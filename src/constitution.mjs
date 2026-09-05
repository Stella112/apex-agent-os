// Constitution loading, versioning and hashing (spec sections 22, 23).
//
// The Constitution is the single source of every limit APEX enforces. Its
// SHA-256 is recorded on every decision so a historical verdict stays bound to
// the exact policy text that produced it, even after the policy changes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Minimal YAML reader for the flat, two-level, scalar-only shape the
// Constitution uses. Written rather than depended upon so the project stays
// dependency-free, and constrained so that anything outside that shape is a
// loud error rather than a silent misparse.
export function parseConstitutionYaml(text) {
  const root = {};
  let section = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    // A whole-line comment is dropped entirely; a trailing comment needs
    // preceding whitespace so a "#" inside a value is not eaten.
    if (/^\s*#/.test(raw)) continue;
    const withoutComment = raw.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const line = withoutComment.trim();

    if (indent !== 0 && indent !== 2) {
      throw new Error(`constitution line ${i + 1}: unsupported indent ${indent}`);
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`constitution line ${i + 1}: expected "key: value"`);
    }

    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (indent === 0) {
      if (rest === "") {
        section = {};
        root[key] = section;
      } else {
        section = null;
        root[key] = coerce(rest, i + 1);
      }
      continue;
    }

    if (!section) {
      throw new Error(`constitution line ${i + 1}: nested key "${key}" has no parent section`);
    }
    if (rest === "") {
      throw new Error(`constitution line ${i + 1}: nested key "${key}" needs a scalar value`);
    }
    section[key] = coerce(rest, i + 1);
  }
  return root;
}

function coerce(token, lineNumber) {
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null" || token === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(token)) {
    const asNumber = Number(token);
    if (!Number.isFinite(asNumber)) {
      throw new Error(`constitution line ${lineNumber}: unparseable number "${token}"`);
    }
    return asNumber;
  }
  const unquoted = token.replace(/^["'](.*)["']$/, "$1");
  return unquoted;
}

// Canonical JSON: object keys sorted at every level, no incidental whitespace.
// Both the Constitution hash and the journal chain depend on this being stable
// across runs and machines.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${pairs.join(",")}}`;
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const REQUIRED = [
  ["risk", "max_leverage"],
  ["risk", "max_net_delta_btc"],
  ["risk", "min_liquidation_distance_pct"],
  ["risk", "daily_loss_lock_pct"],
  ["risk", "max_name_pct"],
  ["risk", "max_order_pct"],
  ["execution", "require_human_confirmation"],
  ["capital", "withdrawals_allowed"]
];

export function validateConstitution(doc) {
  const problems = [];
  if (!doc.id) problems.push("missing id");
  if (!doc.version) problems.push("missing version");
  for (const [section, key] of REQUIRED) {
    if (doc[section] === undefined || doc[section][key] === undefined) {
      problems.push(`missing ${section}.${key}`);
    }
  }
  // A Constitution that permits withdrawals contradicts the platform's own
  // guarantee and is refused rather than quietly honoured.
  if (doc.capital?.withdrawals_allowed === true) {
    problems.push("capital.withdrawals_allowed must be false");
  }
  if (doc.execution?.require_human_confirmation === false) {
    problems.push("execution.require_human_confirmation must be true");
  }
  return problems;
}

const DEFAULT_PATH = fileURLToPath(new URL("../config/constitution.yaml", import.meta.url));

export function loadConstitution(path = DEFAULT_PATH) {
  const text = readFileSync(path, "utf8");
  const doc = parseConstitutionYaml(text);

  const problems = validateConstitution(doc);
  if (problems.length > 0) {
    throw new Error(`constitution is invalid: ${problems.join("; ")}`);
  }

  // The hash covers the canonical parse, not the raw bytes, so reformatting
  // whitespace or reordering sections does not change a policy's identity
  // while any change to a limit does.
  const canonical = canonicalJson(doc);
  return {
    ...doc,
    constitution_id: doc.id,
    constitution_version: doc.version,
    constitution_sha256: sha256(canonical)
  };
}

// The stamp recorded on every decision.
export function stamp(constitution) {
  return {
    constitution_id: constitution.constitution_id,
    constitution_version: constitution.constitution_version,
    constitution_sha256: constitution.constitution_sha256
  };
}
