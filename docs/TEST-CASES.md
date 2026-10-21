# dsh-plugin-mesh 回归测试用例

> 适用版本：`0.3.36`（协议卡片 v2，HTTP API v1，sidecar 协议 v1）
> 维护方式：新增功能时**先加用例再改代码**；修复线上问题时，把触发条件固化成一条 `BUG-*` 回归用例。
> 配套文档：[`PLUGIN-SPEC.md`](./PLUGIN-SPEC.md)（功能需求 / 架构 / 通信协议）。需求编号 `FR-*` 与本文用例编号互相引用。

---

## 0. 怎么用这份文档

### 0.1 三种执行档位

| 档位 | 何时执行 | 范围 | 预计耗时 |
|---|---|---|---|
| **S 档：发版门禁** | 每次合入 `main` / 发 npm 前 | `AUTO-*` 全部 + `INST-01/02/03` + `DISC-01/06` + `DISP-01/10` + `SEC-01/04` + `UI-01` | 15 分钟（其中 `npm test` 约 90 秒） |
| **R 档：日常回归** | 版本升级、改发现/路由/唤醒/UI 后 | S 档 + 对应模块的 P0/P1 用例 | 1～2 小时（双机） |
| **F 档：完整回归** | 大版本、协议升版、新增 IDE 实现、发版前 | 全文（含 P2、平台矩阵、浸泡） | 半天～1 天 |

### 0.2 优先级

| 级别 | 含义 | 不通过的后果 |
|---|---|---|
| **P0** | 主链路或安全底线 | 禁止发版；两台机器互相看不见 / 任务丢失 / 配对形同虚设 |
| **P1** | 重要能力或可观测性 | 可发版但必须记录 issue；用户会遇到但可绕过 |
| **P2** | 边界、体验、平台差异 | 记录后安排；不阻塞发版 |

### 0.3 结果标记

`PASS` / `FAIL` / `BLOCKED`（环境不具备）/ `N/A`（该平台不适用）。
`FAIL` 必须附：日志片段、`/mesh/v1/health` 返回、`state.json`/`threads.json` 关键字段、复现步骤。

### 0.4 测试环境矩阵

| 编号 | 环境 | 用途 |
|---|---|---|
| E1 | macOS（Intel 或 Apple Silicon）+ Node ≥ 20 + DSH Desktop | 主开发/主回归机 |
| E2 | 同机第二个 profile（`DSH_HOME=/tmp/dsh-mesh-dev`，端口 45918） | 无第二台机器时验证发现/派发/回传 |
| E3 | 第二台物理机（macOS / Windows / Linux 任选） | 真实跨机、防火墙、组播隔离 |
| E4 | Android / Termux（DSHA） | 移动端、省电杀进程、Android sidecar |
| E5 | 无外网或无法访问 GitHub 的网络 | tsnet 下载失败降级、局域网镜像 |

> **不要用生产组播组做测试**：`_selftest-discovery.mjs` 使用私有组与端口。手工起第二个实例时务必改 `port`（如 45918）并设置独立 `DSH_HOME`，否则会在真实局域网里留下一条测试机器记录。

### 0.5 关键观测点（排障时先看这四样）

```bash
# 1) 进程自述身份与版本（唯一可信的"新代码在跑"证据）
curl -s http://127.0.0.1:45917/mesh/v1/health | python3 -m json.tool

# 2) 对端视角（把 127.0.0.1 换成对端 IP；只走 mesh 端口，不要用 GUI 端口）
curl -s --max-time 3 http://<peer-ip>:45917/mesh/v1/health | python3 -m json.tool

# 3) 本机持久状态（配对码、机器名、instanceIds、tsnet 授权码）
python3 -m json.tool "$DSH_HOME/mesh/state.json" 2>/dev/null || \
  python3 -m json.tool "$HOME/.dsh/mesh/state.json"

# 4) 线程绑定与限速账本（判断"复用还是新建""为什么没唤醒"）
python3 -m json.tool "$DSH_HOME/mesh/threads.json" 2>/dev/null || \
  python3 -m json.tool "$HOME/.dsh/mesh/threads.json"
```

任务为什么没跑，看入站记录里的 `status` / `routeDecision` / `dispatchError`：

```bash
curl -s http://127.0.0.1:45917/mesh/v1/tasks | python3 -m json.tool | head -80
```

---

## 1. 自动化门禁（AUTO）

这些用例必须**完全无人值守**通过；任何一条红都不得发版。

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| AUTO-01 | P0 | 静态检查 | `npm run check` | 退出码 0；版本一致性、TDZ、语法、可加载性、`llms.txt` 同步全部通过 |
| AUTO-02 | P0 | 全量自测 | `npm test` | 退出码 0；9 个套件全绿（0.3.36 基线：selftest 52、prompt 10、pairing 8、client 22、caps 66、release 18、reply 5、reasoning 3、resume 5，合计 189 条断言） |
| AUTO-03 | P0 | 发布件完整性 | `node scripts/check-tarball.mjs`（或先 `npm pack`） | 13 项必需条目齐全：`cordis.patch.yml`、`lib/index.js`、`client/client.js`、`LICENSE` 等；无越界路径、无包外软链接 |
| AUTO-04 | P0 | 版本号三处一致 | `node scripts/check-version.mjs` | `package.json` = `lib/index.js` 的 `VERSION` = 运行中 `/mesh/v1/health.version` |
| AUTO-05 | P1 | 文档同步 | `npm run check:docs` | `llms.txt` 与 README/配置一致；无未同步字段 |
| AUTO-06 | P1 | 发版决策 | `npm run release:plan`（不联网、不写文件；加 `--apply` 才会改版本号） | 按提交类型给出正确 bump / skip；不误发、不重复发 |
| AUTO-07 | P0 | 测试不污染真实网络 | 在联网机器执行 `npm test`，同时另一台机器 `mesh_peers` | 测试前后对端列表不出现 `test-*` 假机器；组播组仍为生产组之外 |
| AUTO-08 | P1 | 无模型密钥也能跑 | 清空模型 API key 后运行入站唤醒自测 | 自测不依赖真实模型；失败原因是明确的 `no API key`，不是超时/挂死 |
| AUTO-09 | P1 | 客户端 bundle 可加载 | `npm run selftest:client` + 手动 `curl` 客户端资源 | bundle 的 `__ModuleLoader__.load({ id: "dsh-plugin-mesh" })` 名称精确；渲染树断言通过 |
| AUTO-10 | P1 | 可加载性（部署口径） | `npm run check:deploy` | 不缺运行时依赖；宿主提供的 `@deepseek-ai/*` 不被误判为缺失 |

