# APEX_IMPLEMENTATION_AUDIT

Produced under the verification-first directive. Every status below was determined by
running the system on 2026-09-05, not by reading source code.

Reproduce with:

```bash
npm start          # in one terminal
node bin/verify.mjs
```

Status vocabulary is exactly as the directive defines it. No status such as "mostly complete"
appears anywhere in this document.

---

## 1. Feature classification

| Feature | Status | Evidence |
|---|---|---|
| Binance public market data | `VERIFIED_LIVE` | `fetchMarketContext` returned BTCUSDT mark 79685.46, bid 79724, ask 79724.01, funding 0.00002099 at 15:28:22Z, age 0 ms |
| Application-level DNS resolution | `VERIFIED_LIVE` | `probeReachability` 738 ms via `apex-resolver`; system resolver refuses these hostnames |
| Quant engine | `VERIFIED_LIVE` | 34 evidence keys built from the live read above |
| Provenance envelope | `VERIFIED_LIVE` | raw `price.mark` = BINANCE_REPORTED/binance; derived `price.spread_bps` = APEX_ESTIMATE with formula retained |
| Estimate/reading separation | `VERIFIED_LIVE` | zero APEX-derived fields claim Binance as source, checked across all 34 keys |
| Bull agent | `VERIFIED_LIVE` | `deterministic-bull` v1.0.0, 4 validated claims on live packet |
| Bear agent | `VERIFIED_LIVE` | `deterministic-bear` v1.0.0, 4 validated claims on the same packet |
| Identical-evidence guarantee | `VERIFIED_LIVE` | both agents recorded `input_hash c653985ee6e49541…` |
| Evidence validator | `VERIFIED_LIVE` | 14 live citations resolved; injected `market.ema_200` returned UNSUPPORTED_CLAIM |
| Debate router | `VERIFIED_LIVE` | classified DIRECTIONAL on live disagreement |
| Constitution load, validate, hash | `VERIFIED_LOCAL` | `apex-v1` v1.0.0, sha256 `604ebd6af983fe2d…`, stamped on every verdict |
| Referee DENY path | `VERIFIED_LOCAL` | reckless fixture denied on 5 rules with observed, limit and operator each printed |
| Referee ALLOW path | `VERIFIED_LOCAL` | safe fixture returned APPROVE against the same Constitution |
| Referee determinism | `VERIFIED_LOCAL` | identical inputs reproduce an identical rule-by-rule verdict, no model call |
| Liquidation math | `VERIFIED_LOCAL` | all six acceptance classifications distinct; solver agrees with closed form to 1 cent |
| Hash-linked journal | `VERIFIED_LOCAL` | 3 events chained, `e2.previous_hash == e1.event_hash` confirmed |
| Journal tamper detection | `VERIFIED_LOCAL` | editing event 2 produced PAYLOAD_TAMPERED at index 1 |
| HTTP API | `VERIFIED_LIVE` | 4/4 endpoints returned 200, no 404s |
| Dashboard data path | `VERIFIED_LIVE` | all five panels populated from `/api/cycle`; no hardcoded market values remain in source |
| Human execution gate | `VERIFIED_LOCAL` | cycle halted at REFEREE_DENIED; no code path submits an order |
| End-to-end golden path | `VERIFIED_LIVE` | 9-event sequence from a clean start against live data, chain valid |
| Reckless proposal fixture | `SIMULATION` | labelled DETERMINISTIC SAFETY FIXTURE, classification SIMULATION throughout |
| Safe proposal fixture | `SIMULATION` | labelled DETERMINISTIC SAFE FIXTURE |
| Captured market replay | `SIMULATION` | `market-context.captured.json`, clock rebased, every field classified SIMULATION |
| Account state (balances, positions) | `ADAPTER_ONLY` | `/api/account` returns CAPABILITY_UNAVAILABLE; the book in use is a fixture |
| Binance MCP tools | `UNVERIFIED` | endpoint returns HTTP 401 with RFC 9728 pointer; no published tool schema |
| Binance-reported liquidation | `UNVERIFIED` | requires an Account-scope tool that has no verified schema |
| Live Binance execution | `NOT_IMPLEMENTED` | deliberate: writing against a guessed schema would violate directive section 1 |
| Order status and fill retrieval | `NOT_IMPLEMENTED` | unreachable without execution |
| Post-trade reconciliation | `NOT_IMPLEMENTED` | cannot reconcile a fill that cannot be produced |
| Portfolio router (scored routes) | `VERIFIED_LIVE` | 5 routes scored on live data; compliant book gave CARRY -31.44, REVERSE_CARRY -22.29, DIRECTIONAL -5.09, PARK 0.00 bps; PARK selected |
| Router breach rejection | `VERIFIED_LIVE` | an over-concentrated book rejected all three position routes, citing "name exposure 159.44% exceeds the 15% cap" |
| Router execution gate | `VERIFIED_LOCAL` | with execution unverified, only PARK and STAND_DOWN are selectable |
| x402 payments | `NOT_IMPLEMENTED` | out of scope at P2; no code exists |
| PROMETHEUS UI (`index.html`, `app.js`) | `MOCK` | superseded static mockup, retained but not served by default |

---

## 2. The Golden Path, arrow by arrow

Directive section 3 requires every arrow to be either `VERIFIED_LIVE` or explicitly
`SIMULATION`, with no ambiguous middle state.

