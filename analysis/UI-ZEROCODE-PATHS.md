# 零代码 UI 路径落地手册（ui.json island / 工具卡 / 原生 panel）

> 任务 task-6。目标：让 Lead 能在真机上照着执行、并能判断「成没成」。
> 三条路径的定位不同，先看对比表，别混着用：

| 路径 | 代码改动 | 手机上能看到什么 | 可交互 | 实时数据 | 生效代价 | 风险 |
|---|---|---|---|---|---|---|
| **A. `ui.json` island 席位** | **0 行**（只写一个 JSON 配置文件） | mesh 的**完整 Web 面板**（侧栏入口，点开是面板）嵌在原生界面里 | ✅ 完整（WebView 内） | ✅ 引擎在线即可 | **1~2 秒自动生效**，不重启、不重开 App | 语义未实测；WebView 依赖 3080；slot 语义可能被忽略 |
| **B. 工具卡 `presentationMeta`** | 4 个 tool 各加 ~10 行（`output` 里加一个函数） | 原生聊天里，mesh 工具调用的结果变成**只读卡片**（设备表/任务表） | ❌ 第 0 期不可点（按钮/确认隐藏，options 只读） | ⚠ 只有调用那一刻的快照 | 改 `lib/` → **重启引擎** | 8 KiB/40 节点上限；`presentationMeta` 抛错会让**整次工具调用失败** |
| **C. 原生 panel/strip** | 1 个新文件 + `package.json` 加 `dshGo` 块（task-3 §2/§8） | 原生「插件」页签 / 全部功能里的 **Mesh 面板** + 输入框上方的状态条 + 胶囊 | ✅ 面板内动作、胶囊、状态条 | ✅ 面板数据函数订阅即跑 | 重启引擎（`lib/`+清单都要重载） | 依赖 bridge 协议（0.4.0）；要自己写视图 |

**建议顺序**：先用 A 验证「原生界面能不能看到 mesh」（零成本、可回滚）；再用 B 拿「聊天里能看设备表」；C 是最终形态（task-3 已设计），等 A/B 验证完再投入。

**三条路都建立在同一前提上**：手机上 DSH 引擎在跑（`/etc/dsh-app/runtime.json` 存在）、mesh 已安装并启用（`/root/.dsh/profiles/web/`，`profile=web`）。

---

## 0. 真机事实校准（Lead 提供，会影响三条路的显示/写法）

| 事实 | 影响 |
|---|---|
| Android 15 / App 0.9.7；`profile=web` | 所有命令用 `--profile web`；ui.json 在 `$DSH_HOME/dsh-go/`（**不是** profile 目录） |
| `os.networkInterfaces()` 正常（7 个网卡，含 `wlan0`） | A/B/C 显示的设备地址可用；mesh 新加的 `lib/netinfo.js` 已按「配置 > networkInterfaces > UDP 源地址 > /proc/net」四级兜底（`mesh:lib/netinfo.js:1-20` 注释）【实测·文件】 |
| `os.cpus().length = 0`，`availableParallelism() = 8` | 任何 UI 里显示 `cpuCores` 的地方必须用 `availableParallelism()` 或数 `/proc/cpuinfo` 的 `^processor` 兜底，否则显示 0【推断】 |
| `hostname = localhost` | mesh 的机器名回退到 `hostname()`（`mesh:lib/index.js:743` `return { name: hostname(), source: "hostname" }`）→ UI 会显示 `localhost`。**显示层要过滤**：`machine==="localhost"` 时改显示 IP 或空串 |
| `/etc/machine-id` 为空 | 同上，别拿它当设备身份 |
| `/system/build.prop` 存在；`getprop` 不在 PATH | 想拿型号：读 `/system/build.prop`（`ro.product.model` / `ro.product.manufacturer`）或绝对路径 `/system/bin/getprop`。proot 已把 `/system` bind 进 guest（`APK:assets/runtime/manifest.json:146-147` bind `-b /system`），所以这两条在 guest 里都能读【实测·清单 + Lead 事实】 |

> 这三条（machine/cpu/mac）正是 Lead 在 health 里看到 `machine:"localhost"`、`cpuCores:0`、`mac:"00:00:00:00:00:00"` 的来源。原生 UI（A/B/C 三条路）会把这些字段直接摆给用户看，**显示层必须兜底**：空/0/占位值不要原样显示。

---

## 1. 路径 A：`ui.json` 的 `plugins.seats` / `island` 席位（0 行代码）

### A.1 确切路径（三份东西，别搞混）

