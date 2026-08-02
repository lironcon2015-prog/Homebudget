const DRIVE_CLIENT_ID = '702808266000-m1gro990l5uflm9o5jj56ut6n0b760il.apps.googleusercontent.com'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_FILE_NAME = 'finance-app-backup.json'

let _pendingDriveAction = null
let _driveToken = null
let _driveTokenClient = null
let _silentSignInResolve = null
let _syncState = 'off'   // last status — lets a freshly-rendered badge repaint itself

function _initDriveClient() {
  if (_driveTokenClient) return
  _driveTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: resp => {
      if (resp.error) {
        if (_silentSignInResolve) { _silentSignInResolve(false); _silentSignInResolve = null; return }
        _showDriveStatus('שגיאת התחברות: ' + resp.error, true)
        return
      }
      _driveToken = resp.access_token
      _renderDriveUI()
      localStorage.setItem('driveAutoSync', '1')

      // Silent path → just resolve; the caller drives the next step.
      if (_silentSignInResolve) { _silentSignInResolve(true); _silentSignInResolve = null; return }

      if (_pendingDriveAction === 'backup') {
        _pendingDriveAction = null
        driveBackup()
      } else if (_pendingDriveAction === 'restore') {
        _pendingDriveAction = null
        driveRestore()
      } else {
        // Manual interactive sign-in → start auto-sync (pull now, idle after).
        _setSyncStatus('syncing')
        _driveAutoPull().then(() => _setSyncStatus('idle')).catch(() => _setSyncStatus('error'))
      }
    },
  })
}

function driveSignIn() {
  _initDriveClient()
  _driveTokenClient.requestAccessToken()
}

function driveSignOut() {
  if (_driveToken) google.accounts.oauth2.revoke(_driveToken)
  _driveToken = null
  localStorage.removeItem('driveAutoSync')
  _setSyncStatus('off')
  _renderDriveUI()
}

function _renderDriveUI() {
  const on = !!_driveToken
  document.getElementById('driveNotSignedIn').style.display = on ? 'none' : ''
  const si = document.getElementById('driveSignedIn')
  si.style.display = on ? 'flex' : 'none'
  if (on) _updateDriveLastInfo()
}

function _updateDriveLastInfo() {
  const el = document.getElementById('driveLastBackupInfo')
  if (!el) return
  const at = localStorage.getItem('driveLastUploadAt') || localStorage.getItem('driveBackupAt')
  el.textContent = at ? 'גיבוי אחרון: ' + new Date(at).toLocaleString('he-IL') : 'טרם גובה לענן'
}

async function _driveReq(method, url, body, contentType) {
  const headers = { Authorization: 'Bearer ' + _driveToken }
  if (contentType) headers['Content-Type'] = contentType

  const cacheBuster = (url.includes('?') ? '&' : '?') + '_t=' + Date.now()
  const finalUrl = method === 'GET' ? url + cacheBuster : url

  const resp = await fetch(finalUrl, { method, headers, body, cache: 'no-store' })
  if (resp.status === 401) {
    _driveToken = null
    _renderDriveUI()
    throw new Error('פג תוקף החיבור — התחבר מחדש.')
  }
  return resp
}

async function _driveFindFile() {
  // סריקת ענן למציאת הקובץ הכי חדש שקיים כדי לפתור כפילויות (Split Brain)
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`)
  const r = await _driveReq('GET', `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime+desc&pageSize=5`)
  const data = await r.json()
  const searchLatest = data.files?.[0] || null

  // בדיקת הקובץ שהמכשיר הזה ננעל עליו
  const savedId = localStorage.getItem('driveBackupFileId')
  let savedFile = null
  if (savedId) {
    try {
      const r2 = await _driveReq('GET', `https://www.googleapis.com/drive/v3/files/${savedId}?fields=id,modifiedTime`)
      if (r2.ok) savedFile = await r2.json()
    } catch (e) {}
  }

  // בחירת הקובץ העדכני ביותר מביניהם
  let bestFile = savedFile || searchLatest
  if (savedFile && searchLatest) {
    const tSaved = new Date(savedFile.modifiedTime).getTime()
    const tSearch = new Date(searchLatest.modifiedTime).getTime()
    if (tSearch > tSaved) bestFile = searchLatest
  }

  if (bestFile) localStorage.setItem('driveBackupFileId', bestFile.id)
  return bestFile
}

