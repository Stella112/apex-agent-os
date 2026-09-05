import test from "node:test";
import assert from "node:assert/strict";

import { POLICY, maintenanceMargin, maintenanceTier } from "../src/config.mjs";
import { createBook, applyCandidate, equity } from "../src/portfolio.mjs";
import {
  judge,
  largestCompliantSize,
  liquidationDistance,
  liquidationPrice,
  maintenanceRequirement
} from "../src/referee.mjs";

// Closed-form cross-margin liquidation price for a book holding exactly one
// position, used to verify the numerical solver.
//
//   equity(P) = WB + q(P - E)
//   MM(P)     = |q| * P * mmr - deduction
//   liquidation where equity(P) = MM(P)
//
// For a long position this rearranges to:
//   P = (qE - WB - deduction) / (q(1 - mmr))
function closedFormLongLiquidation({ walletBalance, qty, entryPrice, mmr, deduction }) {
  return (qty * entryPrice - walletBalance - deduction) / (qty * (1 - mmr));
}

test("maintenance margin matches the published bracket arithmetic", () => {
  // 100,000 notional falls in the 500,000 bracket: 0.50% rate, 50 deduction.
  assert.equal(maintenanceTier("BTCUSDT", 100_000).mmr, 0.005);
  assert.equal(maintenanceMargin("BTCUSDT", 100_000), 100_000 * 0.005 - 50);

  // 40,000 notional falls in the first bracket: 0.40% rate, no deduction.
  assert.equal(maintenanceMargin("BTCUSDT", 40_000), 40_000 * 0.004);
});

test("numerical liquidation price agrees with the closed form for one long", () => {
  const walletBalance = 10_000;
  const qty = 1;
  const entryPrice = 80_000;
  const book = createBook({
    walletBalance,
    positions: [{ symbol: "BTCUSDT", qty, entryPrice }]
  });
  const marks = { BTCUSDT: 80_000 };

  const solved = liquidationPrice(book, marks, "BTCUSDT");
  const expected = closedFormLongLiquidation({
    walletBalance,
    qty,
    entryPrice,
    mmr: 0.005,
    deduction: 50
  });

  assert.ok(Math.abs(solved - expected) < 0.01, `solved ${solved} vs expected ${expected}`);

  // And the defining property holds: equity equals maintenance margin there.
  const atLiq = { BTCUSDT: solved };
  assert.ok(Math.abs(equity(book, atLiq) - maintenanceRequirement(book, atLiq)) < 0.01);
});

test("liquidation solver handles the short side symmetrically", () => {
  const book = createBook({
    walletBalance: 10_000,
    positions: [{ symbol: "BTCUSDT", qty: -1, entryPrice: 80_000 }]
  });
  const marks = { BTCUSDT: 80_000 };

  const liq = liquidationPrice(book, marks, "BTCUSDT");
  assert.ok(liq > 80_000, "a short liquidates above the mark");

  const atLiq = { BTCUSDT: liq };
  assert.ok(Math.abs(equity(book, atLiq) - maintenanceRequirement(book, atLiq)) < 0.01);
});

test("a flat book has no liquidation price in that symbol", () => {
  const book = createBook({ walletBalance: 10_000, positions: [] });
  assert.equal(liquidationPrice(book, { BTCUSDT: 80_000 }, "BTCUSDT"), null);
});

test("the Referee denies a fill that lands liquidation inside the policy floor", () => {
  // 10,000 of equity buying 1 BTC at 80,000 is 8x gross. Liquidation lands
  // about 12% away, inside the 15% floor, so this must be denied.
  const book = createBook({ walletBalance: 10_000, positions: [] });
  const marks = { BTCUSDT: 80_000 };
  const candidate = { symbol: "BTCUSDT", side: "LONG", qty: 1, entryPrice: 80_000 };
  const thesis = { confidence: 0.8, invalidation: 78_000, flowToxicity: 0.2 };

  const result = judge({ book, marks, candidate, thesis });

  assert.equal(result.verdict, "DENY");
  const liqCheck = result.checks.find((c) => c.rule === "LIQUIDATION_DISTANCE");
  assert.equal(liqCheck.passed, false);
  assert.ok(liqCheck.numbers.distanceAfter < POLICY.minLiquidationDistance);

  // The denial must carry the computed number, not just a verdict.
  assert.ok(Number.isFinite(liqCheck.numbers.liquidationPriceAfter));
  assert.match(liqCheck.detail, /liquidation would sit at/);
});

test("the Referee refuses a thesis with no invalidation level", () => {
  const book = createBook({ walletBalance: 100_000, positions: [] });
  const marks = { BTCUSDT: 80_000 };
  const candidate = { symbol: "BTCUSDT", side: "LONG", qty: 0.1, entryPrice: 80_000 };
  const thesis = { confidence: 0.9, flowToxicity: 0.1 }; // no invalidation

  const result = judge({ book, marks, candidate, thesis });

  assert.equal(result.verdict, "DENY");
  assert.ok(result.hardFailures.some((c) => c.rule === "MANDATORY_INVALIDATION"));
});

