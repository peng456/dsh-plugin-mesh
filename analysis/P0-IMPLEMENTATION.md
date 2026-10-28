# P0 实现报告：mesh 在 dsh-go（Android proot）上"不崩、可被发现、可手动加 peer"

| 项 | 值 |
|---|---|
| 任务 | task-4（实现 GAP-ANALYSIS 的 P0 清单） |
| 基线 | `E:\mesh\dsh-plugin-mesh` v0.5.4（**版本号未改**） |
| 改动范围 | `lib/**`、`package.json`、`cordis.patch.yml`（+ 生成的 `docs/llms.txt`） |
| 未动 | `lib/tsnet/**`、`client/client.js`、`E:\DSH-Home` 下已安装副本、协议字段语义 |
| 结论 | **P0 全部落地，自测全绿**：新增 netinfo 28 用例全过；check 通过；selftest 67 通过；selftest:lan 双进程通过；桌面行为与 pristine 0.5.4 逐字节一致（地址/MAC/名片），无回归 |
| 真机修正 | 已吸收 Lead 的真机结论：**不假设 netlink 必抛**；`source`/`mounts` 的探测过程可观察；MAC 不可用显式表达；`cpuCores:0` 留给 P1（本次未动 capabilities） |

---

## 0. 一页摘要

| P0 项 | 改动 | 关键文件 | 验收 |
|---|---|---|---|
| 1. 安全地址采集 | 新增 `lib/netinfo.js`：config > os > UDP 源地址 > /proc，四级兜底，**任何情况不抛**，结果带 `source/macsAvailable/errors` | `lib/netinfo.js` | `npm run selftest:netinfo` → 28/0 |
| 2. discovery 接入 | `lanIPv4Addresses/macForAddress/preferredAddress` 全部改走 netinfo；构造/心跳/HTTP 零抛；新增 `MeshDiscovery.netInfo()`；无地址时异步 UDP 预热并重播公告 | `lib/discovery.js:19,92,116,241,256,277,400,457` | netinfo 用例 7（模拟 EPERM 下 MeshDiscovery 仍可构造） |
| 3. 扫描兜底 | 网卡枚举包 try/catch；`candidateAddresses(extraRanges, limit, extraHosts)`，**staticPeers 先于网段展开**（不会被 limit 截掉） | `lib/scan.js:22,47,55` | netinfo 用例 7（抛 EPERM 时 scanRanges+staticPeers 仍生效）+ 显式候选探到 health |
| 4. 三个配置 | `staticPeers` / `advertiseAddress` / `sidecarPlatform`：schema + patch（保留全部原键）+ 全链路接线 | `lib/index.js:255,263,270,814,892,1989,2002,2149,2648,2685`、`cordis.patch.yml:51-58`、`lib/diagnostics.js:68-70` | 真 schemastery 校验 35 keys/默认值/类型拒绝；真 yaml 解析原键齐全；`/mesh/v1/health` diag 端到端断言 |
| 5. 自测 | 新增 `lib/_selftest-netinfo.mjs`（28 用例，六类形态）；挂进 `scripts`/`test`/`check`；`selftest:lan` 改为 `--pair` 自动双进程；reply-route 增加 health diag 断言 | `lib/_selftest-netinfo.mjs`、`lib/_selftest-discovery.mjs:53,68`、`lib/_selftest-reply-route.mjs:110`、`package.json:57,71,72` | 见 §6 |

---

## 1. 改动文件清单

| 文件 | 类型 | 行数 | 说明 |
|---|---|---|---|
| `lib/netinfo.js` | **新增** | 564 | 地址采集安全网：四级来源、错误分类、UDP 探测、/proc 解析、staticPeers 规格解析、可测试注入口 |
| `lib/_selftest-netinfo.mjs` | **新增** | 487 | 28 个离线用例（正常/EPERM/空对象/UDP/advertiseAddress/永不抛/调用点回归） |
| `lib/discovery.js` | 修改 | 1076 | 地址三函数改走 netinfo；`#advertiseAddress`；`netInfo()`；`#warmAddress()` UDP 预热 |
| `lib/scan.js` | 修改 | 138 | 网卡枚举 try/catch；`candidateAddresses` 第三参 `extraHosts`（staticPeers 优先入列） |
| `lib/index.js` | 修改 | 3655 | schema 三键；`configureNetInfo`；ctor 传 advertiseAddress；scan 候选/端口并入 staticPeers；`/mesh/v1/health` diag；diagnostics/state 增量字段；启动日志可见地址来源 |
| `lib/diagnostics.js` | 修改 | 113 | 安全字段白名单补三键 |
| `lib/_selftest-discovery.mjs` | 修改 | 104 | 新增 `--pair` 自动配对模式（单进程退出码 3 是"没人和我配对"，不是回归） |
| `lib/_selftest-reply-route.mjs` | 修改 | 181 | 增加 `/mesh/v1/health` diag 端到端断言 |
| `package.json` | 修改 | 143 | `selftest:netinfo` 脚本；`check` 加 `node --check lib/netinfo.js`；`test` 链加 netinfo；`selftest:lan` 改 `--pair` |
| `cordis.patch.yml` | 修改 | 96 | 三新键（`config` 整体替换，原有 22 个键全部保留） |
| `docs/llms.txt` | **生成** | 151 | `node scripts/sync-llms.mjs --write` 产出（baseline tarball 不含 docs/，`check:docs` 需要它；内容就是 `llms.txt` 的副本） |

