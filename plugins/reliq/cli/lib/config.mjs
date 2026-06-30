// config.mjs — endpoint + credential resolution for the reliq CLI.
//
// Resolution order (most specific wins):
//   endpoint: RELIQ_ENDPOINT env > ~/.reliq/config.json "endpoint" >
//             ~/.reliq/credentials.json "endpoint" > DEFAULT_ENDPOINT
//   token:    RELIQ_TOKEN env > ~/.reliq/credentials.json "token"
//
// Credentials are cached centrally (~/.reliq/credentials.json, mode 0600) so a
// device logs in ONCE and every Reliq tool on that device shares the token —
// no per-repo committed .env / PAT. This is the portability fix.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  renameSync,
} from "node:fs";

export const DEFAULT_ENDPOINT = "https://mcp.reliq.sh";

/** Directory holding all reliq CLI state. Override with RELIQ_HOME (tests). */
export function reliqHome() {
  return process.env.RELIQ_HOME || join(homedir(), ".reliq");
}

function credentialsPath() {
  return join(reliqHome(), "credentials.json");
}

function configPath() {
  return join(reliqHome(), "config.json");
}

/** Strip a trailing slash so we can append paths cleanly. */
export function trimEndpoint(url) {
  return String(url || "").replace(/\/+$/, "");
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Read the cached credentials record, or null. */
export function readCredentials() {
  return readJson(credentialsPath());
}

/** Read the optional ~/.reliq/config.json, or null. */
export function readConfig() {
  return readJson(configPath());
}

/**
 * Persist credentials atomically with 0600 perms (owner read/write only — it
 * holds a bearer token). Creates ~/.reliq if needed.
 */
export function writeCredentials(creds) {
  const dir = reliqHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  // rename is atomic on the same fs; re-assert mode in case umask altered tmp.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}

/**
 * Resolve the effective endpoint + token + their sources, given the process
 * env and the on-disk caches. Pure-ish: reads files but no network.
 */
export function resolveSettings(env = process.env) {
  const creds = readCredentials();
  const cfg = readConfig();

  let endpoint = DEFAULT_ENDPOINT;
  let endpointSource = "default";
  if (creds && creds.endpoint) {
    endpoint = creds.endpoint;
    endpointSource = "credentials";
  }
  if (cfg && cfg.endpoint) {
    endpoint = cfg.endpoint;
    endpointSource = "config";
  }
  if (env.RELIQ_ENDPOINT) {
    endpoint = env.RELIQ_ENDPOINT;
    endpointSource = "env";
  }
  endpoint = trimEndpoint(endpoint);

  let token = null;
  let tokenSource = "none";
  let expiresAt = null;
  if (creds && creds.token) {
    token = creds.token;
    tokenSource = "credentials";
    expiresAt = creds.expiresAt ?? null;
  }
  if (env.RELIQ_TOKEN) {
    token = env.RELIQ_TOKEN;
    tokenSource = "env";
    expiresAt = null; // env tokens carry no expiry metadata
  }

  // Repo allowlist: env (':'-separated, matching the bash prototype) or config.
  let allowlist = [];
  if (cfg && Array.isArray(cfg.repoAllowlist)) allowlist = cfg.repoAllowlist.slice();
  if (env.RELIQ_REPO_ALLOWLIST) {
    allowlist = env.RELIQ_REPO_ALLOWLIST.split(":").filter(Boolean);
  }

  return {
    endpoint,
    endpointSource,
    token,
    tokenSource,
    expiresAt,
    allowlist,
    credentialsPath: credentialsPath(),
  };
}

/** Mask a token to a safe prefix for display (never print the whole secret). */
export function tokenPrefix(token) {
  if (!token) return null;
  // Keep the kind prefix (reliq_pat_ / reliq_at_) + a few chars, redact the rest.
  const m = String(token).match(/^(reliq_(?:pat|at)_)(.{0,6})/);
  if (m) return `${m[1]}${m[2]}…`;
  return `${String(token).slice(0, 8)}…`;
}
