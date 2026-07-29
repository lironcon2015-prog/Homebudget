# Kids Portfolio — Architecture & System Principles

A Vanilla JS Single Page Application that tracks a multi-kid stock portfolio held inside a single parent brokerage account. The parent's own slice ("Ghost Number") is tracked in the back-office only — strictly so dividend math works correctly — and is **never** displayed.

---

## Guiding Principles

1. **Ledger is the source of truth.** All current state (cash balances, share counts, lots, valuation, XIRR) is derived by replaying an append-only list of transactions. Editing or deleting a tx and re-deriving is always safe.
2. **Pure engine, dumb UI.** The financial core (`src/ledger`, `src/math`, `src/util`) has no DOM access and can be unit-tested in Node. The UI consumes ViewModels produced by `src/view/Selectors.js`.
3. **Parent data is invisible by construction.** Selectors read only kid-keyed maps; they never touch `parentSharesByTicker`. This makes leaks structurally impossible from the UI layer.
4. **Determinism over cleverness.** Ledger entries are sorted by `(date, createdAt, id)` before reduction. FIFO ties break on `lotId`. Money is rounded with the **largest-remainder** method so prorated parts re-sum to the input exactly — no floating-point drift.
5. **Persistence is pluggable.** v1 ships `LocalStoragePersistence`; the same interface will be implemented later by `DrivePersistence` for sync.

---

## Modules

| Layer | Module | Role |
|---|---|---|
| util | `MathUtils.js` | `round2`, `round8`, `proratePreservingTotal` (largest-remainder), `sumValues`, `EPS`. |
| util | `IdGen.js` | Monotonic `tx_0001…` ids seeded from existing ledger; kid-id slugger. |
| util | `EventBus.js` | Tiny pub/sub used by `StateManager` to notify the UI on `state:changed`. |
| math | `Xirr.js` | Newton-Raphson XIRR with bisection fallback in `[-0.99, +10.0]`. Returns `{value, reason}`. |
| ledger | `FifoEngine.js` | `consumeFifo(lots, ticker, sharesSold)` — depletes per-kid shares from oldest lots, returns `consumedByKid`. |
| ledger | `DividendEngine.js` | `distributeDividend(lots, ticker, netIlsTotal)` — per-share rate × kid shares; parent slice discarded. |
| ledger | `GemelEngine.js` | `deriveGemel(state, todayKey)` — קופת גמל balances from a standing order + a statement anchor, revalued forward with published monthly returns. |
| io | `GemelFetcher.js` | Pulls monthly track returns from the גמל-נט CKAN dataset on data.gov.il. Discovers the column names instead of hard-coding them. |
| ledger | `LedgerEngine.js` | Pure reducer `deriveState(state, today)` → derived snapshot. |
| state | `LocalStoragePersistence.js` | JSON round-trip into `localStorage`. |
| state | `StateManager.js` | Owns persisted state, validates each tx by trial-derivation, emits change events. |
| view | `Selectors.js` | Builds `dashboardViewModel`, `holdingsViewModel`, `ledgerViewModel`, `tickersViewModel`. Strips parent data. |
| ui | `ui.js` | All DOM rendering + form wiring. |
| entry | `app.js` | Wires `Persistence → StateManager → UI`. |

UI → `Selectors` → `LedgerEngine`/`Xirr` → `FifoEngine`/`DividendEngine`/`MathUtils`. Lower layers never import upward.

---

## State Schema (persisted JSON)

