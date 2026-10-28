# mesh → dsh-go 迁移报告（进行中，2026-10-29 01:45）

> 目标：把 `dsh-plugin-mesh` 完全适配 **dsh-go**（Android 15 手机 App，proot Ubuntu 24.04 里跑 DSH 0.2.1-rc.2 + Node 24.22.1），做到「桌面派任务到手机自动执行、不需要人当中间人」。
> 工作区：`E:\mesh`；设备：Xiaomi 15 Ultra（`1441e87a`，Android 15 / arm64，dsh-go 0.9.7，profile=`web`）。

## 1. 结论先说（已达成）

| 能力 | 状态 | 证据 |
|---|---|---|
| dsh-go 里跑通 mesh 节点 | ✅ | `/mesh/v1/health` 200：`version 0.5.4`、`host 192.168.1.19` |
| dsh-go 环境识别（Android 宿主 + proot runtime） | ✅ | health：`os: "android 15 (6.6.30-android15…)"`；`diag.dshGo.isDshGo=true`（7 项证据）；`diag.sidecarTarget.asset=dsh-mesh-tsnet-android-arm64.gz` |
| **入站任务自动执行（消灭中间人）** | ✅ | health：`diag.inboundPermissionPreset=danger-full-access`、`source=dsh-go`；实测派发升级任务后**手机无人工确认**直接执行（01:37:47 手机从 `127.0.0.1:8792` 拉取 tarball 200） |
| 网卡/地址采集兜底 | ✅ | health：`diag.net.source=os`、`macsAvailable=false` + `MAC_UNAVAILABLE`（SELinux 拒 SIOCGIFHWADDR 的显式表达，不再伪装成"没有网卡"） |
| 桌面 ↔ 手机发现 | ✅ | 桌面 `/mesh/v1/peers` 看到 `localhost 192.168.1.19:45917 online=true`；手机 peers 看到桌面 |
| **上游 bug 修复（真机事故）** | ✅ | 0.5.4 的 package.json 缺 `@deepseek-ai/dsh-brand` peer，而 `lib/index.js` import 它 → dsh-go 加载器不拦截 → `ERR_MODULE_NOT_FOUND` → **整个插件 import 失败**。已补 peer + `scripts/check-peerdeps.mjs` 门禁（防回归） |
| USB/adb 传输适配（桌面经 adb forward 直连手机 mesh） | ✅ 模块级（真机冒烟通过） | `lib/usb.js` 24 离线用例全绿；真机冒烟：识别 `1441e87a` → 复用 forward → `GET /mesh/v1/health` → endpoint `usb:1441e87a`；`stop()` 保留复用映射。接线已进 `lib/index.js`/`diagnostics`（`diag.usb`），桌面侧需装新插件后生效 |

## 2. 代码（git，`E:\mesh`）

| commit | 内容 |
|---|---|
| `da528da` | baseline：dsh-plugin-mesh 0.5.4 + 分析/部署脚本 |
| `6855343` | **P0**：`lib/netinfo.js`（四级地址兜底、永不抛、source/errors 可观察）、scan 兜底、`staticPeers` / `advertiseAddress` / `sidecarPlatform` 配置 |
| `383b7c8` | **P1**：`lib/dshgo.js` 环境探测；osinfo=Android 宿主+proot runtime；identity/cpuCores 兜底；tsnet 资产选择（linux+dshGo→android/arm64）；`permissionPresetOnDshGo` + `lib/inbound-preset.js` |
| `9aa8359` | **P1.5**：`lib/usb.js`（USB/adb 传输，24 自测）+ 设计文档 |
| `8ff25a2` | **P1.5 接线**：`index.js` schema/apply/health diag + diagnostics（`selftest:usb-integration` 17/17） |
| `9e6816b` | dsh-go 上**默认** `danger-full-access`（无需改配置；桌面零变化）+ 版本 `0.5.4-dshgo.1` |
| `e2e4cd4` | **修复 peer 缺失**（dsh-brand）+ `check-peerdeps` 门禁 + 版本 `0.5.4-dshgo.2` |

测试：`npm test` 全绿（netinfo 28 / dshgo 22 / inbound-preset 13 / usb 24 / usb-integration 17 / tsnet 74 / caps 78 / osinfo 26 / …），`npm run check` 含新 peer 门禁全绿。

产物：`E:\mesh\dist\dsh-plugin-mesh-0.5.4-dshgo.2.tgz`（566,959 B）。

## 3. 部署/回滚

- 一键部署（手机 guest 内 bash）：`E:\mesh\scripts\deploy-task-v2.txt`（含备份、loadable 自检、curl 兜底）
- 通道：`adb reverse tcp:8792 tcp:8792` + PC `E:\mesh\dist` 静态服务（`scripts/serve-dist.ps1`）
- 重启引擎：`adb shell am force-stop io.github.ccch1mneyyy.dsh_app && am start -n …/.LauncherMist`（无需点击，已验证）
- 回滚：换回 `${PLUGIN}.bak-*` / `${PLUGIN}.bak2-*`，profile patch 换回 `.bak-*`，重启引擎
- 配置：**无需任何配置**（0.5.4-dshgo.2 在 dsh-go 上自动 `danger-full-access`，桌面行为不变）

## 4. 关键事实（真机）

- dsh-go：`process.platform==="linux"`、`os.release()` 含 `android15`、`hostname=localhost`、`/etc/machine-id` 空、`/system/build.prop` 存在、`getprop` 不在 PATH（用 `/system/bin/getprop`）
- `os.networkInterfaces()` **正常**（wlan0 等 7 个网卡，MAC 全 0 因 SELinux 拒 `SIOCGIFHWADDR`）；`os.cpus().length=0` 但 `availableParallelism=8`（已在 P1 修）
- DSH 插件加载器：只拦截插件 package.json 里**声明过的 peer**；漏声明 → 原生解析 → 缺包 → 整个插件 import 失败（本次事故根因）
- 入站会话权限：mesh 原来恒定 `workspace-write`；dsh-go 的 proot 无沙箱后端 → `sandbox+approval:ask` → 每个任务卡「待确认」；`danger-full-access` 才拿到 `approval:"never"`

## 5. 待收尾（阻塞在设备连通性）

- [ ] 手机重连（USB 稳定 + 与 PC 同网段）→ 重启引擎 → 确认 `version=0.5.4-dshgo.2`、diag 保持、任务自动执行不被确认打断
- [ ] 双向 `mesh_run` 各一次（桌面→手机、手机→桌面）留证据
- [ ] 关 Wi-Fi 后 USB 通道派发（最强验收，需要桌面侧装新插件）
- [ ] ui.json island 零代码嵌入（需要 guest 写入 `/root/.dsh/dsh-go/ui.json`）
- [ ] 桌面侧安装适配版插件（可选：需重启桌面 DSH，会断开当前会话）
