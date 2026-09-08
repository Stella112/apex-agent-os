import test from "node:test";
import assert from "node:assert/strict";
import { parseFeed, matchesSymbol, fetchNewsForSymbols } from "../src/news.mjs";

const feed = `<?xml version="1.0"?><rss><channel>
  <item><title>Bitcoin adoption surges after approval</title><link>https://example.com/btc</link><pubDate>2026-09-06T10:00:00Z</pubDate><description><![CDATA[Bitcoin growth and inflow are being reported.]]></description></item>
  <item><title>Unrelated equity story</title><link>https://example.com/other</link><pubDate>2026-09-06T10:00:00Z</pubDate><description>Nothing about crypto.</description></item>
</channel></rss>`;

test("RSS parser extracts safe headline fields", () => {
  const items = parseFeed(feed, "https://example.com/feed.xml");
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Bitcoin adoption surges after approval");
  assert.equal(items[0].feedUrl, "https://example.com/feed.xml");
  assert.equal(matchesSymbol(items[0], "BTCUSDT"), true);
  assert.equal(matchesSymbol(items[1], "BTCUSDT"), false);
});

test("news fetch matches, deduplicates and classifies headlines", async () => {
  const response = await fetchNewsForSymbols(["BTCUSDT"], {
    feeds: ["https://example.com/feed.xml"],
    now: Date.parse("2026-09-06T12:00:00Z"),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => feed })
  });
  assert.equal(response.sources.length, 1);
  assert.equal(response.sources[0].symbol, "BTCUSDT");
  assert.equal(response.sources[0].sentiment, "POSITIVE_SAMPLE");
  assert.equal(response.coverage.social, "UNAVAILABLE");
});

