# dsh-go 原生 Mesh UI（bridge 面板）—— 移动端重做版

> 任务：task-1（P2 主线）第二轮：**重做 dsh-go 原生 Mesh 面板**。
> 背景：第一版能显示但真机很难看（用户截图：`Mesh 设备` 页同一台设备出现两次、4 个通栏大药丸、
> 没有移动端信息层级；用户原话「他的长这样，我无语了」）。
> 实现：`dsh-plugin-mesh/lib/dshgo-ui.js`（host 侧，零 WebView）；`package.json` 的 `dshGo` 清单；
> 自测 `lib/_selftest-dshgo-ui.mjs`。`client/client.js`（Web 模式）由 Lead 另行处理，本改动不碰。
> 真机验收由 Lead 做；本文给结构、组件清单、limits 实测、验收点/失败判据、风险与取舍。

---

## 0. 这版改了什么（对照真机截图）

| 真机症状（第一版） | 这版 |
|---|---|
| 「Mesh 设备」页同一台设备出现两次：list 行 + `options` 选择器行 | **删掉所有 `options` 组件**；选中设备改用 **list 行 action**（行可点 → 同面板切详情）。全仓库 0 个 options。 |
| 4 个按钮全是通栏大药丸、没有层级 | 按屏收敛动作数：home 4（仅刷新 primary）、peers 2（打开网页 primary）、tasks 1（刷新）、detail 2（打开网页 primary）、config 6；**每屏至多 1 个 primary**。 |
| 没有头像/系统 logo、在线徽章、任务状态色 | 设备行 icon 按平台（android→robot / win32→terminal / darwin→image / linux→code），trailing 显示 `12ms`/在线/上次见过，tone=good/muted；任务行出/入站 icon + 状态 tone（成功 good、失败 bad、进行中 warn）。 |
| 信息层级平铺 | home 首屏：**metric 行（在线/任务/通道）→ 在线设备 list → 最近任务 list → 导航型快捷动作 → 底部一句提示**；设备/任务各自可点进行。 |
| 设备页还混着派发/探测/复制 | **产品收敛**：设备页只有「刷新 / 打开网页」两个动作；设备详情只有「打开网页 / 返回」+ 信息展示；home 快捷动作是导航型（刷新 primary / 设备列表 / 打开网页 / 调整主页）。**原生 UI 不再派发任务/探测**（只在完整 Web 面板做），避免误触唤醒对端 agent。 |

---

## 1. 清单（`package.json` → `dshGo`）

```jsonc
"dshGo": {
  "v": 1,
  "title": { "zh": "设备互联", "en": "Mesh" },   // 插件名 ≤24 字
  "icon": "team",
  "contributes": {
    "composer.strip": [{ "id": "mesh-status", "icon": "team", "panel": "peers" }],
    "panels": [
      { "id": "home",  "title": { "zh": "Mesh", "en": "Mesh" },    "icon": "team",
        "placement": ["session.tab", "features"] },              // 默认入口，排第一
      { "id": "peers", "title": { "zh": "设备", "en": "Devices" }, "icon": "team",
        "placement": ["session.tab", "features"] },
      { "id": "tasks", "title": { "zh": "任务", "en": "Tasks" },   "icon": "todo",
        "placement": ["session.tab", "features"] }
    ]
  }
}
```

- 面板上限 4 / 插件、标题 ≤16 字、strip ≤1（bridge `manifest.js`/`limits.js`）；本清单 3 面板 + 1 strip。
- 没有 `wants` / `capabilities`：面板点按拿不到 clipboard/draft/message context（`routes.js:18`），
  本版也不需要（原生 UI 不读剪贴板、不派发）。
- 官方 kit 清单校验：`原生界面能显示（状态条 1 · 面板 3）`，0 error（见 §6）。

---

## 2. 信息架构（3 面板 + 面板内子视图）

