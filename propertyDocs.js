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

const PROP_DOC_TYPES = {
  voucher:   { label: 'שובר תשלום',         icon: '🧾' },
  receipt:   { label: 'אישור ביצוע תשלום',  icon: '💳' },
  guarantee: { label: 'ערבות בנקאית',       icon: '🏦' },
  schedule:  { label: 'לוח תשלומים מעודכן', icon: '📅' },
  mortgage:  { label: 'מסמכי משכנתא',       icon: '📜' },
  approval:  { label: 'אישור עקרוני',       icon: '✅' },
  contract:  { label: 'חוזה רכישה',         icon: '✍️' },
  tax:       { label: 'מס רכישה',           icon: '🏛️' },
  insurance: { label: 'ביטוח',              icon: '🛡️' },
  other:     { label: 'אחר',                icon: '📄' },
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
  } finally { db.close() }
}

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
  } finally { db.close() }
}

// ===== UPLOAD PIPELINE =====
let _pdPresetPaymentId = ''   // set when uploading from a specific payment row
let _pdFilter = 'all'         // doc-type chip filter
let _pdPayFilter = ''         // show only docs of one payment (row 📎 click)
let _pdBusy = 0               // uploads in flight (spinner in card header)

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

async function propDocHandleFiles(fileList) {
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
        docDate: '',
        amount: 0,
        notes: '',
        summary: '',
        ai: false,
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
  if (!apiKey && added.length) toast('להשלמת סיווג אוטומטי הזן מפתח Gemini בהגדרות. ניתן לסווג ידנית עם ✏️', { type: 'info' })
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
  const typeDesc = [
    'voucher (שובר תשלום לתשלום בבנק — לרוב עם ברקוד/מסלקה)',
    'receipt (אישור/קבלה על תשלום שבוצע)',
    'guarantee (ערבות בנקאית לפי חוק המכר שהתקבלה מהבנק המלווה של היזם)',
    'schedule (לוח/חשבון תשלומים מעודכן מהיזם, כולל הצמדות מדד)',
    'mortgage (הסכם הלוואה/משכנתא, לוח סילוקין, דוח יתרות)',
    'approval (אישור עקרוני למשכנתא)',
    'contract (חוזה/הסכם רכישת הדירה)',
    'tax (שובר או אישור מס רכישה)',
    'insurance (ביטוח חיים/מבנה למשכנתא)',
    'other (כל דבר אחר)',
  ].join(', ')
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
  if (PROP_DOC_TYPES[out.docType]) doc.docType = out.docType
  if (out.title) doc.title = String(out.title).slice(0, 80)
  if (/^\d{4}-\d{2}-\d{2}$/.test(out.docDate || '')) doc.docDate = out.docDate
  if (Number(out.amount) > 0) doc.amount = Number(out.amount)
  doc.summary = String(out.summary || '').slice(0, 200)
  doc.ai = true

  // Auto-link to a payment row: payment # first, amount match as fallback.
  if (!doc.linkedPaymentId) {
    const linked = _pdMatchPayment(out.paymentNumber, doc.amount, doc.docType)
    if (linked) doc.linkedPaymentId = linked.id
  }
  savePropertyDocs(list)

  const t = PROP_DOC_TYPES[doc.docType]
  const linkedRow = doc.linkedPaymentId ? getPropertyPayments().find(x => x.id === doc.linkedPaymentId) : null
  toast(`✨ ${t.icon} סווג: ${t.label}${linkedRow ? ` · קושר לתשלום${linkedRow.paymentNumber ? ' #' + linkedRow.paymentNumber : ''}` : ''}`, { type: 'success' })
}

function _pdMatchPayment(paymentNumber, amount, docType) {
  // Linking makes sense only for docs that belong to a specific payment.
  if (!['voucher', 'receipt', 'guarantee', 'tax'].includes(docType)) return null
  const pays = getPropertyPayments()
  if (paymentNumber != null) {
    const byNum = pays.find(x => x.paymentNumber === Number(paymentNumber))
    if (byNum) return byNum
  }
  if (amount > 0) {
    const tol = Math.max(5, amount * 0.01)
    return pays.find(x =>
      Math.abs((Number(x.paidAmount) || 0) - amount) <= tol ||
      Math.abs((Number(x.amount) || 0) - amount) <= tol
    ) || null
  }
  return null
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
  return `${type.label}${num} · ${when} · ${formatCurrency(row.amount)}`
}

