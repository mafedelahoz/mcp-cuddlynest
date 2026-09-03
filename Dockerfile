# CuddlyNest MCP server. Uses Playwright/Chromium to read the public listing
# page, so this needs a glibc base (not alpine) plus the browser + its system
# libraries.
FROM node:lts-bookworm-slim

WORKDIR /app

# Install deps without lifecycle scripts first (postinstall pulls the browser,
# which we do explicitly below with --with-deps so the OS libs come too).
COPY package*.json ./
RUN npm install --ignore-scripts

COPY . .

RUN npx playwright install --with-deps chromium \
  && npm run build

ENV NODE_ENV=production
# Containers are for hosting → default to the Streamable HTTP transport.
# Endpoint: POST http://<host>:$PORT/mcp   ·   health: GET /health
ENV MCP_TRANSPORT=http
ENV PORT=8080
EXPOSE 8080

CMD [ "node", "dist/index.js" ]
