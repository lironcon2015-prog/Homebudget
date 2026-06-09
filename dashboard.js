let _monthlyChart = null

function renderDashboard() {
  renderPeriodSelector('dashPeriodSelector', () => renderDashboard())
  const period = getActivePeriod()

  document.getElementById('dashPeriodLabel').textContent = period.label || `${period.start} → ${period.end}`

  const all = getTransactions()
  // Last-import indicator: max(importedAt) across all tx. Discreet subtitle
  // line so the user can tell at a glance how stale the dashboard is without
  // a dedicated card. Tooltip shows the source file when we have one.
  ;(() => {
    const el = document.getElementById('dashLastImport')
    if (!el) return
    let latest = 0, file = ''
    for (const t of all) {
      if (t.importedAt && t.importedAt > latest) { latest = t.importedAt; file = t.sourceFile || '' }
    }
    if (!latest) { el.textContent = ''; el.removeAttribute('title'); return }
    const d = new Date(latest)
    const dmy = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
    const diff = Date.now() - latest
    const days = Math.floor(diff / 86400000)
    const rel = days === 0 ? 'היום' : days === 1 ? 'אתמול' : `לפני ${days} ימים`
    el.textContent = `📥 עדכון אחרון: ${dmy} (${rel})`
    el.title = file ? `קובץ אחרון: ${file}` : ''
  })()
  const periodTx = filterByEffectivePeriod(all, period)

  const income         = sumIncome(periodTx)
  const expenses       = sumExpenses(periodTx)
  const net            = income - expenses
  const hiddenSavings  = sumHiddenSavings(periodTx)
  const capitalIncome  = sumCapitalIncome(periodTx)
  const netHidden      = hiddenSavings - capitalIncome

  // Stats row
  const cards = [
    { label: 'הכנסות התקופה', value: income,   color: 'var(--income)',  icon: '📈', bg: 'var(--income-bg)' },
    { label: 'הוצאות התקופה', value: expenses, color: 'var(--expense)', icon: '📉', bg: 'var(--expense-bg)' },
    { label: 'נטו התקופה',    value: net,      color: net >= 0 ? 'var(--income)' : 'var(--expense)', icon: '⚖️', bg: net >= 0 ? 'var(--income-bg)' : 'var(--expense-bg)' },
  ]
  if (hiddenSavings > 0 || capitalIncome > 0) {
    const parts = []
    if (hiddenSavings > 0) parts.push(`+${formatCurrency(hiddenSavings)} חסכונות חבויים`)
    if (capitalIncome > 0) parts.push(`−${formatCurrency(capitalIncome)} הכנסה הונית`)
    cards.push({
      label: 'חיסכון חבוי נטו',
      value: netHidden,
      color: netHidden >= 0 ? 'var(--income)' : 'var(--expense)',
      icon: '🪙',
      bg: netHidden >= 0 ? 'var(--income-bg)' : 'var(--expense-bg)',
      tooltip: `חסכונות חבויים פחות הכנסה הונית:\n${parts.join('\n')}\n\nחיובי = נטו הכנסת כסף לחיסכון. שלילי = נטו שבירת חיסכון.`
    })
  }
  // Recurring monthly-equivalent — only show when there's at least one
  // active (non-hidden) recurring entry. Independent of the active period
  // because cadence is intrinsic to the entry, not to the visible window.
  if (typeof recurringMonthlyTotals === 'function') {
    const rt = recurringMonthlyTotals()
    if (rt.count > 0) {
      cards.push({
        label: 'קבועות חודשי שקול',
        value: rt.net,
        color: rt.net >= 0 ? 'var(--income)' : 'var(--expense)',
        icon: '🔁',
        bg: rt.net >= 0 ? 'var(--income-bg)' : 'var(--expense-bg)',
        tooltip: `${rt.count} פעולות קבועות (לא־מוסתרות)\nהכנסות: +${formatCurrency(rt.income)}\nהוצאות: -${formatCurrency(rt.expense)}\n\nחישוב חודשי שקול: דו-חודשי /2, רבעוני /3.`
      })
    }
  }
  // Hero = net; rest go in the bento right column. Color alone signals sign —
  // no manual "+" prefix (positive=green is enough); Intl.NumberFormat already
  // places "-" to the left of the digits for negatives, matching the other
  // bento cards (hidden-savings, recurring) which use formatCurrency directly.
  const heroCard = cards[2] || cards[0]
  const otherCards = cards.filter(c => c !== heroCard)
  const trendPos = heroCard.value >= 0
  document.getElementById('dashStats').innerHTML = `
    <div class="bento-outer">
      <div class="bento-hero">
        <div class="bento-hero-eyebrow">נטו התקופה</div>
        <div class="bento-hero-amount" style="color:${heroCard.color}">${formatCurrency(heroCard.value)}</div>
        <div class="bento-hero-trend" style="background:${trendPos?'rgba(16,185,129,.14)':'rgba(244,63,94,.14)'};color:${heroCard.color}">
          ${trendPos?'▲':'▼'} ${trendPos?'תזרים חיובי':'תזרים שלילי'}
        </div>
        <div class="bento-hero-sub">הכנסות פחות הוצאות בתקופה הנבחרת</div>
      </div>
      <div class="bento-right">
        ${otherCards.map(s => `
          <div class="bento-stat" ${s.tooltip?`title="${s.tooltip.replace(/"/g,'&quot;')}"`:''}>
            <div class="bento-stat-icon" style="background:${s.bg}">${s.icon}</div>
            <div class="bento-stat-label">${s.label}</div>
            <div class="bento-stat-value" style="color:${s.color}">${formatCurrency(s.value)}</div>
            ${s.tooltip?`<div class="bento-stat-hint">${s.tooltip.split('\n')[0]}</div>`:''}
          </div>`).join('')}
      </div>
    </div>`

  // Accounts balances
  _renderAccountBalances()

  // Savings & investment flows for active period
  _renderNonLiquidFlows(period)

  // Monthly chart - respects period (up to 12 months)
  _renderMonthlyChart(all, period)

  // Category breakdown
  _renderCategoryBreakdown(periodTx, expenses)

  // Budget vs actual (current month only)
  const currentMonth = _ym(new Date())
  renderBudgetCard('dashBudget', currentMonth)

  // Recent transactions (10)
  _renderRecentTx(all)

  // Dashboard insights (Inbox / MoM chips / upcoming bills) — Phase 5
  if (typeof INS_renderDashboard === 'function') INS_renderDashboard()
}

