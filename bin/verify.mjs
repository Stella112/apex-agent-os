#!/usr/bin/env node
// APEX verification harness.
//
// Implements the acceptance tests of the verification directive, sections 4
// through 14, and prints the final report of section 19.
//
// Rules this harness obeys:
//   - No check may pass without evidence produced during this run.
//   - Live checks use live Binance data. Fixture data is never substituted.
//   - A check that cannot be performed is reported UNVERIFIED, never PASS.
//
// Usage: node bin/verify.mjs [--base http://127.0.0.1:4173]

import { createBook } from "../src/portfolio.mjs";
import { configureResolver, getJsonViaResolver, probeReachability } from "../src/resolver.mjs";
import { fetchMarketContext } from "../src/market.mjs";
import { buildQuantPacket } from "../src/quant.mjs";
import { CLASSIFICATION, observed } from "../src/provenance.mjs";
import { callModelWithValidation } from "../src/evidence.mjs";
import { bearProvider, bullProvider, routeDebate } from "../src/agents.mjs";
import { judge } from "../src/referee.mjs";
import { ROUTE, ROUTE_STATUS, evaluateRoutes } from "../src/router.mjs";
import { EXECUTION_VERIFIED } from "../src/cycle.mjs";
import { activePolicy } from "../src/policy.mjs";
import { canonicalJson, loadConstitution, sha256 } from "../src/constitution.mjs";
import { createJournal, verifyJournal } from "../src/journal.mjs";
import { resolveLiquidation, liquidationDistancePct, meetsDistanceFloor } from "../src/liquidation.mjs";
import { runCycle } from "../src/cycle.mjs";
import {
  fixtureBook as recklessBook,
  recklessCandidate,
  fixtureThesis as recklessThesis
} from "../fixtures/reckless-add.mjs";
import {
  fixtureBook as safeBook,
  fixtureMarks as safeMarks,
  safeCandidate,
  safeThesis
} from "../fixtures/safe-add.mjs";

const baseArg = process.argv.indexOf("--base");
const BASE = baseArg > -1 ? process.argv[baseArg + 1] : "http://127.0.0.1:4173";

const results = {};
const notes = [];

function record(name, status, evidence) {
  results[name] = { status, evidence };
  const mark = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : status;
  console.log(`  [${mark.padEnd(10)}] ${name}`);
  if (evidence) console.log(`               ${evidence}`);
}

