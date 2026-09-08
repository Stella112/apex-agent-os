import test from "node:test";
import assert from "node:assert/strict";
import { APEX_MCP_TOOLS, handleApexMcp } from "../src/apex-mcp.mjs";

test("APEX MCP initializes as a read-only decision server", async () => {
  const response = await handleApexMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
  });
  assert.equal(response.result.serverInfo.name, "apex-decision-layer");
  assert.match(response.result.instructions, /read-only/i);
  assert.match(response.result.instructions, /plain-language/i);
  assert.match(response.result.instructions, /Bull, Bear/i);
});

test("APEX MCP lists only safe decision tools", async () => {
  const response = await handleApexMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(response.result.tools.map((tool) => tool.name), APEX_MCP_TOOLS.map((tool) => tool.name));
  assert.equal(response.result.tools.some((tool) => /order|withdraw/i.test(tool.name)), false);
});

test("APEX MCP dispatches tool calls without exposing a write path", async () => {
  const response = await handleApexMcp(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "apex_status", arguments: {} }
    },
    { apex_status: () => ({ execution: "BLOCKED", writes_enabled: false }) }
  );
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.execution, "BLOCKED");
  assert.equal(value.writes_enabled, false);
});

test("APEX MCP returns JSON-RPC errors for unknown methods and tools", async () => {
  const method = await handleApexMcp({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  assert.equal(method.error.code, -32601);
  const tool = await handleApexMcp({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "place_order", arguments: {} }
  });
  assert.equal(tool.error.code, -32602);
});
