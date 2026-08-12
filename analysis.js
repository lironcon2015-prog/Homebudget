let _pieChart = null
let _trendChart = null
let _yoyChart = null

function renderAnalysis() {
  if (typeof IS_MOBILE_UI !== 'undefined' && IS_MOBILE_UI && typeof M_renderAnalysis === 'function') return M_renderAnalysis()
  renderPeriodSelector('analysisPeriodSelector', () => _drawAnalysis())
  _drawAnalysis()
}

// Shared entry point for the desktop and mobile analysis renderers: resolves
// the period once and hands back both the lensed sets (exclusions applied) and
// the raw ones. `rawPeriodTx` is what the exclusion picker and the banner
// measure against — they have to show what was removed, so they cannot look at
// a set it was already removed from.
function analysisTxSets() {
  const period = getActivePeriod()
  const excl = analysisExcludedCatSet()
  const allRaw = getTransactions()
  const rawPeriodTx = filterByEffectivePeriod(allRaw, period)
  _analysisRawPeriodTx = rawPeriodTx
  return {
    period, excl, allRaw, rawPeriodTx,
    all: applyAnalysisExclusions(allRaw, excl),
    periodTx: applyAnalysisExclusions(rawPeriodTx, excl),
  }
}

function _drawAnalysis() {
  if (typeof IS_MOBILE_UI !== 'undefined' && IS_MOBILE_UI && typeof M_anDraw === 'function') return M_anDraw()
  const { period, excl, allRaw, rawPeriodTx, all, periodTx } = analysisTxSets()
  document.getElementById('analysisPeriodLabel').textContent = period.label || `${period.start} → ${period.end}`
  _renderAnalysisExcludeBanner('analysisExcludeBanner', rawPeriodTx, excl)

  const income         = sumIncome(periodTx)
  const expenses       = sumExpenses(periodTx)
  const refunds        = sumRefunds(periodTx)
  const hiddenSavings  = sumHiddenSavings(periodTx)
  const capitalIncome  = sumCapitalIncome(periodTx)
  const net            = income - expenses + refunds
  // "True savings rate" treats hidden-savings expenses as kept money and
  // strips capital income (dividends, asset sales, savings withdrawals)
  // so it reflects only what we saved out of real earned income:
  //   realIncome   = income - capitalIncome
  //   realSavings  = net + hiddenSavings - capitalIncome
  //   savingsPct   = realSavings / realIncome
  const pnlPct       = income > 0 ? (net / income * 100) : 0
  const realIncome   = income - capitalIncome
  const realSavings  = net + hiddenSavings - capitalIncome
  const savingsPct   = realIncome > 0 ? (realSavings / realIncome * 100) : 0
  const hasHidden    = hiddenSavings > 0
  const hasCapital   = capitalIncome > 0
  const showSavingsCard = hasHidden || hasCapital

  const cards = [
    { label: 'סך הכנסות', value: income,   color: 'var(--income)',  icon: uiIcon('trendingup', 18), bg: 'var(--income-bg)' },
    { label: 'סך הוצאות', value: expenses, color: 'var(--expense)', icon: uiIcon('trendingdown', 18), bg: 'var(--expense-bg)' },
    { label: 'רווח / הפסד', value: net,    color: net>=0?'var(--income)':'var(--expense)', icon: uiIcon('chart', 18), bg: net>=0?'var(--income-bg)':'var(--expense-bg)' },
    { label: showSavingsCard ? 'רווח/הפסד כאחוז מהכנסה' : 'אחוז חיסכון', value: pnlPct,
      color: pnlPct>=0?'var(--income)':'var(--expense)', icon: uiIcon('percent', 18),
      bg: pnlPct>=0?'var(--income-bg)':'var(--expense-bg)', pct: true,
      tooltip: '(הכנסות − הוצאות) / הכנסות — רווח/הפסד מתוך סך ההכנסה' },
  ]
  if (refunds > 0) {
    cards.push({
      label: 'החזרים', value: refunds, color: 'var(--refund)',
      icon: uiIcon('undo', 18), bg: 'var(--refund-bg)',
      tooltip: 'כסף שחזר בתקופה. ההוצאות מוצגות ברוטו — ההחזר נספר כאן ובנטו',
    })
  }
  if (showSavingsCard) {
    const parts = []
    if (hasHidden)  parts.push(`+ ${formatCurrency(hiddenSavings)} חסכונות חבויים`)
    if (hasCapital) parts.push(`− ${formatCurrency(capitalIncome)} הכנסה הונית`)
    cards.push({
      label: 'אחוז חיסכון אמיתי',
      value: savingsPct,
      color: savingsPct>=0?'var(--income)':'var(--expense)', icon: uiIcon('vault', 18),
      bg: savingsPct>=0?'var(--income-bg)':'var(--expense-bg)', pct: true,
      tooltip: 'מוסיף בחזרה הוצאות שסומנו כחיסכון ומנטרל הכנסה הונית'
    })
  }
  // Recurring monthly-equivalent — surfaces the "fixed slice" alongside
  // the period totals. Cadence-intrinsic, not period-bound.
  if (typeof recurringMonthlyTotals === 'function') {
    const rt = recurringMonthlyTotals()
    if (rt.count > 0) {
      cards.push({
        label: 'קבועות חודשי שקול',
        value: rt.net,
        color: rt.net >= 0 ? 'var(--income)' : 'var(--expense)',
        icon: uiIcon('refresh', 18),
        bg: rt.net >= 0 ? 'var(--income-bg)' : 'var(--expense-bg)',
        tooltip: `${rt.count} פעולות קבועות · חודשי שקול`
      })
    }
  }
  document.getElementById('pnlStats').innerHTML = cards.map(s => `
    <div class="stat-card" ${s.tooltip?`title="${s.tooltip}"`:''}>
      <div class="stat-icon" style="background:${s.bg}">${s.icon}</div>
      <div>
        <div class="stat-label">${s.label}</div>
        <div class="stat-value" style="color:${s.color}">${s.pct ? s.value.toFixed(1) + '%' : formatCurrency(s.value)}</div>
      </div>
    </div>`).join('')

  // Expense pie (excludes CC-payment bank rows — details live in CC account)
  _renderExpensePie(periodTx)

  // Expense breakdown (same scope as pie, in list form)
  _renderExpenseBreakdown(periodTx)

  // Income breakdown
  _renderIncomeBreakdown(periodTx, income)

  // Trend chart: 12 months ending at period.end
  _renderTrendChart(all, period)

  // YoY comparison
  _renderYoY(all, period)

  // Cash flow statement — deliberately on the RAW set. It reconciles opening
  // and closing balances that came from real account data, so neutralizing an
  // outflow here would leave a statement whose middle no longer explains its
  // ends. It carries a note instead while the lens is on.
  _renderCashFlowStatement(allRaw, period, excl.size > 0)

  // Top vendors
  _renderTopVendors(periodTx)
}

