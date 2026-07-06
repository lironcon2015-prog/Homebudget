let _txPage = 0
const TX_PAGE_SIZE = 40

function _richAmount(dispAmt) {
  const sign = dispAmt > 0 ? '+' : (dispAmt < 0 ? '-' : '')
  const abs = Math.abs(dispAmt)
  const intPart = Math.floor(abs).toLocaleString('he-IL')
  const cents = Math.round(abs * 100) % 100
  const decPart = '.' + String(cents).padStart(2, '0')
  return `<span class="cur">${sign}<span class="amt-sym">₪</span><span class="amt-int">${intPart}</span><span class="amt-dec">${decPart}</span></span>`
}

// Bulk-select mode: when on, each row gets a checkbox and a toolbar lets
// the user merge them into a manual recurring group. Tx that belong to a
// manual group (`recurringGroupId`) STAY in the list (with a 🔗 chip) —
// they only appear merged on the recurring screen.
let _txSelectMode = false
let _txSelected   = new Set()

// When viewing from a specific account, mirror-side transactions
// (CC payments / transfers to savings) affect the account's balance
// with the opposite sign. These helpers flip the perspective.
function _txIsMirrorFor(t, accountId) {
  return !!accountId && t.accountId !== accountId &&
    (t.ccPaymentForAccountId === accountId || t.transferAccountId === accountId)
}
function _txViewAmount(t, accountId) {
  return _txIsMirrorFor(t, accountId) ? -t.amount : t.amount
}

// "Advanced" filter panel — amount range, installment, standing-order — is
// collapsed by default so the main filters-bar stays uncluttered. We persist
// the open/closed state per session via a module-level flag (not localStorage)
// so it resets on reload but survives screen navigation in a single session.
let _txAdvOpen = false

// Contextual "back" bar shown when the transactions screen was opened by drilling
// in from another screen (e.g. the suspicious-transactions card). `_txPendingBack`
// is set by the caller right before navigate('transactions'); the next full render
// consumes it into `_txBackContext` (so it survives in-screen redraws but clears
// when the user enters transactions normally via a tab).
let _txPendingBack = null
let _txBackContext = null
function txSetReturnContext(ctx) { _txPendingBack = ctx }
function _txConsumeBack() { _txBackContext = _txPendingBack; _txPendingBack = null }
function _txBackBarHTML() {
  if (!_txBackContext) return ''
  const lbl = _txBackContext.label ? ` · ${_insEscSafe(_txBackContext.label)}` : ''
  return `<div class="tx-back-bar"><button class="tx-back-btn" onclick="txBack()">→ חזרה</button><span class="tx-back-lbl">${_txBackContext.fromLabel || 'חזרה'}${lbl}</span></div>`
}
function _insEscSafe(s) { return (typeof _insEsc === 'function') ? _insEsc(s) : String(s == null ? '' : s) }
function txBack() {
  const c = _txBackContext; _txBackContext = null
  const s = document.getElementById('txSearch'); if (s) s.value = ''
  if (c && typeof c.onBack === 'function') { c.onBack(); return }
  if (typeof navigate === 'function') navigate(c && c.screen ? c.screen : 'dashboard')
}

function renderTransactions() {
  if (typeof IS_MOBILE_UI !== 'undefined' && IS_MOBILE_UI && typeof M_renderTransactions === 'function') return M_renderTransactions()
  _txConsumeBack()
  const bb = document.getElementById('txBackBar'); if (bb) bb.innerHTML = _txBackBarHTML()
  _txPage = 0
  renderPeriodSelector('txPeriodSelector', () => { _txPage = 0; _drawTxTable() })
  _buildTxAccountFilter()
  _buildTxCategoryFilter()
  _buildTxFlowFilter()
  _syncTxAdvPanelVisibility()
  _drawTxTable()
}

function _syncTxAdvPanelVisibility() {
  const panel = document.getElementById('txAdvPanel')
  const btn   = document.getElementById('txAdvToggleBtn')
  if (!panel || !btn) return
  panel.style.display = _txAdvOpen ? 'grid' : 'none'
  const activeCount = _countActiveAdvFilters()
  const badge = activeCount > 0 ? ` (${activeCount})` : ''
  btn.textContent = (_txAdvOpen ? '▲ הסתר אפשרויות סינון' : '▼ אפשרויות סינון נוספות') + badge
  btn.classList.toggle('has-active', activeCount > 0)
}

function _countActiveAdvFilters() {
  const ids = ['txAmountMin', 'txAmountMax']
  let n = 0
  for (const id of ids) {
    const v = document.getElementById(id)?.value
    if (v !== undefined && v !== null && String(v).trim() !== '') n++
  }
  if (document.getElementById('txInstallmentFilter')?.checked) n++
  if (document.getElementById('txStandingOrderFilter')?.checked) n++
  return n
}

