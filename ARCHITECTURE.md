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
