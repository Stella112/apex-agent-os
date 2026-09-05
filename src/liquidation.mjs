// Liquidation resolution with provenance (spec sections 8, 9, 10, 11).
//
// This module is the single place APEX is allowed to produce a liquidation
// value. It has one job beyond the arithmetic: never let an estimate be
// mistaken for something Binance said.

import {
  CLASSIFICATION,
  FRESHNESS,
  STATUS,
  invalidContext,
  observed,
  unavailable
} from "./provenance.mjs";
import { liquidationPrice } from "./referee.mjs";

export const FORMULA_VERSION = "liq-v1";

// Assumptions baked into liq-v1. Disclosed with every estimate it produces.
export const LIQ_V1_ASSUMPTIONS = [
  "A1 cross margin only; isolated margin is not modelled",
  "A2 maintenance-margin brackets from a static table, not the account's live leverageBracket",
  "A3 USDS-M linear contracts only; COIN-M inverse contracts are not modelled",
  "A4 filled positions only; open orders are not considered",
  "A5 funding, fees and insurance-fund clawback are excluded",
  "A6 only the named symbol's price varies; other marks are held fixed"
];

// Products for which liq-v1 is valid. Anything else is an invalid context
// rather than a number that happens to compute.
const SUPPORTED_PRODUCTS = new Set(["USDM_FUTURES"]);
const SUPPORTED_MARGIN_MODES = new Set(["CROSS"]);

// Resolve a liquidation price, preferring what Binance reported.
//
// `reported` is an optional provenance field carrying an Account-scope value.
// When APEX cannot verify such a tool exists, this argument is simply absent
// and the estimate path is used.
export function resolveLiquidation({
  reported = null,
  book,
  marks,
  symbol,
  product = "USDM_FUTURES",
  marginMode = "CROSS",
  now = Date.now(),
  thresholds
}) {
  // Path 1: Binance said so. Pass it through with its own provenance intact.
  if (reported && reported.status === STATUS.AVAILABLE && reported.value !== null) {
    return {
      ...reported,
      classification: CLASSIFICATION.BINANCE_REPORTED
    };
  }

  // Path 2: estimate it ourselves, but only where liq-v1 is actually valid.
  if (!SUPPORTED_PRODUCTS.has(product)) {
    return invalidContext({
      source: "apex",
      reason: `liq-v1 does not model product ${product}`
    });
  }
  if (!SUPPORTED_MARGIN_MODES.has(marginMode)) {
    return invalidContext({
      source: "apex",
      reason: `liq-v1 does not model margin mode ${marginMode}`
    });
  }
  if (!book || !marks || !Number.isFinite(marks[symbol])) {
    return invalidContext({
      source: "apex",
      reason: "missing book or mark price for the requested symbol"
    });
  }

  const price = liquidationPrice(book, marks, symbol);
  if (price === null) {
    // Not an error. The book genuinely cannot be liquidated by a move in this
    // symbol alone. That is the safest possible state, and it is not zero.
    return unavailable({
      source: "apex",
      reason: "no liquidation exposure in this symbol at the current book"
    });
  }

  return observed({
    value: price,
    source: "apex",
    classification: CLASSIFICATION.APEX_ESTIMATE,
    observedAt: now,
    now,
    thresholds,
    formula_version: FORMULA_VERSION,
    assumptions: LIQ_V1_ASSUMPTIONS,
    product,
    margin_mode: marginMode
  });
}

// Distance from mark to liquidation as a percentage (spec section 10).
//
// Only computed when the underlying liquidation value is valid for this exact
// position. Returns a provenance field, not a bare number.
export function liquidationDistancePct({
  liquidation,
  markPrice,
  side,
  now = Date.now(),
  thresholds
}) {
  if (!liquidation || liquidation.status === STATUS.INVALID_CONTEXT) {
    return invalidContext({
      source: "apex",
      reason: liquidation?.reason ?? "invalid liquidation context"
    });
  }
  if (liquidation.status !== STATUS.AVAILABLE || liquidation.value === null) {
    return unavailable({
      source: "apex",
      reason: liquidation?.reason ?? "liquidation price unavailable"
    });
  }
  if (!markPrice || !markPrice.value || markPrice.status !== STATUS.AVAILABLE) {
    return unavailable({ source: "apex", reason: "mark price unavailable" });
  }
  if (side !== "LONG" && side !== "SHORT") {
    return invalidContext({ source: "apex", reason: `unknown side ${side}` });
  }

  const current = markPrice.value;
  const liq = liquidation.value;
  const pct =
    side === "LONG"
      ? ((current - liq) / current) * 100
      : ((liq - current) / current) * 100;

  // The distance inherits the weaker of its two inputs. A distance computed
  // from a stale mark is itself stale.
  const inheritedAge = Math.max(liquidation.age_ms ?? 0, markPrice.age_ms ?? 0);

  return observed({
    value: pct,
    source: "apex",
    classification: liquidation.classification,
    observedAt: now - inheritedAge,
    now,
    thresholds,
    calculation_version: FORMULA_VERSION,
    price_source: markPrice.source,
    liquidation_source: liquidation.source,
    liquidation_classification: liquidation.classification,
    side
  });
}

// Deterministic comparison against a policy floor (spec section 11, test F).
//
// Floating point makes naive comparison at the boundary unreliable, so the
// comparison is made on values rounded to a fixed number of decimal places and
// the tolerance is stated explicitly.
export const DISTANCE_TOLERANCE_DP = 6;

export function meetsDistanceFloor(distanceField, floorPct) {
  if (!distanceField || distanceField.status !== STATUS.AVAILABLE) {
    return { passed: false, reason: "distance unavailable, failing closed" };
  }
  const factor = 10 ** DISTANCE_TOLERANCE_DP;
  const observedRounded = Math.round(distanceField.value * factor) / factor;
  const floorRounded = Math.round(floorPct * factor) / factor;
  return {
    passed: observedRounded >= floorRounded,
    observed: observedRounded,
    limit: floorRounded,
    operator: ">=",
    tolerance_dp: DISTANCE_TOLERANCE_DP
  };
}

// New risk may only be opened against liquidation data that is present and not
// stale (spec section 27). Anything else fails closed.
export function liquidationUsableForNewRisk(field) {
  if (!field || field.status !== STATUS.AVAILABLE) return false;
  return field.freshness === FRESHNESS.FRESH || field.freshness === FRESHNESS.AGING;
}
