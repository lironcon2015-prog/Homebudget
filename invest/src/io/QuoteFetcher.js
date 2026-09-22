import {
  RESOLVE_BUDGET_MS,
  israeliCandidateUrls, extractIsraeliPrice, priceContextSnippet,
  yahooChartUrl, parseYahooChart, yahooSearchUrl, parseYahooSearch,
  resolveQuote,
} from './quoteSources.js';

const TIMEOUT_MS = 6000;
// The user's own worker fetches the upstream page server-side, and the Israeli
// scrape targets are slow to render. Six seconds was cutting off responses that
// were simply on their way, which reads as "no source has this price".
const WORKER_TIMEOUT_MS = 12000;
// Public fallback proxies get a much tighter budget: they are the slow path,
// and four of them at the worker's timeout is most of a minute spent proving
// they are still down.
const PUBLIC_TIMEOUT_MS = 3500;
const MAX_PARALLEL = 5;
const WORKER_URL_KEY = 'juniorinvest:quoteProxy';
const SYMBOL_MAP_KEY = 'juniorinvest:symbolMap';

// Built-in worker addresses, tried in order when the user has not set one.
// The custom domain comes first on purpose: `*.workers.dev` is blocked by some
// mobile carriers, DNS filters and ad blockers — it is a heavily abused
// hostname — and that failure is indistinguishable from a broken worker. The
// workers.dev address stays as a second candidate so an install that predates
// the domain keeps working without anyone touching a setting.
const DEFAULT_WORKER_URLS = [
  'https://quotes.lironcon.com',
  'https://juniorinvest-quotes.lironcon.workers.dev',
];

// The batch endpoint's own budget. It prices every holding server-side in one
// request, so it is allowed longer than a single proxied page — but it must
// still land well inside the UI's hard timeout.
const BATCH_TIMEOUT_MS = 25000;

export function getWorkerUrl() {
  try { return (localStorage.getItem(WORKER_URL_KEY) || '').trim(); }
  catch { return ''; }
}

// Every worker address worth trying, best first. An explicit setting always
// wins; the built-ins follow it rather than replacing it, so a user who
// configured their own worker keeps it and a user who never configured one
// does not have to.
function workerCandidates() {
  const set = getWorkerUrl();
  return set ? [set, ...DEFAULT_WORKER_URLS.filter((u) => u !== set)] : [...DEFAULT_WORKER_URLS];
}

let workerPick = null;   // Promise<string> — resolved once per page load

/**
 * Which worker address actually answers.
 *
 * Trying the candidates in order costs the full worker timeout on EVERY lookup
 * whenever the first one is the dead one, which is the exact failure this is
 * here to end: one unreachable address ahead of a working one turned every
 * refresh into a minute of waiting. So they race a liveness ping instead — a
 * GET with no ?url=, which every deployed version refuses with an immediate
 * 400 without touching any upstream. First to answer wins and is used for the
 * rest of the session; if none answers we keep the first candidate, so the
 * behaviour with no worker at all is unchanged.
 */
function activeWorker() {
  if (!workerPick) {
    const cands = workerCandidates();
    workerPick = cands.length <= 1
      ? Promise.resolve(cands[0] || '')
      : Promise.any(cands.map(async (u) => {
          await fetchWithTimeout(`${u}/?_=${Date.now()}`, PUBLIC_TIMEOUT_MS);
          return u;
        })).catch(() => cands[0]);
  }
  return workerPick;
}

