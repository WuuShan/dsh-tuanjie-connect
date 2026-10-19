/**
 * Independent verification of the two semantics most likely to be subtly wrong
 * in the merged transport patch.
 *
 * The patch ships its own tests; these are written from the contract rather
 * than from that implementation, and assert the mechanisms directly:
 *
 *   1. A mid-stream upstream failure must reach the client as a failed read,
 *      not as a clean HTTP EOF. A clean EOF is indistinguishable from a
 *      complete answer, which is how a truncated reply gets accepted.
 *   2. A 401 must cause at most one key rotation, and must not rotate at all
 *      when another in-flight request already did.
 *   3. Backpressure must actually stop pulling from upstream when the consumer
 *      stalls — the defect this patch exists to fix was an unawaited
 *      `res.write()` loop draining the whole response into memory.
 *
 * Offline: the upstream is a stub injected through the shim's `fetch` option.
 */
import { createTuanjieShim } from '../lib/codely.js'

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

/** A store whose rotation attempts are counted. */
function makeStore(keys) {
  let index = 0
  const calls = { resolve: 0, refresh: 0 }
  return {
    calls,
    /** Advance the "someone else already rotated it" cursor. */
    rotateExternally() { index++ },
    currentKey: () => keys[index],
    resolve: async () => { calls.resolve++; return keys[index] },
    read: () => ({ access_token: 'tok', user_id: 1, cli_api_key: keys[index] }),
    refresh: async () => { calls.refresh++; index++; return keys[index] },
    credentialPath: () => 'C:/nonexistent/creds.json',
    organizationPath: () => 'C:/nonexistent/org.json',
    disabled: () => [],
  }
}

async function withShim(t, fetchImpl) {
  const store = fetchImpl.store
  const shim = createTuanjieShim({ store, fetch: fetchImpl.fetch, logger: { warn() {}, debug() {} } })
  await shim.ready
  t.after(() => shim.close())
  return shim
}

