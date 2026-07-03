// ===== IMPORT TEMPLATE WIZARD =====
// Shown when a user imports a file whose header signature doesn't match any
// saved template. Lets the user map columns → fields, then parses.

let _wizardState = null
// { rows, file, accountId, headerRowIndex, columns, dateFormat, amountMode, name, lockToAccount }

const ROLE_OPTIONS = [
  { v: 'ignore',      l: 'התעלם' },
  { v: 'date',        l: 'תאריך עסקה' },
  { v: 'chargeDate',  l: 'תאריך חיוב (כרטיס אשראי)' },
  { v: 'amount',      l: 'סכום (חתום)' },
  { v: 'debit',       l: 'חובה / הוצאה' },
  { v: 'credit',      l: 'זכות / הכנסה' },
  { v: 'vendor',      l: 'ספק' },
  { v: 'description', l: 'תיאור' },
  { v: 'category',    l: 'קטגוריה' },
  { v: 'balance',     l: 'יתרה (להתעלמות)' },
]

const DATE_FORMAT_OPTIONS = [
  { v: 'DD/MM/YYYY', l: 'DD/MM/YYYY' },
  { v: 'DD/MM/YY',   l: 'DD/MM/YY' },
  { v: 'MM/DD/YYYY', l: 'MM/DD/YYYY' },
  { v: 'YYYY-MM-DD', l: 'YYYY-MM-DD' },
]

function openTplWizard(file, accountId, rows) {
  const headerRowIndex = guessHeaderRow(rows)
  _wizardState = {
    file, accountId, rows,
    headerRowIndex,
    columns: _guessColumnMapping(rows, headerRowIndex),
    dateFormat: 'DD/MM/YYYY',
    name: _guessTemplateName(file.name, rows, headerRowIndex),
    lockToAccount: false,
    flipAmountSign: false,
  }
  document.getElementById('tplWizardModal').classList.add('open')
  _renderWizard()
}

function closeTplWizard() {
  document.getElementById('tplWizardModal').classList.remove('open')
  _wizardState = null
}

function _guessColumnMapping(rows, headerRowIndex) {
  const header = (rows[headerRowIndex] || []).map(_normHeaderCell)
  const mapping = header.map(() => 'ignore')
  const matchOne = (patterns, role) => {
    for (let i = 0; i < header.length; i++) {
      if (mapping[i] !== 'ignore') continue
      if (patterns.some(p => header[i].includes(p))) { mapping[i] = role; return }
    }
  }
  // Charge date FIRST so a header literally named "תאריך חיוב" doesn't get
  // greedily eaten by the generic "תאריך" matcher below.
  matchOne(['תאריך חיוב', 'מועד חיוב', 'יום חיוב', 'charge date', 'billing date'], 'chargeDate')
  matchOne(['תאריך'], 'date')
  matchOne(['חובה', 'debit'], 'debit')
  matchOne(['זכות', 'credit'], 'credit')
  // If no debit/credit split, look for signed amount
  if (!mapping.includes('debit') && !mapping.includes('credit')) {
    matchOne(['סכום', 'amount'], 'amount')
  }
  matchOne(['ספק', 'תיאור', 'פירוט', 'עסקה', 'שם', 'vendor', 'description', 'merchant'], 'vendor')
  matchOne(['הערה', 'נוסף', 'comment', 'notes'], 'description')
  matchOne(['קטגוריה', 'category'], 'category')
  matchOne(['יתרה', 'balance'], 'balance')
  return mapping
}

function _guessTemplateName(filename, rows, headerRowIndex) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').trim()
  return base.slice(0, 40) || 'תבנית חדשה'
}