```
home（默认）
├─ home 主视图
│  ├─ row:  metric 在线 / metric 任务 / metric 通道
│  ├─ text「在线设备」+ list（≤5 行，行 action → home 详情）
│  ├─ text「最近任务」+ list（≤3 行，行 action → tasks 面板）
│  ├─ actions: 刷新(primary) / 设备列表 / 打开网页 / 调整主页
│  └─ text（muted）：本机名 · N/M 在线 · 通道 · 引导语 / 截断提示
├─ detail（同一面板内切换）：keyValue（8 项）+ actions: 打开网页(primary) / 返回
└─ config（同一面板内切换）：「调整主页」list 行选中 + 上移/下移/显示隐藏 + 保存(primary)/恢复默认/返回

peers
├─ list：metric 在线（caption 兼作空态说明）+ 设备 list（行 action → peers 详情）
│        + actions: 刷新 / 打开网页(primary)
└─ detail（同一面板内切换）：keyValue + actions: 打开网页(primary) / 返回

tasks
└─ list：row: metric 入站 / metric 出站 + 任务 list（行 action 复制完整 ID）+ actions: 刷新(primary) + 提示 text
```

为什么是「面板内切子视图」而不是多开面板：bridge 面板之间没有切页 API，只有 `{open:"panel:<id>"}`
（且面板配额 ≤4）。设备详情放进 home/peers 各自面板的 `homeMode`/`peersMode` 状态里：
**不新开面板、不占配额、同屏不会同时出现设备列表 + 设备详情（这是"同一台设备出现两次"的结构性修复）。**

`composer.strip` 保持 `Mesh · N 在线 · usb/lan`（≤24 字），点它打开 peers 面板。

---

## 3. 每个面板的组件 + 数据绑定

| 视图 | 组件（节点数/深度） | 主要绑定/data |
|---|---|---|
| `home` 主视图 | stack(1) + row(1) + metric×3 + text×2 + list×2 + actions + text = **11 节点 / 深度 3 / ~0.98KB** | `onlineLabel` `onlineTone` `onlineCaption` `taskCount` `taskTone` `taskCaption` `channelLabel` `channelTone` `deviceRows` `taskRows` `hint` |
| `home` 详情 | stack + keyValue + actions = **3 节点 / 深度 2 / ~0.25KB** | `detailItems`（设备/状态/地址/系统/版本/通道/能力/最后活跃，8 项） |
| `home` 调整页 | stack + text + list + actions×2 + callout = **6 节点 / 深度 2 / ~0.6KB** | `cfgRows`（4 行，行 action=`selectWidget`）+ `cfgHint` |
| `peers` 列表 | stack + metric + list + actions = **4 节点 / 深度 2 / ~0.38KB** | `onlineLabel` `onlineTone` `summary`（caption）`rows`（行 action=`openPeer`） |
| `peers` 详情 | 同 home 详情（**3 节点 / 深度 2**） | `detailItems`（与 home 详情共用 builder） |
| `tasks` | stack + row + metric×2 + list + actions + text = **7 节点 / 深度 3 / ~0.44KB** | `inboundCount` `outboundCount` `rows`（行 action=`copyTask`）`hint` |

- 所有视图都只有 SKILL.md 组件表里的**稳定 v1 组件**：`stack`/`row`/`text`/`metric`/`list`/
  `keyValue`/`actions`/`callout`。**不使用** `options`、不碰 v2 控件（toggle/divider/badge…）。
- 视图 = 静态骨架 + `{ "$": "data.…" }` 绑定；行数/内容/显隐由 data + state 决定。
- 实测 limits：最坏视图 11 节点 / 深度 3 / ~1KB，远低于 120 节点 / 8 层 / 32KiB；
  最大数据（60 台设备 + 60 条任务）仍 < 3.5KB（上限 32KiB），且超限会自动截断 + `truncated`。

### 3.1 行内交互（点按 → action 映射）

