# Imagem de produção do RoomsCode.
#
# Build:  docker compose build   (ou: docker build -t roomscode .)
# Run:    ver docker-compose.yml (publica só em 127.0.0.1:5000, atrás do
#         Cloudflare Tunnel do host)
FROM python:3.12-slim

# Evita .pyc no filesystem da imagem e garante que stdout/stderr do Gunicorn
# apareçam sem buffer nos logs do `docker compose logs`.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Instala as dependências antes de copiar o resto do código, pra aproveitar
# o cache de camadas do Docker em rebuilds que só mudam código-fonte.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Usuário não-root — o processo do Gunicorn nunca precisa de root (não hospeda
# nada em porta privilegiada, não escreve fora de /app).
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin appuser

COPY --chown=appuser:appuser . .

# /app/data é onde backend/secrets_bootstrap.py grava o .env com a
# SECRET_KEY gerada automaticamente (ver ROOMSCODE_ENV_FILE no
# docker-compose.yml) — precisa existir e já pertencer ao appuser ANTES do
# volume nomeado ser montado em cima, porque é assim que o Docker decide a
# dona/permissão inicial de um volume nomeado novo (copia do que já existe
# no caminho, dentro da imagem). Sem isso, o volume nasceria com dono
# "root" e o processo (rodando como appuser, sem privilégio nenhum) não
# conseguiria escrever a SECRET_KEY nele.
RUN mkdir -p /app/data && chown appuser:appuser /app/data

USER appuser

EXPOSE 5000

# Health-check simples: só confirma que o processo Flask está de pé e
# respondendo (rota /healthz, sem dependências externas — o projeto não tem
# banco de dados). O compose também expõe esse health-check pro
# `restart: unless-stopped` e pra quem for automatizar o deploy.sh.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:5000/healthz', timeout=3).status == 200 else sys.exit(1)"

# Exatamente 1 worker eventlet — ver o comentário em wsgi.py sobre por que
# o estado de sala em memória não permite mais de 1 worker/processo.
CMD ["gunicorn", "-k", "eventlet", "-w", "1", "-b", "0.0.0.0:5000", "--log-level", "info", "wsgi:app"]
