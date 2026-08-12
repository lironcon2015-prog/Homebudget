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
  const refunds = sumRefunds(tx)
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
  // Refunds are their own bucket, never a negative slice of a category (see
  // core.js): the report has to show the same three flows the screens show.
  const refundBucket = refundBreakdownByCategory(tx)

  const months = monthsInPeriod(period)
  const monthly = months.map(mo => {
    const mtx = tx.filter(t => getTxEffectiveMonth(t) === mo)
    const mi = sumIncome(mtx)
    const me = sumExpenses(mtx)
    const mr = sumRefunds(mtx)
    return { month: mo, income: mi, expense: me, refund: mr, net: mi - me + mr }
  })

  return {
    period, tx,
    income, expenses, refunds, net: income - expenses + refunds, hiddenSavings, capitalIncome,
    expBreakdownTotal,
    expRows: Object.values(expByCat).sort((a, b) => b.total - a.total),
    incRows: Object.values(incByCat).sort((a, b) => b.total - a.total),
    refundRows: refundBucket.rows,
    refundBreakdownTotal: refundBucket.total,
    monthly,
  }
}

function _reportSavingsRate(d) {
  const base = d.income - d.capitalIncome
  return base > 0 ? (d.net + d.hiddenSavings) / base : 0
}

// ===== EXCEL =====
// Two SheetJS builds are loaded (see index.html): the plain one, which READS
// the statements we import, and xlsx-js-style, which is the same 0.18.5 codebase
// with a style writer. `_xl()` picks the styling build for exports and falls
// back to the plain one if its CDN is unreachable — in that case every `s`
// property is simply ignored and the workbook still comes out correct, just
// unstyled. Never emit pre-formatted strings for numbers: that produces a
// workbook that looks right and cannot compute.
function _xl() { return (typeof XLSX_STYLE !== 'undefined' && XLSX_STYLE) ? XLSX_STYLE : XLSX }

const _XL_MONEY = '"₪"#,##0.00'
const _XL_MONEY0 = '"₪"#,##0'
const _XL_PCT = '0.0%'
const _XL_DATE = 'dd/mm/yyyy'
const _XL_MONTH = 'mm/yyyy'

// Palette: the app's V2 hues translated to a light, printable sheet. Excel wants
// AARRGGBB. Flow colours match the screens (income green, expense red, refund
// sky) so a number means the same thing in both places.
const _XLC = {
  ink: 'FF0E1420', mute: 'FF64748B', line: 'FFE2E8F0',
  headBg: 'FF1E293B', headInk: 'FFFFFFFF',
  bandBg: 'FFF1F5F9', zebra: 'FFF8FAFC', totalBg: 'FFEEF2FF',
  income: 'FF0E9F6E', expense: 'FFE11D48', refund: 'FF0284C7', accent: 'FF4F8BFF',
}
const _XL_FONT = 'Arial'

function _xlBorder(color = _XLC.line, style = 'thin') {
  return { top: { style, color: { rgb: color } }, bottom: { style, color: { rgb: color } },
           left: { style, color: { rgb: color } }, right: { style, color: { rgb: color } } }
}

