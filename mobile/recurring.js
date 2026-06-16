// ===== MOBILE RECURRING (Dark Glass) =====
// Native card list for #screen-recurring (desktop renders a 7-col table that
// scrolls sideways on mobile). Reuses the engine + state verbatim: getAllRecurring,
// recurringMonthlyTotals, the _recKeyMap idx map and the existing drill/hide/
// toggle handlers. renderRecurring() delegates here via the IS_MOBILE_UI guard,
// so every toggle (flow mode / installments / show-hidden) re-renders natively.
function M_renderRecurring() {
  const host = document.getElementById('screen-recurring')
  if (!host) return
  const items = getAllRecurring()
  const hidden = getHiddenRecurring()
  const expenseItems = items.filter(r => r.smoothedMonthly < 0)
  const incomeItems  = items.filter(r => r.smoothedMonthly > 0)
  const installmentCount = items.filter(_isInstallmentEntry).length
  let bucket = _recFlowMode === 'income' ? incomeItems : expenseItems
  if (_recInstallmentsOnly) bucket = bucket.filter(_isInstallmentEntry)
  const visible    = bucket.filter(r => !hidden.has(r.key))
  const hiddenList = bucket.filter(r =>  hidden.has(r.key))
  const totals = recurringMonthlyTotals()

  // Rebuild the idx→key map over ALL items so the shared *ByIdx handlers work.
  _recKeyMap = {}
  items.forEach((r, i) => { _recKeyMap['k' + i] = r.key })
  const idxOf = r => Object.keys(_recKeyMap).find(k => _recKeyMap[k] === r.key)

  const modeLabel = _recFlowMode === 'income' ? 'הכנסות' : 'הוצאות'

  host.innerHTML = `
    ${M_topbar('קבועות')}
    <div class="m-stat-grid" style="grid-template-columns:1fr 1fr 1fr">
      <div class="m-stat"><div class="m-stat-label">הוצאות</div><div class="m-stat-val neg">${formatCurrency(totals.expense)}</div></div>
      <div class="m-stat"><div class="m-stat-label">הכנסות</div><div class="m-stat-val pos">${formatCurrency(totals.income)}</div></div>
      <div class="m-stat"><div class="m-stat-label">נטו</div><div class="m-stat-val ${totals.net >= 0 ? 'pos' : 'neg'}">${formatCurrency(totals.net)}</div></div>
    </div>

    <div class="m-typechips">
      <button class="m-chip-btn ${_recFlowMode === 'expense' ? 'active' : ''}" onclick="setRecurringFlowMode('expense')">📉 הוצאות ${expenseItems.length}</button>
      <button class="m-chip-btn ${_recFlowMode === 'income' ? 'active' : ''}" onclick="setRecurringFlowMode('income')">📈 הכנסות ${incomeItems.length}</button>
      ${installmentCount > 0 ? `<button class="m-chip-btn ${_recInstallmentsOnly ? 'active' : ''}" onclick="toggleRecurringInstallmentsOnly()">💳 תשלומים</button>` : ''}
      ${hiddenList.length > 0 ? `<button class="m-chip-btn ${_recShowHidden ? 'active' : ''}" onclick="toggleShowHiddenRecurring()">👁 מוסתרות ${hiddenList.length}</button>` : ''}
    </div>

    ${items.length === 0
      ? '<p class="m-empty-line" style="padding:2.5rem 1rem">לא זוהו קבועות. נדרשות לפחות 3 עסקאות חוזרות לאותו ספק, או סמן עסקה ידנית.</p>'
      : `<div class="m-card m-tx-card" id="mRecList">${
          visible.length === 0
            ? `<p class="m-empty-line">אין ${modeLabel} קבועות${bucket.length > 0 ? ' (כולן מוסתרות)' : ''}</p>`
            : visible.map(r => M_recRow(r, idxOf(r), false)).join('')
        }</div>
        ${(_recShowHidden && hiddenList.length > 0)
          ? `${M_sectionHead('מוסתרות')}<div class="m-card m-tx-card">${hiddenList.map(r => M_recRow(r, idxOf(r), true)).join('')}</div>`
          : ''}`}
  `

  M_wireRecSwipe()
  if (typeof M_syncTabs === 'function') M_syncTabs('recurring')
  if (typeof M_repaintSync === 'function') M_repaintSync()
}

function M_recRow(r, idx, isHidden) {
  const cls = r.smoothedMonthly > 0 ? 'pos' : 'neg'
  const sign = r.smoothedMonthly > 0 ? '+' : ''
  let badges = ''
  if (r.source === 'manual-group') badges += '<span class="m-badge">📦</span>'
  else if (r.source === 'manual-flag') badges += '<span class="m-badge">✋</span>'
  if (r.installmentCurrent && r.installmentTotal) badges += `<span class="m-badge">💳 ${r.installmentCurrent}/${r.installmentTotal}</span>`
  const smoothNote = r.cadenceDays !== 30
    ? ` · ${r.avgAmount > 0 ? '+' : ''}${formatCurrencyPlain(r.avgAmount)} ל${r.cadenceLabel}`
    : ''
  const avatar = (typeof UK_vendorAvatar === 'function') ? UK_vendorAvatar(r.vendor, { size: 42 }) : '<div class="tx-avatar">🔁</div>'
  return `<div class="m-tx-row ${isHidden ? 'm-rec-hidden' : ''}" data-idx="${idx}" onclick="openRecurringDrillByIdx('${idx}')">
    ${avatar}
    <div class="m-tx-mid">
      <div class="m-tx-name">${r.vendor} ${badges}</div>
      <div class="m-tx-sub">${r.cadenceLabel} · הבא ${formatDate(r.nextExpected)}${smoothNote}</div>
    </div>
    <div class="m-tx-amt ${cls}">${sign}${formatCurrency(r.smoothedMonthly)}</div>
  </div>`
}

// Swipe a row toward the inline-end to hide it (or restore a hidden one).
function M_wireRecSwipe() {
  if (typeof UK_onSwipe !== 'function') return
  document.querySelectorAll('#screen-recurring .m-tx-row[data-idx]').forEach(row => {
    const idx = row.dataset.idx
    const hiddenRow = row.classList.contains('m-rec-hidden')
    UK_onSwipe(row, {
      onEnd: () => (hiddenRow ? unhideRecurringByIdx(idx) : hideRecurringByIdx(idx)),
    })
  })
}
