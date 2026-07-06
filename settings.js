function renderSettings() {
  renderAccountList()
  renderCategoryList()
  const key = getApiKey()
  document.getElementById('apiKeyInput').value = key
  document.getElementById('apiKeyMsg').textContent = key ? '✅ מפתח שמור' : ''
  document.getElementById('apiKeyMsg').style.color = 'var(--income)'
  loadGeminiModelsToUI()
  document.getElementById('accCount').textContent = `${getAccounts().length} חשבונות`
  document.getElementById('promptInput').value = getPrompt()
  document.getElementById('promptMsg').textContent = ''
  renderImportBatches()
  renderTemplatesList()
  renderRulesList()
  renderAliasList()
  renderReconcileAccountSelector()
  renderReconcileTable()
  if (typeof loadGithubConfig === 'function') loadGithubConfig()
  if (typeof renderFeedbackList === 'function') renderFeedbackList()
  document.getElementById('appVersion').textContent = 'גרסה ' + APP_VERSION
}

// ===== BALANCE RECONCILIATION =====
// Per-month "did we get the bank balance right" tool. The user types in the
// end-of-month balance from each bank statement, we compute the same number
// from getAccountBalance(uptoLastOfMonth) and flag the first month where the
// two diverge — that's where the bookkeeping bug sits (duplicate row, wrong
// sign, missed line, mis-typed transfer, etc).
function getReconciliationData() { return DB.getObj('finReconciliation', {}) }
function setReconciliationData(d) { DB.set('finReconciliation', d) }

// Default to checking/cash accounts — savings/investment balances aren't
// real-time accurate so reconciling them against a bank statement is noisy.
function renderReconcileAccountSelector() {
  const sel = document.getElementById('reconcileAccount')
  if (!sel) return
  const accs = getAccounts().filter(a => a.type === 'checking' || a.type === 'cash')
  if (accs.length === 0) {
    sel.innerHTML = '<option value="">אין חשבון עו"ש/מזומן</option>'
    return
  }
  const prev = sel.value
  sel.innerHTML = accs.map(a => `<option value="${a.id}">${escHtml(a.name)}${a.institution?' – '+escHtml(a.institution):''}</option>`).join('')
  if (prev && accs.some(a => a.id === prev)) sel.value = prev
}

function _lastDayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m, 0)
  return _iso(d)
}

// Earliest tx date that touches the account (either side of a mirror link).
// Falls back to "current month" when the account has no tx yet.
function _earliestTxDateForAccount(accountId) {
  const dates = getTransactions()
    .filter(t => t.accountId === accountId
              || t.transferAccountId === accountId
              || t.ccPaymentForAccountId === accountId)
    .map(t => t.date)
    .filter(Boolean)
    .sort()
  return dates[0] || _iso(new Date())
}

function _monthsInRange(startIso, endIso) {
  if (!startIso) return []
  const [sy, sm] = startIso.split('-').map(Number)
  const [ey, em] = endIso.split('-').map(Number)
  const months = []
  let y = sy, mo = sm
  while (y < ey || (y === ey && mo <= em)) {
    months.push(`${y}-${String(mo).padStart(2,'0')}`)
    mo++
    if (mo > 12) { mo = 1; y++ }
  }
  return months
}

