// The Internal Risk Referee.
//
// The Referee does not check order size. It simulates the resulting portfolio
// and judges the consequence. Every denial ships with the rule that produced
// it and the numbers behind it, so the decision is checkable on screen.

import { POLICY, maintenanceMargin } from "./config.mjs";
import {
  applyCandidate,
  equity,
  grossNotional,
  notionalOf
} from "./portfolio.mjs";

// Total maintenance margin the book requires at a given set of marks.
export function maintenanceRequirement(book, marks) {
  return book.positions.reduce((total, p) => {
    const mark = marks[p.symbol] ?? p.entryPrice;
    return total + maintenanceMargin(p.symbol, notionalOf(p, mark));
  }, 0);
}

// Margin health at a hypothetical price for one symbol, all else held fixed.
// Liquidation occurs where this crosses zero.
function marginSlack(book, marks, symbol, price) {
  const hypothetical = { ...marks, [symbol]: price };
  return equity(book, hypothetical) - maintenanceRequirement(book, hypothetical);
}

// Cross-margin liquidation price for a symbol, solved numerically.
//
// Maintenance margin rate is a step function of notional, so the relationship
// is piecewise linear rather than closed-form. Bisection is used because it is
// robust across bracket boundaries and easy to verify by hand.
// Returns null when a move in this symbol alone cannot liquidate the book.
export function liquidationPrice(book, marks, symbol) {
  const position = book.positions.find((p) => p.symbol === symbol);
  if (!position || position.qty === 0) return null;

  const mark = marks[symbol] ?? position.entryPrice;
  if (marginSlack(book, marks, symbol, mark) <= 0) return mark;

  const isLong = position.qty > 0;
  let low = isLong ? 1e-9 : mark;
  let high = isLong ? mark : mark * 50;

  // Confirm the far bound is actually liquidatable, otherwise there is no root.
  const farBound = isLong ? low : high;
  if (marginSlack(book, marks, symbol, farBound) > 0) return null;

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const slack = marginSlack(book, marks, symbol, mid);
    if (slack > 0) {
      if (isLong) high = mid;
      else low = mid;
    } else if (isLong) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

// Distance from mark to liquidation, as a fraction of mark.
export function liquidationDistance(book, marks, symbol) {
  const liq = liquidationPrice(book, marks, symbol);
  if (liq === null) return null;
  const mark = marks[symbol];
  return Math.abs(mark - liq) / mark;
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function money(value) {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

// Judge a candidate order against the policy.
//
// Returns { verdict, checks, simulation }. Verdict is APPROVE, RESIZE or DENY.
// Checks are ordered and each carries the numbers that produced it.
export function judge({ book, marks, candidate, thesis, policy = POLICY }) {
  const checks = [];
  const marksAfter = { ...marks };
  const after = applyCandidate(book, candidate);

  const equityBefore = equity(book, marks);
  const equityAfter = equity(after, marksAfter);
  const openingEquity = book.sessionOpeningEquity ?? equityBefore;

  const record = (rule, passed, detail, numbers, severity = "DENY") => {
    checks.push({ rule, passed, detail, numbers, severity });
  };

  // Gate 0: confidence floor.
  const confidence = thesis?.confidence ?? 0;
  record(
    "CONFIDENCE_FLOOR",
    confidence >= policy.minConfidence,
    confidence >= policy.minConfidence
      ? `Confidence ${pct(confidence)} clears the ${pct(policy.minConfidence)} floor.`
      : `Confidence ${pct(confidence)} is below the ${pct(policy.minConfidence)} floor.`,
    { confidence, floor: policy.minConfidence }
  );

  // Gate 1: mandatory invalidation. Unbounded ideas are not executable.
  const hasInvalidation =
    typeof thesis?.invalidation === "number" && Number.isFinite(thesis.invalidation);
  record(
    "MANDATORY_INVALIDATION",
    hasInvalidation,
    hasInvalidation
      ? `Invalidation defined at ${money(thesis.invalidation)}.`
      : "Thesis carries no invalidation level. Unbounded ideas are not executable.",
    { invalidation: thesis?.invalidation ?? null }
  );

  // Gate 2: session drawdown lock.
  const sessionPnl = equityBefore - openingEquity;
  const drawdown = openingEquity > 0 ? -sessionPnl / openingEquity : 0;
  const locked = drawdown >= policy.maxDailyLoss;
  record(
    "DAILY_LOSS_LOCK",
    !locked,
    locked
      ? `Session drawdown ${pct(drawdown)} has breached the ${pct(policy.maxDailyLoss)} ceiling. Book is locked to risk-reducing actions.`
      : `Session drawdown ${pct(Math.max(0, drawdown))} is inside the ${pct(policy.maxDailyLoss)} ceiling.`,
    { sessionPnl, drawdown, ceiling: policy.maxDailyLoss }
  );

  // Gate 3: post-fill liquidation distance. This is the headline check.
  const distanceBefore = liquidationDistance(book, marks, candidate.symbol);
  const distanceAfter = liquidationDistance(after, marksAfter, candidate.symbol);
  const liqAfter = liquidationPrice(after, marksAfter, candidate.symbol);
  const liqPassed = distanceAfter === null || distanceAfter >= policy.minLiquidationDistance;
  record(
    "LIQUIDATION_DISTANCE",
    liqPassed,
    distanceAfter === null
      ? "No liquidation exposure in this symbol after the fill."
      : liqPassed
        ? `Post-fill liquidation sits at ${money(liqAfter)}, ${pct(distanceAfter)} away. Policy requires ${pct(policy.minLiquidationDistance)}.`
        : `Post-fill liquidation would sit at ${money(liqAfter)}, only ${pct(distanceAfter)} from mark. Policy requires ${pct(policy.minLiquidationDistance)}.`,
    {
      liquidationPriceAfter: liqAfter,
      distanceBefore,
      distanceAfter,
      required: policy.minLiquidationDistance,
      markPrice: marks[candidate.symbol]
    }
  );

  // Gate 4: risk budget measured at the invalidation level.
  let riskFraction = null;
  if (hasInvalidation && equityAfter > 0) {
    const perUnitLoss = Math.abs(candidate.entryPrice - thesis.invalidation);
    riskFraction = (perUnitLoss * candidate.qty) / equityAfter;
  }
  const riskPassed = riskFraction === null || riskFraction <= policy.maxRiskPerThesis;
  record(
    "RISK_BUDGET",
    riskPassed,
    riskFraction === null
      ? "Risk budget not computable without an invalidation level."
      : riskPassed
        ? `Loss at invalidation is ${pct(riskFraction)} of post-fill equity, inside the ${pct(policy.maxRiskPerThesis)} budget.`
        : `Loss at invalidation would be ${pct(riskFraction)} of post-fill equity, over the ${pct(policy.maxRiskPerThesis)} budget.`,
    { riskFraction, budget: policy.maxRiskPerThesis, equityAfter },
    "RESIZE"
  );

  // Gate 5: single-symbol concentration.
  const symbolPosition = after.positions.find((p) => p.symbol === candidate.symbol);
  const symbolNotional = symbolPosition
    ? notionalOf(symbolPosition, marksAfter[candidate.symbol])
    : 0;
  const concentration = equityAfter > 0 ? symbolNotional / equityAfter : Infinity;
  const concentrationPassed = concentration <= policy.maxSymbolConcentration;
  record(
    "CONCENTRATION",
    concentrationPassed,
    concentrationPassed
      ? `${candidate.symbol} would be ${pct(concentration)} of equity, inside the ${pct(policy.maxSymbolConcentration)} cap.`
      : `${candidate.symbol} would be ${pct(concentration)} of equity, over the ${pct(policy.maxSymbolConcentration)} cap.`,
    { symbolNotional, concentration, cap: policy.maxSymbolConcentration },
    "RESIZE"
  );

  // Gate 6: gross leverage across the whole book.
  const gross = grossNotional(after, marksAfter);
  const leverage = equityAfter > 0 ? gross / equityAfter : Infinity;
  const leveragePassed = leverage <= policy.maxGrossLeverage;
  record(
    "GROSS_LEVERAGE",
    leveragePassed,
    leveragePassed
      ? `Gross leverage would be ${leverage.toFixed(2)}x, inside the ${policy.maxGrossLeverage.toFixed(2)}x cap.`
      : `Gross leverage would be ${leverage.toFixed(2)}x, over the ${policy.maxGrossLeverage.toFixed(2)}x cap.`,
    { grossNotional: gross, leverage, cap: policy.maxGrossLeverage },
    "RESIZE"
  );

  // Gate 7: flow toxicity.
  //
  // This is an advisory, not a gate. Toxicity does not depend on order size, so
  // treating it as pass/fail made it unsatisfiable: once tripped, no resize
  // could ever clear it and the largest compliant size collapsed to zero. The
  // specification calls for size to be reduced rather than denied, so elevated
  // toxicity now applies a haircut to the permitted size and the check itself
  // always passes.
  const toxicity = thesis?.flowToxicity ?? 0;
  const toxicityElevated = toxicity >= policy.toxicFlowThreshold;
  const sizeHaircut = toxicityElevated
    ? Math.max(0.25, 1 - (toxicity - policy.toxicFlowThreshold) / (1 - policy.toxicFlowThreshold))
    : 1;
  record(
    "FLOW_TOXICITY",
    true,
    toxicityElevated
      ? `Order flow toxicity ${toxicity.toFixed(2)} is above the ${policy.toxicFlowThreshold.toFixed(2)} threshold. Permitted size is cut to ${(sizeHaircut * 100).toFixed(0)}%.`
      : `Order flow toxicity ${toxicity.toFixed(2)} is below the ${policy.toxicFlowThreshold.toFixed(2)} threshold.`,
    { toxicity, threshold: policy.toxicFlowThreshold, size_haircut: sizeHaircut },
    "ADVISORY"
  );

  // Gate 8: net directional delta. Only evaluated when the Constitution names
  // a limit, so the engine never invents one.
  let netDeltaBtc = null;
  if (Number.isFinite(policy.maxNetDeltaBtc)) {
    netDeltaBtc = after.positions
      .filter((p) => p.symbol.startsWith("BTC"))
      .reduce((total, p) => total + p.qty, 0);
    const deltaPassed = Math.abs(netDeltaBtc) <= policy.maxNetDeltaBtc;
    record(
      "NET_DELTA",
      deltaPassed,
      deltaPassed
        ? `Net BTC delta would be ${netDeltaBtc.toFixed(6)}, inside the ${policy.maxNetDeltaBtc} limit.`
        : `Net BTC delta would be ${netDeltaBtc.toFixed(6)}, over the ${policy.maxNetDeltaBtc} limit.`,
      { netDeltaBtc, limit: policy.maxNetDeltaBtc },
      "RESIZE"
    );
  }

  const hardFailures = checks.filter((c) => !c.passed && c.severity === "DENY");
  const softFailures = checks.filter((c) => !c.passed && c.severity === "RESIZE");

  let verdict = "APPROVE";
  if (hardFailures.length > 0) verdict = "DENY";
  else if (softFailures.length > 0) verdict = "RESIZE";

  return {
    verdict,
    checks,
    hardFailures,
    softFailures,
    // Which policy produced this verdict. Absent when the caller passed a bare
    // policy object rather than one derived from the Constitution.
    constitution_id: policy.constitution_id ?? null,
    constitution_version: policy.constitution_version ?? null,
    constitution_sha256: policy.constitution_sha256 ?? null,
    sizeHaircut,
    simulation: {
      sizeHaircut,
      netDeltaBtc,
      equityBefore,
      equityAfter,
      maintenanceBefore: maintenanceRequirement(book, marks),
      maintenanceAfter: maintenanceRequirement(after, marksAfter),
      liquidationPriceAfter: liqAfter,
      liquidationDistanceBefore: distanceBefore,
      liquidationDistanceAfter: distanceAfter,
      grossNotionalAfter: gross,
      leverageAfter: leverage,
      concentrationAfter: concentration,
      riskFraction,
      positionsAfter: after.positions
    }
  };
}

// Largest quantity that clears every gate, found by binary search on size.
// Returns 0 when no size clears the hard gates.
export function largestCompliantSize({ book, marks, candidate, thesis, policy = POLICY }) {
  const clears = (qty) =>
    judge({ book, marks, candidate: { ...candidate, qty }, thesis, policy }).verdict === "APPROVE";

  // Elevated order-flow toxicity reduces the permitted size rather than barring
  // the trade, so the haircut is applied to whatever the rules would otherwise
  // allow.
  const { sizeHaircut } = judge({ book, marks, candidate, thesis, policy });

  if (clears(candidate.qty)) return candidate.qty * sizeHaircut;

  let low = 0;
  let high = candidate.qty;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (clears(mid)) low = mid;
    else high = mid;
  }
  return low * sizeHaircut;
}
