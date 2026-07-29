// Kids Portfolio — UI v2.
//
// Same engine as ui.js: reads through Selectors, writes through StateManager,
// never touches the ledger directly. Parent ghost shares are stripped by the
// selectors and are never rendered here.
//
// Layout: four tabs behind a floating bar, a FAB for new transactions, and
// pull-to-refresh for quotes on every screen.

import {
  dashboardViewModel, holdingsViewModel, ledgerViewModel, tickersViewModel,
} from './view/Selectors.js';
import { fetchQuotes, getWorkerUrl, setWorkerUrl, testWorker } from './io/QuoteFetcher.js';
import { xirr } from './math/Xirr.js';
import { currentAllocation } from './ledger/GemelEngine.js';
import { fetchGemelReturns, describeSource } from './io/GemelFetcher.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const ilsFmt = new Intl.NumberFormat('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });

// Latin/numeric runs are isolated so RTL never reorders them, and forced onto
// the Hanken Grotesk stack so every numeral is tabular.
const ltr = (s, cls = '') => `<bdi dir="ltr" class="font-data tnum ${cls}">${s}</bdi>`;

const ils = (n) => (n == null || isNaN(n) ? '—' : `₪ ${ilsFmt.format(Math.abs(n))}`);
const signedIls = (n) => (n == null || isNaN(n) ? '—' : `${n < 0 ? '−' : '+'}${ils(n)}`);

// The engine mixes two conventions and they must not be confused: profitPct
// and totalReturnPct arrive already multiplied out (profit / principal * 100),
// while XIRR is a plain ratio. Passing a percentage through the ratio
// formatter multiplies by 100 a second time.
const signedPoints = (n) => (n == null || isNaN(n) ? '—' : `${n < 0 ? '−' : '+'}${numFmt.format(Math.abs(n))}%`);
const signedRatio = (n) => (n == null || isNaN(n) ? '—' : signedPoints(n * 100));
const ratioAsPct = (n) => (n == null || isNaN(n) ? '—' : `${numFmt.format(n * 100)}%`);

const isUp = (n) => (n ?? 0) >= 0;
const today = () => new Date().toISOString().slice(0, 10);

const formatDateHe = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
};

const icon = (name, cls = '') => `<span class="material-symbols-outlined ${cls}">${name}</span>`;

// Glowing pill — the app's signature indicator.
const PILL_TONES = {
  secondary: ['bg-secondary/10', 'border-secondary/30', 'bg-secondary', 'text-secondary', '0 0 15px rgba(69,223,164,0.15)'],
  primary:   ['bg-primary/10',   'border-primary/30',   'bg-primary',   'text-primary',   '0 0 15px rgba(206,189,255,0.18)'],
  tertiary:  ['bg-tertiary/10',  'border-tertiary/30',  'bg-tertiary',  'text-tertiary',  '0 0 15px rgba(249,189,34,0.18)'],
  red:       ['bg-red-400/10',   'border-red-400/30',   'bg-red-400',   'text-red-400',   '0 0 15px rgba(248,113,113,0.18)'],
};

function pill(tone, text) {
  const [bg, border, dotBg, fg, shadow] = PILL_TONES[tone] || PILL_TONES.secondary;
  return `<div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full ${bg} border ${border}" style="box-shadow:${shadow};">
    <span class="w-1.5 h-1.5 rounded-full ${dotBg} animate-pulse shrink-0"></span>
    <span class="${fg} font-semibold text-xs font-data tnum tracking-wide whitespace-nowrap">${text}</span>
  </div>`;
}

const TABS = [
  { id: 'dashboard', label: 'דשבורד', icon: 'dashboard' },
  { id: 'holdings',  label: 'החזקות', icon: 'account_balance_wallet' },
  { id: 'ledger',    label: 'יומן',   icon: 'receipt_long' },
  { id: 'settings',  label: 'הגדרות', icon: 'settings' },
];

const KID_PALETTE = [
  { bright: 'rgba(206, 189, 255, 0.55)', soft: 'rgba(206, 189, 255, 0.16)', accent: 'text-primary',   bar: '#cebdff' },
  { bright: 'rgba(69, 223, 164, 0.50)',  soft: 'rgba(69, 223, 164, 0.14)',  accent: 'text-secondary', bar: '#45dfa4' },
  { bright: 'rgba(249, 189, 34, 0.50)',  soft: 'rgba(249, 189, 34, 0.14)',  accent: 'text-tertiary',  bar: '#f9bd22' },
];

// A fixed-radius circle rather than the default farthest-corner extent: on a
// phone the cards are wide and short, and a proportional gradient floods the
// whole surface instead of reading as a corner glow.
const cardGlow = (c) =>
  `radial-gradient(circle 200px at 14% -8%, ${c.bright} 0%, ${c.soft} 30%, transparent 68%)`;

const LEDGER_KIND = {
  DEPOSIT:  { icon: 'account_balance', bubble: 'bg-primary/10 border-primary/25 text-primary',     tone: 'text-secondary' },
  BUY:      { icon: 'add_shopping_cart', bubble: 'bg-secondary/10 border-secondary/25 text-secondary', tone: 'text-white' },
  SELL:     { icon: 'sell',            bubble: 'bg-tertiary/10 border-tertiary/25 text-tertiary',  tone: 'text-white' },
  DIVIDEND: { icon: 'savings',         bubble: 'bg-secondary/10 border-secondary/25 text-secondary', tone: 'text-secondary' },
};

// ---------------------------------------------------------------------------

export class UIv2 {
  constructor(sm) {
    this.sm = sm;
    this.tab = 'dashboard';
    // Drill-down from a dashboard kid card. Non-null means the kid screen is
    // showing; the dashboard tab stays lit because that is where it came from.
    this.kidId = null;
    this.expanded = null;
    this.refreshing = false;
    this.pullStart = null;
    this.sheetOpen = false;
  }

  init() {
    // Overlays live outside #v2-root so a state-driven re-render can't wipe a
    // half-typed form out from under the user.
    if (!$('#v2-overlay')) {
      const el = document.createElement('div');
      el.id = 'v2-overlay';
      document.body.appendChild(el);
    }
    this.sm.on('state:changed', () => this.render());
    this._bind();
    this.render();
  }

  // ---- Derived helpers ----------------------------------------------------

  // Cost basis and average buy price per ticker, kids' remaining shares only.
  // holdingsViewModel gives value but not cost, and the raw lots are the only
  // place the buy price and FX at buy survive.
  _costByTicker() {
    const derived = this.sm.getDerived();
    const out = {};
    for (const lot of derived.lots || []) {
      const shares = Object.values(lot.remaining.kids).reduce((a, b) => a + b, 0);
      if (shares <= 0) continue;
      const rate = lot.currency === 'ILS-Agorot' ? 0.01 : lot.fxAtBuy;
      const e = out[lot.ticker] || (out[lot.ticker] = { shares: 0, costIls: 0, priceSum: 0 });
      e.shares += shares;
      e.costIls += shares * lot.price * rate;
      e.priceSum += shares * lot.price;
    }
    for (const t in out) out[t].avgPrice = out[t].shares > 0 ? out[t].priceSum / out[t].shares : null;
    return out;
  }

  // ---- Render -------------------------------------------------------------

  render() {
    const state = this.sm.getState();
    const derived = this.sm.getDerived();
    const views = {
      dashboard: () => this._dashboard(state, derived),
      holdings:  () => this._holdings(state, derived),
      ledger:    () => this._ledger(state),
      settings:  () => this._settings(state, derived),
      kid:       () => this._kidPortfolio(state, derived),
    };

    $('#v2-root').innerHTML = `
      <div class="status-scrim"></div>
      <div id="pull-ind" class="pull-ind">${icon('sync', `text-[20px] ${this.refreshing ? 'spinning' : ''}`)}</div>
      <div class="ambient-orb"><div class="orb-violet"></div><div class="orb-emerald"></div></div>
      <!-- Bottom padding clears the floating bar *and* the FAB, so the last row
           of a list is never parked underneath either at the end of a scroll. -->
      <div class="safe-top relative z-10 mx-auto min-h-screen max-w-lg pb-[calc(11rem+env(safe-area-inset-bottom))]">
        <main>${views[this.tab]()}</main>
      </div>
      ${this._fab()}
      ${this._nav()}`;

    if (this.refreshing) this._showPull(56, true);
  }

  _header(title, subtitle) {
    return `
      <header class="px-5 pb-1 pt-8">
        <h1 class="text-2xl font-bold tracking-tight text-white">${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="mt-1.5 text-sm text-on-surface-variant">${subtitle}</p>` : ''}
      </header>`;
  }

  _sectionTitle(text) {
    return `<h2 class="px-1 pb-3 pt-1 text-[11px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">${escapeHtml(text)}</h2>`;
  }

  _empty(text, hint = '') {
    return `
      <div class="glass-card rounded-2xl px-5 py-10 text-center">
        <p class="text-sm text-on-surface-variant">${escapeHtml(text)}</p>
        ${hint ? `<p class="mt-2 text-xs text-outline">${escapeHtml(hint)}</p>` : ''}
      </div>`;
  }

  // ---- Dashboard ----------------------------------------------------------

  _dashboard(state, derived) {
    const vm = dashboardViewModel(state, derived);
    const up = isUp(vm.totalProfit);

    const summary = `
      <section class="px-5 pt-4">
        <div class="glass-card rounded-2xl p-5">
          <div class="card-glow" style="background: ${cardGlow(KID_PALETTE[0])};"></div>

          <p class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-tertiary">
            <span class="h-1.5 w-1.5 rounded-full bg-tertiary shadow-[0_0_12px_#f9bd22] animate-pulse"></span>
            שווי תיק כולל (ילדים)
          </p>

          <h2 class="mt-3 text-4xl font-black tracking-tight text-white drop-shadow-[0_2px_15px_rgba(255,255,255,0.22)]">
            ${ltr(ils(vm.totalKidsValue))}
          </h2>

          <div class="mt-4 flex flex-wrap items-center gap-2">
            ${pill(up ? 'secondary' : 'red', `${signedIls(vm.totalProfit)} (${signedPoints(vm.totalReturnPct)})`)}
            ${vm.totalKidsXirr != null ? pill('primary', `שנתית ${ratioAsPct(vm.totalKidsXirr)}`) : ''}
          </div>

          <div class="mt-5 flex items-center justify-between border-t border-white/10 pt-3">
            <span class="text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">USD/ILS</span>
            <span class="text-sm font-semibold text-white">${ltr(numFmt.format(vm.fxRate))}</span>
          </div>
        </div>
      </section>`;

    const kids = vm.kids.length
      ? vm.kids.map((k, i) => this._kidCard(k, i)).join('')
      : this._empty('אין ילדים עדיין', 'הוסף ילד בהגדרות כדי להתחיל');

    return `
      ${this._header('תיק ההשקעות', `עודכן ${formatDateHe(vm.fxRateAsOf || today())}`)}
      ${summary}
      <section class="px-5 pt-6">
        ${this._sectionTitle('הילדים')}
        <div class="space-y-4">${kids}</div>
      </section>`;
  }

  _kidCard(kid, i) {
    const c = KID_PALETTE[i % KID_PALETTE.length];
    const up = isUp(kid.profit);
    // Centre the bar at 40% and let the return nudge it, so a flat kid still
    // reads as a bar rather than an empty track.
    const barPct = Math.max(8, Math.min(95, 40 + (kid.profitPct || 0) * 2));

    return `
      <div class="glass-card pressable flex flex-col gap-4 rounded-2xl p-5"
           data-kid="${escapeHtml(kid.id)}" role="button" tabindex="0">
        <div class="card-glow" style="background: ${cardGlow(c)};"></div>

        <!-- Identity on the start side, numbers on the end side — the same
             grammar every holdings and ledger row uses. -->
        <div class="flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            <div class="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full border border-white/10 bg-surface-container">
              ${kid.avatar
                ? `<img src="${escapeHtml(kid.avatar)}" alt="" class="h-full w-full object-cover" />`
                : icon('person', `${c.accent} text-[21px]`)}
            </div>
            <div class="min-w-0">
              <h3 class="truncate text-base font-bold text-white">${escapeHtml(kid.name)}</h3>
              <p class="mt-0.5 text-xs text-on-surface-variant">מזומן ${ltr(ils(kid.cashIls))}</p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <div class="text-left">
              <div class="text-xl font-black tracking-tight text-white">${ltr(ils(kid.portfolioValueIls))}</div>
              <div class="mt-0.5 text-sm font-bold ${up ? 'text-secondary' : 'text-red-400'}">${ltr(signedPoints(kid.profitPct))}</div>
            </div>
            ${icon('chevron_left', `${c.accent} text-[20px]`)}
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          ${pill(up ? 'secondary' : 'red', signedIls(kid.profit))}
          ${kid.xirr != null ? pill('primary', `שנתית ${ratioAsPct(kid.xirr)}`) : ''}
        </div>

