# 贡献者

这个项目不是一个人写出来的。

0.5 之后的很多部分，来自别人的真机、别人的报错、别人半夜贴出来的一段复现日志：
有人一口气交了 23 个 PR，把 Windows / Android 上的坑一个个填掉；有人在自己两台机器上
复现出「看起来卡住」的 bug，把对端提示词的原文一起贴了出来；第一个外部 issue
把 thread 路由这条主线直接拽了出来。名字列在这里是记账，不是客套。

> 想加入这份名单：提一个 PR，或者提一个**能复现**的 issue 就够了 ——
> 见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 维护者

| 谁 | 负责 |
|---|---|
| **[@peng456](https://github.com/peng456)** | 项目发起人 / 维护者 —— 协议、持久化、发版流水线、安全 |

## 核心贡献者

### [@sakikoTGW](https://github.com/sakikoTGW) · 23 个 PR

0.5.0 里「看得见」的那一大半，基本是他做的。按交付的块列：

- **平台兼容的一串硬修**：Windows sidecar 资产名补 `.exe`（#3，此前下载必 404 且跳过校验）、
  虚拟显示适配器不再冒充 GPU（#4）、WindowsApps 不进探测 PATH 且 `exit 9009` 记为不确定（#16）、
  `mesh_scan` 漏传 `log` 导致调用必报错（#2）。
- **网络边界**：发现 / 心跳 / 扫描 / tailnet 一圈的修复 —— LAN 以观察到的地址为准、自述 host 不能改派发目标（#7），
  心跳不再清零出站失败冷却（#8），`scanRanges` 是额外网段、非法 CIDR 不再静默扫 0 个（#10），
  未验证端点按间隔重试（#11）。
- **限速与接口校验**：提高上限按会话键生效、逃生通道不再形同虚设（#5）；
  状态变更接口只接受 POST、配对开关拒绝非布尔值（#6）；tsnet 诊断读对字段、fetch 异常不再卡死按钮（#9）。
- **CI 与状态持久化**：三平台测试矩阵（ubuntu / macos / windows × Node 20/22/24，#14）；
  跨 profile 锁 + 原子写 + 损坏时 fail-closed（#15）。
- **能力与诊断**：系统身份（`osInfo` / `systems` / WSL 运行时）与系统 logo（#13）；
  诊断接口（进程版本 vs 磁盘版本）+ 任务记录详情（#17）。
- **文档**：修未闭合围栏、过期默认值与不存在的命令（#12）；Mesh 定义 v0.2 —— 账号/会话模型、目录布局（#18）。
- **界面与布局**：三层 Mesh 工作台与动作锚定传输（#19）、卡片工作台主页（可拖拽 / 缩放 / 专注模式，#20）、
  手机端适配（<768px 安全区 / 触控 / 键盘，#29）、每个 profile 一个 `mesh/` 且会话工作区落在 `mesh/sessions/`（#24）。
- **0.5.0 主干**：[#30 完整 mesh](https://github.com/peng456/dsh-plugin-mesh/pull/30) —— 0.5.0 host + 工作台 UI +
  手机/桌面 + 每 profile `mesh/` 目录，是 10-21 那次大合入。
- 还挂着一个没合完的：[#21 配对码二维码](https://github.com/peng456/dsh-plugin-mesh/pull/21)
  （内置编码器，不调在线服务）—— 等 rebase，不是被搁置。

### [@geekstartup42](https://github.com/geekstartup42) · 2 个 PR，均已合并

- [#34](https://github.com/peng456/dsh-plugin-mesh/pull/34)：同一 thread 的多轮任务不再被判成回执
  （D-001 / #33）—— 回执改成「发送方声明 `answers` + 接收端认领一次」，修掉 0.5.20 的「第 2 轮石沉大海」，
  随 0.5.22 发出。
- [#35](https://github.com/peng456/dsh-plugin-mesh/pull/35)：`state.json` 原子写 + 损坏时 fail-closed
  —— 文件读不出来不再悄悄把配对关掉，随 0.5.23 发出。
- 另外在 [#31](https://github.com/peng456/dsh-plugin-mesh/issues/31) 里写下了 0.5.22 之后 thread / 账本 / `replyWindowMs`
  的完整基线，让那个提案能落在确切事实上，而不是靠记忆。

### [@chengle0575](https://github.com/chengle0575) · 1 个 PR

- [#22](https://github.com/peng456/dsh-plugin-mesh/pull/22)：第一个外部代码修复尝试（issue #1 的 Codex 版补丁）。
  最后修复走了 #25 的路子，但这份补丁让「运行期状态没登记」这件事第一次被完整读了一遍。

## 提 issue 的人

这三个 issue 直接改变了代码，不只是「收到，谢谢」：

| 谁 | issue | 后来 |
|---|---|---|
| **[@WinWindWing](https://github.com/WinWindWing)** | [#1](https://github.com/peng456/dsh-plugin-mesh/issues/1) 派发时未登记 `threadState`，回传永远落不进发起会话 | 项目的**第一个外部 issue**：带行号、带实测放大效应（20 分钟 4 个会话、同一个 thread 6 分钟被唤醒 7 次）。促成 #25 的回传绑定，也是后来 thread 路由的主线 |
| **[@sillywhalebot](https://github.com/sillywhalebot)** | [#33](https://github.com/peng456/dsh-plugin-mesh/issues/33) 同一 thread 的第 2 条派发被当成回执，对端不再回派 | 复现步骤、版本、对端提示词原文都给全了 —— 修的时候几乎不用二次确认。产出 #34，0.5.22 修好 |
| **[@kingofpantheon](https://github.com/kingofpantheon)** | [#31](https://github.com/peng456/dsh-plugin-mesh/issues/31) 给 thread 补任务归属元数据 + 只读检索（避免多任务串味） | 第一个点出「thread 串味」这条线的提案。误判回执的部分已由 #34 解决；剩下「归属元数据 + `GET /mesh/v1/threads`」还没实现，提案暂时关闭，想推的人可以直接接 |

## 机器人们

- **[@dependabot[bot]](https://github.com/apps/dependabot)**：CI 依赖升级都靠它提，从没错过。
- **github-actions**：合并即发、三平台回归、Release 资产 —— 没人夸它，但它没停过。

## 怎么算贡献

提 PR、提 issue、补一个能复现的最小步骤、修一句文档里说错的默认值、在真机上替别人验一遍、
把任务派到另一台机器上跑通 —— 都算。

名单按 PR / issue 记录**手工**维护：名字漏了、写错了，直接开 issue 或 PR 改，
这本身也是一次贡献。

---

赞助方（OMDSH，提供模型 token / 算力）在 [README 的「赞助方」一节](README.md#赞助方)。