function renderReconcileTable() {
  const sel = document.getElementById('reconcileAccount')
  const wrap = document.getElementById('reconcileTable')
  if (!sel || !wrap) return
  const accountId = sel.value
  if (!accountId) { wrap.innerHTML = ''; return }
  const acc = getAccounts().find(a => a.id === accountId)
  if (!acc) { wrap.innerHTML = ''; return }

  const startIso = _earliestTxDateForAccount(accountId)
  const endIso = _iso(new Date())
  const months = _monthsInRange(startIso, endIso)
  if (months.length === 0) {
    wrap.innerHTML = '<p style="color:var(--text-muted);font-size:.9rem">אין עסקאות בחשבון.</p>'
    return
  }

  const recAll = getReconciliationData()
  const recForAcc = recAll[accountId] || {}

  // Build rows in chronological order so the FIRST divergence stands out as
  // the failure point — bugs cascade forward so anything after that month
  // is downstream noise.
  const rows = months.map(ym => {
    const lastDay = _lastDayOfMonth(ym)
    const computed = getAccountBalance(accountId, lastDay)
    const bankRaw = recForAcc[ym]
    const bank = (bankRaw === '' || bankRaw == null) ? null : Number(bankRaw)
    const diff = (bank == null || !isFinite(bank)) ? null : bank - computed
    return { ym, lastDay, computed, bank, diff }
  })
  // Identify first divergent month — both sides filled in and |diff| > 0.005.
  let firstDivergent = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].diff != null && Math.abs(rows[i].diff) > 0.005) { firstDivergent = i; break }
  }

  const head = `<thead><tr>
    <th>חודש</th>
    <th>יתרה מחושבת (סוף חודש)</th>
    <th>יתרה לפי הבנק</th>
    <th>הפרש</th>
    <th></th>
  </tr></thead>`
  const body = rows.map((r, i) => {
    const ymDisp = r.ym.slice(5) + '/' + r.ym.slice(0,4)
    const cls = (i === firstDivergent) ? 'rec-row-divergent'
              : (r.diff != null && Math.abs(r.diff) <= 0.005) ? 'rec-row-match'
              : ''
    const diffCell = r.diff == null
      ? '<span style="color:var(--text-muted);font-size:.8rem">—</span>'
      : Math.abs(r.diff) <= 0.005
        ? '<span style="color:var(--income);font-weight:600">✓ תואם</span>'
        : `<span style="color:var(--expense);font-weight:600">${r.diff>0?'+':''}${formatCurrency(r.diff)}</span>`
    const indicator = (i === firstDivergent)
      ? '<span class="type-badge type-expense" title="כאן מתחיל הפער — בדוק את העסקאות בחודש הזה">🚨 כאן הפער מתחיל</span>'
      : ''
    const bankVal = (r.bank == null) ? '' : r.bank
    // Adjust button — only when there's a real divergence to close. It posts a
    // single adjustment tx (income for positive diff, expense for negative)
    // dated to the LAST day of the month so it lands inside this row's
    // computed-balance window and bank == computed immediately afterwards.
    const adjustBtn = (r.diff != null && Math.abs(r.diff) > 0.005)
      ? `<button class="btn-primary" style="font-size:.78rem;padding:.3rem .6rem"
            onclick="performBalanceAdjustment('${accountId}','${r.ym}', ${r.diff})"
            title="צור עסקת התאמה בסכום ההפרש לסוף החודש">⚖️ התאם יתרה</button>`
      : ''
    return `<tr class="${cls}">
      <td style="font-weight:600">${ymDisp}</td>
      <td style="font-variant-numeric:tabular-nums">${formatCurrency(r.computed)}</td>
      <td><input type="number" step="0.01" value="${bankVal}" placeholder="הזן..."
            onchange="saveReconcileEntry('${accountId}','${r.ym}', this.value)"
            style="max-width:140px;font-variant-numeric:tabular-nums"></td>
      <td>${diffCell}</td>
      <td style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
        ${adjustBtn}
        <button class="btn-ghost" style="font-size:.78rem;padding:.3rem .6rem"
          onclick="openMonthInTransactions('${accountId}','${r.ym}')" title="פתח את החודש במסך עסקאות">פתח חודש</button>
        ${indicator}
      </td>
    </tr>`
  }).join('')

  wrap.innerHTML = `
    <div style="overflow-x:auto">
      <table class="data-table" style="min-width:560px">${head}<tbody>${body}</tbody></table>
    </div>
    <p style="font-size:.78rem;color:var(--text-muted);margin-top:.75rem">
      רק עו"ש ומזומן ניתנים להתאמה — חיסכון/השקעות/CC לא מציגים יתרה בזמן אמת באפליקציה.
      אחרי שהפער מתבטל בחודש הראשון הוא לרוב נסגר מעצמו לכל החודשים הבאים.
    </p>`
}

function saveReconcileEntry(accountId, ym, value) {
  const all = getReconciliationData()
  if (!all[accountId]) all[accountId] = {}
  const trimmed = String(value || '').trim()
  if (trimmed === '') delete all[accountId][ym]
  else all[accountId][ym] = Number(trimmed)
  setReconciliationData(all)
  renderReconcileTable()
}

// One-click adjustment: posts a single income/expense tx (vendor "התאמת
// יתרה") for the diff amount, dated to the last day of the given month so
// the recomputed balance for that month equals the bank-reported balance
// immediately. Asks for confirmation, refreshes the table, and surfaces a
// toast. Doesn't touch other months — adjusting one month shifts every
// subsequent computed balance by the same delta, which may close OR open
// new gaps; the user keeps full control by re-entering bank values.
async function performBalanceAdjustment(accountId, ym, diff) {
  const num = Number(diff)
  if (!isFinite(num) || Math.abs(num) <= 0.005) return
  const acc = getAccounts().find(a => a.id === accountId)
  if (!acc) { toast('לא נמצא חשבון', { type: 'error' }); return }
  const ymDisp = ym.slice(5) + '/' + ym.slice(0,4)
  const direction = num > 0 ? 'הכנסה' : 'הוצאה'
  const msg = `ליצור עסקת ${direction} של ${formatCurrency(Math.abs(num))} בסוף ${ymDisp} (חשבון: ${acc.name}) כדי להתאים את היתרה לבנק?`
  if (!await confirmDialog(msg, { confirmText: 'צור עסקה', title: 'התאמת יתרה' })) return
  const lastDay = _lastDayOfMonth(ym)
  const txs = getTransactions()
  txs.push({
    id: genId(),
    accountId,
    date: lastDay,
    amount: num,                // positive = income, negative = expense
    vendor: 'התאמת יתרה',
    description: `התאמה אוטומטית של יתרת ${acc.name} עבור ${ymDisp}`,
    type: num > 0 ? 'income' : 'expense',
    categoryId: '',
    notes: `התאמת יתרה אוטומטית · ${formatCurrency(num)} · ${ymDisp}`,
    createdAt: Date.now(),
    balanceAdjustment: true,     // tag for future filtering / hiding
  })
  DB.set('finTransactions', txs)
  if (typeof toast === 'function') toast(`נוספה עסקת התאמה (${formatCurrencyPlain(num)}) ל-${ymDisp}`, { type: 'success' })
  renderReconcileTable()
}

// Opens the transactions screen with the period preset to the given month
// and the account pre-filtered — the user can immediately scan that single
// month's tx for the offending row.
function openMonthInTransactions(accountId, ym) {
  const lastDay = _lastDayOfMonth(ym)
  const label = ym.slice(5) + '/' + ym.slice(0,4)
  if (typeof setActivePeriod === 'function') {
    setActivePeriod({ key: 'custom', label, start: ym + '-01', end: lastDay })
  }
  navigate('transactions')
  setTimeout(() => {
    const sel = document.getElementById('txAccountFilter')
    if (sel) { sel.value = accountId; sel.dispatchEvent(new Event('change')) }
  }, 30)
}

