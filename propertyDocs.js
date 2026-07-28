// ===== PROPERTY / MORTGAGE DOCUMENTS =====
// מסמכים סרוקים של הנכס והמשכנתא: שוברי תשלום, ערבויות בנקאיות, לוחות
// תשלומים מעודכנים, מסמכי הלוואה ועוד.
//
// Storage split (on purpose):
//   - Blobs → IndexedDB (finPropertyDocFiles). Scans are MBs — localStorage
//     (~5MB total) can't hold them, and base64 in the Drive JSON backup would
//     blow past its practical size. Blobs are therefore DEVICE-LOCAL.
//   - Metadata → localStorage key finPropertyDocs (rides every backup path:
//     Drive, JSON export, local snapshots). On a device without the blob the
//     doc renders with an "unavailable on this device" state instead of lying.
// Images are recompressed before storing (camera scans are 3-8MB; a 2200px
// JPEG is plenty for a receipt) so quota lasts for years of vouchers.
//
// AI: if a Gemini key exists, every upload is classified async (type, date,
// amount, payment #, one-line summary) and auto-linked to the matching row in
// the payments table. Everything the AI writes is user-editable afterwards.

// Built-in categories. User-defined ones (finPropertyDocCats, synced in the
// backup payload) merge after these; docs reference a category by id, so a
// deleted custom category falls back to 'general'.
const PROP_DOC_BUILTIN_CATS = [
  { id: 'voucher',   label: 'שובר תשלום',         icon: 'ic:receipt',     hint: 'שובר תשלום לתשלום בבנק — לרוב עם ברקוד/מסלקה' },
  { id: 'receipt',   label: 'אישור ביצוע תשלום',  icon: 'ic:card',        hint: 'אישור/קבלה על תשלום שבוצע' },
  { id: 'guarantee', label: 'ערבות בנקאית',       icon: 'ic:landmark',    hint: 'ערבות בנקאית לפי חוק המכר שהתקבלה מהבנק המלווה של היזם' },
  { id: 'schedule',  label: 'לוח תשלומים מעודכן', icon: 'ic:calendar',    hint: 'לוח/חשבון תשלומים מעודכן מהיזם, כולל הצמדות מדד' },
  { id: 'mortgage',  label: 'מסמכי משכנתא',       icon: 'ic:scroll',      hint: 'הסכם הלוואה/משכנתא, לוח סילוקין, דוח יתרות' },
  { id: 'approval',  label: 'אישור עקרוני',       icon: 'ic:check',       hint: 'אישור עקרוני למשכנתא' },
  { id: 'contract',  label: 'חוזה רכישה',         icon: 'ic:signature',   hint: 'חוזה/הסכם רכישת הדירה' },
  { id: 'tax',       label: 'מס רכישה',           icon: 'ic:institution', hint: 'שובר או אישור מס רכישה' },
  { id: 'insurance', label: 'ביטוח',              icon: 'ic:shield',      hint: 'ביטוח חיים/מבנה למשכנתא' },
  { id: 'general',   label: 'מסמכים כלליים',      icon: 'ic:folder',      hint: 'מסמך כללי שלא שייך לתשלום ספציפי' },
  { id: 'other',     label: 'אחר',                icon: 'ic:file',        hint: 'כל דבר אחר' },
]

// Category icons are 'ic:<id>' entries in the shared icon registry (icons.js).
// Custom categories created before the SVG switch carry a legacy emoji — they
// fall back to the generic folder glyph rather than rendering the emoji.
function _pdCatIcon(c, size = 16, color = 'currentColor') {
  const raw = (c && c.icon) || ''
  return uiIcon(raw.indexOf('ic:') === 0 ? raw.slice(3) : 'folder', size, color, (c && c.label) || '')
}

function getPropDocCustomCats() { return DB.get('finPropertyDocCats', []) }
function savePropDocCustomCats(list) { DB.set('finPropertyDocCats', list) }
function getPropDocCats() { return PROP_DOC_BUILTIN_CATS.concat(getPropDocCustomCats()) }
function _pdCat(id) {
  return getPropDocCats().find(c => c.id === id) || PROP_DOC_BUILTIN_CATS.find(c => c.id === 'general')
}

const PROPDOC_MAX_BYTES = 20 * 1024 * 1024
const PROPDOC_COMPRESS_OVER = 1.5 * 1024 * 1024
const PROPDOC_MAX_DIM = 2200

function getPropertyDocs() { return DB.get('finPropertyDocs', []) }
function savePropertyDocs(list) { DB.set('finPropertyDocs', list) }

// ===== INDEXEDDB (blobs) =====
function _pdOpenDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const req = indexedDB.open('finPropertyDocFiles', 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('files')) req.result.createObjectStore('files', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function _pdReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function _pdPutFile(id, blob) {
  const db = await _pdOpenDb()
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.objectStore('files').put({ id, blob })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    if (_pdLocalIds) _pdLocalIds.add(id)
  } finally { db.close() }
}

// Which blobs exist on THIS device — metadata syncs across devices, blobs
// don't (until pulled from Drive), so the UI needs a cheap sync lookup.
let _pdLocalIds = null
async function _pdRefreshLocalIds() {
  try {
    const db = await _pdOpenDb()
    try {
      const keys = await _pdReq(db.transaction('files').objectStore('files').getAllKeys())
      _pdLocalIds = new Set(keys || [])
    } finally { db.close() }
  } catch { _pdLocalIds = null }
}
function _pdHasLocal(id) { return !_pdLocalIds || _pdLocalIds.has(id) }
document.addEventListener('DOMContentLoaded', () => {
  _pdRefreshLocalIds().then(() => {
    const scr = document.getElementById('screen-property')
    if (scr && scr.classList.contains('active')) _pdRerender()
  })
})

async function _pdGetFile(id) {
  const db = await _pdOpenDb()
  try {
    const rec = await _pdReq(db.transaction('files').objectStore('files').get(id))
    return rec ? rec.blob : null
  } finally { db.close() }
}

async function _pdDeleteFile(id) {
  const db = await _pdOpenDb()
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.objectStore('files').delete(id)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    if (_pdLocalIds) _pdLocalIds.delete(id)
  } finally { db.close() }
}

// ===== UPLOAD PIPELINE =====
let _pdPresetPaymentId = ''   // set when uploading from a specific payment row
let _pdFilter = 'all'         // doc-type chip filter
let _pdPayFilter = ''         // show only docs of one payment (row clip click)
let _pdBusy = 0               // uploads in flight (spinner in card header)
// The list grows without bound (years of vouchers) and sits at the bottom of a
// screen whose real subject is the payments table, so it starts folded. The
// flag is module-level, not persisted: it resets on reload but survives the
// full-screen redraws that _pdRerender does on every edit.
let _pdCardOpen = false

