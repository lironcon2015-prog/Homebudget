import { test } from 'node:test'
import assert from 'node:assert'
import { loadApp } from './helpers.mjs'

const ctx = loadApp(['txmatch.js'])
const {
  txmAgorot, txmVendorKey, txmTokenOverlap, txmVendorTokens, txmRowSignature,
  txmRecord, txmScorePair, reconcileTransactions, txmAddMonths, txmMonthDiff,
  txmExplain,
} = ctx

// Build a match record the way the import pipeline will.
const rec = (o) => txmRecord({
  id: o.id, accountId: o.acct || 'cc1', amount: o.amount, vendor: o.vendor,
  installmentCurrent: o.cur, installmentTotal: o.tot, srcRowHash: o.sig,
}, { purchaseDate: o.date ?? null, billingMonth: o.month ?? null, ref: o })

const names = r => r.matched.length + '/' + r.fresh.length + '/' + r.review.length + '/' + r.orphans.length

// ---------- normalization ----------

test('agorot compares money as integers', () => {
  assert.equal(txmAgorot(-120.5), -12050)
  assert.equal(txmAgorot(-120.50), -12050)
  assert.equal(txmAgorot(0.1 + 0.2), 30)
  assert.equal(txmAgorot('abc'), null)
})

test('vendor key collapses formatting noise between export formats', () => {
  // Corporate suffix, in both spellings, drops out entirely.
  assert.equal(txmVendorKey('שופרסל דיל בע"מ'), txmVendorKey('שופרסל דיל בעמ'))
  assert.equal(txmVendorKey('שופרסל דיל בע"מ'), txmVendorKey('שופרסל דיל'))
  // Digits and padding are noise; word order is not meaningful.
  assert.equal(txmVendorKey('  RAMI   LEVY 1234 '), 'levy rami')
  assert.equal(txmVendorKey('לאומי בנק'), txmVendorKey('בנק לאומי'))
  // Hebrew final letters unify so token sets line up.
  assert.equal(txmVendorKey('קניון'), txmVendorKey('קניונ'))
  assert.equal(txmVendorKey(''), '')
})

test('token overlap uses containment, so a shorter name still corroborates', () => {
  const a = txmVendorTokens('שופרסל')
  const b = txmVendorTokens('שופרסל דיל רמת גן')
  assert.equal(txmTokenOverlap(a, b), 1)
  assert.equal(txmTokenOverlap(a, txmVendorTokens('סונול')), 0)
})

test('row signature ignores whitespace but not content', () => {
  assert.equal(txmRowSignature(['03/05/2026', ' רמי לוי ', '-120']),
               txmRowSignature(['03/05/2026', 'רמי  לוי', '-120']))
  assert.notEqual(txmRowSignature(['03/05/2026', 'רמי לוי', '-120']),
                  txmRowSignature(['03/05/2026', 'רמי לוי', '-121']))
  // Column-shifted rows must not collide (the separator does that work).
  assert.notEqual(txmRowSignature(['a', 'bc']), txmRowSignature(['ab', 'c']))
  assert.equal(txmRowSignature(['', '  ']), '')
})

// ---------- scoring ----------

test('printed installment indices veto a pair outright', () => {
  const a = rec({ amount: -250, vendor: 'איקאה', date: '2026-04-22', cur: 3, tot: 10, month: '2026-05' })
  const b = rec({ amount: -250, vendor: 'איקאה', date: '2026-04-22', cur: 4, tot: 10, month: '2026-06' })
  const s = txmScorePair(a, b)
  assert.equal(s.disqualified, true)
})

test('a missing signal never penalizes; only conflicting ones do', () => {
  const withInst = rec({ amount: -250, vendor: 'איקאה', date: '2026-04-22', cur: 3, tot: 10, month: '2026-06' })
  const without  = rec({ amount: -250, vendor: 'איקאה', month: '2026-06' })
  const s = txmScorePair(withInst, without)
  assert.equal(s.disqualified, false)
  assert.ok(s.score >= 2, `expected corroboration, got ${s.score}`)
})

// ---------- the failures that motivated the rebuild ----------

