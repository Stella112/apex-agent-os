# APEX demo script

Use the public dashboard at `http://38.49.209.149:4174/dashboard` and record only what the live run shows. Keep the dashboard and your agent chat visible together. Do not show `.env` files, API keys, or execute a real trade during the recording.

## Two-minute recording

### 0:00–0:20 · What APEX is

**On screen:** Open the APEX landing page.

**Say:**

> APEX is a decision layer for trading agents.
>
> It watches Binance markets, finds potential opportunities, checks the news, and helps an agent decide whether a trade actually makes sense.
>
> APEX does not hold your Binance keys or trade by itself. It helps an AI think twice before real money moves.

### 0:20–0:45 · Find opportunities

**On screen:** Open Markets and click Refresh.

**Say:**

> Here, APEX scans live Binance market data and organizes the results into separate Spot, Perpetuals and Futures, Meme, Stock-linked, and Other tables.
>
> Each result has a condition, status, score, price, and an Inspect button. These scores rank conditions; they are not promises of profit.

### 0:45–1:00 · News and sentiment

**On screen:** Show News & Sentiment and click Refresh.

**Say:**

> APEX also matches fresh public headlines to the symbols it scanned. Each headline shows its source and time.
>
> This is evidence for the decision, not social consensus or a trade instruction.

### 1:00–1:30 · The council

**On screen:** Open Agent review and submit a small example proposal. Use clearly labeled demo values and do not execute.

**Say:**

> When I ask APEX to review a trade, Bull explains why it could work. Bear challenges the same evidence and looks for what could go wrong.
>
> The Referee then checks the actual risk: position size, leverage, concentration, losses, and liquidation distance.
>
> Guardian checks freshness, authority, duplicate risk, and safety. It can block the handoff even when the trade idea looks attractive.

### 1:30–1:50 · The handoff

**On screen:** Show the completed Bull, Bear, Referee, and Guardian results, then open the Docs page.

**Say:**

> APEX gives the agent a clear, evidence-based verdict. It can approve, resize, deny, or block a proposal.
>
> If I choose to continue, Binance MCP handles the account and asks for my confirmation before execution. APEX never receives my Binance login or API key.

### 1:50–2:00 · Close

**On screen:** Return to the APEX logo or landing page.

**Say:**

> APEX turns a fast signal into an accountable decision: research the market, challenge the trade, and check the risk before anything happens.

## Recording checklist

- Use the current public dashboard and show the build identity.
- Demonstrate plain-language requests; users do not need to write JSON or name internal tools.
- Show the separate opportunity tables and the live news timestamp.
- Show Bull, Bear, Referee, and Guardian results from the same review.
- State clearly that the demo is analysis-only unless Binance MCP execution is separately and visibly authorized.
- Never show secrets, API keys, account balances, or private environment files.
