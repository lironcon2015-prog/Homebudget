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

// Exchange suffix worth guessing when a bare symbol isn't on Yahoo as-is.
// This app's users hold TASE + US securities; Yahoo's own search covers the
// rest, so guessing more suffixes only costs round-trips.
const SUFFIX_GUESSES = ['.TA'];

// Discovering an unknown symbol costs several round-trips. Cap the whole
// resolution chain for one ticker so a batch refresh can't outrun the UI's
// 45s hard timeout. Once resolved, the symbol is cached and the next refresh
// is a single call.
const RESOLVE_BUDGET_MS = 20000;

// Yahoo reports Tel Aviv prices in agorot under the ISO code "ILA".
// Only codes we can represent exactly are mapped; anything else (GBp pence,
// plain ILS, JPY…) is left undefined so the UI keeps its own inference rather
// than silently introducing a 100x error.
const CURRENCY_MAP = { ILA: 'ILS-Agorot', USD: 'USD', EUR: 'EUR', GBP: 'GBP' };

export function getWorkerUrl() {
  try { return (localStorage.getItem(WORKER_URL_KEY) || '').trim(); }
  catch { return ''; }
}

export function setWorkerUrl(url) {
  try {
    let cleaned = (url || '').trim();
    // Strip wrapping angle brackets / quotes / whitespace that users
    // commonly paste in (e.g. copying "<https://...>" from markdown).
    cleaned = cleaned.replace(/^[<"'\s]+/, '').replace(/[>"'\s]+$/, '').replace(/\/+$/, '');
    if (cleaned) localStorage.setItem(WORKER_URL_KEY, cleaned);
    else localStorage.removeItem(WORKER_URL_KEY);
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

export function resetProxyHealth() { proxyStrikes.clear(); }

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
  const workerUrl = getWorkerUrl();
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
    lines.push(`  ${where()}, ${getWorkerUrl() ? 'Worker מוגדר' : 'ללא Worker'}:`);
    for (const a of trace) lines.push(`    · ${a.id}: ${a.outcome}${a.ms != null ? ` (${a.ms}ms)` : ''}`);
    if (trace.every((a) => /נחסם/.test(a.outcome))) {
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

    const resolved = direct || await getForeignQuote(testTicker);
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

function extractIsraeliPrice(html) {
  if (!html) return null;
  // Only match keys/labels that explicitly mean "last/current" price.
  // Excludes BasePrice/PaperValue/Open/etc. — those are previous-day or
  // opening values and are a common false positive.
  const patterns = [
    // Bizportal (most reliable for tradedfund / ETF). Markup:
    //   <div class="top-rate-line" ...><div class="num">5,844</div>...
    /class="top-rate-line"[\s\S]{0,200}?class="num"[^>]*>\s*([\d.,]+)/i,
    // Funder mutual-fund JSON (buyPrice == sellPrice == daily NAV).
    /"buyPrice"\s*:\s*([\d.]+)/i,
    /"sellPrice"\s*:\s*([\d.]+)/i,
    // Funder explicit IDs (when present)
    /id="fundLastRate"[^>]*>\s*([\d.,]+)/i,
    /id="etfLastRate"[^>]*>\s*([\d.,]+)/i,
    /class="[^"]*(?:fund|etf)[-_]?last[-_]?rate[^"]*"[^>]*>\s*([\d.,]+)/i,
    /class="[^"]*last[-_]?(?:rate|price)[^"]*"[^>]*>\s*([\d.,]+)/i,
    /data-last-(?:rate|price)\s*=\s*"([\d.,]+)"/i,
    // Bizportal / Next.js JSON — last/current only
    /"(?:lastRate|last_rate|LastRate|lastPrice|last_price|LastPrice|LastTradeRate|LastTradePrice|currentPrice|CurrentPrice)"\s*:\s*"?([\d.]+)"?/i,
    // Hebrew "שער אחרון" / "שער נוכחי" near a number (and optional inner tag)
    /שער\s+אחרון[^0-9-]{0,80}<[^>]+>\s*([\d.,]+)/i,
    /שער\s+אחרון[^0-9-]{0,40}([0-9]{2,7}(?:[.,][0-9]{1,4})?)/i,
    /שער\s+נוכחי[^0-9-]{0,80}<[^>]+>\s*([\d.,]+)/i,
    /שער\s+נוכחי[^0-9-]{0,40}([0-9]{2,7}(?:[.,][0-9]{1,4})?)/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    const raw = parseFloat(m[1].replace(/,/g, ''));
    // Numeric Israeli tickers are stored with currency ILS-Agorot, so
    // the price is kept in agorot (e.g. 5844 = 58.44 NIS). Don't divide.
    if (!isNaN(raw) && raw > 0) return raw;
  }
  return null;
}

// For diagnostics: surface the first plausible price-looking number with
// ~60 chars of context on each side, so we can see what markup wraps it.
function priceContextSnippet(html) {
  if (!html) return '';
  const re = /[\s>"=]([0-9]{2,6}\.[0-9]{1,4})[\s<",]/;
  const m = html.match(re);
  if (!m) return '';
  const idx = html.indexOf(m[0]);
  const start = Math.max(0, idx - 60);
  const end = Math.min(html.length, idx + m[0].length + 60);
  const snippet = html.slice(start, end).replace(/\s+/g, ' ').trim();
  return ` | near "${snippet}"`;
}

// Fetch all Israeli candidate URLs in parallel and return per-URL results
// (url, htmlLength, price). Order preserved.
async function fetchIsraeliCandidates(rawId) {
  const padded = rawId.padStart(8, '0');
  // Order matters: getQuote returns the first source whose HTML yields a
  // price. Bizportal tradedfund is reliable for ETFs (top-rate-line
  // markup); Funder /fund is reliable for mutual funds (buyPrice JSON).
  // Trying Bizportal first prevents a Funder ETF's bid/ask spread (if
  // it ever appears as buyPrice) from beating Bizportal's last price.
  // These are all fund-and-ETF pages; an ordinary TASE share is on none of
  // them (Bizportal files shares under a per-sector path we can't guess).
  // Shares are covered by the Yahoo "<id>.TA" fallback in getIsraeliQuote.
  const urls = [
    'https://www.bizportal.co.il/tradedfund/quote/generalview/' + rawId,
    'https://www.bizportal.co.il/mutualfund/quote/generalview/' + rawId,
    'https://www.funder.co.il/fund/' + rawId,
    'https://www.funder.co.il/etf/' + rawId,
    'https://market.tase.co.il/he/market_data/security/' + padded + '/major_data',
  ];
  const tasks = urls.map(async (url) => {
    try {
      const html = await proxyFetch(url);
      const price = extractIsraeliPrice(html);
      const context = price == null ? priceContextSnippet(html) : '';
      return { url, html: html || '', htmlLength: html?.length ?? 0, price, context };
    } catch (e) {
      console.warn('[fetchIsraeliCandidates] failed', url, e.message);
      return { url, html: '', htmlLength: 0, price: null, context: '' };
    }
  });
  return Promise.all(tasks);
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

// One Yahoo chart lookup. Returns { price, currency, symbol } or null.
// Speculative candidates pass hosts=['query1'] — mirroring a guess across both
// Yahoo hosts doubles the round-trips without improving the odds.
async function yahooChart(symbol, hosts = ['query1', 'query2'], deadline) {
  for (const host of hosts) {
    if (deadline && Date.now() > deadline) return null;
    const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    try {
      const text = await proxyFetch(url, { deadline });
      if (!text) continue;
      const meta = JSON.parse(text)?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      if (typeof price === 'number' && price > 0) {
        return { price, currency: CURRENCY_MAP[meta.currency], symbol: meta.symbol || symbol };
      }
    } catch (e) { console.warn(`[QuoteFetcher] Yahoo chart failed ${symbol}:`, e.message); }
  }
  return null;
}

// Ask Yahoo's symbol lookup what "DLAS" actually is. Only candidates whose
// base symbol (the part before the exchange suffix) equals the typed ticker
// are accepted — a fuzzy *name* match must never end up pricing a different
// security than the one the user holds.
async function yahooSearch(ticker, deadline) {
  // Compare base symbol to base symbol. Taking the typed ticker whole meant a
  // user who entered an already-qualified symbol could never match: searching
  // "DLEKG.TA" returns the symbol DLEKG.TA, whose base is DLEKG, which is not
  // equal to the string "DLEKG.TA" — so every candidate was filtered out and
  // the security reported as missing from every source.
  const base = ticker.toUpperCase().split('.')[0];
  const url = 'https://query1.finance.yahoo.com/v1/finance/search'
    + `?q=${encodeURIComponent(ticker)}&quotesCount=10&newsCount=0&listsCount=0`;
  try {
    const text = await proxyFetch(url, { deadline });
    if (!text) return [];
    const quotes = JSON.parse(text)?.quotes || [];
    return quotes
      .filter((q) => q?.symbol && String(q.symbol).toUpperCase().split('.')[0] === base)
      .map((q) => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || '',
        exchange: q.exchDisp || q.exchange || '',
      }));
  } catch (e) {
    console.warn(`[QuoteFetcher] Yahoo search failed ${ticker}:`, e.message);
    return [];
  }
}

// Stooq CSV — an independent free source that covers a number of listings
// Yahoo is missing. Format: Symbol,Date,Time,Open,High,Low,Close,Volume
async function stooqQuote(ticker, deadline) {
  const base = ticker.toLowerCase();
  for (const s of [`${base}.us`, base]) {
    if (deadline && Date.now() > deadline) return null;
    try {
      const text = await proxyFetch(`https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`, { deadline });
      if (!text) continue;
      const row = text.trim().split('\n')[1];
      if (!row) continue;
      const close = parseFloat(row.split(',')[6]);
      if (!isNaN(close) && close > 0) return { price: close, currency: undefined, symbol: s.toUpperCase() };
    } catch (e) { console.warn(`[QuoteFetcher] Stooq failed ${s}:`, e.message); }
  }
  return null;
}

// Resolve + price a non-numeric ticker. Returns { price, currency, symbol,
// source } or null.
async function getForeignQuote(ticker) {
  const seen = new Set([ticker.toUpperCase()]);
  const known = [ticker];
  const push = (s) => { const u = (s || '').toUpperCase(); if (u && !seen.has(u)) seen.add(u); };
  const deadline = Date.now() + RESOLVE_BUDGET_MS;
  const outOfTime = () => Date.now() > deadline;

  // The literal spelling (and any symbol resolved on a previous run) is the
  // common path, so it goes first. It still carries the deadline: exempting it
  // was what let a single lookup run for over a minute — two hosts, each
  // walking five proxies at six seconds apiece, with the budget only consulted
  // once the phase was already over.
  for (const sym of known) {
    const hit = await yahooChart(sym, ['query1', 'query2'], deadline);
    if (hit) return { ...hit, source: 'yahoo' };
  }

  // Nothing under the literal spelling — ask Yahoo which symbol this is.
  if (!outOfTime()) {
    const matches = await yahooSearch(ticker, deadline);
    for (const m of matches) {
      if (seen.has(m.symbol.toUpperCase()) || outOfTime()) continue;
      push(m.symbol);
      const hit = await yahooChart(m.symbol, ['query1'], deadline);
      if (hit) {
        console.log(`[QuoteFetcher] resolved ${ticker} -> ${hit.symbol} (${m.exchange} ${m.name})`);
        return { ...hit, source: 'yahoo-search' };
      }
    }
  }

  // Search itself can come back empty behind a flaky proxy; guess the common
  // exchange suffix directly before giving up on Yahoo. Skipped when the user
  // already typed a qualified symbol — "DLEKG.TA" + ".TA" is not a ticker.
  if (!ticker.includes('.')) {
    for (const sfx of SUFFIX_GUESSES) {
      const sym = ticker.toUpperCase() + sfx;
      if (seen.has(sym) || outOfTime()) continue;
      push(sym);
      const hit = await yahooChart(sym, ['query1'], deadline);
      if (hit) {
        console.log(`[QuoteFetcher] resolved ${ticker} -> ${hit.symbol} by suffix guess`);
        return { ...hit, source: 'yahoo-suffix' };
      }
    }
  }

  if (!outOfTime()) {
    const stooq = await stooqQuote(ticker, deadline);
    if (stooq) return { ...stooq, source: 'stooq' };
  }

  return null;
}

// Price a numeric TASE security id. Returns { price, currency, symbol,
// source } or null.
async function getIsraeliQuote(rawId) {
  const results = await fetchIsraeliCandidates(rawId);
  for (const { url, price } of results) {
    if (price != null) return { price, currency: 'ILS-Agorot', symbol: rawId, source: url };
  }
  // Scraped pages can change markup or omit the security entirely; Yahoo
  // carries many TASE listings under "<id>.TA" and answers with clean JSON.
  const y = await yahooChart(`${rawId}.TA`, ['query1'], Date.now() + RESOLVE_BUDGET_MS);
  if (y) return { price: y.price, currency: y.currency || 'ILS-Agorot', symbol: y.symbol, source: 'yahoo' };
  return null;
}

// Full quote for one ticker: { price, currency, symbol, source } or null.
export async function getQuoteDetail(ticker) {
  // A previously discovered symbol stands in for the typed ticker, and may
  // route it to a different source family than the raw ticker would (a bare
  // ticker resolving to a numeric TASE id, say). Routing therefore happens on
  // the resolved symbol, not on what the user typed.
  const cached = getResolvedSymbol(ticker);
  const lookup = cached || ticker;
  const rawId = lookup.replace(/\.TA$/i, '');
  // Strip .TA before testing so "1150184.TA" routes to the Israeli sources too.
  const isNumericIsraeli = /^\d{6,7}$/.test(rawId);

  const hit = isNumericIsraeli ? await getIsraeliQuote(rawId) : await getForeignQuote(lookup);

  if (hit) {
    if (!cached) rememberSymbol(ticker, hit.symbol);
    console.log(`[QuoteFetcher] OK: ${ticker} = ${hit.price} via ${hit.source} (${hit.symbol})`);
  } else {
    console.warn(`[QuoteFetcher] no price found for ${ticker} (lookup: ${lookup})`);
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

// Batch wrapper used by the UI. Runs in parallel with a concurrency cap so the
// spinner can never hang for the sequential sum of all per-ticker timeouts.
// Returns { [ticker]: { price, currency, symbol, source } } for the tickers
// that resolved; missing keys mean no source had a price.
export async function fetchQuotes(tickers, { onProgress } = {}) {
  const results = {};
  let done = 0;
  await runWithConcurrency(tickers, MAX_PARALLEL, async (ticker) => {
    const hit = await getQuoteDetail(ticker);
    if (hit) results[ticker] = hit;
    done++;
    if (onProgress) onProgress({ done, total: tickers.length, ticker, ok: !!hit });
  });
  return results;
}
