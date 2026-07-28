// ===== BUDGETS (v1.12) =====
// Budget record: { id, categoryId, monthKey, amount, type, createdAt, updatedAt }
// monthKey ('YYYY-MM') added in v1.12 — every budget is per month. Legacy records
// (no monthKey) get migrated to the CURRENT month via migrateBudgetMonthly_v2,
// so the previous user's single-record-per-category still tracks this month.
//
// Virtual categories:
//   UNFORESEEN_ID     — expense residual (בלת״ם): auto-sum of un-budgeted expenses.
//   OTHER_INCOME_ID   — income  residual (הכנסות אחרות): auto-sum of un-budgeted income.
//   CARRYOVER_INCOME_ID  — manual planning row: surplus carried in from previous month,
//                          entered by the user on the income side of the budget.
//   CARRYOVER_EXPENSE_ID — manual planning row: deficit/debt from previous month,
//                          entered by the user on the expense side of the budget.
//
// Carryover rows only affect the PLANNING totals (incBudget / expBudget) — actual
// income/expense stay attributed to the month the transaction happened in, so P&L
// in the dashboard/analysis is never touched.

const UNFORESEEN_ID = '__unforeseen__'
const UNFORESEEN_NAME = 'בלת״ם'
const UNFORESEEN_ICON = 'ic:file'
const UNFORESEEN_COLOR = '#a78bfa'

const OTHER_INCOME_ID = '__other_income__'
const OTHER_INCOME_NAME = 'הכנסות אחרות'
const OTHER_INCOME_ICON = 'ic:banknote'
const OTHER_INCOME_COLOR = '#22d3ee'

const CARRYOVER_INCOME_ID  = '__carryover_income__'
const CARRYOVER_EXPENSE_ID = '__carryover_expense__'

function _isUnforeseen(catId)  { return catId === UNFORESEEN_ID }
function _isOtherIncome(catId) { return catId === OTHER_INCOME_ID }
function _isResidual(catId)    { return _isUnforeseen(catId) || _isOtherIncome(catId) }
function _isCarryover(catId)   { return catId === CARRYOVER_INCOME_ID || catId === CARRYOVER_EXPENSE_ID }

function getBudgets() { return DB.get('finBudgets', []) }
function saveBudgets(b) { DB.set('finBudgets', b) }

function getBudgetsForMonth(monthKey) {
  return getBudgets().filter(b => b.monthKey === monthKey)
}

function migrateBudgetType_v1() {
  if (localStorage.getItem('migration_budget_type_v1') === '1') return
  const all = getBudgets()
  let changed = 0
  all.forEach(b => { if (!b.type) { b.type = 'expense'; changed++ } })
  if (changed > 0) saveBudgets(all)
  localStorage.setItem('migration_budget_type_v1', '1')
}

function migrateBudgetMonthly_v2() {
  if (localStorage.getItem('migration_budget_monthly_v2') === '1') return
  const all = getBudgets()
  const cm = _ym(new Date())
  let changed = 0
  all.forEach(b => { if (!b.monthKey) { b.monthKey = cm; changed++ } })
  if (changed > 0) saveBudgets(all)
  localStorage.setItem('migration_budget_monthly_v2', '1')
}

// Upsert by (categoryId, monthKey). If monthKey omitted, defaults to current month.
function setBudget(categoryId, monthKey, amount, type = 'expense') {
  if (!monthKey) monthKey = _ym(new Date())
  const all = getBudgets()
  const idx = all.findIndex(b => b.categoryId === categoryId && b.monthKey === monthKey)
  const amt = parseFloat(amount) || 0
  const now = Date.now()
  if (idx >= 0) {
    all[idx] = { ...all[idx], amount: amt, type, updatedAt: now }
  } else {
    all.push({ id: genId(), categoryId, monthKey, amount: amt, type, createdAt: now, updatedAt: now })
  }
  saveBudgets(all)
}

// Delete a specific (category, month) record. Omit monthKey to wipe every
// month for this category (used e.g. when a category itself is deleted).
function deleteBudget(categoryId, monthKey) {
  if (!monthKey) {
    saveBudgets(getBudgets().filter(b => b.categoryId !== categoryId))
    return
  }
  saveBudgets(getBudgets().filter(b => !(b.categoryId === categoryId && b.monthKey === monthKey)))
}

// Rename excludeFromUnforeseen → excludeFromBudget. Old field only dropped
// the tx from the בלת״ם sum (it counted in its own category anyway). New
// field drops the tx from every budget row, which is a superset — and for
// uncovered txs (the only ones the old flag affected) the behaviour is
// identical.
function migrateExcludeFromUnforeseen_v1() {
  if (localStorage.getItem('migration_exclude_from_budget_v1') === '1') return
  const txs = getTransactions()
  let changed = 0
  txs.forEach(t => {
    if (t.excludeFromUnforeseen && !t.excludeFromBudget) {
      t.excludeFromBudget = true
      changed++
    }
    if (t.excludeFromUnforeseen !== undefined) {
      delete t.excludeFromUnforeseen
      changed++
    }
  })
  if (changed > 0) DB.set('finTransactions', txs)
  localStorage.setItem('migration_exclude_from_budget_v1', '1')
}

