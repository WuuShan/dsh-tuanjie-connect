/**
 * Account-detection checks: the status/quota layer and its loopback route.
 *
 * Runs against the real control plane with the machine's own sign-in, so it
 * proves the account card's data path end to end.
 */
import {
  TuanjieCredentialStore,
  collectStatus,
  createTuanjieShim,
  decodeTokenClaims,
  defaultAuthPath,
  defaultOrgPath,
  fetchAccount,
} from '../lib/codely.js'

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

const silent = { warn: () => {}, debug: () => {}, error: () => {} }
const store = new TuanjieCredentialStore(defaultAuthPath, defaultOrgPath, silent)
const cred = store.read()

console.log('\n=== 1. token claims ===')
const claims = decodeTokenClaims(cred.access_token)
check('claims decode', claims !== undefined && typeof claims === 'object')
check('carries a username', typeof claims?.username === 'string', String(claims?.username))
check('carries an exp', typeof claims?.exp === 'number')
check('malformed tokens return undefined', decodeTokenClaims('not.a.jwt') === undefined)
check('empty tokens return undefined', decodeTokenClaims('') === undefined)

console.log('\n=== 2. account + quota (live) ===')
const account = await fetchAccount(cred.access_token)
check('account resolves', account?.username !== undefined, JSON.stringify(account)?.slice(0, 120))
check('user id present', account.userId !== undefined, String(account.userId))
check('quota reported as a number', Number.isFinite(account.remainingPoints), String(account.remainingPoints))
check('exhaustion flag present', typeof account.exhausted === 'boolean')
check('quota buckets parsed', Array.isArray(account.buckets), JSON.stringify(account.buckets))

console.log('\n=== 3. collectStatus (the card\'s data source) ===')
const status = await collectStatus({ version: 'test' })
check('state is signed-in', status.state === 'signed-in', status.state)
check('identifies the account', status.username !== undefined, String(status.username))
check('reports token expiry', typeof status.accessTokenExpires === 'string', String(status.accessTokenExpires))
check('reports days left', typeof status.accessTokenDaysLeft === 'number', String(status.accessTokenDaysLeft))
check('reports model-key health', status.modelKey?.state === 'ready', JSON.stringify(status.modelKey))
check('carries the quota', Number.isFinite(status.account?.remainingPoints))
check('reports its own version', status.version === 'test')

console.log('\n=== 4. status never leaks a secret ===')
const serialized = JSON.stringify(status)
check('no JWT in the payload', !/eyJ[A-Za-z0-9_-]{10,}/.test(serialized))
check('no sk- key in the payload', !/sk-[A-Za-z0-9_-]{8,}/.test(serialized))
check('no raw access_token field', !serialized.includes('access_token'))

console.log('\n=== 5. signed-out and error paths ===')
const signedOut = await collectStatus({ authPath: 'C:/definitely/missing/creds.json', orgPath: 'C:/missing/org.json' })
check('missing credential reports signed-out', signedOut.state === 'signed-out', signedOut.state)
check('signed-out carries a hint', typeof signedOut.hint === 'string' && signedOut.hint.length > 0)
check('signed-out reports the path it checked', signedOut.authFile?.present === false)

const rejected = await collectStatus({
  authPath: await (async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const file = path.join(os.tmpdir(), `tuanjie-bad-${Date.now()}.json`)
    fs.writeFileSync(file, JSON.stringify({ access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x', user_id: 1 }))
    return file
  })(),
  orgPath: 'C:/missing/org.json',
})
check('rejected token reports error', rejected.state === 'error', rejected.state)
check('error carries a hint', typeof rejected.hint === 'string')

console.log('\n=== 6. the /status route on the shim ===')
const shim = createTuanjieShim({ store, logger: silent, version: 'test' })
await shim.ready
const base = shim.baseUrl()

const unauthorized = await fetch(`${base}/status`)
check('status route requires the bearer', unauthorized.status === 401, String(unauthorized.status))

const response = await fetch(`${base}/status`, {
  headers: { Authorization: `Bearer ${shim.sharedSecret}` },
})
const payload = await response.json()
check('status route answers 200', response.status === 200, String(response.status))
check('route returns the signed-in state', payload.state === 'signed-in', payload.state)
check('route returns the account', payload.username !== undefined, String(payload.username))
check('route returns the quota', Number.isFinite(payload.account?.remainingPoints), String(payload.account?.remainingPoints))
check('route leaks no token', !/eyJ[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{8,}/.test(JSON.stringify(payload)))

await shim.close()
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
