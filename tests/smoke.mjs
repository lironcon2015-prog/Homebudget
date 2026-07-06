// End-to-end smoke test against a local server (python3 -m http.server 8000).
// Requires playwright-core + a chromium binary:
//   PW_CHROMIUM=/path/to/chrome node tests/smoke.mjs
// CDN is unreachable in the sandbox → Chart.js/XLSX are shimmed; nothing the
// smoke asserts depends on real chart rendering.
import { createRequire } from 'node:module'

const require = createRequire(process.env.PW_REQUIRE_FROM || import.meta.url)
const { chromium } = require('playwright-core')

const BASE = process.env.SMOKE_URL || 'http://localhost:8000'
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const failures = []
function check(name, cond, detail = '') {
  const ok = !!cond
  console.log(`${ok ? 'ok' : 'NOT OK'} - ${name}${ok || !detail ? '' : ' — ' + detail}`)
  if (!ok) failures.push(name)
}

const XSS_VENDOR = `חברה בע"מ <img src=x onerror="window.__xss=1">`

const SEED = {
  accounts: [
    { id: 'acc1', name: 'עו"ש', type: 'checking', openingBalance: 1000, currency: 'ILS', createdAt: 1 },
    { id: 'sav1', name: 'חיסכון', type: 'savings', openingBalance: 0, currency: 'ILS', paymentVendorPatterns: ['הפקדה לחיסכון'], createdAt: 1 },
    { id: 'cc1', name: 'ויזה', type: 'credit_card', billingDay: 10, paymentVendorPatterns: ['ויזה 1234'], createdAt: 1 },
  ],
  transactions: [
    { id: 't1', accountId: 'acc1', date: '2026-06-15', amount: -120, vendor: XSS_VENDOR, description: 'תיאור <b>מוזרק</b>', type: 'expense', categoryId: 'cat_food', notes: 'הערה "עם" גרשיים', createdAt: 1 },
    { id: 't2', accountId: 'acc1', date: '2026-06-20', amount: -500, vendor: 'הפקדה לחיסכון', description: '', type: 'expense', categoryId: 'cat_invest_out', transferAccountId: 'sav1', createdAt: 1 },
    { id: 't3', accountId: 'acc1', date: '2026-07-01', amount: 8000, vendor: 'משכורת', description: '', type: 'income', categoryId: 'cat_salary', createdAt: 1 },
    { id: 't4', accountId: 'cc1', date: '2026-06-05', amount: -75, vendor: 'מסעדה', description: '', type: 'expense', categoryId: 'cat_rest', createdAt: 1 },
    { id: 't5', accountId: 'acc1', date: '2026-06-25', amount: -900, vendor: 'ויזה 1234 תשלום', description: '', type: 'expense', ccPaymentForAccountId: 'cc1', createdAt: 1 },
  ],
}

async function newPage(browser, { mobile = false } = {}) {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    ...(mobile ? { hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' } : {}),
  })
  await page.addInitScript(() => {
    window.Chart = class { constructor() {} destroy() {} resize() {} }
    window.XLSX = { read: () => ({ SheetNames: [], Sheets: {} }), utils: {} }
  })
  const errors = []
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  page.on('console', m => {
    const t = m.text()
    if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(t)) errors.push('console: ' + t)
  })
  page._errors = errors
  return page
}

