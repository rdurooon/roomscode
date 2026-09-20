import json
import os

from flask import Flask, g, request
from flask_limiter import Limiter
from flask_socketio import SocketIO
from werkzeug.middleware.proxy_fix import ProxyFix

from .config import Config
from .events.chat import register_chat_events
from .events.cursor import register_cursor_events
from .events.file_sync import register_file_sync_events
from .events.connection_quality import register_connection_quality_events
from .events.presence import register_presence_events
from .events.room_settings import register_room_settings_events
from .events.signaling import register_signaling_events
from .i18n.locale import LOCALE_DISPLAY, get_all_translations, get_full_translations, resolve_locale, translate
from .net import get_client_ip
from .routes.downloads import downloads_bp
from .routes.health import health_bp
from .routes.home import home_bp
from .routes.host import host_bp
from .routes.room_link import room_link_bp
from .routes.spectator import spectator_bp

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_DIR = os.path.join(BASE_DIR, "frontend", "templates")
STATIC_DIR = os.path.join(BASE_DIR, "frontend", "static")

# CSP compatível com o que o app realmente usa: todo JS/CSS de terceiros é
# vendorizado em frontend/static/vendor/ e servido pela própria origem (ver
# esse diretório), então "'self'" cobre tudo — não precisamos liberar nenhum
# domínio externo. style-src usa 'unsafe-inline' só por causa de alguns
# atributos style="display:none" pontuais no HTML (baixo risco: CSS inline
# não executa código); script-src fica estrito, sem 'unsafe-inline'/'eval'.
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "media-src 'self' blob:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)


def create_app():
    if Config.IS_PRODUCTION and not Config.SECRET_KEY:
        # Isto só deveria acontecer se backend/secrets_bootstrap.py não
        # conseguiu gerar/gravar uma SECRET_KEY nova (ex.: filesystem
        # somente leitura) e nenhuma variável de ambiente real supriu o
        # valor por outro caminho. Continua sendo um erro fatal em
        # produção — nunca caímos pra um valor padrão inseguro.
        raise RuntimeError(
            "SECRET_KEY não definida e não foi possível gerá-la automaticamente "
            "(ver mensagens acima). Defina a variável de ambiente manualmente "
            "antes de subir a aplicação em produção (FLASK_ENV != 'development')."
        )

    app = Flask(__name__, template_folder=TEMPLATE_DIR, static_folder=STATIC_DIR)
    app.config.from_object(Config)

    # A aplicação roda atrás de exatamente 1 proxy reverso confiável (o
    # Cloudflare Tunnel, instalado no host, fora do container). O ProxyFix
    # corrige request.remote_addr / wsgi.url_scheme / Host a partir dos
    # cabeçalhos X-Forwarded-* desse proxy, para que o Flask-Limiter e
    # qualquer log de IP enxerguem o visitante real, não o túnel.
    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=Config.TRUSTED_PROXY_COUNT,
        x_proto=Config.TRUSTED_PROXY_COUNT,
        x_host=Config.TRUSTED_PROXY_COUNT,
    )

    # Protege as rotas HTTP comuns (ex: contra flood de acesso às páginas).
    # O chat e os demais eventos de tempo real, que rodam via Socket.IO e
    # não passam por essas rotas, têm seu próprio rate limit dedicado (ver
    # events/chat.py e events/rate_limit.py).
    Limiter(get_client_ip, app=app, default_limits=["60 per minute"])

    @app.after_request
    def set_security_headers(response):
        response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    # ---- Idioma (i18n) ----
    # Resolve o idioma uma vez por request (cookie > Accept-Language > país
    # via CF-IPCountry > default — ver i18n/locale.py) e persiste em cookie
    # quando ainda não havia um, pra requests seguintes não precisarem
    # reprocessar Accept-Language/país. Um seletor manual de idioma (a virar
    # feature de UI depois) só precisa sobrescrever esse mesmo cookie.
    @app.before_request
    def resolve_request_locale():
        g.locale = resolve_locale()

    @app.after_request
    def persist_locale_cookie(response):
        if request.cookies.get(Config.LOCALE_COOKIE_NAME) != g.get("locale"):
            response.set_cookie(
                Config.LOCALE_COOKIE_NAME,
                g.locale,
                max_age=Config.LOCALE_COOKIE_MAX_AGE_SECONDS,
                samesite="Lax",
            )
        return response

    @app.context_processor
    def inject_i18n():
        current_locale = g.get("locale", Config.DEFAULT_LOCALE)
        return {
            "t": lambda key, **kwargs: translate(current_locale, key, **kwargs),
            "current_locale": current_locale,
            # Dicionário completo (já com fallback pro idioma fonte
            # resolvido) embutido na página pra uso do JS do navegador — ver
            # i18n-client.js. json.dumps escapa aspas/backslash; segue pra
            # dentro de uma <script type="application/json"> no template,
            # nunca interpolado direto em atributo HTML.
            "i18n_json": json.dumps(get_full_translations(current_locale)),
            # Idem, mas com TODOS os idiomas suportados de uma vez — só as
            # páginas com troca de idioma ao vivo (ver language-switcher.js)
            # embutem isso; as demais ignoram a variável.
            "i18n_all_json": json.dumps(get_all_translations()),
            "supported_locales": Config.SUPPORTED_LOCALES,
            "locale_display": LOCALE_DISPLAY,
        }

    app.register_blueprint(home_bp)
    app.register_blueprint(host_bp)
    app.register_blueprint(spectator_bp)
    app.register_blueprint(health_bp)
    app.register_blueprint(downloads_bp)
    # Catch-all de 1 segmento (ex: /A1B2C3) — registrado por último por
    # clareza; rotas fixas como as acima sempre têm prioridade no Werkzeug
    # independente da ordem de registro, então isso não afeta o roteamento.
    app.register_blueprint(room_link_bp)

    if Config.ALLOWED_ORIGIN:
        cors_allowed_origins = [o.strip() for o in Config.ALLOWED_ORIGIN.split(",") if o.strip()]
    elif not Config.IS_PRODUCTION:
        cors_allowed_origins = "*"
    else:
        # Produção sem ALLOWED_ORIGIN definida: não libera nenhuma origem
        # cross-site. Requisições same-origin (o caso normal — front e back
        # servidos do mesmo domínio via Cloudflare Tunnel) continuam
        # funcionando normalmente, pois o Engine.IO já permite same-origin
        # por padrão quando cors_allowed_origins é None.
        cors_allowed_origins = None

    socketio = SocketIO(
        app,
        cors_allowed_origins=cors_allowed_origins,
        async_mode="eventlet",
        # Ver comentário em Config sobre esses dois valores: detectam uma
        # queda de verdade bem mais rápido que o default da lib, sem tratar
        # jitter de rede pontual como desconexão.
        ping_interval=Config.SOCKETIO_PING_INTERVAL_SECONDS,
        ping_timeout=Config.SOCKETIO_PING_TIMEOUT_SECONDS,
    )

    register_presence_events(socketio)
    register_signaling_events(socketio)
    register_file_sync_events(socketio)
    register_cursor_events(socketio)
    register_room_settings_events(socketio)
    register_chat_events(socketio)
    register_connection_quality_events(socketio)

    return app, socketio


app, socketio = create_app()