function _renderAccountBalances() {
  // Show ONLY checking + cash. Balances for CC / savings / investment are
  // unreliable here because we don't have real-time data (CC has unpaid-but-
  // not-yet-charged purchases; savings/investment usually lag or aren't imported).
  const accs = getAccounts().filter(a => PL_ACCOUNT_TYPES.has(a.type))
  const el = document.getElementById('dashAccounts')
  if (!el) return
  if (accs.length === 0) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:1rem">אין חשבונות עו"ש/מזומן. עבור להגדרות.</p>'
    return
  }
  const TYPE = { checking:'עו"ש', cash:'מזומן' }
  el.innerHTML = accs.map(a => {
    const bal = getAccountBalance(a.id)
    const color = bal >= 0 ? 'var(--income)' : 'var(--expense)'
    return `
      <div class="account-balance-row">
        <div>
          <div class="list-item-name">${a.name}</div>
          <div class="list-item-sub">${TYPE[a.type]||a.type}${a.institution?' · '+a.institution:''}</div>
        </div>
        <span class="bal-amt" style="font-weight:700;color:${color}">${formatCurrency(bal)}</span>
      </div>`
  }).join('')
}

function _renderNonLiquidFlows(period) {
  const el = document.getElementById('dashNonLiquidFlows')
  const card = document.getElementById('dashNonLiquidFlowsCard')
  if (!el) return
  const accs = getAccounts().filter(a => !isLiquidAccount(a))
  if (accs.length === 0) { el.innerHTML = ''; if (card) card.style.display = 'none'; return }
  if (card) card.style.display = ''

  const rows = accs.map(a => ({ acc: a, ...getAccountFlow(a.id, period) }))
  const totalNet = rows.reduce((s, r) => s + r.net, 0)
  const TYPE = { savings:'חיסכון', investment:'ני"ע / השקעות' }

  el.innerHTML = `
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:baseline">
      <span>💰 תזרים חיסכון והשקעות</span>
      <span style="font-size:.85rem;font-weight:600;color:${totalNet>=0?'var(--income)':'var(--expense)'}">נטו: ${totalNet>=0?'+':''}${formatCurrency(totalNet)}</span>
    </div>
    <div class="nonliquid-flow-list">
      ${rows.map(r => `
        <div class="nonliquid-flow-row">
          <div>
            <div class="list-item-name">${r.acc.name}</div>
            <div class="list-item-sub">${TYPE[r.acc.type]||r.acc.type}${r.acc.institution?' · '+r.acc.institution:''}</div>
          </div>
          <div class="nonliquid-flow-nums">
            <span class="income-color">+${formatCurrency(r.deposited)}</span>
            <span class="expense-color">-${formatCurrency(r.withdrawn)}</span>
            <span style="font-weight:700;color:${r.net>=0?'var(--income)':'var(--expense)'}">${r.net>=0?'+':''}${formatCurrency(r.net)}</span>
          </div>
        </div>`).join('')}
    </div>`
}