| 位置 | 行/按钮 | action | 效果 |
|---|---|---|---|
| home 在线设备行 | 任意设备行 | `openHomePeer` (args `{id}`) | 记录选中 + `homeMode=detail` + `{refresh:true}` |
| home 最近任务行 | 任意任务行 | `openTasks` | `{open:"panel:tasks"}` |
| home 快捷动作 | 刷新 / 设备列表 / 打开网页 / 调整主页 | `refresh` / `openPeers` / `openWeb` / `openConfig` | `{refresh:true}` / `{open:"panel:peers"}` / `{open:"web"}` / 切 config |
| home/peers 详情 | 打开网页 / 返回 | `openWeb` / `closeHomePeer`·`closePeer` | `{open:"web"}` / 回列表 |
| peers 设备行 | 任意设备行 | `openPeer` (args `{id}`) | 记录选中 + `peersMode=detail` + `{refresh:true}` |
| peers 动作 | 刷新 / 打开网页 | `refresh` / `openWeb` | — |
| tasks 任务行 | 任意任务行 | `copyTask` (args `{id}`) | `{copy:id, toast:"已复制任务 ID"}`（≤40 字 toast） |
| 调整主页行 | 任意 widget 行 | `selectWidget` (args `{index}`) | 记录 cursor + `{refresh:true}` |
| 调整主页按钮 | 上移/下移/显示隐藏/保存/恢复默认/返回 | 同名 action | 改草稿/写 `homeWidgets`/回主页 |

自测会断言：**视图和 data 行里引用的每个 action id 都真在对应面板的 actions 映射里**
（没有"画出来却点不动"的死按钮）；且 home/peers 不再注册任何 `probe*/copy*` 动作。

---

## 4. 数据来源与刷新

- 数据仍来自 mesh 现有快照：`discovery.peers()`、`getSelf()`（selfRecord）、`getTasks()`
  （inbound/outbound 内存 + 持久化历史）。**不改 discovery、派发、协议任何一行。**
- data 函数 `(scope, emit, caps) => cancel`：首帧立即 emit；之后 250ms 节流（= bridge `dataHz` 4Hz）+
  5s 定时刷新（rtt/在线状态自愈）+ `discovery.on("change")` 触发（同一节流）。
- 面板内切子视图/保存布局后用 `st._kick()` 立即排一次推送，不必等 5s。
- 超限兜底：紧凑 JSON >32KiB 时按序丢 `deviceRows/taskRows/rows/cfgRows/detailItems` 尾巴并标
  `truncated`；仍超限给一句说明；视图超限退化成一张说明卡。**任何越限都不抛。**
- `cancel` 清定时器 + change 监听；插件卸载 `ctx.effect(() => () => ui.dispose())` 兜底；
  桌面 DSH（无 `dshGo` 服务）整个模块 no-op。

### 4.1 主页布局持久化（`调整主页`）

沿用第一版模型：state.json 的 `homeWidgets`（与 settings 同机制）：
`[{id:"self"|"devices"|"tasks"|"quick", visible:boolean}]`。
- `normalizeHomeWidgets()` 防手改坏：未知/重复丢弃、缺失补齐、全隐藏时至少留一项、垃圾输入回默认。
- 本版 `self` 不再是"本机状态卡"，而是顶部 **metric 概览行**（id 不变，老配置无需迁移）。
- 保存/恢复默认写 `deps.saveState({ homeWidgets })`；读失败用默认、写失败只 toast。

---

## 5. 组件/视觉层面的取舍（写给真机验收的人）

1. **为什么没有系统 logo 图片**：`image.src` 只支持 `/dsh-go/v1/…` 同源路径或 ≤64KiB data URL，
   kit schema 里另有 `asset:` 形式，但**没法在真机验证**哪种路径 App 真能加载。按任务要求不赌 →
   一律用 kit icon（android→robot、win32→terminal、darwin→image、linux→code、未知→team）。
2. **为什么设备页没有 callout**：产品决定（设备页保持 metric + list 干净）；且 v1 视图无法条件隐藏
   组件，空态说明改放在 metric 的 caption（"还没有发现其他设备：确认对端已装 mesh 并开启"）。
