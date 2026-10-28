# USB / adb 传输适配设计（mesh × dsh-go）

> 状态：**模块与离线自测已完成**（`lib/usb.js`、`lib/_selftest-usb.mjs`，24 用例全绿）；接线未落地（`lib/index.js` 正被 P1 并发修改，本轮只给最小 hunk 方案）。真机 E2E 待实测。
> 版本：仍为 `0.5.4`。本轮改动文件：`lib/usb.js`（新增）、`lib/_selftest-usb.mjs`（新增）、`package.json`（仅追加 selftest 脚本行 + 两条链各插一项）、本文档。

---

## 1. 设计动机

mesh 现有两条传输：`lan`（UDP 组播 + 主动扫描）与 `tsnet`（用户态 Tailscale）。手机侧 dsh-go 是
**Flutter 壳 + proot Ubuntu + Node**（`process.platform === "linux"`，内核却是 Android app UID），
这条链路上局域网路径有三个天然的坏点：

| 坏点 | 真机表现 | USB 传输为什么能绕开 |
|---|---|---|
| 组播收包可能被系统丢（无 MulticastLock / 省电） | 手机不发也不收心跳，桌面只能靠扫描碰运气 | 不依赖组播，也不依赖同网段 |
| 网卡信息/地址不可信（app UID 下 netlink 受限） | `os.networkInterfaces()` 拿不到或拿到全 0 MAC，自述 host 不可用 | 端点固定 `127.0.0.1:<forward 端口>`，不做任何地址探测 |
| AP isolation / 访客网络 / 手机走蜂窝 | 桌面与手机不同网段，扫描扫不到 | adb 隧道是 USB 线本身，与 IP 网络无关 |

USB 直连的额外好处是**确定性**：`adb forward tcp:<local> tcp:<device>` 是 adb 自己维护的
TCP 转发，进程重启后按 serial 稳定 hash 复用同一个本地端口（见 §3.3），不存在"地址又漂了"。

与此同时必须诚实说明它的代价（真机事实，Lead 已实测）：

- 需要 USB 调试打开 + 用户点过"允许调试"（RSA 授权）。**未授权时本模块跳过并记原因，绝不假装"没有设备"**。
- adb 是**桌面侧**工具；手机（proot）里通常没有 adb，所以本模块在手机侧启动会得到
  `{available:false, reason:'ENOENT'}` —— 这是设计上允许并预期的（见 §7 风险）。
- 真机现状：serial `1441e87a`（Xiaomi 15 Ultra / Android 15），手机 dsh-go 监听 `0.0.0.0:45917`，
  `adb forward tcp:45917 tcp:45917` 后 `GET http://127.0.0.1:45917/mesh/v1/health` 返回 200 JSON
  （`app=dsh-mesh`、`id`、`machine`、`host`、`port`、`version`、`os`…）。adb 路径
  `E:\AndroidSDK\platform-tools\adb.exe`，PATH 里也有 `adb`。

### 1.1 双向往返的实际路径

```
桌面 DSH ──(adb forward tcp:46066 → 手机 tcp:45917)──▶ 手机 dsh-go mesh
   ▲                                                        │
   └──────── 回执：手机侧 agent 调 mesh_run ◀───────────────┘
             （需要手机能"发现"桌面；见下）
```

- **桌面 → 手机**：`adb forward`（本模块负责）。手机侧 mesh 监听 `0.0.0.0:45917`，
  所以 forward 到 `tcp:45917` 即可；桌面端点写死 `127.0.0.1:<local>`。
  派发时 `peerFetch()` 对非 `tsnet` 端点走 `fetchViaLan()`，普通 `fetch` 直接命中 adb 隧道，
  **派发代码零改动**。
