// ===== CORE HELPERS =====
// Source of truth for counting income/expenses (fixes double-counting)
//
// P&L PHILOSOPHY: the checking account (and cash) is the authoritative source
// of real income/expenses. Credit-card and savings/investment account transactions
// are detail lines — they move money around but don't represent a fresh expense
// from the user's perspective. Only the bank-level debit to a CC counts as an
// expense; the detailed CC statement rows are informational (category breakdown,
// balance tracking) but excluded from P&L totals to avoid double counting.
//
// Transfers never count in P&L (they're movements between owned accounts).
//
// REFUNDS ARE A THIRD FLOW (since 1.47.0). They are neither income nor a
// negative expense: they get their own line/bucket everywhere they surface.
// The reason is that a refund almost never lands in the month (or the payment
// plan) of the expense it refunds — a purchase split over six installments can
// be refunded in cash next week. Netting it into the expense side therefore
// made one month look expensive and another artificially cheap, and made a
// category read as if the money had never gone out. Cash-flow attribution stays
// honest: every row sits in the month its money actually moved, and the
// PRESENTATION separates refunds instead.
//   expenses = gross outflow · refunds = credits back · net = inc - exp + ref
// Net is identical to what the old netting produced; only the two sides split.

const PL_ACCOUNT_TYPES = new Set(['checking', 'cash'])

let _plAcctIdsCache = null
let _plAcctIdsCacheTs = 0
function _getPLAccountIds() {
  const now = Date.now()
  if (!_plAcctIdsCache || now - _plAcctIdsCacheTs > 500) {
    _plAcctIdsCache = new Set(getAccounts().filter(a => PL_ACCOUNT_TYPES.has(a.type)).map(a => a.id))
    _plAcctIdsCacheTs = now
  }
  return _plAcctIdsCache
}
function invalidatePLCache() { _plAcctIdsCache = null }

let _accInfoCache = null
let _accInfoCacheTs = 0
function _getAccountInfo(accountId) {
  const now = Date.now()
  if (!_accInfoCache || now - _accInfoCacheTs > 500) {
    _accInfoCache = new Map(getAccounts().map(a => [a.id, { type: a.type, billingDay: a.billingDay }]))
    _accInfoCacheTs = now
  }
  return _accInfoCache.get(accountId) || null
}
function invalidateAccountCache() { _accInfoCache = null }

function isPLTransaction(t) { return _getPLAccountIds().has(t.accountId) }

// The refunds bucket is a DISPLAY bucket, not a category: the refund row keeps
// its own category (health, car…) so the drill-down can still say what was
// refunded. Turning it into a real category would have thrown that away.
const REFUND_BUCKET_ID = '__refunds__'
const REFUND_BUCKET_NAME = 'החזרים'
const REFUND_BUCKET_COLOR = '#38bdf8'

function isCountedIncome(t)  { return isPLTransaction(t) && t.amount > 0 && t.type !== 'transfer' && t.type !== 'refund' }
function isCountedExpense(t) { return isPLTransaction(t) && t.amount < 0 && t.type !== 'transfer' }
function isCountedRefund(t)  { return isPLTransaction(t) && t.type === 'refund' && t.amount > 0 }

function countedExpenseAmount(t) {
  if (!isPLTransaction(t)) return 0
  if (t.type === 'refund' && t.amount > 0) return 0
  if (t.amount < 0 && t.type !== 'transfer') return Math.abs(t.amount)
  return 0
}

// Positive = money that came back. A refund row with a NEGATIVE amount is a
// mislabelled outflow and stays on the expense side (see countedExpenseAmount).
function countedRefundAmount(t) { return isCountedRefund(t) ? t.amount : 0 }

function sumIncome(txs)   { return txs.filter(isCountedIncome).reduce((s,t)=>s+t.amount,0) }
function sumExpenses(txs) { return txs.reduce((s,t)=>s+countedExpenseAmount(t),0) }
function sumRefunds(txs)  { return txs.reduce((s,t)=>s+countedRefundAmount(t),0) }
function sumNet(txs)      { return sumIncome(txs) - sumExpenses(txs) + sumRefunds(txs) }

// ===== "HIDDEN SAVINGS" — expense categories tagged isSavings =====
// A user can mark any expense category as isSavings=true via the category
// editor. Amounts in those categories are still real outflows (money left
// the checking account), so we keep them in sumExpenses by default — but
// they represent money the user *kept* (moved to savings/investment/etc.)
// rather than consumed. These helpers let us present that separately.
let _savingsCatCache = null
let _savingsCatCacheTs = 0
function getSavingsCategoryIds() {
  const now = Date.now()
  if (!_savingsCatCache || now - _savingsCatCacheTs > 500) {
    _savingsCatCache = new Set(getCategories().filter(c => c.isSavings).map(c => c.id))
    _savingsCatCacheTs = now
  }
  return _savingsCatCache
}
function invalidateSavingsCache() { _savingsCatCache = null }

function isHiddenSavings(t) {
  if (!isPLTransaction(t)) return false
  if (t.type === 'transfer') return false
  if (!(t.amount < 0 || (t.type === 'refund' && t.amount > 0))) return false
  return t.categoryId && getSavingsCategoryIds().has(t.categoryId)
}

// Refunds stay NETTED here, unlike every other sum: this figure is "money the
// user kept", and a refund of a savings deposit means that much was never put
// aside. Splitting it out would have inflated the true-savings-rate numerator
// by the refund while net stayed flat.
function sumHiddenSavings(txs) {
  return txs.reduce((s, t) => s + (isHiddenSavings(t) ? countedExpenseAmount(t) - countedRefundAmount(t) : 0), 0)
}

// ===== "CAPITAL INCOME" — income categories tagged isSavingsReduction =====
// Income that is actually savings depletion (dividends, security sales,
// savings-account withdrawals). Still counted as income in raw sumIncome,
// but the savings-rate calculator subtracts it so the rate reflects only
// true earned income.
let _capitalIncomeCatCache = null
let _capitalIncomeCatCacheTs = 0
function getCapitalIncomeCategoryIds() {
  const now = Date.now()
  if (!_capitalIncomeCatCache || now - _capitalIncomeCatCacheTs > 500) {
    _capitalIncomeCatCache = new Set(getCategories().filter(c => c.isSavingsReduction).map(c => c.id))
    _capitalIncomeCatCacheTs = now
  }
  return _capitalIncomeCatCache
}
function invalidateCapitalIncomeCache() { _capitalIncomeCatCache = null }

function isCapitalIncome(t) {
  return isCountedIncome(t) && t.categoryId && getCapitalIncomeCategoryIds().has(t.categoryId)
}
function sumCapitalIncome(txs) {
  return txs.reduce((s, t) => s + (isCapitalIncome(t) ? t.amount : 0), 0)
}

