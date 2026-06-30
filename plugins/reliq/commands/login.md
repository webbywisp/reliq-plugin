---
description: Authenticate this device to Reliq (one-time per device) so the hooks can read your context and capture sessions.
---

Run the bundled Reliq CLI to log in this device:

```sh
"${CLAUDE_PLUGIN_ROOT}/bin/reliq" login
```

This is a **one-time step per device**. `reliq login` authenticates you and
caches a token locally (it does NOT write a committed `.env` or any secret into
the repo). After it succeeds, the plugin's SessionStart hook can load your Reliq
context and the SessionEnd hook can capture each coding session.

Note: the Reliq MCP connector itself authenticates separately via Claude Code's
built-in MCP OAuth flow (run `/mcp` and authorize `reliq` if prompted). `reliq
login` is for the device-side hooks/CLI; OAuth is for the MCP tools.

After running it, briefly report whether login succeeded (run `reliq status` if
unsure).
