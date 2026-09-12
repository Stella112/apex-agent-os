// APEX HTTP server.
//
// Serves the dashboard and a small read-only API. There is no write endpoint,
// because APEX has nothing to write: no Binance execution tool has a verified
// schema. Every external input is validated against an allow-list rather than
// trusted, and no credential ever reaches the browser.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DecisionStore } from "./src/decision-store.mjs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { runCycle } from "./src/cycle.mjs";
import { verifyJournal } from "./src/journal.mjs";
import { loadConstitution, stamp } from "./src/constitution.mjs";
import { configureResolver, probeReachability } from "./src/resolver.mjs";
import { fetchBinanceUniverse, fetchBstockProducts, fetchMarketContext, fetchMarketContexts, fetchTradableSymbols } from "./src/market.mjs";
import { buildQuantPacket } from "./src/quant.mjs";
import { CLASSIFICATION } from "./src/provenance.mjs";
import { PROPOSALS, deskBook, deskThesis } from "./fixtures/desk.mjs";
import { judge } from "./src/referee.mjs";
import { activePolicy } from "./src/policy.mjs";
import { createBook } from "./src/portfolio.mjs";
import { probeOllama } from "./src/ollama.mjs";
import { discoverOpportunities, OPPORTUNITY_CONSTANTS } from "./src/opportunities.mjs";
import { fetchNewsForSymbols } from "./src/news.mjs";
import {
  createBinanceExecutionAdapter,
  BinanceMcpError,
  createPkcePair,
  createBinanceAuthorizationUrl,
  discoverBinanceOAuth,
  exchangeBinanceCode
} from "./src/binance-mcp.mjs";
import { createBinanceRestClient, BinanceRestError } from "./src/binance-rest.mjs";
import { handleApexMcp } from "./src/apex-mcp.mjs";
import {
  ValidationError,
  validateBook,
  validateCandidate,
  validateThesis
} from "./src/validate.mjs";
import capturedContext from "./fixtures/market-context.captured.json" with { type: "json" };

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 4173);

// Binds to loopback by default so a development run is not exposed by accident.
// Set HOST=0.0.0.0 to serve publicly, which is what a deployment needs.
const host = process.env.HOST || "127.0.0.1";
// The shared dashboard is a decision service; visitors never inherit owner credentials.
const PUBLIC_READ_ONLY = true;
const CORS_ORIGINS = new Set(
  (process.env.APEX_CORS_ORIGINS || "http://127.0.0.1:4177,http://localhost:4177")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

// Allow-listed inputs. Anything else is rejected rather than coerced.
const ALLOWED_MODES = new Set(["live", "replay"]);
const ALLOWED_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT"]);
const ALLOWED_PROPOSALS = new Set(Object.keys(PROPOSALS));

// Cycles awaiting an operator decision, so a confirmation can append to the
// same journal the cycle produced. In-memory and short-lived by design.
const pendingCycles = new Map();
const MAX_PENDING = 20;
const binanceExecution = createBinanceExecutionAdapter();
const binanceRest = createBinanceRestClient();
const oauthStates = new Map();
const records = new DecisionStore(process.env.APEX_DATA_DIR || join(root, "data", "decisions"));
const buildFiles = ["server.mjs", ...["src", "public", "config"].flatMap(dir => readdirSync(join(root, dir)).filter(n => /\.(mjs|js|css|html|yaml)$/.test(n)).map(n => `${dir}/${n}`))].sort();
const buildId = createHash("sha256").update(buildFiles.map(file => file + readFileSync(join(root, file), "utf8")).join("\n")).digest("hex").slice(0, 16);
const startedAt = new Date().toISOString();
let reviewInFlight = false;
async function runPublicReview(args) {
  if (reviewInFlight) throw new Error('Another review is running. Please retry after it completes.');
  reviewInFlight = true;
  try { return await runCycle(args); }
  finally { reviewInFlight = false; }
}

function recheckResize(result, candidate, book) {
  if (!result.resize || result.resize <= 0 || !result.referee_inputs) return null;
  return judge({
    book,
    marks: result.referee_inputs.marks,
    candidate: { ...candidate, qty: result.resize },
    thesis: result.referee_inputs.thesis,
    policy: activePolicy()
  });
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(payload);
}

function sendMcpJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "MCP-Protocol-Version": "2025-06-18",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body === null ? "" : JSON.stringify(body));
}

