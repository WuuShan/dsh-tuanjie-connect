/**
 * Prove the card's data path over real HTTP.
 *
 * The card unit test stubs the loader and never opens a socket; this mounts the
 * exact handler shape the host registers onto a bare server and fetches it the
 * way the browser would, which is the only way to catch a handler-signature or
 * header mistake.
 */
import { createServer } from 'node:http'
import { collectStatus } from '../lib/codely.js'

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

/** The handler body exactly as `lib/index.js` registers it. */
function handler(version) {
  return async (req, res) => {
    try {
      const status = await collectStatus({ version, logger: undefined })
      const body = Buffer.from(JSON.stringify(status), 'utf8')
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      })
      res.end(body)
    } catch (error) {
      const body = Buffer.from(JSON.stringify({ state: 'error', error: String(error?.message ?? error) }), 'utf8')
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      })
      res.end(body)
    }
  }
}

const server = createServer((req, res) => {
  if (req.url === '/plugins/dsh-tuanjie-connect/status') return void handler('http-test')(req, res)
  res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = `http://127.0.0.1:${port}/plugins/dsh-tuanjie-connect/status`

console.log('\n=== 1. the browser\'s own request ===')
const response = await fetch(url, { headers: { Accept: 'application/json' } })
check('route answers 200', response.status === 200, String(response.status))
check('content type is JSON', (response.headers.get('content-type') ?? '').includes('application/json'),
  String(response.headers.get('content-type')))
check('responses are not cached', response.headers.get('cache-control') === 'no-store',
  String(response.headers.get('cache-control')))
check('content-length is declared', response.headers.get('content-length') !== null)

console.log('\n=== 2. the payload the card renders ===')
const payload = await response.json()
check('parses as JSON', typeof payload === 'object' && payload !== null)
check('reports a state', typeof payload.state === 'string', payload.state)
check('state is signed-in', payload.state === 'signed-in', payload.state)
check('carries the username', typeof payload.username === 'string', String(payload.username))
check('carries the quota', typeof payload.account?.remainingPoints === 'number',
  String(payload.account?.remainingPoints))
check('carries token expiry', typeof payload.accessTokenExpires === 'string', String(payload.accessTokenExpires))
check('carries days left', typeof payload.accessTokenDaysLeft === 'number', String(payload.accessTokenDaysLeft))
check('carries model-key health', payload.modelKey?.state === 'ready', String(payload.modelKey?.state))
check('stamps the bundle version', payload.version === 'http-test', String(payload.version))

console.log('\n=== 3. UTF-8 survives the wire (the card shows Chinese) ===')
check('username round-trips', payload.username === (await collectStatus({})).username)
const raw = await (await fetch(url)).text()
check('body is valid UTF-8', !raw.includes('\uFFFD'))

console.log('\n=== 4. no secret crosses the wire ===')
check('no JWT in the body', !/eyJ[A-Za-z0-9_-]{10,}/.test(raw))
check('no sk- key in the body', !/sk-[A-Za-z0-9_-]{8,}/.test(raw))
check('no access_token field', !raw.includes('access_token'))
check('no refresh_token field', !raw.includes('refresh_token'))

console.log('\n=== 5. unknown paths still 404 ===')
const missing = await fetch(`http://127.0.0.1:${port}/plugins/dsh-tuanjie-connect/nope`)
check('unknown route is 404', missing.status === 404, String(missing.status))

await new Promise((resolve) => server.close(resolve))
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
