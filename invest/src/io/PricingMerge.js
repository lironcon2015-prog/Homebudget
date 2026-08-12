// src/io/PricingMerge.js
//
// Keeps the FRESHEST PRICES across devices, which is not the same thing as
// keeping the newest file.
//
// A Drive pull replaces the local portfolio with the cloud copy, and the cloud
// copy is whichever device wrote last. Writing last says nothing about prices:
// the phone that added a transaction ten minutes ago may be carrying quotes from
// last week, while the desktop that refreshed quotes an hour ago wrote earlier.
// Applying that pull as-is walks the portfolio's valuation backwards — the
// holdings are right and every price is stale.
//
// So the pull is not "cloud wins" for pricing. The ledger, kids and funds still
// come from the incoming payload (it is the newer state of the world, and the
// ledger is append-only truth), but each quote is decided on its own recorded
// time and the FX rate likewise. Prices only ever move forward in time.
//
// Pure module: no DOM, no network, no localStorage — so it is testable and so a
// mistake here cannot take the sync down with it. Every entry point is
// defensive; on anything unparseable it returns the remote text untouched,
// which is exactly the old behaviour.

/**
 * When was this priced? Prefers the full timestamp, falls back to the date-only
 * `asOf` that portfolios written before asOfTs carry.
 *
 * A date-only value is read as the START of that day (00:00 UTC) on purpose: it
 * is the earliest moment the price could have been recorded, so a same-day
 * timestamped price wins over it. Reading it as end-of-day would let a legacy
 * quote outrank a refresh that actually happened today.
 *
 * @returns {number} ms since epoch, or 0 when nothing usable is present.
 */
export function pricedAt(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  const ts = Date.parse(entry.asOfTs);
  if (!Number.isNaN(ts)) return ts;
  if (typeof entry.asOf === 'string' && /^\d{4}-\d{2}-\d{2}/.test(entry.asOf)) {
    const d = Date.parse(entry.asOf.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isNaN(d)) return d;
  }
  return 0;
}

function fxEntry(state) {
  const s = state?.settings;
  if (!s || typeof s.lastFxRate !== 'number' || !(s.lastFxRate > 0)) return null;
  return { rate: s.lastFxRate, asOf: s.lastFxRateAsOf, asOfTs: s.lastFxRateAsOfTs };
}

/**
 * Merge the pricing of two portfolio states.
 *
 * `base` is the state being kept — everything that is not a price comes from it,
 * unchanged. `candidate` contributes ONLY quotes and an FX rate, and only where
 * its own recorded time is strictly newer. The direction is deliberate and both
 * are used: a pull passes base=remote / candidate=local (the incoming state
 * wins, except on prices), while the conflict "overwrite the cloud" branch
 * passes base=local / candidate=remote (the local edits win, except on prices).
 *
 * Which tickers exist is always the base's call: a quote the base dropped stays
 * dropped, and one only the candidate has is not introduced. Only tickers
 * present on BOTH sides are considered, so this can never resurrect a deleted
 * security or price one the base does not hold.
 *
 * NOTE: mutates `base` in place (the callers pass a freshly parsed object).
 *
 * @returns {{state: object, keptQuotes: string[], keptFx: boolean}}
 *          keptQuotes — tickers taken from the candidate.
 */
export function mergePricingState(candidate, base) {
  const out = base;
  const keptQuotes = [];
  let keptFx = false;
  if (!candidate || typeof candidate !== 'object' || !base || typeof base !== 'object') {
    return { state: out, keptQuotes, keptFx };
  }

  const candQuotes = candidate.quotes;
  const baseQuotes = out.quotes;
  if (candQuotes && typeof candQuotes === 'object' && baseQuotes && typeof baseQuotes === 'object') {
    for (const ticker of Object.keys(baseQuotes)) {
      const theirs = candQuotes[ticker];
      if (!theirs) continue;
      if (pricedAt(theirs) > pricedAt(baseQuotes[ticker])) {
        baseQuotes[ticker] = theirs;
        keptQuotes.push(ticker);
      }
    }
  }

  // The FX rate prices every foreign holding, so a stale one is as damaging as a
  // stale quote — and it lives in settings rather than in the quotes map.
  const candFx = fxEntry(candidate);
  const baseFx = fxEntry(out);
  if (candFx && (!baseFx || pricedAt(candFx) > pricedAt(baseFx))) {
    out.settings = { ...(out.settings || {}) };
    out.settings.lastFxRate = candFx.rate;
    if (candFx.asOf) out.settings.lastFxRateAsOf = candFx.asOf;
    if (candFx.asOfTs) out.settings.lastFxRateAsOfTs = candFx.asOfTs;
    keptFx = true;
  }

  return { state: out, keptQuotes, keptFx };
}

/**
 * Same merge over the serialized `juniorinvest:v1` blobs the sync moves around.
 * Returns `baseRaw` byte-for-byte when nothing was newer, so a no-op pull writes
 * back exactly what it received.
 *
 * @param {string|null} candidateRaw  contributes prices only
 * @param {string} baseRaw            the state being kept
 * @returns {{json: string, keptQuotes: string[], keptFx: boolean}}
 */
export function mergePricingJson(candidateRaw, baseRaw) {
  const none = { json: baseRaw, keptQuotes: [], keptFx: false };
  if (typeof baseRaw !== 'string' || typeof candidateRaw !== 'string') return none;
  let candidate, base;
  try {
    candidate = JSON.parse(candidateRaw);
    base = JSON.parse(baseRaw);
  } catch {
    return none;   // a payload we cannot read is applied exactly as it arrived
  }
  const { state, keptQuotes, keptFx } = mergePricingState(candidate, base);
  if (!keptQuotes.length && !keptFx) return none;
  try {
    return { json: JSON.stringify(state), keptQuotes, keptFx };
  } catch {
    return none;
  }
}
