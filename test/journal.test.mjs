import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalJson,
  loadConstitution,
  parseConstitutionYaml,
  sha256,
  validateConstitution
} from "../src/constitution.mjs";
import { GENESIS_HASH, createJournal, verifyJournal } from "../src/journal.mjs";

// --- Constitution -----------------------------------------------------------

test("the constitution loads with every required limit present", () => {
  const c = loadConstitution();
  assert.equal(c.constitution_id, "apex-v1");
  assert.equal(c.constitution_version, "1.1.0");
  assert.equal(c.risk.max_leverage, 2);
  assert.equal(c.risk.min_liquidation_distance_pct, 15);
  assert.equal(c.risk.max_net_delta_btc, 0.25);
  assert.equal(c.risk.daily_loss_lock_pct, 3);
  assert.equal(c.capital.withdrawals_allowed, false);
  assert.equal(c.execution.require_human_confirmation, true);
});

test("the constitution hash is stable and 64 hex characters", () => {
  const a = loadConstitution();
  const b = loadConstitution();
  assert.equal(a.constitution_sha256, b.constitution_sha256);
  assert.match(a.constitution_sha256, /^[0-9a-f]{64}$/);
});

test("changing any limit changes the hash", () => {
  const base = parseConstitutionYaml("id: x\nversion: 1\nrisk:\n  max_leverage: 2\n");
  const changed = parseConstitutionYaml("id: x\nversion: 1\nrisk:\n  max_leverage: 3\n");
  assert.notEqual(sha256(canonicalJson(base)), sha256(canonicalJson(changed)));
});

test("reordering sections does not change the hash but editing a value does", () => {
  const one = parseConstitutionYaml("risk:\n  a: 1\nrouting:\n  b: 2\n");
  const two = parseConstitutionYaml("routing:\n  b: 2\nrisk:\n  a: 1\n");
  assert.equal(sha256(canonicalJson(one)), sha256(canonicalJson(two)));
});

test("comments and blank lines are ignored by the parser", () => {
  const doc = parseConstitutionYaml("# header\nid: x\n\nrisk:\n  max_leverage: 2  # inline\n");
  assert.equal(doc.id, "x");
  assert.equal(doc.risk.max_leverage, 2);
});

test("scalar types are coerced correctly", () => {
  const doc = parseConstitutionYaml(
    "a: 1\nb: 1.5\nc: -0.002\nd: true\ne: false\nf: hello\ng: \"quoted\"\n"
  );
  assert.equal(doc.a, 1);
  assert.equal(doc.b, 1.5);
  assert.equal(doc.c, -0.002);
  assert.equal(doc.d, true);
  assert.equal(doc.e, false);
  assert.equal(doc.f, "hello");
  assert.equal(doc.g, "quoted");
});

test("a constitution that permits withdrawals is refused", () => {
  const doc = parseConstitutionYaml(
    "id: bad\nversion: 1\ncapital:\n  withdrawals_allowed: true\nexecution:\n  require_human_confirmation: true\nrisk:\n  max_order_pct: 1\n  max_name_pct: 1\n  max_leverage: 1\n  max_net_delta_btc: 1\n  min_liquidation_distance_pct: 1\n  daily_loss_lock_pct: 1\n"
  );
  const problems = validateConstitution(doc);
  assert.ok(problems.some((p) => /withdrawals_allowed/.test(p)));
});

test("a constitution that skips human confirmation is refused", () => {
  const doc = parseConstitutionYaml(
    "id: bad\nversion: 1\ncapital:\n  withdrawals_allowed: false\nexecution:\n  require_human_confirmation: false\nrisk:\n  max_order_pct: 1\n  max_name_pct: 1\n  max_leverage: 1\n  max_net_delta_btc: 1\n  min_liquidation_distance_pct: 1\n  daily_loss_lock_pct: 1\n"
  );
  const problems = validateConstitution(doc);
  assert.ok(problems.some((p) => /require_human_confirmation/.test(p)));
});

