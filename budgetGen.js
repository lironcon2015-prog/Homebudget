// ===== AI BUDGET GENERATOR (v1.12) =====
// Proposes a monthly budget per category for a TARGET MONTH, based on the 3
// *complete* calendar months immediately before that target. All math runs
// locally so the user can audit every number; the Gemini advisor (optional)
// produces narrative commentary only — never changes numbers.
//
// v1.12 formula:
//   baseline = trimmedMean(last 3 months actual)
//   suggested_raw = hasPrevBudget ? 0.7 * baseline + 0.3 * prevMonthBudget
//                                 : baseline
//   recurringFloor = Σ non-monthly recurring items hitting the target month
//   suggested = max(suggested_raw, recurringFloor), rounded to 10
//
// Outlier rule (100%): if one month is >100% above the mean of the *other*
// months, treat it as a one-off and exclude it from the baseline. Applied
// symmetrically for expenses and income (unusual low/high both handled via
// abs ratio).

let _budgetGenProposals = null
let _budgetGenAdvice = ''                // overall summary (optional)
let _budgetGenAdvicePerCat = {}          // categoryId → short Hebrew note
let _budgetGenTargetMonth = null  // 'YYYY-MM'

function _bgMean(arr) {
  if (arr.length === 0) return 0
  return arr.reduce((s,v)=>s+v,0) / arr.length
}

function _bgMedian(arr) {
  if (arr.length === 0) return 0
  const s = arr.slice().sort((a,b)=>a-b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid-1] + s[mid]) / 2 : s[mid]
}

// For each value v_i, compare to mean-of-others. If ratio >2.0 → outlier.
function _bgTrimmedMean25(values) {
  if (values.length <= 1) return { trimmed: values[0] || 0, outliers: [], wasTrimmed: false }
  const outliers = []
  for (let i = 0; i < values.length; i++) {
    const others = values.filter((_, j) => j !== i)
    const othersMean = _bgMean(others)
    if (Math.abs(othersMean) < 0.01) continue
    const ratio = Math.abs(values[i]) / Math.abs(othersMean)
    if (ratio > 2.0) outliers.push(i)
  }
  const kept = values.filter((_, i) => !outliers.includes(i))
  const trimmed = kept.length > 0 ? _bgMean(kept) : _bgMean(values)
  return { trimmed, outliers, wasTrimmed: outliers.length > 0 }
}

function _bgCurrentMonthKey() {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`
}

function _bgPrevMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
}

// Last N complete calendar months BEFORE targetMonth.
// For target=2026-05 with n=3 → ['2026-02','2026-03','2026-04'].
function _bgLastCompleteMonthsBefore(targetMonth, n) {
  const [y, m] = targetMonth.split('-').map(Number)
  const out = []
  for (let i = n; i >= 1; i--) {
    const d = new Date(y, m - 1 - i, 1)
    out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`)
  }
  return out
}

// Amount contributed by a tx to a category's baseline, by category type.
// Expense uses budgetExpenseAmount with a per-month context (CC detail per
// category, lump CC payments dropped only when the targeted CC account has
// detail txs in the same month) — matches computeBudgetStatus so the
// proposed baseline reflects the same numbers the budget tracker will report.
function _bgCategoryAmount(t, type, ctx) {
  if (type === 'income') return isCountedIncome(t) ? t.amount : 0
  return budgetExpenseAmount(t, ctx)
}

// Does recurring item r land in monthKey? Monthly always hits. For
// bi-monthly/quarterly/annual, walk forward from lastSeen by cadenceDays
// and check if any iteration falls inside monthKey.
function _bgRecurringHitsMonth(r, monthKey) {
  if (r.cadence === 'monthly') return true
  if (!r.lastSeen || !r.cadenceDays) return false
  const [ty, tm] = monthKey.split('-').map(Number)
  const monthStart = new Date(ty, tm - 1, 1).getTime()
  const monthEnd   = new Date(ty, tm, 1).getTime() - 1
  const [ly, lm, ld] = r.lastSeen.split('-').map(Number)
  let d = new Date(ly, lm - 1, ld)
  for (let i = 0; i < 40; i++) {
    const t = d.getTime()
    if (t >= monthStart && t <= monthEnd) return true
    if (t > monthEnd) return false
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + r.cadenceDays)
  }
  return false
}

