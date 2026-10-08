# Changelog

## 0.1.9

修复勾选框点击无效（点了闪一下又弹回去）。

- **根因**：回调语义接反了两次——模型清单把「当前可见状态」传给卡片，卡片又把它取反（`makeVisible === false`），负负得正，每次点击写回的都是**点击前的旧状态**。刷新后勾选框原样弹回。
- 修正为直接传递「点击后应否隐藏」（`!isHidden`），卡片不再取反。
- 新增点击语义断言：点一个可见的模型必须请求隐藏、点一个已隐藏的必须请求显示。该缺陷此前没有任何断言覆盖；变异测试将其收为第 4 个用例，确认会被拒绝。
- 顺带修正测试自身的树遍历：`walk` 此前把节点推进一个共享数组，`renderTab`/`renderBody` 只检查到根元素，嵌套的「无 null props」类断言形同虚设。现在每次渲染收集完整子树，断言真正覆盖到 checkbox。

## 0.1.8

模型显隐。

- **模型清单标签页新增勾选框**：取消勾选即从 DSH 模型选择器中隐藏该模型，重新勾选恢复。偏好按账号保存在 `~/.dsh/tuanjie-visibility.json`，两个账号互不继承。
- **隐藏只影响选择器**：实现为 `listModels` 过滤。`LlmAdapter` 契约写明「核心路由接受未列出的模型 id」，所以正在使用被隐藏模型的会话照常工作——测试覆盖了「隐藏模型仍可解析、仍可调用」与「清空偏好即恢复」。
- **为什么不用 pi-ai 的 `filterModels` 钩子**：它只在 `ModelsImpl.getAvailable()` 里生效，而列出模型走的是 `getModels()`——在那里过滤选择器根本看不到效果。这一点是测试先发现的：先写了 `filterModels`，断言立刻失败，随后才换成 `listModels` 子类。
- **存储语义**：禁用列表而非白名单，上游新增模型默认可见；模型暂时从网关消失时保留其条目，回来后仍是隐藏状态。读容错（损坏文件视为「无隐藏」，只会多显示不会丢模型），写失败向上抛。
- 新增 `POST /plugins/dsh-tuanjie-connect/visibility` 路由；卡片保存失败显示独立红色提示，不吞掉整张卡。
- 偏好文件是插件自己的（放在 `~/.dsh/` 下），不写进桌面 App 的凭据文件。
- 测试改为 `process.exitCode` 结尾并新增 `test/fixture.mjs`（把插件装进 dsh-core 夹具驱动真实 `apply()`）。可见性套件 29 项，变异测试扩到 3 个缺陷注入（jsx 误用、错误插槽、错误的隐藏机制——全部被拒绝）。

## 0.1.7

卡片改为三个标签页，对齐 WorkBuddy 的版式，但**只放 Codely 这边真能拿到的数据**。

- **状态**：账号、邮箱、访问令牌到期、模型列表更新时间、剩余额度、模型密钥健康度。
- **模型清单**（新增）：从网关实时拉取的模型列表，每个显示模型 ID、后端名、上下文窗口、能力标签（图片/工具/思考）。
- **额度详情**（新增）：剩余额度、可用状态、按额度池拆分。
- `collectStatus()` 现在同时返回模型清单与拉取时间，卡片无需二次请求。
- 新增 `test/tabs-data.test.mjs`（23 项）验证数据确实流到卡片，卡片测试扩到 64 项。

### 上游没有的数据，卡片不编

先探测过才决定不做的两项：

- **模型倍率（x0.79）**：网关的管理端点（`/v1/model/info`、`/model_group/info`、`/key/info` 等）全部被 nginx 挡回 403，只有 `/v1/models` 可达。App 配置文件里有 `rate`，但只覆盖 5 个模型中的 2 个，作为卡片数据不可靠，因此不显示。
- **额度进度条与套餐名**：`/api/user/usage/summary` 只返回 `remaining_points`，没有 `used_points`、`quota_points` 或套餐名，无法算进度。额度详情页里写明了这一点，而不是画一条假的进度条。

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
