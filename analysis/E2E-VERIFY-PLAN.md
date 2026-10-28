# mesh → dsh-go 适配验证计划（E2E）

> 目标：证明「移植后的 dsh-plugin-mesh 在 dsh-go 上完全可用」，并与桌面 DSH 双向联通。
> 设备：Xiaomi 15 Ultra（Android 15, arm64, dsh-go 0.9.7）+ 本机 Windows DSH（mesh 0.5.4）。
> 关键通道：`adb forward tcp:45917`（手机 mesh 入站）、`adb reverse tcp:8792`（PC 分发插件包）、`adb forward tcp:3080`（手机 DSH Web，需要 token）。

## 证据目录
- 手机端 JSON：`E:\mesh\evidence\phone-health.json`、`phone-peers.json`、`phone-tasks.json`
- 桌面端 JSON：`E:\mesh\evidence\desktop-health.json`、`desktop-peers.json`
- 截图：`E:\mesh\evidence\*.png`（手机 App、PC 浏览器 Mesh 面板、scrcpy 镜像）
- 命令输出：`E:\mesh\evidence\*.txt`

## 阶段 A：环境事实（一次性）
执行 `E:\mesh\scripts\phone-probe-task.md` 里那段任务（经 mesh_run 派给手机 agent），把输出存 `evidence\phone-probe.txt`。
判定：
- [ ] A1 `process.platform === "linux"`，`os.release()` 含 `android`
- [ ] A2 `os.cpus().length` 是否 0（对应 health cpuCores:0 根因）
- [ ] A3 `/proc/sys/kernel/hostname` = localhost（machine 名 localhost 根因）
- [ ] A4 `/etc/machine-id` 0 字节（fingerprint 空根因）
- [ ] A5 `os.networkInterfaces()` 是否 THROW EPERM（G1 判定）
- [ ] A6 UDP-connect 取到的本机 IP == 192.168.1.19
- [ ] A7 `/proc/net/route` 可读性（tsnet linux 资产 controlC 判定）
- [ ] A8 20s 组播收包数（MCAST_TOTAL>0 = 能收；=0 = G3 成立）
- [ ] A9 `/dev/__properties__` 存在（androidbin onAndroid 判据）

## 阶段 B：安装补丁版插件（P0）
1. `pack-plugin.ps1` → `dist/*.tgz`；`serve-dist.ps1`（8792）；`adb reverse tcp:8792 tcp:8792`
2. 经 mesh_run 派发安装任务（见 deploy-via-mesh.md）
3. 手机 App「本机引擎 → 重启」；等 3080/45917 恢复
判定：
- [ ] B1 手机上 `node -e require('<plugin>/package.json').version` 输出预期版本
- [ ] B2 `/mesh/v1/health` 返回 200 且新增 netinfo 诊断字段（实现定稿后核对）
- [ ] B3 手机日志无插件加载错误（App 引擎日志 / mesh health 可用性）

## 阶段 C：发现与可达性
- [ ] C1 桌面 `mesh_peers` 看到手机（当前已成立；P1 后应显示 Android 身份/名字而非 localhost）
- [ ] C2 手机 `/mesh/v1/peers` 看到桌面 Rosmontis喵（当前已成立）
- [ ] C3 组播：桌面→手机、手机→桌面分别是否依赖组播（用 A8 + 关组播对照实验）
- [ ] C4 `staticPeers` 兜底：手机配置 staticPeers=["192.168.1.6:45917"]，禁用组播后仍能发现桌面
- [ ] C5 桌面 `mesh_scan` 能找到手机（扫描兜底）
- [ ] C6 手机 `scan` 能找到桌面（proot 内主动扫描）

## 阶段 D：任务派发 E2E
- [ ] D1 桌面 `mesh_run(phone, "在手机上执行 uname -a 并回报")` → 手机 `/mesh/v1/tasks` 出现 dispatched → 手机 agent 执行 → 桌面收到回派（`mesh_tasks` 有入站）
- [ ] D2 手机 agent 用 `mesh_run(desktop, ...)` → 桌面 `/mesh/v1/tasks` 有入站
- [ ] D3 回执路由：conversation key 在同一 thread 下复用会话（手机侧 session 复用可观察）
- [ ] D4 限速/短消息闸门不误伤（minTaskChars=24 等）

## 阶段 E：UI 可见性（"电脑上看效果"）
- [ ] E1 手机 dsh-go Web 模式：侧栏 Mesh 面板可见（截图；`sidebar.panellist`）
- [ ] E2 PC 浏览器：`adb forward tcp:3080` + token URL → 同一引擎的 Mesh 面板可见且可操作（截图）
- [ ] E3（可选 P2）原生桥面板：dsh-go 原生界面显示 peer 列表（bridge `dshGo.panel`）

## 阶段 F：桌面回归
- [ ] F1 `npm run check` 全绿（docs/llms.txt 用 sync-llms 补齐后）
- [ ] F2 `npm run selftest`、`selftest:caps`、`selftest:osinfo`、`selftest:client` 全绿
- [ ] F3 桌面 DSH 现有 mesh 功能不回归（mesh_peers/mesh_run 与另一台桌面/手机互通）
- [ ] F4 协议兼容：桌面 0.5.4 ↔ 手机补丁版（字段增量、老字段不变）

## 阶段 G：交付
- [ ] G1 `E:\mesh\README-MIGRATION.md`（改动说明 + 部署手册 + 验证结论）
- [ ] G2 `E:\mesh\dist\dsh-plugin-mesh-<ver>.tgz`（可交付 tarball）
- [ ] G3 git 提交（baseline + P0 + P1 + 文档）
