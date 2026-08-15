// ===== SUSPICIOUS / ANOMALOUS TRANSACTIONS =====
// Globals prefixed ANOM_. Read-only over the existing data layer (never touches
// P&L). Loads after recurring.js + insights.js. Surfaced as a dashboard card
// (desktop via INS_renderDashboard, mobile via M_renderDashboard) with an
// expandable review sheet. Dismissed alerts are remembered in localStorage.

// Every threshold here exists to keep PRECISION high. An alert the user has to
// dismiss is worse than no alert: it trains them to clear the list without
// reading it, and then the one real duplicate scrolls by unread. The corpora in
// tests/anomalies.test.mjs pin that trade-off — change a number here and a test
// that measures false positives on a realistic year of data will tell you what
// it cost.
const ANOM_CONFIG = {
  recentDays: 35,        // most rules only flag activity within this window
  warmupDays: 60,        // < this much history => stay silent (a first import
                         // makes every vendor "new" and every month a "spike")
  minSamples: 30,        // population size before percentile rules mean anything

  // duplicates
  dupNearDays: 3,
  dupMinAmount: 60,      // below this, a repeat is a habit (coffee), not fraud
  dupPriorRepeats: 2,    // vendor already did this N times => it's their pattern

  // large expense
  largePctile: 0.99,     // robust replacement for mean + 3*std
  largeFloor: 800,
  knownBillTol: 0.15,    // ±this of a past charge counts as "the same bill"
  knownBillMin: 3,       // seen at that size N times => an expected bill

  // recurring spike / creep
  minOcc: 4,
  spikePct: 0.30,
  spikeMinDelta: 30,     // +10% of a ₪55 subscription is ₪5.50, not news
  spikeMadMult: 3,       // must also clear the entry's own volatility
  spikeMaxRatio: 3,      // beyond this it isn't a price rise, it's another kind
                         // of purchase at the same merchant — say so honestly
  creepPct: 0.25,
  creepMinOcc: 6,

  // vendor spike
  vendorSpikeX: 2,
  vendorSpikeMadMult: 3,
  vendorSpikeMinDelta: 150,
  vendorSpikeMaxCv: 0.5, // MAD/median above this = a variable vendor, skip

  // dormant
  dormantDays: 120,
  dormantMinOcc: 3,
  dormantGapMult: 3,     // gap must break the vendor's OWN rhythm

  // new vendor
  newVendorPctile: 0.95,
  newVendorFloor: 500,

  // periodic
  catSpikePct: 0.5,
  catSpikeMinDelta: 200,
  catBaseMonths: 6,
  catMinMonths: 3,       // need this many non-zero months to have a baseline
  catSingleTxShare: 0.6, // one charge carrying the overage = a big purchase,
                         // not a category trending up
  freqMinRatio: 0.5,     // the extra charge must be a real one, not a top-up
  missingGraceDays: 3,
  missingMinOcc: 4,
  newRecurringMaxAgeDays: 180,

  // surfacing
  minConfidence: 0.55,
  vendorMuteAfter: 2,    // dismissed this rule+vendor N times => stop asking
  cardPreview: 3,
  maxShow: 25,
}

// ===== dismiss state =====
function getDismissedAnomalies() { return new Set(DB.get('finDismissedAnomalies', [])) }
function setDismissedAnomalies(s) { DB.set('finDismissedAnomalies', [...s]) }

// Dismissing one row says "this row is fine". Dismissing the SAME rule for the
// SAME vendor twice says "this rule is wrong about this vendor" — so we stop
// re-asking every month with a fresh txId. Counted rather than immediate, so a
// single genuine duplicate at a vendor doesn't blind us to the next one.
function getAnomVendorMutes() { return DB.getObj('finAnomVendorMutes', {}) }
function setAnomVendorMutes(o) { DB.set('finAnomVendorMutes', o) }
function _anomMuteKey(a) { return a && a.vendorKey ? `${a.rule}:${a.vendorKey}` : '' }
function ANOM_resetMutes() {
  DB.set('finAnomVendorMutes', {})
  DB.set('finDismissedAnomalies', [])
  if (typeof toast === 'function') toast('ההשתקות אופסו')
  if (ANOM_reviewSheet) ANOM_renderReviewBody()
  if (typeof renderDashboard === 'function') renderDashboard()
}
function ANOM_muteCount() { return Object.keys(getAnomVendorMutes()).filter(k => getAnomVendorMutes()[k] >= ANOM_CONFIG.vendorMuteAfter).length }

let ANOM_reviewSheet = null
let ANOM_reviewKeys = []

function ANOM_dismiss(key, muteKey) {
  const s = getDismissedAnomalies()
  s.add(key)
  setDismissedAnomalies(s)
  if (muteKey) {
    const m = getAnomVendorMutes()
    m[muteKey] = (m[muteKey] || 0) + 1
    setAnomVendorMutes(m)
  }
  if (typeof UK_haptic === 'function') UK_haptic('tap')
  if (ANOM_reviewSheet) ANOM_renderReviewBody()
  if (typeof renderDashboard === 'function') renderDashboard()
}

