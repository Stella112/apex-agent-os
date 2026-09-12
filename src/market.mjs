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
const BSTOCKS = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=3";
let fundingSchedulePromise, fundingScheduleUntil = 0;
async function fundingInterval(symbol) {
  if (!fundingSchedulePromise || Date.now() > fundingScheduleUntil) {
    fundingScheduleUntil = Date.now() + 300_000;
    fundingSchedulePromise = getJson(`${FUTURES}/fapi/v1/fundingInfo`).catch(() => { fundingScheduleUntil = 0; return null; });
  }
  const schedules = await fundingSchedulePromise;
  if (!Array.isArray(schedules)) return null;
  return schedules.find(row => row.symbol === symbol)?.fundingIntervalHours ?? 8;
}

const STABLE_PAIRS = new Set(['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'USDPUSDT', 'DAIUSDT', 'USD1USDT']);

// Binance has returned more than one 24h ticker shape over time. In
// particular, some MINI responses omit quoteVolume even though they still
// include base volume and a last/close price. Keep the screening step
// tolerant: this is only a sample selector, not an account or eligibility
// check.
export function tickerLiquidity(ticker) {
  const quoteVolume = Number(ticker?.quoteVolume ?? ticker?.quoteAssetVolume);
  if (Number.isFinite(quoteVolume) && quoteVolume > 0) return quoteVolume;
  const baseVolume = Number(ticker?.volume ?? ticker?.baseVolume);
  const price = Number(ticker?.lastPrice ?? ticker?.close);
  if (Number.isFinite(baseVolume) && baseVolume > 0 && Number.isFinite(price) && price > 0) {
    return baseVolume * price;
  }
  return 0;
}

export function rankTradableTickers(tickers, limit = 24) {
  return (Array.isArray(tickers) ? tickers : [])
    .filter((ticker) => {
      const symbol = String(ticker?.symbol ?? '').toUpperCase();
      return /^[A-Z0-9._-]+USDT$/.test(symbol) && !STABLE_PAIRS.has(symbol);
    })
    .map((ticker, index) => ({ ticker, index, symbol: String(ticker.symbol).toUpperCase(), liquidity: tickerLiquidity(ticker) }))
    .sort((a, b) => b.liquidity - a.liquidity || a.index - b.index)
    .slice(0, limit == null ? undefined : limit)
    .map(({ symbol }) => symbol);
}

// Select liquid USDT spot candidates; detailed reads verify their perpetual.
// This keeps a universe scan useful without launching hundreds of heavyweight
// market reads at once. If Binance omits volume in a MINI response, the
// fallback still returns valid USDT symbols instead of producing an invalid
// empty-symbol request.
export async function fetchTradableSymbols(limit = 24) {
  const tickers = await getJson(`${SPOT}/api/v3/ticker/24hr?type=MINI`);
  return rankTradableTickers(tickers, limit);
}

export function normalizeBstockProducts(payload) {
  if (payload?.code !== "000000" || !Array.isArray(payload.data)) return [];
  return payload.data
    .filter((item) => item?.type === 3 && item.symbol && item.ticker && item.contractAddress)
    .map((item) => ({
      symbol: String(item.symbol),
      ticker: String(item.ticker),
      contractAddress: String(item.contractAddress),
      chainId: String(item.chainId ?? ""),
      quoteSymbol: String(item.cs ?? `${item.symbol}USDT`),
      lastUpdatedAt: item.lastUpdateTime ? new Date(Number(item.lastUpdateTime)).toISOString() : null
    }));
}

export async function fetchBstockProducts() {
  return normalizeBstockProducts(await getJson(BSTOCKS));
}

export async function fetchBinanceUniverse() {
  const [spot, futures] = await Promise.all([
    getJson(`${SPOT}/api/v3/ticker/24hr?type=MINI`),
    getJson(`${FUTURES}/fapi/v1/ticker/24hr`).catch(() => [])
  ]);
  const markets = [];
  const quoteAssets = ["USDT", "USDC", "FDUSD", "BUSD", "BTC", "ETH", "BNB", "TRY", "EUR", "BRL", "AUD"];
  const assetParts = (symbol) => {
    const quote = quoteAssets.find((candidate) => symbol.endsWith(candidate));
    return { baseAsset: quote ? symbol.slice(0, -quote.length) : symbol, quoteAsset: quote ?? "UNKNOWN" };
  };
  for (const item of spot ?? []) {
    if (!item.symbol) continue;
    markets.push({ symbol: item.symbol, market: "SPOT", ...assetParts(item.symbol) });
  }
  for (const item of futures ?? []) {
    if (!item.symbol) continue;
    markets.push({ symbol: item.symbol, market: "USDⓈ-M FUTURES", ...assetParts(item.symbol) });
  }
  return [...new Map(markets.map((item) => [`${item.market}:${item.symbol}`, item])).values()];
}

async function getJson(url, { timeoutMs = 6000, attempts = 1 } = {}) {
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
  if (!Number.isFinite(total) || total <= 0) return null;
  return (bids - asks) / total;
}

// Realized volatility from close-to-close log returns, annualized off the
// candle interval. Used as a sizing input, never as a signal on its own.
export function realizedVolatility(klines, periodsPerYear) {
  const closes = klines.map((k) => Number(k[4]));
  if (closes.length < 3 || closes.some(v => !Number.isFinite(v) || v <= 0)) return null;
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
  if (!trades.length) return null;
  let buyVolume = 0;
  let sellVolume = 0;
  for (const trade of trades) {
    const qty = Number(trade.qty);
    // isBuyerMaker true means the aggressor was a seller.
    if (trade.isBuyerMaker) sellVolume += qty;
    else buyVolume += qty;
  }
  const total = buyVolume + sellVolume;
  if (!Number.isFinite(total) || total <= 0) return null;
  // Imbalance of aggressor flow, mapped to [0, 1]. A one-sided tape is toxic
  // to the resting side and is the condition worth sizing down into.
  return Math.abs(buyVolume - sellVolume) / total;
}

export async function fetchMarketContext(symbol = "BTCUSDT") {
  const [ticker, premium, depth, rawKlines, trades, openInterest, fundingIntervalHours] = await Promise.all([
    getJson(`${SPOT}/api/v3/ticker/24hr?symbol=${symbol}`),
    getJson(`${FUTURES}/fapi/v1/premiumIndex?symbol=${symbol}`),
    getJson(`${SPOT}/api/v3/depth?symbol=${symbol}&limit=100`),
    getJson(`${SPOT}/api/v3/klines?symbol=${symbol}&interval=1h&limit=169`),
    getJson(`${SPOT}/api/v3/trades?symbol=${symbol}&limit=500`),
    getJson(`${FUTURES}/fapi/v1/openInterest?symbol=${symbol}`, { attempts: 2 }).catch(() => null),
    fundingInterval(symbol)
  ]);
  if (ticker.symbol !== symbol || premium.symbol !== symbol || (openInterest && openInterest.symbol !== symbol)) throw new Error("Market instrument mismatch");
  if (!Array.isArray(rawKlines) || !Array.isArray(trades) || !depth.bids?.length || !depth.asks?.length) throw new Error("Incomplete market response");
  const now = Date.now();
  const klines = rawKlines.filter(k => Number(k[6]) <= now);
  if (klines.some((k,i) => i && Number(k[0]) - Number(klines[i-1][0]) !== 3_600_000)) throw new Error("Candle sequence is duplicate or incomplete");
  if (trades.some(t => !Number.isFinite(Number(t.qty)) || Number(t.qty) <= 0 || typeof t.isBuyerMaker !== "boolean")) throw new Error("Invalid trade sample");

  const markPrice = Number(premium.markPrice);
  const lastPrice = Number(ticker.lastPrice);
  const fundingRate = Number(premium.lastFundingRate);
  if (![markPrice, lastPrice, Number(premium.indexPrice)].every(v => Number.isFinite(v) && v > 0) || !Number.isFinite(fundingRate)) throw new Error("Invalid market prices or funding");

  const closes = klines.map((k) => Number(k[4]));
  const highs = klines.map((k) => Number(k[2]));
  const lows = klines.map((k) => Number(k[3]));

  const range24h = {
    high: Math.max(...highs.slice(-24)),
    low: Math.min(...lows.slice(-24))
  };
  const range7d = { high: Math.max(...highs), low: Math.min(...lows) };

  const sma = (n) => closes.length < n ? null : closes.slice(-n).reduce((a, b) => a + b, 0) / n;

  return {
    symbol,
    fetchedAt: new Date().toISOString(),
    source: "binance-public-rest",
    lastPrice,
    markPrice,
    indexPrice: Number(premium.indexPrice),
    priceChangePercent: Number(ticker.priceChangePercent),
    volume24h: tickerLiquidity(ticker),
    fundingRate,
    fundingIntervalHours,
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

// Read a bounded number of symbols at a time. A 24-symbol scan fans out to
// several Binance endpoints per symbol; Promise.all over the full list can
// trigger transient rate limits or serverless timeouts.
export async function fetchMarketContexts(symbols, concurrency = 4) {
  const reads = Array(symbols.length);
  let next = 0;
  const worker = async () => {
    while (next < symbols.length) {
      const index = next++;
      const symbol = symbols[index];
      try {
        reads[index] = { symbol, context: await fetchMarketContext(symbol) };
      } catch (error) {
        reads[index] = { symbol, error: error.message };
      }
    }
  };
  const workerCount = Math.min(Math.max(1, concurrency), symbols.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return reads;
}
