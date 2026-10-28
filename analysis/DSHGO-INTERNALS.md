# dsh-go Android App 内部机制分析

> 任务：为「把 dsh-plugin-mesh 移植到 dsh-go」提供依据。只读分析，未修改 `E:\mesh\dsh-plugin-mesh`。
> 标注约定：**【实测】**= 本机直接读到的产物/日志/源码；**【推断】**= 由代码或产物反推，未在真机运行验证；**【待实测】**= 需要真机/设备侧动作才能确定。
> 证据引用：`rootfs:/…` 指 WSL 内 `~/dshgo-rootfs`（= APK 内 rootfs 解压结果，`E:\mesh\.tmp\dshgo-rootfs` 是同一份的 Windows 侧解压中副本）；`APK:…` 指 `E:\mesh\.tmp\dsh-go-0.9.7-arm64.apk` 内条目；`E:\mesh\.tmp\…` 是本机产物。

---

## 0. 证据来源与复现方法

### 0.1 素材

| 素材 | 路径 | 说明 |
|---|---|---|
| APK | `E:\mesh\.tmp\dsh-go-0.9.7-arm64.apk` | 0.9.7，包名 `io.github.ccch1mneyyy.dsh_app` |
| 运行时清单 | `APK:assets/runtime/manifest.json` | 已解出到 `E:\mesh\.tmp\apk-x\assets\runtime\manifest.json`（218 行，可直接按行引用） |
| rootfs（解压后） | WSL `~/dshgo-rootfs`（Windows: `E:\mesh\.tmp\dshgo-rootfs`，解压中） | 已核对 opt/ /etc/ /usr/ /root/ 全量 |
| Flutter 资产 | `E:\mesh\.tmp\apk-x\assets\flutter_assets\assets\…` | `skills/dsh-go-guide/*`（官方使用指南）、`skills/dsh-go-plugin/*`（插件作者指南 + 校验器 kit）、`web/*`（Web 模式注入脚本）、`engine/auth/*` |
| App Java 层字符串 | `E:\mesh\.tmp\classes.dex` → 我用 DEX 字符串表精确提取 | 见 0.2 |
| 引擎实跑日志 | `E:\mesh\.tmp\dshgo-logs\dsh.log` | MuMu（x86+Houdini）上真实启动日志，含完整 proot argv |

### 0.2 方法：我在本机补的两个提取器（都放在 .tmp，可复用）

- `E:\mesh\.tmp\dexstrings.py` + `dexscan.py` / `dexhits2.py` / `dexdirect.py` / `dexpaths.py` / `dexq2.py`
  直接解析 `classes.dex` 的 string_ids（MUTF-8），比 `strings` 精确。**关键发现：App 的引擎启动/停止/直连引擎逻辑在 Java/Kotlin 层（classes.dex）**，且很多是**内嵌的完整 shell/Node 脚本字符串**（App 每次启动重写进 rootfs）。
- `E:\mesh\.tmp\asar.py` / `asarls.py`
  解析 `E:\DSH-App\resources\app.asar`，用于取桌面 DSH 版本与桌面前端构建产物（Q6）。

提取产物（本文引用行号）：`E:\mesh\.tmp\dex-hits2.md`、`E:\mesh\.tmp\dex-direct.md`、`E:\mesh\.tmp\dex-scan.md`、`E:\mesh\.tmp\dex-paths.md`、`E:\mesh\.tmp\dex-q2.md`；从 rootfs/APK 摘出的原件在 `E:\mesh\.tmp\rootfs-pick\`、`E:\mesh\.tmp\dsh-src\`。

---

## 1. 引擎启动链路（Q1）

### 1.1 分层链路总览

```
APK assets/runtime/{manifest.json, rootfs-arm64-v8a.tar.xz}
   │  首启解压 23s（实测日志）→ files/runtime/rootfs
   ▼
{filesDir}/runtime/rootfs                ← {-ROOTFS}
   │  App(Kotlin) 读 manifest.launch.argv 模板，替换占位符
   ▼
libproot.so --kill-on-exit … --rootfs={ROOTFS} …
   │  /usr/bin/env -i HOME=… DSH_HOME=/root/.dsh … {GUEST_ENV}
   ▼
/bin/sh -c 'echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web --patch … --host 127.0.0.1 --port {PORT} --no-open'
   │  /usr/local/bin/dsh 是 9 行 shim（web 额外 --import boot-cache.mjs）
   ▼
/opt/node/bin/node --import=/opt/dsh-go/boot-cache.mjs /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web …
   ▼
dsh-web-app 打印 `dsh web: http://127.0.0.1:3080/?token=…`  ← App 用正则抓 token
```

- argv **模板**：`E:\mesh\.tmp\apk-x\assets\runtime\manifest.json:117-169`【实测】
- dsh shim：
  ```sh
  #!/bin/sh
  # dsh-app shim: run the bundled DeepSeek Harness CLI with the bundled Node.
  # `dsh web` (the app's launch) preloads the boot cache, /opt/dsh-go/boot-cache.mjs.
  if [ "$1" = web ]; then
    exec /opt/node/bin/node --import=/opt/dsh-go/boot-cache.mjs /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
  fi
  exec /opt/node/bin/node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
  ```
  `rootfs:/usr/local/bin/dsh:1-7`【实测】
- boot-cache（proot 下 fs 调用加速，读到 token 行即自我卸载）：`rootfs:/opt/dsh-go/boot-cache.mjs:19`（`ROOTS=['/opt/dsh/','/opt/node/','/opt/dsh-go/']`）、`:115-190`（install/uninstall）、`:175-180`（stdout 含 `?token=` 就卸载）、`:193-199`（仅 `argv[2]==='web'` 且主线程时激活）【实测】

### 1.2 实测 argv（MuMu 上真实打印，最权威）

`E:\mesh\.tmp\dshgo-logs\dsh.log:12`（`[dsh-app] launching …` 一行）【实测】：

```
…/lib/arm64/libproot.so --kill-on-exit --link2symlink --sysvipc -L -0 \
  --rootfs=/data/user/0/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs --cwd=/root \
  -b /dev -b /dev/urandom:/dev/random -b /proc -b /proc/self/fd:/dev/fd \
  -b /proc/self/fd/0:/dev/stdin -b /proc/self/fd/1:/dev/stdout -b /proc/self/fd/2:/dev/stderr \
  -b /sys -b <ROOTFS>/var/lib/dsh-app/empty:/sys/fs/selinux -b <ROOTFS>/var/lib/dsh-app/shm:/dev/shm \
  -b /system -b /apex \
  /usr/bin/env -i HOME=/root USER=root LOGNAME=root SHELL=/bin/bash \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 TERM=xterm-256color \
  TMPDIR=/tmp DSH_HOME=/root/.dsh pnpm_config_registry=https://registry.npmmirror.com/ \
  UV_USE_IO_URING=0 NARB_DISABLE_NATIVE_CACHE=1 NODE_OPTIONS=--dns-result-order=ipv4first \
  TZ=Asia/Shanghai NODE_OPTIONS=--dns-result-order=ipv4first --max-old-space-size=2048 \
  UV_THREADPOOL_SIZE=4 DSH_GO_RUNTIME_ROOT=<ROOTFS> \
  /bin/sh -c echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web \
     --patch /etc/dsh-app/dsh-web.patch.yml \
     --patch /opt/dsh-app/auth/auth.patch.yml \
     --patch /opt/dsh-app/search.patch.yml \
     --host 127.0.0.1 --port 3080 --no-open