// Cell style presets. `alignment.readingOrder: 2` marks the run as RTL so mixed
// Hebrew + digits render the way the app shows them.
const _XLS = {
  title:   { font: { name: _XL_FONT, sz: 16, bold: true, color: { rgb: _XLC.ink } },
             alignment: { horizontal: 'right', vertical: 'center', readingOrder: 2 } },
  meta:    { font: { name: _XL_FONT, sz: 10, color: { rgb: _XLC.mute } },
             alignment: { horizontal: 'right', readingOrder: 2 } },
  head:    { font: { name: _XL_FONT, sz: 11, bold: true, color: { rgb: _XLC.headInk } },
             fill: { patternType: 'solid', fgColor: { rgb: _XLC.headBg } },
             alignment: { horizontal: 'center', vertical: 'center', wrapText: true, readingOrder: 2 },
             border: _xlBorder(_XLC.headBg) },
  section: { font: { name: _XL_FONT, sz: 11, bold: true, color: { rgb: _XLC.ink } },
             fill: { patternType: 'solid', fgColor: { rgb: _XLC.bandBg } },
             alignment: { horizontal: 'right', vertical: 'center', readingOrder: 2 },
             border: _xlBorder() },
  text:    { font: { name: _XL_FONT, sz: 10, color: { rgb: _XLC.ink } },
             alignment: { horizontal: 'right', vertical: 'center', readingOrder: 2 }, border: _xlBorder() },
  num:     { font: { name: _XL_FONT, sz: 10, color: { rgb: _XLC.ink } },
             alignment: { horizontal: 'left', vertical: 'center' }, border: _xlBorder() },
  total:   { font: { name: _XL_FONT, sz: 11, bold: true, color: { rgb: _XLC.ink } },
             fill: { patternType: 'solid', fgColor: { rgb: _XLC.totalBg } },
             alignment: { horizontal: 'right', vertical: 'center', readingOrder: 2 },
             border: _xlBorder(_XLC.accent) },
  totalNum:{ font: { name: _XL_FONT, sz: 11, bold: true, color: { rgb: _XLC.ink } },
             fill: { patternType: 'solid', fgColor: { rgb: _XLC.totalBg } },
             alignment: { horizontal: 'left', vertical: 'center' }, border: _xlBorder(_XLC.accent) },
  note:    { font: { name: _XL_FONT, sz: 9, color: { rgb: _XLC.mute }, italic: true },
             alignment: { horizontal: 'right', vertical: 'top', wrapText: true, readingOrder: 2 } },
}

// A flow-coloured, bold variant of the number style (income/expense/refund).
function _xlFlowNum(rgb, { bold = true, fill = null } = {}) {
  const s = { font: { name: _XL_FONT, sz: 10, bold, color: { rgb } },
              alignment: { horizontal: 'left', vertical: 'center' }, border: _xlBorder() }
  if (fill) s.fill = { patternType: 'solid', fgColor: { rgb: fill } }
  return s
}

function _xlA(col, row) { return _xl().utils.encode_cell({ c: col, r: row }) }

// Style one cell, merging into whatever it already carries (so a zebra fill can
// be laid down first and a flow colour applied on top).
function _xlStyle(ws, col, row, style) {
  const cell = ws[_xlA(col, row)]
  if (!cell) return
  cell.s = { ...(cell.s || {}), ...style }
}
function _xlStyleRow(ws, row, fromCol, toCol, style) {
  for (let c = fromCol; c <= toCol; c++) _xlStyle(ws, c, row, style)
}

// Table body: alternating fills, text on the right, numbers on the left (the
// report is RTL, so the numeric edge is the left one).
function _xlBody(ws, { fromRow, toRow, cols, numCols = [] }) {
  for (let r = fromRow; r <= toRow; r++) {
    const zebra = (r - fromRow) % 2 === 1
    for (let c = 0; c < cols; c++) {
      const base = numCols.includes(c) ? _XLS.num : _XLS.text
      const style = zebra
        ? { ...base, fill: { patternType: 'solid', fgColor: { rgb: _XLC.zebra } } }
        : base
      _xlStyle(ws, c, r, style)
    }
  }
}

// Applies a number format down a column, over the given (0-based) row range.
// Date cells must be included: aoa_to_sheet stamps them t:'d' with the default
// m/d/yy, which is the wrong order for an RTL Hebrew report.
function _xlFormatCol(ws, col, z, fromRow, toRow) {
  for (let r = fromRow; r <= toRow; r++) {
    const cell = ws[_xlA(col, r)]
    if (cell && (cell.t === 'n' || cell.t === 'd')) cell.z = z
  }
}

function _xlDate(iso) {
  if (!iso) return ''
  const [y, m, dd] = String(iso).split('-').map(Number)
  if (!y || !m) return String(iso)
  return new Date(y, m - 1, dd || 1)
}

