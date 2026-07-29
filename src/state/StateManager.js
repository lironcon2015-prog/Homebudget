// src/state/StateManager.js
// Owns persisted state, applies ledger mutations, emits change events.

import { EventBus } from '../util/EventBus.js';
import { createIdGen, kidId as makeKidId } from '../util/IdGen.js';
import { deriveState, TX } from '../ledger/LedgerEngine.js';

function defaultState() {
  const k1 = makeKidId('Kid 1');
  const k2 = makeKidId('Kid 2');
  const today = new Date().toISOString().slice(0, 10);
  return {
    schemaVersion: 1,
    settings: {
      baseCurrency: 'ILS',
      locale: 'he-IL',
      lastFxRate: 3.7,
      lastFxRateAsOf: today,
    },
    kids: {
      [k1]: { id: k1, name: 'ילד/ה 1', createdAt: today },
      [k2]: { id: k2, name: 'ילד/ה 2', createdAt: today },
    },
    quotes: {},
    gemelFunds: [],
    ledger: [],
  };
}

function gemelId() {
  return 'gemel_' + Math.random().toString(36).slice(2, 8);
}

export class StateManager {
  constructor(persistence) {
    this.persistence = persistence;
    this.bus = new EventBus();
    const loaded = persistence.load();
    this.state = loaded || defaultState();
    // Portfolios saved before gemel support have no such key.
    if (!Array.isArray(this.state.gemelFunds)) this.state.gemelFunds = [];
    if (!loaded) persistence.save(this.state);
    this._idGen = createIdGen(this.state.ledger);
    this._derived = null;
  }

  on(event, fn) { return this.bus.on(event, fn); }

  _commit() {
    this._derived = null;
    this.persistence.save(this.state);
    this.bus.emit('state:changed', { state: this.state, derived: this.getDerived() });
  }

  getState() { return this.state; }

  getDerived(today = new Date()) {
    if (this._derived) return this._derived;
    this._derived = deriveState(this.state, today);
    return this._derived;
  }

  // ---- Settings & kids ------------------------------------------------

  setFxRate(rate, asOf) {
    this.state.settings.lastFxRate = Number(rate);
    this.state.settings.lastFxRateAsOf = asOf || new Date().toISOString().slice(0, 10);
    this._commit();
  }

