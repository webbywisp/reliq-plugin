# Reliq — Claude Code plugin

This repository is the **public marketplace** for the **Reliq Claude Code
plugin**: the client that connects Claude Code to your personal Reliq memory.

> This repo contains the **client plugin only** — not the Reliq product/server.
> The plugin is a thin client: an MCP server URL, session hooks, and a small
> device-side CLI for auth + deterministic git capture. It talks to **your own
> Reliq server** over MCP; it ships no Reliq core/server code. Licensed MIT.

## Install

From any Claude Code session:

```text
/plugin marketplace add webbywisp/reliq-plugin
/plugin install reliq@reliq
/reliq:login
```

- `/plugin marketplace add webbywisp/reliq-plugin` registers this repo's
  marketplace (`.claude-plugin/marketplace.json`).
- `/plugin install reliq@reliq` installs the `reliq` plugin from the `reliq`
  marketplace.
- `/reliq:login` authenticates the device-side CLI once per device so the hooks
  can read your context and capture sessions. Verify any time with
  `/reliq:status`.

If prompted, also run `/mcp` and complete the OAuth login for the `reliq`
server — that gates the `mcp__reliq__*` tools (separate from `/reliq:login`,
which gates the device-side hooks/CLI).

## What it does

- **MCP connector** (`.mcp.json`) — adds the Reliq MCP server (Streamable HTTP)
  as `reliq`, exposing `mcp__reliq__*` tools (`get_context`, `search_memory`,
  `get_person`, `remember`, `add_note`, `expand`, …). Auth is Claude Code's
  built-in MCP OAuth flow — no secret in the file.
- **SessionStart hook** — loads your Reliq context into each new session.
- **SessionEnd hook** — captures a **deterministic git-based** session record
  (repo / branch / diffstat / commit subjects — never raw transcripts or file
  bodies) and sends it to Reliq.
- **Skill** — tells the agent to read your context and proactively save durable
  decisions, conventions, and gotchas to your memory.
- **Slash commands** — `/reliq:login` and `/reliq:status`.

## Privacy

- Hooks never block your session — all failures exit cleanly.
- The session record is **git signals only** (diff stats, file names, commit
  subjects) — never raw file contents or transcripts.
- A repo allowlist and secret-redaction pass apply on the capture path.

## License

MIT — see [LICENSE](./LICENSE). This is the client plugin; it is not the Reliq
product.
