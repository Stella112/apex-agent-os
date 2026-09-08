# Binance MCP adapter

APEX now includes a guarded Binance Agentic MCP client in `src/binance-mcp.mjs`.
It is not a guessed REST order wrapper. The client uses the Binance MCP endpoint,
OAuth PKCE, `initialize`, `tools/list`, and `tools/call`.

## What the builder must provide

Binance must issue/register an OAuth client for the APEX deployment. Configure these
environment values on the Qevor VPS:

```text
BINANCE_OAUTH_CLIENT_ID=...
BINANCE_OAUTH_REDIRECT_URI=https://<your-approved-host>/api/binance/callback
BINANCE_OAUTH_SCOPES=account trade
```

The redirect URI must be one registered with Binance and must be HTTPS (or localhost
for a local development client). Do not put an access token in the browser, Ollama,
the repository, or a public URL.

## Authorization flow

1. Start APEX with the variables above.
2. Call `GET /api/binance/connect` from the APEX UI/backend.
3. Redirect the user to the returned `authorization_url`.
4. Binance redirects to `/api/binance/callback`.
5. APEX exchanges the code with PKCE and keeps the access token server-side in memory
   for the current demo process.
6. Call `GET /api/binance/tools` and inspect the actual tool names and schemas returned
   by Binance.

## Tool mapping

Because Binance does not publish a fixed public tool-name contract, map the discovered
tools explicitly after inspecting `/api/binance/tools`:

```text
BINANCE_MCP_TOOL_BALANCES=...
BINANCE_MCP_TOOL_POSITIONS=...
BINANCE_MCP_TOOL_PLACE_ORDER=...
BINANCE_MCP_TOOL_ORDER_STATUS=...
BINANCE_MCP_TOOL_CANCEL_ORDER=...
```

The adapter refuses to call an unmapped or undiscovered tool. It also refuses live
orders unless `BINANCE_LIVE_EXECUTION=true` is explicitly enabled after the returned
order schema has been reviewed. APEX's Constitution and human confirmation gate must
remain upstream of that call.

## Demo versus production

The current implementation is suitable for a single authorized hackathon demo session.
For multiple users, replace the in-memory token with an encrypted per-user session
store, bind the OAuth state to the user's session, implement token refresh and revoke,
and never use one builder token for every user's funds.
