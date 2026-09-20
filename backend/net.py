"""Resolução do IP real do visitante quando a aplicação roda atrás do
Cloudflare Tunnel (ver app.py para a configuração do ProxyFix).

O Cloudflare Tunnel injeta o cabeçalho `CF-Connecting-IP` com o IP original
do visitante antes de encaminhar a requisição para o container. O
ProxyFix já corrige `request.remote_addr` a partir de X-Forwarded-For para
o caso de outros proxies, mas preferimos `CF-Connecting-IP` quando presente
por ser a fonte mais confiável especificamente no cenário do Cloudflare
Tunnel (não pode ser forjado pelo visitante, já que o Cloudflare sobrescreve
esse cabeçalho antes de repassar).
"""

from flask import request
from flask_limiter.util import get_remote_address


def get_client_ip() -> str:
    forwarded = request.headers.get("CF-Connecting-IP")
    if forwarded:
        return forwarded.strip()
    return get_remote_address()
