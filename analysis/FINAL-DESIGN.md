# 最终设计清单（P0 / P1 / P1.5 / P2 + 验证手册）

> 汇总 `DSHGO-INTERNALS.md`、`DSHGO-BRIDGE-INTEGRATION.md`、`UI-ZEROCODE-PATHS.md`、`GAP-ANALYSIS.md`、`P0-IMPLEMENTATION.md`、`E2E-VERIFY-PLAN.md`，给出 mesh 在 dsh-go 上**最终要落什么、谁在做、怎么验、风险在哪**。
> 状态快照：**2026-10-29 00:12 +08:00**（仓库 `E:\mesh`，git 已初始化）。
> ⚠ 并发提示：mesh-gap 正在做 P1，工作区有未提交改动（`M lib/index.js`、`M lib/osinfo.js`、`M lib/tsnet/download.js`、`?? lib/dshgo.js`、`?? lib/inbound-preset.js`）。**本清单里的行号都会漂，定位一律用锚点（函数名/原文串）**。
> 规则遵守：本文只写 analysis，不改 `dsh-plugin-mesh`、不碰设备。

---

## 0. 一页总览

| 阶段 | 内容 | 状态 | 提交/证据 | 一句话验收 |
|---|---|---|---|---|
| **P0** | netinfo 安全地址采集、scan 兜底、staticPeers / advertiseAddress / sidecarPlatform | ✅ 完成 | `6855343`（其前置部分落在基线 `da528da`，见 §1 注） | `npm run selftest:netinfo` 28/0 + `npm run selftest` 67/0 + 真机 health `diag.net` |
| **P1** | dsh-go 环境识别、`permissionPresetOnDshGo`、osinfo/identity/capabilities、tsnet 资产策略 | 🚧 进行中（mesh-gap，task-5） | 工作区（未提交） | 真机日志「来源 dsh-go」+ 入站不再「待确认」+ health `diag.dshGo`/`sidecarTarget` |
| **P1.5** | USB/adb 传输（`lib/usb.js`）：桌面经 `adb forward` 直连手机 mesh | 🚧 进行中（task-7，另一 teammate） | `lib/usb.js` 尚未落盘（00:12） | 关掉 WiFi 后桌面 `mesh_run` 仍能派到手机；`/mesh/v1/peers` 出现 `transport:"usb"` |
| **P2** | bridge 原生面板（`dshGo` 清单 + `lib/dshgo-ui.js`）、工具卡 `presentationMeta`、`ui.json` island seat | ⬜ 可选（其中 ui.json/工具卡可立即验证） | 设计见 `DSHGO-BRIDGE-INTEGRATION.md` / `UI-ZEROCODE-PATHS.md` | 原生界面能看到 Mesh 面板/卡片，无需切 Web 模式 |
| **零改代码** | `ui.json` island 席位 | ✅ 示例已过官方 checker；端到端待实测 | `UI-ZEROCODE-PATHS.md` §1 | 原生侧栏出现 Mesh 入口 |

**依赖顺序**：P1 的 `permissionPresetOnDshGo` 是**真机阻塞项**（不修则每个入站任务都停在「待确认」）→ 必须最先落；P1.5 的接线要等 P1 提交后做（同一文件，避免冲突）；P2 与它们无耦合，可并行/靠后。

---

## 1. 阶段 P0 ✅（已完成）