// Sheet chrome shared by every sheet: RTL, tuned widths, a header band with a
// real height, and an autofilter over the data. Freeze panes are deliberately
// NOT attempted: neither build writes a <pane> element (they only read one), so
// the code would have looked like it froze the header while the file did not.
function _xlFinishSheet(ws, { cols, headerRow = 0, lastCol = 0, lastRow = 0, autofilter = true, numCols = [] }) {
  if (cols) ws['!cols'] = cols
  ws['!views'] = [{ RTL: true }]
  const rows = []
  rows[headerRow] = { hpt: 24 }
  ws['!rows'] = rows
  _xlStyleRow(ws, headerRow, 0, lastCol, _XLS.head)
  if (lastRow > headerRow) _xlBody(ws, { fromRow: headerRow + 1, toRow: lastRow, cols: lastCol + 1, numCols })
  if (autofilter) ws['!autofilter'] = { ref: `${_xlA(0, headerRow)}:${_xlA(lastCol, Math.max(headerRow + 1, lastRow))}` }
}

function _xlSummarySheet(d) {
  const label = d.period.label || `${d.period.start} – ${d.period.end}`
  const rate = _reportSavingsRate(d)
  const aoa = [
    ['דוח פיננסי – כספים'],
    [`תקופה: ${label}`],
    [`הופק: ${new Date().toLocaleDateString('he-IL')}`],
    [],
    ['מדד', 'סכום'],
    ['סך הכנסות', d.income],
    ['סך הוצאות (ברוטו)', d.expenses],
    ['החזרים', d.refunds],
    ['נטו (הכנסות − הוצאות + החזרים)', d.net],
    ['מתוך ההוצאות: חסכונות חבויים', d.hiddenSavings],
    ['מתוך ההכנסות: הכנסה הונית', d.capitalIncome],
    ['שיעור חיסכון אמיתי', rate],
    [],
    ['הערה', 'החזרים אינם מנוכים מההוצאות ואינם נספרים כהכנסה. ההוצאות מוצגות ברוטו — כפי שיצאו בפועל בחודש שלהן — וההחזר נספר בשורה נפרדת ובנטו.'],
  ]
  const X = _xl()
  const ws = X.utils.aoa_to_sheet(aoa)
  _xlFormatCol(ws, 1, _XL_MONEY, 5, 10)
  const rateCell = ws[_xlA(1, 11)]
  if (rateCell && rateCell.t === 'n') rateCell.z = _XL_PCT
  ws['!merges'] = [
    X.utils.decode_range('A1:B1'),
    X.utils.decode_range('A2:B2'),
    X.utils.decode_range('A3:B3'),
    X.utils.decode_range('A14:B14'),
  ]
  ws['!cols'] = [{ wch: 38 }, { wch: 58 }]
  ws['!views'] = [{ RTL: true }]
  ws['!rows'] = [{ hpt: 30 }, { hpt: 16 }, { hpt: 16 }, { hpt: 8 }, { hpt: 24 }]
  ws['!rows'][13] = { hpt: 44 }

  _xlStyle(ws, 0, 0, _XLS.title)
  _xlStyle(ws, 0, 1, _XLS.meta)
  _xlStyle(ws, 0, 2, _XLS.meta)
  _xlStyleRow(ws, 4, 0, 1, _XLS.head)
  // Each KPI row is coloured by the flow it reports, so the three-way split
  // (income / gross expenses / refunds) is legible at a glance.
  const kpiColor = [_XLC.income, _XLC.expense, _XLC.refund, _XLC.accent, _XLC.ink, _XLC.ink, _XLC.income]
  for (let i = 0; i < 7; i++) {
    const r = 5 + i
    const isNet = i === 3
    _xlStyle(ws, 0, r, isNet ? _XLS.total : _XLS.text)
    _xlStyle(ws, 1, r, _xlFlowNum(kpiColor[i], { fill: isNet ? _XLC.totalBg : null }))
  }
  _xlStyle(ws, 0, 13, _XLS.note)
  _xlStyle(ws, 1, 13, _XLS.note)
  return ws
}