function toggleTxAdvFilters() {
  _txAdvOpen = !_txAdvOpen
  _syncTxAdvPanelVisibility()
}

function _onTxAdvChange() {
  _txPage = 0
  _syncTxAdvPanelVisibility()
  _drawTxTable()
}

function clearTxAdvFilters() {
  const a = document.getElementById('txAmountMin'); if (a) a.value = ''
  const b = document.getElementById('txAmountMax'); if (b) b.value = ''
  const c = document.getElementById('txInstallmentFilter'); if (c) c.checked = false
  const d = document.getElementById('txStandingOrderFilter'); if (d) d.checked = false
  _onTxAdvChange()
}

function _buildTxCategoryFilter() {
  const sel = document.getElementById('txCategoryFilter')
  if (!sel) return
  const cur = sel.value
  const cats = getCategories()
  const expCats = cats.filter(c => c.type === 'expense')
  const incCats = cats.filter(c => c.type === 'income')
  const opt = c => `<option value="${c.id}" ${c.id===cur?'selected':''}>${catIconText(c)} ${escHtml(c.name)}</option>`
  sel.innerHTML = `
    <option value="">כל הקטגוריות</option>
    <option value="__none__" ${cur==='__none__'?'selected':''}>— ללא קטגוריה —</option>
    <optgroup label="הוצאות">${expCats.map(opt).join('')}</optgroup>
    <optgroup label="הכנסות">${incCats.map(opt).join('')}</optgroup>`
}

function _buildTxAccountFilter() {
  const accs = getAccounts()
  const sel = document.getElementById('txAccountFilter')
  if (!sel) return
  const cur = sel.value
  sel.innerHTML = '<option value="">כל החשבונות</option>' +
    accs.map(a => `<option value="${a.id}" ${a.id===cur?'selected':''}>${escHtml(a.name)}</option>`).join('')
}

function _buildTxFlowFilter() {
  const sel = document.getElementById('txFlowFilter')
  if (!sel) return
  const nonLiquid = getAccounts().filter(a => !isLiquidAccount(a))
  const cur = sel.value
  sel.innerHTML = '<option value="">תזרים חיסכון/השקעות: הכל</option>' +
    nonLiquid.map(a => `<option value="${a.id}" ${a.id===cur?'selected':''}>תזרים ל/מ ${escHtml(a.name)}</option>`).join('')
  sel.style.display = nonLiquid.length === 0 ? 'none' : ''
}

function _getFiltered() {
  const search = document.getElementById('txSearch')?.value.toLowerCase() || ''
  const type   = document.getElementById('txTypeFilter')?.value || 'all'
  const account = document.getElementById('txAccountFilter')?.value || ''
  const category = document.getElementById('txCategoryFilter')?.value || ''
  const flowAcc = document.getElementById('txFlowFilter')?.value || ''
  // Advanced filters — read raw, validate, fall back to no-op when empty.
  const amtMinRaw = document.getElementById('txAmountMin')?.value
  const amtMaxRaw = document.getElementById('txAmountMax')?.value
  const amtMin = amtMinRaw === '' || amtMinRaw == null ? null : Math.abs(parseFloat(amtMinRaw))
  const amtMax = amtMaxRaw === '' || amtMaxRaw == null ? null : Math.abs(parseFloat(amtMaxRaw))
  const onlyInstallments  = !!document.getElementById('txInstallmentFilter')?.checked
  const onlyStandingOrder = !!document.getElementById('txStandingOrderFilter')?.checked
  const period = getActivePeriod()
  // Treat a tx as uncategorized if it has no categoryId, or if its
  // categoryId points at a category that was deleted.
  const validCatIds = new Set(getCategories().map(c => c.id))
  const isUncat = t => !t.categoryId || !validCatIds.has(t.categoryId)
  // Hide the bank-side aggregate CC payment ONLY when it resolves to a SPECIFIC
  // credit-card account that has its own itemized transactions imported (so the
  // lump + detail rows aren't both counted). Matching uses that card's own
  // identifiers (paymentVendorPatterns — set these to the card's 4-digit number
  // for precise, per-card matching). Generic company-name keyword hits
  // (_CC_LUMP_ANY) are NOT dropped, so charges for non-scraped cards stay visible
  // and unrelated rows that merely mention a CC brand aren't removed.
  const _ccAccsWithDetail = ccAccountsWithDetail(getTransactions())
  const _dropCcLump = t => {
    const target = ccLumpTargetForTx(t)
    return !!target && target !== _CC_LUMP_ANY && _ccAccsWithDetail.has(target)
  }
  return filterByEffectivePeriod(getTransactions(), period)
    .filter(t => {
      if (_dropCcLump(t)) return false
      // Tx that belong to a manual recurring group STAY in the tx list (the
      // user's bank still reflects them as separate operations) — they only
      // appear merged on the recurring screen. The row gets a 🔗 chip so it's
      // visually obvious which entries are linked.
      if (type !== 'all') {
        if (type === 'uncategorized') { if (!isUncat(t)) return false }
        else if (t.type !== type) return false
      }
      if (account) {
        const touchesAcc = t.accountId === account
          || t.ccPaymentForAccountId === account
          || t.transferAccountId === account
        if (!touchesAcc) return false
      }
      if (category) {
        if (category === '__none__') { if (!isUncat(t)) return false }
        else if (t.categoryId !== category) return false
      }
      if (flowAcc) {
        // Match either side of a flow involving the selected non-liquid account.
        // Linked rows keep type='expense' (autoLinkTransfersByPattern), so the
        // link fields must match regardless of type.
        const touches = t.accountId === flowAcc
          || t.transferAccountId === flowAcc
          || t.ccPaymentForAccountId === flowAcc
        if (!touches) return false
      }
      if (search) {
        const hay = ((t.vendor||'') + (t.description||'') + (resolveVendor(t.vendor, t.amount, getTxAliasDay(t))||'')).toLowerCase()
        if (!hay.includes(search)) return false
      }
      // Amount range compares against the absolute value so the user types
      // "100..200" once and gets both a 150₪ expense and a 150₪ refund.
      if (amtMin != null && !isNaN(amtMin)) {
        if (Math.abs(t.amount || 0) < amtMin) return false
      }
      if (amtMax != null && !isNaN(amtMax)) {
        if (Math.abs(t.amount || 0) > amtMax) return false
      }
      if (onlyInstallments && !(t.installmentCurrent && t.installmentTotal)) return false
      if (onlyStandingOrder && !t.standingOrder) return false
      return true
    })
    .sort((a,b) => (b.date||'').localeCompare(a.date||''))
}

