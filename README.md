# dsh-plugin-mesh

**装一个插件，把跑不完的活交给另一台电脑；跑完，结果回到你面前。**

两台（或几台）装了 DSH 的电脑各自装上它，打开 Mesh 就能互相看见 —— 不用配对码、不用填 IP、不用装 Tailscale 客户端。点一台机器，写下要它做什么，派过去；它会在那边开一个会话去做。你不用盯着。

> 🎬 **60 秒看它怎么工作**：<https://peng456.github.io/dsh-plugin-mesh/demo.html>
> （示意动画，不连接任何机器；真实的"派发 → 在跑 → 结果回来"就是那个样子。）
>
> **没有第二台电脑？** 装好后打开 Mesh 侧栏 → 点「看演示」，在一台机器上就能看完整个闭环。

---

## 它解决的是什么

不是"组网"，是这三个具体时刻：

| 你的处境 | 它做的事 |
|---|---|
| 这个活太重，笔记本风扇要起飞了 | 丢给台式机 / 那台吃灰的旧电脑跑 |
| 长任务跑到一半，你要合盖走人 | 活在那台机器上继续跑，结果回到任务记录里 |
| 人在外面，只想让家里的电脑干件事 | 从手机上的 DSH 派过去，回家看结果 |

**以前**：两台机器各干各的，你在中间来回搬上下文、复述需求、复制结果。
**现在**：一句话派过去，对端的 agent 自己开跑；结果由它派回来，落在「任务」里。

---

## 这不是"远程执行"，是 agent 之间互相派活

A 的 agent 把任务交给 B 的 agent；B 自己决定怎么做、用什么命令、做完把结果派回来。
你不需要在两台机器之间搬上下文 —— 你只需要说清楚"要什么结果"。

链式也可以：A 派给 B 编译，B 做完再交给 C 部署验证，最后结果回到 A。
（对端的 agent 可以用 `mesh_run` 继续往下一台派。）

### 几个真实用法

| 场景 | 你在某一台机器上说 | 对端 agent 做的事 | 你收到的 |
|---|---|---|---|
| **PC 编译** | 「拉最新代码，编译 Windows 版，产物和报错都发我」 | 拉代码、跑构建、收集产物与错误 | 产物路径、退出码、报错摘要 |
| **Android 部署验证** | 「把刚编的包装到 Android 上，启动一下，截图和日志发我」 | 安装、启动、截图、抓日志 | 截图、关键日志、启动是否成功 |
| **插件适配** | 「在 Windows 那台点『检查更新』装到最新版，重启，确认 health 里的版本是新的」 | 升级、重启、请求 `/mesh/v1/health` | 版本号、是否真的生效 |
| 长任务 | 「跑完整测试，失败的用例发我」 | 跑测试、整理失败 | 摘要 + 退出码 + 失败用例 |
| 旧电脑借算力 | 「把这段视频转成 1080p，放回 `~/Movies`」 | 转码、校验 | 完成/失败 + 文件路径 |

> 例子里的每一句都能直接派。派发方式：Mesh 面板的「派发任务」，或会话里以 `@机器名` 开头。

---

## 5 分钟上手

**第 1 步 · 每台机器装一次**

```bash
dsh plugin add dsh-plugin-mesh
```

- `desktop` profile 要在 **DSH Desktop 自带的终端**里跑（普通终端会被 dsh 拒绝）；
- 其它 profile 用普通终端即可；
- 装完**必须重启一次 DSH** —— 插件在启动时加载；
- 插件**零运行时依赖**：安装只解包，不跑构建脚本 —— 所以 iPad（DSH Go）这类不允许
  依赖跑构建脚本的宿主也装得上。只有「SSH 终端」要一个可选模块 `ssh2`（默认不装，
  缺了只影响 SSH），要用时在 profile 目录 `pnpm add ssh2`。

**第 2 步 · 起个名字**

打开侧栏的「Mesh」，第一次会让你给这台机器起名（默认填主机名）。别的机器就靠这个名字找你。

**第 3 步 · 看到对方**

两台在同一局域网、都重启过，几秒内就会互相出现。看不到就点「局域网探测」，它直接扫本网段，不依赖组播。

**第 4 步 · 派一个活**

在设备页选一台机器 →「派发任务」→ 写清楚要它做什么。或者直接在会话输入框里以 `@机器名` 开头说话。

**第 5 步 · 看结果**

派出去只是「送达」。对端跑完会把结果派回来，出现在「任务」里。
默认装好就能直接派活，不用配对码、也不用点任何确认 —— 要加一道保护见下面「安全」。

---

## 安全：默认能直接派，保护按需打开