```

**与 manifest 模板的差异（全部实测）**：
1. `{GUEST_ENV}` 实际展开为 `TZ=…`、`NODE_OPTIONS=… --max-old-space-size=2048`、`UV_THREADPOOL_SIZE=4`、`DSH_GO_RUNTIME_ROOT=<ROOTFS>`；注意 **`NODE_OPTIONS` 出现两次**，后者覆盖前者（保留 ipv4first 同时加堆上限）。
2. 模板里只有一个 `--patch /etc/dsh-app/dsh-web.patch.yml`；App 实际追加 `auth.patch.yml`、`search.patch.yml`（正常模式总是加），以及**仅当手机操控开启时**加 `/opt/dsh-app/phone/phone.patch.yml`（见 1.6）。追加串在 dex 里是带前导空格的常量：`E:\mesh\.tmp\dex-hits2.md:29-42`（`[128]/[129]/[130]`）【实测】
3. 端口：App 选一个 loopback 端口（模板 `{PORT}`），实测 3080。

### 1.3 env / mounts / 关键路径

- proot 自身 env：`manifest.json:170-175` —— `PROOT_LOADER={NATIVE_LIB_DIR}/libproot-loader.so`、`PROOT_TMP_DIR={TMP}`、**`PROOT_L2S_DIR={ROOTFS}/root/.l2s`**、`LD_LIBRARY_PATH={NATIVE_LIB_DIR}`【实测】
- 占位符语义：`manifest.json:176-183`（`{NATIVE_LIB_DIR}`=applicationInfo.nativeLibraryDir 且必须 `useLegacyPackaging=true` 解压 .so；`{ROOTFS}`=filesDir/runtime/rootfs；`{TMP}`=App 私有可写目录）【实测】
- bind 语义要点：
  - `/system`、`/apex` 直接把 Android 系统目录绑进 guest → proot 内能读到 `/system/bin/linker64` 之类
  - `{ROOTFS}/var/lib/dsh-app/empty:/sys/fs/selinux` → 用一个**空目录**顶掉 selinux，规避读取权限
  - `{ROOTFS}/var/lib/dsh-app/shm:/dev/shm` → shm 落在 rootfs 内（Android 上 /dev/shm 不存在）
  - `/dev/urandom:/dev/random`、`/proc/self/fd/*:/dev/{fd,stdin,stdout,stderr}`
- 运行时清单还声明了 4 个 jni lib 的 sha256/来源/patche（`manifest.json:41-102`，`libproot.so` 来自 termux `proot_5.1.107.98_aarch64.deb`，`DT_NEEDED libtalloc.so.2→libtalloc.so` 被改写）【实测】
- 解析 DNS：App 会写 `{ROOTFS}/etc/resolv.conf`（`manifest.json:204`），日志里有 `resolv.conf: … source=network result=written ns1=192.168.1.1,…`（`E:\mesh\.tmp\dshgo-logs\dsh.log:5,8`）【实测】

### 1.4 `/tmp/dsh-web.pid` 与 token 行

- pid 文件由 **sh 自身写**：`echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh …`（`manifest.json:168`）。`$$` 是 sh 的 pid，`exec` 后 sh 的 pid 原地变成 node 的 pid → **pid 文件里就是 node（DSH）的 pid**，`/tmp` = `{ROOTFS}/tmp`（proot 内 `/tmp` 未 bind，指向 rootfs）。【实测+推断】
  - direct engine 下改成 preload 自己写：`rootfs:/opt/dsh-go/direct/preload.mjs:39-41`（`DSH_GO_DIRECT_MAIN=1` 时 `writeFileSync(${rootfs}/tmp/dsh-web.pid, process.pid)`）【实测】
- token 行规范（**只在 stdout 打一次，插件全部加载完之后**）：
  - `manifest.json:184-189`：`stream=stdout`，regex `^dsh web: (http://127\.0\.0\.1:[0-9]+/)\?token=([A-Za-z0-9_-]+)`，示例 `dsh web: http://127.0.0.1:3080/?token=<43 base64url chars>`
  - 产生处：`rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-web-app/lib/index.js:162`（`if (config.printUrl) console.log(\`dsh web: ${authenticatedUrl}\`)`）【实测源码】
  - boot-cache 也把 `text.includes('?token=')` 当作 boot 完成信号（`rootfs:/opt/dsh-go/boot-cache.mjs:178`）【实测】
- token 用法（Server 端鉴权）：
  - `GET /?token=<t>` → 303 到 `./` 并 `Set-Cookie: dsh-auth-<id>=v1.…; Path=/; HttpOnly; SameSite=Strict`（`manifest.json:190-193`）【实测】
  - WebView 里也可以直接加载带 token 的 URL。App 的 Web 模式还会注入 `dsh_web_phone.{js,css}`、`dsh_web_state.js`（`E:\mesh\.tmp\apk-x\assets\flutter_assets\assets\web\*`）【实测】

### 1.5 健康检查

- `manifest.json:194-197`：`tcp` = `127.0.0.1:{PORT}` 可 connect；`http` = **无 cookie `GET /` → 401**（服务在跑但未认证），带 `dsh-auth` cookie → 200【实测（清单声明）】
- 401 的产生处：`rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:572`（写 401）、`:737-750`（`requestRejection`/`admit`：`isTrusted` 失败→403；cookie 或 API 凭据都没有→401）【实测源码】
- App 自己的「就绪」判据是 **token 行**（不是 401/200）：安全模式 helper 里同样是 `line.indexOf('token=') >= 0` 即视作起来了（`rootfs:` 无此文件，见 dex 内嵌 `dsh-app-plugins` 脚本：`E:\mesh\.tmp\dex-scan.md:98-384`，其中 `trial()` 用 token 行判定 PASS）【实测（脚本源码在 dex 里）】

### 1.6 停止方式（两条，且很关键）

`manifest.json:198-202`【实测（清单声明）】：

1. **优雅**：读 `{ROOTFS}/tmp/dsh-web.pid` → `Os.kill(pid, SIGTERM)` → DSH 卸载插件、退出码 0 → `--kill-on-exit` 收掉残留 → proot 退出。
2. **兜底**：`Os.kill(prootPid, SIGQUIT)` 杀掉所有 tracee。**proot 自己忽略 SIGTERM/SIGINT/SIGHUP**，所以 `Process.destroy()` 对 proot 无效，`destroyForcibly()` 会让 node 变孤儿。

安全模式相关补充（dex 内嵌脚本 + 字符串）：
- 安全模式启动：`/usr/local/bin/dsh --profile dsh-app-safe --from-default-profile web --patch /var/lib/dsh-app/safe-mode/overlay.patch.yml`（`E:\mesh\.tmp\dex-paths.md` 中 `[1800]`、`E:\mesh\.tmp\dex-direct.md` 见 `[1600]` 附近）【实测】
- 安全模式目录：`/var/lib/dsh-app/safe-mode/{bin/dsh-app-plugins, overlay.patch.yml, lkg.json, failure.json, last-failure.log, agents/}`（同上 + `[1807]/[1808]`）【实测】
- 连续 2 次启动失败自动进安全模式（官方指南 `en-03-engine-hosts.md:22`、`en-11-faq.md:29`）【实测（官方文档资产）】

### 1.7 启动失败时最容易被忽略的两点

1. **端口只能是具体 loopback/网卡字面量，不能是通配**：`rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-web-app/lib/startup.js:25` 明写 `--host <host>`「bind address: one concrete IPv4 or IPv6 literal of a local interface; **wildcard addresses are rejected**」。→ 手机上的 DSH Web **永远只监听 127.0.0.1:3080**，局域网直接访问不可能（这对 mesh 入站派发是硬约束，见 §3.6/§7）。【实测源码】
2. `useLegacyPackaging=true` 是 proot 能跑的前提（.so 必须被解压到 nativeLibraryDir）——`manifest.json:177`【实测】

---

## 2. rootfs 目录约定（Q2）

### 2.1 顶层布局（pristine rootfs 实测）

```
/
├─ bin -> usr/bin, lib -> usr/lib, sbin -> usr/sbin        (usrmerge)
├─ opt/
│   ├─ dsh/node_modules/@deepseek-ai/*  (DSH 0.2.1-rc.2 全套 197 个包) + /opt/dsh/package.json
│   ├─ node/{bin,lib,etc}                Node 24.22.1（含 npm/npx/corepack）
│   ├─ python/                           python3 + pip
│   └─ dsh-go/{boot-cache.mjs, dsh-go-bridge/, direct/}
├─ usr/local/bin/{dsh→shim, node, npm, npx, pnpm, pnpx, pn, pnx, python3, pip3, corepack}
├─ usr/local/lib/node_modules/pnpm/        pnpm 11.28.5
├─ etc/
│   ├─ dsh-app/{runtime.json, dsh-web.patch.yml}
│   ├─ resolv.conf                         App 每次启动写入
│   └─ profile.d/{01-locale-fix.sh, dsh-app.sh}
├─ var/lib/dsh-app/{shm/, empty/}          bind 目标（selinux/shm）
├─ root/
│   ├─ .dsh/           **pristine 为空目录**（首启后由 DSH 填充）
│   ├─ .l2s/           **必须是空目录**（proot L2S 后端；direct engine 的兼容闸门，见 §4）
│   ├─ workspace/      默认工作目录
│   ├─ .bashrc, .profile
└─ tmp/                /tmp → 这里；启动时写 dsh-web.pid
```

`rootfs:` 实测：`E:\mesh\.tmp\rootfs-pick\` 下是我摘出来可直接读的原件。

### 2.2 `/root/.dsh`（DSH_HOME）——所有用户数据

> pristine rootfs 里 `/root/.dsh` 是**空目录**【实测】；下表来自 DSH 源码、App 内嵌脚本与官方指南，都是「首次启动后会长成什么」。

| 路径 | 作用 | 证据 |
|---|---|---|
| `profiles/web/` | dsh-go 手机引擎唯一使用的 profile（安全模式另用 `dsh-app-safe`） | `rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:551-556`（`web: {bundles:[dsh-base, dsh-web-app]}`）；安全模式脚本 `PROFILE='web'`【实测】 |
| `profiles/web/package.json` | `dependencies`=已装包；`dsh.profile.bundles`=按顺序叠加的组合层 | dex 内嵌指南 `[13]`（`E:\mesh\.tmp\dex-paths.md`）；`rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:611-627`（initProfile 结构）【实测】 |
| `profiles/web/cordis.patch.yml` | 该 profile 的用户补丁层（Web 设置页写这里） | 同上 + dex `[13]`【实测】 |
| `profiles/web/pnpm-workspace.yaml`、`pnpm-lock.yaml` | pnpm 工作区与锁 | `dsh-app-boot/lib/index.js:625-626`（initProfile 写 workspace 文件）【实测】 |
| `profiles/web/.plugin-manager/logs/` | 插件安装日志 | dex `[13]`【实测】 |
| `profiles/web/node_modules/<pkg>/` | 插件实体 | 安全模式脚本 `installedVersion()` / dex `[15]`【实测】 |
| `profiles/web/mesh/` | **mesh 自己的状态目录**（`state.json`/`threads.json`/`sessions/`/`mesh-receive-task/`） | `E:\mesh\dsh-plugin-mesh\lib\layout.js:63-68`（`chooseMeshRoot`：profileDir/mesh 优先）、`:70-91`【实测源码】 |
| `sessions/` | 会话持久化（JSONL） | dex `[15]`（别删 sessions/storages/credentials）【实测】 |
| `storages/` | 插件/服务 storage（json） | 同上【实测】 |
| `.credentials.yaml` | 凭据（mode 0600；`version: 1` + `refs:`） | `manifest.json:206`；`dsh-credentials-local`【实测】 |
| `session-search.sqlite` | 会话搜索库（dsh-app 的 search patch 指定） | dex `[578]`（`- id: session-query-sqlite / path: /root/.dsh/session-search.sqlite / openAt: first-search`）【实测】 |
| `cache/dsh-go-bridge/occupancy.json` | dsh-go-bridge 的槽位占用缓存 | `rootfs:/opt/dsh-go/dsh-go-bridge/lib/index.js:56-59`【实测】 |
| `skills/dsh-go-plugin/` | 官方插件作者技能 + `kit/bin/check.mjs` 校验器（App 每次启动写入） | `E:\mesh\.tmp\apk-x\assets\flutter_assets\assets\skills\dsh-go-plugin\SKILL.md:27-39`【实测】 |
| `dsh-go/plugins/<pkg>/` | 用户自建的原生小插件目录（**引擎重置会保留**） | `…\dsh-go-plugin\SKILL.md:27-31`【实测】 |
| `logs/` | DSH 启动诊断日志 | dex `[13]`【实测】 |
| `cordis.patch.yml`、`.env` | 全局层：对所有 profile 生效 | dex `[13]`；另有 `/root/.env` 也生效【实测】 |

### 2.3 `/etc/dsh-app/`（App 生成，属于 runtime，会被升级覆盖）

- `runtime.json`（`rootfs:/etc/dsh-app/runtime.json:1-15`）：`abi/dshGoBridge/dshPatches/dshVersion/nodeVersion/pnpmVersion/prootVersion/runtimeVersion/ubuntuVersion`。**这个文件的存在就是「这是手机本机引擎」的判据**（`…\dsh-go-plugin\SKILL.md:23`）【实测】
- `dsh-web.patch.yml`（`rootfs:/etc/dsh-app/dsh-web.patch.yml:1-21`）全文关键两段【实测】：
  ```yaml
  - id: plugin-manager
    config:
      fallbackRegistries:
        - https://registry.npmmirror.com/
        - https://registry.npmjs.org/
  - insert:
      - id: dsh-go-bridge
        name: /opt/dsh-go/dsh-go-bridge/lib/index.js
  ```
  → ① plugin-manager 的整份 config 被这行**替换**（profile 的 cordis.patch.yml 里 plugin-manager config **不生效**）；② dsh-go-bridge 按**绝对路径**加载。
- 注释里还写明：`/etc/dsh-app/*` 每次 runtime 升级都会被替换，手改不保留【实测（文件头注释）】

### 2.4 `/opt/dsh-go/`（runtime 自带，App 不重写）

| 路径 | 作用 |
|---|---|
| `boot-cache.mjs` | `dsh web` 的 `--import` 预载：proot 下 realpath/existsSync/readFile(package.json) 的分量缓存，见 §1.1 |
| `dsh-go-bridge/` | **dsh-go-bridge 0.4.0**，见 §3 |
| `direct/` | 免 proot 直连引擎的三个 seam 模块 + 原生 addon 清单，见 §4 |

### 2.5 `/opt/dsh-app/`（App 运行时写入；pristine 里**不存在**）

App 每次引擎启动重写下列子树/文件（内容在 dex 里可见）【实测】：`E:\mesh\.tmp\dex-paths.md` `[1766]-[1769]`、`[1800]-[1808]`；`E:\mesh\.tmp\dex-hits2.md` `[578]-[584]`

| 路径 | 内容 | 证据 |
|---|---|---|
| `auth/{index.mjs,bridge.mjs,auth.patch.yml}` | 订阅登录（ChatGPT/Claude）桥：`appAuth` Remote 服务（list/begin/poll/answer/cancel/signOut），背后是 `ctx.authorization.begin` + `llm-pi-ai` OAuth | `APK:assets/flutter_assets/assets/engine/auth/index.mjs:1-26`、`bridge.mjs:1-20`；patch 见 dex `[580]` |
| `search.patch.yml` | `session-query-sqlite` 覆盖：`path=/root/.dsh/session-search.sqlite`，`openAt: first-search` | dex `[578]` |
| `phone/{phone.patch.yml, relay.cjs}` | 手机操控：把 `@deepseek-ai/dsh-mcp-client` 以 stdio 方式启动 `relay.cjs`，再连 App 的 socket（`{dshPhone:1, token}` 握手）；工具定义在 APK 里（`mcp__phone__*`：screen/intent/open/handoff…） | dex `[579]`（patch）、`[584]`（relay 全文，1911 字节） |
| `direct/config.json` + `direct/bin/` | direct engine 的启动配置与 host 侧 wrapper，见 §4 | `manifest.json:103-115`、`E:\mesh\.tmp\dex-direct.md` |

### 2.6 `/var/lib/dsh-app/`

- `shm/`、`empty/`：proot bind 源（`manifest.json:143,145`；`rootfs` 里实测存在）【实测】
- `safe-mode/`：安全模式全套（见 §1.6）【实测】
- `phone/bridge.json`：手机操控 socket 配置（`abstract` 或 `tcpPort` + `token`），relay 读它（dex `[584]`、`[1806]`）【实测】

### 2.7 系统级其它

- `/etc/profile.d/dsh-app.sh`：登录 shell 的 guest 默认值（PATH/HOME/LANG/TERM/TMPDIR/**DSH_HOME=/root/.dsh**/**pnpm_config_registry=npmmirror**）——**这就是在 agent bash 里直接敲 `dsh`/`pnpm` 能用的原因**（`rootfs:/etc/profile.d/dsh-app.sh:1-8`）【实测】
- `/tmp` 就是 `{ROOTFS}/tmp`：`dsh-web.pid` 在这里【实测】
- 「访问手机文件」开着时 `/sdcard` 会被 bind 进 guest（官方指南 `en-10-settings.md:74`）→ 是**非 root 真机上把文件送进 guest 的最简通道**之一【实测（文档）】

