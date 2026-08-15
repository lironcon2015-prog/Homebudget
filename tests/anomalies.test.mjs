// Suspicious-transaction detection.
//
// These tests measure PRECISION, not just behaviour. The rules regressed to a
// 6%-precision state (16 alerts on a realistic year, one of them real) because
// nothing here failed when a threshold let noise through. So the headline test
// builds a full synthetic household year with exactly one planted duplicate and
// asserts on the false-positive count; the rest pin the individual traps that
// produced that noise, each named for the real-world thing it stands for.
//
// The clock is frozen: every rule keys off "now", so a corpus written against a
// moving today would drift out of its own windows within weeks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApp, makeDbStub } from './helpers.mjs'

const NOW = new Date(2026, 7, 15)          // 2026-08-15
const d = (y, m, dd) => `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`

const ACCOUNTS = [
  { id: 'chk', name: 'עו"ש', type: 'checking' },
  { id: 'cc', name: 'ויזה', type: 'credit_card', billingDay: 10 },
  { id: 'sav', name: 'חיסכון', type: 'savings' },
]
const CATEGORIES = [
  { id: 'food', name: 'מזון' }, { id: 'car', name: 'רכב' }, { id: 'home', name: 'בית' },
  { id: 'fun', name: 'פנאי' }, { id: 'sub', name: 'מנויים' },
  { id: 'sv', name: 'חסכונות והשקעות', isSavings: true },
]

// A deterministic clock. `Date.now()` and `new Date()` must both answer 2026-08-15
// while `new Date('2026-01-02')` keeps parsing normally.
function frozenDate() {
  const R = Date
  const F = function (...a) { return a.length ? new R(...a) : new R(NOW) }
  F.prototype = R.prototype
  F.now = () => NOW.getTime()
  F.parse = R.parse
  F.UTC = R.UTC
  return F
}

function detect(transactions, { accounts = ACCOUNTS, categories = CATEGORIES, db = {}, dom = null } = {}) {
  const store = makeDbStub(db)
  const ctx = loadApp(['core.js', 'autocat.js', 'recurring.js', 'anomalies.js'], {
    Date: frozenDate(),
    document: dom || { addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] },
    _insEsc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    DB: {
      get: (k, def) => (k === 'finTransactions' ? transactions : store.get(k, def)),
      set: store.set,
      getObj: store.getObj,
    },
    getAccounts: () => accounts,
    getCategories: () => categories,
    getTransactions: () => transactions,
    getCategoryById: id => categories.find(c => c.id === id),
    genId: () => 'gen' + Math.random().toString(36).slice(2),
    CC_KEYWORDS: ['ויזה', 'visa', 'מקס', 'max'],
    formatDate: s => s,
    formatCurrency: v => `₪${Math.round(v)}`,
    formatCurrencyPlain: v => `₪${Math.round(v)}`,
    uiIcon: () => '',
  })
  // The 25-alert display cap would mask a rule that fires 300 times.
  return { ctx, alerts: ctx._eval('(() => { ANOM_CONFIG.maxShow = 1e5; return ANOM_detect() })()') }
}

const rules = alerts => alerts.map(a => a.rule)
const countOf = (alerts, rule) => alerts.filter(a => a.rule === rule).length

