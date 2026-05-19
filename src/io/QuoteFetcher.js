const TIMEOUT_MS = 6000;
const MAX_PARALLEL = 5;
const WORKER_URL_KEY = 'juniorinvest:quoteProxy';

export function getWorkerUrl() {
  try { return (localStorage.getItem(WORKER_URL_KEY) || '').trim(); }
  catch { return ''; }
}

export function setWorkerUrl(url) {
  try {
    const trimmed = (url || '').trim().replace(/\/+$/, '');
    if (trimmed) localStorage.setItem(WORKER_URL_KEY, trimmed);
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
      if (!res.ok) continue;
      const raw = await res.text();
      const text = json ? (JSON.parse(raw).contents ?? raw) : raw;
      if (text && text.length > 50) return text;
    } catch (_) {}
  }
  return null;
}

export async function getQuote(ticker) {
  const isMutualFund = /^\d{6,7}$/.test(ticker);  // pure numeric only
  const rawId = ticker.replace(/\.TA$/i, '');

  if (isMutualFund) {
    try {
      const html = await proxyFetch('https://www.funder.co.il/fund/' + rawId);
      if (!html) throw new Error('empty');
      const match =
        html.match(/id="fundLastRate"[^>]*>\s*([\d.,]+)/i) ||
        html.match(/שער[^0-9]*([0-9]{3,5}\.[0-9]{1,3})/i) ||
        html.match(/class="[^"]*info-price[^"]*"[^>]*>\s*([\d,.]+)/i);
      if (match) {
        const agorot = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(agorot) && agorot > 0) return agorot / 100;
      }
    } catch (e) { console.warn('[QuoteFetcher] Funder failed:', e.message); }
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
