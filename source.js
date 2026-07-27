// ===== SOURCE DOCUMENTS =====
// Until now the app stored derived transactions and threw the source away.
// That is why "have I already imported this line?" was unanswerable: every
// re-parse produced a slightly different derivation and there was nothing
// stable to compare against. This module keeps the source.
//
// Split by cost:
//   * localStorage `finSourceDocs` — one small record per imported file
//     (content hash, detected account, detected cycle, row signatures).
//     Small enough to live in the Drive backup, and sufficient for dedup.
//   * IndexedDB `finSourceRows`    — the raw rows, for audit and re-parsing.
//     Local only, pruned by age. Losing it degrades nothing but forensics.
//
// The payoff is that re-uploading a file you already imported is answered
// outright, before a single row is interpreted.

const SRC_DOCS_KEY = 'finSourceDocs'
const SRC_MAX_DOCS = 400          // ~1 file/day for a year across all accounts
const SRC_IDB_NAME = 'finSourceRows'

function getSourceDocs()      { return DB.get(SRC_DOCS_KEY, []) }
function saveSourceDocs(list) { DB.set(SRC_DOCS_KEY, list) }

// ---------- file identity ----------

// SHA-256 of the file bytes when the platform offers it, else a cheap rolling
// hash. Either way the same bytes always produce the same id, which is all the
// "already imported this file" check needs.
async function fileContentHash(file) {
  const buf = await file.arrayBuffer()
  try {
    if (globalThis.crypto?.subtle) {
      const d = await crypto.subtle.digest('SHA-256', buf)
      return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {}
  const bytes = new Uint8Array(buf)
  let h = 0
  for (let i = 0; i < bytes.length; i++) h = (Math.imul(31, h) + bytes[i]) | 0
  return 'r' + Math.abs(h).toString(36) + '-' + bytes.length.toString(36)
}

function findSourceDocByHash(contentHash) {
  if (!contentHash) return null
  return getSourceDocs().find(d => d.contentHash === contentHash) || null
}

function recordSourceDoc(doc) {
  const docs = getSourceDocs()
  const existing = docs.findIndex(d => d.contentHash === doc.contentHash)
  const rec = { id: doc.id || genId(), importedAt: Date.now(), ...doc }
  if (existing >= 0) docs[existing] = { ...docs[existing], ...rec, id: docs[existing].id }
  else docs.push(rec)
  // Keep the log bounded; oldest first.
  docs.sort((a, b) => (a.importedAt || 0) - (b.importedAt || 0))
  while (docs.length > SRC_MAX_DOCS) docs.shift()
  saveSourceDocs(docs)
  return rec
}

// ---------- raw rows (IndexedDB, best effort) ----------

function _srcOpenDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const req = indexedDB.open(SRC_IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('rows')) req.result.createObjectStore('rows', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Never let a storage failure block an import — the row signatures in
// localStorage carry the dedup work on their own.
async function putSourceRows(docId, rows) {
  try {
    const db = await _srcOpenDb()
    await new Promise((res, rej) => {
      const tx = db.transaction('rows', 'readwrite')
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
      tx.objectStore('rows').put({ id: docId, rows })
    })
    return true
  } catch (err) {
    console.warn('source rows not persisted:', err?.message)
    return false
  }
}

async function getSourceRows(docId) {
  try {
    const db = await _srcOpenDb()
    return await new Promise((res, rej) => {
      const req = db.transaction('rows').objectStore('rows').get(docId)
      req.onsuccess = () => res(req.result?.rows || null)
      req.onerror = () => rej(req.error)
    })
  } catch { return null }
}

// Drop stored rows for documents no longer in the log.
async function pruneSourceRows() {
  try {
    const live = new Set(getSourceDocs().map(d => d.id))
    const db = await _srcOpenDb()
    const keys = await new Promise((res, rej) => {
      const req = db.transaction('rows').objectStore('rows').getAllKeys()
      req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error)
    })
    const dead = keys.filter(k => !live.has(k))
    if (!dead.length) return 0
    await new Promise((res, rej) => {
      const tx = db.transaction('rows', 'readwrite')
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
      dead.forEach(k => tx.objectStore('rows').delete(k))
    })
    return dead.length
  } catch { return 0 }
}

// ---------- statement scope ----------
// A credit-card statement states which bill it is, in its own preamble. Reading
// it is far better than the old approach of guessing the cycle from the latest
// transaction date, which produced a different answer for the same rows
// depending on what else happened to be in the file.

const _SRC_HEB_MONTHS = {
  'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'מרס': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6,
  'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12,
}

function _srcMonthOf(y, m) {
  if (!y || !m || m < 1 || m > 12) return ''
  return `${y}-${String(m).padStart(2, '0')}`
}

// Scans free text (statement preamble / filename) for an explicit statement
// period. Returns { month, source } or null. Ordered most-specific first: an
// explicit charge date beats a bare month name.
function detectStatementScope(text) {
  const s = String(text || '').replace(/\s+/g, ' ')
  if (!s) return null

  // "מועד חיוב 10/06/2026" / "חיוב לתאריך 10.06.2026" / "לחיוב ב-10/06/26"
  const chargeRe = /(?:מועד\s*חיוב|תאריך\s*חיוב|חיוב\s*לתאריך|לחיוב\s*ב|יום\s*חיוב)\D{0,12}(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/
  const cm = s.match(chargeRe)
  if (cm) {
    let y = Number(cm[3]); if (y < 100) y += 2000
    const month = _srcMonthOf(y, Number(cm[2]))
    if (month) return { month, source: 'charge-date', chargeDay: Number(cm[1]) }
  }

  // "עסקאות לחודש יוני 2026" / "פירוט לחודש 06/2026"
  const hebRe = new RegExp(`לחודש\\s*(${Object.keys(_SRC_HEB_MONTHS).join('|')})\\s*(\\d{4})`)
  const hm = s.match(hebRe)
  if (hm) {
    const month = _srcMonthOf(Number(hm[2]), _SRC_HEB_MONTHS[hm[1]])
    if (month) return { month, source: 'month-name' }
  }
  const numRe = /לחודש\s*(\d{1,2})[\/.\-](\d{4})/
  const nm = s.match(numRe)
  if (nm) {
    const month = _srcMonthOf(Number(nm[2]), Number(nm[1]))
    if (month) return { month, source: 'month-number' }
  }

  // A period range — the cycle is the month the range ENDS in.
  const rangeRe = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\s*(?:עד|-|–|until)\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/
  const rm = s.match(rangeRe)
  if (rm) {
    let y = Number(rm[6]); if (y < 100) y += 2000
    const month = _srcMonthOf(y, Number(rm[5]))
    if (month) return { month, source: 'period-range' }
  }
  return null
}

// The preamble is everything above the table header, where issuers print the
// card number and the billing period. Joined into one string for scanning.
function statementPreamble(rows, headerRowIndex) {
  const upTo = Math.max(0, Math.min(headerRowIndex ?? 0, rows.length))
  return rows.slice(0, upTo)
    .map(r => (r || []).map(c => String(c ?? '').trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' | ')
}

// ---------- account identification ----------
// Accounts carry `identifiers`: card last-4 digits, bank account numbers. The
// system learns them — on a confirmed import the identifier found in the file
// is attached to the chosen account, so the next file of that shape needs no
// question at all.

function accountIdentifiers(acc) {
  return (acc.identifiers || []).map(s => normalizeAccountIdentifier(s)).filter(Boolean)
}

// Digits only; a bank account written "12-345-678" and "12345678" are the same
// account. Card identifiers keep only the last 4 digits.
function normalizeAccountIdentifier(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (digits.length < 4) return ''
  return digits
}

function _srcIdentifierVariants(digits) {
  const out = new Set([digits])
  if (digits.length > 4) out.add(digits.slice(-4))
  return out
}

// Pull candidate identifiers out of statement text. A bare 4-digit number is
// far too common to trust, so a keyword must appear alongside it.
function extractAccountIdentifiers(text) {
  const s = String(text || '').replace(/\s+/g, ' ')
  const found = []
  const push = (raw, kind, conf) => {
    const n = normalizeAccountIdentifier(raw)
    if (n && !found.some(f => f.value === n)) found.push({ value: n, kind, confidence: conf })
  }

  // Masked card numbers: ****1234 / XXXX-XXXX-XXXX-1234 / 4580****1234
  for (const m of s.matchAll(/(?:[*xX•·]{2,}[\s\-]?){1,4}(\d{4})\b/g)) push(m[1], 'card', 'high')
  // "כרטיס 1234" / "כרטיס 4580123412341234" / "card 1234". The digit run is
  // captured whole — normalization keeps every digit and matching also tries
  // the last four, so a full PAN in the file still finds an account that was
  // only ever told the last four.
  for (const m of s.matchAll(/(?:כרטיס|card)\D{0,20}?(\d{4,19})\b/g)) push(m[1], 'card', 'high')
  for (const m of s.matchAll(/(?:מסתיים|ending|last)\D{0,12}?(\d{4})\b/gi)) push(m[1], 'card', 'high')
  for (const m of s.matchAll(/(\d{4})\s*(?:ספרות\s*אחרונות)/g)) push(m[1], 'card', 'high')
  // Bank accounts: "חשבון 12-345-678" / "מספר חשבון 123456" / "ח-ן 123456"
  for (const m of s.matchAll(/(?:מספר\s*חשבון|חשבון|ח["׳'`]?ן|account)\D{0,10}?(\d{2,3}[-\s]\d{3}[-\s]\d{3,9}|\d{5,12})\b/g)) {
    push(m[1], 'account', 'high')
  }
  return found
}

// Match extracted identifiers against the configured accounts.
// Returns { accountId, identifier, confidence } or null. Ambiguity — two
// accounts claiming the same identifier — resolves to null so the user picks.
function matchAccountByIdentifiers(identifiers, accounts) {
  if (!identifiers?.length || !accounts?.length) return null
  const hits = []
  for (const cand of identifiers) {
    const variants = _srcIdentifierVariants(cand.value)
    for (const acc of accounts) {
      for (const known of accountIdentifiers(acc)) {
        const knownVariants = _srcIdentifierVariants(known)
        const overlap = [...variants].some(v => knownVariants.has(v))
        if (overlap) hits.push({ accountId: acc.id, identifier: cand.value, confidence: cand.confidence })
      }
    }
  }
  if (!hits.length) return null
  const uniqueAccounts = new Set(hits.map(h => h.accountId))
  if (uniqueAccounts.size > 1) return null
  return hits[0]
}

// Full identification ladder for a structured file. Deterministic sources only;
// the AI step lives in the import flow and runs solely when this returns null.
//   1. identifiers printed in the statement preamble
//   2. identifiers in the filename
//   3. the profile/template this file matched, if it is bound to an account
function identifyAccountForFile({ preamble, filename, template, accounts }) {
  const fromText = matchAccountByIdentifiers(extractAccountIdentifiers(preamble), accounts)
  if (fromText) return { ...fromText, via: 'statement' }

  const fromName = matchAccountByIdentifiers(extractAccountIdentifiers(filename), accounts)
  if (fromName) return { ...fromName, via: 'filename' }

  if (template?.accountId && accounts.some(a => a.id === template.accountId)) {
    return { accountId: template.accountId, identifier: null, confidence: 'medium', via: 'template' }
  }
  return null
}

// Attach a newly-confirmed identifier to an account so the next file of the
// same shape is recognised without asking.
function learnAccountIdentifier(accountId, identifier) {
  const norm = normalizeAccountIdentifier(identifier)
  if (!norm) return false
  const accs = getAccounts()
  const acc = accs.find(a => a.id === accountId)
  if (!acc) return false
  const known = new Set(acc.identifiers || [])
  if (known.has(norm)) return false
  acc.identifiers = [...known, norm]
  DB.set('finAccounts', accs)
  if (typeof invalidateAccountCache === 'function') invalidateAccountCache()
  return true
}