function _drawTxTable() {
  if (typeof IS_MOBILE_UI !== 'undefined' && IS_MOBILE_UI && typeof M_drawTxList === 'function') return M_drawTxList()
  const filtered = _getFiltered()
  const accountId = document.getElementById('txAccountFilter')?.value || ''
  const acc = accountId ? getAccounts().find(a => a.id === accountId) : null
  // Running balance only for checking/cash — CC and savings/investment balances
  // aren't real-time accurate, so showing them is misleading.
  const showRunningBalance = !!(acc && PL_ACCOUNT_TYPES.has(acc.type))
  // Raw sums of visible rows (not P&L scope) so the summary matches
  // the table — CC detail and transactions on non-liquid accounts must
  // be counted here even though they're excluded from the dashboard P&L.
  // When viewing a single account, flip sign for mirror-side rows so a
  // CC payment (bank -5,000) shows as +5,000 credit against the CC.
  const viewAmt = t => _txViewAmount(t, accountId)
  const nonTransfer = filtered.filter(t => t.type !== 'transfer')
  const totalInc = nonTransfer.filter(t => viewAmt(t) > 0).reduce((s,t) => s + viewAmt(t), 0)
  const totalExp = nonTransfer.filter(t => viewAmt(t) < 0).reduce((s,t) => s + Math.abs(viewAmt(t)), 0)
  const net = totalInc - totalExp
  let runningBalanceInfo = ''
  if (showRunningBalance) {
    const bal = getAccountBalance(accountId)
    runningBalanceInfo = `<span style="color:${bal>=0?'var(--income)':'var(--expense)'};font-weight:600">יתרה: ${formatCurrency(bal)}</span>`
  }

  const categoryId = document.getElementById('txCategoryFilter')?.value || ''
  let categoryBalanceInfo = ''
  if (categoryId && categoryId !== '__none__') {
    const cat = getCategoryById(categoryId)
    const catBal = net
    const label = cat ? `${catIconHTML(cat)} ${escHtml(cat.name)}` : 'קטגוריה'
    categoryBalanceInfo = `<span style="color:${catBal>=0?'var(--income)':'var(--expense)'};font-weight:600">יתרת ${label}: ${formatCurrency(catBal)}</span>`
  }

  // Recurring summary — monthly-equivalent of all non-hidden recurring entries.
  // Surfaced here so the user sees the "fixed slice" of their flow alongside
  // the period totals.
  let recurringInfo = ''
  if (typeof recurringMonthlyTotals === 'function') {
    const rt = recurringMonthlyTotals()
    if (rt.count > 0) {
      const netCls = rt.net >= 0 ? 'net-pos' : 'net-neg'
      recurringInfo = `<span title="חודשי שקול של כל הקבועות הלא־מוסתרות"
        style="color:var(--text-muted)">קבועות חודשי:
        <span class="income">+${formatCurrency(rt.income)}</span>
        <span class="expense">-${formatCurrency(rt.expense)}</span>
        <span class="${netCls}">${rt.net>=0?'+':''}${formatCurrency(rt.net)}</span></span>`
    }
  }

  document.getElementById('txSummary').innerHTML = `
    <span>${filtered.length} עסקאות</span>
    <span class="income">+${formatCurrency(totalInc)}</span>
    <span class="expense">-${formatCurrency(totalExp)}</span>
    <span class="${net>=0?'net-pos':'net-neg'}">נטו: ${formatCurrency(net)}</span>
    ${categoryBalanceInfo}
    ${runningBalanceInfo}
    ${recurringInfo}`

  // Select-mode toolbar — toggling enables checkbox column + merge action.
  _renderTxSelectToolbar(filtered.length)

  const page = filtered.slice(_txPage * TX_PAGE_SIZE, (_txPage+1) * TX_PAGE_SIZE)
  const totalPages = Math.ceil(filtered.length / TX_PAGE_SIZE)

  const TYPE_LABEL = { income:'הכנסה', expense:'הוצאה', transfer:'העברה', refund:'החזר' }
  const TYPE_CLS = { income:'type-income', expense:'type-expense', transfer:'type-transfer', refund:'type-refund' }

  // Refund ↔ expense links: map expenseId → total refunded, and refundId → expense.
  const _allTx = getTransactions()
  const _refundedByExpense = {}
  const _txById = {}
  _allTx.forEach(t => { _txById[t.id] = t })
  _allTx.forEach(t => { if (t.refundForTxId) _refundedByExpense[t.refundForTxId] = (_refundedByExpense[t.refundForTxId] || 0) + Math.abs(t.amount) })

  // Compute running balance (only when single account filtered)
  // We need to compute balance at each row. Since table is date desc, we:
  // - get balance up to & including each row's date (but only for transactions on/before that row)
  let rowBalances = {}
  if (showRunningBalance) {
    // Include mirror-side txs (CC payments from bank / deposits to savings)
    // so the running balance reconciles with getAccountBalance.
    const accTxs = getTransactions().filter(t =>
      t.accountId === accountId
      || t.ccPaymentForAccountId === accountId
      || t.transferAccountId === accountId
    ).sort((a,b) => (a.date||'').localeCompare(b.date||''))
    let run = acc?.openingBalance || 0
    for (const t of accTxs) {
      run += _txViewAmount(t, accountId)
      rowBalances[t.id] = run
    }
  }

  const selectColHead = _txSelectMode ? '<th style="width:32px"><input type="checkbox" id="txSelectAll" onclick="toggleTxSelectAll(this.checked)"></th>' : ''
  const colspan = (showRunningBalance ? 8 : 7) + (_txSelectMode ? 1 : 0)

  document.getElementById('txTable').innerHTML = `
    <table class="data-table tx-table">
      <thead><tr>
        ${selectColHead}
        <th>ספק / קטגוריה</th>
        <th>תאריך</th><th>חודש חיוב</th>
        <th>סכום</th><th>סוג</th>
        ${showRunningBalance ? '<th>יתרה</th>' : ''}
        <th>הערות</th><th></th>
      </tr></thead>
      <tbody>
      ${page.length === 0 ? `<tr><td colspan="${colspan}">${emptyStateHTML({
          icon: '🧾',
          title: 'אין עסקאות להצגה',
          text: 'ייבא דוח או הוסף עסקה ידנית. אם הגדרת סינון — נסה לנקות אותו.',
          actions: [
            { label: 'הוסף עסקה', onclick: 'addManualTransaction()', primary: true },
            { label: 'ייבוא קובץ', onclick: "navigate('import')" },
          ],
        })}</td></tr>` :
        page.map(tx => {
          const cat = getCategoryById(tx.categoryId)
          const isMirror = _txIsMirrorFor(tx, accountId)
          const dispAmt = isMirror ? -tx.amount : tx.amount
          const isNonCounted = tx.type === 'transfer' || tx.type === 'refund'
          const amountCls = isNonCounted ? 'amount-muted' : (dispAmt>0?'amount-inc':'amount-exp')
          const balCell = showRunningBalance ? `<td class="tx-cell-sec" style="font-weight:500">${formatCurrency(rowBalances[tx.id] ?? 0)}</td>` : ''
          const mirrorLabel = isMirror
            ? (tx.ccPaymentForAccountId === accountId ? 'תשלום לכרטיס' : 'הפקדה')
            : null
          const typeBadge = mirrorLabel
            ? `<span class="type-badge type-transfer" title="עסקה מחשבון אחר שמשפיעה על היתרה">${mirrorLabel}</span>`
            : `<span class="type-badge ${TYPE_CLS[tx.type]||'type-expense'}">${TYPE_LABEL[tx.type]||tx.type}</span>`
          const effMonth = getTxEffectiveMonth(tx)
          const effMonthDisplay = effMonth ? effMonth.slice(5) + '/' + effMonth.slice(0,4) : '—'
          const effMonthMismatch = effMonth && tx.date && effMonth !== tx.date.slice(0,7)
          const effCell = `<td class="tx-cell-sec" style="font-size:.8rem;color:${effMonthMismatch?'var(--accent)':'var(--text-muted)'}">${effMonthDisplay}</td>`
          const recurringFlagBadge = tx.recurringFlag
            ? `<span class="type-badge type-refund" title="מסומן כקבוע (${recurringCadenceLabel(tx.recurringFlag)})" style="margin-inline-start:.3rem">🔁 ${recurringCadenceLabel(tx.recurringFlag)}</span>`
            : ''
          const installmentBadge = (tx.installmentCurrent && tx.installmentTotal)
            ? (() => {
                const fm = tx.installmentFinalMonth || ''
                const fmDisp = fm ? (fm.slice(5) + '/' + fm.slice(0,4)) : ''
                const title = `תשלום ${tx.installmentCurrent} מתוך ${tx.installmentTotal}${fmDisp?` · חודש חיוב אחרון ${fmDisp}`:''}`
                return `<span class="type-badge type-transfer" title="${title}" style="margin-inline-start:.3rem">💳 ${tx.installmentCurrent}/${tx.installmentTotal}</span>`
              })()
            : ''
          const standingOrderBadge = tx.standingOrder
            ? `<span class="type-badge type-income" title="הוראת קבע" style="margin-inline-start:.3rem">📌 ה.ק.</span>`
            : ''
          const groupBadge = tx.recurringGroupId && typeof getManualRecurringGroups === 'function'
            ? (() => {
                const grp = getManualRecurringGroups().find(g => g.id === tx.recurringGroupId)
                if (!grp) return ''
                return `<span class="type-badge type-transfer" title="חלק מקבוצת קבועה: ${escAttr(grp.label)}" style="margin-inline-start:.3rem;cursor:pointer" onclick="event.stopPropagation();openRecurringDrill('mgroup:${grp.id}')">🔗 ${escHtml(grp.label)}</span>`
              })()
            : ''
          const selectCell = _txSelectMode
            ? `<td onclick="event.stopPropagation()"><input type="checkbox" ${_txSelected.has(tx.id)?'checked':''} onclick="toggleTxSelected('${tx.id}')"></td>`
            : ''
          const avatarBg = cat ? cat.color + '22' : 'rgba(100,116,139,.15)'
          const avatarIcon = cat ? (catIconHTML(cat, 18) || '📋') : '📋'
          const catLabel = cat
            ? `<span class="tx-vendor-cat cat-badge-clickable" onclick="event.stopPropagation();openTxCategoryPicker('${tx.id}')" title="שנה קטגוריה" style="color:${cat.color}">${catIconHTML(cat)} ${escHtml(cat.name)} ▾</span>`
            : `<span class="tx-vendor-cat cat-badge-clickable cat-badge-add" onclick="event.stopPropagation();openTxCategoryPicker('${tx.id}')" title="הוסף קטגוריה" style="color:var(--text-muted)">+ סווג</span>`
          const vendorName = escHtml(resolveVendor(tx.vendor, tx.amount, getTxAliasDay(tx)) || '—')
          const descLine = tx.description && tx.description !== tx.vendor
            ? `<div style="font-size:.72rem;color:var(--text-muted);margin-top:.1rem">${escHtml(tx.description)}</div>` : ''
          // Refund ↔ expense traceability.
          let refundLine = ''
          if (tx.refundForTxId && _txById[tx.refundForTxId]) {
            const e = _txById[tx.refundForTxId]
            const ev = resolveVendor(e.vendor, e.amount, getTxAliasDay(e)) || e.vendor || '—'
            refundLine = `<div style="font-size:.72rem;color:var(--accent);margin-top:.1rem">↩ החזר עבור: ${escHtml(ev)}</div>`
          } else if (_refundedByExpense[tx.id]) {
            refundLine = `<div style="font-size:.72rem;color:var(--income);margin-top:.1rem">↩ הוחזר ${formatCurrency(_refundedByExpense[tx.id])}</div>`
          }
          return `<tr ${isNonCounted||isMirror?'class="tx-noncounted"':''}>
            ${selectCell}
            <td class="tx-cell-main">
              <div class="tx-vendor-cell" data-id="${tx.id}">
                <div class="tx-avatar" style="background:${avatarBg}">${avatarIcon}</div>
                <div>
                  <div class="tx-vendor-name">${vendorName}${recurringFlagBadge}${installmentBadge}${standingOrderBadge}${groupBadge}</div>
                  ${catLabel}${descLine}${refundLine}
                  <div class="tx-meta-mobile">${formatDate(tx.date)} · ${typeBadge}</div>
                </div>
              </div>
            </td>
            <td class="tx-cell-sec" style="font-size:.85rem;color:var(--text-secondary)">${formatDate(tx.date)}</td>
            ${effCell}
            <td class="${amountCls} tx-cell-amount">${_richAmount(dispAmt)}</td>
            <td class="tx-cell-sec">${typeBadge}</td>
            ${balCell}
            <td class="tx-cell-sec" style="color:var(--text-muted);font-size:.8rem">${escHtml(tx.notes||'')}</td>
            <td class="tx-cell-edit"><button class="edit-btn" onclick="openEditModal('${tx.id}')">✏️</button></td>
          </tr>`
        }).join('')}
      </tbody>
    </table>`

  _wireTxSwipe()

  // Pagination
  const pag = document.getElementById('txPagination')
  if (totalPages <= 1) { pag.innerHTML = ''; return }
  pag.innerHTML = `
    <button class="btn-ghost" onclick="_txPage=Math.max(0,_txPage-1);_drawTxTable()" ${_txPage===0?'disabled':''}>הקודם</button>
    <span class="page-info">${_txPage+1} / ${totalPages}</span>
    <button class="btn-ghost" onclick="_txPage=Math.min(${totalPages-1},_txPage+1);_drawTxTable()" ${_txPage===totalPages-1?'disabled':''}>הבא</button>`
}

