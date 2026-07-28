// Cloudflare Worker — same-origin CORS proxy for JuniorInvest quote sources.
//
// Deploy:
//   1. Cloudflare dashboard → Workers & Pages → Create → Worker
//   2. Name: juniorinvest-quotes  (or whatever you like)
//   3. Paste this whole file as the worker code → Deploy
//   4. Copy the worker URL (e.g. https://juniorinvest-quotes.<account>.workers.dev)
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
]);

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
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; JuniorInvestBot/1.0)',
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
      return new Response('upstream error: ' + e.message, {
        status: 502,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
      });
    }
  },
};
