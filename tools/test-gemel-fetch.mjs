// tools/test-gemel-fetch.mjs — `npm run test:gemel-fetch`
// Covers the transport and schema-discovery logic in GemelFetcher by stubbing
// global fetch. The real source (data.gov.il) is unreachable from CI and from
// the development sandbox, so these checks pin the behaviour that has to hold
// regardless of what the live endpoint does: direct-before-proxy ordering,
// schema auto-detection, month/percent parsing, and a diagnostic that explains
// its own failure.

import { fetchGemelReturns, describeSource, normalizeMonth } from '../src/io/GemelFetcher.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

// The live gemelnet schema, captured from a real response. INCEPTION_DATE is
// the trap: its name matches a date pattern but it holds an Excel serial, and
// choosing it makes every row fail to parse.
const FIELDS = [
  { id: '_id' }, { id: 'FUND_ID' }, { id: 'FUND_NAME' }, { id: 'MANAGING_CORPORATION' },
  { id: 'REPORT_PERIOD' }, { id: 'INCEPTION_DATE' }, { id: 'DEPOSITS' },
  { id: 'AVG_ANNUAL_MANAGEMENT_FEE' }, { id: 'MONTHLY_YIELD' }, { id: 'YEAR_TO_DATE_YIELD' },
  { id: 'YIELD_TRAILING_3_YRS' }, { id: 'REPORTING_YEAR' },
];
const row = (period, yield_, fee = 0.67) => ({
  _id: 1, FUND_ID: 99999, FUND_NAME: 'קופה', MANAGING_CORPORATION: 'מנהל',
  REPORT_PERIOD: period, INCEPTION_DATE: 44166, DEPOSITS: 0.33,
  AVG_ANNUAL_MANAGEMENT_FEE: fee, MONTHLY_YIELD: yield_,
  YEAR_TO_DATE_YIELD: 1.1, YIELD_TRAILING_3_YRS: 9.9, REPORTING_YEAR: Math.floor(period / 100),
});
// The inception month legitimately carries a null yield.
const ROWS = [row(202012, null, null), row(202602, -3.1), row(202603, 0.4, 0.62)];

function jsonRes(body, status = 200) {
  return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
}

// `calls` records every URL the module reaches for, in order.
function installFetch({ directFails = false, calls = [] } = {}) {
  globalThis.fetch = (url) => {
    calls.push(String(url));
    const isDirect = String(url).startsWith('https://data.gov.il/');
    if (isDirect && directFails) return Promise.reject(Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }));
    const target = isDirect ? String(url) : decodeURIComponent(String(url).replace(/^.*?(quest|url)=/, ''));
    if (target.includes('package_show')) {
      return jsonRes({ success: true, result: { resources: [{ id: 'res-1', name: 'yields', datastore_active: true }] } });
    }
    if (target.includes('filters')) return jsonRes({ success: true, result: { records: ROWS } });
    // A probe returns one real row, which is what schema validation runs against.
    return jsonRes({ success: true, result: { fields: FIELDS, records: [ROWS[0]] } });
  };
  return calls;
}

console.log('\n-- month normalisation --');
check('YYYYMM', normalizeMonth('202604') === '2026-04');
check('YYYY-MM', normalizeMonth('2026-04') === '2026-04');
check('YYYY-MM-DD', normalizeMonth('2026-04-30') === '2026-04');
check('DD/MM/YYYY', normalizeMonth('30/04/2026') === '2026-04');
check('garbage rejected', normalizeMonth('not a date') === null);
check('null rejected', normalizeMonth(null) === null);

console.log('\n-- direct call is tried before any proxy --');
const calls = installFetch();
const ok = await fetchGemelReturns('99999');
check('direct hit first', calls[0].startsWith('https://data.gov.il/'), calls[0]);
check('no proxy used when direct works',
  !calls.some((c) => /codetabs|allorigins|corsproxy/.test(c)), calls.join('\n'));
check('returns parsed', ok.returns?.length === 2, JSON.stringify(ok.error || ok.returns));
check('newest first', ok.returns?.[0].month === '2026-03', JSON.stringify(ok.returns));
check('integer YYYYMM period parsed', ok.returns?.[0].month === '2026-03', JSON.stringify(ok.returns));
check('percent preserved', ok.returns?.[1].pct === -3.1, JSON.stringify(ok.returns));
check('schema auto-detected',
  ok.meta.fundField === 'FUND_ID' && ok.meta.monthField === 'REPORT_PERIOD'
  && ok.meta.retField === 'MONTHLY_YIELD', JSON.stringify(ok.meta));
check('INCEPTION_DATE rejected as the month column',
  ok.meta.monthField !== 'INCEPTION_DATE', ok.meta.monthField);
check('null inception yield skipped, not fatal', ok.returns.length === 2,
  JSON.stringify(ok.returns));
check('published management fee surfaced', ok.meta.avgFeePct === 0.62, String(ok.meta.avgFeePct));

console.log('\n-- a name-matching column with unusable values is rejected --');
// Drop REPORT_PERIOD entirely: INCEPTION_DATE still matches /date/i by name,
// but its Excel serial must disqualify it rather than be silently accepted.
const FIELDS_NO_PERIOD = FIELDS.filter((f) => f.id !== 'REPORT_PERIOD');
globalThis.fetch = (url) => {
  const isDirect = String(url).startsWith('https://data.gov.il/');
  const target = isDirect ? String(url) : decodeURIComponent(String(url).replace(/^.*?(quest|url)=/, ''));
  if (target.includes('package_show')) {
    return jsonRes({ success: true, result: { resources: [{ id: 'res-1', name: 'y', datastore_active: true }] } });
  }
  if (target.includes('filters')) return jsonRes({ success: true, result: { records: ROWS } });
  return jsonRes({ success: true, result: { fields: FIELDS_NO_PERIOD, records: [ROWS[0]] } });
};
const noMonth = await fetchGemelReturns('99999');
check('detection fails loudly instead of parsing nothing',
  noMonth.error?.includes('לא זוהו העמודות'), noMonth.error);

