import test from "node:test";
import assert from "node:assert/strict";

import { CLASSIFICATION } from "../src/provenance.mjs";
import { buildQuantPacket } from "../src/quant.mjs";
import { createBook } from "../src/portfolio.mjs";
import { activePolicy } from "../src/policy.mjs";
import { loadConstitution } from "../src/constitution.mjs";
import {
  COST_ASSUMPTIONS,
  ROUTE,
  ROUTE_STATUS,
  carryBps,
  concentrationPenaltyBps,
  evaluateRoutes,
  exposurePenaltyBps,
  feesBps,
  slippageBps,
  stressPenaltyBps,
  volatilityPenaltyBps
} from "../src/router.mjs";
import capturedContext from "../fixtures/market-context.captured.json" with { type: "json" };

const policy = activePolicy();
const constitution = loadConstitution();
const NOW = Date.now();

function packet(contextOverrides = {}, bookOverrides = null) {
  return buildQuantPacket({
    context: { ...capturedContext, fetchedAt: new Date(NOW).toISOString(), ...contextOverrides },
    book:
      bookOverrides ??
      createBook({
        walletBalance: 100_000,
        positions: [{ symbol: "BTCUSDT", qty: 0.001, entryPrice: 79_000 }]
      }),
    marks: { BTCUSDT: contextOverrides.markPrice ?? capturedContext.markPrice },
    symbol: "BTCUSDT",
    now: NOW,
    classification: CLASSIFICATION.SIMULATION
  });
}

// --- Component arithmetic ---------------------------------------------------

test("carry is signed by side and scaled by horizon", () => {
  // Positive funding means longs pay. Over one 8h interval at 0.01%:
  assert.equal(carryBps({ fundingRate: 0.0001, side: "LONG", horizonHours: 8 }), -1);
  assert.equal(carryBps({ fundingRate: 0.0001, side: "SHORT", horizonHours: 8 }), 1);

  // Half the horizon, half the carry.
  assert.equal(carryBps({ fundingRate: 0.0001, side: "SHORT", horizonHours: 4 }), 0.5);

  // Negative funding flips who receives.
  assert.equal(carryBps({ fundingRate: -0.0001, side: "LONG", horizonHours: 8 }), 1);
});

test("slippage is half the quoted spread", () => {
  assert.equal(slippageBps({ spreadBps: 3 }), 1.5);
});

test("the fee assumption is disclosed rather than hidden", () => {
  assert.equal(feesBps(), COST_ASSUMPTIONS.taker_fee_bps);
  assert.match(COST_ASSUMPTIONS.assumption, /APEX_ESTIMATE/);
});

test("penalties are zero on a comfortable book and rise with utilisation", () => {
  assert.equal(exposurePenaltyBps({ leverage: 0.5, maxLeverage: 2 }), 0);
  assert.ok(exposurePenaltyBps({ leverage: 1.8, maxLeverage: 2 }) > 0);
  assert.ok(
    exposurePenaltyBps({ leverage: 1.9, maxLeverage: 2 }) >
      exposurePenaltyBps({ leverage: 1.5, maxLeverage: 2 })
  );

  assert.equal(concentrationPenaltyBps({ namePct: 5, maxNamePct: 15 }), 0);
  assert.ok(concentrationPenaltyBps({ namePct: 14, maxNamePct: 15 }) > 0);
});

test("stress is charged only as liquidation approaches", () => {
  assert.equal(stressPenaltyBps({ liquidationDistancePct: 80, minDistancePct: 15 }), 0);
  assert.equal(stressPenaltyBps({ liquidationDistancePct: 30, minDistancePct: 15 }), 0);
  assert.ok(stressPenaltyBps({ liquidationDistancePct: 20, minDistancePct: 15 }) > 0);
  assert.ok(
    stressPenaltyBps({ liquidationDistancePct: 10, minDistancePct: 15 }) >
      stressPenaltyBps({ liquidationDistancePct: 20, minDistancePct: 15 })
  );
});

test("a missing liquidation distance is not treated as zero stress by accident", () => {
  // Absence means no exposure here, which genuinely is zero stress, but the
  // function must reach that by the null branch rather than by arithmetic.
  assert.equal(stressPenaltyBps({ liquidationDistancePct: null, minDistancePct: 15 }), 0);
});