function ANOM_dismissAllReview() {
  const s = getDismissedAnomalies()
  const m = getAnomVendorMutes()
  ANOM_reviewKeys.forEach(({ key, muteKey }) => {
    s.add(key)
    if (muteKey) m[muteKey] = (m[muteKey] || 0) + 1
  })
  setAnomVendorMutes(m)
  setDismissedAnomalies(s)
  if (typeof UK_haptic === 'function') UK_haptic('success')
  if (ANOM_reviewSheet) { ANOM_reviewSheet.close(); ANOM_reviewSheet = null }
  if (typeof renderDashboard === 'function') renderDashboard()
}

// ===== helpers =====
function _anomDays(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000) }
function _anomMedian(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
// Median absolute deviation. Used everywhere a spike is judged, because the
// mean/std pair this file used to rely on is not usable here: transaction
// amounts are heavily right-skewed, so a handful of large bills drag the mean
// up and inflate std until "mean + 3*std" says nothing about whether THIS
// charge is odd. MAD is unmoved by the tail.
function _anomMad(arr, med) {
  if (!arr.length) return 0
  const m = (med === undefined) ? _anomMedian(arr) : med
  return _anomMedian(arr.map(v => Math.abs(v - m)))
}
function _anomPctile(arr, p) {
  if (!arr.length) return Infinity
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]
}
// Median gap between consecutive dates — a vendor's own rhythm.
function _anomMedianGap(dates) {
  if (dates.length < 2) return 0
  const gaps = []
  for (let i = 1; i < dates.length; i++) gaps.push(_anomDays(dates[i - 1], dates[i]))
  return _anomMedian(gaps.filter(g => g > 0))
}
const _ANOM_SEV_RANK = { high: 0, med: 1, low: 2 }
function _anomSev(conf) { return conf >= 0.8 ? 'high' : conf >= 0.62 ? 'med' : 'low' }

// ===== detection =====
// Shared pre-pass. Every rule reads candidates from here so the exclusions are
// stated once instead of drifting apart rule by rule (which is how savings
// deposits ended up being reported as suspicious purchases).
function _anomContext() {
  const all = (typeof getTransactions === 'function') ? getTransactions() : []
  const ccDetail = (typeof ccAccountsWithDetail === 'function') ? ccAccountsWithDetail(all) : new Set()
  const isLump = t => (typeof shouldDropCcLump === 'function') ? shouldDropCcLump(t, ccDetail) : false

  // What can be "a suspicious charge" at all. Excluded, and why:
  //  - transfer / CC lump / refund: not a purchase (a refund's absolute value
  //    used to make an incoming credit look like a big spend).
  //  - transferAccountId / ccPaymentForAccountId: mirror rows for money moving
  //    between the user's own accounts. They ARE expenses in P&L, but a ₪25,000
  //    deposit into savings is not an unfamiliar merchant. detectRecurring has
  //    always excluded them; this file didn't, and that was the bug.
  const candidates = all
    .filter(t => t.amount < 0 && t.type !== 'transfer' && t.type !== 'refund' && !isLump(t)
      && !t.transferAccountId && !t.ccPaymentForAccountId)
    .map(t => ({
      t, key: _txVendorKey(t), abs: Math.abs(t.amount), date: t.date || '',
      m: getTxEffectiveMonth(t),
      inst: !!(t.installmentCurrent || t.installmentTotal),
    }))
    .filter(x => x.key && x.date)
    .sort((a, b) => a.date.localeCompare(b.date))

  const groups = {}
  for (const x of candidates) (groups[x.key] = groups[x.key] || []).push(x)

  // How far each account's data actually reaches. A rule that asserts something
  // is MISSING may only speak for a period the data covers — otherwise every
  // bill looks unpaid in the window between the 1st and the day you import.
  const accountThrough = {}
  for (const t of all) {
    if (!t.date) continue
    const a = t.accountId || ''
    if (!accountThrough[a] || t.date > accountThrough[a]) accountThrough[a] = t.date
  }

  const now = new Date()
  const firstDate = candidates.length ? candidates[0].date : ''
  return {
    all, candidates, groups, accountThrough, ccDetail, now,
    curMonth: _ym(now),
    todayIso: _iso(now),
    recentCut: _iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ANOM_CONFIG.recentDays)),
    yearCut: _iso(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())),
    // A fresh install importing three years of history at once would otherwise
    // report every vendor in the last 35 days as new and every bill as a spike.
    warm: !!firstDate && _anomDays(firstDate, _iso(now)) >= ANOM_CONFIG.warmupDays,
  }
}