```jsonc
{
  "schemaVersion": 1,
  "settings": {
    "baseCurrency": "ILS",
    "locale":       "he-IL",
    "lastFxRate":   3.70,
    "lastFxRateAsOf": "2026-05-09"
  },
  "kids": {
    "k_aviv_a1b2": { "id": "k_aviv_a1b2", "name": "Aviv", "createdAt": "2026-01-01" }
  },
  "quotes": {
    "AAPL": { "ticker": "AAPL", "company": "Apple Inc.", "priceUsd": 189.23, "asOf": "2026-05-09", "source": "manual" }
  },
  "gemelFunds": [
    { "id": "gemel_a1b2c3",
      "name": "קופת גמל להשקעה — מסלול מדדי",
      "fundNumber": "12345", "manager": "שם מנהל הקופה",
      "monthlyAmount": 500,                    // standing order, ILS
      "firstDepositDate": "2024-01-25",         // also fixes the day of month
      "annualFeePct": 0.67,
      "allocationHistory": [                    // forward-only; past deposits keep their split
        { "from": "2024-01-25", "allocation": { "k_aviv_a1b2": 33.34, "k_noa_b3c4": 33.33 } }
      ],
      "overrides": [                            // months that deviated; amount 0 = skipped
        { "date": "2026-02-25", "amount": 0, "note": "לא ירד" }
      ],
      "anchor": { "balance": 25000, "asOf": "2026-03-31" },  // from the quarterly statement
      "returns": [                              // manual entries outrank fetched ones
        { "month": "2026-04", "pct": 1.8, "source": "gemelnet", "fetchedAt": "2026-07-29" },
        { "month": "2026-05", "pct": -0.4, "source": "manual" }
      ]
    }
  ],
  "ledger": [
    { "id": "tx_0001", "type": "DEPOSIT", "date": "2026-01-15", "kidId": "k_aviv_a1b2", "amountIls": 1000, "note": "" },
    { "id": "tx_0002", "type": "BUY",     "date": "2026-02-01",
      "ticker": "AAPL", "company": "Apple Inc.",
      "totalShares": 10, "kidsShares": 8,
      "allocation": { "k_aviv_a1b2": 60, "k_noa_b3c4": 40 },
      "priceUsd": 180, "fxRate": 3.7, "feesIls": 0 },
    { "id": "tx_0003", "type": "SELL",     "date": "2026-04-01", "ticker": "AAPL", "sharesSold": 5, "netIls": 3500 },
    { "id": "tx_0004", "type": "DIVIDEND", "date": "2026-03-15", "ticker": "AAPL", "netIlsTotal": 200 }
  ]
}
```

### Derived state (recomputed every change — never persisted)

```jsonc
{
  "cashByKid":            { "k_aviv_a1b2": 1234.50 },
  "sharesByKidByTicker":  { "k_aviv_a1b2": { "AAPL": 4.8 } },
  "parentSharesByTicker": { "AAPL": 2.0 },
  "lots": [
    { "lotId": "tx_0002", "ticker": "AAPL", "openDate": "2026-02-01",
      "priceUsd": 180, "fxAtBuy": 3.7,
      "remaining": { "kids": { "k_aviv_a1b2": 2.88 }, "parent": 2.0 },
      "original":  { "kids": { "k_aviv_a1b2": 4.8 },  "parent": 2.0 } }
  ],
  "portfolioValueByKid": { "k_aviv_a1b2": 5421.10 },
  "totalKidsValue":      8531.65,
  "xirrByKid":           { "k_aviv_a1b2": { "value": 0.142 } }
}
```

---

## Gemel Funds (קופת גמל להשקעה)

A gemel fund has no ticker, no units and no quoted price — only a shekel balance
the manager reports. Modelling it as a synthetic security would mean inventing a
unit count for every deposit and pricing it off an index model that drifts
silently. Instead it is described by facts and derived arithmetically:

| Quantity | Source | Exact? |
|---|---|---|
| Principal | Σ deposits, generated from the standing order + overrides | Yes — every amount and date is known |
| Balance | `anchor.balance` rolled forward month by month with published returns | Through the last published month |
| Gain | `balance − principal` | As exact as the balance |
| XIRR | deposit flows + today's balance as the terminal flow | Yes |

### Revaluation

`revalue()` walks month by month from the anchor. The opening balance earns the
whole month; each deposit earns the fraction of the month left after it landed.
An anchor on the last day of its month contributes nothing to that month and so
does not require a return for it.

Published track returns are gross of the account-level management fee — the fee
is charged against the account, not the track — so `annualFeePct / 12` is
deducted from every month. That is a known constant, not an estimate.

