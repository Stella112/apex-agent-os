// Binance Agentic MCP transport and execution adapter.
//
// Binance publishes the MCP endpoint, but intentionally does not publish a
// fixed tool-name contract in the public docs. APEX therefore discovers the
// live tool list after OAuth and refuses to guess a tool or argument shape.

import { createHash, randomBytes } from "node:crypto";

export const BINANCE_MCP_URL = process.env.BINANCE_MCP_URL || "https://agent.binance.com/mcp/agentic";
export const BINANCE_MCP_RESOURCE = BINANCE_MCP_URL;

const PROTOCOL_VERSION = "2025-06-18";

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createPkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export async function discoverBinanceOAuth(fetchImpl = fetch) {
  const response = await fetchImpl("https://agent.binance.com/.well-known/oauth-authorization-server", {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Binance OAuth metadata returned HTTP ${response.status}`);
  return response.json();
}

export function createBinanceAuthorizationUrl({ metadata, clientId, redirectUri, state, challenge, scopes }) {
  if (!clientId || !redirectUri || !state || !challenge) {
    throw new Error("Binance OAuth requires client id, redirect URI, state, and PKCE challenge");
  }
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", BINANCE_MCP_RESOURCE);
  if (scopes) url.searchParams.set("scope", scopes);
  return url.toString();
}

export async function exchangeBinanceCode({ metadata, code, verifier, clientId, redirectUri, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: BINANCE_MCP_RESOURCE
  });
  const response = await fetchImpl(metadata.token_endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Binance OAuth token exchange returned HTTP ${response.status}`);
  return payload;
}

function parseMcpResponse(text, contentType) {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text || "{}");
  const messages = [];
  let data = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    if (!line && data.length) {
      try { messages.push(JSON.parse(data.join("\n"))); } catch { /* ignore keep-alive/non-JSON frames */ }
      data = [];
    }
  }
  if (data.length) {
    try { messages.push(JSON.parse(data.join("\n"))); } catch { /* ignore */ }
  }
  return messages.at(-1) ?? {};
}

export class BinanceMcpError extends Error {
  constructor(message, code = "BINANCE_MCP_ERROR", details = null) {
    super(message);
    this.name = "BinanceMcpError";
    this.code = code;
    this.details = details;
  }
}

export class BinanceMcpClient {
  constructor({ accessToken, endpoint = BINANCE_MCP_URL, fetchImpl = fetch }) {
    this.accessToken = accessToken;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.requestId = 0;
    this.initialized = false;
  }

  async request(method, params = {}) {
    if (!this.accessToken) throw new BinanceMcpError("No Binance MCP access token is configured", "NOT_AUTHORIZED");
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      "MCP-Protocol-Version": PROTOCOL_VERSION
    };
    if (this.sessionId) headers["MCP-Session-Id"] = this.sessionId;
    const id = ++this.requestId;
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const text = await response.text();
    if (response.status === 401) throw new BinanceMcpError("Binance MCP authorization is missing or expired", "NOT_AUTHORIZED");
    if (response.status === 403) throw new BinanceMcpError("Binance MCP scope is insufficient", "INSUFFICIENT_SCOPE");
    if (!response.ok) throw new BinanceMcpError(`Binance MCP returned HTTP ${response.status}`, "HTTP_ERROR", text.slice(0, 500));
    if (text.length > 2_000_000) throw new BinanceMcpError("MCP payload too large");
    const envelope = parseMcpResponse(text, response.headers.get("content-type") || "application/json");
    if (envelope.id !== id || envelope.jsonrpc !== "2.0") throw new BinanceMcpError("MCP response identity mismatch");
    if (envelope.error) throw new BinanceMcpError(envelope.error.message || "Binance MCP request failed", "MCP_RPC_ERROR", envelope.error);
    return envelope.result ?? envelope;
  }

  async initialize() {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "apex-agent", version: "0.3.0" }
    });
    const headers = { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL_VERSION };
    if (this.sessionId) headers["MCP-Session-Id"] = this.sessionId;
    const notified = await this.fetchImpl(this.endpoint, { method: "POST", headers, signal: AbortSignal.timeout(15_000), redirect: "error", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    if (!notified.ok) throw new BinanceMcpError("MCP initialized notification failed");
    this.initialized = true;
  }

  async listTools() {
    await this.initialize();
    const tools = []; let cursor; const seen = new Set();
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result.tools) || result.tools.some(t => typeof t.name !== "string" || !t.inputSchema)) throw new BinanceMcpError("Invalid tool discovery response");
      tools.push(...result.tools); cursor = result.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new BinanceMcpError("Tool discovery pagination invalid");
      seen.add(cursor);
    } while (cursor);
    return tools;
  }

  async callTool(name, arguments_) {
    await this.initialize();
    const result = await this.request("tools/call", { name, arguments: arguments_ });
    if (result.isError) throw new BinanceMcpError("MCP tool reported failure", "TOOL_ERROR");
    return result;
  }
}