function ANOM_detect() {
  if (typeof getTransactions !== 'function') return []
  const C = _anomContext()
  const dismissed = getDismissedAnomalies()
  const mutes = getAnomVendorMutes()
  const out = []
  if (!C.warm) return out

  const { candidates, groups, recentCut, curMonth, todayIso } = C
  const byId = new Map(candidates.map(x => [x.t.id, x]))
  const vendorOf = t => (typeof resolveVendor === 'function'
    ? resolveVendor(t.vendor, t.amount, (typeof getTxAliasDay === 'function' ? getTxAliasDay(t) : undefined))
    : t.vendor) || t.vendor || '—'
  const recent = x => x.date >= recentCut

  const recurring = (typeof getAllRecurring === 'function')
    ? (() => { try { return getAllRecurring() } catch (e) { return [] } })() : []
  const recurringKeys = new Set(recurring.map(r => r.sourceKey).filter(Boolean))
  // The rows the recurring entry was actually built from. Falling back to the
  // raw vendor group (what this used to do) hands back the outliers and the
  // user's explicit opt-outs that detectRecurring had just filtered away, and
  // then reports them as "+1467% jump in a fixed expense".
  const entryTxs = r => {
    if (Array.isArray(r.memberIds)) return r.memberIds.map(id => byId.get(id)).filter(Boolean)
    if (r.key && String(r.key).startsWith('mgroup:')) return candidates.filter(x => x.t.recurringGroupId === r.groupId)
    return (groups[r.sourceKey] || []).filter(x => !x.t.recurringExcludeFromAuto)
  }
  // Members are the BASELINE; this is the ACTIVITY. The two are not the same
  // question and using members for both is a trap in each direction: the ±20%
  // filter that keeps the baseline clean also hides the charge that broke the
  // pattern (a subscription doubling in price is never a member), and it makes
  // a bill that did arrive look absent.
  const entryActivity = r => {
    if (r.key && String(r.key).startsWith('mgroup:')) return candidates.filter(x => x.t.recurringGroupId === r.groupId)
    const g = (groups[r.sourceKey] || []).filter(x => !x.t.recurringExcludeFromAuto)
    return r.source === 'installment' ? g : g.filter(x => !x.inst)
  }

  // One alert per transaction, resolved by confidence rather than by which rule
  // happens to run first.
  const perTx = new Map()
  const add = (a) => {
    a.severity = _anomSev(a.confidence)
    if (!a.txId) { out.push(a); return }
    const prev = perTx.get(a.txId)
    if (prev && prev.confidence >= a.confidence) return
    if (prev) out.splice(out.indexOf(prev), 1)
    perTx.set(a.txId, a)
    out.push(a)
  }

  // ---- DUPLICATES ----
  // A real double charge is the same merchant billing the identical amount
  // again within a couple of days. Three things had to go: the "same billing
  // month" arm (13 of 16 alerts on a realistic year, all of them one ₪18
  // coffee), shekel-rounded comparison, and the blindness to instalment plans —
  // six rows of one plan share a purchase date and an amount, which read as
  // five high-severity duplicates.
  for (const k of Object.keys(groups)) {
    const list = groups[k]
    const flaggedMonths = new Set()
    // How often identical-amount repeats are simply what this vendor does.
    let habit = 0
    for (let i = 1; i < list.length; i++) {
      if (Math.round(list[i - 1].abs * 100) === Math.round(list[i].abs * 100)
        && _anomDays(list[i - 1].date, list[i].date) <= ANOM_CONFIG.dupNearDays) habit++
    }
    if (habit >= ANOM_CONFIG.dupPriorRepeats) continue
    for (let i = 1; i < list.length; i++) {
      const cur = list[i]
      if (!recent(cur) || cur.abs < ANOM_CONFIG.dupMinAmount || cur.inst) continue
      if (flaggedMonths.has(cur.m)) continue
      for (let j = i - 1; j >= 0; j--) {
        const prev = list[j]
        const gap = _anomDays(prev.date, cur.date)
        if (gap > ANOM_CONFIG.dupNearDays) break
        if (prev.inst) continue
        if (Math.round(prev.abs * 100) !== Math.round(cur.abs * 100)) continue
        // One purchase split across billing cycles (an instalment plan whose
        // rows carry no index, a deferred charge) repeats the date, not the
        // bill. A true duplicate lands on the same statement.
        if (prev.date === cur.date && prev.m !== cur.m) continue
        flaggedMonths.add(cur.m)
        add({
          key: `dup:${cur.t.id}`, rule: 'dup', txId: cur.t.id, vendorKey: k,
          confidence: gap === 0 ? 0.9 : 0.85,
          vendor: vendorOf(cur.t), amount: cur.t.amount, date: cur.date,
          title: 'ייתכן חיוב כפול',
          detail: gap === 0 ? 'אותו סכום בדיוק פעמיים באותו יום' : `אותו סכום בדיוק שוב תוך ${gap} ימים`,
        })
        break
      }
    }
  }

  // ---- LARGE EXPENSE ----
  // Two gates, and the second one is the point: an amount can only be surprising
  // if it is also unusual FOR THIS VENDOR. A ₪6,200 mortgage paid 18 months
  // running was clearing "mean + 3*std" every single month and explaining
  // itself against the average of every ₪18 coffee in the file.
  ;(() => {
    const yearAmts = candidates.filter(x => x.date >= C.yearCut).map(x => x.abs)
    if (yearAmts.length < ANOM_CONFIG.minSamples) return
    const p99 = _anomPctile(yearAmts, ANOM_CONFIG.largePctile)
    for (const x of candidates) {
      if (!recent(x) || x.abs <= p99 || x.abs < ANOM_CONFIG.largeFloor) continue
      const prior = (groups[x.key] || []).filter(y => y.date < x.date)
      const known = prior.filter(y => Math.abs(y.abs - x.abs) <= x.abs * ANOM_CONFIG.knownBillTol).length
      if (known >= ANOM_CONFIG.knownBillMin) continue         // an expected bill of this size
      const med = _anomMedian(prior.map(y => y.abs))
      add({
        key: `large-expense:${x.t.id}`, rule: 'large-expense', txId: x.t.id, vendorKey: x.key,
        confidence: prior.length ? 0.7 : 0.78,
        vendor: vendorOf(x.t), amount: x.t.amount, date: x.date,
        title: 'הוצאה חריגה בגודלה',
        detail: prior.length
          ? `הרגיל אצל הספק הזה כ-${formatCurrencyPlain(med)}`
          : `מעל 99% מהחיובים בשנה האחרונה (${formatCurrencyPlain(p99)})`,
      })
    }
  })()

  // ---- RECURRING SPIKE + PRICE CREEP ----
  for (const r of recurring) {
    if ((r.avgAmount || 0) >= 0) continue          // expense entries only
    const members = entryTxs(r)
    if (members.length < ANOM_CONFIG.minOcc) continue
    const act = entryActivity(r)
    const last = act[act.length - 1]
    const avg = Math.abs(r.avgAmount)
    if (last && recent(last)) {
      const priorAmts = members.filter(x => x.t.id !== last.t.id).map(x => x.abs)
      const med = _anomMedian(priorAmts)
      const mad = _anomMad(priorAmts, med)
      // The percentage is measured against the user-facing average (which honours
      // amount overrides); the MAD gate is what keeps a genuinely lumpy bill —
      // electricity, water — from firing every single cycle.
      const overAvg = avg > 0 && last.abs > avg * (1 + ANOM_CONFIG.spikePct)
        && (last.abs - avg) >= ANOM_CONFIG.spikeMinDelta
      const overOwnNoise = last.abs > med + ANOM_CONFIG.spikeMadMult * mad
      // Netflix going 55 -> 100 is a price rise. A ₪940 charge against a ₪60
      // subscription is not the subscription at all — let large-expense or
      // vendor-spike describe it, under a title that is actually true.
      const plausibleRise = avg > 0 && last.abs <= avg * ANOM_CONFIG.spikeMaxRatio
      if (overAvg && overOwnNoise && plausibleRise) {
        const pct = Math.round((last.abs / avg - 1) * 100)
        add({
          key: `recurring-spike:${last.t.id}`, rule: 'recurring-spike', txId: last.t.id, vendorKey: r.sourceKey || r.key,
          confidence: 0.72,
          vendor: r.vendor, amount: last.t.amount, date: last.date,
          title: 'קפיצה בהוצאה קבועה', detail: `+${pct}% מהממוצע (${formatCurrencyPlain(avg)})`,
        })
        continue
      }
    }
    const mLast = members[members.length - 1]
    if (recent(mLast) && members.length >= ANOM_CONFIG.creepMinOcc) {
      const half = Math.floor(members.length / 2)
      const om = _anomMedian(members.slice(0, half).map(x => x.abs))
      const nm = _anomMedian(members.slice(half).map(x => x.abs))
      if (om > 0 && nm > om * (1 + ANOM_CONFIG.creepPct)) {
        add({
          key: `price-creep:${mLast.t.id}`, rule: 'price-creep', txId: mLast.t.id, vendorKey: r.sourceKey || r.key,
          confidence: 0.6,
          vendor: r.vendor, amount: mLast.t.amount, date: mLast.date,
          title: 'התייקרות הדרגתית', detail: `עלה ~${Math.round((nm / om - 1) * 100)}% לאורך זמן`,
        })
      }
    }
  }

  // ---- VENDOR SPIKE — non-recurring vendor, charge far above its own norm ----
  // "> 2x median" alone flags a big stock-up at the supermarket. A vendor whose
  // amounts scatter that widely has no norm to break, so it is skipped outright.
  for (const k of Object.keys(groups)) {
    if (recurringKeys.has(k)) continue
    const list = groups[k]
    if (list.length < ANOM_CONFIG.minOcc) continue
    const last = list[list.length - 1]
    if (!recent(last) || last.inst) continue
    const priorAmts = list.slice(0, -1).map(x => x.abs)
    const med = _anomMedian(priorAmts)
    if (med <= 0) continue
    const mad = _anomMad(priorAmts, med)
    if (mad / med > ANOM_CONFIG.vendorSpikeMaxCv) continue
    if (last.abs > med * ANOM_CONFIG.vendorSpikeX
      && last.abs > med + ANOM_CONFIG.vendorSpikeMadMult * mad
      && (last.abs - med) >= ANOM_CONFIG.vendorSpikeMinDelta) {
      add({
        key: `vendor-spike:${last.t.id}`, rule: 'vendor-spike', txId: last.t.id, vendorKey: k,
        confidence: 0.68,
        vendor: vendorOf(last.t), amount: last.t.amount, date: last.date,
        title: 'גבוה מהרגיל לספק', detail: `החיוב הטיפוסי כ-${formatCurrencyPlain(med)}`,
      })
    }
  }

  // ---- DORMANT vendor returns ----
  // Only when the gap breaks the vendor's OWN rhythm. Annual car insurance
  // returning after twelve months is on schedule, not dormant, and a shop
  // visited twice ever has no rhythm to break.
  for (const k of Object.keys(groups)) {
    const list = groups[k]
    if (list.length < ANOM_CONFIG.dormantMinOcc + 1) continue
    const last = list[list.length - 1], prev = list[list.length - 2]
    if (!recent(last)) continue
    const gap = _anomDays(prev.date, last.date)
    const rhythm = _anomMedianGap(list.slice(0, -1).map(x => x.date))
    if (gap <= ANOM_CONFIG.dormantDays) continue
    if (rhythm > 0 && gap <= rhythm * ANOM_CONFIG.dormantGapMult) continue
    add({
      key: `dormant:${last.t.id}`, rule: 'dormant', txId: last.t.id, vendorKey: k,
      confidence: 0.6,
      vendor: vendorOf(last.t), amount: last.t.amount, date: last.date,
      title: 'ספק חזר אחרי הפסקה', detail: `לא היה חיוב כ-${Math.round(gap / 30)} חודשים`,
    })
  }

  // ---- NEW vendor ----
  // A first charge at an unfamiliar merchant is ordinary life — ten of them a
  // month is a normal household, and no bank treats "new merchant" as a signal
  // on its own. It only earns a row when the amount is also large for this user.
  ;(() => {
    const yearAmts = candidates.filter(x => x.date >= C.yearCut).map(x => x.abs)
    if (yearAmts.length < ANOM_CONFIG.minSamples) return
    const bar = Math.max(_anomPctile(yearAmts, ANOM_CONFIG.newVendorPctile), ANOM_CONFIG.newVendorFloor)
    for (const k of Object.keys(groups)) {
      const first = groups[k][0]
      if (first.date < recentCut || first.abs < bar || first.inst) continue
      add({
        key: `new-vendor:${first.t.id}`, rule: 'new-vendor', txId: first.t.id, vendorKey: k,
        confidence: 0.65,
        vendor: vendorOf(first.t), amount: first.t.amount, date: first.date,
        title: 'חיוב ראשון מספק חדש', detail: 'לא היה חיוב מספק זה, והסכום גבוה יחסית',
      })
    }
  })()

  // ---- NEW recurring detected ----
  for (const r of recurring) {
    if (r.source !== 'auto' || (r.avgAmount || 0) >= 0) continue
    if (r.occurrences >= 3 && r.occurrences <= 5 && r.lastSeen >= recentCut) {
      // `occurrences` counts MEMBERS, and the ±20%-of-median filter can whittle
      // a lumpy two-year-old water bill down to four of them. Newness is a fact
      // about when the vendor first appeared, so ask that instead.
      const act = entryActivity(r)
      if (act.length && _anomDays(act[0].date, todayIso) > ANOM_CONFIG.newRecurringMaxAgeDays) continue
      const txs = entryTxs(r)
      const last = txs[txs.length - 1]
      add({
        key: `new-recurring:${r.key}`, rule: 'new-recurring',
        txId: last ? last.t.id : undefined, nav: 'recurring', vendorKey: r.sourceKey || r.key,
        confidence: 0.58,
        vendor: r.vendor, amount: r.avgAmount, date: r.lastSeen,
        title: 'מנוי/הוצאה קבועה חדשה', detail: `זוהתה כקבועה (${r.cadenceLabel})`,
      })
    }
  }

  // ---- FREQUENCY anomaly — monthly vendor charged twice this month ----
  for (const r of recurring) {
    if (r.cadence !== 'monthly') continue
    const txs = entryTxs(r)
    const inCur = txs.filter(x => x.m === curMonth && !x.inst)
    if (inCur.length < 2) continue
    const typical = _anomMedian(txs.map(x => x.abs))
    const extra = inCur[inCur.length - 1]
    if (typical > 0 && extra.abs < typical * ANOM_CONFIG.freqMinRatio) continue
    add({
      key: `freq:${r.sourceKey || r.key}:${curMonth}`, rule: 'freq', txId: extra.t.id,
      vendorKey: r.sourceKey || r.key, confidence: 0.66,
      vendor: r.vendor, amount: extra.t.amount, date: extra.date,
      title: 'חויב יותר מהרגיל', detail: `${inCur.length} חיובים החודש (בד״כ פעם בחודש)`,
    })
  }

  // ---- MISSING expected recurring ----
  // Gated on the data, not on the calendar. Before this, the days between the
  // due date and the day you import the statement produced one "missing bill"
  // alert per subscription, all at once.
  for (const r of recurring) {
    if ((r.avgAmount || 0) >= 0) continue
    if ((r.occurrences || 0) < ANOM_CONFIG.missingMinOcc) continue
    const act = entryActivity(r)
    if (!act.length || act.some(x => x.m === curMonth)) continue
    // Due date derived from the last charge that actually happened. `nextExpected`
    // is anchored to the last MEMBER, so on a lumpy bill it can sit months in the
    // past while the bill has been arriving on time all along.
    const cad = r.cadenceDays || 30
    const lastActual = act[act.length - 1].date
    const due = _addDays(lastActual, cad)
    const since = _anomDays(lastActual, todayIso)
    if (since <= cad + ANOM_CONFIG.missingGraceDays) continue
    // Absent for more than one cycle: the subscription ended. Saying "missing"
    // every month from here on is a permanent row nobody can ever clear.
    if (since > cad * 2 + ANOM_CONFIG.missingGraceDays) continue
    const through = C.accountThrough[r.accountId || ''] || ''
    if (!through || _anomDays(due, through) < ANOM_CONFIG.missingGraceDays) continue
    add({
      key: `missing-recurring:${r.key}:${curMonth}`, rule: 'missing-recurring',
      nav: 'recurring', vendorKey: r.sourceKey || r.key, confidence: 0.6,
      vendor: r.vendor, amount: r.avgAmount, date: due,
      title: 'חיוב קבוע צפוי שחסר', detail: `היה אמור להופיע ~${formatDate(due)}`,
    })
  }

  // ---- CATEGORY spike ----
  // Uses the ANALYSIS scope, matching the category breakdown the user actually
  // sees on the dashboard. The P&L scope it used before is checking+cash only,
  // so for a household that pays by card this rule was reading almost nothing —
  // and then calling a second garage visit "+800%" off a one-month baseline.
  ;(() => {
    if (typeof analysisExpenseAmount !== 'function') return
    const savingsInvestIds = (typeof analysisExpenseSavingsInvestIds === 'function')
      ? analysisExpenseSavingsInvestIds() : new Set()
    const byCatMonth = {}
    const biggestThisMonth = {}
    for (const t of C.all) {
      const amt = analysisExpenseAmount(t, savingsInvestIds, C.ccDetail)
      if (!amt) continue
      const m = getTxEffectiveMonth(t); if (!m) continue
      const c = (typeof analysisCatKey === 'function') ? analysisCatKey(t) : (t.categoryId || '__none__')
      byCatMonth[c] = byCatMonth[c] || {}
      byCatMonth[c][m] = (byCatMonth[c][m] || 0) + amt
      if (m === curMonth && amt > (biggestThisMonth[c] || 0)) biggestThisMonth[c] = amt
    }
    const baseMonths = []
    for (let d = 1; d <= ANOM_CONFIG.catBaseMonths; d++) baseMonths.push(_ym(new Date(C.now.getFullYear(), C.now.getMonth() - d, 1)))
    for (const c of Object.keys(byCatMonth)) {
      const cur = byCatMonth[c][curMonth] || 0
      if (cur <= 0) continue
      const vals = baseMonths.map(m => byCatMonth[c][m] || 0).filter(v => v > 0)
      if (vals.length < ANOM_CONFIG.catMinMonths) continue   // no baseline to speak of
      const base = _anomMedian(vals)
      if (base <= 0) continue
      // One annual insurance premium does not mean the car category is trending
      // up — it means you bought one big thing, which the per-transaction rules
      // already cover. A category alert should describe broad drift.
      if ((biggestThisMonth[c] || 0) >= (cur - base) * ANOM_CONFIG.catSingleTxShare) continue
      if (cur > base * (1 + ANOM_CONFIG.catSpikePct) && (cur - base) >= ANOM_CONFIG.catSpikeMinDelta) {
        const cat = (typeof getCategoryById === 'function') ? getCategoryById(c) : null
        add({
          key: `category-spike:${c}:${curMonth}`, rule: 'category-spike', confidence: 0.57,
          navCat: c === '__none__' ? '' : c, vendorKey: `cat:${c}`,
          vendor: cat ? cat.name : 'לא מסווג', amount: -cur, date: todayIso,
          title: 'הוצאה גבוהה בקטגוריה', detail: `+${Math.round((cur / base - 1) * 100)}% מהחציון של ${vals.length} חודשים`,
        })
      }
    }
  })()

  return out
    .filter(a => a.confidence >= ANOM_CONFIG.minConfidence)
    .filter(a => !dismissed.has(a.key))
    .filter(a => (mutes[_anomMuteKey(a)] || 0) < ANOM_CONFIG.vendorMuteAfter)
    .sort((a, b) => (b.confidence - a.confidence)
      || (_ANOM_SEV_RANK[a.severity] - _ANOM_SEV_RANK[b.severity])
      || b.date.localeCompare(a.date))
    .slice(0, ANOM_CONFIG.maxShow)
}

