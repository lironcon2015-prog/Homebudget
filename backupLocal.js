// ===== LOCAL SNAPSHOTS (IndexedDB) =====
// Safety net under localStorage: rolling snapshots of the full backup payload
// (collectBackupData) written into IndexedDB, which has a far larger quota and
// survives localStorage pressure. Purely additive — the app's read path never
// touches this layer; it exists so "restore" is always possible after a bad
// sync, a destructive restore, or storage corruption.
//
// Retention: nothing outlives SNAP_RETENTION_DAYS (one week) except a small
// safety floor — the 2 newest snapshots survive regardless of age, so a
// dormant install always has something to restore from. Inside the window:
// the newest SNAP_KEEP_RECENT, the first snapshot of each day, and every
// 'pre-restore' snapshot (the "undo my restore" lifeline).
//
// Storage layout: two stores so listing stays cheap —
//   meta:    { id, createdAt, reason, txCount, accCount, bytes }
//   payload: { id, data }   (the full backup JSON)

const SNAP_DB_NAME = 'finSnapshots'
const SNAP_KEEP_RECENT = 10
const SNAP_RETENTION_DAYS = 7
const SNAP_SAFETY_FLOOR = 2
const SNAP_DEBOUNCE_MS = 30000

let _snapDebounceTimer = null
let _snapWriting = false

function _snapOpenDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const req = indexedDB.open(SNAP_DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('payload')) db.createObjectStore('payload', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function _snapTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'payload'], mode)
    const out = fn(tx.objectStore('meta'), tx.objectStore('payload'))
    tx.oncomplete = () => resolve(out)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('IDB transaction aborted'))
  })
}

function _snapReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function listLocalSnapshots() {
  const db = await _snapOpenDb()
  try {
    const metas = await _snapReq(db.transaction('meta').objectStore('meta').getAll())
    return (metas || []).sort((a, b) => b.createdAt - a.createdAt)
  } finally { db.close() }
}

// reason: 'auto' | 'pre-restore-drive' | 'pre-restore-local' | 'manual' | 'exit'
async function writeLocalSnapshot(reason = 'auto') {
  if (_snapWriting) return null
  if (typeof collectBackupData !== 'function') return null
  _snapWriting = true
  try {
    const data = collectBackupData()
    // Nothing worth snapshotting on a completely empty install.
    if (!(data.transactions?.length || data.accounts?.length)) return null
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const meta = {
      id,
      createdAt: Date.now(),
      reason,
      txCount: data.transactions?.length || 0,
      accCount: data.accounts?.length || 0,
      bytes: JSON.stringify(data).length,
    }
    const db = await _snapOpenDb()
    try {
      await _snapTx(db, 'readwrite', (m, p) => { m.put(meta); p.put({ id, data }) })
      await _snapPrune(db)
    } finally { db.close() }
    return meta
  } catch (e) {
    console.error('local snapshot failed:', e)
    return null
  } finally { _snapWriting = false }
}

async function _snapPrune(db) {
  const metas = (await _snapReq(db.transaction('meta').objectStore('meta').getAll()) || [])
    .sort((a, b) => b.createdAt - a.createdAt)
  const keep = new Set()
  metas.slice(0, SNAP_SAFETY_FLOOR).forEach(m => keep.add(m.id))
  const cutoff = Date.now() - SNAP_RETENTION_DAYS * 86400000
  const inWindow = metas.filter(m => m.createdAt >= cutoff)
  inWindow.slice(0, SNAP_KEEP_RECENT).forEach(m => keep.add(m.id))
  const seenDays = new Set()
  for (const m of inWindow) {
    if (String(m.reason || '').startsWith('pre-restore')) { keep.add(m.id); continue }
    const day = new Date(m.createdAt).toDateString()
    if (!seenDays.has(day)) { seenDays.add(day); keep.add(m.id) }
  }
  const drop = metas.filter(m => !keep.has(m.id)).map(m => m.id)
  if (drop.length) await _snapTx(db, 'readwrite', (m, p) => { drop.forEach(id => { m.delete(id); p.delete(id) }) })
}

async function _snapGetPayload(id) {
  const db = await _snapOpenDb()
  try {
    const rec = await _snapReq(db.transaction('payload').objectStore('payload').get(id))
    return rec ? rec.data : null
  } finally { db.close() }
}