---

## 2. 安装、升级与生命周期（INST）

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| INST-01 | P0 | 全新安装 | E1：`dsh plugin add dsh-plugin-mesh` → 重启 DSH | 侧栏出现 `Mesh`；日志有 `对端服务监听 0.0.0.0:45917`；`/mesh/v1/health` 返回 200 且 `app=dsh-mesh` |
| INST-02 | P0 | 覆盖升级 | 装旧版 → 确认旧 `version` → 装新版 → 重启 → 再查 `health.version` | `health.version` 变为新版本；`state.json` 里的 `machineName`、`secret`、`instanceIds` 保留；对端只看到一台同名机器 |
| INST-03 | P0 | 区分"磁盘版本"与"进程版本" | 升级后**不重启**查 `health.version`，再重启查一次 | 不重启时仍是旧版本；重启后才是新版本。禁止用 `package.json` 或重启脚本的落盘字段代替该判据 |
| INST-04 | P1 | 回滚 | 卸载新版、装回旧版、重启 | 旧版能读新版留下的 `state.json`/`threads.json`（未知字段忽略）；插件正常加载 |
| INST-05 | P0 | 固定端口被占用 | 先占住 45917，再启动插件 | 日志明确写"端口被占用，退回随机端口"；`health` 在随机端口仍 200；组播发现仍可用；主动扫描扫不到本机（已知限制） |
| INST-06 | P1 | 禁用插件 | 配置 `enabled: false` 后重启 | 日志 `mesh: 已禁用`；不监听端口、不发组播；DSH 其他功能正常 |
| INST-07 | P0 | 插件初始化失败不拖垮宿主 | 人为制造初始化错误（如让 `apply` 抛错） | 宿主仍能启动；日志有 `mesh: 初始化失败，插件已停用`；其他插件/会话不受影响 |
| INST-08 | P1 | 家目录只读 / 状态目录不可写 | 对 `$DSH_HOME/mesh` 设只读后启动 | 插件仍启动（退化为每次重启换 instanceId / 不持久化），日志有原因，不崩溃 |
| INST-09 | P0 | 同机多 profile 并存 | 同机起 desktop + meshtest 两个 profile | 两个实例各自有独立 `instanceIds[profile]`；互不顶替；对端看到两台不同机器 |
| INST-10 | P1 | 卸载清理 | `dsh plugin remove dsh-plugin-mesh` → 重启 | 端口释放；不残留定时器/子进程；`~/.dsh/mesh/` 按预期保留或可手工清理 |
| INST-11 | P0 | 安装后无需手工填 IP | 全新两台机器、同一 /24、默认配置 | 5 秒内（组播通）或 60 秒内（组播被挡）互相出现；不需要任何地址配置 |
| INST-12 | P1 | 插件包不执行安装脚本 | 检查 `package.json` 无 `prepare/build/install` 脚本；安装日志 | 安装过程不编译、不下载二进制（tsnet 仅在启用时运行时下载） |
| INST-13 | P1 | 冷启动竞态 | A 先启动，30 秒后 B 启动 | 启动扫描退避重试生效，B 启动后 45 秒内双向可见 |

---