function sendHtml(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function escapeHtmlText(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

// Strip provenance fields down to what the browser needs. The dashboard shows
// provenance, so these are passed through deliberately and completely.
function serializeField(field) {
  if (!field) return null;
  return {
    value: field.value,
    source: field.source ?? null,
    classification: field.classification,
    timestamp: field.timestamp,
    age_ms: field.age_ms,
    freshness: field.freshness,
    status: field.status,
    formula: field.formula ?? null,
    formula_version: field.formula_version ?? null,
    assumptions: field.assumptions ?? null,
    reason: field.reason ?? null
  };
}

function serializeCycle(result, mode, proposal) {
  const evidence = {};
  for (const [key, field] of Object.entries(result.packet?.evidence ?? {})) {
    evidence[key] = serializeField(field);
  }

  const events = result.journal ? result.journal.all() : [];
  const integrity = verifyJournal(events);
  const recordId = result.cycle_id || randomUUID();
  records.save({ id: recordId, buildId, createdAt: new Date().toISOString(), mode,
    proposal, evidence, bull: serializeAgent(result.bull), bear: serializeAgent(result.bear),
    constitution: result.constitution ?? null, verdict: result.verdict ?? null, guardian: result.guardian ?? null,
    execution_result: result.execution_result ?? null,
    narrative: result.packet?.narrative ?? null, events });

  return {
    execution_mode: mode === "replay" ? "SIMULATION" : "LIVE",
    halted: Boolean(result.halted),
    halt: result.halt ?? null,
    message: result.message ?? null,
    narrative: result.packet?.narrative ?? { coverage: { accepted: 0, social: "UNAVAILABLE" }, relevance: "No live narrative source configured" },
    stage: result.stage ?? null,
    constitution: result.constitution ?? null,
    cycle_id: recordId,
    authorisable: null,
    execution_blocker: result.guardian?.status === "BLOCK"
      ? `APEX Guardian blocked execution: ${result.guardian.reason}`
      : "Account binding and Binance execution schemas are not verified in this build.",
    guardian: result.guardian
      ? {
          name: result.guardian.name,
          status: result.guardian.status,
          safe_to_confirm: result.guardian.safe_to_confirm,
          reason: result.guardian.reason,
          summary: result.guardian.summary,
          checks: result.guardian.checks
        }
      : null,
    execution_result: result.execution_result ?? null,
    agent_runtime: {
      provider: result.bull?.model?.startsWith("ollama:") ? "ollama" : "deterministic",
      bull_model: result.bull?.model ?? null,
      bear_model: result.bear?.model ?? null,
      bull_version: result.bull?.model_version ?? null,
      bear_version: result.bear?.model_version ?? null
    },
    proposal: {
      id: proposal.id,
      label: proposal.label,
      description: proposal.description,
      classification: mode === "replay" ? "SIMULATION" : "USER_PROPOSAL",
      symbol: proposal.symbol,
      side: proposal.side,
      qty: proposal.qty,
      reference_price: proposal.entryPrice
    },
    routes: result.routes
      ? {
          selected: result.routes.selected,
          selected_score: result.routes.selected_score,
          execution_verified: result.routes.execution_verified,
          book_breaches: result.routes.book_breaches ?? [],
          evaluations: result.routes.evaluations.map((e) => ({
            route: e.route,
            side: e.side ?? null,
            score: e.score,
            status: e.status,
            reason: e.reason ?? null,
            components: e.components ?? null
          }))
        }
      : null,
    packet: {
      available: result.packet?.available ?? false,
      worst_freshness: result.packet?.worst_freshness ?? "UNAVAILABLE",
      missing_keys: result.packet?.missing_keys ?? [],
      evidence
    },
    bull: serializeAgent(result.bull),
    bear: serializeAgent(result.bear),
    debate: result.debate ?? null,
    verdict: result.verdict
      ? {
          verdict: result.verdict.verdict,
          checks: result.verdict.checks.map((c) => ({
            rule_id: c.rule,
            result: c.passed ? "PASS" : "FAIL",
            severity: c.severity,
            detail: c.detail,
            numbers: c.numbers
          })),
          simulation: result.verdict.simulation
        }
      : null,
    resize: result.resize ?? null,
    journal: {
      valid: integrity.valid,
      failure: integrity.failure ?? null,
      length: events.length,
      events: events.map((e) => ({
        event_id: e.event_id,
        timestamp: e.timestamp,
        event_type: e.event_type,
        environment: e.environment,
        event_hash: e.event_hash,
        previous_hash: e.previous_hash
      }))
    }
  };
}

function serializeAgent(agent) {
  if (!agent) return null;
  return {
    valid: agent.valid,
    decision: agent.decision ?? null,
    confidence: agent.confidence ?? null,
    claims: (agent.claims ?? []).map((c) => ({
      claim: c.claim,
      evidence_keys: c.evidence_keys
    })),
    rejected: (agent.rejected ?? []).map((r) => ({
      claim: r.claim?.claim ?? null,
      rejection: r.rejection,
      missing_keys: r.missing_keys ?? null
    })),
    failure: agent.failure ?? null,
    reason: Array.isArray(agent.reasons) ? String(agent.reasons[0] ?? "") : null
  };
}

function mcpSymbols(args, max, defaults = ["BTCUSDT", "ETHUSDT"]) {
  const requested = Array.isArray(args?.symbols) && args.symbols.length
    ? args.symbols
    : defaults;
  const symbols = [...new Set(requested.map((symbol) => String(symbol).trim().toUpperCase()))];
  if (!symbols.length || symbols.length > max || symbols.some((symbol) => !/^[A-Z0-9._-]{2,30}$/.test(symbol))) {
    const error = new Error("Provide between 1 and " + max + " valid Binance symbols.");
    error.code = "INVALID_SYMBOLS";
    throw error;
  }
  return symbols;
}

async function mcpFindOpportunities(args) {
  const symbols = Array.isArray(args?.symbols) && args.symbols.length
    ? mcpSymbols(args, 12)
    : await fetchTradableSymbols(12);
  configureResolver();
  const reads = await fetchMarketContexts(symbols);
  const contexts = reads.filter((read) => read.context).map((read) => read.context);
  return {
    fetched_at: new Date().toISOString(),
    source: "binance-public-rest",
    classification: "BINANCE_REPORTED + APEX_ESTIMATE",
    opportunities: discoverOpportunities(contexts),
    unavailable: reads.filter((read) => read.error).map(({ symbol, error }) => ({ symbol, reason: error })),
    constants: OPPORTUNITY_CONSTANTS,
    execution: "READ_ONLY",
    note: "Funding carry is indicative. APEX does not place orders; re-check the portfolio Constitution before any action."
  };
}

async function mcpNewsSentiment(args) {
  const symbols = mcpSymbols(args, 8);
  return {
    ...(await fetchNewsForSymbols(symbols)),
    execution: "READ_ONLY",
    note: "News and sentiment are evidence, not a trade instruction."
  };
}

async function mcpReviewTrade(args) {
  let book;
  let candidate;
  let thesisOverrides;
  try {
    book = createBook(validateBook(args.book));
    if (args.sessionOpeningEquity !== undefined && (!Number.isFinite(args.sessionOpeningEquity) || args.sessionOpeningEquity <= 0)) throw new ValidationError('Session opening equity must be positive and finite');
    book.sessionOpeningEquity = args.sessionOpeningEquity ?? null;
    candidate = validateCandidate(args.proposal);
    thesisOverrides = validateThesis(args.thesis);
  } catch (error) {
    if (error instanceof ValidationError) error.code = "INVALID_INPUT";
    throw error;
  }

  const news = await fetchNewsForSymbols([candidate.symbol]).catch(() => ({
    sources: [],
    sentiment: "MIXED_OR_NEUTRAL",
    coverage: { accepted: 0, social: "UNAVAILABLE" }
  }));
  // APEX remains the decision layer. Even if a caller supplies Binance MCP
  // market evidence, this endpoint never treats it as an authenticated
  // account book and never enables an execution path.
  const result = await runPublicReview({
    symbol: candidate.symbol,
    book,
    candidate,
    thesisOverrides,
    mode: "LIVE",
    execution: {
      accountBound: false,
      writesEnabled: false,
      autopilotEnabled: false,
      pendingOrder: false,
      maxOrderNotional: null,
      allowedSymbols: []
    },
    narrativeItems: news.sources
  });
  const response = serializeCycle(result, "live", {
    id: "mcp",
    label: "MCP proposal",
    description: candidate.side + " " + candidate.qty + " " + candidate.symbol,
    ...candidate,
    ...result.appliedCandidate
  });
  return {
    ...response,
    input_provenance: {
      binance_market_data: args.binance_market_data ? "NOT_USED: review fetches public Binance data" : "NOT_SUPPLIED",
      account_data: "NOT_READ_BY_APEX",
      execution: "NOT_AVAILABLE_TO_THIS_MCP"
    },
    decision_boundary:
      "APEX reviewed the proposal only. The official Binance MCP remains responsible for any user-approved execution."
  };
}

function mcpStatus() {
  return {
    name: "APEX",
    role: "decision_and_risk_layer",
    endpoint: "https://apexagent.site/mcp",
    skill: "apex-binance-council",
    build_id: buildId,
    execution: "BLOCKED",
    writes_enabled: false,
    withdrawal_scope: "ABSENT",
    binance_mcp: binanceExecution.status(),
    binance_rest: PUBLIC_READ_ONLY
      ? { public_read_only: true, configured: false, writes_enabled: false }
      : binanceRest.status(),
    providers: {
      bull: process.env.OLLAMA_ENABLED === "true" ? "configured_not_verified" : "unavailable",
      bear: process.env.BEAR_API_KEY && process.env.BEAR_API_URL && process.env.BEAR_MODEL
        ? "configured_not_verified"
        : "unavailable"
    },
    integration:
      "Use https://apexagent.site/mcp as APEX's canonical MCP endpoint. Use the official Binance MCP for Binance authorization and execution; add both to the same agent."
  };
}

async function handleApi(url, response, request) {
  if (url.pathname.startsWith('/api/binance/') || url.pathname.startsWith('/api/autopilot/')) {
    sendJson(response, 410, { error: 'USE_AGENT_MCP', detail: 'Connect your own Binance account in your MCP client. This shared dashboard provides analysis only.', docs: '/docs#connect' });
    return true;
  }
  if (url.pathname === "/api/identity") {
    sendJson(response, 200, { buildId, startedAt, pid: process.pid, market: "USD-M analysis using mixed spot/futures evidence", execution: "BLOCKED", account: "NOT_VERIFIED", bull: process.env.OLLAMA_ENABLED === "true" ? "CONFIGURED_NOT_VERIFIED" : "UNAVAILABLE", bear: process.env.BEAR_API_KEY && process.env.BEAR_API_URL && process.env.BEAR_MODEL ? "CONFIGURED_NOT_VERIFIED" : "UNAVAILABLE" });
    return true;
  }
  if (["/api/cycle", "/api/journal"].includes(url.pathname)) {
    sendJson(response, 410, { error: "FIXTURE_ENDPOINT_RETIRED", detail: "Use /api/evaluate for live analysis. Recorded scenarios run separately via CLI." });
    return true;
  }
  if (url.pathname === "/api/binance/connect") {
    if (binanceRest.configured && !PUBLIC_READ_ONLY) {
      sendJson(response, 200, {
        connection: "server_api_key",
        message: "Binance is already connected through the server-side API key. OAuth is not required for this private deployment."
      });
      return true;
    }
    const clientId = process.env.BINANCE_OAUTH_CLIENT_ID;
    const redirectUri = process.env.BINANCE_OAUTH_REDIRECT_URI;
    const scopes = process.env.BINANCE_OAUTH_SCOPES || "account trade";
    if (!clientId || !redirectUri) {
      sendJson(response, 503, {
        error: "BINANCE_OAUTH_NOT_CONFIGURED",
        detail: "Set BINANCE_OAUTH_CLIENT_ID and BINANCE_OAUTH_REDIRECT_URI on the server before connecting Binance.",
        required: ["BINANCE_OAUTH_CLIENT_ID", "BINANCE_OAUTH_REDIRECT_URI"]
      });
      return true;
    }
    try {
      const metadata = await discoverBinanceOAuth();
      const { verifier, challenge } = createPkcePair();
      const state = randomUUID();
      oauthStates.set(state, { verifier, clientId, redirectUri, createdAt: Date.now() });
      for (const [key, value] of oauthStates) {
        if (Date.now() - value.createdAt > 10 * 60_000) oauthStates.delete(key);
      }
      const authorizationUrl = createBinanceAuthorizationUrl({
        metadata, clientId, redirectUri, state, challenge, scopes
      });
      sendJson(response, 200, { authorization_url: authorizationUrl, expires_in_seconds: 600 });
    } catch (error) {
      sendJson(response, 503, { error: "BINANCE_OAUTH_UNAVAILABLE", detail: error.message });
    }
    return true;
  }
  if (url.pathname === "/api/binance/callback") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    const pending = state ? oauthStates.get(state) : null;
    if (oauthError) {
      if (state) oauthStates.delete(state);
      sendHtml(response, 400, `<h1>Binance authorization was not completed</h1><p>${escapeHtmlText(oauthError)}</p>`);
      return true;
    }
    if (!pending || Date.now() - pending.createdAt > 10 * 60_000 || !code) {
      if (state) oauthStates.delete(state);
      sendHtml(response, 400, "<h1>Binance authorization expired</h1><p>Start the connection again from APEX.</p>");
      return true;
    }
    oauthStates.delete(state);
    try {
      const metadata = await discoverBinanceOAuth();
      const token = await exchangeBinanceCode({
        metadata,
        code,
        verifier: pending.verifier,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri
      });
      if (!token?.access_token || typeof token.access_token !== "string") {
        throw new Error("Binance did not return an access token");
      }
      binanceExecution.setAccessToken(token.access_token);
      sendHtml(response, 200, "<h1>Binance connected</h1><p>APEX can now discover the authorized MCP tools. You may close this window and return to APEX.</p>");
    } catch (error) {
      sendHtml(response, 502, `<h1>Binance connection failed</h1><p>${escapeHtmlText(error.message)}</p>`);
    }
    return true;
  }
  if (url.pathname === "/api/health") {
    const constitution = loadConstitution();
    configureResolver();
    const [reachability, ollama] = await Promise.all([probeReachability({ attempts: 1, timeoutMs: 6000 }), probeOllama()]);
    sendJson(response, 200, {
      ok: true,
      constitution: stamp(constitution),
      binance: reachability,
      ollama,
      binance_mcp: binanceExecution.status(),
      binance_rest: PUBLIC_READ_ONLY
        ? { public_read_only: true, configured: false, writes_enabled: false, blocker: "Public demo route is read-only" }
        : binanceRest.status(),
      writes_enabled: false,
      withdrawal_scope: "ABSENT"
    });
    return true;
  }

  // Raw market state with full provenance on every field.
  if (url.pathname === "/api/market") {
    const symbol = url.searchParams.get("symbol") ?? "BTCUSDT";
    if (!ALLOWED_SYMBOLS.has(symbol)) {
      sendJson(response, 400, { error: "unsupported symbol", allowed: [...ALLOWED_SYMBOLS] });
      return true;
    }
    configureResolver();
    try {
      const context = await fetchMarketContext(symbol);
      const packet = buildQuantPacket({
        context,
        symbol,
        now: Date.now(),
        classification: CLASSIFICATION.BINANCE_REPORTED
      });
      const evidence = {};
      for (const [key, field] of Object.entries(packet.evidence)) {
        evidence[key] = serializeField(field);
      }
      sendJson(response, 200, {
        symbol,
        execution_mode: "LIVE",
        source: "binance-public-rest",
        fetched_at: context.fetchedAt,
        worst_freshness: packet.worst_freshness,
        evidence
      });
    } catch (error) {
      // Fail closed and say so, rather than serving a stale or zeroed shape.
      sendJson(response, 503, {
        error: "MARKET_UNAVAILABLE",
        detail: error.message,
        note: "no new risk may be opened on absent market data"
      });
    }
    return true;
  }

  if (url.pathname === "/api/binance/status") {
    sendJson(response, 200, binanceExecution.status());
    return true;
  }

  if (url.pathname === "/api/binance/rest/status") {
    sendJson(response, 200, binanceRest.status());
    return true;
  }

  if (url.pathname === "/api/autopilot/status") {
    sendJson(response, 200, PUBLIC_READ_ONLY
      ? { public_read_only: true, configured: false, writes_enabled: false, blocker: "Public demo route is read-only" }
      : binanceRest.status());
    return true;
  }

  if (url.pathname === "/api/binance/tools") {
    try {
      const tools = await binanceExecution.discover();
      sendJson(response, 200, {
        ok: true,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? null,
          input_schema: tool.inputSchema ?? null
        })),
        mappings: binanceExecution.status().mappings
      });
    } catch (error) {
      const status = error instanceof BinanceMcpError && error.code === "NOT_AUTHORIZED" ? 401 : 503;
      sendJson(response, status, { error: error.code ?? "BINANCE_MCP_UNAVAILABLE", detail: error.message });
    }
    return true;
  }

  // Discover opportunities instead of requiring the user to invent a trade
  // first. Only public, live Binance market inputs are used here. Account
  // balances and order placement remain separate capability boundaries.
  if (url.pathname === "/api/universe") {
    try {
      const markets = await fetchBinanceUniverse();
      sendJson(response, 200, {
        fetched_at: new Date().toISOString(),
        count: markets.length,
        markets,
        note: "Trading symbols reported by Binance exchange metadata. Product eligibility still depends on the user's account and jurisdiction."
      });
    } catch (error) {
      sendJson(response, 503, { error: "UNIVERSE_UNAVAILABLE", detail: error.message });
    }
    return true;
  }

  if (url.pathname === "/api/bstocks") {
    try {
      const products = await fetchBstockProducts();
      sendJson(response, 200, {
        fetched_at: new Date().toISOString(),
        count: products.length,
        products,
        source: "binance-public-rwa-feed",
        note: "Verified Binance bStock products. APEX does not score or execute these listings; use Binance Agentic Wallet or Binance MCP for quotes and user-confirmed orders."
      });
    } catch (error) {
      sendJson(response, 503, { error: "BSTOCKS_UNAVAILABLE", detail: error.message, products: [] });
    }
    return true;
  }

  if (url.pathname === "/api/opportunities") {
    const requested = (url.searchParams.get("symbols") ?? "")
      .split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
    let symbols = [...new Set(requested)];
    let universeWarning = null;
    if (!symbols.length) {
      try {
        symbols = await fetchTradableSymbols(24);
      } catch {
        symbols = ["BTCUSDT", "ETHUSDT"];
        universeWarning = 'Universe discovery unavailable; limited fallback scan of BTC and ETH.';
      }
    }
    if (!symbols.length || symbols.length > 24 || symbols.some((symbol) => !/^[A-Z0-9._-]{2,30}$/.test(symbol))) {
      sendJson(response, 400, { error: "invalid symbols", detail: "Provide up to 24 valid Binance symbols." });
      return true;
    }

    configureResolver();
    const reads = await fetchMarketContexts(symbols);
    const contexts = reads.filter((read) => read.context).map((read) => read.context);
    sendJson(response, contexts.length ? 200 : 503, {
      fetched_at: new Date().toISOString(),
      symbols,
      universe_count: null,
      universe_markets: [],
      universe_assets: null,
      universe_warning: universeWarning,
      source: "binance-public-rest",
      classification: "BINANCE_REPORTED + APEX_ESTIMATE",
      opportunities: discoverOpportunities(contexts),
      unavailable: reads
        .filter((read) => read.error)
        .map(({ symbol, error }) => ({ symbol, reason: error })),
      constants: OPPORTUNITY_CONSTANTS,
      note: "Funding carry is an indicative estimate. APEX must re-check the portfolio Constitution before any action."
    });
    return true;
  }

  if (url.pathname === "/api/news") {
    const symbols = (url.searchParams.get("symbols") ?? "BTCUSDT,ETHUSDT")
      .split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length || symbols.length > 8 || symbols.some((symbol) => !/^[A-Z0-9._-]{2,30}$/.test(symbol))) {
      sendJson(response, 400, { error: "invalid symbols", detail: "Provide up to 8 valid Binance symbols." });
      return true;
    }
    try {
      sendJson(response, 200, await fetchNewsForSymbols(symbols));
    } catch (error) {
      sendJson(response, 503, { error: "NEWS_UNAVAILABLE", detail: error.message, sources: [] });
    }
    return true;
  }

  // Account state. Prefer the server-side REST adapter when configured; never
  // accept credentials from the browser or expose the secret in the response.
  if (url.pathname === "/api/account") {
    if (PUBLIC_READ_ONLY) {
      sendJson(response, 200, {
        status: "CAPABILITY_UNAVAILABLE",
        classification: "UNAVAILABLE",
        reason: "This public demo route does not expose private Binance account data.",
        balances: null,
        positions: null,
        liquidation_price: null
      });
      return true;
    }
    if (binanceRest.configured) {
      try {
        const account = await binanceRest.getAccount();
        sendJson(response, 200, {
          status: "CONNECTED",
          classification: "BINANCE_REPORTED",
          accountType: account.accountType ?? null,
          canTrade: account.canTrade ?? null,
          canWithdraw: account.canWithdraw ?? null,
          canDeposit: account.canDeposit ?? null,
          balances: (account.balances ?? []).filter((item) => Number(item.free) > 0 || Number(item.locked) > 0),
          source: "binance-authenticated-rest"
        });
      } catch (error) {
        const status = error instanceof BinanceRestError && error.code === "INVALID_API_KEY" ? 401 : 503;
        sendJson(response, status, { error: error.code ?? "BINANCE_ACCOUNT_UNAVAILABLE", detail: error.message });
      }
      return true;
    }

    sendJson(response, 200, {
      status: "CAPABILITY_UNAVAILABLE",
      classification: "UNAVAILABLE",
      reason:
        "No server-side Binance REST credentials are configured, and no Binance MCP Account-scope tool has a verified schema.",
      balances: null,
      positions: null,
      liquidation_price: null,
      book_in_use: "user-supplied analysis only; no authenticated account book"
    });
    return true;
  }


  return false;
}

