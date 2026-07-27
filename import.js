// ===== IMPORT =====
// An import is a RECONCILIATION, not an append. A statement is an authoritative
// claim about the contents of one billing cycle, so the question this screen
// answers is "how does this file differ from what I already have?" — with an
// account of every row on both sides, including the rows the file omits. That
// last bucket is the safety net: when matching fails, the row that should have
// matched appears there instead of vanishing, so a miss is visible.
//
// Deliberately NOT done here any more:
//   * guessing one billing cycle for the whole file from its latest date
//   * overwriting `date` so installments sort into that guessed cycle
// Both made the same source row parse to different values depending on what
// else happened to be in the file, which is what broke duplicate detection.
// The cycle now comes from the statement itself and lives in `billingMonth`.

let _parsedTx = []
let _importFileName = ''
let _importAccountId = ''
let _importDoc = null          // { contentHash, filename, scope, identifier }
let _importScopeMonths = []
let _importOrphans = []
let _importPendingFile = null  // parked while the user picks an account
let _lastParseStats = null
let _lastTemplateName = ''

function initImport() {
  resetImport()
  _renderImportAccountPicker()
}

function _renderImportAccountPicker(selectedId) {
  const accounts = getAccounts()
  const sel = document.getElementById('importAccount')
  if (!sel) return
  sel.innerHTML = accounts.length === 0
    ? '<option value="">אין חשבונות – צור חשבון בהגדרות</option>'
    : ['<option value="">— זיהוי אוטומטי מהקובץ —</option>',
       ...accounts.map(a => `<option value="${a.id}"${a.id === selectedId ? ' selected' : ''}>${escHtml(a.name)}${a.institution ? ' – ' + escHtml(a.institution) : ''}</option>`)].join('')
}

function resetImport() {
  _parsedTx = []
  _importAccountId = ''
  _importDoc = null
  _importScopeMonths = []
  _importOrphans = []
  _importPendingFile = null
  ;['importStep2','importStep3','importStep4','importStepError','importStepKnown','importStepAccount'].forEach(id => {
    const el = document.getElementById(id)
    if (el) el.style.display = 'none'
  })
  const s1 = document.getElementById('importStep1')
  if (s1) s1.style.display = 'block'
  const err = document.getElementById('importError')
  if (err) err.textContent = ''
  const fi = document.getElementById('fileInput')
  if (fi) fi.value = ''
}

function _importShowStep(id) {
  ;['importStep1','importStep2','importStep3','importStep4','importStepError','importStepKnown','importStepAccount']
    .forEach(s => { const el = document.getElementById(s); if (el) el.style.display = s === id ? 'block' : 'none' })
}

function _importFail(msg) {
  _importShowStep('importStepError')
  const el = document.getElementById('importErrMsg')
  if (el) el.textContent = msg
}

// ---------- entry point ----------
// The account is no longer required up front. The file is parsed first and the
// account is resolved from the file itself; if that fails the rows are still
// shown and the account is picked there.

async function handleFileSelect(input) {
  const file = input.files?.[0]
  if (!file) return
  _importFileName = file.name
  const chosen = document.getElementById('importAccount')?.value || ''

  _importShowStep('importStep2')
  const nameEl = document.getElementById('importFilename')
  if (nameEl) nameEl.textContent = file.name
  const msgEl = document.getElementById('importLoadingMsg')
  if (msgEl) msgEl.textContent = 'בודק את הקובץ...'

  try {
    // Has this exact file been imported before? Answered from the document log
    // before a single row is interpreted.
    const contentHash = (typeof fileContentHash === 'function') ? await fileContentHash(file) : ''
    const known = (typeof findSourceDocByHash === 'function') ? findSourceDocByHash(contentHash) : null
    _importDoc = { contentHash, filename: file.name }
    if (known) { _importPendingFile = { file, chosen }; _showKnownDocument(known); return }
    await _routeFile(file, chosen)
  } catch (err) {
    console.error('Import error:', err)
    _importFail(err.message)
  }
}

function _showKnownDocument(doc) {
  const acc = getAccounts().find(a => a.id === doc.accountId)
  const when = doc.importedAt ? formatDate(new Date(doc.importedAt).toISOString().slice(0, 10)) : ''
  const el = document.getElementById('importKnownMsg')
  if (el) {
    el.innerHTML = `הקובץ <b>${escHtml(doc.filename || '')}</b> כבר יובא${when ? ' ב-' + when : ''}` +
      `${acc ? ' לחשבון <b>' + escHtml(acc.name) + '</b>' : ''}` +
      `${doc.txCount ? ` (${doc.txCount} עסקאות)` : ''}.`
  }
  _importShowStep('importStepKnown')
}

