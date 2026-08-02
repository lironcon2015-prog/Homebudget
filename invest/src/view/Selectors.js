// src/view/Selectors.js
// State -> ViewModels. Strips parent data so it cannot leak into the UI.

import { xirr } from '../math/Xirr.js';

const ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 });
const PCT = new Intl.NumberFormat('he-IL', { style: 'percent', maximumFractionDigits: 1 });
const NUM = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });

const CURRENCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', 'ILS-Agorot': '' };
const currencySymbol = (c) => c in CURRENCY_SYMBOL ? CURRENCY_SYMBOL[c] : (c || '$');

export const fmtIls = (n) => (n == null || isNaN(n) ? '—' : ILS.format(n));
export const fmtPct = (n) => (n == null || isNaN(n) ? '—' : PCT.format(n));
export const fmtNum = (n) => (n == null || isNaN(n) ? '—' : NUM.format(n));

const pickKidPublicFields = (kid) => ({ id: kid.id, name: kid.name, avatar: kid.avatar || null });

export function dashboardViewModel(state, derived) {
  const kids = Object.values(state.kids).map((k) => {
    const xirrVal = typeof derived.xirrByKid[k.id] === 'number' ? derived.xirrByKid[k.id] : null;
    const kidProfit = derived.profitByKid?.[k.id];
    const profit = kidProfit?.total ?? 0;
    const profitPct = kidProfit?.pct ?? 0;
    return {
      ...pickKidPublicFields(k),
      cashIls: derived.cashByKid[k.id] || 0,
      portfolioValueIls: derived.portfolioValueByKid[k.id] || 0,
      cashFmt: fmtIls(derived.cashByKid[k.id] || 0),
      portfolioValueFmt: fmtIls(derived.portfolioValueByKid[k.id] || 0),
      xirr: xirrVal,
      xirrFmt: fmtPct(xirrVal),
      xirrSign: xirrVal == null ? 'na' : xirrVal >= 0 ? 'pos' : 'neg',
      profit,
      profitFmt: fmtIls(profit),
      profitPct,
      profitSign: profit >= 0 ? 'pos' : 'neg',
    };
  });

  const totalKidsXirr = typeof derived.totalKidsXirr === 'number' ? derived.totalKidsXirr : null;
  const totalProfit = derived.totalProfit ?? 0;
  const totalReturnPct = derived.totalReturnPct ?? 0;
  return {
    totalKidsValueFmt: fmtIls(derived.totalKidsValue),
    totalKidsValue: derived.totalKidsValue,
    fxRate: state.settings.lastFxRate,
    fxRateAsOf: state.settings.lastFxRateAsOf,
    totalKidsXirr,
    totalKidsXirrFmt: fmtPct(totalKidsXirr),
    totalProfit,
    totalProfitFmt: fmtIls(totalProfit),
    totalReturnPct,
    kids,
  };
}

