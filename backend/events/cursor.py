from flask import current_app, request
from flask_socketio import emit

from ..rooms.manager import room_manager
from .rate_limit import SlidingWindowRateLimiter

_cursor_rate_limiter = SlidingWindowRateLimiter()


def register_cursor_events(socketio):
    """A extensão do Host manda em qual linha (e em qual aba) o cursor está
    a cada movimento, pra os Espectadores destacarem essa linha na tela."""

    @socketio.on("host_cursor_line")
    def handle_host_cursor_line(data):
        data = data or {}
        code = data.get("room_code", "")

        if not room_manager.is_trusted_sender(code, request.sid):
            return

        if _cursor_rate_limiter.is_limited(
            request.sid,
            current_app.config["CURSOR_RATE_LIMIT_COUNT"],
            current_app.config["CURSOR_RATE_LIMIT_WINDOW_SECONDS"],
        ):
            return

        tab_id = data.get("tab_id", "")
        line = data.get("line")

        room = room_manager.get_room(code)
        if room is None or not tab_id or line is None:
            return

        room_manager.set_host_cursor(code, tab_id, line)

        emit(
            "host_cursor_line",
            {"tabId": tab_id, "line": line},
            room=room.code,
            include_self=False,
        )
