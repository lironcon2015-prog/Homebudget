// src/io/DriveSync.js
//
// Cross-device sync over Google Drive.
//
// Why this exists at all: the portfolio and the budget app share an origin and
// therefore a localStorage, which makes them one database ON ONE DEVICE. It
// does nothing across devices. The budget app has its own Drive sync, but it is
// wired into its DB.set — our writes go through our own persistence layer and
// never reach it. Rather than teach one app to sync the other's data (two
// independent writers, one document, guaranteed conflicts), each app owns its
// own file end to end. Ours is kids-portfolio.json; theirs is untouched.
//
// The OAuth client is deliberately the SAME one the budget app registered: same
// origin, same consent, so connecting here does not send the user through a
// second Google setup. The drive.file scope only grants access to files this
// client created, which covers both apps' backups and nothing else of theirs.

const CLIENT_ID = '702808266000-m1gro990l5uflm9o5jj56ut6n0b760il.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'kids-portfolio.json';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

const ENABLED_KEY = 'juniorinvest:driveAutoSync';
const FILE_ID_KEY = 'juniorinvest:driveFileId';
const PULLED_AT_KEY = 'juniorinvest:driveLastPullAt';

// Everything under this prefix travels, EXCEPT the sync bookkeeping itself —
// pushing our own file id and pull timestamps would have every device
// overwrite the others' idea of where they are in the sync.
const DATA_PREFIX = 'juniorinvest:';
const BOOKKEEPING_PREFIX = 'juniorinvest:drive';

const PUSH_DEBOUNCE_MS = 4000;
const SILENT_SIGNIN_TIMEOUT_MS = 5000;

function collectKeys() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(DATA_PREFIX) && !k.startsWith(BOOKKEEPING_PREFIX)) {
      out[k] = localStorage.getItem(k);
    }
  }
  return out;
}

// A payload is only worth applying if it carries a parseable ledger. Restoring
// replaces the whole portfolio, so a truncated or foreign file must be rejected
// before it overwrites good data rather than after.
function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = payload.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return false;
  if (Object.values(keys).some((v) => typeof v !== 'string')) return false;
  const main = keys[DATA_PREFIX + 'v1'];
  if (typeof main !== 'string') return false;
  try {
    return Array.isArray(JSON.parse(main).ledger);
  } catch {
    return false;
  }
}

let gisPromise = null;
function loadGis() {
  // Loaded on demand rather than from index.html: a user who never connects
  // Drive should not be paying for Google's script on every cold start.
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const el = document.createElement('script');
    el.src = GIS_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { gisPromise = null; reject(new Error('טעינת Google Identity נכשלה')); };
    document.head.appendChild(el);
  });
  return gisPromise;
}

export class DriveSync {
  /**
   * @param {object} sm   StateManager — read for pushes, reloaded after pulls.
   * @param {object} opts
   * @param {(status: string, detail?: string) => void} opts.onStatus
   * @param {(message: string) => Promise<boolean>} opts.onConflict  resolve
   *        true to take the cloud copy, false to overwrite it with local.
   */
  constructor(sm, { onStatus = () => {}, onConflict = async () => true } = {}) {
    this.sm = sm;
    this.onStatus = onStatus;
    this.onConflict = onConflict;
    this.token = null;
    this.tokenClient = null;
    this._silentResolve = null;
    this._pushTimer = null;
    this._pushing = false;
    this._suppress = false;   // true while applying a pull — do not echo it back
    this._status = 'off';
  }

  get enabled() { return localStorage.getItem(ENABLED_KEY) === '1'; }
  get status() { return this._status; }

  _setStatus(s, detail) {
    this._status = s;
    this.onStatus(s, detail);
  }

  // ---- Auth ---------------------------------------------------------------

