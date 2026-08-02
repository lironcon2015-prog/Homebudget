// src/ledger/FifoEngine.js
// SELL helper. Walks lots oldest-first, depletes per-kid shares from each lot
// PROPORTIONALLY, and returns how many shares each kid actually contributed.
// This per-lot proration is what prevents cross-subsidization between kids.

import { EPS, sumValues } from '../util/MathUtils.js';

/**
 * @param {Lot[]} lots          all lots in the derived state (filtered/sorted internally)
 * @param {string} ticker
 * @param {number} sharesSold   from KIDS' aggregate position only
 * @returns {{consumedByKid: Record<string, number>}}
 * @throws when not enough kid shares are available for the ticker
 */
export function consumeFifo(lots, ticker, sharesSold) {
  const matching = lots
    .filter((l) => l.ticker === ticker)
    .sort((a, b) => {
      if (a.openDate < b.openDate) return -1;
      if (a.openDate > b.openDate) return 1;
      return a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0;
    });

  const totalAvail = matching.reduce((acc, l) => acc + sumValues(l.remaining.kids), 0);
  if (sharesSold > totalAvail + EPS) {
    throw new Error(
      `SELL: not enough kid shares of ${ticker} (have ${totalAvail}, want ${sharesSold})`
    );
  }

  const consumedByKid = {};
  let remainingToSell = sharesSold;

  for (const lot of matching) {
    if (remainingToSell <= EPS) break;
    const lotKidsTotal = sumValues(lot.remaining.kids);
    if (lotKidsTotal <= EPS) continue;

    const take = Math.min(lotKidsTotal, remainingToSell);
    const fraction = take / lotKidsTotal;

    for (const kid in lot.remaining.kids) {
      const kidTake = lot.remaining.kids[kid] * fraction;
      lot.remaining.kids[kid] -= kidTake;
      consumedByKid[kid] = (consumedByKid[kid] || 0) + kidTake;
    }
    remainingToSell -= take;
  }

  return { consumedByKid };
}