// "Compare anyway" — re-runs the reconciliation. Safe by construction: matched
// rows are not re-imported, so the worst case is confirming there is nothing new.
async function reimportKnownDocument() {
  const parked = _importPendingFile
  if (!parked) { resetImport(); return }
  _importPendingFile = null
  _importShowStep('importStep2')
  try { await _routeFile(parked.file, parked.chosen) }
  catch (err) { console.error('Import error:', err); _importFail(err.message) }
}

async function _routeFile(file, chosenAccountId) {
  const isStructured = /\.(xlsx?|csv|txt)$/i.test(file.name)
  if (isStructured) return handleStructuredFile(file, chosenAccountId)
  const apiKey = getApiKey()
  if (!apiKey) { _importFail('חסר מפתח Gemini API – הזן בהגדרות'); return }
  return parseWithGemini(file, chosenAccountId, apiKey)
}

// ---------- structured files ----------

async function handleStructuredFile(file, chosenAccountId) {
  _importShowStep('importStep2')
  const msgEl = document.getElementById('importLoadingMsg')
  if (msgEl) msgEl.textContent = 'קורא את הקובץ...'
  try {
    const rows = await extractRowsFromFile(file)
    const maxTry = Math.min(rows.length, 15)
    let matched = null
    for (let i = 0; i < maxTry; i++) {
      const tpl = findTemplateForHeaderRow(rows[i] || [])
      if (tpl) { matched = { ...tpl, headerRowIndex: tpl.headerRowIndex ?? i }; break }
    }
    if (matched) {
      continueImportWithTemplate(file, chosenAccountId, rows, matched)
    } else {
      _importShowStep('importStep1')
      openTplWizard(file, chosenAccountId, rows)
    }
  } catch (err) {
    console.error('Structured import error:', err)
    _importFail(err.message)
  }
}

function continueImportWithTemplate(file, chosenAccountId, rows, template) {
  try {
    _importShowStep('importStep2')
    const msgEl = document.getElementById('importLoadingMsg')
    if (msgEl) msgEl.textContent = `פרסור דטרמיניסטי לפי תבנית "${template.name}"...`
    const { transactions, stats } = parseWithTemplate(rows, template)
    _lastParseStats = stats
    _lastTemplateName = template.name

    // Everything the statement says about itself lives above the table.
    const headerRowIndex = template.headerRowIndex ?? 0
    const preamble = (typeof statementPreamble === 'function') ? statementPreamble(rows, headerRowIndex) : ''
    const scope = (typeof detectStatementScope === 'function')
      ? (detectStatementScope(preamble) || detectStatementScope(file.name)) : null

    const ident = (typeof identifyAccountForFile === 'function')
      ? identifyAccountForFile({ preamble, filename: file.name, template, accounts: getAccounts() })
      : null

    bumpTemplateUsage(template.id, transactions.length)
    _importDoc = { ..._importDoc, scope, preamble, template: template.id, rows }
    _resolveAccountThenReconcile(transactions, chosenAccountId, ident, scope)
      .catch(err => { console.error('Import error:', err); _importFail(err.message) })
  } catch (err) {
    console.error('Template parse error:', err)
    _importFail(err.message)
  }
}

// ---------- AI parsing ----------