// ===== VENDOR ALIASES =====
function renderAliasList() {
  const el = document.getElementById('aliasList')
  if (!el) return
  const aliases = getVendorAliases()
  if (aliases.length === 0) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:.9rem;padding:1rem 0">אין איחודי ספקים. הוסף מכאן או ישירות מטופ הספקים בניתוח.</div>'
    return
  }
  const cell = v => v
    ? `<span class="vendor-raw-chip" style="background:var(--accent-bg);color:var(--accent)">${v}</span>`
    : `<span style="color:var(--text-muted);font-size:.8rem">ללא</span>`
  el.innerHTML = `
    <div class="rules-table-head" style="grid-template-columns:1fr 1.5fr auto auto auto">
      <div>שם תצוגה</div>
      <div>ביטויים</div>
      <div>טווח סכום</div>
      <div>טווח יום חיוב</div>
      <div></div>
    </div>
    ${aliases.map(a => {
      const amountRange = formatAliasAmountRange(a.amountMin, a.amountMax)
      const dayRange    = formatAliasDayRange(a.dayMin, a.dayMax)
      return `
      <div class="rules-row" style="grid-template-columns:1fr 1.5fr auto auto auto">
        <div class="rules-pattern" style="font-weight:600">${escHtml(a.displayName)}</div>
        <div class="rules-cat">${(a.patterns || []).map(p => `<span class="vendor-raw-chip">${escHtml(p)}</span>`).join(' ')}</div>
        <div>${cell(amountRange)}</div>
        <div>${cell(dayRange)}</div>
        <div style="display:flex;gap:.4rem">
          <button class="btn-ghost" style="font-size:.8rem;padding:.3rem .7rem" onclick="editAliasPrompt('${a.id}')">ערוך</button>
          <button class="btn-danger" onclick="removeAlias('${a.id}')">מחק</button>
        </div>
      </div>`
    }).join('')}`
}

function addAliasFromForm() {
  const displayName = document.getElementById('aliasInputDisplay').value.trim()
  const patternsRaw = document.getElementById('aliasInputPatterns').value
  const minRaw = document.getElementById('aliasInputAmountMin')?.value
  const maxRaw = document.getElementById('aliasInputAmountMax')?.value
  const dayMinRaw = document.getElementById('aliasInputDayMin')?.value
  const dayMaxRaw = document.getElementById('aliasInputDayMax')?.value
  const patterns = patternsRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
  if (!displayName || patterns.length === 0) { toast('שם תצוגה וביטוי אחד לפחות חובה', { type: 'error' }); return }
  addVendorAlias(patterns, displayName, minRaw, maxRaw, dayMinRaw, dayMaxRaw)
  document.getElementById('aliasInputDisplay').value = ''
  document.getElementById('aliasInputPatterns').value = ''
  for (const id of ['aliasInputAmountMin','aliasInputAmountMax','aliasInputDayMin','aliasInputDayMax']) {
    const el = document.getElementById(id); if (el) el.value = ''
  }
  renderAliasList()
}

async function editAliasPrompt(id) {
  const alias = getVendorAliases().find(a => a.id === id)
  if (!alias) return
  const newDisplay = await promptDialog('שם תצוגה:', { defaultValue: alias.displayName, title: 'עריכת איחוד' })
  if (newDisplay === null) return
  const newPatterns = await promptDialog('ביטויים לזיהוי (שורה/פסיק לכל אחד):', { defaultValue: (alias.patterns || []).join(', '), multiline: true, title: 'עריכת איחוד' })
  if (newPatterns === null) return
  const currentAmount = formatAliasAmountRange(alias.amountMin, alias.amountMax)
  const newAmount = await promptDialog(
    'טווח סכום (לדוגמה: 100-200, או 5000 לסכום מדויק. ריק = ללא הגבלה):',
    { defaultValue: currentAmount, title: 'עריכת איחוד' }
  )
  if (newAmount === null) return
  const currentDay = formatAliasDayRange(alias.dayMin, alias.dayMax)
  const newDay = await promptDialog(
    'טווח יום חיוב (1–31). לדוגמה: 9-11, או 10 ליום מדויק. ריק = ללא הגבלה:',
    { defaultValue: currentDay, title: 'עריכת איחוד' }
  )
  if (newDay === null) return
  const patterns = newPatterns.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
  if (!newDisplay.trim() || patterns.length === 0) { toast('שם תצוגה וביטוי אחד לפחות חובה', { type: 'error' }); return }
  const { amountMin, amountMax } = parseAliasAmountRange(newAmount)
  const { dayMin,    dayMax    } = parseAliasDayRange(newDay)
  updateVendorAlias(id, patterns, newDisplay.trim(), amountMin, amountMax, dayMin, dayMax)
  renderAliasList()
}

async function removeAlias(id) {
  if (!await confirmDialog('למחוק את האיחוד? שמות גולמיים יוצגו כמו שהם.', { danger: true, confirmText: 'מחק' })) return
  deleteVendorAlias(id)
  renderAliasList()
}