        <div class="kid-progress-track">
          <div class="kid-progress-fill" style="width:${barPct}%; background:${c.bar};"></div>
        </div>
      </div>`;
  }

  // ---- Kid portfolio (drill-down) -----------------------------------------

  _kidPortfolio(state, derived) {
    const kid = state.kids[this.kidId];
    if (!kid) {
      // The kid was removed while the screen was open.
      this.tab = 'dashboard';
      this.kidId = null;
      return this._dashboard(state, derived);
    }

    const fxRate = state.settings.lastFxRate;
    const value = derived.portfolioValueByKid[this.kidId] || 0;
    const cash = derived.cashByKid[this.kidId] || 0;
    const profit = derived.profitByKid?.[this.kidId] || { total: 0, unrealized: 0, realized: 0 };
    const kidXirr = typeof derived.xirrByKid?.[this.kidId] === 'number' ? derived.xirrByKid[this.kidId] : null;
    const gemelBalance = derived.gemel?.balanceByKid?.[this.kidId] || 0;
    const up = isUp(profit.total);
    const now = new Date();

    const back = `
      <header class="flex items-center gap-3 px-5 pb-1 pt-8">
        <button type="button" id="kid-back" aria-label="חזרה" class="pressable shrink-0 text-on-surface-variant active:text-white">
          ${icon('chevron_right', 'text-[26px]')}
        </button>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-2xl font-bold tracking-tight text-white">${escapeHtml(kid.name)}</h1>
          <p class="mt-1.5 text-sm text-on-surface-variant">התיק האישי</p>
        </div>
      </header>`;

    const summary = `
      <section class="px-5 pt-4">
        <div class="glass-card rounded-2xl p-5">
          <div class="card-glow" style="background: ${cardGlow(KID_PALETTE[0])};"></div>
          <p class="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">שווי התיק</p>
          <h2 class="mt-3 text-4xl font-black tracking-tight text-white drop-shadow-[0_2px_15px_rgba(255,255,255,0.22)]">
            ${ltr(ils(value))}
          </h2>
          <div class="mt-4 flex flex-wrap items-center gap-2">
            ${pill(up ? 'secondary' : 'red', signedIls(profit.total))}
            ${kidXirr != null ? pill('primary', `שנתית ${ratioAsPct(kidXirr)}`) : ''}
          </div>
          <div class="mt-5 space-y-2 border-t border-white/10 pt-3">
            ${this._kidStat('רווח לא ממומש', profit.unrealized)}
            ${this._kidStat('רווח ממומש', profit.realized)}
            ${gemelBalance ? this._kidStat('קופות גמל', gemelBalance, false) : ''}
            ${this._kidStat('מזומן', cash, false)}
          </div>
        </div>
      </section>`;

    // Per-lot figures for this kid alone. holdingsViewModel aggregates lots
    // across all kids, so this has to come off the raw lots.
    const lots = (derived.lots || []).filter((l) => (l.remaining.kids[this.kidId] || 0) > 0);

    const lotCards = lots.map((lot) => {
      const open = this.expanded === lot.lotId;
      const shares = lot.remaining.kids[this.kidId];
      const q = state.quotes[lot.ticker];
      const price = q?.price ?? q?.priceUsd ?? null;
      const qCurrency = q?.currency ?? 'USD';
      const nowRate = qCurrency === 'ILS-Agorot' ? 0.01 : fxRate;
      const buyRate = lot.currency === 'ILS-Agorot' ? 0.01 : lot.fxAtBuy;
      const cost = shares * lot.price * buyRate;
      const val = price != null ? shares * price * nowRate : null;
      const lotProfit = val != null ? val - cost : null;
      const pct = price != null ? (price - lot.price) / lot.price : null;

      let lotXirr = null;
      if (val != null && cost !== 0) {
        // A same-day lot has no elapsed time to annualise over.
        if (String(lot.openDate).slice(0, 10) !== now.toISOString().slice(0, 10)) {
          lotXirr = xirr([{ date: lot.openDate, amount: -cost }, { date: now, amount: val }])?.value ?? null;
        }
      }

      const tone = lotProfit == null ? 'text-on-surface-variant' : isUp(lotProfit) ? 'text-secondary' : 'text-red-400';
      const sym = { USD: '$', EUR: '€', GBP: '£', 'ILS-Agorot': '' };
      const money = (v, c) => (v == null ? '—' : `${c in sym ? sym[c] : (c || '')}${numFmt.format(v)}`);

      // Same collapsed/expanded grammar as a holdings card: identity and date
      // on the start side, value and return on the end side, detail behind the
      // accordion.
      const summaryBtn = `
        <button type="button" data-toggle="${escapeHtml(lot.lotId)}" aria-expanded="${open}"
                class="pressable flex w-full items-center justify-between gap-4 p-5 text-right">
          <div class="min-w-0">
            <div class="text-base font-bold text-white">${ltr(escapeHtml(lot.ticker))}</div>
            <div class="mt-0.5 truncate text-xs text-on-surface-variant">${escapeHtml(formatDateHe(lot.openDate))}</div>
          </div>
          <div class="flex shrink-0 items-center gap-3">
            <div class="text-left">
              <div class="text-base font-bold text-white">${ltr(val != null ? ils(val) : '—')}</div>
              <div class="mt-0.5 text-sm font-bold ${tone}">${ltr(signedRatio(pct))}</div>
            </div>
            ${icon('expand_more', `chevron text-outline text-[20px] ${open ? 'open' : ''}`)}
          </div>
        </button>`;

      const details = `
        <div class="accordion ${open ? 'open' : ''}">
          <div>
            <div class="border-t border-white/10 px-5 pb-5 pt-3">
              ${this._detailRow('מניות', numFmt.format(shares))}
              ${this._detailRow('מחיר קנייה', money(lot.price, lot.currency))}
              ${this._detailRow('מחיר נוכחי', money(price, qCurrency))}
              ${this._detailRow('רווח/הפסד', signedIls(lotProfit), tone)}
              ${this._detailRow('תשואה שנתית', lotXirr != null ? ratioAsPct(lotXirr) : '—')}
            </div>
          </div>
        </div>`;

      return `<div class="glass-card rounded-2xl">${summaryBtn}${details}</div>`;
    }).join('');

    return `
      ${back}
      ${summary}
      <section class="px-5 pt-6">
        ${this._sectionTitle('אחזקות פתוחות')}
        <div class="space-y-4">${lots.length ? lotCards : this._empty('אין אחזקות פתוחות')}</div>
      </section>
      ${this._gemelSection(state, derived, this.kidId)}`;
  }

  _kidStat(label, amount, tone = true) {
    const cls = !tone ? 'text-white' : isUp(amount) ? 'text-secondary' : 'text-red-400';
    return `
      <div class="flex items-center justify-between text-sm">
        <span class="text-gray-400">${escapeHtml(label)}</span>
        <span class="font-semibold ${cls}">${ltr(tone ? signedIls(amount) : ils(amount))}</span>
      </div>`;
  }

  // Shared by the holdings and kid-portfolio accordions so the two can't drift.
  _detailRow(label, value, tone = 'text-white') {
    return `
      <div class="flex items-center justify-between border-b border-gray-800 py-2 text-sm last:border-b-0">
        <span class="text-gray-400">${escapeHtml(label)}</span>
        <span class="font-semibold ${tone}">${ltr(value)}</span>
      </div>`;
  }

  // ---- Holdings -----------------------------------------------------------

  _holdings(state, derived) {
    const vm = holdingsViewModel(state, derived);
    const gemel = this._gemelSection(state, derived);
    const fundCount = derived.gemel?.funds?.length || 0;

    if (!vm.rows.length) {
      const empty = `<section class="px-5 pt-4">${this._empty('אין אחזקות עדיין', 'הוסף קנייה עם הכפתור הצף')}</section>`;
      return `${this._header('החזקות', fundCount ? `${fundCount} קופות גמל` : '')}
        ${gemel ? '' : empty}${gemel}`;
    }

    const cost = this._costByTicker();
    const cards = vm.rows.map((r) => this._holdingCard(r, cost[r.ticker])).join('');
    const parts = [`${vm.rows.length} ניירות`];
    if (fundCount) parts.push(`${fundCount} קופות גמל`);

    return `
      ${this._header('החזקות', `${parts.join(' · ')} · הקש על כרטיס לפירוט`)}
      <section class="px-5 pt-4">
        ${gemel ? this._sectionTitle('ניירות ערך') : ''}
        <div class="space-y-4">${cards}</div>
      </section>
      ${gemel}`;
  }

  _holdingCard(r, cost) {
    const open = this.expanded === r.ticker;
    const profit = r.valueIls != null && cost ? r.valueIls - cost.costIls : null;
    const profitPct = profit != null && cost?.costIls ? profit / cost.costIls : null;
    const tone = profit == null ? 'text-on-surface-variant' : isUp(profit) ? 'text-secondary' : 'text-red-400';
    const sym = r.currency === 'ILS-Agorot' ? '' : (r.currency === 'USD' ? '$' : '');

    const summary = `
      <button type="button" data-toggle="${escapeHtml(r.ticker)}" aria-expanded="${open}"
              class="pressable flex w-full items-center justify-between gap-4 p-5 text-right">
        <div class="min-w-0">
          <div class="text-base font-bold text-white">${ltr(escapeHtml(r.ticker))}</div>
          <div class="mt-0.5 truncate text-xs text-on-surface-variant">${escapeHtml(r.company)}</div>
        </div>
        <div class="flex shrink-0 items-center gap-3">
          <div class="text-left">
            <div class="text-base font-bold text-white">${ltr(r.valueIls != null ? ils(r.valueIls) : '—')}</div>
            <div class="mt-0.5 text-sm font-bold ${tone}">${ltr(signedRatio(profitPct))}</div>
          </div>
          ${icon('expand_more', `chevron text-outline text-[20px] ${open ? 'open' : ''}`)}
        </div>
      </button>`;

    const row = (label, value, valueTone) => this._detailRow(label, value, valueTone);

    const split = r.perKid.map((k) => {
      const kidValue = r.price != null
        ? k.shares * r.price * (r.currency === 'ILS-Agorot' ? 0.01 : this.sm.getState().settings.lastFxRate)
        : null;
      const pct = r.totalShares > 0 ? (k.shares / r.totalShares) * 100 : 0;
      return `
        <div class="flex items-center justify-between border-b border-gray-800 py-2 text-sm last:border-b-0">
          <span class="text-gray-400">${escapeHtml(k.kidName)} <span class="text-xs text-outline">${ltr(`${numFmt.format(pct)}%`)}</span></span>
          <span class="flex items-baseline gap-2">
            <span class="font-semibold text-white">${ltr(kidValue != null ? ils(kidValue) : '—')}</span>
            <span class="text-xs text-gray-400">${ltr(`${k.sharesFmt} מנ׳`)}</span>
          </span>
        </div>`;
    }).join('');

    const details = `
      <div class="accordion ${open ? 'open' : ''}">
        <div>
          <div class="border-t border-white/10 px-5 pb-5 pt-3">
            ${row('כמות מניות', r.totalSharesFmt)}
            ${row('מחיר קנייה ממוצע', cost?.avgPrice != null ? `${sym}${numFmt.format(cost.avgPrice)}` : '—')}
            ${row('מחיר נוכחי', r.priceFmt)}
            ${row('רווח/הפסד', signedIls(profit), tone)}
            ${row('עודכן', r.asOf)}

            <p class="pb-1 pt-5 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">חלוקה בין הילדים</p>
            ${split}