| # | 改了什么 | 文件 | 验收方式 | 风险/边界 | 实测状态 |
|---|---|---|---|---|---|
| P0-1 | 新增地址采集安全网：`config > os.networkInterfaces > UDP 源地址 > /proc`，**任何情况不抛**，返回 `{lanIPv4, addresses[], source, macsAvailable, errors[]}` | `lib/netinfo.js`（新，~563 行） | `npm run selftest:netinfo` → 28 通过 / 0 失败 | `source:"none"` 是**明确结论**（真没地址），不是"探测失败"；`errors[]` 永远带原因（AGENTS.md 硬约束 1） | 离线 ✅；真机字段待 P0 包上机 |
| P0-2 | `discovery` 的地址三函数全改走 netinfo；构造/心跳/HTTP **零抛**；新增 `MeshDiscovery.netInfo()`；无地址时异步 UDP 预热并重播公告 | `lib/discovery.js` | 同 P0-1 的用例 7（monkey-patch EPERM 仍可构造）；`selftest:ok` | MAC 不可用显式标 `MAC_UNAVAILABLE`（真机 `00:00:…` 即此情况） | 离线 ✅ |
| P0-3 | `scan` 网卡枚举 `try/catch`；`candidateAddresses(extraRanges, limit, extraHosts)`，**staticPeers 先于网段展开**（不会被 limit 截掉） | `lib/scan.js` | 用例 7 + `npm run selftest` | 网卡全挂时仍能用 `scanRanges`/`staticPeers` 扫端口 | 离线 ✅ |
| P0-4 | 三个配置键：`staticPeers: []`、`advertiseAddress: ''`、`sidecarPlatform: 'auto'`（schema + `cordis.patch.yml` **保留原 22 键** + 全链路接线 + health diag） | `lib/index.js`、`cordis.patch.yml`、`lib/diagnostics.js` | `npm run check`（含 `node --check lib/netinfo.js`）；真机 health `diag.net`/`diag.sidecarPlatform` | **patch 的 `config:` 是整份替换**：以后再加键必须保留全部原键（AGENTS.md 硬约束 4）；`sidecarPlatform` P0 只存值+诊断，资产选择在 P1 | 离线 ✅ |
| P0-5 | 自测入链：`_selftest-netinfo.mjs`（28 用例，六类形态）；`selftest:lan` 改 `--pair` 自动双进程；`reply-route` 加 health diag 断言；`docs/llms.txt` 生成 | `lib/_selftest-*.mjs`、`package.json`、`docs/llms.txt` | 见下方命令块 | `selftest:lan` 退出码 3 = 没人和我配对（不是回归） | 离线 ✅ |

**P0 验收命令（可复现，全离线除 `selftest:lan`）**
```powershell
cd E:\mesh\dsh-plugin-mesh
npm run check                # 语法/TDZ/版本/registry/loadable/docs
npm run selftest:netinfo     # 28 通过，0 失败
npm run selftest             # 67 通过，0 失败
npm run selftest:lan         # [pair] 两端 exit=0
```
> 注（便于 bisect）：基线提交 `da528da` 其实**已经包含** `lib/netinfo.js` 与 discovery/index 的 P0 半成品（23:54 提交工作区），`6855343` 是 P0 收尾（scan/selftest/patch/health diag）。所以"P0 = 6855343"只是标签，`git log -- lib/netinfo.js` 会显示 `da528da`。

---

## 2. 阶段 P1 🚧（进行中，mesh-gap / task-5）

> 目标：让 mesh 在 dsh-go 上**认得出环境**、**入站默认全自动**、**身份/能力不再脏**、**tsnet 选对资产**。
> 当前工作区（00:12）：`lib/dshgo.js`（新，探测）、`lib/inbound-preset.js`（新，纯函数）、`lib/index.js`（已接线 P1-0/P1-1/P1-3 import）、`lib/osinfo.js`（P1-2 进行中）、`lib/tsnet/download.js`（P1-3 已导出 `configureSidecarPlatform`/`describeSidecarTarget`）。都**未提交**。

