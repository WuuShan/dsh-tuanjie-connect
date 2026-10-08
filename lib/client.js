/**
 * Browser half of dsh-tuanjie-connect: the account card on the Plugins page.
 *
 * Shipped as a prebuilt `window.__ModuleLoader__.load(...)` bundle, which is how
 * DSH loads client halves. React and the JSX runtime come from the host; nothing
 * here is bundled from npm, so the file stays dependency-free. Data comes from
 * the host's same-origin `/plugins/dsh-tuanjie-connect/status` route, which is
 * what lets the card show the account without the browser ever holding a token.
 *
 * @module dsh-tuanjie-connect/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-tuanjie-connect',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')
    /**
     * `createElement`, not the jsx-runtime `jsx`.
     *
     * The two have different signatures — `createElement(type, props, ...children)`
     * versus `jsx(type, props, key)` — and this file is written in the
     * varargs-children style. Aliasing the runtime function here made every
     * `h(C, null, child)` pass `child` as the *key* and `null` as props, which
     * threw `Cannot read properties of null (reading 'key')` inside React and
     * took the whole card down with it.
     */
    let h = react.createElement
    let Fragment = react.Fragment
    let useState = react.useState
    let useEffect = react.useEffect
    let useCallback = react.useCallback

    /**
     * Stable Cordis plugin name for the browser half.
     *
     * This must NOT equal the host half's name: the two halves are separate
     * cordis plugins in the same runtime, and a shared id makes the second
     * registration a duplicate that gets dropped. The `-client` suffix is the
     * convention the WorkBuddy bundle uses.
     */
    const name = 'dsh-tuanjie-connect-client'

    /**
     * Services this half needs before it can contribute.
     *
     * These are cordis *service* names — `slots` is the slot registry — not
     * package specifiers. The package list in `package.json`'s `dsh.client.inject`
     * is a different thing and must name browser modules.
     */
    const inject = ['slots']

    /** The bundle this client half belongs to. */
    const BUNDLE_NAME = 'dsh-tuanjie-connect'

    /** The host route this card reads. Kept literal so both halves cannot drift. */
    const STATUS_PATH = '/plugins/dsh-tuanjie-connect/status'

    /** The host route a visibility toggle is written to. */
    const VISIBILITY_PATH = '/plugins/dsh-tuanjie-connect/visibility'

    /** Slot key: must equal the host-side settings section id the card serves. */
    const CARD_KEY = 'tuanjie'

    /** A disposer for a contribution that could not be registered. */
    const NOOP_DISPOSER = () => {}

    /** Turn a number into a grouped string, or undefined when unusable. */
    function formatPoints(value) {
      if (typeof value !== 'number' || !isFinite(value)) return undefined
      try {
        return value.toLocaleString('zh-CN')
      } catch {
        return String(value)
      }
    }

    /** One label/value row. */
    function Row(props) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' } },
        h('span', { style: { opacity: 0.65 } }, props.label),
        h('span', { style: { fontVariantNumeric: 'tabular-nums', textAlign: 'right' } }, props.value),
      )
    }

    /** A state dot plus its label. */
    function StateLine(props) {
      var color = props.tone === 'ok' ? '#3fb950' : props.tone === 'warn' ? '#d29922' : '#f85149'
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
        h('span', {
          style: {
            width: 8,
            height: 8,
            borderRadius: 4,
            background: color,
            display: 'inline-block',
            flex: 'none',
          },
        }),
        h('strong', null, props.label),
      )
    }

    /** Muted helper text. */
    function Note(props) {
      return h('div', { style: { opacity: 0.65, fontSize: '0.92em', marginTop: 4 } }, props.children)
    }

    /** The card body: signed-out, rejected, or signed-in. */
    function StatusBody(props) {
      var status = props.status

      if (status.state === 'signed-out') {
        return h(
          Fragment,
          null,
          h(StateLine, { tone: 'bad', label: '未登录' }),
          h(Note, null, status.hint ?? '请先在 Tuanjie Cowork 桌面 App 中登录。'),
        )
      }

      if (status.state === 'error') {
        return h(
          Fragment,
          null,
          h(StateLine, { tone: 'bad', label: '登录被拒' }),
          h(Note, null, status.hint ?? '请打开 Tuanjie Cowork App 重新登录。'),
          h(Row, { label: '错误', value: status.error ?? '未知' }),
        )
      }

      var days = status.accessTokenDaysLeft
      var quota = formatPoints(status.account && status.account.remainingPoints)
      var exhausted = status.state === 'quota-exhausted'
      var rows = []

      rows.push(h(Row, { key: 'user', label: '账号', value: status.username ?? '—' }))
      if (status.email !== undefined) rows.push(h(Row, { key: 'mail', label: '邮箱', value: status.email }))
      if (status.accessTokenExpires !== undefined) {
        rows.push(
          h(Row, {
            key: 'exp',
            label: '访问令牌',
            value:
              new Date(status.accessTokenExpires).toLocaleDateString('zh-CN') +
              ' 过期' +
              (days === undefined ? '' : '（' + days + ' 天，自动续期）'),
          }),
        )
      }
      if (status.modelsUpdatedAt !== undefined) {
        rows.push(
          h(Row, {
            key: 'modelsAt',
            label: '模型列表更新于',
            value: new Date(status.modelsUpdatedAt).toLocaleString('zh-CN'),
          }),
        )
      }
      if (quota !== undefined) rows.push(h(Row, { key: 'quota', label: '剩余额度', value: quota + ' 积分' }))
      rows.push(
        h(Row, {
          key: 'key',
          label: '模型密钥',
          value: status.modelKey && status.modelKey.state === 'ready' ? '就绪' : '不可用',
        }),
      )

      return h(
        Fragment,
        null,
        h(StateLine, {
          key: 'state',
          tone: exhausted ? 'warn' : 'ok',
          label: exhausted ? '已登录（额度耗尽）' : '已登录',
        }),
        ...rows,
      )
    }

    /** Short context-window label: 1048576 -> "1M". */
    function formatContext(tokens) {
      if (typeof tokens !== 'number' || !isFinite(tokens) || tokens <= 0) return '—'
      if (tokens >= 1048576) return (tokens / 1048576).toFixed(tokens % 1048576 === 0 ? 0 : 1) + 'M'
      if (tokens >= 1000) return Math.round(tokens / 1000) + 'K'
      return String(tokens)
    }

    /** Capability chips for one model. */
    function Capabilities(props) {
      var info = props.info
      var chips = []
      if (info.images) chips.push({ text: '图片', color: '#d2a8ff', border: '#5b3a86' })
      chips.push({ text: '工具', color: '#7ee787', border: '#1d4433' })
      chips.push({ text: '思考', color: '#ffa657', border: '#6b4a1d' })
      return h(
        'span',
        null,
        ...chips.map((chip, index) =>
          h(
            'span',
            {
              key: chip.text + index,
              style: {
                display: 'inline-block',
                fontSize: '0.82em',
                padding: '0 6px',
                marginRight: 4,
                borderRadius: 8,
                border: '1px solid ' + chip.border,
                color: chip.color,
              },
            },
            chip.text,
          ),
        ),
      )
    }

    /** Tab 2: the live model roster. */
    function ModelsTab(props) {
      var models = props.models
      if (!Array.isArray(models) || models.length === 0) {
        return h(Note, null, '模型清单不可用；网关未返回数据，插件会退回内置清单。')
      }
      var hidden = Array.isArray(props.hidden) ? props.hidden : []
      var busy = props.busy === true
      var hiddenCount = models.filter((model) => hidden.indexOf(model.id) >= 0).length

      return h(
        'div',
        null,
        h(
          Note,
          null,
          '取消勾选即可在 DSH 模型选择器中隐藏该模型；隐藏只影响选择器，正在用该模型的会话不受影响。偏好按账号保存。',
        ),
        hiddenCount > 0
          ? h(
              'div',
              { style: { marginTop: 6, opacity: 0.75, fontSize: '0.9em' } },
              '已隐藏 ' + hiddenCount + ' / ' + models.length + ' 个模型',
            )
          : null,
        h(
          'div',
          { style: { marginTop: 10 } },
          ...models.map((model) => {
            var visible = hidden.indexOf(model.id) < 0
            return h(
              'label',
              {
                key: model.id,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '7px 0',
                  borderTop: '1px solid rgba(128,128,128,0.16)',
                  cursor: busy ? 'default' : 'pointer',
                  opacity: visible ? 1 : 0.5,
                },
              },
              h(
                'span',
                { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
                h('input', {
                  type: 'checkbox',
                  checked: visible,
                  disabled: busy,
                  onChange: () => props.onToggle(model.id, visible),
                  style: { cursor: busy ? 'default' : 'pointer', flex: 'none' },
                }),
                h(
                  'span',
                  { style: { minWidth: 0 } },
                  h('span', { style: { fontFamily: 'ui-monospace, monospace' } }, model.id),
                  h(
                    'span',
                    { style: { opacity: 0.65, fontSize: '0.88em', marginLeft: 8 } },
                    model.name === model.id ? '' : model.name,
                  ),
                ),
              ),
              h(
                'span',
                { style: { display: 'flex', alignItems: 'center', gap: 12, flex: 'none' } },
                h(Capabilities, { info: model }),
                h(
                  'span',
                  { style: { fontVariantNumeric: 'tabular-nums', opacity: 0.85, minWidth: 46, textAlign: 'right' } },
                  formatContext(model.contextWindow),
                ),
              ),
            )
          }),
        ),
      )
    }

    /** Tab 3: quota, with a per-pool breakdown when the server reports one. */
    function QuotaTab(props) {
      var account = props.account
      if (account === undefined) return h(Note, null, '额度信息不可用。')

      var total = formatPoints(account.remainingPoints)
      var buckets = account.buckets ?? []

      return h(
        Fragment,
        null,
        h(Row, {
          label: '剩余额度',
          value: total === undefined ? '未知' : total + ' 积分',
        }),
        h(Row, {
          label: '状态',
          value: account.exhausted ? '已耗尽' : '可用',
        }),
        ...(account.quotaError === undefined
          ? []
          : [h(Note, { key: 'qerr' }, '额度接口错误：' + account.quotaError)]),
        ...(buckets.length === 0
          ? [h(Note, { key: 'none' }, '上游未返回分池明细。')]
          : [
              h('div', { key: 'head', style: { marginTop: 12, marginBottom: 2 } }, h('strong', null, '按额度池')),
              ...buckets.map((bucket, index) =>
                h(Row, {
                  key: 'b' + index,
                  label: bucket.type ?? '池',
                  value:
                    (formatPoints(bucket.remainingPoints) ?? '?') +
                    (bucket.quotaPoints === undefined ? '' : ' / ' + formatPoints(bucket.quotaPoints)) +
                    (bucket.exhausted ? '（已耗尽）' : ''),
                }),
              ),
            ]),
        h(
          Note,
          { key: 'note' },
          '上游只返回剩余额度，不返回已用量与套餐名，因此没有进度条。',
        ),
      )
    }

    /** One tab button. */
    function TabButton(props) {
      var active = props.active
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          style: {
            padding: '6px 10px',
            marginRight: 4,
            border: 'none',
            borderBottom: active ? '2px solid currentColor' : '2px solid transparent',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            opacity: active ? 1 : 0.6,
            fontWeight: active ? 600 : 400,
          },
        },
        props.label,
      )
    }

    /** The Plugins-page card: a header, then the three tabs. */
    function TuanjiePluginCard() {
      var [state, setState] = useState({ loading: true })
      var [busy, setBusy] = useState(false)
      var [tab, setTab] = useState('status')
      /** A failed visibility save, kept apart from the load error so the card survives it. */
      var [saveError, setSaveError] = useState(undefined)

      var load = useCallback(async (signal) => {
        try {
          var response = await fetch(STATUS_PATH, {
            signal: signal,
            headers: { Accept: 'application/json' },
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          setState({ loading: false, status: await response.json() })
        } catch (error) {
          if (signal && signal.aborted) return
          setState({ loading: false, error: String((error && error.message) || error) })
        }
      }, [])

      useEffect(() => {
        var controller = new AbortController()
        load(controller.signal)
        return () => controller.abort()
      }, [load])

      var refresh = useCallback(async () => {
        setBusy(true)
        try {
          await load(new AbortController().signal)
        } finally {
          setBusy(false)
        }
      }, [load])

      /**
       * Hide or show one model.
       *
       * The write goes to the host, which persists it and tells the LLM registry
       * to re-list; reloading afterwards is what updates the checkboxes from the
       * saved document rather than from an optimistic guess. A failed save sets
       * a separate notice so the rest of the card stays usable.
       */
      var toggle = useCallback(
        async (modelId, makeVisible) => {
          setBusy(true)
          setSaveError(undefined)
          try {
            var response = await fetch(VISIBILITY_PATH, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ modelId: modelId, hidden: makeVisible === false }),
            })
            if (!response.ok) {
              var detail = await response.text().catch(() => '')
              setSaveError('保存失败：HTTP ' + response.status + ' ' + detail.slice(0, 140))
              return
            }
            await load(new AbortController().signal)
          } catch (error) {
            setSaveError('保存失败：' + String((error && error.message) || error))
          } finally {
            setBusy(false)
          }
        },
        [load],
      )

      var status = state.status
      var signedIn = status !== undefined && status.state !== 'signed-out' && status.state !== 'error'

      var body
      if (state.loading) body = h(Note, null, '正在读取登录状态…')
      else if (state.error !== undefined) {
        body = h(
          Fragment,
          null,
          h(StateLine, { tone: 'bad', label: '状态不可用' }),
          h(Note, null, state.error),
        )
      } else if (!signedIn) {
        body = h(StatusBody, { status: status })
      } else if (tab === 'models') {
        body = h(ModelsTab, {
          models: status.models,
          hidden: status.hiddenModels,
          busy: busy,
          onToggle: toggle,
        })
      } else if (tab === 'quota') {
        body = h(QuotaTab, { account: status.account })
      } else {
        body = h(StatusBody, { status: status })
      }

      return h(
        'div',
        { style: { padding: '4px 0' } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 10,
            },
          },
          h(
            'div',
            null,
            h('strong', null, '账号'),
            h(Note, null, '复用 Tuanjie Cowork 桌面 App 的登录态，无需额外配置'),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: refresh,
              disabled: busy,
              style: {
                padding: '4px 12px',
                borderRadius: 6,
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
                flex: 'none',
              },
            },
            busy ? '刷新中…' : '刷新',
          ),
        ),
        signedIn && !state.loading && state.error === undefined
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: 2,
                  borderBottom: '1px solid rgba(128,128,128,0.25)',
                  marginBottom: 12,
                },
              },
              h(TabButton, { label: '状态', active: tab === 'status', onClick: () => setTab('status') }),
              h(TabButton, { label: '模型清单', active: tab === 'models', onClick: () => setTab('models') }),
              h(TabButton, { label: '额度详情', active: tab === 'quota', onClick: () => setTab('quota') }),
            )
          : null,
        // A failed visibility save must not be silent: the checkbox would snap
        // back on the next read with no explanation.
        saveError === undefined
          ? null
          : h(
              'div',
              {
                style: {
                  marginBottom: 10,
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: '1px solid #f85149',
                  color: '#f85149',
                  fontSize: '0.9em',
                },
              },
              saveError,
            ),
        body,
      )
    }

    /**
     * Register the card.
     *
     * `plugins.bundle.config` is the slot DSH 0.2.0's Plugins page renders as a
     * bundle's own configuration panel — the boxed, collapsible section below
     * the component list. It is keyed by the *bundle package name*, which is how
     * the page knows which bundle the panel belongs to. This is the same
     * registration the WorkBuddy bundle uses.
     *
     * `settings.plugin.item` is registered too, for older cores whose Settings
     * page dispatched a card per served section. On 0.2.0 that slot has no
     * consumer, so it is inert rather than wrong.
     */
    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: BUNDLE_NAME,
            priority: 20,
          },
          TuanjiePluginCard,
        ) || NOOP_DISPOSER,
      )

      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: CARD_KEY,
            priority: 30,
          },
          TuanjiePluginCard,
        ) || NOOP_DISPOSER,
      )
    }

    exports.BUNDLE_NAME = BUNDLE_NAME
    exports.TuanjiePluginCard = TuanjiePluginCard
    // Exported for tests: these are the branches that read the fetched
    // document, and rendering them directly is what catches a bad child
    // position.
    exports.StatusBody = StatusBody
    exports.ModelsTab = ModelsTab
    exports.QuotaTab = QuotaTab
    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
