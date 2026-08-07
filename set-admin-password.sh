#!/usr/bin/env bash
# Define a senha de login do painel sem ela aparecer no terminal ou no histórico.
# Uso: ./set-admin-password.sh   (na pasta do compose)
set -euo pipefail

ENV_FILE="${ENV_FILE:-./.env}"
[ -f "$ENV_FILE" ] || { echo "não achei $ENV_FILE"; exit 1; }

read -rsp "Nova senha do painel: " p1; echo
read -rsp "Confirme:             " p2; echo
[ "$p1" = "$p2" ] || { echo "as senhas não conferem"; exit 1; }
[ ${#p1} -ge 8 ] || { echo "use pelo menos 8 caracteres"; exit 1; }
case "$p1" in *$'\n'*|*'"'*) echo "sem aspas ou quebras de linha, por favor"; exit 1;; esac

tmp=$(mktemp); chmod 600 "$tmp"
grep -v '^ADMIN_PASSWORD=' "$ENV_FILE" > "$tmp" || true
printf 'ADMIN_PASSWORD=%s\n' "$p1" >> "$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
unset p1 p2

echo "senha gravada. aplicando..."
docker compose up -d ${SERVICO:-craftcontrol}
echo "pronto."