export function setWorkerUrl(url) {
  try {
    let cleaned = (url || '').trim();
    // Strip wrapping angle brackets / quotes / whitespace that users
    // commonly paste in (e.g. copying "<https://...>" from markdown).
    cleaned = cleaned.replace(/^[<"'\s]+/, '').replace(/[>"'\s]+$/, '').replace(/\/+$/, '');
    if (cleaned) localStorage.setItem(WORKER_URL_KEY, cleaned);
    else localStorage.removeItem(WORKER_URL_KEY);
    workerPick = null;   // a new address deserves a fresh race
  } catch {}
}

function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

// Consecutive failures per PUBLIC proxy, for the lifetime of the page. A dead
// one used to cost its full timeout on EVERY lookup: the first ticker
// discovered it was down and the next twenty rediscovered it. Two strikes and
// it sits out the rest of the session; any success clears its record.
//
// The user's own worker is never benched, whatever it does. It is the primary
// and usually the ONLY source that works — the public proxies are a courtesy
// for people who never deployed one. Benching it turned a slow worker into no
// worker at all: fetchIsraeliCandidates fires five requests in parallel, so a
// single slow page timed out all five at once and disabled the worker for the
// session, after which every lookup reported "no source has this".
const proxyStrikes = new Map();
const PROXY_STRIKE_LIMIT = 2;
const UNBENCHABLE = new Set(['worker']);

const benched = (id) => (proxyStrikes.get(id) || 0) >= PROXY_STRIKE_LIMIT;
// A timeout benches a public proxy on its own: one that never answers is
// unreachable, and making the next ticker prove that again costs a whole
// budget. An HTTP error is weaker evidence — a single 500 or a rate-limit
// should not disable a proxy that otherwise works — so it takes two.
const strike = (id, weight = 1) => {
  if (UNBENCHABLE.has(id)) return;
  proxyStrikes.set(id, (proxyStrikes.get(id) || 0) + weight);
};
const absolve = (id) => proxyStrikes.delete(id);

export function resetProxyHealth() { proxyStrikes.clear(); workerPick = null; }

/**
 * @param {string} targetUrl
 * @param {{deadline?: number, trace?: Array}} opts
 *        deadline — absolute Date.now() cut-off. Attempts stop once it passes
 *        and each timeout is clamped to what remains, which is what makes a
 *        caller's budget an actual bound instead of something checked between
 *        phases while one phase runs for a minute.
 *        trace — collects one entry per attempt for the settings diagnostic.
 *        "No price found" has many causes that look identical from the outside
 *        (blocked request, 403 from the proxy, upstream returning an empty
 *        body) and the report was naming none of them.
 */
export async function proxyFetch(targetUrl, { deadline, trace } = {}) {
  const workerUrl = await activeWorker();
  const attempts = [];
  if (workerUrl) {
    // Cache-bust so a stale Cloudflare edge response doesn't poison future calls.
    const bust = '&_=' + Date.now();
    attempts.push({ id: 'worker', url: workerUrl + '/?url=' + encodeURIComponent(targetUrl) + bust, json: false, ms: WORKER_TIMEOUT_MS });
  }
  // Public proxies exist for users who have not deployed a worker. They are
  // slower and far less reliable, so they get a shorter leash than the worker.
  attempts.push(
    { id: 'codetabs', url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(targetUrl), json: false, ms: PUBLIC_TIMEOUT_MS },
    { id: 'allorigins-raw', url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(targetUrl), json: false, ms: PUBLIC_TIMEOUT_MS },
    { id: 'allorigins-get', url: 'https://api.allorigins.win/get?url=' + encodeURIComponent(targetUrl), json: true, ms: PUBLIC_TIMEOUT_MS },
    { id: 'corsproxy', url: 'https://corsproxy.io/?url=' + encodeURIComponent(targetUrl), json: false, ms: PUBLIC_TIMEOUT_MS },
  );

  for (const { id, url, json, ms } of attempts) {
    if (benched(id)) { trace?.push({ id, outcome: 'skipped (מנוטרל)' }); continue; }
    const left = deadline ? deadline - Date.now() : Infinity;
    if (left <= 0) { console.warn('[proxyFetch] out of budget before', id); trace?.push({ id, outcome: 'לא נוסה — נגמר הזמן' }); break; }
    const t0 = Date.now();
    try {
      const res = await fetchWithTimeout(url, Math.min(ms, left));
      if (!res.ok) {
        console.warn('[proxyFetch] HTTP', res.status, url);
        trace?.push({ id, outcome: `HTTP ${res.status}`, ms: Date.now() - t0 });
        strike(id); continue;
      }
      const raw = await res.text();
      const text = json ? (JSON.parse(raw).contents ?? raw) : raw;
      if (text && text.length > 50) {
        trace?.push({ id, outcome: `ok, ${text.length}B`, ms: Date.now() - t0 });
        absolve(id); return text;
      }
      console.warn('[proxyFetch] short body', text?.length, url);
      trace?.push({ id, outcome: `גוף ריק (${text?.length ?? 0}B)`, ms: Date.now() - t0 });
      // A short body is the upstream saying "no data", not this proxy failing.
      // Benching it over that would disable a route that works.
      absolve(id);
    } catch (e) {
      trace?.push({
        id,
        // An AbortError is our own timeout; anything else is the browser
        // refusing to make the request at all — an extension, a tracking
        // blocker, or a CORS rejection. Naming which one is the whole point.
        outcome: e?.name === 'AbortError' ? `timeout אחרי ${Math.min(ms, left)}ms` : `נחסם/שגיאת רשת (${e?.name || 'Error'})`,
        ms: Date.now() - t0,
      });
      console.warn('[proxyFetch] err', e.name, e.message, url);
      strike(id, e?.name === 'AbortError' ? PROXY_STRIKE_LIMIT : 1);
    }
  }
  return null;
}

// Did the worker answer at all? Two different failures hide behind one
// "timeout": a worker that is not deployed (or that this network cannot
// reach) and a worker that IS running but is stuck waiting on a quote source
// that accepted the connection and never answered. They have opposite fixes,
// so the probe asks the worker something it can answer without touching any
// upstream — a request with no ?url=, which every deployed version of
// quote-proxy.js refuses with an immediate 400.
//
// The no-cors retry covers the third case: a cors fetch throws the same
// TypeError whether nothing answered or something answered without the headers
// that let us read it. An opaque response proves the server did answer — which
// is what a Cloudflare error page looks like from here.
//
// Used only by the diagnostic: it costs an extra request and tells a
// successful lookup nothing.
async function workerLiveness(workerUrl) {
  if (!workerUrl) return 'unknown';
  const ping = () => `${workerUrl}/?_=${Date.now()}`;
  try {
    await fetchWithTimeout(ping(), PUBLIC_TIMEOUT_MS);
    return 'alive';   // any readable status, 400 included, means it ran
  } catch (e) {
    if (e?.name === 'AbortError') return 'dead';
    try { await fetch(ping(), { mode: 'no-cors' }); return 'opaque'; }
    catch { return 'dead'; }
  }
}

// Whether this ran standalone or inside the budget app's frame. The two
// differ in ways that matter to a network request — a framed page is a
// third-party context to content blockers — so a report that does not say
// which one it came from cannot be compared against the other.
function where() {
  try { return window.top !== window.self ? 'בתוך אפליקציית הכספים' : 'חלון עצמאי'; }
  catch { return 'בתוך מסגרת' ; }
}

// Diagnostic for the settings "בדוק טיקר" button. Returns a human-readable
// report: numeric Israeli IDs list every source tried, alphabetic tickers show
// the full Yahoo symbol-resolution chain.
// Runs even without a Worker URL — proxyFetch falls back to public proxies.
export async function testWorker(testTicker = 'AAPL') {
  const isNumericIsraeli = /^\d{6,7}$/.test(testTicker);
  const t0 = Date.now();
  try {
    if (isNumericIsraeli) {
      const results = await fetchIsraeliCandidates(testTicker);
      const ms = Date.now() - t0;
      const winner = results.find((r) => r.price != null);
      const lines = results.map((r) => {
        const star = r === winner ? '★ ' : '  ';
        const value = r.price != null ? `price=${r.price}` : `no price${r.context || ''}`;
        return `${star}${shortUrl(r.url)}: ${r.htmlLength}B, ${value}`;
      });
      const header = winner
        ? `✓ ${testTicker}=${winner.price} (${ms}ms)`
        : `אין מחיר ב-${results.length} מקורות (${ms}ms)`;
      return { ok: !!winner, msg: header + ':\n' + lines.join('\n') };
    }
    if (/^\d{6,7}=\d/.test(testTicker)) {
      const [t, exp] = testTicker.split('=');
      const results = await fetchIsraeliCandidates(t);
      const ms = Date.now() - t0;
      const lines = results.map((r) => `${shortUrl(r.url)}:\n` + findExpectedContexts(r.html, exp));
      return { ok: true, msg: `חיפוש "${exp}" עבור ${t} (${ms}ms):\n\n` + lines.join('\n\n') };
    }
    // Alphabetic ticker: report the whole resolution chain, so a symbol that
    // Yahoo spells differently (DLAS -> DLAS.TA) is visible rather than just
    // "failed".
    const lines = [];
    // The diagnostic is bounded like a real lookup — an unbounded one used to
    // sit for over a minute, which is its own bug report.
    const probeDeadline = Date.now() + RESOLVE_BUDGET_MS;

    // Probe the transport directly, before any Yahoo parsing, and report every
    // attempt. "No data in Yahoo" was covering for causes that have nothing to
    // do with Yahoo — a request the browser never made, a 403 from the proxy,
    // an empty body — and they need telling apart.
    const trace = [];
    await proxyFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(testTicker)}`,
      { deadline: probeDeadline, trace });
    // Print the worker host, not just "configured". A typo in it fails exactly
    // like a blocked request, and the settings field truncates the URL — so the
    // one string that explains the failure was the one nowhere on screen.
    // The worker actually in use, which is not always the configured one: an
    // empty setting falls back to the built-in addresses, and a configured one
    // that never answers loses the race to a built-in that does. Printing the
    // setting instead of the winner made the report disagree with the request.
    const wUrl = await activeWorker();
    const setUrl = getWorkerUrl();
    lines.push(`  ${where()}, ${wUrl ? `Worker: ${wUrl}${setUrl && setUrl !== wUrl ? ` (מוגדר: ${setUrl})` : ''}` : 'ללא Worker'}`);
    for (const a of trace) lines.push(`    · ${a.id}: ${a.outcome}${a.ms != null ? ` (${a.ms}ms)` : ''}`);

    const workerAttempt = trace.find((a) => a.id === 'worker');
    const reachedNetwork = trace.some((a) => /HTTP|timeout|ok,|גוף ריק/.test(a.outcome));
    // A timeout is diagnosed the same way as a blocked request, and for the
    // same reason: on its own it names no cause. It is also the failure that
    // costs the most — the worker holds the whole budget before anything else
    // is tried — so leaving it unexplained was leaving the common case unexplained.
    if (workerAttempt && /נחסם|timeout/.test(workerAttempt.outcome)) {
      const reach = await workerLiveness(wUrl);
      lines.push(
        reach === 'alive'
          ? '    ⚠ ה-Worker עצמו עונה מיד לבקשת בדיקה — מה שנתקע הוא מקור השערים שהוא פונה אליו. גרסה עדכנית של worker/quote-proxy.js מחזירה 504 עם שם המקור במקום להיתקע; פרוס אותה מחדש כדי לראות במי מדובר.'
        : reach === 'opaque'
          ? '    ⚠ ה-Worker כן עונה, אבל התשובה נדחית ע"י הדפדפן — כותרות CORS חסרות. סימן מובהק לשגיאה בתוך ה-Worker (דף שגיאה של Cloudflare לא נושא אותן).'
        : reach === 'dead'
          ? '    ⚠ ה-Worker לא עונה בכלל, גם לבקשת בדיקה ריקה שאינה נוגעת בשום מקור — כתובת שגויה, Worker שאינו פרוס, או חסימה של ‎*.workers.dev‎ ברשת הזו. בדוק את אותו מסך ברשת אחרת (סלולר מול Wi-Fi).'
          : reachedNetwork
            ? '    ⚠ רק ה-Worker נכשל, בעוד מקורות אחרים הגיעו לרשת'
            : '    ⚠ אף בקשה לא יצאה — חוסם פרסומות/הרחבה או הגנת מעקב',
      );
    } else if (trace.length && trace.every((a) => /נחסם/.test(a.outcome))) {
      lines.push('    ⚠ כל הבקשות נחסמו לפני שיצאו — חוסם פרסומות/הרחבה או הגנת מעקב');
    }

    const direct = await yahooChart(testTicker, ['query1', 'query2'], probeDeadline);
    lines.push(direct
      ? `  ✓ ${testTicker} (ישיר): ${direct.price} ${direct.currency || ''}`
      : `  ✗ ${testTicker} (ישיר): אין נתונים ב-Yahoo`);

    const matches = await yahooSearch(testTicker, probeDeadline);
    if (matches.length) {
      lines.push(`  חיפוש Yahoo מצא ${matches.length} התאמות:`);
      for (const m of matches) lines.push(`    · ${m.symbol} — ${m.name} (${m.exchange})`);
    } else {
      lines.push('  חיפוש Yahoo: אין התאמה לסימול הזה');
    }

    const resolved = direct || await getQuoteDetail(testTicker);
    const ms = Date.now() - t0;
    if (resolved) {
      const via = resolved.symbol !== testTicker.toUpperCase() ? ` (סימול בפועל: ${resolved.symbol})` : '';
      return {
        ok: true,
        msg: `✓ ${testTicker}=${resolved.price}${via} מקור: ${resolved.source} (${ms}ms)\n` + lines.join('\n'),
      };
    }
    return {
      ok: false,
      msg: `אין מחיר עבור ${testTicker} באף מקור (${ms}ms):\n` + lines.join('\n')
        + '\n  נסה את הסימול המלא של הבורסה, למשל DLAS.TA',
    };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, msg: `${e.name} (${ms}ms): ${e.message}` };
  }
}

function shortUrl(u) {
  try { const p = new URL(u); return p.hostname.replace(/^www\./, '') + p.pathname; }
  catch { return u; }
}

// Given an HTML blob and an expected price (e.g. "5844"), find up to 3
// occurrences of common formattings (5844 / 5,844 / 58.44 / 58,44 / 5844.0)
// and return each with ~80 chars of surrounding context.
function findExpectedContexts(html, expected) {
  if (!html || !expected) return '  (אין HTML)';
  const variants = new Set([expected]);
  const n = Number(expected);
  if (!isNaN(n)) {
    variants.add(String(n));
    variants.add(n.toLocaleString('en-US'));      // 5,844
    variants.add((n / 100).toFixed(2));           // 58.44
    variants.add((n / 100).toFixed(2).replace('.', ',')); // 58,44
    variants.add(n.toFixed(1));                   // 5844.0
  }
  const matches = [];
  for (const v of variants) {
    let idx = 0;
    while ((idx = html.indexOf(v, idx)) !== -1 && matches.length < 8) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(html.length, idx + v.length + 80);
      const snippet = html.slice(start, end).replace(/\s+/g, ' ').trim();
      matches.push(`  [${v}] …${snippet}…`);
      idx += v.length;
    }
  }
  return matches.length ? matches.slice(0, 3).join('\n') : `  (לא נמצא "${expected}" בשום וריאציה)`;
}

// Fetch all Israeli candidate URLs in parallel and return per-URL results
// (url, htmlLength, price). Order preserved. Used only by the diagnostic —
// a real lookup goes through resolveQuote, which walks the same sources and
// stops at the first price instead of collecting all five.
async function fetchIsraeliCandidates(rawId) {
  return Promise.all(israeliCandidateUrls(rawId).map(async (url) => {
    try {
      const html = await proxyFetch(url);
      const price = extractIsraeliPrice(html);
      return {
        url, html: html || '', htmlLength: html?.length ?? 0, price,
        context: price == null ? priceContextSnippet(html) : '',
      };
    } catch (e) {
      console.warn('[fetchIsraeliCandidates] failed', url, e.message);
      return { url, html: '', htmlLength: 0, price: null, context: '' };
    }
  }));
}

// ---------------------------------------------------------------------------
// Symbol resolution
//
// Yahoo only answers for its *own* symbol spelling: a Tel Aviv security is
// "DLAS.TA", not "DLAS", and a listing Yahoo doesn't carry at all never
// resolves. A ticker the user copied from Investing.com therefore silently
// returns nothing. We resolve the typed ticker to a real Yahoo symbol once,
// remember it, and fall back to a second data source when Yahoo has no match.
// ---------------------------------------------------------------------------

function loadSymbolMap() {
  try { return JSON.parse(localStorage.getItem(SYMBOL_MAP_KEY) || '{}'); }
  catch { return {}; }
}

// The Yahoo symbol previously discovered for a user-typed ticker, if any.
export function getResolvedSymbol(ticker) {
  return loadSymbolMap()[ticker.toUpperCase()] || '';
}

function rememberSymbol(ticker, symbol) {
  const key = ticker.toUpperCase();
  if (!symbol || symbol === key) return;
  try {
    const map = loadSymbolMap();
    map[key] = symbol;
    localStorage.setItem(SYMBOL_MAP_KEY, JSON.stringify(map));
  } catch {}
}

export function clearSymbolCache() {
  try { localStorage.removeItem(SYMBOL_MAP_KEY); } catch {}
}

// One Yahoo chart lookup, for the diagnostic's "direct" line.
async function yahooChart(symbol, hosts = ['query1', 'query2'], deadline) {
  for (const host of hosts) {
    if (deadline && Date.now() > deadline) return null;
    try {
      const hit = parseYahooChart(await proxyFetch(yahooChartUrl(host, symbol), { deadline }), symbol);
      if (hit) return hit;
    } catch (e) { console.warn(`[QuoteFetcher] Yahoo chart failed ${symbol}:`, e.message); }
  }
  return null;
}

// Ask Yahoo's symbol lookup what "DLAS" actually is, for the diagnostic.
async function yahooSearch(ticker, deadline) {
  try { return parseYahooSearch(await proxyFetch(yahooSearchUrl(ticker), { deadline }), ticker); }
  catch (e) { console.warn(`[QuoteFetcher] Yahoo search failed ${ticker}:`, e.message); return []; }
}

// Full quote for one ticker, fetched through the proxy chain from this
// device: { price, currency, symbol, source } or null. This is the fallback
// path — a refresh asks the worker's batch endpoint first (see fetchQuotes)
// and only lands here for tickers it did not answer for.
export async function getQuoteDetail(ticker) {
  const cached = getResolvedSymbol(ticker);
  const hit = await resolveQuote(ticker, {
    fetchText: (url) => proxyFetch(url),
    deadline: Date.now() + RESOLVE_BUDGET_MS,
    resolvedSymbol: cached,
    log: (m) => console.log('[QuoteFetcher]', m),
  });

  if (hit) {
    if (!cached) rememberSymbol(ticker, hit.symbol);
    console.log(`[QuoteFetcher] OK: ${ticker} = ${hit.price} via ${hit.source} (${hit.symbol})`);
  } else {
    console.warn(`[QuoteFetcher] no price found for ${ticker} (lookup: ${cached || ticker})`);
  }
  return hit;
}

export async function getQuote(ticker) {
  const hit = await getQuoteDetail(ticker);
  return hit ? hit.price : null;
}

// Run async tasks in parallel with a concurrency cap.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

// Whether this session's worker knows /quotes. A deployment older than that
// endpoint does not, and asking it again on every refresh is a wasted
// round-trip per refresh.
let batchSupported = null;

/**
 * Ask the worker to price the whole list in one request.
 *
 * This is the path that makes a refresh reliable. The scraping, the fallbacks
 * and the retries all happen inside Cloudflare — fast, predictable egress —
 * instead of across a phone's cellular connection, and the worker's cache
 * means one upstream fetch serves every device and every reload. What reaches
 * the client is one request with one failure mode, in place of five candidate
 * URLs per holding each walking up to five proxies.
 *
 * Returns the tickers it answered for; anything missing falls through to the
 * per-ticker path. A worker that does not know the endpoint answers the old
 * `missing ?url=` 400, which is how we detect it — and then stop asking.
 */
async function fetchQuotesBatch(tickers) {
  const base = await activeWorker();
  if (!base || batchSupported === false || !tickers.length) return null;
  try {
    const res = await fetchWithTimeout(
      `${base}/quotes?ids=${encodeURIComponent(tickers.join(','))}&_=${Date.now()}`,
      BATCH_TIMEOUT_MS,
    );
    if (res.status === 400 || res.status === 404) {
      console.warn('[QuoteFetcher] worker has no /quotes endpoint — using the per-ticker path');
      batchSupported = false;
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    const quotes = data?.quotes;
    if (!quotes || typeof quotes !== 'object') return null;
    batchSupported = true;
    return quotes;
  } catch (e) {
    console.warn('[QuoteFetcher] batch endpoint failed:', e.message);
    return null;
  }
}

// Batch wrapper used by the UI. The worker prices what it can in one request;
// whatever it did not answer for is fetched from here, in parallel with a
// concurrency cap so the spinner can never hang for the sequential sum of all
// per-ticker timeouts. Returns { [ticker]: { price, currency, symbol, source } }
// for the tickers that resolved; missing keys mean no source had a price.
export async function fetchQuotes(tickers, { onProgress } = {}) {
  const results = {};
  let done = 0;
  const report = (ticker, ok) => { done++; onProgress?.({ done, total: tickers.length, ticker, ok }); };

  const batch = await fetchQuotesBatch(tickers);
  const remaining = [];
  for (const ticker of tickers) {
    const hit = batch?.[ticker];
    if (hit && typeof hit.price === 'number' && hit.price > 0) { results[ticker] = hit; report(ticker, true); }
    else remaining.push(ticker);
  }

  await runWithConcurrency(remaining, MAX_PARALLEL, async (ticker) => {
    const hit = await getQuoteDetail(ticker);
    if (hit) results[ticker] = hit;
    report(ticker, !!hit);
  });
  return results;
}
