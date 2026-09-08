import test from "node:test";
import assert from "node:assert/strict";
import { createExternalBear } from "../src/external-model.mjs";

const packet = { evidence: { "market.price": { value: 100 } } };

test("external Bear accepts JSON mode and a harmless json prefix", async () => {
  let request;
  const bear = createExternalBear(
    { BEAR_API_URL: "https://api.openai.com/v1/chat/completions", BEAR_API_KEY: "test", BEAR_MODEL: "gpt-4o-mini" },
    async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'json {"decision":"HOLD","confidence":0.7,"claims":[]}' } }] }), { status: 200 });
    }
  );
  const result = await bear.propose({ packet });
  assert.equal(result.decision, "HOLD");
  assert.equal(request.response_format.type, "json_object");
});

test("external Bear accepts a fenced JSON response without accepting prose", async () => {
  const bear = createExternalBear(
    { BEAR_API_URL: "https://example.com/chat", BEAR_API_KEY: "test", BEAR_MODEL: "model" },
    async () => new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"decision":"STAND_DOWN","confidence":0.9,"claims":[]}\n```' } }] }), { status: 200 })
  );
  const result = await bear.propose({ packet });
  assert.equal(result.decision, "STAND_DOWN");
});
