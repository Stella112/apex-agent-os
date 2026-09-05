// Evidence validator (spec sections 18, 19, 41).
//
// An agent may only argue from measurements the Quant Engine actually produced.
// A claim citing a key that does not exist in the packet is rejected as
// unsupported, whatever the prose around it says. This is the mechanism that
// stops a confident sentence from becoming a trading input.

export const REJECTION = {
  UNSUPPORTED_CLAIM: "UNSUPPORTED_CLAIM",
  UNAVAILABLE_EVIDENCE: "UNAVAILABLE_EVIDENCE",
  MALFORMED_CLAIM: "MALFORMED_CLAIM",
  FALSE_EXECUTION_STATE: "FALSE_EXECUTION_STATE",
  PAYMENT_UNVERIFIED: "PAYMENT_UNVERIFIED"
};

export const MODEL_FAILURE = {
  MODEL_INVALID_OUTPUT: "MODEL_INVALID_OUTPUT",
  MODEL_TIMEOUT: "MODEL_TIMEOUT",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE"
};

const ALLOWED_DECISIONS = new Set([
  "OPEN",
  "ADD",
  "HOLD",
  "INCREASE",
  "REDUCE",
  "EXIT",
  "HEDGE",
  "STAND_DOWN"
]);

// Validate one agent output against the packet it was given.
//
// Returns { valid, decision, claims, rejected, reasons }. Invalid claims are
// removed rather than silently repaired, and an output whose claims are all
// rejected is itself invalid.
export function validateAgentOutput({ output, packet }) {
  const rejected = [];
  const reasons = [];

  if (!output || typeof output !== "object") {
    return fail(REJECTION.MALFORMED_CLAIM, "agent output was not an object");
  }
  if (!ALLOWED_DECISIONS.has(output.decision)) {
    return fail(REJECTION.MALFORMED_CLAIM, `unknown decision ${JSON.stringify(output.decision)}`);
  }
  if (typeof output.confidence !== "number" || output.confidence < 0 || output.confidence > 1) {
    return fail(REJECTION.MALFORMED_CLAIM, "confidence must be a number between 0 and 1");
  }
  if (!Array.isArray(output.claims) || output.claims.length === 0) {
    return fail(REJECTION.MALFORMED_CLAIM, "agent output carried no claims");
  }

  const accepted = [];
  for (const claim of output.claims) {
    if (!claim || typeof claim.claim !== "string" || !Array.isArray(claim.evidence_keys)) {
      rejected.push({ claim, rejection: REJECTION.MALFORMED_CLAIM });
      reasons.push("a claim was missing its text or evidence_keys");
      continue;
    }
    if (claim.evidence_keys.length === 0) {
      rejected.push({ claim, rejection: REJECTION.UNSUPPORTED_CLAIM });
      reasons.push(`"${claim.claim}" cited no evidence`);
      continue;
    }

    const missing = claim.evidence_keys.filter((key) => !(key in packet.evidence));
    if (missing.length > 0) {
      rejected.push({
        claim,
        rejection: REJECTION.UNSUPPORTED_CLAIM,
        missing_keys: missing
      });
      reasons.push(`"${claim.claim}" cites evidence that does not exist: ${missing.join(", ")}`);
      continue;
    }

    // A key that exists but holds no value cannot support a claim either.
    const emptyKeys = claim.evidence_keys.filter(
      (key) => packet.evidence[key].value === null
    );
    if (emptyKeys.length > 0) {
      rejected.push({
        claim,
        rejection: REJECTION.UNAVAILABLE_EVIDENCE,
        unavailable_keys: emptyKeys
      });
      reasons.push(`"${claim.claim}" cites unavailable evidence: ${emptyKeys.join(", ")}`);
      continue;
    }

    accepted.push(claim);
  }

  if (accepted.length === 0) {
    return {
      valid: false,
      failure: REJECTION.UNSUPPORTED_CLAIM,
      decision: output.decision,
      claims: [],
      rejected,
      reasons
    };
  }

  return {
    valid: true,
    decision: output.decision,
    confidence: output.confidence,
    claims: accepted,
    rejected,
    reasons
  };
}

function fail(failure, reason) {
  return { valid: false, failure, decision: null, claims: [], rejected: [], reasons: [reason] };
}

// An agent may not assert that an order filled. Only a reconciled execution
// record can establish that (spec sections 32, 41).
export function assertNoFabricatedExecution({ text, executionEvents = [] }) {
  const claimsFill = /\b(filled|executed|order (was )?placed|position (is )?open(ed)?)\b/i.test(
    String(text ?? "")
  );
  const hasEvidence = executionEvents.some((e) => e.event_type === "FILL");
  if (claimsFill && !hasEvidence) {
    return { valid: false, rejection: REJECTION.FALSE_EXECUTION_STATE };
  }
  return { valid: true };
}

// Likewise for payment. An unverified settlement is not a settlement.
export function assertNoFabricatedPayment({ text, settlementEvents = [] }) {
  const claimsPaid = /\b(payment (successful|received|settled)|paid|settled)\b/i.test(
    String(text ?? "")
  );
  const hasEvidence = settlementEvents.some((e) => e.verified === true);
  if (claimsPaid && !hasEvidence) {
    return { valid: false, rejection: REJECTION.PAYMENT_UNVERIFIED };
  }
  return { valid: true };
}

// Model call wrapper implementing spec section 19: retry once, validate again,
// then fail closed. Never substitutes a different provider.
export async function callModelWithValidation({
  provider,
  role,
  packet,
  timeoutMs = 10_000,
  attempts = 2,
  hashInput = null
}) {
  // The exact bytes the agent saw, hashed. Two agents claiming to have argued
  // from the same evidence can then be checked rather than trusted.
  const input_hash = hashInput ? hashInput(packet) : null;
  const attribution = {
    role,
    model: provider?.name ?? null,
    model_version: provider?.version ?? null,
    input_hash,
    timestamp: new Date().toISOString()
  };

  if (!provider || typeof provider.propose !== "function") {
    return {
      valid: false,
      failure: MODEL_FAILURE.MODEL_UNAVAILABLE,
      reasons: ["no provider"],
      ...attribution
    };
  }

  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let output;
    try {
      output = await withTimeout(provider.propose({ role, packet }), timeoutMs);
    } catch (error) {
      if (error?.message === "__timeout__") {
        last = {
          valid: false,
          failure: MODEL_FAILURE.MODEL_TIMEOUT,
          reasons: ["model timed out"]
        };
        continue;
      }
      last = {
        valid: false,
        failure: MODEL_FAILURE.MODEL_UNAVAILABLE,
        reasons: [error?.message ?? "provider threw"]
      };
      continue;
    }

    const validated = validateAgentOutput({ output, packet });
    if (validated.valid) return { ...validated, ...attribution, attempts_used: attempt };
    last = { ...validated, failure: validated.failure ?? MODEL_FAILURE.MODEL_INVALID_OUTPUT };
  }
  return { ...last, ...attribution, attempts_used: attempts };
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error("__timeout__")), ms))
  ]);
}
