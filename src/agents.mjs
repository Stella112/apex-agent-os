// Bull and Bear (spec sections 16, 17), and the debate router (section 20).
//
// Both agents receive the identical Quant packet and must cite evidence keys
// from it. They are implemented as deterministic reasoners behind a
// ModelProvider seam, for two reasons: the demo then runs with no API key, and
// a judge can reproduce every argument exactly. Swapping in a language model is
// a change to this file only, and the evidence validator applies either way.

import { readEvidence } from "./quant.mjs";

// Read a value only if the packet genuinely carries one. Returns null rather
// than a default, so an agent cannot argue from an absent measurement.
function val(packet, key) {
  const field = readEvidence(packet, key);
  return field && field.value !== null ? field.value : null;
}

// ---------------------------------------------------------------------------
// Bull: the strongest defensible case for OPEN / ADD / HOLD / INCREASE.
// ---------------------------------------------------------------------------
export const bullProvider = {
  name: "deterministic-bull",
  version: "1.0.0",
  async propose({ packet }) {
    const claims = [];
    let score = 0;

    const funding = val(packet, "funding.current");
    if (funding !== null && funding < 0) {
      claims.push({
        claim: "Funding is negative, so shorts are paying to hold the position",
        evidence_keys: ["funding.current"]
      });
      score += 0.18;
    } else if (funding !== null && funding < 0.0001) {
      claims.push({
        claim: "Funding is close to flat, so carry is not working against a long",
        evidence_keys: ["funding.current"]
      });
      score += 0.08;
    }

    const imbalance = val(packet, "market.order_book_imbalance");
    if (imbalance !== null && imbalance > 0.05) {
      claims.push({
        claim: "The visible order book is bid-heavy",
        evidence_keys: ["market.order_book_imbalance", "price.bid", "price.ask"]
      });
      score += 0.16;
    }

    const sma24 = val(packet, "market.sma_24");
    const sma168 = val(packet, "market.sma_168");
    const mark = val(packet, "price.mark");
    if (mark !== null && sma24 !== null && sma168 !== null && mark > sma24 && sma24 > sma168) {
      claims.push({
        claim: "Price sits above both the short and long moving averages",
        evidence_keys: ["price.mark", "market.sma_24", "market.sma_168"]
      });
      score += 0.2;
    }

    const spreadBps = val(packet, "price.spread_bps");
    if (spreadBps !== null && spreadBps < 2) {
      claims.push({
        claim: "The spread is tight, so entry cost is low",
        evidence_keys: ["price.spread_bps"]
      });
      score += 0.08;
    }

    const low7d = val(packet, "market.range_7d_low");
    if (mark !== null && low7d !== null && mark > low7d * 1.02) {
      claims.push({
        claim: "Price is holding well above the weekly low",
        evidence_keys: ["price.mark", "market.range_7d_low"]
      });
      score += 0.1;
    }

    if (claims.length === 0) {
      // No supportable bullish case. Saying so is the honest output.
      return {
        decision: "STAND_DOWN",
        confidence: 0.5,
        claims: [
          {
            claim: "No measurement in the packet supports adding exposure",
            evidence_keys: ["price.mark"]
          }
        ]
      };
    }

    return {
      decision: score >= 0.3 ? "ADD" : "HOLD",
      confidence: Math.min(0.95, 0.5 + score),
      claims
    };
  }
};

