"""Proteção contra abuso de requisições HTTP (F5 em loop, scripts, flood).

Substitui o limite genérico do Flask-Limiter. Diferenças importantes:

- Páginas e arquivos estáticos têm limites separados. Uma única página
  carrega dezenas de arquivos de /static/, então contar tudo junto fazia
  poucos F5 esgotarem o limite (e, atrás de um NAT de faculdade, bloqueava
  a turma inteira).
- Quem estoura o limite recebe um bloqueio temporário e leve (resposta 429
  imediata, sem renderizar nada). Reincidentes dentro de uma hora ganham
  bloqueios cada vez mais longos, até um teto.
- Cada início de bloqueio gera um alerta no log do servidor
  (`docker compose logs roomscode`).

Só cobre requisições HTTP que passam pelo Flask. O Socket.IO (/socket.io/)
é atendido antes do Flask e continua com seus próprios limites por evento
(ver events/rate_limit.py). /healthz fica fora para não derrubar o
HEALTHCHECK do Docker.
"""

import base64
import html
import math
import os
import time
from collections import defaultdict, deque
from typing import NamedTuple, Optional

from flask import Response, request

from .i18n.locale import resolve_locale, translate
from .net import get_client_ip

_CLEANUP_INTERVAL_SECONDS = 60
# A partir desta reincidência o alerta sobe de WARNING para ERROR.
_PERSISTENT_ABUSE_STRIKES = 3

# Favicon embutido na própria página de bloqueio (data URI): quem está
# bloqueado também recebe 429 nos arquivos estáticos, então um <link> para
# /static/... nunca carregaria. O CSP já permite img-src data:.
_favicon_data_uri = ""


def _now() -> float:
    return time.monotonic()


class BlockInfo(NamedTuple):
    retry_after: int
    is_new: bool
    strike: int
    kind: str
    hits: int
    window: int


class AbuseGuard:
    def __init__(self):
        self._page_hits = defaultdict(deque)
        self._asset_hits = defaultdict(deque)
        self._blocked_until: dict = {}
        self._block_info: dict = {}
        self._strikes: dict = {}  # ip -> (quantidade, instante do último strike)
        self._last_cleanup = _now()

    @staticmethod
    def _prune(hits: deque, now: float, window: float) -> None:
        while hits and now - hits[0] > window:
            hits.popleft()

    def check(self, ip: str, is_asset: bool, cfg) -> Optional[BlockInfo]:
        """Registra uma requisição de `ip`. Devolve None se pode passar, ou
        um BlockInfo se deve ser recusada (is_new=True só na que iniciou o
        bloqueio — é a que deve gerar o alerta)."""
        now = _now()
        self._cleanup(now, cfg)

        until = self._blocked_until.get(ip)
        if until is not None:
            if until > now:
                previous = self._block_info[ip]
                return previous._replace(retry_after=math.ceil(until - now), is_new=False)
            del self._blocked_until[ip]
            self._block_info.pop(ip, None)

        if is_asset:
            kind, hits_map = "assets", self._asset_hits
            limit = cfg["ABUSE_ASSET_LIMIT_COUNT"]
            window = cfg["ABUSE_ASSET_LIMIT_WINDOW_SECONDS"]
        else:
            kind, hits_map = "pages", self._page_hits
            limit = cfg["ABUSE_PAGE_LIMIT_COUNT"]
            window = cfg["ABUSE_PAGE_LIMIT_WINDOW_SECONDS"]

        hits = hits_map[ip]
        self._prune(hits, now, window)
        if len(hits) >= limit:
            return self._start_block(ip, kind, len(hits), window, now, cfg)

        hits.append(now)
        return None

    def _start_block(self, ip, kind, hits, window, now, cfg) -> BlockInfo:
        count, last = self._strikes.get(ip, (0, now))
        if now - last > cfg["ABUSE_STRIKE_MEMORY_SECONDS"]:
            count = 0
        count += 1
        self._strikes[ip] = (count, now)

        duration = min(
            cfg["ABUSE_BLOCK_BASE_SECONDS"] * (2 ** (count - 1)),
            cfg["ABUSE_BLOCK_MAX_SECONDS"],
        )
        info = BlockInfo(math.ceil(duration), True, count, kind, hits, window)
        self._blocked_until[ip] = now + duration
        self._block_info[ip] = info

        # Recomeça "limpo" quando o bloqueio acabar.
        self._page_hits.pop(ip, None)
        self._asset_hits.pop(ip, None)
        return info

    def _cleanup(self, now: float, cfg) -> None:
        """Evita crescimento ilimitado de memória: descarta IPs inativos."""
        if now - self._last_cleanup < _CLEANUP_INTERVAL_SECONDS:
            return
        self._last_cleanup = now

        for hits_map, window in (
            (self._page_hits, cfg["ABUSE_PAGE_LIMIT_WINDOW_SECONDS"]),
            (self._asset_hits, cfg["ABUSE_ASSET_LIMIT_WINDOW_SECONDS"]),
        ):
            for ip in list(hits_map):
                self._prune(hits_map[ip], now, window)
                if not hits_map[ip]:
                    del hits_map[ip]

        for ip in [ip for ip, until in self._blocked_until.items() if until <= now]:
            del self._blocked_until[ip]
            self._block_info.pop(ip, None)

        memory = cfg["ABUSE_STRIKE_MEMORY_SECONDS"]
        for ip in [ip for ip, (_, last) in self._strikes.items() if now - last > memory]:
            if ip not in self._blocked_until:
                del self._strikes[ip]


