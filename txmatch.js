// ===== TRANSACTION IDENTITY & MATCHING =====
// The identity of a transaction is DERIVED, never stored. Every stored hash in
// this app has historically gone stale the moment something touched the row —
// a user edit, a migration that rewrote `date`, an alias that rewrote `vendor`.
// So nothing here reads a persisted hash: match records are rebuilt from the
// current field values on both sides of every comparison.
//
// The matcher exists because the same real transaction reaches us in several
// shapes. One credit card produces reports from the bank's site (in two
// layouts) and from the issuer's site, and those disagree on vendor spelling,
// on whether the "פירוט" column exists, on whether the installment index is
// printed, and on whether the date column holds the purchase date or the
// charge date. Text is therefore a hint, never a key.
//
// What survives every format for one real transaction:
//   * the amount, to the agora
//   * the purchase date, WHEN the source prints it
//   * the billing cycle it lands on, within about a month
// Amount is the hard gate; everything else contributes a score. A pair that
// clears the score floor but doesn't beat its runner-up by a clear margin is
// reported as ambiguous rather than guessed — see reconcileTransactions.

const TXM_MIN_SCORE    = 2   // floor a pair must clear to be called a match
const TXM_MARGIN       = 2   // best must beat runner-up by this to be unambiguous
const TXM_DAY_WINDOW   = 3   // purchase dates this far apart still corroborate
const TXM_MONTH_WINDOW = 1   // billing cycles this far apart are still candidates

// ---------- normalization ----------

// Money compares as integer agorot. Float equality on 120.5 vs 120.50 happens
// to work, but 0.1+0.2 arithmetic anywhere upstream would break it silently.
function txmAgorot(amount) {
  const n = typeof amount === 'number' ? amount : parseFloat(amount)
  if (!isFinite(n)) return null
  return Math.round(n * 100)
}

const _TXM_FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' }
// Corporate/formatting noise that one export prints and another doesn't.
const _TXM_STOPWORDS = new Set(['בעמ', 'בע', 'מ', 'ltd', 'inc', 'llc', 'the', 'co'])

// Aggressive vendor normalization for MATCHING only (never for display).
// Strips diacritics, unifies Hebrew final letters, drops digits, punctuation
// and corporate suffixes. Punctuation becomes a space, so `בע"מ` and `בעמ` both
// reduce to stopword tokens and drop out — the two spellings converge.
function txmVendorTokens(vendor) {
  if (!vendor) return new Set()
  const s = String(vendor)
    .replace(/[֑-ֽֿׁ-ׂׄ-ׇ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[ךםןףץ]/g, c => _TXM_FINALS[c] || c)
  const out = new Set()
  for (const w of s.split(/\s+/)) {
    if (w && w.length > 1 && !_TXM_STOPWORDS.has(w)) out.add(w)
  }
  return out
}

// Canonical form built from the token SET, sorted — so the key is stable
// against word order and against noise words one export prints and another
// doesn't. Used for the strongest vendor signal (exact key equality).
function txmVendorKey(vendor) {
  return [...txmVendorTokens(vendor)].sort().join(' ')
}

// Containment, not Jaccard: "שופרסל" fully inside "שופרסל דיל רמת גן" should
// score as a strong signal, and Jaccard would punish it for being shorter.
function txmTokenOverlap(a, b) {
  if (!a.size || !b.size) return 0
  let hits = 0
  for (const t of a) if (b.has(t)) hits++
  return hits / Math.min(a.size, b.size)
}

function txmDayDiff(isoA, isoB) {
  if (!isoA || !isoB) return null
  const a = Date.parse(isoA + 'T00:00:00Z'), b = Date.parse(isoB + 'T00:00:00Z')
  if (isNaN(a) || isNaN(b)) return null
  return Math.round(Math.abs(a - b) / 86400000)
}

function txmMonthDiff(a, b) {
  const ma = String(a || '').match(/^(\d{4})-(\d{2})$/)
  const mb = String(b || '').match(/^(\d{4})-(\d{2})$/)
  if (!ma || !mb) return null
  return Math.abs((+ma[1] * 12 + +ma[2]) - (+mb[1] * 12 + +mb[2]))
}

function txmAddMonths(month, delta) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/)
  if (!m) return ''
  let total = (+m[1]) * 12 + (+m[2]) - 1 + delta
  const y = Math.floor(total / 12), mo = total % 12 + 1
  return `${y}-${String(mo).padStart(2, '0')}`
}

function _txmHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

