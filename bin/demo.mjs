#!/usr/bin/env node
// APEX demo runner.
//
//   node bin/demo.mjs            live market data, the reckless fixture proposal
//   node bin/demo.mjs --replay   captured market data, no network required
//
// Prints the full decision trail and verifies the journal at the end.

import { runCycle } from "../src/cycle.mjs";
import { verifyJournal } from "../src/journal.mjs";
import {
  EXECUTION_MODE,
  FIXTURE_LABEL,
  fixtureBook,
  recklessCandidate
} from "../fixtures/reckless-add.mjs";
import capturedContext from "../fixtures/market-context.captured.json" with { type: "json" };

const replay = process.argv.includes("--replay");

// Replay rebases the capture's timestamp to now. Without this the recording is
// hours old and the cycle correctly refuses it as EXPIRED, which is right for
// live trading but useless for a reproducible demo. Everything stays classified
// SIMULATION, so nothing here is presented as a current exchange reading.
const replayContext = replay
  ? { ...capturedContext, fetchedAt: new Date().toISOString() }
  : null;

const bar = (label) => {
  console.log("");
  console.log(`── ${label} ${"─".repeat(Math.max(0, 62 - label.length))}`);
};

const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(2)}%`);
const money = (v) =>
  v === null || v === undefined
    ? "n/a"
    : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const book = fixtureBook();

console.log("APEX · Adversarial Portfolio Execution Engine");
console.log("Let the models fight. Let the math decide.");
console.log("");
console.log(
  `Mode        ${replay ? `SIMULATION · capture from ${capturedContext._captured_at}, clock rebased to now` : "LIVE market data"}`
);
console.log(`Proposal    ${FIXTURE_LABEL} · ${EXECUTION_MODE}`);
console.log("Writes      disabled; no Binance write tool has a verified schema");

const result = await runCycle({
  book,
  candidate: recklessCandidate,
  mode: replay ? "SIMULATION" : "LIVE",
  capturedContext: replayContext
});

if (result.halt === "MARKET_UNAVAILABLE" || result.halt === "EVIDENCE_STALE") {
  bar("HALTED");
  console.log(result.message);
  console.log("This is the fail-closed path: no new risk is opened on bad data.");
  process.exit(0);
}

// --- Evidence ---------------------------------------------------------------
bar("QUANT EVIDENCE");
const e = result.packet.evidence;
const show = (key, format = (v) => String(v)) => {
  const field = e[key];
  if (!field) return;
  const value = field.value === null ? "UNAVAILABLE" : format(field.value);
  console.log(
    `  ${key.padEnd(38)} ${String(value).padStart(14)}   ${field.classification} · ${field.freshness}`
  );
};
show("price.mark", (v) => money(v));
show("price.spread_bps", (v) => v.toFixed(3));
show("funding.current", (v) => `${(v * 100).toFixed(4)}%`);
show("market.order_book_imbalance", (v) => v.toFixed(4));
show("market.realized_volatility", (v) => pct(v));
show("market.flow_toxicity", (v) => v.toFixed(4));
show("portfolio.equity", (v) => money(v));
show("portfolio.leverage", (v) => `${v.toFixed(2)}x`);
show("portfolio.liquidation_price", (v) => money(v));
show("portfolio.liquidation_distance_pct", (v) => `${v.toFixed(2)}%`);

// --- Debate -----------------------------------------------------------------
bar("DEBATE");
for (const [name, agent] of [
  ["BULL", result.bull],
  ["BEAR", result.bear]
]) {
  console.log(
    `  ${name}  ${agent.decision}  confidence ${(agent.confidence * 100).toFixed(0)}%`
  );
  for (const claim of agent.claims) {
    console.log(`    · ${claim.claim}`);
    console.log(`      cites: ${claim.evidence_keys.join(", ")}`);
  }
  if (agent.rejected.length) {
    console.log(`    ${agent.rejected.length} claim(s) rejected as unsupported`);
  }
}
console.log("");
console.log(`  ROUTER  ${result.debate.classification}  ·  ${result.debate.detail}`);

// --- Router -----------------------------------------------------------------
if (result.routes) {
  bar("PORTFOLIO ROUTER");
  console.log(`  ${"ROUTE".padEnd(16)} ${"SIDE".padEnd(6)} ${"SCORE".padStart(9)}   STATUS`);
  for (const e of result.routes.evaluations) {
    const score = e.score === null ? "—" : `${e.score.toFixed(2)} bps`;
    console.log(
      `  ${e.route.padEnd(16)} ${(e.side ?? "—").padEnd(6)} ${score.padStart(9)}   ${e.status}`
    );
  }
  console.log("");
  console.log(`  SELECTED  ${result.routes.selected ?? "none"}`);
  const rejections = [...result.routes.rejected, ...result.routes.not_executable];
  if (rejections.length) {
    console.log("");
    console.log("  Why the others were not taken:");
    for (const r of rejections) console.log(`    · ${r.route}: ${r.reason}`);
  }
}

// --- Referee ----------------------------------------------------------------
if (result.verdict) {
  bar("REFEREE");
  console.log(`  VERDICT  ${result.verdict.verdict}`);
  console.log(
    `  policy   ${result.constitution.constitution_id} v${result.constitution.constitution_version} · ${result.constitution.constitution_sha256.slice(0, 12)}…`
  );
  console.log("");
  console.log(`  ${"RULE".padEnd(24)} ${"OBSERVED".padStart(14)} ${"LIMIT".padStart(12)}   RESULT`);
  for (const check of result.verdict.checks) {
    const n = check.numbers;
    const observed = firstNumber([
      n.distanceAfter,
      n.leverage,
      n.netDeltaBtc,
      n.concentration,
      n.riskFraction,
      n.drawdown,
      n.confidence,
      n.toxicity
    ]);
    const limit = firstNumber([
      n.required,
      n.cap,
      n.limit,
      n.budget,
      n.ceiling,
      n.floor,
      n.threshold
    ]);
    console.log(
      `  ${check.rule.padEnd(24)} ${fmt(observed).padStart(14)} ${fmt(limit).padStart(12)}   ${check.passed ? "PASS" : "FAIL"}`
    );
  }
  const failed = result.verdict.checks.filter((c) => !c.passed);
  if (failed.length) {
    console.log("");
    console.log("  Why it was denied:");
    for (const check of failed) console.log(`    · ${check.detail}`);
  }
  if (result.resize !== undefined) {
    console.log("");
    console.log(
      result.resize > 0
        ? `  Largest compliant size: ${result.resize.toFixed(6)} (proposed ${recklessCandidate.qty})`
        : "  No compliant size exists. The correct action is to stand down."
    );
  }
}

// --- Journal ----------------------------------------------------------------
bar("JOURNAL");
for (const event of result.journal.all()) {
  console.log(
    `  ${event.event_id}  ${event.event_type.padEnd(20)} ${event.event_hash.slice(0, 12)}…`
  );
}
const integrity = verifyJournal(result.journal.all());
console.log("");
console.log(`  chain: ${integrity.valid ? "VALID" : `BROKEN at ${integrity.event_id}`} · ${result.journal.length} events`);

// Demonstrate that tampering is actually detectable.
const tampered = result.journal.all();
const target = tampered.find((ev) => ev.event_type === "REFEREE_DECISION");
if (target) {
  target.payload.verdict = "APPROVE";
  const broken = verifyJournal(tampered);
  console.log(
    `  tamper test: flipped the Referee verdict to APPROVE → ${broken.valid ? "NOT DETECTED" : `${broken.failure} at ${broken.event_id}`}`
  );
}

console.log("");

function firstNumber(candidates) {
  for (const c of candidates) if (typeof c === "number" && Number.isFinite(c)) return c;
  return null;
}
function fmt(v) {
  if (v === null) return "—";
  if (Math.abs(v) < 1) return v.toFixed(4);
  return v.toFixed(2);
}
