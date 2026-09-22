// invest/src/io/quoteSources.js — the one copy of "where a price comes from".
// It is pure and transport-agnostic, so it can be tested with a fake fetch;
// that is most of the reason it was split out of QuoteFetcher in the first
// place. The browser and the Cloudflare worker both run this file, so a
// regression here is a regression in both at once.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIsraeliPrice, israeliCandidateUrls, parseYahooChart, parseYahooSearch,
  parseStooq, resolveQuote,
} from '../invest/src/io/quoteSources.js';

// A fetchText that answers from a { url-substring: body } table and records
// every URL it was asked for, in order.
function fakeFetch(table) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [frag, body] of Object.entries(table)) if (url.includes(frag)) return body;
    return null;
  };
  fn.calls = calls;
  return fn;
}

const chart = (price, currency = 'USD', symbol = 'AAPL') =>
  JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: price, currency, symbol } }] } });

test('Bizportal last price wins over any other number on the page', () => {
  const html = `<div class="open">5000</div>
    <div class="top-rate-line"><span>x</span><div class="num">5,844</div></div>
    <div data-last-rate="9999">`;
  assert.equal(extractIsraeliPrice(html), 5844);
});

test('agorot are not divided', () => {
  // A numeric TASE id is stored as ILS-Agorot, so 5844 must stay 5844.
  assert.equal(extractIsraeliPrice('"lastRate": "5844"'), 5844);
});

test('opening and base prices are not mistaken for the last price', () => {
  assert.equal(extractIsraeliPrice('"BasePrice": 5000, "PaperValue": 4000, "Open": 123'), null);
});

test('Hebrew "שער אחרון" is read through an inner tag', () => {
  assert.equal(extractIsraeliPrice('שער אחרון <span class="v">406.38</span>'), 406.38);
});

test('ILA is mapped to agorot, unknown currencies stay undefined', () => {
  assert.equal(parseYahooChart(chart(1234, 'ILA', 'DLAS.TA')).currency, 'ILS-Agorot');
  assert.equal(parseYahooChart(chart(12, 'JPY', 'X')).currency, undefined);
});

test('a zero or missing price is not a quote', () => {
  assert.equal(parseYahooChart(chart(0)), null);
  assert.equal(parseYahooChart('{"chart":{"result":[{"meta":{}}]}}'), null);
});

test('search accepts only the same base symbol, never a name match', () => {
  const body = JSON.stringify({ quotes: [
    { symbol: 'DLAS.TA', shortname: 'Delek', exchDisp: 'Tel Aviv' },
    { symbol: 'DLASX', shortname: 'Delek Something Else' },
  ] });
  assert.deepEqual(parseYahooSearch(body, 'DLAS').map((m) => m.symbol), ['DLAS.TA']);
  // An already-qualified ticker must still match its own base symbol.
  assert.deepEqual(parseYahooSearch(body, 'DLAS.TA').map((m) => m.symbol), ['DLAS.TA']);
});

test('stooq reads the close column', () => {
  assert.equal(parseStooq('Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-09-21,22:00:00,1,2,3,42.5,100'), 42.5);
  assert.equal(parseStooq('Symbol,Date\nAAPL.US,N/D'), null);
});

test('a numeric id prices from the scrape sources, never from a ticker lookup', async () => {
  const f = fakeFetch({ 'bizportal.co.il/tradedfund': '<div class="top-rate-line"><div class="num">5,650</div></div>' });
  const hit = await resolveQuote('1150184', { fetchText: f });
  assert.equal(hit.price, 5650);
  assert.equal(hit.currency, 'ILS-Agorot');
  assert.ok(!f.calls.some((u) => u.includes('/v1/finance/search')));
});

test('a numeric id falls back to Yahoo <id>.TA when every page is silent', async () => {
  const hit = await resolveQuote('1150184', { fetchText: fakeFetch({ '/chart/1150184.TA': chart(77, 'ILA', '1150184.TA') }) });
  assert.equal(hit.price, 77);
  assert.equal(hit.source, 'yahoo');
});

test('a ticker Yahoo spells differently resolves through search', async () => {
  const f = fakeFetch({
    '/v1/finance/search': JSON.stringify({ quotes: [{ symbol: 'DLAS.TA', exchDisp: 'Tel Aviv' }] }),
    '/chart/DLAS.TA': chart(1500, 'ILA', 'DLAS.TA'),
  });
  const hit = await resolveQuote('DLAS', { fetchText: f });
  assert.equal(hit.symbol, 'DLAS.TA');
  assert.equal(hit.source, 'yahoo-search');
});

test('a qualified symbol is never suffixed again', async () => {
  const f = fakeFetch({});
  await resolveQuote('DLEKG.TA', { fetchText: f });
  assert.ok(!f.calls.some((u) => u.includes('DLEKG.TA.TA')));
});

test('a remembered symbol routes the lookup, not what the user typed', async () => {
  // The typed ticker is alphabetic but resolved to a numeric TASE id, so the
  // lookup must go to the Israeli pages rather than to Yahoo's chart API.
  const f = fakeFetch({ 'funder.co.il/fund/1150184': '"buyPrice": 406.38' });
  const hit = await resolveQuote('MYFUND', { fetchText: f, resolvedSymbol: '1150184' });
  assert.equal(hit.price, 406.38);
  assert.ok(f.calls.every((u) => !u.includes('MYFUND')));
});

test('the deadline bounds the chain instead of being checked after it', async () => {
  const f = fakeFetch({});
  const hit = await resolveQuote('NOPE', { fetchText: f, deadline: Date.now() - 1 });
  assert.equal(hit, null);
  assert.equal(f.calls.length, 0);
});

test('every Israeli candidate URL carries the id, and the padded TASE form', () => {
  const urls = israeliCandidateUrls('1150184');
  assert.equal(urls.length, 5);
  assert.ok(urls.every((u) => u.includes('1150184')));
  assert.ok(urls.some((u) => u.includes('market.tase.co.il') && u.includes('01150184')));
});
