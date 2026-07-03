// ===== REPORTS & EXPORT =====
// Turns the active-period data into shareable output: an Excel workbook
// (SheetJS, already loaded globally as XLSX) and a print-optimized report that
// the browser can save as PDF. All numbers reuse core.js so there is no
// parallel calculation logic here.

const _REPORT_TYPE_LABEL = { income: 'הכנסה', expense: 'הוצאה', transfer: 'העברה', refund: 'החזר' }

function _reportVendor(t) {
  if (typeof resolveVendor === 'function') {
    const day = typeof getTxAliasDay === 'function' ? getTxAliasDay(t) : null
    return resolveVendor(t.vendor, t.amount, day) || t.vendor || ''
  }
  return t.vendor || ''
}

// Aggregates the active period into the shape every report needs.
function _reportData() {
  const period = getActivePeriod()
  const all = getTransactions()
  const tx = filterByEffectivePeriod(all, period)
  const income = sumIncome(tx)
  const expenses = sumExpenses(tx)
  const hiddenSavings = sumHiddenSavings(tx)
  const capitalIncome = sumCapitalIncome(tx)

  // Category breakdown uses the canonical analysis scope (analysisExpenseAmount):
  // CC detail rows count under their categories, and a card's lump payment is
  // dropped only when that card has itemized detail in the period. The old
  // countedExpenseAmount + drop-every-linked-lump combination silently lost
  // lump amounts for cards without detail from the breakdown.
  const savingsInvestIds = analysisExpenseSavingsInvestIds()
  const ccAccsWithDetail = ccAccountsWithDetail(tx)
  let expBreakdownTotal = 0
  const expByCat = {}
  const incByCat = {}
  for (const t of tx) {
    const ce = analysisExpenseAmount(t, savingsInvestIds, ccAccsWithDetail)
    if (ce > 0) {
      const c = getCategoryById(t.categoryId)
      const k = c ? c.id : '__none__'
      if (!expByCat[k]) expByCat[k] = { id: k, name: c ? c.name : 'לא מסווג', total: 0, count: 0 }
      expByCat[k].total += ce
      expByCat[k].count++
      expBreakdownTotal += ce
    }
    if (isCountedIncome(t)) {
      const c = getCategoryById(t.categoryId)
      const k = c ? c.id : '__none__'
      if (!incByCat[k]) incByCat[k] = { id: k, name: c ? c.name : 'לא מסווג', total: 0, count: 0 }
      incByCat[k].total += t.amount
      incByCat[k].count++
    }
  }

  const months = monthsInPeriod(period)
  const monthly = months.map(mo => {
    const mtx = tx.filter(t => getTxEffectiveMonth(t) === mo)
    const mi = sumIncome(mtx)
    const me = sumExpenses(mtx)
    return { month: mo, income: mi, expense: me, net: mi - me }
  })

  return {
    period, tx,
    income, expenses, net: income - expenses, hiddenSavings, capitalIncome,
    expBreakdownTotal,
    expRows: Object.values(expByCat).sort((a, b) => b.total - a.total),
    incRows: Object.values(incByCat).sort((a, b) => b.total - a.total),
    monthly,
  }
}

