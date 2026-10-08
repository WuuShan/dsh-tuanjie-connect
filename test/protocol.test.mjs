/**
 * Standalone verification of the Tuanjie Cowork protocol layer.
 *
 * Runs the real credential store, the real loopback shim, and real gateway
 * traffic — no DSH involvement. Proves the pieces `index.js` depends on.
 */
import { TuanjieCredentialStore, buildCatalog, createTuanjieShim, fetchModelList, defaultAuthPath, defaultOrgPath, deriveSigningKey, signRequest } from '../lib/codely.js'
import { connect } from 'node:net'

/** Minimal HTTP/1.1 client, so the Host header can be spoofed deliberately. */
function rawRequest(base, { method, path, headers }) {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      const lines = [`${method} ${path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)]
      socket.write(`${lines.join('\r\n')}\r\nConnection: close\r\n\r\n`)
    })
    let data = ''
    socket.on('data', (chunk) => { data += chunk.toString('utf8') })
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.\d (\d+)/.exec(data)?.[1] ?? 0)
      resolve({ status, body: data })
    })
    socket.on('error', reject)
  })
}

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

const silent = { warn: (m) => console.log(`    [warn] ${m}`), debug: () => {}, error: (m) => console.log(`    [error] ${m}`) }

console.log('\n=== 1. credential store ===')
const store = new TuanjieCredentialStore(defaultAuthPath, defaultOrgPath, silent)
const cred = store.read()
check('credential file parses', cred !== undefined)
check('carries an access token', typeof cred?.access_token === 'string' && cred.access_token.length > 0)
check('team id resolves from org.json', typeof store.teamId(cred) === 'string')

console.log('\n=== 2. signing ===')
const key = await store.resolve()
check('resolve() returns an sk- virtual key', typeof key === 'string' && key.startsWith('sk-'), String(key).slice(0, 10))
const sk = deriveSigningKey(key)
const sig = signRequest('/v1/chat/completions', sk)
check('signature has the v1.<ts>.<mac> shape', /^v1\.\d+\.[A-Za-z0-9_-]+$/.test(sig), sig.slice(0, 30))
check('signature is path-bound', signRequest('/v1/models', sk) !== signRequest('/v1/chat/completions', sk))
check('signature is time-bound', signRequest('/v1/models', sk, 1000) !== signRequest('/v1/models', sk, 2000))

console.log('\n=== 3. live model list ===')
const live = await fetchModelList(key)
check('gateway returned a roster', live.length > 0, `${live.length} models`)
const ids = live.map((m) => m.id)
check('includes codely-core', ids.includes('codely-core'), ids.join(','))

console.log('\n=== 4. catalog merge ===')
const cat = buildCatalog(live)
check('catalog covers the roster', cat.length === live.length)
const core = cat.find((m) => m.id === 'codely-core')
check('codely-core keeps its friendly name', core?.name.includes('GLM-5.3'), core?.name)
check('codely-core declares a context window', core?.contextWindow > 0, String(core?.contextWindow))
const vl = cat.find((m) => m.id === 'codely-vl')
check('codely-vl is text-only (is_vlm false)', vl?.images === false, `images=${vl?.images}`)
const flash = cat.find((m) => m.id === 'codely-flash')
check('codely-flash accepts images', flash?.images === true)
check('unknown ids fall back to the default window', buildCatalog(['brand-new'])[0].contextWindow === 202752)
check('empty input falls back to the built-in roster', buildCatalog([]).length === 5)

console.log('\n=== 5. loopback shim: auth boundary ===')
const shim = createTuanjieShim({ store, logger: silent })
await shim.ready
const base = shim.baseUrl()
check('shim listens on loopback', /^http:\/\/127\.0\.0\.1:\d+$/.test(base), base)

const noAuth = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' })
check('rejects a missing bearer', noAuth.status === 401, String(noAuth.status))

const badAuth = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}',
})
check('rejects a wrong bearer', badAuth.status === 401, String(badAuth.status))

// `fetch` forbids setting Host, so this one check goes over a raw socket.
const badHost = await rawRequest(base, {
  method: 'GET',
  path: '/healthz',
  headers: { Host: 'evil.example.com', Authorization: `Bearer ${shim.sharedSecret}` },
})
check('rejects a foreign Host header', badHost.status === 403, String(badHost.status))

const badOrigin = await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example.com' } })
check('rejects a foreign Origin', badOrigin.status === 403, String(badOrigin.status))

const health = await fetch(`${base}/healthz`, { headers: { Authorization: `Bearer ${shim.sharedSecret}` } })
check('accepts the shared secret', health.status === 200, String(health.status))

console.log('\n=== 6. loopback shim: live chat through the gateway ===')
const chatRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${shim.sharedSecret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'codely-core',
    messages: [{ role: 'user', content: 'Reply with exactly: SHIM_OK' }],
    max_tokens: 64,
  }),
})
const chatText = await chatRes.text()
check('chat completion succeeds through the shim', chatRes.status === 200, `${chatRes.status} ${chatText.slice(0, 160)}`)
let chatJson = null
try { chatJson = JSON.parse(chatText) } catch {}
check('response carries assistant content', typeof chatJson?.choices?.[0]?.message?.content === 'string',
  JSON.stringify(chatJson?.choices?.[0]?.message)?.slice(0, 160))
check('reasoning_content is surfaced', chatJson?.choices?.[0]?.message?.reasoning_content !== undefined)

console.log('\n=== 7. loopback shim: streaming ===')
const streamRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${shim.sharedSecret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'codely-flash',
    messages: [{ role: 'user', content: 'Count 1 to 3.' }],
    max_tokens: 64,
    stream: true,
    stream_options: { include_usage: true },
  }),
})
check('stream request is accepted', streamRes.status === 200, String(streamRes.status))
let dataLines = 0
let sawDone = false
let sawUsage = false
let sawReasoning = false
for await (const chunk of streamRes.body) {
  for (const line of Buffer.from(chunk).toString('utf8').split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (payload === '[DONE]') { sawDone = true; continue }
    dataLines++
    try {
      const j = JSON.parse(payload)
      if (j.usage) sawUsage = true
      if (j.choices?.[0]?.delta?.reasoning_content !== undefined) sawReasoning = true
    } catch {}
  }
}
check('stream delivered SSE chunks', dataLines > 0, `${dataLines} chunks`)
check('stream terminated with [DONE]', sawDone)
check('stream reported usage', sawUsage)
check('stream carried reasoning deltas', sawReasoning)

console.log('\n=== 8. loopback shim: tool calling ===')
const toolRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${shim.sharedSecret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'codely-core',
    messages: [{ role: 'user', content: 'What is the weather in Beijing? Use the tool.' }],
    max_tokens: 300,
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
  }),
})
const toolJson = await toolRes.json().catch(() => null)
check('tool call is returned', Array.isArray(toolJson?.choices?.[0]?.message?.tool_calls),
  JSON.stringify(toolJson?.choices?.[0]?.message)?.slice(0, 200))
check('tool call names the function', toolJson?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'get_weather')

console.log('\n=== 9. loopback shim: image input ===')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const imgRes = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${shim.sharedSecret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'codely-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    }],
    max_tokens: 48,
  }),
})
check('image request is accepted', imgRes.status === 200, String(imgRes.status))

console.log('\n=== 10. unknown route ===')
const nf = await fetch(`${base}/v1/embeddings`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${shim.sharedSecret}` },
  body: '{}',
})
check('unknown route returns 404', nf.status === 404, String(nf.status))

await shim.close()
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
