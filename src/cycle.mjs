// The decision cycle (spec section 28).
//
//   MARKET -> QUANT -> DEBATE -> REFEREE -> EXECUTION PREVIEW -> HUMAN
//
// The chain stops at the preview. Nothing in APEX submits an order, because no
// Binance write tool has a verified schema. See BINANCE_CAPABILITIES.md.
// Every stage appends to the hash-linked journal as it happens, including
// failures, so a denied or aborted cycle leaves the same quality of record as a
// successful one.

import { CLASSIFICATION } from "./provenance.mjs";
import { configureResolver, probeReachability } from "./resolver.mjs";
import { fetchMarketContext } from "./market.mjs";
import { buildQuantPacket } from "./quant.mjs";
import { callModelWithValidation, validateAgentOutput } from "./evidence.mjs";
import { bearProvider, bullProvider, routeDebate } from "./agents.mjs";
import { getAgentProviders } from "./ollama.mjs";
import { createExternalBear } from "./external-model.mjs";
import { analyzeNarrative, attachNarrative } from "./narrative.mjs";
import { judge, largestCompliantSize } from "./referee.mjs";
import { loadConstitution, stamp } from "./constitution.mjs";
import { policyFromConstitution } from "./policy.mjs";
import { createJournal } from "./journal.mjs";
import { evaluateRoutes } from "./router.mjs";
import { canonicalJson, sha256 } from "./constitution.mjs";
import { runGuardianPreflight } from "./guardian.mjs";

// No Binance MCP write tool has a published schema, so execution is unverified.
// This flag is the single place that fact enters the decision pipeline. Setting
// it true without a verified schema would be exactly the false success the
// project exists to avoid.
export const EXECUTION_VERIFIED = false;

export const HALT = {
  MARKET_UNAVAILABLE: "MARKET_UNAVAILABLE",
  EVIDENCE_STALE: "EVIDENCE_STALE",
  AGENT_INVALID: "AGENT_INVALID",
  REFEREE_DENIED: "REFEREE_DENIED",
  GUARDIAN_BLOCKED: "GUARDIAN_BLOCKED",
  AWAITING_HUMAN: "AWAITING_HUMAN"
};

