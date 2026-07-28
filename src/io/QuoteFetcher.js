const TIMEOUT_MS = 6000;
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

async function proxyFetch(targetUrl) {
  const workerUrl = getWorkerUrl();
  const attempts = [];
  if (workerUrl) {
    // Cache-bust so a stale Cloudflare edge response doesn't poison future calls.
    const bust = '&_=' + Date.now();
    attempts.push({ url: workerUrl + '/?url=' + encodeURIComponent(targetUrl) + bust, json: false });
  }
  attempts.push(
    { url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(targetUrl), json: false },
    { url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(targetUrl), json: false },
    { url: 'https://api.allorigins.win/get?url=' + encodeURIComponent(targetUrl), json: true },
    { url: 'https://corsproxy.io/?url=' + encodeURIComponent(targetUrl), json: false },
  );
  for (const { url, json } of attempts) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) { console.warn('[proxyFetch] HTTP', res.status, url); continue; }
      const raw = await res.text();
      const text = json ? (JSON.parse(raw).contents ?? raw) : raw;
      if (text && text.length > 50) return text;
      console.warn('[proxyFetch] short body', text?.length, url);
    } catch (e) { console.warn('[proxyFetch] err', e.name, e.message, url); }
  }
  return null;
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
    const direct = await yahooChart(testTicker);
    lines.push(direct
      ? `  ✓ ${testTicker} (ישיר): ${direct.price} ${direct.currency || ''}`
      : `  ✗ ${testTicker} (ישיר): אין נתונים ב-Yahoo`);

    const matches = await yahooSearch(testTicker);
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
async function yahooChart(symbol, hosts = ['query1', 'query2']) {
  for (const host of hosts) {
    const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    try {
      const text = await proxyFetch(url);
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
async function yahooSearch(ticker) {
  const base = ticker.toUpperCase();
  const url = 'https://query1.finance.yahoo.com/v1/finance/search'
    + `?q=${encodeURIComponent(ticker)}&quotesCount=10&newsCount=0&listsCount=0`;
  try {
    const text = await proxyFetch(url);
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
async function stooqQuote(ticker) {
  const base = ticker.toLowerCase();
  for (const s of [`${base}.us`, base]) {
    try {
      const text = await proxyFetch(`https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`);
      if (!text) continue;
      const row = text.trim().split('\n')[1];
      if (!row) continue;
      const close = parseFloat(row.split(',')[6]);
      if (!isNaN(close) && close > 0) return { price: close, currency: undefined, symbol: s.toUpperCase() };
    } catch (e) { console.warn(`[QuoteFetcher] Stooq failed ${s}:`, e.message); }
  }
  return null;
}

// Ordered list of Yahoo symbols to try for a typed ticker, cheapest first.
async function yahooCandidates(ticker) {
  const seen = new Set();
  const out = [];
  const push = (s) => { const u = (s || '').toUpperCase(); if (u && !seen.has(u)) { seen.add(u); out.push(s); } };
  push(getResolvedSymbol(ticker));   // previously resolved — usually a direct hit
  push(ticker);
  return { known: out, push, seen };
}

// Resolve + price a non-numeric ticker. Returns { price, currency, symbol,
// source } or null.
async function getForeignQuote(ticker) {
  const { known, push, seen } = await yahooCandidates(ticker);
  const deadline = Date.now() + RESOLVE_BUDGET_MS;
  const outOfTime = () => Date.now() > deadline;

  // The literal spelling (and any symbol we resolved on a previous run) is
  // tried first and is never skipped for budget — this is the common path.
  for (const sym of known) {
    const hit = await yahooChart(sym);
    if (hit) return { ...hit, source: 'yahoo' };
  }

  // Nothing under the literal spelling — ask Yahoo which symbol this is.
  if (!outOfTime()) {
    const matches = await yahooSearch(ticker);
    for (const m of matches) {
      if (seen.has(m.symbol.toUpperCase()) || outOfTime()) continue;
      push(m.symbol);
      const hit = await yahooChart(m.symbol, ['query1']);
      if (hit) {
        console.log(`[QuoteFetcher] resolved ${ticker} -> ${hit.symbol} (${m.exchange} ${m.name})`);
        return { ...hit, source: 'yahoo-search' };
      }
    }
  }

  // Search itself can come back empty behind a flaky proxy; guess the common
  // exchange suffix directly before giving up on Yahoo.
  for (const sfx of SUFFIX_GUESSES) {
    const sym = ticker.toUpperCase() + sfx;
    if (seen.has(sym) || outOfTime()) continue;
    push(sym);
    const hit = await yahooChart(sym, ['query1']);
    if (hit) {
      console.log(`[QuoteFetcher] resolved ${ticker} -> ${hit.symbol} by suffix guess`);
      return { ...hit, source: 'yahoo-suffix' };
    }
  }

  if (!outOfTime()) {
    const stooq = await stooqQuote(ticker);
    if (stooq) return { ...stooq, source: 'stooq' };
  }

  return null;
}

// Full quote for one ticker: { price, currency, symbol, source } or null.
export async function getQuoteDetail(ticker) {
  const rawId = ticker.replace(/\.TA$/i, '');
  // Strip .TA before testing so "1150184.TA" routes to the Israeli sources too.
  const isNumericIsraeli = /^\d{6,7}$/.test(rawId);

  if (isNumericIsraeli) {
    const results = await fetchIsraeliCandidates(rawId);
    for (const { url, price } of results) {
      if (price != null) {
        console.log(`[QuoteFetcher] OK: ${ticker} = ${price} via ${url}`);
        return { price, currency: 'ILS-Agorot', symbol: rawId, source: url };
      }
    }
    return null;
  }

  const hit = await getForeignQuote(ticker);
  if (hit) {
    rememberSymbol(ticker, hit.symbol);
    console.log(`[QuoteFetcher] OK: ${ticker} = ${hit.price} via ${hit.source} (${hit.symbol})`);
  } else {
    console.warn(`[QuoteFetcher] no price found for ${ticker}`);
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
