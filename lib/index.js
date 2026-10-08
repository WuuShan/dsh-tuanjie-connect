/**
 * dsh-tuanjie-connect — bring Tuanjie Cowork (Codely) models into DeepSeek Harness.
 *
 * This file is only the DSH seam: it registers a `tuanjie` provider, points it
 * at the plugin's loopback shim, and keeps the model roster current. Everything
 * protocol-specific lives in `./codely.js`, which imports nothing from DSH and
 * is testable against the real gateway with plain Node.
 *
 * @module dsh-tuanjie-connect
 */
import z from '@deepseek-ai/schemastery'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  FALLBACK_MODELS,
  SUPPORTED_EFFORTS,
  TuanjieCredentialStore,
  TuanjieVisibilityStore,
  buildCatalog,
  collectStatus,
  createTuanjieShim,
  decodeTokenClaims,
  defaultAuthPath,
  defaultOrgPath,
  defaultVisibilityPath,
  fetchModelList,
  visibilityAccountKeyOf,
} from './codely.js'

/** Stable Cordis plugin name. */
export const name = 'llm-tuanjie'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/** The provider route this plugin owns. */
export const TUANJIE_PROVIDER = 'tuanjie'

/** This bundle's own version, surfaced in status output. */
const CONNECT_VERSION = '0.1.2'

/** The same-origin route the Plugins-page card reads its status from. */
const STATUS_ROUTE_PATH = '/plugins/dsh-tuanjie-connect/status'

/** The same-origin route the card writes hidden-model changes to. */
const VISIBILITY_ROUTE_PATH = '/plugins/dsh-tuanjie-connect/visibility'

/** Provider idle ceiling while one stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_MS = 3e5

/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** How often the credential file is re-checked for a sign-in change. */
const CREDENTIAL_POLL_MS = 3e4

/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100
const MAX_POLL_MS = 864e5

/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs() {
  const override = Number(process.env.DSH_TUANJIE_POLL_MS)
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * One pi-ai model descriptor pointing at the loopback shim.
 *
 * `reasoning_content` is how this gateway returns thinking, and pi-ai parses
 * that field natively on the OpenAI-completions transport, so no custom
 * decoding is needed here.
 */
function toPiModel(info, baseUrl, providerId) {
  const thinkingLevelMap = { off: null, minimal: null, medium: null, xhigh: null }
  for (const level of SUPPORTED_EFFORTS) thinkingLevelMap[level] = level
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.images ? ['text', 'image'] : ['text'],
    reasoning: true,
    thinkingLevelMap,
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
  }
}

/**
 * Inert pi-ai auth plane.
 *
 * This route authenticates only through the shim's shared secret, resolved per
 * request by `resolveApiKey`, so pi-ai's own credential lifecycle must never
 * manufacture a credential for it. Every ambient question answers "nothing
 * stored, nothing set".
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-tuanjie-connect: the tuanjie route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

/**
 * Assemble the adapter.
 *
 * The profile is constructed by hand rather than through dsh-llm-pi-ai's
 * internal `resolveProfiles()`: that helper is not part of the package's public
 * export surface, so hand-assembly is the only supported path and every newly
 * required field has to be adopted here explicitly.
 */
function createTuanjieAdapter(options) {
  const { shim, catalog, providerId, displayName, resolveAttachments, resolveImageAccess, hidden } = options
  const buildModels = () =>
    catalog.current().map((info) => toPiModel(info, `${shim.baseUrl()}/v1`, providerId))

  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: 'Tuanjie Cowork loopback bearer',
          async resolve({ credential }) {
            const apiKey = credential?.key
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: 'Tuanjie Cowork' }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-tuanjie-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }
  const profiles = new Map([[providerId, profile]])

  return new TuanjiePiAiAdapter(
    {
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.sharedSecret,
      ...(resolveAttachments === undefined ? {} : { resolveAttachments }),
      ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
    },
    hidden,
  )
}

