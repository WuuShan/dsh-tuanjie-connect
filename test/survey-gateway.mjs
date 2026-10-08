/**
 * Probe the Codely gateway for the metadata WorkBuddy's card shows:
 * per-model rates and context windows. Reports which endpoints exist.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SEC = Buffer.from('406f00f74768ba0cb0cd30f097ec6c2bdacb89c61a38b7dd140838bbd0e98018', 'hex')
const creds = JSON.parse(readFileSync(join(homedir(), '.codely-cli', 'oauth_creds.json'), 'utf8'))
const org = JSON.parse(readFileSync(join(homedir(), '.codely-cli', 'org.json'), 'utf8'))
const teamId = org.accounts?.[String(creds.user_id)]?.currentOrgId

const minted = await fetch(
  `https://codely.tuanjie.cn/api/api-token/cli-api-key?teamId=${encodeURIComponent(teamId)}`,
  { headers: { Authorization: `Bearer ${creds.access_token}`, Accept: 'application/json' } },
)
const vk = (await minted.json()).cli_api_key

const inner = crypto.createHmac('sha256', SEC).update('codely-signing-v1').digest()
const signingKey = crypto.createHmac('sha256', inner).update(vk).digest()

function sign(path) {
  const ts = String(Math.floor(Date.now() / 1000))
  const mac = crypto.createHmac('sha256', signingKey).update(['v1', path, ts].join('\n')).digest('base64url')
  return `v1.${ts}.${mac}`
}

const paths = [
  '/v1/model/info',
  '/model/info',
  '/v1/model_group/info',
  '/model_group/info',
  '/v1/models',
  '/spend/logs',
  '/v1/model/group/info',
  '/v1/model/access_group',
  '/key/info',
]

console.log('=== gateway metadata endpoints ===')
for (const path of paths) {
  try {
    const res = await fetch(`https://codely-litellm.tuanjie.cn${path}`, {
      headers: { 'x-api-key': vk, 'X-Codely-Signature': sign(path), Accept: 'application/json' },
    })
    const text = await res.text()
    console.log(`[${res.status}] ${path}`)
    if (res.ok) console.log(`        ${text.slice(0, 600).replace(/\s+/g, ' ')}`)
    else console.log(`        ${text.slice(0, 140).replace(/\s+/g, ' ')}`)
  } catch (error) {
    console.log(`[ERR] ${path} :: ${error.message}`)
  }
}