// ===== AI double-check =====
async function ANOM_askAI() {
  const apiKey = (typeof getApiKey === 'function') ? getApiKey() : null
  if (!apiKey) { if (typeof toast === 'function') toast('חסר מפתח Gemini API – הזן בהגדרות', { type: 'error' }); return }
  const resultEl = document.getElementById('anomAIResult')
  if (resultEl) resultEl.innerHTML = `<div class="anom-ai-loading">${uiIcon('clock', 14)} בודק עם AI…</div>`
  const list = ANOM_detect()
  if (!list.length) { if (resultEl) resultEl.innerHTML = ''; return }
  const allTx = (typeof getTransactions === 'function') ? getTransactions() : []
  // The vendor's real history, matched on the SAME normalized key the detector
  // grouped by. Matching on the first word of the display name (what this did
  // before) is near-useless in Hebrew, where that word is usually generic:
  // "מסעדת הדג הכחול" pulled in four unrelated restaurants and handed them to
  // the model as this vendor's past. The model then reasoned confidently about
  // history that never happened — which is what read as hallucination.
  const lines = list.slice(0, 20).map(a => {
    const peers = a.vendorKey && typeof _txVendorKey === 'function'
      ? allTx.filter(t => t.date < a.date && t.id !== a.txId && _txVendorKey(t) === a.vendorKey)
      : []
    const amts = peers.filter(t => t.amount < 0).map(t => Math.abs(t.amount))
    const history = peers
      .sort((x, y) => y.date.localeCompare(x.date))
      .slice(0, 6)
      .map(t => `    ${t.date}: ${t.amount > 0 ? '+' : ''}${t.amount} ₪`)
      .join('\n')
    const stat = amts.length
      ? `\n  אצל הספק הזה: ${amts.length} חיובים קודמים, חציון ${Math.round(_anomMedian(amts))} ₪`
      : '\n  אין ולו חיוב קודם אחד מהספק הזה'
    return `• ${a.vendor} | ${a.date} | ${a.amount > 0 ? '+' : ''}${a.amount} ₪`
      + `\n  הכלל שהופעל: ${a.title} — ${a.detail}${stat}`
      + (history ? '\n  היסטוריה מלאה שיש לנו:\n' + history : '')
  }).join('\n\n')
  const prompt = `אתה מומחה לאבטחה פיננסית. להלן ${list.length > 20 ? 20 : list.length} עסקאות שמערכת כללים סימנה כחשודות.

חוקי עבודה מחייבים:
- הסתמך אך ורק על הנתונים שלמטה. אין לך שום מידע אחר על הספקים האלה.
- אל תשער מה הספק מוכר, מה גובה החיוב הרגיל שלו בשוק, או מה קרה בחיובים שלא מופיעים כאן.
- כשאין מספיק נתונים כדי להכריע — כתוב "ייתכן" ואמור מפורשות איזה מידע חסר.

פתח כל שורה באחת המילים בדיוק: "מוצדק" / "ייתכן" / "לא מוצדק" — ואז פסקה קצרה מדוע.
אל תשתמש באימוג'ים. ענה בעברית, תמציתי.

${lines}`
  try {
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } }
    const data = await (typeof callGemini === 'function' ? callGemini(apiKey, body) : Promise.reject(new Error('callGemini not available')))
    const allParts = data.candidates?.[0]?.content?.parts || []
    let text = ''
    for (const p of allParts) { if (!p.thought && p.text) { text = p.text; break } }
    if (!text) text = allParts.filter(p => !p.thought).map(p => p.text || '').join('')
    if (resultEl) resultEl.innerHTML = `<div class="anom-ai-result">${(typeof _insEsc === 'function' ? _insEsc(text) : text).replace(/\n/g, '<br>').replace(/(^|<br>)\s*(לא מוצדק|מוצדק|ייתכן)/g, '$1<b>$2</b>')}</div>`
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="anom-ai-error">שגיאת AI: ${err.message}</div>`
  }
}

// ===== rendering =====
// Anomaly keys/vendors can contain Hebrew/quotes that break inline onclick
// strings, so render-time we map a safe idx ('r0','r1'…) → anomaly and the
// handlers look it up (same pattern as recurring.js _recKeyMap).
const _ANOM_SEV_CLS = { high: 'sev-high', med: 'sev-med', low: 'sev-low' }
let ANOM_rowMap = {}

function ANOM_actIdx(idx) {
  const a = ANOM_rowMap[idx]; if (!a) return
  if (ANOM_reviewSheet) { ANOM_reviewSheet.close(); ANOM_reviewSheet = null }
  if (a.rule === 'category-spike') { ANOM_goToTxCategory(a.navCat, a.date); return }
  if (a.nav === 'recurring') { if (typeof navigate === 'function') navigate('recurring'); return }
  // vendor-based rules → show that vendor's transactions in the relevant month
  // (so duplicates / the flagged charge appear together in context).
  ANOM_goToTxVendor(a.vendor, a.date)
}
function ANOM_dismissIdx(idx) { const a = ANOM_rowMap[idx]; if (a) ANOM_dismiss(a.key, _anomMuteKey(a)) }

// Set the active period to the calendar month of `dateIso`.
function _anomSetMonth(dateIso) {
  if (!dateIso || typeof setActivePeriod !== 'function') return
  const [y, m] = dateIso.split('-').map(Number)
  if (!y || !m) return
  const pad = n => String(n).padStart(2, '0')
  const last = new Date(y, m, 0).getDate()
  setActivePeriod({ key: 'custom', label: `${pad(m)}/${y}`, start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}` })
}