async function driveBackup() {
  if (!_driveToken) {
    _pendingDriveAction = 'backup'
    driveSignIn()
    return
  }
  _showDriveStatus('מגבה…', false)
  try {
    const payload = JSON.stringify(collectBackupData(), null, 2)

    const existing = await _driveFindFile()
    let fileResult

    if (existing) {
      // בקשת השדות id,modifiedTime מגוגל דרייב בתשובה
      const r = await _driveReq(
        'PATCH',
        `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id,modifiedTime`,
        payload,
        'application/json'
      )
      if (!r.ok) throw new Error(await r.text())
      fileResult = await r.json()
    } else {
      const meta = JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' })
      const boundary = 'fb_boundary'
      const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`
      const r = await _driveReq(
        'POST',
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime',
        body,
        `multipart/related; boundary=${boundary}`
      )
      if (!r.ok) throw new Error(await r.text())
      fileResult = await r.json()
    }

    localStorage.setItem('driveBackupFileId', fileResult.id)
    // תיקון: זמן העלאה נשמר בנפרד מזמן שחזור כדי לא לחסום משיכות ממשתמשים אחרים
    localStorage.setItem('driveLastUploadAt', fileResult.modifiedTime || new Date().toISOString())
    _updateDriveLastInfo()
    _showDriveStatus('גובה בהצלחה', false)
  } catch (e) {
    _showDriveStatus('שגיאה: ' + e.message, true)
  }
}

async function driveRestore() {
  if (!_driveToken) {
    _pendingDriveAction = 'restore'
    driveSignIn()
    return
  }
  if (!await confirmDialog('שחזור יחליף את כל הנתונים הנוכחיים בגיבוי האחרון מ-Drive — כולל שינויים מקומיים שעדיין לא גובו. להמשיך?', { danger: true, confirmText: 'שחזר', title: 'שחזור מ-Drive' })) return
  _showDriveStatus('משחזר…', false)
  try {
    const file = await _driveFindFile()
    if (!file) throw new Error('לא נמצא קובץ גיבוי בגוגל דרייב.')
    const r = await _driveReq('GET', `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`)
    if (!r.ok) throw new Error(await r.text())
    let data
    try { data = await r.json() } catch { data = null }
    if (!validateBackupData(data)) throw new Error('קובץ הגיבוי בענן פגום — לא בוצע שחזור.')
    // The current state becomes a local snapshot before it's replaced —
    // a wrong-file restore is always reversible from Settings → גיבוי.
    if (typeof writeLocalSnapshot === 'function') await writeLocalSnapshot('pre-restore-drive')
    applyBackupData(data)
    localStorage.setItem('driveBackupFileId', file.id)
    localStorage.setItem('driveBackupAt', new Date(file.modifiedTime).toISOString())
    _showDriveStatus('שוחזר — מרענן…', false)
    setTimeout(() => location.reload(), 1500)
  } catch (e) {
    _showDriveStatus('שגיאה: ' + e.message, true)
  }
}

function _showDriveStatus(msg, isErr) {
  const el = document.getElementById('driveStatus')
  if (!el) return
  el.textContent = msg
  el.style.color = isErr ? 'var(--expense)' : '#4ade80'
  if (!isErr) setTimeout(() => { if (el.textContent === msg) el.textContent = '' }, 4000)
}

// ===== AUTO-SYNC =====
// Once the user signs in once, the app stays connected: every page load
// silently re-obtains a token (via GIS prompt:''), pulls Drive if it's
// newer than our last pull, and every write to a backup key schedules a
// debounced upload. On a push conflict (Drive moved since the last pull) we
// ask the user — never silently overwrite their other-device work.
const _DRIVE_BACKUP_KEYS = new Set([
  'finTransactions','finAccounts','finCategories','finBudgets','finCategoryRules',
  'finImportTemplates','finVendorAliases','finManualRecurringGroups','finRecurringHidden',
  'finRecurringIgnoreOutliers','finRecurringAmountOverride','finRecurringCadenceOverride',
  'finHiddenTopVendors','finProperty','finPropertyPayments','finPropertyManualMortgage','finPropertyDocs','finPropertyDocCats','finGmailDocSeen','finFeedback',
  'finDismissedAnomalies',
])
let _driveDebounceTimer = null
let _drivePushing = false
let _driveDirty = false
let _driveSuppressPush = false  // true while restoring from Drive — don't bounce writes back

function driveAutoSyncEnabled() { return localStorage.getItem('driveAutoSync') === '1' }

function _setSyncStatus(s) {
  const map = {
    'off':        { txt: '',                  cls: '',              title: '' },
    'signed-out': { txt: 'חיבור ל-Drive',      cls: 'sync-warn',     title: 'סנכרון פעיל אך לא מחובר — לחץ להתחבר' },
    'idle':       { txt: '✓ מסונכרן',          cls: 'sync-ok',       title: 'הנתונים מסונכרנים ל-Drive' },
    'syncing':    { txt: '↻ מסנכרן…',         cls: 'sync-syncing',  title: '' },
    'offline':    { txt: 'לא מקוון',           cls: 'sync-warn',     title: 'אין חיבור — נסנכרן כשיחזור' },
    'error':      { txt: 'שגיאת סנכרון',       cls: 'sync-err',      title: '' },
  }
  _syncState = (map[s] ? s : 'off')
  const m = map[s] || map.off
  document.querySelectorAll('.sync-status').forEach(el => {
    el.className = 'sync-status ' + m.cls
    el.textContent = m.txt
    el.title = m.title
    el.style.display = m.txt ? 'inline-flex' : 'none'
    el.onclick = (s === 'signed-out') ? () => driveSignIn() : null
  })
}

function _silentDriveSignIn() {
  return new Promise(resolve => {
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) return resolve(false)
    _initDriveClient()
    _silentSignInResolve = resolve
    try { _driveTokenClient.requestAccessToken({ prompt: '' }) }
    catch { _silentSignInResolve = null; resolve(false) }
    setTimeout(() => { if (_silentSignInResolve) { _silentSignInResolve(false); _silentSignInResolve = null } }, 5000)
  })
}

async function _driveAutoPull() {
  const file = await _driveFindFile()
  if (!file) return
  const lastPullAt = localStorage.getItem('driveLastPullAt') || ''
  if (lastPullAt && file.modifiedTime <= lastPullAt) return
  const r = await _driveReq('GET', `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`)
  if (!r.ok) throw new Error(await r.text())
  const data = await r.json()
  if (!validateBackupData(data)) return
  _driveSuppressPush = true
  try { applyBackupData(data) } finally { _driveSuppressPush = false }
  _driveDirty = false
  if (_driveDebounceTimer) { clearTimeout(_driveDebounceTimer); _driveDebounceTimer = null }
  localStorage.setItem('driveBackupFileId', file.id)
  localStorage.setItem('driveBackupAt', file.modifiedTime)
  localStorage.setItem('driveLastPullAt', file.modifiedTime)
  // Reflect restored data on screen.
  const cur = (typeof _currentScreen !== 'undefined' && _currentScreen) || 'dashboard'
  if (typeof navigate === 'function') navigate(cur)
}

// Whether a localStorage key belongs in the backup payload. The portfolio app
// under /invest/ owns an open-ended namespace rather than a fixed key list, so
// it is matched by prefix — see collectInvestKeys() in app.js.
function _isBackupKey(key) {
  return _DRIVE_BACKUP_KEYS.has(key) || key.startsWith(INVEST_KEY_PREFIX)
}

// Hook called from DB.set — schedules a debounced push when the changed key
// is part of the backup payload and we're connected.
function _onBackupKeyWrite(key) {
  if (_driveSuppressPush) return
  if (!_isBackupKey(key)) return
  if (!driveAutoSyncEnabled() || !_driveToken) return
  _driveDirty = true
  if (_driveDebounceTimer) clearTimeout(_driveDebounceTimer)
  _driveDebounceTimer = setTimeout(_drivePush, 5000)
}

// The portfolio app has its own persistence layer and writes localStorage
// directly, so its saves never reach DB.set and the hook above. They do reach
// us as `storage` events: the browser fires those in every context on the
// origin EXCEPT the one that made the write — which covers both the embedded
// frame on this page and the portfolio running in its own tab.
//
// Note the gap this does not close: when the portfolio PWA is open on a phone
// and this app is not, nothing on that device is listening, so the push waits
// until the budget app is next opened there.
window.addEventListener('storage', e => {
  if (e.key && e.key.startsWith(INVEST_KEY_PREFIX)) _onBackupKeyWrite(e.key)
})

async function _drivePush() {
  if (_drivePushing) return
  if (!navigator.onLine) { _setSyncStatus('offline'); return }
  if (!_driveToken) { _setSyncStatus('signed-out'); return }
  _drivePushing = true
  _setSyncStatus('syncing')
  try {
    const file = await _driveFindFile()
    if (file) {
      const lastPullAt = localStorage.getItem('driveLastPullAt') || ''
      if (lastPullAt && file.modifiedTime > lastPullAt) {
        // Conflict: remote moved since our last pull. Ask the user.
        const pullRemote = await confirmDialog(
          'מכשיר אחר עידכן את ה-Drive מאז הסנכרון האחרון.\nלמשוך את הענן (תאבד שינויים מקומיים שטרם הועלו)?\nאם תבטל — נדרוס את הענן עם המקומי.',
          { confirmText: 'משוך מהענן', cancelText: 'דרוס לענן' }
        )
        if (pullRemote) {
          const r = await _driveReq('GET', `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`)
          const data = await r.json()
          _driveSuppressPush = true
          try { applyBackupData(data) } finally { _driveSuppressPush = false }
          localStorage.setItem('driveLastPullAt', file.modifiedTime)
          localStorage.setItem('driveBackupAt', file.modifiedTime)
          _driveDirty = false
          _drivePushing = false
          _setSyncStatus('idle')
          const cur = (typeof _currentScreen !== 'undefined' && _currentScreen) || 'dashboard'
          if (typeof navigate === 'function') navigate(cur)
          return
        }
        // else: fall through to overwrite the remote with local.
      }
    }
    const payload = JSON.stringify(collectBackupData(), null, 2)
    let fileResult
    if (file) {
      const r = await _driveReq('PATCH', `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media&fields=id,modifiedTime`, payload, 'application/json')
      if (!r.ok) throw new Error(await r.text())
      fileResult = await r.json()
    } else {
      const boundary = 'b' + Math.random().toString(16).slice(2)
      const meta = JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' })
      const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`
      const r = await _driveReq('POST', `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`, body, `multipart/related; boundary=${boundary}`)
      if (!r.ok) throw new Error(await r.text())
      fileResult = await r.json()
    }
    localStorage.setItem('driveBackupFileId', fileResult.id)
    localStorage.setItem('driveBackupAt', fileResult.modifiedTime)
    localStorage.setItem('driveLastPullAt', fileResult.modifiedTime)
    localStorage.setItem('driveLastUploadAt', new Date().toISOString())
    _driveDirty = false
    _setSyncStatus('idle')
    _updateDriveLastInfo()
  } catch (e) {
    console.error('drive auto-push failed:', e)
    _setSyncStatus('error')
  } finally {
    _drivePushing = false
  }
}

async function driveAutoSyncInit() {
  if (!driveAutoSyncEnabled()) { _setSyncStatus('off'); return }
  _setSyncStatus('signed-out')
  // Wait briefly for the GIS script to load (it's async).
  for (let i = 0; i < 50 && (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2); i++) {
    await new Promise(r => setTimeout(r, 100))
  }
  const ok = await _silentDriveSignIn()
  if (!ok) { _setSyncStatus('signed-out'); return }
  _setSyncStatus('syncing')
  try { await _driveAutoPull(); _setSyncStatus('idle') } catch { _setSyncStatus('error') }
  window.addEventListener('online', () => { if (_driveDirty) _drivePush() })
  window.addEventListener('offline', () => _setSyncStatus('offline'))
}
document.addEventListener('DOMContentLoaded', () => { driveAutoSyncInit() })