Months with no published return yet still receive their deposits but earn
nothing. `tailFrom`, `measuredThrough` and `tailDeposits` are surfaced so the UI
can state exactly which window is unmeasured; `measuredThrough` is computed in
the engine so no screen has to do date arithmetic to phrase it correctly. That
window is now weeks rather than a whole quarter, and a fresh anchor still resets
the error to zero.

### Fetching returns

The גמל-נט dataset is reached **directly from the browser**, not through the
Worker or the public CORS proxies. data.gov.il rejects data-centre addresses, so
every proxy that makes the app's other sources reachable is what makes this one
unreachable; CKAN serves `Access-Control-Allow-Origin: *`, so the direct call
works from a home connection. The proxies remain a fallback.

Column names are discovered rather than hard-coded, and — this is the part that
matters — a candidate column is accepted only once a **real value from the
resource survives the parser it will be fed to**. Name matching alone is not
enough: `/date/i` matches `INCEPTION_DATE`, which holds an Excel serial rather
than a period, and choosing it makes every row fail to parse. Validating at
detection turns that into an honest "columns not detected" instead.

The live schema is `FUND_ID` / `REPORT_PERIOD` (integer `YYYYMM`) /
`MONTHLY_YIELD`; those are tried first, with looser patterns behind them.
A fund's inception month legitimately carries a null yield, so nulls are skipped
rather than treated as failure. `AVG_ANNUAL_MANAGEMENT_FEE` from the same rows
is reported in the diagnostic, since it is the number the fee field wants. `describeSource()` renders that
reasoning as text for the settings screen, so a failure reports which step
failed and what columns it actually saw. A ratio-vs-percent mix-up — invisible in
the UI, catastrophic in the maths — is caught by a magnitude check.

Fetched months never overwrite a manually entered one: a number typed off a real
statement outranks anything scraped.

**Deposits are not ledger rows.** One standing order describes dozens of
identical transfers; `overrides` covers the months that deviated (`amount: 0`
for a skipped month, a different amount for an unusual one, a date outside the
schedule for a one-off). This keeps the ledger screen readable, at the cost of
schedule edits rewriting history — acceptable because the schedule is config
the user owns.

**Allocation is forward-only.** `allocationHistory` entries take effect from
their `from` date; a deposit is split by whatever was in force when it was made.
Gain is then distributed by Modified-Dietz weighting (each deposit earns in
proportion to how long it has been invested), which collapses to exactly the
allocation when the split never changed, and avoids retroactively reassigning
past gains when it did.

Every split runs through `proratePreservingTotal`, but it is applied to the
**running total** rather than to each deposit on its own. Prorating a single
deposit is fair once and biased forever: equal weights break ties in a stable
order, so with an amount that does not divide evenly (₪500 across 3 kids) the
same kid takes the leftover agora every month. Splitting the cumulative sum and
taking the difference bounds each kid's deviation at one agora no matter how
many years of deposits accumulate. The run restarts whenever the allocation
changes, so amounts locked in under the previous split stay put.

Funds fold into `deriveState` before the profit maths: deposits into
`principalByKid`, balance into `portfolioValueByKid`, gain into the
**unrealized** bucket (nothing is sold), and deposit flows into each kid's XIRR.

---

## Transaction Semantics

### DEPOSIT
Credits a kid's ILS cash. The only source of "negative cashflow" used by XIRR.

### BUY
Inputs: `date, ticker, company, totalShares, kidsShares, allocation, priceUsd, fxRate, feesIls?`.

1. `parentShares = totalShares − kidsShares`.
2. `perKidShares = proratePreservingTotal(kidsShares, allocation%, 8)` — largest-remainder so the rounded shares re-sum to `kidsShares` exactly.
3. For each kid, debit `shares × priceUsd × fxRate` plus a proportional slice of `feesIls`.
4. Open a new lot with `{remaining: {kids: perKidShares, parent: parentShares}}`.

Negative cash is allowed (recorded as a warning) so back-dated entries can be ingested without ordering nightmares.

### SELL (FIFO)
Inputs: `date, ticker, sharesSold, netIls`. `sharesSold` is from the **kids' aggregate** position; the parent's lot share is never touched.