function renderRulesList() {
  const catSel = document.getElementById('ruleInputCategory')
  if (catSel) {
    const cats = getCategories().filter(c => c.type !== 'transfer')
    catSel.innerHTML = cats.map(c => `<option value="${c.id}">${catIconText(c)} ${escHtml(c.name)}</option>`).join('')
  }
  const listEl = document.getElementById('rulesList')
  if (listEl) {
    const rules = getCategoryRules()
    const cats = getCategories()
    if (rules.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-muted);font-size:.9rem">אין כללים אישיים. ברירות המחדל פעילות למטה.</div>'
    } else {
      listEl.innerHTML = `
        <div class="rules-table-head">
          <div>מילת מפתח</div>
          <div>קטגוריה</div>
          <div></div>
        </div>
        ${rules.map(r => {
          const c = cats.find(x => x.id === r.categoryId)
          return `
            <div class="rules-row">
              <div class="rules-pattern">${escHtml(r.pattern)}</div>
              <div class="rules-cat">${c ? `${catIconHTML(c)} ${escHtml(c.name)}` : '(קטגוריה לא קיימת)'}</div>
              <div><button class="btn-danger" onclick="removeRule('${r.id}')">מחק</button></div>
            </div>`
        }).join('')}
      `
    }
  }
  const defEl = document.getElementById('defaultRulesList')
  if (defEl) {
    const cats = getCategories()
    defEl.innerHTML = DEFAULT_CATEGORY_RULES.map(r => {
      const c = cats.find(x => x.id === r.categoryId)
      return `<div class="rules-default-row">
        <span class="rules-pattern">${escHtml(r.patterns.join(' · '))}</span>
        <span class="rules-cat">→ ${c ? `${catIconHTML(c)} ${escHtml(c.name)}` : r.categoryId}</span>
      </div>`
    }).join('')
  }
}

function addRuleFromForm() {
  const p = document.getElementById('ruleInputPattern').value.trim()
  const cid = document.getElementById('ruleInputCategory').value
  if (!p || !cid) { toast('מילת מפתח וקטגוריה חובה', { type: 'error' }); return }
  addCategoryRule(p, cid)
  document.getElementById('ruleInputPattern').value = ''
  renderRulesList()
  // Retroactively re-categorize uncategorized transactions matching the new rule
  const changed = applyRulesToUncategorized()
  if (changed > 0) toast(`${changed} עסקאות קיימות סווגו על פי הכלל החדש`, { type: 'success' })
}

async function removeRule(id) {
  if (!await confirmDialog('למחוק את הכלל?', { danger: true, confirmText: 'מחק' })) return
  deleteCategoryRule(id)
  renderRulesList()
}

// Scan all uncategorized transactions and apply rules retroactively.
function applyRulesToUncategorized() {
  const txs = getTransactions()
  let changed = 0
  txs.forEach(t => {
    if (t.categoryId) return
    if (t.type === 'transfer') return
    const cid = matchVendorToCategory(t.vendor, t.description)
    if (cid) { t.categoryId = cid; changed++ }
  })
  if (changed > 0) DB.set('finTransactions', txs)
  return changed
}

function renderTemplatesList() {
  const el = document.getElementById('templatesList')
  if (!el) return
  const list = getTemplates()
  if (list.length === 0) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:.9rem">אין תבניות שמורות. ייבא קובץ מובנה (Excel/CSV/TXT) כדי ליצור תבנית ראשונה.</div>'
    return
  }
  const accs = getAccounts()
  el.innerHTML = list.map(t => {
    const acc = t.accountId ? accs.find(a => a.id === t.accountId) : null
    const lastUsed = t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString('he-IL') : '—'
    const headerPreview = (t.headerPreview || []).join(' · ').slice(0, 80) || '(ללא תצוגה)'
    return `
      <div class="template-row">
        <div class="template-main">
          <div class="template-name">${escHtml(t.name)}</div>
          <div class="template-meta">${escHtml(headerPreview)}</div>
          <div class="template-meta">
            ${acc ? `חשבון: ${escHtml(acc.name)} · ` : 'כל חשבון · '}
            שימוש אחרון: ${lastUsed} ·
            סה"כ תנועות שחולצו: ${t.txCount || 0}
          </div>
        </div>
        <div class="template-actions">
          <button class="btn-ghost" onclick="renameTemplate('${t.id}')">שנה שם</button>
          <button class="btn-danger" onclick="confirmDeleteTemplate('${t.id}')">מחק</button>
        </div>
      </div>`
  }).join('')
}

async function renameTemplate(id) {
  const list = getTemplates()
  const t = list.find(x => x.id === id)
  if (!t) return
  const newName = await promptDialog('שם חדש לתבנית:', { defaultValue: t.name, title: 'שינוי שם תבנית' })
  if (!newName || newName === t.name) return
  t.name = newName.trim()
  saveTemplates(list)
  renderTemplatesList()
}

async function confirmDeleteTemplate(id) {
  if (!await confirmDialog('למחוק את התבנית? ייבוא עתידי מאותו מקור ידרוש מיפוי מחדש.', { danger: true, confirmText: 'מחק' })) return
  deleteTemplate(id)
  renderTemplatesList()
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none')
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
  document.getElementById('tab-' + name).style.display = 'block'
  btn.classList.add('active')
}

// ===== ACCOUNTS =====
function toggleAccForm() {
  const f = document.getElementById('accForm')
  f.style.display = f.style.display === 'none' ? 'block' : 'none'
}

const PATTERN_BEARING_TYPES = ['credit_card', 'savings', 'investment']
function _onAccTypeChange() {
  const t = document.getElementById('accType').value
  document.getElementById('accPatternsRow').style.display = PATTERN_BEARING_TYPES.includes(t) ? 'block' : 'none'
  document.getElementById('accBillingDayRow').style.display = t === 'credit_card' ? 'block' : 'none'
}

