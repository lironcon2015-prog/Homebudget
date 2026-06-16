const APP_VERSION = '1.28.7'

// ===== STORAGE =====
const DB = {
  get: (key, def = []) => { try { return JSON.parse(localStorage.getItem(key)) ?? def } catch { return def } },
  set: (key, val) => {
    try {
      localStorage.setItem(key, JSON.stringify(val))
    } catch (e) {
      console.error('DB.set failed', key, e)
      if (typeof toast === 'function') toast('השמירה נכשלה — ייתכן שנגמר מקום האחסון', { type: 'error', duration: 6000 })
      return false
    }
    if (typeof _onBackupKeyWrite === 'function') _onBackupKeyWrite(key)
    return true
  },
  getObj: (key, def = {}) => { try { return JSON.parse(localStorage.getItem(key)) ?? def } catch { return def } },
}

// ===== UTILS =====
function formatCurrencyPlain(n) {
  return new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2 }).format(n)
}
// HTML display variant — wraps the amount in .cur so privacy mode can blur every
// figure from one CSS rule. Use formatCurrencyPlain() for NON-HTML contexts
// (chart tooltips, title attributes, toasts, AI prompt strings, CSV).
function formatCurrency(n) {
  return `<span class="cur">${formatCurrencyPlain(n)}</span>`
}
function formatDate(str) {
  if (!str) return ''
  const [y, m, d] = str.split('-')
  return `${d}/${m}/${y}`
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

function _rawHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

// Returns { hash, legacyHash, looseHash }:
//   hash       — includes description, avoiding false dup-matches when the
//                same vendor charges the same amount twice on the same day.
//   legacyHash — pre-1.9.1 formula (no description). Kept so re-imports of
//                files indexed before the upgrade still detect existing rows.
//   looseHash  — vendor-agnostic (accountId|date|amount). Secondary match for
//                AI-imported files where Gemini may return a different vendor
//                string on re-import, causing exact hash to miss the duplicate.
// saveImport stores all three; _finalizeParsedTransactions matches exact first,
// then falls back to loose (flagged as _maybeDuplicate, unchecked but overrideable).
function hashTx(tx, accountId) {
  const v1 = `${accountId}|${tx.date}|${tx.amount}|${tx.vendor}`
  const v2 = `${accountId}|${tx.date}|${tx.amount}|${tx.vendor}|${tx.description||''}`
  const v0 = `${accountId}|${tx.date}|${tx.amount}`
  return { hash: _rawHash(v2), legacyHash: _rawHash(v1), looseHash: _rawHash(v0) }
}

// ===== NAVIGATION =====
const SCREENS = ['dashboard', 'transactions', 'import', 'analysis', 'recurring', 'budget', 'property', 'settings']
let _currentScreen = null

// `fromHash` is true when invoked by the hashchange listener — used to skip a
// redundant re-render when the URL hash merely echoes the screen we just set.
function navigate(screen, fromHash = false) {
  if (!SCREENS.includes(screen)) screen = 'dashboard'
  if (fromHash && screen === _currentScreen) return
  _currentScreen = screen

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'))
  const el = document.getElementById('screen-' + screen)
  if (el) el.classList.add('active')
  document.querySelectorAll(`[data-screen="${screen}"]`).forEach(l => l.classList.add('active'))
  closeMobileMenu()

  if (screen === 'dashboard') renderDashboard()
  if (screen === 'transactions') renderTransactions()
  if (screen === 'import') initImport()
  if (screen === 'analysis') renderAnalysis()
  if (screen === 'recurring') renderRecurring()
  if (screen === 'budget') renderBudgetScreen()
  if (screen === 'property') renderProperty()
  if (screen === 'settings') renderSettings()

  // Keep the URL hash in sync for deep-linking + browser back/forward.
  if (location.hash.slice(1) !== screen) location.hash = screen
}

function _onHashChange() {
  const s = location.hash.slice(1)
  navigate(SCREENS.includes(s) ? s : 'dashboard', true)
}

function toggleMobileMenu() {
  document.getElementById('sidebar').classList.toggle('open')
  document.getElementById('sidebarOverlay').classList.toggle('open')
}
function closeMobileMenu() {
  document.getElementById('sidebar').classList.remove('open')
  document.getElementById('sidebarOverlay').classList.remove('open')
}

// ===== DEFAULT DATA =====
const DEFAULT_CATEGORIES = [
  { id: 'cat_food',      name: 'מזון וסופרמרקט',  type: 'expense', color: '#ef4444', icon: '🛒', system: true },
  { id: 'cat_rest',      name: 'מסעדות ובתי קפה',  type: 'expense', color: '#f97316', icon: '🍽️', system: true },
  { id: 'cat_transport', name: 'תחבורה',            type: 'expense', color: '#eab308', icon: '🚗', system: true },
  { id: 'cat_fuel',      name: 'דלק',               type: 'expense', color: '#84cc16', icon: '⛽', system: true },
  { id: 'cat_rent',      name: 'דיור ושכירות',      type: 'expense', color: '#06b6d4', icon: '🏠', system: true },
  { id: 'cat_bills',     name: 'חשבונות וחשמל',    type: 'expense', color: '#3b82f6', icon: '💡', system: true },
  { id: 'cat_health',    name: 'בריאות ורפואה',     type: 'expense', color: '#a855f7', icon: '🏥', system: true },
  { id: 'cat_clothing',  name: 'ביגוד והנעלה',      type: 'expense', color: '#ec4899', icon: '👕', system: true },
  { id: 'cat_leisure',   name: 'בידור ופנאי',       type: 'expense', color: '#14b8a6', icon: '🎮', system: true },
  { id: 'cat_insurance', name: 'ביטוח',              type: 'expense', color: '#6366f1', icon: '🛡️', system: true },
  { id: 'cat_bank',      name: 'עמלות בנק',         type: 'expense', color: '#64748b', icon: '🏦', system: true },
  { id: 'cat_online',    name: 'קניות אונליין',     type: 'expense', color: '#0ea5e9', icon: '📦', system: true },
  { id: 'cat_invest_out', name: 'חסכונות והשקעות',   type: 'expense', color: '#0ea5e9', icon: '💰', system: true, isSavings: true },
  { id: 'cat_other_exp', name: 'אחר – הוצאה',       type: 'expense', color: '#9ca3af', icon: '📋', system: true },
  { id: 'cat_salary',    name: 'משכורת',             type: 'income',  color: '#22c55e', icon: '💼', system: true },
  { id: 'cat_extra',     name: 'הכנסה נוספת',       type: 'income',  color: '#10b981', icon: '💰', system: true },
  { id: 'cat_taxback',   name: 'החזר מס',            type: 'income',  color: '#34d399', icon: '📑', system: true },
  { id: 'cat_invest',    name: 'ריבית והשקעות',     type: 'income',  color: '#6ee7b7', icon: '📈', system: true },
  { id: 'cat_other_inc', name: 'אחר – הכנסה',       type: 'income',  color: '#a7f3d0', icon: '📋', system: true },
  { id: 'cat_transfer',  name: 'העברה',              type: 'transfer',color: '#94a3b8', icon: '🔄', system: true },
]

function initDefaultData() {
  if (!localStorage.getItem('finCategories')) {
    DB.set('finCategories', DEFAULT_CATEGORIES)
  } else {
    // Seed newly-added system categories into existing installs
    const cats = getCategories()
    const byId = new Set(cats.map(c => c.id))
    let added = false
    DEFAULT_CATEGORIES.forEach(dc => {
      if (dc.system && !byId.has(dc.id)) { cats.push(dc); added = true }
    })
    if (added) DB.set('finCategories', cats)
  }
}

// ===== GETTERS =====
function getTransactions() { return DB.get('finTransactions', []) }
function getAccounts()    { return DB.get('finAccounts', []) }
function getCategories()  { return DB.get('finCategories', DEFAULT_CATEGORIES) }
function getCategoryById(id) { return getCategories().find(c => c.id === id) }
function getApiKey()      { return localStorage.getItem('geminiApiKey') || '' }

const DEFAULT_PROMPT = `אתה מנתח דוחות בנק ישראלים. נתח את הקובץ והחזר JSON בלבד – ללא טקסט נוסף, ללא backticks.

מערך עסקאות בפורמט:
[{"date":"YYYY-MM-DD","amount":250.00,"vendor":"שם הספק","description":"תיאור מלא","type":"expense","category":"שם הקטגוריה"}]

חוקים:
- date: תאריך בפורמט YYYY-MM-DD
- amount: חיובי להכנסה, שלילי להוצאה
- type: income | expense | transfer | refund
- vendor: שם נקי ללא מספרים מיותרים
- description: העתק את שדה "פירוט" / "תיאור" מהקובץ במלואו (כולל ציוני "תשלום X מתוך Y", "הוראת קבע", ושמות נמענים בעסקאות ביט/פייבוקס)
- אל תכלול יתרות חשבון כעסקאות
- חיובי כרטיס אשראי מרוכזים (ויזה, מסטרקארד, ישראכרט, כאל, אמקס, דיינרס, לאומי קארד, מקס) – סמן כ-transfer
- מיין לפי תאריך עולה

סיווג לקטגוריות (חובה לכל עסקה):
- מזון וסופרמרקט: רמי לוי, שופרסל, מגה, ויקטורי, יוחננוף, אושר עד, חצי חינם, פרש מרקט וכו׳
- מסעדות ובתי קפה: מסעדות, קפה, פיצה, סושי, מקדונלדס, ארומה, קפה קפה וכו׳
- תחבורה: רכבת, אגד, דן, מוניות, גט, אובר, יאנגו וכו׳
- דלק: סונול, פז, דלק, דור אלון, Ten וכו׳
- דיור ושכירות: שכירות, ועד בית, ארנונה, משכנתא
- חשבונות וחשמל: חשמל, מים, גז, אינטרנט, סלולר, פרטנר, סלקום, הוט וכו׳
- בריאות ורפואה: קופת חולים, מכבי, כללית, בית מרקחת, סופר-פארם וכו׳
- ביגוד והנעלה: H&M, זארה, קסטרו, פוקס, רנואר, גולף וכו׳
- בידור ופנאי: סרטים, הופעות, נטפליקס, ספוטיפיי, חוגים וכו׳
- ביטוח: ביטוח רכב, ביטוח בריאות, ביטוח דירה, ביטוח חיים
- עמלות בנק: עמלה, דמי ניהול, ריבית חובה
- קניות אונליין: אמזון, עלי אקספרס, איביי, SHEIN וכו׳
- משכורת: משכורת, שכר, העברה ממעסיק
- הכנסה נוספת: שכירות שהתקבלה, פרילנס, בונוס
- החזר מס: החזר מס, מס הכנסה, ביטוח לאומי (זיכוי)
- ריבית והשקעות: ריבית, דיבידנד, רווח הון
- העברה: העברה בין חשבונות, הפקדה, משיכה
- אחר: כל דבר שלא מתאים לקטגוריות למעלה`

function getPrompt() { return localStorage.getItem('geminiPrompt') || DEFAULT_PROMPT }

const DEFAULT_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
function getGeminiModels() {
  try {
    const stored = JSON.parse(localStorage.getItem('geminiModels'))
    if (Array.isArray(stored) && stored.length) {
      const cleaned = stored.map(s => String(s || '').trim()).filter(Boolean)
      if (cleaned.length) return cleaned
    }
  } catch {}
  return DEFAULT_GEMINI_MODELS.slice()
}
function setGeminiModels(list) {
  localStorage.setItem('geminiModels', JSON.stringify(list))
}

async function callGemini(apiKey, body) {
  let lastError = ''
  for (const model of getGeminiModels()) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    )
    const data = await res.json()
    if (res.ok) return data
    lastError = data.error?.message || 'שגיאת API'
    const status = data.error?.status || ''
    const shouldFallback = res.status === 429 || res.status === 503
      || status === 'RESOURCE_EXHAUSTED' || status === 'UNAVAILABLE'
    if (!shouldFallback) throw new Error(lastError)
  }
  throw new Error('כל המודלים עמוסים כרגע – נסה שוב בעוד דקה')
}

