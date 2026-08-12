import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApp, makeDbStub } from './helpers.mjs'

// reports.js touches no DOM and no XLSX at load time, so it can be loaded next to
// core.js with plain data stubs. The point of these tests is PARITY: the printed
// report and the analysis screen must never quote different savings rates.
function reports({ accounts = [], categories = [], transactions = [] } = {}) {
  return loadApp(['core.js', 'reports.js'], {
    DB: makeDbStub({ finTransactions: transactions }),
    getAccounts: () => accounts,
    getCategories: () => categories,
    getCategoryById: id => categories.find(c => c.id === id) || null,
    getTransactions: () => transactions,
    formatCurrency: v => String(v),
    escHtml: s => String(s),
    toast: () => {},
  })
}

const ACCOUNTS = [{ id: 'chk', name: 'עו"ש', type: 'checking', openingBalance: 0 }]
const CATEGORIES = [
  { id: 'cat_food', name: 'מזון', type: 'expense' },
  { id: 'cat_invest_out', name: 'חסכונות', type: 'expense', isSavings: true },
  { id: 'cat_salary', name: 'משכורת', type: 'income' },
  { id: 'cat_div', name: 'דיבידנד', type: 'income', isSavingsReduction: true },
]

// The formula the analysis screen renders, spelled out here so a change on one
// side fails loudly instead of drifting.
function analysisScreenRate({ income, expenses, refunds, hiddenSavings, capitalIncome }) {
  const net = income - expenses + refunds
  const realIncome = income - capitalIncome
  const realSavings = net + hiddenSavings - capitalIncome
  return realIncome > 0 ? realSavings / realIncome : 0
}

test('_reportSavingsRate matches the analysis screen, capital income on both sides', () => {
  const c = reports({ accounts: ACCOUNTS, categories: CATEGORIES })
  const d = { income: 20000, expenses: 14000, refunds: 500, hiddenSavings: 4000, capitalIncome: 3000 }
  d.net = d.income - d.expenses + d.refunds
  const rate = c._eval('_reportSavingsRate')(d)
  assert.equal(Math.round(rate * 1000) / 1000, 0.441)
  assert.equal(rate, analysisScreenRate(d))
})

test('_reportSavingsRate: no capital income, hidden savings returned to the numerator', () => {
  const c = reports({ accounts: ACCOUNTS, categories: CATEGORIES })
  const d = { income: 10000, expenses: 8000, refunds: 0, hiddenSavings: 3000, capitalIncome: 0 }
  d.net = d.income - d.expenses + d.refunds
  assert.equal(c._eval('_reportSavingsRate')(d), 0.5)   // (2000 + 3000) / 10000
  assert.equal(c._eval('_reportSavingsRate')(d), analysisScreenRate(d))
})

test('_reportSavingsRate is 0 when the period has no earned income', () => {
  const c = reports({ accounts: ACCOUNTS, categories: CATEGORIES })
  const rate = c._eval('_reportSavingsRate')
  assert.equal(rate({ income: 0, expenses: 500, refunds: 0, net: -500, hiddenSavings: 0, capitalIncome: 0 }), 0)
  // Income that is ENTIRELY capital leaves no real income to divide by.
  assert.equal(rate({ income: 4000, expenses: 0, refunds: 0, net: 4000, hiddenSavings: 0, capitalIncome: 4000 }), 0)
})

test('_reportData splits the three flows and feeds the same rate the screen shows', () => {
  const transactions = [
    { id: 'i1', accountId: 'chk', date: '2026-08-01', amount: 20000, type: 'income', categoryId: 'cat_salary' },
    { id: 'i2', accountId: 'chk', date: '2026-08-02', amount: 3000, type: 'income', categoryId: 'cat_div' },
    { id: 'e1', accountId: 'chk', date: '2026-08-10', amount: -10000, type: 'expense', categoryId: 'cat_food' },
    { id: 'e2', accountId: 'chk', date: '2026-08-11', amount: -4000, type: 'expense', categoryId: 'cat_invest_out' },
    { id: 'r1', accountId: 'chk', date: '2026-08-20', amount: 500, type: 'refund', categoryId: 'cat_food' },
  ]
  const c = reports({ accounts: ACCOUNTS, categories: CATEGORIES, transactions })
  c._eval('setActivePeriod({ key: "custom", label: "test", start: "2026-08-01", end: "2026-08-31" })')
  const d = c._eval('_reportData')()
  assert.equal(d.income, 23000)
  assert.equal(d.expenses, 14000)          // gross: the refund does not shrink it
  assert.equal(d.refunds, 500)
  assert.equal(d.net, 9500)                // 23000 - 14000 + 500
  assert.equal(d.hiddenSavings, 4000)
  assert.equal(d.capitalIncome, 3000)
  assert.equal(d.refundBreakdownTotal, 500)
  const rate = c._eval('_reportSavingsRate')(d)
  assert.equal(rate, analysisScreenRate(d))
  assert.equal(Math.round(rate * 100), 53)  // (9500 + 4000 - 3000) / 20000
})
