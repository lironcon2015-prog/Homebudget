// src/state/LocalStoragePersistence.js

const KEY = 'juniorinvest:v1';

export class LocalStoragePersistence {
  constructor(key = KEY) { this.key = key; }

  load() {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('[LocalStoragePersistence] load failed', e);
      return null;
    }
  }

  save(state) {
    try {
      localStorage.setItem(this.key, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('[LocalStoragePersistence] save failed', e);
      return false;
    }
  }

  clear() { localStorage.removeItem(this.key); }
}
