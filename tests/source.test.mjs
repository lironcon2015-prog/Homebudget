import { test } from 'node:test'
import assert from 'node:assert'
import { loadApp, makeDbStub } from './helpers.mjs'

function load(accounts = []) {
  const db = makeDbStub({ finAccounts: accounts })
  return loadApp(['source.js'], {
    DB: db,
    getAccounts: () => db.get('finAccounts', []),
    genId: () => 'id' + Math.random().toString(36).slice(2),
    indexedDB: undefined,
  })
}

// ---------- statement scope ----------

test('an explicit charge date in the preamble sets the cycle', () => {
  const { detectStatementScope } = load()
  assert.deepEqual(detectStatementScope('פירוט עסקאות | מועד חיוב 10/06/2026'),
                   { month: '2026-06', source: 'charge-date', chargeDay: 10 })
  assert.equal(detectStatementScope('חיוב לתאריך 02.07.2026').month, '2026-07')
  assert.equal(detectStatementScope('לחיוב ב-10/06/26').month, '2026-06')
})

test('a Hebrew or numeric month name sets the cycle', () => {
  const { detectStatementScope } = load()
  assert.deepEqual(detectStatementScope('עסקאות לחודש יוני 2026'),
                   { month: '2026-06', source: 'month-name' })
  assert.equal(detectStatementScope('פירוט לחודש 06/2026').month, '2026-06')
  assert.equal(detectStatementScope('לחודש דצמבר 2025').month, '2025-12')
})

test('a period range resolves to the month it ends in', () => {
  const { detectStatementScope } = load()
  assert.deepEqual(detectStatementScope('לתקופה 11/05/2026 עד 10/06/2026'),
                   { month: '2026-06', source: 'period-range' })
})

test('an explicit charge date wins over a month name in the same text', () => {
  const { detectStatementScope } = load()
  const r = detectStatementScope('עסקאות לחודש מאי 2026 · מועד חיוב 10/06/2026')
  assert.equal(r.source, 'charge-date')
  assert.equal(r.month, '2026-06')
})

test('text with no period information yields nothing, rather than a guess', () => {
  const { detectStatementScope } = load()
  assert.equal(detectStatementScope('רשימת עסקאות'), null)
  assert.equal(detectStatementScope(''), null)
})

test('the preamble is only what sits above the table header', () => {
  const { statementPreamble } = load()
  const rows = [
    ['כרטיס אשראי 1234'], ['מועד חיוב 10/06/2026'], [],
    ['תאריך', 'שם בית עסק', 'סכום'],
    ['03/05/2026', 'רמי לוי', '-120'],
  ]
  const p = statementPreamble(rows, 3)
  assert.ok(p.includes('1234') && p.includes('10/06/2026'))
  assert.ok(!p.includes('רמי לוי'), 'data rows must not leak into the preamble')
})

// ---------- account identification ----------

test('card identifiers are read only alongside a keyword or a mask', () => {
  const { extractAccountIdentifiers } = load()
  const vals = t => extractAccountIdentifiers(t).map(f => f.value)
  assert.deepEqual(vals('כרטיס 1234'), ['1234'])
  assert.deepEqual(vals('****1234'), ['1234'])
  assert.deepEqual(vals('XXXX-XXXX-XXXX-5678'), ['5678'])
  assert.deepEqual(vals('כרטיס מסתיים ב-4321'), ['4321'])
  // A bare number with no keyword is far too common to trust.
  assert.deepEqual(vals('סכום 1234 שח'), [])
  assert.deepEqual(vals('03/05/2026'), [])
})

test('bank account numbers are read in both punctuated and plain form', () => {
  const { extractAccountIdentifiers, normalizeAccountIdentifier } = load()
  const vals = t => extractAccountIdentifiers(t).map(f => f.value)
  assert.deepEqual(vals('מספר חשבון 12-345-678'), ['12345678'])
  assert.deepEqual(vals('חשבון 123456'), ['123456'])
  assert.equal(normalizeAccountIdentifier('12-345-678'), '12345678')
  assert.equal(normalizeAccountIdentifier('12'), '', 'too short to identify anything')
})

test('an account is identified from the statement preamble', () => {
  const accounts = [
    { id: 'cc1', name: 'ויזה', type: 'credit_card', identifiers: ['1234'] },
    { id: 'cc2', name: 'מאסטרקארד', type: 'credit_card', identifiers: ['5678'] },
  ]
  const { identifyAccountForFile } = load(accounts)
  const r = identifyAccountForFile({ preamble: 'כרטיס 5678 | מועד חיוב 10/06/2026', filename: 'x.xlsx', accounts })
  assert.equal(r.accountId, 'cc2')
  assert.equal(r.via, 'statement')
})