def _blocked_response(retry_after: int) -> Response:
    # HTML mínimo e autocontido de propósito: sob abuso, a resposta precisa
    # ser barata (sem template, sem i18n JSON embutido).
    locale = resolve_locale()
    title = html.escape(translate(locale, "errors.rate_limited_title"))
    body = html.escape(translate(locale, "errors.rate_limited_body", seconds=retry_after))
    favicon = f'<link rel="icon" type="image/png" href="{_favicon_data_uri}">' if _favicon_data_uri else ""
    page = (
        f'<!doctype html><html lang="{locale}"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{title}</title>{favicon}"
        "<style>*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}"
        "body{display:flex;align-items:center;justify-content:center;background:#111;"
        "color:#ddd;font-family:system-ui,sans-serif;text-align:center;padding:1rem}"
        "h1{font-size:1.4rem}</style></head>"
        f"<body><main><h1>{title}</h1><p>{body}</p></main></body></html>"
    )
    response = Response(page, status=429, mimetype="text/html")
    response.headers["Retry-After"] = str(retry_after)
    response.headers["Cache-Control"] = "no-store"
    return response


def register_abuse_guard(app) -> AbuseGuard:
    guard = AbuseGuard()
    app.extensions["abuse_guard"] = guard

    global _favicon_data_uri
    try:
        with open(os.path.join(app.static_folder, "img", "favicon-32.png"), "rb") as f:
            _favicon_data_uri = "data:image/png;base64," + base64.b64encode(f.read()).decode("ascii")
    except OSError:
        _favicon_data_uri = ""

    # Registrado ANTES do before_request de idioma (ver app.py): uma
    # requisição bloqueada não precisa resolver locale nem renderizar nada.
    @app.before_request
    def enforce_abuse_guard():
        if request.endpoint == "health.healthz":
            return None

        ip = get_client_ip()
        info = guard.check(ip, request.endpoint == "static", app.config)
        if info is None:
            return None

        if info.is_new:
            log = app.logger.error if info.strike >= _PERSISTENT_ABUSE_STRIKES else app.logger.warning
            log(
                "[ALERTA DE ABUSO] IP %s bloqueado por %ds (ocorrência #%d na última hora): "
                "%d requisições de %s em %ds. Último caminho: %r",
                ip,
                info.retry_after,
                info.strike,
                info.hits,
                "arquivos estáticos" if info.kind == "assets" else "páginas",
                info.window,
                request.path[:200],
            )
        return _blocked_response(info.retry_after)

    return guard