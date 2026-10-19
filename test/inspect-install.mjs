import fs from 'node:fs'
import path from 'node:path'

const d = process.argv[2]
const codely = fs.readFileSync(path.join(d, 'lib', 'codely.js'), 'utf8')
const client = fs.readFileSync(path.join(d, 'lib', 'client.js'), 'utf8')
const host = fs.readFileSync(path.join(d, 'lib', 'index.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'))

let ok = 0
let bad = 0
function t(label, present) {
  if (present) { ok++; console.log(`  ok    ${label}`) } else { bad++; console.log(`  MISS  ${label}`) }
}

console.log(`installed: ${pkg.name}@${pkg.version}\n`)
console.log('=== transport fixes (v0.1.11) ===')
t('pipeline forwards with backpressure', codely.includes('Readable.fromWeb'))
t('mid-stream failure aborts instead of res.end()', codely.includes('res.destroy(error)'))
t('control-plane calls carry a 30s timeout', codely.includes('AbortSignal.timeout(30000)'))
t('late 401 reuses an already-rotated key', codely.includes('if (currentKey !== key)'))
t('quotaPoints guards empty/illegal values', codely.includes('function quotaPoints'))
t('SSE headers flushed immediately', codely.includes('res.flushHeaders()'))
t('gateway asked for identity encoding', codely.includes('identity'))
t('SSE marked no-transform / no buffering', codely.includes('x-accel-buffering'))
t('Retry-After passed through', codely.includes('retry-after'))

console.log('\n=== quota display ===')
t('read-only /quota route', host.includes('QUOTA_ROUTE_PATH'))
t('catalog poll has a single-flight guard', host.includes('if (stopped || catalogRefresh) return'))
t('card reads the quota route', client.includes('QUOTA_PATH'))
t('card skips polling while hidden', client.includes('document.hidden'))
t('card guards overlap and timeout', client.includes('pending') && client.includes('15000'))

console.log('\n=== earlier work still present ===')
t('createElement (not jsx-runtime)', client.includes('react.createElement'))
t('registers plugins.bundle.config', client.includes('plugins.bundle.config'))
t('checkbox asks for the flipped state', client.includes('props.onToggle(model.id, !isHidden)'))
t('listModels subclass hides from the picker', host.includes('class TuanjiePiAiAdapter'))
t('visibility store present', codely.includes('class TuanjieVisibilityStore'))
t('peer range widened', String(pkg.peerDependencies['@deepseek-ai/dsh-llm']).startsWith('^'))
t('test:offline script shipped', typeof pkg.scripts?.['test:offline'] === 'string')

console.log(`\n=== ${bad === 0 ? `all ${ok} present` : `${bad} missing of ${ok + bad}`} ===`)
process.exitCode = bad === 0 ? 0 : 1
