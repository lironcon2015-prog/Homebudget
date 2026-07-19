// ===== PROPERTY / MORTGAGE TRACKER =====
// Single property for now (קוד מבנה תומך בהרחבה עתידית). הנתונים הם פרטיים
// ולכן לא מאוכלסים בקוד — המשתמש מזין דרך ה-UI; ה-storage הוא localStorage
// ולכן עובר אוטומטית עם הגיבוי ל-Drive (drive.js).

const PROPERTY_TRACKS = {
  '':         { label: '—',           color: 'var(--text-muted)' },
  'fixed':    { label: 'קבוע',        color: '#3b82f6' },
  'prime':    { label: 'פריים',       color: '#22c55e' },
  'variable': { label: 'משתנה',       color: '#f59e0b' },
  'mixed':    { label: 'מעורב',       color: '#a855f7' },
}

const PROPERTY_TYPES = {
  signing: { label: 'חתימה',     icon: '✍️' },
  payment: { label: 'תשלום',     icon: '' },
  tax:     { label: 'מס רכישה',  icon: '🧾' },
  other:   { label: 'אחר',       icon: '' },
}
// icon-or-nothing — several types render without an icon on purpose
function _propTypeText(row) {
  const type = PROPERTY_TYPES[row.type] || PROPERTY_TYPES.other
  const num = row.type === 'payment' && row.paymentNumber ? ` #${row.paymentNumber}` : ''
  return `${type.icon ? type.icon + ' ' : ''}${type.label}${num}`
}

function getProperty() {
  return DB.get('finProperty', { name: 'דירה בנתניה', signedAt: '', basePrice: 0, mortgageCategoryId: '', additionalCosts: [] })
}
function saveProperty(p) { DB.set('finProperty', p) }

function getPropertyPayments() { return DB.get('finPropertyPayments', []) }
function savePropertyPayments(list) { DB.set('finPropertyPayments', list) }

function _propEmptyPayment() {
  return {
    id: genId(),
    dueDate: '', paidDate: '',
    type: 'payment', paymentNumber: null,
    amount: 0, paidAmount: 0, equity: 0, mortgage: 0,
    track: '', notes: '',
  }
}

