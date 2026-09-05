# BINANCE_CAPABILITIES

Phase 1 deliverable. All entries reflect direct testing from this machine on 2026-09-05,
or the absence of an authoritative source. Nothing in this table is assumed.

Status vocabulary: `VERIFIED` (tested, worked), `BLOCKED` (tested, refused),
`UNVERIFIED` (no authoritative schema found), `UNAVAILABLE` (documented as not existing).

---

## 1. Headline findings

**F-1. The Agentic MCP endpoint exists and requires OAuth.** A `tools/list` JSON-RPC probe to
`https://agent.binance.com/mcp/agentic` returned `HTTP 401` with:

```
WWW-Authenticate: Bearer resource_metadata="https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp"
```

Following that pointer returns a valid RFC 9728 protected-resource document naming
`https://agent.binance.com` as the authorization server. The endpoint and its auth scheme are
therefore `VERIFIED`. Its **tool list is not**, because the tool list is behind the OAuth wall.

**F-2. No authoritative source publishes the MCP tool schemas.** The official documentation at
`developers.binance.com/en/docs/agent-native/mcp-server` and its `/agentic` sub-page describe
permission *categories* (Market Data, Account, Trade, Transfer) in prose. They do not publish
tool names, input schemas, or output schemas. Per spec section 1, every MCP tool is therefore
`UNVERIFIED` and every one sits behind an adapter that fails closed.

**F-3. Binance REST is geo-restricted from this machine, intermittently.** At 12:29 UTC six
public endpoints returned real data. At 14:19 UTC every endpoint, including `/api/v3/ping`,
returned:

> Service unavailable from a restricted location according to 'b. Eligibility'

A 12-call sample at 14:22 UTC returned 12 restrictions and 0 successes. This is a hard
constraint on the build, not a transient error to retry past.

---

## 2. Capability matrix

### Market data

| Capability | Source | Actual API | Read/Write | Tested | Status |
|---|---|---|---|---|---|
| Ticker 24h | Binance public REST | `GET /api/v3/ticker/24hr` | Read | Yes | `BLOCKED` (worked 12:29, refused 14:19) |
| Order book | Binance public REST | `GET /api/v3/depth` | Read | Yes | `BLOCKED` (same pattern) |
| Candles | Binance public REST | `GET /api/v3/klines` | Read | Yes | `BLOCKED` (same pattern) |
| Recent trades | Binance public REST | `GET /api/v3/trades` | Read | Yes | `BLOCKED` (same pattern) |
| Mark price and funding | Binance futures REST | `GET /fapi/v1/premiumIndex` | Read | Yes | `BLOCKED` (same pattern) |
| Open interest | Binance futures REST | `GET /fapi/v1/openInterest` | Read | Yes | `BLOCKED` (same pattern) |
| Symbol filters | Binance public REST | `GET /api/v3/exchangeInfo` | Read | Yes | `BLOCKED` |
| Predicted funding | none found | — | — | No | `UNVERIFIED` |
| Market data via MCP | Binance MCP | tool name unknown | Read | No | `UNVERIFIED` |

Observed field shapes, captured while reachable at 12:29 UTC, are recorded in
`fixtures/market-context.captured.json` and are labelled `SIMULATION` when replayed.

### Account

| Capability | Source | Actual API | Read/Write | Tested | Status |
|---|---|---|---|---|---|
| Balances | Binance MCP, Account scope | tool name unknown | Read | No | `UNVERIFIED` |
| Positions | Binance MCP, Account scope | tool name unknown | Read | No | `UNVERIFIED` |
| Leverage and margin mode | Binance MCP, Account scope | tool name unknown | Read | No | `UNVERIFIED` |
| Entry price | Binance MCP, Account scope | tool name unknown | Read | No | `UNVERIFIED` |
| **Liquidation price** | Binance MCP, Account scope | tool name unknown | Read | No | `UNVERIFIED` |
| Unrealized PnL | Binance MCP, Account scope | tool name unknown | Read | No | `UNVERIFIED` |
| Maintenance-margin brackets | Binance futures REST | `GET /fapi/v1/leverageBracket` | Read | No | `UNVERIFIED` (requires signature) |

### Execution

| Capability | Source | Actual API | Read/Write | Tested | Status |
|---|---|---|---|---|---|
| Create order | Binance MCP, Trade scope | tool name unknown | Write | No | `UNVERIFIED` |
| Cancel order | Binance MCP, Trade scope | tool name unknown | Write | No | `UNVERIFIED` |
| Order status | Binance MCP, Trade scope | tool name unknown | Read | No | `UNVERIFIED` |
| Fills | Binance MCP, Trade scope | tool name unknown | Read | No | `UNVERIFIED` |
| Transfer within sub-account | Binance MCP, Transfer scope | tool name unknown | Write | No | `UNVERIFIED` |
| **External withdrawal** | Official docs, explicit | — | — | n/a | `UNAVAILABLE` by design |

### Products

Documentation names Spot, Margin, Convert, USDⓈ-M Futures and COIN-M Futures as supported.
None is verified at the tool level. Options and Quarterly Futures are not mentioned and are
treated as `UNAVAILABLE` until proven otherwise. APEX implements **no** product-specific
execution path until its tool schema is verified.

---

## 3. Liquidation strategy decision (spec section 8)

The eight questions, answered honestly:

1. **Does Binance directly report liquidation price?** `UNVERIFIED`. The Account scope plausibly
   exposes it, but no schema is published and the wall is OAuth-gated.
