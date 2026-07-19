// ===== RECURRING DETECTION =====

// Resolve aliases first (so different raw strings mapped to the same display
// name — "משיכת שיק 2500" + "דמי שכירות" — group together), then delegate
// to the canonical normalizer in autocat.js. autocat.js is loaded before
// recurring.js in index.html, so the function is globally available.
// `amount` and `day` flow through so condition-bearing aliases resolve
// correctly: e.g. "העברה" tx of ₪5,000 groups under "משכנתא" while a ₪200
// "העברה" stays raw; "מחיר ראשון" on day 5 groups under one alias and the
// same vendor on day 28 stays in a separate bucket.
function _normalizeVendor(v, amount, day) {
  const resolved = (typeof resolveVendor === 'function') ? resolveVendor(v, amount, day) : v
  return (typeof normalizeVendorForAutocat === 'function')
    ? normalizeVendorForAutocat(resolved)
    : String(resolved || '').toLowerCase().trim()
}

function _txVendorKey(t) {
  return _normalizeVendor(t.vendor, t.amount, getTxAliasDay(t))
}

// Cadence dictionary used by both auto-detection and manual flags/groups.
// Days are notional (30 / 60 / 90) — used both for "next expected" and for
// converting per-occurrence avg into monthly-equivalent (smoothed).
const RECURRING_CADENCES = {
  monthly:    { days: 30,  label: 'חודשי' },
  bimonthly:  { days: 60,  label: 'דו-חודשי' },
  quarterly:  { days: 90,  label: 'רבעוני' },
  weekly:     { days: 7,   label: 'שבועי' },
  biweekly:   { days: 14,  label: 'דו-שבועי' },
  annual:     { days: 365, label: 'שנתי' },
}

function recurringCadenceLabel(c) { return RECURRING_CADENCES[c]?.label || c }
function recurringCadenceDays(c)  { return RECURRING_CADENCES[c]?.days  || 30 }

function _addDays(iso, days) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days)
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
}

// Drops outliers whose |amount| exceeds 2 × mean(|amounts|) — i.e. anything
// >100% above the average. Returns the original array if it has fewer than
// 3 items (not enough signal to call something an outlier).
function _filterAmountOutliers(txs) {
  if (txs.length < 3) return txs
  const mean = txs.reduce((s,t)=>s+Math.abs(t.amount),0) / txs.length
  const limit = mean * 2
  const kept = txs.filter(t => Math.abs(t.amount) <= limit)
  return kept.length >= 3 ? kept : txs
}

// Bucket key for "which cadence-period does this date fall into".
// Used by manual paths to count DISTINCT cadence periods, so two tx in the
// same month (e.g. wife's salary from two employers) count as ONE monthly
// occurrence — matching the user-facing notion of "monthly income".
function _cadencePeriodKey(iso, cadence) {
  if (!iso) return ''
  const [y, m] = iso.split('-').map(Number)
  if (cadence === 'monthly')   return `${y}-${m}`
  if (cadence === 'bimonthly') return `${y}-${Math.floor((m-1)/2)}`     // 2-month bins
  if (cadence === 'quarterly') return `${y}-${Math.floor((m-1)/3)}`     // 3-month bins
  return iso
}

// Average per cadence period over the last 12 months.
// Groups tx into cadence buckets (month / quarter / etc.), sums per bucket,
// then divides by the number of buckets that actually had data.
// ignoreOutliers (user-controlled): removes buckets whose |sum| > 2× the
// mean of all other buckets — excluded from BOTH numerator and denominator.
//
// Per-tx user overrides (set via the drill modal):
// - t.recurringExcludeMode === 'period': tx is dropped entirely (no sum, no
//   period registered for it). If it's the only tx of its period, the period
//   leaves the denominator. If others remain, the period still counts via them.
// - t.recurringExcludeMode === 'amount': tx still registers its period
//   (denominator unchanged) but contributes 0 to the period sum.
// - t.recurringPeriodOverride ('YYYY-MM-DD'): bucketing uses this date instead
//   of the actual tx.date. Lets the user shift a paycheck that arrived early
//   or late into its "real" month/quarter.
function _avgPerCadencePeriod(txs, cadence, ignoreOutliers = false) {
  if (txs.length === 0) return { avg: 0, sum: 0, periods: 0, kept: [] }
  const now = new Date()
  const cutoff = _iso(new Date(now.getFullYear(), now.getMonth() - 11, 1))
  const recent = txs.filter(t => t.date && t.date >= cutoff)
  if (recent.length === 0) return { avg: 0, sum: 0, periods: 0, kept: [] }

  const periodMap = {}
  for (const t of recent) {
    if (t.recurringExcludeMode === 'period') continue
    const dateForPeriod = t.recurringPeriodOverride || t.date
    const k = _cadencePeriodKey(dateForPeriod, cadence)
    if (!k) continue
    if (!(k in periodMap)) periodMap[k] = 0
    if (t.recurringExcludeMode !== 'amount') {
      periodMap[k] += (t.amount || 0)
    }
  }
  let entries = Object.entries(periodMap)  // [[periodKey, periodSum], ...]

  if (ignoreOutliers && entries.length >= 3) {
    const filtered = entries.filter((_, i) => {
      const others = entries.filter((_, j) => j !== i)
      const meanOthers = others.reduce((s, [, a]) => s + Math.abs(a), 0) / others.length
      return Math.abs(entries[i][1]) <= meanOthers * 2
    })
    if (filtered.length >= 1) entries = filtered
  }

  const sum = entries.reduce((s, [, a]) => s + a, 0)
  const periods = Math.max(entries.length, 1)
  return { avg: sum / periods, sum, periods, kept: entries.map(([k]) => k) }
}

function _daysBetween(a, b) {
  const da = new Date(a), db = new Date(b)
  return Math.round((db - da) / (1000 * 60 * 60 * 24))
}

function _classifyCadence(gaps) {
  if (gaps.length === 0) return null
  const median = gaps.slice().sort((a,b)=>a-b)[Math.floor(gaps.length/2)]
  if (median >= 28 && median <= 31) return { cadence: 'monthly', label: 'חודשי', days: 30 }
  if (median >= 13 && median <= 15) return { cadence: 'biweekly', label: 'דו-שבועי', days: 14 }
  if (median >= 6 && median <= 8) return { cadence: 'weekly', label: 'שבועי', days: 7 }
  if (median >= 55 && median <= 65) return { cadence: 'bimonthly', label: 'דו-חודשי', days: 60 }
  if (median >= 88 && median <= 95) return { cadence: 'quarterly', label: 'רבעוני', days: 90 }
  if (median >= 360 && median <= 370) return { cadence: 'annual', label: 'שנתי', days: 365 }
  return null
}