function _renderMonthlyChart(all, period) {
  const months = monthsInPeriod(period)
  // if period too short (single month), show last 12 months instead
  const displayMonths = months.length < 2
    ? (() => {
        const out = []
        const now = new Date()
        for (let i = 11; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
          out.push(_ym(d))
        }
        return out
      })()
    : months

  const incomes = displayMonths.map(mo => sumIncome(all.filter(t => getTxEffectiveMonth(t) === mo)))
  const exps    = displayMonths.map(mo => sumExpenses(all.filter(t => getTxEffectiveMonth(t) === mo)))
  const nets    = incomes.map((v,i) => v - exps[i])
  const labels  = displayMonths.map(mo => mo.slice(5) + '/' + mo.slice(2,4))

  document.getElementById('monthlyChartTitle').textContent =
    displayMonths.length <= 6 ? `הכנסות מול הוצאות – ${displayMonths.length} חודשים`
    : `הכנסות מול הוצאות – ${displayMonths.length} חודשים אחרונים`

  if (_monthlyChart) _monthlyChart.destroy()
  const ctx = document.getElementById('monthlyChart').getContext('2d')
  const netGrad = ctx.createLinearGradient(0, 0, 0, 260)
  netGrad.addColorStop(0, 'rgba(59,130,246,.35)')
  netGrad.addColorStop(1, 'rgba(59,130,246,0)')
  _monthlyChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: 'bar',  label: 'הכנסות', data: incomes, backgroundColor: CHART_COLORS.incomeBg,  borderRadius: 6, borderSkipped: false, yAxisID: 'y' },
        { type: 'bar',  label: 'הוצאות', data: exps,    backgroundColor: CHART_COLORS.expenseBg, borderRadius: 6, borderSkipped: false, yAxisID: 'y' },
        { type: 'line', label: 'נטו',    data: nets,    borderColor: CHART_COLORS.accent, backgroundColor: netGrad,
          borderWidth: 2.5, tension: 0.45, fill: true, yAxisID: 'y',
          pointRadius: 4, pointBackgroundColor: CHART_COLORS.accent, pointBorderColor: CHART_COLORS.surface, pointBorderWidth: 2 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: CHART_COLORS.muted, font: { family: CHART_COLORS.font, size: 11 }, boxWidth: 12, padding: 16 } } },
      scales: {
        x: { ticks: { color: CHART_COLORS.ticks, font: { family: CHART_COLORS.font, size: 11 } },
             grid: { display: false }, border: { display: false } },
        y: { ticks: { color: CHART_COLORS.ticks, font: { family: CHART_COLORS.font, size: 11 }, callback: v => '₪' + (v/1000).toFixed(0) + 'k' },
             grid: { color: CHART_COLORS.grid }, border: { display: false } }
      }
    }
  })
}

