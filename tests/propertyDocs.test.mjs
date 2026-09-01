import { test } from 'node:test'
import assert from 'node:assert'
import { loadApp, makeDbStub } from './helpers.mjs'

// Doc → payment linking is a scoring decision with a hard gate at 80%, so the
// interesting cases are the ones that must NOT auto-link.
function load(payments = []) {
  const db = makeDbStub({ finPropertyPayments: payments })
  return loadApp(['propertyDocs.js'], {
    DB: db,
    getPropertyPayments: () => db.get('finPropertyPayments', []),
    genId: () => 'id' + Math.random().toString(36).slice(2),
    indexedDB: undefined,
    window: { addEventListener: () => {} },
  })
}

// Top-level `const` lives in the vm's lexical scope, not on the context object.
const gate = ctx => ctx._eval('PD_LINK_MIN_CONFIDENCE')

const pay = (o) => ({ id: 'p', type: 'payment', paymentNumber: null, amount: 0, paidAmount: 0, dueDate: '', paidDate: '', ...o })
const doc = (o) => ({ docType: 'receipt', amount: 0, docDate: '', ...o })

// ---------- rule 1: the amount, weighed against what was actually paid ----------

test('the actual paid amount outranks a contractual amount that also matches', () => {
  const ctx = load([
    pay({ id: 'a', paymentNumber: 1, amount: 100000, paidAmount: 103500, dueDate: '2026-03-01', paidDate: '2026-03-05' }),
    pay({ id: 'b', paymentNumber: 2, amount: 103500, paidAmount: 0, dueDate: '2026-06-01' }),
  ])
  const m = ctx._pdMatchPayment(doc({ amount: 103500, docDate: '2026-03-06' }), null)
  assert.equal(m.row.id, 'a')
  assert.ok(m.confidence >= gate(ctx))
})

test('an unpaid row still auto-links on its contractual amount', () => {
  const ctx = load([pay({ id: 'b', paymentNumber: 2, amount: 103500, dueDate: '2026-06-01' })])
  const m = ctx._pdMatchPayment(doc({ docType: 'voucher', amount: 103500, docDate: '2026-06-02' }), null)
  assert.equal(m.row.id, 'b')
  assert.equal(m.confidence, 0.85)
})

test('hitting the contractual amount while a different amount was actually paid asks instead', () => {
  const ctx = load([
    pay({ id: 'c', paymentNumber: 3, amount: 50000, paidAmount: 51200, dueDate: '2026-01-01', paidDate: '2026-01-02' }),
  ])
  const m = ctx._pdMatchPayment(doc({ amount: 50000, docDate: '2026-01-03' }), null)
  assert.equal(m.row.id, 'c')
  assert.ok(m.confidence < gate(ctx), 'a conflicting actual amount must not auto-link')
})

test('a shekel apart is the same payment, twenty apart is not', () => {
  const ctx = load([pay({ id: 'a', paidAmount: 10000, paidDate: '2026-03-01' })])
  assert.equal(ctx._pdMatchPayment(doc({ amount: 10001, docDate: '2026-03-01' }), null).rule, 'amount')
  assert.notEqual(ctx._pdMatchPayment(doc({ amount: 10020, docDate: '2026-03-01' }), null).rule, 'amount')
})

test('two payments of the same amount are ambiguous — nearest date first, but below the bar', () => {
  const ctx = load([
    pay({ id: 'd', paymentNumber: 4, paidAmount: 20000, dueDate: '2026-02-01', paidDate: '2026-02-01' }),
    pay({ id: 'e', paymentNumber: 5, paidAmount: 20000, dueDate: '2026-05-01', paidDate: '2026-05-01' }),
  ])
  const m = ctx._pdMatchPayment(doc({ amount: 20000, docDate: '2026-05-02' }), null)
  assert.equal(m.row.id, 'e')
  assert.equal(m.candidates.length, 2)
  assert.ok(m.confidence < gate(ctx))
})

test('a payment number breaks the tie and clears the bar', () => {
  const ctx = load([
    pay({ id: 'd', paymentNumber: 4, paidAmount: 20000, paidDate: '2026-02-01' }),
    pay({ id: 'e', paymentNumber: 5, paidAmount: 20000, paidDate: '2026-05-01' }),
  ])
  const m = ctx._pdMatchPayment(doc({ amount: 20000, docDate: '2026-05-02' }), 4)
  assert.equal(m.row.id, 'd')
  assert.ok(m.confidence >= gate(ctx))
})