async function parseWithGemini(file, chosenAccountId, apiKey) {
  _importShowStep('importStep2')
  const nameEl = document.getElementById('importFilename')
  if (nameEl) nameEl.textContent = file.name
  const msgEl = document.getElementById('importLoadingMsg')
  if (msgEl) msgEl.textContent = 'מנתח עם Gemini AI...'

  try {
    const isExcel = /\.xlsx?$/i.test(file.name)
    const isText = /\.(csv|txt)$/i.test(file.name)
    let parts
    const prompt = getPrompt()

    if (isExcel) {
      parts = [{ text: prompt + '\n\nנתוני הקובץ:\n' + await excelToCSV(file) }]
    } else if (isText) {
      parts = [{ text: prompt + '\n\nנתוני הקובץ:\n' + await readTextFile(file) }]
    } else {
      const base64 = await fileToBase64(file)
      parts = [{ text: prompt }, { inline_data: { mime_type: getMimeType(file.name), data: base64 } }]
    }

    const data = await callGemini(apiKey, { contents: [{ parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 65536 } })
    const candidate = data.candidates?.[0]
    const allParts = candidate?.content?.parts || []
    let text = ''
    for (const p of allParts) { if (!p.thought && p.text) { text = p.text; break } }
    if (!text) text = allParts.filter(p => !p.thought).map(p => p.text || '').join('')
    if (!text) text = allParts.map(p => p.text || '').join('')
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    if (!text) throw new Error(`תשובה ריקה מ-AI (סיבה: ${candidate?.finishReason || 'unknown'}) – נסה שוב`)

    const parsed = tryParseJSON(text)
    // The model may return a leading metadata object describing the statement.
    let scope = null, aiIdentifiers = []
    let rowsOut = parsed
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
      rowsOut = parsed.transactions || parsed.rows || []
      if (parsed.billingMonth && /^\d{4}-\d{2}$/.test(parsed.billingMonth)) scope = { month: parsed.billingMonth, source: 'ai' }
      if (parsed.cardLast4)     aiIdentifiers.push(String(parsed.cardLast4))
      if (parsed.accountNumber) aiIdentifiers.push(String(parsed.accountNumber))
    }
    if (!Array.isArray(rowsOut)) rowsOut = []

    _lastParseStats = null
    _lastTemplateName = ''

    let ident = (typeof matchAccountByIdentifiers === 'function' && aiIdentifiers.length)
      ? matchAccountByIdentifiers(aiIdentifiers.map(v => ({ value: (typeof normalizeAccountIdentifier === 'function' ? normalizeAccountIdentifier(v) : v), confidence: 'high' })), getAccounts())
      : null
    if (ident) ident = { ...ident, via: 'ai' }

    _importDoc = { ..._importDoc, scope, parser: 'ai' }
    await _resolveAccountThenReconcile(rowsOut, chosenAccountId, ident, scope)
  } catch (err) {
    console.error('Import error:', err)
    _importFail(err.message)
  }
}

// ---------- account resolution ----------
// The ladder, in order:
//   1. an explicit choice by the user
//   2. deterministic identification from the file (identifiers, filename, template)
//   3. Gemini reads the statement header once — and whatever it finds is LEARNED
//      onto the account, so this rung is never reached again for that card
//   4. the rows are shown anyway and the account is picked there
// An unidentified account never blocks the parse.

// Rung 3. Reads only the statement header, never the transaction rows, so the
// call stays small and carries no spending detail. Returns identifier strings.
async function _aiIdentifyAccount(preamble, filename) {
  const apiKey = (typeof getApiKey === 'function') ? getApiKey() : ''
  const text = `${preamble || ''}\n${filename || ''}`.trim()
  if (!apiKey || !text) return []
  const prompt =
    'להלן טקסט הכותרת של דוח בנק או כרטיס אשראי ישראלי. ' +
    'החזר JSON בלבד, ללא backticks, בפורמט {"cardLast4":"1234","accountNumber":"123456"}. ' +
    'כלול רק שדות שמופיעים במפורש בטקסט. אם אין אף אחד מהם – החזר {}.\n\n' + text
  try {
    const data = await callGemini(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    })
    const parts = data.candidates?.[0]?.content?.parts || []
    const raw = parts.filter(p => !p.thought).map(p => p.text || '').join('')
      .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
    return [obj.cardLast4, obj.accountNumber].filter(Boolean).map(String)
  } catch (err) {
    console.warn('AI account identification failed:', err?.message)
    return []
  }
}

async function _resolveAccountThenReconcile(parsed, chosenAccountId, ident, scope) {
  const accounts = getAccounts()
  if (!accounts.length) { _importFail('אין חשבונות – צור חשבון בהגדרות'); return }

  let resolved = ident
  if (!chosenAccountId && !resolved?.accountId && typeof _aiIdentifyAccount === 'function') {
    const msgEl = document.getElementById('importLoadingMsg')
    if (msgEl) msgEl.textContent = 'מזהה את החשבון...'
    const aiIds = await _aiIdentifyAccount(_importDoc?.preamble, _importFileName)
    if (aiIds.length && typeof matchAccountByIdentifiers === 'function') {
      const hit = matchAccountByIdentifiers(
        aiIds.map(v => ({ value: normalizeAccountIdentifier(v), confidence: 'high' })), accounts)
      if (hit) resolved = { ...hit, via: 'ai' }
    }
    // Even without a match, remember what the AI saw — the manual prompt turns
    // it into a rule the moment the user names the account.
    if (!resolved?.accountId && aiIds.length) _importAiIdentifiers = aiIds
  }

  const accountId = chosenAccountId || resolved?.accountId || ''
  if (!accountId) {
    _importPendingParsed = { parsed, scope, ident: resolved }
    _showAccountPrompt(parsed, scope)
    return
  }
  ident = resolved
  if (ident?.identifier && !chosenAccountId && typeof learnAccountIdentifier === 'function') {
    learnAccountIdentifier(accountId, ident.identifier)
  }
  _importDoc = { ..._importDoc, detectedVia: ident?.via || (chosenAccountId ? 'user' : ''), identifier: ident?.identifier || null }
  _reconcileParsed(parsed, accountId, scope)
}

