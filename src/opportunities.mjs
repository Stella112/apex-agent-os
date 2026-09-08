// Opportunity discovery for APEX.
//
// This is deliberately narrower than a generic "yield" screen. APEX can
// verify public Binance funding and market conditions, so the first route it
// can responsibly discover is delta-neutral funding carry: buy spot and short
// the perpetual when positive funding is large enough to compensate for
// estimated costs and market risk. It is an estimate, not promised APY.

const HOURS_PER_FUNDING_PERIOD = 8;
const FUNDING_PERIODS_PER_DAY = 24 / HOURS_PER_FUNDING_PERIOD;
const ROUND_TRIP_FEE_PCT = 0.08;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function fundingCarry(context) {
  const rate = Number(context.fundingRate);
  const basisBps = ((context.markPrice - context.indexPrice) / context.indexPrice) * 10_000;
  const periodsPerDay = 24 / context.fundingIntervalHours;
  const grossAnnualizedPct = rate * periodsPerDay * 365 * 100;
  const gross30dPct = rate * periodsPerDay * 30 * 100;
  const net30dPct = gross30dPct - ROUND_TRIP_FEE_PCT;
  const volatilityPct = Number(context.realizedVolatility) * 100;
  const spreadBps = ((context.bestAsk - context.bestBid) / ((context.bestAsk + context.bestBid) / 2)) * 10_000;

  let status = "STAND_DOWN";
  let reason = "Funding is not positive enough for the long-spot / short-perpetual route.";
  if (rate > 0 && net30dPct > 0 && spreadBps < 12 && context.flowToxicity < 0.75) {
    status = "CANDIDATE";
    reason = "Positive funding covers the indicative round-trip cost; APEX must still check size and margin.";
  } else if (rate > 0) {
    reason = "Funding is positive, but spread, flow toxicity, or indicative cost leaves too little carry.";
  }

  const score = clamp(
    50 + grossAnnualizedPct * 1.5 - Math.max(0, volatilityPct - 50) * 0.35 - spreadBps * 1.2 - context.flowToxicity * 18,
    0,
    100
  );

  return {
    id: `funding-carry-${context.symbol.toLowerCase()}`,
    symbol: context.symbol,
    category: "FUNDING_CARRY",
    title: "Funding carry",
    route: "LONG SPOT · SHORT PERPETUAL",
    status,
    score: round(score, 1),
    reason,
    current_funding_pct: round(rate * 100, 5),
    funding_interval_hours: context.fundingIntervalHours,
    gross_annualized_pct: round(grossAnnualizedPct, 2),
    indicative_30d_net_pct: round(net30dPct, 2),
    estimated_round_trip_cost_pct: ROUND_TRIP_FEE_PCT,
    basis_bps: round(basisBps, 2),
    realized_volatility_pct: round(volatilityPct, 2),
    spread_bps: round(spreadBps, 3),
    flow_toxicity: round(context.flowToxicity, 4),
    next_funding_time: context.nextFundingTime,
    reference_price: context.markPrice,
    caveat: "Indicative carry from the latest funding rate; funding changes every period and this is not guaranteed yield."
  };
}

function momentumWatch(context) {
  const trend = context.sma24 > context.sma168 ? "UP" : "DOWN";
  const distanceFromSmaPct = ((context.markPrice - context.sma24) / context.sma24) * 100;
  const status = Math.abs(distanceFromSmaPct) < 3 && context.flowToxicity < 0.65 ? "WATCH" : "NO_TRADE";
  return {
    id: `momentum-watch-${context.symbol.toLowerCase()}`,
    symbol: context.symbol,
    category: "MOMENTUM_WATCH",
    title: "Trend watch",
    route: `${trend === "UP" ? "LONG" : "SHORT"} · TACTICAL`,
    status,
    score: round(clamp(55 + (50 - context.realizedVolatility * 100) * 0.2 - context.flowToxicity * 20, 0, 100), 1),
    reason:
      status === "WATCH"
        ? "Trend is active without an extreme short-term extension; submit through the adversarial referee before acting."
        : "Conditions are too extended or flow is too one-sided for a fresh tactical entry.",
    trend,
    distance_from_24h_sma_pct: round(distanceFromSmaPct, 2),
    realized_volatility_pct: round(Number(context.realizedVolatility) * 100, 2),
    flow_toxicity: round(context.flowToxicity, 4),
    reference_price: context.markPrice,
    caveat: "This is a watchlist signal, not an order or a guaranteed return."
  };
}

export function discoverOpportunities(contexts) {
  const opportunities = [];
  for (const context of contexts) {
    const numeric = key => typeof context[key] === 'number' && Number.isFinite(context[key]);
    if (!['markPrice','realizedVolatility','flowToxicity'].every(numeric) || context.markPrice <= 0) continue;
    if (['fundingRate','fundingIntervalHours','indexPrice','bestAsk','bestBid'].every(numeric) && context.fundingIntervalHours > 0 && context.indexPrice > 0 && context.bestBid > 0 && context.bestAsk >= context.bestBid) opportunities.push(fundingCarry(context));
    if (['sma24','sma168'].every(numeric) && context.sma24 > 0 && context.sma168 > 0) opportunities.push(momentumWatch(context));
  }
  return opportunities.sort((a, b) => b.score - a.score);
}

export const OPPORTUNITY_CONSTANTS = {
  funding_period_hours: HOURS_PER_FUNDING_PERIOD,
  estimated_round_trip_cost_pct: ROUND_TRIP_FEE_PCT
};