| 东西 | 路径 | 证据 |
|---|---|---|
| **要写的配置** | guest 内 `$DSH_HOME/dsh-go/ui.json`；本机启动 env `DSH_HOME=/root/.dsh` → **`/root/.dsh/dsh-go/ui.json`** | `apk:skills/dsh-go-ui/SKILL.md:10`（App 会读 `$DSH_HOME/dsh-go/ui.json`）；`APK:assets/runtime/manifest.json:160`（`DSH_HOME=/root/.dsh`）【实测】 |
| App 实际读到的结果 | `$DSH_HOME/dsh-go/ui.status.json`（= `/root/.dsh/dsh-go/ui.status.json`），App 每次读取后写出 | `apk:skills/dsh-go-ui/SKILL.md:25`【实测·文档资产】 |
| 官方校验器（App 内） | `$DSH_HOME/skills/dsh-go-ui/scripts/check.mjs`；schema 在 `$DSH_HOME/skills/dsh-go-ui/schema.json` | `apk:skills/dsh-go-ui/manifest.json`（`check.mjs → scripts/check.mjs`）；`check.mjs:18-24` 找 `../schema.json`【实测】 |
| App 侧实现来源 | 校验器是 App 的 Dart 校验器逐行复刻（`lib/ui_config/ui_config_parser.dart`、`ui_json_reader.dart`） | `apk:skills/dsh-go-ui/check.mjs:1-12`【实测·注释】 |

> App 会把 skill 按 manifest 落到 guest：`scripts/check.mjs`、`schema.json`、`examples/*`、`SKILL.md` —— 所以校验器在**手机上**就能跑，不需要电脑。

### A.2 完整示例（最小可用）

写入 `/root/.dsh/dsh-go/ui.json`（目录可能不存在，先 `mkdir -p`）：

```json
{
  "version": 1,
  "plugins": {
    "seats": {
      "sidebar.panellist": {
        "dsh-plugin-mesh": "island"
      }
    }
  }
}
```

- `version: 1` 是**必填**（schema `required`）。
- `seats` 结构：`{ "<slot 名>": { "<npm 包名>": "native" | "island" | "web" | "hidden" } }`（`apk:skills/dsh-go-ui/SKILL.md:67`）。
- 语义（SKILL 原文）：`native` 原生画 / `island` 内嵌网页 / `web` 在网页版打开 / `hidden` 隐藏。
- 整份文件 ≤ **64 KiB**、深度 ≤ 32（schema `x-dsh-go.maxBytes/maxDepth`，`apk:skills/dsh-go-ui/schema.json` → `E:\mesh\.tmp\ui-x.json:3-4`）。

如果想保留 App 其它已有配置，只往 `plugins.seats` 里加这一项，不要覆盖别的键（SKILL 第 3 条：只改用户要求的部分、其它原样保留）。

### A.3 为什么是 `sidebar.panellist` 这个 slot

- mesh 的浏览器半只往两个 slot 注册：`sidebar.panellist`（侧栏面板入口）和 `main`（`mesh:client/client.js` 里 `ctx.slots.inject("sidebar.panellist", …)` / `ctx.slots.inject("main", …)`，用 `grep -n 'slots.inject' client/client.js` 定位，当前在 8679/8685 附近，mesh 正在被改，以 grep 为准）【实测·源码】。
- 可 seat 的 slot = `x-dsh-go.slots.known` 里、且不在 `x-dsh-go.slots.unseatable` 里的（校验器 `apk:skills/dsh-go-ui/check.mjs:803-830`：未知 slot 报 `adjusted`，`unseatable` 报 `ignored`）。
- `sidebar.panellist` 在 `known`（`E:\mesh\.tmp\ui-x.json:176`），**不在** `unseatable`（对照 `E:\mesh\.tmp\ui-x.json:202-245`）→ **可以 seat**。
- `main` 也可 seat（不在 unseatable）；`main.conversation`/`sidebar`/`rightbar` 等则不可 seat。
- 候选备选：`known` 末尾的 **`dsh-go.panel`**（`E:\mesh\.tmp\ui-x.json:200`，同样不在 unseatable）—— 名字看就是 App 给插件面板留的容器，**值得真机试**（待实测）。

**机制（两条证据吻合）**：dsh-go-bridge 的浏览器半实现了 island 模式 —— 页面通过 `#dsh-go-island=<slot>[,<slot>…]` 或 `window.__dshGoBridge.mask([...])` 把官方条目遮掉、只留第三方条目（`rootfs:/opt/dsh-go/dsh-go-bridge/lib/client.js:4-23`、tail 的 `__dshGoBridge = {mask, occupants, report, rightPaneTabs, openTab}`）。ui.json 的 `island` 席位正是让 App 用这种页面把该 slot 的第三方插件 UI 嵌进原生界面。**端到端行为仍需真机确认**（见 A.6）。

### A.4 生效方式

