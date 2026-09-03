# Hugging Face Space (Docker SDK) — runs the published `cuddlynest-mcp` over
# Streamable HTTP. The Chromium download happens once, here at build time.
#
# Bump CUDDLYNEST_MCP_VERSION on every `npm publish`, then push this Space again.
FROM node:22-bookworm-slim

ARG CUDDLYNEST_MCP_VERSION=0.2.0

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=7860 \
    HOME=/tmp \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Global install triggers the package's postinstall (`playwright install
# chromium`); the follow-up pulls the OS libraries the browser needs.
RUN npm install -g "cuddlynest-mcp@${CUDDLYNEST_MCP_VERSION}" \
 && npx --yes playwright install --with-deps chromium \
 && npm cache clean --force

# HF routes external traffic to app_port (see README frontmatter).
EXPOSE 7860
CMD ["sh", "-c", "cuddlynest-mcp --http ${PORT}"]