---

## 3. dsh-go-bridge 插件 API（Q3，重点）

dsh-go-bridge 0.4.0 是**两半**：host 半（Node，`lib/index.js`）与 browser 半（`lib/client.js`，`window.__ModuleLoader__.load` 形式）。它同时承担三件事：
1. **给 App 用的插件清单/槽位占用/路由守卫探针**（`/dsh-go/v1/inventory`、`/dsh-go/v1/occupancy`）；
2. **原生插件协议 v1（+v1.2 能力）**：`dshGo` 服务 + `/dsh-go/v1/{contributions,views,invoke,files,media,assets}` + WS `/dsh-go/v1/stream`；
3. **路由守卫兜底**（给没打 route-guard 补丁的远端主机包一层同样的鉴权）。

来源：`rootfs:/opt/dsh-go/dsh-go-bridge/package.json:1-31`（描述/`dsh.bundle`/`dsh.client.immediately`）、`cordis.patch.yml:1-5`（profile 方式安装时用的 layer）；装载方式见 `rootfs:/etc/dsh-app/dsh-web.patch.yml:16-21`（App 按绝对路径 insert）。

### 3.1 host 半暴露的 HTTP / WS 路由（全部要过 Connection 的鉴权）

| 路由 | 方法 | 作用 | 证据 |
|---|---|---|---|
| `/dsh-go/v1/inventory` | GET/HEAD | 给 App：`{v,bridge,release,bootRev,currentRev,packages[],slots,occupancy{reportedAt,stale,attribution,unresolved},routeGuard,routeGuardMode}`，每次读都实测守卫 | `lib/index.js:308-335`、`:357-360` |
| `/dsh-go/v1/occupancy` | POST(JSON) | browser 半上报槽位占用（≤512KB） | `lib/index.js:361-383` |
| `/dsh-go/v1/contributions` | GET | 原生插件清单（含 limits、按 app caps 渲染的 plugins） | `lib/native/routes.js:564` |
| `/dsh-go/v1/invoke` | POST(JSON) | 点按回调：`{v,pkg,id,surface,action?,value?,scope,context?,locale,stream?,userGesture?}` → 效果列表；支持 pending/deferred | `lib/native/routes.js:243-317`、`:321-372` |
| `/dsh-go/v1/views/<pkg>/<panel-id>` | GET | 渲染面板视图（服务端算视图+数据） | `lib/native/routes.js:567` |
| `/dsh-go/v1/files/<req>/{upload,complete}?stream=` | POST | 文件选择握手（见 3.4） | `lib/native/file-picker-runtime.js:102-123` |
| `/dsh-go/v1/media/<pkg>/<id>` | GET | v1.2 媒体（TTS 等）音频流 | `lib/native/routes.js:568-572` |
| `/dsh-go/v1/assets/<pkg>/<path>` | GET | 插件包内图片资源（只允许 png/jpg/jpeg/webp/gif，≤1MiB，realpath 必须落在包内） | `lib/native/routes.js:399-420` |
| `WS /dsh-go/v1/stream` | upgrade | 订阅/推送：`hello→welcome`，`sub/unsub/patch/data/stale/end/cancel/ping-pong`；以及 v1.2 capability 事件 | `lib/native/routes.js:15`、`:468-557` |
| `/dsh-go-guard-canary` | 任意 | 守卫自检「无凭据必须被拒」 | `lib/index.js:32`、`:277-306` |