function ANOM_goToTxVendor(vendor, dateIso) {
  _anomSetMonth(dateIso)
  if (typeof txSetReturnContext === 'function') txSetReturnContext({
    fromLabel: 'עסקאות לבדיקה', label: vendor || '',
    onBack: () => { if (typeof navigate === 'function') navigate('dashboard'); ANOM_openReview() },
  })
  if (typeof navigate === 'function') navigate('transactions')
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v }
  set('txSearch', vendor || '')
  set('txTypeFilter', 'all')
  ;['txAccountFilter', 'txCategoryFilter', 'txFlowFilter', 'txAmountMin', 'txAmountMax'].forEach(id => set(id, ''))
  if (typeof _txPage !== 'undefined') _txPage = 0
  if (typeof _drawTxTable === 'function') _drawTxTable()
}

function ANOM_goToTxCategory(catId, dateIso) {
  _anomSetMonth(dateIso)
  if (typeof txSetReturnContext === 'function') txSetReturnContext({
    fromLabel: 'עסקאות לבדיקה',
    onBack: () => { if (typeof navigate === 'function') navigate('dashboard'); ANOM_openReview() },
  })
  if (typeof goToTransactionsByCategory === 'function') goToTransactionsByCategory(catId || '__none__')
  else if (typeof navigate === 'function') navigate('transactions')
}