// ===== TOTALS / DERIVED STATE =====
function _propertyTotals() {
  const p = getProperty()
  const pays = getPropertyPayments()
  
  // סך העלויות הנוספות
  const addCosts = (p.additionalCosts || []).reduce((s, c) => s + (Number(c.amount) || 0), 0)
  const basePrice = Number(p.basePrice) || 0
  
  // מחיר כולל = חוזה + עלויות נוספות (ללא סכימה אוטומטית של מס רכישה מהטבלה)
  const totalDue = basePrice + addCosts

  const totalPaid       = pays.reduce((s, x) => s + (Number(x.paidAmount) || 0), 0)
  const totalEquity     = pays.reduce((s, x) => s + (Number(x.equity) || 0), 0)
  const totalMortgage   = pays.reduce((s, x) => s + (Number(x.mortgage) || 0), 0)
  const denominator     = totalEquity + totalMortgage
  const equityRatio     = denominator > 0 ? totalEquity / denominator : 0
  const remaining       = totalDue - totalPaid
  
  const today = _iso(new Date())
  const unpaid = pays.filter(x => !x.paidDate && (Number(x.amount) || 0) > 0)
  const future = unpaid.filter(x => x.dueDate && x.dueDate >= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const overdue = unpaid.filter(x => x.dueDate && x.dueDate < today).sort((a, b) => b.dueDate.localeCompare(a.dueDate))
  const nextPayment = future[0] || overdue[0] || null
  
  return { p, pays, totalDue, totalPaid, totalEquity, totalMortgage, equityRatio, remaining, nextPayment }
}

function _propertyStatus(row) {
  const today = _iso(new Date())
  const paid = (Number(row.paidAmount) || 0) > 0 && row.paidDate
  if (paid) return { key: 'paid', label: 'שולם', cls: 'prop-st-paid' }
  if (!row.dueDate) return { key: 'tba', label: 'ללא מועד', cls: 'prop-st-tba' }
  if (row.dueDate < today) return { key: 'overdue', label: 'מאחר', cls: 'prop-st-overdue' }
  // 30-day window for "upcoming"
  const dueT = new Date(row.dueDate).getTime()
  const todT = new Date(today).getTime()
  const diffDays = Math.round((dueT - todT) / 86400000)
  if (diffDays <= 30) return { key: 'upcoming', label: 'קרוב', cls: 'prop-st-upcoming' }
  return { key: 'future', label: 'עתידי', cls: 'prop-st-future' }
}

// ===== MORTGAGE PAYMENTS (pulled from existing tx) =====
function getPropertyManualMortgage() { return DB.get('finPropertyManualMortgage', []) }
function savePropertyManualMortgage(list) { DB.set('finPropertyManualMortgage', list) }

function _mortgagePaymentList(catId) {
  const today = _iso(new Date())
  const auto = !catId ? [] : getTransactions().filter(t =>
    t.categoryId === catId &&
    t.date && t.date <= today &&
    (Number(t.amount) || 0) < 0
  ).map(t => ({
    id: t.id, date: t.date, amount: Math.abs(t.amount),
    vendor: t.vendor || '', notes: '', source: 'auto',
  }))
  const manual = getPropertyManualMortgage().map(m => ({
    id: m.id, date: m.date, amount: Number(m.amount) || 0,
    vendor: '', notes: m.notes || '', source: 'manual',
  }))
  return [...auto, ...manual].sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

function _mortgagePaid(catId) {
  const list = _mortgagePaymentList(catId)
  const total = list.reduce((s, x) => s + (Number(x.amount) || 0), 0)
  const count = list.length
  const now = new Date()
  const threeMoAgo = _iso(new Date(now.getFullYear(), now.getMonth() - 3, 1))
  const recent = list.filter(x => x.date >= threeMoAgo)
  const monthlyAvg = recent.length > 0 ? recent.reduce((s, x) => s + x.amount, 0) / 3 : 0
  const recurringMonthly = !catId ? 0 : (typeof getRecurring === 'function' ? getRecurring() : [])
    .filter(r => r.categoryId === catId && r.smoothedMonthly < 0)
    .reduce((s, r) => s + Math.abs(r.smoothedMonthly), 0)
  return { total, count, monthlyAvg, recurringMonthly, list }
}

// ===== RENDER =====
function renderProperty() {
  if (typeof IS_MOBILE_UI !== 'undefined' && IS_MOBILE_UI && typeof M_renderProperty === 'function') return M_renderProperty()
  const container = document.getElementById('propertyBody')
  if (!container) return
  const t = _propertyTotals()
  const p = t.p
  const cats = (typeof getCategories === 'function' ? getCategories() : []).filter(c => c.type === 'expense')
  const mort = _mortgagePaid(p.mortgageCategoryId)
  const mortgageRemaining = Math.max(0, t.totalMortgage - mort.total)
  const monthsLeft = mort.recurringMonthly > 0 ? mortgageRemaining / mort.recurringMonthly : null

  container.innerHTML = `
    ${_propSetupCard(p, cats)}
    ${_propSummaryCards(t)}
    ${_propPaymentsTable(t)}
    ${_propMortgageCard(t, mort, mortgageRemaining, monthsLeft, p)}
    ${_propDocsCard()}
  `
  _syncPropDrawer()
}

function addPropCost() {
  const p = getProperty()
  if (!p.additionalCosts) p.additionalCosts = []
  p.additionalCosts.push({ id: genId(), name: '', amount: 0 })
  saveProperty(p)
  renderProperty()
}

function removePropCost(idx) {
  const p = getProperty()
  if (p.additionalCosts && p.additionalCosts[idx]) {
    p.additionalCosts.splice(idx, 1)
    saveProperty(p)
    renderProperty()
  }
}

function updatePropCost(idx, field, value) {
  const p = getProperty()
  if (p.additionalCosts && p.additionalCosts[idx]) {
    if (field === 'amount') p.additionalCosts[idx][field] = parseFloat(value) || 0
    else p.additionalCosts[idx][field] = value
    saveProperty(p)
    renderProperty()
  }
}

function _propSetupCard(p, cats) {
  const catOpts = ['<option value="">— בחר קטגוריה —</option>']
    .concat(cats.map(c => `<option value="${c.id}" ${p.mortgageCategoryId===c.id?'selected':''}>${catIconText(c)} ${escHtml(c.name)}</option>`))
    .join('')
    
  const costsHtml = (p.additionalCosts || []).map((c, i) => `
    <div style="display:flex; gap:0.5rem; margin-bottom: 0.35rem; align-items:center;">
      <input type="text" class="form-input" placeholder="שם העלות (למשל: מס רכישה / עו''ד)" value="${c.name.replace(/"/g,'&quot;')}" onchange="updatePropCost(${i}, 'name', this.value)">
      <input type="number" class="form-input" placeholder="סכום" value="${c.amount ? c.amount : ''}" onchange="updatePropCost(${i}, 'amount', this.value)" style="width: 110px;">
      <button class="btn-ghost" onclick="removePropCost(${i})" style="padding: 0.2rem 0.5rem; color: var(--expense);" title="מחק עלות">✕</button>
    </div>
  `).join('')

  return `
    <div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>פרטי הנכס</span>
        <div style="display:flex;gap:.5rem">
          <input type="file" id="propXlsxInput" accept=".xlsx,.xls,.csv" style="display:none" onchange="importPropertyXlsx(this.files[0])">
          <button class="btn-ghost" onclick="document.getElementById('propXlsxInput').click()" style="font-size:.85rem;padding:.4rem .9rem">📥 ייבוא מאקסל</button>
        </div>
      </div>
      <div class="prop-setup-grid">
        <label class="form-row"><span class="form-label">שם הנכס</span>
          <input type="text" value="${escAttr(p.name||'')}" oninput="onPropertyMetaChange('name', this.value)" class="form-input"></label>
        <label class="form-row"><span class="form-label">כתובת</span>
          <input type="text" value="${escAttr(p.address||'')}" oninput="onPropertyMetaChange('address', this.value)" class="form-input" placeholder="עיר, רחוב, מספר"></label>
        <label class="form-row"><span class="form-label">מחיר חוזה מקורי</span>
          <input type="text" inputmode="numeric" value="${p.basePrice ? Number(p.basePrice).toLocaleString('en-US') : ''}" onfocus="this.value=this.value.replace(/,/g,'')" onblur="this.value=Number(this.value.replace(/,/g,'')||0).toLocaleString('en-US'); onPropertyMetaChange('basePrice', this.value.replace(/,/g,''))" class="form-input" style="direction:ltr;text-align:left" placeholder="0"></label>
        <label class="form-row"><span class="form-label">תאריך חתימה</span>
          <input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy"
            value="${_isoToDmy(p.signedAt||'')}" oninput="_onDateMaskInput(this)"
            onchange="onPropertyMetaChange('signedAt', _dmyToIso(this.value))" class="form-input" style="min-width: 8.5rem; text-align: center;"></label>
        <label class="form-row"><span class="form-label">שווי שוק נוכחי (אופציונלי)</span>
          <input type="text" inputmode="numeric" value="${p.marketValue ? Number(p.marketValue).toLocaleString('en-US') : ''}" onfocus="this.value=this.value.replace(/,/g,'')" onblur="this.value=Number(this.value.replace(/,/g,'')||0).toLocaleString('en-US'); onPropertyMetaChange('marketValue', this.value.replace(/,/g,''))" class="form-input" style="direction:ltr;text-align:left" placeholder="0"></label>
        <label class="form-row"><span class="form-label">קטגוריית תשלומי משכנתא חודשיים</span>
          <select onchange="onPropertyMetaChange('mortgageCategoryId', this.value)" class="form-input">${catOpts}</select></label>
        
        <label class="form-row" style="grid-column: 1 / -1; margin-top:0.5rem; background: var(--bg-elevated); padding: 0.8rem; border-radius: 8px;">
          <span class="form-label" style="display:flex; justify-content:space-between; margin-bottom:0.75rem;">
            <span>עלויות נוספות לנכס (מס רכישה, עו"ד, תיווך, שמאי וכו')</span>
            <button class="btn-ghost" onclick="addPropCost()" style="font-size:0.75rem; padding: 0.15rem 0.5rem;">+ הוסף עלות</button>
          </span>
          <div id="propAdditionalCosts">
            ${costsHtml || '<span style="font-size:0.8rem;color:var(--text-muted);">לא הוגדרו עלויות נוספות</span>'}
          </div>
        </label>
        
        <label class="form-row" style="grid-column: 1 / -1"><span class="form-label">הערות כלליות לנכס</span>
          <textarea rows="2" onchange="onPropertyMetaChange('notes', this.value)" class="form-input" placeholder="הערות לעצמך — קומה, מ״ר, חניות, מחסן…">${escHtml(p.notes||'')}</textarea></label>
      </div>
    </div>`
}

function _propSummaryCards(t) {
  const ratioPct = (t.equityRatio * 100).toFixed(1)
  const paidPct = t.totalDue > 0 ? Math.min(100, (t.totalPaid / t.totalDue) * 100) : 0
  const next = t.nextPayment
  const nextLine = next
    ? `<div class="prop-next-date">${formatDate(next.dueDate)}</div>
       <div class="prop-next-amt">${formatCurrency(next.amount)}</div>
       ${next.paymentNumber ? `<div style="font-size:.75rem;color:var(--text-muted)">תשלום #${next.paymentNumber}</div>` : ''}`
    : `<div class="prop-next-date" style="color:var(--text-muted)">אין תשלום פתוח</div>`
  return `
    <div class="prop-summary-grid">
      <div class="prop-summary-card">
        <div class="prop-summary-label">מחיר כולל (כולל מיסים וע.נוספות)</div>
        <div class="prop-summary-val">${formatCurrency(t.totalDue)}</div>
        <div class="prop-summary-sub">מחיר חוזה בסיס: ${formatCurrency(Number(t.p.basePrice) || 0)}</div>
      </div>
      <div class="prop-summary-card">
        <div class="prop-summary-label">שולם בפועל</div>
        <div class="prop-summary-val income-color">${formatCurrency(t.totalPaid)}</div>
        <div class="prop-progress-track"><div class="prop-progress-fill" style="width:${paidPct}%"></div></div>
        <div class="prop-summary-sub">${paidPct.toFixed(1)}% מסך ההתחייבות</div>
      </div>
      <div class="prop-summary-card">
        <div class="prop-summary-label">יתרה לתשלום</div>
        <div class="prop-summary-val expense-color">${formatCurrency(t.remaining)}</div>
      </div>
      <div class="prop-summary-card">
        <div class="prop-summary-label">הון עצמי</div>
        <div class="prop-summary-val">${formatCurrency(t.totalEquity)}</div>
        <div class="prop-summary-sub">${ratioPct}% מהמימון ששולם</div>
      </div>
      <div class="prop-summary-card">
        <div class="prop-summary-label">משכנתא</div>
        <div class="prop-summary-val">${formatCurrency(t.totalMortgage)}</div>
        <div class="prop-summary-sub">${(100 - parseFloat(ratioPct)).toFixed(1)}% מהמימון ששולם</div>
      </div>
      <div class="prop-summary-card prop-next-card">
        <div class="prop-summary-label">תשלום הבא</div>
        ${nextLine}
      </div>
    </div>`
}

// Sorted view shared by the table and the drawer's "next row" navigation.
function _propSortedPays() {
  return getPropertyPayments().slice().sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
}

function _propSplitCell(eq, mo, track, mismatchGap) {
  if (eq <= 0 && mo <= 0) {
    return `<div class="prop-split-nums"><span style="color:var(--text-muted)">${mismatchGap ? '' : 'טרם שולם'}</span></div><div class="prop-bar"></div>
      ${mismatchGap ? `<div class="prop-warn-sub">⚠ חסר פיצול הון/משכנתא</div>` : ''}`
  }
  const sum = eq + mo
  const trackLabel = PROPERTY_TRACKS[track]?.label
  return `
    <div class="prop-split-nums"><span class="ps-eq">הון ${eq.toLocaleString('en-US')}</span><span class="ps-mo">משכ׳ ${mo.toLocaleString('en-US')}</span></div>
    <div class="prop-bar"><i class="pb-eq" style="width:${(eq / sum * 100).toFixed(1)}%"></i><i class="pb-mo" style="width:${(mo / sum * 100).toFixed(1)}%"></i></div>
    ${trackLabel && track ? `<div class="prop-track-sub">מסלול: ${trackLabel}</div>` : ''}
    ${mismatchGap ? `<div class="prop-warn-sub">⚠ הון+משכנתא ≠ שולם (${mismatchGap > 0 ? 'חסר' : 'עודף'} ${Math.abs(mismatchGap).toLocaleString('en-US')})</div>` : ''}`
}

function _propPaymentsTable(t) {
  const sorted = t.pays.slice().sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
  const rows = sorted.length === 0
    ? `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem">אין תשלומים. הוסף שורה ↑</td></tr>`
    : sorted.map(_propRow).join('')

  const totalsRow = `
    <tr class="prop-totals-row">
      <td colspan="2">סך הכל</td>
      <td class="prop-amt">${formatCurrency(t.totalDue)}</td>
      <td class="prop-amt prop-amt-paid">${formatCurrency(t.totalPaid)}</td>
      <td class="prop-split">${_propSplitCell(t.totalEquity, t.totalMortgage, '', 0)}</td>
      <td></td>
    </tr>`

  return `
    <div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>טבלת תשלומים (מהקבלן/יזם)</span>
        <button class="btn-primary" onclick="addPropertyPayment()" style="padding:.4rem .9rem;font-size:.85rem">+ הוסף שורה</button>
      </div>
      <table class="data-table prop-rtable">
        <thead><tr>
          <th>סטטוס · סוג</th>
          <th>מועדים</th>
          <th>סכום</th>
          <th>שולם בפועל</th>
          <th>הון ↔ משכנתא</th>
          <th style="text-align:left">פעולות</th>
        </tr></thead>
        <tbody>
          ${rows}
          ${totalsRow}
        </tbody>
      </table>
      <div style="font-size:.75rem;color:var(--text-muted);margin-top:.6rem">
        💡 לחץ על שורה לעריכה. בהזנת "שולם בפועל" + "הון עצמי" — חלק המשכנתא מחושב אוטומטית.
      </div>
    </div>`
}

async function editPropertyNote(id) {
  const list = getPropertyPayments()
  const row = list.find(x => x.id === id)
  if (!row) return
  const newNote = await promptDialog('הזן הערה לשורה זו (השאר ריק כדי למחוק):', { defaultValue: row.notes || '', multiline: true, title: 'הערה לשורה' })
  if (newNote !== null) {
    row.notes = newNote.trim()
    savePropertyPayments(list)
    renderProperty()
  }
}

function _propRow(row) {
  const st = _propertyStatus(row)
  const eq = Number(row.equity) || 0
  const mo = Number(row.mortgage) || 0
  const paid = Number(row.paidAmount) || 0
  const mismatch = paid > 0 && Math.abs(eq + mo - paid) > 1

  let variance = ''
  if (row.dueDate && row.paidDate && row.dueDate !== row.paidDate) {
    const days = Math.round((new Date(row.paidDate) - new Date(row.dueDate)) / 86400000)
    if (days !== 0) variance = ` <span class="prop-var" style="color:${days > 0 ? 'var(--expense)' : 'var(--income)'}">${days > 0 ? '+' : ''}${days} ימים</span>`
  }

  const docCount = propDocCountForPayment(row.id)
  const docChip = docCount > 0
    ? `<span class="prop-chip" onclick="propDocShowForPayment('${row.id}')" title="הצג ${docCount} מסמכים מקושרים">📎${docCount}</span>`
    : `<span class="prop-chip prop-chip-dim" onclick="propDocBrowse('${row.id}')" title="צרף מסמך לתשלום זה">📎+</span>`
  const hasNote = !!row.notes && row.notes.trim() !== ''
  const noteChip = hasNote ? `<span class="prop-chip" title="${escHtml(row.notes)}">💬</span>` : ''

  return `
    <tr class="prop-rrow ${mismatch ? 'prop-row-mismatch' : ''} ${_propDrawerRowId === row.id ? 'prop-row-selected' : ''}" onclick="openPropDrawer('${row.id}')">
      <td><span class="prop-status ${st.cls}">${st.label}</span><div class="prop-type-sub">${_propTypeText(row)}</div></td>
      <td class="prop-dates">
        <div><span class="prop-dt-lbl">מתוכנן</span> ${formatDate(row.dueDate) || '—'}</div>
        <div><span class="prop-dt-lbl">שולם</span> ${row.paidDate ? formatDate(row.paidDate) : '—'}${variance}</div>
      </td>
      <td class="prop-amt">${formatCurrency(row.amount)}</td>
      <td class="prop-amt ${paid > 0 ? 'prop-amt-paid' : ''}">${paid > 0 ? formatCurrency(paid) : '—'}</td>
      <td class="prop-split">${_propSplitCell(eq, mo, row.track, mismatch ? paid - (eq + mo) : 0)}</td>
      <td class="prop-racts" onclick="event.stopPropagation()">${docChip}${noteChip}</td>
    </tr>`
}

// ===== EDIT DRAWER (desktop) =====
// The table is read-only; a row click opens this side panel with the full
// editable field set. Lives outside #propertyBody so renderProperty() can
// repaint the table under it without touching focused inputs.
let _propDrawerRowId = null

function _ensurePropDrawer() {
  let el = document.getElementById('propDrawer')
  if (el) return el
  el = document.createElement('div')
  el.id = 'propDrawer'
  el.className = 'prop-drawer'
  document.body.appendChild(el)
  return el
}

function openPropDrawer(id) {
  const row = getPropertyPayments().find(x => x.id === id)
  if (!row) return
  _propDrawerRowId = id
  const el = _ensurePropDrawer()
  el.innerHTML = _propDrawerHtml(row)
  el.classList.add('open')
  renderProperty()
}

function closePropDrawer() {
  const el = document.getElementById('propDrawer')
  if (el) el.classList.remove('open')
  if (_propDrawerRowId) { _propDrawerRowId = null; renderProperty() }
}

function openPropDrawerNext() {
  const sorted = _propSortedPays()
  const idx = sorted.findIndex(x => x.id === _propDrawerRowId)
  if (idx >= 0 && idx < sorted.length - 1) openPropDrawer(sorted[idx + 1].id)
  else closePropDrawer()
}

async function propDrawerDelete(id) {
  closePropDrawer()
  deletePropertyPayment(id)
}

function _propDrawerHtml(row) {
  const typeOpts = Object.entries(PROPERTY_TYPES)
    .map(([k, v]) => `<option value="${k}" ${row.type === k ? 'selected' : ''}>${v.label}</option>`).join('')
  const trackOpts = Object.entries(PROPERTY_TRACKS)
    .map(([k, v]) => `<option value="${k}" ${row.track === k ? 'selected' : ''}>${v.label}</option>`).join('')
  const id = row.id
  const dateF = (k, val, lbl) => `<div class="prop-fld"><label>${lbl}</label>
    <input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" value="${_isoToDmy(val || '')}" oninput="_onDateMaskInput(this)" onchange="onPropertyRowChange('${id}','${k}',_dmyToIso(this.value))" data-field="${k}"></div>`
  const numF = (k, val, lbl) => `<div class="prop-fld"><label>${lbl}</label>
    <input type="number" inputmode="decimal" min="0" value="${val || ''}" placeholder="0" onchange="onPropertyRowChange('${id}','${k}',this.value)" data-field="${k}"></div>`
  const hasNext = (() => { const s = _propSortedPays(); const i = s.findIndex(x => x.id === id); return i >= 0 && i < s.length - 1 })()

  return `
    <div class="prop-drawer-head">
      <h3>✏️ עריכת ${_propTypeText(row)}</h3>
      <button class="modal-close" aria-label="סגור" onclick="closePropDrawer()">✕</button>
    </div>
    <div class="prop-fgrid">
      ${dateF('dueDate', row.dueDate, 'מועד מתוכנן')}
      ${dateF('paidDate', row.paidDate, 'תאריך תשלום בפועל')}
      <div class="prop-fld"><label>סוג</label>
        <select onchange="onPropertyRowChange('${id}','type',this.value)" data-field="type">${typeOpts}</select></div>
      ${numF('paymentNumber', row.paymentNumber, 'מספר תשלום')}
      ${numF('amount', row.amount, 'סכום')}
      ${numF('paidAmount', row.paidAmount, 'שולם בפועל')}
      ${numF('equity', row.equity, 'הון עצמי')}
      ${numF('mortgage', row.mortgage, 'משכנתא')}
      <div class="prop-fld"><label>מסלול</label>
        <select onchange="onPropertyRowChange('${id}','track',this.value)" data-field="track">${trackOpts}</select></div>
      <div class="prop-fld"><label>הערות</label>
        <input type="text" value="${escHtml(row.notes || '')}" placeholder="—" onchange="onPropertyRowChange('${id}','notes',this.value)" data-field="notes"></div>
    </div>
    <div class="prop-drawer-docs" id="propDrawerDocs">${_propDrawerDocsHtml(id)}</div>
    <div class="prop-drawer-btns">
      ${hasNext ? `<button class="btn-primary" onclick="openPropDrawerNext()">שמור ופתח את הבא ↓</button>` : ''}
      <button class="btn-ghost" onclick="closePropDrawer()">${hasNext ? 'סגור' : 'שמור וסגור'}</button>
      <button class="btn-ghost" style="color:var(--expense)" onclick="propDrawerDelete('${id}')" title="מחק שורה">🗑</button>
    </div>`
}

function _propDrawerDocsHtml(id) {
  const docs = (typeof getPropertyDocs === 'function' ? getPropertyDocs() : []).filter(d => d.linkedPaymentId === id)
  const items = docs.map(d => {
    const c = _pdCat(d.docType)
    return `<div class="prop-drawer-doc" onclick="propDocView('${d.id}')">${c.icon} ${escHtml(_pdDisplayName(d))}${d.driveFileId ? ' <span style="opacity:.6">☁✓</span>' : ''}</div>`
  }).join('')
  return `
    <div class="prop-drawer-docs-title">📎 מסמכים מקושרים${docs.length ? ` (${docs.length})` : ''}</div>
    ${items || '<div style="font-size:.75rem;color:var(--text-muted)">אין מסמכים מקושרים</div>'}
    <div class="prop-drawer-doc" style="color:var(--accent)" onclick="propDocBrowse('${id}')">＋ צרף מסמך</div>`
}

// Values may change under the drawer (auto-fill of mortgage/equity) — refresh
// unfocused inputs and the docs list without rebuilding focused ones.
function _syncPropDrawer() {
  const el = document.getElementById('propDrawer')
  if (!el || !_propDrawerRowId) return
  const row = getPropertyPayments().find(x => x.id === _propDrawerRowId)
  if (!row) { closePropDrawer(); return }
  el.querySelectorAll('[data-field]').forEach(inp => {
    if (inp === document.activeElement) return
    const k = inp.dataset.field
    if (k === 'dueDate' || k === 'paidDate') inp.value = _isoToDmy(row[k] || '')
    else if (k === 'notes' || k === 'type' || k === 'track') inp.value = row[k] || (k === 'notes' ? '' : inp.value)
    else inp.value = row[k] || ''
  })
  const docsEl = document.getElementById('propDrawerDocs')
  if (docsEl) docsEl.innerHTML = _propDrawerDocsHtml(_propDrawerRowId)
}

function _propMortgageCard(t, mort, mortgageRemaining, monthsLeft, p) {
  const cat = p.mortgageCategoryId ? getCategoryById(p.mortgageCategoryId) : null
  const paidPct = t.totalMortgage > 0 ? Math.min(100, (mort.total / t.totalMortgage) * 100) : 0
  const monthsLine = monthsLeft != null && isFinite(monthsLeft) && monthsLeft > 0
    ? `<div class="prop-summary-sub">~${Math.round(monthsLeft)} חודשים בקצב הנוכחי</div>`
    : ''
  const subline = cat
    ? `מבוסס על קטגוריה: <b>${catIconHTML(cat)} ${escHtml(cat.name)}</b> + רישומים ידניים. לא כולל את תשלומי הרכישה למעלה.`
    : 'בחר קטגוריה למעלה כדי לשלב גם החזרים אוטומטיים ממסך ההוצאות. ניתן להזין רישומים ידניים בכל מקרה.'
  return `
    <div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>תשלומי משכנתא חודשיים (לבנק)</span>
        <button class="btn-ghost" onclick="openMortgagePaidModal()" style="font-size:.85rem;padding:.4rem .9rem">📋 פירוט תשלומים</button>
      </div>
      <div style="font-size:.85rem;color:var(--text-muted);margin-bottom:.75rem">${subline}</div>
      <div class="prop-summary-grid">
        <div class="prop-summary-card prop-card-clickable" onclick="openMortgagePaidModal()" title="לחץ לראות את כל התשלומים">
          <div class="prop-summary-label">סך ששולם עד היום ↗</div>
          <div class="prop-summary-val expense-color">${formatCurrency(mort.total)}</div>
          <div class="prop-summary-sub">${mort.count} תשלומים</div>
        </div>
        <div class="prop-summary-card">
          <div class="prop-summary-label">החזר חודשי שקול</div>
          <div class="prop-summary-val">${formatCurrency(mort.recurringMonthly || mort.monthlyAvg)}</div>
          <div class="prop-summary-sub">${mort.recurringMonthly > 0 ? 'מזיהוי הוצאה קבועה' : 'ממוצע 3 חודשים'}</div>
        </div>
        <div class="prop-summary-card">
          <div class="prop-summary-label">יתרת קרן (ללא ריבית)</div>
          <div class="prop-summary-val">${formatCurrency(mortgageRemaining)}</div>
          <div class="prop-progress-track"><div class="prop-progress-fill" style="width:${paidPct}%"></div></div>
          ${monthsLine}
        </div>
      </div>
      <div style="font-size:.75rem;color:var(--text-muted);margin-top:.6rem">
        💡 "יתרת קרן" היא אומדן גס — היא לא מפרידה בין קרן לריבית. לחישוב מדויק נדרש לוח סילוקין מלא של כל מסלול.
      </div>
    </div>`
}

// ===== EVENT HANDLERS =====
function onPropertyMetaChange(field, value) {
  const p = getProperty()
  if (field === 'basePrice') p[field] = parseFloat(value) || 0
  else p[field] = value
  saveProperty(p)
  renderProperty()
}

function onPropertyRowChange(id, field, value) {
  const list = getPropertyPayments()
  const row = list.find(x => x.id === id)
  if (!row) return
  if (['amount', 'paidAmount', 'equity', 'mortgage'].includes(field)) {
    row[field] = parseFloat(value) || 0
    // Auto-fill mortgage = paid - equity when user enters paid + equity but
    // mortgage is empty/zero. Same logic in reverse for equity.
    if (field === 'paidAmount' || field === 'equity') {
      const paid = Number(row.paidAmount) || 0
      const eq = Number(row.equity) || 0
      if (paid > 0 && eq > 0 && (Number(row.mortgage) || 0) === 0) {
        row.mortgage = Math.max(0, paid - eq)
      }
    }
    if (field === 'paidAmount' || field === 'mortgage') {
      const paid = Number(row.paidAmount) || 0
      const mo = Number(row.mortgage) || 0
      if (paid > 0 && mo > 0 && (Number(row.equity) || 0) === 0) {
        row.equity = Math.max(0, paid - mo)
      }
    }
  } else if (field === 'paymentNumber') {
    row[field] = value === '' ? null : (parseInt(value, 10) || null)
  } else {
    row[field] = value
  }
  savePropertyPayments(list)
  renderProperty()
}

function addPropertyPayment() {
  const list = getPropertyPayments()
  // Default new row to next payment number if any prior payments exist.
  const maxNum = list.filter(x => x.type === 'payment' && x.paymentNumber)
    .reduce((m, x) => Math.max(m, x.paymentNumber), 0)
  const row = _propEmptyPayment()
  row.paymentNumber = maxNum + 1
  list.push(row)
  savePropertyPayments(list)
  renderProperty()
}

async function deletePropertyPayment(id) {
  if (!await confirmDialog('למחוק את השורה?', { danger: true, confirmText: 'מחק' })) return
  const list = getPropertyPayments().filter(x => x.id !== id)
  savePropertyPayments(list)
  renderProperty()
}

// ===== MORTGAGE PAID DRILL-DOWN =====
function openMortgagePaidModal() {
  _renderMortgagePaidModal()
  document.getElementById('mortgagePaidModal').classList.add('open')
}
function closeMortgagePaidModal() {
  document.getElementById('mortgagePaidModal').classList.remove('open')
}

function _renderMortgagePaidModal() {
  const p = getProperty()
  const mort = _mortgagePaid(p.mortgageCategoryId)
  // Group by month for the by-month summary the user asked for.
  const byMonth = {}
  for (const x of mort.list) {
    const ym = (x.date || '').slice(0, 7)
    if (!ym) continue
    byMonth[ym] = (byMonth[ym] || 0) + (Number(x.amount) || 0)
  }
  const monthsSorted = Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]))

  const monthRows = monthsSorted.length === 0
    ? `<tr><td colspan="2" style="text-align:center;color:var(--text-muted);padding:1.25rem">אין תשלומים</td></tr>`
    : monthsSorted.map(([ym, sum]) => {
        const [y, m] = ym.split('-')
        return `<tr><td>${m}/${y}</td><td style="text-align:end;font-weight:600">${formatCurrency(sum)}</td></tr>`
      }).join('')

  const detailRows = mort.list.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:1.25rem">אין תשלומים</td></tr>`
    : mort.list.map(x => {
        const srcBadge = x.source === 'manual'
          ? '<span class="prop-status prop-st-tba">ידני</span>'
          : '<span class="prop-status prop-st-paid">אוטו׳</span>'
        const delBtn = x.source === 'manual'
          ? `<button class="btn-ghost" style="font-size:.75rem;padding:.2rem .55rem;color:var(--expense)" onclick="deleteManualMortgage('${x.id}')">🗑</button>`
          : ''
        return `<tr>
          <td>${formatDate(x.date)}</td>
          <td>${srcBadge}</td>
          <td>${escHtml(x.vendor || x.notes || '')}</td>
          <td style="text-align:end;font-weight:600">${formatCurrency(x.amount)}</td>
          <td>${delBtn}</td>
        </tr>`
      }).join('')

  const totalMonthly = mort.recurringMonthly || mort.monthlyAvg
  const today = _iso(new Date())
  document.getElementById('mortgagePaidBody').innerHTML = `
    <div class="prop-summary-grid" style="margin-bottom:1rem">
      <div class="prop-summary-card">
        <div class="prop-summary-label">סך כולל</div>
        <div class="prop-summary-val expense-color">${formatCurrency(mort.total)}</div>
        <div class="prop-summary-sub">${mort.count} תשלומים</div>
      </div>
      <div class="prop-summary-card">
        <div class="prop-summary-label">חודשי שקול</div>
        <div class="prop-summary-val">${formatCurrency(totalMonthly)}</div>
        <div class="prop-summary-sub">${mort.recurringMonthly > 0 ? 'מזיהוי הוצאה קבועה' : 'ממוצע 3 חודשים'}</div>
      </div>
    </div>

    <div class="card" style="background:rgba(34,197,94,.06);border-color:rgba(34,197,94,.25);margin-bottom:1rem">
      <div class="card-title" style="font-size:1rem">+ הוסף תשלום ידני</div>
      <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:.6rem">שימושי לתשלומים שנעשו לפני שהתחלת לעקוב באפליקציה.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.6rem;align-items:end">
        <label class="form-row"><span class="form-label">תאריך</span>
          <input id="manualMortDate" type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" value="${_isoToDmy(today)}" oninput="_onDateMaskInput(this)" class="form-input"></label>
        <label class="form-row"><span class="form-label">סכום</span>
          <input id="manualMortAmount" type="number" min="0" step="100" placeholder="0" class="form-input"></label>
        <label class="form-row" style="grid-column: span 2"><span class="form-label">הערה</span>
          <input id="manualMortNotes" type="text" placeholder="לדוגמה: החזר ינואר 2024" class="form-input"></label>
        <button class="btn-primary" onclick="addManualMortgage()" style="height:2.4rem">הוסף</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns: 1fr 2fr;gap:1.25rem">
      <div>
        <h4 style="margin:0 0 .5rem">סיכום חודשי</h4>
        <table class="data-table">
          <thead><tr><th>חודש</th><th style="text-align:end">סכום</th></tr></thead>
          <tbody>${monthRows}</tbody>
        </table>
      </div>
      <div>
        <h4 style="margin:0 0 .5rem">פירוט תשלומים</h4>
        <table class="data-table">
          <thead><tr><th>תאריך</th><th>מקור</th><th>פירוט</th><th style="text-align:end">סכום</th><th></th></tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
      </div>
    </div>`
}