// Click-to-filter from a category badge inside the table.
function filterTxByCategory(catId) {
  const sel = document.getElementById('txCategoryFilter')
  if (!sel) return
  sel.value = catId
  _txPage = 0
  _drawTxTable()
}

// ===== BULK-SELECT + MERGE-TO-RECURRING =====
function toggleTxSelectMode() {
  _txSelectMode = !_txSelectMode
  if (!_txSelectMode) _txSelected.clear()
  _drawTxTable()
}

function toggleTxSelected(id) {
  if (_txSelected.has(id)) _txSelected.delete(id)
  else _txSelected.add(id)
  _renderTxSelectToolbar()
}

function toggleTxSelectAll(checked) {
  const filtered = _getFiltered()
  const page = filtered.slice(_txPage * TX_PAGE_SIZE, (_txPage+1) * TX_PAGE_SIZE)
  page.forEach(t => { if (checked) _txSelected.add(t.id); else _txSelected.delete(t.id) })
  _drawTxTable()
}

function _renderTxSelectToolbar(_filteredCount) {
  const el = document.getElementById('txSelectToolbar')
  if (!el) return
  if (!_txSelectMode) {
    el.innerHTML = `
      <button class="btn-ghost" onclick="toggleTxSelectMode()" style="font-size:.85rem">📦 בחר לקיבוץ</button>`
    return
  }
  const n = _txSelected.size
  el.innerHTML = `
    <button class="btn-ghost" onclick="toggleTxSelectMode()" style="font-size:.85rem">בטל בחירה</button>
    <span style="color:var(--text-muted);font-size:.85rem">${n} נבחרו</span>
    <button class="btn-ghost" ${n<1?'disabled':''} onclick="bulkRecategorize()" style="font-size:.85rem">🏷️ סווג</button>
    <button class="btn-ghost" ${n<1?'disabled':''} onclick="bulkExportCsv()" style="font-size:.85rem">⬇️ CSV</button>
    <button class="btn-danger" ${n<1?'disabled':''} onclick="bulkDelete()" style="font-size:.85rem">🗑️ מחק</button>
    <button class="btn-primary" ${n<2?'disabled':''} onclick="openMergeRecurringModal()" style="font-size:.85rem">אחד לקבועה</button>`
}

