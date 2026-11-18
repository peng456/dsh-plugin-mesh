# 证据与口径

> `ROADMAP.md` 里每个数字的来源。**新增结论时先来这里记一行**，否则下一个人无法复核。

## 1. 数字来源

| 数字 | 来源 | 采集时间 |
|---|---|---|
| commits / tags / 作者分布 | 本地 `git log`、`git tag` | 2026-10-23 |
| 6 star / 2 fork / 0 open issue / 2 open PR | GitHub REST API `repos` + `issues` | 2026-10-23 |
| 924 周下载 / 375·483·66 日分布 | npm registry downloads API | 窗口 2026-10-12 ~ 10-18 |
| 299,775 周下载（dsh 平台） | npm downloads API，同一窗口 | 2026-10-23 |
| MCP 39.4M / A2A 2.34M 周下载 | npm downloads API，同一窗口 | 2026-10-23 |
| A2A 26.3k star、仍活跃 | GitHub API `a2aproject/A2A` | 2026-10-23 |
| 竞品 star 数 | GitHub API（各仓库） | 2026-10-23 |
| 11 条目录 / 5 个社区插件 | dsha.cc 首页文本 | 2026-10-23 |
| 41 条任务与状态（收到 20 / 派出 21） | 本机 `mesh_tasks` 账本 | 2026-10-23 |
| 3,900 万 token/日、98.6% 缓存、789k 上下文 | `mesh-survey/2026-10-21-mesh-survey.md` | 2026-10-21 |
| 54 会话 / 800 万 token 的循环事故 | `README.md`「循环限速」节 | 仓库内记录 |
| 版本 0.5.20 / 28 套件 | `package.json`、`ls lib/_selftest-*.mjs` | 2026-11-18 |
| 无状态机 / 无取消 / 无结果契约 | `grep -rn 'cancel' lib/` 零命中；状态是散落字符串 | 2026-11-18 |
| 无事件流 | `grep -rn 'text/event-stream\|EventSource' lib/` 零命中 | 2026-11-18 |
| 无 skill 形态 | 全仓 `find . -name SKILL.md`（排除 node_modules）为空 | 2026-11-18 |
| 无群概念 | `grep -n 'group' lib/index.js` 只有面板按 machine 分组的展示逻辑 | 2026-11-18 |
| 两份协议实现 | `lib/` + `mcp-mesh/mesh-node.mjs`（自建组播 + `/mesh/v1` 兼容 + 自报 `app:"dsh-mesh"`） | 2026-11-18 |
| 三壳实测：extension 可用 / 页面被 CORS 挡 / IWA 未跑通 | `dsh-mesh-web/README.md` + `verify/` | 2026-10 |
| 纯页面探测：命中 0 · 无应答 253 · 超时 1 | `dsh-mesh-web/README.md`（对 mesh 节点 :45917 实测） | 2026-10 |
| `dsh-mesh-web/node_modules` symlink 到外部部署 | `ls -la dsh-mesh-web/node_modules` | 2026-11-18 |
| CC / opencode 无头与复用参数 | `claude --help`（`-p` `--resume` `--session-id` `--mcp-config`）、`opencode run --help`（`-s/--session` `-c` `--attach`） | 2026-10-26 |
| ACP 实测 | 最小 ACP client：`initialize → session/new → session/prompt` 全通，返回 `end_turn` + usage；`session/list` 列出 17 条历史 | 2026-10-26 |
| Codex 未安装 | `command -v codex` 为空 | 2026-10-26 |
| WorkBuddy 已注册 mesh MCP | `~/.workbuddy/mcp.json` | 2026-10-26 |

## 2. 已知口径缺陷

| 缺陷 | 影响 | 什么时候修 |
|---|---|---|
| npm 只有三天有数据 | 无法区分「曝光脉冲」与「统计缺失」 | R-v1 补测 |
| 「≥2 台设备联通用户数」没有任何埋点 | 当前是估计值（1–3） | R-v1 建立基线 |
| 「首次成功派发」没有激活事件 | 漏斗后三格全黑 | U-v2（`mesh demo` 落地时） |
| 竞品 star 与下载是单点快照 | 无法看趋势 | 需要时重采 |

> 原则：**宁可写「未测」，不要写估计值当事实**。这条与 `AGENTS.md` 的
> 「探测失败不能看起来像否定事实」是同一条纪律。