// ===== CC LUMP DETECTION (shared by analysis & budget) =====
// A "CC lump" is a bank-side aggregate payment that pays off a CC account.
// We drop it from expense breakdowns ONLY IF that CC account already has
// itemized statement data in the same tx set — otherwise the lump is the
// user's only visibility into the spend and must remain counted.
//
// Detection order (most specific → least):
//   1. explicit `ccPaymentForAccountId` flag set by autoLinkTransfersByPattern.
//   2. vendor/description matches a specific CC account's paymentVendorPatterns.
//   3. vendor/description hits a generic CC keyword → returns `_CC_LUMP_ANY`
//      (we know it's a CC payment but not which card).
const _CC_LUMP_ANY = '__any_cc__'

let _ccLumpDetectCache = null
let _ccLumpDetectCacheTs = 0
function _getCcLumpDetect() {
  const now = Date.now()
  if (_ccLumpDetectCache && now - _ccLumpDetectCacheTs < 500) return _ccLumpDetectCache
  const ccAccs = getAccounts().filter(a => a.type === 'credit_card')
  const ccAccPatterns = ccAccs.map(a => ({
    id: a.id,
    needles: (a.paymentVendorPatterns || [])
      .map(p => String(p || '').toLowerCase().trim())
      .filter(Boolean),
  }))
  const hasCc = ccAccs.length > 0
  const keywords = (hasCc && typeof CC_KEYWORDS !== 'undefined') ? CC_KEYWORDS.map(k => k.toLowerCase()) : []
  _ccLumpDetectCache = { hasCc, ccAccPatterns, keywords }
  _ccLumpDetectCacheTs = now
  return _ccLumpDetectCache
}
function invalidateCcLumpDetectCache() { _ccLumpDetectCache = null }

function ccLumpTargetForTx(t) {
  if (t.ccPaymentForAccountId) return t.ccPaymentForAccountId
  if (t.amount >= 0) return null
  if (t.type === 'transfer') return null
  const det = _getCcLumpDetect()
  if (!det.hasCc) return null
  const info = _getAccountInfo(t.accountId)
  if (info && info.type !== 'checking' && info.type !== 'cash') return null
  const text = ((t.vendor || '') + ' ' + (t.description || '')).toLowerCase()
  if (!text.trim()) return null
  for (const acc of det.ccAccPatterns) {
    if (acc.needles.some(n => text.includes(n))) return acc.id
  }
  if (det.keywords.some(k => text.includes(k))) return _CC_LUMP_ANY
  return null
}

// Set of CC account ids that have at least one of their own (itemized)
// transactions inside the given tx list.
function ccAccountsWithDetail(txs) {
  const out = new Set()
  for (const t of txs) {
    const info = _getAccountInfo(t.accountId)
    if (info && info.type === 'credit_card') out.add(t.accountId)
  }
  return out
}

function shouldDropCcLump(t, ccAccsWithDetail) {
  if (!ccAccsWithDetail) return false
  const target = ccLumpTargetForTx(t)
  if (!target) return false
  // Generic CC payment (matched a brand keyword but not a SPECIFIC card): we
  // can't tie it to a scraped card, and it's most likely a non-scraped card
  // whose lump is the only record of that spend — so KEEP it (counts as a
  // general credit-card expense in analysis/budget). Only a lump tied to a
  // specific card that has itemized detail is dropped (its detail rows count
  // instead). To neutralize a scraped card's lump, give that card identifying
  // paymentVendorPatterns (e.g. its 4-digit number) so it matches specifically.
  if (target === _CC_LUMP_ANY) return false
  return ccAccsWithDetail.has(target)
}

// ===== ANALYSIS EXPENSE SCOPE =====
// For the analysis screen's expense breakdown/pie, we want the DETAILED picture:
// show individual CC purchases with their categories instead of the lump-sum
// bank payment. Rules:
//   - skip transfers (internal money movement)
//   - skip CC lump payments whose target CC has itemized data in this tx set
//     (the detail rows already contribute; counting both = double-count).
//     If the target CC has no itemized data, KEEP the lump — it's the only
//     record of the spend.
//   - skip savings/investment account rows — prefer the bank-side transfer
//     (which already carries the "savings" category)
//   - include negative amounts on bank (checking/cash) AND on CC accounts
//   - refunds go to their own bucket (analysisRefundAmount), NOT as a negative
//     slice of the category they happen to carry — a negative pie slice is
//     unrenderable, and the refund's category is usually the refunded thing,
//     not this period's spending on it.
function _inAnalysisScope(t, savingsInvestIds, ccAccsWithDetail) {
  if (t.type === 'transfer') return false
  if (shouldDropCcLump(t, ccAccsWithDetail)) return false
  if (savingsInvestIds && savingsInvestIds.has(t.accountId)) return false
  return true
}
function analysisExpenseAmount(t, savingsInvestIds, ccAccsWithDetail) {
  if (!_inAnalysisScope(t, savingsInvestIds, ccAccsWithDetail)) return 0
  if (t.type === 'refund' && t.amount > 0) return 0
  if (t.amount < 0) return Math.abs(t.amount)
  return 0
}
function analysisRefundAmount(t, savingsInvestIds, ccAccsWithDetail) {
  if (!_inAnalysisScope(t, savingsInvestIds, ccAccsWithDetail)) return 0
  return (t.type === 'refund' && t.amount > 0) ? t.amount : 0
}
function analysisExpenseSavingsInvestIds() {
  return new Set(getAccounts().filter(a => a.type === 'savings' || a.type === 'investment').map(a => a.id))
}

// Refund rows grouped by their own category — the shared source for every
// "החזרים" bucket (dashboard, analysis, mobile, reports, budget). Same scope
// guards as the expense breakdown so the two panels can't disagree.
function refundBreakdownByCategory(txs) {
  const savingsInvestIds = analysisExpenseSavingsInvestIds()
  const ccAccsWithDetail = ccAccountsWithDetail(txs)
  // Resolved from getCategories() rather than getCategoryById() so this stays
  // inside core.js's dependency surface, and so a categoryId pointing at a
  // deleted category falls into the same "לא מסווג" bucket the breakdown uses.
  const byId = new Map(((typeof getCategories === 'function') ? getCategories() : []).map(c => [c.id, c]))
  const byCat = {}
  let total = 0
  let count = 0
  for (const t of txs) {
    const ra = analysisRefundAmount(t, savingsInvestIds, ccAccsWithDetail)
    if (ra <= 0) continue
    const cat = t.categoryId ? byId.get(t.categoryId) : null
    const key = cat ? cat.id : ANALYSIS_EXCL_UNCATEGORIZED
    if (!byCat[key]) byCat[key] = { catId: key, name: cat ? cat.name : 'לא מסווג', color: cat?.color || REFUND_BUCKET_COLOR, total: 0, count: 0 }
    byCat[key].total += ra
    byCat[key].count++
    total += ra
    count++
  }
  return { total, count, rows: Object.values(byCat).sort((a, b) => b.total - a.total) }
}

