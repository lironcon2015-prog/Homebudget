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
    ${_propDocsCard()}
    ${M_accordion('פרטי הנכס והגדרות', _propSetupCard(p, cats))}
  `
  if (typeof M_syncTabs === 'function') M_syncTabs('property')
  if (typeof M_repaintSync === 'function') M_repaintSync()
}

function M_fmtK(n) {
  n = Number(n) || 0
  if (n >= 1000) { const k = n / 1000; return (k % 1 === 0 ? k : k.toFixed(1)) + 'K' }
  return String(n)
}

function M_propPayCard(row) {
  const st = _propertyStatus(row)
  const eq = Number(row.equity) || 0
  const mo = Number(row.mortgage) || 0
  const paid = Number(row.paidAmount) || 0
  const sum = eq + mo
  const mismatch = paid > 0 && Math.abs(sum - paid) > 1
  const strip = mismatch ? 'm-pp-warn' : { paid: 'm-pp-paid', upcoming: 'm-pp-up', overdue: 'm-pp-late' }[st.key] || 'm-pp-fut'

  let when = `מתוכנן <b>${formatDate(row.dueDate) || '—'}</b>`
  let when2 = ''
  if (row.paidDate) when2 = `שולם <b>${formatDate(row.paidDate)}</b>${paid ? ` (${formatCurrency(paid)})` : ''}`
  else if (st.key === 'upcoming' && row.dueDate) {
    const days = Math.round((new Date(row.dueDate) - new Date(_iso(new Date()))) / 86400000)
    when2 = `בעוד ${days} ימים`
  } else if (st.key === 'overdue') when2 = '<span class="neg">טרם שולם</span>'

  const bar = sum > 0
    ? `<div class="m-pp-bar"><i class="m-pp-beq" style="width:${(eq / sum * 100).toFixed(1)}%"></i><i class="m-pp-bmo" style="width:${(mo / sum * 100).toFixed(1)}%"></i></div>`
    : ''
  const docCount = propDocCountForPayment(row.id)
  const chips = [
    eq > 0 ? `<span class="m-pp-chip" style="color:#4ade80">הון ${M_fmtK(eq)}</span>` : '',
    mo > 0 ? `<span class="m-pp-chip" style="color:#60a5fa">משכ׳ ${M_fmtK(mo)}</span>` : '',
    row.track ? `<span class="m-pp-chip">${PROPERTY_TRACKS[row.track]?.label || ''}</span>` : '',
    docCount > 0 ? `<span class="m-pp-chip" onclick="event.stopPropagation();propDocShowForPayment('${row.id}')">📎${docCount}</span>` : '',
    row.notes ? `<span class="m-pp-chip">💬</span>` : '',
    mismatch ? `<span class="m-pp-chip neg">⚠ הון+משכ׳ ≠ שולם</span>` : '',
  ].filter(Boolean).join('')

  return `<div class="m-prop-pay ${strip}" onclick="M_editPayment('${row.id}')">
    <div class="m-prop-pay-top">
      <span class="prop-status ${st.cls}">${st.label}</span>
      <span class="m-prop-pay-type">${_propTypeText(row)}</span>
      <span class="m-prop-pay-amt">${formatCurrency(row.amount)}</span>
    </div>
    <div class="m-prop-pay-meta m-pp-dates"><span>${when}</span><span>${when2}</span></div>
    ${bar}
    ${chips ? `<div class="m-pp-chips">${chips}</div>` : ''}
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

  const docs = (typeof getPropertyDocs === 'function' ? getPropertyDocs() : []).filter(d => d.linkedPaymentId === id)
  const docRows = docs.map(d => {
    const c = _pdCat(d.docType)
    return `<div class="m-pp-docrow" onclick="propDocView('${d.id}')">${c.icon} ${escHtml(_pdDisplayName(d))}${d.driveFileId ? ' <span style="opacity:.6">☁✓</span>' : ''}</div>`
  }).join('')

  const html = `
  <div class="m-pp-tabs">
    <button class="m-pp-tab on" id="mPPTabD" onclick="M_ppTab('details')">פרטים</button>
    <button class="m-pp-tab" id="mPPTabF" onclick="M_ppTab('docs')">מסמכים${docs.length ? ` (${docs.length})` : ''}</button>
  </div>
  <div class="m-filter-form" id="mPPDetails">
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
  </div>
  <div id="mPPDocs" style="display:none">
    ${docRows || '<p class="m-empty-line">אין מסמכים מקושרים לתשלום זה</p>'}
    <button class="btn-ghost" style="width:100%;margin-top:.8rem" onclick="if(M_propPaySheet){M_propPaySheet.close();M_propPaySheet=null};propDocBrowse('${id}')">📎 צרף מסמך / 📷 צלם שובר</button>
  </div>`
  M_propPaySheet = UK_sheet({ title: `עריכת ${_propTypeText(row)}`, content: html })
}

function M_ppTab(which) {
  const d = which === 'details'
  document.getElementById('mPPDetails').style.display = d ? '' : 'none'
  document.getElementById('mPPDocs').style.display = d ? 'none' : ''
  document.getElementById('mPPTabD').classList.toggle('on', d)
  document.getElementById('mPPTabF').classList.toggle('on', !d)
}

function M_delPayment(id) {
  if (M_propPaySheet) { M_propPaySheet.close(); M_propPaySheet = null }
  deletePropertyPayment(id)
}