3. **metric 的 tone 限制**：kit 的 `metric` 只认 `good/warn/bad/info`（不接受 `muted`），
   所以空态用 `info`、无通道但有设备用 `warn`；有失败任务时任务 metric 标 `bad`。
4. **3 个 metric 放一行**：App 的 `row` 窄屏会自动折行；即使折成 2+1 也仍是 3 块统计，不会破版。
5. **原生 UI 不再派发/复制**：`index.js` 仍注入 `sendProbe`，但本模块不再调用（自测断言
   `sendProbe` 调用次数 = 0）。派发/探测/复制地址只在完整 Web 面板做。
6. **无自定义颜色/字体/动画**：bridge 协议不允许，观感由 App 的主题决定。

---

## 6. 校验与自测（本机可复现）

### 6.1 官方 kit：清单 + 真视图

```powershell
cd E:\mesh
# ① 真实插件目录（清单/包/宿主半侧加载）：0 error
node .tmp\dshgo-kit\kit\bin\check.mjs dsh-plugin-mesh --load
```

实际输出（0 error；`提示` 不是 error）：

```
dsh-plugin-mesh 0.5.4-dshgo.9
  提示 /engines/dsh：没写 engines.dsh：…
  原生界面能显示（状态条 1 · 面板 3）
  已加载宿主半侧：1 项可用；注册了工具：mesh_peers、mesh_scan、mesh_run、mesh_tasks
```

> 为什么这条命令看不到「视图 …能显示」：kit 的 `--load` 用自带 stand-in host 跑 `apply()`，
> 该 host 只提供 `tools/sessions/commands`，没有 web-server 服务，插件的 `registerUiRoutes`
> 在 UI 注册之前就失败（插件自身 try/catch 吞掉并停用，属 kit host 的既有局限，与本改动无关）。
> 因此视图校验用下面 ② 的 shim（同一份 `dshgo-ui.js` + 同一份 `dshGo` 清单）和 ③ 的数据绑定版。

```powershell
# ② 用 shim 让官方 CLI 真正渲染/校验三面板视图（shim 在 .tmp，gitignore，可重建）
node .tmp\make-ui-check.mjs                 # 生成 .tmp/mesh-ui-check（真实 manifest + 真实 dshgo-ui.js）
node .tmp\dshgo-kit\kit\bin\check.mjs .tmp\mesh-ui-check --load
```

实际输出（12 条视图全部「能显示」，exit 0）：

```
dsh-plugin-mesh-ui-check 0.5.4-dshgo.9
  原生界面能显示（状态条 1 · 面板 3）
  已加载宿主半侧：4 项可用
  视图 home · session.tab · zh-CN（面板）：能显示      …（home/peers/tasks × session.tab/features × zh/en，共 12 条）
```

```powershell
# ③ 解析 data 绑定后再过官方 view-check（更严：list 行 action/文案/tone 都会被逐项检查）
node .tmp\validate-views.mjs
```

实际输出：18 个视图变体（home/空态/详情/调整页/peers/空态/详情/tasks/空态 × 中英）
`PASS (18 view variants, 0 failing)`；home/peers/tasks 数据分别 ~2.1KB / 1.0KB / 0.8KB。