test('REGRESSION: a wide report re-offers nothing that is already stored', () => {
  // Two monthly bills already imported, then one report covering both cycles.
  const stored = [
    rec({ id: 's1', amount: -250, vendor: 'איקאה',  date: '2026-04-22', cur: 3, tot: 10, month: '2026-05' }),
    rec({ id: 's2', amount: -90,  vendor: 'שופרסל', date: '2026-04-28', month: '2026-05' }),
    rec({ id: 's3', amount: -60,  vendor: 'ארומה',  date: '2026-05-04', month: '2026-05' }),
    rec({ id: 's4', amount: -250, vendor: 'איקאה',  date: '2026-04-22', cur: 4, tot: 10, month: '2026-06' }),
    rec({ id: 's5', amount: -140, vendor: 'פז',     date: '2026-05-19', month: '2026-06' }),
    rec({ id: 's6', amount: -75,  vendor: 'ארומה',  date: '2026-06-02', month: '2026-06' }),
  ]
  const wide = [
    rec({ amount: -250, vendor: 'איקאה',  date: '2026-04-22', cur: 3, tot: 10, month: '2026-05' }),
    rec({ amount: -90,  vendor: 'שופרסל', date: '2026-04-28', month: '2026-05' }),
    rec({ amount: -60,  vendor: 'ארומה',  date: '2026-05-04', month: '2026-05' }),
    rec({ amount: -250, vendor: 'איקאה',  date: '2026-04-22', cur: 4, tot: 10, month: '2026-06' }),
    rec({ amount: -140, vendor: 'פז',     date: '2026-05-19', month: '2026-06' }),
    rec({ amount: -75,  vendor: 'ארומה',  date: '2026-06-02', month: '2026-06' }),
  ]
  const r = reconcileTransactions(wide, stored, { scopeMonths: ['2026-05', '2026-06'] })
  assert.equal(names(r), '6/0/0/0', JSON.stringify({
    matched: r.matched.map(m => m.existing.id), fresh: r.fresh.length, review: r.review.length,
  }))
  // Each installment matched ITS OWN stored row, not the other one.
  const pair = r.matched.filter(m => m.row.instCur)
  assert.deepEqual(pair.map(m => [m.row.instCur, m.existing.id]).sort(), [[3, 's1'], [4, 's4']])
})

