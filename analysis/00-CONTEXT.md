# 任务背景（Lead 维护，teammates 只读）

## 目标
把 `dsh-plugin-mesh`（DSH 的局域网 mesh 插件）**完全适配 dsh-go**（Android 手机端 DSH App），
并在「桌面 DSH ↔ 手机 dsh-go」之间完成 mesh 发现 + 任务派发的端到端验证。

工作区：`E:\mesh`
- `E:\mesh\dsh-plugin-mesh\` —— 插件源码基线（v0.5.4，从桌面 profile 拷贝，未改动）
- `E:\mesh\analysis\` —— 分析文档输出目录
- `E:\mesh\.tmp\` —— 临时产物（APK、rootfs 解压、截图、日志），可随意写

## dsh-go App 关键事实（已实测）
- APK：`E:\mesh\.tmp\dsh-go-0.9.7-arm64.apk`（原始文件在 `D:\vx聊天记录\...\dsh-go-0.9.7-arm64.apk.1`）
- 包名 `io.github.ccch1mneyyy.dsh_app`，版本 0.9.7，label「DSH」，minSdk 26 / targetSdk 28，**仅 arm64-v8a**
- 技术栈：Flutter 壳 + **proot 跑 Ubuntu 24.04.5 arm64 rootfs**，Node 24.22.1，pnpm 11.28.5，DSH 0.2.1-rc.2
- 运行时清单（APK 内 `assets/runtime/manifest.json`）已解出：
  - rootfs：`assets/runtime/rootfs-arm64-v8a.tar.xz`（158MB，解压 ~810MB），已解压到
    `E:\mesh\.tmp\rootfs-arm64-v8a.tar.xz`（原始）与 `E:\mesh\.tmp\dshgo-rootfs\`（解压后，host 上可读）
  - 设备内路径：`/data/data/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs`
  - 启动：`libproot.so --kill-on-exit --link2symlink --sysvipc -L -0 --rootfs={ROOTFS} --cwd=/root -b /dev -b /proc -b /sys -b /system -b /apex …`
    然后 `/usr/bin/env -i HOME=/root USER=root PATH=… DSH_HOME=/root/.dsh TMPDIR=/tmp … /bin/sh -c 'echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web --patch /etc/dsh-app/dsh-web.patch.yml --patch /opt/dsh-app/auth/auth.patch.yml --patch /opt/dsh-app/search.patch.yml --host 127.0.0.1 --port 3080 --no-open'`
  - 引擎日志（App 内 设置→本机引擎→日志 同源）：设备上 `files/runtime/logs/dsh.log`
  - dsh-go-bridge v0.4.0：rootfs 内 `/opt/dsh-go/dsh-go-bridge/`（DSH 插件，注册原生能力；`lib/index.js`、`lib/native/*.js`）
  - direct engine（免 proot 直跑 Node）也在 rootfs：`/opt/dsh-go/direct/*.mjs`（`defaultEnabled:false`，App 侧是 `DirectEngineSettings`）
  - App 的 web patch：`/etc/dsh-app/dsh-web.patch.yml`（plugin-manager 的 fallbackRegistries=npmmirror+npmjs；insert dsh-go-bridge）
- **MuMu(x86 模拟器，Houdini ARM 转译) 跑不了 proot**：App 界面能起、rootfs 23s 解压完成、resolv.conf 已写，
  但 `launching libproot.so …` 之后无任何输出、永远停在「正在启动引擎」。手动执行同一 proot 命令会挂死（ptrace 与转译冲突）。
  → 结论：验证必须用**真 arm64 环境**（真机 Xiaomi 15 Ultra，或本机 arm64 AVD `dshgo_arm64`，已创建未启动）。
- 真机：Xiaomi 15 Ultra（VID_2717&PID_FF40），用户已插线，等待开启 USB 调试后由 Lead 接管。
  设备上用 `adb` 可做：装 APK、`adb forward tcp:3080 tcp:3080` 读引擎（DSH Web 需 token，见 launch stdout 的
  `dsh web: http://127.0.0.1:3080/?token=…`），但**App 私有目录在非 root 真机上不可写**。

## 插件基线关键事实
- 已装桌面版：`E:\DSH-Home\profiles\desktop\node_modules\dsh-plugin-mesh\`（v0.5.4，npm 最新也是 0.5.4）
- 结构：`lib/index.js`(host, 159KB) / `lib/discovery.js` / `lib/capabilities.js` / `lib/osinfo.js` / `lib/identity.js` /
  `lib/tsnet/*`（sidecar 下载+管理）/ `client/client.js`（手写 bundle, 499KB）/ `sidecar/*.go` / `scripts/*`
- 已知 Android 适配（Termux 场景，`process.platform === "android"`）：`lib/capabilities.js`、`lib/identity.js`、
  `lib/osinfo.js`、`lib/tsnet/download.js`、`sidecar/androidbin_linux.go`、`sidecar/androidnet_linux.go`、
  `scripts/build-sidecar.sh`（android 资产 = PIE + `/system/bin/linker64`）。
- **dsh-go 与 Termux 的关键差异**：dsh-go 里 Node 跑在 proot Ubuntu 下，`process.platform === "linux"`（不是 `android`），
  但底层内核是 Android（app UID：netlink `/proc/net` 受限、组播收包可能被系统丢、后台会被省电杀）。
  现有 Android 分支全部不会被触发 → 这是"完全适配"的核心。
- 插件已有的联调脚本：`scripts/e2e-android.mjs`（adb+forward 冒烟）、`lib/_selftest-*.mjs`（全离线回归）。
- 桌面 DSH 运行中（本会话所在）：`DSH_HOME=E:\DSH-Home`、profile `desktop`、DSH 版本见 E:\DSH-App。

## 已知待办
1. 真机接上后：装 dsh-go → 设 DeepSeek API Key（桌面 `E:\DSH-Home\.credentials.yaml` 的 refs 里有）→ 启引擎 → 验证 Web 可访问。
2. 把 mesh 装进 dsh-go（非 root 真机：走 dsh-go 内 agent 的 bash + 局域网 HTTP 分发 tarball；或 DSH 插件市场装 0.5.4 再覆盖）。
3. 采集 dsh-go 内 proot 环境事实：`process.platform`、`os.networkInterfaces()`、`/proc/net`、组播收发、sidecar 可执行性、DNS、CA。
4. 按 GAP-ANALYSIS 实现适配（新增 dsh-go 环境识别 + 网卡/发现兜底 + tsnet 资产选择 + 安装/升级路径）。
5. E2E：桌面 ↔ 手机互发现、mesh_run 派发与回执；出验证证据（截图/日志/JSON）。
