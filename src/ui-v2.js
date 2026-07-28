// JuniorInvest — UI v2 mockup shell.
//
// PHASE 1: static mock data only. This module deliberately imports nothing
// from src/state, src/ledger or src/view — the redesign is being reviewed as
// a visual skeleton first, and the engine stays untouched until it's approved.
//
// MOCK is shaped like the real selectors' output so Phase 2 can swap the
// constant for a Selectors call without reworking the render functions.

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK = {
  portfolio: {
    totalIls: 217422.47,
    profitIls: 34908.12,
    profitPct: 19.1,
    xirrPct: 14.2,
    asOf: '28 ביולי 2026',
  },
  // Parent ghost shares are internal to dividend math and never surface here.
  kids: [
    { name: 'איתמר', allocationPct: 60, valueIls: 130453.48, profitIls: 20944.87, xirrPct: 14.6 },
    { name: 'אורי',  allocationPct: 40, valueIls: 86968.99,  profitIls: 13963.25, xirrPct: 13.6 },
  ],
  holdings: [
    {
      ticker: 'VOO',
      company: 'Vanguard S&P 500 ETF',
      valueIls: 98340.20,
      profitPct: 22.4,
      profitIls: 17984.55,
      shares: 42.5,
      buyPrice: '$412.30',
      currentPrice: '$504.68',
      split: [
        { name: 'איתמר', pct: 60, shares: 25.5, valueIls: 59004.12 },
        { name: 'אורי',  pct: 40, shares: 17.0, valueIls: 39336.08 },
      ],
    },
    {
      ticker: 'QQQ',
      company: 'Invesco QQQ Trust',
      valueIls: 71882.15,
      profitPct: 18.9,
      profitIls: 11428.30,
      shares: 31.0,
      buyPrice: '$389.10',
      currentPrice: '$462.65',
      split: [
        { name: 'איתמר', pct: 60, shares: 18.6, valueIls: 43129.29 },
        { name: 'אורי',  pct: 40, shares: 12.4, valueIls: 28752.86 },
      ],
    },
    {
      ticker: '1159250',
      company: 'הראל סל ת״א 125',
      valueIls: 47200.12,
      profitPct: -2.3,
      profitIls: -1111.24,
      shares: 810,
      buyPrice: '‏5,962 אג׳',
      currentPrice: '‏5,825 אג׳',
      split: [
        { name: 'איתמר', pct: 60, shares: 486, valueIls: 28320.07 },
        { name: 'אורי',  pct: 40, shares: 324, valueIls: 18880.05 },
      ],
    },
  ],
  // amountIls is the transaction's cash value, always positive — the kind
  // carries the direction. Signing these would read as profit/loss, which a
  // purchase is not.
  ledger: [
    { kind: 'BUY',      date: '14 ביולי 2026', ticker: 'VOO',     detail: '12 מניות · $504.68',    amountIls: 22_010.40 },
    { kind: 'DIVIDEND', date: '02 ביולי 2026', ticker: 'VOO',     detail: 'דיבידנד רבעוני',         amountIls: 412.88 },
    { kind: 'BUY',      date: '21 ביוני 2026', ticker: '1159250', detail: '310 יחידות · 5,962 אג׳', amountIls: 18_482.20 },
    { kind: 'SELL',     date: '09 ביוני 2026', ticker: 'QQQ',     detail: '4 מניות · $462.65',     amountIls: 7_402.40 },
    { kind: 'BUY',      date: '18 במאי 2026',  ticker: 'QQQ',     detail: '9 מניות · $441.02',     amountIls: 15_876.72 },
  ],
};

