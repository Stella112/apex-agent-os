# APEX — The Decision Layer Before the Trade

Most trading agents are built to act fast.

APEX is built to make them think twice.

APEX is an adversarial decision and risk layer for Binance Agent OS. It scans live Binance markets, finds potential opportunities, brings in news and sentiment, and challenges every idea before it reaches execution.

APEX does not replace Binance Agent OS. Binance Agent OS provides the authenticated Agentic account, live Binance account and market data, and user-confirmed trade execution. APEX works beside it as the independent intelligence, debate, and safety layer.

## What APEX does

APEX looks across:

- Spot markets
- Perpetuals and futures
- Meme assets
- Stock-linked assets
- Other supported Binance markets

Finding a signal is only the beginning. Every proposal goes through an agent council:

- **Bull** argues why the opportunity could work.
- **Bear** challenges the thesis and looks for failure points.
- **Constitution Referee** checks position size, leverage, concentration, loss limits, and liquidation risk.
- **Guardian** checks evidence freshness, authority, duplicate risk, and execution safety.

The result is not just `BUY` or `SELL`. APEX can approve, resize, deny, or block a proposal—with a clear explanation in plain language.

APEX is MCP-native and can run alongside compatible agents such as Codex, Claude, Cursor, VS Code, ChatGPT, and other agent environments. Users do not need to write JSON or understand internal tool names.

The intended flow is:

`APEX scans → Bull/Bear debate → Referee checks risk → Guardian protects the handoff → Binance Agent OS verifies → user confirms → Binance executes`

APEX never stores Binance API keys, never impersonates a Binance session, never enables withdrawals, and never trades silently. Every non-read action remains supervised and confirmation-gated.

This repository is a reviewable engineering build. Live provider availability, account binding, executable sizing, and write authorization are reported explicitly rather than simulated. See [REQUIREMENTS](REQUIREMENTS.md) and [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md).

## APEX products

APEX is a small agent stack, not only a dashboard:

1. **APEX Dashboard** — a live market workspace for the Binance universe,
   opportunity rankings, news and sentiment evidence, review forms, and visible
   decision records.
2. **APEX Binance Council Skill** — the reusable agent instruction package in
   `skills/apex-binance-council/SKILL.md`. It teaches Codex, Claude, Cursor,
   ChatGPT, Antigravity, and other compatible agents to call APEX first and
   keep analysis separate from execution.
3. **APEX MCP** — the analysis interface with `apex_status`,
   `apex_find_opportunities`, `apex_news_sentiment`, and `apex_review_trade`.
4. **APEX Council** — Bull, Bear, the deterministic Constitution Referee, and
   the independent Guardian safety firewall.
5. **Binance Skills + Binance MCP companion** — Binance's official account,
   authorization, balances, positions, bStocks, and user-confirmed execution
   layer. The official Binance Agentic Wallet skill is included at
   `skills/binance-agentic-wallet/`; APEX does not hold those credentials or
   impersonate the user's Binance session.

The product flow is:

`APEX Skill → APEX MCP → Bull → Bear → Referee → Guardian → Binance Skill/MCP → user confirmation`

Autopilot is intentionally a separate, opt-in REST path. It requires an explicit Constitution permission, a symbol allowlist, a per-order USDT cap, authenticated account reads, and both runtime write flags. Create `/opt/apex-agent/AUTOPILOT_STOP` on Qevor to block future autopilot orders immediately; existing Binance orders must still be cancelled through Binance separately.

## Run locally

Requires Node 22 or newer. No runtime dependencies.

```
npm test
node bin/smoke.mjs
node server.mjs
```

Default address: http://127.0.0.1:4173 . Use PORT to choose another port. The current review instance uses 4178. Stop a foreground server with Ctrl+C. Do not stop unrelated Node processes.

Copy .env.example to a private .env, configure only the providers you have authorized, and run `node --env-file=.env server.mjs`. Never commit credentials. Ollama Bull and the external Bear must both be configured for live analysis. Missing providers produce an unavailable state, never canned responses. Account figures in the form are manually supplied and are not exchange-verified balances.

## Verification and records

```
node bin/evaluate.mjs
node bin/record.mjs
node bin/record.mjs DECISION_ID
```

The evaluation is labeled SIMULATION and has no execution capability. The dashboard accepts live analysis only. Decisions persist in APEX_DATA_DIR (default data/decisions). The record command verifies local integrity and emits a sanitized checkpoint export; this is not a full deterministic replay archive.

Read [ARCHITECTURE](ARCHITECTURE.md), [VERIFICATION](VERIFICATION.md), [EVALUATION](EVALUATION.md), [DEMO](DEMO.md) and [operations](deploy.md). Older APEX audit documents are historical and do not establish current live capabilities.

Binance MCP remains the supervised Agent OS route. A server-side Binance Spot REST adapter is now present for authenticated account reads, but REST writes and autopilot remain disabled by default until Guardian limits, account binding and fill reconciliation are verified. Official MCP setup: https://developers.binance.com/en/docs/agent-native/mcp-server/agentic .

## APEX as a second MCP server

The official Binance MCP keeps the user's Binance authorization and any
user-approved execution, while APEX runs beside it as the decision, debate,
and risk layer.

Install the APEX skill package and add both servers to a supported MCP client:

```text
codex mcp add binance-mcp-server --url https://agent.binance.com/mcp/agentic
codex mcp add apex --url https://apexagent.site/mcp
```

The Binance server is the account-aware connector. APEX's /mcp endpoint is
read-only and provides apex_status, apex_find_opportunities,
apex_news_sentiment, and apex_review_trade. A user or agent can pass Binance
MCP market results into apex_review_trade as binance_market_data; APEX labels
that as caller-supplied evidence and never mistakes it for an authenticated
account book. APEX does not accept Binance API keys, does not impersonate
Binance, and does not submit orders.

The intended flow is:

Binance MCP authorization → Binance MCP market/account data → APEX MCP debate + Constitution + Guardian → user-approved action in Binance MCP

The APEX skill package is the reusable orchestration layer. The official
Binance Skills Hub companion is included in this repository for Binance-native
wallet actions and verified bStock product discovery. APEX displays bStocks as
their own verified product directory; it does not invent opportunity scores for
them or execute trades. Use Binance Agentic Wallet or Binance MCP for quotes,
account checks and user-confirmed execution.

On Vercel, configure the model providers required by apex_review_trade
separately. The public MCP remains safe when providers are unavailable: it
returns an explicit unavailable result rather than a canned verdict.