function _anomRowHTML(a, idx) {
  return `<div class="ins-anom-row" onclick="ANOM_actIdx('${idx}')">
    <span class="ins-anom-sev"><i class="sev-dot ${_ANOM_SEV_CLS[a.severity] || 'sev-low'}" title="חומרה: ${a.severity || 'low'}"></i></span>
    <div class="ins-anom-main">
      <div class="ins-anom-vendor">${_insEsc(a.vendor)} <span class="ins-anom-tag">${_insEsc(a.title)}</span></div>
      <div class="ins-anom-detail">${_insEsc(a.detail)} · ${formatDate(a.date)}</div>
    </div>
    <div class="ins-anom-side">
      <span class="ins-anom-amt expense-color">${formatCurrency(Math.abs(a.amount))}</span>
      <button class="ins-anom-ok" onclick="event.stopPropagation();ANOM_dismissIdx('${idx}')">תקין</button>
    </div>
  </div>`
}

function ANOM_cardHTML() {
  let list
  try { list = ANOM_detect() } catch (e) { return '' }
  if (!list.length) return ''
  list.forEach((a, i) => { ANOM_rowMap['c' + i] = a })   // 'c' prefix so it won't clobber the review map
  const n = list.length
  const more = n - ANOM_CONFIG.cardPreview
  const preview = list.slice(0, ANOM_CONFIG.cardPreview)
  return `<div class="card ins-anomalies">
    <div class="card-title ins-anom-titlerow" ${n > ANOM_CONFIG.cardPreview ? 'onclick="ANOM_openReview()"' : ''}>
      <span>${uiIcon('siren', 14)} עסקאות לבדיקה · ${n}</span>
      ${n > ANOM_CONFIG.cardPreview ? '<span class="ins-anom-expand">הצג הכל ›</span>' : ''}
    </div>
    ${preview.map((a, i) => _anomRowHTML(a, 'c' + i)).join('')}
    ${more > 0 ? `<button class="ins-anom-all" onclick="ANOM_openReview()">הצג עוד ${more} ›</button>` : ''}
  </div>`
}

