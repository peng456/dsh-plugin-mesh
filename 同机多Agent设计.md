# 同机多 Agent 设计：一机一节点，多 agent 挂载

> 草案 v0.1 · 2026-10-26 · 未提交
>
> 回答一个具体问题：**同一台机器上有 DSH、Claude Code、opencode、Codex 好几个 agent，
> 端口怎么分？** 结论先给：**不分。agent 不占端口，只有机器占一个。**
>
> 关联：[`ROADMAP-可玩性与多端适配.md`](./ROADMAP-可玩性与多端适配.md) §2（多端适配）、
> [`docs/PLUGIN-SPEC.md`](./docs/PLUGIN-SPEC.md) §5.4（端口与单实例）、
> [`设备身份与多通道设计.md`](./设备身份与多通道设计.md)（身份与 tailnet 通道）。

---

## 0. 一句话

**把端口从「身份」和「发现键」里摘出去，只留「监听」。**
一台机器一个 mesh 节点（单例常驻），所有 agent 以本地客户端身份注册上来；
跨机发现靠节点播报的**实际端口**，扫描只扫**一个**兜底端口，不再维护「agent → 端口」表。

```
今天（每 agent 一个监听）              目标（一机一节点）
┌─────────────── 机器 ───────────────┐  ┌─────────────── 机器 ───────────────┐
│ DSH      :45917 ─┐                 │  │ DSH     ─┐                        │
│ CC       :45918  ├─ 各自组播        │  │ CC      ─┼─ UDS ─▶ mesh 节点 :45917 │
│ opencode :45919  ├─ 各自状态目录    │  │ Codex   ─┘   （唯一监听、唯一身份） │
│ 扫描表 [45917,45918,45919,…]       │  │ 扫描表 [45917] + 显式兜底           │
└────────────────────────────────────┘  └────────────────────────────────────┘
```

---

## 1. 为什么「每个 agent 一个端口 + 固定扫描表」不优雅

端口现在同时承担三件事，而这三件事需要的东西都不一样：

| 角色 | 需要什么 | 端口为什么不行 |
|---|---|---|
| **身份** | 稳定、可读、重启不变 | 端口会漂移（被占用回退随机端口），一漂就「换了一台机器」 |
| **发现键** | 对方能猜到 / 广播能带到 | 只能靠广播带；写死列表就要求全局分配 |
| **监听地址** | 每机器一份、可冲突检测 | 这是端口唯一适合承担的角色 |

具体会坏在这几处（前两条在仓库里已经发生过）：

1. **扫描表膨胀**：N 个 agent × 每个网段 254 个地址 × 每 60 秒。4 个 agent 就是 4 倍探测，
   AP isolation 下本来就慢的扫描会更慢。
2. **端口冲突 → 静默失联**：`lib/index.js:2122` 现在遇到 `EADDRINUSE` 会退回随机端口；
   `TEST-CASES.md` INST-05 把「主动扫描扫不到本机」列成已知限制。多 agent 之后，
   这个已知限制会变成常态。
3. **端口即身份**：账本、配对、每对端策略都按身份存。端口一换，历史全断。
4. **防火墙 / tailnet 规则爆炸**：每个端口一条入站规则；每个 tsnet sidecar 还要 per-port forward。
5. **状态四分五裂**：N 份 inbox、N 份身份、N 个循环闸计数器、N 份配对密钥 ——
   同一台机器上的 4 个 agent 互不相识，却都对同一个对端自称「同一台机器」。
   现有实现为此被迫要求「同机多实例必须用不同机器名」（`PLUGIN-SPEC.md` FR-1.5），这是绕，不是解。
6. **资源账最贵的一项**：tailnet sidecar 是 Go 进程。N 个 agent 各自管理通道 = N×M 个进程。

**结论**：列表不是不优雅的问题，是它把「机器」这个概念切碎了。
Mesh 的寻址单位一直是**机器**（`machine`），不是 agent —— 那就别让 agent 拥有监听。

---

## 2. 目标模型

### 2.1 三层，各归各位

```
跨机（LAN / tailnet）
   │  名片 v3：一台机器一张卡，agents[] 在卡里
   ▼
mesh 节点（每用户每机器一个，单例常驻）
   · 唯一 TCP 监听（默认 45917）        · 唯一身份（nodeId / machine）
   · 唯一发现者（组播 + 扫描）          · 唯一任务账本 / 事件流 / 配对密钥
   · 唯一 tailnet sidecar 管理者        · 唤醒执行器（spawn / delegate）
   │
   ├── UDS / 命名管道（首选，无端口）
   ├── loopback TCP + token（回退）
   ▼
本地 agent（0..N 个）
   DSH 插件 · CC 的 MCP 壳 · opencode 壳 · CLI · 未来其他宿主
```