| # | 内容 | 文件 | 验收点 | 风险 | 实测状态 |
|---|---|---|---|---|---|
| **P1-0**（阻塞项） | `permissionPresetOnDshGo`（默认 `''` = 不覆盖）→ dsh-go 环境且非空时入站会话用该 preset；解析顺序 `dsh-go 覆盖 > tsnet 收紧 > 默认` | `lib/inbound-preset.js`（新）、`lib/index.js`（`permissionPresetFor` / `setupInbound` 已接线）、schema | ① `resolveInboundPermissionPreset({config,task,dshGo})` 纯函数单测；② 真机日志「权限 preset=danger-full-access（来源 dsh-go）」；③ 手机不再弹「待确认」 | 外部输入全权 → 必须 `requirePairing: true`（建议）；桌面零变化靠"检测不到 dsh-go"；**新键不要写进 cordis.patch.yml**（patch 整份替换，靠 schema 默认生效） | 接线中；单测待补 |
| **P1-1** | dsh-go 环境探测：`/opt/dsh-go`、`/etc/dsh-app`、`/system/build.prop`、`os.release()` 含 android、`/system/bin/getprop`、`/dev/__properties__`、env `DSH_GO_RUNTIME_ROOT`（**真机实测不存在**，不能单靠）；只读、进程缓存、**永不抛** | `lib/dshgo.js`（新） | `node -e "import('./lib/dshgo.js').then(m=>console.log(m.dshGoSummary()))"`；真机 log「检测到 dsh-go/Android proot 环境：<机型>」 | 探测误判 → 只在"包装层标记 or Android 内核+/system 挂载"时算 true，两类都按 dsh-go 类环境对待 | 已落盘（未提交） |
| **P1-2** | 身份三件套：osinfo（`osInfo.platform=android`、`name`、`systems[]` 增加 `kind:"runtime"` 的 Ubuntu/`host` 的 Android）；identity（`/system/build.prop` 的 `ro.serialno`/`ro.boot.serialno` → `/etc/machine-id`（真机空）→ 组合 hash，**空则保持空不乱认领**）；capabilities（`cpuCores`：`availableParallelism()` → `os.cpus().length` → `/proc/cpuinfo` 计数；真机 `cpus().length=0`、`availableParallelism=8`） | `lib/osinfo.js`（进行中）、`lib/identity.js`、`lib/capabilities.js` | `npm run selftest:osinfo`、`npm run selftest:caps`（加 dsh-go fixture）；真机 health `osInfo.platform==="android"`、`systems[]` 有 host+runtime、`capabilities.cpuCores===8` | 纯增量协议：老对端忽略未知 `kind`；`systems` 最多 4 条（`MAX_SYSTEMS`）；指纹空值不得"认领"成同一台 | P1-2 进行中（osinfo 已改） |
| **P1-3** | tsnet 资产策略：`detectTarget()` 在 dsh-go 上默认选 **android/arm64** 资产（linux 静态资产会死在 netns controlC）；`sidecarPlatform` 配置可覆盖；health/diag 暴露选中资产 | `lib/tsnet/download.js`（已导出 `configureSidecarPlatform`/`describeSidecarTarget`）、`lib/index.js` | 单测：`detectTarget()` 在注入 dsh-go=true 时返回 android；真机 health `diag.sidecarTarget`；sidecar 实际启动日志 | 覆盖优先级：显式 `sidecarPlatform=linux` 必须生效（真机救急）；`auto` 时桌面仍 linux | 进行中（导出已加，接线见 index.js diff） |

**P1 验收（等 mesh-gap 提交后）**
```powershell
cd E:\mesh\dsh-plugin-mesh
npm run check
npm run selftest:osinfo ; npm run selftest:caps
# 新增建议：npm run selftest:inbound-preset（纯函数：dshGo true/false × 空/非空 × tsnet 优先级）
```
真机：`/mesh/v1/health` 里应出现 §4-C 的字段；派一条任务确认不再「待确认」。

---

## 3. 阶段 P1.5 🚧（进行中，task-7 / 另一 teammate）：USB/adb 传输

**要解决**：不依赖局域网/组播/同网段，桌面经 `adb forward` 直连手机的 mesh 45917；USB 是**确定性传输**，也是"手机只插线不连 WiFi"场景的唯一通道。

### 3.1 交付物（task-7 定义）
`lib/usb.js`（新，自包含、依赖注入、**绝不抛**）+ `lib/_selftest-usb.mjs`（≥12 用例）+ `analysis/USB-ADAPTER-DESIGN.md`。
截至 00:12：`lib/usb.js` **尚未落盘**（`Test-Path` false）。

设计要点（摘自 task-7，供接线方对照）：
- `adb devices -l` → 解析 `[{serial,state,model,...}]`，跳过 `unauthorized`/`offline` 并记原因；
- 端口按 serial 稳定 hash 落在 `[forwardBase=46000, 46000+99]`，冲突顺延；先查 `adb forward --list` 复用；
- `ensureForward` 幂等；`probe` = `GET http://127.0.0.1:<localPort>/mesh/v1/health` 拿对端名片；
- 产出 endpoint `{key:'usb:'+serial, transport:'usb', host:'127.0.0.1', port:localPort, ...health}`；
- `start/stop` 幂等，`stop` 清 forward + 定时器；adb 不存在 → `{available:false, reason:'ENOENT'}` 静默。

### 3.2 与 discovery/派发的接线点（全部是**已有**机制，USB 只是多一个 transport）