## 3. 发现（DISC）

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| DISC-01 | P0 | 组播双向发现 | E1+E3 默认配置启动 | 双向各 5 秒内出现；`mesh_peers` 显示在线、`host:port`、OS、user、能力摘要 |
| DISC-02 | P0 | 关闭组播靠扫描发现 | 两端 `useMulticast: false`、`scanOnStart: true` | 60 秒内通过启动扫描/周期扫描发现；`online=true`；日志无组播报错 |
| DISC-03 | P1 | 启动扫描退避重试 | 对端在 0/8/20/45 秒重试窗口内才起来 | 最终能发现；无需手动刷新 |
| DISC-04 | P1 | 手动扫描 | Mesh 页面点刷新/扫描；agent 调 `mesh_scan` | 返回"探测 N 个地址、命中 M 台、总数 a→b"；不产生重复记录 |
| DISC-05 | P0 | ping 保活不依赖组播 | 发现后关闭组播（或屏蔽 UDP），只保留 TCP | 对端保持在线超过 `peerTtlMs`（20 秒）；不会因没有心跳掉线 |
| DISC-06 | P0 | 离线判定 | 直接 kill 对端进程 | 约 20 秒（`peerTtlMs`）内标记离线；UI 显示"离线"而非消失 |
| DISC-07 | P1 | 过期清理 | 对端离线后等待 > 5 分钟（`keepMs`） | 记录从列表移除；不残留"幽灵机器" |
| DISC-08 | P0 | 改名即时传播 | A 在 Mesh 页面改名 → B 观察 | 约 2 秒内 B 看到新名字；A 重启后名字仍在（写入 `state.json`） |
| DISC-09 | P0 | 网络切换自愈 | 笔记本 Wi-Fi → 有线（或换热点） | 心跳中的 `host` 在 ≤5 秒内更新为新地址；对端重新可达，无需重启 |
| DISC-10 | P1 | 多网卡选路 | 机器同时有 en0 / utun / bridge | 广播与名片优先物理网卡；VPN 虚拟网卡不抢主地址 |
| DISC-11 | P1 | 同机两实例 | desktop 用 45917，meshtest 用 45918，**两实例机器名不同**，互配 `scanPorts` | 两个实例可互相发现；不会因为同 IP 互相顶掉 |
| DISC-12 | P1 | 重名告警只算在线 | A 重启换 instanceId（旧记录未过期），B 查看 | 不弹"有重名"；派发仍能选中唯一在线的那台；旧记录过期后消失 |
| DISC-13 | P0 | 指纹认领 | 用配置固定 `machineName`；删除 A 的 `state.json`（instanceId 变化）后重启 | B 用指纹认领，旧记录被顶掉，只显示一台；不出现双份 |
| DISC-14 | P0 | 同指纹、不同名的两实例 | 同机两个 profile，**机器名不同**，均在运行 | 不互相顶掉；各自保留（日志有"两台都在线，不认领"诊断）。⚠ 同名 + 同指纹会被判为重装并认领，见 §14 已知限制 |
| DISC-15 | P1 | 指纹不同绝不认领 | 两台不同物理机，但人为改成一个名字 | 保持两条记录；提示重名；不静默合并 |
| DISC-16 | P0 | instanceId 持久化 | 重启 DSH 多次 | `instanceId` 不变；对端不产生新记录 |
| DISC-17 | P1 | 按地址去重 | A 旧版无指纹，重启后换 id | 同 `host:port` 的旧记录被新记录顶掉，不出现同名双份 |
| DISC-18 | P1 | 组播被路由器隔离 | E5 / 企业 AP 开客户端隔离 | 主动扫描兜底成功；日志不刷错误风暴；UI 有可操作提示 |
| DISC-19 | P1 | 额外网段/端口 | 配置 `scanRanges: ["192.168.1.0/24"]`、`scanPorts: [45918]` | 指定网段/端口被发现；不扫无关网段 |
| DISC-20 | P2 | 无物理网卡 | 仅回环环境（容器） | `preferredAddress()` 回退 `127.0.0.1`；不崩溃；提示无局域网 |
| DISC-21 | P2 | 扫描性能 | 254 地址 /24，`scanConcurrency: 64` | 单轮 1～2 秒完成；不阻塞事件循环；失败地址不拖慢整轮 |
| DISC-22 | P1 | 对端版本变化 | 对端升级并重启 | 名字不变、记录被认领/按地址去重；能力在新心跳后更新；不出现"双机" |

---

## 4. 安全与配对（SEC）

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| SEC-01 | P0 | 默认免配对 | 默认配置（`requirePairing: false`）两端互派 | 任务成功；`/mesh/v1/health` 与 `/hello` 免鉴权 |
| SEC-02 | P0 | UI 开关即时生效 | 在 Mesh 页面打开配对（不重启）→ 用旧 token 发任务 | 立即 403；再关掉 → 立即恢复 200。不得要求重启 |
| SEC-03 | P0 | 配置钉死配对 | 配置 `requirePairing: true` 重启 → 看 UI | 开关禁用并说明"由配置钉死"；`requirePairingPinned=true`；界面无法关闭 |
| SEC-04 | P0 | 错误配对码 | 两端配对码不一致，A 向 B POST `/mesh/v1/task` | `403`，body 含"未配对"；B 的 `/health`、`/hello` 仍 200（可用性探测不受影响） |
| SEC-05 | P0 | 正确配对码 | 两端配对码一致（UI 粘贴） | `POST /task` 200；`/peers`、`/tasks` 也可读 |
| SEC-06 | P0 | 配对码不走漏 | 抓组播包、看 `/health` 返回 | 组播心跳与 health 均**不含** `secret`；只在本机 `/mesh/api/state`（回环）可见 |
| SEC-07 | P0 | 组播不广播 MAC | 抓组播 JSON | 心跳无 `mac` 字段；主动 GET `/health` 才返回 `mac` |
| SEC-08 | P1 | 超大请求体 | POST `/task`，body > 256 KB | 连接被拒绝/返回 400，不缓存、不 OOM；后续请求正常 |
| SEC-09 | P1 | 非法 JSON | POST `/task` 非法 JSON 或空 `task` | `400`；不产生入站记录 |
| SEC-10 | P1 | 未知路径/方法 | GET `/mesh/v1/nope`、GET `/mesh/v1/task` | `404`；进程不崩溃 |
| SEC-11 | P1 | 未配对时的数据面 | 开启配对且 token 错误，依次访问 `/peers`、`/tasks`、`/task` | 全部 403；不能只保护写接口而漏掉读接口 |
| SEC-12 | P1 | 状态文件权限 | 安装后看 `~/.dsh/mesh/state.json`、`threads.json` | 目录 0700、文件 0600；非本用户不可读 |
| SEC-13 | P1 | 伪造来源地址 | tailnet 入站流量检查 `X-Forwarded-For` | 仅回环来源才采信；外部来源不能伪造 `sourceAddress`/`transport` |
| SEC-14 | P1 | 入站任务权限降级 | 对端派来任务，本机新建会话 | 默认 `permissionPreset=workspace-write`，不是 `danger-full-access`；`workspaceRoot` 生效 |
| SEC-15 | P2 | 明文传输边界 | 在不可信网络抓包 | 文档明确 token 走明文 HTTP，只防误连不防嗅探；建议 SSH/TLS 或开配对 |

---