const ENV_TOOL_KEYS = {
  balances: "BINANCE_MCP_TOOL_BALANCES",
  positions: "BINANCE_MCP_TOOL_POSITIONS",
  placeOrder: "BINANCE_MCP_TOOL_PLACE_ORDER",
  orderStatus: "BINANCE_MCP_TOOL_ORDER_STATUS",
  cancelOrder: "BINANCE_MCP_TOOL_CANCEL_ORDER"
};

function configuredTools() {
  return Object.fromEntries(
    Object.entries(ENV_TOOL_KEYS)
      .map(([role, envKey]) => [role, process.env[envKey] || null])
  );
}

function toolByName(tools, name) {
  return tools.find((tool) => tool.name === name) ?? null;
}

function schemaProperties(tool) {
  return tool?.inputSchema?.properties ?? {};
}

function orderArguments(tool, candidate) {
  const properties = schemaProperties(tool);
  const keys = Object.keys(properties);
  const find = (names) => names.find((name) => keys.includes(name));
  const symbol = find(["symbol", "pair", "instrument"]);
  const side = find(["side", "direction"]);
  const quantity = find(["quantity", "qty", "amount", "size"]);
  const type = find(["type", "orderType", "order_type"]);
  if (!symbol || !side || !quantity) {
    throw new BinanceMcpError("Configured Binance order tool does not expose a supported schema", "ORDER_SCHEMA_UNSUPPORTED", { keys });
  }
  const args = {
    [symbol]: candidate.symbol,
    [side]: candidate.side === "LONG" ? "BUY" : "SELL",
    [quantity]: String(candidate.qty)
  };
  if (type) args[type] = "MARKET";
  return args;
}

export class BinanceExecutionAdapter {
  constructor({ accessToken = process.env.BINANCE_MCP_ACCESS_TOKEN, endpoint = BINANCE_MCP_URL } = {}) {
    this.accessToken = accessToken;
    this.endpoint = endpoint;
    this.client = accessToken ? new BinanceMcpClient({ accessToken, endpoint }) : null;
    this.tools = [];
    this.toolMap = configuredTools();
  }

  setAccessToken(accessToken) {
    this.accessToken = accessToken;
    this.client = accessToken ? new BinanceMcpClient({ accessToken, endpoint: this.endpoint }) : null;
    this.tools = [];
  }

  get configured() {
    return Boolean(this.accessToken);
  }

  get ready() {
    return this.configured && this.tools.length > 0;
  }

  async discover() {
    if (!this.client) throw new BinanceMcpError("Binance MCP is not authorized", "NOT_AUTHORIZED");
    this.tools = await this.client.listTools();
    return this.tools;
  }

  status() {
    return {
      configured: this.configured,
      discovered: this.tools.length > 0,
      endpoint: this.endpoint,
      tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description ?? null })),
      mappings: this.toolMap,
      writes_enabled: false,
      blocker: "Account, order schema and confirmation binding unverified"
    };
  }

  async call(role, args = {}) {
    if (!["balances", "positions", "orderStatus"].includes(role)) throw new BinanceMcpError("Mutating roles require verified execution coordination", "WRITES_DISABLED");
    if (!this.client) throw new BinanceMcpError("Binance MCP is not authorized", "NOT_AUTHORIZED");
    if (!this.tools.length) await this.discover();
    const name = this.toolMap[role];
    if (!name) throw new BinanceMcpError(`No tool mapping configured for ${role}`, "TOOL_MAPPING_MISSING");
    const tool = toolByName(this.tools, name);
    if (!tool) throw new BinanceMcpError(`Mapped Binance tool ${name} was not returned by tools/list`, "TOOL_NOT_FOUND");
    return this.client.callTool(name, args);
  }

  async getBalances() { return this.call("balances"); }
  async getPositions() { return this.call("positions"); }

  async placeOrder(candidate) {
    throw new BinanceMcpError("Binance account and order schema not yet reviewed; live execution remains blocked", "WRITES_DISABLED");
    if (process.env.BINANCE_LIVE_EXECUTION !== "true") {
      throw new BinanceMcpError("Live execution is disabled; set BINANCE_LIVE_EXECUTION=true only after schema review", "WRITES_DISABLED");
    }
    if (!this.tools.length) await this.discover();
    const name = this.toolMap.placeOrder;
    const tool = toolByName(this.tools, name);
    if (!tool) throw new BinanceMcpError(`Mapped Binance order tool ${name || "(unset)"} was not returned by tools/list`, "TOOL_NOT_FOUND");
    return this.client.callTool(name, orderArguments(tool, candidate));
  }

  async getOrderStatus(args) { return this.call("orderStatus", args); }
  async cancelOrder(args) { return this.call("cancelOrder", args); }
}

export function createBinanceExecutionAdapter() {
  return new BinanceExecutionAdapter();
}
