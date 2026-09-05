// DEMO FIXTURE — SIMULATION (spec sections 29, 30, 31).
//
// This is a deliberately reckless proposed trade, constructed so the Referee's
// veto is deterministic and reproducible on any machine. It did NOT come from a
// live Binance account. Nothing here is BINANCE_REPORTED. Every value carries
// the SIMULATION classification and the UI must display it as such.
//
// It exists to answer one question in front of a judge: when an agent proposes
// something dangerous, does the risk authority actually stop it?

import { CLASSIFICATION } from "../src/provenance.mjs";
import { createBook } from "../src/portfolio.mjs";

export const FIXTURE_LABEL = "DETERMINISTIC SAFETY FIXTURE";
export const EXECUTION_MODE = "SIMULATION";
export const FIXTURE_SOURCE = "SIMULATOR";
export const FIXTURE_CLASSIFICATION = CLASSIFICATION.SIMULATION;

export const MARK_PRICE = 80_000;

// A small account already carrying a modest long.
export function fixtureBook() {
  const book = createBook({
    walletBalance: 2_000,
    positions: [{ symbol: "BTCUSDT", qty: 0.03, entryPrice: 80_000 }]
  });
  book.sessionOpeningEquity = 2_000;
  return book;
}

export const fixtureMarks = { BTCUSDT: MARK_PRICE };

// The reckless proposal: add enough to take the book to roughly 8.2x gross
// leverage, which lands liquidation about 11.8% away.
export const recklessCandidate = {
  symbol: "BTCUSDT",
  side: "LONG",
  qty: 0.175714,
  entryPrice: MARK_PRICE
};

// A thesis both agents happen to agree on, which is exactly the situation the
// Referee exists for. Agreement is not safety.
export const fixtureThesis = {
  confidence: 0.81,
  invalidation: 78_400,
  flowToxicity: 0.31
};

// What this fixture is built to violate, stated up front so the test can prove
// the engine actually produced these breaches rather than the fixture asserting
// them.
export const EXPECTED_BREACHES = [
  "LIQUIDATION_DISTANCE",
  "GROSS_LEVERAGE",
  "NET_DELTA",
  "CONCENTRATION"
];

// ---------------------------------------------------------------------------
// Note on the specification's illustrative numbers.
//
// The APEX specification illustrates this fixture with 3.4x leverage AND an
// 11.8% liquidation distance. Under liq-v1 those two cannot co-occur.
//
// For a cross-margin BTCUSDT long inside the first maintenance bracket
// (0.40% rate, no deduction), distance relates to leverage L as:
//
//     distance = 1 - (1 - 1/L) / (1 - 0.004)
//
// which gives 29.13% at L = 3.4, and requires L = 8.23 to reach 11.8%.
//
// Rather than print a number the engine did not produce, this fixture keeps the
// 11.8% distance, which is the figure the demo turns on, and accepts the
// leverage the arithmetic actually implies. The discrepancy is recorded in
// BINANCE_CAPABILITIES.md.
// ---------------------------------------------------------------------------
export const SPEC_NOTE = {
  spec_illustration: { leverage: 3.4, liquidation_distance_pct: 11.8 },
  engine_reality: { leverage: 8.229, liquidation_distance_pct: 11.8 },
  reason:
    "3.4x and 11.8% are not simultaneously reachable under liq-v1 cross margin; " +
    "3.4x implies 29.13%. The fixture preserves the 11.8% distance."
};
