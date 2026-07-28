// ===== SHARED UI PRIMITIVES =====
// Toasts, an async confirm dialog, button loading state, inline form validation,
// and a single source of chart colours. Loaded early (after core.js) so every
// other module can rely on these globals.

// ===== TOASTS =====
// Stacked, non-blocking notifications. Replaces ad-hoc alert()/custom divs.
//   toast('נשמר', { type:'success' })
//   toast('נמחק', { action:{ label:'בטל', onClick:()=>restore() } })
function _toastStack() {
  let c = document.getElementById('toastStack')
  if (!c) {
    c = document.createElement('div')
    c.id = 'toastStack'
    c.className = 'toast-stack'
    document.body.appendChild(c)
  }
  return c
}

function toast(msg, opts = {}) {
  const { type = 'info', duration = 3200, action = null } = opts
  const el = document.createElement('div')
  el.className = `toast toast-${type}`
  // Errors interrupt assertively; everything else announces politely.
  el.setAttribute('role', type === 'error' ? 'alert' : 'status')
  el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite')

  const span = document.createElement('span')
  span.className = 'toast-msg'
  span.textContent = msg
  el.appendChild(span)

  let timer
  const dismiss = () => {
    clearTimeout(timer)
    el.classList.remove('open')
    setTimeout(() => el.remove(), 220)
  }

  if (action && action.label) {
    const btn = document.createElement('button')
    btn.className = 'toast-action'
    btn.textContent = action.label
    btn.onclick = () => {
      try { if (typeof action.onClick === 'function') action.onClick() }
      finally { dismiss() }
    }
    el.appendChild(btn)
  }

  _toastStack().appendChild(el)
  requestAnimationFrame(() => el.classList.add('open'))
  // Actions get a longer window so the user can react (e.g. Undo).
  if (duration > 0) timer = setTimeout(dismiss, duration + (action ? 2800 : 0))
  return { dismiss }
}

// ===== CONFIRM DIALOG =====
// Promise-based replacement for blocking confirm(). Resolves true/false.
// ESC / backdrop / cancel → false; Enter / confirm → true. Message is set via
// textContent (safe for interpolated data).
// V2 confirm: centered icon-in-halo, bold question, muted context, centered
// actions with a gradient destructive button. When no explicit title is given,
// the message's first line is promoted to the title (matches how most call
// sites phrase the question on line one and the consequences below).
function confirmDialog(message, opts = {}) {
  const {
    danger = false,
    confirmText = 'אישור',
    cancelText = 'ביטול',
    title = '',
    icon = '',
  } = opts
  return new Promise(resolve => {
    const lastFocused = document.activeElement
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay open'
    overlay.style.zIndex = '1200'

    const box = document.createElement('div')
    box.className = 'modal-box confirm2'
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')

    const lines = String(message || '').split('\n')
    const headline = title || lines[0] || 'אישור פעולה'
    const rest = title ? message : lines.slice(1).join('\n')

    const ico = document.createElement('div')
    ico.className = 'confirm2-ico' + (danger ? ' confirm2-ico-danger' : '')
    ico.innerHTML = icon || uiIcon(danger ? 'trash' : 'alert', 24)
    box.appendChild(ico)

    const h3 = document.createElement('h3')
    h3.className = 'confirm2-title'
    h3.textContent = headline
    h3.id = 'confirmDlgTitle' + Date.now()
    box.setAttribute('aria-labelledby', h3.id)
    box.appendChild(h3)

    if (rest && rest.trim()) {
      const body = document.createElement('div')
      body.className = 'confirm2-body'
      body.textContent = rest
      box.appendChild(body)
    }

    const actions = document.createElement('div')
    actions.className = 'confirm2-actions'
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'btn-ghost'
    cancelBtn.textContent = cancelText
    const okBtn = document.createElement('button')
    okBtn.className = danger ? 'btn-danger-cta' : 'btn-primary'
    okBtn.textContent = confirmText
    actions.appendChild(cancelBtn)
    actions.appendChild(okBtn)
    box.appendChild(actions)
    overlay.appendChild(box)

    const close = val => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus()
      resolve(val)
    }
    const onKey = e => {
      if (e.key === 'Escape') { close(false); return }
      if (e.key === 'Enter') { close(true); return }
      if (e.key === 'Tab') _trapFocus(e, box)
    }
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false) })
    cancelBtn.onclick = () => close(false)
    okBtn.onclick = () => close(true)
    document.addEventListener('keydown', onKey)

    document.body.appendChild(overlay)
    okBtn.focus()
  })
}

// ===== V2 MODAL HERO =====
// Shared header band for drill/edit modals: icon tile · name + meta · big
// number. Pass amountHtml pre-formatted (formatCurrency output is HTML).
function v2ModalHero({ icon = uiIcon('file', 20), tileBg = 'rgba(79,139,255,.13)', name = '', meta = '', amountHtml = '', amountCls = '' }) {
  return `
    <div class="mhero2">
      <div class="mhero2-tile" style="background:${tileBg}">${icon}</div>
      <div class="mhero2-mid">
        <div class="mhero2-name">${name}</div>
        ${meta ? `<div class="mhero2-meta">${meta}</div>` : ''}
      </div>
      ${amountHtml ? `<div class="mhero2-amt ${amountCls}">${amountHtml}</div>` : ''}
    </div>`
}

// Keeps Tab/Shift+Tab cycling inside `container` (focus trap for modals).
function _trapFocus(e, container) {
  const focusables = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )
  if (!focusables.length) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