// A year and a half of plausible household activity, so any rule that assumes
// "quiet baseline" meets the mess it will actually run against. Deterministic
// LCG — a flaky corpus is a useless corpus.
function household() {
  let seed = 42
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const jit = (base, pct) => Math.round(base * (1 + (rnd() * 2 - 1) * pct))
  let n = 0
  const tx = []
  const push = o => tx.push({ id: 't' + (++n), type: 'expense', accountId: 'cc', ...o })

  for (let k = 17; k >= 0; k--) {
    const base = new Date(2026, 7 - k, 1)
    const y = base.getFullYear(), m = base.getMonth() + 1
    const upto = k === 0 ? 15 : new Date(y, m, 0).getDate()   // current month is partial

    push({ date: d(y, m, 1), vendor: 'משכורת', amount: 21000, type: 'income', accountId: 'chk' })
    push({ date: d(y, m, 2), vendor: 'משכנתא בנק לאומי', amount: -6200, categoryId: 'home', accountId: 'chk' })
    push({ date: d(y, m, 5), vendor: 'ארנונה עיריית חיפה', amount: -jit(720, 0.02), categoryId: 'home', accountId: 'chk' })
    push({ date: d(y, m, 10), vendor: 'הפקדה לחיסכון', amount: -3000, categoryId: 'sv', accountId: 'chk', transferAccountId: 'sav' })
    // deliberately lumpy utilities — the classic "spike every cycle" trap
    if (m % 2 === 0) push({ date: d(y, m, 12), vendor: 'חברת חשמל', amount: -jit(690, 0.35), categoryId: 'home', accountId: 'chk' })
    else push({ date: d(y, m, 14), vendor: 'מי כרמל', amount: -jit(310, 0.25), categoryId: 'home', accountId: 'chk' })

    push({ date: d(y, m, 3), vendor: 'NETFLIX', amount: -54.9, categoryId: 'sub' })
    push({ date: d(y, m, 7), vendor: 'SPOTIFY', amount: -21.9, categoryId: 'sub' })
    push({ date: d(y, m, 15), vendor: 'סלקום', amount: -jit(189, 0.06), categoryId: 'sub' })
    push({ date: d(y, m, 20), vendor: 'חוג שחייה', amount: -320, categoryId: 'fun' })

    for (let i = 0; i < 5 + Math.floor(rnd() * 4); i++)          // groceries, wildly variable
      push({ date: d(y, m, 1 + Math.floor(rnd() * (upto - 1))), vendor: rnd() < 0.6 ? 'שופרסל דיל' : 'רמי לוי', amount: -jit(240, 0.6), categoryId: 'food' })
    for (let i = 0; i < 3 + Math.floor(rnd() * 2); i++)          // fuel, near-identical fills
      push({ date: d(y, m, 1 + Math.floor(rnd() * (upto - 1))), vendor: 'פז יעלים', amount: -jit(300, 0.08), categoryId: 'car' })
    for (let i = 0; i < 6 + Math.floor(rnd() * 5); i++)          // the ₪18 coffee, many times a month
      push({ date: d(y, m, 1 + Math.floor(rnd() * (upto - 1))), vendor: 'קפה ג׳ו', amount: -18, categoryId: 'food' })

    const fresh = ['מסעדת בני הדייג', 'סטימצקי', 'ACE חומרי בניין', 'זארה', 'איקאה', 'סופר פארם', 'מכון כושר']
    for (let i = 0; i < 2 + Math.floor(rnd() * 3); i++)          // ordinary new merchants
      push({ date: d(y, m, 1 + Math.floor(rnd() * (upto - 1))), vendor: fresh[Math.floor(rnd() * fresh.length)], amount: -jit(180, 0.8), categoryId: 'fun' })
  }
  // annual insurance: a legitimate 12-month gap
  push({ date: d(2025, 8, 20), vendor: 'ביטוח חובה רכב', amount: -2400, categoryId: 'car', accountId: 'chk' })
  push({ date: d(2026, 8, 12), vendor: 'ביטוח חובה רכב', amount: -2450, categoryId: 'car', accountId: 'chk' })
  // the one thing that IS wrong
  push({ date: d(2026, 8, 6), vendor: 'שופרסל דיל', amount: -412, categoryId: 'food', id: 'REAL-DUP-A' })
  push({ date: d(2026, 8, 7), vendor: 'שופרסל דיל', amount: -412, categoryId: 'food', id: 'REAL-DUP-B' })
  return tx
}

test('realistic household year: finds the planted duplicate and little else', () => {
  const { alerts } = detect(household())
  assert.ok(alerts.some(a => a.txId === 'REAL-DUP-B' && a.rule === 'dup'),
    'the planted ₪412 double charge must still be caught')
  // The bar the old implementation failed: 16 alerts, 1 of them real.
  assert.ok(alerts.length <= 3,
    `expected at most 3 alerts on a clean year, got ${alerts.length}: ${JSON.stringify(rules(alerts))}`)
})

