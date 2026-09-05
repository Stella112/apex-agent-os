// Evidence validation, model failure and adversarial anti-hallucination tests
// (spec sections 18, 19, 20, 41).

import test from "node:test";
import assert from "node:assert/strict";

import { CLASSIFICATION } from "../src/provenance.mjs";
import { buildQuantPacket, evidenceKeys } from "../src/quant.mjs";
import { createBook } from "../src/portfolio.mjs";
import {
  MODEL_FAILURE,
  REJECTION,
  assertNoFabricatedExecution,
  assertNoFabricatedPayment,
  callModelWithValidation,
  validateAgentOutput
} from "../src/evidence.mjs";
import { DISAGREEMENT, bearProvider, bullProvider, routeDebate } from "../src/agents.mjs";
import capturedContext from "../fixtures/market-context.captured.json" with { type: "json" };

const NOW = Date.parse(capturedContext.fetchedAt) + 1_000;

function packet(overrides = {}) {
  return buildQuantPacket({
    context: capturedContext,
    book: createBook({
      walletBalance: 10_000,
      positions: [{ symbol: "BTCUSDT", qty: 0.2, entryPrice: 79_000 }]
    }),
    marks: { BTCUSDT: capturedContext.markPrice },
    now: NOW,
    classification: CLASSIFICATION.SIMULATION,
    ...overrides
  });
}

// --- Quant packet -----------------------------------------------------------

test("the quant packet exposes addressable evidence keys", () => {
  const p = packet();
  const keys = evidenceKeys(p);
  assert.ok(keys.includes("funding.current"));
  assert.ok(keys.includes("market.order_book_imbalance"));
  assert.ok(keys.includes("portfolio.liquidation_distance_pct"));
  assert.equal(p.available, true);
});

test("a derived measurement is never labelled as an exchange reading", () => {
  const p = packet({ classification: CLASSIFICATION.BINANCE_REPORTED });
  assert.equal(p.evidence["price.mark"].classification, CLASSIFICATION.BINANCE_REPORTED);
  assert.equal(p.evidence["price.mid"].classification, CLASSIFICATION.APEX_ESTIMATE);
  assert.equal(p.evidence["price.spread_bps"].classification, CLASSIFICATION.APEX_ESTIMATE);
  assert.equal(p.evidence["portfolio.leverage"].classification, CLASSIFICATION.APEX_ESTIMATE);
});

test("every derived measurement carries its formula", () => {
  const p = packet();
  assert.match(p.evidence["price.spread_bps"].formula, /10000/);
  assert.match(p.evidence["portfolio.leverage"].formula, /gross_notional \/ equity/);
});

test("an absent market read produces an empty packet, not a packet of zeroes", () => {
  const p = buildQuantPacket({ context: null, now: NOW });
  assert.equal(p.available, false);
  assert.deepEqual(p.evidence, {});
  assert.equal(p.worst_freshness, "UNAVAILABLE");
});

// --- Adversarial: unsupported evidence (spec 41) -----------------------------

test("ADVERSARIAL: a claim citing a nonexistent key is rejected", () => {
  const result = validateAgentOutput({
    packet: packet(),
    output: {
      decision: "ADD",
      confidence: 0.8,
      claims: [
        { claim: "Funding is strongly positive", evidence_keys: ["funding.predicted_next_week"] }
      ]
    }
  });

  assert.equal(result.valid, false);
  assert.equal(result.failure, REJECTION.UNSUPPORTED_CLAIM);
  assert.deepEqual(result.rejected[0].missing_keys, ["funding.predicted_next_week"]);
});

test("ADVERSARIAL: an invented indicator is rejected", () => {
  const result = validateAgentOutput({
    packet: packet(),
    output: {
      decision: "ADD",
      confidence: 0.9,
      claims: [{ claim: "EMA200 confirms the trend", evidence_keys: ["market.ema_200"] }]
    }
  });

  assert.equal(result.valid, false);
  assert.equal(result.rejected[0].rejection, REJECTION.UNSUPPORTED_CLAIM);
  assert.ok(result.reasons.some((r) => /market\.ema_200/.test(r)));
});

test("ADVERSARIAL: a fabricated fill is rejected without a FILL event", () => {
  const noEvents = assertNoFabricatedExecution({
    text: "Binance filled the order at 79,700.",
    executionEvents: []
  });
  assert.equal(noEvents.valid, false);
  assert.equal(noEvents.rejection, REJECTION.FALSE_EXECUTION_STATE);

  const withEvent = assertNoFabricatedExecution({
    text: "Binance filled the order at 79,700.",
    executionEvents: [{ event_type: "FILL" }]
  });
  assert.equal(withEvent.valid, true);
});

test("ADVERSARIAL: a fabricated payment is rejected without verified settlement", () => {
  const unverified = assertNoFabricatedPayment({
    text: "Payment successful, artifact released.",
    settlementEvents: [{ verified: false }]
  });
  assert.equal(unverified.valid, false);
  assert.equal(unverified.rejection, REJECTION.PAYMENT_UNVERIFIED);

  const verified = assertNoFabricatedPayment({
    text: "Payment successful.",
    settlementEvents: [{ verified: true }]
  });
  assert.equal(verified.valid, true);
});

test("a claim citing a key that exists but holds no value is rejected", () => {
  const p = packet({
    book: createBook({ walletBalance: 10_000, positions: [] })
  });
  assert.equal(p.evidence["portfolio.liquidation_distance_pct"].value, null);

  const result = validateAgentOutput({
    packet: p,
    output: {
      decision: "ADD",
      confidence: 0.7,
      claims: [
        {
          claim: "Liquidation is comfortably far away",
          evidence_keys: ["portfolio.liquidation_distance_pct"]
        }
      ]
    }
  });
  assert.equal(result.valid, false);
  assert.equal(result.rejected[0].rejection, REJECTION.UNAVAILABLE_EVIDENCE);
});