            <button type="button" data-edit-security="${escapeHtml(r.ticker)}"
                    class="pressable mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-primary/25 bg-primary/10 py-2.5 text-sm font-semibold text-primary">
              ${icon('edit', 'text-[17px]')} עריכת נייר
            </button>
          </div>
        </div>
      </div>`;

    return `<div class="glass-card rounded-2xl">${summary}${details}</div>`;
  }

  // ---- Gemel funds --------------------------------------------------------

  /**
   * Same collapsed/expanded grammar as a holdings card. `kidId` narrows every
   * figure to that kid's slice for the personal-portfolio screen; null shows
   * the whole fund plus the split between the kids.
   */
  _gemelCard(fund, f, state, kidId = null) {
    const key = 'gemel:' + f.id + (kidId ? ':' + kidId : '');
    const open = this.expanded === key;

    const balance = kidId ? (f.balanceByKid[kidId] || 0) : f.balance;
    const deposited = kidId ? (f.depositedByKid[kidId] || 0) : f.totalDeposited;
    const gain = kidId ? (f.gainByKid[kidId] || 0) : f.gain;
    const pct = deposited > 0 ? gain / deposited : null;
    const tone = gain === 0 ? 'text-on-surface-variant' : isUp(gain) ? 'text-secondary' : 'text-red-400';

    const subtitle = kidId
      ? `${f.deposits.length} הפקדות`
      : (fund?.fundNumber ? `קופה ${fund.fundNumber} · ${f.deposits.length} הפקדות` : `${f.deposits.length} הפקדות`);

    const summary = `
      <button type="button" data-toggle="${escapeHtml(key)}" aria-expanded="${open}"
              class="pressable flex w-full items-center justify-between gap-4 p-5 text-right">
        <div class="min-w-0">
          <div class="truncate text-base font-bold text-white">${escapeHtml(f.name)}</div>
          <div class="mt-0.5 truncate text-xs text-on-surface-variant">${escapeHtml(subtitle)}</div>
        </div>
        <div class="flex shrink-0 items-center gap-3">
          <div class="text-left">
            <div class="text-base font-bold text-white">${ltr(ils(balance))}</div>
            <div class="mt-0.5 text-sm font-bold ${tone}">${ltr(signedRatio(pct))}</div>
          </div>
          ${icon('expand_more', `chevron text-outline text-[20px] ${open ? 'open' : ''}`)}
        </div>
      </button>`;

    const last = f.deposits.length ? f.deposits.at(-1) : null;

    // The tail is the honest part of this screen: everything up to the anchor
    // date is the fund's own reported balance, and deposits after it are
    // counted at face value because no return is published for that window.
    const tailNote = f.tailFrom
      ? `<p class="mt-4 rounded-xl border border-tertiary/20 bg-tertiary/5 px-3 py-2.5 text-xs leading-relaxed text-tertiary">
           ${icon('info', 'align-middle text-[15px]')}
           היתרה משוערכת עד ${escapeHtml(formatDateHe(f.measuredThrough))}${f.revaluedMonths ? ` (${f.revaluedMonths} חודשי תשואה)` : ''}.
           ${ltr(ils(f.tailDeposits))} שהופקדו מאז נספרים ללא תשואה.
         </p>`
      : (f.warnings.some((w) => w.code === 'no-anchor')
        ? `<p class="mt-4 rounded-xl border border-red-400/20 bg-red-400/5 px-3 py-2.5 text-xs leading-relaxed text-red-400">
             ${icon('warning', 'align-middle text-[15px]')} לא הוזנה יתרה — מוצגת הקרן בלבד. עדכן יתרה בהגדרות.
           </p>`
        : '');

    const split = kidId ? '' : `
      <p class="pb-1 pt-5 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">חלוקה בין הילדים</p>
      ${Object.keys(state.kids).map((id) => {
        const kb = f.balanceByKid[id] || 0;
        const share = f.balance > 0 ? (kb / f.balance) * 100 : 0;
        return `
          <div class="flex items-center justify-between border-b border-gray-800 py-2 text-sm last:border-b-0">
            <span class="text-gray-400">${escapeHtml(state.kids[id].name)}
              <span class="text-xs text-outline">${ltr(`${numFmt.format(share)}%`)}</span></span>
            <span class="flex items-baseline gap-2">
              <span class="font-semibold text-white">${ltr(ils(kb))}</span>
              <span class="text-xs ${(f.gainByKid[id] || 0) < 0 ? 'text-red-400' : 'text-secondary'}">${ltr(signedIls(f.gainByKid[id] || 0))}</span>
            </span>
          </div>`;
      }).join('')}`;

    const editBtn = kidId ? '' : `
      <button type="button" data-edit-gemel="${escapeHtml(f.id)}"
              class="pressable mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-primary/25 bg-primary/10 py-2.5 text-sm font-semibold text-primary">
        ${icon('edit', 'text-[17px]')} עריכת קופה
      </button>`;

    const details = `
      <div class="accordion ${open ? 'open' : ''}">
        <div>
          <div class="border-t border-white/10 px-5 pb-5 pt-3">
            ${this._detailRow('סך הפקדות', ils(deposited))}
            ${this._detailRow('יתרה', ils(balance))}
            ${this._detailRow('רווח/הפסד', signedIls(gain), tone)}
            ${this._detailRow('תשואה', pct != null ? signedRatio(pct) : '—', tone)}
            ${this._detailRow('הפקדה חודשית', fund ? ils(fund.monthlyAmount) : '—')}
            ${this._detailRow('הפקדה אחרונה', last ? formatDateHe(last.date) : '—')}
            ${f.anchorAsOf ? this._detailRow('עוגן מהדוח', formatDateHe(f.anchorAsOf)) : ''}
            ${f.revaluedFrom ? this._detailRow('משוערך מ-', f.revaluedFrom) : ''}
            ${f.measuredThrough ? this._detailRow('משוערך עד', formatDateHe(f.measuredThrough)) : ''}
            ${split}
            ${tailNote}
            ${editBtn}
          </div>
        </div>
      </div>`;

    return `<div class="glass-card rounded-2xl">${summary}${details}</div>`;
  }

  _gemelSection(state, derived, kidId = null) {
    const funds = derived.gemel?.funds || [];
    const shown = kidId
      ? funds.filter((f) => (f.balanceByKid[kidId] || 0) !== 0 || (f.depositedByKid[kidId] || 0) !== 0)
      : funds;
    if (!shown.length) return '';

    const byId = Object.fromEntries((state.gemelFunds || []).map((x) => [x.id, x]));
    const cards = shown.map((f) => this._gemelCard(byId[f.id], f, state, kidId)).join('');

    return `
      <section class="px-5 pt-6">
        ${this._sectionTitle('קופות גמל')}
        <div class="space-y-4">${cards}</div>
      </section>`;
  }

  // ---- Ledger -------------------------------------------------------------

  _ledger(state) {
    const vm = ledgerViewModel(state);
    if (!vm.rows.length) {
      return `${this._header('יומן')}
        <section class="px-5 pt-4">${this._empty('אין תנועות עדיין', 'רשום תנועה עם הכפתור הצף')}</section>`;
    }

    const rows = vm.rows.map((t) => {
      const k = LEDGER_KIND[t.type] || LEDGER_KIND.BUY;
      return `
        <div class="pressable flex items-center gap-4 px-5 py-4" data-edit-tx="${escapeHtml(t.id)}" role="button" tabindex="0">
          <div class="grid h-11 w-11 shrink-0 place-items-center rounded-full border ${k.bubble}">
            ${icon(k.icon, 'text-[20px]')}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-bold text-white">${escapeHtml(t.label)}</span>
              <span class="truncate text-xs text-on-surface-variant">${ltr(escapeHtml(t.who))}</span>
            </div>
            <div class="mt-1 truncate text-xs text-outline">${escapeHtml(t.details)}</div>
          </div>
          <div class="shrink-0 text-left">
            <div class="text-sm font-bold ${k.tone}">${ltr(escapeHtml(t.amountFmt))}</div>
            <div class="mt-1 text-xs text-outline">${escapeHtml(formatDateHe(t.date))}</div>
          </div>
          <button type="button" data-del-tx="${escapeHtml(t.id)}" aria-label="מחק תנועה"
                  class="pressable shrink-0 text-outline active:text-red-400">
            ${icon('close', 'text-[18px]')}
          </button>
        </div>`;
    }).join('<div class="mx-5 border-t border-white/5"></div>');

    return `
      ${this._header('יומן', `${vm.rows.length} תנועות, מהחדשה לישנה`)}
      <section class="px-5 pt-4"><div class="glass-card rounded-2xl">${rows}</div></section>`;
  }

  // ---- Settings -----------------------------------------------------------

  _settings(state, derived) {
    const kids = Object.values(state.kids);
    const quotes = Object.values(state.quotes).sort((a, b) => a.ticker.localeCompare(b.ticker));

    const kidRows = kids.length ? kids.map((k) => `
      <div class="flex items-center gap-3 px-5 py-3">
        <button type="button" data-avatar-kid="${escapeHtml(k.id)}" aria-label="תמונה של ${escapeHtml(k.name)}"
                class="pressable grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full border border-white/10 bg-surface-container text-primary">
          ${k.avatar
            ? `<img src="${escapeHtml(k.avatar)}" alt="" class="h-full w-full object-cover" />`
            : icon('person', 'text-[19px]')}
        </button>
        <span class="min-w-0 flex-1 truncate text-sm text-white">${escapeHtml(k.name)}</span>
        <span class="shrink-0 text-xs text-on-surface-variant">${ltr(ils(derived.portfolioValueByKid[k.id] || 0))}</span>
        <button type="button" data-rename-kid="${escapeHtml(k.id)}" class="pressable shrink-0 text-outline active:text-primary">${icon('edit', 'text-[17px]')}</button>
        <button type="button" data-remove-kid="${escapeHtml(k.id)}" class="pressable shrink-0 text-outline active:text-red-400">${icon('delete', 'text-[17px]')}</button>
      </div>`).join('<div class="mx-5 border-t border-white/5"></div>')
      : '<p class="px-5 py-4 text-sm text-on-surface-variant">אין ילדים עדיין</p>';

    const quoteRows = quotes.length ? quotes.map((q) => `
      <div class="flex items-center gap-3 px-5 py-3">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-white">${ltr(escapeHtml(q.ticker))}</div>
          <div class="truncate text-xs text-outline">${escapeHtml(q.company || '')} · ${escapeHtml(formatDateHe(q.asOf))}</div>
        </div>
        <input type="number" step="0.01" min="0" value="${q.price ?? q.priceUsd ?? ''}"
               data-quote-price="${escapeHtml(q.ticker)}" dir="ltr"
               class="w-24 shrink-0 bg-transparent text-left font-data tnum text-sm text-white outline-none focus:text-primary" />
        <span class="shrink-0 text-xs text-outline">${q.currency === 'ILS-Agorot' ? 'אג׳' : escapeHtml(q.currency || 'USD')}</span>
        <button type="button" data-remove-quote="${escapeHtml(q.ticker)}" class="pressable shrink-0 text-outline active:text-red-400">${icon('close', 'text-[17px]')}</button>
      </div>`).join('<div class="mx-5 border-t border-white/5"></div>')
      : '<p class="px-5 py-4 text-sm text-on-surface-variant">אין ציטוטים עדיין</p>';

    const gemelDerived = Object.fromEntries((derived.gemel?.funds || []).map((f) => [f.id, f]));
    const gemelRows = (state.gemelFunds || []).length ? (state.gemelFunds || []).map((f) => {
      const d = gemelDerived[f.id];
      const stale = d?.measuredThrough
        ? `משוערך עד ${formatDateHe(d.measuredThrough)} · ${d.returnsCount || 0} תשואות`
        : 'ללא יתרה';
      return `
      <div class="flex items-center gap-3 px-5 py-3">
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-semibold text-white">${escapeHtml(f.name)}</div>
          <div class="truncate text-xs text-outline">${escapeHtml(stale)}</div>
        </div>
        <span class="shrink-0 text-xs text-on-surface-variant">${ltr(ils(d?.balance || 0))}</span>
        <button type="button" data-edit-gemel="${escapeHtml(f.id)}" class="pressable shrink-0 text-outline active:text-primary">${icon('edit', 'text-[17px]')}</button>
        <button type="button" data-remove-gemel="${escapeHtml(f.id)}" class="pressable shrink-0 text-outline active:text-red-400">${icon('delete', 'text-[17px]')}</button>
      </div>`;
    }).join('<div class="mx-5 border-t border-white/5"></div>')
      : '<p class="px-5 py-4 text-sm text-on-surface-variant">אין קופות גמל</p>';

    const field = (label, inner) => `
      <div class="px-5 py-3">
        <label class="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">${escapeHtml(label)}</label>
        ${inner}
      </div>`;

    const inputCls = 'w-full rounded-xl border border-primary/20 bg-white/[0.03] px-3 py-2.5 text-sm text-white outline-none focus:border-primary/60';

    return `
      ${this._header('הגדרות')}
      <section class="space-y-6 px-5 pt-4">
        <div>
          ${this._sectionTitle('ילדים')}
          <div class="glass-card rounded-2xl">
            ${kidRows}
            <div class="border-t border-white/5 px-5 py-3">
              <button type="button" id="btn-add-kid" class="pressable flex items-center gap-2 text-sm font-semibold text-primary">
                ${icon('add', 'text-[18px]')} הוסף ילד/ה
              </button>
            </div>
          </div>
        </div>