### 2.2 四条不变量

| # | 不变量 | 违反时的症状 |
|---|---|---|
| I1 | **一台机器同一时刻只有一个对外监听者** | 两个监听 = 两份身份 = 对端看到两台同名机器 |
| I2 | **端口只负责监听**；身份用 `nodeId`，寻址用 `machine` + `agent` | 端口漂移导致失联、配对失效 |
| I3 | **agent 不监听跨机端口**；它注册到本地节点 | 端口表、扫描表、防火墙规则重复 |
| I4 | **扫描是兜底，且只扫节点端口**（+ 显式 `scanPorts`） | 扫 N 个端口，慢且易误判 |

> `scanPorts` 保留，但语义改变：从「同机多实例的补丁」变成
> 「对端跑在非默认端口时的显式兜底」。默认配置下它应该是空的。

### 2.3 谁是那个「唯一点」

**逻辑上是 `mesh-node` 进程；物理上是绑上 45917 的那个进程。不是任何一个 agent。**

| 方向 | 允许 | 走什么 | 理由 |
|---|---|---|---|
| 节点 → 本地 agent | ✅ | ACP（优先）/ CLI spawn / delegate socket | 这是 ACP 的正确定位：节点扮演宿主 |
| 本地 agent → 节点 | ✅ | UDS 本地控制 API | 注册、发任务、等结果、订阅事件 |
| 本地 agent → 本地 agent（直连 ACP） | ❌ | — | 没有主体、绕过闸门账本、N² 链路 |
| 本地 agent → 跨机 agent（直连 mesh） | ❌ | — | 出口必须唯一 |
| 节点 → 对端节点 | ✅ | mesh 线协议（组播 / 扫描 / tailnet） | 只有节点说 mesh |

一句话：**同机与跨机的每一次跨 agent 调用，都从节点出去。**
节点内部才决定下一跳是「UDS 回给本机 agent」「ACP 驱动本机 agent」还是「mesh 出网」。

**为什么不让 ACP 当本机互联：**

1. **没有主体**：ACP 的 client 是「人面向的宿主」。agent A 冒充 B 的编辑器，审计里这条记录算谁的？
2. **绕过闸门**：配对、预算、危险动作确认、循环限速都在节点；直连 ACP 全部跳过。
3. **N² 链路**：4 个 agent 就是 12 条点对点，没有任何一处能回答「这台机器现在在干什么」。
4. **会话打架**：ACP session 是 per-client 的，两个 client 同时驱动同一 session 会互相覆盖。

**为什么出口不是 DSH：**
关掉 DSH 就整机掉线；CC / opencode 在 DSH 没开时不可达；DSH 重启等于对端看到抖动。
出口的生命周期不能等于某个 App 的生命周期。

**为什么不是「每个 agent 都是出口」：**
回到 N 个监听、N 份身份、N 套 tailnet sidecar；而且 `peer=machine` 这一层寻址会失去唯一接收者 ——
旧对端派任务时根本无法判断该由这台机器上的哪个 agent 接。

**物理唯一怎么保证**：`bind()` 选举（§3）。内嵌是兜底，且必须自报 `nodeEmbeddedIn`，
让 `mesh doctor` 能直接说出「出口现在长在 DSH 里，关掉它整机离线」。

**生命周期**：launchd / systemd KeepAlive；节点重启不掉账（journal 在磁盘）；
节点挂了 = 整机离线 —— 这是有意为之：**一个明确的离线，好过 N 个半在线。**

---

## 3. 端口归属：谁绑上 45917，谁就是节点

**不做选举协议，让操作系统的 `bind()` 当选举**：它是原子的，跨进程、跨语言都一致。

| 45917 的状态 | 判定 | 动作 |
|---|---|---|
| 空闲 | 我是第一个 | 绑定，成为节点；创建 UDS，写 `node.json` |
| 被占，`/mesh/v1/health` 返回 mesh 且 `userKey` 相同 | 本用户已有节点 | **不建第二个**，作为客户端接入 |
| 被占，是 mesh 但 `userKey` 不同 | 别的用户 / 别的 mesh 域 | 不接管、不并入；见 §3.2 |
| 有响应但不是 mesh（404 / 别的 app），或探测超时 | 外来进程 | **默认报错**，`mesh doctor` 给处置建议；见 §3.2 |
| 能连上、`app` 自称 mesh，但 `proto`/`v`/`id` 形态不符 | 幽灵对端 | 当作外来进程，**不入对端表** |

