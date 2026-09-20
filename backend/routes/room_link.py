import re

from flask import Blueprint, abort, render_template

from ..config import Config

room_link_bp = Blueprint("room_link", __name__)

# Mesmo formato usado por RoomManager._generate_code() (backend/rooms/manager.py):
# só letras maiúsculas e dígitos, tamanho fixo. Validar aqui evita que esse
# catch-all de 1 segmento capture qualquer path desconhecido (ex: um bot
# pedindo /robots.txt) — nesses casos cai no 404 normal, igual antes dessa
# rota existir.
_ROOM_CODE_RE = re.compile(rf"^[A-Z0-9]{{{Config.ROOM_CODE_LENGTH}}}$")


@room_link_bp.route("/<room_code>")
def join_via_link(room_code):
    """Link curto de convite pra sala (ex: https://.../A1B2C3), gerado pelo
    botão de compartilhar (ver share-room-link-btn em room-init.js).

    Renderiza a página do Espectador diretamente aqui, sem redirect — a URL
    visível continua sendo só /A1B2C3, sem "?code=" em nenhum momento.

    Não valida se a sala ainda existe aqui. Isso é papel do fluxo de
    entrada de sempre (evento join_error / código ROOM_NOT_FOUND, ver
    events/presence.py), então uma sala encerrada dá o mesmo aviso de
    sempre, só que depois de já ter aberto a tela de nome.
    """
    room_code = room_code.strip().upper()
    if not _ROOM_CODE_RE.match(room_code):
        abort(404)
    return render_template("room.html", role="spectator", prefill_code=room_code)
