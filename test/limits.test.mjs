/**
 * Output-ceiling regression tests.
 *
 * The defect: reasoning and the answer share one `max_tokens` on the
 * OpenAI-completions path, and the declared 16384 was exactly pi-ai's `high`
 * thinking budget, so a task that invited long planning spent the whole
 * allowance thinking and the answer was cut off (or never started).
 *
 * These assert the ceiling the adapter actually publishes, because that is what
 * DSH forwards as max_tokens — and the clamps that keep it from overflowing a
 * model whose context is smaller than the desired ceiling.
 *
 * Offline: the catalog maths needs no network, and the adapter half drives the
 * real apply() inside the dsh-core fixture with a synthetic sign-in.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KNOWN_MODELS, buildCatalog } from '../lib/codely.js'

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'tj-limits-'))

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

// --- 1. the declared ceilings ------------------------------------------------
console.log('\n=== 1. every known model keeps real answer room ===')
{
  // pi-ai's DEFAULT_THINKING_BUDGETS.high is 16384; anything at or below it
  // leaves no space for an answer once reasoning has run.
  const HIGH_THINKING_BUDGET = 16384
  const MIN_ANSWER_ROOM = 1024

  for (const [id, info] of Object.entries(KNOWN_MODELS)) {
    check(`${id} ceiling ${info.maxTokens} leaves room beyond a high thinking budget`,
      info.maxTokens > HIGH_THINKING_BUDGET + MIN_ANSWER_ROOM,
      `a ceiling of ${info.maxTokens} cannot hold ${HIGH_THINKING_BUDGET} of thinking plus an answer`)
  }
}

console.log('\n=== 2. the context windows are the ones the gateway reports ===')
{
  // Measured from GET /v1/models: core 1048576, flash/vl 1024000. Declaring less
  // than the model supports makes DSH compact a conversation early for no reason.
  check('codely-core declares its full window', KNOWN_MODELS['codely-core'].contextWindow === 1048576,
    String(KNOWN_MODELS['codely-core'].contextWindow))
  check('codely-flash declares its full window', KNOWN_MODELS['codely-flash'].contextWindow === 1024000,
    String(KNOWN_MODELS['codely-flash'].contextWindow))
  check('codely-vl declares its full window', KNOWN_MODELS['codely-vl'].contextWindow === 1024000,
    String(KNOWN_MODELS['codely-vl'].contextWindow))
}

// --- 3. clamps ---------------------------------------------------------------
console.log('\n=== 3. the ceiling never overflows the context window ===')
{
  const cases = [
    { entry: { id: 'codely-core', max_model_len: 1048576 }, want: { contextWindow: 1048576, maxTokens: 65536 } },
    { entry: { id: 'codely-basic', max_model_len: 1024000 }, want: { contextWindow: 1024000, maxTokens: 65536 } },
    { entry: { id: 'unheard-of', max_model_len: 8000 }, want: { contextWindow: 8000, maxTokens: 6976 } },
    { entry: { id: 'tiny', max_model_len: 2048 }, want: { contextWindow: 2048, maxTokens: 1024 } },
    { entry: { id: 'codely-flash' }, want: { contextWindow: 1024000, maxTokens: 65536 } },
  ]
  for (const { entry, want } of cases) {
    const [built] = buildCatalog([entry])
    check(`${entry.id}: window ${built.contextWindow}, ceiling ${built.maxTokens}`,
      built.contextWindow === want.contextWindow && built.maxTokens === want.maxTokens,
      `wanted ${want.contextWindow}/${want.maxTokens}`)
    check(`${entry.id}: prompt room is left below the window`,
      built.maxTokens < built.contextWindow, `${built.maxTokens} vs ${built.contextWindow}`)
  }
}

console.log('\n=== 4. an upstream-published output cap wins when it is smaller ===')
{
  const [capped] = buildCatalog([{ id: 'codely-core', max_model_len: 1048576, max_output_tokens: 8192 }])
  check('a smaller published cap is honoured', capped.maxTokens === 8192, String(capped.maxTokens))

  const [generous] = buildCatalog([{ id: 'codely-core', max_model_len: 1048576, max_output_tokens: 500000 }])
  check('a larger published cap does not inflate our ceiling', generous.maxTokens === 65536,
    String(generous.maxTokens))

  const [junk] = buildCatalog([{ id: 'codely-core', max_model_len: 1048576, max_output_tokens: 'not-a-number' }])
  check('a malformed published cap is ignored', junk.maxTokens === 65536, String(junk.maxTokens))
}

// --- 5. what the adapter publishes ------------------------------------------
console.log('\n=== 5. the raised ceiling is wired into the pi-ai model ===')
{
  // DSH's own model-info shape carries only provider/id/name/modalities, so the
  // token figures cannot be read back from listModels(). What is checked here is
  // that buildCatalog still feeds `maxTokens` into the pi-ai model definition,
  // which is what pi-ai turns into `max_tokens` (via compat.maxTokensField).
  //
  // The historical evidence that this wire is live: before the fix, generation
  // stopped at exactly 16384 completion tokens — the declared value — so the
  // declared ceiling provably reaches the request.
  const host = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  check('toPiModel copies the catalog ceiling', /maxTokens:\s*info\.maxTokens/.test(host))
  check('the OpenAI field name is still max_tokens', /maxTokensField:\s*'max_tokens'/.test(host))
  check('the catalog builder is what feeds it', /catalog\.current\(\)\.map/.test(host))

  const fixture = await import('./fixture.mjs')
  const loaded = await fixture.loadPluginIntoFixture()

  if (loaded === undefined) {
    console.log('  SKIP  the dsh-core fixture is not present (run extract-core.mjs, then grow-core.mjs)')
    process.exitCode = fail === 0 ? 0 : 1
  } else {
    const USER_ID = 999
    const TEAM = 'team-x'
    const authFile = join(dir, 'oauth_creds.json')
    const orgFile = join(dir, 'org.json')
    const visFile = join(dir, 'vis.json')
    const claims = Buffer.from(JSON.stringify({ sub: String(USER_ID), exp: 4102444800 })).toString('base64url')
    writeFileSync(authFile, JSON.stringify({ access_token: `x.${claims}.y`, user_id: USER_ID, cli_api_key: 'sk-synthetic' }), 'utf8')
    writeFileSync(orgFile, JSON.stringify({ accounts: { [String(USER_ID)]: { currentOrgId: TEAM } } }), 'utf8')
    writeFileSync(visFile, JSON.stringify({ accounts: {} }), 'utf8')

    const registrations = []
    const disposers = []
    const mockCtx = {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      llm: { registerAdapter(providers, adapter) { registrations.push(adapter); return () => {} } },
      get: () => undefined,
      emit() {},
      effect: (fn) => disposers.push(fn),
      inject() {},
    }
    loaded.plugin.apply(mockCtx, loaded.plugin.Config({ authFile, orgFile, visibilityFile: visFile }))
    await new Promise((resolve) => setTimeout(resolve, 1200))

    const adapter = registrations[0]
    check('the adapter registered', adapter !== undefined)

    if (adapter !== undefined) {
      const models = await adapter.listModels('tuanjie')
      check('every known model is still listed', models.length === 5, String(models.length))
      check('the roster still names every model', models.every((m) => typeof m.id === 'string' && m.id.length > 0))
    }

    // Closes the plugin's loopback server; without this the suite never exits.
    for (const factory of disposers) {
      const dispose = factory()
      if (typeof dispose === 'function') await dispose()
    }
  }
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