// CC lump detection moved to core.js (ccLumpTargetForTx / ccAccountsWithDetail
// / shouldDropCcLump) — shared by analysis & budget. A lump that targets a CC
// account with itemized data is treated as a duplicate of the per-purchase
// rows; a lump targeting a CC with no statements stays counted (it's the only
// record of the spend).

// Per-month context for budget computations. Pre-compute once per call so
// budgetExpenseAmount doesn't re-derive these for every tx.
function _budgetMonthContext(monthTxs) {
  return {
    savingsInvestIds: analysisExpenseSavingsInvestIds(),
    ccAccsWithDetail: ccAccountsWithDetail(monthTxs),
  }
}

function budgetExpenseAmount(t, ctx) {
  if (t.excludeFromBudget) return 0
  if (t.type === 'transfer') return 0
  if (ctx.savingsInvestIds.has(t.accountId)) return 0
  if (shouldDropCcLump(t, ctx.ccAccsWithDetail)) return 0
  if (t.type === 'refund' && t.amount > 0) return -t.amount
  if (t.amount < 0) return Math.abs(t.amount)
  return 0
}

function budgetIncomeAmount(t) {
  if (t.excludeFromBudget) return 0
  if (!isCountedIncome(t)) return 0
  return t.amount
}

// Synthesizes a "category" object for residual/virtual slots so UI code stays
// uniform. Real categories go through getCategoryById.
function _budgetCategoryProxy(catId) {
  if (_isUnforeseen(catId)) {
    return { id: UNFORESEEN_ID, name: UNFORESEEN_NAME, icon: UNFORESEEN_ICON, color: UNFORESEEN_COLOR, type: 'expense', _virtual: true }
  }
  if (_isOtherIncome(catId)) {
    return { id: OTHER_INCOME_ID, name: OTHER_INCOME_NAME, icon: OTHER_INCOME_ICON, color: OTHER_INCOME_COLOR, type: 'income', _virtual: true }
  }
  if (catId === CARRYOVER_INCOME_ID) {
    return { id: CARRYOVER_INCOME_ID, name: 'יתרה מחודש קודם', icon: 'ic:vault', color: '#22c55e', type: 'income', _virtual: true }
  }
  if (catId === CARRYOVER_EXPENSE_ID) {
    return { id: CARRYOVER_EXPENSE_ID, name: 'גירעון מחודש קודם', icon: 'ic:chart', color: '#f97316', type: 'expense', _virtual: true }
  }
  return getCategoryById(catId)
}

// Per-category status for a specific month.
//
// SCOPE: analysis-style (CC detail per category, lump payment dropped) via
// budgetExpenseAmount. A bank-side CC lump is dropped only when the CC account
// it targets has detail txs in this month (the detail already counts under
// food / fuel / etc.). When the CC account is detail-free, the lump still
// counts — otherwise the user has no visibility into that spend at all.
//
// The residual rows (UNFORESEEN_ID for expense, OTHER_INCOME_ID for income)
// aggregate every tx whose category isn't covered by another budget row in
// the same direction. Any tx with t.excludeFromBudget=true is dropped from
// the residual AND from its own-category sum (a global "ignore in budget").
function computeBudgetStatus(monthKey) {
  const budgets = getBudgetsForMonth(monthKey)
  const txs = getTransactions().filter(t => getTxEffectiveMonth(t) === monthKey)
  const ctx = _budgetMonthContext(txs)
  const sets = _coveredCatSets(budgets)

  // Synthesize residual budget stubs if the user hasn't set one explicitly.
  // The residual actual must always surface — otherwise un-budgeted expenses
  // / incomes silently vanish from the screen and the totals.
  const allBudgets = budgets.slice()
  if (!allBudgets.some(b => _isUnforeseen(b.categoryId))) {
    allBudgets.push({ categoryId: UNFORESEEN_ID, monthKey, amount: 0, type: 'expense', _synthetic: true })
  }
  if (!allBudgets.some(b => _isOtherIncome(b.categoryId))) {
    allBudgets.push({ categoryId: OTHER_INCOME_ID, monthKey, amount: 0, type: 'income', _synthetic: true })
  }

  return allBudgets.map(b => {
    const cat = _budgetCategoryProxy(b.categoryId)
    const type = b.type || 'expense'
    let actual = 0
    if (_isUnforeseen(b.categoryId)) {
      for (const t of txs) {
        if (t.categoryId && sets.expense.has(t.categoryId)) continue
        actual += budgetExpenseAmount(t, ctx)
      }
    } else if (_isOtherIncome(b.categoryId)) {
      for (const t of txs) {
        if (t.categoryId && sets.income.has(t.categoryId)) continue
        actual += budgetIncomeAmount(t)
      }
    } else {
      const catTxs = txs.filter(t => t.categoryId === b.categoryId)
      actual = type === 'income'
        ? catTxs.reduce((s,t)=>s+budgetIncomeAmount(t),0)
        : catTxs.reduce((s,t)=>s+budgetExpenseAmount(t, ctx),0)
    }
    const budget = b.amount
    const remaining = budget - actual
    const pct = budget > 0 ? (actual / budget) * 100 : 0
    return { ...b, type, cat, budget, actual, remaining, pct, isResidual: _isResidual(b.categoryId) }
  }).sort((a,b) => b.pct - a.pct)
}

