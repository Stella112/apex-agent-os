// Live news evidence for APEX.
//
// News is context, never an execution signal. Feeds are untrusted: APEX
// validates URLs and dates, matches headlines to an explicit symbol, removes
// repeats, and labels the resulting sentiment as a weak evidence field.

import { analyzeNarrative } from "./narrative.mjs";

export const DEFAULT_NEWS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss"
];

const POSITIVE = /\b(approved|approval|adoption|bullish|buyback|growth|inflow|launch|partnership|record high|surge|upgrade| bullish)\b/gi;
const NEGATIVE = /\b(bankrupt|bearish|breach|decline|exploit|hack|lawsuit|liquidat|outflow|reject|sanction|scam|selloff|shutdown|vulnerab)\w*/gi;

const ALIASES = {
  BTC: ["bitcoin"], ETH: ["ethereum", "ether"], BNB: ["binance coin"],
  SOL: ["solana"], XRP: ["ripple"], ADA: ["cardano"], DOGE: ["dogecoin"],
  DOT: ["polkadot"], AVAX: ["avalanche"], LINK: ["chainlink"],
  MATIC: ["polygon"], TON: ["toncoin"], TRX: ["tron"], LTC: ["litecoin"]
};

function decodeEntities(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function linkValue(block) {
  const atom = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  if (atom) return decodeEntities(atom[1]);
  return tagValue(block, "link") || tagValue(block, "guid");
}

export function parseFeed(xml, feedUrl = "") {
  if (typeof xml !== "string" || xml.length > 2_000_000) return [];
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].map((m) => m[0]);
  return blocks.map((block) => ({
    title: tagValue(block, "title"),
    url: linkValue(block),
    publishedAt: tagValue(block, "pubDate") || tagValue(block, "published") || tagValue(block, "updated"),
    text: tagValue(block, "description") || tagValue(block, "summary") || tagValue(block, "content"),
    feedUrl
  })).filter((item) => item.title && item.url && item.publishedAt);
}

function symbolBase(symbol) {
  return String(symbol).toUpperCase().replace(/(USDT|USDC|BUSD|FDUSD|BTC|ETH|BNB)$/, "") || String(symbol).toUpperCase();
}

export function matchesSymbol(item, symbol) {
  const base = symbolBase(symbol);
  const haystack = `${item.title} ${item.text}`.toLowerCase();
  const terms = [base.toLowerCase(), ...(ALIASES[base] || [])];
  return terms.some((term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s)?([^a-z0-9]|$)`, "i").test(haystack));
}

export function scoreSentiment(text = "") {
  const positive = text.match(POSITIVE)?.length || 0;
  const negative = text.match(NEGATIVE)?.length || 0;
  return {
    label: positive === negative ? "MIXED_OR_NEUTRAL" : positive > negative ? "POSITIVE_SAMPLE" : "NEGATIVE_SAMPLE",
    positive,
    negative
  };
}

function feedName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown source"; }
}

export async function fetchNewsForSymbols(symbols, {
  feeds = (process.env.APEX_NEWS_RSS_URLS || "").split(",").map((v) => v.trim()).filter(Boolean),
  fetchImpl = fetch,
  now = Date.now(),
  maxAgeMs = 86_400_000,
  limit = 12,
  timeoutMs = 5_000
} = {}) {
  const requested = [...new Set((symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean))];
  const sources = feeds.length ? feeds : DEFAULT_NEWS_FEEDS;
  const responses = await Promise.allSettled(sources.map(async (feed) => {
    const response = await fetchImpl(feed, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/rss+xml, application/atom+xml, text/xml" } });
    if (!response.ok) throw new Error(`${feed} returned HTTP ${response.status}`);
    return parseFeed(await response.text(), feed).map((item) => ({ ...item, sourceName: feedName(feed) }));
  }));
  const feedErrors = responses.filter((r) => r.status === "rejected").map((r) => r.reason?.message || "feed unavailable");
  const raw = responses.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  const items = [];
  for (const symbol of requested) {
    const matching = raw.filter((item) => matchesSymbol(item, symbol)).slice(0, limit);
    const checked = analyzeNarrative(matching.map((item) => ({
      ...item,
      symbol,
      originalUrl: item.url,
      text: `${item.title}\n${item.text}`,
      retrievedAt: new Date(now).toISOString()
    })), { symbol, now, maxAgeMs });
    items.push(...checked.sources.map((source) => ({ ...source, title: matching.find((item) => item.url === source.url)?.title || source.text.slice(0, 120), sourceName: matching.find((item) => item.url === source.url)?.sourceName || "unknown" })));
  }
  const counts = items.reduce((out, item) => { out[item.sentiment] = (out[item.sentiment] || 0) + 1; return out; }, {});
  const sentiment = (counts.NEGATIVE_SAMPLE || 0) > (counts.POSITIVE_SAMPLE || 0) ? "NEGATIVE_SAMPLE" : (counts.POSITIVE_SAMPLE || 0) > (counts.NEGATIVE_SAMPLE || 0) ? "POSITIVE_SAMPLE" : "MIXED_OR_NEUTRAL";
  return {
    symbols: requested,
    sources: items,
    sentiment,
    counts,
    coverage: { accepted: items.length, feeds: sources.length, feed_errors: feedErrors.length, social: "UNAVAILABLE" },
    feed_errors: feedErrors,
    generatedAt: new Date(now).toISOString(),
    authority: "Evidence only; sentiment cannot authorize or veto a trade"
  };
}