test('REGRESSION: a cycle guessed one month off still matches', () => {
  // The old code keyed dedup on a guessed billing month; a disagreement of one
  // cycle between two imports meant zero matches.
  const stored = [rec({ id: 's1', amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-05' })]
  const again  = [rec({ amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-06' })]
  const r = reconcileTransactions(again, stored, {})
  assert.equal(names(r), '1/0/0/0')
})

test('REGRESSION: a legacy row with no billing month at all still matches', () => {
  const stored = [rec({ id: 's1', amount: -120, vendor: 'רמי לוי', date: '2026-05-03' })]
  const again  = [rec({ amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-06' })]
  assert.equal(names(reconcileTransactions(again, stored, {})), '1/0/0/0')
})

test('same charge from a different export format matches on amount + cycle', () => {
  // Issuer export: purchase date + installment index, terse vendor.
  const stored = [rec({ id: 's1', amount: -250, vendor: 'איקאה', date: '2026-04-22', cur: 3, tot: 10, month: '2026-06' })]
  // Bank export of the same bill: no installment column, date column holds the
  // charge date so no purchase date is known, vendor spelled differently.
  const bank = [rec({ amount: -250, vendor: 'איקאה ישראל בע"מ', month: '2026-06' })]
  assert.equal(names(reconcileTransactions(bank, stored, {})), '1/0/0/0')
})

test('vendor drift alone does not prevent a match', () => {
  const stored = [rec({ id: 's1', amount: -120, vendor: 'רמי לוי שיווק השקמה', date: '2026-05-03', month: '2026-05' })]
  const again  = [rec({ amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-05' })]
  assert.equal(names(reconcileTransactions(again, stored, {})), '1/0/0/0')
})

// ---------- safety: it must not over-match ----------

test('a genuinely new charge is not absorbed by a similar stored one', () => {
  const stored = [rec({ id: 's1', amount: -50, vendor: 'ארומה', date: '2026-05-03', month: '2026-05' })]
  const file = [
    rec({ amount: -50, vendor: 'ארומה',   date: '2026-05-03', month: '2026-05' }),
    rec({ amount: -50, vendor: 'קפה קפה', date: '2026-05-03', month: '2026-05' }),
  ]
  const r = reconcileTransactions(file, stored, { scopeMonths: ['2026-05'] })
  assert.equal(names(r), '1/1/0/0')
  assert.equal(r.fresh[0].vendorKey, txmVendorKey('קפה קפה'))
})

test('a repeated identical charge consumes one slot, the rest are new', () => {
  const stored = [rec({ id: 's1', amount: -45, vendor: 'נטפליקס', date: '2026-05-03', month: '2026-05' })]
  const file = [
    rec({ amount: -45, vendor: 'נטפליקס', date: '2026-05-03', month: '2026-05' }),
    rec({ amount: -45, vendor: 'נטפליקס', date: '2026-05-03', month: '2026-05' }),
  ]
  const r = reconcileTransactions(file, stored, { scopeMonths: ['2026-05'] })
  assert.equal(names(r), '1/1/0/0')
})

test('a monthly subscription in the next cycle is new, not a duplicate', () => {
  const stored = [rec({ id: 's1', amount: -45, vendor: 'נטפליקס', date: '2026-05-03', month: '2026-05' })]
  const next   = [rec({ amount: -45, vendor: 'נטפליקס', date: '2026-06-03', month: '2026-06' })]
  // Scope is the June bill, so May's charge is outside it and not an orphan.
  const r = reconcileTransactions(next, stored, { scopeMonths: ['2026-06'] })
  assert.equal(names(r), '0/1/0/0')
})

test('an indistinguishable pair goes to review rather than being guessed', () => {
  // Two stored charges, same amount and cycle, nothing else to tell them apart.
  const stored = [
    rec({ id: 's1', amount: -100, vendor: '', month: '2026-06' }),
    rec({ id: 's2', amount: -100, vendor: '', month: '2026-06' }),
  ]
  const file = [rec({ amount: -100, vendor: '', month: '2026-06' })]
  const r = reconcileTransactions(file, stored, {})
  assert.equal(r.review.length, 1)
  assert.equal(r.matched.length, 0)
  assert.equal(r.review[0].candidates.length, 2)
})

test('different amounts never match, however similar everything else is', () => {
  const stored = [rec({ id: 's1', amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-05' })]
  const file   = [rec({ amount: -121, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-05' })]
  const r = reconcileTransactions(file, stored, { scopeMonths: ['2026-05'] })
  assert.equal(names(r), '0/1/0/1')
})

// ---------- the safety net ----------

test('a stored row the file omits surfaces as an orphan, never silently', () => {
  const stored = [
    rec({ id: 's1', amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-05' }),
    rec({ id: 's2', amount: -300, vendor: 'סונול',   date: '2026-05-04', month: '2026-05' }),
  ]
  const file = [rec({ amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-05' })]
  const r = reconcileTransactions(file, stored, { scopeMonths: ['2026-05'] })
  assert.equal(names(r), '1/0/0/1')
  assert.equal(r.orphans[0].id, 's2')
})

test('orphans stay inside the cycles the file covers', () => {
  const stored = [
    rec({ id: 's1', amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-05' }),
    rec({ id: 'old', amount: -999, vendor: 'ישן',    date: '2025-01-03', month: '2025-01' }),
  ]
  const file = [rec({ amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-05' })]
  const r = reconcileTransactions(file, stored, { scopeMonths: ['2026-05'] })
  assert.equal(r.orphans.length, 0)
})

// ---------- identical re-upload ----------

test('identical raw rows match by signature with no scoring at all', () => {
  const sig = txmRowSignature(['03/05/2026', 'רמי לוי', '-120'])
  const stored = [rec({ id: 's1', amount: -120, vendor: 'רמי לוי', date: '2026-05-03', month: '2026-05', sig })]
  const file   = [rec({ amount: -120, vendor: 'לגמרי אחר', date: '2020-01-01', month: '2020-01', sig })]
  const r = reconcileTransactions(file, stored, {})
  assert.equal(r.matched.length, 1)
  assert.deepEqual(r.matched[0].reasons, ['row-signature'])
})

test('month arithmetic wraps years correctly', () => {
  assert.equal(txmAddMonths('2026-12', 1), '2027-01')
  assert.equal(txmAddMonths('2026-01', -1), '2025-12')
  assert.equal(txmMonthDiff('2025-12', '2026-01'), 1)
})

// ---------- explaining a miss ----------

test('a miss reports the gate that actually stopped it', () => {
  const stored = [rec({ id: 's1', amount: -250, vendor: 'איקאה', date: '2026-04-22', cur: 3, tot: 10, month: '2026-06' })]

  // Nothing at that amount at all.
  assert.equal(txmExplain(rec({ amount: -99, vendor: 'ארומה', month: '2026-06' }), stored).verdict, 'no-amount-match')

  // Same magnitude, opposite sign — invisible under the hard amount gate, so
  // it must be surfaced explicitly.
  const flipped = txmExplain(rec({ amount: 250, vendor: 'איקאה', month: '2026-06' }), stored)
  assert.equal(flipped.verdict, 'amount-near-miss')
  assert.equal(flipped.nearAmount[0].why, 'sign')

  // Same amount, but a contradicting installment index.
  assert.equal(txmExplain(rec({ amount: -250, vendor: 'איקאה', date: '2026-04-22', cur: 4, tot: 10, month: '2026-06' }), stored).verdict,
               'disqualified')

  // Same amount, but years away.
  assert.equal(txmExplain(rec({ amount: -250, vendor: 'איקאה', date: '2024-01-01', month: '2024-01' }), stored).verdict,
               'out-of-window')

  assert.equal(txmExplain(rec({ amount: -250, vendor: 'איקאה', month: '2026-06' }), []).verdict, 'empty-account')
})

test('an ambiguous row is reported as ambiguous, with its candidates', () => {
  const stored = [
    rec({ id: 's1', amount: -100, vendor: '', month: '2026-06' }),
    rec({ id: 's2', amount: -100, vendor: '', month: '2026-06' }),
  ]
  const info = txmExplain(rec({ amount: -100, vendor: '', month: '2026-06' }), stored)
  assert.equal(info.verdict, 'ambiguous')
  assert.equal(info.candidates.length, 2)
  assert.ok(info.candidates.every(c => c.inWindow && !c.disqualified))
})

test('every verdict has a message a user can act on', () => {
  const labels = ctx._eval('TXM_VERDICT_LABEL')
  for (const v of ['empty-account', 'no-amount-match', 'amount-near-miss', 'out-of-window',
                   'disqualified', 'below-threshold', 'ambiguous']) {
    assert.ok(labels[v] && labels[v].length > 5, `missing label for ${v}`)
  }
})