// Run one cycle. `mode` is LIVE or SIMULATION and is recorded on every event.
export async function runCycle({
  symbol = "BTCUSDT",
  book,
  candidate,
  thesisOverrides = null,
  mode = "LIVE",
  capturedContext = null,
  dnsServers,
  now = Date.now(),
  agentProviders = null,
  narrativeItems = [],
  execution = {}
} = {}) {
  if (!["LIVE", "SIMULATION"].includes(mode)) throw new Error("Unsupported decision environment");
  if (mode === "LIVE" && capturedContext) throw new Error("LIVE cannot accept captured market data");
  const constitution = loadConstitution();
  const executionContext = {
    accountBound: false,
    writesEnabled: false,
    autopilotEnabled: false,
    pendingOrder: false,
    maxOrderNotional: null,
    allowedSymbols: [],
    ...execution
  };
  const policy = policyFromConstitution(constitution);
  const journal = createJournal({ environment: mode });

  journal.append("CONSTITUTION", stamp(constitution));
  if (mode === "LIVE" && !agentProviders && (!getAgentProviders()?.bull || !createExternalBear())) {
    journal.append("ERROR", { stage: "PROVIDERS", halt: "MODEL_UNAVAILABLE" });
    return halted(journal, "MODEL_UNAVAILABLE", "Live analysis requires a configured Ollama Bull and external Bear. No canned analyst was substituted.");
  }

  // --- Market ---------------------------------------------------------------
  let context = capturedContext;
  let reachability = null;

  if (!context) {
    configureResolver(dnsServers);
    reachability = await probeReachability();
    if (!reachability.reachable) {
      journal.append("ERROR", {
        stage: "MARKET_STATE",
        halt: HALT.MARKET_UNAVAILABLE,
        detail: reachability.reason
      });
      return halted(journal, HALT.MARKET_UNAVAILABLE, "Binance is unreachable; no new risk.", {
        reachability
      });
    }
    try {
      context = await fetchMarketContext(symbol);
    } catch (error) {
      journal.append("ERROR", {
        stage: "MARKET_STATE",
        halt: HALT.MARKET_UNAVAILABLE,
        detail: error.message
      });
      return halted(journal, HALT.MARKET_UNAVAILABLE, "Market read failed; no new risk.", {
        reachability
      });
    }
  }

  const classification =
    mode === "SIMULATION" ? CLASSIFICATION.SIMULATION : CLASSIFICATION.BINANCE_REPORTED;

  journal.append("MARKET_STATE", {
    symbol,
    mark: context.markPrice,
    fetched_at: context.fetchedAt,
    classification,
    execution_mode: mode
  });

  // --- Quant ----------------------------------------------------------------
  const marks = { [symbol]: context.markPrice };
  // Never value other holdings at their historical entry during a live review.
  for (const heldSymbol of new Set((book?.positions ?? []).map(p => p.symbol))) {
    if (heldSymbol === symbol) continue;
    if (mode !== 'LIVE') return halted(journal, 'MARKET_UNAVAILABLE', 'Captured evidence does not contain every portfolio mark.');
    try { marks[heldSymbol] = (await fetchMarketContext(heldSymbol)).markPrice; }
    catch { return halted(journal, 'MARKET_UNAVAILABLE', `Live mark unavailable for ${heldSymbol}.`); }
  }
  // The clock is read here, after the market fetch, not at cycle start. Using
  // the earlier timestamp would date every field from before the data existed
  // and make fresh readings look unavailable.
  const observedNow = Math.max(now, Date.now());
  let packet = buildQuantPacket({
    context,
    book,
    marks,
    symbol,
    now: observedNow,
    classification
  });

  journal.append("QUANT_PACKET", {
    symbol,
    evidence_key_count: Object.keys(packet.evidence).length,
    worst_freshness: packet.worst_freshness
  });
  const narrative = analyzeNarrative(narrativeItems, { symbol, now: observedNow });
  packet = attachNarrative(packet, narrative);

  // Fail closed on stale evidence before any agent is asked anything.
  if (["STALE", "EXPIRED", "UNAVAILABLE"].includes(packet.worst_freshness)) {
    journal.append("ERROR", {
      stage: "QUANT_PACKET",
      halt: HALT.EVIDENCE_STALE,
      worst_freshness: packet.worst_freshness
    });
    return halted(
      journal,
      HALT.EVIDENCE_STALE,
      `Evidence is ${packet.worst_freshness}; no new risk.`,
      { packet }
    );
  }

  // --- Debate ---------------------------------------------------------------
  // Both agents are handed the same object and the hash is recorded on each, so
  // "they saw identical evidence" is checkable rather than asserted.
  const hashInput = (p) => sha256(canonicalJson(p.evidence));

  const configuredAgents = agentProviders ?? (mode === "LIVE" ? getAgentProviders() : null);
  let bull;
  let bear;
  if (mode === "LIVE") {
    [bull, bear] = await Promise.all([
      callModelWithValidation({ provider: configuredAgents?.bull, role: "bull", packet, hashInput, timeoutMs: 78_000, attempts: 1 }),
      callModelWithValidation({ provider: agentProviders?.bear ?? createExternalBear(), role: "bear", packet, hashInput, timeoutMs: 30_000, attempts: 1 })
    ]);
  } else if (configuredAgents?.debate) {
    // Ollama on the VPS is intentionally called once: its small local model
    // queues concurrent generations. The response still contains two
    // independently validated agent decisions, each with the same input hash.
    const input_hash = hashInput(packet);
    try {
      const raw = await withTimeout(
        configuredAgents.debate.debate({ packet }),
        configuredAgents.timeoutMs
      );
      bull = validateOllamaDecision({ role: "bull", output: raw?.bull, packet, input_hash, model: configuredAgents.model });
      bear = validateOllamaDecision({ role: "bear", output: raw?.bear, packet, input_hash, model: configuredAgents.model });
    } catch (error) {
      bull = ollamaFailure("bull", input_hash, configuredAgents.model, error);
      bear = ollamaFailure("bear", input_hash, configuredAgents.model, error);
    }
  } else {
    const [deterministicBull, deterministicBear] = await Promise.all([
      callModelWithValidation({
        provider: bullProvider,
        role: "bull",
        packet,
        hashInput
      }),
      callModelWithValidation({
        provider: bearProvider,
        role: "bear",
        packet,
        hashInput
      })
    ]);
    bull = deterministicBull;
    bear = deterministicBear;
  }
  if (!["price.mark", "price.index", "price.bid", "price.ask", "portfolio.equity"].every(key => packet.evidence[key]?.value != null)) {
    journal.append("ERROR", { stage: "QUANT_PACKET", halt: "CRITICAL_INPUT_MISSING" });
    return halted(journal, "CRITICAL_INPUT_MISSING", "Critical prices or portfolio equity unavailable.", { packet });
  }

  journal.append("BULL_DECISION", summarize(bull));
  journal.append("BEAR_DECISION", summarize(bear));

  if (!bull.valid || !bear.valid) {
    journal.append("ERROR", { stage: "DEBATE", halt: HALT.AGENT_INVALID });
    return halted(journal, HALT.AGENT_INVALID, "An agent produced no supportable claim.", {
      packet,
      bull,
      bear
    });
  }

  const debate = routeDebate({ bull, bear, packet });
  journal.append("DEBATE_RESULT", debate);

  // --- Portfolio router -----------------------------------------------------
  // Execution capability is passed in rather than assumed. It is false while no
  // Binance write tool has a verified schema, which means no position-taking
  // route can be selected. That is the honest result, not a limitation to hide.
  const routes = evaluateRoutes({
    packet,
    policy,
    constitution,
    executionVerified: executionContext.writesEnabled === true
  });

  journal.append("ROUTE_EVALUATION", {
    selected: routes.selected,
    selected_score: routes.selected_score,
    execution_verified: routes.execution_verified,
    scored: routes.evaluations
      .filter((e) => e.score !== null)
      .map((e) => ({
        route: e.route,
        side: e.side ?? null,
        score: e.score,
        status: e.status,
        components: e.components
      }))
  });

  for (const rejection of [...routes.rejected, ...routes.not_executable]) {
    journal.append("ROUTE_REJECTION", rejection);
  }

  // --- Referee --------------------------------------------------------------
  if (!candidate) {
    return {
      halted: false,
      stage: "ROUTER",
      packet,
      bull,
      bear,
      debate,
      routes,
      journal,
      constitution: stamp(constitution)
    };
  }

  // A user may propose a size without naming a price. The live mark is the
  // honest default, and it is recorded so the verdict is reproducible.
  const appliedCandidate = {
    ...candidate,
    entryPrice:
      candidate.entryPrice === null || candidate.entryPrice === undefined
        ? context.markPrice
        : candidate.entryPrice
  };

  const thesis = { ...thesisFrom(bull, packet), ...(thesisOverrides ?? {}) };
  const verdict = judge({ book, marks, candidate: appliedCandidate, thesis, policy });

  journal.append("REFEREE_SIMULATION", {
    equity_before: verdict.simulation.equityBefore,
    equity_after: verdict.simulation.equityAfter,
    liquidation_price_after: verdict.simulation.liquidationPriceAfter,
    liquidation_distance_after: verdict.simulation.liquidationDistanceAfter,
    leverage_after: verdict.simulation.leverageAfter,
    net_delta_after: verdict.simulation.netDeltaBtc
  });

  journal.append("REFEREE_DECISION", {
    verdict: verdict.verdict,
    ...stamp(constitution),
    rules: verdict.checks.map((c) => ({
      rule_id: c.rule,
      result: c.passed ? "PASS" : "FAIL",
      detail: c.detail,
      numbers: c.numbers
    }))
  });

  if (verdict.verdict !== "APPROVE") {
    const safeQty = largestCompliantSize({
      book,
      marks,
      candidate: appliedCandidate,
      thesis,
      policy
    });
    journal.append("ROUTE_REJECTION", {
      original_qty: appliedCandidate.qty,
      failed_rules: verdict.checks.filter((c) => !c.passed).map((c) => c.rule),
      compliant_qty: safeQty,
      outcome: safeQty > 0 ? "RESIZE_AVAILABLE" : "STAND_DOWN"
    });
    return {
      halted: true,
      stage: "REFEREE",
      halt: HALT.REFEREE_DENIED,
      verdict,
      resize: safeQty,
      appliedCandidate,
      // Expose the exact inputs used by the first Referee pass so the HTTP
      // layer can recheck a computed resize without silently switching to a
      // fixture price or a different thesis.
      referee_inputs: { marks, thesis },
      packet,
      bull,
      bear,
      debate,
      routes,
      journal,
      constitution: stamp(constitution)
    };
  }

  // --- Guardian preflight --------------------------------------------------
  // Guardian is a deterministic execution firewall. It does not replace the
  // Referee and it cannot grant account authority; it can only add a check or
  // fail closed when the account/write path is not verified.
  const guardian = runGuardianPreflight({
    candidate: appliedCandidate,
    book,
    packet,
    verdict,
    constitution,
    execution: executionContext,
    pendingOrder: executionContext.pendingOrder === true
  });
  journal.append("GUARDIAN_PREFLIGHT", {
    status: guardian.status,
    safe_to_confirm: guardian.safe_to_confirm,
    summary: guardian.summary,
    blocked_checks: guardian.checks.filter((item) => item.status === "BLOCK").map((item) => item.id)
  });

  if (guardian.status !== "PASS") {
    return {
      halted: true,
      stage: "GUARDIAN_PREFLIGHT",
      halt: HALT.GUARDIAN_BLOCKED,
      message: guardian.reason,
      verdict,
      appliedCandidate,
      referee_inputs: { marks, thesis },
      guardian,
      packet,
      bull,
      bear,
      debate,
      routes,
      journal,
      constitution: stamp(constitution)
    };
  }

  // --- Execution preview ----------------------------------------------------
  journal.append("EXECUTION_PREVIEW", {
    symbol,
    side: appliedCandidate.side,
    qty: appliedCandidate.qty,
    reference_price: appliedCandidate.entryPrice,
    execution_mode: mode,
    requires_human_confirmation: constitution.execution.require_human_confirmation,
    guardian: guardian.status,
    note: "Guardian passed; APEX still requires human confirmation before any order."
  });

  return {
    halted: true,
    stage: "EXECUTION_PREVIEW",
    halt: HALT.AWAITING_HUMAN,
    verdict,
    appliedCandidate,
    referee_inputs: { marks, thesis },
    guardian,
    packet,
    bull,
    bear,
    debate,
    routes,
    journal,
    constitution: stamp(constitution)
  };
}

