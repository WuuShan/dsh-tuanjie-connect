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
// The card is written in createElement style. Aliasing the jsx-runtime `jsx`
// here is the bug that crashed it: the two have different signatures.
check('uses createElement, not the jsx runtime',
  clientSource.includes('react.createElement') && !clientSource.includes("require('react/jsx-runtime')"))
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

/**
 * A faithful-enough React stub.
 *
 * The important part is `createElement` reproducing React's real signature and
 * its `config.key` access: the previous stub returned null for everything, so a
 * component that passed children in the wrong position — which is exactly what
 * happened when this file aliased the jsx-runtime `jsx` as `createElement` —
 * still "passed". React threw on `config.key` for a null props object, and the
 * card died inside its error boundary.
 */
function createElementStub(type, config, ...children) {
  // Reproduce React's own key read, so a null config throws here too.
  const key = config === null || config === undefined ? undefined : config.key
  if (config !== null && config !== undefined && typeof config !== 'object') {
    throw new Error('createElement: config must be an object or null')
  }
  return { __element: true, type, key, props: config ?? {}, children }
}

const previousWindow = globalThis.window
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      exported = factory((name) => {
        if (name === 'react') {
          return {
            Fragment: Symbol('Fragment'),
            // These components are rendered by calling them directly, so state
            // reads back its initial value; the status body — the branch that
            // actually reads the fetched document — is exported and rendered on
            // its own rather than driven through a fetch.
            useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
            useEffect: () => {},
            useCallback: (fn) => fn,
            createElement: createElementStub,
          }
        }
        if (name === 'react/jsx-runtime') {
          return {
            jsx: (type, props, key) => ({ __element: true, type, key, props, children: [] }),
            jsxs: (type, props, key) => ({ __element: true, type, key, props, children: [] }),
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

// Walk the produced tree. A card whose children were passed in the wrong
// position renders "successfully" at the top level while its nested components
// receive null props, so the top-level check above is not enough.
const tree = []
function walk(node, depth) {
  if (node === null || node === undefined || depth > 6) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, depth)
    return
  }
  if (typeof node !== 'object') return
  if (node.__element) {
    tree.push(node)
    walk(node.children, depth + 1)
    if (node.props?.children !== undefined) walk(node.props.children, depth + 1)
  }
}
walk(cardOut, 0)
check('the tree contains nested elements', tree.length > 1, `${tree.length} elements`)
check('no element received null props',
  tree.every((n) => n.props !== null && typeof n.props === 'object'),
  JSON.stringify(tree.filter((n) => n.props === null).map((n) => String(n.type)).slice(0, 3)))
check('no element keyed by a string child',
  tree.every((n) => n.key === undefined || typeof n.key === 'string'),
  JSON.stringify(tree.filter((n) => n.key !== undefined).map((n) => String(n.key)).slice(0, 3)))

// The status body is the branch that reads the fetched document, and it only
// appears after the fetch resolves — which this stub never does. Render it
// directly instead: this is the code path whose children were passed in the
// wrong position and crashed the card inside React.
check('bundle exports StatusBody for testing', typeof exported.StatusBody === 'function')

const sample = {
  state: 'signed-in',
  username: 'WuuShan',
  email: 'u@example.com',
  accessTokenExpires: new Date(Date.now() + 86400000).toISOString(),
  accessTokenDaysLeft: 1,
  account: { remainingPoints: 9948, buckets: [{ type: 'gift_credit', remainingPoints: 9948 }] },
  modelKey: { state: 'ready' },
}

/** Render one status body and walk everything it produced. */
function renderBody(status) {
  let error
  let out
  try {
    out = exported.StatusBody({ status })
  } catch (caught) {
    error = caught
  }
  const nodes = []
  walk(out, 0)
  if (out !== undefined) nodes.push(out)
  return { error, out, nodes: nodes.filter((n) => n?.__element) }
}

const signedIn = renderBody(sample)
check('signed-in body renders without throwing', signedIn.error === undefined, String(signedIn.error))
check('signed-in body produces elements', signedIn.nodes.length > 0, `${signedIn.nodes.length}`)
check('signed-in body has no null props',
  signedIn.nodes.every((n) => n.props !== null && typeof n.props === 'object'))
check('signed-in body names the account',
  signedIn.nodes.some((n) => JSON.stringify(n.children ?? []).includes('WuuShan')))

// The four states the card must survive.
for (const state of [
  { state: 'signed-out', hint: 'sign in' },
  { state: 'error', hint: 'rejected', error: 'HTTP 401' },
  { state: 'quota-exhausted', username: 'u', account: { remainingPoints: 0, buckets: [] }, modelKey: {} },
  { state: 'signed-in', username: 'u', account: { remainingPoints: 5, buckets: [] }, modelKey: { state: 'unavailable' } },
]) {
  const rendered = renderBody(state)
  check(`"${state.state}" body renders`, rendered.error === undefined, String(rendered.error))
  check(`"${state.state}" body has no null props`,
    rendered.nodes.every((n) => n.props !== null && typeof n.props === 'object'))
}

console.log('\n=== 7. the other two tabs render ===')
check('bundle exports ModelsTab', typeof exported.ModelsTab === 'function')
check('bundle exports QuotaTab', typeof exported.QuotaTab === 'function')

/** Render any tab component and walk its tree. */
function renderTab(component, props) {
  let error
  let out
  try {
    out = component(props)
  } catch (caught) {
    error = caught
  }
  const nodes = []
  walk(out, 0)
  if (out !== undefined) nodes.push(out)
  return { error, out, nodes: nodes.filter((n) => n?.__element) }
}

const models = [
  { id: 'codely-core', name: 'codely-core · GLM-5.3', contextWindow: 1048576, maxTokens: 16384, images: true },
  { id: 'codely-vl', name: 'codely-vl · Vision', contextWindow: 202752, maxTokens: 16384, images: false },
]
const modelsTab = renderTab(exported.ModelsTab, { models })
check('models tab renders', modelsTab.error === undefined, String(modelsTab.error))
check('models tab produces elements', modelsTab.nodes.length > 0, `${modelsTab.nodes.length}`)
check('models tab has no null props',
  modelsTab.nodes.every((n) => n.props !== null && typeof n.props === 'object'))

const emptyModels = renderTab(exported.ModelsTab, { models: undefined })
check('models tab survives a missing roster', emptyModels.error === undefined, String(emptyModels.error))

const quotaTab = renderTab(exported.QuotaTab, {
  account: { remainingPoints: 9948, exhausted: false, buckets: [{ type: 'gift_credit', remainingPoints: 9948 }] },
})
check('quota tab renders', quotaTab.error === undefined, String(quotaTab.error))
check('quota tab has no null props',
  quotaTab.nodes.every((n) => n.props !== null && typeof n.props === 'object'))

const quotaEmpty = renderTab(exported.QuotaTab, { account: { remainingPoints: 0, buckets: [] } })
check('quota tab survives an empty pool list', quotaEmpty.error === undefined, String(quotaEmpty.error))
const quotaMissing = renderTab(exported.QuotaTab, { account: undefined })
check('quota tab survives a missing account', quotaMissing.error === undefined, String(quotaMissing.error))
const quotaError = renderTab(exported.QuotaTab, {
  account: { remainingPoints: undefined, buckets: [], quotaError: 'HTTP 500' },
})
check('quota tab surfaces a quota error', quotaError.error === undefined, String(quotaError.error))

console.log('\n=== 8. the route answers a secret-free document ===')
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