- **手机 → 桌面（回执 / 反向派发）**：mesh 的回执机制是"对端 agent 再调一次 `mesh_run`"
  （见 `AGENTS.md` §4 数据流），所以**手机侧注册表里必须有桌面这台机器**。两条路：
  1. **同 LAN（推荐，零改动）**：桌面 mesh 服务监听 `0.0.0.0:<port>`（`startPeerServer()` 里
     `server.listen(port, "0.0.0.0")`），手机用 `staticPeers: ["<桌面 LAN IP>:45917"]` 或组播
     /扫描发现。这是正常情况，USB 只是补充桌面→手机这一侧。
  2. **完全没有共同网络（USB only）**：用 `adb reverse tcp:<手机本地端口> tcp:<桌面 mesh 端口>`
     （例如 `adb reverse tcp:45918 tcp:45917`），然后**手机侧** `staticPeers: ["127.0.0.1:45918"]`。
     ⚠ 有一个已知缺口：`scan.js › scanForPeers()` 返回的记录里只有对端**自述的 `port`**，
     而 `discovery.note(rec, rec.sourceAddress)` 用的正是这个 `port`；reverse 场景下
     自述端口（桌面 45917）≠ reverse 本地端口（45918），登记出来的端点会指错。
     最小修复（不在本轮写权限内，留给接线任务）：
     ```js
     // lib/scan.js › scanForPeers()：found.push({ ...body, sourceAddress: ip, probedPort: p });
     // lib/index.js › runScan()：discovery.note(rec, rec.sourceAddress, { port: rec.probedPort || rec.port });
     ```
     不修也能用：手机侧 `staticPeers` 指向桌面 LAN IP（路径 1）时自述端口就是实际端口。
     USB-only 的反向方向属于 P1.5 可选增强，**不阻塞"桌面→手机派发"验收**。

---

## 2. 模块契约（`lib/usb.js`）

### 2.1 构造与依赖注入

```js
createUsbTransport({
  adbPath: "adb",            // 空串/缺省 = PATH 里的 adb；Windows 可传绝对路径
  devicePort: 45917,         // 手机侧 mesh 端口
  forwardBase: 46000,        // 本地端口基址（区间 [base, base+span)）
  forwardSpan: 100,
  pollMs: 15000,             // 轮询间隔
  probeTimeoutMs: 1200,      // 单次 health 探测超时
  execFile,                  // (file, args, options) => Promise<{stdout,stderr}>，可注入
  fetchImpl,                 // (url, init) => Response 形状，可注入
  log,                       // (message) => void
  onEndpoints,               // (list, meta) => void
  onError,                   // ({serial, phase, code, message, at}) => void
})
```

**默认不启动**：构造时不碰 adb、不建隧道。调用方在插件 `apply` 里 `start()`，卸载时 `stop()`。

设计要点与理由：

| 决策 | 理由 |
|---|---|
| 自包含（不 import `discovery.js` / `index.js`） | 可在无宿主环境离线自测；`index.js` 正并发修改，先落地后接线 |
| 全部可注入 + **任何情况不抛** | 调用点在定时器、HTTP 健康检查、UI 状态；一次抛异常 = 整个 Mesh 不可用，而桌面复现不出来（桌面 adb 恰好正常） |
| `start/stop` 幂等 | `apply` 可能被重入/热重载；重复启动不能叠加定时器、不能泄漏 forward |
| 只用 `adb version` 做可用性探测 | `adb devices` 会在 server 未启动时**顺手拉起 adb server**；"看看装没装"不该有副作用 |
| 端口按 serial 稳定 hash | 进程重启后复用同一端口，不会留下一堆"占着端口的孤儿 forward" |
| 复用已有 `adb forward` | 用户/其他工具（真机现状：Lead 手工 `45917→45917`）建的映射优先，不重复建、`stop()` 也不删别人的 |
| 只在状态切换时打日志 | 每 15s 一行"设备未授权"会淹没真正的故障；`onError` 同样按 `serial|phase|code` 限流 60s |
| 错误分类而非一刀切 | `ENOENT`（没装 adb）/`UNAUTHORIZED`（用户没点允许）/`ETIMEDOUT`（这次没答上来）/`NOT_MESH`（端口被别的服务占）/`EADDRINUSE`（换端口就好）—— 见 AGENTS.md 硬约束 1 |