test('a full card number in the file matches an account stored by last-4', () => {
  const accounts = [{ id: 'cc1', name: 'ויזה', type: 'credit_card', identifiers: ['1234'] }]
  const { identifyAccountForFile } = load(accounts)
  const r = identifyAccountForFile({ preamble: 'כרטיס 4580123412341234', filename: '', accounts })
  assert.equal(r?.accountId, 'cc1')
})

test('the filename is used when the statement itself says nothing', () => {
  const accounts = [{ id: 'cc1', name: 'ויזה', type: 'credit_card', identifiers: ['1234'] }]
  const { identifyAccountForFile } = load(accounts)
  const r = identifyAccountForFile({ preamble: 'פירוט עסקאות', filename: 'export-כרטיס 1234-06-2026.xlsx', accounts })
  assert.equal(r.accountId, 'cc1')
  assert.equal(r.via, 'filename')
})

test('a template bound to an account is the last deterministic resort', () => {
  const accounts = [{ id: 'cc1', name: 'ויזה', type: 'credit_card' }]
  const { identifyAccountForFile } = load(accounts)
  const r = identifyAccountForFile({ preamble: '', filename: 'x.xlsx', template: { accountId: 'cc1' }, accounts })
  assert.equal(r.via, 'template')
  assert.equal(r.confidence, 'medium')
})

test('two accounts claiming the same identifier resolve to nothing', () => {
  const accounts = [
    { id: 'cc1', name: 'ויזה', type: 'credit_card', identifiers: ['1234'] },
    { id: 'cc2', name: 'ויזה 2', type: 'credit_card', identifiers: ['1234'] },
  ]
  const { identifyAccountForFile } = load(accounts)
  assert.equal(identifyAccountForFile({ preamble: 'כרטיס 1234', filename: '', accounts }), null)
})

test('an unknown card yields nothing, leaving the AI step to run', () => {
  const accounts = [{ id: 'cc1', name: 'ויזה', type: 'credit_card', identifiers: ['1234'] }]
  const { identifyAccountForFile } = load(accounts)
  assert.equal(identifyAccountForFile({ preamble: 'כרטיס 9999', filename: '', accounts }), null)
})

test('a confirmed identifier is learned onto the account', () => {
  const accounts = [{ id: 'cc1', name: 'ויזה', type: 'credit_card' }]
  const ctx = load(accounts)
  assert.equal(ctx.learnAccountIdentifier('cc1', '9999'), true)
  assert.deepEqual(ctx.DB.get('finAccounts')[0].identifiers, ['9999'])
  // Idempotent.
  assert.equal(ctx.learnAccountIdentifier('cc1', '9999'), false)
  // And now it identifies the file on its own.
  const accs = ctx.DB.get('finAccounts')
  assert.equal(ctx.identifyAccountForFile({ preamble: 'כרטיס 9999', filename: '', accounts: accs }).accountId, 'cc1')
})

// ---------- document log ----------

test('the same file is recognised on a second upload', () => {
  const ctx = load()
  ctx.recordSourceDoc({ contentHash: 'abc123', filename: 'may.xlsx', accountId: 'cc1', txCount: 47 })
  const hit = ctx.findSourceDocByHash('abc123')
  assert.equal(hit.filename, 'may.xlsx')
  assert.equal(hit.txCount, 47)
  assert.equal(ctx.findSourceDocByHash('nope'), null)
  assert.equal(ctx.findSourceDocByHash(''), null)
})

test('re-recording the same file updates in place, keeping one entry', () => {
  const ctx = load()
  const first = ctx.recordSourceDoc({ contentHash: 'abc', filename: 'a.xlsx', txCount: 1 })
  ctx.recordSourceDoc({ contentHash: 'abc', filename: 'a.xlsx', txCount: 5 })
  const docs = ctx.getSourceDocs()
  assert.equal(docs.length, 1)
  assert.equal(docs[0].txCount, 5)
  assert.equal(docs[0].id, first.id, 'the document keeps its identity across re-imports')
})

