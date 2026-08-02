// src/ledger/DividendEngine.js
// Computes per-kid ILS dividend distribution from the active lots.
// Parent's slice is intentionally discarded — we never track parent cash.

import { EPS, sumValues, proratePreservingTotal } from '../util/MathUtils.js';

/**
 * @param {Lot[]} lots
 * @param {string} ticker
 * @param {number} netIlsTotal   net ILS for the ENTIRE account incl. parent
 * @returns {{ilsPerKid: Record<string, number>, divPerShare: number}}
 */
export function distributeDividend(lots, ticker, netIlsTotal) {
  let totalShares = 0;
  const perKidShares = {};

  for (const lot of lots) {
    if (lot.ticker !== ticker) continue;
    totalShares += lot.remaining.parent;
    for (const kid in lot.remaining.kids) {
      const s = lot.remaining.kids[kid];
      totalShares += s;
      perKidShares[kid] = (perKidShares[kid] || 0) + s;
    }
  }

  if (totalShares <= EPS) throw new Error(`DIVIDEND: no active position in ${ticker}`);

  const divPerShare = netIlsTotal / totalShares;
  const kidsTotalIls = divPerShare * sumValues(perKidShares);
  const ilsPerKid = proratePreservingTotal(kidsTotalIls, perKidShares, 2);
  return { ilsPerKid, divPerShare };
}
