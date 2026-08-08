import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCore, deepEq } from './helpers.mjs'

const ACCOUNTS = [
  { id: 'chk', name: 'עו"ש', type: 'checking', openingBalance: 1000 },
  { id: 'cash', name: 'מזומן', type: 'cash', openingBalance: 0 },
  { id: 'cc', name: 'ויזה', type: 'credit_card', billingDay: 10, paymentVendorPatterns: ['ויזה 1234'] },
  { id: 'sav', name: 'חיסכון', type: 'savings', paymentVendorPatterns: ['הפקדה לחיסכון'] },
]
const CATEGORIES = [
  { id: 'cat_food', name: 'מזון', type: 'expense' },
  { id: 'cat_invest_out', name: 'חסכונות', type: 'expense', isSavings: true },
  { id: 'cat_salary', name: 'משכורת', type: 'income' },
  { id: 'cat_div', name: 'דיבידנד', type: 'income', isSavingsReduction: true },
]

function core(transactions = [], aliases = []) {
  return loadCore({ accounts: ACCOUNTS, categories: CATEGORIES, transactions, aliases })
}

// ===== P&L counting =====
test('isCountedIncome/Expense respect account scope and type', () => {
  const c = core()
  assert.equal(c.isCountedIncome({ accountId: 'chk', amount: 100, type: 'income' }), true)
  assert.equal(c.isCountedIncome({ accountId: 'cc', amount: 100, type: 'income' }), false)   // CC not in P&L
  assert.equal(c.isCountedIncome({ accountId: 'chk', amount: 100, type: 'transfer' }), false)
  assert.equal(c.isCountedIncome({ accountId: 'chk', amount: 100, type: 'refund' }), false)
  assert.equal(c.isCountedExpense({ accountId: 'chk', amount: -50, type: 'expense' }), true)
  assert.equal(c.isCountedExpense({ accountId: 'chk', amount: -50, type: 'transfer' }), false)
  assert.equal(c.isCountedExpense({ accountId: 'chk', amount: 80, type: 'refund' }), true)   // refund reduces expenses
})

test('countedExpenseAmount: refund is negative expense', () => {
  const c = core()
  assert.equal(c.countedExpenseAmount({ accountId: 'chk', amount: -50, type: 'expense' }), 50)
  assert.equal(c.countedExpenseAmount({ accountId: 'chk', amount: 80, type: 'refund' }), -80)
  assert.equal(c.countedExpenseAmount({ accountId: 'cc', amount: -50, type: 'expense' }), 0)
})

test('sumIncome/sumExpenses/sumNet', () => {
  const c = core()
  const txs = [
    { accountId: 'chk', amount: 1000, type: 'income' },
    { accountId: 'chk', amount: -300, type: 'expense' },
    { accountId: 'chk', amount: 50, type: 'refund' },
    { accountId: 'cc', amount: -999, type: 'expense' },       // out of P&L
    { accountId: 'chk', amount: -100, type: 'transfer' },     // transfer never counts
  ]
  assert.equal(c.sumIncome(txs), 1000)
  assert.equal(c.sumExpenses(txs), 250)
  assert.equal(c.sumNet(txs), 750)
})

test('sumHiddenSavings counts only isSavings categories; sumCapitalIncome only isSavingsReduction', () => {
  const c = core()
  const txs = [
    { accountId: 'chk', amount: -500, type: 'expense', categoryId: 'cat_invest_out' },
    { accountId: 'chk', amount: -200, type: 'expense', categoryId: 'cat_food' },
    { accountId: 'chk', amount: 900, type: 'income', categoryId: 'cat_div' },
    { accountId: 'chk', amount: 5000, type: 'income', categoryId: 'cat_salary' },
  ]
  assert.equal(c.sumHiddenSavings(txs), 500)
  assert.equal(c.sumCapitalIncome(txs), 900)
})