// ---------------------------------------------------------------------------
// Bear: the strongest defensible case for REDUCE / EXIT / HEDGE / STAND DOWN.
// ---------------------------------------------------------------------------
export const bearProvider = {
  name: "deterministic-bear",
  version: "1.0.0",
  async propose({ packet }) {
    const claims = [];
    let score = 0;

    const leverage = val(packet, "portfolio.leverage");
    if (leverage !== null && leverage > 1) {
      claims.push({
        claim: "The book already carries leverage, so an add compounds existing risk",
        evidence_keys: ["portfolio.leverage", "portfolio.gross_notional", "portfolio.equity"]
      });
      score += 0.2;
    }

    const distance = val(packet, "portfolio.liquidation_distance_pct");
    if (distance !== null && distance < 25) {
      claims.push({
        claim: "Liquidation already sits within a quarter of the current price",
        evidence_keys: ["portfolio.liquidation_distance_pct", "portfolio.liquidation_price"]
      });
      score += 0.25;
    }

    const exposure = val(packet, "portfolio.name_exposure_pct");
    if (exposure !== null && exposure > 10) {
      claims.push({
        claim: "Exposure is concentrated in a single name",
        evidence_keys: ["portfolio.name_exposure_pct", "portfolio.name_notional"]
      });
      score += 0.15;
    }

    const vol = val(packet, "market.realized_volatility");
    if (vol !== null && vol > 0.3) {
      claims.push({
        claim: "Realized volatility is elevated, widening the range of outcomes",
        evidence_keys: ["market.realized_volatility"]
      });
      score += 0.14;
    }

    const toxicity = val(packet, "market.flow_toxicity");
    if (toxicity !== null && toxicity > 0.5) {
      claims.push({
        claim: "Recent tape is one-sided, which is hostile to a resting order",
        evidence_keys: ["market.flow_toxicity"]
      });
      score += 0.12;
    }

    const change = val(packet, "market.price_change_pct_24h");
    if (change !== null && change < -1) {
      claims.push({
        claim: "Price is down over the last day, so momentum is not supportive",
        evidence_keys: ["market.price_change_pct_24h"]
      });
      score += 0.12;
    }

    const freshness = packet.worst_freshness;
    if (freshness === "STALE" || freshness === "EXPIRED" || freshness === "UNAVAILABLE") {
      claims.push({
        claim: "Part of the evidence is no longer fresh, so conclusions are weakly grounded",
        evidence_keys: ["price.mark"]
      });
      score += 0.2;
    }

    if (claims.length === 0) {
      return {
        decision: "HOLD",
        confidence: 0.5,
        claims: [
          {
            claim: "No measurement in the packet indicates elevated risk",
            evidence_keys: ["price.mark"]
          }
        ]
      };
    }

    return {
      decision: score >= 0.35 ? "STAND_DOWN" : "REDUCE",
      confidence: Math.min(0.95, 0.5 + score),
      claims
    };
  }
};

// ---------------------------------------------------------------------------
// Debate router (spec section 20).
// ---------------------------------------------------------------------------
export const DISAGREEMENT = {
  MINOR: "MINOR",
  CONFIDENCE: "CONFIDENCE",
  DIRECTIONAL: "DIRECTIONAL",
  STRATEGY: "STRATEGY",
  RISK: "RISK",
  DATA_UNCERTAINTY: "DATA_UNCERTAINTY"
};

const RISK_INCREASING = new Set(["OPEN", "ADD", "INCREASE"]);
const RISK_REDUCING = new Set(["REDUCE", "EXIT", "HEDGE", "STAND_DOWN"]);

export function routeDebate({ bull, bear, packet }) {
  // Evidence quality outranks any disagreement about direction.
  const freshness = packet?.worst_freshness;
  if (freshness === "STALE" || freshness === "EXPIRED" || freshness === "UNAVAILABLE") {
    return {
      classification: DISAGREEMENT.DATA_UNCERTAINTY,
      material: true,
      detail: `evidence freshness is ${freshness}; no new risk may be opened on it`
    };
  }

  if (!bull?.valid || !bear?.valid) {
    return {
      classification: DISAGREEMENT.DATA_UNCERTAINTY,
      material: true,
      detail: "at least one agent produced no supportable claim"
    };
  }

  const bullIncreases = RISK_INCREASING.has(bull.decision);
  const bearReduces = RISK_REDUCING.has(bear.decision);

  if (bullIncreases && bearReduces) {
    return {
      classification: DISAGREEMENT.DIRECTIONAL,
      material: true,
      detail: `Bull wants ${bull.decision} while Bear wants ${bear.decision}`
    };
  }

  // Agreement on direction, but Bear has flagged a risk claim. This is the case
  // the Referee exists for: two agents can agree and still be wrong.
  if (bullIncreases && !bearReduces) {
    const flagsRisk = bear.claims.some((c) =>
      c.evidence_keys.some((k) => k.startsWith("portfolio."))
    );
    if (flagsRisk) {
      return {
        classification: DISAGREEMENT.RISK,
        material: true,
        detail: "both agents accept the direction, but Bear cites portfolio risk"
      };
    }
  }

  if (bull.decision !== bear.decision) {
    return {
      classification: DISAGREEMENT.STRATEGY,
      material: true,
      detail: `different actions proposed: ${bull.decision} against ${bear.decision}`
    };
  }

  const gap = Math.abs(bull.confidence - bear.confidence);
  if (gap > 0.25) {
    return {
      classification: DISAGREEMENT.CONFIDENCE,
      material: false,
      detail: `same action, confidence differs by ${(gap * 100).toFixed(1)} points`
    };
  }

  return { classification: DISAGREEMENT.MINOR, material: false, detail: "agents substantially agree" };
}
