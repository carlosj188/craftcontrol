FROM node:22-bookworm-slim

WORKDIR /app

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