// ===== ANALYSIS EXCLUSIONS ("what if I hadn't spent this?") =====
// A view-level lens for the analysis screen: the user neutralizes whole expense
// categories (the motivating case is savings/investments) and every analysis
// number is recomputed as if that money had never gone out.
//
// Three deliberate limits:
//   - It is a LENS, not a data change, and it lives only on the analysis
//     screen. The dashboard stays the honest picture, so the analysis screen
//     must announce the lens whenever it is on (see _renderAnalysisExcludeBanner).
//   - INCOME rows are never dropped. A category can carry both signs (a refund
//     year, a savings withdrawal), and zeroing the income side would move the
//     savings rate for reasons the user never asked for.
//   - Transfers are never dropped either — they are already outside every P&L
//     sum, and removing them would only corrupt balance math downstream.
const ANALYSIS_EXCL_UNCATEGORIZED = '__none__'

function getAnalysisExcludedCats() {
  const v = DB.get('finAnalysisExcludedCats', [])
  return Array.isArray(v) ? v : []
}
function saveAnalysisExcludedCats(list) {
  DB.set('finAnalysisExcludedCats', [...new Set(list)])
}
function analysisExcludedCatSet() { return new Set(getAnalysisExcludedCats()) }

function _analysisCatIds() { return new Set(getCategories().map(c => c.id)) }

// Bucket key for a transaction, matching how the expense breakdown groups it:
// a categoryId left pointing at a deleted category renders there as "לא מסווג",
// so it has to neutralize together with the genuinely uncategorized rows —
// otherwise its money would sit in a bucket no picker row can reach.
function analysisCatKey(t, knownCatIds) {
  const id = t.categoryId
  return (id && (knownCatIds || _analysisCatIds()).has(id)) ? id : ANALYSIS_EXCL_UNCATEGORIZED
}

function isAnalysisExcluded(t, excl, knownCatIds) {
  if (!excl || excl.size === 0) return false
  if (t.type === 'transfer') return false
  if (!(t.amount < 0 || (t.type === 'refund' && t.amount > 0))) return false
  return excl.has(analysisCatKey(t, knownCatIds))
}

function applyAnalysisExclusions(txs, excl) {
  const set = excl || analysisExcludedCatSet()
  if (set.size === 0) return txs
  const known = _analysisCatIds()
  return txs.filter(t => !isAnalysisExcluded(t, set, known))
}

// Per-category expense totals in the SAME scope as the analysis breakdown
// (analysisExpenseAmount, not the PL-only sums), so the exclusion picker and
// the banner quote the very numbers the user is reading off the screen when
// they decide what to neutralize. Keyed by category id, uncategorized under
// ANALYSIS_EXCL_UNCATEGORIZED.
function analysisExcludableTotals(txs) {
  const savingsInvestIds = analysisExpenseSavingsInvestIds()
  const ccAccs = ccAccountsWithDetail(txs)
  const known = _analysisCatIds()
  const out = new Map()
  for (const t of txs) {
    if (t.type === 'transfer') continue
    const ca = analysisExpenseAmount(t, savingsInvestIds, ccAccs)
    if (ca === 0) continue
    const key = analysisCatKey(t, known)
    out.set(key, (out.get(key) || 0) + ca)
  }
  return out
}

// Expense total the exclusion removed from the breakdown.
function sumAnalysisExcluded(txs, excl) {
  const set = excl || analysisExcludedCatSet()
  if (set.size === 0) return 0
  let sum = 0
  for (const [key, total] of analysisExcludableTotals(txs)) if (set.has(key)) sum += total
  return sum
}

