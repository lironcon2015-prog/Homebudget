// ===== UI KIT — shared primitives for the v1.23 UX upgrades =====
// Loaded right after ui.js so it can reuse toast / _trapFocus / CHART_COLORS.
// All globals are prefixed UK_ to avoid classic-script name collisions.
// Persisted UI prefs use bare keys (uiTheme/uiAccent/uiPrivacy) — deliberately
// NOT fin* — so they never sync to Drive or trigger _onBackupKeyWrite.

// ===== THEME =====
const UK_THEME_KEY = 'uiTheme'
const UK_ACCENT_KEY = 'uiAccent'
const UK_PRIVACY_KEY = 'uiPrivacy'

function UK_getTheme() { return localStorage.getItem(UK_THEME_KEY) || 'system' }

function _UK_resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

// Apply theme to <html> + sync the PWA status-bar colour. Does NOT persist.
function UK_applyTheme(mode) {
  const resolved = _UK_resolveTheme(mode)
  document.documentElement.dataset.theme = resolved
  const tc = document.querySelector('meta[name="theme-color"]')
  if (tc) tc.setAttribute('content', resolved === 'light' ? '#f4f5f7' : '#0a0e1a')
}

function UK_setTheme(mode) {
  localStorage.setItem(UK_THEME_KEY, mode)
  UK_applyTheme(mode)
  UK_refreshChartColors()
  UK_syncAppearanceUI()
  UK_rerenderActiveScreen()
}

// Reflect current prefs in the Settings → Appearance controls (if mounted).
function UK_syncAppearanceUI() {
  const seg = document.getElementById('themeSeg')
  if (seg) { const m = UK_getTheme(); seg.querySelectorAll('[data-theme-mode]').forEach(b => b.classList.toggle('active', b.dataset.themeMode === m)) }
  const sw = document.getElementById('accentSwatches')
  if (sw) { const a = UK_getAccent(); sw.querySelectorAll('[data-accent]').forEach(b => b.classList.toggle('active', (b.dataset.accent || '') === a)) }
  const pv = document.getElementById('privacyToggle')
  if (pv) pv.checked = UK_isPrivacy()
}

function _UK_hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

function UK_getAccent() { return localStorage.getItem(UK_ACCENT_KEY) || '' }

function UK_setAccent(hex) {
  const root = document.documentElement
  if (hex) {
    localStorage.setItem(UK_ACCENT_KEY, hex)
    root.style.setProperty('--accent', hex)
    const dim = _UK_hexToRgba(hex, 0.15)
    if (dim) root.style.setProperty('--accent-dim', dim)
  } else {
    localStorage.removeItem(UK_ACCENT_KEY)
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-dim')
  }
  UK_refreshChartColors()
  UK_syncAppearanceUI()
  UK_rerenderActiveScreen()
}

function UK_isPrivacy() { return !!localStorage.getItem(UK_PRIVACY_KEY) }

function UK_setPrivacy(on) {
  if (on) { localStorage.setItem(UK_PRIVACY_KEY, '1'); document.documentElement.dataset.privacy = '1' }
  else { localStorage.removeItem(UK_PRIVACY_KEY); delete document.documentElement.dataset.privacy }
  UK_syncAppearanceUI()
}

function UK_togglePrivacy() { UK_setPrivacy(!UK_isPrivacy()) }

// CHART_COLORS (ui.js) hardcodes hex; mutate it in place from the live CSS
// tokens so charts match the active theme/accent. Existing references keep working.
function UK_refreshChartColors() {
  if (typeof CHART_COLORS === 'undefined') return
  const cs = getComputedStyle(document.documentElement)
  const v = n => cs.getPropertyValue(n).trim()
  const set = (k, val) => { if (val) CHART_COLORS[k] = val }
  set('accent', v('--accent'))
  set('accentBg', _UK_hexToRgba(v('--accent'), 0.65) || CHART_COLORS.accentBg)
  set('surface', v('--bg-base'))
  set('grid', v('--border'))
  set('ticks', v('--text-secondary'))
  set('muted', v('--text-muted'))
}

// Re-render the current screen so charts/colours refresh after a theme change.
function UK_rerenderActiveScreen() {
  if (typeof navigate === 'function' && typeof _currentScreen === 'string' && _currentScreen) {
    navigate(_currentScreen)
  }
}

// Wire live updates for "system" mode + first chart-colour sync. Called on init.
function UK_initTheme() {
  UK_applyTheme(UK_getTheme())          // re-assert (head bootstrap already set it pre-paint)
  UK_refreshChartColors()
  UK_syncAppearanceUI()
  const mq = matchMedia('(prefers-color-scheme: light)')
  const onChange = () => { if (UK_getTheme() === 'system') { UK_applyTheme('system'); UK_refreshChartColors(); UK_rerenderActiveScreen() } }
  if (mq.addEventListener) mq.addEventListener('change', onChange)
  else if (mq.addListener) mq.addListener(onChange)
}

