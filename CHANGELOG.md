# Changelog

## 0.1.12

修复回答被输出上限截断。

- **根因**：`maxTokens` 声明为 `16384`，而这恰好是 pi-ai `DEFAULT_THINKING_BUDGETS` 里 `high` 档的推理预算（`clampReasoning` 把 `max` 也归到 `high`）。这条路由走 OpenAI 兼容协议，而 pi-ai 只对 Anthropic / Bedrock 路径调用 `adjustMaxTokensForThinking` 给答案留空间——OpenAI 路径上 `max_tokens` 就是「思考 + 回答」的**唯一**总池。于是开高推理档时，推理可以把整个 16384 吃光，答案是空的或被截断。
- **实测证据**（`codely-core`，`reasoning_effort=high`，要求 400 条长枚举）：

  | max_tokens | finish | completion | reasoning | 答案字符 |
  |---|---|---|---|---|
  | 16384 | length | 16384 | 16387 | **0** |
  | 32768 | length | 32768 | 32769 | **0** |
  | 65536 | length | 65536 | 65537 | **0** |

  即「只加大预算」无效——推理会一直涨到吃满为止。
- **改法**：`maxTokens` 提到 **65536**（网关接受，实测 `codely-core` 到 1000000 都通过），给推理之外留出真实的答案空间。常规任务下推理约 1300–1600，答案完整。
- **上下文窗口改正**：`contextWindow` 从硬编码的 `202752` 改为网关 `/v1/models` 实际公布的 `max_model_len`（`codely-core` 1048576，`codely-flash` / `codely-vl` 1024000）。原来少报 5 倍，会让 DSH 过早压缩对话。
- **新增保护**：`buildCatalog` 现在会采纳上游公布的上限（`max_output_tokens` / `max_completion_tokens` / `max_tokens`），并把 `maxTokens` 钳制在「上下文窗口 − 1024」以内。上下文很小的模型（实测 2048）不会再因为声明 65536 而被拒。
- 新增 `test/limits.test.mjs`（27 项，离线）：断言每个模型的预设额度都高于「high 推理预算 + 答案空间」、窗口取自网关实际值、钳制在边界模型上正确、异常的上游值被忽略，以及 `maxTokens → pi-ai → max_tokens` 的接线仍然存在。变异测试把 `16384` 注入回去作为第 5 个用例，确认会被拒绝。
- **仍存在的限制**：`thinking_token_budget` 字段网关语法上接受但不执行（实测 4096 与 8192 都无法约束失控的推理），所以插件层面无法强制推理收敛。遇到极长枚举类任务请手动降低推理档位。

## 0.1.11

转发层加固 + 卡片顶部剩余额度。修复了 0.1.10 中真实的传输缺陷。

**来源**：这组改动最初由第三方基于 `0.1.10`（`413a125`）以本地补丁形式编写并交付，本版本将其并入仓库。合并前逐项复核，并独立重写了关键语义的验证（见下）；对方的原始交付说明未写变更日志、版本号仍为 `0.1.10`，因此本地补丁会被任何一次从 GitHub 的更新静默覆盖——这也是并入仓库的原因。

### 修复的真实缺陷

- **背压丢失**：`for await (...) res.write(chunk)` 忽略 `res.write()` 返回值，慢消费端下会持续抽干上游并把整个响应堆在内存里。改为 `Readable.fromWeb()` + `pipeline()`，让背压沿链路传播，客户端断开时取消上游。
- **断流被伪装成正常结束**：上游中途失败时原先调 `res.end()`，截断的响应会以正常 HTTP EOF 结束——客户端无法与完整回答区分。现在改为中止响应，让客户端识别为传输失败。这是「经常断链」最可能的成因。
- **控制面调用无超时**：密钥兑换、令牌刷新、模型清单原先没有超时，控制面挂起会让插件无限等待。现在统一 30 秒网络超时（不对整段生成设上限）。
- **401 重试语义**：原先排空错误正文后总是重新兑换密钥；现在只取消即将重试的那次响应、保留最终 401/403 正文，并且若其他并发请求已换过密钥就直接复用，最多重试一次认证。
- **额度解析**：`Number('')` 为 `0`，会把未知额度显示成「0 积分」。现在只有上游明确返回 0 才显示 0；缺失、null、空串、非法值都视为未知。
- **模型清单轮询**：加入单飞守卫（不重叠）、清单未变化不广播适配器更新、卸载后不发布迟到结果。
- 流式响应立即 `flushHeaders()`，SSE 加 `no-cache, no-transform` 与 `x-accel-buffering: no`，向网关请求 `Accept-Encoding: identity` 以减少压缩层造成的分块聚集；透传 `Retry-After` 与 `x-request-id`。

