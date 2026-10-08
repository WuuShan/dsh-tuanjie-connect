# Changelog

## 0.1.6

**修复卡片崩溃** —— 卡片其实一直有在渲染，是组件自己抛异常被 React 错误边界吞掉了（控制台报 `slot entry crashed in 'plugins.bundle.config'`）。

- **根因**：`lib/client.js` 把 jsx-runtime 的 `jsx` 当作元素工厂用了。两者签名不同——`createElement(type, props, ...children)` 对 `jsx(type, props, key)`——于是 `h(Note, null, '文本')` 把中文字符串当成了 `key`、`props` 传成 `null`，React 内部读 `config.key` 时抛 `Cannot read properties of null (reading 'key')`。改用 `react.createElement`。
- **测试为什么没拦住**：桩函数的 `createElement` 直接返回 `null`，永远不会抛错。现在桩函数**复现 React 的真实签名与 `config.key` 访问**，并新增 `test/mutation.test.mjs`——把原 bug 注入回去，要求测试必须失败（实测会失败 9 项）。一条对坏代码也通过的测试等于没有测试。

## 0.1.5

修正客户端半边的两处声明。

- **客户端插件名不再与宿主重名**：浏览器半边的 cordis 插件名改为 `dsh-tuanjie-connect-client`（原来误用了宿主的 `llm-tuanjie`）。两半在同一个 runtime 里是独立插件，同名会让第二次注册被判为重复而丢弃。
- **`dsh.client.inject` 改为空数组**：原来填的 `@deepseek-ai/dsh-client-ui-slots` 是 Node 侧纯核心包（其 package.json 没有 `dsh.client` 声明），不是浏览器模块。卡片只用宿主提供的 React，不需要注入任何客户端包。
- 新增 `test/discover-client.mjs`（复现 DSH 的客户端包发现流程）与 `test/list-client-packages.mjs`（列出 DSH 中所有声明 `dsh.client` 的包）。

## 0.1.4

改用正确的插槽。

- 卡片注册到 `plugins.bundle.config`（原来误用 `plugins.detail.section`）。DSH 插件页渲染 bundle 自身配置面板的方式是 `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`，且只在 `ledger.bundles.has(pkg.name)` 时渲染——插槽名与 key 都必须正确。
- `test/card.test.mjs` 增加插槽名、key、以及 key 与 `package.json` name 一致的断言。

## 0.1.3

修复卡片不显示。

- **补上 `exports` 字段**：DSH 通过 `"./client": "./lib/client.js"` 定位浏览器半边，缺失时卡片静默不加载（这是卡片没出现的主因）。
- **改用 DSH 0.2.0 真正的插槽名**：插件页声明的是 `plugins.detail.section`（详情页区块），不是 `settings.plugin.item`。旧名保留注册以便兼容更早的内核。
- 详情区块按 `subject.pkg.name` 过滤，只在自己的 bundle 页面渲染；`subject` 为 null（列表态）时不渲染。
- `test/card.test.mjs` 增加 exports 映射断言与真实插槽名校验（37 项）。

## 0.1.2

界面卡片。

- 新增插件页**账号卡片**（`lib/client.js`）：在 Tuanjie Cowork 条目下显示登录状态、账号、邮箱、令牌到期、剩余额度、模型密钥健康度，带「刷新」按钮。
- 宿主新增同源状态路由 `/plugins/dsh-tuanjie-connect/status`（`ctx.webServer.register`），卡片从这里取数，浏览器侧不接触任何令牌。
- 新增 `dsh.client` 声明与插槽注册；`webServer` 为可选注入，无该服务的 headless profile 只是不显示卡片。
- 新增 `test/card.test.mjs` 与 `test/route.test.mjs`（真实 HTTP）。

## 0.1.1

账号检测。

- 新增 `status` / `doctor` 命令（`lib/bin.js`）：显示登录账号、邮箱、令牌剩余有效期、**剩余额度**、模型密钥健康度；支持 `--json`。
- 新增 `collectStatus()` / `fetchAccount()`：身份取自 `/auth/external/me`，额度取自 `/api/user/usage/summary`（含分池明细与耗尽标记）。
- 本地端点新增 `/status` 路由，需 bearer 且响应不含密钥，供本机消费者读取。
- 所有输出路径自动脱敏（JWT、`sk-` 密钥、token 查询参数）。
- 未登录、令牌被拒、额度耗尽为独立状态并各自带提示，退出码区分。
- 新增 `test/account.test.mjs`（31 项）。

## 0.1.0

首个版本。

- 将 Tuanjie Cowork（Codely）的模型接入 DSH：`codely-core` / `codely-flash` / `codely-basic` / `codely-air` / `codely-vl`。
- 复用 App 登录态，无独立登录流程。
- 模型清单每次启动从网关实时拉取，失败时退回内置清单。
- 实测支持：流式输出、思考过程（`reasoning_content`）、工具调用、图片输入、推理档位 `low`/`high`/`max`。
- 逆向实现请求签名（`X-Codely-Signature`）与本地转发端点；401/403 时自动换密钥并重放一次。
- 凭据文件每 30 秒扫描一次，App 重新登录后自动恢复。
- 新增 `test/protocol.test.mjs`（34 项）。