### 2.2 公开方法

| 方法 | 语义 | 失败形态（不抛） |
|---|---|---|
| `start()` | 幂等启动：探测 adb → 首轮轮询 → 起定时器 | 返回 `status()`，`available=false` + `reason` |
| `stop()` | 幂等停止：清定时器 + 移除**本模块创建的** forward + 发布空端点 | 返回 `status()` |
| `poll()` / `refresh()` | 立即跑一轮 | 返回 `status()` |
| `detect()` | 强制重探 adb | `{available, reason}` |
| `listDevices()` | `adb devices -l` → 可用设备数组（只含 `device` 状态） | `[]`；跳过原因在 `status().skipped` / `onError` |
| `listForwards()` | `adb forward --list` → `[{serial, localPort, remotePort}]` | `null`（"不知道" ≠ "没有映射"） |
| `ensureForward(serial, localPort)` | 幂等建 forward；已有映射直接 `reused:true` | `{ok:false, code, message}` |
| `removeForward(serial)` | 只删本模块创建的；复用的保留 | `{ok:false, code}` |
| `probe(serial, localPort?)` | `GET 127.0.0.1:<local>/mesh/v1/health` → `{ok, rttMs, record, endpoint}` | `{ok:false, error:{serial,phase,code,message,at}}` |
| `status()` | 诊断快照（UI/`/mesh/v1/health` 用） | 永不抛，兜底结构 |
| `getOptions()` | 只读选项快照（接线处取 `pollMs` 当 `probeIntervalMs`） | — |

`status()` 关键字段：`available`、`reason`（仅不可用时）、`adbVersion`、`started`、`pollCount`、
`devices`、`skipped`（含 `reason`）、`forwards`（含 `createdByUs`/`adopted`）、`endpoints`、
`errors`（环形 50 条，同类连续错误折叠成 `repeat`）、`errCount`。

### 2.3 端点形状（给注册表用）

```json
{
  "key": "usb:1441e87a",
  "channel": "usb:1441e87a",
  "transport": "usb",
  "host": "127.0.0.1",
  "port": 45917,
  "serial": "1441e87a",
  "model": "2510DPC0",
  "product": "nuwa",
  "deviceTransport": "usb:1-4",
  "usb": true,
  "id": "…手机 instanceId…",
  "machine": "…",
  "hostname": "…",
  "version": "0.5.4",
  "os": "android 15 (6.6.30-android15)",
  "app": "dsh-mesh",
  "remotePort": 45917,
  "rttMs": 3,
  "probedAt": 1761…,
  "record": { "…原始 /mesh/v1/health JSON 原样…" }
}
```

- `key === channel`：`discovery.js` 的端点身份是**通道 key**（`endpointKeyOf(ep) = ep.channel ?? ep.transport`），
  用 `usb:<serial>` 保证同一台手机的 USB 通道稳定、不与 `lan`/`tsnet:<id>` 互相覆盖。
- `record` 是原始 health 记录，接线时原样交给 `discovery.note()`，**不要**在传输层改协议字段。
- `host` 永远是 `127.0.0.1`（adb forward 的本地端），**不是**手机自述的 LAN IP —— 后者在桌面侧不一定可达。

### 2.4 错误码表（"探针失败 ≠ 否定事实"）

