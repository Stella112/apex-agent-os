// The demo desk (spec sections 29, 30, 31).
//
// SIMULATION. This is the starting book APEX reasons about. It is a fixture,
// not a real Binance account, because no Account-scope tool has a verified
// schema. Market data around it is live; this book is not.
//
// It is deliberately policy-compliant at rest, so the Referee has something
// real to decide about. A starting book that already breaches the Constitution
// forces DENY on every proposal and makes the system look broken when it is
// merely refusing correctly.

import { CLASSIFICATION } from "../src/provenance.mjs";
import { createBook } from "../src/portfolio.mjs";

export const EXECUTION_MODE = "SIMULATION";
export const CLASSIFICATION_LABEL = CLASSIFICATION.SIMULATION;

export const WALLET_BALANCE = 50_000;
export const OPENING_QTY = 0.08;
export const OPENING_ENTRY = 80_000;

// A funded desk holding a modest long. Roughly 12.8% name exposure against a
// 15% cap, so there is headroom for a small add and none for a large one.
export function deskBook() {
  const book = createBook({
    walletBalance: WALLET_BALANCE,
    positions: [{ symbol: "BTCUSDT", qty: OPENING_QTY, entryPrice: OPENING_ENTRY }]
  });
  book.sessionOpeningEquity = WALLET_BALANCE;
  return book;
}

// --- The two proposals the demo puts in front of the Referee ---------------

// Small enough to clear every rule. This is the path that reaches a human.
export const MODEST_ADD = {
  id: "modest",
  label: "Modest add",
  description: "0.01 BTC. Sized to sit inside every Constitution limit.",
  symbol: "BTCUSDT",
  side: "LONG",
  qty: 0.01,
  entryPrice: OPENING_ENTRY,
  expect: "APPROVE"
};

// Deliberately reckless. Constructed to breach several rules at once so the
// veto is deterministic and reproducible.
export const RECKLESS_ADD = {
  id: "reckless",
  label: "Reckless add",
  description: "5 BTC. Built to breach leverage, concentration and liquidation distance.",
  symbol: "BTCUSDT",
  side: "LONG",
  qty: 5,
  entryPrice: OPENING_ENTRY,
  expect: "DENY"
};

export const PROPOSALS = { modest: MODEST_ADD, reckless: RECKLESS_ADD };

export const deskMarks = { BTCUSDT: OPENING_ENTRY };

export const deskThesis = {
  confidence: 0.74,
  invalidation: 76_800,
  flowToxicity: 0.28
};
