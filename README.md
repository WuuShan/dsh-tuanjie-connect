# DSH Tuanjie Cowork Connect


[English](./README.en.md) | 中文


将 Tuanjie Cowork（Codely）桌面 App 中的模型（GLM-5.3、DeepSeek-V4.1-Flash 等）自动接入 DeepSeek Harness，实现在 DSH 对话窗口里零配置使用。


## 功能


- **开箱即用**：插件复用 Tuanjie Cowork App 已有的登录态，安装后不需要任何额外配置。前提只有一个——你已经安装并登录了 Tuanjie Cowork 桌面 App。


- **模型清单**：安装后 DSH 模型选择器里出现 **Tuanjie Cowork** 分组。清单每次启动从网关实时拉取，上游上新模型不用升级插件；拉取失败时退回内置清单，分组不会消失。


- **能力完整**：流式输出、思考过程（reasoning）、工具调用（tool calls）、图片输入均已实测通过。

| 模型 ID | 后端 | 图片输入 |
|---|---|---|
| `codely-core` | GLM-5.3 | ✅ |
| `codely-flash` | DeepSeek-V4.1-Flash | ✅ |
| `codely-basic` | DeepSeek-V4.1-Flash | ✅ |
| `codely-air` | DeepSeek-V4.1-Flash | ✅ |
| `codely-vl` | Vision | ❌（纯文本） |


- **推理档位**：`low` / `high` / `max`，已对每个模型实测通过。其余档位不声明，避免选择器给出上游会忽略的选项。


- **自动续期与故障恢复**：网关返回 401/403 时自动换新密钥并重放一次请求；凭据文件每 30 秒扫描一次，App 里重新登录后 30 秒内自动恢复，无需重启 DSH。


- **账号检测**：`dsh-tuanjie-connect status` 直接显示登录账号、邮箱、令牌剩余有效期、**剩余额度**和模型密钥健康度；`doctor` 输出不含密钥的诊断信息（路径、令牌到期、密钥状态）。两者都支持 `--json`，且**输出里永不包含令牌**（自动脱敏）。

```console
$ dsh-tuanjie-connect status
Tuanjie Cowork Connect: signed in as WuuShan
Email: 805490972@qq.com
Access token expires 2027-10-08T03:34:26.000Z (364 days; refresh is automatic)
Remaining quota: 9948 points
Model key: ready
Credential file: C:\Users\Administrator\.codely-cli\oauth_creds.json
```

  未登录、令牌被拒、额度耗尽都有各自的明确状态与提示，不会静默失败。


- **积分按订阅额度计**，无法得知单价，因此成本上报为 0。


## 安装


前置：已安装并登录 Tuanjie Cowork 桌面 App（登录的账号决定可用额度）。


在 DSH 侧边栏打开 **插件**（Plugins）→ **添加插件**（Add plugin），粘贴本仓库地址：


```
https://github.com/WuuShan/dsh-tuanjie-connect
```


或者用命令行（`dsh` 在 PATH 中时）：


```sh
dsh plugin --profile desktop add git+https://github.com/WuuShan/dsh-tuanjie-connect.git
```


安装完成后**重启 DSH**，模型选择器里即可看到 Tuanjie Cowork 分组。


**版本对应（重要）**：插件声明的 peer 依赖会在安装时做版本校验，不匹配会被静默跳过（stderr 提示 `skipping profile bundle`）。


| 插件版本 | 要求的 DSH 内核 | 桌面 App |
|---|---|---|
| **0.1.0（当前）** | **`0.2.0-rc.2`** | 内置 `0.2.0-rc.2` 内核的桌面版 |


### 手动安装（无 GitHub 访问时）


```powershell
# 1. 把本仓库放进 profile
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-tuanjie-connect"
New-Item -ItemType Directory -Force -Path "$dst\lib","$dst\test" | Out-Null
Copy-Item .\lib\*.js $dst\lib\
Copy-Item .\package.json, .\cordis.patch.yml, .\LICENSE, .\README* $dst\

# 2. 编辑 $env:USERPROFILE\.dsh\profiles\desktop\package.json，
#    在 dsh.profile.bundles 数组中加入 "dsh-tuanjie-connect"
# 3. 重启 DSH
```


## 更新


插件页**没有升级按钮**（官方说明：既不列出可用版本，也不提供升级操作），所以更新要走命令行。依赖被钉在具体提交上，重新 `add` 一次即可解析到最新提交：


```sh
dsh plugin --profile desktop add git+https://github.com/WuuShan/dsh-tuanjie-connect.git
```


看到 `Packages: +1` 就是拉到了新版本；如果显示 `Already up to date` 说明已经是最新。然后**重启 DSH**。