async function testGeminiModels(apiKey, promptText, modelsList) {
  const models = (Array.isArray(modelsList) && modelsList.length) ? modelsList : getGeminiModels()
  const results = []
  for (const model of models) {
    const startedAt = performance.now()
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }) }
      )
      const data = await res.json()
      const ms = Math.round(performance.now() - startedAt)
      if (res.ok) {
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        results.push({ model, ok: true, ms, reply })
      } else {
        results.push({ model, ok: false, ms, error: data.error?.message || `HTTP ${res.status}` })
      }
    } catch (e) {
      results.push({ model, ok: false, ms: Math.round(performance.now() - startedAt), error: e.message || 'Network error' })
    }
  }
  return results
}

// ===== EXPORT / IMPORT =====
// Single source of truth for the backup payload — used by the JSON export,
// JSON import, AND the Google Drive backup/restore (drive.js). Keep all three
// in sync by editing only these two functions.
function collectBackupData() {
  return {
    transactions:        getTransactions(),
    accounts:            getAccounts(),
    categories:          getCategories(),
    budgets:             getBudgets(),
    rules:               getCategoryRules(),
    templates:           getTemplates(),
    aliases:             getVendorAliases(),
    recurringGroups:     DB.get('finManualRecurringGroups', []),
    recurringHidden:     DB.get('finRecurringHidden', []),
    recurringIgnoreOut:  DB.get('finRecurringIgnoreOutliers', []),
    recurringAmountOverride: DB.get('finRecurringAmountOverride', {}),
    recurringCadenceOverride: DB.get('finRecurringCadenceOverride', {}),
    hiddenTopVendors:    DB.get('finHiddenTopVendors', []),
    property:            DB.get('finProperty', null),
    propertyPayments:    DB.get('finPropertyPayments', []),
    propertyManualMortgage: DB.get('finPropertyManualMortgage', []),
    feedback:            DB.get('finFeedback', []),
    reconciliation:      DB.getObj('finReconciliation', {}),
    exportedAt:          new Date().toISOString(),
  }
}

