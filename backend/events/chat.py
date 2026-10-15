import re
from datetime import datetime, timezone

import bleach
from flask import current_app, request
from flask_socketio import emit

from ..rooms.manager import room_manager
from .rate_limit import SlidingWindowRateLimiter

_chat_rate_limiter = SlidingWindowRateLimiter()


# Atalho "@host": vira a menção ao nome real do Host antes de a mensagem ir para a sala. O "@" precisa estar
# no começo ou depois de espaço, e "@hostil" não conta. "host" é nome reservado para espectadores (ver config).
_AT_HOST_RE = re.compile(r"(?<!\S)@host(?!\w)", re.IGNORECASE)
_USER_HOST_RE = re.compile(r"!user\(\s*host\s*\)", re.IGNORECASE)
_USER_CMD_RE = re.compile(r"!user\(\s*([^)]+?)\s*\)", re.IGNORECASE)

# Quantos caracteres da mensagem seguem para a notificação do VS Code do Host.
_EXTENSION_NOTIFY_MAX_CHARS = 200


def expand_host_shortcut(message: str, host_name: str) -> str:
    if not host_name:
        return message
    message = _AT_HOST_RE.sub(lambda _m: f"@{host_name}", message)
    return _USER_HOST_RE.sub(lambda _m: f"!user({host_name})", message)


def find_mentioned_sids(message: str, room, sender_sid: str) -> list:
    """sids das pessoas mencionadas na mensagem (por @nome ou !user(nome)), sem o remetente e sem repetir.

    Mesma regra de leitura do chat no navegador: nomes mais longos têm prioridade ("@Ana Paula" não menciona
    a "Ana"), e depois do nome não pode vir letra, número ou "_" ("@Anabela" não menciona a "Ana").
    """
    by_name = {}
    if room.host_sid and room.host_name:
        by_name.setdefault(room.host_name.casefold(), []).append(room.host_sid)
    for sid, name in room.spectators.items():
        by_name.setdefault(name.casefold(), []).append(sid)
    if not by_name:
        return []

    names = sorted({n for n in (room.host_name, *room.spectators.values()) if n}, key=len, reverse=True)
    at_re = re.compile(r"(?<!\w)@(" + "|".join(re.escape(n) for n in names) + r")(?!\w)", re.IGNORECASE)

    mentioned = []
    matched_names = [m.group(1) for m in at_re.finditer(message)]
    matched_names += [m.group(1) for m in _USER_CMD_RE.finditer(message)]
    for matched in matched_names:
        for sid in by_name.get(matched.casefold(), []):
            if sid != sender_sid and sid not in mentioned:
                mentioned.append(sid)
    return mentioned


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

        # Espectador com o chat restrito pelo Host: nada é enviado (isso
        # cobre também menções e citações de código, que são só texto da
        # mensagem). Fica antes do rate limit pra não gastar o limite dele.
        if request.sid != room.host_sid and room_manager.is_chat_muted(room, request.sid):
            emit("chat_rate_limited", {"code": "CHAT_MUTED"})
            return

        # Bloqueio do chat de todos os espectadores (o Host nunca é barrado).
        if request.sid != room.host_sid and room.chat_all_muted:
            emit("chat_rate_limited", {"code": "CHAT_ALL_MUTED"})
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

        clean_message = expand_host_shortcut(clean_message, room.host_name)
        if len(clean_message) > max_chars:
            emit("chat_rate_limited", {"code": "MESSAGE_TOO_LONG", "max_chars": max_chars})
            return

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

        # Aviso sonoro só para quem foi mencionado (cada um recebe só o seu). Se for o Host, a extensão do VS Code
        # dele também recebe, para mostrar a notificação lá.
        for target_sid in find_mentioned_sids(clean_message, room, request.sid):
            emit("chat_mention", {"sender": sender}, room=target_sid)
            if target_sid == room.host_sid and room.extension_sid:
                emit(
                    "host_mentioned",
                    {"sender": sender, "message": clean_message[:_EXTENSION_NOTIFY_MAX_CHARS]},
                    room=room.extension_sid,
                )
