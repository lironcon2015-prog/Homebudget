let _parsedTx = []
let _importFileName = ''
let _importAccountId = ''

function initImport() {
  resetImport()
  const accounts = getAccounts()
  const sel = document.getElementById('importAccount')
  sel.innerHTML = accounts.length === 0
    ? '<option value="">אין חשבונות – צור חשבון בהגדרות</option>'
    : accounts.map(a => `<option value="${a.id}">${escHtml(a.name)}${a.institution?' – '+escHtml(a.institution):''}</option>`).join('')
}

function resetImport() {
  _parsedTx = []
  _importAccountId = ''
  ;['importStep2','importStep3','importStep4','importStepError'].forEach(id => {
    const el = document.getElementById(id)
    if (el) el.style.display = 'none'
  })
  const s1 = document.getElementById('importStep1')
  if (s1) s1.style.display = 'block'
  document.getElementById('importError').textContent = ''
  const fi = document.getElementById('fileInput')
  if (fi) fi.value = ''
}

function handleFileSelect(input) {
  const file = input.files?.[0]
  if (!file) return
  const accountId = document.getElementById('importAccount')?.value
  if (!accountId) { document.getElementById('importError').textContent = 'יש לבחור חשבון תחילה'; return }
  _importFileName = file.name

  const isStructured = /\.(xlsx?|csv|txt)$/i.test(file.name)
  if (isStructured) {
    handleStructuredFile(file, accountId)
  } else {
    const apiKey = getApiKey()
    if (!apiKey) { document.getElementById('importError').textContent = 'חסר מפתח Gemini API – הזן בהגדרות'; return }
    parseWithGemini(file, accountId, apiKey)
  }
}

async function handleStructuredFile(file, accountId) {
  document.getElementById('importStep1').style.display = 'none'
  document.getElementById('importStep2').style.display = 'block'
  document.getElementById('importFilename').textContent = file.name
  const msgEl = document.getElementById('importLoadingMsg')
  if (msgEl) msgEl.textContent = 'קורא את הקובץ...'
  try {
    const rows = await extractRowsFromFile(file)
    // Try existing template (try each plausible header row 0..min(10,rows-1))
    const maxTry = Math.min(rows.length, 15)
    let matched = null
    for (let i = 0; i < maxTry; i++) {
      const tpl = findTemplateForHeaderRow(rows[i] || [])
      if (tpl) {
        // Template saved with a specific header row? Respect it.
        matched = { ...tpl, headerRowIndex: tpl.headerRowIndex ?? i }
        break
      }
    }
    if (matched) {
      continueImportWithTemplate(file, accountId, rows, matched)
    } else {
      document.getElementById('importStep2').style.display = 'none'
      openTplWizard(file, accountId, rows)
    }
  } catch (err) {
    console.error('Structured import error:', err)
    document.getElementById('importStep2').style.display = 'none'
    document.getElementById('importStepError').style.display = 'block'
    document.getElementById('importErrMsg').textContent = err.message
  }
}

function continueImportWithTemplate(file, accountId, rows, template) {
  try {
    document.getElementById('importStep2').style.display = 'block'
    const msgEl = document.getElementById('importLoadingMsg')
    if (msgEl) msgEl.textContent = `פרסור דטרמיניסטי לפי תבנית "${template.name}"...`
    const { transactions, stats } = parseWithTemplate(rows, template)
    _lastParseStats = stats
    _lastTemplateName = template.name
    bumpTemplateUsage(template.id, transactions.length)
    _finalizeParsedTransactions(transactions, accountId)
  } catch (err) {
    console.error('Template parse error:', err)
    document.getElementById('importStep2').style.display = 'none'
    document.getElementById('importStepError').style.display = 'block'
    document.getElementById('importErrMsg').textContent = err.message
  }
}

let _lastParseStats = null
let _lastTemplateName = ''

