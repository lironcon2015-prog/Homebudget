// ===== MOBILE DASHBOARD (Dark Glass) =====
// Owns the #screen-dashboard markup on mobile. Reuses the desktop ENGINE only
// (sumIncome/sumExpenses/sumRefunds/getAccountBalance/analysisExpenseAmount/resolveVendor…)
// — no desktop presentational code is shared. Routed from renderDashboard()'s
// mobile guard, so every refresh caller lands here too.
let _mMonthlyChart = null

function M_renderDashboard() {
  const host = document.getElementById('screen-dashboard')
  if (!host) return
  const period = getActivePeriod()
  const all = getTransactions()
  const periodTx = filterByEffectivePeriod(all, period)

  const income        = sumIncome(periodTx)
  const expenses      = sumExpenses(periodTx)
  const refunds       = sumRefunds(periodTx)
  const net           = income - expenses + refunds
  const hiddenSavings = sumHiddenSavings(periodTx)
  const capitalIncome = (typeof sumCapitalIncome === 'function') ? sumCapitalIncome(periodTx) : 0
  const netHidden     = hiddenSavings - capitalIncome
  const recur         = (typeof recurringMonthlyTotals === 'function') ? recurringMonthlyTotals() : { count: 0, net: 0 }

  const trendPos = net >= 0
  const chips = [
    { label: 'הכנסות', value: income,   cls: 'pos' },
    { label: 'הוצאות', value: expenses, cls: 'neg' },
  ]
  if (refunds > 0) chips.push({ label: 'החזרים', value: refunds, cls: 'ref' })
  if (hiddenSavings > 0 || capitalIncome > 0) chips.push({ label: 'חיסכון חבוי נטו', value: netHidden, cls: netHidden >= 0 ? 'pos' : 'neg' })
  if (recur.count > 0)   chips.push({ label: 'קבוע חודשי', value: recur.net, cls: recur.net >= 0 ? 'pos' : 'neg' })

  host.innerHTML = `
    ${M_topbar('לוח בקרה', `
      <button class="m-iconbtn" onclick="UK_togglePrivacy()" aria-label="הסתר סכומים">${uiIcon('eyeoff', 17)}</button>
      <button class="m-iconbtn" onclick="navigate('settings')" aria-label="הגדרות">${uiIcon('gear', 17)}</button>
    `)}
    <div id="mDashPeriod" class="m-period"></div>

    <section class="m-hero ${trendPos ? 'pos' : 'neg'}">
      <div class="m-hero-ring"></div>
      <div class="m-hero-k">יתרה נטו · התקופה</div>
      <div class="m-hero-v">${formatCurrency(net)}</div>
      <div class="m-hero-trend">${trendPos ? '▲ תזרים חיובי' : '▼ תזרים שלילי'}</div>
      <div class="m-hero-sub" id="mDashLastImport"></div>
    </section>

    <div class="m-chips">
      ${chips.map(c => `
        <div class="m-chip">
          <div class="m-chip-k">${c.label}</div>
          <div class="m-chip-v ${c.cls}">${formatCurrency(c.value)}</div>
        </div>`).join('')}
    </div>

    ${M_sectionHead('הכנסות מול הוצאות', `<a onclick="navigate('budget')">תקציב ›</a>`)}
    <div class="m-card m-card-chart"><div class="m-chart-wrap"><canvas id="mMonthlyChart"></canvas></div></div>

    ${M_sectionHead('פירוט לפי קטגוריה')}
    <div class="m-card" id="mDashCats"></div>

    ${M_sectionHead('יתרות חשבונות')}
    <div class="m-card" id="mDashAccounts"></div>

    <div id="mDashAnomalies"></div>

    <div id="mDashNonLiquid"></div>

    ${M_sectionHead('עסקאות אחרונות', `<a onclick="navigate('transactions')">הכל ›</a>`)}
    <div class="m-card m-tx-card" id="mDashRecent"></div>
  `

  M_renderPeriodBar('mDashPeriod', () => M_renderDashboard())
  if (typeof ANOM_renderInto === 'function') ANOM_renderInto('mDashAnomalies')
  M_dashLastImport(all)
  M_dashChart(all, period)
  M_dashCats(periodTx)
  M_dashAccounts()
  M_dashNonLiquid(period)
  M_dashRecent(all)
  if (typeof M_syncTabs === 'function') M_syncTabs('dashboard')
  if (typeof M_repaintSync === 'function') M_repaintSync()
}