        <div>
          ${this._sectionTitle('שערים')}
          <div class="glass-card rounded-2xl">
            ${field('שער דולר/שקל', `<input id="set-fx" type="number" step="0.001" min="0" dir="ltr" value="${state.settings.lastFxRate}" class="${inputCls} font-data tnum" />`)}
            <div class="border-t border-white/5"></div>
            ${field('כתובת Worker לשערים', `<input id="set-worker" type="url" dir="ltr" placeholder="https://…workers.dev" value="${escapeHtml(getWorkerUrl())}" class="${inputCls}" />`)}
            <div class="border-t border-white/5"></div>
            ${field('בדיקת טיקר', `
              <div class="flex gap-2">
                <input id="test-ticker" type="text" dir="ltr" placeholder="AAPL / 1159250" class="${inputCls} flex-1" />
                <button type="button" id="btn-test-ticker" class="pressable shrink-0 rounded-xl bg-primary/20 px-4 text-sm font-semibold text-primary">בדוק</button>
              </div>
              <pre id="test-result" class="mt-2 hidden whitespace-pre-wrap break-all font-data text-[11px] text-on-surface-variant"></pre>`)}
          </div>
        </div>

        <div>
          ${this._sectionTitle('קופות גמל')}
          <div class="glass-card rounded-2xl">
            ${gemelRows}
            <div class="border-t border-white/5 px-5 py-3">
              <button type="button" id="btn-add-gemel" class="pressable flex items-center gap-2 text-sm font-semibold text-primary">
                ${icon('add', 'text-[18px]')} הוסף קופה
              </button>
            </div>
          </div>
        </div>

        <div>
          ${this._sectionTitle('ציטוטים')}
          <div class="glass-card rounded-2xl">${quoteRows}</div>
        </div>

        <div>
          ${this._sectionTitle('נתונים')}
          <div class="glass-card rounded-2xl">
            <button type="button" id="btn-export" class="pressable flex w-full items-center gap-4 px-5 py-4 text-right">
              <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-white/5 text-primary">${icon('download', 'text-[18px]')}</div>
              <span class="flex-1 text-sm font-medium text-white">ייצוא JSON</span>
              ${icon('chevron_left', 'text-outline text-[20px]')}
            </button>
            <div class="border-t border-white/5"></div>
            <button type="button" id="btn-import" class="pressable flex w-full items-center gap-4 px-5 py-4 text-right">
              <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-white/5 text-primary">${icon('upload', 'text-[18px]')}</div>
              <span class="flex-1 text-sm font-medium text-white">ייבוא JSON</span>
              ${icon('chevron_left', 'text-outline text-[20px]')}
            </button>
            <input id="import-file" type="file" accept="application/json" class="hidden" />
            <div class="border-t border-white/5"></div>
            <!-- Escape hatch while v2 is being evaluated. Same data either way:
                 both shells read the same persistence key. -->
            <a href="./index-v1.html" class="pressable flex w-full items-center gap-4 px-5 py-4 text-right">
              <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-on-surface-variant">${icon('history', 'text-[18px]')}</div>
              <span class="flex-1 text-sm font-medium text-white">הממשק הקודם</span>
              ${icon('chevron_left', 'text-outline text-[20px]')}
            </a>
          </div>
        </div>
      </section>`;
  }

  // ---- Chrome -------------------------------------------------------------

  _nav() {
    const items = TABS.map((t) => {
      const active = (this.tab === 'kid' ? 'dashboard' : this.tab) === t.id;
      return `
        <button type="button" data-tab="${t.id}" aria-current="${active ? 'page' : 'false'}"
                class="tab-item flex flex-1 flex-col items-center gap-1 rounded-full px-1 py-2 ${active ? 'text-primary' : 'text-outline'}">
          ${icon(t.icon, `text-[21px] ${active ? 'fill' : ''}`)}
          <span class="text-[10px] ${active ? 'font-bold' : 'font-medium'}">${t.label}</span>
        </button>`;
    }).join('');

    return `
      <nav class="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div class="tabbar pointer-events-auto mx-auto flex max-w-md items-stretch gap-1 rounded-full p-1.5">${items}</div>
      </nav>`;
  }

  // Bottom-left mirrors the conventional bottom-right FAB under RTL.
  _fab() {
    return `
      <button type="button" id="v2-fab" aria-label="תנועה חדשה"
              class="fab-neon fixed bottom-[calc(6.75rem+env(safe-area-inset-bottom))] left-5 z-50 grid h-14 w-14 place-items-center rounded-2xl transition-all">
        ${icon('add', 'text-[26px] fill')}
      </button>`;
  }

  // ---- Pull to refresh ----------------------------------------------------

  _showPull(dist, locked = false) {
    const el = $('#pull-ind');
    if (!el) return;
    el.style.transform = `translateY(${Math.min(dist, 88)}px) rotate(${locked ? 0 : dist * 2}deg)`;
    el.style.opacity = String(Math.min(1, dist / 64));
  }

  _resetPull() {
    const el = $('#pull-ind');
    if (!el) return;
    el.style.transition = 'transform .25s ease, opacity .25s ease';
    el.style.transform = 'translateY(-3rem)';
    el.style.opacity = '0';
    setTimeout(() => { if (el) el.style.transition = ''; }, 260);
  }

  async _refreshQuotes() {
    if (this.refreshing) return;
    const state = this.sm.getState();
    const derived = this.sm.getDerived();
    const active = (derived.lots || [])
      .filter((l) => Object.values(l.remaining.kids).reduce((a, b) => a + b, 0) > 0)
      .map((l) => l.ticker);
    const tickers = [...new Set([...Object.keys(state.quotes || {}), ...active])];
    if (!tickers.includes('ILS=X')) tickers.push('ILS=X');

    if (tickers.length <= 1) {
      this._resetPull();
      return toast('אין ניירות לעדכון');
    }

    this.refreshing = true;
    this.render();
    const status = stickyToast(`מושך שערים עבור ${tickers.length - 1} ניירות…`);

    // Hard cap: never let the indicator hang longer than this regardless of
    // proxy state. Matches the budget inside QuoteFetcher plus round-trips.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45000));

    try {
      const results = await Promise.race([
        fetchQuotes(tickers, {
          onProgress: ({ done, total, ticker, ok }) => status.update(`(${done}/${total}) ${ok ? '✓' : '✗'} ${ticker}`),
        }),
        timeout,
      ]);

      const stock = tickers.filter((t) => t !== 'ILS=X');
      const ok = [];
      Object.keys(results).forEach((t) => {
        if (t === 'ILS=X') return this.sm.setFxRate(results[t].price);
        const q = state.quotes[t] || {};
        // A currency already on the quote is the user's choice and wins. Only
        // when there is none do we take the source's, then the name heuristic.
        const currency = q.currency || results[t].currency
          || (t.endsWith('.TA') || /^\d+(\.TA)?$/.test(t) ? 'ILS-Agorot' : 'USD');
        this.sm.upsertQuote({
          ticker: t, company: q.company || t, price: results[t].price,
          currency, asOf: today(), source: 'api',
        });
        ok.push(t);
      });

      const failed = stock.filter((t) => !results[t]);
      const fx = results['ILS=X'] ? ` · USD/ILS ${results['ILS=X'].price.toFixed(3)}` : '';
      status.finish(
        `✓ ${ok.length}/${stock.length} עודכנו${fx}` + (failed.length ? ` | ✗ נכשלו: ${failed.join(', ')}` : ''),
        ok.length ? 4000 : 7000,
      );
    } catch (e) {
      status.finish(e?.message === 'timeout'
        ? 'הזמן עבר 45 שניות — כל הפרוקסים נכשלו. נסה שוב מאוחר יותר.'
        : 'שגיאה בעת משיכת השערים', 7000);
    } finally {
      this.refreshing = false;
      this.render();
      this._resetPull();
    }
  }

  // ---- Transaction sheet --------------------------------------------------

  // tx set means editing an existing transaction rather than recording a new
  // one. The type is then fixed: the four kinds take different fields, so
  // switching type mid-edit would leave the record half-populated.
  _openSheet(type = 'BUY', tx = null) {
    this.sheetOpen = true;
    this.editingTx = tx;
    const state = this.sm.getState();
    const kids = Object.values(state.kids);
    const tickers = tickersViewModel(state, this.sm.getDerived());

    const TYPES = [
      { id: 'DEPOSIT', label: 'הפקדה' },
      { id: 'BUY', label: 'קנייה' },
      { id: 'SELL', label: 'מכירה' },
      { id: 'DIVIDEND', label: 'דיבידנד' },
    ];

    const inputCls = 'w-full rounded-xl border border-primary/20 bg-white/[0.03] px-3 py-2.5 text-sm text-white outline-none focus:border-primary/60';
    const fld = (label, inner) => `
      <div>
        <label class="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">${label}</label>
        ${inner}
      </div>`;

    const val = (k, dflt = '') => escapeHtml(tx?.[k] ?? dflt);

    const dateFld = fld('תאריך', `<input name="date" type="date" value="${tx ? val('date') : today()}" required class="${inputCls} font-data" />`);
    const tickerFld = fld('סימול', `<input name="ticker" list="v2-tickers" dir="ltr" value="${val('ticker')}" required class="${inputCls} font-data uppercase" />
      <datalist id="v2-tickers">${tickers.map((t) => `<option value="${escapeHtml(t.ticker)}">${escapeHtml(t.company)}</option>`).join('')}</datalist>`);

    // Even split by default; the engine requires the allocation to total 100.
    const evenPct = kids.length ? +(100 / kids.length).toFixed(2) : 0;
    const allocOf = (k, i) => tx?.allocation?.[k.id]
      ?? (i === kids.length - 1 ? +(100 - evenPct * (kids.length - 1)).toFixed(2) : evenPct);
    const allocFlds = kids.map((k, i) => `
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-sm text-white">${escapeHtml(k.name)}</span>
        <input data-alloc-kid="${escapeHtml(k.id)}" type="number" step="0.01" min="0" max="100" dir="ltr"
               value="${allocOf(k, i)}"
               class="w-24 rounded-xl border border-primary/20 bg-white/[0.03] px-2 py-1.5 text-left font-data tnum text-sm text-white outline-none focus:border-primary/60" />
        <span class="text-xs text-outline">%</span>
      </div>`).join('');

    const bodies = {
      DEPOSIT: `
        ${dateFld}
        ${fld('ילד/ה', `<select name="kidId" required class="${inputCls}">${kids.map((k) => `<option value="${escapeHtml(k.id)}"${tx?.kidId === k.id ? ' selected' : ''}>${escapeHtml(k.name)}</option>`).join('')}</select>`)}
        ${fld('סכום (₪)', `<input name="amountIls" type="number" step="0.01" min="0.01" dir="ltr" required class="${inputCls} font-data tnum" value="${val('amountIls')}" />`)}
        ${fld('הערה', `<input name="note" type="text" class="${inputCls}" value="${val('note')}" />`)}`,

      BUY: `
        ${dateFld}
        ${tickerFld}
        ${fld('שם החברה', `<input name="company" type="text" class="${inputCls}" value="${val('company')}" />`)}
        <div class="grid grid-cols-2 gap-3">
          ${fld('סה״כ מניות', `<input name="totalShares" type="number" step="any" min="0" dir="ltr" required class="${inputCls} font-data tnum" value="${val('totalShares')}" />`)}
          ${fld('מהן לילדים', `<input name="kidsShares" type="number" step="any" min="0" dir="ltr" required class="${inputCls} font-data tnum" value="${val('kidsShares')}" />`)}
        </div>
        <div class="grid grid-cols-2 gap-3">
          ${fld('מחיר', `<input name="price" type="number" step="any" min="0" dir="ltr" required class="${inputCls} font-data tnum" value="${val('price')}" />`)}
          ${fld('מטבע', `<select name="currency" class="${inputCls}">
            ${['USD', 'ILS-Agorot', 'EUR', 'GBP'].map((c) => `<option value="${c}"${(tx?.currency ?? 'USD') === c ? ' selected' : ''}>${c === 'ILS-Agorot' ? 'אגורות' : c}</option>`).join('')}</select>`)}
        </div>
        <div id="fx-wrap">${fld('שער חליפין', `<input name="fxRate" type="number" step="any" min="0" dir="ltr" value="${tx?.fxRate ?? state.settings.lastFxRate}" required class="${inputCls} font-data tnum" />`)}</div>
        ${fld('עמלות (₪)', `<input name="feesIls" type="number" step="0.01" min="0" dir="ltr" value="${tx?.feesIls ?? 0}" class="${inputCls} font-data tnum" />`)}
        <div>
          <p class="mb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">חלוקה בין הילדים</p>
          <div class="space-y-2">${allocFlds || '<p class="text-sm text-on-surface-variant">הוסף ילדים בהגדרות תחילה</p>'}</div>
          <p id="alloc-sum" class="mt-2 text-xs text-outline"></p>
        </div>`,

      SELL: `
        ${dateFld}
        ${tickerFld}
        ${fld('מניות שנמכרו', `<input name="sharesSold" type="number" step="any" min="0" dir="ltr" required class="${inputCls} font-data tnum" value="${val('sharesSold')}" />`)}
        ${fld('תמורה נטו (₪)', `<input name="netIls" type="number" step="0.01" min="0" dir="ltr" required class="${inputCls} font-data tnum" value="${val('netIls')}" />`)}`,

      DIVIDEND: `
        ${dateFld}
        ${tickerFld}
        ${fld('נטו לחשבון (₪)', `<input name="netIlsTotal" type="number" step="0.01" dir="ltr" required class="${inputCls} font-data tnum" value="${val('netIlsTotal')}" />`)}`,
    };

    $('#v2-overlay').innerHTML = `
      <div id="sheet-backdrop" class="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm"></div>
      <div class="sheet fixed inset-x-0 bottom-0 z-[71] mx-auto max-h-[88vh] max-w-lg overflow-y-auto rounded-t-3xl"
           dir="rtl" role="dialog" aria-modal="true" aria-label="תנועה חדשה">
        <div class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-surface-container/95 px-5 py-4 backdrop-blur-xl">
          <h2 class="text-base font-bold text-white">${tx ? 'עריכת תנועה' : 'תנועה חדשה'}</h2>
          <button type="button" id="sheet-close" aria-label="סגור" class="pressable text-outline active:text-white">${icon('close', 'text-[22px]')}</button>
        </div>

