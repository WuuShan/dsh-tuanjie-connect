/**
 * Survey what the Codely control plane can actually supply for a rich card.
 *
 * Answers, with live calls, which of the WorkBuddy card's three tabs have a
 * data source here: quota pools (积分详情), per-model rates (上下文窗口), and
 * anything else the endpoints carry that the current card ignores.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONTROL = 'https://codely.tuanjie.cn'
const creds = JSON.parse(readFileSync(join(homedir(), '.codely-cli', 'oauth_creds.json'), 'utf8'))
const org = JSON.parse(readFileSync(join(homedir(), '.codely-cli', 'org.json'), 'utf8'))
const teamId = org.accounts?.[String(creds.user_id)]?.currentOrgId

async function get(pathname, token = creds.access_token) {
  const res = await fetch(new URL(pathname, CONTROL), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json, text }
}

console.log('=== 1. usage summary: the full document ===')
const usage = await get('/api/user/usage/summary')
console.log(JSON.stringify(usage.json, null, 2))

console.log('\n=== 2. does it carry per-pool quota (used/quota)? ===')
const details = usage.json?.details ?? []
console.log(`pools: ${details.length}`)
for (const d of details) {
  console.log('  ', JSON.stringify(d))
}

console.log('\n=== 3. candidate endpoints for models / rates ===')
const candidates = [
  '/api/user/usage/summary',
  '/api/user/usage',
  '/api/models',
  '/api/user/models',
  '/api/api-token/models',
  '/api/litellm/models',
  '/api/user/quota',
  '/api/team/models',
  '/api/user/rate-limits',
]
for (const path of candidates) {
  const r = await get(path)
  const head = r.text.slice(0, 110).replace(/\s+/g, ' ')
  console.log(`  [${r.status}] ${path} :: ${head}`)
}

console.log('\n=== 4. what /auth/external/me carries ===')
const me = await get('/auth/external/me')
console.log(JSON.stringify(me.json, null, 2))