let _importPendingParsed = null
let _importAiIdentifiers = []

function _showAccountPrompt(parsed, scope) {
  const accounts = getAccounts()
  const el = document.getElementById('importAccountPromptBody')
  if (el) {
    const dates = parsed.map(t => t.date).filter(Boolean).sort()
    el.innerHTML = `
      <div style="color:var(--text-muted);font-size:.9rem;margin-bottom:.75rem">
        ${parsed.length} עסקאות נקראו מהקובץ${dates.length ? ` (${dates[0]} → ${dates[dates.length - 1]})` : ''}.
        ${scope?.month ? `חודש חיוב שזוהה: <b>${scope.month}</b>. ` : ''}
        לא הצלחתי לזהות את החשבון — בחר אותו, והמערכת תזכור לפעם הבאה.
      </div>
      <select id="importAccountPromptSel">
        ${accounts.map(a => `<option value="${a.id}">${escHtml(a.name)}${a.institution ? ' – ' + escHtml(a.institution) : ''}</option>`).join('')}
      </select>`
  }
  _importShowStep('importStepAccount')
}

function confirmImportAccount() {
  const accountId = document.getElementById('importAccountPromptSel')?.value
  if (!accountId || !_importPendingParsed) return
  const { parsed, scope } = _importPendingParsed
  _importPendingParsed = null
  // Turn this one manual answer into a rule: whatever identifier the file
  // carried is attached to the account, so the question is asked once per card
  // rather than once per file. The AI's reading is used when the deterministic
  // scan found nothing — that is the whole point of rung 3.
  const scanned = (typeof extractAccountIdentifiers === 'function')
    ? extractAccountIdentifiers(`${_importDoc?.preamble || ''} ${_importFileName}`).map(f => f.value) : []
  const candidates = scanned.length ? scanned
    : (typeof normalizeAccountIdentifier === 'function'
        ? _importAiIdentifiers.map(normalizeAccountIdentifier).filter(Boolean) : [])
  // Only an unambiguous single reading becomes a rule — two candidates would
  // teach the account something that may belong to a different card.
  const learned = candidates.length === 1 ? candidates[0] : null
  if (learned && typeof learnAccountIdentifier === 'function') learnAccountIdentifier(accountId, learned)
  _importAiIdentifiers = []
  _importDoc = { ..._importDoc, detectedVia: 'user', identifier: learned }
  _reconcileParsed(parsed, accountId, scope)
}

// ---------- billing cycle ----------
// Per row, from strongest evidence to weakest. `date` is never touched.

// Some export formats put the CHARGE date in the date column rather than the
// purchase date — the bank's rendering of a card bill typically does, while the
// issuer's own export gives the real purchase date. Comparing one against the
// other as if both were purchase dates makes them look like different charges.
//
// When the statement states its charge date and a row's date is exactly that
// date, the row is telling us the cycle, not when the purchase happened. We
// keep `date` as the file gave it — that is what the source says — but report
// the purchase date as UNKNOWN, so matching scores it as a missing signal
// instead of a conflicting one.
function _purchaseDateForRow(t, account, scope) {
  const date = t.originalTransactionDate || t.date || null
  if (!date || !account || account.type !== 'credit_card') return date
  if (!scope?.month || !scope?.chargeDay) return date
  const stated = `${scope.month}-${String(scope.chargeDay).padStart(2, '0')}`
  return date === stated ? null : date
}

function _billingMonthForRow(t, account, scope) {
  if (!account || account.type !== 'credit_card') return (t.date || '').slice(0, 7)
  // 1. the issuer's own charge-date column
  if (t.chargeDate && /^\d{4}-\d{2}/.test(t.chargeDate)) {
    return { month: t.chargeDate.slice(0, 7), provenance: 'explicit' }
  }
  // 2. the period the statement states for itself
  if (scope?.month) return { month: scope.month, provenance: 'explicit' }
  // 3. billing-day rollover on the purchase date
  const m = (typeof getTxEffectiveMonth === 'function')
    ? getTxEffectiveMonth({ date: t.date, accountId: account.id }) : (t.date || '').slice(0, 7)
  return { month: m, provenance: 'derived' }
}

// ---------- reconciliation ----------