2. **For which product?** Unknown. Liquidation mechanics differ between USDⓈ-M and COIN-M, and
   between isolated and cross margin.
3. **Position-specific?** Unknown for the MCP surface.
4. **What inputs does Binance expose?** Wallet balance, position quantity, entry price and mark
   price are all plausibly available, but unconfirmed.
5. **Can APEX reproduce the calculation?** Yes, for USDⓈ-M cross margin, given wallet balance,
   signed position quantity, entry price, mark price and the maintenance-margin bracket table.
   This is implemented and tested in `src/referee.mjs`.
6. **Does leverage or margin mode change it?** Yes. The implemented model is **cross margin
   only**. Isolated margin is a different calculation and is not implemented.
7. **Does isolated versus cross change it?** Yes, materially. See above.
8. **What assumptions are required?** Recorded as `liq-v1` assumptions below.

### Formula `liq-v1`

Cross-margin USDⓈ-M. Liquidation is the price at which account equity meets the maintenance
margin requirement:

```
equity(P)      = walletBalance + Σ qty_i × (P_i − entry_i)
maintenance(P) = Σ max(0, |qty_i| × P_i × mmr(notional_i) − deduction(notional_i))
liquidation    = the P where equity(P) = maintenance(P)
```

Solved by bisection because `mmr` is a step function of notional, so the relation is piecewise
linear rather than closed-form. Verified against a closed-form single-position case to within
one cent in `test/referee.test.mjs`.

**Assumptions, all of which must be disclosed with any value produced:**

- `A1` Cross margin. Isolated margin is not modelled.
- `A2` Maintenance-margin brackets come from a static table, not the account's live
  `leverageBracket` response. Non-standard accounts will differ.
- `A3` USDⓈ-M linear contracts. COIN-M inverse contracts are not modelled.
- `A4` No open orders are considered, only filled positions.
- `A5` Funding, fees and the insurance-fund clawback are excluded.
- `A6` Only the named symbol's price varies. Other marks are held fixed.

**Consequence.** Because `A2` alone breaks the tie to the real account, every liquidation value
APEX produces is classified `APEX_ESTIMATE`. APEX cannot emit `BINANCE_REPORTED` until an
Account-scope tool is verified and returns the value directly.

---

## 4. Conflicts between sources

**K-1.** Press coverage states agents run with "no built-in cap on trading losses" while
official docs stress permission scoping and the absence of withdrawal. These are not in
conflict. They describe different things: the platform bounds *where* funds can go, not *how
much* can be lost. This gap is APEX's entire reason to exist and is stated as such.

**K-2.** Prize structure differs between the announcement post and secondary reporting.
Immaterial to the build.

No unresolved conflict blocks implementation.

---

## 5. Consequences for the build

1. **No live market data path can be trusted from this machine.** The `MarketDataProvider`
   must return `UNAVAILABLE` with a reason, and the system must fail closed to `NO NEW RISK`
   per spec section 27.
2. **The demo cannot depend on live data.** The killer fixture of spec section 30 is therefore
   mandatory, and must be labelled `DEMO FIXTURE / SIMULATION` exactly as section 31 requires.
3. **No live execution path will be implemented.** Writing code against an unverified schema
   would violate spec section 1. `BinanceExecutionProvider` exists as an interface that
   reports `CAPABILITY_UNAVAILABLE`.
4. **Every liquidation value is `APEX_ESTIMATE`.** The UI must say so.

---

## 6. Open item for the operator

The geo-restriction has two possible causes and they lead to different actions.

- The egress IP of this machine sits in a Binance-restricted range, which is common for cloud
  and datacenter address space. In that case a normal residential connection may work fine.
- The operator's actual jurisdiction is restricted. In that case hackathon eligibility itself
  is in question, since the rules exclude the US, UK, EEA, Hong Kong, Singapore and Binance's
  prohibited list.

This must be resolved by the operator before further investment. APEX does not attempt to
determine, evade, or work around geographic restrictions.

---

## 7. Conflicts found inside the APEX specification itself

**K-3. The killer fixture's illustrative numbers are not simultaneously reachable.**

Spec section 30 describes the reckless proposal as `leverage: 3.4x` together with
`liquidation_distance: 11.8%`. Under `liq-v1` these cannot co-occur. For a cross-margin BTCUSDT
long inside the first maintenance bracket:

```
distance = 1 - (1 - 1/L) / (1 - 0.004)
```

| Leverage | Liquidation distance |
|---|---|
| 3.4x | 29.13% |
| 8.23x | 11.80% |

Resolved by keeping the 11.8% distance, which is the figure the demo turns on, and accepting
the 8.229x leverage the arithmetic implies. Recorded in `fixtures/reckless-add.mjs` as
`SPEC_NOTE`, and asserted by test so the printed number is always the engine's own.

**K-4. `risk.max_net_delta_btc: 0.002` makes almost every BTC position non-compliant.**

At an 80,000 mark, 0.002 BTC is 160 dollars of directional exposure. Combined with
`max_leverage: 2`, the Constitution only admits accounts of roughly 80 dollars. The fixture
book holds 0.03 BTC, which already breaches the limit before any add is proposed, so the
resize search correctly returns zero and the system stands down.

This is faithful fail-closed behaviour and the test asserts it. It is flagged because it is
almost certainly a calibration oversight rather than the intended policy: as written, APEX can
essentially never open a BTC position. The limit is left exactly as specified and has not been
altered. Changing it is an operator decision.