- 保存后 **App 一两秒内自动生效，不用重启引擎、不用重开 App**（`apk:skills/dsh-go-ui/SKILL.md:10`）【实测·文档资产】。
- 前提：此时 App 正连着**这台手机的本机引擎**（ui.json 是「每台主机各一份」，SKILL「注意」第 1 条）。

### A.5 前置条件与风险

| 风险 | 说明 | 依据 |
|---|---|---|
| slot 语义可能被忽略 | `unseatable` 之外的 slot 也可能在 island 下没有视觉落点（App 是 Flutter 原生侧栏） | 【待实测】 |
| island 需要 DSH Web 在跑 | 内嵌网页指向本机 3080（App 已持有 token/cookie）；引擎没起就没有内容 | 【推断】 |
| 只影响原生界面 | Web 模式、桌面浏览器完全不受影响 | 【推断（ui.json 是 App 原生配置）】 |
| mesh 没装/没启用 | seat 指向的包不存在 → 无内容 | 【推断】 |
| `native` vs `island` | 若 `island` 不生效，可把值换 `native` 试（原生画需要 dshGo 清单，见路径 C）；`web` 则在网页版打开 | SKILL:67 |
| 写错整份失效 | 语法错 → App 保留上一次有效配置（SKILL「注意」第 2 条）；每项错只影响那一项 | SKILL |

### A.6 验收观察点（按顺序做）

1. **guest 内自查**（在 App 的 agent bash 里，或 `adb forward` 后 Web 终端）：
   ```sh
   mkdir -p "$DSH_HOME/dsh-go"
   cat > "$DSH_HOME/dsh-go/ui.json" <<'JSON'
   {"version":1,"plugins":{"seats":{"sidebar.panellist":{"dsh-plugin-mesh":"island"}}}}
   JSON
   node "$DSH_HOME/skills/dsh-go-ui/scripts/check.mjs" "$DSH_HOME/dsh-go/ui.json"
   # 期望：ui.json：已应用 1 项        （exit 0）
   ```
2. **App 实际读到的结果**：
   ```sh
   cat "$DSH_HOME/dsh-go/ui.status.json"
   ```
   应能看到 `plugins.seats` 这一项（具体结构待实测，先看是否有该条目/是否有 ignored 记录）。
3. **App 界面**：设置 → 界面里应出现「来自 ui.json」相关分组（SKILL:26 提到这里能「恢复默认」）；原生侧栏/抽屉里应出现 mesh 的入口/内嵌面板。**【待实测——这是路径 A 的成败判据】**
4. **反证**：如果 App 原生界面毫无变化，先跑第 1 步的 checker 排除语法问题，再按 A.5 换 slot（`dsh-go.panel`）或换模式（`native`/`web`）重试。

### A.7 回滚

- 删掉 key：把 `plugins.seats.sidebar.panellist` 删掉（整份文件只留 `{"version":1}` 或直接删文件）→ 1~2 秒生效。
- 或在 **App 设置里点「来自 ui.json」→「恢复默认」**（SKILL:26）—— 这只让 App 忽略那一项，**不改文件**；要彻底回滚还是删文件。
- 备份命令（改前）：`cp "$DSH_HOME/dsh-go/ui.json" "$DSH_HOME/dsh-go/ui.json.bak-$(date +%Y%m%d%H%M)"`。

### A.8 本机离线已实测（不需要手机就能复现）

我把 APK 里的 skill 资产按 manifest 还原成「App 写入 guest 的布局」，在 WSL（node v22.22.1）里跑了**同一份官方校验器**：

```
$ node /mnt/e/mesh/.tmp/dshgo-ui-kit/scripts/check.mjs /mnt/e/mesh/.tmp/samples/ui-mesh-island.json
ui.json：已应用 1 项                       ← exit 0

$ node ... --json
{"file":".../ui-mesh-island.json","applied":1,"fatal":false,"issues":[]}   ← exit 0

# 反例：seat 到不可 seat 的 slot
$ node ... /mnt/e/mesh/.tmp/samples/ui-unseatable.json
ui.json：已应用 0 项，1 处没生效
忽略 /plugins/seats/sidebar：这个位置不放插件       ← exit 1
```

→ **示例 JSON 的格式、slot 名、seatMode 词表都已用官方校验器验证通过**【已实测】；App 最终渲染效果【待实测】。

---

## 2. 路径 B：工具卡（`presentationMeta` 返回 `{'dsh-go/view': …}`）

### B.1 插入位置（mesh 当前代码）

4 个工具都长这样（`mesh:lib/index.js`，行号为 **2026-10-29 00:05 时点：3654 行 / 164,594 字节**；mesh 正在被改，**以锚点 grep 为准**）：

| 工具 | 定义锚点 | `output` 行 |
|---|---|---|
| `mesh_peers` | `name: "mesh_peers"`（:2344） | `output: { schema: { type: "string" }, render: (_a, v) => text(v) },`（:2351） |
| `mesh_scan` | :2380 | :2385 |
| `mesh_run` | :2402 | :2426 |
| `mesh_tasks` | :2518 | :2521 |