---

## 2. P0-1：`lib/netinfo.js`（任何情况不抛）

### 2.1 采集顺序（与"真机可能不抛"的现实兼容）

```
advertiseAddress（配置，最高优先级，只接受 IPv4，可带 :port 但端口忽略）
  → os.networkInterfaces()（try/catch；按接口名打分挑主地址）
  → UDP 源地址（dgram.connect 仅做路由选择、不发包；同步路径用 warmNetInfo 预热的缓存）
  → /proc/net/fib_trie + /proc/net/route（最后兜底，EACCES 也只是一条 error）
  → none（返回空 + errors，调用方退回 127.0.0.1，与 0.5.4 一致）
```

**这条顺序是"可观察"的**：`collectNetInfo()` 返回
`{ lanIPv4, lanIPv6?, addresses, source: "config"|"os"|"udp"|"proc"|"none", macsAvailable, errors: [{source, code, message}] }`。
真机上 `os.networkInterfaces()` 若可用，`source` 就是 `"os"`，UDP/proc 分支不会触发（但代码在，故障时自动接管）。

### 2.2 关键实现点

| 点 | 位置 | 说明 |
|---|---|---|
| 错误分类 | `lib/netinfo.js:61 classifyError` | 保留 `code`（EPERM/EACCES/ENOENT/ETIMEDOUT…），无 code 时按 message 归类；`message` 截断 200 字 —— 与项目现有 `probeErrors` 风格一致 |
| MAC 可用性 | `lib/netinfo.js:117 usableMac` | 全 0（`00:00:00:00:00:00`）/空/非法都算不可用；有地址但 MAC 不可用时**显式**追加 `{source:"os", code:"MAC_UNAVAILABLE"}`，`macsAvailable=false` |
| IPv4 校验 | `lib/netinfo.js:isIPv4/isUsableIPv4` | 排除回环、0.0.0.0、169.254/16 |
| staticPeers 规格 | `lib/netinfo.js:143 parsePeerSpec / :152 peerHostsFromSpecs / :165 peerPortsFromSpecs` | `host:port` / `host`；允许主机名；非法值（含 `http://`、坏端口）直接丢弃 |
| UDP 探测 | `lib/netinfo.js:303 udpSourceAddress` | 目标顺序 223.5.5.5、8.8.8.8、`/proc/net/route` 的默认网关、1.1.1.1；单目标超时 800ms；只接受可用 IPv4；`deps.udpConnect` 可注入 |
| /proc 解析 | `lib/netinfo.js:236 parseProcNetRoute`（网关小端解码）、`:270 parseProcFibTrie`（`|-- addr` + `/32 host LOCAL`） | 纯函数，坏输入返回空 |
| 同步/异步分层 | `:380 collectNetInfo`（同步、绝不抛）、`:503 collectNetInfoAsync`（os/proc 无地址才做 UDP）、`:530 preferredAddressFrom` | `selfRecord()` 是同步路径，所以 UDP 结果通过模块缓存（`warmNetInfo` 预热）进入后续同步采集 |
| 配置注入 | `:540 configureNetInfo`、`:550 currentNetInfo`、`__resetNetInfoForTest/__getNetInfoStateForTest` | index.js 的 apply 与 MeshDiscovery 构造都会写；自测用于隔离 |

### 2.3 为什么这样设计（对齐真实故障形态）

