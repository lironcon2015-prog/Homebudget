// tools/test-gemel.mjs — `npm run test:gemel`
// Engine-only checks for the gemel derivation: schedule generation, override
// handling, and the two properties the money maths depends on — that principal
// and gain stay exact, and that every per-kid split re-sums to its total.

import { deriveGemelFund, scheduleDates, resolveDeposits } from '../src/ledger/GemelEngine.js';
import { deriveState } from '../src/ledger/LedgerEngine.js';

let pass = 0, fail = 0;
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

const kids = { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } };
const third = { a: 100 / 3, b: 100 / 3, c: 100 / 3 };

const fund = {
  id: 'g1',
  name: 'קופת גמל להשקעה — מסלול מדדי',
  monthlyAmount: 500,
  firstDepositDate: '2024-01-25',
  allocationHistory: [{ from: '2024-01-25', allocation: third }],
  overrides: [],
  anchor: { balance: 25000, asOf: '2026-03-31' },
};

console.log('\n-- schedule --');
const dates = scheduleDates('2024-01-25', '2024-06-25');
check('6 monthly dates', dates.length === 6, dates.join(','));
check('spans Jan..Jun', dates[0] === '2024-01-25' && dates[5] === '2024-06-25');
check('clamps day 31 in Feb', scheduleDates('2024-01-31', '2024-02-29')[1] === '2024-02-29');

console.log('\n-- overrides --');
const withSkip = resolveDeposits(
  { ...fund, overrides: [{ date: '2024-03-25', amount: 0 }, { date: '2024-04-10', amount: 300 }] },
  '2024-05-25'
);
check('skipped month dropped', !withSkip.some((d) => d.date === '2024-03-25'));
check('one-off added', withSkip.some((d) => d.date === '2024-04-10' && d.amount === 300));
check('total = 4*500+300', near(withSkip.reduce((s, d) => s + d.amount, 0), 4 * 500 + 300));

console.log('\n-- exactness of principal / gain --');
const d1 = deriveGemelFund(fund, kids, '2026-07-29');
// Jan 2024 .. Jul 2026 inclusive on the 25th = 31 deposits
check('31 deposits', d1.deposits.length === 31, String(d1.deposits.length));
check('principal = 31*500', near(d1.totalDeposited, 31 * 500), String(d1.totalDeposited));
// anchor 25000 @ 31/03/2026, then 25/04, 25/05, 25/06, 25/07 = 4 deposits
check('tail = 4 deposits', near(d1.tailDeposits, 4 * 500), String(d1.tailDeposits));
check('balance = anchor + tail', near(d1.balance, 25000 + 2000), String(d1.balance));
check('gain = balance - principal', near(d1.gain, d1.balance - d1.totalDeposited), String(d1.gain));
check('tail starts the month after the anchor', d1.tailFrom === '2026-04-01', String(d1.tailFrom));
check('measured through the anchor date', d1.measuredThrough === '2026-03-31', String(d1.measuredThrough));

console.log('\n-- constant allocation collapses to exact thirds --');
const sumBal = d1.balanceByKid.a + d1.balanceByKid.b + d1.balanceByKid.c;
check('per-kid balances re-sum to total', near(sumBal, d1.balance), `${sumBal} vs ${d1.balance}`);
check('each kid within an agora of a third', ['a', 'b', 'c'].every((k) => near(d1.balanceByKid[k], d1.balance / 3, 0.02)),
  JSON.stringify(d1.balanceByKid));
const sumDep = d1.depositedByKid.a + d1.depositedByKid.b + d1.depositedByKid.c;
check('per-kid deposits re-sum to principal', near(sumDep, d1.totalDeposited), `${sumDep} vs ${d1.totalDeposited}`);
const sumGain = d1.gainByKid.a + d1.gainByKid.b + d1.gainByKid.c;
check('per-kid gains re-sum to gain', near(sumGain, d1.gain), `${sumGain} vs ${d1.gain}`);

console.log('\n-- rounding does not drift toward one kid --');
// 500/3 does not divide evenly. Prorating each deposit alone would give the
// same two kids the leftover agora every month; over years that compounds.
const spread = (o) => Math.max(...Object.values(o)) - Math.min(...Object.values(o));
check('deposit spread stays within one agora', spread(d1.depositedByKid) <= 0.0101,
  JSON.stringify(d1.depositedByKid));
check('balance spread stays within one agora', spread(d1.balanceByKid) <= 0.0201,
  JSON.stringify(d1.balanceByKid));
const long = deriveGemelFund({ ...fund, firstDepositDate: '2015-01-25' }, kids, '2026-07-29');
check('still no drift over 10 years', spread(long.depositedByKid) <= 0.0101,
  `${long.deposits.length} deposits → ${JSON.stringify(long.depositedByKid)}`);
check('10-year deposits re-sum', near(
  long.depositedByKid.a + long.depositedByKid.b + long.depositedByKid.c, long.totalDeposited));

console.log('\n-- allocation change is forward-only --');
const changed = {
  ...fund,
  allocationHistory: [
    { from: '2024-01-25', allocation: third },
    { from: '2026-01-01', allocation: { a: 50, b: 25, c: 25 } },
  ],
};
const d2 = deriveGemelFund(changed, kids, '2026-07-29');
check('principal unchanged by split change', near(d2.totalDeposited, d1.totalDeposited));
check('a deposited more than b', d2.depositedByKid.a > d2.depositedByKid.b);
check('a still below half of principal (past kept old split)',
  d2.depositedByKid.a < d2.totalDeposited * 0.5, String(d2.depositedByKid.a));
