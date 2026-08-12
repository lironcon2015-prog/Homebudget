// ===== MOBILE TRANSACTIONS (Dark Glass) =====
// Owns the #screen-transactions markup on mobile: card list + sticky search +
// type chips + filter sheet + load-more, with swipe actions. Reuses the desktop
// ENGINE/state helpers as-is: _getFiltered(), _buildTx*Filter(), openEditModal(),
// openTxCategoryPicker(), _openTxSwipeActions(), _renderTxSelectToolbar(),
// _deleteTxById(). The canonical filter inputs (#txSearch, #txTypeFilter,
// #txAccountFilter…) are kept live in a hidden stash so _getFiltered works
// unchanged; the filter sheet just relocates that stash node temporarily.
let M_txLimit = 30
let M_txFilterSheet = null

function M_renderTransactions() {
  const host = document.getElementById('screen-transactions')
  if (!host) return
  M_txLimit = 30
  if (typeof _txConsumeBack === 'function') _txConsumeBack()

  host.innerHTML = `
    ${(typeof _txBackBarHTML === 'function') ? _txBackBarHTML() : ''}
    ${M_topbar('עסקאות', `
      <button class="m-iconbtn" onclick="runAutoCategorize()" title="סווג אוטומטית" aria-label="סווג אוטומטית">${uiIcon('refresh', 17)}</button>
      <button class="m-iconbtn m-iconbtn-ai" onclick="runGeminiCategorize()" title="סווג עם AI" aria-label="סווג עם AI">${uiIcon('sparkles', 17)}</button>
    `)}
    <div id="mtxPeriod" class="m-period"></div>

    <div class="m-search-row">
      <div class="m-search"><span>${uiIcon('search', 15)}</span>
        <input id="txSearch" placeholder="חיפוש ספק או תיאור…" oninput="M_txReset()">
      </div>
      <button class="m-filter-btn" id="mTxFilterBtn" onclick="M_openTxFilters()" aria-label="מסננים">${uiIcon('gear', 16)}</button>
    </div>

    <div class="m-typechips" id="mTxTypeChips">
      ${[['all', 'הכל'], ['expense', 'הוצאות'], ['income', 'הכנסות'], ['uncategorized', 'לא מסווג']]
        .map(([v, l]) => `<button class="m-chip-btn" data-type="${v}" onclick="M_setTxType('${v}')">${l}</button>`).join('')}
    </div>

    <div id="txSelectToolbar" class="m-select-toolbar"></div>
    <div id="txSummary" class="m-tx-summary"></div>
    <div id="txTable" class="m-tx-card m-card"></div>
    <div id="txPagination" class="m-pagination"></div>

    <!-- live filter inputs (hidden stash so _getFiltered keeps working; the
         filter sheet relocates this node while open) -->
    <div id="mTxStash" class="m-stash">
      <select id="txTypeFilter" class="m-hidden-input">
        <option value="all">הכל</option><option value="income">הכנסות</option>
        <option value="expense">הוצאות</option><option value="transfer">העברות</option>
        <option value="refund">החזרים</option><option value="uncategorized">לא מסווג</option>
      </select>
      <label class="form-label">חשבון</label>
      <select id="txAccountFilter" onchange="M_txReset()"></select>
      <label class="form-label">קטגוריה</label>
      <select id="txCategoryFilter" onchange="M_txReset()"></select>
      <select id="txFlowFilter" onchange="M_txReset()"></select>
      <label class="form-label">טווח סכום (₪)</label>
      <div class="m-amt-range">
        <input id="txAmountMin" inputmode="decimal" placeholder="מ-" oninput="M_txReset()">
        <input id="txAmountMax" inputmode="decimal" placeholder="עד" oninput="M_txReset()">
      </div>
      <label class="m-check"><input type="checkbox" id="txInstallmentFilter" onchange="M_txReset()"> תשלומים בלבד</label>
      <label class="m-check"><input type="checkbox" id="txStandingOrderFilter" onchange="M_txReset()"> הוראות קבע בלבד</label>
    </div>
  `

  M_renderPeriodBar('mtxPeriod', () => M_txReset())
  _buildTxAccountFilter()
  _buildTxCategoryFilter()
  _buildTxFlowFilter()
  M_syncTypeChips()
  _drawTxTable()
  if (typeof M_syncTabs === 'function') M_syncTabs('transactions')
  if (typeof M_repaintSync === 'function') M_repaintSync()
}

function M_txReset() {
  M_txLimit = 30
  M_syncTypeChips()
  _drawTxTable()
}

function M_setTxType(v) {
  const sel = document.getElementById('txTypeFilter')
  if (sel) sel.value = v
  M_txReset()
}