// Fingerprint of a RAW source row (the cells as they came out of the file,
// before any interpretation). Two exports of the same statement from the same
// system produce byte-identical rows, so this catches re-imports outright with
// no scoring at all. Whitespace is collapsed because CSV and XLSX round-trips
// differ on padding.
function txmRowSignature(cells) {
  if (!Array.isArray(cells)) return ''
  const parts = cells.map(c => String(c ?? '').replace(/\s+/g, ' ').trim())
  return parts.some(Boolean) ? _txmHash(parts.join('\u001f')) : ''
}

// ---------- match records ----------

// Both sides of a comparison are reduced to this shape. `purchaseDate` is the
// date the purchase actually happened; it is null when the source only printed
// a charge date, and a null field never penalizes a pair — only two PRESENT
// and CONFLICTING values do.
function txmRecord(tx, opts = {}) {
  const purchaseDate = opts.purchaseDate !== undefined
    ? opts.purchaseDate
    : (tx.originalTransactionDate || tx.date || null)
  const billingMonth = opts.billingMonth !== undefined
    ? opts.billingMonth
    : (tx.billingMonth || null)
  const vendorTokens = txmVendorTokens(tx.vendor)
  const vendorKey = [...vendorTokens].sort().join(' ')
  return {
    ref:          opts.ref !== undefined ? opts.ref : tx,
    id:           tx.id || null,
    accountId:    tx.accountId || opts.accountId || null,
    agorot:       txmAgorot(tx.amount),
    purchaseDate: /^\d{4}-\d{2}-\d{2}$/.test(String(purchaseDate)) ? purchaseDate : null,
    billingMonth: /^\d{4}-\d{2}$/.test(String(billingMonth)) ? billingMonth : null,
    vendorKey,
    vendorTokens,
    instCur:      tx.installmentCurrent ? Number(tx.installmentCurrent) : null,
    instTot:      tx.installmentTotal   ? Number(tx.installmentTotal)   : null,
    rowSig:       tx.srcRowHash || opts.rowSig || null,
  }
}

// ---------- scoring ----------

// Returns { score, disqualified, reasons }. The caller has already guaranteed
// the amounts are equal — that is a precondition, not a scored component.
function txmScorePair(a, b) {
  const reasons = []
  let score = 0

  // Installments: two DIFFERENT printed indices of the same plan are provably
  // different charges. This is the one signal strong enough to veto a pair.
  if (a.instCur && b.instCur) {
    if (a.instCur !== b.instCur || (a.instTot && b.instTot && a.instTot !== b.instTot)) {
      return { score: -Infinity, disqualified: true, reasons: ['installment-conflict'] }
    }
    score += 3; reasons.push('installment')
  }

  if (a.purchaseDate && b.purchaseDate) {
    const d = txmDayDiff(a.purchaseDate, b.purchaseDate)
    if (d === 0)                   { score += 3; reasons.push('date-exact') }
    else if (d <= TXM_DAY_WINDOW)  { score += 1; reasons.push('date-near') }
    // A large gap usually means the two sources disagree on what the date
    // column MEANS (purchase vs charge), so it counts against the pair but
    // doesn't veto it — the billing cycle can still carry the match.
    else                           { score -= 2; reasons.push('date-conflict') }
  }

  if (a.vendorKey && b.vendorKey) {
    if (a.vendorKey === b.vendorKey) { score += 2; reasons.push('vendor-exact') }
    else {
      const ov = txmTokenOverlap(a.vendorTokens, b.vendorTokens)
      if (ov >= 0.5)      { score += 1; reasons.push('vendor-partial') }
      else if (ov === 0)  { score -= 1; reasons.push('vendor-mismatch') }
    }
  }

  if (a.billingMonth && b.billingMonth) {
    const m = txmMonthDiff(a.billingMonth, b.billingMonth)
    if (m === 0)      { score += 2; reasons.push('cycle-exact') }
    else if (m === 1) { score += 1; reasons.push('cycle-near') }
    else              { score -= 2; reasons.push('cycle-conflict') }
  }

  return { score, disqualified: false, reasons }
}

// A pair is only worth scoring if it could plausibly be the same charge.
function txmInWindow(a, b) {
  const m = txmMonthDiff(a.billingMonth, b.billingMonth)
  if (m !== null && m <= TXM_MONTH_WINDOW) return true
  const d = txmDayDiff(a.purchaseDate, b.purchaseDate)
  if (d !== null && d <= TXM_DAY_WINDOW) return true
  // One side carries neither signal — let scoring decide rather than dropping
  // a pair we simply know nothing about.
  return m === null && d === null
}