// ===== effective month =====
test('getTxEffectiveMonth: calendar month for non-CC, rollover for CC, chargeDate wins', () => {
  const c = core()
  assert.equal(c.getTxEffectiveMonth({ accountId: 'chk', date: '2026-06-25' }), '2026-06')
  // CC billingDay=10: before the 10th → same month; on/after → next month
  assert.equal(c.getTxEffectiveMonth({ accountId: 'cc', date: '2026-06-05' }), '2026-06')
  assert.equal(c.getTxEffectiveMonth({ accountId: 'cc', date: '2026-06-10' }), '2026-07')
  assert.equal(c.getTxEffectiveMonth({ accountId: 'cc', date: '2026-12-15' }), '2027-01')
  // explicit chargeDate wins outright
  assert.equal(c.getTxEffectiveMonth({ accountId: 'cc', date: '2026-06-25', chargeDate: '2026-09-10' }), '2026-09')
  // stray chargeDate on a checking account is ignored
  assert.equal(c.getTxEffectiveMonth({ accountId: 'chk', date: '2026-06-25', chargeDate: '2026-09-10' }), '2026-06')
})

test('monthsInPeriod spans year boundary', () => {
  const c = core()
  deepEq(c.monthsInPeriod({ start: '2025-11-05', end: '2026-02-20' }),
    ['2025-11', '2025-12', '2026-01', '2026-02'])
})

// ===== balances =====
test('getAccountBalance includes opening balance, own rows and mirror rows', () => {
  const txs = [
    { accountId: 'chk', amount: -400, type: 'expense', ccPaymentForAccountId: 'cc', date: '2026-06-01' },
    { accountId: 'chk', amount: -500, type: 'expense', transferAccountId: 'sav', date: '2026-06-02' },
    { accountId: 'cc', amount: -400, type: 'expense', date: '2026-05-20' },
    { accountId: 'chk', amount: 2000, type: 'income', date: '2026-06-03' },
  ]
  const c = core(txs)
  assert.equal(c.getAccountBalance('chk'), 1000 - 400 - 500 + 2000)
  assert.equal(c.getAccountBalance('cc'), -400 + 400)      // debt cleared by mirror of the payment
  assert.equal(c.getAccountBalance('sav'), 500)            // mirror side of the deposit
  // uptoDate cutoff
  assert.equal(c.getAccountBalance('chk', '2026-06-01'), 600)
})

test('getAccountFlow flips mirror-side sign', () => {
  const txs = [
    { accountId: 'chk', amount: -500, type: 'expense', transferAccountId: 'sav', date: '2026-06-02' },
    { accountId: 'sav', amount: -200, type: 'expense', date: '2026-06-05' },
  ]
  const c = core(txs)
  const flow = c.getAccountFlow('sav', { start: '2026-06-01', end: '2026-06-30' })
  assert.equal(flow.deposited, 500)
  assert.equal(flow.withdrawn, 200)
  assert.equal(flow.net, 300)
})

// ===== CC lump detection / analysis scope =====
test('shouldDropCcLump drops specific-pattern lump only when CC has detail', () => {
  const lump = { accountId: 'chk', amount: -1500, type: 'expense', vendor: 'ויזה 1234', description: '' }
  const c = core()
  // no detail → keep
  assert.equal(c.shouldDropCcLump(lump, new Set()), false)
  // detail present → drop
  assert.equal(c.shouldDropCcLump(lump, new Set(['cc'])), true)
  // generic keyword hit (no specific pattern) → never dropped
  const generic = { accountId: 'chk', amount: -900, type: 'expense', vendor: 'ישראכרט', description: '' }
  assert.equal(c.shouldDropCcLump(generic, new Set(['cc'])), false)
})

test('analysisExpenseAmount: transfers/savings rows excluded, refund negative, CC detail included', () => {
  const c = core()
  const savIds = c.analysisExpenseSavingsInvestIds()
  assert.equal(c.analysisExpenseAmount({ accountId: 'chk', amount: -100, type: 'expense' }, savIds, new Set()), 100)
  assert.equal(c.analysisExpenseAmount({ accountId: 'cc', amount: -70, type: 'expense' }, savIds, new Set()), 70)
  assert.equal(c.analysisExpenseAmount({ accountId: 'sav', amount: -70, type: 'expense' }, savIds, new Set()), 0)
  assert.equal(c.analysisExpenseAmount({ accountId: 'chk', amount: -70, type: 'transfer' }, savIds, new Set()), 0)
  assert.equal(c.analysisExpenseAmount({ accountId: 'chk', amount: 30, type: 'refund' }, savIds, new Set()), -30)
})