## 5. 派发与回传（DISP）

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| DISP-01 | P0 | 正常派发 | A：`mesh_run(peer=B, task="…", thread="reg-1")` | 立即返回"已派发 + 任务 id + 耗时"；B 入站出现 `accepted`→`dispatched`；B 的 agent 会话执行 |
| DISP-02 | P0 | 接收 ≠ 完成 | 观察 A 的返回文案 | 明确写"这只代表对方已接收"；不谎报完成 |
| DISP-03 | P0 | 目标离线 | kill B 后 `mesh_run` | 返回"当前离线，任务未派发"；不发起 HTTP、不产生派出记录；不排队 |
| DISP-04 | P0 | 目标不存在 | `mesh_run(peer="不存在")` | 返回"找不到机器 + 当前发现列表"；不发请求 |
| DISP-05 | P0 | 重名且都在线 | 两台在线同名 → `mesh_run` | 拒绝并列出候选；不静默挑一台 |
| DISP-06 | P1 | 重名但仅一台在线（UI） | 旧记录离线 + 新记录在线，从 UI 派发 | UI 自动选中唯一在线者并成功。注意：`mesh_run` 参考实现更严格，>1 个名字匹配即拒绝，需 `ip:port` |
| DISP-07 | P1 | `ip:port` 指定 | `mesh_run(peer="192.168.1.6:45917")` | 正确解析到目标；回传按机器名回，不按 ip:port |
| DISP-08 | P1 | 对端 403 | 两端配对码不一致 | 返回 HTTP 403 + "对齐配对码"提示；不重试风暴 |
| DISP-09 | P1 | 超时 | 对端端口被 DROP（丢包） | `requestTimeoutMs`（20 秒）后返回超时；A 不死锁、可继续派发 |
| DISP-10 | P0 | 回传落到发起会话 | A 的 session S 派任务给 B；B 执行后 `mesh_run` 回传 | A 收到回传并注入**原会话 S**；不新建 A 侧会话、不串到别的会话（回归 #25） |
| DISP-11 | P1 | 回传早于派发响应 | 对端立即回传（构造极快响应） | 回传仍路由到 S：回传绑定在发请求**之前**登记；无"找不到会话" |
| DISP-12 | P0 | 同 thread 复用 | 同一 thread 连发两条（间隔 > 冷却） | B 侧两条进入**同一个**会话；`threads.json` 的 `sessionId` 不变 |
| DISP-13 | P0 | `newSession` 强制新会话 | 同 thread 第二条带 `newSession: true` | B 侧绑定到**不同** sessionId；会话键不变；对照组不带则复用 |
| DISP-14 | P1 | `noWake` 只入箱 | 发 `noWake: true` 的正文 | B 入站记录 `noted-only`；不建会话、不唤醒；`mesh_tasks` 可见 |
| DISP-15 | P1 | 无 thread 一次性任务 | 不带 thread 连发两条 | 每条新建会话；不参与限速、不用完绑定；互不串上下文 |
| DISP-16 | P1 | 不同来源同名 thread | A 与 C 同时发 `thread="deploy"` 给 B | B 侧算出的会话键不同（含来源机器名），两个会话互不顶替、限速互不误伤 |
| DISP-17 | P1 | thread 绑定冲突 | 同一 thread 已绑定会话 S1，再从另一会话发起 | 拒绝并提示"thread 已绑定另一会话，请使用新 thread"；不覆盖绑定 |
| DISP-18 | P1 | 建会话期间派发 | 同一 thread 在 B 建会话过程中再派一条 | 返回"正在建立会话，请稍后重试"；不产生第二个会话 |
| DISP-19 | P1 | workspace 字段 | `mesh_run(..., workspace="/tmp/w")` | 字段被原样传输并记录在任务里；**参考实现不会用它改变会话目录**（实际目录由接收方 `workspaceRoot` 决定，空则回退用户主目录）。若产品决定强制执行，需同时改用例并升兼容说明 |
| DISP-20 | P1 | 派发记录 | `mesh_tasks` / UI 任务 tab | 收到与派出分列；显示 id、状态、对方、正文摘要；最多保留 200 条 |
| DISP-21 | P0 | 任务提示词正确 | 检查 B 侧 agent 收到的提示词 | 含任务 id、来源、线程；回派指令里的 `peer` 是**机器名**，不是 `machine/user` |
| DISP-22 | P0 | 回传不产生额外会话 | B 回传后看 A 的会话列表 | 只有原会话 S；没有为"回传"新建会话（零新建） |
| DISP-23 | P1 | 对端重启后回传 | B 重启后继续用原 thread 回传 | A 若原会话已结束 → 尝试 resume；成功则接回原上下文，失败则新建且记录原因（见 WAKE-17/18） |
| DISP-24 | P1 | 幂等 | 用同一 `id` 重复 POST `/task` | 第二次返回 `duplicate: true`；不重复入箱、不重复唤醒 |
| DISP-25 | P2 | 长任务正文 | 接近 256 KB 的正文 | 正常接收；超过上限则拒绝并给出明确错误 |
| DISP-26 | P2 | 特殊字符/中文/换行 | 任务含中文、emoji、Markdown、换行 | 原样送达；JSON 编解码无损；提示词不截断 |

### 5.1 回传链路的手工验证（推荐每次回归都做）

```bash
# 在 A 上让 agent 执行：
#   mesh_run(peer="B", task="把 /tmp/x 的内容读出来，用 mesh_run 回传给 A，thread=reg-1", thread="reg-1")
# 观察 B：
curl -s http://127.0.0.1:45917/mesh/v1/tasks | python3 -m json.tool
# 观察 A 的 threads.json：回传应绑定到 A 发起会话的 sessionId，而不是新建
cat "$HOME/.dsh/mesh/threads.json"
```

通过判据：
- B 的入站任务 `status` 最终为 `dispatched` / `injected-thread-session` / `injected-queued`；
- A 的原会话收到回传文本；
- A 的 `threads.json` 没有为回传新增无关会话；
- 全程无重复回执 ping-pong（见 WAKE-03/04）。

---

