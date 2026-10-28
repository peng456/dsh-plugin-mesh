# P2b 报告：mesh Web 面板手机适配（窄屏布局 + 触控优化，桌面不变）

| 项 | 值 |
|---|---|
| 任务 | task-11（P2b） |
| 提交 | `feat(client): mobile layout for mesh web panel`（单独提交；见 `git log`） |
| 改动文件 | `client/client.js`（手写 bundle）、`lib/_selftest-client.mjs`、本报告 |
| 版本 | 未改（当前 `0.5.4-dshgo.2`） |
| 验收 | `npm run check` **EXIT 0**；`npm run selftest:client` **EXIT 0**（窄屏专项 **12/0** + 原有桌面回归 **48/0**） |
| 未碰 | `lib/index.js`、`package.json`、`lib/dshgo-ui.js`（另一任务并发）、已装副本 |

---

## 0. 一页摘要

| 需求 | 实现 | 证据（`client/client.js:行`） |
|---|---|---|
| 窄屏（≤760px）单列设备卡片 | `DeviceList` 在窄屏加 `is-narrow`，CSS 把每行变独立卡片：单列、间距 10px、`min-height: 64px`、圆角/边框、选中高亮 | `:4171,4187`；CSS `:2281-2300` |
| 触控目标 ≥44px | 设备卡 ≥64px；底部派发主按钮 `min-height:48px`；详情页主操作 `min-height:46px`；折叠头 `min-height:44px`；手机输入框 `font-size:16px`（防 iOS 缩放） | CSS `:2281-2361` |
| 能力/端点信息折叠成「详情」 | 窄屏 `DeviceDetail` 把 `CapabilitySection + ChannelSection + IdentitySection` 收进默认收起的 `Fold("详情", right:"能力 · 通道 · 身份")`；宽屏仍是原来的三段直接铺开 | `:4345-4360` |
| 任务派发区 → 底部固定操作条 + 可展开面板 | 新增 `MobileDispatchBar`：常态一条底部栏（在线设备数 + 主按钮）；点开在条上方展开完整 `DispatchPanel`（复用同一组件，不复制业务逻辑）。窄屏 `HomeBoard` 不再重复渲染内联派发卡 | `:8137`（组件）、`:8001`（HomeBoard 去重）、`:8866`（MeshApp 渲染） |
| 在线状态 / transport(lan/usb) 小屏更醒目 | 窄屏设备行底部加徽章：`在线/离线` + `局域网/USB/互联网`（按端点数去重，最多 3 个）；宽屏不渲染 | `:4128-4137`（DeviceRow）、`:2536`（`peerTransportBadges`） |
| 空态 / 错误态适配 | CSS 放宽 `.mesh-empty` / `.mesh-error` 左右留白与行高；列表空态文案在窄屏可换行 | CSS `:2356-2359` |
| 桌面渲染保持现状 | 所有移动分支由 `useNarrowViewport()` 控制、默认 `false`；CSS 全部在 `@media (max-width: 760px)` 内；原有 48 项桌面断言全过 + 新增宽屏反向断言 | `:2477-2565`；`_selftest-client.mjs` 宽屏用例 |

---

## 1. 断点策略

| 项 | 取值 | 说明 |
|---|---|---|
| JS 断点 | `MOBILE_MAX_WIDTH = 760` | `isNarrowViewport()` 用 `matchMedia("(max-width: 760px)")`，同一行与 CSS 注释互相钉住（改一处必须改另一处） |
| CSS 断点 | `@media (max-width: 760px)` | 追加在原有 `767px` 块之后 —— 同特异性下"后写覆盖"，不会与既有 `640/720/767/900px` 规则打架 |
| 已有断点 | 保持不动 | `900px`（分栏→列表/详情单页）、`767px`（能力面板底部抽屉）、`640/720px`（顶栏换行、表格密度）全保留 |
| 容器查询 | 未采用 | 手写 bundle 不能加构建步骤；且 dsh-go island 嵌入时面板宽度≈视口宽度，媒体查询足够。若后续出现"面板比视口窄很多"的宿主，再补 `@container`（需要宿主容器声明 `container-type`） |
| 默认方向 | **宽屏优先** | 无 `window` / 无 `matchMedia` / 探测抛错 → 一律按宽屏渲染（桌面、SSR、旧宿主、单测都是这个分支） |

设备回退：`matchMedia` 不存在时用 `window.innerWidth`（手机 WebView 常见）；连 `innerWidth` 也没有就 false。

---

## 2. 改动点明细

### 2.1 基础能力（`client/client.js:2477-2565`）

- `MOBILE_MAX_WIDTH = 760`；
- `isNarrowViewport()`：同步读取，**任何异常都返回 false**；
- `useNarrowViewport()`：`useState` 初值同步算（桌面不会先闪一下移动布局），`useEffect` 订阅
  `matchMedia change` + `resize`，卸载时解绑；同时兼容 `addListener/removeListener`（旧 Safari/WebView）；
- `peerTransportBadges(peer)`：把 `peer.endpoints[]` 的 `transport` 去重成
  `USB / 互联网 / 局域网`（顺序按端点到达顺序，最多 3 个）；`endpoints` 缺失时回退 `peer.transport`；坏输入返回 `[]`。

