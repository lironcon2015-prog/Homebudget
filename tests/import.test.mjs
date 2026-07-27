import { test } from 'node:test'
import assert from 'node:assert'
import { loadApp, makeDbStub } from './helpers.mjs'

// Drives the real import pipeline (core + txmatch + source + detect + import)
// with the DOM stubbed out, so the reconciliation is exercised end to end.
function makeImport({ accounts = [], categories = [], transactions = [] } = {}) {
  const state = { accounts, categories, transactions }
  const db = makeDbStub()
  const els = new Map()
  const ctx = loadApp(['core.js', 'txmatch.js', 'detect.js', 'autocat.js', 'source.js', 'import.js'], {
    DB: {
      get: (k, d) => {
        if (k === 'finTransactions') return state.transactions
        if (k === 'finAccounts') return state.accounts
        if (k === 'finCategories') return state.categories
        return db.get(k, d)
      },
      set: (k, v) => {
        if (k === 'finTransactions') { state.transactions = v; return true }
        if (k === 'finAccounts') { state.accounts = v; return true }
        return db.set(k, v)
      },
      getObj: (k, d = {}) => db.get(k, d),
    },
    document: {
      addEventListener: () => {}, querySelectorAll: () => [],
      getElementById: id => {
        if (!els.has(id)) els.set(id, { style: {}, textContent: '', innerHTML: '', value: '', disabled: false })
        return els.get(id)
      },
    },
    getAccounts: () => state.accounts,
    getCategories: () => state.categories,
    getTransactions: () => state.transactions,
    genId: (() => { let n = 0; return () => 'gen' + (++n) })(),
    getApiKey: () => '',                 // keeps the AI rung out of these tests
    matchVendorToCategory: () => '',
    CC_KEYWORDS: ['ויזה', 'visa', 'כאל'],
    formatDate: s => s, formatCurrency: n => String(n), escHtml: s => String(s),
    catIconHTML: () => '', toast: () => {},
    indexedDB: undefined,
  })
  ctx._state = state
  return ctx
}

const CC   = { id: 'cc1', name: 'ויזה', type: 'credit_card', billingDay: 10 }
const BANK = { id: 'b1',  name: 'עו"ש', type: 'checking' }

// Run one import and report the state of every row.
function runImport(ctx, rows, accountId, scope = null) {
  ctx._reconcileParsed(JSON.parse(JSON.stringify(rows)), accountId, scope)
  return ctx._eval('_parsedTx')
}
function commit(ctx) { ctx.saveImport(); return ctx._state.transactions }
const tally = r => ({
  fresh:   r.filter(t => t._state === 'fresh').length,
  matched: r.filter(t => t._state === 'matched').length,
  review:  r.filter(t => t._state === 'review').length,
  keep:    r.filter(t => t._keep).length,
})

// ---------- the reported failure ----------

test('REGRESSION: monthly bills then a wide report offers nothing already stored', () => {
  const ctx = makeImport({ accounts: [CC, BANK] })
  const mayBill = [
    { date: '2026-04-22', amount: -250, vendor: 'איקאה',  description: 'תשלום 3 מתוך 10', type: 'expense' },
    { date: '2026-04-28', amount: -90,  vendor: 'שופרסל', description: '', type: 'expense' },
    { date: '2026-05-04', amount: -60,  vendor: 'ארומה',  description: '', type: 'expense' },
  ]
  const junBill = [
    { date: '2026-04-22', amount: -250, vendor: 'איקאה', description: 'תשלום 4 מתוך 10', type: 'expense' },
    { date: '2026-05-19', amount: -140, vendor: 'פז',    description: '', type: 'expense' },
    { date: '2026-06-02', amount: -75,  vendor: 'ארומה', description: '', type: 'expense' },
  ]
  runImport(ctx, mayBill, 'cc1', { month: '2026-05', source: 'charge-date' }); commit(ctx)
  runImport(ctx, junBill, 'cc1', { month: '2026-06', source: 'charge-date' }); commit(ctx)
  assert.equal(ctx._state.transactions.length, 6)

  // The wide report covering both cycles. No statement scope: it spans two.
  const wide = [...mayBill, ...junBill]
  const r = runImport(ctx, wide, 'cc1')
  assert.deepEqual(tally(r), { fresh: 0, matched: 6, review: 0, keep: 0 })

  // And saving it adds nothing.
  const before = ctx._state.transactions.length
  commit(ctx)
  assert.equal(ctx._state.transactions.length, before)
})

