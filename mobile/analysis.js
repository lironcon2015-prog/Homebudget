// ===== MOBILE ANALYSIS (Dark Glass) =====
// A native, single-column layout for #screen-analysis. Reuses the desktop ENGINE
// computations + the already-vertical sub-renderers (pie, breakdowns, trend,
// cash-flow), but renders the parts that were desktop TABLES/GRIDS (P&L stats,
// YoY, top vendors) as native mobile cards/rows so nothing overflows sideways.
// renderAnalysis() and _drawAnalysis() both delegate here via IS_MOBILE_UI.

function M_renderAnalysis() {
  const host = document.getElementById('screen-analysis')
  if (!host) return
  host.innerHTML = `
    ${M_topbar('ניתוח ותזרים')}
    <div id="mAnPeriod" class="m-period"></div>

    <div id="mAnStats" class="m-stat-grid"></div>

    ${M_sectionHead('הוצאות לפי קטגוריה')}
    <div class="m-card m-card-chart"><div class="m-chart-wrap m-chart-tall"><canvas id="expensePieChart"></canvas></div></div>
    <div class="m-card" id="expenseBreakdown"></div>

    ${M_sectionHead('הכנסות לפי קטגוריה')}
    <div class="m-card" id="incomeBreakdown"></div>

    ${M_sectionHead('מגמה חודשית')}
    <div class="m-card m-card-chart"><div class="m-chart-wrap"><canvas id="trendChart"></canvas></div></div>

    ${M_accordion('השוואה לשנה קודמת', `<div id="mAnYoY"></div>`)}
    ${M_accordion('דוח תזרים מזומנים', `<div id="cashFlowStatement"></div>`)}
    ${M_accordion('ספקים מובילים', `<div id="mAnVendors"></div>`)}
    ${M_accordion('שאל את ה-AI 🤖', `
      <div id="chatMessages" class="m-chat-messages"></div>
      <label class="m-check" style="margin:.5rem 0"><input type="checkbox" onchange="toggleChatDeep(this)"> ניתוח מעמיק</label>
      <div class="m-chat-input-row">
        <input id="chatInput" placeholder="שאל על הנתונים…" onkeydown="if(event.key==='Enter')sendChat()">
        <button class="btn-primary" onclick="sendChat()">שלח</button>
      </div>`)}
  `
  M_renderPeriodBar('mAnPeriod', () => M_anDraw())
  M_anDraw()
  if (typeof _renderChat === 'function') _renderChat()
  if (typeof M_syncTabs === 'function') M_syncTabs('analysis')
  if (typeof M_repaintSync === 'function') M_repaintSync()
}

// Re-render all analysis content for the active period. Routed from
// _drawAnalysis() so alias/hide handlers refresh the native layout too.
function M_anDraw() {
  const period = getActivePeriod()
  const all = getTransactions()
  const periodTx = filterByEffectivePeriod(all, period)
  const income = sumIncome(periodTx)

  M_anStats(periodTx)
  if (typeof _renderExpensePie === 'function') _renderExpensePie(periodTx)
  if (typeof _renderExpenseBreakdown === 'function') _renderExpenseBreakdown(periodTx)
  if (typeof _renderIncomeBreakdown === 'function') _renderIncomeBreakdown(periodTx, income)
  if (typeof _renderTrendChart === 'function') _renderTrendChart(all, period)
  M_anYoY(all, period)
  if (typeof _renderCashFlowStatement === 'function') _renderCashFlowStatement(all, period)
  M_anVendors(periodTx)
}

// P&L stat cards — native 2-col grid, concise labels, no verbose tooltips.
function M_anStats(periodTx) {
  const el = document.getElementById('mAnStats')
  if (!el) return
  const income = sumIncome(periodTx)
  const expenses = sumExpenses(periodTx)
  const net = income - expenses
  const hidden = sumHiddenSavings(periodTx)
  const capital = sumCapitalIncome(periodTx)
  const realIncome = income - capital
  const realSavings = net + hidden - capital
  const savingsPct = realIncome > 0 ? (realSavings / realIncome * 100) : 0
  const recur = (typeof recurringMonthlyTotals === 'function') ? recurringMonthlyTotals() : { count: 0, net: 0 }

  const cards = [
    { label: 'סך הכנסות', val: formatCurrency(income), cls: 'pos' },
    { label: 'סך הוצאות', val: formatCurrency(expenses), cls: 'neg' },
    { label: 'רווח / הפסד', val: formatCurrency(net), cls: net >= 0 ? 'pos' : 'neg' },
    { label: 'אחוז חיסכון', val: savingsPct.toFixed(1) + '%', cls: savingsPct >= 0 ? 'pos' : 'neg' },
  ]
  if (hidden > 0) cards.push({ label: 'חיסכון חבוי', val: formatCurrency(hidden), cls: 'pos' })
  if (recur.count > 0) cards.push({ label: 'קבוע חודשי', val: formatCurrency(recur.net), cls: recur.net >= 0 ? 'pos' : 'neg' })

  el.innerHTML = cards.map(c => `
    <div class="m-stat">
      <div class="m-stat-label">${c.label}</div>
      <div class="m-stat-val ${c.cls}">${c.val}</div>
    </div>`).join('')
}