function propDocToggleCard(force) {
  _pdCardOpen = force === undefined ? !_pdCardOpen : !!force
  _pdRerender()
}

function propDocBrowse(paymentId = '') {
  _pdPresetPaymentId = paymentId || ''
  const inp = document.getElementById('propDocFileInput')
  if (inp) inp.click()
}

function propDocOnInput(inp) {
  const files = [...inp.files]
  inp.value = ''
  propDocHandleFiles(files)
}

// extra: { source, gmailMsgId, defaultDate, defaultNotes } — set by the Gmail
// importer so pulled attachments carry their message context.
async function propDocHandleFiles(fileList, extra = {}) {
  const preset = _pdPresetPaymentId
  _pdPresetPaymentId = ''
  const files = [...fileList].filter(f => {
    const ok = f.type.startsWith('image/') || f.type === 'application/pdf'
    if (!ok) toast(`"${f.name}" לא נתמך — רק תמונות ו-PDF`, { type: 'error' })
    else if (f.size > PROPDOC_MAX_BYTES) { toast(`"${f.name}" גדול מדי (מעל 20MB)`, { type: 'error' }); return false }
    return ok
  })
  if (!files.length) return

  _pdBusy += files.length
  const added = []
  for (const f of files) {
    try {
      const blob = await _pdMaybeCompress(f)
      const meta = {
        id: genId(),
        name: f.name,
        title: '',
        mime: blob.type || f.type,
        size: blob.size,
        docType: 'other',
        linkedPaymentId: preset,
        docDate: extra.defaultDate || '',
        amount: 0,
        notes: extra.defaultNotes || '',
        summary: '',
        ai: false,
        source: extra.source || 'upload',
        gmailMsgId: extra.gmailMsgId || '',
        driveFileId: '',
        createdAt: new Date().toISOString(),
      }
      await _pdPutFile(meta.id, blob)
      const list = getPropertyDocs()
      list.push(meta)
      savePropertyDocs(list)
      added.push({ meta, blob })
    } catch (e) {
      _pdBusy--
      toast(`שגיאה בשמירת "${f.name}": ` + (e.message || e), { type: 'error' })
    }
  }
  if (added.length) _pdCardOpen = true   // uploading is asking to see the list
  _pdRerender()
  if (!added.length) return
  toast(added.length === 1 ? 'המסמך נשמר' : `${added.length} מסמכים נשמרו`, { type: 'success' })

  // AI classification — async, sequential (rate limits), best-effort.
  const apiKey = typeof getApiKey === 'function' ? getApiKey() : ''
  for (const { meta, blob } of added) {
    if (apiKey) { try { await _pdClassify(meta, blob) } catch (e) { console.warn('doc classify failed:', e) } }
    _pdBusy--
    _pdRerender()
  }
  if (!apiKey && added.length) toast('להשלמת סיווג אוטומטי הזן מפתח Gemini בהגדרות. ניתן לסווג ידנית בכפתור העריכה', { type: 'info' })
  propDocSyncDrive()
}

// Camera scans are huge; a bounded JPEG keeps years of vouchers inside quota.
async function _pdMaybeCompress(file) {
  if (!file.type.startsWith('image/') || file.size <= PROPDOC_COMPRESS_OVER) return file
  try {
    const url = URL.createObjectURL(file)
    const img = await new Promise((res, rej) => {
      const i = new Image()
      i.onload = () => res(i)
      i.onerror = rej
      i.src = url
    })
    const scale = Math.min(1, PROPDOC_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    const out = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85))
    return (out && out.size < file.size) ? out : file
  } catch { return file }
}

// ===== AI CLASSIFICATION =====
async function _pdClassify(meta, blob) {
  // Category list is dynamic — custom categories participate in classification.
  const typeDesc = getPropDocCats()
    .map(c => `${c.id} (${c.label}${c.hint ? ' — ' + c.hint : ''})`)
    .join(', ')
  const prompt = `אתה מסווג מסמכים של רכישת דירה ומשכנתא בישראל.
נתח את המסמך המצורף והחזר JSON בלבד, ללא markdown וללא טקסט נוסף:
{"docType":"...","title":"...","docDate":"YYYY-MM-DD","amount":0,"paymentNumber":null,"summary":"..."}

- docType: אחד מ: ${typeDesc}
- title: שם קצר ותיאורי בעברית (עד 6 מילים), למשל "שובר תשלום 4 לבנק לאומי"
- docDate: התאריך המרכזי במסמך (תאריך תשלום/הנפקה), או "" אם לא ברור
- amount: הסכום המרכזי במסמך בש"ח (מספר, ללא פסיקים), או 0
- paymentNumber: מספר התשלום לפי לוח התשלומים אם מופיע במסמך, אחרת null
- summary: משפט אחד בעברית שמסכם את המסמך`

  const base64 = await new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result.split(',')[1])
    r.onerror = rej
    r.readAsDataURL(blob)
  })
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: meta.mime, data: base64 } }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
  }
  const data = await callGemini(getApiKey(), body)
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('no JSON in AI reply')
  const out = JSON.parse(m[0])

  const list = getPropertyDocs()
  const doc = list.find(x => x.id === meta.id)
  if (!doc) return
  if (getPropDocCats().some(c => c.id === out.docType)) doc.docType = out.docType
  if (out.title) doc.title = String(out.title).slice(0, 80)
  if (/^\d{4}-\d{2}-\d{2}$/.test(out.docDate || '')) doc.docDate = out.docDate
  if (Number(out.amount) > 0) doc.amount = Number(out.amount)
  doc.summary = String(out.summary || '').slice(0, 200)
  doc.ai = true

  savePropertyDocs(list)

  const t = _pdCat(doc.docType)
  if (doc.linkedPaymentId) {   // uploaded from a specific payment row
    const row = getPropertyPayments().find(x => x.id === doc.linkedPaymentId)
    toast(`סווג: ${t.label}${row ? ` · קושר לתשלום${row.paymentNumber ? ' #' + row.paymentNumber : ''}` : ''}`, { type: 'success' })
    return
  }

  const link = _pdMatchPayment(doc, out.paymentNumber)
  if (link.row && link.confidence >= PD_LINK_MIN_CONFIDENCE) {
    _pdSetLink(doc.id, link.row.id)
    toast(`סווג: ${t.label} · קושר לתשלום${link.row.paymentNumber ? ' #' + link.row.paymentNumber : ''}`, { type: 'success' })
    return
  }
  toast(`סווג: ${t.label}`, { type: 'success' })
  // Below the confidence bar the app does not guess — it asks.
  if (link.rule !== 'skip') await _pdAskLink(doc.id, link)
}