// Previous calendar month's key, e.g. '2026-01' for '2026-02'.
function _prevMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  return _ym(new Date(y, m - 2, 1))
}

function _coveredCatSets(budgets) {
  const expense = new Set()
  const income = new Set()
  budgets.forEach(b => {
    if (_isResidual(b.categoryId) || _isCarryover(b.categoryId)) return
    const t = b.type || 'expense'
    if (t === 'expense') expense.add(b.categoryId)
    else if (t === 'income') income.add(b.categoryId)
  })
  return { expense, income }
}

// Transactions that would feed a specific budget row, used by the editor
// modal. Works whether or not a budget record exists yet — `catId` may be a
// real category or one of the virtual residual ids.
//   { includeExcluded: true } → also lists txs the user has set
//   excludeFromBudget on (rendered greyed-out so they can be re-included).
function computeBudgetRowTxs(catId, monthKey, type, { includeExcluded = false } = {}) {
  const budgets = getBudgetsForMonth(monthKey)
  const txs = getTransactions().filter(t => getTxEffectiveMonth(t) === monthKey)
  const ctx = _budgetMonthContext(txs)
  const sets = _coveredCatSets(budgets)
  const effType = type || (_isOtherIncome(catId) ? 'income' : 'expense')

  const amountFor = effType === 'income'
    ? ((t) => isCountedIncome(t) ? t.amount : 0)
    : ((t) => {
        // Same as budgetExpenseAmount but ignoring excludeFromBudget so we can
        // show excluded rows in the modal too.
        if (t.type === 'transfer') return 0
        if (ctx.savingsInvestIds.has(t.accountId)) return 0
        if (shouldDropCcLump(t, ctx.ccAccsWithDetail)) return 0
        if (t.type === 'refund' && t.amount > 0) return -t.amount
        if (t.amount < 0) return Math.abs(t.amount)
        return 0
      })

  const matchesRow = (t) => {
    if (_isUnforeseen(catId)) return !(t.categoryId && sets.expense.has(t.categoryId))
    if (_isOtherIncome(catId)) return !(t.categoryId && sets.income.has(t.categoryId))
    return t.categoryId === catId
  }

  const out = []
  for (const t of txs) {
    if (!matchesRow(t)) continue
    const amt = amountFor(t)
    if (amt === 0) continue
    if (!includeExcluded && t.excludeFromBudget) continue
    out.push({ tx: t, amount: amt })
  }
  out.sort((a, b) => b.amount - a.amount)
  return out
}

function setTxExcludeFromBudget(txId, exclude) {
  const txs = getTransactions()
  const idx = txs.findIndex(t => t.id === txId)
  if (idx < 0) return
  if (exclude) txs[idx].excludeFromBudget = true
  else delete txs[idx].excludeFromBudget
  DB.set('finTransactions', txs)
}

function computeBudgetTotals(monthKey) {
  const rows = computeBudgetStatus(monthKey)
  const exp = rows.filter(r => r.type !== 'income')
  const inc = rows.filter(r => r.type === 'income')
  return {
    rows, exp, inc,
    expBudget: exp.reduce((s,r)=>s+r.budget,0),
    expActual: exp.reduce((s,r)=>s+r.actual,0),
    incBudget: inc.reduce((s,r)=>s+r.budget,0),
    incActual: inc.reduce((s,r)=>s+r.actual,0),
  }
}

// ===== DASHBOARD CARD (aggregated totals only) =====
// Deliberately does NOT list per-category rows — the top-level budget screen
// owns that. Clicking "הרחב" navigates there.
function renderBudgetCard(containerId, monthKey) {
  const el = document.getElementById(containerId)
  if (!el) return
  const { rows, expBudget, expActual, incBudget, incActual } = computeBudgetTotals(monthKey)
  const openBtn = `<button class="btn-ghost" onclick="openBudgetScreenAtMonth('${monthKey}')">הרחב למסך תקציב ↗</button>`
  // Synthetic residual rows always exist; treat the card as empty unless
  // the user set something OR there are uncovered actuals worth showing.
  const hasContent = rows.some(r => !r._synthetic || r.actual > 0)
  if (!hasContent) {
    el.innerHTML = `
      <p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:1rem 0">לא הוגדרו תקציבים לחודש זה.</p>
      <div style="text-align:center">${openBtn}</div>`
    return
  }
  const expRem = expBudget - expActual
  const expPct = expBudget > 0 ? (expActual / expBudget) * 100 : 0
  const expW = Math.min(100, expPct)
  const expCls = expPct >= 100 ? 'budget-over' : expPct >= 90 ? 'budget-danger' : expPct >= 70 ? 'budget-warn' : 'budget-ok'
  const hasInc = incBudget > 0 || incActual > 0
  const incPct = incBudget > 0 ? (incActual / incBudget) * 100 : 0
  const incW = Math.min(100, incPct)
  const incCls = incPct >= 100 ? 'budget-ok' : incPct >= 70 ? 'budget-warn' : 'budget-danger'
  const incRow = !hasInc ? '' : `
    <div class="budget-agg-row ${incCls}">
      <div class="budget-agg-head"><span>הכנסות צפויות</span>
        <span class="budget-agg-nums">${formatCurrency(incActual)} / ${formatCurrency(incBudget)}</span></div>
      <div class="budget-agg-bar-track"><div class="budget-agg-bar-fill" style="width:${incW}%"></div></div>
      <div class="budget-agg-foot"><span>${incPct.toFixed(0)}%</span>
        <span>${incActual>=incBudget?'מעל היעד ':'חסר '}${formatCurrency(Math.abs(incBudget - incActual))}</span></div>
    </div>`
  el.innerHTML = `
    <div class="budget-agg-grid">
      <div class="budget-agg-row ${expCls}">
        <div class="budget-agg-head"><span>הוצאות</span>
          <span class="budget-agg-nums">${formatCurrency(expActual)} / ${formatCurrency(expBudget)}</span></div>
        <div class="budget-agg-bar-track"><div class="budget-agg-bar-fill" style="width:${expW}%"></div></div>
        <div class="budget-agg-foot"><span>${expPct.toFixed(0)}%</span>
          <span>${expRem>=0?'נותר ':'חריגה '}${formatCurrency(Math.abs(expRem))}</span></div>
      </div>
      ${incRow}
    </div>
    <div style="text-align:center;margin-top:.9rem">${openBtn}</div>`
}

