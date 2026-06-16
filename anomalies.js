// ===== SUSPICIOUS / ANOMALOUS TRANSACTIONS =====
// Globals prefixed ANOM_. Read-only over the existing data layer (never touches
// P&L). Loads after recurring.js + insights.js. Surfaced as a dashboard card
// (desktop via INS_renderDashboard, mobile via M_renderDashboard) with an
// expandable review sheet. Dismissed alerts are remembered in localStorage.

const ANOM_CONFIG = {
  recentDays: 35,      // most rules only flag activity within this window
  dupNearDays: 4,      // same vendor+amount within N days = near-duplicate
  minOcc: 4,           // min history before calling something a spike
  spikePct: 0.10,      // recurring charge > avg * (1+this) => spike
  creepPct: 0.25,      // cumulative gradual rise threshold
  vendorSpikeX: 2,     // single charge > median * this => vendor spike
  dormantDays: 120,    // gap before a returning vendor is "dormant"
  catSpikePct: 0.5,    // category month total > 3mo avg * (1+this)
  catSpikeMinDelta: 200,
  largeStdMult: 3,     // |amount| > mean + this*std => unusually large
  cardPreview: 3,      // rows shown on the dashboard card
  maxShow: 40,         // hard cap on total alerts
}

// ===== dismiss state =====
function getDismissedAnomalies() { return new Set(DB.get('finDismissedAnomalies', [])) }
function setDismissedAnomalies(s) { DB.set('finDismissedAnomalies', [...s]) }

let ANOM_reviewSheet = null
let ANOM_reviewKeys = []

function ANOM_dismiss(key) {
  const s = getDismissedAnomalies()
  s.add(key)
  setDismissedAnomalies(s)
  if (typeof UK_haptic === 'function') UK_haptic('tap')
  if (ANOM_reviewSheet) ANOM_renderReviewBody()
  if (typeof renderDashboard === 'function') renderDashboard()
}