定位命令（在仓库根跑）：
```sh
grep -n 'name: "mesh_\|output: {' lib/index.js
```

### B.2 最小代码（以 `mesh_peers` 为例）

`defineTool` 把 `output.presentationMeta` 原样转交给框架（`dsh:dsh-tools/lib/index.js:838-872`，其中 `:843` 读取、`:860-862` 包装），工具执行完会调用 `(exec.arguments, value)` 并做 JSON 快照（`:3640-3657`）。**取值必须同步、必须 lossless JSON**（`snapshotProjection`，`:2661-2672`）。所以：

```js
// mesh:lib/index.js —— mesh_peers 的 defineTool 里，output 改成：
output: {
  schema: { type: "string" },
  render: (_a, v) => text(v),
  // dsh-go 原生「工具卡」：只读快照，没有数据模型（不能写 {$:...} 绑定）
  presentationMeta: (_args) => {
    try {
      const peers = discovery.peers();                      // 闭包直接读实时状态
      const online = peers.filter((p) => p.online);
      const view = {
        type: "stack",
        title: "Mesh 设备",
        children: [
          { type: "metric", label: "在线", tone: "good",
            value: `${online.length} / ${peers.length}`,
            caption: peers.length ? `最近心跳 ${lastSeenSeconds(peers)} 秒前` : "还没发现设备" },
          { type: "list", items: peers.slice(0, 20).map((p) => ({
              title: displayName(p),                          // ← "localhost" 兜底（见 §0）
              subtitle: `${p.online ? "在线" : "离线"} · ${p.host || "无地址"}:${p.port || 0}`,
              trailing: p.online ? "在线" : "离线",
              tone: p.online ? "good" : "muted",
              icon: "team",
            })) },
          { type: "callout", tone: "info",
            text: peers.length > 20 ? `还有 ${peers.length - 20} 台，点工具详情看完整列表` : "点工具详情看完整能力清单" },
        ],
      };
      return JSON.stringify(view).length <= 8000 ? { "dsh-go/view": view } : {};  // 8 KiB 预算，留余量
    } catch {
      return {};   // ⚠ 抛错 = 整次工具调用失败（ToolOutputError），必须吞掉
    }
  },
},
```

对 `mesh_tasks` 同理：用 `inbound.slice(-20)` 画 `table`（`columns:["时间","来源","状态"]`）或 `steps`（`status: done|current|todo|failed`）。

### B.3 硬约束（全部实测自官方 kit / dsh-tools）

| 约束 | 值/行为 | 证据 |
|---|---|---|
| 体积 | **8,192 字节**（紧凑 JSON） | `apk:skills/dsh-go-plugin/kit-lib-view-check.js:31`（`toolCard: {bytes:8192, nodes:40, depth:6, children:16}`） |
| 节点/深度/子项 | ≤40 个 typed 节点 / ≤6 层 / 每容器 ≤16 子项 | 同上 |
| 计数口径 | 只数带字符串 `type` 的对象（list 的 items 不计数）；**字节按紧凑 JSON 算，不是文件大小** | `rootfs:/opt/dsh-go/dsh-go-bridge/lib/native/util.js:156-173` `viewStats`；实测见 B.4 |
| 无数据模型 | 视图里的 `{$:"data.x"}` 绑定全部显示「—」 | kit 输出原文 `A tool card has no data model; every binding shows as "—"`（`kit-lib-check.js:45`） |
| 不可交互（第 0 期） | `actions`/`confirm` 按钮不显示，`options` 只读 | kit 原文 `Tool cards (phase 0) are not tappable…`（`kit-lib-check.js:46`） |
| 回调语义 | 同步调用；返回值做 lossless JSON 快照；**抛错 → 工具调用整体失败** | `dsh:dsh-tools/lib/index.js:3640-3657`、`2657-2672` |
| 不需要 `dshGo` 清单 | 工具卡是「零成本扩展」，插件没有 `dshGo` 也能用 | kit 原文「没有 dshGo 清单：只有工具卡（presentationMeta）这类零成本扩展」（`kit-lib-check.js:30`） |
| **连 bridge 都不需要** | 胶囊/菜单/状态条/面板只在装了 bridge 的主机出现；**其他主机只有工具卡** → 连远端 SSH 主机上也能看到 mesh 工具卡 | `apk:skills/dsh-go-plugin/SKILL.md:23` |

### B.4 离线校验（不用手机，已跑通）