// ===== vendor aliases =====
test('resolveVendor: substring match, amount/day filters, specificity ordering', () => {
  const aliases = [
    { id: 'a1', patterns: ['העברה'], displayName: 'כללי' },
    { id: 'a2', patterns: ['העברה'], displayName: 'משכנתא', amountMin: 4000, amountMax: 6000 },
    { id: 'a3', patterns: ['מחיר ראשון'], displayName: 'קניות חודש', dayMin: 1, dayMax: 10 },
  ]
  const c = core([], aliases)
  // filtered alias outranks unfiltered for same needle
  assert.equal(c.resolveVendor('העברה בנקאית', 5000), 'משכנתא')
  assert.equal(c.resolveVendor('העברה בנקאית', 200), 'כללי')
  // alias with amount filter is skipped when amount not passed
  assert.equal(c.resolveVendor('העברה בנקאית'), 'כללי')
  // day filter
  assert.equal(c.resolveVendor('מחיר ראשון בעמ', -300, 5), 'קניות חודש')
  assert.equal(c.resolveVendor('מחיר ראשון בעמ', -300, 25), 'מחיר ראשון בעמ')
})

test('parseAliasAmountRange forms', () => {
  const c = core()
  deepEq(c.parseAliasAmountRange('100-200'), { amountMin: 100, amountMax: 200 })
  deepEq(c.parseAliasAmountRange('5000'), { amountMin: 5000, amountMax: 5000 })
  deepEq(c.parseAliasAmountRange('100-'), { amountMin: 100, amountMax: null })
  deepEq(c.parseAliasAmountRange('-200'), { amountMin: null, amountMax: 200 })
  deepEq(c.parseAliasAmountRange('200-100'), { amountMin: 100, amountMax: 200 })  // swapped bounds
  deepEq(c.parseAliasAmountRange('1,193'), { amountMin: 1193, amountMax: 1193 })
  deepEq(c.parseAliasAmountRange(''), { amountMin: null, amountMax: null })
})

// ===== date helpers =====
test('_dmyToIso validates real calendar dates', () => {
  const c = core()
  assert.equal(c._dmyToIso('15/07/2026'), '2026-07-15')
  assert.equal(c._dmyToIso('15/07/26'), '2026-07-15')
  assert.equal(c._dmyToIso('29/02/2024'), '2024-02-29')
  assert.equal(c._dmyToIso('29/02/2025'), '')
  assert.equal(c._dmyToIso('31/04/2026'), '')
  assert.equal(c._dmyToIso('00/05/2026'), '')
  assert.equal(c._dmyToIso('junk'), '')
})

test('filterByEffectivePeriod matches by effective month', () => {
  const c = core()
  const txs = [
    { accountId: 'cc', date: '2026-06-25' },   // effective 2026-07 (after billingDay)
    { accountId: 'chk', date: '2026-06-25' },  // effective 2026-06
  ]
  const july = c.filterByEffectivePeriod(txs, { start: '2026-07-01', end: '2026-07-31' })
  assert.equal(july.length, 1)
  assert.equal(july[0].accountId, 'cc')
})

// ===== category rules =====
test('matchVendorToCategory: user rules outrank defaults; account-derived rules apply', () => {
  const c = core()
  assert.equal(c.matchVendorToCategory('שופרסל דיל', ''), 'cat_food')
  assert.equal(c.matchVendorToCategory('הפקדה לחיסכון חודשית', ''), 'cat_invest_out')  // from sav account patterns
  c.addCategoryRule('שופרסל', 'cat_invest_out')
  assert.equal(c.matchVendorToCategory('שופרסל דיל', ''), 'cat_invest_out')
})