// Debounced auto-snapshot — wired into DB.set via _onLocalSnapshotKeyWrite.
function _onLocalSnapshotKeyWrite(key) {
  const keys = (typeof _DRIVE_BACKUP_KEYS !== 'undefined') ? _DRIVE_BACKUP_KEYS : null
  if (keys && !keys.has(key)) return
  if (_snapDebounceTimer) clearTimeout(_snapDebounceTimer)
  _snapDebounceTimer = setTimeout(() => { _snapDebounceTimer = null; writeLocalSnapshot('auto') }, SNAP_DEBOUNCE_MS)
}

// ===== RESTORE =====
async function restoreLocalSnapshot(id) {
  const metas = await listLocalSnapshots()
  const meta = metas.find(m => m.id === id)
  if (!meta) { toast('ה-snapshot לא נמצא', { type: 'error' }); return }
  const when = new Date(meta.createdAt).toLocaleString('he-IL')
  const ok = await confirmDialog(
    `לשחזר את הנתונים מגיבוי מקומי מ-${when} (${meta.txCount} עסקאות)?\nהמצב הנוכחי יישמר כ-snapshot נוסף לפני השחזור.`,
    { danger: true, confirmText: 'שחזר', title: 'שחזור מגיבוי מקומי' })
  if (!ok) return
  const data = await _snapGetPayload(id)
  if (typeof validateBackupData === 'function' && !validateBackupData(data)) {
    toast('ה-snapshot פגום — לא בוצע שחזור', { type: 'error' }); return
  }
  // Safety net: the current state becomes a snapshot BEFORE it's replaced.
  await writeLocalSnapshot('pre-restore-local')
  applyBackupData(data)
  toast('שוחזר מגיבוי מקומי — מרענן…', { type: 'success' })
  setTimeout(() => location.reload(), 1200)
}

// ===== SETTINGS UI =====
const _SNAP_REASON_LABEL = {
  'auto': 'אוטומטי', 'manual': 'ידני', 'exit': 'ביציאה',
  'pre-restore-drive': 'לפני שחזור Drive', 'pre-restore-local': 'לפני שחזור מקומי',
}

async function renderLocalSnapshots() {
  const el = document.getElementById('localSnapshotsList')
  if (!el) return
  const summary = document.getElementById('localSnapshotsSummary')
  let metas = []
  try { metas = await listLocalSnapshots() } catch (e) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem">גיבוי מקומי לא זמין בדפדפן זה.</p>'
    return
  }
  if (summary) summary.textContent = `🗂 הצג רשימת גיבויים (${metas.length})`
  if (metas.length === 0) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem">אין עדיין גיבויים מקומיים — נוצרים אוטומטית אחרי כל שינוי.</p>'
    return
  }
  const fmtKb = b => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB')
  el.innerHTML = metas.map(m => `
    <div class="list-item" style="gap:.5rem;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div class="list-item-name">${new Date(m.createdAt).toLocaleString('he-IL')}</div>
        <div class="list-item-sub">${_SNAP_REASON_LABEL[m.reason] || escHtml(m.reason || '')} · ${m.txCount} עסקאות · ${fmtKb(m.bytes || 0)}</div>
      </div>
      <button class="btn-ghost" style="font-size:.8rem;padding:.35rem .75rem" onclick="restoreLocalSnapshot('${m.id}')">↩ שחזר</button>
    </div>`).join('')
}

async function createLocalSnapshotNow() {
  const meta = await writeLocalSnapshot('manual')
  toast(meta ? 'נוצר גיבוי מקומי' : 'אין נתונים לגבות', { type: meta ? 'success' : 'info' })
  renderLocalSnapshots()
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  // Ask the browser not to evict our storage under pressure (iOS/Android
  // PWAs). Best-effort; ignored where unsupported.
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {})
  } catch (e) {}

  // One snapshot per day guaranteed even without writes.
  setTimeout(async () => {
    try {
      const metas = await listLocalSnapshots()
      const today = new Date().toDateString()
      if (!metas.some(m => new Date(m.createdAt).toDateString() === today)) writeLocalSnapshot('auto')
    } catch (e) {}
  }, 4000)

  // Leaving the page: flush a pending Drive push (best-effort — the browser
  // may kill it) and capture a final local snapshot if writes are pending.
  const flush = () => {
    if (typeof _driveDirty !== 'undefined' && _driveDirty && typeof _drivePush === 'function') {
      try { _drivePush() } catch (e) {}
    }
    if (_snapDebounceTimer) {
      clearTimeout(_snapDebounceTimer)
      _snapDebounceTimer = null
      writeLocalSnapshot('exit')
    }
  }
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
})