function generateBudgetProposals(targetMonth) {
  const target = targetMonth || _bgCurrentMonthKey()
  _budgetGenTargetMonth = target
  const months = _bgLastCompleteMonthsBefore(target, 3)
  const cats = getCategories()
  const recurring = (typeof getRecurring === 'function' ? getRecurring() : []) || []
  const txs = getTransactions()

  // Pre-filter to baseline months by EFFECTIVE month, so CC purchases at
  // end-of-month whose raw date falls outside the calendar range still get
  // included in the right billing month.
  const monthsSet = new Set(months)
  const periodTx = txs.filter(t => t.date && monthsSet.has(getTxEffectiveMonth(t)))

  // Per-month context (CC-detail set is month-scoped, so the lump-drop rule
  // can flip month to month as cards come and go).
  const monthCtx = {}
  months.forEach(m => {
    monthCtx[m] = _budgetMonthContext(periodTx.filter(t => getTxEffectiveMonth(t) === m))
  })

  // Last-month budgets (for 70/30 blend), keyed by categoryId|type.
  const prevMonthKey = _bgPrevMonthKey(target)
  const prevBudgets = (typeof getBudgetsForMonth === 'function') ? getBudgetsForMonth(prevMonthKey) : []
  const prevByKey = {}
  prevBudgets.forEach(b => { prevByKey[b.categoryId + '|' + (b.type || 'expense')] = b })

  const proposals = []
  for (const cat of cats) {
    const type = cat.type
    if (type !== 'expense' && type !== 'income') continue
    const catTxs = periodTx.filter(t => t.categoryId === cat.id)
    const perMonth = months.map(m =>
      catTxs
        .filter(t => getTxEffectiveMonth(t) === m)
        .reduce((s, t) => s + _bgCategoryAmount(t, type, monthCtx[m]), 0)
    )
    const { trimmed, outliers, wasTrimmed } = _bgTrimmedMean25(perMonth)
    const median = _bgMedian(perMonth)
    const mean = _bgMean(perMonth)

    const prevBudget = prevByKey[cat.id + '|' + type]?.amount
    const hasPrev = typeof prevBudget === 'number' && prevBudget > 0
    const blended = hasPrev ? 0.7 * trimmed + 0.3 * prevBudget : trimmed

    // Recurring layer for this category — only entries whose direction matches
    // the category type (income vs expense). Monthly-equivalent (smoothedMonthly)
    // already converts a quarterly bill into ~1/3 of itself per month, so this
    // is the "fixed monthly load" that the budget MUST cover regardless of the
    // historical baseline.
    const recForCat = recurring.filter(r => r.categoryId === cat.id && (
      type === 'income' ? r.smoothedMonthly > 0 : r.smoothedMonthly < 0
    ))
    const recurringFixed = recForCat.reduce((s, r) => s + Math.abs(r.smoothedMonthly), 0)

    // Non-monthly bumps that LAND in the target month — when a quarterly bill
    // hits this exact month, the floor should be the full amount, not the 1/3
    // smoothed share. Take the bigger of the two so both regimes are covered.
    const nonMonthlyRec = recForCat.filter(r => r.cadence !== 'monthly')
    const recurringHits = nonMonthlyRec.filter(r => _bgRecurringHitsMonth(r, target))
    const nonMonthlyFloor = recurringHits.reduce((s, r) => s + Math.abs(r.avgAmount), 0)
    const recurringFloor = Math.max(recurringFixed, nonMonthlyFloor)

    const raw = Math.max(blended, recurringFloor)
    const suggested = Math.max(0, Math.round(raw / 10) * 10)
    const flooredByRecurring = recurringFloor > blended && recurringFloor > 0

    const notes = recForCat.map(r => ({
      vendor: r.vendor,
      cadence: r.cadenceLabel,
      cadenceKey: r.cadence,
      avgAmount: r.avgAmount,
      smoothedMonthly: r.smoothedMonthly,
      expectedThisMonth: r.cadence === 'monthly' ? true : _bgRecurringHitsMonth(r, target),
    }))

    const totalAbs = perMonth.reduce((s,v)=>s+Math.abs(v),0)
    if (totalAbs === 0 && notes.length === 0 && !hasPrev) continue

    proposals.push({
      categoryId: cat.id,
      category: cat,
      type,
      perMonth,
      months,
      mean,
      median,
      trimmedMean: trimmed,
      prevBudget: hasPrev ? prevBudget : null,
      blended,
      recurringFixed,
      recurringFloor,
      flooredByRecurring,
      suggested,
      outliers,
      wasTrimmed,
      recurringNotes: notes,
      include: suggested > 0,
    })
  }

  proposals.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'expense' ? -1 : 1
    return Math.abs(b.suggested) - Math.abs(a.suggested)
  })

  _budgetGenProposals = proposals
  return proposals
}