test("volatility penalty scales with the square root of horizon", () => {
  const short = volatilityPenaltyBps({ realizedVolatility: 0.4, horizonHours: 4 });
  const long = volatilityPenaltyBps({ realizedVolatility: 0.4, horizonHours: 16 });
  assert.ok(long > short);
  assert.ok(Math.abs(long / short - 2) < 1e-9, "four times the horizon is twice the penalty");
});

// --- Route evaluation -------------------------------------------------------

test("every route is either scored or rejected with a reason", () => {
  const result = evaluateRoutes({ packet: packet(), policy, constitution });
  const routes = result.evaluations.map((e) => e.route);
  for (const name of Object.values(ROUTE)) {
    assert.ok(routes.includes(name), `${name} must be evaluated`);
  }
  for (const evaluation of result.evaluations) {
    if (evaluation.status === ROUTE_STATUS.REJECTED) {
      assert.ok(evaluation.reason && evaluation.reason.length > 0, `${evaluation.route} needs a reason`);
    }
  }
});

test("a route with missing evidence is rejected, not scored with defaults", () => {
  // A packet with no book has no portfolio keys, but the market routes only
  // need market keys, so remove a market key instead.
  const p = packet();
  delete p.evidence["funding.current"];

  const result = evaluateRoutes({ packet: p, policy, constitution });
  const carry = result.evaluations.find((e) => e.route === ROUTE.CARRY);

  assert.equal(carry.status, ROUTE_STATUS.REJECTED);
  assert.equal(carry.score, null, "a rejected route must carry no score");
  assert.ok(carry.missing_keys.includes("funding.current"));
  assert.match(carry.reason, /required evidence unavailable/);
});

test("every scored route exposes all nine components", () => {
  const result = evaluateRoutes({ packet: packet(), policy, constitution, executionVerified: true });
  const required = [
    "expected_return_bps",
    "carry_bps",
    "fees_bps",
    "slippage_bps",
    "volatility_penalty_bps",
    "exposure_penalty_bps",
    "concentration_penalty_bps",
    "liquidity_penalty_bps",
    "stress_penalty_bps"
  ];
  for (const evaluation of result.evaluations) {
    if (evaluation.score === null) continue;
    for (const key of required) {
      assert.equal(typeof evaluation.components[key], "number", `${evaluation.route}.${key}`);
    }
  }
});

test("the final score equals its components", () => {
  const result = evaluateRoutes({ packet: packet(), policy, constitution, executionVerified: true });
  for (const e of result.evaluations) {
    if (e.score === null) continue;
    const c = e.components;
    const expected =
      c.expected_return_bps +
      c.carry_bps -
      c.fees_bps -
      c.slippage_bps -
      c.volatility_penalty_bps -
      c.exposure_penalty_bps -
      c.concentration_penalty_bps -
      c.liquidity_penalty_bps -
      c.stress_penalty_bps;
    assert.ok(Math.abs(e.score - expected) < 1e-9, `${e.route} score must be reproducible`);
  }
});

test("carry takes the side that receives funding", () => {
  const longPays = evaluateRoutes({
    packet: packet({ fundingRate: 0.0005 }),
    policy,
    constitution,
    executionVerified: true
  });
  assert.equal(longPays.evaluations.find((e) => e.route === ROUTE.CARRY).side, "SHORT");

  const shortPays = evaluateRoutes({
    packet: packet({ fundingRate: -0.0005 }),
    policy,
    constitution,
    executionVerified: true
  });
  assert.equal(shortPays.evaluations.find((e) => e.route === ROUTE.CARRY).side, "LONG");
});

test("carry below the constitution's floor is rejected with the numbers", () => {
  // The captured funding rate is tiny, well under the 8 bps floor.
  const result = evaluateRoutes({ packet: packet(), policy, constitution, executionVerified: true });
  const carry = result.evaluations.find((e) => e.route === ROUTE.CARRY);
  assert.equal(carry.status, ROUTE_STATUS.REJECTED);
  assert.match(carry.reason, /below the 8 bps floor/);
});

test("a large funding rate clears the carry floor", () => {
  // 0.1% per interval is 10 bps to the receiving side, over the 8 bps floor.
  const result = evaluateRoutes({
    packet: packet({ fundingRate: 0.001 }),
    policy,
    constitution,
    executionVerified: true
  });
  const carry = result.evaluations.find((e) => e.route === ROUTE.CARRY);
  assert.notEqual(carry.status, ROUTE_STATUS.REJECTED);
  assert.ok(carry.components.carry_bps >= 8);
});