> ①②③ 的辅助脚本在 `E:\mesh\.tmp\`（`make-ui-check.mjs`、`validate-views.mjs`、`run-kitcheck.mjs`），
> `.tmp/` 被 gitignore；如需重建，按本节命令即可。② 的 shim 只替换宿主接线，视图代码与清单都是真实的。

### 6.2 离线自测

```powershell
cd E:\mesh\dsh-plugin-mesh
npm run selftest:dshgo-ui    # 49 通过 / 0 失败
npm run check                # 语法/TDZ/peerdeps/registry/loadable/docs
npm test                     # 全链（≈90s，网络免费）
```

自测覆盖（49 例）重点：

- 桌面 no-op / inject 抛错 / panel 抛错 / 永不抛；
- 注册 3 面板 + strip、home 第一；home/peers 无 probe/copy 动作、无 `selectPeer`；
- **所有视图无 `options` 组件**；每个 actions ≤4 项、每屏 ≤1 primary；视图/data 行动作 id 全部有处理函数；
- **设备详情视图没有 list**（同屏不重复设备）；peers 行设备 id 唯一；
- home 默认 = metric 行 + 设备 list + 任务 list + 4 导航动作（刷新 primary）、设备行带 `openHomePeer` args；
- peers = metric + list + 「刷新/打开网页(primary)」，无 text/callout、无 hint 数据；
- tasks 状态 tone 合法（失败 bad）、行 action=`copyTask`；入/出站 metric；
- **遍历所有点按回调后 `sendProbe` 调用 0 次**；
- 空态/截断/垃圾输入不抛、data ≤32KiB；4Hz 节流、cancel/dispose；strip ≤24 字；
- 视图节点数对照（peers 5→4、detail 4→3、home 11、config 6、tasks 7）。

---

## 7. 真机验收（App 原生界面）

前置：手机装含本改动的 `dsh-plugin-mesh` → App「本机引擎 → 重启引擎」（改 `lib/` 必须重启）。
入口：对话详情 →「插件」页签；或「全部功能 → Plugins → 设备互联」。

### 7.1 应该看到什么

1. **home（默认入口，标题 `Mesh`）**：第一行三块统计 `在线 2/3` / `任务 4` / `通道 usb/lan`；
   下面「在线设备」列表（每行：平台 icon + 设备名 + `系统 · 地址` + 右侧 `3ms`/在线/上次见过，
   在线行绿色调）；再下面「最近任务」（`对端 · 短ID`、时间/线程、右侧状态色）；再往下 4 个动作：
   **刷新（蓝色 primary）**、设备列表、打开网页、调整主页；底部一行灰色提示
   （本机名 · 2/3 在线 · lan/usb · 点设备看详情 · 点任务看全部）。
2. **点任一设备行**：页面切「设备详情」（同一面板内），显示 8 行信息
   （设备/状态/地址/系统/版本/通道/能力/最后活跃），下面只有 **打开网页（primary）** 和 **返回**；
   **同屏没有第二个设备列表行**，也**没有复制地址/派发探测**。点返回回到 home。
3. **peers 面板（标题 `设备`）**：顶部 `在线 2/3` metric（caption 是 `usb/lan · 2/3 在线 ·
   点按设备查看详情`），下面设备列表（行可点），底部只有 **刷新 / 打开网页（primary）** 两个动作；
   **没有 options 选择行、没有第二份设备行、没有 callout、没有复制/派发**。点设备行 → 同面板详情 → 返回。
4. **tasks 面板（标题 `任务`）**：两框 `入站 2 / 出站 2`；任务列表每行左侧 mail（入）/link（出）icon，
   中间 `对端 · 短ID` 与 `时间 · #线程`，右侧状态（ok→绿、fail→红、dispatched→琥珀）；只有「刷新」动作；
   点任务行 → toast「已复制任务 ID」。
5. **调整主页**：home 点「调整主页」→ 同一面板切「调整主页」：4 行 widget（1.概览 / 2.在线设备 /
   3.最近任务 / 4.快捷动作，显示中/已隐藏），点一行选中（右侧「已选」），再上移/下移/显示隐藏，
   「保存」后自动回 home 且布局生效；重启引擎后仍保持。**这里也没有 options 选择器。**
6. 输入框上方状态条：`Mesh · N 在线 · usb/lan`，点它打开 peers。

### 7.2 失败判据（怎么判断"没生效"）