/**
 * `PiAiAdapter` with the account's hidden models dropped from the listing.
 *
 * Hiding belongs on `listModels` alone, and the `LlmAdapter` contract says why:
 * "Core routing accepts unlisted model ids; catalog-driven entry points such as
 * the GUI may require membership." So an id filtered out here disappears from
 * the picker while `resolveModel`/`prepareCall` still serve it, which is what
 * keeps a session that already chose the model working.
 *
 * pi-ai's own `filterModels` hook is deliberately NOT used: it is applied only
 * on `ModelsImpl.getAvailable()`, which nothing in the listing path calls, so a
 * model filtered there still shows up in the picker.
 */
class TuanjiePiAiAdapter extends PiAiAdapter {
  constructor(config, hidden) {
    super(config)
    this.hidden = hidden
  }

  async listModels(provider) {
    const models = await super.listModels(provider)
    const disabled = this.hidden?.() ?? []
    if (disabled.length === 0) return models
    const drop = new Set(disabled)
    return models.filter((model) => !drop.has(model.id))
  }
}

/** Plugin configuration: where the desktop app keeps its sign-in. */
export const Config = z.object({
  authFile: z
    .string()
    .description('Tuanjie Cowork credential file (defaults to ~/.codely-cli/oauth_creds.json)'),
  orgFile: z
    .string()
    .description('Tuanjie Cowork org map (defaults to ~/.codely-cli/org.json)'),
  visibilityFile: z
    .string()
    .description('Hidden-model preferences (defaults to ~/.dsh/tuanjie-visibility.json)'),
})

