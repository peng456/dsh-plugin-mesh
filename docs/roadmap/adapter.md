# A · 接入 子路线图（MCP · Skills / 多宿主 / dshInWeb 适配）

> 父文档：[`ROADMAP.md`](../../ROADMAP.md) §2 · 被 [`C-v1`](./protocol.md) 收编闸住。
> 架构：[`../design/同机多Agent设计.md`](../design/同机多Agent设计.md) · 分级：[`../PLUGIN-SPEC.md`](../PLUGIN-SPEC.md) §5.2.1

**回答什么**：别的 agent 和别的宿主能不能用我？能到什么程度？

**形态清单**（不是「写 N 个壳」）：DSH 插件 · CLI `mesh` · MCP（stdio + HTTP）· skill ·
ACP（作为节点向下的执行通道）。**内核一份，壳里不许有协议。**

**三条子轨**（同一方向下的三种「接入面」，各自有独立验收）：

| 子轨 | 接的是谁 | 关键判据 |
|---|---|---|
| **① MCP · Skills** | 任何有 MCP 或 skill 能力的宿主 | 接一个 URL / 装一个 skill 就能发现并派发，**不给每家写适配** |
| **② 多宿主适配** | Claude Code · Codex · WorkBuddy · opencode · VS Code · Copilot | 每宿主自报 `wakeLevel` 且**实测**能唤醒；未实测只标「实验」 |
| **③ dshInWeb 适配** | 浏览器里的 dsh（page / IWA / extension 三壳） | 浏览器里能发现并操作 mesh 节点；**它当看板与遥控器，不当节点** |

> 与 [`C-v1`](./protocol.md) 的分工：**C 管「代码只有一份」（收编 core），A 管「形态跑得通」（验收）。**
> dshInWeb 的代码收编落在 C-v1；「浏览器能不能用」这条验收在 A。

---

## 现状（v0）

| 形态 / 宿主 | 状态 |
|---|---|
| DSH 插件 | ✅ L3（进程内建/注入会话，thread → session） |
| MCP stdio（`mcp-mesh`） | 🟡 已接 WorkBuddy；但它自带一份协议实现（见 [`protocol.md`](./protocol.md)） |
| MCP HTTP | ❌ 未做 |
| skill | ❌ **全仓没有 `SKILL.md`** |
| Claude Code | 🟡 参数实测（`-p` / `--session-id` / `--resume` / `-t http`），未接 |
| opencode | 🟡 参数实测（`run` / `-s` / `--attach` / `acp` stdio），未接 |
| Codex | ❌ 未安装（`codex exec` 是推断） |
| WorkBuddy | 🟡 MCP 已接；CLI 脱离 `app.asar` 后 `--help` 缺模块，**无头未验** |
| VS Code / Copilot | ❌ 未开始（两者合并成一行，本质同一件事） |

**宿主能力分级**：L0 只读 → L1 收件箱（能收能派，不唤醒）→ L2 用户触发（通知 + 一键执行）→ L3 自动唤醒。
**`wakeLevel` 必须自报，对端必须照它办事**：说 L2 就给「一键执行」，而不是等一个永不到来的回执。

---

## 版本史

> 这张表只记「什么时候从什么变成什么」；每个版本的细则在下面各节。
> **每次发版往这里追加一行**，不覆盖历史。

| 版本 | 状态 | 内容摘要 | 时间 |
|---|---|---|---|
| v0 | 已发布（≤0.5.20） | DSH 达 L3；MCP stdio 已接 WorkBuddy；CC / opencode 参数实测未接；无 `SKILL.md` | 2026-11 |
| v1 一个 URL | 计划 · 一半可立刻开始 | MCP HTTP + `wait_any` + 首个 skill + CC/opencode 实测 | — |
| v2 唤得醒 | 计划 · 等 `C-v1` | 唤醒矩阵落地 + 守护进程 + 薄适配器 + Codex/WorkBuddy 补齐 | — |
| v3 外人接 | 条件触发 · 与 `C-v3` 同开 | A2A 适配器 | — |

## A-v1 · 一个 URL 就能接

| 工作项 | 做到什么 | 验收 |
|---|---|---|
| MCP HTTP 传输 | 只回环 `127.0.0.1` + token（决策 A5） | 一个 URL 接进来，不给每个宿主写适配 |
| `wait_any` | `mesh_wait(threads:[a,b])` 一次订阅多路 | 并发等 N 路不占额外回合 |
| 首个 `SKILL.md` | 纯 skill 宿主能发现并派发 | 一个非 MCP 宿主也能用 |
| CC / opencode 实测接入 | 用已验参数接通 | ≥3 个宿主实测能收能派 |

**为什么 MCP HTTP 优先级最高**：本机 `claude` 与 `opencode` 都支持 URL 形态的远程 MCP
（`claude mcp add -t http`、`opencode mcp add --url`）。**接一个 URL 就够，不为每家写代码。**

---

## A-v2 · 唤得醒

| 工作项 | 做到什么 |
|---|---|
| 唤醒矩阵落地 | 每个宿主一行：唤醒方式 / 会话复用 / 实测状态 / 目标级别 |
| 守护进程 + 薄适配器 | 方案 B，给 IDE 类宿主；IDE 重启不掉线 |
| Codex / WorkBuddy 补齐 | Codex 只出配置生成器并标「未实测」；WorkBuddy 先验无头能不能跑 |

**硬规则（写进实现，不是建议）**

1. 未实测的宿主只能标「实验」，**不进 README 支持矩阵**。
2. 拉起无头进程必须带四样预算：超时、并发上限、工作目录、权限档位 —— 少一样就是 `rm -rf` 直通车。
3. 同一 session 被两个进程续跑必须串行化（依赖 [`R-v2`](./route.md)）。
4. ACP 是「宿主 → agent」的纵向协议，提供 `session/update`（映射成事件流）、
   `session/request_permission`（现成的危险动作确认）、`session/list`（thread 复用）；
   但它**不提供发现 / 寻址 / 配对** —— 那些仍是 Mesh 的活。`opencode acp --port` 的 TCP 模式实测不可用，只走 stdio。

---

## A-v3 · 外人也能接

A2A 适配器（与 [`C-v3`](./protocol.md) 一起开）：Mesh 节点作为 A2A agent 对外，
内核不重写只做映射。验收：一个非 DSH 客户端能派任务并拿到终态。

---

## 闸门

**入**：A-v2+ 必须等 [`C-v1`](./protocol.md) —— 不先收编，接一个宿主多一处分叉。
A-v1 的一半（MCP HTTP + `wait_any` + skill）**不等交账**，可以立刻做。
**出**：A 不闸别人。

## 边界

- 不做「非 DSH 用户也能装」的独立客户端（1.0 前）
- 不做本地 agent 之间的直连（每次跨 agent 调用都从节点出去）
- 不做「参数存在就算支持」—— 必须真跑通一次往返