function _pdRerender() { if (typeof renderProperty === 'function') renderProperty() }

// ===== CARD (shared desktop + mobile) =====
function _propDocsCard() {
  const docs = getPropertyDocs()
  const payFilterRow = _pdPayFilter ? getPropertyPayments().find(x => x.id === _pdPayFilter) : null
  let shown = docs
  if (payFilterRow) shown = shown.filter(d => d.linkedPaymentId === _pdPayFilter)
  else if (_pdFilter !== 'all') shown = shown.filter(d => (d.docType || 'other') === _pdFilter)
  shown = shown.slice().sort((a, b) => (b.docDate || b.createdAt || '').localeCompare(a.docDate || a.createdAt || ''))

  const counts = {}
  docs.forEach(d => { const k = d.docType || 'other'; counts[k] = (counts[k] || 0) + 1 })
  const chips = docs.length === 0 ? '' : `
    <div class="propdoc-chips">
      <button class="propdoc-chip ${_pdFilter === 'all' && !_pdPayFilter ? 'active' : ''}" onclick="propDocSetFilter('all')">הכל (${docs.length})</button>
      ${Object.entries(PROP_DOC_TYPES).filter(([k]) => counts[k]).map(([k, v]) =>
        `<button class="propdoc-chip ${_pdFilter === k && !_pdPayFilter ? 'active' : ''}" onclick="propDocSetFilter('${k}')">${v.icon} ${v.label} (${counts[k]})</button>`).join('')}
      ${payFilterRow ? `<button class="propdoc-chip active" onclick="propDocSetFilter('all')">📎 ${_pdPaymentLabel(payFilterRow)} ✕</button>` : ''}
    </div>`

  const items = shown.length === 0
    ? `<p style="text-align:center;color:var(--text-muted);font-size:.85rem;padding:1rem 0;margin:0">${docs.length === 0 ? 'אין עדיין מסמכים — העלה שובר, ערבות בנקאית או כל מסמך אחר' : 'אין מסמכים בסינון הנוכחי'}</p>`
    : shown.map(_pdItemHtml).join('')

  const totalBytes = docs.reduce((s, d) => s + (d.size || 0), 0)
  const busy = _pdBusy > 0 ? `<span class="propdoc-busy">⏳ מעבד ${_pdBusy} מסמכים…</span>` : ''

  return `
    <div class="card" id="propDocsCard">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap">
        <span>📎 מסמכים${docs.length ? ` (${docs.length})` : ''} ${busy}</span>
        <button class="btn-primary" onclick="propDocBrowse()" style="padding:.4rem .9rem;font-size:.85rem">+ העלה מסמך</button>
      </div>
      <div class="propdoc-drop" onclick="propDocBrowse()"
           ondragover="event.preventDefault();this.classList.add('drag')"
           ondragleave="this.classList.remove('drag')"
           ondrop="event.preventDefault();this.classList.remove('drag');propDocHandleFiles(event.dataTransfer.files)">
        <div style="font-size:1.4rem">📤</div>
        <div>לחץ לבחירת קובץ, גרור לכאן, או הדבק (Ctrl+V)</div>
        <div style="font-size:.75rem;color:var(--text-muted)">תמונות ו-PDF · שוברים, ערבויות, לוחות תשלומים, מסמכי משכנתא</div>
      </div>
      ${chips}
      <div class="propdoc-list">${items}</div>
      ${docs.length ? `<div style="font-size:.72rem;color:var(--text-muted);margin-top:.6rem">
        סה"כ ${_pdFmtSize(totalBytes)} · הקבצים נשמרים במכשיר זה (המידע עליהם מגובה, הקבצים עצמם לא עולים ל-Drive)
      </div>` : ''}
      <input type="file" id="propDocFileInput" multiple accept="image/*,application/pdf" style="display:none" onchange="propDocOnInput(this)">
    </div>`
}