鉴权：全部走 `connection.requestRejection(req)`（→401/403/503）。放行的只有 `exact /connect`、`exact /oauth/callback`（`lib/index.js:37`、`rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:502-527`）。

### 3.2 给**插件作者**的服务：`ctx.inject(['dshGo'])`（这是 mesh 能复用的核心）

`ctx.provide("dshGo", native.service)`：`rootfs:/opt/dsh-go/dsh-go-bridge/lib/index.js:263-265`；服务方法定义 `rootfs:/opt/dsh-go/dsh-go-bridge/lib/native/core.js:424-445`：

```js
{
  ctx, v, bridge,
  panel(id, {view, data?, actions?})   // 4 个/插件；view=对象或函数；data=(scope,emit,caps)=>cancel；actions={name:fn}
  strip(id, fn|{data})                 // 1 个/插件；emit({text≤24,icon?,tone?})
  media(id, handler)                   // ≤2；v1.2 音频资源，返回 {body, contentType}
  micro(id, def|{data})                // ≤2；mini 数据通道 {text≤240,progress 0..1}
  onCapability(handler)                // 需声明 capabilities；audio.ended/voice.*/overlay.closed 事件
  on(id, handler)                      // composer.actions / message.actions 的点按处理
  refresh(id, scope)                   // 通知数据源过期
  readPickedFile(handle)               // 读用户刚选的文件（v1.3 files 能力）
}
```

配套的声明与取值（都在同一个库里，schema 也随 kit 发给插件作者）：
- manifest 字段：`dshGo.{v,minApp,title,icon,wants,assets,contributes,capabilities}` — `lib/native/manifest.js:10`、`:191`【实测】
- `wants`：`["draft","clipboard","message"]`（**仅**作点按时的 context 传入）— `lib/native/limits.js:66`、`routes.js:18,287-289`【实测】
- `capabilities`：`["audio","voice","micro","overlay","files"]` — `lib/native/capabilities.js:7`；`picker` 类型 `["pickFile","pickImage"]` :10【实测】
- limits 全表（invoke 8 次突发/4 次每秒/并发 4；view 32KiB/120 节点/8 层；data 32KiB@4Hz；patch 16KiB；效果 4 个/3 秒……）— `lib/native/limits.js:5-49`【实测】
- 一次 invoke 允许的效果（由 `effects.js` 归一化）：`insert`(≤2000字, 永不自动发送)/`copy`(≤8000)/`toast`(≤40)/`link`(仅 https)/`open`(panel: 或页面 id)/`command`/`refresh`/`patch`/`pending`(慢活)/v1.2 `audio|voice|overlay`/v1.3 `pickFile|pickImage`——见 `lib/native/effects.js`、`capabilities.js:130-171`、官方指南 `…\dsh-go-plugin\SKILL.md:120-141`【实测】

### 3.3 browser 半（`lib/client.js`）

`window.__ModuleLoader__.load({id:"dsh-go-bridge", factory: require => …})`，`module.exports.name/apply`（`rootfs:/opt/dsh-go/dsh-go-bridge/lib/client.js:1-3`、`:390-393`）【实测】。做四件事（源码注释 `client.js:4-23`）：
1. **归因**：包装 `slots._register`，把每个槽位条目打上「注册者包名」戳（否则只能拿到插件导出的 `name`）；
2. **占用上报**：debounce 1200ms → `POST /dsh-go/v1/occupancy`；
3. **island 模式**：`#dsh-go-island=<slot>` 或 `window.__dshGoBridge.mask([...])`，把官方展示位用低优先级空条目遮住，只留第三方；
4. **右栏 tab 报告**：`sidebar.right.pane.tab(.title)` 的类型 id → 报给 App，可用 `openTab(id)`/`#dsh-go-tab=<id>` 打开。

浏览器侧全局 API：`window.__dshGoBridge = {mask, occupants(slot), report(), rightPaneTabs(), openTab(id)}`（`client.js` 尾部）。**这是 mesh 若想在手机上做「原生/岛式」展示时可直接借用的现成机制**。

### 3.4 文件选择（v1.3 `files` 能力）——唯一的「手机文件」通道

- 插件在 invoke 结果里返回 `{type:'pickFile'|'pickImage', action, maxFiles}`（**必须有用户手势**：`opts.userGesture===true`）— `rootfs:/opt/dsh-go/dsh-go-bridge/lib/native/capabilities.js:159-171`
- App 选完文件后走 `POST /dsh-go/v1/files/<req>/upload?stream=…&name=…&mediaType=…`（`application/octet-stream`，单文件≤8MiB，总计≤16MiB，≤4 个）再 `POST …/complete`，插件用 `ctx.dshGo.readPickedFile(handle)` 读 — `file-picker-runtime.js:102-149`、`core.js:437-441`、`limits.js:13-17`（FILE_LIMITS）
- 注意：**设备 URI/真实路径永不过线**，只传显示名（`file-picker-runtime.js:134-135`）

### 3.5 逐条回答「bridge 能不能给 mesh 这些能力」

| 能力 | bridge 是否提供 | 证据 / 说明 |
|---|---|---|
| **Android 网络接口 / IP / 子网 / 网关** | **不能**。bridge 里没有任何网卡/系统信息读取 | 我对 `rootfs:/opt/dsh-go/dsh-go-bridge/lib/*.js` 与 `lib/native/*.js` 全量 grep `networkInterface\|getifaddrs\|/proc/net\|ClipboardManager\|android\.` → **零命中**（唯一命中都是 `capabilities` 这个 UI 能力词）；它声明的能力只有 `audio/voice/micro/overlay/files`（`limits.js:66`、`capabilities.js:7`）【实测】 |
| **Android 系统信息**（型号/版本/电量…） | 不能（同上）。App 侧信息只出现在**给 App 自己的** `inventory`（`packages/slots/routeGuard`）里，不给插件 | `lib/index.js:308-335`【实测】 |
| **剪贴板** | 只能**间接**拿：`wants:["clipboard"]` → App 在**用户点按**时把剪贴板文本放进 `invoke.context.clipboard`（≤16KiB/字段），插件**不能主动读**、不能写；写只能返回 `{copy:'…'}` 效果 | `routes.js:18,287-289`、`effects.js`、`…\dsh-go-plugin\SKILL.md:79,91,126`【实测】 |
| **输入框草稿** | 同上，`wants:["draft"]`，只在 composer.actions 点按时给 | 同上 |
| **文件选择** | **能**（v1.3 `files` 能力 + picker 效果 + `/files/{upload,complete}` + `readPickedFile`） | §3.4【实测】 |
| **任意 HTTP 路由注册** | 不能「新开」端口；插件仍用 DSH 的 `ctx.webServer.register/registerUpgrade`，**在 dsh-go 上会被 route-guard 统一鉴权**（无 cookie 的局域网请求 → 401/403） | `rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:502-527`；bridge 兜底 `lib/index.js:161-219`【实测】 |
| **原生 UI（胶囊/状态条/面板/菜单/工具卡）** | **能**，完整协议见 §3.2/3.3；需要插件 package.json 里声明 `dshGo` 清单 | 同上【实测】 |
| **音频朗读/TTS/语音/字幕 overlay** | 能（v1.2 `audio/voice/micro/overlay`） | `capabilities.js:1-31`、`capability-runtime.js:1-6`【实测】 |

### 3.6 对 mesh 的**可复用接口清单**（建议照此选型）

1. **原生面板展示 peer/任务列表**（最省事、最贴 dsh-go 体验）
   `ctx.inject(['dshGo'], ctx => { ctx.dshGo.panel('peers',{view,data,actions}) })` + package.json `dshGo.contributes.panels=[{id:'peers', title:'Mesh', placement:['session.tab','features']}]`
   → 手机上不打开 Web 模式也能看到 mesh（`lib/native/core.js:428-435`、`lib/native/manifest.js`）；`list/keyValue/table/progress/metric/actions` 组件足够画设备表与任务队列（`…\dsh-go-plugin\SKILL.md:142-165`）
2. **状态条** `ctx.dshGo.strip('peers', (scope,emit)=>…)` → 输入框上方一行「N 台在线」，`emit({text,icon,tone})`（≤24 字）
3. **一键操作** `ctx.dshGo.on('dispatch', …)` + `composer.actions`，返回 `{insert:'…'}`（永不自动发送）或 `{toast}` / `{link}`（`…\dsh-go-plugin\SKILL.md:120-131`）
4. **工具卡**：不用清单，只要 mesh 的 tool 的 `presentationMeta` 返回 `{'dsh-go/view': {…}}`，手机就有原生卡片（`SKILL.md:166-175`）
5. **手动刷新数据**：`ctx.dshGo.refresh(id, scope)`（`core.js:436`）
6. **文件互传**：若以后要做「手机→桌面发文件」，用 v1.3 picker 通道（§3.4），不要试图在 guest 里猜 /sdcard 路径
7. **不要**指望 bridge 给你网卡/IP —— mesh 必须自己从 proot 内部取（见 §7 风险）

### 3.7 实测：库内没有的东西（避免误期）

- 没有 `dshGo.*` 之外的「系统信息/网络」服务；`dshGo` 服务只做 UI 与数据通道
- 没有对外暴露的 HTTP 端口：全部挂在 DSH webServer（127.0.0.1）
- 不给插件「绕过 route-guard」的口子（`guardRoutes:false` 只对**装了 bridge 的远端主机**有意义：`lib/index.js:270`）

---

## 4. direct engine（Q4）

### 4.1 它想解决什么