        <div class="flex gap-1 px-5 pt-4 ${tx ? 'hidden' : ''}">
          ${TYPES.map((t) => `
            <button type="button" data-tx-type="${t.id}"
                    class="flex-1 rounded-lg px-2 py-2 text-xs font-semibold transition-colors ${
                      t.id === type ? 'bg-primary/20 text-primary' : 'bg-white/[0.04] text-on-surface-variant'}">${t.label}</button>`).join('')}
        </div>

        <form id="tx-form" class="space-y-4 px-5 pb-8 pt-5">
          ${bodies[type]}
          <button type="submit" class="fab-neon w-full rounded-xl py-3 text-sm font-bold">${tx ? 'עדכן' : 'שמור'}</button>
        </form>
      </div>`;

    document.body.style.overflow = 'hidden';
    this._bindSheet(type, tx);
  }

  // Renaming a company and recording a split both touch every BUY of a ticker,
  // which no single transaction edit can do.
  _openSecuritySheet(ticker) {
    this.sheetOpen = true;
    const state = this.sm.getState();
    const q = state.quotes[ticker];
    const inputCls = 'w-full rounded-xl border border-primary/20 bg-white/[0.03] px-3 py-2.5 text-sm text-white outline-none focus:border-primary/60';

    $('#v2-overlay').innerHTML = `
      <div id="sheet-backdrop" class="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm"></div>
      <div class="sheet fixed inset-x-0 bottom-0 z-[71] mx-auto max-h-[88vh] max-w-lg overflow-y-auto rounded-t-3xl"
           dir="rtl" role="dialog" aria-modal="true" aria-label="עריכת נייר">
        <div class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-surface-container/95 px-5 py-4 backdrop-blur-xl">
          <h2 class="text-base font-bold text-white">עריכת ${escapeHtml(ticker)}</h2>
          <button type="button" id="sheet-close" aria-label="סגור" class="pressable text-outline active:text-white">${icon('close', 'text-[22px]')}</button>
        </div>

        <form id="security-form" class="space-y-5 px-5 pb-8 pt-5">
          <div>
            <label class="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">שם החברה</label>
            <input name="company" type="text" value="${escapeHtml(q?.company || '')}" class="${inputCls}" />
            <p class="mt-1.5 text-xs text-outline">מתעדכן גם בציטוט וגם בכל הקניות של הנייר.</p>
          </div>

          <div class="border-t border-white/10 pt-5">
            <label class="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">פיצול מניות</label>
            <div class="flex items-center gap-2">
              <input name="split" type="number" step="any" min="0" dir="ltr" placeholder="2" class="${inputCls} font-data tnum flex-1" />
              <span class="shrink-0 text-sm text-on-surface-variant">‎:1</span>
            </div>
            <p class="mt-1.5 text-xs text-outline">
              יחס הפיצול. 2 פירושו שכל מניה הפכה לשתיים: הכמות בכל קנייה תוכפל ומחיר הקנייה יחולק,
              כך שבסיס העלות נשמר. השאר ריק אם אין פיצול.
            </p>
            <label class="mt-3 flex items-center gap-2 text-sm text-on-surface-variant">
              <input name="adjustQuote" type="checkbox" checked class="h-4 w-4 rounded border-primary/30 bg-white/5" />
              עדכן גם את השער הנוכחי
            </label>
            <p class="mt-1.5 text-xs text-outline">
              בטל אם השער השמור כבר מעודכן אחרי הפיצול, אחרת הוא יחולק פעמיים.
            </p>
          </div>

          <button type="submit" class="fab-neon w-full rounded-xl py-3 text-sm font-bold">עדכן</button>
        </form>
      </div>`;

    document.body.style.overflow = 'hidden';
    const overlay = $('#v2-overlay');
    $('#sheet-close', overlay).addEventListener('click', () => this._closeSheet());
    $('#sheet-backdrop', overlay).addEventListener('click', () => this._closeSheet());

    $('#security-form', overlay).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const company = (f.elements.namedItem('company').value || '').trim();
      const splitRaw = f.elements.namedItem('split').value;
      const ratio = splitRaw === '' ? null : parseFloat(splitRaw);
      const adjustQuote = f.elements.namedItem('adjustQuote').checked;

      if (ratio != null && (!(ratio > 0) || ratio === 1)) {
        return toast('יחס פיצול חייב להיות מספר חיובי ששונה מ-1', 6000);
      }

      // patchTx commits one transaction at a time, so a failure partway would
      // leave a ticker half-split. Snapshot first and roll back on error.
      const snapshot = this.sm.exportJson();
      try {
        for (const tx of this.sm.getState().ledger) {
          if (tx.type !== 'BUY' || tx.ticker !== ticker) continue;
          const fields = {};
          if (company) fields.company = company;
          if (ratio != null) {
            fields.totalShares = tx.totalShares * ratio;
            fields.kidsShares = tx.kidsShares * ratio;
            fields.price = (tx.price ?? tx.priceUsd) / ratio;
          }
          if (Object.keys(fields).length) this.sm.patchTx(tx.id, fields);
        }

        const price = q?.price ?? q?.priceUsd ?? null;
        if (q && (company || (ratio != null && adjustQuote))) {
          this.sm.upsertQuote({
            ticker,
            company: company || q.company,
            price: ratio != null && adjustQuote && price != null ? price / ratio : price,
            currency: q.currency,
            asOf: q.asOf,
            source: q.source,
          });
        }
        this._closeSheet();
        toast(ratio != null ? `${ticker}: פיצול ${ratio}:1 הוחל` : 'עודכן');
      } catch (err) {
        this.sm.importJson(snapshot);
        toast(`העדכון בוטל: ${err.message}`, 7000);
      }
    });
  }

  /**
   * Add or edit a gemel fund. `fundId` null opens the add form.
   *
   * The form is the whole configuration: the standing order that generates the
   * deposits, the balance anchor from the latest statement, the split, and the
   * exceptions for months the standing order deviated from.
   */
  _openGemelSheet(fundId = null, notice = '') {
    this.sheetOpen = true;
    const state = this.sm.getState();
    const fund = fundId ? (state.gemelFunds || []).find((f) => f.id === fundId) : null;
    if (fundId && !fund) return;

    const kids = Object.values(state.kids);
    if (!kids.length) { this.sheetOpen = false; return toast('הוסף ילדים לפני יצירת קופה', 5000); }

    const alloc = fund ? currentAllocation(fund) : {};
    // An even split has to re-sum to exactly 100 or the form rejects its own
    // default: 100/3 rounded to 33.33 three times is 99.99. The remainder goes
    // to the first kid, same largest-remainder idea used for the money.
    const evenSplit = (() => {
      const n = kids.length;
      const base = Math.floor((100 / n) * 100) / 100;
      const parts = new Array(n).fill(base);
      parts[0] = Number((100 - base * (n - 1)).toFixed(2));
      return parts;
    })();
    const histLen = fund ? (fund.allocationHistory || []).length : 0;

    const inputCls = 'w-full rounded-xl border border-primary/20 bg-white/[0.03] px-3 py-2.5 text-sm text-white outline-none focus:border-primary/60';
    const labelCls = 'mb-1.5 block text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant';
    const hintCls = 'mt-1.5 text-xs leading-relaxed text-outline';

    const allocFields = kids.map((k, i) => `
      <div class="flex items-center gap-3 py-1.5">
        <span class="min-w-0 flex-1 truncate text-sm text-white">${escapeHtml(k.name)}</span>
        <input name="alloc:${escapeHtml(k.id)}" type="number" step="any" min="0" max="100" dir="ltr"
               value="${alloc[k.id] != null ? Number(Number(alloc[k.id]).toFixed(4)) : evenSplit[i]}"
               class="w-24 shrink-0 rounded-xl border border-primary/20 bg-white/[0.03] px-3 py-2 text-left font-data tnum text-sm text-white outline-none focus:border-primary/60" />
        <span class="shrink-0 text-sm text-on-surface-variant">%</span>
      </div>`).join('');

    const returnRows = (fund?.returns || []).length ? `
      <div class="max-h-48 overflow-y-auto">${(fund.returns).map((r) => `
        <div class="flex items-center gap-3 border-b border-white/5 py-2 text-sm last:border-b-0">
          <span class="flex-1 text-gray-400">${ltr(escapeHtml(r.month))}
            ${r.source === 'manual' ? '<span class="text-[10px] text-outline">ידני</span>' : ''}</span>
          <span class="font-semibold ${r.pct < 0 ? 'text-red-400' : 'text-secondary'}">${ltr(signedPoints(r.pct))}</span>
          <button type="button" data-del-gemel-ret="${escapeHtml(r.month)}" class="pressable shrink-0 text-outline active:text-red-400">${icon('close', 'text-[16px]')}</button>
        </div>`).join('')}</div>`
      : '<p class="py-2 text-xs text-outline">אין תשואות — היתרה נספרת מהעוגן ללא שערוך.</p>';

    const overrideRows = (fund?.overrides || []).length ? (fund.overrides).map((o) => `
      <div class="flex items-center gap-3 border-b border-white/5 py-2 text-sm last:border-b-0">
        <span class="flex-1 text-gray-400">${escapeHtml(formatDateHe(o.date))}</span>
        <span class="font-semibold ${o.amount === 0 ? 'text-red-400' : 'text-white'}">
          ${o.amount === 0 ? 'לא הופקד' : ltr(ils(o.amount))}
        </span>
        <button type="button" data-del-gemel-ov="${escapeHtml(o.date)}" class="pressable shrink-0 text-outline active:text-red-400">${icon('close', 'text-[16px]')}</button>
      </div>`).join('')
      : '<p class="py-2 text-xs text-outline">אין חריגים — כל החודשים לפי הוראת הקבע.</p>';

    $('#v2-overlay').innerHTML = `
      <div id="sheet-backdrop" class="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm"></div>
      <div class="sheet fixed inset-x-0 bottom-0 z-[71] mx-auto max-h-[88vh] max-w-lg overflow-y-auto rounded-t-3xl"
           dir="rtl" role="dialog" aria-modal="true" aria-label="קופת גמל">
        <div class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-surface-container/95 px-5 py-4 backdrop-blur-xl">
          <h2 class="text-base font-bold text-white">${fund ? 'עריכת קופה' : 'קופת גמל חדשה'}</h2>
          <button type="button" id="sheet-close" aria-label="סגור" class="pressable text-outline active:text-white">${icon('close', 'text-[22px]')}</button>
        </div>