> `userKey` 是提案字段：`/mesh/v1/health` 是未鉴权端点，所以它只能回**哈希前缀**（用于区分
> 「是不是我这个用户的节点」），不能回用户名 —— 否则等于把本机用户名广播给全网段。

### 3.1 为什么不再「静默退回随机端口」

当前行为（`lib/index.js:2122`）是警告一句然后 `listen(0)`。单机单 agent 时这是合理的降级；
多 agent 之后它会制造一批**组播看得见、扫描看不见、人也不知道它在哪**的节点 ——
正是本仓库最反对的那类状态：**看起来在，其实不可达**。

新策略：

```yaml
# 以下键名均为提案，尚未进入 Config schema
port: 45917            # 节点端口；改它要同时改对端 scanPorts
portFallback: "error"  # error（默认）| random
```

- 默认 `error`：起不来就明确失败，`mesh doctor` 打印「谁占了、怎么让」。
- `random` 只在**显式配置**时使用，且日志与名片都要标 `portEphemeral: true`。
  名片里端口本来就上报实际值，所以组播路径仍然可用；只是扫描兜底失效 —— 这是可以接受的已知边界，
  但要让人主动选择，而不是替他选。

### 3.2 多用户 / 多 mesh 域

节点是**每用户**的（UDS 在 `~/.mesh/`，权限 0600）。同一台机器两个用户时，第二个用户的节点
绑不上 45917：

- 默认：报错，提示 `MESH_PORT=45918`（环境变量名同样是提案；或 `portFallback: random`）。
- 不自动接管别人的端口 —— 接管意味着把另一个用户的配对密钥和账本暴露给第一个用户。

同一个用户想在同一台机器跑两个独立 mesh 域（测试、隔离环境）：
显式给 `MESH_HOME` + `MESH_PORT`。**默认不提供**，因为默认提供就会有人误用。

---

## 4. 本地通道：agent 怎么找到节点

| 平台 | 通道 | 权限 | 说明 |
|---|---|---|---|
| macOS / Linux | `~/.mesh/node.sock`（UDS） | 目录 0700，socket 0600 | 无端口、无 token，权限即认证 |
| Windows | `\\.\pipe\mesh-<userHash>`（命名管道） | 默认创建者独占 | Node 的 `net` 直接支持；路径不是文件，别去 `fs.exists` |
| 受限宿主（沙箱拦 UDS） | `127.0.0.1:<port>` + token | `~/.mesh/client.json` 0600 | 回退路径；token 每次启动轮换 |

**实现坑（先写在这里，免得踩）**：Node 的 `fetch()` 不接受 `socketPath`（要自定义 dispatcher），
本地客户端直接用 `http.request({ socketPath })` / `http.request({ path: pipe })` 更省事。
SSE 也一样，用 `http.request` 读流。

### 4.1 自动拉起与单例

```
agent 启动
  └─▶ 连接 ~/.mesh/node.sock
        ├─ 成功 ────────────────▶ 注册（§5），完事
        └─ ENOENT / ECONNREFUSED
              └─▶ 清理 stale socket（确认没有进程在听）
                    └─▶ detached 拉起 mesh-node
                          ├─ 等 socket 就绪（≤3s，指数退避）
                          ├─ 成功 ─▶ 注册
                          └─ 失败 ─▶ 内嵌模式（该宿主自己成为节点，见 §4.3）
```

- **socket 的存在就是锁**，不需要额外的 pid 锁。`node.json` 只用于诊断（pid、版本、端口、启动时间）。
- 节点 `KeepAlive` 交给系统（launchd / systemd / 计划任务），但**不强制安装**：
  「首次调用自动拉起」已经够用，开机自启是可选项。
- 节点被 `kill -9`：socket 残留 → 下一个客户端发现 `ECONNREFUSED` → 清理并重新拉起。
  账本已经在磁盘上，inbox 不丢。

### 4.2 内嵌模式是兜底，不是主路径

