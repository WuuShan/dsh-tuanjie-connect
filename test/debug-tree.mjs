/** Dump the ModelsTab tree to see where the checkbox went. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const previousWindow = globalThis.window
let exported
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      exported = factory((name) => {
        if (name === 'react') {
          return {
            Fragment: Symbol('Fragment'),
            useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
            useEffect: () => {},
            useCallback: (fn) => fn,
            createElement: (type, config, ...children) => ({
              __element: true, type,
              key: config && config.key,
              props: config ?? {}, children,
            }),
          }
        }
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
}
await import(`file://${join(root, 'lib', 'client.js').replace(/\\/g, '/')}`)
globalThis.window = previousWindow

const models = [
  { id: 'codely-core', name: 'core', contextWindow: 1048576, images: true },
  { id: 'codely-vl', name: 'vl', contextWindow: 202752, images: false },
]

let error
let out
try {
  out = exported.ModelsTab({ models, hidden: [], onToggle: () => {} })
} catch (e) {
  error = e
}
console.log('render error:', error?.message ?? 'none')

function dump(node, depth) {
  if (node === null || node === undefined || depth > 8) return
  if (Array.isArray(node)) { for (const c of node) dump(c, depth); return }
  if (typeof node !== 'object' || !node.__element) { if (typeof node === 'string' && node.trim()) console.log('  '.repeat(depth) + JSON.stringify(node.slice(0, 40))); return }
  console.log('  '.repeat(depth) + `<${typeof node.type === 'function' ? node.type.name : node.type}>`)
  dump(node.children, depth + 1)
  if (node.props?.children !== undefined && node.props.children !== node.children) dump(node.props.children, depth + 1)
}
dump(out, 0)