function thesisFrom(bull, packet) {
  const mark = packet.evidence["price.mark"]?.value ?? null;
  const low = packet.evidence["market.range_24h_low"]?.value ?? null;
  return {
    confidence: bull.confidence ?? 0,
    // Invalidation is mandatory. The 24h low is a measured level, not invented.
    invalidation: low,
    flowToxicity: packet.evidence["market.flow_toxicity"]?.value ?? 0,
    mark
  };
}

function summarize(agent) {
  return {
    valid: agent.valid,
    model: agent.model ?? null,
    model_version: agent.model_version ?? null,
    input_hash: agent.input_hash ?? null,
    decided_at: agent.timestamp ?? null,
    decision: agent.decision ?? null,
    confidence: agent.confidence ?? null,
    claims: (agent.claims ?? []).map((c) => ({ claim: c.claim, evidence_keys: c.evidence_keys })),
    rejected_count: (agent.rejected ?? []).length,
    failure: agent.failure ?? null
  };
}

function validateOllamaDecision({ role, output, packet, input_hash, model }) {
  return {
    ...validateAgentOutput({ output, packet }),
    role,
    model: `ollama:${role}`,
    model_version: model,
    input_hash,
    timestamp: new Date().toISOString(),
    attempts_used: 1
  };
}

function ollamaFailure(role, input_hash, model, error) {
  return {
    valid: false,
    failure: "MODEL_UNAVAILABLE",
    reasons: [error?.message ?? "Ollama request failed"],
    role,
    model: `ollama:${role}`,
    model_version: model,
    input_hash,
    timestamp: new Date().toISOString(),
    attempts_used: 1
  };
}