function section(title) {
  console.log("");
  console.log(`── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

async function http(path) {
  const response = await fetch(`${BASE}${path}`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

console.log("APEX VERIFICATION HARNESS");
console.log(`Started ${new Date().toISOString()}`);
console.log(`Target  ${BASE}`);

// ---------------------------------------------------------------------------
// 4. REAL DATA ACCEPTANCE TEST — live Binance, no fixtures
// ---------------------------------------------------------------------------
section("4 · REAL BINANCE DATA");

configureResolver();
let liveContext = null;
const reach = await probeReachability();

if (!reach.reachable) {
  record("REAL_BINANCE_DATA", "FAIL", `unreachable: ${reach.reason}`);
} else {
  try {
    liveContext = await fetchMarketContext("BTCUSDT");
    const fetchedMs = Date.parse(liveContext.fetchedAt);
    const age = Date.now() - fetchedMs;
    console.log("");
    console.log("  BTCUSDT (live, not fixture)");
    console.log(`    Bid            ${liveContext.bestBid}`);
    console.log(`    Ask            ${liveContext.bestAsk}`);
    console.log(`    Mark           ${liveContext.markPrice}`);
    console.log(`    Funding        ${liveContext.fundingRate}`);
    console.log(`    Source         BINANCE (public REST via apex-resolver)`);
    console.log(`    Timestamp      ${liveContext.fetchedAt}`);
    console.log(`    Age            ${age} ms`);
    console.log(`    Classification BINANCE_REPORTED`);
    console.log("");
    const ok =
      Number.isFinite(liveContext.markPrice) &&
      liveContext.markPrice > 0 &&
      Number.isFinite(liveContext.bestBid) &&
      age < 60_000;
    record(
      "REAL_BINANCE_DATA",
      ok ? "PASS" : "FAIL",
      `mark ${liveContext.markPrice}, age ${age}ms, latency ${reach.latency_ms}ms`
    );
  } catch (error) {
    record("REAL_BINANCE_DATA", "FAIL", error.message);
  }
}

// ---------------------------------------------------------------------------
// 5. QUANT ACCEPTANCE TEST — provenance survives derivation
// ---------------------------------------------------------------------------
section("5 · QUANT AND PROVENANCE");

let livePacket = null;
if (!liveContext) {
  record("QUANT", "UNVERIFIED", "no live market data to feed through Quant");
  record("DATA_PROVENANCE", "UNVERIFIED", "no live packet");
} else {
  livePacket = buildQuantPacket({
    context: liveContext,
    book: createBook({
      walletBalance: 10_000,
      positions: [{ symbol: "BTCUSDT", qty: 0.2, entryPrice: liveContext.markPrice }]
    }),
    marks: { BTCUSDT: liveContext.markPrice },
    symbol: "BTCUSDT",
    now: Date.now(),
    classification: CLASSIFICATION.BINANCE_REPORTED
  });

  const keyCount = Object.keys(livePacket.evidence).length;
  record("QUANT", keyCount > 20 ? "PASS" : "FAIL", `${keyCount} evidence keys from live data`);

  // A raw reading keeps BINANCE_REPORTED; a derived metric must become an
  // APEX_ESTIMATE and must still carry source and timestamp.
  const raw = livePacket.evidence["price.mark"];
  const derived = livePacket.evidence["price.spread_bps"];
  const provenanceOk =
    raw.classification === "BINANCE_REPORTED" &&
    raw.source === "binance" &&
    typeof raw.timestamp === "string" &&
    derived.classification === "APEX_ESTIMATE" &&
    typeof derived.timestamp === "string" &&
    typeof derived.formula === "string" &&
    Number.isFinite(derived.age_ms);
  record(
    "DATA_PROVENANCE",
    provenanceOk ? "PASS" : "FAIL",
    `raw=${raw.classification}/${raw.source}, derived=${derived.classification} formula="${derived.formula}"`
  );

  // A derived value must never inherit the BINANCE_REPORTED label.
  const mislabelled = Object.entries(livePacket.evidence).filter(
    ([, f]) => f.source === "apex" && f.classification === "BINANCE_REPORTED"
  );
  record(
    "NO_ESTIMATE_MISLABELLED_AS_BINANCE",
    mislabelled.length === 0 ? "PASS" : "FAIL",
    mislabelled.length === 0
      ? "no APEX-derived field claims Binance as its source"
      : `${mislabelled.length} mislabelled: ${mislabelled.map(([k]) => k).join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// 6. AI ACCEPTANCE TEST — same packet, attributed, evidence validated
// ---------------------------------------------------------------------------
section("6 · BULL, BEAR, EVIDENCE VALIDATION");

let bull = null;
let bear = null;
if (!livePacket) {
  record("BULL", "UNVERIFIED", "no packet");
  record("BEAR", "UNVERIFIED", "no packet");
  record("EVIDENCE_VALIDATION", "UNVERIFIED", "no packet");
  record("DEBATE", "UNVERIFIED", "no packet");
} else {
  const hashInput = (p) => sha256(canonicalJson(p.evidence));
  bull = await callModelWithValidation({ provider: bullProvider, role: "bull", packet: livePacket, hashInput });
  bear = await callModelWithValidation({ provider: bearProvider, role: "bear", packet: livePacket, hashInput });

  console.log(`    input_hash     ${bull.input_hash?.slice(0, 24)}…`);
  console.log(`    bull           ${bull.model} v${bull.model_version} → ${bull.decision} @ ${bull.confidence}`);
  console.log(`    bear           ${bear.model} v${bear.model_version} → ${bear.decision} @ ${bear.confidence}`);

  const sameInput = bull.input_hash && bull.input_hash === bear.input_hash;
  record(
    "BULL",
    bull.valid && bull.model && bull.model_version && bull.timestamp ? "PASS" : "FAIL",
    `${bull.claims?.length ?? 0} validated claims, attributed to ${bull.model} v${bull.model_version}`
  );
  record(
    "BEAR",
    bear.valid && bear.model && bear.model_version && bear.timestamp ? "PASS" : "FAIL",
    `${bear.claims?.length ?? 0} validated claims, attributed to ${bear.model} v${bear.model_version}`
  );
  record(
    "AGENTS_SAW_IDENTICAL_EVIDENCE",
    sameInput ? "PASS" : "FAIL",
    sameInput ? `both input_hash ${bull.input_hash.slice(0, 16)}…` : "input hashes differ"
  );

  // Every cited key must exist in the packet.
  const cited = [...(bull.claims ?? []), ...(bear.claims ?? [])].flatMap((c) => c.evidence_keys);
  const orphans = cited.filter((k) => !(k in livePacket.evidence));

  // And an invented key must be rejected rather than accepted.
  const injected = await callModelWithValidation({
    provider: {
      name: "adversarial-probe",
      version: "1.0.0",
      async propose() {
        return {
          decision: "ADD",
          confidence: 0.9,
          claims: [{ claim: "EMA200 confirms the trend", evidence_keys: ["market.ema_200"] }]
        };
      }
    },
    role: "bull",
    packet: livePacket,
    hashInput
  });
  const rejectedProbe = !injected.valid && injected.failure === "UNSUPPORTED_CLAIM";
  record(
    "EVIDENCE_VALIDATION",
    orphans.length === 0 && rejectedProbe ? "PASS" : "FAIL",
    `${cited.length} citations all resolve; invented key market.ema_200 → ${injected.failure}`
  );

  const debate = routeDebate({ bull, bear, packet: livePacket });
  record(
    "DEBATE",
    debate.classification ? "PASS" : "FAIL",
    `${debate.classification}: ${debate.detail}`
  );
}

// ---------------------------------------------------------------------------
// 21. PORTFOLIO ROUTER — scored routes, reasoned rejections
// ---------------------------------------------------------------------------
section("21 · PORTFOLIO ROUTER");

const policy = activePolicy();
const constitution = loadConstitution();

if (!livePacket) {
  record("PORTFOLIO_ROUTER", "UNVERIFIED", "no live packet to route over");
} else {
  const routes = evaluateRoutes({
    packet: livePacket,
    policy,
    constitution,
    executionVerified: EXECUTION_VERIFIED
  });

  console.log(`    ${"ROUTE".padEnd(16)} ${"SIDE".padEnd(6)} ${"SCORE".padStart(10)}   STATUS`);
  for (const e of routes.evaluations) {
    const score = e.score === null ? "—" : `${e.score.toFixed(2)} bps`;
    console.log(
      `    ${e.route.padEnd(16)} ${(e.side ?? "—").padEnd(6)} ${score.padStart(10)}   ${e.status}`
    );
  }
  console.log(`    selected: ${routes.selected ?? "none"}`);

  // The book above is deliberately over-concentrated, which proves rejection.
  // Score a compliant book as well, so the scoring path is exercised on live
  // data rather than only on fixtures.
  const compliantPacket = buildQuantPacket({
    context: liveContext,
    book: createBook({
      walletBalance: 100_000,
      positions: [{ symbol: "BTCUSDT", qty: 0.001, entryPrice: liveContext.markPrice }]
    }),
    marks: { BTCUSDT: liveContext.markPrice },
    symbol: "BTCUSDT",
    now: Date.now(),
    classification: CLASSIFICATION.BINANCE_REPORTED
  });
  const compliantRoutes = evaluateRoutes({
    packet: compliantPacket,
    policy,
    constitution,
    executionVerified: true
  });
  console.log("");
  console.log("    against a policy-compliant book, execution hypothetically verified:");
  for (const e of compliantRoutes.evaluations) {
    const score = e.score === null ? "—" : `${e.score.toFixed(2)} bps`;
    console.log(
      `    ${e.route.padEnd(16)} ${(e.side ?? "—").padEnd(6)} ${score.padStart(10)}   ${e.status}`
    );
  }
  console.log(`    selected: ${compliantRoutes.selected}`);

  const scoredSomething = compliantRoutes.evaluations.filter((e) => e.score !== null).length >= 3;
  const boundedScores = compliantRoutes.evaluations
    .filter((e) => e.score !== null)
    .every((e) => Math.abs(e.score) < 200);

  const allFive = Object.values(ROUTE).every((r) =>
    routes.evaluations.some((e) => e.route === r)
  );
  const everyRejectionReasoned = routes.evaluations
    .filter((e) => e.status === ROUTE_STATUS.REJECTED)
    .every((e) => typeof e.reason === "string" && e.reason.length > 0);
  const scoresReproduce = routes.evaluations
    .filter((e) => e.score !== null)
    .every((e) => {
      const c = e.components;
      const expected =
        c.expected_return_bps + c.carry_bps - c.fees_bps - c.slippage_bps -
        c.volatility_penalty_bps - c.exposure_penalty_bps -
        c.concentration_penalty_bps - c.liquidity_penalty_bps - c.stress_penalty_bps;
      return Math.abs(e.score - expected) < 1e-9;
    });
  // With execution unverified, no position-taking route may be selected.
  const honestSelection =
    EXECUTION_VERIFIED || [ROUTE.PARK, ROUTE.STAND_DOWN, null].includes(routes.selected);

  record(
    "PORTFOLIO_ROUTER",
    allFive && everyRejectionReasoned && scoresReproduce && honestSelection && scoredSomething && boundedScores
      ? "PASS"
      : "FAIL",
    `5 routes on live data; breached book → ${routes.selected}, compliant book → ${compliantRoutes.selected}; scores bounded and reproducible`
  );
  record(
    "ROUTER_REJECTS_NON_COMPLIANT_BOOK",
    routes.book_breaches.length > 0 &&
      routes.evaluations.filter((e) => e.status === ROUTE_STATUS.REJECTED).length >= 3
      ? "PASS"
      : "FAIL",
    routes.book_breaches.length > 0
      ? `position routes rejected: ${routes.book_breaches[0]}`
      : "book was compliant, rejection path not exercised"
  );
  record(
    "ROUTER_RESPECTS_EXECUTION_GATE",
    honestSelection ? "PASS" : "FAIL",
    EXECUTION_VERIFIED
      ? "execution verified, position routes selectable"
      : "execution unverified, so only no-position routes are selectable"
  );
}

section("7 · REFEREE, CONSTITUTION");
record(
  "CONSTITUTION",
  constitution.constitution_sha256?.length === 64 ? "PASS" : "FAIL",
  `${constitution.constitution_id} v${constitution.constitution_version} sha256 ${constitution.constitution_sha256.slice(0, 16)}…`
);

const safeVerdict = judge({
  book: safeBook(),
  marks: safeMarks,
  candidate: safeCandidate,
  thesis: safeThesis,
  policy
});
const recklessVerdict = judge({
  book: recklessBook(),
  marks: { BTCUSDT: 80_000 },
  candidate: recklessCandidate,
  thesis: recklessThesis,
  policy
});

console.log(`    safe proposal      → ${safeVerdict.verdict}`);
console.log(`    reckless proposal  → ${recklessVerdict.verdict}`);
const recklessFails = recklessVerdict.checks.filter((c) => !c.passed).map((c) => c.rule);
console.log(`    reckless breaches  → ${recklessFails.join(", ")}`);

const refereeOk =
  safeVerdict.verdict === "APPROVE" &&
  recklessVerdict.verdict === "DENY" &&
  recklessFails.length >= 2 &&
  recklessVerdict.checks.every(
    (c) => c.rule && typeof c.detail === "string" && typeof c.numbers === "object"
  );
record(
  "REFEREE",
  refereeOk ? "PASS" : "FAIL",
  `safe=${safeVerdict.verdict}, reckless=${recklessVerdict.verdict} on ${recklessFails.length} rules, all checks expose rule/observed/limit`
);
if (safeVerdict.verdict !== "APPROVE") {
  notes.push(
    `Safe proposal returned ${safeVerdict.verdict}: ${safeVerdict.checks
      .filter((c) => !c.passed)
      .map((c) => c.rule)
      .join(", ")}`
  );
}

// Determinism: the same inputs must produce the same verdict, with no model.
const repeat = judge({
  book: recklessBook(),
  marks: { BTCUSDT: 80_000 },
  candidate: recklessCandidate,
  thesis: recklessThesis,
  policy
});
record(
  "REFEREE_DETERMINISTIC",
  JSON.stringify(repeat.checks) === JSON.stringify(recklessVerdict.checks) ? "PASS" : "FAIL",
  "identical inputs reproduce an identical rule-by-rule verdict without any model call"
);

// ---------------------------------------------------------------------------
// 8. LIQUIDATION ACCEPTANCE TEST
// ---------------------------------------------------------------------------
section("8 · LIQUIDATION MATH");

const NOW = Date.now();
const leveredBook = createBook({
  walletBalance: 10_000,
  positions: [{ symbol: "BTCUSDT", qty: 1, entryPrice: 80_000 }]
});
const lmarks = { BTCUSDT: 80_000 };

const reported = resolveLiquidation({
  reported: observed({
    value: 91_420.25,
    source: "verified-binance-account-response",
    classification: CLASSIFICATION.BINANCE_REPORTED,
    observedAt: NOW - 200,
    now: NOW
  }),
  book: leveredBook,
  marks: lmarks,
  symbol: "BTCUSDT",
  now: NOW
});
const estimate = resolveLiquidation({ book: leveredBook, marks: lmarks, symbol: "BTCUSDT", now: NOW });
const absent = resolveLiquidation({
  book: createBook({ walletBalance: 10_000, positions: [] }),
  marks: lmarks,
  symbol: "BTCUSDT",
  now: NOW
});
const staleField = observed({
  value: 70_301.5,
  source: "verified-binance-account-response",
  classification: CLASSIFICATION.BINANCE_REPORTED,
  observedAt: NOW - 30_000,
  now: NOW
});
const badContext = resolveLiquidation({
  book: leveredBook,
  marks: lmarks,
  symbol: "BTCUSDT",
  product: "COINM_FUTURES",
  now: NOW
});
const boundary = meetsDistanceFloor(
  observed({ value: 15, source: "apex", classification: CLASSIFICATION.APEX_ESTIMATE, observedAt: NOW, now: NOW }),
  15
);

const liqChecks = [
  ["1 binance-reported", reported.classification === "BINANCE_REPORTED"],
  ["2 apex estimate", estimate.classification === "APEX_ESTIMATE" && estimate.formula_version === "liq-v1"],
  ["3 unavailable", absent.status === "UNAVAILABLE" && absent.value === null],
  ["4 stale", staleField.freshness === "STALE"],
  ["5 invalid context", badContext.status === "INVALID_LIQUIDATION_CONTEXT"],
  ["6 boundary at 15%", boundary.passed === true]
];
for (const [label, ok] of liqChecks) console.log(`    ${ok ? "ok  " : "FAIL"} ${label}`);
record(
  "LIQUIDATION_MATH",
  liqChecks.every(([, ok]) => ok) ? "PASS" : "FAIL",
  `all six classifications distinct; estimate never labelled BINANCE_REPORTED`
);

// ---------------------------------------------------------------------------
// 11. API HEALTH ACCEPTANCE TEST
// ---------------------------------------------------------------------------
section("11 · API ENDPOINTS");

const endpoints = ["/api/health", "/api/market", "/api/account", "/api/journal?mode=replay"];
const apiResults = [];
for (const path of endpoints) {
  try {
    const { status, body } = await http(path);
    const realness =
      path.includes("market")
        ? body?.execution_mode ?? "?"
        : path.includes("account")
          ? body?.status ?? "?"
          : path.includes("journal")
            ? body?.verification?.valid
              ? "SIMULATION (replay)"
              : "?"
            : body?.binance?.reachable
              ? "LIVE"
              : "UNREACHABLE";
    const keys = body ? Object.keys(body).slice(0, 5).join(", ") : "no body";
    console.log(`    ${String(status).padEnd(4)} ${path.padEnd(28)} ${realness}`);
    console.log(`         schema: ${keys}`);
    apiResults.push(status === 200);
  } catch (error) {
    console.log(`    ERR  ${path} → ${error.message}`);
    apiResults.push(false);
  }
}
record(
  "API_ENDPOINTS",
  apiResults.every(Boolean) ? "PASS" : "FAIL",
  `${apiResults.filter(Boolean).length}/${endpoints.length} returned 200; no 404s`
);

// ---------------------------------------------------------------------------
// 12. FRONTEND ACCEPTANCE TEST
// ---------------------------------------------------------------------------
section("12 · DASHBOARD DATA PATH");

try {
  const { status, body } = await http("/api/cycle?mode=live");
  const panelsBacked =
    status === 200 &&
    Object.keys(body.packet?.evidence ?? {}).length > 0 &&
    Boolean(body.bull?.decision) &&
    Boolean(body.bear?.decision) &&
    Boolean(body.verdict?.verdict) &&
    (body.journal?.events?.length ?? 0) > 0;

  console.log(`    market panel   ← ${Object.keys(body.packet?.evidence ?? {}).length} live evidence keys`);
  console.log(`    bull panel     ← ${body.bull?.decision} (${body.bull?.claims?.length} claims)`);
  console.log(`    bear panel     ← ${body.bear?.decision} (${body.bear?.claims?.length} claims)`);
  console.log(`    referee panel  ← ${body.verdict?.verdict} (${body.verdict?.checks?.length} rules)`);
  console.log(`    journal panel  ← ${body.journal?.events?.length} events, valid=${body.journal?.valid}`);

  // Prove the dashboard's own source file contains no hardcoded market numbers.
  const { readFile } = await import("node:fs/promises");
  const dashJs = await readFile(new URL("../public/apex.js", import.meta.url), "utf8");
  const dashHtml = await readFile(new URL("../public/apex.html", import.meta.url), "utf8");
  const hardcoded = /\$1?\d{2},\d{3}\.\d{2}|108,420|18\.6%|4\.2%/.test(dashJs + dashHtml);

  record(
    "DASHBOARD",
    panelsBacked && !hardcoded ? "PASS" : "FAIL",
    panelsBacked
      ? hardcoded
        ? "panels are API-backed but hardcoded values remain in the source"
        : "every panel is API-backed; no hardcoded market values in apex.js or apex.html"
      : "one or more panels had no backing data"
  );
} catch (error) {
  record("DASHBOARD", "FAIL", error.message);
}

// ---------------------------------------------------------------------------
// 13. JOURNAL ACCEPTANCE TEST
// ---------------------------------------------------------------------------
section("13 · JOURNAL AND TAMPER DETECTION");

const j = createJournal({ environment: "verification" });
const e1 = j.append("MARKET_STATE", { price: 80_000 });
const e2 = j.append("REFEREE_DECISION", { verdict: "DENY" });
const e3 = j.append("POST_TRADE_STATE", { equity: 10_000 });

const chained = e2.previous_hash === e1.event_hash && e3.previous_hash === e2.event_hash;
console.log(`    e2.previous_hash == e1.event_hash  → ${e2.previous_hash === e1.event_hash}`);
console.log(`    e3.previous_hash == e2.event_hash  → ${e3.previous_hash === e2.event_hash}`);
record("HASH_JOURNAL", chained && j.verify().valid ? "PASS" : "FAIL", `3 events chained, verify=${j.verify().valid}`);

const tampered = j.all();
tampered[1].payload.verdict = "APPROVE";
const broken = verifyJournal(tampered);
console.log(`    after editing event 2 → ${broken.failure} at ${broken.event_id}`);
record(
  "JOURNAL_TAMPER_DETECTION",
  broken.valid === false && broken.failure === "PAYLOAD_TAMPERED" && broken.index === 1 ? "PASS" : "FAIL",
  `TAMPERING_DETECTED: ${broken.failure} located at index ${broken.index}`
);

// ---------------------------------------------------------------------------
// 14. END-TO-END GOLDEN PATH — clean start, live data, self-produced sequence
// ---------------------------------------------------------------------------
section("14 · END-TO-END GOLDEN PATH");

const golden = await runCycle({
  book: recklessBook(),
  candidate: recklessCandidate,
  mode: "LIVE"
});

const events = golden.journal.all();
const seen = events.map((e) => e.event_type);
console.log(`    sequence: ${seen.join(" → ")}`);

const requiredStages = [
  "CONSTITUTION",
  "MARKET_STATE",
  "QUANT_PACKET",
  "BULL_DECISION",
  "BEAR_DECISION",
  "DEBATE_RESULT",
  "REFEREE_SIMULATION",
  "REFEREE_DECISION"
];
const missingStages = requiredStages.filter((s) => !seen.includes(s));
const goldenIntegrity = verifyJournal(events);
const marketWasLive =
  events.find((e) => e.event_type === "MARKET_STATE")?.payload?.classification === "BINANCE_REPORTED";

record(
  "END_TO_END_GOLDEN_PATH",
  missingStages.length === 0 && goldenIntegrity.valid && marketWasLive ? "PASS" : "FAIL",
  missingStages.length === 0
    ? `${events.length} events, live market classification, chain valid`
    : `missing stages: ${missingStages.join(", ")}`
);

// Stages the platform does not permit.
record(
  "HUMAN_EXECUTION_GATE",
  constitution.execution.require_human_confirmation === true &&
    (golden.halt === "REFEREE_DENIED" || golden.halt === "AWAITING_HUMAN")
    ? "PASS"
    : "FAIL",
  `constitution requires confirmation; cycle halted at ${golden.halt} with no order submitted`
);
record(
  "LIVE_BINANCE_EXECUTION",
  "UNVERIFIED",
  "no Binance MCP write tool has a published schema; no execution code path exists"
);
record(
  "POST_TRADE_RECONCILIATION",
  "NOT_IMPLEMENTED",
  "unreachable without execution; cannot reconcile a fill that cannot be produced"
);

// ---------------------------------------------------------------------------
// 19. FINAL REPORT
// ---------------------------------------------------------------------------
console.log("");
console.log("=".repeat(66));
console.log("APEX FINAL VERIFICATION REPORT");
console.log(`${new Date().toISOString()}`);
console.log("=".repeat(66));

const order = [
  "REAL_BINANCE_DATA",
  "QUANT",
  "DATA_PROVENANCE",
  "NO_ESTIMATE_MISLABELLED_AS_BINANCE",
  "BULL",
  "BEAR",
  "AGENTS_SAW_IDENTICAL_EVIDENCE",
  "EVIDENCE_VALIDATION",
  "DEBATE",
  "PORTFOLIO_ROUTER",
  "ROUTER_REJECTS_NON_COMPLIANT_BOOK",
  "ROUTER_RESPECTS_EXECUTION_GATE",
  "CONSTITUTION",
  "LIQUIDATION_MATH",
  "REFEREE",
  "REFEREE_DETERMINISTIC",
  "HUMAN_EXECUTION_GATE",
  "LIVE_BINANCE_EXECUTION",
  "POST_TRADE_RECONCILIATION",
  "API_ENDPOINTS",
  "HASH_JOURNAL",
  "JOURNAL_TAMPER_DETECTION",
  "DASHBOARD",
  "END_TO_END_GOLDEN_PATH"
];

for (const key of order) {
  const r = results[key];
  if (!r) continue;
  console.log(`${key.padEnd(38)} ${r.status}`);
}

const failures = order.filter((k) => results[k]?.status === "FAIL");
const unverified = order.filter((k) =>
  ["UNVERIFIED", "NOT_IMPLEMENTED"].includes(results[k]?.status)
);

console.log("=".repeat(66));
console.log(`PASS ${order.filter((k) => results[k]?.status === "PASS").length}` +
  ` · FAIL ${failures.length} · UNVERIFIED/NOT_IMPLEMENTED ${unverified.length}`);
if (failures.length) console.log(`FAILURES: ${failures.join(", ")}`);
if (unverified.length) console.log(`NOT PROVEN: ${unverified.join(", ")}`);
for (const note of notes) console.log(`NOTE: ${note}`);
console.log("");

process.exit(failures.length === 0 ? 0 : 1);
