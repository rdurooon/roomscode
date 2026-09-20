"""Ponto de entrada de DESENVOLVIMENTO do RoomsCode.

Rode com: python run.py
(depois de instalar as dependências com `pip install -r requirements.txt`,
e com FLASK_ENV=development definido no ambiente — ver backend/config.py)

Isso NÃO é usado em produção. Em produção, o Dockerfile roda a aplicação via
Gunicorn com worker eventlet e exatamente 1 worker apontando para wsgi.py
(o estado das salas vive em memória de um único processo, então mais de 1
worker faria cada requisição cair num processo diferente, com salas
"sumindo" dependendo de qual worker atender). Ver Dockerfile e
docker-compose.yml.
"""

import eventlet

eventlet.monkey_patch()

from backend.app import app, socketio  # noqa: E402  (import depois do monkey_patch de propósito)

if __name__ == "__main__":
    # debug é sempre False, de propósito — não é uma env var opcional. O
    # debugger do Werkzeug expõe execução de código arbitrário e nunca deve
    # ligar nem por engano; se precisar de reload automático em
    # desenvolvimento, use `flask run --debug` apontando pra create_app, não
    # este script.
    socketio.run(app, host="127.0.0.1", port=5000, debug=False)
