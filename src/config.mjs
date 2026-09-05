// Risk policy. These are enforced in code by the Referee, never in prompt text.
// Every limit here is a hard gate: a thesis that violates one cannot reach execution.

export const POLICY = {
  // Minimum acceptable distance from the post-fill liquidation price, as a
  // fraction of mark price. A candidate that lands the book closer than this
  // is denied outright.
  minLiquidationDistance: 0.15,

  // Maximum fraction of account equity that may be at risk on a single thesis,
  // measured as (entry -> invalidation) loss on the proposed size.
  maxRiskPerThesis: 0.02,

  // Maximum fraction of equity a single symbol may represent as notional
  // exposure after the fill.
  maxSymbolConcentration: 0.35,

  // Maximum total notional as a multiple of equity after the fill.
  maxGrossLeverage: 3.0,

  // Session drawdown ceiling. Once realized+unrealized session PnL breaches
  // this fraction of the session opening equity, the book is locked to
  // risk-reducing actions only.
  maxDailyLoss: 0.05,

  // Flow toxicity is a soft input, not a headline. Above this score the
  // Referee resizes rather than denies.
  toxicFlowThreshold: 0.70,

  // Minimum confidence for a thesis to be considered at all.
  minConfidence: 0.55
};

// Binance USDS-M futures maintenance margin brackets.
// Source: published leverage & margin tiers. The live per-account table is
// behind an authenticated endpoint (/fapi/v1/leverageBracket), so this static
// table is used and is accurate for standard accounts.
const BTC_TIERS = [
  { cap: 50_000,      mmr: 0.0040, deduction: 0 },
  { cap: 500_000,     mmr: 0.0050, deduction: 50 },
  { cap: 1_000_000,   mmr: 0.0100, deduction: 2_550 },
  { cap: 10_000_000,  mmr: 0.0250, deduction: 17_550 },
  { cap: 20_000_000,  mmr: 0.0500, deduction: 267_550 },
  { cap: 50_000_000,  mmr: 0.1000, deduction: 1_267_550 },
  { cap: 100_000_000, mmr: 0.1250, deduction: 2_517_550 },
  { cap: 200_000_000, mmr: 0.1500, deduction: 5_017_550 },
  { cap: 300_000_000, mmr: 0.2500, deduction: 25_017_550 },
  { cap: 500_000_000, mmr: 0.5000, deduction: 100_017_550 }
];

const ALT_TIERS = [
  { cap: 10_000,     mmr: 0.0050, deduction: 0 },
  { cap: 100_000,    mmr: 0.0065, deduction: 15 },
  { cap: 500_000,    mmr: 0.0100, deduction: 365 },
  { cap: 1_000_000,  mmr: 0.0200, deduction: 5_365 },
  { cap: 5_000_000,  mmr: 0.0500, deduction: 35_365 },
  { cap: 10_000_000, mmr: 0.1000, deduction: 285_365 },
  { cap: 20_000_000, mmr: 0.1250, deduction: 535_365 },
  { cap: 50_000_000, mmr: 0.5000, deduction: 8_035_365 }
];

const TIER_TABLE = { BTCUSDT: BTC_TIERS, ETHUSDT: BTC_TIERS };

export function tiersFor(symbol) {
  return TIER_TABLE[symbol] || ALT_TIERS;
}

// Returns { mmr, deduction } for a given notional on a given symbol.
export function maintenanceTier(symbol, notional) {
  const tiers = tiersFor(symbol);
  for (const tier of tiers) {
    if (notional <= tier.cap) return tier;
  }
  return tiers[tiers.length - 1];
}

// Maintenance margin required to hold `notional` of `symbol`.
export function maintenanceMargin(symbol, notional) {
  const { mmr, deduction } = maintenanceTier(symbol, notional);
  return Math.max(0, notional * mmr - deduction);
}
