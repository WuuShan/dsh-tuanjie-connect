/**
 * Card-layer checks: the host's status route and the client bundle contract.
 *
 * The client half is a prebuilt browser bundle, so it is validated by executing
 * it against a stubbed `window.__ModuleLoader__` and inspecting what it
 * registers — that catches the mistakes a syntax check cannot (wrong slot name,
 * wrong card key, missing exports).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

console.log('\n=== 1. the host mounts the route the card reads ===')
const hostSource = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

const routePath = /STATUS_ROUTE_PATH = '([^']+)'/.exec(hostSource)?.[1]
const clientPath = /STATUS_PATH = '([^']+)'/.exec(clientSource)?.[1]
check('host declares a status route', typeof routePath === 'string', String(routePath))
check('client reads the same path', routePath === clientPath, `host=${routePath} client=${clientPath}`)
check('route is namespaced under the bundle', routePath === '/plugins/dsh-tuanjie-connect/status', String(routePath))

console.log('\n=== 2. host registers it on the web server ===')
check('injects the webServer service', hostSource.includes("ctx.inject(['webServer']"))
check('uses an exact-path registration', hostSource.includes("kind: 'exact'"))
check('disposes the route with the plugin', /ctx\.effect\(\(\) => \(\) => dispose\(\)\)/.test(hostSource))
check('route is mounted, not a hard dependency', !hostSource.includes("inject = ['llm', 'webServer']"))

console.log('\n=== 3. the client bundle is well-formed ===')
check('declares the module loader call', clientSource.includes('window.__ModuleLoader__.load('))
check('declares its bundle id', clientSource.includes("id: 'dsh-tuanjie-connect'"))
check('requires react from the host', clientSource.includes("require('react')"))
check('requires the jsx runtime from the host', clientSource.includes("require('react/jsx-runtime')"))
check('imports nothing else from npm', !/require\(['"](?!react)/.test(clientSource))

console.log('\n=== 4. executing the bundle against a stubbed loader ===')
/** Capture what the bundle does when the host loads it. */
const registrations = []
const injections = []
let exported

const stubSlots = {
  inject(slotName, fn) {
    injections.push(slotName)
    return fn()
  },
  register(spec, component) {
    registrations.push({ spec, component })
    return () => {}
  },
}
const stubCtx = { slots: stubSlots }

const previousWindow = globalThis.window
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      exported = factory((name) => {
        if (name === 'react') {
          return {
            Fragment: Symbol('Fragment'),
            useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
            useEffect: () => {},
            useCallback: (fn) => fn,
            createElement: () => null,
          }
        }
        if (name === 'react/jsx-runtime') {
          return { jsx: () => null, jsxs: () => null }
        }
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
}

let execError
try {
  await import(`file://${join(root, 'lib', 'client.js').replace(/\\/g, '/')}`)
} catch (error) {
  execError = error
}
globalThis.window = previousWindow

check('bundle executes without throwing', execError === undefined, String(execError))
check('bundle exports a name', typeof exported?.name === 'string', String(exported?.name))
check('bundle exports apply()', typeof exported?.apply === 'function')
check('bundle declares its inject list', Array.isArray(exported?.inject), JSON.stringify(exported?.inject))
check('bundle names the bundle', exported?.BUNDLE_NAME === 'dsh-tuanjie-connect', String(exported?.BUNDLE_NAME))

console.log('\n=== 5. what apply() registers ===')
let applyError
try {
  exported.apply(stubCtx)
} catch (error) {
  applyError = error
}
check('apply() does not throw', applyError === undefined, String(applyError))
check('injects the settings slot', injections.includes('settings.plugin.item'), injections.join(','))
check('registers exactly one card', registrations.length === 1, String(registrations.length))
check('card targets settings.plugin.item', registrations[0]?.spec?.name === 'settings.plugin.item',
  JSON.stringify(registrations[0]?.spec))
check('card key matches the host section id', registrations[0]?.spec?.key === 'tuanjie',
  String(registrations[0]?.spec?.key))
check('card has a component', typeof registrations[0]?.component === 'function')

console.log('\n=== 6. the route answers a secret-free document ===')
// Exercise the handler shape the host registers, with the real collectStatus.
const { collectStatus } = await import(
  new URL('../lib/codely.js', import.meta.url).href
)
const status = await collectStatus({ version: 'test' })
const serialized = JSON.stringify(status)
check('payload has a state', typeof status.state === 'string', status.state)
check('payload carries no JWT', !/eyJ[A-Za-z0-9_-]{10,}/.test(serialized))
check('payload carries no sk- key', !/sk-[A-Za-z0-9_-]{8,}/.test(serialized))
check('payload names the account', status.username !== undefined, String(status.username))

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
