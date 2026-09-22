// src/io/quoteSources.js
//
// Where a price comes from and how to read it — with no opinion about who does
// the fetching. Pure: no DOM, no localStorage, no network of its own. Every
// entry point takes a `fetchText(url) => Promise<string|null>` and respects a
// caller-supplied deadline.
//
// This module exists because the same logic runs in two places. The browser
// runs it when it reaches the sources through a CORS proxy; the Cloudflare
// worker runs it when it does the same job server-side for a whole batch at
// once. Two hand-written copies is how the markup patterns drift apart in
// exactly the way that makes a price wrong rather than missing, so the worker
// is BUILT from this file (`tools/build-worker.js`) instead of repeating it.

// Yahoo reports Tel Aviv prices in agorot under the ISO code "ILA".
// Only codes we can represent exactly are mapped; anything else (GBp pence,
// plain ILS, JPY…) is left undefined so the UI keeps its own inference rather
// than silently introducing a 100x error.
export const CURRENCY_MAP = { ILA: 'ILS-Agorot', USD: 'USD', EUR: 'EUR', GBP: 'GBP' };

// Exchange suffix worth guessing when a bare symbol isn't on Yahoo as-is.
// This app's users hold TASE + US securities; Yahoo's own search covers the
// rest, so guessing more suffixes only costs round-trips.
export const SUFFIX_GUESSES = ['.TA'];

// Cap the whole resolution chain for one ticker. Discovering an unknown symbol
// costs several round-trips, and a batch refresh must not outrun the UI's own
// hard timeout. Once resolved, the symbol is remembered and the next refresh
// is a single call.
export const RESOLVE_BUDGET_MS = 20000;

/** Is this the numeric id of a TASE security rather than a ticker symbol? */
export const isNumericIsraeli = (s) => /^\d{6,7}$/.test(s);

// Order matters: the first source whose HTML yields a price wins. Bizportal
// tradedfund is reliable for ETFs (top-rate-line markup); Funder /fund is
// reliable for mutual funds (buyPrice JSON). Trying Bizportal first prevents a
// Funder ETF's bid/ask spread (if it ever appears as buyPrice) from beating
// Bizportal's last price. These are all fund-and-ETF pages; an ordinary TASE
// share is on none of them (Bizportal files shares under a per-sector path we
// cannot guess) and is covered by the Yahoo "<id>.TA" fallback below.
export function israeliCandidateUrls(rawId) {
  const padded = String(rawId).padStart(8, '0');
  return [
    'https://www.bizportal.co.il/tradedfund/quote/generalview/' + rawId,
    'https://www.bizportal.co.il/mutualfund/quote/generalview/' + rawId,
    'https://www.funder.co.il/fund/' + rawId,
    'https://www.funder.co.il/etf/' + rawId,
    'https://market.tase.co.il/he/market_data/security/' + padded + '/major_data',
  ];
}

