import test from "node:test";
import assert from "node:assert/strict";
import {
  BINANCE_MCP_RESOURCE,
  createBinanceAuthorizationUrl,
  createPkcePair
} from "../src/binance-mcp.mjs";

test("Binance OAuth creates a valid PKCE authorization request", () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(verifier, challenge);

  const authorization = createBinanceAuthorizationUrl({
    metadata: { authorization_endpoint: "https://accounts.binance.com/oauth/authorize" },
    clientId: "apex-test-client",
    redirectUri: "https://apex.example/api/binance/callback",
    state: "state-123",
    challenge,
    scopes: "account trade"
  });
  const url = new URL(authorization);
  assert.equal(url.protocol, "https:");
  assert.equal(url.searchParams.get("client_id"), "apex-test-client");
  assert.equal(url.searchParams.get("redirect_uri"), "https://apex.example/api/binance/callback");
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), BINANCE_MCP_RESOURCE);
  assert.equal(url.searchParams.get("scope"), "account trade");
});
