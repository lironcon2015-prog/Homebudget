// Shared vm harness for unit tests: loads the app's classic scripts into a
// sandboxed context with browser stubs, so pure functions can be exercised
// under node:test without a browser. Storage is a real in-memory Map, so
// DB.get/DB.set behave like the app (JSON round-trip included).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function makeLocalStorageStub() {
  const store = new Map()
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    _store: store,
  }
}

// Load one or more of the app's script files into a fresh vm context.
// `extraGlobals` lets a test pre-seed stubs (e.g. getAccounts) before load.
export function loadApp(files, extraGlobals = {}) {
  const ctx = {
    console, Date, JSON, Math, Number, String, Array, Object, Set, Map, RegExp,
    parseInt, parseFloat, isNaN, isFinite, WeakSet, Intl, structuredClone,
    localStorage: makeLocalStorageStub(),
    document: { addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] },
    window: {},
    navigator: {},
    ...extraGlobals,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  for (const f of files) {
    vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f })
  }
  // Top-level `const`/`let` in a script live in the context's lexical scope,
  // not on the global object, so they aren't reachable as ctx properties.
  // `_eval` reaches them.
  ctx._eval = src => vm.runInContext(src, ctx)
  return ctx
}

// Generic in-memory DB stub: any key round-trips, like the real DB layer.
export function makeDbStub(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    get: (key, def) => (store.has(key) ? store.get(key) : def),
    set: (key, val) => { store.set(key, val); return true },
    getObj: (key, def = {}) => (store.has(key) ? store.get(key) : def),
    _store: store,
  }
}

// Cross-realm-safe deep equality: values built inside the vm context carry
// foreign prototypes, which assert.deepStrictEqual rejects. JSON-normalize.
export function deepEq(actual, expected, msg) {
  const norm = v => JSON.parse(JSON.stringify(v))
  const a = JSON.stringify(norm(actual)), e = JSON.stringify(norm(expected))
  if (a !== e) throw new Error(`${msg || 'deepEq failed'}\nactual:   ${a}\nexpected: ${e}`)
}

// Convenience: core.js needs DB + getters; app.js provides DB but also pulls
// a lot of DOM. Instead, give core.js a minimal DB + data accessors backed by
// plain arrays the test controls.
export function loadCore({ accounts = [], categories = [], transactions = [], aliases = [] } = {}) {
  const state = { accounts, categories, transactions }
  const db = makeDbStub({ finVendorAliases: aliases })
  const ctx = loadApp(['core.js'], {
    DB: {
      get: (key, def) => {
        if (key === 'finTransactions') return state.transactions
        return db.get(key, def)
      },
      set: (key, val) => {
        if (key === 'finTransactions') { state.transactions = val; return true }
        return db.set(key, val)
      },
      getObj: db.getObj,
    },
    getAccounts: () => state.accounts,
    getCategories: () => state.categories,
    getTransactions: () => state.transactions,
    genId: () => 'id' + Math.random().toString(36).slice(2),
    CC_KEYWORDS: ['ויזה', 'visa', 'ישראכרט', 'isracard', 'מקס', 'max', 'כאל', 'cal'],
    formatDate: s => s,
  })
  ctx._state = state
  return ctx
}