function ANOM_dismissAllReview() {
  const s = getDismissedAnomalies()
  ANOM_reviewKeys.forEach(k => s.add(k))
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
const _ANOM_SEV_RANK = { high: 0, med: 1, low: 2 }

// ===== detection =====
function ANOM_detect() {
  if (typeof getTransactions !== 'function') return []
  const dismissed = getDismissedAnomalies()
  const all = getTransactions()
  const ccDetail = (typeof ccAccountsWithDetail === 'function') ? ccAccountsWithDetail(all) : new Set()
  const isLump = t => (typeof shouldDropCcLump === 'function') ? shouldDropCcLump(t, ccDetail) : false

  // Visible expenses the user actually sees (no transfers, no double-counted CC lump).
  const expenses = all
    .filter(t => (t.amount < 0 || (t.type === 'refund' && t.amount > 0)) && t.type !== 'transfer' && !isLump(t))
    .map(t => ({ t, key: _txVendorKey(t), abs: Math.abs(t.amount), date: t.date || '', m: getTxEffectiveMonth(t) }))
    .filter(x => x.key && x.date)
    .sort((a, b) => a.date.localeCompare(b.date))

  const now = new Date()
  const recentCut = _iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ANOM_CONFIG.recentDays))
  const curMonth = _ym(now)
  const todayIso = _iso(now)

  const groups = {}
  for (const x of expenses) (groups[x.key] = groups[x.key] || []).push(x)

  const recurring = (typeof getAllRecurring === 'function') ? (() => { try { return getAllRecurring() } catch (e) { return [] } })() : []
  const recurringKeys = new Set(recurring.map(r => r.sourceKey).filter(Boolean))
  const entryTxs = r => r.key && String(r.key).startsWith('mgroup:')
    ? expenses.filter(x => x.t.recurringGroupId === r.groupId)
    : (groups[r.sourceKey] || [])

  const out = []
  const flagged = new Set()      // txIds already flagged by a per-tx rule
  const vendorOf = t => (typeof resolveVendor === 'function' ? resolveVendor(t.vendor, t.amount, (typeof getTxAliasDay === 'function' ? getTxAliasDay(t) : undefined)) : t.vendor) || t.vendor || '—'
  const add = (a) => { if (a.txId) { if (flagged.has(a.txId)) return; flagged.add(a.txId) } out.push(a) }
  const recent = x => x.date >= recentCut

  // ---- DUPLICATES (high) ----
  for (const k of Object.keys(groups)) {
    const list = groups[k]
    for (let i = 1; i < list.length; i++) {
      const cur = list[i]
      if (!recent(cur)) continue
      // find a prior tx of same rounded amount
      for (let j = i - 1; j >= 0; j--) {
        const prev = list[j]
        if (Math.round(prev.abs) !== Math.round(cur.abs)) continue
        const sameMonth = prev.m && prev.m === cur.m
        const near = _anomDays(prev.date, cur.date) <= ANOM_CONFIG.dupNearDays
        if (sameMonth || near) {
          add({
            key: `${sameMonth ? 'dup-month' : 'dup-near'}:${cur.t.id}`,
            rule: sameMonth ? 'dup-month' : 'dup-near', severity: 'high', txId: cur.t.id,
            vendor: vendorOf(cur.t), amount: cur.t.amount, date: cur.date,
            title: 'ייתכן חיוב כפול',
            detail: sameMonth ? 'אותו ספק וסכום פעמיים באותו חודש' : `אותו סכום שוב תוך ${_anomDays(prev.date, cur.date)} ימים`,
          })
        }
        break
      }
    }
  }

  // ---- LARGE EXPENSE (high) — vs distribution of last 12 months ----
  ;(() => {
    const yearCut = _iso(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()))
    const amts = expenses.filter(x => x.date >= yearCut).map(x => x.abs)
    if (amts.length < 8) return
    const mean = amts.reduce((s, v) => s + v, 0) / amts.length
    const std = Math.sqrt(amts.reduce((s, v) => s + (v - mean) ** 2, 0) / amts.length)
    if (std <= 0) return
    const thresh = mean + ANOM_CONFIG.largeStdMult * std
    for (const x of expenses) {
      if (!recent(x) || x.abs <= thresh) continue
      add({
        key: `large-expense:${x.t.id}`, rule: 'large-expense', severity: 'high', txId: x.t.id,
        vendor: vendorOf(x.t), amount: x.t.amount, date: x.date,
        title: 'הוצאה חריגה בגודלה', detail: `גבוה משמעותית מהממוצע (${formatCurrencyPlain(mean)})`,
      })
    }
  })()

  // ---- RECURRING SPIKE + PRICE CREEP (med/low) ----
  for (const r of recurring) {
    if ((r.avgAmount || 0) >= 0) continue          // expense entries only
    const txs = entryTxs(r)
    if (txs.length < ANOM_CONFIG.minOcc) continue
    const last = txs[txs.length - 1]
    const avg = Math.abs(r.avgAmount)
    if (recent(last) && avg > 0 && last.abs > avg * (1 + ANOM_CONFIG.spikePct)) {
      const pct = Math.round((last.abs / avg - 1) * 100)
      add({
        key: `recurring-spike:${last.t.id}`, rule: 'recurring-spike', severity: 'med', txId: last.t.id,
        vendor: r.vendor, amount: last.t.amount, date: last.date,
        title: 'קפיצה בהוצאה קבועה', detail: `+${pct}% מהממוצע (${formatCurrencyPlain(avg)})`,
      })
      continue
    }
    // gradual creep: recent half avg vs older half avg
    if (recent(last) && txs.length >= ANOM_CONFIG.minOcc) {
      const half = Math.floor(txs.length / 2)
      const older = txs.slice(0, half).map(x => x.abs)
      const newer = txs.slice(half).map(x => x.abs)
      const om = older.reduce((s, v) => s + v, 0) / older.length
      const nm = newer.reduce((s, v) => s + v, 0) / newer.length
      if (om > 0 && nm > om * (1 + ANOM_CONFIG.creepPct)) {
        add({
          key: `price-creep:${last.t.id}`, rule: 'price-creep', severity: 'low', txId: last.t.id,
          vendor: r.vendor, amount: last.t.amount, date: last.date,
          title: 'התייקרות הדרגתית', detail: `עלה ~${Math.round((nm / om - 1) * 100)}% לאורך זמן`,
        })
      }
    }
  }

  // ---- VENDOR SPIKE (med) — non-recurring vendor, charge >> its median ----
  for (const k of Object.keys(groups)) {
    if (recurringKeys.has(k)) continue
    const list = groups[k]
    if (list.length < ANOM_CONFIG.minOcc) continue
    const last = list[list.length - 1]
    if (!recent(last)) continue
    const med = _anomMedian(list.slice(0, -1).map(x => x.abs))
    if (med > 0 && last.abs > med * ANOM_CONFIG.vendorSpikeX) {
      add({
        key: `vendor-spike:${last.t.id}`, rule: 'vendor-spike', severity: 'med', txId: last.t.id,
        vendor: vendorOf(last.t), amount: last.t.amount, date: last.date,
        title: 'גבוה מהרגיל לספק', detail: `החיוב הטיפוסי כ-${formatCurrencyPlain(med)}`,
      })
    }
  }

  // ---- DORMANT vendor returns (med) ----
  for (const k of Object.keys(groups)) {
    const list = groups[k]
    if (list.length < 2) continue
    const last = list[list.length - 1], prev = list[list.length - 2]
    if (recent(last) && _anomDays(prev.date, last.date) > ANOM_CONFIG.dormantDays) {
      const mo = Math.round(_anomDays(prev.date, last.date) / 30)
      add({
        key: `dormant:${last.t.id}`, rule: 'dormant', severity: 'med', txId: last.t.id,
        vendor: vendorOf(last.t), amount: last.t.amount, date: last.date,
        title: 'ספק חזר אחרי הפסקה', detail: `לא היה חיוב כ-${mo} חודשים`,
      })
    }
  }

  // ---- NEW vendor (med) — first ever charge, within window ----
  for (const k of Object.keys(groups)) {
    const list = groups[k]
    const first = list[0]
    if (list.length >= 1 && first.date >= recentCut) {
      add({
        key: `new-vendor:${first.t.id}`, rule: 'new-vendor', severity: 'med', txId: first.t.id,
        vendor: vendorOf(first.t), amount: first.t.amount, date: first.date,
        title: 'חיוב מספק חדש', detail: 'לא היה חיוב מספק זה בעבר',
      })
    }
  }

  // ---- NEW recurring detected (low) ----
  for (const r of recurring) {
    if (r.source !== 'auto' || (r.avgAmount || 0) >= 0) continue
    if (r.occurrences >= 3 && r.occurrences <= 5 && r.lastSeen >= recentCut) {
      const txs = entryTxs(r)
      const last = txs[txs.length - 1]
      add({
        key: `new-recurring:${r.key}`, rule: 'new-recurring', severity: 'low',
        txId: last ? last.t.id : undefined, nav: 'recurring',
        vendor: r.vendor, amount: r.avgAmount, date: r.lastSeen,
        title: 'מנוי/הוצאה קבועה חדשה', detail: `זוהתה כקבועה (${r.cadenceLabel})`,
      })
    }
  }

  // ---- FREQUENCY anomaly (low) — monthly vendor charged 2+ this month ----
  for (const r of recurring) {
    if (r.cadence !== 'monthly') continue
    const inCur = entryTxs(r).filter(x => x.m === curMonth)
    if (inCur.length >= 2) {
      add({
        key: `freq:${r.sourceKey || r.key}:${curMonth}`, rule: 'freq', severity: 'low',
        txId: inCur[inCur.length - 1].t.id,
        vendor: r.vendor, amount: inCur[inCur.length - 1].t.amount, date: inCur[inCur.length - 1].date,
        title: 'חויב יותר מהרגיל', detail: `${inCur.length} חיובים החודש (בד״כ פעם בחודש)`,
      })
    }
  }

  // ---- MISSING expected recurring (low, aggregate) ----
  for (const r of recurring) {
    if ((r.avgAmount || 0) >= 0 || !r.nextExpected) continue
    const nm = r.nextExpected.slice(0, 7)
    if (nm > curMonth) continue                                  // not due yet
    if (_anomDays(r.nextExpected, todayIso) < 3) continue        // grace
    const seen = entryTxs(r).some(x => x.m === curMonth)
    if (!seen) {
      out.push({
        key: `missing-recurring:${r.key}:${curMonth}`, rule: 'missing-recurring', severity: 'low',
        nav: 'recurring', vendor: r.vendor, amount: r.avgAmount, date: r.nextExpected,
        title: 'חיוב קבוע צפוי שחסר', detail: `היה אמור להופיע ~${formatDate(r.nextExpected)}`,
      })
    }
  }

  // ---- CATEGORY spike (low, aggregate) ----
  ;(() => {
    if (typeof countedExpenseAmount !== 'function') return
    const byCatMonth = {}
    for (const t of all) {
      if (!isCountedExpense(t)) continue
      const m = getTxEffectiveMonth(t); if (!m) continue
      const c = t.categoryId || '__none__'
      byCatMonth[c] = byCatMonth[c] || {}
      byCatMonth[c][m] = (byCatMonth[c][m] || 0) + countedExpenseAmount(t)
    }
    const prevMonths = [1, 2, 3].map(d => _ym(new Date(now.getFullYear(), now.getMonth() - d, 1)))
    for (const c of Object.keys(byCatMonth)) {
      const cur = byCatMonth[c][curMonth] || 0
      if (cur <= 0) continue
      const prevVals = prevMonths.map(m => byCatMonth[c][m] || 0)
      const avg = prevVals.reduce((s, v) => s + v, 0) / prevVals.length
      if (avg <= 0) continue
      if (cur > avg * (1 + ANOM_CONFIG.catSpikePct) && (cur - avg) >= ANOM_CONFIG.catSpikeMinDelta) {
        const cat = (typeof getCategoryById === 'function') ? getCategoryById(c) : null
        out.push({
          key: `category-spike:${c}:${curMonth}`, rule: 'category-spike', severity: 'low',
          navCat: c === '__none__' ? '' : c, vendor: cat ? cat.name : 'לא מסווג',
          amount: -cur, date: todayIso,
          title: 'הוצאה גבוהה בקטגוריה', detail: `+${Math.round((cur / avg - 1) * 100)}% מממוצע 3 חודשים`,
        })
      }
    }
  })()

  return out
    .filter(a => !dismissed.has(a.key))
    .sort((a, b) => (_ANOM_SEV_RANK[a.severity] - _ANOM_SEV_RANK[b.severity]) || b.date.localeCompare(a.date))
    .slice(0, ANOM_CONFIG.maxShow)
}

