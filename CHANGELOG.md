# Changelog

## 0.1.3

修复卡片不显示。

- **补上 exports 字段**：DSH 通过 "./client": "./lib/client.js" 定位浏览器半边，缺失时卡片静默不加载（这是卡片没出现的主因）。
- **改用 DSH 0.2.0 真正的插槽名**：插件页声明的是 `plugins.detail.section`（详情页区块），不是 `settings.plugin.item`。旧名保留注册以便兼容更早的内核。
- 详情区块按 `subject.pkg.name` 过滤，只在自己的 bundle 页面渲染；`subject` 为 null（列表态）时不渲染。
- `test/card.test.mjs` 增加 exports 映射断言与真实插槽名校验（37 项）。

## 0.1.2
