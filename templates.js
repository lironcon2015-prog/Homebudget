// ===== IMPORT TEMPLATES =====
// Deterministic parser for structured files (xlsx, csv, txt).
// Each template maps a specific source's columns to the transaction shape
// produced by the Gemini flow: { date, amount, vendor, description, type, category }
// Templates are matched by hashing the normalized header row.

function getTemplates() { return DB.get('finImportTemplates', []) }
function saveTemplates(list) { DB.set('finImportTemplates', list) }

function upsertTemplate(tpl) {
  const list = getTemplates()
  const idx = list.findIndex(t => t.id === tpl.id)
  if (idx >= 0) list[idx] = tpl
  else list.push(tpl)
  saveTemplates(list)
}

function deleteTemplate(id) {
  saveTemplates(getTemplates().filter(t => t.id !== id))
}

function findTemplateForSignature(sig) {
  return getTemplates().find(t => t.signature === sig) || null
}

function bumpTemplateUsage(id, txCount) {
  const list = getTemplates()
  const tpl = list.find(t => t.id === id)
  if (!tpl) return
  tpl.lastUsedAt = Date.now()
  tpl.txCount = (tpl.txCount || 0) + txCount
  saveTemplates(list)
}

// Normalize a header cell: lowercase, strip non-alphanumeric (incl. Hebrew),
// collapse whitespace.
function _normHeaderCell(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function computeHeaderSignature(headerRow) {
  const joined = (headerRow || []).map(_normHeaderCell).join('|')
  let h = 0
  for (let i = 0; i < joined.length; i++) h = (Math.imul(31, h) + joined.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

// ===== FILE → 2D array =====

function excelFileToRows(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = e => {
      try {
        // cellDates:true makes XLSX resolve serial dates into JS Date objects
        // using the workbook's epoch (1900 OR 1904), so Mac-Excel 1904 files
        // parse correctly. parseDateValue branches on Date to avoid re-doing
        // the conversion with the wrong epoch.
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
        res(rows)
      } catch (err) { rej(err) }
    }
    r.onerror = rej
    r.readAsArrayBuffer(file)
  })
}

function detectDelimiter(sampleText) {
  const line = (sampleText.split(/\r?\n/).find(l => l.trim()) || '')
  const counts = {
    ',':  (line.match(/,/g)  || []).length,
    ';':  (line.match(/;/g)  || []).length,
    '\t': (line.match(/\t/g) || []).length,
    '|':  (line.match(/\|/g) || []).length,
  }
  let best = ',', max = 0
  for (const [d, n] of Object.entries(counts)) if (n > max) { max = n; best = d }
  return max === 0 ? ',' : best
}

function parseCSVText(text, delimiter) {
  const rows = []
  let row = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++ }
      else if (c === '"') inQ = false
      else field += c
    } else {
      if (c === '"') inQ = true
      else if (c === delimiter) { row.push(field); field = '' }
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else field += c
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

async function csvFileToRows(file) {
  const text = await readTextFile(file)
  const delim = detectDelimiter(text)
  return parseCSVText(text, delim)
}

// Extract 2D array from any supported file type.
async function extractRowsFromFile(file) {
  if (/\.xlsx?$/i.test(file.name)) return excelFileToRows(file)
  if (/\.(csv|txt)$/i.test(file.name)) return csvFileToRows(file)
  throw new Error('סוג קובץ לא נתמך לפרסור דטרמיניסטי')
}

// ===== VALUE PARSERS =====

function parseDateValue(raw, format) {
  if (raw == null || raw === '') return null

  // XLSX with cellDates:true returns JS Date (local time) for date cells.
  // Use local getters here — UTC getters would shift a day back in UTC+2/3.
  if (raw instanceof Date) {
    const y = raw.getFullYear(), m = raw.getMonth() + 1, d = raw.getDate()
    if (!y || !m || !d) return null
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
  }

  // Excel serial date (numeric) — fallback for CSVs / sources that deliver
  // the raw serial as a number. Assumes the 1900 epoch; 1904-epoch files are
  // handled above via cellDates:true.
  if (typeof raw === 'number' && isFinite(raw) && raw > 1000 && raw < 80000) {
    const epoch = new Date(Date.UTC(1899, 11, 30))
    const d = new Date(epoch.getTime() + raw * 86400000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
  }

  const s = String(raw).trim()
  if (!s) return null

  // Already ISO
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  const parts = s.split(/[\/\-.]/).map(p => p.trim())
  if (parts.length < 3) return null
  let y, m, d
  const fmt = format || 'DD/MM/YYYY'

  const [p1, p2, p3] = parts
  if (fmt === 'DD/MM/YYYY' || fmt === 'DD/MM/YY') { d = p1; m = p2; y = p3 }
  else if (fmt === 'MM/DD/YYYY')                  { m = p1; d = p2; y = p3 }
  else if (fmt === 'YYYY-MM-DD')                  { y = p1; m = p2; d = p3 }
  else                                            { d = p1; m = p2; y = p3 }

  if (!y || !m || !d) return null
  if (y.length === 2) y = (Number(y) >= 70 ? '19' : '20') + y
  const yN = Number(y), mN = Number(m), dN = Number(d)
  if (!yN || !mN || !dN || mN > 12 || dN > 31) return null
  return `${String(yN).padStart(4,'0')}-${String(mN).padStart(2,'0')}-${String(dN).padStart(2,'0')}`
}

function parseAmountValue(raw, opts = {}) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && isFinite(raw)) return raw
  let s = String(raw).trim()
  if (!s) return null

  // Accounting negatives: (1,234.56) or [1,234.56]
  let negative = false
  if ((/^\(.*\)$/.test(s)) || (/^\[.*\]$/.test(s))) { negative = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1) }
  if (s.startsWith('+')) s = s.slice(1)

  // Strip currency symbols and spaces
  s = s.replace(/[₪$€£]/g, '').replace(/\s/g, '')

  // Heuristic: if both . and , appear, the rightmost is the decimal.
  const lastDot = s.lastIndexOf('.')
  const lastCom = s.lastIndexOf(',')
  if (lastDot >= 0 && lastCom >= 0) {
    if (lastDot > lastCom) s = s.replace(/,/g, '')        // US: 1,234.56
    else                   s = s.replace(/\./g, '').replace(',', '.')  // EU: 1.234,56
  } else if (lastCom >= 0 && lastDot < 0) {
    // Only commas — ambiguous. If there are 3 digits after the last comma -> thousands.
    const tail = s.slice(lastCom + 1)
    if (/^\d{3}$/.test(tail)) s = s.replace(/,/g, '')
    else                       s = s.replace(',', '.')
  }
  const n = parseFloat(s)
  if (!isFinite(n)) return null
  return negative ? -Math.abs(n) : n
}

