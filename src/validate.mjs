// Input validation for user-supplied portfolios (spec section 42).
//
// Everything here arrives from a browser, so nothing is trusted. Each field is
// checked for type, finiteness and range, and anything outside the allow-list
// is rejected with a message the user can act on rather than coerced into a
// value they did not intend.

export const LIMITS = {
  maxWalletBalance: 100_000_000,
  maxPositions: 8,
  maxAbsQty: 10_000,
  maxPrice: 10_000_000,
  minPrice: 0.000001
};

export const ALLOWED_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT"]);
export const ALLOWED_SIDES = new Set(["LONG", "SHORT"]);

function num(value, field, { min, max, allowZero = true }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`);
  }
  if (!allowZero && value === 0) {
    throw new ValidationError(`${field} must not be zero`);
  }
  if (min !== undefined && value < min) {
    throw new ValidationError(`${field} must be at least ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`${field} must be at most ${max}`);
  }
  return value;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

// Validate a user-supplied book. Returns a clean object; never mutates input.
export function validateBook(input) {
  if (!input || typeof input !== "object") {
    throw new ValidationError("book must be an object");
  }

  const walletBalance = num(input.walletBalance, "walletBalance", {
    min: 0,
    max: LIMITS.maxWalletBalance
  });

  const rawPositions = input.positions ?? [];
  if (!Array.isArray(rawPositions)) {
    throw new ValidationError("positions must be an array");
  }
  if (rawPositions.length > LIMITS.maxPositions) {
    throw new ValidationError(`at most ${LIMITS.maxPositions} positions are supported`);
  }

  const seen = new Set();
  const positions = rawPositions.map((p, i) => {
    if (!p || typeof p !== "object") {
      throw new ValidationError(`position ${i + 1} must be an object`);
    }
    if (!ALLOWED_SYMBOLS.has(p.symbol)) {
      throw new ValidationError(
        `position ${i + 1}: symbol must be one of ${[...ALLOWED_SYMBOLS].join(", ")}`
      );
    }
    if (seen.has(p.symbol)) {
      throw new ValidationError(`duplicate position for ${p.symbol}; combine them into one`);
    }
    seen.add(p.symbol);

    return {
      symbol: p.symbol,
      // Signed: positive is long, negative is short.
      qty: num(p.qty, `position ${i + 1} quantity`, {
        min: -LIMITS.maxAbsQty,
        max: LIMITS.maxAbsQty,
        allowZero: false
      }),
      entryPrice: num(p.entryPrice, `position ${i + 1} entry price`, {
        min: LIMITS.minPrice,
        max: LIMITS.maxPrice
      })
    };
  });

  if (walletBalance === 0 && positions.length === 0) {
    throw new ValidationError("an empty book with no balance has nothing to evaluate");
  }

  return { walletBalance, positions };
}

// Validate a proposed order.
export function validateCandidate(input) {
  if (!input || typeof input !== "object") {
    throw new ValidationError("proposal must be an object");
  }
  if (!ALLOWED_SYMBOLS.has(input.symbol)) {
    throw new ValidationError(`symbol must be one of ${[...ALLOWED_SYMBOLS].join(", ")}`);
  }
  if (!ALLOWED_SIDES.has(input.side)) {
    throw new ValidationError("side must be LONG or SHORT");
  }
  return {
    symbol: input.symbol,
    side: input.side,
    qty: num(input.qty, "proposal quantity", {
      min: 0,
      max: LIMITS.maxAbsQty,
      allowZero: false
    }),
    entryPrice: input.entryPrice === undefined || input.entryPrice === null
      ? null // filled from the live mark
      : num(input.entryPrice, "proposal entry price", {
          min: LIMITS.minPrice,
          max: LIMITS.maxPrice
        })
  };
}

// Optional thesis fields. Confidence and invalidation drive real gates, so an
// out-of-range value is rejected rather than clamped.
export function validateThesis(input = {}) {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("thesis must be an object");
  }
  const thesis = {};
  if (input.confidence !== undefined && input.confidence !== null) {
    thesis.confidence = num(input.confidence, "confidence", { min: 0, max: 1 });
  }
  if (input.invalidation !== undefined && input.invalidation !== null) {
    thesis.invalidation = num(input.invalidation, "invalidation price", {
      min: LIMITS.minPrice,
      max: LIMITS.maxPrice
    });
  }
  return thesis;
}