const TABS = [
  { id: 'dashboard', label: 'דשבורד',  icon: 'dashboard' },
  { id: 'holdings',  label: 'החזקות',  icon: 'donut_small' },
  { id: 'ledger',    label: 'יומן',    icon: 'receipt_long' },
  { id: 'settings',  label: 'הגדרות',  icon: 'settings' },
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const ilsFmt = new Intl.NumberFormat('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });

// Latin/numeric runs are isolated so RTL never reorders them.
const ltr = (s, cls = '') => `<bdi dir="ltr" class="font-data-tabular ${cls}">${s}</bdi>`;

const ils = (n) => `₪ ${ilsFmt.format(Math.abs(n))}`;
const signedIls = (n) => `${n < 0 ? '−' : '+'}${ils(n)}`;
const signedPct = (n) => `${n < 0 ? '−' : '+'}${numFmt.format(Math.abs(n))}%`;

// Gains use the app's emerald, losses its soft red.
const toneOf = (n) => (n < 0 ? 'text-error' : 'text-secondary');

const icon = (name, cls = '') =>
  `<span class="material-symbols-outlined ${cls}">${name}</span>`;

// ---------------------------------------------------------------------------
// View state (local to the mockup — no EventBus, no persistence)
// ---------------------------------------------------------------------------

const view = {
  tab: 'dashboard',
  // One holding starts expanded so the accordion state is visible on load.
  expanded: 'VOO',
};

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

const card = (inner, extra = '') => `
  <div class="rounded-2xl border border-gray-800 bg-white/[0.02] ${extra}">${inner}</div>`;

const sectionTitle = (text, trailing = '') => `
  <div class="flex items-baseline justify-between px-1 pb-3 pt-2">
    <h2 class="text-sm font-semibold tracking-wide text-on-surface-variant">${text}</h2>
    ${trailing ? `<span class="text-xs text-outline">${trailing}</span>` : ''}
  </div>`;

const screenHeader = (title, subtitle) => `
  <header class="px-5 pb-2 pt-8">
    <h1 class="text-2xl font-semibold text-on-surface">${title}</h1>
    ${subtitle ? `<p class="mt-1 text-sm text-outline">${subtitle}</p>` : ''}
  </header>`;

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function renderDashboard() {
  const p = MOCK.portfolio;

  const hero = `
    <section class="px-5 pt-10 pb-8 text-center">
      <p class="text-xs font-semibold uppercase tracking-[0.18em] text-outline">שווי תיק כולל</p>
      <div class="mt-3 text-[2.75rem] font-semibold leading-none text-on-surface">
        ${ltr(ils(p.totalIls))}
      </div>
      <!-- Deliberately text-only: no pills or borders competing with the total. -->
      <div class="mt-5 flex items-center justify-center gap-6 text-sm">
        <span class="${toneOf(p.profitIls)} font-semibold">
          ${ltr(signedIls(p.profitIls))}
          <span class="opacity-70">${ltr(`(${signedPct(p.profitPct)})`)}</span>
        </span>
        <span class="h-3 w-px bg-outline-variant"></span>
        <span class="text-on-surface-variant">
          XIRR <span class="font-semibold text-on-surface">${ltr(`${numFmt.format(p.xirrPct)}%`)}</span>
        </span>
      </div>
      <p class="mt-4 text-xs text-outline">עודכן ${p.asOf}</p>
    </section>`;

  const kids = MOCK.kids.map((k) => card(`
    <div class="flex items-center justify-between p-5">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h3 class="text-base font-semibold text-on-surface">${k.name}</h3>
          <span class="text-xs text-outline">${ltr(`${k.allocationPct}%`)}</span>
        </div>
        <p class="mt-2 text-xs ${toneOf(k.profitIls)}">
          ${ltr(signedIls(k.profitIls))}
          <span class="text-outline">· XIRR ${ltr(`${numFmt.format(k.xirrPct)}%`)}</span>
        </p>
      </div>
      <div class="shrink-0 text-lg font-semibold text-on-surface">${ltr(ils(k.valueIls))}</div>
    </div>`, 'pressable active:bg-white/[0.04]')).join('');

  return `
    ${hero}
    <section class="px-5 pb-2">
      ${sectionTitle('הילדים')}
      <div class="space-y-3">${kids}</div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Holdings — progressive disclosure
// ---------------------------------------------------------------------------

function holdingCard(h) {
  const open = view.expanded === h.ticker;

  // Collapsed state shows only what a glance needs: ticker, value, profit %.
  const summary = `
    <button type="button" data-toggle="${h.ticker}"
            aria-expanded="${open}"
            class="pressable flex w-full items-center justify-between gap-4 p-5 text-right active:bg-white/[0.04]">
      <div class="min-w-0">
        <div class="text-base font-semibold text-on-surface">${ltr(h.ticker)}</div>
        <div class="mt-1 truncate text-xs text-outline">${h.company}</div>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <div class="text-left">
          <div class="text-base font-semibold text-on-surface">${ltr(ils(h.valueIls))}</div>
          <div class="mt-1 text-xs font-semibold ${toneOf(h.profitPct)}">${ltr(signedPct(h.profitPct))}</div>
        </div>
        ${icon('expand_more', `chevron text-outline ${open ? 'open' : ''}`)}
      </div>
    </button>`;

  const row = (label, value, tone = 'text-on-surface') => `
    <div class="flex items-center justify-between py-2">
      <span class="text-xs text-outline">${label}</span>
      <span class="text-sm ${tone}">${ltr(value)}</span>
    </div>`;

  const split = h.split.map((s) => `
    <div class="flex items-center justify-between py-2">
      <span class="text-sm text-on-surface-variant">
        ${s.name} <span class="text-xs text-outline">${ltr(`${s.pct}%`)}</span>
      </span>
      <span class="flex items-baseline gap-2 text-sm text-on-surface">
        ${ltr(ils(s.valueIls))}
        <span class="text-xs text-outline">${ltr(`${numFmt.format(s.shares)} מנ׳`)}</span>
      </span>
    </div>`).join('');

  const details = `
    <div class="accordion ${open ? 'open' : ''}">
      <div>
        <div class="border-t border-gray-800 px-5 pb-5 pt-4">
          ${row('כמות מניות', numFmt.format(h.shares))}
          ${row('מחיר קנייה ממוצע', h.buyPrice)}
          ${row('מחיר נוכחי', h.currentPrice)}
          ${row('רווח/הפסד', signedIls(h.profitIls), toneOf(h.profitIls))}

          <div class="mt-4 border-t border-gray-800 pt-4">
            <p class="pb-1 text-xs font-semibold tracking-wide text-on-surface-variant">חלוקה בין הילדים</p>
            ${split}
          </div>
        </div>
      </div>
    </div>`;

  return card(summary + details, 'overflow-hidden');
}

function renderHoldings() {
  return `
    ${screenHeader('החזקות', `${MOCK.holdings.length} ניירות · הקש על כרטיס לפירוט`)}
    <section class="space-y-3 px-5 pt-4">
      ${MOCK.holdings.map(holdingCard).join('')}
    </section>`;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

// Only a dividend is income; a buy or sell is a position change, so neither
// gets the gain/loss palette. The icon tint carries the kind instead.
const KIND = {
  BUY:      { label: 'קנייה',   icon: 'add_shopping_cart', iconTone: 'text-primary',   amountTone: 'text-on-surface' },
  SELL:     { label: 'מכירה',   icon: 'sell',              iconTone: 'text-tertiary',  amountTone: 'text-on-surface' },
  DIVIDEND: { label: 'דיבידנד', icon: 'savings',           iconTone: 'text-secondary', amountTone: 'text-secondary' },
};

function renderLedger() {
  const rows = MOCK.ledger.map((t) => {
    const k = KIND[t.kind];
    const amount = t.kind === 'DIVIDEND' ? `+${ils(t.amountIls)}` : ils(t.amountIls);
    return `
    <div class="pressable flex items-center gap-4 px-5 py-4 active:bg-white/[0.04]">
      <div class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/[0.04] ${k.iconTone}">
        ${icon(k.icon, 'text-[20px]')}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold text-on-surface">${k.label}</span>
          <span class="text-xs text-outline">${ltr(t.ticker)}</span>
        </div>
        <div class="mt-1 truncate text-xs text-outline">${t.detail}</div>
      </div>
      <div class="shrink-0 text-left">
        <div class="text-sm font-semibold ${k.amountTone}">${ltr(amount)}</div>
        <div class="mt-1 text-xs text-outline">${t.date}</div>
      </div>
    </div>`;
  }).join('<div class="mx-5 border-t border-gray-800"></div>');

  return `
    ${screenHeader('יומן', 'כל התנועות, מהחדשה לישנה')}
    <section class="px-5 pt-4">
      ${card(rows, 'overflow-hidden')}
    </section>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsGroup(title, items) {
  const rows = items.map((it) => `
    <button type="button" class="pressable flex w-full items-center gap-4 px-5 py-4 text-right active:bg-white/[0.04]">
      <div class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/[0.04] text-on-surface-variant">
        ${icon(it.icon, 'text-[18px]')}
      </div>
      <span class="min-w-0 flex-1 truncate text-sm text-on-surface">${it.label}</span>
      ${it.value ? `<span class="shrink-0 text-xs text-outline">${it.value}</span>` : ''}
      ${icon('chevron_left', 'text-outline text-[20px]')}
    </button>`).join('<div class="mx-5 border-t border-gray-800"></div>');

  return `
    ${sectionTitle(title)}
    ${card(rows, 'overflow-hidden')}`;
}

function renderSettings() {
  return `
    ${screenHeader('הגדרות')}
    <section class="space-y-6 px-5 pt-4">
      <div>${settingsGroup('תיק', [
        { icon: 'group',              label: 'ילדים והקצאות', value: '2 ילדים' },
        { icon: 'currency_exchange',  label: 'שער דולר/שקל',  value: '3.62' },
      ])}</div>

      <div>${settingsGroup('שערים', [
        { icon: 'sync',   label: 'רענון שערים',     value: 'עודכן היום' },
        { icon: 'lan',    label: 'כתובת Worker',    value: 'מוגדר' },
        { icon: 'search', label: 'בדיקת טיקר' },
      ])}</div>

      <div>${settingsGroup('נתונים', [
        { icon: 'download', label: 'ייצוא JSON' },
        { icon: 'upload',   label: 'ייבוא JSON' },
      ])}</div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Shell: scroll area + FAB + bottom navigation
// ---------------------------------------------------------------------------

const VIEWS = {
  dashboard: renderDashboard,
  holdings: renderHoldings,
  ledger: renderLedger,
  settings: renderSettings,
};

function renderNav() {
  const items = TABS.map((t) => {
    const active = view.tab === t.id;
    return `
      <button type="button" data-tab="${t.id}"
              aria-current="${active ? 'page' : 'false'}"
              class="flex flex-1 flex-col items-center gap-1 py-2 transition-colors ${active ? 'text-primary' : 'text-outline'}">
        ${icon(t.icon, `text-[22px] ${active ? 'fill' : ''}`)}
        <span class="text-[11px] ${active ? 'font-semibold' : ''}">${t.label}</span>
      </button>`;
  }).join('');

  return `
    <nav class="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-gray-800 bg-background/85 backdrop-blur-xl">
      <div class="mx-auto flex max-w-lg items-stretch px-2 pt-1">${items}</div>
    </nav>`;
}

// Bottom-left mirrors the conventional bottom-right FAB under RTL.
const renderFab = () => `
  <button type="button" id="v2-fab" aria-label="תנועה חדשה"
          class="pressable fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-5 z-50 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-on-primary shadow-[0_10px_30px_-6px_rgba(206,189,255,0.5)] active:brightness-95">
    ${icon('add', 'text-[26px] fill')}
  </button>`;

function render() {
  const root = document.getElementById('v2-root');
  root.innerHTML = `
    <!-- Bottom padding clears the nav *and* the FAB, so the last row of a
         list is never parked underneath the button at the end of a scroll. -->
    <div class="mx-auto min-h-screen max-w-lg pb-[calc(10rem+env(safe-area-inset-bottom))]">
      <main id="v2-main">${VIEWS[view.tab]()}</main>
    </div>
    ${renderFab()}
    ${renderNav()}`;
}

// ---------------------------------------------------------------------------
// Mock interactions — presentation only, nothing is persisted.
// ---------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    view.tab = tab.dataset.tab;
    render();
    window.scrollTo({ top: 0 });
    return;
  }

  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const ticker = toggle.dataset.toggle;
    view.expanded = view.expanded === ticker ? null : ticker;
    render();
    return;
  }

  if (e.target.closest('#v2-fab')) {
    // Phase 2 hooks the real transaction form up here.
    console.log('[ui-v2] FAB tapped — transaction sheet is not wired in the mockup');
  }
});

render();
