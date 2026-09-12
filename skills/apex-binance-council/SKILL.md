---
name: apex-binance-council
description: Use APEX as the adversarial research, opportunity-scanning, and safety-review layer beside Binance Skills or Binance MCP.
---

# APEX Binance Council Skill

APEX is the decision layer for Binance-connected agents. It does not hold Binance
credentials and it does not replace Binance's authorization or execution tools.
Use this skill to gather evidence, expose disagreement, apply rules, and explain
the handoff before asking Binance to do anything.

## When to use it

Use APEX for finding and ranking opportunities across Binance-listed Spot and
Futures markets; checking funding, trend structure, volatility, liquidity,
order-book context, and recent matched news; reviewing a proposed trade; and
producing an evidence-backed decision record.

For Binance tokenized stocks (bStocks), use the bundled Binance Agentic Wallet
skill for the verified bStock directory, quotes, account checks, and execution.
Treat bStocks as tokenized products, not conventional equities. The APEX
dashboard may display verified bStock metadata separately, but its current
crypto opportunity scoring and portfolio review models do not apply to bStocks.

## Plain-language interface

Users should not need to know APEX tool names, JSON, symbols lists, or the
internal pipeline. Translate requests such as “find promising perpetuals,”
“what is moving SOL?”, or “should I consider this trade?” into the workflow
below automatically. Explain the result in normal language and show the Bull,
Bear, Referee, and Guardian sections when a review is run. Ask only for a
missing essential fact, such as the intended market or order size; never make
the user construct a tool call.

## Required order of operations

1. Call `apex_status` and confirm the APEX service boundary.
2. Call `apex_find_opportunities` for the requested universe or symbols.
3. Call `apex_news_sentiment` when news or sentiment could change the thesis.
4. If the user is considering an action, call `apex_review_trade` with the
   current book, proposal, and evidence. Show Bull, Bear, Constitution Referee,
   and Guardian separately.
5. For live account context, call the authorized Binance Skill or Binance MCP
   for balances, positions, and order state. Never infer private account data
   from APEX.
6. Only after the user understands the verdict and explicitly confirms, use the
   authorized Binance Skill or Binance MCP to submit an order. Re-check the
   exact symbol, side, quantity, price, and account immediately before any write.

## Tool boundaries

APEX provides `apex_status`, `apex_find_opportunities`, `apex_news_sentiment`,
and `apex_review_trade`. Binance Skills and Binance MCP are the account and
execution tools. A Referee `APPROVE` is not Binance authorization, and a
Guardian `BLOCK` must stop the handoff.

## Install alongside Binance

Add APEX MCP through the agent's MCP settings:

```text
https://apexagent.site/mcp
```

Add Binance's official Agentic MCP through the same client, then authenticate
through Binance. For clients that support the Skills CLI, Binance's official
Agentic Wallet skill can be installed with:

```bash
npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet
```

The official Binance skill is a companion for wallet and trading capabilities;
this APEX skill teaches the agent when to call APEX first and how to interpret
the council before handing off to Binance.

## Safety rules

- Never request, store, or paste Binance API keys into APEX.
- Never present a score as a guaranteed return or funding rate as guaranteed yield.
- Never hide unavailable market data or turn missing coverage into a neutral signal.
- Never submit an order from an APEX-only result.
- Keep human confirmation enabled for every Binance write unless the user has
  separately configured a clearly bounded, authorized automation policy.
