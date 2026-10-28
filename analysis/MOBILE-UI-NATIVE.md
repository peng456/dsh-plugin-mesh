# dsh-go 原生 Mesh UI（bridge 面板）落地说明

> 任务：task-10（P2 主线）。给手机 **原生界面**做一套 mesh UI：`home` 首屏（可配置 widget）+ `peers`/`tasks` 二级页 + 输入框上方状态条。
> 实现：`dsh-plugin-mesh/lib/dshgo-ui.js`（host 侧，零 WebView、零 client 改动）；`package.json` 的 `dshGo` 清单；`lib/index.js` 一段 try/catch 接线。
> 真机验收由 Lead 做；本文给验收点/失败判据/回滚。

---

## 0. 交付清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `lib/dshgo-ui.js` | **新增** | 三个面板（home/peers/tasks）+ 状态条 + 全部点按回调；纯函数视图/数据导出，便于离线自测 |
| `lib/_selftest-dshgo-ui.mjs` | **新增** | 39 个离线用例（no-op/注册/视图 limits/数据/home widget/调整页/持久化/限流/清理/永不抛） |
| `package.json` | 修改 | 新增 `dshGo` 清单（v1：2 panel→现 3 panel + 1 strip）；新增 `selftest:dshgo-ui` 脚本并挂进 `test`/`check` |
| `lib/index.js` | 修改（最小接线） | `import { registerDshGoUI }`；apply 末尾 try/catch 调用，注入 `discovery/getSelf/getTasks/sendProbe/loadState/saveState/log/warn` |
| `analysis/MOBILE-UI-NATIVE.md` | 新增 | 本文 |

**没碰**：`client/client.js`、`discovery.js`、`scan.js`、`tsnet/**`、cordis.patch.yml、版本号（仍 `0.5.4-dshgo.2`，由 Lead 统一 bump）。

---

## 1. 清单（`package.json` → `dshGo`）

```jsonc
"dshGo": {
  "v": 1,
  "title": { "zh": "设备互联", "en": "Mesh" },   // 插件名 ≤24 字
  "icon": "team",                               // ui.json icon 白名单
  "contributes": {
    "composer.strip": [
      { "id": "mesh-status", "icon": "team", "panel": "peers" }   // 点状态条 → 打开 peers
    ],
    "panels": [
      { "id": "home",  "title": { "zh": "Mesh", "en": "Mesh" }, "icon": "team",
        "placement": ["session.tab", "features"] },              // ★ 首屏，排第一
      { "id": "peers", "title": { "zh": "Mesh 设备", "en": "Mesh devices" }, "icon": "team",
        "placement": ["session.tab", "features"] },              // 二级页
      { "id": "tasks", "title": { "zh": "Mesh 任务", "en": "Mesh tasks" }, "icon": "todo",
        "placement": ["session.tab", "features"] }               // 二级页
    ]
  }
}
```

- 字段/上限依据：`rootfs:/opt/dsh-go/dsh-go-bridge/lib/native/manifest.js:10-16`（键白名单）、`limits.js:5-49`（panel title ≤16 字、插件名 ≤24、panels ≤4/插件、strip ≤1）。
- **没有 `wants`、没有 `capabilities`**：面板点按**拿不到** clipboard/draft/message context（`bridge:routes.js:18` 的 `CONTEXT_FOR` 只有 composer/message 两个面），"复制地址/ID"用的是 `{ copy }` 效果，不需要读剪贴板。
- 官方校验器（APK 自带 kit，离线跑过）：`原生界面能显示（状态条 1 · 面板 3）`，唯一提示是没写 `engines.dsh`（我们刻意不加：手机/桌面 DSH 都是 0.2.1-rc.2，不想引入额外版本闸门）。

---

## 2. 结构：为什么是「home + open 切换」而不是多开面板

bridge 的 panel 之间没有"切页"API；能跨面板/页面导航的只有 `open` effect：
`{ open: "panel:<自己的 panel id>" }` 或 `{ open: "<App 页面 id>" }`（`bridge:lib/native/effects.js:80-86`；panel id 必须是本插件已声明的）。

因此：
- **home 首屏**里的「设备列表 / 任务队列 / 打开网页」三个入口分别发 `{open:"panel:peers"}`、`{open:"panel:tasks"}`、`{open:"web"}` —— 直达，不是只做展示。
- **「调整主页」不新开面板**，而是在 **home 面板内部**切一个 `config` 视图（面板内状态 `st.mode`，见 §3）。这样不占 panel 配额，也不用处理"调整页自己怎么回去"的导航问题。
- 状态条在 manifest 里直接 `panel:"peers"`（bridge 支持 strip 点按打开自家面板），不需要 `on()` handler。