// ===== EXCLUSION LENS UI =====
// Raw (un-lensed) period transactions from the last draw. The picker and the
// banner must measure what the lens removed, so they read this rather than the
// filtered set every other renderer gets.
let _analysisRawPeriodTx = []

function _analysisExclLabel(id) {
  if (id === ANALYSIS_EXCL_UNCATEGORIZED) return 'לא מסווג'
  const c = getCategoryById(id)
  return c ? c.name : 'קטגוריה שנמחקה'
}

// An active lens must never be silent: the totals above this banner are not
// the user's real totals, and a filter left on from last week would otherwise
// read as a genuinely cheaper month.
function _renderAnalysisExcludeBanner(elId, rawPeriodTx, excl) {
  const el = document.getElementById(elId)
  if (!el) return
  if (!excl || excl.size === 0) { el.innerHTML = ''; return }
  const removed = sumAnalysisExcluded(rawPeriodTx, excl)
  const chips = [...excl].map(id => `<span class="excl-chip">${escHtml(_analysisExclLabel(id))}</span>`).join('')
  el.innerHTML = `
    <div class="excl-banner">
      <span class="excl-banner-title">${uiIcon('eyeoff', 14)} מנוטרל מהניתוח</span>
      <span class="excl-banner-cats">${chips}</span>
      <span class="excl-banner-amt">${formatCurrency(removed)}</span>
      <button class="excl-banner-clear" onclick="clearAnalysisExclusions()">בטל נטרול</button>
    </div>`
}

function clearAnalysisExclusions() {
  saveAnalysisExcludedCats([])
  _drawAnalysis()
}

// Category id → checkbox id, so ids carrying Hebrew or punctuation never have
// to survive an inline onclick (same reasoning as _recKeyMap elsewhere).
let _exclRowMap = {}

function openAnalysisExcludeModal() {
  const modal = document.getElementById('analysisExcludeModal')
  const body = document.getElementById('analysisExcludeModalBody')
  if (!modal || !body) return
  const excl = analysisExcludedCatSet()
  const totals = analysisExcludableTotals(_analysisRawPeriodTx)

  // Alphabetical by name (getCategoriesSorted) — this is a picker the user
  // scans by name. The period amount rides along so the choice is informed.
  const rows = getCategoriesSorted()
    .filter(c => c.type === 'expense')
    .map(c => ({ key: c.id, name: c.name, total: totals.get(c.id) || 0 }))
  if (totals.has(ANALYSIS_EXCL_UNCATEGORIZED) || excl.has(ANALYSIS_EXCL_UNCATEGORIZED)) {
    rows.push({ key: ANALYSIS_EXCL_UNCATEGORIZED, name: 'לא מסווג', total: totals.get(ANALYSIS_EXCL_UNCATEGORIZED) || 0 })
  }
  // A category deleted while still excluded would otherwise be un-uncheckable.
  for (const id of excl) {
    if (!rows.some(r => r.key === id)) rows.push({ key: id, name: _analysisExclLabel(id), total: totals.get(id) || 0 })
  }

  _exclRowMap = {}
  const rowHtml = (r, i) => {
    const cid = 'exclRow' + i
    _exclRowMap[cid] = r.key
    return `
      <label class="excl-row" for="${cid}">
        <input type="checkbox" id="${cid}" ${excl.has(r.key) ? 'checked' : ''}>
        <span class="excl-row-name">${escHtml(r.name)}</span>
        <span class="excl-row-amt">${r.total ? formatCurrency(r.total) : '—'}</span>
      </label>`
  }
  // Two groups, each alphabetical by name: a category with no spend this
  // period is not what the user came here to neutralize, but it still has to
  // be listed — a category left checked from another period must always have a
  // row to uncheck.
  const spent = rows.filter(r => r.total !== 0)
  const idle  = rows.filter(r => r.total === 0)
  let n = 0
  const section = (title, list) => list.length === 0 ? ''
    : `<div class="excl-group-title">${title}</div>${list.map(r => rowHtml(r, n++)).join('')}`
  const html = section('הוצאות בתקופה', spent) + section('ללא הוצאה בתקופה', idle)

  body.innerHTML = `
    <p class="excl-help">קטגוריות מסומנות יוצאו מכל חישובי הניתוח — כרטיסי הסיכום, הגרפים, הפירוט והמגמה — כאילו הכסף לא יצא. הנתונים עצמם לא משתנים, וגם לא לוח הבקרה.</p>
    <div class="excl-presets">
      <button class="btn-ghost" onclick="_exclSelectSavings()">סמן חסכונות והשקעות</button>
      <button class="btn-ghost" onclick="_exclSelectNone()">נקה סימון</button>
    </div>
    <div class="excl-list">${html || '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:1.5rem">אין קטגוריות הוצאה</p>'}</div>`
  modal.classList.add('open')
}

function closeAnalysisExcludeModal() {
  const modal = document.getElementById('analysisExcludeModal')
  if (modal) modal.classList.remove('open')
}

function _exclSetChecked(keys) {
  const want = new Set(keys)
  Object.entries(_exclRowMap).forEach(([cid, key]) => {
    const el = document.getElementById(cid)
    if (el) el.checked = want.has(key)
  })
}

// The isSavings flag is already the app's definition of "money I kept, not
// money I consumed" — reuse it instead of matching on category names.
function _exclSelectSavings() {
  _exclSetChecked(getCategories().filter(c => c.type === 'expense' && c.isSavings).map(c => c.id))
}
function _exclSelectNone() { _exclSetChecked([]) }

function applyAnalysisExcludeModal() {
  const picked = Object.entries(_exclRowMap)
    .filter(([cid]) => { const el = document.getElementById(cid); return el && el.checked })
    .map(([, key]) => key)
  saveAnalysisExcludedCats(picked)
  closeAnalysisExcludeModal()
  _drawAnalysis()
}