function _reconcileParsed(parsed, accountId, scope) {
  _importAccountId = accountId
  const account = getAccounts().find(a => a.id === accountId)
  const cats = getCategories()
  const existingAll = getTransactions()

  const matchCategory = (t) => {
    const catName = (t.category || '').trim()
    if (!catName) return ''
    const match = cats.find(c => c.name === catName || catName.includes(c.name) || c.name.includes(catName))
    return match?.id || ''
  }
  const autocatRules = (typeof _buildVendorCategoryRules === 'function') ? _buildVendorCategoryRules(existingAll) : {}
  const suggestFromAutocat = (vendor) => {
    if (!vendor) return ''
    const k = (typeof normalizeVendorForAutocat === 'function') ? normalizeVendorForAutocat(vendor) : ''
    if (!k || !autocatRules[k]) return ''
    const entries = Object.entries(autocatRules[k])
    const total = entries.reduce((s, [, n]) => s + n, 0)
    entries.sort((a, b) => b[1] - a[1])
    const [topCat, topN] = entries[0]
    return (topN / total) >= AUTOCAT_CONFIDENCE_THRESHOLD ? topCat : ''
  }

  // Enrich, categorise and resolve the cycle — without mutating any date.
  const rows = (Array.isArray(parsed) ? parsed : []).map(raw => {
    const t = (typeof enrichDetectedFields === 'function') ? enrichDetectedFields(raw) : { ...raw }
    const bm = _billingMonthForRow(t, account, scope)
    const catFromName    = matchCategory(t)
    const catFromRules   = catFromName ? '' : matchVendorToCategory(t.vendor, t.description)
    const catFromAutocat = (catFromName || catFromRules) ? '' : suggestFromAutocat(t.vendor)
    const catSource = catFromName ? (_lastTemplateName ? 'import' : 'ai')
                    : catFromRules ? 'rule' : catFromAutocat ? 'autocat' : ''
    const billingMonth = typeof bm === 'string' ? bm : bm.month
    // Last charge of an installment plan, counted forward from THIS
    // installment's own cycle: cycle + (total - current). Never reconstructs a
    // purchase date, so it holds whatever convention the issuer uses.
    let installmentFinalMonth = ''
    if (t.installmentCurrent && t.installmentTotal && billingMonth
        && typeof installmentFinalMonthFromCharge === 'function') {
      installmentFinalMonth = installmentFinalMonthFromCharge(billingMonth, t.installmentCurrent, t.installmentTotal)
    }
    return {
      ...t,
      _purchaseDate: _purchaseDateForRow(t, account, scope),
      _installmentFinalMonth: installmentFinalMonth,
      _billingMonth: billingMonth,
      _billingProvenance: typeof bm === 'string' ? 'derived' : bm.provenance,
      _categoryId: catFromName || catFromRules || catFromAutocat,
      _categorySource: catSource,
      _accountId: accountId,
    }
  })

  // The cycles this file claims to cover — the window orphans are drawn from.
  _importScopeMonths = [...new Set(rows.map(r => r._billingMonth).filter(Boolean))]

  const toRecord = (t, ref) => txmRecord(
    { ...t, accountId, srcRowHash: t._rowSig || t.srcRowHash || null },
    { purchaseDate: t._purchaseDate !== undefined ? t._purchaseDate : (t.originalTransactionDate || t.date || null),
      billingMonth: t._billingMonth || t.billingMonth || null, ref }
  )
  const incoming = rows.map(r => toRecord(r, r))
  const existing = existingAll
    .filter(t => t.accountId === accountId)
    .map(t => txmRecord(t, {
      billingMonth: t.billingMonth || ((typeof getTxEffectiveMonth === 'function') ? getTxEffectiveMonth(t) : null),
      ref: t,
    }))

  const rec = reconcileTransactions(incoming, existing, { scopeMonths: _importScopeMonths })

  // Project the outcome back onto the display rows.
  const state = new Map()
  rec.matched.forEach(m => state.set(m.row.ref, { kind: 'matched', against: m.existing.ref, reasons: m.reasons }))
  rec.review.forEach(v => state.set(v.row.ref, { kind: 'review', candidates: v.candidates }))
  rec.fresh.forEach(f => state.set(f.ref, { kind: 'fresh' }))
  _importOrphans = rec.orphans.map(o => o.ref)

  _parsedTx = rows.map(r => {
    const s = state.get(r) || { kind: 'fresh' }
    return {
      ...r,
      _state: s.kind,
      _matchAgainst: s.against || null,
      _candidates: s.candidates || null,
      // Matched rows are off by default; ambiguous ones too — the user opts in
      // after looking at the candidate shown beside them.
      _keep: s.kind === 'fresh',
    }
  })

  showImportReview()
}

// ---------- review ----------