// ===== BUDGET SCREEN (top-level) =====
let _budgetScreenMonth = null

function getBudgetScreenMonth() {
  if (!_budgetScreenMonth) _budgetScreenMonth = _ym(new Date())
  return _budgetScreenMonth
}

function setBudgetScreenMonth(m) { _budgetScreenMonth = m; renderBudgetScreen() }

function shiftBudgetScreenMonth(delta) {
  const [y, m] = getBudgetScreenMonth().split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  _budgetScreenMonth = _ym(d)
  renderBudgetScreen()
}

function openBudgetScreenAtMonth(monthKey) {
  if (monthKey) _budgetScreenMonth = monthKey
  navigate('budget')
}

const _HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר']
function _budgetFormatMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  return `${_HE_MONTHS[m-1]} ${y}`
}

function renderBudgetScreen() {
  const container = document.getElementById('budgetScreenBody')
  if (!container) return
  const monthKey = getBudgetScreenMonth()
  const currentKey = _ym(new Date())
  const isCurrent = monthKey === currentKey
  const isFuture  = monthKey > currentKey
  const isPast    = monthKey < currentKey
  const { expBudget, expActual, incBudget, incActual } = computeBudgetTotals(monthKey)
  const expRem = expBudget - expActual
  const incRem = incBudget - incActual
  const netBudget = incBudget - expBudget
  const netActual = incActual - expActual

  const tag = isCurrent ? ' <span class="budget-month-tag">החודש</span>'
            : isFuture  ? ' <span class="budget-month-tag budget-month-tag-future">עתיד</span>'
            : ' <span class="budget-month-tag budget-month-tag-past">היסטוריה</span>'

  const monthNav = `
    <div class="budget-month-nav">
      <button class="btn-ghost" onclick="shiftBudgetScreenMonth(-1)">← חודש קודם</button>
      <div class="budget-month-label">${_budgetFormatMonth(monthKey)}${tag}</div>
      <button class="btn-ghost" onclick="shiftBudgetScreenMonth(1)">חודש הבא →</button>
    </div>`

  const summary = `
    <div class="budget-summary-grid">
      <div class="budget-summary-card">
        <div class="budget-label">הוצאות (בפועל / תקציב)</div>
        <div class="budget-val"><span class="expense-color">${formatCurrency(expActual)}</span> / ${formatCurrency(expBudget)}</div>
        <div class="budget-sub">${expRem>=0?'נותר ':'חריגה '}${formatCurrency(Math.abs(expRem))}</div>
      </div>
      <div class="budget-summary-card">
        <div class="budget-label">הכנסות (בפועל / יעד)</div>
        <div class="budget-val"><span class="income-color">${formatCurrency(incActual)}</span> / ${formatCurrency(incBudget)}</div>
        <div class="budget-sub">${incRem<=0?'מעל היעד ':'חסר '}${formatCurrency(Math.abs(incRem))}</div>
      </div>
      <div class="budget-summary-card">
        <div class="budget-label">נטו</div>
        <div class="budget-val ${netActual>=0?'income-color':'expense-color'}">${formatCurrency(netActual)}</div>
        <div class="budget-sub">מתוכנן: <span class="${netBudget>=0?'income-color':'expense-color'}">${formatCurrency(netBudget)}</span></div>
      </div>
    </div>`

  const actions = isPast ? '' : `
    <div class="budget-actions">
      <button class="btn-primary" onclick="openBudgetGenModalForMonth('${monthKey}')">הצע תקציב ל${_budgetFormatMonth(monthKey)}</button>
      <button class="btn-ghost" onclick="copyBudgetFromPrevMonth()">העתק מחודש קודם</button>
      <button class="btn-ghost" onclick="importCarryoverFromPrevMonth()">ייבא יתרת חודש קודם</button>
      <button class="btn-ghost" onclick="clearBudgetForMonth()">נקה חודש זה</button>
    </div>`

  const filterBar = `
    <div class="budget-filterbar">
      <button class="btn-ghost" onclick="openBudgetUnder('${monthKey}')">טרם מומשו</button>
      <button class="btn-ghost" onclick="openBudgetOver('${monthKey}')">חריגות תקציב</button>
    </div>`

  container.innerHTML = monthNav + summary + filterBar + actions + _renderBudgetScreenTable(monthKey, isPast)
}

