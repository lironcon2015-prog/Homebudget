// ===== AUTO-CATEGORIZE =====
// Deterministic propagation of categories: learns vendor→category rules from
// already-categorized transactions, applies to uncategorized ones.

const AUTOCAT_CONFIDENCE_THRESHOLD = 0.8  // ≥80% of sightings agree → apply

function normalizeVendorForAutocat(v) {
  return (v || '')
    .toLowerCase()
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function _buildVendorCategoryRules(txs) {
  const rules = {}
  for (const t of txs) {
    if (!t.categoryId || !t.vendor) continue
    if (t.oneOff) continue  // one-off manual categorizations don't teach the vendor→category map
    const k = normalizeVendorForAutocat(t.vendor)
    if (!k) continue
    if (!rules[k]) rules[k] = {}
    rules[k][t.categoryId] = (rules[k][t.categoryId] || 0) + 1
  }
  return rules
}

// Returns { autoApplied:[{txId,catId,vendor}], ambiguous:[{vendor,key,txIds,candidates}] }
function computeAutoCategorizePlan() {
  const all = getTransactions()
  const rules = _buildVendorCategoryRules(all)

  const autoApplied = []
  const ambiguous = {}

  for (const t of all) {
    if (t.categoryId || !t.vendor) continue
    // Skip transfers/refunds that are non-counted — they usually don't need categories
    if (t.type === 'transfer') continue
    const k = normalizeVendorForAutocat(t.vendor)
    if (!k || !rules[k]) continue
    const entries = Object.entries(rules[k]).sort((a, b) => b[1] - a[1])
    const total = entries.reduce((s, e) => s + e[1], 0)
    const [topCat, topCount] = entries[0]
    if (entries.length === 1 || topCount / total >= AUTOCAT_CONFIDENCE_THRESHOLD) {
      autoApplied.push({ txId: t.id, catId: topCat, vendor: t.vendor })
    } else {
      if (!ambiguous[k]) ambiguous[k] = { vendor: t.vendor, key: k, txIds: [], candidates: entries }
      ambiguous[k].txIds.push(t.id)
    }
  }
  return { autoApplied, ambiguous: Object.values(ambiguous) }
}

// Auto-categorization NEVER overwrites an existing categoryId. The plan is
// already built from uncategorized rows only, but we re-check here so any
// future caller of these helpers is bound by the same contract.
function applyAutoCategorizeConfident(plan) {
  if (plan.autoApplied.length === 0) return 0
  const map = new Map(plan.autoApplied.map(a => [a.txId, a.catId]))
  const txs = getTransactions()
  let n = 0
  txs.forEach(t => {
    if (!map.has(t.id)) return
    if (t.categoryId) return
    t.categoryId = map.get(t.id)
    t.categorySource = 'autocat'
    n++
  })
  DB.set('finTransactions', txs)
  return n
}

function applyCategoryToTxIds(txIds, catId) {
  if (!catId) return 0
  const set = new Set(txIds)
  const txs = getTransactions()
  let n = 0
  txs.forEach(t => {
    if (!set.has(t.id)) return
    if (t.categoryId) return
    t.categoryId = catId
    t.categorySource = 'autocat'
    n++
  })
  DB.set('finTransactions', txs)
  return n
}

// ===== UI =====
let _autocatPlan = null

function runAutoCategorize() {
  _autocatPlan = computeAutoCategorizePlan()
  const { autoApplied, ambiguous } = _autocatPlan
  const applied = applyAutoCategorizeConfident(_autocatPlan)

  if (autoApplied.length === 0 && ambiguous.length === 0) {
    toast('אין עסקאות חדשות לסיווג אוטומטי. ודא שיש עסקאות ללא קטגוריה עם ספק שכבר סווג בעבר.', { type: 'info', duration: 5000 })
    if (typeof renderTransactions === 'function') renderTransactions()
    return
  }

  if (ambiguous.length === 0) {
    toast(`סווגו אוטומטית ${applied} עסקאות`, { type: 'success' })
    if (typeof renderTransactions === 'function') renderTransactions()
    return
  }

  _showAutocatAmbiguousModal(applied, ambiguous)
}

function _showAutocatAmbiguousModal(appliedCount, ambiguous) {
  const cats = getCategories()
  const catOpts = ['expense', 'income'].map(type => {
    const list = cats.filter(c => c.type === type)
    if (!list.length) return ''
    const label = type === 'expense' ? 'הוצאה' : 'הכנסה'
    return `<optgroup label="${label}">${list.map(c => `<option value="${c.id}">${catIconText(c)} ${c.name}</option>`).join('')}</optgroup>`
  }).join('')

  const summary = appliedCount > 0
    ? `סווגו אוטומטית ${appliedCount} עסקאות. דרושה החלטה ב-${ambiguous.length} ספקים:`
    : `דרושה החלטה ב-${ambiguous.length} ספקים:`

  const rows = ambiguous.map((a, i) => {
    const candLabel = a.candidates.map(([cid, cnt]) => {
      const c = cats.find(x => x.id === cid)
      return `${catIconHTML(c)} ${c?.name || 'לא ידוע'} (${cnt})`
    }).join(' · ')
    return `
      <div class="autocat-row" data-idx="${i}">
        <div class="autocat-row-head">
          <span class="autocat-vendor">${a.vendor}</span>
          <span class="autocat-count">${a.txIds.length} עסקאות</span>
        </div>
        <div class="autocat-candidates">סיווגים קיימים: ${candLabel}</div>
        <select class="autocat-select" data-key="${a.key}">
          <option value="">— דלג —</option>
          ${catOpts}
        </select>
      </div>`
  }).join('')

  document.getElementById('autocatModalBody').innerHTML = `
    <div class="autocat-summary">${summary}</div>
    <div class="autocat-list">${rows}</div>`
  document.getElementById('autocatModal').classList.add('open')
}

function applyAutocatChoices() {
  if (!_autocatPlan) return
  const selects = document.querySelectorAll('#autocatModalBody .autocat-select')
  let applied = 0
  selects.forEach(sel => {
    const catId = sel.value
    if (!catId) return
    const key = sel.dataset.key
    const entry = _autocatPlan.ambiguous.find(a => a.key === key)
    if (!entry) return
    applied += applyCategoryToTxIds(entry.txIds, catId)
  })
  closeAutocatModal()
  toast(applied === 0 ? 'לא בוצעו סיווגים נוספים' : `סווגו ${applied} עסקאות נוספות`, { type: applied === 0 ? 'info' : 'success' })
  if (typeof renderTransactions === 'function') renderTransactions()
}

function closeAutocatModal() {
  document.getElementById('autocatModal').classList.remove('open')
  _autocatPlan = null
}

// ===== GEMINI VENDOR CATEGORIZATION =====
// Opt-in fallback: collect unique vendors of uncategorized non-transfer
// transactions, send them to Gemini as a batch, receive {vendor → categoryId}
// mapping, apply. Users who prefer fully-local processing can skip this and
// rely on deterministic rules + manual tagging.
async function runGeminiCategorize() {
  const apiKey = getApiKey()
  if (!apiKey) { toast('חסר מפתח Gemini בהגדרות', { type: 'error' }); return }

  const txs = getTransactions()
  const targets = txs.filter(t => !t.categoryId && t.vendor && t.type !== 'transfer')
  if (targets.length === 0) { toast('אין עסקאות לא־מסווגות', { type: 'info' }); return }

  // Unique vendors (normalized dedupe, but send original form to Gemini)
  const seen = new Set()
  const uniqueVendors = []
  for (const t of targets) {
    const k = normalizeVendorForAutocat(t.vendor)
    if (!k || seen.has(k)) continue
    seen.add(k)
    uniqueVendors.push(t.vendor)
  }

  if (uniqueVendors.length > 200) {
    if (!(await confirmDialog(`${uniqueVendors.length} ספקים שונים. ההרצה עלולה לארוך. להמשיך?`, { confirmText: 'המשך' }))) return
  }

  const cats = getCategories()
  const catList = cats
    .filter(c => c.type === 'expense' || c.type === 'income')
    .map(c => `- ${c.name} (id=${c.id}, ${c.type === 'expense' ? 'הוצאה' : 'הכנסה'})`)
    .join('\n')

  const prompt = `סווג כל שם ספק לאחת מהקטגוריות הבאות.
החזר JSON בלבד בפורמט {"vendor_name":"category_id"} — ללא טקסט נוסף, ללא backticks.
אם אין התאמה ברורה, השמט את הספק. השתמש ב-id המדויק מהרשימה (cat_...).

קטגוריות זמינות:
${catList}

ספקים לסיווג:
${uniqueVendors.map(v => `- ${v}`).join('\n')}`

  const btns = document.querySelectorAll('button[onclick="runGeminiCategorize()"]')
  btns.forEach(b => { b.disabled = true; b.textContent = '🤖 מסווג עם AI...' })

  try {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 32768 }
    }
    const data = await callGemini(apiKey, body)
    const parts = data.candidates?.[0]?.content?.parts || []
    let text = ''
    for (const p of parts) { if (!p.thought && p.text) { text = p.text; break } }
    if (!text) text = parts.filter(p => !p.thought).map(p => p.text || '').join('')
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

    let mapping = {}
    try { mapping = JSON.parse(text) } catch {
      // Try to extract {...} substring
      const i = text.indexOf('{'), j = text.lastIndexOf('}')
      if (i >= 0 && j > i) mapping = JSON.parse(text.slice(i, j + 1))
    }

    // Normalize mapping keys for matching
    const catIds = new Set(cats.map(c => c.id))
    const lookup = {}
    for (const [vendor, catId] of Object.entries(mapping)) {
      if (!catIds.has(catId)) continue
      lookup[normalizeVendorForAutocat(vendor)] = catId
    }

    // Apply
    const all = getTransactions()
    let applied = 0
    all.forEach(t => {
      if (t.categoryId || !t.vendor || t.type === 'transfer') return
      const k = normalizeVendorForAutocat(t.vendor)
      if (k && lookup[k]) { t.categoryId = lookup[k]; t.categorySource = 'ai'; applied++ }
    })
    DB.set('finTransactions', all)
    toast(applied === 0
      ? 'ה-AI לא הצליח לסווג אף ספק. נסה להוסיף כללים ידניים.'
      : `ה-AI סיווג ${applied} עסקאות (${Object.keys(lookup).length} ספקים)`,
      { type: applied === 0 ? 'info' : 'success', duration: 5000 })
    if (typeof renderTransactions === 'function') renderTransactions()
  } catch (err) {
    console.error('Gemini categorize error:', err)
    toast('שגיאה בסיווג עם AI: ' + err.message, { type: 'error', duration: 6000 })
  } finally {
    btns.forEach(b => { b.disabled = false; b.textContent = '🤖 סווג לא־מסווגים עם AI' })
  }
}
