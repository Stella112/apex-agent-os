// Portfolio Router (spec section 21).
//
// Evaluates the routes available given the current evidence, scores each one in
// basis points of notional over its own horizon, and rejects the rest with a
// reason. It proposes; it does not decide. The Referee still holds the veto and
// the human still holds the trigger.
//
// Two honesty rules govern this module:
//
//   1. A route whose required evidence is missing is REJECTED, not scored with
//      a default. A missing input is not a zero input.
//   2. A route requiring an execution capability APEX has not verified is
//      marked NOT_EXECUTABLE even when it scores well. Directive section 21
//      permits enabling a route only when its execution capability is verified,
//      and no Binance write tool has a published schema.

import { readEvidence } from "./quant.mjs";

export const ROUTE = {
  CARRY: "CARRY",
  REVERSE_CARRY: "REVERSE_CARRY",
  DIRECTIONAL: "DIRECTIONAL",
  PARK: "PARK",
  STAND_DOWN: "STAND_DOWN"
};

export const ROUTE_STATUS = {
  SCORED: "SCORED",
  REJECTED: "REJECTED",
  NOT_EXECUTABLE: "NOT_EXECUTABLE"
};

// Cost assumptions. These are APEX estimates, not account facts: the real fee
// tier is behind an authenticated endpoint, so it cannot be read here.
export const COST_ASSUMPTIONS = {
  taker_fee_bps: 4.0,
  assumption:
    "Binance USDS-M standard taker fee of 0.04%. The account's real tier is behind an " +
    "authenticated endpoint and is not readable, so this is an APEX_ESTIMATE.",
  slippage_model: "half the quoted spread, plus a size term against visible depth"
};

// Route definitions. Each declares what it needs before it may be scored.
const ROUTE_SPECS = {
  [ROUTE.CARRY]: {
    horizon_hours: 8,
    requires_execution: true,
    required_keys: ["funding.current", "price.mark", "price.spread_bps", "market.realized_volatility"],
    description: "Hold the side that receives funding"
  },
  [ROUTE.REVERSE_CARRY]: {
    horizon_hours: 8,
    requires_execution: true,
    required_keys: ["funding.current", "price.mark", "price.spread_bps", "market.order_book_imbalance"],
    description: "Pay funding to hold a directional view against the carry"
  },
  [ROUTE.DIRECTIONAL]: {
    horizon_hours: 4,
    requires_execution: true,
    required_keys: ["price.mark", "market.sma_24", "market.sma_168", "price.spread_bps"],
    description: "Take a momentum view, funding-agnostic"
  },
  [ROUTE.PARK]: {
    horizon_hours: 8,
    requires_execution: false,
    required_keys: [],
    description: "Hold the current book unchanged"
  },
  [ROUTE.STAND_DOWN]: {
    horizon_hours: 0,
    requires_execution: false,
    required_keys: [],
    description: "Take no action and open no risk"
  }
};

function val(packet, key) {
  const field = readEvidence(packet, key);
  return field && field.value !== null ? field.value : null;
}

function missingKeysFor(packet, keys) {
  return keys.filter((key) => val(packet, key) === null);
}

// --- Cost and penalty components -------------------------------------------
// Every one of these is documented arithmetic, in basis points of notional.

// Funding accrues per 8h interval. Positive rate means longs pay shorts.
export function carryBps({ fundingRate, side, horizonHours }) {
  const intervals = horizonHours / 8;
  const paidByLong = fundingRate * intervals * 10_000;
  return side === "LONG" ? -paidByLong : paidByLong;
}

export function slippageBps({ spreadBps }) {
  // Crossing the book costs about half the quoted spread on entry.
  return spreadBps / 2;
}

export function feesBps() {
  return COST_ASSUMPTIONS.taker_fee_bps;
}

// Volatility over the horizon, expressed in bps, scaled down to a penalty.
// A wider distribution of outcomes is a real cost to a bounded-risk mandate.
export function volatilityPenaltyBps({ realizedVolatility, horizonHours }) {
  const horizonVol = realizedVolatility * Math.sqrt(horizonHours / (24 * 365));
  return horizonVol * 10_000 * 0.25;
}

// Penalties express *approaching* a limit. Being past one is not a penalty,
// it is a rejection, handled by bookBreaches below. Utilisation is therefore
// clamped to 1: without the clamp a book at ten times its cap produced a
// four-hundred basis point penalty that swamped every other component and made
// the scores meaningless.
const PENALTY_AT_FULL_UTILISATION_BPS = 20;

function utilisationPenalty(current, limit) {
  if (current === null || !limit) return 0;
  const utilisation = Math.min(1, Math.abs(current) / limit);
  return Math.max(0, utilisation - 0.5) * 2 * PENALTY_AT_FULL_UTILISATION_BPS;
}