test('a recurring small charge is a habit, not a duplicate', () => {
  // ₪18 coffee twice in the same days every month for eight months.
  const tx = []
  for (let m = 1; m <= 8; m++) {
    tx.push({ id: `a${m}`, type: 'expense', accountId: 'cc', date: d(2026, m, 4), vendor: 'קפה', amount: -18 })
    tx.push({ id: `b${m}`, type: 'expense', accountId: 'cc', date: d(2026, m, 5), vendor: 'קפה', amount: -18 })
  }
  assert.equal(countOf(detect(tx).alerts, 'dup'), 0)
})

test('an instalment plan is not six duplicate charges', () => {
  // Six rows of one purchase: same date, same amount, different billing cycles.
  const tx = []
  for (let m = 1; m <= 8; m++) tx.push({ id: 'base' + m, type: 'expense', accountId: 'cc', date: d(2026, m, 1), vendor: 'בסיס', amount: -500 })
  for (let i = 1; i <= 6; i++) {
    const bm = new Date(2026, 7 + i - 1, 1)
    tx.push({
      id: 'inst' + i, type: 'expense', accountId: 'cc', date: d(2026, 8, 4),
      vendor: 'א.ל.מ מוצרי חשמל', amount: -1200,
      billingMonth: `${bm.getFullYear()}-${String(bm.getMonth() + 1).padStart(2, '0')}`,
      installmentCurrent: i, installmentTotal: 6,
    })
  }
  assert.equal(countOf(detect(tx).alerts, 'dup'), 0)
})

test('an unfamiliar merchant charging the same large amount twice IS a duplicate', () => {
  // The counterweight to the two tests above: precision must not cost recall.
  const tx = []
  for (let m = 1; m <= 40; m++)
    tx.push({ id: 'n' + m, type: 'expense', accountId: 'cc', date: d(2025, 1 + ((m - 1) % 12), 1 + (m % 25)), vendor: 'ספק ' + (m % 7), amount: -(80 + m * 3) })
  tx.push({ id: 'z1', type: 'expense', accountId: 'cc', date: d(2026, 8, 6), vendor: 'חנות אלקטרוניקה', amount: -4300 })
  tx.push({ id: 'z2', type: 'expense', accountId: 'cc', date: d(2026, 8, 7), vendor: 'חנות אלקטרוניקה', amount: -4300 })
  const { alerts } = detect(tx)
  const dup = alerts.find(a => a.rule === 'dup')
  assert.ok(dup, `expected a duplicate alert, got ${JSON.stringify(rules(alerts))}`)
  assert.equal(dup.txId, 'z2')
  assert.equal(dup.severity, 'high')
})

test('a fixed monthly bill is never "an unusually large expense"', () => {
  // A ₪6,200 mortgage clears mean+3*std of a file full of ₪18 coffees every
  // month; it must not clear "unusual for this vendor".
  const { alerts } = detect(household())
  assert.equal(alerts.filter(a => a.rule === 'large-expense' && String(a.vendor).includes('משכנתא')).length, 0)
})

test('a savings deposit is not a suspicious charge', () => {
  const tx = []
  for (let m = 1; m <= 8; m++) tx.push({ id: 'g' + m, type: 'expense', accountId: 'chk', date: d(2026, m, 1), vendor: 'קניות', amount: -300, categoryId: 'food' })
  tx.push({ id: 'dep', type: 'expense', accountId: 'chk', date: d(2026, 8, 10), vendor: 'הפקדה לחיסכון', amount: -25000, transferAccountId: 'sav', categoryId: 'sv' })
  assert.equal(detect(tx).alerts.filter(a => a.txId === 'dep').length, 0)
})

