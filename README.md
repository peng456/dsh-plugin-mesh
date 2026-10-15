# dsh-plugin-mesh

DSH 的 Mesh 插件：**启动后自动发现同一网段的其他 DSH 实例**，在侧栏提供一个
操作页面显示各机器的在线状态，并支持把任务派给对端的 agent 执行。
**不在同一网段也行** —— 内置用户态 Tailscale 节点，可跨互联网自组网，功能同级。

用起来就是你要的那个效果：在 A 机器上开发，把「部署到 B」这件事丢给 agent，
你只下大命令。

**零配置**：固定端口 + 自动扫描 + ping，装上就能发现彼此，**不需要配对码**。
首次打开 Mesh 页面会让你给这台机器起个名字（默认填主机名），别的机器就靠这个名字找你。
跨互联网只要在界面上填一次 Tailscale 授权码，**不需要装 Go、不需要装 Tailscale 客户端**。

```
┌──────── A 机器 (DSH) ────────┐          ┌──────── B 机器 (DSH) ────────┐
│  mesh 插件  :45917            │          │  mesh 插件  :45917            │
│   ├ UDP 组播心跳  ◀───────────┼──────────┼──▶  被动发现                  │
│   ├ 主动扫本网段  ────────────┼──────────┼──▶  兜底发现                  │
│   ├ ping 保活     ────────────┼──────────┼──▶  在线状态                  │
│   └ 侧栏 Mesh 页面            │          │                              │
│                               │───任务──▶│  唤醒本机 agent 执行          │
│                               │◀──回派───┤                              │
└───────────────────────────────┘          └──────────────────────────────┘
```

---

## 发现机制：两条互补的路

只靠组播是不够的 —— **很多路由器/AP 会隔离客户端组播，Windows 防火墙默认也拦入站组播**。
所以这里同时用两条路，任一条通就能发现：

| 路径 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **组播心跳** | 每 5s 向 `239.255.42.99:45892` 广播，同时监听 | 零配置、即时、不产生额外连接 | 可能被路由器/防火墙挡掉 |
| **主动扫描** | 并发 GET 本网段每台机器的 `:45917/mesh/v1/health` | 只要 TCP 通就能成，最可靠 | 扫一次约 1~2 秒；254 个地址 |

再加一条**ping 保活**：每 10s GET 已知对端的 `/mesh/v1/health`，刷新在线状态。
这条让"发现"一旦建立就不再依赖组播 —— 即使组播完全不通，扫描见过一次之后也能一直维持。

扫描时机：**启动时**（带退避重试，因为常抢在对方启动之前）+ **每 60s** 一次 + UI 上手动触发。

**默认端口 45917**。固定端口是"扫一下就能连上"的前提。同机跑多个实例时端口会被占用，
此时自动退回随机端口（组播仍能找到，但主动扫描扫不到它）。

#### ⚠️ 45917 和"UI 面端口"是两回事，排查时别混

实测的**绑定范围**（这才是能不能从别的机器读到的唯一决定因素）：

| 端口 | 绑定 | 谁能读 |
| --- | --- | --- |
| `45917`（mesh 口） | `*:45917`（全网卡） | **局域网内任意机器** —— `/mesh/v1/health`（免鉴权）、`/mesh/v1/peers`（需配对） |
| DSH 的 Web/GUI 端口（这台的 Mac 是 `43120`，Android 对端是 `3080`） | `127.0.0.1:<端口>`（**仅 loopback**） | 只有本机。`/mesh/api/state` 挂在这上面，**跨机一定读不到** |

> 已在 **macOS 与 Android 两个独立平台**实测同构（不是某个平台的特性）：
> `127.0.0.1:<GUI端口>/mesh/api/state` → 200，`<LAN IP>:<GUI端口>/...` → 连不上；
> 而 `<LAN IP>:45917/mesh/v1/health` → 200。GUI 端口各平台不同（loopback-only 相同）。

所以：

- 想从 A 读 B 的**版本/能力** → `GET http://<B-ip>:45917/mesh/v1/health`。
- `GET /mesh/api/state` **只能读自己**：它的 `peers[]` 里是**别人**的投影，
  而**不含本机**（`discovery.peers()` 只投影 `#peers`，且 upsert 显式丢弃
  `id === this.#id`）。读本机的 version 要看 `state.self` 或直接打 `/mesh/v1/health`。
- 跨机排查时**不要**把 GUI 端口写进任何文档或脚本 —— 它在对端一定是不通的，
  而失败现象（连接超时/拒绝）看起来像"对端没开服务"，很容易误诊。
- **受限环境下本机 socket 表可能根本读不到**（Android 无 root：`ss` 报
  `netlink socket: Permission denied`、`netstat` 不支持 AF_INET、`/proc/net/tcp`
  也 denied）。这时**别据"读不到"下结论** —— 只能靠**功能判据**：
  `192.168.x.x:<mesh端口>/mesh/v1/health` 通 → 对外可服务；
  同一 IP 的 GUI 端口不通 → 证实它 loopback-only。
  "本机看不到 socket 表" + "跨机读 GUI 面失败" 两者叠加，现象与"对端没开服务"
  **完全一样** —— 这正是最容易误诊的组合，必须用双向探测把两者分开。

> 这组区分是踩出来的：跨机验证重启时用 `/mesh/api/state` 会拿到 403/连不上，
> 用 `/mesh/v1/health` 才拿得到对端自述的 `version`（判断"进程是否已重启"的
> **唯一**可靠字段 —— `capabilities` 每轮定时重采，不反映进程版本）。

#### ⚠️ 重启日志里的三行，**没有一行**能证明"新代码在跑"

`scripts/restart-dsh.sh` 重启后会打三行自检。实测这三行各自的证据强度是：

| 日志行 | 实际读的是什么 | 能证明什么 |
| --- | --- | --- |
| `[OK] 已重启：pid X → Y` | 进程表 | 有个进程起来了 —— **不**证明它加载了新代码 |
| `[OK] 新代码已生效（instanceIds）` | `grep` **落盘**的 `state.json` | 几乎什么都不能证明：该字段是**持久化**的，上一版写进去之后一直留在文件里，所以这里**恒真** |
| `磁盘上的插件版本 v`（原写作"已安装插件版本"） | 读**磁盘**上 `package.json` | 磁盘是什么版本 —— 与进程**无关** |

踩过：升级窗口里磁盘 `16:11:06` 就已是 0.3.28，进程 `16:14:06` 才换。那三分钟里
上面几行**全是绿的**，但跑的还是旧代码。`VERSION` 是**启动时冻结**的常量，所以
只有**进程自述**才是硬证据 —— 而它只有 `/mesh/v1/health` 给得出。

现在脚本最后会真的去问进程：

```bash
curl -fsS --max-time 3 http://127.0.0.1:45917/mesh/v1/health   # 取 .version
# 进程版本 ≠ 磁盘版本 → [WARN] 新代码**没**被加载，检查 plugins 挂载
```

（不依赖 `node`：优先 `python3` 解 JSON，退回到正则抠 `version` 字段。）

##### ⚠️ 只许比 `version`；两条轴**互补，缺一不可**

**① 绝不能把 `capabilities` 拉进这个比对"求更严"。**
能力块（`gpu` / `runtimes` / `capabilitiesAt`）是**热刷新**的，与重启完全解耦：
实测同一个 pid 在不重启的情况下 `capabilitiesAt` 一路前进，而 `version` 纹丝不动。
把能力字段纳入比对会造成**反向误诊**。对端给过的反例：它进程是 0.3.27 旧码，
但"磁盘代码采出的 `gpu`"与"进程报的 `gpu`"**都是 `null`**，两者相等 → 检查会
误判成"新码已加载"。**能力相等什么都证明不了。**

**② 两条轴管的是不同的失败**：

| 轴 | 时机 | 兜住的失败 | 工具 |
| --- | --- | --- | --- |
| ① 可加载性 | 重启**前** | **半加载**：`index.js`/`package.json` 已是新版，但新 import 的文件没拷全 → 重启即崩 | `check-loadable.mjs`（真 import 一次入口） |
| ② 进程自述版本 | 重启**后** | **加载了但没重启**：磁盘换了、进程还是旧码 | `/mesh/v1/health` 的 `.version` |

`version` 检查**覆盖不到半加载**：那种情况下它读到的是**新**版本号（常量来自
`index.js`，而 `index.js` 已经换过了），于是**正确地**报新版本、检查**放行**，
可进程 import 时直接 `ERR_MODULE_NOT_FOUND` 崩。
所以只做 ② 会漏半加载，只做 ① 会漏"加载了但没重启"。

### 组播的作用范围：比"局域网"更窄

`239.255.42.99:45892` 是我在私有组播段里挑的（`239.0.0.0/8` 是 RFC 2365 定义的
管理范围，相当于组播里的"私有地址"），**TTL 设为 1**，所以：

- ✅ 同一网段（同一个二层广播域）内有效
- ❌ **路由器不转发** —— 跨子网/VLAN 到不了，那种情况要配 `scanRanges`
- ❌ **AP isolation 会连它一起挡**（那是把客户端之间的所有流量都隔离，不只是组播）
- ⚠️ 部分交换机的 IGMP snooping 在没有 querier 时会丢掉组播
- ⚠️ Windows 防火墙默认拦入站组播，要放行 UDP 45892

