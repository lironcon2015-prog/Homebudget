// src/io/GemelFetcher.js
// Pulls published monthly returns for a gemel track from גמל-נט, via the
// Ministry of Finance's CKAN dataset on data.gov.il.
//
// The dataset's column names are not part of any stable published contract, and
// they are Hebrew, and they have changed shape before. Hard-coding them would
// produce a fetcher that breaks silently and is impossible to debug from a
// phone. So this module *discovers* the schema instead: it reads the resource's
// own field list and matches columns by pattern, then reports what it matched.
// `describeSource()` renders that reasoning as text for the settings screen, so
// a failure says which step failed and what it saw rather than "לא נמצא".
//
// Nothing here is trusted blindly: a column is accepted only once a real value
// from the resource survives the parser it will be fed to. Name matching alone
// picked INCEPTION_DATE over REPORT_PERIOD once, and every row then failed to
// parse — the validators exist so that fails at detection instead.

import { proxyFetch } from './QuoteFetcher.js';

const CKAN = 'https://data.gov.il/api/3/action';
const DATASET = 'gemelnet';
const MAX_ROWS = 600;          // ~50 years of monthly rows for one track

// The live schema, verified against the dataset, first — then looser patterns
// so a column rename does not break the fetcher outright.
//
// Name matching alone is not enough: `/date/i` happily matches INCEPTION_DATE,
// which holds an Excel serial (44166) rather than a period, and picking it
// yields rows that all fail to parse. So a candidate column is only accepted
// once a real value from the resource survives the parser below.
const PATTERNS = {
  fund: [/^FUND_ID$/i, /^ID_KUPA$/i, /מספר.?קופה/, /קופה/, /kupa/i, /fund.?id/i],
  month: [/^REPORT_PERIOD$/i, /report.?period/i, /תקופת.?דוח/, /^MONTH$/i, /^TKUFA/i,
          /חודש/, /period/i, /תאריך/, /date/i],
  ret: [/^MONTHLY_YIELD$/i, /monthly.?yield/i, /תשואה.?נומינלית.?ברוטו/,
        /תשואה.?חודשית/, /^YIELD$/i, /תשואה/],
};

// A month column has to produce a real YYYY-MM. A yield column may legitimately
// be null on a fund's inception month, so only a non-numeric non-null value
// disqualifies it.
const VALIDATORS = {
  fund: (v) => v != null && String(v).length > 0,
  month: (v) => normalizeMonth(v) != null,
  ret: (v) => v == null || v === '' || toNumber(v) != null,
};

/**
 * First column whose name matches a pattern *and* whose value in `sample`
 * survives the corresponding validator. Falls back to name-only matching when
 * no sample row is available.
 */
function pickField(fields, kind, sample = null) {
  const names = fields.map((f) => String(f.id));
  const validate = VALIDATORS[kind];
  for (const re of PATTERNS[kind]) {
    for (const name of names) {
      if (!re.test(name)) continue;
      if (sample && !validate(sample[name])) continue;
      return name;
    }
  }
  return null;
}

/**
 * Normalise whatever the month column holds into `YYYY-MM`.
 * Seen in the wild across similar datasets: 202604, "2026-04", "2026-04-30",
 * "30/04/2026". Anything else returns null rather than a wrong guess.
 */