| code | 含义 | 不是 |
|---|---|---|
| `ENOENT` | `adb` 不在 PATH / 路径错 | 不是"没有 USB 设备" |
| `EACCES` / `EPERM` | adb 不可执行 | 不是"设备未授权" |
| `UNAUTHORIZED` | 手机未点"允许 USB 调试" | 不是"设备离线" |
| `OFFLINE` / `DEVICE_OFFLINE` | 设备状态 offline | 不是"设备不存在" |
| `NO_PERMISSIONS` | Linux udev 权限不足（`no permissions`） | 不是"没插线" |
| `DEVICE_GONE` | adb 找不到该 serial（拔线/重启 adb） | — |
| `EADDRINUSE` | 本地端口被占（adb: cannot bind） | 不是"手机侧 mesh 没起" |
| `ETIMEDOUT` | 这次探测没拿到回答 | 不是"设备不存在" |
| `ECONNREFUSED` | 隧道在、设备侧没人监听（mesh 没起/端口不对） | — |
| `HTTP_<code>` | 本地端口有服务但不是 200 | 不是"mesh 不健康" |
| `NOT_MESH` | 200 + JSON，但不是 dsh-mesh（端口被别的服务占用） | 不是"对端版本不对" |
| `PORT_ALLOC_FAILED` | 候选端口全部不可用 | — |
| `POLL_FAILED` / `INTERNAL` | 本模块内部异常（已兜底，仅记录） | — |

---

## 3. 关键实现决策

### 3.1 设备枚举

`adb devices -l` 输出形如：

```
List of devices attached
1441e87a               device usb:1-4 product:nuwa model:2510DPC0 device:nuwa transport_id:3
```

`parseAdbDevices()` 忽略 daemon 启动噪声（`* daemon not running…`）与表头，按
`serial state k:v…` 解析；只有 `state === "device"` 进可用列表，其余（`unauthorized`、
`offline`、`no permissions`…）进 `skipped` 并带 `reason`，同时经 `onError` 上报一次（限流）。
无线调试条目（serial 形如 `ip:port`、无 `usb:` 字段）也接受 —— `adb forward` 一样可用，
只是 UI 上 `usb:false`。

### 3.2 forward 建立顺序

1. **内存缓存**：本进程上一轮建的，若 `adb forward --list` 里还在 → 直接用。
2. **复用已有映射**：`--list` 里有 `serial + remote==devicePort` 的任意本地端口 → 直接采纳
   （真机现状：Lead 手工建的 `tcp:45917 tcp:45917` 会被复用，不再新建；`stop()` 不会删它）。
3. **稳定 hash**：`usbPortFor(serial, base, span)`（FNV-1a 32 → `base + h % span`），
   跳过已被其它映射/本进程占用的端口。
4. **bind 冲突顺延**：`adb forward` 报 `cannot bind listener` → 记 `EADDRINUSE` 错误，
   区间内顺延，最多 `MAX_BIND_ATTEMPTS = 8` 次。

### 3.3 为什么端口要"稳定 + 顺延"

- 稳定：进程重启后 forward 已存在（adb server 还活着），复用即可；不会每次重启漂一个新端口，
  导致 `adb forward --list` 里堆一排孤儿映射。
- 顺延：`46000-46099` 里可能已有别的东西（用户自己的服务、另一台手机的映射、上一次运行遗留）。

### 3.4 探测与超时

`fetchWithTimeout()` 用 `AbortController` + `Promise.race` 双保险：即使注入的 `fetchImpl`
完全忽略 `AbortSignal`（或永不 settle），也会在 `probeTimeoutMs` 后返回 `ETIMEDOUT`，
不会把"超时"退化成"挂死"。**该定时器刻意不 `unref()`** —— 超时是必须给出的结果；
`unref()` 后如果事件循环恰好只剩它，Promise 就永远不 settle（离线自测踩过）。

判定顺序：`res.ok !== true` → `HTTP_<status>`；`json()` 抛错 → `BAD_JSON`；
`looksLikeMeshHealth(body) === false` → `NOT_MESH`；通过才生成端点。
`looksLikeMeshHealth()` 与 `discovery.looksLikeDshPeer()` 判据一致（`app==='dsh-mesh'`、
有 `id`、`v` 缺省或 2、`proto` 缺省或 `dsh-mesh`、id 不是 UUID 形态），本地复制而非 import，
保证模块自包含；注册表侧仍会再判一次。

---

## 4. 与现有 discovery / scan / registry 的接线点

> 锚点一律用**函数名/注释**（`lib/index.js` 正在被 P1 并发修改，行号会漂移）。

### 4.1 配置 schema

锚点：`lib/index.js` 顶部 `export const Config = z.object({` 里、`staticPeers` 那一项之后。

