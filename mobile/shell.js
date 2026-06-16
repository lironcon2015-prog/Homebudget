// ===== MOBILE SHELL =====
// Chrome + shared helpers for the native mobile layer (Dark Glass). The bottom
// tab bar / FAB live in index.html (mobile-only via CSS); this file owns the
// "More" launcher and small markup helpers reused by the M_* screen renderers.
// All state hangs off the single MOBILE namespace to keep the global surface tiny.
const MOBILE = { moreSheet: null, periodSheet: null }

// Secondary screens that don't get a primary tab — reached from the "עוד" tab.
const M_MORE_ITEMS = [
  { screen: 'budget',    icon: '🎯', label: 'תקציב' },
  { screen: 'recurring', icon: '🔁', label: 'הוצאות/הכנסות קבועות' },
  { screen: 'property',  icon: '🏠', label: 'משכנתא ונכס' },
  { screen: 'import',    icon: '📥', label: 'ייבוא קובץ' },
  { screen: 'settings',  icon: '⚙️', label: 'הגדרות' },
]

function M_openMore() {
  if (typeof UK_haptic === 'function') UK_haptic('tap')
  const rows = M_MORE_ITEMS.map(it => `
    <button class="m-more-row" onclick="M_navMore('${it.screen}')">
      <span class="m-more-ic">${it.icon}</span>
      <span class="m-more-label">${it.label}</span>
      <span class="m-more-chev">‹</span>
    </button>`).join('')
  const driveOn = (typeof _driveToken !== 'undefined' && _driveToken)
  const driveRow = `
    <button class="m-more-row" onclick="M_openDriveBackup()">
      <span class="m-more-ic">☁️</span>
      <span class="m-more-label">גיבוי וסנכרון (Google Drive)</span>
      <span class="m-more-status ${driveOn ? 'pos' : ''}">${driveOn ? 'מחובר ✓' : 'התחבר'}</span>
    </button>`
  const content = `<div class="m-more-list">${rows}${driveRow}</div>`
  if (typeof UK_sheet === 'function') {
    MOBILE.moreSheet = UK_sheet({ title: 'עוד', content })
  } else {
    navigate('settings')
  }
}

function M_navMore(screen) {
  if (MOBILE.moreSheet) { MOBILE.moreSheet.close(); MOBILE.moreSheet = null }
  navigate(screen)
}