| 接线点 | 位置（锚点，行号会漂） | USB 需要做什么 |
|---|---|---|
| 端点排序 | `export const TRANSPORT_RANK = { lan: 0, tsnet: 1 };`（discovery.js:131） | 改为 `{ lan: 0, usb: 1, tsnet: 2 }`（**USB 胜过 tsnet**：不过 DERP、不过用户态网络栈；与 LAN 并存时 LAN 优先，交给 RTT/verified 细分） |
| 登记对端 | `note(record, sourceAddress, meta = {})`（discovery.js:621）→ `#upsert(msg, rinfo)`（:796） | `discovery.note(healthRecord, "127.0.0.1", { transport:"usb", channel:"usb:"+serial, port:localPort, rttMs })`；`#upsert` 已支持 `rinfo.port/channel/rttMs`，端点 key = `channel` |
| 端点投影 | `peers()` / `#project()`：`transport: chosen?.transport` | 不用改：选中 USB 端点时对外 `transport:"usb"`、`channel:"usb:<serial>"` |
| 派发 | `async function peerFetch(peer, path, opts)`（index.js:1822）→ `orderedEndpoints(peer)` 逐通道失败切换；非 tsnet 走 `fetchViaLan` | 不用改：`http://127.0.0.1:<localPort>` 就是普通 fetch |
| 健康探测 | 定时 ping 循环按端点 `ep.transport` 选间隔（`ep.transport === "tsnet" ? tsnetInterval : pingIntervalMs`） | 不用改：USB 端点按 `pingIntervalMs` 被探，失败自动进冷却 |
| 快照 | `persist.js` / `discovery.restore()` | 不用改：`restore` 只要求 `ep.transport` 非空；USB 历史端点显示为离线，`start()` 后覆盖 |
| 健康诊断 | `const netDiag = () => {…}`（index.js:2149，`/mesh/v1/health`） | 加一项 `usb: usb.summary()` → `{available, devices, forwards, lastError}` |
| UI | `client/client.js:5233` 通道列只映射 `lan/tsnet` | USB 会显示原始串 `usb`（可接受；client.js 不在 P1.5 范围，P2 再美化） |

### 3.3 验收
```powershell
adb devices -l                       # 至少一台 device
adb forward --list                   # 应出现 tcp:46xxx tcp:45917
curl -s http://127.0.0.1:46xxx/mesh/v1/health | ConvertFrom-Json | Select id,machine,host,port
# 桌面 DSH：
#   mesh_peers           → 手机在列表里（是否走 usb 看下一行）
#   /mesh/v1/peers       → peers[].endpoints[] 含 {"transport":"usb","host":"127.0.0.1","port":46xxx}
```
**最强验收**：**关掉手机 WiFi**，桌面 `mesh_run(phone, …)` 仍成功 → 证明 USB 通道独立于局域网。

### 3.4 风险
- adb server 权限/多 server 混用（`adb -P` 端口不同）；`forward` 泄漏（进程崩溃未清理）→ `stop()` + 启动时按 serial 先清再建；
- 设备拔插/授权变化 → `listDevices` 每轮重算，`unauthorized` 只记 error 不重试爆刷；
- 端口冲突（46000–46099 用尽）→ 记 error 并跳过该设备；
- 安全：`adb forward` 只监听 127.0.0.1，不暴露局域网；但桌面上的 adb 权限本身等于设备控制权（文档里要写清）。

---

## 4. 阶段 P2 ⬜（可选，UI 侧）

| # | 内容 | 文件 | 验收 | 风险 | 实测状态 |
|---|---|---|---|---|---|
| P2-1 | **bridge 原生面板**：`package.json` 加 `dshGo` 清单（2 panel + 1 strip + 2 action + `capabilities:["files"]`），新增 **`lib/dshgo-ui.js`** 用 `ctx.inject(['dshGo'])` 注册（⚠ 命名：`lib/dshgo.js` 已被 P1-1 环境探测占用，UI 模块一律用 `lib/dshgo-ui.js`；task-3 里写的 `lib/dshgo.js` 以此为准） | `package.json`、`lib/dshgo-ui.js`（新）、`lib/index.js`（apply 里调用） | 手机原生「全部功能 → Plugins」出现 Mesh 面板；输入框上方状态条；胶囊可派发 | 视图 ≤32KiB/120 节点/8 层；data ≤32KiB@4Hz；连续 5 次违规会关原生 UI；**必须方法调用 `ctx.dshGo.*`** | 设计已定（`DSHGO-BRIDGE-INTEGRATION.md` §2/§3/§8），未实现 |
| P2-2 | **工具卡**：4 个 tool 的 `output.presentationMeta` 返回 `{'dsh-go/view': …}` | `lib/index.js`（4 处 `output: {` 在 `name:"mesh_peers|scan|run|tasks"` 后） | 原生聊天里 mesh 工具结果是卡片；离线 `kit/bin/check.mjs <json> --budget toolCard` → `renders` | 同步、lossless JSON、**抛错=整次工具调用失败**（必须 try/catch 返回 `{}`）；无绑定、不可点；≤8KiB/40 节点/6 深度（实测约 **71 台**封顶） | 离线 checker 已实测 ✅（`UI-ZEROCODE-PATHS.md` §B.4） |
| P2-3 | **`ui.json` island seat**（零改代码，详见 §5） | guest `/root/.dsh/dsh-go/ui.json` | 原生侧栏出现 Mesh 入口（待实测） | 依赖 App 0.9.7 的 island 渲染；`unseatable` slot 会被忽略 | 示例已过官方 checker ✅；端到端待实测 |
| P2-4 | 文件通道（v1.3 picker）→ 选 tgz 落盘/安装；v2 表单派发 | `lib/dshgo-ui.js`、`package.json` 的 `capabilities:["files"]` | App 里选包 → 面板显示已接收；v2 表单在 `caps.components` 支持时启用 | picker 限 8MiB/文件、16MiB/总、回调 3s 内必须读完、只能在回调里 `readPickedFile`；自升级需重启引擎 | 设计已定（§5），未实现 |

