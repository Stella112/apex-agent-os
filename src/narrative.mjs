import { sha256 } from "./constitution.mjs";
// Conservative sampled-news evidence. No social coverage, probability, or trading authority.
export function analyzeNarrative(items, { symbol = "BTCUSDT", now = Date.now(), maxAgeMs = 86_400_000 } = {}) {
  const accepted = [], rejected = [], seen = new Set();
  for (const item of items.slice(0, 100)) {
    let url;
    try { url = new URL(item.url); } catch { rejected.push({ reason: "INVALID_SOURCE" }); continue; }
    const time = Date.parse(item.publishedAt);
    if (url.protocol !== "https:" || !Number.isFinite(time) || time > now || now - time > maxAgeMs || item.symbol !== symbol) {
      rejected.push({ url: url.href, reason: "DATE_OR_ENTITY_MISMATCH" }); continue;
    }
    if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 20_000) { rejected.push({ url: url.href, reason: "MISSING_OR_OVERSIZE_TEXT" }); continue; }
    const normalized = item.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const identity = sha256(normalized);
    let origin;
    try { origin = new URL(item.originalUrl || item.url).href; } catch { rejected.push({ reason: "INVALID_ORIGINAL_SOURCE" }); continue; }
    if (seen.has(identity) || seen.has(origin)) { rejected.push({ url: url.href, reason: "REPETITION" }); continue; }
    seen.add(identity); seen.add(origin);
    const positive = /\b(approval|approved|growth|inflow|launch)\b/.test(normalized);
    const negative = /\b(rejected|outflow|hack|halt|decline)\b/.test(normalized);
    accepted.push({ id: `narrative.${identity.slice(0,16)}`, symbol, url: url.href, originalUrl: origin,
      publishedAt: item.publishedAt, retrievedAt: item.retrievedAt ?? null, text: item.text,
      title: item.title ?? item.text.slice(0, 120), sourceName: item.sourceName ?? new URL(url.href).hostname,
      status: "UNVERIFIED", reason: "Retrieved text is not independent confirmation of the underlying event",
      sentiment: positive === negative ? "MIXED_OR_NEUTRAL" : positive ? "POSITIVE_SAMPLE" : "NEGATIVE_SAMPLE" });
  }
  return { symbol, classification: "EXTERNAL_SOURCE", generatedAt: new Date(now).toISOString(),
    sources: accepted, rejected, coverage: { accepted: accepted.length, rejected: rejected.length, social: "UNAVAILABLE" },
    methodology: "Exact normalized text and original-URL deduplication; small English keyword sample. Paraphrased syndication may remain. No market-wide inference.",
    relevance: accepted.length ? "Review whether these sampled events affect the proposal assumption; no automatic trade revision" : "NO_MATERIAL_RELEVANCE",
    authority: "Evidence only; cannot authorize tools, spending, or override policy" };
}

export function attachNarrative(packet, narrative) {
  const evidence = { ...packet.evidence };
  for (const source of narrative.sources) evidence[source.id] = {
    value: { text: source.text, sentiment: source.sentiment, status: source.status }, source: source.url,
    classification: "EXTERNAL_SOURCE", timestamp: source.publishedAt, retrieved_at: source.retrievedAt,
    status: "AVAILABLE", freshness: "FRESH", age_ms: Date.parse(narrative.generatedAt) - Date.parse(source.publishedAt)
  };
  return { ...packet, evidence, narrative };
}
