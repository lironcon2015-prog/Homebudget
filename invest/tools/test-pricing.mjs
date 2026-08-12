// tools/test-pricing.mjs — `npm run test:pricing`
// The rule under test: a Drive pull takes the incoming state but keeps whichever
// PRICE was recorded later. Last write decides the ledger; recorded time decides
// the quotes.

import { pricedAt, mergePricingState, mergePricingJson } from '../src/io/PricingMerge.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

const q = (price, { asOf, asOfTs } = {}) => ({ ticker: 'X', price, currency: 'USD', asOf, asOfTs });

console.log('\n-- pricedAt --');
check('full timestamp wins over the date', pricedAt(q(1, { asOf: '2026-08-10', asOfTs: '2026-08-12T09:30:00Z' })) === Date.parse('2026-08-12T09:30:00Z'));
check('date-only reads as the start of that day',
  pricedAt(q(1, { asOf: '2026-08-12' })) === Date.parse('2026-08-12T00:00:00Z'));
check('a same-day refresh outranks a legacy date-only quote',
  pricedAt(q(1, { asOfTs: '2026-08-12T10:00:00Z' })) > pricedAt(q(1, { asOf: '2026-08-12' })));
check('nothing usable is 0', pricedAt({}) === 0 && pricedAt(null) === 0 && pricedAt(q(1, { asOf: 'שלשום' })) === 0);

console.log('\n-- quotes: newer price survives the pull --');
{
  // The motivating case: the phone wrote last (it added a transaction) but its
  // prices are a week old; the desktop refreshed quotes an hour ago.
  const desktop = { quotes: { AAPL: q(228.5, { asOfTs: '2026-08-12T09:00:00Z' }), MSFT: q(410, { asOfTs: '2026-08-05T09:00:00Z' }) } };
  const phone = { quotes: { AAPL: q(201.0, { asOfTs: '2026-08-05T09:00:00Z' }), MSFT: q(415, { asOfTs: '2026-08-12T09:05:00Z' }) }, ledger: [1, 2, 3] };
  const { state, keptQuotes } = mergePricingState(desktop, phone);
  check('stale incoming quote replaced by the fresher local one', state.quotes.AAPL.price === 228.5);
  check('fresher incoming quote is left alone', state.quotes.MSFT.price === 415);
  check('only the replaced ticker is reported', keptQuotes.join(',') === 'AAPL');
  check('the incoming ledger is untouched', state.ledger.length === 3);
}

console.log('\n-- what the base decides --');
{
  const local = { quotes: { GONE: q(50, { asOfTs: '2026-08-12T10:00:00Z' }), KEPT: q(10, { asOfTs: '2026-08-12T10:00:00Z' }) } };
  const remote = { quotes: { KEPT: q(9, { asOfTs: '2026-08-01T10:00:00Z' }) } };
  const { state, keptQuotes } = mergePricingState(local, remote);
  check('a ticker the incoming state dropped is NOT resurrected', !('GONE' in state.quotes));
  check('a ticker present on both sides is compared', state.quotes.KEPT.price === 10 && keptQuotes.join(',') === 'KEPT');
}
{
  const local = { quotes: { A: q(5, { asOfTs: '2026-08-12T10:00:00Z' }) } };
  const remote = { quotes: { A: q(6, { asOfTs: '2026-08-12T10:00:00Z' }) } };
  check('an exact tie leaves the incoming price in place',
    mergePricingState(local, remote).state.quotes.A.price === 6);
}

console.log('\n-- fx rate --');
{
  const local = { settings: { lastFxRate: 3.72, lastFxRateAsOfTs: '2026-08-12T09:00:00Z' }, quotes: {} };
  const remote = { settings: { lastFxRate: 3.55, lastFxRateAsOfTs: '2026-08-01T09:00:00Z', locale: 'he-IL' }, quotes: {} };
  const { state, keptFx } = mergePricingState(local, remote);
  check('fresher local rate survives', state.settings.lastFxRate === 3.72 && keptFx === true);
  check('other settings from the incoming state survive', state.settings.locale === 'he-IL');
  check('the timestamp travels with the rate', state.settings.lastFxRateAsOfTs === '2026-08-12T09:00:00Z');
}
{
  const local = { settings: { lastFxRate: 3.72, lastFxRateAsOfTs: '2026-08-01T09:00:00Z' }, quotes: {} };
  const remote = { settings: { lastFxRate: 3.60, lastFxRateAsOfTs: '2026-08-12T09:00:00Z' }, quotes: {} };
  const { state, keptFx } = mergePricingState(local, remote);
  check('a stale local rate does not override a fresher incoming one', state.settings.lastFxRate === 3.60 && keptFx === false);
}
{
  const local = { settings: { lastFxRate: 0 }, quotes: {} };
  const remote = { settings: { lastFxRate: 3.6, lastFxRateAsOfTs: '2026-08-12T09:00:00Z' }, quotes: {} };
  check('a missing/zero local rate is never treated as pricing',
    mergePricingState(local, remote).state.settings.lastFxRate === 3.6);
}

console.log('\n-- json wrapper --');
{
  const local = JSON.stringify({ quotes: { A: q(9, { asOfTs: '2026-08-12T10:00:00Z' }) }, ledger: [] });
  const remote = JSON.stringify({ quotes: { A: q(8, { asOfTs: '2026-08-01T10:00:00Z' }) }, ledger: [{ id: 't' }] });
  const out = mergePricingJson(local, remote);
  const parsed = JSON.parse(out.json);
  check('merged json keeps the fresher price', parsed.quotes.A.price === 9);
  check('merged json keeps the incoming ledger', parsed.ledger.length === 1);
  check('reports what it kept', out.keptQuotes.join(',') === 'A');
}
{
  const remote = JSON.stringify({ quotes: {}, ledger: [] });
  const out = mergePricingJson('{{ not json', remote);
  check('unparseable local blob returns the incoming text byte-for-byte', out.json === remote && !out.keptQuotes.length);
  check('missing local blob returns the incoming text', mergePricingJson(null, remote).json === remote);
}
{
  const remote = JSON.stringify({ quotes: { A: q(8, { asOfTs: '2026-08-12T10:00:00Z' }) } });
  const local = JSON.stringify({ quotes: { A: q(7, { asOfTs: '2026-08-01T10:00:00Z' }) } });
  check('a no-op merge returns the incoming text unchanged (not a re-serialization)',
    mergePricingJson(local, remote).json === remote);
}

console.log('\n-- convergence: two devices, different tickers refreshed --');
{
  // A refreshed AAPL, B refreshed MSFT. Whoever pulls second must end up with
  // BOTH fresh prices, and a third pull must then change nothing.
  const a = { quotes: { AAPL: q(228, { asOfTs: '2026-08-12T09:00:00Z' }), MSFT: q(400, { asOfTs: '2026-08-01T09:00:00Z' }) } };
  const b = { quotes: { AAPL: q(220, { asOfTs: '2026-08-01T09:00:00Z' }), MSFT: q(415, { asOfTs: '2026-08-12T09:05:00Z' }) } };
  const first = mergePricingState(structuredClone(a), structuredClone(b)).state;
  check('union of the fresh prices', first.quotes.AAPL.price === 228 && first.quotes.MSFT.price === 415);
  const second = mergePricingState(structuredClone(a), structuredClone(first));
  check('re-merging is a no-op', !second.keptQuotes.length && !second.keptFx);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