// ===== PERIOD PRESETS =====
function _ym(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` }
function _iso(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }

// Whole CALENDAR days (local time) between a past timestamp and today — so an
// import from "yesterday evening" reads as 1 day ago, not 0 (a rolling-24h diff
// would call last night "today"). Uses the device's local timezone.
function _daysAgoLocal(ts) {
  const a = new Date(ts), b = new Date()
  const am = new Date(a.getFullYear(), a.getMonth(), a.getDate())
  const bm = new Date(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((bm - am) / 86400000)
}

// ===== Native <input type=date> is locale-flaky and rejects typed input
// reliably only via the browser's native picker. We use a masked text input
// instead so users can type dd/mm/yyyy directly. Helpers here convert
// between the typed format and the ISO 'YYYY-MM-DD' we store internally.
function _isoToDmy(iso) {
  if (!iso) return ''
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  return `${m[3]}/${m[2]}/${m[1]}`
}

function _dmyToIso(s) {
  if (!s) return ''
  const m = String(s).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/)
  if (!m) return ''
  let [_, dd, mm, yy] = m
  if (yy.length === 2) yy = (parseInt(yy, 10) >= 70 ? '19' : '20') + yy
  dd = dd.padStart(2, '0'); mm = mm.padStart(2, '0')
  const mN = parseInt(mm, 10), dN = parseInt(dd, 10)
  if (mN < 1 || mN > 12 || dN < 1) return ''
  // Reject day overflow for the actual month (e.g. 31/02, 31/04).
  if (dN > new Date(parseInt(yy, 10), mN, 0).getDate()) return ''
  return `${yy}-${mm}-${dd}`
}

// Mask handler: keeps the input strictly as dd/mm/yyyy while typing. Auto-
// inserts "/" after day and month so the user types digits only.
function _onDateMaskInput(input) {
  const digits = input.value.replace(/\D/g, '').slice(0, 8)
  let out = digits.slice(0, 2)
  if (digits.length >= 3) out += '/' + digits.slice(2, 4)
  if (digits.length >= 5) out += '/' + digits.slice(4, 8)
  input.value = out
}

// Renders a masked dd/mm/yyyy text input. `cb` is the global function name
// to call on commit (with the ISO string). `extra` is appended HTML attrs
// (e.g., id, class, style). The change event fires only when the value
// parses to a valid ISO (or empty).
function dmyDateInput(value, cb, extra) {
  const dmy = _isoToDmy(value)
  const cls = (extra && /class=/.test(extra)) ? '' : ' class="form-input dmy-input"'
  return `<input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" value="${dmy}"
    oninput="_onDateMaskInput(this)"
    onchange="${cb}(_dmyToIso(this.value), this)"${cls} ${extra||''}>`
}
// =====
function _startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1) }
function _endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth()+1, 0) }

function periodPresets() {
  const now = new Date()
  const som = _startOfMonth(now)
  const lmS = new Date(now.getFullYear(), now.getMonth()-1, 1)
  const lmE = new Date(now.getFullYear(), now.getMonth(), 0)
  const nmS = new Date(now.getFullYear(), now.getMonth()+1, 1)
  const nmE = new Date(now.getFullYear(), now.getMonth()+2, 0)
  return [
    { key: 'next_month',  label: 'חודש הבא',           start: _iso(nmS),                                       end: _iso(nmE) },
    { key: 'this_month',  label: 'חודש נוכחי',        start: _iso(som),                                       end: _iso(now) },
    { key: 'last_month',  label: 'חודש קודם',          start: _iso(lmS),                                       end: _iso(lmE) },
    { key: 'last_3m',     label: '3 חודשים אחרונים',    start: _iso(new Date(now.getFullYear(), now.getMonth()-2, 1)), end: _iso(now) },
    { key: 'last_6m',     label: '6 חודשים אחרונים',    start: _iso(new Date(now.getFullYear(), now.getMonth()-5, 1)), end: _iso(now) },
    { key: 'last_12m',    label: '12 חודשים אחרונים',   start: _iso(new Date(now.getFullYear(), now.getMonth()-11,1)), end: _iso(now) },
    { key: 'ytd',         label: 'מתחילת השנה',        start: _iso(new Date(now.getFullYear(), 0, 1)),          end: _iso(now) },
    { key: 'last_year',   label: 'שנה קודמת',           start: _iso(new Date(now.getFullYear()-1, 0, 1)),        end: _iso(new Date(now.getFullYear()-1, 11, 31)) },
  ]
}

function getActivePeriod() {
  try {
    const raw = localStorage.getItem('finActivePeriod')
    if (raw) {
      const p = JSON.parse(raw)
      if (p?.start && p?.end) return p
    }
  } catch {}
  const presets = periodPresets()
  return presets.find(p => p.key === 'this_month') || presets[0]  // default: current month
}
function setActivePeriod(p) { localStorage.setItem('finActivePeriod', JSON.stringify(p)) }

function filterByPeriod(txs, p) {
  return txs.filter(t => t.date && t.date >= p.start && t.date <= p.end)
}

// Returns the effective billing month (YYYY-MM) for a transaction.
// If tx.chargeDate is present (e.g. CC export with an explicit "תאריך חיוב"
// column), that wins outright — the issuer already told us which billing
// cycle this row belongs to, no need to guess from billingDay rollover.
// Otherwise: credit_card accounts use day-vs-billingDay rollover; everything
// else returns the calendar month of tx.date.
// Which bill cycle CONTAINS a given charge date.
//
// A charge date names the day the money moves, which is not the same as naming
// the bill. A cycle on a card billing on the 10th runs 11/07–10/08 and is called
// August, so a charge dated 30/07 belongs to August even though its calendar
// month is July — and an instalment charged on the purchase's day-of-month
// produces exactly that. Reading the calendar month off the charge date put
// every such row a cycle early.
//
// The cycle is half-open at the start and closed at the end — (billingDay,
// billingDay] — so the bill's own charge date, 10/08, still names August rather
// than rolling into September.
function billingMonthForChargeDate(chargeDate, billingDay) {
  const m = String(chargeDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  let y = Number(m[1]), mo = Number(m[2])
  const d = Number(m[3])
  if (!y || !mo) return ''
  if (d > (billingDay || 10)) { mo += 1; if (mo > 12) { mo = 1; y += 1 } }
  return `${y}-${String(mo).padStart(2, '0')}`
}

function getTxEffectiveMonth(tx) {
  if (!tx.date) return ''
  const info = _getAccountInfo(tx.accountId)
  const [y, m, d] = tx.date.split('-').map(Number)
  if (!y || !m) return ''
  // Non-CC accounts (checking / cash / savings / investment / unknown) are
  // ALWAYS bucketed by the calendar month of `date`. We ignore any stray
  // chargeDate / billingDay these accounts might carry — those fields are
  // CC-only concepts, and a checking account that picked one up (legacy
  // import, account-type change, manual edit) shouldn't have its tx pushed
  // into a different month.
  if (!info || info.type !== 'credit_card') return `${y}-${String(m).padStart(2,'0')}`
  // CC precedence: an explicit billingMonth beats everything. It is set when
  // the statement itself told us which bill it is (a charge-date column, or the
  // period printed in the statement preamble), which is strictly better than
  // any rollover arithmetic. `date` always stays the PURCHASE date, so the two
  // facts never have to fight over one field the way they used to.
  if (/^\d{4}-\d{2}$/.test(String(tx.billingMonth || ''))) return tx.billingMonth
  // Otherwise an explicit chargeDate from the issuer; else billing-day rollover.
  if (tx.chargeDate) {
    const cm = billingMonthForChargeDate(tx.chargeDate, info.billingDay)
    if (cm) return cm
  }
  const billingDay = info.billingDay || 10
  if (d < billingDay) return `${y}-${String(m).padStart(2,'0')}`
  const nm = m === 12 ? 1 : m + 1
  const ny = m === 12 ? y + 1 : y
  return `${ny}-${String(nm).padStart(2,'0')}`
}

// Like filterByPeriod but uses effective billing month instead of raw date.
// Matches transactions whose getTxEffectiveMonth falls within the months
// covered by the period. Used for dashboard/analysis/transactions views.
function filterByEffectivePeriod(txs, p) {
  const months = new Set(monthsInPeriod(p))
  return txs.filter(t => t.date && months.has(getTxEffectiveMonth(t)))
}

function monthsInPeriod(p) {
  const out = []
  const [sy, sm] = p.start.split('-').map(Number)
  const [ey, em] = p.end.split('-').map(Number)
  let y = sy, m = sm
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2,'0')}`)
    m++; if (m > 12) { m = 1; y++ }
  }
  return out
}

function shiftPeriodByYear(p, years = 1) {
  const shift = iso => {
    const [y,m,d] = iso.split('-')
    return `${+y - years}-${m}-${d}`
  }
  return { ...p, start: shift(p.start), end: shift(p.end), key: 'shifted', label: p.label + ' (שנה קודמת)' }
}

// ===== BALANCES =====
// "Liquid" accounts are those whose balance represents immediate purchasing power
// (checking, cash, credit_card debt). Savings & investments are tracked separately.
const NON_LIQUID_ACCOUNT_TYPES = new Set(['savings', 'investment'])
function isLiquidAccount(a) { return !NON_LIQUID_ACCOUNT_TYPES.has(a.type) }

