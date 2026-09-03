---
title: CuddlyNest MCP
emoji: 🛎️
colorFrom: pink
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: MCP server for CuddlyNest hotel search, rooms & pricing
---

# CuddlyNest MCP — hosted

Runs [`cuddlynest-mcp`](https://www.npmjs.com/package/cuddlynest-mcp) over the
MCP **Streamable HTTP** transport.

| | |
| --- | --- |
| MCP endpoint | `POST https://<this-space>.hf.space/mcp` |
| Health | `GET  https://<this-space>.hf.space/health` |

Read-only: hotel search + listing details. No booking, no payment. Reads
publicly available CuddlyNest page content only.

Source, tools and docs: <https://github.com/mafedelahoz/mcp-cuddlynest>

> Free-tier Space: it sleeps after a period of inactivity and takes ~30 s to
> wake on the next request.