test('recurring spike reads the entry members, not the raw vendor group', () => {
  // detectRecurring built the ₪60 subscription from rows within ±20% of median.
  // A one-off ₪940 charge at the same vendor is not "the subscription jumped".
  const tx = []
  for (let m = 1; m <= 8; m++) tx.push({ id: 's' + m, type: 'expense', accountId: 'cc', date: d(2026, m, 3), vendor: 'GOOGLE', amount: -60 })
  tx.push({ id: 'oneoff', type: 'expense', accountId: 'cc', date: d(2026, 8, 9), vendor: 'GOOGLE', amount: -940 })
  assert.equal(countOf(detect(tx).alerts, 'recurring-spike'), 0)
})

test('a row the user excluded from the vendor bucket cannot drive its spike', () => {
  const tx = []
  for (let m = 1; m <= 8; m++) tx.push({ id: 's' + m, type: 'expense', accountId: 'cc', date: d(2026, m, 3), vendor: 'GOOGLE', amount: -60 })
  tx.push({ id: 'x', type: 'expense', accountId: 'cc', date: d(2026, 8, 9), vendor: 'GOOGLE', amount: -940, recurringExcludeFromAuto: true })
  assert.equal(detect(tx).alerts.filter(a => a.txId === 'x' && a.rule === 'recurring-spike').length, 0)
})

test('a real subscription price rise still reports', () => {
  const tx = []
  for (let m = 1; m <= 7; m++) tx.push({ id: 's' + m, type: 'expense', accountId: 'cc', date: d(2026, m, 3), vendor: 'NETFLIX', amount: -54.9 })
  tx.push({ id: 'risen', type: 'expense', accountId: 'cc', date: d(2026, 8, 3), vendor: 'NETFLIX', amount: -99.9 })
  const { alerts } = detect(tx)
  assert.ok(alerts.some(a => a.txId === 'risen' && a.rule === 'recurring-spike'),
    `expected a recurring spike, got ${JSON.stringify(rules(alerts))}`)
})

test('an annual bill returning on schedule is not dormant', () => {
  const tx = []
  for (let m = 1; m <= 8; m++) tx.push({ id: 'b' + m, type: 'expense', accountId: 'chk', date: d(2026, m, 1), vendor: 'בסיס', amount: -500 })
  for (let y = 2022; y <= 2026; y++) tx.push({ id: 'lic' + y, type: 'expense', accountId: 'chk', date: d(y, 8, 3), vendor: 'רישוי רכב', amount: -1400 })
  assert.equal(countOf(detect(tx).alerts, 'dormant'), 0)
})

test('a two-visit shop has no rhythm and cannot be dormant', () => {
  const tx = []
  for (let m = 1; m <= 8; m++) tx.push({ id: 'b' + m, type: 'expense', accountId: 'chk', date: d(2026, m, 1), vendor: 'בסיס', amount: -500 })
  tx.push({ id: 'g1', type: 'expense', accountId: 'cc', date: d(2026, 1, 9), vendor: 'חנות מתנות', amount: -150 })
  tx.push({ id: 'g2', type: 'expense', accountId: 'cc', date: d(2026, 8, 9), vendor: 'חנות מתנות', amount: -160 })
  assert.equal(countOf(detect(tx).alerts, 'dormant'), 0)
})

test('ten ordinary new merchants in a month produce no new-vendor alerts', () => {
  const tx = []
  for (let m = 1; m <= 7; m++)
    for (let i = 0; i < 6; i++) tx.push({ id: `o${m}${i}`, type: 'expense', accountId: 'cc', date: d(2026, m, 2 + i * 3), vendor: `ותיק${m}${i}`, amount: -100 })
  ;['פיצה רומא', 'גלידריה ורדי', 'מוסך אבו חמד', 'אופטיקנה', 'דואר ישראל', 'חניון עזריאלי', 'טוטו', 'בית מרקחת', 'פרחי ליאור', 'תיקון מזגן']
    .forEach((v, i) => tx.push({ id: 'f' + i, type: 'expense', accountId: 'cc', date: d(2026, 8, 1 + i), vendor: v, amount: -(80 + i * 17) }))
  assert.equal(countOf(detect(tx).alerts, 'new-vendor'), 0)
})