proot 的每次路径查找都要 trap 到 tracer，手机上有明显代价（boot-cache 的注释就是这么写的：`rootfs:/opt/dsh-go/boot-cache.mjs:3-8`）。direct engine = **不用 proot，直接用 Android 上跑 rootfs 里的 aarch64 Node**，并在 Node 里用 `--import preload.mjs` 把「guest 路径 ↔ 物理路径」「命令执行」「DNS」「原生 addon 加载」这些 seam 补回来。

### 4.2 组成（`rootfs:/opt/dsh-go/direct/`，全部实测）

| 文件 | 作用 | 关键行 |
|---|---|---|
| `preload.mjs` | 入口。读 `/opt/dsh-app/direct/config.json` → 建 `createPaths` → **L2S 兼容闸门** → `installCommands` → 挂 `globalThis[Symbol.for('dsh.go.direct')]` → `installModules(native-addons.json)` → `installLookup(resolv.conf,hosts)` → 设 `pnpm_config_package_import_method=copy` → `DSH_GO_DIRECT_MAIN=1` 时写 `/tmp/dsh-web.pid` 并 import boot-cache | `:13-15`、`:19-29`、`:30-35`、`:37-44` |
| `paths.mjs` | `{toHost,toGuest,cwd,executable,within,requiresProot,containsExecutionPath,prepareDirectory}`；**整个 rootfs 以同一绝对路径 bind**，所以物理路径 = guest 路径（同路径 alias）；`/root/.l2s` 内的路径一律要求 proot | `:15-51`、`:57-79` |
| `processes.mjs` | 接管 `child_process.{spawn,spawnSync,execFile,execFileSync,exec,execSync,fork}` + `process.execPath`；把 `sh/bash` 换成 `{bin}/sh|bash`、`node` 换成 `{bin}/node`、其余可执行文件走 `{bin}/guest`；`shell` 选项生成 `{bin}/shell-<hash>` wrapper（首行 `#!{config.hostShell}`），wrapper 里 `exec {bin}/guest <exe> "$@"` | `:11-76`、`:85-160` |
| `dns.mjs` | 用 `config.servers` 设置 resolver；读 `{rootfs}/etc/resolv.conf` + `/etc/hosts` | `:60`、preload `:35` |
| `modules.mjs` | 原生 addon：按 `native-addons.json` 的 sha256 白名单加载（`moduleIdentity` seam） | preload `:33-34` |
| `native-addons.json` | 6 个 aarch64 addon 的路径+sha256：`node-addon-system-linux-arm64`、`@img/sharp-linux-arm64`、`@koromix/koffi-linux-arm64`、`node-addon-require-builtin-linux-arm64-gnu`、`node-pty/linux-arm64`、`sherpa-onnx-linux-arm64` | `native-addons.json:1` |
| `bin/`（运行时生成） | `node / pnpm / pnpx / guest / sh / bash / shell-<hash>` = 给 Android 直接 exec 的 wrapper | `E:\mesh\.tmp\dex-direct.md` 中 `[1763] /guest`、`[30002] direct-glibc`、`[126]` 的 guest 脚本片段 |

**guest wrapper 的实测片段**（dex 内嵌，带前导空格 = 拼接进脚本）：

```
 --cwd="$(pwd -P)" /usr/bin/env -u LD_LIBRARY_PATH -u LD_PRELOAD -u PROOT_LOADER \
   -u PROOT_TMP_DIR -u PROOT_L2S_DIR -u DSH_GO_GUEST_PATH "PATH=$guest_path" \
   'SHELL=/bin/bash' 'TMPDIR=/tmp' "$@"
```
— `E:\mesh\.tmp\dex-hits2.md` 的 `[126]`；以及 `if [ "${DSH_GO_GUEST_PATH+x}" = x ]; then guest_path="$DSH_GO_GUEST_PATH"; fi`（`E:\mesh\.tmp\dex-direct.md:711-720`）【实测】

### 4.3 可用性判定（App 侧，Kotlin；从 dex 的错误串反推）

dex 里有整套 direct 引擎的**诊断串**（`E:\mesh\.tmp\dex-direct.md:446-574`），可以直接反推它的校验项【实测】：

| 校验 | 证据串 |
|---|---|
| 只允许 `web` profile | `direct engine: only the web profile can run directly` |
| 解析 launch 模板（argv/env/binds） | `unsupported launch template` / `unsupported launch syntax` / `invalid patch argument` / `unsupported web flag ` / `missing guest environment` / `invalid environment name` / `invalid shell argument` |
| 只接受 loopback host + 合法端口 | `loopback host required` / `host and port required` / `invalid port` |
| bind 校验（拒绝把 `/` 覆盖） | `unsupported bind` / `missing bind value` / `root-overriding bind is unsupported` |
| **ABI/ELF 校验** | `unsupported ABI ` / `unsupported ELF` / `invalid ELF program headers`（说明它会读可执行文件的 ELF header，跟设备 ABI 对齐） |
| ripgrep 必须来自打包 | `packaged ripgrep missing` |
| rootfs / home / 生成目录 | `invalid rootfs path` / `cannot preserve paths through a symlinked home` / `generated directory is a symlink` / `cannot create ` |
| **L2S 闸门** | `proot hard-link backing files require compatible launch`（与 `preload.mjs:19-29` 一致：`{rootfs}/root/.l2s` 必须是**空目录**，否则回退 proot 并保留用户设置/数据：`[dsh-app] direct fallback: proot hard-link backing files need compatible launch; user preference and data retained`，`dex-direct.md:398`） |

对应的 App 偏好键：`directEngine` / `directEngineActive` / `directEngineAvailable` / `directEngineEnabled` / `directEngineFallbackReason`（`dex-direct.md:586-620`）→ App 有独立的「Direct engine」设置页（CONTEXT 里提到 `DirectEngineSettings`）【实测】

### 4.4 `config.json` 结构（**从代码反推**，运行时生成，pristine 里没有）

`preload.mjs:13-14` 要求 `config.schema === 2 && config.rootfs === rootfs`（rootfs 由 `import.meta.url` 反推出，`preload.mjs:10-12`）。各模块实际读取的字段汇总【推断，字段名均为实测自源码】：

```jsonc
{
  "schema": 2,
  "rootfs": "/data/user/0/<pkg>/files/runtime/rootfs",   // 必须等于 preload 推算出的 rootfs
  "mounts": [ { "guest": "/system", "host": "<物理路径>" }, … ],  // paths.mjs:20-23 校验 guest/host 均是绝对路径，guest 不能是 "/"
  "bin":    "<rootfs>/opt/dsh-app/direct/bin",           // processes.mjs:13 用它拼 node/pnpm/pnpx/guest
  "node":   "/opt/node/bin/node",                        // processes.mjs:14 nodeNames 里的一员（也可能是物理路径）
  "hostShell": "/system/bin/sh",                         // processes.mjs:42 wrapper 的 shebang（必须是 Android 上存在的 sh）
  "loader": "/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1",   // manifest.json:107；processes.mjs:69 用于动态 ripgrep
  "libraryPath": "<rootfs>/usr/lib/aarch64-linux-gnu:…",  // processes.mjs:69 --library-path
  "ripgrep": { "path": "/…/rg", "dynamic": true|false },  // processes.mjs:67-71
  "servers": ["192.168.1.1", …]                          // dns.mjs:60
}
```
> 注：`bin`/`node`/`hostShell`/`loader`/`libraryPath`/`ripgrep`/`servers` 是**从 preload 所载模块的读取点反推**的；`schema`/`rootfs`/`mounts` 是确定项。真实文件只能在真机 App 私有目录看（`files/runtime/opt/dsh-app/direct/config.json`，rootfs 内的 `/opt/dsh-app/` 是同一个 bind 点）【待实测】

启动方式推断：App 用 `ProcessBuilder` 直接 exec `{bin}/node --import /opt/dsh-go/direct/preload.mjs /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web …`，并设 `DSH_GO_DIRECT_MAIN=1`、`DSH_GO_DIRECT_ROOTFS=<rootfs>`（dex `[5953]/[5954]`、`[114720]` `[120754]` `[120755]`）、清 `LD_PRELOAD`（dex `[161092]` `unset DSH_GO_DIRECT_MAIN DSH_GO_DIRECT_ROOTFS LD_PRELOAD`）。`{bin}/node` 的 shebang 是 `#!{hostShell}`（Android 的 `/system/bin/sh`），内容是用 rootfs 的 glibc loader 起 rootfs 的 aarch64 node（loader 路径即 `manifest.json:107`）【推断，依据充分】

### 4.5 **x86 模拟器上能否用 direct engine 让 dsh-go 跑起来？**

**结论：不能直接照搬现有 dart 结论，但有真实可测空间；当前证据表示「大概率不行，且被 App 自己的 ABI/ELF 校验挡在启动前」。**依据：