// Rule → group, for the review filter.
const _ANOM_GROUPS = {
  'dup': 'dup',
  'new-vendor': 'new', 'new-recurring': 'new', 'dormant': 'new',
  'recurring-spike': 'spike', 'price-creep': 'spike', 'vendor-spike': 'spike', 'large-expense': 'spike',
  'category-spike': 'period', 'freq': 'period', 'missing-recurring': 'period',
}
const _ANOM_GROUP_LABELS = { all: 'הכל', dup: 'כפילויות', new: 'חדש', spike: 'קפיצות', period: 'תקופתי' }
let ANOM_reviewFilter = 'all'
function ANOM_setReviewFilter(g) { ANOM_reviewFilter = g; ANOM_renderReviewBody() }

function ANOM_renderInto(id) {
  const el = document.getElementById(id)
  if (el) el.innerHTML = ANOM_cardHTML()
}

// ===== review sheet (full list + bulk dismiss) =====
function ANOM_openReview() {
  if (typeof UK_sheet !== 'function') { return }
  ANOM_reviewFilter = 'all'
  ANOM_reviewSheet = UK_sheet({
    title: 'עסקאות לבדיקה',
    content: '<div id="anomReviewBody"></div>',
    onClose: () => { ANOM_reviewSheet = null; if (typeof renderDashboard === 'function') renderDashboard() },
  })
  ANOM_renderReviewBody()
}