/** Answer one route with a JSON body. */
function writeRouteJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Collect a small request body (the toggle payload is a few dozen bytes). */
function readRequestBody(req, limit = 64 * 1024) {
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
 * Start the provider: its loopback endpoint, the `tuanjie` route, and the
 * credential-driven catalog lifecycle.
 *
 * The provider registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group, which keeps a
 * sign-in that happens after startup working without re-registering.
 */
export function apply(ctx, config) {
  let current = () => config
  let stopped = false
  const timers = []

  const authPath = () => current()?.authFile ?? defaultAuthPath()
  const orgPath = () => current()?.orgFile ?? defaultOrgPath()
  const store = new TuanjieCredentialStore(authPath, orgPath, ctx.logger)

  /**
   * The per-account hidden-model preference.
   *
   * The account key is derived from the credential alone — no network call — so
   * a toggle stays cheap and works offline.
   */
  const visibilityStore = new TuanjieVisibilityStore(
    () => current()?.visibilityFile ?? defaultVisibilityPath(),
    ctx.logger,
    () => {
      const credential = store.read()
      if (credential === undefined) return undefined
      const claims = decodeTokenClaims(credential.access_token)
      const userId = credential.user_id ?? claims?.sub
      const team = store.teamId(credential) ?? claims?.org_id ?? ''
      return visibilityAccountKeyOf(userId, team)
    },
  )

  /** The live catalog; starts on the fallback roster and swaps in on success. */
  let entries = buildCatalog(FALLBACK_MODELS)
  const catalog = { current: () => entries }

  const shim = createTuanjieShim({ store, logger: ctx.logger, version: CONNECT_VERSION })
  const providerId = TUANJIE_PROVIDER
  const displayName = 'Tuanjie Cowork'

  /**
   * Mount the same-origin status route the Plugins-page card reads.
   *
   * The card is a browser component, so it cannot reach the loopback shim
   * directly; it reads this route instead. The route answers the same
   * secret-free document the CLI prints, and `webServer` is optional — a
   * headless profile without it simply has no card, which is why this is an
   * `inject` rather than a hard dependency.
   */
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_ROUTE_PATH,
        handler: async (req, res) => {
          try {
            const status = await collectStatus({
              authPath: authPath(),
              orgPath: orgPath(),
              version: CONNECT_VERSION,
              logger: ctx.logger,
              // `collectStatus` derives the account key from the account it
              // fetched, so the store is handed over as-is.
              visibility: visibilityStore,
            })
            writeRouteJson(res, 200, status)
          } catch (error) {
            writeRouteJson(res, 500, { state: 'error', error: String(error?.message ?? error) })
          }
        },
      })
      ctx.effect(() => () => dispose())
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-tuanjie-connect: could not mount the status route, so the account card ` +
          `will be unavailable: ${error?.message ?? error}`,
      )
    }

    // The visibility write. Separate route from the read because it changes
    // state: the card sends one model id and whether it should be hidden.
    try {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: VISIBILITY_ROUTE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            writeRouteJson(res, 405, { error: 'method_not_allowed' })
            return
          }
          try {
            const payload = JSON.parse((await readRequestBody(req)).toString('utf8') || '{}')
            const modelId = payload?.modelId
            if (typeof modelId !== 'string' || modelId.length === 0) {
              writeRouteJson(res, 400, { error: 'modelId is required' })
              return
            }
            const account = visibilityStore.accountKey()
            if (account === undefined) {
              writeRouteJson(res, 409, { error: 'not_signed_in' })
              return
            }
            const disabled = visibilityStore.toggle(account, modelId, payload.hidden === true)
            // The picker reads the filtered roster, so it must be told to re-read.
            ctx.emit('llm/adapters-updated')
            writeRouteJson(res, 200, { ok: true, hidden: disabled })
          } catch (error) {
            writeRouteJson(res, 500, { error: String(error?.message ?? error) })
          }
        },
      })
      ctx.effect(() => () => dispose())
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-tuanjie-connect: could not mount the visibility route, so the card cannot ` +
          `save model visibility: ${error?.message ?? error}`,
      )
    }
  })

  /**
   * Declare the settings section the browser card renders into.
   *
   * DSH dispatches `settings.plugin.item` once per served section, pairing the
   * card's `key` with the section's id; a section that names no card renders
   * nothing, which is why both halves must agree on `tuanjie`.
   */
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.installSection?.('tuanjie', { authFile: authPath(), orgFile: orgPath() })
    } catch (error) {
      ctx.logger?.debug?.(
        `dsh-tuanjie-connect: settings section not installed on this core: ${error?.message ?? error}`,
      )
    }
  })

  /**
   * Fetch the gateway roster and publish it to the picker.
   *
   * A failed fetch leaves the previous catalog in place: the built-in roster is
   * always serviceable, and dropping to nothing would hide the group entirely.
   */
  async function refreshCatalog() {
    if (stopped) return
    try {
      const key = await store.resolve()
      const list = await fetchModelList(key)
      if (list.length === 0) return
      entries = buildCatalog(list)
      ctx.emit('llm/adapters-updated')
      ctx.logger?.debug?.(`dsh-tuanjie-connect: catalog refreshed (${entries.length} models)`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-tuanjie-connect: model list unavailable: ${error?.message ?? error}`)
    }
  }

  // The adapter must be built only after the listener is bound: `createProvider`
  // reads its `models` eagerly, and every model descriptor carries the shim's
  // base URL, which does not exist until the port is assigned.
  void shim.ready
    .then(() => {
      if (stopped) return
      const adapter = createTuanjieAdapter({
        shim,
        catalog,
        providerId,
        displayName,
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) =>
          resolveImageAttachmentAccess(
            attachments,
            (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
            ref,
          ),
        // Read on every listing, so a toggle reaches the picker without a
        // restart; the store answers [] when signed out or nothing is hidden.
        hidden: () => visibilityStore.disabled(visibilityStore.accountKey()),
      })
      const release = ctx.llm.registerAdapter([providerId], adapter)
      try {
        ctx.effect(() => () => {
          release()
          shim.close()
        })
      } catch {
        release()
        shim.close()
      }
      void refreshCatalog()
      const timer = setInterval(() => void refreshCatalog(), credentialPollMs())
      timer.unref?.()
      timers.push(timer)
    })
    .catch((error) => {
      ctx.logger?.error?.(
        `dsh-tuanjie-connect: the loopback endpoint failed to start, so the ${providerId} ` +
          `provider was not registered: ${error?.message ?? error}`,
      )
    })

  // Drop the sweep when the plugin is unloaded.
  ctx.effect(() => () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
  })
}
