/**
 * Replay DSH's client-package discovery against the installed profile.
 *
 * Mirrors @deepseek-ai/dsh-client-modules' scan: for each Loader entry that is
 * a bare package specifier, read its manifest, and if it declares `dsh.client`,
 * resolve exports['./client'] and check the file exists. This is the step that
 * decides whether a bundle's browser half ever reaches the page.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const profileDir = 'C:/Users/Administrator/.dsh/profiles/desktop'
const require = createRequire(join(profileDir, 'package.json'))

/** Package names the profile lists as bundles. */
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []
console.log('profile bundles:', bundles.join(', '))
console.log('')

/** The exact resolution DSH's profile loader performs for a bundle. */
function bundleDir(packageName) {
  try {
    return dirname(require.resolve(`${packageName}/package.json`))
  } catch {
    // Fall back to the literal node_modules path when exports hides package.json.
    const guess = join(profileDir, 'node_modules', packageName)
    return existsSync(join(guess, 'package.json')) ? guess : undefined
  }
}

function clientExportOf(pkgName, exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = exportsField['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null && typeof client.default === 'string') {
    return client.default
  }
  throw new Error(`${pkgName} exports["./client"] must be a string or {default: string}`)
}

let verdicts = 0
for (const name of bundles) {
  const dir = bundleDir(name)
  if (dir === undefined) {
    console.log(`${name}\n  → bundle directory NOT RESOLVABLE`)
    continue
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const decl = pkg.dsh?.client
  if (decl === undefined) {
    console.log(`${name}\n  → host-only bundle (no dsh.client)`)
    continue
  }
  verdicts++
  const rel = clientExportOf(name, pkg.exports)
  const abs = rel === undefined ? undefined : resolve(dir, rel)
  const present = abs !== undefined && existsSync(abs)

  console.log(`${name}`)
  console.log(`  dir            : ${dir}`)
  console.log(`  platform       : ${decl.platform}`)
  console.log(`  inject         : ${JSON.stringify(decl.inject ?? [])}`)
  console.log(`  exports[./client]: ${rel ?? '(MISSING)'}`)
  console.log(`  bundle file    : ${present ? 'present' : 'MISSING'}${abs ? ` (${abs})` : ''}`)
  if (present) {
    const source = readFileSync(abs, 'utf8')
    const id = /id:\s*['"]([^'"]+)['"]/.exec(source)?.[1]
    console.log(`  loader id      : ${id ?? '(none)'}`)
    console.log(`  id matches name: ${id === name}`)
  }

  // Every injected name must itself be a client package, or the browser half
  // will try to require a module that was never registered.
  for (const dep of decl.inject ?? []) {
    let depPkg
    try {
      depPkg = JSON.parse(readFileSync(join(bundleDir(dep) ?? '', 'package.json'), 'utf8'))
    } catch {
      console.log(`  inject "${dep}": NOT RESOLVABLE`)
      continue
    }
    console.log(`  inject "${dep}": ${depPkg.dsh?.client ? 'client package ok' : 'NOT a client package'}`)
  }
  console.log('')
}
console.log(`client packages found: ${verdicts}`)
