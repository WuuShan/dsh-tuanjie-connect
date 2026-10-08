import fs from 'node:fs'

const ASAR = 'E:/DeepSeek Harness/resources/app.asar'
const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(8)
fs.readSync(fd, head, 0, 8, 0)
const hs = head.readUInt32LE(4)
const hb = Buffer.alloc(hs)
fs.readSync(fd, hb, 0, hs, 8)
const header = JSON.parse(hb.toString('utf8', 8, hs))

/** Walk to a nested directory node by path segments. */
function nodeAt(segments) {
  let node = header
  for (const seg of segments) {
    node = node.files?.[seg]
    if (node === undefined) return undefined
  }
  return node
}

/** Read one file entry's bytes. */
function readEntry(entry) {
  if (entry === undefined || entry.files !== undefined) return undefined
  const offset = Number(entry.offset)
  if (!Number.isFinite(offset)) return undefined
  const buf = Buffer.alloc(entry.size)
  if (entry.size > 0) fs.readSync(fd, buf, 0, entry.size, 8 + hs + offset)
  return buf
}

const scopeDir = nodeAt(['dsh', 'node_modules', '@deepseek-ai'])
const clients = []
for (const [pkgDirName, pkgNode] of Object.entries(scopeDir.files)) {
  const manifest = readEntry(pkgNode.files?.['package.json'])
  if (manifest === undefined) continue
  let pkg
  try {
    pkg = JSON.parse(manifest.toString('utf8'))
  } catch {
    continue
  }
  if (pkg.dsh?.client !== undefined) {
    clients.push({ name: pkg.name ?? pkgDirName, client: pkg.dsh.client })
  }
}
clients.sort((a, b) => a.name.localeCompare(b.name))
for (const c of clients) {
  console.log(c.name.padEnd(48), JSON.stringify(c.client).slice(0, 78))
}
console.log(`\n共 ${clients.length} 个声明 dsh.client 的包`)
fs.closeSync(fd)