正因为组播有这么多坑，才加了扫描那条路：**只要 TCP 通，扫描就能发现**。

---

## 互联网自组网（Tailscale / tsnet）

局域网那套跨互联网时不成立：没有组播，也没有可扫的网段。所以插件内置了一个
**用户态 Tailscale 节点**，把发现与派发延伸到互联网，**功能与局域网完全同级** ——
tailnet 上找到的机器和局域网找到的机器出现在同一个列表里，`mesh_run` 用法一模一样。

### 终端用户零依赖

不需要装 Go，也不需要装 Tailscale 客户端。插件首次启用时按平台下载一个预编译的
sidecar 二进制（约 9MB gzip），缓存在 `~/.dsh/mesh/bin/`。

为什么必须自己编译：`tsnet` 是 Go 库（`tailscale.com/tsnet`），npm 上没有可用的绑定
（实测 `tsnet` 包是个无描述无仓库的空壳，`tailscale` 包是占位符）。所以由
`scripts/build-sidecar.sh` 交叉编译各平台产物，随 GitHub Release 发布。

**已发布的平台：**

| 平台 | 适用 | ELF 形态 |
|---|---|---|
| `darwin/amd64` | Intel Mac | Mach-O |
| `darwin/arm64` | Apple Silicon Mac | Mach-O |
| `windows/amd64` | Windows | PE |
| `linux/amd64` | Linux x86_64、WSL | 全静态 ET_EXEC |
| `linux/arm64` | ARM64 Linux、树莓派 | 全静态 ET_EXEC |
| `android/amd64` | x86_64 Android / 模拟器上的 Termux | **PIE(ET_DYN) + `/system/bin/linker64`** |
| `android/arm64` | aarch64 Android / 手机上的 Termux | **PIE(ET_DYN) + `/system/bin/linker64`** |

> **Android 是独立平台，不是 linux 的别名**（真机实测，2026-10）。
>
> 第一层坑是平台识别：Node 在 Termux 下 `process.platform` 返回的是 **`android`**，
> 不是 `linux`。早期 `detectTarget()` 只认 darwin/win32/linux，于是抛
> 「不支持的系统：android」。这个抛发生在 `binaryInfo()→binaryPath()` 里，而
> `binaryInfo()` 又被 `TsnetNode.status() → /mesh/api/state` 一路调用，于是**整个
> Mesh 页面变成 500**，表现为「本机 undefined · undefined:undefined」且互联网组网
> 卡片消失。这也是为什么 `binaryInfo()` 被改成绝不抛异常。

### ⚠️ Android 端必须手动加白名单，否则会被系统杀掉

**实测结论，不是猜测。** 一台 Android 设备：`up 7 days`、`MemAvailable 2.6 GB`、
`load average 0.00` —— 设备和内存都好好的，但它的 sidecar 进程 `etime` 只有
**2 分钟**。DSH 进程在反复被重建。

**不是 OOM，是 Android 的省电策略在主动冻结/杀掉后台 App。** 对 mesh 的后果：

| 机制 | 触发条件 | 后果 |
|---|---|---|
| **Doze（打盹）** | 屏幕关闭一段时间、未充电、未移动 | 暂停后台**网络访问**与定时任务 → 心跳发不出、ping 收不到，对端看它就像掉线 |
| **App Standby** | App 长期未被使用 | 同上，限制更严 |
| **厂商后台清理** | 小米 / 华为 / OPPO / vivo 自有策略 | **直接杀进程**，比原生激进得多 → 会话被中途打断 |

> 会话被打断**不算故障**：manager 会走"原会话已结束 → 新建会话并重绑同一会话键"
> 这条路径（见 `设备身份与多通道设计.md`）。只是调试噪声变多 —— 同一个会话键
> 可能先后绑定过几个 session。

**必须手动加白名单**，路径因厂商而异：

| 厂商 | 设置路径 |
|---|---|
| 原生 Android | 设置 → 应用 → DSH → 电池 → **不受限制** |
| 小米 / Redmi | 设置 → 应用设置 → 应用管理 → DSH → 省电策略 → **无限制**；再到「自启动」打开；最近任务里长按卡片**加锁**（防一键清理） |
| 华为 / 荣耀 | 设置 → 电池 → 启动管理 → DSH → 关掉「自动管理」→ 手动勾选 **允许自启动 / 关联启动 / 后台活动** |
| OPPO / vivo / 一加 | 设置里找「允许后台运行」「自启动」「电池优化白名单」 |

代价是多耗一点电；长期插电或常驻在线的设备几乎无感。