function saveAccount() {
  const name = document.getElementById('accName').value.trim()
  if (!name) { toast('שם החשבון חובה', { type: 'error' }); return }
  const accounts = getAccounts()
  const type = document.getElementById('accType').value
  const patternsRaw = document.getElementById('accPatterns')?.value || ''
  const patterns = PATTERN_BEARING_TYPES.includes(type)
    ? patternsRaw.split('\n').map(s => s.trim()).filter(Boolean)
    : undefined
  const billingDay = type === 'credit_card'
    ? (parseInt(document.getElementById('accBillingDay').value, 10) || 10)
    : undefined
  accounts.push({
    id:             genId(),
    name,
    type,
    institution:    document.getElementById('accInstitution').value.trim(),
    openingBalance: parseFloat(document.getElementById('accBalance').value) || 0,
    currency:       'ILS',
    paymentVendorPatterns: patterns,
    billingDay,
    createdAt:      Date.now(),
  })
  DB.set('finAccounts', accounts)
  invalidatePLCache()
  invalidateAccountCache()
  document.getElementById('accName').value = ''
  document.getElementById('accInstitution').value = ''
  document.getElementById('accBalance').value = '0'
  if (document.getElementById('accPatterns')) document.getElementById('accPatterns').value = ''
  document.getElementById('accBillingDay').value = '10'
  toggleAccForm()
  renderSettings()
}

async function editAccountPatterns(id) {
  const accs = getAccounts()
  const acc = accs.find(a => a.id === id)
  if (!acc) return
  const current = (acc.paymentVendorPatterns || []).join('\n')
  const v = await promptDialog(`דפוסי זיהוי לחשבון "${acc.name}":\n(שורה לכל ביטוי - משמש לזיהוי העברות אל החשבון בדפי הבנק)`, { defaultValue: current, multiline: true, title: 'דפוסי זיהוי' })
  if (v === null) return
  acc.paymentVendorPatterns = v.split('\n').map(s => s.trim()).filter(Boolean)
  DB.set('finAccounts', accs)
  invalidateAccountCache()
  if (typeof invalidateCcLumpDetectCache === 'function') invalidateCcLumpDetectCache()
  renderSettings()
}

async function editAccountBillingDay(id) {
  const accs = getAccounts()
  const acc = accs.find(a => a.id === id)
  if (!acc) return
  const current = acc.billingDay || 10
  const v = await promptDialog(`יום חיוב בחודש עבור "${acc.name}" (1–31):`, { defaultValue: String(current), title: 'יום חיוב' })
  if (v === null) return
  const day = parseInt(v, 10)
  if (isNaN(day) || day < 1 || day > 31) { toast('יום לא חוקי. הזן מספר בין 1 ל-31.', { type: 'error' }); return }
  acc.billingDay = day
  DB.set('finAccounts', accs)
  invalidateAccountCache()
  renderSettings()
}

function runAutoLinkTransfers() {
  const n = autoLinkTransfersByPattern()
  toast(n === 0 ? 'לא נמצאו העברות חדשות להתאמה' : `זוהו וסומנו ${n} העברות לפי דפוסים`, { type: n === 0 ? 'info' : 'success' })
  renderSettings()
}

async function deleteAccount(id) {
  const acc = getAccounts().find(a => a.id === id)
  const owned = getTransactions().filter(t => t.accountId === id).length
  const msg = owned > 0
    ? `למחוק את חשבון "${acc?.name||''}"?\nפעולה זו תמחק גם ${owned} עסקאות שייכות אליו.`
    : `למחוק את חשבון "${acc?.name||''}"?`
  if (!await confirmDialog(msg, { danger: true, confirmText: 'מחק' })) return
  // Drop tx on the deleted account, and scrub stale cross-account links.
  const remainingTx = getTransactions().filter(t => t.accountId !== id)
  remainingTx.forEach(t => {
    if (t.transferAccountId === id)     delete t.transferAccountId
    if (t.ccPaymentForAccountId === id) delete t.ccPaymentForAccountId
  })
  DB.set('finTransactions', remainingTx)
  DB.set('finAccounts', getAccounts().filter(a => a.id !== id))
  invalidatePLCache()
  invalidateAccountCache()
  if (typeof invalidateCcLumpDetectCache === 'function') invalidateCcLumpDetectCache()
  renderSettings()
}

function renderAccountList() {
  const accounts = getAccounts()
  document.getElementById('accCount').textContent = `${accounts.length} חשבונות`
  const TYPE = { checking:'עו"ש', savings:'חיסכון', credit_card:'כרטיס אשראי', cash:'מזומן', investment:'ני"ע / השקעות' }
  document.getElementById('accList').innerHTML = accounts.length === 0
    ? '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:2rem">אין חשבונות. לחץ "חשבון חדש" להוסיף.</p>'
    : accounts.map(a => {
        const showBalance = PL_ACCOUNT_TYPES.has(a.type)
        let balLine = ''
        if (showBalance) {
          const bal = getAccountBalance(a.id)
          const balColor = bal >= 0 ? 'var(--income)' : 'var(--expense)'
          balLine = ` · יתרה: <span style="color:${balColor}">${formatCurrency(bal)}</span>`
        }
        const patternsBtn = PATTERN_BEARING_TYPES.includes(a.type)
          ? `<button class="btn-ghost" style="font-size:.75rem;padding:.3rem .7rem" onclick="editAccountPatterns('${a.id}')">דפוסי זיהוי (${(a.paymentVendorPatterns||[]).length})</button>`
          : ''
        const billingDayBtn = a.type === 'credit_card'
          ? `<button class="btn-ghost" style="font-size:.75rem;padding:.3rem .7rem" onclick="editAccountBillingDay('${a.id}')">⚙️ יום חיוב: ${a.billingDay || 10}</button>`
          : ''
        return `
        <div class="list-item">
          <div style="flex:1">
            <div class="list-item-name">${escHtml(a.name)}</div>
            <div class="list-item-sub">${TYPE[a.type]||a.type}${a.institution?' · '+escHtml(a.institution):''}${balLine}</div>
          </div>
          <div style="display:flex;gap:.4rem;align-items:center">
            ${patternsBtn}
            ${billingDayBtn}
            <button class="list-item-del" onclick="deleteAccount('${a.id}')">🗑️</button>
          </div>
        </div>`
      }).join('')
}