## 6. 入站唤醒、限速与会话（WAKE）

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| WAKE-01 | P0 | 正常唤醒 | 对端派来 ≥24 字的实质任务 | 新建会话并开跑；入站 `status=dispatched`；`routeDecision` 写明"新建会话并绑定会话键" |
| WAKE-02 | P0 | `noWake` 豁免 | 发 `noWake: true` | 只入箱；`status=noted-only`；原因"发送方标记 noWake" |
| WAKE-03 | P0 | 过短正文 | 正文 < `minTaskChars`（默认 24） | 不唤醒；`status=noted-only`；原因写字符数 |
| WAKE-04 | P0 | 纯寒暄 | 正文为 `收到` / `好的` / `ping` / `ack` 等 | 不唤醒；`status=noted-only`；不误伤正文含寒暄的长任务 |
| WAKE-05 | P0 | 同 thread 注入已有会话 | 同 thread 第二条到达且会话仍活 | 注入该会话（`injected-thread-session`）；不新建；不触发冷却 |
| WAKE-06 | P0 | `newSession` 跳过复用 | 同 thread 带 `newSession: true` | 跳过注入与 resume，直接新会话；冷却照常生效 |
| WAKE-07 | P1 | 冷却 | 同 thread 连续新建两条（< 5 秒） | 第二条不唤醒（`noted-only`，原因"冷却中"）；等待后可正常 |
| WAKE-08 | P1 | 冷却不误伤注入 | 已有活跃会话时 20 秒内连发两条后续 | 两条都被注入；第二条不得被静默吞掉（历史 bug） |
| WAKE-09 | P1 | 滑动窗口限速 | 同 thread 在 1 小时内唤醒 > 30 次 | 超出后只入箱（`throttled`）；UI 出现"是否提高上限"；窗口滑过后自动释放 |
| WAKE-10 | P1 | 用户提高上限 | UI 点"提高上限" 或 `POST /mesh/api/throttle/raise` | 立即放行最近被挡的一条；其余仍在收件箱；覆盖值落盘、重启仍有效 |
| WAKE-11 | P1 | 忽略提示 | UI 点"忽略" 或 `/throttle/dismiss` | 只清提示，上限不变；被挡任务仍在收件箱 |
| WAKE-12 | P1 | 并发同 thread 只建一个 | 同一 thread 几乎同时发两条 | 只建一个会话；第二条排队，建成后按到达顺序注入（`injected-queued`） |
| WAKE-13 | P1 | 排队顺序 | 建会话期间连发 3 条不同正文 | 注入顺序 = 到达顺序；不丢、不乱序 |
| WAKE-14 | P1 | 背压 | 同一 thread 建会话期间发 > 8 条 | 第 9 条起 `busy`；明确告知积压上限；不无限占内存 |
| WAKE-15 | P1 | 建会话失败 | 人为让 `followup`/create 抛错 | `dispatch-failed` + `dispatchError` 可远端读到；占位锁释放，后续同 thread 不被永久卡住 |
| WAKE-16 | P1 | 唤醒服务缺失 | 缺 `agents`/`agentPresets` 等服务 | `stored-only` + `dispatchError` 列出缺失服务；任务不丢；宿主不崩 |
| WAKE-17 | P0 | 恢复已结束会话 | 重启 DSH 后同 thread 再派任务（原会话已结束） | 先 `resume` 原会话成功 → 注入原会话；`routeDecision` 写"恢复了已结束的会话" |
| WAKE-18 | P0 | resume 失败退回新建 | 让 resume 抛错（会话被删/API 不可用） | 退回新建；消息不丢；日志有失败原因；不重复入箱 |
| WAKE-19 | P1 | `newSession` 不 resume | 原会话已结束，发 `newSession: true` | 直接新建，不尝试恢复 |
| WAKE-20 | P1 | 推理强度保留 | 让 agent preset 解析出 `reasoningEffort=low/high`，再触发新建/恢复 | 新会话保留该值；未设置时不写该字段 |
| WAKE-21 | P1 | 权限预设 | 默认配置 + tailnet 独立配置 | 局域网任务用 `permissionPreset`；tailnet 任务用 `tsnetPermissionPreset`（留空=与局域网一致） |
| WAKE-22 | P1 | 限速跨重启 | 打满窗口 → 重启 DSH → 立即再派 | 窗口不归零；不能靠重启绕过限速（`threads.json` 持久化） |
| WAKE-23 | P1 | 覆盖值不被冲掉 | 提高上限后高频收派任务 | `capOverrides` 仍在；`saveThreads` 不覆盖用户覆盖值 |
| WAKE-24 | P2 | 账本清理 | 长期运行后看 `threads.json` | 只保留窗口内的 `wakesAt`；过期空条目被删除；文件不无限增长 |

---

## 7. 能力名片（CAP）

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| CAP-01 | P0 | 采集运行时 | 本机装 node/python/docker 等，等首轮采集 | `runtimes` 含实际版本；`capabilitySummary` 可读；不阻塞启动 |
| CAP-02 | P0 | 对端看到能力 | B 的 `mesh_peers` 输出 / UI | 显示 B 的 runtimes、CPU 核数、内存、GPU；老对端显示"未知" |
| CAP-03 | P0 | 三种"不知道"分开 | 构造：对端未报 / 报了空 / 过期 | 分别渲染"未知 / 没探到 / 已过期"；不得把"没报"渲染成"什么都没装" |
| CAP-04 | P1 | 空 vs 未知 | 对端 `capabilities: null` 与 `{}` | `null` → 未知（不能据此排除）；`{}` → 确实没探到运行时 |
| CAP-05 | P1 | 净化恶意字段 | 伪造 `/health` 返回超长名字、脚本、非法版本 | `sanitizeCapabilities` 截断/过滤；不进 UI 执行；不崩 |
| CAP-06 | P1 | 过期判定 | 把 `capabilitiesAt` 调到 30 分钟前 | `capabilitiesStale=true`；UI 显示过期；不据此说"没装" |
| CAP-07 | P1 | 探测不确定 | 让一个探测超时/失败 | `probeFailCount>0`、必要时 `runtimesIncomplete=true`；对端能看到"不完整"，不能断言缺失 |
| CAP-08 | P1 | PATH 极简 | 从 GUI 启动（PATH 无 Homebrew/~/go/bin） | `augmentedPath` 补全常见目录；能找到已安装运行时；`capabilityProbePath` 可用于排障 |
| CAP-09 | P1 | GPU 解析 | macOS `system_profiler`、NVIDIA `nvidia-smi`、Windows WMI | 有显卡 → name/vramMb 正确；无显卡 → `gpu=null`；虚拟机无 GPU 不报错、不红门禁 |
| CAP-10 | P1 | 采集频率 | 连续观察 10 分钟 | 每 10 分钟刷新；心跳每 5 秒复用缓存，不反复 spawn 子进程 |
| CAP-11 | P1 | 旧包不覆盖新名片 | 同一设备两条通道先后送来名片 | `capabilitiesAt` 旧的不会覆盖新的 |
| CAP-12 | P1 | 首轮延迟 | 冷启动 | 首轮采集有延迟保护；期间对端看到"未知"而不是"空"；采集完成立即重播心跳 |
| CAP-13 | P2 | 数字型版本号 | 对端 `runtimes: {node: 20}` | 版本必须是字符串才收；非法值被丢弃，不崩 |
| CAP-14 | P2 | 工作区提示限量 | 对端 `workspaceHints` 超过 8 条 / 单条超 40 字符 | 截断后接收；不放大、不执行；UI 不溢出 |