function showImportReview() {
  const counts = {
    fresh:   _parsedTx.filter(t => t._state === 'fresh').length,
    matched: _parsedTx.filter(t => t._state === 'matched').length,
    review:  _parsedTx.filter(t => t._state === 'review').length,
    orphans: _importOrphans.length,
  }

  const chips = [
    { label: 'בדוח',    value: _parsedTx.length, color: 'var(--accent)' },
    { label: 'חדשות',   value: counts.fresh,     color: 'var(--income)' },
    { label: 'כבר קיימות', value: counts.matched, color: 'var(--text-muted)' },
    ...(counts.review  ? [{ label: 'לבדיקה',        value: counts.review,  color: '#f59e0b' }] : []),
    ...(counts.orphans ? [{ label: 'קיימות ולא בדוח', value: counts.orphans, color: '#f59e0b' }] : []),
  ]
  document.getElementById('importChips').innerHTML = chips.map(c => `
    <div class="import-chip">
      <div class="chip-label">${c.label}</div>
      <div class="chip-value" style="color:${c.color}">${c.value}</div>
    </div>`).join('')

  const summaryEl = document.getElementById('importParseSummary')
  if (summaryEl) summaryEl.innerHTML = _buildParseSummary()

  const cats = getCategories()
  const accs = getAccounts()
  const importAcc = accs.find(a => a.id === _importAccountId)
  const showBillingMonth = importAcc?.type === 'credit_card'
  const typeLabel = tp => ({ income: 'הכנסה', expense: 'הוצאה', transfer: 'העברה', refund: 'החזר' }[tp] || tp)
  const typeCls = tp => ({ income: 'type-income', expense: 'type-expense', transfer: 'type-transfer', refund: 'type-refund' }[tp] || 'type-expense')

  const rows = _parsedTx.map((t, i) => {
    const cat = cats.find(c => c.id === t._categoryId)
    const matched = t._state === 'matched'
    const review  = t._state === 'review'
    const badge = matched ? 'קיים' : review ? '<span style="color:#f59e0b">לבדיקה</span>' : typeLabel(t.type)
    const badgeCls = (matched || review) ? '' : typeCls(t.type)

    // An ambiguous row shows what it might be, so the call can be made here
    // rather than by digging through the transactions screen afterwards.
    let hint = ''
    if (review && t._candidates?.length) {
      const c = t._candidates[0].existing.ref
      hint = `<div style="font-size:.72rem;color:#f59e0b;margin-top:.15rem">דומה לקיימת: ${escHtml(c.vendor || '')} · ${formatDate(c.date)}</div>`
    } else if (matched && t._matchAgainst) {
      hint = `<div style="font-size:.72rem;color:var(--text-muted);margin-top:.15rem">תואם עסקה קיימת מ-${formatDate(t._matchAgainst.date)}</div>`
    }

    const billingCell = showBillingMonth ? `<td>
      <input type="month" value="${t._billingMonth || ''}"
        title="חודש חיוב${t._billingProvenance === 'explicit' ? ' (מהדוח)' : ' (מחושב)'}"
        class="import-billing-month-input${t._billingProvenance === 'explicit' ? ' import-billing-month-overridden' : ''}"
        onchange="_overrideBillingMonth(${i},this.value)">
    </td>` : ''

    return `
    <tr style="opacity:${matched ? '.45' : review ? '.8' : '1'};${review ? 'background:rgba(245,158,11,0.06)' : ''}">
      <td><input type="checkbox" ${t._keep ? 'checked' : ''}
        onchange="_parsedTx[${i}]._keep=this.checked;_updateSaveBtn()"
        ${matched ? 'title="כבר קיימת במערכת. סמן כדי לייבא בכל זאת"' : ''}
        style="width:auto;cursor:pointer"></td>
      <td>${formatDate(t.date)}</td>
      <td style="font-weight:500">${escHtml(t.vendor)}${hint}</td>
      <td style="font-weight:700;color:${t.amount > 0 ? 'var(--income)' : 'var(--expense)'}">${t.amount > 0 ? '+' : ''}${formatCurrency(t.amount)}</td>
      <td>${cat ? `<span style="font-size:.8rem">${catIconHTML(cat)} ${escHtml(cat.name)}</span>` : '<span style="color:var(--text-muted);font-size:.8rem">—</span>'}</td>
      <td><span class="${badgeCls ? `type-badge ${badgeCls}` : ''}">${badge}</span></td>
      ${billingCell}
    </tr>`
  }).join('')

  document.getElementById('importTable').innerHTML = `
    <thead><tr><th>ייבא</th><th>תאריך</th><th>ספק</th><th>סכום</th><th>קטגוריה</th><th>סטטוס</th>${showBillingMonth ? '<th>חודש חיוב</th>' : ''}</tr></thead>
    <tbody>${rows}</tbody>`

  const orphEl = document.getElementById('importOrphans')
  if (orphEl) orphEl.innerHTML = _buildOrphanPanel()

  _importShowStep('importStep3')
  _updateSaveBtn()
}