- **不能把"探测失败"变成"没有地址"**：`errors[]` 永远带着失败原因；`source:"none"` 是明确结论，不是空数据。
- **不写死 EPERM**：真机上 os 路径可用（Lead 实测），所以 UDP/proc 只是**兜底**，不是主路径；代码里没有任何"Android 必然抛错"的假设。
- **可注入**：六种形态全部离线覆盖（见 §6），不需要真机也能防回归。

---

## 3. P0-2：`lib/discovery.js` 接入（零抛 + 可观察）

| 改动 | 位置 | 行为 |
|---|---|---|
| 导入 netinfo | `lib/discovery.js:19` | `collectNetInfo/preferredAddressFrom/configureNetInfo/warmNetInfo` |
| `lanIPv4Addresses()` | `:92` | 走 `collectNetInfo()`；**内部 try/catch**，拿不到返回 `[]`（旧签名/旧返回形状不变：`{iface,address,mac}`） |
| `macForAddress()` | `:104` | 复用 `lanIPv4Addresses()`；MAC 不可用返回 `""`（注释写明 Android 场景） |
| `preferredAddress()` | `:116` | `preferredAddressFrom(collectNetInfo())`；全失败退回 `127.0.0.1`（与 0.5.4 相同语义） |
| 构造参数 | `:241` `#advertiseAddress`、`:256` configureNetInfo | 透传配置；`MeshDiscovery` 单测可用 `advertiseAddress` 覆盖 |
| `netInfo()` | `:277` | 诊断快照（source/macsAvailable/errors）；缺方法时 `index.js` 侧有兜底 |
| UDP 预热 | `:400` 调用、`:457 #warmAddress` | 只有"当前拿不到地址"时才异步探测；拿到后重播公告。**不阻塞 start()、不抛** |

回归证据：`E:\mesh\.tmp\regression-compare.mjs` 对比"改动后 vs 已安装 pristine 0.5.4"：
地址列表、preferred、MAC、`selfRecord()`（host/mac/os/osInfo）**完全一致**（详见 §7）。

---

## 4. P0-3：`lib/scan.js` 兜底

| 改动 | 位置 |
|---|---|
| 网卡枚举包 try/catch（失败继续用显式网段/主机） | `lib/scan.js:47` |
| `candidateAddresses(extraRanges, limit, extraHosts)` 新增第三参；**staticPeers 入列排在网段展开之前** | `lib/scan.js:22,55` |
| 注释写明 GAP G4 的真机表现（"扫描完成：未命中"且无报错） | `lib/scan.js:38-46` |

配套（`lib/index.js`）：
- `scanPortList()` 把 `staticPeers` 里写明的端口并入扫描端口：`:1989`；
- `runScan()` 把 `staticPeers` 的主机并入候选：`:2002`；
- `runScan` 的"没有可扫描地址"警告文案更新为同时提示 `scanRanges / staticPeers`。

验收：netinfo selftest 用例 7 —— 模拟 `os.networkInterfaces()` 抛 EPERM 后
`candidateAddresses(["192.168.1.0/30"], 1024, ["192.168.1.6"])` 仍返回 `192.168.1.6` + `192.168.1.2`；
另有"显式候选地址直探 `/mesh/v1/health` 并带出记录"的端到端用例（127.0.0.1 本地服务，不碰外网）。

---

## 5. P0-4：配置与全链路接线

### 5.1 schema（`lib/index.js`）

```js
staticPeers: z.array(String).default([]),      // :255
advertiseAddress: z.string().default(""),      // :263
sidecarPlatform: z.string().default("auto"),   // :270
```
默认值 = 现状行为（空/空/auto 时与 0.5.4 完全等价）。

### 5.2 `cordis.patch.yml`（`config:` 是整体替换，原键全部保留）

新增（`:51-58`）：`staticPeers: []`、`advertiseAddress: ''`、`sidecarPlatform: auto`，带用途/格式注释。
原来是 22 个键，现在 25 个；**没有任何旧键丢失**。

### 5.3 各键的消费点

| 键 | 消费点 |
|---|---|
| `staticPeers` | `lib/index.js:1989`（端口并入 scanPortList）、`:2002`（主机并入 candidateAddresses）、`:1005` 起启动日志列出、`:2685` state 暴露、`lib/diagnostics.js:68` 诊断白名单 |
| `advertiseAddress` | `lib/index.js:814` `configureNetInfo()`（必须早于任何 selfRecord）、`:892` 传给 MeshDiscovery、`:2686` state、`lib/diagnostics.js:69`；实际生效在 `lib/netinfo.js:380`（config 分支优先级最高） |
| `sidecarPlatform` | `lib/index.js:763 sidecarPlatformValue()`（auto/linux/android 归一，非法按 auto）、`:980` diagnostics、`:2149-2160` `/mesh/v1/health` diag、`:2687` state；**P0 只存值与展示**，不改 sidecar 行为（P1 再做） |

