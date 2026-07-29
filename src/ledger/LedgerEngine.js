// src/ledger/LedgerEngine.js
// Pure reducer: (state) -> derived snapshot. No DOM, no I/O.
// Always re-runs from scratch, so editing/removing past tx is safe.

import { EPS, sumValues, proratePreservingTotal, round8 } from '../util/MathUtils.js';
import { consumeFifo } from './FifoEngine.js';
import { distributeDividend } from './DividendEngine.js';
import { deriveGemel } from './GemelEngine.js';
import { xirr } from '../math/Xirr.js';

export const TX = Object.freeze({
  DEPOSIT:  'DEPOSIT',
  BUY:      'BUY',
  SELL:     'SELL',
  DIVIDEND: 'DIVIDEND',
});

function dateKey(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// Returns null when the rate is genuinely unknown — too few flows, no sign
// change, or no convergence. Collapsing those to 0 would print a confident
// "0.0%" that cannot be told apart from a flat portfolio.
function safeXirr(flows) {
  if (flows.length < 2) return null;
  const first = dateKey(flows[0].date);
  if (flows.every((f) => dateKey(f.date) === first)) return null;
  return xirr(flows).value ?? null;
}

function emptyDerived(kids) {
  const cashByKid = {};
  const sharesByKidByTicker = {};
  for (const kidId in kids) {
    cashByKid[kidId] = 0;
    sharesByKidByTicker[kidId] = {};
  }
  return {
    cashByKid,
    sharesByKidByTicker,
    parentSharesByTicker: {},
    lots: [],
    gemel: null,
    portfolioValueByKid: {},
    principalByKid: {},
    profitByKid: {},
    totalKidsPrincipal: 0,
    totalKidsValue: 0,
    xirrByKid: {},
    xirrSecuritiesByKid: {},
    xirrGemelByKid: {},
    totalKidsXirr: null,
    warnings: [],
  };
}

function bumpShares(map, kidId, ticker, delta) {
  if (!map[kidId]) map[kidId] = {};
  map[kidId][ticker] = (map[kidId][ticker] || 0) + delta;
  if (Math.abs(map[kidId][ticker]) < EPS) delete map[kidId][ticker];
}

function bumpParent(map, ticker, delta) {
  map[ticker] = (map[ticker] || 0) + delta;
  if (Math.abs(map[ticker]) < EPS) delete map[ticker];
}

// ---- Per-tx handlers --------------------------------------------------

function applyDeposit(d, tx) {
  if (!(tx.kidId in d.cashByKid)) throw new Error(`DEPOSIT: unknown kidId "${tx.kidId}"`);
  if (!(tx.amountIls > 0)) throw new Error('DEPOSIT: amount must be > 0');
  d.cashByKid[tx.kidId] += tx.amountIls;
  d.principalByKid[tx.kidId] = (d.principalByKid[tx.kidId] || 0) + tx.amountIls;
  d.totalKidsPrincipal += tx.amountIls;
}

function applyBuy(d, tx) {
  const { totalShares, kidsShares, allocation, fxRate, feesIls = 0 } = tx;
  const price = tx.price ?? tx.priceUsd;           // backward compat
  const currency = tx.currency ?? 'USD';
  if (!(totalShares >= kidsShares && kidsShares >= 0)) {
    throw new Error('BUY: need totalShares >= kidsShares >= 0');
  }
  if (!(price > 0) || !(fxRate > 0)) throw new Error('BUY: price and fxRate must be > 0');
  const allocSum = sumValues(allocation);
  if (Math.abs(allocSum - 100) > 1e-3) throw new Error(`BUY: allocation must sum to 100 (got ${allocSum})`);
  for (const kidId in allocation) {
    if (!(kidId in d.cashByKid)) throw new Error(`BUY: unknown kidId "${kidId}"`);
  }

  const parentShares = round8(totalShares - kidsShares);
  const perKidShares = proratePreservingTotal(kidsShares, allocation, 8);

  for (const kidId in perKidShares) {
    const shares = perKidShares[kidId];
    if (!tx.externalFunds) {
      // Deduct from cash only when using internally accumulated cash (from sells/dividends)
      const costIls = shares * price * fxRate;
      const feeShare = kidsShares > 0 ? feesIls * (shares / kidsShares) : 0;
      d.cashByKid[kidId] -= costIls + feeShare;
      if (d.cashByKid[kidId] < 0) {
        d.warnings.push({
          txId: tx.id,
          kidId,
          message: `Cash went negative for ${kidId} after BUY ${tx.ticker}`,
        });
      }
    } else {
      // External funds: track cost as invested principal
      const costIls = shares * price * fxRate;
      const feeShare = kidsShares > 0 ? feesIls * (shares / kidsShares) : 0;
      const cost = costIls + feeShare;
      d.principalByKid[kidId] = (d.principalByKid[kidId] || 0) + cost;
      d.totalKidsPrincipal += cost;
    }
    bumpShares(d.sharesByKidByTicker, kidId, tx.ticker, shares);
  }
  bumpParent(d.parentSharesByTicker, tx.ticker, parentShares);

  d.lots.push({
    lotId: tx.id,
    ticker: tx.ticker,
    company: tx.company,
    openDate: tx.date,
    price,
    currency,
    fxAtBuy: fxRate,
    remaining: { kids: { ...perKidShares }, parent: parentShares },
    original:  { kids: { ...perKidShares }, parent: parentShares },
  });
}

function applySell(d, tx) {
  const { ticker, sharesSold, netIls } = tx;
  if (!(sharesSold > 0)) throw new Error('SELL: sharesSold must be > 0');
  if (!(netIls >= 0)) throw new Error('SELL: netIls must be >= 0');

  const { consumedByKid } = consumeFifo(d.lots, ticker, sharesSold);

  for (const kidId in consumedByKid) {
    bumpShares(d.sharesByKidByTicker, kidId, ticker, -consumedByKid[kidId]);
  }

  const ilsPerKid = proratePreservingTotal(netIls, consumedByKid, 2);
  for (const kidId in ilsPerKid) {
    d.cashByKid[kidId] += ilsPerKid[kidId];
  }
}

function applyDividend(d, tx) {
  const { ticker, netIlsTotal } = tx;
  if (!(netIlsTotal >= 0)) throw new Error('DIVIDEND: netIlsTotal must be >= 0');
  const { ilsPerKid } = distributeDividend(d.lots, ticker, netIlsTotal);
  for (const kidId in ilsPerKid) {
    d.cashByKid[kidId] += ilsPerKid[kidId];
  }
}

const HANDLERS = {
  [TX.DEPOSIT]:  applyDeposit,
  [TX.BUY]:      applyBuy,
  [TX.SELL]:     applySell,
  [TX.DIVIDEND]: applyDividend,
};

// ---- Public reducer ---------------------------------------------------

export function deriveState(state, today = new Date()) {
  const d = emptyDerived(state.kids || {});

  const sorted = [...(state.ledger || [])].sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    const ac = a.createdAt || '', bc = b.createdAt || '';
    if (ac < bc) return -1;
    if (ac > bc) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (const tx of sorted) {
    const h = HANDLERS[tx.type];
    if (!h) throw new Error(`Unknown tx type: ${tx.type}`);
    h(d, tx);
  }

  // Gemel funds contribute principal and value but never pass through the
  // ledger: their deposits are derived from a standing order, so they are
  // folded in here rather than by a tx handler.
  const gemel = deriveGemel(state, dateKey(today));
  d.gemel = gemel;
  d.warnings.push(...gemel.warnings);
  for (const kidId in state.kids || {}) {
    const dep = gemel.depositedByKid[kidId] || 0;
    if (dep === 0) continue;
    d.principalByKid[kidId] = (d.principalByKid[kidId] || 0) + dep;
    d.totalKidsPrincipal += dep;
  }

  // Live portfolio value (cash + market) per kid in ILS
  const fxRate = state.settings?.lastFxRate ?? 1;
  const quotes = state.quotes || {};
  let total = 0;
  for (const kidId in state.kids || {}) {
    let pv = d.cashByKid[kidId] || 0;
    const tickers = d.sharesByKidByTicker[kidId] || {};
    for (const ticker in tickers) {
      const q = quotes[ticker];
      const qPrice = q?.price ?? q?.priceUsd;       // backward compat
      const qCurrency = q?.currency ?? 'USD';
      if (q && typeof qPrice === 'number') {
        const rate = qCurrency === 'ILS-Agorot' ? 0.01 : fxRate;
        pv += tickers[ticker] * qPrice * rate;
      }
    }
    pv += gemel.balanceByKid[kidId] || 0;
    d.portfolioValueByKid[kidId] = pv;

    // Profit breakdown per kid
    const principal = d.principalByKid[kidId] || 0;
    // Gemel gain is a paper gain — nothing is sold — so it belongs to the
    // unrealized bucket; leaving it out would push it into `realized` below.
    let unrealizedProfit = gemel.gainByKid[kidId] || 0;
    for (const lot of d.lots) {
      const kidShares = lot.remaining.kids[kidId] || 0;
      if (kidShares <= 0) continue;
      const q = quotes[lot.ticker];
      const qPrice = q?.price ?? q?.priceUsd;
      const qCurrency = q?.currency ?? 'USD';
      if (q && typeof qPrice === 'number') {
        const currentRate = qCurrency === 'ILS-Agorot' ? 0.01 : fxRate;
        const buyRate = lot.currency === 'ILS-Agorot' ? 0.01 : lot.fxAtBuy;
        unrealizedProfit += kidShares * (qPrice * currentRate - lot.price * buyRate);
      }
    }
    const totalProfit = pv - principal;
    d.profitByKid[kidId] = {
      total: totalProfit,
      pct: principal > 0 ? (totalProfit / principal) * 100 : 0,
      unrealized: unrealizedProfit,
      realized: totalProfit - unrealizedProfit,
    };

    total += pv;
  }
  d.totalKidsValue = total;
  d.totalProfit = d.totalKidsValue - d.totalKidsPrincipal;
  d.totalReturnPct = d.totalKidsPrincipal > 0 ? (d.totalProfit / d.totalKidsPrincipal) * 100 : 0;

  // XIRR per kid: contributions negative at their dates, today's value positive.
  //
  // Three rates are produced from the same flows. The combined one is the union
  // of both sleeves — the correct money-weighted return of everything, and not
  // an average of the two. The split ones exist because that combined number is
  // otherwise impossible to attribute: with a gemel several times the size of
  // the brokerage, it is almost entirely the gemel.
  const totalFlows = [];
  for (const kidId in state.kids || {}) {
    const securityFlows = [];
    for (const tx of sorted) {
      if (tx.type === TX.DEPOSIT && tx.kidId === kidId) {
        securityFlows.push({ date: tx.date, amount: -tx.amountIls });
      } else if (tx.type === TX.BUY && tx.externalFunds === true) {
        const price = tx.price ?? tx.priceUsd;
        const txFxRate = tx.fxRate;
        const feesIls = tx.feesIls || 0;
        const perKidShares = proratePreservingTotal(tx.kidsShares, tx.allocation, 8);
        const shares = perKidShares[kidId] || 0;
        if (shares > 0) {
          const feeShare = tx.kidsShares > 0 ? feesIls * (shares / tx.kidsShares) : 0;
          const cost = shares * price * txFxRate + feeShare;
          securityFlows.push({ date: tx.date, amount: -cost });
        }
      }
    }
    const gemelFlows = (gemel.flowsByKid[kidId] || []).map((f) => ({ ...f }));
    for (const f of [...securityFlows, ...gemelFlows]) totalFlows.push({ ...f });

    const pv = d.portfolioValueByKid[kidId] || 0;
    const gemelValue = gemel.balanceByKid[kidId] || 0;
    // Cash lives in pv and belongs to the securities sleeve, so the split is by
    // subtraction rather than by re-summing the holdings.
    const securityValue = pv - gemelValue;

    const combined = [...securityFlows, ...gemelFlows];
    if (pv > 0) combined.push({ date: today, amount: pv });
    d.xirrByKid[kidId] = safeXirr(combined);

    const secOnly = [...securityFlows];
    if (securityValue > 0) secOnly.push({ date: today, amount: securityValue });
    d.xirrSecuritiesByKid[kidId] = safeXirr(secOnly);

    const gemOnly = [...gemelFlows];
    if (gemelValue > 0) gemOnly.push({ date: today, amount: gemelValue });
    d.xirrGemelByKid[kidId] = safeXirr(gemOnly);
  }
  if (d.totalKidsValue > 0) totalFlows.push({ date: today, amount: d.totalKidsValue });
  d.totalKidsXirr = safeXirr(totalFlows);

  return d;
}