test("malformed indentation is a loud error, not a silent misparse", () => {
  assert.throws(() => parseConstitutionYaml("risk:\n      max_leverage: 2\n"), /unsupported indent/);
  assert.throws(() => parseConstitutionYaml("  orphan: 1\n"), /no parent section/);
  assert.throws(() => parseConstitutionYaml("no colon here\n"), /expected/);
});

// --- Journal ----------------------------------------------------------------

test("an empty journal verifies and its head is the genesis hash", () => {
  const journal = createJournal();
  assert.equal(journal.head(), GENESIS_HASH);
  assert.equal(journal.verify().valid, true);
});

test("appended events chain to their predecessor", () => {
  const journal = createJournal({ environment: "test" });
  const first = journal.append("MARKET_STATE", { symbol: "BTCUSDT" });
  const second = journal.append("QUANT_PACKET", { mid: 80_000 });

  assert.equal(first.previous_hash, GENESIS_HASH);
  assert.equal(second.previous_hash, first.event_hash);
  assert.equal(journal.head(), second.event_hash);
  assert.equal(journal.verify().valid, true);
  assert.equal(journal.verify().length, 2);
});

test("event ids are sequential and the environment is recorded", () => {
  const journal = createJournal({ environment: "simulation" });
  journal.append("MARKET_STATE", {});
  const second = journal.append("REFEREE_DECISION", { verdict: "DENY" });
  assert.equal(second.event_id, "evt_000002");
  assert.equal(second.environment, "simulation");
});

test("an unknown event type is rejected", () => {
  const journal = createJournal();
  assert.throws(() => journal.append("MADE_UP_EVENT", {}), /unknown event type/);
});

test("tampering with a payload is detected and located", () => {
  const journal = createJournal();
  journal.append("MARKET_STATE", { price: 80_000 });
  journal.append("REFEREE_DECISION", { verdict: "DENY" });
  journal.append("POST_TRADE_STATE", { equity: 10_000 });

  const events = journal.all();
  events[1].payload.verdict = "ALLOW"; // flip a denial into an approval

  const result = verifyJournal(events);
  assert.equal(result.valid, false);
  assert.equal(result.failure, "PAYLOAD_TAMPERED");
  assert.equal(result.index, 1);
  assert.equal(result.event_id, "evt_000002");
});

test("deleting an event from the middle breaks the chain", () => {
  const journal = createJournal();
  journal.append("MARKET_STATE", { a: 1 });
  journal.append("QUANT_PACKET", { b: 2 });
  journal.append("REFEREE_DECISION", { c: 3 });

  const events = journal.all();
  events.splice(1, 1);

  const result = verifyJournal(events);
  assert.equal(result.valid, false);
  assert.equal(result.failure, "BROKEN_LINK");
  assert.equal(result.index, 1);
});

test("re-hashing a tampered event still breaks the following link", () => {
  // A tamperer who recomputes the edited event's own hash cannot stop there:
  // the next event still commits to the original hash.
  const journal = createJournal();
  journal.append("MARKET_STATE", { price: 80_000 });
  journal.append("REFEREE_DECISION", { verdict: "DENY" });
  journal.append("POST_TRADE_STATE", { equity: 10_000 });

  const events = journal.all();
  events[1].payload.verdict = "ALLOW";
  events[1].event_hash = sha256(
    canonicalJson({
      event_type: events[1].event_type,
      timestamp: events[1].timestamp,
      payload: events[1].payload,
      previous_hash: events[1].previous_hash
    })
  );

  const result = verifyJournal(events);
  assert.equal(result.valid, false);
  assert.equal(result.failure, "BROKEN_LINK");
  assert.equal(result.index, 2, "the break surfaces at the next event");
});

test("the journal getter cannot be used to mutate the chain", () => {
  const journal = createJournal();
  journal.append("MARKET_STATE", { price: 80_000 });
  const copy = journal.all();
  copy[0].payload.price = 1;
  assert.equal(journal.verify().valid, true, "internal state is untouched");
});

test("canonical json sorts keys at every level", () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
});
