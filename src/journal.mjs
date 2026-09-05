// Hash-linked audit journal (spec sections 35, 36).
//
// Append-only. Each event commits to the one before it, so any edit to a past
// event breaks every hash after it and verification reports the exact index.
// This is a hash-linked journal. It is not a blockchain and is not described
// as one.

import { canonicalJson, sha256 } from "./constitution.mjs";

export const EVENT_TYPES = [
  "MARKET_STATE",
  "QUANT_PACKET",
  "BULL_DECISION",
  "BEAR_DECISION",
  "DEBATE_RESULT",
  "ROUTE_EVALUATION",
  "ROUTE_REJECTION",
  "CONSTITUTION",
  "REFEREE_SIMULATION",
  "REFEREE_DECISION",
  "EXECUTION_PREVIEW",
  "HUMAN_CONFIRMATION",
  "ORDER_SUBMITTED",
  "ORDER_UPDATE",
  "FILL",
  "POST_TRADE_STATE",
  "ERROR"
];

export const GENESIS_HASH = "0".repeat(64);

export function hashEvent({ event_type, timestamp, payload, previous_hash }) {
  return sha256(
    canonicalJson({ event_type, timestamp, payload, previous_hash })
  );
}

export function createJournal({ environment = "development" } = {}) {
  const events = [];

  function append(event_type, payload, { timestamp = new Date().toISOString() } = {}) {
    if (!EVENT_TYPES.includes(event_type)) {
      throw new Error(`unknown event type ${event_type}`);
    }
    const previous_hash = events.length ? events[events.length - 1].event_hash : GENESIS_HASH;
    const event = {
      event_id: `evt_${String(events.length + 1).padStart(6, "0")}`,
      timestamp,
      event_type,
      payload,
      previous_hash,
      environment
    };
    event.event_hash = hashEvent(event);
    events.push(event);
    return event;
  }

  return {
    append,
    get length() {
      return events.length;
    },
    all() {
      // Deep copy so a caller cannot mutate the chain through the getter.
      return events.map((e) => JSON.parse(JSON.stringify(e)));
    },
    head() {
      return events.length ? events[events.length - 1].event_hash : GENESIS_HASH;
    },
    verify() {
      return verifyJournal(events);
    }
  };
}

// Verify the chain. Returns the first break rather than a bare boolean, so a
// tamper can be pointed at in the UI.
export function verifyJournal(events) {
  let previous = GENESIS_HASH;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];

    if (event.previous_hash !== previous) {
      return {
        valid: false,
        failure: "BROKEN_LINK",
        index: i,
        event_id: event.event_id,
        detail: `event ${event.event_id} points at ${short(event.previous_hash)} but the chain head was ${short(previous)}`
      };
    }

    const recomputed = hashEvent(event);
    if (recomputed !== event.event_hash) {
      return {
        valid: false,
        failure: "PAYLOAD_TAMPERED",
        index: i,
        event_id: event.event_id,
        detail: `event ${event.event_id} hashes to ${short(recomputed)} but carries ${short(event.event_hash)}`
      };
    }

    previous = event.event_hash;
  }
  return { valid: true, length: events.length, head: previous };
}

function short(hash) {
  return typeof hash === "string" ? `${hash.slice(0, 8)}…` : String(hash);
}