// ===== EXCEL =====
function exportExcel() {
  if (typeof XLSX === 'undefined') { toast('ספריית Excel לא נטענה', { type: 'error' }); return }
  const d = _reportData()

  const txAoA = [['תאריך', 'חשבון', 'ספק', 'קטגוריה', 'סוג', 'סכום']]
  const accs = (typeof getAccounts === 'function') ? getAccounts() : []
  const accName = id => (accs.find(a => a.id === id) || {}).name || ''
  ;[...d.tx].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(t => {
    const cat = getCategoryById(t.categoryId)
    txAoA.push([t.date || '', accName(t.accountId), _reportVendor(t), cat ? cat.name : '', _REPORT_TYPE_LABEL[t.type] || t.type, t.amount])
  })

  const catAoA = [['קטגוריה', 'סוג', 'סכום', 'מספר עסקאות']]
  d.expRows.forEach(r => catAoA.push([r.name, 'הוצאה', r.total, r.count]))
  d.incRows.forEach(r => catAoA.push([r.name, 'הכנסה', r.total, r.count]))

  const plAoA = [['חודש', 'הכנסות', 'הוצאות', 'נטו']]
  d.monthly.forEach(m => plAoA.push([m.month, m.income, m.expense, m.net]))
  plAoA.push(['סה"כ', d.income, d.expenses, d.net])

  const wb = XLSX.utils.book_new()
  wb.Workbook = { Views: [{ RTL: true }] }
  const s1 = XLSX.utils.aoa_to_sheet(txAoA)
  s1['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 26 }, { wch: 18 }, { wch: 8 }, { wch: 12 }]
  XLSX.utils.book_append_sheet(wb, s1, 'עסקאות')
  const s2 = XLSX.utils.aoa_to_sheet(catAoA)
  s2['!cols'] = [{ wch: 24 }, { wch: 8 }, { wch: 12 }, { wch: 12 }]
  XLSX.utils.book_append_sheet(wb, s2, 'סיכום קטגוריות')
  const s3 = XLSX.utils.aoa_to_sheet(plAoA)
  s3['!cols'] = [{ wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 14 }]
  XLSX.utils.book_append_sheet(wb, s3, 'רווח והפסד חודשי')

  XLSX.writeFile(wb, `כספים-דוח-${d.period.start}_${d.period.end}.xlsx`)
  toast('הדוח יוצא ל-Excel', { type: 'success' })
}

// ===== PRINTABLE PDF REPORT =====
// Renders into #reportPrintRoot; an @media print stylesheet hides everything
// else, so window.print() (or "Save as PDF") yields a clean RTL report.
function printReport() {
  const root = document.getElementById('reportPrintRoot')
  if (!root) return
  const d = _reportData()
  const f = v => formatCurrency(v)
  const pct = (v, tot) => (tot > 0 ? Math.round((v / tot) * 100) + '%' : '—')
  const savingsBase = d.income - d.capitalIncome
  const savingsRate = savingsBase > 0 ? Math.round(((d.net + d.hiddenSavings) / savingsBase) * 100) : 0
  const taxRefund = (d.incRows.find(r => r.id === 'cat_taxback') || {}).total || 0
  const generated = new Date().toLocaleDateString('he-IL')

  const expRowsHTML = d.expRows.map(r =>
    `<tr><td>${r.name}</td><td class="num">${f(r.total)}</td><td class="num">${pct(r.total, d.expBreakdownTotal)}</td><td class="num">${r.count}</td></tr>`).join('')
  const incRowsHTML = d.incRows.map(r =>
    `<tr><td>${r.name}</td><td class="num">${f(r.total)}</td><td class="num">${pct(r.total, d.income)}</td><td class="num">${r.count}</td></tr>`).join('')
  const plRowsHTML = d.monthly.map(m =>
    `<tr><td>${m.month}</td><td class="num">${f(m.income)}</td><td class="num">${f(m.expense)}</td><td class="num">${f(m.net)}</td></tr>`).join('')

  root.innerHTML = `
    <div class="report">
      <div class="report-head">
        <h1>דוח פיננסי – כספים</h1>
        <div class="report-meta">תקופה: ${d.period.label || (d.period.start + ' – ' + d.period.end)} · הופק: ${generated}</div>
      </div>
      <div class="report-summary">
        <div class="report-kpi"><span>הכנסות</span><strong>${f(d.income)}</strong></div>
        <div class="report-kpi"><span>הוצאות</span><strong>${f(d.expenses)}</strong></div>
        <div class="report-kpi"><span>נטו</span><strong>${f(d.net)}</strong></div>
        <div class="report-kpi"><span>שיעור חיסכון</span><strong>${savingsRate}%</strong></div>
      </div>

      <h2>הוצאות לפי קטגוריה</h2>
      <table class="report-table"><thead><tr><th>קטגוריה</th><th class="num">סכום</th><th class="num">%</th><th class="num">עסקאות</th></tr></thead>
        <tbody>${expRowsHTML || '<tr><td colspan="4">אין נתונים</td></tr>'}</tbody></table>

      <h2>הכנסות לפי קטגוריה</h2>
      <table class="report-table"><thead><tr><th>קטגוריה</th><th class="num">סכום</th><th class="num">%</th><th class="num">עסקאות</th></tr></thead>
        <tbody>${incRowsHTML || '<tr><td colspan="4">אין נתונים</td></tr>'}</tbody></table>

      <h2>רווח והפסד חודשי</h2>
      <table class="report-table"><thead><tr><th>חודש</th><th class="num">הכנסות</th><th class="num">הוצאות</th><th class="num">נטו</th></tr></thead>
        <tbody>${plRowsHTML}</tbody>
        <tfoot><tr><td>סה"כ</td><td class="num">${f(d.income)}</td><td class="num">${f(d.expenses)}</td><td class="num">${f(d.net)}</td></tr></tfoot></table>

      <h2>סיכום למס</h2>
      <table class="report-table"><tbody>
        <tr><td>סך הכנסות בתקופה</td><td class="num">${f(d.income)}</td></tr>
        <tr><td>מתוכן הכנסה הונית (שבירת חיסכון/דיבידנד)</td><td class="num">${f(d.capitalIncome)}</td></tr>
        <tr><td>החזרי מס שהתקבלו</td><td class="num">${f(taxRefund)}</td></tr>
      </tbody></table>

      <div class="report-foot">הופק מאפליקציית "כספים" · גרסה ${typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''}</div>
    </div>`

  window.print()
}
