/**
 * Replay DSH's peer gate to pick a range that survives routine core bumps.
 *
 * dsh-app-boot checks `semver.satisfies(runtimeVersion, peerRange,
 * { includePrerelease: true })` for every `@deepseek-ai/dsh*` peer; a range the
 * running core does not satisfy makes the whole bundle incompatible. Pinning an
 * exact version means every core release trips it, so this measures the
 * candidate ranges against the versions the plugin has actually been verified
 * on.
 */
import semver from '../dsh-core/node_modules/semver/index.js'

const VERIFIED = ['0.2.0-rc.2', '0.2.1-rc.2']
const CANDIDATES = ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.2-rc.1', '0.2.5', '0.3.0-rc.1', '1.0.0']

console.log('=== how each candidate range behaves at the gate ===')
console.log(`runtime versions considered: ${CANDIDATES.join(', ')}\n`)

for (const range of ['0.2.0-rc.2', '0.2.1-rc.2', '^0.2.0-rc.2', '~0.2.0-rc.2', '>=0.2.0-rc.2 <0.3.0', '*']) {
  const row = CANDIDATES.map((v) => {
    const ok = semver.satisfies(v, range, { includePrerelease: true })
    const verified = VERIFIED.includes(v)
    return `${v}:${ok ? (verified ? 'ok' : 'ALLOW') : 'block'}`
  })
  const coversVerified = VERIFIED.every((v) => semver.satisfies(v, range, { includePrerelease: true }))
  console.log(`  ${range.padEnd(22)} ${row.join('  ')}${coversVerified ? '' : '   <-- misses a verified core'}`)
}

console.log('\n=== the chosen range ===')
const chosen = '^0.2.0-rc.2'
for (const v of VERIFIED) {
  console.log(`  verified ${v} -> ${semver.satisfies(v, chosen, { includePrerelease: true }) ? 'accepted' : 'REJECTED'}`)
}
console.log('  next minor 0.2.2-rc.1 ->', semver.satisfies('0.2.2-rc.1', chosen, { includePrerelease: true }) ? 'accepted (no gate trip)' : 'blocked')
console.log('  next major 0.3.0-rc.1 ->', semver.satisfies('0.3.0-rc.1', chosen, { includePrerelease: true }) ? 'accepted' : 'blocked (intended: a new minor line needs re-verification)')