test("supported claims survive while unsupported ones are stripped", () => {
  const result = validateAgentOutput({
    packet: packet(),
    output: {
      decision: "ADD",
      confidence: 0.75,
      claims: [
        { claim: "Funding is cheap", evidence_keys: ["funding.current"] },
        { claim: "The oracle says buy", evidence_keys: ["oracle.signal"] }
      ]
    }
  });

  assert.equal(result.valid, true);
  assert.equal(result.claims.length, 1);
  assert.equal(result.rejected.length, 1);
});

// --- Malformed output -------------------------------------------------------

test("malformed agent output is refused rather than repaired", () => {
  const p = packet();
  const cases = [
    null,
    { decision: "MOON", confidence: 0.5, claims: [] },
    { decision: "ADD", confidence: 5, claims: [] },
    { decision: "ADD", confidence: 0.5, claims: [] },
    { decision: "ADD", confidence: 0.5, claims: "not an array" }
  ];
  for (const output of cases) {
    const result = validateAgentOutput({ output, packet: p });
    assert.equal(result.valid, false, `expected refusal for ${JSON.stringify(output)}`);
  }
});

// --- Model failure (spec 19) ------------------------------------------------

test("an invalid model output is retried once, then fails closed", async () => {
  let calls = 0;
  const provider = {
    async propose() {
      calls += 1;
      return { decision: "ADD", confidence: 0.8, claims: [{ claim: "x", evidence_keys: ["nope"] }] };
    }
  };
  const result = await callModelWithValidation({ provider, role: "bull", packet: packet() });
  assert.equal(result.valid, false);
  assert.equal(calls, 2, "exactly one retry");
});

test("a model that recovers on the retry is accepted", async () => {
  let calls = 0;
  const provider = {
    async propose() {
      calls += 1;
      if (calls === 1) return { decision: "ADD", confidence: 0.8, claims: [] };
      return {
        decision: "ADD",
        confidence: 0.8,
        claims: [{ claim: "Funding is cheap", evidence_keys: ["funding.current"] }]
      };
    }
  };
  const result = await callModelWithValidation({ provider, role: "bull", packet: packet() });
  assert.equal(result.valid, true);
  assert.equal(result.attempts_used, 2);
});

test("a model timeout reports MODEL_TIMEOUT and does not substitute a provider", async () => {
  const provider = { propose: () => new Promise(() => {}) };
  const result = await callModelWithValidation({
    provider,
    role: "bull",
    packet: packet(),
    timeoutMs: 30
  });
  assert.equal(result.valid, false);
  assert.equal(result.failure, MODEL_FAILURE.MODEL_TIMEOUT);
});

test("a missing provider reports MODEL_UNAVAILABLE", async () => {
  const result = await callModelWithValidation({ provider: null, role: "bull", packet: packet() });
  assert.equal(result.failure, MODEL_FAILURE.MODEL_UNAVAILABLE);
});

// --- Agents and debate ------------------------------------------------------

test("Bull and Bear argue only from keys the packet contains", async () => {
  const p = packet();
  const bull = await callModelWithValidation({ provider: bullProvider, role: "bull", packet: p });
  const bear = await callModelWithValidation({ provider: bearProvider, role: "bear", packet: p });

  assert.equal(bull.valid, true);
  assert.equal(bear.valid, true);

  const keys = new Set(evidenceKeys(p));
  for (const agent of [bull, bear]) {
    for (const claim of agent.claims) {
      for (const key of claim.evidence_keys) {
        assert.ok(keys.has(key), `${key} must exist in the packet`);
      }
    }
  }
});

test("both agents receive the identical packet", async () => {
  const p = packet();
  const before = JSON.stringify(p);
  await bullProvider.propose({ packet: p });
  await bearProvider.propose({ packet: p });
  assert.equal(JSON.stringify(p), before, "agents must not mutate shared evidence");
});

test("stale evidence outranks any directional disagreement", () => {
  const route = routeDebate({
    bull: { valid: true, decision: "ADD", confidence: 0.8, claims: [] },
    bear: { valid: true, decision: "STAND_DOWN", confidence: 0.8, claims: [] },
    packet: { worst_freshness: "STALE" }
  });
  assert.equal(route.classification, DISAGREEMENT.DATA_UNCERTAINTY);
  assert.equal(route.material, true);
});

test("opposing directions classify as DIRECTIONAL", () => {
  const route = routeDebate({
    bull: { valid: true, decision: "ADD", confidence: 0.8, claims: [] },
    bear: { valid: true, decision: "EXIT", confidence: 0.7, claims: [] },
    packet: { worst_freshness: "FRESH" }
  });
  assert.equal(route.classification, DISAGREEMENT.DIRECTIONAL);
});

test("agreement on direction with a portfolio risk flag classifies as RISK", () => {
  const route = routeDebate({
    bull: { valid: true, decision: "ADD", confidence: 0.8, claims: [] },
    bear: {
      valid: true,
      decision: "HOLD",
      confidence: 0.7,
      claims: [{ claim: "leverage is high", evidence_keys: ["portfolio.leverage"] }]
    },
    packet: { worst_freshness: "FRESH" }
  });
  assert.equal(route.classification, DISAGREEMENT.RISK);
  assert.equal(route.material, true);
});

test("an agent with no supportable claim forces DATA_UNCERTAINTY", () => {
  const route = routeDebate({
    bull: { valid: false },
    bear: { valid: true, decision: "HOLD", confidence: 0.6, claims: [] },
    packet: { worst_freshness: "FRESH" }
  });
  assert.equal(route.classification, DISAGREEMENT.DATA_UNCERTAINTY);
});