// ===== CATEGORIES =====
function toggleCatForm() {
  const f = document.getElementById('catForm')
  const opening = f.style.display === 'none'
  f.style.display = opening ? 'block' : 'none'
  if (opening) {
    const wrap = document.getElementById('catIconPickerWrap')
    if (wrap) wrap.innerHTML = iconPickerMarkup('catIcon', '')
  }
}

function saveCategory() {
  const name = document.getElementById('catName').value.trim()
  if (!name) { toast('שם הקטגוריה חובה', { type: 'error' }); return }
  const cats = getCategories()
  cats.push({
    id:     genId(),
    name,
    type:   document.getElementById('catType').value,
    icon:   document.getElementById('catIcon').value || '📋',
    color:  document.getElementById('catColor').value,
    system: false,
  })
  DB.set('finCategories', cats)
  document.getElementById('catName').value = ''
  toggleCatForm()
  renderSettings()
}

// Shared delete: drops the category and scrubs stale categoryId pointers
// on every transaction so the dataset isn't dirty (autocat learning reads
// raw categoryId counts and would otherwise score a ghost id).
function _deleteCategoryAndScrub(id) {
  DB.set('finCategories', getCategories().filter(c => c.id !== id))
  const txs = getTransactions()
  let changed = 0
  txs.forEach(t => { if (t.categoryId === id) { t.categoryId = ''; changed++ } })
  if (changed > 0) DB.set('finTransactions', txs)
  if (typeof invalidateSavingsCache === 'function')       invalidateSavingsCache()
  if (typeof invalidateCapitalIncomeCache === 'function') invalidateCapitalIncomeCache()
}

async function deleteCategory(id) {
  const cat = getCategories().find(c => c.id === id)
  if (cat?.system) { toast('לא ניתן למחוק קטגוריית מערכת', { type: 'error' }); return }
  if (!await confirmDialog('האם למחוק קטגוריה זו?', { danger: true, confirmText: 'מחק' })) return
  _deleteCategoryAndScrub(id)
  renderSettings()
}

function renderCategoryList() {
  const cats = getCategories()
  const expCats = cats.filter(c => c.type === 'expense')
  const incCats = cats.filter(c => c.type === 'income')

  document.getElementById('catList').innerHTML = [
    ['הוצאות', expCats],
    ['הכנסות', incCats],
  ].map(([label, list]) => `
    <div style="margin-bottom:1.5rem">
      <div style="font-size:.82rem;color:var(--text-muted);margin-bottom:.6rem;font-weight:500">${label} (${list.length})</div>
      <div class="cat-grid">
        ${list.map(c => `
          <div class="cat-chip" onclick="openCatEditModal('${c.id}')" style="cursor:pointer">
            <div class="cat-chip-left">
              <span class="cat-dot" style="background:${c.color}"></span>
              ${catIconHTML(c)} ${escHtml(c.name)}${c.isSavings ? ' <span class="cat-savings-badge" title="חיסכון חבוי">🪙</span>' : ''}${c.isSavingsReduction ? ' <span class="cat-savings-badge" title="הכנסה הונית">📉</span>' : ''}
            </div>
            <span class="cat-chip-edit">✏️</span>
          </div>`).join('')}
      </div>
    </div>`).join('')
}

// ===== CATEGORY EDIT MODAL =====
let _catEditId = null
function openCatEditModal(id) {
  const cat = getCategoryById(id)
  if (!cat) return
  _catEditId = id
  document.getElementById('catEditTitle').textContent = `עריכת קטגוריה – ${cat.name}`
  document.getElementById('catEditDeleteBtn').style.display = cat.system ? 'none' : 'inline-flex'

  const typeOptions = [
    { v: 'expense', l: 'הוצאה' },
    { v: 'income',  l: 'הכנסה' },
  ].map(o => `<option value="${o.v}" ${cat.type===o.v?'selected':''}>${o.l}</option>`).join('')

  const isSavingsRow = `
    <div class="modal-row" id="catEditSavingsRow" style="display:${cat.type==='expense'?'block':'none'}">
      <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
        <input type="checkbox" id="catEditIsSavings" ${cat.isSavings?'checked':''} style="width:auto;margin:0">
        <span>🪙 הוצאה שהיא בעצם חיסכון</span>
      </label>
      <div style="font-size:.78rem;color:var(--text-muted);margin-top:.35rem;line-height:1.5">
        עסקאות בקטגוריה זו ימשיכו להיספר כהוצאה (הכסף אכן יצא מהעו"ש),<br>
        אבל יוצגו בנפרד בדשבורד ויתווספו לחישוב אחוז החיסכון המורחב בניתוח התזרים.
      </div>
    </div>`

  const isCapitalRow = `
    <div class="modal-row" id="catEditCapitalRow" style="display:${cat.type==='income'?'block':'none'}">
      <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
        <input type="checkbox" id="catEditIsSavingsReduction" ${cat.isSavingsReduction?'checked':''} style="width:auto;margin:0">
        <span>📉 הכנסה הונית (שבירת חיסכון/דיבידנד/מכירת ני"ע)</span>
      </label>
      <div style="font-size:.78rem;color:var(--text-muted);margin-top:.35rem;line-height:1.5">
        הכנסות בקטגוריה זו ימשיכו להיכלל בסך ההכנסות, אבל ינוטרלו<br>
        מ"אחוז החיסכון האמיתי" בניתוח התזרים — כי אינן הכנסה טרייה אלא שבירת חיסכון.
      </div>
    </div>`

  document.getElementById('catEditBody').innerHTML = `
    <div class="modal-row"><label class="form-label">שם</label><input id="catEditName" value="${cat.name}"></div>
    <div class="modal-row"><label class="form-label">אייקון</label>${iconPickerMarkup('catEditIcon', cat.icon || '')}</div>
    <div class="modal-row"><label class="form-label">צבע</label><input type="color" id="catEditColor" value="${cat.color || '#64748b'}"></div>
    <div class="modal-row"><label class="form-label">סוג</label><select id="catEditType" onchange="_onCatEditTypeChange()" ${cat.system?'disabled':''}>${typeOptions}</select></div>
    ${isSavingsRow}
    ${isCapitalRow}
    <div style="font-size:.78rem;color:var(--text-muted);padding:.5rem .1rem 0">שינויים בשם/אייקון/צבע יחולו מיידית על כל העסקאות הקיימות והעתידיות בקטגוריה.</div>`
  document.getElementById('catEditModal').classList.add('open')
}

