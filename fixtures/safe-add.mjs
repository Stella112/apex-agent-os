// DEMO FIXTURE — SIMULATION (spec sections 7, 29, 30).
//
// The counterpart to reckless-add.mjs. This proposal is deliberately
// conservative and must clear every Constitution rule, so the acceptance suite
// can prove the Referee is capable of ALLOW and is not simply a rule that
// denies everything.
//
// As with the reckless fixture, nothing here came from a live account.

import { CLASSIFICATION } from "../src/provenance.mjs";
import { createBook } from "../src/portfolio.mjs";

export const FIXTURE_LABEL = "DETERMINISTIC SAFE FIXTURE";
export const EXECUTION_MODE = "SIMULATION";
export const FIXTURE_CLASSIFICATION = CLASSIFICATION.SIMULATION;

export const MARK_PRICE = 80_000;

// A well capitalised, flat book. Nothing is at risk before the proposal.
export function fixtureBook() {
  const book = createBook({ walletBalance: 100_000, positions: [] });
  book.sessionOpeningEquity = 100_000;
  return book;
}

export const fixtureMarks = { BTCUSDT: MARK_PRICE };

// 0.0015 BTC is 120 dollars of notional against 100,000 of equity. That sits
// inside the Constitution's net-delta cap of 0.002 BTC, which is the tightest
// limit in the policy and the one that makes most proposals impossible.
export const safeCandidate = {
  symbol: "BTCUSDT",
  side: "LONG",
  qty: 0.0015,
  entryPrice: MARK_PRICE
};

export const safeThesis = {
  confidence: 0.72,
  invalidation: 78_660,
  flowToxicity: 0.31
};

// Every rule this proposal is expected to clear.
export const EXPECTED_PASSES = [
  "CONFIDENCE_FLOOR",
  "MANDATORY_INVALIDATION",
  "DAILY_LOSS_LOCK",
  "LIQUIDATION_DISTANCE",
  "RISK_BUDGET",
  "CONCENTRATION",
  "GROSS_LEVERAGE",
  "FLOW_TOXICITY",
  "NET_DELTA"
];
