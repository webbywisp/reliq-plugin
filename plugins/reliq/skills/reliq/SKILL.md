---
name: reliq
description: You are connected to Reliq, the user's personal memory (an MCP server). Use this whenever you start work or learn a durable fact about the user's projects, conventions, decisions, people, or gotchas — read context at session start and proactively save durable signal without being asked.
---

# Reliq — the user's memory

You are connected to **Reliq**, the user's personal memory and context substrate,
over MCP. Reliq stores, organizes, and retrieves what's known about the user —
their projects, conventions, prior decisions, recurring people, and gotchas. It
is **not** an AI; the intelligence is yours. Reliq supplies memory; you supply
reasoning.

The Reliq MCP server is bundled with this plugin (see the `reliq` MCP connector).
Its tools appear as `mcp__reliq__*` — for example `get_context`, `search_memory`,
`get_person`, `remember`, `add_note`, and `expand`. There is also a
`reliq://context` resource you can read directly.

## At session start — READ

Before doing substantive work, load what's already known so you don't relearn
the user's setup from scratch:

- Call **`get_context`** with a short description of the task to pull the relevant
  project, conventions, and prior decisions. (The plugin's SessionStart hook also
  injects a context snapshot automatically; still call `get_context` when you need
  more, or when the task is specific.)
- If a specific person, project, or topic is named, also **`search_memory`** /
  **`get_person`** for it.
- Prefer compact reads; only **`expand`** an item when you need its full body.
- Don't announce the lookup — just use what you learn.

## As you work — WRITE (without being asked)

When you establish or discover a **durable fact** — a decision, convention,
gotcha, architecture choice, recurring command, or who owns what — save it
proactively. Do not wait to be told:

- **`remember`** for structured facts (subject–predicate–object, e.g.
  *decided* / *uses* / *works_on*).
- **`add_note`** for freeform detail and rationale.

Save the **durable signal, not chatter** — skip transient back-and-forth, and
**never save secrets** the user asks to keep private (tokens, credentials,
private keys). When in doubt about whether something is durable, a short
`add_note` is cheap; raw conversation is not worth saving.

## Why this matters

Coding-agent interactions are ~90% of the context the user wants Reliq to hold.
MCP is pull-based — nothing forces a write — so your proactive saves are what make
Reliq useful over time. (A deterministic git-based session record is also
captured by the plugin's SessionEnd hook as a backstop, but it only captures
*what changed*, not the *why* — that part is yours to record.)