// ===== MAIN PARSER =====
// Apply a template to extracted rows. Returns { transactions, stats }.
// Transaction shape matches Gemini's output so downstream code is agnostic.
// Some sources (e.g. MAX credit statements) stack several tables in one sheet,
// each with its OWN header row and a slightly different column layout — the
// off-cycle table inserts a "תאריך חיוב" column, the FX table adds currency
// columns. A single fixed index-map therefore mis-aligns every section after
// the first. To stay robust we re-resolve column indices by matching each
// section's header LABELS (taken from the primary header) whenever a new
// header row appears mid-sheet.
function _normHeaderCell(s) { return String(s ?? '').replace(/\s+/g, ' ').trim() }

// Build { field: label } from the template's mapped indices applied to the
// primary header row — the labels we'll hunt for in later section headers.
function _templateFieldLabels(columns, headerRow) {
  const at = idx => (idx == null ? null : _normHeaderCell(headerRow[idx]) || null)
  return {
    date:        at(columns.date?.index),
    vendor:      at(columns.vendor?.index),
    description: at(columns.description?.index),
    category:    at(columns.category?.index),
    chargeDate:  at(columns.chargeDate?.index),
    amount:      at(columns.amount?.index),
    debit:       at(columns.amount?.debitIndex),
    credit:      at(columns.amount?.creditIndex),
  }
}

// A row is a section header if one of its cells exactly matches the (required)
// date label — data rows hold a date VALUE there, never the label text.
function _isSectionHeaderRow(row, labels) {
  if (!labels.date) return false
  return row.some(c => _normHeaderCell(c) === labels.date)
}

// Re-resolve indices for this section by locating each field's label in its
// header row; keep the previous index when a label isn't found.
function _remapColumnsToHeader(baseColumns, headerRow, labels) {
  const find = label => {
    if (!label) return null
    const i = headerRow.findIndex(c => _normHeaderCell(c) === label)
    return i >= 0 ? i : null
  }
  const c = JSON.parse(JSON.stringify(baseColumns))
  const setIdx = (obj, key, label) => { const i = find(label); if (i != null && obj) obj[key] = i }
  setIdx(c.date, 'index', labels.date)
  setIdx(c.vendor, 'index', labels.vendor)
  setIdx(c.description, 'index', labels.description)
  setIdx(c.category, 'index', labels.category)
  setIdx(c.chargeDate, 'index', labels.chargeDate)
  if (c.amount) {
    setIdx(c.amount, 'index', labels.amount)
    setIdx(c.amount, 'debitIndex', labels.debit)
    setIdx(c.amount, 'creditIndex', labels.credit)
  }
  return c
}

