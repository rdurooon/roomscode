from flask_socketio import emit

from ..rooms.manager import room_manager


def emit_roster_to_host(room):
    """Manda só ao Host a lista de espectadores com sid e estado do chat
    (restrito ou não) — é isso que permite a ele clicar num espectador pra
    restringir o chat ou expulsar. Os espectadores nunca recebem sids por
    aqui, só os nomes (ver eventos spectator_joined/spectator_left)."""
    if room.host_sid:
        emit("spectator_roster", {"spectators": room_manager.get_roster(room)}, room=room.host_sid)
