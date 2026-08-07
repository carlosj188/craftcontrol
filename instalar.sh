#!/usr/bin/env bash
# CraftControl — prepara o .env e sobe o painel.
#
#     ./instalar.sh
#
# Roda quantas vezes quiser: o que já está preenchido é mantido, e só o que
# falta é perguntado. Não toca no seu servidor de Minecraft.
set -euo pipefail

cd "$(dirname "$0")"

verde() { printf '\033[0;32m%s\033[0m\n' "$1"; }
amarelo() { printf '\033[0;33m%s\033[0m\n' "$1"; }
vermelho() { printf '\033[0;31m%s\033[0m\n' "$1" >&2; }

# ---------- pré-requisitos ----------

command -v docker >/dev/null || { vermelho "Docker não encontrado. Instale antes: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { vermelho "Falta o plugin 'docker compose' (v2)."; exit 1; }

segredo() {
  if command -v openssl >/dev/null; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# ---------- .env ----------

[ -f .env ] || { cp .env.example .env; chmod 600 .env; verde "→ .env criado a partir do exemplo"; }
chmod 600 .env

# Lê um valor do .env sem executar o arquivo.
ler() { sed -n "s/^$1=//p" .env | head -1; }

# Grava uma chave no .env preservando o resto.
gravar() {
  local chave="$1" valor="$2"
  if grep -q "^${chave}=" .env; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$chave" -v v="$valor" -F= '
      $1 == k { print k "=" v; feito=1; next } { print }
      END { if (!feito) print k "=" v }' .env > "$tmp"
    mv "$tmp" .env
  else
    printf '%s=%s\n' "$chave" "$valor" >> .env
  fi
  chmod 600 .env
}

# Pergunta só o que ainda está vazio ou como "troque-me".
perguntar() {
  local chave="$1" rotulo="$2" padrao="${3:-}" secreto="${4:-}"
  local atual; atual="$(ler "$chave")"
  if [ -n "$atual" ] && [ "$atual" != "troque-me" ]; then return; fi

  local resposta
  if [ "$secreto" = "secreto" ]; then
    read -rsp "$rotulo: " resposta </dev/tty; echo
  else
    read -rp "$rotulo${padrao:+ [$padrao]}: " resposta </dev/tty
  fi
  gravar "$chave" "${resposta:-$padrao}"
}

echo
verde "CraftControl — configuração"
echo "Só é perguntado o que ainda falta. Enter aceita o valor entre colchetes."
echo

perguntar MC_DATA      "Pasta de dados do servidor (a que tem world/ e mods/)" "./data"
perguntar MC_CONTAINER "Nome do contêiner do Minecraft"                        "minecraft"
perguntar MC_HOST      "Nome do serviço do Minecraft na rede do Docker"        "mc"
perguntar MC_NAME      "Nome do servidor (só aparência)"                       "Meu Servidor"
perguntar RCON_PASSWORD "Senha do RCON (a mesma do server.properties)"         "" secreto
perguntar ADMIN_USER   "Usuário do painel"                                     "admin"
perguntar ADMIN_PASSWORD "Senha do painel"                                     "" secreto

# JWT_SECRET ninguém precisa escolher.
jwt="$(ler JWT_SECRET)"
if [ -z "$jwt" ] || [ "$jwt" = "troque-me" ]; then
  gravar JWT_SECRET "$(segredo)"
  verde "→ JWT_SECRET gerado"
fi

# ---------- conferências que evitam dor de cabeça ----------

dados="$(ler MC_DATA)"
if [ ! -d "$dados" ]; then
  amarelo "! A pasta '$dados' não existe. Confira MC_DATA no .env."
elif [ ! -d "$dados/world" ] && [ ! -d "$dados/mods" ]; then
  amarelo "! Em '$dados' não achei world/ nem mods/ — tem certeza que é a pasta de dados do servidor?"
fi

dono="$(stat -c %u "$dados" 2>/dev/null || echo "")"
if [ -n "$dono" ] && [ "$dono" != "1000" ]; then
  amarelo "! '$dados' pertence ao uid $dono, e o painel roda como 1000."
  amarelo "  Instalar mod e restaurar mundo vão falhar. Para corrigir:"
  amarelo "      sudo chown -R 1000:1000 $dados"
fi

alvo="$(ler MC_CONTAINER)"
if ! docker ps --format '{{.Names}}' | grep -qx "$alvo"; then
  amarelo "! Não achei um contêiner chamado '$alvo' rodando."
  amarelo "  O painel sobe assim mesmo, mas o controle de energia não vai funcionar."
fi

# ---------- sobe ----------

echo
verde "→ subindo o painel"
docker compose up -d

porta="$(ler PANEL_PORT)"; porta="${porta:-8095}"
ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
verde "Pronto."
echo "   Painel:  http://${ip:-localhost}:${porta}"
echo "   Usuário: $(ler ADMIN_USER)"
echo
echo "   Logs:    docker compose logs -f craftcontrol"
echo "   Parar:   docker compose down"
