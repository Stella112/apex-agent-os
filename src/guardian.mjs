// APEX Guardian: deterministic preflight checks between the Referee and any
// account action. Guardian never overrides the Constitution Referee; it adds
// execution-specific checks and fails closed when account authority is absent.

const TERMINAL = new Set(["PASS", "BLOCK", "REVIEW"]);

function check(id, status, detail, observed = null, limit = null) {
  if (!TERMINAL.has(status)) throw new Error(`Invalid Guardian status: ${status}`);
  return { id, status, detail, observed, limit };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function runGuardianPreflight({
  candidate,
  book,
  packet,
  verdict,
  constitution,
  execution = {},
  pendingOrder = false
} = {}) {
  const evidence = packet?.evidence ?? {};
  const mark = evidence["price.mark"]?.value;
  const bid = evidence["price.bid"]?.value;
  const ask = evidence["price.ask"]?.value;
  const checks = [];

  checks.push(
    candidate && typeof candidate.symbol === "string" &&
      ["LONG", "SHORT"].includes(candidate.side) && finite(candidate.qty) && candidate.qty > 0 &&
      finite(candidate.entryPrice) && candidate.entryPrice > 0
      ? check("ORDER_TERMS", "PASS", "Symbol, side, quantity, and reference price are explicit.")
      : check("ORDER_TERMS", "BLOCK", "Order terms are incomplete or non-finite.")
  );

  checks.push(
    verdict?.verdict === "APPROVE"
      ? check("REFEREE_VERDICT", "PASS", "The deterministic Constitution Referee approved the proposal.")
      : check("REFEREE_VERDICT", "BLOCK", "The proposal has not been approved by the deterministic Referee.", verdict?.verdict ?? "UNAVAILABLE", "APPROVE")
  );

  checks.push(
    packet?.worst_freshness === "FRESH"
      ? check("MARKET_FRESHNESS", "PASS", "All required market evidence is fresh.", packet.worst_freshness, "FRESH")
      : check("MARKET_FRESHNESS", "BLOCK", "Market evidence is stale, expired, or unavailable; no new risk may open.", packet?.worst_freshness ?? "UNAVAILABLE", "FRESH")
  );

  checks.push(
    finite(mark)
      ? check("PRICE_INTEGRITY", "PASS", "A live Binance mark is available for the proposed action.", mark)
      : check("PRICE_INTEGRITY", "BLOCK", "No trustworthy live mark is available.")
  );

  checks.push(
    finite(bid) && finite(ask) && ask >= bid
      ? check("LIQUIDITY_INPUTS", "PASS", "Bid/ask inputs are available for execution review.", ask - bid)
      : check("LIQUIDITY_INPUTS", "REVIEW", "Bid/ask inputs are not available; execution quality cannot be estimated.")
  );

  checks.push(
    constitution?.capital?.withdrawals_allowed === false && constitution?.execution?.require_human_confirmation === true
      ? check("CONSTITUTION_GUARD", "PASS", "Withdrawals are disabled and human confirmation is mandatory.")
      : check("CONSTITUTION_GUARD", "BLOCK", "The Constitution does not enforce the required execution safeguards.")
  );

  checks.push(
    execution.autopilotEnabled !== true || constitution?.execution?.autonomous_execution_allowed === true
      ? check("AUTONOMY_POLICY", "PASS", execution.autopilotEnabled === true
        ? "Autonomous execution is explicitly enabled by the versioned Constitution."
        : "Autonomous execution is not enabled; supervised confirmation remains the policy.")
      : check("AUTONOMY_POLICY", "BLOCK", "Autopilot was requested but the versioned Constitution does not allow autonomous execution.")
  );

  const orderNotional = finite(candidate?.qty) && finite(candidate?.entryPrice)
    ? candidate.qty * candidate.entryPrice
    : null;
  const maxOrderNotional = execution.maxOrderNotional;
  checks.push(
    finite(maxOrderNotional) && maxOrderNotional > 0 && finite(orderNotional) && orderNotional <= maxOrderNotional
      ? check("ORDER_NOTIONAL_LIMIT", "PASS", "The proposed order is inside the configured notional cap.", orderNotional, maxOrderNotional)
      : execution.autopilotEnabled === true
        ? check("ORDER_NOTIONAL_LIMIT", "BLOCK", "Autopilot requires a positive maximum order-notional cap.", orderNotional, maxOrderNotional ?? "configured cap required")
        : check("ORDER_NOTIONAL_LIMIT", "REVIEW", "No autopilot notional cap is active for this supervised review.", orderNotional, maxOrderNotional ?? "not active")
  );

  checks.push(
    !Array.isArray(execution.allowedSymbols) || execution.allowedSymbols.length === 0 || execution.allowedSymbols.includes(candidate?.symbol)
      ? check("SYMBOL_ALLOWLIST", "PASS", "The symbol is inside the configured execution scope.", candidate?.symbol, execution.allowedSymbols ?? "supervised")
      : check("SYMBOL_ALLOWLIST", "BLOCK", "The symbol is outside the configured autopilot allowlist.", candidate?.symbol, execution.allowedSymbols)
  );

  checks.push(
    pendingOrder
      ? check("DUPLICATE_ORDER", "BLOCK", "An unresolved order already exists for this account.")
      : check("DUPLICATE_ORDER", "PASS", "No unresolved duplicate order is recorded.")
  );

  checks.push(
    execution.accountBound === true
      ? check("ACCOUNT_BINDING", "PASS", "The account identity is bound to this execution session.")
      : check("ACCOUNT_BINDING", "BLOCK", "No authenticated Binance account is bound to APEX.")
  );

  checks.push(
    execution.writesEnabled === true
      ? check("EXECUTION_CAPABILITY", "PASS", "A verified Binance write capability is available.")
      : check("EXECUTION_CAPABILITY", "BLOCK", "Binance write capability is not verified; no order can be sent.")
  );

  const blocked = checks.filter((item) => item.status === "BLOCK").length;
  const review = checks.filter((item) => item.status === "REVIEW").length;
  const passed = checks.filter((item) => item.status === "PASS").length;
  const status = blocked ? "BLOCK" : review ? "REVIEW" : "PASS";

  return {
    name: "APEX GUARDIAN",
    status,
    safe_to_confirm: status === "PASS",
    checks,
    summary: { passed, blocked, review },
    reason: status === "PASS"
      ? "All preflight checks passed; human confirmation is still required."
      : checks.find((item) => item.status === "BLOCK")?.detail ?? "Execution requires review."
  };
}