export async function handleRequest(request, response) {
  const requestOrigin = request.headers.origin;
  const allowedOrigin = requestOrigin && CORS_ORIGINS.has(requestOrigin) ? requestOrigin : null;
  if (allowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Vary", "Origin");
  }
  if (request.method === "OPTIONS") {
    if (!allowedOrigin) {
      sendJson(response, 403, { error: "CORS_ORIGIN_NOT_ALLOWED" });
      return;
    }
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, MCP-Protocol-Version");
    response.writeHead(204);
    response.end();
    return;
  }
  let pathname;
  try { pathname = new URL(request.url, "http://localhost").pathname; }
  catch { sendJson(response, 400, { error: "MALFORMED_URL" }); return; }
  const isConfirm = request.method === "POST" && pathname === "/api/confirm";
  const isEvaluate = request.method === "POST" && pathname === "/api/evaluate";
  const isAutopilotStop = false;
  const isMcp = request.method === "POST" && pathname === "/mcp";
  if (isConfirm) { sendJson(response, 409, { error: "LIVE_EXECUTION_BLOCKED", detail: "No authenticated account-bound execution preview is available. No confirmation or order was recorded." }); return; }
  let foreignOrigin = false;
  try { foreignOrigin = Boolean(request.headers.origin && new URL(request.headers.origin).host !== request.headers.host); }
  catch { foreignOrigin = true; }
  if ((isEvaluate || isAutopilotStop || isMcp) && (request.headers["sec-fetch-site"] === "cross-site" || foreignOrigin) && !allowedOrigin) {
    sendJson(response, 403, { error: "CROSS_ORIGIN_REQUEST" }); return;
  }
  if (isAutopilotStop) {
    try {
      sendJson(response, 200, {
        ...binanceRest.activateEmergencyStop(),
        detail: "Future APEX autopilot orders are blocked. Review and cancel any existing Binance orders separately."
      });
    } catch (error) {
      sendJson(response, 500, { error: "AUTOPILOT_STOP_FAILED", detail: error.message });
    }
    return;
  }
  if (request.method !== "GET" && !isConfirm && !isEvaluate && !isMcp) {
    sendJson(response, 405, {
      error: "only GET is supported, plus POST /api/evaluate and POST /mcp; APEX has no Binance write endpoints"
    });
    return;
  }

  let url;
  try {
    url = new URL(request.url, `http://127.0.0.1:${port}`);
  } catch {
    sendJson(response, 400, { error: "malformed request" });
    return;
  }

  if (isMcp) {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 131_072) {
        sendMcpJson(response, 413, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "MCP payload too large" }
        });
        return;
      }
    }
    let message;
    try {
      message = JSON.parse(raw || "{}");
    } catch {
      sendMcpJson(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      });
      return;
    }
    const mcpResponse = await handleApexMcp(message, {
      apex_status: async () => mcpStatus(),
      apex_find_opportunities: mcpFindOpportunities,
      apex_news_sentiment: mcpNewsSentiment,
      apex_review_trade: mcpReviewTrade
    });
    if (mcpResponse === null) {
      response.writeHead(202, {
        "Cache-Control": "no-store",
        "MCP-Protocol-Version": "2025-06-18"
      });
      response.end();
      return;
    }
    sendMcpJson(response, 200, mcpResponse);
    return;
  }

  // Evaluate a portfolio and a proposed trade supplied by the user.
  //
  // This is the endpoint that makes APEX usable on someone else's numbers:
  // live market data, their book, their proposal, the same Referee. It reads
  // nothing from any account and needs no credentials.
  if (isEvaluate) {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 16_384) {
        sendJson(response, 413, { error: "payload too large" });
        return;
      }
    }
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      sendJson(response, 400, { error: "malformed JSON" });
      return;
    }

    let book;
    let candidate;
    let thesisOverrides;
    try {
      if (body.mode !== undefined && body.mode !== "live") throw new ValidationError("HTTP dashboard accepts live analysis only; use isolated CLI scenarios for replay");
      if (body.sessionOpeningEquity !== undefined && (!Number.isFinite(body.sessionOpeningEquity) || body.sessionOpeningEquity <= 0)) throw new ValidationError("Session opening equity must be positive and finite");
      const validated = validateBook(body.book);
      book = createBook(validated);
      book.sessionOpeningEquity = body.sessionOpeningEquity ?? validated.walletBalance;
      candidate = validateCandidate(body.proposal);
      thesisOverrides = validateThesis(body.thesis);
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(response, 400, { error: "invalid input", detail: error.message });
        return;
      }
      throw error;
    }

    const symbol = candidate.symbol;
    const mode = body.mode === "replay" ? "replay" : "live";
    const replayContext =
      mode === "replay" ? { ...capturedContext, fetchedAt: new Date().toISOString() } : null;

    try {
      const execution = PUBLIC_READ_ONLY
        ? { accountBound: false, writesEnabled: false, autopilotEnabled: false }
        : await binanceRest.executionContext(symbol);
      const news = await fetchNewsForSymbols([symbol]).catch(() => ({ sources: [], sentiment: "MIXED_OR_NEUTRAL", coverage: { accepted: 0, social: "UNAVAILABLE" } }));
      const result = await runPublicReview({
        symbol,
        book,
        candidate,
        thesisOverrides,
        mode: mode === "replay" ? "SIMULATION" : "LIVE",
        capturedContext: replayContext,
        execution,
        narrativeItems: news.sources
      });

      if (result.guardian?.status === "PASS" && execution.autopilotEnabled && execution.writesEnabled) {
        try {
          const order = await binanceRest.placeCandidate(result.appliedCandidate);
          result.execution_result = {
            status: "SUBMITTED",
            order_id: order.orderId ?? null,
            client_order_id: order.clientOrderId ?? null,
            symbol: result.appliedCandidate.symbol,
            side: result.appliedCandidate.side,
            qty: result.appliedCandidate.qty
          };
          result.journal.append("ORDER_SUBMITTED", result.execution_result);
        } catch (error) {
          result.execution_result = { status: "FAILED", code: error.code ?? "ORDER_FAILED", detail: error.message };
          result.journal.append("ORDER_FAILED", result.execution_result);
        }
      }

      let cycleId = null;
      let authorisable = null;
      if (!result.execution_result && result.verdict?.verdict === "APPROVE" && result.guardian?.status === "PASS") {
        authorisable = { ...result.appliedCandidate, resized: false };
      } else if (!result.execution_result && result.resize && result.resize > 0 && result.guardian?.status === "PASS") {
        const resizedCandidate = { ...result.appliedCandidate, qty: result.resize };
        const recheck = recheckResize(result, resizedCandidate, book);
        if (recheck?.verdict === "APPROVE") {
          authorisable = {
            ...resizedCandidate,
            resized: true,
            original_qty: result.appliedCandidate.qty
          };
          result.resized_verdict = recheck;
        }
      }
      if (authorisable) {
        cycleId = `cyc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        if (pendingCycles.size >= MAX_PENDING) {
          pendingCycles.delete(pendingCycles.keys().next().value);
        }
        pendingCycles.set(cycleId, {
          result,
          proposal: authorisable,
          verdict: result.resized_verdict ?? result.verdict,
          created_at: Date.now()
        });
        result.cycle_id = cycleId;
        result.authorisable = authorisable;
      }

      sendJson(
        response,
        200,
        serializeCycle(result, mode, {
          id: "custom",
          label: "Your proposal",
          description: `${candidate.side} ${candidate.qty} ${candidate.symbol}`,
          ...candidate,
          ...result.appliedCandidate
        })
      );
    } catch (error) {
      sendJson(response, 502, { error: "evaluation failed", detail: error.message });
    }
    return;
  }


  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(url, response, request);
      if (handled) return;
      sendJson(response, 404, { error: "unknown endpoint" });
      return;
    }
    if (url.pathname.startsWith("/apex/api/")) {
      const apiUrl = new URL(url);
      apiUrl.pathname = url.pathname.slice("/apex".length);
      const handled = await handleApi(apiUrl, response, request);
      if (handled) return;
      sendJson(response, 404, { error: "unknown endpoint" });
      return;
    }
  } catch (error) {
    sendJson(response, 500, { error: "internal error", detail: error.message });
    return;
  }

  const requestPath = url.pathname === '/docs' ? '/docs-v2.html'
    : url.pathname === "/" ? "/landing.html"
      : url.pathname === "/dashboard" ? "/apex.html"
        : url.pathname.startsWith("/apex/")
          ? url.pathname.slice("/apex".length)
          : url.pathname;
  const filePath = normalize(join(publicDir, requestPath));

  if (!filePath.startsWith(publicDir + "/") && !filePath.startsWith(publicDir + "\\")) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mime[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

// Vercel imports `handleRequest` as a serverless function. Local/Qevor runs
// still use the same handler through Node's HTTP server.
// PM2 can launch an ESM entrypoint with a normalized argv path that differs
// from import.meta.url. Treat its managed process as a normal server launch;
// Vercel still imports this module without pm_id and remains serverless.
const isManagedRuntime = process.env.PM2_HOME !== undefined || process.env.NODE_APP_INSTANCE !== undefined;
const isServerRuntime = (process.env.NODE_ENV === "production" || isManagedRuntime) && !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME;
if ((process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) || isServerRuntime) {
  const server = createServer(handleRequest);
  server.listen(port, host, () => {
    console.log(`APEX running at http://${host}:${server.address().port}`);
    console.log(`Build ${buildId}. Live execution and payment disabled. Decisions persist in the configured private data directory.`);
  });
}
