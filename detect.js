// ===== TRANSACTION DETECTION HELPERS =====
// Stateless pattern matchers used during import (and via migration on existing
// rows) to surface CC-bill metadata the issuer hides inside the "פירוט" column:
// installment plans, standing orders, and bit/paybox payee names.
//
// All detectors operate on the raw `vendor` + `description` fields and return
// either a structured result or null. enrichDetectedFields wires them together
// and produces the side-effects we persist on the tx (extra flag fields and a
// rewritten vendor for bit/paybox).

// "תשלום X מתוך Y" / "X מתוך Y" / "X/Y" – Y up to 99.
// Returns { current, total } or null. Validates current <= total.
function detectInstallmentInfo(text) {
  if (!text) return null
  const s = String(text)
  // Order matters – the "תשלום" prefix variant is the most specific and
  // catches the canonical CC-bill phrasing. The bare "X מתוך Y" variant
  // covers exports that drop the prefix word.
  const patterns = [
    /תשלום\s*(\d{1,2})\s*(?:מתוך|מ-|\/|of)\s*(\d{1,2})/i,
    /(\d{1,2})\s*מתוך\s*(\d{1,2})/,
    /\bתשלום\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/,
    /\b(\d{1,2})\s*\/\s*(\d{1,2})\s*תשלום/,
  ]
  for (const re of patterns) {
    const m = s.match(re)
    if (!m) continue
    const cur = parseInt(m[1], 10), tot = parseInt(m[2], 10)
    if (!cur || !tot || cur > tot || tot < 2 || tot > 99) continue
    return { current: cur, total: tot }
  }
  return null
}