// ===== INLINE CATEGORIZE =====
// Quick category change straight from the list (no edit modal). On select,
// offers an undoable "apply to similar uncategorized" toast via propagateCategoryToSimilar.
let _txCatPickHandler = null
let _txCatPickSheet = null

function openTxCategoryPicker(txId, onPick) {
  const cats = getCategories()
  const expCats = cats.filter(c => c.type === 'expense')
  const incCats = cats.filter(c => c.type === 'income')
  const btn = c => `<button class="cat-pick-btn" onclick="_txPickCat('${c.id}')" style="--cc:${c.color}">${catIconHTML(c)} <span>${escHtml(c.name)}</span></button>`
  const html = `
    <input id="catPickSearch" class="cat-pick-search" placeholder="חיפוש קטגוריה..." oninput="_filterCatPick(this.value)">
    <div class="cat-pick-grid" id="catPickGrid">
      <div class="cat-pick-section">הוצאות</div>${expCats.map(btn).join('')}
      <div class="cat-pick-section">הכנסות</div>${incCats.map(btn).join('')}
      <button class="cat-pick-btn cat-pick-none" onclick="_txPickCat('')">— הסר קטגוריה —</button>
    </div>`
  _txCatPickHandler = onPick || (catId => setTxCategory(txId, catId))
  _txCatPickSheet = (typeof UK_sheet === 'function') ? UK_sheet({ title: 'בחר קטגוריה', content: html }) : null
}

