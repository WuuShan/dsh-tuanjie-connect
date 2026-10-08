/**
 * Tuanjie Cowork (Codely) protocol layer — credential handling, request
 * signing, model catalog, and the loopback shim.
 *
 * This module deliberately imports nothing from DSH: everything here is
 * testable against the real gateway with plain Node, and `index.js` layers the
 * provider registration on top.
 *
 * ## Why signing is required
 *
 * The gateway at `codely-litellm.tuanjie.cn` rejects a bare `x-api-key` with
 * "由于安全问题，请升级到最新版 Codely" (HTTP 401). A request is accepted only
 * when it carries both the LiteLLM virtual key (`sk-...`, minted by the control
 * plane) *and* an `X-Codely-Signature` HMAC:
 *
 *     signingKey = HMAC-SHA256(HMAC-SHA256(pepper, "codely-signing-v1"), virtualKey)
 *     signature  = "v1." + unixSeconds + "." + base64url(HMAC-SHA256(signingKey, "v1\n" + path + "\n" + unixSeconds))
 *
 * The pepper is compiled into the desktop client. The signature covers the
 * request path, so it is computed per request and must not be cached.
 *
 * @module dsh-tuanjie-connect/codely
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Control plane: sign-in, org list, and virtual-key minting. */
export const CONTROL_PLANE = 'https://codely.tuanjie.cn'

/** The LiteLLM gateway the desktop app's assistant talks to. */
export const GATEWAY = 'https://codely-litellm.tuanjie.cn'

/** User-Agent the CLI presents; keeps this plugin's traffic indistinguishable. */
export const USER_AGENT = 'codely-cli/0.0.0 (win32; x64)'

/**
 * The compiled-in secret the desktop client mixes with the per-account virtual
 * key to derive the request-signing key. Recovered from the shipped binary; it
 * is not a per-user secret and grants nothing on its own.
 */
export const SIGNING_PEPPER = Buffer.from(
  '406f00f74768ba0cb0cd30f097ec6c2bdacb89c61a38b7dd140838bbd0e98018',
  'hex',
)

/**
 * Model facts the gateway does not publish, keyed by model id.
 *
 * `/v1/models` returns ids and a display name but no window or token ceiling,
 * so the declared window comes from the app's own bundled provider config and
 * the live response is layered on top when it carries `max_model_len`/`is_vlm`.
 */
export const KNOWN_MODELS = {
  'codely-core': { name: 'GLM-5.3', contextWindow: 202752, maxTokens: 16384, images: true },
  'codely-flash': { name: 'DeepSeek-V4.1-Flash', contextWindow: 202752, maxTokens: 16384, images: true },
  'codely-basic': { name: 'DeepSeek-V4.1-Flash', contextWindow: 202752, maxTokens: 16384, images: true },
  'codely-air': { name: 'DeepSeek-V4.1-Flash', contextWindow: 202752, maxTokens: 16384, images: true },
  'codely-vl': { name: 'Vision', contextWindow: 202752, maxTokens: 16384, images: false },
}

/** Roster used before the first successful catalog fetch. */
export const FALLBACK_MODELS = Object.keys(KNOWN_MODELS)

/**
 * Reasoning levels the gateway accepts. `low`/`high`/`max` were verified
 * against every model on this route; the levels absent here are reported as
 * unavailable so the picker never offers a spelling the upstream ignores.
 */
export const SUPPORTED_EFFORTS = ['low', 'high', 'max']

/** Default location of the desktop app's credential file. */
export function defaultAuthPath() {
  const override = process.env.DSH_TUANJIE_AUTH_FILE
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), '.codely-cli', 'oauth_creds.json')
}

/** Default location of the org map that names the active team. */
export function defaultOrgPath() {
  const override = process.env.DSH_TUANJIE_ORG_FILE
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), '.codely-cli', 'org.json')
}