// Budget sub-views: under-utilized (actual < 50% of budget) and overruns
// (actual > budget +30% AND the overage is material, ≥ ₪300). Both open a sheet
// listing the matching expense rows; tapping a row drills into its transactions.
const BUDGET_UNDER_PCT = 0.5
const BUDGET_OVER_PCT = 1.3
const BUDGET_OVER_MIN_DELTA = 300
let _budgetFilterSheet = null

function openBudgetUnder(monthKey) { _openBudgetFilterSheet(monthKey || getBudgetScreenMonth(), 'under') }
function openBudgetOver(monthKey) { _openBudgetFilterSheet(monthKey || getBudgetScreenMonth(), 'over') }

function _openBudgetFilterSheet(monthKey, mode) {
  if (typeof UK_sheet !== 'function') return
  // Applies to BOTH expense and income budgets:
  //  under → expense under-spent / income under-earned (actual < 50% of plan)
  //  over  → expense overspent / income above target (actual > +30%, material)
  const rows = computeBudgetStatus(monthKey).filter(r =>
    !r.isResidual && !_isCarryover(r.categoryId) && r.budget > 0 && (
      mode === 'under'
        ? r.actual < r.budget * BUDGET_UNDER_PCT
        : (r.actual > r.budget * BUDGET_OVER_PCT && (r.actual - r.budget) >= BUDGET_OVER_MIN_DELTA)
    ))
  rows.sort((a, b) => mode === 'under' ? a.pct - b.pct : (b.actual - b.budget) - (a.actual - a.budget))
  const title = mode === 'under' ? `סעיפים שטרם מומשו · ${_budgetFormatMonth(monthKey)}` : `חריגות תקציב · ${_budgetFormatMonth(monthKey)}`
  const empty = mode === 'under' ? 'אין סעיפים מתחת ל-50% מהתקציב/היעד' : 'אין חריגות מהותיות (מעל 30% ולפחות ₪300)'
  const body = rows.length === 0
    ? `<p style="color:var(--text-muted);text-align:center;padding:2rem">${empty}</p>`
    : rows.map(r => {
        const isInc = r.type === 'income'
        const delta = r.actual - r.budget
        const sub = mode === 'under'
          ? `${isInc ? 'חסר' : 'נותר'} ${formatCurrency(r.budget - r.actual)}`
          : `${isInc ? 'מעל היעד' : 'חריגה'} ${formatCurrency(delta)}`
        // green = the "good" direction (expense under / income over), red otherwise
        const good = mode === 'under' ? !isInc : isInc
        const cls = good ? 'income-color' : 'expense-color'
        return `<button class="bf-row" onclick="_budgetFilterGo('${r.categoryId}','${monthKey}')">
          <span class="bf-cat">${catIconHTML(r.cat) || uiIcon('file', 16)} ${escHtml(r.cat.name)}${isInc ? ' <span class="bf-badge">הכנסה</span>' : ''}</span>
          <div class="bf-side">
            <span class="bf-nums"><span class="${cls}">${formatCurrency(r.actual)}</span> / ${formatCurrency(r.budget)}</span>
            <span class="bf-sub ${cls}">${Math.round(r.pct)}% · ${sub}</span>
          </div>
        </button>`
      }).join('')
  _budgetFilterSheet = UK_sheet({ title, content: `<div class="bf-list">${body}</div>` })
}

function _budgetFilterGo(catId, monthKey) {
  if (_budgetFilterSheet) { _budgetFilterSheet.close(); _budgetFilterSheet = null }
  if (typeof navigateBudgetCatToTx === 'function') navigateBudgetCatToTx(catId, monthKey)
}