```js
  usbTransfer: z.boolean().default(false),
  usbAdbPath: z.string().default(""),
  usbDevicePort: z.natural().max(65535).default(45917),
  usbForwardBase: z.natural().max(65535).default(46000),
```

- 默认 `false`（opt-in）：默认行为零变化，符合"桌面端行为不回归"的要求。
- **不要**把新键写进 `cordis.patch.yml` 的 `config:` —— patch 里的 `config` 是整份替换，
  加一个键会静默清掉其它键（AGENTS.md 硬约束 3/4）。schema 默认值对缺失键生效，够用。

### 4.2 `applyUnsafe(ctx, config)` 里创建传输 + 接线

```js
// 锚点 1：文件顶部 import 区
import { createUsbTransport } from "./usb.js";

// 锚点 2：applyUnsafe() 内 `const discovery = new MeshDiscovery({...})` 之后
//         （`activeDiscovery = discovery;` 附近，此时 discovery 可用了）
const usbTransport = createUsbTransport({
  adbPath: config.usbAdbPath || "adb",
  devicePort: config.usbDevicePort,
  forwardBase: config.usbForwardBase,
  pollMs: Math.max(1000, config.pingIntervalMs),        // 与 LAN 保活同节奏
  probeTimeoutMs: Math.min(1200, config.requestTimeoutMs),
  log: (m) => log(m),
  onError: ({ serial, phase, code, message }) => {
    // 传输层已按 code 区分 ENOENT/UNAUTHORIZED/ETIMEDOUT/NOT_MESH 并限流；
    // 这里原样落日志，不要翻译成"没有设备/手机不存在"
    warn(`USB ${serial || "adb"} ${phase}/${code}：${message}`);
  },
  onEndpoints: (endpoints) => {
    // 锚点 3：注册表入口 discovery.note(record, sourceAddress, meta)
    for (const ep of endpoints) {
      discovery.note(ep.record, ep.host, {
        transport: ep.transport,     // "usb"
        channel: ep.key,             // "usb:<serial>"（端点身份）
        port: ep.port,               // 127.0.0.1:<forward 本地端口>
        rttMs: ep.rttMs,
        probeIntervalMs: Math.max(1000, config.pingIntervalMs), // endpointAlive 的存活窗口
      });
    }
    // 端点消失不需要额外 API：pingKnownPeers() 会对 usb 端点做同样的保活探测，
    // 连续失败 2 次进冷却 → 设备显示离线；超过 keepMs 无证据的端点由 #sweep() 摘掉。
    // （stop() 会发布空列表，下一次 ping 就会把通道标失败，不会假装还在线。）
  },
});

// 锚点 4：startPeerServer(...).then(async (port) => { ... }) 里、
//         注释「// 主动发现 + 保活」之前
if (config.usbTransfer) {
  ctx.effect(() => () => { void usbTransport.stop(); }); // 卸载即清 forward + 定时器
  usbTransport.start().then((st) => {
    if (!st.available) {
      // ENOENT 是"没装 adb"，不是"没有手机"（AGENTS.md 硬约束 1）
      warn(`USB 传输不可用（${st.reason}）：${st.adbPath} —— 不影响局域网/tsnet 发现`);
    } else {
      log(`USB 传输已启动：adb ${st.adbVersion}，设备端口 ${st.devicePort}，轮询 ${st.pollMs}ms`);
    }
  }).catch(() => {});
} else {
  log("USB 传输未启用（usbTransfer=false）");
}
```

**为什么不用改派发代码**：

- `mesh_run` → `findPeersByName()` → `target.online`（`peerOnline` 任一端点活着）→
  `peerFetch(target, "/mesh/v1/task")` → `orderedEndpoints()` → 对每个端点拼
  `http://${ep.host}:${ep.port}${path}`。USB 端点 `127.0.0.1:<local>` 走 `fetchViaLan()`（非 tsnet），
  **普通 fetch 直接命中 adb 隧道**。
