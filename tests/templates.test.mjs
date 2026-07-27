import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApp, deepEq } from './helpers.mjs'

// templates.js needs DB for template storage; back it with a live array.
function loadTemplates() {
  const store = { tpls: [] }
  const ctx = loadApp(['templates.js'], {
    DB: { get: (k, d) => (k === 'finImportTemplates' ? store.tpls : d), set: (k, v) => { if (k === 'finImportTemplates') store.tpls = v; return true } },
    genId: () => 'id' + Math.random().toString(36).slice(2),
  })
  ctx._store = store
  return ctx
}

test('parseDateValue: formats, 2-digit years, excel serial, ISO passthrough', () => {
  const t = loadTemplates()
  assert.equal(t.parseDateValue('15/06/2026', 'DD/MM/YYYY'), '2026-06-15')
  assert.equal(t.parseDateValue('06/15/2026', 'MM/DD/YYYY'), '2026-06-15')
  assert.equal(t.parseDateValue('15/06/26', 'DD/MM/YY'), '2026-06-15')
  assert.equal(t.parseDateValue('2026-06-15'), '2026-06-15')
  assert.equal(t.parseDateValue(45000), '2023-03-15')          // excel serial (1900 epoch)
  assert.equal(t.parseDateValue('13/45/2026', 'DD/MM/YYYY'), null)
  assert.equal(t.parseDateValue(''), null)
})

test('parseAmountValue: signs, currency, thousands, EU/US decimals, accounting negatives', () => {
  const t = loadTemplates()
  assert.equal(t.parseAmountValue('1,234.56'), 1234.56)
  assert.equal(t.parseAmountValue('1.234,56'), 1234.56)
  assert.equal(t.parseAmountValue('₪ 250'), 250)
  assert.equal(t.parseAmountValue('-80.5'), -80.5)
  assert.equal(t.parseAmountValue('(120)'), -120)
  assert.equal(t.parseAmountValue('1,193'), 1193)              // 3 digits after comma → thousands
  assert.equal(t.parseAmountValue('12,5'), 12.5)               // EU decimal comma
  assert.equal(t.parseAmountValue('abc'), null)
})

test('parseCSVText: quotes, embedded delimiters, CRLF', () => {
  const t = loadTemplates()
  const rows = t.parseCSVText('a,"b,c",d\r\n1,"say ""hi""",3\n', ',')
  deepEq(rows[0], ['a', 'b,c', 'd'])
  deepEq(rows[1], ['1', 'say "hi"', '3'])
})

test('detectDelimiter picks the dominant separator', () => {
  const t = loadTemplates()
  assert.equal(t.detectDelimiter('a;b;c\n1;2;3'), ';')
  assert.equal(t.detectDelimiter('a\tb\tc'), '\t')
  assert.equal(t.detectDelimiter('plain'), ',')
})

test('signature: strict differs from legacy; findTemplateForHeaderRow matches both eras', () => {
  const t = loadTemplates()
  const hdr = ['תאריך', 'שם בית העסק', 'סכום החיוב', 'Charge Date']
  const strict = t.computeHeaderSignature(hdr)
  const legacy = t.computeHeaderSignatureLegacy(hdr)
  assert.notEqual(strict, legacy)
  t._store.tpls = [{ id: 'L', signature: legacy }]
  assert.equal(t.findTemplateForHeaderRow(hdr).id, 'L')
  t._store.tpls = [{ id: 'S', signature: strict }]
  assert.equal(t.findTemplateForHeaderRow(hdr).id, 'S')
  t._store.tpls = []
  assert.equal(t.findTemplateForHeaderRow(hdr), null)
})

test('parseWithTemplate: signed amounts, skip reasons, chargeDate auto-detect, unmapped cells → _detectText', () => {
  const t = loadTemplates()
  const rows = [
    ['תאריך', 'ספק', 'סכום', 'תאריך חיוב', 'פירוט'],
    ['01/06/2026', 'שופרסל', '-120', '10/06/2026', 'תשלום 1 מתוך 3'],
    ['', '', '', '', ''],                       // empty row
    ['02/06/2026', '', '-50', '', ''],           // missing vendor
    ['bad', 'ספק', '-10', '', ''],               // bad date
    ['03/06/2026', 'מסעדה', '0', '', ''],        // zero amount
  ]
  const tpl = {
    name: 'x', headerRowIndex: 0, skipFooterRows: 0,
    columns: { date: { index: 0, format: 'DD/MM/YYYY' }, vendor: { index: 1 }, amount: { mode: 'signed', index: 2 } },
  }
  const { transactions, stats } = t.parseWithTemplate(rows, tpl)
  assert.equal(transactions.length, 1)
  const tx = transactions[0]
  assert.equal(tx.date, '2026-06-01')
  assert.equal(tx.amount, -120)
  assert.equal(tx.chargeDate, '2026-06-10')          // auto-detected column
  assert.equal(tx._detectText.includes('תשלום 1 מתוך 3'), true)
  assert.equal(stats.parsed, 1)
  assert.equal(stats.skipped, 4)
})