// Per-tx balance delta for one account — the single semantic used everywhere:
// own row adds the amount; the mirror side of a linked/transfer transaction
// (CC payment / savings deposit — independent of type) subtracts it.
function _accountTxDelta(t, accountId) {
  if (t.accountId === accountId) return t.amount
  if (t.transferAccountId === accountId || t.ccPaymentForAccountId === accountId) return -t.amount
  return 0
}

// All current balances in ONE pass over the transactions (the per-account
// scan made dashboards O(accounts × transactions)). Cached by data revision;
// falls back to per-call compute when DB.rev is unavailable (test stubs).
let _allBalancesCache = null
let _allBalancesCacheRev = null
function _getAllBalances() {
  const rev = (typeof DB.rev === 'function') ? `${DB.rev('finTransactions')}:${DB.rev('finAccounts')}` : null
  if (rev !== null && _allBalancesCache && _allBalancesCacheRev === rev) return _allBalancesCache
  const map = new Map()
  getAccounts().forEach(a => map.set(a.id, a.openingBalance || 0))
  for (const t of getTransactions()) {
    if (map.has(t.accountId)) map.set(t.accountId, map.get(t.accountId) + t.amount)
    // Mirror sides — matching the per-account else-if: a row never mirrors
    // into its own account, and an identical transfer/cc target counts once.
    const m1 = t.transferAccountId, m2 = t.ccPaymentForAccountId
    if (m1 && m1 !== t.accountId && map.has(m1)) map.set(m1, map.get(m1) - t.amount)
    if (m2 && m2 !== t.accountId && m2 !== m1 && map.has(m2)) map.set(m2, map.get(m2) - t.amount)
  }
  if (rev !== null) { _allBalancesCache = map; _allBalancesCacheRev = rev }
  return map
}

function getAccountBalance(accountId, uptoDateISO = null) {
  if (!uptoDateISO) {
    const map = _getAllBalances()
    return map.has(accountId) ? map.get(accountId) : 0
  }
  const acc = getAccounts().find(a => a.id === accountId)
  if (!acc) return 0
  let balance = acc.openingBalance || 0
  getTransactions().forEach(t => {
    if (uptoDateISO && t.date > uptoDateISO) return
    balance += _accountTxDelta(t, accountId)
  })
  return balance
}

// End-of-cutoff balances for a list of ISO cutoff dates (ascending), computed
// in one pass instead of dates × full-scan. Matches getAccountBalance's
// semantics exactly: a tx with a missing date is never "after" any cutoff,
// so it counts toward every cutoff (empty string sorts before any ISO date).
function getAccountBalanceSeries(accountId, cutoffsAsc) {
  const acc = getAccounts().find(a => a.id === accountId)
  if (!acc) return cutoffsAsc.map(() => 0)
  const deltas = []
  for (const t of getTransactions()) {
    const d = _accountTxDelta(t, accountId)
    if (d !== 0) deltas.push([t.date || '', d])
  }
  deltas.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out = []
  let run = acc.openingBalance || 0
  let i = 0
  for (const cutoff of cutoffsAsc) {
    while (i < deltas.length && deltas[i][0] <= cutoff) { run += deltas[i][1]; i++ }
    out.push(run)
  }
  return out
}

function getLiquidBalance(uptoDateISO = null) {
  return getAccounts().filter(isLiquidAccount).reduce((s, a) => s + getAccountBalance(a.id, uptoDateISO), 0)
}

// Balance across P&L accounts only (checking + cash). Accurate because it
// mirrors the bank statements directly — unlike CC balances which depend on
// timing that the app can't observe.
function getCheckingCashBalance(uptoDateISO = null) {
  return getAccounts().filter(a => PL_ACCOUNT_TYPES.has(a.type)).reduce((s, a) => s + getAccountBalance(a.id, uptoDateISO), 0)
}

function getLiquidBalanceTrend(months) {
  const cutoffs = months.map(mo => {
    const [y, m] = mo.split('-').map(Number)
    return _iso(new Date(y, m, 0))
  })
  const liquid = getAccounts().filter(isLiquidAccount)
  const totals = cutoffs.map(() => 0)
  for (const a of liquid) {
    const series = getAccountBalanceSeries(a.id, cutoffs)
    series.forEach((v, i) => { totals[i] += v })
  }
  return months.map((mo, i) => ({ month: mo, balance: totals[i] }))
}

// Flow to/from a specific account during a period.
// Deposited = positive balance deltas entering the account (including mirror side of transfers)
// Withdrawn = negative balance deltas leaving the account
function getAccountFlow(accountId, period) {
  const txs = filterByPeriod(getTransactions(), period)
  let deposited = 0, withdrawn = 0
  txs.forEach(t => {
    let delta = 0
    if (t.accountId === accountId) {
      delta = t.amount
    } else if (t.transferAccountId === accountId || t.ccPaymentForAccountId === accountId) {
      delta = -t.amount
    }
    if (delta > 0) deposited += delta
    else if (delta < 0) withdrawn += -delta
  })
  return { deposited, withdrawn, net: deposited - withdrawn }
}

// ===== PERIOD SELECTOR UI =====
function renderPeriodSelector(containerId, onChange) {
  const el = document.getElementById(containerId)
  if (!el) return
  const active = getActivePeriod()
  const presets = periodPresets()
  el.innerHTML = `
    <div class="period-selector">
      <div class="period-presets">
        ${presets.map(p => `<button class="period-btn ${active.key===p.key?'active':''}" data-key="${p.key}">${p.label}</button>`).join('')}
        <button class="period-btn ${active.key==='custom'?'active':''}" data-key="custom">טווח מותאם</button>
      </div>
      <div class="period-custom" style="display:${active.key==='custom'?'flex':'none'}">
        <label class="form-label" style="margin:0">מ:</label>
        <input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" id="periodCustomStart" value="${_isoToDmy(active.start||'')}" oninput="_onDateMaskInput(this)">
        <label class="form-label" style="margin:0">עד:</label>
        <input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" id="periodCustomEnd" value="${_isoToDmy(active.end||'')}" oninput="_onDateMaskInput(this)">
        <button class="btn-primary" id="periodCustomApply" style="padding:.4rem .9rem">החל</button>
      </div>
    </div>`
  el.querySelectorAll('.period-btn').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.key
    if (key === 'custom') {
      el.querySelector('.period-custom').style.display = 'flex'
      el.querySelectorAll('.period-btn').forEach(x => x.classList.remove('active'))
      b.classList.add('active')
      return
    }
    const p = presets.find(x => x.key === key)
    if (p) { setActivePeriod(p); renderPeriodSelector(containerId, onChange); onChange?.(p) }
  }))
  const applyBtn = el.querySelector('#periodCustomApply')
  if (applyBtn) applyBtn.addEventListener('click', () => {
    const s = _dmyToIso(el.querySelector('#periodCustomStart').value)
    const e = _dmyToIso(el.querySelector('#periodCustomEnd').value)
    if (!s || !e) return
    const p = { key: 'custom', label: `${formatDate(s)} → ${formatDate(e)}`, start: s, end: e }
    setActivePeriod(p); onChange?.(p)
  })
}