// ===== UI =====

function openBudgetGenModal(targetMonth) {
  _budgetGenAdvice = ''
  _budgetGenAdvicePerCat = {}
  const target = targetMonth || (typeof getBudgetScreenMonth === 'function' ? getBudgetScreenMonth() : _bgCurrentMonthKey())
  generateBudgetProposals(target)
  _renderBudgetGenModal()
  document.getElementById('budgetGenModal').classList.add('open')
}

function closeBudgetGenModal() {
  document.getElementById('budgetGenModal').classList.remove('open')
}

function _renderBudgetGenModal() {
  const body = document.getElementById('budgetGenBody')
  if (!body) return
  const props = _budgetGenProposals || []
  const targetLabel = (typeof _budgetFormatMonth === 'function' && _budgetGenTargetMonth)
    ? _budgetFormatMonth(_budgetGenTargetMonth)
    : (_budgetGenTargetMonth || '')
  const header = document.getElementById('budgetGenTitle')
  if (header) header.textContent = `הצעת תקציב ל-${targetLabel}`

  if (props.length === 0) {
    body.innerHTML = '<p style="color:var(--text-muted);padding:2rem;text-align:center">אין מספיק נתונים ב-3 החודשים שקדמו לחודש היעד להצעת תקציב.</p>'
    return
  }
  const expProps = props.filter(p => p.type === 'expense')
  const incProps = props.filter(p => p.type === 'income')

  const renderRow = (p) => {
    const idx = props.indexOf(p)
    const monthsCols = p.perMonth.map((v, i) => {
      const isOut = p.outliers.includes(i)
      const title = p.months[i] + (isOut ? ' (חריג — הוחרג)' : '')
      return `<span class="bgen-mo ${isOut?'bgen-mo-out':''}" title="${title}">${formatCurrency(v)}</span>`
    }).join('')
    const notesHTML = p.recurringNotes.length === 0 ? '' :
      '<div class="bgen-notes">' +
      p.recurringNotes.map(n => `
        <span class="bgen-note ${n.expectedThisMonth?'bgen-note-hot':''}" title="ממוצע ${formatCurrency(n.avgAmount)}">
          ${n.vendor} · ${n.cadence}${n.expectedThisMonth?' · צפוי בחודש היעד':''}
        </span>`).join('') + '</div>'
    const outBadge = p.wasTrimmed ? '<span class="bgen-badge">חריג הוחרג</span>' : ''
    const prevLine = p.prevBudget != null
      ? `<div>חודש קודם: ${formatCurrency(p.prevBudget)}</div><div>בלנד 70/30: ${formatCurrency(p.blended)}</div>`
      : ''
    const fixedLine = p.recurringFixed > 0
      ? `<div class="bgen-fixed-tag" title="חלק זה של התקציב מקורו בהוצאות/הכנסות שזוהו כקבועות (חודשי שקול)">📌 מתוך זה ${formatCurrency(p.recurringFixed)} קבוע</div>`
      : ''
    const floorLine = p.flooredByRecurring
      ? `<div class="bgen-floor-tag" title="הרצפה ממחזורי גבוהה מהבסיס ההיסטורי — התקציב הועלה להתאמה">📌 רצפה ממחזורי: ${formatCurrency(p.recurringFloor)}</div>`
      : ''
    const aiAdvice = _budgetGenAdvicePerCat[p.categoryId]
    const aiLine = aiAdvice
      ? `<div class="bgen-ai-advice" title="המלצת AI">💡 ${aiAdvice}</div>`
      : ''
    return `
      <tr>
        <td><input type="checkbox" onchange="_toggleBudgetProposal(${idx})" ${p.include?'checked':''}></td>
        <td><span class="budget-cat-name">${catIconHTML(p.category)} ${p.category.name}</span>${notesHTML}${aiLine}</td>
        <td class="bgen-months">${monthsCols}</td>
        <td class="bgen-stats">
          <div>חציון: ${formatCurrency(p.median)}</div>
          <div>ממוצע: ${formatCurrency(p.mean)}</div>
          <div>מקוצץ: ${formatCurrency(p.trimmedMean)}</div>
          ${prevLine}
          ${fixedLine}
          ${floorLine}
          ${outBadge}
        </td>
        <td>
          <div class="budget-input-wrap">
            <span class="budget-currency">₪</span>
            <input type="number" min="0" step="10" value="${p.suggested}" class="budget-input" onchange="_updateBudgetProposal(${idx}, this.value)">
          </div>
        </td>
      </tr>`
  }

  const table = (rows, title, sectionKey) => rows.length === 0 ? '' : `
    <h4 style="margin:1.25rem 0 .5rem">${title}</h4>
    <div style="overflow-x:auto">
      <table class="data-table bgen-table">
        <thead>
          <tr>
            <th style="width:2.2rem"><input type="checkbox" onchange="_toggleAllBudgetProposals('${sectionKey}', this.checked)" ${rows.every(r => r.include)?'checked':''}></th>
            <th>קטגוריה</th>
            <th>3 חודשים אחרונים</th>
            <th>סטטיסטיקה</th>
            <th>תקציב מוצע</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(renderRow).join('')}
        </tbody>
      </table>
    </div>`

  const advice = _budgetGenAdvice ? `
    <div class="bgen-advice">
      <strong>💡 סיכום AI כללי</strong>
      <div style="white-space:pre-wrap;margin-top:.5rem">${_budgetGenAdvice}</div>
    </div>` : ''

  body.innerHTML = `
    <div style="color:var(--text-muted);font-size:.85rem;margin-bottom:.75rem">
      מבוסס על 3 חודשים מלאים לפני ${targetLabel} בשילוב שכבת ההכנסות/הוצאות הקבועות. ערכים חריגים (מעל 100% מעל ממוצע האחרים) הוחרגו מהבסיס.
      כשקיים תקציב לחודש שקדם, הבלנד הוא 70% בסיס היסטורי + 30% תקציב קודם — תמיד מעל רצפת הקבועות (חודשי שקול), עם תוספת לחודשים שבהם נופלת הוצאה דו-חודשית/רבעונית/שנתית.
    </div>
    ${advice}
    ${table(expProps, 'הוצאות', 'expense')}
    ${table(incProps, 'הכנסות צפויות', 'income')}
  `
}