test('getAccountBalanceSeries equals per-cutoff getAccountBalance (incl. undated tx)', () => {
  const txs = [
    { accountId: 'chk', amount: -100, type: 'expense', date: '2026-05-15' },
    { accountId: 'chk', amount: -400, type: 'expense', ccPaymentForAccountId: 'cc', date: '2026-06-01' },
    { accountId: 'chk', amount: 2000, type: 'income', date: '2026-07-03' },
    { accountId: 'chk', amount: -7, type: 'expense' },                       // undated → counts everywhere
    { accountId: 'chk', amount: -500, type: 'expense', transferAccountId: 'sav', date: '2026-06-20' },
  ]
  const c = core(txs)
  const cutoffs = ['2026-05-31', '2026-06-30', '2026-07-31']
  for (const acc of ['chk', 'cc', 'sav']) {
    const series = c.getAccountBalanceSeries(acc, cutoffs)
    cutoffs.forEach((cut, i) => {
      assert.equal(series[i], c.getAccountBalance(acc, cut), `${acc} @ ${cut}`)
    })
  }
  deepEq(c.getAccountBalanceSeries('missing', cutoffs), [0, 0, 0])
})

// ===== CHARGE DATE -> BILL CYCLE =====
// A charge date names the day money moves; the cycle containing it names the
// bill. They differ for anything charged before the billing day.

test('billingMonthForChargeDate: the cycle is (billingDay, billingDay]', () => {
  const c = loadCore({ accounts: [] })
  const f = c.billingMonthForChargeDate
  // An instalment charged on the purchase's day-of-month, mid-cycle.
  assert.equal(f('2026-07-30', 10), '2026-08')
  assert.equal(f('2026-07-11', 10), '2026-08')
  // The bill's own charge date closes the cycle it belongs to.
  assert.equal(f('2026-08-10', 10), '2026-08')
  assert.equal(f('2026-08-02', 10), '2026-08')
  // One day past it opens the next.
  assert.equal(f('2026-08-11', 10), '2026-09')
  // Year boundary.
  assert.equal(f('2026-12-30', 10), '2027-01')
  // Other billing days, and junk.
  assert.equal(f('2026-07-02', 2), '2026-07')
  assert.equal(f('2026-07-03', 2), '2026-08')
  assert.equal(f('', 10), '')
  assert.equal(f('2026-07', 10), '')
})

test('getTxEffectiveMonth reads a charge date as its containing cycle', () => {
  const c = loadCore({ accounts: [{ id: 'cc1', type: 'credit_card', billingDay: 10 }] })
  // Instalment: purchase in November, charged 30/07 → the August bill.
  assert.equal(c.getTxEffectiveMonth({ accountId: 'cc1', date: '2025-11-30', chargeDate: '2026-07-30' }), '2026-08')
  // Ordinary row on the same bill.
  assert.equal(c.getTxEffectiveMonth({ accountId: 'cc1', date: '2026-07-15', chargeDate: '2026-08-10' }), '2026-08')
  // An explicit billingMonth still outranks the charge date.
  assert.equal(c.getTxEffectiveMonth({ accountId: 'cc1', date: '2025-11-30', chargeDate: '2026-07-30', billingMonth: '2026-09' }), '2026-09')
  // Non-credit accounts ignore charge dates entirely.
  const b = loadCore({ accounts: [{ id: 'b1', type: 'checking' }] })
  assert.equal(b.getTxEffectiveMonth({ accountId: 'b1', date: '2026-07-15', chargeDate: '2026-08-10' }), '2026-07')
})

// ===== ANALYSIS EXCLUSION LENS =====
test('applyAnalysisExclusions drops only the expense side of an excluded category', () => {
  const c = core()
  const txs = [
    { id: 'a', accountId: 'chk', amount: -500, type: 'expense',  categoryId: 'cat_invest_out' },
    { id: 'b', accountId: 'chk', amount:  120, type: 'refund',   categoryId: 'cat_invest_out' },
    { id: 'c', accountId: 'chk', amount:  900, type: 'income',   categoryId: 'cat_invest_out' },
    { id: 'd', accountId: 'chk', amount: -300, type: 'transfer', categoryId: 'cat_invest_out' },
    { id: 'e', accountId: 'chk', amount: -200, type: 'expense',  categoryId: 'cat_food' },
  ]
  const excl = new Set(['cat_invest_out'])
  const kept = c.applyAnalysisExclusions(txs, excl).map(t => t.id)
  // Expense and refund (a negative expense) go; income and transfer stay.
  deepEq(kept, ['c', 'd', 'e'])
})