test('a payment number that contradicts the amount drops confidence below the bar', () => {
  const ctx = load([
    pay({ id: 'd', paymentNumber: 4, paidAmount: 20000, paidDate: '2026-02-01' }),
    pay({ id: 'e', paymentNumber: 5, paidAmount: 31000, paidDate: '2026-05-01' }),
  ])
  const m = ctx._pdMatchPayment(doc({ amount: 20000, docDate: '2026-02-02' }), 5)
  assert.equal(m.row.id, 'd')
  assert.ok(m.confidence < gate(ctx))
})

// ---------- rule 2: the date, and only as a nomination ----------

test('a date-only match never auto-links', () => {
  const ctx = load([
    pay({ id: 'f', paymentNumber: 6, amount: 9000, paidAmount: 9000, paidDate: '2026-04-01' }),
  ])
  const m = ctx._pdMatchPayment(doc({ amount: 12345, docDate: '2026-04-10' }), null)
  assert.equal(m.rule, 'date')
  assert.equal(m.row.id, 'f')
  assert.ok(m.confidence < gate(ctx))
})

test('the back window is two weeks — an older payment is not "near"', () => {
  const ctx = load([pay({ id: 'f', paidAmount: 9000, paidDate: '2026-04-01' })])
  assert.equal(ctx._pdMatchPayment(doc({ docDate: '2026-04-14' }), null).rule, 'date')
  assert.equal(ctx._pdMatchPayment(doc({ docDate: '2026-04-20' }), null).rule, 'none')
})

test('a doc that belongs to no single payment stays silent instead of asking', () => {
  const ctx = load([pay({ id: 'f', paidAmount: 9000, paidDate: '2026-04-01' })])
  assert.equal(ctx._pdMatchPayment(doc({ docType: 'contract', docDate: '2026-04-05' }), null).rule, 'skip')
  assert.equal(ctx._pdMatchPayment(doc({ docType: 'schedule', amount: 9000, docDate: '2026-04-05' }), null).rule, 'amount')
})

test('nothing to match a payment doc against — offer to create the row', () => {
  const ctx = load([])
  const m = ctx._pdMatchPayment(doc({ docType: 'voucher', amount: 7500, docDate: '2026-04-05' }), null)
  assert.equal(m.row, null)
  assert.equal(m.rule, 'none')
})

// ---------- the row built from a document ----------

test('a receipt creates a paid row, a voucher only a due one', () => {
  const ctx = load([pay({ id: 'x', paymentNumber: 3 })])
  ctx.DB.set('finPropertyDocs', [
    { id: 'd1', name: 'r.pdf', title: 'קבלה', docType: 'receipt', amount: 8000, docDate: '2026-04-05' },
    { id: 'd2', name: 'v.pdf', title: 'שובר', docType: 'voucher', amount: 8000, docDate: '2026-04-05' },
  ])
  ctx._eval('_propEmptyPayment = () => ({ id: genId(), dueDate: "", paidDate: "", type: "payment", paymentNumber: null, amount: 0, paidAmount: 0, equity: 0, mortgage: 0, track: "", notes: "" })')
  ctx._eval('savePropertyPayments = list => DB.set("finPropertyPayments", list)')

  const receipt = ctx._pdCreatePaymentForDoc('d1')
  assert.equal(receipt.paymentNumber, 4, 'numbering continues from the highest existing')
  assert.equal(receipt.amount, 8000)
  assert.equal(receipt.paidAmount, 8000)
  assert.equal(receipt.paidDate, '2026-04-05')

  const voucher = ctx._pdCreatePaymentForDoc('d2')
  assert.equal(voucher.dueDate, '2026-04-05')
  assert.equal(voucher.paidAmount, 0, 'a voucher has not paid anything yet')
  assert.equal(voucher.paidDate, '')
})


// ---------- order and search inside the card ----------

// The card is a filing cabinet: category first, then the date on the document
// itself. Docs here deliberately carry an upload order that contradicts their
// document dates — that is the case the old createdAt sort got wrong.
function loadCard(docs = [], payments = []) {
  const db = makeDbStub({ finPropertyDocs: docs, finPropertyPayments: payments })
  return loadApp(['propertyDocs.js'], {
    DB: db,
    getPropertyPayments: () => db.get('finPropertyPayments', []),
    genId: () => 'id' + Math.random().toString(36).slice(2),
    formatDate: iso => (iso ? iso.split('-').reverse().join('/') : ''),
    formatCurrency: n => String(n),
    uiIcon: () => '',
    escHtml: v => String(v),
    escAttr: v => String(v),
    PROPERTY_TYPES: { payment: { label: 'תשלום' }, other: { label: 'אחר' } },
    indexedDB: undefined,
    window: { addEventListener: () => {} },
  })
}

