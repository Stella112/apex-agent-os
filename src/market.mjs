// MarketContextAdapter.
//
// Reads live Binance market data. Every endpoint used here is public and
// unauthenticated, which is deliberate: the market layer is genuinely live in
// the demo without any credential ever touching this machine.
//
// When the Binance MCP server is connected, these same shapes are produced by
// the market-data scope of that server. The adapter boundary exists so the
// swap is a one-file change.

import { getJsonViaResolver } from "./resolver.mjs";

const SPOT = "https://api.binance.com";
const FUTURES = "https://fapi.binance.com";

async function getJson(url, { timeoutMs = 15000, attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Resolved through APEX's own resolver, because the system resolver on
      // this machine refuses Binance hostnames. See src/resolver.mjs.
      return await getJsonViaResolver(url, { timeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }
  throw new Error(`market data fetch failed for ${url}: ${lastError?.message ?? "unknown"}`);
}

// Order-book imbalance across the top `depth` levels.
// Returns a value in [-1, 1]: positive means bid-heavy, negative ask-heavy.
export function orderBookImbalance(book, depth = 20) {
  const sum = (side) =>
    side.slice(0, depth).reduce((total, [price, qty]) => total + Number(price) * Number(qty), 0);
  const bids = sum(book.bids);
  const asks = sum(book.asks);
  const total = bids + asks;
  if (total === 0) return 0;
  return (bids - asks) / total;
}

// Realized volatility from close-to-close log returns, annualized off the
// candle interval. Used as a sizing input, never as a signal on its own.
export function realizedVolatility(klines, periodsPerYear) {
  const closes = klines.map((k) => Number(k[4]));
  if (closes.length < 3) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((total, r) => total + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

// A crude, honest proxy for order-flow toxicity: the share of recent volume
// that traded through the passive side, bucketed. This is one input among
// several and is never the headline of a thesis.
export function flowToxicity(trades) {
  if (!trades.length) return 0;
  let buyVolume = 0;
  let sellVolume = 0;
  for (const trade of trades) {
    const qty = Number(trade.qty);
    // isBuyerMaker true means the aggressor was a seller.
    if (trade.isBuyerMaker) sellVolume += qty;
    else buyVolume += qty;
  }
  const total = buyVolume + sellVolume;
  if (total === 0) return 0;
  // Imbalance of aggressor flow, mapped to [0, 1]. A one-sided tape is toxic
  // to the resting side and is the condition worth sizing down into.
  return Math.abs(buyVolume - sellVolume) / total;
}

export async function fetchMarketContext(symbol = "BTCUSDT") {
  const [ticker, premium, depth, klines, trades, openInterest] = await Promise.all([
    getJson(`${SPOT}/api/v3/ticker/24hr?symbol=${symbol}`),
    getJson(`${FUTURES}/fapi/v1/premiumIndex?symbol=${symbol}`),
    getJson(`${SPOT}/api/v3/depth?symbol=${symbol}&limit=100`),
    getJson(`${SPOT}/api/v3/klines?symbol=${symbol}&interval=1h&limit=168`),
    getJson(`${SPOT}/api/v3/trades?symbol=${symbol}&limit=500`),
    getJson(`${FUTURES}/fapi/v1/openInterest?symbol=${symbol}`, { attempts: 2 }).catch(() => null)
  ]);

  const markPrice = Number(premium.markPrice);
  const lastPrice = Number(ticker.lastPrice);
  const fundingRate = Number(premium.lastFundingRate);

  const closes = klines.map((k) => Number(k[4]));
  const highs = klines.map((k) => Number(k[2]));
  const lows = klines.map((k) => Number(k[3]));

  const range24h = {
    high: Math.max(...highs.slice(-24)),
    low: Math.min(...lows.slice(-24))
  };
  const range7d = { high: Math.max(...highs), low: Math.min(...lows) };

  const sma = (n) => closes.slice(-n).reduce((a, b) => a + b, 0) / n;

  return {
    symbol,
    fetchedAt: new Date().toISOString(),
    source: "binance-public-rest",
    lastPrice,
    markPrice,
    indexPrice: Number(premium.indexPrice),
    priceChangePercent: Number(ticker.priceChangePercent),
    volume24h: Number(ticker.quoteVolume),
    fundingRate,
    nextFundingTime: premium.nextFundingTime,
    openInterest: openInterest ? Number(openInterest.openInterest) : null,
    orderBookImbalance: orderBookImbalance(depth),
    bestBid: Number(depth.bids[0][0]),
    bestAsk: Number(depth.asks[0][0]),
    realizedVolatility: realizedVolatility(klines, 24 * 365),
    flowToxicity: flowToxicity(trades),
    sma24: sma(24),
    sma168: sma(168),
    range24h,
    range7d
  };
}