// --- The honesty constraint -------------------------------------------------

test("routes needing execution are NOT_EXECUTABLE while no write schema is verified", () => {
  const result = evaluateRoutes({ packet: packet(), policy, constitution, executionVerified: false });

  for (const route of [ROUTE.DIRECTIONAL, ROUTE.REVERSE_CARRY]) {
    const evaluation = result.evaluations.find((e) => e.route === route);
    assert.equal(evaluation.status, ROUTE_STATUS.NOT_EXECUTABLE);
    assert.equal(evaluation.executable, false);
    assert.match(evaluation.reason, /no Binance write tool has a verified schema/);
  }

  // And they are still scored, so the reasoning is visible even though the
  // action is unavailable.
  const directional = result.evaluations.find((e) => e.route === ROUTE.DIRECTIONAL);
  assert.equal(typeof directional.score, "number");
});

test("with execution unverified the selection can only be a no-position route", () => {
  const result = evaluateRoutes({ packet: packet(), policy, constitution, executionVerified: false });
  assert.ok(
    [ROUTE.PARK, ROUTE.STAND_DOWN].includes(result.selected),
    `expected a no-position route, got ${result.selected}`
  );
  assert.equal(result.execution_verified, false);
});

test("with execution verified a positive-scoring route can be selected", () => {
  // Strong negative funding makes a long carry genuinely profitable.
  const result = evaluateRoutes({
    packet: packet({ fundingRate: -0.002 }),
    policy,
    constitution,
    executionVerified: true
  });
  assert.ok(result.selected_score >= 0);
  assert.ok(result.evaluations.every((e) => e.status !== ROUTE_STATUS.NOT_EXECUTABLE));
});

test("PARK scores zero and is the baseline every route must beat", () => {
  const result = evaluateRoutes({ packet: packet(), policy, constitution, executionVerified: true });
  const park = result.evaluations.find((e) => e.route === ROUTE.PARK);
  assert.equal(park.score, 0);
  assert.equal(park.executable, true);
});

test("a book already outside policy rejects position-taking routes by name", () => {
  // 2 BTC against 10k of wallet: far past the net-delta and leverage caps.
  const breached = packet(
    {},
    createBook({
      walletBalance: 10_000,
      positions: [{ symbol: "BTCUSDT", qty: 2, entryPrice: 79_000 }]
    })
  );
  const result = evaluateRoutes({
    packet: breached,
    policy,
    constitution,
    executionVerified: true
  });

  assert.ok(result.book_breaches.length > 0, "the breach must be detected");
  assert.ok(result.book_breaches.some((b) => /net delta/.test(b)));

  for (const route of [ROUTE.CARRY, ROUTE.REVERSE_CARRY, ROUTE.DIRECTIONAL]) {
    const evaluation = result.evaluations.find((e) => e.route === route);
    assert.equal(evaluation.status, ROUTE_STATUS.REJECTED, `${route} must be rejected`);
    assert.equal(evaluation.score, null, "a rejected route carries no score");
    assert.match(evaluation.reason, /book is already outside policy/);
  }

  // Standing down is still available, and is the only sane answer.
  assert.ok([ROUTE.PARK, ROUTE.STAND_DOWN].includes(result.selected));
});

test("penalties stay bounded even against an extreme book", () => {
  // Without the utilisation clamp this produced a 405 bps concentration
  // penalty that swamped every other component.
  assert.ok(concentrationPenaltyBps({ namePct: 159.35, maxNamePct: 15 }) <= 20);
  assert.ok(exposurePenaltyBps({ leverage: 50, maxLeverage: 2 }) <= 20);
  assert.equal(concentrationPenaltyBps({ namePct: 15, maxNamePct: 15 }), 20);
});

test("rejected and not-executable routes are summarised for the caller", () => {
  const result = evaluateRoutes({ packet: packet(), policy, constitution, executionVerified: false });
  assert.ok(Array.isArray(result.rejected));
  assert.ok(Array.isArray(result.not_executable));
  for (const entry of [...result.rejected, ...result.not_executable]) {
    assert.ok(entry.route && entry.reason, "each entry names its route and its reason");
  }
});
