// ===== FEEDBACK: bug reports & feature ideas =====
// Lightweight in-app capture so issues/ideas can be jotted down without
// breaking flow, then reviewed (and handed to Claude) from Settings.
// Stored under 'finFeedback' and included in the JSON backup.

function getFeedback() { return DB.get('finFeedback', []) }
function saveFeedback(list) { DB.set('finFeedback', list) }

// ===== GitHub sync (optional) =====
// When a token + repo are configured, each item is also opened as a GitHub
// issue (label user-feedback + bug/enhancement) so a Claude session can read
// and triage it automatically. Token lives in localStorage only and is NOT
// included in the JSON backup.
function getGithubToken() { return DB.get('finGithubToken', '') }
function getGithubRepo() { return DB.get('finGithubRepo', 'lironcon2015-prog/homebudget') }

function saveGithubConfig() {
  const token = (document.getElementById('ghToken')?.value || '').trim()
  const repo = (document.getElementById('ghRepo')?.value || '').trim()
  DB.set('finGithubToken', token)
  DB.set('finGithubRepo', repo)
  toast('החיבור ל-GitHub נשמר', { type: 'success' })
  loadGithubConfig()
}

function loadGithubConfig() {
  const t = document.getElementById('ghToken')
  const r = document.getElementById('ghRepo')
  const s = document.getElementById('ghStatus')
  if (r) r.value = getGithubRepo()
  if (t) t.value = getGithubToken()
  if (s) {
    const on = !!getGithubToken() && !!getGithubRepo()
    s.textContent = on ? '✓ מחובר — באגים/רעיונות ייפתחו כ-issues' : 'לא מחובר — שמירה מקומית בלבד'
    s.style.color = on ? 'var(--income)' : 'var(--text-muted)'
  }
}

async function createGithubIssue(item) {
  const token = getGithubToken(), repo = getGithubRepo()
  if (!token || !repo) return null
  const labels = ['user-feedback', item.type === 'bug' ? 'bug' : 'enhancement']
  const body = `${item.text || ''}\n\n---\n- סוג: ${item.type === 'bug' ? 'באג' : 'רעיון'}\n- מסך: ${item.screen}\n- גרסה: ${item.appVersion}\n- נוצר: ${new Date(item.createdAt).toLocaleString('he-IL')}`
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: (item.title || item.text || 'משוב').slice(0, 120), body, labels }),
  })
  if (!res.ok) throw new Error('GitHub ' + res.status)
  const data = await res.json()
  return { number: data.number, url: data.html_url }
}

// Persist any issue metadata back onto the stored item.
function _markFeedbackSynced(id, issue) {
  const list = getFeedback()
  const it = list.find(x => x.id === id)
  if (it) { it.issueNumber = issue.number; it.issueUrl = issue.url; saveFeedback(list) }
}

async function syncFeedbackItem(id) {
  const it = getFeedback().find(x => x.id === id)
  if (!it) return
  if (!getGithubToken()) { toast('לא הוגדר חיבור ל-GitHub', { type: 'error' }); return }
  try {
    const issue = await createGithubIssue(it)
    if (issue) { _markFeedbackSynced(id, issue); toast(`נפתח issue #${issue.number}`, { type: 'success' }); renderFeedbackList() }
  } catch (e) {
    toast('שליחה ל-GitHub נכשלה: ' + e.message, { type: 'error' })
  }
}


// Two subtle ghost buttons mounted into every screen's .page-header.
const FEEDBACK_DOCK_HTML = `
  <div class="feedback-dock" role="group" aria-label="משוב">
    <button class="fb-btn" type="button" title="דיווח על באג" aria-label="דיווח על באג" onclick="openFeedbackModal('bug')"><span class="fb-ic" aria-hidden="true">${uiIcon('bug', 15)}</span><span class="fb-label">באג</span></button>
    <button class="fb-btn" type="button" title="הצעת רעיון לפיתוח" aria-label="הצעת רעיון לפיתוח" onclick="openFeedbackModal('idea')"><span class="fb-ic" aria-hidden="true">${uiIcon('lightbulb', 15)}</span><span class="fb-label">רעיון</span></button>
  </div>`

