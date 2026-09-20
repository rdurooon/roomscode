from flask import request
from flask_socketio import emit

from ..rooms.manager import room_manager


def register_room_settings_events(socketio):
    """Configurações da sala controladas pelo Host — por enquanto, só a
    visibilidade do código de entrada da sala para os Espectadores."""

    @socketio.on("set_code_visibility")
    def handle_set_code_visibility(data):
        data = data or {}
        code = data.get("room_code", "")
        visible = bool(data.get("visible", False))

        room = room_manager.get_room(code)
        if room is None or room.host_sid != request.sid:
            return  # só o host da sala pode mudar essa configuração

        room_manager.set_code_visibility(code, visible)

        emit(
            "code_visibility_changed",
            {"visible": visible},
            room=room.code,
            include_self=False,
        )
