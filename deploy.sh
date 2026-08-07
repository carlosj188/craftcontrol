#!/usr/bin/env bash
# edita local -> envia -> rebuild -> restart
# (usa tar via ssh, para não exigir rsync no servidor)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# Onde publicar. Ponha os seus valores em .deploy.env (fica fora do git) ou
# passe por variável de ambiente:
#
#     HOST=root@10.0.0.5 DEST=/opt/mc/painel ./deploy.sh
#
[ -f "$HERE/.deploy.env" ] && . "$HERE/.deploy.env"
HOST="${HOST:?defina HOST=usuario@servidor (ou crie .deploy.env)}"
DEST="${DEST:?defina DEST=/caminho/no/servidor (ou crie .deploy.env)}"
SERVICO="${SERVICO:-craftcontrol}"

# O frontend é um HTML único com o script inline: erro de sintaxe nele não aparece
# em lugar nenhum do build, o painel só abre em branco na tela de login. Uma const
# repetida já derrubou o script inteiro uma vez. Checa antes de subir.
echo "→ conferindo a sintaxe do painel"
JS="$(mktemp)"; trap 'rm -f "$JS"' EXIT
python3 - "$HERE/src/web/index.html" "$JS" <<'PY'
import io, sys
html = io.open(sys.argv[1], encoding="utf-8").read()
io.open(sys.argv[2], "w", encoding="utf-8").write(
    html[html.index("<script>") + 8 : html.rindex("</script>")])
PY
ssh "$HOST" "cat > /tmp/mcpanel-check.js" < "$JS"
ssh "$HOST" "docker run --rm -v /tmp/mcpanel-check.js:/c.js:ro node:22-alpine node --check /c.js" \
  || { echo "✗ o index.html tem erro de sintaxe — nada foi enviado"; exit 1; }

echo "→ enviando para $HOST:$DEST"
ssh "$HOST" "mkdir -p $DEST && rm -rf $DEST/src"
tar -C "$HERE" --exclude node_modules --exclude .git -cz src set-admin-password.sh .env.example \
  | ssh "$HOST" "tar -xz -C $DEST"
ssh "$HOST" "chmod +x $DEST/set-admin-password.sh"

echo "→ rebuild + restart"
# --no-deps: sem ele o depends_on recria o contêiner do minecraft junto e derruba quem está jogando
ssh "$HOST" "cd \"$(dirname "$DEST")\" && docker compose up -d --build --no-deps $SERVICO"

echo "→ status"
ssh "$HOST" "docker ps --filter name=$SERVICO --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'"
