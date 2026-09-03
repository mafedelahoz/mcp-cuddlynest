# CuddlyNest MCP — Hugging Face Space (paid tier)

> ⚠️ As of ~July 2026 Hugging Face charges for the **Docker SDK** — the free
> CPU-basic tier no longer covers Docker Spaces. For a genuinely-free
> always-on host use **[`../oracle/`](../oracle/SETUP.md)** (Oracle Cloud
> Always Free). Keep these files only if you have an HF plan that includes
> Docker Spaces.

The Space frontmatter + Dockerfile below run
[`cuddlynest-mcp`](https://www.npmjs.com/package/cuddlynest-mcp) over Streamable
HTTP, pulling it from npm at build time. Endpoint: `POST /mcp`, health: `GET
/health`. Read-only; reads publicly available CuddlyNest page content only.
Source: <https://github.com/mafedelahoz/mcp-cuddlynest>

<!-- Space frontmatter, if you do use HF:
---
title: CuddlyNest MCP
emoji: 🛎️
colorFrom: pink
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---
-->
