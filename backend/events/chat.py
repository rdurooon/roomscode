from datetime import datetime, timezone

import bleach
from flask import current_app, request
from flask_socketio import emit

from ..rooms.manager import room_manager
from .rate_limit import SlidingWindowRateLimiter

_chat_rate_limiter = SlidingWindowRateLimiter()


def register_chat_events(socketio):

    @socketio.on("chat_message")
    def handle_chat_message(data):
        data = data or {}
        code = data.get("room_code", "")
        message = data.get("message", "")
        quoted_line = data.get("quoted_line")

        room = room_manager.get_room(code)
        if room is None or not str(message).strip():
            return

        # O nome do remetente é o que está registrado na sala (host_name ou
        # o nome dado ao entrar como espectador) — nunca o que o cliente
        # mandar no payload. Isso impede um espectador "assinar" mensagens
        # com o nome de outra pessoa (ou do Host). Também serve como
        # confirmação de que quem está mandando a mensagem de fato entrou
        # nessa sala pelo fluxo normal (join_room/spectator_join_room):
        # qualquer outro sid é ignorado.
        if request.sid == room.host_sid:
            sender = room.host_name
        elif request.sid in room.spectators:
            sender = room.spectators[request.sid]
        else:
            return

        # Eventos de erro/aviso mandam um "code" (mapeado 1:1 pra chave
        # socket.<code em minúsculo> nos arquivos de tradução), nunca texto
        # pronto — quem decide o idioma de exibição é o cliente que recebeu
        # o evento, não o backend (host e espectadores podem estar em
        # idiomas diferentes na mesma sala). Ver frontend/static/js/i18n-client.js.
        rate_limit_count = current_app.config["CHAT_RATE_LIMIT_COUNT"]
        rate_limit_window = current_app.config["CHAT_RATE_LIMIT_WINDOW_SECONDS"]
        if _chat_rate_limiter.is_limited(request.sid, rate_limit_count, rate_limit_window):
            emit("chat_rate_limited", {"code": "CHAT_RATE_LIMITED"})
            return

        max_chars = current_app.config["MAX_CHAT_MESSAGE_CHARS"]
        if len(message) > max_chars:
            emit("chat_rate_limited", {"code": "MESSAGE_TOO_LONG", "max_chars": max_chars})
            return

        # O frontend (chat-client.js) sempre renderiza a mensagem com
        # textContent/createTextNode — nunca como HTML. Ou seja, a lista de
        # tags que o bleach "permitia" antes (b, i, code, pre, br) nunca
        # tinha efeito nenhum na prática: o texto aparecia literalmente com
        # os `<...>` de qualquer jeito. Em vez de implementar renderização
        # real dessas tags no cliente (o que ampliaria a superfície de
        # sanitização necessária sem ganho claro para um chat de aula),
        # removemos a whitelist: agora todo o conteúdo de marcação é
        # removido, o texto plano continua intacto.
        clean_message = bleach.clean(message, tags=[], strip=True)

        payload = {
            "sender": sender,
            "message": clean_message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        if quoted_line:
            payload["quoted_line"] = {
                "start": int(quoted_line.get("start", 0) or 0),
                "end": int(quoted_line.get("end", 0) or 0),
                "text": bleach.clean(str(quoted_line.get("text", "")), tags=[], strip=True),
            }

        emit("chat_message", payload, room=room.code)
