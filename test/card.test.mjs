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

// DSH finds the browser half through the package's exports map, so a missing
// "./client" entry means the card silently never loads.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('package declares an exports map', manifest.exports !== undefined)
check('exports "./client"', manifest.exports?.['./client'] === './lib/client.js',
  String(manifest.exports?.['./client']))
check('exports the root entry', manifest.exports?.['.']?.default === './lib/index.js',
  JSON.stringify(manifest.exports?.['.']))
check('declares a web client half', manifest.dsh?.client?.platform === 'web',
  JSON.stringify(manifest.dsh?.client))
check('client half is shipped in files', manifest.files?.includes('lib'), JSON.stringify(manifest.files))

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
          // Return a distinguishable marker rather than null, so a test can
          // tell "rendered an element" apart from "returned null to skip".
          return {
            jsx: (type, props) => ({ __element: true, type, props }),
            jsxs: (type, props) => ({ __element: true, type, props }),
          }
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
check('injects the bundle-config slot', injections.includes('plugins.bundle.config'), injections.join(','))
check('registers a card for it', registrations.some((r) => r.spec?.name === 'plugins.bundle.config'),
  registrations.map((r) => r.spec?.name).join(','))

// The slot name AND its filter key are the whole contract. DSH 0.2.0's Plugins
// page renders the bundle panel as:
//   renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })
// so a registration must name that slot and key itself by the bundle package
// name, or the page looks up a key nothing registered under.
const pageSlots = new Set([
  'plugins.bundle.activation',
  'plugins.bundle.config',
  'plugins.detail.actions',
  'plugins.detail.badge',
  'plugins.detail.section',
  'plugins.item',
  'plugins.row.config',
])
for (const registration of registrations) {
  check(
    `slot "${registration.spec?.name}" is one DSH actually declares`,
    pageSlots.has(registration.spec?.name) || registration.spec?.name === 'settings.plugin.item',
    registration.spec?.name,
  )
}

const config = registrations.find((r) => r.spec?.name === 'plugins.bundle.config')
check('bundle-config registration exists', config !== undefined)
check('keyed by the bundle package name', config?.spec?.key === 'dsh-tuanjie-connect',
  String(config?.spec?.key))
check('registration key equals package.json name', config?.spec?.key === manifest.name,
  `slot key=${config?.spec?.key} package name=${manifest.name}`)
check('bundle-config has a component', typeof config?.component === 'function')

console.log('\n=== 6. the card component renders ===')
// Call the component with the props the page passes. The stub React returns a
// marker element, so this proves it renders rather than throwing.
let cardError
let cardOut
try {
  cardOut = config.component({ view: 'page' })
} catch (error) {
  cardError = error
}
check('card renders without throwing', cardError === undefined, String(cardError))
check('card returns an element', cardOut?.__element === true)

console.log('\n=== 7. the route answers a secret-free document ===')
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