test('a first charge that is also large for this user does report', () => {
  const tx = []
  for (let m = 1; m <= 7; m++)
    for (let i = 0; i < 6; i++) tx.push({ id: `o${m}${i}`, type: 'expense', accountId: 'cc', date: d(2026, m, 2 + i * 3), vendor: `ותיק${m}${i}`, amount: -100 })
  tx.push({ id: 'big', type: 'expense', accountId: 'cc', date: d(2026, 8, 4), vendor: 'ספק לא מוכר', amount: -5200 })
  const { alerts } = detect(tx)
  assert.ok(alerts.some(a => a.txId === 'big'), `expected an alert on the ₪5,200 first charge, got ${JSON.stringify(rules(alerts))}`)
})

test('a first import stays silent until there is enough history', () => {
  // Everything imported at once, all of it inside the recent window: without a
  // warm-up gate every vendor is new and every category is a spike.
  const tx = []
  for (let i = 0; i < 40; i++)
    tx.push({ id: 'i' + i, type: 'expense', accountId: 'cc', date: d(2026, 8, 1 + (i % 14)), vendor: 'ספק ' + i, amount: -(100 + i * 40) })
  assert.equal(detect(tx).alerts.length, 0)
})

test('missing bills wait for the data, not for the calendar', () => {
  // Bills run cleanly through July; August has not been imported yet. The old
  // rule compared nextExpected against today and fired once per subscription.
  const tx = []
  ;['NETFLIX', 'SPOTIFY', 'סלקום', 'חוג שחייה', 'ביטוח בריאות', 'חדר כושר'].forEach((v, i) => {
    for (let m = 1; m <= 7; m++) tx.push({ id: `${i}-${m}`, type: 'expense', accountId: 'cc', date: d(2026, m, 3 + i), vendor: v, amount: -(50 + i * 40) })
  })
  assert.equal(countOf(detect(tx).alerts, 'missing-recurring'), 0)
})

test('a bill genuinely absent from an imported month does report', () => {
  const tx = []
  for (let m = 1; m <= 8; m++) {
    tx.push({ id: 'n' + m, type: 'expense', accountId: 'cc', date: d(2026, m, 3), vendor: 'NETFLIX', amount: -54.9 })
    if (m < 8) tx.push({ id: 'gym' + m, type: 'expense', accountId: 'cc', date: d(2026, m, 4), vendor: 'חדר כושר', amount: -250 })
    // ordinary activity, so the account's data demonstrably covers the due date
    for (let i = 0; i < 3; i++) tx.push({ id: `q${m}-${i}`, type: 'expense', accountId: 'cc', date: d(2026, m, 6 + i * 3), vendor: 'שופרסל', amount: -(180 + i * 20), categoryId: 'food' })
  }
  // August data runs to the 12th; the gym charge simply never arrived.
  const { alerts } = detect(tx)
  assert.ok(alerts.some(a => a.rule === 'missing-recurring' && a.vendor.includes('כושר')),
    `expected the missing gym charge, got ${JSON.stringify(alerts.map(a => [a.rule, a.vendor]))}`)
})

test('category spike needs a real baseline, not one prior month', () => {
  const tx = []
  for (let m = 1; m <= 8; m++) tx.push({ id: 'b' + m, type: 'expense', accountId: 'chk', date: d(2026, m, 1), vendor: 'בסיס', amount: -500, categoryId: 'food' })
  tx.push({ id: 'r1', type: 'expense', accountId: 'chk', date: d(2026, 5, 4), vendor: 'מוסך', amount: -300, categoryId: 'car' })
  tx.push({ id: 'r2', type: 'expense', accountId: 'chk', date: d(2026, 8, 4), vendor: 'מוסך אחר', amount: -900, categoryId: 'car' })
  assert.equal(countOf(detect(tx).alerts, 'category-spike'), 0)
})

