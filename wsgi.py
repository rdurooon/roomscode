"""Ponto de entrada de PRODUÇÃO do RoomsCode, usado pelo Gunicorn.

Comando (ver Dockerfile / docker-compose.yml):
    gunicorn -k eventlet -w 1 -b 0.0.0.0:5000 wsgi:app

Por que exatamente 1 worker: o estado das salas (RoomManager) vive em
memória de um único processo Python, por design do projeto (sem banco de
dados / Redis). Com mais de 1 worker, cada processo teria sua própria cópia
vazia do RoomManager, e uma mesma sala apareceria "inexistente" dependendo
de qual worker atendesse a requisição seguinte. Se no futuro for necessário
escalar horizontalmente, isso exige migrar o estado de sala para algo
compartilhado entre processos (ex.: Redis) — não é algo que se resolve só
aumentando o número de workers.
"""

import eventlet

eventlet.monkey_patch()

from backend.app import app  # noqa: E402  (import depois do monkey_patch de propósito)

# O Gunicorn com worker class "eventlet" serve o objeto WSGI padrão do
# Flask normalmente — o monkey-patch do eventlet acima é o que faz o
# Flask-SocketIO funcionar corretamente sob esse worker.
__all__ = ["app"]
