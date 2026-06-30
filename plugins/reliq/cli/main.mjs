// main.mjs — `reliq` CLI dispatcher. Subcommands: login, status, context, capture.
//
// The CLI is the portability + capture engine behind the Reliq Claude Code
// plugin's hooks. It is deterministic (no LLM inference) and FAILS SAFE on the
// hook paths (context/capture exit 0 even on error so a session is never
// blocked).

import { readStdin } from "./lib/stdin.mjs";
import {
  resolveSettings,
  writeCredentials,
  tokenPrefix,
  DEFAULT_ENDPOINT,
} from "./lib/config.mjs";
import { loopbackLogin } from "./lib/oauth.mjs";
import { httpJson, mcpToolsCall } from "./lib/http.mjs";
import {
  parseHookInput,
  buildGitRecord,
  ingestDocumentBody,
} from "./lib/capture.mjs";
import {
  renderAdditionalContext,
  sessionStartOutput,
  directiveOnlyOutput,
  unwrapMcpContextPack,
} from "./lib/context.mjs";

function log(msg) {
  process.stderr.write(`reliq: ${msg}\n`);
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Validate a PAT/access token by calling get_context with a tiny budget. */
async function validateToken(endpoint, token) {
  try {
    const result = await mcpToolsCall(
      endpoint,
      token,
      "get_context",
      { intent: "reliq cli auth check", budget: 100 },
      { timeoutMs: 12000 },
    );
    return { ok: true, pack: unwrapMcpContextPack(result) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── reliq login ────────────────────────────────────────────────────────────
async function cmdLogin(argv) {
  const settings = resolveSettings();
  const endpoint = settings.endpoint || DEFAULT_ENDPOINT;

  // --token <tok> or --token - (stdin) fallback: paste/validate/cache a PAT.
  const tokenFlagIdx = argv.indexOf("--token");
  if (tokenFlagIdx >= 0) {
    let token = argv[tokenFlagIdx + 1];
    if (!token || token === "-") {
      token = (await readStdin()).trim();
    }
    token = (token || "").trim();
    if (!token) {
      log("no token provided (use --token <reliq_pat_…> or pipe it to --token -)");
      return 1;
    }
    log(`validating token against ${endpoint} …`);
    const v = await validateToken(endpoint, token);
    if (!v.ok) {
      log(`token did NOT validate: ${v.error}`);
      return 1;
    }
    const path = writeCredentials({
      token,
      endpoint,
      expiresAt: null,
      obtainedVia: "token-paste",
      savedAt: new Date().toISOString(),
    });
    log(`token validated and cached → ${path} (${tokenPrefix(token)})`);
    return 0;
  }

  // Default: full loopback OAuth 2.1 + PKCE + DCR.
  log(`starting OAuth login against ${endpoint} …`);
  try {
    const creds = await loopbackLogin(endpoint, {
      openBrowser: (url) => {
        log(`opening browser to authorize. If it doesn't open, visit:\n${url}`);
        // also attempt the OS open via the default in oauth.mjs
        import("node:child_process").then(({ spawn }) => {
          const p = process.platform;
          const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
          const args = p === "win32" ? ["/c", "start", "", url] : [url];
          try {
            spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
          } catch {
            /* printed above for manual paste */
          }
        });
      },
    });
    const path = writeCredentials({
      ...creds,
      savedAt: new Date().toISOString(),
    });
    log(`logged in. credentials cached → ${path} (${tokenPrefix(creds.token)})`);
    return 0;
  } catch (e) {
    log(`OAuth login failed: ${e.message}`);
    log(
      "fallback: create a PAT in the Reliq dashboard and run `reliq login --token <reliq_pat_…>`.",
    );
    return 1;
  }
}

// ── reliq status ───────────────────────────────────────────────────────────
async function cmdStatus(argv) {
  const s = resolveSettings();
  const json = argv.includes("--json");
  const authed = Boolean(s.token);
  let expiryNote = "no expiry";
  if (s.expiresAt) {
    const ms = s.expiresAt - Date.now();
    expiryNote = ms > 0 ? `expires in ${Math.round(ms / 60000)} min` : "EXPIRED";
  }
  const info = {
    endpoint: s.endpoint,
    endpointSource: s.endpointSource,
    authenticated: authed,
    tokenSource: authed ? s.tokenSource : "none",
    tokenPrefix: authed ? tokenPrefix(s.token) : null,
    expiry: authed ? expiryNote : null,
    credentialsPath: s.credentialsPath,
    repoAllowlist: s.allowlist,
  };
  if (json) {
    out(info);
    return 0;
  }
  process.stdout.write(
    [
      `endpoint:    ${info.endpoint}  (${info.endpointSource})`,
      `authed:      ${authed ? "yes" : "no"}`,
      ...(authed
        ? [
            `token:       ${info.tokenPrefix}  (${info.tokenSource})`,
            `expiry:      ${info.expiry}`,
          ]
        : []),
      `credentials: ${info.credentialsPath}`,
      `allowlist:   ${info.repoAllowlist.length ? info.repoAllowlist.join(", ") : "(allow all)"}`,
      "",
    ].join("\n"),
  );
  return 0;
}

// ── reliq context ──────────────────────────────────────────────────────────
// SessionStart hook. Reads {cwd, session_id, ...} on stdin, fetches the user's
// Reliq context, prints the SessionStart hook output JSON. FAILS SAFE: on any
// error (unauthed/unreachable) emit the directive-only output and exit 0.
async function cmdContext() {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    /* ignore — stdin may be absent */
  }
  const hook = parseHookInput(raw);

  let s = resolveSettings();
  if (!s.token) {
    // Brand-new/unauthenticated device. Optionally run the login flow inline if
    // the user opted in (RELIQ_AUTOLOGIN=1); we never auto-open a browser by
    // default since that's intrusive on a passive SessionStart hook.
    if (process.env.RELIQ_AUTOLOGIN === "1") {
      log("RELIQ_AUTOLOGIN=1 set — attempting login before loading context …");
      try {
        await cmdLogin([]);
        s = resolveSettings(); // re-read in case login cached a token
      } catch (e) {
        log(`autologin failed (${e.message}) — continuing unauthenticated`);
      }
    }
    if (!s.token) {
      // Still unauthenticated → emit the login nudge so the user is never
      // silently uncaptured, plus the standing directive. Fail-safe (exit 0).
      out(directiveOnlyOutput({ unauthenticated: true }));
      return 0;
    }
  }
  try {
    const intent = hook.cwd ? `coding session in ${hook.cwd}` : "starting a coding session";
    const result = await mcpToolsCall(
      s.endpoint,
      s.token,
      "get_context",
      { intent, budget: 1500 },
      { timeoutMs: 10000 },
    );
    const pack = unwrapMcpContextPack(result);
    out(sessionStartOutput(renderAdditionalContext(pack)));
  } catch (e) {
    log(`context fetch failed (${e.message}) — emitting directive only`);
    out(directiveOnlyOutput());
  }
  return 0; // never block the session
}

// ── reliq capture ──────────────────────────────────────────────────────────
// SessionEnd/Stop hook. Builds the deterministic git record and POSTs it to
// /ingest/document. --dry-run prints instead of sending. FAILS SAFE: exit 0 on
// any error so capture never breaks the session.
async function cmdCapture(argv) {
  const dryRun = argv.includes("--dry-run");
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    /* ignore */
  }
  const hook = parseHookInput(raw);
  const s = resolveSettings();

  let record;
  try {
    record = buildGitRecord(hook, { allowlist: s.allowlist });
  } catch (e) {
    log(`failed to build git record (${e.message}) — skipping capture`);
    return 0;
  }
  if (record.skipped) {
    log(`nothing to capture: ${record.reason}`);
    return 0;
  }

  const body = ingestDocumentBody(record.filename, record.markdown);

  if (dryRun) {
    process.stdout.write(
      `=== DRY RUN: would POST to ${s.endpoint}/ingest/document ===\n` +
        `filename: ${record.filename}\n\n${record.markdown}\n`,
    );
    return 0;
  }

  if (!s.token) {
    log("not authenticated (run `reliq login`) — capture skipped. Exiting 0.");
    return 0;
  }

  try {
    const res = await httpJson(`${s.endpoint}/ingest/document`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${s.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      timeoutMs: 15000,
    });
    if (res.status >= 200 && res.status < 300) {
      log(`captured session (${record.repoName}, ${record.branch}) [${res.status}]`);
    } else {
      log(`send failed [HTTP ${res.status}] — session NOT captured (continuing): ${res.body.slice(0, 200)}`);
    }
  } catch (e) {
    log(`send failed (${e.message}) — session NOT captured (continuing)`);
  }
  return 0; // never block the session
}

const HELP = `reliq — Reliq memory CLI (plugin engine)

Usage:
  reliq login [--token <reliq_pat_…> | --token -]   Authenticate this device (OAuth loopback; PAT fallback)
  reliq status [--json]                             Show endpoint + auth state (never prints the full token)
  reliq context                                     SessionStart hook: emit Reliq context as additionalContext
  reliq capture [--dry-run]                         SessionEnd/Stop hook: POST a deterministic git record

Config:
  RELIQ_ENDPOINT  override endpoint (default ${DEFAULT_ENDPOINT})
  RELIQ_TOKEN     token fallback (else ~/.reliq/credentials.json)
  RELIQ_REPO_ALLOWLIST  ':'-separated repo paths allowed for capture (empty = all)
`;

export async function run(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case "login":
      return cmdLogin(rest);
    case "status":
      return cmdStatus(rest);
    case "context":
      return cmdContext(rest);
    case "capture":
      return cmdCapture(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      return cmd === undefined ? 1 : 0;
    default:
      log(`unknown command: ${cmd}`);
      process.stdout.write(HELP);
      return 1;
  }
}