| 看到 | 说明 |
|---|---|
| 仍是一屏 4 个通栏大药丸、设备出现两次（列表 + 选择器行） | 手机上还是旧版：确认装的版本、App「引擎」页重启引擎（`lib/` 改动必须重启才生效）。 |
| 面板标题仍是「Mesh 设备 / Mesh 任务」 | 旧清单（package.json `dshGo` 会热重读，但建议一并重启）。 |
| 设备页出现「刷新/复制地址/打开网页/派发探测」四个动作 | 旧版；需重启引擎装到新 `lib/`。 |
| 面板不出现 / 只有一行「Mesh 面板暂时不可用」 | 插件未装/未启用或视图构建失败；看引擎日志应有 `mesh: dsh-go 原生 UI 已就绪：面板 home/peers/tasks、状态条 mesh-status`。 |
| 行里全是「—」/空列表 | 没有发现对端或数据未推上来；桌面 DSH 无 bridge 时本模块 no-op（正常）。 |
| 点设备行没反应 | 检查 App 版本是否支持 list 行 action（协议 v1 应有）；日志会有 `no-handler`。 |

辅助定位：`GET /dsh-go/v1/inventory`（需 token）`packages` 应含 `dsh-plugin-mesh`，
`slots`/`occupancy` 能看到 `home`/`peers`/`tasks`。

### 7.3 回滚

- 只恢复默认布局：App「调整主页 → 恢复默认」，或改 `state.json` 删 `homeWidgets` 键。
- 想关整套原生 UI：回退本 commit，或临时删 `package.json` 的 `dshGo` 块并重启引擎。
- 桌面完全不受影响（无 `dshGo` 服务 → `ctx.inject(['dshGo'])` 不执行）。

---

## 8. 风险与边界

1. **依赖 bridge 0.4.0 + App 0.9.7 的 v1 协议**：只用 `panel/strip/list/metric/actions/keyValue/
   callout/text/row/stack` + `refresh/patch/open/toast/copy`。App 若不支持 `open:"panel:<id>"`，
   「设备列表」按钮会只 toast 不跳转（其余不受影响）。
2. **options 全删是结构性修复**：旧版 list + options 在 App 里是两组重复 UI，这是"同一台设备出现
   两次"的根因；现在选中设备只靠 list 行 action。**不要再把 options 加回设备页。**
3. **产品收敛**：原生 UI 不做派发/探测/复制地址（避免误触唤醒对端 agent）；这些只在完整 Web 面板。
   `sendProbe` 仍由 `index.js` 注入但本模块不调用（自测断言 0 次）。
4. **空态没有 callout**：v1 视图无法条件隐藏组件，空态说明放在 metric caption；如果以后 App 支持
   条件渲染或 `callout` 绑定空值不渲染，可再改回 callout。
5. **metric tone 不支持 muted**（kit 限定）；空态用 info，避免 App 忽略非法 tone。
6. **homeWidgets 兼容**：`self` id 保留但语义变为顶部 metric 行；老用户配置无需迁移。
7. **版本号未 bump**：仍 `0.5.4-dshgo.9`（由 Lead 统一 bump）；诊断接口与包版本应保持一致。
8. **Web 模式落点**（打开 Web 即落在 Mesh 面板、Android WebView UA `; wv)` / 窗口 <700px）由
   Lead 在 `client/client.js` 处理，不在本 commit 范围内。

---

## 9. 关键位置索引（实现内）

| 内容 | `lib/dshgo-ui.js` |
|---|---|
| bridge limits / 本模块预算 | `BRIDGE_LIMITS`、`LIMITS` |
| 主页布局（目录/默认/归一化/读写） | `HOME_WIDGETS`、`DEFAULT_HOME_WIDGETS`、`normalizeHomeWidgets`、`loadHomeWidgets`、`saveHomeWidgets` |
| 设备/任务投影 | `displayName`、`platformLabel`、`peerIcon`、`peerSubtitle`、`peerStatusText`、`addressOf`、`capabilityOf`、`peerRow`、`peerDetailItems`、`taskRow`、`taskTone`、`flattenTasks` |
| 视图构造 | `buildHomeView`、`buildPeerDetailView`、`buildHomeConfigView`、`buildPeersView`、`buildTasksView` |
| 数据构造 | `buildHomeData`、`buildPeersData`、`buildTasksData`、`buildStripData` |
| 注册/清理 | `createDshGoUI`、`registerDshGoUI` |
| 接线 | `lib/index.js`：`import { registerDshGoUI }`；apply 内「5) dsh-go 原生界面」块 |
