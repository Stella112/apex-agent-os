// APEX HTTP server.
//
// Serves the dashboard and a small read-only API. There is no write endpoint,
// because APEX has nothing to write: no Binance execution tool has a verified
// schema. Every external input is validated against an allow-list rather than
// trusted, and no credential ever reaches the browser.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { confirmExecution, runCycle } from "./src/cycle.mjs";
import { verifyJournal } from "./src/journal.mjs";
import { loadConstitution, stamp } from "./src/constitution.mjs";
import { configureResolver, probeReachability } from "./src/resolver.mjs";
import { fetchMarketContext } from "./src/market.mjs";
import { buildQuantPacket } from "./src/quant.mjs";
import { CLASSIFICATION } from "./src/provenance.mjs";
import { PROPOSALS, deskBook, deskThesis } from "./fixtures/desk.mjs";
import { judge } from "./src/referee.mjs";
import { activePolicy } from "./src/policy.mjs";
import { createBook } from "./src/portfolio.mjs";
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

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(payload);
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

  return {
    execution_mode: mode === "replay" ? "SIMULATION" : "LIVE",
    halted: Boolean(result.halted),
    halt: result.halt ?? null,
    message: result.message ?? null,
    stage: result.stage ?? null,
    constitution: result.constitution ?? null,
    cycle_id: result.cycle_id ?? null,
    authorisable: result.authorisable ?? null,
    proposal: {
      id: proposal.id,
      label: proposal.label,
      description: proposal.description,
      classification: "SIMULATION",
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
    failure: agent.failure ?? null
  };
}