有些宿主（沙箱里的 IDE 扩展、无法 spawn 进程的环境）拉不起外部节点。此时：
**该宿主自己绑定 45917，成为节点**；如果绑定失败（已有节点），它只能当客户端。
这两种情况都不改变 I1 —— 谁是监听者由 `bind()` 决定。

> 这修正了路线图里 A1 的表述：不是「内嵌 or 守护二选一」，
> 而是 **一个节点实现，两种承载方式**：能 spawn 就守护，不能就内嵌。

---

## 5. 注册与唤醒

### 5.1 注册报文

```json
POST /v1/agents/register          // 走本地通道
{
  "agentId": "claude-code:default",   // 稳定 id：kind + scope
  "kind": "claude-code",
  "label": "Claude Code",
  "workspace": "/Users/peng/proj",    // 可选，用于按项目路由
  "wake": {
    "mode": "spawn",                  // spawn | delegate | none
    "cmd": "/Users/peng/.npm-global/bin/claude",
    "args": ["-p", "{{task}}", "--session-id", "{{newId}}", "--permission-mode", "acceptEdits"],
    "reuse": { "flag": "--resume", "idFrom": "sessionId" },
    "timeoutMs": 900000,
    "concurrency": 1
  },
  "tools": ["mesh_peers", "mesh_send", "mesh_wait", "mesh_tasks"],
  "wakeLevel": "L3"
}
```

- `wake.mode`：
  - **`delegate`**：agent 自己常驻，节点通过 agent 的 socket 发 `wake` 请求（DSH 插件、未来的 IDE 插件）。
    保住「进程内建会话」，这是 DSH 现在的能力。
  - **`spawn`**：节点执行宿主无头命令（`claude -p` / `opencode run` / `codex exec`）；
    宿主若提供 ACP server（本机实测 `opencode acp` 可用），**优先走 ACP**，能拿到事件流、
    权限请求与会话恢复，见路线图 §2.3。适合没有常驻会话的 CLI 宿主。
  - **`none`**：只收件箱（L1），不自动跑。
- 心跳 10s，TTL 30s；节点按 `agentId` 维护在线/忙闲/最近任务。
- 注册是幂等的；同名 `agentId` 重新注册即视为重启，旧会话绑定保留（`--resume` 需要）。

### 5.2 入站一条任务，节点做什么

```
对端 POST /mesh/v1/task { task, thread, agent? }
  │
  ├─ 1. 解析目标 agent：exact agentId → 该机器 defaultAgent → 报错并列出候选
  ├─ 2. 闸门（沿用现有 classifyInbound）：noWake / 长度 / 寒暄 / thread 上限 / 冷却 / 预算
  ├─ 3. 落 journal：queued
  ├─ 4. 按 wake.mode 分发
  │      delegate → POST agent.sock /wake，等 ack（超时 = agent 忙，排队）
  │      spawn    → detached 执行，stdin 喂任务，带超时/并发/工作目录/权限档
  │      none     → 仅入收件箱，事件 task.waiting-user
  ├─ 5. 收 agent 回报的 started / done / failed，写 journal + 事件流
  └─ 6. 回执走节点，不经过 agent（agent 不需要知道对端地址）
```

**关键取舍**：回执由节点发。这样 agent 不需要持有跨机凭据，也避免「agent 自己拼 URL」
导致的各种半成品实现。

### 5.3 唤醒预算（spawn 模式必须有）

| 闸 | 默认 | 为什么 |
|---|---|---|
| 超时 | 15 分钟 | 无头进程可能挂住；超时后 `failed` + 事件 |
| 并发 | 每个 agent 1 | 同一 CC 工作区并发写会互相覆盖 |
| 权限档 | 宿主默认档，不放宽 | `claude --permission-mode` 不传就按宿主默认 |
| 工作目录 | 注册时声明 | 防止在 `$HOME` 里跑 |
| 预算 | 继承 thread 预算（轮次/token） | 已有 54 会话 / 800 万 token 的教训 |

---

## 6. 寻址与名片

### 6.1 寻址

| 场景 | 写法 | 规则 |
|---|---|---|
| 老调用方 / 只有一个 agent | `peer="hos"` | 落到 `defaultAgent` |
| 指定宿主 | `peer="hos", agent="claude-code:default"` | 精确命中，找不到就报错，**不猜** |
| CLI | `mesh send hos --agent cc:default …` | 同上 |
| 同一 kind 多个（两个 CC 工作区） | `mesh_run(agent="claude-code:work")` | 注册时 `workspace` 可作二级路由 |