function _renderWizard() {
  if (!_wizardState) return
  const { rows, headerRowIndex, columns, dateFormat, name, lockToAccount, flipAmountSign } = _wizardState
  const header = rows[headerRowIndex] || []
  const preview = rows.slice(headerRowIndex + 1, headerRowIndex + 6)

  const body = document.getElementById('tplWizardBody')

  const headerRowSelector = `
    <div class="form-row">
      <label class="form-label">שורת כותרות</label>
      <select id="tplHeaderRow" onchange="_wizardChangeHeaderRow(this.value)">
        ${rows.slice(0, Math.min(15, rows.length)).map((r, i) =>
          `<option value="${i}" ${i===headerRowIndex?'selected':''}>שורה ${i+1} — ${r.slice(0,4).map(c => String(c??'').slice(0,18)).join(' | ')}</option>`
        ).join('')}
      </select>
    </div>`

  const columnTable = `
    <div style="overflow-x:auto;margin:.75rem 0">
      <table class="tpl-map-table">
        <thead>
          <tr>${header.map((h, i) => `<th>${String(h ?? '').slice(0,30) || `עמודה ${i+1}`}</th>`).join('')}</tr>
          <tr>${header.map((_, i) => `
            <th>
              <select class="tpl-role-select" data-col="${i}" onchange="_wizardChangeRole(${i}, this.value)">
                ${ROLE_OPTIONS.map(o => `<option value="${o.v}" ${columns[i]===o.v?'selected':''}>${o.l}</option>`).join('')}
              </select>
            </th>`).join('')}</tr>
        </thead>
        <tbody>
          ${preview.map(r => `<tr>${header.map((_, i) => `<td>${String(r?.[i] ?? '').slice(0,40)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`

  const dateFormatRow = `
    <div class="form-row" style="display:${columns.includes('date') ? 'block' : 'none'}">
      <label class="form-label">פורמט תאריך</label>
      <select id="tplDateFormat" onchange="_wizardState.dateFormat=this.value;_wizardRenderPreview()">
        ${DATE_FORMAT_OPTIONS.map(o => `<option value="${o.v}" ${dateFormat===o.v?'selected':''}>${o.l}</option>`).join('')}
      </select>
    </div>`

  const flipRow = `
    <div class="form-row" style="display:${columns.includes('amount') ? 'block' : 'none'}">
      <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
        <input type="checkbox" id="tplFlipSign" ${flipAmountSign?'checked':''}
          onchange="_wizardState.flipAmountSign=this.checked;_wizardRenderPreview()" style="width:auto">
        <span>הפוך סימן (אם סכומים חיוביים = הוצאות)</span>
      </label>
    </div>`

  const nameRow = `
    <div class="form-row">
      <label class="form-label">שם התבנית</label>
      <input type="text" id="tplName" value="${(typeof escAttr === 'function' ? escAttr(name) : name)}" oninput="_wizardState.name=this.value">
    </div>
    <div class="form-row">
      <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
        <input type="checkbox" id="tplLock" ${lockToAccount?'checked':''}
          onchange="_wizardState.lockToAccount=this.checked" style="width:auto">
        <span>נעל תבנית זו לחשבון הנוכחי</span>
      </label>
    </div>`

  body.innerHTML = `
    ${headerRowSelector}
    <div style="font-size:.85rem;color:var(--text-muted);margin:.5rem 0">
      בחר לכל עמודה את התפקיד שלה. המערכת תזכור את המיפוי הזה לפי חתימת שורת הכותרות.
    </div>
    ${columnTable}
    ${dateFormatRow}
    ${flipRow}
    ${nameRow}
    <div id="tplPreviewResult" style="margin-top:.75rem"></div>`

  _wizardRenderPreview()
}

function _wizardChangeHeaderRow(val) {
  _wizardState.headerRowIndex = Number(val)
  _wizardState.columns = _guessColumnMapping(_wizardState.rows, _wizardState.headerRowIndex)
  _renderWizard()
}

function _wizardChangeRole(col, role) {
  _wizardState.columns[col] = role
  // Only one of each role (except description+vendor can coexist)
  if (role !== 'ignore') {
    for (let i = 0; i < _wizardState.columns.length; i++) {
      if (i !== col && _wizardState.columns[i] === role) _wizardState.columns[i] = 'ignore'
    }
  }
  _renderWizard()
}

function _buildTemplateFromWizard() {
  const { rows, headerRowIndex, columns, dateFormat, flipAmountSign } = _wizardState
  const header = rows[headerRowIndex] || []
  const findIdx = (role) => columns.indexOf(role)
  const amountIdx = findIdx('amount')
  const debitIdx  = findIdx('debit')
  const creditIdx = findIdx('credit')

  const chargeDateIdx = findIdx('chargeDate')
  const tplColumns = {
    date: { index: findIdx('date'), format: dateFormat },
    chargeDate: chargeDateIdx >= 0 ? { index: chargeDateIdx, format: dateFormat } : null,
    amount: amountIdx >= 0
      ? { mode: 'signed', index: amountIdx, flipSign: !!flipAmountSign }
      : (debitIdx >= 0 || creditIdx >= 0)
        ? { mode: 'debit_credit', debitIndex: debitIdx, creditIndex: creditIdx }
        : null,
    vendor:      findIdx('vendor') >= 0 ? { index: findIdx('vendor') } : null,
    description: findIdx('description') >= 0 ? { index: findIdx('description') } : null,
    category:    findIdx('category') >= 0 ? { index: findIdx('category') } : null,
    balance:     findIdx('balance') >= 0 ? { index: findIdx('balance') } : null,
  }

  return {
    id: genId(),
    name: _wizardState.name || 'תבנית',
    signature: computeHeaderSignature(header),
    accountId: _wizardState.lockToAccount ? _wizardState.accountId : null,
    headerRowIndex,
    skipFooterRows: 0,
    columns: tplColumns,
    createdAt: Date.now(),
    lastUsedAt: null,
    txCount: 0,
    headerPreview: header.slice(0, 6).map(h => String(h ?? '').slice(0, 20)),
  }
}

function _wizardRenderPreview() {
  const { rows, columns } = _wizardState
  const el = document.getElementById('tplPreviewResult')
  if (!el) return

  const missing = []
  if (!columns.includes('date')) missing.push('תאריך')
  if (!columns.includes('amount') && !(columns.includes('debit') || columns.includes('credit'))) missing.push('סכום')
  if (!columns.includes('vendor')) missing.push('ספק')

  if (missing.length) {
    el.innerHTML = `<div class="tpl-preview-warn">חסר מיפוי: ${missing.join(', ')}</div>`
    document.getElementById('tplWizardSaveBtn').disabled = true
    document.getElementById('tplWizardStatus').textContent = ''
    return
  }

  const tpl = _buildTemplateFromWizard()
  const { transactions, stats } = parseWithTemplate(rows, tpl)
  document.getElementById('tplWizardSaveBtn').disabled = false
  document.getElementById('tplWizardStatus').textContent =
    `${stats.parsed} תנועות יחולצו${stats.skipped ? `, ${stats.skipped} ידולגו` : ''}`

  const sample = transactions.slice(0, 3)
  el.innerHTML = `
    <div class="tpl-preview-ok">תצוגה מקדימה — 3 תנועות ראשונות:</div>
    <div class="tpl-preview-list">
      ${sample.map(t => `
        <div class="tpl-preview-tx">
          <span>${t.date}</span>
          <span style="font-weight:500">${t.vendor}</span>
          <span style="font-weight:700;color:${t.amount > 0 ? 'var(--income)' : 'var(--expense)'}">${t.amount > 0 ? '+' : ''}${t.amount}</span>
        </div>`).join('')}
    </div>`
}

function saveTplWizard() {
  if (!_wizardState) return
  const tpl = _buildTemplateFromWizard()
  upsertTemplate(tpl)
  const { file, accountId, rows } = _wizardState
  closeTplWizard()
  // Hand control back to import flow with the freshly-saved template
  continueImportWithTemplate(file, accountId, rows, tpl)
}
