# mesh × dsh-go-bridge 原生 UI / 文件通道 落地设计

> 任务：task-3。目标是把 `dsh-plugin-mesh` 做成「在 dsh-go App **原生界面**里可用」（不打开 Web 模式也能看设备/任务、能派发），并给出文件通道与权限/审批的落地方案。
> 前置阅读：`E:\mesh\analysis\DSHGO-INTERNALS.md`（bridge API、启动链路、安装路径）。本文只补充/修正与设计相关的部分。
> 标注：**【实测】**= 本机读到的源码/产物/日志；**【推断】**= 由代码反推；**【待实测】**= 需真机。
> 引用：`bridge:`=`rootfs:/opt/dsh-go/dsh-go-bridge/`（Windows 可读副本 `E:\mesh\.tmp\rootfs-pick\opt\dsh-go\dsh-go-bridge\`）；`dsh:`=`rootfs:/opt/dsh/node_modules/@deepseek-ai/`；`mesh:`=`E:\mesh\dsh-plugin-mesh\`；`apk:`=`E:\mesh\.tmp\apk-x\assets\flutter_assets\assets\`。

---

## 0. 先修正上一份文档的两处表述（Lead 真机事实）

**【实测·Lead 真机】mesh 在 dsh-go 上是活的**：`/mesh/v1/health` 返回 `host:192.168.1.19`、`machine:"localhost"`、`fingerprint:""`、`osInfo.platform:"linux"`（Ubuntu 24.04）、`mac:"00:00:00:00:00:00"`、`cpuCores:0`；桌面发现手机、手机探测桌面都 OK。

由此对 `DSHGO-INTERNALS.md` 的两处修正：

| 位置 | 原表述 | 修正后 |
|---|---|---|
| INTERNALS §6.4 #3 / §7.4 | 「手机上的 `/mesh/api` 不可能被局域网直接访问 → 入站派发必须另想办法」 | **mesh 的 peer 协议不走 DSH webServer**：它自己 `createServer` 并 `listen(port, "0.0.0.0")`（`mesh:lib/index.js:2062`、`:2209`，默认端口 `MESH_DEFAULT_PORT=45917` 见 `:89`），所以 **45917 在局域网可达，入站派发本来就能通**。不可达的只是挂在 DSH webServer 3080 上的 `/mesh/api/*`（UI 路由，需 App token/cookie）。 |
| INTERNALS §7.4 的结论 | 「入站派发是最大结构性问题」 | 真正的结构性问题不是「可达」而是 **入站唤醒后的权限确认**（见 §7）：任务已被接收、会话已建、agent 已跑，但停在「待确认」。 |

**新的边界图（实测 + 源码）**

```
Android 网络
   ├─ 0.0.0.0:45917  ← mesh 自建 http server（peer 协议：health/hello/task/peers/tasks/file…）
   │                    不经过 DSH 中间件，不带 cookie，局域网友好  【实测 mesh:lib/index.js:2209】
   └─ 127.0.0.1:3080 ← DSH webServer（/mesh/api/*、/dsh-go/v1/*、Web UI）
                        只 loopback + route-guard（无 cookie→401/403） 【实测 dsh:dsh-web-app/lib/startup.js:25、dsh-host-webserver/lib/index.js:499-527】
```

**另一个必须记住的数据质量缺口**：真机 health 里 `machine:"localhost"`、`mac:"00:00:00:00:00:00"`、`cpuCores:0` —— 这些是 mesh 在 proot/Android 下取不到的系统信息（`process.platform==="linux"` 走了 Linux 分支，见 INTERNALS §6.4）。**原生 UI 会把这些字段直接摆到用户眼前**，所以 §3 的视图设计里必须做兜底（空值显示「—」而不是 `localhost`/`0`），并把「补系统信息」列入 §9 的 P1。

---

## 1. 设计目标与最小可用路径（TL;DR）

**P0（能列出 peer + 能派发，约 1 个新文件 + package.json 一个块）**
1. `mesh:package.json` 增加 `dshGo` 清单（含 1 个 `composer.actions`、1 个 `message.actions`、1 个 `composer.strip`、2 个 `panels`）。
2. 新增 `mesh:lib/dshgo.js`：`installDshGo(ctx, deps)`，在 `apply()` 里 `ctx.inject(['dshGo'], …)` 后注册面板/状态条/回调。
3. 面板数据直接复用 mesh 现有 `discovery.peers()`（`mesh:lib/discovery.js:503-530`）与入站任务数组（`/mesh/v1/tasks` 同源，`mesh:lib/index.js:2151`）。
4. 派发复用 mesh 现有 peer 派发函数（`mesh:lib/index.js:2393` `peerFetch(target,"/mesh/v1/task")`），走 bridge 的 `pending` 效果等待、`toast` 反馈。

**P1**：任务列表面板、v2 派发表单（可选）、文件通道（选包安装）。
**P2**：自升级（picker 选 tgz → 安装自身）、ui.json island 席位（把完整 Mesh Web 面板嵌进原生界面）。

---

## 2. 清单与接入（task 必答 1）

### 2.1 `package.json` 需要新增的 `dshGo` 块

字段白名单：`{v,minApp,title,icon,wants,assets,contributes,capabilities}`（`bridge:lib/native/manifest.js:10`）；未知字段只是 warn。各 surface 允许的字段见 `bridge:lib/native/manifest.js:11-16`。

建议的声明（`mesh:package.json` 顶层，**不要动现有 `dsh` 块**；`dsh.bundle`/`dsh.client` 与 `dshGo` 可共存，dsh-go-bridge 本身就是这么做的）：

```jsonc
"dshGo": {
  "v": 1,                                  // 必须=协议 1（bridge:lib/native/limits.js:3 PROTOCOL=1）
  "title": { "zh": "设备互联", "en": "Mesh" },   // 插件名 ≤24 字（limits.js:8 pluginTitle）
  "icon": "team",                          // ICON 白名单；team 在列表里（apk:dsh-go-plugin/SKILL.md:82）
  "wants": ["draft", "clipboard", "message"],    // 只有 composer/message 动作能用（见 §4.2）
  "contributes": {
    "composer.actions": [                  // ≤2/插件，label ≤10 字（limits.js:7-8）
      { "id": "dispatch", "label": { "zh": "派发到设备", "en": "Send to device" }, "icon": "link" }
    ],
    "message.actions": [                   // ≤2/插件，label ≤12 字
      { "id": "send-message", "label": { "zh": "发给设备", "en": "Send to device" }, "icon": "link" }
    ],
    "composer.strip": [                    // ≤1/插件，text ≤24 字
      { "id": "status", "icon": "team", "panel": "peers" }   // panel 必须指向本插件声明过的 panel id
    ],
    "panels": [                            // ≤4/插件，title ≤16 字
      { "id": "peers", "title": { "zh": "设备", "en": "Devices" }, "icon": "team",
        "placement": ["session.tab", "features"] },
      { "id": "tasks", "title": { "zh": "任务", "en": "Tasks" }, "icon": "todo",
        "placement": ["session.tab", "features"] }
    ]
  },
  "capabilities": ["files"]                // 仅当要用 §5 的文件通道；否则不要写
}
```

约束与陷阱（全部实测自源码/官方指南）：
- **`id` 全插件唯一**（跨 surface 也算），正则 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$`（`bridge:lib/native/limits.js:69`；重复 id 报 `duplicate-id` error，`manifest.js:131`）。
- `dshGo` 这个对象的 JSON **必须 ≤16KiB**（`limits.js:6` `manifestBytes:16384`，`manifest.js:61-64`）；上面的块约 1KB。
- `contributes` 必须是对象（`manifest.js:98`），每个 surface 必须是数组（`:118`），否则整份清单 invalid。
- panel **必须**有 `title`（`:167-168`），`placement` 可选（缺省 `session.tab`，`:170-176`；`features` 让面板出现在「全部功能」）。
- panel 的静态 `view` 字段是**包内 .json 文件**（`manifest.js:177-184`），我们不用它 —— 改用运行期 `ctx.dshGo.panel(id,{view})` 注册（两者都算 ready，`:265`）。
- 动作「声明了但没有 handler / effect」只会 warn 且 `ready:false`（`manifest.js:234-237,251-252`），不会让插件挂掉 —— 但用户会看到灰掉的胶囊，所以 manifest 里的 id 必须与 `on(id)` 一一对应。
- **`capabilities` 只写真正要用的**：写了 `files` 后，panel 里才能发起 picker（§5），否则 picker 效果会被当作未知效果丢弃（`capabilities.js:163-165`）。

### 2.2 host 侧如何 `ctx.inject(['dshGo'])`、何时注册

官方模板注释写得很直白（`apk:dsh-go-plugin/template-lib-index.js:5-9`）：

```js
export function apply(ctx) {
  // Runs only on hosts with the dsh-go bridge. Write ['dshGo'], never ['dshGo?'].
  ctx.inject(['dshGo'], (ctx) => { … })
}
```

- **必须用 required 形式 `['dshGo']`**：在桌面 DSH（没有 bridge）该回调永远不会执行，于是 mesh 在所有非 dsh-go 主机上行为完全不变 —— 这就是「一份包同时支持桌面与手机」的开关，**不需要** `process.platform` 判断、**不需要**新增配置项。
- 时机：放进 mesh 现有的 `apply()` 里（mesh 的 `apply` 在 `mesh:lib/index.js` 导出 `inject = ["tools","webServer"]`，`:73`）。bridge 的服务在它自己的 `apply` 里 `ctx.provide("dshGo", …)`（`bridge:lib/index.js:263-265`），是**常驻**的（注释：「the service exists whenever the bridge runs (no cost without plugins)」），所以 mesh 的 inject 不会被「服务还没准备好」卡住。
- **调用方式**：必须写成 `ctx.dshGo.panel(...)` 这种**方法调用**。服务方法内部用 `this.ctx` 反查调用者 fiber（`bridge:lib/native/core.js:430-435`），解构（`const {panel}=ctx.dshGo`）会抛 `dshGo: call ctx.dshGo.* as a method from a plugin context`（`core.js:353`）。
- 数据函数只在**有人订阅时**才启动（`core.js:449-465` 建 Feed、`:529-548` start），没人看面板时零开销；最后一个订阅者离开后 `feedLingerMs=30s` 再停（`limits.js:39`、`core.js:642-646`）。→ **可以无脑常驻注册**。

### 2.3 卸载 / 清理

- 每次注册返回 disposer，且注册内部用 `callerCtx.effect(...)` 绑定到**调用方插件的生命周期**（`bridge:lib/native/core.js:371-374`）：插件重载/卸载时 bridge 自动 `#remove`（`core.js:403-411`），**mesh 不需要手动反注册**。
- mesh 自己要负责的是：`data` 函数返回的 **cancel 函数**（`core.js:538-547`；返回非函数会被忽略，抛错会记 violation 并停 feed `core.js:543-547`）、面板/状态条里起的 `setInterval`/`fs.watch`、以及 §5 文件通道落盘后的临时文件清理（bridge 只保证上传缓冲在请求结束后释放，`file-picker-runtime.js:219-222`）。
- 建议模式（与 dsh-go-bridge 的 `ctx.effect` 写法一致）：

```js
const off = ctx.dshGo.panel('peers', { view, data, actions })  // 内部已 ctx.effect 绑定
// data 函数：
function data(scope, emit) {
  const push = () => emit(snapshot(scope))
  push()
  const timer = setInterval(push, 2000)      // 注意 ≤4Hz（limits.js:16 dataHz），2s 很安全
  return () => clearInterval(timer)          // ← 卸载/取消时调用
}
```

---

## 3. 原生视图设计（task 必答 2）

### 3.1 数据来源（复用 mesh 现有内存态）

| 视图需要 | mesh 现成来源 | 字段 |
|---|---|---|
| 设备列表 | `discovery.peers()`（`mesh:lib/discovery.js:503-530`，按「在线 → 刚掉线 → 仅缓存」排序） | `id, machine, host, port, online, restored, lastSeen, transport, channel, sourceAddress, knownAddresses[], capabilitiesStale, capabilitySummary`（`:568-605`） |
| 设备详情 | 同上 `#project` 结果 | `endpoints[]`、`capabilities`（含 `osInfo`、`cpuCores`、`mac`…） |
| 入站任务 | `inbound` 数组（`/mesh/v1/tasks` 取 `slice(-50).reverse()`，`mesh:lib/index.js:2151`） | `id, from, fromMachine, task, thread, receivedAt, transport, status, sourceAddress, dispatchError?`（`:2238-2252`） |
| 选中设备/上次派发 | 需要 mesh 新增一个很小的 UI state（建议放 `mesh:lib/dshgo.js` 内，按 `scope.sessionId` 或全局单例） | — |

**兜底规则**（因真机 `machine/mac/cpuCores` 脏数据，见 §0）：`machine` 为 `"localhost"`/空 → 显示 `host`；`cpuCores:0` → 不显示该行；`capabilitySummary` 空 → 不显示。

### 3.2 视图 1：`peers` 面板（设备列表 + 在线状态 + 刷新/扫描）

视图（静态骨架 + 绑定，**4 节点 / 深度 2 / 329 字节**，限 120 节点 / 深度 8 / 32KiB）：

```json
{
  "type": "stack", "title": "Mesh",
  "children": [
    { "type": "metric", "label": "在线", "value": { "$": "data.online" }, "tone": "good",
      "caption": { "$": "data.caption" } },
    { "type": "list", "items": { "$": "data.rows" } },
    { "type": "actions", "items": [
      { "label": "刷新", "icon": "refresh", "action": "refresh" },
      { "label": "扫描", "icon": "search", "action": "scan" }
    ]}
  ]
}
```

`data`（emit 的对象，限 32KiB、≤4Hz；`null` 会被剥掉）：

```json
{
  "online": "2/3",
  "caption": "最近心跳 12 秒前 · 1 台离线",
  "rows": [
    { "title": "文超-win", "subtitle": "win32 · lan · 192.168.1.10:45917", "trailing": "在线",
      "tone": "good", "icon": "team", "action": { "id": "peer", "args": { "id": "p-1" } } },
    { "title": "hos", "subtitle": "android · lan · 192.168.1.19:45917", "trailing": "在线",
      "tone": "good", "icon": "team", "action": { "id": "peer", "args": { "id": "p-2" } } },
    { "title": "myserver", "subtitle": "上次见到 3 分钟前", "trailing": "离线",
      "tone": "muted", "icon": "team", "action": { "id": "peer", "args": { "id": "p-3" } } }
  ]
}
```

- `list` 的 `items` 允许**绑定**（schema：`$defs.listNode.items` 是 `array | binding`，`apk:dsh-go-plugin/kit-schema-view.schema.json`），所以行数完全动态；每行 `title` 必填、`action` 可选（`{"id":…,"args":…}`，args 解析后 ≤1KiB，`$defs.action`）。
- **待实测**：绑定数据里的 `action` 是否真被 App 接线（数据来自插件，App 需要在渲染时保留 action）。**兜底方案**：行只做展示，另用 `options` 组件选设备 —— `options.id` 本身就是动作 id，`options.options` 也可绑定，点选后 bridge 用 `value={value}` 回调（见 §4.2）。这条一定要真机试，因为它决定 P0 的交互形态。
- 50 台设备的最坏情况：`data` 约 **9,810 字节**（我按同一组行字段实测计算），仍 < 32KiB；`list` 建议自己截到 20 行并显示「还有 N 台」。

### 3.3 视图 2：`tasks` 面板（任务队列）

视图（**6 节点 / 深度 3 / 347 字节**）：

```json
{
  "type": "stack", "title": "Mesh 任务",
  "children": [
    { "type": "row", "children": [
      { "type": "metric", "label": "进行中", "value": { "$": "data.running" } },
      { "type": "metric", "label": "今日", "value": { "$": "data.today" } }
    ]},
    { "type": "table", "columns": ["时间", "来源", "状态"], "rows": { "$": "data.rows" } },
    { "type": "callout", "text": { "$": "data.hint" }, "tone": "info" }
  ]
}
```

`data`：

```json
{ "running": 1, "today": 7,
  "rows": [["12:03", "文超-win", "已收"], ["11:48", "hos", "完成"]],
  "hint": "任务在目标机器的 Mesh 会话里跑，回执会回到原会话。" }
```

- `table.columns`（≤8）和 `rows`（≤50）都支持绑定；单元格是文本/数字/null。
- 需要「正在跑的那条」的进度条时，加 `{"type":"progress","value":{"$":"data.progress"},"label":{"$":"data.currentLabel"}}`（多 1 节点；`progress.value` 必填，0–100 或配 `max`）。
- 若想显示「为什么这条没跑」：mesh 已在任务记录里写 `dispatchError`/`routeDecision`（`mesh:lib/index.js:1626` 注释、`2572-2581` diagnostics），直接映射成 `steps` 的 `status: failed` + `detail`。

### 3.4 视图 3（可选，v2）：`dispatch` 派发表单

0.9.7 的 kit 里已经带了 **view v2**：根节点 `v: 2` 才启用（schema `$defs.node.v` enum [1,2]），v2 提供 `form/textField/select/segmented/toggle/number/...` 与 `bind`（写回 `data.*`）。示例（**4 节点 / 361 字节**）：

```json
{
  "type": "form", "v": 2, "label": "派发任务", "submit": "dispatch", "submitLabel": "派发",
  "children": [
    { "type": "select", "label": "目标设备", "bind": "data.peer", "options": { "$": "data.options" } },
    { "type": "textField", "label": "任务", "bind": "data.task", "multiline": true,
      "maxLength": 2000, "required": true },
    { "type": "toggle", "label": "新会话", "bind": "data.newSession" }
  ]
}
```

- `form.submit` 是 action id；提交时 bridge 回调的 `event.value` 应是绑定后的字段对象（v2 语义，`apk:dsh-go-plugin/kit-schema-view.schema.json` `$defs.formV2/inputV2`）。
- **风险**：v2 组件是否被 App 0.9.7 实际渲染，要看 App 在 `/dsh-go/v1/views` 请求头里 `components=` 协商了什么（bridge 会把它透给视图函数，见 `bridge:lib/native/routes.js:44-66` 和 SKILL 的 `caps.components`）。**不要让 P0 依赖 v2**：先用 v1 的「状态条 + 胶囊 + options」跑通，`view(scope, caps)` 里判断 `caps.components.includes('form')` 再返回 v2。

### 3.5 状态条（`composer.strip`）

- 数据形状固定：`{text?:string ≤24 字, icon?, tone?: good|warn|bad|info|muted}`（`bridge:lib/native/core.js:485-496`）。
- 建议 `emit({ text: onlineCount>0 ? \`${onlineCount} 台在线\` : null, icon: "team", tone: "good" })`；`null` = 空（App 不画）。
- `tone` 只能是那五个值，否则被丢弃（`core.js:494`）。

### 3.6 限流与降级（必须遵守，否则原生 UI 会被关掉）

- 数据 emit 上限 **4Hz**（`limits.js:16`），bridge 会合并到下一次 flush（`core.js:567-598`）；`data` ≤32KiB（`:14`）、`patch` ≤16KiB（`:15`，差量自动算）。
- 视图 ≤32KiB / 120 节点 / 8 层（`limits.js:9-11`）；超了只是 warn + App 截断（`routes.js:207-210`），不会挂。
- **连续 5 次违规**（非法数据/非 JSON/超限/回调抛错）→ 插件 `degraded`，**原生 UI 整个关掉直到插件重载**（`core.js:295-309`、`limits.js:42` `violationsToDegrade:5`）。→ 所有 emit 前先自己 clamp/校验；`emit` 只发对象。
- 面板 `data` 只能 emit **对象或 null**（`core.js:557-562`），数组要包一层 `{rows:[…]}`。

---

## 4. 交互设计（task 必答 3）

### 4.1 invoke 的 payload 与语义（由 bridge 定义）

App → `POST /dsh-go/v1/invoke`（`bridge:lib/native/routes.js:243-317`），插件拿到的 `(scope, event)`：

| 字段 | 内容 | 证据 |
|---|---|---|
| `scope` | `{sessionId?, turnId?, messageId?, callId?}`，另加**声明的** context（`draft`/`clipboard`/`message`，仅 composer/message 面） | `routes.js:18,287-289`、`limits.js:66-68` |
| `event` | `{surface, id, action?, value?, locale, signal?}`；面板 `action` 来自视图里的动作 id，`value` 来自 args/options/confirm | `routes.js:290-293`、`apk:dsh-go-plugin/SKILL.md:117` |
| `userGesture` | 只有 App 认为是用户点按才为 true；**picker 强制要求** | `routes.js:266`、`capabilities.js:166` |
| `stream` | App 的 WS 连接 id（picker 用它绑定） | `routes.js:265`、`file-picker-runtime.js:64` |

关键限制：
- **panel 没有 context**：`CONTEXT_FOR` 只有 composer.actions→[draft,clipboard]、message.actions→[message]（`routes.js:18`）。所以「面板里读剪贴板/草稿」做不到，必须走 composer 胶囊。
- context 只在插件 **wants** 里声明过才发（`routes.js:287-289`）。
- 一次回调 ≤3s（`handlerTimeoutMs:3000`，`limits.js:28`、`routes.js:296`），超时算 violation；慢活用 `pending`（≤60s、每插件并发 2、结果只能是 `insert/copy/toast/patch`，`routes.js:321-372`、`SKILL.md:133-140`）。
- invoke 限速：突发 8 / 持续 4/s / 并发 4（`limits.js:20-22`、`core.js:317-336`）。

### 4.2 mesh 该暴露的动作与效果映射

| 动作（manifest id） | 触发面 | 行为 | 返回效果 | 备注 |
|---|---|---|---|---|
| `dispatch` | `composer.actions`（`wants:["draft"]`） | 把**输入框草稿**当任务正文，派给「当前选中设备」（默认第一台在线；没有就提示） | 慢：`{pending:{label:"正在派发",timeoutMs:60000}, result: async(signal)=>({toast:'已派发给 X'})}`；快：`{toast}` | 派发是网络操作，**一律用 pending**（3s 内回不来）；`pending.label` ≤16 字（`limits.js:44`） |
| `send-message` | `message.actions`（`wants:["message"]`） | 把**被长按的那条回复**当任务派给选中设备 | 同上 | 长回复可能 >2000 字：派发前按 mesh 现有 `minTaskChars`/长度策略截断 |
| `refresh` | `peers` 面板 actions | 重新 emit 一次设备快照 | `{refresh:true}`（面板重取视图）或直接 patch | 视图重取的语义见 `routes.js:130-…`（views 路由） |
| `scan` | `peers` 面板 actions | 触发一次主动扫描（mesh `discovery` 已有） | `{toast:'扫描中…'}` + 完成后 `ctx.dshGo.refresh('peers')` | 扫描可能 >3s → 用 pending 或 fire-and-forget |
| `peer` | 面板行/`options` | 选中设备（只改 UI state） | `{patch:{selected:{…}}}` + `{refresh:true}`？ | patch 会合并进面板 data（`core.js:467-476`） |
| `probe` | 设备详情 actions | 探活 `GET /mesh/v1/health` | `{patch}` 更新该设备行 / `{toast}` | 需要网络，>3s 用 pending |
| `open-web` | 设备详情 actions | 打开桌面 peer 的 DSH Web | `{link:'https://…'}` 仅 https；或 `{open:'panel:peers'}` | **本机** 3080 是 http+loopback，`link` 用不了（只收 https，SKILL.md:128） |
| `install-package` | `tasks`/维护面板 | 见 §5 | picker | 需要 `capabilities:["files"]` |

其他效果语义（`bridge:lib/native/effects.js`、`SKILL.md:120-131`）：

| 效果 | 用在哪 | 注意 |
|---|---|---|
| `insert` | 把「建议的任务文本」放进输入框 | ≤2000 字，**绝不自动发送** |
| `copy` | 复制设备地址/配对码 | ≤8000 字 |
| `toast` | 所有操作的即时反馈 | ≤40 字（超了自动截断并 warn） |
| `link` | 打开外部链接 | 只接受 `https://`，≤2048 字 |
| `open` | `'panel:peers'` 或 App 页面 id | 页面 id 见 ui.json `$defs.page` 枚举（`apk:dsh-go-ui/schema.json`） |
| `command` | 在当前会话执行斜杠命令 | 参数 ≤500 字；不建议 mesh 用 |
| `refresh` / `patch` | 面板数据刷新/合并 | patch 走差量，≤16KiB |
| `pending` | 派发/探测/扫描等慢活 | ≤60s，每插件 2 个并发；`signal` 在取消/超时/断开时 abort |

**userGesture**：只有 picker 强制（`capabilities.js:166`「file selection needs an explicit user gesture」）。胶囊/菜单/面板动作天然是点按，App 会带 `userGesture:true`；不要试图在 `data` 函数里发 picker（`data` 不是点按，`capabilities.js:164` 会以 `bad-effect` 拒绝）。

---

## 5. 文件通道：picker 全流程与「选包安装 / 自升级」（task 必答 4）

### 5.1 bridge 的 v1.3 文件选择契约（**完整时序，全部实测自源码**）

```
 [App 用户点按面板动作]
        │  POST /dsh-go/v1/invoke {surface:"panel", id:"tasks", action:"pick-install", stream:"<welcome.conn>"}
        ▼
 插件回调返回效果: {type:"pickFile", action:"install-package", maxFiles:1}
        │   ── bridge 校验：注册还活着 / conn 有 files 特性 / 没有并发选择 ──
        │   （file-picker-runtime.js:59-82；capabilities.js:159-171）
        ▼
 App 弹系统选择器 → 用户选文件
        │  POST /dsh-go/v1/files/<request>/upload?stream=<conn>&name=<名>&mediaType=<mime>
        │      Content-Type: application/octet-stream   （≤8MiB/个，≤16MiB/总，≤4 个）
        │  POST /dsh-go/v1/files/<request>/complete  {"status":"selected"}
        ▼  （file-picker-runtime.js:102-188）
 bridge 再次调用**同一个 action 名**（effect.action）:
        插件函数(scope, event)  其中
          event.value = {status:"selected", files:[{handle,name,bytes,mediaType,access:"read"}]}
        │  此时才能读字节：ctx.dshGo.readPickedFile(handle) → Buffer
        │   （AsyncLocalStorage 作用域，只在这次回调期间有效；file-picker-runtime.js:22-28）
        │   回调 3s 超时；返回值只允许 insert/copy/toast/link/open/command/refresh/patch，
        │   不允许嵌套 picker、不允许 pending（fileResult 语义，capabilities.js:130-171）
        ▼
 bridge 回 200 {effects:[…]} → App 执行效果（toast/patch/…）
```

硬限制（`bridge:lib/native/capabilities.js:13-17` FILE_LIMITS）：

| 项 | 值 | 含义 |
|---|---|---|
| `count` | 4 | 一次最多 4 个文件 |
| `bytes` | 8 MiB | 单文件上限 |
| `totalBytes` | 16 MiB | 单次选择总上限 |
| `cacheBytes` | 64 MiB | 全局缓存预算（超了 429） |
| `requests` | 8 | 全局并发选择请求 |
| `requestMs` | 5 分钟 | 选择会话存活 |
| `uploadMs` | 30s | 单个上传超时 |
| `nameChars` | 128 | 显示名上限（**只传名字，不传路径/URI**，`file-picker-runtime.js:134-135`） |

→ 结论：**文件通道是「一次性、有大小预算、必须在回调里读完」的只读快照**，不是通用文件系统。

### 5.2 用 picker 做「选一个 .tgz → 交给 mesh 安装插件/升级自身」

mesh 发布包约 **1.58 MiB**（我按 `files` 字段实测统计：lib 619KB + client 497KB + scripts 167KB + sidecar 70KB + 文档/数据 ≈ 1.58MiB），**在 8MiB 单文件上限内** → 技术上完全可行。

建议流程（`install-package` 面板动作）：

1. 面板上放 `{"type":"actions","items":[{"label":"安装包…","style":"plain","action":"pick-install"}]}`（或 v2 的 `form`）。
2. `pick-install` 回调**当场**返回 picker（不要包在 pending 里）：
   ```js
   'pick-install': () => ({ type: 'pickFile', action: 'install-package', maxFiles: 1 })
   ```
   ⚠ 硬约束：**picker 不能出现在 `pending.result` 里**（`capabilities.js:164`：`opts.deferred`/`opts.fileResult` 时 picker 直接判 `bad-effect`）。若要先让用户确认，用 `confirm` 组件，确认动作的回调也当场返回 picker。
3. `install-package` 回调（同一个 panel `actions` 里的函数）：
   ```js
   async function installPackage(scope, event) {
     if (event.value?.status !== 'selected') return { toast: '已取消' }
     const f = event.value.files[0]
     if (!/\.(tgz|tar\.gz)$/i.test(f.name)) return { toast: '只支持 .tgz' }
     const buf = ctx.dshGo.readPickedFile(f.handle)       // ⚠ 必须在本回调内同步/尽快读
     if (buf.length !== f.bytes || buf.length > 8 * 1024 * 1024) return { toast: '文件不完整' }
     const dir = join(meshRoot, 'incoming'); mkdirSync(dir, { recursive: true })
     const file = join(dir, `${Date.now()}-${sanitize(f.name)}`)
     writeFileSync(file, buf)
     // 立刻返回（3s 上限），安装放到后台；failed 时候通过面板数据/日志可见
     spawnDetached('/usr/local/bin/dsh', ['plugin', '--profile', 'web', 'add', file])
     return { toast: '已接收，正在安装…' }
   }
   ```
4. 安装完成后（后台 promise）`ctx.dshGo.refresh('tasks')` 或在面板 data 里带一行 `data.maintenance = "已安装 0.5.5，重启引擎后生效"`；同时清掉 `incoming/` 里的旧包。

**这条路的真实风险（必须写进文档/给用户确认）**
- 装的是**正在运行的自己**：pnpm 会替换 `profiles/web/node_modules/dsh-plugin-mesh`；`lib/*` 的改动**必须重启引擎**才生效（官方 skill 也说「`lib/` 里的代码改了，要重启引擎」`apk:dsh-go-plugin/SKILL.md:45`），且重启会中断进行中的对话（`apk:dsh-go-guide/en-08-plugins.md:21`）。
- 安装失败会留下半装状态；mesh 自己已经在进程里，无法用新代码回滚 → 建议**保留上一版 tgz + 一条「回滚」动作**，或先只支持「装第三方插件 / sidecar / 资源包」。
- 需要 pnpm 与网络/本地包完整；`dsh plugin add` 走 `runPluginCommand`（`dsh:dsh/lib/plugin-BiveYA7h.js:63-99`），改 profile 的 package.json/node_modules —— 与正在运行的进程并发，plugin-manager 有文件锁但**不保证热重载**（`dsh:dsh-plugin-manager/lib/types/operations.js:207-260`）。
- 结论：**P1 只做「选包 → 校验 → 落盘 → 提示用户执行 `dsh plugin … add`」**（把安装命令做成 `insert` 效果放进输入框，用户点发送才会跑，符合「insert 永不自动发送」的安全约定）；**P2 再考虑自动 spawn**，并用 `confirm` 组件二次确认。

### 5.3 替代方案（当 picker 不适用时）

| 方案 | 做法 | 评价 |
|---|---|---|
| 局域网 HTTP（推荐给 tarball） | 桌面 `python -m http.server`，guest 内 `curl` 到 `/root/dl` 再 `dsh plugin --profile web add ./x.tgz` | 已在 INTERNALS §5.3 验证路径；无大小限制（8MiB 限制只属于 picker）；要用户会敲命令 |
| `/sdcard` | App 设置开「访问手机文件」→ guest 内 `/sdcard/Download/x.tgz` 可直接 `cp` | 零代码；需要用户用文件管理器放文件（`apk:dsh-go-guide/en-10-settings.md:74`） |
| mesh 自带 `/mesh/v1/file` | 已有：`GET /mesh/v1/file?k=<nonce>&path=<插件包内路径>`，nonce 在启动日志里打印，**只服务插件包目录内的文件**、只 GET | 现成「同版本部署」通道（`mesh:lib/index.js:2175-2205`、nonce `:84`、日志 `:1002`）；**只能给对方取，不能收**，且要求双方都已跑 mesh；不适合首次安装 |
| npm 镜像 | `dsh plugin --profile web add dsh-plugin-mesh@0.5.4`（npmmirror） | 最省事，需外网（INTERNALS §5.3 B） |

---

## 6. native 模式 vs Web 模式（task 必答 5）

### 6.1 两种壳的可见性矩阵（实测自官方指南/资产）

| mesh 的 UI 形态 | App 原生界面（Native） | App Web 模式 | 桌面浏览器 |
|---|---|---|---|
| bridge 原生贡献（panel/strip/胶囊/菜单/工具卡） | ✅ 显示（`apk:dsh-go-plugin/SKILL.md:23`、`en-08-plugins.md:37-50`） | ❌ 不显示（Web 模式就是 DSH Web 页面） | ❌ 不显示（桌面没有 bridge） |
| `client/client.js`（Web 客户端 bundle，`__ModuleLoader__`） | 仅当被 seat 成 `island`/`web` 时显示（见 6.3） | ✅ 侧栏 Mesh 面板（抽屉里） | ✅ 侧栏 |
| 工具结果卡（`presentationMeta` 返回 `{'dsh-go/view':…}`） | ✅ 原生卡片 | ❌（Web 用 DSH 自己的 render） | ❌ |
| `/mesh/api/*` HTTP 路由 | 需 App token（route-guard） | ✅ 同源 cookie | ⚠ 桌面 DSH 有自己的 renderer token，curl 会 403（`mesh:AGENTS.md:60-61` 明确） |

### 6.2 宿主侧能否检测「当前是 native 还是 Web」？

**结论：没有可靠信号，也不必检测。**【实测】
- `dsh-client-connection` 只校验 Host/Origin 同源（`dsh:dsh-client-connection/lib/index.js:238-268`），不区分 UA/transport；`dsh-host-webserver` 没有任何 user-agent 处理（grep 零命中）；唯一的 dsh-go 标记是 route-guard 的 `x-dsh-go-guard` 响应头（`dsh:dsh-host-webserver/lib/index.js:496-520`）。
- 唯一「像信号」的是 bridge 自己的占用上报（`POST /dsh-go/v1/occupancy`）与缓存文件 `$DSH_HOME/cache/dsh-go-bridge/occupancy.json`（`bridge:lib/index.js:56-59`），但那是 **Web 页面**打开的痕迹，且不暴露给插件、还会过期。**不要依赖它做逻辑。**
- **设计上不需要**：原生贡献只在原生壳里渲染，Web bundle 只在网页里加载，两套 surface 天然互斥；bridge 的数据函数没人订阅就不跑（§2.2）。→ **策略：永远注册原生贡献；Web 端代码零改动。**

### 6.3 零改动备选：用 `ui.json` 的 `plugins.seats` 把 Web 面板嵌进原生界面

dsh-go App 会读 `$DSH_HOME/dsh-go/ui.json`（用户级，App 一两秒内生效，不用重启；`apk:dsh-go-ui/SKILL.md`）。其中：

```jsonc
"plugins": {
  "seats": {                      // slot → npm 包名 → native | island | web | hidden
    "sidebar.panellist": { "dsh-plugin-mesh": "island" }
  }
}
```

- 语义（SKILL 原话）：`native` 原生画 / `island` 内嵌网页 / `web` 在网页版打开 / `hidden` 隐藏；slot 必须在 `known` 里且不在 `unseatable` 里（`apk:dsh-go-ui/schema.json` `x-dsh-go.slots`；校验见 `apk:dsh-go-ui/check.mjs:803-830`）。
- mesh 注册的槽位是 `sidebar.panellist` 与 `main`（`mesh:client/client.js:8679,8685`），**`sidebar.panellist` 可 seat**（不在 unseatable 列表，schema `x-dsh-go.slots.unseatable`）。
- 这是 **P2 可选增强**：让用户不写代码就能把 mesh 的完整 Web 面板以「岛屿」形式嵌进原生侧栏；它和 §3 的 bridge 原生面板可以并存（不同 surface）。
- 注意：ui.json 是**每个主机一份**的用户配置，插件不应该偷偷改它；建议只在文档里给用户一行配置示例。

---

## 7. 权限 / 审批：入站任务卡在「待确认」的根因与解法（Lead 补充事实）

### 7.1 真机现象

任务被接收 → 手机 App 会话列表出现「Mesh 任务 t-… 待确认」→ 停在待确认。→ **wakeAgent 成功**（会话已建、标题已改、prompt 已注入），卡在**权限审批门**。

### 7.2 dsh-go 的权限模型（实测源码）

`dsh-base/cordis.patch.yml:236-282` 组合出的默认值：

| 组件 | 配置 | 证据 |
|---|---|---|
| `sandbox-policy` | `mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'` | `dsh:dsh-base/cordis.patch.yml:243-247` |
| `approval`（user-approval） | `policy: DSH_PERMISSION_MODE==='danger-full-access' ? 'never' : 'ask'` | `:259-262` |
| `permission-presets` | `read-only`={read-only,ask}、`workspace-write`={workspace-write,ask}、`danger-full-access`={danger-full-access,**never**} | `:264-277` |

`dsh-permission-presets` 的 `set(session,name)` 会 append `permission/preset` 事件并分别写 `sandbox/mode` + `approval/policy`（`dsh:dsh-permission-presets/lib/index.js:344-369`）；`approval: "ask"` 的语义是「**没有可用 answerer 时 fail closed**」（`dsh:dsh-user-approval/lib/index.js:36-41`）。

### 7.3 根因（推断，证据链完整）

1. mesh 的入站唤醒固定给会话设 `permissionPreset`（`mesh:lib/index.js:1197`、`:1267`、`:1335`），**每次建会话都显式覆盖**。
2. mesh 的默认值是 `workspace-write`（`mesh:lib/index.js:264-265`：`permissionPreset: z.string().default("workspace-write")`，注释「默认不给 danger-full-access」）。
3. 于是入站会话 = `sandbox: workspace-write` + `approval: ask`。
4. proot 里没有可用沙箱后端（bubblewrap/Landlock 都不可用），dsh-go 写进 guest 的 AGENTS 文本明说「`workspace-write` 沙箱模式一定会被拒绝」（`E:\mesh\.tmp\dex-scan.md:635-641`，App 内嵌字符串 STRING[2915]）；同时 `ask` 需要一个 answerer：后台会话没有页面在等，按 user-approval 的说明会 fail closed（`dsh:dsh-user-approval/lib/index.js:36-41`），或排队等用户打开该会话点确认 —— 这就是「待确认」。
5. **App 的「新对话默认权限=完全访问」也救不了**：它只决定 `defaultPreset`（新会话 pin 的初始值），而 mesh 在建会话后无条件 `set()` 覆盖（步骤 1）。反之，即使 App 设了 full access，mesh 仍会把它改回 workspace-write。

### 7.4 建议方案（配置项 + 风险 + 中间路线）

**P0 建议**：给 mesh 增加一个「dsh-go 专用权限 preset」配置，默认 `danger-full-access`：

```js
// 建议在 config schema 增加（新键，不写进 cordis.patch.yml，靠 schema 默认生效）：
permissionPresetOnDshGo: z.string().default("danger-full-access"),
// 选择逻辑：
const isDshGo = ctx.get("dshGo") !== undefined /* 或 /etc/dsh-app/runtime.json 存在 */
const presetFor = (task) => isDshGo
  ? (config.permissionPresetOnDshGo || config.permissionPreset)
  : (task?.transport === "tsnet" ? config.tsnetPermissionPreset || config.permissionPreset : config.permissionPreset)