export function holdingsViewModel(state, derived) {
  // Aggregate by ticker, KID SHARES ONLY. Parent shares are never read here.
  const byTicker = {};
  for (const kidId in derived.sharesByKidByTicker) {
    const m = derived.sharesByKidByTicker[kidId];
    for (const ticker in m) {
      if (!byTicker[ticker]) byTicker[ticker] = { ticker, perKid: {}, totalShares: 0 };
      byTicker[ticker].perKid[kidId] = (byTicker[ticker].perKid[kidId] || 0) + m[ticker];
      byTicker[ticker].totalShares += m[ticker];
    }
  }

  const fxRate = state.settings.lastFxRate;
  const today = new Date();
  const rows = Object.values(byTicker).map((h) => {
    const q = state.quotes[h.ticker];
    const price = q?.price ?? q?.priceUsd ?? null;  // backward compat
    const currency = q?.currency ?? 'USD';
    const rate = currency === 'ILS-Agorot' ? 0.01 : fxRate;
    const valueIls = price != null ? h.totalShares * price * rate : null;

    const tickerLots = (derived.lots || []).filter((lot) => {
      if (lot.ticker !== h.ticker) return false;
      return Object.values(lot.remaining.kids).reduce((a, b) => a + b, 0) > 0;
    });

    const lots = tickerLots.map((lot) => {
      const kidsShares = Object.values(lot.remaining.kids).reduce((a, b) => a + b, 0);
      const lotCurrency = lot.currency;
      const buyRate = lotCurrency === 'ILS-Agorot' ? 0.01 : lot.fxAtBuy;
      const pctChange = price != null ? (price - lot.price) / lot.price : null;
      let xirrLot = null;
      if (price != null && kidsShares > 0) {
        const buyAmt  = -(kidsShares * lot.price * buyRate);
        const sellAmt =   kidsShares * price * rate;
        const lotDk = String(lot.openDate).slice(0, 10);
        const todDk  = today.toISOString().slice(0, 10);
        if (lotDk !== todDk && buyAmt !== 0) {
          const res = xirr([{ date: lot.openDate, amount: buyAmt }, { date: today, amount: sellAmt }]);
          xirrLot = res.value == null ? 0 : res.value;
        } else {
          xirrLot = 0;
        }
      }
      const pctSign  = pctChange == null ? 'na' : pctChange  > 0 ? 'pos' : pctChange  < 0 ? 'neg' : 'na';
      const xirrSign = xirrLot   == null ? 'na' : xirrLot    > 0 ? 'pos' : xirrLot    < 0 ? 'neg' : 'na';
      return {
        lotId:           lot.lotId,
        openDate:        lot.openDate,
        buyPriceFmt:     `${currencySymbol(lotCurrency)}${lot.price.toFixed(2)}`,
        currentPriceFmt: price != null ? `${currencySymbol(currency)}${price.toFixed(2)}` : '—',
        pctChange,
        pctChangeFmt:    fmtPct(pctChange),
        pctSign,
        xirrLot,
        xirrLotFmt:      fmtPct(xirrLot),
        xirrSign,
      };
    });

    return {
      ticker: h.ticker,
      company: q?.company || h.ticker,
      totalShares: h.totalShares,
      totalSharesFmt: fmtNum(h.totalShares),
      price,
      currency,
      priceFmt: price != null ? `${currencySymbol(currency)}${price.toFixed(2)}` : '—',
      asOf: q?.asOf || '—',
      valueIls,
      valueFmt: price != null ? fmtIls(valueIls) : '—',
      perKid: Object.entries(h.perKid).map(([kidId, shares]) => ({
        kidId,
        kidName: state.kids[kidId]?.name || kidId,
        shares,
        sharesFmt: fmtNum(shares),
      })),
      lots,
    };
  });

  rows.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { rows, fxRate };
}

export function ledgerViewModel(state) {
  const rows = [...state.ledger]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt > b.createdAt ? -1 : 1)))
    .map((tx) => {
      const base = { id: tx.id, type: tx.type, date: tx.date };
      switch (tx.type) {
        case 'DEPOSIT':
          return {
            ...base, label: 'הפקדה',
            who: state.kids[tx.kidId]?.name || tx.kidId,
            amountFmt: fmtIls(tx.amountIls),
            sign: 'pos',
            details: tx.note || '',
          };
        case 'BUY': {
          // Show kids' shares only — the account-level total is back-office info.
          const txPrice = tx.price ?? tx.priceUsd;  // backward compat
          const txCurrency = tx.currency ?? 'USD';
          return {
            ...base, label: 'קנייה',
            who: tx.ticker,
            amountFmt: `${fmtNum(tx.kidsShares)} מניות לילדים`,
            sign: 'neg',
            details: `${currencySymbol(txCurrency)}${txPrice} × ש״ח ${tx.fxRate} • ${tx.company || ''}`,
          };
        }
        case 'SELL':
          return {
            ...base, label: 'מכירה',
            who: tx.ticker,
            amountFmt: `${fmtNum(tx.sharesSold)} מניות → ${fmtIls(tx.netIls)}`,
            sign: 'pos',
            details: '',
          };
        case 'DIVIDEND':
          return {
            ...base, label: 'דיבידנד',
            who: tx.ticker,
            amountFmt: fmtIls(tx.netIlsTotal),
            sign: 'pos',
            details: 'נטו לחשבון כולל',
          };
      }
    });
  return { rows };
}

export function tickersViewModel(state, derived) {
  const set = new Set();
  for (const kidId in derived.sharesByKidByTicker) {
    for (const t in derived.sharesByKidByTicker[kidId]) set.add(t);
  }
  for (const t in state.quotes) set.add(t);
  return [...set].sort().map((t) => ({
    ticker: t,
    company: state.quotes[t]?.company || t,
  }));
}
