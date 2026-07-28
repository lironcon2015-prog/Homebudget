// src/ui.js
// All DOM rendering & event wiring. Reads ViewModels from Selectors,
// writes back through StateManager.

import {
  dashboardViewModel,
  holdingsViewModel,
  ledgerViewModel,
  tickersViewModel,
  fmtIls,
} from './view/Selectors.js';
import { xirr } from './math/Xirr.js';
import { fetchQuotes, getWorkerUrl, setWorkerUrl, testWorker, getResolvedSymbol, setResolvedSymbol } from './io/QuoteFetcher.js';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const VIEWS = ['dashboard', 'holdings', 'ledger', 'settings', 'kid-portfolio'];

export class UI {
  constructor(stateManager) {
    this.sm = stateManager;
    this.activeView = 'dashboard';
    this.isTotalMode = false;
  }

  init() {
    this._bindNav();
    this._bindForm();
    this._bindSettings();
    this._bindIO();
    this._bindEditDialog();
    const vEl = document.getElementById('settings-version');
    if (vEl) vEl.textContent = 'v' + (window.JI_APP_VERSION || '?');
    document.getElementById('btn-hero-total')?.addEventListener('click', () => {
      this.isTotalMode = true;
      this.activeKidId = null;
      this._showView('kid-portfolio');
      this.renderAll();
    });
    this.sm.on('state:changed', () => this.renderAll());
    this.renderAll();
    this._showView(this.activeView);
  }

  // ---- Navigation -----------------------------------------------------

