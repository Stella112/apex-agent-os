// Liquidation acceptance suite (spec section 11).
// Tests A through F must pass before execution work proceeds.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLASSIFICATION,
  FRESHNESS,
  STATUS,
  observed,
  unavailable
} from "../src/provenance.mjs";
import { createBook } from "../src/portfolio.mjs";
import {
  FORMULA_VERSION,
  liquidationDistancePct,
  liquidationUsableForNewRisk,
  meetsDistanceFloor,
  resolveLiquidation
} from "../src/liquidation.mjs";

const NOW = Date.parse("2026-09-05T14:00:00.000Z");

// A book that is genuinely liquidatable: 10,000 equity holding 1 BTC.
function leveredBook() {
  return createBook({
    walletBalance: 10_000,
    positions: [{ symbol: "BTCUSDT", qty: 1, entryPrice: 80_000 }]
  });
}

const marks = { BTCUSDT: 80_000 };

function markField(ageMs = 0) {
  return observed({
    value: 80_000,
    source: "binance",
    classification: CLASSIFICATION.BINANCE_REPORTED,
    observedAt: NOW - ageMs,
    now: NOW
  });
}

// --- Test A -----------------------------------------------------------------
test("A: a Binance-reported liquidation price is passed through as BINANCE_REPORTED", () => {
  const reported = observed({
    value: 91_420.25,
    source: "verified-binance-account-response",
    classification: CLASSIFICATION.BINANCE_REPORTED,
    observedAt: NOW - 214,
    now: NOW
  });

  const result = resolveLiquidation({
    reported,
    book: leveredBook(),
    marks,
    symbol: "BTCUSDT",
    now: NOW
  });

  assert.equal(result.classification, CLASSIFICATION.BINANCE_REPORTED);
  assert.equal(result.value, 91_420.25);
  assert.equal(result.age_ms, 214);
  assert.equal(result.freshness, FRESHNESS.FRESH);

  // A reported value must not acquire APEX formula metadata.
  assert.equal(result.formula_version, undefined);
});

// --- Test B -----------------------------------------------------------------
test("B: an APEX-derived value is labelled APEX_ESTIMATE and discloses assumptions", () => {
  const result = resolveLiquidation({
    book: leveredBook(),
    marks,
    symbol: "BTCUSDT",
    now: NOW
  });

  assert.equal(result.classification, CLASSIFICATION.APEX_ESTIMATE);
  assert.equal(result.status, STATUS.AVAILABLE);
  assert.equal(result.formula_version, FORMULA_VERSION);
  assert.ok(Array.isArray(result.assumptions) && result.assumptions.length >= 6);
  assert.ok(result.assumptions.some((a) => a.startsWith("A2")), "must disclose the bracket assumption");

  // The estimate must never claim Binance as its source.
  assert.notEqual(result.source, "binance");
  assert.equal(result.source, "apex");
});

// --- Test C -----------------------------------------------------------------
test("C: missing liquidation data yields UNAVAILABLE, never zero", () => {
  // A flat book has no liquidation exposure at all.
  const flat = createBook({ walletBalance: 10_000, positions: [] });
  const result = resolveLiquidation({ book: flat, marks, symbol: "BTCUSDT", now: NOW });

  assert.equal(result.status, STATUS.UNAVAILABLE);
  assert.equal(result.classification, CLASSIFICATION.UNAVAILABLE);
  assert.equal(result.value, null);
  assert.notEqual(result.value, 0, "absence must never be rendered as zero");

  const distance = liquidationDistancePct({
    liquidation: result,
    markPrice: markField(),
    side: "LONG",
    now: NOW
  });
  assert.equal(distance.status, STATUS.UNAVAILABLE);
  assert.equal(distance.value, null);
});

// --- Test D -----------------------------------------------------------------
test("D: stale liquidation data is marked STALE and fails closed for new risk", () => {
  const stale = observed({
    value: 70_301.5,
    source: "verified-binance-account-response",
    classification: CLASSIFICATION.BINANCE_REPORTED,
    observedAt: NOW - 30_000, // past the 10s aging threshold
    now: NOW
  });

  assert.equal(stale.freshness, FRESHNESS.STALE);
  assert.equal(liquidationUsableForNewRisk(stale), false, "stale data must not open new risk");

  const expired = observed({
    value: 70_301.5,
    source: "verified-binance-account-response",
    classification: CLASSIFICATION.BINANCE_REPORTED,
    observedAt: NOW - 120_000,
    now: NOW
  });
  assert.equal(expired.freshness, FRESHNESS.EXPIRED);
  assert.equal(liquidationUsableForNewRisk(expired), false);

  // Fresh and aging data may open risk; nothing beyond that may.
  assert.equal(liquidationUsableForNewRisk(markField(0)), true);
  assert.equal(liquidationUsableForNewRisk(markField(5_000)), true);
});

test("D2: a distance computed from a stale input inherits the staleness", () => {
  const liquidation = resolveLiquidation({
    book: leveredBook(),
    marks,
    symbol: "BTCUSDT",
    now: NOW
  });

  const distance = liquidationDistancePct({
    liquidation,
    markPrice: markField(45_000), // stale mark
    side: "LONG",
    now: NOW
  });

  assert.equal(distance.freshness, FRESHNESS.STALE);
  assert.equal(liquidationUsableForNewRisk(distance), false);
});