function M_syncTypeChips() {
  const cur = document.getElementById('txTypeFilter')?.value || 'all'
  document.querySelectorAll('#mTxTypeChips .m-chip-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === cur))
  // reflect active advanced/filters on the funnel button
  const n = (document.getElementById('txAccountFilter')?.value ? 1 : 0)
    + (document.getElementById('txCategoryFilter')?.value ? 1 : 0)
    + (document.getElementById('txFlowFilter')?.value ? 1 : 0)
    + (document.getElementById('txAmountMin')?.value ? 1 : 0)
    + (document.getElementById('txAmountMax')?.value ? 1 : 0)
    + (document.getElementById('txInstallmentFilter')?.checked ? 1 : 0)
    + (document.getElementById('txStandingOrderFilter')?.checked ? 1 : 0)
  const btn = document.getElementById('mTxFilterBtn')
  if (btn) { btn.classList.toggle('has-active', n > 0); btn.innerHTML = uiIcon('gear', 16) + (n > 0 ? ` ${n}` : '') }
}

// Mobile redraw — replaces desktop _drawTxTable via the mobile guard.
function M_drawTxList() {
  const filtered = _getFiltered()
  // Mirror-side rows flip sign when a single account is filtered — same
  // perspective as the desktop summary (_txViewAmount).
  const accountId = document.getElementById('txAccountFilter')?.value || ''
  const viewAmt = t => (typeof _txViewAmount === 'function') ? _txViewAmount(t, accountId) : t.amount
  const nonTransfer = filtered.filter(t => t.type !== 'transfer')
  const totalInc = nonTransfer.filter(t => viewAmt(t) > 0).reduce((s, t) => s + viewAmt(t), 0)
  const totalExp = nonTransfer.filter(t => viewAmt(t) < 0).reduce((s, t) => s + Math.abs(viewAmt(t)), 0)
  const net = totalInc - totalExp

  const sum = document.getElementById('txSummary')
  if (sum) sum.innerHTML = `
    <div class="m-sum-chip"><span class="m-muted">${filtered.length} עסקאות</span></div>
    <div class="m-sum-chip"><span class="pos">+${formatCurrency(totalInc)}</span></div>
    <div class="m-sum-chip"><span class="neg">−${formatCurrency(totalExp)}</span></div>
    <div class="m-sum-chip"><span class="${net >= 0 ? 'pos' : 'neg'}">נטו ${formatCurrency(net)}</span></div>`

  _renderTxSelectToolbar(filtered.length)

  const list = document.getElementById('txTable')
  if (!list) return
  if (filtered.length === 0) {
    list.innerHTML = emptyStateHTML({
      icon: uiIcon('receipt', 30, 'var(--text-muted)'), title: 'אין עסקאות להצגה',
      text: 'ייבא דוח או הוסף עסקה ידנית. אם הגדרת סינון — נסה לנקות אותו.',
      actions: [{ label: 'הוסף עסקה', onclick: 'addManualTransaction()', primary: true }, { label: 'ייבוא קובץ', onclick: "navigate('import')" }],
    })
    document.getElementById('txPagination').innerHTML = ''
    return
  }
  const shown = filtered.slice(0, M_txLimit)
  list.innerHTML = shown.map(tx => M_txListRow(tx)).join('')
  M_wireTxCardSwipe()

  const pag = document.getElementById('txPagination')
  if (pag) pag.innerHTML = filtered.length > M_txLimit
    ? `<button class="m-loadmore" onclick="M_txLimit+=30;_drawTxTable()">טען עוד (${filtered.length - M_txLimit})</button>`
    : ''
}

function M_txListRow(tx) {
  const checkbox = _txSelectMode
    ? `<input type="checkbox" class="m-tx-check" ${_txSelected.has(tx.id) ? 'checked' : ''} onclick="event.stopPropagation();toggleTxSelected('${tx.id}')">`
    : ''
  // badges (installment / standing order / recurring group) — compact
  let badges = ''
  if (tx.installmentCurrent && tx.installmentTotal) badges += `<span class="m-badge">${uiIcon('card', 11)} ${tx.installmentCurrent}/${tx.installmentTotal}</span>`
  if (tx.standingOrder) badges += `<span class="m-badge" title="הוראת קבע">${uiIcon('pin', 11)}</span>`
  const cat = getCategoryById(tx.categoryId)
  const isNonCounted = tx.type === 'transfer'
  const cls = isNonCounted ? 'm-muted' : (tx.type === 'refund' && tx.amount > 0) ? 'ref' : (tx.amount > 0 ? 'pos' : 'neg')
  const name = escHtml(resolveVendor(tx.vendor, tx.amount, getTxAliasDay(tx)) || tx.description || '—')
  const sign = tx.amount > 0 ? '+' : ''
  const avatar = (typeof UK_vendorAvatar === 'function') ? UK_vendorAvatar(tx, { size: 42 }) : `<div class="tx-avatar">${uiIcon('file', 18)}</div>`
  return `<div class="m-tx-row" data-id="${tx.id}" onclick="openEditModal('${tx.id}')">
    ${checkbox}${avatar}
    <div class="m-tx-mid">
      <div class="m-tx-name">${name} ${badges}</div>
      <div class="m-tx-sub" onclick="event.stopPropagation();openTxCategoryPicker('${tx.id}')">${formatDate(tx.date)} · ${cat ? escHtml(cat.name) + ' ▾' : '+ סווג'}</div>
    </div>
    <div class="m-tx-amt ${cls}">${sign}${formatCurrency(tx.amount)}</div>
  </div>`
}

function M_wireTxCardSwipe() {
  if (typeof UK_onSwipe !== 'function') return
  document.querySelectorAll('#txTable .m-tx-row[data-id]').forEach(row => {
    const id = row.dataset.id
    UK_onSwipe(row, {
      onEnd: () => (typeof _openTxSwipeActions === 'function' ? _openTxSwipeActions(id) : openEditModal(id)),
      onStart: () => openTxCategoryPicker(id),
    })
  })
}

// Filter sheet — self-contained UI built fresh from the hidden stash's current
// values; changes write back to the stash inputs so _getFiltered() keeps working.
function M_openTxFilters() {
  if (typeof UK_sheet !== 'function') return
  const val = id => (document.getElementById(id)?.value || '')
  const chk = id => !!document.getElementById(id)?.checked
  const accSel = document.getElementById('txAccountFilter')
  const catSel = document.getElementById('txCategoryFilter')
  const flowSel = document.getElementById('txFlowFilter')
  const hasFlow = flowSel && flowSel.options.length > 1
  const html = `
    <div class="m-filter-form">
      <label class="m-filter-label">חשבון</label>
      <select class="m-filter-select" onchange="M_filterSet('txAccountFilter',this.value)">${accSel ? accSel.innerHTML : ''}</select>
      <label class="m-filter-label">קטגוריה</label>
      <select class="m-filter-select" onchange="M_filterSet('txCategoryFilter',this.value)">${catSel ? catSel.innerHTML : ''}</select>
      ${hasFlow ? `<label class="m-filter-label">תזרים חיסכון/השקעות</label>
      <select class="m-filter-select" onchange="M_filterSet('txFlowFilter',this.value)">${flowSel.innerHTML}</select>` : ''}
      <label class="m-filter-label">טווח סכום (₪)</label>
      <div class="m-amt-range">
        <input class="m-filter-select" inputmode="decimal" placeholder="מ-" value="${val('txAmountMin')}" oninput="M_filterSet('txAmountMin',this.value)">
        <input class="m-filter-select" inputmode="decimal" placeholder="עד" value="${val('txAmountMax')}" oninput="M_filterSet('txAmountMax',this.value)">
      </div>
      <label class="m-check"><input type="checkbox" ${chk('txInstallmentFilter') ? 'checked' : ''} onchange="M_filterChk('txInstallmentFilter',this.checked)"> תשלומים בלבד</label>
      <label class="m-check"><input type="checkbox" ${chk('txStandingOrderFilter') ? 'checked' : ''} onchange="M_filterChk('txStandingOrderFilter',this.checked)"> הוראות קבע בלבד</label>
    </div>`
  M_txFilterSheet = UK_sheet({
    title: 'סינון',
    content: html,
    actions: [
      { label: 'נקה הכל', onClick: () => { M_clearTxFilters() } },
      { label: 'הצג תוצאות', primary: true },
    ],
  })
}

function M_filterSet(id, v) { const el = document.getElementById(id); if (el) el.value = v; M_txReset() }
function M_filterChk(id, c) { const el = document.getElementById(id); if (el) el.checked = c; M_txReset() }

function M_clearTxFilters() {
  ;['txAccountFilter', 'txCategoryFilter', 'txFlowFilter', 'txAmountMin', 'txAmountMax'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = ''
  })
  ;['txInstallmentFilter', 'txStandingOrderFilter'].forEach(id => {
    const el = document.getElementById(id); if (el) el.checked = false
  })
  const t = document.getElementById('txTypeFilter'); if (t) t.value = 'all'
  M_txReset()
}
