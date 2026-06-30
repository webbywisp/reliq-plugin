# Reliq — Claude Code plugin

Install **one** thing and connect Claude Code to **Reliq**, your personal memory.
This plugin bundles everything a new user needs so they never have to hand-edit
settings, paste rules files, or wire up hooks by hand.

## What it bundles

| Component | File | What it does |
|---|---|---|
| **MCP connector** | `.mcp.json` | Adds the Reliq MCP server (`https://mcp.reliq.sh/mcp`, Streamable HTTP) as `reliq`, exposing `mcp__reliq__*` tools (`get_context`, `search_memory`, `get_person`, `remember`, `add_note`, `expand`, …) and the `reliq://context` resource. Auth is Claude Code's built-in **MCP OAuth** flow — no secret in the file. |
| **SessionStart hook** | `hooks/hooks.json` | Runs `bin/reliq context` when a session starts/resumes, which fetches your Reliq context and injects it (plus a "capture durable facts to Reliq as you go" directive) into the conversation via `additionalContext`. |
| **SessionEnd hook** | `hooks/hooks.json` | Runs `bin/reliq capture` when a session ends, deriving a **deterministic git-based session record** (repo / branch / diffstat / commit subjects — never raw transcripts or file bodies) and POSTing it to Reliq. This is the no-inference backstop. |
| **Skill** | `skills/reliq/SKILL.md` | Tells the agent it has Reliq as the user's memory: read context at session start, and proactively save durable decisions/conventions/gotchas via `remember` / `add_note` without being asked. |
| **Slash commands** | `commands/login.md`, `commands/status.md` | `/reliq:login` and `/reliq:status` — thin wrappers over the bundled CLI. |
| **CLI** | `bin/reliq` | The `reliq` command the hooks and slash commands call (`context`, `capture`, `login`, `status`). Bundled with the plugin and on `PATH` when the plugin is enabled. |

The two capture paths overlap on purpose: the **skill** drives the rich
*agent-summary* path (the agent volunteers the *why* on your existing token
budget), and the **SessionEnd hook** guarantees a factual skeleton of every
session lands even if the agent forgets. Reliq pays for **no** inference in
either path — see [`docs/research/capturing-coding-agent-interactions.md`](../../docs/research/capturing-coding-agent-interactions.md).

## Install (for a new user)

This is the open-source **client** plugin (MIT) — a thin client that connects
Claude Code to *your own* private Reliq server. It ships only the `.mcp.json`
URL, the session hooks, and the small `reliq` OAuth/git CLI; no Reliq core or
server code lives here. It is distributed from the public repo
**`webbywisp/reliq-plugin`** (this `plugins/reliq/` directory is the dev source
of truth; the public repo is published from it).

From any Claude Code session:

```text
/plugin marketplace add webbywisp/reliq-plugin
/plugin install reliq@reliq
/reliq:login
```

`/plugin marketplace add webbywisp/reliq-plugin` registers the public
`webbywisp/reliq-plugin` marketplace; `/plugin install reliq@reliq` installs this
plugin from it (`reliq@reliq` = the `reliq` plugin from the `reliq` marketplace);
`/reliq:login` authenticates the device-side CLI once per device (see below).

## One-time setup per device

After installing, do these once on each device:

1. **Authenticate the device-side CLI:**
   ```text
   /reliq:login
   ```
   This caches a local token so the hooks can read your context and capture
   sessions. It does **not** write a committed `.env` or any secret into a repo.
   Verify any time with `/reliq:status`.

2. **Authorize the MCP connector (if prompted):** run `/mcp` and complete the
   OAuth login for the `reliq` server. (Separate from `reliq login`: OAuth gates
   the `mcp__reliq__*` tools; `reliq login` gates the device-side hooks/CLI.)

That's it. New sessions now load your Reliq context automatically and capture
what you work on.

## Optional: per-turn capture (`Stop`)

The shipped `hooks/hooks.json` captures **once per session** on `SessionEnd` —
the right cadence for most users. If you want capture after **every turn**
instead, add a `Stop` entry that calls the same CLI:

```json
"Stop": [
  {
    "hooks": [
      { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/reliq", "args": ["capture"], "timeout": 20 }
    ]
  }
]
```

`Stop` has no matcher (it always fires) and runs after every response, so it is
noisier. Reliq's ingest is idempotent on content, so identical records are
no-ops; a changing diff each turn still produces multiple records. Prefer
`SessionEnd` unless you specifically want per-turn granularity.

## Privacy

- Hooks **never block** your session — all failures exit cleanly.
- The session record is **git signals only** (diff stats, file names, commit
  subjects) — never raw file contents or transcripts.
- A repo allowlist and secret-redaction pass apply on the capture path (see the
  CLI's own docs).

For full details on what Reliq collects and how it's handled, see the
**[Reliq Privacy Policy](https://[reliq-domain]/privacy)**.