### 新增

- 插件卡片顶部显示**剩余额度**（大号数字、更新时间、耗尽状态、「刷新额度」按钮），前台每 60 秒自动刷新，页面隐藏时跳过、恢复可见时立即查询。
- 新增只读同源路由 `GET /plugins/dsh-tuanjie-connect/quota`：只读凭据并请求控制面的 usage 接口，**不兑换密钥、不刷新令牌、不拉模型清单、不发起生成请求**，响应 `no-store` 且不含凭据。

### 验证

- 新增 `test/transport.test.mjs`（8 项）、`test/catalog-poll.test.mjs`（1 项）、`test/quota.test.mjs`（2 项），全部离线、不消耗额度；`npm run test:offline` 可重复运行。
- 新增 `test/transport-verify.test.mjs`（15 项）：**独立于对方测试**重写关键语义验证——正常流逐字节完整（含跨分块多字节字符）、中途失败必须是读取失败而非成功的短读、401 恰好换一次密钥且并发已换过时不重复兑换、消费端停顿时不抽干上游、取消后停止拉取。
- 合并后的库跑通原有全部套件（门禁 5 + 协议 34 + 账号 31 + 卡片 70 + 路由 20 + 标签 23 + 可见性 29），变异测试的 4 个缺陷注入仍全部被拒绝。

### 已知限制

原作者没有做真实生成的 A/B 测速（本机无可用的缓存模型密钥），因此**不声称 tokens/s 提升**。推理档位开 max 时的速率主要由上游生成速度决定；本组修复改善的是断流、分块延迟与缓冲，不是原始 token 速率。

## 0.1.10

适配 DSH `0.2.1-rc.2`，并把 peer 范围从精确 pin 放宽。

- **问题**：插件把 `@deepseek-ai/dsh-llm` / `dsh-llm-pi-ai` 精确钉在 `0.2.0-rc.2`，而 DSH 的门禁拿运行内核版本去匹配这个范围——内核升到 `0.2.1-rc.2` 后整包被判定不兼容而拒绝（「请卸载后重新安装与当前 DSH 兼容的版本」）。
- **改法**：范围改为 `^0.2.0-rc.2`。`test/peer-range.mjs` 实测各候选范围在门禁下的表现后选定：它覆盖两个已实测内核（`0.2.0-rc.2`、`0.2.1-rc.2`）与整个 `0.2.x`，同时 `0.3.x` 仍被拦下要求重新验证。（顺带发现 `>=0.2.0-rc.2 <0.3.0` 在 `includePrerelease` 下会错误放行 `0.3.0-rc.1`——所以没有用它。）
- `@earendil-works/pi-ai` 声明改为 `^0.87.1 || ^1.0.0`：该包不在门禁内，但实际已从 `0.87.1` 跳到 `1.1.0`，旧范围与事实不符。
- **内核升级做了实际验证，不只是改版本号**：从新 asar 重建 `dsh-core` 夹具，逐项审计插件用到的私有 API（`PiAiAdapter`、`listModels`/`resolveModel`/`prepareCall`、`createAdapter` 的 `piProvider`、`registerAdapter`、`llm/adapters-updated`、`plugins.bundle.config` 插槽与 `entryKey` 过滤、`exports["./client"]`），并用真实 `apply()` 跑通可见性与卡片行为。
- 新增 `test/compat-core.mjs`（API 面审计）、`test/gate.test.mjs`（用 DSH 自己的门禁逻辑判定本清单，并断言 `0.3.x` 会被拒绝）、`test/peer-range.mjs`（候选范围的决策依据）。

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