**不做** `hos#cc` 或 `cc@hos` 这类语法糖：`from` 字段已经长成 `machine/user` 的样子，
再引入一种分隔符只会让「到底是机器名还是 agent 名」更难判断。

### 6.2 名片 v3（在路线图基础上补 `agents[]`）

```json
{
  "v": 3, "app": "dsh-mesh", "proto": "dsh-mesh",
  "id": "<nodeId>", "machine": "lipeng-mac",
  "host": "192.168.1.3", "port": 45917, "version": "0.7.0",
  "hostKind": "node", "wakeLevel": "L3",
  "defaultAgent": "dsh:desktop",
  "agents": [
    { "id": "dsh:desktop", "kind": "dsh", "label": "DSH Desktop", "wakeLevel": "L3", "status": "idle" },
    { "id": "claude-code:default", "kind": "claude-code", "label": "Claude Code", "wakeLevel": "L3", "status": "busy" },
    { "id": "opencode:proj-x", "kind": "opencode", "label": "opencode", "wakeLevel": "L1", "status": "idle" }
  ],
  "capabilities": { "…": "defaultAgent 的，兼容旧版" },
  "transports": ["lan", "tsnet:home"]
}
```

- 顶层字段保持旧版语义：**旧对端读到的是「这台机器 + 默认 agent 的名片」**，不需要改代码。
- `agents[]` 是新字段，旧版忽略它即可（`PLUGIN-SPEC.md` FR-11.4：必须忽略未知字段）。
- 面板可以据此显示「这台机器上挂着 3 个 agent，其中 1 个忙」——这是可玩性的一部分。

### 6.3 默认 agent 的规则

1. 节点配置显式指定 `defaultAgent` → 用它。
2. 否则：有 `dsh` 就选 `dsh`（参考实现，行为最可预期）。
3. 否则：选 `wakeLevel` 最高、注册最早的。
4. **都不满足**（只有 L0/L1）→ 仍然接受任务，但事件里标 `waiting-user`，回执照实说
   「已入收件箱，不会自动跑」。**不允许静默接受后什么也不发生。**

---

## 7. 身份与状态迁移

这是本次改动唯一需要小心的地方：现在是**每 profile 一份**身份与状态，目标变成**每机器一份**。

| 数据 | 现在 | 目标 | 迁移 |
|---|---|---|---|
| `instanceId` | 每 profile 一个 UUID | 节点级 `nodeId` | **沿用最早那个 profile 的实例 id 作为 nodeId**，避免对端把它当「新机器」重新认领 |
| `machineName` | 每 profile 一个（FR-1.5 要求不同名） | 节点级一个 | 取最早 profile 的名字；第二个 profile 的名字降级为 `agents[].label` |
| 配对密钥 / 每对端策略 | 每 profile 一份 | 节点一份 | 合并；若两份不一致，**保留最早那份并记一条迁移日志**，不静默覆盖 |
| 账本 `tasks.json` | 每 profile 一份 | 节点一份 + `agentId` 字段 | 逐条补 `agentId`（旧记录留空 = `unknown`） |
| tailnet 通道 | 每 profile 一套 sidecar | 节点一套 | 取并集；同名不同 key 的冲突要报错，不能猜 |

> 迁移原则沿用仓库既有约束：**宁可显示「未决定」，也不要静默选一个**。

---

## 8. 资源账：为什么这比 N 个节点省

| 资源 | N 个独立节点 | 1 个节点 + N 个客户端 |
|---|---|---|
| TCP 监听 | N | 1 |
| 组播发送者 | N（同一网卡发 N 份心跳） | 1 |
| 扫描器 | N（每个都在扫 /24） | 1 |
| tailnet sidecar | N × 通道数（最贵的一项） | 通道数 |
| 身份 / 配对 | N 份（对端看到 N 台同名机器） | 1 份（对端看到 1 台机器、N 个 agent） |
| 账本 | N 份（无法回答「这台忙不忙」） | 1 份（能） |
| 端口冲突面 | N 个端口都可能被占 | 1 个 |

---

## 9. 迁移步骤（都能独立回滚）