**在手机上**（skill 已随 App 落到 guest）：
```sh
# 把工具的示例输出写成文件（真实实现里可以由 presentationMeta 生成后落盘一份样例）
cat > /root/tool-card.json <<'JSON'
{ "dsh-go/view": { "type": "stack", "title": "Mesh 设备", "children": [
  { "type": "metric", "label": "在线", "value": "2 / 3", "tone": "good" },
  { "type": "list", "items": [
    { "title": "文超-win", "subtitle": "win32 · 192.168.1.10:45917", "trailing": "在线", "tone": "good", "icon": "team" },
    { "title": "hos", "subtitle": "android · 192.168.1.19:45917", "trailing": "在线", "tone": "good", "icon": "team" } ] } ] } }
JSON
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" /root/tool-card.json --budget toolCard
# 期望：View /root/tool-card.json (tool card): renders      （exit 0）
```
`--budget` 可省略：文件里有 `"dsh-go/view"` 且没有顶层 `type` 时，校验器**自动按 toolCard 预算**（`kit-lib-check.js:354-377`）【实测】。

**在本机（我已复核，WSL node v22.22.1）**：
```
$ node dshgo-kit/kit/bin/check.mjs samples/tool-card-peers.json --budget toolCard
  View samples/tool-card-peers.json (tool card): renders            exit=0   （compact 602 B）

$ node dshgo-kit/kit/bin/check.mjs samples/tool-card-bad.json --budget toolCard
  View samples/tool-card-bad.json (tool card): renders, 2 problem(s)
    note view.children[0].text: A tool card has no data model; every binding shows as "—"
    note view: Tool cards (phase 0) are not tappable: buttons and confirms are hidden, options read-only
                                                                      exit=0
```
（坏的写法不会 fatal，只是两项 note —— 但真机上用户看到的是「—」和消失的按钮。）

**容量实测**（同款 `viewStats` + 紧凑 JSON 字节）：
| 设备数 | 工具卡紧凑字节 | 结论 |
|---|---|---|
| 3 台 | 602 B | ✅ |
| 40 台 | 4,620 B | ✅ |
| 50 台 | 5,740 B | ✅ |
| **71 台** | 8,092 B | ✅ 上限边缘 |
| 72 台 | 8,204 B | ❌ 超 8 KiB |

→ 工具卡最多塞 **约 70 台**；我仍建议展示层截到 20 行 + 一句「还有 N 台」（人眼看不过来、也留余量）。

### B.5 生效方式

- 改的是 `lib/index.js` → **必须重启引擎**（DSH 只在启动时加载插件 host 半；官方 skill 同结论：`lib/` 改了要重启，`apk:skills/dsh-go-plugin/SKILL.md:45`）。
- 只改 `package.json` 的清单不需要重启（会自动重读），但这条路径**不用改清单**。

### B.6 验收观察点

1. 重启引擎后，在**手机原生聊天**里让 agent 调一次 `mesh_peers`：
   - ✅ 成功：聊天里出现「Mesh 设备」卡片（metric + 设备列表 + callout），而不是一大段纯文本。
   - ❌ 失败特征：仍是纯文本 → `presentationMeta` 没被调用/返回值不是对象；**整次工具调用报错** → 函数抛异常了（必须 try/catch）。
2. App 的「插件详情」里该插件的「原生 UI」状态（SKILL:46）应显示工具卡可用；bridge 的 `/dsh-go/v1/inventory` 里 `packages` 应含 `dsh-plugin-mesh`（`rootfs:/opt/dsh-go/dsh-go-bridge/lib/index.js:308-335`）。
3. 离线判据见 B.4（checker `renders`）。

### B.7 回滚 / 风险

- 回滚：删掉 `presentationMeta` 这一个键即可（无状态、无迁移）；重新打包重启。
- 风险：① 超过 8 KiB 会被 App 截断/不显示（先按 B.4 量）；② 抛错会破坏工具调用本身（**所有分支都要 try/catch 并返回 `{}`**）；③ 卡片是只读快照，别设计成「点一下派发」（第 0 期不支持，`kit-lib-check.js:46`）；④ `snapshotJsonValue` 要求 lossless JSON：`undefined`/`NaN`/函数会导致整次失败，字段要自己兜底。

---

## 3. 路径 C：原生 panel / strip（半步代码，最终形态）

完整设计见 `E:\mesh\analysis\DSHGO-BRIDGE-INTEGRATION.md` §2/§3/§8。这里只给「最小实现清单 + 关键调用」，避免重复：