/** Read a JSON document, or `undefined` when it is absent or unparsable. */
export function readJson(file) {
  try {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Replace a file atomically so a crash cannot truncate a credential. */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

//#region signing

/** Derive the per-account request-signing key from the LiteLLM virtual key. */
export function deriveSigningKey(virtualKey) {
  const inner = createHmac('sha256', SIGNING_PEPPER).update('codely-signing-v1').digest()
  return createHmac('sha256', inner).update(virtualKey).digest()
}

/** Build the `X-Codely-Signature` value for one request path. */
export function signRequest(pathname, signingKey, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000))
  const mac = createHmac('sha256', signingKey)
    .update(['v1', pathname, timestamp].join('\n'))
    .digest('base64url')
  return `v1.${timestamp}.${mac}`
}

//#endregion

//#region credentials

/**
 * The desktop app's credential file, refreshed on demand.
 *
 * Reading is cheap and never throws; a sign-in that happens while DSH is
 * already running is picked up by the caller's sweep. Refresh writes back
 * through an atomic replace, because the app reads this same file.
 */
export class TuanjieCredentialStore {
  constructor(authPath, orgPath, logger) {
    this.authPath = authPath
    this.orgPath = orgPath
    this.logger = logger
    /** In-flight refresh, so concurrent 401s trigger one round trip. */
    this.pending = undefined
  }

  /** The raw credential document, or `undefined` when signed out. */
  read() {
    const raw = readJson(this.authPath())
    if (raw === undefined || typeof raw !== 'object' || raw === null) return undefined
    if (typeof raw.access_token !== 'string' || raw.access_token.length === 0) return undefined
    return raw
  }

  /** The active team id, when the app has recorded one for this account. */
  teamId(credential) {
    const userId = credential?.user_id
    if (userId === undefined || userId === null) return undefined
    const org = readJson(this.orgPath())
    const id = org?.accounts?.[String(userId)]?.currentOrgId
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }

  /**
   * Whether a stored virtual key is present, correctly shaped, and unexpired.
   *
   * The shape check matters: older builds of the desktop app wrote a different
   * `id:secret` value into this same field, and the gateway answers that with a
   * flat 401 rather than a "wrong format" error. LiteLLM virtual keys always
   * start with `sk-`, so anything else is treated as absent and re-minted.
   */
  usableKey(credential) {
    const key = credential?.cli_api_key
    if (typeof key !== 'string' || !key.startsWith('sk-') || key.length < 8) return false
    const expiry = credential?.key_expiry_date
    if (typeof expiry === 'number' && Number.isFinite(expiry) && Date.now() > expiry) return false
    return true
  }

  /**
   * A virtual key that is currently usable, minting one when necessary.
   *
   * Order: the stored key, then minting, then a token refresh followed by a
   * second mint. Every network failure surfaces as an `Error` the caller can
   * report verbatim.
   */
  async resolve() {
    const credential = this.read()
    if (credential === undefined) {
      throw new Error(
        `Tuanjie Cowork is not signed in: no usable credential at ${this.authPath()}. ` +
          'Sign in through the Tuanjie Cowork desktop app, then retry.',
      )
    }
    if (this.usableKey(credential)) return credential.cli_api_key
    return await this.refresh(credential)
  }

  /** Serialize refreshes so a burst of 401s mints one key. */
  async refresh(credential) {
    if (this.pending !== undefined) return await this.pending
    this.pending = this.performRefresh(credential).finally(() => {
      this.pending = undefined
    })
    return await this.pending
  }

  async performRefresh(credential) {
    let current = credential
    let key = await this.mint(current)

    if (key === undefined) {
      current = await this.refreshAccessToken(current)
      key = await this.mint(current)
    }
    if (key === undefined) {
      throw new Error(
        'Tuanjie Cowork: could not obtain a LiteLLM key; the stored sign-in may have expired. ' +
          'Open the Tuanjie Cowork app to sign in again.',
      )
    }

    const next = { ...current, cli_api_key: key.value, user_id: key.userId ?? current.user_id }
    if (typeof key.expiresIn === 'number') {
      next.key_expiry_date = Date.now() + key.expiresIn * 1000
    }
    try {
      writeJsonAtomic(this.authPath(), next)
    } catch (error) {
      this.logger?.warn?.(`dsh-tuanjie-connect: could not persist refreshed credential: ${error}`)
    }
    return key.value
  }