function _pdItemHtml(d) {
  const t = PROP_DOC_TYPES[d.docType] || PROP_DOC_TYPES.other
  const linkedRow = d.linkedPaymentId ? getPropertyPayments().find(x => x.id === d.linkedPaymentId) : null
  const metaBits = [
    d.docDate ? formatDate(d.docDate) : '',
    d.amount > 0 ? formatCurrency(d.amount) : '',
    linkedRow ? `📎 ${linkedRow.paymentNumber ? 'תשלום #' + linkedRow.paymentNumber : _pdPaymentLabel(linkedRow)}` : '',
    _pdFmtSize(d.size || 0),
  ].filter(Boolean).join(' · ')
  return `
    <div class="propdoc-item" onclick="propDocView('${d.id}')">
      <div class="propdoc-icon">${t.icon}</div>
      <div class="propdoc-info">
        <div class="propdoc-name">${escHtml(_pdDisplayName(d))} ${d.ai ? '<span class="propdoc-ai" title="סווג אוטומטית ע&quot;י AI">✨</span>' : ''}</div>
        <div class="propdoc-meta"><span class="prop-status prop-st-tba">${t.label}</span> ${metaBits}</div>
        ${d.summary ? `<div class="propdoc-meta" style="opacity:.8">${escHtml(d.summary)}</div>` : ''}
      </div>
      <div class="propdoc-actions" onclick="event.stopPropagation()">
        <button class="btn-ghost" onclick="propDocEdit('${d.id}')" title="עריכה">✏️</button>
        <button class="btn-ghost" onclick="propDocDownload('${d.id}')" title="הורדה">⬇</button>
        <button class="btn-ghost" onclick="propDocDelete('${d.id}')" title="מחיקה" style="color:var(--expense)">🗑</button>
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
  _pdRerender()
  setTimeout(() => document.getElementById('propDocsCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
}

// ===== VIEW / EDIT / DOWNLOAD / DELETE =====
async function propDocView(id) {
  const d = getPropertyDocs().find(x => x.id === id)
  if (!d) return
  const blob = await _pdGetFile(id)
  if (!blob) {
    toast('הקובץ לא נמצא במכשיר זה — הוא הועלה ממכשיר אחר', { type: 'error' })
    return
  }
  const url = URL.createObjectURL(new Blob([blob], { type: d.mime }))
  const isImg = (d.mime || '').startsWith('image/')
  const preview = isImg
    ? `<img src="${url}" style="max-width:100%;max-height:65vh;border-radius:.5rem;display:block;margin:0 auto" alt="">`
    : `<iframe src="${url}" style="width:100%;height:65vh;border:1px solid var(--border);border-radius:.5rem;background:#fff"></iframe>`
  const t = PROP_DOC_TYPES[d.docType] || PROP_DOC_TYPES.other
  UK_sheet({
    title: `${t.icon} ${_pdDisplayName(d)}`,
    width: 'min(860px,96vw)',
    content: `
      ${d.summary ? `<div style="font-size:.85rem;color:var(--text-muted);margin-bottom:.6rem">${escHtml(d.summary)}</div>` : ''}
      ${preview}`,
    actions: [
      { label: '⬇ הורדה', onClick: () => { propDocDownload(id); return true } },
      { label: '🔗 פתח בכרטיסייה', onClick: () => { window.open(url, '_blank'); return true } },
      { label: '✏️ עריכה', onClick: () => { setTimeout(() => propDocEdit(id), 50) } },
      { label: 'סגור', onClick: () => {} },
    ],
    onClose: () => setTimeout(() => URL.revokeObjectURL(url), 30000),
  })
}

function propDocEdit(id) {
  const d = getPropertyDocs().find(x => x.id === id)
  if (!d) return
  const typeOpts = Object.entries(PROP_DOC_TYPES)
    .map(([k, v]) => `<option value="${k}" ${d.docType === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')
  const pays = getPropertyPayments().slice().sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
  const payOpts = ['<option value="">— ללא שיוך —</option>']
    .concat(pays.map(r => `<option value="${r.id}" ${d.linkedPaymentId === r.id ? 'selected' : ''}>${_pdPaymentLabel(r)}</option>`)).join('')
  UK_sheet({
    title: 'עריכת מסמך',
    content: `
      <div style="display:flex;flex-direction:column;gap:.7rem">
        <label class="form-row"><span class="form-label">שם</span>
          <input class="form-input" id="pdEditName" value="${escHtml(_pdDisplayName(d))}"></label>
        <label class="form-row"><span class="form-label">סוג מסמך</span>
          <select class="form-input" id="pdEditType">${typeOpts}</select></label>
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
  const blob = await _pdGetFile(id)
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
  if (!await confirmDialog(`למחוק את "${_pdDisplayName(d)}"? הקובץ יימחק לצמיתות מהמכשיר.`, { danger: true, confirmText: 'מחק' })) return
  savePropertyDocs(getPropertyDocs().filter(x => x.id !== id))
  try { await _pdDeleteFile(id) } catch (e) { console.warn('blob delete failed:', e) }
  _pdRerender()
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