function ANOM_renderReviewBody() {
  const body = document.getElementById('anomReviewBody')
  if (!body) return
  const full = ANOM_detect()
  if (!full.length) { body.innerHTML = '<div class="ins-inbox-done">אין עסקאות חשודות</div>'; return }
  // counts per group, for the filter chips
  const counts = { all: full.length }
  full.forEach(a => { const g = _ANOM_GROUPS[a.rule] || 'period'; counts[g] = (counts[g] || 0) + 1 })
  const chips = ['all', 'dup', 'new', 'spike', 'period']
    .filter(g => g === 'all' || counts[g])
    .map(g => `<button class="ins-anom-fchip ${ANOM_reviewFilter === g ? 'active' : ''}" onclick="ANOM_setReviewFilter('${g}')">${_ANOM_GROUP_LABELS[g]} ${counts[g] || 0}</button>`).join('')

  const list = ANOM_reviewFilter === 'all' ? full : full.filter(a => (_ANOM_GROUPS[a.rule] || 'period') === ANOM_reviewFilter)
  ANOM_reviewKeys = list.map(a => ({ key: a.key, muteKey: _anomMuteKey(a) }))
  list.forEach((a, i) => { ANOM_rowMap['v' + i] = a })   // 'v' prefix — separate from the card map
  const muted = ANOM_muteCount()
  body.innerHTML = `
    <div class="ins-anom-fchips">${chips}</div>
    <div class="ins-anom-reviewtop">
      <span>${list.length} התראות</span>
      <div style="display:flex;gap:.5rem">
        <button class="btn-ghost" onclick="ANOM_askAI()">בדוק עם AI</button>
        <button class="btn-ghost" onclick="ANOM_dismissAllReview()">סמן הכל כתקין</button>
      </div>
    </div>
    ${muted ? `<div class="ins-anom-muted-note">${muted} כללים מושתקים לספקים שסימנת כתקינים <button class="btn-ghost" onclick="ANOM_resetMutes()">אפס</button></div>` : ''}
    <div id="anomAIResult"></div>
    ${list.map((a, i) => _anomRowHTML(a, 'v' + i)).join('')}`
}
