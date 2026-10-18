/**
 * Compatibility audit against the host core that is actually installed.
 *
 * The plugin pins peer versions, and a core bump is exactly when that pin has
 * to be re-earned rather than re-stated: every private API the plugin imports
 * is checked here against the new packages, so a bump that looks like a version
 * edit is really a verification.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mods = join(here, '..', 'dsh-core', 'node_modules')

let problems = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok    ${label}`)
  else { problems++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

function manifest(name) {
  const p = join(mods, name, 'package.json')
  if (!existsSync(p)) return undefined
  return JSON.parse(readFileSync(p, 'utf8'))
}
function source(relative) {
  const p = join(mods, relative)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

console.log('=== installed host versions ===')
for (const name of [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/schemastery',
  '@earendil-works/pi-ai',
  '@deepseek-ai/cordis',
]) {
  const m = manifest(name)
  console.log(`  ${name.padEnd(34)} ${m?.version ?? '(absent)'}`)
}

console.log('\n=== 1. dsh-llm still exports what the plugin imports ===')
{
  const src = source('@deepseek-ai/dsh-llm/lib/index.js')
  check('dsh-llm/lib/index.js present', src.length > 0)
  for (const symbol of ['resolveRetryPolicy', 'resolveImageAttachmentAccess', 'LlmAdapter']) {
    check(`exports ${symbol}`, src.includes(symbol), 'not found in the bundle')
  }
  const m = manifest('@deepseek-ai/dsh-llm')
  check('peer version matches the installed core', m?.version === '0.2.1-rc.2', String(m?.version))
}

console.log('\n=== 2. dsh-llm-pi-ai still exports PiAiAdapter ===')
{
  const src = source('@deepseek-ai/dsh-llm-pi-ai/lib/index.js')
  check('dsh-llm-pi-ai/lib/index.js present', src.length > 0)
  check('exports PiAiAdapter', src.includes('PiAiAdapter'))
  const m = manifest('@deepseek-ai/dsh-llm-pi-ai')
  check('peer version matches the installed core', m?.version === '0.2.1-rc.2', String(m?.version))
}

console.log('\n=== 3. pi-ai 1.x still has the entry points the plugin uses ===')
{
  const index = source('@earendil-works/pi-ai/dist/index.js')
  check('pi-ai/dist/index.js present', index.length > 0)
  const models = source('@earendil-works/pi-ai/dist/models.js')
  check('createProvider still exported', models.includes('export function createProvider'))
  const lazy = source('@earendil-works/pi-ai/dist/api/openai-completions.lazy.js')
  check('openai-completions.lazy.js still ships', lazy.length > 0, 'the deep import path must exist')
  check('it still exports openAICompletionsApi', lazy.includes('openAICompletionsApi'), lazy.trim().slice(0, 120))
}

console.log('\n=== 4. the listing path the visibility filter hooks ===')
{
  // The plugin subclasses PiAiAdapter and overrides listModels. That only works
  // while the adapter exposes it, and while `getModel` keeps resolving through
  // the unfiltered roster.
  const adapter = source('@deepseek-ai/dsh-llm-pi-ai/lib/index.js')
  check('PiAiAdapter declares listModels', /listModels\s*\(/.test(adapter))
  check('PiAiAdapter declares resolveModel', /resolveModel\s*\(/.test(adapter))
  check('PiAiAdapter declares prepareCall', /prepareCall\s*\(/.test(adapter))

  const models = source('@earendil-works/pi-ai/dist/models.js')
  check('getModel resolves via getModels (unfiltered)', /getModel\(provider, id\)\s*\{\s*return this\.getModels\(provider\)\.find/.test(models),
    'if this changed, hiding a model could break resolvable ids')
  check('filterModels is still only applied off the listing path', models.includes('filterModels?.('))
}

console.log('\n=== 5. the host seams the plugin registers through ===')
{
  const adapter = source('@deepseek-ai/dsh-llm-pi-ai/lib/index.js')
  check('pi-ai adapter profile carries piProvider', adapter.includes('piProvider'))
  const llm = source('@deepseek-ai/dsh-llm/lib/index.js')
  check('llm service registers adapters', llm.includes('registerAdapter('))
  check('llm emits adapters-updated', llm.includes('llm/adapters-updated'))
}

console.log('\n=== 6. the Plugins page still renders the slot the card registers into ===')
{
  // The card is registered under `plugins.bundle.config`, keyed by the bundle
  // package name. A slot rename would leave the card loaded but invisible, so
  // check the page's own bundle for the name and its key filter.
  const page = source('@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js')
  if (page.length === 0) {
    console.log('  skip  the plugin page bundle is not in the fixture')
  } else {
    check('slot plugins.bundle.config still declared',
      page.includes('"plugins.bundle.config"'), 'the card would load but never render')
    check('it is still rendered with an entryKey filter',
      /renderSlot\("plugins\.bundle\.config"[^)]*entryKey/.test(page),
      'the key must remain the bundle package name')
    check('exports["./client"] is still how a client half is found',
      page.includes('__ModuleLoader__.load('))
  }
}

console.log(`\n=== RESULT: ${problems === 0 ? 'all seams intact' : `${problems} problem(s)`} ===`)
process.exit(problems === 0 ? 0 : 1)
