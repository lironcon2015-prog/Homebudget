// Budget carryover: the "יתרה מחודש קודם" planning rows.
//
// The carried figure is the MONEY IN THE ACCOUNTS on the last day of the
// previous month — the bank statement's closing balance — not the budget
// screen's own surplus/deficit. The rows are plan-only (actual is always 0),
// so nothing here may leak into the actuals.
import test from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { loadCore } from './helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const ACCOUNTS = [
  { id: 'a1', name: 'עו"ש', type: 'checking', openingBalance: 2000 },
  { id: 'cc1', name: 'ויזה', type: 'credit_card', billingDay: 10 },
]

function loadBudget(transactions, accounts = ACCOUNTS) {
  const ctx = loadCore({
    accounts,
    categories: [
      { id: 'c1', name: 'מזון', type: 'expense' },
      { id: 'c2', name: 'משכורת', type: 'income' },
    ],
    transactions,
  })
  ctx.getCategoriesSorted = () => ctx.getCategories()
  ctx.toast = (msg) => { ctx._lastToast = msg }
  ctx.confirmDialog = async () => true
  ctx.renderBudgetScreen = () => {}
  ctx.formatCurrency = n => 'ILS' + n
  ctx.formatCurrencyPlain = n => String(n)
  vm.runInContext(readFileSync(join(root, 'budget.js'), 'utf8'), ctx, { filename: 'budget.js' })
  ctx.importFor = async monthKey => {
    ctx._eval(`_budgetScreenMonth = ${JSON.stringify(monthKey)}`)
    await ctx._eval('importCarryoverFromPrevMonth()')
  }
  return ctx
}

// Opening 2,000 → July closes at 8,000 → August spends 1,000 → closes at 7,000.
const TXS = [
  { id: 't1', accountId: 'a1', date: '2026-07-05', amount: 10000, type: 'income',  categoryId: 'c2' },
  { id: 't2', accountId: 'a1', date: '2026-07-10', amount: -4000, type: 'expense', categoryId: 'c1' },
  { id: 't3', accountId: 'a1', date: '2026-08-03', amount: -1000, type: 'expense', categoryId: 'c1' },
]

test('carryover imports the accounts balance on the last day of the previous month', async () => {
  const ctx = loadBudget(TXS)
  await ctx.importFor('2026-08')
  const rows = ctx.getBudgets()
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].categoryId, ctx._eval('CARRYOVER_INCOME_ID'))
  assert.strictEqual(rows[0].monthKey, '2026-08')
  assert.strictEqual(rows[0].amount, 8000, 'opening 2000 + 10000 − 4000, not the budget net of 6000')
  assert.strictEqual(rows[0].type, 'income')
})

test('the balance is measured on the 30th/31st, ignoring later transactions', () => {
  const ctx = loadBudget(TXS)
  assert.strictEqual(ctx.budgetPhysicalBalance('2026-07'), 8000)
  assert.strictEqual(ctx.budgetPhysicalBalance('2026-08'), 7000, 'August spend counts, nothing after 31/08 does')
  assert.strictEqual(ctx._eval('_monthEndISO("2026-02")'), '2026-02-28')
  assert.strictEqual(ctx._eval('_monthEndISO("2026-07")'), '2026-07-31')
})

test('each month carries the balance of its own closing date', async () => {
  const ctx = loadBudget(TXS)
  await ctx.importFor('2026-08')
  await ctx.importFor('2026-09')
  const sep = ctx.getBudgetsForMonth('2026-09')
  assert.strictEqual(sep.length, 1)
  assert.strictEqual(sep[0].categoryId, ctx._eval('CARRYOVER_INCOME_ID'))
  assert.strictEqual(sep[0].amount, 7000, '8000 carried in, 1000 spent — read off the account, not re-derived')
})

test('credit-card balances never enter the carried figure', async () => {
  const ctx = loadBudget([
    ...TXS,
    { id: 't4', accountId: 'cc1', date: '2026-07-08', amount: -2500, type: 'expense', categoryId: 'c1' },
  ])
  await ctx.importFor('2026-08')
  assert.strictEqual(ctx.getBudgetsForMonth('2026-08')[0].amount, 8000)
})

