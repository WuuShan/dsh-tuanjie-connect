# 插件卡片顶部剩余额度

用户选择：在插件卡片顶部醒目显示并自动刷新，不增加聊天界面入口。

## 行为

- 在「插件 → Tuanjie Cowork」卡片的标签页上方显示大号剩余积分、更新时间、额度耗尽状态以及「刷新额度」按钮。
- 卡片挂载时查询，此后前台每 60 秒更新；页面隐藏时跳过查询，恢复可见时立即查询。卸载时清除定时器、监听器，并取消未完成请求。
- 请求未完成时不叠加下一次查询；15 秒超时。失败时保留上次成功的余额，明确显示失败与上次成功时间。未登录清除旧余额。
- 使用独立同源 GET `/plugins/dsh-tuanjie-connect/quota`，只读取凭据并请求控制面的 `/api/user/usage/summary`，不兑换密钥、不刷新令牌、不拉取模型清单、不发起生成请求。响应不含用户凭据，并设 `Cache-Control: no-store`。
- 自动刷新同时更新已有状态/额度详情里的总余额；分池数据仍由原来的账号刷新获取。
- 缺失、null、空字符串和非法额度都视为未知，不能显示为 0；只有上游明确返回 0 才显示 0。

## 验证

- `npm run test:offline` 全部通过：8 项转发测试、1 项轮询测试、2 项额度接口测试、70 项原有卡片检查。
- 额度接口测试包含真实本地 HTTP 的 apply 注册路由、GET JSON/no-store、拒绝 POST、只调用单个 usage 接口、不改凭据、不泄露令牌、非法数值处理。
- 真实 Chromium + React 19.2 浏览器验证通过 9 项：顶部显示、手动刷新、60 秒自动刷新、后台暂停/恢复、失败保留上次成功值、零余额与恢复、375px 无横向溢出、登出清空、卸载停止轮询且无浏览器错误。浏览器测试使用模拟余额，预览图也为模拟数据，不代表真实账号额度。
- 单独调用真实额度接口，返回 `state: ready`，验证了数据源可用；未发起模型生成或修改凭据。
- 浏览器验证脚本保留在 workspace 的 `work/ui-harness`；Python Playwright 无法安装时改用本机已有 Node Playwright 与 Chromium。测试工具不加入插件依赖。

## 参考[React useEffect 官方文档](https://react.dev/reference/react/useEffect)、[Playwright Clock 官方文档](https://playwright.dev/docs/clock)。
