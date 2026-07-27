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
    { date: '2026-01-22', amount: -250, vendor: 'איקאה',  description: 'תשלום 4 מתוך 10', type: 'expense' },
    { date: '2026-04-28', amount: -90,  vendor: 'שופרסל', description: '', type: 'expense' },
    { date: '2026-05-04', amount: -60,  vendor: 'ארומה',  description: '', type: 'expense' },
  ]
  const junBill = [
    { date: '2026-01-22', amount: -250, vendor: 'איקאה', description: 'תשלום 5 מתוך 10', type: 'expense' },
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

// ---------- the bank's rendering of a card bill ----------
// Reported failure: a card report pulled from the BANK's site re-offered
// transactions already imported from the issuer's own export.

test('REGRESSION: a bank-rendered card bill matches the issuer export', () => {
  const ctx = makeImport({ accounts: [CC] })
  // Issuer export: real purchase dates, installment markers, terse vendors,
  // and a preamble that states the charge date.
  runImport(ctx, [
    { date: '2026-04-22', amount: -250, vendor: 'איקאה',  description: 'תשלום 3 מתוך 10', type: 'expense' },
    { date: '2026-05-19', amount: -140, vendor: 'פז',     description: '', type: 'expense' },
    { date: '2026-05-28', amount: -90,  vendor: 'שופרסל', description: '', type: 'expense' },
    { date: '2026-06-02', amount: -75,  vendor: 'ארומה',  description: '', type: 'expense' },
    { date: '2026-06-04', amount: -32,  vendor: 'רמי לוי', description: '', type: 'expense' },
  ], 'cc1', { month: '2026-06', source: 'charge-date', chargeDay: 10 })
  commit(ctx)

  // The bank's rendering of the SAME bill: every row carries the charge date
  // instead of the purchase date, no installment column, no parsable preamble.
  const bank = [
    { date: '2026-06-10', amount: -250, vendor: 'איקאה ישראל', type: 'expense' },
    { date: '2026-06-10', amount: -140, vendor: 'פז חברת נפט', type: 'expense' },
    { date: '2026-06-10', amount: -90,  vendor: 'שופרסל דיל',  type: 'expense' },
    { date: '2026-06-10', amount: -75,  vendor: 'ארומה אספרסו', type: 'expense' },
    { date: '2026-06-10', amount: -32,  vendor: 'רמי לוי שיווק', type: 'expense' },
  ]
  const r = runImport(ctx, bank, 'cc1', null)
  assert.deepEqual(tally(r), { fresh: 0, matched: 5, review: 0, keep: 0 },
    JSON.stringify(r.map(t => [t.vendor, t._state, t._billingMonth])))
})

test('a repeated date across most rows is read as the bill cycle', () => {
  const ctx = makeImport({ accounts: [CC] })
  const rows = runImport(ctx, [
    { date: '2026-06-10', amount: -250, vendor: 'א', type: 'expense' },
    { date: '2026-06-10', amount: -140, vendor: 'ב', type: 'expense' },
    { date: '2026-06-10', amount: -90,  vendor: 'ג', type: 'expense' },
    { date: '2026-06-10', amount: -75,  vendor: 'ד', type: 'expense' },
    { date: '2026-06-10', amount: -32,  vendor: 'ה', type: 'expense' },
  ], 'cc1', null)
  // Rollover would have pushed day 10 into July; the charge date says June.
  assert.ok(rows.every(t => t._billingMonth === '2026-06'),
    JSON.stringify(rows.map(t => t._billingMonth)))
})

test('genuine purchase dates are not mistaken for a charge date', () => {
  const ctx = makeImport({ accounts: [CC] })
  const rows = runImport(ctx, [
    { date: '2026-05-12', amount: -10, vendor: 'א', type: 'expense' },
    { date: '2026-05-14', amount: -20, vendor: 'ב', type: 'expense' },
    { date: '2026-05-19', amount: -30, vendor: 'ג', type: 'expense' },
    { date: '2026-05-22', amount: -40, vendor: 'ד', type: 'expense' },
    { date: '2026-06-01', amount: -50, vendor: 'ה', type: 'expense' },
  ], 'cc1', null)
  // Spread dates → per-row rollover, and the purchase date stays a real signal.
  assert.ok(rows.every(t => t._purchaseDate), 'purchase dates preserved')
  assert.deepEqual(rows.map(t => t._billingMonth),
    ['2026-06', '2026-06', '2026-06', '2026-06', '2026-06'])
})

test('a busy shopping day is not mistaken for a charge date', () => {
  const ctx = makeImport({ accounts: [CC] })
  // Three of five rows share a date, but later purchases follow it — so it
  // bills nothing and must keep counting as a real purchase date.
  const rows = runImport(ctx, [
    { date: '2026-05-14', amount: -10, vendor: 'א', type: 'expense' },
    { date: '2026-05-14', amount: -20, vendor: 'ב', type: 'expense' },
    { date: '2026-05-14', amount: -30, vendor: 'ג', type: 'expense' },
    { date: '2026-05-20', amount: -40, vendor: 'ד', type: 'expense' },
    { date: '2026-05-22', amount: -50, vendor: 'ה', type: 'expense' },
  ], 'cc1', null)
  assert.ok(rows.every(t => t._purchaseDate), 'purchase dates kept')
  assert.equal(rows[0]._billingProvenance, 'derived', 'no cycle was invented')
})

test('an explicit statement period always outranks an inferred one', () => {
  const ctx = makeImport({ accounts: [CC] })
  const rows = runImport(ctx, [
    { date: '2026-06-10', amount: -10, vendor: 'א', type: 'expense' },
    { date: '2026-06-10', amount: -20, vendor: 'ב', type: 'expense' },
    { date: '2026-06-10', amount: -30, vendor: 'ג', type: 'expense' },
    { date: '2026-06-10', amount: -40, vendor: 'ד', type: 'expense' },
  ], 'cc1', { month: '2026-07', source: 'charge-date', chargeDay: 10 })
  assert.ok(rows.every(t => t._billingMonth === '2026-07'), JSON.stringify(rows.map(t => t._billingMonth)))
})

// ---------- installments across consecutive bills ----------
// Reported: this month's bill marked its instalment rows as already existing.
// An instalment plan emits charges identical in purchase date, amount and
// vendor; only the cycle separates them.

test('REGRESSION: the next instalment of a stored plan is new, not existing', () => {
  const ctx = makeImport({ accounts: [CC] })
  // July bill: instalment 8 of a plan bought 30/11/2025.
  runImport(ctx, [
    { date: '2025-11-30', amount: -500, vendor: 'איקאה', description: 'תשלום 8 מתוך 12', type: 'expense' },
    { date: '2026-06-20', amount: -60,  vendor: 'ארומה', description: '', type: 'expense' },
  ], 'cc1', { month: '2026-07', source: 'charge-date', chargeDay: 10 })
  commit(ctx)

  // August bill: instalment 9. Same purchase date, same amount, same vendor.
  const r = runImport(ctx, [
    { date: '2025-11-30', amount: -500, vendor: 'איקאה', description: 'תשלום 9 מתוך 12', type: 'expense' },
    { date: '2026-07-20', amount: -70,  vendor: 'ארומה', description: '', type: 'expense' },
  ], 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  assert.deepEqual(tally(r), { fresh: 2, matched: 0, review: 0, keep: 2 },
    JSON.stringify(r.map(t => [t.vendor, t._state])))
})

test('REGRESSION: it holds even when the index is printed on only one side', () => {
  const ctx = makeImport({
    accounts: [CC],
    // A stored row with no index at all — an older import, or a format that
    // never printed one.
    transactions: [{ id: 'old', accountId: 'cc1', date: '2025-11-30', amount: -500,
                     vendor: 'איקאה', billingMonth: '2026-07', type: 'expense' }],
  })
  const r = runImport(ctx, [
    { date: '2025-11-30', amount: -500, vendor: 'איקאה', description: 'תשלום 9 מתוך 12', type: 'expense' },
  ], 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  assert.equal(tally(r).fresh, 1, JSON.stringify(r.map(t => [t.vendor, t._state])))
})

test('the same bill re-imported still matches its own instalment', () => {
  // The stricter rule must not break the case it shares a shape with.
  const ctx = makeImport({ accounts: [CC] })
  const bill = [{ date: '2025-11-30', amount: -500, vendor: 'איקאה', description: 'תשלום 9 מתוך 12', type: 'expense' }]
  runImport(ctx, bill, 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  commit(ctx)
  const r = runImport(ctx, bill, 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  assert.deepEqual(tally(r), { fresh: 0, matched: 1, review: 0, keep: 0 })
})

test('an instalment is charged on the purchase day, mapped into its cycle', () => {
  const ctx = makeImport({ accounts: [CC] })
  // Both examples from the report, on the August bill of a card billing on 10.
  runImport(ctx, [
    { date: '2025-11-30', amount: -500, vendor: 'איקאה', description: 'תשלום 9 מתוך 12', type: 'expense' },
    { date: '2026-06-02', amount: -300, vendor: 'קרביץ', description: 'תשלום 3 מתוך 6', type: 'expense' },
  ], 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  const saved = commit(ctx)
  // Purchase on the 30th → charged 30/07 (the cycle runs 11/07–10/08).
  assert.equal(saved[0].date, '2025-11-30', 'purchase date untouched')
  assert.equal(saved[0].chargeDate, '2026-07-30')
  assert.equal(saved[0].billingMonth, '2026-08')
  // Purchase on the 2nd → charged 02/08.
  assert.equal(saved[1].date, '2026-06-02')
  assert.equal(saved[1].chargeDate, '2026-08-02')
  assert.equal(saved[1].billingMonth, '2026-08')
})

test('an ordinary purchase gets no derived charge date', () => {
  const ctx = makeImport({ accounts: [CC] })
  runImport(ctx, [{ date: '2026-07-20', amount: -60, vendor: 'ארומה', type: 'expense' }],
            'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  assert.equal(commit(ctx)[0].chargeDate, undefined)
})

test('a charge date printed by the issuer is never overwritten', () => {
  const ctx = makeImport({ accounts: [CC] })
  runImport(ctx, [{ date: '2025-11-30', amount: -500, vendor: 'איקאה',
                    description: 'תשלום 9 מתוך 12', chargeDate: '2026-07-28', type: 'expense' }], 'cc1', null)
  assert.equal(commit(ctx)[0].chargeDate, '2026-07-28')
})

test('in a wide export each instalment lands in its own cycle', () => {
  const ctx = makeImport({ accounts: [CC] })
  // No statement scope. Deriving from the purchase date alone would pile all
  // three into one cycle; the index is what separates them.
  const rows = runImport(ctx, [
    { date: '2026-01-22', amount: -250, vendor: 'איקאה', description: 'תשלום 4 מתוך 10', type: 'expense' },
    { date: '2026-01-22', amount: -250, vendor: 'איקאה', description: 'תשלום 5 מתוך 10', type: 'expense' },
    { date: '2026-01-22', amount: -250, vendor: 'איקאה', description: 'תשלום 6 מתוך 10', type: 'expense' },
  ], 'cc1', null)
  assert.deepEqual(rows.map(t => t._billingMonth), ['2026-05', '2026-06', '2026-07'])
})

// ---------- the statement month is the default ----------
// Every line on a monthly bill belongs to that bill's cycle. The one exception
// is an immediate charge (foreign currency / overseas), billed when it happened.

test('every row on a stated bill defaults to the bill month', () => {
  const ctx = makeImport({ accounts: [CC] })
  // Purchase dates scattered across the cycle AND outside it — billing-day
  // rollover would have split these across three different months.
  const rows = runImport(ctx, [
    { date: '2026-07-03', amount: -10, vendor: 'א', type: 'expense' },
    { date: '2026-07-15', amount: -20, vendor: 'ב', type: 'expense' },
    { date: '2026-07-28', amount: -30, vendor: 'ג', type: 'expense' },
    { date: '2026-08-05', amount: -40, vendor: 'ד', type: 'expense' },
    { date: '2025-11-30', amount: -50, vendor: 'ה', description: 'תשלום 9 מתוך 12', type: 'expense' },
  ], 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  assert.ok(rows.every(t => t._billingMonth === '2026-08'),
    JSON.stringify(rows.map(t => [t.vendor, t._billingMonth])))
})

test('an immediate charge is billed in the month it happened', () => {
  const ctx = makeImport({ accounts: [CC] })
  const rows = runImport(ctx, [
    { date: '2026-07-03', amount: -10, vendor: 'רמי לוי', type: 'expense' },
    { date: '2026-07-03', amount: -20, vendor: 'AMAZON', description: 'עסקת חו"ל', type: 'expense' },
    { date: '2026-06-28', amount: -30, vendor: 'BOOKING', description: 'חיוב מיידי', type: 'expense' },
  ], 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  assert.equal(rows[0]._billingMonth, '2026-08', 'ordinary row takes the bill month')
  assert.equal(rows[1]._billingMonth, '2026-07', 'FX row takes its own month')
  assert.equal(rows[1]._billingProvenance, 'immediate')
  assert.equal(rows[2]._billingMonth, '2026-06')
})

test('an immediate charge is flagged on the saved transaction', () => {
  const ctx = makeImport({ accounts: [CC] })
  runImport(ctx, [{ date: '2026-07-03', amount: -20, vendor: 'AMAZON', description: 'מט"ח', type: 'expense' }],
            'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  const saved = commit(ctx)
  assert.equal(saved[0].immediateCharge, true)
  assert.equal(saved[0].billingMonth, '2026-07')
})

test("an issuer's own charge-date column still outranks the bill month", () => {
  const ctx = makeImport({ accounts: [CC] })
  const rows = runImport(ctx, [{ date: '2026-07-03', amount: -10, vendor: 'א', chargeDate: '2026-09-10', type: 'expense' }],
                         'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  assert.equal(rows[0]._billingMonth, '2026-09')
})

test('with no stated period, per-row derivation still applies', () => {
  const ctx = makeImport({ accounts: [CC] })
  const rows = runImport(ctx, [
    { date: '2026-07-03', amount: -10, vendor: 'א', type: 'expense' },
    { date: '2026-07-28', amount: -20, vendor: 'ב', type: 'expense' },
  ], 'cc1', null)
  // Day 3 < billingDay 10 stays in July; day 28 rolls to August.
  assert.deepEqual(rows.map(t => t._billingMonth), ['2026-07', '2026-08'])
})

test('REGRESSION: a per-cycle instalment charge date names the right bill', () => {
  // Reports that carry a charge-date column print the bill date on ordinary
  // rows and the per-cycle date on instalments. The latter sits INSIDE the
  // cycle, so its calendar month is a month early.
  const ctx = makeImport({ accounts: [CC] })
  const rows = runImport(ctx, [
    { date: '2026-07-15', amount: -100, vendor: 'רמי לוי', chargeDate: '2026-08-10', type: 'expense' },
    { date: '2025-11-30', amount: -500, vendor: 'איקאה',  chargeDate: '2026-07-30', description: 'תשלום 9 מתוך 12', type: 'expense' },
    { date: '2026-06-02', amount: -300, vendor: 'קרביץ',  chargeDate: '2026-08-02', description: 'תשלום 3 מתוך 6',  type: 'expense' },
  ], 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  assert.ok(rows.every(t => t._billingMonth === '2026-08'),
    JSON.stringify(rows.map(t => [t.vendor, t.chargeDate, t._billingMonth])))
})

test('a charge date past the billing day belongs to the next cycle', () => {
  const ctx = makeImport({ accounts: [CC] })
  const rows = runImport(ctx, [
    { date: '2026-08-01', amount: -100, vendor: 'א', chargeDate: '2026-08-11', type: 'expense' },
  ], 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  assert.equal(rows[0]._billingMonth, '2026-09')
})

test('the derived instalment charge date round-trips to its own cycle', () => {
  // The date we derive must name the bill it was derived from — otherwise a
  // re-read of the saved row would move it a month.
  const ctx = makeImport({ accounts: [CC] })
  runImport(ctx, [
    { date: '2025-11-30', amount: -500, vendor: 'איקאה', description: 'תשלום 9 מתוך 12', type: 'expense' },
    { date: '2026-06-02', amount: -300, vendor: 'קרביץ', description: 'תשלום 3 מתוך 6', type: 'expense' },
  ], 'cc1', { month: '2026-08', source: 'charge-date', chargeDay: 10 })
  const saved = commit(ctx)
  for (const t of saved) {
    assert.equal(ctx.billingMonthForChargeDate(t.chargeDate, 10), '2026-08',
      `${t.vendor} chargeDate=${t.chargeDate}`)
    assert.equal(ctx.getTxEffectiveMonth(t), '2026-08')
  }
})