function addManualMortgage() {
  const dateInput = document.getElementById('manualMortDate')
  const amtInput  = document.getElementById('manualMortAmount')
  const notesInput= document.getElementById('manualMortNotes')
  const date = _dmyToIso(dateInput.value)
  const amount = parseFloat(amtInput.value) || 0
  if (!date || amount <= 0) { toast('נדרשים תאריך וסכום', { type: 'error' }); return }
  const list = getPropertyManualMortgage()
  list.push({ id: genId(), date, amount, notes: notesInput.value || '' })
  savePropertyManualMortgage(list)
  _renderMortgagePaidModal()
  renderProperty()
}

async function deleteManualMortgage(id) {
  if (!await confirmDialog('למחוק את התשלום?', { danger: true, confirmText: 'מחק' })) return
  const list = getPropertyManualMortgage().filter(x => x.id !== id)
  savePropertyManualMortgage(list)
  _renderMortgagePaidModal()
  renderProperty()
}

// ===== EXCEL IMPORT =====
// Maps the user's Hebrew column names to the schema. Columns may be partial;
// missing columns are tolerated. Type column maps Hebrew labels → enum.
function importPropertyXlsx(file) {
  if (!file) return
  if (typeof XLSX === 'undefined') { toast('ספריית האקסל לא נטענה', { type: 'error' }); return }
  const reader = new FileReader()
  reader.onload = async e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
      const mapped = []
      
      for (const r of rows) {
        const row = _propEmptyPayment()
        
        for (const k of Object.keys(r)) {
          const key = String(k).trim()
          const v = r[k]
          
          if (key.includes('מועד') || /due.?date/i.test(key)) row.dueDate = _xlsxToIso(v)
          else if ((key.includes('תאריך') && key.includes('תשלום')) || /paid.?date/i.test(key)) row.paidDate = _xlsxToIso(v)
          else if ((key.includes('תשלום') && key.includes('פעולה')) || /^type$/i.test(key)) row.type = _propTypeFromHebrew(v)
          else if ((key.includes('מס') && key.includes('תשלום')) || /payment.?(no|num)/i.test(key)) {
            const n = parseInt(String(v).replace(/\D/g, ''), 10)
            row.paymentNumber = isFinite(n) ? n : null
          }
          else if (key.includes('סכום') || /^amount$/i.test(key)) row.amount = _xlsxToNumber(v)
          else if (key.includes('שולם') || /paid.?amount/i.test(key)) row.paidAmount = _xlsxToNumber(v)
          else if ((key.includes('הון') && key.includes('עצמי')) || /^equity$/i.test(key)) row.equity = _xlsxToNumber(v)
          else if (key.includes('משכנתא') || /^mortgage$/i.test(key)) row.mortgage = _xlsxToNumber(v)
          else if (key.includes('הער') || /^notes?$/i.test(key)) row.notes = String(v || '')
          else if (key.includes('מסלול') || /^track$/i.test(key)) row.track = _propTrackFromHebrew(v)
        }
        
        // סינון שורות ריקות ושורות סיכום בתחתית.
        // שורה חוקית חייבת להכיל מספר כספי כלשהו באחת מעמודות הכסף!
        if (!row.amount && !row.paidAmount && !row.equity && !row.mortgage) continue
        
        mapped.push(row)
      }
      
      if (mapped.length === 0) { toast('לא נמצאו שורות תקפות באקסל', { type: 'error' }); return }
      if (!await confirmDialog(`לייבא ${mapped.length} שורות? פעולה זו תחליף את הטבלה הקיימת.`, { danger: true, confirmText: 'ייבא' })) return
      savePropertyPayments(mapped)
      renderProperty()
      toast(`יובאו ${mapped.length} שורות`, { type: 'success' })
    } catch (err) {
      toast('שגיאה בקריאת האקסל: ' + err.message, { type: 'error' })
    }
    document.getElementById('propXlsxInput').value = ''
  }
  reader.readAsArrayBuffer(file)
}

