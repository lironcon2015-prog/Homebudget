// GENERATED FILE — do not edit.
// Built from worker/src/quote-proxy.js + src/io/quoteSources.js by
// tools/build-worker.js. Edit those and rebuild; edits here are overwritten.
//
// Paste this whole file into the Cloudflare dashboard as the worker code.

// src/io/quoteSources.js
var CURRENCY_MAP = { ILA: "ILS-Agorot", USD: "USD", EUR: "EUR", GBP: "GBP" };
var SUFFIX_GUESSES = [".TA"];
var RESOLVE_BUDGET_MS = 2e4;
var isNumericIsraeli = (s) => /^\d{6,7}$/.test(s);
function israeliCandidateUrls(rawId) {
  const padded = String(rawId).padStart(8, "0");
  return [
    "https://www.bizportal.co.il/tradedfund/quote/generalview/" + rawId,
    "https://www.bizportal.co.il/mutualfund/quote/generalview/" + rawId,
    "https://www.funder.co.il/fund/" + rawId,
    "https://www.funder.co.il/etf/" + rawId,
    "https://market.tase.co.il/he/market_data/security/" + padded + "/major_data"
  ];
}
function extractIsraeliPrice(html) {
  if (!html) return null;
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
    /שער\s+נוכחי[^0-9-]{0,40}([0-9]{2,7}(?:[.,][0-9]{1,4})?)/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    const raw = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(raw) && raw > 0) return raw;
  }
  return null;
}
var yahooChartUrl = (host, symbol) => `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
function parseYahooChart(text, fallbackSymbol) {
  if (!text) return null;
  const meta = JSON.parse(text)?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== "number" || !(price > 0)) return null;
  return { price, currency: CURRENCY_MAP[meta.currency], symbol: meta.symbol || fallbackSymbol };
}
var yahooSearchUrl = (ticker) => `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=10&newsCount=0&listsCount=0`;
function parseYahooSearch(text, ticker) {
  if (!text) return [];
  const base = ticker.toUpperCase().split(".")[0];
  const quotes = JSON.parse(text)?.quotes || [];
  return quotes.filter((q) => q?.symbol && String(q.symbol).toUpperCase().split(".")[0] === base).map((q) => ({
    symbol: q.symbol,
    name: q.shortname || q.longname || "",
    exchange: q.exchDisp || q.exchange || ""
  }));
}
var stooqSymbols = (ticker) => [`${ticker.toLowerCase()}.us`, ticker.toLowerCase()];
var stooqUrl = (s) => `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`;
function parseStooq(text) {
  const row = text?.trim().split("\n")[1];
  if (!row) return null;
  const close = parseFloat(row.split(",")[6]);
  return !isNaN(close) && close > 0 ? close : null;
}
var noop = () => {
};
async function resolveQuote(ticker, { fetchText, deadline, resolvedSymbol = "", log = noop } = {}) {
  const budget = deadline ?? Date.now() + RESOLVE_BUDGET_MS;
  const lookup = resolvedSymbol || ticker;
  const rawId = lookup.replace(/\.TA$/i, "");
  return isNumericIsraeli(rawId) ? israeliQuote(rawId, fetchText, budget, log) : foreignQuote(lookup, fetchText, budget, log);
}
async function yahooChart(symbol, hosts, fetchText, deadline, log) {
  for (const host of hosts) {
    if (Date.now() > deadline) return null;
    try {
      const hit = parseYahooChart(await fetchText(yahooChartUrl(host, symbol)), symbol);
      if (hit) return hit;
    } catch (e) {
      log(`Yahoo chart failed ${symbol}: ${e.message}`);
    }
  }
  return null;
}
async function israeliQuote(rawId, fetchText, deadline, log) {
  const results = await Promise.all(israeliCandidateUrls(rawId).map(async (url) => {
    try {
      return { url, price: extractIsraeliPrice(await fetchText(url)) };
    } catch (e) {
      log(`candidate failed ${url}: ${e.message}`);
      return { url, price: null };
    }
  }));
  for (const { url, price } of results) {
    if (price != null) return { price, currency: "ILS-Agorot", symbol: rawId, source: url };
  }
  const y = await yahooChart(`${rawId}.TA`, ["query1"], fetchText, deadline, log);
  return y ? { price: y.price, currency: y.currency || "ILS-Agorot", symbol: y.symbol, source: "yahoo" } : null;
}
async function foreignQuote(ticker, fetchText, deadline, log) {
  const seen = /* @__PURE__ */ new Set([ticker.toUpperCase()]);
  const outOfTime = () => Date.now() > deadline;
  const literal = await yahooChart(ticker, ["query1", "query2"], fetchText, deadline, log);
  if (literal) return { ...literal, source: "yahoo" };
  if (!outOfTime()) {
    let matches = [];
    try {
      matches = parseYahooSearch(await fetchText(yahooSearchUrl(ticker)), ticker);
    } catch (e) {
      log(`Yahoo search failed ${ticker}: ${e.message}`);
    }
    for (const m of matches) {
      if (seen.has(m.symbol.toUpperCase()) || outOfTime()) continue;
      seen.add(m.symbol.toUpperCase());
      const hit = await yahooChart(m.symbol, ["query1"], fetchText, deadline, log);
      if (hit) {
        log(`resolved ${ticker} -> ${hit.symbol} (${m.exchange} ${m.name})`);
        return { ...hit, source: "yahoo-search" };
      }
    }
  }
  if (!ticker.includes(".")) {
    for (const sfx of SUFFIX_GUESSES) {
      const sym = ticker.toUpperCase() + sfx;
      if (seen.has(sym) || outOfTime()) continue;
      seen.add(sym);
      const hit = await yahooChart(sym, ["query1"], fetchText, deadline, log);
      if (hit) {
        log(`resolved ${ticker} -> ${hit.symbol} by suffix guess`);
        return { ...hit, source: "yahoo-suffix" };
      }
    }
  }
  for (const s of stooqSymbols(ticker)) {
    if (outOfTime()) break;
    try {
      const close = parseStooq(await fetchText(stooqUrl(s)));
      if (close != null) return { price: close, currency: void 0, symbol: s.toUpperCase(), source: "stooq" };
    } catch (e) {
      log(`Stooq failed ${s}: ${e.message}`);
    }
  }
  return null;
}

// worker/src/quote-proxy.js
var ALLOWED_HOSTS = /* @__PURE__ */ new Set([
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "www.funder.co.il",
  "www.bizportal.co.il",
  "market.tase.co.il",
  "maya.tase.co.il",
  "mayaapi.tase.co.il",
  // Fallback quote source for listings Yahoo doesn't carry.
  "stooq.com",
  "www.stooq.com",
  // גמל-נט monthly returns, published by the Ministry of Finance.
  "data.gov.il",
  "gemel.funder.co.il"
]);
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
var UPSTREAM_TIMEOUT_MS = 8e3;
var FRESH_MS = 15 * 60 * 1e3;
var STALE_MS = 24 * 60 * 60 * 1e3;
var SUBREQUEST_BUDGET = 44;
var RESOLVE_BUDGET_MS2 = 2e4;
var CACHE_ORIGIN = "https://quote-cache.internal";
var json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
function fetchUpstream(url) {
  return fetch(url, {
    cf: { cacheTtl: 60, cacheEverything: true },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KidsPortfolioBot/1.0)",
      "Accept": "application/json, text/html, */*"
    }
  });
}
var cacheKey = (id) => new Request(`${CACHE_ORIGIN}/q/${encodeURIComponent(id)}`);
async function readCache(id) {
  try {
    const hit = await caches.default.match(cacheKey(id));
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}
function writeCache(id, entry, ctx) {
  const res = new Response(JSON.stringify(entry), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${Math.floor(STALE_MS / 1e3)}` }
  });
  ctx.waitUntil(caches.default.put(cacheKey(id), res));
}
async function handleQuotes(reqUrl, ctx) {
  const ids = (reqUrl.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
  if (!ids.length) return json({ error: "missing ?ids=" }, 422);
  const quotes = {};
  const now = Date.now();
  let spent = 0;
  const cached = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await readCache(id)])));
  const stale = [];
  for (const id of ids) {
    const c = cached[id];
    if (c && now - Date.parse(c.asOf) < FRESH_MS) quotes[id] = { ...c, stale: false };
    else stale.push(id);
  }
  for (const id of stale) {
    if (spent >= SUBREQUEST_BUDGET) break;
    const fetchText = async (url) => {
      if (spent >= SUBREQUEST_BUDGET) return null;
      spent++;
      const res = await fetchUpstream(url);
      return res.ok ? await res.text() : null;
    };
    let hit = null;
    try {
      hit = await resolveQuote(id, { fetchText, deadline: Date.now() + RESOLVE_BUDGET_MS2 });
    } catch {
    }
    if (hit) {
      const entry = { ...hit, asOf: (/* @__PURE__ */ new Date()).toISOString() };
      writeCache(id, entry, ctx);
      quotes[id] = { ...entry, stale: false };
    } else if (cached[id] && now - Date.parse(cached[id].asOf) < STALE_MS) {
      quotes[id] = { ...cached[id], stale: true };
    }
  }
  return json({ quotes, asOf: (/* @__PURE__ */ new Date()).toISOString() });
}
async function handlePassthrough(reqUrl) {
  const target = reqUrl.searchParams.get("url");
  if (!target) {
    return new Response("missing ?url=", { status: 400, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("bad url", { status: 400, headers: CORS_HEADERS });
  }
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return new Response("host not allowed: " + parsed.hostname, {
      status: 403,
      headers: { ...CORS_HEADERS, "Cache-Control": "no-store" }
    });
  }
  try {
    const upstream = await fetchUpstream(target);
    const body = await upstream.text();
    const ok = upstream.status >= 200 && upstream.status < 300;
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": upstream.headers.get("Content-Type") || "text/plain; charset=utf-8",
        // Only cache successful responses; errors must always re-fetch.
        "Cache-Control": ok ? "public, max-age=60" : "no-store"
      }
    });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return new Response(`upstream ${timedOut ? "timeout" : "error"} (${parsed.hostname}): ${e.message}`, {
      status: timedOut ? 504 : 502,
      headers: { ...CORS_HEADERS, "Cache-Control": "no-store" }
    });
  }
}
var quote_proxy_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: CORS_HEADERS });
    }
    const reqUrl = new URL(request.url);
    return reqUrl.pathname === "/quotes" ? handleQuotes(reqUrl, ctx) : handlePassthrough(reqUrl);
  }
};
export {
  quote_proxy_default as default
};