取舍（已注明）：config 视图没有可点击 checkbox（v1 组件里没有 checkbox；v2 `toggle` 需要 App 协商组件，不能依赖）→ 用 **`options` 选中 + actions「上移/下移/显示隐藏」** 实现，语义等价、全部是稳定 v1 组件。

---

## 3. home widget 配置模型（持久化）

### 3.1 模型

state.json（mesh 自己的 `<profile>/mesh/state.json`，与 settings 同机制）新增一个键：

```json
"homeWidgets": [
  { "id": "self",    "visible": true },
  { "id": "devices", "visible": true },
  { "id": "tasks",   "visible": true },
  { "id": "quick",   "visible": true }
]
```

- `id` ∈ `self`（本机状态卡）/ `devices`（在线设备 ≤5）/ `tasks`（最近任务 ≤3）/ `quick`（快捷入口）。
- **默认全开、顺序即数组顺序**；用户可在「调整主页」里改顺序/显隐。
- 读：`deps.loadState()`；写：`deps.saveState({ homeWidgets })`（都是 index.js 现有模块级函数，原样注入，不新增存储）。
- `normalizeHomeWidgets()` 做防御：未知 id 丢弃、重复去重、缺失的补默认（visible:true）、最多 8 项、**全隐藏时强制第一项可见**、垃圾输入（null/非数组/被手改坏）一律回默认 —— 真机 state 文件可能被人手改。
- 读失败（state.json 损坏）→ 默认布局；写失败 → 界面 toast「保存失败（留在本页）」，不抛、不崩。

### 3.2 四个 widget 的内容（与桌面信息对等，不新增数据源）

| widget | 内容 | 数据来源 |
|---|---|---|
| `self` | 名称 / 地址 `host:port` / 版本 / 通道 `usb/lan` / 在线设备数 | `discovery.selfRecord()`（`machine/host/port/version`）+ peers 的通道集合 |
| `devices` | 在线设备最多 5 行：`● 名称`、`平台/机型 · 地址 · 通道 · 能力摘要`、rtt 或「在线」 | `discovery.peers()`（与桌面 web 面板同一份快照：`osInfo/capabilitySummary/transport/endpoints[].rttMs`） |
| `tasks` | 最近 3 条：时间 / 对端 / 状态（入站 `status`，出站 `ok(200)`/`fail(...)`） | `inbound` / `outbound` 数组（即 `/mesh/v1/tasks` 的同源数据） |
| `quick` | 两行 actions（每行 ≤4）：刷新、探测派发、设备列表、任务队列、打开网页、复制本机地址 | 无需数据；按钮发 effect |

`home` 底部固定一行 actions：**调整主页**。

---

## 4. 视图（严格按 bridge limits）

| 视图 | 节点 | 深度 | 字节 | 上限 |
|---|---|---|---|---|
| `home`（4 widget 全开） | 10 | 2 | ~940 | 120 节点 / 8 层 / 32KiB |
| `home` config（调整页） | 7 | 2 | ~711 | 同上 |
| `peers` | 6 | 2 | ~648 | 同上 |
| `tasks` | 8 | 3 | ~621 | 同上 |

- 视图 = **静态骨架 + data 绑定**（`list.items → {$:"data.deviceRows"}` 等），行数/显隐完全由 data 与 state 决定；`buildHomeView(locale, widgets)` 按布局拼 `children`（顺序/显隐在这里生效）。
- 官方 kit 离线校验：5 个视图（home 中/英、home config、peers、tasks）全部 `View ... (panel): renders`，exit 0（命令见 §8）。
- 每次 `emit` 前按 **紧凑 JSON 字节** 检查 ≤32KiB；超限先丢 `options` 再丢行并置 `truncated:true`、hint 明示；视图超限退化成一张说明卡。**任何越限都截断 + note，不抛。**

---

## 5. 数据刷新与限流

- 数据函数 `(scope, emit, caps) => cancel`：首帧立即 emit；之后 **250ms 节流**（= bridge `dataHz=4`）+ 5s 定时刷新（rtt/在线状态自愈）+ `discovery.on("change")` 事件触发（同一节流）。
- 面板点按触发状态变化时用 `st._kick()` 立即排一次推送（例如切换 config 视图、保存布局后不必等 5s）。
- `cancel`（bridge 在无人订阅/停流时调用）清定时器与 change 监听；插件卸载时 `ctx.effect(() => () => ui.dispose())` 再兜一层。**没有 bridge 的主机（桌面 DSH）整个模块 no-op**（`ctx.inject(['dshGo'])` 回调永不执行）。