function _xlsxToIso(v) {
  if (!v) return ''
  if (v instanceof Date) {
    // חובה להשתמש ב-UTC כדי להתגבר על קפיצות אזורי הזמן של אקסל
    const y = v.getUTCFullYear()
    const m = v.getUTCMonth() + 1
    const d = v.getUTCDate()
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
  }
  const s = String(v).trim()
  if (!s) return ''
  // תפיסה מדויקת של יום/חודש/שנה בצורה של מחרוזת מפורשת
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2}|\d{4})$/)
  if (m) {
    let yy = m[3]
    if (yy.length === 2) yy = (parseInt(yy, 10) >= 70 ? '19' : '20') + yy
    return `${yy}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`
  }
  return ''
}

function _xlsxToNumber(v) {
  if (typeof v === 'number') return v
  if (!v) return 0
  // מחיקת סימני מטבע, פסיקים, רווחים ותאים שמכילים מקף או N/A
  const s = String(v).replace(/[₪,\s]/g, '').replace(/^-+$/, '')
  if (/n\/a/i.test(s)) return 0
  const n = parseFloat(s)
  return isFinite(n) ? n : 0
}

function _propTypeFromHebrew(v) {
  const s = String(v || '').trim()
  if (/חתימה/.test(s)) return 'signing'
  if (/מס\s*רכישה/.test(s)) return 'tax'
  if (/תשלום/.test(s)) return 'payment'
  if (!s) return 'other'
  return 'other'
}

function _propTrackFromHebrew(v) {
  const s = String(v || '').trim()
  if (/פריים/.test(s)) return 'prime'
  if (/קבוע/.test(s)) return 'fixed'
  if (/משתנה/.test(s)) return 'variable'
  if (/מעורב|משולב/.test(s)) return 'mixed'
  return ''
}