test('applyAnalysisExclusions with an empty set is a no-op', () => {
  const c = core()
  const txs = [{ accountId: 'chk', amount: -100, type: 'expense', categoryId: 'cat_food' }]
  assert.equal(c.applyAnalysisExclusions(txs, new Set()), txs)
})

test('excluding an uncategorized expense uses the __none__ key', () => {
  const c = core()
  const NONE = c._eval('ANALYSIS_EXCL_UNCATEGORIZED')
  const txs = [
    { id: 'a', accountId: 'chk', amount: -100, type: 'expense' },
    { id: 'b', accountId: 'chk', amount: -100, type: 'expense', categoryId: 'cat_food' },
  ]
  deepEq(c.applyAnalysisExclusions(txs, new Set([NONE])).map(t => t.id), ['b'])
})

test('analysisExcludableTotals reports the breakdown scope, not the P&L scope', () => {
  const c = core()
  const txs = [
    { accountId: 'chk', amount: -200, type: 'expense', categoryId: 'cat_food' },
    { accountId: 'cc',  amount: -300, type: 'expense', categoryId: 'cat_food' },  // CC detail: outside P&L, inside the breakdown
    { accountId: 'sav', amount: -400, type: 'expense', categoryId: 'cat_food' },  // savings-account side: never in the breakdown
    { accountId: 'chk', amount:   50, type: 'refund',  categoryId: 'cat_food' },
  ]
  const totals = c.analysisExcludableTotals(txs)
  assert.equal(totals.get('cat_food'), 450)  // 200 + 300 − 50
  assert.equal(c.sumAnalysisExcluded(txs, new Set(['cat_food'])), 450)
  assert.equal(c.sumAnalysisExcluded(txs, new Set()), 0)
})

test('neutralizing savings moves expenses by exactly the hidden-savings amount', () => {
  const c = core()
  const txs = [
    { accountId: 'chk', amount: 10000, type: 'income',  categoryId: 'cat_salary' },
    { accountId: 'chk', amount: -3000, type: 'expense', categoryId: 'cat_food' },
    { accountId: 'chk', amount: -2000, type: 'expense', categoryId: 'cat_invest_out' },
  ]
  const hidden = c.sumHiddenSavings(txs)
  const lensed = c.applyAnalysisExclusions(txs, new Set(['cat_invest_out']))
  assert.equal(c.sumExpenses(txs) - c.sumExpenses(lensed), hidden)
  // Income is untouched, so the "true savings rate" the analysis screen shows
  // (net + hiddenSavings) is the same number through the lens as without it.
  assert.equal(c.sumNet(lensed), c.sumNet(txs) + hidden)
  assert.equal(c.sumHiddenSavings(lensed), 0)
})

test('analysis exclusions round-trip through storage', () => {
  const c = core()
  deepEq(c.getAnalysisExcludedCats(), [])
  c.saveAnalysisExcludedCats(['cat_food', 'cat_invest_out', 'cat_food'])
  deepEq(c.getAnalysisExcludedCats(), ['cat_food', 'cat_invest_out'])  // deduped
  assert.equal(c.analysisExcludedCatSet().has('cat_food'), true)
})

test('a dangling categoryId neutralizes with "לא מסווג", as the breakdown groups it', () => {
  const c = core()
  const NONE = c._eval('ANALYSIS_EXCL_UNCATEGORIZED')
  const txs = [
    { id: 'a', accountId: 'chk', amount: -700, type: 'expense', categoryId: 'cat_deleted' },
    { id: 'b', accountId: 'chk', amount: -300, type: 'expense' },
    { id: 'c', accountId: 'chk', amount: -100, type: 'expense', categoryId: 'cat_food' },
  ]
  // The picker only ever offers real categories plus "לא מסווג", so the
  // deleted-category money must land in that bucket or be unreachable.
  assert.equal(c.analysisExcludableTotals(txs).get(NONE), 1000)
  deepEq(c.applyAnalysisExclusions(txs, new Set([NONE])).map(t => t.id), ['c'])
})