// --- Test E -----------------------------------------------------------------
test("E: mismatched product metadata yields INVALID_LIQUIDATION_CONTEXT", () => {
  const coinM = resolveLiquidation({
    book: leveredBook(),
    marks,
    symbol: "BTCUSDT",
    product: "COINM_FUTURES",
    now: NOW
  });
  assert.equal(coinM.status, STATUS.INVALID_CONTEXT);
  assert.match(coinM.reason, /COINM_FUTURES/);

  const isolated = resolveLiquidation({
    book: leveredBook(),
    marks,
    symbol: "BTCUSDT",
    marginMode: "ISOLATED",
    now: NOW
  });
  assert.equal(isolated.status, STATUS.INVALID_CONTEXT);
  assert.match(isolated.reason, /ISOLATED/);

  // An invalid context must propagate, not degrade into a plain unavailable.
  const distance = liquidationDistancePct({
    liquidation: coinM,
    markPrice: markField(),
    side: "LONG",
    now: NOW
  });
  assert.equal(distance.status, STATUS.INVALID_CONTEXT);
});

test("E2: an unknown side is an invalid context, not a silent long", () => {
  const liquidation = resolveLiquidation({
    book: leveredBook(),
    marks,
    symbol: "BTCUSDT",
    now: NOW
  });
  const distance = liquidationDistancePct({
    liquidation,
    markPrice: markField(),
    side: "SIDEWAYS",
    now: NOW
  });
  assert.equal(distance.status, STATUS.INVALID_CONTEXT);
});

// --- Test F -----------------------------------------------------------------
test("F: the 15% boundary compares deterministically", () => {
  const at = observed({
    value: 15.0,
    source: "apex",
    classification: CLASSIFICATION.APEX_ESTIMATE,
    observedAt: NOW,
    now: NOW
  });
  const below = { ...at, value: 14.999999 };
  const above = { ...at, value: 15.000001 };

  assert.equal(meetsDistanceFloor(at, 15).passed, true, "exactly at the floor passes");
  assert.equal(meetsDistanceFloor(below, 15).passed, false);
  assert.equal(meetsDistanceFloor(above, 15).passed, true);

  // Values that differ only beyond the stated tolerance are treated as equal,
  // so the comparison cannot flip on floating-point noise.
  const noisy = { ...at, value: 15 - 1e-12 };
  assert.equal(meetsDistanceFloor(noisy, 15).passed, true);

  // The comparison reports its own arithmetic.
  const report = meetsDistanceFloor(below, 15);
  assert.equal(report.operator, ">=");
  assert.equal(report.limit, 15);
  assert.equal(report.tolerance_dp, 6);
});

test("F2: a floating-point sum near the boundary does not flip the verdict", () => {
  // Accumulated 0.1 additions drift below the boundary: the sum of 150 of them
  // is 14.999999999999963, not 15. A naive comparison would deny this trade.
  let drifted = 0;
  for (let i = 0; i < 150; i += 1) drifted += 0.1;
  assert.notEqual(drifted, 15, "the drift this test depends on must actually exist");
  assert.ok(drifted < 15);
  const field = observed({
    value: drifted,
    source: "apex",
    classification: CLASSIFICATION.APEX_ESTIMATE,
    observedAt: NOW,
    now: NOW
  });
  assert.equal(meetsDistanceFloor(field, 15).passed, true);
});

test("F3: an unavailable distance fails the floor closed", () => {
  const result = meetsDistanceFloor(unavailable({ source: "apex" }), 15);
  assert.equal(result.passed, false);
  assert.match(result.reason, /failing closed/);
});

// --- Direction --------------------------------------------------------------
test("distance is computed with the correct sign for each side", () => {
  const long = liquidationDistancePct({
    liquidation: observed({
      value: 70_000,
      source: "apex",
      classification: CLASSIFICATION.APEX_ESTIMATE,
      observedAt: NOW,
      now: NOW
    }),
    markPrice: markField(),
    side: "LONG",
    now: NOW
  });
  // (80000 - 70000) / 80000 = 12.5%
  assert.ok(Math.abs(long.value - 12.5) < 1e-9);

  const short = liquidationDistancePct({
    liquidation: observed({
      value: 90_000,
      source: "apex",
      classification: CLASSIFICATION.APEX_ESTIMATE,
      observedAt: NOW,
      now: NOW
    }),
    markPrice: markField(),
    side: "SHORT",
    now: NOW
  });
  // (90000 - 80000) / 80000 = 12.5%
  assert.ok(Math.abs(short.value - 12.5) < 1e-9);
});

test("a distance carries both of its source classifications", () => {
  const liquidation = resolveLiquidation({
    book: leveredBook(),
    marks,
    symbol: "BTCUSDT",
    now: NOW
  });
  const distance = liquidationDistancePct({
    liquidation,
    markPrice: markField(),
    side: "LONG",
    now: NOW
  });

  assert.equal(distance.liquidation_classification, CLASSIFICATION.APEX_ESTIMATE);
  assert.equal(distance.price_source, "binance");
  assert.equal(distance.liquidation_source, "apex");
  assert.equal(distance.calculation_version, FORMULA_VERSION);
});