function chat(shim, init = {}) {
  return globalThis.fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${shim.sharedSecret}`, 'Content-Type': 'application/json' },
    body: '{"stream":true}',
    ...init,
  })
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. normal streaming delivers every byte; a mid-stream failure does not look clean ===')
{
  // 1a. The baseline this must not regress: a healthy stream arrives intact.
  const storeOk = makeStore(['sk-a'])
  const shimOk = await (async () => {
    const s = createTuanjieShim({
      store: storeOk,
      logger: { warn() {}, debug() {} },
      fetch: async () => {
        const parts = [
          'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
          'data: [DONE]\n\n',
        ]
        let i = 0
        return new Response(new ReadableStream({
          pull(controller) {
            if (i >= parts.length) { controller.close(); return }
            // One byte at a time, so multi-byte characters straddle chunks.
            const bytes = new TextEncoder().encode(parts[i++])
            for (const b of bytes) controller.enqueue(new Uint8Array([b]))
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    await s.ready
    return s
  })()

  const okResponse = await chat(shimOk)
  let okBody = ''
  let okError
  try {
    for await (const chunk of okResponse.body) okBody += Buffer.from(chunk).toString('utf8')
  } catch (error) {
    okError = error
  }
  check('a healthy stream reads cleanly', okError === undefined, String(okError))
  check('every byte survived, including split multi-byte characters',
    okBody.includes('思考') && okBody.includes('答案') && okBody.includes('[DONE]'),
    JSON.stringify(okBody.slice(0, 140)))
  await shimOk.close()

  // 1b. The failure case. Whether the already-buffered prefix surfaces before
  // the error is timing-dependent and not part of the contract; what matters is
  // that the client cannot mistake a truncated answer for a complete one.
  const store = makeStore(['sk-a'])
  const shim = await (async () => {
    const s = createTuanjieShim({
      store,
      logger: { warn() {}, debug() {} },
      fetch: async () => {
        let sent = 0
        const body = new ReadableStream({
          pull(controller) {
            if (sent === 0) {
              sent++
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'))
              return
            }
            // Fail after the client has already received part of the answer.
            controller.error(new Error('upstream exploded mid-stream'))
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    await s.ready
    return s
  })()

  const response = await chat(shim)
  check('the status line is a success (headers already went out)', response.status === 200, String(response.status))

  let readError
  let received = ''
  try {
    for await (const chunk of response.body) received += Buffer.from(chunk).toString('utf8')
  } catch (error) {
    readError = error
  }

  check('the read FAILED rather than ending cleanly', readError !== undefined,
    'a truncated answer would be accepted as complete — this is the disconnect symptom')
  check('a failure is never reported as a successful short read',
    !(readError === undefined && received.length > 0))
  await shim.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. a 401 rotates once, and reuses a key another request rotated ===')
{
  const store = makeStore(['sk-old', 'sk-new'])
  let seen = 0
  const shim = await (async () => {
    const s = createTuanjieShim({
      store,
      logger: { warn() {}, debug() {} },
      fetch: async (_url, init) => {
        seen++
        const used = init.headers['x-api-key']
        if (used === 'sk-old') return new Response('{"error":"stale key"}', { status: 401 })
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    await s.ready
    return s
  })()

  const response = await chat(shim)
  check('the retry eventually succeeds', response.status === 200, String(response.status))
  check('upstream was called exactly twice (one retry, not a loop)', seen === 2, `seen=${seen}`)
  check('the key was rotated exactly once', store.calls.refresh === 1, `refresh=${store.calls.refresh}`)
  await shim.close()
}

{
  // The late-401 case: by the time our request is rejected, another request has
  // already rotated the key, so rotating again would be wasted work.
  const store = makeStore(['sk-old', 'sk-new', 'sk-third'])
  let seen = 0
  const shim = await (async () => {
    const s = createTuanjieShim({
      store,
      logger: { warn() {}, debug() {} },
      fetch: async (_url, init) => {
        seen++
        const used = init.headers['x-api-key']
        if (used === 'sk-old') {
          // Simulate a concurrent request completing its rotation first.
          store.rotateExternally()
          return new Response('{"error":"stale key"}', { status: 401 })
        }
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    await s.ready
    return s
  })()

  const response = await chat(shim)
  check('the late 401 still succeeds', response.status === 200, String(response.status))
  check('it did NOT rotate the key again', store.calls.refresh === 0,
    `refresh=${store.calls.refresh} — a second mint for a key someone else already replaced`)
  check('it retried with the already-rotated key', seen === 2, `seen=${seen}`)
  await shim.close()
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. backpressure stops pulling when the consumer stalls ===')
{
  const CHUNK = 64 * 1024
  const TOTAL = 200
  let pulled = 0
  const store = makeStore(['sk-a'])
  const shim = await (async () => {
    const s = createTuanjieShim({
      store,
      logger: { warn() {}, debug() {} },
      fetch: async () => {
        const body = new ReadableStream({
          pull(controller) {
            if (pulled >= TOTAL) { controller.close(); return }
            pulled++
            controller.enqueue(new Uint8Array(CHUNK))
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    await s.ready
    return s
  })()

  const response = await chat(shim)
  // Take one chunk so the response is live, then stop reading entirely.
  const reader = response.body.getReader()
  await reader.read()
  const pulledAtStall = pulled
  await new Promise((resolve) => setTimeout(resolve, 400))
  const pulledAfterStall = pulled

  check('the response is streaming', pulledAtStall >= 1, `pulled=${pulledAtStall}`)
  check('a stalled consumer does NOT drain the whole upstream',
    pulledAfterStall < TOTAL,
    `pulled ${pulledAfterStall}/${TOTAL} chunks (${((pulledAfterStall * CHUNK) / 1048576).toFixed(1)} MiB) while nobody was reading`)
  check('buffering stayed bounded', pulledAfterStall < TOTAL / 2,
    `${pulledAfterStall} chunks — the unawaited-write defect would have reached ${TOTAL}`)

  // Cancelling the consumer must release upstream rather than let it run on.
  const beforeCancel = pulled
  await reader.cancel()
  await new Promise((resolve) => setTimeout(resolve, 200))
  check('cancelling the client stops upstream being pulled further',
    pulled <= beforeCancel + 3, `${beforeCancel} -> ${pulled}`)
  await shim.close()
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