test("the Referee approves a conservatively sized fill", () => {
  const book = createBook({ walletBalance: 100_000, positions: [] });
  const marks = { BTCUSDT: 80_000 };
  const candidate = { symbol: "BTCUSDT", side: "LONG", qty: 0.25, entryPrice: 80_000 };
  const thesis = { confidence: 0.78, invalidation: 74_000, flowToxicity: 0.25 };

  const result = judge({ book, marks, candidate, thesis });

  assert.equal(result.verdict, "APPROVE");
  assert.ok(result.checks.every((c) => c.passed));

  // Equity here exceeds the position value, so a move in BTC alone cannot
  // liquidate the book at all. A null distance is the safest possible result,
  // not a missing one.
  const { liquidationDistanceAfter } = result.simulation;
  assert.ok(
    liquidationDistanceAfter === null || liquidationDistanceAfter > POLICY.minLiquidationDistance,
    `expected no liquidation exposure or a distance past the floor, got ${liquidationDistanceAfter}`
  );
});

test("a position smaller than equity cannot be liquidated by price alone", () => {
  // 100,000 of equity holding 20,000 of notional: the position would have to
  // be worth less than nothing to wipe the account out.
  const book = createBook({
    walletBalance: 100_000,
    positions: [{ symbol: "BTCUSDT", qty: 0.25, entryPrice: 80_000 }]
  });
  assert.equal(liquidationPrice(book, { BTCUSDT: 80_000 }, "BTCUSDT"), null);
});

test("the daily loss lock blocks new risk once the session ceiling is breached", () => {
  const book = createBook({
    walletBalance: 90_000,
    positions: []
  });
  book.sessionOpeningEquity = 100_000; // down 10%, past the 5% ceiling

  const marks = { BTCUSDT: 80_000 };
  const candidate = { symbol: "BTCUSDT", side: "LONG", qty: 0.1, entryPrice: 80_000 };
  const thesis = { confidence: 0.9, invalidation: 78_000, flowToxicity: 0.1 };

  const result = judge({ book, marks, candidate, thesis });

  assert.equal(result.verdict, "DENY");
  const lock = result.checks.find((c) => c.rule === "DAILY_LOSS_LOCK");
  assert.equal(lock.passed, false);
  assert.ok(lock.numbers.drawdown >= POLICY.maxDailyLoss);
});

test("concentration is judged on the resulting book, not the single order", () => {
  // Each order alone is small. Together they breach the concentration cap.
  const marks = { BTCUSDT: 80_000 };
  const thesis = { confidence: 0.8, invalidation: 79_000, flowToxicity: 0.1 };
  let book = createBook({ walletBalance: 100_000, positions: [] });

  const order = { symbol: "BTCUSDT", side: "LONG", qty: 0.2, entryPrice: 80_000 };
  assert.equal(judge({ book, marks, candidate: order, thesis }).verdict, "APPROVE");

  book = applyCandidate(book, order);
  book = applyCandidate(book, order); // now 0.4 BTC held

  const third = judge({ book, marks, candidate: order, thesis });
  assert.notEqual(third.verdict, "APPROVE");
  assert.ok(
    third.checks.some((c) => c.rule === "CONCENTRATION" && !c.passed),
    "the third add must trip concentration on the resulting book"
  );
});

test("resizing finds the largest size that clears every gate", () => {
  const book = createBook({ walletBalance: 100_000, positions: [] });
  const marks = { BTCUSDT: 80_000 };
  const candidate = { symbol: "BTCUSDT", side: "LONG", qty: 5, entryPrice: 80_000 };
  const thesis = { confidence: 0.8, invalidation: 78_400, flowToxicity: 0.2 };

  assert.notEqual(judge({ book, marks, candidate, thesis }).verdict, "APPROVE");

  const safeQty = largestCompliantSize({ book, marks, candidate, thesis });
  assert.ok(safeQty > 0 && safeQty < candidate.qty);

  const resized = judge({ book, marks, candidate: { ...candidate, qty: safeQty }, thesis });
  assert.equal(resized.verdict, "APPROVE");

  // And a hair more must fail, proving the boundary is tight.
  const tooMuch = judge({
    book,
    marks,
    candidate: { ...candidate, qty: safeQty * 1.05 },
    thesis
  });
  assert.notEqual(tooMuch.verdict, "APPROVE");
});

test("adding to a position averages the entry price correctly", () => {
  let book = createBook({ walletBalance: 100_000, positions: [] });
  book = applyCandidate(book, {
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 1,
    entryPrice: 80_000
  });
  book = applyCandidate(book, {
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 1,
    entryPrice: 60_000
  });

  const position = book.positions.find((p) => p.symbol === "BTCUSDT");
  assert.equal(position.qty, 2);
  assert.equal(position.entryPrice, 70_000);
});

test("every check carries the numbers behind it", () => {
  const book = createBook({ walletBalance: 50_000, positions: [] });
  const marks = { BTCUSDT: 80_000 };
  const candidate = { symbol: "BTCUSDT", side: "LONG", qty: 1, entryPrice: 80_000 };
  const thesis = { confidence: 0.8, invalidation: 78_000, flowToxicity: 0.2 };

  const result = judge({ book, marks, candidate, thesis });

  for (const check of result.checks) {
    assert.ok(check.rule, "each check names its rule");
    assert.ok(check.detail.length > 0, "each check explains itself");
    assert.equal(typeof check.numbers, "object", "each check carries its numbers");
  }
});
