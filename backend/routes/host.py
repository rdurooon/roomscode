from flask import Blueprint, render_template

host_bp = Blueprint("host", __name__)


@host_bp.route("/anfitriao")
def host_page():
    return render_template("room.html", role="host")