- 端点失败切换、冷却、`markEndpoint` 全部复用现有逻辑，无需新增代码。
- `mesh_run` 返回"当前离线"只看 `peer.online`；USB 端点每次 `onEndpoints` 刷新 `lastSeen`，
  并把 `probeIntervalMs` 传进 `note()`，`endpointAlive` 的窗口 = `max(ttl, pollMs*2.5)`，
  不会出现"探着通却显示离线"。

### 4.3 诊断（可选但强烈建议，真机验收靠它）

锚点：`startPeerServer()` 里 `const netDiag = () => {` 的返回对象加一项
`usb: usbStatus()`（把 `usbTransport.status()` 通过 `startPeerServer(...)` 的参数传进去）。
效果：`curl http://127.0.0.1:<port>/mesh/v1/health | jq .diag.usb` 能直接看到
`available/reason/devices/skipped/forwards/endpoints/errors`，不用翻日志。
同理可加进 `applyUnsafe()` 里的 `diagnosticsPayload()`（锚点同名函数）。

### 4.4 通道排序（可选）

锚点：`lib/discovery.js` 顶部 `export const TRANSPORT_RANK = { lan: 0, tsnet: 1 };`。
当前未知 transport 落到 `?? 9`，即 **usb 排在最后**。这不影响可达性（`peerFetch` 会逐个失败切换），
只影响"同时有 LAN 和 USB 时先试谁"。若想让 USB 优先于 tsnet：
`{ lan: 0, usb: 1, tsnet: 2 }`。属于**行为变更**，建议接线任务一起做并加自测。

### 4.5 UI（client/client.js，手写 bundle）

- 锚点：`const label = ep.transport === "tsnet" ? (channelTag ? `互联网 · ${channelTag}` : "互联网") : "局域网";`
  → 三分支（`usb` 显示 `USB`），图标同理（`ep.transport === "tsnet" ? "tailscale" : "wifi"`）。
- 锚点：`const SETTINGS_FIELDS = [` → 加
  `{ cat: "network", key: "usbTransfer", label: "USB/adb 直连（桌面）", type: "switch", restart: true }`。
  最小 hunk 用 `restart: true`（传输在 `apply` 里启动）；后续可做成即时 start/stop。
- 锚点：`raw.transport === "tsnet" ? "互联网" : raw.transport === "lan" ? "局域网" : raw.transport || "—"`
  —— 这里已能把 `usb` 原样显示出来，可选改成中文 `USB`。
- 设备详情里 `peer.knownAddresses` 会带 `usb:127.0.0.1:<port>`（`discovery.#project` 现有逻辑），
  天然可见，不需要额外改动。

---

## 5. 安全副作用

| 副作用 | 说明与处理 |
|---|---|
| **adb 权限** | 需要 USB 调试 + 用户授权（RSA 指纹）。未授权时只跳过 + 记 `UNAUTHORIZED`，**不尝试自动点允许**（那需要 root/UI 自动化，超出插件边界） |
| **forward 生命周期** | 本模块只删 `createdByUs === true` 的映射；复用到的（用户手建、其他工具建）保留。`stop()` 清理自己建的。桌面进程被 kill 时可能残留（adb server 还活着）→ 稳定 hash 让下次启动复用同一端口；用户可 `adb forward --remove-all` 一键清 |
| **多个 adb server 混用** | adb 客户端连 `tcp:5037` 上的 server；`ANDROID_ADB_SERVER_PORT` / 不同 platform-tools 版本可能看到不同的 forward 表。表现：`--list` 里看不到已有映射 → 尝试新建 → 可能 `EADDRINUSE` → 自动顺延并记录。建议固定 `usbAdbPath`，`status().adbVersion` 可见 |
| **本机端口暴露面** | `adb forward tcp:` 由 adb 绑定（现代 adb 默认 `127.0.0.1`/`::1` 只监听回环）。本模块的 URL 固定 `127.0.0.1`。若担心，可用 `adb -a` 之外的方式确认 `netstat -ano \| findstr 46066` 的监听地址（见 §6 验收） |
| **认证不受影响** | USB 只换传输，不改协议：`/mesh/v1/health` 免鉴权（只暴露身份），`/mesh/v1/task` 仍受 `requirePairing`/`X-Dsh-Mesh-Token` 保护 |
| **设备拔插** | adb 在设备断连时自动清掉该设备的 forward；本模块下一轮 poll 发现 `--list` 里没了 → 重建（首次即报错则记 `DEVICE_GONE`）。端点因探测失败被移除，**不是**"设备不存在" |
| **手机侧启动** | dsh-go（proot）里通常没有 adb → `detect()` 得 `ENOENT` → 不轮询设备、只报一次错、不刷屏。手机侧建议保持 `usbTransfer:false` |

