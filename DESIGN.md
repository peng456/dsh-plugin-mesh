# 设计原理与复盘（Design & Post-mortems）

> 这份文档解释**为什么这么设计**，以及每次踩坑之后改了什么。
> 面向想改这个插件、或想知道"它为什么长这样"的人。
>
> 只想**用**它？看 [`README.md`](README.md)（安装/使用/配置）或展示页
> <https://peng456.github.io/dsh-plugin-mesh/>。
> 给 agent 的机器可读摘要见 [`llms.txt`](llms.txt)；改代码前的硬约束见 [`AGENTS.md`](AGENTS.md)。
>
> 本文由 README 拆出，内容与原先逐字一致，只是换了位置。

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
## 互联网自组网：为什么这样设计

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

## 反复踩到的坑

### 三个反复踩到的坑（改这个代码前请先读）

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

## 能力名片（Placement 第 1 步）

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