        <form id="gemel-form" class="space-y-5 px-5 pb-8 pt-5">
          <div>
            <label class="${labelCls}">שם הקופה</label>
            <input name="name" type="text" required value="${escapeHtml(fund?.name || '')}"
                   placeholder="קופת גמל להשקעה" class="${inputCls}" />
          </div>

          <div>
            <label class="${labelCls}">מספר קופה</label>
            <input name="fundNumber" type="text" dir="ltr" value="${escapeHtml(fund?.fundNumber || '')}"
                   placeholder="12345" class="${inputCls} font-data tnum" />
            <p class="${hintCls}">מזהה המסלול בגמל-נט. לתיעוד בלבד.</p>
          </div>

          <div class="border-t border-white/10 pt-5">
            <label class="${labelCls}">הוראת קבע</label>
            <div class="flex gap-2">
              <input name="monthlyAmount" type="number" step="any" min="0" required dir="ltr"
                     value="${fund?.monthlyAmount ?? ''}" placeholder="500"
                     class="${inputCls} font-data tnum flex-1" />
              <span class="grid shrink-0 place-items-center text-sm text-on-surface-variant">₪ לחודש</span>
            </div>
            <p class="${hintCls}">הסכום הקבוע שמופקד כל חודש.</p>
          </div>

          <div>
            <label class="${labelCls}">תאריך הפקדה ראשונה</label>
            <input name="firstDepositDate" type="date" required dir="ltr"
                   value="${escapeHtml(fund?.firstDepositDate || '')}" class="${inputCls} font-data" />
            <p class="${hintCls}">היום בחודש נקבע לפי התאריך הזה, וכל ההפקדות הבאות נגזרות ממנו. זה מה שהופך את הקרן למדויקת.</p>
          </div>

          <div class="border-t border-white/10 pt-5">
            <label class="${labelCls}">יתרה מהדוח</label>
            <div class="grid grid-cols-2 gap-2">
              <input name="anchorBalance" type="number" step="any" min="0" dir="ltr"
                     value="${fund?.anchor?.balance ?? ''}" placeholder="25000"
                     class="${inputCls} font-data tnum min-w-0" />
              <input name="anchorAsOf" type="date" dir="ltr"
                     value="${escapeHtml(fund?.anchor?.asOf || '')}"
                     class="${inputCls} font-data tnum min-w-0" />
            </div>
            <p id="anchor-warn" class="mt-1.5 hidden text-xs leading-relaxed text-tertiary"></p>
            <p class="${hintCls}">
              היתרה והתאריך שהיא נכונה לו. עד התאריך הזה השווי הוא בדיוק מה שהקופה דיווחה;
              הפקדות שאחריו נספרות ללא תשואה, ולכן כדאי לרענן כל רבעון.
            </p>
          </div>

          <div class="border-t border-white/10 pt-5">
            <label class="${labelCls}">פיצול בין הילדים</label>
            ${allocFields}
            <p id="alloc-sum" class="${hintCls}"></p>
            ${fund ? `
              <label class="mt-3 flex items-start gap-2 text-sm text-on-surface-variant">
                <input name="allocForward" type="checkbox" ${histLen > 1 ? 'checked' : ''} class="mt-0.5 h-4 w-4 shrink-0 rounded border-primary/30 bg-white/5" />
                <span>החל מהיום והלאה בלבד
                  <span class="block text-xs text-outline">סמן כששינית את החלוקה. השאר ריק כדי לתקן טעות — אז הפיצול חל למפרע על כל ההפקדות.</span>
                </span>
              </label>` : ''}
          </div>

          ${fund ? `
          <div class="border-t border-white/10 pt-5">
            <label class="${labelCls}">דמי ניהול מהצבירה</label>
            <div class="flex gap-2">
              <input name="annualFeePct" type="number" step="any" min="0" dir="ltr"
                     value="${fund.annualFeePct ?? ''}" placeholder="0.67"
                     class="${inputCls} font-data tnum flex-1" />
              <span class="grid shrink-0 place-items-center text-sm text-on-surface-variant">% לשנה</span>
            </div>
            <p class="${hintCls}">
              נגבים ברמת החשבון ולכן אינם כלולים בתשואת המסלול המפורסמת. זה קבוע ידוע, לא הערכה —
              הוא מנוכה מכל חודש בשערוך.
            </p>
          </div>

          <div class="border-t border-white/10 pt-5">
            <label class="${labelCls}">תשואות חודשיות</label>
            <div class="mb-3">${returnRows}</div>
            <!-- Two columns plus a full-width button: a native month/date picker has
                 a wide intrinsic minimum, so three controls on one line overflow a phone. -->
            <div class="grid grid-cols-2 gap-2">
              <input name="retMonth" type="month" dir="ltr" class="${inputCls} font-data tnum min-w-0" />
              <input name="retPct" type="number" step="any" dir="ltr" placeholder="1.25"
                     class="${inputCls} font-data tnum min-w-0" />
            </div>
            <button type="button" id="btn-add-ret"
                    class="pressable mt-2 w-full rounded-xl bg-primary/20 py-2.5 text-sm font-semibold text-primary">הוסף חודש</button>
            <div class="mt-3 flex gap-2">
              <button type="button" id="btn-fetch-ret"
                      class="pressable flex-1 rounded-xl border border-secondary/25 bg-secondary/10 py-2.5 text-sm font-semibold text-secondary">
                ${icon('sync', 'align-middle text-[17px]')} משוך מגמל-נט
              </button>
              <button type="button" id="btn-test-ret"
                      class="pressable shrink-0 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-semibold text-on-surface-variant">בדוק מקור</button>
            </div>
            <div id="ret-result-wrap" class="mt-2 hidden">
              <pre id="ret-result" class="max-h-56 overflow-auto whitespace-pre-wrap break-all font-data text-[11px] text-on-surface-variant"></pre>
              <!-- The report scrolls inside its own box, so the part that
                   explains the failure is usually the part not on screen. -->
              <button type="button" id="btn-copy-ret"
                      class="pressable mt-2 w-full rounded-xl border border-white/10 bg-white/5 py-2 text-xs font-semibold text-on-surface-variant">
                ${icon('content_copy', 'align-middle text-[15px]')} העתק את הדוח
              </button>
            </div>
            <p class="${hintCls}">
              השערוך מגלגל את היתרה מהעוגן קדימה לפי התשואה של כל חודש. חודש שטרם פורסם
              נספר ללא תשואה ומסומן בכרטיס. ידני גובר תמיד על נמשך.
            </p>
          </div>

          <div class="border-t border-white/10 pt-5">
            <label class="${labelCls}">חודשים חריגים</label>
            <div class="mb-3">${overrideRows}</div>
            <div class="grid grid-cols-2 gap-2">
              <input name="ovDate" type="date" dir="ltr" class="${inputCls} font-data tnum min-w-0" />
              <input name="ovAmount" type="number" step="any" min="0" dir="ltr" placeholder="0"
                     class="${inputCls} font-data tnum min-w-0" />
            </div>
            <button type="button" id="btn-add-ov"
                    class="pressable mt-2 w-full rounded-xl bg-primary/20 py-2.5 text-sm font-semibold text-primary">הוסף חריג</button>
            <p class="${hintCls}">חודש שבו הופקד סכום אחר, או 0 לחודש שבו לא הופקד כלום. גם הפקדה חד-פעמית בתאריך אחר נרשמת כאן.</p>
          </div>` : ''}

