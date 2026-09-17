# dsh-plugin-mesh

DSH 的局域网 Mesh 插件：**启动后自动发现同一网段的其他 DSH 实例**，在侧栏提供一个
操作页面显示各机器的在线状态，并支持把任务派给对端的 agent 执行。

用起来就是你要的那个效果：在 A 机器上开发，把「部署到 B」这件事丢给 agent，
你只下大命令。

**零配置**：固定端口 + 自动扫描 + ping，装上就能发现彼此，**不需要配对码**。
首次打开 Mesh 页面会让你给这台机器起个名字（默认填主机名），别的机器就靠这个名字找你。

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

## 身份与命名

每台机器有**两个**标识，分工不同：

| 标识 | 是什么 | 稳定性 | 用途 |
|---|---|---|---|
| **instanceId** | 启动时随机生成的 8 字节 hex | 每次启动都变 | 内部用：去重、识别"这条是我自己发的" |
| **machineName** | 人可读的名字，如 `客厅的Mac` | 持久保存 | 你和 agent 用它指代这台机器 |

**名字解析优先级**：插件配置 `machineName` > 用户首次启动时填的 > 系统主机名。

首次启动时（还没命名过、落在主机名上）Mesh 页面会主动问你一次：输入框预填主机名，
点「就这个」直接用，或改成你想要的名字。名字存在 `$DSH_HOME/mesh/state.json`
（和配对码同一个文件，权限 0600），**改完立刻重新广播**，对端不用重启就能看到。

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

---

## 文件结构

```
dsh-plugin-mesh/
├── package.json           # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml       # 只插入本插件（含默认配置）
├── lib/
│   ├── index.js           # 主机侧：发现编排 + 对端 HTTP + agent 工具 + UI 接口 + 入站唤醒
│   ├── discovery.js       # UDP 组播被动发现 + 对端注册表 + 过期清理
│   ├── scan.js            # 主动扫描（固定端口 + CIDR 展开）
│   └── _selftest-discovery.mjs
├── client/
│   └── client.js          # 浏览器侧：手写 bundle，无需打包工具
├── dev-setup.sh           # 隔离测试环境搭建
├── dev-boot.mjs           # 带模块解析器的测试启动器
└── README.md
```