> 注意：**持久化 instanceId 已经让"重启"不再产生重名**（见「身份与命名」），
> 所以白名单要解决的是**会话连续性**，不是重名。
>
> 第二层坑更隐蔽：当时把 `android` 映射到 `linux` 资产就以为完事了，但 Android 从
> 5.0 起**只允许 PIE 可执行文件**，而给桌面准备的是全静态 `ET_EXEC`，真机 exec
> 阶段会被 bionic 直接拒掉，原话就一句（下载、解压、sha256 全部正常，一跑就退）：
>
> ```
> error: "/data/data/com.termux/files/home/.dsh/mesh/bin/sidecar-v1/dsh-mesh-tsnet" has unexpected e_type: 2
> ```
>
> 与 glibc/bionic、`CGO_ENABLED=0` 与否、权限、防火墙都无关，**就是 ELF 类型不对**。
> 所以 `android/*` 单独出一份产物：`-buildmode=pie` 拿到 `ET_DYN`，再用
> `-ldflags=-I /system/bin/linker64` 把解释器指到 bionic。
>
> 只加 `-buildmode=pie` **不够**：Go（实测 go1.25.5）内部链接器产的 linux/arm64 PIE
> 带 `PT_INTERP=/lib/ld-linux-aarch64.so.1`，这个路径在 Android 上不存在，内核会以
> ENOENT 收场。必须显式改解释器路径。好在纯 Go 的 PIE 里 `DT_NEEDED` 为空、动态
> 符号表无未定义符号、重定位全是 `R_AARCH64_RELATIVE`（实测 113089 条），bionic
> 加载时只需刷一遍相对重定位，不依赖任何 libc —— 正是 Android 自家 PIE 的形态。
>
> 桌面 `linux/*` 则**刻意保持全静态 ET_EXEC**：给它加 PIE 会把解释器钉成
> `/lib64/ld-linux-x86-64.so.2`，Alpine 这类 musl 发行版没有该路径，等于用一点
> 安全加固换掉一整类系统。构建脚本里对 android 产物有硬校验（ET_DYN + 解释器 +
> TLS 对齐，任一不满足就直接拒绝发布），免得这些坑再溜出去。
>
> 第三层坑是 **TLS 段对齐**。Go 的**内部链接器**产 PIE 时把 `PT_TLS` 的 `p_align`
> 硬编码成寄存器宽度（`cmd/link/internal/ld/elf.go`: `ph.Align = ctxt.Arch.RegSize`，
> arm64 上是 8），而 ARM64 bionic 要求 ≥64：
>
> ```
> error: "…/dsh-mesh-tsnet": executable's TLS segment is underaligned:
>        alignment is 8, needs to be at least 64 for ARM64 Bionic
> ```
>
> 外部链接器（NDK 的 lld）会按符号对齐算这个值，用内部链接器就得自己补，所以
> `scripts/fix-android-tls-align.py` 在编译后把 `p_align` 抬到 64（x86_64 抬到 16）。
> 这是安全的：TLS 块按 variant II 布局、**块尾贴着线程指针**，`p_align` 只影响块起点
> 留多少填充，符号相对块尾的偏移不变，Go 运行时算出来的地址一样。
>
> 第四层坑是 **argv 错位**。Android/Termux 上 exec 经常经 `/system/bin/linker64`
> 转发（`linker64 <程序> -hostname …`，这就是为什么一个**没有** `PT_INTERP` 的静态
> `ET_EXEC` 也会收到 bionic 的报错 —— 内核根本不会去调 bionic）。bionic 只在
> `__libc_init` 里把 `linker64 <程序>` 这两段摘掉，而**纯 Go 程序从不调用
> `__libc_init`**：它直接按内核初始栈读 argc/argv，于是 `os.Args[1]` 是程序路径。
> `flag.Parse()` 一遇到非选项就停止解析，**后面所有开关被静默丢掉**，看起来像
> "收不到任何参数"（`-version` 和故意写错的 `-zzz` 得到同一句报错；对照组 node/bash
> 正常，因为它们是 C 程序、走 `__libc_init`）。所以 `sidecar/main.go` 的
> `normalizeArgs()` 在 `flag.Parse()` 前把第一个以 `-` 开头的元素之前的东西丢掉。
>
> 第四层坑是 **Android 不给 netlink**。修好前两层后 sidecar 能启动了，但死在 tsnet
> 自己的启动阶段：
>
> ```
> {"event":"error","message":"tsnet: route ip+net: netlinkrib: permission denied","where":"start"}
> ```
>
> Android 对 app UID（untrusted_app）关掉了 `NETLINK_ROUTE` 与 `/proc/net`（同一身份下
> `/proc/net/route`、`/proc/net/if_inet6` 都是 EACCES，而 bionic 的 `getifaddrs` 正常），
> 而 Go 标准库的 `net.Interfaces()` 在 linux（android 也算 linux）上一律走 netlink，
> 于是 `netmon.New()` 直接失败。Tailscale 源码里对这件事有原话（`net/netmon/state.go`）：
> "It exists because Android SDK 30 no longer permits Go's net.Interfaces to work"。
> 官方 Android app 靠 Java 注册接口表，**裸二进制没有 Java 可依赖**，所以官方提供了
> `tailscale.com/feature/androidbin`（包注释第一句就是"makes Tailscale binaries work
> when run as raw (non-GUI app) executables on Android, such as under Termux"）：
> 注册 netmon 的接口回退（合成一个 `android` 接口，地址靠向内核要一条出站 UDP 路由拿
> 源地址，不发包）、拉进 `androiddns`、并把 CA 根证书指到
> `/system/etc/security/cacerts`。最后这条是我们还没走到但一定会踩的坑：**GOOS=linux
> 的二进制在 Android 上系统证书池是空的，控制面 TLS 会全挂**。
> tsnet 默认不引入它（"tsnet apps and other programs opt in with a blank import"），
> 所以 sidecar 加了 `sidecar/androidbin_linux.go`（必须带 `linux` 构建约束，否则
> mac/win 构建会报 "build constraints exclude all Go files"）。它在普通 Linux 上是
> 空操作（`onAndroid()` 为假）。
>
> 顺带说明为什么**不**改成 `GOOS=android`：`androidbin` 官方就支持 `GOOS=linux` 形态
> （"static linux binaries are commonly run under Android kernels"），而我们的
> `GOOS=linux` 产物已在真机上实测能加载、能解析参数；换 GOOS 会同时动掉运行时这一层，
> 收益不明。
>
> 第五层坑是 **DNS**。前四层修完后 sidecar 能起来、控制 API 可用，但节点一直停在
> `NeedsLogin`、`authUrl` 为空。原因：Android 没有 `/etc/resolv.conf`，Go 的纯 Go
> 解析器读不到配置就回退到 `127.0.0.1:53`（没人在听），于是每个查询都失败；而
> `curl` 走的是 bionic 的 `getaddrinfo`（经 netd），所以"网络明明是通的"。
> tailscale 的 `dnsfallback`（控制面解析兜底）走 DoH 打 `dns.google`/quad9，
> 在国内多半也不通，最后就表现为"控制面怎么都连不上"。
>
> tailscale 为此提供了 `feature/androiddns`（androidbin 会自动拉进来）：它**不读系统
> 属性**，而是直接跟 netd 的 `/dev/socket/dnsproxyd` 说协议 —— 和 bionic 的
> `getaddrinfo` 同一条路。它更好（顺带拿到 per-network 配置与 Private DNS），
> 所以它接管了就不动。但它的前提是 `dnsproxyd` 连得上，连不上时它**静默什么都不做**。
>
> 于是 `sidecar/androidnet_linux.go` 补三件事：① 自检 —— 先解析
> `controlplane.tailscale.com`（建链最需要的那个名字），结果写进 `/status` 的 `diag`；
> ② 兜底 —— 解析失败时**扫系统属性**找 DNS（刻意不只看 `net.dns1..4`：实测那台华为
> ROM 上它们全空，只有 `net.rmnet0.dns1` 有值，所以按"键以 `dnsN` 结尾"匹配）；
> ③ 再兜底 —— 属性里的都不通就用公共解析器（223.5.5.5 / 119.29.29.29 / …）。
>
> **候选集要逐个自检着换，不能在 `Dial` 里轮询**：UDP "连接"一台不可达的服务器不会
> 失败（只会让查询超时），`Dial` 永远返回第一个候选、后面的根本轮不到。自检本身跑在
> "控制 API 已监听之后、`srv.Up()` 之前"，所以不会拖慢握手。
>
> 注意：`androiddns` **不读系统属性**，它走 `/dev/socket/dnsproxyd`（与 bionic 的
> `getaddrinfo` 同一条路）。二进制里 `net.dns*` 那些串是 Go 运行时的符号名
> （`net.dnsReadConfig`、`net.dnsStreamRoundTrip`…），跟 Android 属性无关。
>
> **真正的坑在解析器对象上**（真机日志定位）：tailscale 的控制面解析**不走
> `net.DefaultResolver`** —— controlclient 用的是 `net/dnscache` 的 `Forward`，而
> `dnscache` 在**包初始化时自己 new 了一个** `&net.Resolver{PreferGo: …}`
> （`dnscache.go` 的 `single`），和 `net.DefaultResolver` 是两个对象。于是无论
> `androiddns` 还是我们，只要改的是 `net.DefaultResolver`，控制面就一点没沾上：
> 自检（走 `net.DefaultResolver`）通过，`TryLogin`（走 `dnscache.Forward`）却报
> `failed to resolve "controlplane.tailscale.com"`，随后退到 DERP bootstrap
> （裸 IP，被出口代理挡掉）→ 节点永远 `NeedsLogin`。
>
> 所以 `applyResolver()` 把 dial **原地**装到两个解析器上（`net.DefaultResolver`
> 与 `dnscache.Get().Forward`，后者是导出字段），而自检也改成打在
> `controlResolver()`（即控制面真正用的那个）上 —— 否则就是自欺欺人。
> 另外**只能原地改字段、不能替换 `net.DefaultResolver` 指针**：有代码在 init 时
> 就把那个指针存下来了，替换指针它们看不到。
>
> **安装时机同样致命**：`ensureDNS()` 必须早于任何可能启动 tsnet 的代码。真机
> diag 的先后顺序是 `[52] StartLoginInteractiveAs` → `[61] trying bootstrapDNS`
> → `[62] dns: …`，即第一次 `TryLogin` 已经失败，我们才装好解析器。原因是
> `watchStatus` 每秒调 `currentStatus()`，而它调 `srv.LocalClient()` ——
> tsnet 的 `LocalClient()` 内部就调 `s.Start()`，整套后端（含第一次登录）会在
> 一秒内起来。等装好时早已退到 DERP 裸 IP 的 bootstrap，在那台机器"按域名放行"
> 的出口代理下必然全灭。现在 `ensureDNS()` 在 `sc` 建好之后立刻执行，位于
> `go sc.watchStatus(ctx)` 之前；`srv.Up()` 之前还会再打一行 `dnsUpCheck()` 复查
> 控制面解析器的 `Dial` 状态与自检结果，下次一眼能看出有没有抢跑。
>
> 顺带把 tsnet 的日志口径放宽了：原来只放 `tsnet: ` 前缀且含 error/fail/warning 的行，
> 结果 DNS 卡住时 stdout 上一行线索都没有、只能靠 `/status` 猜。现在**全部**进 `diag`
> （容量 40→200 行），其中建链关键路径（control/dns/login/auth/derp/magicsock）实时推
> 到 stdout。
>
> 另外两件诊断工具（0.3.9 起）：`dnscache.SetDebugLoggingEnabled(true)` 会把
> tailscale 自己的 dnscache 决策日志（"using fallback resolver due to error/no returned
> IPs"、"not using bootstrap DNS: DNS was trustworthy"）经 tsnet 的 Logf 流进 `diag`；
> `probeControlPlane()` 异步复刻"解析(`ip`/`ip4`) → 逐地址直连 :443 → TLS(SNI=域名)
> → GET /key?v=148"整条链，每步单独记一行。这样下次就能一锤定音地分清是解析失败、
> 连接失败还是 TLS 失败 —— 前几轮只能看到"退到 DERP 裸 IP"，分不清这三者。
>
> 0.3.10 起再加一道**真正的兜底**：`feature/dnsresolvecache`。这是 tailscale 为
> "开机时 DNS 坏掉"设计的机制（dnscache 在**主解析失败或返回空**时会去读
> `<dir>/dns-<host>.json`），但官方明说 tsnet 默认不链接它、"tsnet apps must both
> blank-import this package and configure the cache directory themselves"。所以
> sidecar 现在 blank import 它、用 `dnscache.HookSetCacheDir` 把目录指到
> `<stateDir>/dnscache`，并在自检通过后把我们自己解析出来的
> `controlplane.tailscale.com` 写进 `dns-controlplane.tailscale.com.json`。
> 这样即使控制面的主解析再出问题，它也能从落盘缓存拿到 IP，不必退回 DERP bootstrap。
> 自己写这份文件是安全的：里面只是本进程刚解析并自检通过的 IP，连接时的证书校验
> 照旧（最坏情况与今天一样连不上）。格式已用 tailscale 自己的读入口
> （`dnscache.HookLookupDiskCache`）在本机验证过。
>
> **最后一跳的根因（0.3.11）**：`tailscale/net/netns` 的 linux 与 android 实现是
> 两个文件 —— `netns_linux.go` 的约束是 `linux && !android`，`netns_android.go`
> 是 `android`。GOOS=linux 编出来的产物走 linux 版 `controlC`：它对每个 socket 调
> `netmon.DefaultRouteInterface()` 拿默认路由接口名，而 Android 上 `/proc/net/route`
> 与 netlink 都是 EACCES，于是退化去绑 `"lo"`（或设 SO_MARK），**拨号因此出不去**。
> 真机判据很干净：sidecar 内部用裸 `net.Dialer` 直连 `192.200.0.x:443` 成功、完整
> HTTPS 拿到 200，而 tailscale 自己的拨号路径全灭 —— 两者唯一的差别就是这个
> `Control` 钩子。`netns_android.go` 的 `controlC` 在没有 Java 回调时**什么都不做**，
> 所以 android 资产改成 `GOOS=android` 编译（`CGO_ENABLED=0` 即可，不需要 NDK）：
> 顺带把 netmon 换成 android 的 polling 实现、x509 走 `goos.IsAndroid` 分支读
> `/system/etc/security/cacerts`，而且该构建不发 `PT_TLS` 段，TLS 对齐那个坑也消失。
>
> 只堵平台映射还不够：`#spawnOwn()` 的第一行 `binaryInfo()/looksExecutable()` 在任何
> `try` 之外，而 `start()` 是**先把 phase 置成 `"starting"` 才调它** —— 异常 reject 到
> 调用方只留一条 warning，phase 就永远停在 `"starting"`，页面显示「正在组网中」永不结束
> （真机实测：`POST /mesh/api/tsnet/start` 返回 `{"ok":false,...,"node":{"phase":"starting"}}`）。
> 所以 `start()` 与 `#spawnOwn()` 各自再兜一层：任何早期失败都先落 `phase:"error"` 再抛。
> 自动重启路径（`#onExit` 的退避重试）直接调 `#spawnOwn()`、不经过 `start()`，这层兜底是它唯一的保障。
>
> 另外 `#spawnOwnInner()` 现在**无条件**调 `ensureBinary()`：只有它知道
> `PINNED_CHECKSUMS` 变没变（比对解压时旁挂的 `source-sha256` 标记）。原先外面套了
> `!installed || !looksExecutable()`，于是 sidecar 重新发布时那一步永远走不到，
> 老装置会一直复用旧二进制，**只有手动删缓存才会下载**（真机实测踩到）。