function _toggleBudgetProposal(idx) {
  if (!_budgetGenProposals) return
  const p = _budgetGenProposals[idx]
  p.include = !p.include
}

function _toggleAllBudgetProposals(sectionKey, checked) {
  if (!_budgetGenProposals) return
  _budgetGenProposals.forEach(p => { if (p.type === sectionKey) p.include = checked })
  _renderBudgetGenModal()
}

function _updateBudgetProposal(idx, value) {
  if (!_budgetGenProposals) return
  const v = parseFloat(value)
  _budgetGenProposals[idx].suggested = (!isFinite(v) || v < 0) ? 0 : v
}

function applyBudgetProposals() {
  if (!_budgetGenProposals) return
  const target = _budgetGenTargetMonth || _bgCurrentMonthKey()
  let applied = 0
  for (const p of _budgetGenProposals) {
    if (!p.include) continue
    if (!p.suggested || p.suggested <= 0) { deleteBudget(p.categoryId, target); continue }
    setBudget(p.categoryId, target, p.suggested, p.type)
    applied++
  }
  closeBudgetGenModal()
  if (typeof renderBudgetScreen === 'function') renderBudgetScreen()
  toast(`${applied} תקציבים הוחלו על ${(typeof _budgetFormatMonth==='function')?_budgetFormatMonth(target):target}.`, { type: 'success' })
}