          <button type="submit" class="fab-neon w-full rounded-xl py-3 text-sm font-bold">${fund ? 'עדכן' : 'צור קופה'}</button>
        </form>
      </div>`;

    document.body.style.overflow = 'hidden';
    const overlay = $('#v2-overlay');
    const form = $('#gemel-form', overlay);
    $('#sheet-close', overlay).addEventListener('click', () => this._closeSheet());
    $('#sheet-backdrop', overlay).addEventListener('click', () => this._closeSheet());

    // A statement is almost always as-of a month or quarter end. Dating the
    // anchor to the start of a month instead makes that month's return apply to
    // a balance that already contains it — the loss or gain counts twice, and
    // nothing about the resulting number looks wrong.
    const anchorEl = form.elements.namedItem('anchorAsOf');
    const checkAnchorDate = () => {
      const el = $('#anchor-warn', overlay);
      const v = anchorEl?.value;
      if (!el) return;
      if (!v) { el.classList.add('hidden'); return; }
      const [y, m, d] = v.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (d === last) { el.classList.add('hidden'); return; }
      const suggested = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
      el.classList.remove('hidden');
      el.textContent = `⚠ ${v} אינו סוף חודש. רוב הדוחות נכונים לסוף התקופה —`
        + ` אם הדוח הוא לסוף החודש בחר ${suggested}, אחרת תשואת החודש הזה תיספר פעמיים.`;
    };
    anchorEl?.addEventListener('input', checkAnchorDate);
    anchorEl?.addEventListener('change', checkAnchorDate);
    checkAnchorDate();

    const readAlloc = () => {
      const out = {};
      for (const k of kids) {
        const el = form.elements.namedItem('alloc:' + k.id);
        const v = parseFloat(el.value);
        out[k.id] = isNaN(v) ? 0 : v;
      }
      return out;
    };

    // Live total, because a split that does not reach 100 is rejected on submit
    // and the reason is otherwise invisible until then.
    const showSum = () => {
      const sum = Object.values(readAlloc()).reduce((a, b) => a + b, 0);
      const el = $('#alloc-sum', overlay);
      const ok = Math.abs(sum - 100) < 1e-3;
      el.textContent = `סה״כ ${numFmt.format(sum)}%` + (ok ? '' : ' — חייב להסתכם ב-100%');
      el.className = ok ? hintCls : 'mt-1.5 text-xs leading-relaxed text-red-400';
    };
    for (const k of kids) form.elements.namedItem('alloc:' + k.id).addEventListener('input', showSum);
    showSum();

    const addOv = $('#btn-add-ov', overlay);
    if (addOv) {
      addOv.addEventListener('click', () => {
        const date = form.elements.namedItem('ovDate').value;
        const raw = form.elements.namedItem('ovAmount').value;
        if (!date) return toast('בחר תאריך לחריג', 5000);
        const amount = raw === '' ? 0 : parseFloat(raw);
        if (isNaN(amount) || amount < 0) return toast('סכום לא תקין', 5000);
        try {
          this.sm.setGemelOverride(fundId, { date, amount });
          this._openGemelSheet(fundId);   // re-render so the new row shows
        } catch (err) { toast(err.message, 6000); }
      });
    }

    const addRet = $('#btn-add-ret', overlay);
    if (addRet) {
      addRet.addEventListener('click', () => {
        const month = form.elements.namedItem('retMonth').value;
        const pct = parseFloat(form.elements.namedItem('retPct').value);
        if (!month) return toast('בחר חודש', 5000);
        if (isNaN(pct)) return toast('הזן תשואה באחוזים', 5000);
        try {
          this.sm.setGemelReturn(fundId, { month, pct });
          this._openGemelSheet(fundId);
        } catch (err) { toast(err.message, 6000); }
      });
    }

    // The fetch and the diagnostic share one output pane. Neither can be
    // verified from a development machine — this source is only reachable from
    // a real browser — so both always report what they actually saw.
    const showRet = (text) => {
      const pane = $('#ret-result', overlay);
      if (!pane) return;
      $('#ret-result-wrap', overlay).classList.remove('hidden');
      pane.textContent = text;
    };
    // Pulling returns re-renders the sheet so the new rows appear, which would
    // otherwise wipe the very report the user pressed the button to see.
    if (notice) showRet(notice);

    const fetchBtn = $('#btn-fetch-ret', overlay);
    if (fetchBtn) {
      fetchBtn.addEventListener('click', async () => {
        const num = (form.elements.namedItem('fundNumber').value || '').trim();
        if (!num) return toast('נדרש מספר קופה כדי למשוך תשואות', 6000);
        fetchBtn.disabled = true;
        showRet('מושך…');
        try {
          const res = await fetchGemelReturns(num);
          if (res.error) { showRet(`✗ ${res.error}`); return; }
          const { added, updated, total } = this.sm.mergeGemelReturns(fundId, res.returns);
          const report = `✓ ${added} חדשים, ${updated} עודכנו, ${total} סה״כ`
            + (res.meta?.scaleWarning ? `\n⚠ ${res.meta.scaleWarning}` : '');
          toast(`נמשכו ${added + updated} חודשים`);
          this._openGemelSheet(fundId, report);
        } catch (err) {
          showRet(`✗ ${err.message}`);
        } finally { fetchBtn.disabled = false; }
      });
    }

    const copyBtn = $('#btn-copy-ret', overlay);
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const text = $('#ret-result', overlay)?.textContent || '';
        try {
          await navigator.clipboard.writeText(text);
          toast('הדוח הועתק');
        } catch {
          // Clipboard access is refused on insecure origins and in some
          // in-app browsers; selecting the text is the fallback that always works.
          const pane = $('#ret-result', overlay);
          const range = document.createRange();
          range.selectNodeContents(pane);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          toast('הדוח נבחר — העתק ידנית', 6000);
        }
      });
    }

    const testBtn = $('#btn-test-ret', overlay);
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const num = (form.elements.namedItem('fundNumber').value || '').trim();
        if (!num) return toast('נדרש מספר קופה', 5000);
        testBtn.disabled = true;
        showRet('בודק…');
        try {
          showRet(await describeSource(num));
        } catch (err) {
          showRet(`✗ ${err.message}`);
        } finally { testBtn.disabled = false; }
      });
    }

    // Bound to the sheet, not the overlay: the sheet is rebuilt on every open,
    // so listeners cannot pile up across repeated re-renders.
    $('.sheet', overlay).addEventListener('click', (e) => {
      const delOv = e.target.closest('[data-del-gemel-ov]');
      if (delOv) {
        try {
          this.sm.removeGemelOverride(fundId, delOv.dataset.delGemelOv);
          this._openGemelSheet(fundId);
        } catch (err) { toast(err.message, 6000); }
        return;
      }
      const delRet = e.target.closest('[data-del-gemel-ret]');
      if (delRet) {
        try {
          this.sm.removeGemelReturn(fundId, delRet.dataset.delGemelRet);
          this._openGemelSheet(fundId);
        } catch (err) { toast(err.message, 6000); }
      }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const name = (f.elements.namedItem('name').value || '').trim();
      const fundNumber = (f.elements.namedItem('fundNumber').value || '').trim();
      const monthlyAmount = parseFloat(f.elements.namedItem('monthlyAmount').value);
      const firstDepositDate = f.elements.namedItem('firstDepositDate').value;
      const balRaw = f.elements.namedItem('anchorBalance').value;
      const asOf = f.elements.namedItem('anchorAsOf').value;
      const allocation = readAlloc();

      if (!name) return toast('נדרש שם לקופה', 5000);
      if (!(monthlyAmount > 0)) return toast('סכום ההפקדה חייב להיות גדול מאפס', 5000);
      if (!firstDepositDate) return toast('נדרש תאריך הפקדה ראשונה', 5000);
      const sum = Object.values(allocation).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) > 1e-3) return toast(`הפיצול מסתכם ב-${numFmt.format(sum)}% במקום 100%`, 6000);
      if ((balRaw === '') !== (asOf === '')) return toast('יתרה ותאריך היתרה — או שניהם או אף אחד', 6000);
      if (asOf && asOf < firstDepositDate) return toast('תאריך היתרה קודם להפקדה הראשונה', 6000);

      const anchor = balRaw === '' ? null : { balance: parseFloat(balRaw), asOf };

      try {
        if (fund) {
          const feeRaw = f.elements.namedItem('annualFeePct')?.value;
          this.sm.updateGemelFund(fund.id, {
            name, fundNumber, monthlyAmount, firstDepositDate,
            annualFeePct: feeRaw === '' || feeRaw == null ? null : parseFloat(feeRaw),
          });
          this.sm.setGemelAnchor(fund.id, anchor || { balance: null, asOf: null });
          const forward = f.elements.namedItem('allocForward')?.checked;
          this.sm.setGemelAllocation(fund.id, allocation, forward ? null : firstDepositDate);
        } else {
          this.sm.addGemelFund({ name, fundNumber, monthlyAmount, firstDepositDate, allocation, anchor });
        }
        this._closeSheet();
        toast(fund ? 'הקופה עודכנה' : 'הקופה נוספה');
      } catch (err) {
        toast(err.message, 7000);
      }
    });
  }

  // Crop constants. CROP is the circle being cropped to; OUT is what gets
  // stored. 320px JPEG keeps a kid's photo at tens of KB, so photos ride along
  // inside the JSON backup without threatening the localStorage quota.
  static CROP = 240;
  static OUT = 320;
  static QUALITY = 0.85;
  // Zoom reaches 3x, so the circle can show as little as a third of the source.
  // This many pixels on the short edge means the export never upscales, while a
  // 12MP phone photo is discarded early.
  static WORK_MIN = 1024;

  _openAvatarSheet(kidId) {
    const kid = this.sm.getState().kids[kidId];
    if (!kid) return;
    this.sheetOpen = true;

    $('#v2-overlay').innerHTML = `
      <div id="sheet-backdrop" class="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm"></div>
      <div class="sheet fixed inset-x-0 bottom-0 z-[71] mx-auto max-h-[92vh] max-w-lg overflow-y-auto rounded-t-3xl"
           dir="rtl" role="dialog" aria-modal="true" aria-label="תמונת פרופיל">
        <div class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-surface-container/95 px-5 py-4 backdrop-blur-xl">
          <h2 class="text-base font-bold text-white">תמונה — ${escapeHtml(kid.name)}</h2>
          <button type="button" id="sheet-close" aria-label="סגור" class="pressable text-outline active:text-white">${icon('close', 'text-[22px]')}</button>
        </div>

        <div class="flex flex-col gap-5 px-5 pb-8 pt-5">
          <div class="flex flex-col items-center gap-2.5">
            <div id="crop-stage" class="crop-stage">
              <canvas id="crop-canvas" width="280" height="280"></canvas>
              <div class="crop-mask"></div>
            </div>
            <p id="crop-hint" class="text-xs text-outline">עדיין לא נבחרה תמונה</p>
          </div>

          <label class="flex items-center gap-3">
            <span class="shrink-0 text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">קירוב</span>
            <input id="crop-zoom" type="range" min="1" max="3" step="0.01" value="1" class="flex-1" style="accent-color:#cebdff;" />
          </label>