function _renderBudgetScreenTable(monthKey, readOnly) {
  const cats = getCategoriesSorted()
  const expCats = cats.filter(c => c.type === 'expense')
  const incCats = cats.filter(c => c.type === 'income')
  const budgets = getBudgetsForMonth(monthKey)
  const byKey = {}
  budgets.forEach(b => { byKey[b.categoryId + '|' + (b.type || 'expense')] = b })
  const statusRows = computeBudgetStatus(monthKey)
  const rowByKey = {}
  statusRows.forEach(r => { rowByKey[r.categoryId + '|' + r.type] = r })

  const row = (c, type, opts = {}) => {
    const { residual = false, residualTag = '', residualRowCls = '', residualTitle = '', noClick = false } = opts
    const key = c.id + '|' + type
    const b = byKey[key]
    const status = rowByKey[key]
    const actual = status?.actual ?? 0
    const budget = b?.amount ?? 0
    const rawPct = budget > 0 ? (actual / budget) * 100 : 0
    const pct = Math.min(100, rawPct)
    const isIncome = type === 'income'
    const cls = isIncome
      ? (rawPct >= 100 ? 'budget-ok' : rawPct >= 70 ? 'budget-warn' : rawPct > 0 ? 'budget-danger' : '')
      : (rawPct >= 100 ? 'budget-over' : rawPct >= 90 ? 'budget-danger' : rawPct >= 70 ? 'budget-warn' : rawPct > 0 ? 'budget-ok' : '')
    const actualCls = isIncome ? 'income-color' : 'expense-color'
    const actualCell = budget > 0 || actual > 0
      ? `<span class="budget-screen-actual ${actualCls}">${formatCurrency(actual)}</span>`
      : '<span class="budget-screen-actual" style="color:var(--text-muted)">—</span>'
    const input = readOnly
      ? `<span class="budget-screen-budget">${budget > 0 ? formatCurrency(budget) : '—'}</span>`
      : `<div class="budget-input-wrap">
           <span class="budget-currency">₪</span>
           <input type="number" min="0" step="10" value="${b?.amount || ''}" placeholder="0"
             data-cat="${c.id}" data-type="${type}" data-month="${monthKey}"
             class="budget-input" onchange="onBudgetScreenChange(this)">
         </div>`
    const onClick = noClick ? '' : `openBudgetRowModal('${c.id}','${monthKey}','${type}')`
    const catAttrs = noClick
      ? `class="budget-screen-cat"`
      : `class="budget-screen-cat budget-screen-cat-link" role="link" tabindex="0" onclick="${onClick}"`
    const tag = residualTag ? ` <span class="budget-unforeseen-tag" title="${residualTitle}">${residualTag}</span>` : ''
    const linkTitle = noClick ? '' : (residual ? residualTitle : 'ערוך אילו עסקאות נכללות בשורה זו')
    return `
      <div class="budget-screen-row ${residualRowCls} ${cls}">
        <span ${catAttrs}${linkTitle ? ` title="${linkTitle}"` : ''}>${catIconHTML(c) || uiIcon('file', 16)} ${escHtml(c.name)}${tag}</span>
        <span class="budget-screen-actual-wrap"${onClick ? ` onclick="${onClick}" style="cursor:pointer"` : ''}>${actualCell}</span>
        ${input}
        <div class="budget-screen-bar-track"><div class="budget-screen-bar-fill" style="width:${pct}%"></div></div>
      </div>`
  }

  const uRow = row(
    _budgetCategoryProxy(UNFORESEEN_ID),
    'expense',
    {
      residual: true,
      residualTag: 'אוטומטי',
      residualRowCls: 'budget-unforeseen-row',
      residualTitle: 'סוכם כל הוצאה ללא תקציב משלה. לחיצה פותחת עורך כדי להוציא ידנית עסקאות שלא צריכות להיכלל',
    }
  )
  const oiRow = row(
    _budgetCategoryProxy(OTHER_INCOME_ID),
    'income',
    {
      residual: true,
      residualTag: 'אוטומטי',
      residualRowCls: 'budget-other-income-row',
      residualTitle: 'סוכמת כל הכנסה ללא יעד תקציב משלה. לחיצה פותחת עורך כדי להוציא ידנית הכנסות שלא צריכות להיכלל',
    }
  )
  const coIncRow = row(
    _budgetCategoryProxy(CARRYOVER_INCOME_ID),
    'income',
    { residualRowCls: 'budget-carryover-row budget-carryover-income-row', noClick: true }
  )
  const coExpRow = row(
    _budgetCategoryProxy(CARRYOVER_EXPENSE_ID),
    'expense',
    { residualRowCls: 'budget-carryover-row budget-carryover-expense-row', noClick: true }
  )

  return `
    <div class="budget-screen-section">
      <h3 class="budget-screen-heading">הוצאות</h3>
      <div class="budget-screen-list-head">
        <span>קטגוריה</span><span>בפועל</span><span>תקציב</span><span></span>
      </div>
      <div class="budget-screen-table">
        ${expCats.map(c => row(c, 'expense')).join('')}
        ${coExpRow}
        ${uRow}
      </div>
    </div>
    <div class="budget-screen-section">
      <h3 class="budget-screen-heading">הכנסות צפויות</h3>
      <div class="budget-screen-list-head">
        <span>קטגוריה</span><span>בפועל</span><span>יעד</span><span></span>
      </div>
      <div class="budget-screen-table">
        ${incCats.map(c => row(c, 'income')).join('')}
        ${coIncRow}
        ${oiRow}
      </div>
    </div>`
}

// Click-through from budget category → transactions view, scoped to that
// month + category. The transactions screen filters via filterByEffectivePeriod
// over a single calendar month, which lines up with computeBudgetStatus's
// getTxEffectiveMonth grouping — same set of rows the "בפועל" cell counted.
function navigateBudgetCatToTx(catId, monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  const pad = n => String(n).padStart(2, '0')
  const start = `${y}-${pad(m)}-01`
  const end   = `${y}-${pad(m)}-${pad(lastDay)}`
  // 'custom' so the period selector reflects the chosen range and the user can
  // see/edit it, instead of an unrecognised key that highlights nothing.
  setActivePeriod({ key: 'custom', label: _budgetFormatMonth(monthKey), start, end })
  if (typeof txSetReturnContext === 'function' && typeof _currentScreen === 'string' && _currentScreen && _currentScreen !== 'transactions') {
    const cat = (typeof _budgetCategoryProxy === 'function') ? _budgetCategoryProxy(catId) : null
    txSetReturnContext({ screen: _currentScreen, fromLabel: 'חזרה', label: cat ? cat.name : '' })
  }
  navigate('transactions')
  // After navigate, the filter elements exist. Reset orthogonal filters that
  // would hide rows the budget tile counted (account / flow / search), then
  // pin the category and redraw.
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v }
  setVal('txSearch', '')
  setVal('txAccountFilter', '')
  setVal('txFlowFilter', '')
  setVal('txTypeFilter', 'all')
  setVal('txCategoryFilter', catId)
  if (typeof _txPage !== 'undefined') _txPage = 0
  if (typeof _drawTxTable === 'function') _drawTxTable()
}