function mountFeedbackButtons() {
  document.querySelectorAll('.page-header').forEach(h => {
    if (!h.querySelector('.feedback-dock')) h.insertAdjacentHTML('beforeend', FEEDBACK_DOCK_HTML)
  })
}
document.addEventListener('DOMContentLoaded', mountFeedbackButtons)

// Best-effort label of the screen the user is currently on (for context).
function _currentScreenLabel() {
  const map = { dashboard: 'לוח בקרה', transactions: 'עסקאות', import: 'ייבוא', analysis: 'ניתוח', recurring: 'קבועות', budget: 'תקציב', property: 'משכנתא ונכס', settings: 'הגדרות' }
  const s = (typeof _currentScreen !== 'undefined' && _currentScreen) || (location.hash || '').slice(1) || 'dashboard'
  return map[s] || s
}

function openFeedbackModal(type) {
  const isBug = type === 'bug'
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay open'
  overlay.style.zIndex = '1200'
  overlay.innerHTML = `
    <div class="modal-box" style="width:min(460px,95vw)" role="dialog" aria-modal="true">
      <div class="modal-header"><h3>${isBug ? 'דיווח על באג' : 'הצעת רעיון לפיתוח'}</h3><button class="modal-close" type="button" data-x>✕</button></div>
      <div class="modal-row"><label class="form-label">כותרת קצרה</label><input id="fbTitle" placeholder="${isBug ? 'מה לא עבד?' : 'מה תרצה להוסיף?'}"></div>
      <div class="modal-row"><label class="form-label">פירוט</label><textarea id="fbText" rows="4" style="resize:vertical" placeholder="${isBug ? 'תיאור הבאג: מה עשית, מה ציפית שיקרה, ומה קרה בפועל.' : 'תיאור הרעיון והערך שהוא מוסיף.'}"></textarea></div>
      <div style="font-size:.75rem;color:var(--text-muted);margin-bottom:1rem">נשמר אוטומטית עם המסך הנוכחי (${_currentScreenLabel()}), הגרסה והתאריך.</div>
      <div style="display:flex;gap:.6rem;justify-content:flex-end">
        <button class="btn-ghost" type="button" data-x>ביטול</button>
        <button class="btn-primary" type="button" data-save>שמירה</button>
      </div>
    </div>`
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-x]')) return close()
    if (e.target.closest('[data-save]')) {
      const title = (overlay.querySelector('#fbTitle').value || '').trim()
      const text = (overlay.querySelector('#fbText').value || '').trim()
      if (!title && !text) { toast('כתוב כותרת או פירוט', { type: 'error' }); return }
      const item = {
        id: genId(), type, title, text,
        screen: _currentScreenLabel(),
        appVersion: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '',
        createdAt: Date.now(), status: 'open',
      }
      const list = getFeedback()
      list.push(item)
      saveFeedback(list)
      close()
      toast(isBug ? 'הבאג נשמר' : 'הרעיון נשמר', { type: 'success' })
      if (document.getElementById('feedbackList')) renderFeedbackList()
      // Best-effort GitHub sync (non-blocking; local copy already saved).
      if (getGithubToken()) {
        createGithubIssue(item)
          .then(issue => { if (issue) { _markFeedbackSynced(item.id, issue); toast(`נפתח issue #${issue.number} ב-GitHub`, { type: 'success' }); if (document.getElementById('feedbackList')) renderFeedbackList() } })
          .catch(err => toast('שמור מקומית; שליחה ל-GitHub נכשלה (' + err.message + ')', { type: 'error', duration: 5000 }))
      }
    }
  })
  document.body.appendChild(overlay)
  overlay.querySelector('#fbTitle').focus()
}

// ===== SETTINGS TAB: review list =====
function toggleFeedbackStatus(id) {
  const list = getFeedback()
  const it = list.find(x => x.id === id)
  if (!it) return
  it.status = it.status === 'done' ? 'open' : 'done'
  saveFeedback(list)
  renderFeedbackList()
}
function deleteFeedbackItem(id) {
  saveFeedback(getFeedback().filter(x => x.id !== id))
  renderFeedbackList()
}

