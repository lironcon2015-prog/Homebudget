// Budget carryover: the "יתרה מחודש קודם" planning rows.
//
// The rows have actual=0 by design (the money moved last month), so the
// balance a month hands over can only be read off the budget records — which
// is exactly what the chaining regression below locks down.
import test from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { loadCore } from './helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadBudget(transactions) {
  const ctx = loadCore({
    accounts: [{ id: 'a1', name: 'עו"ש', type: 'checking' }],
    categories: [
      { id: 'c1', name: 'מזון', type: 'expense' },
      { id: 'c2', name: 'משכורת', type: 'income' },
    ],
    transactions,
  })
  ctx.getCategoriesSorted = () => ctx.getCategories()
  ctx.toast = () => {}
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

const TXS = [
  { id: 't1', accountId: 'a1', date: '2026-07-05', amount: 10000, type: 'income',  categoryId: 'c2' },
  { id: 't2', accountId: 'a1', date: '2026-07-10', amount: -4000, type: 'expense', categoryId: 'c1' },
  { id: 't3', accountId: 'a1', date: '2026-08-03', amount: -1000, type: 'expense', categoryId: 'c1' },
]

test('carryover import writes the previous month net as an income row', async () => {
  const ctx = loadBudget(TXS)
  await ctx.importFor('2026-08')
  const rows = ctx.getBudgets()
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].categoryId, ctx._eval('CARRYOVER_INCOME_ID'))
  assert.strictEqual(rows[0].monthKey, '2026-08')
  assert.strictEqual(rows[0].amount, 6000)
  assert.strictEqual(rows[0].type, 'income')
})

test('carryover chains: an unspent surplus keeps rolling forward', async () => {
  const ctx = loadBudget(TXS)
  await ctx.importFor('2026-08')   // July: +10000 −4000 = +6000
  await ctx.importFor('2026-09')   // August: 6000 carried in, 1000 spent = +5000
  const sep = ctx.getBudgetsForMonth('2026-09')
  assert.strictEqual(sep.length, 1, 'exactly one carryover row for September')
  assert.strictEqual(sep[0].categoryId, ctx._eval('CARRYOVER_INCOME_ID'),
    'a surplus must stay a surplus — dropping the carry-in flipped it to a deficit')
  assert.strictEqual(sep[0].amount, 5000)
})

test('a real deficit still carries over as an expense row', async () => {
  const ctx = loadBudget([
    { id: 'x1', accountId: 'a1', date: '2026-07-05', amount: 3000,  type: 'income',  categoryId: 'c2' },
    { id: 'x2', accountId: 'a1', date: '2026-07-11', amount: -4200, type: 'expense', categoryId: 'c1' },
  ])
  await ctx.importFor('2026-08')
  const aug = ctx.getBudgetsForMonth('2026-08')
  assert.strictEqual(aug[0].categoryId, ctx._eval('CARRYOVER_EXPENSE_ID'))
  assert.strictEqual(aug[0].amount, 1200)
})

test('re-importing replaces the opposite carryover row instead of stacking', async () => {
  const ctx = loadBudget(TXS)
  ctx.setBudget(ctx._eval('CARRYOVER_EXPENSE_ID'), '2026-08', 900, 'expense')
  await ctx.importFor('2026-08')
  const aug = ctx.getBudgetsForMonth('2026-08')
  assert.strictEqual(aug.length, 1)
  assert.strictEqual(aug[0].categoryId, ctx._eval('CARRYOVER_INCOME_ID'))
  assert.strictEqual(aug[0].amount, 6000)
})

test('carryover rows count in the plan but never in the actuals', async () => {
  const ctx = loadBudget(TXS)
  await ctx.importFor('2026-08')
  const t = ctx.computeBudgetTotals('2026-08')
  assert.strictEqual(t.incBudget, 6000, 'carryover is a planned income')
  assert.strictEqual(t.incActual, 0,    'carryover never becomes actual income')
  assert.strictEqual(t.expActual, 1000)
  assert.strictEqual(ctx.budgetCarryIn('2026-08'), 6000)
  assert.strictEqual(ctx.budgetClosingBalance('2026-08'), 5000)
})

test('budgetCarryIn is signed and nets both rows', () => {
  const ctx = loadBudget([])
  assert.strictEqual(ctx.budgetCarryIn('2026-08'), 0)
  ctx.setBudget(ctx._eval('CARRYOVER_EXPENSE_ID'), '2026-08', 750, 'expense')
  assert.strictEqual(ctx.budgetCarryIn('2026-08'), -750)
})