// The rows already stored inside the cycles this file covers, that the file
// does not contain. Never hidden: if the matcher missed something, the row it
// should have matched is listed here, right beside the "new" row it belongs to.
function _buildOrphanPanel() {
  if (!_importOrphans.length) return ''
  const shown = _importOrphans.slice(0, 12)
  return `
    <details class="import-orphans" style="margin-top:.75rem">
      <summary style="cursor:pointer;color:#f59e0b;font-size:.85rem">
        ${_importOrphans.length} עסקאות קיימות בחודשים האלה שלא הופיעו בדוח — בדוק אם אחת מהן היא בעצם שורה שסומנה "חדשה"
      </summary>
      <div style="font-size:.8rem;color:var(--text-muted);margin-top:.5rem;display:grid;gap:.25rem">
        ${shown.map(o => `<div>${formatDate(o.date)} · ${escHtml(o.vendor || '')} · ${formatCurrency(o.amount)}</div>`).join('')}
        ${_importOrphans.length > shown.length ? `<div>ועוד ${_importOrphans.length - shown.length}…</div>` : ''}
      </div>
    </details>`
}

function _overrideBillingMonth(i, monthVal) {
  if (!monthVal || !_parsedTx[i]) return
  _parsedTx[i]._billingMonth = monthVal
  _parsedTx[i]._billingProvenance = 'explicit'
  showImportReview()
}

function _buildParseSummary() {
  const txs = _parsedTx.filter(t => t._state !== 'matched')
  const all = _parsedTx
  if (all.length === 0) return ''
  const fileSum = all.reduce((s, t) => s + (t.amount || 0), 0)
  const dates = all.map(t => t.date).filter(Boolean).sort()
  const tplBadge = _lastTemplateName
    ? `<span class="parse-summary-badge">תבנית: ${escHtml(_lastTemplateName)}</span>`
    : `<span class="parse-summary-badge parse-summary-ai">AI</span>`
  const stats = _lastParseStats
  const skippedNote = stats && stats.skipped > 0
    ? ` · דולגו ${stats.skipped} שורות (${Object.entries(stats.skippedReasons).map(([r, n]) => `${r}: ${n}`).join(', ')})`
    : ''
  const scopeNote = _importScopeMonths.length
    ? ` · חודשי חיוב: ${_importScopeMonths.slice().sort().join(', ')}`
    : ''
  return `
    <div class="parse-summary">
      ${tplBadge}
      <span>סה"כ בדוח: <b class="cur">${Math.round(fileSum).toLocaleString('he-IL')}</b></span>
      <span>לייבוא: <b style="color:var(--income)" class="cur">${Math.round(txs.filter(t => t._keep).reduce((s, t) => s + (t.amount || 0), 0)).toLocaleString('he-IL')}</b></span>
      <span>טווח: ${dates[0] || '—'} → ${dates[dates.length - 1] || '—'}</span>
      <span style="color:var(--text-muted)">${scopeNote}${skippedNote}</span>
    </div>`
}

function _updateSaveBtn() {
  const n = _parsedTx.filter(t => t._keep).length
  const btn = document.getElementById('importSaveBtn')
  if (!btn) return
  btn.textContent = n ? `שמור ${n} עסקאות` : 'אין מה לייבא'
  btn.disabled = n === 0
}

// ---------- save ----------