// "הוראת קבע" or the common short form "הו״ק". Used for tagging notes
// and offering an explicit filter on the transactions screen.
function detectStandingOrder(text) {
  if (!text) return false
  const s = String(text)
  if (/הוראת\s*קבע/.test(s)) return true
  // The "הו״ק" abbreviation — JS \b doesn't anchor on Hebrew letters, so
  // require a non-Hebrew-letter or end-of-string right after the ק.
  if (/הו["׳'`]ק(?=[^א-ת]|$)/.test(s)) return true
  return false
}

// Bit/Paybox lines on a CC bill carry the payee inside "פירוט". We rewrite
// the raw "BIT" / "פייבוקס" vendor into "ביט <payee>" so the user can
// categorise once per payee (autocat then propagates by normalised vendor).
// JS \b only treats ASCII letters as word chars, so /\bביט\b/ would either
// match nothing or match inside "ביטוח". For the Hebrew patterns we instead
// require the token to be flanked by non-Hebrew-letter chars (start of string
// / space / punctuation), which excludes "ביטוח" while keeping "ביט נסים".
const _BIT_PATTERNS = [/(^|\W)bit(\W|$)/i, /(?:^|[^א-ת])ביט(?=[^א-ת]|$)/]
const _PAYBOX_PATTERNS = [/paybox/i, /(?:^|[^א-ת])פייבוקס(?=[^א-ת]|$)/, /(?:^|[^א-ת])פיי\s*בוקס(?=[^א-ת]|$)/]

function _stripDiacritics(s) { return s.replace(/[֑-ֽֿׁ-ׂׄ-ׇ]/g, '') }

function detectBitPayboxRecipient(vendor, description) {
  const v = String(vendor || '')
  const d = String(description || '')
  const all = `${v} ${d}`
  let provider = null
  if (_PAYBOX_PATTERNS.some(p => p.test(all))) provider = 'פייבוקס'
  else if (_BIT_PATTERNS.some(p => p.test(all))) provider = 'ביט'
  if (!provider) return null
  // Strip the provider word + connective stop-words from description; what
  // remains is the payee name. Description is preferred over vendor because
  // the vendor cell on a bit/paybox CC line is almost always just "BIT" /
  // "PAYBOX". Installment markers ("תשלום X מתוך Y") and CC-bill
  // boilerplate are stripped too so they don't leak into the recipient.
  let raw = _stripDiacritics(d || v)
  raw = raw
    .replace(/תשלום\s*\d+\s*(?:מתוך|מ-|\/|of)\s*\d+/gi, ' ')
    .replace(/\d+\s*מתוך\s*\d+/g, ' ')
    .replace(/\b(bit|paybox)\b/gi, ' ')
    .replace(/(פייבוקס|פיי\s*בוקס|ביט)/g, ' ')
    .replace(/(העבר[התי]?|תשלום|זיכוי|חיוב|מקבל|למקבל|מאת|אל|לטובת|מתוך|הוראת\s*קבע)/g, ' ')
    // Drop standalone single-letter Hebrew prepositions ("ל דנה" → "דנה").
    // Only when space-flanked, so prefixes glued to a name ("לאה") survive.
    .replace(/(?:^|\s)[למבה](?=\s)/g, ' ')
    .replace(/[^א-תA-Za-z\s'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Drop very short or numeric-only leftovers — they're not a real name.
  if (!raw || raw.length < 2) return null
  // Capitalize-ish: keep Hebrew as-is; latin words → title case.
  raw = raw.split(' ').map(w => /[a-z]/i.test(w) ? (w[0].toUpperCase() + w.slice(1).toLowerCase()) : w).join(' ')
  return { provider, recipient: raw }
}

// Mutates a copy of `t` with whatever the detectors find. Idempotent — if the
// vendor was already rewritten on a previous pass (because the input was a
// stored, previously-enriched row), re-running keeps the same result.
function enrichDetectedFields(t) {
  const out = { ...t }
  const desc = String(t.description || '')
  const vendor = String(t.vendor || '')

  const inst = detectInstallmentInfo(desc) || detectInstallmentInfo(vendor)
  if (inst) {
    out.installmentCurrent = inst.current
    out.installmentTotal = inst.total
  }

  if (detectStandingOrder(desc) || detectStandingOrder(vendor)) {
    out.standingOrder = true
  }

  const bp = detectBitPayboxRecipient(vendor, desc)
  if (bp && bp.recipient) {
    const rewritten = `${bp.provider} ${bp.recipient}`
    if (out.vendor !== rewritten) out.vendor = rewritten
    out.detectedProvider = bp.provider
    out.detectedRecipient = bp.recipient
  } else if (t._detectText) {
    // The recipient sits in a column the import template doesn't map. Surface
    // it as a NOTE only — deliberately NOT rewriting the vendor — so the dedup
    // hash (date|amount|vendor|description) is unchanged and re-imports of the
    // same file are still recognised as duplicates.
    const bp2 = detectBitPayboxRecipient(vendor, String(t._detectText))
    if (bp2 && bp2.recipient) {
      out.detectedProvider = bp2.provider
      out.detectedRecipient = bp2.recipient
    }
  }

  return out
}

// Compute the YYYY-MM of the LAST installment charge.
// Israeli CC convention: first installment is the bill cycle AFTER the
// purchase month, so `finalMonth = purchaseMonth + total`. This formula is
// stable regardless of which specific installment line we're looking at —
// every installment of the same plan should produce the same final month.
// Falls back gracefully when the second arg is omitted: the legacy 3-arg
// signature (effectiveMonth, current, total) treated `effectiveMonth` as
// the current bill cycle and added `total - current`; we replicate that
// behaviour so older migrations don't change behaviour mid-flight.
function computeInstallmentFinalMonth(purchaseDateOrEffectiveMonth, totalOrCurrent, totalLegacy) {
  if (!purchaseDateOrEffectiveMonth) return ''
  const m = String(purchaseDateOrEffectiveMonth).match(/^(\d{4})-(\d{2})/)
  if (!m) return ''
  let y = parseInt(m[1], 10), mo = parseInt(m[2], 10)
  let monthsAhead
  if (totalLegacy == null) {
    // New 2-arg form: (purchaseDate, total). Final = purchase + total.
    const total = totalOrCurrent
    if (!total || total < 1) return ''
    monthsAhead = total
  } else {
    // Legacy 3-arg form kept for migration code paths that already shipped.
    const current = totalOrCurrent, total = totalLegacy
    if (!current || !total || total < current) return ''
    monthsAhead = total - current
  }
  mo += monthsAhead
  while (mo > 12) { mo -= 12; y += 1 }
  return `${y}-${String(mo).padStart(2, '0')}`
}

// Some CC bills print the installment's ORIGINAL purchase date instead of
// the per-cycle charge date — e.g., installment 7/12 of a Nov 2025 purchase
// shows up on the June 2026 bill with date=30/11/2025. We map that into the
// bill's actual cycle so the tx sorts/displays correctly:
//   - keep the day-of-month from the original purchase (30)
//   - pick the calendar month so the day, after CC rollover, lands in the
//     bill cycle:
//       day  < billingDay → use billingMonth   (no rollover)
//       day >= billingDay → use billingMonth-1 (rollover bumps it forward)
// Day 31 clamps to the target month's last day (e.g., 30 in April).
function remapInstallmentDateToBillCycle(origIsoDate, billingMonth, billingDay) {
  if (!origIsoDate || !billingMonth) return ''
  const m1 = String(origIsoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const m2 = String(billingMonth).match(/^(\d{4})-(\d{2})$/)
  if (!m1 || !m2) return ''
  const origDay = parseInt(m1[3], 10)
  const bDay = billingDay || 10
  let ty = parseInt(m2[1], 10)
  let tm = parseInt(m2[2], 10)
  if (origDay >= bDay) {
    tm -= 1
    if (tm === 0) { tm = 12; ty -= 1 }
  }
  const daysInMonth = new Date(ty, tm, 0).getDate()
  const day = Math.min(origDay, daysInMonth)
  return `${ty}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Bill cycle of installment N (Israeli convention "first = purchase + 1"):
// purchaseMonth + N. Returns 'YYYY-MM' (no day component).
function installmentBillCycleMonth(purchaseDate, installmentCurrent) {
  if (!purchaseDate || !installmentCurrent) return ''
  const m = String(purchaseDate).match(/^(\d{4})-(\d{2})/)
  if (!m) return ''
  let y = parseInt(m[1], 10), mo = parseInt(m[2], 10) + installmentCurrent
  while (mo > 12) { mo -= 12; y += 1 }
  return `${y}-${String(mo).padStart(2, '0')}`
}

// Notes rebuilder — splits the current notes by " · ", strips any of OUR
// auto-clauses and re-emits them from the current field values, while
// preserving anything the user wrote themselves. Idempotent.
function rebuildAutoNotes(existingNotes, fields) {
  const segments = String(existingNotes || '').split(/\s*·\s*/).map(s => s.trim()).filter(Boolean)
  const isAuto = s =>
    /^תשלום\s+\d+\s+מתוך\s+\d+$/.test(s) ||
    /^חודש\s+חיוב\s+אחרון:/.test(s) ||
    /^תאריך\s+עסקה\s+מקורי:/.test(s) ||
    /^נמען:\s/.test(s) ||
    s === 'הוראת קבע'
  const userParts = segments.filter(s => !isAuto(s))
  const autoParts = []
  if (fields.installmentCurrent && fields.installmentTotal) {
    autoParts.push(`תשלום ${fields.installmentCurrent} מתוך ${fields.installmentTotal}`)
    if (fields.installmentFinalMonth) {
      const m = String(fields.installmentFinalMonth).match(/^(\d{4})-(\d{2})$/)
      if (m) autoParts.push(`חודש חיוב אחרון: ${m[2]}/${m[1]}`)
    }
  }
  if (fields.originalDate) {
    const m = String(fields.originalDate).match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (m) autoParts.push(`תאריך עסקה מקורי: ${m[3]}/${m[2]}/${m[1]}`)
  }
  if (fields.standingOrder) autoParts.push('הוראת קבע')
  // Bit/Paybox payee — surfaced as a note so the user can later turn it into
  // a proper vendor/alias ("הפיכה לספק").
  if (fields.detectedRecipient) autoParts.push(`נמען: ${fields.detectedRecipient}`)
  return [...autoParts, ...userParts].join(' · ')
}

// Convenience wrapper for the new-import code path — same shape as the
// previous buildAutoNotes(fields) helper, just routed through the rebuilder.
function buildAutoNotes(t) {
  return rebuildAutoNotes('', t)
}
