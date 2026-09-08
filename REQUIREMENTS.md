# Requirement and evidence matrix

Current assessment: 2026-09-06. Supersedes historical capability claims in APEX_IMPLEMENTATION_AUDIT.md and APEX_REPOSITORY_AUDIT.md. VERIFIED means the named local behavior was tested, not that the external integration is operational.

| ID | Expected behavior | Status | Implementation / evidence | Remaining work |
|---|---|---|---|---|
| R01 | Decision desk preserves APEX identity | PARTIAL | public/apex.*; browser review on port 4178 | Complete connected-account journey |
| R02 | No unauthorized trades or payments | VERIFIED | HTTP confirmation blocked; bin/smoke.mjs; no payment signer | Retain lock until authenticated execution is verified |
| R03 | Reproducible baseline | VERIFIED | Base commit 0daaa7ea768507c0bf9cfd4a534be3c03841665a; dirty worktree preserved; /api/identity | Use runtime build hash, not base commit alone |
| R04 | Distinct component authority | PARTIAL | cycle, external-model, execution, purchase-policy modules | Bind production adapters to authenticated sessions |
| R05 | Honest quantitative evidence | PARTIAL | Missing inputs no longer become zero; candle sequence checks; provenance categories | Per-field event times, complete payload retention, funding-period validation and consistent market inputs |
| R06 | Portfolio-aware deterministic Referee | PARTIAL | Existing suite + realized P&L and invalid-input regressions | Wire fixed-point fees/exchange rounding to Referee; pending orders; current derivatives metadata; order-percent enforcement |
| R07 | Bound execution and reconciliation | PARTIAL | execution.mjs mock tests cover identity, reservation, ambiguity and restart | Production session/account binding, schema validation and real reconciliation BLOCKED |
| R08 | Ollama Bull and external Bear | PARTIAL | Live canned fallback removed; separate provider contracts; Qevor model list retrieved | Bear provider credential/model; verified Bull/Bear inference |
| R09 | Bounded narrative evidence | PARTIAL | narrative.mjs dedup/date/entity tests; attachNarrative seam in cycle | Configure/retrieve sources, stronger syndication handling, live relevance evaluation |
| R10 | Optional verified x402 purchase | PARTIAL | purchase-policy.mjs tests; no signing or spending | Real quote/wallet/settlement/delivery adapter and spending authorization missing |
| R11 | Durable inspectable records | PARTIAL | Atomic record replace; digest and journal verification; bin/record.mjs | Full sanitized replay export, multi-process locking and trusted external checkpoints |
| R12 | Working responsive UI | PARTIAL | Browser desktop/mobile inspection; missing-provider journey; no console errors observed | Successful live journey and final comprehensive responsive review |
| R13 | Honest scenarios/evaluation | PARTIAL | bin/evaluate.mjs: 16 synthetic cases, 6 APPROVE / 5 RESIZE / 5 DENY | Single analyst, Bull/Bear and full-pipeline comparisons not measured |
| R14 | Failure regression tests | PARTIAL | 104 tests passed before final check; HTTP smoke passed | Broader schema, execution-state, payment settlement and provider integration coverage |
| R15 | Operations/submission candidate | PARTIAL | README, ARCHITECTURE, VERIFICATION, DEMO, EVALUATION and limitations | Deployment, recording and submission not performed |
| R16 | Independent execution preflight | VERIFIED locally | `src/guardian.mjs`, `GUARDIAN_PREFLIGHT` journal event, Guardian dashboard panel and regression tests | Bind the checks to a verified production account/session before enabling real writes |

Priority: execution/account authority and market-specific arithmetic first; real provider verification next; narrative/payment expansion afterward. No Python Quant or Referee exists: both are Node modules. This is a documented specification discrepancy, not a language migration.