// ===== HAPTICS =====
const UK_HAPTIC_PATTERNS = { tap: 10, success: [10, 40, 12], warn: [20, 30, 20], heavy: 24 }
function UK_haptic(type = 'tap') {
  try { if (navigator.vibrate) navigator.vibrate(UK_HAPTIC_PATTERNS[type] || 10) } catch (e) {}
}

// ===== BOTTOM-SHEET / POPOVER =====
// Reuses the .modal-overlay/.modal-box convention (so the existing mobile
// bottom-sheet CSS applies automatically) + _trapFocus from ui.js.
// Sits below confirmDialog (z 1200) so a confirm fired inside a sheet stacks above.
function UK_sheet(opts = {}) {
  const { title = '', content = '', actions = [], width = 'min(460px,95vw)', onClose = null } = opts
  const lastFocused = document.activeElement
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay open uk-sheet-overlay'
  overlay.style.zIndex = '1100'

  const box = document.createElement('div')
  box.className = 'modal-box uk-sheet'
  box.style.width = width
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')

  if (title) {
    const h = document.createElement('div')
    h.className = 'modal-header'
    h.innerHTML = '<h3></h3><button class="modal-close" aria-label="סגור">✕</button>'
    h.querySelector('h3').textContent = title
    h.querySelector('.modal-close').onclick = () => close()
    box.appendChild(h)
  }

  const body = document.createElement('div')
  body.className = 'uk-sheet-body'
  if (typeof content === 'string') body.innerHTML = content
  else if (content instanceof Node) body.appendChild(content)
  box.appendChild(body)

  if (actions.length) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:.6rem;justify-content:flex-end;margin-top:1.25rem;flex-wrap:wrap'
    actions.forEach(a => {
      const b = document.createElement('button')
      b.className = a.className || (a.primary ? 'btn-primary' : 'btn-ghost')
      b.textContent = a.label
      b.onclick = () => { const keep = a.onClick && a.onClick(); if (!keep) close() }
      row.appendChild(b)
    })
    box.appendChild(row)
  }

  overlay.appendChild(box)
  const close = () => {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus()
    if (onClose) onClose()
  }
  const onKey = e => {
    if (e.key === 'Escape') close()
    else if (e.key === 'Tab' && typeof _trapFocus === 'function') _trapFocus(e, box)
  }
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.addEventListener('keydown', onKey)
  document.body.appendChild(overlay)
  const first = box.querySelector('input,select,textarea,button:not(.modal-close),[tabindex]')
  if (first) first.focus()
  return { close, box, body }
}

// ===== GESTURES =====
// Swipe with RTL-aware LOGICAL callbacks: onStart = swipe toward the inline-start
// edge (physically right in RTL), onEnd = toward the inline-end edge. Vertical-
// dominant moves are ignored so it never fights list scrolling. Suppresses the
// trailing click so a swipe doesn't also trigger row onclick handlers.
function UK_onSwipe(el, opts = {}) {
  const { onStart, onEnd, threshold = 60, maxVertical = 34 } = opts
  let x0 = 0, y0 = 0, active = false
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    x0 = e.clientX; y0 = e.clientY; active = true
  })
  el.addEventListener('pointercancel', () => { active = false })
  el.addEventListener('pointerup', e => {
    if (!active) return
    active = false
    const dx = e.clientX - x0, dy = e.clientY - y0
    if (Math.abs(dy) > maxVertical || Math.abs(dx) < threshold) return
    const rtl = (document.documentElement.dir === 'rtl')
    const towardStart = rtl ? dx > 0 : dx < 0
    // Cancel the click that fires right after the swipe.
    el.addEventListener('click', function sup(ev) { ev.stopPropagation(); ev.preventDefault(); el.removeEventListener('click', sup, true) }, true)
    UK_haptic('tap')
    if (towardStart) { if (onStart) onStart(e) } else { if (onEnd) onEnd(e) }
  })
}

// Pull-to-refresh on a page that scrolls the document. Touch listeners attach to
// `target`, but the "at top" arm-check uses the WINDOW scroll position (the app's
// .main-content has min-height:100vh, so the document scrolls, not the element).
// A fixed indicator shows the pull; past threshold it runs asyncFn.
function UK_onPullToRefresh(target, asyncFn) {
  if (!target) return
  let y0 = null, dy = 0, busy = false
  let ind = document.getElementById('ukPtr')
  if (!ind) {
    ind = document.createElement('div')
    ind.id = 'ukPtr'
    ind.className = 'uk-ptr'
    ind.innerHTML = '<span class="uk-ptr-spin">↻</span>'
    document.body.appendChild(ind)
  }
  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0
  const reset = () => { ind.classList.remove('armed', 'busy', 'show'); ind.style.transform = ''; y0 = null; dy = 0 }
  target.addEventListener('touchstart', e => {
    if (busy || !atTop()) { y0 = null; return }
    y0 = e.touches[0].clientY
  }, { passive: true })
  target.addEventListener('touchmove', e => {
    if (y0 === null || busy) return
    dy = e.touches[0].clientY - y0
    if (dy > 0 && atTop()) {
      ind.classList.add('show')
      ind.style.transform = `translateY(${Math.min(dy, 90)}px)`
      ind.classList.toggle('armed', dy > 70)
    }
  }, { passive: true })
  target.addEventListener('touchend', async () => {
    if (y0 === null || busy) { reset(); return }
    if (dy > 70) {
      busy = true; ind.classList.add('busy', 'show'); ind.classList.remove('armed')
      ind.style.transform = 'translateY(50px)'
      UK_haptic('success')
      try { await asyncFn() } catch (e) { console.error(e) }
      finally { busy = false; reset() }
    } else { reset() }
  })
}

