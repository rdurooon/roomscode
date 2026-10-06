from flask import request
from flask_socketio import emit, leave_room

from ..rooms.manager import room_manager
from .roster import emit_roster_to_host


def _host_room_and_target(data):
    """Valida uma ação de moderação: só o Host da sala pode, e o alvo precisa
    ser um espectador dessa mesma sala. Devolve (sala, sid_alvo) ou (None, None)."""
    data = data or {}
    code = data.get("room_code", "")
    target_sid = data.get("sid")

    room = room_manager.get_room(code if isinstance(code, str) else "")
    if room is None or room.host_sid != request.sid:
        return None, None
    if not isinstance(target_sid, str) or target_sid not in room.spectators:
        return None, None
    return room, target_sid


def register_moderation_events(socketio):
    """Ações do Host sobre um espectador: restringir/liberar o chat e expulsar."""

    @socketio.on("host_set_chat_muted")
    def handle_host_set_chat_muted(data):
        room, target_sid = _host_room_and_target(data)
        if room is None:
            return

        muted = (data or {}).get("muted")
        if not isinstance(muted, bool):
            return

        room_manager.set_chat_muted(room.code, target_sid, muted)
        emit("chat_muted_changed", {"muted": muted}, room=target_sid)
        emit_roster_to_host(room)

    @socketio.on("host_kick_spectator")
    def handle_host_kick_spectator(data):
        room, target_sid = _host_room_and_target(data)
        if room is None:
            return

        room_manager.kick_spectator(room.code, target_sid)
        # Avisa o expulso ANTES de tirá-lo da sala do Socket.IO, senão a
        # mensagem não chegaria nele.
        emit("kicked", {"code": "KICKED_FROM_ROOM"}, room=target_sid)
        leave_room(room.code, sid=target_sid)

        # Mesmo evento de quando alguém sai: o Host fecha a conexão de vídeo
        # desse espectador e todo mundo atualiza a lista de nomes.
        emit(
            "spectator_left",
            {"sid": target_sid, "spectators": list(room.spectators.values())},
            room=room.code,
        )
        emit_roster_to_host(room)
