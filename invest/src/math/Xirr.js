// src/math/Xirr.js
// XIRR via Newton-Raphson with bisection fallback. Pure.

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

const toDate = (d) => (d instanceof Date ? d : new Date(d));
const yearsBetween = (a, b) => (toDate(b).getTime() - toDate(a).getTime()) / MS_PER_YEAR;

function npv(cashflows, r, t0) {
  let total = 0;
  for (const cf of cashflows) {
    total += cf.amount / Math.pow(1 + r, yearsBetween(t0, cf.date));
  }
  return total;
}

function dnpv(cashflows, r, t0) {
  let total = 0;
  for (const cf of cashflows) {
    const y = yearsBetween(t0, cf.date);
    total += -y * cf.amount / Math.pow(1 + r, y + 1);
  }
  return total;
}

function hasMixedSigns(cashflows) {
  let pos = false, neg = false;
  for (const cf of cashflows) {
    if (cf.amount > 0) pos = true;
    else if (cf.amount < 0) neg = true;
    if (pos && neg) return true;
  }
  return false;
}

/**
 * @param {{date: Date|string, amount: number}[]} cashflows
 * @param {number} guess
 * @returns {{value: number|null, reason?: string}}
 */
export function xirr(cashflows, guess = 0.1) {
  if (!cashflows || cashflows.length < 2) return { value: null, reason: 'insufficient_flows' };
  if (!hasMixedSigns(cashflows)) return { value: null, reason: 'no_sign_change' };

  let t0 = toDate(cashflows[0].date);
  for (const cf of cashflows) {
    const d = toDate(cf.date);
    if (d < t0) t0 = d;
  }

  // Newton-Raphson
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(cashflows, r, t0);
    const fp = dnpv(cashflows, r, t0);
    if (!isFinite(f) || !isFinite(fp)) break;
    if (Math.abs(fp) < 1e-12) break;
    let rNew = r - f / fp;
    if (rNew <= -0.999) rNew = (r + -0.999) / 2;
    if (Math.abs(rNew - r) < 1e-9) return { value: rNew };
    r = rNew;
  }

  // Bisection fallback in [-0.99, +10.0]
  let lo = -0.99, hi = 10.0;
  let fLo = npv(cashflows, lo, t0);
  let fHi = npv(cashflows, hi, t0);
  if (!isFinite(fLo) || !isFinite(fHi) || fLo * fHi > 0) {
    return { value: null, reason: 'no_convergence' };
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(cashflows, mid, t0);
    if (Math.abs(fMid) < 1e-9 || (hi - lo) / 2 < 1e-9) return { value: mid };
    if (fMid * fLo < 0) { hi = mid; fHi = fMid; }
    else { lo = mid; fLo = fMid; }
  }
  return { value: (lo + hi) / 2 };
}