function withTimeout(promise, ms = 10_000) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Ollama request timed out")), ms))
  ]);
}

function halted(journal, halt, message, extra = {}) {
  return { halted: true, halt, message, journal, ...extra };
}


// Record an operator authorisation against a cycle that reached the human gate.
//
// This appends to the same hash-linked journal the cycle produced, so the
// confirmation is part of one continuous chain rather than a separate record.
// It does NOT execute anything: no Binance write tool has a verified schema, so
// the chain ends here by design.
export function confirmExecution({ journal, verdict, candidate, operator = "operator" }) {
  if (!journal) throw new Error("confirmExecution requires the cycle's journal");
  if (!verdict || verdict.verdict !== "APPROVE") {
    throw new Error("only an APPROVED proposal can be authorised");
  }

  const confirmation = journal.append("HUMAN_CONFIRMATION", {
    authorised_by: operator,
    authorised_at: new Date().toISOString(),
    symbol: candidate.symbol,
    side: candidate.side,
    qty: candidate.qty,
    reference_price: candidate.entryPrice
  });

  // The next event in a complete system would be ORDER_SUBMITTED. Recording
  // why it is absent keeps the gap in the audit trail rather than hiding it.
  const halt = journal.append("ERROR", {
    stage: "ORDER_SUBMISSION",
    halt: "LIVE_EXECUTION_UNVERIFIED",
    detail:
      "Authorisation recorded, but no order was submitted. No Binance MCP write tool " +
      "has a published schema, so APEX has no execution code path. See BINANCE_CAPABILITIES.md."
  });

  return { confirmation, halt, head: journal.head() };
}