---

## 5. 零改代码快速验证（不动 host 逻辑）

> 目的：**今天就能确认"手机原生界面能不能看到 mesh"**，不用等 P2 实现。完整细节见 `UI-ZEROCODE-PATHS.md`，这里给收敛版。

### 5.1 `ui.json` island 席位（0 行代码）

**写入路径**（guest 内，App 私有目录）：`/root/.dsh/dsh-go/ui.json`
（= `$DSH_HOME/dsh-go/ui.json`；本机启动 env 实测 `DSH_HOME=/root/.dsh`，`APK:assets/runtime/manifest.json`）

**示例（已被官方 checker 验证通过：`已应用 1 项`）**
```json
{
  "version": 1,
  "plugins": {
    "seats": {
      "sidebar.panellist": { "dsh-plugin-mesh": "island" }
    }
  }
}
```
- `seats` 语义：`native` 原生画 / `island` 内嵌网页 / `web` 在网页版打开 / `hidden` 隐藏（`apk:skills/dsh-go-ui/SKILL.md:67`）。
- `sidebar.panellist` 在可 seat 白名单（`known` 且在 `unseatable` 之外）；备选 slot：`dsh-go.panel`（待实测）。

**写入 + 自查（在手机 App 的 agent bash 里执行）**
```sh
mkdir -p "$DSH_HOME/dsh-go"
cat > "$DSH_HOME/dsh-go/ui.json" <<'JSON'
{"version":1,"plugins":{"seats":{"sidebar.panellist":{"dsh-plugin-mesh":"island"}}}}
JSON
node "$DSH_HOME/skills/dsh-go-ui/scripts/check.mjs" "$DSH_HOME/dsh-go/ui.json"
# 期望：ui.json：已应用 1 项     （exit 0）
```
**生效/观察**：保存后 **1~2 秒自动生效，不用重启引擎/重开 App**（`SKILL.md:10`）；`cat "$DSH_HOME/dsh-go/ui.status.json"` 是 App 实际读到的结果（`SKILL.md:25`）。
**回滚**：删掉 `plugins.seats` 这一项（或删文件）→ 1~2 秒恢复；App 设置里「来自 ui.json → 恢复默认」只让 App 忽略、不改文件（`SKILL.md:26`）。
**风险**：island 端到端渲染**未实测**（唯一未知）；`unseatable` slot 会被忽略；mesh 未启用则无内容。

### 5.2 工具卡（每工具 ~10 行，独立小改动）
在 `mesh_peers` 的 `output: { schema, render }` 里加：
```js
presentationMeta: (_args) => {
  try {
    const peers = discovery.peers()
    const view = { type: "stack", title: "Mesh 设备", children: [
      { type: "metric", label: "在线", tone: "good",
        value: `${peers.filter((p) => p.online).length} / ${peers.length}` },
      { type: "list", items: peers.slice(0, 20).map((p) => ({
        title: displayName(p), subtitle: `${p.host}:${p.port}`, icon: "team",
        trailing: p.online ? "在线" : "离线", tone: p.online ? "good" : "muted" })) },
    ] }
    return JSON.stringify(view).length <= 8000 ? { "dsh-go/view": view } : {}
  } catch { return {} }   // 抛错会让整次工具调用失败
}
```
离线验收（手机或本机均可，kit 已随 App 落到 guest）：
```sh
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" tool-card.json --budget toolCard
# 期望：View tool-card.json (tool card): renders
```
生效：改的是 `lib/` → **重启引擎**。限制：无绑定、不可点、≤8 KiB（约 71 台封顶）。