test('category spike sees credit-card spending', () => {
  // It ran on the P&L scope (checking + cash), so for a card-paying household
  // it was reading almost nothing. The dashboard breakdown uses analysis scope.
  const tx = []
  for (let m = 1; m <= 7; m++)
    for (let i = 0; i < 4; i++) tx.push({ id: `f${m}${i}`, type: 'expense', accountId: 'cc', date: d(2026, m, 2 + i * 5), vendor: 'מסעדה ' + i, amount: -250, categoryId: 'fun' })
  for (let i = 0; i < 10; i++) tx.push({ id: 'x' + i, type: 'expense', accountId: 'cc', date: d(2026, 8, 1 + i), vendor: 'בילוי ' + i, amount: -400, categoryId: 'fun' })
  const { alerts } = detect(tx)
  assert.ok(alerts.some(a => a.rule === 'category-spike'),
    `expected a category spike on card spending, got ${JSON.stringify(rules(alerts))}`)
})

test('one transaction yields one alert, chosen by confidence', () => {
  const { alerts } = detect(household())
  const ids = alerts.filter(a => a.txId).map(a => a.txId)
  assert.equal(ids.length, new Set(ids).size, 'a transaction was reported by two rules at once')
  for (let i = 1; i < alerts.length; i++) assert.ok(alerts[i - 1].confidence >= alerts[i].confidence, 'alerts are not ordered by confidence')
})

test('the card and review sheet render, and bulk dismiss clears the list', () => {
  // ANOM_reviewKeys carries {key, muteKey} pairs now; a plain-string leftover
  // would only surface as a silent no-op when the user taps "all fine".
  const el = { innerHTML: '' }
  const { ctx } = detect(household(), { dom: { addEventListener: () => {}, getElementById: () => el, querySelectorAll: () => [] } })
  const card = ctx.ANOM_cardHTML()
  assert.match(card, /עסקאות לבדיקה/)
  assert.match(card, /ANOM_dismissIdx/)

  ctx.ANOM_renderReviewBody()
  assert.match(el.innerHTML, /התראות/)
  const before = ctx._eval('ANOM_detect()').length
  assert.ok(before > 0)
  ctx.ANOM_dismissAllReview()
  assert.equal(ctx._eval('ANOM_detect()').length, 0, 'bulk dismiss left alerts behind')
})

test('dismissing the same rule for the same vendor twice mutes it', () => {
  const tx = []
  for (let m = 1; m <= 40; m++)
    tx.push({ id: 'n' + m, type: 'expense', accountId: 'cc', date: d(2025, 1 + ((m - 1) % 12), 1 + (m % 25)), vendor: 'ספק ' + (m % 7), amount: -(80 + m * 3) })
  tx.push({ id: 'z1', type: 'expense', accountId: 'cc', date: d(2026, 8, 6), vendor: 'חנות אלקטרוניקה', amount: -4300 })
  tx.push({ id: 'z2', type: 'expense', accountId: 'cc', date: d(2026, 8, 7), vendor: 'חנות אלקטרוניקה', amount: -4300 })

  const { ctx, alerts } = detect(tx)
  const a = alerts.find(x => x.rule === 'dup')
  assert.ok(a)
  const muteKey = ctx._eval('_anomMuteKey')(a)
  assert.ok(muteKey, 'an alert must carry a vendor-level mute key')

  ctx.ANOM_dismiss(a.key, muteKey)                       // first dismissal: this row only
  assert.equal(ctx._eval('(() => { ANOM_CONFIG.maxShow = 1e5; return ANOM_detect() })()')
    .filter(x => x.rule === 'dup' && x.vendorKey === a.vendorKey).length, 0, 'the dismissed row came back')

  ctx.ANOM_dismiss('dup:someOtherRow', muteKey)          // second: the rule is wrong here
  const mutes = ctx.getAnomVendorMutes()
  assert.equal(mutes[muteKey], 2)
  assert.ok(ctx.ANOM_muteCount() >= 1)
})