### 5.4 可观察性（不新增协议语义，只做增量字段）

- `/mesh/v1/health` 新增 `diag: { net: { source, macsAvailable, errors:[{source,code}] }, sidecarPlatform }`
  （`lib/index.js:2149-2160`）—— 免鉴权接口只给"来源/是否可用/错误码"，不给地址列表和错误详情文本。
  与 Lead 真机观测对齐：手机应出现 `diag.net.source:"os"`、`diag.net.macsAvailable:false`、`errors` 里含 `{source:"os",code:"MAC_UNAVAILABLE"}`。
- `/mesh/api/state` 的 `self.net` 与 `config.{staticPeers,advertiseAddress,sidecarPlatform}`（`:2648,2685-2687`）—— 纯增量，旧客户端忽略未知键。
- `diagnosticsPayload` 增加 `net` 与 `sidecarPlatform`（`:979-980`）。
- 启动日志：`地址=…（来源 os，MAC 不可用）`，探测错误单独 warn（`:999` 起）。

**协议不变**：`selfRecord()` 字段、组播报文、`/mesh/v1/task`、会话键/回信地址全部未改；
`/mesh/v1/health` 只是多一个 `diag` 键（`scanForPeers` 只校验 `app/id/port`，不受影响）。

---

## 6. P0-5：自测

### 6.1 新增 `lib/_selftest-netinfo.mjs`（28 用例，离线）

| 分组 | 覆盖 |
|---|---|
| 1. 正常 | os 可用时的 source/lanIPv4/macsAvailable/errors、IPv6 提取、preferredAddressFrom、family 4/6 归一化 |
| 2. EPERM | os 抛 EPERM 时不抛且保留 EPERM；MAC 全 0 → `macsAvailable:false` + `MAC_UNAVAILABLE`；usableMac 形态 |
| 3. 空对象 | `{}` → 报 `EMPTY` + /proc 兜底出 192.168.1.19；/proc 也不可用 → none 不抛；两个 /proc 解析器 fixture |
| 4. UDP | os/proc 全失败 → `collectNetInfoAsync` 用 UDP 兜底（source=udp）并写缓存（后续同步调用也生效）；无网/回环/未指定 → null；成功返回 `{address,target}`；全失败只在 errors 留一条 udp |
| 5. advertiseAddress | 合法覆盖（source=config，且保留 os 地址列表）；带端口只取 host；非法 `10.0.0.999` 记 `config/INVALID` 后继续 os；空=自动；configure/currentNetInfo 写入生效 |
| 6. 永不抛 | deps 全炸（含 throw 字符串/null）；垃圾 advertiseAddress（对象/数组）；isIPv4/isUsableIPv4 形状；staticPeers 规格解析 |
| 7. 调用点回归 | os 抛错时 `preferredAddress()`=127.0.0.1、`new MeshDiscovery()` 可构造、`candidateAddresses` 仍用 scanRanges+staticPeers、`advertiseAddress` 选项生效、显式候选直探 health |

### 6.2 挂进 scripts（`package.json`）

- `:57` 新增 `"selftest:netinfo": "node lib/_selftest-netinfo.mjs"`；
- `:71` `test` 链：`check && npm run selftest:netinfo && npm run selftest && …`；
- `:72` `check` 链加 `node --check lib/netinfo.js`（静态语法门禁）。

### 6.3 `selftest:lan` 改为自动配对模式

原 `npm run selftest:lan` = 单进程脚本，设计上**永远发现 0 个对端 → exit 3**（它是"开两个终端"的手动测试）。
为了让它成为可机械验收的命令：

- `lib/_selftest-discovery.mjs:53 runPair()`：父进程先起 mac-a:45900，1.5s 后起 mac-b:45901，两边都发现对端才算通过（`process.exit(0)`），否则 exit 1 并提示"可能是网络拦了组播"；
- `:68` 检测 `--pair`；单实例/手动双终端用法保持原样（头注释已更新）；
- `package.json` `"selftest:lan": "node lib/_selftest-discovery.mjs --pair"`。

### 6.4 reply-route 增加 health diag 断言