function M_dashLastImport(all) {
  const el = document.getElementById('mDashLastImport')
  if (!el) return
  let latest = 0, file = ''
  for (const t of all) if (t.importedAt && t.importedAt > latest) { latest = t.importedAt; file = t.sourceFile || '' }
  if (!latest) { el.textContent = ''; return }
  const days = (typeof _daysAgoLocal === 'function') ? _daysAgoLocal(latest) : Math.floor((Date.now() - latest) / 86400000)
  const rel = days <= 0 ? 'היום' : days === 1 ? 'אתמול' : `לפני ${days} ימים`
  el.textContent = `עדכון אחרון ${rel}`
  if (file) el.title = `קובץ אחרון: ${file}`
}

function M_dashChart(all, period) {
  const months = monthsInPeriod(period)
  const displayMonths = months.length < 2
    ? (() => { const out = [], now = new Date(); for (let i = 5; i >= 0; i--) out.push(_ym(new Date(now.getFullYear(), now.getMonth() - i, 1))); return out })()
    : months
  const monthTx = displayMonths.map(mo => all.filter(t => getTxEffectiveMonth(t) === mo))
  const incomes = monthTx.map(sumIncome)
  const exps    = monthTx.map(sumExpenses)
  const refs    = monthTx.map(sumRefunds)
  const nets    = incomes.map((v, i) => v - exps[i] + refs[i])
  const labels  = displayMonths.map(mo => mo.slice(5) + '/' + mo.slice(2, 4))
  const hasRefunds = refs.some(v => v > 0)

  if (_mMonthlyChart) { _mMonthlyChart.destroy(); _mMonthlyChart = null }
  const cv = document.getElementById('mMonthlyChart')
  if (!cv || typeof Chart === 'undefined') return
  const ctx = cv.getContext('2d')
  const netGrad = ctx.createLinearGradient(0, 0, 0, 200)
  netGrad.addColorStop(0, 'rgba(59,130,246,.35)'); netGrad.addColorStop(1, 'rgba(59,130,246,0)')
  _mMonthlyChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'הכנסות', data: incomes, backgroundColor: CHART_COLORS.incomeBg, borderRadius: 5, borderSkipped: false },
        { type: 'bar', label: 'הוצאות', data: exps, backgroundColor: CHART_COLORS.expenseBg, borderRadius: 5, borderSkipped: false },
        ...(hasRefunds ? [{ type: 'bar', label: 'החזרים', data: refs, backgroundColor: CHART_COLORS.refundBg, borderRadius: 5, borderSkipped: false }] : []),
        { type: 'line', label: 'נטו', data: nets, borderColor: CHART_COLORS.accent, backgroundColor: netGrad, borderWidth: 2.5, tension: 0.45, fill: true, hidden: true, pointRadius: 3, pointBackgroundColor: CHART_COLORS.accent },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: CHART_COLORS.muted, font: { family: CHART_COLORS.font, size: 10 }, boxWidth: 10, padding: 12 } } },
      scales: {
        x: { ticks: { color: CHART_COLORS.ticks, font: { family: CHART_COLORS.font, size: 10 } }, grid: { display: false }, border: { display: false } },
        y: { ticks: { color: CHART_COLORS.ticks, font: { family: CHART_COLORS.font, size: 10 }, callback: v => '₪' + (v / 1000).toFixed(0) + 'k' }, grid: { color: CHART_COLORS.grid }, border: { display: false } }
      }
    }
  })
  // Force a layout-correct resize on the next frame — the canvas can otherwise
  // measure the container before it has its final width, leaving blank space.
  requestAnimationFrame(() => { if (_mMonthlyChart) _mMonthlyChart.resize() })
}

function M_dashCats(periodTx) {
  const el = document.getElementById('mDashCats')
  if (!el) return
  const savingsInvestIds = analysisExpenseSavingsInvestIds()
  const ccAccsWithDetail = ccAccountsWithDetail(periodTx)
  const bycat = {}; let total = 0
  periodTx.forEach(t => {
    const ca = analysisExpenseAmount(t, savingsInvestIds, ccAccsWithDetail)
    if (ca <= 0) return
    const cat = getCategoryById(t.categoryId)
    const key = cat?.id || '__none__'
    if (!bycat[key]) bycat[key] = { name: cat?.name || 'לא מסווג', color: cat?.color || '#64748b', total: 0 }
    bycat[key].total += ca; total += ca
  })
  const sorted = Object.values(bycat).sort((a, b) => b.total - a.total).slice(0, 6)
  const refundLine = refundBucketLineHTML(refundBreakdownByCategory(periodTx), { compact: true })
  el.innerHTML = (sorted.length === 0 && !refundLine)
    ? '<p class="m-empty-line">אין נתונים לתקופה</p>'
    : sorted.map(c => `
      <div class="m-catbar">
        <div class="m-catbar-head"><span>${escHtml(c.name)}</span><span class="m-muted">${formatCurrency(c.total)}</span></div>
        <div class="m-catbar-track"><div class="m-catbar-fill" style="width:${total > 0 ? Math.round(c.total / total * 100) : 0}%;background:${c.color}"></div></div>
      </div>`).join('') + refundLine
}

