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
import { xirr } from '../math/Xirr.js';

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

const monthKey = (key) => String(key).slice(0, 7);

function addMonth(mKey) {
  let [y, m] = mKey.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * The published monthly return for `mKey`, net of account-level management fees.
 *
 * A track's published return is the return of the *track*, while the fee is
 * charged against the account — so the saver never actually earns the headline
 * number. `annualFeePct` is a known constant, not an unknown, so it is simply
 * deducted: a twelfth of it per month.
 */
export function netMonthlyReturn(fund, mKey) {
  const entry = (fund.returns || []).find((r) => monthKey(r.month) === mKey);
  if (!entry || !Number.isFinite(Number(entry.pct))) return null;
  const fee = Number(fund.annualFeePct) || 0;
  return (Number(entry.pct) - fee / 12) / 100;
}

/**
 * Roll the anchor balance forward to today using the published monthly returns.
 *
 * Walks month by month: the opening balance earns the whole month, and each
 * deposit earns the fraction of the month left after it landed. Months with no
 * published return yet are still credited with their deposits but earn nothing,
 * and the first such month is reported as `tailFrom` so the UI can say which
 * window is unmeasured. That window is now weeks rather than a whole quarter.
 */
export function revalue(fund, deposits, anchorBalance, anchorAsOf, todayKey) {
  const depositsAfter = deposits.filter((d) => d.date > anchorAsOf);
  let balance = anchorBalance;
  let tailFrom = null;
  const applied = [];

  const anchorMonth = monthKey(anchorAsOf);
  const todayMonth = monthKey(todayKey);
  const { y: ay, m: am, d: ad } = parseKey(anchorAsOf);
  const anchorDim = daysInMonth(ay, am);

  for (let mKey = anchorMonth; mKey <= todayMonth; mKey = addMonth(mKey)) {
    const r = netMonthlyReturn(fund, mKey);
    const inMonth = depositsAfter.filter((d) => monthKey(d.date) === mKey);

    // The anchor usually sits at a month end, but when it lands mid-month only
    // the remainder of that month may be applied to the balance.
    let openingFraction = 1;
    if (mKey === anchorMonth) openingFraction = (anchorDim - ad) / anchorDim;

    // An anchor on the last day of its month leaves nothing of that month to
    // revalue, so it must not demand a return for it — otherwise a statement
    // dated 31/03 would report the tail as starting in March forever.
    if (openingFraction === 0 && inMonth.length === 0) continue;

    if (r == null) {
      if (!tailFrom) tailFrom = mKey === anchorMonth ? anchorAsOf : mKey + '-01';
      for (const d of inMonth) balance += d.amount;
      continue;
    }

    applied.push(mKey);
    balance *= 1 + r * openingFraction;
    for (const d of inMonth) {
      const { y, m, d: day } = parseKey(d.date);
      const dim = daysInMonth(y, m);
      balance += d.amount * (1 + r * ((dim - day) / dim));
    }
  }

  // The last day the balance is backed by a published number. Derived here
  // rather than in the view, so no screen has to do date arithmetic to phrase
  // "accurate through …" correctly.
  const measuredThrough = tailFrom
    ? dateKey(new Date(Date.parse(tailFrom + 'T00:00:00Z') - dayMs))
    : todayKey;

  return {
    balance: round2(balance),
    tailFrom,
    measuredThrough,
    appliedMonths: applied.length,
    // Which months were actually applied on top of the anchor. An anchor dated
    // to the start of its month instead of the end makes that month's return
    // count twice — the statement already contains it — and the only visible
    // symptom is a balance that is quietly wrong. Surfacing the list lets the
    // UI show it before it costs anyone a reconciliation.
    appliedMonthList: applied,
  };
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
    xirr: null,
    tailFrom: null,
    measuredThrough: null,
    tailDeposits: 0,
    revaluedMonths: 0,
    revaluedFrom: null,
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
  let measuredThrough = null;
  let revaluedMonths = 0;
  let revaluedFrom = null;

  if (anchorAsOf && Number.isFinite(anchorBalance)) {
    const r = revalue(fund, deposits, anchorBalance, anchorAsOf, todayKey);
    balance = r.balance;
    revaluedMonths = r.appliedMonths;
    revaluedFrom = r.appliedMonthList[0] || null;
    tailFrom = r.tailFrom && r.tailFrom < todayKey ? r.tailFrom : null;
    measuredThrough = tailFrom ? r.measuredThrough : todayKey;
    // Only the deposits inside the unmeasured window are carried at face value.
    tailDeposits = tailFrom
      ? round2(deposits.filter((x) => x.date > tailFrom).reduce((s, x) => s + x.amount, 0))
      : 0;
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

  // Money-weighted return of the fund on its own: every deposit at its date,
  // today's balance as the terminal flow. Exact whenever the standing order is,
  // since both legs are facts rather than estimates.
  const fundFlows = deposits.map((x) => ({ date: x.date, amount: -x.amount }));
  if (balance > 0) fundFlows.push({ date: todayKey, amount: balance });
  const fundXirr = fundFlows.length >= 2 ? (xirr(fundFlows).value ?? null) : null;

  return {
    id: fund.id,
    name: fund.name,
    fundNumber: fund.fundNumber || null,
    xirr: fundXirr,
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
    measuredThrough,
    tailDeposits,
    revaluedMonths,
    revaluedFrom,
    returnsCount: (fund.returns || []).length,
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
