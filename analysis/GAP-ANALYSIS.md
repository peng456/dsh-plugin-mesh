# GAP-ANALYSIS：dsh-plugin-mesh × dsh-go（Android proot）兼容性缺口

| 项 | 值 |
|---|---|
| 分析对象 | `E:\mesh\dsh-plugin-mesh`（v0.5.4，**只读**；published-tarball 拷贝） |
| 目标环境 | dsh-go 0.9.7（`io.github.ccch1mneyyy.dsh_app`）→ Flutter 壳 + proot Ubuntu 24.04.5 arm64 + Node 24.22.1 + DSH 0.2.1-rc.2 |
| 作者 | mesh-gap（task-2） |
| 证据标记 | ✅ 已实测 ／ ◐ 推断（有代码/平台依据） ／ ⏳ 待真机实测 |
| 复现脚本 | `E:\mesh\.tmp\gap-probe.mjs`（本地行为探针）、`apk-manifest.mjs`（APK 权限）、`asar-dsh.mjs`（桌面 DSH 版本/包清单）、`rootfs-etc\`、`clientcheck\`、`pkgjson\` |

---

## 0. 一句话结论

插件在 dsh-go 里会**以 `process.platform === "linux"` 的身份运在一个 Android app UID 的 kernel 上**：
平台分支（osinfo/identity/capabilities/tsnet 资产）全部走 linux，**不会报错，只会给出"看起来正常的错误事实"**；
真正会硬崩的是**本机局域网 IPv4 获取**（`os.networkInterfaces()` → glibc `getifaddrs` → netlink 被 app UID 拒绝），
而它位于 `MeshDiscovery` 构造函数里 → **整个插件被 apply() 的安全网停用**。
第二名阻塞是**组播收包**：dsh-go APK 没有 `CHANGE_WIFI_MULTICAST_STATE` 权限，装不了 `MulticastLock`，
手机基本收不到对端组播（发得出去，收不回来）。
第三名是 **tsnet sidecar 资产选成 linux/arm64**（Android 内核上 GOOS=linux 产物会踩 netns/`/proc/net` 的坑）。

> 好消息：三处都能在不改 dsh-go App 的前提下修好（UDP-connect 取源地址 + 静态对端 unicast 公告 + 扫描兜底 + 资产选择）。
> 详细的"改哪里/怎么验收"见 §8，真机实测清单见 §9。

### 阻塞级缺口（Top 6）

| # | 缺口 | 现状证据 | 后果 | 证据级别 |
|---|---|---|---|---|
| G1 | `os.networkInterfaces()` 在 app UID 下抛错，且**没有任何 try/catch**，构造函数里就调用 | `lib/discovery.js:84-92`、`:243`；`lib/scan.js:37`；探针实测：throw → `new MeshDiscovery()` 抛 → `apply()` 停用插件 | Mesh 完全不可用（日志一行 "初始化失败，插件已停用"） | ◐（Android 侧 netlink 拒绝来自 README 真机实测；dsh-go 具体行为 ⏳） |
| G2 | 平台识别全部按 linux 走，Android 分支一个都不触发 | `lib/osinfo.js:132`、`lib/identity.js:92-100`、`lib/capabilities.js:661-685`、`lib/tsnet/download.js:59` | UI 把手机显示成 Ubuntu；sidecar 拉 linux 资产；指纹/认领逻辑退化 | ✅（代码路径确定） |
| G3 | 组播只发不收：APK 无 `CHANGE_WIFI_MULTICAST_STATE`/`ACCESS_WIFI_STATE`，拿不到 `MulticastLock` | APK manifest 解析结果（§3）；`lib/discovery.js:399-401` | 手机看不到桌面主动广播；只能靠"手机广播被桌面看到"这半边 | ✅（权限事实）/ ⏳（实机丢包率） |
| G4 | 扫描兜底受 G1 连坐：`candidateAddresses()` 先枚举本机网卡，抛错时连 `scanRanges` 都不生效 | `lib/scan.js:19-45`，尤其 `:37` | 组播被挡 + 网卡枚举失败 = 没有任何发现路径 | ✅（探针实测：throw 时 `candidateAddresses([...])` 也抛） |
| G5 | tsnet 资产选 `linux/arm64`（GOOS=linux，静态 ET_EXEC），Android 内核上 netns controlC 读 `/proc/net` 会被拒 | `lib/tsnet/download.js:59`；README.md:298-309（Termux 实测同一坑） | 互联网组网起不来（LAN 不受影响），且错误只在组网卡片里 | ◐/⏳ |
| G6 | 无"静态对端"入口：所有发现都建立在"组播能通"或"本机 IP 已知"上 | `lib/discovery.js:363-418`（只 bind 组播组）、`:731-739`（只发组播） | 手机与桌面在"组播被隔离/收包被丢"的网络里无法首次相遇 | ✅（代码确定） |

---

## 1. 平台识别现状与在 dsh-go 的错误结果（Q1）

### 1.1 五个判定点

| 位置 | 判定方式 | 在 dsh-go 的结果 |
|---|---|---|
| `lib/osinfo.js:30` | `PLATFORMS = {win32,darwin,linux,android}`；`:94-95` 取 `process.platform` | 走 `:132` **linux 分支**：读 `/etc/os-release`（rootfs 里是 Ubuntu 24.04.5）→ `name="Ubuntu"`、`distro="ubuntu"`、`desktop=""`、`kernel=os.release()`（Android 内核串） |
| `lib/osinfo.js:142-153` | **android 分支**：`name="Android"` + `getprop ro.build.version.release` | **永不触发** |
| `lib/identity.js:56-100` | `:57` 取 `process.platform`；`:75-90` android→`getprop ro.serialno/...`；`:92-100` linux→`/etc/machine-id`、`/var/lib/dbus/machine-id`、`/sys/class/dmi/id/product_uuid` | 走 linux：rootfs 里 `/etc/machine-id` 是 **0 字节空文件**（已实测，见 §10.3），`/var/lib/dbus/machine-id` 不存在，ARM 手机无 DMI → **`rawMachineId()` 返回空串 → fingerprint=""**。功能上"退化成纯 UUID"，与设计允许的降级一致；但**认领机制（同机重装顶掉旧记录）失效** |
| `lib/capabilities.js:28`（`platform()` 来自 `node:os`）、`:100-142`、`:661-685` | PATH 补全按平台；`:137-140` Termux 路径；GPU 探测 `case "linux": case "android":` 同一份 | PATH 补全只补 `/usr/local/bin` 等（Termux 路径不存在被 `isDir` 过滤，`lib/capabilities.js:145`）；GPU 探测与 linux 相同（手机不会有 nvidia-smi → `gpu=null`，语义正确）。**无功能性错误**，只是名片 `os` 字段=`"linux <android内核串>"` |
| `lib/tsnet/download.js:50-64` | `:59` 平台→资产 os 映射：`{darwin,win32,linux,android}`，linux→`linux` | **下载 `dsh-mesh-tsnet-linux-arm64.gz`**（静态 ET_EXEC，GOOS=linux），不是 `android/arm64`（PIE+`/system/bin/linker64`，GOOS=android）。见 §4 |
| `lib/index.js:22,912` | `platform()`/`arch()` 直传 diagnostics、`/mesh/api/state` | UI 自述 platform=linux、`osLabel()` 显示 "Linux"（`client/client.js:232-235`） |
| `lib/discovery.js:313`、`:316` | 名片 `os: "${os.platform()} ${os.release()}"`、`osInfo: osInfo()` | 名片里 `os` 大概率含 `-android` 内核串（`osLabel` 会命中 `includes("android")` → 显示 Android），但 `osInfo.name="Ubuntu"` 会被 UI 优先显示（`client/client.js:osInfoLabel`）→ **同一台设备在不同视图里显示成 Linux / Android / Ubuntu 三种事实** |

### 1.2 结论：现有 Android 分支全不触发，得到什么错误结果

1. **不会崩**（除了 §2 的网卡问题），但会得到"看起来正常的错误事实"：
   - 手机自述 `platform=linux`、`name=Ubuntu 24.04.5`、`distro=ubuntu` —— 对端 Placement/UI 会把它当一台 Linux 服务器；
   - `capabilities.os="linux 5.15.x-android…"`，与 `osInfo` 自相矛盾；
   - 指纹空（无 DMI/machine-id），重启后 instanceId 变化时无法认领，可能产生重名。
2. **sidecar 资产选错**（§4）。
3. **平台分支本可复用的三件 Android 适配全部白写**：`getprop` 版本号、Termux PATH、android 资产映射。

### 1.3 建议的 dsh-go 识别信号（均不依赖 netlink）

| 信号 | dsh-go 里是否存在 | 说明 |
|---|---|---|
| `/dev/__properties__`（目录） | 是（proot `-b /dev`，见 `00-CONTEXT.md:20`） | **与 tailscale `androidbin` 完全相同的判据**（上游 `feature/androidbin/androidbin.go:onAndroid()`，见 §4.3） |
| `/system/build.prop` | 是（`-b /system`） | 次选判据 |
| `/opt/dsh-go/` 或 `/etc/dsh-app/` | 是（rootfs，已解包确认） | 用于识别"dsh-go 包装"，可与 Android 判据分开 |
| `os.release()` 含 `-android` | 大概率（Android 内核版本串） | 只在上面都读不到时的兜底 |
| `process.env.DSH_GO_*` / `DSH_HOME=/root/.dsh` | 只有 `DSH_GO_DIRECT_MAIN`（direct 引擎，见 `direct/preload.mjs:39`） | 不可靠，别依赖 |

> 判定应返回**两个正交事实**：`androidKernel: boolean`（内核/权限模型）与 `runtime: "proot" | "direct" | "native"`，而不是把 `process.platform` 硬改成 "android"。osinfo/identity/capabilities/discovery 各自取需要的那一个。

---

## 2. 本机地址获取（Q2）

### 2.1 现状：唯一来源是 `os.networkInterfaces()`

```js
// lib/discovery.js:84-92
export function lanIPv4Addresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) { … }   // ← 无 try/catch
```
- `lib/discovery.js:103-113 preferredAddress()`：按网卡名打分（`en0|eth0|wlan0` 优先），**无地址时返回 `127.0.0.1`**。
- 使用点：
  - 构造函数 `lib/discovery.js:243`（→ 抛错会把插件打死，`lib/index.js:741-751` 的安全网会停用插件）；
  - 每次心跳 `lib/discovery.js:303-304`（**每 5s 重算**，切网自愈的设计）；
  - 扫描 `lib/scan.js:37`（见 §3.3）；
  - 日志/UI `lib/index.js:935`、`lib/index.js:2132`、`lib/index.js:2522`、`:2549`。
- 回信/公告里用到的地址：
  - 公告：`host: preferredAddress()`（`lib/discovery.js:311`）——**但接收侧不信任它**；
  - 接收侧以观察到的源地址为准：`lib/discovery.js:762 const host = address || selfHost;`（`:381-394` 把 `rinfo.address` 传进来）→ **关键缓解：手机不需要知道自己的 IP，也能被桌面正确登记**（只要它能发包出去）。
  - 回信：对端地址来自 peer 记录的 endpoint，`lib/index.js:1744 peerFetch()`；不是"用本机 IP"。

### 2.2 proot（Android app UID）下的失败形态

| 形态 | 触发 | 探针实测（`gap-probe.mjs`，本机模拟） | dsh-go 概率 |
|---|---|---|---|
| **A. 抛异常** | glibc `getifaddrs` → netlink RTM_GETLINK/GETADDR 被 SELinux/EPERM 拒 | `lanIPv4Addresses/preferredAddress/candidateAddresses/new MeshDiscovery` **全部 throw**（`uv_interface_addresses … Permission denied`） | ◐ 高（README.md:194-205 在 Android 13 真机测得 Go 的 netlinkrib `permission denied`；Node 走 glibc，同样被拒） |
| **B. 返回 []/只剩回环** | netlink 能开但看不到 wlan0 | `preferredAddress()="127.0.0.1"`、`candidateAddresses([])=0`、名片 `host="127.0.0.1"`（探针实测） | ◐ 中 |
| **C. 正常** | 某些 ROM 放行 | 一切照旧 | ⏳ 需实测 |

> 注意：Node 在 Termux 下没问题，是因为 Termux 的 Node 链 bionic（`getifaddrs` 走 netd）；dsh-go 的 Node 链 **glibc**（Ubuntu rootfs），glibc 的 `getifaddrs` 自己发 netlink —— 这正是"Termux 能跑、dsh-go 不一定能跑"的关键差异。

### 2.3 兜底方案与可靠性排序（推荐按此顺序实现）

| 排序 | 方案 | 依赖 | 可靠性 | 备注 |
|---|---|---|---|---|
| 1 | **UDP connect 取源地址**：`dgram.createSocket("udp4")` → `connect(53, gateway/8.8.8.8)` → `address().address`（不发包） | 仅 socket（Node 本来就能连网） | **高**（探针实测本机返回 `192.168.1.6`，两个目标一致；tailscale 官方 androidbin 就用这一招，见 §4.3） | 目标是"拿到默认路由的源地址"；建议同时试 **网关**（更贴近 LAN）和 `8.8.8.8`（无 LAN 时） |
| 2 | **配置 `advertiseAddress`** | 用户填一次 | 高（人工兜底） | 新增配置，见 §7 |
| 3 | **`/system/bin/ip -4 addr`**（bionic iproute2，`-b /system` 可见） | 需 app 能开 netlink；bionic 二进制在 proot 里可 exec | 中低（大概率同样 EPERM）⏳ | 值得做一个"廉价探测"，失败即降级；不要当主路径 |
| 4 | **`/proc/net/route`、`/proc/net/fib_trie`、`/proc/net/if_inet6`** | 读 /proc/net | 低（README.md:201-203 在 Termux 同 UID 下实测 EACCES）⏳ | 在 dsh-go 里 `/proc` 是 `-b /proc` 的 Android /proc，限制相同 |
| 5 | **`/sys/class/net/*`** | sysfs | 中（能给网卡名/MAC 文件，**给不了 IPv4**） | 只适合补 `macForAddress()`、接口名打分 |
| 6 | **App 写的 `/etc/resolv.conf` 反推网段** | rootfs 文件 | 中低（App 写的是真实 DNS；`E:\mesh\.tmp\dshgo-logs\dsh.log` 里 ns1=`192.168.1.1`，可反推候选 /24） | 只用于**生成 scanRanges**，不能当本机 IP；公共 DNS 时会错 |
| 7 | **`dsh-go-bridge` 原生能力** | bridge v0.4.0 的能力面 | **当前不可用** | 已实测：`dsh-go-bridge/lib/native/capabilities.js:7 FEATURES=["audio","voice","micro","overlay","files"]`，**没有任何网络/设备 IP API**；要用得让 App 侧加 |
| 8 | **`/system/bin/getprop`（`dhcp.wlan0.ipaddress`、`net.hostname` 等）** | 属性服务（app 可读） | 低（新 ROM 上 dhcp.wlan0.* 基本为空）⏳ | 只能当最后的嗅探 |
| 9 | **让对端告诉我们**：unicast 公告发给 `staticPeers`，对端用包源地址登记我们 | 只需能发包 | **高** | 不需要本机 IP；见 §3.4/§7 |

### 2.4 结论

- **P0**：给 `lanIPv4Addresses()` 加 `try/catch` + UDP-connect 兜底 + `advertiseAddress` 覆盖；把"取地址"从 `discovery.js` 抽到独立模块（如 `lib/netinfo.js`），并让构造函数/心跳/扫描都走它。**任何一处都不能抛**。
- provider 需返回**顺序与来源**（`source: "interfaces"|"udp"|"config"`），进 diagnostics/UI —— 这台手机的"地址从哪来"必须可见，否则又是"看起来正常的空数据"（AGENTS.md 硬约束 1）。

---

## 3. 组播发现与 Android 限制（Q3）

### 3.1 现状收/发路径

| 方向 | 代码 | 细节 |
|---|---|---|
| 发送 | `lib/discovery.js:731-739` | 每 `announceIntervalMs`(5s) 向 `239.255.42.99:45892`（`:23-24`）发 JSON 名片；**不带 mac**（`:293`、`:353`）；TTL=1（`:399`） |
| 接收 | `lib/discovery.js:363-418` | `dgram.createSocket({type:"udp4", reuseAddr:true})`（`:374`）→ `bind(45892)`（`:409`）→ `addMembership(group)`（`:401`），`message` 回调用 `rinfo.address` 登记（`:381-394`） |
| 失败可见性 | `:377-379`、`:402-404`、`:410-412` | socket error / join 失败 / bind 失败 **只 emit diagnostic**，不抛不重试 —— 在手机上会表现为"静默零发现" |
| 端口契约 | `:763` | 对端 HTTP 端口取自 `msg.port`（不能用 `rinfo.port`，注释 `:390-393` 是踩过的坑） |
| 超时 | `:235`（构造默认 `ttlMs=20000`、`intervalMs=5000`）、`:369`（sweep 周期=ttl/4） | peerTtl 20s → 标记离线；keep 5min |

### 3.2 Android 限制（对 mesh 的具体影响）

| 机制 | dsh-go 事实 | 影响 | 证据级别 |
|---|---|---|---|
| **MulticastLock** | APK **没有** `CHANGE_WIFI_MULTICAST_STATE`，也没有 `ACCESS_WIFI_STATE`（manifest 解析，§10.5） | 无法申请 MulticastLock → Wi-Fi 驱动通常**丢弃入站组播帧** → 手机收不到桌面的 5s 心跳；`addMembership` 仍会成功（所以日志里没有任何错误） | ✅ 权限缺失 / ⏳ 实机收包 |
| **发送** | 无需权限 | 手机每 5s 的组播公告能出去；桌面的 discovery 用**包源地址**登记（`:762`）→ **桌面能发现手机**（比反向更乐观） | ◐ |
| **AP isolation** | 路由器侧 | 客户端之间 L2 全隔离 → 组播且不说，**TCP 直连也不通** → 只能靠 hotspot/关闭隔离 | ⏳ 现场网络 |
| **Doze / App Standby / 厂商清理** | README.md:115-142；APK 有 `FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_SPECIAL_USE`/`WAKE_LOCK`/`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | 屏幕关闭后网络可能被暂停 → 心跳/RTT 断档；对端 20s TTL 会把手机判离线。建议 dsh-go 侧把 `peerTtlMs` 放大（如 60s），并在 App 里加电池白名单 | ◐ |
| **端口占用/固定端口** | `lib/index.js:2199-2207`（EADDRINUSE 退回随机端口） | 随机端口时主动扫描扫不到；组播公告仍能自愈（`setPort` 重播，`lib/discovery.js:264-268`） | ✅ |

### 3.3 `lib/scan.js` 能否兜底？——能，但必须先修 G4

- 扫描本身与组播无关：`scanForPeers()` 直接 `fetch http://<ip>:<port>/mesh/v1/health`（`lib/scan.js:92-118`），命中后用 `discovery.note(rec, rec.sourceAddress)` 登记（`lib/index.js:1943-1945`）。
- 端口来源：`scanPortList()` = 本机端口 + `45917` + `config.scanPorts`（`lib/index.js:1912-1914`）→ 手机与桌面同默认端口即可互扫。
- 触发：启动重试（`lib/index.js:985-999`，延迟 0/8/20/45s）、周期 `scanIntervalMs`（`:1001-1008`）、tailnet（`:979`）、手动/agent（`:2295`、`:2768`）。
- **但** `candidateAddresses()` 的第一段就是枚举本机网卡（`lib/scan.js:37`），**没有 try/catch**：
  - 探针实测：网卡抛错时，`candidateAddresses([])` 和 `candidateAddresses(["192.168.1.0/24"])` **都抛** → `runScan` 在 `.catch(()=>{})` 里被吞掉（`index.js:998`、`:1003`）→ 用户只看到"扫描没结果"。
  - 只有"网卡返回空数组"的形态下，`scanRanges` 才真正生效（`lib/scan.js:41-43` 在本地 /24 之后追加）。
- 需要的配置：`scanRanges: ["192.168.1.0/24"]`（或从 `/etc/resolv.conf` 的 ns 反推）+ 默认端口；`scanTimeoutMs` 800ms 对 Wi-Fi 偏紧（手机上建议 1200~1500ms）；`scanConcurrency` 64 会让手机耗电/发热，建议 32。

### 3.4 结论与推荐组合（不依赖 App 改权限）

1. **保留组播发送**（它是手机→桌面的发现路径，成本最低）；**不要**因为"收不到"就把 `useMulticast` 关掉。
2. **新增 `staticPeers`**：手机每轮心跳**额外 unicast 发一份公告**到 `staticPeers` 的 `<ip>:45892`（对端 discovery socket 已 bind 该端口，会正常 upsert，并用源地址纠正 host，`lib/discovery.js:762`）—— 这是"手机不知道自己的 IP、也收不到组播"时的**双向兜底**。
3. **新增 staticPeers 的 HTTP 主动探测**（复用 `scanForPeers({addresses: [...staticPeers]})`，`lib/scan.js:69-87` 支持显式 addresses）→ 手机能学会桌面。
4. `scanRanges` 作为第三重兜底（配置或从 resolv.conf 推导），前提是先修 `candidateAddresses` 的 try/catch。
5. 读取路径上把"组播 join 成功但 X 秒 0 包"记录成 diagnostic（现在完全静默），便于真机判定。

---

## 4. tsnet sidecar（Q4）

### 4.1 资产选择现状

```js
// lib/tsnet/download.js:59
const os = { darwin: "darwin", win32: "windows", linux: "linux", android: "android" }[process.platform];
// :61  arch: x64→amd64 / arm64→arm64
```
- dsh-go：`process.platform="linux"`、`process.arch="arm64"` → 资产 **`dsh-mesh-tsnet-linux-arm64.gz`**（`lib/tsnet/download.js:67-74`）。
- 两种资产的形态差异（README.md:96-104、`scripts/build-sidecar.sh:113-152`）：
  - `linux/arm64`：`CGO_ENABLED=0` **全静态 ET_EXEC**（`-buildmode=exe`），GOOS=linux；
  - `android/arm64`：GOOS=android + `-buildmode=pie` + `-ldflags=-I /system/bin/linker64` + `fix-android-tls-align.py` 抬 TLS 对齐 → **PIE + bionic 解释器**。
- 校验和两种资产都已钉好：`lib/tsnet/checksums.js:13`（android-arm64）、`:17`（linux-arm64）。
- 缓存路径**不含 os/arch**：`lib/tsnet/download.js:83-86 binaryPath()`；`cacheState()`（`:118-130`）靠 `.source-sha256` 标记判断 stale → 切资产会重下（同一文件名会被覆盖，功能可用，但 diagnostics 里看不出"现在用的是哪种风味"，建议加）。

### 4.2 `sidecar/androidbin_linux.go` 的 `onAndroid()` 判定

- 插件源码只做一件事：`import _ "tailscale.com/feature/androidbin"`（`sidecar/androidbin_linux.go:39`，注释 `:5-33` 记录了 Termux 实测的 `netlinkrib: permission denied`）。
- 真正的 `onAndroid()` 在上游包（tailscale **v1.104.1**，`sidecar/go.mod:5`）：
  `runtime.GOOS == "android" || os.Stat("/dev/__properties__") == nil`
  （上游 `feature/androidbin/androidbin.go`，`onAndroid()` 注释明确说"GOOS=linux binary running under an Android kernel"也返回 true）。
- 它做三件事（上游 `androidbin.go` / `cacerts.go`）：
  1. `netmon.HookInterfacesFallback`：`net.Interfaces()` **已经失败之后**，用 **UDP connect 源地址**合成一个 `android` 网卡（不发包）；
  2. 拉进 `androiddns`（走 `/dev/socket/dnsproxyd`，没有 `/etc/resolv.conf` 时才有意义）；
  3. GOOS=linux 构建时把 `SSL_CERT_DIR` 指到 `/system/etc/security/cacerts`（`cacerts.go`）。
- 插件自己的 `sidecar/androidnet_linux.go`：
  - `:405-412 runningOnAndroid()` 用的是**同一个判据**（`/dev/__properties__`）；
  - `:92-97 ensureDNS()` 第一句是"`/etc/resolv.conf` 存在且非空就什么都不做"。

### 4.3 在 dsh-go（proot）里分别会发生什么

| 阶段 | linux/arm64 资产（现状会选的） | android/arm64 资产（建议改选的） |
|---|---|---|
| 下载 | ✅ 走镜像（`download.js:38-43`）；国内三镜像在真机可能全挂（README.md:829-836） | 同左 |
| 解压/校验 | ✅ `looksExecutable()` 只查 ELF 魔数（`download.js:374-388`），两种资产都过 | 同左 |
| **exec（proot）** | ◐ 静态 ET_EXEC：proot 的 exec 路径与 Termux 的 `linker64` 转发不同，理论上内核直接加载；⏳ 需实测 `-version` | ⏳ PIE 的 `PT_INTERP=/system/bin/linker64`：`-b /system` 已挂载 → 内核能找到解释器；`main.go` 的 `normalizeArgs()`（`:210-228`）能吸收 linker64 转发造成的 argv 错位（README.md:184-192） |
| `onAndroid()` | **true**（`/dev/__properties__` 经 `-b /dev` 可见）→ 合成网卡 fallback 生效 | true |
| net.Interfaces | 第一次失败（netlink EPERM），随后 androidbin fallback 成功 → tsnet 的 `netmon.New()` 能起来 | GOOS=android 的 netmon 是 polling 实现，**根本不碰 netlink** |
| **netns controlC** | ❌ GOOS=linux 走 `netns_linux.go`：对每个 socket 调 `netmon.DefaultRouteInterface()` → 读 `/proc/net/route`（app UID EACCES，README.md:298-309 实测）→ **tsnet 很可能在这一步死掉** | ✅ `netns_android.go` 的 controlC 没有 Java 回调时什么都不做 |
| DNS | rootfs `/etc/resolv.conf` 由 App 每次启动重写（`E:\mesh\.tmp\dshgo-logs\dsh.log`：`resolv.conf … result=written ns1=192.168.1.1,…`）→ `ensureDNS()` 直接返回，不打架；Go 解析器读它 ✅ | 同左（`androiddns` 即使装上也不改写 net.DefaultResolver 的行为；不影响） |
| CA | androidbin 的 `cacerts.go` 会把 `SSL_CERT_DIR=/system/etc/security/cacerts`（`-b /system` 可见）→ 控制面 TLS 有根证书 ✅ | GOOS=android 的 x509 本来就读 `/system/etc/security/cacerts` ✅ |
| 控制面 | 取决于 controlC，见上 | 预期可用 |

> 结论：**现状 linux 资产大概率在 controlC 一步死**（正好是 README 记录的 0.3.11 "最后一跳"）。建议**优先选 android/arm64**；linux/arm64 保留为 fallback（万一 proot 执行 bionic PIE 有问题）。

### 4.4 建议方案（按优先级）

1. `lib/tsnet/download.js` 增加 `detectTarget()` 的 os 覆盖：
   - 默认 `auto`：`process.platform==="android"` → android；`process.platform==="linux" && isAndroidKernel()` → **android**；否则 linux；
   - 配置 `sidecarPlatform: "auto"|"linux"|"android"` 可覆盖（新增配置，§7）；
   - fallback 链：`[首选, 另一风味]`，每个都走完整 ensureBinary→spawn；
   - `binaryPath()` 里带上 os（如 `bin/sidecar-v1/<os>-<arch>/dsh-mesh-tsnet`），让两种资产可共存、诊断可见；`cacheState()` 自然按资产校验和区分。
2. `lib/tsnet/manager.js`：spawn 前先用 `<binary> -version` 试跑（`sidecar/main.go:52-62` 支持 `-version`，输出 JSON 后退出，不联网），失败就换下一个风味，并把 stderr 原话记进 `status.diag`（现有 `:391-394`/`:495` 的 error 落地已具备）。`-version` 是**最便宜的实机验收手段**。
3. 若 android 资产在 proot 里 exec 失败（PIE+linker64 被 proot 拦），再退回 linux 资产并接受 controlC 风险；**不要**为此改 `GOOS` 或用 NDK 重编（成本高）。
4. 下载源：dsh-go 首次安装时优先用**局域网 http 镜像**（`tsnetDownloadSources`，`download.js:150-163` 支持 `http://`）——真机镜像可达性差的教训见 README.md:829-836。

---

## 5. 主机 HTTP 服务 / 回信路由（Q5）

### 5.1 现状

| 项 | 代码 | 在 dsh-go 的可行性 |
|---|---|---|
| 监听 | `lib/index.js:2209` `server.listen(port, "0.0.0.0")`；默认端口 45917（`:89`、`:2199`）；占用则退回随机（`:2200-2207`） | ✅ Android app 可 bind ≥1024；APK 有 `INTERNET`（manifest 已解析）。风险：Doze/后台网络暂停时不可达 ⏳ |
| 路由 | 免鉴权：`/mesh/v1/health`、`/mesh/v1/hello`（`:2068-2078`）；其余先过 `authed()`（`:2080`）；`/mesh/v1/file`、`/diagnostics`、`/web-url`、`/peers`、`/tasks`、`/task`（`:2084-2193`） | ✅ 纯 Node http，不依赖 Android API |
| 入站任务 | `POST /mesh/v1/task`（`:2155-2193`）→ `handleInboundTask`（`:1474-1722`）：回执判定、闸门（`:1412-1468`）、复用/新建会话、注入 | ◐ 依赖 DSH host 服务：`agents`/`agentPresets`/`permissionPresets`/`sessionTitle`/`workspaceRegistry`（`:1125-1152`、`:1160-1230`）。dsh-go rootfs 里有对应包（§10.6）→ 大概率可用 ⏳ |
| 会话键 | `lib/conversation.js:33-40`：`sha256(fromMachine + thread)` 前 12 位；**每端各算、无需协商** | ✅ 与网络拓扑无关 |
| 回信地址 | `lib/conversation.js:53-59`：`{machine, session, thread}`；peer agent 用 `mesh_run` 回派（`lib/index.js:2370-2420` 一带），目标用**对端记录**解析 | ◐ 需要"对端记录存在" → 手机若没发现桌面，回信会"找不到对端"。staticPeers 直接解决 |
| pairing | 默认 `requirePairing=false`（`:260`），token 头 `x-dsh-mesh-token`（`:2059-2060`） | ✅ 建议 dsh-go 侧设为 true（手机常在不可信 Wi-Fi） |
| NAT/模拟器 | MuMu(x86) 与 proot 冲突，**该项目当前不走模拟器**（`00-CONTEXT.md:26-28`）；arm64 AVD 的 10.0.2.x 是模拟器 NAT，桌面不可直达 | ⏳ 真机同一 Wi-Fi 才有意义；模拟器场景建议直接排除 |
| 远程 Web | `/mesh/v1/web-url` 检查 `bind==="0.0.0.0"`（`:2132-2142`）；dsh-go 的 DSH web 启动参数是 `--host 127.0.0.1 --port 3080`（`00-CONTEXT.md:21`）→ `lanReachable=false` | 但 **`desktopWebPort: 3080`** 这条前缀代理可用（`:3426-3462`，本机 mesh 服务代理到 `127.0.0.1:3080`）→ 桌面可以从 mesh 里打开手机 DSH Web（待实测 cookie 签名链路 `lib/desktop-auth.js`） |

### 5.2 结论

- 服务端/回信本身的网络路径没有 Android 特有问题（手机出站没问题；入站只要有网且不被省电掐）。
- 真正的瓶颈仍是**发现**：`handleInboundTask` 的回复、`mesh_run` 的目标解析、`pingKnownPeers` 的保活，全都要求"对端记录存在"。因此 §2/§3 的 `staticPeers` + UDP 兜底是 5 的前置条件。
- 建议 dsh-go profile 里额外开：`requirePairing: true`、`desktopWebPort: 3080`（看到手机引擎）、`permissionPreset: workspace-write`（保持默认，别给 danger）。

---

## 6. 客户端 UI（Q6）

### 6.1 `client/client.js` 实际依赖的 DSH 客户端 API 清单

| 依赖 | 位置 | 说明 |
|---|---|---|
| `window.__ModuleLoader__.load({ id: "dsh-plugin-mesh", factory })` | `client/client.js:20-21` | 手写 bundle 契约；id 必须等于包名 |
| `require("react")` | `client/client.js:27`（**唯一** require；JSX 运行时不依赖，bundle 自带 `h()` 手写元素） | 允许的 require 面 |
| 导出 `apply(ctx)` / `inject` | `client/client.js:8678-8691` | `inject = ["slots"]`（`:36`）——只声明 slots 服务 |
| `ctx.slots.inject(slot, cb)` + `ctx.slots.register(def, Component)` | `client/client.js:8679-8687` | 注册 **`sidebar.panellist`**（id=`PANEL_ID`, order=50, label="Mesh"）与 **`main`**（key=`PANEL_ID`） |
| `ctx.get("sidebarRight")` → `openTab/openTabIn/mounted` | `client/client.js:369-390`、`:739-741` | **可选**，取不到就降级 |
| `ctx.get("uiWorkspace")` | `client/client.js:730` | 可选 |
| `ctx.get("sessions")` / `ctx.get("conversation")` / `ctx.get("layout")` | `client/client.js:751-763`、`:8262` | 可选（`|| ctx.sessions` 兜底） |
| `window.androidBridge.openExternalLink` | `client/client.js:341-390` | 可选；**dsh-go 里没有这个 bridge**（APK 是 Flutter `webview_flutter`，字节扫描无 `androidBridge`）→ 退化到 `window.open` |
| `window.open` / `navigator.clipboard` / `fetch` | 多处 | Flutter WebView 支持情况 ⏳ |

### 6.2 与 dsh-go 内 DSH 0.2.1-rc.2 的静态核对结果

已把 dsh-go rootfs 里的客户端包解出来（`E:\mesh\.tmp\clientcheck`）并逐项核对：

| 依赖的服务/槽位 | 0.2.1-rc.2 是否存在 | 证据（解包文件:行） |
|---|---|---|
| `slots` 服务 | ✅ | `dsh-cordis-client-runner/lib/client.js:559`（`__ModuleLoader__`）、`:598-600`（插件自身 inject 保留）；`dsh-client-ui-sidebar-right/lib/client.js:1348`（`super(ctx,"slots")`） |
| 槽位 **`sidebar.panellist`** | ✅ | `dsh-client-ui-sidebar/lib/client.js:190`、`:454`、`:469`、`:503` |
| 槽位 **`main`** | ✅ | `dsh-client-ui-layout/lib/client.js:119`、`:615-631`、`:689` |
| `sidebarRight` 服务 | ✅ | `dsh-client-ui-sidebar-right/lib/client.js:4848-4849`（`provide("sidebarRightTabs")` / `provide("sidebarRight")`） |
| `uiWorkspace` 服务 | ✅ | `dsh-client-ui-sidebar/lib/client.js:439/447` |
| `layout` 服务 | ✅ | `dsh-client-ui-layout/lib/client.js:622`（`provide("layout")`） |
| `sessions` 服务 | ✅ | `dsh-client-ui-session` 系列（rootfs 包清单存在） |
| `conversation` 服务 | ⚠ 未在解出的包里找到；mesh 侧已判空降级 | `client.js:753` 有 `?:` 保护 |

**桌面版本对照**：`E:\DSH-App\resources\app.asar` 里的 `dsh/package.json` 是 `@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.2` —— 与 dsh-go **同版本**。
`package.json` 的 `dsh.client.inject` 列出了 `dsh-client-ui-slots`、`dsh-client-ui-primitives`，但：
- 桌面 asar 里 **0 个路径** 含这两个包（`asar-dsh.mjs` 实测）；
- dsh-go rootfs 的 `@deepseek-ai/*` 清单里也没有这两个包（tar 清单 + `dsh-web-app` 依赖表）。
→ 它们在**桌面（同版本）就是死引用且不影响运行**，因此对 dsh-go 也只是历史包袱；建议在 dsh-go 交付的包清单里删掉这两项（或至少不要用它做"兼容性门槛"）。

### 6.3 结论与残余风险

- **UI 主体大概率直接可用**（槽位/服务在 0.2.1-rc.2 全都有，loader 契约一致）。
- 残余风险（⏳ 待实测）：
  1. dsh-go 的 **island 模式**：`dsh-go-bridge` 的 client 会为 `#dsh-go-island=<slot>` 遮蔽"官方条目"（`dsh-go-bridge/lib/client.js:14-20`）。mesh 注册在 `main`（keyed），是否被 App 的 island 食谱遮蔽要实测；若被遮，Mesh 面板可能不显示（但侧栏入口 `sidebar.panellist` 仍应显示）。
  2. `window.androidBridge` 不存在 → "打开对端 DSH Web" 按钮可能无效（`window.open` 在 Flutter WebView 里通常被拦）；这是次要功能。
  3. 令牌/鉴权：dsh-go 的 WebView 启动 URL 带 `?token=`（`dsh web` 打印），mesh UI 的 `/mesh/api/*` 是同源 fetch → 预期正常 ⏳。

---

## 7. 配置与安装面（Q7）

### 7.1 现有配置项对 dsh-go 的意义

| 键（`lib/index.js:209-351`，patch 里同名 `cordis.patch.yml`） | dsh-go 下的意义 |
|---|---|
| `enabled` | 必须 true |
| `machineName` | **必填**（默认空→用 hostname；proot 里 `/etc/hostname` 是 `localhost` → 会变成 "localhost" 重名）建议填"手机名" |
| `port: 45917` | 保持默认（扫描靠它）；随机端口时依赖公告自愈 |
| `useMulticast` | **保持 true**（发送是手机→桌面的唯一无配置发现路径，§3.4）；不要因为收不到就关 |
| `scanOnStart` / `scanIntervalMs` | 保持开；手机建议 `scanIntervalMs: 120000`（省电） |
| `scanRanges` | **dsh-go 关键项**：网卡枚举不可用时唯一能扫的网段；建议 `["192.168.1.0/24"]` 或由 resolv.conf 推导 |
| `scanPorts` | 视桌面是否改端口；一般留空 |
| `scanTimeoutMs: 800` / `scanConcurrency: 64` | 手机 Wi-Fi 建议 1200~1500 / 32（省电、少丢包） |
| `pingIntervalMs: 10000` | 保持；它是"不进组播也能保活"的关键 |
| `announceIntervalMs: 5000` / `peerTtlMs: 20000` | 手机进 Doze 会断心跳 → 建议 `peerTtlMs: 60000`（对端看它不那么容易掉线） |
| `requirePairing: false` | **建议 dsh-go 改 true**（手机常连不可信 Wi-Fi；配对码机制两端都支持） |
| `agentPreset: standard` / `permissionPreset: workspace-write` | 保持默认；dsh-go rootfs 有对应包（`dsh-agent-preset`、`dsh-permission-presets`） |
| `workspaceRoot: ""` | 默认回退家目录 `/root`；建议显式 `/root/work` 或 App 的工作区 |
| `desktopWebPort` | 手机侧可设 **3080**（手机 DSH web 只绑 127.0.0.1）→ 桌面经 mesh 前缀代理查看手机引擎（`lib/index.js:3426-3462`） |
| `experimentalRemoteControl` | 手机侧保持 false（`/web-url` 会如实报 `lanReachable:false`，`:2132-2142`） |
| `tsnet*` | 想在手机上用互联网组网才需要；依赖 §4 的资产修复 |
| 循环限速四项 | 手机侧建议保持默认（30 次/小时）甚至更严（手机上跑 agent 有本机成本） |

### 7.2 建议新增的配置键（及理由）

| 新键 | 类型/默认 | 理由 |
|---|---|---|
| **`staticPeers: string[]`** | `[]`（如 `["192.168.1.6:45917"]`，可省端口） | **最重要**。组播收不到 + 本机 IP 拿不到时，唯一可配置的双向发现；实现 = unicast 公告 + 定向 health 探测（§3.4）。给 dsh-go 装一次改一次配置即可用 |
| **`advertiseAddress: string`** | `""` | UDP 兜底也失败时人工指定本机 LAN IP（公告/UI/扫描用）。必须存在，否则用户只能靠猜 |
| **`sidecarPlatform: "auto"\|"linux"\|"android"`** | `"auto"` | 覆盖 tsnet 资产风味（§4.4）；auto=dsh-go 自动选 android 资产 |
| **`deriveScanRangeFromDns: boolean`** | `false`（或 auto） | 从 App 写的 `/etc/resolv.conf` 的私有 DNS 反推候选 /24 作为 `scanRanges`（§2.3 第 6 项），让"零配置扫描"在手机上成立 |
| `peerServerBind`（可选） | `"0.0.0.0"` | 默认即可，可不做；但若以后 Android 有网卡选择需求会用到 |
| `runtimeFacts`（只读诊断，非配置） | — | 把 `androidKernel/proot/addressSource/multicastRecv` 暴露到 `/mesh/api/state` + 诊断卡片（AGENTS.md 硬约束 1：探测失败必须可见） |

> 注意 AGENTS.md §3.3/§3.4 的两条硬约束：**改 schema 默认值不够**（profile 的 `cordis.patch.yml` 会覆盖）；**`config:` 是整体替换不是合并** —— 给 dsh-go 写 patch 时要把所有要用的键一次写全。

### 7.3 安装与持久化约束（dsh-go 特有）

| 项 | 事实/约束 |
|---|---|
| 运行时位置 | `/data/data/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs`；DSH_HOME=`/root/.dsh`（`00-CONTEXT.md:19-21`）；rootfs 里 `/root/.dsh/` 已预置（空目录） |
| 插件安装路径 | `<DSH_HOME>/profiles/<profile>/node_modules/<pkg>` + profile `package.json` 的 `dsh.profile.bundles`（`install.sh:36-38`、`:129-132` 的约定）；proot 里 Node/pnpm 都是 rootfs 自带的（`/opt/node`、`/usr/local/lib/node_modules/pnpm`） |
| 依赖 | `ssh2` 是**静态 import**（`lib/ssh-host.js:13`）→ 必须有 `node_modules/ssh2`（`install.sh` 只复制 lib/client/scripts/package.json/cordis.patch.yml/README/LICENSE，**不含 node_modules**）→ dsh-go 上要么 `pnpm add` 安装 tarball，要么手工连 node_modules 一起搬 |
| 打包/分发 | 非 root 真机不能 `adb push` 到 app 私有目录；rootfs 也只 bind 了 `/dev /proc /sys /system /apex`（**没有 /sdcard**）→ 走**局域网 HTTP**（桌面起 http server → dsh-go 内 agent bash `curl`），或 DSH 插件市场（App patch 里 plugin-manager fallbackRegistries=npmmirror+npmjs，`00-CONTEXT.md:25`）⏳ |
| 引擎 web 端口 | `--host 127.0.0.1 --port 3080`（`00-CONTEXT.md:21`）；本地联调/取证据用 `adb forward tcp:3080 tcp:3080` |
| 运行时升级 | `runtime.tar.xz` 解包会覆盖 rootfs；`/etc/dsh-app/*` 注释明确"每次 runtime 升级都被替换"（`rootfs-pick/etc/dsh-app/dsh-web.patch.yml:1-3`）。`/root/.dsh` 是否被 App 备份/保留 ⏳ —— 若不保留，装好的插件会在升级后消失，需要重新分发 |
| 现有 e2e 脚本 | `scripts/e2e-android.mjs:64` 检查的是 `com.dsharnessmobile.shell`（dsh-mobile），不是 dsh-go 的 `io.github.ccch1mneyyy.dsh_app` → 需要参数化包名/端口后才能用于 dsh-go（其余流程 `adb forward` + `/mesh/v1/health` 可直接复用，`:70-89`） |
| 基线仓库状态 | `npm run check` 在当前拷贝上**只**失败在 `check:docs`（缺 `docs/llms.txt`，published tarball 不带 docs）；`node scripts/sync-llms.mjs --write` 可离线修复（只复制 `llms.txt` → `docs/llms.txt`）。**不是代码回归** |

---

## 8. 建议的代码改动清单（按优先级）

> 约定：全部保持现有导出名（`lanIPv4Addresses`/`preferredAddress`/`candidateAddresses`）不变，避免牵动 `_selftest-*` 与 `index.js` 的 20+ 个调用点。

### P0 —— 不做就完全不可用

| # | 文件 | 改动点 | 验收方式（可执行） |
|---|---|---|---|
| P0-1 | **新增 `lib/netinfo.js`**（或重构 `discovery.js:84-113`） | ① `os.networkInterfaces()` 包 try/catch；② **UDP-connect 源地址兜底**（先网关、再 `8.8.8.8`，`dgram` connect 后 `address()`，绝不发包）；③ `advertiseAddress` 覆盖（最高优先级）；④ 返回值带 `source`；⑤ `preferredAddress()` 只从该 provider 取，任何情况不抛 | `node lib/_selftest-netinfo.mjs`：注入"interfaces 抛 EPERM" → 期望 UDP 兜底出 IP、不抛；注入"interfaces=[]" → 期望 UDP 或 `advertiseAddress`；注入"全失败" → 期望返回 `127.0.0.1` 且 `source:"none"` 并 emit diagnostic。另：本机 `node -e` 跑 `gap-probe.mjs` 的 §1/§4 对照 |
| P0-2 | `lib/discovery.js:84-113`、`:243`、`:303-304` | 改为从 `netinfo` 取地址；构造函数不再因地址失败而抛（`selfRecord()` 同样兜底） | 同上 + `npm run selftest`（67 项）保持全绿 |
| P0-3 | `lib/scan.js:19-45` | `lanIPv4Addresses()` 包 try/catch；保证 `extraRanges` 在枚举失败时仍生效；允许传入 `staticPeers` 显式地址 | `node -e` 探针（模拟 throw）→ `candidateAddresses(["192.168.1.0/24"]).length===254` |
| P0-4 | `lib/discovery.js:731-739`（+ 选项注入） | 新增 `staticPeers`：① 每轮 `#announce()` 额外 unicast 发送到 `staticPeers` 的 UDP 端口；② 新增 `probeStaticPeers()`（走 `scanForPeers({addresses, ports})`）供启动/周期调用 | `node lib/_selftest-discovery.mjs <name> <port>` 两实例（同机、私有组播组）；再加一例"`useMulticast:false` + staticPeers 指向对方 HTTP 端口"→ 仍能互见（新增自测） |
| P0-5 | `lib/index.js:209-351`（schema）+ `:816-832`（构造函数选项）+ `cordis.patch.yml` | 新增 `staticPeers`、`advertiseAddress`（并接到 `MeshDiscovery`）；`applyUnsafe` 里对 `new MeshDiscovery` 再包一层 try/catch（现在只有 `apply` 外层，失败会**整体停用插件**，至少让"网卡异常"降级成"仅静态对端+扫描"） | `node --check lib/index.js`、`node scripts/check-tdz.mjs`、`npm run selftest`；`grep -n staticPeers` 三处一致（schema/ctor/patch） |

### P1 —— 决定"看起来对不对"

| # | 文件 | 改动点 | 验收方式 |
|---|---|---|---|
| P1-1 | 新增 `lib/platform.js`（或并入 `osinfo.js`） | `detectRuntimeFacts()`：`androidKernel`（`/dev/__properties__` 或 `/system/build.prop`）、`proot`（`/opt/dsh-go` 或 `/etc/dsh-app`）、`osReleaseHasAndroid`；纯探测、不抛、可注入 fs | `node lib/_selftest-platform.mjs`：注入"有 /dev/__properties__"→androidKernel=true；注入只有 `-android` 内核串→true；普通 Linux→false |
| P1-2 | `lib/osinfo.js:132-153` | `linux && androidKernel` → `platform:"android"`（保留 `distro`/`version` 的 Ubuntu 信息，`desktop` 可填 `proot`）；`osInfo.name` 用 "Android" 或 "Android (Ubuntu 24.04.5)" | 扩展现有 `lib/_selftest-osinfo.mjs`（fixture 注入 platform:linux + 探测结果）→ 22 项 + 新用例全绿 |
| P1-3 | `lib/identity.js:92-100` | `androidKernel` 时**不要**用 `/etc/machine-id`（rootfs 里是空文件，且将来可能被镜像写死造成跨设备同指纹）→ 依次 `getprop ro.serialno/ro.boot.serialno`（走 `/system/bin/getprop`）→ 失败返回空（纯 UUID 降级） | `node lib/_selftest-identity` 类似的新用例：注入 androidKernel + machine-id 内容 → 期望不返回 `linux:` |
| P1-4 | `lib/tsnet/download.js:50-74`、`:83-86` | `detectTarget()` 支持 androidKernel→android 资产 + `sidecarPlatform` 覆盖；`binaryPath()` 按 os/arch 分目录；候选资产列表按优先顺序 | 扩展现有 `lib/_selftest-tsnet.mjs`（`:559-592` 已有平台夹具）→ 新增"platform=linux + androidKernel → `dsh-mesh-tsnet-android-arm64.gz`；path 含 android" |
| P1-5 | `lib/tsnet/manager.js:500-533` | spawn 前 `<binary> -version` 预检；主资产失败自动换 fallback 资产；把 `-version`/stderr 原话写进 status.diag | `node lib/_selftest-tsnet.mjs`（离线，已有 fake binary 套路）；真机 `-version` 命令见 §9 |
| P1-6 | `lib/discovery.js:377-412` | 组播 bind/join/收包做**可见化**：join 成功但 N 秒 0 包 → diagnostic；把 `multicastRecv` 状态暴露到 `/mesh/api/state` | `npm run selftest` + 诊断断言（新增纯函数测试） |

### P2 —— 体验与诊断

| # | 文件 | 改动点 | 验收方式 |
|---|---|---|---|
| P2-1 | `lib/index.js` 诊断/state | 暴露 `runtimeFacts`（androidKernel/proot/addressSource/multicastRecv/assetFlavor）到 `/mesh/api/state` 与 `/mesh/v1/diagnostics` | `node lib/_selftest-diagnostics.mjs` |
| P2-2 | `lib/index.js:985-1017` | dsh-go 下扫描节奏默认更省电（`scanConcurrency 32 / timeout 1200 / interval 120000`），但**必须在 patch 里显式写**（config 整体替换） | `npm run check` + `grep` |
| P2-3 | `client/client.js` + `package.json:121-134` | 去掉 `dsh.client.inject` 里不存在的 `dsh-client-ui-slots`/`-primitives`（或保留但加注释）；"打开对端 Web"在无 `window.androidBridge` 时给出明确提示 | `node lib/_selftest-client.mjs`（42 项）+ 真机 UI |
| P2-4 | `scripts/e2e-android.mjs` | 参数化包名（默认 `io.github.ccch1mneyyy.dsh_app`）+ 端口；保留 `adb forward` 流程 | `node scripts/e2e-android.mjs --expect-peer <desktop>`（真机） |
| P2-5 | `docs/` / `README` | 新增"dsh-go (proot) 部署与排障"一节；注明 `npm run check` 需要先 `node scripts/sync-llms.mjs --write` | `npm run check` 全绿 |

### P3 —— 可选增强

| # | 改动 | 价值 |
|---|---|---|
| P3-1 | `deriveScanRangeFromDns`（读 `/etc/resolv.conf` 私有 DNS 反推 /24） | 手机"零配置扫描" |
| P3-2 | 若 dsh-go 后续加 App 侧 API（暴露 LAN IP / MulticastLock），在 `dsh-go-bridge` 里加 `network` capability，mesh 优先用它 | 根治组播收包 |
| P3-3 | 把 `staticPeers` 支持做成 UI 表单（Mesh 设置页"连接与发现"） | 免手改 yml |

---

## 9. 需要 Lead 用真机实测确认的清单（每条给命令/期望）

> 前提：dsh-go 引擎已启动（Web 3080 可访问），在 dsh-go 的 agent 里跑 bash（proot 内），或 `adb forward tcp:3080 tcp:3080` 后用 DSH Web 的终端。先确保 mesh 装好（见 §7.3）。

### 9.1 平台事实（一次性，全部 5 条）

```bash
node -e 'const os=require("os");console.log(JSON.stringify({platform:process.platform,arch:process.arch,release:os.release(),host:os.hostname()}))'
ls -ld /dev/__properties__ /system/build.prop /system/bin/ip /system/bin/getprop 2>&1
cat /etc/resolv.conf; echo ---; cat /etc/machine-id | wc -c; ls /opt/dsh-go /etc/dsh-app 2>&1
node -e 'try{console.log(JSON.stringify(require("os").networkInterfaces()))}catch(e){console.log("THROW",e.code,e.message)}'
node -e 'const d=require("dgram").createSocket("udp4");d.connect(53,"192.168.1.1",()=>{console.log("udp-local",d.address());d.close()})'
```
期望/判据：
- `platform=linux`、`arch=arm64`、`release` 含 `-android`；（✅ 这是全部分析的前提）
- `/dev/__properties__` 存在 → androidbin 的 `onAndroid()` 为真；
- `/etc/resolv.conf` 非空（App 写）→ sidecar `ensureDNS()` 早退；
- `/etc/machine-id` 为 0 字节 → 指纹退化为空（预期）；
- **第 4 条**：若 `THROW ... EPERM/EPERM` → 确认 G1 成立（必须走 P0）；若正常返回 wlan0 IPv4 → G1 降级，但仍建议保留兜底；
- **第 5 条**：`udp-local` 应等于手机 LAN IP（验证 UDP-connect 兜底可用）。

### 9.2 组播收（G3 判定，最重要的实测）

1. 桌面 DSH（mesh 已启用，组播开）保持运行；
2. 手机 proot 内跑：
```bash
node -e 'const d=require("dgram").createSocket({type:"udp4",reuseAddr:true});let n=0;d.on("message",(b,r)=>{n++;console.log("recv",Date.now(),r.address,b.length)});d.on("error",e=>console.log("sockerr",e.message));d.bind(45892,()=>{try{d.addMembership("239.255.42.99")}catch(e){console.log("join-fail",e.message)}});setTimeout(()=>{console.log("TOTAL",n);process.exit(0)},20000)'
```
期望：20s 内 `recv` ≥3 次（桌面 5s 心跳）。**若 TOTAL=0 且 join 无报错 → 确认"multicast 收包被丢"，G3 成立**（记录 ROM/机型）。
3. 反向（手机发、桌面收）：手机 `node -e '...socket.send(JSON.stringify({app:"dsh-mesh",id:"probe",machine:"gap-probe",host:"1.2.3.4",port:45917}) ... 239.255.42.99:45892'`，桌面 `tail -f` 引擎日志/`GET /mesh/api/state` 看是否出现 `gap-probe`（桌面侧会以源地址登记）。这条决定"桌面能否发现手机"。

### 9.3 TCP 入站（G5/HTTP 可达性）

```bash
# 桌面执行（手机 IP 用 9.1 第 5 条拿到的）
curl -sS --max-time 3 http://<手机IP>:45917/mesh/v1/health
```
期望 200 + `"app":"dsh-mesh"`；失败 → 检查 AP isolation / 手机是否在后台/Doze。

### 9.4 tsnet sidecar exec（Q4 决定性）

1. 桌面下载两种资产（或从仓库 release 拿）→ 局域网 http 分发到手机；
2. 手机 proot 内（放到 `/root/.dsh/mesh/bin/sidecar-v1/`）：
```bash
chmod +x dsh-mesh-tsnet-linux-arm64 && ./dsh-mesh-tsnet-linux-arm64 -version; echo "linux-exit=$?"
chmod +x dsh-mesh-tsnet-android-arm64 && ./dsh-mesh-tsnet-android-arm64 -version; echo "android-exit=$?"
./dsh-mesh-tsnet-android-arm64 -hostname probe -dir /tmp/tsprobe -token x   # 看 30s 内是否 emit listening / 报 netlinkrib / controlC 错误
```
期望：两个 `-version` 都输出 `{"protocol":1,...}`（决定该选哪个资产）；启动探针用来确认 android 资产是否死在 controlC（若 android 资产起得来，P1-4/1-5 直接采用它）。
3. 同时确认 `-token` 控制 API 只监听 `127.0.0.1`（proot 无 netns，Node 可连）。

### 9.5 端到端最小验证（P0 改完后的验收）

1. 桌面 mesh：`machineName=desktop`，默认配置；手机 mesh：`machineName=phone`，`useMulticast:true` + `staticPeers:["<桌面IP>:45917"]`（P0 落地后）；
2. 手机 agent 调 `mesh_peers` → 应看到 desktop；桌面 `mesh_peers` → 应看到 phone（靠手机组播/unicast 公告）；
3. 桌面 `mesh_run(target=phone, task="…")` → 手机 `GET /mesh/v1/tasks` 应出现 `status: dispatched`；手机回派一次 → 桌面收到；
4. 证据：两边 `/mesh/api/state` 截图 + `mesh/v1/peers` JSON + 引擎日志。

### 9.6 安装/持久化

1. 用 DSH 插件市场安装 0.5.4（App patch 的 npmmirror fallback）→ 检查 profile `node_modules/dsh-plugin-mesh`、`node_modules/ssh2` 是否都在；
2. 重启引擎 → side 栏出现 Mesh；
3. 模拟 runtime 升级（或问 App 作者）：`/root/.dsh` 是否保留 ⏳（决定是否需要"一键重装"脚本）。

---

## 10. 本次已执行的离线验证与证据

### 10.1 离线测试（全部不联网）

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run check` | **仅 `check:docs` 失败**：`✗ docs/llms.txt 不存在`（version/TDZ/syntax/registry/loadable 全过） | 基线是 published tarball 拷贝，不带 `docs/`；修法 `node scripts/sync-llms.mjs --write`（离线）。**不是代码回归** |
| `npm run selftest`（`lib/_selftest-tsnet.mjs`） | **67 通过 / 0 失败**（含 Android 平台夹具、binaryInfo 不抛、start()→phase=error、http 源下载） | 纯逻辑 + 127.0.0.1 本地 http，无外网 |
| `node lib/_selftest-osinfo.mjs` | **22 通过 / 0 失败**（含 android getprop fixture） | 纯 fixture |
| `node lib/_selftest-discovery.mjs` | **未跑**：这是**双进程组播**测试（私有组 239.255.42.98:45893，`_selftest-discovery.mjs:7-18`），会碰网络 | 需要时由实现者在本机跑（不影响生产组） |
| `node lib/_selftest-reply-route.mjs` | 未跑；离线（127.0.0.1 HTTP + vm），命令 `node --experimental-vm-modules lib/_selftest-reply-route.mjs` | 改服务端/入站路由时的现成验收 |

### 10.2 行为探针（`E:\mesh\.tmp\gap-probe.mjs`，已跑）

- 本机（win32）：`networkInterfaces` 正常；`preferredAddress()=192.168.1.6`；`candidateAddresses([])=508`；
- **模拟 netlink EPERM**（`os.networkInterfaces` 抛 `uv_interface_addresses … Permission denied`）：
  `lanIPv4Addresses` / `preferredAddress` / `candidateAddresses([])` / `candidateAddresses(["192.168.1.0/24"])` / `new MeshDiscovery()` **全部 throw**；
- **模拟 interfaces=[]**：`preferredAddress()="127.0.0.1"`、`selfRecord().host="127.0.0.1"`、`candidateAddresses([])=0`；
- **UDP-connect 兜底**：`192.168.1.1:53` 与 `223.5.5.5:53` 都返回本机 `192.168.1.6`（证明该 API 在本机可用；Android 待实测）；
- `detectTarget()` 平台夹具：`platform=android` → `dsh-mesh-tsnet-android-amd64.gz`（映射存在）；dsh-go 的 `platform=linux` → 会得到 linux 资产（§4）。

### 10.3 dsh-go 运行时事实（从 APK/rootfs 解出）

- `runtime.json`：`dshVersion=0.2.1-rc.2`、`nodeVersion=24.22.1`、`prootVersion=5.1.107.98`、`ubuntuVersion=24.04.5`、`dshGoBridge=0.4.0`；
- rootfs `/etc/machine-id` = **0 字节**；`/etc/resolv.conf` 默认含 DNS 注释 + 3 个 nameserver（App 每次启动重写；`dsh.log` 里的 `result=written ns1=192.168.1.1,…` 来自 MuMu 那次运行，真机值 ⏳）；
- rootfs 内**没有** `ip/ifconfig/busybox/getprop`（在 proot 里只能通过 `/system/bin/*` 调 Android 侧的）；
- rootfs 里 `/root/.dsh/` 已预置（空）；
- DSH 0.2.1-rc.2 的 host 侧包齐全：`dsh-agent-preset`、`dsh-permission-presets`、`dsh-workspace`、`dsh-session-title`、`dsh-host-webserver`、`dsh-tools`、`dsh-brand`、`schemastery` 等（tar 清单）。

### 10.4 dsh-go 客户端包核对（`E:\mesh\.tmp\clientcheck`）

`sidebar.panellist` / `main` / `sidebarRight` / `uiWorkspace` / `layout` / `slots` 全部存在于 0.2.1-rc.2（§6.2 行号）；`dsh-client-ui-slots` / `dsh-client-ui-primitives` 在 dsh-go rootfs 与桌面 asar（同为 `@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.2`）中**都不存在**。

### 10.5 dsh-go APK manifest（`E:\mesh\.tmp\apk-manifest.mjs`）

权限：`INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `WAKE_LOCK`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `POST_NOTIFICATIONS`, `MANAGE_EXTERNAL_STORAGE`, `READ/WRITE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO`, `BIND_ACCESSIBILITY_SERVICE`, `BIND_QUICK_SETTINGS_TILE`, `DUMP`, `INTERACT_ACROSS_USERS_FULL`, `REQUEST_INSTALL_PACKAGES`。
**没有** `CHANGE_WIFI_MULTICAST_STATE`、`ACCESS_WIFI_STATE`、`CHANGE_WIFI_STATE`、`NEARBY_WIFI_DEVICES` → 无法申请 `MulticastLock`、读不到 Wi-Fi 信息（§3.2）。

### 10.6 上游依据（外部）

- tailscale v1.104.1（`sidecar/go.mod:5`）`feature/androidbin/androidbin.go`：`onAndroid()` = `runtime.GOOS=="android" || stat("/dev/__properties__")==nil`；fallback 用 UDP connect 源地址合成网卡；`cacerts.go` 设 `SSL_CERT_DIR=/system/etc/security/cacerts`（https://github.com/tailscale/tailscale/blob/v1.104.1/feature/androidbin/androidbin.go 、`.../cacerts.go`）。

---

## 附录 A：关键事实来源索引

| 事实 | 来源 |
|---|---|
| proot 启动参数（`-b /dev /proc /sys /system /apex`）、`--host 127.0.0.1 --port 3080`、`DSH_HOME=/root/.dsh`、`TMPDIR=/tmp` | `E:\mesh\analysis\00-CONTEXT.md:19-24`；`E:\mesh\.tmp\dshgo-logs\dsh.log`（`launching … libproot.so …`） |
| MuMu(x86) 不能跑 proot | `00-CONTEXT.md:26-28` |
| Termux 真机：netlink/`/proc/net` EACCES、`netinkrib: permission denied`、argv 错位、TLS 对齐、DNS | `README.md:147-269`、`sidecar/androidbin_linux.go:5-33`、`sidecar/androidnet_linux.go:405-412` |
| android 资产构建方式（PIE+linker64、GOOS=android、形状校验） | `scripts/build-sidecar.sh:113-157`、`:189-242`、`README.md:96-104` |
| Android/Termux 需要电池白名单、组播/省电影响 | `README.md:115-142` |
| 国内下载源现实（github/镜像全挂，需局域网 http） | `README.md:829-847`、`lib/tsnet/download.js:38-43` |
| 插件约束（探测失败不得伪装成事实、config 整体替换、schema 默认不够） | `dsh-plugin-mesh/AGENTS.md` §3.1/§3.3/§3.4 |
| 「no /tmp on Android」只适用于 Termux，不适用于 dsh-go（rootfs 有可写 /tmp） | `AGENTS.md` §7 vs `dsh.log` 的 `TMPDIR=/tmp` + 启动写 `/tmp/dsh-web.pid` |

## 附录 B：未决问题（需 App 侧或真机回答）

1. dsh-go 的 `/dev/__properties__` 是否真的可 stat（Kernel/SELinux 差异）→ 影响 androidbin 是否生效、`androidnet` 是否接管 DNS。
2. proot 能否 exec 带 `PT_INTERP=/system/bin/linker64` 的纯 Go PIE（决定 sidecar 选 android 还是 linux 资产）。
3. 手机收组播的实际丢包率（本报告判"基本收不到"，需 §9.2 实测确认）。
4. App 的运行时升级是否保留 `/root/.dsh`（决定插件持久性）。
5. dsh-go island 模式是否遮蔽 `main` 槽里的第三方面板（影响 Mesh 面板可见性）。
6. dsh-go 的 WebView 是否给 mesh UI 注入可用的外链打开方式（`window.open` 行为）。