1. **它要执行的是 aarch64 ELF**：loader 固定为 `/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1`（`manifest.json:107`），node 是 rootfs 里的 **aarch64 glibc** 二进制，`native-addons.json` 里 6 个 addon 全是 `linux-arm64`。x86_64 设备上除非有 Intel Houdini/ARM 转译层接手 **execve 的 aarch64 动态链接二进制**，否则内核直接 ENOEXEC。【实测（产物形态）+推断（执行路径）】
2. **App 自己会先拒**：direct 引擎有 `unsupported ABI ` / `unsupported ELF` / `invalid ELF program headers` 三类校验（`dex-direct.md:526-549`），它读 ELF header 与设备 ABI 对表。MuMu 上 App 装在 arm64 变体下（proot .so 从 `/lib/arm64/` 加载，`dsh.log:12`），所以**设备上报的 `SUPPORTED_ABIS` 是否含 arm64-v8a** 决定它给不给开——这一点我没法从 APK 侧证明。【待实测】
3. **direct 不碰 ptrace**：MuMu 上 proot 挂死的直接原因是 ptrace 与 Houdini 冲突（已实测于 CONTEXT），direct engine **完全没有 ptrace**（无 proot、无 L2S 使用）。所以「direct 在 MuMu 上也许能跑」这个假设**技术上不是荒谬的**，值得实测一次——它可能是 x86 模拟器上唯一可用的路径。【推断】
4. **即使 ELF 能起，仍有两个坎**：
   - `useLegacyPackaging`/`bin` wrapper 的 shebang 是 `/system/bin/sh`，x86 模拟器上存在；但 `{bin}/node` 里的 loader 是 aarch64 → 仍要靠 Houdini；
   - `native-addons.json` 的 sha256 白名单只列 arm64 addon；转译层下 dlopen 这些 arm64 .node 通常也能转，但 `node-pty`/`sherpa-onnx` 这类重度 SIMD 代码风险高。【推断】
5. **真正稳妥的验证环境仍是 arm64**：真机 Xiaomi 15 Ultra（Lead 负责）或本机 arm64 AVD `dshgo_arm64`。x86 模拟器只作为「direct 引擎能否开」的**低成本探针**：在 App 的「本机引擎 → Direct engine」页看是否可开、开了之后的日志里是否出现 `direct engine: unsupported ABI/ELF` 或 `[dsh-app] direct fallback: …`。【待实测】

**建议的一次性验证（成本 5 分钟，交给 Lead/真机）**：
```
# 1) 打开 Direct engine，清掉 /root/.l2s（保证为空），重启引擎
# 2) 看日志首行是否变成 direct（而不是 [dsh-app] launch method: proot）
# 3) 成功后立即采：process.platform/arch、os.networkInterfaces()、/proc/net/route、sidecar 可执行性
```

---

## 5. 插件安装 / 升级路径（Q5）

### 5.1 profile 与包解析器（rootfs 内 dsh 源码，全部实测）

`dsh` CLI 入口 `/opt/dsh/node_modules/@deepseek-ai/dsh/lib/`（`bin.js`, `plugin-BiveYA7h.js`, `profile-boot-*.js`）：

- profile 目录 = `$DSH_HOME/profiles/<name>`，常量 `PROFILES_DIR="profiles"` — `rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:507`、`resolveProfileDir` `:546-549`
- 预置模板：`web: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]` — `:551-556`
- `initProfile(dir,bundles)` 写 `package.json`（`{name:"dsh-profile-<name>",private,dependencies:{},dsh:{profile:{bundles}}}`）+ `cordis.patch.yml` + `pnpm-workspace.yaml` — `:611-627`
- **`dsh plugin --profile <p> <args>` = 在 profile 目录里跑 pnpm**：
  - `dsh/lib/plugin-BiveYA7h.js:63-99`（`runPlugin`，`profile !== "desktop"` 走 `runPluginCommand`，带 `--profile`/`--patch` 由上层解析）
  - `rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:71-76`（`anchorPathSpec`：`./x`、`file:./x`、`link:./x` 会被解析成**调用时 cwd 的绝对路径**再交给 pnpm）
  - `:380`（真的 `execa('pnpm', [...args.map(anchorPathSpec)], {cwd: profileDir})`）
  - `:96-124`（`reconcile`：安装后把带 **`dsh.bundle`** 的新依赖**自动 push 进 `dsh.profile.bundles`**；没有 `dsh.bundle` 的只当普通依赖并 warn）
- 插件解析的「外部软链」问题：0.2.1-rc.2 **支持** profile `node_modules` 里指向 profile 树外的软链——`linkedProfileRoots()` 把这类 realpath 收集成 linked roots，并加入 runtime resolver 的 `linkedPaths`（`dsh-app-boot/lib/index.js:664-692`、`:1316`、`:1535-1570`）。**mesh 的 `install.sh` 头注释说「DSH 会拒绝 realpath 落在 node_modules 之外的包、软链会 ERR_MODULE_NOT_FOUND」——那是旧版 DSH 的行为，对本 runtime 不成立**【实测源码 + 与 mesh 注释冲突，建议真机再确认一次】

### 5.2 plugin-manager 配置

- `/etc/dsh-app/dsh-web.patch.yml:10-14` 用 `- id: plugin-manager / config: fallbackRegistries: [npmmirror, npmjs]` **整份替换** plugin-manager config；注释明确「profile 的 cordis.patch.yml 里 plugin-manager 配置在这个 overlay 下不生效」【实测】
- 装包时 pnpm 的 registry 来自启动 env 的 `pnpm_config_registry=https://registry.npmmirror.com/`（`manifest.json:161`），fallback 由上面那行给出 → 国内可装，镜像没同步时落 npmjs【实测】
- 安装日志：`~/.dsh/profiles/web/.plugin-manager/logs/`（dex `[13]`）【实测】
- 构建脚本会被 pnpm 拦：git 类包需要 `allowBuilds`（`dsh/lib/plugin-BiveYA7h.js:97` 提示写到 `profiles/<p>/pnpm-workspace.yaml`）。mesh 的 tarball 里 `scripts` 只是 selftest/check，不是安装期构建 → 不触发【实测（package.json）】

### 5.3 非 root 真机上把本地 tarball 装进 `~/.dsh/profiles/web/node_modules` 的可行方法

> 前提认知：**「非 root」只指 Android 侧**。在 proot 里 agent 和 dsh 都是 root，`/root/.dsh` 可写；真正的难点只是「怎么把文件送进 guest」。

**通道（把 tarball 送进 guest）**
- (a) **局域网 HTTP 分发（推荐）**：桌面起静态服务器 → guest 里 `curl -O http://<桌面IP>:<port>/dsh-plugin-mesh-0.5.4.tgz`。proot 内网络走 Android 网络栈，出站 http 可用（DNS 已由 App 写好 resolv.conf）。【推断（网络栈常规）+实测（resolv.conf 写入）】
- (b) **/sdcard**：App 设置里开「访问手机文件」→ guest 内 `/sdcard` 可读【实测（官方指南 `en-10-settings.md:74`）】；用户用文件管理器把 tgz 放进 Download，再 `cp /sdcard/Download/… /root/`。
- (c) **`adb push` → App 私有目录**：非 root 真机**不可行**（App private 目录 adb 无权限），只有 debug 版可 `run-as`。【推断，与 CONTEXT 一致】
- (d) **原生 UI 文件选择**：v1.3 picker 只把文件交给**插件**（写进插件自己的目录），不是给 shell 用；可作为「App 上传 → 插件落到 ~/.dsh/dsh-go/plugins」的自定义通道，但要自己写代码。【实测（§3.4）+推断（用途）】

**安装命令（在 guest 里、agent 的 bash 或 App 的终端）**
```sh
# 0) 确认环境（都该有）
which dsh pnpm curl; echo $DSH_HOME            # /usr/local/bin/dsh, pnpm, /root/.dsh

# A) 从本地 tarball（离线，推荐）
mkdir -p /root/dl && cd /root/dl
curl -fO http://192.168.x.x:8000/dsh-plugin-mesh-0.5.4.tgz
dsh plugin --profile web add ./dsh-plugin-mesh-0.5.4.tgz
#  → pnpm 解包到 profiles/web/node_modules，reconcile 自动把 dsh-plugin-mesh 加进 dsh.profile.bundles
#  → 之后按提示“重启引擎”（App: 设置→本机引擎→重启）；lib/ 改动必重启，纯 manifest 改动会自动重读

# B) 从 npm 镜像（有网即可，最省事）
dsh plugin --profile web add dsh-plugin-mesh@0.5.4

# C) 开发迭代：装成链接（目录必须保留；0.2.1-rc.2 支持 profile 外的软链，见 5.1）
P=/root/.dsh/dsh-go/plugins/mesh        # 这个目录引擎重置会保留
cp -r /root/dl/dsh-plugin-mesh/. "$P"/
dsh plugin --profile web add "$P"       # 等价 pnpm add link:<abs>；之后每次改 lib 不再重装
```
**D) 完全不用 pnpm 的「手工放置」**（网络/包管理器都不可用时的兜底；有强证据支持可行）：
```sh
# 1) 把包目录放到 node_modules（或放到任意位置后用绝对路径 insert）
cp -r /root/dl/dsh-plugin-mesh /root/.dsh/dsh-go/plugins/mesh
# 2) 启用：在 profile 的补丁层插入绝对路径入口（与 dsh-go-bridge 被 /etc/dsh-app/dsh-web.patch.yml 插入的方式完全一致）
printf '%s\n' '- insert:' '    - id: mesh' '      name: /root/.dsh/dsh-go/plugins/mesh/lib/index.js' \
  >> /root/.dsh/profiles/web/cordis.patch.yml
# 3) 重启引擎
```
  ⚠ 两个坑：① **不要双份**（既 insert 又 bundles，会让「同一个浏览器包有两个来源」的客户端组装失败——dsh-go-bridge 的注释原文「Do not also install dsh-go-bridge into a profile: two sources of one browser package fail the client composition」，`rootfs:/etc/dsh-app/dsh-web.patch.yml:16-17`）；② 这种方式下 mesh 的 `cordis.patch.yml`（含默认 config）**不会自动应用**，要自己把 `- id: mesh config: {...}` 段并进 profile 补丁层，否则会用 schema 默认值。【推断，依据 §3.7 的绝对路径装载先例 + `dsh-app-boot` 的 bundle 逻辑】
  ③ 手工放置的包不会被 pnpm 记录进 `dependencies`，后续 `dsh plugin` 的 reconcile **可能**把它清掉/忽略（`reconcile` 只看 dependencies）。开发期可以，长期建议 A/C。【推断】

