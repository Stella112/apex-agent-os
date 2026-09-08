# Operations — prepared, not deployed

Use Node 22+, bind to 127.0.0.1, and keep one process per private data directory. Run `node --env-file=.env server.mjs`; Ctrl+C stops that foreground process. The existing Qevor convention is PM2 apex-agent under /opt/apex-agent with private Ollama on localhost. Do not expose Ollama publicly.

The supplied environment example names the provider settings. Confirm model availability with the private Ollama tags endpoint; successful inference is a separate check. External Bear needs an exact HTTPS chat-completions endpoint, model and server-side key. The optional Binance REST adapter reads `BINANCE_API_KEY` and `BINANCE_API_SECRET` only on the server; `BINANCE_REST_WRITES` and `BINANCE_AUTOPILOT_ENABLED` must remain false until Guardian limits, account binding and reconciliation are verified. `BINANCE_LIVE_EXECUTION` cannot unlock this checkpoint.

Before a future authorized deployment: capture the current release and sanitized configuration inventory, back up the private data directory, stage the candidate separately, run regression/smoke checks, verify the candidate build ID, then restart only apex-agent. Check /api/identity and /api/health. Keep the previous release for rollback and restore it if readiness regresses. Do not overwrite private credentials or records. The old deploy-qevor.ps1 is a legacy direct-copy script, not a verified release/rollback mechanism; do not use it for this candidate without revision.

Back up data while the single writer is stopped. Restore to an empty private directory with the same ownership, run bin/record.mjs and verify each relevant record. Revised journal hashing is not compatible with all historical records; retain old records unchanged with their original verifier. A self-contained chain needs an external trusted checkpoint to detect complete rewriting or truncation.

Logs: terminal stderr/stdout locally, PM2 logs for the existing deployed service. Do not log credentials or raw authorization headers. Readiness requires real market data, both model responses and eventually a verified account bridge; process liveness is insufficient.

No deployment, rollback, backup restoration or container run was performed during this repair pass. The Dockerfile and legacy deployment script need additional validation for the new writable data path.