export function exposurePenaltyBps({ leverage, maxLeverage }) {
  return utilisationPenalty(leverage, maxLeverage);
}

export function concentrationPenaltyBps({ namePct, maxNamePct }) {
  return utilisationPenalty(namePct, maxNamePct);
}

// Hard Constitution limits the current book already violates. A route that
// would add exposure cannot be scored against a book that is already outside
// policy: the Referee would deny it regardless, so the honest output is a
// rejection naming the breach.
export function bookBreaches(packet, policy) {
  const breaches = [];
  const leverage = val(packet, "portfolio.leverage");
  const namePct = val(packet, "portfolio.name_exposure_pct");
  const netDelta = val(packet, "portfolio.net_delta_btc");

  if (leverage !== null && policy?.maxGrossLeverage && leverage > policy.maxGrossLeverage) {
    breaches.push(
      `gross leverage ${leverage.toFixed(2)}x exceeds the ${policy.maxGrossLeverage}x cap`
    );
  }
  if (namePct !== null && policy?.maxSymbolConcentration) {
    const cap = policy.maxSymbolConcentration * 100;
    if (namePct > cap) {
      breaches.push(`name exposure ${namePct.toFixed(2)}% exceeds the ${cap}% cap`);
    }
  }
  if (
    netDelta !== null &&
    Number.isFinite(policy?.maxNetDeltaBtc) &&
    Math.abs(netDelta) > policy.maxNetDeltaBtc
  ) {
    breaches.push(
      `net delta ${netDelta.toFixed(6)} BTC exceeds the ${policy.maxNetDeltaBtc} BTC cap`
    );
  }
  return breaches;
}

export function liquidityPenaltyBps({ spreadBps }) {
  // A wide book is a warning as well as a cost, so it is charged twice: once as
  // slippage and once here.
  return Math.max(0, spreadBps - 1) * 2;
}

// Distance to liquidation is the stress term. Comfortable books pay nothing.
export function stressPenaltyBps({ liquidationDistancePct, minDistancePct }) {
  if (liquidationDistancePct === null) return 0;
  if (liquidationDistancePct >= minDistancePct * 2) return 0;
  const shortfall = Math.max(0, minDistancePct * 2 - liquidationDistancePct);
  return shortfall * 3;
}

// --- Expected return per route ---------------------------------------------

function expectedReturnBps(route, packet, side) {
  const mark = val(packet, "price.mark");
  switch (route) {
    case ROUTE.CARRY:
      // The carry itself is the thesis; no directional edge is claimed.
      return 0;
    case ROUTE.REVERSE_CARRY: {
      // Edge is claimed from order-book imbalance only, and deliberately
      // discounted: imbalance is a weak, fast-decaying signal.
      const imbalance = val(packet, "market.order_book_imbalance");
      if (imbalance === null) return 0;
      const signed = side === "LONG" ? imbalance : -imbalance;
      return signed * 12;
    }
    case ROUTE.DIRECTIONAL: {
      const sma24 = val(packet, "market.sma_24");
      const sma168 = val(packet, "market.sma_168");
      if (mark === null || sma24 === null || sma168 === null) return 0;
      const trend = (sma24 - sma168) / sma168;
      const signed = side === "LONG" ? trend : -trend;
      return signed * 10_000 * 0.15;
    }
    default:
      return 0;
  }
}

// Which side a route would take, derived from evidence rather than assumed.
function sideFor(route, packet) {
  const funding = val(packet, "funding.current");
  const imbalance = val(packet, "market.order_book_imbalance");
  const sma24 = val(packet, "market.sma_24");
  const sma168 = val(packet, "market.sma_168");

  switch (route) {
    case ROUTE.CARRY:
      // Receive funding: short when longs pay, long when shorts pay.
      if (funding === null) return null;
      return funding > 0 ? "SHORT" : "LONG";
    case ROUTE.REVERSE_CARRY:
      if (imbalance === null) return null;
      return imbalance > 0 ? "LONG" : "SHORT";
    case ROUTE.DIRECTIONAL:
      if (sma24 === null || sma168 === null) return null;
      return sma24 >= sma168 ? "LONG" : "SHORT";
    default:
      return null;
  }
}

// --- Evaluation -------------------------------------------------------------