1. Sort lots for the ticker by `(openDate, lotId)`.
2. Walk oldest-first. For each lot, `take = min(lotKidsTotal, remainingToSell)`; deplete each kid's slice of THIS lot proportionally (`fraction = take / lotKidsTotal`). Accumulate `consumedByKid`.
3. Distribute `netIls` across kids using `proratePreservingTotal(netIls, consumedByKid, 2)` so the credited ILS sums **exactly** to `netIls`.

**Why per-lot proration matters:** if Lot A is 70/30 and Lot B is 20/80, and FIFO pulls only from Lot A, the kid who owned more of Lot A receives more cash. Distributing `netIls` by aggregate ownership instead would silently cross-subsidize.

### DIVIDEND
Inputs: `date, ticker, netIlsTotal` (entire account incl. parent).

1. Sum active shares across all lots for the ticker (kids + parent).
2. `divPerShare = netIlsTotal / totalShares`.
3. Credit each kid `divPerShare × kidShares`. Parent slice is intentionally discarded — we don't track parent cash.

---

## XIRR (per kid)

Cashflows: every kid DEPOSIT as a negative outflow, plus today's portfolio value (cash + Σ shares × priceUsd × fxRate) as a single positive terminal flow.

Algorithm: Newton-Raphson on NPV with `guess = 0.1`, clamped away from −100%, fallback to bisection in `[-0.99, +10.0]`. Returns `{value: number}` on success or `{value: null, reason: 'insufficient_flows' | 'no_sign_change' | 'no_convergence'}`.

The UI renders `null` results as `—` (never a misleading 0%).

---

## Validation

`StateManager._appendTx` validates every transaction by deriving a tentative state — if derivation throws, the ledger is not mutated. Per-type:

| Type | Hard rules | Warnings |
|---|---|---|
| DEPOSIT | `kidId ∈ kids`, `amountIls > 0` | — |
| BUY | `totalShares ≥ kidsShares ≥ 0`, `Σ allocation = 100 (±0.001)`, all `kidId ∈ kids`, `priceUsd > 0`, `fxRate > 0` | resulting cash < 0 |
| SELL | `sharesSold ≤ Σ kid shares`, `netIls ≥ 0` | — |
| DIVIDEND | active position in ticker, `netIlsTotal ≥ 0` | — |

---

## UI Architecture

Single-page, three views (`#view-dashboard`, `#view-holdings`, `#view-ledger`) controlled by `data-nav` links in one sidebar. `EventBus` triggers a full re-render on `state:changed` — derivation is cheap (state is small) and idempotent.

The form picker (Deposit/Buy/Sell/Dividend) shows one of four `<form>`s inside the Ledger view. The BUY allocation row is generated dynamically from `state.kids` so it always matches the configured kids.

Styling vocabulary: Tailwind via CDN with a custom theme (`primary` violet `#8b5cf6`, `secondary` emerald `#10b981`, deep-obsidian background). Glassmorphism cards (`.glass-panel`), neon CTAs (`.neon-button`), Hebrew RTL throughout, full mobile + desktop responsiveness.

---

## Persistence & Portability

- **Default:** `LocalStoragePersistence` under key `juniorinvest:v1`.
- **Manual portability:** Sidebar buttons export the full state to a JSON file and re-import it (with schema validation on load).
- **Future:** A `DrivePersistence` adapter implementing the same `load() / save() / clear()` interface will plug in without engine changes.

---

## Verification Checklist (engine, no UI)

1. `proratePreservingTotal` — all parts re-sum exactly to the input across awkward percentages.
2. BUY → assert per-kid cash, lot remaining, parent shares.
3. SELL across two lots with different allocations → assert `consumedByKid` and that credited ILS sum equals `netIls` exactly.
4. DIVIDEND with parent slice → assert kids receive only their proportional share.
5. XIRR matches Excel/Sheets reference within `1e-6`.
6. XIRR edge cases: insufficient flows, missing quote → returns `{value: null, reason}`.
7. Round-trip: state → JSON export → import → re-derive → identical derived snapshot.
8. **Invariant test:** the serialized output of every Selector must not contain the substring `parent`. Regression test on every PR.
