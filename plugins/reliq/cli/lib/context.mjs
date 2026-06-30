// context.mjs — render a Reliq ContextPack into the Claude Code SessionStart
// hook output shape.
//
// SessionStart hooks inject context by emitting JSON on stdout with:
//   { "hookSpecificOutput": { "hookEventName": "SessionStart",
//                             "additionalContext": "<string>" } }
// The additionalContext string is prepended to the session as context.
//
// We render a COMPACT view of the pack (titles + gists, not full bodies — those
// cost tokens and the agent can `expand` on demand) plus a STANDING DIRECTIVE
// telling the connected agent to write durable facts back to Reliq proactively.

export const STANDING_DIRECTIVE =
  "As we work, persist durable decisions/conventions/gotchas to Reliq via " +
  "remember/add_note immediately — don't wait to be asked.";

// Shown ONLY on a brand-new/unauthenticated device (no cached credentials and no
// RELIQ_TOKEN). It tells the agent to surface a one-liner so the user knows Reliq
// isn't capturing yet and how to turn it on. Kept friendly + non-spammy: it only
// appears while truly unauthenticated.
export const LOGIN_NUDGE =
  "Reliq isn't connected on this device yet, so nothing is being captured. " +
  "Tell the user (surface this once, briefly): run `/reliq:login` to connect " +
  "Reliq and start capturing your work automatically.";

/** One compact line for a memory card: "• title — gist [type]". */
function renderCard(c) {
  if (!c) return null;
  const title = (c.title || c.gist || c.id || "").toString().trim();
  if (!title) return null;
  const gist = c.gist && c.gist !== c.title ? ` — ${String(c.gist).trim()}` : "";
  const why = c.why ? ` (${c.why})` : "";
  const type = c.type ? ` [${c.type}]` : "";
  return `• ${title}${gist}${type}${why}`;
}

function section(heading, cards) {
  const lines = (cards || []).map(renderCard).filter(Boolean);
  if (lines.length === 0) return null;
  return [`${heading}:`, ...lines].join("\n");
}

/**
 * Render a ContextPack ({ pinned, cards, adjacent, people, ... }) into a compact
 * additionalContext string, always ending with the standing directive.
 * Tolerant of a null/empty pack (directive-only).
 */
export function renderAdditionalContext(pack) {
  const blocks = [];
  if (pack) {
    const pinned = section("Pinned (core profile)", pack.pinned);
    const cards = section("Relevant memory", pack.cards);
    const adjacent = section("Connected", pack.adjacent);
    const people = section("People", pack.people);
    for (const b of [pinned, cards, adjacent, people]) if (b) blocks.push(b);
  }

  const header =
    blocks.length > 0
      ? "Reliq memory about this user (call `expand(id)` for full detail; `search_memory` for more):"
      : "Reliq: no stored context loaded for this session.";

  return [header, ...blocks, "", STANDING_DIRECTIVE].join("\n").trim() + "\n";
}

/** Wrap an additionalContext string in the SessionStart hook output envelope. */
export function sessionStartOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

/**
 * The fail-safe output emitted when Reliq is unauthed/unreachable: never blocks
 * the session, still nudges the agent to write back via the standing directive.
 *
 * @param {{ unauthenticated?: boolean }} [opts] When `unauthenticated` is true
 *   (no cached credentials AND no RELIQ_TOKEN — a brand-new device), prepend a
 *   friendly one-liner telling the user to run `/reliq:login`. Omitted when the
 *   user IS authenticated but a fetch merely failed (avoids false "not connected"
 *   nudges).
 */
export function directiveOnlyOutput(opts = {}) {
  const base = renderAdditionalContext(null);
  const text = opts.unauthenticated ? `${LOGIN_NUDGE}\n\n${base}` : base;
  return sessionStartOutput(text);
}

/**
 * Unwrap the MCP `tools/call` result for get_context. The server returns
 * { content: [{ type: "text", text: "<json>" }] } where the JSON is the
 * ContextPack. Returns the parsed pack, or null if it can't be extracted.
 */
export function unwrapMcpContextPack(toolResult) {
  try {
    const text = toolResult?.content?.find?.((c) => c?.type === "text")?.text;
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