### 2.2 CSS（`client/client.js:2281-2361`，新增 `@media (max-width: 760px)` 块）

```css
.mesh-list.is-narrow { display:flex; flex-direction:column; gap:10px; padding:8px 10px 16px; }
.mesh-list.is-narrow .mesh-row { min-height:64px; padding:12px; border:1px solid var(--mesh-line);
                                 border-radius:14px; background:var(--mesh-surface); }
.mesh-list.is-narrow .mesh-row.is-active { border-color:var(--mesh-accent); background:var(--mesh-surface-2); }
.mesh-list.is-narrow .mesh-row-name { font-size:15px; }
.mesh-row-badges { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.mesh-mobile-bar-wrap { flex:0 0 auto; border-top:1px solid var(--mesh-line);
                        padding-bottom:env(safe-area-inset-bottom,0px); }
.mesh-mobile-bar .mesh-btn { min-height:48px; border-radius:12px; font-size:14px; }
.mesh-mobile-bar-panel { max-height:min(62dvh,520px); overflow-y:auto; overscroll-behavior:contain; }
.mesh-detail.is-narrow .mesh-detail-actions .mesh-btn { flex:1 1 0; min-height:46px; }
.mesh-detail.is-narrow .mesh-fold-head { min-height:44px; }
```
- 底部条是 **flex 子项**（不是 `position:fixed` 盖在内容上）：在 `.mesh-root`（flex column）里
  自动贴底，内容区高度自动让出，**不会遮住列表最后一行**；`env(safe-area-inset-bottom)` 让 Android 手势区/iPhone 小白条不挡按钮。
- 展开面板 `max-height:min(62dvh,520px)` 内部滚动，避免手指误滚整页；`dvh` 不支持的 WebView 会忽略该行（退化为不限高），不影响可用性。
- 未改任何宽屏规则的数值；新增规则只作用于 `.is-narrow` / `.mesh-mobile-*` / 760px 媒体查询内。

### 2.3 组件分支（全部 `narrow` 门控）

| 组件 | 窄屏行为 | 宽屏行为（不变） |
|---|---|---|
| `DeviceRow`（`:4080-4140`） | 加 `is-narrow`；行内追加 `.mesh-row-badges`（在线/离线 + 局域网/USB/互联网） | 原样（无徽章、无 extra class） |
| `DeviceList`（`:4170-4205`） | `.mesh-list.is-narrow`（单列卡片由 CSS 接管） | 原样 |
| `DeviceDetail`（`:4211-4365`） | 根 `.mesh-detail.is-narrow`；`CapabilitySection/ChannelSection/IdentitySection` 收进 `Fold("详情")`（默认收起）；主操作按钮全宽、≥46px | 三个 section 直接铺开（与 0.5.4 完全一致） |
| `HomeBoard`（`:7438/7473/7854/8001`） | `.mesh-home.is-narrow`；**不再渲染内联 `DispatchPanel`**（交给底部条） | 内联派发面板（原有"派发放在最底下"语义） |
| `MobileDispatchBar`（`:8137`） | 底部条 + 可展开面板（复用 `DispatchPanel`） | 不渲染 |
| `MeshApp`（`:8176/8191/8234/8696/8726/8866`） | `narrow` 挂到 `.mesh-root`；新增 `mobileDispatchOpen` 状态；`<main>` 之后渲染 `MobileDispatchBar` | 根 class、DOM 结构、事件全部与之前一致 |

### 2.4 测试可见性（`__test`，`:8968-8973`）

新增导出：`MOBILE_MAX_WIDTH`、`isNarrowViewport`、`useNarrowViewport`、`peerTransportBadges`、`MobileDispatchBar`。
bundle 契约（`window.__ModuleLoader__.load({id:"dsh-plugin-mesh", factory})`、只 require react）**未变**。

---

## 3. 自测（`lib/_selftest-client.mjs`，新入口）

原文件只是 `import "./_selftest-workbench.mjs"` 的兼容入口；现在改成：
**先跑窄屏专项 12 项 → 全绿后动态 import 原来的工作台回归（48 项）**。
跑法不变：`node lib/_selftest-client.mjs`（`npm run selftest:client`）。

### 3.1 窄屏专项（12/12）