function detectRecurring() {
  // Exclude transfers and bank-level CC payment aggregates — the real detail
  // lives on the CC account (individual purchases), which IS included. Also
  // exclude linked savings/investment deposits (they're a single structural
  // flow to a savings bucket, not a recurring "bill"). Tx that are part of
  // a manual merged group are excluded — they belong to that group only.
  // Tx with recurringExcludeFromAuto: the user explicitly opted them out of
  // their vendor's auto-bucket (one-off charges that share a vendor name with
  // a real recurring item).
  const txs = getTransactions().filter(t => {
    if (t.type === 'transfer') return false
    if (t.ccPaymentForAccountId) return false
    if (t.transferAccountId) return false
    if (t.recurringGroupId) return false
    if (t.recurringExcludeFromAuto) return false
    return true
  })
  // Narrowing now lives on the vendor alias itself (amountMin/Max + dayMin/Max).
  // resolveVendor — invoked through _txVendorKey — only returns the alias's
  // displayName when ALL of its constraints pass; tx that fail fall back to
  // their raw vendor key and end up in a separate (usually small, often
  // ignored) bucket. Single source of truth shared with the settings UI.
  const groups = {}
  txs.forEach(t => {
    const key = _txVendorKey(t)
    if (!key) return
    if (!groups[key]) groups[key] = []
    groups[key].push(t)
  })
  const ignoreOutliersSet = getIgnoreOutliersSet()
  const out = []
  for (const [key, rawList] of Object.entries(groups)) {
    if (rawList.length < 3) continue
    // Drop amount-outliers (>100% above mean) — they distort the cadence
    // gap calculation and pull the average around. Only kept when the
    // remainder still has ≥3 occurrences.
    const list = _filterAmountOutliers(rawList)
    if (list.length < 3) continue
    // sort by date asc
    list.sort((a,b) => (a.date||'').localeCompare(b.date||''))
    // median amount
    const amounts = list.map(t => t.amount).sort((a,b)=>a-b)
    const median = amounts[Math.floor(amounts.length/2)]
    // filter within ±20% of median
    const tol = Math.abs(median) * 0.2 || 5
    const filtered = list.filter(t => Math.abs(t.amount - median) <= tol)
    if (filtered.length < 3) continue
    // gaps
    const gaps = []
    for (let i = 1; i < filtered.length; i++) {
      const g = _daysBetween(filtered[i-1].date, filtered[i].date)
      if (g > 0 && g < 400) gaps.push(g)
    }
    const cadence = _classifyCadence(gaps)
    if (!cadence) continue
    const last = filtered[filtered.length - 1]
    // Timezone-safe: 'YYYY-MM-DD' parsed via `new Date(str)` is UTC midnight,
    // but getDate() reads local. In UTC+2/3 this can shift the day backward.
    // Use the local-time Date constructor + local getters only.
    const [ly, lm, ld] = last.date.split('-').map(Number)
    const nextDate = new Date(ly, lm - 1, ld + cadence.days)
    const nextExpected = `${nextDate.getFullYear()}-${String(nextDate.getMonth()+1).padStart(2,'0')}-${String(nextDate.getDate()).padStart(2,'0')}`
    const { avg: avgAmount } = _avgPerCadencePeriod(filtered, cadence.cadence, ignoreOutliersSet.has(key))
    out.push({
      key,
      sourceKey: key,
      vendor: resolveVendor(filtered[filtered.length-1].vendor, filtered[filtered.length-1].amount, getTxAliasDay(filtered[filtered.length-1])),
      cadence: cadence.cadence,
      cadenceLabel: cadence.label,
      cadenceDays: cadence.days,
      avgAmount,
      // Monthly-equivalent: bimonthly /2, quarterly /3, weekly ×4.33, etc.
      // Used in summaries and forecast so different cadences sum apples to apples.
      smoothedMonthly: avgAmount * (30 / cadence.days),
      lastSeen: last.date,
      nextExpected,
      occurrences: filtered.length,
      accountId: last.accountId,
      categoryId: last.categoryId,
      source: 'auto',
    })
  }
  return out
}

// ===== MANUAL: per-tx recurringFlag (acts at the vendor level) =====
// User flags one tx with 'monthly'/'bimonthly'/'quarterly'. We treat every
// other tx of the same vendor key as part of the same recurring entry.
// If multiple flags exist for the same vendor, the latest-dated tx wins.
// Outlier filter (|amount| > 2×mean) is applied before averaging.
function _getManualFlagRecurring() {
  const all = getTransactions()
  const flagByKey = {}
  for (const t of all) {
    if (!t.recurringFlag) continue
    if (t.recurringGroupId) continue
    if (t.recurringExcludeFromAuto) continue
    const key = _txVendorKey(t)
    if (!key) continue
    const cur = flagByKey[key]
    if (!cur || (t.date || '') > (cur.date || '')) {
      flagByKey[key] = { cadence: t.recurringFlag, date: t.date, ref: t }
    }
  }
  const ignoreOutliersSet = getIgnoreOutliersSet()
  const out = []
  for (const [key, info] of Object.entries(flagByKey)) {
    // Same vendor-key bucket as auto-detect: alias narrowing already applied
    // by _txVendorKey, so a tx that fails the alias's amount/day filter is
    // simply in a different (raw-vendor) bucket and not picked up here.
    const same = all.filter(t =>
      !t.recurringGroupId &&
      !t.recurringExcludeFromAuto &&
      t.type !== 'transfer' &&
      !t.ccPaymentForAccountId &&
      !t.transferAccountId &&
      _txVendorKey(t) === key
    )
    if (same.length === 0) continue
    const sorted = [...same].sort((a,b) => (a.date||'').localeCompare(b.date||''))
    const last = sorted[sorted.length-1]
    const cad = RECURRING_CADENCES[info.cadence] || RECURRING_CADENCES.monthly
    const { avg, periods } = _avgPerCadencePeriod(same, info.cadence, ignoreOutliersSet.has('mflag:' + key))
    const cadenceMonths = cad.days / 30  // 1 / 2 / 3
    out.push({
      key: 'mflag:' + key,
      sourceKey: key,
      vendor: resolveVendor(last.vendor, last.amount, getTxAliasDay(last)),
      cadence: info.cadence,
      cadenceLabel: cad.label,
      cadenceDays: cad.days,
      avgAmount: avg,
      smoothedMonthly: avg / cadenceMonths,
      lastSeen: last.date,
      nextExpected: _addDays(last.date, cad.days),
      occurrences: same.length,
      periods,
      accountId: last.accountId,
      categoryId: last.categoryId,
      source: 'manual-flag',
    })
  }
  return out
}

// ===== MANUAL: merged groups =====
// User selects N arbitrary tx in the tx screen → groups them into one labeled
// recurring entry. Each tx gets `recurringGroupId = group.id` and is hidden
// from the tx list (still counted in P&L / balance — same row, different view).
function getManualRecurringGroups() { return DB.get('finManualRecurringGroups', []) }
function saveManualRecurringGroups(list) { DB.set('finManualRecurringGroups', list) }

function createManualRecurringGroup({ label, cadence, txIds }) {
  if (!label || !cadence || !Array.isArray(txIds) || txIds.length === 0) return null
  if (!RECURRING_CADENCES[cadence]) return null
  const txs = getTransactions()
  const selectedSet = new Set(txIds)
  const selected = txs.filter(t => selectedSet.has(t.id))
  if (selected.length === 0) return null
  // The selected tx define the group's vendor-key membership. Any past or
  // future tx with one of these keys auto-joins the group, so the user
  // doesn't have to re-merge each month.
  const vendorKeys = [...new Set(
    selected.map(t => _txVendorKey(t)).filter(Boolean)
  )]
  const id = genId()
  const list = getManualRecurringGroups()
  list.push({
    id,
    label: String(label).trim(),
    cadence,
    vendorKeys,
    createdAt: Date.now(),
  })
  saveManualRecurringGroups(list)
  // Stamp every matching tx (selected + same-vendor past/future). Don't
  // poach tx that already belong to another group.
  let n = 0
  txs.forEach(t => {
    if (t.recurringGroupId) return
    const matches = selectedSet.has(t.id) ||
      (vendorKeys.length > 0 && vendorKeys.includes(_txVendorKey(t)))
    if (!matches) return
    t.recurringGroupId = id
    delete t.recurringFlag
    n++
  })
  if (n > 0) DB.set('finTransactions', txs)
  return { id, count: n, vendorKeys }
}

// Pulls in any un-grouped tx whose vendor key matches a group's vendorKeys.
// Called whenever recurring is computed so newly imported tx slot in
// without an explicit migration / import-time hook.
function _reconcileManualGroups() {
  const groups = getManualRecurringGroups().filter(g => Array.isArray(g.vendorKeys) && g.vendorKeys.length > 0)
  if (groups.length === 0) return 0
  const keyToGroup = {}
  for (const g of groups) for (const k of g.vendorKeys) keyToGroup[k] = g.id
  const txs = getTransactions()
  let n = 0
  for (const t of txs) {
    if (t.recurringGroupId) continue
    const k = _txVendorKey(t)
    if (k && keyToGroup[k]) {
      t.recurringGroupId = keyToGroup[k]
      delete t.recurringFlag
      n++
    }
  }
  if (n > 0) DB.set('finTransactions', txs)
  return n
}

// One-time backfill for groups created before v1.16.0 (no vendorKeys field).
// Derives the keys from the tx already stamped with each group's id, so
// the auto-include behaviour starts working without forcing the user to
// recreate their existing groups.
function migrateManualGroupVendorKeys_v1() {
  if (localStorage.getItem('migration_manual_group_vendor_keys_v1') === '1') return
  const groups = getManualRecurringGroups()
  if (groups.length === 0) {
    localStorage.setItem('migration_manual_group_vendor_keys_v1', '1')
    return
  }
  const txs = getTransactions()
  let changed = false
  for (const g of groups) {
    if (Array.isArray(g.vendorKeys) && g.vendorKeys.length > 0) continue
    const keys = new Set()
    for (const t of txs) {
      if (t.recurringGroupId !== g.id) continue
      const k = _txVendorKey(t)
      if (k) keys.add(k)
    }
    g.vendorKeys = [...keys]
    changed = true
  }
  if (changed) saveManualRecurringGroups(groups)
  localStorage.setItem('migration_manual_group_vendor_keys_v1', '1')
}