function _feedbackDigest() {
  const list = getFeedback()
  if (list.length === 0) return ''
  const fmt = ts => new Date(ts).toLocaleDateString('he-IL')
  const block = (label, type) => {
    const items = list.filter(x => x.type === type)
    if (items.length === 0) return ''
    const lines = items.map(x => `- [${x.status === 'done' ? 'x' : ' '}] ${x.title || '(ללא כותרת)'}${x.text ? ' — ' + x.text : ''}  _(מסך: ${x.screen}, גרסה: ${x.appVersion}, ${fmt(x.createdAt)})_`).join('\n')
    return `## ${label} (${items.length})\n${lines}`
  }
  return [block('באגים', 'bug'), block('רעיונות', 'idea')].filter(Boolean).join('\n\n')
}

function copyAllFeedback() {
  const digest = _feedbackDigest()
  if (!digest) { toast('אין משוב לייצוא', { type: 'info' }); return }
  navigator.clipboard.writeText(digest)
    .then(() => toast('הועתק ללוח — אפשר להדביק לקלוד', { type: 'success' }))
    .catch(() => toast('ההעתקה נכשלה', { type: 'error' }))
}

function renderFeedbackList() {
  const el = document.getElementById('feedbackList')
  if (!el) return
  const list = getFeedback().slice().sort((a, b) => b.createdAt - a.createdAt)
  const open = list.filter(x => x.status !== 'done').length
  const fmt = ts => new Date(ts).toLocaleDateString('he-IL')

  const ghOn = !!getGithubToken()
  const card = x => {
    const isBug = x.type === 'bug'
    const syncBadge = x.issueNumber
      ? `<a href="${x.issueUrl}" target="_blank" class="fb-sync fb-sync-ok" title="נפתח ב-GitHub">#${x.issueNumber} ↗</a>`
      : (ghOn ? `<button class="fb-sync fb-sync-retry" onclick="syncFeedbackItem('${x.id}')" title="שלח ל-GitHub">טרם נשלח · שלח</button>` : '')
    return `
      <div class="fb-item ${x.status === 'done' ? 'fb-item-done' : ''}">
        <div class="fb-item-main">
          <div class="fb-item-title">${uiIcon(isBug ? 'bug' : 'lightbulb', 14)} ${escHtml(x.title || '(ללא כותרת)')} ${syncBadge}</div>
          ${x.text ? `<div class="fb-item-text">${escHtml(x.text)}</div>` : ''}
          <div class="fb-item-meta">${escHtml(x.screen)} · גרסה ${escHtml(x.appVersion || '—')} · ${fmt(x.createdAt)}</div>
        </div>
        <div class="fb-item-actions">
          <button class="btn-ghost" style="font-size:.75rem;padding:.3rem .6rem" onclick="toggleFeedbackStatus('${x.id}')">${x.status === 'done' ? 'פתח מחדש' : 'סמן כטופל'}</button>
          <button class="btn-ghost" style="font-size:.75rem;padding:.3rem .55rem;color:var(--expense)" onclick="deleteFeedbackItem('${x.id}')" title="מחק" aria-label="מחק">${uiIcon('trash', 14)}</button>
        </div>
      </div>`
  }

  if (list.length === 0) {
    el.innerHTML = emptyStateHTML({
      icon: uiIcon('message', 30, 'var(--text-muted)'),
      title: 'אין משוב עדיין',
      text: 'השתמש בכפתורי הבאג והרעיון שבראש כל מסך כדי לתעד באגים ורעיונות תוך כדי שימוש.',
    })
    return
  }
  el.innerHTML = `
    <div class="fb-toolbar">
      <span style="color:var(--text-muted);font-size:.85rem">${list.length} פריטים · ${open} פתוחים</span>
      <button class="btn-primary" style="font-size:.8rem;padding:.4rem .8rem" onclick="copyAllFeedback()">העתק הכל ל-Claude</button>
    </div>
    <div class="fb-list">${list.map(card).join('')}</div>`
}