补新平台只要跑一次 `scripts/build-sidecar.sh --targets ... --publish`。

构建戳取的是 **sidecar 源码的 git 提交哈希**，而不是时间戳。因为 Go 构建是可复现的
（实测同输入连编两次逐字节相同），所以未改动的平台重编后 sha256 不变，**补新平台
不会让已装的机器白重下 8.5MB**；用时间戳则每次发版全平台哈希都变。

### 为什么是"用户态"节点

tsnet 不建 TUN 设备、不要 root、也不碰系统上装的 Tailscale，它跑在自己的用户态
网络栈里。代价是**宿主机路由不到 `100.x.y.z`**，所以 sidecar 必须在两个方向都代理：

```
入站：tailnet :45917 ──反代──▶ 127.0.0.1:45917   （并注入 X-Forwarded-For）
出站：插件 ──/__tsnet/fetch──▶ sidecar 用 tailnet 拨号
```

这也是 `discovery.js` 里对端记录多一个 `transport` 字段的原因：tailnet 对端自述的
`host` 是它的**局域网** IP，跨互联网不可达，必须被实际观察到的 tailnet IP 覆盖。

### 整机一个节点

每个 sidecar 就是 tailnet 里的一个设备，所以**一台机器只有一个节点**。同机的多个
DSH profile 通过 `~/.dsh/mesh/tsnet/rendezvous.json` 复用同一个 sidecar，不会重复
占用设备名额（免费版上限 100 台）。

### 用法

侧栏 Mesh → 「互联网组网」：

1. 打开开关
2. 粘贴 Tailscale 授权码（`tskey-auth-...`）—— **只需输入一次**，存进 `state.json`
   （权限 0600），重启不用再填
3. Headscale 用户另填「控制服务器地址」，官方用户留空

节点名自动取机器名（`立朋-mac` → `dsh-mac`，`文超-win` → `dsh-win`），不用你填。

### 安全边界

进 tailnet 要授权码，进局域网要物理接入 —— 两者信任模型不同。所以留了
`tsnetPermissionPreset`：**留空 = 与局域网完全一致**（默认），想只收紧互联网那一侧
就填 `workspace-write` 之类。因为一旦进网，对方就能对你所有机器下 `mesh_run`。

### 网络要求（实测本机）

| 目标 | 结果 |
|---|---|
| `controlplane.tailscale.com` | ✅ 0.65s |
| `login.tailscale.com` | ✅ 0.63s |
| `derp1/2/3.tailscale.com` | ✅ ~0.8s |
| `github.com` 直连 | ❌ HTTP 000 |

所以 sidecar 二进制**默认走镜像下载**（`ghfast.top` → `gh-proxy.com` → … → 直连兜底），
实测 1.24MB/s，9MB 约 8 秒。完整性校验用的是**钉在插件源码里的 sha256**
（`lib/tsnet/checksums.js`），而不是从同一个 release 拉 `checksums.txt` ——
否则恶意镜像可以同时替换两者，校验就成了摆设。

---

## 身份与命名

每台机器有**三个**标识，分工不同：

| 标识 | 是什么 | 稳定性 | 用途 |
|---|---|---|---|
| **instanceId** | 持久 UUID（存在 `state.json`） | 同一 profile 内不变 | 内部用：去重、识别"这条是我自己发的" |
| **machineName** | 人可读的名字，如 `客厅的Mac` | 持久保存 | 你和 agent 用它指代这台机器 |
| **fingerprint** | OS 机器 ID 的 sha256 截断（见 `lib/identity.js`） | 按**物理机**不变 | 只用来**认领**：state.json 丢了/插件重装后，认出"这还是同一台机器" |

**为什么身份用 UUID 而不是 MAC**：一台笔记本同时有 Wi-Fi / 有线 / Thunderbolt 网桥 /
VPN，换网 MAC 就变；iOS / Android / macOS 现在默认按 SSID 使用随机 MAC；Android 上
也拿不到稳定 ID。用 MAC 当身份会让"切个网"变成"多出一台新设备"。指纹经过 sha256
截断后才上网，不可逆推硬件 ID。

**名字解析优先级**：插件配置 `machineName` > 用户首次启动时填的 > 系统主机名。

首次启动时（还没命名过、落在主机名上）Mesh 页面会主动问你一次：输入框预填主机名，
点「就这个」直接用，或改成你想要的名字。名字存在 `$DSH_HOME/mesh/state.json`
（和配对码同一个文件，权限 0600），**改完立刻重新广播**，对端不用重启就能看到。

### 指纹认领的边界（同一台机器上跑多个 profile）

指纹是**按物理机**算的，所以同一台 Mac 上的每个 DSH profile 指纹都相同。认领
因此有个必须的条件，否则两个都活着的实例会**互相删掉对方**（连自己都被删）：

| 情况 | 是否认领 |
|---|---|
| 指纹相同 + **机器名相同** | ✅ 认领（重装/丢 state.json，名字一般不变） |
| 指纹相同 + 机器名不同 + **旧记录已离线** | ✅ 认领（重启残留，正是认领要解决的场景） |
| 指纹相同 + 机器名不同 + **两台都在线** | ❌ **不认领**（同机两个 profile，各自合法） |
| 指纹不同 | ❌ 绝不认领（不同物理机，重名交给重名告警） |

### 重名怎么办

名字是人手填的，可能撞。页面会检测并告警，派发时也不会随便挑一台：

- **从 A 看**：`--peer winbox` 只要在 A 的上游对端里唯一就能用（自己不算）
- **从第三台机器看**：如果它发现有两台都叫 winbox，`mesh_run` 会**拒绝**并列出候选，
  让你改用 `<ip>:<port>` 精确定位

地址也接受实例 id 或 `ip:port`，所以撞名时总有办法精确指定。

---

## 实测验证状态

以下都在**真实 DSH host** 上跑出来（临时 DSH_HOME，未动你正在用的应用）：