async function handleApi(url, response) {
  if (url.pathname === "/api/health") {
    const constitution = loadConstitution();
    configureResolver();
    const reachability = await probeReachability();
    sendJson(response, 200, {
      ok: true,
      constitution: stamp(constitution),
      binance: reachability,
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

  // Account state. No Binance Account-scope tool has a verified schema, so this
  // reports an explicit unavailable capability rather than inventing a shape.
  if (url.pathname === "/api/account") {
    sendJson(response, 200, {
      status: "CAPABILITY_UNAVAILABLE",
      classification: "UNAVAILABLE",
      reason:
        "No Binance MCP Account-scope tool has a verified schema. See BINANCE_CAPABILITIES.md.",
      balances: null,
      positions: null,
      liquidation_price: null,
      book_in_use: "deterministic fixture, classified SIMULATION"
    });
    return true;
  }

  // The journal from a freshly run cycle, with its verification result.
  if (url.pathname === "/api/journal") {
    const mode = url.searchParams.get("mode") ?? "replay";
    if (!ALLOWED_MODES.has(mode)) {
      sendJson(response, 400, { error: "unsupported mode", allowed: [...ALLOWED_MODES] });
      return true;
    }
    const replayContext =
      mode === "replay" ? { ...capturedContext, fetchedAt: new Date().toISOString() } : null;
    try {
      const result = await runCycle({
        book: deskBook(),
        candidate: PROPOSALS.reckless,
        mode: mode === "replay" ? "SIMULATION" : "LIVE",
        capturedContext: replayContext
      });
      const events = result.journal.all();
      sendJson(response, 200, { verification: verifyJournal(events), events });
    } catch (error) {
      sendJson(response, 502, { error: "journal run failed", detail: error.message });
    }
    return true;
  }

  if (url.pathname === "/api/cycle") {
    const mode = url.searchParams.get("mode") ?? "live";
    const symbol = url.searchParams.get("symbol") ?? "BTCUSDT";
    const proposalId = url.searchParams.get("proposal") ?? "modest";

    if (!ALLOWED_MODES.has(mode)) {
      sendJson(response, 400, { error: "unsupported mode", allowed: [...ALLOWED_MODES] });
      return true;
    }
    if (!ALLOWED_SYMBOLS.has(symbol)) {
      sendJson(response, 400, { error: "unsupported symbol", allowed: [...ALLOWED_SYMBOLS] });
      return true;
    }
    if (!ALLOWED_PROPOSALS.has(proposalId)) {
      sendJson(response, 400, { error: "unknown proposal", allowed: [...ALLOWED_PROPOSALS] });
      return true;
    }

    const proposal = PROPOSALS[proposalId];
    const replayContext =
      mode === "replay" ? { ...capturedContext, fetchedAt: new Date().toISOString() } : null;

    try {
      const book = deskBook();
      const result = await runCycle({
        symbol,
        book,
        candidate: proposal,
        mode: mode === "replay" ? "SIMULATION" : "LIVE",
        capturedContext: replayContext
      });

      // Anything the Referee can make compliant is offered to the operator.
      //
      // An APPROVE is authorised as proposed. A RESIZE or DENY that has a
      // computable compliant size is authorised at that size instead, which is
      // the point of a resize: a refusal that still tells you what would work.
      // Only a proposal with no compliant size at all reaches nobody.
      let cycleId = null;
      let authorisable = null;

      if (result.verdict?.verdict === "APPROVE") {
        authorisable = { ...proposal, resized: false };
      } else if (result.resize && result.resize > 0) {
        const resizedCandidate = { ...proposal, qty: result.resize };
        const recheck = judge({
          book: deskBook(),
          marks: { [symbol]: proposal.entryPrice },
          candidate: resizedCandidate,
          thesis: deskThesis,
          policy: activePolicy()
        });
        if (recheck.verdict === "APPROVE") {
          authorisable = {
            ...resizedCandidate,
            resized: true,
            original_qty: proposal.qty,
            recheck_verdict: recheck.verdict
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

      sendJson(response, 200, serializeCycle(result, mode, proposal));
    } catch (error) {
      sendJson(response, 502, { error: "cycle failed", detail: error.message });
    }
    return true;
  }

  return false;
}

const server = createServer(async (request, response) => {
  const isConfirm = request.method === "POST" && request.url.startsWith("/api/confirm");
  const isEvaluate = request.method === "POST" && request.url.startsWith("/api/evaluate");
  if (request.method !== "GET" && !isConfirm && !isEvaluate) {
    sendJson(response, 405, {
      error: "only GET is supported, plus POST /api/confirm; APEX has no Binance write endpoints"
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
      const result = await runCycle({
        symbol,
        book,
        candidate,
        thesisOverrides,
        mode: mode === "replay" ? "SIMULATION" : "LIVE",
        capturedContext: replayContext
      });

      let cycleId = null;
      let authorisable = null;
      if (result.verdict?.verdict === "APPROVE") {
        authorisable = { ...result.appliedCandidate, resized: false };
      } else if (result.resize && result.resize > 0) {
        authorisable = {
          ...result.appliedCandidate,
          qty: result.resize,
          resized: true,
          original_qty: result.appliedCandidate.qty
        };
      }
      if (authorisable) {
        cycleId = `cyc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        if (pendingCycles.size >= MAX_PENDING) {
          pendingCycles.delete(pendingCycles.keys().next().value);
        }
        pendingCycles.set(cycleId, {
          result,
          proposal: authorisable,
          verdict: result.verdict,
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
          ...result.appliedCandidate
        })
      );
    } catch (error) {
      sendJson(response, 502, { error: "evaluation failed", detail: error.message });
    }
    return;
  }

  // Operator authorisation. This writes to the local journal only. It is the
  // one state-changing endpoint, and it still submits nothing to Binance.
  if (isConfirm) {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 4096) {
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
    const pending = pendingCycles.get(body.cycle_id);
    if (!pending) {
      sendJson(response, 404, {
        error: "unknown or expired cycle",
        detail: "only an approved cycle from this session can be authorised"
      });
      return;
    }
    try {
      const outcome = confirmExecution({
        journal: pending.result.journal,
        verdict: pending.verdict,
        candidate: pending.proposal
      });
      const events = pending.result.journal.all();
      pendingCycles.delete(body.cycle_id);
      sendJson(response, 200, {
        authorised: true,
        executed: false,
        execution_status: "LIVE_EXECUTION_UNVERIFIED",
        detail: outcome.halt.payload.detail,
        confirmation: outcome.confirmation,
        journal: {
          valid: verifyJournal(events).valid,
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
      });
    } catch (error) {
      sendJson(response, 409, { error: "cannot authorise", detail: error.message });
    }
    return;
  }

  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(url, response);
      if (handled) return;
      sendJson(response, 404, { error: "unknown endpoint" });
      return;
    }
  } catch (error) {
    sendJson(response, 500, { error: "internal error", detail: error.message });
    return;
  }

  const requestPath = url.pathname === "/" ? "/apex.html" : url.pathname;
  const filePath = normalize(join(publicDir, requestPath));

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mime[extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`APEX running at http://${host}:${port}`);
  console.log("No Binance write endpoints exist. POST /api/confirm writes only to the local journal.");
});
