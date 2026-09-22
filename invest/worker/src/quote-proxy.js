// Cloudflare Worker — the quote service for Kids Portfolio.
//
// SOURCE FILE. Do not paste this one into Cloudflare: it imports
// ../../src/io/quoteSources.js. Run `node tools/build-worker.js` (or
// `npm run build:worker`) and paste the generated `worker/quote-proxy.js`,
// which is a single self-contained file.
//
// Deploy:
//   1. Cloudflare dashboard → Workers & Pages → Create → Worker
//   2. Paste the BUILT worker/quote-proxy.js as the worker code → Deploy
//   3. Optional but recommended: Settings → Domains & Routes → add
//      quotes.lironcon.com. The app tries that address first, because
//      *.workers.dev is blocked by some carriers, DNS filters and ad
//      blockers — a failure that looks exactly like a broken worker.
//
// Endpoints:
//   GET /quotes?ids=1150184,AAPL   → {"quotes":{"AAPL":{price,currency,symbol,source,asOf,stale}}}
//   GET /?url=<encoded>            → allowlisted CORS passthrough (Gemel, and
//                                     the client's own fallback path)
//   GET /                          → 400 "missing ?url=", immediately. The
//                                     client uses this as a liveness ping: it
//                                     touches no upstream, so an answer proves
//                                     the worker runs and moves the suspicion
//                                     to the source behind it.

import { resolveQuote } from '../../src/io/quoteSources.js';

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'www.funder.co.il',
  'www.bizportal.co.il',
  'market.tase.co.il',
  'maya.tase.co.il',
  'mayaapi.tase.co.il',
  // Fallback quote source for listings Yahoo doesn't carry.
  'stooq.com',
  'www.stooq.com',
  // גמל-נט monthly returns, published by the Ministry of Finance.
  'data.gov.il',
  'gemel.funder.co.il',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Cap every upstream fetch well inside the client's own budget. Without it a
// source that accepts the connection and then never answers holds this worker
// open until the browser gives up, and the client reports "the worker timed
// out" — which reads as a broken worker and sends the search to the wrong
// place entirely. A 504 that names the host says what actually happened.
const UPSTREAM_TIMEOUT_MS = 8000;

// How long a cached quote is served without re-fetching. TASE funds publish
// once a day and shares move by the minute, so this is a compromise aimed at
// the thing that actually hurts: a family refreshing the same portfolio on
// three devices should cost the sources one fetch, not three.
const FRESH_MS = 15 * 60 * 1000;

// How long a quote stays usable once it is no longer fresh. This is the whole
// point of caching here rather than in the browser: when Bizportal is down,
// the app shows this morning's price marked stale instead of showing nothing,
// which is the failure the user actually notices.
const STALE_MS = 24 * 60 * 60 * 1000;

// A worker request may make 50 subrequests on the free plan. One Israeli id
// costs up to six, so a portfolio of ten uncached holdings would blow through
// it and fail the whole batch. Instead the budget is counted and ids that do
// not fit are simply left out of the answer — the client fetches those itself
// and the next refresh finds them cached. Degrading beats erroring.
const SUBREQUEST_BUDGET = 44;

const RESOLVE_BUDGET_MS = 20000;
const CACHE_ORIGIN = 'https://quote-cache.internal';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

function fetchUpstream(url) {
  return fetch(url, {
    cf: { cacheTtl: 60, cacheEverything: true },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; KidsPortfolioBot/1.0)',
      'Accept': 'application/json, text/html, */*',
    },
  });
}

// Cached entries carry a long max-age and their own `asOf`, and freshness is
// judged from `asOf` here. Letting the cache expire them instead would throw
// away exactly the copy we want when the upstream is down.
const cacheKey = (id) => new Request(`${CACHE_ORIGIN}/q/${encodeURIComponent(id)}`);

async function readCache(id) {
  try {
    const hit = await caches.default.match(cacheKey(id));
    return hit ? await hit.json() : null;
  } catch { return null; }
}

function writeCache(id, entry, ctx) {
  const res = new Response(JSON.stringify(entry), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${Math.floor(STALE_MS / 1000)}` },
  });
  ctx.waitUntil(caches.default.put(cacheKey(id), res));
}

async function handleQuotes(reqUrl, ctx) {
  const ids = (reqUrl.searchParams.get('ids') || '')
    .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60);
  if (!ids.length) return json({ error: 'missing ?ids=' }, 422);

  const quotes = {};
  const now = Date.now();
  let spent = 0;

  // Cache first, for every id, before a single subrequest is spent. An id that
  // is fresh costs nothing and does not eat into the budget below.
  const cached = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await readCache(id)])));
  const stale = [];
  for (const id of ids) {
    const c = cached[id];
    if (c && now - Date.parse(c.asOf) < FRESH_MS) quotes[id] = { ...c, stale: false };
    else stale.push(id);
  }

  // Resolve sequentially. Parallel lookups would overrun the subrequest budget
  // before it could be checked, and the sources are the same few hosts anyway
  // — hammering them in parallel is what gets an IP rate-limited.
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
      hit = await resolveQuote(id, { fetchText, deadline: Date.now() + RESOLVE_BUDGET_MS });
    } catch { /* one bad id must not fail the batch */ }

    if (hit) {
      const entry = { ...hit, asOf: new Date().toISOString() };
      writeCache(id, entry, ctx);
      quotes[id] = { ...entry, stale: false };
    } else if (cached[id] && now - Date.parse(cached[id].asOf) < STALE_MS) {
      // Every source refused, but we priced this before. Yesterday's number
      // labelled as yesterday's is worth more than an empty row.
      quotes[id] = { ...cached[id], stale: true };
    }
  }
  return json({ quotes, asOf: new Date().toISOString() });
}

async function handlePassthrough(reqUrl) {
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    return new Response('missing ?url=', { status: 400, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } });
  }
  let parsed;
  try { parsed = new URL(target); }
  catch { return new Response('bad url', { status: 400, headers: CORS_HEADERS }); }

  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return new Response('host not allowed: ' + parsed.hostname, {
      status: 403,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
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
        'Content-Type': upstream.headers.get('Content-Type') || 'text/plain; charset=utf-8',
        // Only cache successful responses; errors must always re-fetch.
        'Cache-Control': ok ? 'public, max-age=60' : 'no-store',
      },
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return new Response(`upstream ${timedOut ? 'timeout' : 'error'} (${parsed.hostname}): ${e.message}`, {
      status: timedOut ? 504 : 502,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405, headers: CORS_HEADERS });
    }
    const reqUrl = new URL(request.url);
    return reqUrl.pathname === '/quotes'
      ? handleQuotes(reqUrl, ctx)
      : handlePassthrough(reqUrl);
  },
};