test('REGRESSION: purchase dates are never rewritten by the importer', () => {
  const ctx = makeImport({ accounts: [CC] })
  const bill = [
    { date: '2026-01-20', amount: -500, vendor: 'איקאה', description: 'תשלום 5 מתוך 12', type: 'expense' },
    { date: '2026-06-02', amount: -80,  vendor: 'ארומה', description: '', type: 'expense' },
  ]
  runImport(ctx, bill, 'cc1', { month: '2026-06', source: 'charge-date' })
  const saved = commit(ctx)
  const inst = saved.find(t => t.installmentCurrent)
  assert.equal(inst.date, '2026-01-20', 'the purchase date is preserved verbatim')
  assert.equal(inst.billingMonth, '2026-06', 'the cycle is a separate, explicit fact')
  assert.equal(inst.originalTransactionDate, undefined, 'nothing to restore — nothing was overwritten')
  // Final charge of the plan: cycle + (total - current) = 2026-06 + 7.
  assert.equal(inst.installmentFinalMonth, '2027-01')
})

test('REGRESSION: a multi-month export keeps each row in its own cycle', () => {
  const ctx = makeImport({ accounts: [CC] })
  // No statement scope — a wide export is not one bill, so each row falls back
  // to billing-day rollover on its own purchase date.
  const multi = [
    { date: '2026-01-20', amount: -500, vendor: 'איקאה', description: 'תשלום 1 מתוך 6', type: 'expense' },
    { date: '2026-03-12', amount: -90,  vendor: 'ארומה', description: '', type: 'expense' },
    { date: '2026-05-15', amount: -70,  vendor: 'פז',    description: '', type: 'expense' },
  ]
  runImport(ctx, multi, 'cc1')
  const saved = commit(ctx)
  // Each date rolls on its own: day 20, 12 and 15 all sit past billingDay 10.
  assert.deepEqual(saved.map(t => t.billingMonth), ['2026-02', '2026-04', '2026-06'])
  assert.deepEqual(saved.map(t => t.date), ['2026-01-20', '2026-03-12', '2026-05-15'])
})