- **默认零配置**：同一局域网里发现即可互相派活，没有确认弹窗。这是刻意的 —— 装上就能用是它的价值。
- 在不可信网络（公司、合租、咖啡厅）里，打开「配对码」：两端用同一个码，码不一致的派活请求直接被 HTTP 403 拒掉。
- 配对码走的是**明文 HTTP 头**：它挡的是误连上来的陌生设备，挡不住同网段的抓包嗅探 —— 完全不可信的网络别只靠它。
- 暂时不想被任何人找到：用面板上的「一键关闭」停掉局域网 / 互联网组网。
- 对端派来的任务默认用 `workspace-write` 权限，不给 `danger-full-access`。
- `state.json` 原子写入并保留 `.bak`；文件与备份都损坏时**强制开启配对**（fail-closed），损坏现场另存为 `state.json.corrupt-*`，不会因为读不出来就悄悄把配对关掉。
- 所有数据都在本机：没有账号、没有云端、不上报任何统计。

---

## 常见问题

**看不到另一台机器？**
① 两台在同一局域网？② 对端也装了、也重启了？③ 防火墙放行 TCP `45917` 和 UDP `45892`？
还不出现就点「局域网探测」—— 只要端口通，扫描就能发现，不依赖组播。

**结果在哪？**
在「任务」里。派发的返回只代表对端**收下了**，不代表跑完了；跑完的结果由对端派回来。

**Android 上的 DSH 老掉线？**
是系统省电在杀后台，不是插件的问题。把 DSH 加进电池优化白名单。

**跨互联网能用吗？**
能。在「连接 → 互联网组网」里填一次 Tailscale 授权码，插件会自动下载并运行一个用户态节点，不需要装 Go、不需要装 Tailscale 客户端。功能与局域网同级。

---

## 平台

macOS（Intel / Apple Silicon）· Windows · Linux · Android（Termux）· WSL。
固定端口 `45917`；同一台机器跑多个实例时会自动退回随机端口（组播仍可发现）。

---

## 路线图：往哪走（每个方向都会演化）

七个方向各自迭代 v1/v2/v3，**版本号是能力增量，不是时间，也不跨方向对齐**。
方向之间没有全局顺序，只有**闸门** —— 多数方向的下一版都等 R-v1（事件层）先到位，其余可以并行。