---

## 6. 给用户看的验证清单（装完后怎么确认）

> 前提：装包 + 重启引擎；P1 落地后按服务端日志确认 dsh-go 探测与权限 preset。
> 建议把每条的输出存进 `E:\mesh\evidence\`（见 `E2E-VERIFY-PLAN.md`）。

### A. 桌面 `mesh_peers` 应看到什么

| 期望 | 现在（P0 版） | P1/P1.5 后应变成 | 判据/命令 |
|---|---|---|---|
| 手机出现在列表里 | ✅ 已成立（真机） | 同 | 桌面 DSH 调 `mesh_peers` |
| **名字不是 `localhost`** | ❌ `machine: "localhost"`（`os.hostname()`；`discovery.selfRecord()` 的 machine 回退） | 机型名（`ro.product.model`）或至少 Android 标识 | `mesh_peers` 该行首列；或 `curl /mesh/v1/health \| jq .machine` |
| 系统行 | `linux 5.x…`（Ubuntu） | `Android 15 …` + proot 运行时分开显示（`systems[]` 宿主机/runtime 两条） | `mesh_peers` 的 systems 列；`health.systems` |
| 能力行 | `cpuCores:0`（真机 `os.cpus().length=0`） | `8 核`（`availableParallelism()`） | `health.capabilities.cpuCores === 8` |
| 地址/端口 | `192.168.1.19:45917`（LAN） | LAN 时不变；**USB 时 `127.0.0.1:46xxx`** | `health.host`；`/mesh/v1/peers` |
| **transport 含 usb** | 无（只有 lan/tsnet） | `/mesh/v1/peers` 里 `transport` 或 `endpoints[].transport === "usb"`（工具文本本身不打印 transport；Web UI 通道列会显示 `usb` 原串） | `curl /mesh/v1/peers \| jq '.peers[].endpoints[] \| select(.transport=="usb")'` |

### B. 手机 dsh-go 原生侧栏/面板应出现什么

| 路径 | 应看到 | 状态 |
|---|---|---|
| **零改代码（ui.json island）** | App 原生侧栏/抽屉出现 Mesh 入口，点开是 mesh 的 Web 面板（内嵌） | 待实测（示例已过 checker） |
| **P2 bridge 原生面板** | 「全部功能 → Plugins」出现 Mesh 面板；输入框上方状态条「N 台在线」；胶囊「派发到设备」 | 未实现（设计已定） |
| **Web 模式**（对照） | 侧栏 Mesh 面板（同桌面） | 已成立（App Web 模式） |
| 不出现时排查 | `cat $DSH_HOME/dsh-go/ui.status.json`（ui.json 是否被读）；App 设置「来自 ui.json」；引擎日志里 mesh 是否加载 | — |

### C. `/mesh/v1/health` 应新增哪些字段

命令（PC 侧，经 adb forward）：
```powershell
adb forward tcp:45917 tcp:45917
curl -s http://127.0.0.1:45917/mesh/v1/health | ConvertFrom-Json
```

| 字段 | 期望值 | 来源/阶段 | 说明 |
|---|---|---|---|
| `diag.net.source` | `"os"`（真机 7 网卡时） | P0 ✅ 已实现 | 若 `"udp"/"proc"/"none"` 说明 os 路径拿不到，但仍可用（带原因） |
| `diag.net.macsAvailable` | 真机 `false`（MAC 全 0 被 SELinux 拒） | P0 ✅ | `errors[]` 里应有 `MAC_UNAVAILABLE` |
| `diag.net.errors[]` | `[{source,code}]`（≤6） | P0 ✅ | 区分 EPERM/EACCES/ENOENT，不是"没地址" |
| `diag.sidecarPlatform` | `"auto"`（或配置值） | P0 ✅ | P0 只存值 |
| `diag.sidecarTarget` | `android/arm64`（dsh-go 上） | P1-3 | 选中资产；桌面为 linux/* |
| `diag.dshGo` | `{isDshGo:true, deviceModel, androidVersion, evidence:[…]}` | P1-1 | 探测证据链，便于排障 |
| `osInfo.platform` | `"android"` | P1-2 | 之前是 `"linux"` |
| `osInfo.name` / `osInfo.version` | `Android` / `15`（或机型名） | P1-2 | 老对端回退解析 `os` 字符串 |
| `systems[]` | 含 `kind:"host"`（Android 机型）+ `kind:"runtime"`（Ubuntu 24.04 proot） | P1-2 | 纯增量，老对端不丢 |
| `capabilities.cpuCores` | `8`（真机 `availableParallelism=8`） | P1-2 | 之前 `0` |
| `host` | `192.168.1.19`（LAN）或 `127.0.0.1`+forward（USB） | P0/P1.5 | `advertiseAddress` 可强制 |
| `mac` | `""`（空，不是 `00:00:00:00:00:00`） | P0 ✅ | 显示层要过滤 |

### D. `/mesh/v1/tasks` 与「待确认」

- 手机侧：`curl http://127.0.0.1:45917/mesh/v1/tasks`（或经 LAN）→ 入站任务记录 `status` 迁移：`accepted → stored-only / busy / queued-for-session → dispatched`（失败为 `dispatch-failed` / `queued-lost`）；带 `transport`、`sourceAddress`、`receivedAt`。
- **不再弹「待确认」**：P1-0 生效后（手机 dsh-go 上 `permissionPresetOnDshGo: "danger-full-access"` + 重启引擎），桌面派一条需要写文件的任务 → 手机 App 会话直接跑完并回执，会话列表不出现「Mesh 任务 t-… 待确认」。
- 若仍待确认：查引擎日志「入站唤醒已就绪（… 权限 preset=…（来源 dsh-go）…）」；若显示「未设 permissionPresetOnDshGo」→ 配置未生效（profile 的 cordis.patch.yml 里加 `- id: mesh / config:` 时注意**整份替换**，要保留其余键）。

