#!/bin/bash
# Script de atualização do RoomsCode em produção.
#
# Modelo: docker compose down -> git fetch/reset --hard origin/main ->
# docker compose up -d --build
#
# O RoomsCode não tem banco de dados nem uploads persistentes (o estado das
# salas é 100% em memória, por design do projeto) e a SECRET_KEY não vive
# dentro da pasta do projeto — ela é gerada sozinha por
# backend/secrets_bootstrap.py e persistida no volume Docker nomeado
# "roomscode_data" (ver docker-compose.yml), que "docker compose down"
# (sem "-v") nunca apaga. Ou seja: não existe nenhum arquivo dentro de
# $APP_DIR que precise ser preservado manualmente entre deploys — "git
# reset --hard" não afeta nada que precise sobreviver a esse comando.
set -euo pipefail

APP_DIR="/opt/roomscode"          # ajuste para o caminho real no servidor
COMPOSE_DIR="$APP_DIR"            # onde fica o docker-compose.yml (mesmo dir aqui)

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

cd "$COMPOSE_DIR"

echo "-> Parando containers (sem remover o volume de dados)..."
docker compose down

echo "-> Atualizando código-fonte (git fetch/reset --hard origin/main)..."
cd "$APP_DIR"
git fetch origin
git reset --hard origin/main

echo "-> Subindo containers (rebuild)..."
cd "$COMPOSE_DIR"
docker compose up -d --build

echo "-> Deploy concluído. Últimas linhas de log:"
docker compose logs --tail=30