| 项目 | 结果 |
|---|---|
| 配置装配进 profile | ✅ `--dump-config` 含本项目两行 |
| 插件加载、`apply` 执行 | ✅ 挂载 5 个 UI 接口、注册 4 个工具 |
| **两个真实 DSH 互相发现（仅扫描，组播全关）** | ✅ 双向，24 秒内（含启动竞态重试） |
| 两个真实 DSH 互相发现（组播开） | ✅ 双向，1 秒内 |
| **零配对派发任务** | ✅ `ok: true`，全程没有任何配对操作 |
| **对端 agent 被唤醒** | ✅ 建了 `mesh-*` 会话，17 个事件，含任务提示词 + 线程 + 回派指令，`turn/start` → `assistant/attempt` |
| **离线判定** | ✅ 杀掉对端后约 20 秒标记离线（ttl 20s） |
| 固定端口被占用 → 回退 | ✅ 配置 45919、实际 63570 |
| `requirePairing: true` 时 | ✅ 错误 token → 403；正确 token → 200 |
| **首次启动询问名字** | ✅ 未命名时 `needsName=true`，输入框预填主机名 |
| **改名立刻传播** | ✅ 改完 **2 秒内**对端就看到新名字（立即重新广播） |
| **名字持久化** | ✅ 存 `state.json`，重启后仍是 `客厅的Mac` / `source=saved` |
| 名字校验 | ✅ 空、含 `/`、超 32 字符均被拒 |
| 配置优先 | ✅ 配置里写了 `machineName` 时改名返回 409，不静默覆盖 |
| 重名检测 | ✅ 两端 `duplicateNames` 均正确列出 |
| 客户端 bundle 被提供 | ✅ 出现在 `__DSH_BOOT__`，路由 200，内容与源码逐字节一致 |
| UI 页面渲染 | ✅ 机器列表 / 任务记录两个 tab |
| 不花你的 token | ✅ 测试环境无模型密钥，agent 止步于 `no API key` |
| **`newSession` 强制新起会话** | ✅ 同一 thread 隔 8 秒发两条：带 `newSession` → 绑到两个不同 `mesh-*` 会话；**对照组不带 → 复用同一个**（证明差异确实来自这个标志） |
| **能力名片双向交换** | ✅ 两个真实实例互相拿到对方完整 `runtimes`（node/python/go/docker/git/ffmpeg）+ CPU/内存/GPU |
| **老版本对端向后兼容** | ✅ 对 0.3.18 与 0.3.24 的对端显示「能力未知」且不报错，其余功能照常 |
| **同机两实例并存** | ✅ 两个 profile 同时在线，互不顶掉（指纹认领加了边界条件前会被互相删除） |
| **探测失败可辨识 + 串行重试** | ✅ 自测里用「睡 4 秒再报版本」的假命令验证：首轮超时 → 串行重试拿到真值（7343ms） |
| **Mesh 页面展示能力** | ✅ 每个运行时一枚徽章 + GPU + 规格，悬停给完整信息；三种「不知道」分开渲染 |
| **客户端渲染（无浏览器）** | ✅ 12 项：假 module loader + 最小 react stub，遍历 `createElement` 返回树断言文案 |

**没验证的**（如实说明）：
- 没在你**正在运行的** DSH Desktop 里验证 —— 需要重启应用，会掐断本次会话。
  用 `dev-boot.mjs` 复现了真实主进程的模块解析行为来代替。
- Windows 侧没跑（手上没那台机器）。代码跨平台，但 Windows 防火墙要放行 TCP 45917
  和 UDP 45892。
- 扫多端口（`scanPorts`）是我为了在同机测试才加的，真实两机场景用不到。

---

## 安装

两台机器都装。**装完必须重启 DSH Desktop 才会加载。**

### 方式 A：一键脚本（推荐）

```bash
git clone https://github.com/peng456/dsh-plugin-mesh.git
cd dsh-plugin-mesh
./install.sh
```

脚本做两件事，且**可重复执行**（已装就跳过）：

1. 把插件**复制**到 `~/.dsh/profiles/desktop/node_modules/dsh-plugin-mesh/`
2. 把它加进该 profile `package.json` 的 `dsh.profile.bundles`
   （改前自动备份为 `package.json.bak`）

常用选项：

```bash
./install.sh --dry-run              # 只打印会做什么，不落盘
./install.sh --profile web          # 装到别的 profile
./install.sh --home /path/to/.dsh   # 指定 DSH_HOME
./install.sh --uninstall            # 卸载（删目录 + 从 bundles 移除）
```

### 方式 B：手动装

```bash
# macOS
cp -R dsh-plugin-mesh ~/.dsh/profiles/desktop/node_modules/dsh-plugin-mesh

# Windows (PowerShell)
Copy-Item -Recurse dsh-plugin-mesh "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-mesh"
```

然后在 `~/.dsh/profiles/desktop/package.json` 的 `bundles` 里加上 `"dsh-plugin-mesh"`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-mesh"],
      "patchReload": "live"
    }
  }
}
```

> ⚠️ **必须是真实目录，不能是软链。** DSH 的 profile 包解析器会拒绝 realpath 落在
> `<profile>/node_modules` 之外的包（`module-resolution-*.js` 里那条判断，
> 目的是防止陈旧的外部状态覆盖已封装安装）。把插件软链到你的工作目录会在启动时
> 报 `ERR_MODULE_NOT_FOUND`。`install.sh` 已经处理好了这一点。

### 方式 C：官方命令（用 DSH Desktop 自带的终端）

托盘/菜单 → 终端：

```bash
dsh plugin add /path/to/dsh-plugin-mesh
```

注意 `dsh plugin --profile desktop` 在**普通终端**里会被拒绝
（`bin.js:29`：profile "desktop" is managed exclusively by the Electron application），
必须用应用自带的那个终端。

### 升级已安装的插件

`release-plugin.sh --publish` 发完版会**自动同步到局域网镜像**并打印一段可直接
粘贴到对端的命令。对端（尤其是 Android，见下面的 `/tmp` 坑）执行后**必须重启 DSH**
才会加载新版本。

手工步骤就是：下载 → 解压 → 备份 → 覆盖 → 重启。

```bash
# 对端可写临时目录（Android 用 $TMPDIR，见下）
T="${TMPDIR:-$HOME/tmp}"; mkdir -p "$T"
curl -fL -o "$T/mesh-0.3.26.tar.gz" http://192.168.1.6:8791/dsh-plugin-mesh-0.3.26.tar.gz

mkdir -p "$T/mesh-new" && tar xzf "$T/mesh-0.3.26.tar.gz" -C "$T/mesh-new"
grep -m1 '"version"' "$T/mesh-new/package.json"     # 应显示目标版本

PLUGIN="$HOME/.dsh/profiles/<profile>/node_modules/dsh-plugin-mesh"
cp -R "$PLUGIN" "$PLUGIN.bak"
rm -rf "$PLUGIN/lib" "$PLUGIN/client" "$PLUGIN/scripts" "$PLUGIN/sidecar"
cp -R "$T/mesh-new/lib" "$T/mesh-new/client" "$T/mesh-new/scripts" "$T/mesh-new/sidecar" "$PLUGIN/"
cp "$T/mesh-new/package.json" "$T/mesh-new/cordis.patch.yml" "$PLUGIN/"
# 然后重启 DSH
```

先 `rm -rf` 那几个子目录再拷，是为了不让**上一版删掉的文件**残留下来。

#### ⚠️ 重启前必须先验「可加载」，不能只验「文件对得上」

升级是**先落盘、后重启**两段式的，中间有一段**半态窗口**：磁盘已是新版本，
进程还是旧版本（`VERSION` 是启动时读入的常量，不跟着磁盘变）。这个窗口里如果
新代码**新增了一个 import 而落盘漏了那个文件**，重启会在 DSH 加载插件时**当场崩**。

两种常规自检都兜不住这个失败模式：

| 自检 | 为什么兜不住 |
| --- | --- |
| `find` + 逐字节 `cmp` | 被漏掉的文件**根本不在磁盘上**，没有"不一致"可比对，只会报全部一致 |
| `node --check <file>` | 只做**单文件语法**解析，不解析 import 图，缺文件照样通过 |

唯一能精确复现"重启即崩"的，是**从安装路径实际 import 一次入口**：

```bash
PLUGIN="$HOME/.dsh/profiles/<profile>/node_modules/dsh-plugin-mesh"

# ① 一条命令版（不依赖安装路径里有脚本，任何机器都能跑）
node -e "(async()=>{const m=await import('file://$PLUGIN/lib/index.js');console.log('OK',Object.keys(m))})()"

