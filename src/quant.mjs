// Quant Engine (spec sections 14, 15).
//
// Converts verified market data and the current book into deterministic,
// individually addressable measurements. Every entry is a provenance field, and
// the key it is filed under is the evidence key an agent must cite to use it.
//
// Nothing here reasons. It measures.

import {
  CLASSIFICATION,
  missingKeys,
  observed,
  unavailable,
  worstFreshness
} from "./provenance.mjs";
import { equity, grossNotional, notionalOf } from "./portfolio.mjs";
import { liquidationDistancePct, resolveLiquidation } from "./liquidation.mjs";

// Formula documentation (spec section 15). Kept beside the code so the
// dashboard can show a reader the arithmetic behind any number.
export const FORMULAS = {
  "price.mid": "mid = (bid + ask) / 2",
  "price.spread": "spread = ask - bid",
  "price.spread_bps": "spread_bps = ((ask - bid) / mid) * 10000",
  "price.microprice":
    "microprice = (bid * ask_size + ask * bid_size) / (bid_size + ask_size)",
  "market.basis_bps": "basis_bps = ((mark - index) / index) * 10000",
  "portfolio.equity": "equity = wallet_balance + sum(qty_i * (mark_i - entry_i))",
  "portfolio.gross_notional": "gross_notional = sum(abs(qty_i) * mark_i)",
  "portfolio.leverage": "leverage = gross_notional / equity",
  "portfolio.net_delta_btc": "net_delta_btc = sum(qty_i) over BTC-denominated symbols",
  "portfolio.name_exposure_pct": "name_exposure_pct = abs(name_notional) / equity * 100",
  "portfolio.liquidation_distance_pct":
    "long: ((mark - liq) / mark) * 100; short: ((liq - mark) / mark) * 100"
};

const BINANCE = CLASSIFICATION.BINANCE_REPORTED;
const ESTIMATE = CLASSIFICATION.APEX_ESTIMATE;

