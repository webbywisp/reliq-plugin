// http.mjs — minimal HTTP helpers + a stateless MCP tools/call client, built on
// node:https/node:http only (no fetch dependency assumptions, keeps deps zero).

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

/** Promise wrapper over node http(s).request. Returns { status, headers, body }. */
export function httpJson(urlStr, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const isHttps = url.protocol === "https:";
    const req = (isHttps ? httpsRequest : httpRequest)(
      url,
      { method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/** Parse a JSON body, tolerant of empty/non-JSON. */
export function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Call one MCP tool over the stateless Streamable HTTP endpoint (POST /mcp).
 * Sends a single JSON-RPC tools/call request. The server may answer as JSON or
 * as a one-shot SSE stream (text/event-stream), so we parse both.
 * Returns the JSON-RPC `result` object, or throws on transport/RPC error.
 */
export async function mcpToolsCall(endpoint, token, name, args, { timeoutMs = 15000 } = {}) {
  const url = `${endpoint.replace(/\/+$/, "")}/mcp`;
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args || {} },
  };
  const res = await httpJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: payload,
    timeoutMs,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`MCP /mcp returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const rpc = extractJsonRpc(res.body);
  if (!rpc) throw new Error("MCP response was not parseable JSON-RPC");
  if (rpc.error) throw new Error(`MCP error: ${rpc.error.message || JSON.stringify(rpc.error)}`);
  return rpc.result;
}

/**
 * Extract the JSON-RPC object from either a plain JSON body or an SSE stream
 * ("event: message\ndata: {...}\n\n"). Returns the parsed object or null.
 */
export function extractJsonRpc(body) {
  const direct = tryParseJson(body);
  if (direct) return direct;
  // SSE: collect the last `data:` line's JSON.
  let found = null;
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (m && m[1]) {
      const parsed = tryParseJson(m[1]);
      if (parsed) found = parsed;
    }
  }
  return found;
}
