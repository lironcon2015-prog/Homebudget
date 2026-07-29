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

const FIELDS = [{ id: 'ID_KUPA' }, { id: 'תקופת דוח' }, { id: 'תשואה נומינלית ברוטו' }];
const ROWS = [
  { ID_KUPA: '13344', 'תקופת דוח': '202602', 'תשואה נומינלית ברוטו': -3.1 },
  { ID_KUPA: '13344', 'תקופת דוח': '202603', 'תשואה נומינלית ברוטו': 0.4 },
];

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
    return jsonRes({ success: true, result: { fields: FIELDS, records: [] } });
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
const ok = await fetchGemelReturns('13344');
check('direct hit first', calls[0].startsWith('https://data.gov.il/'), calls[0]);
check('no proxy used when direct works',
  !calls.some((c) => /codetabs|allorigins|corsproxy/.test(c)), calls.join('\n'));
check('returns parsed', ok.returns?.length === 2, JSON.stringify(ok.error || ok.returns));
check('newest first', ok.returns?.[0].month === '2026-03', JSON.stringify(ok.returns));
check('percent preserved', ok.returns?.[1].pct === -3.1, JSON.stringify(ok.returns));
check('schema auto-detected',
  ok.meta.fundField === 'ID_KUPA' && ok.meta.monthField === 'תקופת דוח'
  && ok.meta.retField === 'תשואה נומינלית ברוטו', JSON.stringify(ok.meta));

console.log('\n-- proxy fallback when direct is blocked --');
const calls2 = installFetch({ directFails: true });
const viaProxy = await fetchGemelReturns('13344');
check('falls back to a proxy', calls2.some((c) => /codetabs|allorigins|corsproxy/.test(c)));
check('still resolves through the proxy', viaProxy.returns?.length === 2,
  JSON.stringify(viaProxy.error || viaProxy.returns));
check('log records the direct failure',
  viaProxy.meta.log?.some((l) => l.includes('TypeError')), JSON.stringify(viaProxy.meta.log));

console.log('\n-- diagnostic explains a total failure --');
globalThis.fetch = () => Promise.reject(Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }));
const report = await describeSource('13344');
check('reports failure', report.startsWith('✗'), report);
check('names the failing step', report.includes('package_show'), report);
check('includes the attempt log', report.includes('ניסיונות'), report);
check('log distinguishes direct from proxy',
  report.includes('ישיר') && report.includes('פרוקסי'), report);

console.log('\n-- diagnostic on success --');
installFetch();
const good = await describeSource('13344');
check('reports success', good.startsWith('✓'), good);
check('lists detected columns', good.includes('ID_KUPA'), good);
check('shows the month range', good.includes('2026-02') && good.includes('2026-03'), good);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
