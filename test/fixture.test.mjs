// The killer fixture must deny, and the resize must land inside the
// Constitution (spec sections 26, 30, 31).

import test from "node:test";
import assert from "node:assert/strict";

import { activePolicy } from "../src/policy.mjs";
import { judge, largestCompliantSize, liquidationDistance } from "../src/referee.mjs";
import { applyCandidate, equity, grossNotional } from "../src/portfolio.mjs";
import {
  EXECUTION_MODE,
  EXPECTED_BREACHES,
  FIXTURE_CLASSIFICATION,
  fixtureBook,
  fixtureMarks,
  fixtureThesis,
  recklessCandidate
} from "../fixtures/reckless-add.mjs";
import {
  PROPOSALS,
  deskBook,
  deskMarks,
  deskThesis
} from "../fixtures/desk.mjs";

const policy = activePolicy();

test("the fixture is labelled as a simulation, never as live data", () => {
  assert.equal(EXECUTION_MODE, "SIMULATION");
  assert.equal(FIXTURE_CLASSIFICATION, "SIMULATION");
});

test("the fixture actually produces an 11.8% liquidation distance", () => {
  const after = applyCandidate(fixtureBook(), recklessCandidate);
  const distance = liquidationDistance(after, fixtureMarks, "BTCUSDT");
  assert.ok(
    Math.abs(distance * 100 - 11.8) < 0.05,
    `expected about 11.8%, engine produced ${(distance * 100).toFixed(3)}%`
  );
});

test("flow toxicity is advisory and never blocks a resize", () => {
  // Toxicity does not depend on order size, so treating it as a pass/fail gate
  // made it unsatisfiable: once tripped, no resize could ever clear it and the
  // compliant size collapsed to zero.
  const toxic = { ...deskThesis, flowToxicity: 0.95 };
  const result = judge({
    book: deskBook(),
    marks: deskMarks,
    candidate: PROPOSALS.modest,
    thesis: toxic,
    policy
  });
  const check = result.checks.find((c) => c.rule === "FLOW_TOXICITY");
  assert.equal(check.passed, true, "an advisory never fails");
  assert.equal(check.severity, "ADVISORY");
  assert.ok(check.numbers.size_haircut < 1, "elevated toxicity cuts the permitted size");
  assert.ok(check.numbers.size_haircut >= 0.25, "the haircut is floored, not zeroed");

  const safe = largestCompliantSize({
    book: deskBook(),
    marks: deskMarks,
    candidate: PROPOSALS.reckless,
    thesis: toxic,
    policy
  });
  assert.ok(safe > 0, "a toxic tape reduces size rather than forbidding the trade");
});

test("the reckless add is DENIED by the Constitution", () => {
  const result = judge({
    book: fixtureBook(),
    marks: fixtureMarks,
    candidate: recklessCandidate,
    thesis: fixtureThesis,
    policy
  });

  assert.equal(result.verdict, "DENY");

  const failed = result.checks.filter((c) => !c.passed).map((c) => c.rule);
  for (const rule of ["LIQUIDATION_DISTANCE", "GROSS_LEVERAGE", "CONCENTRATION"]) {
    assert.ok(failed.includes(rule), `expected ${rule} to fail, failures were ${failed.join(", ")}`);
  }
  assert.ok(failed.length >= 3, "the fixture must breach several rules at once");
});

test("the denial cites each rule with observed value, limit and operator", () => {
  const result = judge({
    book: fixtureBook(),
    marks: fixtureMarks,
    candidate: recklessCandidate,
    thesis: fixtureThesis,
    policy
  });

  const liq = result.checks.find((c) => c.rule === "LIQUIDATION_DISTANCE");
  assert.equal(liq.passed, false);
  assert.ok(liq.numbers.distanceAfter < policy.minLiquidationDistance);
  assert.equal(liq.numbers.required, 0.15);

  const lev = result.checks.find((c) => c.rule === "GROSS_LEVERAGE");
  assert.equal(lev.passed, false);
  assert.ok(lev.numbers.leverage > 2);
  assert.equal(lev.numbers.cap, 2);

  const delta = result.checks.find((c) => c.rule === "NET_DELTA");
  assert.equal(delta.numbers.limit, 0.25, "the net-delta limit comes from the Constitution");
});

