import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApp, deepEq } from './helpers.mjs'

const d = loadApp(['detect.js'])

test('detectInstallmentInfo variants', () => {
  deepEq(d.detectInstallmentInfo('תשלום 3 מתוך 12'), { current: 3, total: 12 })
  deepEq(d.detectInstallmentInfo('7 מתוך 10'), { current: 7, total: 10 })
  deepEq(d.detectInstallmentInfo('תשלום 2/6'), { current: 2, total: 6 })
  assert.equal(d.detectInstallmentInfo('תשלום 5 מתוך 3'), null)   // current > total
  assert.equal(d.detectInstallmentInfo('תשלום 1 מתוך 1'), null)   // total < 2
  assert.equal(d.detectInstallmentInfo(''), null)
})

test('detectStandingOrder: full phrase and abbreviation, not substrings', () => {
  assert.equal(d.detectStandingOrder('הוראת קבע חשמל'), true)
  assert.equal(d.detectStandingOrder('הו"ק ארנונה'), true)
  assert.equal(d.detectStandingOrder('חיוב רגיל'), false)
})

test('detectBitPayboxRecipient extracts payee, excludes ביטוח', () => {
  const r = d.detectBitPayboxRecipient('BIT', 'העברה ביט אל דנה כהן')
  assert.equal(r.provider, 'ביט')
  assert.equal(r.recipient.includes('דנה'), true)
  assert.equal(d.detectBitPayboxRecipient('ביטוח ישיר', 'פוליסת רכב'), null)
  const p = d.detectBitPayboxRecipient('PAYBOX', 'תשלום פייבוקס יוסי לוי')
  assert.equal(p.provider, 'פייבוקס')
})

test('enrichDetectedFields rewrites bit vendor and is idempotent', () => {
  const t = { vendor: 'BIT', description: 'העברה ביט אל דנה כהן' }
  const e1 = d.enrichDetectedFields(t)
  assert.equal(e1.vendor.startsWith('ביט'), true)
  const e2 = d.enrichDetectedFields(e1)
  assert.equal(e2.vendor, e1.vendor)
})

test('installmentFinalMonthFromCharge', () => {
  assert.equal(d.installmentFinalMonthFromCharge('2026-06', 3, 12), '2027-03')
  assert.equal(d.installmentFinalMonthFromCharge('2026-06', 12, 12), '2026-06')
  assert.equal(d.installmentFinalMonthFromCharge('2026-06', 5, 3), '')
  assert.equal(d.installmentFinalMonthFromCharge('', 1, 3), '')
})

test('remapInstallmentDateToBillCycle: rollover + day clamp', () => {
  // day < billingDay → stays in billing month
  assert.equal(d.remapInstallmentDateToBillCycle('2025-11-05', '2026-06', 10), '2026-06-05')
  // day >= billingDay → previous calendar month so rollover lands it in the cycle
  assert.equal(d.remapInstallmentDateToBillCycle('2025-11-30', '2026-06', 10), '2026-05-30')
  // day 31 clamps to target month length
  assert.equal(d.remapInstallmentDateToBillCycle('2025-01-31', '2026-05', 10), '2026-04-30')
})

test('rebuildAutoNotes: preserves user text, idempotent, rewrites auto clauses', () => {
  const fields = { installmentCurrent: 2, installmentTotal: 6, installmentFinalMonth: '2026-10', standingOrder: true, detectedRecipient: 'דנה' }
  const n1 = d.rebuildAutoNotes('הערה שלי', fields)
  assert.equal(n1.includes('תשלום 2 מתוך 6'), true)
  assert.equal(n1.includes('חודש חיוב אחרון: 10/2026'), true)
  assert.equal(n1.includes('הוראת קבע'), true)
  assert.equal(n1.includes('נמען: דנה'), true)
  assert.equal(n1.includes('הערה שלי'), true)
  // idempotent: rebuilding from its own output yields identical notes
  assert.equal(d.rebuildAutoNotes(n1, fields), n1)
  // changing a field rewrites the clause without duplicating
  const n2 = d.rebuildAutoNotes(n1, { ...fields, installmentCurrent: 3 })
  assert.equal(n2.includes('תשלום 3 מתוך 6'), true)
  assert.equal(n2.includes('תשלום 2 מתוך 6'), false)
  assert.equal(n2.includes('הערה שלי'), true)
})