---

## 8. 多通道与跨互联网组网（TS）

> 未启用 tsnet 时，TS-* 全部应为 N/A；**任何 tsnet 失败都不能影响局域网**（P0）。

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| TS-01 | P0 | 未启用不影响局域网 | 默认 `tsnetEnabled: false` | 局域网发现/派发正常；无下载、无子进程、无外网连接；日志"未启用" |
| TS-02 | P0 | 平台不支持优雅降级 | 在没有 sidecar 资产的平台启用 tsnet | `phase=error` + 明确原因；页面不永久转圈；`/mesh/api/state` 仍 `ok:true`；局域网可用 |
| TS-03 | P1 | 下载与校验 | 首次启用 | 按平台下载 sidecar；sha256 校验通过；缓存到 `~/.dsh/mesh/bin/`；失败有明确错误 |
| TS-04 | P1 | 登录 | 填可复用授权码（或 UI 粘贴） | 给出授权链接（如需要）；登录后 `phase=running`、`selfIpv4` 有值；授权码只存本地 state（0600） |
| TS-05 | P1 | tailnet 入站 | 从 tailnet 对端访问 `100.x.y.z:45917/mesh/v1/health` | sidecar 反代到 `127.0.0.1:45917`，返回 200；`X-Forwarded-For` 可识别来源 |
| TS-06 | P1 | tailnet 出站 | 向 tailnet 对端派任务 | 经 `/__tsnet/fetch` 隧道；成功；不尝试宿主机直连 100.x |
| TS-07 | P0 | 双通道故障切换 | 先走局域网，再断开局域网 | 自动切到 tailnet 端点；切回后恢复局域网优先；HTTP 4xx 不触发切换 |
| TS-08 | P1 | 备选地址自报 | 对端名片带 `tailnetIp` | 本机记一条**未验证**候选端点；未验证通道会被尽快探一次，之后按 `tsnetProbeIntervalMs`（默认 60s）低频保活；断网后可直接切换 |
| TS-09 | P1 | 整机单节点复用 | 同机第二个 profile 启用 tsnet | 通过 `rendezvous.json` 复用同一 sidecar；不重复占设备名额 |
| TS-10 | P1 | 协议版本不一致 | 改 `SIDECAR_PROTOCOL` 后启动 | 检测到旧 sidecar → 重启它；不混用两套控制 API |
| TS-11 | P1 | 改名 | 改机器名后重启 | sidecar 节点名与机器名不一致时重启节点；MagicDNS 名称更新 |
| TS-12 | P1 | owner 退出清理 | owner 进程退出 | 自己启动的 sidecar 被清理；非 owner 退出不牵连共享节点；无孤儿进程 |
| TS-13 | P1 | 下载源全部不通 | 模拟 GitHub/镜像不可达 | 明确报错；提示用 `tsnetDownloadSources` 指向局域网镜像；局域网功能不受影响 |
| TS-14 | P1 | Android 资产 | Android arm64 启用 tsnet | 下载 `android/arm64` 专用 PIE 资产；不是把 linux 资产改名；可执行 |
| TS-15 | P1 | 授权码不回传 | 看 `/mesh/api/state` | 只返回 `authKeySaved: true`，绝不返回授权码明文 |
| TS-16 | P2 | tailnet 权限收紧 | 配置 `tsnetPermissionPreset: workspace-write` | tailnet 入站任务用该权限；局域网仍用 `permissionPreset` |

---