// ===== rendering =====
// Anomaly keys/vendors can contain Hebrew/quotes that break inline onclick
// strings, so render-time we map a safe idx ('r0','r1'…) → anomaly and the
// handlers look it up (same pattern as recurring.js _recKeyMap).
const _ANOM_SEV_ICON = { high: '🔴', med: '🟠', low: '🟡' }
let ANOM_rowMap = {}

function ANOM_actIdx(idx) {
  const a = ANOM_rowMap[idx]; if (!a) return
  if (a.txId && typeof openEditModal === 'function') openEditModal(a.txId)
  else if (a.navCat && typeof goToTransactionsByCategory === 'function') goToTransactionsByCategory(a.navCat)
  else if (a.nav && typeof navigate === 'function') navigate(a.nav)
}
function ANOM_dismissIdx(idx) { const a = ANOM_rowMap[idx]; if (a) ANOM_dismiss(a.key) }

function _anomRowHTML(a, idx) {
  return `<div class="ins-anom-row" onclick="ANOM_actIdx('${idx}')">
    <span class="ins-anom-sev">${_ANOM_SEV_ICON[a.severity] || '🟡'}</span>
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
  ANOM_rowMap = {}
  list.forEach((a, i) => { ANOM_rowMap['r' + i] = a })   // full map (review may reference all)
  const n = list.length
  const more = n - ANOM_CONFIG.cardPreview
  const preview = list.slice(0, ANOM_CONFIG.cardPreview)
  return `<div class="card ins-anomalies">
    <div class="card-title ins-anom-titlerow" ${n > ANOM_CONFIG.cardPreview ? 'onclick="ANOM_openReview()"' : ''}>
      <span>⚠ עסקאות לבדיקה · ${n}</span>
      ${n > ANOM_CONFIG.cardPreview ? '<span class="ins-anom-expand">הצג הכל ›</span>' : ''}
    </div>
    ${preview.map((a, i) => _anomRowHTML(a, 'r' + i)).join('')}
    ${more > 0 ? `<button class="ins-anom-all" onclick="ANOM_openReview()">הצג עוד ${more} ›</button>` : ''}
  </div>`
}

function ANOM_renderInto(id) {
  const el = document.getElementById(id)
  if (el) el.innerHTML = ANOM_cardHTML()
}

// ===== review sheet (full list + bulk dismiss) =====
function ANOM_openReview() {
  if (typeof UK_sheet !== 'function') { return }
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
  const list = ANOM_detect()
  ANOM_reviewKeys = list.map(a => a.key)
  if (!list.length) { body.innerHTML = '<div class="ins-inbox-done">🎉 אין עסקאות חשודות</div>'; return }
  ANOM_rowMap = {}
  list.forEach((a, i) => { ANOM_rowMap['r' + i] = a })
  body.innerHTML = `
    <div class="ins-anom-reviewtop">
      <span>${list.length} התראות</span>
      <button class="btn-ghost" onclick="ANOM_dismissAllReview()">סמן הכל כתקין</button>
    </div>
    ${list.map((a, i) => _anomRowHTML(a, 'r' + i)).join('')}`
}