// Jump straight to Settings → Backup (Drive sign-in / sync) from the More sheet.
function M_openDriveBackup() {
  if (MOBILE.moreSheet) { MOBILE.moreSheet.close(); MOBILE.moreSheet = null }
  navigate('settings')
  const btn = document.querySelector('.tab-btn[onclick*="backup"]')
  if (typeof switchTab === 'function' && btn) switchTab('backup', btn)
  const panel = document.getElementById('tab-backup')
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// Mark the active bottom-tab. "More" screens highlight the עוד tab.
function M_syncTabs(screen) {
  const primary = ['dashboard', 'transactions', 'analysis']
  document.querySelectorAll('.bottom-nav .bnav-item').forEach(el => el.classList.remove('active'))
  const key = primary.includes(screen) ? screen : (screen === 'more' ? 'more' : null)
  if (key && key !== 'more') {
    document.querySelectorAll(`.bottom-nav .bnav-item[data-screen="${key}"]`).forEach(el => el.classList.add('active'))
  } else if (!primary.includes(screen)) {
    const more = document.querySelector('.bottom-nav .bnav-item.m-more-tab')
    if (more) more.classList.add('active')
  }
}

// ===== SHARED MARKUP HELPERS =====
// Sticky top bar for a mobile screen: title + optional right-side action buttons.
function M_topbar(title, actionsHTML = '') {
  return `<header class="m-topbar">
    <h1 class="m-topbar-title">${title}</h1>
    <div class="m-topbar-actions">${actionsHTML}</div>
  </header>`
}

// Section header with optional trailing link/control.
function M_sectionHead(title, rightHTML = '') {
  return `<div class="m-section-head"><h3>${title}</h3>${rightHTML}</div>`
}

// ===== PERIOD BAR =====
// Compact native period control: 3 quick presets + an "עוד" button that opens a
// sheet with every other preset and a custom range. Reuses the engine's
// periodPresets()/getActivePeriod()/setActivePeriod(). The onChange callback is
// stashed on the container element so the inline handlers can reach it.
const M_PERIOD_QUICK = ['this_month', 'last_month', 'last_3m']

function M_renderPeriodBar(containerId, onChange) {
  const el = document.getElementById(containerId)
  if (!el) return
  el._onChange = onChange
  const active = getActivePeriod()
  const presets = periodPresets()
  const quick = M_PERIOD_QUICK.map(k => presets.find(p => p.key === k)).filter(Boolean)
  const isQuick = quick.some(p => p.key === active.key)
  el.innerHTML = `<div class="m-period-bar">
    ${quick.map(p => `<button class="m-period-chip ${active.key === p.key ? 'active' : ''}" onclick="M_setPeriod('${p.key}','${containerId}')">${p.label}</button>`).join('')}
    <button class="m-period-chip m-period-more ${isQuick ? '' : 'active'}" onclick="M_openPeriodMore('${containerId}')">${isQuick ? 'עוד' : (active.label || 'מותאם')} ▾</button>
  </div>`
}

function M_setPeriod(key, containerId) {
  const p = periodPresets().find(x => x.key === key)
  if (!p) return
  setActivePeriod(p)
  if (typeof UK_haptic === 'function') UK_haptic('tap')
  const el = document.getElementById(containerId)
  const cb = el && el._onChange
  M_renderPeriodBar(containerId, cb)
  if (cb) cb(p)
}

function M_openPeriodMore(containerId) {
  if (typeof UK_sheet !== 'function') return
  const active = getActivePeriod()
  const rest = periodPresets().filter(p => !M_PERIOD_QUICK.includes(p.key))
  const rows = rest.map(p => `
    <button class="m-more-row" onclick="M_pickPeriodMore('${p.key}','${containerId}')">
      <span class="m-more-label">${p.label}</span>
      ${active.key === p.key ? '<span class="pos">✓</span>' : '<span class="m-more-chev">‹</span>'}
    </button>`).join('')
  const custom = `
    <div class="m-period-custom">
      <label class="form-label">טווח מותאם</label>
      <div class="m-amt-range">
        <input id="mPerStart" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" value="${_isoToDmy(active.start || '')}" oninput="typeof _onDateMaskInput==='function'&&_onDateMaskInput(this)">
        <input id="mPerEnd" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" value="${_isoToDmy(active.end || '')}" oninput="typeof _onDateMaskInput==='function'&&_onDateMaskInput(this)">
      </div>
      <button class="btn-primary" style="width:100%;margin-top:.5rem" onclick="M_applyCustomPeriod('${containerId}')">החל טווח</button>
    </div>`
  MOBILE.periodSheet = UK_sheet({ title: 'בחר תקופה', content: `<div class="m-more-list">${rows}</div>${custom}` })
}

function M_pickPeriodMore(key, containerId) {
  if (MOBILE.periodSheet) { MOBILE.periodSheet.close(); MOBILE.periodSheet = null }
  M_setPeriod(key, containerId)
}

function M_applyCustomPeriod(containerId) {
  const s = _dmyToIso(document.getElementById('mPerStart').value)
  const e = _dmyToIso(document.getElementById('mPerEnd').value)
  if (!s || !e) { if (typeof toast === 'function') toast('טווח תאריכים לא תקין', { type: 'error' }); return }
  const p = { key: 'custom', label: `${formatDate(s)} → ${formatDate(e)}`, start: s, end: e }
  setActivePeriod(p)
  if (MOBILE.periodSheet) { MOBILE.periodSheet.close(); MOBILE.periodSheet = null }
  const el = document.getElementById(containerId)
  const cb = el && el._onChange
  M_renderPeriodBar(containerId, cb)
  if (cb) cb(p)
}
