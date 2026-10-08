/**
 * Model-visibility checks.
 *
 * The behaviour that matters is not "does a checkbox render" but two things the
 * WorkBuddy bundle learned the hard way:
 *
 *   1. Hiding a model must remove it from the *listing* only. `getModel()`
 *      resolves through the unfiltered roster, so a session already using a
 *      hidden model keeps working — filtering `getModels` instead would break
 *      it with UNKNOWN_MODEL.
 *   2. Preferences are per account and use a disabled-list, so a new model
 *      starts visible and an id that leaves the roster stays hidden when it
 *      returns.
 *
 * The second half drives the real pi-ai `createProvider` + `ModelsImpl` so the
 * resolution rule is tested against the library, not against my reading of it.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TuanjieVisibilityStore,
  visibilityAccountKeyOf,
  defaultVisibilityPath,
} from '../lib/codely.js'

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'tuanjie-vis-'))
const file = join(dir, 'visibility.json')
const silent = { warn: () => {}, debug: () => {}, error: () => {} }

console.log('\n=== 1. store: defaults and round-trip ===')
{
  let key = '84591:team-a'
  const store = new TuanjieVisibilityStore(() => file, silent, () => key)
  check('missing file means nothing hidden', store.disabled(key).length === 0)
  check('accountKey resolves', store.accountKey() === key, String(store.accountKey()))

  store.toggle(key, 'codely-vl', true)
  check('hiding persists', store.disabled(key).includes('codely-vl'), JSON.stringify(store.disabled(key)))
  check('the file now exists', readFileSync(file, 'utf8').includes('codely-vl'))
  check('hiding is idempotent', store.toggle(key, 'codely-vl', true).length === 1,
    JSON.stringify(store.disabled(key)))
  store.toggle(key, 'codely-vl', false)
  check('showing removes it', !store.disabled(key).includes('codely-vl'))
}

console.log('\n=== 2. store: per-account isolation ===')
{
  let key = 'a:team-a'
  const store = new TuanjieVisibilityStore(() => file, silent, () => key)
  store.toggle('a:team-a', 'codely-vl', true)
  store.toggle('b:team-b', 'codely-air', true)
  check('account a hides only its own', store.disabled('a:team-a').join() === 'codely-vl',
    store.disabled('a:team-a').join())
  check('account b hides only its own', store.disabled('b:team-b').join() === 'codely-air',
    store.disabled('b:team-b').join())
  check('an unknown account hides nothing', store.disabled('c:team-c').length === 0)
  check('signed out hides nothing', store.disabled(undefined).length === 0)

  // A model that leaves the roster and returns must stay hidden.
  store.toggle('a:team-a', 'codely-gone', true)
  check('an id that vanishes keeps its entry', store.disabled('a:team-a').includes('codely-gone'),
    store.disabled('a:team-a').join())
}

console.log('\n=== 3. store: hostile input ===')
{
  const store = new TuanjieVisibilityStore(() => file, silent, () => 'a:team-a')
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, 'not json at all', 'utf8')
  const forgiving = new TuanjieVisibilityStore(() => bad, silent, () => 'a:team-a')
  check('a corrupt file reads as nothing hidden', forgiving.disabled('a:team-a').length === 0)

  writeFileSync(bad, JSON.stringify({ accounts: { 'a:team-a': ['ok', 42, '', null, 'two'] } }), 'utf8')
  check('non-string ids are dropped',
    forgiving.disabled('a:team-a').join() === 'ok,two', forgiving.disabled('a:team-a').join())

  writeFileSync(bad, JSON.stringify({ accounts: 'nonsense' }), 'utf8')
  check('a malformed accounts map yields nothing', forgiving.disabled('a:team-a').length === 0)

  let threw = false
  try {
    new TuanjieVisibilityStore(() => bad, silent, () => undefined).setDisabled(undefined, ['x'])
  } catch {
    threw = true
  }
  check('writing without an account key refuses', threw)
}

console.log('\n=== 4. account key ===')
{
  check('joins user and team', visibilityAccountKeyOf(84591, 'team-a') === '84591:team-a')
  check('tolerates a missing team', visibilityAccountKeyOf(84591, undefined) === '84591:')
  check('refuses a missing user', visibilityAccountKeyOf(undefined, 'team-a') === undefined)
  check('refuses an empty user', visibilityAccountKeyOf('', 'team-a') === undefined)
  check('default path lives under .dsh', defaultVisibilityPath().includes('.dsh'),
    defaultVisibilityPath())
}

console.log('\n=== 5. the real adapter hides from the listing, not from routing ===')
{
  // Drive the plugin's actual apply() against the real host libraries, because
  // this is the behaviour that is easy to get wrong: pi-ai's own `filterModels`
  // hook is applied only on ModelsImpl.getAvailable(), which the listing path
  // never calls, so a model filtered there still shows up in the picker.
  const fixture = await import('./fixture.mjs')
  const loaded = await fixture.loadPluginIntoFixture()

  if (loaded === undefined) {
    console.log('  SKIP  the dsh-core fixture is not present (run extract-core.mjs, then grow-core.mjs)')
  } else {
    // A synthetic sign-in, so the account key — and therefore the visibility
    // file — is deterministic and the test touches no network.
    const USER_ID = 999
    const TEAM = 'team-x'
    const ACCOUNT_KEY = `${USER_ID}:${TEAM}`
    const authFile = join(dir, 'oauth_creds.json')
    const orgFile = join(dir, 'org.json')
    const visFile = join(dir, 'vis.json')

    // A structurally valid JWT (unsigned): only the payload is ever read.
    const claims = Buffer.from(JSON.stringify({ sub: String(USER_ID), exp: 4102444800 })).toString('base64url')
    writeFileSync(authFile, JSON.stringify({
      access_token: `x.${claims}.y`,
      user_id: USER_ID,
      cli_api_key: 'sk-synthetic',
    }), 'utf8')
    writeFileSync(orgFile, JSON.stringify({ accounts: { [String(USER_ID)]: { currentOrgId: TEAM } } }), 'utf8')
    writeFileSync(visFile, JSON.stringify({ accounts: { [ACCOUNT_KEY]: ['codely-vl'] } }), 'utf8')

    const registrations = []
    // Collect the disposers `apply()` registers and run them at the end. The
    // plugin's teardown closes the loopback server; leaving it open would keep
    // the event loop alive forever now that the suite ends on `exitCode`
    // instead of forcing the process down, and exercising the disposers is the
    // only teardown coverage this path gets.
    const disposers = []
    const mockCtx = {
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      llm: {
        registerAdapter(providers, adapter) {
          registrations.push({ providers, adapter })
          return () => {}
        },
      },
      get: () => undefined,
      emit: () => {},
      effect: (fn) => disposers.push(fn),
      inject: () => {},
    }

    loaded.plugin.apply(
      mockCtx,
      loaded.plugin.Config({ authFile, orgFile, visibilityFile: visFile }),
    )
    await new Promise((resolve) => setTimeout(resolve, 1200))

    const adapter = registrations[0]?.adapter
    check('the adapter registered', adapter !== undefined)

    if (adapter !== undefined) {
      check('it is the subclassed adapter', adapter.constructor.name !== 'PiAiAdapter',
        adapter.constructor.name)

      const listed = await adapter.listModels('tuanjie')
      const ids = listed.map((m) => m.id)
      check('the listing drops the hidden model', !ids.includes('codely-vl'), ids.join(','))
      check('the listing keeps the others', ids.length > 0, ids.join(','))
      check('every listed model carries an id and name', listed.every((m) => m.id && m.name))

      // The contract that keeps existing sessions alive.
      const resolved = await adapter.resolveModel('tuanjie', 'codely-vl')
      check('a hidden model still resolves', resolved?.id === 'codely-vl',
        'a session already using it would fail')
      const prepared = await adapter.prepareCall('tuanjie', 'codely-vl')
      check('a hidden model can still be called', prepared?.model?.id === 'codely-vl')

      // Un-hiding must take effect on the next listing, without a restart.
      writeFileSync(visFile, JSON.stringify({ accounts: { [ACCOUNT_KEY]: [] } }), 'utf8')
      const after = await adapter.listModels('tuanjie')
      check('clearing the preference restores the model',
        after.map((m) => m.id).includes('codely-vl'), after.map((m) => m.id).join(','))
    }

    // Teardown: `ctx.effect` stores a factory whose return value is the
    // disposer, so run both layers. This is what closes the plugin's loopback
    // server; a listening socket would otherwise keep the event loop alive and
    // the suite would hang now that it ends on `exitCode` rather than forcing
    // the process down.
    let teardownError
    try {
      for (const factory of disposers) {
        const dispose = factory()
        if (typeof dispose === 'function') await dispose()
      }
    } catch (error) {
      teardownError = error
    }
    check('the plugin disposes cleanly', teardownError === undefined, String(teardownError))
  }
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