---

## 6. 点按（invoke）与 effect 映射

| 动作 | 触发 | 返回 | 说明 |
|---|---|---|---|
| `refresh` | 各面板 actions | `{refresh:true}` | bridge 按来源面板补 id（`effects.js:90-93`） |
| `openPeers` / `openTasks` | home quick | `{open:"panel:peers"}` / `{open:"panel:tasks"}` | 自家 panel 才合法 |
| `openWeb` | home / peers | `{open:"web"}` | App「Web」页面，不是 https 链接（link 只收 https） |
| `copySelf` / `copyAddress` / `copyTask` | home / peers / tasks | `{copy:"…"}` | 面板拿不到剪贴板 context，复制用 effect；≤8000 字 |
| `probe` / `probeQuick` | home / peers | `{toast:"…"}` + 后台派发 | **不用 pending**：pending 需要 App 在 invoke 里带 `stream`，本模块不依赖它；handler 立刻返回，派发在后台跑，失败只 warn |
| `openConfig` | home 底部 | `{refresh:true}` | 切成 config 视图 |
| `selectWidget` | config options | `{patch:{cfgSelected}}` | options 的 id 即 action id |
| `moveUp` / `moveDown` / `toggleWidget` | config actions | `{refresh:true, toast}` | 改草稿；至少保留 1 项可见 |
| `saveConfig` | config actions | `{refresh:true, toast}` | `saveState({homeWidgets})` → 回 home |
| `resetConfig` / `cancelConfig` | config actions | 保存默认 / 不保存回 home | — |

兜底：所有回调包 `safeAction`，异常 → 一条 ≤40 字 toast + `warn`，**绝不把异常抛给 bridge**（连续 5 次违规会让 bridge 关掉整个插件的原生 UI）。

「派发探测」会真的给对端发一条固定任务（`mesh UI 探测：请在回执里报告本机名称与平台`），唤醒对端 agent —— 这是唯一会消耗对端 token 的按钮，UI 文案已写清；实现复用 `mesh_run` 同款 payload/鉴权（`X-Dsh-Mesh-Token`）/outbound 记录，由 index.js 注入的 `sendProbe` 完成。

---

## 7. 真机验收（App 原生界面）

前置：手机装 `dsh-plugin-mesh@0.5.4-dshgo.2`（含本改动）→ App「本机引擎 → 重启」。

### 7.1 入口
- 对话详情 →「插件」页签；或「全部功能 → Plugins」分组（`placement: session.tab/features`）。
- 输入框上方应出现状态条：`Mesh · N 在线 · usb/lan`（点它 → 打开 peers）。

### 7.2 期望（按顺序点一遍）
1. **首屏是 `home`**（不是设备列表），标题 `Mesh`，自上而下：本机状态卡 →（在线设备）→（最近任务）→（快捷入口两行）→ 调整主页 → 提示条。
2. 本机状态卡：名称不是 `localhost`（真机应显示机型/主机名）、地址 `IP:45917`、版本 `0.5.4-dshgo.2`、通道 `usb/lan`、在线设备数 `n/m`。
3. 在线设备：最多 5 行，每行有 `●`、名称、平台（如 `Android 15`）、通道标签、rtt（如 `12ms`）。
4. 最近任务：最多 3 行（时间/对端/状态）；没有任务时提示去桌面 `mesh_run`。
5. 快捷入口：**设备列表 → 打开 peers 面板**；**任务队列 → 打开 tasks 面板**；**打开网页 → App Web 页面**；**复制本机地址 → 剪贴板出现 `name ip:port`**；**刷新** 后数据重取；**探测派发** → 立刻 toast `已派发探测 → 对端名`，随后桌面 `mesh_tasks` 能看到一条 outbound 记录、手机侧对端回执进入本机入站任务（`tasks` 面板可见）。
6. **调整主页**：进入 config 视图；选「在线设备」→ 下移 → 选「快捷入口」→ 显示/隐藏（隐藏）→ 保存 → 自动回 home，且 home 里 devices 位置变了、quick 消失；**重启引擎后仍然保持**（state.json 持久化）。
7. 失败判据：面板不出现 / 打开后只有一行「Mesh 面板暂时不可用」/ 行里全是「—」/ 点按无反应或 toast 报错。
   - 查 App 的 `GET /dsh-go/v1/inventory`（需 token）：`packages` 应含 `dsh-plugin-mesh`，`slots`/`occupancy` 能看到 `home`/`peers`/`tasks`。
   - 查引擎日志：应出现 `mesh: dsh-go 原生 UI 已就绪：面板 home/peers/tasks、状态条 mesh-status`；桌面 DSH（无 bridge）**不应**出现该行（no-op）。
   - 官方 kit（离线，见 §8）若报 `renders` 但真机不显示 → 是 App 端渲染/协议问题，不是视图结构问题。