function getIgnoreOutliersSet() { return new Set(DB.get('finRecurringIgnoreOutliers', [])) }
function toggleIgnoreOutliers(key) {
  const s = getIgnoreOutliersSet()
  if (s.has(key)) s.delete(key); else s.add(key)
  DB.set('finRecurringIgnoreOutliers', [...s])
  renderRecurring()
  if (_drillKey === key) _renderDrillModal()
}
function toggleIgnoreOutliersDrill() { if (_drillKey) toggleIgnoreOutliers(_drillKey) }

function setRecurringTxExclude(txId, mode) {
  const txs = getTransactions()
  const t = txs.find(x => x.id === txId)
  if (!t) return
  if (mode === 'amount' || mode === 'period') {
    t.recurringExcludeMode = mode
    delete t.recurringExcludeFromAuto
  } else if (mode === 'out') {
    // Hard exclude: drop the tx from its vendor's auto-bucket entirely.
    // Soft exclude modes are mutually exclusive with this — clear them.
    t.recurringExcludeFromAuto = true
    delete t.recurringExcludeMode
  } else {
    delete t.recurringExcludeMode
    delete t.recurringExcludeFromAuto
  }
  DB.set('finTransactions', txs)
  renderRecurring()
  if (_drillKey) _renderDrillModal()
}

// ===== Per-bucket narrowing criteria =====
// Criteria live on the vendor alias itself (amountMin/Max + dayMin/Max). The
// alias unifies one or more raw vendor strings into a single displayName, and
// resolveVendor only emits that displayName when ALL of the alias's
// constraints pass — so the "criteria" and the "grouping" are the same object,
// editable from the settings screen ("איחוד ספקים") and from the drill modal.
//
// findOrSeedAliasForDrill: maps a drill key (the normalised displayName the
// recurring entry is keyed by) to the matching alias. If none exists yet we
// synthesise a seed alias from the bucket's most-frequent raw vendor so the
// drill's criteria editor always has something concrete to update.
function findAliasForDrillKey(drillKey) {
  return getVendorAliases().find(a =>
    normalizeVendorForAutocat(a.displayName || '') === drillKey
  ) || null
}