| # | 覆盖 |
|---|---|
| 1 | bundle 契约不变 + 新 `__test` 导出存在 |
| 2 | CSS 有 760px 断点、单列卡片 ≥64px、徽章、底部条、主按钮 ≥48px、safe-area、详情折叠、面板；reduced-motion 块仍在且顺序正确（窄屏在前） |
| 3 | **宽屏** DeviceList/DeviceRow：无 `is-narrow`、无徽章、无 USB 文案（桌面外观反向断言） |
| 4 | **窄屏** DeviceList/DeviceRow：`is-narrow` + 徽章包含 在线/USB/局域网 |
| 5 | `peerTransportBadges` 去重、最多 3 个、坏输入不崩 |
| 6 | 窄屏 DeviceDetail：`is-narrow` + `详情` 折叠（right="能力 · 通道 · 身份"）+ 首屏不含能力细节 + 状态仍在 |
| 7 | 宽屏 DeviceDetail：无 P2b 折叠、能力信息直接可见（桌面回归） |
| 8 | `MobileDispatchBar` 收起：`mesh-mobile-bar`、无面板、文案「派发任务」+ 在线数 |
| 9 | `MobileDispatchBar` 展开：`mesh-mobile-bar-panel`、复用完整派发表单（「要对方做什么？」）、按钮变「收起派发」 |
| 10 | 窄屏 HomeBoard 无内联 `.mesh-dispatch`；宽屏 HomeBoard 有（原语义） |
| 11 | `isNarrowViewport`：matchMedia 优先 / 无 matchMedia 回退 `innerWidth`（390→true、1280→false）/ 探测不到→false |
| 12 | `matchMedia` 抛错时按宽屏兜底，DeviceRow/List/Detail 照常渲染；MeshApp 加载态窄屏带 class、宽屏不带 |

### 3.2 桌面回归（原有 48 项，全部通过）

包括：设备行/详情文案、坏数据不崩、能力三种"不知道"、GPU 详情、任务状态、配对、tailnet、
主页卡片顺序（含"派发面板在卡片之后"）、设置页分栏、派发 sheet/面板、锚定传输、`sendToAgent` 等。

### 3.3 关键输出

```text
> node lib/_selftest-client.mjs
窄屏专项：12 通过 / 0 失败
…
全部通过：48 通过 / 0 失败
EXIT=0

> npm run check
✓ 版本号一致：0.5.4-dshgo.2
✓ 无声明前使用（TDZ）
✓ 所有 lib/ 静态 import 的 @deepseek-ai/* 都已在 peerDependencies 里声明
✓ 注册表一致：78 icons / 139 aliases / 12 tokens
⚠ 跳过：缺的是 DSH 运行时依赖，不是磁盘半态。
✓ llms.txt 与 docs/llms.txt 一致（10743 字符）
EXIT=0
```

---

## 4. 人工验收清单（真机 / 浏览器）

### 4.1 手机（dsh-go Web / 手机浏览器 / island 嵌入）

1. 打开 Mesh 面板（≤760px 宽）：
   - 设备页：一行一张卡片，卡片高 ≥64px，名字 15px；行底能看到「在线 / 局域网 / USB」徽章；
   - 点进设备：首屏只有状态 + 探测/发任务两个大按钮；下方「详情」折叠，点开才是能力/通道/身份；
   - 任意页签底部都有「派发任务」条；点开面板填任务能发出去，面板不会盖住列表末尾（可滚到）;
   - 手指点按无"点不中"：按钮/折叠头/输入框都够大；键盘弹出时底部条仍在（iOS `dvh` 面板内滚）。
2. 横竖屏切换：matchMedia change 后布局即时切换（不刷新页面）。
3. 桌面宽度（>760px）：与改版前逐像素等价（可用桌面浏览器窗口拖宽/窄对比）。

### 4.2 桌面

- 设备/任务/设置/主页各页与原版一致（原有 48 项断言 + 人工扫一眼）；
- 宽屏不再有底部派发条，主页派发卡仍在最底下（原有测试已覆盖）。

---

## 5. 风险与回滚

| 风险 | 说明 / 缓解 |
|---|---|
| 底部条在"非全高宿主"里不贴屏幕底 | 它是 flex 子项，贴的是 **Mesh 面板**底部；dsh-go island/手机 WebView 里面板=视口高度，等价于贴底。若某宿主给插件面板 auto 高度，条会落在内容下方（仍可用，不遮挡） |
| `dvh` 兼容性 | 仅用于展开面板 `max-height`；老 WebView 忽略该行 → 面板不限高但仍可滚动（`overflow-y:auto`） |
| iOS 输入缩放 | 派发输入框在窄屏 `font-size:16px`（<16px 会触发聚焦缩放） |
| 安全区 | 底部条用 `env(safe-area-inset-bottom)`；只影响有刘海的设备，其余为 0 |
| island 嵌入的容器宽度 | island 宽度≈面板宽度，媒体查询按视口判；若未来 island 变成"宽屏里的窄容器"，需补容器查询（见 §1） |
| 回滚 | 单提交 3 文件；`git revert <hash>` 即可。无服务端/配置依赖，无数据迁移 |

**未做（留后续）**：设置页/任务页的深度手机化（表格密度、分栏抽屉已由原有 900/767 断点覆盖大部分）、横屏手机的专用布局、容器查询（`@container`）、原生 bridge 面板（另一任务 `lib/dshgo-ui.js`）。

---

## 6. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `client/client.js` | 修改 | 新增窄屏 hook/badges/CSS 块/`MobileDispatchBar`；`DeviceRow/DeviceList/DeviceDetail/HomeBoard/MeshApp` 加 narrow 分支；`__test` 导出 |
| `lib/_selftest-client.mjs` | 重写 | 窄屏专项 12 项 + 动态 import 原工作台回归（48 项）；入口命令不变 |
| `analysis/MOBILE-UI-WEB.md` | 新增 | 本报告 |