function onBudgetScreenChange(input) {
  const catId = input.dataset.cat
  const type = input.dataset.type || 'expense'
  const monthKey = input.dataset.month
  const val = parseFloat(input.value)
  if (!val || val <= 0) {
    deleteBudget(catId, monthKey)
  } else {
    setBudget(catId, monthKey, val, type)
  }
  renderBudgetScreen()
}

async function copyBudgetFromPrevMonth() {
  const monthKey = getBudgetScreenMonth()
  const [y, m] = monthKey.split('-').map(Number)
  const prev = _ym(new Date(y, m - 2, 1))
  // Exclude carryover rows — they are month-specific and shouldn't be blindly copied.
  const source = getBudgetsForMonth(prev).filter(b => !_isCarryover(b.categoryId))
  if (source.length === 0) { toast(`אין תקציב ב-${_budgetFormatMonth(prev)}`, { type: 'error' }); return }
  if (!await confirmDialog(`להעתיק ${source.length} ערכי תקציב מ-${_budgetFormatMonth(prev)} ל-${_budgetFormatMonth(monthKey)}? (דריסת ערכים קיימים)`, { confirmText: 'העתק' })) return
  source.forEach(b => setBudget(b.categoryId, monthKey, b.amount, b.type || 'expense'))
  renderBudgetScreen()
}

// Computes the previous month's actual net (real income minus real expenses,
// excluding carryover rows whose actual is always 0) and offers to fill it in
// as a carryover planning row for the current budget month.
async function importCarryoverFromPrevMonth() {
  const monthKey = getBudgetScreenMonth()
  const prev = _prevMonthKey(monthKey)
  const { incActual, expActual } = computeBudgetTotals(prev)
  // incActual / expActual from computeBudgetTotals exclude carryover rows (their actual=0).
  const net = incActual - expActual
  if (Math.abs(net) < 1) { toast(`אין יתרה מהותית ב-${_budgetFormatMonth(prev)}`, { type: 'info' }); return }
  const sign = net > 0 ? 'חיובית' : 'שלילית'
  const desc = net > 0
    ? `יתרה חיובית של ${formatCurrencyPlain(net)} — תועבר כהכנסה מועברת.`
    : `גירעון של ${formatCurrencyPlain(Math.abs(net))} — יועבר כגירעון מחודש קודם בהוצאות.`
  if (!await confirmDialog(`${_budgetFormatMonth(prev)}: ${desc}`, { confirmText: 'העבר' })) return
  if (net > 0) {
    setBudget(CARRYOVER_INCOME_ID,  monthKey, net,          'income')
    deleteBudget(CARRYOVER_EXPENSE_ID, monthKey)
  } else {
    setBudget(CARRYOVER_EXPENSE_ID, monthKey, Math.abs(net), 'expense')
    deleteBudget(CARRYOVER_INCOME_ID, monthKey)
  }
  renderBudgetScreen()
}

async function clearBudgetForMonth() {
  const monthKey = getBudgetScreenMonth()
  const source = getBudgetsForMonth(monthKey)
  if (source.length === 0) return
  if (!await confirmDialog(`למחוק את כל ${source.length} ערכי התקציב ל-${_budgetFormatMonth(monthKey)}?`, { danger: true, confirmText: 'מחק' })) return
  saveBudgets(getBudgets().filter(b => b.monthKey !== monthKey))
  renderBudgetScreen()
}

function openBudgetGenModalForMonth(monthKey) {
  if (typeof openBudgetGenModal === 'function') openBudgetGenModal(monthKey)
}

// ===== BUDGET ROW EDITOR =====
// Lists every tx that currently feeds (or could feed) the selected budget
// row for the given month, with a per-tx checkbox controlling
// t.excludeFromBudget. Works for normal categories (income/expense) and for
// the two residual rows (UNFORESEEN_ID, OTHER_INCOME_ID).
let _budgetRowModalState = null

function openBudgetRowModal(catId, monthKey, type) {
  const effType = type || (_isOtherIncome(catId) ? 'income' : 'expense')
  _budgetRowModalState = { catId, monthKey, type: effType }
  _renderBudgetRowModal()
  document.getElementById('budgetRowModal')?.classList.add('open')
}

function closeBudgetRowModal() {
  document.getElementById('budgetRowModal')?.classList.remove('open')
}