  async _initClient() {
    await loadGis();
    if (this.tokenClient) return;
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) {
          if (this._silentResolve) { this._silentResolve(false); this._silentResolve = null; return; }
          this._setStatus('error', resp.error);
          return;
        }
        this.token = resp.access_token;
        localStorage.setItem(ENABLED_KEY, '1');
        if (this._silentResolve) { this._silentResolve(true); this._silentResolve = null; return; }
        this._setStatus('syncing');
        this.pull()
          .then(() => this._setStatus('idle'))
          .catch((e) => this._setStatus('error', e.message));
      },
    });
  }

  // Re-obtains a token without any UI. Works once the user has consented on
  // this origin before, which is what keeps the app connected across reloads.
  async _silentSignIn() {
    await this._initClient();
    return new Promise((resolve) => {
      this._silentResolve = resolve;
      try {
        this.tokenClient.requestAccessToken({ prompt: '' });
      } catch {
        this._silentResolve = null;
        resolve(false);
      }
      setTimeout(() => {
        if (this._silentResolve) { this._silentResolve(false); this._silentResolve = null; }
      }, SILENT_SIGNIN_TIMEOUT_MS);
    });
  }

  async signIn() {
    await this._initClient();
    this._setStatus('syncing');
    this.tokenClient.requestAccessToken({ prompt: '' });
  }

  signOut() {
    if (this.token && window.google?.accounts?.oauth2) {
      try { google.accounts.oauth2.revoke(this.token, () => {}); } catch { /* best effort */ }
    }
    this.token = null;
    localStorage.removeItem(ENABLED_KEY);
    this._setStatus('off');
  }

  // ---- Transport ----------------------------------------------------------

  async _req(method, url, body, contentType) {
    const headers = { Authorization: 'Bearer ' + this.token };
    if (contentType) headers['Content-Type'] = contentType;
    // GETs are cache-busted: a 200 from the HTTP cache would hide the very
    // change we are polling for.
    const finalUrl = method === 'GET' ? url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now() : url;
    const resp = await fetch(finalUrl, { method, headers, body, cache: 'no-store' });
    if (resp.status === 401) {
      this.token = null;
      this._setStatus('signed-out');
      throw new Error('פג תוקף החיבור ל-Drive');
    }
    return resp;
  }

  // Resolves the file to use, preferring whichever copy is newest. Two devices
  // that both created a file before ever seeing each other's leaves duplicates
  // behind; picking the newest converges them instead of silently splitting the
  // portfolio in two.
  async _findFile() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const r = await this._req(
      'GET',
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc&pageSize=5`
    );
    if (!r.ok) throw new Error(await r.text());
    const newest = (await r.json()).files?.[0] || null;

    const savedId = localStorage.getItem(FILE_ID_KEY);
    let saved = null;
    if (savedId) {
      try {
        const r2 = await this._req('GET', `https://www.googleapis.com/drive/v3/files/${savedId}?fields=id,modifiedTime`);
        if (r2.ok) saved = await r2.json();
      } catch { /* fall back to the search result */ }
    }

    let best = saved || newest;
    if (saved && newest && new Date(newest.modifiedTime) > new Date(saved.modifiedTime)) best = newest;
    if (best) localStorage.setItem(FILE_ID_KEY, best.id);
    return best;
  }

  // ---- Pull ---------------------------------------------------------------

  /** @param {boolean} force  pull even when the file looks unchanged. */
  async pull({ force = false } = {}) {
    if (!this.token) return false;
    const file = await this._findFile();
    if (!file) return false;

    const lastPull = localStorage.getItem(PULLED_AT_KEY) || '';
    if (!force && lastPull && file.modifiedTime <= lastPull) return false;

    const r = await this._req('GET', `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
    if (!r.ok) throw new Error(await r.text());
    const payload = await r.json();
    if (!validPayload(payload)) throw new Error('הקובץ ב-Drive לא בפורמט מוכר');

    this._suppress = true;
    try {
      for (const [k, v] of Object.entries(payload.keys)) {
        if (k.startsWith(DATA_PREFIX) && !k.startsWith(BOOKKEEPING_PREFIX)) localStorage.setItem(k, v);
      }
      this.sm.reloadFromPersistence();
    } finally {
      this._suppress = false;
    }

    if (this._pushTimer) { clearTimeout(this._pushTimer); this._pushTimer = null; }
    localStorage.setItem(PULLED_AT_KEY, file.modifiedTime);
    return true;
  }

  // ---- Push ---------------------------------------------------------------

  // Called on every commit. Debounced, because a single edit in the UI can be
  // several commits in a row and each one must not become its own upload.
  schedulePush() {
    if (this._suppress || !this.enabled || !this.token) return;
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this.push().catch(() => {}), PUSH_DEBOUNCE_MS);
  }

  async push() {
    if (this._pushing) return;
    if (!navigator.onLine) { this._setStatus('offline'); return; }
    if (!this.token) { this._setStatus('signed-out'); return; }

    this._pushing = true;
    this._setStatus('syncing');
    try {
      const existing = await this._findFile();

      if (existing) {
        const lastPull = localStorage.getItem(PULLED_AT_KEY) || '';
        if (lastPull && existing.modifiedTime > lastPull) {
          // Another device moved the file since we last read it. Overwriting
          // here would silently destroy that work, so the choice is the user's.
          const takeRemote = await this.onConflict(
            'מכשיר אחר עדכן את התיק ב-Drive מאז הסנכרון האחרון.\n' +
            'למשוך את הגרסה מהענן? (השינויים המקומיים שטרם עלו יאבדו)\n' +
            'ביטול — הגרסה המקומית תדרוס את הענן.'
          );
          if (takeRemote) {
            await this.pull({ force: true });
            this._setStatus('idle');
            return;
          }
        }
      }

      const payload = JSON.stringify({
        app: 'kids-portfolio',
        version: 1,
        savedAt: new Date().toISOString(),
        keys: collectKeys(),
      });

      let result;
      if (existing) {
        const r = await this._req(
          'PATCH',
          `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id,modifiedTime`,
          payload,
          'application/json'
        );
        if (!r.ok) throw new Error(await r.text());
        result = await r.json();
      } else {
        const meta = JSON.stringify({ name: FILE_NAME, mimeType: 'application/json' });
        const boundary = 'ji_boundary';
        const body =
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n` +
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
        const r = await this._req(
          'POST',
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime',
          body,
          `multipart/related; boundary=${boundary}`
        );
        if (!r.ok) throw new Error(await r.text());
        result = await r.json();
      }

      localStorage.setItem(FILE_ID_KEY, result.id);
      // Our own upload becomes the new baseline, otherwise the next push would
      // read the file we just wrote as somebody else's change and prompt.
      localStorage.setItem(PULLED_AT_KEY, result.modifiedTime || new Date().toISOString());
      this._setStatus('idle');
    } catch (e) {
      this._setStatus('error', e.message);
      throw e;
    } finally {
      this._pushing = false;
    }
  }

  // ---- Lifecycle ----------------------------------------------------------

  async init() {
    if (!this.enabled) { this._setStatus('off'); return; }
    this._setStatus('syncing');
    try {
      const ok = await this._silentSignIn();
      if (!ok) { this._setStatus('signed-out'); return; }
      await this.pull();
      this._setStatus('idle');
    } catch (e) {
      this._setStatus('error', e.message);
    }

    // Coming back to the app is the moment its data is most likely stale —
    // another device may have pushed while this one sat in the background.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.pullIfIdle();
    });
    window.addEventListener('online', () => this.pullIfIdle());

    // The budget app's desktop shell keeps this page alive in a hidden frame
    // across screen changes, where visibilitychange never fires. It pokes us
    // when the user navigates back to the portfolio screen.
    window.addEventListener('message', (e) => {
      if (e.origin === location.origin && e.data?.type === 'ji:pull') this.pullIfIdle();
    });
  }

  async pullIfIdle() {
    if (!this.enabled || this._pushing || this._status === 'syncing') return;
    try {
      if (!this.token && !(await this._silentSignIn())) { this._setStatus('signed-out'); return; }
      this._setStatus('syncing');
      await this.pull();
      this._setStatus('idle');
    } catch (e) {
      this._setStatus('error', e.message);
    }
  }
}
