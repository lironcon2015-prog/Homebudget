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
    fxRate: 3.62,
    asOf: '28 ביולי 2026',
  },
  // Parent ghost shares are internal to dividend math and never surface here.
  kids: [
    { name: 'איתמר', allocationPct: 60, valueIls: 130453.48, cashIls: 1240.10, profitIls: 20944.87, profitPct: 19.1, xirrPct: 14.6 },
    { name: 'אורי',  allocationPct: 40, valueIls: 86968.99,  cashIls: 826.73,  profitIls: 13963.25, profitPct: 19.1, xirrPct: 13.6 },
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
  // carries the direction.
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
  { id: 'holdings',  label: 'החזקות',  icon: 'account_balance_wallet' },
  { id: 'ledger',    label: 'יומן',    icon: 'receipt_long' },
  { id: 'settings',  label: 'הגדרות',  icon: 'settings' },
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const ilsFmt = new Intl.NumberFormat('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });

// Latin/numeric runs are isolated so RTL never reorders them, and forced onto
// the Hanken Grotesk stack so every numeral is tabular.
const ltr = (s, cls = '') => `<bdi dir="ltr" class="font-data tnum ${cls}">${s}</bdi>`;

// Thin space, not a full one: at font-black the ₪ otherwise collides with the
// leading digit, but a normal space leaves the symbol looking detached.
const ils = (n) => `₪ ${ilsFmt.format(Math.abs(n))}`;
const signedIls = (n) => `${n < 0 ? '−' : '+'}${ils(n)}`;
const signedPct = (n) => `${n < 0 ? '−' : '+'}${numFmt.format(Math.abs(n))}%`;

const isUp = (n) => n >= 0;

const icon = (name, cls = '') =>
  `<span class="material-symbols-outlined ${cls}">${name}</span>`;

// Glowing pill — the app's signature indicator. tone: secondary | primary |
// tertiary | red.
function pill(tone, text, { dot = true } = {}) {
  const TONES = {
    secondary: ['bg-secondary/10', 'border-secondary/30', 'bg-secondary', 'text-secondary', '0 0 15px rgba(69,223,164,0.15)'],
    primary:   ['bg-primary/10',   'border-primary/30',   'bg-primary',   'text-primary',   '0 0 15px rgba(206,189,255,0.18)'],
    tertiary:  ['bg-tertiary/10',  'border-tertiary/30',  'bg-tertiary',  'text-tertiary',  '0 0 15px rgba(249,189,34,0.18)'],
    red:       ['bg-red-400/10',   'border-red-400/30',   'bg-red-400',   'text-red-400',   '0 0 15px rgba(248,113,113,0.18)'],
  };
  const [bg, border, dotBg, fg, shadow] = TONES[tone] || TONES.secondary;
  return `<div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full ${bg} border ${border}" style="box-shadow:${shadow};">
    ${dot ? `<span class="w-1.5 h-1.5 rounded-full ${dotBg} animate-pulse shrink-0"></span>` : ''}
    <span class="${fg} font-semibold text-xs font-data tnum tracking-wide whitespace-nowrap">${text}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// View state (local to the mockup — no EventBus, no persistence)
// ---------------------------------------------------------------------------

const view = {
  tab: 'dashboard',
  // One holding starts expanded so the accordion state is visible on load.
  expanded: 'VOO',
  // Review-only: which quote-refresh treatment is being demonstrated.
  // 'header' = freshness chip, 'fab' = mini FAB, 'pull' = pull-to-refresh.
  refreshOption: 'header',
  refreshing: false,
  lastUpdated: '07:12',
};

const REFRESH_OPTIONS = [
  { id: 'header', label: '1 · ציפור טריות' },
  { id: 'fab',    label: '2 · FAB קטן' },
  { id: 'pull',   label: '3 · משיכה' },
];

// Stands in for QuoteFetcher.fetchQuotes so each treatment can be felt with
// real latency and a real busy state.
function simulateRefresh() {
  if (view.refreshing) return;
  view.refreshing = true;
  render();
  setTimeout(() => {
    view.refreshing = false;
    const d = new Date();
    view.lastUpdated = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    render();
  }, 1800);
}

// Option 1 — the freshness chip that is also the control.
function freshnessChip() {
  if (view.refreshOption !== 'header') return '';
  const busy = view.refreshing;
  return `
    <button type="button" data-refresh
            class="pressable mt-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-on-surface-variant active:bg-white/[0.08]">
      ${icon('sync', `text-[15px] text-primary ${busy ? 'spinning' : ''}`)}
      <span>${busy ? 'מרענן שערים…' : `עודכן ${ltr(view.lastUpdated)}`}</span>
    </button>`;
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

const sectionTitle = (text) => `
  <h2 class="px-1 pb-3 pt-1 text-[11px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">${text}</h2>`;

const screenHeader = (title, subtitle) => `
  <header class="px-5 pb-1 pt-8">
    <h1 class="text-2xl font-bold tracking-tight text-white">${title}</h1>
    ${subtitle ? `<p class="mt-1.5 text-sm text-on-surface-variant">${subtitle}</p>` : ''}
    ${freshnessChip()}
  </header>`;

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

// Focal colour per kid card, cycling the brand palette.
const KID_PALETTE = [
  { bright: 'rgba(206, 189, 255, 0.55)', soft: 'rgba(206, 189, 255, 0.16)', accent: 'text-primary',   bar: '#cebdff' },
  { bright: 'rgba(69, 223, 164, 0.50)',  soft: 'rgba(69, 223, 164, 0.14)',  accent: 'text-secondary', bar: '#45dfa4' },
  { bright: 'rgba(249, 189, 34, 0.50)',  soft: 'rgba(249, 189, 34, 0.14)',  accent: 'text-tertiary',  bar: '#f9bd22' },
];

// A fixed-radius circle rather than the default farthest-corner extent: on a
// phone the cards are wide and short, and a proportional gradient floods the
// whole surface instead of reading as a corner glow.
const kidGlow = (c) =>
  `radial-gradient(circle 200px at 14% -8%, ${c.bright} 0%, ${c.soft} 30%, transparent 68%)`;

function kidCard(kid, i) {
  const c = KID_PALETTE[i % KID_PALETTE.length];
  const up = isUp(kid.profitIls);
  // Centre the bar at 40% and let the return nudge it, so a flat kid still
  // reads as a bar rather than an empty track.
  const barPct = Math.max(8, Math.min(95, 40 + kid.profitPct * 2));

  return `
    <div class="glass-card pressable flex flex-col gap-4 rounded-2xl p-5">
      <div class="card-glow" style="background: ${kidGlow(c)};"></div>

      <!-- Identity on the start side, numbers on the end side — the same
           grammar every holdings and ledger row uses. -->
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <div class="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/10 bg-surface-container">
            ${icon('person', `${c.accent} text-[21px]`)}
          </div>
          <div class="min-w-0">
            <h3 class="text-base font-bold text-white">${kid.name}</h3>
            <p class="mt-0.5 text-xs text-on-surface-variant">${ltr(`${kid.allocationPct}%`)} מהתיק</p>
          </div>
        </div>
        <div class="shrink-0 text-left">
          <div class="text-xl font-black tracking-tight text-white">${ltr(ils(kid.valueIls))}</div>
          <div class="mt-0.5 text-sm font-bold ${up ? 'text-secondary' : 'text-red-400'}">${ltr(signedPct(kid.profitPct))}</div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        ${pill(up ? 'secondary' : 'red', signedIls(kid.profitIls))}
        ${pill('primary', `שנתית ${numFmt.format(kid.xirrPct)}%`)}
      </div>

      <div class="kid-progress-track">
        <div class="kid-progress-fill" style="width:${barPct}%; background:${c.bar};"></div>
      </div>

      <div class="flex items-center justify-between">
        <span class="text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">מזומן</span>
        <span class="text-sm font-semibold text-white">${ltr(ils(kid.cashIls))}</span>
      </div>
    </div>`;
}

function renderDashboard() {
  const p = MOCK.portfolio;
  const up = isUp(p.profitIls);

  // Same glass surface, radius and padding as every other card in the app —
  // the total is emphasised by type weight, not by a bespoke floating card.
  const summary = `
    <section class="px-5 pt-4">
      <div class="glass-card rounded-2xl p-5">
        <div class="card-glow" style="background: ${kidGlow(KID_PALETTE[0])};"></div>

        <p class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-tertiary">
          <span class="h-1.5 w-1.5 rounded-full bg-tertiary shadow-[0_0_12px_#f9bd22] animate-pulse"></span>
          שווי תיק כולל (ילדים)
        </p>

        <h2 class="mt-3 text-4xl font-black tracking-tight text-white drop-shadow-[0_2px_15px_rgba(255,255,255,0.22)]">
          ${ltr(ils(p.totalIls))}
        </h2>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          ${pill(up ? 'secondary' : 'red', `${signedIls(p.profitIls)} (${signedPct(p.profitPct)})`)}
          ${pill('primary', `שנתית ${numFmt.format(p.xirrPct)}%`)}
        </div>

        <div class="mt-5 flex items-center justify-between border-t border-white/10 pt-3">
          <span class="text-[10px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">USD/ILS</span>
          <span class="text-sm font-semibold text-white">${ltr(numFmt.format(p.fxRate))}</span>
        </div>
      </div>
    </section>`;

  return `
    ${screenHeader('תיק ההשקעות', `עודכן ${p.asOf}`)}
    ${summary}
    <section class="px-5 pt-6">
      ${sectionTitle('הילדים')}
      <div class="space-y-4">${MOCK.kids.map(kidCard).join('')}</div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Holdings — progressive disclosure
// ---------------------------------------------------------------------------

function holdingCard(h) {
  const open = view.expanded === h.ticker;
  const up = isUp(h.profitPct);
  const yieldTone = up ? 'text-secondary' : 'text-red-400';

  // Collapsed: name on the start side, value + brightly coloured yield on the
  // end side. Nothing else competes.
  const summary = `
    <button type="button" data-toggle="${h.ticker}" aria-expanded="${open}"
            class="pressable flex w-full items-center justify-between gap-4 p-5 text-right">
      <div class="min-w-0">
        <div class="text-base font-bold text-white">${ltr(h.ticker)}</div>
        <div class="mt-0.5 truncate text-xs text-on-surface-variant">${h.company}</div>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <div class="text-left">
          <div class="text-base font-bold text-white">${ltr(ils(h.valueIls))}</div>
          <div class="mt-0.5 text-sm font-bold ${yieldTone}">${ltr(signedPct(h.profitPct))}</div>
        </div>
        ${icon('expand_more', `chevron text-outline text-[20px] ${open ? 'open' : ''}`)}
      </div>
    </button>`;

  const row = (label, value, tone = 'text-white') => `
    <div class="flex items-center justify-between border-b border-gray-800 py-2 text-sm last:border-b-0">
      <span class="text-gray-400">${label}</span>
      <span class="font-semibold ${tone}">${ltr(value)}</span>
    </div>`;

  const split = h.split.map((s) => `
    <div class="flex items-center justify-between border-b border-gray-800 py-2 text-sm last:border-b-0">
      <span class="text-gray-400">${s.name} <span class="text-xs text-outline">${ltr(`${s.pct}%`)}</span></span>
      <span class="flex items-baseline gap-2">
        <span class="font-semibold text-white">${ltr(ils(s.valueIls))}</span>
        <span class="text-xs text-gray-400">${ltr(`${numFmt.format(s.shares)} מנ׳`)}</span>
      </span>
    </div>`).join('');

  const details = `
    <div class="accordion ${open ? 'open' : ''}">
      <div>
        <div class="border-t border-white/10 px-5 pb-5 pt-3">
          ${row('כמות מניות', numFmt.format(h.shares))}
          ${row('מחיר קנייה ממוצע', h.buyPrice)}
          ${row('מחיר נוכחי', h.currentPrice)}
          ${row('רווח/הפסד', signedIls(h.profitIls), yieldTone)}

          <p class="pb-1 pt-5 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">חלוקה בין הילדים</p>
          ${split}
        </div>
      </div>
    </div>`;

  return `<div class="glass-card rounded-2xl">${summary}${details}</div>`;
}

function renderHoldings() {
  return `
    ${screenHeader('החזקות', `${MOCK.holdings.length} ניירות · הקש על כרטיס לפירוט`)}
    <section class="space-y-4 px-5 pt-4">
      ${MOCK.holdings.map(holdingCard).join('')}
    </section>`;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

// The icon's tinted bubble carries the direction of the transaction; only
// income is coloured in the amount column.
const KIND = {
  BUY: {
    label: 'קנייה', icon: 'add_shopping_cart',
    bubble: 'bg-secondary/10 border-secondary/25 text-secondary',
    amountTone: 'text-white',
  },
  SELL: {
    label: 'מכירה', icon: 'sell',
    bubble: 'bg-tertiary/10 border-tertiary/25 text-tertiary',
    amountTone: 'text-white',
  },
  DIVIDEND: {
    label: 'דיבידנד', icon: 'savings',
    bubble: 'bg-secondary/10 border-secondary/25 text-secondary',
    amountTone: 'text-secondary',
  },
};

function renderLedger() {
  const rows = MOCK.ledger.map((t) => {
    const k = KIND[t.kind];
    const amount = t.kind === 'DIVIDEND' ? `+${ils(t.amountIls)}` : ils(t.amountIls);
    return `
    <div class="pressable flex items-center gap-4 px-5 py-4 active:bg-white/[0.04]">
      <div class="grid h-11 w-11 shrink-0 place-items-center rounded-full border ${k.bubble}">
        ${icon(k.icon, 'text-[20px]')}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="text-sm font-bold text-white">${k.label}</span>
          <span class="text-xs text-on-surface-variant">${ltr(t.ticker)}</span>
        </div>
        <div class="mt-1 truncate text-xs text-outline">${t.detail}</div>
      </div>
      <div class="shrink-0 text-left">
        <div class="text-sm font-bold ${k.amountTone}">${ltr(amount)}</div>
        <div class="mt-1 text-xs text-outline">${t.date}</div>
      </div>
    </div>`;
  }).join('<div class="mx-5 border-t border-white/5"></div>');

  return `
    ${screenHeader('יומן', 'כל התנועות, מהחדשה לישנה')}
    <section class="px-5 pt-4">
      <div class="glass-card rounded-2xl">${rows}</div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsGroup(title, items) {
  const rows = items.map((it) => `
    <button type="button" class="pressable flex w-full items-center gap-4 px-5 py-4 text-right active:bg-white/[0.04]">
      <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-white/5 text-primary">
        ${icon(it.icon, 'text-[18px]')}
      </div>
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-white">${it.label}</span>
      ${it.value ? `<span class="shrink-0 text-xs text-on-surface-variant">${it.value}</span>` : ''}
      ${icon('chevron_left', 'text-outline text-[20px]')}
    </button>`).join('<div class="mx-5 border-t border-white/5"></div>');

  return `${sectionTitle(title)}<div class="glass-card rounded-2xl">${rows}</div>`;
}

function renderSettings() {
  return `
    ${screenHeader('הגדרות')}
    <section class="space-y-6 px-5 pt-4">
      <div>${settingsGroup('תיק', [
        { icon: 'group',             label: 'ילדים והקצאות', value: '2 ילדים' },
        { icon: 'currency_exchange', label: 'שער דולר/שקל',  value: '3.62' },
      ])}</div>

      <div>${settingsGroup('שערים', [
        { icon: 'sync',   label: 'רענון שערים',  value: 'עודכן היום' },
        { icon: 'lan',    label: 'כתובת Worker', value: 'מוגדר' },
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

// Floating iOS-style capsule, detached from the screen edges. The active tab
// carries its own filled pill, so selection survives being read at a glance
// without relying on colour alone.
function renderNav() {
  const items = TABS.map((t) => {
    const active = view.tab === t.id;
    return `
      <button type="button" data-tab="${t.id}"
              aria-current="${active ? 'page' : 'false'}"
              class="tab-item flex flex-1 flex-col items-center gap-1 rounded-full px-1 py-2 ${
                active ? 'text-primary' : 'text-outline'}">
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
// Option 2 stacks a smaller refresh button directly above it.
const renderFab = () => {
  const mini = view.refreshOption !== 'fab' ? '' : `
    <button type="button" data-refresh aria-label="רענן שערים"
            class="pressable fixed bottom-[calc(11rem+env(safe-area-inset-bottom))] left-[1.55rem] z-50 grid h-11 w-11 place-items-center rounded-full border border-primary/30 bg-surface-container/90 text-primary backdrop-blur-xl shadow-[0_6px_20px_rgba(0,0,0,0.5)]">
      ${icon('sync', `text-[20px] ${view.refreshing ? 'spinning' : ''}`)}
    </button>`;

  return `${mini}
  <button type="button" id="v2-fab" aria-label="תנועה חדשה"
          class="fab-neon fixed bottom-[calc(6.75rem+env(safe-area-inset-bottom))] left-5 z-50 grid h-14 w-14 place-items-center rounded-2xl transition-all">
    ${icon('add', 'text-[26px] fill')}
  </button>`;
};

// Review-only scaffolding — remove once a treatment is chosen.
const renderOptionSwitch = () => `
  <div class="opt-switch sticky top-0 z-[60] flex items-center gap-2 px-4 py-2">
    <span class="shrink-0 text-[10px] font-bold uppercase tracking-[0.15em] text-outline">רענון</span>
    <div class="flex flex-1 gap-1">
      ${REFRESH_OPTIONS.map((o) => `
        <button type="button" data-opt="${o.id}"
                class="flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                  view.refreshOption === o.id
                    ? 'bg-primary/20 text-primary'
                    : 'bg-white/[0.04] text-on-surface-variant'}">${o.label}</button>`).join('')}
    </div>
  </div>`;

function render() {
  const root = document.getElementById('v2-root');
  const pull = view.refreshOption !== 'pull' ? '' :
    `<div id="pull-ind" class="pull-ind">${icon('sync', `text-[20px] ${view.refreshing ? 'spinning' : ''}`)}</div>`;

  root.innerHTML = `
    ${renderOptionSwitch()}
    ${pull}
    <div class="ambient-orb"><div class="orb-violet"></div><div class="orb-emerald"></div></div>
    <!-- Bottom padding clears the floating bar *and* the FAB, so the last row
         of a list is never parked underneath either at the end of a scroll. -->
    <div class="relative z-10 mx-auto min-h-screen max-w-lg pb-[calc(11rem+env(safe-area-inset-bottom))]">
      <main id="v2-main">${VIEWS[view.tab]()}</main>
    </div>
    ${renderFab()}
    ${renderNav()}`;

  if (view.refreshing && view.refreshOption === 'pull') showPull(56, true);
}

// ---------------------------------------------------------------------------
// Option 3 — pull to refresh
// ---------------------------------------------------------------------------

const PULL_TRIGGER = 64;
let pullStart = null;

function showPull(dist, locked = false) {
  const el = document.getElementById('pull-ind');
  if (!el) return;
  const y = Math.min(dist, 88);
  el.style.transform = `translateY(${y}px) rotate(${locked ? 0 : dist * 2}deg)`;
  el.style.opacity = String(Math.min(1, dist / PULL_TRIGGER));
}

function resetPull() {
  const el = document.getElementById('pull-ind');
  if (!el) return;
  el.style.transition = 'transform .25s ease, opacity .25s ease';
  el.style.transform = 'translateY(-3rem)';
  el.style.opacity = '0';
  setTimeout(() => { if (el) el.style.transition = ''; }, 260);
}

function onPullStart(y) {
  // Only a drag that begins at the very top counts as a pull.
  if (view.refreshOption !== 'pull' || view.refreshing || window.scrollY > 0) return;
  pullStart = y;
}

function onPullMove(y, e) {
  if (pullStart === null) return;
  const d = y - pullStart;
  if (d <= 0) return;
  if (e.cancelable) e.preventDefault();
  showPull(d * 0.6);
}

function onPullEnd(y) {
  if (pullStart === null) return;
  const d = (y - pullStart) * 0.6;
  pullStart = null;
  if (d >= PULL_TRIGGER) simulateRefresh(); else resetPull();
}

document.addEventListener('touchstart', (e) => onPullStart(e.touches[0].clientY), { passive: true });
document.addEventListener('touchmove', (e) => onPullMove(e.touches[0].clientY, e), { passive: false });
document.addEventListener('touchend', (e) => onPullEnd((e.changedTouches[0] || {}).clientY || 0));
// Mouse drag mirrors the gesture so the option can be reviewed on a desktop.
document.addEventListener('mousedown', (e) => onPullStart(e.clientY));
document.addEventListener('mousemove', (e) => { if (pullStart !== null) onPullMove(e.clientY, e); });
document.addEventListener('mouseup', (e) => onPullEnd(e.clientY));

// ---------------------------------------------------------------------------
// Mock interactions — presentation only, nothing is persisted.
// ---------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const opt = e.target.closest('[data-opt]');
  if (opt) {
    view.refreshOption = opt.dataset.opt;
    render();
    return;
  }

  if (e.target.closest('[data-refresh]')) { simulateRefresh(); return; }

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
