// Cloudflare Worker — same-origin CORS proxy for Kids Portfolio quote sources.
//
// Deploy:
//   1. Cloudflare dashboard → Workers & Pages → Create → Worker
//   2. Name: kids-portfolio-quotes  (or whatever you like)
//   3. Paste this whole file as the worker code → Deploy
//   4. Copy the worker URL (e.g. https://kids-portfolio-quotes.<account>.workers.dev)
//   5. In the app: הגדרות → "כתובת Worker לשערים" → paste the URL → Save
//
// Usage from the client:
//   GET https://<your-worker>.workers.dev/?url=<encoded-target-url>
//
// Only the allowed upstream hosts below are proxied; everything else returns 403.

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

// Cap the upstream fetch well inside the client's own budget. Without it a
// quote source that accepts the connection and then never answers holds this
// worker open until the browser gives up, and the client reports "the worker
// timed out" — which reads as a broken worker and sends the search to the
// wrong place entirely. A 504 that names the host says what actually happened.
const UPSTREAM_TIMEOUT_MS = 8000;

// Note for the client's diagnostic: a GET with no ?url= is answered below with
// an immediate 400. That makes it a liveness probe that touches no upstream —
// the one question that separates "this worker is not running" from "this
// worker is waiting on a source that never answers".
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response('missing ?url=', { status: 400, headers: CORS_HEADERS });
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
      const upstream = await fetch(target, {
        cf: { cacheTtl: 60, cacheEverything: true },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; KidsPortfolioBot/1.0)',
          'Accept': 'application/json, text/html, */*',
        },
      });
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
      return new Response(
        `upstream ${timedOut ? 'timeout' : 'error'} (${parsed.hostname}): ${e.message}`, {
          status: timedOut ? 504 : 502,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
        });
    }
  },
};
