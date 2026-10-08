/**
 * Load the plugin with the real host libraries.
 *
 * Node resolves a bare specifier by walking up from the importing file, so a
 * plugin sitting at `<plugin>/lib/index.js` cannot see `<plugin>/dsh-core/
 * node_modules`. Installing a copy inside the fixture is what makes
 * `@deepseek-ai/dsh-llm` and friends resolve — the same layout the DSH profile
 * loader produces.
 *
 * Returns `undefined` when the fixture is absent, so callers can skip instead
 * of failing on a machine that never built it.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fixtureModules = join(root, 'dsh-core', 'node_modules')

/** True when the fixture holds the packages the plugin imports. */
export function fixturePresent() {
  return (
    existsSync(join(fixtureModules, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')) &&
    existsSync(join(fixtureModules, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')) &&
    existsSync(join(fixtureModules, '@earendil-works', 'pi-ai', 'dist', 'index.js'))
  )
}

/** Install the plugin under test into the fixture and import it. */
export async function loadPluginIntoFixture() {
  if (!fixturePresent()) return undefined
  const installed = join(fixtureModules, 'dsh-tuanjie-connect')
  rmSync(installed, { recursive: true, force: true })
  mkdirSync(installed, { recursive: true })
  cpSync(join(root, 'lib'), join(installed, 'lib'), { recursive: true })
  copyFileSync(join(root, 'package.json'), join(installed, 'package.json'))
  const plugin = await import(pathToFileURL(join(installed, 'lib', 'index.js')).href)
  return { plugin, installed }
}