| 步骤 | 做什么 | 验收 | 估时 |
|---|---|---|---|
| **M0** | 抽 `mesh-core`（路线图 P0/P1 已有） | 库可被 CLI 与插件同时引用 | 已有 |
| **M1** | 节点单例：`bind()` 选举、UDS/named pipe、`node.json`、自动拉起 | 同机连起 3 个客户端，只有一个监听 | 3 人日 |
| **M2** | 注册 + `agents[]` 名片 + 寻址（`agent` 参数、default 规则） | 旧对端派任务仍落到 default；指定 agent 精确命中 | 2 人日 |
| **M3** | DSH 插件改为 `delegate` 客户端：面板的 peers/tasks/scan 数据路由改从节点取（web 投屏与 SSH 仍留在插件侧）；保留内嵌兜底开关 | DSH 重启后节点不掉线；进程内唤醒仍可用；面板不出现两份数据源 | 4 人日 |
| **M4** | `mcp-mesh` 改为纯客户端：删组播与「抄 DSH peer 表」 | 仓库里只剩一份发现实现 | 2 人日 |
| **M5** | `mesh doctor` 增三项：socket 通路、agent 注册、端口归属 | 三种故障各自给出不同提示 | 1 人日 |

**总计约 12 人日**（另：tailnet 通道归属从插件迁到节点约 2 人日，可推迟到 P2），
落在路线图 P1 里 → P1 从 ≈12 人日调整为 ≈24 人日。
**P0 不受影响**（事件流、信封、名片 v3 的字段定义都不依赖节点形态）。

---

## 10. 验收用例（写成 TEST-CASES 的新条目）

| ID | 场景 | 期望 |
|---|---|---|
| NODE-01 | 同机跑 DSH + CC + opencode + CLI | 只有 1 个 TCP 监听；`mesh doctor` 列出 4 个 agent |
| NODE-02 | 不带 `agent` 派任务 | 落到 default，日志写明为什么是它 |
| NODE-03 | 指定不存在的 `agent` | 明确报错 + 候选列表，**不**回落 |
| NODE-04 | 45917 被外来进程占 | 默认启动失败并给出处置建议；配 `portFallback: random` 后能起，名片标 `portEphemeral` |
| NODE-05 | 两个用户各起节点 | 互不接管、互不并账；第二个用户显式配端口后可用 |
| NODE-06 | 旧版对端（v2）派任务 | 正常落到 default，回执可读 |
| NODE-07 | `kill -9` 节点后客户端再调用 | 自动重新拉起；inbox 不丢；对端看到的是「短暂离线」而不是新机器 |
| NODE-08 | 同一 kind 两个 agent | 精确 id 命中；歧义时报错，不随机选 |
| NODE-09 | 内嵌兜底：无法 spawn 的宿主 | 自己成为节点；已有节点时作为客户端接入 |
| NODE-10 | 幽灵对端（`proto` 不符） | 不入表；面板不显示成一台机器 |

---

## 11. 被否掉的方案

| 方案 | 为什么不选 |
|---|---|
| **每 agent 固定端口（45917+n）** | 需要全局注册表与扫描表；换端口即失联；防火墙规则翻倍；这正是本文要消掉的东西 |
| **端口即身份**（URL 里带端口当 id） | 回退随机端口、容器重启、端口转发都会让它失效 |
| **每个 agent 一个独立节点** | N 份状态/组播/sidecar/配对；对端看到 N 台同名机器；无法回答「这台忙不忙」 |
| **mDNS-SD 替代组播** | 平台实现差异大（Android 时好时坏），而我们已有组播 + 扫描两条路；可作为未来可选，不当下依赖 |
| **只走 UDS，不要 TCP** | 跨机必须 TCP；UDS 是本地优化，不是替代 |
| **系统级 root 服务** | 对「一个人 2–5 台设备」的场景，增加权限面的收益为负 |
| **`machine#agent` / `agent@machine` 语法糖** | 与现有 `machine/user` 混淆；用独立 `agent` 参数更不容易猜错 |

---

## 12. 与路线图的关系

- 本文落实路线图 §2.4 的「一个核心，四种壳」，并补上「**一机一节点**」这条不变量。
- 路线图 A1 的建议从「库 + 可选守护」细化为：
  **一个节点实现，两种承载（spawn 守护 / 内嵌兜底），由 `bind()` 决定谁是监听者。**
- 路线图 P1 增加 M1–M5，工作量上调；P0 不变。
- 旧的「同机多实例：不同 `port` + 对方 `scanPorts`」从现在起标记为**历史兼容用法**，
  README §已知限制 #4 与 `TEST-CASES.md` INST-05 在新模型落地后应改写为「无需此配置」。
