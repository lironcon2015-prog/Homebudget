// ===== MOBILE PROPERTY / MORTGAGE (Dark Glass) =====
// Replaces the 11-column editable payments table with compact read cards (no
// horizontal scrolling); tapping a card opens an edit bottom-sheet. Everything
// else (summary, mortgage card, setup form) reuses the desktop helpers, styled
// natively via mobile.css. renderProperty() delegates here via IS_MOBILE_UI.
let M_propPaySheet = null

function M_renderProperty() {
  const host = document.getElementById('screen-property')
  if (!host) return
  const t = _propertyTotals()
  const p = t.p
  const cats = (typeof getCategories === 'function' ? getCategories() : []).filter(c => c.type === 'expense')
  const mort = _mortgagePaid(p.mortgageCategoryId)
  const mortgageRemaining = Math.max(0, t.totalMortgage - mort.total)
  const monthsLeft = mort.recurringMonthly > 0 ? mortgageRemaining / mort.recurringMonthly : null

  host.innerHTML = `
    ${M_topbar('משכנתא ונכס')}
    ${_propSummaryCards(t)}
    ${_propMortgageCard(t, mort, mortgageRemaining, monthsLeft, p)}
    ${M_sectionHead('תשלומים (מהקבלן/יזם)', `<button class="m-iconbtn" onclick="addPropertyPayment()" aria-label="הוסף תשלום">＋</button>`)}
    <div id="mPropPays">${
      t.pays.length === 0
        ? '<p class="m-empty-line">אין תשלומים. הוסף עם ＋</p>'
        : t.pays.slice().sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || '')).map(M_propPayCard).join('')
    }</div>
    ${M_accordion('פרטי הנכס והגדרות', _propSetupCard(p, cats))}
  `
  if (typeof M_syncTabs === 'function') M_syncTabs('property')
  if (typeof M_repaintSync === 'function') M_repaintSync()
}

function M_propPayCard(row) {
  const st = _propertyStatus(row)
  const type = PROPERTY_TYPES[row.type] || PROPERTY_TYPES.other
  const track = PROPERTY_TRACKS[row.track]?.label || '—'
  const sum = (Number(row.equity) || 0) + (Number(row.mortgage) || 0)
  const paid = Number(row.paidAmount) || 0
  const mismatch = paid > 0 && Math.abs(sum - paid) > 1
  return `<div class="m-prop-pay ${mismatch ? 'm-prop-mismatch' : ''}" onclick="M_editPayment('${row.id}')">
    <div class="m-prop-pay-top">
      <span class="prop-status ${st.cls}">${st.label}</span>
      <span class="m-prop-pay-type">${type.icon} ${type.label}${row.paymentNumber ? ` #${row.paymentNumber}` : ''}</span>
      <span class="m-prop-pay-amt">${formatCurrency(row.amount)}</span>
    </div>
    <div class="m-prop-pay-meta">מתוכנן ${formatDate(row.dueDate) || '—'} · שולם ${row.paidDate ? formatDate(row.paidDate) : '—'}${paid ? ` (${formatCurrency(paid)})` : ''}</div>
    <div class="m-prop-pay-meta">הון ${formatCurrency(row.equity)} · משכנתא ${formatCurrency(row.mortgage)} · ${track}${mismatch ? ' · <span class="neg">⚠ הון+משכנתא ≠ שולם</span>' : ''}</div>
  </div>`
}

function M_editPayment(id) {
  if (typeof UK_sheet !== 'function') return
  const row = getPropertyPayments().find(x => x.id === id)
  if (!row) return
  const typeOpts = Object.entries(PROPERTY_TYPES).map(([k, v]) => `<option value="${k}" ${row.type === k ? 'selected' : ''}>${v.label}</option>`).join('')
  const trackOpts = Object.entries(PROPERTY_TRACKS).map(([k, v]) => `<option value="${k}" ${row.track === k ? 'selected' : ''}>${v.label}</option>`).join('')
  const dateInput = (field, val) => `<input class="m-filter-select" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" value="${_isoToDmy(val || '')}" oninput="_onDateMaskInput(this)" onchange="onPropertyRowChange('${id}','${field}',_dmyToIso(this.value))">`
  const numInput = (field, val) => `<input class="m-filter-select" type="number" inputmode="decimal" value="${val || ''}" onchange="onPropertyRowChange('${id}','${field}',this.value)">`
  const html = `<div class="m-filter-form">
    <label class="m-filter-label">מועד מתוכנן</label>${dateInput('dueDate', row.dueDate)}
    <label class="m-filter-label">תאריך תשלום בפועל</label>${dateInput('paidDate', row.paidDate)}
    <label class="m-filter-label">סוג</label>
    <select class="m-filter-select" onchange="onPropertyRowChange('${id}','type',this.value)">${typeOpts}</select>
    <label class="m-filter-label">מספר תשלום</label>${numInput('paymentNumber', row.paymentNumber)}
    <div class="m-amt-2col">
      <div><label class="m-filter-label">סכום</label>${numInput('amount', row.amount)}</div>
      <div><label class="m-filter-label">שולם בפועל</label>${numInput('paidAmount', row.paidAmount)}</div>
    </div>
    <div class="m-amt-2col">
      <div><label class="m-filter-label">הון עצמי</label>${numInput('equity', row.equity)}</div>
      <div><label class="m-filter-label">משכנתא</label>${numInput('mortgage', row.mortgage)}</div>
    </div>
    <label class="m-filter-label">מסלול</label>
    <select class="m-filter-select" onchange="onPropertyRowChange('${id}','track',this.value)">${trackOpts}</select>
    <label class="m-filter-label">הערות</label>
    <input class="m-filter-select" value="${(row.notes || '').replace(/"/g, '&quot;')}" onchange="onPropertyRowChange('${id}','notes',this.value)">
    <button class="btn-danger" style="width:100%;margin-top:1.1rem" onclick="M_delPayment('${id}')">🗑 מחק תשלום</button>
  </div>`
  M_propPaySheet = UK_sheet({ title: 'עריכת תשלום', content: html })
}

function M_delPayment(id) {
  if (M_propPaySheet) { M_propPaySheet.close(); M_propPaySheet = null }
  deletePropertyPayment(id)
}