function applyBackupData(data) {
  if (!data || typeof data !== 'object') return
  if (data.transactions)       DB.set('finTransactions',            data.transactions)
  if (data.accounts)           DB.set('finAccounts',                data.accounts)
  if (data.categories)         DB.set('finCategories',              data.categories)
  if (data.budgets)            DB.set('finBudgets',                 data.budgets)
  if (data.rules)              DB.set('finCategoryRules',           data.rules)
  if (data.templates)          DB.set('finImportTemplates',         data.templates)
  if (data.aliases)            DB.set('finVendorAliases',           data.aliases)
  if (data.recurringGroups)    DB.set('finManualRecurringGroups',   data.recurringGroups)
  if (data.recurringHidden)    DB.set('finRecurringHidden',         data.recurringHidden)
  if (data.recurringIgnoreOut) DB.set('finRecurringIgnoreOutliers', data.recurringIgnoreOut)
  if (data.recurringAmountOverride) DB.set('finRecurringAmountOverride', data.recurringAmountOverride)
  if (data.recurringCadenceOverride) DB.set('finRecurringCadenceOverride', data.recurringCadenceOverride)
  if (data.hiddenTopVendors)   DB.set('finHiddenTopVendors',        data.hiddenTopVendors)
  if (data.property)           DB.set('finProperty',                data.property)
  if (data.propertyPayments)   DB.set('finPropertyPayments',        data.propertyPayments)
  if (data.propertyManualMortgage) DB.set('finPropertyManualMortgage', data.propertyManualMortgage)
  if (data.feedback)           DB.set('finFeedback',                data.feedback)
  if (data.reconciliation)     DB.set('finReconciliation',          data.reconciliation)
  if (typeof invalidatePLCache === 'function')            invalidatePLCache()
  if (typeof invalidateSavingsCache === 'function')       invalidateSavingsCache()
  if (typeof invalidateCapitalIncomeCache === 'function') invalidateCapitalIncomeCache()
  if (typeof invalidateVendorAliasCache === 'function')   invalidateVendorAliasCache()
}