// ===== IMMEDIATE / FX CHARGES =====
// Billed in the month they were executed, not deferred to the statement cycle —
// the one exception to "every line on this bill belongs to this bill".

test('detectImmediateCharge: recognises immediate and foreign-currency markers', () => {
  for (const txt of ['חיוב מיידי', 'עסקת חו"ל', 'חו״ל', 'מט"ח', 'מטבע חוץ',
                     'דולר', 'אירו', 'יורו', 'AMAZON USD', 'foreign currency', 'EUR 12.50']) {
    assert.equal(d.detectImmediateCharge('', txt, ''), true, `missed: ${txt}`)
  }
})

test('detectImmediateCharge: does not fire on ordinary Hebrew words', () => {
  // "חול" is an ordinary word and must never be read as "חו״ל"; "מיידית" as
  // part of another word must not trip the standalone token either.
  for (const txt of ['חול הים', 'מיידיות שירות', 'רמי לוי', 'ביטוח לאומי',
                     'שופרסל דיל', 'דולרי גל בע"מ', '']) {
    assert.equal(d.detectImmediateCharge('', txt, ''), false, `false positive: ${txt}`)
  }
})

test('detectImmediateCharge: reads the unmapped-column text too', () => {
  assert.equal(d.detectImmediateCharge('AMAZON', '', 'חיוב מיידי'), true)
  assert.equal(d.enrichDetectedFields({ vendor: 'AMAZON', description: '', _detectText: 'עסקת חו"ל' }).immediateCharge, true)
  assert.equal(d.enrichDetectedFields({ vendor: 'רמי לוי', description: '' }).immediateCharge, undefined)
})

test('detectInstallmentInfo: the MAX "N מ - M" form', () => {
  // Taken from a real MAX statement's הערות column. Verified against the file:
  // סכום עסקה / M equals סכום חיוב on every row.
  deepEq(d.detectInstallmentInfo('9 מ - 12'), { current: 9, total: 12 })
  deepEq(d.detectInstallmentInfo('8 מ - 10'), { current: 8, total: 10 })
  deepEq(d.detectInstallmentInfo('6 מ - 15'), { current: 6, total: 15 })
  deepEq(d.detectInstallmentInfo('2 מ - 3'), { current: 2, total: 3 })
  deepEq(d.detectInstallmentInfo('9 מ-12'), { current: 9, total: 12 })
  deepEq(d.detectInstallmentInfo('9 מ – 12'), { current: 9, total: 12 })
  // The other values that share that column must stay inert.
  assert.equal(d.detectInstallmentInfo('רגילה'), null)
  assert.equal(d.detectInstallmentInfo('חיוב מיידי, רגילה'), null)
  // The dash is required — מ is an ordinary Hebrew prefix.
  assert.equal(d.detectInstallmentInfo('9 מ 12'), null)
  assert.equal(d.detectInstallmentInfo('נסע 5 מ 20 קמ'), null)
  // Still validated like every other form.
  assert.equal(d.detectInstallmentInfo('12 מ - 9'), null, 'current > total')
})

test('enrichDetectedFields reads the MAX form out of an unmapped column', () => {
  const e = d.enrichDetectedFields({ vendor: 'אלקטרה - סופר גז', description: '', _detectText: '9 מ - 12' })
  assert.equal(e.installmentCurrent, 9)
  assert.equal(e.installmentTotal, 12)
  const plain = d.enrichDetectedFields({ vendor: 'שופרסל', description: '', _detectText: 'רגילה' })
  assert.equal(plain.installmentCurrent, undefined)
})
