# Changelog

## 0.1.2

界面卡片。

- 新增设置页**账号卡片**（`lib/client.js`）：在插件页 Tuanjie Cowork 条目下显示登录状态、账号、邮箱、令牌到期、剩余额度、模型密钥健康度，带「刷新」按钮。
- 宿主新增同源状态路由 `/plugins/dsh-tuanjie-connect/status`（`ctx.webServer.register`），卡片从这里取数，浏览器侧不接触任何令牌。
- 新增 `dsh.client` 声明与 `settings.plugin.item` 插槽注册；`webServer` 为可选注入，无该服务的 headless profile 只是不显示卡片。
- 新增 `test/card.test.mjs`（27 项）与 `test/route.test.mjs`（20 项，真实 HTTP）。

## 0.1.1

账号检测。

- 新增 `status` / `doctor` 命令（`lib/bin.js`）：显示登录账号、邮箱、令牌剩余有效期、**剩余额度**、模型密钥健康度；支持 `--json`。
- 新增 `collectStatus()` / `fetchAccount()`：身份取自 `/auth/external/me`，额度取自 `/api/user/usage/summary`（含分池明细与耗尽标记）。
- 本地端点新增 `/status` 路由，需 bearer 且响应不含密钥，供界面卡片等本机消费者读取。
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