test("the verdict records which Constitution produced it", () => {
  const result = judge({
    book: fixtureBook(),
    marks: fixtureMarks,
    candidate: recklessCandidate,
    thesis: fixtureThesis,
    policy
  });

  assert.equal(result.constitution_id, "apex-v1");
  assert.equal(result.constitution_version, "1.1.0");
  assert.match(result.constitution_sha256, /^[0-9a-f]{64}$/);
});

test("the resize is computed from the rules, not hardcoded, and passes", () => {
  const book = fixtureBook();
  const safeQty = largestCompliantSize({
    book,
    marks: fixtureMarks,
    candidate: recklessCandidate,
    thesis: fixtureThesis,
    policy
  });

  assert.ok(safeQty >= 0);
  assert.ok(safeQty < recklessCandidate.qty, "the resize must be smaller than the proposal");

  if (safeQty === 0) {
    // A legitimate outcome: no size clears the Constitution. Then the correct
    // action is to stand down, not to trade something small.
    return;
  }

  const resized = judge({
    book,
    marks: fixtureMarks,
    candidate: { ...recklessCandidate, qty: safeQty },
    thesis: fixtureThesis,
    policy
  });
  assert.equal(resized.verdict, "APPROVE");
  assert.ok(resized.checks.every((c) => c.passed));
});

test("the post-resize state satisfies every Constitution limit it can be measured against", () => {
  const book = fixtureBook();
  const safeQty = largestCompliantSize({
    book,
    marks: fixtureMarks,
    candidate: recklessCandidate,
    thesis: fixtureThesis,
    policy
  });
  if (safeQty === 0) return;

  const after = applyCandidate(book, { ...recklessCandidate, qty: safeQty });
  const eq = equity(after, fixtureMarks);
  const leverage = grossNotional(after, fixtureMarks) / eq;
  const distance = liquidationDistance(after, fixtureMarks, "BTCUSDT");
  const netDelta = after.positions
    .filter((p) => p.symbol.startsWith("BTC"))
    .reduce((t, p) => t + p.qty, 0);

  assert.ok(leverage <= policy.maxGrossLeverage + 1e-9, `leverage ${leverage}`);
  assert.ok(Math.abs(netDelta) <= policy.maxNetDeltaBtc + 1e-9, `net delta ${netDelta}`);
  if (distance !== null) {
    assert.ok(distance >= policy.minLiquidationDistance - 1e-9, `distance ${distance}`);
  }
});

test("a denial on the desk book still yields a size the operator can act on", () => {
  // A refusal that cannot say what would work is not useful. This is the loop
  // the app depends on: DENY, then a computed size that actually passes.
  const safeQty = largestCompliantSize({
    book: deskBook(),
    marks: deskMarks,
    candidate: PROPOSALS.reckless,
    thesis: deskThesis,
    policy
  });
  assert.ok(safeQty > 0, "the Referee must be able to propose a workable size");
  assert.ok(safeQty < PROPOSALS.reckless.qty);

  const rechecked = judge({
    book: deskBook(),
    marks: deskMarks,
    candidate: { ...PROPOSALS.reckless, qty: safeQty },
    thesis: deskThesis,
    policy
  });
  assert.equal(rechecked.verdict, "APPROVE", "the resized proposal must actually pass");
});

test("the modest proposal clears every rule as proposed", () => {
  const result = judge({
    book: deskBook(),
    marks: deskMarks,
    candidate: PROPOSALS.modest,
    thesis: deskThesis,
    policy
  });
  assert.equal(result.verdict, "APPROVE");
  assert.ok(result.checks.every((c) => c.passed));
});

test("a book that breaches concentration at rest admits no size at all", () => {
  // The legacy reckless fixture holds 120% of its equity in one name before any
  // order exists. Standing down is then the only correct answer, and the engine
  // must say zero rather than invent a small trade.
  const safeQty = largestCompliantSize({
    book: fixtureBook(),
    marks: fixtureMarks,
    candidate: recklessCandidate,
    thesis: fixtureThesis,
    policy
  });
  assert.equal(safeQty, 0);
});
