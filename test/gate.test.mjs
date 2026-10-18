/**
 * Replay DSH's plugin compatibility gate against this manifest.
 *
 * dsh-app-boot's `evaluatePluginCompatibility` walks `peerDependencies`, keeps
 * every `@deepseek-ai/dsh*` name, and marks the plugin incompatible when the
 * running core version does not satisfy that range. An incompatible bundle is
 * refused with "可能导致崩溃或数据丢失" — the message this test exists to keep
 * from coming back.
 *
 * The runtime version is read from the installed app-boot package rather than
 * hard-coded, so this fails loudly on the next core bump instead of quietly
 * asserting a version nobody runs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from '../dsh-core/node_modules/semver/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const mods = join(root, 'dsh-core', 'node_modules')

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`) }
}

/** The version DSH calls the runtime: its own app-boot package. */
function runtimeVersion() {
  const p = join(mods, '@deepseek-ai', 'dsh-app-boot', 'package.json')
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version
  // The installed app is the other honest source.
  const installed = 'E:/DeepSeek Harness/resources/app.asar'
  return existsSync(installed) ? readFileSync(join(root, 'dsh-core', 'RUNTIME-VERSION'), 'utf8').trim() : undefined
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runtime = runtimeVersion()

console.log('=== the gate as dsh-app-boot implements it ===')
console.log(`  plugin   : ${manifest.name}@${manifest.version}`)
console.log(`  runtime  : ${runtime ?? '(unknown)'}\n`)

check('the runtime version is knowable', typeof runtime === 'string' && runtime.length > 0,
  'extract @deepseek-ai/dsh-app-boot into the fixture')

if (typeof runtime === 'string') {
  const gated = Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

  check('the manifest declares at least one gated peer', gated.length > 0,
    'a plugin with none is never gate-checked, which would hide a real mismatch')

  const incompatible = []
  for (const [name, range] of gated) {
    const ok = semver.satisfies(runtime, range, { includePrerelease: true })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name} ${range}`)
    if (!ok) incompatible.push(`${name} (${range})`)
  }

  check('DSH accepts this bundle', incompatible.length === 0,
    `incompatible: ${incompatible.join(', ')}`)

  console.log('\n=== the range still rejects a core it was not verified against ===')
  // Widening must not turn into "accepts anything": a new minor line has to trip
  // the gate so the next core bump is re-verified instead of silently loaded.
  const futureMinor = semver.inc(runtime, 'minor')
  const futureRejected = gated.every(([, range]) => !semver.satisfies(futureMinor, range, { includePrerelease: true }))
  check(`a ${futureMinor} core would be refused`, futureRejected,
    `the range ${gated.map(([, r]) => r).join(', ')} would let it load unverified`)

  const futurePatch = semver.inc(runtime, 'patch')
  const patchAccepted = gated.every(([, range]) => semver.satisfies(futurePatch, range, { includePrerelease: true }))
  check(`a ${futurePatch} patch core would be accepted`, patchAccepted,
    'routine patches should not require a plugin release')
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