function exportData() {
  const blob = new Blob([JSON.stringify(collectBackupData(), null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `כספים-גיבוי-${new Date().toLocaleDateString('he-IL').replace(/\//g, '-')}.json`
  a.click()
}
function importData(input) {
  const file = input.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = e => {
    try {
      applyBackupData(JSON.parse(e.target.result))
      toast('הנתונים יובאו בהצלחה', { type: 'success' })
      renderSettings()
    } catch { toast('שגיאה בקריאת הקובץ', { type: 'error' }) }
  }
  reader.readAsText(file)
  input.value = ''
}

// ===== EDIT MODAL =====
let _editId = null
let _editIsNew = false
function openEditModal(id) {
  const txs = getTransactions()
  let tx = txs.find(t => t.id === id)
  _editIsNew = !tx
  if (!tx) {
    const accs = getAccounts()
    tx = {
      id: genId(), accountId: accs[0]?.id || '', date: new Date().toISOString().slice(0,10),
      amount: 0, vendor: '', description: '', type: 'expense', categoryId: '', notes: '', createdAt: Date.now(),
    }
  }
  _editId = tx.id
  _editRefundForTxId = tx.refundForTxId || null
  const cats = getCategories()
  const accs = getAccounts()
  const catOptions = cats.map(c => `<option value="${c.id}" ${tx.categoryId === c.id ? 'selected' : ''}>${catIconText(c)} ${c.name}</option>`).join('')
  const accOptions = accs.map(a => `<option value="${a.id}" ${tx.accountId === a.id ? 'selected' : ''}>${a.name}</option>`).join('')
  const typeOptions = ['income','expense','transfer','refund'].map(tp => {
    const lbl = { income:'הכנסה', expense:'הוצאה', transfer:'העברה', refund:'החזר' }[tp]
    return `<option value="${tp}" ${tx.type===tp?'selected':''}>${lbl}</option>`
  }).join('')
  // destination account for transfers (excluding source)
  const destAccOptions = accs.filter(a => a.id !== tx.accountId).map(a =>
    `<option value="${a.id}" ${tx.transferAccountId === a.id ? 'selected' : ''}>${a.name}</option>`).join('')

  const showDest = tx.type === 'transfer' ? 'block' : 'none'
  document.getElementById('editModalTitle').textContent = _editIsNew ? 'עסקה חדשה' : 'עריכת עסקה'
  document.getElementById('editDeleteBtn').style.display = _editIsNew ? 'none' : 'inline-flex'
  document.getElementById('editModalBody').innerHTML = `
    <div class="modal-row"><label class="form-label">חשבון</label><select id="editAccount">${accOptions}</select></div>
    <div class="modal-row"><label class="form-label">ספק</label><input id="editVendor" value="${tx.vendor || ''}"></div>
    <div class="modal-row"><label class="form-label">תאריך</label><input id="editDate" type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" value="${_isoToDmy(tx.date)}" oninput="_onDateMaskInput(this)"></div>
    <div class="modal-row"><label class="form-label">סכום (חיובי=הכנסה)</label><input id="editAmount" type="number" step="0.01" value="${tx.amount}"></div>
    <div class="modal-row"><label class="form-label">סוג</label><select id="editType" onchange="_onEditTypeChange()">${typeOptions}</select></div>
    <div class="modal-row" id="editDestRow" style="display:${showDest}"><label class="form-label">חשבון יעד (להעברה)</label><select id="editDestAccount"><option value="">—</option>${destAccOptions}</select></div>
    <div class="modal-row"><label class="form-label">קטגוריה</label><select id="editCategory"><option value="">ללא קטגוריה</option>${catOptions}</select></div>
    <div class="modal-row" id="editRefundRow" style="display:${tx.type==='refund'?'block':'none'}">
      <label class="form-label">החזר עבור הוצאה</label>
      <div id="editRefundLink">${_refundLinkRowHTML()}</div>
    </div>
    <div class="modal-row" style="margin-top:-.5rem"><button type="button" class="btn-ghost" style="font-size:.85rem;padding:.45rem .8rem" onclick="applyCategoryToAllSimilar()">החל קטגוריה על כל העסקאות עם אותו ספק (קדימה ואחורה)</button></div>
    <div class="modal-row">
      <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;font-size:.9rem">
        <input type="checkbox" id="editOneOff" ${tx.oneOff ? 'checked' : ''} style="width:auto;margin:0">
        <span>סיווג חד-פעמי — אל תחיל על עסקאות דומות (ביט/פייבוקס וכו')</span>
      </label>
      <div style="font-size:.72rem;color:var(--text-muted);margin-top:.3rem">הקטגוריה ושם הספק יחולו על העסקה הזו בלבד — בלי הפצה לעסקאות אחרות ובלי שהזיהוי האוטומטי ילמד מהן.</div>
    </div>
    ${tx.recurringGroupId ? (() => {
      const grp = (typeof getManualRecurringGroups === 'function') ? getManualRecurringGroups().find(g => g.id === tx.recurringGroupId) : null
      const label = grp?.label || 'קבוצה ידנית'
      return `<div class="modal-row" style="background:var(--bg-elevated);padding:.6rem .8rem;border-radius:8px;font-size:.85rem">
        🔗 חלק מקבוצת קבועה: <strong>${label}</strong>
        <div style="font-size:.72rem;color:var(--text-muted);margin-top:.3rem">הקבוצה אחראית על ה-cadence והאיחוד במסך הקבועות. כדי להוציא את העסקה — פרק את הקבוצה במסך הקבועות.</div>
        <input type="hidden" id="editRecurringFlag" value="${tx.recurringFlag || ''}">
      </div>`
    })() : `
    <div class="modal-row">
      <label class="form-label">סימון כקבוע</label>
      <select id="editRecurringFlag">
        <option value=""           ${!tx.recurringFlag ? 'selected' : ''}>— ללא —</option>
        <option value="monthly"    ${tx.recurringFlag==='monthly'   ?'selected':''}>חודשי</option>
        <option value="bimonthly"  ${tx.recurringFlag==='bimonthly' ?'selected':''}>דו-חודשי</option>
        <option value="quarterly"  ${tx.recurringFlag==='quarterly' ?'selected':''}>רבעוני</option>
      </select>
      <div style="font-size:.72rem;color:var(--text-muted);margin-top:.3rem">סימון מעלה את העסקה (ואת שאר העסקאות מאותו ספק) למסך ההוצאות/הכנסות הקבועות גם כשהזיהוי האוטומטי לא תופס אותן.</div>
    </div>`}
    <div class="modal-row"><label class="form-label">הערות</label><input id="editNotes" value="${tx.notes || ''}"></div>
  `
  document.getElementById('editModal').classList.add('open')
}
function _onEditTypeChange() {
  const tp = document.getElementById('editType').value
  document.getElementById('editDestRow').style.display = tp === 'transfer' ? 'block' : 'none'
  const rr = document.getElementById('editRefundRow')
  if (rr) rr.style.display = tp === 'refund' ? 'block' : 'none'
}

// ===== REFUND → EXPENSE LINK =====
let _editRefundForTxId = null

function _refundLinkRowHTML() {
  if (_editRefundForTxId) {
    const e = getTransactions().find(t => t.id === _editRefundForTxId)
    if (e) {
      const v = (typeof resolveVendor === 'function') ? (resolveVendor(e.vendor, e.amount, getTxAliasDay(e)) || e.vendor) : e.vendor
      return `<div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
        <span style="background:var(--bg-elevated);padding:.35rem .6rem;border-radius:8px;font-size:.85rem">↩ ${v} · ${formatCurrency(e.amount)} · ${formatDate(e.date)}</span>
        <button type="button" class="btn-ghost" style="font-size:.8rem;padding:.3rem .6rem" onclick="openRefundPicker()">שנה</button>
        <button type="button" class="btn-ghost" style="font-size:.8rem;padding:.3rem .6rem;color:var(--expense)" onclick="unlinkRefund()">נתק</button>
      </div>`
    }
  }
  return `<button type="button" class="btn-ghost" style="font-size:.85rem;padding:.45rem .8rem" onclick="openRefundPicker()">בחר הוצאה לקיזוז</button>`
}

function _refreshRefundLinkRow() {
  const el = document.getElementById('editRefundLink')
  if (el) el.innerHTML = _refundLinkRowHTML()
}

function unlinkRefund() { _editRefundForTxId = null; _refreshRefundLinkRow() }

function openRefundPicker() {
  const catSel = document.getElementById('refundPickCat')
  if (catSel) {
    catSel.innerHTML = '<option value="">כל הקטגוריות</option>' +
      getCategories().filter(c => c.type === 'expense').map(c => `<option value="${c.id}">${catIconText(c)} ${c.name}</option>`).join('')
  }
  const s = document.getElementById('refundPickSearch'); if (s) s.value = ''
  renderRefundPickerList()
  document.getElementById('refundPickerModal').classList.add('open')
}
function closeRefundPicker() { document.getElementById('refundPickerModal').classList.remove('open') }

function renderRefundPickerList() {
  const term = (document.getElementById('refundPickSearch')?.value || '').trim().toLowerCase()
  const catFilter = document.getElementById('refundPickCat')?.value || ''
  const days = parseInt(document.getElementById('refundPickPeriod')?.value || '90', 10)
  const cutoff = days > 0 ? _iso(new Date(Date.now() - days * 86400000)) : ''
  // Candidate expenses: real outflows (not the refund itself / transfers / other refunds).
  let cands = getTransactions().filter(t =>
    t.id !== _editId && t.amount < 0 && t.type !== 'transfer' && t.type !== 'refund'
  )
  if (cutoff) cands = cands.filter(t => (t.date || '') >= cutoff)
  if (catFilter) cands = cands.filter(t => t.categoryId === catFilter)
  if (term) cands = cands.filter(t => {
    const v = (resolveVendor(t.vendor, t.amount, getTxAliasDay(t)) || t.vendor || '').toLowerCase()
    return v.includes(term) || String(Math.abs(t.amount)).includes(term)
  })
  cands.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  cands = cands.slice(0, 200)

  const el = document.getElementById('refundPickList')
  if (!el) return
  if (cands.length === 0) { el.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:1.5rem">לא נמצאו הוצאות מתאימות</p>'; return }
  el.innerHTML = cands.map(t => {
    const cat = getCategoryById(t.categoryId)
    const v = resolveVendor(t.vendor, t.amount, getTxAliasDay(t)) || t.vendor || '—'
    return `<div class="refund-pick-row" onclick="selectRefundExpense('${t.id}')" style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;padding:.55rem .7rem;border:1px solid var(--border);border-radius:8px;margin-bottom:.4rem;cursor:pointer">
      <div style="min-width:0"><div style="font-weight:500">${v}</div><div style="font-size:.75rem;color:var(--text-muted)">${formatDate(t.date)}${cat ? ' · ' + cat.name : ''}</div></div>
      <span class="amount-exp" style="font-weight:600;white-space:nowrap">${formatCurrency(t.amount)}</span>
    </div>`
  }).join('')
}

function selectRefundExpense(txId) {
  _editRefundForTxId = txId
  // Auto-fill the refund's category from the linked expense (manual override
  // still possible — the user can change the category select afterwards).
  const e = getTransactions().find(t => t.id === txId)
  const catSel = document.getElementById('editCategory')
  if (e && e.categoryId && catSel) catSel.value = e.categoryId
  _refreshRefundLinkRow()
  closeRefundPicker()
}
function closeEditModal() { document.getElementById('editModal').classList.remove('open'); _editId = null; _editIsNew = false }
function saveEditModal() {
  if (!_editId) return
  const vendorEl = document.getElementById('editVendor')
  const amountEl = document.getElementById('editAmount')
  const newAmount = parseFloat(amountEl.value)
  let invalid = false
  if (!vendorEl.value.trim()) { markInvalid(vendorEl, 'שדה חובה'); invalid = true }
  if (isNaN(newAmount)) { markInvalid(amountEl, 'הזן סכום'); invalid = true }
  if (invalid) { toast('יש להשלים את השדות המסומנים', { type: 'error' }); return }
  const txs = getTransactions()
  const newType = document.getElementById('editType').value
  const destId = document.getElementById('editDestAccount').value
  const newRecurringFlag = document.getElementById('editRecurringFlag')?.value || ''
  if (_editIsNew) {
    const fresh = {
      id: _editId,
      accountId: document.getElementById('editAccount').value,
      date: _dmyToIso(document.getElementById('editDate').value) || _iso(new Date()),
      amount: isNaN(newAmount) ? 0 : newAmount,
      vendor: document.getElementById('editVendor').value,
      description: '',
      type: newType,
      categoryId: document.getElementById('editCategory').value,
      notes: document.getElementById('editNotes').value,
      transferAccountId: newType === 'transfer' ? destId : undefined,
      ccPaymentForAccountId: undefined,
      createdAt: Date.now(),
    }
    if (newRecurringFlag) fresh.recurringFlag = newRecurringFlag
    txs.push(fresh)
  } else {
    const idx = txs.findIndex(t => t.id === _editId)
    if (idx < 0) return
    txs[idx].accountId  = document.getElementById('editAccount').value
    txs[idx].vendor     = document.getElementById('editVendor').value
    txs[idx].date       = _dmyToIso(document.getElementById('editDate').value) || txs[idx].date
    if (!isNaN(newAmount)) txs[idx].amount = newAmount
    txs[idx].type       = newType
    txs[idx].categoryId = document.getElementById('editCategory').value
    txs[idx].notes      = document.getElementById('editNotes').value
    if (newRecurringFlag) txs[idx].recurringFlag = newRecurringFlag
    else delete txs[idx].recurringFlag
    if (newType === 'transfer') {
      txs[idx].transferAccountId = destId || undefined
      // keep existing ccPaymentForAccountId if destination matches
      if (destId && getAccounts().find(a => a.id === destId)?.type === 'credit_card') {
        txs[idx].ccPaymentForAccountId = destId
      } else if (destId) {
        txs[idx].ccPaymentForAccountId = undefined
      }
    } else {
      txs[idx].transferAccountId = undefined
      txs[idx].ccPaymentForAccountId = undefined
    }
  }
  // Auto-propagate: if a category was set on a non-transfer transaction, apply
  // it to all uncategorized transactions with the same normalized vendor (past
  // and future). User categorizes once — system learns. The "one-off" flag
  // (e.g. Bit/PayBox, where each payment is unrelated) opts out: no propagation
  // and autocat won't learn from it.
  const oneOff = !!document.getElementById('editOneOff')?.checked
  let propagated = 0
  const editedIdx = txs.findIndex(t => t.id === _editId)
  const edited = editedIdx >= 0 ? txs[editedIdx] : null
  if (edited) { if (oneOff) edited.oneOff = true; else delete edited.oneOff }
  if (edited) {
    if (edited.type === 'refund' && _editRefundForTxId) edited.refundForTxId = _editRefundForTxId
    else delete edited.refundForTxId
  }
  if (edited && !oneOff && edited.categoryId && edited.type !== 'transfer' && edited.vendor) {
    propagated = propagateCategoryToSimilar(txs, edited.vendor, edited.categoryId, edited.id)
  }

  DB.set('finTransactions', txs)
  closeEditModal()
  renderTransactions()
  if (propagated > 0) showPropagateToast(propagated)
}

function propagateCategoryToSimilar(txs, vendor, categoryId, skipId) {
  if (typeof normalizeVendorForAutocat !== 'function') return 0
  const target = normalizeVendorForAutocat(vendor)
  if (!target) return 0
  let count = 0
  for (const t of txs) {
    if (t.id === skipId) continue
    if (t.categoryId) continue
    if (t.type === 'transfer') continue
    if (!t.vendor) continue
    if (normalizeVendorForAutocat(t.vendor) !== target) continue
    t.categoryId = categoryId
    count++
  }
  return count
}

// Manual "apply to all" from edit modal: OVERRIDES existing categorizations
// on every transaction whose normalized vendor matches the one currently
// being edited. Confirms with the user first. Writes the current categoryId
// selected in the modal — even before saving — so user can preview.
async function applyCategoryToAllSimilar() {
  if (!_editId) return
  const vendor = document.getElementById('editVendor').value
  const catId  = document.getElementById('editCategory').value
  if (!vendor.trim()) { toast('יש להזין שם ספק לפני החלה על דומים', { type: 'error' }); return }
  if (!catId)         { toast('יש לבחור קטגוריה לפני החלה על דומים', { type: 'error' }); return }
  if (typeof normalizeVendorForAutocat !== 'function') return
  const target = normalizeVendorForAutocat(vendor)
  if (!target) { toast('שם הספק לא תקין', { type: 'error' }); return }

  const txs = getTransactions()
  const matches = txs.filter(t =>
    t.vendor && t.type !== 'transfer' && normalizeVendorForAutocat(t.vendor) === target
  )
  if (matches.length === 0) { toast('לא נמצאו עסקאות דומות', { type: 'error' }); return }

  const cat = getCategoryById(catId)
  const catLabel = cat ? `${catIconText(cat)} ${cat.name}` : catId
  if (!await confirmDialog(`להחיל את הקטגוריה "${catLabel}" על ${matches.length} עסקאות עם אותו ספק (כולל עסקאות שכבר מסווגות)?`, { confirmText: 'החל' })) return

  let changed = 0
  txs.forEach(t => {
    if (!t.vendor) return
    if (t.type === 'transfer') return
    if (normalizeVendorForAutocat(t.vendor) !== target) return
    if (t.categoryId !== catId) { t.categoryId = catId; changed++ }
  })
  DB.set('finTransactions', txs)
  showPropagateToast(changed)
}

function showPropagateToast(n) {
  toast(`סווגו ${n} עסקאות דומות אוטומטית`, { type: 'success' })
}

function addManualTransaction() {
  _editIsNew = true
  openEditModal(null)
}
async function deleteFromModal() {
  if (!_editId) return
  if (!(await confirmDialog('האם למחוק עסקה זו?', { danger: true, confirmText: 'מחק' }))) return
  const deletedId = _editId
  const snapshot = getTransactions().find(t => t.id === deletedId)
  DB.set('finTransactions', getTransactions().filter(t => t.id !== deletedId))
  closeEditModal()
  renderTransactions()
  toast('העסקה נמחקה', {
    type: 'success',
    action: snapshot ? {
      label: 'בטל',
      onClick: () => {
        const cur = getTransactions()
        if (!cur.some(t => t.id === deletedId)) { cur.push(snapshot); DB.set('finTransactions', cur) }
        renderTransactions()
        if (typeof renderDashboard === 'function') renderDashboard()
      },
    } : null,
  })
}

// ===== MIGRATIONS =====
const CC_KEYWORDS = ['ויזה','visa','מסטרקארד','mastercard','ישראכרט','isracard','כאל','cal','אמריקן אקספרס','american express','amex','דיינרס','diners','לאומי קארד','לאומי ויזה','מקס','max','כרטיס אשראי','credit card','חיוב כרטיס']

function migrateCreditCardTransfers() {
  if (localStorage.getItem('migration_cc_transfers')) return
  const ccAccIds = new Set(getAccounts().filter(a => a.type === 'credit_card').map(a => a.id))
  const txs = getTransactions()
  let changed = 0
  txs.forEach(t => {
    if (t.type !== 'expense' || t.amount > 0) return
    // Never auto-convert transactions that live inside a credit card account
    if (ccAccIds.has(t.accountId)) return
    const text = ((t.vendor || '') + ' ' + (t.description || '')).toLowerCase()
    if (CC_KEYWORDS.some(kw => text.includes(kw))) {
      t.type = 'transfer'
      changed++
    }
  })
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_cc_transfers', '1')
}

function migrateTransferLinking_v2() {
  if (localStorage.getItem('migration_transfer_v2')) return
  // Link transfers to matching pattern-bearing accounts (CC / savings / investment).
  autoLinkTransfersByPattern()
  // Also fix CC-statement purchases that were mistakenly marked as transfer.
  fixCcStatementTypes()
  localStorage.setItem('migration_transfer_v2', '1')
}

// v1.8.1 migration — re-counts ALL auto-linked bank outflows in P&L.
// Before 1.8.1, `autoLinkTransfersByPattern` flipped bank→CC payments and
// bank→savings/investment deposits to type='transfer', silently removing them
// from income/expense totals. This reverts any lingering transfer rows on
// liquid accounts back to expense/income while PRESERVING the link fields
// (so balance mirrors and pie-exclusion continue to work).
function migrateRelinkAutoTransfers_v3() {
  if (localStorage.getItem('migration_relink_auto_transfers_v3') === '1') return
  const txs = getTransactions()
  const accs = getAccounts()
  const liquidIds = new Set(accs.filter(a => a.type === 'checking' || a.type === 'cash').map(a => a.id))
  let changed = 0
  txs.forEach(t => {
    if (t.type !== 'transfer') return
    if (!liquidIds.has(t.accountId)) return
    if (!t.ccPaymentForAccountId && !t.transferAccountId) return
    // Revert type so the row counts in P&L; keep link fields intact.
    t.type = t.amount > 0 ? 'income' : 'expense'
    // For savings/investment links that had no category, assign cat_invest_out
    if (t.transferAccountId && !t.ccPaymentForAccountId && !t.categoryId) {
      const dest = accs.find(a => a.id === t.transferAccountId)
      if (dest && (dest.type === 'savings' || dest.type === 'investment')) {
        t.categoryId = 'cat_invest_out'
      }
    }
    changed++
  })
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_relink_auto_transfers_v3', '1')
  if (changed > 0) console.log(`Migration v3: reverted ${changed} auto-linked transfers to P&L-counted expenses`)
}

// Reverts auto-linked CC transfers on bank accounts back to expense/income.
// Before 1.7.2, imported bank transactions matching a CC pattern were marked as
// type='transfer' with ccPaymentForAccountId. That choice excluded them from
// P&L — but the user wants the bank line to be the authoritative expense.
// This migration restores those to real expenses/incomes.
function migrateRevertAutoCc_v1() {
  if (localStorage.getItem('migration_revert_auto_cc_v1') === '1') return
  const txs = getTransactions()
  const accs = getAccounts()
  const plIds = new Set(accs.filter(a => a.type === 'checking' || a.type === 'cash').map(a => a.id))
  let changed = 0
  txs.forEach(t => {
    if (t.type !== 'transfer') return
    if (!plIds.has(t.accountId)) return
    if (!t.ccPaymentForAccountId) return  // only auto-linked rows had this flag
    t.type = t.amount > 0 ? 'income' : 'expense'
    delete t.transferAccountId
    delete t.ccPaymentForAccountId
    changed++
  })
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_revert_auto_cc_v1', '1')
  if (changed > 0) console.log(`Migration: reverted ${changed} auto-linked CC transfers to P&L expenses/income`)
}

// One-time rescue migration: before v1.9.0, migrateCreditCardTransfers()
// flipped bank rows matching CC keywords to type='transfer' WITHOUT
// setting ccPaymentForAccountId/transferAccountId. The three follow-up
// revert migrations all guard on those link fields, so these "orphaned
// transfers" slipped through every cleanup and vanished from P&L.
// This restores them to real income/expense (link fields remain absent,
// which is correct — they were never linked to anything).
function migrateOrphanedTransfers_v4() {
  if (localStorage.getItem('migration_orphaned_v4') === '1') return
  const txs = getTransactions()
  const accs = getAccounts()
  const liquidIds = new Set(
    accs.filter(a => a.type === 'checking' || a.type === 'cash').map(a => a.id)
  )
  let changed = 0
  txs.forEach(t => {
    if (t.type !== 'transfer') return
    if (!liquidIds.has(t.accountId)) return
    if (t.ccPaymentForAccountId || t.transferAccountId) return
    t.type = t.amount > 0 ? 'income' : 'expense'
    changed++
  })
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_orphaned_v4', '1')
  if (changed > 0) console.log(`Migration v4: restored ${changed} orphaned transfers to P&L`)
}

// One-shot enrichment of existing rows. The detectors in detect.js are pure
// — running them after the fact catches installments, standing orders and
// bit/paybox payees the user already imported before v1.21.42. Vendor rewrites
// only happen when the recipient can be extracted from the description, so
// untouched rows stay as-is. Auto-notes are only prepended when notes is
// empty, to avoid trampling on user-written notes.
function migrateDetectFields_v1() {
  if (localStorage.getItem('migration_detect_fields_v1') === '1') return
  if (typeof enrichDetectedFields !== 'function') return
  const txs = getTransactions()
  let changed = 0
  for (const t of txs) {
    const enriched = enrichDetectedFields(t)
    let touched = false
    if (enriched.installmentCurrent && enriched.installmentTotal &&
        (t.installmentCurrent !== enriched.installmentCurrent || t.installmentTotal !== enriched.installmentTotal)) {
      t.installmentCurrent = enriched.installmentCurrent
      t.installmentTotal   = enriched.installmentTotal
      touched = true
    }
    if (enriched.standingOrder && !t.standingOrder) {
      t.standingOrder = true
      touched = true
    }
    // Only rewrite the vendor on migration when the existing one is still the
    // bare provider name. If the user already typed a custom vendor we leave
    // it alone — they may have set a name we shouldn't override.
    if (enriched.detectedProvider && enriched.vendor !== t.vendor) {
      const cur = String(t.vendor || '').trim().toLowerCase()
      const looksBare = cur === 'bit' || cur === 'paybox' || cur === 'ביט' || cur === 'פייבוקס' || cur === 'פיי בוקס'
      if (looksBare) {
        t.vendor = enriched.vendor
        t.detectedProvider = enriched.detectedProvider
        t.detectedRecipient = enriched.detectedRecipient
        touched = true
      }
    }
    if (t.installmentCurrent && t.installmentTotal && !t.installmentFinalMonth) {
      const em = (typeof getTxEffectiveMonth === 'function') ? getTxEffectiveMonth(t) : ''
      const fm = (typeof computeInstallmentFinalMonth === 'function')
        ? computeInstallmentFinalMonth(em, t.installmentCurrent, t.installmentTotal) : ''
      if (fm) { t.installmentFinalMonth = fm; touched = true }
    }
    if (touched && (!t.notes || t.notes.trim() === '') && typeof buildAutoNotes === 'function') {
      const n = buildAutoNotes(t)
      if (n) t.notes = n
    }
    if (touched) changed++
  }
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_detect_fields_v1', '1')
  if (changed > 0) console.log(`Migration v1: enriched ${changed} transactions with installments / standing-order / bit-paybox detection`)
}

// Backfill the Bit/Paybox recipient note ("נמען: <name>") onto rows that were
// imported before recipient-notes existed. migrateDetectFields_v1 already
// rewrote their vendor to "ביט <name>" but never wrote the note, and a
// re-import would just be flagged as a duplicate — so existing rows would
// otherwise never get the note. rebuildAutoNotes preserves user-written notes
// and is idempotent (the "נמען:" segment is recognised as an auto-note).
function migrateRecipientNotes_v1() {
  if (localStorage.getItem('migration_recipient_notes_v1') === '1') return
  if (typeof enrichDetectedFields !== 'function' || typeof rebuildAutoNotes !== 'function') return
  const txs = getTransactions()
  let changed = 0
  for (const t of txs) {
    const enriched = enrichDetectedFields(t)
    if (!enriched.detectedRecipient) continue
    const newNotes = rebuildAutoNotes(t.notes, {
      installmentCurrent:    t.installmentCurrent,
      installmentTotal:      t.installmentTotal,
      installmentFinalMonth: t.installmentFinalMonth,
      originalDate:          t.originalTransactionDate,
      standingOrder:         t.standingOrder,
      detectedRecipient:     enriched.detectedRecipient,
    })
    if (newNotes !== (t.notes || '')) {
      t.notes = newNotes
      t.detectedProvider  = enriched.detectedProvider
      t.detectedRecipient = enriched.detectedRecipient
      changed++
    }
  }
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_recipient_notes_v1', '1')
  if (changed > 0) console.log(`Migration recipient-notes v1: added recipient note to ${changed} bit/paybox transactions`)
}

// Historical CC bills sometimes printed the installment's ORIGINAL purchase
// date instead of the per-cycle charge date — so installment 7/12 of a Nov
// 2025 purchase ended up stored as date=2025-11-30, chargeDate=2026-06-10,
// which got effectiveMonth right but displayed the wrong date everywhere
// else. This migration walks installment tx whose chargeDate (not date) is
// driving the effective month and remaps date into the bill cycle, while
// preserving the original day-of-month and stashing the historical date in
// notes + originalTransactionDate.
function migrateInstallmentDates_v1() {
  if (localStorage.getItem('migration_installment_dates_v1') === '1') return
  if (typeof remapInstallmentDateToBillCycle !== 'function') return
  if (typeof getTxEffectiveMonth !== 'function') return
  const txs = getTransactions()
  const accs = getAccounts()
  const accById = Object.fromEntries(accs.map(a => [a.id, a]))
  let changed = 0
  for (const t of txs) {
    if (!t.installmentCurrent || !t.installmentTotal) continue
    if (!t.chargeDate) continue
    if (t.originalTransactionDate) continue
    const acc = accById[t.accountId]
    if (!acc || acc.type !== 'credit_card') continue
    // Only act when chargeDate is the thing routing this tx — i.e., the
    // date alone would land it in a different month.
    const dateOnly = getTxEffectiveMonth({ date: t.date, accountId: t.accountId })
    const effective = getTxEffectiveMonth(t)
    if (!dateOnly || !effective || dateOnly === effective) continue
    const billingMonth = effective
    const billingDay = acc.billingDay || 10
    const newDate = remapInstallmentDateToBillCycle(t.date, billingMonth, billingDay)
    if (!newDate || newDate === t.date) continue
    t.originalTransactionDate = t.date
    t.date = newDate
    delete t.chargeDate
    if (typeof buildAutoNotes === 'function') {
      const clause = (() => {
        const m = String(t.originalTransactionDate).match(/^(\d{4})-(\d{2})-(\d{2})$/)
        return m ? `תאריך עסקה מקורי: ${m[3]}/${m[2]}/${m[1]}` : ''
      })()
      if (clause && !(t.notes || '').includes(clause)) {
        t.notes = (t.notes && t.notes.trim()) ? `${t.notes} · ${clause}` : clause
      }
    }
    changed++
  }
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_installment_dates_v1', '1')
  if (changed > 0) console.log(`Migration v1: remapped ${changed} installment txs into their bill cycles`)
}

// Second-pass repair for installment txs after v1.21.43 shipped: the v1
// migration above only remapped txs that had a chargeDate AND whose chargeDate
// drove the effective month different from the date alone. Installments that
// were imported before the inferredChargeDate logic existed still had
// chargeDate=null and date=<original purchase>, so v1 silently skipped them.
// v1 also computed installmentFinalMonth as `effectiveMonth + (total-current)`,
// which was wrong whenever effectiveMonth came from the original purchase date.
//
// v2 rewrites BOTH the per-tx date AND installmentFinalMonth using the
// purchaseDate-driven formula (`first cycle = purchaseMonth + 1`,
// `final = purchaseMonth + total`). Notes are rebuilt segment-by-segment so
// user-added text in notes is preserved.
function migrateInstallmentDates_v2() {
  if (localStorage.getItem('migration_installment_dates_v2') === '1') return
  if (typeof installmentBillCycleMonth !== 'function') return
  if (typeof remapInstallmentDateToBillCycle !== 'function') return
  if (typeof computeInstallmentFinalMonth !== 'function') return
  if (typeof rebuildAutoNotes !== 'function') return
  const txs = getTransactions()
  const accs = getAccounts()
  const accById = Object.fromEntries(accs.map(a => [a.id, a]))
  let changed = 0
  for (const t of txs) {
    if (!t.installmentCurrent || !t.installmentTotal) continue
    const purchaseDate = t.originalTransactionDate || t.date
    if (!purchaseDate) continue
    const cycleMonth = installmentBillCycleMonth(purchaseDate, t.installmentCurrent)
    if (!cycleMonth) continue
    const acc = accById[t.accountId]
    const billingDay = (acc && acc.billingDay) || 10
    const expDate = remapInstallmentDateToBillCycle(purchaseDate, cycleMonth, billingDay)
    const expFinal = computeInstallmentFinalMonth(purchaseDate, t.installmentTotal)
    let touched = false
    if (expFinal && t.installmentFinalMonth !== expFinal) {
      t.installmentFinalMonth = expFinal
      touched = true
    }
    if (expDate && t.date !== expDate) {
      if (!t.originalTransactionDate) t.originalTransactionDate = purchaseDate
      t.date = expDate
      // The new date encodes the right cycle (with billingDay rollover) so
      // a stale chargeDate would only confuse things — drop it.
      delete t.chargeDate
      touched = true
    }
    if (touched) {
      t.notes = rebuildAutoNotes(t.notes, {
        installmentCurrent: t.installmentCurrent,
        installmentTotal: t.installmentTotal,
        installmentFinalMonth: t.installmentFinalMonth,
        originalDate: t.originalTransactionDate,
        standingOrder: t.standingOrder,
      })
      changed++
    }
  }
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_installment_dates_v2', '1')
  if (changed > 0) console.log(`Migration v2: recomputed ${changed} installment txs (date + finalMonth + notes)`)
}

// Recompute installmentFinalMonth for existing rows using the charge-month
// formula (chargeMonth(current) + (total-current)) instead of the older
// purchaseMonth+total approach. The two agree when the "first installment =
// purchase month + 1" convention holds, but the charge-based one is correct
// even when the issuer charges the first installment in the purchase month, and
// it doesn't depend on a reconstructed purchase date. Notes are rebuilt so the
// "חודש חיוב אחרון" segment reflects the corrected month; user text is kept.
function migrateInstallmentFinalMonth_v3() {
  if (localStorage.getItem('migration_installment_final_month_v3') === '1') return
  if (typeof getTxEffectiveMonth !== 'function') return
  if (typeof installmentFinalMonthFromCharge !== 'function') return
  if (typeof rebuildAutoNotes !== 'function') return
  const txs = getTransactions()
  let changed = 0
  for (const t of txs) {
    if (!t.installmentCurrent || !t.installmentTotal) continue
    const chargeMonth = getTxEffectiveMonth(t)
    const expFinal = installmentFinalMonthFromCharge(chargeMonth, t.installmentCurrent, t.installmentTotal)
    if (!expFinal || expFinal === t.installmentFinalMonth) continue
    t.installmentFinalMonth = expFinal
    t.notes = rebuildAutoNotes(t.notes, {
      installmentCurrent: t.installmentCurrent,
      installmentTotal: t.installmentTotal,
      installmentFinalMonth: t.installmentFinalMonth,
      originalDate: t.originalTransactionDate,
      standingOrder: t.standingOrder,
      detectedRecipient: t.detectedRecipient,
    })
    changed++
  }
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_installment_final_month_v3', '1')
  if (changed > 0) console.log(`Migration v3: recomputed installmentFinalMonth (charge-based) for ${changed} txs`)
}

// One-shot migration: the v1.21 release moved the recurring narrowing config
// off its own localStorage key (finRecurringGroupCriteria, briefly used in
// 1.21.0) and into the existing vendor-alias schema, so the criteria editor
// in the recurring drill and the alias card in settings now share storage.
// This converts any criteria the user managed to set during 1.21.0 into a
// matching alias (creating one if needed), then drops the old key.
function migrateRecurringCriteriaToAliases_v1() {
  if (localStorage.getItem('migration_recurring_criteria_to_aliases_v1') === '1') return
  const old = DB.getObj('finRecurringGroupCriteria', {})
  const keys = Object.keys(old || {})
  if (keys.length === 0) {
    localStorage.setItem('migration_recurring_criteria_to_aliases_v1', '1')
    return
  }
  let migrated = 0
  for (const vendorKey of keys) {
    const c = old[vendorKey] || {}
    const txs = getTransactions().filter(t => {
      const k = (typeof _txVendorKey === 'function')
        ? _txVendorKey(t)
        : (typeof _normalizeVendor === 'function' ? _normalizeVendor(t.vendor, t.amount) : '')
      return k === vendorKey
    })
    const counts = new Map()
    let label = vendorKey
    for (const t of txs) {
      const raw = String(t.vendor || '').trim().toLowerCase()
      if (raw) counts.set(raw, (counts.get(raw) || 0) + 1)
      const resolved = (typeof resolveVendor === 'function')
        ? resolveVendor(t.vendor, t.amount)
        : t.vendor
      if (resolved) label = resolved
    }
    const seedPattern = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || vendorKey
    const existing = (typeof findAliasForDrillKey === 'function')
      ? findAliasForDrillKey(vendorKey)
      : null
    if (existing) {
      updateVendorAlias(existing.id, existing.patterns, existing.displayName,
        c.amountMin, c.amountMax, null, null)
    } else {
      addVendorAlias([seedPattern], label, c.amountMin, c.amountMax, null, null)
    }
    migrated++
  }
  localStorage.removeItem('finRecurringGroupCriteria')
  localStorage.setItem('migration_recurring_criteria_to_aliases_v1', '1')
  if (migrated > 0) console.log(`Migration v1: moved ${migrated} recurring criteria into aliases`)
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  initDefaultData()
  migrateCreditCardTransfers()
  migrateTransferLinking_v2()
  migrateRevertAutoCc_v1()
  migrateRelinkAutoTransfers_v3()
  migrateOrphanedTransfers_v4()
  migrateRecurringCriteriaToAliases_v1()
  migrateDetectFields_v1()
  if (typeof migrateRecipientNotes_v1 === 'function') migrateRecipientNotes_v1()
  migrateInstallmentDates_v1()
  migrateInstallmentDates_v2()
  if (typeof migrateInstallmentFinalMonth_v3 === 'function') migrateInstallmentFinalMonth_v3()
  migrateBudgetType_v1()
  migrateBudgetMonthly_v2()
  if (typeof migrateExcludeFromUnforeseen_v1 === 'function') migrateExcludeFromUnforeseen_v1()
  if (typeof migrateManualGroupVendorKeys_v1 === 'function') migrateManualGroupVendorKeys_v1()
  if (typeof migrateCategoryIconsToSvg_v1 === 'function') migrateCategoryIconsToSvg_v1()
  window.addEventListener('hashchange', _onHashChange)
  const _initialScreen = location.hash.slice(1)
  navigate(SCREENS.includes(_initialScreen) ? _initialScreen : 'dashboard', true)

  const dz = document.getElementById('dropZone')
  if (dz) {
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over') })
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'))
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag-over')
      const f = e.dataTransfer.files[0]
      if (f) { document.getElementById('fileInput').files = e.dataTransfer.files; handleFileSelect({ files: [f] }) }
    })
  }
})