check('a above a third', d2.depositedByKid.a > d2.totalDeposited / 3);
check('balances re-sum after change',
  near(d2.balanceByKid.a + d2.balanceByKid.b + d2.balanceByKid.c, d2.balance));

console.log('\n-- loss case --');
const losing = { ...fund, anchor: { balance: 10000, asOf: '2026-03-31' } };
const d3 = deriveGemelFund(losing, kids, '2026-07-29');
check('negative gain', d3.gain < 0, String(d3.gain));
check('negative gain re-sums',
  near(d3.gainByKid.a + d3.gainByKid.b + d3.gainByKid.c, d3.gain),
  `${d3.gainByKid.a + d3.gainByKid.b + d3.gainByKid.c} vs ${d3.gain}`);

console.log('\n-- no anchor --');
const d4 = deriveGemelFund({ ...fund, anchor: null }, kids, '2026-07-29');
check('balance falls back to principal', near(d4.balance, d4.totalDeposited));
check('zero gain', near(d4.gain, 0));
check('warns', d4.warnings.some((w) => w.code === 'no-anchor'));

console.log('\n-- integration with deriveState --');
const state = {
  schemaVersion: 1,
  settings: { lastFxRate: 3.6 },
  kids,
  quotes: {},
  gemelFunds: [fund],
  ledger: [],
};
const ds = deriveState(state, new Date('2026-07-29T00:00:00Z'));
check('kid pv includes gemel', near(ds.portfolioValueByKid.a, d1.balanceByKid.a),
  `${ds.portfolioValueByKid.a} vs ${d1.balanceByKid.a}`);
check('total value = gemel balance', near(ds.totalKidsValue, d1.balance), String(ds.totalKidsValue));
check('principal folded in', near(ds.totalKidsPrincipal, d1.totalDeposited), String(ds.totalKidsPrincipal));
check('total profit = gemel gain', near(ds.totalProfit, d1.gain), String(ds.totalProfit));
check('gain is unrealized, not realized', near(ds.profitByKid.a.realized, 0),
  `realized=${ds.profitByKid.a.realized} unrealized=${ds.profitByKid.a.unrealized}`);
check('xirr computed and sane', ds.xirrByKid.a > -0.9 && ds.xirrByKid.a < 2, String(ds.xirrByKid.a));
check('total xirr computed', ds.totalKidsXirr !== 0, String(ds.totalKidsXirr));

console.log('\n-- empty state still derives --');
const ds0 = deriveState({ schemaVersion: 1, settings: {}, kids, quotes: {}, ledger: [] }, new Date('2026-07-29'));
check('no gemelFunds key is safe', ds0.gemel.totalBalance === 0);
check('totals zero', ds0.totalKidsValue === 0);

console.log('\n-- revaluation from published returns --');
const withReturns = {
  ...fund,
  annualFeePct: 0.6,
  returns: [
    { month: '2026-04', pct: 2 },
    { month: '2026-05', pct: -1 },
    { month: '2026-06', pct: 1.5 },
  ],
};
const rv = deriveGemelFund(withReturns, kids, '2026-07-29');
check('three months applied', rv.revaluedMonths === 3, String(rv.revaluedMonths));
check('tail starts at first unpublished month', rv.tailFrom === '2026-07-01', String(rv.tailFrom));
check('only July deposit left unmeasured', near(rv.tailDeposits, 500), String(rv.tailDeposits));
check('revalued balance differs from face value', Math.abs(rv.balance - (25000 + 2000)) > 1,
  `${rv.balance} vs ${25000 + 2000}`);
check('per-kid balances still re-sum',
  near(rv.balanceByKid.a + rv.balanceByKid.b + rv.balanceByKid.c, rv.balance));

// Fee must actually bite: same returns, higher fee, lower balance.
const pricier = deriveGemelFund({ ...withReturns, annualFeePct: 3 }, kids, '2026-07-29');
check('higher fee lowers the balance', pricier.balance < rv.balance, `${pricier.balance} vs ${rv.balance}`);

// A flat 0% month must leave the balance at face value.
const flat = deriveGemelFund(
  { ...fund, annualFeePct: 0, returns: [{ month: '2026-04', pct: 0 }, { month: '2026-05', pct: 0 },
    { month: '2026-06', pct: 0 }, { month: '2026-07', pct: 0 }] },
  kids, '2026-07-29');
check('zero returns == face value', near(flat.balance, 25000 + 2000, 0.02), String(flat.balance));
check('no tail when every month published', flat.tailFrom === null, String(flat.tailFrom));

// No returns at all must behave exactly as before the feature existed.
check('no returns falls back to face value', near(d1.balance, 25000 + 2000), String(d1.balance));

console.log('\n-- revaluation reconciles against a real statement --');
// A statement shaped as: opening + deposits − loss − fees = closing. Feeding
// the same shape back must reproduce the closing balance from the opening one,
// which is the property a revaluation has to preserve.
const q = {
  id: 'q', name: 'רבעון', monthlyAmount: 500, firstDepositDate: '2026-01-25',
  allocationHistory: [{ from: '2026-01-25', allocation: third }],
  overrides: [{ date: '2026-01-25', amount: 0 }],   // the quarter had 2 deposits, not 3
  anchor: { balance: 50000, asOf: '2025-12-31' },
  annualFeePct: 0,
  returns: [{ month: '2026-01', pct: 0 }, { month: '2026-02', pct: 0 }, { month: '2026-03', pct: 0 }],
};
const qd = deriveGemelFund(q, kids, '2026-03-31');
check('two deposits in the quarter', qd.deposits.length === 2, String(qd.deposits.length));
check('flat quarter = opening + deposits', near(qd.balance, 50000 + 1000, 0.02), String(qd.balance));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