### E. 双向 `mesh_run` 各一次（最终功能验收）

| 方向 | 步骤 | 期望 |
|---|---|---|
| 桌面 → 手机 | 桌面调 `mesh_run(phone, "在手机上执行 uname -a 并回报")` | 桌面工具返回派发成功；手机 `/mesh/v1/tasks` 出现该任务且最终执行；手机 agent 回执回到桌面原会话（同一 thread 复用） |
| 手机 → 桌面 | 手机 agent 调 `mesh_run(desktop, "…")` | 桌面 `/mesh/v1/tasks` 出现入站；桌面 agent 执行并回执 |
| USB 专项 | 关手机 WiFi，重复「桌面 → 手机」 | 仍成功（P1.5 目标）；`/mesh/v1/peers` 显示 `usb` 端点 |

---

## 7. 给 mesh-gap 的 USB 接线清单（一段话 + 最小 hunk）

> 已另行 `send_message` 发给 mesh-gap（含 permissionPresetOnDshGo 锚点提醒）。这里是**等 P1 提交后**再接 USB 的最小改动；原则：只加 3 处、不动 discovery 其它逻辑、不碰 `permissionPresetFor`/`setupInbound`。

```js
// ① discovery.js —— 只改一行（锚：export const TRANSPORT_RANK）
export const TRANSPORT_RANK = { lan: 0, usb: 1, tsnet: 2 };   // USB 胜过 tsnet；LAN 仍优先

// ② index.js applyUnsafe() —— 锚：configureNetInfo({ advertiseAddress: ... }); 之后
const usb = createUsbTransport({
  devicePort: config.port ?? MESH_DEFAULT_PORT,     // 手机 mesh 端口（默认 45917）
  log, warn,
  onEndpoints(list) {
    for (const ep of list) {
      // note() 契约：record = 对端 /mesh/v1/health JSON；sourceAddress 用 127.0.0.1；
      // meta 里传 port（forward 本地端口）与 channel（USB 端点身份），#upsert 已支持
      discovery.note(ep.record, "127.0.0.1", {
        transport: "usb", channel: ep.key, port: ep.localPort, rttMs: ep.rttMs,
      });
    }
  },
  onError(e) { warn(`usb: ${e.serial ?? "?"} ${e.phase}: ${e.code ?? e.message}`); },
});
ctx.effect(() => () => usb.stop());    // forward + 定时器清理（与 P1 的 ctx.effect 风格一致）
usb.start();                           // adb ENOENT 时内部 no-op、不抛

// ③ index.js netDiag() —— 锚：const netDiag = () => {
//   返回对象里加： usb: usb.summary()   // {available, devices, forwards, lastError}
```
**冲突避免**：USB 只新增 import + apply 内一段 + `TRANSPORT_RANK` 一行，**不修改** P1 改的 `permissionPresetFor`/`setupInbound`/`configureSidecarPlatform` 区域；建议 P1 合入并跑绿后，USB 单独一个 commit（`feat(P1.5): usb transport`）。若要加配置键（`usb.enabled/adbPath/forwardBase`），必须同步 `cordis.patch.yml` 的 `config:` 并**保留全部现有键**（整份替换）。`client/client.js` 不动（USB 通道列显示原串 `usb`）。

