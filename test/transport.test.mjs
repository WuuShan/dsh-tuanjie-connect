// Offline transport regressions. No credentials, external requests or quota.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createTuanjieShim } from '../lib/codely.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, fetch, store = {}) {
  const shim = createTuanjieShim({
    store: { resolve: async () => 'sk-test-key', read: () => ({}), ...store },
    fetch,
  })
  await shim.ready
  t.after(() => shim.close())
  return {
    shim,
    post: (options = {}) => globalThis.fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${shim.sharedSecret}` },
      body: '{"stream":true}', ...options,
    }),
  }
}

test('headers and first SSE delta arrive before generation finishes; bytes stay intact', { timeout: 5000 }, async (t) => {
  let stream
  const body = new ReadableStream({ start(controller) { stream = controller } })
  const { post } = await fixture(t, async (_, init) => {
    assert.equal(init.headers['Accept-Encoding'], 'identity')
    assert.match(init.headers['X-Codely-Signature'], /^v1\./)
    assert.equal(init.body.toString(), '{"stream":true}')
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  // No upstream body yet: headers must still be flushed immediately.
  const response = await post()
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  assert.match(response.headers.get('cache-control'), /no-transform/)
  const reader = response.body.getReader()
  const first = Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n')
  stream.enqueue(first)
  const received = [Buffer.from((await reader.read()).value)]
  assert.deepEqual(received[0], first)
  const rest = Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"中文"}}]}}]}\n\ndata: [DONE]\n\n')
  // Split UTF-8 and JSON across arbitrary transport chunks.
  for (let i = 0; i < rest.length; i++) stream.enqueue(rest.subarray(i, i + 1))
  stream.close()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received.push(Buffer.from(value))
  }
  assert.deepEqual(Buffer.concat(received), Buffer.concat([first, rest]))
})

test('final auth rejection preserves its error body and retries only once', async (t) => {
  let calls = 0
  let refreshes = 0
  let cancelled = false
  const { post } = await fixture(t, async () => {
    if (++calls === 1) return new Response(new ReadableStream({
      cancel() { cancelled = true },
    }), { status: 401 })
    return new Response('{"error":{"message":"quota denied"}}', {
      status: 403, headers: { 'content-type': 'application/json' },
    })
  }, { refresh: async () => { refreshes++; return 'sk-new-key' } })
  const response = await post()
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.message, 'quota denied')
  assert.equal(calls, 2)
  assert.equal(refreshes, 1)
  assert.equal(cancelled, true)
})

test('a late 401 reuses the key refreshed by another concurrent request', { timeout: 5000 }, async (t) => {
  const bothStarted = deferred()
  const refreshed = deferred()
  let key = 'sk-old-key'
  let oldRequests = 0
  let refreshes = 0
  const { post } = await fixture(t, async (_, init) => {
    if (init.headers['x-api-key'] === 'sk-old-key') {
      const ordinal = ++oldRequests
      if (ordinal === 2) bothStarted.resolve()
      await bothStarted.promise
      if (ordinal === 2) await refreshed.promise
      return new Response('expired', { status: 401 })
    }
    return new Response('ok')
  }, {
    resolve: async () => key,
    refresh: async () => { refreshes++; key = 'sk-new-key'; refreshed.resolve(); return key },
  })
  const responses = await Promise.all([post(), post()])
  assert.deepEqual(await Promise.all(responses.map((r) => r.text())), ['ok', 'ok'])
  assert.equal(refreshes, 1)
})

test('429 preserves Retry-After without replaying a billable POST', async (t) => {
  let calls = 0
  const { post } = await fixture(t, async () => {
    calls++
    return new Response('limited', { status: 429, headers: { 'retry-after': '12', 'x-request-id': 'test-id' } })
  })
  const response = await post()
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '12')
  assert.equal(response.headers.get('x-request-id'), 'test-id')
  assert.equal(await response.text(), 'limited')
  assert.equal(calls, 1)
})

test('broken upstream fails the downstream read instead of returning clean EOF', { timeout: 5000 }, async (t) => {
  let stream
  let calls = 0
  const { post } = await fixture(t, async () => {
    calls++
    return new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(Buffer.from('data: partial\n\n')) } }))
  })
  const response = await post()
  const reader = response.body.getReader()
  await reader.read()
  stream.error(new Error('upstream disconnected'))
  await assert.rejects(async () => { while (!(await reader.read()).done) {} })
  assert.equal(calls, 1)
})

test('client cancellation aborts upstream and cancels a running body', { timeout: 5000 }, async (t) => {
  const cancelled = deferred()
  let signal
  const { post } = await fixture(t, async (_, init) => {
    signal = init.signal
    return new Response(new ReadableStream({
      start(c) { c.enqueue(Buffer.from('data: first\n\n')) },
      cancel() { cancelled.resolve() },
    }))
  })
  const controller = new AbortController()
  const response = await post({ signal: controller.signal })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()
  await cancelled.promise
  assert.equal(signal.aborted, true)
})

test('slow consumer backpressures upstream rather than buffering the entire response', { timeout: 5000 }, async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 120)
  const total = 1024 // 64 MiB; well above TCP and stream buffers.
  let pulls = 0
  const { shim } = await fixture(t, async () => new Response(new ReadableStream({
    pull(c) {
      pulls++
      c.enqueue(chunk)
      if (pulls === total) c.close()
    },
  })))
  const response = await new Promise((resolve, reject) => {
    const req = request(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${shim.sharedSecret}` },
    }, resolve)
    req.on('error', reject)
    req.end('{}')
  })
  t.after(() => response.destroy())
  response.pause()
  await delay(150)
  const first = pulls
  await delay(150)
  assert.ok(pulls < total / 2, `read ${pulls} chunks for a paused consumer`)
  assert.ok(pulls - first <= 4, `upstream kept reading: ${first} -> ${pulls}`)
  response.resume()
  let bytes = 0
  for await (const data of response) bytes += data.length
  assert.equal(bytes, total * chunk.length)
})

test('independent concurrent requests do not block each other', { timeout: 5000 }, async (t) => {
  const allStarted = deferred()
  let active = 0
  const { post } = await fixture(t, async () => {
    if (++active === 16) allStarted.resolve()
    await allStarted.promise
    return new Response('ok')
  })
  const responses = await Promise.all(Array.from({ length: 16 }, () => post()))
  assert.deepEqual(await Promise.all(responses.map((r) => r.text())), Array(16).fill('ok'))
})
