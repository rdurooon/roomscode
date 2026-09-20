import re

from flask import Blueprint, render_template, request

from ..config import Config

spectator_bp = Blueprint("spectator", __name__)

# Mesma validação da rota de link curto (room_link.py) — se alguém montar a
# URL /espectador?code=... na mão com lixo, ignoramos em vez de jogar pro
# campo (o template já escapa por padrão, então isso não é uma questão de
# XSS, é só não pré-preencher com algo que claramente não é um código real).
_ROOM_CODE_RE = re.compile(rf"^[A-Z0-9]{{{Config.ROOM_CODE_LENGTH}}}$")


@spectator_bp.route("/espectador")
def spectator_page():
    raw_code = (request.args.get("code") or "").strip().upper()
    prefill_code = raw_code if _ROOM_CODE_RE.match(raw_code) else ""
    return render_template("room.html", role="spectator", prefill_code=prefill_code)