```

为什么是**新键**而不是改默认值：AGENTS.md 的硬约束 —— `cordis.patch.yml` 里的 `config:` 是**整份替换**（`mesh:AGENTS.md` §3.4），而仓库自带的 `mesh:cordis.patch.yml` 已经钉死了 `permissionPreset: workspace-write`。改 schema 默认值对「已钉 config 的安装」无效；新增一个**不在 patch 里出现**的键，其 schema 默认才会生效，同时桌面完全不受影响（桌面 `isDshGo=false`，走旧逻辑）。

`danger-full-access` 在 dsh-go 上可解析（presets 表里有，`dsh-base/cordis.patch.yml:275-277`；mesh 启动时会 `resolve()` 校验，`mesh:lib/index.js:1141`），且 `approval:"never"` → 后台任务不等人，**这才是「全自动」体验的前提**。

**风险与缓解**
- 外部不可信输入获得全权（可读写 guest 全部文件）。缓解组合：`requirePairing: true`（配对码，`mesh:lib/index.js:260`）+ 只在 dsh-go 上开 + 保持 `minTaskChars`/限流（`mesh:lib/index.js` 的 throttled/threadState）+ 面板上明示「本机 Mesh 任务拥有完全访问」。
- 首次安装的 tgz 来自哪里也决定信任边界：局域网 HTTP/配对设备 < npm 官方包 < 任意 picker 选中的 tgz。

**中间路线（如果用户不接受 full access）**
1. `permissionPreset: "workspace-write"` + 用户每次打开「Mesh 任务」会话手动确认 → 现状，但至少应把 `dispatchError/routeDecision` 写清楚（mesh 已有这些字段），并在原生任务面板上用 `steps(failed)` 提示「等待你在会话里确认」。
2. `permissionPreset: "read-only"` → 只读任务可跑，写操作仍会 ask。
3. 目前没有「danger-full-access 沙箱 + ask 审批」的 preset（`AUTO_PRESET_SPEC` 只是 experimental Auto 集成 `registerAuto` 用，`dsh:dsh-permission-presets/lib/index.js:51-60,282-296`），别指望用 `auto`。

**验收**：真机把 `permissionPresetOnDshGo` 生效后，重发一条mesh 任务 → 会话不再出现「待确认」，agent 直接跑完并回执。

---

## 8. 最小示例骨架（dshGo 清单 + inject 时机 + 卸载清理）

> 给 mesh 的落地骨架（伪代码级，可直接改写进 `lib/dshgo.js`）。已在 §2/§3/§4 标注行号的地方都是实测契约。

```js
// mesh:lib/dshgo.js
// dsh-go 原生 UI 适配层。只在装了 dsh-go bridge 的主机上运行：
// 用 ctx.inject(['dshGo']) 的 required 形式，桌面 DSH 永远不会进这个回调。
import { MESH_DEFAULT_PORT } from './index.js'   // 或由 apply 传参注入

