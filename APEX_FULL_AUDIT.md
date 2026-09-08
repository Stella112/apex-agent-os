# APEX full audit

Audit date: 2026-09-07

## Outcome

APEX now runs as a public, read-only market-intelligence and adversarial trade-review service. It scans live Binance market data, presents funding-carry and trend-watch conditions, incorporates matched news, runs independent Bull and Bear model calls, applies a deterministic Constitution Referee, and finishes with a Guardian execution-readiness check. Its MCP server exposes analysis tools only; it never holds Binance credentials or submits orders.

## Fixed

- Removed public Binance account/connect controls and prevented private account data from being exposed by the shared service.
- Retired public Binance REST and autopilot write routes with explicit `410` responses.
- Rebuilt the dashboard around Markets, Agent review, and Decision record workflows.
- Added a visible live Agent council panel on Markets so Bull, Bear, Referee and Guardian are not hidden inside the activity view.
- Added a full Binance Spot + USDⓈ-M universe index; the dashboard currently reports 4,461 symbols / 1,602 unique assets while keeping detailed route scoring to a reliable liquid batch.
- Added a complete `/docs` guide for APEX MCP plus the separate official Binance MCP.
- Replaced the hard-coded scan universe with a liquid-USDT universe sourced from live Binance data.
- Corrected funding annualization to use each instrument's funding interval.
- Prevented missing or non-finite market inputs from becoming fabricated opportunities.
- Corrected multi-position valuation to fetch live marks for every held supported symbol.
- Added live news matching, freshness labels, source links, and honest social-data availability.
- Added MCP protocol negotiation and strict schemas for all four read-only tools.
- Added structured Ollama output, bounded prompts, serialization, and fail-closed validation.
- Added Guardian audit events to the hash-linked journal.
- Added a browser timeout long enough for a cold local-model inference.

## Verification

- Automated suite: 121 tests passing.
- Live scanner: 12 liquid markets, 24 ranked routes, 0 unavailable reads during browser verification; full universe index: 4,461 symbols across Spot and USDⓈ-M Futures.
- Live news: fresh matched headlines rendered with source links.
- Live model cycle: Bull valid, Bear valid, Referee `APPROVE`, Guardian `BLOCK` because no Binance execution authority was supplied.
- Public service: `http://38.49.209.149:4174/`
- APEX MCP: `http://38.49.209.149:4174/mcp`

## Intentional limits

- APEX does not submit Binance orders. A user's agent connects to APEX MCP for analysis and Binance MCP separately for account/trading actions.
- The public scanner samples 12 liquid USDT pairs per run; it does not claim coverage of every Binance product.
- Full portfolio review currently models BTCUSDT and ETHUSDT USD-M cross-margin estimates.
- News sentiment is headline classification, not broad social consensus.
- The temporary MCP endpoint is HTTP. Add a domain and HTTPS before presenting it as a generally compatible production endpoint.
- Cross-server enforcement cannot be guaranteed by APEX. The agent must explicitly call APEX before Binance and obey Binance's own confirmation flow.
