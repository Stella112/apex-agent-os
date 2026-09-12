import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BinanceRestClient } from "../src/binance-rest.mjs";
import { rankTradableTickers, tickerLiquidity } from "../src/market.mjs";

test("market sampling tolerates Binance ticker volume variants", () => {
  assert.equal(tickerLiquidity({ volume: "2", lastPrice: "100" }), 200);
  assert.deepEqual(
    rankTradableTickers([
      { symbol: "ETHUSDT", volume: "1", lastPrice: "100" },
      { symbol: "USDCUSDT", quoteVolume: "999999" },
      { symbol: "BTCUSDT", quoteVolume: "500" }
    ], 2),
    ["BTCUSDT", "ETHUSDT"]
  );
});

test("REST account reads sign requests without exposing the secret", async () => {
  let requestedUrl;
  let requestedInit;
  const client = new BinanceRestClient({
    apiKey: "public-key",
    apiSecret: "private-secret",
    baseUrl: "https://api.example.test",
    now: () => 1700000000000,
    fetchImpl: async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return new Response(JSON.stringify({ accountType: "SPOT", balances: [] }), { status: 200 });
    }
  });

  const result = await client.getAccount();
  const query = new URL(requestedUrl).searchParams;
  const unsigned = `timestamp=${query.get("timestamp")}`;
  const expected = createHmac("sha256", "private-secret").update(unsigned).digest("hex");

  assert.equal(result.accountType, "SPOT");
  assert.equal(requestedInit.headers["X-MBX-APIKEY"], "public-key");
  assert.equal(query.get("signature"), expected);
  assert.equal(requestedUrl.includes("private-secret"), false);
});

test("REST writes stay disabled unless both explicit flags are enabled", async () => {
  const previousWrites = process.env.BINANCE_REST_WRITES;
  const previousAutopilot = process.env.BINANCE_AUTOPILOT_ENABLED;
  process.env.BINANCE_REST_WRITES = "false";
  process.env.BINANCE_AUTOPILOT_ENABLED = "false";

  try {
    const client = new BinanceRestClient({ apiKey: "key", apiSecret: "secret" });
    assert.equal(client.status().writes_enabled, false);
    await assert.rejects(
      () => client.placeMarketOrder({ symbol: "BTCUSDT", side: "BUY", quoteOrderQty: "10" }),
      (error) => error.code === "WRITES_DISABLED"
    );
  } finally {
    if (previousWrites === undefined) delete process.env.BINANCE_REST_WRITES;
    else process.env.BINANCE_REST_WRITES = previousWrites;
    if (previousAutopilot === undefined) delete process.env.BINANCE_AUTOPILOT_ENABLED;
    else process.env.BINANCE_AUTOPILOT_ENABLED = previousAutopilot;
  }
});
