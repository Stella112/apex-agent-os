// Book state for the Agentic sub-account.
// Positions use signed quantity: positive = long, negative = short.

export function createBook({ walletBalance, positions = [] }) {
  return {
    walletBalance,
    sessionOpeningEquity: null,
    positions: positions.map((p) => ({ ...p }))
  };
}

export function unrealizedPnl(position, markPrice) {
  return position.qty * (markPrice - position.entryPrice);
}

export function notionalOf(position, markPrice) {
  return Math.abs(position.qty) * markPrice;
}

// Account equity = wallet balance + unrealized PnL across all positions.
export function equity(book, marks) {
  return book.positions.reduce(
    (total, p) => total + unrealizedPnl(p, marks[p.symbol] ?? p.entryPrice),
    book.walletBalance
  );
}

export function grossNotional(book, marks) {
  return book.positions.reduce(
    (total, p) => total + notionalOf(p, marks[p.symbol] ?? p.entryPrice),
    0
  );
}

// Returns a new book with the candidate order applied, without mutating the
// original. This is what the Referee judges: the resulting portfolio, not the
// order in isolation.
export function applyCandidate(book, candidate) {
  const next = {
    ...book,
    positions: book.positions.map((p) => ({ ...p }))
  };
  const signedQty = candidate.side === "LONG" ? candidate.qty : -candidate.qty;
  const existing = next.positions.find((p) => p.symbol === candidate.symbol);

  if (!existing) {
    next.positions.push({
      symbol: candidate.symbol,
      qty: signedQty,
      entryPrice: candidate.entryPrice
    });
    return next;
  }

  const combined = existing.qty + signedQty;

  // Adding to an existing position in the same direction: weighted average entry.
  if (Math.sign(existing.qty) === Math.sign(signedQty)) {
    const totalCost = existing.qty * existing.entryPrice + signedQty * candidate.entryPrice;
    existing.entryPrice = totalCost / combined;
    existing.qty = combined;
    return next;
  }

  // Reducing or flipping.
  if (combined === 0) {
    next.positions = next.positions.filter((p) => p.symbol !== candidate.symbol);
    return next;
  }
  if (Math.sign(combined) !== Math.sign(existing.qty)) {
    existing.entryPrice = candidate.entryPrice; // flipped through flat
  }
  existing.qty = combined;
  return next;
}