function _xlTransactionsSheet(d) {
  const accs = (typeof getAccounts === 'function') ? getAccounts() : []
  const accName = id => (accs.find(a => a.id === id) || {}).name || ''
  const header = ['תאריך', 'חודש חיוב', 'חשבון', 'ספק', 'קטגוריה', 'סוג', 'סכום']
  const rows = [...d.tx]
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(t => {
      const cat = getCategoryById(t.categoryId)
      const eff = getTxEffectiveMonth(t)
      return [
        _xlDate(t.date),
        eff ? _xlDate(eff + '-01') : '',
        accName(t.accountId),
        _reportVendor(t),
        cat ? cat.name : 'לא מסווג',
        _REPORT_TYPE_LABEL[t.type] || t.type || '',
        t.amount,
      ]
    })
  const ws = _xl().utils.aoa_to_sheet([header, ...rows], { cellDates: true })
  const last = rows.length
  _xlFormatCol(ws, 0, _XL_DATE, 1, last)
  _xlFormatCol(ws, 1, _XL_MONTH, 1, last)
  _xlFormatCol(ws, 6, _XL_MONEY, 1, last)
  _xlFinishSheet(ws, {
    cols: [{ wch: 12 }, { wch: 11 }, { wch: 18 }, { wch: 30 }, { wch: 20 }, { wch: 9 }, { wch: 14 }],
    lastCol: 6, lastRow: last, numCols: [0, 1, 6],
  })
  // Amount coloured by what the row is: outflow, income, or credit back. Keeps
  // the zebra fill underneath (see _xlStyle merging).
  ;[...d.tx].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach((t, i) => {
    const rgb = t.type === 'refund' && t.amount > 0 ? _XLC.refund
      : t.amount > 0 ? _XLC.income
      : _XLC.expense
    const zebra = i % 2 === 1
    _xlStyle(ws, 6, i + 1, _xlFlowNum(rgb, { fill: zebra ? _XLC.zebra : null }))
  })
  return ws
}

function _xlCategoriesSheet(d) {
  const header = ['קטגוריה', 'סוג', 'סכום', 'אחוז מהסוג', 'מספר עסקאות']
  const rows = []
  const flow = []
  d.expRows.forEach(r => { rows.push([r.name, 'הוצאה', r.total, d.expBreakdownTotal > 0 ? r.total / d.expBreakdownTotal : 0, r.count]); flow.push(_XLC.expense) })
  d.incRows.forEach(r => { rows.push([r.name, 'הכנסה', r.total, d.income > 0 ? r.total / d.income : 0, r.count]); flow.push(_XLC.income) })
  d.refundRows.forEach(r => { rows.push([r.name, 'החזר', r.total, d.refundBreakdownTotal > 0 ? r.total / d.refundBreakdownTotal : 0, r.count]); flow.push(_XLC.refund) })
  const ws = _xl().utils.aoa_to_sheet([header, ...rows])
  const last = rows.length
  _xlFormatCol(ws, 2, _XL_MONEY, 1, last)
  _xlFormatCol(ws, 3, _XL_PCT, 1, last)
  _xlFinishSheet(ws, {
    cols: [{ wch: 26 }, { wch: 9 }, { wch: 14 }, { wch: 12 }, { wch: 13 }],
    lastCol: 4, lastRow: last, numCols: [2, 3, 4],
  })
  // The three blocks are stacked on one sheet so they stay filterable together;
  // colour on the type and amount columns is what separates them visually.
  flow.forEach((rgb, i) => {
    const zebra = i % 2 === 1
    _xlStyle(ws, 1, i + 1, { ..._xlFlowNum(rgb, { fill: zebra ? _XLC.zebra : null }), alignment: { horizontal: 'center', vertical: 'center', readingOrder: 2 } })
    _xlStyle(ws, 2, i + 1, _xlFlowNum(rgb, { fill: zebra ? _XLC.zebra : null }))
  })
  return ws
}