**升级 / 卸载**
```sh
dsh plugin --profile web add dsh-plugin-mesh@0.5.5   # 升级（先 uninstall 旧版，官方市场逻辑是“先卸再装”）
dsh plugin --profile web remove dsh-plugin-mesh      # 卸载（reconcile 会把 bundles 里的名字摘掉）
```
然后重启引擎。插件市场 UI（`Settings › Plugins › Plugin market`）走的是同一套 plugin-manager，只是多了 UI 层（`en-08-plugins.md:14-35`）【实测（文档）】。

### 5.4 风险清单

| 风险 | 说明 | 依据 |
|---|---|---|
| 安装/启停会打断对话 | 重启引擎会中断进行中的回复 | `en-08-plugins.md:21` |
| 安全模式不加载插件 | 连续 2 次启动失败 → 自动安全模式（无插件），表现为「mesh 消失」 | `en-03-engine-hosts.md:22`、`en-11-faq.md:29` |
| `/opt/dsh-app/*`、`/etc/dsh-app/*` 会被覆盖 | 别把插件放这里；升级 runtime 会重建 | `dsh-web.patch.yml` 头注释；安全模式指南 |
| `/opt/dsh`、`/opt/node` 会被重建 | 同上 | dex `[15]`「不要改 /opt/dsh、/opt/node」 |
| 手工改 `profiles/web/cordis.patch.yml` 会让「上次正常运行」比对失败/进安全模式 | 建议先备份（`cp … .bak-$(date …)`） | dex `[15]` |
| `pnpm` 首次装会写 lockfile/workspace；并发安装有锁（`package.json.lock`，12 分钟等待） | 别并行装 | `dsh-plugin-manager/lib/types/operations.js:207-260`、`:299-330` |
| mesh 的 sidecar 资产 | `process.platform==="linux"` + `arch==="arm64"` → 下载 **linux/arm64** 资产；proot Ubuntu 里这是**对的**，(Termux 的 android 分支不会触发) | `E:\mesh\dsh-plugin-mesh\lib\tsnet\download.js:51-62` |

---

## 6. 桌面 DSH vs dsh-go 内 DSH：插件 API 差异风险（Q6）

### 6.1 事实：**两边是完全相同的 DSH 版本**

