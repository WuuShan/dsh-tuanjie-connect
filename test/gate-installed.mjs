/**
 * Run DSH's compatibility gate against the plugin as actually installed.
 *
 * The fixture-based gate test checks the repository manifest; this checks the
 * copy DSH will load, which is what the warning is about. A profile plugin is
 * refused when any `@deepseek-ai/dsh*` peer range rejects the running core
 * version.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from '../dsh-core/node_modules/semver/index.js'

const installed = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules'
const runtime = JSON.parse(
  readFileSync(join(process.argv[2], 'dsh-core', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), 'utf8'),
).version

console.log(`runtime core: ${runtime}\n`)

/** Every installed profile plugin that declares a gated peer. */
const profile = JSON.parse(
  readFileSync('C:/Users/Administrator/.dsh/profiles/desktop/package.json', 'utf8'),
)
const names = Object.keys(profile.dependencies ?? {})

let refused = 0
for (const name of names) {
  const manifestPath = join(installed, name, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const gated = Object.entries(manifest.peerDependencies ?? {}).filter(
    ([dep]) => dep === '@deepseek-ai/dsh' || dep.startsWith('@deepseek-ai/dsh-'),
  )
  if (gated.length === 0) continue

  const bad = gated.filter(([, range]) => !semver.satisfies(runtime, range, { includePrerelease: true }))
  const label = `${manifest.name}@${manifest.version}`
  if (bad.length === 0) {
    console.log(`  ok    ${label}`)
  } else {
    refused++
    console.log(`  DENIED ${label}`)
    for (const [dep, range] of bad) console.log(`           ${dep} ${range} — ${runtime} does not satisfy`)
  }
}

console.log(`\n=== ${refused === 0 ? 'every installed plugin passes the gate' : `${refused} plugin(s) refused`} ===`)
process.exitCode = refused === 0 ? 0 : 1
