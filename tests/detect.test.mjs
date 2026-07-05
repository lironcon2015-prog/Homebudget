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
