# 五个 Agent Mesh 项目的通信协议对照

> 研究笔记 · 2026-10-23 · 核对自各项目仓库与代码，不是规范文档
>
> 范围：Solace Agent Mesh、EnvoyMesh、AgentsMesh、google/agentmesh、dsh-plugin-mesh。
> 目的：为 [`ROADMAP.md`](./ROADMAP.md) 的 H1（交账）/ H3（A2A）判断提供依据。
> 所有「mesh」条目均对照本仓库代码核对（`lib/discovery.js`、`lib/index.js`），
> 其余四个对照各自 README 与协议文件；来源见文末。

---

## 0. 结论先说

**这五个项目不在同一层。** 两个是真 P2P 网格协议（EnvoyMesh、google/agentmesh），
一个是中心编排平台（AgentsMesh），一个是事件总线上的 A2A 宿主（Solace），
而 mesh 是 harness 内的轻量 RPC。放在一张表里比，容易得出「mesh 很弱」的错觉 ——
它其实选了另一条路：**用跨网与身份上限，换零依赖与零账号。**

---

## 1. 维度对照

| 维度 | Solace Agent Mesh | EnvoyMesh | AgentsMesh | google/agentmesh | dsh-plugin-mesh |
|---|---|---|---|---|---|
| 拓扑 | 事件 broker 中枢 | P2P + 可选 relay | 中心后端 + 自托管 Runner | 控制面 + Router + 节点（数据面可直连） | 无中心，局域网直连 |
| 发现 | broker 上的 agent 目录 | libp2p mDNS + DHT | 后端注册表 | Router 的 Kademlia DHT 目录 | UDP 组播 + /24 扫描 + ping |
| 传输 / 线格式 | 事件主题（pub/sub）+ A2A | libp2p（TCP/QUIC）+ 签名信封 | gRPC+mTLS（控制）、WebSocket（终端流） | libp2p + protobuf（`agentmesh.proto`） | HTTP/1.1 + JSON，固定端口 45917 |
| 身份 | 企业凭据 / broker 账号 | Ed25519 + 自持 DID | 组织/团队账号，后端 PKI 签 runner 证书 | OIDC 注册 → Biscuit 能力令牌；peerID 由 Ed25519 公钥派生 | 自述 UUID + 机器指纹，**无密钥** |
| 消息完整性 | broker 层 TLS + A2A 消息 | **每条信封签名**，验签 + 防重放 | mTLS 信道 | Biscuit 离线验签 + libp2p 握手证明持钥 | 无签名 |
| 任务语义 | A2A 标准（Task/Message/Artifact） | 信封内 agent task + 信任层级 | Ticket / Pod / Autopilot | service 调用 + 策略授权（非任务状态机） | 文本派发 + thread，**无终态** |
| 权限 | topic ACL / 企业策略 | 策略引擎（blocked / public / referred / direct） | RBAC + 组织隔离 | 按 **service name** 授权，默认不可达 | 可选共享配对码，默认关 |
| 跨网 | broker 本身可达即可 | relay / circuit relay | 中心可达即可 | relay + 多 Router | 内置 tsnet（用户态 Tailscale） |
| 部署依赖 | 事件 broker（生产需商业授权） | 桌面节点，可选 relay | 后端 + Runner 集群 | 控制面 + Router（可单机 `agentmesh-one`） | 零服务端，装插件即可 |
| 许可 | BUSL-1.1 | 自有许可 | BSL-1.1 | Apache-2.0 | MIT |

---

## 2. 各自的关键机制

**Solace Agent Mesh**
把 A2A 跑在事件总线上。agent 不互相直连，而是往主题发消息，broker 负责路由、
扇出与持久化。好处是企业级可靠性与解耦，代价是必须有一个 broker（生产需商业
授权或上云）。运行时是 SAC + Google ADK，工具体系走 MCP。

**EnvoyMesh**
双协议：libp2p 做发现与打洞，消息是**签名信封**，relay 只转发不解密；
身份是用户自持的 Ed25519 DID，信任分四层（blocked / public / referred / direct）；
手机是 thin client（JSON-RPC over WebSocket 或 libp2p circuit），
agent 通过 HTTP bridge 接入、**不持有身份密钥**。