test('the document log stays bounded', () => {
  const ctx = load()
  const max = ctx._eval('SRC_MAX_DOCS')
  for (let i = 0; i < max + 25; i++) {
    ctx.recordSourceDoc({ contentHash: 'h' + i, filename: `f${i}.xlsx`, importedAt: 1000 + i })
  }
  const docs = ctx.getSourceDocs()
  assert.equal(docs.length, max)
  assert.equal(docs[docs.length - 1].contentHash, 'h' + (max + 24), 'newest survives')
  assert.equal(ctx.findSourceDocByHash('h0'), null, 'oldest evicted')
})

test('more statement-period phrasings are recognised', () => {
  const { detectStatementScope } = load()
  const m = t => detectStatementScope(t)?.month
  assert.equal(m('לחיוב בתאריך 10/08/2026'), '2026-08')
  assert.equal(m('תאריך החיוב 10/08/2026'), '2026-08')
  assert.equal(m('סה"כ לחיוב 02/08/2026'), '2026-08')
  assert.equal(m('Billing date 10/08/2026'), '2026-08')
  assert.equal(m('חיוב 08/2026'), '2026-08')
  assert.equal(m('תקופה 08.2026'), '2026-08')
  // Weakest rung: a bare month named in the title lines.
  const bare = detectStatementScope('פירוט עסקאות אוגוסט 2026')
  assert.equal(bare.month, '2026-08')
  assert.equal(bare.source, 'bare-month-name')
})

test('a stated charge date still outranks a bare month name', () => {
  const { detectStatementScope } = load()
  const r = detectStatementScope('עסקאות אוגוסט 2026 · מועד חיוב 10/09/2026')
  assert.equal(r.source, 'charge-date')
  assert.equal(r.month, '2026-09')
})

test('statement chrome covers the whole file, not just the preamble', () => {
  const { statementChromeText, detectStatementScope } = load()
  // A multi-section statement: the billing period is stated between sections,
  // far below the first header row.
  const rows = [
    ['פירוט עסקאות כרטיס 1234'],                      // 0 preamble
    ['תאריך עסקה', 'שם בית עסק', 'סכום'],             // 1 header
    ['22/04/2026', 'איקאה', '-250'],                  // 2 data
    [],                                                // 3
    ['עסקאות תשלומים · מועד חיוב 10/08/2026'],        // 4 section header
    ['תאריך עסקה', 'שם בית עסק', 'סכום'],             // 5 header
    ['30/11/2025', 'אלקטרה', '-374.17'],              // 6 data
  ]
  const chrome = statementChromeText(rows, new Set([2, 6]))
  assert.ok(chrome.includes('10/08/2026'), 'the section header is scanned')
  assert.ok(!chrome.includes('איקאה'), 'transaction rows are excluded')
  assert.equal(detectStatementScope(chrome)?.month, '2026-08')
})

test('chrome text never lets a data row masquerade as the period', () => {
  const { statementChromeText, detectStatementScope } = load()
  const rows = [
    ['פירוט עסקאות'],
    ['תאריך', 'ספק', 'סכום'],
    ['מועד חיוב 10/01/2020', 'ספק מפוקפק', '-1'],   // a data row that looks like a header
  ]
  // Marked as parsed → excluded, so it cannot set the statement period.
  assert.equal(detectStatementScope(statementChromeText(rows, new Set([2]))), null)
})

test('a bare charge date is found by its position in time', () => {
  const { detectScopeFromLooseDates } = load()
  // MAX prints the charge date alone in a cell, with no keyword beside it.
  const chrome = 'כרטיס: MAX מאסטרקארד - 7519 | 10/08/2026 | 10/08/2026'
  const r = detectScopeFromLooseDates(chrome, '2026-07-24')
  assert.equal(r.month, '2026-08')
  assert.equal(r.chargeDay, 10)
  assert.equal(r.chargeDate, '2026-08-10')
})

test('a loose date earlier than the purchases is not a charge date', () => {
  const { detectScopeFromLooseDates } = load()
  assert.equal(detectScopeFromLooseDates('הופק בתאריך 01/01/2026', '2026-07-24'), null)
})

test('the earliest qualifying date wins, so a later notice cannot displace it', () => {
  const { detectScopeFromLooseDates } = load()
  const r = detectScopeFromLooseDates('10/08/2026 | החיוב הבא 10/09/2026', '2026-07-24')
  assert.equal(r.chargeDate, '2026-08-10')
})

test('a date far past the purchases is out of range', () => {
  const { detectScopeFromLooseDates } = load()
  assert.equal(detectScopeFromLooseDates('01/01/2030', '2026-07-24'), null)
  assert.equal(detectScopeFromLooseDates('10/08/2026', ''), null)
})