function parseWithTemplate(rows, template) {
  const { columns, headerRowIndex = 0, skipFooterRows = 0 } = template
  const dataRows = rows.slice(headerRowIndex + 1, rows.length - (skipFooterRows || 0))

  const labels = _templateFieldLabels(columns, rows[headerRowIndex] || [])
  let cur = columns  // active mapping; switches when a new section header appears

  const stats = { total: dataRows.length, parsed: 0, skipped: 0, skippedReasons: {} }
  const skip = (reason) => { stats.skipped++; stats.skippedReasons[reason] = (stats.skippedReasons[reason]||0) + 1 }

  const transactions = []
  for (const row of dataRows) {
    // Empty row?
    if (!row || row.every(c => c == null || String(c).trim() === '')) { skip('ריקה'); continue }

    // New section header → re-map columns for the rows that follow, skip it.
    if (_isSectionHeaderRow(row, labels)) { cur = _remapColumnsToHeader(columns, row, labels); skip('כותרת מקטע'); continue }

    const columns_ = cur
    const dateRaw = row[columns_.date?.index]
    const date = parseDateValue(dateRaw, columns_.date?.format)
    if (!date) { skip('תאריך לא תקין'); continue }

    let amount = null
    if (columns_.amount?.mode === 'debit_credit') {
      const debit  = parseAmountValue(row[columns_.amount.debitIndex])
      const credit = parseAmountValue(row[columns_.amount.creditIndex])
      if (debit && debit !== 0)       amount = -Math.abs(debit)
      else if (credit && credit !== 0) amount = Math.abs(credit)
      else                             amount = null
    } else if (columns_.amount?.mode === 'signed' || !columns_.amount?.mode) {
      // Single signed-amount column. `flipSign` handles sources that use
      // positives for expenses.
      amount = parseAmountValue(row[columns_.amount?.index])
      if (amount != null && columns_.amount?.flipSign) amount = -amount
    }
    if (amount == null || amount === 0) { skip('סכום לא תקין'); continue }

    const vendor = columns_.vendor?.index != null ? String(row[columns_.vendor.index] ?? '').trim() : ''
    if (!vendor) { skip('ספק חסר'); continue }

    const description = columns_.description?.index != null ? String(row[columns_.description.index] ?? '').trim() : ''
    const category    = columns_.category?.index    != null ? String(row[columns_.category.index]    ?? '').trim() : ''

    // Optional explicit "charge date" column on CC bills. If present and parsable,
    // we surface it on the row; getTxEffectiveMonth then uses it directly instead
    // of inferring the billing month from billingDay rollover.
    let chargeDate = ''
    if (columns_.chargeDate?.index != null) {
      const cdRaw = row[columns_.chargeDate.index]
      const parsed = parseDateValue(cdRaw, columns_.chargeDate.format || columns_.date?.format)
      if (parsed) chargeDate = parsed
    }

    // Cells the template does NOT map to a known field (e.g. a "פירוט"/"הערות"
    // column the user chose to ignore) can still hold the Bit/Paybox recipient.
    // Stash them so enrichment can surface the recipient as a NOTE. We use only
    // unmapped cells (date/amount/vendor/category/chargeDate/description are
    // excluded) so account names, categories etc. don't leak into the name.
    const _mappedIdx = new Set([
      columns_.date?.index,
      columns_.amount?.index, columns_.amount?.debitIndex, columns_.amount?.creditIndex,
      columns_.vendor?.index, columns_.category?.index,
      columns_.chargeDate?.index, columns_.description?.index,
    ].filter(i => i != null))
    const _detectText = row
      .map((c, i) => (_mappedIdx.has(i) ? '' : String(c ?? '').trim()))
      .filter(Boolean)
      .join(' ')

    transactions.push({
      date,
      amount,
      vendor,
      description,
      type: amount > 0 ? 'income' : 'expense',
      category,
      ...(chargeDate ? { chargeDate } : {}),
      ...(_detectText ? { _detectText } : {}),
    })
    stats.parsed++
  }

  return { transactions, stats }
}

// Try to auto-detect the header row: first row with ≥3 non-empty cells
// that are mostly non-numeric (labels, not data).
function guessHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i] || []
    const nonEmpty = r.filter(c => c != null && String(c).trim() !== '')
    if (nonEmpty.length < 3) continue
    const numericCount = nonEmpty.filter(c => {
      const n = parseAmountValue(c)
      return n != null && !isNaN(n)
    }).length
    if (numericCount / nonEmpty.length < 0.5) return i
  }
  return 0
}