function _onCatEditTypeChange() {
  const t = document.getElementById('catEditType').value
  document.getElementById('catEditSavingsRow').style.display = t === 'expense' ? 'block' : 'none'
  const capRow = document.getElementById('catEditCapitalRow')
  if (capRow) capRow.style.display = t === 'income' ? 'block' : 'none'
}

function closeCatEditModal() {
  document.getElementById('catEditModal').classList.remove('open')
  _catEditId = null
}

function saveCatEdit() {
  if (!_catEditId) return
  const cats = getCategories()
  const idx  = cats.findIndex(c => c.id === _catEditId)
  if (idx < 0) return
  const name = document.getElementById('catEditName').value.trim()
  if (!name) { toast('שם חובה', { type: 'error' }); return }
  cats[idx].name  = name
  cats[idx].icon  = document.getElementById('catEditIcon').value.trim() || '📋'
  cats[idx].color = document.getElementById('catEditColor').value
  if (!cats[idx].system) cats[idx].type = document.getElementById('catEditType').value
  const isSavingsInput = document.getElementById('catEditIsSavings')
  cats[idx].isSavings = cats[idx].type === 'expense' && isSavingsInput && isSavingsInput.checked
  const isCapitalInput = document.getElementById('catEditIsSavingsReduction')
  cats[idx].isSavingsReduction = cats[idx].type === 'income' && isCapitalInput && isCapitalInput.checked
  DB.set('finCategories', cats)
  if (typeof invalidateSavingsCache === 'function') invalidateSavingsCache()
  if (typeof invalidateCapitalIncomeCache === 'function') invalidateCapitalIncomeCache()
  closeCatEditModal()
  renderSettings()
}

async function deleteFromCatModal() {
  if (!_catEditId) return
  const cat = getCategoryById(_catEditId)
  if (!cat || cat.system) return
  if (!await confirmDialog('למחוק את הקטגוריה? עסקאות שסווגו אליה יוצגו כלא־מסווגות.', { danger: true, confirmText: 'מחק' })) return
  _deleteCategoryAndScrub(_catEditId)
  closeCatEditModal()
  renderSettings()
}

// ===== PROMPT =====
function savePrompt() {
  const val = document.getElementById('promptInput').value.trim()
  if (!val) { toast('ההנחיות לא יכולות להיות ריקות', { type: 'error' }); return }
  localStorage.setItem('geminiPrompt', val)
  document.getElementById('promptMsg').textContent = '✅ ההנחיות נשמרו'
  document.getElementById('promptMsg').style.color = 'var(--income)'
}
async function resetPrompt() {
  if (!await confirmDialog('לאפס את ההנחיות לברירת המחדל?', { confirmText: 'אפס' })) return
  localStorage.removeItem('geminiPrompt')
  document.getElementById('promptInput').value = DEFAULT_PROMPT
  document.getElementById('promptMsg').textContent = '✅ אופס לברירת מחדל'
  document.getElementById('promptMsg').style.color = 'var(--income)'
}

// ===== DATA MANAGEMENT =====
function renderImportBatches() {
  const txs = getTransactions()
  const batches = {}
  txs.forEach(t => {
    const key = t.importBatch || '_manual'
    if (!batches[key]) batches[key] = { file: t.sourceFile || 'לא ידוע', importedAt: t.importedAt || t.createdAt, count: 0, total: 0 }
    batches[key].count++
    batches[key].total += t.amount || 0
  })

  const list = Object.entries(batches).sort((a, b) => (b[1].importedAt || 0) - (a[1].importedAt || 0))
  const container = document.getElementById('importBatchList')

  if (list.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:2rem">אין עסקאות במערכת</p>'
    return
  }

  container.innerHTML = list.map(([batchId, b]) => {
    const date = b.importedAt ? new Date(b.importedAt).toLocaleString('he-IL') : '—'
    return `
    <div class="list-item" style="flex-wrap:wrap;gap:.5rem">
      <div style="flex:1;min-width:200px">
        <div class="list-item-name">${escHtml(b.file)}</div>
        <div class="list-item-sub">${date} · ${b.count} עסקאות · ${formatCurrency(b.total)}</div>
      </div>
      <button class="btn-danger" style="font-size:.8rem;padding:.35rem .75rem" onclick="deleteImportBatch('${batchId}')">מחק ייבוא</button>
    </div>`
  }).join('')
}

