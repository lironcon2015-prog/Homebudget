const TIMEOUT_MS = 6000;
const MAX_PARALLEL = 5;
const WORKER_URL_KEY = 'juniorinvest:quoteProxy';

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
    attempts.push({ url: workerUrl + '/?url=' + encodeURIComponent(targetUrl), json: false });
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

// Single-shot diagnostic for the settings "Test Worker" button. Runs one
// fetch through the configured worker and returns a human-readable result.
// Routes numeric Israeli IDs to Funder, everything else to Yahoo.
export async function testWorker(testTicker = 'AAPL') {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) return { ok: false, msg: 'אין URL של Worker מוגדר' };
  const isNumericIsraeli = /^\d{6,7}$/.test(testTicker);
  const t0 = Date.now();
  try {
    if (isNumericIsraeli) {
      const price = await getQuote(testTicker);
      const ms = Date.now() - t0;
      if (price != null) return { ok: true, msg: `✓ ${testTicker}=${price} (${ms}ms via Funder)` };
      return { ok: false, msg: `Funder לא החזיר מחיר עבור ${testTicker} (${ms}ms)` };
    }
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(testTicker)}`;
    const url = workerUrl + '/?url=' + encodeURIComponent(target);
    const res = await fetchWithTimeout(url, 10000);
    const ms = Date.now() - t0;
    const raw = await res.text();
    if (!res.ok) return { ok: false, msg: `HTTP ${res.status} (${ms}ms): ${raw.slice(0, 120)}` };
    let price = null;
    try { price = JSON.parse(raw)?.chart?.result?.[0]?.meta?.regularMarketPrice; } catch {}
    if (typeof price === 'number') return { ok: true, msg: `✓ ${testTicker}=${price} (${ms}ms)` };
    return { ok: false, msg: `תגובה לא תקינה (${ms}ms): ${raw.slice(0, 120)}` };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, msg: `${e.name} (${ms}ms): ${e.message}` };
  }
}

function extractIsraeliPrice(html) {
  if (!html) return null;
  const patterns = [
    /id="fundLastRate"[^>]*>\s*([\d.,]+)/i,
    /id="etfLastRate"[^>]*>\s*([\d.,]+)/i,
    /class="[^"]*(?:fund|etf)[-_]?last[-_]?rate[^"]*"[^>]*>\s*([\d.,]+)/i,
    /class="[^"]*info-price[^"]*"[^>]*>\s*([\d.,]+)/i,
    /class="[^"]*last[-_]?(?:rate|price)[^"]*"[^>]*>\s*([\d.,]+)/i,
    /data-(?:last-)?rate\s*=\s*"([\d.,]+)"/i,
    /"lastRate"\s*:\s*"?([\d.]+)"?/i,
    /"last_rate"\s*:\s*"?([\d.]+)"?/i,
    /"closingPrice"\s*:\s*"?([\d.]+)"?/i,
    /שער\s*(?:אחרון|נוכחי)?[^0-9-]{0,40}([0-9]{2,6}(?:[.,][0-9]{1,4})?)/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    const raw = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(raw) && raw > 0) {
      // Israeli sources quote in agorot (e.g. 12345.6 = 123.456 ILS).
      // Values >100 we treat as agorot; otherwise as ILS.
      return raw > 100 ? raw / 100 : raw;
    }
  }
  return null;
}

export async function getQuote(ticker) {
  const isNumericIsraeli = /^\d{6,7}$/.test(ticker);  // pure numeric: ETF or mutual fund
  const rawId = ticker.replace(/\.TA$/i, '');

  if (isNumericIsraeli) {
    // We can't tell ETF vs mutual fund from the number alone, so try both
    // ETF and mutual-fund paths across Funder, Bizportal, and TASE Maya.
    const padded = rawId.padStart(8, '0');
    const urls = [
      'https://www.funder.co.il/etf/' + rawId,
      'https://www.funder.co.il/fund/' + rawId,
      'https://www.bizportal.co.il/tradedfund/quote/generalview/' + rawId,
      'https://www.bizportal.co.il/mutualfund/quote/generalview/' + rawId,
      'https://market.tase.co.il/he/market_data/security/' + padded + '/major_data',
    ];
    for (const u of urls) {
      try {
        const html = await proxyFetch(u);
        const price = extractIsraeliPrice(html);
        if (price != null) { console.log(`[QuoteFetcher] OK: ${ticker} = ${price} via ${u}`); return price; }
      } catch (e) { console.warn('[QuoteFetcher] failed:', u, e.message); }
    }
  } else {
    const endpoints = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
    ];
    for (const ep of endpoints) {
      try {
        const text = await proxyFetch(ep);
        if (!text) continue;
        const data = JSON.parse(text);
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (typeof price === 'number') { console.log(`[QuoteFetcher] Yahoo OK: ${ticker} = ${price}`); return price; }
      } catch (e) { console.warn(`[QuoteFetcher] Yahoo failed ${ticker}:`, e.message); }
    }
  }
  return null;
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
export async function fetchQuotes(tickers, { onProgress } = {}) {
  const results = {};
  let done = 0;
  await runWithConcurrency(tickers, MAX_PARALLEL, async (ticker) => {
    const price = await getQuote(ticker);
    if (price != null) results[ticker] = price;
    done++;
    if (onProgress) onProgress({ done, total: tickers.length, ticker, ok: price != null });
  });
  return results;
}