  /** Ask the control plane for a virtual key; `undefined` on auth failure. */
  async mint(credential) {
    const teamId = this.teamId(credential)
    const url = new URL('/api/api-token/cli-api-key', CONTROL_PLANE)
    if (teamId !== undefined) url.searchParams.set('teamId', teamId)
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credential.access_token}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    })
    if (response.status === 401 || response.status === 403) return undefined
    if (!response.ok) {
      throw new Error(
        `Tuanjie Cowork: minting a LiteLLM key failed (HTTP ${response.status}): ` +
          (await response.text()).slice(0, 300),
      )
    }
    const body = await response.json()
    const value = body?.cli_api_key
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Tuanjie Cowork: the key endpoint returned no cli_api_key')
    }
    return { value, userId: body?.user_id, expiresIn: undefined }
  }

  /** Exchange the refresh token for a new access token. */
  async refreshAccessToken(credential) {
    const refreshToken = credential.refresh_token
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw new Error(
        'Tuanjie Cowork: the stored credential has no refresh token. ' +
          'Sign in again through the desktop app.',
      )
    }
    const response = await fetch(new URL('/auth/refresh', CONTROL_PLANE), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!response.ok) {
      throw new Error(
        `Tuanjie Cowork: refreshing the sign-in failed (HTTP ${response.status}). ` +
          'Open the Tuanjie Cowork app to sign in again.',
      )
    }
    const body = await response.json()
    const accessToken = body?.access_token
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('Tuanjie Cowork: the refresh endpoint returned no access_token')
    }
    const next = {
      ...credential,
      access_token: accessToken,
      token_type: body.token_type ?? credential.token_type,
      refresh_token: body.refresh_token ?? refreshToken,
    }
    if (typeof body.expires_in === 'number') {
      next.expires_in = body.expires_in
      next.expiry_date = Date.now() + body.expires_in * 1000
    }
    // Drop the stale key so the next mint is not short-circuited by it.
    delete next.cli_api_key
    delete next.key_expiry_date
    try {
      writeJsonAtomic(this.authPath(), next)
    } catch (error) {
      this.logger?.warn?.(`dsh-tuanjie-connect: could not persist refreshed token: ${error}`)
    }
    return next
  }
}

//#endregion

//#region catalog

/** Merge the live gateway roster with the facts the gateway does not publish. */
export function buildCatalog(live) {
  const list = Array.isArray(live) && live.length > 0 ? live : FALLBACK_MODELS
  const seen = new Set()
  const out = []
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const published = typeof entry === 'string' ? {} : entry
    const known = KNOWN_MODELS[id] ?? {}
    const contextWindow =
      typeof published?.max_model_len === 'number' && published.max_model_len > 0
        ? published.max_model_len
        : (known.contextWindow ?? 202752)
    const images = typeof published?.is_vlm === 'boolean' ? published.is_vlm : (known.images ?? true)
    const displayName =
      known.name ?? (typeof published?.display_name === 'string' ? published.display_name : undefined)
    out.push({
      id,
      name: displayName === undefined ? id : `${id} · ${displayName}`,
      contextWindow,
      maxTokens: known.maxTokens ?? 16384,
      images,
    })
  }
  return out
}