export function evaluateRoutes({
  packet,
  policy,
  executionVerified = false,
  constitution = null
}) {
  const minNetCarryBps = constitution?.routing?.min_net_carry_bps ?? 0;
  const breaches = bookBreaches(packet, policy);
  const evaluations = [];

  for (const [route, spec] of Object.entries(ROUTE_SPECS)) {
    const missing = missingKeysFor(packet, spec.required_keys);

    if (missing.length > 0) {
      evaluations.push({
        route,
        status: ROUTE_STATUS.REJECTED,
        reason: `required evidence unavailable: ${missing.join(", ")}`,
        missing_keys: missing,
        score: null
      });
      continue;
    }

    const side = sideFor(route, packet);
    const horizonHours = spec.horizon_hours;

    // A route that would add exposure to an already non-compliant book is
    // rejected before scoring. Scoring it would imply it were available.
    if (spec.requires_execution && breaches.length > 0) {
      evaluations.push({
        route,
        status: ROUTE_STATUS.REJECTED,
        side,
        reason: `book is already outside policy: ${breaches.join("; ")}`,
        book_breaches: breaches,
        score: null
      });
      continue;
    }

    // Routes that take no position have no cost and no return. They are the
    // baseline every other route must beat.
    if (route === ROUTE.PARK || route === ROUTE.STAND_DOWN) {
      evaluations.push({
        route,
        status: ROUTE_STATUS.SCORED,
        side: null,
        horizon_hours: horizonHours,
        components: {
          expected_return_bps: 0,
          carry_bps: 0,
          fees_bps: 0,
          slippage_bps: 0,
          volatility_penalty_bps: 0,
          exposure_penalty_bps: 0,
          concentration_penalty_bps: 0,
          liquidity_penalty_bps: 0,
          stress_penalty_bps: 0
        },
        score: 0,
        executable: true,
        description: spec.description
      });
      continue;
    }

    const fundingRate = val(packet, "funding.current");
    const spreadBps = val(packet, "price.spread_bps");
    const vol = val(packet, "market.realized_volatility") ?? 0;
    const leverage = val(packet, "portfolio.leverage");
    const namePct = val(packet, "portfolio.name_exposure_pct");
    const liqDistance = val(packet, "portfolio.liquidation_distance_pct");

    const components = {
      expected_return_bps: expectedReturnBps(route, packet, side),
      carry_bps: carryBps({ fundingRate, side, horizonHours }),
      fees_bps: feesBps(),
      slippage_bps: slippageBps({ spreadBps }),
      volatility_penalty_bps: volatilityPenaltyBps({
        realizedVolatility: vol,
        horizonHours
      }),
      exposure_penalty_bps: exposurePenaltyBps({
        leverage,
        maxLeverage: policy?.maxGrossLeverage
      }),
      concentration_penalty_bps: concentrationPenaltyBps({
        namePct,
        maxNamePct: policy ? policy.maxSymbolConcentration * 100 : null
      }),
      liquidity_penalty_bps: liquidityPenaltyBps({ spreadBps }),
      stress_penalty_bps: stressPenaltyBps({
        liquidationDistancePct: liqDistance,
        minDistancePct: policy ? policy.minLiquidationDistance * 100 : 15
      })
    };

    const score =
      components.expected_return_bps +
      components.carry_bps -
      components.fees_bps -
      components.slippage_bps -
      components.volatility_penalty_bps -
      components.exposure_penalty_bps -
      components.concentration_penalty_bps -
      components.liquidity_penalty_bps -
      components.stress_penalty_bps;

    // A carry route must clear the Constitution's minimum net carry, otherwise
    // it is not worth the exposure regardless of its score.
    if (route === ROUTE.CARRY && components.carry_bps < minNetCarryBps) {
      evaluations.push({
        route,
        status: ROUTE_STATUS.REJECTED,
        side,
        reason: `net carry ${components.carry_bps.toFixed(2)} bps is below the ${minNetCarryBps} bps floor`,
        components,
        score
      });
      continue;
    }

    // Scored, but honest about whether it could actually be executed.
    evaluations.push({
      route,
      status: executionVerified ? ROUTE_STATUS.SCORED : ROUTE_STATUS.NOT_EXECUTABLE,
      side,
      horizon_hours: horizonHours,
      components,
      score,
      executable: executionVerified,
      reason: executionVerified
        ? undefined
        : "no Binance write tool has a verified schema, so this route cannot be executed",
      description: spec.description
    });
  }

  // The chosen route is the best-scoring one that is actually executable. When
  // execution is unverified, that will be PARK or STAND_DOWN by construction,
  // which is the correct and honest outcome.
  const executable = evaluations.filter((e) => e.executable === true && e.score !== null);
  executable.sort((a, b) => b.score - a.score);
  const selected = executable[0] ?? null;

  return {
    evaluations,
    book_breaches: breaches,
    selected: selected ? selected.route : null,
    selected_score: selected ? selected.score : null,
    execution_verified: executionVerified,
    cost_assumptions: COST_ASSUMPTIONS,
    rejected: evaluations
      .filter((e) => e.status === ROUTE_STATUS.REJECTED)
      .map((e) => ({ route: e.route, reason: e.reason })),
    not_executable: evaluations
      .filter((e) => e.status === ROUTE_STATUS.NOT_EXECUTABLE)
      .map((e) => ({ route: e.route, score: e.score, reason: e.reason }))
  };
}
