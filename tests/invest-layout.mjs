// Layout regression test for the embedded portfolio (/invest/).
// Requires playwright-core + a chromium binary, and a local server:
//   python3 -m http.server 8000 && node tests/invest-layout.mjs
//
// WHY THIS EXISTS, and why it goes to the trouble of loading Tailwind:
//
// The portfolio's wide-desktop layout shipped broken. Its custom rules
// (.app-shell, .wide-grid) compete with Tailwind utilities on the same
// elements — max-w-lg, space-y-4, grid — and the Tailwind CDN compiles and
// injects its <style> at RUNTIME, which places it after the page's own inline
// block. At equal specificity the later rule wins, so the shell stayed at
// 32rem and nothing appeared in the console to say so.
//
// It passed review because the sandbox blocks the CDN: with no Tailwind loaded
// there was nothing to lose the cascade to, and the rules applied unopposed.
// A test that cannot see the competing stylesheet cannot see this class of bug,
// so this one injects the locally built CSS exactly as the CDN does.
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'

const require = createRequire(process.env.PW_REQUIRE_FROM || import.meta.url)
const { chromium } = require('playwright-core')

const BASE = process.env.SMOKE_URL || 'http://localhost:8000'
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const TW_PATH = new URL('../invest/tools/.tailwind.css', import.meta.url).pathname

if (!existsSync(TW_PATH)) {
  console.error(`missing ${TW_PATH} — run "npm ci && node tools/build-offline.js" in invest/ first`)
  process.exit(2)
}
const TW = readFileSync(TW_PATH, 'utf8')

const failures = []
function check(name, cond, detail = '') {
  const ok = !!cond
  console.log(`${ok ? 'ok' : 'NOT OK'} - ${name}${ok || !detail ? '' : ' — ' + detail}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch({ executablePath: CHROME })

async function context(opts) {
  const ctx = await browser.newContext(opts)
  await ctx.addInitScript((css) => {
    // Same insertion point and timing the CDN uses: appended to <head> once the
    // document is parsed, i.e. after the page's own <style>.
    const add = () => {
      const el = document.createElement('style')
      el.textContent = css
      document.head.appendChild(el)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add)
    else add()
  }, TW)
  return ctx
}

// Three kids: the count that actually pins the grid down. Two would sit side
// by side even in a two-column layout, so it cannot tell the two apart.
const SEED = {
  schemaVersion: 1,
  settings: { baseCurrency: 'ILS', locale: 'he-IL', lastFxRate: 3.7, lastFxRateAsOf: '2026-08-01' },
  kids: {
    k_a: { id: 'k_a', name: 'ילד/ה 1', createdAt: '2026-01-01' },
    k_b: { id: 'k_b', name: 'ילד/ה 2', createdAt: '2026-01-01' },
    k_c: { id: 'k_c', name: 'ילד/ה 3', createdAt: '2026-01-01' },
  },
  quotes: {}, gemelFunds: [], ledger: [],
}

async function measure(label, opts) {
  const ctx = await context(opts)
  // Seeded before any document script runs. Seeding after a load would race the
  // app's own ?v= redirect and tear the execution context out mid-evaluate.
  await ctx.addInitScript((s) => {
    try { localStorage.setItem('juniorinvest:v1', JSON.stringify(s)) } catch { /* first paint on about:blank */ }
  }, SEED)
  const page = await ctx.newPage()
  await page.goto(BASE + '/invest/', { waitUntil: 'networkidle' })
  await page.waitForSelector('.app-shell', { timeout: 15000 })
  await page.waitForTimeout(600)

  const m = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell')
    const grid = document.querySelector('.wide-grid')
    const kids = grid ? [...grid.children] : []
    const btn = document.querySelector('#btn-refresh-quotes')
    const hero = document.querySelector('.summary-hero')
    const stats = document.querySelector('.summary-stats')
    return {
      tailwindPresent: !![...document.styleSheets].some((s) => {
        try { return [...s.cssRules].some((r) => r.selectorText === '.max-w-lg') } catch { return false }
      }),
      shellWidth: Math.round(shell.getBoundingClientRect().width),
      gridDisplay: grid ? getComputedStyle(grid).display : null,
      rows: kids.length ? new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top))).size : null,
      cards: kids.length,
      secondMarginTop: kids[1] ? getComputedStyle(kids[1]).marginTop : null,
      refreshVisible: btn ? !!btn.offsetParent : false,
      // Same row means the band laid out horizontally; stacked means it did not.
      summaryBandHorizontal: hero && stats
        ? Math.abs(hero.getBoundingClientRect().top - stats.getBoundingClientRect().top) < 60
        : null,
      fxHasStackRule: document.querySelector('.summary-fx')
        ? getComputedStyle(document.querySelector('.summary-fx')).borderTopWidth !== '0px'
        : null,
    }
  })
  await ctx.close()
  console.log(`  ${label}: ${JSON.stringify(m)}`)
  return m
}

// A run where Tailwind failed to load proves nothing — it is the exact blind
// spot that let the bug ship, so treat it as a hard failure rather than a pass.
const desktop = await measure('desktop 1400', { viewport: { width: 1400, height: 900 } })
check('tailwind actually loaded (otherwise this test is blind)', desktop.tailwindPresent)
check('shell widens past the phone column on desktop', desktop.shellWidth > 900, `${desktop.shellWidth}px`)
check('cards become a grid', desktop.gridDisplay === 'grid', String(desktop.gridDisplay))
check('three cards share one row', desktop.cards === 3 && desktop.rows === 1, `${desktop.cards} cards, ${desktop.rows} rows`)
check('summary lays out as a band, not a stack', desktop.summaryBandHorizontal)
check('summary drops its stacked divider', desktop.fxHasStackRule === false)
check('space-y margin does not survive inside the grid', desktop.secondMarginTop === '0px', String(desktop.secondMarginTop))
check('refresh button is offered on a pointer device', desktop.refreshVisible)

// The width that actually matters: what the budget app's shell gives the frame.
const framed = await measure('host frame 1058', { viewport: { width: 1058, height: 900 } })
check('shell widens at the embedded frame width', framed.shellWidth > 900, `${framed.shellWidth}px`)
check('three cards share one row in the frame too', framed.cards === 3 && framed.rows === 1, `${framed.rows} rows`)

const phone = await measure('phone 390 touch', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
check('phone keeps the single column', phone.shellWidth <= 520, `${phone.shellWidth}px`)
check('phone keeps stacked cards', phone.gridDisplay === 'block', String(phone.gridDisplay))
check('phone keeps the summary stacked', phone.summaryBandHorizontal === false)
check('phone keeps the summary divider', phone.fxHasStackRule === true)
check('refresh button stays out of the way on touch', !phone.refreshVisible)

await browser.close()
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed')
process.exit(failures.length ? 1 : 0)
