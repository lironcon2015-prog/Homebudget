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