function saveImport() {
  const toSave = _parsedTx.filter(t => t._keep)
  const existing = getTransactions()
  const batchId = genId()
  const importedAt = Date.now()
  const docId = _importDoc?.id || genId()

  const newTx = toSave.map(t => ({
    id:          genId(),
    accountId:   t._accountId,
    date:        t.date,
    amount:      t.amount,
    vendor:      t.vendor,
    description: t.description || '',
    type:        t.type,
    categoryId:  t._categoryId || '',
    ...(t._billingMonth ? { billingMonth: t._billingMonth } : {}),
    ...(t.chargeDate ? { chargeDate: t.chargeDate } : {}),
    ...(t._categoryId && t._categorySource ? { categorySource: t._categorySource } : {}),
    notes: (typeof buildAutoNotes === 'function') ? buildAutoNotes({
      installmentCurrent: t.installmentCurrent,
      installmentTotal:   t.installmentTotal,
      installmentFinalMonth: t._installmentFinalMonth,
      standingOrder:      t.standingOrder,
      detectedRecipient:  t.detectedRecipient,
    }) : '',
    ...(t.installmentCurrent ? { installmentCurrent: t.installmentCurrent } : {}),
    ...(t.installmentTotal   ? { installmentTotal:   t.installmentTotal   } : {}),
    ...(t._installmentFinalMonth ? { installmentFinalMonth: t._installmentFinalMonth } : {}),
    ...(t.standingOrder ? { standingOrder: true } : {}),
    ...(t.detectedProvider ? { detectedProvider: t.detectedProvider } : {}),
    ...(t.detectedRecipient ? { detectedRecipient: t.detectedRecipient } : {}),
    // Provenance: which document and which line of it this row came from.
    ...(t._rowSig ? { srcRowHash: t._rowSig } : {}),
    ...(t._rowIndex != null ? { srcRow: t._rowIndex } : {}),
    srcDoc:      docId,
    sourceFile:  _importFileName,
    importBatch: batchId,
    importedAt,
    createdAt:   importedAt,
  }))

  DB.set('finTransactions', [...existing, ...newTx])

  if (typeof recordSourceDoc === 'function' && _importDoc?.contentHash) {
    const doc = recordSourceDoc({
      id: docId,
      contentHash: _importDoc.contentHash,
      filename: _importFileName,
      accountId: _importAccountId,
      billingMonths: _importScopeMonths,
      detectedVia: _importDoc.detectedVia || '',
      parser: _lastTemplateName ? `template:${_lastTemplateName}` : 'ai',
      txCount: newTx.length,
      rowCount: _parsedTx.length,
      importedAt,
    })
    // Raw rows are a best-effort convenience for audit and re-parsing; a
    // failure here must never affect the import that just succeeded.
    if (typeof putSourceRows === 'function' && _importDoc.rows) {
      putSourceRows(doc.id, _importDoc.rows).then(() => {
        if (typeof pruneSourceRows === 'function') pruneSourceRows()
      })
    }
  }

  _importShowStep('importStep4')
  const msg = document.getElementById('importDoneMsg')
  if (msg) {
    const skipped = _parsedTx.length - newTx.length
    msg.textContent = `${newTx.length} עסקאות נשמרו` + (skipped ? ` · ${skipped} כבר היו במערכת` : '')
  }
}

// ===== JSON PARSER =====
function tryParseJSON(text) {
  try { return JSON.parse(text) } catch {}

  // An object wrapper (metadata + transactions) is valid too.
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  const start = (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) ? objStart : arrStart
  if (start < 0) throw new Error('תשובת AI לא הכילה נתונים – נסה שוב')
  let jsonPart = text.slice(start)

  const closer = text[start] === '{' ? '}' : ']'
  const end = jsonPart.lastIndexOf(closer)
  if (end > 0) {
    try { return JSON.parse(jsonPart.slice(0, end + 1)) } catch {}
  }

  // Truncated JSON – recover up to the last complete object.
  const lastBrace = jsonPart.lastIndexOf('}')
  if (lastBrace > 0) {
    const fixed = jsonPart.slice(0, lastBrace + 1).replace(/,\s*$/, '') + ']'
    try { return JSON.parse(fixed.startsWith('[') ? fixed : '[' + fixed) } catch {}
  }
  throw new Error('שגיאה בפרסור תשובת AI – נסה שוב')
}

// ===== HELPERS =====
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result.split(',')[1])
    r.onerror = rej
    r.readAsDataURL(file)
  })
}
function excelToCSV(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' })
        const parts = []
        for (const name of wb.SheetNames) {
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim()
          if (!csv) continue
          parts.push(wb.SheetNames.length > 1 ? `=== גיליון: ${name} ===\n${csv}` : csv)
        }
        res(parts.join('\n\n'))
      } catch (err) { rej(err) }
    }
    r.onerror = rej
    r.readAsArrayBuffer(file)
  })
}
function getMimeType(filename) {
  if (filename.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

// Read a text file with encoding detection: UTF-8 first, fallback to
// windows-1255 (Hebrew) if the UTF-8 decode produced replacement characters.
function readTextFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = e => {
      try {
        const buf = e.target.result
        const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
        if (!utf8.includes('\uFFFD')) { res(utf8); return }
        try { res(new TextDecoder('windows-1255', { fatal: false }).decode(buf)) }
        catch { res(utf8) }
      } catch (err) { rej(err) }
    }
    r.onerror = rej
    r.readAsArrayBuffer(file)
  })
}
