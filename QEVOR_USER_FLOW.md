# APEX user flow on Qevor

## What is live now

Qevor runs APEX continuously under PM2 as `apex-agent`. The service uses the host’s Ollama
installation (`qwen2.5:1.5b`) for the adversarial debate and public Binance market data for the
live evidence packet. The Referee is deterministic and fail-closed.

## Intended user journey

1. Open the APEX dashboard.
2. APEX is already connected to Binance Agent OS as part of the deployed agent.
3. Fund the dedicated Binance Agentic sub-account from Binance’s web UI.
4. Ask APEX to scan for funding carry and tactical opportunities, or choose a market yourself.
5. APEX reads the market and account state, asks Ollama for Bull and Bear views, and validates
   every claim against the shared evidence packet.
6. The Constitution Referee simulates the proposed fill. It approves, resizes, or denies it.
7. The user confirms the exact symbol, side, quantity, and price before Binance execution.
8. APEX monitors the order, reconciles the fill, and records the post-trade state.

## What the user sees

Agent OS is an implementation detail of the APEX deployment, not a setup task shown to users.
The current VPS build provides live opportunity discovery, Ollama analysis, and the deterministic
Constitution decision. The account-scoped execution adapter and post-trade reconciliation remain
the final integration boundary, so this build must not claim that a Binance order was placed.

The user must never paste Binance credentials, API keys, or MCP tokens into the APEX form or into
Ollama. Binance authentication belongs to Binance’s own consent flow, and the Ollama service is
kept on the VPS loopback interface.