function _renderCategoryBreakdown(periodTx, expenses) {
  // CC-aware distribution (same scope as the analysis pie): a card's lump
  // payment is dropped only when that card has itemized detail in this period
  // (the detail rows are shown instead); cards with no detail keep the lump.
  const savingsInvestIds = analysisExpenseSavingsInvestIds()
  const ccAccsWithDetail = ccAccountsWithDetail(periodTx)
  const bycat = {}
  let pieTotal = 0
  periodTx.forEach(t => {
    const ca = analysisExpenseAmount(t, savingsInvestIds, ccAccsWithDetail)
    if (ca <= 0) return
    const cat = getCategoryById(t.categoryId)
    const key = cat?.id || '__none__'
    if (!bycat[key]) bycat[key] = { name: cat?.name || 'לא מסווג', color: cat?.color || '#64748b', total: 0 }
    bycat[key].total += ca
    pieTotal += ca
  })
  const sorted = Object.values(bycat).sort((a,b) => b.total - a.total).slice(0, 6)
  document.getElementById('catBreakdown').innerHTML = sorted.length === 0
    ? '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:1.5rem">אין נתונים</p>'
    : sorted.map(c => `
      <div class="cat-bar-item">
        <div class="cat-bar-header">
          <span>${c.name}</span>
          <span style="color:var(--text-secondary)">${formatCurrency(c.total)}</span>
        </div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width:${pieTotal>0?Math.round(c.total/pieTotal*100):0}%;background:${c.color}"></div>
        </div>
      </div>`).join('')
}

function _renderRecentTx(all) {
  const recent = [...all].sort((a,b) => (b.date||'').localeCompare(a.date||'')).slice(0, 10)
  const TYPE_LABEL = { income:'הכנסה', expense:'הוצאה', transfer:'העברה', refund:'החזר' }
  document.getElementById('recentTx').innerHTML = recent.length === 0
    ? emptyStateHTML({
        icon: '📊',
        title: 'נתחיל לעקוב אחר הכסף',
        text: 'ייבא דוח בנק/אשראי לסיווג אוטומטי עם AI, או הוסף עסקה ראשונה ידנית.',
        actions: [
          { label: 'ייבוא קובץ', onclick: "navigate('import')", primary: true },
          { label: 'הוסף עסקה', onclick: 'addManualTransaction()' },
        ],
      })
    : recent.map(tx => {
        const cat = getCategoryById(tx.categoryId)
        const isNonCounted = tx.type === 'transfer' || tx.type === 'refund'
        const amountColor = isNonCounted ? 'var(--text-muted)' : (tx.amount > 0 ? 'var(--income)' : 'var(--expense)')
        const badge = isNonCounted ? `<span class="type-badge type-${tx.type}" style="margin-inline-start:.4rem">${TYPE_LABEL[tx.type]||tx.type}</span>` : ''
        return `
        <div class="recent-tx-item">
          <div class="recent-tx-left">
            <div class="recent-tx-icon">${cat ? (catIconHTML(cat, 18) || '📋') : '📋'}</div>
            <div>
              <div class="recent-tx-name">${resolveVendor(tx.vendor, tx.amount, getTxAliasDay(tx)) || tx.description || '—'}${badge}</div>
              <div class="recent-tx-meta">${formatDate(tx.date)} · ${cat?.name || 'לא מסווג'}</div>
            </div>
          </div>
          <span style="font-weight:700;color:${amountColor}">
            ${tx.amount>0?'+':''}${formatCurrency(tx.amount)}
          </span>
        </div>`
      }).join('')
}