1. `package.json` 加 `dshGo` 块（§2.1，含 `panels`/`composer.strip`/`composer.actions`/`message.actions`）。
2. 新增 `lib/dshgo.js`，在 `apply()` 里：
   ```js
   export function installDshGo(ctx, deps) {
     ctx.inject(['dshGo'], (c) => {          // 桌面主机没有 dshGo 服务 → 整个回调不执行
       const g = c.dshGo                      // 必须方法调用，别解构
       g.panel('peers', {
         view: () => ({ type: 'stack', title: 'Mesh', children: [
           { type: 'metric', label: '在线', value: { $: 'data.online' }, tone: 'good' },
           { type: 'list', items: { $: 'data.rows' } },
           { type: 'actions', items: [ { label: '刷新', icon: 'refresh', action: 'refresh' } ] },
         ]}),
         data: (scope, emit) => {             // 订阅才启动；≤4Hz；emit 必须是对象
           const push = () => emit({ online: '2 / 3', rows: [] })
           push(); const t = setInterval(push, 2000)
           return () => clearInterval(t)
         },
         actions: { refresh: () => ({ refresh: true }) },
       })
       g.strip('status', (scope, emit) => {
         emit({ text: '2 台在线', icon: 'team', tone: 'good' }); return () => {}
       })
     })
   }
   ```
3. 生效：重启引擎；验收：原生「全部功能 → Plugins」出现 Mesh 面板、输入框上方出现状态条。
4. 回滚：`dshGo` 块 + `lib/dshgo.js` 一起去掉（bridge 注册随插件 fiber 自动清理，`bridge:lib/native/core.js:371-374`）。

**为什么还值得做 C**：A 是 WebView（重、可能慢），B 只读且不可点；**只有 C 能在原生界面里实时刷新 + 点按钮派发**，且不依赖 Web 页面/3080。

---

## 4. `permissionPresetOnDshGo` 精确 patch 指引（转交 mesh-gap）

> 目的：让 mesh 在 dsh-go 上给入站任务设 `danger-full-access`，不再卡「待确认」；桌面行为零变化。
> ⚠ **并发编辑提醒**：`E:\mesh\dsh-plugin-mesh\lib\index.js` 正在被改（我这轮看到 mtime `2026-10-28 23:55`、3654 行、164,594 字节；00:00 还有 `lib/netinfo.js`、`lib/diagnostics.js` 新增）。**行号会漂移，用下面的锚点 grep 定位**。

### 4.1 为什么必须新增键，而不是改 `permissionPreset` 的默认值

- mesh 自带 `cordis.patch.yml` 的 `config:` 块**已经把 `permissionPreset: workspace-write` 钉死**；patch 里的 `config:` 是**整份替换**（`mesh:AGENTS.md` 硬约束 4）→ 改 schema 默认值对已装配置无效。
- 新增一个**不在任何 patch 里出现**的键，schema 默认值才会生效；桌面因检测不到 dsh-go 而走旧逻辑，零影响。
- 根因（详证见 `DSHGO-BRIDGE-INTEGRATION.md` §7）：dsh-go 组合默认 `sandbox-policy.mode=workspace-write`、`approval.policy=ask`（`dsh:dsh-base/cordis.patch.yml:243-247,259-262`），而 proot 没有沙箱后端、后台会话又没人应答 approval。

### 4.2 精确位置（当前行号 + 锚点）

| # | 位置 | 当前行号 | 锚点（grep 用） | 动作 |
|---|---|---|---|---|
| 1 | `lib/index.js` 配置 schema | `Config = z.object({` 在 **:210**，结束 `});` 在 **:376**；`permissionPreset` 在 **:290** | `grep -n 'permissionPreset: z.string'` | 在 :290 之后插入新键 |
| 2 | `permissionPresetFor()` | **:1189-1192** | `grep -n 'function permissionPresetFor'` | 加 dsh-go 分支 + 加检测函数 |
| 3 | `setupInbound()` 启动自检 | **:1200-1229**，`resolve` 在 :1216-1218，日志 :1219-1223 | `grep -n 'function setupInbound'` | 增加对 dsh-go preset 的 `resolve()` 与日志 |
| 4 | 三个 `set()` 调用点 | **:1272 / :1342 / :1410** | `grep -n 'permissionPresets.set(handle.agent.session'` | **不用改**（都走 `permissionPresetFor`） |
| 5 | 状态接口（UI 读的 config 快照） | **:2666-2675**，`permissionPreset: config.permissionPreset` 在 :2668 | `grep -n 'config: {' lib/index.js` | 增加 `permissionPresetEffective` |
| 6 | 已导入 `existsSync` | **:19** | `grep -n 'from "node:fs"'` | 不需要加 import ✅ |

### 4.3 补丁内容（可直接抄）

**(1) schema —— 在 `permissionPreset`（:290）之后插入：**

