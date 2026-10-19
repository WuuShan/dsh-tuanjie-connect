import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { setImmediate as tick } from 'node:timers/promises'
import * as protocol from '../lib/codely.js'

test('quota query is read-only, lightweight, bounded and secret-free', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tuanjie-quota-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const authPath = join(dir, 'auth.json')
  const original = '{"access_token":"synthetic-private-token"}'
  writeFileSync(authPath, original)
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  let usage = { remaining_points: '1234.5', is_exhausted: false }
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(new URL(url).pathname, '/api/user/usage/summary')
    assert.equal(init.headers.Authorization, 'Bearer synthetic-private-token')
    assert.ok(init.signal)
    return Response.json(usage)
  }
  const quota = await protocol.collectQuota({ authPath })
  assert.equal(calls, 1)
  assert.equal(quota.state, 'ready')
  assert.equal(quota.remainingPoints, 1234.5)
  assert.ok(Number.isFinite(Date.parse(quota.updatedAt)))
  assert.ok(!JSON.stringify(quota).includes('synthetic-private-token'))
  assert.equal(readFileSync(authPath, 'utf8'), original)

  usage = { remaining_points: 0, is_exhausted: true }
  assert.equal((await protocol.collectQuota({ authPath })).remainingPoints, 0)
  assert.equal((await protocol.collectQuota({ authPath })).exhausted, true)
  for (const value of [null, undefined, '', '  ', false, [], {}, 'broken']) {
    usage = { remaining_points: value }
    const invalid = await protocol.collectQuota({ authPath })
    assert.equal(invalid.state, 'error')
    assert.equal(invalid.remainingPoints, undefined)
  }
  globalThis.fetch = async () => { throw new Error('synthetic-private-token must never leak') }
  const failed = await protocol.collectQuota({ authPath })
  assert.equal(failed.state, 'error')
  assert.ok(!JSON.stringify(failed).includes('synthetic-private-token'))
  const before = calls
  assert.equal((await protocol.collectQuota({ authPath: join(dir, 'missing') })).state, 'signed-out')
  assert.equal(calls, before)
})

test('the actual registered quota route serves no-store JSON and rejects mutations', async (t) => {
  const routes = []
  const effects = []
  let queried = 0
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from '[^']+'\r?\n/gm, '').replace(/^export /gm, '')
  const apply = runInNewContext(`${source}\napply`, {
    ...protocol,
    Buffer,
    z: { object: (v) => v, string: () => ({ description() { return this } }) },
    PiAiAdapter: class {}, resolveRetryPolicy: () => ({}),
    createProvider: (v) => v, openAICompletionsApi: () => ({}),
    TuanjieCredentialStore: class { async resolve() { return 'sk-test' } },
    createTuanjieShim: () => ({ ready: Promise.resolve(), baseUrl: () => 'http://127.0.0.1:1', close() {} }),
    collectQuota: async () => { queried++; return { state: 'ready', remainingPoints: 42 } },
    fetchModelList: async () => protocol.FALLBACK_MODELS,
    setInterval: () => ({ unref() {} }), clearInterval() {}, process: { env: {} },
  })
  apply({
    logger: {}, get() {}, emit() {},
    effect: (fn) => effects.push(fn()),
    llm: { registerAdapter: () => () => {} },
    inject: (services, fn) => { if (services[0] === 'webServer') fn({ webServer: { register: (route) => { routes.push(route); return () => {} } } }) },
  }, {})
  await tick()
  t.after(() => effects.forEach((dispose) => dispose?.()))
  const route = routes.find((item) => item.path === '/plugins/dsh-tuanjie-connect/quota')
  assert.ok(route)
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/`
  const response = await fetch(url)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).remainingPoints, 42)
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
  assert.equal(queried, 1)
})