  _bindNav() {
    $$('[data-nav]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this._showView(el.dataset.nav);
      });
    });
  }

  _showView(name) {
    if (!VIEWS.includes(name)) return;
    this.activeView = name;
    VIEWS.forEach((v) => {
      const panel = $(`#view-${v}`);
      if (panel) {
        panel.classList.toggle('hidden', v !== name);
        panel.classList.toggle('flex', v === name);
      }
    });
    $$('[data-nav]').forEach((el) => {
      const active = el.dataset.nav === name;
      // Remove initial-HTML classes that conflict with JS-managed active state
      el.classList.remove('bg-primary/10', 'text-on-background', 'border', 'border-primary/30', 'shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]');
      el.classList.toggle('bg-white/5', active);
      el.classList.toggle('text-white', active);
      el.classList.toggle('text-on-surface-variant', !active);
      const icon = el.querySelector('.material-symbols-outlined');
      if (icon) {
        icon.classList.toggle('fill', active);
        icon.classList.toggle('text-primary', active);
      }
    });
  }

  // ---- Render ---------------------------------------------------------

  renderAll() {
    const state = this.sm.getState();
    const derived = this.sm.getDerived();
    this._renderDashboard(state, derived);
    this._renderHoldings(state, derived);
    this._renderLedger(state);
    this._renderFormHelpers(state, derived);
    this._renderSettings(state);
    this._renderKidPortfolio(state, derived);
  }

  _renderDashboard(state, derived) {
    const vm = dashboardViewModel(state, derived);
    $('#hero-total').textContent = vm.totalKidsValueFmt;
    $('#hero-fx').innerHTML =
      `<span class="material-symbols-outlined text-[16px]">currency_exchange</span> USD/ILS ${vm.fxRate} · ${formatDateHe(vm.fxRateAsOf)}`;

    let xirrEl = $('#hero-xirr');
    if (!xirrEl) {
      xirrEl = document.createElement('div');
      xirrEl.id = 'hero-xirr';
      xirrEl.className = 'mt-4 flex flex-wrap items-center justify-center gap-2 z-10 relative';
      $('#hero-fx')?.closest('div')?.after(xirrEl);
    }
    if (vm.totalKidsValue > 0) {
      const pSign = vm.totalProfit >= 0 ? 'pos' : 'neg';
      const profitPrefix = pSign === 'pos' ? '+' : '';
      const profitText = `${profitPrefix}${vm.totalProfitFmt} (${profitPrefix}${vm.totalReturnPct.toFixed(1)}%)`;
      let html = pillHtml({ tone: pSign === 'pos' ? 'secondary' : 'red', text: profitText });
      if (vm.totalKidsXirr != null) {
        const xirrTone = (vm.totalKidsXirr ?? 0) >= 0 ? 'primary' : 'red';
        html += pillHtml({ tone: xirrTone, text: `שנתית ${vm.totalKidsXirrFmt}` });
      }
      xirrEl.innerHTML = html;
    } else {
      xirrEl.innerHTML = '';
    }

    const grid = $('#kids-grid');
    const n = Math.max(vm.kids.length, 1);
    // Use inline style — Tailwind CDN doesn't scan JS strings for dynamic classes
    grid.className = 'grid gap-6 mt-8 relative z-10 w-full max-w-5xl mx-auto';
    grid.style.gridTemplateColumns = `repeat(${Math.min(n, 3)}, minmax(0, 1fr))`;
    grid.innerHTML = vm.kids.map((kid, i) => kidCardHtml(kid, i)).join('');
    $$('.kid-card', grid).forEach((card) => {
      card.addEventListener('click', () => {
        this.isTotalMode = false;
        this.activeKidId = card.dataset.kidId;
        this._showView('kid-portfolio');
        this.renderAll();
      });
    });
  }

  _renderHoldings(state, derived) {
    const vm = holdingsViewModel(state, derived);
    const tbody = $('#holdings-tbody');
    if (!vm.rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-on-surface-variant">אין אחזקות עדיין</td></tr>`;
      return;
    }
    const ltr = (s) => `<bdi dir="ltr" style="unicode-bidi: isolate;">${s}</bdi>`;
    tbody.innerHTML = vm.rows.map((r) => {
      const hasLots = r.lots.length > 0;
      const lotsId = `lots-${r.ticker.replace(/[^a-zA-Z0-9]/g, '_')}`;
      return `
        <tr class="row-card border-b border-white/5 hover:bg-white/[0.02] transition-colors group">
          <td class="cell-header py-5 pr-4">
            <div class="flex items-center gap-3">
              ${hasLots
                ? `<button data-lots-toggle="${escapeHtml(lotsId)}" class="flex items-center justify-center w-6 h-6 rounded-lg bg-white/5 hover:bg-white/10 transition-colors shrink-0" title="הצג לוטים">
                    <span class="material-symbols-outlined text-on-surface-variant text-sm" id="chevron-${escapeHtml(lotsId)}">expand_more</span>
                  </button>`
                : '<div class="w-6 shrink-0"></div>'}
              <div class="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center border border-white/5 shrink-0">
                <span class="material-symbols-outlined text-on-surface-variant text-base">show_chart</span>
              </div>
              <div class="min-w-0 flex-1">
                <div class="font-semibold text-white"><bdi dir="ltr" class="ticker-cell inline-block whitespace-nowrap text-left font-data-tabular" style="unicode-bidi: isolate; max-width: 140px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(r.ticker)}</bdi></div>
                <div class="text-xs text-on-surface-variant truncate">${escapeHtml(r.company)}</div>
              </div>
            </div>
          </td>
          <td data-label="סה״כ מניות" class="py-5 text-on-surface-variant">${ltr(escapeHtml(r.totalSharesFmt))}</td>
          <td data-label="מחיר נוכחי" class="py-5 text-on-surface-variant whitespace-nowrap">${ltr(escapeHtml(r.priceFmt) + ` <span style="opacity:0.6;font-size:0.85em;">· ${escapeHtml(formatDateHe(r.asOf))}</span>`)}</td>
          <td data-label="שווי בש״ח" class="py-5 text-white font-data-tabular">${ltr(escapeHtml(r.valueFmt))}</td>
          <td data-label="פיצול בין הילדים" class="cell-block py-5">
            <div class="flex flex-col gap-1 text-xs">
              ${r.perKid.map((k) => `
                <div class="flex items-center justify-between gap-3 bg-white/[0.03] border border-white/5 rounded-lg px-3 py-1.5">
                  <span class="text-on-surface-variant">${escapeHtml(k.kidName)}</span>
                  <span class="font-data-tabular text-white">${ltr(escapeHtml(k.sharesFmt))}</span>
                </div>`).join('')}
            </div>
          </td>
        </tr>
        ${hasLots ? `<tr id="${escapeHtml(lotsId)}" class="lots-row hidden border-b border-white/5">
          <td colspan="5" class="pb-3 px-4">
            <div class="lots-inner rounded-xl bg-white/[0.02] border border-white/5">
              <table class="lots-table w-full text-right text-xs" style="min-width: 420px;">
                <thead>
                  <tr class="border-b border-white/5">
                    <th class="py-2 pr-4 font-semibold text-on-surface-variant/60 font-label-caps uppercase tracking-wider">תאריך</th>
                    <th class="py-2 font-semibold text-on-surface-variant/60 font-label-caps uppercase tracking-wider">מחיר קנייה</th>
                    <th class="py-2 font-semibold text-on-surface-variant/60 font-label-caps uppercase tracking-wider">מחיר נוכחי</th>
                    <th class="py-2 font-semibold text-on-surface-variant/60 font-label-caps uppercase tracking-wider">שינוי %</th>
                    <th class="py-2 pl-4 font-semibold text-on-surface-variant/60 font-label-caps uppercase tracking-wider">תשואה שנתית</th>
                  </tr>
                </thead>
                <tbody>
                  ${r.lots.map((lot) => `
                    <tr class="lot-row border-b border-white/[0.03] last:border-0">
                      <td data-label="תאריך" class="lot-date py-2 pr-4 text-on-surface-variant whitespace-nowrap">${ltr(escapeHtml(formatDateHe(lot.openDate)))}</td>
                      <td data-label="מחיר קנייה" class="py-2 text-on-surface-variant whitespace-nowrap">${ltr(escapeHtml(lot.buyPriceFmt))}</td>
                      <td data-label="מחיר נוכחי" class="py-2 text-on-surface-variant whitespace-nowrap">${ltr(escapeHtml(lot.currentPriceFmt))}</td>
                      <td data-label="שינוי %" class="py-2 font-data-tabular whitespace-nowrap ${lot.pctSign === 'pos' ? 'text-emerald-400' : lot.pctSign === 'neg' ? 'text-red-400' : 'text-on-surface-variant'}">${ltr(escapeHtml(lot.pctChangeFmt))}</td>
                      <td data-label="תשואה שנתית" class="py-2 pl-4 font-data-tabular whitespace-nowrap ${lot.xirrSign === 'pos' ? 'text-emerald-400' : lot.xirrSign === 'neg' ? 'text-red-400' : 'text-on-surface-variant'}">${ltr(escapeHtml(lot.xirrLotFmt))}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </td>
        </tr>` : ''}
      `;
    }).join('');

    tbody.onclick = (e) => {
      const btn = e.target.closest('[data-lots-toggle]');
      if (!btn) return;
      const lotsId = btn.dataset.lotsToggle;
      const lotsRow = document.getElementById(lotsId);
      const chevron = document.getElementById(`chevron-${lotsId}`);
      if (lotsRow) {
        const collapsed = lotsRow.classList.toggle('hidden');
        if (chevron) chevron.style.transform = collapsed ? '' : 'rotate(180deg)';
      }
    };
  }

  _renderLedger(state) {
    const vm = ledgerViewModel(state);
    const tbody = $('#ledger-tbody');
    if (!vm.rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-on-surface-variant">היומן ריק</td></tr>`;
      return;
    }
    tbody.innerHTML = vm.rows.map((r) => `
      <tr class="row-card border-b border-white/5 hover:bg-white/[0.02] group">
        <td data-label="תאריך" class="py-4 pr-4 text-on-surface-variant text-xs whitespace-nowrap">${escapeHtml(formatDateHe(r.date))}</td>
        <td data-label="פעולה" class="py-4">
          <span class="text-xs uppercase tracking-widest font-semibold ${r.sign === 'pos' ? 'text-secondary' : 'text-primary'}">
            ${escapeHtml(r.label)}
          </span>
        </td>
        <td data-label="נושא" class="py-4 text-on-background font-medium"><bdi dir="ltr" class="ticker-cell inline-block whitespace-nowrap text-left font-data-tabular" style="unicode-bidi: isolate; max-width: 140px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(r.who)}</bdi></td>
        <td data-label="פרטים" class="py-4 text-on-surface-variant text-xs">${escapeHtml(r.details)}</td>
        <td data-label="סכום" class="cell-amount py-4 text-left">
          <span class="font-data-tabular ${r.sign === 'pos' ? 'text-secondary' : 'text-on-background'}">${escapeHtml(r.amountFmt)}</span>
          <span class="row-actions inline-flex items-center gap-2 mr-3 md:mr-3">
            <button data-edit-tx="${r.id}" class="opacity-0 md:group-hover:opacity-100 transition-opacity text-on-surface-variant hover:text-secondary text-xs">עריכה</button>
            <button data-del-tx="${r.id}" class="opacity-0 md:group-hover:opacity-100 transition-opacity text-on-surface-variant hover:text-primary text-xs">מחק</button>
          </span>
        </td>
      </tr>
    `).join('');

    $$('[data-edit-tx]', tbody).forEach((btn) => {
      btn.addEventListener('click', () => this._openEditDialog(btn.dataset.editTx));
    });
    $$('[data-del-tx]', tbody).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('למחוק את הפעולה?')) this.sm.removeTx(btn.dataset.delTx);
      });
    });
  }

  _renderFormHelpers(state, derived) {
    const kids = Object.values(state.kids);

    const depKid = $('#dep-kidId');
    if (depKid) {
      const cur = depKid.value;
      depKid.innerHTML = kids.map((k) => `<option value="${k.id}">${escapeHtml(k.name)}</option>`).join('');
      if (cur && state.kids[cur]) depKid.value = cur;
    }

    const allocBox = $('#buy-allocation');
    if (allocBox && allocBox.children.length === 0) {
      const split = Math.floor(100 / Math.max(kids.length, 1));
      const last = 100 - split * (kids.length - 1);
      allocBox.innerHTML = kids.map((k, i) => `
        <label class="flex items-center justify-between gap-3 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3">
          <span class="text-sm text-on-surface-variant">${escapeHtml(k.name)} %</span>
          <input type="number" min="0" max="100" step="0.01"
                 data-alloc-kid="${k.id}"
                 value="${i === kids.length - 1 ? last : split}"
                 class="bg-transparent text-white font-data-tabular text-left w-24 outline-none focus:text-primary" />
        </label>
      `).join('');

      // Auto-calculate the other kid's % when exactly 2 kids exist
      const allocInputs = $$('[data-alloc-kid]', allocBox);
      if (allocInputs.length === 2) {
        allocInputs.forEach((inp, i) => {
          inp.addEventListener('input', () => {
            allocInputs[1 - i].value = Math.max(0, 100 - parseFloat(inp.value || 0)).toFixed(2);
          });
        });
      }
    }

    const dl = $('#ticker-suggestions');
    if (dl) {
      const ts = tickersViewModel(state, derived);
      dl.innerHTML = ts.map((t) =>
        `<option value="${escapeHtml(t.ticker)}">${escapeHtml(t.company)}</option>`).join('');
    }
  }

  _renderSettings(state) {
    const fx = $('#settings-fx');
    if (fx && document.activeElement !== fx) fx.value = state.settings.lastFxRate;

    const wu = $('#settings-worker-url');
    if (wu && document.activeElement !== wu) wu.value = getWorkerUrl();

    const list = $('#settings-kids');
    if (list) {
      list.innerHTML = Object.values(state.kids).map((k) => `
        <li class="flex items-center justify-between gap-3 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3">
          <input data-kid-name="${k.id}" value="${escapeHtml(k.name)}"
                 class="bg-transparent text-white outline-none flex-1 focus:text-primary" />
          <button data-rm-kid="${k.id}" class="text-on-surface-variant hover:text-primary text-xs">הסר</button>
        </li>
      `).join('');

      $$('[data-kid-name]', list).forEach((inp) =>
        inp.addEventListener('change', () =>
          this.sm.renameKid(inp.dataset.kidName, inp.value.trim() || 'ילד/ה')));
      $$('[data-rm-kid]', list).forEach((btn) =>
        btn.addEventListener('click', () => {
          try { this.sm.removeKid(btn.dataset.rmKid); }
          catch (e) { alert(e.message); }
        }));
    }

    const quoteBox = $('#settings-quotes');
    if (quoteBox) {
      const tickers = Object.values(state.quotes).sort((a, b) => a.ticker.localeCompare(b.ticker));
      quoteBox.innerHTML = tickers.length
        ? tickers.map((q) => `
          <div class="flex flex-wrap items-center gap-2 sm:gap-3 bg-white/[0.03] border border-white/5 rounded-xl px-3 sm:px-4 py-3">
            <div class="flex-1 min-w-0">
              <div class="text-white font-semibold"><bdi dir="ltr" class="ticker-cell inline-block whitespace-nowrap text-left font-data-tabular" style="unicode-bidi: isolate; max-width: 140px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(q.ticker)}</bdi></div>
              <div class="text-xs text-on-surface-variant truncate">${escapeHtml(q.company)} · ${escapeHtml(formatDateHe(q.asOf))}</div>
            </div>
            <input type="number" step="0.01" min="0" value="${q.price ?? q.priceUsd}"
                   data-quote="${q.ticker}"
                   class="bg-transparent text-white font-data-tabular w-24 sm:w-28 text-left outline-none focus:text-primary shrink-0" />
            <span class="text-xs text-on-surface-variant shrink-0 min-w-[2rem] inline-block text-left">${escapeHtml(q.currency === 'ILS-Agorot' ? 'אג\'' : (q.currency || 'USD'))}</span>
            <button data-rm-quote="${escapeHtml(q.ticker)}" class="text-on-surface-variant hover:text-primary text-xs shrink-0">הסר</button>
            <div class="basis-full flex items-center gap-2">
              <label class="text-xs text-on-surface-variant shrink-0" for="sym-${escapeHtml(q.ticker)}">סימול משיכה</label>
              <input id="sym-${escapeHtml(q.ticker)}" type="text" dir="ltr" placeholder="${escapeHtml(q.ticker)}"
                     value="${escapeHtml(getResolvedSymbol(q.ticker))}"
                     data-sym-quote="${escapeHtml(q.ticker)}"
                     class="bg-transparent text-on-surface-variant font-data-tabular text-xs w-36 text-left outline-none focus:text-primary border-b border-white/10 focus:border-primary/50" />
            </div>
          </div>`).join('')
        : '<p class="text-sm text-on-surface-variant">לא נשמרו ציטוטים. ייווצרו אוטומטית בעת קנייה ראשונה.</p>';

      $$('[data-quote]', quoteBox).forEach((inp) =>
        inp.addEventListener('change', () => {
          const ticker = inp.dataset.quote;
          const q = state.quotes[ticker];
          this.sm.upsertQuote({
            ticker,
            company: q?.company,
            price: parseFloat(inp.value),
            currency: q?.currency || 'USD',
            asOf: new Date().toISOString().slice(0, 10),
            source: 'manual',
          });
        }));

      // Pinning a fetch symbol only affects quote lookups — the ledger keeps
      // the original ticker, so lots and transactions stay attached to it.
      $$('[data-sym-quote]', quoteBox).forEach((inp) =>
        inp.addEventListener('change', () => {
          setResolvedSymbol(inp.dataset.symQuote, inp.value);
          toast(inp.value.trim()
            ? `${inp.dataset.symQuote} יימשך לפי ${inp.value.trim().toUpperCase()}`
            : `בוטל סימול משיכה עבור ${inp.dataset.symQuote}`);
        }));

      $$('[data-rm-quote]', quoteBox).forEach((btn) =>
        btn.addEventListener('click', () => {
          if (confirm('להסיר ציטוט?')) this.sm.removeQuote(btn.dataset.rmQuote);
        }));
    }
  }

  // ---- Forms ----------------------------------------------------------

  _bindForm() {
    const typeSel = $('#tx-type');
    typeSel.addEventListener('change', () => this._showFormFor(typeSel.value));
    this._showFormFor(typeSel.value);

    $('#form-deposit').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        this.sm.recordDeposit({
          date: f.date.value,
          kidId: f.kidId.value,
          amountIls: parseFloat(f.amountIls.value),
          note: f.note.value || '',
        });
        f.reset();
        this._setDefaultDate(f.date);
        toast('ההפקדה נשמרה');
      } catch (err) { alert(err.message); }
    });

    const formBuy = $('#form-buy');
    const currencySel = formBuy.elements.namedItem('currency');
    const fxRateWrapper = $('#fxRate-wrapper');
    const fxRateInp = formBuy.elements.namedItem('fxRate');
    const showHideFxRate = () => {
      if (currencySel.value === 'ILS-Agorot') {
        fxRateWrapper.classList.add('hidden');
        fxRateInp.value = '0.01';
      } else {
        fxRateWrapper.classList.remove('hidden');
      }
    };
    currencySel.addEventListener('change', showHideFxRate);
    // After a reset(), currency reverts to USD but wrapper would stay hidden — restore it
    formBuy.addEventListener('reset', () => setTimeout(showHideFxRate, 0));

    formBuy.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const allocation = {};
        $$('[data-alloc-kid]').forEach((inp) => {
          allocation[inp.dataset.allocKid] = parseFloat(inp.value);
        });
        const priceEl = f.elements.namedItem('price') || f.elements.namedItem('priceUsd');
        const currencyEl = f.elements.namedItem('currency');
        const fxRateEl = f.elements.namedItem('fxRate');
        this.sm.recordBuy({
          date: f.elements.namedItem('date').value,
          ticker: f.elements.namedItem('ticker').value.trim().toUpperCase(),
          company: f.elements.namedItem('company').value.trim(),
          totalShares: parseFloat(f.elements.namedItem('totalShares').value),
          kidsShares: parseFloat(f.elements.namedItem('kidsShares').value),
          allocation,
          price: parseFloat(priceEl?.value),
          currency: currencyEl?.value || 'USD',
          fxRate: parseFloat(fxRateEl?.value),
          feesIls: parseFloat(f.elements.namedItem('feesIls')?.value) || 0,
          externalFunds: f.elements.namedItem('externalFunds')?.checked ?? true,
        });
        f.reset();
        this._setDefaultDate(f.elements.namedItem('date'));
        toast('הקנייה נשמרה');
      } catch (err) { alert(err.message); }
    });

    $('#form-sell').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        this.sm.recordSell({
          date: f.date.value,
          ticker: f.ticker.value.trim().toUpperCase(),
          sharesSold: parseFloat(f.sharesSold.value),
          netIls: parseFloat(f.netIls.value),
        });
        f.reset();
        this._setDefaultDate(f.date);
        toast('המכירה נשמרה');
      } catch (err) { alert(err.message); }
    });

    $('#form-dividend').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        this.sm.recordDividend({
          date: f.date.value,
          ticker: f.ticker.value.trim().toUpperCase(),
          netIlsTotal: parseFloat(f.netIlsTotal.value),
        });
        f.reset();
        this._setDefaultDate(f.date);
        toast('הדיבידנד נשמר');
      } catch (err) { alert(err.message); }
    });

    $$('input[type="date"]').forEach((d) => this._setDefaultDate(d));
  }

  _renderKidPortfolio(state, derived) {
    if (this.activeView !== 'kid-portfolio') return;
    const section = $('#view-kid-portfolio');
    if (!section) return;

    const fxRate = state.settings.lastFxRate;
    const today = new Date();
    const signCls = (n) => n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-on-surface-variant';
    const priceFmt = (p, c) => {
      const sym = { USD: '$', EUR: '€', GBP: '£', 'ILS-Agorot': '' };
      return p != null ? `${c in sym ? sym[c] : (c || '')}${p.toFixed(2)}` : '—';
    };

    let displayName, avatarIcon, pv, profit, lots;

    if (this.isTotalMode) {
      displayName = 'התיק הכללי';
      avatarIcon = 'account_balance_wallet';
      pv = Object.values(derived.portfolioValueByKid).reduce((a, b) => a + b, 0);
      profit = { total: 0, unrealized: 0, realized: 0 };
      for (const p of Object.values(derived.profitByKid || {})) {
        profit.total += p.total || 0;
        profit.unrealized += p.unrealized || 0;
        profit.realized += p.realized || 0;
      }
      lots = (derived.lots || []).filter((lot) =>
        Object.values(lot.remaining?.kids || {}).some((v) => v > 0)
      );
    } else {
      const kidId = this.activeKidId;
      const kid = state.kids[kidId];
      if (!kid) { section.innerHTML = ''; return; }
      displayName = kid.name;
      avatarIcon = 'person';
      pv = derived.portfolioValueByKid[kidId] || 0;
      profit = derived.profitByKid?.[kidId] || { total: 0, unrealized: 0, realized: 0 };
      lots = (derived.lots || []).filter((lot) => (lot.remaining.kids[kidId] || 0) > 0);
    }

    const rows = lots.map((lot) => {
      const shares = this.isTotalMode
        ? Object.values(lot.remaining?.kids || {}).reduce((a, b) => a + b, 0)
        : lot.remaining.kids[this.activeKidId];
      const q = state.quotes[lot.ticker];
      const qPrice = q?.price ?? q?.priceUsd ?? null;
      const qCurrency = q?.currency ?? 'USD';
      const currentRate = qCurrency === 'ILS-Agorot' ? 0.01 : fxRate;
      const buyRate = lot.currency === 'ILS-Agorot' ? 0.01 : lot.fxAtBuy;
      const costBasis = shares * lot.price * buyRate;
      const currentVal = qPrice != null ? shares * qPrice * currentRate : null;
      const lotProfit = currentVal != null ? currentVal - costBasis : null;
      const pctChange = qPrice != null ? (qPrice - lot.price) / lot.price : null;

      let xirrVal = null;
      if (qPrice != null && costBasis !== 0) {
        const lotDk = String(lot.openDate).slice(0, 10);
        const todDk = today.toISOString().slice(0, 10);
        if (lotDk !== todDk) {
          const res = xirr([{ date: lot.openDate, amount: -costBasis }, { date: today, amount: currentVal }]);
          xirrVal = res?.value ?? null;
        }
      }

      const ltr = (s) => `<bdi dir="ltr" style="unicode-bidi: isolate;">${s}</bdi>`;
      return `
        <tr class="row-card kid-lot-card border-b border-white/5 hover:bg-white/[0.02]">
          <td class="cell-header py-3 pr-4 font-semibold text-white"><bdi dir="ltr" class="ticker-cell inline-block whitespace-nowrap text-left font-data-tabular" style="unicode-bidi: isolate; max-width: 140px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(lot.ticker)}</bdi></td>
          <td data-label="תאריך קנייה" class="py-3 text-on-surface-variant text-xs">${ltr(escapeHtml(formatDateHe(lot.openDate)))}</td>
          <td data-label="מחיר קנייה" class="py-3 font-data-tabular text-on-surface-variant">${ltr(escapeHtml(priceFmt(lot.price, lot.currency)))}</td>
          <td data-label="מחיר נוכחי" class="py-3 font-data-tabular text-on-surface-variant">${ltr(escapeHtml(priceFmt(qPrice, qCurrency)))}</td>
          <td data-label="שינוי %" class="py-3 font-data-tabular ${signCls(pctChange)}">${ltr(pctChange != null ? (pctChange * 100).toFixed(1) + '%' : '—')}</td>
          <td data-label="רווח (₪)" class="py-3 font-data-tabular ${signCls(lotProfit)}">${ltr(lotProfit != null ? fmtIls(lotProfit) : '—')}</td>
          <td data-label="תשואה שנתית" class="py-3 font-data-tabular ${signCls(xirrVal)}">${ltr(xirrVal != null ? (xirrVal * 100).toFixed(1) + '%' : '—')}</td>
        </tr>`;
    }).join('');

    section.innerHTML = `
      <div class="glass-panel rounded-3xl p-4 sm:p-6 md:p-8 lg:p-10">
        <div class="flex flex-wrap items-center gap-3 md:gap-4 mb-5 md:mb-8">
          <button class="text-on-surface-variant hover:text-white transition-colors shrink-0" id="kid-portfolio-back">
            <span class="material-symbols-outlined">arrow_forward</span>
          </button>
          <div class="w-10 h-10 md:w-12 md:h-12 rounded-full bg-surface-container overflow-hidden border border-white/10 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-primary" style="font-size:22px;">${escapeHtml(avatarIcon)}</span>
          </div>
          <h2 class="text-xl md:text-2xl font-bold text-on-background min-w-0 truncate">${escapeHtml(displayName)}</h2>
          <span class="text-on-surface-variant text-sm w-full md:w-auto md:mr-auto">שווי נוכחי: <span class="text-white font-data-tabular">${fmtIls(pv)}</span></span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mb-5 md:mb-8 text-center">
          <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-3 md:p-4">
            <div class="text-[10px] md:text-xs text-on-surface-variant/60 uppercase tracking-wider mb-1">רווח כולל</div>
            <div class="text-lg md:text-xl font-bold font-data-tabular ${signCls(profit.total)}">${fmtIls(profit.total)}</div>
          </div>
          <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-3 md:p-4">
            <div class="text-[10px] md:text-xs text-on-surface-variant/60 uppercase tracking-wider mb-1">רווח לא ממומש</div>
            <div class="text-lg md:text-xl font-bold font-data-tabular ${signCls(profit.unrealized)}">${fmtIls(profit.unrealized)}</div>
          </div>
          <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-3 md:p-4">
            <div class="text-[10px] md:text-xs text-on-surface-variant/60 uppercase tracking-wider mb-1">רווח ממומש</div>
            <div class="text-lg md:text-xl font-bold font-data-tabular ${signCls(profit.realized)}">${fmtIls(profit.realized)}</div>
          </div>
        </div>
        ${lots.length ? `
        <div class="md:overflow-x-auto">
          <table class="w-full text-right border-collapse text-sm table-as-cards">
            <thead>
              <tr class="border-b border-white/10 font-label-caps text-[11px] text-on-surface-variant uppercase tracking-[0.15em]">
                <th class="py-3 pr-4">נכס</th>
                <th class="py-3">תאריך קנייה</th>
                <th class="py-3">מחיר קנייה</th>
                <th class="py-3">מחיר נוכחי</th>
                <th class="py-3">שינוי %</th>
                <th class="py-3">רווח (₪)</th>
                <th class="py-3">תשואה שנתית</th>
              </tr>
            </thead>
            <tbody class="font-data-tabular tabular-nums">${rows}</tbody>
          </table>
        </div>` : '<p class="text-on-surface-variant text-sm">אין אחזקות פתוחות</p>'}
      </div>`;

    $('#kid-portfolio-back')?.addEventListener('click', () => {
      this.isTotalMode = false;
      this._showView('dashboard');
    });
  }

  _setDefaultDate(input) {
    if (input && !input.value) input.value = new Date().toISOString().slice(0, 10);
  }

  _bindEditDialog() {
    const dialog = $('#edit-tx-dialog');
    if (!dialog) return;
    const close = () => dialog.close();
    $('#edit-tx-cancel').addEventListener('click', close);
    $('#edit-tx-close').addEventListener('click', close);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });

    $('#edit-tx-save').addEventListener('click', () => {
      const txId = dialog.dataset.editingTx;
      const tx = this.sm.getState().ledger.find((t) => t.id === txId);
      if (!tx) return;
      const root = $('#edit-tx-fields');
      const g = (name) => root.querySelector(`[name="${name}"]`);
      try {
        const fields = { date: g('date')?.value };
        switch (tx.type) {
          case 'DEPOSIT':
            Object.assign(fields, {
              kidId: g('kidId')?.value,
              amountIls: parseFloat(g('amountIls')?.value),
              note: g('note')?.value || '',
            });
            break;
          case 'BUY': {
            const allocation = {};
            $$('[data-edit-alloc-kid]', root).forEach((inp) => {
              allocation[inp.dataset.editAllocKid] = parseFloat(inp.value);
            });
            Object.assign(fields, {
              ticker: g('ticker')?.value.trim().toUpperCase(),
              company: g('company')?.value.trim(),
              totalShares: parseFloat(g('totalShares')?.value),
              kidsShares: parseFloat(g('kidsShares')?.value),
              price: parseFloat(g('price')?.value),
              currency: g('currency')?.value || 'USD',
              fxRate: parseFloat(g('fxRate')?.value),
              feesIls: parseFloat(g('feesIls')?.value) || 0,
              externalFunds: g('externalFunds')?.checked ?? true,
              allocation,
            });
            break;
          }
          case 'SELL':
            Object.assign(fields, {
              ticker: g('ticker')?.value.trim().toUpperCase(),
              sharesSold: parseFloat(g('sharesSold')?.value),
              netIls: parseFloat(g('netIls')?.value),
            });
            break;
          case 'DIVIDEND':
            Object.assign(fields, {
              ticker: g('ticker')?.value.trim().toUpperCase(),
              netIlsTotal: parseFloat(g('netIlsTotal')?.value),
            });
            break;
        }
        this.sm.patchTx(txId, fields);
        dialog.close();
        toast('הפעולה עודכנה');
      } catch (err) { alert(err.message); }
    });
  }

  _openEditDialog(txId) {
    const state = this.sm.getState();
    const tx = state.ledger.find((t) => t.id === txId);
    if (!tx) return;
    const dialog = $('#edit-tx-dialog');
    if (!dialog) return;

    const LABELS = { DEPOSIT: 'הפקדה', BUY: 'קנייה', SELL: 'מכירה', DIVIDEND: 'דיבידנד' };
    $('#edit-tx-title').textContent = `עריכת ${LABELS[tx.type] || tx.type}`;
    dialog.dataset.editingTx = txId;

    const kids = Object.values(state.kids);
    const fld = (label, inner, wide = false) =>
      `<div${wide ? ' class="md:col-span-2"' : ''}><label class="field-label">${label}</label>${inner}</div>`;
    const numI = (name, val, step = '0.01', min = '0') =>
      `<input class="input-field tabular-nums" type="number" name="${name}" step="${step}" min="${min}" value="${val}" required />`;
    const txtI = (name, val, extra = '') =>
      `<input class="input-field" type="text" name="${name}" value="${escapeHtml(String(val ?? ''))}" ${extra} required />`;

    let html = fld('תאריך', `<input class="input-field" type="date" name="date" value="${tx.date}" required />`);

    switch (tx.type) {
      case 'DEPOSIT':
        html += fld('ילד/ה',
          `<select name="kidId" class="input-field">${kids.map((k) =>
            `<option value="${k.id}"${k.id === tx.kidId ? ' selected' : ''}>${escapeHtml(k.name)}</option>`
          ).join('')}</select>`);
        html += fld('סכום (₪)', numI('amountIls', tx.amountIls, '0.01', '0.01'));
        html += fld('הערה', `<input class="input-field" type="text" name="note" value="${escapeHtml(tx.note || '')}" />`, false);
        break;

      case 'BUY': {
        const price = tx.price ?? tx.priceUsd;
        const currencies = ['USD', 'ILS-Agorot', 'EUR', 'GBP'];
        const CURR_LABELS = { 'ILS-Agorot': 'אגורות (מקומי)', USD: 'USD', EUR: 'EUR', GBP: 'GBP' };
        const currSel = `<select name="currency" class="input-field">${currencies.map((c) =>
          `<option value="${c}"${c === tx.currency ? ' selected' : ''}>${CURR_LABELS[c] || c}</option>`).join('')}</select>`;
        html += fld('סימול', txtI('ticker', tx.ticker, 'style="text-transform:uppercase"'));
        html += fld('שם החברה', txtI('company', tx.company || ''));
        html += fld('מטבע', currSel);
        html += fld('מחיר למניה', numI('price', price, '0.0001', '0.0001'));
        html += fld('שער חליפין ל-ILS', numI('fxRate', tx.fxRate, '0.0001', '0.0001'));
        html += fld('סך מניות (כולל הורה)', numI('totalShares', tx.totalShares, '0.00000001', '0'));
        html += fld('מניות ילדים', numI('kidsShares', tx.kidsShares, '0.00000001', '0'));
        html += fld('עמלות (₪)', numI('feesIls', tx.feesIls || 0));
        html += `<div class="md:col-span-2 flex items-center gap-3">
          <input type="checkbox" name="externalFunds" id="edit-chk-ext" ${tx.externalFunds ? 'checked' : ''} class="w-5 h-5 rounded accent-[#d0bcff]" />
          <label for="edit-chk-ext" class="field-label mb-0 cursor-pointer">כסף חיצוני (לא מהתיק)</label>
        </div>`;
        html += `<div class="md:col-span-2">
          <label class="field-label">פיצול אחוזים בין הילדים</label>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            ${Object.entries(tx.allocation).map(([kidId, pct]) => {
              const kidName = state.kids[kidId]?.name || kidId;
              return `<label class="flex items-center justify-between gap-3 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3">
                <span class="text-sm text-on-surface-variant">${escapeHtml(kidName)} %</span>
                <input type="number" min="0" max="100" step="0.01" data-edit-alloc-kid="${kidId}" value="${pct}"
                       class="bg-transparent text-white font-data-tabular text-left w-24 outline-none focus:text-primary" />
              </label>`;
            }).join('')}
          </div>
        </div>`;
        break;
      }

      case 'SELL':
        html += fld('סימול', txtI('ticker', tx.ticker, 'style="text-transform:uppercase"'));
        html += fld('מניות שנמכרו', numI('sharesSold', tx.sharesSold, '0.00000001', '0.00000001'));
        html += fld('תקבול נטו (₪)', numI('netIls', tx.netIls));
        break;

      case 'DIVIDEND':
        html += fld('סימול', txtI('ticker', tx.ticker, 'style="text-transform:uppercase"'));
        html += fld('סך הדיבידנד נטו (₪)', numI('netIlsTotal', tx.netIlsTotal), true);
        break;
    }

    $('#edit-tx-fields').innerHTML = html;
    dialog.showModal();
  }

  _showFormFor(type) {
    ['DEPOSIT', 'BUY', 'SELL', 'DIVIDEND'].forEach((t) => {
      const f = $(`#form-${t.toLowerCase()}`);
      if (f) f.classList.toggle('hidden', t !== type);
    });
  }

  _refreshAllQuotes() {
    return this._refreshQuotes(
      $('#btn-fetch-quotes'),
      $('#btn-fetch-quotes-mobile'),
      $('#btn-fetch-quotes-side'),
    );
  }

  async _refreshQuotes(...buttons) {
    const state = this.sm.getState();
    const derived = this.sm.getDerived();
    const activeTickers = derived.lots.map((l) => l.ticker);
    const tickers = [...new Set([...Object.keys(state.quotes || {}), ...activeTickers])];
    if (!tickers.includes('ILS=X')) tickers.push('ILS=X');
    if (!tickers.length) return toast('אין מניות לעדכון');

    const btns = buttons.filter(Boolean);
    btns.forEach((b) => { b.disabled = true; b.classList.add('refreshing'); });

    const status = stickyToast(`מושך נתונים עבור ${tickers.length} טיקרים...`);

    // Hard cap: never let the spinner hang longer than this regardless of
    // proxy/network state. Allows for a first-time symbol resolution (bounded
    // at 20s per ticker inside QuoteFetcher) plus the surrounding round-trips.
    const HARD_TIMEOUT_MS = 45000;
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), HARD_TIMEOUT_MS),
    );

    try {
      const newPrices = await Promise.race([
        fetchQuotes(tickers, {
          onProgress: ({ done, total, ticker, ok }) => {
            status.update(`(${done}/${total}) ${ok ? '✓' : '✗'} ${ticker}`);
          },
        }),
        timeoutPromise,
      ]);
      const stockTickers = tickers.filter((t) => t !== 'ILS=X');
      const succeeded = [];
      const failed = [];

      Object.keys(newPrices).forEach((t) => {
        if (t === 'ILS=X') { this.sm.setFxRate(newPrices[t].price); return; }
        const q = state.quotes[t] || {};
        // A currency already on the quote is the user's choice and wins. Only
        // when there is none do we take the source's, then the name heuristic.
        const currency = q.currency
          || newPrices[t].currency
          || (t.endsWith('.TA') || /^\d+(\.TA)?$/.test(t) ? 'ILS-Agorot' : 'USD');
        this.sm.upsertQuote({ ticker: t, company: q.company || t, price: newPrices[t].price, currency, asOf: new Date().toISOString().slice(0, 10), source: 'api' });
        succeeded.push(t);
      });

      stockTickers.forEach((t) => { if (!newPrices[t]) failed.push(t); });

      const fxLine = newPrices['ILS=X'] ? ` · USD/ILS ${newPrices['ILS=X'].price.toFixed(3)}` : '';
      const summary = `✓ ${succeeded.length}/${stockTickers.length} עודכנו${fxLine}` +
        (failed.length ? ` | ✗ נכשלו: ${failed.join(', ')}` : '');
      status.finish(summary, succeeded.length ? 4000 : 7000);
      console.log('[QuoteFetch] succeeded:', succeeded, '| failed:', failed, '| raw:', newPrices);
      this.renderAll();
    } catch (e) {
      console.error('[QuoteFetch] unexpected error:', e);
      const msg = e?.message === 'timeout'
        ? 'הזמן עבר 45 שניות - כל הפרוקסים נכשלו. נסה שוב מאוחר יותר.'
        : 'שגיאה בעת משיכת הנתונים';
      status.finish(msg, 7000);
    } finally {
      btns.forEach((b) => { b.disabled = false; b.classList.remove('refreshing'); });
    }
  }

  _bindSettings() {
    const quoteBox = $('#settings-quotes');
    if (quoteBox) {
      quoteBox.insertAdjacentHTML('beforebegin', `<button id="btn-fetch-quotes" class="bg-primary/20 text-primary px-4 py-2 rounded-xl text-sm font-semibold hover:bg-primary/30 transition-colors mb-4 flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">sync</span> רענן שערים (Yahoo)</button>`);
      $('#btn-fetch-quotes').addEventListener('click', () => this._refreshAllQuotes());
    }

    $('#btn-fetch-quotes-mobile')?.addEventListener('click', () => this._refreshAllQuotes());
    $('#btn-fetch-quotes-side')?.addEventListener('click', () => this._refreshAllQuotes());

    $('#btn-add-kid').addEventListener('click', () => {
      const name = prompt('שם הילד/ה החדש/ה');
      if (name && name.trim()) {
        this.sm.addKid(name.trim());
        const allocBox = $('#buy-allocation');
        if (allocBox) allocBox.innerHTML = '';
      }
    });

    $('#settings-fx').addEventListener('change', (e) => {
      this.sm.setFxRate(parseFloat(e.target.value));
    });

    const workerInput = $('#settings-worker-url');
    if (workerInput) {
      let lastToasted = getWorkerUrl();
      const save = (e) => {
        const trimmed = (e.target.value || '').trim().replace(/\/+$/, '');
        setWorkerUrl(trimmed);
        if (trimmed !== lastToasted) {
          toast(trimmed ? 'נשמר Worker URL' : 'נמחק Worker URL');
          lastToasted = trimmed;
        }
      };
      workerInput.addEventListener('input', save);
      workerInput.addEventListener('change', save);
      workerInput.addEventListener('blur', save);

      if (!$('#btn-test-worker')) {
        workerInput.insertAdjacentHTML('afterend',
          `<div class="mt-2 flex flex-wrap items-center gap-2">
             <input id="input-test-ticker" type="text" placeholder="AAPL / 1150184 / 1150184=5844" dir="ltr" class="input-field text-sm flex-1 min-w-0" style="padding:0.4rem 0.6rem;" />
             <button id="btn-test-worker" type="button" class="bg-primary/20 text-primary px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-primary/30 transition-colors whitespace-nowrap">בדוק טיקר</button>
           </div>
           <div id="worker-test-result" class="mt-2 text-xs font-mono break-all whitespace-pre-wrap text-on-surface-variant"></div>`);
        const runTest = async () => {
          const btn = $('#btn-test-worker');
          const out = $('#worker-test-result');
          const t = ($('#input-test-ticker').value || 'AAPL').trim();
          btn.disabled = true; out.textContent = `בודק ${t}...`;
          const r = await testWorker(t);
          out.textContent = r.msg;
          out.className = 'mt-2 text-xs font-mono break-all whitespace-pre-wrap ' + (r.ok ? 'text-secondary' : 'text-red-400');
          btn.disabled = false;
        };
        $('#btn-test-worker').addEventListener('click', runTest);
        $('#input-test-ticker').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runTest(); } });
      }
    }
  }

  _bindIO() {
    const doExport = () => {
      const blob = new Blob([this.sm.exportJson()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `juniorinvest-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    };
    const doImport = () => $('#import-file').click();

    $('#btn-export').addEventListener('click', doExport);
    $('#btn-import').addEventListener('click', doImport);
    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        this.sm.importJson(await file.text());
        toast('הקובץ נטען');
      } catch (err) { alert('כשל בטעינה: ' + err.message); }
      e.target.value = '';
    });
  }
}

// ---- helpers ----

function formatDateHe(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'fixed bottom-8 left-1/2 -translate-x-1/2 bg-background/90 border border-white/10 backdrop-blur-xl px-6 py-3 rounded-2xl text-white text-sm z-50 shadow-2xl';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

// Persistent toast that stays visible until finish() is called - useful for
// long-running ops like quote refresh where the user (especially on mobile)
// needs to see live progress and the final outcome.
function stickyToast(msg) {
  const t = document.createElement('div');
  t.className = 'fixed bottom-8 left-1/2 -translate-x-1/2 bg-background/90 border border-white/10 backdrop-blur-xl px-6 py-3 rounded-2xl text-white text-sm z-50 shadow-2xl max-w-[90vw] text-center';
  t.textContent = msg;
  document.body.appendChild(t);
  return {
    update(next) { t.textContent = next; },
    finish(next, holdMs = 4000) {
      t.textContent = next;
      setTimeout(() => t.remove(), holdMs);
    },
  };
}

function pillHtml({ tone, text }) {
  // tone: 'secondary' (emerald), 'primary' (violet), 'red'
  let bg, border, dot, textColor, shadow;
  if (tone === 'primary') {
    bg = 'bg-primary/10'; border = 'border-primary/30'; dot = 'bg-primary'; textColor = 'text-primary';
    shadow = '0 0 15px rgba(206,189,255,0.18)';
  } else if (tone === 'red') {
    bg = 'bg-red-400/10'; border = 'border-red-400/30'; dot = 'bg-red-400'; textColor = 'text-red-400';
    shadow = '0 0 15px rgba(248,113,113,0.18)';
  } else {
    bg = 'bg-secondary/10'; border = 'border-secondary/30'; dot = 'bg-secondary'; textColor = 'text-secondary';
    shadow = '0 0 15px rgba(69,223,164,0.15)';
  }
  return `<div class="flex items-center gap-2 px-4 py-2 rounded-full ${bg} border ${border}" style="box-shadow:${shadow};">
    <span class="w-1.5 h-1.5 rounded-full ${dot} animate-pulse"></span>
    <span class="${textColor} font-medium text-sm font-data-tabular tracking-wide">${escapeHtml(text)}</span>
  </div>`;
}

function kidCardHtml(kid, index = 0) {
  // glowBright = visible focal color at the corner; glowSoft = mid-falloff
  // shade so the radial-gradient feels diffuse like the old blurred orb
  // instead of a hard color edge.
  const palette = [
    { glowBright: 'rgba(206, 189, 255, 0.85)', glowSoft: 'rgba(206, 189, 255, 0.32)', accent: 'text-primary', bar: '#cebdff' },
    { glowBright: 'rgba(69, 223, 164, 0.80)',  glowSoft: 'rgba(69, 223, 164, 0.28)',  accent: 'text-secondary', bar: '#45dfa4' },
    { glowBright: 'rgba(249, 189, 34, 0.80)',  glowSoft: 'rgba(249, 189, 34, 0.28)',  accent: 'text-tertiary', bar: '#f9bd22' },
  ];
  const c = palette[index % palette.length];

  const rawPct = (typeof kid.profitPct === 'number' ? kid.profitPct : 0);
  const barPct = Math.max(8, Math.min(95, 40 + rawPct * 2));
  const profitPrefix = kid.profitSign === 'pos' ? '+' : '';
  const profitText = `${profitPrefix}${kid.profitFmt} (${profitPrefix}${rawPct.toFixed(1)}%)`;
  const profitTone = kid.profitSign === 'pos' ? 'secondary' : 'red';

  const xirrTone =
    kid.xirrSign === 'pos' ? 'primary'
    : kid.xirrSign === 'neg' ? 'red'
    : 'primary';
  const hasXirr = kid.xirrSign !== 'na';

  return `
    <div class="kid-card group flex flex-col gap-stack-md" data-kid-id="${escapeHtml(kid.id)}">
      <div class="kid-glow" style="background: radial-gradient(circle at 15% 0%, ${c.glowBright} 0%, ${c.glowSoft} 22%, transparent 55%);"></div>

      <div class="flex justify-between items-start z-10 relative">
        <div class="flex items-center gap-stack-sm">
          <div class="w-12 h-12 rounded-full bg-surface-container overflow-hidden border border-white/10 flex items-center justify-center">
            <span class="material-symbols-outlined ${c.accent}" style="font-size:22px;">person</span>
          </div>
          <h3 class="font-headline-md text-headline-md text-white">${escapeHtml(kid.name)}</h3>
        </div>
        <span class="material-symbols-outlined ${c.accent} group-hover:-translate-x-1 transition-transform rtl:rotate-180" style="font-size:20px;">arrow_forward</span>
      </div>

      <div class="flex flex-col items-center text-center gap-2 z-10 relative">
        <p class="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-[0.2em] font-bold">יתרה</p>
        <h4 class="font-display-lg text-3xl text-white tracking-tight font-bold tabular-nums drop-shadow-[0_2px_10px_rgba(255,255,255,0.15)]">${escapeHtml(kid.portfolioValueFmt)}</h4>
        <div class="flex flex-wrap items-center justify-center gap-2 mt-1">
          ${pillHtml({ tone: profitTone, text: profitText })}
          ${hasXirr ? pillHtml({ tone: xirrTone, text: `שנתית ${kid.xirrFmt}` }) : ''}
        </div>
      </div>

      <div class="kid-progress-track z-10 relative">
        <div class="kid-progress-fill" style="width:${barPct}%; background:${c.bar};"></div>
      </div>

      <div class="flex justify-between items-center z-10 relative">
        <span class="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider">מזומן</span>
        <span class="font-body-md text-body-md text-white font-data-tabular">${escapeHtml(kid.cashFmt)}</span>
      </div>
    </div>
  `;
}