// ===== TRANSFER AUTO-MATCHING =====
// Matches a bank transaction against accounts that define paymentVendorPatterns
// (credit_card, savings, or investment). Returns the matched account or null.
const PATTERN_MATCHABLE_TYPES = new Set(['credit_card', 'savings', 'investment'])
function findMatchingAccountByPattern(vendor, description) {
  const text = ((vendor || '') + ' ' + (description || '')).toLowerCase().trim()
  if (!text) return null
  const candidates = getAccounts().filter(a => PATTERN_MATCHABLE_TYPES.has(a.type))
  for (const acc of candidates) {
    const patterns = acc.paymentVendorPatterns || []
    for (const p of patterns) {
      if (!p) continue
      if (text.includes(p.toLowerCase().trim())) return acc
    }
  }
  return null
}

// Scan all transactions on liquid source accounts and LINK matching outflows
// to their destination (CC / savings / investment). CRITICAL: the bank line
// stays as type='expense' so it continues to count in P&L totals — linking
// only adds a cross-reference for balance mirroring and for excluding the
// row from the expense-by-category pie (where the details live on the other
// side). Returns count of updates.
function autoLinkTransfersByPattern() {
  const txs = getTransactions()
  const accs = getAccounts()
  const srcAccIds = new Set(accs.filter(a => !PATTERN_MATCHABLE_TYPES.has(a.type)).map(a => a.id))
  let changed = 0
  txs.forEach(t => {
    if (!srcAccIds.has(t.accountId)) return
    if (t.amount >= 0) return
    if (t.ccPaymentForAccountId || t.transferAccountId) return
    const match = findMatchingAccountByPattern(t.vendor, t.description)
    if (!match) return
    if (match.type === 'credit_card') {
      // Bank-level CC payment: keep as expense so it counts. Tag it so the
      // category pie can exclude it (details live in the CC account).
      t.ccPaymentForAccountId = match.id
    } else {
      // Savings / investment deposit: keep as expense on bank (shows up in
      // "חסכונות והשקעות" category). Link for balance mirroring only.
      t.transferAccountId = match.id
      if (!t.categoryId) t.categoryId = 'cat_invest_out'
    }
    changed++
  })
  if (changed > 0) DB.set('finTransactions', txs)
  return changed
}

// ===== CC PURCHASES FIX =====
// Bug fix: prior migration marked negative bank tx with CC-keyword vendor as transfer.
// But if a CC statement was imported, its ACTUAL purchases might also carry CC-keyword
// descriptions and get wrongly marked as transfer.
// Fix: for transactions on credit_card accounts, force type='expense' (amount<0) or 'income' (amount>0)
function fixCcStatementTypes() {
  const ccIds = new Set(getAccounts().filter(a => a.type === 'credit_card').map(a => a.id))
  if (ccIds.size === 0) return 0
  const txs = getTransactions()
  let changed = 0
  txs.forEach(t => {
    if (!ccIds.has(t.accountId)) return
    if (t.type === 'transfer' && !t.ccPaymentForAccountId) {
      // CC account transaction mistakenly marked as transfer - fix
      t.type = t.amount > 0 ? 'income' : 'expense'
      changed++
    }
  })
  if (changed > 0) DB.set('finTransactions', txs)
  return changed
}

// ===== CATEGORY RULES =====
// Deterministic vendor→category matching. Priority:
//   1. User-defined rules (finCategoryRules)
//   2. Account-derived rules (savings/investment accounts auto-contribute)
//   3. Default seed rules for common Israeli merchants
// First substring match (case-insensitive) wins.

const DEFAULT_CATEGORY_RULES = [
  { patterns: ['שופרסל','רמי לוי','ויקטורי','יוחננוף','יינות ביתן','מגה','קרפור','אושר עד','טיב טעם','מחסני השוק','האחים דהן','shufersal','rami levy'], categoryId: 'cat_food' },
  { patterns: ['סופרפארם','super-pharm','סופר פארם','בי אנד לייף','ניובר','ליפמן פארם'], categoryId: 'cat_health' },
  { patterns: ['מכבי','כללית','מאוחדת','לאומית','רופא','קופת חולים','בית מרקחת','מרפאה','רנטגן'], categoryId: 'cat_health' },
  { patterns: ['פז ','דור אלון','סונול','פנגו','טן ','delek','paz','דלק חברה'], categoryId: 'cat_fuel' },
  { patterns: ['רכבת ישראל','אגד','דן תחבורה','קווים','רב-קו','רב קו','סופרבוס','מוניות','egged','dan tnu','moovit','גט טקסי','יאנגו','gett'], categoryId: 'cat_transport' },
  { patterns: ['חברת החשמל','חב החשמל','חברת חשמל','בזק','הוט','סלקום','פרטנר','פלאפון','012','019','015'], categoryId: 'cat_bills' },
  { patterns: ['מי אביבים','הגיחון','מיתב','מי רעננה','מי שבע','תאגיד מים','מקורות'], categoryId: 'cat_bills' },
  { patterns: ['פז גז','סופרגז','דור גז','אמישראגז','גזטל'], categoryId: 'cat_bills' },
  { patterns: ['ארנונה','עיריית','מועצה מקומית'], categoryId: 'cat_bills' },
  { patterns: ['netflix','נטפליקס','spotify','ספוטיפיי','youtube','disney','apple.com','icloud','itunes','hbo','stan','paramount'], categoryId: 'cat_leisure' },
  { patterns: ['קולנוע','הכרטיס','יס פלאנט','סינמה סיטי','רב-חן','היכל התרבות','פסטיבל','גלילאו','bookme','ticketim','ticmate'], categoryId: 'cat_leisure' },
  { patterns: ['aliexpress','amazon','amzn','ebay','shein','asos','terminal x','next direct','wish','lightinthebox','temu','zara','h&m'], categoryId: 'cat_online' },
  { patterns: ['מגדל','הראל','מנורה','הפניקס','כלל ביטוח','איילון ביטוח','ביטוח ישיר','שומרה','clal'], categoryId: 'cat_insurance' },
  { patterns: ['ביטוח לאומי','מס הכנסה','רשות המסים','משרד התחבורה'], categoryId: 'cat_bills' },
  { patterns: ['ארומה','ארקפה','גרג','roladin','רולדין','מקדונלד','בורגר','פיצה','דומינוס','kfc','wolt','10bis','tenbis','ten bis','גולדה','starbucks','bbb','japanika','humus'], categoryId: 'cat_rest' },
  { patterns: ['עמלה','עמלת','ריבית חובה','ריבית זכות','ניהול חשבון','דמי ניהול','דמי כרטיס','שורות','התראות','דמי שורה'], categoryId: 'cat_bank' },
  { patterns: ['משכורת','שכר עבודה','תלוש שכר'], categoryId: 'cat_salary' },
  { patterns: ['החזר מס','מס הכנסה החזר','זיכוי מס'], categoryId: 'cat_taxback' },
]