// ===== DOC → PAYMENT MATCHING =====
// Rule order (deliberate, and different from "payment # first"): the amount on
// the document is rule 1, its date is rule 2, and a payment number the AI read
// off the page only corroborates or contradicts them. A payment number is the
// field most often misread (schedules print several), while the amount is the
// one fact a voucher and a bank confirmation always agree on.
const PD_LINK_MIN_CONFIDENCE = 0.8
// Doc types that inherently belong to one payment. A contract or an updated
// schedule must not get glued to whatever payment happened that week, and must
// never trigger the "create a payment?" offer.
const PD_PAYMENT_DOC_TYPES = ['voucher', 'receipt', 'guarantee', 'tax']
// "זהות מדוייקת" — a shekel apart is rounding, twenty apart is another payment.
const PD_AMOUNT_EPSILON = 1
const PD_DATE_BACK_DAYS = 14      // "בטווח של שבועיים אחורה"
const PD_DATE_FORWARD_DAYS = 14   // a voucher is issued before it is paid

function _pdRowDate(r) { return r.paidDate || r.dueDate || '' }
function _pdDayGap(a, b) { return Math.abs(new Date(a) - new Date(b)) / 86400000 }
// >0 when the payment precedes the document.
function _pdDaysBefore(rowDate, docDate) { return (new Date(docDate) - new Date(rowDate)) / 86400000 }

// The ACTUAL amount is what identifies a payment. The contractual `amount`
// drifts from what left the account (index linkage, partial payments, fees),
// so a document is matched against `paidAmount` whenever one was recorded;
// `amount` only stands in for a payment that has not been paid yet. Hitting the
// contractual figure exactly while a *different* actual figure exists is the
// weakest signal of the three — that is precisely the case a human must judge.
const PD_AMT_RANK = { paid: 0, contract: 1, conflict: 2 }
function _pdAmountMatch(row, amount) {
  const paid = Number(row.paidAmount) || 0
  const due = Number(row.amount) || 0
  if (paid > 0 && Math.abs(paid - amount) <= PD_AMOUNT_EPSILON) return 'paid'
  if (due > 0 && Math.abs(due - amount) <= PD_AMOUNT_EPSILON) return paid > 0 ? 'conflict' : 'contract'
  return ''
}

// → { row, confidence, rule, candidates }. rule 'skip' means "this kind of
// document has nothing to link to" — stay silent rather than ask.
function _pdMatchPayment(doc, paymentNumber) {
  const pays = getPropertyPayments()
  const amount = Number(doc.amount) || 0
  const docDate = doc.docDate || ''
  const num = (paymentNumber === null || paymentNumber === undefined || paymentNumber === '')
    ? null : Number(paymentNumber)
  const byNum = (num != null && !isNaN(num)) ? pays.find(x => x.paymentNumber === num) : null
  const payDoc = PD_PAYMENT_DOC_TYPES.includes(doc.docType)
  const none = { row: null, confidence: 0, rule: payDoc && (amount > 0 || docDate) ? 'none' : 'skip', candidates: [] }

  // ---- Rule 1: the document's amount ----
  if (amount > 0) {
    const hits = []
    for (const r of pays) {
      const kind = _pdAmountMatch(r, amount)
      if (kind) hits.push({ row: r, kind })
    }
    if (hits.length) {
      const near = h => (docDate && _pdRowDate(h.row)) ? _pdDayGap(_pdRowDate(h.row), docDate) : 1e9
      hits.sort((a, b) => PD_AMT_RANK[a.kind] - PD_AMT_RANK[b.kind] || near(a) - near(b))
      const agreed = !!(byNum && hits.some(h => h.row.id === byNum.id))
      const best = agreed ? hits.find(h => h.row.id === byNum.id) : hits[0]
      const tied = hits.filter(h => h.kind === best.kind).length > 1
      let confidence = { paid: 0.95, contract: 0.85, conflict: 0.55 }[best.kind]
      if (agreed) confidence = 0.95
      else if (byNum) confidence = Math.min(confidence, 0.6)  // the page named a different payment
      else if (tied) confidence = Math.min(confidence, 0.7)   // the amount alone cannot choose
      return { row: best.row, confidence, rule: 'amount', kind: best.kind, candidates: hits.map(h => h.row) }
    }
  }

  // ---- Rule 2: the document's date ----
  if (docDate && payDoc) {
    const near = pays.filter(r => {
      const d = _pdRowDate(r)
      if (!d) return false
      const before = _pdDaysBefore(d, docDate)
      return before <= PD_DATE_BACK_DAYS && before >= -PD_DATE_FORWARD_DAYS
    }).sort((a, b) => _pdDayGap(_pdRowDate(a), docDate) - _pdDayGap(_pdRowDate(b), docDate))
    if (near.length) {
      const agreed = !!(byNum && near.some(r => r.id === byNum.id))
      // Rule 1 already failed, so the date on its own only nominates a
      // candidate — it clears the bar only when the payment number agrees.
      const confidence = agreed ? 0.85 : near.length === 1 ? 0.7 : 0.6
      return { row: agreed ? byNum : near[0], confidence, rule: 'date', candidates: near }
    }
  }

  if (byNum) return { row: byNum, confidence: 0.6, rule: 'number', candidates: [byNum] }
  return none
}

function _pdSetLink(docId, paymentId) {
  const list = getPropertyDocs()
  const d = list.find(x => x.id === docId)
  if (!d) return
  d.linkedPaymentId = paymentId || ''
  savePropertyDocs(list)
  _pdRerender()
}

// A document uploaded for a payment that was never entered by hand: build the
// row from what the document itself says. A receipt documents money that
// already left, a voucher only asks for it — so only the former is marked paid.
function _pdCreatePaymentForDoc(docId) {
  const d = getPropertyDocs().find(x => x.id === docId)
  if (!d) return null
  const list = getPropertyPayments()
  const maxNum = list.filter(x => x.type === 'payment' && x.paymentNumber)
    .reduce((mx, x) => Math.max(mx, x.paymentNumber), 0)
  const row = _propEmptyPayment()
  row.paymentNumber = maxNum + 1
  row.dueDate = d.docDate || ''
  row.amount = Number(d.amount) || 0
  if (d.docType === 'receipt') {
    row.paidDate = d.docDate || ''
    row.paidAmount = Number(d.amount) || 0
  }
  row.notes = `נוצר ממסמך: ${_pdDisplayName(d)}`
  list.push(row)
  savePropertyPayments(list)
  return row
}

const PD_ASK_WHY = {
  amount: 'נמצא תשלום בסכום זהה, אך לא באופן חד-משמעי',
  date: 'אין תשלום בסכום זהה — ההצעה מבוססת על קרבת תאריך בלבד',
  number: 'המסמך מציין מספר תשלום, אך הסכום והתאריך לא תואמים',
  none: 'לא נמצא תשלום תואם — לא לפי סכום ולא בשבועיים שלפני תאריך המסמך',
}