// ---------- explaining a miss ----------

// Why was this row not matched? Matching is a scored decision, so "it looked
// new" is never a satisfying answer on its own — this reports the comparison
// that actually happened, against the stored rows that came closest.
//
// Amount is a hard gate, which makes it the most common silent cause: a sign
// convention or a currency difference removes a row from consideration before
// any scoring runs, and nothing on screen would hint at it. So near-miss
// amounts are reported too, precisely because the gate hid them.
function txmExplain(row, existing, opts = {}) {
  const limit = opts.limit || 5
  const sameAmount = []
  const nearAmount = []
  for (const e of existing) {
    if (e.agorot === row.agorot) { sameAmount.push(e); continue }
    if (e.agorot === -row.agorot) { nearAmount.push({ existing: e, why: 'sign' }); continue }
    const diff = Math.abs(e.agorot - row.agorot)
    if (diff > 0 && diff <= Math.max(100, Math.abs(row.agorot) * 0.03)) {
      nearAmount.push({ existing: e, why: 'close', diff })
    }
  }

  const candidates = sameAmount.map(e => {
    const s = txmScorePair(row, e)
    return {
      existing: e,
      inWindow: txmInWindow(row, e),
      monthDiff: txmMonthDiff(row.billingMonth, e.billingMonth),
      dayDiff: txmDayDiff(row.purchaseDate, e.purchaseDate),
      score: s.score,
      disqualified: s.disqualified,
      reasons: s.reasons,
    }
  }).sort((a, b) => b.score - a.score)

  // Reconciliation is deliberately scoped to one account — a charge really can
  // appear in two accounts (a card detail line and its lump payment) and merging
  // those would be wrong. But that scoping is invisible in the UI, so "it IS in
  // the system" and "it is not in this account" look identical. The explainer
  // therefore looks wider than the matcher does, and says so.
  const crossAccount = (opts.otherAccounts || [])
    .filter(e => e.agorot === row.agorot)
    .map(e => ({ existing: e, monthDiff: txmMonthDiff(row.billingMonth, e.billingMonth), score: txmScorePair(row, e).score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  // Last resort: when no amount matches anywhere, show what IS stored in the
  // same cycle. An empty answer is the one outcome that teaches nothing, and it
  // is exactly the outcome that means the amount itself is the problem.
  let neighbours = []
  if (!sameAmount.length && !nearAmount.length) {
    const rank = list => list
      .map(e => ({ existing: e, overlap: txmTokenOverlap(row.vendorTokens, e.vendorTokens), delta: e.agorot - row.agorot }))
      .sort((a, b) => b.overlap - a.overlap || Math.abs(a.delta) - Math.abs(b.delta))
      .slice(0, limit)
    const inCycle = existing.filter(e => {
      const md = txmMonthDiff(row.billingMonth, e.billingMonth)
      const dd = txmDayDiff(row.purchaseDate, e.purchaseDate)
      return (md !== null && md <= TXM_MONTH_WINDOW) || (dd !== null && dd <= 7)
    })
    // Falling back to the whole account matters for rows carrying a cycle from
    // an older, buggier import: those sit outside every window, so a
    // cycle-limited fallback would come back empty for exactly the rows most
    // in need of an explanation.
    neighbours = inCycle.length ? rank(inCycle) : rank(existing.filter(e => txmTokenOverlap(row.vendorTokens, e.vendorTokens) > 0))
  }

  const scorable = candidates.filter(c => c.inWindow && !c.disqualified)
  let verdict
  if (crossAccount.length && !sameAmount.length) verdict = 'other-account'
  else if (!existing.length)                     verdict = 'empty-account'
  else if (!sameAmount.length)                   verdict = nearAmount.length ? 'amount-near-miss' : 'no-amount-match'
  else if (!scorable.length)                     verdict = candidates.some(c => c.disqualified) ? 'disqualified' : 'out-of-window'
  else if (scorable[0].score < TXM_MIN_SCORE)    verdict = 'below-threshold'
  else                                           verdict = 'ambiguous'

  return {
    verdict,
    amountMatches: sameAmount.length,
    candidates: candidates.slice(0, limit),
    nearAmount: nearAmount.slice(0, limit),
    crossAccount,
    neighbours,
  }
}

const TXM_VERDICT_LABEL = {
  'other-account':    'העסקה קיימת במערכת — אבל בחשבון אחר. ייבוא משווה מול חשבון אחד בלבד',
  'empty-account':    'אין עסקאות בחשבון הזה להשוות מולן',
  'no-amount-match':  'אין במערכת אף עסקה בסכום הזה בחשבון הזה',
  'amount-near-miss': 'אין התאמת סכום מדויקת, אבל יש סכומים קרובים — בדוק סימן או מטבע',
  'out-of-window':    'יש סכום זהה, אבל התאריך וחודש החיוב רחוקים מדי',
  'disqualified':     'יש סכום זהה, אבל מדד התשלומים סותר (למשל 3/10 מול 4/10)',
  'below-threshold':  'יש מועמד, אבל אין מספיק סימנים תומכים כדי לקבוע שזו אותה עסקה',
  'ambiguous':        'יש כמה מועמדים שקולים — לא ניתן להכריע ביניהם',
}

// ---------- reconciliation ----------

// Compares an incoming statement against what's already stored and returns a
// full account of every row on BOTH sides. The `orphans` bucket — rows in the
// store, inside the cycles this file covers, that the file does not contain —
// is the safety net: when matching fails, the row it should have matched shows
// up there instead of vanishing, so a miss is visible instead of silent.
//
//   incoming  — match records built from the file
//   existing  — match records built from the store (same account)
//   scopeMonths — cycles this file claims to cover; orphans are limited to them
function reconcileTransactions(incoming, existing, opts = {}) {
  const scopeMonths = new Set(opts.scopeMonths || [])
  const taken = new Set()          // indices of consumed existing records
  const result = { matched: [], fresh: [], review: [], orphans: [] }

  // Index existing by amount — the hard gate, so this is exact and cheap.
  const byAmount = new Map()
  existing.forEach((rec, i) => {
    if (rec.agorot === null) return
    if (!byAmount.has(rec.agorot)) byAmount.set(rec.agorot, [])
    byAmount.get(rec.agorot).push(i)
  })

  // Pass 1 — identical raw source rows. Same statement re-exported from the
  // same system: no interpretation involved, so no scoring either.
  const pending = []
  incoming.forEach((rec, ri) => {
    if (rec.rowSig) {
      const hit = (byAmount.get(rec.agorot) || [])
        .find(i => !taken.has(i) && existing[i].rowSig === rec.rowSig)
      if (hit !== undefined) {
        taken.add(hit)
        result.matched.push({ row: rec, existing: existing[hit], score: Infinity, reasons: ['row-signature'] })
        return
      }
    }
    pending.push(ri)
  })

  // Pass 2 — score every plausible pair, then assign. Rows whose best candidate
  // is strongest go first, so a confident match claims its slot before a weaker
  // row can take it.
  const scored = pending.map(ri => {
    const rec = incoming[ri]
    const cands = []
    if (rec.agorot !== null) {
      for (const ei of (byAmount.get(rec.agorot) || [])) {
        if (!txmInWindow(rec, existing[ei])) continue
        const s = txmScorePair(rec, existing[ei])
        if (s.disqualified) continue
        cands.push({ ei, score: s.score, reasons: s.reasons })
      }
    }
    cands.sort((a, b) => b.score - a.score)
    return { ri, rec, cands, best: cands.length ? cands[0].score : -Infinity }
  })
  scored.sort((a, b) => b.best - a.best)

  for (const entry of scored) {
    const open = entry.cands.filter(c => !taken.has(c.ei))
    if (!open.length) { result.fresh.push(entry.rec); continue }
    const best = open[0]
    const runnerUp = open.length > 1 ? open[1].score : -Infinity
    const clear = open.length === 1 || (best.score - runnerUp) >= TXM_MARGIN
    if (best.score >= TXM_MIN_SCORE && clear) {
      taken.add(best.ei)
      result.matched.push({ row: entry.rec, existing: existing[best.ei], score: best.score, reasons: best.reasons })
    } else if (best.score >= TXM_MIN_SCORE) {
      // Clears the floor but can't be told apart from its runner-up. Guessing
      // here is how installment 3/10 got merged into 4/10 in the old code.
      result.review.push({
        row: entry.rec,
        candidates: open.slice(0, 4).map(c => ({ existing: existing[c.ei], score: c.score, reasons: c.reasons })),
      })
    } else {
      result.fresh.push(entry.rec)
    }
  }

  // Anything in the store, inside the cycles this file covers, that the file
  // didn't account for.
  existing.forEach((rec, i) => {
    if (taken.has(i)) return
    if (scopeMonths.size && !scopeMonths.has(rec.billingMonth)) return
    result.orphans.push(rec)
  })

  return result
}