function _renderExpensePie(periodTx) {
  const savingsInvestIds = analysisExpenseSavingsInvestIds()
  const ccAccsWithDetail = ccAccountsWithDetail(periodTx)
  const expByCat = {}
  periodTx.forEach(t => {
    const ca = analysisExpenseAmount(t, savingsInvestIds, ccAccsWithDetail)
    if (ca <= 0) return
    const cat = getCategoryById(t.categoryId)
    const key = cat?.id || '__none__'
    if (!expByCat[key]) expByCat[key] = { name: cat?.name||'לא מסווג', color: cat?.color||'#64748b', total: 0 }
    expByCat[key].total += ca
  })
  const expRows = Object.values(expByCat).map((r, i) => ({ ...r, catId: Object.keys(expByCat)[i] })).sort((a,b)=>b.total-a.total)

  if (_pieChart) _pieChart.destroy()
  const ctx = document.getElementById('expensePieChart').getContext('2d')
  if (expRows.length > 0) {
    _pieChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: expRows.map(r=>r.name),
        datasets: [{ data: expRows.map(r=>r.total), backgroundColor: expRows.map(r=>r.color), borderWidth: 2, borderColor: CHART_COLORS.surface }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        onClick: (_evt, items) => {
          if (items.length === 0) return
          const idx = items[0].index
          const cid = expRows[idx]?.catId
          if (cid) goToTransactionsByCategory(cid)
        },
        onHover: (evt, items) => {
          evt.native.target.style.cursor = items.length > 0 ? 'pointer' : 'default'
        },
        plugins: {
          legend: { position: 'bottom', labels: { color: CHART_COLORS.ticks, font: { family: CHART_COLORS.font, size: 11 }, padding: 10 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${formatCurrencyPlain(ctx.raw)}` } }
        }
      }
    })
  }
}

// Navigate to transactions filtered by a category. catId may be '__none__'.
function goToTransactionsByCategory(catId) {
  // If we were drilling from the "all categories" expand modal, close it so the
  // filtered transactions are actually visible (it otherwise covers the screen).
  if (typeof closeExpenseBreakdownModal === 'function') closeExpenseBreakdownModal()
  // Remember where we came from so the transactions screen can offer a back bar.
  if (typeof txSetReturnContext === 'function' && typeof _currentScreen === 'string' && _currentScreen && _currentScreen !== 'transactions') {
    const cat = (typeof getCategoryById === 'function') ? getCategoryById(catId) : null
    txSetReturnContext({ screen: _currentScreen, fromLabel: 'חזרה', label: cat ? cat.name : '' })
  }
  navigate('transactions')
  // navigate() synchronously calls renderTransactions() which builds the
  // filter dropdown; we can safely set the value immediately after.
  const sel = document.getElementById('txCategoryFilter')
  if (sel) {
    sel.value = catId
    if (typeof _txPage !== 'undefined') _txPage = 0
    _drawTxTable()
  }
}

// Keep latest expense rows at module scope so the "expand" modal can render
// the full list without re-computing on its own.
let _expenseBreakdownAll = []

// Share of the period's total expenses. Sub-0.1% rows would all read "0.0%",
// so they collapse to a single "<0.1%" instead of looking like zero spending.
function _catSharePct(total, totalForPct) {
  if (!(totalForPct > 0)) return ''
  const pct = total / totalForPct * 100
  if (pct > 0 && pct < 0.1) return '<0.1%'
  return pct.toFixed(1) + '%'
}

function _expenseBreakdownRowHtml(r, totalForPct) {
  const share = _catSharePct(r.total, totalForPct)
  return `
    <div class="cat-bar-item cat-bar-clickable" onclick="goToTransactionsByCategory('${r.catId}')" title="לחץ כדי לראות עסקאות בקטגוריה זו">
      <div class="cat-bar-header">
        <span>${escHtml(r.name)}</span>
        <span class="cat-bar-vals"><span class="cat-bar-pct">${share}</span><span style="color:var(--expense);font-weight:600">${formatCurrency(r.total)}</span></span>
      </div>
      <div class="cat-bar-track">
        <div class="cat-bar-fill" style="width:${totalForPct>0?Math.round(r.total/totalForPct*100):0}%;background:${r.color}"></div>
      </div>
    </div>`
}

function _renderExpenseBreakdown(periodTx) {
  const savingsInvestIds = analysisExpenseSavingsInvestIds()
  const ccAccsWithDetail = ccAccountsWithDetail(periodTx)
  const expByCat = {}
  let totalForPct = 0
  periodTx.forEach(t => {
    const ca = analysisExpenseAmount(t, savingsInvestIds, ccAccsWithDetail)
    if (ca <= 0) return
    const cat = getCategoryById(t.categoryId)
    const key = cat?.id || '__none__'
    if (!expByCat[key]) expByCat[key] = { name: cat?.name || 'לא מסווג', color: cat?.color || '#64748b', total: 0 }
    expByCat[key].total += ca
    totalForPct += ca
  })
  const rows = Object.values(expByCat).map((r, i) => ({ ...r, catId: Object.keys(expByCat)[i] })).sort((a,b) => b.total - a.total)
  _expenseBreakdownAll = { rows, totalForPct }

  // Refund credits sit below the bars, outside the % base: the percentages
  // describe how gross spending split, and a credit is not a share of it.
  const refundLine = refundBucketLineHTML(refundBreakdownByCategory(periodTx))
  const container = document.getElementById('expenseBreakdown')
  if (rows.length === 0) {
    container.innerHTML = refundLine ||
      '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:2rem">אין הוצאות לתקופה</p>'
    return
  }
  const top = rows.slice(0, 10)
  const more = rows.length - top.length
  const expandBtn = more > 0
    ? `<button class="btn-ghost" style="width:100%;margin-top:.5rem;font-size:.85rem" onclick="openExpenseBreakdownModal()">הצג את כל ${rows.length} הקטגוריות (+${more})</button>`
    : ''
  container.innerHTML = top.map(r => _expenseBreakdownRowHtml(r, totalForPct)).join('') + expandBtn + refundLine
}

function openExpenseBreakdownModal() {
  const { rows = [], totalForPct = 0 } = _expenseBreakdownAll || {}
  const body = document.getElementById('expenseBreakdownModalBody')
  if (!body) return
  body.innerHTML = rows.length === 0
    ? '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:2rem">אין הוצאות</p>'
    : rows.map(r => _expenseBreakdownRowHtml(r, totalForPct)).join('')
  document.getElementById('expenseBreakdownModal').classList.add('open')
}
function closeExpenseBreakdownModal() {
  document.getElementById('expenseBreakdownModal').classList.remove('open')
}

function _renderIncomeBreakdown(periodTx, income) {
  const capIds = getCapitalIncomeCategoryIds()
  const incByCat = {}
  periodTx.filter(isCountedIncome).forEach(t => {
    const cat = getCategoryById(t.categoryId)
    const key = cat?.id || '__none__'
    if (!incByCat[key]) incByCat[key] = { name: cat?.name||'לא מסווג', color: cat?.color||'#22c55e', total: 0, isCapital: !!(cat && capIds.has(cat.id)) }
    incByCat[key].total += t.amount
  })
  const incRows = Object.values(incByCat).map((r, i) => ({ ...r, catId: Object.keys(incByCat)[i] })).sort((a,b)=>b.total-a.total)
  document.getElementById('incomeBreakdown').innerHTML = incRows.length === 0
    ? '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:2rem">אין הכנסות לתקופה</p>'
    : incRows.map(r => `
      <div class="cat-bar-item cat-bar-clickable" onclick="goToTransactionsByCategory('${r.catId}')" title="לחץ כדי לראות עסקאות בקטגוריה זו">
        <div class="cat-bar-header">
          <span>${escHtml(r.name)}${r.isCapital ? ` <span class="cat-capital-badge" title="הכנסה הונית — מנוכה מאחוז החיסכון האמיתי">${uiIcon('trendingdown', 12)}</span>` : ''}</span>
          <span style="color:var(--income);font-weight:600">${formatCurrency(r.total)}</span>
        </div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width:${income>0?Math.round(r.total/income*100):0}%;background:${r.color}"></div>
        </div>
      </div>`).join('')
}

function _renderTrendChart(all, period) {
  // Use period months, but if fewer than 3 months in period, show last 12 ending at period.end
  let months = monthsInPeriod(period)
  if (months.length < 3) {
    const [ey, em] = period.end.split('-').map(Number)
    months = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(ey, em - 1 - i, 1)
      months.push(_ym(d))
    }
  }
  const monthTx = months.map(mo => all.filter(t => getTxEffectiveMonth(t) === mo))
  const incomes = monthTx.map(sumIncome)
  const exps    = monthTx.map(sumExpenses)
  const refs    = monthTx.map(sumRefunds)
  const nets    = incomes.map((v,i) => v - exps[i] + refs[i])
  const labels  = months.map(mo => mo.slice(5) + '/' + mo.slice(2,4))
  const hasRefunds = refs.some(v => v > 0)

  if (_trendChart) _trendChart.destroy()
  const ctx = document.getElementById('trendChart').getContext('2d')
  const trendNetGrad = ctx.createLinearGradient(0, 0, 0, 300)
  trendNetGrad.addColorStop(0, 'rgba(59,130,246,.3)')
  trendNetGrad.addColorStop(1, 'rgba(59,130,246,0)')
  _trendChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: 'bar',  label: 'הכנסות', data: incomes, backgroundColor: CHART_COLORS.incomeBg,  borderRadius: 6, borderSkipped: false },
        { type: 'bar',  label: 'הוצאות', data: exps,    backgroundColor: CHART_COLORS.expenseBg, borderRadius: 6, borderSkipped: false },
        ...(hasRefunds ? [{ type: 'bar', label: 'החזרים', data: refs, backgroundColor: CHART_COLORS.refundBg, borderRadius: 6, borderSkipped: false }] : []),
        { type: 'line', label: 'נטו',    data: nets,    borderColor: CHART_COLORS.accent, backgroundColor: trendNetGrad,
          borderWidth: 2.5, tension: 0.45, fill: true, hidden: true,
          pointRadius: 4, pointBackgroundColor: CHART_COLORS.accent, pointBorderColor: CHART_COLORS.surface, pointBorderWidth: 2 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: CHART_COLORS.muted, font: { family: CHART_COLORS.font, size: 11 }, boxWidth: 12, padding: 16 } } },
      scales: {
        x: { ticks: { color: CHART_COLORS.ticks, font: { family: CHART_COLORS.font, size: 11 } }, grid: { display: false }, border: { display: false } },
        y: { ticks: { color: CHART_COLORS.ticks, font: { family: CHART_COLORS.font, size: 11 }, callback: v => '₪' + (v/1000).toFixed(0) + 'k' },
             grid: { color: CHART_COLORS.grid }, border: { display: false } }
      }
    }
  })
}

function _renderYoY(all, period) {
  const prevPeriod = shiftPeriodByYear(period, 1)
  const curTx = filterByEffectivePeriod(all, period)
  const prvTx = filterByEffectivePeriod(all, prevPeriod)

  const curInc = sumIncome(curTx),  prvInc = sumIncome(prvTx)
  const curExp = sumExpenses(curTx), prvExp = sumExpenses(prvTx)
  const curRef = sumRefunds(curTx),  prvRef = sumRefunds(prvTx)
  const curNet = curInc - curExp + curRef, prvNet = prvInc - prvExp + prvRef

  const delta = (c, p) => p === 0 ? (c === 0 ? 0 : 100) : ((c - p) / Math.abs(p) * 100)
  const dInc = delta(curInc, prvInc)
  const dExp = delta(curExp, prvExp)
  const dRef = delta(curRef, prvRef)
  const dNet = delta(curNet, prvNet)
  const refRow = (curRef > 0 || prvRef > 0) ? `
      <div class="yoy-label">החזרים</div>
      <div class="refund-color">${formatCurrency(curRef)}</div>
      <div class="yoy-muted">${formatCurrency(prvRef)}</div>
      <div class="${dRef>=0?'income-color':'expense-color'}">${dRef>=0?'+':''}${dRef.toFixed(1)}%</div>
` : ''

  document.getElementById('yoyTable').innerHTML = `
    <div class="yoy-grid">
      <div></div>
      <div class="yoy-head">תקופה נוכחית</div>
      <div class="yoy-head">שנה קודמת</div>
      <div class="yoy-head">שינוי</div>

      <div class="yoy-label">הכנסות</div>
      <div class="income-color">${formatCurrency(curInc)}</div>
      <div class="yoy-muted">${formatCurrency(prvInc)}</div>
      <div class="${dInc>=0?'income-color':'expense-color'}">${dInc>=0?'+':''}${dInc.toFixed(1)}%</div>

      <div class="yoy-label">הוצאות</div>
      <div class="expense-color">${formatCurrency(curExp)}</div>
      <div class="yoy-muted">${formatCurrency(prvExp)}</div>
      <div class="${dExp<=0?'income-color':'expense-color'}">${dExp>=0?'+':''}${dExp.toFixed(1)}%</div>
${refRow}
      <div class="yoy-label">נטו</div>
      <div class="${curNet>=0?'income-color':'expense-color'}">${formatCurrency(curNet)}</div>
      <div class="yoy-muted">${formatCurrency(prvNet)}</div>
      <div class="${dNet>=0?'income-color':'expense-color'}">${dNet>=0?'+':''}${dNet.toFixed(1)}%</div>
    </div>`

  if (_yoyChart) _yoyChart.destroy()
  const ctx = document.getElementById('yoyChart').getContext('2d')
  _yoyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: refRow ? ['הכנסות', 'הוצאות', 'החזרים', 'נטו'] : ['הכנסות', 'הוצאות', 'נטו'],
      datasets: [
        { label: 'שנה קודמת',    data: refRow ? [prvInc, prvExp, prvRef, prvNet] : [prvInc, prvExp, prvNet], backgroundColor: CHART_COLORS.mutedBg, borderRadius: 6, borderSkipped: false },
        { label: 'תקופה נוכחית', data: refRow ? [curInc, curExp, curRef, curNet] : [curInc, curExp, curNet], backgroundColor: CHART_COLORS.accentBg, borderRadius: 6, borderSkipped: false },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: CHART_COLORS.muted, font: { family: CHART_COLORS.font, size: 11 }, boxWidth: 12, padding: 16 } } },
      scales: {
        x: { ticks: { color: CHART_COLORS.ticks, font: { family: CHART_COLORS.font, size: 11 } }, grid: { display: false }, border: { display: false } },
        y: { ticks: { color: CHART_COLORS.ticks, font: { family: CHART_COLORS.font, size: 11 }, callback: v => '₪' + (v/1000).toFixed(0) + 'k' },
             grid: { color: CHART_COLORS.grid }, border: { display: false } }
      }
    }
  })
}

function _renderCashFlowStatement(all, period, exclActive) {
  const periodTx = filterByEffectivePeriod(all, period)
  // Local-time date math — new Date('YYYY-MM-DD') parses as UTC midnight and
  // can land on the wrong calendar day in negative-offset timezones.
  const [psY, psM, psD] = period.start.split('-').map(Number)
  const dayBefore = _iso(new Date(psY, psM - 1, psD - 1))
  // Use checking+cash balance only (reliable, mirrors imported bank data).
  const startBal = getCheckingCashBalance(dayBefore)
  const endBal   = getCheckingCashBalance(period.end)
  const income   = sumIncome(periodTx)
  const expense  = sumExpenses(periodTx)
  // Own line, not netted into the expense row: the expense row is what left the
  // account this period, the refund row is what came back into it. Both sides
  // are real cash movements, so the statement still reconciles to the balances.
  const refunds  = sumRefunds(periodTx)
  const netOp    = income - expense + refunds

  document.getElementById('cashFlowStatement').innerHTML = `
    <div class="cf-row"><span>יתרת עו"ש/מזומן פותחת (${formatDate(period.start)})</span><span style="font-weight:700">${formatCurrency(startBal)}</span></div>
    <div class="cf-row cf-income"><span>+ הכנסות</span><span>${formatCurrency(income)}</span></div>
    <div class="cf-row cf-expense"><span>− הוצאות</span><span>${formatCurrency(expense)}</span></div>
    ${refunds > 0 ? `<div class="cf-row cf-refund"><span>+ החזרים</span><span>${formatCurrency(refunds)}</span></div>` : ''}
    <div class="cf-row cf-net"><span>תזרים תפעולי נטו</span><span>${netOp >= 0 ? '+' : ''}${formatCurrency(netOp)}</span></div>
    <div class="cf-row cf-total"><span>יתרת עו"ש/מזומן סוגרת (${formatDate(period.end)})</span><span>${formatCurrency(endBal)}</span></div>
    ${exclActive ? '<p class="cf-note">תזרים מזומנים מוצג ללא נטרול — היתרות הן כסף שבאמת יצא ונכנס.</p>' : ''}
  `
}

// Top vendors grouping uses the ALIASED (display) name so unified vendors
// cluster together. Clicking a row opens a vendor drill modal showing every
// underlying raw vendor + all transactions, with the option to alias.
//
// SCOPE: must match the expense breakdown (analysisExpenseAmount) so vendors
// that don't appear in "הוצאות לפי קטגוריה" never show up here. That excludes
// the lump-sum CC payment bank row (its detail CC lines already contribute)
// and the savings/investment-side rows.
let _topVendorMap = {}  // idx → { displayName, rawVendors: Set<string> }

function getHiddenTopVendors() { return DB.get('finHiddenTopVendors', []) }
function saveHiddenTopVendors(list) { DB.set('finHiddenTopVendors', list) }

function hideTopVendor(displayName) {
  const list = getHiddenTopVendors()
  if (!list.includes(displayName)) {
    list.push(displayName)
    saveHiddenTopVendors(list)
  }
  _drawAnalysis()
}

function unhideTopVendor(displayName) {
  saveHiddenTopVendors(getHiddenTopVendors().filter(n => n !== displayName))
  _drawAnalysis()
}

function hideTopVendorByIdx(idx) {
  const entry = _topVendorMap[idx]
  if (!entry) return
  hideTopVendor(entry.displayName)
}

function toggleHiddenTopVendorsList() {
  const el = document.getElementById('hiddenTopVendorsList')
  if (!el) return
  el.classList.toggle('open')
}

function _renderTopVendors(periodTx) {
  const savingsInvestIds = analysisExpenseSavingsInvestIds()
  const ccAccsWithDetail = ccAccountsWithDetail(periodTx)
  const byVendor = {}
  periodTx.forEach(t => {
    const ca = analysisExpenseAmount(t, savingsInvestIds, ccAccsWithDetail)
    if (ca <= 0) return
    const raw = (t.vendor || '—').trim()
    const display = resolveVendor(raw, t.amount, getTxAliasDay(t)) || raw || '—'
    if (!byVendor[display]) byVendor[display] = { displayName: display, total: 0, count: 0, rawVendors: new Set() }
    byVendor[display].total += ca
    byVendor[display].count++
    if (raw) byVendor[display].rawVendors.add(raw)
  })
  const hidden = new Set(getHiddenTopVendors())
  const allSorted = Object.values(byVendor).sort((a,b) => b.total - a.total)
  const visible   = allSorted.filter(r => !hidden.has(r.displayName))
  const rows      = visible.slice(0, 10)
  const hiddenRows = allSorted.filter(r => hidden.has(r.displayName))
  // Hidden vendors the user hid but don't exist in current period — keep so they can still be unhidden
  const hiddenOrphans = [...hidden].filter(n => !byVendor[n]).map(n => ({ displayName: n, total: 0, count: 0, rawVendors: new Set() }))
  const hiddenAll = [...hiddenRows, ...hiddenOrphans]

  _topVendorMap = {}
  rows.forEach((r, i) => { _topVendorMap['v' + i] = { displayName: r.displayName, rawVendors: [...r.rawVendors] } })

  const escapeAttr = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;')

  const tableHtml = rows.length === 0
    ? '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:1.5rem">אין נתונים</p>'
    : `<table class="data-table top-vendors-table" style="font-size:.85rem">
        <thead><tr><th>ספק</th><th>עסקאות</th><th>סה"כ</th><th style="width:2.5rem"></th></tr></thead>
        <tbody>${rows.map((r, i) => {
          const aliased = r.rawVendors.size > 1 ? ` <span title="מאוחד מ-${r.rawVendors.size} שמות" style="font-size:.72rem;color:var(--text-muted)">${uiIcon('link', 11)}</span>` : ''
          return `<tr class="vendor-row">
            <td style="font-weight:500" onclick="openVendorDrillByIdx('v${i}')" title="לחץ כדי לראות את כל העסקאות">${escHtml(r.displayName)}${aliased}</td>
            <td onclick="openVendorDrillByIdx('v${i}')">${r.count}</td>
            <td class="amount-exp" onclick="openVendorDrillByIdx('v${i}')">${formatCurrency(r.total)}</td>
            <td><button class="vendor-hide-btn" onclick="event.stopPropagation();hideTopVendorByIdx('v${i}')" title="הסתר מהרשימה">✕</button></td>
          </tr>`
        }).join('')}</tbody>
      </table>`

  const hiddenToggle = hiddenAll.length === 0 ? '' : `
    <div class="hidden-vendors-wrap">
      <button class="btn-ghost hidden-vendors-toggle" onclick="toggleHiddenTopVendorsList()">
        הצג ספקים מוסתרים (${hiddenAll.length})
      </button>
      <div id="hiddenTopVendorsList" class="hidden-vendors-list">
        ${hiddenAll.map(r => `
          <div class="hidden-vendor-row">
            <span class="hidden-vendor-name">${escHtml(r.displayName)}</span>
            ${r.total > 0 ? `<span class="hidden-vendor-total amount-exp">${formatCurrency(r.total)}</span>` : '<span class="hidden-vendor-total" style="color:var(--text-muted);font-size:.75rem">—</span>'}
            <button class="btn-ghost hidden-vendor-restore" onclick="unhideTopVendor('${escapeAttr(r.displayName)}')" title="החזר לרשימה">↩ החזר</button>
          </div>`).join('')}
      </div>
    </div>`

  document.getElementById('topVendors').innerHTML = tableHtml + hiddenToggle
}

// ===== VENDOR DRILL =====
// State for the drill modal. We store by displayName (post-alias) so the
// drill shows ALL transactions the user considers "the same vendor" — even
// after creating a new alias the modal updates live.
let _vendorDrill = null  // { displayName: string, range: '3m'|'6m'|'12m'|'all'|'custom', customStart, customEnd }

function openVendorDrillByIdx(idx) {
  const entry = _topVendorMap[idx]
  if (!entry) return
  openVendorDrill(entry.displayName)
}

function openVendorDrill(displayName) {
  _vendorDrill = { displayName, range: '12m', customStart: '', customEnd: '' }
  _renderVendorDrill()
  document.getElementById('vendorDrillModal').classList.add('open')
}

function closeVendorDrill() {
  document.getElementById('vendorDrillModal').classList.remove('open')
  _vendorDrill = null
}

function setVendorDrillRange(range) {
  if (!_vendorDrill) return
  _vendorDrill.range = range
  _renderVendorDrill()
}

function applyVendorDrillCustom() {
  if (!_vendorDrill) return
  _vendorDrill.customStart = _dmyToIso(document.getElementById('vendorDrillCustomStart').value)
  _vendorDrill.customEnd   = _dmyToIso(document.getElementById('vendorDrillCustomEnd').value)
  _vendorDrill.range = 'custom'
  _renderVendorDrill()
}

function _getVendorDrillBounds() {
  const now = new Date()
  const endIso = _iso(now)
  if (_vendorDrill.range === 'all') return { start: '0000-01-01', end: endIso }
  if (_vendorDrill.range === 'custom') {
    return {
      start: _vendorDrill.customStart || _iso(new Date(now.getFullYear(), now.getMonth()-12, 1)),
      end:   _vendorDrill.customEnd   || endIso,
    }
  }
  const monthsBack = _vendorDrill.range === '12m' ? 12 : _vendorDrill.range === '6m' ? 6 : 3
  return { start: _iso(new Date(now.getFullYear(), now.getMonth() - monthsBack, 1)), end: endIso }
}

function _renderVendorDrill() {
  if (!_vendorDrill) return
  const { displayName } = _vendorDrill
  document.getElementById('vendorDrillTitle').textContent = `עסקאות – "${displayName}"`

  // Pull ALL tx (any account, any type) whose resolved vendor matches this
  // display name. No P&L filter — the user wants full picture.
  const allTx = getTransactions().filter(t => (resolveVendor(t.vendor, t.amount, getTxAliasDay(t)) || t.vendor || '').trim() === displayName)
  const rawNames = [...new Set(allTx.map(t => (t.vendor || '').trim()).filter(Boolean))]

  const { start, end } = _getVendorDrillBounds()
  const filtered = allTx
    .filter(t => t.date && t.date >= start && t.date <= end)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  const totalAmount = filtered.reduce((s, t) => s + t.amount, 0)
  const totalAbs    = filtered.reduce((s, t) => s + Math.abs(t.amount), 0)
  const avg         = filtered.length > 0 ? totalAmount / filtered.length : 0

  const rangeBtn = (key, label) =>
    `<button class="period-btn ${_vendorDrill.range===key?'active':''}" onclick="setVendorDrillRange('${key}')">${label}</button>`
  const customRow = _vendorDrill.range === 'custom' ? `
    <div class="period-custom" style="display:flex;margin-top:.5rem">
      <label class="form-label" style="margin:0">מ:</label>
      <input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" id="vendorDrillCustomStart" value="${_isoToDmy(_vendorDrill.customStart || start)}" oninput="_onDateMaskInput(this)">
      <label class="form-label" style="margin:0">עד:</label>
      <input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" id="vendorDrillCustomEnd" value="${_isoToDmy(_vendorDrill.customEnd || end)}" oninput="_onDateMaskInput(this)">
      <button class="btn-primary" style="padding:.35rem .9rem" onclick="applyVendorDrillCustom()">החל</button>
    </div>` : ''

  // Alias block: if multiple raw names map here OR this looks like one raw
  // name the user may want to rename, show alias controls.
  const existingAlias = getVendorAliases().find(a => a.displayName === displayName)
  const existingMin = typeof existingAlias?.amountMin === 'number' ? existingAlias.amountMin : ''
  const existingMax = typeof existingAlias?.amountMax === 'number' ? existingAlias.amountMax : ''
  const aliasBlock = `
    <div class="vendor-alias-panel">
      <div class="vendor-alias-head">
        איחוד שמות ספקים
        ${existingAlias ? '<span class="vendor-alias-tag">קיים</span>' : ''}
      </div>
      <div class="vendor-alias-sub">כל ביטוי (שורה אחת לכל אחד) שיימצא בשם הספק יוצג מעתה כ־"${escHtml(displayName)}". ההאחדה חלה מיידית על כל העסקאות הקיימות ועל כל ייבוא עתידי. ניתן להגביל את האיחוד לטווח סכומים — שימושי כשאותה מילת מפתח (למשל "העברה בנקאית") מציינת תשלומים שונים בסכומים שונים.</div>
      <div class="vendor-alias-body">
        <label class="form-label">שם תצוגה</label>
        <input id="vendorAliasDisplayName" value="${(existingAlias?.displayName || displayName).replace(/"/g, '&quot;')}">
        <label class="form-label" style="margin-top:.6rem">ביטויים לזיהוי (שורה לכל אחד)</label>
        <textarea id="vendorAliasPatterns" rows="3" placeholder="למשל:&#10;משיכת שיק 2500&#10;שיק שכירות">${escHtml((existingAlias?.patterns || rawNames).join('\n'))}</textarea>
        <div style="display:flex;gap:.6rem;margin-top:.6rem;flex-wrap:wrap">
          <div style="flex:1;min-width:120px">
            <label class="form-label">סכום מינימום</label>
            <input id="vendorAliasAmountMin" type="number" step="0.01" placeholder="ללא" value="${existingMin}">
          </div>
          <div style="flex:1;min-width:120px">
            <label class="form-label">סכום מקסימום</label>
            <input id="vendorAliasAmountMax" type="number" step="0.01" placeholder="ללא" value="${existingMax}">
          </div>
        </div>
        <div style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem">לסכום מדויק — מלאו את שני השדות עם אותו הערך. ריק = ללא הגבלה. מתבסס על ערך מוחלט.</div>
        <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.6rem">
          ${existingAlias ? `<button class="btn-danger" style="font-size:.8rem;padding:.35rem .8rem" onclick="deleteVendorAliasFromDrill('${existingAlias.id}')">מחק איחוד</button>` : ''}
          <button class="btn-primary" style="font-size:.8rem;padding:.35rem .8rem" onclick="saveVendorAliasFromDrill(${existingAlias ? `'${existingAlias.id}'` : 'null'})">${existingAlias ? 'עדכן איחוד' : 'צור איחוד'}</button>
        </div>
      </div>
    </div>`

  const rawList = rawNames.length > 1
    ? `<div class="vendor-raw-list">נמצא תחת ${rawNames.length} שמות גולמיים: ${rawNames.map(r => `<span class="vendor-raw-chip">${escHtml(r)}</span>`).join(' ')}</div>`
    : ''

  const rows = filtered.length === 0
    ? `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted)">אין עסקאות בתקופה</td></tr>`
    : filtered.map(t => {
        const cat = getCategoryById(t.categoryId)
        const acc = getAccounts().find(a => a.id === t.accountId)
        return `
          <tr>
            <td>${formatDate(t.date)}</td>
            <td style="font-weight:500">${escHtml(t.vendor || '—')}</td>
            <td style="font-size:.78rem;color:var(--text-muted)">${escHtml(acc?.name || '—')}</td>
            <td>${cat ? `<span class="cat-badge" style="background:${cat.color}22;color:${cat.color}">${catIconHTML(cat)} ${escHtml(cat.name)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td class="${t.amount>0?'amount-inc':'amount-exp'}" style="font-weight:600">${t.amount>0?'+':''}${formatCurrency(t.amount)}</td>
          </tr>`
      }).join('')

  document.getElementById('vendorDrillBody').innerHTML = `
    <div class="period-selector" style="margin-bottom:1rem">
      <div class="period-presets">
        ${rangeBtn('3m', '3 חודשים')}
        ${rangeBtn('6m', '6 חודשים')}
        ${rangeBtn('12m', '12 חודשים')}
        ${rangeBtn('all', 'הכל')}
        ${rangeBtn('custom', 'טווח מותאם')}
      </div>
      ${customRow}
    </div>
    <div class="drill-stats">
      <div><span class="drill-stat-label">עסקאות</span><span class="drill-stat-val">${filtered.length}</span></div>
      <div><span class="drill-stat-label">סה"כ</span><span class="drill-stat-val ${totalAmount>=0?'income-color':'expense-color'}">${totalAmount>=0?'+':''}${formatCurrency(totalAmount)}</span></div>
      <div><span class="drill-stat-label">ממוצע</span><span class="drill-stat-val">${formatCurrency(avg)}</span></div>
      <div><span class="drill-stat-label">טווח</span><span class="drill-stat-val" style="font-size:.85rem">${formatDate(start)} – ${formatDate(end)}</span></div>
    </div>
    ${rawList}
    ${aliasBlock}
    <div style="overflow-x:auto;margin-top:1rem">
      <table class="data-table">
        <thead><tr><th>תאריך</th><th>ספק (מקור)</th><th>חשבון</th><th>קטגוריה</th><th style="text-align:left">סכום</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
}

function saveVendorAliasFromDrill(existingId) {
  const displayName = document.getElementById('vendorAliasDisplayName').value.trim()
  const patternsRaw = document.getElementById('vendorAliasPatterns').value
  const minRaw = document.getElementById('vendorAliasAmountMin')?.value
  const maxRaw = document.getElementById('vendorAliasAmountMax')?.value
  const patterns = patternsRaw.split('\n').map(s => s.trim()).filter(Boolean)
  if (!displayName) { toast('שם תצוגה חובה', { type: 'error' }); return }
  if (patterns.length === 0) { toast('יש להזין לפחות ביטוי אחד', { type: 'error' }); return }
  // Preserve any day-of-month constraint set from settings/drill — this modal
  // doesn't expose those fields, so we'd otherwise wipe them on save.
  const prevAlias = (existingId && existingId !== 'null')
    ? (getVendorAliases().find(a => a.id === existingId) || {})
    : {}
  if (existingId && existingId !== 'null') {
    updateVendorAlias(existingId, patterns, displayName, minRaw, maxRaw, prevAlias.dayMin, prevAlias.dayMax)
  } else {
    addVendorAlias(patterns, displayName, minRaw, maxRaw)
  }
  if (_vendorDrill) _vendorDrill.displayName = displayName
  _renderVendorDrill()
  // Re-render the analysis screen so top vendors + breakdown reflect alias
  _drawAnalysis()
}

async function deleteVendorAliasFromDrill(id) {
  if (!await confirmDialog('למחוק את האיחוד? שמות גולמיים יוצגו כמו שהם.', { danger: true, confirmText: 'מחק' })) return
  deleteVendorAlias(id)
  _renderVendorDrill()
  _drawAnalysis()
}

// ===== CHAT =====
let _chatMessages = []
// Opt-in deep mode: widens the transaction window + row cap sent to the model.
// Off by default to keep per-question token cost low; the user flips it on only
// when they explicitly want a deeper, longer-horizon analysis.
let _chatDeepMode = false
function toggleChatDeep(el) { _chatDeepMode = !!el.checked }

async function sendChat() {
  const input = document.getElementById('chatInput')
  const msg = input.value.trim()
  if (!msg) return
  const apiKey = getApiKey()
  if (!apiKey) { toast('חסר מפתח Gemini API – הזן בהגדרות', { type: 'error' }); return }

  input.value = ''
  _chatMessages.push({ role: 'user', text: msg })
  _renderChat(true)

  const context = _buildChatContext(msg)

  try {
    const data = await callGemini(apiKey, { contents:[{ parts:[{ text: context }] }], generationConfig:{ temperature:0.3 } })
    const resParts = data.candidates?.[0]?.content?.parts || []
    let answer = ''
    for (const p of resParts) { if (!p.thought && p.text) { answer = p.text; break } }
    if (!answer) answer = resParts[0]?.text || 'לא התקבלה תשובה'
    _chatMessages.push({ role: 'ai', text: answer })
  } catch(e) {
    _chatMessages.push({ role: 'ai', text: 'שגיאה: ' + e.message })
  }
  _renderChat()
}

function _buildChatContext(question) {
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const period = getActivePeriod()
  const all = getTransactions()
  const cats = getCategories()
  const accs = getAccounts()
  const catName = id => (cats.find(c => c.id === id)?.name) || 'לא מסווג'
  const accInfo = id => accs.find(a => a.id === id)

  const byMonth = {}
  for (const t of all) {
    const em = getTxEffectiveMonth(t)
    if (!em) continue
    if (!byMonth[em]) byMonth[em] = { income: 0, expense: 0, refund: 0, count: 0 }
    if (isCountedIncome(t)) byMonth[em].income += t.amount
    byMonth[em].expense += countedExpenseAmount(t)
    byMonth[em].refund += countedRefundAmount(t)
    byMonth[em].count++
  }
  // Deep mode widens both the monthly horizon and the raw-transaction window.
  const deep = _chatDeepMode
  const monthsBack = deep ? 24 : 12
  const windowDays = deep ? 540 : 120
  const rowCap = deep ? 1500 : 400
  const months = Object.keys(byMonth).sort().slice(-monthsBack)
  const monthlyLines = months.map(m => {
    const b = byMonth[m]
    const net = b.income - b.expense + b.refund
    const ref = b.refund > 0 ? `, החזרים ${Math.round(b.refund)}` : ''
    return `${m}: הכנסות ${Math.round(b.income)}, הוצאות ${Math.round(b.expense)}${ref}, נטו ${net >= 0 ? '+' : ''}${Math.round(net)} (${b.count} עסקאות)`
  })

  // Deep mode only: a month × category expense table over the whole horizon.
  // Unlike the raw-transaction list (which is row-capped), this is aggregated,
  // so it gives complete, gap-free coverage of every month at category
  // resolution for a tiny token cost. Uses analysisExpenseAmount so CC lump
  // payments aren't double-counted against their itemized detail rows.
  let catLines = []
  if (deep) {
    const monthSet = new Set(months)
    const windowTx = all.filter(t => monthSet.has(getTxEffectiveMonth(t)))
    const savingsInvestIds = (typeof analysisExpenseSavingsInvestIds === 'function') ? analysisExpenseSavingsInvestIds() : new Set()
    const ccDetailWin = ccAccountsWithDetail(windowTx)
    const catByMonth = {}
    for (const t of windowTx) {
      const amt = analysisExpenseAmount(t, savingsInvestIds, ccDetailWin)
      if (!amt) continue
      const em = getTxEffectiveMonth(t)
      const cn = catName(t.categoryId)
      if (!catByMonth[em]) catByMonth[em] = {}
      catByMonth[em][cn] = (catByMonth[em][cn] || 0) + amt
    }
    catLines = months.map(m => {
      const row = catByMonth[m]
      if (!row) return `${m}: —`
      const parts = Object.entries(row).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${Math.round(v)}`)
      return `${m}: ${parts.join(' · ')}`
    })
  }

  const accBalances = accs.map(a => {
    const bal = (typeof getAccountBalance === 'function') ? Math.round(getAccountBalance(a.id)) : 0
    return `${a.name} [${a.type}]: ${bal} ₪`
  })

  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - windowDays)
  const cutoffIso = cutoff.toISOString().slice(0, 10)
  const recentRaw = all.filter(t => t.date && t.date >= cutoffIso && t.type !== 'transfer')
  const ccAccsWithDetailChat = ccAccountsWithDetail(recentRaw)
  const recent = recentRaw
    .filter(t => !shouldDropCcLump(t, ccAccsWithDetailChat))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, rowCap)
    .map(t => {
      const acc = accInfo(t.accountId)
      const aliasDay = (typeof getTxAliasDay === 'function') ? getTxAliasDay(t) : null
      const vendor = (typeof resolveVendor === 'function')
        ? (resolveVendor(t.vendor, t.amount, aliasDay) || t.vendor || '')
        : (t.vendor || '')
      return {
        date: t.date,
        effMonth: getTxEffectiveMonth(t),
        amount: Math.round(t.amount),
        vendor: vendor,
        category: catName(t.categoryId),
        account: acc ? `${acc.name}/${acc.type}` : '—',
        type: t.type || 'normal',
      }
    })

  const periodTx = filterByEffectivePeriod(all, period)
  const periodInc = sumIncome(periodTx)
  const periodExp = sumExpenses(periodTx)
  const periodRef = sumRefunds(periodTx)
  const checkingBalance = (typeof getCheckingCashBalance === 'function') ? getCheckingCashBalance() : 0

  return `אתה יועץ פיננסי אישי דובר עברית. ענה בעברית, תמציתי ומקצועי. השתמש בכל הנתונים שמצורפים. אם המשתמש שואל על חודש או טווח שלא תואמים לתקופת הצפייה הפעילה, הסתמך על "סיכום חודשי" ו"עסקאות אחרונות" — אל תגביל את עצמך לתקופה הפעילה.

תאריך היום: ${todayIso}
תקופת הצפייה בממשק כעת: ${period.label || ''} (${period.start} → ${period.end})
סיכום התקופה הפעילה (לפי P&L, חודש חיוב אפקטיבי): הכנסות ${Math.round(periodInc)} ₪, הוצאות ${Math.round(periodExp)} ₪, החזרים ${Math.round(periodRef)} ₪, נטו ${Math.round(periodInc - periodExp + periodRef)} ₪
החזרים הם זרם שלישי: אינם הכנסה ואינם מקטינים את ההוצאות המוצגות (ההוצאות ברוטו), אבל נספרים בנטו ובתזרים. נטו = הכנסות − הוצאות + החזרים.
יתרת עו"ש+מזומן כיום: ${Math.round(checkingBalance)} ₪

יתרות חשבונות (כל סוגי החשבונות):
${accBalances.join('\n')}

סיכום חודשי — עד ${monthsBack} חודשים אחרונים שיש בהם נתונים (effMonth = חודש חיוב אפקטיבי; חיובי אשראי משויכים לחודש שבו ירדו בעו"ש):
${monthlyLines.join('\n')}
${deep ? `\nפירוט חודשי לפי קטגוריה (הוצאות, ${monthsBack} חודשים, כיסוי מלא ללא חיתוך; analysisExpenseAmount — בלי כפל-ספירה של חיובי אשראי מרוכזים):\n${catLines.join('\n')}\n` : ''}
${deep ? 'מצב ניתוח מעמיק מופעל — נתח לעומק, כולל מגמות ארוכות טווח.\n' : ''}עסקאות ${windowDays} הימים האחרונים, ללא העברות (${recent.length} שורות; amount חיובי = הכנסה, שלילי = הוצאה, type=refund עם amount חיובי = החזר — זרם נפרד, לא הכנסה ולא הקטנת הוצאה):
${JSON.stringify(recent)}

שאלת המשתמש: ${question}`
}

function _renderChat(loading = false) {
  const container = document.getElementById('chatMessages')
  if (_chatMessages.length === 0) {
    container.innerHTML = '<div class="chat-empty">שאל שאלה על הנתונים הפיננסיים שלך<br><small>לדוגמה: "מה הקטגוריה היקרה ביותר?"</small></div>'
    return
  }
  container.innerHTML = _chatMessages.map(m => `
    <div class="chat-msg ${m.role}">
      <div class="chat-avatar">${m.role==='user'?'את/ה':'AI'}</div>
      <div class="chat-bubble">${escHtml(m.text).replace(/\n/g, '<br>')}</div>
    </div>`).join('')
  if (loading) container.innerHTML += `
    <div class="chat-msg ai">
      <div class="chat-avatar">AI</div>
      <div class="chat-bubble"><span class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle"></span></div>
    </div>`
  container.scrollTop = container.scrollHeight
}