// Resolves when the sheet closes, whatever the user chose — the upload loop
// classifies sequentially and must not race ahead of the question.
function _pdAskLink(docId, m) {
  return new Promise(resolve => {
    const d = getPropertyDocs().find(x => x.id === docId)
    if (!d) { resolve(); return }
    const pays = getPropertyPayments()
    const rest = pays.filter(p => !m.candidates.some(c => c.id === p.id))
      .sort((a, b) => (_pdRowDate(a) || '').localeCompare(_pdRowDate(b) || ''))
    const opts = ['<option value="">— ללא שיוך —</option>']
      .concat(m.candidates.concat(rest).map(r =>
        `<option value="${r.id}" ${m.row && m.row.id === r.id ? 'selected' : ''}>${_pdPaymentLabel(r)}</option>`)).join('')
    // formatCurrency emits markup — the same reason _pdPaymentLabel is not
    // escaped here either. Nothing in either string is user-authored.
    const bits = [
      d.docDate ? formatDate(d.docDate) : 'ללא תאריך',
      Number(d.amount) > 0 ? formatCurrency(d.amount) : 'ללא סכום',
      escHtml(_pdCat(d.docType).label),
    ].join(' · ')
    const offerNew = PD_PAYMENT_DOC_TYPES.includes(d.docType) && (Number(d.amount) > 0 || d.docDate)
    const actions = [{
      label: 'שמור שיוך',
      primary: m.rule !== 'none',
      onClick: () => { _pdSetLink(docId, document.getElementById('pdAskPay').value) },
    }]
    if (offerNew) actions.push({
      label: '＋ צור תשלום חדש',
      primary: m.rule === 'none',
      onClick: () => {
        const row = _pdCreatePaymentForDoc(docId)
        if (row) {
          _pdSetLink(docId, row.id)
          toast(`נוצר תשלום #${row.paymentNumber} והמסמך שויך אליו`, { type: 'success' })
        }
      },
    })
    actions.push({ label: 'דלג', onClick: () => {} })

    UK_sheet({
      title: 'לאן לשייך את המסמך?',
      width: 'min(520px,95vw)',
      content: `
        <div style="display:flex;flex-direction:column;gap:.7rem">
          <div style="font-size:.9rem;font-weight:600">${escHtml(_pdDisplayName(d))}</div>
          <div style="font-size:.8rem;color:var(--text-muted)">${bits}</div>
          <div style="font-size:.8rem;color:var(--warning,#f59e0b)">${escHtml(PD_ASK_WHY[m.rule] || '')}${
            m.row ? ` (ודאות ${Math.round(m.confidence * 100)}%)` : ''}</div>
          <label class="form-row"><span class="form-label">תשלום מלוח התשלומים</span>
            <select class="form-input" id="pdAskPay">${opts}</select></label>
          ${offerNew ? '<div style="font-size:.75rem;color:var(--text-muted)">אם התשלום עוד לא הוזן בלוח — "צור תשלום חדש" יקים שורה לפי הסכום והתאריך שבמסמך.</div>' : ''}
        </div>`,
      actions,
      onClose: () => resolve(),
    })
  })
}

// ===== QUERIES =====
function propDocCountForPayment(paymentId) {
  return getPropertyDocs().filter(d => d.linkedPaymentId === paymentId).length
}

function _pdDisplayName(d) { return d.title || d.name }

function _pdFmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB' }

function _pdPaymentLabel(row) {
  const type = PROPERTY_TYPES[row.type] || PROPERTY_TYPES.other
  const num = row.paymentNumber ? ` #${row.paymentNumber}` : ''
  const when = formatDate(row.paidDate || row.dueDate) || 'ללא מועד'
  // What was actually paid is what a document can be compared against; the
  // contractual figure is shown only while nothing has been paid yet.
  const paid = Number(row.paidAmount) || 0
  const amt = paid > 0 ? `${formatCurrency(paid)} (שולם)` : formatCurrency(row.amount)
  return `${type.label}${num} · ${when} · ${amt}`
}

function _pdRerender() { if (typeof renderProperty === 'function') renderProperty() }