# ② 仓库里的封装命令（打印版本/exports，退出码可直接当门禁）
npm run check:deploy -- "$PLUGIN"          # 严格模式：面向"落盘后的安装路径"
npm run check:loadable                     # 仓库自检：忽略"缺运行时依赖"这一类误报
```

退出码 **0 = 可加载**，非 0 = **别重启，先回滚**。`check:loadable` 已挂在
`npm run check` 末尾，发版时就会跑到。

> ⚠️ `check-loadable.mjs` **不能 `cd "$PLUGIN"` 再跑** —— 升级只覆盖
> `lib/client/sidecar/scripts`，但你手上这份安装目录未必带 `scripts/`（我的就没有），
> 于是 `node scripts/check-loadable.mjs` 会报 `Cannot find module`。那是"脚本不在
> 那儿"，**不是**半态。所以校验脚本要放在**仓库**里、把安装路径当参数传；或者用
> 上面 ① 那行 `node -e`，它不需要安装目录里有任何脚本。
>
> ⚠️ 校验**仓库**副本时缺 `@deepseek-ai/dsh-brand` 是正常的（那是 DSH 运行时提供的
> 依赖，只有安装路径才解析得到），别误判成半态 —— 这就是 `check:loadable` 要加
> `--allow-missing-runtime-dep` 的原因。

> 这一步是拿真实事故换来的：0.3.28 新增了 `lib/prompt.js` 并由 `index.js` 顶层
> import 它，磁盘一度处于"新 `index.js` + 缺 `prompt.js`"的半态 —— `cmp` 全绿、
> `--check` 全绿，差点带着它重启。由对端 hos 复现并给出这条做法，实测有效。

回滚就是 `cp -R "$PLUGIN.bak" "$PLUGIN"`，再重跑一次上面的校验。

> ⚠️ **Android 上没有 `/tmp`**（根文件系统只读，`mkdir /tmp` 报
> `Read-only file system`）。给 Android 的命令必须用 `$TMPDIR`，否则你会看到
> `curl: (23) client returned ERROR on write` —— 一个看起来像网络故障、
> 实际是"盘不存在"的错误。

### Windows 防火墙

```powershell
New-NetFirewallRule -DisplayName "DSH Mesh" -Direction Inbound -Protocol TCP -LocalPort 45917 -Action Allow
New-NetFirewallRule -DisplayName "DSH Mesh (multicast)" -Direction Inbound -Protocol UDP -LocalPort 45892 -Action Allow
```

只放行 TCP 也行 —— 那时靠主动扫描发现，不依赖组播。

## 使用

侧栏会出现一个 **Mesh** 图标（三个节点连成的网状），点开是主页面：

- **本机信息**：机器名、地址、端口、当前发现方式与配对要求
- **发现的机器**：每台一行，在线绿点/离线灰点，显示地址、系统、用户、最后心跳；
  每行「探测」和「派发任务」
- **扫描本网段** / **重新广播** 按钮
- **派发任务**：选目标机器 → 填任务 → 派发
- **任务记录**：收到 / 派出的任务
- **配对码**（折叠，默认不需要）

agent 多出四个工具：

| 工具 | 作用 |
|---|---|
| `mesh_peers` | 列出发现的机器 |
| `mesh_scan` | 主动扫本网段，找还没发现的机器 |
| `mesh_run` | 把任务派给某台机器的 agent（异步） |
| `mesh_tasks` | 查看收到/派出的任务记录 |

所以你可以直接说：

> 「看看局域网里有哪些机器，然后让 B 把 web 服务重新部署一下，跑完告诉我。」

---

## 工作原理

### 唤醒：自包含实现，不依赖额外插件

agent 没有事件循环，只在有回合时才思考。所以收到对端任务后，必须**建一个会话并让它跑起来**。

DSH 提供了官方插件 `@deepseek-ai/dsh-webhook` 做这件事，但**本插件没有用它**，理由：

1. 它不在任何默认 bundle 里，靠补丁替用户插一行，会让"装一个插件"变成配置里两行，困惑
2. 更实际的问题：万一它已经被启用（比如你以后装了 GitHub webhook 插件），
   cordis 的 `provide` 遇到重名会直接抛错（`service "webhookRuntime" has been registered at <...>`），
   而且那是在它的构造函数里，**本插件的安全网拦不住**

所以这里按官方 `createWebhookSession` 的做法自己走一遍，用到的都是 DSH 基础服务
（桌面 profile 本来就全都有）：

```
ctx.permissionPresets.resolve / set      校验并设置权限 preset
ctx.agentPresets.resolve / mount         解析并挂载 agent preset
ctx.workspaceRegistry.create             建/取工作区
ctx.agents.create                        建 Agent
ctx.sessionTitle.rename                  给会话起名
ctx.agentDefaultModel.currentSelection   取默认 provider/model
agent.followup(createUserMessage(...))   ← 这一步才是"唤醒"
```

服务齐备时才启用（用 `ctx.inject([...])` 探测）；缺任何一个就降级为"只收件不唤醒"，
并在日志里说明缺了什么。**插件是自包含的，profile 里只多一行。**

### 为什么发现要两条路

我先只做了组播，后来加扫描，是因为组播在真实家庭网络里失败率比想象中高：
AP isolation、Windows 防火墙默认策略、跨 VLAN，任何一个都能让它静默失效。
而"TCP 直连固定端口"只要网络通就能成。

---

## 配置项

默认已经可用。要改就在 profile 的 `cordis.patch.yml` 里按 id 覆盖
（注意：patch 是**整体替换** config，所以要把想保留的项一起写上）：

```yaml
- id: mesh
  config:
    machineName: ''            # 对端列表里的名字，留空用主机名
    port: 45917                # 固定端口
    useMulticast: true         # 组播被动发现
    scanOnStart: true          # 启动扫描（带退避重试）
    scanIntervalMs: 60000      # 周期扫描；0 = 关闭
    scanRanges: []             # 额外网段，如 ["192.168.1.0/24"]；空则扫本机 /24
    scanPorts: []              # 除本机端口外额外要扫的端口
    scanConcurrency: 64
    scanTimeoutMs: 800
    pingIntervalMs: 10000      # ping 保活；0 = 关闭
    announceIntervalMs: 5000
    peerTtlMs: 20000           # 多久没消息算离线
    requirePairing: false      # 见下
    agentPreset: standard
    permissionPreset: workspace-write
    workspaceRoot: ''
    # ── 互联网自组网（Tailscale / tsnet）──
    tsnetEnabled: false        # 也可以在 Mesh 页面上的开关里改（存 state.json）
    tsnetAuthKey: ''           # 建议只在页面填；配置里填则优先且钉死
    tsnetControlUrl: ''        # 留空 = 官方 Tailscale；Headscale 填自己的
    tsnetHostname: ''          # 留空 = 由机器名派生（立朋-mac → dsh-mac）
    tsnetDownloadSources: []   # 自定义下载源前缀，可用 {url} 占位符
    tsnetPermissionPreset: ''  # 留空 = 与 permissionPreset 完全一致；填了就只对 tailnet 生效
    # ── 循环限速 ──
    maxWakesPerThread: 30      # 每窗口内最多自动唤醒几次；0 = 不限制
    threadWindowMs: 3600000    # 窗口长度（毫秒），默认 1 小时
    threadCooldownMs: 20000    # 两次自动唤醒的最小间隔；0 = 不限制
    minTaskChars: 24           # 正文短于此长度只入箱不唤醒（挡 ping/ack）
```

### 循环限速（重要）

**为什么需要**：入站任务会自动新建会话并立刻让 agent 开跑，而每条消息都由
远端决定。两个 agent 互相回执时会形成自持的 ping-pong —— 实测一个互回执线程
在 2.5 小时内自动开了 54 个会话、约 800 万 token，全部是重复探索。

四道闸门，任何一道触发都**只入箱、不唤醒**（任务仍可在 `/mesh/v1/tasks` 和
Mesh 页面看到，不会被丢弃）：

| 闸门 | 默认 | 作用 |
|---|---|---|
| `minTaskChars` | 24 | 太短的内容不开会话 |
| 寒暄识别 | 内置 | `ping` / `ack` / `收到` / `好的` 等整条即寒暄的，不开会话 |
| `threadCooldownMs` | 20s | 同一 thread 不会连续秒回，管**突发** |
| `maxWakesPerThread` | 30 | 同一 thread 在 `threadWindowMs` 内的唤醒上限，管**持续速率** |

`maxWakesPerThread` 是**滑动窗口限速，不是终身配额**：只统计最近
`threadWindowMs`（默认 1 小时）内的唤醒。窗口内的唤醒点会随时间自然过期，
该 thread 自动恢复，不需要重启。

⚠ **限速只会让循环变慢，不会让它停。** 如果循环的自然节奏低于上限，
窗口永远填不满，限速就永不触发 —— 实测事故节奏约 21 轮/小时，即使把上限
压到 10/小时，24 小时也仍会放行 276 轮。要真正止住请把上限设得**低于**
循环节奏，或配合会话复用把单价降下来。

#### 撞上限时交给用户决定

限速触发时**不静默丢弃**，而是在 Mesh 页面出现一张提示卡：

```
⚠ 有 thread 撞到唤醒上限，已暂停自动唤醒
  diet-reconcile   上限 30 次 / 60 分钟 · 已挡下 12 条
  [提高上限并放行最新一条]  [忽略]
```

- **提高上限** → 把该 thread 的上限翻倍（至少 +10），并**立刻放行最新那一条**
  （对话的最新一环）。其余被挡的仍留在收件箱 —— 一次性全放会造成新突发，
  反而失去限速的意义。覆盖值落盘，重启后仍有效。
- **忽略** → 只清提示，上限不变，任务仍留在收件箱。

对应的 API：`POST /mesh/api/throttle/raise {thread, cap?}`、
`POST /mesh/api/throttle/dismiss {thread}`；被挡的 thread 列表在
`GET /mesh/api/state` 的 `throttled` 字段里。

账本与覆盖值落盘在 `~/.dsh/mesh/threads.json`，**重启不清零** —— 否则对端
只要等到你重启就能重新灌满窗口。

另外两点配套改动：

- **同 thread 复用会话**：同一 `thread` 的后续消息注入同一个会话，不再每条
  从零重新探索。这是省 token 的最大一项，也让 agent 记得前几轮结论。
- **`noWake: true`**：发送方可以显式声明"这条只回执，别开跑"。`mesh_run`
  工具已带这个参数 —— 纯回执/确认请用它，否则会凭空开一个 agent 会话。

**已知绕过**：限速只认 `thread` 名字，而名字由发送方自由填写。对端若每次都
换 thread 名或不带 thread，就不受限速约束（此时只有 `threadCooldownMs` 的
突发冷却在起作用）。它是刹车，不是安全边界。

---

## 安全

**默认不需要配对** —— 同一内网里任何发现到本机的 DSH 都能派发任务。
对本机 agent 而言，这些任务会被当成一条用户消息（默认权限 `workspace-write`：
能读写工作区、能执行命令）。

这在**自己家的可信内网**里是合理取舍，也正是你要的"零配置"。但如果你在
**不完全可信的网络**里（合租、公司、宿舍、有访客设备、IoT 设备多），请打开：

```yaml
- id: mesh
  config:
    requirePairing: true