`lib/_selftest-reply-route.mjs:110`：启动真实 peer server 后 GET `/mesh/v1/health`，断言
`health.ok === true`、`diag.net.source` 是字符串、`diag.net.macsAvailable` 是布尔、`diag.sidecarPlatform === "auto"`。
该测试的 fake discovery 故意**没有** `netInfo()`，顺带验证了 index.js 侧对缺失方法的兜底（真实 MeshDiscovery 有该方法）。

---

## 7. 验收命令与输出摘要

> 全部命令在 `E:\mesh\dsh-plugin-mesh` 下执行；离线（只有 loopback/私有组播组）。

### 7.1 静态门禁

```text
> node --check lib/netinfo.js / lib/discovery.js / lib/scan.js / lib/index.js / lib/diagnostics.js /
  lib/_selftest-netinfo.mjs / lib/_selftest-discovery.mjs   → 全部通过（无输出）
> node scripts/check-tdz.mjs                                  → ✓ 无声明前使用（TDZ）
> node scripts/check-version.mjs                              → ✓ 版本号一致：0.5.4
> npm run check                                               → check-EXIT=0
  ✓ 版本号一致：0.5.4 / ✓ 无声明前使用（TDZ） / ✓ 注册表一致：78 icons / 139 aliases / 12 tokens
  ⚠ 跳过：缺的是 DSH 运行时依赖，不是磁盘半态。   （check-loadable 的既有行为）
  ✓ llms.txt 与 docs/llms.txt 一致（10743 字符）
```

### 7.2 自测

```text
> npm run selftest:netinfo   → 结果：28 通过，0 失败          netinfo-EXIT=0
> npm run selftest           → 结果：67 通过，0 失败          tsnet-EXIT=0
> npm run selftest:lan       → [pair] 结果：mac-a exit=0，mac-b exit=0 → 通过   EXIT=0
    [mac-a] 对端变化 (1): ● mac-b 192.168.1.6:45901
    [mac-b] 对端变化 (1): ● mac-a 192.168.1.6:45900
> npm run selftest:reply     → ✓ /mesh/v1/health carries net diag (source/macsAvailable) + sidecarPlatform
                               ✓ 其余 6 条 inbound 路由用例，EXIT=0
> 其余离线 suite（逐个跑，均 exit=0）：
  prompt 15/0、pairing 8/0、client 48/0、release 21/0、reasoning ✓、persist ✓、
  layout 10/0、diagnostics 8/0、avatar 5/0、osinfo 22/0、resume ✓
```

### 7.3 配置面（真库校验，脚本在 `E:\mesh\.tmp\schemaprobe\`）

```text
# 用真实 @deepseek-ai/schemastery@3.18.5 构建 index.js 的整块 Config
keys: 35
new defaults: {"staticPeers":[],"advertiseAddress":"","sidecarPlatform":"auto","port":45917,"useMulticast":true,"scanRanges":[]}
explicit: {"staticPeers":["192.168.1.6:45917","192.168.1.6"],"advertiseAddress":"192.168.1.19","sidecarPlatform":"android"}
invalid staticPeers rejected: true
CONFIG SCHEMA OK

# 用真实 yaml@2.9.1 解析 cordis.patch.yml，核对原键一个不少
id: mesh name: dsh-plugin-mesh
new keys: {"staticPeers":[],"advertiseAddress":"","sidecarPlatform":"auto"}
extra keys: (none)
YAML OK
```

### 7.4 桌面端不回归（与 pristine 0.5.4 对照）

```text
> node E:\mesh\.tmp\regression-compare.mjs
next: {"lan":[{"iface":"WLAN","address":"192.168.1.6","mac":"ac:f2:3c:d9:26:3d"},…],"preferred":"192.168.1.6","mac":"ac:f2:3c:d9:26:3d"}
prev: {"lan":[…同上…],"preferred":"192.168.1.6","mac":"ac:f2:3c:d9:26:3d"}
address-helpers-identical: true
next selfRecord: {"host":"192.168.1.6","mac":"ac:f2:3c:d9:26:3d","os":"win32 10.0.26200","osInfo":{…},"machine":"regression","port":45917,"v":2}
prev selfRecord: {…完全相同…}
selfRecord-identical: true
NO REGRESSION
```

### 7.5 已知的既有失败（与本次改动无关，已对照证明）

`npm run selftest:caps` 在本机有 **2 项**失败：