function _txPickCat(catId) {
  const h = _txCatPickHandler, s = _txCatPickSheet
  _txCatPickHandler = null; _txCatPickSheet = null
  if (s) s.close()
  if (h) h(catId)
}

function _filterCatPick(term) {
  term = (term || '').trim().toLowerCase()
  document.querySelectorAll('#catPickGrid .cat-pick-btn').forEach(b => {
    if (b.classList.contains('cat-pick-none')) return
    b.style.display = (!term || b.textContent.toLowerCase().includes(term)) ? '' : 'none'
  })
}

function setTxCategory(txId, catId) {
  const txs = getTransactions()
  const tx = txs.find(t => t.id === txId)
  if (!tx) return
  tx.categoryId = catId || ''
  DB.set('finTransactions', txs)
  if (typeof UK_haptic === 'function') UK_haptic('tap')
  _drawTxTable()
  if (typeof renderDashboard === 'function' && typeof _currentScreen !== 'undefined' && _currentScreen === 'dashboard') renderDashboard()
  const cat = catId ? getCategoryById(catId) : null
  const label = cat ? cat.name : 'ללא קטגוריה'
  let similar = 0
  if (catId && tx.vendor && typeof normalizeVendorForAutocat === 'function') {
    const target = normalizeVendorForAutocat(tx.vendor)
    similar = txs.filter(t => t.id !== txId && !t.categoryId && t.type !== 'transfer' && t.vendor && normalizeVendorForAutocat(t.vendor) === target).length
  }
  if (similar > 0) {
    toast(`סווג כ-${label}`, { type: 'success', action: { label: `החל על ${similar} דומות`, onClick: () => {
      const all = getTransactions()
      const n = propagateCategoryToSimilar(all, tx.vendor, catId, txId)
      DB.set('finTransactions', all)
      _drawTxTable()
      toast(`סווגו ${n} עסקאות דומות`, { type: 'success' })
    } } })
  } else {
    toast(`סווג כ-${label}`, { type: 'success' })
  }
}