function _seedAliasForDrillKey(drillKey, vendorLabel) {
  // Pick the most common raw vendor under this key as the seed pattern,
  // falling back to the resolved label. lowercase + trim to match resolveVendor's
  // substring needle.
  const all = getTransactions().filter(t =>
    !t.recurringGroupId && !t.recurringExcludeFromAuto && _txVendorKey(t) === drillKey
  )
  const counts = new Map()
  for (const t of all) {
    const raw = String(t.vendor || '').trim().toLowerCase()
    if (!raw) continue
    counts.set(raw, (counts.get(raw) || 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const seedPattern = top || String(vendorLabel || drillKey).trim().toLowerCase()
  if (!seedPattern) return null
  return addVendorAlias([seedPattern], vendorLabel || drillKey)
}

function applyRecurringCriteriaFromDrill(drillKey, vendorLabel) {
  const f = id => document.getElementById(id)
  const amountMinRaw = f('drillCriteriaAmountMin')?.value
  const amountMaxRaw = f('drillCriteriaAmountMax')?.value
  const dayMinRaw    = f('drillCriteriaDayMin')?.value
  const dayMaxRaw    = f('drillCriteriaDayMax')?.value

  let alias = findAliasForDrillKey(drillKey) || _seedAliasForDrillKey(drillKey, vendorLabel)
  if (!alias) { toast('לא ניתן ליצור איחוד — אין עסקה עם שם ספק תקין.', { type: 'error' }); return }
  updateVendorAlias(
    alias.id,
    alias.patterns,
    alias.displayName,
    amountMinRaw,
    amountMaxRaw,
    dayMinRaw,
    dayMaxRaw,
  )
  renderRecurring()
  if (_drillKey) _renderDrillModal()
}

function clearRecurringCriteriaFromDrill(drillKey) {
  const alias = findAliasForDrillKey(drillKey)
  if (!alias) return
  // Strip the narrowing fields but keep the alias itself (patterns + displayName)
  // so the bucket label doesn't suddenly fall apart back to raw vendors.
  updateVendorAlias(alias.id, alias.patterns, alias.displayName, null, null, null, null)
  renderRecurring()
  if (_drillKey) _renderDrillModal()
}

function setRecurringTxPeriodOverride(txId, ym) {
  const txs = getTransactions()
  const t = txs.find(x => x.id === txId)
  if (!t) return
  if (ym && /^\d{4}-\d{2}$/.test(ym)) t.recurringPeriodOverride = ym + '-01'
  else delete t.recurringPeriodOverride
  DB.set('finTransactions', txs)
  renderRecurring()
  if (_drillKey) _renderDrillModal()
}

// Human-readable label for a cadence period bucket. Used to show the user
// which month/quarter a tx contributes to (especially after period override).
function _formatPeriodLabel(iso, cadence) {
  if (!iso) return ''
  const [y, m] = iso.split('-').map(Number)
  if (!y || !m) return iso
  if (cadence === 'quarterly') return `Q${Math.floor((m-1)/3)+1} ${y}`
  if (cadence === 'bimonthly') return `B${Math.floor((m-1)/2)+1} ${y}`
  return `${String(m).padStart(2,'0')}/${y}`
}

function unmergeManualRecurringGroup(groupId) {
  const list = getManualRecurringGroups().filter(g => g.id !== groupId)
  saveManualRecurringGroups(list)
  const txs = getTransactions()
  let n = 0
  txs.forEach(t => {
    if (t.recurringGroupId === groupId) { delete t.recurringGroupId; n++ }
  })
  if (n > 0) DB.set('finTransactions', txs)
  // Scrub per-entry state keyed by the now-dead group key so it doesn't
  // linger in storage (hidden flag, overrides, outlier toggle).
  const gKey = 'mgroup:' + groupId
  const hidden = getHiddenRecurring()
  if (hidden.has(gKey)) { hidden.delete(gKey); setHiddenRecurring(hidden) }
  const amtOv = getRecurringAmountOverrides()
  if (gKey in amtOv) { delete amtOv[gKey]; setRecurringAmountOverrides(amtOv) }
  const cadOv = getRecurringCadenceOverrides()
  if (gKey in cadOv) { delete cadOv[gKey]; DB.set('finRecurringCadenceOverride', cadOv) }
  const ign = getIgnoreOutliersSet()
  if (ign.has(gKey)) { ign.delete(gKey); DB.set('finRecurringIgnoreOutliers', [...ign]) }
  return n
}

function clearRecurringFlagForVendorKey(vendorKey) {
  const txs = getTransactions()
  let n = 0
  txs.forEach(t => {
    if (t.recurringFlag && _txVendorKey(t) === vendorKey) {
      delete t.recurringFlag
      n++
    }
  })
  if (n > 0) DB.set('finTransactions', txs)
  return n
}

function _getManualGroupRecurring() {
  const groups = getManualRecurringGroups()
  if (groups.length === 0) return []
  const all = getTransactions()
  const ignoreOutliersSet = getIgnoreOutliersSet()
  const out = []
  for (const g of groups) {
    const txs = all.filter(t => t.recurringGroupId === g.id)
    if (txs.length === 0) continue
    const sorted = [...txs].sort((a,b) => (a.date||'').localeCompare(b.date||''))
    const last = sorted[sorted.length-1]
    const cad = RECURRING_CADENCES[g.cadence] || RECURRING_CADENCES.monthly
    const { avg, periods } = _avgPerCadencePeriod(txs, g.cadence, ignoreOutliersSet.has('mgroup:' + g.id))
    const cadenceMonths = cad.days / 30
    out.push({
      key: 'mgroup:' + g.id,
      groupId: g.id,
      vendor: g.label,
      cadence: g.cadence,
      cadenceLabel: cad.label,
      cadenceDays: cad.days,
      avgAmount: avg,
      smoothedMonthly: avg / cadenceMonths,
      lastSeen: last.date,
      nextExpected: _addDays(last.date, cad.days),
      occurrences: txs.length,
      periods,
      accountId: g.accountId || last.accountId,
      categoryId: g.categoryId || last.categoryId,
      source: 'manual-group',
    })
  }
  return out
}

// Unified recurring list (auto + manual flag + manual group). Manual entries
// override auto ones with the same vendor key (user's explicit signal wins).
// When a manual group absorbs tx that previously fed an auto-detected entry,
// the hidden key changes from the vendor string to 'mgroup:<id>'. This pass
// migrates any stale vendor-key entries in finRecurringHidden to the current
// group key so items that were hidden stay hidden after absorption.
function _migrateHiddenRecurringKeys() {
  const hidden = getHiddenRecurring()
  if (hidden.size === 0) return
  const groups = getManualRecurringGroups()
  let changed = false
  for (const g of groups) {
    if (!Array.isArray(g.vendorKeys) || g.vendorKeys.length === 0) continue
    const gKey = 'mgroup:' + g.id
    for (const vk of g.vendorKeys) {
      if (hidden.has(vk) && !hidden.has(gKey)) {
        hidden.delete(vk)
        hidden.add(gKey)
        changed = true
      }
      // also handle mflag: prefix from a previous manual-flag hidden entry
      const mfKey = 'mflag:' + vk
      if (hidden.has(mfKey) && !hidden.has(gKey)) {
        hidden.delete(mfKey)
        hidden.add(gKey)
        changed = true
      }
    }
  }
  if (changed) setHiddenRecurring(hidden)
}

// ===== REPRESENTATIVE AMOUNT OVERRIDE =====
// By default a recurring entry's amount is a smoothed average. Some expenses
// shouldn't be smoothed — e.g. a mortgage payment that climbs each month until
// the principal is fully drawn, then stabilises. The user can override the
// average per entry (keyed by r.key) with either:
//   - mode 'manual': a per-occurrence amount typed in by hand.
//   - mode 'pick'  : the amount of one chosen past payment (txId kept for UI).
// In both cases `amount` is the per-OCCURRENCE figure (same basis as avgAmount,
// sign preserved); smoothedMonthly is re-derived from it.
function getRecurringAmountOverrides() { return DB.get('finRecurringAmountOverride', {}) }
function setRecurringAmountOverrides(obj) { DB.set('finRecurringAmountOverride', obj) }

// Natural sign (+income / -expense) of an entry, so a hand-typed magnitude
// lands on the correct side regardless of how the user enters it.
function _recurringSignFor(key) {
  const e = getAllRecurring().find(r => r.key === key)
  return (e && e.avgAmount < 0) ? -1 : 1
}

function applyRecurringManualAmount(key) {
  const raw = document.getElementById('drillManualAmount')?.value
  const n = parseFloat(raw)
  if (!isFinite(n) || n === 0) { toast('הזן סכום תקין.', { type: 'error' }); return }
  const ov = getRecurringAmountOverrides()
  ov[key] = { mode: 'manual', amount: _recurringSignFor(key) * Math.abs(n) }
  setRecurringAmountOverrides(ov)
  renderRecurring()
  if (_drillKey) _renderDrillModal()
}

function pickRecurringRepresentative(key, txId) {
  const t = getTransactions().find(x => x.id === txId)
  if (!t) return
  const ov = getRecurringAmountOverrides()
  ov[key] = { mode: 'pick', amount: t.amount, txId }
  setRecurringAmountOverrides(ov)
  renderRecurring()
  if (_drillKey) _renderDrillModal()
}

function clearRecurringAmountOverride(key) {
  const ov = getRecurringAmountOverrides()
  if (!(key in ov)) return
  delete ov[key]
  setRecurringAmountOverrides(ov)
  renderRecurring()
}
function clearRecurringAmountOverrideDrill() {
  if (_drillKey) { clearRecurringAmountOverride(_drillKey); _renderDrillModal() }
}

// Replaces avgAmount / smoothedMonthly with the user's representative figure.
// Monthly-equivalent re-derived the same way detection does it (×30/cadenceDays).
function _applyAmountOverrides(items) {
  const ov = getRecurringAmountOverrides()
  if (!ov || Object.keys(ov).length === 0) return items
  for (const r of items) {
    const o = ov[r.key]
    if (!o || typeof o.amount !== 'number') continue
    r.avgAmount = o.amount
    r.smoothedMonthly = o.amount * (30 / (r.cadenceDays || 30))
    r.amountOverride = o
  }
  return items
}

// ===== CADENCE OVERRIDE =====
// Auto-detection sometimes mis-classifies how often an item recurs. The user
// can pin the cadence per entry (keyed by r.key); it wins over the detected /
// flagged cadence: relabel, re-derive the monthly-equivalent from the
// per-occurrence avg, and shift the next-expected date.
function getRecurringCadenceOverrides() { return DB.get('finRecurringCadenceOverride', {}) }

function setRecurringCadenceOverride(key, cadence) {
  const ov = getRecurringCadenceOverrides()
  if (cadence && RECURRING_CADENCES[cadence]) ov[key] = cadence
  else delete ov[key]
  DB.set('finRecurringCadenceOverride', ov)
  renderRecurring()
  if (_drillKey) _renderDrillModal()
}

function clearRecurringCadenceOverride(key) {
  const ov = getRecurringCadenceOverrides()
  if (!(key in ov)) return
  delete ov[key]
  DB.set('finRecurringCadenceOverride', ov)
  renderRecurring()
  if (_drillKey) _renderDrillModal()
}

function _applyCadenceOverrides(items) {
  const ov = getRecurringCadenceOverrides()
  if (!ov || Object.keys(ov).length === 0) return items
  for (const r of items) {
    const cad = RECURRING_CADENCES[ov[r.key]]
    if (!cad) continue
    r.cadence = ov[r.key]
    r.cadenceLabel = cad.label
    r.cadenceDays = cad.days
    r.smoothedMonthly = (r.avgAmount || 0) * (30 / cad.days)
    r.nextExpected = _addDays(r.lastSeen, cad.days)
    r.cadenceOverride = true
  }
  return items
}

// Current calendar month as 'YYYY-MM' — the reference point for deciding
// whether an installment plan is still active (has/expects a charge this month).
function _curYM() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Drop recurring entries whose installment plan has finished — i.e. the last
// billing month is before the current month, so no charge is expected now.
// A finished plan is KEPT only if the vendor has recurring activity AFTER the
// plan ended (lastSeen later than the final month), meaning it's a genuine
// ongoing recurring expense that merely happened to include installments.
function _dropFinishedInstallments(items) {
  const now = _curYM()
  return items.filter(r => {
    if (!r.installmentFinalMonth) return true
    if (r.installmentFinalMonth >= now) return true
    const lastSeenMonth = (r.lastSeen || '').slice(0, 7)
    return lastSeenMonth && lastSeenMonth > r.installmentFinalMonth
  })
}

// Synthetic recurring entries for active installment plans — surfaces a plan
// in the recurring screen even before it accumulates the 3 occurrences that
// auto-detection requires. Skipped when an auto/manual entry already covers
// the same vendor key (those win and get _attachInstallmentInfo annotation).
function _getInstallmentRecurring(coveredKeys) {
  const all = getTransactions().filter(t =>
    t.installmentCurrent && t.installmentTotal &&
    !t.recurringGroupId &&
    !t.recurringExcludeFromAuto &&
    t.type !== 'transfer'
  )
  if (all.length === 0) return []
  const groups = {}
  for (const t of all) {
    const k = _txVendorKey(t)
    if (!k) continue
    if (coveredKeys && coveredKeys.has(k)) continue
    if (!groups[k]) groups[k] = []
    groups[k].push(t)
  }
  const out = []
  for (const [key, txs] of Object.entries(groups)) {
    txs.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    const latest = txs[0]
    // Plan already finished — the last charge month is in the past, so there
    // are no current/future charges to forecast. We prefer the final billing
    // month (handles plans whose charges aren't all imported yet) and fall back
    // to the current>=total count when no final month is recorded.
    const fm = latest.installmentFinalMonth || ''
    if (fm) { if (fm < _curYM()) continue }
    else if (latest.installmentCurrent >= latest.installmentTotal) continue
    const cad = RECURRING_CADENCES.monthly
    const avg = txs.reduce((s, t) => s + (t.amount || 0), 0) / txs.length
    out.push({
      key: 'installment:' + key,
      sourceKey: key,
      vendor: resolveVendor(latest.vendor, latest.amount, getTxAliasDay(latest)) || latest.vendor || key,
      cadence: 'monthly',
      cadenceLabel: cad.label,
      cadenceDays: cad.days,
      avgAmount: avg,
      smoothedMonthly: avg,
      lastSeen: latest.date,
      nextExpected: _addDays(latest.date, cad.days),
      occurrences: txs.length,
      accountId: latest.accountId,
      categoryId: latest.categoryId,
      source: 'installment',
      installmentCurrent: latest.installmentCurrent,
      installmentTotal: latest.installmentTotal,
      installmentFinalMonth: latest.installmentFinalMonth || '',
    })
  }
  return out
}

// Installment annotations — looks at the underlying tx for each recurring
// entry. If any of them carry installmentCurrent/Total, surface the latest
// (current, total, finalMonth) so the recurring row can show when the plan
// ends. We pick the most recent installment-carrying tx because that's the
// "where are we now" position the user expects to see.
function _attachInstallmentInfo(items) {
  const all = getTransactions()
  for (const r of items) {
    let pool
    if (typeof r.key === 'string' && r.key.startsWith('mgroup:')) {
      const gid = r.key.slice('mgroup:'.length)
      pool = all.filter(t => t.recurringGroupId === gid)
    } else {
      const vk = (typeof r.key === 'string' && r.key.startsWith('mflag:'))
        ? r.key.slice('mflag:'.length) : r.sourceKey || r.key
      pool = all.filter(t => !t.recurringGroupId && _txVendorKey(t) === vk)
    }
    const withInst = pool.filter(t => t.installmentCurrent && t.installmentTotal)
    if (withInst.length === 0) continue
    withInst.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    const latest = withInst[0]
    r.installmentCurrent = latest.installmentCurrent
    r.installmentTotal   = latest.installmentTotal
    r.installmentFinalMonth = latest.installmentFinalMonth || ''
  }
  return items
}

// Reconciles manual groups first so newly-imported tx with a matching vendor
// are absorbed before the auto pass sees them.
//
// Memoized by the revision counters of every input the pipeline reads —
// summary callers (dashboard / analysis / tx screen) used to re-run the whole
// detection on every render. The rev key is computed AFTER the body because
// _reconcileManualGroups may itself write finTransactions; capturing the
// post-write rev keeps the very next call a cache hit. Result entries are
// treated as read-only by all callers.
const _RECURRING_REV_KEYS = ['finTransactions', 'finAccounts', 'finVendorAliases',
  'finManualRecurringGroups', 'finRecurringHidden', 'finRecurringIgnoreOutliers',
  'finRecurringAmountOverride', 'finRecurringCadenceOverride']
let _recurringCache = null
let _recurringCacheRev = null
function _recurringRev() {
  if (typeof DB.rev !== 'function') return null
  // Day stamp: parts of the pipeline read "today" (12-month window,
  // finished-installment cutoff) — a PWA left open across midnight must
  // not serve yesterday's result.
  return new Date().toDateString() + '|' + _RECURRING_REV_KEYS.map(k => DB.rev(k)).join(':')
}
function getAllRecurring() {
  const revBefore = _recurringRev()
  if (revBefore !== null && _recurringCache && _recurringCacheRev === revBefore) return _recurringCache
  _reconcileManualGroups()
  _migrateHiddenRecurringKeys()
  const auto         = detectRecurring()
  const manualFlags  = _getManualFlagRecurring()
  const manualGroups = _getManualGroupRecurring()
  const overrideKeys = new Set(manualFlags.map(m => m.sourceKey))
  const autoKept = auto.filter(a => !overrideKeys.has(a.sourceKey))
  const covered = new Set([
    ...autoKept.map(a => a.sourceKey),
    ...manualFlags.map(m => m.sourceKey),
  ])
  const installments = _getInstallmentRecurring(covered)
  const annotated = _attachInstallmentInfo(
      _applyCadenceOverrides(_applyAmountOverrides([...autoKept, ...manualFlags, ...manualGroups, ...installments])))
  const result = _dropFinishedInstallments(annotated)
    .sort((a,b) => Math.abs(b.smoothedMonthly) - Math.abs(a.smoothedMonthly))
  const revAfter = _recurringRev()
  if (revAfter !== null) { _recurringCache = result; _recurringCacheRev = revAfter }
  return result
}

// Monthly-equivalent income/expense/net of NON-HIDDEN recurring entries.
// Used by dashboard / analysis / recurring-screen summaries.
function recurringMonthlyTotals() {
  const items = getAllRecurring()
  const hidden = getHiddenRecurring()
  let income = 0, expense = 0
  for (const r of items) {
    if (hidden.has(r.key)) continue
    if (r.smoothedMonthly > 0) income += r.smoothedMonthly
    else expense += Math.abs(r.smoothedMonthly)
  }
  return { income, expense, net: income - expense, count: items.filter(r => !hidden.has(r.key)).length }
}

// Unified recurring list. Recomputed each call (linear in tx count, fast
// enough); manual flags / merges need to reflect immediately so the cache
// that detectRecurring used to keep is no longer worth it.
function getRecurring() { return getAllRecurring() }
function refreshRecurring() { return getAllRecurring() }

// ===== HIDDEN RECURRING =====
function getHiddenRecurring() { return new Set(DB.get('finRecurringHidden', [])) }
function setHiddenRecurring(setObj) { DB.set('finRecurringHidden', [...setObj]) }
function hideRecurring(key) { const s = getHiddenRecurring(); s.add(key); setHiddenRecurring(s); renderRecurring() }
function unhideRecurring(key) { const s = getHiddenRecurring(); s.delete(key); setHiddenRecurring(s); renderRecurring() }

let _recShowHidden = false
let _recFlowMode = 'expense'  // 'expense' | 'income' — sticky toggle
let _recInstallmentsOnly = false  // sticky filter: show only installment plans
function toggleShowHiddenRecurring() { _recShowHidden = !_recShowHidden; renderRecurring() }
function setRecurringFlowMode(mode) { _recFlowMode = mode; renderRecurring() }
function toggleRecurringInstallmentsOnly() { _recInstallmentsOnly = !_recInstallmentsOnly; renderRecurring() }
function _isInstallmentEntry(r) { return r.source === 'installment' || !!(r.installmentCurrent && r.installmentTotal) }

// Recurring rows carry arbitrary Hebrew / punctuation in `key`, which breaks
// inline onclick attribute string-escaping. We keep a render-time map from a
// safe index string to the real key and use data-idx + event delegation.
let _recKeyMap = {}

// ===== RECURRING SCREEN =====
function renderRecurring() {
  if (typeof IS_MOBILE_UI !== 'undefined' && IS_MOBILE_UI && typeof M_renderRecurring === 'function') return M_renderRecurring()
  const items = getAllRecurring()
  const container = document.getElementById('recurringList')
  if (!container) return

  const hidden = getHiddenRecurring()
  const expenseItems = items.filter(r => r.smoothedMonthly < 0)
  const incomeItems  = items.filter(r => r.smoothedMonthly > 0)
  const installmentCount = items.filter(_isInstallmentEntry).length
  let bucket = _recFlowMode === 'income' ? incomeItems : expenseItems
  if (_recInstallmentsOnly) bucket = bucket.filter(_isInstallmentEntry)

  const visible    = bucket.filter(r => !hidden.has(r.key))
  const hiddenList = bucket.filter(r =>  hidden.has(r.key))

  // Rebuild the idx→key map for this render.
  _recKeyMap = {}
  items.forEach((r, i) => { _recKeyMap['k' + i] = r.key })
  const idxOf = r => Object.keys(_recKeyMap).find(k => _recKeyMap[k] === r.key)

  // Top summary — monthly-equivalent of all non-hidden recurring entries.
  const totals = recurringMonthlyTotals()
  const summary = `
    <div class="recurring-summary">
      <div class="recurring-summary-card">
        <span class="recurring-summary-label">הוצאות קבועות (חודשי שקול)</span>
        <span class="recurring-summary-val expense-color">-${formatCurrency(totals.expense)}</span>
      </div>
      <div class="recurring-summary-card">
        <span class="recurring-summary-label">הכנסות קבועות (חודשי שקול)</span>
        <span class="recurring-summary-val income-color">+${formatCurrency(totals.income)}</span>
      </div>
      <div class="recurring-summary-card">
        <span class="recurring-summary-label">נטו חודשי שקול</span>
        <span class="recurring-summary-val ${totals.net>=0?'income-color':'expense-color'}">${totals.net>=0?'+':''}${formatCurrency(totals.net)}</span>
      </div>
    </div>`

  const modeLabel = _recFlowMode === 'income' ? 'הכנסות' : 'הוצאות'
  const toggle = `
    <div class="recurring-mode-toggle">
      <button class="mode-btn ${_recFlowMode==='expense'?'active':''}" onclick="setRecurringFlowMode('expense')">📉 הוצאות קבועות <span class="mode-count">${expenseItems.length}</span></button>
      <button class="mode-btn ${_recFlowMode==='income'?'active':''}" onclick="setRecurringFlowMode('income')">📈 הכנסות קבועות <span class="mode-count">${incomeItems.length}</span></button>
    </div>`

  const toolbar = `
    <div class="recurring-toolbar">
      <div style="color:var(--text-muted);font-size:.85rem">${visible.length} ${modeLabel} פעילות · ${hiddenList.length} מוסתרות</div>
      <div style="display:flex;gap:.4rem;align-items:center">
        ${installmentCount > 0 ? `<button class="btn-ghost ${_recInstallmentsOnly?'active':''}" onclick="toggleRecurringInstallmentsOnly()" title="הצג רק עסקאות תשלומים פעילות">💳 תשלומים בלבד${_recInstallmentsOnly?' ✓':''}</button>` : ''}
        ${hiddenList.length > 0 ? `<button class="btn-ghost" onclick="toggleShowHiddenRecurring()">${_recShowHidden?'הסתר מוסתרות':'הצג מוסתרות'}</button>` : ''}
      </div>
    </div>`

  if (items.length === 0) {
    container.innerHTML = summary + toggle +
      '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:3rem">לא זוהו הוצאות/הכנסות קבועות. נדרשות לפחות 3 עסקאות חוזרות לאותו ספק, או סמן עסקה ידנית.</p>'
    return
  }

  const buildRow = (r, isHidden = false) => {
    const idx = idxOf(r)
    const amountCls = r.smoothedMonthly > 0 ? 'amount-inc' : 'amount-exp'
    const sourceBadge = r.source === 'manual-group'
      ? '<span class="type-badge type-refund" title="קבוצה ידנית מאוחדת">📦 ידנית</span>'
      : r.source === 'manual-flag'
      ? '<span class="type-badge type-refund" title="סומן ידנית">✋ ידנית</span>'
      : r.source === 'installment'
      ? '<span class="type-badge type-transfer" title="עסקת תשלומים שזוהתה מדוח האשראי">💳 תשלומים</span>'
      : ''
    // Installment plans appear as recurring once they hit the 3-occurrence
    // threshold. Surface "where in the plan we are" and the final billing
    // month so the user can see when the recurring entry will stop counting.
    const installmentBadge = (r.installmentCurrent && r.installmentTotal)
      ? (() => {
          const fm = r.installmentFinalMonth || ''
          const fmDisp = fm ? (fm.slice(5) + '/' + fm.slice(0,4)) : ''
          const title = `תשלומים — נכון לתשלום ${r.installmentCurrent} מתוך ${r.installmentTotal}${fmDisp?` · מסתיים ${fmDisp}`:''}`
          return `<span class="type-badge type-transfer" title="${title}" style="margin-inline-start:.3rem">💳 ${r.installmentCurrent}/${r.installmentTotal}${fmDisp?` · עד ${fmDisp}`:''}</span>`
        })()
      : ''
    // Smoothed (monthly-equivalent) is the primary number; show the
    // raw per-occurrence amount underneath when the cadence isn't monthly.
    const showSmoothNote = r.cadenceDays !== 30
    const smoothNote = showSmoothNote
      ? `<div style="font-size:.7rem;color:var(--text-muted);margin-top:.15rem">${r.avgAmount>0?'+':''}${formatCurrency(r.avgAmount)} ל${r.cadenceLabel}</div>`
      : ''
    const overrideNote = r.amountOverride
      ? `<div style="font-size:.7rem;color:var(--accent);margin-top:.15rem">📌 סכום מייצג${r.amountOverride.mode==='pick'?' (תשלום נבחר)':' (ידני)'}</div>`
      : ''
    // Manual entries get a tailored secondary action (unmerge / clear flag).
    const manualAction = r.source === 'manual-group'
      ? `<button class="btn-ghost" style="font-size:.7rem;padding:.25rem .55rem;margin-inline-start:.3rem" onclick="event.stopPropagation();unmergeManualRecurringByIdx('${idx}')" title="פרק את הקבוצה">פרק</button>`
      : r.source === 'manual-flag'
      ? `<button class="btn-ghost" style="font-size:.7rem;padding:.25rem .55rem;margin-inline-start:.3rem" onclick="event.stopPropagation();clearRecurringFlagByIdx('${idx}')" title="הסר סימון ידני">בטל סימון</button>`
      : ''
    return `
      <tr class="recurring-row ${isHidden?'recurring-row-hidden':''}" onclick="openRecurringDrillByIdx('${idx}')">
        <td class="rec-cell-main" style="font-weight:500">${escHtml(r.vendor)} ${sourceBadge}${installmentBadge}
          <div class="rec-meta-mobile"><span class="type-badge type-income">${r.cadenceLabel}</span><span>הבא: ${formatDate(r.nextExpected)}</span><span>${r.occurrences} מופעים</span></div>
        </td>
        <td class="rec-cell-sec"><span class="type-badge type-income">${r.cadenceLabel}</span></td>
        <td class="${amountCls} rec-cell-amount">${r.smoothedMonthly>0?'+':''}${formatCurrency(r.smoothedMonthly)}${smoothNote}${overrideNote}</td>
        <td class="rec-cell-sec">${formatDate(r.lastSeen)}</td>
        <td class="rec-cell-sec">${formatDate(r.nextExpected)}</td>
        <td class="rec-cell-sec" title="${r.periods && r.periods !== r.occurrences ? r.occurrences + ' עסקאות לאורך ' + r.periods + ' תקופות' : r.occurrences + ' מופעים'}">${r.periods && r.periods !== r.occurrences ? `${r.occurrences} <span style="color:var(--text-muted);font-size:.7rem">(${r.periods})</span>` : r.occurrences}</td>
        <td class="rec-cell-act" onclick="event.stopPropagation()">
          ${isHidden
            ? `<button class="btn-ghost" style="font-size:.75rem;padding:.3rem .6rem" onclick="unhideRecurringByIdx('${idx}')">שחזר</button>`
            : `<button class="btn-ghost" style="font-size:.75rem;padding:.3rem .6rem" onclick="hideRecurringByIdx('${idx}')">הסתר</button>`}
          ${manualAction}
        </td>
      </tr>`
  }

  const visibleTable = visible.length === 0
    ? `<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:2rem">אין ${modeLabel} קבועות${bucket.length>0?' (כולן מוסתרות)':''}.</p>`
    : `<table class="data-table recurring-table">
        <thead><tr>
          <th>ספק</th><th>תדירות</th><th>חודשי שקול</th>
          <th>מופע אחרון</th><th>מופע הבא</th><th>מופעים</th><th></th>
        </tr></thead>
        <tbody>${visible.map(r => buildRow(r, false)).join('')}</tbody>
      </table>`

  const hiddenBlock = (_recShowHidden && hiddenList.length > 0)
    ? `<div class="card-title" style="margin-top:1.5rem">מוסתרות (${hiddenList.length})</div>
       <table class="data-table recurring-table">
        <thead><tr>
          <th>ספק</th><th>תדירות</th><th>חודשי שקול</th>
          <th>מופע אחרון</th><th>מופע הבא</th><th>מופעים</th><th></th>
        </tr></thead>
        <tbody>${hiddenList.map(r => buildRow(r, true)).join('')}</tbody>
       </table>`
    : ''

  container.innerHTML = summary + toggle + toolbar + visibleTable + hiddenBlock
}

// Thin wrappers that resolve an idx→key via _recKeyMap — avoids escaping Hebrew
// or punctuation inside inline onclick attributes.
function hideRecurringByIdx(idx)   { const k = _recKeyMap[idx]; if (k) hideRecurring(k) }
function unhideRecurringByIdx(idx) { const k = _recKeyMap[idx]; if (k) unhideRecurring(k) }
function openRecurringDrillByIdx(idx) { const k = _recKeyMap[idx]; if (k) openRecurringDrill(k) }

async function unmergeManualRecurringByIdx(idx) {
  const k = _recKeyMap[idx]
  if (!k || !k.startsWith('mgroup:')) return
  const groupId = k.slice('mgroup:'.length)
  if (!await confirmDialog('לפרק את הקבוצה? העסקאות יחזרו להופיע ברשימת העסקאות הרגילה.', { confirmText: 'פרק' })) return
  unmergeManualRecurringGroup(groupId)
  renderRecurring()
}

async function clearRecurringFlagByIdx(idx) {
  const k = _recKeyMap[idx]
  if (!k || !k.startsWith('mflag:')) return
  const vendorKey = k.slice('mflag:'.length)
  if (!await confirmDialog('להסיר את הסימון הידני? אם הספק עדיין חוזר באופן קבוע, הוא ימשיך להופיע מזיהוי אוטומטי.', { confirmText: 'הסר סימון' })) return
  clearRecurringFlagForVendorKey(vendorKey)
  renderRecurring()
}

// ===== DRILL-DOWN =====
let _drillKey = null
let _drillRange = '3m'  // '3m' | '6m' | '12m' | 'custom'
let _drillCustomStart = ''
let _drillCustomEnd = ''

function openRecurringDrill(key) {
  _drillKey = key
  _drillRange = '3m'
  _drillCustomStart = ''
  _drillCustomEnd = ''
  _renderDrillModal()
  document.getElementById('recurringDrillModal').classList.add('open')
}

function closeRecurringDrill() {
  document.getElementById('recurringDrillModal').classList.remove('open')
  _drillKey = null
}

function setDrillRange(range) { _drillRange = range; _renderDrillModal() }

function _getDrillBounds() {
  const now = new Date()
  const end = _iso(now)
  if (_drillRange === 'custom') {
    return { start: _drillCustomStart || _iso(new Date(now.getFullYear(), now.getMonth()-3, 1)), end: _drillCustomEnd || end }
  }
  const monthsBack = _drillRange === '12m' ? 12 : _drillRange === '6m' ? 6 : 3
  return { start: _iso(new Date(now.getFullYear(), now.getMonth() - monthsBack, 1)), end }
}

function applyDrillCustom() {
  _drillCustomStart = _dmyToIso(document.getElementById('drillCustomStart').value)
  _drillCustomEnd   = _dmyToIso(document.getElementById('drillCustomEnd').value)
  _drillRange = 'custom'
  _renderDrillModal()
}

function _renderDrillModal() {
  if (!_drillKey) return
  // Drill key encoding: 'mgroup:<id>' (manual merge), 'mflag:<vendorKey>'
  // (manual flag), or the bare vendor key for an auto-detected entry.
  let allTx, vendor
  if (_drillKey.startsWith('mgroup:')) {
    const gid = _drillKey.slice('mgroup:'.length)
    allTx = getTransactions().filter(t => t.recurringGroupId === gid)
    const g = getManualRecurringGroups().find(g => g.id === gid)
    vendor = g?.label || gid
  } else if (_drillKey.startsWith('mflag:') || _drillKey.startsWith('installment:')) {
    const prefix = _drillKey.startsWith('mflag:') ? 'mflag:' : 'installment:'
    const vk = _drillKey.slice(prefix.length)
    allTx = getTransactions().filter(t =>
      !t.recurringGroupId && _txVendorKey(t) === vk
    )
    vendor = (allTx[0] && resolveVendor(allTx[0].vendor, allTx[0].amount, getTxAliasDay(allTx[0]))) || vk
  } else {
    allTx = getTransactions().filter(t =>
      !t.recurringGroupId && _txVendorKey(t) === _drillKey
    )
    vendor = (allTx[0] && resolveVendor(allTx[0].vendor, allTx[0].amount, getTxAliasDay(allTx[0]))) || _drillKey
  }
  document.getElementById('drillTitle').textContent = `היסטוריית "${vendor}"`

  const curEntry = getAllRecurring().find(r => r.key === _drillKey) || {}
  const cadence = curEntry.cadence || 'monthly'
  const amountOverride = getRecurringAmountOverrides()[_drillKey]
  const cadenceOpts = Object.entries(RECURRING_CADENCES)
    .map(([k, v]) => `<option value="${k}" ${cadence === k ? 'selected' : ''}>${v.label}</option>`).join('')

  const { start, end } = _getDrillBounds()
  const filtered = allTx
    .filter(t => t.date && t.date >= start && t.date <= end)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  const totalAmount = filtered.reduce((s, t) => s + t.amount, 0)
  const totalAbs = filtered.reduce((s, t) => s + Math.abs(t.amount), 0)
  const avg = filtered.length > 0 ? totalAmount / filtered.length : 0
  const isIgnoringOutliers = getIgnoreOutliersSet().has(_drillKey)

  const rangeBtn = (key, label) =>
    `<button class="period-btn ${_drillRange===key?'active':''}" onclick="setDrillRange('${key}')">${label}</button>`

  const customRow = _drillRange === 'custom' ? `
    <div class="period-custom" style="display:flex;margin-top:.5rem">
      <label class="form-label" style="margin:0">מ:</label>
      <input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" id="drillCustomStart" value="${_isoToDmy(_drillCustomStart || start)}" oninput="_onDateMaskInput(this)">
      <label class="form-label" style="margin:0">עד:</label>
      <input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" id="drillCustomEnd" value="${_isoToDmy(_drillCustomEnd || end)}" oninput="_onDateMaskInput(this)">
      <button class="btn-primary" style="padding:.35rem .9rem" onclick="applyDrillCustom()">החל</button>
    </div>` : ''

  const rows = filtered.length === 0
    ? `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-muted)">אין עסקאות בתקופה</td></tr>`
    : filtered.map(t => {
        const cat = getCategoryById(t.categoryId)
        const mode = t.recurringExcludeFromAuto ? 'out' : (t.recurringExcludeMode || '')
        const overrideYm = t.recurringPeriodOverride ? t.recurringPeriodOverride.slice(0,7) : ''
        const effectiveDate = t.recurringPeriodOverride || t.date
        const periodLabel = _formatPeriodLabel(effectiveDate, cadence)
        const periodChanged = !!t.recurringPeriodOverride
        const rowMuted = mode ? 'opacity:.55' : ''
        const periodBadge = `<div style="font-size:.7rem;${periodChanged?'color:var(--accent)':'color:var(--text-muted)'};margin-top:.15rem">${periodChanged?'→ ':''}${periodLabel}</div>`
        return `
          <tr style="${rowMuted}">
            <td>${formatDate(t.date)}${periodBadge}</td>
            <td style="font-weight:500">${escHtml(resolveVendor(t.vendor, t.amount, getTxAliasDay(t)) || '—')}</td>
            <td>${cat ? `<span class="cat-badge" style="background:${cat.color}22;color:${cat.color}">${catIconHTML(cat)} ${escHtml(cat.name)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td class="${t.amount>0?'amount-inc':'amount-exp'}" style="font-weight:600">${t.amount>0?'+':''}${formatCurrency(t.amount)}</td>
            <td style="min-width:9.5rem">
              <input type="month" value="${overrideYm}" onchange="setRecurringTxPeriodOverride('${t.id}', this.value)" style="font-size:.85rem;padding:.3rem .4rem;width:9rem">
            </td>
            <td style="min-width:9rem">
              <select onchange="setRecurringTxExclude('${t.id}', this.value)" style="font-size:.85rem;padding:.3rem .45rem;min-width:8.5rem;width:100%">
                <option value="" ${mode===''?'selected':''}>נספר</option>
                <option value="amount" ${mode==='amount'?'selected':''}>בלי סכום</option>
                <option value="period" ${mode==='period'?'selected':''}>דלג על תקופה</option>
                <option value="out" ${mode==='out'?'selected':''}>מחוץ לקיבוץ</option>
              </select>
            </td>
            <td style="text-align:center;min-width:5.5rem">
              ${(amountOverride && amountOverride.mode==='pick' && amountOverride.txId===t.id)
                ? '<span style="color:var(--accent);font-size:.78rem;font-weight:600">📌 מייצג</span>'
                : `<button class="btn-ghost" style="font-size:.72rem;padding:.25rem .5rem" onclick="pickRecurringRepresentative('${_drillKey}','${t.id}')" title="קבע תשלום זה כסכום המייצג">בחר כמייצג</button>`}
            </td>
          </tr>`
      }).join('')

  // Criteria editor — shown for auto-detected vendor-key drills and for the
  // manual-flag path (mflag:*) since both share one vendor-key bucket. Manual
  // merge groups (mgroup:*) curate membership explicitly and bypass narrowing.
  // The criteria store IS the vendor alias (settings → "איחוד ספקים"); editing
  // here writes to that same alias, so changes show up in both places.
  const isManualGroup = _drillKey.startsWith('mgroup:')
  // Strip the prefix for prefix-tagged keys so criteriaKey is the bare vendor
  // key (what the alias lookup expects).
  const criteriaKey = _drillKey.startsWith('mflag:')      ? _drillKey.slice('mflag:'.length)
                   : _drillKey.startsWith('installment:') ? _drillKey.slice('installment:'.length)
                   : _drillKey
  const currentAlias = isManualGroup ? null : findAliasForDrillKey(criteriaKey)
  const hasNarrowing = !!(currentAlias && (
    currentAlias.amountMin != null || currentAlias.amountMax != null ||
    currentAlias.dayMin    != null || currentAlias.dayMax    != null
  ))
  const criteriaSection = isManualGroup ? '' : (() => {
    const a = currentAlias || {}
    const summary = !currentAlias
      ? '<span style="color:var(--text-muted);font-size:.8rem">ללא איחוד — שמירה תיצור אחד</span>'
      : (hasNarrowing
        ? '<span style="color:var(--accent);font-size:.8rem">איחוד פעיל עם מאפיינים</span>'
        : '<span style="color:var(--text-muted);font-size:.8rem">איחוד קיים, ללא מאפיינים — נתפס לפי שם הספק בלבד</span>')
    const escAttr = v => String(v ?? '').replace(/"/g,'&quot;')
    const labelEscaped = escAttr(vendor)
    return `
      <details class="drill-criteria" style="margin-bottom:1rem;border:1px solid var(--border);border-radius:8px;padding:.6rem .85rem" ${hasNarrowing?'open':''}>
        <summary style="cursor:pointer;font-weight:600;font-size:.9rem;display:flex;justify-content:space-between;align-items:center">
          <span>מאפייני קיבוץ</span>${summary}
        </summary>
        <p style="font-size:.78rem;color:var(--text-muted);margin:.5rem 0 .75rem">
          המאפיינים נשמרים כחלק מ"איחוד הספקים" שבמסך ההגדרות. עסקה נכנסת לקיבוץ רק אם שם הספק וכל המאפיינים שמולאו נכונים.
          לסכום או יום מדויק — מלא את אותו ערך בשני השדות.
        </p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.6rem">
          <div>
            <label class="form-label" style="margin:0 0 .2rem">סכום מ־ (מוחלט)</label>
            <input type="number" step="0.01" id="drillCriteriaAmountMin" value="${a.amountMin ?? ''}" placeholder="ללא" style="font-size:.85rem;padding:.3rem;width:100%">
          </div>
          <div>
            <label class="form-label" style="margin:0 0 .2rem">סכום עד (מוחלט)</label>
            <input type="number" step="0.01" id="drillCriteriaAmountMax" value="${a.amountMax ?? ''}" placeholder="ללא" style="font-size:.85rem;padding:.3rem;width:100%">
          </div>
          <div>
            <label class="form-label" style="margin:0 0 .2rem">יום חיוב מ־ (1–31)</label>
            <input type="number" min="1" max="31" id="drillCriteriaDayMin" value="${a.dayMin ?? ''}" placeholder="ללא" style="font-size:.85rem;padding:.3rem;width:100%">
          </div>
          <div>
            <label class="form-label" style="margin:0 0 .2rem">יום חיוב עד (1–31)</label>
            <input type="number" min="1" max="31" id="drillCriteriaDayMax" value="${a.dayMax ?? ''}" placeholder="ללא" style="font-size:.85rem;padding:.3rem;width:100%">
          </div>
        </div>
        <div style="display:flex;gap:.5rem;margin-top:.75rem">
          <button class="btn-primary" style="font-size:.85rem;padding:.35rem .9rem" onclick="applyRecurringCriteriaFromDrill('${criteriaKey}','${labelEscaped}')">החל מאפיינים</button>
          ${hasNarrowing ? `<button class="btn-ghost" style="font-size:.85rem;padding:.35rem .9rem" onclick="clearRecurringCriteriaFromDrill('${criteriaKey}')">נקה מאפיינים</button>` : ''}
        </div>
      </details>`
  })()

  document.getElementById('drillBody').innerHTML = `
    <div class="period-selector" style="margin-bottom:1rem">
      <div class="period-presets">
        ${rangeBtn('3m', '3 חודשים')}
        ${rangeBtn('6m', '6 חודשים')}
        ${rangeBtn('12m', '12 חודשים')}
        ${rangeBtn('custom', 'טווח מותאם')}
      </div>
      ${customRow}
    </div>
    <div class="drill-cadence" style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:1rem;border:1px solid var(--border);border-radius:8px;padding:.55rem .85rem">
      <span style="font-weight:600;font-size:.9rem">תדירות</span>
      <select onchange="setRecurringCadenceOverride('${_drillKey}', this.value)" style="font-size:.85rem;padding:.3rem .5rem">${cadenceOpts}</select>
      ${curEntry.cadenceOverride
        ? `<span style="color:var(--accent);font-size:.78rem">✎ ידני</span><button class="btn-ghost" style="font-size:.78rem;padding:.25rem .6rem" onclick="clearRecurringCadenceOverride('${_drillKey}')">חזור לאוטומטי</button>`
        : '<span style="color:var(--text-muted);font-size:.78rem">זוהה אוטומטית — ניתן לשנות</span>'}
    </div>
    ${criteriaSection}
    ${(() => {
      const ovActive = !!amountOverride
      const monthlyEq = ovActive ? amountOverride.amount * (30 / (curEntry.cadenceDays || 30)) : 0
      const manualVal = ovActive && amountOverride.mode === 'manual' ? Math.abs(amountOverride.amount) : ''
      return `
      <details class="drill-representative" style="margin-bottom:1rem;border:1px solid var(--border);border-radius:8px;padding:.6rem .85rem" ${ovActive?'open':''}>
        <summary style="cursor:pointer;font-weight:600;font-size:.9rem;display:flex;justify-content:space-between;align-items:center">
          <span>סכום מייצג</span>
          ${ovActive
            ? `<span style="color:var(--accent);font-size:.8rem">📌 קבוע: ${formatCurrency(monthlyEq)}${curEntry.cadenceDays!==30?' לחודש':''}</span>`
            : '<span style="color:var(--text-muted);font-size:.8rem">ממוצע מוחלק</span>'}
        </summary>
        <p style="font-size:.78rem;color:var(--text-muted);margin:.5rem 0 .75rem">
          כברירת מחדל הסכום מחושב כממוצע מוחלק. אם ההוצאה גדלה בהדרגה (כמו תשלום משכנתא) ולא מתאימה להחלקה — אפשר לקבוע תשלום מייצג: הזן סכום ידני, או בחר תשלום מהרשימה למטה בעזרת "בחר כמייצג".
        </p>
        <div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
          <div>
            <label class="form-label" style="margin:0 0 .2rem">סכום התשלום${curEntry.cadenceDays!==30?` (ל${curEntry.cadenceLabel||recurringCadenceLabel(cadence)})`:''}</label>
            <input type="number" step="0.01" id="drillManualAmount" value="${manualVal}" placeholder="הזן סכום" style="font-size:.85rem;padding:.3rem;width:9rem">
          </div>
          <button class="btn-primary" style="font-size:.85rem;padding:.35rem .9rem" onclick="applyRecurringManualAmount('${_drillKey}')">קבע סכום</button>
          ${ovActive ? `<button class="btn-ghost" style="font-size:.85rem;padding:.35rem .9rem" onclick="clearRecurringAmountOverrideDrill()">חזור לממוצע</button>` : ''}
        </div>
        ${ovActive && amountOverride.mode==='pick' ? `<div style="font-size:.78rem;color:var(--text-muted);margin-top:.5rem">נבחר תשלום מהרשימה כסכום מייצג.</div>` : ''}
      </details>`
    })()}
    <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;cursor:pointer;font-size:.9rem">
      <input type="checkbox" ${isIgnoringOutliers ? 'checked' : ''} onchange="toggleIgnoreOutliersDrill()">
      התעלם מחריגים בחישוב הממוצע
    </label>
    <div class="drill-stats">
      <div><span class="drill-stat-label">עסקאות</span><span class="drill-stat-val">${filtered.length}</span></div>
      <div><span class="drill-stat-label">סה"כ</span><span class="drill-stat-val ${totalAmount>=0?'income-color':'expense-color'}">${totalAmount>=0?'+':''}${formatCurrency(totalAmount)}</span></div>
      <div><span class="drill-stat-label">ממוצע</span><span class="drill-stat-val">${formatCurrency(avg)}</span></div>
      <div><span class="drill-stat-label">טווח</span><span class="drill-stat-val" style="font-size:.85rem">${formatDate(start)} – ${formatDate(end)}</span></div>
    </div>
    <div style="overflow-x:auto;margin-top:1rem">
      <table class="data-table">
        <thead><tr><th>תאריך</th><th>ספק</th><th>קטגוריה</th><th style="text-align:left">סכום</th><th style="min-width:9.5rem">תקופת שיוך</th><th style="min-width:8.5rem">ספירה</th><th style="min-width:5.5rem">מייצג</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
}

