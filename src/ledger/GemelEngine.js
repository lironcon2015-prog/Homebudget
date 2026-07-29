// src/ledger/GemelEngine.js
// Pure derivation for קופת גמל להשקעה accounts. No DOM, no I/O.
//
// A gemel fund is not a security: there are no units and no quoted price, only
// a shekel balance that the fund manager reports. So instead of a ticker +
// quantity we model it as a standing order (a fixed monthly amount) plus a
// user-entered balance anchor taken from a statement.
//
// That combination makes the money numbers exact rather than modelled:
//   principal = Σ deposits          (every deposit amount and date is known)
//   gain      = balance − principal (balance comes from the statement)
//   XIRR      = deposits + today's balance as the terminal flow
// No index model, no tracking-error assumption, no external data source.
//
// The only inexact part is the tail: deposits made after the anchor date are
// counted at face value with no return applied, so the balance is understated
// or overstated by whatever the fund earned since the statement. Callers get
// `tailFrom` / `tailDeposits` so the UI can label that explicitly.

import { round2, proratePreservingTotal, sumValues } from '../util/MathUtils.js';

const dayMs = 86400000;

function dateKey(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function parseKey(key) {
  const [y, m, d] = String(key).slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();  // m is 1-based; day 0 = last of m
}

function makeKey(y, m, d) {
  const dim = daysInMonth(y, m);
  const day = Math.min(d, dim);   // a 31st standing order lands on the 30th/28th
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function diffDays(aKey, bKey) {
  return (Date.parse(bKey + 'T00:00:00Z') - Date.parse(aKey + 'T00:00:00Z')) / dayMs;
}

/**
 * Every scheduled deposit date from `firstKey` up to and including `untilKey`.
 * The day-of-month comes from `firstKey` itself unless `depositDay` overrides it.
 */
export function scheduleDates(firstKey, untilKey, depositDay = null) {
  const out = [];
  if (!firstKey || !untilKey || firstKey > untilKey) return out;
  const first = parseKey(firstKey);
  const day = depositDay || first.d;
  out.push(firstKey);
  let y = first.y;
  let m = first.m;
  for (let guard = 0; guard < 1200; guard++) {   // 100 years is plenty; never spin
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    const key = makeKey(y, m, day);
    if (key > untilKey) break;
    out.push(key);
  }
  return out;
}

/**
 * Merge the generated schedule with the user's overrides.
 * An override replaces the amount on its date; amount 0 removes that month
 * (a skipped standing order). An override on a date outside the schedule adds
 * a one-off deposit.
 */
export function resolveDeposits(fund, untilKey) {
  const amount = Number(fund.monthlyAmount) || 0;
  const dates = scheduleDates(dateKey(fund.firstDepositDate), untilKey, fund.depositDay || null);

  const byDate = new Map();
  for (const date of dates) byDate.set(date, amount);

  for (const ov of fund.overrides || []) {
    const key = dateKey(ov.date);
    if (!key || key > untilKey) continue;
    byDate.set(key, Number(ov.amount) || 0);
  }

  return [...byDate.entries()]
    .filter(([, amt]) => amt > 0)
    .map(([date, amt]) => ({ date, amount: amt }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * The allocation in effect on `dateKey`. History entries are `{ from, allocation }`
 * with allocation as percentages summing to 100, same convention as BUY.
 * Falls back to the earliest entry for dates before any change took effect.
 */
export function allocationOn(fund, key) {
  const hist = (fund.allocationHistory || []).slice().sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  if (hist.length === 0) return null;
  let chosen = hist[0];
  for (const entry of hist) {
    if (dateKey(entry.from) <= key) chosen = entry;
    else break;
  }
  return chosen.allocation;
}

export function currentAllocation(fund) {
  const hist = fund.allocationHistory || [];
  if (hist.length === 0) return {};
  return hist.slice().sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)).at(-1).allocation;
}

/**
 * Derive one fund.
 *
 * Gain is split across kids by Modified-Dietz weighting: each deposit earns in
 * proportion to how long it has been invested. With a constant allocation this
 * collapses to exactly that allocation, so the common case stays exact; it only
 * does real work once the split changes mid-life, where applying today's
 * percentages to past gains would silently rewrite who earned what.
 */
export function deriveGemelFund(fund, kids, todayKey) {
  const warnings = [];
  const kidIds = Object.keys(kids || {});
  const zeroByKid = () => Object.fromEntries(kidIds.map((k) => [k, 0]));

  const empty = {
    id: fund.id,
    name: fund.name,
    deposits: [],
    depositedByKid: zeroByKid(),
    balanceByKid: zeroByKid(),
    gainByKid: zeroByKid(),
    flowsByKid: Object.fromEntries(kidIds.map((k) => [k, []])),
    totalDeposited: 0,
    balance: 0,
    gain: 0,
    returnPct: 0,
    tailFrom: null,
    tailDeposits: 0,
    warnings,
  };

  if (!fund.firstDepositDate) {
    warnings.push({ fundId: fund.id, code: 'no-first-date', message: 'לא הוגדר תאריך הפקדה ראשונה' });
    return empty;
  }

  const deposits = resolveDeposits(fund, todayKey);
  if (deposits.length === 0) return empty;

  const totalDeposited = round2(deposits.reduce((s, x) => s + x.amount, 0));

  // Balance: the anchor is authoritative up to its date; deposits after it are
  // added at face value because no return is known for that window yet.
  const anchorBalance = Number(fund.anchor?.balance);
  const anchorAsOf = fund.anchor?.asOf ? dateKey(fund.anchor.asOf) : null;
  let balance;
  let tailFrom = null;
  let tailDeposits = 0;

  if (anchorAsOf && Number.isFinite(anchorBalance)) {
    const after = deposits.filter((x) => x.date > anchorAsOf);
    tailDeposits = round2(after.reduce((s, x) => s + x.amount, 0));
    balance = round2(anchorBalance + tailDeposits);
    if (anchorAsOf < todayKey) tailFrom = anchorAsOf;
  } else {
    balance = totalDeposited;
    warnings.push({ fundId: fund.id, code: 'no-anchor', message: 'לא הוזנה יתרה — מוצגת הקרן בלבד' });
  }

  const gain = round2(balance - totalDeposited);

  // Per-kid deposits, prorated by the allocation in effect on each date.
  const depositedByKid = zeroByKid();
  const flowsByKid = Object.fromEntries(kidIds.map((k) => [k, []]));
  const weighted = zeroByKid();
  const spanDays = Math.max(diffDays(deposits[0].date, todayKey), 1);

  // Prorating each deposit on its own would hand the leftover agora to the same
  // kid every month, because equal weights break ties in a stable order — a
  // systematic drift, not the rounding noise proratePreservingTotal prevents.
  // Splitting the *running* total instead and taking the difference keeps every
  // kid's cumulative share correct, and still allows the split to change.
  let runningTotal = 0;
  let runningAlloc = null;
  const assigned = zeroByKid();

  for (const dep of deposits) {
    const alloc = allocationOn(fund, dep.date);
    if (!alloc || Math.abs(sumValues(alloc) - 100) > 1e-3) {
      warnings.push({ fundId: fund.id, code: 'bad-allocation', message: `פיצול לא תקין בתאריך ${dep.date}` });
      continue;
    }
    const known = Object.fromEntries(Object.entries(alloc).filter(([k]) => k in kids));
    if (Object.keys(known).length === 0) continue;

    // A changed split applies only to what comes after it, so the run restarts
    // from the amounts already locked in under the previous one.
    const allocKey = JSON.stringify(known);
    if (allocKey !== runningAlloc) {
      runningAlloc = allocKey;
      runningTotal = 0;
      for (const kidId in assigned) assigned[kidId] = 0;
    }

    runningTotal = round2(runningTotal + dep.amount);
    const target = proratePreservingTotal(runningTotal, known, 2);
    const heldFraction = Math.max(diffDays(dep.date, todayKey), 0) / spanDays;

    for (const kidId in known) {
      const share = round2((target[kidId] || 0) - (assigned[kidId] || 0));
      assigned[kidId] = target[kidId] || 0;
      depositedByKid[kidId] = round2(depositedByKid[kidId] + share);
      weighted[kidId] += share * heldFraction;
      if (share > 0) flowsByKid[kidId].push({ date: dep.date, amount: -share });
    }
  }

  // Split the gain by weighted capital; prorate so the parts re-sum to `gain`.
  const weightSum = sumValues(weighted);
  const gainByKid = weightSum > 0
    ? proratePreservingTotal(gain, weighted, 2)
    : proratePreservingTotal(gain, depositedByKid, 2);

  const balanceByKid = {};
  for (const kidId of kidIds) {
    balanceByKid[kidId] = round2((depositedByKid[kidId] || 0) + (gainByKid[kidId] || 0));
  }

  return {
    id: fund.id,
    name: fund.name,
    fundNumber: fund.fundNumber || null,
    deposits,
    depositedByKid,
    balanceByKid,
    gainByKid,
    flowsByKid,
    totalDeposited,
    balance,
    gain,
    returnPct: totalDeposited > 0 ? (gain / totalDeposited) * 100 : 0,
    anchorAsOf,
    tailFrom,
    tailDeposits,
    warnings,
  };
}

/**
 * Derive every fund in state and roll them up.
 * Returns zeroed totals when no funds are configured, so callers can add
 * unconditionally.
 */
export function deriveGemel(state, todayKey) {
  const kids = state.kids || {};
  const kidIds = Object.keys(kids);
  const funds = (state.gemelFunds || []).map((f) => deriveGemelFund(f, kids, todayKey));

  const balanceByKid = Object.fromEntries(kidIds.map((k) => [k, 0]));
  const depositedByKid = Object.fromEntries(kidIds.map((k) => [k, 0]));
  const gainByKid = Object.fromEntries(kidIds.map((k) => [k, 0]));
  const flowsByKid = Object.fromEntries(kidIds.map((k) => [k, []]));
  const warnings = [];

  for (const f of funds) {
    for (const kidId of kidIds) {
      balanceByKid[kidId] = round2(balanceByKid[kidId] + (f.balanceByKid[kidId] || 0));
      depositedByKid[kidId] = round2(depositedByKid[kidId] + (f.depositedByKid[kidId] || 0));
      gainByKid[kidId] = round2(gainByKid[kidId] + (f.gainByKid[kidId] || 0));
      flowsByKid[kidId].push(...(f.flowsByKid[kidId] || []));
    }
    warnings.push(...f.warnings);
  }

  return {
    funds,
    balanceByKid,
    depositedByKid,
    gainByKid,
    flowsByKid,
    totalBalance: round2(sumValues(balanceByKid)),
    totalDeposited: round2(sumValues(depositedByKid)),
    totalGain: round2(sumValues(gainByKid)),
    warnings,
  };
}
