"""Geração automática de segredos ausentes no `.env`, na inicialização.

Princípio geral (vale pra qualquer segredo futuro, não só SECRET_KEY): se um
valor pode ser gerado aleatoriamente pelo próprio programa — ao contrário de,
por exemplo, ALLOWED_ORIGIN ou FLASK_ENV, que são escolhas de configuração
que só quem hospeda sabe responder — ele nunca deveria precisar ser
preenchido à mão. Na primeira execução sem `.env` (ou sem essa chave
específica dentro dele), o programa gera o valor, grava no `.env` pra
persistir entre reinícios, e já carrega esse valor pro processo atual.

Isso cobre o uso direto do Python (`python run.py` / `wsgi.py` via
Gunicorn). No fluxo Docker de produção, a MESMA geração acontece um passo
antes, em bash, dentro de `deploy.sh` — porque o `docker compose` precisa
do `.env` já pronto no host antes mesmo de criar o container (é ele quem
injeta essas variáveis no processo via `env_file`, não o container que lê o
arquivo sozinho). As duas implementações geram o mesmo tipo de valor
(`secrets.token_hex(32)` aqui, `openssl rand -hex 32` lá) só porque são dois
pontos de entrada diferentes do mesmo fluxo — não é código duplicado por
descuido.
"""

import os
import secrets
import stat
import sys


def _generate_secret_key() -> str:
    return secrets.token_hex(32)


# Registro dos segredos que este programa sabe gerar sozinho. Chave = nome
# da variável de ambiente; valor = função que gera um valor novo válido.
# Pra adicionar um novo segredo gerável no futuro, basta uma linha aqui.
GENERATABLE_SECRETS = {
    "SECRET_KEY": _generate_secret_key,
}

_ENV_FILE_HEADER = (
    "# .env do RoomsCode.\n"
    "# Segredos como SECRET_KEY são gerados sozinhos na primeira execução,\n"
    "# se ainda não existirem aqui — normalmente você não precisa mexer\n"
    "# nessas linhas. Configuração não-secreta (ALLOWED_ORIGIN, FLASK_ENV,\n"
    "# TRUSTED_PROXY_COUNT etc.) continua exigindo edição manual quando você\n"
    "# quiser um valor diferente do padrão — ver .env.example.\n"
)


def _parse_env_file(path: str) -> dict:
    values = {}
    if not os.path.isfile(path):
        return values
    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def ensure_env_file(path: str) -> dict:
    """Garante que `path` tenha um valor pra cada segredo gerável ainda não
    definido (nem no arquivo, nem já numa variável de ambiente real — essa
    sempre tem prioridade e nunca é sobrescrita). Retorna o dicionário final
    de valores lidos/gerados.

    Uma falha ao gravar (ex.: filesystem somente leitura) não derruba a
    aplicação aqui — só avisa; quem decide se a ausência do valor é fatal é
    o Config, que continua recusando subir em produção sem SECRET_KEY,
    gerada ou não (ver app.py).
    """
    existing = _parse_env_file(path)
    newly_generated = {}

    for key, generator in GENERATABLE_SECRETS.items():
        if os.environ.get(key) or existing.get(key):
            continue
        value = generator()
        existing[key] = value
        newly_generated[key] = value

    if not newly_generated:
        return existing

    try:
        file_is_new = not os.path.isfile(path)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            if file_is_new:
                f.write(_ENV_FILE_HEADER)
            for key, value in newly_generated.items():
                f.write(f"{key}={value}\n")
        # O arquivo passa a conter segredo — restringe leitura a quem for
        # dono dele (best-effort: se o processo não puder mudar o modo,
        # ex. permissões do host num bind mount, apenas seguimos em frente).
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        print(
            f"[RoomsCode] .env não tinha {', '.join(newly_generated)} — "
            f"gerado(s) automaticamente e salvo(s) em {path}.",
            file=sys.stderr,
        )
    except OSError as exc:
        print(
            f"[RoomsCode] Aviso: não consegui gravar {', '.join(newly_generated)} "
            f"gerado(s) em {path} ({exc}). Os valores gerados só valem pra este "
            f"processo e vão mudar no próximo restart.",
            file=sys.stderr,
        )

    return existing


def bootstrap_env(path: str) -> None:
    """Garante o `.env` e carrega tudo que houver nele pro processo atual,
    sem nunca sobrescrever uma variável de ambiente já definida de verdade
    (ex.: passada via `docker run -e`, `env_file` do compose, ou já
    exportada no shell)."""
    values = ensure_env_file(path)
    for key, value in values.items():
        os.environ.setdefault(key, value)
