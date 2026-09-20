import os

from .secrets_bootstrap import bootstrap_env

# Caminho do .env: raiz do projeto (um nível acima de backend/), a menos que
# ROOMSCODE_ENV_FILE aponte pra outro lugar (usado pelos testes, pra não
# gerar/mexer no .env real do projeto durante a suíte de testes).
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ENV_FILE_PATH = os.environ.get("ROOMSCODE_ENV_FILE") or os.path.join(_PROJECT_ROOT, ".env")

# Roda ANTES de qualquer leitura de env var abaixo: garante que segredos
# geráveis (hoje, só SECRET_KEY) existam no .env, gerando e persistindo o
# que faltar, e carrega tudo que houver no arquivo pro ambiente do processo
# atual (sem nunca sobrescrever uma env var real já definida).
bootstrap_env(_ENV_FILE_PATH)


class Config:
    """Configurações do app. Segredos geráveis (SECRET_KEY) são criados
    sozinhos por bootstrap_env() acima, se ainda não existirem. Config
    não-secreta (ALLOWED_ORIGIN, TRUSTED_PROXY_COUNT etc.) continua exigindo
    que você defina a variável de ambiente correspondente (via .env / Docker)
    quando quiser um valor diferente do padrão."""

    # FLASK_ENV=development habilita um fallback de CORS mais permissivo pra
    # rodar localmente sem configurar nada. Qualquer outro valor (inclusive
    # não definir a variável) é tratado como produção, com esse fallback
    # desligado de propósito.
    FLASK_ENV = os.environ.get("FLASK_ENV", "production").strip().lower()
    IS_PRODUCTION = FLASK_ENV != "development"

    # Normalmente já vem preenchida pelo bootstrap_env() acima. Continua
    # None aqui só se a geração falhou (ex.: filesystem somente leitura) e
    # nenhuma variável de ambiente real supriu o valor — nesse caso,
    # create_app() recusa subir em produção (ver app.py), em vez de usar
    # um valor padrão inseguro.
    SECRET_KEY = os.environ.get("SECRET_KEY")

    ROOM_CODE_LENGTH = 6

    # Origem(ns) permitida(s) para o Socket.IO em produção, ex.:
    # ALLOWED_ORIGIN=https://roomscode.exemplo.com
    # Aceita múltiplas origens separadas por vírgula. Se não definida em
    # produção, nenhuma origem cross-site é liberada (o same-origin sempre
    # continua funcionando, que é o caso normal por trás do Cloudflare
    # Tunnel — front e back são servidos do mesmo domínio).
    ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "").strip()

    # Quantos proxies reversos confiáveis existem na frente da aplicação
    # (Cloudflare Tunnel = 1). Usado pelo ProxyFix em app.py.
    TRUSTED_PROXY_COUNT = int(os.environ.get("TRUSTED_PROXY_COUNT", "1"))

    # ---- Limites de tamanho de payload (mitigação de flood/DoS via
    # conteúdo de arquivo ou chat, já que tudo é retransmitido pra sala
    # inteira) ----
    MAX_FILE_CONTENT_CHARS = int(os.environ.get("MAX_FILE_CONTENT_CHARS", 3_000_000))  # ~3MB de texto
    MAX_PATCH_CHARS = int(os.environ.get("MAX_PATCH_CHARS", 3_000_000))
    MAX_TABS_PER_BATCH = int(os.environ.get("MAX_TABS_PER_BATCH", 50))
    MAX_CHAT_MESSAGE_CHARS = int(os.environ.get("MAX_CHAT_MESSAGE_CHARS", 4000))

    # ---- Rate limiting (janela deslizante) por evento de Socket.IO ----
    # Chat (já existia)
    CHAT_RATE_LIMIT_COUNT = 5
    CHAT_RATE_LIMIT_WINDOW_SECONDS = 10

    # Criação de sala — por IP, para não permitir spam de salas novas.
    ROOM_CREATE_RATE_LIMIT_COUNT = 5
    ROOM_CREATE_RATE_LIMIT_WINDOW_SECONDS = 60

    # Entrada de espectador — por IP, para dificultar força bruta do código
    # de sala de 6 caracteres.
    SPECTATOR_JOIN_RATE_LIMIT_COUNT = 10
    SPECTATOR_JOIN_RATE_LIMIT_WINDOW_SECONDS = 30

    # Diff de arquivo — por sid (Host/extensão), para conter flood
    # amplificado (cada diff é reenviado a todos os espectadores da sala).
    FILE_DIFF_RATE_LIMIT_COUNT = 40
    FILE_DIFF_RATE_LIMIT_WINDOW_SECONDS = 10

    # Posição do cursor do Host — mesmo raciocínio do diff.
    CURSOR_RATE_LIMIT_COUNT = 40
    CURSOR_RATE_LIMIT_WINDOW_SECONDS = 10

    # ---- Robustez de conexão ----
    # Quanto tempo (em segundos) a sala fica em "estado de graça" depois que
    # o socket do Host cai, esperando ele voltar (reconexão automática do
    # navegador ou o usuário voltando manualmente), antes de encerrar a sala
    # de vez. Enquanto dura, a sala continua de pé (espectadores continuam
    # vendo o último código/tela, e a extensão VS Code — se ainda estiver
    # conectada — continua publicando normalmente).
    HOST_RECONNECT_GRACE_SECONDS = int(os.environ.get("HOST_RECONNECT_GRACE_SECONDS", 60))

    # Engine.IO (transporte por trás do Flask-SocketIO): intervalo entre
    # pings do servidor pro cliente e quanto tempo esperar pelo pong antes de
    # considerar a conexão morta. Os valores padrão da lib (25s / 20s) somam
    # até 45s pra detectar uma queda "silenciosa" (processo travado, cabo
    # arrancado sem fechar o socket) — isso é lento demais pra avisar
    # espectadores que o Host sumiu. Os valores abaixo detectam isso em até
    # ~20s, e ainda toleram uma rede instável real: o Engine.IO só conta como
    # perda depois de PING_TIMEOUT sem resposta a partir do próximo ping
    # agendado, então um pico de latência isolado (ex: um bufferbloat de
    # alguns segundos) não derruba a conexão por si só.
    SOCKETIO_PING_INTERVAL_SECONDS = int(os.environ.get("SOCKETIO_PING_INTERVAL_SECONDS", 20))
    SOCKETIO_PING_TIMEOUT_SECONDS = int(os.environ.get("SOCKETIO_PING_TIMEOUT_SECONDS", 15))

    # ---- Idioma (i18n) ----
    # Ordem de detecção do idioma do visitante: cookie manual > Accept-Language
    # do navegador > país via CF-IPCountry (Cloudflare Tunnel, ver net.py) >
    # DEFAULT_LOCALE. Lógica completa em backend/i18n/locale.py.
    # pt-BR é o idioma fonte: todo texto novo é escrito lá primeiro, e uma
    # chave ausente nos outros idiomas cai automaticamente para pt-BR.
    SUPPORTED_LOCALES = ["pt-BR", "en", "es"]
    DEFAULT_LOCALE = "pt-BR"
    LOCALE_COOKIE_NAME = "roomscode_lang"
    LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365  # 1 ano