```

然后在两台机器的 Mesh 页面里互相对一下配对码（首次启动自动生成，页面上可直接复制）。
打开后所有控制接口都要过配对码，用 `timingSafeEqual` 比较。

其他：
- **发现是公开的**：同一网段任何人都能看见机器名、地址、系统、用户名。这是有意的取舍。
- **明文 HTTP**：局域网内可接受；跨不可信网络请套 SSH 隧道或 TLS 反代。

---

## 已知限制

1. **同 thread 复用会话，但跨 thread 不复用**：同一 `thread` 的后续消息会注入
   同一个会话；没带 `thread` 的任务仍然每次新建。（早于 2026-09 的版本无此复用，
   每条消息都新建会话。）
2. **去重只在进程生命周期内**（内存），重启后同 id 会重复入箱。
3. **没有离线排队**：对端离线时 `mesh_run` 直接失败，不暂存重投。
   （要这个能力可以用工作区里的 `lanmsg.py`。）
4. **同机多实例**：第二个实例端口被占会退回随机端口，主动扫描扫不到它（组播仍能发现）。
   真要同机多实例，给它们配不同 `port` 和对方的 `scanPorts`。
5. **`sidebar.panellist` 槽位官方插件没人用过**（翻遍 58 个客户端 bundle，只有官方侧栏
   自己声明它）。我按源码契约接的，实测注册和渲染都正常，但不如 `sidebar.footer.action`
   那样有第三方先例。
6. **Android 上 sidecar 需要专用资产，且下载源仍是拦路虎**：`detectTarget()` 现在把
   `android` 映射到 `android` 资产（PIE + `/system/bin/linker64`，见上文 Termux 的坑）。
   原先那份全静态 `linux/arm64` 在真机上 exec 会被 bionic 拒掉（`has unexpected e_type: 2`），
   所以**老版本插件 + 新 sidecar** 或**新插件 + 老 sidecar** 都不行，两边要一起升。
   剩下的真正拦路虎是**下载源**：实测那台 Android 上 ghfast.top / gh-proxy.com / ghproxy.net /
   github.com 全部不通，只能靠同网段的镜子（见下一节）。装好之后 sidecar 本身可以正常跑。
   **平台不支持不该拖垮页面**：`binaryInfo()` 只返回 `{installed:false, error}` 从不抛异常，
   `TsnetNode.status()` 外再兜一层 try/catch，`/mesh/api/state` 在 Android 上仍为 `ok:true`。

### 逃生通道：用同网段的机器当 sidecar 镜子

当一台机器的所有下载源都不通（被墙、DNS 污染、无外网）时，把已经拿到资产的机器
当镜子即可 —— 校验和钉在 `checksums.js` 里，明文 http 改不了内容：

```bash
# 在能拿到资产的机器上（仓库内 dist/sidecar/ 已有构建产物时）
python3 ../lan-sidecar-mirror.py --host 0.0.0.0 --port 8791   # 见仓库外的 lan-sidecar-mirror.py
# 先验证这台机器「按对方的平台」真的装得上（不碰本机真实缓存）
node scripts/verify-lan-mirror.mjs --url http://192.168.1.6:8791/ --platform android --arch arm64
```

对端（被墙的那台）在插件配置里加上：

```json
"tsnetDownloadSources": ["http://192.168.1.6:8791/"]
```

源按顺序试：**用户配置的源 → 内置镜像 → 直连 GitHub**；`http://` 与 `https://`
都支持（只 import `node:https` 的话，http 源会直接 `ERR_INVALID_PROTOCOL`，
而被迫用局域网源的机器恰恰最没法自己排查）。镜像按「完整 GitHub URL 拼在前缀后」
的形状请求，所以镜子只要忽略路径、按文件名给文件就行。

---

## 开发与测试

```bash
# 搭隔离环境（把插件真实复制进 profile，不碰你的 desktop profile）
MACHINE=macbox PORT=45917 MULTICAST=false SCAN_PORTS="[45918]" \
  ./dev-setup.sh meshtest /tmp/mesh-dsh

# 启动（dev-boot.mjs 复现真实主进程的模块解析行为）
DSH_HOME=/tmp/mesh-dsh ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DSH Desktop 2.app/Contents/MacOS/DSH Desktop" \
  dev-boot.mjs --profile meshtest --port 8877
```

`dev-setup.sh` 支持的环境变量：`MACHINE` `PORT` `MULTICAST` `SCAN_ON_START`
`SCAN_PORTS` `PING_INTERVAL_MS` `REQUIRE_PAIRING`。

**为什么需要 `dev-boot.mjs`**：`desktop-cli.js:78` 只在 `app.asar` 内才安装 profile
包解析器，而这个安装是未打包的 `Resources/app`。真实 Electron 主进程
（`main.js:4478`）是**无条件**安装的，所以真实应用没这个问题，只有 CLI 路径有。

发现模块可以脱离 DSH 单独测：

```bash
node lib/_selftest-discovery.mjs alpha 45900 9000   # 两个进程同时跑可验证互相发现
```

### ⚠️ 三个反复踩到的坑（改这个代码前请先读）

**1. 改 schema 的 `.default()` 不等于改生效值。** `cordis.patch.yml` 里显式写了
的键会**覆盖** schema 默认值，用户 profile 里的 `cordis.patch.yml` 又是第三份。
所以改默认值时必须查三处：

```bash
grep -n "你要改的键" cordis.patch.yml ~/.dsh/profiles/*/cordis.patch.yml
```

漏了的话现象是"代码改了、行为完全没变"，极容易误判成代码没生效。

**2. "探测失败"绝不能等同于"没有"。** 这个项目已经因此吃亏两次：

- `execFile` 超时/失败一律降级成空 → 机器忙时名片报出"什么运行时都没装"
- 只有 `status` 没有原因 → 任务卡在 `dispatch-failed` 时无从查起（后来加了 `dispatchError`）

所以规矩是：**任何"我们没问出答案"的情况，都要和"答案是明确的否定"分开存**，
并且要能被看见（`probeErrors` / `runtimesIncomplete` / `routeDecision` /
`dispatchError` 都是这条规矩的产物）。

**3. 环境差异会伪装成功能故障。** 实测两次，两次都先怀疑错了方向：

- Android 上**没有 `/tmp`** → `curl -o /tmp/...` 报 `(23) ... on write`，
  看着像网络问题，其实是根文件系统只读。对端命令一律用 `$TMPDIR`。
- **GUI 启动的 DSH 继承的 PATH 极简**（`/usr/bin:/bin:/usr/sbin:/sbin`），
  Homebrew / `~/go/bin` / conda 全都不在 → 能力探测报"什么运行时都没装"。
  所以 `capabilities.js` 补全 PATH，`state().self.capabilityProbePath` 把实际
  用的 PATH 暴露出来。

教训：对端报"功能不对"时，**先确认那台机器的环境**（盘、PATH、shell），
再怀疑代码。

### 能力名片（Placement 第 1 步）

每台设备启动后采集一次自己的能力并**挂在现有名片上**广播（不新增协议、
不在心跳里探测）：

```js
capabilities: {
  os, arch, cpuCores, memMb,
  runtimes: { node: "20.19", python: "3.12", go: "1.25", ... },
  gpu: { present, name, vramMb } | null,
  workspaceHints: ["~/projects"],   // 家目录缩写成 ~，不带用户名
  runtimesIncomplete: false,        // true = 有探测项没探准，缺失不能当结论
  capabilitiesAt: 1791999999999
}
```

对面收到后净化（限长、封顶、剥控制字符）再存。**`null` 与 `{}` 语义不同**：
`null` = 还没报（老版本 / 刚开始采集 / **报来的东西被净化判为非法**）→ 该去问人；
`{}`（净化后的空壳）= 报过了确实没有 → 可以直接排除。
`runtimesIncomplete` 为真时同理不可用于硬门槛判断。

#### ⚠️ `null` 有两种成因，而现有字段**都区分不了**（实测）

`capabilities` 为 `null` 既可能是"对端**从来没有**这个字段"（老版本），也可能是
"对端报了、但内容非法被净化掉了"。两个坑：

1. **`capabilitiesStale` 不能用来区分。** `isCapabilityStale(null)` 返回的是
   **`false`**（`lib/capabilities.js:510`：没报能力不是"过期"，是"未知"）。
   所以对 0.2.0 那台也会得到 `capabilitiesStale: false` —— 一个"看起来不陈旧、
   其实压根没这个字段"的**假阴性信号**。
2. **净化会把两种成因合并成同一个 `null`。** 实测 `sanitizeCapabilities()`：
   `undefined` / `null` / `"not-an-object"` / `42` **全部** → `null`。
   净化后的投影里已经不含"原始字段是否存在"的信息了。

→ Placement 想区分"**不支持**"和"**没采集完**"，可靠判据是**版本**：
`version >= 0.3.25` 才保证名片里有 `capabilities` 字段（实测：0.3.25 起
`selfRecord` 含该字段，0.2.0 里出现次数为 **0**）。版本 `< 0.3.25` → 判"不支持"，
不要去问人、也不要当成"等它采集完"。

