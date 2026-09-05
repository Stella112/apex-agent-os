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
import { callModelWithValidation } from "./evidence.mjs";
import { bearProvider, bullProvider, routeDebate } from "./agents.mjs";
import { judge, largestCompliantSize } from "./referee.mjs";
import { loadConstitution, stamp } from "./constitution.mjs";
import { policyFromConstitution } from "./policy.mjs";
import { createJournal } from "./journal.mjs";
import { evaluateRoutes } from "./router.mjs";
import { canonicalJson, sha256 } from "./constitution.mjs";

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
  now = Date.now()
} = {}) {
  const constitution = loadConstitution();
  const policy = policyFromConstitution(constitution);
  const journal = createJournal({ environment: mode });

  journal.append("CONSTITUTION", stamp(constitution));

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
  // The clock is read here, after the market fetch, not at cycle start. Using
  // the earlier timestamp would date every field from before the data existed
  // and make fresh readings look unavailable.
  const observedNow = Math.max(now, Date.now());
  const packet = buildQuantPacket({
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

  const bull = await callModelWithValidation({
    provider: bullProvider,
    role: "bull",
    packet,
    hashInput
  });
  const bear = await callModelWithValidation({
    provider: bearProvider,
    role: "bear",
    packet,
    hashInput
  });

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
    executionVerified: EXECUTION_VERIFIED
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
    note: "APEX does not submit orders. No Binance write tool has a verified schema."
  });

  return {
    halted: true,
    stage: "EXECUTION_PREVIEW",
    halt: HALT.AWAITING_HUMAN,
    verdict,
    appliedCandidate,
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