| 项 | 桌面 | dsh-go | 证据 |
|---|---|---|---|
| DSH runtime 版本 | `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.2** | `@deepseek-ai/dsh` **0.2.1-rc.2** | `app.asar:/dsh/package.json:4`（我用 asar 解析读出）；`rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh/package.json:4` |
| 关键 client 包 | — | `dsh-web-app / dsh-client-modules / dsh-client-ui-plugin-manager / dsh-client-ui-layout / dsh-host-webserver / dsh-client-connection / dsh-api-gateway / dsh-web-frontend / dsh-client-locale / dsh-brand` **全部 0.2.1-rc.2** | `E:\mesh\.tmp\dsh-src\` 与 WSL 内 `package.json` 读取【实测】 |
| 前端构建产物 | `dist/assets/index-CN7NIWNw.js`(939867) / `vendor-DcuzkuQH.js`(741114) / `index-BxpfOGf3.css`(77343) / `vendor-DV2921Zo.css`(27312) | **同名同字节大小**（同样 4 个文件） | `app.asar` 内 `/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/…` vs `rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/`【实测】 |

→ **结论：不存在「桌面高版本、手机低版本」的 API 代沟**。`client slots / locale / primitives / peers` 的版本风险在事实层面为 0；风险全部来自「**dsh-go 打了 3 个补丁 + 平台差异 + 运行环境差异**」。

### 6.2 dsh-go 的 3 个补丁落在哪（`manifest.json:23-27`，我在 rootfs 里定位到了对应代码）

| 补丁 | 定位证据 | 对 mesh 的影响 |
|---|---|---|
| `route-guard.diff` | `rootfs:/opt/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:499-527`（`dshGoOpenRoutes`、`dshGoRouteRejection`、`dshGoRejectRequest`、`dshGoGuardUpgrade`） | **直接影响 mesh**：所有 `ctx.webServer.register/registerUpgrade` 路由（mesh 的 `/mesh/api` 前缀、`/mesh/api/ssh/ws`）都会被 401/403 挡在门外，**除非**请求带 `dsh-auth` cookie 或 API 凭据。跨机 peer 调用不会带 cookie → 入站派发在 dsh-go 上**默认不可达**（见 §7） |
| `zz-direct-runtime.diff` | 9 个包出现 `Symbol.for('dsh.go.direct')` seam：`dsh-api-session-controller / dsh-app-boot / dsh-fs-local / dsh-home-paths / dsh-sandbox-policy / dsh-sandbox / dsh-skill-filesystem / dsh-subprocess-local / dsh-working-directory` | 只在 direct 模式下生效；proot 模式下 `globalThis[Symbol.for('dsh.go.direct')]` 不存在 → `dsh-home-paths/lib/index.js:86` 的 `toHost` 短路，行为与桌面一致。**对 mesh 无影响**（除非开 direct） |
| `fs-create-exclusive.diff` | 未直接定位（补丁名自述：`fs` 创建用排他语义） | 与插件装包/原子写相关，风险低；mesh 不做 fs 创建约定 |

### 6.3 mesh client bundle 的可能不兼容点（只列事实 + 待实测）

mesh 的浏览器侧是**手写 bundle**（无构建步骤）：
- `E:\mesh\dsh-plugin-mesh\client\client.js:20` `window.__ModuleLoader__.load({ id:"dsh-plugin-mesh", factory:(require)=>… })`
- `:27` 只 `require("react")`
- `:36` `const inject = ["slots"]`，`:8691-8692` `exports.apply/apply; exports.inject = inject`
- `:8679` `ctx.slots.inject("sidebar.panellist", …)`、`:8685` `ctx.slots.inject("main", …)`
- 可选服务探测：`:369/:739` `ctx.get("sidebarRight")`、`:730` `ctx.get("uiWorkspace")`、`:8262` `ctx.get("layout")`

与之对应的事实：
1. `window.__ModuleLoader__` 在 dsh-go 前端里**存在**（`index-CN7NIWNw.js` 命中），且 dsh-go-bridge 的 client 半用同样写法（`rootfs:/opt/dsh-go/dsh-go-bridge/lib/client.js:1`）→ 加载机制一致【实测】
2. `sidebar.panellist` 槽位名在 `dsh-client-ui-sidebar` 里存在（rootfs 内 grep 命中）→ mesh 的主入口槽位在 0.2.1-rc.2 里仍有效【实测】
3. **`@deepseek-ai/dsh-client-ui-primitives` 与 `dsh-client-ui-slots` 在 dsh-go runtime 里不存在**（`rootfs:/opt/dsh/node_modules/@deepseek-ai/` 无此目录），**桌面 `app.asar` 里也没有**（asar 条目搜索 0 命中）。它们是 mesh 的 **optional peerDependencies**（`E:\mesh\dsh-plugin-mesh\package.json` peerDependenciesMeta 全 optional），且 client bundle 实际**没有 import 它们**（只 require react）→ 事实层面不构成阻塞【实测】
4. dsh-go 的 App **原生界面是 Flutter**，mesh 的 Web UI 只在 App 的「Web 模式」里可见；Web 模式注入 `dsh_web_phone.css`（`data-dsh-app-layout="drawer"`，<1024px 时侧栏变抽屉）→ mesh 的 `sidebar.panellist` 会被收进抽屉，`main` 槽仍可见（`E:\mesh\.tmp\apk-x\assets\flutter_assets\assets\web\dsh_web_phone.css:1-12`、`dsh_web_phone.js:1-27`）【实测（注入脚本）+待实测（真实布局）】
5. mesh 的 host 半 `inject = ["tools","webServer"]`（`lib/index.js:73`）——两者在 dsh-go runtime 都有（`dsh-tools`、`dsh-host-webserver`）【实测】
6. locale：`dsh-client-locale` 版本一致；mesh 若用了 `ctx.get("locale")` 之类，同版本行为一致【推断】

### 6.4 平台/运行时差异（真正的风险区，不是 API 版本）

| # | 事实 | 对 mesh 的含义 | 证据 |
|---|---|---|---|
| 1 | proot 内 `process.platform === "linux"`、`process.arch === "arm64"`；`os.release()` 是 Android 内核版本 | mesh 现有 `process.platform === "android"` 分支**永远不会触发**（capabilities/identity/osinfo/tsnet download 的 Android 特判全部失效） | CONTEXT + `lib/tsnet/download.js:59` |
| 2 | `os.networkInterfaces()` 在 proot 内通常**能看到** Android 的 `wlan0`（proot 不隔离网络命名空间）——但它报的地址/掩码是否可信、是否会漏（Android 的 `netd` 限制）**待实测** | 局域网发现的基础；mesh 需要兜底（读 `/proc/net/route`、`ip` 命令、或由 App 侧传入） | 【待实测】 |
| 3 | DSH Web 只监听 `127.0.0.1:{PORT}`，且 `--host` **拒绝通配地址** | 手机上的 `/mesh/api` **不可能被局域网直接访问**；入站派发必须另想办法（mesh 自建 `node:net` 监听 / 或用 App 的 DSH Remote / adb forward） | `dsh-web-app/lib/startup.js:25`【实测源码】 |
| 4 | route-guard 对所有 `webServer` 路由做 cookie/API 凭据鉴权 | 即使解决了监听地址，peer 的 HTTP 调用也会 401/403 | `dsh-host-webserver/lib/index.js:502-527`【实测】 |
| 5 | Android 后台省电会杀引擎（日志：`background policy: battery optimization on`） | mesh 心跳/announce 会随引擎一起停；`peerTtlMs=20s` 会在桌面侧把手机判离线 | `E:\mesh\.tmp\dshgo-logs\dsh.log:3`【实测】 |
| 6 | 组播收发：proot 不隔离 socket，但 Android 上组播收包需要 `WifiManager.MulticastLock`（App 未持有的话内核会丢组播包） | mesh 的 `useMulticast` 可能收不到 announce → 必须靠 `scanOnStart` 主动扫描兜底 | 【待实测，核心项】 |
| 7 | 网络变化（WiFi/5G 切换）时 App 会重写 resolv.conf 并可能重启引擎 | 重连逻辑要容忍引擎重启 | `dsh.log:5,8,10`【实测】 |

---

## 7. 结论：对 mesh 移植最关键的事实

1. **版本不是问题，执行环境才是。** 桌面与 dsh-go 的 DSH 都是 0.2.1-rc.2，前端构建产物逐字节同源。mesh 的 client bundle（`__ModuleLoader__` + `slots`）在 dsh-go 前端里有对应机制，**不需要为版本做兼容层**。
2. **dsh-go 上「主机侧」mesh 一定能起来**：`tools`/`webServer` 都有，`dsh plugin --profile web add` 可用，`/root/.dsh/profiles/web/mesh/` 可直接落状态。
3. **手机→桌面的派发（出站）路径基本没变**：mesh 自己发 HTTP 到桌面 DSH，走 Android 网络栈，proot 不拦。
4. **桌面→手机的派发（入站）是本次移植最大的结构性问题**：手机上的 DSH Web 被 App 固定为 `127.0.0.1` 且显式拒绝通配 bind，同时所有 webServer 路由被 route-guard 鉴权。→ 选项：(a) mesh 自己 `net.createServer` 监听 `0.0.0.0` 的独立端口（**唯一不依赖 App 改动的方案**）；(b) 让 App 侧放开 `--host`/路由（需要改 App，不在本次范围）；(c) 退化成「手机只发、桌面只收」或 `adb forward`（仅调试可用）。**建议 (a) 并把它当作 GAP-ANALYSIS 的头号项。**
5. **发现层要在 proot 里重做兜底**：`process.platform` 是 `linux`，Android 特判全部失效；组播可能被 Android 丢包；`os.networkInterfaces()` 需真机实测。
6. **bridge 能白送 mesh 一套「手机原生 UI」**：`ctx.dshGo.panel/strip/on` + `dshGo` 清单即可在 App 原生界面里显示 peer 列表/任务队列/一键派发，不用打开 Web 模式；文件互传可复用 v1.3 picker。**但 bridge 不提供网卡/IP/系统信息**，这些仍要 mesh 自己在 proot 里取。
7. **direct engine 目前不能用于 x86 模拟器**（要执行 aarch64 ELF，App 还会做 ABI/ELF 校验）；但它是**唯一不碰 ptrace 的启动方式**，值得在 MuMu 上花 5 分钟验证一次「设置页能不能开 + 日志说什么」，作为低成本探针。验证主战场仍是 arm64 真机/AVD。
8. 安装路径**不依赖 root**：proot 内就是 root；tarball 走局域网 HTTP 最省事；`/sdcard` 是备用通道；手工放置 + 绝对路径 insert 是不用 pnpm 的兜底（有 dsh-go-bridge 这个先例）。

---

## 8. 待实测清单（按 ROI 排序）

> 都需要手机/模拟器侧动作，我这一侧无法完成（不动 adb/模拟器）。

**P0（决定移植架构）**
1. 真机装 dsh-go → 起引擎 → `adb forward tcp:3080 tcp:3080` → 浏览器访问确认 3080 可达；记录 token 行原文与耗时。
2. 在 proot 内跑环境采集脚本（agent 的 bash 即可）：
   ```sh
   node -e 'const os=require("os");console.log(process.platform,process.arch,os.release());
     console.log(JSON.stringify(os.networkInterfaces(),null,1))'
   cat /proc/net/route; cat /proc/net/igmp; ip addr 2>/dev/null || ifconfig -a 2>/dev/null
   node -e 'console.log(require("dgram").createSocket({type:"udp4"}).bind(0))' 2>&1 | head
   ```
   → 确认网卡/IP/组播可见性（对应 §6.4 #2/#6）。
3. 组播实测：桌面起一个 announce 源，手机侧 `lib/_selftest-discovery.mjs` 或手写 dgram 收包，确认 Android 是否丢组播；同时测 `scanOnStart` 主动扫描到桌面的成功率。
4. **入站可达性**：手机 mesh 自建一个临时 `net.createServer` 监听 3080 之外的端口，桌面 `curl` 它，确认 Android 防火墙/无 root 情况下端口可被局域网访问（这是方案 4(a) 的可行性前提）。

**P1（安装与加载）**
5. `dsh plugin --profile web add ./dsh-plugin-mesh-0.5.4.tgz` 端到端跑通；确认 `dsh.profile.bundles` 自动加了 `dsh-plugin-mesh`、`node_modules/dsh-plugin-mesh` 存在、重启引擎后 `/mesh/api` 与页面出现。
6. 验证 0.2.1-rc.2 对「profile 外软链」的接受度（§5.1 与 mesh install.sh 的说法冲突）：`dsh plugin --profile web add <dir>` 后重启，看是否有 `ERR_MODULE_NOT_FOUND`。
7. 手工放置方案（§5.3 D）是否真能加载（含 client 半）：用一个最小 `local-*` 插件按官方 skill 流程验证（`dsh plugin --profile web add "$P"`，见 `…\dsh-go-plugin\SKILL.md:40-45`）。

**P1（direct engine）**
8. MuMu 上打开 Direct engine：看设置页是否可见/可开、日志是否出现 `direct engine: unsupported ABI/ELF` 或 `[dsh-app] launch method: …`；确认 `launch method` 是否从 proot 变成 direct。
9. 真机开 Direct engine 后采 `config.json`（`/opt/dsh-app/direct/config.json`）与 `direct/bin/` 的实际内容，校对 §4.4 的字段推断；同时验证 direct 下 mesh 行为（`Symbol.for('dsh.go.direct')` 存在时 `dsh-fs-local` 等 seam 会影响路径）。

**P2（兼容细节）**
10. mesh 的 Web UI 在 App「Web 模式」抽屉里的真实布局（`sidebar.panellist` 是否被收进抽屉、`main` 面板可用性）。
11. route-guard 对 mesh 的 `/mesh/api` 实际表现：带/不带 cookie 各请求一次，记录状态码与 `x-dsh-go-guard` 头（应为 401/403 + 头）。
12. tsnet sidecar：确认 `process.platform=linux/arm64` 时下载的 linux 资产能在 proot 里 exec（glibc/内核版本）；`/root/.dsh/profiles/web/mesh/` 下的状态是否正常。
13. 后台存活：锁屏/切后台 10 分钟后 mesh 心跳与 peer 列表状态（`peerTtlMs=20s`）。

---

## 9. 附：本次产出与可复用脚本

| 文件 | 用途 |
|---|---|
| `E:\mesh\.tmp\dexstrings.py` | 精确提取 classes.dex 字符串表 |
| `E:\mesh\.tmp\dexscan.py` / `dexhits2.py` / `dexdirect.py` / `dexpaths.py` / `dexq2.py` | 按关键字导出 App 内嵌脚本/诊断串（产出 `dex-*.md`） |
| `E:\mesh\.tmp\asar.py` / `asarls.py` | 只读解析 `app.asar`，取桌面 DSH 版本/前端产物 |
| `E:\mesh\.tmp\apkgrep.py` | 扫 APK 各条目的字节模式（定位启动逻辑在哪个文件） |
| `E:\mesh\.tmp\rootfs-pick\` | 从 rootfs 摘出的 bridge/direct/etc/dsh shim 原件（Windows 可直接读） |
| `E:\mesh\.tmp\apk-x\assets\runtime\manifest.json` | 带行号的运行时清单 |
| `E:\mesh\.tmp\apk-x\assets\flutter_assets\assets\…` | 官方 guide / 插件 skill / web 注入脚本 |
| `E:\mesh\.tmp\dsh-src\` | rootfs 内 dsh 源码相关包（dsh, dsh-app-boot, dsh-plugin-manager, dsh-home-paths, dsh-web-app 等） |
| `E:\mesh\.tmp\w*.sh` | 在 WSL 里跑的各次探查脚本（`w.sh`、`w2.sh`…`w10.sh`，可复现） |

**本文未做的事**：没有修改 `E:\mesh\dsh-plugin-mesh`；没有接触 adb/手机/模拟器；没有在真机或 AVD 上运行任何东西；没有反编译 dex 字节码（只做字符串表提取）。