### 7.3 回滚
- 只想恢复默认布局：App 里「调整主页 → 恢复默认」；或直接改 `state.json` 删掉 `homeWidgets` 键（下次启动回默认）。
- 想关掉整套原生 UI：回退本 commit，或临时把 `package.json` 里的 `dshGo` 块删掉并重启引擎（bridge 的 `clientModules` 不再包含它）。
- 桌面完全不受影响（无 `dshGo` 服务 → `ctx.inject(['dshGo'])` 不执行）。

---

## 8. 自测与离线校验（本机可复现）

```powershell
cd E:\mesh\dsh-plugin-mesh
npm run selftest:dshgo-ui   # 39 通过 / 0 失败
npm run check               # 语法/TDZ/peerdeps/registry/loadable/docs 全过
npm test                    # 全链（含新增 dshgo-ui）全过
```

官方 bridge kit（我从 APK 还原到 `E:\mesh\.tmp\dshgo-kit\`）离线校验清单与视图：

```bash
# 清单：面板 3 · 状态条 1
node /mnt/e/mesh/.tmp/dshgo-kit/kit/bin/check.mjs ./package.json --lang zh
# 视图（5 个全部 renders）
node /mnt/e/mesh/.tmp/dump-views.mjs && bash /mnt/e/mesh/.tmp/w39.sh
```

自测覆盖（39 例）：桌面 no-op、inject 抛错、panel 抛错、注册 3 面板+strip、视图 limits（三面板+config、中英）、peers/tasks 数据与截断、strip ≤24 字、refresh/copy/open/select/probe、home 默认布局/数据对等/截断/loadState 布局生效、normalizeHomeWidgets、config 视图 open/选择/上下移/显隐（至少留一项）/保存（saveState 形状）/保存失败/恢复默认/取消、快捷入口直达、4Hz 节流、cancel 后不再推送、dispose 幂等。

---

## 9. 风险与边界

1. **依赖 bridge 0.4.0 + App 0.9.7**：本实现只用协议 v1（panel/strip/actions/options/list/table/keyValue/text/callout + refresh/patch/copy/open/toast）。App 若不支持 `open:"panel:<id>"`（协议允许但需 App 实现）→ 快捷入口只 toast 不跳转；降级不影响 home 本身。
2. **config 视图没有 checkbox**：见 §2 取舍；用 options + 上移/下移/显隐按钮。
3. **探测派发会唤醒对端 agent**（token 成本）：按钮文案已写「探测派发」，失败只 warn。
4. **面板点按没有 clipboard/draft context**：复制是 `{copy}` 效果，不是读剪贴板；想"粘贴到输入框"这类需求要另做 composer 胶囊（P2 之外）。
5. **state.json 手改**：`homeWidgets` 被手改坏时按默认布局兜底；保存失败只 toast。
6. **不新增数据源**：`peers`/`tasks` 数据与桌面 Web 面板同源；本模块不改 discovery/派发/协议任何一行（唯一"写"是探测派发与 homeWidgets）。
7. **version 未 bump**：仍 `0.5.4-dshgo.2`（Lead 统一 bump）；诊断接口里会显示同一版本号。

---

## 10. 关键位置索引（实现内）

| 内容 | `lib/dshgo-ui.js` |
|---|---|
| bridge limits 常量 / 本模块预算 | `BRIDGE_LIMITS`、`LIMITS` |
| home widget 目录/默认布局/归一化/读写 | `HOME_WIDGETS`、`DEFAULT_HOME_WIDGETS`、`normalizeHomeWidgets`、`loadHomeWidgets`、`saveHomeWidgets` |
| 视图构造 | `buildHomeView`、`buildHomeConfigView`、`buildPeersView`、`buildTasksView` |
| 数据构造 | `buildHomeData`、`buildPeersData`、`buildTasksData`、`buildStripData` |
| 注册/清理 | `createDshGoUI`、`registerDshGoUI` |
| 接线 | `lib/index.js`：`import { registerDshGoUI }`；apply 内「5) dsh-go 原生界面」块（try/catch，注入 deps） |
