// Provenance envelope (spec sections 9, 12, 13).
//
// Every value that crosses a module boundary in APEX is wrapped. The wrapper
// carries where the value came from, when it was observed, and how much it can
// be trusted now. Downstream code is not permitted to see a bare number,
// because a bare number cannot be distinguished from a guess.

export const CLASSIFICATION = {
  BINANCE_REPORTED: "BINANCE_REPORTED",
  APEX_ESTIMATE: "APEX_ESTIMATE",
  SIMULATION: "SIMULATION",
  UNAVAILABLE: "UNAVAILABLE"
};

export const FRESHNESS = {
  FRESH: "FRESH",
  AGING: "AGING",
  STALE: "STALE",
  EXPIRED: "EXPIRED",
  UNAVAILABLE: "UNAVAILABLE"
};

export const STATUS = {
  AVAILABLE: "AVAILABLE",
  UNAVAILABLE: "UNAVAILABLE",
  INVALID_CONTEXT: "INVALID_LIQUIDATION_CONTEXT"
};

// Freshness thresholds in milliseconds. Configuration-driven per spec 12.
export const DEFAULT_FRESHNESS_THRESHOLDS = {
  freshMs: 2_000,
  agingMs: 10_000,
  staleMs: 60_000
};

// Small negative ages come from ordinary clock skew between this machine and
// the exchange and are treated as zero. A large negative age means the
// timestamp is wrong, which is reported rather than smoothed over.
export const MAX_TOLERATED_SKEW_MS = 5_000;

export function classifyFreshness(ageMs, thresholds = DEFAULT_FRESHNESS_THRESHOLDS) {
  if (!Number.isFinite(ageMs)) return FRESHNESS.UNAVAILABLE;
  if (ageMs < 0) {
    if (ageMs >= -MAX_TOLERATED_SKEW_MS) return FRESHNESS.FRESH;
    return FRESHNESS.UNAVAILABLE;
  }
  if (ageMs <= thresholds.freshMs) return FRESHNESS.FRESH;
  if (ageMs <= thresholds.agingMs) return FRESHNESS.AGING;
  if (ageMs <= thresholds.staleMs) return FRESHNESS.STALE;
  return FRESHNESS.EXPIRED;
}

// Wrap an observed value. `observedAt` is an ISO string or epoch ms.
export function observed({
  value,
  source,
  classification,
  observedAt,
  now = Date.now(),
  thresholds = DEFAULT_FRESHNESS_THRESHOLDS,
  ...extra
}) {
  if (value === null || value === undefined) {
    return unavailable({ source, reason: extra.reason ?? "no value supplied" });
  }
  const observedMs = typeof observedAt === "number" ? observedAt : Date.parse(observedAt);
  const ageMs = now - observedMs;
  return {
    value,
    source,
    classification,
    timestamp: new Date(observedMs).toISOString(),
    age_ms: ageMs,
    freshness: classifyFreshness(ageMs, thresholds),
    status: STATUS.AVAILABLE,
    ...extra
  };
}

// The explicit absence of a value. Never substitute zero (spec section 13).
export function unavailable({ source = null, reason = "unavailable" } = {}) {
  return {
    value: null,
    source,
    classification: CLASSIFICATION.UNAVAILABLE,
    timestamp: null,
    age_ms: null,
    freshness: FRESHNESS.UNAVAILABLE,
    status: STATUS.UNAVAILABLE,
    reason
  };
}

export function invalidContext({ source = null, reason }) {
  return {
    value: null,
    source,
    classification: CLASSIFICATION.UNAVAILABLE,
    timestamp: null,
    age_ms: null,
    freshness: FRESHNESS.UNAVAILABLE,
    status: STATUS.INVALID_CONTEXT,
    reason
  };
}

export function isUsable(field) {
  return Boolean(field) && field.status === STATUS.AVAILABLE && field.value !== null;
}

// A field is safe to open new risk against only when it is present and has not
// gone stale. Spec section 27 requires this to fail closed.
export function isFreshEnoughForNewRisk(field) {
  return (
    isUsable(field) &&
    (field.freshness === FRESHNESS.FRESH || field.freshness === FRESHNESS.AGING)
  );
}

// Reduce many fields to the worst freshness among those that actually carry a
// value, so a packet can be judged as a whole.
//
// Absent fields are deliberately excluded. Absence and staleness are different
// failures and must not be conflated: a book with no liquidation exposure has
// no liquidation price, which is the safest possible state, not degraded data.
// Callers that require a specific field must check that field, which is what
// `missingKeys` is for.
export function worstFreshness(fields) {
  const order = [FRESHNESS.FRESH, FRESHNESS.AGING, FRESHNESS.STALE, FRESHNESS.EXPIRED];
  let worst = null;
  for (const field of fields) {
    if (!field || field.value === null) continue;
    const current = field.freshness;
    const rank = order.indexOf(current);
    if (rank === -1) continue;
    if (worst === null || rank > order.indexOf(worst)) worst = current;
  }
  // A packet in which nothing at all is present is genuinely unavailable.
  return worst ?? FRESHNESS.UNAVAILABLE;
}

// The keys whose values are absent, so a caller can fail closed on the ones it
// actually needs rather than on any absence anywhere.
export function missingKeys(evidence) {
  return Object.entries(evidence)
    .filter(([, field]) => !field || field.value === null)
    .map(([key]) => key);
}
