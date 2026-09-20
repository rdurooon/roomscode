"""Eventos de diagnóstico de conexão — hoje só um "ping" de aplicação,
independente do ping/pong interno do Engine.IO, usado pelos clientes (a
extensão VS Code e o navegador) pra medir a latência real de ida-e-volta até
o backend e mostrar isso pro usuário (ex: "conectado — 42ms").

Não exige sala nem autenticação: é só um eco, então não há estado sensível
envolvido e qualquer socket conectado pode usar pra saber a qualidade da
própria conexão antes mesmo de entrar numa sala.
"""

from flask import request
from flask_socketio import emit

from .rate_limit import SlidingWindowRateLimiter

# Generoso o bastante pra um cliente medir latência a cada poucos segundos
# sem se preocupar com o limite, mas o suficiente pra impedir que alguém use
# esse evento pra floodar o servidor.
_PING_PROBE_LIMIT_COUNT = 30
_PING_PROBE_LIMIT_WINDOW_SECONDS = 10

_ping_probe_rate_limiter = SlidingWindowRateLimiter()


def register_connection_quality_events(socketio):
    @socketio.on("ping_probe")
    def handle_ping_probe(data):
        if _ping_probe_rate_limiter.is_limited(
            request.sid,
            _PING_PROBE_LIMIT_COUNT,
            _PING_PROBE_LIMIT_WINDOW_SECONDS,
        ):
            return

        data = data or {}
        # Devolve exatamente o timestamp que o cliente mandou — é o próprio
        # cliente quem calcula o round-trip (Date.now() local - o timestamp
        # que ele guardou antes de emitir), então não há necessidade de
        # sincronizar relógios com o servidor.
        client_sent_at = data.get("client_sent_at")
        emit("pong_probe", {"client_sent_at": client_sent_at})