function getCategoryRules() { return DB.get('finCategoryRules', []) }
function saveCategoryRules(list) { DB.set('finCategoryRules', list) }

function addCategoryRule(pattern, categoryId) {
  const rules = getCategoryRules()
  rules.push({ id: genId(), pattern: String(pattern).trim(), categoryId, createdAt: Date.now() })
  saveCategoryRules(rules)
}

function deleteCategoryRule(id) {
  saveCategoryRules(getCategoryRules().filter(r => r.id !== id))
}

// Rules derived from savings/investment accounts' paymentVendorPatterns:
// every pattern auto-categorizes matching bank transactions as "חסכונות והשקעות".
function _accountDerivedRules() {
  const rules = []
  getAccounts().forEach(a => {
    if (!['savings', 'investment'].includes(a.type)) return
    ;(a.paymentVendorPatterns || []).forEach(p => {
      if (p && String(p).trim()) rules.push({ patterns: [p], categoryId: 'cat_invest_out', source: 'account:' + a.id })
    })
  })
  return rules
}

function matchVendorToCategory(vendor, description) {
  const text = ((vendor || '') + ' ' + (description || '')).toLowerCase().trim()
  if (!text) return ''

  const userRules    = getCategoryRules().map(r => ({ patterns: [r.pattern], categoryId: r.categoryId }))
  const accountRules = _accountDerivedRules()
  const allRules     = [...userRules, ...accountRules, ...DEFAULT_CATEGORY_RULES]

  for (const rule of allRules) {
    const patterns = rule.patterns || (rule.pattern ? [rule.pattern] : [])
    for (const p of patterns) {
      const needle = String(p).toLowerCase().trim()
      if (!needle) continue
      if (text.includes(needle)) return rule.categoryId
    }
  }
  return ''
}

// ===== VENDOR ALIASES =====
// Unifies different raw vendor strings under a single user-facing display
// name. For example: "משיכת שיק 2500" + "שיק 2500 #4123" → "דמי שכירות".
// Applied at render time everywhere a vendor is shown; grouping logic
// (recurring detection, top vendors, etc.) also uses the resolved name so
// aliased transactions cluster together.
//
// Storage shape:
//   [{ id, patterns: ['p1','p2'], displayName,
//      amountMin?: number, amountMax?: number,
//      dayMin?:    number, dayMax?:    number, createdAt }]
// amountMin/amountMax: |amount| must fall in [amountMin, amountMax]. min===max
// means exact-amount match. Either bound may be omitted (open-ended range).
// dayMin/dayMax: day-of-month of the charge (chargeDate if present, else date)
// must fall in [dayMin, dayMax]. Same semantics — exact day, single-bound, or
// none. Day is 1..31. Lets users pin a recurring charge to its real billing
// window when vendor + amount alone aren't unique.
// Matching is case-insensitive substring. Aliases with an amount or day filter
// outrank ones without (more specific wins); within each tier, longer
// needle wins.

let _vendorAliasIdx = null
let _vendorAliasIdxTs = 0

function getVendorAliases() { return DB.get('finVendorAliases', []) }
function saveVendorAliases(list) {
  DB.set('finVendorAliases', list)
  _vendorAliasIdx = null
}
function invalidateVendorAliasCache() { _vendorAliasIdx = null }

function _aliasHasAmountFilter(a) {
  return typeof a.amountMin === 'number' || typeof a.amountMax === 'number'
}

function _aliasHasDayFilter(a) {
  return typeof a.dayMin === 'number' || typeof a.dayMax === 'number'
}

function _aliasAmountMatches(a, amount) {
  const hasMin = typeof a.amountMin === 'number'
  const hasMax = typeof a.amountMax === 'number'
  if (!hasMin && !hasMax) return true
  if (typeof amount !== 'number') return false
  const abs = Math.abs(amount)
  if (hasMin && abs < a.amountMin) return false
  if (hasMax && abs > a.amountMax) return false
  return true
}

function _aliasDayMatches(a, day) {
  const hasMin = typeof a.dayMin === 'number'
  const hasMax = typeof a.dayMax === 'number'
  if (!hasMin && !hasMax) return true
  if (typeof day !== 'number' || isNaN(day)) return false
  if (hasMin && day < a.dayMin) return false
  if (hasMax && day > a.dayMax) return false
  return true
}

// Day-of-month for an alias check. Prefers chargeDate (issuer-supplied billing
// day) over tx.date so CC bills with explicit charge dates align with the
// alias's day-range constraint, not the purchase day.
function getTxAliasDay(t) {
  if (!t) return null
  const s = t.chargeDate || t.date
  if (!s) return null
  const day = Number(String(s).split('-')[2])
  return isNaN(day) ? null : day
}

function _getVendorAliasIndex() {
  const now = Date.now()
  if (_vendorAliasIdx && now - _vendorAliasIdxTs < 500) return _vendorAliasIdx
  const aliases = getVendorAliases()
  const idx = []
  aliases.forEach(a => {
    const amountMin = typeof a.amountMin === 'number' ? a.amountMin : null
    const amountMax = typeof a.amountMax === 'number' ? a.amountMax : null
    const dayMin    = typeof a.dayMin    === 'number' ? a.dayMin    : null
    const dayMax    = typeof a.dayMax    === 'number' ? a.dayMax    : null
    ;(a.patterns || []).forEach(p => {
      const needle = String(p || '').trim().toLowerCase()
      if (needle) idx.push({ id: a.id, needle, displayName: a.displayName, amountMin, amountMax, dayMin, dayMax })
    })
  })
  // Aliases with any narrowing filter are more specific — try them first.
  // Within the "has-filter" tier, prefer entries with MORE filters set so
  // (vendor+amount+day) wins over (vendor+amount) for the same vendor needle.
  idx.sort((a, b) => {
    const aFilterCount = (a.amountMin !== null || a.amountMax !== null ? 1 : 0)
                       + (a.dayMin    !== null || a.dayMax    !== null ? 1 : 0)
    const bFilterCount = (b.amountMin !== null || b.amountMax !== null ? 1 : 0)
                       + (b.dayMin    !== null || b.dayMax    !== null ? 1 : 0)
    if (aFilterCount !== bFilterCount) return bFilterCount - aFilterCount
    return b.needle.length - a.needle.length
  })
  _vendorAliasIdx = idx
  _vendorAliasIdxTs = now
  return idx
}

