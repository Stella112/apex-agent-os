// Decimal strings -> fixed-point integers. No exponent or silently rounded input.
export function units(value, scale = 8) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2]?.length ?? 0) > scale) throw new Error("INVALID_DECIMAL");
  return BigInt(match[1]) * 10n ** BigInt(scale) + BigInt((match[2] ?? "").padEnd(scale, "0"));
}
export function roundOrder({ quantity, stepSize, price, minNotional, feeRate, available }) {
  const scale = 100_000_000n;
  const step = units(stepSize); if (step <= 0n) throw new Error("INVALID_STEP");
  const qty = units(quantity) / step * step;
  const notional = (qty * units(price) + scale - 1n) / scale;
  const fees = (notional * units(feeRate) + scale - 1n) / scale;
  return { allowed: qty > 0n && notional > 0n && notional >= units(minNotional) && notional + fees <= units(available),
    quantityUnits: qty.toString(), notionalUnits: notional.toString(), feeUnits: fees.toString(), scale: 8 };
}
