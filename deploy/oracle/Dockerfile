# cuddlynest-mcp for an always-on host (Oracle Cloud Always Free, or any VM).
# Multi-arch: node:22-bookworm-slim has arm64 (Ampere A1) and amd64.
FROM node:22-bookworm-slim

ARG CUDDLYNEST_MCP_VERSION=0.2.0

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=8080 \
    HOME=/tmp \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN npm install -g "cuddlynest-mcp@${CUDDLYNEST_MCP_VERSION}" \
 && npx --yes playwright install --with-deps chromium \
 && npm cache clean --force

EXPOSE 8080
# Simple liveness for `docker compose` / orchestrators.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+ (process.env.PORT||8080) +'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "cuddlynest-mcp --http ${PORT}"]