// ===== PROMPT DIALOG =====
// Promise-based replacement for blocking prompt(). Resolves the entered string,
// or null on cancel/ESC/backdrop. Mirrors confirmDialog's focus + trap handling.
function promptDialog(message, opts = {}) {
  const {
    defaultValue = '',
    multiline = false,
    placeholder = '',
    confirmText = 'אישור',
    cancelText = 'ביטול',
    title = '',
  } = opts
  return new Promise(resolve => {
    const lastFocused = document.activeElement
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay open'
    overlay.style.zIndex = '1200'

    const box = document.createElement('div')
    box.className = 'modal-box'
    box.style.width = 'min(440px,95vw)'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')

    if (title) {
      const h = document.createElement('div')
      h.className = 'modal-header'
      h.innerHTML = '<h3></h3>'
      const h3 = h.querySelector('h3')
      h3.textContent = title
      h3.id = 'promptDlgTitle' + Date.now()
      box.setAttribute('aria-labelledby', h3.id)
      box.appendChild(h)
    }

    const label = document.createElement('label')
    label.className = 'form-label'
    label.style.cssText = 'display:block;white-space:pre-line;margin-bottom:.5rem'
    label.textContent = message
    box.appendChild(label)

    const field = document.createElement(multiline ? 'textarea' : 'input')
    if (!multiline) field.type = 'text'
    if (multiline) field.rows = 4
    field.value = defaultValue
    if (placeholder) field.placeholder = placeholder
    label.appendChild(field)

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:.6rem;justify-content:flex-end;margin-top:1.25rem'
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'btn-ghost'
    cancelBtn.textContent = cancelText
    const okBtn = document.createElement('button')
    okBtn.className = 'btn-primary'
    okBtn.textContent = confirmText
    actions.appendChild(cancelBtn)
    actions.appendChild(okBtn)
    box.appendChild(actions)
    overlay.appendChild(box)

    const close = val => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus()
      resolve(val)
    }
    const onKey = e => {
      if (e.key === 'Escape') { close(null); return }
      if (e.key === 'Enter' && !multiline) { close(field.value); return }
      if (e.key === 'Tab') _trapFocus(e, box)
    }
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null) })
    cancelBtn.onclick = () => close(null)
    okBtn.onclick = () => close(field.value)
    document.addEventListener('keydown', onKey)

    document.body.appendChild(overlay)
    field.focus()
    field.select && field.select()
  })
}

// ===== BUTTON LOADING =====
// Disables a button and swaps its label for a spinner while `fn` runs.
async function withButtonLoading(btn, fn) {
  if (!btn) return fn()
  const orig = btn.innerHTML
  const w = btn.offsetWidth
  btn.disabled = true
  btn.classList.add('btn-loading')
  if (w) btn.style.minWidth = w + 'px'
  btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>'
  try {
    return await fn()
  } finally {
    btn.disabled = false
    btn.classList.remove('btn-loading')
    btn.style.minWidth = ''
    btn.innerHTML = orig
  }
}

// ===== INLINE VALIDATION =====
function markInvalid(input, msg) {
  if (!input) return
  input.classList.add('input-invalid')
  let hint = input.parentElement && input.parentElement.querySelector(':scope > .field-error')
  if (!hint) {
    hint = document.createElement('div')
    hint.className = 'field-error'
    input.insertAdjacentElement('afterend', hint)
  }
  hint.textContent = msg || ''
  input.addEventListener('input', () => clearInvalid(input), { once: true })
  input.addEventListener('change', () => clearInvalid(input), { once: true })
}
function clearInvalid(input) {
  if (!input) return
  input.classList.remove('input-invalid')
  const hint = input.parentElement && input.parentElement.querySelector(':scope > .field-error')
  if (hint) hint.remove()
}

// ===== EMPTY STATE =====
// Guided empty/first-run placeholder with optional CTA buttons.
//   emptyStateHTML({ icon: uiIcon('download', 30), title:'אין עסקאות', text:'...', actions:[
//     { label:'ייבוא קובץ', onclick:"navigate('import')", primary:true } ]})
function emptyStateHTML({ icon = '', title = '', text = '', actions = [] } = {}) {
  const btns = actions.map(a =>
    `<button class="${a.primary ? 'btn-primary' : 'btn-ghost'}" onclick="${a.onclick}">${a.label}</button>`
  ).join('')
  return `<div class="empty-state">
    ${icon ? `<div class="empty-state-icon">${icon}</div>` : ''}
    ${title ? `<div class="empty-state-title">${title}</div>` : ''}
    ${text ? `<div class="empty-state-text">${text}</div>` : ''}
    ${btns ? `<div class="empty-state-actions">${btns}</div>` : ''}
  </div>`
}

// ===== CHART COLOURS =====
// Single source of truth mirroring the CSS tokens, so chart styling stops
// scattering hardcoded hex across dashboard.js / analysis.js.
const CHART_COLORS = {
  income:    '#10b981',
  incomeBg:  'rgba(16,185,129,.5)',
  expense:   '#f43f5e',
  expenseBg: 'rgba(244,63,94,.5)',
  accent:    '#3b82f6',
  accentBg:  'rgba(59,130,246,.65)',
  muted:     '#64748b',
  mutedBg:   'rgba(100,116,139,.4)',
  grid:      'rgba(255,255,255,0.06)',
  ticks:     '#94a3b8',
  surface:   '#09090b',
  font:      'Heebo',
}
