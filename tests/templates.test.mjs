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