---

## 6. 真机验收清单

前置：手机 USB 连接、`adb devices -l` 里状态为 `device`。命令里的 adb 用
`E:\AndroidSDK\platform-tools\adb.exe`（PATH 里的 `adb` 等价）。

### 6.1 设备与隧道

```powershell
adb devices -l
# 期望（真机实测形态）：
# List of devices attached
# 1441e87a               device usb:1-4 product:nuwa model:2510DPC0 device:nuwa transport_id:3

adb forward --list
# 期望：至少能看到模块/手工建立的映射（真机现状 Lead 手工建的）
# 1441e87a tcp:45917 tcp:45917
```

### 6.2 health 直连

```powershell
curl.exe -s http://127.0.0.1:45917/mesh/v1/health
# 期望 200 JSON（字段来自真机）：
# {"ok":true,"app":"dsh-mesh","v":2,"proto":"dsh-mesh","id":"<16位hex>","machine":"<机器名>",
#  "host":"<手机自述 LAN IP>","port":45917,"hostname":"...","version":"0.5.4",
#  "os":"android 15 ...","user":"root","requirePairing":false,"diag":{...}}
```

### 6.3 模块冒烟（不改 index.js，直接跑传输层）

```powershell
cd E:\mesh\dsh-plugin-mesh
node -e "import('./lib/usb.js').then(async ({createUsbTransport})=>{const t=createUsbTransport({adbPath:'E:/AndroidSDK/platform-tools/adb.exe',pollMs:1000});const st=await t.start();console.log(JSON.stringify({available:st.available,reason:st.reason,adbVersion:st.adbVersion,devices:st.devices,endpoints:st.endpoints,forwards:st.forwards,errors:st.errors.map(e=>e.code)},null,2));await t.stop();})"
```

期望（**重点看断言点**）：

- `available: true`，`adbVersion: "1.0.41"`；
- `devices[0].serial === "1441e87a"`、`state: "device"`、`model: "2510DPC0"`；
- `endpoints[0]`：`key: "usb:1441e87a"`、`transport: "usb"`、`host: "127.0.0.1"`、
  `port` 为稳定 hash 端口（或 `45917`，见下）、`machine/id` 来自 health；
- `forwards[0]`：若 Lead 的手工 `tcp:45917` 还在 → `localPort: 45917, createdByUs: false, adopted: true`
  （复用生效，不重复建）；若已清理 → `port = usbPortFor("1441e87a")`（默认 `46000 + hash%100`），
  `createdByUs: true`；
- `errors`：正常时为空；手机未授权时含 `UNAUTHORIZED`。

`stop()` 之后再跑：

```powershell
adb forward --list
# 期望：本模块创建的映射已消失；Lead 手工建的 45917 映射若被复用则**仍在**（不删别人的）
```

### 6.4 接线后（桌面 mesh 视角）

1. 日志出现 `USB 传输已启动：adb 1.0.41，设备端口 45917，轮询 10000ms`；
   若 adb 缺失则只有一行 `USB 传输不可用（ENOENT）…`。
2. `mesh_peers`（或 Mesh 页面）里手机那台设备：
   - `transport` 字段为 `usb`（页面标签在 §4.5 修完前会显示"局域网"，属已知 UI 缺口）；
   - `knownAddresses` 含 `usb:127.0.0.1:<port>`；
   - `host:port` 投影为 `127.0.0.1:<port>`。