```text
✗ 原 PATH 的每一项都还在（补全不能把已有路径挤掉）
✗ 自校验式判据：问的是「我们自己的兜底有没有起作用」，不是硬编码根
有失败：70 通过 / 2 失败
```

用**未改动的已安装 pristine 0.5.4** 跑同一个测试，**完全相同的 2 项失败**（`E:\DSH-Home\profiles\desktop\node_modules\dsh-plugin-mesh`，只读执行），
说明这是本机 Windows PATH 环境相关、改动前就存在的问题，不是 P0 回归（P0 也没改 capabilities/identity）。
`npm test` 因此会在 caps 这一步整体 exit 1；其余套件已逐个跑通（§7.2）。

---

## 8. 风险与边界（诚实说明）

1. **真机修正已吸收，但真机回归要重测**：本机没有 dsh-go 环境，只能证明"探测失败时不再崩、桌面不回归"。
   上机后请确认：`/mesh/v1/health` 出现 `diag.net.source`（真机预期 `"os"`）、`diag.net.macsAvailable:false`、
   启动日志出现"地址来源 os，MAC 不可用"、以及 `staticPeers: ["<桌面IP>:45917"]` 后手机 `mesh_peers` 能看到桌面。
2. **MAC 原值未改动**：`/mesh/v1/health` 的 `mac` 仍来自 os（真机是 `00:00:00:00:00:00`），
   以免改字段语义/影响既有 UI；"不可用"通过 `macsAvailable:false` + `MAC_UNAVAILABLE` 显式表达。
   若 P1 想把它归一成空串，建议连 UI 一起改并在报告里注明。
3. **`advertiseAddress` 只接受 IPv4**（可带 `:port`，端口忽略）；填错只记 `config/INVALID`，不会改变探测结果。
4. **`staticPeers` 的作用是"并入扫描候选 + 定向 health 探测"**，不做 unicast 公告。
   真机拓扑（桌面能发现手机、手机收不到组播）下这已经够用：手机配置桌面地址 → 手机扫描发现桌面。
   若以后要"手机不知道自己的 IP、桌面也发现不了手机"，再做 unicast 公告（P1/P3）。
5. **`sidecarPlatform` P0 只存值与展示**，不改变 sidecar 资产选择；P1 才实现 `auto→android` 逻辑。
6. **`--pair` 依赖组播/二层可达**：网络层拦组播时 pair 会失败并打印提示；它没有挂进 `npm test`
   （和原脚本一样是网络相关的手动验收），只有 `selftest:lan` 这一个入口用它。
7. **`docs/llms.txt` 是生成文件**（内容 = `llms.txt` 副本），仅为让 baseline tarball 缺失的 `check:docs` 通过；
   不包含手写内容，重跑 `node scripts/sync-llms.mjs --write` 可稳定复现。
8. 未改 `lib/tsnet/**`、`client/client.js`、`E:\DSH-Home` 副本；版本号保持 0.5.4。

---

## 9. 与 P1 的衔接

| P1 项 | 本次留下的接口 |
|---|---|
| `cpuCores:0`（os.cpus 为空时读 /proc/cpuinfo） | `capabilities.js` 未动；`netinfo` 的 /proc 解析器可复用作参考（不直接依赖，避免耦合） |
| 平台识别（`androidKernel`/osinfo/identity） | 建议新增 `lib/platform.js`（GAP §8 P1-1/2/3）；`netinfo` 只关心网络，不掺平台判断 |
| tsnet 资产选择（auto→android）+ `-version` 预检 | `sidecarPlatform` 配置已就位、已进 health diag/diagnostics/state；P1 只需在 `lib/tsnet/download.js:50-74` 读它 |
| `multicastRecv` 状态 | `/mesh/v1/health` 的 `diag` 结构已存在，加一个字段即可 |
| unicast 公告到 staticPeers | `peerHostsFromSpecs` 已导出，可直接给 `#announce()` 用 |

## 10. 复现/验收速查

```bash
cd E:\mesh\dsh-plugin-mesh
node --check lib/netinfo.js && node scripts/check-tdz.mjs          # 静态门禁
npm run selftest:netinfo                                           # 28 用例
npm run selftest                                                   # 67 用例
npm run selftest:lan                                               # 双进程发现（私有组播组）
npm run check                                                      # 全量 check（含 docs）
node --experimental-vm-modules lib/_selftest-reply-route.mjs       # health diag + 入站路由
node E:\mesh\.tmp\regression-compare.mjs                           # 与 pristine 0.5.4 对照
```
