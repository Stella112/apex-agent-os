// Preflight only. Does not sign, pay, or fabricate a provider quote.
export function assessPurchase(request, limits, history = []) {
  const deny = reason => ({ allowed: false, reason, settlement: "NOT_STARTED" });
  if (!request?.authorized || !limits) return deny("SPENDING_NOT_AUTHORIZED");
  if (request.mode !== "LIVE") return deny("NON_LIVE_ISOLATED");
  if (request.hardDenial || !request.question || !request.materialEffect || !request.freeEvidenceInsufficient) return deny("NO_MATERIAL_VALUE");
  const q = request.quote;
  if (!q || !q.verified || !q.recipient || !q.resource || !q.asset || !q.network || !Number.isFinite(q.expiresAt) || q.expiresAt <= Date.now()) return deny("QUOTE_UNVERIFIED");
  if (![q.amount, limits.perPurchase, limits.perDecision, limits.total].every(v => typeof v === "string" && /^\d+$/.test(v))) return deny("INVALID_BASE_UNITS");
  if (q.asset !== limits.asset || q.network !== limits.network || q.recipient !== limits.recipient) return deny("QUOTE_SCOPE_MISMATCH");
  if (history.some(h => h.question === request.question && h.status !== "REJECTED")) return deny("DUPLICATE_OR_PENDING_PURCHASE");
  const committed = history.filter(h => h.status !== "REJECTED");
  const sum = entries => entries.reduce((n,h) => n + BigInt(h.amount), 0n);
  const amount = BigInt(q.amount);
  if (amount <= 0n || amount > BigInt(limits.perPurchase) || amount + sum(committed) > BigInt(limits.total) || amount + sum(committed.filter(h => h.decisionId === request.decisionId)) > BigInt(limits.perDecision)) return deny("BUDGET_EXHAUSTED");
  return { allowed: true, settlement: "NOT_STARTED", reason: "PREFLIGHT_ONLY_WALLET_AND_DELIVERY_ADAPTER_REQUIRED" };
}
