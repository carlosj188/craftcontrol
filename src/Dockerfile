FROM node:22-bookworm-slim

WORKDIR /app

# `unzip` para restaurar mundo empacotado em .zip — o caminho de quem descompacta,
# edita no MCA Selector e compacta de novo pelo próprio Windows. O leitor de zip
# que o painel já tem (jar.js) não serve aqui: ele não trata ZIP64, e mundo passa
# fácil dos limites que o formato antigo aguenta. `tar` e `gzip` a base já traz.
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="CraftControl"
LABEL org.opencontainers.image.description="Painel web para administrar servidor Minecraft (Fabric/Forge/NeoForge) via RCON"
LABEL org.opencontainers.image.source="https://github.com/carlosj188/craftcontrol"
LABEL org.opencontainers.image.licenses="MIT"

COPY backend/package*.json ./
# ci + lockfile: o deploy instala exatamente o que foi testado, nada de semver surpresa
RUN npm ci --omit=dev

COPY backend/ ./
COPY web/ ./public

ENV NODE_ENV=production
EXPOSE 8095
# mesmo uid do dono dos dados do servidor: escreve no volume sem chown e sem root
USER 1000:1000
CMD ["node", "src/server.js"]