const cdoc = (o) => ({ id: o.id, name: o.id, docType: 'voucher', title: '', summary: '', notes: '',
  amount: 0, docDate: '', linkedPaymentId: '', createdAt: '2026-01-01T00:00:00.000Z', ...o })

test('inside a category the document date orders the list, not the upload time', () => {
  const ctx = loadCard([
    cdoc({ id: 'c', docDate: '2026-03-10', createdAt: '2026-05-01T09:00:00.000Z' }),
    cdoc({ id: 'a', docDate: '2026-01-10', createdAt: '2026-05-01T12:00:00.000Z' }),
    cdoc({ id: 'b', docDate: '2026-02-10', createdAt: '2026-05-01T07:00:00.000Z' }),
  ])
  assert.deepEqual(ctx._pdVisibleDocs().map(d => d.id), ['c', 'b', 'a'])
  ctx.propDocToggleSort()
  assert.deepEqual(ctx._pdVisibleDocs().map(d => d.id), ['a', 'b', 'c'])
})

test('a document with no date read off it falls back to its upload time', () => {
  const ctx = loadCard([
    cdoc({ id: 'dated', docDate: '2026-02-10', createdAt: '2026-01-01T00:00:00.000Z' }),
    cdoc({ id: 'undated', docDate: '', createdAt: '2026-03-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(ctx._pdVisibleDocs().map(d => d.id), ['undated', 'dated'])
})

test('categories stay grouped, and each group is ordered on its own', () => {
  const ctx = loadCard([
    cdoc({ id: 'r1', docType: 'receipt', docDate: '2026-01-01' }),
    cdoc({ id: 'v1', docType: 'voucher', docDate: '2026-01-01' }),
    cdoc({ id: 'r2', docType: 'receipt', docDate: '2026-04-01' }),
    cdoc({ id: 'v2', docType: 'voucher', docDate: '2026-04-01' }),
  ])
  // voucher precedes receipt in PROP_DOC_BUILTIN_CATS.
  assert.deepEqual(ctx._pdVisibleDocs().map(d => d.id), ['v2', 'v1', 'r2', 'r1'])
})

test('search is AND over tokens and reaches the indexed text of the scan', () => {
  const ctx = loadCard([
    cdoc({ id: 'a', title: 'שובר תשלום 4', text: 'בנק לאומי סניף 800 שובר לתשלום' }),
    cdoc({ id: 'b', title: 'שובר תשלום 5', text: 'בנק הפועלים סניף 12' }),
  ])
  ctx._eval("_pdSearch = 'לאומי'")
  assert.deepEqual(ctx._pdVisibleDocs().map(d => d.id), ['a'])
  ctx._eval("_pdSearch = 'שובר לאומי'")
  assert.deepEqual(ctx._pdVisibleDocs().map(d => d.id), ['a'])
  ctx._eval("_pdSearch = 'שובר הפועלים לאומי'")
  assert.deepEqual(ctx._pdVisibleDocs().map(d => d.id), [])
})

test('search also matches the formatted date, the amount and the category label', () => {
  const ctx = loadCard([cdoc({ id: 'a', docDate: '2026-03-09', amount: 103500 })])
  for (const q of ['09/03/2026', '2026-03', '103500', 'שובר']) {
    ctx._eval(`_pdSearch = ${JSON.stringify(q)}`)
    assert.deepEqual(ctx._pdVisibleDocs().map(d => d.id), ['a'], q)
  }
})

test('a hit inside the scanned text gets a snippet, a metadata-only hit does not', () => {
  const ctx = loadCard([cdoc({ id: 'a', title: 'שובר', text: 'שולם בבנק לאומי ביום שלישי' })])
  const withText = ctx._pdTextSnippet(ctx._pdVisibleDocs()[0], ['לאומי'])
  assert.ok(withText.includes('<mark>לאומי</mark>'))
  assert.equal(ctx._pdTextSnippet(ctx._pdVisibleDocs()[0], ['שובר']), '')
})