| 方向 | 现在 | 下一版 | 子路线图 |
|---|---|---|---|
| **会话事件智能路由** | 派出即止，无终态 | 调用事件流模型重构 + 任务流水账（journal） + 结果信封 + 取消 | [route](https://github.com/peng456/dsh-plugin-mesh/blob/main/docs/roadmap/route.md) |
| **接入** | DSH + MCP 手接 | MCP · Skills<br>CC / Codex / WorkBuddy / opencode / VS Code / Copilot 等适配<br>dshInWeb 适配 | [adapter](https://github.com/peng456/dsh-plugin-mesh/blob/main/docs/roadmap/adapter.md) |
| **trace** | 无 | 状态时间线（等 R-v1） | [trace](https://github.com/peng456/dsh-plugin-mesh/blob/main/docs/roadmap/trace.md) |
| **玩法** | 一对一派发 | 组群 | [play](https://github.com/peng456/dsh-plugin-mesh/blob/main/docs/roadmap/play.md) |
| **界面** | 面板 + 任务列表 | 结果卡 + 通知 + `mesh demo` | [ui](https://github.com/peng456/dsh-plugin-mesh/blob/main/docs/roadmap/ui.md) |
| **协议** | 两份实现（`lib/` + `mcp-mesh`） | 收编成一份 + 名片区 v3 | [protocol](https://github.com/peng456/dsh-plugin-mesh/blob/main/docs/roadmap/protocol.md) |
| **安全** | 同网段默认可派 | 幽灵对端校验 + 高危动作确认 | [security](https://github.com/peng456/dsh-plugin-mesh/blob/main/docs/roadmap/security.md) |

每个子路线图里都有：**现状证据 → 版本史（v0 已发布 / v1 计划 / v2、v3 条件）→ 各版验收判据 → 闸门 → 不做什么**。
版本细则发版时追加，不覆盖历史。

**今天就缺的那一件**：派出去的任务没有终态 —— 返回 `200` 只说明对端**收下了**，
不代表跑完了，也不能取消。它闸住了 trace / 结果卡 / 扇出三条方向。

完整矩阵（v2/v3、闸门表、验收判据、指标、风险、明确不做什么）见
[`ROADMAP.md`](https://github.com/peng456/dsh-plugin-mesh/blob/main/ROADMAP.md)。

---

## 深入阅读

| 想要什么 | 去哪 |
|---|---|
| 路线图、决策记录、指标与不做什么 | [`ROADMAP.md`](https://github.com/peng456/dsh-plugin-mesh/blob/main/ROADMAP.md) |
| 给 agent 的机器可读事实（工具、配置项、端口） | [`llms.txt`](llms.txt) |
| 英文快速上手 | [`README.en.md`](README.en.md) |
| 设计取舍、组播/防火墙/tsnet 细节、配置项全表、排障 | [`docs/DESIGN-NOTES.md`](https://github.com/peng456/dsh-plugin-mesh/blob/main/docs/DESIGN-NOTES.md) |
| 设计与实施记录（任务追踪 / 同机多 agent / 身份与通道 / 放置） | [`docs/design/`](https://github.com/peng456/dsh-plugin-mesh/tree/main/docs/design) |
| 改这个仓库前的硬约束与坑 | [`AGENTS.md`](AGENTS.md) |
| 参与开发、发版流程 | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| 贡献者名单（每个 PR / issue 换来了什么） | [`CONTRIBUTORS.md`](CONTRIBUTORS.md) |

---

## 参与开发

合并进 `main` 会自动测试、发 npm 包和 GitHub Release，你不需要碰版本号。
本地先跑：

```bash
npm install
npm run check
npm test
```

有问题或想提需求：<https://github.com/peng456/dsh-plugin-mesh/issues> · 邮箱 `geekstartup@163.com`

---

## 贡献者

这个项目不是一个人写出来的 —— 0.5 之后的很多部分，来自别人的真机、别人的报错和别人的 PR。
名字列在这里是记账，不是客套。

| 贡献者 | 做了什么 |
|---|---|
| <img src="https://github.com/sakikoTGW.png?size=64" width="22" height="22" valign="middle" alt=""> **[@sakikoTGW](https://github.com/sakikoTGW)** | **23 个 PR**：Windows / Android 平台兼容的一串硬修、三平台 CI 矩阵、系统身份与诊断接口、卡片工作台、手机端适配、每 profile `mesh/` 目录 —— **0.5.0 的主干** |
| <img src="https://github.com/geekstartup42.png?size=64" width="22" height="22" valign="middle" alt=""> **[@geekstartup42](https://github.com/geekstartup42)** | #34 修掉「同一 thread 第 2 轮不回派」（0.5.22）、#35 `state.json` 原子写 + 损坏时 fail-closed（0.5.23） |
| <img src="https://github.com/chengle0575.png?size=64" width="22" height="22" valign="middle" alt=""> **[@chengle0575](https://github.com/chengle0575)** | #22 第一个外部代码修复尝试（issue #1 的补丁） |
| <img src="https://github.com/WinWindWing.png?size=64" width="22" height="22" valign="middle" alt=""> **[@WinWindWing](https://github.com/WinWindWing)** | #1 项目第一个外部 issue：派发未登记 `threadState`，回传落不进发起会话 —— thread 路由这条线的起点 |
| <img src="https://github.com/sillywhalebot.png?size=64" width="22" height="22" valign="middle" alt=""> **[@sillywhalebot](https://github.com/sillywhalebot)** | #33 同一 thread 的第 2 条派发被判成回执：复现步骤、版本、对端提示词原文一起给全，直接产出 #34 |
| <img src="https://github.com/kingofpantheon.png?size=64" width="22" height="22" valign="middle" alt=""> **[@kingofpantheon](https://github.com/kingofpantheon)** | #31 提案：给 thread 补任务归属元数据 + 只读检索，第一个点出「多任务串味」 |

还有 **[@dependabot[bot]](https://github.com/apps/dependabot)** 与发版机器人 —— 不提意见，只保证流程不停。

逐条对账（哪个 PR 换了哪段代码、哪个 issue 促成了哪个修复）在 [`CONTRIBUTORS.md`](CONTRIBUTORS.md)。
想进这份名单：提一个 PR，或者提一个能复现的 issue 就够了。

---

## 赞助方

<a href="https://omdsh.dev/"><img src="https://omdsh.dev/assets/logo-orca.png" width="22" height="22" alt="Oh My DSH"></a> **[OMDSH](https://omdsh.dev/)**（Oh My DSH）· *Beyond the default.* · DeepSeek Harness 开发者社区

独立、非官方，为本项目赞助模型 token（算力）。官网 <https://omdsh.dev/>

感谢 OMDSH 的支持。赞助是支持，不是购买——本项目全部功能免费，赞助不解锁任何能力。

---

MIT · 与 DeepSeek 官方无隶属关系
