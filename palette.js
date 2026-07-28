// ===== COMMAND PALETTE + GLOBAL KEYBOARD SHORTCUTS =====
// Globals prefixed CP_. Loads after app.js (navigate/SCREENS), uikit.js (UK_sheet),
// transactions.js (_drawTxTable/_txPage). Desktop-first; harmless on mobile.

const CP_SCREEN_LABELS = {
  dashboard: 'בית', transactions: 'עסקאות', import: 'ייבוא', analysis: 'ניתוח',
  recurring: 'קבועות', budget: 'תקציב', property: 'נכס', settings: 'הגדרות',
}

let _cpSheet = null
let _cpItems = []
let _cpActive = 0

function CP_open() {
  if (_cpSheet) return
  const html = `
    <input id="cpInput" class="cp-input" placeholder="חיפוש עסקאות / ספקים / קטגוריות, או פעולה…" autocomplete="off" oninput="CP_render(this.value)" onkeydown="CP_onInputKey(event)">
    <div class="cp-results" id="cpResults"></div>`
  _cpSheet = UK_sheet({ content: html, width: 'min(560px,96vw)', onClose: () => { _cpSheet = null } })
  _cpActive = 0
  CP_render('')
}

function CP_close() { if (_cpSheet) { _cpSheet.close(); _cpSheet = null } }

function _cpEsc(s) { return escHtml(s) }

function CP_render(q) {
  q = (q || '').trim()
  const ql = q.toLowerCase()
  const items = []

  const actions = [
    { icon: '+', label: 'עסקה חדשה', run: () => { CP_close(); if (typeof addManualTransaction === 'function') addManualTransaction() } },
    { icon: uiIcon('download', 15), label: 'ייבוא דוח', run: () => { CP_close(); navigate('import') } },
    { icon: uiIcon('cloud', 15), label: 'גיבוי ל-Drive', run: () => { CP_close(); if (typeof driveBackup === 'function') driveBackup() } },
    { icon: uiIcon('moon', 15), label: 'החלף ערכת נושא (בהיר/כהה)', run: () => { UK_setTheme(_UK_resolveTheme(UK_getTheme()) === 'light' ? 'dark' : 'light') } },
    { icon: uiIcon('eyeoff', 15), label: 'הסתר/הצג סכומים', run: () => { UK_togglePrivacy() } },
  ]
  if (typeof SCREENS !== 'undefined') {
    SCREENS.forEach(s => actions.push({ icon: uiIcon('file', 15), label: 'מעבר: ' + (CP_SCREEN_LABELS[s] || s), run: () => { CP_close(); navigate(s) } }))
  }
  actions.forEach(a => { if (!q || a.label.toLowerCase().includes(ql)) items.push(a) })

  // Data search only once the query is meaningful.
  if (q.length >= 2 && typeof getTransactions === 'function') {
    const seen = new Set()
    let added = 0
    for (const t of getTransactions()) {
      const vn = (typeof resolveVendor === 'function' ? resolveVendor(t.vendor, t.amount, (typeof getTxAliasDay === 'function' ? getTxAliasDay(t) : undefined)) : t.vendor) || t.vendor || ''
      if (vn && vn.toLowerCase().includes(ql) && !seen.has(vn)) {
        seen.add(vn)
        const av = (typeof UK_vendorAvatar === 'function') ? UK_vendorAvatar(vn, { size: 26 }) : uiIcon('search', 15)
        items.push({ html: av, label: vn, sub: 'חיפוש עסקאות', run: () => { CP_close(); CP_gotoTxSearch(vn) } })
        if (++added >= 6) break
      }
    }
    if (typeof getCategories === 'function') {
      getCategories().forEach(c => {
        if (c.name.toLowerCase().includes(ql)) items.push({ icon: uiIcon('tag', 15), label: c.name, sub: 'סנן לפי קטגוריה', run: () => { CP_close(); CP_gotoCategory(c.id) } })
      })
    }
  }

  _cpItems = items
  if (_cpActive >= items.length) _cpActive = 0
  const out = document.getElementById('cpResults')
  if (!out) return
  out.innerHTML = items.length
    ? items.map((it, i) => `
      <button class="cp-item ${i === _cpActive ? 'active' : ''}" onmouseenter="_cpActive=${i};CP_syncActive()" onclick="CP_runIndex(${i})">
        <span class="cp-ic">${it.html || it.icon || ''}</span>
        <span class="cp-label">${_cpEsc(it.label)}</span>
        ${it.sub ? `<span class="cp-sub">${it.sub}</span>` : ''}
      </button>`).join('')
    : '<div class="cp-empty">אין תוצאות</div>'
}