export function installDshGo(ctx, deps) {
  // deps = { peers: () => discovery.peers(), tasks: () => inbound.slice(-50),
  //          dispatchTask: (peer, text, opts) => …, scan: () => …, myMachine: () => … }
  ctx.inject(['dshGo'], (dshCtx) => {
    const dshGo = dshCtx.dshGo           // ⚠ 只能方法调用，别解构（core.js:353）

    // ---- 每个 scope 一份 UI state（面板可在 features 里无 sessionId） ----
    const states = new Map()
    const stateOf = (scope) => {
      const key = scope?.sessionId ?? '_global'
      let s = states.get(key)
      if (!s) states.set(key, (s = { selected: '', lastNote: '' }))
      return s
    }

    // ---- 视图 1：设备列表 ----
    dshGo.panel('peers', {
      view: (scope, caps) => ({
        type: 'stack', title: 'Mesh',
        children: [
          { type: 'metric', label: '在线', value: { $: 'data.online' }, tone: 'good',
            caption: { $: 'data.caption' } },
          { type: 'list', items: { $: 'data.rows' } },   // 行含 action {id:'peer',args:{id}}
          { type: 'actions', items: [
            { label: '刷新', icon: 'refresh', action: 'refresh' },
            { label: '扫描', icon: 'search', action: 'scan' } ] },
        ],
      }),
      data: (scope, emit) => {                 // 返回 cancel；emit ≤4Hz；面板 data 必须是对象
        const push = () => emit(buildPeersData(deps, stateOf(scope)))
        push()
        const timer = setInterval(push, 2000)
        return () => clearInterval(timer)      // ← 卸载/无人订阅时清理
      },
      actions: {
        refresh: (scope) => ({ refresh: true }),
        scan: (scope) => { deps.scan(); return { toast: '扫描中…' } },
        peer: (scope, event) => {              // 行 action 或 options 选中
          const id = event.value?.id ?? event.value?.value
          stateOf(scope).selected = String(id ?? '')
          return { patch: { selected: stateOf(scope).selected }, toast: '已选中' }
        },
        probe: async (scope, event) => ({ pending: {
          label: '探测中', timeoutMs: 20000,
          result: async (signal) => ({ toast: await deps.probe(event.value?.id, signal) }),
        } }),
      },
    })

    // ---- 视图 2：任务队列 ----
    dshGo.panel('tasks', {
      view: () => ({ type: 'stack', title: 'Mesh 任务', children: [
        { type: 'row', children: [
          { type: 'metric', label: '进行中', value: { $: 'data.running' } },
          { type: 'metric', label: '今日', value: { $: 'data.today' } } ] },
        { type: 'table', columns: ['时间', '来源', '状态'], rows: { $: 'data.rows' } },
        { type: 'callout', text: { $: 'data.hint' }, tone: 'info' },
      ]}),
      data: (scope, emit) => { emit(buildTasksData(deps)); return () => {} },
      actions: {
        // 文件通道入口（需要 package.json dshGo.capabilities 含 "files"）：
        'pick-install': () => ({ type: 'pickFile', action: 'install-package', maxFiles: 1 }),
        'install-package': (scope, event) => {
          if (event.value?.status !== 'selected') return { toast: '已取消' }
          const f = event.value.files?.[0]
          if (!f) return { toast: '没有文件' }
          const buf = dshCtx.dshGo.readPickedFile(f.handle)   // ⚠ 只在本次回调内可读
          return deps.stagePackage(buf, f.name)               // 落盘+校验，返回 toast/insert
        },
      },
    })

    // ---- 状态条 ----
    dshGo.strip('status', (scope, emit) => {
      const push = () => {
        const n = deps.peers().filter((p) => p.online).length
        emit(n > 0 ? { text: `${n} 台在线`, icon: 'team', tone: 'good' } : null)  // null 安全
      }
      push()
      const timer = setInterval(push, 5000)
      return () => clearInterval(timer)
    })

    // ---- 输入框胶囊：把草稿派出去 ----
    dshGo.on('dispatch', async (scope, event) => {
      const text = String(scope.draft ?? '').trim()
      if (!text) return { toast: '输入框里没有内容' }
      const target = pickTarget(deps, stateOf(scope).selected)
      if (!target) return { open: 'panel:peers' }
      return { pending: {
        label: '正在派发', timeoutMs: 60000,
        result: async (signal) => ({ toast: await deps.dispatchTask(target, text, signal) }),
      } }
    })
    dshGo.on('send-message', async (scope) => { /* 用 scope.message 作正文，同上 */ })

    // 自动清理：上面每个注册返回的 disposer 已由 bridge 绑到本插件 ctx.effect
    //（core.js:371-374）。插件卸载/重载时 bridge 自动 #remove（core.js:403-411），
    // 我们只需要清自己的定时器（data/strip 的 cancel 会被调用）。
  })
}
```

**清单侧**（`package.json`）：见 §2.1。**不要**在 `cordis.patch.yml` 里新增字段（整份替换 + 已钉死；AGENTS.md §3.4）。

**卸载清理清单**
- [x] bridge 注册：随插件 fiber 自动移除（`core.js:371-374,403-411`）。
- [x] data/strip 定时器：`cancel()` 里 `clearInterval`。
- [x] 文件通道落盘的临时 tgz：`install-package` 成功后删除/保留一版用于回滚。
- [x] UI state（`states` Map）：插件卸载即随模块实例消失，无需持久化。
- [x] 若加了 `permissionPresetOnDshGo`：无需清理（只是配置）。

---

## 9. 落地清单（task 必答 6，按最小可用路径排序）

### P0：能列出设备 + 能派发（目标：真机原生界面可用）

| # | 文件 | 改动 | 验收 | 风险 |
|---|---|---|---|---|
| 1 | `mesh:package.json` | 新增 `dshGo` 块（§2.1：2 个面板 + 1 strip + composer.action `dispatch` + message.action `send-message`；`wants:["draft","clipboard","message"]`）；**不动** `dsh`/`dependencies` | `node -e "JSON.parse(fs.readFileSync('package.json'))"`；装到 dsh-go 后 App「全部功能」出现 Mesh 面板 | `dshGo` ≤16KiB；id 唯一；面板 title ≤16 字 |
| 2 | `mesh:lib/dshgo.js`（新） | `installDshGo(ctx, deps)`：peers/tasks 两个 panel + status strip + `dispatch`/`send-message` 回调（§8 骨架） | 原生面板列出设备、点刷新有反应、点派发桌面收到任务 | panel data 必须是对象、≤32KiB、≤4Hz；连续 5 次违规会关原生 UI |
| 3 | `mesh:lib/index.js` | 在 `apply()` 里按需调用 `installDshGo(ctx, {...})`（传入 peers/tasks/dispatch/scan 闭包）；**不新增 inject 依赖**（`tools`,`webServer` 不变） | 桌面 DSH 行为完全不变（桌面无 `dshGo` 服务，回调不执行） | 闭包生命周期：插件卸载后别再被调用 |
| 4 | `mesh:lib/index.js` 配置 schema | 新增 `permissionPresetOnDshGo`（默认 `danger-full-access`）+ `permissionPresetFor` 优先取它（§7.4） | 真机入站任务不再「待确认」 | 外部输入全权；配合 `requirePairing` |
| 5 | 文档 | `llms.txt`/README 的 dsh-go 段：说明原生面板、权限建议、Web 模式差异 | `npm run check` 的 `check-docs` 通过（`sync-llms.mjs`） | 文档与代码不一致会被 check 抓 |

### P1：任务队列 + 工具卡 + 文件通道

| # | 文件 | 改动 | 验收 | 风险 |
|---|---|---|---|---|
| 6 | `mesh:lib/dshgo.js` | `tasks` 面板数据接 `inbound`（含 `dispatchError` → `steps(failed)`） | 原生面板能看到入站任务与失败原因 | 任务里可能有敏感文本：面板只展示前 60 字 |
| 7 | `mesh:lib/index.js`（4 个工具的 `output.presentationMeta`） | 给 `mesh_peers/mesh_scan/mesh_run/mesh_tasks` 返回 `{'dsh-go/view': {...}}`（`dsh:dsh-tools/lib/index.js:843-860,3650-3657` 定义投影点；视图 ≤8KiB/40 节点/6 层） | 手机原生聊天里 mesh 工具调用显示成卡片（设备表/派发回执） | 抛错或返回非对象会让**整次工具调用失败**（`SKILL.md:166-175`），必须 try/catch |
| 8 | `mesh:package.json` | `capabilities:["files"]` | — | 只在实现 §5 后加 |
| 9 | `mesh:lib/dshgo.js` | `pick-install`/`install-package`：选 tgz → `readPickedFile` → 校验 → 落盘 → 返回 `{insert:'dsh plugin --profile web add <path>'}`（先不自动装，§5.2） | 选一个 1.5MB tgz，面板提示已落盘并给出命令 | 8MiB/3s/只能在回调内读 |
| 10 | `mesh:lib/index.js` | System 信息兜底（`machine`/`mac`/`cpuCores` 空态）或后续补取 | 原生 UI 不显示 `localhost`/`0` | 与本次 UI 无强耦合 |

### P2：v2 表单 / island 席位 / 自动安装

| # | 项 | 改动 | 验收 |
|---|---|---|---|
| 11 | v2 `form` 派发表单 | `view(scope,caps)` 里判断 `caps.components` 含 v2 组件才返回 v2 视图，否则回 v1 | 真机看到表单 vs 退回 v1 均可用 |
| 12 | ui.json `plugins.seats` island | 只写文档 + 示例（不替用户改文件）：`"sidebar.panellist": {"dsh-plugin-mesh":"island"}` | 「全部功能」里出现完整 Mesh Web 面板 |
| 13 | 自动安装 | `install-package` spawn `dsh plugin add`（detached）+ `confirm` 二次确认 + 保留上一版 tgz 回滚 | 换版本成功、失败可回滚 |

**每项的共同风险**
- 原生 UI 的「隐形失败」很难查：优先把错误写进面板 data / mesh 自己的日志，而不是静默 `catch {}`（mesh AGENTS.md §3.1 的同一条原则）。
- bridge 的 `locate()` 依赖「插件包能被 `require.resolve` 到」（`bridge:lib/native/core.js:84-121`）：mesh 若被以**绝对路径 insert**（非 profile 安装）也能工作（dsh-go-bridge 自身就这么装），但 `package.json.name` 必须能被找到 —— 安装方式变化时要回归一次。
- 不要同时用两种来源启用 mesh（profile bundle + 绝对路径 insert）：会出现两份浏览器包/两个注册者（`rootfs:/etc/dsh-app/dsh-web.patch.yml:16-17` 的同一条告诫）。

---

## 10. 待实测清单（决定 P0/P1 形态）

| # | 要测什么 | 怎么做 | 影响 |
|---|---|---|---|
| 1 | **面板行内 `action` 是否生效**（data 绑定的 list item action） | 真机点设备行；看 `/dsh-go/v1/invoke` 是否带 `action:"peer"` | 决定 P0 用「行内点按」还是「options 选设备」 |
| 2 | App 上报的 `components` / `features` 到底是什么 | 视图函数里 `console.log(caps)`（或面板显示）；同时看 App 的 `/dsh-go/v1/contributions?v=1&app=…&components=…` 请求头 | 决定能否用 v2 form、picker 的 `files` 是否协商 |
| 3 | 原生 UI 打开时 WS `stream` 是否常驻 | 面板里返回 picker 后是否报 "needs a live files stream" | picker 能否用 |
| 4 | 面板在 `features` placement 下的 `scope`（无 sessionId） | 面板显示 scope.key | 决定 UI state 的键 |
| 5 | 入站 `permissionPresetOnDshGo: danger-full-access` 后是否真的全自动 | 真机派发一条需要写文件的任务 | 决定 §7.4 是否是最终方案 |
| 6 | 原生面板刷新时机（App 何时重新 GET views） | 点 `refresh` 后观察 | 决定是否需要轮询 patch |
| 7 | `list` 行数/`data` 体积上限的实际表现 | 造 50 台假 peer | 决定截断策略 |
| 8 | App 对 `patch` 差量的应用是否平滑 | 高频 emit 小变化 | 决定 4Hz 是否要降 |
| 9 | 安装后的插件热重载行为（`dsh plugin add` 是否触发 loader 重载） | P1 文件通道验收时观察 | 决定自升级是否需要强制重启提示 |
| 10 | ui.json island 席位在 0.9.7 的实际效果 | 手工改 ui.json → 重开 App | P2 是否值得做 |

---

## 11. 与 INTERNALS / 其它任务的衔接

- 本文依赖的 bridge 契约全部来自 `rootfs:/opt/dsh-go/dsh-go-bridge/`（0.4.0，`manifest.json:28-31`）与 APK 内 `skills/dsh-go-plugin/`（App 0.9.7 自带，含 `kit-schema-*.json` 与 `kit-lib-bridge-*.js` 校验器）。**App 升级时应以 APK 内的 kit 版本重新核对**：本次看到的是 v1 + v1.2 capabilities + v1.3 files，view schema 已到 v2。
- 本设计**不触碰** mesh 现有 peer 协议/发现/tsnet 逻辑：原生 UI 只是「第二个读数据、发同一条 `/mesh/v1/task` 的入口」。入站任务链路的权限问题（§7）是唯一需要改行为的地方。
- 与 INTERNALS 的安装路径章节（§5.3）配合：`dshGo` 清单随包发布，`dsh plugin --profile web add` 装完、重启引擎即可在原生界面看到 —— 不依赖任何 dsh-go App 侧改动。

---

### 附：本文用到的校验/提取脚本与产物

| 文件 | 用途 |
|---|---|
| `E:\mesh\.tmp\viewcheck.py` | 用 bridge 同款 `viewStats` 算法 + 紧凑 JSON 字节数校验 §3 的视图样本（peers 4 节点/329B、tasks 6 节点/347B、v2 form 4 节点/361B、50 台设备 data 9,810B） |
| `E:\mesh\.tmp\viewparse*.py` / `uischema.py` | 从 APK 的 `kit-schema-view.schema.json` / `dsh-go-ui/schema.json` 提取组件与 slots/seats 定义 |
| `E:\mesh\.tmp\ui-x.json`、`ui-seats.json` | ui.json 的 `x-dsh-go.slots`（known/unseatable）与 `plugins.seats` 结构 |
| `E:\mesh\.tmp\w11.sh`–`w20.sh` | 权限 presets / approval / 组合默认值的 WSL 探查脚本（可复现） |