async function adviseBudgetWithGemini() {
  const apiKey = (typeof getApiKey === 'function') ? getApiKey() : localStorage.getItem('geminiApiKey')
  if (!apiKey) { toast('חסר מפתח Gemini API – הזן בהגדרות', { type: 'error' }); return }
  if (!_budgetGenProposals || _budgetGenProposals.length === 0) return
  const btn = document.getElementById('bgenAdviceBtn')
  if (btn) { btn.disabled = true; btn.textContent = 'טוען…' }
  try {
    // Household-level totals derived from current proposals — these give the
    // AI the big-picture context an economist needs (ratios, savings rate)
    // rather than just per-category data.
    const incProps = _budgetGenProposals.filter(p => p.type === 'income')
    const expProps = _budgetGenProposals.filter(p => p.type === 'expense')
    const totalSuggestedIncome  = incProps.reduce((s, p) => s + (p.suggested || 0), 0)
    const totalSuggestedExpense = expProps.reduce((s, p) => s + (p.suggested || 0), 0)
    const totalSuggestedNet     = totalSuggestedIncome - totalSuggestedExpense
    const totalHistIncome       = incProps.reduce((s, p) => s + (p.mean || 0), 0)
    const totalHistExpense      = expProps.reduce((s, p) => s + (p.mean || 0), 0)
    const totalHistNet          = totalHistIncome - totalHistExpense
    const pct = (n, d) => d > 0 ? Math.round((n / d) * 1000) / 10 : 0
    const householdSummary = {
      totalSuggestedIncome:  Math.round(totalSuggestedIncome),
      totalSuggestedExpense: Math.round(totalSuggestedExpense),
      totalSuggestedNet:     Math.round(totalSuggestedNet),
      suggestedSavingsRatePct: pct(totalSuggestedNet, totalSuggestedIncome),
      totalHistIncome:  Math.round(totalHistIncome),
      totalHistExpense: Math.round(totalHistExpense),
      totalHistNet:     Math.round(totalHistNet),
      histSavingsRatePct: pct(totalHistNet, totalHistIncome),
    }
    const snapshot = _budgetGenProposals.map(p => {
      const denom = p.type === 'income' ? totalSuggestedIncome : totalSuggestedExpense
      const weight = pct(p.suggested || 0, denom)
      return {
        id: p.categoryId,
        category: p.category.name,
        type: p.type,
        months: p.months,
        perMonth: p.perMonth.map(v => Math.round(v)),
        mean: Math.round(p.mean),
        median: Math.round(p.median),
        trimmed: Math.round(p.trimmedMean),
        prevBudget: p.prevBudget,
        blended: Math.round(p.blended),
        recurringFixed: Math.round(p.recurringFixed || 0),
        recurringFloor: Math.round(p.recurringFloor),
        suggested: p.suggested,
        weightOfTotalPct: weight,
        weightOfIncomePct: pct(p.suggested || 0, totalSuggestedIncome),
        outliersRemoved: p.wasTrimmed,
        recurringNotes: p.recurringNotes.map(n => `${n.vendor}:${n.cadence}${n.expectedThisMonth?'(צפוי בחודש היעד)':''}`),
      }
    })
    const prompt = `אתה כלכלן ויועץ פיננסי מקצועי, מומחה בבניית תקציב למשק בית בישראל. אתה מנתח את הנתונים בכלים של כלכלן: יחסים מקובלים בין קטגוריות, שיעור חיסכון, יחס הוצאות קבועות מול משתנות, סיכון לגירעון, ואיתור הוצאות שמרגישות "טבעיות" אבל גודלות בשקט.

ההצעות לפניך חושבו מקומית מ-3 חודשים מלאים לפני חודש היעד: בסיס היסטורי = ממוצע מקוצץ (חריגות מעל 100% מעל ממוצע האחרים מוחרגות), בלנד 70/30 עם תקציב החודש הקודם כשקיים, ורצפה של מחזוריים דו-חודשיים/רבעוניים/שנתיים שצפויים בחודש היעד.

תקציר משק הבית (לפי ההצעה והממוצע ההיסטורי):
${JSON.stringify(householdSummary)}

קווים מנחים למשק בית ישראלי טיפוסי (התייחס כבנצ'מרק, לא חוקים מוחלטים — הקשר משפחתי משפיע):
- שיעור חיסכון בריא: 15-20% מההכנסה. מתחת ל-10% מהווה סיכון לטווח ארוך. מעל 25% מצוין.
- דיור (שכ"ד/משכנתא + ארנונה + ועד בית): 25-35% מההכנסה. מעל 40% נטל גבוה.
- אוכל (סופרים + מסעדות יחד): 12-20% מההכנסה.
- תחבורה (דלק + תחבורה ציבורית + ביטוח רכב + טיפולים): 10-15% מההכנסה.
- שירותים שוטפים (חשמל / מים / גז / תקשורת): 5-8% מההכנסה.
- ביטוחים (חיים / בריאות / רכוש): 3-6% מההכנסה.
- בידור ופנאי: 5-10% מההכנסה.
- בריאות (לא דרך ביטוח): 2-5% מההכנסה.
- חינוך / חוגים / קייטנות: 5-15% מההכנסה (תלוי במספר ילדים וגיל).

לכל קטגוריה ניתן \`weightOfTotalPct\` (אחוז מסך ההכנסות או מסך ההוצאות, בהתאמה) ו-\`weightOfIncomePct\` (אחוז מסך ההכנסה — שימושי גם להוצאות לבחינה מול הבנצ'מרק).

המשימה שלך: לכל קטגוריה תן הערה מקצועית קצרה (משפט אחד עד שניים, מקסימום 25 מילים, בעברית, גוף ראשון של יועץ). שקול:
- האם המשקל של הקטגוריה (weightOfIncomePct) סביר מול הבנצ'מרק
- מגמה (עולה / יורד / יציב), תנודתיות, וחריגות שחוזרות
- האם יש הוצאה מחזורית צפויה
- פערים בין ההיסטוריה לתקציב הקודם
- ההשפעה על שיעור החיסכון של משק הבית

ההערה צריכה להיות פרקטית. דוגמאות לסגנון:
- "אוכל תופס 24% מההכנסה — מעט מעל הטווח המקובל (12-20%); שווה לבחון פוטנציאל חיסכון של 500-800 ₪"
- "ביטוחים 7% מההכנסה — קצה גבול עליון של המקובל; ודא שאין כפל כיסויים"
- "מגמה עולה ב-3 החודשים, ההצעה תופסת זאת; עקוב חודש הבא לוודא שזה לא טרנד מתמשך"
- "סטטיסטיקה יציבה והמשקל מאוזן (4% מההכנסה) — ההצעה ריאלית"

**חובה לתת הערה לכל קטגוריה ברשימה — גם אם תקין, כתוב את התובנה המקצועית.**

ה-summary שלך: משפט אחד-שניים שמסכם את בריאות התקציב הכוללת — האם משק הבית מאוזן, מה שיעור החיסכון מול המקובל, האם יש דגלים אדומים מצרפיים.

החזר JSON תקני בלבד במבנה:
{ "perCategory": [ { "id": "<id מהנתונים>", "advice": "<טקסט עברי קצר>" }, ... ], "summary": "<משפט סיכום על בריאות התקציב>" }

נתוני קטגוריות:
${JSON.stringify(snapshot)}`
    const data = await callGemini(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            perCategory: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  id: { type: 'STRING' },
                  advice: { type: 'STRING' },
                },
                required: ['id', 'advice'],
              },
            },
            summary: { type: 'STRING' },
          },
          required: ['perCategory'],
        },
      },
    })
    const parts = data.candidates?.[0]?.content?.parts || []
    let text = ''
    for (const p of parts) { if (!p.thought && p.text) { text = p.text; break } }
    if (!text) text = parts[0]?.text || ''
    const parsed = JSON.parse(text)
    _budgetGenAdvicePerCat = {}
    ;(parsed.perCategory || []).forEach(item => {
      if (item && item.id && item.advice && String(item.advice).trim()) {
        _budgetGenAdvicePerCat[item.id] = String(item.advice).trim()
      }
    })
    _budgetGenAdvice = parsed.summary ? String(parsed.summary).trim() : ''
  } catch (e) {
    _budgetGenAdvice = 'שגיאה: ' + (e.message || e)
  }
  if (btn) { btn.disabled = false; btn.textContent = '💡 ייעוץ AI' }
  _renderBudgetGenModal()
}