function _xlMonthlySheet(d) {
  const header = ['חודש', 'הכנסות', 'הוצאות (ברוטו)', 'החזרים', 'נטו']
  const rows = d.monthly.map(m => [_xlDate(m.month + '-01'), m.income, m.expense, m.refund, m.net])
  const totals = ['סה"כ', d.income, d.expenses, d.refunds, d.net]
  const ws = _xl().utils.aoa_to_sheet([header, ...rows, totals], { cellDates: true })
  const totalRow = rows.length + 1
  _xlFormatCol(ws, 0, _XL_MONTH, 1, rows.length)
  for (const c of [1, 2, 3, 4]) _xlFormatCol(ws, c, _XL_MONEY0, 1, totalRow)
  _xlFinishSheet(ws, {
    cols: [{ wch: 11 }, { wch: 15 }, { wch: 17 }, { wch: 13 }, { wch: 15 }],
    lastCol: 4, lastRow: rows.length, numCols: [0, 1, 2, 3, 4], autofilter: false,
  })
  const colColor = [null, _XLC.income, _XLC.expense, _XLC.refund, null]
  rows.forEach((_, i) => {
    const zebra = i % 2 === 1
    for (let c = 1; c <= 4; c++) {
      if (!colColor[c]) continue
      _xlStyle(ws, c, i + 1, _xlFlowNum(colColor[c], { bold: false, fill: zebra ? _XLC.zebra : null }))
    }
    // Net is signed: a deficit month has to look like one.
    const net = rows[i][4]
    _xlStyle(ws, 4, i + 1, _xlFlowNum(net >= 0 ? _XLC.income : _XLC.expense, { fill: zebra ? _XLC.zebra : null }))
  })
  _xlStyle(ws, 0, totalRow, _XLS.total)
  _xlStyleRow(ws, totalRow, 1, 4, _XLS.totalNum)
  return ws
}

function exportExcel() {
  if (typeof XLSX === 'undefined') { toast('ספריית Excel לא נטענה', { type: 'error' }); return }
  const d = _reportData()

  const X = _xl()
  const wb = X.utils.book_new()
  wb.Workbook = { Views: [{ RTL: true }] }
  wb.Props = {
    Title: 'דוח פיננסי – כספים',
    Subject: d.period.label || `${d.period.start} – ${d.period.end}`,
    Application: 'כספים',
  }

  X.utils.book_append_sheet(wb, _xlSummarySheet(d), 'סיכום')
  X.utils.book_append_sheet(wb, _xlTransactionsSheet(d), 'עסקאות')
  X.utils.book_append_sheet(wb, _xlCategoriesSheet(d), 'סיכום קטגוריות')
  X.utils.book_append_sheet(wb, _xlMonthlySheet(d), 'רווח והפסד חודשי')

  X.writeFile(wb, `כספים-דוח-${d.period.start}_${d.period.end}.xlsx`, { cellDates: true })
  toast('הדוח יוצא ל-Excel', { type: 'success' })
}

// ===== PRINTABLE PDF REPORT =====
// Renders into #reportPrintRoot; an @media print stylesheet hides everything
// else, so window.print() (or "Save as PDF") yields a clean RTL report.
//
// Every heading is wrapped with its table in .report-block so a page break can
// never leave a title stranded at the foot of a page with its content overleaf
// (the CSS pairs break-after:avoid on the heading with break-before:avoid on
// the table — Chrome honours the pair even where it ignores either alone).
function _reportBlock(title, bodyHTML) {
  return `<section class="report-block"><h2>${title}</h2>${bodyHTML}</section>`
}