`dsh` 不在 PATH 时，用应用自带的入口（Windows）：

```powershell
& "E:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add git+https://github.com/WuuShan/dsh-tuanjie-connect.git
```


确认当前装的是哪个提交：

```sh
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\pnpm-lock.yaml" -Pattern 'codeload.github.com/WuuShan'
```


版本变化见 [CHANGELOG.md](./CHANGELOG.md)。


## 命令行


```sh
dsh plugin --profile desktop exec dsh-tuanjie-connect status     # 账号、额度、密钥状态
dsh plugin --profile desktop exec dsh-tuanjie-connect doctor     # 诊断（路径、令牌到期、密钥）
```

两者都支持 `--json` 输出机器可读格式。也可以直接运行：

```sh
node lib/bin.js status
```


## 验证安装


```sh
git clone https://github.com/WuuShan/dsh-tuanjie-connect
cd dsh-tuanjie-connect
node test/protocol.test.mjs   # 34 项：凭据、签名、模型清单、本地端点、流式、工具、图片
node test/account.test.mjs    # 31 项：账号、额度、脱敏、状态路由
```


两套都用你自己的登录态对真实接口检查。全绿即安装可用。


> 这一步会产生少量真实请求，可能消耗额度。


## 它是怎么工作的


Tuanjie Cowork 的模型网关（`codely-litellm.tuanjie.cn`）**不接受单独的 bearer**——只带 `x-api-key` 会被拒（401「由于安全问题，请升级到最新版 Codely」）。必须同时带上 `X-Codely-Signature`：


```
signingKey = HMAC-SHA256( HMAC-SHA256(pepper, "codely-signing-v1"), sk-… )
signature  = "v1." + unix秒 + "." + base64url( HMAC-SHA256(signingKey, "v1\n" + 路径 + "\n" + unix秒) )
```


`sk-…` 是 LiteLLM 虚拟密钥，用 App 的 `access_token` 调 `GET /api/api-token/cli-api-key?teamId=<orgId>` 换得；`pepper` 是编译进客户端的常量。签名覆盖**请求路径**，每个请求都要重算。


因为 pi-ai 的 `streamSimple` 路径不接受自定义 `fetch`，而签名必须按请求注入 header，插件起了一个只监听 `127.0.0.1` 的本地端点：pi-ai 对它说标准 OpenAI，它负责签名后转发。上游密钥只留在插件进程内，pi-ai 拿到的是每次运行重新生成的随机 bearer。网关用 `reasoning_content` 返回思考内容，pi-ai 原生解析该字段，无需自定义解码。


账号检测走控制面的两个接口：`/auth/external/me`（账号信息）与 `/api/user/usage/summary`（剩余额度与分池明细）。同一个本地端点也提供 `/status` 路由，供设置卡片等本机消费者读取——同样需要 bearer，且响应中不含任何密钥。


### 配置


两个可选项（默认就是 App 的位置，一般不用填）：


| 配置 | 默认值 |
|---|---|
| `authFile` | `~/.codely-cli/oauth_creds.json` |
| `orgFile` | `~/.codely-cli/org.json` |


环境变量：`DSH_TUANJIE_AUTH_FILE` / `DSH_TUANJIE_ORG_FILE`（覆盖文件路径）、`DSH_TUANJIE_POLL_MS`（凭据扫描间隔，默认 30000）。


## 已知限制


- **依赖 App 的登录态**。App 退出登录后分组消失（模型清单为空）；插件不提供自己的登录流程。
- **依赖未公开的内部接口**。`api-token/cli-api-key`、`/auth/refresh` 和签名算法都是逆向得到的；上游改动会导致失效，届时需按上文「它是怎么工作的」重新对齐。
- **refresh_token 可能失效**（本机实测已失效）。此时 access_token 到期后插件无法自动续期，需要打开 App 重新登录一次；30 秒内自动恢复。
- **`codely-vl` 只声明文本**：网关的 `is_vlm` 没标记它。
- 插件会把换得的 `sk-` 密钥缓存回 `~/.codely-cli/oauth_creds.json`——与 Codely CLI 自身行为一致（同一文件、同一字段）。


## 致谢


本插件的协议层（`lib/codely.js`：认证链路、请求签名、模型清单、本地端点）为逆向 Tuanjie Cowork 客户端二进制与真实网关流量所得。DSH 接缝层（`lib/index.js`）的结构大幅参考了 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（作者 corrinehu，MIT）——包括 loopback shim 架构、`PiAiAdapter` 组装方式与 `ctx.llm.registerAdapter` 注册方式，详见该文件注释与 [LICENSE](./LICENSE) 中的声明。


## 许可


[MIT](./LICENSE)
