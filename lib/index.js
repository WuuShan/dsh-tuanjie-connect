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
  buildCatalog,
  createTuanjieShim,
  defaultAuthPath,
  defaultOrgPath,
  fetchModelList,
} from './codely.js'

/** Stable Cordis plugin name. */
export const name = 'llm-tuanjie'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/** The provider route this plugin owns. */
export const TUANJIE_PROVIDER = 'tuanjie'

/** This bundle's own version, surfaced in status output. */
const CONNECT_VERSION = '0.1.1'

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
  const { shim, catalog, providerId, displayName, resolveAttachments, resolveImageAccess } = options
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

  return new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.sharedSecret,
    ...(resolveAttachments === undefined ? {} : { resolveAttachments }),
    ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
  })
}

/** Plugin configuration: where the desktop app keeps its sign-in. */
export const Config = z.object({
  authFile: z
    .string()
    .description('Tuanjie Cowork credential file (defaults to ~/.codely-cli/oauth_creds.json)'),
  orgFile: z
    .string()
    .description('Tuanjie Cowork org map (defaults to ~/.codely-cli/org.json)'),
})

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

  /** The live catalog; starts on the fallback roster and swaps in on success. */
  let entries = buildCatalog(FALLBACK_MODELS)
  const catalog = { current: () => entries }

  const shim = createTuanjieShim({ store, logger: ctx.logger, version: CONNECT_VERSION })
  const providerId = TUANJIE_PROVIDER
  const displayName = 'Tuanjie Cowork'

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