  addKid(name) {
    const id = makeKidId(name);
    this.state.kids[id] = {
      id, name,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    this._commit();
    return id;
  }

  renameKid(kidId, name) {
    if (!this.state.kids[kidId]) throw new Error('Unknown kid');
    this.state.kids[kidId].name = name;
    this._commit();
  }

  // dataUrl null clears the photo. Stored on the kid record rather than in a
  // side channel, so it travels with export/import like everything else.
  setKidAvatar(kidId, dataUrl) {
    if (!this.state.kids[kidId]) throw new Error('Unknown kid');
    if (dataUrl) this.state.kids[kidId].avatar = dataUrl;
    else delete this.state.kids[kidId].avatar;
    this._commit();
  }

  removeKid(kidId) {
    const used = this.state.ledger.some((tx) =>
      tx.kidId === kidId || (tx.allocation && kidId in tx.allocation)
    );
    if (used) throw new Error('לא ניתן למחוק ילד/ה עם היסטוריית פעולות');
    const inGemel = (this.state.gemelFunds || []).some((f) =>
      (f.allocationHistory || []).some((e) => kidId in (e.allocation || {}))
    );
    if (inGemel) throw new Error('לא ניתן למחוק ילד/ה המשויך/ת לקופת גמל');
    delete this.state.kids[kidId];
    this._commit();
  }

  // ---- Quotes ---------------------------------------------------------

  upsertQuote({ ticker, company, price, priceUsd, currency = 'USD', asOf, source = 'manual' }) {
    if (!ticker) throw new Error('Quote needs a ticker');
    const resolvedPrice = price ?? priceUsd;        // backward compat
    const existingCurrency = this.state.quotes[ticker]?.currency;
    this.state.quotes[ticker] = {
      ticker,
      company: company || this.state.quotes[ticker]?.company || ticker,
      price: Number(resolvedPrice),
      currency: currency || existingCurrency || 'USD',
      asOf: asOf || new Date().toISOString().slice(0, 10),
      source,
    };
    this._commit();
  }

  removeQuote(ticker) {
    if (this.state.quotes[ticker]) {
      delete this.state.quotes[ticker];
      this._commit();
    }
  }

  // ---- Gemel funds ----------------------------------------------------
  // Deposits are a standing order rather than ledger rows: one entry describes
  // dozens of identical monthly transfers, and the exceptions list covers the
  // months that deviate. Everything else is derived in GemelEngine.

  _fund(id) {
    const f = (this.state.gemelFunds || []).find((x) => x.id === id);
    if (!f) throw new Error('Unknown gemel fund');
    return f;
  }

  addGemelFund({ name, fundNumber = '', manager = '', monthlyAmount, firstDepositDate, allocation, annualFeePct = null, anchor = null }) {
    if (!name) throw new Error('לקופה נדרש שם');
    if (!(Number(monthlyAmount) > 0)) throw new Error('סכום ההפקדה חייב להיות גדול מאפס');
    if (!firstDepositDate) throw new Error('נדרש תאריך הפקדה ראשונה');
    const id = gemelId();
    this.state.gemelFunds.push({
      id,
      name,
      fundNumber,
      manager,
      monthlyAmount: Number(monthlyAmount),
      firstDepositDate: String(firstDepositDate).slice(0, 10),
      annualFeePct: annualFeePct == null ? null : Number(annualFeePct),
      allocationHistory: [{ from: String(firstDepositDate).slice(0, 10), allocation: { ...allocation } }],
      overrides: [],
      anchor: anchor ? { balance: Number(anchor.balance), asOf: String(anchor.asOf).slice(0, 10) } : null,
      createdAt: new Date().toISOString().slice(0, 10),
    });
    this._commit();
    return id;
  }

  updateGemelFund(id, patch) {
    const f = this._fund(id);
    for (const key of ['name', 'fundNumber', 'manager']) {
      if (key in patch) f[key] = patch[key];
    }
    if ('monthlyAmount' in patch) f.monthlyAmount = Number(patch.monthlyAmount);
    if ('firstDepositDate' in patch) f.firstDepositDate = String(patch.firstDepositDate).slice(0, 10);
    if ('annualFeePct' in patch) f.annualFeePct = patch.annualFeePct == null ? null : Number(patch.annualFeePct);
    this._commit();
  }

  removeGemelFund(id) {
    this.state.gemelFunds = (this.state.gemelFunds || []).filter((f) => f.id !== id);
    this._commit();
  }

  // asOf is the statement date the balance is true for — the derivation trusts
  // it up to that day and only adds face-value deposits after it.
  setGemelAnchor(id, { balance, asOf }) {
    const f = this._fund(id);
    if (balance == null || asOf == null) f.anchor = null;
    else f.anchor = { balance: Number(balance), asOf: String(asOf).slice(0, 10) };
    this._commit();
  }

  /**
   * Set the split effective from `from` (default today). Past deposits keep the
   * allocation that was in force when they were made — applying a new split
   * retroactively would rewrite who owns previously earned gains.
   */
  setGemelAllocation(id, allocation, from = null) {
    const f = this._fund(id);
    const sum = Object.values(allocation).reduce((a, b) => a + Number(b), 0);
    if (Math.abs(sum - 100) > 1e-3) throw new Error(`הפיצול חייב להסתכם ב-100% (התקבל ${sum})`);
    for (const kidId in allocation) {
      if (!this.state.kids[kidId]) throw new Error(`ילד/ה לא מוכר/ת: ${kidId}`);
    }
    const key = String(from || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const hist = f.allocationHistory || (f.allocationHistory = []);
    const existing = hist.find((e) => e.from === key);
    if (existing) existing.allocation = { ...allocation };
    else hist.push({ from: key, allocation: { ...allocation } });
    hist.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    this._commit();
  }

  removeGemelAllocation(id, from) {
    const f = this._fund(id);
    const hist = f.allocationHistory || [];
    if (hist.length <= 1) throw new Error('חייב להישאר פיצול אחד לפחות');
    f.allocationHistory = hist.filter((e) => e.from !== from);
    this._commit();
  }

  // amount 0 marks a month the standing order did not go through.
  setGemelOverride(id, { date, amount, note = '' }) {
    const f = this._fund(id);
    const key = String(date).slice(0, 10);
    const list = f.overrides || (f.overrides = []);
    const existing = list.find((o) => o.date === key);
    if (existing) { existing.amount = Number(amount); existing.note = note; }
    else list.push({ date: key, amount: Number(amount), note });
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    this._commit();
  }

  removeGemelOverride(id, date) {
    const f = this._fund(id);
    f.overrides = (f.overrides || []).filter((o) => o.date !== date);
    this._commit();
  }

  // ---- Ledger ---------------------------------------------------------

  _appendTx(tx) {
    tx.id = this._idGen.next();
    tx.createdAt = new Date().toISOString();
    // Validate by deriving a tentative state. Throws on bad tx.
    const tentative = { ...this.state, ledger: [...this.state.ledger, tx] };
    deriveState(tentative);
    this.state.ledger.push(tx);
    this._commit();
    return tx.id;
  }

  recordDeposit({ date, kidId, amountIls, note = '' }) {
    return this._appendTx({
      type: TX.DEPOSIT, date, kidId,
      amountIls: Number(amountIls), note,
    });
  }

  recordBuy({ date, ticker, company, totalShares, kidsShares, allocation, price, priceUsd, currency = 'USD', fxRate, feesIls = 0, externalFunds = true }) {
    const resolvedPrice = price ?? priceUsd;        // backward compat
    // Auto-seed quote for new ticker so portfolio valuation works immediately
    if (ticker && !this.state.quotes[ticker]) {
      this.state.quotes[ticker] = {
        ticker,
        company: company || ticker,
        price: Number(resolvedPrice),
        currency,
        asOf: date,
        source: 'manual',
      };
    } else if (ticker && company && this.state.quotes[ticker] && !this.state.quotes[ticker].company) {
      this.state.quotes[ticker].company = company;
    }
    return this._appendTx({
      type: TX.BUY,
      date, ticker, company,
      totalShares: Number(totalShares),
      kidsShares: Number(kidsShares),
      allocation: Object.fromEntries(
        Object.entries(allocation).map(([k, v]) => [k, Number(v)])
      ),
      price: Number(resolvedPrice),
      currency,
      fxRate: Number(fxRate),
      feesIls: Number(feesIls) || 0,
      externalFunds: Boolean(externalFunds),
    });
  }

  recordSell({ date, ticker, sharesSold, netIls }) {
    return this._appendTx({
      type: TX.SELL, date, ticker,
      sharesSold: Number(sharesSold),
      netIls: Number(netIls),
    });
  }

  recordDividend({ date, ticker, netIlsTotal }) {
    return this._appendTx({
      type: TX.DIVIDEND, date, ticker,
      netIlsTotal: Number(netIlsTotal),
    });
  }

  removeTx(txId) {
    this.state.ledger = this.state.ledger.filter((t) => t.id !== txId);
    this._commit();
  }

  patchTx(txId, fields) {
    const idx = this.state.ledger.findIndex((t) => t.id === txId);
    if (idx === -1) throw new Error(`Transaction ${txId} not found`);
    const updated = { ...this.state.ledger[idx], ...fields };
    const tentative = {
      ...this.state,
      ledger: this.state.ledger.map((t) => t.id === txId ? updated : t),
    };
    deriveState(tentative); // throws on invalid data
    this.state.ledger[idx] = updated;
    this._commit();
  }

  // ---- Import / Export ------------------------------------------------

  exportJson() { return JSON.stringify(this.state, null, 2); }

  importJson(json) {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    if (!parsed || parsed.schemaVersion !== 1) throw new Error('Bad schema');
    deriveState(parsed); // validate
    if (!Array.isArray(parsed.gemelFunds)) parsed.gemelFunds = [];
    this.state = parsed;
    this._idGen = createIdGen(this.state.ledger);
    this._commit();
  }
}
