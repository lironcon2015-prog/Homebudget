// The Gemini model cascade (callGemini in app.js).
//
// A newly released model answers 503 "currently experiencing high demand" for
// weeks after launch, intermittently. The cascade has to ride that out: retry
// the model, fall through to the next one, and never let a transient failure
// escape as a hard error while a healthy model is still in the list.
import test from 'node:test'
import assert from 'node:assert'
import { loadApp } from './helpers.mjs'

// Scripted responses per call, in order. Each entry is either
// { status, body } or { throw: 'message' } for a fetch that rejects.
function makeCtx(script, models = ['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
  const calls = []
  const toasts = []
  let i = 0
  const ctx = loadApp(['app.js'], {
    performance,
    // No real waiting: the backoff is exercised, not slept through.
    setTimeout: (fn) => { fn(); return 0 },
    clearTimeout: () => {},
    toast: (msg) => toasts.push(msg),
    fetch: async (url) => {
      const step = script[Math.min(i, script.length - 1)]
      i++
      calls.push(String(url).match(/models\/([^:]+):/)[1])
      if (step.throw) throw new Error(step.throw)
      return {
        ok: step.status === 200,
        status: step.status,
        json: async () => step.body ?? {},
      }
    },
  })
  ctx.localStorage.setItem('geminiModels', JSON.stringify(models))
  ctx._calls = calls
  ctx._toasts = toasts
  return ctx
}

const OK = { status: 200, body: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] } }
const HIGH_DEMAND = {
  status: 503,
  body: { error: { status: 'UNAVAILABLE', message: 'The model is currently experiencing high demand.' } },
}
const RATE_LIMIT = { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } } }

test('a transient 503 is retried on the same model before demoting', async () => {
  const ctx = makeCtx([HIGH_DEMAND, OK])
  const data = await ctx.callGemini('k', {})
  assert.ok(data.candidates)
  assert.deepStrictEqual(ctx._calls, ['gemini-3.7-flash', 'gemini-3.7-flash'],
    'the preferred model gets another chance instead of an instant demotion')
  assert.strictEqual(ctx._toasts.length, 0, 'a recovered blip is not worth a toast')
})

test('a persistently overloaded model falls through to the next one', async () => {
  const ctx = makeCtx([HIGH_DEMAND, HIGH_DEMAND, HIGH_DEMAND, OK])
  const data = await ctx.callGemini('k', {})
  assert.ok(data.candidates)
  assert.deepStrictEqual(ctx._calls.slice(0, 3), Array(3).fill('gemini-3.7-flash'))
  assert.strictEqual(ctx._calls[3], 'gemini-2.5-flash')
  assert.match(ctx._toasts[0], /gemini-3\.7-flash.*gemini-2\.5-flash/)
})

test('a benched model is skipped on the next request while a healthy one is left', async () => {
  const ctx = makeCtx([HIGH_DEMAND, HIGH_DEMAND, HIGH_DEMAND, OK])
  await ctx.callGemini('k', {})
  ctx._calls.length = 0
  await ctx.callGemini('k', {})
  assert.strictEqual(ctx._calls[0], 'gemini-2.5-flash',
    'the second request must not pay the overloaded model\'s retries again')
})

test('a successful call clears the model cooldown', async () => {
  const ctx = makeCtx([HIGH_DEMAND, HIGH_DEMAND, HIGH_DEMAND, OK])
  await ctx.callGemini('k', {})
  assert.strictEqual(ctx._eval('_geminiCooldown.has("gemini-3.7-flash")'), true)
  assert.strictEqual(ctx._eval('_geminiCooldown.has("gemini-2.5-flash")'), false)
})

test('a thrown fetch does not abort the cascade', async () => {
  const ctx = makeCtx([{ throw: 'Failed to fetch' }, { throw: 'Failed to fetch' }, { throw: 'Failed to fetch' }, OK])
  const data = await ctx.callGemini('k', {})
  assert.ok(data.candidates)
  assert.strictEqual(ctx._calls[3], 'gemini-2.5-flash')
})

test('an unknown model name is skipped immediately, without retries', async () => {
  const ctx = makeCtx([
    { status: 404, body: { error: { status: 'NOT_FOUND', message: 'models/typo is not found' } } },
    OK,
  ])
  const data = await ctx.callGemini('k', {})
  assert.ok(data.candidates)
  assert.deepStrictEqual(ctx._calls, ['gemini-3.7-flash', 'gemini-2.5-flash'],
    'a name that can never work is not worth three attempts')
})

test('a bad key fails fast instead of walking the whole cascade', async () => {
  const ctx = makeCtx([{ status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'API key not valid' } } }])
  await assert.rejects(() => ctx.callGemini('k', {}), /API key not valid/)
  assert.strictEqual(ctx._calls.length, 1, 'every model would answer the same')
})

test('when everything is overloaded the error names each model and why', async () => {
  const ctx = makeCtx([HIGH_DEMAND, HIGH_DEMAND, HIGH_DEMAND, RATE_LIMIT], ['gemini-3.7-flash', 'gemini-2.5-flash'])
  await assert.rejects(() => ctx.callGemini('k', {}), err => {
    assert.match(err.message, /gemini-3\.7-flash: עומס \(503\)/)
    assert.match(err.message, /gemini-2\.5-flash: עומס \(429\)/)
    return true
  })
})

test('a cooldown never empties the cascade — benched models are retried last', async () => {
  const ctx = makeCtx([HIGH_DEMAND], ['gemini-3.7-flash'])
  await assert.rejects(() => ctx.callGemini('k', {}))
  ctx._calls.length = 0
  await assert.rejects(() => ctx.callGemini('k', {}))
  assert.strictEqual(ctx._calls[0], 'gemini-3.7-flash', 'the only model still gets tried')
})