console.log('\n-- proxy fallback when direct is blocked --');
const calls2 = installFetch({ directFails: true });
const viaProxy = await fetchGemelReturns('99999');
check('falls back to a proxy', calls2.some((c) => /codetabs|allorigins|corsproxy/.test(c)));
check('still resolves through the proxy', viaProxy.returns?.length === 2,
  JSON.stringify(viaProxy.error || viaProxy.returns));
check('log records the direct failure',
  viaProxy.meta.log?.some((l) => l.includes('TypeError')), JSON.stringify(viaProxy.meta.log));

console.log('\n-- history split across resources is merged, not truncated --');
// The dataset is split by era. Stopping at the first matching resource is what
// silently cut the history short at 2022.
const ARCHIVE = [row(202012, null, null), row(202111, 1.0), row(202206, -2.0)];
const CURRENT = [row(202312, 0.9), row(202602, -3.1), row(202603, 0.4, 0.62)];
let sortSeen = [];
function installSplitFetch({ rejectSort = false } = {}) {
  sortSeen = [];
  globalThis.fetch = (url) => {
    const isDirect = String(url).startsWith('https://data.gov.il/');
    const target = isDirect ? String(url) : decodeURIComponent(String(url).replace(/^.*?(quest|url)=/, ''));
    if (target.includes('package_show')) {
      return jsonRes({ success: true, result: { resources: [
        { id: 'res-archive', name: 'gemelnet 2020-2022', datastore_active: true },
        { id: 'res-current', name: 'gemelnet 2023-', datastore_active: true },
      ] } });
    }
    if (target.includes('filters')) {
      const u = new URL(target);
      if (u.searchParams.get('sort')) {
        sortSeen.push(u.searchParams.get('sort'));
        if (rejectSort) return jsonRes({ success: false, error: { message: 'bad sort' } }, 409);
      }
      const rows = target.includes('res-archive') ? ARCHIVE : CURRENT;
      return jsonRes({ success: true, result: { records: rows } });
    }
    const rows = target.includes('res-archive') ? ARCHIVE : CURRENT;
    return jsonRes({ success: true, result: { fields: FIELDS, records: [rows[0]] } });
  };
}

installSplitFetch();
const merged = await fetchGemelReturns('99999');
check('both resources contribute', merged.returns?.length === 5,
  JSON.stringify(merged.error || merged.returns?.map((r) => r.month)));
check('reaches the newest month', merged.returns?.[0].month === '2026-03',
  JSON.stringify(merged.returns?.map((r) => r.month)));
check('keeps the oldest month too',
  merged.returns?.at(-1).month === '2021-11', JSON.stringify(merged.returns?.map((r) => r.month)));
check('query is sorted newest-first', sortSeen.every((v) => /desc/.test(v)), JSON.stringify(sortSeen));
check('per-resource breakdown reported', merged.meta.perResource?.length === 2,
  JSON.stringify(merged.meta.perResource));

console.log('\n-- overlapping months: first resource wins --');
const OVERLAP_A = [row(202603, 5.5)];
const OVERLAP_B = [row(202603, 9.9)];
globalThis.fetch = (url) => {
  const isDirect = String(url).startsWith('https://data.gov.il/');
  const target = isDirect ? String(url) : decodeURIComponent(String(url).replace(/^.*?(quest|url)=/, ''));
  if (target.includes('package_show')) {
    return jsonRes({ success: true, result: { resources: [
      { id: 'res-a', name: 'a', datastore_active: true },
      { id: 'res-b', name: 'b', datastore_active: true },
    ] } });
  }
  const rows = target.includes('res-a') ? OVERLAP_A : OVERLAP_B;
  if (target.includes('filters')) return jsonRes({ success: true, result: { records: rows } });
  return jsonRes({ success: true, result: { fields: FIELDS, records: [rows[0]] } });
};
const overlap = await fetchGemelReturns('99999');
check('duplicate month kept once', overlap.returns?.length === 1, JSON.stringify(overlap.returns));
check('first resource wins the tie', overlap.returns?.[0].pct === 5.5, JSON.stringify(overlap.returns));

console.log('\n-- a rejected sort falls back to an unsorted query --');
installSplitFetch({ rejectSort: true });
const unsorted = await fetchGemelReturns('99999');
check('sort was attempted', sortSeen.length > 0);
check('still returns rows without sort', unsorted.returns?.length === 5,
  JSON.stringify(unsorted.error || unsorted.returns?.length));

console.log('\n-- diagnostic explains a total failure --');
globalThis.fetch = () => Promise.reject(Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }));
const report = await describeSource('99999');
check('reports failure', report.startsWith('✗'), report);
check('names the failing step', report.includes('package_show'), report);
check('includes the attempt log', report.includes('ניסיונות'), report);
check('log distinguishes direct from proxy',
  report.includes('ישיר') && report.includes('פרוקסי'), report);

console.log('\n-- diagnostic on success --');
installFetch();
const good = await describeSource('99999');
check('reports success', good.startsWith('✓'), good);
check('lists detected columns', good.includes('FUND_ID') && good.includes('MONTHLY_YIELD'), good);
check('shows the month range', good.includes('2026-02') && good.includes('2026-03'), good);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