// ===== CARD (shared desktop + mobile) =====
function _propDocsCard() {
  const docs = getPropertyDocs()
  const payFilterRow = _pdPayFilter ? getPropertyPayments().find(x => x.id === _pdPayFilter) : null
  let shown = docs
  if (payFilterRow) shown = shown.filter(d => d.linkedPaymentId === _pdPayFilter)
  else if (_pdFilter !== 'all') shown = shown.filter(d => _pdCat(d.docType).id === _pdFilter)
  // Grouped by category, and inside each category newest upload first. Upload
  // time — not docDate — is the order the user remembers: a voucher scanned
  // today can carry a document date from months back.
  const catOrder = new Map(getPropDocCats().map((c, i) => [c.id, i]))
  const catIdx = d => catOrder.has(_pdCat(d.docType).id) ? catOrder.get(_pdCat(d.docType).id) : 999
  shown = shown.slice().sort((a, b) =>
    catIdx(a) - catIdx(b) ||
    (b.createdAt || '').localeCompare(a.createdAt || ''))

  const counts = {}
  docs.forEach(d => { const k = _pdCat(d.docType).id; counts[k] = (counts[k] || 0) + 1 })
  const chips = `
    <div class="propdoc-chips">
      ${docs.length ? `<button class="propdoc-chip ${_pdFilter === 'all' && !_pdPayFilter ? 'active' : ''}" onclick="propDocSetFilter('all')">הכל (${docs.length})</button>` : ''}
      ${getPropDocCats().filter(c => counts[c.id]).map(c =>
        `<button class="propdoc-chip ${_pdFilter === c.id && !_pdPayFilter ? 'active' : ''}" onclick="propDocSetFilter('${c.id}')">${_pdCatIcon(c, 13)} ${escHtml(c.label)} (${counts[c.id]})</button>`).join('')}
      ${payFilterRow ? `<button class="propdoc-chip active" onclick="propDocSetFilter('all')">${uiIcon('paperclip', 13)} ${_pdPaymentLabel(payFilterRow)} ✕</button>` : ''}
      <button class="propdoc-chip" onclick="propDocManageCats()" title="ניהול קטגוריות מסמכים">${uiIcon('gear', 13)} קטגוריות</button>
    </div>`

  const items = shown.length === 0
    ? `<p style="text-align:center;color:var(--text-muted);font-size:.85rem;padding:1rem 0;margin:0">${docs.length === 0 ? 'אין עדיין מסמכים — העלה שובר, ערבות בנקאית או כל מסמך אחר' : 'אין מסמכים בסינון הנוכחי'}</p>`
    : shown.map(_pdItemHtml).join('')

  const totalBytes = docs.reduce((s, d) => s + (d.size || 0), 0)
  const busy = _pdBusy > 0 ? `<span class="propdoc-busy">${uiIcon('clock', 13)} מעבד ${_pdBusy} מסמכים…</span>` : ''

  // The hidden file input stays outside the folded region — propDocBrowse()
  // clicks it, and pasting works on the property screen whether or not the
  // list is open.
  const body = !_pdCardOpen ? '' : `
      <div class="propdoc-drop" onclick="propDocBrowse()"
           ondragover="event.preventDefault();this.classList.add('drag')"
           ondragleave="this.classList.remove('drag')"
           ondrop="event.preventDefault();this.classList.remove('drag');propDocHandleFiles(event.dataTransfer.files)">
        <div>${uiIcon('upload', 26, 'var(--text-muted)')}</div>
        <div>לחץ לבחירת קובץ, גרור לכאן, או הדבק (Ctrl+V)</div>
        <div style="font-size:.75rem;color:var(--text-muted)">תמונות ו-PDF · שוברים, ערבויות, לוחות תשלומים, מסמכי משכנתא</div>
      </div>
      ${chips}
      <div class="propdoc-list">${items}</div>
      <div style="font-size:.72rem;color:var(--text-muted);margin-top:.6rem;display:flex;gap:.35rem;flex-wrap:wrap">
        ${docs.length ? `<span>סה"כ ${_pdFmtSize(totalBytes)} · מסתנכרן ל-Drive (תיקיית "${PROPDOC_DRIVE_FOLDER}")</span> ·` : ''}
        <span>תווית מייל: "${escHtml(localStorage.getItem('finGmailDocLabel') || 'HomeBudget')}"</span>
        <a style="cursor:pointer;text-decoration:underline" onclick="propDocChangeGmailLabel()">שנה</a>
      </div>`

  return `
    <div class="card" id="propDocsCard">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap">
        <button class="propdoc-fold" onclick="propDocToggleCard()"
                aria-expanded="${_pdCardOpen}" aria-controls="propDocsBody"
                title="${_pdCardOpen ? 'כווץ' : 'הצג מסמכים'}">
          <span class="propdoc-chev${_pdCardOpen ? ' open' : ''}">›</span>
          <span>מסמכים${docs.length ? ` (${docs.length})` : ''}</span> ${busy}
        </button>
        <span style="display:flex;gap:.5rem">
          <button class="btn-ghost" onclick="propDocScanGmail()" style="padding:.4rem .9rem;font-size:.85rem" title="ייבוא מסמכים ממיילים מתויגים ב-Gmail">סריקת מייל</button>
          <button class="btn-primary" onclick="propDocBrowse()" style="padding:.4rem .9rem;font-size:.85rem">+ העלה מסמך</button>
        </span>
      </div>
      <div id="propDocsBody">${body}</div>
      <input type="file" id="propDocFileInput" multiple accept="image/*,application/pdf" style="display:none" onchange="propDocOnInput(this)">
    </div>`
}

function _pdItemHtml(d) {
  const t = _pdCat(d.docType)
  const linkedRow = d.linkedPaymentId ? getPropertyPayments().find(x => x.id === d.linkedPaymentId) : null
  const local = _pdHasLocal(d.id)
  const cloud = d.driveFileId
    ? (local ? `<span title="מסונכרן ל-Drive">${uiIcon('cloudcheck', 14, 'var(--income)', 'מסונכרן ל-Drive')}</span>`
              : `<span title="נמצא ב-Drive — יורד בלחיצה">${uiIcon('clouddown', 14, 'currentColor', 'נמצא ב-Drive')}</span>`)
    : (local ? `<span title="ממתין לסנכרון ל-Drive">${uiIcon('cloud', 14, 'var(--text-muted)', 'ממתין לסנכרון')}</span>`
             : `<span title="הקובץ לא זמין במכשיר זה ולא ב-Drive">${uiIcon('alert', 14, 'var(--expense)', 'הקובץ לא זמין')}</span>`)
  const metaBits = [
    d.docDate ? formatDate(d.docDate) : '',
    d.amount > 0 ? formatCurrency(d.amount) : '',
    linkedRow ? `${uiIcon('paperclip', 12)} ${linkedRow.paymentNumber ? 'תשלום #' + linkedRow.paymentNumber : _pdPaymentLabel(linkedRow)}` : '',
    d.source === 'gmail' ? 'ממייל' : '',
    _pdFmtSize(d.size || 0),
  ].filter(Boolean).join(' · ')
  return `
    <div class="propdoc-item" onclick="propDocView('${d.id}')">
      <div class="propdoc-icon">${_pdCatIcon(t, 20)}</div>
      <div class="propdoc-info">
        <div class="propdoc-name">${escHtml(_pdDisplayName(d))} ${d.ai ? `<span class="propdoc-ai" title="סווג אוטומטית ע&quot;י AI">${uiIcon('sparkles', 12)}</span>` : ''}</div>
        <div class="propdoc-meta"><span class="prop-status prop-st-tba">${escHtml(t.label)}</span> ${metaBits} ${cloud}</div>
        ${d.summary ? `<div class="propdoc-meta" style="opacity:.8">${escHtml(d.summary)}</div>` : ''}
      </div>
      <div class="propdoc-actions" onclick="event.stopPropagation()">
        <button class="btn-ghost" onclick="propDocEdit('${d.id}')" title="עריכה" aria-label="עריכה">${uiIcon('pencil', 15)}</button>
        <button class="btn-ghost" onclick="propDocDownload('${d.id}')" title="הורדה" aria-label="הורדה">${uiIcon('download', 15)}</button>
        <button class="btn-ghost" onclick="propDocDelete('${d.id}')" title="מחיקה" aria-label="מחיקה" style="color:var(--expense)">${uiIcon('trash', 15)}</button>
      </div>
    </div>`
}

function propDocSetFilter(k) {
  _pdFilter = k
  _pdPayFilter = ''
  _pdRerender()
}

function propDocShowForPayment(paymentId) {
  _pdPayFilter = paymentId
  _pdFilter = 'all'
  _pdCardOpen = true   // the clip on a payment row asks for the list, not the card
  _pdRerender()
  setTimeout(() => document.getElementById('propDocsCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
}

// ===== VIEW / EDIT / DOWNLOAD / DELETE =====
// Fetch the blob locally, or pull it down from Drive (and cache it) if this
// device never had it.
async function _pdGetFileAnywhere(d) {
  let blob = await _pdGetFile(d.id)
  if (blob) return blob
  if (d.driveFileId && typeof _driveToken !== 'undefined' && _driveToken) {
    toast('מוריד מ-Drive…', { type: 'info' })
    const r = await _driveReq('GET', `https://www.googleapis.com/drive/v3/files/${d.driveFileId}?alt=media`)
    if (r.ok) {
      blob = await r.blob()
      try { await _pdPutFile(d.id, blob) } catch (e) { console.warn('doc cache failed:', e) }
      _pdRerender()
      return blob
    }
  }
  return null
}

