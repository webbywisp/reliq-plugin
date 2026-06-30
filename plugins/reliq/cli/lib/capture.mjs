// capture.mjs — deterministic, no-inference coding-session record builder.
//
// Ports integrations/reliq-capture/reliq-capture.sh to Node. Reliq must never
// pay for LLM inference (CLAUDE.md hard constraint), so the session record is
// derived from GIT SIGNALS ONLY — never raw file contents or transcripts:
//   - branch
//   - git diff --stat HEAD          (uncommitted change summary)
//   - git diff --name-only HEAD     (files touched, capped)
//   - last 10 git log subjects      (committed narrative)
// A redaction pass masks token-shaped strings as a safety net.
//
// All git access goes through an injected `git(args, cwd)` runner so the record
// builder + redaction + allowlist + stdin parsing are PURE and unit-testable
// with no real repo / network.

import { execFileSync } from "node:child_process";

const MAX_FILES = 50;
const MAX_COMMITS = 10;

/** Default git runner: returns trimmed stdout, or "" on any failure. */
export function makeGitRunner() {
  return (args, cwd) => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000,
      }).trim();
    } catch {
      return "";
    }
  };
}

/**
 * Parse a Claude Code hook stdin payload (SessionEnd / Stop / SessionStart).
 * Tolerant: returns {} for empty / malformed input so capture never throws.
 * Known fields: session_id, cwd, reason, hook_event_name.
 */
export function parseHookInput(raw) {
  if (!raw || !raw.trim()) return {};
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== "object") return {};
  const pick = (k) => (typeof obj[k] === "string" ? obj[k] : undefined);
  return {
    sessionId: pick("session_id"),
    cwd: pick("cwd"),
    reason: pick("reason"),
    event: pick("hook_event_name"),
  };
}

/**
 * Redact obvious token-shaped strings (defence in depth — we never ship file
 * contents, but a commit subject could contain a leaked secret). Mirrors the
 * bash prototype's sed rules.
 */
export function redact(text) {
  if (!text) return text;
  return String(text)
    .replace(/(reliq_(?:pat|at|rt)_)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9]{8})[A-Za-z0-9]+/g, "$1[REDACTED]")
    .replace(/(gh[pousr]_)[A-Za-z0-9]+/g, "$1[REDACTED]")
    .replace(/(AKIA)[A-Z0-9]{12,}/g, "$1[REDACTED]")
    // generic Bearer header values
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{12,}/g, "$1[REDACTED]");
}

/**
 * Decide whether a repo is allowed to be captured.
 *  - empty allowlist  => allow all
 *  - non-empty        => allow only exact-path members
 */
export function isRepoAllowed(repoRoot, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.includes(repoRoot);
}

/** basename without importing path (keeps this module dependency-light). */
function baseName(p) {
  const parts = String(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/**
 * Build the deterministic git record for a session.
 * Returns { skipped, reason?, repoRoot?, repoName?, filename?, markdown? }.
 *
 * @param {object}   hook       parsed hook input (parseHookInput output)
 * @param {object}   opts
 * @param {string[]} opts.allowlist  repo allowlist (exact paths); [] = allow all
 * @param {function} opts.git        git runner (args, cwd) -> stdout|""
 * @param {function} opts.now        () -> Date (injectable for deterministic tests)
 * @param {string}   opts.fallbackCwd process cwd when the hook omits one
 */
export function buildGitRecord(hook, opts = {}) {
  const git = opts.git || makeGitRunner();
  const now = opts.now ? opts.now() : new Date();
  const allowlist = opts.allowlist || [];
  const cwd = hook.cwd || opts.fallbackCwd || process.cwd();

  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  if (!repoRoot) {
    return { skipped: true, reason: `no git repo at ${cwd}` };
  }
  if (!isRepoAllowed(repoRoot, allowlist)) {
    return { skipped: true, reason: `repo ${repoRoot} not in allowlist`, repoRoot };
  }

  const repoName = baseName(repoRoot);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot) || "unknown";
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  let diffstat = git(["diff", "--stat", "HEAD"], repoRoot);
  if (!diffstat) diffstat = "(no uncommitted changes)";
  diffstat = redact(diffstat);

  let commits = git(["log", "--pretty=format:- %h %s", `-n`, String(MAX_COMMITS)], repoRoot);
  if (!commits) commits = "(no commits)";
  commits = redact(commits);

  const filesRaw = git(["diff", "--name-only", "HEAD"], repoRoot);
  const files = filesRaw
    ? filesRaw.split("\n").filter(Boolean).slice(0, MAX_FILES).join("\n")
    : "(none)";

  const reasonSuffix = hook.reason ? ` (reason: ${hook.reason})` : "";
  const markdown = [
    `# Coding session — ${repoName} (${branch})`,
    ``,
    `- repo: ${repoName}`,
    `- repo_path: ${repoRoot}`,
    `- branch: ${branch}`,
    `- captured_at: ${iso}`,
    `- harness_event: ${hook.event || "unknown"}${reasonSuffix}`,
    `- session_id: ${hook.sessionId || "unknown"}`,
    ``,
    `## Files changed (git diff --stat HEAD)`,
    "```",
    diffstat,
    "```",
    ``,
    `## Recent commits`,
    commits,
    ``,
    `## Files touched`,
    files,
    ``,
  ].join("\n");

  const stamp = iso.replace(/[-:]/g, "").replace(/Z$/, "Z");
  const filename = `coding-session-${repoName}-${stamp}.md`;

  return { skipped: false, repoRoot, repoName, branch, filename, markdown };
}

/** Build the JSON body for POST /ingest/document. */
export function ingestDocumentBody(filename, markdown) {
  return { filename, content: markdown, mime: "text/markdown" };
}