3. 派发：

   ```
   mesh_run(peer="<手机机器名>", task="USB 通道连通性验证：只回一句 pong，不要做别的", thread="usb-e2e-1")
   ```

   期望：返回"已派发"；手机侧 inbound 收件箱出现该任务；手机 agent 回执后桌面收到
   （回执方向依赖 §1.1 的路径 1 或 2）。
4. 断线/重插：拔 USB → 15s 内该设备显示离线（`errors` 里有 `ETIMEDOUT`/`ECONNREFUSED` 或端点被 ping 标失败），
   插回 → 下一轮恢复在线；期间**不出现**"设备不存在"之类结论。

### 6.5 清理

```powershell
adb -s 1441e87a forward --remove tcp:<port>   # 只清模块建的
adb forward --list
```

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| adb 子进程调用 | `execFile` 异步、5–8s 超时，不阻塞事件循环 | 已设 timeout / maxBuffer；失败归类记录 |
| 端口区间与用户服务冲突 | `EADDRINUSE` → 顺延；区间占满才失败 | `usbForwardBase` 可配；错误可见 |
| 多个 adb server / 版本不一致 | forward 表不一致 | 固定 `usbAdbPath`；`status().adbVersion` 可查 |
| Windows 驱动/USB 授权弹窗 | 设备不出现或 `unauthorized` | 跳过 + 记原因，不重试刷屏 |
| 手机（proot）侧启动 | `ENOENT` | 设计内；只报一次；建议手机侧不开 |
| `TRANSPORT_RANK` 未改 | usb 端点排序最后（只影响优先顺序） | §4.4 可选 hunk，接线时一起做 |
| reverse 方向端口登记缺口 | 纯 USB、无共同网络时手机→桌面不可达 | §1.1 已给最小修复；不是本轮验收阻塞项 |
| 桌面进程被强杀 | 残留 forward | 稳定 hash 复用；`adb forward --remove-all` 清理 |

**回滚**（默认关闭，所以回滚是纯删除）：

1. 配置/代码：删掉 `applyUnsafe()` 里的 `usbTransport` hunk、`Config` 里 4 个键、client 的标签/设置项；
2. 文件：删 `lib/usb.js`、`lib/_selftest-usb.mjs`；
3. `package.json`：删 `selftest:usb` 脚本行，以及 `check`/`test` 链里各一项；
4. 设备侧：`adb forward --remove-all`（或只删对应 `tcp:<port>`）。
   协议字段没有改动，**回滚不需要动对端**。

---

## 8. 已实现 / 待实测

**已实现并通过离线自测（24 用例，`node lib/_selftest-usb.mjs` 全绿）**：

- `adb devices -l` 解析（真机形态/daemon 噪声/unauthorized/offline/no-permissions/无线调试）；
- `adb forward --list` 解析、稳定 hash 端口、端口冲突顺延、bind 冲突顺延；
- forward 幂等、复用用户手建映射、`stop()` 只清自己的；
- health 200 → 完整端点；非 mesh/404/超时分类；设备中途拔掉；
- adb ENOENT 只报一次不刷屏；重复 start 幂等；定时器/forward 清理；
- stop 打断进行中的轮询（代数守卫：停止后不发布端点、不遗留 forward）；
- 永不 throw（垃圾 opts、注入实现同步抛、adb 输出乱码）。

**待真机实测**（验收按 §6）：

1. 模块冒烟：`start()` 后 `endpoints[0].port` 是否走"复用 45917"或稳定 hash 端口；
2. `stop()` 后 `adb forward --list` 的残留情况（复用映射应保留）；
3. 接线后 `mesh_run` 经 USB 端点派发 + 手机回执；
4. 拔插/`adb kill-server` 后的自动恢复；
5. Windows 上 `adbPath` 绝对路径与 PATH 两种形态；
6. UI 标签修复后的 `USB` 显示。