function _renderBudgetRowModal() {
  const state = _budgetRowModalState
  const body = document.getElementById('budgetRowBody')
  const title = document.getElementById('budgetRowTitle')
  if (!body || !state) return
  const { catId, monthKey, type } = state
  const cat = _budgetCategoryProxy(catId)
  const catLabel = cat ? `${catIconText(cat)} ${cat.name}`.trim() : 'קטגוריה'
  if (title) title.textContent = `${catLabel} – ${_budgetFormatMonth(monthKey)}`

  const rows = computeBudgetRowTxs(catId, monthKey, type, { includeExcluded: true })
  const isIncome = type === 'income'
  const amtCls = isIncome ? 'income-color' : 'expense-color'
  const isResidual = _isResidual(catId)
  const intro = isResidual
    ? (isIncome
        ? 'כל הכנסה ללא יעד תקציב משלה נכללת אוטומטית בהכנסות אחרות. הסר סימון מהכנסות שאינן צריכות להיספר כאן.'
        : 'כל הוצאה ללא תקציב משלה נכללת אוטומטית בבלת״ם. הסר סימון מעסקאות שאינן צריכות להיספר כאן.')
    : 'כל העסקאות בקטגוריה זו לחודש זה. הסר סימון מעסקאות שלא צריכות להיכלל בחישוב התקציב.'

  if (rows.length === 0) {
    body.innerHTML = `
      <div style="color:var(--text-muted);font-size:.85rem;margin-bottom:.75rem">${intro}</div>
      <p style="color:var(--text-muted);padding:1.5rem;text-align:center">אין עסקאות מתאימות בחודש זה.</p>`
    return
  }

  const includedTotal = rows.filter(r => !r.tx.excludeFromBudget).reduce((s, r) => s + r.amount, 0)
  const excludedCount = rows.filter(r => r.tx.excludeFromBudget).length

  const lines = rows.map(({ tx, amount }) => {
    const c = tx.categoryId ? getCategoryById(tx.categoryId) : null
    const catLbl = c ? `${catIconHTML(c) || uiIcon('file', 16)} ${escHtml(c.name)}` : '<span style="color:var(--text-muted)">ללא קטגוריה</span>'
    const vendor = (typeof resolveVendor === 'function')
      ? (resolveVendor(tx.vendor, tx.amount, typeof getTxAliasDay === 'function' ? getTxAliasDay(tx) : null) || tx.vendor || '')
      : (tx.vendor || '')
    const included = !tx.excludeFromBudget
    return `
      <label class="unforeseen-row ${included ? '' : 'unforeseen-row-excluded'}">
        <input type="checkbox" ${included ? 'checked' : ''} onchange="_toggleBudgetRowTx('${tx.id}', this.checked)">
        <span class="unforeseen-row-date">${tx.date || ''}</span>
        <span class="unforeseen-row-vendor">${escHtml(vendor)}</span>
        <span class="unforeseen-row-cat">${catLbl}</span>
        <span class="unforeseen-row-amt ${amtCls}">${formatCurrency(amount)}</span>
      </label>`
  }).join('')

  const drillBtn = isResidual
    ? ''
    : `<button class="btn-ghost" onclick="navigateBudgetCatToTx('${catId}','${monthKey}'); closeBudgetRowModal()">↗ פתח במסך עסקאות</button>`

  // V2 hero: category tile + month + actual-vs-budget at a glance.
  const heroBudget = getBudgetsForMonth(monthKey).find(b => b.categoryId === catId && (b.type || 'expense') === type)
  const heroHtml = (typeof v2ModalHero === 'function') ? v2ModalHero({
    icon: catIconHTML(cat, 20) || uiIcon('file', 20),
    tileBg: cat && cat.color ? cat.color + '22' : 'rgba(79,139,255,.13)',
    name: escHtml(cat ? cat.name : 'קטגוריה'),
    meta: `${_budgetFormatMonth(monthKey)} · ${rows.length} עסקאות${excludedCount ? ` · ${excludedCount} מוחרגות` : ''}`,
    amountHtml: `${formatCurrency(includedTotal)}${heroBudget && heroBudget.amount > 0 ? `<small style="font-size:.72rem;color:var(--text-muted);font-weight:500"> מתוך ${formatCurrencyPlain(heroBudget.amount)}</small>` : ''}`,
    amountCls: amtCls,
  }) : ''

  body.innerHTML = `
    ${heroHtml}
    <div style="color:var(--text-muted);font-size:.85rem;margin-bottom:.75rem">${intro}</div>
    <div style="display:flex;justify-content:space-between;gap:.75rem;font-weight:600;margin-bottom:.5rem;flex-wrap:wrap">
      <span>נכלל בחישוב: <span class="${amtCls}">${formatCurrency(includedTotal)}</span></span>
      <span style="display:flex;gap:.75rem;align-items:center">
        ${excludedCount > 0 ? `<span style="color:var(--text-muted)">הוצאו ידנית: ${excludedCount}</span>` : ''}
        ${drillBtn}
      </span>
    </div>
    <div class="unforeseen-list">${lines}</div>`
}

function _toggleBudgetRowTx(txId, included) {
  setTxExcludeFromBudget(txId, !included)
  _renderBudgetRowModal()
  if (typeof renderBudgetScreen === 'function') renderBudgetScreen()
}