test('parseWithTemplate: debit/credit mode and flipSign', () => {
  const t = loadTemplates()
  const rows = [
    ['תאריך', 'ספק', 'חובה', 'זכות'],
    ['01/06/2026', 'חנות', '200', ''],
    ['02/06/2026', 'מעסיק', '', '5000'],
  ]
  const tpl = { name: 'x', headerRowIndex: 0, columns: { date: { index: 0 }, vendor: { index: 1 }, amount: { mode: 'debit_credit', debitIndex: 2, creditIndex: 3 } } }
  const { transactions } = t.parseWithTemplate(rows, tpl)
  assert.equal(transactions[0].amount, -200)
  assert.equal(transactions[1].amount, 5000)

  const rows2 = [['תאריך', 'ספק', 'סכום'], ['01/06/2026', 'חנות', '200']]
  const tpl2 = { name: 'y', headerRowIndex: 0, columns: { date: { index: 0 }, vendor: { index: 1 }, amount: { mode: 'signed', index: 2, flipSign: true } } }
  assert.equal(t.parseWithTemplate(rows2, tpl2).transactions[0].amount, -200)
})

test('parseWithTemplate: mid-sheet section header remaps columns', () => {
  const t = loadTemplates()
  const rows = [
    ['תאריך', 'ספק', 'סכום'],
    ['01/06/2026', 'חנות א', '-100'],
    ['תאריך', 'מטבע', 'ספק', 'סכום'],           // new section: vendor/amount shifted
    ['02/06/2026', 'USD', 'חנות ב', '-50'],
  ]
  const tpl = { name: 'x', headerRowIndex: 0, columns: { date: { index: 0 }, vendor: { index: 1 }, amount: { mode: 'signed', index: 2 } } }
  const { transactions } = t.parseWithTemplate(rows, tpl)
  assert.equal(transactions.length, 2)
  assert.equal(transactions[1].vendor, 'חנות ב')
  assert.equal(transactions[1].amount, -50)
})

test('guessHeaderRow finds first label-like row', () => {
  const t = loadTemplates()
  const rows = [
    ['דוח עסקאות'],
    [''],
    ['תאריך', 'ספק', 'סכום'],
    ['01/06/2026', 'חנות', '-100'],
  ]
  assert.equal(t.guessHeaderRow(rows), 2)
})

// ===== BACK-COMPAT WITH TEMPLATES SAVED BEFORE 1.40.0 =====
// Existing templates carry only { signature, columns, headerRowIndex,
// skipFooterRows, accountId } — no notion of row signatures, statement scope or
// account identifiers. They must keep parsing byte-identically, and gain the
// new provenance fields for free.

const LEGACY_TPL = {
  id: 'tpl_old', name: 'ויזה ישן',
  signature: null,          // filled in per test from the header row
  headerRowIndex: 1,
  skipFooterRows: 0,
  accountId: null,
  columns: {
    date:   { index: 0, format: 'DD/MM/YYYY' },
    vendor: { index: 1 },
    amount: { mode: 'signed', index: 2 },
  },
}

const LEGACY_ROWS = [
  ['פירוט עסקאות'],
  ['תאריך עסקה', 'שם בית עסק', 'סכום חיוב'],
  ['22/04/2026', 'איקאה', '-250'],
  ['28/05/2026', 'שופרסל', '-90'],
]

test('a template saved before 1.40.0 parses exactly as it used to', () => {
  const t = loadTemplates()
  const { transactions, stats } = t.parseWithTemplate(LEGACY_ROWS, LEGACY_TPL)
  assert.equal(stats.parsed, 2)
  assert.equal(stats.skipped, 0)
  deepEq(transactions.map(x => [x.date, x.vendor, x.amount, x.type]), [
    ['2026-04-22', 'איקאה', -250, 'expense'],
    ['2026-05-28', 'שופרסל', -90, 'expense'],
  ], 'legacy parse output unchanged')
})