test('REGRESSION: legacy rows without a billing month still match', () => {
  // Rows imported before billingMonth existed carry only date + hashes.
  const ctx = makeImport({
    accounts: [CC],
    transactions: [{ id: 'old1', accountId: 'cc1', date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' }],
  })
  const bill = [
    { date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' },
    { date: '2026-05-15', amount: -300, vendor: 'סונול',  description: '', type: 'expense' },
  ]
  const r = runImport(ctx, bill, 'cc1', { month: '2026-06', source: 'charge-date' })
  assert.deepEqual(tally(r), { fresh: 1, matched: 1, review: 0, keep: 1 })
  assert.equal(r.find(t => t._state === 'fresh').vendor, 'סונול')
})

test('REGRESSION: an edited transaction still matches its source row', () => {
  // Stored hashes used to be frozen at import; renaming a vendor afterwards made
  // the row invisible to every later import. Identity is derived now.
  const ctx = makeImport({
    accounts: [CC],
    transactions: [{ id: 'e1', accountId: 'cc1', date: '2026-05-03', amount: -120,
                     vendor: 'רמי לוי סניף מרכז', billingMonth: '2026-05', type: 'expense' }],
  })
  const r = runImport(ctx, [{ date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' }],
                      'cc1', { month: '2026-05', source: 'charge-date' })
  assert.equal(tally(r).matched, 1)
})

test('a manually entered transaction is matched by a later import', () => {
  // Manual rows never had hashes at all, so they could never dedup.
  const ctx = makeImport({
    accounts: [BANK],
    transactions: [{ id: 'm1', accountId: 'b1', date: '2026-05-03', amount: -120, vendor: 'רמי לוי', type: 'expense', createdAt: 1 }],
  })
  const r = runImport(ctx, [{ date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' }], 'b1')
  assert.equal(tally(r).matched, 1)
})

// ---------- cross-format ----------

test('the same bill from a second export format is recognised', () => {
  const ctx = makeImport({ accounts: [CC] })
  // Issuer export: purchase dates, installment markers, terse vendors.
  runImport(ctx, [
    { date: '2026-04-22', amount: -250, vendor: 'איקאה',  description: 'תשלום 3 מתוך 10', type: 'expense' },
    { date: '2026-05-28', amount: -90,  vendor: 'שופרסל', description: '', type: 'expense' },
  ], 'cc1', { month: '2026-06', source: 'charge-date', chargeDay: 10 })
  commit(ctx)

  // Bank export of the same bill: no installment column, the date column holds
  // the charge date, vendors spelled out in full.
  const r = runImport(ctx, [
    { date: '2026-06-10', amount: -250, vendor: 'איקאה ישראל בע"מ', description: '', type: 'expense' },
    { date: '2026-06-10', amount: -90,  vendor: 'שופרסל דיל',       description: '', type: 'expense' },
  ], 'cc1', { month: '2026-06', source: 'charge-date', chargeDay: 10 })
  assert.deepEqual(tally(r), { fresh: 0, matched: 2, review: 0, keep: 0 })
})

// ---------- it must not over-match ----------

test('genuinely new rows are still offered', () => {
  const ctx = makeImport({ accounts: [CC] })
  runImport(ctx, [{ date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' }],
            'cc1', { month: '2026-05', source: 'charge-date' })
  commit(ctx)
  const r = runImport(ctx, [
    { date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' },
    { date: '2026-05-04', amount: -55,  vendor: 'ארומה',  description: '', type: 'expense' },
  ], 'cc1', { month: '2026-05', source: 'charge-date' })
  assert.deepEqual(tally(r), { fresh: 1, matched: 1, review: 0, keep: 1 })
  const saved = commit(ctx)
  assert.equal(saved.length, 2)
})

test('the same file imported to a different account stays separate', () => {
  const ctx = makeImport({ accounts: [CC, BANK] })
  runImport(ctx, [{ date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' }], 'b1')
  commit(ctx)
  const r = runImport(ctx, [{ date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' }], 'cc1')
  assert.equal(tally(r).fresh, 1, 'accounts are reconciled independently')
})

// ---------- the safety net ----------

test('a stored row missing from the statement is surfaced, not hidden', () => {
  const ctx = makeImport({ accounts: [CC] })
  runImport(ctx, [
    { date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' },
    { date: '2026-05-04', amount: -300, vendor: 'סונול',  description: '', type: 'expense' },
  ], 'cc1', { month: '2026-05', source: 'charge-date' })
  commit(ctx)

  runImport(ctx, [{ date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '', type: 'expense' }],
            'cc1', { month: '2026-05', source: 'charge-date' })
  const orphans = ctx._eval('_importOrphans')
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].vendor, 'סונול')
})

// ---------- provenance ----------

test('saved rows record which document and line they came from', () => {
  const ctx = makeImport({ accounts: [CC] })
  ctx._eval('_importDoc = { contentHash: "abc123", filename: "june.xlsx" }')
  runImport(ctx, [{ date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '',
                    type: 'expense', _rowSig: 'sig1', _rowIndex: 7 }],
            'cc1', { month: '2026-06', source: 'charge-date' })
  const saved = commit(ctx)
  assert.equal(saved[0].srcRowHash, 'sig1')
  assert.equal(saved[0].srcRow, 7)
  assert.ok(saved[0].srcDoc, 'every imported row points at its source document')
  // And the document itself is logged, so the file is recognised next time.
  const doc = ctx.findSourceDocByHash('abc123')
  assert.equal(doc.txCount, 1)
  assert.equal(doc.accountId, 'cc1')
  assert.deepEqual(doc.billingMonths, ['2026-06'])
})

test('identical raw rows are matched by signature even when text drifts', () => {
  const ctx = makeImport({ accounts: [CC] })
  ctx._eval('_importDoc = { contentHash: "h1", filename: "a.xlsx" }')
  runImport(ctx, [{ date: '2026-05-03', amount: -120, vendor: 'רמי לוי', description: '',
                    type: 'expense', _rowSig: 'sigX' }], 'cc1', { month: '2026-06', source: 'charge-date' })
  commit(ctx)
  // Re-parsed with a different vendor rendering, same underlying row.
  const r = runImport(ctx, [{ date: '2026-05-03', amount: -120, vendor: 'ר. לוי בע"מ', description: '',
                              type: 'expense', _rowSig: 'sigX' }], 'cc1', { month: '2026-06', source: 'charge-date' })
  assert.equal(tally(r).matched, 1)
})

// ---------- billing cycle resolution ----------

test('cycle precedence: charge-date column, then statement scope, then rollover', () => {
  const ctx = makeImport({ accounts: [CC] })
  const rows = runImport(ctx, [
    { date: '2026-05-03', amount: -10, vendor: 'א', chargeDate: '2026-07-10', type: 'expense' },
    { date: '2026-05-03', amount: -20, vendor: 'ב', type: 'expense' },
  ], 'cc1', { month: '2026-06', source: 'charge-date' })
  assert.equal(rows[0]._billingMonth, '2026-07', 'the issuer column wins')
  assert.equal(rows[0]._billingProvenance, 'explicit')
  assert.equal(rows[1]._billingMonth, '2026-06', 'the statement period comes next')

  const noScope = runImport(ctx, [{ date: '2026-05-15', amount: -30, vendor: 'ג', type: 'expense' }], 'cc1')
  assert.equal(noScope[0]._billingMonth, '2026-06', 'day 15 >= billingDay 10 rolls to the next cycle')
  assert.equal(noScope[0]._billingProvenance, 'derived')
})

test('non-credit accounts bucket by calendar month and ignore cycle fields', () => {
  const ctx = makeImport({ accounts: [BANK] })
  const rows = runImport(ctx, [{ date: '2026-05-15', amount: -30, vendor: 'א', chargeDate: '2026-07-10', type: 'expense' }],
                         'b1', { month: '2026-06', source: 'charge-date' })
  assert.equal(rows[0]._billingMonth, '2026-05')
})
