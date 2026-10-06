#!/bin/bash
# Script de atualização do RoomsCode em produção.
#
# Modelo:
#   docker compose down
#   -> git fetch/reset --hard origin/main
#   -> docker compose up -d --build
#
# Este script fica dentro do próprio repositório Git.
# O diretório do projeto é descoberto automaticamente a partir
# da localização deste arquivo, portanto não é necessário definir
# manualmente o APP_DIR.
#
# Após o git reset --hard, o próprio script restaura sua permissão
# de execução com chmod +x, evitando a necessidade de executar
# chmod manualmente após cada atualização.

set -euo pipefail

# Caminho absoluto deste próprio script.
SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"

# Diretório raiz do projeto/repositório.
APP_DIR="$(dirname "$SCRIPT_PATH")"

# O docker-compose.yml fica na raiz do projeto.
COMPOSE_DIR="$APP_DIR"

echo "=============================================================="
echo "  AVISO: este deploy derruba o container e reinicia o processo."
echo "  Como o estado das salas do RoomsCode vive em memória (não tem"
echo "  banco de dados), TODAS as salas ativas nesse momento serão"
echo "  perdidas — hosts e espectadores conectados vão cair e"
echo "  precisar recriar/entrar na sala de novo depois do restart."
echo "  Isso é uma característica aceita do projeto, não um bug."
echo "=============================================================="

read -r -p "Continuar mesmo assim? [s/N] " confirm

if [[ ! "$confirm" =~ ^[sS]$ ]]; then
    echo "Cancelado."
    exit 0
fi

echo
echo "-> Diretório do projeto: $APP_DIR"

echo "-> Parando containers (sem remover o volume de dados)..."
cd "$COMPOSE_DIR"
docker compose down

echo "-> Atualizando código-fonte..."
cd "$APP_DIR"

git fetch origin
git reset --hard origin/main

# O git reset pode restaurar o script sem a permissão de execução.
# Como o script ainda está em execução, ele pode restaurar sua
# própria permissão para as próximas execuções.
chmod +x "$SCRIPT_PATH"

echo "-> Permissão de execução do script restaurada."

echo "-> Subindo containers (rebuild)..."
cd "$COMPOSE_DIR"
docker compose up -d --build

echo
echo "-> Deploy concluído. Últimas linhas de log:"
docker compose logs --tail=30