**AgentsMesh**
严格说不是「网格协议」，是调度平台。控制面用 gRPC+mTLS 下发指令，终端字节走
无状态 WebSocket Relay 集群；「Mesh & Channels」是 pod 之间的协作拓扑与 @mention
频道，不是网络层。它解决的是「一个人管一百个 agent」，不是「两台机器怎么找到彼此」。

**google/agentmesh**
Router 是 libp2p peer + Kademlia DHT 目录；节点注册时用 OIDC 换 **Biscuit 能力令牌**
（可离线验证、可按任务衰减）；策略按服务名授权、默认不可达；对 agent 暴露本地
MCP server 和 OpenAI 兼容 API —— **它把 mesh 藏在 MCP 后面**。

**dsh-plugin-mesh**
组播心跳（`239.255.42.99:45892`，5 秒一次）+ 主动扫 /24 + 每 10 秒
`GET /mesh/v1/health`；任务就是 `POST /mesh/v1/task` 一个 JSON，回信是再派一条。
跨网靠内置 tsnet，**任务鉴权不做任何身份绑定**，配对码默认关闭。

---

## 3. 同与不同

### 3.1 行业已经收敛的四点

1. **没人自研发现协议** —— libp2p / mDNS / DHT / broker 目录，全是成熟件。
2. **身份都在往「密钥对 + ID 由公钥派生」走** —— EnvoyMesh 的 DID、google 的 `12D3KooW…`。
3. **任务语义都在标准化**（A2A 或 Task 状态机），没人再满足于「发一段文本」。
4. **控制面与数据面分离**是共识：google 明确说控制面不在数据路径上，Solace 用
   broker 解耦，EnvoyMesh 的 relay 不解密 payload。

### 3.2 三条真正的差异轴

| 轴 | 从强到弱 |
|---|---|
| 中心化程度 | AgentsMesh（重中心）> Solace（broker）> google（控制面必需、数据面直连）> EnvoyMesh（relay 可选）> **mesh（无中心）** |
| 身份强度 | EnvoyMesh / google（密码学身份 + 验签）> Solace（企业凭据）> AgentsMesh（中心签发）> **mesh（自述 ID，无签名）** |
| 任务语义 | Solace（A2A + 工件）> google（服务调用 + 策略）> EnvoyMesh（信封任务 + 信任层级）> AgentsMesh（Ticket/Pod）> **mesh（文本派发，无终态）** |

---

## 4. 对 mesh 的三条判断

1. **独特性是真的**：五个里唯一「零服务端、零账号、装插件就能连」。这条护城河
   别人要放弃自己的架构才追得上。
2. **短板也真的短**：身份是自述的、任务没有终态。这正好对应路线图 H1（交账）
   与 H3（A2A），不是巧合。
3. **有一份现成的身份被浪费了**：跑 tsnet 时设备在 tailnet 里已有 WireGuard 密钥与
   Tailscale 节点身份，但派发逻辑仍信任对端自报的名字。**这是最便宜的身份升级路径**，
   比自己新造一套密钥体系省事得多。

> 补充判断：google 与 EnvoyMesh 都选了 libp2p + Ed25519 + DHT，说明「去中心 agent
> 网格」的工程答案基本收敛。mesh 自研组播 + HTTP 是「轻」的选择，代价是跨网与身份
> 要另找方案 —— 跨网已用 tsnet 补上，身份还没补。

---

## 5. TOFU 是什么

**TOFU = Trust On First Use，首次使用即信任。**

三步：

1. 第一次见到某个对端，记下它的身份（通常是公钥指纹）；
2. 以后同一身份直接放行，不再问；
3. 身份变了就告警或要求重新确认。

最熟悉的例子是 SSH：第一次连新机器问一次 `yes/no`，写进 `known_hosts`；
以后不再问，指纹变了就拒绝。Syncthing 的「设备 ID + 首次确认」同理。

### 5.1 在 mesh 里有个前提没满足

**严格意义的 TOFU 需要一对设备密钥。** Mesh 现在只有自述的 16 位 UUID 和机器指纹，
没有公私钥、没有签名。所以现在能做的只是「记住 instanceId」的**弱版** ——
能防误连与幽灵对端，防不了冒充（ID 是对方自己填的）。