// ===== FAB (mobile quick actions) =====
let _UK_fabSheet = null
function UK_openFab() {
  UK_haptic('tap')
  const html = `<div class="fab-actions">
    <button class="fab-action" onclick="_UK_fabAct('tx')"><span class="fab-action-ic">➕</span> עסקה חדשה</button>
    <button class="fab-action" onclick="_UK_fabAct('import')"><span class="fab-action-ic">📥</span> ייבוא דוח</button>
    <button class="fab-action" onclick="_UK_fabAct('privacy')"><span class="fab-action-ic">🙈</span> ${UK_isPrivacy() ? 'הצג סכומים' : 'הסתר סכומים'}</button>
  </div>`
  _UK_fabSheet = UK_sheet({ title: 'פעולה מהירה', content: html })
}
function _UK_fabAct(which) {
  if (_UK_fabSheet) { _UK_fabSheet.close(); _UK_fabSheet = null }
  if (which === 'tx' && typeof addManualTransaction === 'function') addManualTransaction()
  else if (which === 'import' && typeof navigate === 'function') navigate('import')
  else if (which === 'privacy') UK_togglePrivacy()
}

// Pull-to-refresh action: backup to Drive when signed in, else just re-render.
async function _UK_pullRefresh() {
  if (typeof driveBackup === 'function' && typeof _driveToken !== 'undefined' && _driveToken) {
    await driveBackup()
  } else {
    UK_rerenderActiveScreen()
    if (typeof toast === 'function') toast('רוענן', { type: 'info', duration: 1500 })
  }
}

// Wire mobile gestures once the DOM is ready (touch devices only).
function UK_initMobile() {
  if (!('ontouchstart' in window)) return
  const mc = document.querySelector('.main-content')
  if (mc) UK_onPullToRefresh(mc, _UK_pullRefresh)
}
document.addEventListener('DOMContentLoaded', UK_initMobile)

// ===== VENDOR AVATAR =====
const UK_AVATAR_PALETTE = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#6366f1', '#14b8a6', '#f43f5e']

function _UK_initials(name) {
  const s = String(name || '').trim()
  if (!s) return '•'
  const parts = s.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0])
  return s.slice(0, 2)
}

function _UK_hashColor(name) {
  const h = (typeof _rawHash === 'function') ? _rawHash(String(name || '')) : String(name || '')
  let n = 0
  for (let i = 0; i < h.length; i++) n = (n + h.charCodeAt(i)) | 0
  return UK_AVATAR_PALETTE[Math.abs(n) % UK_AVATAR_PALETTE.length]
}

// Category icon when classified, else deterministic-colour initials. Returns HTML.
function UK_vendorAvatar(arg, opts = {}) {
  const size = opts.size || 36
  let cat = null, name = ''
  if (arg && typeof arg === 'object') {
    name = (typeof resolveVendor === 'function'
      ? resolveVendor(arg.vendor, arg.amount, (typeof getTxAliasDay === 'function' ? getTxAliasDay(arg) : undefined))
      : arg.vendor) || arg.vendor || ''
    cat = (arg.categoryId && typeof getCategoryById === 'function') ? getCategoryById(arg.categoryId) : null
  } else {
    name = String(arg || '')
  }
  if (cat) {
    const icon = (typeof catIconHTML === 'function' ? catIconHTML(cat, Math.round(size * 0.5)) : '') || '📋'
    return `<div class="tx-avatar uk-avatar" style="width:${size}px;height:${size}px;background:${cat.color}22">${icon}</div>`
  }
  const color = _UK_hashColor(name)
  const initials = (typeof escHtml === 'function') ? escHtml(_UK_initials(name)) : _UK_initials(name)
  return `<div class="tx-avatar uk-avatar uk-avatar-initials" style="width:${size}px;height:${size}px;background:${color}22;color:${color};font-size:${Math.round(size * 0.36)}px">${initials}</div>`
}

// Sync chart palette to the active theme at load-time — runs before app.js's
// DOMContentLoaded first render, so the initial charts use the right colours.
// (The <head> bootstrap already set data-theme + --accent before this executes.)
UK_refreshChartColors()

// Init UI prefs / system-theme listener once the DOM is ready.
document.addEventListener('DOMContentLoaded', UK_initTheme)