// ===== BULK ACTIONS =====
async function bulkDelete() {
  const ids = [..._txSelected]
  if (!ids.length) return
  if (!await confirmDialog(`למחוק ${ids.length} עסקאות?`, { danger: true, confirmText: 'מחק' })) return
  const snapshot = getTransactions().slice()
  DB.set('finTransactions', getTransactions().filter(t => !_txSelected.has(t.id)))
  _txSelected.clear(); _txSelectMode = false
  _drawTxTable(); _renderTxSelectToolbar()
  if (typeof renderDashboard === 'function') renderDashboard()
  toast(`${ids.length} עסקאות נמחקו`, { type: 'success', action: { label: 'בטל', onClick: () => {
    DB.set('finTransactions', snapshot); _drawTxTable(); if (typeof renderDashboard === 'function') renderDashboard()
  } } })
}

function bulkRecategorize() {
  if (!_txSelected.size) return
  openTxCategoryPicker(null, catId => {
    const txs = getTransactions()
    let n = 0
    txs.forEach(t => { if (_txSelected.has(t.id) && t.categoryId !== (catId || '')) { t.categoryId = catId || ''; n++ } })
    DB.set('finTransactions', txs)
    _txSelected.clear(); _txSelectMode = false
    _drawTxTable(); _renderTxSelectToolbar()
    if (typeof renderDashboard === 'function') renderDashboard()
    const cat = catId ? getCategoryById(catId) : null
    toast(`${n} עסקאות סווגו כ-${cat ? cat.name : 'ללא קטגוריה'}`, { type: 'success' })
  })
}

function bulkExportCsv() {
  const rows = getTransactions().filter(t => _txSelected.has(t.id))
  if (!rows.length) return
  _exportTxToCsv(rows, 'transactions_selected.csv')
}

// Lightweight CSV (BOM for Excel Hebrew) — distinct from reports.js exportExcel()
// which dumps the full dataset; this exports an arbitrary row subset.
function _exportTxToCsv(rows, filename) {
  const headers = ['תאריך', 'ספק', 'קטגוריה', 'סכום', 'סוג', 'הערות']
  const esc = v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }
  const lines = [headers.join(',')]
  rows.forEach(t => {
    const cat = getCategoryById(t.categoryId)
    lines.push([
      formatDate(t.date),
      resolveVendor(t.vendor, t.amount, getTxAliasDay(t)) || t.vendor || '',
      cat ? cat.name : '',
      t.amount,
      t.type || '',
      t.notes || '',
    ].map(esc).join(','))
  })
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast(`יוצאו ${rows.length} עסקאות ל-CSV`, { type: 'success' })
}

