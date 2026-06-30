---
description: Show Reliq auth/connection status for this device — whether reliq login has been completed and the CLI can reach the server.
---

Run the bundled Reliq CLI to check status:

```sh
"${CLAUDE_PLUGIN_ROOT}/bin/reliq" status
```

Report the result concisely: whether this device is logged in (`reliq login`
completed), who it's authenticated as, and whether the CLI can reach the Reliq
server (`https://mcp.reliq.sh`). If it reports "not logged in", tell the
user to run `/reliq:login`.