| Arrow | Status |
|---|---|
| BINANCE → LIVE MARKET DATA | `VERIFIED_LIVE` |
| LIVE MARKET DATA → QUANT ENGINE | `VERIFIED_LIVE` |
| QUANT ENGINE → BULL + BEAR | `VERIFIED_LIVE` |
| BULL + BEAR → DEBATE | `VERIFIED_LIVE` |
| DEBATE → PORTFOLIO ROUTER | `VERIFIED_LIVE` |
| PORTFOLIO ROUTER → CONSTITUTION | `VERIFIED_LIVE` |
| CONSTITUTION → REFEREE | `VERIFIED_LIVE` |
| REFEREE → EXECUTION PREVIEW | `VERIFIED_LIVE` |
| EXECUTION PREVIEW → HUMAN CONFIRMATION | `VERIFIED_LOCAL` |
| HUMAN CONFIRMATION → BINANCE EXECUTION | `NOT_IMPLEMENTED` |
| BINANCE EXECUTION → ORDER STATUS | `NOT_IMPLEMENTED` |
| ORDER STATUS → FILL / REJECTION | `NOT_IMPLEMENTED` |
| FILL → POST-TRADE ACCOUNT STATE | `NOT_IMPLEMENTED` |
| every stage → HASH-LINKED JOURNAL | `VERIFIED_LIVE` |

The path is unbroken and verified from Binance through to the journal. It terminates at the
human confirmation gate. The four arrows beyond that gate are not built.

**The position on the book is a fixture.** Market data is live; the portfolio APEX reasons
about is not, because no Account-scope tool has a verified schema. This is the single most
important qualification in this document.

---

## 3. Definition of Done, clause by clause

Directive section 18 requires a single sentence to be true. Assessed clause by clause:

| Clause | True? |
|---|---|
| "start the application from a clean state" | Yes |
| "retrieve verified Binance data" | Yes, public market data |
| "produce a provenance-preserving Quant packet" | Yes |
| "run Bull and Bear reasoning over that exact packet" | Yes, proven by matching input hash |
| "deterministically evaluate the proposal with the Referee" | Yes |
| "require human authorization" | Yes |
| "execute through the verified Binance integration when live mode is enabled" | **No** |
| "reconcile the actual result" | **No** |
| "record the complete sequence in a tamper-evident journal" | Yes |

**APEX IS NOT COMPLETE.** Two clauses are false: live execution and post-trade reconciliation.

Both are false for the same reason, and it is not a scheduling problem. Binance publishes no
tool names, no input schemas and no output schemas for the MCP write surface. Directive section
1 forbids inventing them and section 15 forbids treating a simulated fill as a real one.
Implementing execution would require guessing an API, which is the exact failure the directive
exists to prevent.

The honest label is `LIVE_EXECUTION_UNVERIFIED`, as section 9 provides for.

---

## 4. What would change these statuses

| To move | You need |
|---|---|
| ~~`PORTFOLIO_ROUTER`~~ | done: implemented, tested and verified on live data |
| `LIVE_BINANCE_EXECUTION` to `VERIFIED_LIVE` | OAuth into `agent.binance.com/mcp/agentic`, enumerate the real tool list, then implement against the observed schema |
| `Binance-reported liquidation` to `VERIFIED_LIVE` | the same, plus an Account-scope tool that returns a liquidation price |
| Account state from `ADAPTER_ONLY` | the same Account-scope tools |
| `PORTFOLIO_ROUTER` to implemented | no external dependency; this is buildable now |

The router has since been built, so every remaining gap is gated on OAuth access this
environment does not have. Nothing further can be honestly implemented without it.

---

## 5. Stale-process finding

Directive section 10 required identifying, not guessing, what owned port 4173.

| Field | Value |
|---|---|
| PID | 23928 |
| Command | `node server.mjs` |
| Executable | `C:\Program Files\nodejs\node.exe` |
| Started | 2026-09-05 13:57:18 |
| `server.mjs` last modified | 2026-09-05 15:56:19 |
| Gap | the process predated the file by 119 minutes |

It was serving in-memory code from before the API existed, which is why every `/api/*` request
returned "Not found" and the dashboard rendered empty. The process was stopped, the current
application started, and all four endpoints then returned 200. This was a stale process, not a
wiring defect.


---

## 6. Router correctness fix

The first working router produced scores near -450 basis points for every position route. The
cause was a genuine design error rather than a bug in arithmetic: penalties were linear and
unbounded, so a book already past a hard limit generated a penalty that swamped every other
component. A book at ten times its concentration cap produced a 405 basis point charge on its
own.

Being past a hard limit is not a penalty, it is a rejection. Two changes followed:

- A book that already breaches a Constitution limit now rejects every position-taking route,
  naming the breach. The Referee would deny such a proposal regardless, so scoring it would
  imply an availability that does not exist.
- Utilisation is clamped at 1, capping each penalty at 20 basis points, so penalties express
  approaching a limit rather than exceeding one.

Scores on a compliant book are now in a legible range, and PARK winning at 0.00 bps against
negative-scoring alternatives is the economically correct answer in current conditions.

---

## 7. Reachability probe fix

One verification run reported REAL_BINANCE_DATA as FAIL, which correctly cascaded UNVERIFIED
through eight downstream checks. The cause was a cold TLS handshake exceeding a single eight
second attempt; an immediate retry connected in 1155 ms.

A single-shot probe gating the entire harness is a false negative. The probe now retries three
times with backoff and reports every failure. Only a genuine inability to connect is recorded
as unreachable.

The cascade itself was correct behaviour and was left unchanged: when live data is absent,
every downstream claim must become UNVERIFIED rather than silently falling back to fixtures.
