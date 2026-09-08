import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./constitution.mjs";

const terminal = new Set(["FILLED", "CANCELLED", "REJECTED"]);
// Adapter contract is internal. No assumption about actual Binance tool names or output shapes.
// This coordinator is NOT connected to the HTTP trading surface until account/schema review.
export class ExecutionCoordinator {
  constructor({ store, adapter, revalidate, now = Date.now }) {
    Object.assign(this, { store, adapter, revalidate, now }); this.busy = new Set(); this.stopped = false;
  }
  async exclusive(account, fn) {
    if (this.busy.has(account)) throw new Error("ACCOUNT_BUSY");
    this.busy.add(account); try { return await fn(); } finally { this.busy.delete(account); }
  }
  preview({ user, session, account, mode, terms, policyHash, stateHash, expiresAt }) {
    if (!user || !session || !account || !["LIVE", "SIMULATION", "REPLAY"].includes(mode) || !terms || !policyHash || !stateHash || expiresAt <= this.now()) throw new Error("INVALID_PREVIEW");
    if (this.store.all().some(r => r.account === account && !terminal.has(r.status) && !(r.status === "PREVIEW" && r.expiresAt <= this.now()))) throw new Error("ACCOUNT_RESERVED");
    const id = randomUUID();
    const record = { id, user, session, account, mode, terms, policyHash, stateHash, expiresAt, status: "PREVIEW", clientOrderId: id, updates: [] };
    record.previewHash = sha256(canonicalJson(record));
    this.store.save(record); return structuredClone(record);
  }
  async confirm({ id, user, session, previewHash }) {
    const initial = this.store.get(id);
    return this.exclusive(initial.account, async () => {
      const r = this.store.get(id);
      if (r.user !== user || r.session !== session || r.previewHash !== previewHash) throw new Error("CONFIRMATION_MISMATCH");
      if (this.stopped || r.mode !== "LIVE" || !this.adapter?.verified) throw new Error("EXECUTION_BLOCKED");
      if (r.status !== "PREVIEW" || r.expiresAt <= this.now()) throw new Error("STALE_OR_CONSUMED_PREVIEW");
      const check = await this.revalidate(r);
      if (check?.verdict !== "ALLOW" || check.policyHash !== r.policyHash || check.stateHash !== r.stateHash || canonicalJson(check.terms) !== canonicalJson(r.terms)) throw new Error("NEW_PREVIEW_REQUIRED");
      if (this.stopped || r.expiresAt <= this.now()) throw new Error("EXECUTION_BLOCKED");
      r.status = "SUBMITTING"; r.confirmedAt = this.now(); this.store.save(r);
      try {
        const result = await this.adapter.submit(r);
        return this.update(r, result);
      } catch {
        // Acceptance may have happened. Preserve reservation and query by stable provider identifier.
        r.status = "UNKNOWN"; this.store.save(r); return r;
      }
    });
  }
  update(r, observation) {
    const allowed = ["ACKNOWLEDGED", "PARTIAL_FILL", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN"];
    if (!observation || !allowed.includes(observation.status) || observation.clientOrderId !== r.clientOrderId || !observation.evidenceId ||
        (["PARTIAL_FILL", "FILLED"].includes(observation.status) && (!Array.isArray(observation.fills) || !observation.fills.length))) throw new Error("INVALID_ORDER_EVIDENCE");
    r.updates.push(observation); r.status = observation.status; this.store.save(r); return r;
  }
  async reconcile() {
    for (const r of this.store.all().filter(r => ["SUBMITTING", "UNKNOWN", "ACKNOWLEDGED", "PARTIAL_FILL"].includes(r.status))) {
      await this.exclusive(r.account, async () => {
        try { this.update(r, await this.adapter.lookup(r)); } catch { /* retain unresolved reservation */ }
      });
    }
  }
  stop() { this.stopped = true; }
}