async function seed(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(data => {
    localStorage.clear()
    localStorage.setItem('finAccounts', JSON.stringify(data.accounts))
    localStorage.setItem('finTransactions', JSON.stringify(data.transactions))
  }, SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
}

// Behavior snapshot: numbers that must stay IDENTICAL across refactors
// (perf caching etc.). Compared against tests/smoke-baseline.json when present.
async function behaviorSnapshot(page) {
  return page.evaluate(() => {
    setActivePeriod({ key: 'custom', label: 'test', start: '2026-06-01', end: '2026-07-31' })
    const p = getActivePeriod()
    const tx = filterByEffectivePeriod(getTransactions(), p)
    const savIds = analysisExpenseSavingsInvestIds()
    const ccDetail = ccAccountsWithDetail(tx)
    const byCat = {}
    tx.forEach(t => {
      const a = analysisExpenseAmount(t, savIds, ccDetail)
      if (a > 0) byCat[t.categoryId || 'none'] = Math.round(((byCat[t.categoryId || 'none'] || 0) + a) * 100) / 100
    })
    return {
      income: sumIncome(tx),
      expenses: sumExpenses(tx),
      hiddenSavings: sumHiddenSavings(tx),
      balChk: getAccountBalance('acc1'),
      balSav: getAccountBalance('sav1'),
      balCc: getAccountBalance('cc1'),
      balChkUpto: getAccountBalance('acc1', '2026-06-20'),
      flowSav: getAccountFlow('sav1', p),
      byCat,
      liquidTrend: getLiquidBalanceTrend(['2026-06', '2026-07']),
    }
  })
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })

  // ===== desktop =====
  const page = await newPage(browser)
  await seed(page)

  // all screens load without pageerror
  for (const s of ['dashboard', 'transactions', 'import', 'analysis', 'recurring', 'budget', 'property', 'settings']) {
    await page.evaluate(scr => navigate(scr), s)
    await page.waitForTimeout(250)
  }
  check('desktop: all 8 screens render without pageerror', page._errors.length === 0, page._errors.join(' | '))

  // behavior snapshot vs baseline
  const snap = await behaviorSnapshot(page)
  const fs = await import('node:fs')
  const basePath = new URL('./smoke-baseline.json', import.meta.url)
  if (fs.existsSync(basePath)) {
    const baseline = JSON.parse(fs.readFileSync(basePath, 'utf8'))
    check('behavior snapshot identical to baseline', JSON.stringify(snap) === JSON.stringify(baseline),
      `got ${JSON.stringify(snap)}\nexp ${JSON.stringify(baseline)}`)
  } else {
    fs.writeFileSync(basePath, JSON.stringify(snap, null, 2))
    console.log('ok - baseline written (first run)')
  }

  // XSS vendor is inert + renders as text
  await page.evaluate(() => navigate('transactions'))
  await page.waitForTimeout(300)
  const xssFired = await page.evaluate(() => !!window.__xss)
  check('XSS vendor payload is inert', !xssFired)
  const txText = await page.locator('#txTable').innerText()
  check('vendor with quotes+tags shown as text', txText.includes('חברה בע"מ'))

  // edit roundtrip must not corrupt vendor/notes
  await page.evaluate(() => openEditModal('t1'))
  await page.waitForTimeout(150)
  const vVal = await page.locator('#editVendor').inputValue()
  check('edit modal vendor value intact', vVal === XSS_VENDOR, vVal)
  await page.evaluate(() => saveEditModal())
  await page.waitForTimeout(150)
  const vAfter = await page.evaluate(() => getTransactions().find(t => t.id === 't1').vendor)
  check('vendor unchanged after save roundtrip', vAfter === XSS_VENDOR, vAfter)

  // flow filter shows linked deposit
  await page.evaluate(() => { document.getElementById('txFlowFilter').value = 'sav1'; _txPage = 0; _drawTxTable() })
  await page.waitForTimeout(150)
  check('flow filter matches linked expense row', (await page.locator('#txTable').innerText()).includes('הפקדה לחיסכון'))
  await page.evaluate(() => { document.getElementById('txFlowFilter').value = ''; _drawTxTable() })

  // ===== local snapshots: write → tamper → restore payload equals original =====
  const snapRes = await page.evaluate(async () => {
    const before = JSON.stringify(getTransactions())
    const meta = await writeLocalSnapshot('manual')
    if (!meta) return { ok: false, why: 'no meta' }
    // simulate data damage
    DB.set('finTransactions', [])
    const metas = await listLocalSnapshots()
    const payload = await _snapGetPayload(metas[0].id)
    if (!validateBackupData(payload)) return { ok: false, why: 'invalid payload' }
    applyBackupData(payload)
    const after = JSON.stringify(getTransactions())
    return { ok: before === after, why: 'roundtrip', count: metas.length }
  })
  check('local snapshot write→restore roundtrip identical', snapRes.ok, snapRes.why)
  const badRejected = await page.evaluate(() =>
    !validateBackupData(null) && !validateBackupData([]) && !validateBackupData({}) &&
    !validateBackupData({ transactions: 'x' }) && validateBackupData({ transactions: [] }))
  check('validateBackupData rejects malformed payloads', badRejected)

  // ===== perf: 10k transactions =====
  const perf = await page.evaluate(() => {
    const vendors = ['שופרסל', 'רמי לוי', 'פז', 'מסעדה', 'נטפליקס', 'חשמל', 'ארנונה', 'ביט דנה']
    const txs = getTransactions()
    for (let i = 0; i < 10000; i++) {
      const m = String(1 + (i % 12)).padStart(2, '0')
      const d = String(1 + (i % 28)).padStart(2, '0')
      txs.push({ id: 'p' + i, accountId: i % 5 === 0 ? 'cc1' : 'acc1', date: `202${4 + (i % 3)}-${m}-${d}`,
        amount: -(20 + (i % 400)), vendor: vendors[i % vendors.length], type: 'expense',
        categoryId: i % 3 === 0 ? 'cat_food' : '', createdAt: 1 })
    }
    DB.set('finTransactions', txs)
    const t0 = performance.now()
    navigate('dashboard')
    const t1 = performance.now()
    navigate('transactions')
    const t2 = performance.now()
    navigate('analysis')
    const t3 = performance.now()
    return { dashboard: Math.round(t1 - t0), transactions: Math.round(t2 - t1), analysis: Math.round(t3 - t2) }
  })
  console.log('perf(ms) with 10k tx:', JSON.stringify(perf))
  check('perf: dashboard render < 4000ms', perf.dashboard < 4000, `${perf.dashboard}ms`)
  check('perf: transactions render < 4000ms', perf.transactions < 4000, `${perf.transactions}ms`)
  check('no pageerror after perf run', page._errors.length === 0, page._errors.join(' | '))
  await page.close()

  // ===== mobile =====
  const mp = await newPage(browser, { mobile: true })
  await seed(mp)
  const isMobileUi = await mp.evaluate(() => typeof IS_MOBILE_UI !== 'undefined' && IS_MOBILE_UI)
  check('mobile UI gate active', isMobileUi)
  for (const s of ['dashboard', 'transactions', 'analysis', 'recurring', 'budget', 'property', 'settings']) {
    await mp.evaluate(scr => navigate(scr), s)
    await mp.waitForTimeout(250)
  }
  check('mobile: screens render without pageerror', mp._errors.length === 0, mp._errors.join(' | '))
  check('mobile: XSS inert', !(await mp.evaluate(() => !!window.__xss)))
  await mp.evaluate(() => navigate('dashboard'))
  await mp.waitForTimeout(300)
  check('mobile: feedback dock present in topbar', await mp.locator('#screen-dashboard .feedback-dock').count() > 0)
  await mp.close()

  await browser.close()
  console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nALL SMOKE CHECKS PASSED')
  process.exit(failures.length ? 1 : 0)
}

main().catch(e => { console.error('SMOKE CRASHED', e); process.exit(1) })