test('an overdrawn account carries over as a deficit row', async () => {
  const ctx = loadBudget([
    { id: 'x1', accountId: 'a1', date: '2026-07-05', amount: 1000,  type: 'income',  categoryId: 'c2' },
    { id: 'x2', accountId: 'a1', date: '2026-07-11', amount: -4200, type: 'expense', categoryId: 'c1' },
  ])
  await ctx.importFor('2026-08')
  const aug = ctx.getBudgetsForMonth('2026-08')
  assert.strictEqual(aug[0].categoryId, ctx._eval('CARRYOVER_EXPENSE_ID'))
  assert.strictEqual(aug[0].amount, 1200, '2000 + 1000 − 4200 = −1200')
})

test('re-importing replaces the opposite carryover row instead of stacking', async () => {
  const ctx = loadBudget(TXS)
  ctx.setBudget(ctx._eval('CARRYOVER_EXPENSE_ID'), '2026-08', 900, 'expense')
  await ctx.importFor('2026-08')
  const aug = ctx.getBudgetsForMonth('2026-08')
  assert.strictEqual(aug.length, 1)
  assert.strictEqual(aug[0].categoryId, ctx._eval('CARRYOVER_INCOME_ID'))
  assert.strictEqual(aug[0].amount, 8000)
})

test('the carried balance counts on both sides — plan and actual', async () => {
  const ctx = loadBudget(TXS)
  await ctx.importFor('2026-08')
  const t = ctx.computeBudgetTotals('2026-08')
  assert.strictEqual(t.incBudget, 8000, 'carryover is a planned income')
  assert.strictEqual(t.incActual, 8000, 'the money is already in the account — it is actual too')
  assert.strictEqual(t.expActual, 1000)
  assert.strictEqual(ctx.budgetCarryIn('2026-08'), 8000)
  assert.strictEqual(ctx.budgetClosingBalance('2026-08'), 7000, 'net already contains the carried row')
})

test('a deficit row counts as actual on the expense side', async () => {
  const ctx = loadBudget([])
  ctx.setBudget(ctx._eval('CARRYOVER_EXPENSE_ID'), '2026-08', 1200, 'expense')
  const t = ctx.computeBudgetTotals('2026-08')
  assert.strictEqual(t.expBudget, 1200)
  assert.strictEqual(t.expActual, 1200)
})

test('the carried amount is stored in agorot, not float dust', async () => {
  // 2000 + 4000.1 − 1000.2 is 4999.900000000001 in IEEE-754 — the trail of
  // digits the number input was printing.
  const ctx = loadBudget([
    { id: 'f1', accountId: 'a1', date: '2026-07-02', amount: 4000.1,  type: 'income',  categoryId: 'c2' },
    { id: 'f2', accountId: 'a1', date: '2026-07-04', amount: -1000.2, type: 'expense', categoryId: 'c1' },
  ])
  const raw = ctx.getCheckingCashBalance('2026-07-31')
  assert.notStrictEqual(raw, 4999.9, `precondition: the raw sum carries dust (${raw})`)
  await ctx.importFor('2026-08')
  const amount = ctx.getBudgetsForMonth('2026-08')[0].amount
  assert.strictEqual(amount, 4999.9, 'rounded to two decimals on the way in')
  assert.ok(/^\d+(\.\d{1,2})?$/.test(String(amount)), `no trailing digits: ${amount}`)
})

test('budgetCarryIn is signed and nets both rows', () => {
  const ctx = loadBudget([])
  assert.strictEqual(ctx.budgetCarryIn('2026-08'), 0)
  ctx.setBudget(ctx._eval('CARRYOVER_EXPENSE_ID'), '2026-08', 750, 'expense')
  assert.strictEqual(ctx.budgetCarryIn('2026-08'), -750)
})

test('with no checking/cash account the import refuses instead of writing zero', async () => {
  const ctx = loadBudget([], [{ id: 'cc1', name: 'ויזה', type: 'credit_card' }])
  await ctx.importFor('2026-08')
  assert.strictEqual(ctx.getBudgets().length, 0)
  assert.match(ctx._lastToast, /עו/)
})
