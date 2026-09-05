# APEX_REPOSITORY_AUDIT

Phase 0 deliverable. Audit performed 2026-09-05 against the working tree at `C:\Binance`.

---

## 1. Existing architecture

| Layer | Files | State |
|---|---|---|
| HTTP server | `server.mjs` | Working static file server, no API routes |
| Risk engine | `src/referee.mjs`, `src/config.mjs`, `src/portfolio.mjs` | Working, 13 passing tests |
| Market data | `src/market.mjs` | Working, live Binance public REST |
| Tests | `test/referee.test.mjs` | 13 tests, all passing |
| PROMETHEUS UI | `public/index.html`, `app.js`, `styles.css` | Hardcoded mockup |
| APEX UI | `public/apex.html`, `apex.js`, `apex.css` | Hardcoded mockup |

Runtime is Node.js v26.4.0. No package manager lockfile, no dependencies, no Docker, no
database, no environment configuration, no authentication, no deployment setup. `package.json`
declares only a `start` script and is missing a `test` script.

The repository is **not** under git control. This is a submission blocker for Track A, which
requires a GitHub link.

---

## 2. Reusable code

Three modules carry real value and should survive the APEX rebuild:

**`src/referee.mjs`** — Cross-margin liquidation solved numerically by bisection over the
maintenance-margin bracket step function, plus seven deterministic gates and a binary-search
resize. This already satisfies most of spec sections 24, 25 and 26. It needs provenance
labelling (section 9) and a Constitution binding (sections 22 and 23) bolted on.

**`src/portfolio.mjs`** — Immutable candidate application with correct weighted-average entry
on adds and correct handling of reduces and flips. Verified by test.

**`src/market.mjs`** — Live unauthenticated Binance REST reads with retry. Produces real
order-book imbalance, realized volatility, funding and open interest. Needs wrapping in the
provenance envelope required by section 12.

---

## 3. Conflicts

**C-1. Both UIs fabricate data and present it as live.** This is the most serious finding.
`apex.html` hardcodes a "MCP CONNECTED" badge, a "hash chain valid" claim, a portfolio value,
a liquidation distance of 18.6%, and a BTC mark of $108,420.60. None of it is computed. The
live mark at audit time was near $79,650, so the displayed price is wrong by roughly 36%.
Under spec sections 1, 13 and 31 this must be rewired to real values with provenance labels,
or explicitly marked `SIMULATION`.

**C-2. Two competing product identities.** PROMETHEUS (self-funding signal business) and APEX
(adversarial portfolio engine) both exist and are cross-linked in `README.md`. The APEX spec
supersedes PROMETHEUS. Keeping both dilutes the submission and doubles the surface to keep
honest.

**C-3. `README.md` describes six PROMETHEUS adapters that do not exist.** The document
describes planned architecture in the present tense.

**C-4. My earlier `POLICY` object versus the spec's `config/constitution.yaml`.** The spec
requires a YAML Constitution with an id, version and SHA-256 recorded on every decision. The
current policy is a plain JavaScript object with no identity or hash. Limits also differ: my
`maxGrossLeverage` is 3.0 against the spec's `max_leverage: 2`, and my `maxDailyLoss` is 5%
against the spec's `daily_loss_lock_pct: 3`. The Constitution must become the single source.

---

## 4. Missing components

Against the APEX specification, absent entirely:

- Provenance envelope and freshness state machine (section 12)
- Liquidation provenance classification (section 9)
- Capability adapters (section 7)
- Quant engine as a distinct evidence packet (section 14)
- Bull agent, Bear agent, evidence validator (sections 16 to 18)
- Debate router and portfolio router (sections 20 and 21)
- Constitution file, versioning and hashing (sections 22 and 23)
- Hash-linked journal and `verify_journal()` (section 35)
- Execution gate, preview and reconciliation (sections 28, 32 to 34)
- Simulation mode isolation (section 29)
- Killer referee fixture (section 30)
- Anti-hallucination test suite (section 41)
- Any API surface on `server.mjs`

---

## 5. Technical debt

- No `test` script in `package.json`; `node --test test/` fails on Windows and needs an
  explicit file glob or directory handling.
- `server.mjs` has path-traversal protection but no API layer, no error typing, no logging.
- Maintenance-margin brackets in `config.mjs` are a static table. The authenticated
  `/fapi/v1/leverageBracket` endpoint is the real source. This is documented in the file but
  makes every liquidation figure an estimate, never a reported value.
- `market.mjs` returns bare numbers with no timestamps or freshness, so nothing downstream can
  reason about staleness.

---

## 6. Security concerns

- No secrets currently exist in the tree, which is the correct starting state.
- No `.gitignore`. Before `git init`, one must exist covering `.env`, credentials and
  `node_modules`, or the first commit risks leaking whatever is added later.
- The server binds `127.0.0.1` only. Correct for a demo.
- No input validation exists because no API surface exists yet. Validation must be built in
  from the first route, not retrofitted.
- Both UIs would happily render any number handed to them. Once real account data flows, the
  front end must never receive credentials, only computed values.

---

## 7. Recommended implementation sequence

1. `git init`, `.gitignore`, `package.json` test script. Unblocks the submission requirement.
2. Constitution file with id, version and SHA-256. Everything downstream references it.
3. Provenance envelope and freshness thresholds. Every later value is born wrapped.
4. Liquidation provenance classification plus acceptance tests A to F.
5. Quant engine emitting a keyed evidence packet.
6. Evidence validator, then Bull and Bear against the same packet.
7. Debate router, portfolio router.
8. Referee bound to the Constitution, emitting rule-level results.
9. Hash-linked journal with `verify_journal()`.
10. Execution gate and preview. No live writes.
11. Killer fixture, then rewire the APEX UI to real endpoints.
12. Anti-hallucination tests.

Steps 1 to 9 constitute a complete, honest, submittable system. Steps 10 to 12 make it
demonstrable.

---

## 8. Decision on existing UIs

`public/apex.html` is retained as a **visual design target only**. Its markup is a useful
layout reference. Every value in it is fabricated and must be replaced by a provenance-wrapped
value from the API before it is shown to a judge or recorded in a video.