> 注意版本判据的**前提**：它假设版本号和能力字节码**同步发布**。若将来给
> `0.2.x` 回填了 `capabilities` 字段，这条判据就会误报"不支持"。真要做到无懈可击，
> 得在接收侧留一个"原始名片里有没有这个 key"的布尔位再投影出去 —— 现在没有。

#### ⚠️ `runtimes: {}` 也可能是**假的**（Windows 踩过）

`runtimesIncomplete: false` 的语义是"所有探测都得到了**确定**答案，可以据此断言
这台机器**没有**任何运行时"。但"确定没装"和"PATH 里找不到"在数据上长得一模一样 ——
`isUncertain()` 把 `ENOENT` 当作确定答案。只要 **PATH 本身是错的**，整批 `ENOENT`
就会被翻译成"确定没装"。

实测：对端 `文超-win` 升到 0.3.28 后报回 `runtimes: {}` + `runtimesIncomplete: false`
—— 即在名片上宣称"确定没有任何运行时"，**而它自己就跑在 Node 上**（DSH 是 Node 应用）。
根因是 `extraPathDirs()` 当时**没有 Windows 分支**，补的全是 Unix 路径
（`/opt/homebrew/bin`、`/usr/local/bin`…），在 Windows 上等于没补。

三道防线（本次修复起，版本号未变，仍是 0.3.28）：

1. `extraPathDirs()` 分平台。Windows 分支补 `%ProgramFiles%\nodejs`、`%APPDATA%\npm`、
   `%LOCALAPPDATA%\Programs\Python`、`%ProgramFiles%\Git\cmd`、scoop/chocolatey shims 等；
   并且 **PATH 分隔符跟平台走**（Windows 是 `;`）—— 写死 `:` 会让整个 PATH 变成
   一个"目录名"，比不补还糟。
2. **形状守卫**：`runtimes` 为空**且**存在失败项 → 标 `runtimesIncomplete: true`
   （"整批归零"的形状，几乎必定是 PATH 问题）。
3. **补全生效判据**（最关键的一条）：`extraPathDirs()` 在**这台机器上**一个存在的
   目录都加不进去 → 说明我们自己的兜底没做成 → 此时 **所有 ENOENT 结论都不可信**，
   照样标 `runtimesIncomplete: true`。

##### 判据为什么用"补全有没有生效"，而不是"目录白名单"

一开始我写的是"主 PATH 里有没有本平台常见工具目录"（硬编码 `darwin`/`linux`/`android`
三套根）。对端当场指出这会**假阳性**：它的 runtimes 实际住在
`/data/data/com.dsharnessmobile.shell/files/usr/bin`，**不在任何常见白名单里** ——
白名单一旦遇到白名单之外的 prefix 就会误判"PATH 残缺"。

改成**自校验**式：问的不是"PATH 里有没有我认识的目录"，而是
**"我们自己的兜底机制有没有真的加进一个存在的目录"**。这与平台布局无关，
也不需要维护清单；Windows（`%ProgramFiles%\nodejs` 不存在时）和 Android/Termux
都自然落到"补全没生效 → ENOENT 不可信"，而 darwin/linux 正常机器落到"生效 → 可信"。

##### 为什么不是"有失败就报"

对端 hos 曾提议简化成"`errors.length > 0` → incomplete"。**这条会误报**，
我拒绝了，理由是实测反例 —— 就是本机：

| 机器 | runtimes | ENOENT 项 | 那些项真的没装吗 | 正确结论 |
| --- | --- | --- | --- | --- |
| 本机 darwin | 6 个（非空） | `rustc`、`adb` | **是**，`command -v` 也找不到 | `incomplete=false` ✅ |
| 文超-win | **0 个** | 全部 | 否 —— 它跑在 Node 上 | `incomplete=true` ✅ |
| 对端 Android | 3 个（非空） | 6 项 | **是**（它自查 `command -v` 确认） | `incomplete=false` ✅ |

按"有失败就报"，本机会被误标成 incomplete（`rustc`/`adb` 真的没有），于是 Placement
永远不敢断言"这台机器没装 rustc" —— **代价不是"谨慎"，是让这个字段失去区分度**。

> 这一行的第三个格曾反复过：对端先断言"我这台是活反例"，我据此把 Android 改成
> 无条件 `incomplete=true`；**随后它自己跑了 `command -v`，确认那 6 个确实都没装，
> 于是撤回**。那条无条件改动是**假阳性**，已随本判据一起改掉。
> 教训：`command -v` 自查是**必要条件不是充分条件** —— `FOUND` 能证伪
> （一定有 ⇒ 真漏报），`absent` **只在 PATH 健全时才可下结论**，而这条自查用的
> 正是同一个 PATH 机制，所以它本身是**循环**的。另外它对 shell 生效，探针走的是
> node 子进程的 PATH，两者在异常环境下可能不同。

##### `probeFailCount`：让失败信号**能过网线**

`probeErrors`（失败明细）**不上名片**（`sanitize` 不保留，它只在本地日志/UI 用）。
后果是对端结构性看不到"这次探测失败过"—— 只能看到 `runtimes: {}` 和
`runtimesIncomplete`。旧投影里"3 项没探到"和"8 项全没探到"长得一模一样。
所以新增 `probeFailCount`（数字）跟着名片走：旧对端没有该字段时按 `0` 处理。
（明细仍然不上网线 —— 只上一个计数，够对端判断可信度，又不放大协议面。）

#### `gpu === null` 有**三种**成因，投影层区分不了

| 成因 | 含义 |
| --- | --- |
| ① 对端没有 `capabilities` 字段（版本 < 0.3.25） | 不支持 |
| ② 有字段，但探测本身没给出结论（`nvidia-smi` ENOENT / 超时等） | 探测未果 |
| ③ 有字段，对端**明确报了** `present:false` | 对端说"没有"，但…… |

③ 的特殊之处：`sanitizeCapabilities` 里 `const name = safeStr(raw.gpu.name,60); if (name) gpu = {...}`
—— **名字为空就把整块 gpu 丢掉**。也就是说对端想说"确定没有"，经投影会被
**提升成"未知"**。方向与我们常防的"自家 bug 伪装成对端事实"（假阳性）**相反**：
这是"对端事实被抹成未知"（假阴性→未知）。对 Placement 的影响是**保守**的
（不会误排除机器），但语义上 `null` 不再等于"不知道"。

根上已收口：解析函数**解析不出型号一律返回 `null`**（不再返回
`{present:false,name:""}`），所以成因 ③ 现在不可达。见下方 `parseMacGpu`。
要真正区分三者，仍需要在接收侧保留"原始名片有没有这个 key / present 是什么"
的额外位 —— 目前没有，与 `capabilities` 那条结论同源。

诊断：`/mesh/api/state` 的 `self.capabilities`（本机）与 `peers[].capabilities`
（对端）；`self.capabilityProbePath` 是探测实际使用的 PATH。

回归脚本：

```bash
npm test                     # = check + 四个回归脚本（共 139 项，默认不碰网络）
npm run selftest             # 52 项：发现/通道/会话键
npm run selftest:prompt      # 10 项：任务提示词（回派目标必须是机器名）
npm run selftest:client      # 12 项：客户端渲染（无需浏览器，见下）
npm run selftest:caps        # 62 项：净化/GPU/过期/重试/名片兼容/认领边界
npm run selftest:newsession  # 需要先跑起 dev 实例，见文件头注释
```

**客户端怎么在没有浏览器的情况下测**：这是个手写 bundle、没有构建步骤，安装里
也没有 react-dom。但组件都是纯函数（不用 hook），`createElement` 的返回树就是普通
对象 —— 所以 `_selftest-client.mjs` 用假的 `window.__ModuleLoader__` 把 factory
抓出来，用最小 react stub 执行它，再直接调用组件、遍历返回树断言文案。这比"看代码
觉得对"强：写这套测试时当场抓到一个真 bug（形状不对的 `runtimes` 会被渲染成一串
乱码徽章，而不是干净降级）。

---

## 文件结构

```
dsh-plugin-mesh/
├── package.json           # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml       # 只插入本插件（含默认配置）
├── lib/
│   ├── index.js           # 主机侧：发现编排 + 对端 HTTP + agent 工具 + UI 接口 + 入站唤醒
│   ├── discovery.js       # UDP 组播被动发现 + 对端注册表 + 过期清理 + 指纹认领
│   ├── identity.js        # 持久 UUID 身份 + OS 机器指纹（只用于认领）
│   ├── conversation.js    # 会话键 + 回信地址（两端各自算，不协商）
│   ├── capabilities.js    # 能力采集/净化/摘要（Placement 第 1 步）
│   ├── scan.js            # 主动扫描（固定端口 + CIDR 展开）
│   ├── tsnet/             # 用户态 tailscale 节点（sidecar 下载/管理/桥接）
│   └── _selftest-*.mjs    # 回归脚本（默认不碰网络）
├── sidecar/               # Go 源码：tsnet 用户态节点
├── client/
│   └── client.js          # 浏览器侧：手写 bundle，无需打包工具
├── dev-setup.sh           # 隔离测试环境搭建
├── dev-boot.mjs           # 带模块解析器的测试启动器
├── Placement设计.md        # 步骤 ③ 设计 + 实施记录
├── 设备身份与多通道设计.md   # 步骤 ① 设计
└── README.md
```