async function propDocView(id) {
  const d = getPropertyDocs().find(x => x.id === id)
  if (!d) return
  let blob = null
  try { blob = await _pdGetFileAnywhere(d) } catch (e) { console.warn('doc fetch failed:', e) }
  if (!blob) {
    toast(d.driveFileId ? 'הקובץ ב-Drive אך אין חיבור — התחבר ל-Drive בהגדרות' : 'הקובץ לא נמצא במכשיר זה — הוא הועלה ממכשיר אחר לפני שהסנכרון הופעל', { type: 'error' })
    return
  }
  const url = URL.createObjectURL(new Blob([blob], { type: d.mime }))
  const isImg = (d.mime || '').startsWith('image/')
  const preview = isImg
    ? `<img src="${url}" style="max-width:100%;max-height:65vh;border-radius:.5rem;display:block;margin:0 auto" alt="">`
    : `<iframe src="${url}" style="width:100%;height:65vh;border:1px solid var(--border);border-radius:.5rem;background:#fff"></iframe>`
  const t = _pdCat(d.docType)
  UK_sheet({
    title: _pdDisplayName(d),
    width: 'min(860px,96vw)',
    content: `
      ${d.summary ? `<div style="font-size:.85rem;color:var(--text-muted);margin-bottom:.6rem">${escHtml(d.summary)}</div>` : ''}
      ${preview}`,
    actions: [
      { label: 'הורדה', onClick: () => { propDocDownload(id); return true } },
      { label: 'פתח בכרטיסייה', onClick: () => { window.open(url, '_blank'); return true } },
      { label: 'עריכה', onClick: () => { setTimeout(() => propDocEdit(id), 50) } },
      { label: 'סגור', onClick: () => {} },
    ],
    onClose: () => setTimeout(() => URL.revokeObjectURL(url), 30000),
  })
}

function propDocEdit(id) {
  const d = getPropertyDocs().find(x => x.id === id)
  if (!d) return
  const typeOpts = getPropDocCats()
    .map(c => `<option value="${c.id}" ${d.docType === c.id ? 'selected' : ''}>${escHtml(c.label)}</option>`).join('')
  const pays = getPropertyPayments().slice().sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
  const payOpts = ['<option value="">— ללא שיוך —</option>']
    .concat(pays.map(r => `<option value="${r.id}" ${d.linkedPaymentId === r.id ? 'selected' : ''}>${_pdPaymentLabel(r)}</option>`)).join('')
  UK_sheet({
    title: 'עריכת מסמך',
    content: `
      <div style="display:flex;flex-direction:column;gap:.7rem">
        <label class="form-row"><span class="form-label">שם</span>
          <input class="form-input" id="pdEditName" value="${escHtml(_pdDisplayName(d))}"></label>
        <label class="form-row"><span class="form-label">קטגוריה</span>
          <div style="display:flex;gap:.4rem">
            <select class="form-input" id="pdEditType" style="flex:1">${typeOpts}</select>
            <button class="btn-ghost" style="padding:.3rem .6rem" title="קטגוריה חדשה" onclick="propDocAddCatInline('pdEditType')">＋</button>
          </div></label>
        <label class="form-row"><span class="form-label">שיוך לתשלום מלוח התשלומים</span>
          <select class="form-input" id="pdEditPay">${payOpts}</select></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">
          <label class="form-row"><span class="form-label">תאריך מסמך</span>
            <input class="form-input" id="pdEditDate" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" value="${_isoToDmy(d.docDate || '')}" oninput="_onDateMaskInput(this)"></label>
          <label class="form-row"><span class="form-label">סכום</span>
            <input class="form-input" id="pdEditAmount" type="number" min="0" value="${d.amount || ''}" placeholder="0"></label>
        </div>
        <label class="form-row"><span class="form-label">הערות</span>
          <input class="form-input" id="pdEditNotes" value="${escHtml(d.notes || '')}"></label>
      </div>`,
    actions: [
      { label: 'שמור', primary: true, onClick: () => { propDocSaveEdit(id) } },
      { label: 'ביטול', onClick: () => {} },
    ],
  })
}

function propDocSaveEdit(id) {
  const list = getPropertyDocs()
  const d = list.find(x => x.id === id)
  if (!d) return
  d.title = document.getElementById('pdEditName').value.trim()
  d.docType = document.getElementById('pdEditType').value
  d.linkedPaymentId = document.getElementById('pdEditPay').value
  d.docDate = _dmyToIso(document.getElementById('pdEditDate').value) || ''
  d.amount = parseFloat(document.getElementById('pdEditAmount').value) || 0
  d.notes = document.getElementById('pdEditNotes').value.trim()
  savePropertyDocs(list)
  _pdRerender()
}