```js
  /**
   * dsh-go 手机引擎（proot/direct）上，入站任务用的权限 preset；留空 = 回退 permissionPreset。
   *
   * 为什么单独一个键：package 的 cordis.patch.yml 已把 permissionPreset 钉成
   * workspace-write（config 整份替换），改 schema 默认值对已装配置无效；
   * 新增一个不在 patch 里的键，默认值才会生效，且桌面不受影响（检测不到 dsh-go）。
   *
   * 为什么默认 danger-full-access：dsh-go 的 proot 里没有沙箱后端，
   * workspace-write 必被拒；approval=ask 在后台会话没人应答 —— 真机上就是
   * 「Mesh 任务 t-… 待确认」卡住。danger-full-access 对应 approval=never。
   */
  permissionPresetOnDshGo: z.string().default("danger-full-access"),
```

**(2) 检测 + 选择逻辑 —— 替换 `permissionPresetFor`（:1189-1192）整段：**

```js
/** dsh-go 本机引擎的运行时标记（App 每次启动写；桌面/远端主机没有）。 */
const DSH_GO_MARKER = "/etc/dsh-app/runtime.json";

/**
 * 是否跑在 dsh-go 的手机引擎里（proot 或 direct 都算）。
 * 优先看 App 注入的 env（真机 launch argv 实测有 DSH_GO_RUNTIME_ROOT），
 * 退而看 App 写的 runtime.json；两者都没有 = 普通主机。
 * 注意：不要用 process.platform 判断（桌面 Linux 也是 linux），
 * 也不要用「装了 bridge」判断（远端主机也能装 dsh-go-bridge）。
 */
export function isDshGoRuntime(env = process.env) {
  if (typeof env.DSH_GO_RUNTIME_ROOT === "string" && env.DSH_GO_RUNTIME_ROOT !== "") return true;
  try {
    return existsSync(DSH_GO_MARKER);
  } catch {
    return false;
  }
}

function permissionPresetFor(config, task) {
  const dshGoPreset = config.permissionPresetOnDshGo;
  if (dshGoPreset && isDshGoRuntime()) return dshGoPreset;
  if (task?.transport === "tsnet") return config.tsnetPermissionPreset || config.permissionPreset;
  return config.permissionPreset;
}
```

**(3) 启动自检 —— 在 `setupInbound()` 的 try 里（:1216-1218 之后）加：**

```js
      const dshGoPreset = config.permissionPresetOnDshGo && isDshGoRuntime()
        ? config.permissionPresetOnDshGo : "";
      if (dshGoPreset) scoped.permissionPresets.resolve(dshGoPreset);
```
并把 :1219-1223 的日志补上，例如：
```js
        `入站唤醒已就绪（自包含实现，权限 preset=${dshGoPreset || config.permissionPreset}` +
          (dshGoPreset ? "（dsh-go）" : "") +
```
`resolve()` 找不到 preset 会抛错 → 现有的 `catch`（:1224-1227）会置 `waker.ready=false` 并 warn，行为与现在一致。

**(4) 状态接口 —— :2668 附近加一行（让 UI 显示生效值）：**

```js
        permissionPreset: config.permissionPreset,
        /** 实际生效值（dsh-go 上可能是 permissionPresetOnDshGo） */
        permissionPresetEffective: config.permissionPresetOnDshGo && isDshGoRuntime()
          ? config.permissionPresetOnDshGo : config.permissionPreset,
```

### 4.4 为什么这样只对 dsh-go 生效

| 主机 | `isDshGoRuntime()` | 用的 preset |
|---|---|---|
| dsh-go 手机引擎（proot/direct） | true（`DSH_GO_RUNTIME_ROOT` 或 `/etc/dsh-app/runtime.json`） | `permissionPresetOnDshGo` = `danger-full-access` |
| 桌面 DSH（Win/mac/Linux） | false | `permissionPreset`（不变，仍 workspace-write） |
| 远端 SSH 主机（可能装了 dsh-go-bridge） | false（没有 `/etc/dsh-app`，也没有 runtime env） | 同上，不误伤 |

### 4.5 测试与验收

- **不需要手机就能测检测函数**：`isDshGoRuntime()` 接受 `env` 注入，且 `DSH_GO_RUNTIME_ROOT` 分支可被测试直接命中：
  ```js
  import { isDshGoRuntime } from '../lib/index.js'
  isDshGoRuntime({ DSH_GO_RUNTIME_ROOT: '/x' })                       // true
  isDshGoRuntime({})                                                   // 取决于本机 /etc/dsh-app/runtime.json（开发机 false）
  ```
  建议照 mesh 现有 `lib/_selftest-*.mjs` 风格加一个 `_selftest-permission-preset.mjs`（纯函数，不建会话、不烧 token），并挂进 `package.json` 的 `selftest:*` 与 `test` 链（AGENTS.md §5 的测试地图）。
- **真机验收**：桌面派一条需要写文件的任务到手机 → 手机 App 里「Mesh 任务 t-…」会话**不再停在待确认**，agent 直接把活干完并回执；Mesh 页面「诊断/任务记录」里 `permissionPresetEffective` 应显示 `danger-full-access`（若加了 4.2#5）。
- **回归**：桌面 DSH 上重复同一派发，权限仍是 `workspace-write`（行为不变）。