---

## 8. 风险与回滚总表

| 风险 | 影响 | 缓解/回滚 |
|---|---|---|
| `cordis.patch.yml` 的 `config:` 整份替换 | 加键时漏原有键 → 静默重置配置 | 改 patch 前 `cp` 备份；逐键对照现有 config（AGENTS.md 硬约束 4） |
| 工作区中间态被打包上机 | 插件加载失败（如 import 了尚未导出的符号） | 只从 **clean commit** 打包；`git status` 必须只剩 analysis 改动 |
| `permissionPresetOnDshGo` 全权 | 外部输入可读写 guest 全部文件 | dsh-go 上建议 `requirePairing: true`；不需要时设 `""` 回滚 |
| 工具卡 `presentationMeta` 抛错 | 整次工具调用失败 | 函数体全 try/catch，返回 `{}`；先离线 checker |
| 原生 UI 连续违规 | bridge 关闭该插件原生 UI 直到重载 | 视图/数据严格按 limits；先小 View 上机 |
| USB forward 泄漏/拔插 | 端口占用、假在线 | `stop()` 清理；每轮 `listDevices` 重算；预留 error 通道可见 |
| ui.json 写坏 | App 保留上一份有效配置（整份语法错时） | 备份 + 官方 checker 先跑；回滚删键 |
| `DISCOVERY` 脏数据（machine=localhost/mac=0/cpu=0） | UI 难看、判断误导 | P1-2 修；显示层兜底（空/0 不显示） |

---

## 9. 待实测清单（按优先级）

1. **P1-0 真机**：dsh-go 配 `permissionPresetOnDshGo: "danger-full-access"` → 重启 → 日志「来源 dsh-go」→ 派任务不再「待确认」。
2. **P1-1/P1-2/P1-3 真机字段**：health 的 `diag.dshGo`、`diag.sidecarTarget`、`osInfo.platform=android`、`systems[]`、`cpuCores=8`。
3. **P1.5**：`adb forward` + 关 WiFi 后 `mesh_run` 仍通；`/mesh/v1/peers` 出现 usb endpoint。
4. **零改代码 A**：ui.json island 在 App 原生侧栏是否出东西；`ui.status.json` 内容；备选 slot `dsh-go.panel`。
5. **P2 工具卡**：手机原生聊天里 `mesh_peers` 是否渲染卡片（App 0.9.7）。
6. **双向 mesh_run + USB 专项 + 回执 thread 复用**（E2E 计划 C/D 阶段）。
7. 真机 P0 包上机：`diag.net.source/macsAvailable/errors`、`staticPeers` 兜底（关组播仍发现）、`advertiseAddress` 覆盖。

---

## 10. 证据索引

| 主题 | 文件 |
|---|---|
| dsh-go 内部机制/启动/bridge/direct/安装 | `analysis/DSHGO-INTERNALS.md` |
| bridge 原生 UI / 文件通道 / 权限根因 | `analysis/DSHGO-BRIDGE-INTEGRATION.md` |
| 零代码 UI 手册（ui.json/工具卡，含官方 checker 实测输出） | `analysis/UI-ZEROCODE-PATHS.md` |
| 缺口分析（Android/proot 逐项） | `analysis/GAP-ANALYSIS.md` |
| P0 实现报告（改动/自测输出） | `analysis/P0-IMPLEMENTATION.md` |
| E2E 验证计划 | `analysis/E2E-VERIFY-PLAN.md` |
| 离线 kit（校验工具卡/ui.json） | `E:\mesh\.tmp\dshgo-kit\`、`E:\mesh\.tmp\dshgo-ui-kit\`（由 `assemble-kit.sh` 从 APK 还原） |
| git | `E:\mesh`：`da528da` 基线 → `a140f05` E2E 计划 → `6855343` P0 |
