import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import * as protocol from '../lib/codely.js'

test('catalog polling skips overlap, unchanged rosters and updates after disposal', async () => {
  let poll
  let finishFetch
  let calls = 0
  let events = 0
  const effects = []
  // Execute the complete plugin lifecycle; mock only host/network boundaries.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from '[^']+'\r?\n/gm, '')
    .replace(/^export /gm, '')
  const apply = runInNewContext(`${source}\napply`, {
    ...protocol,
    z: { object: (value) => value, string: () => ({ description() { return this } }) },
    PiAiAdapter: class {},
    resolveRetryPolicy: () => ({}),
    resolveImageAttachmentAccess: () => {},
    createProvider: (value) => value,
    openAICompletionsApi: () => ({}),
    TuanjieCredentialStore: class { async resolve() { return 'sk-test-key' } },
    createTuanjieShim: () => ({ ready: Promise.resolve(), baseUrl: () => 'http://127.0.0.1:1', close() {} }),
    fetchModelList: () => { calls++; return new Promise((resolve) => { finishFetch = resolve }) },
    setInterval: (fn) => { poll = fn; return { unref() {} } },
    clearInterval() {},
    process: { env: {} },
  })
  apply({
    logger: {}, inject() {}, get() {},
    effect: (factory) => effects.push(factory()),
    emit: () => events++,
    llm: { registerAdapter: () => () => {} },
  }, {})
  await tick()
  assert.equal(calls, 1)
  poll()
  poll()
  await tick()
  assert.equal(calls, 1, 'a pending fetch must not overlap the next tick')
  finishFetch(protocol.FALLBACK_MODELS)
  await tick()
  assert.equal(events, 0, 'unchanged fallback roster must not invalidate adapters')
  poll()
  await tick()
  finishFetch(['new-model'])
  await tick()
  assert.equal(events, 1, 'changed roster must invalidate adapters')
  poll()
  await tick()
  for (const dispose of effects) dispose?.()
  finishFetch(['another-model'])
  await tick()
  assert.equal(events, 1, 'late fetch must not publish after plugin disposal')
  const before = calls
  poll()
  await tick()
  assert.equal(calls, before)
})