function printReport() {
  const root = document.getElementById('reportPrintRoot')
  if (!root) return
  const d = _reportData()
  const f = v => formatCurrency(v)
  const pct = (v, tot) => (tot > 0 ? Math.round((v / tot) * 100) + '%' : '—')
  const savingsRate = Math.round(_reportSavingsRate(d) * 100)
  const taxRefund = (d.incRows.find(r => r.id === 'cat_taxback') || {}).total || 0
  const generated = new Date().toLocaleDateString('he-IL')

  const expRowsHTML = d.expRows.map(r =>
    `<tr><td>${escHtml(r.name)}</td><td class="num">${f(r.total)}</td><td class="num">${pct(r.total, d.expBreakdownTotal)}</td><td class="num">${r.count}</td></tr>`).join('')
  const incRowsHTML = d.incRows.map(r =>
    `<tr><td>${escHtml(r.name)}</td><td class="num">${f(r.total)}</td><td class="num">${pct(r.total, d.income)}</td><td class="num">${r.count}</td></tr>`).join('')
  const refRowsHTML = d.refundRows.map(r =>
    `<tr><td>${escHtml(r.name)}</td><td class="num">${f(r.total)}</td><td class="num">${r.count}</td></tr>`).join('')
  const plRowsHTML = d.monthly.map(m =>
    `<tr><td>${m.month}</td><td class="num">${f(m.income)}</td><td class="num">${f(m.expense)}</td><td class="num">${f(m.refund)}</td><td class="num">${f(m.net)}</td></tr>`).join('')

  const kpis = [
    ['הכנסות', f(d.income)],
    ['הוצאות (ברוטו)', f(d.expenses)],
  ]
  if (d.refunds > 0) kpis.push(['החזרים', f(d.refunds)])
  kpis.push(['נטו', f(d.net)], ['שיעור חיסכון', savingsRate + '%'])

  const refundsBlock = d.refundBreakdownTotal > 0
    ? _reportBlock('החזרים לפי קטגוריה', `
        <p class="report-note">החזרים אינם מנוכים מההוצאות שלמעלה. הקטגוריה מציינת מה הוחזר — ההוצאה המקורית יכולה להיות מחודש אחר או מפריסת תשלומים.</p>
        <table class="report-table"><thead><tr><th>קטגוריה</th><th class="num">סכום</th><th class="num">עסקאות</th></tr></thead>
          <tbody>${refRowsHTML}</tbody>
          <tfoot><tr><td>סה"כ</td><td class="num">${f(d.refundBreakdownTotal)}</td><td class="num"></td></tr></tfoot></table>`)
    : ''

  root.innerHTML = `
    <div class="report">
      <div class="report-head">
        <h1>דוח פיננסי – כספים</h1>
        <div class="report-meta">תקופה: ${d.period.label || (d.period.start + ' – ' + d.period.end)} · הופק: ${generated}</div>
      </div>
      <div class="report-summary">
        ${kpis.map(([k, v]) => `<div class="report-kpi"><span>${k}</span><strong>${v}</strong></div>`).join('')}
      </div>

      ${_reportBlock('הוצאות לפי קטגוריה', `
        <table class="report-table"><thead><tr><th>קטגוריה</th><th class="num">סכום</th><th class="num">%</th><th class="num">עסקאות</th></tr></thead>
          <tbody>${expRowsHTML || '<tr><td colspan="4">אין נתונים</td></tr>'}</tbody></table>`)}

      ${refundsBlock}

      ${_reportBlock('הכנסות לפי קטגוריה', `
        <table class="report-table"><thead><tr><th>קטגוריה</th><th class="num">סכום</th><th class="num">%</th><th class="num">עסקאות</th></tr></thead>
          <tbody>${incRowsHTML || '<tr><td colspan="4">אין נתונים</td></tr>'}</tbody></table>`)}

      ${_reportBlock('רווח והפסד חודשי', `
        <table class="report-table"><thead><tr><th>חודש</th><th class="num">הכנסות</th><th class="num">הוצאות</th><th class="num">החזרים</th><th class="num">נטו</th></tr></thead>
          <tbody>${plRowsHTML}</tbody>
          <tfoot><tr><td>סה"כ</td><td class="num">${f(d.income)}</td><td class="num">${f(d.expenses)}</td><td class="num">${f(d.refunds)}</td><td class="num">${f(d.net)}</td></tr></tfoot></table>`)}

      ${_reportBlock('סיכום למס', `
        <table class="report-table"><tbody>
          <tr><td>סך הכנסות בתקופה</td><td class="num">${f(d.income)}</td></tr>
          <tr><td>מתוכן הכנסה הונית (שבירת חיסכון/דיבידנד)</td><td class="num">${f(d.capitalIncome)}</td></tr>
          <tr><td>החזרי מס שהתקבלו</td><td class="num">${f(taxRefund)}</td></tr>
        </tbody></table>`)}

      <div class="report-foot">הופק מאפליקציית "כספים" · גרסה ${typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''}</div>
    </div>`

  window.print()
}