### 4.6 风险

- 外部不可信输入获得**全权**（可读写 guest 全部文件）。缓解：dsh-go 上建议同时开 `requirePairing: true`（`mesh:lib/index.js:285`）+ 保留现有的 `minTaskChars`/冷却/线程上限（同文件「循环熔断」段）+ 在原生面板里明示「本机 Mesh 任务拥有完全访问」。
- 若用户不接受全权：把 `permissionPresetOnDshGo` 设 `""`（回退旧行为）或 `workspace-write`，代价是继续要点确认。
- **不要**把新键写进 `cordis.patch.yml`（会把桌面也钉住，且违反「一个键两处维护」）；如果确实要写，必须**改现有 config 块**而不是新增第二个 `- id: mesh`。

---

## 5. 三条路径组合建议

| 阶段 | 做什么 | 成功判据 | 失败退路 |
|---|---|---|---|
| P0（今天就能做） | **A**：写 ui.json island 席位，等 1~2 秒看原生界面（不用重开 App） | 原生侧栏/面板出现 mesh 的 Web 面板 | 换 slot `dsh-go.panel` / 模式 `native`；查 `ui.status.json` |
| P0.5 | **B**：给 `mesh_peers` 加 `presentationMeta`，重启引擎 | 原生聊天里 mesh_peers 结果是卡片 | 先离线 checker 通过，再上机；仍失败看是否是 App 版本不支持工具卡（kit 与 App 同版本，概率低） |
| P1 | **C**：task-3 的 `lib/dshgo.js` P0 版（peers 面板 + 状态条 + 派发动作） | 原生「全部功能」有 Mesh 面板、输入框上方有状态条、能派发 | 回滚清单：删新文件 + `dshGo` 块 |
| P1 | **permissionPresetOnDshGo**（§4） | 入站任务不再「待确认」 | 设空字符串回退 |

---

## 6. 待实测清单

| # | 待测 | 观察点 | 影响 |
|---|---|---|---|
| 1 | ui.json `sidebar.panellist` seats=`island` 是否在原生界面出东西 | App 原生侧栏/抽屉 | 路径 A 成败 |
| 2 | `ui.status.json` 结构（是否有 applied/ignored 明细） | `cat $DSH_HOME/dsh-go/ui.status.json` | 验收证据 |
| 3 | `dsh-go.panel` slot 是否更适合放面板 | 换 slot 重试 | 路径 A 的备选 |
| 4 | 工具卡在原生聊天是否真的渲染（App 0.9.7） | 调 `mesh_peers` | 路径 B 成败 |
| 5 | 工具卡超 8 KiB 时 App 的行为（截断/不显示） | 造 80 台假 peer | 展示截断策略 |
| 6 | island 是否依赖 Web 模式/3080 且 token 是否自动带上 | 停引擎/断网试 | 路径 A 的可靠性 |
| 7 | `permissionPresetOnDshGo` 生效后任务是否全自动 | 真机派发写文件任务 | 见 §4.5 |
| 8 | mesh 的 `machine="localhost"` 在三条 UI 里的显示是否已兜底 | 看卡片/面板 | 见 §0 |

---

## 7. 附：本手册用到的离线资产与可复现命令

| 资产 | 说明 |
|---|---|
| `E:\mesh\.tmp\assemble-kit.sh` | 把 APK 里**扁平**的 skill 资产按 `manifest.json` 还原成 App 写入 guest 的布局（`kit/bin/check.mjs`、`kit/lib/**`、`kit/schema/**`、`scripts/check.mjs`、`schema.json`…） |
| `E:\mesh\.tmp\dshgo-kit\` | 还原后的 **dsh-go-plugin** kit（可直接 `node kit/bin/check.mjs …`） |
| `E:\mesh\.tmp\dshgo-ui-kit\` | 还原后的 **dsh-go-ui** kit（`scripts/check.mjs` + `schema.json`） |
| `E:\mesh\.tmp\samples\` | `tool-card-peers.json`（✅ renders）、`tool-card-50.json`、`tool-card-40.json`、`tool-card-bad.json`（绑定+按钮，2 notes）、`ui-mesh-island.json`（✅ 已应用 1 项）、`ui-unseatable.json`（❌ 忽略） |
| `E:\mesh\.tmp\run-checkers.sh` / `w22-w27.sh` | 跑校验器/取行号锚点的脚本（WSL，node v22.22.1） |

复现（WSL）：
```sh
bash /mnt/e/mesh/.tmp/assemble-kit.sh
bash /mnt/e/mesh/.tmp/run-checkers.sh     # 输出见 §A.8 / §B.4
```