## 9. UI（UI）

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| UI-01 | P0 | 侧栏入口 | 安装重启后看侧栏 | 出现 `Mesh` 面板；点击可打开 |
| UI-02 | P0 | 机器列表 | 两台在线 | 显示名字、在线点、`host:port`、OS、user、能力摘要；离线灰显；重名警告 |
| UI-03 | P0 | 任务记录 | 切到"看任务记录" | 收到/派出分列；显示状态、来源/目标、摘要；空态有文案 |
| UI-04 | P0 | 首次起名 | 首次启动未命名 | 弹起名卡片，输入框预填主机名；保存后立即广播；空/含 `/` 或 `\`/控制字符/超 32 字符被拒 |
| UI-05 | P1 | 改名传播与冲突 | 改名 → 观察对端；配置 `machineName` 时改名 | 对端 ≤2 秒看到；配置优先时返回 409，不静默覆盖 |
| UI-06 | P1 | 配对开关 | 打开/关闭配对 | 即时生效；文案区分"未启用/已启用/由配置钉死"；可复制本机配对码 |
| UI-07 | P1 | 派发表单 | 选目标 → 填任务 → 派发 | 成功提示含任务 id；离线目标禁用；失败展示原因 |
| UI-08 | P1 | 限速提示 | 触发 `maxWakesPerThread` | 显示被挡 thread、条数、上限、窗口；提供"提高上限/忽略" |
| UI-09 | P1 | tailnet 卡片 | 未启用 / 下载中 / 需登录 / 运行 / 错误 / 已退出等状态 | 各状态都有明确文案；错误可展开诊断；平台不支持不转圈 |
| UI-10 | P1 | 能力渲染 | 对端有/无/过期/不完整 | 运行时徽章、GPU、规格；三种"不知道"分开；悬停给完整信息 |
| UI-11 | P1 | 空状态 | 没有对端、没有任务 | 给出排查步骤（同网段、对端是否安装、防火墙端口），不是空白页 |
| UI-12 | P1 | 轮询与停止 | 打开页面 3 分钟，再关闭 | 每 3 秒刷新；关闭后停止轮询；无控制台报错/内存增长 |
| UI-13 | P1 | 宿主未加载 | 停掉主机侧插件后打开页面 | 显示"无法读取状态，请确认主机侧插件已加载"；不白屏 |
| UI-14 | P2 | 窄窗口/长名字 | 侧栏变窄、机器名 32 字符、任务正文很长 | 不溢出；关键操作仍可点；长文本截断/换行合理 |
| UI-15 | P2 | 无障碍/键盘 | Tab 导航、按钮可见性 | 焦点顺序合理；按钮有可读文本；颜色不是唯一状态标识 |

---

## 10. 版本与跨实现兼容（COMPAT）

> 现场可能 Mac / Windows / Android 三台不同版本同时在线。**升级一台不能让全网断开**。

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| COMPAT-01 | P0 | 新 ↔ 新 | 0.3.36 ↔ 0.3.36 | 全部功能正常 |
| COMPAT-02 | P0 | 新 ↔ 0.3.11（卡片 v1，无能力） | 新版对旧版 | 发现、派发、回传正常；能力显示"未知"；不报错、不把未知当"没装" |
| COMPAT-03 | P0 | 新 ↔ 0.3.18 / 0.3.24（卡片 v2，无能力） | 新版对旧版 | 同上；`capabilities=null`，UI 三种"不知道"正确 |
| COMPAT-04 | P1 | 新 ↔ 0.3.25+（v2 + 能力） | 新版对旧版 | 能力名片双向可见；旧版忽略新字段 |
| COMPAT-05 | P0 | 卡片 v1 发送 → v2 接收 | 旧版心跳 | 接收端降级为单端点；`fingerprint`/`tailnetIp` 为空；其余功能正常 |
| COMPAT-06 | P1 | 卡片 v2 发送 → v1 接收 | 新版心跳 | 旧版忽略 `fingerprint`/`tailnetIp`/`capabilities`；不断连 |
| COMPAT-07 | P0 | 滚动升级 | A 升级重启，B 保持旧版 | 升级期间短暂不可见；重启后恢复；旧记录被认领/去重；不出现"两台同名" |
| COMPAT-08 | P1 | HTTP API 路径稳定 | 用 curl 直接打 `/mesh/v1/*` | 路径不随插件 minor 变化；新增字段只增不改；未知请求 404 |
| COMPAT-09 | P1 | 未知字段容忍 | 手工 POST 带未知字段的 task | 正常受理；未知字段忽略；不 400 |
| COMPAT-10 | P1 | `llms.txt`/README 与代码一致 | 按文档逐条核对工具名/配置键 | 文档里的命令、参数、默认值都存在；无幻觉字段（发版门禁项） |
| COMPAT-11 | P0 | 跨 IDE 实现互通 | 用 [`PLUGIN-SPEC.md`](./PLUGIN-SPEC.md) 实现的第三方 IDE 插件 | 能与参考实现互相发现、派发、回传；卡片/任务字段一致；见 SPEC 第 6 章验收 |
| COMPAT-12 | P2 | 未来卡片 v3 | 发送 `v:3` 名片给 0.3.36 | 当前实现不硬拒；未知字段忽略，按 v2 语义处理（v3 草案见 SPEC §5.2） |

---

## 11. 平台、性能与稳定性（PLAT）

| ID | 优先级 | 场景 | 步骤 | 预期 |
|---|---|---|---|---|
| PLAT-01 | P0 | macOS Intel / Apple Silicon | E1 两种架构 | 安装、发现、派发、UI、tsnet 全部正常 |
| PLAT-02 | P1 | Windows | E3 Windows | 插件加载；防火墙放行 TCP 45917 / UDP 45892 后可发现；路径/编码正常 |
| PLAT-03 | P1 | Linux | E3 Linux | 同上；systemd/容器内无组播时扫描兜底 |
| PLAT-04 | P1 | Android / Termux | E4 | 局域网功能可用；省电策略杀后台后能重连；tsnet Android 资产可执行 |
| PLAT-05 | P1 | 24 小时浸泡 | 两台机器持续在线，每小时派发一次 | 无内存泄漏、无句柄泄漏、无僵尸子进程；对端列表稳定；日志不无限增长 |
| PLAT-06 | P1 | 频繁启停 | 30 次重启宿主 | 每次都能加载；端口能释放；sidecar 不残留；`rendezvous.json` 不腐化 |
| PLAT-07 | P1 | 端口与网络异常 | 45917 被占、UDP 被防火墙拦、网络断开 30 秒 | 各自有明确降级；不崩溃；恢复后自动重连 |
| PLAT-08 | P2 | 时钟偏移 | 两台机器时间差 5 分钟 | 在线判定基于本地收到时间，不被对端 `ts` 误导；能力过期判定不被未来时间卡死 |
| PLAT-09 | P1 | 大量历史 | 派发/接收 > 200 条 | 内存中只留最近 200 条；UI/接口不卡；旧记录被裁剪 |
| PLAT-10 | P2 | 高并发派发 | 10 个线程同时派发 | 各自建会话；不互相阻塞；端口/文件句柄无明显增长 |
| PLAT-11 | P1 | 进程被 kill -9 | 杀宿主/杀 sidecar | 重启后自动恢复；不留下无法清理的 sidecar；状态文件不损坏 |
| PLAT-12 | P2 | 组播风暴 | 同网段大量心跳 | 注册表不重复增长；CPU 可接受；`peers()` 稳定 |

---

## 12. 历史缺陷回归清单（BUG）

每一条都对应真实踩过的坑。修复后必须长期保留断言或用例。

| ID | 历史问题 | 回归用例 | 判据 |
|---|---|---|---|
| BUG-01 | `mesh_scan` 漏传 `log` 参数，调用必报 `log is not a function` | DISC-04 | 调用不抛错，返回扫描统计 |
| BUG-02 | 回传没有登记绑定，结果落到新会话 / 丢失（#25） | DISP-10/11/22 | 回传注入原会话；零新建 |
| BUG-03 | DSH 重启后原会话结束，跨机线程静默断开 | WAKE-17/18 | resume 成功则接回；失败则新建且有原因 |
| BUG-04 | 提示词把 `machine/user` 当 `peer`，对端回派必被拒 | DISP-21 | 提示词中 peer 为机器名 |
| BUG-05 | 能力探测超时被渲染成"什么都没装" | CAP-03/07 | 三种"不知道"分开 |
| BUG-06 | PATH 补全把同一目录插两遍 / 从 GUI 启动找不到 brew | CAP-08 | 无重复目录；能找到已安装运行时 |
| BUG-07 | 无 GPU 的 CI 机器上 GPU 断言变红 | CAP-09 | 无显卡不报错 |
| BUG-08 | 对端重启后同名旧记录导致"重名"弹窗、派发失败 | DISC-12/16/17 | 只算在线；唯一在线可选中 |
| BUG-09 | 最后心跳 `Invalid Date`（`lastSeen` 缺失） | DISC-01/UI-02 | 时间正常显示 |
| BUG-10 | 变量在声明前使用（TDZ），任务永远停在 `accepted` | WAKE-01 | `dispatch` 正常；`routeDecision` 有值 |
| BUG-11 | 配对开关只在配置里，页面无入口；改了要重启 | SEC-02 | 即时生效 |
| BUG-12 | 注入已有会话被冷却误伤，第二条静默吞掉 | WAKE-08 | 注入不受冷却；两条都到 |
| BUG-13 | Android sidecar 用 linux 资产，exec 报 `unexpected e_type: 2` | TS-14 | 使用 android 专用资产 |
| BUG-14 | 平台不支持时页面永远"正在组网" | TS-02 | `phase=error`，有原因 |
| BUG-15 | 局域网/ tailnet 抢同一端点，局域网通却显示离线 | TS-07 | 端点独立、按健康切换 |
| BUG-16 | 发布 CI 里未定义变量/全角逗号导致静默失败 | AUTO-06 | `release:plan` 与脚本在 CI 中真实执行 |
| BUG-17 | tarball 缺文件但仍发布 | AUTO-03 | 13 项条目齐全才允许发布 |
| BUG-18 | 重启脚本三行日志都不能证明新代码在跑 | INST-03 | 以 `/mesh/v1/health.version` 为准 |

---

## 13. 发布前检查清单（人工勾）

```text
[ ] AUTO-01 ~ AUTO-07 全绿，日志已归档
[ ] 两台真实机器（或两个隔离实例）完成 S 档
[ ] /mesh/v1/health 的 version 与 package.json 一致
[ ] npm pack 产物含 cordis.patch.yml / lib/index.js / client/client.js / LICENSE
[ ] 与上一个发布版本互测：发现、派发、回传、能力"未知"不报错
[ ] 配置默认值未意外改变；cordis.patch.yml 未把用户配置冲掉
[ ] 新增字段只增不改；老对端忽略后仍可用
[ ] 文档中的每个命令、参数、配置键都真实存在
[ ] 失败路径有可读原因（status/routeDecision/dispatchError），不是静默失败
[ ] 没有把测试机器留在真实局域网（mesh_peers 复查）
```

### 13.1 测试记录模板

```markdown
## 回归记录 YYYY-MM-DD
- 版本：0.3.xx（health.version = ？）
- 环境：E1 macOS 14.x / E3 Windows 11 / Node 20.x
- 执行档位：S / R / F
- 结果：PASS x / FAIL y / BLOCKED z
- FAIL 列表：
  - TC-XXX：现象、日志、health、state/threads 关键字段、初步归因
- 新增风险 / 未覆盖项：
```

---

## 14. 明确不覆盖的范围

- **模型输出质量**：本插件只负责把任务送到对端 agent；对端 agent 回答得好不好不在回归范围。
- **Tailscale 服务端行为**：登录、DERP、ACL 由 Tailscale 负责；这里只验"失败时局域网不受影响"。
- **DSH 宿主自身升级**：只验插件在新宿主上的加载与接口兼容。
- **跨 IDE 实现的内部 UI**：只验协议互通与功能等价，见 SPEC 第 6 章。
- **恶意内网攻击**：默认信任同网段（可用配对码收紧）；不做渗透测试承诺。

### 14.1 已知限制（不算缺陷，但回归时要确认行为没变）

- 同机多实例如果**机器名相同**且指纹相同，会互相认领/顶掉；必须给它们不同机器名（见 SPEC §3.5.3）。
- 任务去重只在进程生命周期内有效；重启后同一 `id` 会再次入箱。
- 没有离线排队：对端离线时 `mesh_run` 直接失败，不暂存重投。
- 固定端口被占用回退随机端口后，主动扫描扫不到该实例（组播仍可发现）。
- 明文 HTTP：配对码只防误连，不防同网段嗅探。
