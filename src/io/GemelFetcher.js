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
// Nothing here is trusted blindly: a detected column still has to produce
// values that look like monthly percentages before they are accepted.

import { proxyFetch } from './QuoteFetcher.js';

const CKAN = 'https://data.gov.il/api/3/action';
const DATASET = 'gemelnet';
const MAX_ROWS = 600;          // ~50 years of monthly rows for one track

// Ordered best-guess first. The first pattern that matches a column wins.
const PATTERNS = {
  fund: [/^ID_KUPA$/i, /^FUND_ID$/i, /מספר.?קופה/, /קופה/, /kupa/i],
  month: [/תקופת.?דוח/, /^MONTH$/i, /^TKUFA/i, /חודש/, /תאריך/, /date/i, /period/i],
  ret: [
    /תשואה.?נומינלית.?ברוטו/,
    /תשואה.?חודשית/,
    /^YIELD$/i,
    /MONTHLY.?YIELD/i,
    /תשואה/,
  ],
};

function pickField(fields, kind) {
  const names = fields.map((f) => String(f.id));
  for (const re of PATTERNS[kind]) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
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

async function ckan(action, params) {
  const qs = new URLSearchParams(params).toString();
  const text = await proxyFetch(`${CKAN}/${action}?${qs}`);
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    return json?.success ? json.result : null;
  } catch { return null; }
}

/**
 * Find the dataset resource that actually carries per-fund monthly returns, and
 * work out which of its columns are which.
 */
async function resolveResource() {
  const pkg = await ckan('package_show', { id: DATASET });
  if (!pkg) return { error: 'package_show נכשל — data.gov.il לא נענה או חסם' };

  const candidates = (pkg.resources || []).filter((r) => r.datastore_active);
  if (!candidates.length) return { error: 'לא נמצא משאב פעיל בדאטהסט', resources: (pkg.resources || []).length };

  for (const res of candidates) {
    const probe = await ckan('datastore_search', { resource_id: res.id, limit: '1' });
    if (!probe?.fields) continue;
    const fundField = pickField(probe.fields, 'fund');
    const monthField = pickField(probe.fields, 'month');
    const retField = pickField(probe.fields, 'ret');
    if (fundField && monthField && retField) {
      return { resourceId: res.id, resourceName: res.name, fundField, monthField, retField,
               allFields: probe.fields.map((f) => f.id) };
    }
  }
  const first = await ckan('datastore_search', { resource_id: candidates[0].id, limit: '1' });
  return {
    error: 'נמצא משאב אך לא זוהו העמודות הדרושות',
    resourceId: candidates[0].id,
    allFields: (first?.fields || []).map((f) => f.id),
  };
}

/**
 * Monthly returns for one track, newest first.
 * Returns `{ returns: [{month, pct}], meta }` or `{ error, meta }`.
 */
export async function fetchGemelReturns(fundNumber) {
  const meta = await resolveResource();
  if (meta.error) return { error: meta.error, meta };

  const rows = await ckan('datastore_search', {
    resource_id: meta.resourceId,
    filters: JSON.stringify({ [meta.fundField]: String(fundNumber) }),
    limit: String(MAX_ROWS),
  });
  if (!rows) return { error: 'שאילתת datastore_search נכשלה', meta };
  if (!rows.records?.length) {
    return { error: `לא נמצאו שורות לקופה ${fundNumber} בעמודה ${meta.fundField}`, meta };
  }

  const returns = [];
  for (const rec of rows.records) {
    const month = normalizeMonth(rec[meta.monthField]);
    const pct = toNumber(rec[meta.retField]);
    if (month && pct != null) returns.push({ month, pct, source: 'gemelnet' });
  }
  if (!returns.length) {
    return {
      error: 'נמצאו שורות אך אף אחת לא נפרסה',
      meta: { ...meta, sampleRow: rows.records[0] },
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

  return { returns, meta: { ...meta, rows: rows.records.length, scaleWarning } };
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
    if (m.resourceId) lines.push(`resource: ${m.resourceId}`);
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
  if (m.scaleWarning) lines.push(`⚠ ${m.scaleWarning}`);
  return lines.join('\n');
}