// `amount` and `day` are optional. When an alias carries a filter on an axis
// the caller didn't pass, that alias is skipped — its condition can't be
// evaluated without the data, and matching anyway would be silently wrong.
function resolveVendor(rawVendor, amount, day) {
  if (!rawVendor) return rawVendor
  const lower = String(rawVendor).toLowerCase()
  for (const e of _getVendorAliasIndex()) {
    if (!lower.includes(e.needle)) continue
    if (e.amountMin !== null || e.amountMax !== null) {
      if (typeof amount !== 'number') continue
      const abs = Math.abs(amount)
      if (e.amountMin !== null && abs < e.amountMin) continue
      if (e.amountMax !== null && abs > e.amountMax) continue
    }
    if (e.dayMin !== null || e.dayMax !== null) {
      if (typeof day !== 'number' || isNaN(day)) continue
      if (e.dayMin !== null && day < e.dayMin) continue
      if (e.dayMax !== null && day > e.dayMax) continue
    }
    return e.displayName
  }
  return rawVendor
}

// Robust numeric parse: accepts strings with whitespace, thousands separators
// (comma), or stray non-numeric chars. Returns null on empty / unparseable so
// callers can distinguish "user left blank" from "user typed 0".
function _normalizeAliasAmount(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim().replace(/,/g, '').replace(/[^\d.\-]/g, '')
  if (s === '' || s === '.' || s === '-') return null
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

// Day must round to an integer in [1, 31]. Anything outside that → null.
function _normalizeAliasDay(v) {
  const n = _normalizeAliasAmount(v)
  if (n == null) return null
  const d = Math.round(n)
  if (d < 1 || d > 31) return null
  return d
}

function addVendorAlias(patterns, displayName, amountMin, amountMax, dayMin, dayMax) {
  const list = getVendorAliases()
  const patternsArr = (Array.isArray(patterns) ? patterns : [patterns])
    .map(p => String(p || '').trim()).filter(Boolean)
  if (patternsArr.length === 0 || !displayName) return null
  const entry = {
    id: genId(),
    patterns: patternsArr,
    displayName: String(displayName).trim(),
    amountMin: _normalizeAliasAmount(amountMin),
    amountMax: _normalizeAliasAmount(amountMax),
    dayMin:    _normalizeAliasDay(dayMin),
    dayMax:    _normalizeAliasDay(dayMax),
    createdAt: Date.now(),
  }
  list.push(entry)
  saveVendorAliases(list)
  return entry
}

function updateVendorAlias(id, patterns, displayName, amountMin, amountMax, dayMin, dayMax) {
  const list = getVendorAliases()
  const idx = list.findIndex(a => a.id === id)
  if (idx < 0) return
  list[idx].patterns = (Array.isArray(patterns) ? patterns : [patterns])
    .map(p => String(p || '').trim()).filter(Boolean)
  list[idx].displayName = String(displayName || '').trim()
  list[idx].amountMin = _normalizeAliasAmount(amountMin)
  list[idx].amountMax = _normalizeAliasAmount(amountMax)
  list[idx].dayMin    = _normalizeAliasDay(dayMin)
  list[idx].dayMax    = _normalizeAliasDay(dayMax)
  saveVendorAliases(list)
}

function deleteVendorAlias(id) {
  saveVendorAliases(getVendorAliases().filter(a => a.id !== id))
}

// "100-200" → {min:100,max:200}; "5000" → {min:5000,max:5000};
// "100-" → {min:100,max:null}; "-200" → {min:null,max:200}; "" → both null.
// Tolerant parser: strips commas/whitespace before parseFloat so "1,193" is
// 1193, not parseFloat("1,193") which would silently truncate to 1.
function parseAliasAmountRange(str) {
  const s = String(str || '').trim()
  if (!s) return { amountMin: null, amountMax: null }
  // Leading '-' with no further dash = open-ended max ("-200" → up to 200).
  // Amounts are matched by absolute value, so a negative bound is meaningless.
  if (s[0] === '-' && s.indexOf('-', 1) < 0) {
    const b = _normalizeAliasAmount(s.slice(1))
    return { amountMin: null, amountMax: b }
  }
  if (s.includes('-')) {
    // Don't split on a leading minus (negative bound) — we only want range
    // separators. Find the first '-' that ISN'T at position 0.
    const i = s.indexOf('-', 1)
    if (i > 0) {
      const a = _normalizeAliasAmount(s.slice(0, i))
      const b = _normalizeAliasAmount(s.slice(i + 1))
      if (a !== null && b !== null && a > b) return { amountMin: b, amountMax: a }
      return { amountMin: a, amountMax: b }
    }
  }
  const v = _normalizeAliasAmount(s)
  return v === null ? { amountMin: null, amountMax: null } : { amountMin: v, amountMax: v }
}

function formatAliasAmountRange(amountMin, amountMax) {
  const hasMin = typeof amountMin === 'number'
  const hasMax = typeof amountMax === 'number'
  if (!hasMin && !hasMax) return ''
  if (hasMin && hasMax && amountMin === amountMax) return String(amountMin)
  if (hasMin && hasMax) return `${amountMin}-${amountMax}`
  if (hasMin) return `${amountMin}-`
  return `-${amountMax}`
}

// Same shape as parseAliasAmountRange, but constrained to [1,31] integer days.
function parseAliasDayRange(str) {
  const { amountMin, amountMax } = parseAliasAmountRange(str)
  return { dayMin: _normalizeAliasDay(amountMin), dayMax: _normalizeAliasDay(amountMax) }
}

function formatAliasDayRange(dayMin, dayMax) {
  const hasMin = typeof dayMin === 'number'
  const hasMax = typeof dayMax === 'number'
  if (!hasMin && !hasMax) return ''
  if (hasMin && hasMax && dayMin === dayMax) return String(dayMin)
  if (hasMin && hasMax) return `${dayMin}-${dayMax}`
  if (hasMin) return `${dayMin}-`
  return `-${dayMax}`
}