export function normalizeMonth(value) {
  if (value == null) return null;
  const s = String(value).trim();
  let m;
  if ((m = /^(\d{4})(\d{2})$/.exec(s))) return `${m[1]}-${m[2]}`;
  if ((m = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(s))) return `${m[1]}-${m[2]}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return `${m[3]}-${String(m[2]).padStart(2, '0')}`;
  if ((m = /^(\d{4})\/(\d{1,2})$/.exec(s))) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  return null;
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const ATTEMPT_TIMEOUT_MS = 12000;

function fetchWithTimeout(url, timeoutMs = ATTEMPT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

/**
 * Try data.gov.il directly before falling back to the proxy chain.
 *
 * The proxies all run in data centres, and data.gov.il sits behind bot
 * protection that rejects those addresses — so the proxy that makes every other
 * source in this app reachable is precisely what makes this one unreachable.
 * A browser on a home connection is not blocked, and CKAN serves
 * `Access-Control-Allow-Origin: *`, so the direct call is both the most likely
 * to succeed and the cheapest. The proxies stay as a fallback for the reverse
 * case (a browser or network that blocks the request instead).
 *
 * Every attempt is recorded: this source cannot be verified from a development
 * machine, so a failure has to explain itself well enough to be diagnosed from
 * a phone.
 */
async function ckan(action, params, log = []) {
  const qs = new URLSearchParams(params).toString();
  const target = `${CKAN}/${action}?${qs}`;

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(target);
    const body = await res.text();
    log.push(`ישיר: HTTP ${res.status}, ${body.length}B, ${Date.now() - t0}ms`);
    if (res.ok && body) {
      const json = JSON.parse(body);
      if (json?.success) return json.result;
      log.push(`  ↳ success=false${json?.error ? ' · ' + JSON.stringify(json.error).slice(0, 200) : ''}`);
    }
  } catch (e) {
    log.push(`ישיר: ${e.name} ${e.message} (${Date.now() - t0}ms)`);
  }

  const t1 = Date.now();
  const text = await proxyFetch(target);
  if (!text) { log.push(`דרך פרוקסי: נכשל (${Date.now() - t1}ms)`); return null; }
  log.push(`דרך פרוקסי: ${text.length}B, ${Date.now() - t1}ms`);
  try {
    const json = JSON.parse(text);
    if (json?.success) return json.result;
    log.push(`  ↳ success=false${json?.error ? ' · ' + JSON.stringify(json.error).slice(0, 200) : ''}`);
    return null;
  } catch {
    log.push(`  ↳ תשובה אינה JSON: ${text.slice(0, 160)}`);
    return null;
  }
}

/**
 * Find the dataset resource that actually carries per-fund monthly returns, and
 * work out which of its columns are which.
 */
async function resolveResource(log = []) {
  const pkg = await ckan('package_show', { id: DATASET }, log);
  if (!pkg) return { error: 'package_show נכשל — data.gov.il לא נענה או חסם', log };

  const candidates = (pkg.resources || []).filter((r) => r.datastore_active);
  if (!candidates.length) {
    return {
      error: 'לא נמצא משאב פעיל בדאטהסט',
      resources: (pkg.resources || []).map((r) => `${r.name} (datastore_active=${r.datastore_active})`),
      log,
    };
  }

  for (const res of candidates) {
    const probe = await ckan('datastore_search', { resource_id: res.id, limit: '1' }, log);
    if (!probe?.fields) continue;
    const sample = probe.records?.[0] || null;
    const fundField = pickField(probe.fields, 'fund', sample);
    const monthField = pickField(probe.fields, 'month', sample);
    const retField = pickField(probe.fields, 'ret', sample);
    if (sample) log.push(`  ↳ עמודות: ${fundField} · ${monthField} · ${retField}`);
    if (fundField && monthField && retField) {
      return { resourceId: res.id, resourceName: res.name, fundField, monthField, retField,
               allFields: probe.fields.map((f) => f.id), log };
    }
  }
  const first = await ckan('datastore_search', { resource_id: candidates[0].id, limit: '1' }, log);
  return {
    error: 'נמצא משאב אך לא זוהו העמודות הדרושות',
    resourceId: candidates[0].id,
    allFields: (first?.fields || []).map((f) => f.id),
    candidates: candidates.map((c) => c.name),
    log,
  };
}

/**
 * Monthly returns for one track, newest first.
 * Returns `{ returns: [{month, pct}], meta }` or `{ error, meta }`.
 */
export async function fetchGemelReturns(fundNumber) {
  const log = [];
  const meta = await resolveResource(log);
  if (meta.error) return { error: meta.error, meta: { ...meta, log } };

  const rows = await ckan('datastore_search', {
    resource_id: meta.resourceId,
    filters: JSON.stringify({ [meta.fundField]: String(fundNumber) }),
    limit: String(MAX_ROWS),
  }, log);
  if (!rows) return { error: 'שאילתת datastore_search נכשלה', meta: { ...meta, log } };
  if (!rows.records?.length) {
    return { error: `לא נמצאו שורות לקופה ${fundNumber} בעמודה ${meta.fundField}`, meta: { ...meta, log } };
  }

  const returns = [];
  let latestFee = null;
  let latestFeeMonth = '';
  for (const rec of rows.records) {
    const month = normalizeMonth(rec[meta.monthField]);
    const pct = toNumber(rec[meta.retField]);
    if (month && pct != null) returns.push({ month, pct, source: 'gemelnet' });
    const fee = toNumber(rec.AVG_ANNUAL_MANAGEMENT_FEE);
    if (month && fee != null && month > latestFeeMonth) { latestFee = fee; latestFeeMonth = month; }
  }
  if (!returns.length) {
    return {
      error: 'נמצאו שורות אך אף אחת לא נפרסה',
      meta: { ...meta, sampleRow: rows.records[0], log },
    };
  }

  returns.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

  // A ratio-vs-percent mix-up is the one error that would be invisible in the
  // UI while being catastrophic in the maths, so it is caught here.
  const worst = Math.max(...returns.map((r) => Math.abs(r.pct)));
  const scaleWarning = worst > 100
    ? `ערכים חריגים (מקס ${worst}) — ייתכן שהעמודה אינה אחוזים חודשיים`
    : worst < 0.2 && returns.length > 6
      ? `ערכים קטנים מאוד (מקס ${worst}) — ייתכן שהעמודה ביחס ולא באחוזים`
      : null;

  return { returns, meta: { ...meta, rows: rows.records.length, scaleWarning, log, avgFeePct: latestFee } };
}

/**
 * Human-readable diagnostic for the settings screen. Mirrors `testWorker`:
 * it always reports which step failed and what it saw, because this source
 * cannot be verified from a development machine — only from a real browser.
 */
export async function describeSource(fundNumber) {
  const t0 = Date.now();
  const out = await fetchGemelReturns(fundNumber);
  const ms = Date.now() - t0;
  const m = out.meta || {};
  const lines = [];

  if (out.error) {
    lines.push(`✗ ${out.error} (${ms}ms)`);
    if (m.log?.length) lines.push(`ניסיונות:\n  ${m.log.join('\n  ')}`);
    if (m.fundField) lines.push(`עמודות שנבחרו: קופה=${m.fundField} · חודש=${m.monthField} · תשואה=${m.retField}`);
    if (m.resourceId) lines.push(`resource: ${m.resourceId}`);
    if (m.candidates?.length) lines.push(`משאבים: ${m.candidates.join(', ')}`);
    if (m.resources?.length) lines.push(`משאבים בדאטהסט:\n  ${m.resources.join('\n  ')}`);
    if (m.allFields?.length) lines.push(`עמודות זמינות:\n  ${m.allFields.join('\n  ')}`);
    if (m.sampleRow) lines.push(`שורה לדוגמה:\n${JSON.stringify(m.sampleRow, null, 2)}`);
    return lines.join('\n');
  }

  const newest = out.returns[0];
  const oldest = out.returns.at(-1);
  lines.push(`✓ ${out.returns.length} חודשים לקופה ${fundNumber} (${ms}ms)`);
  lines.push(`טווח: ${oldest.month} … ${newest.month}`);
  lines.push(`עמודות: קופה=${m.fundField} · חודש=${m.monthField} · תשואה=${m.retField}`);
  lines.push(`אחרונים: ${out.returns.slice(0, 6).map((r) => `${r.month} ${r.pct}%`).join(' · ')}`);
  if (m.avgFeePct != null) lines.push(`דמי ניהול ממוצעים בקופה: ${m.avgFeePct}% — הזן בשדה דמי הניהול`);
  if (m.scaleWarning) lines.push(`⚠ ${m.scaleWarning}`);
  if (m.log?.length) lines.push(`ניסיונות:\n  ${m.log.join('\n  ')}`);
  return lines.join('\n');
}