          <div class="flex gap-2.5">
            <button type="button" id="crop-pick"
                    class="pressable flex-1 rounded-xl border border-primary/25 bg-primary/10 py-3 text-sm font-bold text-primary">בחר תמונה</button>
            <button type="button" id="crop-save" disabled
                    class="fab-neon flex-1 rounded-xl py-3 text-sm font-bold disabled:opacity-45">שמור</button>
          </div>
          ${kid.avatar ? `<button type="button" id="crop-remove"
                    class="pressable w-full rounded-xl border border-red-400/30 bg-red-400/10 py-3 text-sm font-bold text-red-400">הסר תמונה</button>` : ''}
          <input id="crop-file" type="file" accept="image/*" class="hidden" />
        </div>
      </div>`;

    document.body.style.overflow = 'hidden';
    this._bindCropper(kidId, kid.avatar || null);
  }

  _bindCropper(kidId, existing) {
    const { CROP, OUT, QUALITY, WORK_MIN } = UIv2;
    const overlay = $('#v2-overlay');
    const stage = $('#crop-stage', overlay);
    const canvas = $('#crop-canvas', overlay);
    const ctx = canvas.getContext('2d');
    const zoom = $('#crop-zoom', overlay);
    const save = $('#crop-save', overlay);
    const hint = $('#crop-hint', overlay);

    let source = null;                  // working canvas, EXIF already applied
    let nat = { w: 0, h: 0 };
    let base = 1;
    let view = { tx: 0, ty: 0, k: 1 };

    // One routine for both the preview and the export, so what is on screen is
    // exactly what gets saved.
    const paint = (c, size, scale) => {
      c.save();
      c.fillStyle = '#151219';
      c.fillRect(0, 0, size, size);
      if (source) {
        c.translate(size / 2, size / 2);
        c.scale(scale, scale);
        c.translate(view.tx, view.ty);
        const sc = base * view.k;
        c.scale(sc, sc);
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.drawImage(source, -nat.w / 2, -nat.h / 2);
      }
      c.restore();
    };
    const repaint = () => paint(ctx, 280, 1);

    const clamp = () => {
      const sc = base * view.k;
      const maxX = Math.max(0, (nat.w * sc) / 2 - CROP / 2);
      const maxY = Math.max(0, (nat.h * sc) / 2 - CROP / 2);
      view.tx = Math.min(maxX, Math.max(-maxX, view.tx));
      view.ty = Math.min(maxY, Math.max(-maxY, view.ty));
    };

    // Halving repeatedly rather than one big drawImage: a single step from
    // 4032px to 320px samples too sparsely and comes out soft and aliased.
    const downscale = (src, w, h) => {
      let cur = document.createElement('canvas');
      cur.width = w; cur.height = h;
      let cx = cur.getContext('2d');
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(src, 0, 0, w, h);
      let cw = w, ch = h;
      const step = (nw, nh) => {
        const next = document.createElement('canvas');
        next.width = nw; next.height = nh;
        const nx = next.getContext('2d');
        nx.imageSmoothingEnabled = true; nx.imageSmoothingQuality = 'high';
        nx.drawImage(cur, 0, 0, nw, nh);
        cur = next; cw = nw; ch = nh;
      };
      while (Math.min(cw, ch) > WORK_MIN * 2) step(Math.max(1, Math.round(cw / 2)), Math.max(1, Math.round(ch / 2)));
      if (Math.min(cw, ch) > WORK_MIN) {
        const f = WORK_MIN / Math.min(cw, ch);
        step(Math.round(cw * f), Math.round(ch * f));
      }
      return { canvas: cur, w: cw, h: ch };
    };

    // createImageBitmap with imageOrientation applies the EXIF rotation once,
    // so a portrait phone photo can't end up sideways or stretched by a later
    // drawImage that ignores the tag.
    const decode = async (blobOrUrl) => {
      const blob = blobOrUrl instanceof Blob ? blobOrUrl : await (await fetch(blobOrUrl)).blob();
      if (typeof createImageBitmap === 'function') {
        try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
        catch (e) { /* older Safari: fall through */ }
      }
      const url = URL.createObjectURL(blob);
      try {
        const im = new Image();
        im.src = url;
        await (im.decode ? im.decode() : new Promise((res, rej) => { im.onload = res; im.onerror = rej; }));
        return im;
      } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
    };

    const load = async (blobOrUrl) => {
      try {
        const bmp = await decode(blobOrUrl);
        const work = downscale(bmp, bmp.width || bmp.naturalWidth, bmp.height || bmp.naturalHeight);
        if (bmp.close) bmp.close();
        source = work.canvas;
        nat = { w: work.w, h: work.h };
        base = CROP / Math.min(nat.w, nat.h);
        view = { tx: 0, ty: 0, k: 1 };
        zoom.value = '1';
        repaint();
        save.disabled = false;
        hint.textContent = 'גרור להזזה · צבוט או השתמש במחוון לקירוב';
      } catch (err) {
        hint.textContent = 'לא הצלחתי לקרוא את התמונה';
      }
    };

    repaint();
    if (existing) load(existing);

    $('#sheet-close', overlay).addEventListener('click', () => this._closeSheet());
    $('#sheet-backdrop', overlay).addEventListener('click', () => this._closeSheet());
    $('#crop-pick', overlay).addEventListener('click', () => $('#crop-file', overlay).click());
    $('#crop-file', overlay).addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) load(f);
      e.target.value = '';
    });
    zoom.addEventListener('input', () => { view.k = parseFloat(zoom.value); clamp(); repaint(); });

    $('#crop-remove', overlay)?.addEventListener('click', () => {
      this.sm.setKidAvatar(kidId, null);
      this._closeSheet();
      toast('התמונה הוסרה');
    });

    save.addEventListener('click', () => {
      if (!source) return;
      const c = document.createElement('canvas');
      c.width = c.height = OUT;
      paint(c.getContext('2d'), OUT, OUT / CROP);
      try {
        this.sm.setKidAvatar(kidId, c.toDataURL('image/jpeg', QUALITY));
        this._closeSheet();
        toast('התמונה נשמרה');
      } catch (err) {
        // A quota failure must say so rather than look like nothing happened.
        toast(`שמירת התמונה נכשלה: ${err.message}`, 7000);
      }
    });

    // Pan, and pinch to zoom, from one pointer handler.
    const pts = new Map();
    let start = null;
    stage.addEventListener('pointerdown', (e) => {
      if (!source) return;
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      start = null;
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const list = [...pts.values()];
      if (list.length === 1) {
        if (!start) start = { x: list[0].x, y: list[0].y, tx: view.tx, ty: view.ty };
        view.tx = start.tx + (list[0].x - start.x);
        view.ty = start.ty + (list[0].y - start.y);
      } else {
        const d = Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
        if (!start || !start.d) start = { d, k: view.k };
        view.k = Math.min(3, Math.max(1, start.k * (d / start.d)));
        zoom.value = String(view.k);
      }
      clamp(); repaint();
    });
    const up = (e) => { pts.delete(e.pointerId); start = null; };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
  }

  _closeSheet() {
    this.sheetOpen = false;
    $('#v2-overlay').innerHTML = '';
    document.body.style.overflow = '';
  }

  _bindSheet(type, tx = null) {
    const overlay = $('#v2-overlay');
    $('#sheet-close', overlay).addEventListener('click', () => this._closeSheet());
    $('#sheet-backdrop', overlay).addEventListener('click', () => this._closeSheet());
    $$('[data-tx-type]', overlay).forEach((b) =>
      b.addEventListener('click', () => this._openSheet(b.dataset.txType)));

    const form = $('#tx-form', overlay);

    if (type === 'BUY') {
      // Agorot are already shekel-denominated, so the FX field would be a
      // second, conflicting conversion.
      const cur = form.elements.namedItem('currency');
      const fxWrap = $('#fx-wrap', overlay);
      const fx = form.elements.namedItem('fxRate');
      const sync = () => {
        const agorot = cur.value === 'ILS-Agorot';
        fxWrap.classList.toggle('hidden', agorot);
        if (agorot) fx.value = '0.01';
      };
      cur.addEventListener('change', sync);
      sync();

      const allocSum = () => {
        const total = $$('[data-alloc-kid]', overlay).reduce((a, i) => a + (parseFloat(i.value) || 0), 0);
        const el = $('#alloc-sum', overlay);
        el.textContent = `סה״כ ${total.toFixed(2)}%`;
        el.className = `mt-2 text-xs ${Math.abs(total - 100) < 0.01 ? 'text-secondary' : 'text-red-400'}`;
      };
      $$('[data-alloc-kid]', overlay).forEach((i) => i.addEventListener('input', allocSum));
      allocSum();
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const v = (n) => f.elements.namedItem(n)?.value;
      const num = (n) => parseFloat(v(n));
      const fields = {};
      if (type === 'DEPOSIT') {
        Object.assign(fields, { date: v('date'), kidId: v('kidId'), amountIls: num('amountIls'), note: v('note') || '' });
      } else if (type === 'BUY') {
        const allocation = {};
        $$('[data-alloc-kid]', overlay).forEach((i) => { allocation[i.dataset.allocKid] = parseFloat(i.value); });
        Object.assign(fields, {
          date: v('date'), ticker: v('ticker').trim().toUpperCase(), company: (v('company') || '').trim(),
          totalShares: num('totalShares'), kidsShares: num('kidsShares'), allocation,
          price: num('price'), currency: v('currency') || 'USD', fxRate: num('fxRate'),
          feesIls: num('feesIls') || 0,
        });
      } else if (type === 'SELL') {
        Object.assign(fields, { date: v('date'), ticker: v('ticker').trim().toUpperCase(), sharesSold: num('sharesSold'), netIls: num('netIls') });
      } else {
        Object.assign(fields, { date: v('date'), ticker: v('ticker').trim().toUpperCase(), netIlsTotal: num('netIlsTotal') });
      }

      try {
        if (tx) {
          this.sm.patchTx(tx.id, fields);
        } else if (type === 'DEPOSIT') {
          this.sm.recordDeposit(fields);
        } else if (type === 'BUY') {
          this.sm.recordBuy(fields);
        } else if (type === 'SELL') {
          this.sm.recordSell(fields);
        } else {
          this.sm.recordDividend(fields);
        }
        this._closeSheet();
        toast(tx ? 'עודכן' : 'נשמר');
      } catch (err) {
        toast(err.message, 6000);
      }
    });
  }

  // ---- Events -------------------------------------------------------------

  _bind() {
    document.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        this.tab = tab.dataset.tab; this.kidId = null; this.expanded = null;
        this.render(); window.scrollTo({ top: 0 }); return;
      }

      if (e.target.closest('#kid-back')) {
        this.tab = 'dashboard'; this.kidId = null; this.expanded = null;
        this.render(); window.scrollTo({ top: 0 }); return;
      }

      const kidCard = e.target.closest('[data-kid]');
      if (kidCard) {
        this.kidId = kidCard.dataset.kid;
        this.tab = 'kid';
        this.expanded = null;   // every card starts collapsed
        this.render();
        window.scrollTo({ top: 0 });
        return;
      }

      const toggle = e.target.closest('[data-toggle]');
      if (toggle) { const t = toggle.dataset.toggle; this.expanded = this.expanded === t ? null : t; this.render(); return; }

      if (e.target.closest('#v2-fab')) { this._openSheet('BUY'); return; }

      const avatarKid = e.target.closest('[data-avatar-kid]');
      if (avatarKid) { this._openAvatarSheet(avatarKid.dataset.avatarKid); return; }

      const editSec = e.target.closest('[data-edit-security]');
      if (editSec) { this._openSecuritySheet(editSec.dataset.editSecurity); return; }

      if (e.target.closest('#btn-add-gemel')) { this._openGemelSheet(null); return; }

      const editGemel = e.target.closest('[data-edit-gemel]');
      if (editGemel) { this._openGemelSheet(editGemel.dataset.editGemel); return; }

      const delGemel = e.target.closest('[data-remove-gemel]');
      if (delGemel) {
        const f = (this.sm.getState().gemelFunds || []).find((x) => x.id === delGemel.dataset.removeGemel);
        if (f && confirm(`למחוק את "${f.name}"? הנתונים לא ניתנים לשחזור.`)) {
          this.sm.removeGemelFund(f.id);
          toast('הקופה נמחקה');
        }
        return;
      }

      const delTx = e.target.closest('[data-del-tx]');
      if (delTx) {
        if (confirm('למחוק את התנועה?')) {
          try { this.sm.removeTx(delTx.dataset.delTx); toast('נמחק'); }
          catch (err) { toast(err.message, 6000); }
        }
        return;
      }

      const editTx = e.target.closest('[data-edit-tx]');
      if (editTx) {
        const tx = this.sm.getState().ledger.find((t) => t.id === editTx.dataset.editTx);
        if (tx) this._openSheet(tx.type, tx);
        return;
      }

      if (e.target.closest('#btn-add-kid')) {
        const name = prompt('שם הילד/ה');
        if (name && name.trim()) this.sm.addKid(name.trim());
        return;
      }

      const rename = e.target.closest('[data-rename-kid]');
      if (rename) {
        const id = rename.dataset.renameKid;
        const name = prompt('שם חדש', this.sm.getState().kids[id]?.name || '');
        if (name && name.trim()) this.sm.renameKid(id, name.trim());
        return;
      }

      const removeKid = e.target.closest('[data-remove-kid]');
      if (removeKid) {
        if (confirm('להסיר את הילד/ה?')) {
          try { this.sm.removeKid(removeKid.dataset.removeKid); }
          catch (err) { toast(err.message, 6000); }
        }
        return;
      }

      const rmQuote = e.target.closest('[data-remove-quote]');
      if (rmQuote) { if (confirm('להסיר ציטוט?')) this.sm.removeQuote(rmQuote.dataset.removeQuote); return; }

      if (e.target.closest('#btn-test-ticker')) { this._testTicker(); return; }
      if (e.target.closest('#btn-export')) { this._export(); return; }
      if (e.target.closest('#btn-import')) { $('#import-file')?.click(); return; }
    });

    document.addEventListener('change', (e) => {
      const price = e.target.closest('[data-quote-price]');
      if (price) {
        const ticker = price.dataset.quotePrice;
        const q = this.sm.getState().quotes[ticker];
        this.sm.upsertQuote({
          ticker, company: q?.company, price: parseFloat(price.value),
          currency: q?.currency || 'USD', asOf: today(), source: 'manual',
        });
        return;
      }
      if (e.target.id === 'set-fx') { this.sm.setFxRate(parseFloat(e.target.value)); return; }
      if (e.target.id === 'set-worker') {
        setWorkerUrl((e.target.value || '').trim().replace(/\/+$/, ''));
        toast(e.target.value.trim() ? 'נשמר Worker URL' : 'נמחק Worker URL');
        return;
      }
      if (e.target.id === 'import-file') { this._import(e.target.files?.[0]); return; }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.sheetOpen) this._closeSheet();
    });

    // Pull to refresh. Only a drag that begins at the very top counts, and it
    // is suppressed while the sheet is open so the form can scroll freely.
    const start = (y) => {
      if (this.refreshing || this.sheetOpen || window.scrollY > 0) return;
      this.pullStart = y;
    };
    const move = (y, ev) => {
      if (this.pullStart === null) return;
      const d = y - this.pullStart;
      if (d <= 0) return;
      if (ev.cancelable) ev.preventDefault();
      this._showPull(d * 0.6);
    };
    const end = (y) => {
      if (this.pullStart === null) return;
      const d = (y - this.pullStart) * 0.6;
      this.pullStart = null;
      if (d >= 64) this._refreshQuotes(); else this._resetPull();
    };

    document.addEventListener('touchstart', (e) => start(e.touches[0].clientY), { passive: true });
    document.addEventListener('touchmove', (e) => move(e.touches[0].clientY, e), { passive: false });
    document.addEventListener('touchend', (e) => end((e.changedTouches[0] || {}).clientY || 0));
    // Mouse drag mirrors the gesture so the app is usable on a desktop too.
    document.addEventListener('mousedown', (e) => start(e.clientY));
    document.addEventListener('mousemove', (e) => { if (this.pullStart !== null) move(e.clientY, e); });
    document.addEventListener('mouseup', (e) => end(e.clientY));
  }

  async _testTicker() {
    const input = $('#test-ticker');
    const out = $('#test-result');
    const t = (input?.value || '').trim();
    if (!t) return toast('הזן טיקר');
    out.classList.remove('hidden');
    out.textContent = `בודק ${t}…`;
    const r = await testWorker(t);
    out.textContent = r.msg;
    out.className = `mt-2 whitespace-pre-wrap break-all font-data text-[11px] ${r.ok ? 'text-secondary' : 'text-red-400'}`;
  }

  _export() {
    // The worker URL lives under QuoteFetcher's own localStorage key, not in
    // the ledger state, so a plain state export drops it — and a restore onto
    // a new device would come back with quote fetching quietly broken.
    const data = JSON.parse(this.sm.exportJson());
    data.settings = { ...data.settings, quoteWorkerUrl: getWorkerUrl() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kids-portfolio-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  _import(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        // Read it before the import: a file from an older export won't carry
        // the key, and that must leave the current worker URL alone rather
        // than clearing it.
        const worker = parsed?.settings?.quoteWorkerUrl;
        this.sm.importJson(parsed);
        if (typeof worker === 'string') setWorkerUrl(worker);
        toast('הנתונים יובאו');
      } catch (err) { toast(`ייבוא נכשל: ${err.message}`, 7000); }
    };
    reader.readAsText(file);
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toastHost() {
  let host = $('#v2-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'v2-toasts';
    host.dir = 'rtl';
    host.className = 'pointer-events-none fixed inset-x-0 bottom-[calc(7rem+env(safe-area-inset-bottom))] z-[80] flex flex-col items-center gap-2 px-4';
    document.body.appendChild(host);
  }
  return host;
}

function makeToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast max-w-sm rounded-xl px-4 py-2.5 text-center text-sm text-white';
  el.textContent = msg;
  toastHost().appendChild(el);
  return el;
}

export function toast(msg, ms = 3000) {
  const el = makeToast(msg);
  setTimeout(() => el.remove(), ms);
}

// A toast that stays put while a long job runs, then reports its outcome.
export function stickyToast(msg) {
  const el = makeToast(msg);
  return {
    update: (m) => { el.textContent = m; },
    finish: (m, ms = 4000) => { el.textContent = m; setTimeout(() => el.remove(), ms); },
  };
}