// ===== MOBILE SWIPE ACTIONS =====
// Attach RTL-aware swipe to each row's vendor cell (touch only). Swipe toward the
// inline-end → actions sheet (edit/categorize/delete); toward start → quick categorize.
function _wireTxSwipe() {
  if (typeof UK_onSwipe !== 'function') return
  if (!matchMedia('(max-width:768px)').matches) return
  document.querySelectorAll('#txTable .tx-vendor-cell[data-id]').forEach(cell => {
    const id = cell.dataset.id
    UK_onSwipe(cell, {
      onEnd: () => _openTxSwipeActions(id),
      onStart: () => openTxCategoryPicker(id),
    })
  })
}

function _openTxSwipeActions(id) {
  if (typeof UK_sheet !== 'function') { openEditModal(id); return }
  UK_sheet({
    title: 'פעולות',
    actions: [
      { label: '✏️ ערוך', onClick: () => { openEditModal(id) } },
      { label: '🏷️ סווג', onClick: () => { openTxCategoryPicker(id) } },
      { label: '🗑️ מחק', className: 'btn-danger', onClick: () => { _deleteTxById(id) } },
    ],
  })
}

async function _deleteTxById(id) {
  if (!await confirmDialog('למחוק עסקה זו?', { danger: true, confirmText: 'מחק' })) return
  const snapshot = getTransactions().find(t => t.id === id)
  DB.set('finTransactions', getTransactions().filter(t => t.id !== id))
  _drawTxTable()
  if (typeof renderDashboard === 'function') renderDashboard()
  toast('העסקה נמחקה', { type: 'success', action: snapshot ? { label: 'בטל', onClick: () => {
    const cur = getTransactions()
    if (!cur.some(t => t.id === id)) { cur.push(snapshot); DB.set('finTransactions', cur) }
    _drawTxTable(); if (typeof renderDashboard === 'function') renderDashboard()
  } } : null })
}

function openMergeRecurringModal() {
  if (_txSelected.size < 2) { toast('בחר לפחות שתי עסקאות לאיחוד', { type: 'error' }); return }
  const ids = [...(_txSelected)]
  const txs = getTransactions().filter(t => ids.includes(t.id))
  const defaultLabel = (txs[0] ? resolveVendor(txs[0].vendor || '', txs[0].amount, getTxAliasDay(txs[0])) : '') || txs[0]?.vendor || 'קבועה ידנית'
  const sumAmount = txs.reduce((s,t) => s + (t.amount || 0), 0)
  const allSameSign = txs.every(t => (t.amount || 0) * (txs[0].amount || 0) >= 0)

  document.getElementById('mergeRecurringBody').innerHTML = `
    <div class="modal-row" style="font-size:.85rem;color:var(--text-muted)">
      ${ids.length} עסקאות · סך ${formatCurrency(sumAmount)} ${allSameSign?'':'<span style="color:var(--expense)">⚠ סימני סכום מעורבים</span>'}
    </div>
    <div class="modal-row">
      <label class="form-label">תווית הקבוצה</label>
      <input id="mergeLabel" value="${defaultLabel.replace(/"/g, '&quot;')}">
    </div>
    <div class="modal-row">
      <label class="form-label">תדירות</label>
      <select id="mergeCadence">
        <option value="monthly">חודשי</option>
        <option value="bimonthly">דו-חודשי</option>
        <option value="quarterly">רבעוני</option>
      </select>
    </div>
    <div class="modal-row" style="font-size:.78rem;color:var(--text-muted)">
      העסקאות יישארו במסך העסקאות עם חיווי קישור (🔗) ויוצגו במסך הקבועות כפעולה אחת מאוחדת.
      כל עסקה קיימת או עתידית מאותם ספקים תצורף אוטומטית לקבוצה — אין צורך לאחד שוב בכל חודש.
    </div>`
  document.getElementById('mergeRecurringModal').classList.add('open')
}

function closeMergeRecurringModal() {
  document.getElementById('mergeRecurringModal').classList.remove('open')
}

function confirmMergeRecurring() {
  const label = document.getElementById('mergeLabel').value.trim()
  const cadence = document.getElementById('mergeCadence').value
  if (!label) { toast('יש להזין תווית לקבוצה', { type: 'error' }); return }
  if (_txSelected.size < 2) { toast('בחר לפחות שתי עסקאות', { type: 'error' }); return }
  const res = createManualRecurringGroup({ label, cadence, txIds: [..._txSelected] })
  if (!res) { toast('נכשל ביצירת הקבוצה', { type: 'error' }); return }
  _txSelected.clear()
  _txSelectMode = false
  closeMergeRecurringModal()
  _drawTxTable()
  toast(`נוצרה קבוצה קבועה "${label}" עם ${res.count} עסקאות`, { type: 'success' })
}