function M_dashAccounts() {
  const el = document.getElementById('mDashAccounts')
  if (!el) return
  const accs = getAccounts().filter(a => PL_ACCOUNT_TYPES.has(a.type))
  if (accs.length === 0) { el.innerHTML = '<p class="m-empty-line">אין חשבונות עו״ש/מזומן</p>'; return }
  const TYPE = { checking: 'עו״ש', cash: 'מזומן' }
  el.innerHTML = accs.map(a => {
    const bal = getAccountBalance(a.id)
    return `<div class="m-acct-row">
      <div><div class="m-acct-name">${escHtml(a.name)}</div><div class="m-muted">${TYPE[a.type] || a.type}${a.institution ? ' · ' + escHtml(a.institution) : ''}</div></div>
      <span class="${bal >= 0 ? 'pos' : 'neg'} m-acct-bal">${formatCurrency(bal)}</span>
    </div>`
  }).join('')
}

function M_dashNonLiquid(period) {
  const el = document.getElementById('mDashNonLiquid')
  if (!el) return
  const accs = getAccounts().filter(a => !isLiquidAccount(a))
  if (accs.length === 0) { el.innerHTML = ''; return }
  const rows = accs.map(a => ({ acc: a, ...getAccountFlow(a.id, period) }))
  const totalNet = rows.reduce((s, r) => s + r.net, 0)
  const TYPE = { savings: 'חיסכון', investment: 'ני״ע / השקעות' }
  el.innerHTML = M_sectionHead('תזרים חיסכון והשקעות', `<span class="${totalNet >= 0 ? 'pos' : 'neg'}">נטו ${formatCurrency(totalNet)}</span>`) + `
    <div class="m-card">${rows.map(r => `
      <div class="m-acct-row">
        <div><div class="m-acct-name">${escHtml(r.acc.name)}</div><div class="m-muted">${TYPE[r.acc.type] || r.acc.type}</div></div>
        <div class="m-flow-nums">
          <span class="pos">+${formatCurrency(r.deposited)}</span>
          <span class="neg">−${formatCurrency(r.withdrawn)}</span>
        </div>
      </div>`).join('')}</div>`
}

function M_dashRecent(all) {
  const el = document.getElementById('mDashRecent')
  if (!el) return
  const recent = [...all].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 8)
  if (recent.length === 0) {
    el.innerHTML = emptyStateHTML({
      icon: uiIcon('chart', 30, 'var(--text-muted)'), title: 'נתחיל לעקוב אחר הכסף',
      text: 'ייבא דוח בנק/אשראי או הוסף עסקה ראשונה.',
      actions: [{ label: 'ייבוא קובץ', onclick: "navigate('import')", primary: true }, { label: 'הוסף עסקה', onclick: 'addManualTransaction()' }],
    })
    return
  }
  el.innerHTML = recent.map(tx => M_txRow(tx)).join('')
}

// Shared compact transaction row (used by dashboard recents + tx list).
function M_txRow(tx, opts = {}) {
  const cat = getCategoryById(tx.categoryId)
  const isNonCounted = tx.type === 'transfer'
  const cls = isNonCounted ? 'm-muted' : (tx.type === 'refund' && tx.amount > 0) ? 'ref' : (tx.amount > 0 ? 'pos' : 'neg')
  const name = escHtml(resolveVendor(tx.vendor, tx.amount, getTxAliasDay(tx)) || tx.description || '—')
  const sign = tx.amount > 0 ? '+' : ''
  const avatar = (typeof UK_vendorAvatar === 'function') ? UK_vendorAvatar(tx, { size: 40 })
    : `<div class="tx-avatar">${catIconHTML(cat, 18) || uiIcon('file', 18)}</div>`
  return `<div class="m-tx-row" data-id="${tx.id}" onclick="openEditModal('${tx.id}')">
    ${avatar}
    <div class="m-tx-mid">
      <div class="m-tx-name">${name}</div>
      <div class="m-tx-sub">${formatDate(tx.date)} · ${cat ? escHtml(cat.name) : 'לא מסווג'}</div>
    </div>
    <div class="m-tx-amt ${cls}">${sign}${formatCurrency(tx.amount)}</div>
  </div>`
}