// Build the evidence packet.
//
// `context` is a raw market read from the market adapter. `book` and `marks`
// describe the current position. `classification` lets a replayed fixture mark
// everything SIMULATION without any other change.
export function buildQuantPacket({
  context,
  book,
  marks,
  symbol = "BTCUSDT",
  now = Date.now(),
  thresholds,
  classification = BINANCE
}) {
  const evidence = {};

  const at = (value, cls = classification, extra = {}) =>
    observed({
      value,
      source: classification === CLASSIFICATION.SIMULATION ? "SIMULATOR" : "binance",
      classification: cls,
      observedAt: context?.fetchedAt ?? now,
      now,
      thresholds,
      ...extra
    });

  // Anything derived by APEX from exchange data is an estimate, not a reading.
  const derived = (value, formulaKey) =>
    observed({
      value,
      source: "apex",
      classification: classification === CLASSIFICATION.SIMULATION ? classification : ESTIMATE,
      observedAt: context?.fetchedAt ?? now,
      now,
      thresholds,
      formula: FORMULAS[formulaKey]
    });

  if (!context) {
    // Fail closed. An absent market read produces an explicitly empty packet,
    // never a packet of zeroes.
    return {
      symbol,
      generated_at: new Date(now).toISOString(),
      evidence: {},
      available: false,
      reason: "market context unavailable",
      worst_freshness: "UNAVAILABLE",
      missing_keys: []
    };
  }

  // --- Price ---------------------------------------------------------------
  evidence["price.last"] = at(context.lastPrice);
  evidence["price.mark"] = at(context.markPrice);
  evidence["price.index"] = at(context.indexPrice);
  evidence["price.bid"] = at(context.bestBid);
  evidence["price.ask"] = at(context.bestAsk);

  const bid = context.bestBid;
  const ask = context.bestAsk;
  const mid = (bid + ask) / 2;
  evidence["price.mid"] = derived(mid, "price.mid");
  evidence["price.spread"] = derived(ask - bid, "price.spread");
  evidence["price.spread_bps"] = derived(((ask - bid) / mid) * 10_000, "price.spread_bps");

  // --- Market --------------------------------------------------------------
  evidence["funding.current"] = at(context.fundingRate);
  evidence["market.next_funding_time"] = at(context.nextFundingTime);
  evidence["market.open_interest"] =
    context.openInterest === null ? unavailable({ source: "binance" }) : at(context.openInterest);
  evidence["market.volume_24h"] = at(context.volume24h);
  evidence["market.price_change_pct_24h"] = at(context.priceChangePercent);
  evidence["market.range_24h_high"] = at(context.range24h.high);
  evidence["market.range_24h_low"] = at(context.range24h.low);
  evidence["market.range_7d_high"] = at(context.range7d.high);
  evidence["market.range_7d_low"] = at(context.range7d.low);
  evidence["market.basis_bps"] = derived(
    ((context.markPrice - context.indexPrice) / context.indexPrice) * 10_000,
    "market.basis_bps"
  );
  evidence["market.realized_volatility"] = derived(
    context.realizedVolatility,
    "market.realized_volatility"
  );
  evidence["market.order_book_imbalance"] = derived(
    context.orderBookImbalance,
    "market.order_book_imbalance"
  );
  evidence["market.flow_toxicity"] = derived(context.flowToxicity, "market.flow_toxicity");
  evidence["market.sma_24"] = derived(context.sma24, "market.sma_24");
  evidence["market.sma_168"] = derived(context.sma168, "market.sma_168");

  // --- Portfolio -----------------------------------------------------------
  if (book && marks) {
    const eq = equity(book, marks);
    const gross = grossNotional(book, marks);
    evidence["portfolio.wallet_balance"] = derived(book.walletBalance, "portfolio.equity");
    evidence["portfolio.equity"] = derived(eq, "portfolio.equity");
    evidence["portfolio.gross_notional"] = derived(gross, "portfolio.gross_notional");
    evidence["portfolio.leverage"] = derived(
      eq > 0 ? gross / eq : Infinity,
      "portfolio.leverage"
    );

    const netDelta = book.positions
      .filter((p) => p.symbol.startsWith("BTC"))
      .reduce((total, p) => total + p.qty, 0);
    evidence["portfolio.net_delta_btc"] = derived(netDelta, "portfolio.net_delta_btc");

    const position = book.positions.find((p) => p.symbol === symbol);
    if (position) {
      const nameNotional = notionalOf(position, marks[symbol] ?? position.entryPrice);
      evidence["portfolio.name_notional"] = derived(nameNotional, "portfolio.name_exposure_pct");
      evidence["portfolio.name_exposure_pct"] = derived(
        eq > 0 ? (nameNotional / eq) * 100 : Infinity,
        "portfolio.name_exposure_pct"
      );
      evidence["portfolio.position_qty"] = derived(position.qty, "portfolio.net_delta_btc");
      evidence["portfolio.entry_price"] = derived(position.entryPrice, "portfolio.equity");

      const liquidation = resolveLiquidation({ book, marks, symbol, now, thresholds });
      evidence["portfolio.liquidation_price"] = liquidation;
      evidence["portfolio.liquidation_distance_pct"] = liquidationDistancePct({
        liquidation,
        markPrice: evidence["price.mark"],
        side: position.qty >= 0 ? "LONG" : "SHORT",
        now,
        thresholds
      });
    } else {
      evidence["portfolio.name_notional"] = derived(0, "portfolio.name_exposure_pct");
      evidence["portfolio.name_exposure_pct"] = derived(0, "portfolio.name_exposure_pct");
      evidence["portfolio.liquidation_price"] = unavailable({
        source: "apex",
        reason: `no position held in ${symbol}`
      });
      evidence["portfolio.liquidation_distance_pct"] = unavailable({
        source: "apex",
        reason: `no position held in ${symbol}`
      });
    }
  }

  return {
    symbol,
    generated_at: new Date(now).toISOString(),
    evidence,
    available: true,
    worst_freshness: worstFreshness(Object.values(evidence)),
    missing_keys: missingKeys(evidence)
  };
}

// The keys an agent is permitted to cite. Anything outside this set is an
// unsupported claim (spec section 18).
export function evidenceKeys(packet) {
  return Object.keys(packet.evidence);
}

export function readEvidence(packet, key) {
  return packet.evidence[key] ?? null;
}