export function extractIsraeliPrice(html) {
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
export function priceContextSnippet(html) {
  if (!html) return '';
  const re = /[\s>"=]([0-9]{2,6}\.[0-9]{1,4})[\s<",]/;
  const m = html.match(re);
  if (!m) return '';
  const idx = html.indexOf(m[0]);
  const start = Math.max(0, idx - 60);
  const end = Math.min(html.length, idx + m[0].length + 60);
  return ` | near "${html.slice(start, end).replace(/\s+/g, ' ').trim()}"`;
}

export const yahooChartUrl = (host, symbol) =>
  `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;

export function parseYahooChart(text, fallbackSymbol) {
  if (!text) return null;
  const meta = JSON.parse(text)?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== 'number' || !(price > 0)) return null;
  return { price, currency: CURRENCY_MAP[meta.currency], symbol: meta.symbol || fallbackSymbol };
}

export const yahooSearchUrl = (ticker) =>
  'https://query1.finance.yahoo.com/v1/finance/search'
  + `?q=${encodeURIComponent(ticker)}&quotesCount=10&newsCount=0&listsCount=0`;

// Only candidates whose base symbol (the part before the exchange suffix)
// equals the typed ticker are accepted — a fuzzy *name* match must never end
// up pricing a different security than the one the user holds.
//
// Base is compared to base. Taking the typed ticker whole meant a user who
// entered an already-qualified symbol could never match: searching "DLEKG.TA"
// returns the symbol DLEKG.TA, whose base is DLEKG, which is not equal to the
// string "DLEKG.TA" — so every candidate was filtered out and the security
// reported as missing from every source.
export function parseYahooSearch(text, ticker) {
  if (!text) return [];
  const base = ticker.toUpperCase().split('.')[0];
  const quotes = JSON.parse(text)?.quotes || [];
  return quotes
    .filter((q) => q?.symbol && String(q.symbol).toUpperCase().split('.')[0] === base)
    .map((q) => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || '',
      exchange: q.exchDisp || q.exchange || '',
    }));
}

// Stooq CSV — an independent free source covering listings Yahoo is missing.
export const stooqSymbols = (ticker) => [`${ticker.toLowerCase()}.us`, ticker.toLowerCase()];
export const stooqUrl = (s) =>
  `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`;

// Format: Symbol,Date,Time,Open,High,Low,Close,Volume
export function parseStooq(text) {
  const row = text?.trim().split('\n')[1];
  if (!row) return null;
  const close = parseFloat(row.split(',')[6]);
  return !isNaN(close) && close > 0 ? close : null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const noop = () => {};

/**
 * Price one ticker, walking every source in order until one answers.
 *
 * @param {string} ticker            what the user typed
 * @param {object} opts
 * @param {(url: string) => Promise<string|null>} opts.fetchText  the transport
 * @param {number} [opts.deadline]   absolute Date.now() cut-off for the chain
 * @param {string} [opts.resolvedSymbol]  a Yahoo symbol discovered previously
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{price:number, currency?:string, symbol:string, source:string}|null>}
 */
export async function resolveQuote(ticker, { fetchText, deadline, resolvedSymbol = '', log = noop } = {}) {
  const budget = deadline ?? (Date.now() + RESOLVE_BUDGET_MS);
  // A previously discovered symbol stands in for the typed ticker, and may
  // route it to a different source family than the raw ticker would (a bare
  // ticker resolving to a numeric TASE id, say). Routing therefore happens on
  // the resolved symbol, not on what the user typed.
  const lookup = resolvedSymbol || ticker;
  // Strip .TA before testing so "1150184.TA" routes to the Israeli sources too.
  const rawId = lookup.replace(/\.TA$/i, '');
  return isNumericIsraeli(rawId)
    ? israeliQuote(rawId, fetchText, budget, log)
    : foreignQuote(lookup, fetchText, budget, log);
}

/** One Yahoo chart lookup. Speculative candidates pass hosts=['query1'] —
 *  mirroring a guess across both Yahoo hosts doubles the round-trips without
 *  improving the odds. */
async function yahooChart(symbol, hosts, fetchText, deadline, log) {
  for (const host of hosts) {
    if (Date.now() > deadline) return null;
    try {
      const hit = parseYahooChart(await fetchText(yahooChartUrl(host, symbol)), symbol);
      if (hit) return hit;
    } catch (e) { log(`Yahoo chart failed ${symbol}: ${e.message}`); }
  }
  return null;
}

async function israeliQuote(rawId, fetchText, deadline, log) {
  const results = await Promise.all(israeliCandidateUrls(rawId).map(async (url) => {
    try { return { url, price: extractIsraeliPrice(await fetchText(url)) }; }
    catch (e) { log(`candidate failed ${url}: ${e.message}`); return { url, price: null }; }
  }));
  for (const { url, price } of results) {
    if (price != null) return { price, currency: 'ILS-Agorot', symbol: rawId, source: url };
  }
  // Scraped pages can change markup or omit the security entirely; Yahoo
  // carries many TASE listings under "<id>.TA" and answers with clean JSON.
  const y = await yahooChart(`${rawId}.TA`, ['query1'], fetchText, deadline, log);
  return y ? { price: y.price, currency: y.currency || 'ILS-Agorot', symbol: y.symbol, source: 'yahoo' } : null;
}

async function foreignQuote(ticker, fetchText, deadline, log) {
  const seen = new Set([ticker.toUpperCase()]);
  const outOfTime = () => Date.now() > deadline;

  // The literal spelling (which is already the resolved symbol when one was
  // known) is the common path, so it goes first. It still carries the
  // deadline: exempting it was what let a single lookup run for over a minute.
  const literal = await yahooChart(ticker, ['query1', 'query2'], fetchText, deadline, log);
  if (literal) return { ...literal, source: 'yahoo' };

  // Nothing under the literal spelling — ask Yahoo which symbol this is.
  if (!outOfTime()) {
    let matches = [];
    try { matches = parseYahooSearch(await fetchText(yahooSearchUrl(ticker)), ticker); }
    catch (e) { log(`Yahoo search failed ${ticker}: ${e.message}`); }
    for (const m of matches) {
      if (seen.has(m.symbol.toUpperCase()) || outOfTime()) continue;
      seen.add(m.symbol.toUpperCase());
      const hit = await yahooChart(m.symbol, ['query1'], fetchText, deadline, log);
      if (hit) {
        log(`resolved ${ticker} -> ${hit.symbol} (${m.exchange} ${m.name})`);
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
      seen.add(sym);
      const hit = await yahooChart(sym, ['query1'], fetchText, deadline, log);
      if (hit) {
        log(`resolved ${ticker} -> ${hit.symbol} by suffix guess`);
        return { ...hit, source: 'yahoo-suffix' };
      }
    }
  }

  for (const s of stooqSymbols(ticker)) {
    if (outOfTime()) break;
    try {
      const close = parseStooq(await fetchText(stooqUrl(s)));
      if (close != null) return { price: close, currency: undefined, symbol: s.toUpperCase(), source: 'stooq' };
    } catch (e) { log(`Stooq failed ${s}: ${e.message}`); }
  }
  return null;
}
