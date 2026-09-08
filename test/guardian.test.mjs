import test from "node:test";
import assert from "node:assert/strict";
import { runGuardianPreflight } from "../src/guardian.mjs";

const constitution = {
  capital: { withdrawals_allowed: false },
  execution: { require_human_confirmation: true }
};

const packet = {
  worst_freshness: "FRESH",
  evidence: {
    "price.mark": { value: 100000 },
    "price.bid": { value: 99999 },
    "price.ask": { value: 100001 }
  }
};

const candidate = {
  symbol: "BTCUSDT",
  side: "LONG",
  qty: 0.001,
  entryPrice: 100000
};

test("Guardian blocks an approved proposal without bound execution authority", () => {
  const result = runGuardianPreflight({
    candidate,
    packet,
    verdict: { verdict: "APPROVE" },
    constitution,
    execution: { accountBound: false, writesEnabled: false }
  });

  assert.equal(result.status, "BLOCK");
  assert.equal(result.safe_to_confirm, false);
  assert.deepEqual(
    result.checks.filter((item) => item.status === "BLOCK").map((item) => item.id),
    ["ACCOUNT_BINDING", "EXECUTION_CAPABILITY"]
  );
});

test("Guardian passes only when every execution preflight is satisfied", () => {
  const result = runGuardianPreflight({
    candidate,
    packet,
    verdict: { verdict: "APPROVE" },
    constitution,
    execution: {
      accountBound: true,
      writesEnabled: true,
      maxOrderNotional: 1000,
      allowedSymbols: ["BTCUSDT"]
    }
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.safe_to_confirm, true);
  assert.equal(result.summary.blocked, 0);
  assert.equal(result.summary.review, 0);
});

test("Guardian fails closed on stale evidence and duplicate orders", () => {
  const result = runGuardianPreflight({
    candidate,
    packet: { ...packet, worst_freshness: "STALE" },
    verdict: { verdict: "APPROVE" },
    constitution,
    execution: { accountBound: true, writesEnabled: true },
    pendingOrder: true
  });

  assert.equal(result.status, "BLOCK");
  assert.equal(result.checks.find((item) => item.id === "MARKET_FRESHNESS").status, "BLOCK");
  assert.equal(result.checks.find((item) => item.id === "DUPLICATE_ORDER").status, "BLOCK");
});

test("Guardian refuses autopilot until the Constitution explicitly permits it", () => {
  const result = runGuardianPreflight({
    candidate,
    packet,
    verdict: { verdict: "APPROVE" },
    constitution,
    execution: {
      accountBound: true,
      writesEnabled: true,
      autopilotEnabled: true,
      maxOrderNotional: 1000,
      allowedSymbols: ["BTCUSDT"]
    }
  });

  assert.equal(result.status, "BLOCK");
  assert.equal(result.checks.find((item) => item.id === "AUTONOMY_POLICY").status, "BLOCK");
});