async function propDocDownload(id) {
  const d = getPropertyDocs().find(x => x.id === id)
  if (!d) return
  let blob = null
  try { blob = await _pdGetFileAnywhere(d) } catch (e) { console.warn('doc fetch failed:', e) }
  if (!blob) { toast('הקובץ לא נמצא במכשיר זה', { type: 'error' }); return }
  const url = URL.createObjectURL(new Blob([blob], { type: d.mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = d.name || 'document'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

async function propDocDelete(id) {
  const d = getPropertyDocs().find(x => x.id === id)
  if (!d) return
  if (!await confirmDialog(`למחוק את "${_pdDisplayName(d)}"? הקובץ יימחק לצמיתות מהמכשיר${d.driveFileId ? ' ומ-Drive' : ''}.`, { danger: true, confirmText: 'מחק' })) return
  savePropertyDocs(getPropertyDocs().filter(x => x.id !== id))
  try { await _pdDeleteFile(id) } catch (e) { console.warn('blob delete failed:', e) }
  if (d.driveFileId && typeof _driveToken !== 'undefined' && _driveToken) {
    try { await _driveReq('DELETE', `https://www.googleapis.com/drive/v3/files/${d.driveFileId}`) }
    catch (e) { console.warn('drive delete failed:', e) }
  }
  _pdRerender()
}

// ===== DRIVE FILE SYNC =====
// Rides the existing drive.js session (scope drive.file → we may create and
// read back our own files). Blobs go into a visible folder so the user can
// also browse the scans straight from Drive. Metadata (driveFileId) syncs via
// the regular JSON backup, so a second device knows what to pull on demand.
const PROPDOC_DRIVE_FOLDER = 'HomeBudget מסמכים'
let _pdDriveSyncBusy = false

async function _pdDriveFolderId() {
  const cached = localStorage.getItem('finPropDocDriveFolderId')
  if (cached) return cached
  const q = encodeURIComponent(`name='${PROPDOC_DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  const r = await _driveReq('GET', `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`)
  const found = (await r.json()).files?.[0]
  if (found) { localStorage.setItem('finPropDocDriveFolderId', found.id); return found.id }
  const cr = await _driveReq('POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    JSON.stringify({ name: PROPDOC_DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }), 'application/json')
  if (!cr.ok) throw new Error(await cr.text())
  const id = (await cr.json()).id
  localStorage.setItem('finPropDocDriveFolderId', id)
  return id
}

async function _pdDriveUploadDoc(d, blob) {
  const folderId = await _pdDriveFolderId()
  const meta = JSON.stringify({ name: d.name || 'document', parents: [folderId] })
  const form = new FormData()
  form.append('metadata', new Blob([meta], { type: 'application/json' }))
  form.append('file', new Blob([blob], { type: d.mime || 'application/octet-stream' }))
  const r = await _driveReq('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', form)
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).id
}

// Push every local blob that isn't on Drive yet. Safe to call often — bails
// instantly when there's nothing to do or no session.
async function propDocSyncDrive() {
  if (_pdDriveSyncBusy) return
  if (typeof _driveToken === 'undefined' || !_driveToken || !navigator.onLine) return
  const pending = getPropertyDocs().filter(d => !d.driveFileId && _pdHasLocal(d.id))
  if (!pending.length) return
  _pdDriveSyncBusy = true
  let uploaded = 0
  try {
    for (const d of pending) {
      const blob = await _pdGetFile(d.id)
      if (!blob) continue
      try {
        const fileId = await _pdDriveUploadDoc(d, blob)
        const list = getPropertyDocs()
        const cur = list.find(x => x.id === d.id)
        if (cur) { cur.driveFileId = fileId; savePropertyDocs(list) }
        else { await _driveReq('DELETE', `https://www.googleapis.com/drive/v3/files/${fileId}`).catch(() => {}) }
        uploaded++
      } catch (e) {
        console.warn('doc drive upload failed:', e)
        // Stale folder id (deleted folder) → drop cache and let the next pass recreate.
        if (String(e.message || '').includes('404')) localStorage.removeItem('finPropDocDriveFolderId')
        break
      }
    }
  } finally { _pdDriveSyncBusy = false }
  if (uploaded) { toast(`${uploaded} מסמכים הועלו ל-Drive`, { type: 'success' }); _pdRerender() }
}

// Late Drive sign-in (silent auto-connect finishes after first render) —
// retry whenever we're back online and shortly after load.
window.addEventListener('online', () => setTimeout(propDocSyncDrive, 2000))
document.addEventListener('DOMContentLoaded', () => setTimeout(propDocSyncDrive, 8000))

// ===== CATEGORY MANAGEMENT =====
async function propDocAddCat() {
  const name = await promptDialog('שם הקטגוריה החדשה:', { title: 'קטגוריה חדשה' })
  if (!name || !name.trim()) return null
  const label = name.trim().slice(0, 40)
  const all = getPropDocCats()
  const existing = all.find(c => c.label === label)
  if (existing) return existing
  const cat = { id: 'c' + genId(), label, icon: 'ic:folder' }
  savePropDocCustomCats(getPropDocCustomCats().concat(cat))
  return cat
}

async function propDocAddCatInline(selectId) {
  const cat = await propDocAddCat()
  if (!cat) return
  const sel = document.getElementById(selectId)
  if (sel && !sel.querySelector(`option[value="${cat.id}"]`)) {
    const opt = document.createElement('option')
    opt.value = cat.id
    opt.textContent = cat.label
    sel.appendChild(opt)
    sel.value = cat.id
  }
}

let _pdCatSheet = null
function propDocManageCats() {
  const custom = getPropDocCustomCats()
  const customRows = custom.length === 0
    ? '<p style="font-size:.85rem;color:var(--text-muted);margin:.4rem 0">אין עדיין קטגוריות מותאמות אישית.</p>'
    : custom.map(c => `
      <div style="display:flex;align-items:center;gap:.5rem;padding:.35rem 0">
        <span style="flex:1;display:inline-flex;align-items:center;gap:.4rem">${_pdCatIcon(c)} ${escHtml(c.label)}</span>
        <button class="btn-ghost" style="padding:.2rem .5rem" onclick="propDocRenameCat('${c.id}')">שנה שם</button>
        <button class="btn-ghost" style="padding:.2rem .5rem;color:var(--expense)" onclick="propDocDeleteCat('${c.id}')">מחק</button>
      </div>`).join('')
  const builtins = PROP_DOC_BUILTIN_CATS.map(c => c.label).join(' · ')
  if (_pdCatSheet) { _pdCatSheet.close(); _pdCatSheet = null }
  _pdCatSheet = UK_sheet({
    title: 'קטגוריות מסמכים',
    content: `
      <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:.6rem">קטגוריות מובנות: ${builtins}</div>
      <div style="font-weight:600;font-size:.9rem;margin:.4rem 0 .2rem">קטגוריות שלי</div>
      ${customRows}`,
    actions: [
      { label: '＋ הוסף קטגוריה', primary: true, onClick: () => { propDocAddCat().then(c => { if (c) { _pdRerender(); propDocManageCats() } }); return true } },
      { label: 'סגור', onClick: () => {} },
    ],
    onClose: () => { _pdCatSheet = null },
  })
}

async function propDocRenameCat(catId) {
  const list = getPropDocCustomCats()
  const c = list.find(x => x.id === catId)
  if (!c) return
  const name = await promptDialog('שם חדש לקטגוריה:', { defaultValue: c.label })
  if (!name || !name.trim()) return
  c.label = name.trim().slice(0, 40)
  savePropDocCustomCats(list)
  _pdRerender()
  propDocManageCats()
}

async function propDocDeleteCat(catId) {
  const docsIn = getPropertyDocs().filter(d => d.docType === catId).length
  const msg = docsIn > 0
    ? `למחוק את הקטגוריה? ${docsIn} מסמכים יועברו ל"מסמכים כלליים".`
    : 'למחוק את הקטגוריה?'
  if (!await confirmDialog(msg, { danger: true, confirmText: 'מחק' })) return
  if (docsIn > 0) {
    const docs = getPropertyDocs()
    docs.forEach(d => { if (d.docType === catId) d.docType = 'general' })
    savePropertyDocs(docs)
  }
  savePropDocCustomCats(getPropDocCustomCats().filter(x => x.id !== catId))
  _pdRerender()
  propDocManageCats()
}

// ===== GMAIL IMPORT =====
// Pulls attachments from Gmail messages the user tagged with a dedicated
// label. Read-only scope, separate consent from the Drive one; processed
// message ids are remembered (and synced) so a rescan never re-imports.
const GMAIL_DOC_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
let _gmailToken = null
let _gmailTokenClient = null
let _gmailResolve = null

function _gmailEnsureToken() {
  return new Promise(resolve => {
    if (_gmailToken) return resolve(true)
    if (typeof google === 'undefined' || !google.accounts?.oauth2) {
      toast('שירותי Google לא נטענו — בדוק חיבור לאינטרנט', { type: 'error' })
      return resolve(false)
    }
    if (!_gmailTokenClient) {
      _gmailTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: DRIVE_CLIENT_ID,
        scope: GMAIL_DOC_SCOPE,
        callback: resp => {
          let ok = !resp.error
          if (!ok) toast('התחברות ל-Gmail נכשלה: ' + resp.error, { type: 'error' })
          else if (!String(resp.scope || '').includes('gmail.readonly')) {
            // User approved the dialog but unchecked the Gmail checkbox.
            ok = false
            toast('לא אושרה גישת קריאה ל-Gmail — נסה שוב וסמן את תיבת ההרשאה', { type: 'error' })
          } else _gmailToken = resp.access_token
          if (_gmailResolve) { _gmailResolve(ok); _gmailResolve = null }
        },
      })
    }
    _gmailResolve = resolve
    try { _gmailTokenClient.requestAccessToken() }
    catch (e) { _gmailResolve = null; toast('שגיאת התחברות: ' + e.message, { type: 'error' }); resolve(false) }
  })
}