async function deleteImportBatch(batchId) {
  const txs = getTransactions()
  const batchTxs = txs.filter(t => (t.importBatch || '_manual') === batchId)
  const file = batchTxs[0]?.sourceFile || 'לא ידוע'
  if (!await confirmDialog(`למחוק ${batchTxs.length} עסקאות מהקובץ "${file}"?`, { danger: true, confirmText: 'מחק' })) return
  const snapshot = txs.slice()
  DB.set('finTransactions', txs.filter(t => (t.importBatch || '_manual') !== batchId))
  renderImportBatches()
  toast(`${batchTxs.length} עסקאות נמחקו`, {
    type: 'success',
    action: { label: 'בטל', onClick: () => { DB.set('finTransactions', snapshot); renderImportBatches(); if (typeof renderDashboard === 'function') renderDashboard() } },
  })
}

async function deleteAllTransactions() {
  const count = getTransactions().length
  if (count === 0) { toast('אין עסקאות למחיקה', { type: 'info' }); return }
  if (!await confirmDialog(`למחוק את כל ${count} העסקאות? מומלץ לגבות קודם. ניתן לבטל מיד לאחר המחיקה.`, { danger: true, confirmText: 'מחק הכל' })) return
  const snapshot = getTransactions().slice()
  DB.set('finTransactions', [])
  localStorage.removeItem('migration_cc_transfers')
  renderImportBatches()
  toast(`${count} עסקאות נמחקו`, {
    type: 'success',
    action: { label: 'בטל', onClick: () => { DB.set('finTransactions', snapshot); renderImportBatches(); if (typeof renderDashboard === 'function') renderDashboard() } },
  })
}

// ===== API KEY =====
function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim()
  if (!key) { toast('הזן מפתח API', { type: 'error' }); return }
  localStorage.setItem('geminiApiKey', key)
  document.getElementById('apiKeyMsg').textContent = '✅ מפתח נשמר בהצלחה'
  document.getElementById('apiKeyMsg').style.color = 'var(--income)'
}

// ===== GEMINI MODELS CASCADE =====
function loadGeminiModelsToUI() {
  const ta = document.getElementById('modelsInput')
  if (!ta) return
  ta.value = getGeminiModels().join('\n')
  const msg = document.getElementById('modelsMsg')
  if (msg) msg.textContent = ''
  const out = document.getElementById('modelsTestResult')
  if (out) out.innerHTML = ''
}

function _parseModelsInput() {
  const raw = document.getElementById('modelsInput').value || ''
  return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
}

function saveGeminiModelsFromUI() {
  const list = _parseModelsInput()
  if (!list.length) { toast('צריך לפחות מודל אחד', { type: 'error' }); return }
  setGeminiModels(list)
  const msg = document.getElementById('modelsMsg')
  msg.textContent = `✅ נשמרו ${list.length} מודלים`
  msg.style.color = 'var(--income)'
}

async function resetGeminiModelsFromUI() {
  if (!await confirmDialog('לאפס את מפל המודלים לברירת המחדל?', { confirmText: 'אפס' })) return
  localStorage.removeItem('geminiModels')
  loadGeminiModelsToUI()
  const msg = document.getElementById('modelsMsg')
  msg.textContent = '✅ אופס לברירת מחדל'
  msg.style.color = 'var(--income)'
}

function _escHtml(s) { return escHtml(s) }

async function runGeminiModelsTest() {
  const key = getApiKey()
  if (!key) { toast('שמור קודם מפתח API', { type: 'error' }); return }
  const promptText = (document.getElementById('modelsTestPrompt').value || '').trim() || 'בדיקה'
  const list = _parseModelsInput()
  if (!list.length) { toast('הזן מודלים לבדיקה', { type: 'error' }); return }
  const out = document.getElementById('modelsTestResult')
  out.innerHTML = `<div style="color:var(--text-muted)">⏳ בודק ${list.length} מודלים...</div>`
  const btn = document.getElementById('modelsTestBtn')
  if (btn) btn.disabled = true
  try {
    const results = await testGeminiModels(key, promptText, list)
    const okCount = results.filter(r => r.ok).length
    out.innerHTML = `
      <div style="font-size:.85rem;color:var(--text-muted);margin-bottom:.5rem">סיכום: ${okCount}/${results.length} עובדים</div>
      ${results.map(r => {
        if (r.ok) {
          return `<div style="padding:.55rem .75rem;margin-bottom:.4rem;border-radius:6px;background:rgba(46,160,67,.12);border:1px solid rgba(46,160,67,.4)">
            <div style="font-family:monospace;font-weight:600;color:var(--income)">✅ ${_escHtml(r.model)} <span style="font-weight:400;opacity:.7">· ${r.ms}ms</span></div>
            <div style="font-size:.8rem;margin-top:.3rem;opacity:.85">${_escHtml(r.reply) || '<i>(תגובה ריקה)</i>'}</div>
          </div>`
        }
        return `<div style="padding:.55rem .75rem;margin-bottom:.4rem;border-radius:6px;background:rgba(220,53,69,.1);border:1px solid rgba(220,53,69,.35)">
          <div style="font-family:monospace;font-weight:600;color:var(--expense)">❌ ${_escHtml(r.model)} <span style="font-weight:400;opacity:.7">· ${r.ms}ms</span></div>
          <div style="font-size:.8rem;margin-top:.3rem;opacity:.85">${_escHtml(r.error)}</div>
        </div>`
      }).join('')}`
  } finally {
    if (btn) btn.disabled = false
  }
}