/** Fetch the gateway's live model roster. Throws on a transport or HTTP error. */
export async function fetchModelList(virtualKey) {
  const signingKey = deriveSigningKey(virtualKey)
  const response = await fetch(`${GATEWAY}/v1/models`, {
    headers: {
      'x-api-key': virtualKey,
      Authorization: `Bearer ${virtualKey}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'X-Codely-Signature': signRequest('/v1/models', signingKey),
    },
  })
  if (!response.ok) {
    throw new Error(`model list fetch failed (HTTP ${response.status})`)
  }
  const body = await response.json()
  return Array.isArray(body?.data) ? body.data : []
}

//#endregion

//#region loopback shim

/** True when a Host header names the loopback interface. */
function hostIsLoopback(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/** True when an Origin header, if present, names a loopback origin. */
function originIsLoopback(origin) {
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    return hostIsLoopback(new URL(origin).host)
  } catch {
    return false
  }
}

/** Write a JSON response body. */
function writeJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) })
  res.end(body)
}

/** Write an OpenAI-shaped error so pi-ai can classify the failure. */
function writeOpenAIError(res, status, code, message) {
  writeJson(res, status, { error: { message, type: code, code, param: null } })
}

/** Collect a request body up to a sane ceiling. */
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * The loopback endpoint pi-ai talks to.
 *
 * Requests carry a per-run shared secret as their bearer; the loopback bind is
 * the boundary, and the upstream credential never leaves this process. The
 * shim stamps the signing headers onto each upstream request and mints a fresh
 * key when the gateway rejects the current one.
 */
export function createTuanjieShim(options) {
  const { store, logger } = options
  const sharedSecret = randomBytes(32).toString('base64url')
  const sessionId = randomUUID()

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = Buffer.from(match[1])
    const expected = Buffer.from(sharedSecret)
    if (presented.length !== expected.length) return false
    return timingSafeEqual(presented, expected)
  }

  /**
   * Forward one request to the gateway, signing it.
   *
   * A 401 or 403 means the virtual key went stale: mint a new one and replay
   * the request exactly once. The body is already buffered, so the retry does
   * not need a second read of the client stream.
   */
  async function forward(pathname, init, body, signal) {
    let key = await store.resolve()
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'x-api-key': key,
        Authorization: `Bearer ${key}`,
        'x-litellm-session-id': sessionId,
        'X-Codely-Signature': signRequest(pathname, deriveSigningKey(key)),
      }
      const response = await fetch(`${GATEWAY}${pathname}`, { ...init, headers, body, signal })
      if (response.status !== 401 && response.status !== 403) return response
      await response.arrayBuffer().catch(() => {})
      if (attempt === 1) return response
      const credential = store.read()
      if (credential === undefined) return response
      logger?.debug?.('dsh-tuanjie-connect: gateway rejected the key; minting a fresh one')
      key = await store.refresh({ ...credential, cli_api_key: undefined })
    }
    throw new Error('dsh-tuanjie-connect: unreachable retry state')
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) writeOpenAIError(res, 500, 'internal', String(error?.message ?? error))
      else res.end()
    })
  })

  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  server.listen(0, '127.0.0.1')

  /** The shim's base URL; throws before the listener is up. */
  function baseUrl() {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('dsh-tuanjie-connect: the loopback shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
      return
    }
    if (!bearerOk(req)) {
      writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
      return
    }
    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
      writeJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
      await chatCompletions(req, res)
      return
    }
    writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  }

  async function chatCompletions(req, res) {
    const controller = new AbortController()
    // Abort upstream only when the *client* goes away mid-response. Listening
    // on the request instead would fire as soon as the body is fully read,
    // killing every request before it reaches the gateway.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    const body = await readBody(req)
    const upstream = await forward('/v1/chat/completions', { method: 'POST' }, body, controller.signal)
    const headers = {}
    const contentType = upstream.headers.get('content-type')
    if (contentType !== null) headers['content-type'] = contentType
    res.writeHead(upstream.status, headers)
    if (upstream.body === null) {
      res.end()
      return
    }
    try {
      for await (const chunk of upstream.body) res.write(chunk)
    } catch (error) {
      if (!controller.signal.aborted) {
        logger?.warn?.(`dsh-tuanjie-connect: upstream stream broke: ${error}`)
      }
    }
    res.end()
  }

  return {
    sharedSecret,
    ready,
    baseUrl,
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

//#endregion
