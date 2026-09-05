// Constitution to Referee policy binding (spec sections 22, 23, 25).
//
// The Referee must never carry its own limits. It reads them from the
// Constitution, and every verdict records which Constitution produced it.

import { loadConstitution, stamp } from "./constitution.mjs";

// Defaults for gates the Constitution does not currently name. Kept explicit
// so it is obvious which limits are policy and which are engine defaults.
export const ENGINE_DEFAULTS = {
  toxicFlowThreshold: 0.7,
  minConfidence: 0.55
};

export function policyFromConstitution(constitution) {
  const { risk } = constitution;
  return {
    minLiquidationDistance: risk.min_liquidation_distance_pct / 100,
    maxRiskPerThesis: risk.max_order_pct / 100,
    maxSymbolConcentration: risk.max_name_pct / 100,
    maxGrossLeverage: risk.max_leverage,
    maxDailyLoss: risk.daily_loss_lock_pct / 100,
    maxNetDeltaBtc: risk.max_net_delta_btc,
    toxicFlowThreshold: ENGINE_DEFAULTS.toxicFlowThreshold,
    minConfidence: ENGINE_DEFAULTS.minConfidence,
    ...stamp(constitution)
  };
}

export function activePolicy(path) {
  return policyFromConstitution(loadConstitution(path));
}
