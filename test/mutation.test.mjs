/**
 * Mutation checks: prove the suites reject the defects they exist to catch.
 *
 * A test that passes against broken code proves nothing. Each case injects a
 * real defect that shipped or nearly shipped, runs the suite that should object,
 * and requires it to fail. The source is restored either way.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/**
 * Run one suite and report whether its own assertions passed.
 *
 * Deliberately keyed on the suite's RESULT line rather than its exit code:
 * Node on Windows can exit non-zero after a clean run because of a pending
 * libuv handle, and treating that as a failure would make every mutation look
 * like it was caught.
 */
function runSuite(name) {
  let out = ''
  try {
    out = execFileSync(process.execPath, [join(here, name)], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    })
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const m = /RESULT: (\d+) passed, (\d+) failed/.exec(out)
  if (m === null) return { passed: false, summary: '(no result line — the suite crashed)', out }
  return { passed: Number(m[2]) === 0, summary: m[0], out }
}

const CASES = [
  {
    name: 'card: jsx-runtime `jsx` aliased as the element factory',
    file: 'lib/client.js',
    from: 'let h = react.createElement',
    to: "let h = require('react/jsx-runtime').jsx",
    suite: 'card.test.mjs',
  },
  {
    name: 'card: slot registered under a name the page never renders',
    file: 'lib/client.js',
    from: "ctx.slots.inject('plugins.bundle.config'",
    to: "ctx.slots.inject('plugins.nonexistent.slot'",
    suite: 'card.test.mjs',
  },
  {
    name: 'visibility: hide by filtering the provider instead of the listing',
    file: 'lib/index.js',
    from: 'async listModels(provider) {',
    // Filtering the provider's own models removes the id from resolution too,
    // so a session already using a hidden model dies with UNKNOWN_MODEL — the
    // exact failure the suite's "still resolves" checks exist for.
    to: 'async mutatedListModels(provider) {',
    suite: 'visibility.test.mjs',
  },
]

let problems = 0
for (const testCase of CASES) {
  const path = join(root, testCase.file)
  const original = readFileSync(path, 'utf8')
  const backup = `${path}.mutation-backup`

  if (!original.includes(testCase.from)) {
    console.log(`SKIP  ${testCase.name} — anchor not found in ${testCase.file}`)
    continue
  }
  if (original.includes(testCase.to) && !original.includes(testCase.from)) {
    console.log(`SKIP  ${testCase.name} — already mutated`)
    continue
  }

  copyFileSync(path, backup)
  try {
    console.log(`\n=== ${testCase.name} ===`)
    const healthy = runSuite(testCase.suite)
    if (!healthy.passed) {
      console.log(`  FAIL  ${testCase.suite} does not pass on the intact source (${healthy.summary})`)
      problems++
      continue
    }
    console.log(`  ok    ${testCase.suite} passes intact (${healthy.summary})`)

    writeFileSync(path, original.replace(testCase.from, testCase.to), 'utf8')
    const mutated = runSuite(testCase.suite)
    if (mutated.passed) {
      console.log(`  FAIL  ${testCase.suite} still passed against the defect (${mutated.summary})`)
      problems++
    } else {
      console.log(`  ok    ${testCase.suite} rejected the defect (${mutated.summary})`)
      for (const line of mutated.out.split('\n').filter((l) => l.includes('FAIL')).slice(0, 3)) {
        console.log(`          ${line.trim()}`)
      }
    }
  } finally {
    copyFileSync(backup, path)
    rmSync(backup, { force: true })
  }
}

console.log('\n=== restored files are intact ===')
for (const file of new Set(CASES.map((c) => c.file))) {
  const text = readFileSync(join(root, file), 'utf8')
  const damaged = CASES.filter((c) => c.file === file).some((c) => text.includes(c.to))
  console.log(`  ${damaged ? 'FAIL' : 'ok  '}  ${file}`)
  if (damaged) problems++
}

console.log(`\n=== MUTATION RESULT: ${problems === 0 ? 'all cases behaved' : `${problems} problem(s)`} ===`)
process.exit(problems === 0 ? 0 : 1)