async function _gmailReq(url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + _gmailToken } })
  if (r.status === 401) { _gmailToken = null; throw new Error('פג תוקף חיבור Gmail — נסה שוב') }
  if (!r.ok) {
    // Surface the REAL blocker — a bare 403 sends the user hunting in the
    // wrong place. The common cases: API disabled in the Cloud project vs.
    // a token that's missing the scope.
    let detail = '', reason = ''
    try {
      const e = await r.json()
      detail = e.error?.message || ''
      reason = (e.error?.errors?.[0]?.reason || e.error?.status || '')
    } catch {}
    if (r.status === 403 && (/accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used|is disabled/i.test(detail))) {
      throw new Error('Gmail API לא מופעל בפרויקט Google Cloud של האפליקציה. יש להפעיל: console.cloud.google.com → APIs & Services → Library → Gmail API → Enable, ולנסות שוב אחרי כמה דקות')
    }
    if (r.status === 403 && /insufficient|PERMISSION_DENIED|forbidden/i.test(reason + ' ' + detail)) {
      _gmailToken = null
      throw new Error('חסרה הרשאת קריאה ל-Gmail — לחץ שוב על "סריקת מייל" ואשר את הגישה במסך ההתחברות')
    }
    throw new Error('Gmail API: HTTP ' + r.status + (detail ? ' — ' + detail : ''))
  }
  return r.json()
}

function _gmailWalkParts(part, out) {
  if (!part) return out
  const fn = part.filename || ''
  const mime = part.mimeType || ''
  const attId = part.body?.attachmentId
  if (attId && fn && (mime.startsWith('image/') || mime === 'application/pdf')) {
    // Tiny inline images are signatures/logos, not documents.
    if (mime === 'application/pdf' || (part.body?.size || 0) > 20000) {
      out.push({ filename: fn, mime, attachmentId: attId })
    }
  }
  ;(part.parts || []).forEach(p => _gmailWalkParts(p, out))
  return out
}

function _b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function propDocScanGmail() {
  let label = localStorage.getItem('finGmailDocLabel') || ''
  if (!label) {
    label = await promptDialog(
      'שם התווית ב-Gmail שממנה יישאבו מסמכים.\nתייג ב-Gmail את המיילים הרלוונטיים (שוברים, ערבויות, לוחות תשלומים) בתווית הזו — כל קובץ מצורף (תמונה/PDF) יימשך לאפליקציה.',
      { defaultValue: 'HomeBudget', title: 'סריקת מייל — הגדרה חד-פעמית' })
    if (!label || !label.trim()) return
    label = label.trim()
    localStorage.setItem('finGmailDocLabel', label)
  }
  if (!await _gmailEnsureToken()) return

  toast(`סורק מיילים עם התווית "${label}"…`, { type: 'info' })
  try {
    // Spaces in label names become hyphens in Gmail's search syntax.
    const q = encodeURIComponent(`label:${label.replace(/\s+/g, '-')} has:attachment`)
    const listResp = await _gmailReq(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=50`)
    const msgs = listResp.messages || []
    if (!msgs.length) { toast(`לא נמצאו מיילים עם התווית "${label}" וקבצים מצורפים`, { type: 'info' }); return }

    const seen = new Set(DB.get('finGmailDocSeen', []))
    const fresh = msgs.filter(m => !seen.has(m.id))
    if (!fresh.length) { toast('אין מיילים חדשים — הכל כבר יובא', { type: 'info' }); return }

    let imported = 0
    for (const m of fresh) {
      const msg = await _gmailReq(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`)
      const headers = msg.payload?.headers || []
      const subject = headers.find(h => h.name === 'Subject')?.value || ''
      const msgDate = msg.internalDate ? _iso(new Date(Number(msg.internalDate))) : ''
      const atts = _gmailWalkParts(msg.payload, [])
      const files = []
      for (const a of atts) {
        const data = await _gmailReq(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/attachments/${a.attachmentId}`)
        files.push(new File([_b64urlToBytes(data.data)], a.filename, { type: a.mime }))
      }
      if (files.length) {
        await propDocHandleFiles(files, { source: 'gmail', gmailMsgId: m.id, defaultDate: msgDate, defaultNotes: subject.slice(0, 120) })
        imported += files.length
      }
      seen.add(m.id)
      DB.set('finGmailDocSeen', [...seen])
    }
    toast(imported ? `יובאו ${imported} מסמכים מ-${fresh.length} מיילים` : 'לא נמצאו קבצים מתאימים (תמונות/PDF) במיילים החדשים', { type: imported ? 'success' : 'info' })
  } catch (e) {
    toast('שגיאה בסריקת המייל: ' + (e.message || e), { type: 'error' })
  }
}

async function propDocChangeGmailLabel() {
  const cur = localStorage.getItem('finGmailDocLabel') || 'HomeBudget'
  const label = await promptDialog('שם התווית ב-Gmail:', { defaultValue: cur })
  if (label && label.trim()) localStorage.setItem('finGmailDocLabel', label.trim())
}

// ===== PASTE (Ctrl+V anywhere on the property screen) =====
document.addEventListener('paste', e => {
  const scr = document.getElementById('screen-property')
  if (!scr || !scr.classList.contains('active')) return
  const files = [...(e.clipboardData?.files || [])]
  if (!files.length) return
  e.preventDefault()
  propDocHandleFiles(files)
})