async function parseWithGemini(file, accountId, apiKey) {
  document.getElementById('importStep1').style.display = 'none'
  document.getElementById('importStep2').style.display = 'block'
  document.getElementById('importFilename').textContent = file.name
  const msgEl = document.getElementById('importLoadingMsg')
  if (msgEl) msgEl.textContent = 'מנתח עם Gemini AI...'

  try {
    const isExcel = /\.xlsx?$/i.test(file.name)
    const isText = /\.(csv|txt)$/i.test(file.name)
    let parts

    const prompt = getPrompt()

    if (isExcel) {
      const csv = await excelToCSV(file)
      parts = [{ text: prompt + '\n\nנתוני הקובץ:\n' + csv }]
    } else if (isText) {
      const text = await readTextFile(file)
      parts = [{ text: prompt + '\n\nנתוני הקובץ:\n' + text }]
    } else {
      const base64 = await fileToBase64(file)
      const mimeType = getMimeType(file.name)
      parts = [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }

    const body = {
      contents: [{ parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 65536 }
    }

    const data = await callGemini(apiKey, body)

    const candidate = data.candidates?.[0]
    console.log('Gemini finishReason:', candidate?.finishReason)
    console.log('Gemini parts count:', candidate?.content?.parts?.length)

    // Gemini 2.5 models return thinking + response in separate parts
    const allParts = candidate?.content?.parts || []
    let text = ''
    for (const p of allParts) {
      if (!p.thought && p.text) { text = p.text; break }
    }
    // fallback: concatenate all non-thought text
    if (!text) text = allParts.filter(p => !p.thought).map(p => p.text || '').join('')
    // last resort: any text at all
    if (!text) text = allParts.map(p => p.text || '').join('')
    console.log('Gemini extracted text:', text.slice(0, 500))

    text = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()
    if (!text) {
      const reason = candidate?.finishReason || 'unknown'
      throw new Error(`תשובה ריקה מ-AI (סיבה: ${reason}) – נסה שוב`)
    }
    const parsed = tryParseJSON(text)
    _lastParseStats = null
    _lastTemplateName = ''
    _finalizeParsedTransactions(parsed, accountId)
  } catch (err) {
    console.error('Import error:', err)
    document.getElementById('importStep2').style.display = 'none'
    document.getElementById('importStepError').style.display = 'block'
    document.getElementById('importErrMsg').textContent = err.message
  }
}

function _finalizeParsedTransactions(parsed, accountId) {
  _importAccountId = accountId
  const cats = getCategories()
  const matchCategory = (t) => {
    const catName = (t.category || '').trim()
    if (!catName) return ''
    const match = cats.find(c => c.name === catName || catName.includes(c.name) || c.name.includes(catName))
    return match?.id || ''
  }

  // Autocat: learn from user's prior categorizations by vendor (uncategorized only)
  const existing = getTransactions()
  const autocatRules = (typeof _buildVendorCategoryRules === 'function')
    ? _buildVendorCategoryRules(existing) : {}
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

  // Effective billing month — keys the dedup so installments (תשלומים) across
  // different bills survive: same purchase date + amount + vendor, different
  // chargeDate ⇒ different billing months ⇒ separate slots, not duplicates.
  // Non-CC rows resolve to the calendar month of `date`, preserving prior
  // behavior. Rows imported before chargeDate existed fall back to billingDay
  // rollover, which may collide with new chargeDate-tagged rows on rare edges
  // — the user can override per-row in the review table.
  const txMonth = (tx, accId) => {
    try {
      return getTxEffectiveMonth({
        date: tx.date,
        chargeDate: tx.chargeDate,
        accountId: accId || tx.accountId,
      }) || ''
    } catch { return '' }
  }

  // Credit-card imports: every line on a CC bill belongs to that bill's
  // billing month, regardless of the purchase date. Installments (תשלומים)
  // are purchases from earlier months that re-appear on each bill — same
  // (date, amount, vendor) across N bills. Without distinguishing the bills,
  // installment 2/N onward gets falsely flagged as a duplicate of 1/N.
  // Gemini doesn't reliably return a chargeDate column, so we infer the
  // file's billing month from the latest transaction date in the file:
  // CC bills close ~day (billingDay-1) of the billing month, so the latest
  // date's day < CC_BILL_DAY_CUTOFF (=9, with 2-day safety) puts the bill in
  // that calendar month; otherwise, it rolls to next month. Then we stamp
  // chargeDate on every row that lacks one, so dedup-by-month works.
  const accForImport = getAccounts().find(a => a.id === accountId)
  const isCCImport = accForImport?.type === 'credit_card'
  const ccBillingDay = accForImport?.billingDay || 10
  const CC_BILL_DAY_CUTOFF = 9
  let fileBillingMonth = ''
  if (isCCImport && Array.isArray(parsed) && parsed.length) {
    const dates = parsed.map(t => t.date).filter(Boolean).sort()
    const last = dates[dates.length - 1]
    if (last) {
      const [y, m, d] = last.split('-').map(Number)
      if (d < CC_BILL_DAY_CUTOFF) {
        fileBillingMonth = `${y}-${String(m).padStart(2, '0')}`
      } else {
        const nm = m === 12 ? 1 : m + 1
        const ny = m === 12 ? y + 1 : y
        fileBillingMonth = `${ny}-${String(nm).padStart(2, '0')}`
      }
    }
  }
  const inferredChargeDate = fileBillingMonth
    ? `${fileBillingMonth}-${String(ccBillingDay).padStart(2, '0')}`
    : ''
  // Pre-enrich so installment metadata is available for the date-remap
  // decision below. The downstream map() also re-runs enrichment idempotently,
  // so it's safe to mutate `parsed` in place.
  if (isCCImport && typeof enrichDetectedFields === 'function') {
    parsed.forEach((t, i) => {
      const e = enrichDetectedFields(t)
      if (e.installmentCurrent) t.installmentCurrent = e.installmentCurrent
      if (e.installmentTotal)   t.installmentTotal   = e.installmentTotal
      if (e.standingOrder)      t.standingOrder      = true
      if (e.detectedProvider)   t.detectedProvider   = e.detectedProvider
      if (e.detectedRecipient)  t.detectedRecipient  = e.detectedRecipient
      if (e.vendor && e.vendor !== t.vendor) t.vendor = e.vendor
    })
  }
  if (isCCImport) {
    parsed.forEach(t => {
      if (t.chargeDate) return  // explicit chargeDate from file wins
      // Installments whose date is from a different cycle than this bill's
      // (typical when the CC issuer prints the original purchase date instead
      // of the per-cycle charge date) get remapped to the bill cycle, keeping
      // the day-of-month. Once date is corrected we don't need chargeDate —
      // getTxEffectiveMonth derives the bill month from date + billingDay.
      const isInstallment = t.installmentCurrent && t.installmentTotal
      if (isInstallment && fileBillingMonth && typeof remapInstallmentDateToBillCycle === 'function') {
        const natural = (typeof getTxEffectiveMonth === 'function')
          ? getTxEffectiveMonth({ date: t.date, accountId })
          : ''
        if (natural && natural !== fileBillingMonth) {
          const newDate = remapInstallmentDateToBillCycle(t.date, fileBillingMonth, ccBillingDay)
          if (newDate && newDate !== t.date) {
            t._originalDate = t.date
            t.date = newDate
            return
          }
        }
      }
      if (inferredChargeDate) t.chargeDate = inferredChargeDate
    })
  }

  // Multi-set dedupe: each existing row is one slot that can be consumed by
  // at most one new row. Without this, N installments that share the same
  // (date, amount, vendor, description) all match the SAME single existing
  // row and get falsely flagged as duplicates — which silently drops every
  // legitimate installment beyond the first when re-importing a CC bill.
  const slotsByHash = new Map()
  existing.forEach(t => {
    const seen = new Set()
    const m = txMonth(t)
    ;[t.sourceHash, t.legacySourceHash].forEach(h => {
      if (!h || seen.has(h)) return
      seen.add(h)
      const key = `${h}|${m}`
      if (!slotsByHash.has(key)) slotsByHash.set(key, [])
      slotsByHash.get(key).push(t)
    })
  })
  const consumed = new WeakSet()
  const consumeMatch = (m, ...hashes) => {
    for (const h of hashes) {
      if (!h) continue
      const slots = slotsByHash.get(`${h}|${m}`)
      if (!slots) continue
      for (const row of slots) {
        if (!consumed.has(row)) { consumed.add(row); return true }
      }
    }
    return false
  }

  // Loose-hash dedup: vendor-agnostic (accountId|date|amount only).
  // Catches re-imports where Gemini returned a different vendor string.
  // Shares the same `consumed` WeakSet so exact-matched rows can't also
  // be loose-matched by a subsequent import row.
  const slotsByLooseHash = new Map()
  existing.forEach(t => {
    const lh = t.looseHash || _rawHash(`${t.accountId}|${t.date}|${t.amount}`)
    const key = `${lh}|${txMonth(t)}`
    if (!slotsByLooseHash.has(key)) slotsByLooseHash.set(key, [])
    slotsByLooseHash.get(key).push(t)
  })
  const consumeLooseMatch = (m, lh) => {
    if (!lh) return false
    const slots = slotsByLooseHash.get(`${lh}|${m}`)
    if (!slots) return false
    for (const row of slots) {
      if (!consumed.has(row)) { consumed.add(row); return true }
    }
    return false
  }

  // Auto-transfer detection on import is DISABLED: the bank statement is the
  // authoritative P&L source. A "כאל 5000" line on the bank is a real expense,
  // not a transfer. Users can manually mark a row as transfer in the edit modal,
  // or run "זהה אוטומטית חיובי אשראי" in settings to bulk-link after the fact.

  _parsedTx = parsed.map(raw => {
    // Detect installments / standing orders / bit-paybox payees BEFORE
    // hashing and category matching — enrichment can rewrite the vendor
    // (bit/paybox → "ביט <recipient>"), which feeds both the autocat
    // lookup and the dedup hash.
    const t = (typeof enrichDetectedFields === 'function') ? enrichDetectedFields(raw) : raw
    const catFromName    = matchCategory(t)
    const catFromRules   = catFromName ? '' : matchVendorToCategory(t.vendor, t.description)
    const catFromAutocat = (catFromName || catFromRules) ? '' : suggestFromAutocat(t.vendor)
    const { hash, legacyHash, looseHash } = hashTx(t, accountId)
    const newMonth = txMonth(t, accountId)
    const isDuplicate = consumeMatch(newMonth, hash, legacyHash)
    const isMaybeDuplicate = !isDuplicate && consumeLooseMatch(newMonth, looseHash)
    // Final billing month is computed from THIS installment's actual charge
    // month: chargeMonth(current) + (total - current). The charge month comes
    // from getTxEffectiveMonth (issuer chargeDate column wins, else billingDay
    // rollover), so we never depend on reconstructing the purchase date.
    let installmentFinalMonth = ''
    if (t.installmentCurrent && t.installmentTotal) {
      const chargeMonth = (typeof getTxEffectiveMonth === 'function')
        ? getTxEffectiveMonth({ date: t.date, chargeDate: t.chargeDate, accountId })
        : ''
      if (chargeMonth && typeof installmentFinalMonthFromCharge === 'function') {
        installmentFinalMonth = installmentFinalMonthFromCharge(chargeMonth, t.installmentCurrent, t.installmentTotal)
      } else if (typeof computeInstallmentFinalMonth === 'function') {
        installmentFinalMonth = computeInstallmentFinalMonth(t._originalDate || t.date, t.installmentTotal)
      }
    }
    return {
      ...t,
      _installmentFinalMonth: installmentFinalMonth,
      _categoryId:     catFromName || catFromRules || catFromAutocat,
      _hash:           hash,
      _legacyHash:     legacyHash,
      _looseHash:      looseHash,
      _duplicate:      isDuplicate,
      _maybeDuplicate: isMaybeDuplicate,
      _keep:           !isDuplicate && !isMaybeDuplicate,
      _accountId:      accountId,
    }
  })

  document.getElementById('importStep2').style.display = 'none'
  showImportReview()
}

function _overrideBillingMonth(i, monthVal) {
  if (!monthVal || !_parsedTx[i]) return
  const acc = getAccounts().find(a => a.id === _parsedTx[i]._accountId)
  const billingDay = acc?.billingDay || 10
  _parsedTx[i].chargeDate = `${monthVal}-${String(billingDay).padStart(2, '0')}`
  showImportReview()
}

function showImportReview() {
  const toImport = _parsedTx.filter(t => t._keep).length
  const dups = _parsedTx.filter(t => t._duplicate).length
  const maybeDups = _parsedTx.filter(t => t._maybeDuplicate).length

  document.getElementById('importChips').innerHTML = [
    { label: 'עסקאות שנמצאו', value: _parsedTx.length,  color: 'var(--accent)' },
    { label: 'לייבוא',         value: toImport,           color: 'var(--income)' },
    ...(dups > 0      ? [{ label: 'כפילויות (מדולגות)',        value: dups,      color: 'var(--text-muted)' }] : []),
    ...(maybeDups > 0 ? [{ label: 'ייתכן כפיל (בדוק ידנית)', value: maybeDups, color: '#f59e0b' }] : []),
  ].map(c => `
    <div class="import-chip">
      <div class="chip-label">${c.label}</div>
      <div class="chip-value" style="color:${c.color}">${c.value}</div>
    </div>`).join('')

  const summaryEl = document.getElementById('importParseSummary')
  if (summaryEl) summaryEl.innerHTML = _buildParseSummary()

  const cats = getCategories()
  const typeLabel = tp => ({ income:'הכנסה', expense:'הוצאה', transfer:'העברה', refund:'החזר' }[tp] || tp)
  const typeCls = tp => ({ income:'type-income', expense:'type-expense', transfer:'type-transfer', refund:'type-refund' }[tp] || 'type-expense')
  const accs = getAccounts()
  const importAcc = accs.find(a => a.id === _importAccountId)
  const showBillingMonth = importAcc?.type === 'credit_card'
  const rows = _parsedTx.map((t, i) => {
    const cat = cats.find(c => c.id === t._categoryId)
    const acc = accs.find(a => a.id === t._accountId)
    const txDay = t.date ? Number(t.date.split('-')[2]) : null
    const suspicious = acc && acc.type === 'credit_card' && txDay !== null && txDay === (acc.billingDay || 10)
    const billingWarn = suspicious
      ? `<span title="שים לב: תאריך העסקה זהה ליום החיוב. ודא שזהו אכן תאריך הרכישה ולא תאריך החיוב המרוכז" style="cursor:help"> ⚠️</span>`
      : ''
    const rowOpacity = t._duplicate ? '.4' : (t._maybeDuplicate ? '.7' : '1')
    const rowBg = t._maybeDuplicate ? 'background:rgba(245,158,11,0.06)' : ''
    const badge = t._duplicate
      ? 'קיים'
      : t._maybeDuplicate
        ? '<span style="color:#f59e0b">ייתכן כפיל</span>'
        : typeLabel(t.type)
    const badgeCls = (t._duplicate || t._maybeDuplicate) ? '' : typeCls(t.type)
    let billingMonthCell = ''
    if (showBillingMonth) {
      const effMonth = (typeof getTxEffectiveMonth === 'function')
        ? getTxEffectiveMonth({ date: t.date, chargeDate: t.chargeDate, accountId: t._accountId })
        : (t.date || '').slice(0, 7)
      const isOverridden = !!t.chargeDate
      billingMonthCell = `<td>
        <input type="month" value="${effMonth}" title="חודש חיוב${isOverridden ? ' (עודכן ידנית)' : ''}"
          class="import-billing-month-input${isOverridden ? ' import-billing-month-overridden' : ''}"
          onchange="_overrideBillingMonth(${i},this.value)">
      </td>`
    }
    return `
    <tr style="opacity:${rowOpacity};${rowBg}">
      <td><input type="checkbox" ${t._keep?'checked':''}
        onchange="_parsedTx[${i}]._keep=this.checked;_updateSaveBtn()"
        ${t._duplicate?'title="עסקה שזוהתה ככפילות. סמן וי כדי לייבא בכל זאת"':''}
        style="width:auto;cursor:pointer"></td>
      <td>${formatDate(t.date)}${billingWarn}</td>
      <td style="font-weight:500">${escHtml(t.vendor)}</td>
      <td style="font-weight:700;color:${t.amount>0?'var(--income)':'var(--expense)'}">${t.amount>0?'+':''}${formatCurrency(t.amount)}</td>
      <td>${cat ? `<span style="font-size:.8rem">${catIconHTML(cat)} ${escHtml(cat.name)}</span>` : '<span style="color:var(--text-muted);font-size:.8rem">—</span>'}</td>
      <td><span class="${badgeCls?`type-badge ${badgeCls}`:''}">${badge}</span></td>
      ${billingMonthCell}
    </tr>`}).join('')

  document.getElementById('importTable').innerHTML = `
    <thead><tr><th>ייבא</th><th>תאריך</th><th>ספק</th><th>סכום</th><th>קטגוריה</th><th>סוג</th>${showBillingMonth ? '<th>חודש חיוב</th>' : ''}</tr></thead>
    <tbody>${rows}</tbody>`

  document.getElementById('importStep3').style.display = 'block'
  _updateSaveBtn()
}

function _buildParseSummary() {
  const txs = _parsedTx.filter(t => !t._duplicate)
  if (txs.length === 0) return ''
  const incomeSum   = txs.filter(t => t.amount > 0).reduce((s,t)=>s+t.amount, 0)
  const expenseSum  = txs.filter(t => t.amount < 0).reduce((s,t)=>s+t.amount, 0)
  const dates = txs.map(t => t.date).filter(Boolean).sort()
  const minDate = dates[0], maxDate = dates[dates.length - 1]
  const tplBadge = _lastTemplateName
    ? `<span class="parse-summary-badge">תבנית: ${escHtml(_lastTemplateName)}</span>`
    : `<span class="parse-summary-badge parse-summary-ai">AI</span>`
  const stats = _lastParseStats
  const skippedNote = stats && stats.skipped > 0
    ? ` · דולגו ${stats.skipped} שורות (${Object.entries(stats.skippedReasons).map(([r,n])=>`${r}: ${n}`).join(', ')})`
    : ''
  return `
    <div class="parse-summary">
      ${tplBadge}
      <span>הכנסות: <b style="color:var(--income)" class="cur">+${Math.round(incomeSum).toLocaleString('he-IL')}</b></span>
      <span>הוצאות: <b style="color:var(--expense)" class="cur">${Math.round(expenseSum).toLocaleString('he-IL')}</b></span>
      <span>טווח: ${minDate || '—'} → ${maxDate || '—'}</span>
      ${skippedNote ? `<span style="color:var(--text-muted)">${skippedNote}</span>` : ''}
    </div>`
}

function _updateSaveBtn() {
  const n = _parsedTx.filter(t => t._keep).length
  const btn = document.getElementById('importSaveBtn')
  btn.textContent = `שמור ${n} עסקאות`
  btn.disabled = n === 0
}

function saveImport() {
  const toSave = _parsedTx.filter(t => t._keep)
  const existing = getTransactions()
  const batchId = genId()
  const importedAt = Date.now()
  const newTx = toSave.map(t => ({
    id:               genId(),
    accountId:        t._accountId,
    date:             t.date,
    amount:           t.amount,
    vendor:           t.vendor,
    description:      t.description || '',
    ...(t.chargeDate ? { chargeDate: t.chargeDate } : {}),
    type:             t.type,
    categoryId:       t._categoryId || '',
    notes:            (typeof buildAutoNotes === 'function') ? buildAutoNotes({
                        installmentCurrent: t.installmentCurrent,
                        installmentTotal:   t.installmentTotal,
                        installmentFinalMonth: t._installmentFinalMonth,
                        standingOrder:      t.standingOrder,
                        originalDate:       t._originalDate,
                        detectedRecipient:  t.detectedRecipient,
                      }) : '',
    ...(t.installmentCurrent ? { installmentCurrent: t.installmentCurrent } : {}),
    ...(t.installmentTotal   ? { installmentTotal:   t.installmentTotal   } : {}),
    ...(t._installmentFinalMonth ? { installmentFinalMonth: t._installmentFinalMonth } : {}),
    ...(t._originalDate ? { originalTransactionDate: t._originalDate } : {}),
    ...(t.standingOrder ? { standingOrder: true } : {}),
    ...(t.detectedProvider ? { detectedProvider: t.detectedProvider } : {}),
    ...(t.detectedRecipient ? { detectedRecipient: t.detectedRecipient } : {}),
    sourceHash:       t._hash,
    legacySourceHash: t._legacyHash,
    looseHash:        t._looseHash,
    sourceFile:       _importFileName,
    importBatch:      batchId,
    importedAt:       importedAt,
    createdAt:        importedAt,
  }))
  DB.set('finTransactions', [...existing, ...newTx])
  document.getElementById('importStep3').style.display = 'none'
  document.getElementById('importStep4').style.display = 'block'
  document.getElementById('importDoneMsg').textContent = `${newTx.length} עסקאות נשמרו בהצלחה`
}

// ===== JSON PARSER =====
function tryParseJSON(text) {
  // ניסיון ישיר
  try { return JSON.parse(text) } catch {}

  // חילוץ מערך JSON מתוך הטקסט
  const start = text.indexOf('[')
  if (start < 0) throw new Error('תשובת AI לא הכילה נתונים – נסה שוב')
  let jsonPart = text.slice(start)

  // הסרת טקסט אחרי סוף המערך
  const end = jsonPart.lastIndexOf(']')
  if (end > 0) {
    jsonPart = jsonPart.slice(0, end + 1)
    try { return JSON.parse(jsonPart) } catch {}
  }

  // JSON חתוך – מוצא את האובייקט השלם האחרון
  const lastBrace = jsonPart.lastIndexOf('}')
  if (lastBrace > 0) {
    let fixed = jsonPart.slice(0, lastBrace + 1)
    // הסרת פסיק מיותר לפני סגירה
    fixed = fixed.replace(/,\s*$/, '') + ']'
    try { return JSON.parse(fixed) } catch {}
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

// Read a text file with encoding detection: UTF-8 first, fallback to windows-1255 (Hebrew)
// if the UTF-8 decode produced replacement characters (U+FFFD).
function readTextFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = e => {
      try {
        const buf = e.target.result
        const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
        if (!utf8.includes('\uFFFD')) { res(utf8); return }
        try {
          const heb = new TextDecoder('windows-1255', { fatal: false }).decode(buf)
          res(heb)
        } catch {
          res(utf8)
        }
      } catch (err) { rej(err) }
    }
    r.onerror = rej
    r.readAsArrayBuffer(file)
  })
}
