// ===== INSIGHTS — dashboard extras (Inbox, MoM chips, upcoming bills) =====
// Globals prefixed INS_. Loads after recurring.js (getAllRecurring) and
// dashboard.js. All read-only over the existing data layer; never touches P&L.

function _insEsc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) }

function INS_uncategorizedCount() {
  if (typeof getTransactions !== 'function') return 0
  return getTransactions().filter(t => !t.categoryId && t.type !== 'transfer').length
}

function INS_renderDashboard() {
  const host = document.getElementById('dashInsights')
  if (!host) return
  const anom = (typeof ANOM_cardHTML === 'function') ? ANOM_cardHTML() : ''
  host.innerHTML = anom + _insInboxCard() + _insMoMChips() + _insUpcomingCard()
}

// ===== Inbox card + quick-categorize flow =====
function _insInboxCard() {
  const n = INS_uncategorizedCount()
  if (!n) return ''
  return `<div class="card ins-inbox" onclick="INS_openInbox()">
    <div class="ins-inbox-ic">🗂️</div>
    <div class="ins-inbox-txt"><strong>${n} עסקאות ללא קטגוריה</strong><span>סווג עכשיו לשיפור הדיוק בניתוח ובתקציב</span></div>
    <button class="btn-primary" onclick="event.stopPropagation();INS_openInbox()">סווג מהר</button>
  </div>`
}

let _insInboxQueue = []
let _insInboxSheet = null

function INS_openInbox() {
  _insInboxQueue = getTransactions().filter(t => !t.categoryId && t.type !== 'transfer').map(t => t.id)
  if (!_insInboxQueue.length) { if (typeof toast === 'function') toast('הכול מסווג! 🎉', { type: 'success' }); return }
  if (typeof UK_sheet !== 'function') { navigate('transactions'); return }
  _insInboxSheet = UK_sheet({
    title: 'סיווג מהיר',
    content: '<div id="insInboxBody"></div>',
    onClose: () => { _insInboxSheet = null; if (typeof renderDashboard === 'function') renderDashboard() },
  })
  _insInboxStep()
}

function _insInboxStep() {
  const body = document.getElementById('insInboxBody')
  if (!body) return
  let id = null
  while (_insInboxQueue.length) {
    const c = _insInboxQueue[0]
    const t = getTransactions().find(x => x.id === c)
    if (t && !t.categoryId) { id = c; break }
    _insInboxQueue.shift()
  }
  if (!id) { body.innerHTML = '<div class="ins-inbox-done">🎉 סיימת! כל העסקאות סווגו.</div>'; return }
  const t = getTransactions().find(x => x.id === id)
  const vn = (typeof resolveVendor === 'function' ? resolveVendor(t.vendor, t.amount, (typeof getTxAliasDay === 'function' ? getTxAliasDay(t) : undefined)) : t.vendor) || t.vendor || '—'
  const cats = getCategories()
  const grp = (arr, title) => arr.length
    ? `<div class="cat-pick-section">${title}</div>` + arr.map(c => `<button class="cat-pick-btn" style="--cc:${c.color}" onclick="INS_inboxPick('${id}','${c.id}')">${catIconHTML(c)} <span>${_insEsc(c.name)}</span></button>`).join('')
    : ''
  const av = (typeof UK_vendorAvatar === 'function') ? UK_vendorAvatar(t, { size: 42 }) : ''
  body.innerHTML = `
    <div class="ins-inbox-head">
      ${av}
      <div class="ins-inbox-headtxt">
        <div class="ins-inbox-vendor">${_insEsc(vn)}</div>
        <div class="ins-inbox-meta">${formatDate(t.date)} · ${formatCurrency(t.amount)}</div>
      </div>
      <span class="ins-inbox-count">${_insInboxQueue.length} נותרו</span>
    </div>
    <input class="cat-pick-search" placeholder="חיפוש קטגוריה…" oninput="_filterCatPick(this.value)">
    <div class="cat-pick-grid" id="catPickGrid">
      ${grp(cats.filter(c => c.type === 'expense'), 'הוצאות')}
      ${grp(cats.filter(c => c.type === 'income'), 'הכנסות')}
      <button class="cat-pick-btn cat-pick-none" onclick="INS_inboxSkip()">דלג ←</button>
    </div>`
}