// Year-over-year — native stacked rows (current / last year / Δ%), no wide grid.
function M_anYoY(all, period) {
  const el = document.getElementById('mAnYoY')
  if (!el) return
  if (typeof shiftPeriodByYear !== 'function') { el.innerHTML = ''; return }
  const cur = filterByEffectivePeriod(all, period)
  const prv = filterByEffectivePeriod(all, shiftPeriodByYear(period, 1))
  const ci = sumIncome(cur), pi = sumIncome(prv)
  const ce = sumExpenses(cur), pe = sumExpenses(prv)
  const cn = ci - ce, pn = pi - pe
  const delta = (c, p) => p === 0 ? (c === 0 ? 0 : 100) : ((c - p) / Math.abs(p) * 100)
  const row = (label, c, p, goodUp) => {
    const d = delta(c, p)
    const good = goodUp ? d >= 0 : d <= 0
    return `<div class="m-yoy-row">
      <span class="m-yoy-label">${label}</span>
      <span class="m-yoy-cur">${formatCurrency(c)}</span>
      <span class="m-yoy-prev m-muted">${formatCurrency(p)}</span>
      <span class="m-yoy-delta ${good ? 'pos' : 'neg'}">${d >= 0 ? '+' : ''}${d.toFixed(0)}%</span>
    </div>`
  }
  el.innerHTML = `
    <div class="m-yoy-head"><span></span><span>נוכחי</span><span>אשתקד</span><span>שינוי</span></div>
    ${row('הכנסות', ci, pi, true)}
    ${row('הוצאות', ce, pe, false)}
    ${row('נטו', cn, pn, true)}`
}

// Top vendors — native rows with avatar, tap → existing vendor drill modal.
let M_anVendorMap = {}
function M_anVendors(periodTx) {
  const el = document.getElementById('mAnVendors')
  if (!el) return
  const savingsInvestIds = analysisExpenseSavingsInvestIds()
  const ccAccsWithDetail = ccAccountsWithDetail(periodTx)
  const byVendor = {}
  periodTx.forEach(t => {
    const ca = analysisExpenseAmount(t, savingsInvestIds, ccAccsWithDetail)
    if (ca <= 0) return
    const raw = (t.vendor || '—').trim()
    const display = resolveVendor(raw, t.amount, getTxAliasDay(t)) || raw || '—'
    if (!byVendor[display]) byVendor[display] = { displayName: display, total: 0, count: 0 }
    byVendor[display].total += ca
    byVendor[display].count++
  })
  const hidden = new Set((typeof getHiddenTopVendors === 'function') ? getHiddenTopVendors() : [])
  const rows = Object.values(byVendor).filter(r => !hidden.has(r.displayName)).sort((a, b) => b.total - a.total).slice(0, 10)
  M_anVendorMap = {}
  rows.forEach((r, i) => { M_anVendorMap['v' + i] = r.displayName })
  el.innerHTML = rows.length === 0
    ? '<p class="m-empty-line">אין נתונים</p>'
    : rows.map((r, i) => {
        const avatar = (typeof UK_vendorAvatar === 'function') ? UK_vendorAvatar(r.displayName, { size: 40 }) : '<div class="tx-avatar">🏷️</div>'
        return `<div class="m-tx-row" onclick="M_anOpenVendor('v${i}')">
          ${avatar}
          <div class="m-tx-mid"><div class="m-tx-name">${r.displayName}</div><div class="m-tx-sub">${r.count} עסקאות</div></div>
          <div class="m-tx-amt neg">${formatCurrency(r.total)}</div>
        </div>`
      }).join('')
}

function M_anOpenVendor(idx) {
  const name = M_anVendorMap[idx]
  if (name && typeof openVendorDrill === 'function') openVendorDrill(name)
}

// Collapsible section (native <details>); resize charts on open.
function M_accordion(title, innerHTML) {
  return `<details class="m-acc" ontoggle="M_anResizeCharts()">
    <summary class="m-acc-summary">${title}<span class="m-acc-chev">›</span></summary>
    <div class="m-acc-body">${innerHTML}</div>
  </details>`
}

function M_anResizeCharts() {
  try { if (typeof _pieChart !== 'undefined' && _pieChart) _pieChart.resize() } catch (e) {}
  try { if (typeof _trendChart !== 'undefined' && _trendChart) _trendChart.resize() } catch (e) {}
}
