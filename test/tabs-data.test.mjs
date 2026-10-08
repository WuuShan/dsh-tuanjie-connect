/**
 * Prove the new tab data actually reaches the card.
 *
 * The card unit test renders components with hand-made props; this checks the
 * host side of the same contract — that collectStatus really returns the model
 * roster the Models tab renders, and that the payload stays secret-free.
 */
import { collectStatus, buildCatalog, fetchModelList, TuanjieCredentialStore, defaultAuthPath, defaultOrgPath } from '../lib/codely.js'

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

console.log('\n=== 1. collectStatus carries the model roster ===')
const status = await collectStatus({ version: 'tab-test' })
check('signed in', status.state === 'signed-in', status.state)
check('roster present', Array.isArray(status.models) && status.models.length > 0,
  `${status.models?.length} models`)
check('roster stamped with a time', typeof status.modelsUpdatedAt === 'string', String(status.modelsUpdatedAt))
check('stamp parses as a date', Number.isFinite(Date.parse(status.modelsUpdatedAt ?? '')),
  String(status.modelsUpdatedAt))

console.log('\n=== 2. each entry has what the Models tab renders ===')
for (const model of status.models ?? []) {
  check(`${model.id}: id/name/context`,
    typeof model.id === 'string' && typeof model.name === 'string' && typeof model.contextWindow === 'number',
    JSON.stringify(model))
}
const core = (status.models ?? []).find((m) => m.id === 'codely-core')
check('codely-core declares a context window', core?.contextWindow > 0, String(core?.contextWindow))
check('codely-core is marked image-capable', core?.images === true, String(core?.images))
const vl = (status.models ?? []).find((m) => m.id === 'codely-vl')
check('codely-vl is text-only', vl?.images === false, String(vl?.images))

console.log('\n=== 3. the quota tab has a data source ===')
check('account present', status.account !== undefined)
check('remaining points is a number', Number.isFinite(status.account?.remainingPoints),
  String(status.account?.remainingPoints))
check('buckets is an array', Array.isArray(status.account?.buckets),
  JSON.stringify(status.account?.buckets))
check('exhaustion flag present', typeof status.account?.exhausted === 'boolean')

console.log('\n=== 4. nothing secret rides along ===')
const serialized = JSON.stringify(status)
check('no JWT', !/eyJ[A-Za-z0-9_-]{10,}/.test(serialized))
check('no sk- key', !/sk-[A-Za-z0-9_-]{8,}/.test(serialized))
check('no access_token field', !serialized.includes('access_token'))
check('no refresh_token field', !serialized.includes('refresh_token'))

console.log('\n=== 5. a failed roster fetch does not break the card ===')
const store = new TuanjieCredentialStore(defaultAuthPath, defaultOrgPath, undefined)
const key = await store.resolve()
check('key resolves', typeof key === 'string' && key.startsWith('sk-'))
const live = await fetchModelList(key)
check('catalog builds from the live roster', buildCatalog(live).length === live.length,
  `${live.length} -> ${buildCatalog(live).length}`)
check('catalog falls back when the roster is empty', buildCatalog([]).length === 5,
  String(buildCatalog([]).length))

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
