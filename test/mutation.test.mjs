/**
 * Prove the card tests actually catch the bug that crashed the card.
 *
 * Injects the original defect (aliasing the jsx-runtime `jsx` as the element
 * factory) into a copy of client.js, points the suite at that copy, and
 * requires the suite to fail. A test that passes against the broken code is
 * worth nothing — this is the assertion that was missing the first time.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const good = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

const BROKEN = "let h = require('react/jsx-runtime').jsx"
const GOOD = 'let h = react.createElement'

if (!good.includes(GOOD)) {
  console.error(`ABORT: client.js no longer contains the expected line:\n  ${GOOD}`)
  process.exit(2)
}

const broken = good.replace(GOOD, BROKEN)
if (broken === good) {
  console.error('ABORT: the injection did not change the source')
  process.exit(2)
}

const backup = join(root, 'lib', 'client.js.mutation-backup')
copyFileSync(join(root, 'lib', 'client.js'), backup)

/** Run the card suite and report whether it passed. */
function runSuite() {
  try {
    const out = execFileSync(process.execPath, [join(here, 'card.test.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const m = /RESULT: (\d+) passed, (\d+) failed/.exec(out)
    return { passed: true, summary: m ? m[0] : '(no summary)', out }
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    const m = /RESULT: (\d+) passed, (\d+) failed/.exec(out)
    return { passed: false, summary: m ? m[0] : '(crashed)', out }
  }
}

let failures = 0
try {
  console.log('=== 1. the suite passes on the correct source ===')
  const healthy = runSuite()
  console.log(`  ${healthy.passed ? 'PASS' : 'FAIL'}  ${healthy.summary}`)
  if (!healthy.passed) failures++

  console.log('\n=== 2. the suite FAILS on the injected bug ===')
  writeFileSync(join(root, 'lib', 'client.js'), broken, 'utf8')
  const mutated = runSuite()
  if (mutated.passed) {
    console.log(`  FAIL  the suite still passed against broken code (${mutated.summary})`)
    failures++
  } else {
    console.log(`  PASS  the suite rejected the broken code (${mutated.summary})`)
  }
  const failing = mutated.out
    .split('\n')
    .filter((line) => line.includes('FAIL'))
    .slice(0, 4)
  for (const line of failing) console.log(`        ${line.trim()}`)
} finally {
  copyFileSync(backup, join(root, 'lib', 'client.js'))
  rmSync(backup, { force: true })
}

console.log('\n=== 3. source restored ===')
const restored = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const ok = restored.includes(GOOD) && !restored.includes(BROKEN)
console.log(`  ${ok ? 'PASS' : 'FAIL'}  client.js is back to the correct form`)
if (!ok) failures++

console.log(`\n=== MUTATION RESULT: ${failures === 0 ? 'ok' : `${failures} problem(s)`} ===`)
process.exit(failures === 0 ? 0 : 1)
