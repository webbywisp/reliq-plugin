// oauth.mjs — loopback-redirect OAuth 2.1 + PKCE + DCR client for the reliq CLI.
//
// The Reliq MCP server is a full OAuth 2.1 Authorization Server (services/
// mcp-server/src/oauth/*, ADR 0006): the MCP SDK's mcpAuthRouter mounts RFC 8414
// metadata, /authorize (PKCE), /token (code + refresh), /register (RFC 7591 DCR)
// and /revoke. So a desktop CLI can do the canonical native-app flow WITHOUT any
// pre-shared secret:
//
//   1. Discover endpoints via /.well-known/oauth-authorization-server.
//   2. Dynamically register THIS CLI as a public client (DCR) with a
//      http://127.0.0.1:<port>/callback redirect_uri.
//   3. Spin a localhost listener, open the browser to /authorize?... with a
//      PKCE S256 challenge, capture the ?code= on the loopback redirect.
//   4. Exchange code + code_verifier at /token → access_token (reliq_at_…) +
//      refresh_token + expires_in.
//
// No secret ever leaves the device; the cached token is the only credential.
//
// PKCE building blocks are split out as pure functions so they can be unit
// tested without any network or browser.

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { httpJson, tryParseJson } from "./http.mjs";

const CLI_SCOPES = "memory.read memory.write memory.people";

/** base64url with no padding. */
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/** Generate a PKCE verifier + S256 challenge pair. */
export function makePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Build the /authorize URL from discovered metadata + flow params. (pure) */
export function buildAuthorizeUrl(authorizationEndpoint, params) {
  const u = new URL(authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("code_challenge", params.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (params.scope) u.searchParams.set("scope", params.scope);
  if (params.state) u.searchParams.set("state", params.state);
  if (params.resource) u.searchParams.set("resource", params.resource);
  return u.href;
}

/** Fetch the AS metadata document (RFC 8414). */
export async function discover(endpoint) {
  const base = endpoint.replace(/\/+$/, "");
  const url = `${base}/.well-known/oauth-authorization-server`;
  const res = await httpJson(url, { method: "GET" });
  if (res.status !== 200) {
    throw new Error(`OAuth discovery failed (HTTP ${res.status}) at ${url}`);
  }
  const meta = tryParseJson(res.body);
  if (!meta || !meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error("OAuth metadata missing authorize/token endpoints");
  }
  return meta;
}

/** Dynamic Client Registration (RFC 7591) for this CLI as a public client. */
export async function registerClient(meta, redirectUri) {
  if (!meta.registration_endpoint) {
    throw new Error("server does not advertise a registration_endpoint (DCR)");
  }
  const res = await httpJson(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: {
      client_name: "Reliq CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client (PKCE)
      scope: CLI_SCOPES,
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`DCR failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
  }
  const reg = tryParseJson(res.body);
  if (!reg || !reg.client_id) throw new Error("DCR response missing client_id");
  return reg;
}

/** Exchange an authorization code for tokens at /token. */
export async function exchangeCode(meta, { clientId, code, codeVerifier, redirectUri, resource }) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (resource) form.set("resource", resource);
  const res = await httpJson(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`token exchange failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
  }
  const tok = tryParseJson(res.body);
  if (!tok || !tok.access_token) throw new Error("token response missing access_token");
  return tok;
}

/** Exchange a refresh token for a new access token at /token (RFC 6749 §6). */
export async function refreshAccessToken(tokenEndpoint, { clientId, refreshToken, resource }) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (resource) form.set("resource", resource);
  const res = await httpJson(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`token refresh failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
  }
  const tok = tryParseJson(res.body);
  if (!tok || !tok.access_token) throw new Error("refresh response missing access_token");
  return tok;
}

/**
 * Run the full loopback OAuth flow. Returns a credentials record:
 *   { token, refreshToken, endpoint, expiresAt, scope, tokenEndpoint, resource,
 *     clientId, obtainedVia }
 * `openBrowser` is injectable (defaults to a best-effort OS open).
 */
export async function loopbackLogin(endpoint, { openBrowser, timeoutMs = 180_000 } = {}) {
  const base = endpoint.replace(/\/+$/, "");
  const meta = await discover(base);

  // 1. Bind a loopback listener on an ephemeral port.
  const { server, port } = await listenEphemeral();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    // 2. Register this CLI (DCR) and prepare PKCE + state.
    const reg = await registerClient(meta, redirectUri);
    const pkce = makePkce();
    const state = b64url(randomBytes(16));
    const authorizeUrl = buildAuthorizeUrl(meta.authorization_endpoint, {
      clientId: reg.client_id,
      redirectUri,
      codeChallenge: pkce.challenge,
      scope: CLI_SCOPES,
      state,
      resource: meta.resource || base,
    });

    // 3. Open the browser and wait for the loopback redirect to deliver ?code=.
    const codePromise = waitForCode(server, state, timeoutMs);
    (openBrowser || defaultOpenBrowser)(authorizeUrl);
    const code = await codePromise;

    // 4. Exchange the code for tokens.
    const tok = await exchangeCode(meta, {
      clientId: reg.client_id,
      code,
      codeVerifier: pkce.verifier,
      redirectUri,
      resource: meta.resource || base,
    });

    const expiresAt =
      typeof tok.expires_in === "number" ? Date.now() + tok.expires_in * 1000 : null;
    return {
      token: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      endpoint: base,
      expiresAt,
      scope: tok.scope ?? CLI_SCOPES,
      clientId: reg.client_id,
      tokenEndpoint: meta.token_endpoint,
      resource: meta.resource || base,
      obtainedVia: "oauth-loopback",
    };
  } finally {
    server.close();
  }
}

/** Resolve once the loopback receives a request carrying the matching state+code. */
function waitForCode(server, expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for the browser to complete login"));
    }, timeoutMs);
    server.on("request", (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.statusCode = 404;
        return res.end("not found");
      }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const done = (status, msg) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:2rem">` +
            `<h2>Reliq CLI</h2><p>${msg}</p><p>You can close this tab.</p>`,
        );
      };
      if (err) {
        clearTimeout(timer);
        done(400, `Login failed: ${escapeHtml(err)}`);
        return reject(new Error(`authorization error: ${err}`));
      }
      if (expectedState && state !== expectedState) {
        clearTimeout(timer);
        done(400, "State mismatch — login aborted.");
        return reject(new Error("OAuth state mismatch (possible CSRF)"));
      }
      if (!code) {
        clearTimeout(timer);
        done(400, "No authorization code received.");
        return reject(new Error("no authorization code in callback"));
      }
      clearTimeout(timer);
      done(200, "Signed in to Reliq.");
      resolve(code);
    });
  });
}

function listenEphemeral() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Best-effort cross-platform browser open (no hard dependency). */
function defaultOpenBrowser(url) {
  import("node:child_process")
    .then(({ spawn }) => {
      const platform = process.platform;
      const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
      const args = platform === "win32" ? ["/c", "start", "", url] : [url];
      try {
        spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
      } catch {
        /* ignore — the URL is also printed for manual paste */
      }
    })
    .catch(() => {});
}