function INS_inboxPick(id, catId) {
  const txs = getTransactions()
  const t = txs.find(x => x.id === id)
  if (!t) return
  t.categoryId = catId
  DB.set('finTransactions', txs)
  if (typeof UK_haptic === 'function') UK_haptic('tap')
  _insInboxQueue.shift()
  _insInboxStep()
}

function INS_inboxSkip() { _insInboxQueue.shift(); _insInboxStep() }

// ===== Month-over-month chips =====
function _insPrevPeriod(p) {
  const n = (typeof monthsInPeriod === 'function') ? monthsInPeriod(p).length : 1
  const [sy, sm] = p.start.split('-').map(Number)
  const end = new Date(sy, sm - 2, 1)                       // month before the period start
  const start = new Date(end.getFullYear(), end.getMonth() - (n - 1), 1)
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  return { start: fmt(start), end: fmt(end) }
}

function _insMoMChips() {
  if (typeof getActivePeriod !== 'function' || typeof filterByEffectivePeriod !== 'function') return ''
  const p = getActivePeriod()
  const all = getTransactions()
  const prev = _insPrevPeriod(p)
  const cur = filterByEffectivePeriod(all, p)
  const pre = filterByEffectivePeriod(all, prev)
  const curExp = sumExpenses(cur), preExp = sumExpenses(pre)
  const curInc = sumIncome(cur), preInc = sumIncome(pre)
  const chip = (label, c, prv, expenseLike) => {
    if (!prv) return ''
    const pct = Math.round((c - prv) / prv * 100)
    if (!isFinite(pct)) return ''
    const up = pct >= 0
    const good = expenseLike ? !up : up
    return `<div class="ins-chip ${good ? 'ins-chip-good' : 'ins-chip-bad'}"><span class="ins-chip-label">${label}</span><span>${up ? '▲' : '▼'} ${Math.abs(pct)}%</span></div>`
  }
  const expChip = chip('הוצאות', curExp, preExp, true)
  const incChip = chip('הכנסות', curInc, preInc, false)
  if (!expChip && !incChip) return ''
  return `<div class="ins-chips">${expChip}${incChip}<span class="ins-chips-note">מול התקופה הקודמת</span></div>`
}

// ===== Upcoming recurring bills this month =====
function _insUpcomingCard() {
  if (typeof getAllRecurring !== 'function') return ''
  let items
  try { items = getAllRecurring() } catch (e) { return '' }
  const hidden = (typeof getHiddenRecurring === 'function') ? getHiddenRecurring() : new Set()
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const todayDay = now.getDate()
  const up = items
    .filter(r => !hidden.has(r.key) && r.nextExpected && r.nextExpected.slice(0, 7) === ym && r.smoothedMonthly < 0)
    .map(r => ({ vendor: r.vendor, date: r.nextExpected, amount: Math.abs(r.avgAmount || r.smoothedMonthly), day: Number(r.nextExpected.slice(8, 10)) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  if (!up.length) return ''
  const total = up.reduce((s, u) => s + u.amount, 0)
  const rows = up.slice(0, 8).map(u => `
    <div class="ins-bill ${u.day < todayDay ? 'ins-bill-past' : ''}">
      ${(typeof UK_vendorAvatar === 'function') ? UK_vendorAvatar(u.vendor, { size: 30 }) : ''}
      <div class="ins-bill-main"><div>${_insEsc(u.vendor)}</div><div class="ins-bill-date">${formatDate(u.date)}${u.day < todayDay ? ' · חויב' : ''}</div></div>
      <div class="ins-bill-amt">${formatCurrency(u.amount)}</div>
    </div>`).join('')
  return `<div class="card ins-upcoming"><div class="card-title">📅 חיובים קבועים החודש · ${formatCurrency(total)}</div>${rows}</div>`
}