| 方案 | 记住什么 | 防幽灵 / 误连 | 防冒充 | 需要什么 |
|---|---|---|---|---|
| 弱版（现在能做） | instanceId | ✅ | ❌ | 无 |
| 真 TOFU | 公钥指纹 | ✅ | ✅（首次除外） | 设备 Ed25519 密钥对 |
| 配对码（已有） | 共享秘密 | ✅ | ✅ | 人工传一次码 |

### 5.2 它不是什么

- 不是 PKI、不是证书链、不是账号体系；
- **不解决「第一次见面就已被中间人」** —— 这是 TOFU 的固有缺口，它只是把
  「每次都要验证」降成「验证一次」；
- 和配对码不是一回事：配对码是**共享秘密**（事先约定同一个值），TOFU 是
  **记住首次见到的指纹**（不需要事先约定）。两者可叠加。

### 5.3 当前取舍

路线图 Q3 选择「保持零配置」，于是确认点从「每个新对端」挪到「每个高危动作」：
普通派发不问，`rm -rf` / 写系统目录 / 权限变更才问。

这比 TOFU 更轻，但挡不住「先派个无害任务摸清机器」—— 该残余风险已写进
`ROADMAP.md` §5。

### 5.4 如果以后要补身份

最小路径不是 TOFU，而是三步（可放 H2，不必等 1.0）：

1. `hello` 里带 Ed25519 公钥，peerId 由公钥派生（对齐 google / EnvoyMesh）；
2. 首次记录指纹，之后不匹配就拒绝；
3. 走 tsnet 时直接用 tailnet 身份，跳过自建这一层。

---

## 6. 术语表

> 只收本文真正用到的词。一句话定义 + 它在这里为什么重要。

### 6.1 网络与发现

| 术语 | 一句话 | 为什么在这里重要 |
|---|---|---|
| **DHT**（分布式哈希表） | 一张切片分散在很多节点上的查号表，按 key 逐跳查找，无需中心 | EnvoyMesh 用它做跨网发现；决定「无中心」能否成立 |
| **Kademlia** | DHT 最常用的算法：节点 ID 与 key 同空间，按 XOR 距离分桶，log N 跳收敛 | google/agentmesh 的 Router 之间就是 Kademlia |
| **mDNS** | 局域网内的组播 DNS，同一广播域里互相喊名字 | 只管一个局域网，出不了路由器 |
| **libp2p** | 模块化 P2P 网络栈：传输、加密握手、多路复用、发现、DHT、中继都有现成的 | EnvoyMesh 与 google/agentmesh 的共同底座 |
| **circuit relay** | 中继节点替「无法被入站连接」的节点转发流量 | 解决 NAT 后不可直连；设计中继默认读不到 payload |
| **控制面 / 数据面** | 控制面管「谁能进、能做什么」；数据面走真正的业务流量 | 除 mesh 外的四个都在分离两者；mesh 干脆没有控制面 |
| **组播广播域** | 一次发送、同网段所有设备都能收到 | mesh 的局域网发现靠它，规模一大就失效 |

### 6.2 身份与信任

| 术语 | 一句话 | 为什么在这里重要 |
|---|---|---|
| **Ed25519** | 基于 Curve25519 的签名算法，密钥短、签名快、确定性 | EnvoyMesh / google 的身份基石；mesh 目前没有 |
| **DID** | 去中心标识符（`did:method:id`），不依赖中心注册表解析 | EnvoyMesh 的「自持身份」就是它 |
| **签名信封** | 把消息和发送者签名打包成一体，接收方验签后才处理 | EnvoyMesh 每条消息都这样做，mesh 不做 |
| **能力令牌**（capability token） | 一张「持有者被允许做什么」的签名凭证，可离线验证、可再收窄 | google 用 Biscuit 实现；比「你是哪个账号」更细 |
| **Biscuit** | 具体的能力令牌格式，带 Datalog 策略，支持**离线衰减**（把权限切小再转授） | google/agentmesh 的授权核心 |
| **TOFU** | 首次使用时信任并记住对方身份，之后变化即告警 | 详见 §5；mesh 的零配置 vs 安全的折中点 |
| **配对码** | 双方事先约定的共享秘密，用来确认彼此是同一批设备 | mesh 已有；与 TOFU 互补而非替代 |
| **Sybil / Eclipse** | Sybil＝一个实体伪造大量身份；Eclipse＝挤满目标的邻居表把它隔离 | DHT 类系统的典型攻击面，mesh 目前不暴露于此 |

