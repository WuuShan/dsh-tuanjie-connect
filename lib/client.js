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
    let jsx = require('react/jsx-runtime')
    let h = jsx.jsx
    let jsxs = jsx.jsxs
    let Fragment = react.Fragment
    let useState = react.useState
    let useEffect = react.useEffect
    let useCallback = react.useCallback

    /** Stable Cordis plugin name. */
    const name = 'llm-tuanjie'

    /** Services this half needs before it can contribute a card. */
    const inject = ['slots']

    /** The bundle this client half belongs to. */
    const BUNDLE_NAME = 'dsh-tuanjie-connect'

    /** The host route this card reads. Kept literal so both halves cannot drift. */
    const STATUS_PATH = '/plugins/dsh-tuanjie-connect/status'

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
      var buckets = (status.account && status.account.buckets) || []
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
      if (quota !== undefined) rows.push(h(Row, { key: 'quota', label: '剩余额度', value: quota + ' 积分' }))
      rows.push(
        h(Row, {
          key: 'key',
          label: '模型密钥',
          value: status.modelKey && status.modelKey.state === 'ready' ? '就绪' : '不可用',
        }),
      )

      var children = [
        h(StateLine, {
          key: 'state',
          tone: exhausted ? 'warn' : 'ok',
          label: exhausted ? '已登录（额度耗尽）' : '已登录',
        }),
        ...rows,
      ]

      if (buckets.length > 1) {
        children.push(
          h(
            Note,
            { key: 'buckets' },
            buckets
              .map((b) => (b.type || '池') + ': ' + (formatPoints(b.remainingPoints) || '?'))
              .join('　'),
          ),
        )
      }

      return h(Fragment, null, ...children)
    }

    /** The Plugins-page card. */
    function TuanjiePluginCard() {
      var [state, setState] = useState({ loading: true })
      var [busy, setBusy] = useState(false)

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

      var body
      if (state.loading) body = h(Note, null, '正在读取登录状态…')
      else if (state.error !== undefined) {
        body = h(
          Fragment,
          null,
          h(StateLine, { tone: 'bad', label: '状态不可用' }),
          h(Note, null, state.error),
        )
      } else body = h(StatusBody, { status: state.status })

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
        body,
      )
    }

    /**
     * Register the card.
     *
     * DSH 0.2.0's Plugins page renders per-bundle content through
     * `plugins.detail.section`, a root-scope list slot that receives
     * `{ subject }` where `subject` is `{ kind: 'bundle' | 'row', pkg, row? }`
     * and `pkg` is a ref object (`{ name, version, installed, enabled, rows }`).
     * The section renders only for this bundle's own page.
     *
     * `settings.plugin.item` is registered as well for older cores whose
     * Settings page dispatched a card per served section; on 0.2.0 that slot has
     * no consumer, so it is inert rather than wrong.
     */
    function apply(ctx) {
      ctx.slots.inject('plugins.detail.section', () =>
        ctx.slots.register(
          {
            name: 'plugins.detail.section',
            id: 'tuanjie-account',
            priority: 20,
          },
          function TuanjieDetailSection(props) {
            var subject = props && props.subject
            // `subject` is null while the page shows a list rather than a detail.
            if (subject === null || subject === undefined) return null
            var name = subject.pkg && subject.pkg.name
            if (name !== undefined && name !== BUNDLE_NAME) return null
            return h(TuanjiePluginCard, props)
          },
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
    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
