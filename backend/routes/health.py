from flask import Blueprint, jsonify

health_bp = Blueprint("health", __name__)


@health_bp.route("/healthz")
def healthz():
    """Rota simples de health-check, usada pelo HEALTHCHECK do Docker.

    Não verifica dependências externas de propósito — o RoomsCode não tem
    banco de dados nem serviços externos síncronos; só confirma que o
    processo Flask está de pé e respondendo."""
    return jsonify({"status": "ok"}), 200
