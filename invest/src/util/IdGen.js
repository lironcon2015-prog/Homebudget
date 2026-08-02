// src/util/IdGen.js
// Monotonic tx ids: tx_0001, tx_0002... seeded from existing ledger.

export function createIdGen(seedLedger = []) {
  let n = 0;
  for (const tx of seedLedger) {
    const m = /^tx_(\d+)$/.exec(tx.id || '');
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return {
    next() {
      n += 1;
      return 'tx_' + String(n).padStart(4, '0');
    },
  };
}

export function kidId(name) {
  const slug = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9֐-׿]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return 'k_' + (slug || 'kid') + '_' + rand;
}
