# dsh-plugin-mesh 插件规范

## 功能需求清单 · 架构逻辑 · 通信协议（多版本）· 跨 IDE 实现契约

> **这份文档的唯一目的**：让后续的 AI（或人）只读这一份文档，就能在任意 IDE / Agent 宿主上实现一个与参考实现 **线级互通** 的 Mesh 插件。
>
> - 参考实现：`dsh-plugin-mesh` **0.3.36**（DSH / cordis 插件）
> - 协议现状：发现卡片 **v2**、对端 HTTP API **v1**、sidecar 控制协议 **v1**
> - 配套用例：[`TEST-CASES.md`](./TEST-CASES.md)。本文每个需求都标注了验收用例编号。
> - 规范性用语：**MUST**（必须，违反即不兼容）/ **SHOULD**（应该，省略需在实现说明里写明理由）/ **MAY**（可选）。
> - 文中标 **「草案」** 的内容是**尚未在参考实现中落地**的提案，用于跨 IDE 实现时对齐，不得声称已存在。

---

## 目录

1. [范围、术语与设计原则](#1-范围术语与设计原则)
2. [功能需求清单（FR）](#2-功能需求清单fr)
3. [架构逻辑](#3-架构逻辑)
4. [通信协议（多版本）](#4-通信协议多版本)
5. [跨 IDE 实现契约](#5-跨-ide-实现契约)
6. [验收与一致性测试](#6-验收与一致性测试)
7. [附录](#7-附录)

---

# 1. 范围、术语与设计原则

## 1.1 产品一句话

在**同一局域网**（可选跨互联网）内自动发现其他运行着 Agent 的机器，把一条自然语言任务**双向派发**给对方机器上的 Agent 执行，并让执行结果回到发起方的**原会话**。

## 1.2 术语

| 术语 | 英文 / 标识 | 含义 |
|---|---|---|
| 节点 / 本机 | Node / Self | 一个运行 Mesh 插件的宿主实例 |
| 对端 | Peer | 通过发现协议看到的另一台机器 |
| 实例 | Instance | 一个 profile 在宿主里的逻辑身份，用持久 `instanceId` 标识 |
| 机器名 | `machine` | 人类可读名，用于派发寻址与 UI；可重名，重名必须显式处理 |
| 指纹 | `fingerprint` | 物理机级哈希，仅用于"同一台机器换了 instanceId"的认领 |
| 名片 | Card / `selfRecord` | 本机对外自述的 JSON 对象（心跳与 health 共用主体） |
| 端点 | Endpoint | 一台设备的一条可达路径：`transport + host + port` |
| 通道 | Transport | `lan` 或 `tsnet` |
| 任务 | Task | 一次派发请求及其元数据 |
| 线程 | `thread` | 同一件事的标签，用于复用会话与限速记账 |
| 会话键 | Conversation Key | `hash(来源机器名, thread)`，每端独立计算，决定"用哪个会话处理" |
| 回信地址 | `originSession` | **发送方**的会话 id，仅用于把结果送回哪个会话，**绝不能**用来在本机找会话 |
| 宿主 | Host | 运行插件的 IDE / DSH / 编辑器 |
| 适配器 | Adapter | 把宿主能力（建会话、注入消息、注册工具、渲染 UI）接到 Mesh 核心的薄层 |

## 1.3 角色模型

```
┌──────────┐   派发任务 POST /mesh/v1/task    ┌──────────┐
│  A 机     │ ───────────────────────────────▶ │  B 机     │
│ 发起会话 S│                                  │ 收到任务  │
│          │ ◀─────────────────────────────── │ 建/复用会话│
└──────────┘   回派结果（同样是 /task）          └──────────┘
```

- **对等**：没有服务器/客户端之分，每台机器同时是对端 HTTP 服务端与客户端。
- **不对称只体现在信任边界**：谁发起任务，谁的回传地址（`originSession`）由谁决定。
- **没有中央协调器**：发现靠组播/扫描，派发靠直连。任何"云端账号"都不是必需项。

## 1.4 设计原则（实现时必须遵守的判断依据）

| # | 原则 | 具体含义 | 反面案例（真实踩过） |
|---|---|---|---|
| D1 | **零配置发现** | 默认配置下两台同网段机器应能自动看见彼此，不需要填 IP、不需要账号 | 要求手工填端口/地址 |
| D2 | **失败必须可辨识** | 超时 ≠ 没装；未报 ≠ 没有；离线 ≠ 不存在 | 探测超时被渲染成"什么运行时都没装" |
| D3 | **未知不是否定** | 对端没报能力时，不能据此排除它 | Placement 把"未知"当"没装" |
| D4 | **发现公开、控制可收紧** | 同网段可见是设计取舍；控制接口可用配对码保护 | 把配对码放进组播 |
| D5 | **不硬拒版本** | 现场多台机器不可能同时升级；缺字段就降级 | 版本不匹配直接断连 |
| D6 | **局域网优先** | 同网段不走 tsnet，省 DERP 与用户态转发开销 | 两条通道争一个槽位 |
| D7 | **协议与宿主解耦** | 线级协议不出现任何 IDE/DSH 专有字段 | 把 `sessionId` 当成跨机可用的 id |
| D8 | **单实例、可并存** | 同机多个 profile 各自独立，不互相顶掉；整机一个 tsnet 节点 | 同机两实例互相删除记录 |
| D9 | **任何附加能力失败都不拖垮宿主** | Mesh 挂了，DSH/IDE 仍要能正常用 | 初始化异常导致宿主起不来 |
| D10 | **不静默失败** | 每个"没做"都要有 `status` / `reason` / 日志 | 任务停在 `accepted` 永远不动 |

## 1.5 非目标（明确不做）

- 不做远程 Shell / 远程文件系统；任务正文是自然语言，不是命令通道。
- 不做中央服务器或 SaaS；不采集截图、不上传工作区。
- 不做模型代理；任务由对端 Agent 用它自己的模型执行。
- 不做公网穿透以外的 NAT 打洞自研；跨网依赖可选的 tsnet。
- 不做离线排队重投（参考实现没有；实现为可选扩展，但必须显式标注）。
- 不承诺对抗恶意内网；配对码只防误连与普通设备，不防嗅探。

---

# 2. 功能需求清单（FR）

> 优先级：**P0** = 任何实现的最小可用集；**P1** = 完整实现应有；**P2** = 可选增强。
> "验收"列指向 [`TEST-CASES.md`](./TEST-CASES.md) 的用例。

## 2.1 身份与命名（FR-1）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-1.1 | P0 | 每个 profile 必须有**持久** `instanceId`（16 位 hex），写入状态文件；重启不变 | DISC-16 |
| FR-1.2 | P0 | 机器名可配置；未配置时用主机名，并在 UI 首次启动时询问一次 | UI-04 |
| FR-1.3 | P0 | 机器名校验：非空、不含 `/` 与 `\`、不含控制字符、≤32 字符；配置里的名字优先于状态文件，改名时不得静默覆盖配置 | UI-04/05 |
| FR-1.4 | P1 | 采集物理机指纹（sha256 截断 16 位 hex），仅用于"instanceId 变了但确认是同一台机器"的认领；空指纹不得参与认领 | DISC-13/14/15 |
| FR-1.5 | P0 | 同机多实例必须各有独立 `instanceId`，互不顶替；**各实例必须使用不同机器名**（同名 + 同指纹会被认领，见 §3.5.3） | DISC-11/14、INST-09 |
| FR-1.6 | P1 | 改名后立即重新广播（不等下一个心跳周期） | DISC-08 |
| FR-1.7 | P1 | 身份分层：`instanceId` 是身份，`fingerprint` 只是认领线索，MAC 不得作为身份 | DISC-09/13 |

## 2.2 发现（FR-2）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-2.1 | P0 | UDP 组播发现：向 `239.255.42.99:45892` 发 JSON 心跳，周期默认 5s，同时监听同组；支持多网卡 | DISC-01/10 |
| FR-2.2 | P0 | 主动扫描：并发探测本机所在 /24 的 mesh TCP 端口（默认 45917），启动时扫、周期默认 60s、可手动触发 | DISC-02/03/04/21 |
| FR-2.3 | P0 | 已知对端保活：每 10s `GET /mesh/v1/health`，让发现一旦建立就不再依赖组播 | DISC-05 |
| FR-2.4 | P0 | 超过 `peerTtlMs`（默认 20s）无任何证据 → 标记离线但保留记录；超过 `keepMs`（默认 5min）→ 丢弃 | DISC-06/07 |
| FR-2.5 | P1 | 每台设备可有多条端点（lan / tsnet），端点级健康独立；任一条通即在线 | TS-07/08、DISC-22 |
| FR-2.6 | P0 | 端点选择：局域网优先；只把网络层失败当作切换理由，HTTP 4xx/5xx 不切换 | TS-07 |
| FR-2.7 | P1 | 网络切换（Wi-Fi→有线/热点）后，心跳中的地址 ≤5s 自愈 | DISC-09 |
| FR-2.8 | P1 | 重名治理：只在"同名且在线 >1"时告警；UI 派发时若仅一台在线可自动选中；Agent 工具参考实现较严格（>1 匹配即拒绝，要求 `ip:port`），新实现可统一为"唯一在线可选"但必须写进实现说明 | DISC-12、DISP-05/06 |
| FR-2.9 | P1 | 按地址去重：同一 `host:port` 的旧记录必须被新记录顶掉 | DISC-17 |
| FR-2.10 | P1 | 支持 `scanRanges` / `scanPorts` 扩展扫描范围 | DISC-19 |
| FR-2.11 | P2 | 组播被完全屏蔽时，扫描兜底必须仍能发现（不要求 5 秒内，但要求最终可达） | DISC-18 |
| FR-2.12 | P0 | 测试不得污染真实网络：自测使用私有组播组与端口 | AUTO-07 |

## 2.3 能力名片（FR-3）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-3.1 | P1 | 采集运行时（node/python/go/docker/git/ffmpeg 等）、CPU、内存、GPU、工作区提示；采集必须有超时且不阻塞启动 | CAP-01/10/12 |
| FR-3.2 | P1 | 能力随名片广播，对端可见；采集完成立即重播一次心跳 | CAP-02/12 |
| FR-3.3 | P0 | **三种"不知道"必须可区分**：`null`（对端未报）/ `{}`（报了但为空）/ 过期（`capabilitiesAt` 超阈值） | CAP-03/04/06 |
| FR-3.4 | P0 | 名片来自网络，必须净化后存储（长度截断、版本号只留数字点、数组限量）；不得直接进 UI 执行 | CAP-05 |
| FR-3.5 | P0 | 探测不确定必须上报：`runtimesIncomplete` / `probeFailCount`；失败明细 `probeErrors` **只在本地**，不上名片 | CAP-07 |
| FR-3.6 | P1 | 名片按 `capabilitiesAt` 单调更新，旧包不得覆盖新数据 | CAP-11 |
| FR-3.7 | P2 | GPU 解析覆盖 macOS / NVIDIA / Windows；无 GPU 时 `gpu=null`，不得报错 | CAP-09 |
| FR-3.8 | P1 | 探测 PATH 必须补全 GUI 启动时的极简 PATH；并在本地暴露实际使用的 PATH 供排障 | CAP-08 |
| FR-3.9 | P2 | 能力采集周期默认 10 分钟；心跳复用缓存，不得每 5 秒 spawn 子进程 | CAP-10 |

## 2.4 任务派发（FR-4）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-4.1 | P0 | 提供 Agent 工具 `mesh_run(peer, task, thread?, noWake?, newSession?, workspace?)` | DISP-01 |
| FR-4.2 | P0 | `peer` 支持机器名 / `instanceId` / `ip:port`；不得接受 `machine/user` 作为 peer | DISP-04/07、BUG-04 |
| FR-4.3 | P0 | 派发是**异步受理**语义：返回"已派发"不等于完成，文案必须说清 | DISP-02 |
| FR-4.4 | P0 | 请求失败必须给出可操作原因：离线、找不到、重名、403、超时 | DISP-03/04/05/08/09 |
| FR-4.5 | P0 | 派发前登记回传绑定：把"目标机器 + thread"映射到**发起方当前会话**，再发 HTTP | DISP-10/11 |
| FR-4.6 | P1 | 幂等：同一任务 `id` 重复 POST 不得重复入箱/重复唤醒；返回 `duplicate: true` | DISP-24 |
| FR-4.7 | P1 | 任务正文上限 256 KB；超限必须拒绝且给出明确错误 | DISP-25、SEC-08 |
| FR-4.8 | P1 | 记录最近 200 条派出记录（内存即可，重启可丢） | DISP-20 |
| FR-4.9 | P0 | 提供 `mesh_peers` / `mesh_scan` / `mesh_tasks` 三个配套工具 | DISC-04、DISP-20 |
| FR-4.10 | P2 | 没有离线排队时不假装成功；直接失败并说明 | DISP-03 |

## 2.5 入站与唤醒（FR-5）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-5.1 | P0 | 监听 `0.0.0.0:<port>`（默认 45917），提供 `/mesh/v1/*`；端口被占时回退随机端口并明确告警 | INST-05 |
| FR-5.2 | P0 | 收到任务先入箱并尽快回 200（受理），再异步处理；不得让 HTTP 请求等待 Agent 跑完 | DISP-01 |
| FR-5.3 | P0 | 会话键命中且会话仍活跃 → 注入原会话；否则新建；`newSession` 强制新建 | WAKE-01/05/06 |
| FR-5.4 | P0 | 新建前若原会话已结束，SHOULD 先尝试 `resume`；失败则新建并记录原因，消息不得丢 | WAKE-17/18 |
| FR-5.5 | P0 | 投递给 Agent 的提示词 MUST 包含：任务 id、来源、线程、任务正文、回派指令（peer 为机器名）、"不要只本地回复"、回执收敛要求 | DISP-21 |
| FR-5.6 | P0 | 闸门顺序：`noWake` → 正文过短 → 纯寒暄 → 滑动窗口上限 → 冷却；被挡时只入箱且写原因 | WAKE-02/03/04/07/09 |
| FR-5.7 | P0 | 注入已有会话不受冷却约束（冷却只防"建会话风暴"） | WAKE-08 |
| FR-5.8 | P1 | 同一会话键并发建会话必须只建一个：占位 + 排队 + 按到达顺序排空 | WAKE-12/13 |
| FR-5.9 | P1 | 队列上限（默认 8）后必须背压 `busy`，不得无限占内存 | WAKE-14 |
| FR-5.10 | P0 | 所有路由结果必须写入任务记录：`status` + `routeDecision`，失败写 `dispatchError`，且可被对端 GET 读取 | WAKE-15/16 |
| FR-5.11 | P0 | 对端任务是外部不可信输入：新建会话默认 `permissionPreset=workspace-write`，禁止默认 `danger-full-access` | SEC-14、WAKE-21 |
| FR-5.12 | P2 | 若宿主支持推理强度，新建/恢复会话时必须保留 agent preset 解析出的 `reasoningEffort`，不得丢失 | WAKE-20 |

## 2.6 线程、会话与回传（FR-6）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-6.1 | P0 | 会话键 = `sha256(fromMachine + "\0" + thread).hex.slice(0,12)`，键 = `${fromMachine}#${hash}`；每端独立计算 | DISP-12/16 |
| FR-6.2 | P0 | 无 `thread` → 一次性任务：不建绑定、不限速、每次新建会话 | DISP-15 |
| FR-6.3 | P0 | `originSession` 只是回信地址；**禁止**用它在本机查找/复用会话 | DISP-10、BUG-02 |
| FR-6.4 | P1 | 同一 thread 已绑定另一会话时，新的发起必须被拒绝，不得覆盖绑定 | DISP-17 |
| FR-6.5 | P0 | 回传走同一 `/mesh/v1/task`，带原 `thread`；发起方据此把结果注入原会话，零新建 | DISP-10/22 |
| FR-6.6 | P1 | 回传绑定必须在发 HTTP **之前**登记，覆盖"对端回得比响应还快"的竞态 | DISP-11 |
| FR-6.7 | P0 | 防 ping-pong：提示词要求"纯回执带 noWake、无新结论不回派"；闸门兜底 | WAKE-02/04 |

## 2.7 安全与访问控制（FR-7）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-7.1 | P0 | 默认免配对（零配置）；支持开启 `requirePairing`，开启后所有控制接口校验 `X-Dsh-Mesh-Token` | SEC-01/04/05 |
| FR-7.2 | P0 | 配对开关必须**即时生效**（不重启）；配置写 `requirePairing: true` 时钉死，UI 不可关 | SEC-02/03 |
| FR-7.3 | P1 | token 比较使用常量时间比较；不得用 `===` 直接比较 | SEC-04 |
| FR-7.4 | P1 | 请求体上限 256 KB；非法 JSON/缺字段返回 400；未知路径 404 | SEC-08/09/10 |
| FR-7.5 | P0 | 配对码存本地状态文件（0600），不得出现在日志/组播/health；UI 只回环可见 | SEC-06/12 |
| FR-7.6 | P1 | 组播心跳不得带 MAC；主动 GET health 才返回 MAC | SEC-07 |
| FR-7.7 | P1 | 未配对时读接口（`/peers`、`/tasks`）与写接口（`/task`）都必须 403 | SEC-11 |
| FR-7.8 | P1 | 文档必须明示：token 走明文 HTTP，只防误连不防嗅探；不可信网络建议开配对或套隧道 | SEC-15 |

## 2.8 跨互联网组网（FR-8，可选）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-8.1 | P2 | tsnet 必须**默认关闭**；关闭时零下载、零子进程、零外网 | TS-01 |
| FR-8.2 | P0 | 任何 tsnet 失败都只能影响 tsnet，局域网必须照常工作 | TS-02/13 |
| FR-8.3 | P1 | sidecar 二进制按平台下载并校验 sha256；校验值固定在插件源码，不从同一发布源取 | TS-03 |
| FR-8.4 | P1 | 用户态节点不建 TUN：出站经 sidecar `/__tsnet/fetch`，入站经 `/__tsnet/forward` 反代 | TS-05/06 |
| FR-8.5 | P1 | 整机一个 sidecar 节点，多 profile 通过 rendezvous 复用 | TS-09 |
| FR-8.6 | P1 | 侧车协议版本不一致时必须重启 sidecar，不得混用控制 API | TS-10 |
| FR-8.7 | P1 | 授权码只能走环境变量/本地状态，不得出现在进程命令行或 API 明文返回 | TS-15 |
| FR-8.8 | P2 | tailnet 入站可使用独立权限预设，默认与局域网一致 | TS-16 |

## 2.9 UI（FR-9）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-9.1 | P0 | 提供侧栏/面板入口，展示机器列表与任务记录两个视图 | UI-01/02/03 |
| FR-9.2 | P0 | 首次未命名时弹起名卡片；改名后立即生效并可被对端看到 | UI-04/05 |
| FR-9.3 | P1 | 配对开关/配对码展示、复制、粘贴对齐 | UI-06 |
| FR-9.4 | P1 | 派发表单（选目标、填正文、可选 thread）与结果反馈 | UI-07 |
| FR-9.5 | P1 | 限速提示与"提高上限/忽略"操作 | UI-08 |
| FR-9.6 | P1 | tsnet 各状态（未启用/下载/需登录/运行/错误/已退出）文案明确，错误可诊断 | UI-09 |
| FR-9.7 | P0 | 能力渲染必须区分"未报/为空/过期/不完整" | UI-10、CAP-03 |
| FR-9.8 | P1 | 空状态给出排查步骤，不白屏；宿主未加载时给出明确提示 | UI-11/13 |
| FR-9.9 | P1 | 轮询默认 3s；页面关闭后停止；无控制台报错 | UI-12 |

## 2.10 可观测性与生命周期（FR-10）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-10.1 | P0 | `GET /mesh/v1/health` 返回进程自述 `version`、实例、端口、能力；这是判断"新代码是否在跑"的唯一硬证据 | INST-03 |
| FR-10.2 | P0 | 任务状态机必须完整可读（见 §4.4.2） | WAKE-10 |
| FR-10.3 | P0 | 初始化失败只禁用自身，不拖垮宿主；日志必须包含原因 | INST-07 |
| FR-10.4 | P1 | 配置项必须有 schema、默认值、校验；`config` 在 patch 中是整体替换 | AUTO-01、COMPAT-10 |
| FR-10.5 | P1 | 状态/线程文件损坏时按空处理，不崩溃；写入失败不影响主流程 | INST-08 |
| FR-10.6 | P0 | 版本号两处一致（包清单 + 代码常量），发布前校验 | AUTO-04 |

## 2.11 可移植性（FR-11）

| ID | 优先级 | 需求 | 验收 |
|---|---|---|---|
| FR-11.1 | P0 | 线级协议不得出现宿主持有字段（如 `sessionId` 作为跨机 id、DSH 服务名） | COMPAT-11 |
| FR-11.2 | P0 | 宿主能力通过 Adapter 注入；核心逻辑（发现/路由/限速/名片）与宿主解耦 | §5.2 |
| FR-11.3 | P0 | 新实现必须通过 §6 的一致性测试才能声明兼容 | COMPAT-11 |
| FR-11.4 | P1 | 卡片必须带 `v` 与 `app`；接收方必须忽略未知字段 | COMPAT-05/06/12 |
| FR-11.5 | P1 | 时间统一用 epoch 毫秒（`ts`/`capabilitiesAt`）；在线判定用本地收到时间，不信任对端时钟 | PLAT-08 |

---

# 3. 架构逻辑

## 3.1 分层图（推荐的可移植架构）

```
┌──────────────────────────────── IDE / Editor / DSH Host ────────────────────────────────┐
│                                                                                         │
│  UI Surface (webview / toolwindow / panel / TUI)                                        │
│      │  轮询或事件                                                                       │
│      ▼                                                                                  │
│  Local Control API (loopback only, token)  ◀── IDE Adapter (thin) ──▶ Agent Runtime     │
│      │                                         · createSession / resume / inject        │
│      │                                         · tools.register                         │
│      ▼                                         · notify / openPanel                      │
│  ┌──────────────────────── Mesh Core (portable) ────────────────────────┐              │
│  │ Identity      Discovery Registry      Capability Collector           │              │
│  │   │               │  ▲                     │                         │              │
│  │   │        multicast/scan/ping            │                         │              │
│  │   ▼               │                        ▼                         │              │
│  │ Task Router ◀─────┴──── Peer HTTP Server (0.0.0.0:45917 /mesh/v1/*)  │              │
│  │   │  ▲                          │                                    │              │
│  │   │  └── Reply binding          ▼                                    │              │
│  │   │                      Inbound Gates (noWake/len/greeting/cap/cool)│              │
│  │   ▼                                                                  │              │
│  │ Outbound Client ──▶ Transport Selector ──▶ LAN direct / tsnet bridge │              │
│  │ State Store (0600)   Logger / Task History / Throttle Ledger         │              │
│  └──────────────────────────────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**两种落地形态**（见 §5.1）：

- **内嵌形态（参考实现）**：Core 直接跑在宿主进程里，UI 与 Core 同进程，通过本地 HTTP 路由通信。
- **守护形态（跨 IDE 推荐）**：Core 作为独立常驻进程（`mesh-core`），IDE 插件只是 Adapter + UI，通过 loopback 控制 API（§4.5）通信。好处：协议只实现一次；JetBrains/Zed 这类无 Node socket 能力的宿主也能用；IDE 重启不影响对端在线状态。

## 3.2 参考实现模块图

| 模块 | 职责 | 可移植性 |
|---|---|---|
| `lib/index.js` | 配置 schema、编排、对端 HTTP、工具、UI 路由、入站路由、唤醒 | 编排逻辑可移植；DSH 服务调用需替换 |
| `lib/discovery.js` | 组播注册表、端点级存活、指纹认领、名片 | 高度可移植（纯 Node） |
| `lib/scan.js` | 子网扫描 | 高度可移植 |
| `lib/identity.js` | 持久 UUID + 物理机指纹 | 可移植（平台命令需适配） |
| `lib/conversation.js` | 会话键 + 回信地址 | 纯函数，必须原样复刻 |
| `lib/capabilities.js` | 运行时/GPU 采集、净化、过期、摘要 | 可移植 |
| `lib/prompt.js` | 任务提示词 | 纯函数，必须原样复刻语义 |
| `lib/pairing.js` | 配对开关判定 | 纯函数 |
| `lib/tsnet/*` | sidecar 下载/校验/管理/桥接 | 可选；协议 v1 |
| `client/client.js` | 渲染层 | 每 IDE 重写 |
| `sidecar/` | 用户态 Tailscale 节点（Go） | 可复用二进制，不必重写 |

## 3.3 关键数据流

### 3.3.1 发现

```
定时器/启动
   │
   ├─ 组播 announce（selfRecord，forMulticast=true，不含 mac）
   ├─ 组播 receive → upsert(观察地址, transport=lan)
   ├─ 扫描 → GET http://ip:port/mesh/v1/health → upsert(probe=true)
   └─ ping 已知端点 → GET /mesh/v1/health → touch/markEndpoint
                                   │
                                   ▼
                        Registry: id → { meta, endpoints{lan,tsnet} }
                                   │
                        peers() 投影：online / host / port / transport / capabilitiesStale
```

### 3.3.2 出站派发与回传绑定（关键顺序）

```
mesh_run(peer=B, task, thread="reg-1")
  1. 解析 B（名字/ id / ip:port），要求 online
  2. replyKey = conversationKey(B.machine, thread)
  3. 若 replyKey 已绑定别的会话 → 拒绝
  4. 先把 replyKey 绑定到本会话 S（落盘），**再**发 HTTP
  5. POST http://B:45917/mesh/v1/task
       body: { id, from, fromMachine, task, thread, originSession=S, ... }
  6. B 受理 200 → 返回"已派发"（异步语义）
```

第 4 步的顺序是硬要求：B 可能在 A 的 HTTP 响应返回前就回传，晚绑定会让回传落到错误会话或丢失（BUG-02）。

### 3.3.3 入站与唤醒

```
POST /mesh/v1/task
  → 校验/token → 入箱（按 id 去重）→ 立即 200 {ok,id,duplicate}
  → handleInboundTask
       key = conversationKey(fromMachine, thread)
       canInject = (newSession != true) && isLive(boundSession)
       verdict = classifyInbound:
           noWake? short? greeting? window cap? cooldown(only if !canInject)?
       if !wake: status=noted-only/throttled, routeDecision=reason → 结束
       if canInject: inject(boundSession, prompt) → injected-thread-session
       else:
           if key && pending[key]: queue or busy(>8)
           else: mark pending; wakeOrResume()
                    ├─ resume(boundSession) 成功 → 注入原会话
                    └─ 失败/无绑定 → createSession → inject
           绑定 key → 新 sessionId（落盘）
           排空队列（按到达顺序）
```

### 3.3.4 对端回传

```
B 的 Agent 执行完，调用 mesh_run(peer=A, task=结果, thread="reg-1")
  → B 的 mesh_run 也执行 §3.3.2：把 B 侧 replyKey(A, thread) 绑定到 B 当前会话
  → A 收到 POST：
       key = conversationKey(B, thread)  → 命中 A 之前登记的 S
       → 注入 S；originSession 只记录为 replyTo，不用来查找
```

## 3.4 核心状态机

### 3.4.1 端点与在线

```
unknown ──probe ok──▶ verified/alive ──ttl 到期──▶ stale(offline) ──keepMs──▶ removed
   ▲                        │  ▲
   └──failure backoff──◀────┘  └── ping/scan ok ──┘
```

- 端点存活窗口：`max(ttlMs, probeIntervalMs * 2.5)`（未设 probe 间隔时有兜底）。
- 失败进入冷却：冷却期内不再优先尝试；成功清除冷却。
- 设备在线 = 任一端点 alive；候选未验证端点（如对端自报的 `tailnetIp`）**不算在线**。

### 3.4.2 任务状态机

```
accepted
  ├─ dispatched                 新建会话并已注入
  ├─ injected-thread-session    注入同 thread 原会话
  ├─ injected-queued            建会话期间排队，建成后注入
  ├─ queued-for-session         正在排队（尚未注入）
  │    └─ queued-lost          会话建成后已不可注入（会话可能已结束）
  ├─ noted-only                 只入箱：noWake / 过短 / 寒暄 / 冷却
  ├─ throttled                  撞滑动窗口上限
  ├─ busy                       队列背压
  ├─ stored-only                唤醒能力不可用
  └─ dispatch-failed            新建会话异常（必须带 dispatchError）
```

所有状态必须能从 `GET /mesh/v1/tasks` 或 UI 读到；`routeDecision` 写"为什么这么走"。

### 3.4.3 唤醒决策

```
if noWake → noted-only
else if len < minTaskChars → noted-only
else if greeting-only → noted-only
else if key && capReached(key) → throttled
else if !canInject && cooldownActive(key) → noted-only
else → inject 或 create
```

## 3.5 持久化

### 3.5.1 `state.json`（0600）

```json
{
  "machineName": "客厅的Mac",
  "secret": "<配对码>",
  "requirePairing": false,
  "instanceIds": { "desktop": "a1b2c3d4e5f60718", "meshtest": "..." },
  "tsnetEnabled": false,
  "tsnetAuthKey": "tskey-auth-...",
  "tsnetControlUrl": "",
  "tsnetHostname": ""
}
```

- 位置：`$DSH_HOME/mesh/state.json` 或 `~/.dsh/mesh/state.json`；其他宿主应放在自己的应用数据目录，权限 0600。
- 写入采用"读-合并-写"；未知字段必须保留（向前兼容）。

### 3.5.2 `threads.json`（0600）

```json
{
  "version": 1,
  "threads": {
    "B-mac#a1b2c3d4e5f6": { "wakesAt": [1730000000000], "sessionId": "s-..." }
  },
  "capOverrides": { "B-mac#a1b2c3d4e5f6": 100 }
}
```

- 键是**本机视角**的会话键（来源机器名 + thread 哈希）。
- `wakesAt` 只保留窗口内时间戳；`sessionId` 是"本机处理该会话的会话"。
- 限速账本跨重启保留；文件损坏按空处理。

### 3.5.3 已知限制：同名 + 同指纹

参考实现的认领规则是"同指纹且（机器名相同 或 旧记录已离线）→ 判为同一台机器换了 instanceId"。因此：

- 同一台物理机上的两个 profile，如果**机器名也相同**，会被互相认领、互相顶掉；
- 这是参考实现当前的已知限制，不是推荐用法。同机多实例必须**使用不同机器名**。
- 新实现可以改进（例如增加"两个 instanceId 均在线则不认领"的硬条件），但必须把行为写进实现说明，并保证不与参考实现互测时产生歧义。

## 3.6 失败语义（不可妥协）

| 数据 | "没报" | "报了空" | "探测失败" | 正确展示 |
|---|---|---|---|---|
| 能力 | `null` | `{}` | `probeFailCount>0` / `runtimesIncomplete` | 未知 / 确实没有 / 未探准 |
| 在线 | 无记录 | — | `lastFailAt>0` | 不存在 / 离线 / 暂不可达 |
| 任务 | — | — | `dispatchError` | 失败原因可读，不静默 |
| tsnet | `phase=idle` | — | `phase=error + error` | 未启用 / 失败原因 |

**硬规则**：不得把探测失败渲染成否定事实（D2/D3）。新增字段时优先增加"不确定性"字段，而不是用空值表达两种含义。

## 3.7 并发模型

- 单线程事件循环（Node）；阻塞操作（扫描、探测、HTTP）必须异步。
- 同一会话键的建会话用 `pendingByConv` 占位锁；队列上限 8，超出背压。
- 扫描并发默认 64，单地址超时 800ms；一轮不阻塞下一轮。
- 历史记录上限：入站/出站各 200；UI 各自返回最近 30/50 条。
- 定时器必须 `unref` 并在 dispose 时清理，避免拖住宿主退出。

## 3.8 性能与资源预算

| 指标 | 目标 |
|---|---|
| 启动开销 | 不阻塞宿主启动；首轮能力采集延迟 ≥ 数秒（避开启动高峰） |
| 空闲 CPU | 心跳 5s、ping 10s、扫描 60s，可忽略 |
| 单次扫描（/24） | 1～2 秒，最多 64 并发 |
| 内存 | 对端记录 + 200 条历史；不得随运行时间无限增长 |
| 包体 | 参考实现 npm 包约 250 KB；跨 IDE 实现不应把 Go 二进制塞进主包 |
| 依赖 | 运行时零外部服务；tsnet 二进制按需下载 |

## 3.9 安全边界

```
可信：同机、本地状态目录
半可信：同局域网（默认可直接派任务 —— 有意取舍）
不可信：对端任务正文、名片字段、HTTP 头、tailnet 入站
```

- 入站任务按不可信输入处理：权限降级、正文限长、唤醒限速。
- 名片净化后再进 UI/决策。
- 配对码不是加密；明文 HTTP 的边界必须在文档里说清。
- 状态文件 0600；授权码/配对码不得进日志、名片、组播。

---

# 4. 通信协议（多版本）

## 4.1 版本模型

协议有 **三个独立版本轴**，不要混为一谈：

| 轴 | 标识 | 位置 | 当前值 | 变更影响 |
|---|---|---|---|---|
| 发现卡片 | `v` 字段 | 组播心跳、`/health`、`/hello` 的主体 | **2** | 加字段 / 语义变化 |
| 对端 HTTP API | 路径前缀 `/mesh/v1` | 所有跨机接口 | **1** | 仅加字段、加接口；不改路径 |
| sidecar 控制协议 | `protocol` 字段 | 本机 loopback 控制 API | **1** | 形状变化即重启 sidecar |
| 本地控制 API（草案） | 路径 `/v1` | IDE 适配层 ↔ 核心守护进程 | **0.1 草案** | 参考实现尚未内置 |

### 4.1.1 兼容总规则（所有实现 MUST 遵守）

1. **只增不改**：已发布字段的名称、类型、语义不得改变；要改语义就升卡片版本并新增字段。
2. **忽略未知**：接收方必须忽略不认识的字段/枚举值，不得因此报错或断连。
3. **不硬拒版本**：不得因 `v` 高于自己而拒绝通信；按自己理解的子集处理，缺少的字段降级。
4. **空值语义固定**：`null` = 未提供/未知；`{}`/`[]` = 明确为空；`0`/`""` 不得混用为"未知"（时间戳除外，见下）。
5. **时间戳**：epoch 毫秒。非法/缺失按 `0` 处理，并视为"未知/过期"，不得当成 1970 年的有效数据。
6. **幂等**：`POST /task` 的 `id` 是幂等键；重复投递不得重复唤醒。
7. **版本声明**：发送方必须在名片里带 `v` 与 `app`；接收方 SHOULD 在诊断/UI 中展示对端版本。
8. **弃用**：字段先标记 deprecated，至少保留 2 个 minor 版本或 1 个 major 版本后再删除；读取端兼容期不得短于写端。

## 4.2 发现卡片协议

### 4.2.1 传输与封装

| 项 | 值 |
|---|---|
| 传输 | UDP，IPv4，单播/组播 |
| 组播组 | `239.255.42.99` |
| 端口 | `45892` |
| 编码 | UTF-8 JSON 对象，单个 datagram |
| 周期 | `announceIntervalMs`，默认 5000ms |
| 兼容 | 发送方也监听同组；收到自己的 `id` 丢弃 |
| 建议大小 | SHOULD ≤ 1400 字节，避免 IP 分片；能力字段大时精简到摘要 |

### 4.2.2 卡片 v1（历史版本，仍需能读）

```json
{
  "v": 1,
  "app": "dsh-mesh",
  "id": "a1b2c3d4e5f60718",
  "machine": "客厅的Mac",
  "hostname": "macbook.local",
  "host": "192.168.1.6",
  "port": 45917,
  "os": "darwin 21.6.0",
  "user": "peng",
  "profile": "desktop",
  "version": "0.3.11",
  "mac": "aa:bb:cc:dd:ee:ff",
  "ts": 1730000000000
}
```

字段语义：

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `v` | number | 是 | 卡片版本；v1 实现只认 1 |
| `app` | string | 是 | 固定 `dsh-mesh`，用于过滤无关 UDP 包 |
| `id` | string | 是 | 实例 id，16 位 hex；身份主键 |
| `machine` | string | 是 | 人类可读机器名；可重名 |
| `hostname` | string | 否 | OS 主机名 |
| `host` | string | 是 | 对端自述的局域网 IPv4 |
| `port` | number | 是 | mesh HTTP 端口 |
| `os` | string | 否 | `platform release` |
| `user` | string | 否 | 登录用户名 |
| `profile` | string | 否 | 宿主 profile |
| `version` | string | 否 | 插件版本；用于诊断 |
| `mac` | string | 否 | **仅 health/hello 返回；组播不得携带** |
| `ts` | number | 否 | 发送时间 epoch ms |

### 4.2.3 卡片 v2（当前版本）

相对 v1 的变化：

| 变化 | 说明 |
|---|---|
| 新增 `fingerprint` | 物理机指纹（16 位 hex），可空；仅用于认领 |
| 新增 `tailnetIp` | 本机 tailnet IPv4，可空；作为未验证候选端点 |
| 组播不再带 `mac` | 隐私；health 仍可返回 |
| 新增 `capabilities` | 能力名片对象或 `null`；**v2 内的增量字段**（0.3.25 起） |
| 内部多端点 | `endpoints[]` 是本地数据结构，**不上网线**；线上仍是一台设备一份名片 |

v2 示例：

```json
{
  "v": 2,
  "app": "dsh-mesh",
  "id": "a1b2c3d4e5f60718",
  "machine": "客厅的Mac",
  "hostname": "macbook.local",
  "host": "192.168.1.6",
  "port": 45917,
  "os": "darwin 21.6.0",
  "user": "peng",
  "profile": "desktop",
  "version": "0.3.36",
  "fingerprint": "0123456789abcdef",
  "tailnetIp": "100.101.102.103",
  "capabilities": {
    "os": "darwin 21.6.0",
    "arch": "x64",
    "cpuCores": 8,
    "memMb": 16384,
    "runtimes": { "node": "20.19.3", "python": "3.11.6" },
    "runtimesIncomplete": false,
    "probeFailCount": 0,
    "gpu": { "present": true, "name": "Apple M1", "vramMb": 8192 },
    "workspaceHints": ["/Users/peng/work"],
    "capabilitiesAt": 1730000000000
  },
  "ts": 1730000000000
}
```

能力子对象（`capabilities`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `os` / `arch` | string | 平台与架构 |
| `cpuCores` | number | 逻辑核数 |
| `memMb` | number | 内存 MB |
| `runtimes` | object | 名称 → 版本（只含探到的；版本只保留数字与点） |
| `runtimesIncomplete` | boolean | true = 有探测未探准，不能据此断言"没有某运行时" |
| `probeFailCount` | number | 失败项数；0 不等于全部成功，但 >0 明确表示不完整 |
| `gpu` | object/null | `{present,name,vramMb}`；无 GPU 为 null |
| `workspaceHints` | string[] | 最多 8 条，每条 ≤40 字符 |
| `capabilitiesAt` | number | 采集时间 epoch ms；≤0/缺失按未知处理 |
| `probeErrors` | — | **禁止上网线**；只在本地诊断 |

### 4.2.4 卡片 v3（草案，尚未实现）

目的：为跨 IDE 实现提供**显式能力协商**，避免继续在 v2 上"猜字段"。

建议新增字段（全部可选，v3 发送方仍应带 v2 字段）：

```json
{
  "v": 3,
  "proto": { "min": 2, "max": 3 },
  "features": [
    "capabilities", "thread", "newSession", "noWake",
    "resume", "originSession", "tsnet", "rateLimit"
  ],
  "agent": { "host": "vscode", "name": "mesh-vscode", "version": "0.1.0", "wake": "auto" },
  "limits": { "maxBodyBytes": 262144, "maxWakePerWindow": 30, "windowMs": 3600000 }
}
```

规则：
- 接收方不认识 `v:3` 时按 v2 处理；`proto`/`features` 仅用于**优化**，不是准入闸门。
- `features` 只声明"我支持这些语义"，不代表对端必须支持；发送方 SHOULD 在缺失时退化为 v2 行为。
- `agent.wake` 取值建议：`auto`（可自动建会话）/ `user`（需用户触发）/ `none`（只入箱）。
- **在 v3 正式定稿前，任何实现不得把 v3 字段当作必需。**

### 4.2.5 接收算法（所有实现 MUST 等价）

```
on datagram(msg):
  if msg.app != "dsh-mesh" → ignore
  if msg.id == self.id → ignore
  observed = rinfo.address           # 观察地址优先
  transport = rinfo.transport ?? "lan"
  host = (transport == "tsnet") ? observed : (msg.host || observed)
  # rinfo.port 只在调用方显式传入"观察到的端口"时才有值（如 tailnet 候选）
  # 组播 datagram 自身的 UDP 源端口（45892）绝不能当作 HTTP 端口
  port = rinfo.port ?? msg.port
  upsert(id, msg, host, port, transport, verified=true)
```

关键点：
- **不要**用 UDP 源端口（45892）覆盖名片里的 HTTP 端口（45917）。历史上踩过。
- tailnet 通道必须用观察到的地址，因为对端自述的 `host` 是局域网 IP，跨网不可达。
- 按 `id` 合并；同一设备可有多条端点；旧记录按地址去重；指纹认领规则见 FR-1.4。
- 收到 v1 名片：`fingerprint`/`tailnetIp`/`capabilities` 视为空；不得因此报错。

## 4.3 对端 HTTP API v1

### 4.3.1 传输与通用约定

| 项 | 值 |
|---|---|
| 基址 | `http://<peer-host>:<peer-port>/mesh/v1` |
| 监听 | `0.0.0.0`（局域网可达）；**不要**绑回环 |
| 编码 | JSON UTF-8 |
| 认证头 | `X-Dsh-Mesh-Token: <secret>`（大小写不敏感；仅 `requirePairing=true` 时强制） |
| 请求体上限 | 256 KiB |
| 超时建议 | 客户端 20s；健康探测 3s；hello 6s |
| 状态码 | 200 成功；400 参数错；403 未配对；404 未知路径 |
| 错误信封 | `{ "ok": false, "error": "<可读原因>" }` |
| 版本 | 路径 `/mesh/v1` 固定；新增字段/接口不升路径 |
| TLS | 参考实现不内置；跨不可信网络由用户套 SSH/TLS 反代 |

> **不要**把本地 GUI/IDE 的 HTTP 端口写进协议或文档：它通常只绑 `127.0.0.1`，跨机一定不通，失败现象容易被误诊为"对端没开服务"。

### 4.3.2 接口总表

| 方法 | 路径 | 认证 | 用途 |
|---|---|---|---|
| GET | `/mesh/v1/health` | 免 | 连通性探测 + 自述名片 + 版本 |
| GET | `/mesh/v1/hello` | 免 | 配对握手 + 能力/身份 + `peerPaired` |
| GET | `/mesh/v1/peers` | 需 | 对端视角的已发现列表 |
| GET | `/mesh/v1/tasks` | 需 | 最近 50 条入站任务及路由原因 |
| POST | `/mesh/v1/task` | 需 | 派发任务 / 回传结果 |

### 4.3.3 `GET /mesh/v1/health`

免鉴权。返回本机自述名片，并在顶层附加：

```json
{
  "ok": true,
  "v": 2,
  "app": "dsh-mesh",
  "id": "a1b2c3d4e5f60718",
  "instanceId": "a1b2c3d4e5f60718",
  "machine": "客厅的Mac",
  "hostname": "macbook.local",
  "host": "192.168.1.6",
  "port": 45917,
  "os": "darwin 21.6.0",
  "user": "peng",
  "profile": "desktop",
  "version": "0.3.36",
  "fingerprint": "0123456789abcdef",
  "tailnetIp": "",
  "capabilities": { "...": "..." },
  "mac": "aa:bb:cc:dd:ee:ff",
  "ts": 1730000000000,
  "requirePairing": false
}
```

用途：
- 主动扫描/保活探测（唯一可靠的"进程是否在跑/版本是多少"判据）。
- `version` 是**进程自述**，不是磁盘版本；升级后必须重启才变。

### 4.3.4 `GET /mesh/v1/hello`

免鉴权，用于配对握手与 UI "测试连接"。

```json
{
  "ok": true,
  "...": "与本机名片相同",
  "requirePairing": true,
  "requirePairingPinned": false,
  "peerPaired": true
}
```

- `requirePairingPinned`：true = 由配置钉死，UI 不能关。
- `peerPaired`：请求携带的 token 是否通过；未携带/错误为 false。
- 即使未配对，本接口也必须返回 200（可探测 + 可引导用户对齐配对码）。

### 4.3.5 `GET /mesh/v1/peers`

需鉴权。返回本机注册表的投影：

```json
{
  "ok": true,
  "peers": [
    {
      "id": "b2c3...",
      "machine": "文超-win",
      "hostname": "DESKTOP-XXX",
      "mac": "11:22:33:44:55:66",
      "os": "win32 10.0.19045",
      "user": "wc",
      "profile": "desktop",
      "version": "0.3.30",
      "fingerprint": "fedcba9876543210",
      "fingerprintConflict": null,
      "capabilities": { "...": "..." },
      "online": true,
      "lastSeen": 1730000000000,
      "transport": "lan",
      "host": "192.168.1.9",
      "port": 45917,
      "sourceAddress": "192.168.1.9",
      "knownAddresses": ["lan:192.168.1.9:45917"],
      "endpoints": [
        {
          "transport": "lan",
          "host": "192.168.1.9",
          "port": 45917,
          "lastSeen": 1730000000000,
          "lastOkAt": 1730000000000,
          "lastFailAt": 0,
          "okCount": 12,
          "failCount": 0,
          "rttMs": 3,
          "probeIntervalMs": 10000,
          "downUntil": 0,
          "verified": true
        }
      ],
      "capabilitiesStale": false,
      "capabilitySummary": "py3.11 · node20.19 · docker24.0",
      "firstSeen": 1729990000000,
      "ts": 1730000000000
    }
  ]
}
```

实现要求：
- `host`/`port`/`transport` 是"当前选中端点"的兼容投影；`endpoints[]` 是完整真相。
- `capabilities=null` 必须保留为 null（未知），不得变成 `{}`。
- `online` 与 `capabilitiesStale` 是派生字段，接收方应容忍缺失。

### 4.3.6 `GET /mesh/v1/tasks`

需鉴权。返回最近 50 条入站任务，倒序：

```json
{
  "ok": true,
  "tasks": [
    {
      "id": "t-a1b2c3d4e5f6",
      "from": "客厅的Mac/peng",
      "fromMachine": "客厅的Mac",
      "task": "把 /tmp/x 的内容读出来 …",
      "thread": "reg-1",
      "originSession": "s-abc123",
      "noWake": false,
      "newSession": false,
      "workspace": "/tmp/w",
      "receivedAt": "2026-10-21T10:00:00.000Z",
      "sourceAddress": "192.168.1.6",
      "transport": "lan",
      "status": "dispatched",
      "replyTo": { "machine": "客厅的Mac", "session": "s-abc123", "thread": "reg-1" },
      "routeDecision": "新建会话并绑定会话键 客厅的Mac#a1b2c3d4e5f6（首次出现，或原会话已结束）",
      "dispatchError": ""
    }
  ]
}
```

`status` 枚举见 §4.4.2。`routeDecision`/`dispatchError` 是可观测性的一部分，**不得省略**。

### 4.3.7 `POST /mesh/v1/task`

需鉴权。派发或回传任务。

请求：

```json
{
  "id": "t-a1b2c3d4e5f6",
  "from": "客厅的Mac/peng",
  "fromMachine": "客厅的Mac",
  "task": "把 /tmp/x 的内容读出来，结果用 mesh_run 回传给 客厅的Mac，thread=reg-1",
  "thread": "reg-1",
  "originSession": "s-abc123",
  "noWake": false,
  "newSession": false,
  "workspace": "/tmp/w"
}
```

字段语义：

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 否 | 任务 id；缺省由接收方生成；幂等键 |
| `from` | 否 | 人类可读来源，建议 `<machine>/<user>`；**不能**用作 peer |
| `fromMachine` | 建议 | 来源机器名；会话键与回传寻址依赖它；缺失时退化用 `from` |
| `task` | **是** | 任务正文，非空字符串 |
| `thread` | 否 | 线程标签；决定会话复用与限速；空 = 一次性任务 |
| `originSession` | 否 | 发送方会话 id，仅回信地址；接收方**不得**用它查找本机会话 |
| `noWake` | 否 | true = 只入箱不唤醒（纯回执） |
| `newSession` | 否 | true = 强制新建会话（会话键不变） |
| `workspace` | 否 | 建议工作目录（绝对路径）。**参考实现只记录、不强制执行**；实际会话目录由接收方 `workspaceRoot` 决定（空则用户主目录）。新实现若强制执行，必须在实现说明中声明 |

成功响应：

```json
{ "ok": true, "id": "t-a1b2c3d4e5f6", "duplicate": false }
```

错误：

| 情况 | 状态码 | body |
|---|---|---|
| 未配对/ token 错 | 403 | `{ok:false,error:"未配对：两台机器的配对码不一致（本机开启了 requirePairing）"}` |
| 缺 `task` / 空正文 | 400 | `{ok:false,error:"task 必填"}` |
| 非法 JSON / 超大 body | 400 或连接关闭 | 明确错误 |
| 未知路径 | 404 | `{ok:false,error:"not found"}` |

### 4.3.8 幂等与去重

- 接收方按 `id` 在内存中去重（参考实现重启后去重失效，这是已知限制）。
- 重复请求返回 200 + `duplicate: true`；不得再次入箱或唤醒。
- `id` 建议格式 `t-<12 hex>`；实现可自定义，但必须在重试时保持不变。

### 4.3.9 认证细节

- 开关判定优先级：配置 `requirePairing === true` → 强制开启且 UI 不可关；否则看本地状态文件里的 `requirePairing`。
- 只认严格布尔 `true`；字符串 `"true"`、数字 `1` 不算（YAML 常见坑）。
- 比较必须常量时间；失败统一 403，不区分"没带 token"和"token 错"。
- `/health`、`/hello` 永远免认证；其余接口在未配对时全部 403。

## 4.4 任务语义与回传

### 4.4.1 会话键算法（必须逐字复刻）

```js
who = (task.fromMachine || task.from || "unknown").trim()
label = (task.thread || "").trim()
if (!label) return ""                       // 一次性任务
hash = sha256(`${who}\u0000${label}`).hex.slice(0, 12)
key = `${who}#${hash}`                      // 例：客厅的Mac#a1b2c3d4e5f6
```

为什么两端算出的键不同（A 看到 `B#hash`，B 看到 `A#hash`）：每端只需要在**自己的**收件箱里区分"这是哪场对话"；要求两端算出同一字符串反而要协商。键里必须含来源机器名，否则两个来源的同名 `thread` 会撞车。

### 4.4.2 派发语义

- `mesh_run` 返回"已派发"只代表 HTTP 200 受理；完成与否由对端 Agent 回传决定。
- 目标离线：直接失败，不排队（参考实现）。
- 目标重名：>1 台在线必须拒绝；恰好 1 台在线可选中；离线记录不算歧义。
- 超时：`requestTimeoutMs`（默认 20s）后失败；A 侧保留回传绑定（超时不证明未送达）。

### 4.4.3 回传语义

- 回传就是一次普通的 `POST /task`，`fromMachine` = 执行方，`thread` = 原 thread，`originSession` = 执行方自己的会话（不是发起方的）。
- 发起方收到回传后：用 `conversationKey(执行方机器名, thread)` 找到自己此前登记的绑定，注入该会话。
- **零新建**：回传不得在发起方新建会话（除非绑定丢失且无法恢复，此时必须记录原因）。
- 防循环：
  - 提示词要求"纯回执带 noWake；无新结论不回派"；
  - `minTaskChars` 挡过短；
  - 寒暄正则挡 `收到/好的/ack/ping`；
  - 滑动窗口 + 冷却兜底；
  - 回传只回一次，不为"确认收到"再回一轮。

### 4.4.4 回传绑定的时序要求（伪代码）

```js
// 发送方，mesh_run 内：
key = conversationKey({ fromMachine: target.machine, thread })
if (boundSession(key) && boundSession(key) !== mySession) reject("thread 已绑定另一会话")
bind(key, mySession)            // 先落盘
post("/mesh/v1/task", payload)  // 再发请求
// 失败也保留绑定：超时不证明未送达
```

## 4.5 本地控制 API（草案 v0.1，供 IDE 适配层使用）

> 参考实现没有这个 API（DSH 插件是内嵌形态）。跨 IDE 推荐用"守护进程 + 薄适配器"（§5.1）时，由核心进程实现本 API；IDE 插件只消费它。**在草案定稿前，不要求参考实现兼容。**

### 4.5.1 通用约定

- 仅绑定 `127.0.0.1`，随机端口；端口与 token 写入 `~/.mesh/control.json`（0600）。
- 认证头：`X-Mesh-Local-Token`。
- JSON；错误信封与 §4.3.1 相同。
- 与跨机协议**完全分离**：本地 API 可以包含 IDE 专有信息，跨机协议不可以。

### 4.5.2 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/v1/status` | 版本、实例、端口、配对状态、tsnet 状态、错误 |
| GET | `/v1/peers` | 与 `/mesh/v1/peers` 同构 |
| GET | `/v1/tasks` | 入站/出站记录、`routeDecision` |
| POST | `/v1/task` | 派发（等价 `mesh_run`） |
| GET | `/v1/capabilities` | 本机能力名片 |
| POST | `/v1/config` | 运行时配置（受白名单限制） |
| POST | `/v1/scan` | 触发扫描 |
| POST | `/v1/name` | 改名 |
| POST | `/v1/pairing` | 开关/设置配对 |
| POST | `/v1/tsnet/*` | start/stop/relogin/reinstall/scan |
| GET | `/v1/events` | SSE 事件流（见下） |
| POST | `/v1/shutdown` | 优雅退出 |

### 4.5.3 事件流（SSE）

```
event: peer-up        data: {"id":"...","machine":"..."}
event: peer-down      data: {"id":"...","machine":"..."}
event: task-accepted  data: {"id":"...","fromMachine":"..."}
event: task-routed    data: {"id":"...","status":"dispatched","routeDecision":"..."}
event: task-failed    data: {"id":"...","dispatchError":"..."}
event: tsnet          data: {"phase":"running","selfIpv4":"100.x.y.z"}
event: throttle       data: {"thread":"...","blocked":2,"cap":30}
```

IDE 适配器 SHOULD 用事件流驱动 UI，而不是高频轮询；无 SSE 能力时退回 3s 轮询。

## 4.6 sidecar 控制协议 v1（tsnet，可选）

### 4.6.1 进程与事件

- 启动参数：`-hostname <dns-label> -dir <state-dir> -token <secret> [-control-url <url>]`。
- 授权码走环境变量 `DSH_TSNET_AUTHKEY`（避免 `ps` 泄露）。
- stdout 每行一个 JSON 事件：

```json
{"event":"listening","protocol":1,"port":54321}
{"event":"ready","protocol":1,"hostname":"dsh-mac","selfIpv4":"100.x.y.z"}
{"event":"auth-required","url":"https://login.tailscale.com/..."}
{"event":"error","where":"...","message":"..."}
{"event":"log","message":"..."}
```

### 4.6.2 控制 API

基址 `http://127.0.0.1:<port>`，认证头 `X-Mesh-Token`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/__tsnet/status` | — | `{ok,protocol,pid,hostname,ephemeral,backendState,authUrl,machineKey,selfIpv4,selfIpv6,selfDnsName,forwards,diagnostics}` |
| GET | `/__tsnet/peers` | — | `{ok,peers:[{hostname,dnsName,ipv4,ipv6,online,os,exitNode,tags,lastSeen}]}` |
| POST | `/__tsnet/fetch` | `{url,method,headers,bodyBase64,timeoutMs}` | `{ok,status,headers,bodyBase64}` 或 `{ok:false,error}` |
| POST | `/__tsnet/forward` | `{port}` | `{ok,port,already?}` |
| POST | `/__tsnet/unforward` | `{port}` | `{ok}` |
| POST | `/__tsnet/shutdown` | — | `{ok}` |

### 4.6.3 版本与复用

- `protocol` 不一致 → 杀掉并重启 sidecar（本地硬不兼容，但不得影响局域网）。
- `rendezvous.json`：`{pid,port,token,hostname,protocol,startedAt}`，整机单实例复用依据。
- 一个 sidecar 只允许一个 owner 负责退出清理；非 owner 退出不得杀共享节点。

## 4.7 兼容矩阵

### 4.7.1 卡片版本 × 行为

| 发送 \ 接收 | v1 接收方 | v2 接收方 |
|---|---|---|
| v1 发送方 | 正常 | 正常；`fingerprint`/`tailnetIp`/`capabilities` 视为空 |
| v2 发送方 | 正常；忽略新字段 | 正常 |
| v3 草案发送方 | 正常；忽略 `proto`/`features`/`agent` | 正常；按 v2 语义，可选使用 v3 字段 |

### 4.7.2 插件版本兼容（参考实现）

| 版本区间 | 卡片 | 能力名片 | 说明 |
|---|---|---|---|
| ≤0.3.11 | v1 | 无 | 仍可发现/派发/回传 |
| 0.3.12–0.3.24 | v2 | 无 | 有指纹/tailnetIp，无能力 |
| 0.3.25–0.3.36 | v2 | 有 | 能力为 v2 内增量字段 |
| 未来 v3 | v3 | 有 | 未实现；接收方按 v2 降级 |

### 4.7.3 其他兼容规则

- `/mesh/v1/*` 路径与字段名在 1.x 内不变。
- sidecar 1 与插件 1 必须配对升级；插件会检测并重启不匹配的 sidecar。
- 新增枚举值（如任务状态）时，旧接收方必须能当作未知状态展示，不得崩溃。
- 新实现接入前必须通过 §6 的互操作测试，不得只测"自己能连自己"。

## 4.8 扩展与弃用流程

1. **加字段**：发送方加可选字段；接收方忽略未知；不升卡片版本。
2. **改语义**：必须新增字段或升 `v`；旧字段保留并标注 deprecated。
3. **加接口**：`/mesh/v1/<name>`；旧实现 404 视为"不支持"，调用方必须降级。
4. **删字段**：至少等 2 个 minor 或 1 个 major；先在文档标注，再在代码停止发送（仍接收），最后删除读取。
5. **升 `v`**：新增能力协商（`proto`/`features`），不设硬闸门；旧实现按子集处理。
6. **禁止**：复用已有字段名表达新语义；把 `0`/`""` 当"未知"；用版本号拒绝连接。

---

# 5. 跨 IDE 实现契约

## 5.1 两种落地方案

### 方案 A：内嵌（参考实现）

Core + UI 跑在宿主进程/扩展宿主里。适合 Node/Electron 系宿主（VS Code、DSH、CLI）。

- 优点：安装简单、无额外进程、UI 与 Core 同进程。
- 缺点：每个 IDE 重写一遍协议；非 Node 宿主（JetBrains、Zed WASM）成本高；IDE 重启导致对端掉线。

### 方案 B：守护进程 + 薄适配器（跨 IDE 推荐）

```
mesh-core（独立进程，实现 §4.2–§4.6 全部协议）
   ▲ loopback HTTP/SSE（§4.5）
   │
IDE 插件（只做 UI、Agent 适配、生命周期）
```

- 优点：协议只实现一次；任何 IDE 都能接；IDE 重启不影响对端在线；sidecar 与核心同生命周期。
- 缺点：多一个进程、需要安装/升级管理、需要本地端口与 token。
- 要求：核心必须实现 §4.5 草案 API；IDE 插件不得自行实现跨机协议（否则又会分叉）。

> **建议**：新 IDE 实现一律选方案 B。方案 A 只用于"宿主本身就能跑 Node 且希望零额外进程"的场景。

## 5.2 适配器契约（Adapter Contract）

核心不得直接调用 IDE API；所有宿主能力通过以下原语注入。**P0 原语缺失时不能声称完整实现。**

| 原语 | 必需 | 语义 | 缺失时的降级 |
|---|---|---|---|
| `agent.createSession({prompt, workspace, permissionPreset, agentPreset, reasoningEffort}) → sessionId` | P0（自动唤醒级） | 新建一个 Agent 会话并让它开始跑 | 降级为用户触发（L2） |
| `agent.inject(sessionId, message) → boolean` | P0 | 向仍活跃的会话追加一条用户消息 | 降级为新建 |
| `agent.resume(sessionId) → sessionId \| null` | P1 | 恢复已结束但磁盘仍有记录的会话 | 直接新建 |
| `agent.isLive(sessionId) → boolean` | P0 | 会话是否仍在内存/可注入 | 保守返回 false |
| `agent.cancel?` | P2 | 中止会话（防失控） | 不实现 |
| `tools.register(definition)` | P0 | 把 `mesh_run` 等暴露给 Agent | 仅 UI 派发（L1） |
| `ui.openPanel()` / `ui.notify()` | P1 | 面板与通知 | CLI 输出 |
| `http.register(path, handler)` | P0 | 本地回环 API | 守护进程方案下由核心提供 |
| `storage.read/write(key)` | P0 | 0600 持久化 | 内存态（不推荐） |
| `config.get()` | P0 | 读取配置与默认值 | 硬编码默认 |
| `proc.exec(cmd, args, timeout)` | P1 | 能力探测 / sidecar 管理 | 能力名片为空但标"未探准" |
| `lifecycle.onDispose(fn)` | P0 | 清理定时器/监听/子进程 | 可能泄漏 |
| `log.info/warn/error` | P0 | 可观测性 | 丢弃（不推荐） |
| `clock.now()` | P1 | 可注入时钟，便于测试 | 系统时间 |

### 5.2.1 Agent 唤醒能力分级（必须如实声明）

不同 IDE 对"程序化创建/注入 Agent 会话"的开放程度差异很大。实现必须声明自己属于哪一级，不得把 L1 宣传成 L3。

| 级别 | 名称 | 能力 | 用户体验 |
|---|---|---|---|
| **L0** | 仅发现 | 能看到对端、看能力；不能派发/接收唤醒 | 只读 Mesh 面板 |
| **L1** | 收件箱 | 能收任务、能手动派发；不自动唤醒 Agent | 任务进列表，用户点击处理 |
| **L2** | 用户触发唤醒 | 能通知/打开会话/预填提示词，由用户确认开跑 | 一条通知 + 一键执行 |
| **L3** | 自动唤醒 | 收到任务即建/复用会话并开跑 | 与参考实现等价 |

`agent.wake`（§4.2.4 草案）建议与级别对应：`none` / `user` / `user` / `auto`。

## 5.3 各 IDE 映射表

| 宿主 | 推荐形态 | UI | 持久化 | Agent 接入 | 难点 / 注意 |
|---|---|---|---|---|---|
| **DSH / DSH Desktop**（参考） | A 内嵌 | `sidebar.panellist` + 手写 web bundle | `~/.dsh/mesh/state.json` | `ctx.agents` / `agentPresets` / `permissionPresets` | 与参考实现一致；注意 profile 解析与重启 |
| **VS Code / Cursor / Windsurf** | A 或 B | `WebviewPanel` + `postMessage` | `context.globalState` / `SecretStorage` | 扩展宿主可跑 Node：直接复用参考核心；Agent 侧接各自 Chat/Composer API 或外部 CLI | 扩展宿主有 Node `dgram`/`http`；Webview 需 CSP；Cursor 的 Agent API 不稳定，优先 L2 |
| **JetBrains（IDEA/PyCharm/WebStorm）** | **B 守护** | JCEF `ToolWindow` 加载本地页面 | JVM `PersistentStateComponent` 或核心状态目录 | 通过核心本地 API；唤醒用 Run Configuration / Terminal / 插件 AI Assistant（若开放） | 不要用 Kotlin 重写发现协议；JVM 无 Node，直接复用 `mesh-core` 二进制 |
| **Zed** | **B 守护** | Rust/WASM 扩展 + 外部核心 | 核心状态目录 | 扩展只做 UI/命令；唤醒通过 `zed` CLI 或用户确认 | WASM 扩展无 socket/进程能力，**不能**内嵌核心 |
| **Neovim** | B 守护 | Lua floating window / `vim.ui` | 核心状态目录 | `jobstart` 调核心 CLI；唤醒用 `:terminal` 或内置 AI 插件 | 适合先做 L1/L2 |
| **Emacs** | B 守护 | Elisp buffer | 核心状态目录 | `start-process` / `make-process` | 同上 |
| **终端 / 无头 CLI** | A 或 B | TUI/纯文本 | 核心状态目录 | 直接调用核心 | 最容易做到 L3；也最适合做一致性测试的参照端 |

### 5.3.1 各宿主的实现建议

**VS Code 系（含 Cursor/Windsurf）**

- `extension.ts` 里启动核心（方案 A）或连接已有守护进程（方案 B）。
- `WebviewPanel` 只渲染 `GET /v1/status|peers|tasks` 的结果；不要在前端实现协议。
- 用 `vscode.window.showInformationMessage` + `commands.registerCommand` 做 L2 唤醒。
- 持久化：`context.secrets` 存配对码/授权码，`globalState` 存机器名。
- 注意：Webview 的 CSP 不允许直接访问任意主机；所有网络请求走扩展宿主。

**JetBrains**

- 插件用 Kotlin/Java；`ToolWindowFactory` + JCEF 面板。
- 核心以随插件分发的二进制运行（`PathManager.getPluginsPath()` 下），通过 `LocalControl API` 通信。
- 不需要实现 UDP/TCP 服务端；但必须能启动/停止/升级核心，并在 IDE 退出时按策略决定是否保留（推荐保留，保证对端在线）。
- 唤醒：优先用 IDE 的 AI Assistant API；没有则打开终端并提示用户，属于 L2。

**Zed**

- 扩展是 WASM 沙箱，**没有** UDP/TCP/进程权限。官方扩展 API 也不保证能创建 Agent 会话。
- 必须走方案 B：外部 `mesh-core` 常驻；扩展只提供命令与状态展示。
- 若无法启动外部进程，则只能做到 L0/L1。

**Neovim / Emacs**

- 用 `jobstart`/`make-process` 管理核心；UI 用浮动窗口。
- 唤醒 Agent 用宿主已有插件（如 Neovim 的 AI 插件）或终端命令；先做 L2。

## 5.4 端口、进程与单实例

- 跨机 HTTP 端口默认 45917；被占用时回退随机端口，并在名片里上报**实际端口**。
- 同机多实例：不同 `port` + 对方 `scanPorts`；或方案 B 下核心统一占用 45917，多 IDE 共享。
- 单实例锁：状态目录下 `control.json` + pid 存活检测；stale 锁要能自动清理。
- 退出策略：
  - 方案 A：随宿主退出，释放端口；
  - 方案 B：核心可常驻（推荐），IDE 退出不影响对端在线；提供显式 `shutdown`。
- 崩溃恢复：核心启动时清理僵尸 sidecar；不留下监听端口/子进程。

## 5.5 跨 IDE 实现步骤（给 AI 的执行清单）

1. **读协议**：实现 §4.2 发现、§4.3 HTTP、§4.4 语义；先不要写 UI。
2. **做最小节点**：能发/收组播、能响应 `/health`、能被 `mesh_peers` 看到（L0）。
3. **加派发/接收**：实现 `/task` 收发与任务记录（L1）。
4. **加会话适配**：按 §5.2 实现 `agent.*`；先做到"收到任务能入箱"，再逐级提升到 L2/L3。
5. **加回传绑定**：严格按 §4.4.4 的顺序，先绑定再发请求。
6. **加闸门**：noWake/长度/寒暄/限速/冷却/背压；每个拦截都写原因。
7. **加能力名片**：采集、净化、三种"不知道"、不确定性字段。
8. **加安全**：配对开关、常量时间比较、body 限制、状态文件权限。
9. **加 UI**：机器列表、任务记录、起名、配对、限速提示、错误态。
10. **跑一致性测试**（§6）：先自测，再与参考实现互测，再跨平台。
11. **写实现说明**：声明支持的级别（L0–L3）、可选能力（tsnet）、已知限制、未实现项。
12. **不要**在协议里加 IDE 专有字段；需要就在本地 API/UI 层做。

---

# 6. 验收与一致性测试

## 6.1 互通验收（P0）

任意新实现（记为 X）必须与参考实现 R 完成以下双向测试：

| # | 场景 | 通过判据 |
|---|---|---|
| C1 | X 与 R 同网段 | 双方 5s（组播）/60s（扫描）内互相可见；`machine/host/port/version` 正确 |
| C2 | R → X 派任务 | X 入箱；`status` 不为 `accepted` 终态；若 X 为 L3，会话开跑 |
| C3 | X → R 派任务 | R 入箱并唤醒/注入了正确会话 |
| C4 | 回传 | 结果回到发起方**原会话**；双方都不新建无关会话 |
| C5 | thread 复用 | 同 thread 第二条进入同一会话；`newSession` 能强制新建 |
| C6 | 闸门 | `noWake`/短正文/寒暄/限速各自只入箱，并写出原因 |
| C7 | 配对 | 错误 token 403；正确 token 200；开关即时生效 |
| C8 | 能力 | X 的名片在 R 的 UI 正确显示；R 的 `null` 能力在 X 显示"未知" |
| C9 | 版本 | v1/v2 名片互发不报错；未知字段忽略 |
| C10 | 断线 | R 离线 20s 内 X 标记离线；恢复后重新在线 |
| C11 | 重启 | X 重启后 instanceId 不变；不产生重名/双记录 |
| C12 | 安全 | 组播不含 secret/MAC；状态文件 0600；未配对读接口也 403 |

## 6.2 线级测试夹具（建议随实现提供）

```text
fixtures/
  card-v1.json           # 最小 v1 名片
  card-v2.json           # 带 fingerprint/tailnetIp/capabilities
  card-v2-unknown.json   # 含未知字段，必须忽略
  task-min.json          # 最小合法任务
  task-full.json         # 全字段
  task-invalid-*.json    # 缺 task / 非 JSON / 超大
  reply-chain.json       # 派发→回传的完整时序
```

断言：
- 解析 v1/v2 不抛错；
- 未知字段不进入业务；
- `capabilities: null` 保持 null；
- `duplicate` 幂等；
- 会话键与参考实现逐字一致（用固定输入对拍）。

## 6.3 黑盒互操作脚本（建议）

```bash
# 1) 起参考实现（隔离实例）
MACHINE=ref PORT=45917 ./dev-setup.sh meshtest /tmp/dsh-mesh-ref
# 2) 起被测实现 X（另一台机器或另一端口）
# 3) 双向探测
curl -s http://<ref-ip>:45917/mesh/v1/health
curl -s http://<x-ip>:45917/mesh/v1/health
# 4) 派发一条可回传的任务
#    期望：X 入箱、回传、ref 原会话收到
# 5) 互看 peers/tasks，核对状态与原因
```

## 6.4 Definition of Done（新 IDE 实现）

```text
[ ] 声明实现级别：L0 / L1 / L2 / L3（不得夸大）
[ ] 通过 §6.1 的 C1–C12
[ ] 卡片 v1/v2 双向解析；未知字段忽略
[ ] 会话键算法与参考实现逐字一致（对拍）
[ ] 回传绑定顺序正确（先绑定再请求）；回传零新建
[ ] 所有闸门都写 status + reason，无静默丢弃
[ ] 能力三种"不知道"可区分；探测失败不变成否定事实
[ ] 配对开关即时生效；错误 token 403；状态文件 0600
[ ] 端口被占能降级并上报实际端口
[ ] 崩溃/重启后 instanceId 不变、记录不重复
[ ] UI 有空状态、错误态、改名、任务记录
[ ] 文档写清：支持/不支持、已知限制、明文 HTTP 边界
[ ] 与参考实现互测记录（版本、平台、日期、结果）
```

---

# 7. 附录

## 7.1 配置项（参考实现完整清单）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `machineName` | string | `""` | 机器名；空 = 用主机名并提示起名 |
| `port` | natural | `45917` | 对端 HTTP 端口；被占回退随机 |
| `announceIntervalMs` | natural | `5000` | 组播心跳周期 |
| `peerTtlMs` | natural | `20000` | 无证据多久判离线 |
| `requestTimeoutMs` | natural | `20000` | 单次派发超时 |
| `useMulticast` | boolean | `true` | 组播发现 |
| `scanOnStart` | boolean | `true` | 启动扫描 |
| `scanIntervalMs` | natural | `60000` | 周期扫描；0 = 关 |
| `scanRanges` | string[] | `[]` | 额外扫描网段 |
| `scanPorts` | natural[] | `[]` | 额外扫描端口 |
| `scanConcurrency` | natural | `64` | 扫描并发 |
| `scanTimeoutMs` | natural | `800` | 单地址超时 |
| `pingIntervalMs` | natural | `10000` | 已知对端保活；0 = 关 |
| `tsnetProbeIntervalMs` | natural | `60000` | tailnet 探测周期 |
| `requirePairing` | boolean | `false` | 配对开关；true 时钉死 |
| `agentPreset` | string | `"standard"` | 新建会话的 Agent preset |
| `permissionPreset` | string | `"workspace-write"` | 新建会话权限 |
| `workspaceRoot` | string | `""` | 新建会话工作目录；空回退用户主目录 |
| `tsnetEnabled` | boolean | `false` | 跨互联网组网 |
| `tsnetAuthKey` | string | `""` | Tailscale 授权码（可复用） |
| `tsnetControlUrl` | string | `""` | 控制服务器；Headscale 用 |
| `tsnetHostname` | string | `""` | 节点名；留空用机器名；插件会加 `dsh-` 前缀 |
| `tsnetDownloadSources` | string[] | `[]` | 自定义下载源前缀 |
| `tsnetPermissionPreset` | string | `""` | tailnet 入站权限；空 = 与局域网一致 |
| `maxWakesPerThread` | natural | `30` | 每窗口最多自动唤醒；0 = 不限 |
| `threadWindowMs` | natural | `3600000` | 滑动窗口 |
| `threadCooldownMs` | natural | `5000` | 两次建会话的最小间隔 |
| `minTaskChars` | natural | `24` | 过短正文只入箱 |

> 在 DSH 的 `cordis.patch.yml` 中，`config:` 是**整体替换**而非合并。新增一个键时必须重述想保留的所有键，否则其余键回落到 schema 默认值。

## 7.2 端口与地址

| 用途 | 地址 |
|---|---|
| 对端 HTTP | `0.0.0.0:45917`（可配置；被占回退随机） |
| 组播发现 | `239.255.42.99:45892`（UDP） |
| tailnet 入站 | sidecar 监听 tailnet `:<mesh端口>` → 反代 `127.0.0.1:<mesh端口>` |
| 本地 UI/控制 API | 宿主随机端口，**仅 127.0.0.1**；不要写进跨机文档 |

## 7.3 任务状态与原因

| `status` | 含义 |
|---|---|
| `accepted` | 已入箱，尚未路由 |
| `dispatched` | 已新建会话并注入 |
| `injected-thread-session` | 注入同 thread 原会话 |
| `injected-queued` | 建会话期间排队，建成后注入 |
| `queued-for-session` | 正在排队 |
| `queued-lost` | 会话建成后已不可注入 |
| `noted-only` | 只入箱（noWake/过短/寒暄/冷却） |
| `throttled` | 撞滑动窗口上限 |
| `busy` | 队列背压 |
| `stored-only` | 唤醒能力不可用 |
| `dispatch-failed` | 新建会话失败（必须有 `dispatchError`） |

## 7.4 示例：一次完整往返

```jsonc
// 1) A → B 派发
POST http://192.168.1.9:45917/mesh/v1/task
{
  "id": "t-111111111111",
  "from": "客厅的Mac/peng",
  "fromMachine": "客厅的Mac",
  "task": "把 /tmp/report.csv 的行数统计出来，用 mesh_run 回传给 客厅的Mac，thread=reg-1",
  "thread": "reg-1",
  "originSession": "s-A1"
}
// 2) B 受理
{ "ok": true, "id": "t-111111111111", "duplicate": false }
// 3) B 的 Agent 执行后回传
POST http://192.168.1.6:45917/mesh/v1/task
{
  "id": "t-222222222222",
  "from": "文超-win/wc",
  "fromMachine": "文超-win",
  "task": "统计完成：共 1024 行。",
  "thread": "reg-1",
  "originSession": "s-B7"
}
// 4) A 用 conversationKey("文超-win", "reg-1") 命中 s-A1 → 注入
//    注意：s-B7 是 B 的会话，与 A 无关，只作为 replyTo 记录
```

## 7.5 术语对照（中英）

| 中文 | English |
|---|---|
| 名片 / 自述 | card / self record |
| 会话键 | conversation key |
| 回信地址 | reply address (`originSession`) |
| 线程 | thread |
| 端点 / 通道 | endpoint / transport |
| 认领 | claim (fingerprint) |
| 闸门 | gate |
| 背压 | backpressure |
| 租约 / 存活期 | TTL |
| 守护进程 | core daemon |

## 7.6 协议变更记录（本文档维护）

| 日期 | 变更 | 兼容性 |
|---|---|---|
| 2026-10-21 | 初版：整理 0.3.36 的卡片 v2 / API v1 / sidecar v1；补跨 IDE 契约与 v3 草案 | 文档 |
| （未来） | 卡片 v3 定稿、本地控制 API v1 | 需更新 §4.2.4/§4.5 与兼容矩阵 |

---

## 附：给实现 AI 的最后提醒

1. **先对拍会话键和任务状态**，再写 UI。90% 的"互通失败"都在这两处。
2. **不要用对方的 `originSession` 在本机找会话** —— 那是回信地址，不是本机会话 id。
3. **不要让探测失败变成"没有"** —— 这是本项目历史上最贵的 bug。
4. **不要硬拒版本** —— 现场永远有旧机器。
5. **不要只测自己连自己** —— 必须与参考实现互测，且覆盖"旧版对端"。
6. **如实声明能力级别（L0–L3）** —— 做不到自动唤醒就说 L2，不要伪装。