### 6.3 协议与消息

| 术语 | 一句话 | 为什么在这里重要 |
|---|---|---|
| **A2A**（Agent2Agent） | agent 间标准协议：Agent Card、Task 状态机、Message、Artifact，可流式/推送 | Solace 直接跑它；mesh 计划在 1.0 做适配器 |
| **MCP**（Model Context Protocol） | agent 与工具/资源之间的标准协议（JSON-RPC） | 已成工具层事实标准；google 把 mesh 藏在 MCP 后面 |
| **pub/sub 与 broker** | 生产者往主题发、broker 负责分发，双方互不知道对方地址 | Solace 的通信中枢；代价是必须有 broker |
| **gRPC + mTLS** | HTTP/2 上的 protobuf RPC，双向证书认证 | AgentsMesh 的 Runner↔后端控制通道 |
| **JSON-RPC** | 用 JSON 表达「调哪个方法、带什么参数」的轻量 RPC | EnvoyMesh 手机 thin client 用它；mesh 的 HTTP JSON 是同一档 |
| **protobuf** | 二进制、带 schema 的结构化序列化 | google/agentmesh 的线格式；mesh 用 JSON |

### 6.4 形态与机制

| 术语 | 一句话 | 为什么在这里重要 |
|---|---|---|
| **thin client** | 手机只做「遥控器」，不跑节点、不持密钥 | EnvoyMesh 的手机方案；mesh 的手机是真节点 |
| **租约**（lease） | 注册带有效期，必须续期，过期即视为下线 | google 的 Router 用租约；mesh 的心跳 TTL 是同一思路 |
| **peer routing / content routing** | DHT 的两种查询：按 peerID 找地址、按内容哈希找持有者 | 理解 DHT 到底提供什么，避免把它当万能网 |

---

## 7. mesh 协议实测细节（代码口径）

| 项 | 值 | 出处 |
|---|---|---|
| 组播组 / 端口 | `239.255.42.99` / `45892` | `lib/discovery.js` |
| 心跳间隔 / TTL | 5s / 20s | `lib/discovery.js` |
| 数据面端口 | 45917（被占用时回退随机端口） | `lib/index.js` |
| 保活 | 每 10s `GET /mesh/v1/health` | `lib/index.js` |
| 派发 | `POST /mesh/v1/task` | `lib/index.js` |
| 任务字段 | `id` / `from` / `fromMachine` / `task` / `thread` / `originSession` / `noWake` / `newSession` / `workspace` | `lib/index.js` |
| 鉴权 | 可选共享配对码，不匹配返回 403，默认关 | `lib/index.js`、`lib/pairing.js` |
| 初始状态 | `accepted`（无终态机） | `lib/index.js` |

---

## 8. 来源

- Solace Agent Mesh：<https://github.com/SolaceProducts/solace-agent-mesh>
  · A2A over Solace 的能力描述见 <https://pypi.org/project/solace-agent-mesh/>
- EnvoyMesh：<https://github.com/allenpeng0705/EnvoyMesh>
- AgentsMesh：<https://github.com/AgentsMesh/AgentsMesh>
- google/agentmesh：<https://github.com/google/agentmesh>
  · 协议定义 <https://github.com/google/agentmesh/blob/main/api/agentmesh.proto>
  · 架构 <https://github.com/google/agentmesh/blob/main/site/content/docs/concepts/architecture.md>
- dsh-plugin-mesh：本仓库 `lib/`、`MESH-DEFINITION.md` 附录 B

> 口径提醒：各项目的 star 数、活跃度会变，本文不记这些易变数字；
> 需要时按 `ROADMAP.md` 附录 A 的方法现查。