function CP_runIndex(i) { const it = _cpItems[i]; if (it && it.run) it.run() }

function CP_syncActive() {
  const r = document.getElementById('cpResults')
  if (!r) return
  r.querySelectorAll('.cp-item').forEach((b, i) => b.classList.toggle('active', i === _cpActive))
  const act = r.querySelector('.cp-item.active')
  if (act) act.scrollIntoView({ block: 'nearest' })
}

function CP_onInputKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); _cpActive = Math.min(_cpItems.length - 1, _cpActive + 1); CP_syncActive() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); _cpActive = Math.max(0, _cpActive - 1); CP_syncActive() }
  else if (e.key === 'Enter') { e.preventDefault(); CP_runIndex(_cpActive) }
}

function CP_gotoTxSearch(vn) {
  navigate('transactions')
  const s = document.getElementById('txSearch')
  if (s) { s.value = vn; if (typeof _txPage !== 'undefined') _txPage = 0; if (typeof _drawTxTable === 'function') _drawTxTable() }
}

function CP_gotoCategory(catId) {
  navigate('transactions')
  const sel = document.getElementById('txCategoryFilter')
  if (sel) { sel.value = catId; if (typeof _txPage !== 'undefined') _txPage = 0; if (typeof _drawTxTable === 'function') _drawTxTable() }
}

// ===== GLOBAL SHORTCUTS =====
const CP_NAV_CHORD = { d: 'dashboard', t: 'transactions', b: 'budget', a: 'analysis', r: 'recurring', i: 'import', s: 'settings', p: 'property' }
let _cpChord = false
let _cpChordTimer = null

function _cpTyping(el) {
  if (!el) return false
  const t = (el.tagName || '').toLowerCase()
  return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable
}
function _cpOverlayOpen() { return !!document.querySelector('.modal-overlay.open') }

function CP_showHelp() {
  const rows = [
    ['⌘K / Ctrl+K', 'פתח/סגור חיפוש מהיר'],
    ['n', 'עסקה חדשה'],
    ['/', 'מיקוד בשורת החיפוש'],
    ['g ואז d/t/b/a/r/i/s/p', 'מעבר מהיר בין מסכים'],
    ['?', 'מסך זה'],
  ]
  const html = `<div class="cp-help">${rows.map(r => `<div class="cp-help-row"><kbd>${_cpEsc(r[0])}</kbd><span>${_cpEsc(r[1])}</span></div>`).join('')}</div>`
  UK_sheet({ title: 'קיצורי מקלדת', content: html })
}

document.addEventListener('keydown', e => {
  // Cmd/Ctrl+K toggles the palette from anywhere.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    if (_cpSheet) CP_close(); else CP_open()
    return
  }
  if (_cpTyping(e.target) || _cpOverlayOpen()) return
  if (e.metaKey || e.ctrlKey || e.altKey) return

  if (_cpChord) {
    _cpChord = false; clearTimeout(_cpChordTimer)
    const scr = CP_NAV_CHORD[e.key]
    if (scr) { e.preventDefault(); navigate(scr) }
    return
  }
  if (e.key === 'g') { _cpChord = true; _cpChordTimer = setTimeout(() => { _cpChord = false }, 1200); return }
  if (e.key === 'n') { e.preventDefault(); if (typeof addManualTransaction === 'function') addManualTransaction() }
  else if (e.key === '/') { e.preventDefault(); navigate('transactions'); const s = document.getElementById('txSearch'); if (s) s.focus() }
  else if (e.key === '?') { e.preventDefault(); CP_showHelp() }
})