test('legacy templates gain row provenance without being re-created', () => {
  const t = loadTemplates()
  const { transactions } = t.parseWithTemplate(LEGACY_ROWS, LEGACY_TPL)
  // txmRowSignature is absent in this context, so the signature is simply
  // omitted — the parser must not throw over an optional collaborator.
  assert.equal(transactions[0]._rowSig, undefined)
  // The absolute row index is always available and is what links a saved
  // transaction back to its line in the stored source document.
  deepEq(transactions.map(x => x._rowIndex), [2, 3], 'row indices are absolute')
})

test('row indices stay absolute when the header sits further down', () => {
  const t = loadTemplates()
  const rows = [['כרטיס 1234'], ['מועד חיוב 10/06/2026'], [], ...LEGACY_ROWS.slice(1)]
  const { transactions } = t.parseWithTemplate(rows, { ...LEGACY_TPL, headerRowIndex: 3 })
  deepEq(transactions.map(x => x._rowIndex), [4, 5])
})

test('an old template still auto-detects a charge-date column it never mapped', () => {
  const t = loadTemplates()
  const rows = [
    ['תאריך עסקה', 'שם בית עסק', 'סכום חיוב', 'תאריך חיוב'],
    ['22/04/2026', 'איקאה', '-250', '10/06/2026'],
  ]
  const { transactions } = t.parseWithTemplate(rows, { ...LEGACY_TPL, headerRowIndex: 0 })
  assert.equal(transactions[0].chargeDate, '2026-06-10',
    'the column is picked up from the header without re-creating the template')
})

test('a stale headerRowIndex is what shifts the data window', () => {
  const t = loadTemplates()
  // Same format, but the issuer added one preamble line this month. The saved
  // index (1) now points at the preamble instead of the header.
  const shifted = [['פירוט עסקאות'], ['מועד חיוב 10/06/2026'],
                   ['תאריך עסקה', 'שם בית עסק', 'סכום חיוב'],
                   ['22/04/2026', 'איקאה', '-250']]
  const stale = t.parseWithTemplate(shifted, { ...LEGACY_TPL, headerRowIndex: 1 })
  assert.equal(stale.stats.parsed, 1)
  assert.equal(stale.stats.skipped, 1, 'the header row is consumed as a data row and skipped')

  // Re-resolving the index against this file recovers the right window, which
  // is what the importer now does with the index it matched the signature at.
  const fixed = t.parseWithTemplate(shifted, { ...LEGACY_TPL, headerRowIndex: 2 })
  assert.equal(fixed.stats.parsed, 1)
  assert.equal(fixed.stats.skipped, 0)
})

test('templates are matched by header signature, in both signature eras', () => {
  const t = loadTemplates()
  const header = ['תאריך עסקה', 'שם בית עסק', 'סכום חיוב']
  t.upsertTemplate({ ...LEGACY_TPL, signature: t.computeHeaderSignature(header) })
  assert.equal(t.findTemplateForHeaderRow(header)?.id, 'tpl_old')

  // A template saved under the older, weaker normalization still matches.
  const t2 = loadTemplates()
  t2.upsertTemplate({ ...LEGACY_TPL, id: 'tpl_older', signature: t2.computeHeaderSignatureLegacy(header) })
  assert.equal(t2.findTemplateForHeaderRow(header)?.id, 'tpl_older')

  // A different layout must not match either.
  assert.equal(t.findTemplateForHeaderRow(['משהו', 'אחר', 'לגמרי']), null)
})

test('parseCSVText: a quote is a delimiter only at the start of a field', () => {
  const t = loadTemplates()
  // Properly quoted fields keep working.
  deepEq(t.parseCSVText('a,b\n1,"x, y"', ','), [['a','b'],['1','x, y']])
  deepEq(t.parseCSVText('a\n"say ""hi"""', ','), [['a'],['say "hi"']])
  // A mid-field quote is literal text. Hebrew exports are full of בע"מ, and
  // treating it as an opening quote swallowed the rest of the file.
  deepEq(t.parseCSVText('שם,סכום\nאלקטרה בע"מ,374.17\nפיוריטי,203.00', ','),
         [['שם','סכום'],['אלקטרה בע"מ','374.17'],['פיוריטי','203.00']])
  // Every row survives, which is the property that actually broke.
  assert.equal(t.parseCSVText('a,b\nח"ן,1\nמט"ח,2\nחו"ל,3', ',').length, 4)
})
