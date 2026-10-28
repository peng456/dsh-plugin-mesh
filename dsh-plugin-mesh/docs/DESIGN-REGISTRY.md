# 图标 / 设计 token 注册表

> 运行时唯一数据源：`client/client.js`
> 给人/外部工具读的快照：`client/registry.json`
> 门禁：`node scripts/check-registry.mjs`（挂在 `npm run check`）

## 为什么要有

Mesh 的 UI 是手写 bundle，没有构建步骤。图标和颜色原先散在：

- `BRAND_ICONS`：品牌图标 path + color
- `RUNTIME_ICONS`：运行时名 → 图标别名
- CSS 里的 `--mesh-*: var(--dsw-alias-*)`

只要有一处改漏，就会出现“UI 有图标但注册表没有”或“颜色写死导致主题不适配”。注册表把这三类数据固定成一份可核对的事实。

## 数据结构

`client/registry.json`：

```json
{
  "version": 1,
  "generatedFrom": "client/client.js",
  "icons": {
    "node": { "color": "#5FA04E", "category": "language" },
    "docker": { "color": "#2496ED", "category": "tool" }
  },
  "aliases": {
    "node": "node",
    "python3": "python",
    "claude": "code"
  },
  "tokens": {
    "bg": "--dsw-alias-bg-base",
    "surface": "--dsw-alias-bg-layer-1"
  }
}
```

- `icons`：品牌 icon 名 + 品牌色 + 分类（language / tool / package / ai / os / gpu）
- `aliases`：能力名片里的运行时名 → 图标名；未知项回退 `code` 线性图标
- `tokens`：`--mesh-*` → DSH 主题别名；只允许映射到 `--dsw-alias-*`

## 更新流程

改了 `client/client.js` 的图标或 token 后：

```bash
node scripts/check-registry.mjs --write
node scripts/check-registry.mjs
```

第一条同步注册表，第二条验证一致。`npm run check` 会自动跑第二条。

## 主题约束

- 品牌色固定，不跟主题变灰；深色品牌（Bun/Deno/Apple/Gradle/SQLite 等）用 `currentColor`。
- UI 结构色只能走 `--mesh-*`，不能写死 `#fff`/`#111`。
- 新增 `--mesh-*` token 必须同时有 `--dsw-alias-*` 映射，否则 `check-registry.mjs` 不拦，但主题切换会失效——review 时看这一条。
