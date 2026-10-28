# P1 实现报告：dsh-go 环境识别 + 入站权限默认值修复 + tsnet 资产策略

| 项 | 值 |
|---|---|
| 任务 | task-5（P1 完整版，含真机阻塞项） |
| 基线 | `E:\mesh\dsh-plugin-mesh` v0.5.4（**版本号未改**） |
| 基线提交 | P0 = `6855343`（本报告与 P1 代码同一提交，见 `git log`） |
| 改动范围 | `lib/**`、`package.json`（**未改** `client/client.js`、`cordis.patch.yml`、已装副本） |
| 自测 | `npm test` **exit 0**（全链路，含 check / netinfo / dshgo / inbound-preset / tsnet / caps / osinfo / reply …） |
| 真机事实来源 | Lead 实测（`process.platform=linux`、Android 15 内核、`/system/build.prop` 存在、`getprop` 不在 PATH、`os.cpus().length=0`、`availableParallelism=8`、MAC 全 0、profile=web） |

---

## 0. 一页摘要

| 项 | 状态 | 关键文件:行 | 验收 |
|---|---|---|---|
| **P1-0 入站权限默认值（真机阻塞）** | ✅ | `lib/index.js:309,1235,1262`、`lib/inbound-preset.js:44,59` | `selftest:inbound-preset` 12/0；`selftest:reply` 断言"会话创建时传入的 preset"；桌面零变化（对照 pristine） |
| **P1-1 dsh-go 环境探测** | ✅ | `lib/dshgo.js:178,240,262,133` | `selftest:dshgo` 22/0（真机形状 / 普通 Linux / 各单信号 / 永不抛 / 缓存） |
| **P1-2 osinfo / identity / capabilities** | ✅ | `lib/osinfo.js:162,215,357`、`lib/identity.js:71,130`、`lib/capabilities.js:798,850` | `selftest:osinfo` 26/0（+4 条 dsh-go 用例）；`selftest:caps` **78/0**（含 cpuCores 三级兜底；同时修掉 2 个 Windows 假红） |
| **P1-3 tsnet 资产策略** | ✅ | `lib/tsnet/download.js:54,57,80,93,113` | `selftest`（tsnet）74/0（+7 条：linux→android、覆盖、诊断、不抛） |
| 诊断可见性 | ✅ | `lib/index.js:2206-2223`（health diag）、`:2724-2750`（state）、`:2794`（tsnet.target）、`:1014-1016`（diagnostics） | `selftest:reply` 的 health 断言；JSON 见 §4 |

**桌面端零变化**：`E:\mesh\.tmp\regression-compare.mjs` 对比 pristine 0.5.4 → `NO REGRESSION`
（地址、MAC、`selfRecord().os/osInfo` 完全一致；非 dsh-go 时 `permissionPresetFor` 返回值与旧实现逐组合一致）。

---

## 1. P1-0（最高优先级）：入站权限默认值 `permissionPresetOnDshGo`

### 1.1 根因（真机实测，证据链）

`analysis/DSHGO-BRIDGE-INTEGRATION.md:420-473` 记录了完整链路；关键三行：

| 事实 | 出处 |
|---|---|
| dsh-base 的 `sandbox-policy.mode = process.env.DSH_PERMISSION_MODE ?? "workspace-write"`；`approval.policy = mode==="danger-full-access" ? "never" : "ask"` | `:432-433` |
| permission-presets：`workspace-write` = {workspace-write, **ask**}；`danger-full-access` = {danger-full-access, **never**} | `:434` |
| mesh 建会话后**无条件** `permissionPresets.set(permissionPresetFor(config, task))`，默认 `workspace-write` | `mesh:lib/index.js` 三处 set（`:1272/:1342/:1410`，P1 前行号） |

→ proot 里没有可用沙箱后端（bubblewrap/Landlock 都没有），`workspace-write` 解析成
`approval:ask`，后台会话没有 answerer → **每个入站任务都停在「待确认」**，无人值守不可能。
App 的"新对话默认权限=完全访问"也救不了：mesh 建完会话会再 `set()` 覆盖它。

### 1.2 修法（不改现有键语义）

1. **新增 schema 键**（`lib/index.js:309`）：
   ```js
   permissionPresetOnDshGo: z.string().default(""),   // 空 = 不覆盖，完全保持现状
   ```
   - **没有**写进 `cordis.patch.yml`：`config:` 是整份替换，新键靠 schema 默认 `""` 生效；
     要启用就在手机的 profile patch 里显式写（推荐值 `danger-full-access`，理由见 1.3）。
   - 桌面端不配 = 零变化。
2. **解析抽成纯函数**（`lib/inbound-preset.js:44`）：
   ```js
   resolveInboundPermissionPreset({ config, task, dshGo })
   ```
   优先级：`dshGo && permissionPresetOnDshGo 非空` → `tsnetPermissionPreset`（tsnet 收紧）→ `permissionPreset`。
   单独一层的理由：这是阻塞项的核心规则，必须能离线断言（纯函数 + 显式 `dshGo` 入参）。
3. **index.js 接线**：`permissionPresetFor()`（`lib/index.js:1235`）委托给纯函数，喂 `isDshGo()`；
   三个 `c.permissionPresets.set(...)` 调用点不变（它们本来就只用这个函数）。
4. **启动期校验生效值**（`lib/index.js:1262`）：`setupInbound` 改为校验 `describeInboundPermissionPreset()`
   的**生效值**（旧实现只校验 `config.permissionPreset`，dsh-go 上会校验错对象），日志带来源：
   `权限 preset=…（来源 dsh-go）`，未配置时明确 warn：
   `dsh-go 环境但未设 permissionPresetOnDshGo —— workspace-write 会停在「待确认」`。
5. **可见性**：
   - `/mesh/v1/health` 的 `diag`：`inboundPermissionPreset` + `inboundPermissionPresetSource`（`lib/index.js:2215-2216`）；
   - `/mesh/api/state`：`self.inboundPermissionPreset`（值+来源）、`config.permissionPresetEffective` / `permissionPresetSource`（`lib/index.js:2727,2750-2751`）；
   - `diagnostics` 的 `inboundPermissionPreset`（`:1013-1024`），安全字段白名单加 `permissionPresetOnDshGo`（`lib/diagnostics.js:74`）。

### 1.3 参数取舍（写进文档给现场用）

- isDshGo 且该键非空 → **覆盖优先于 tailnet 收紧**：这是**环境约束**（沙箱后端不存在），
  不是信任边界；tailnet 收紧在 proot 里同样会 ask，等于没生效。需要在 dsh-go 上收紧的话，
  应改用 `permissionPreset: "read-only"`（或在覆盖值里填 read-only，但那样写操作仍会 ask）。
- 推荐值 `danger-full-access`：只有它能得到 `approval:"never"`（`DSHGO-BRIDGE-INTEGRATION.md:434,462`），
  这是"桌面派任务自动跑"的前提；安全性靠 `requirePairing` + 局域网可信度兜底（报告 §6 风险）。
- 默认值保持 `""`（task 要求）：**不替用户做安全降级决定**；未配置时日志/诊断会明确提示"会停在待确认"。

---

## 2. P1-1：`lib/dshgo.js`（新增，环境识别）

### 2.1 判定信号（与 Lead 真机事实对齐）

| 信号 | 真机 | 作用 |
|---|---|---|
| `DSH_GO_RUNTIME_ROOT` 环境变量 | **不存在** | 仅强证据之一，不能当唯一判据 |
| `/opt/dsh-go/` 目录 | 存在（rootfs） | dsh-go 包装层标记 |
| `/etc/dsh-app/` 目录 | 存在（rootfs） | App patch/配置目录 |
| `/system/build.prop` | 存在 | proot 把宿主 Android `/system` 挂进来 |
| `os.release()` 含 `android` | `6.6.30-android15-…` | Android 内核 |
| `/system/bin/getprop` | 存在（PATH 里没有！） | 读属性必须用绝对路径 |
| `/dev/__properties__` | 典型存在 | tailscale androidbin 的同款判据 |

**结论规则**（`lib/dshgo.js:178`）：
```
wrapper   = env DSH_GO_RUNTIME_ROOT || /opt/dsh-go || /etc/dsh-app
isDshGo   = wrapper || (androidKernel && /system/build.prop 存在)
runtime   = isDshGo ? "proot" : ""
```
即："明确 dsh-go 包装" 或 "Android 内核 + /system 已挂载"（Termux 类环境同样命中，
消费方要的就是"无桌面沙箱的 Android 内核环境"这个事实）。

### 2.2 约束与实现

- **任何探测都不抛**（启动路径，抛一次=插件加载失败；`detectDshGo` 外层 try/catch 返回 FALLBACK）。
- 只读、不执行耗时命令：属性先读 `build.prop`（纯文件），读不到才 `execFileSync("/system/bin/getprop", [key])`
  （绝对路径 + 1500ms 超时），且**只在 isDshGo 时**才读属性（桌面不会 exec getprop）。
- 进程级缓存：`dshGoInfo()`（`lib/dshgo.js:240`），环境在进程生命周期内不变；`dshGoSummary()`（`:262`）给诊断。
- 可注入 + 可重置：`detectDshGo({deps:{env,release,exists,isFile,isExecutable,props}})`、
  `__setDshGoForTest`、`__setAndroidPropsForTest`、`__resetDshGoCacheForTest`。
- 输出：`{isDshGo, runtime, wrapper, androidKernel, systemMounted, deviceModel, androidVersion, evidence[]}`。

---

## 3. P1-2：osinfo / identity / capabilities

### 3.1 `lib/osinfo.js`（纯增量，老对端可忽略）

| 改动 | 位置 |
|---|---|
| `resolveDshGo(opts)`：默认走 `dshGoInfo()`，测试可注入 `opts.dshGo`（`false` 强制关闭） | `:100` |
| linux + dsh-go → `platform="android"`、`name="Android 15 · dsh-go proot"`、`version="15"`、`desktop="proot"`、`kernel` 仍 Android 内核串 | `:162-172` |
| `KINDS` 加 `"runtime"`（老对端收到未知 kind 会清空 kind 但**保留条目**） | `:39` |
| `detectSystems` / `systems`：`systems[0] = {kind:"host", platform:"android", name:机型(如 Xiaomi 15 Ultra), version:"15"}`；`systems[1] = {kind:"runtime", platform:"linux", name:"Ubuntu", version:"24.04", distro:"ubuntu", desktop:"proot"}` | `:357-380`、`:466-485` |
| `osString()`：兼容旧 `os` 字段 —— android 上 `android 15 (6.6.30-android15-…)`，其它平台与 0.5.4 **逐字节一致**（`<platform> <kernel>`）；`discovery.selfRecord().os` 改用它 | `:215`；`lib/discovery.js:339` |

### 3.2 `lib/identity.js`

- 抽出 `dshGoMachineId()`（`lib/identity.js:71`，可离线单测），在 `rawMachineId()` 的**平台分支之后**调用
  （`:130`；放在 win32/darwin/android 分支之后，保证桌面平台语义不被改变）。
- 兜底顺序：`ro.serialno` → `ro.boot.serialno`（build.prop/getprop）→ `/etc/machine-id` →
  `hostname + ro.product.model` 组合 → 空。
- 真机 `/etc/machine-id` 为空、无 DMI —— 现在至少能拿到 serial 或"机型+hostname"；
  两者都空时返回空串（**绝不乱认领**；`isSameMachineOtherInstance` 已排除空指纹）。
- 已知局限（写进报告）：两台**同型号**手机的 hostname（localhost）+ model 会撞 → 组合指纹只用于
  "同机重装后认领"，且仍要求 instanceId 不同；不会影响不同型号/不同实例的正常流程。

### 3.3 `lib/capabilities.js`

- 新增 `cpuCoreCount()`（`:798`）：依次 `os.availableParallelism()` → `os.cpus().length` →
  `/proc/cpuinfo` 的 `processor` 行数 → 0；`collectCapabilities().cpuCores` 改用它（`:850`）。
  真机 `cpus().length=0`、`availableParallelism=8` → 名片 `cpuCores: 8`（不再报 0）。
- `memMb` 未动（真机 `totalmem()` = 15112MB 已正常，按 task 要求别动）。
- MAC 采集失败不被当"没网卡"：能力采集本来就不收 MAC；MAC 的可观察性由 P0 的
  `netinfo.macsAvailable` + `MAC_UNAVAILABLE` 错误码负责（`lib/netinfo.js`），P1 无重复实现。
- 顺带修掉 `_selftest-capabilities.mjs` 里两处**平台假设**（硬编码 `":"` 拆 PATH、`win32` 目录必不存在）——
  它们只是在 Windows 开发机上假红，产品代码未改，修后 caps 套件 78/0。

---

## 4. P1-3：tsnet 资产策略

### 4.1 选择规则（`lib/tsnet/download.js:80`）

```
sidecarPlatform 显式配置（linux|android）优先   ← 逃生通道，真机出事可一键换风味
  else platform==="linux" && isDshGo → "android"
  else 原映射（darwin/windows/linux 桌面不变）
```
理由：dsh-go 的 proot 里 `/system` 已挂载、`/dev/__properties__` 存在 → androidbin 的
`onAndroid()` 为真，net.Interfaces 回退可用；而 linux 静态资产（GOOS=linux ET_EXEC）会死在
`netns` 的 controlC（读 `/proc/net/route`，Android app UID 上 EACCES）——
README.md:298-309 是同一坑的真机记录。
`checksums.js` 两种资产都已钉好，未改。
本阶段**只做选择与诊断，不做网络实测**（真机下载/启动留给 E2E）。

### 4.2 诊断可见（`/mesh/v1/health` 的 `diag`）

```json
{
  "net": {"source":"os","macsAvailable":false,"errors":[...]},
  "sidecarPlatform": "auto",
  "sidecarTarget": {"os":"android","arch":"arm64","asset":"dsh-mesh-tsnet-android-arm64.gz",
                    "platform":"linux","executableArch":"arm64","configured":"auto","dshGo":true},
  "dshGo": {"isDshGo":true,"runtime":"proot","wrapper":true,"androidKernel":true,
            "deviceModel":"Xiaomi 15 Ultra","androidVersion":"15","evidence":["dir:/opt/dsh-go",...]},
  "inboundPermissionPreset": "danger-full-access",
  "inboundPermissionPresetSource": "dsh-go"
}
```
（上面的值是按真机事实推演的期望形状；实际 JSON 以真机为准。`describeSidecarTarget()` 不抛，
不支持的平台只给 `{error}` —— 健康检查不能被它带崩。）

---

## 5. 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `lib/dshgo.js` | **新增** | dsh-go 环境探测 + Android 属性读取 + 缓存/注入 |
| `lib/inbound-preset.js` | **新增** | 入站权限 preset 纯函数解析（P1-0 核心） |
| `lib/_selftest-dshgo.mjs` | **新增** | 22 用例：真机形状/普通 Linux/单信号/属性/身份/osString/缓存/永不抛 |
| `lib/_selftest-inbound-preset.mjs` | **新增** | 12 用例：dshGo × 空/非空 × lan/tsnet + 来源 + 永不抛 |
| `lib/index.js` | 修改 | schema 键、permissionPresetFor、setupInbound 校验生效值、applyUnsafe 探测+侧车配置、health/state/diagnostics 暴露 |
| `lib/osinfo.js` | 修改 | Android 宿主身份 + runtime 系统条目 + osString |
| `lib/identity.js` | 修改 | dshGoMachineId 兜底链 |
| `lib/capabilities.js` | 修改 | cpuCoreCount 三级兜底 + 自测导出 |
| `lib/discovery.js` | 修改 | selfRecord().os 改用 osString() |
| `lib/tsnet/download.js` | 修改 | 资产风味选择 + 配置覆盖 + describeSidecarTarget |
| `lib/diagnostics.js` | 修改 | 安全字段白名单加 permissionPresetOnDshGo |
| `lib/_selftest-osinfo.mjs` | 修改 | +4 条 dsh-go 用例（26 通过） |
| `lib/_selftest-capabilities.mjs` | 修改 | +6 条 cpuCoreCount 用例；2 处平台假设修正 |
| `lib/_selftest-tsnet.mjs` | 修改 | +7 条资产选择/覆盖/诊断用例（74 通过） |
| `lib/_selftest-reply-route.mjs` | 修改 | +health diag 断言 +1-0"传入 preset"端到端断言 |
| `package.json` | 修改 | 新增 `selftest:dshgo`/`selftest:inbound-preset`，挂进 `test`；`check` 加两个 `node --check` |
| `cordis.patch.yml` | **未改** | 按 task 要求不写新键（schema 默认 `""`） |

---

## 6. 验收命令与输出摘要

```text
> npm run check
  ✓ 版本号一致：0.5.4 / ✓ 无声明前使用（TDZ） / ✓ 注册表一致：78 icons / 139 aliases / 12 tokens
  ⚠ 跳过：缺的是 DSH 运行时依赖，不是磁盘半态。   （check-loadable 既有行为）
  ✓ llms.txt 与 docs/llms.txt 一致（10743 字符）                          check-EXIT=0

> npm run selftest:inbound-preset     结果：12 通过，0 失败
> npm run selftest:dshgo              结果：22 通过，0 失败
> npm run selftest:netinfo            结果：28 通过，0 失败
> npm run selftest                    结果：74 通过，0 失败   （+7 条 P1-3）
> npm run selftest:caps               全部通过：78 通过 / 0 失败   （+6 条 cpuCores，2 个假红已修）
> npm run selftest:osinfo             结果：26 通过，0 失败   （+4 条 dsh-go）
> npm run selftest:reply              EXIT=0（含 ✓ inbound permission preset: dsh-go override + diag exposure (P1-0)）
> npm run selftest:lan                [pair] 结果：mac-a exit=0，mac-b exit=0 → 通过

> npm test                            全链路 EXIT=0（上述全部串行）
```

配置面（真实库校验，`E:\mesh\.tmp\schemaprobe`）：

```text
# 用真实 @deepseek-ai/schemastery@3.18.5 构建 index.js 的整块 Config
keys: 36
new defaults: {"staticPeers":[],"advertiseAddress":"","sidecarPlatform":"auto","port":45917,...}
invalid staticPeers rejected: true
CONFIG SCHEMA OK
# 真实 yaml@2.9.1 解析 cordis.patch.yml：原键齐全、无多余键
YAML OK
```

桌面不回归：

```text
> node E:\mesh\.tmp\regression-compare.mjs
address-helpers-identical: true
selfRecord-identical: true
NO REGRESSION
```

---

## 7. 风险与待真机确认

1. **真机回归必须做**（P1-0 是本轮核心）：在手机的 profile patch 里加
   `permissionPresetOnDshGo: danger-full-access` 后重启引擎 → 桌面重发一条 mesh 任务 →
   会话**不应**再出现「待确认」，agent 直接跑完并回执；`/mesh/v1/health` 的
   `diag.inboundPermissionPreset` 应为 `danger-full-access`、`source` 为 `dsh-go`。
2. **安全边界**：`danger-full-access` = 入站任务在手机上拥有完全权限（无沙箱、无审批）。
   前提是 `requirePairing` + 可信局域网；不建议在不完全可信网络里开启。
   若只需要"能跑"，可先用 `permissionPreset: "read-only"` 验证链路（写入类任务仍会 ask）。
3. **tsnet 资产尚未真机实测**：P1 只做选择；真机需确认 android/arm64 资产在 proot 里能 exec
   且 tsnet 能起来（`/mesh/v1/health` 的 `diag.sidecarTarget.asset` 应为
   `dsh-mesh-tsnet-android-arm64.gz`；组网卡片不应再出现 netns/netlink 错误）。
4. **osInfo 变化**是对外可见的（对端 UI 从 "Ubuntu" 变成 "Android 15 · dsh-go proot"，
   systems[] 多一条 runtime）；老对端忽略未知 kind，属纯增量。若 UI/Placement 出现异常，先看
   `/mesh/v1/health` 的 `diag.dshGo` 是否误判（普通 Linux 上应为 `isDshGo:false`）。
5. **组合指纹局限**：同型号手机 hostname+model 相同会撞；仅影响"同机重装认领"，
   不影响发现/派发；serial 可读时优先用 serial。
6. **`cpuCoreCount` 顺序**按 task 要求 availableParallelism 优先：容器/cgroup 环境下上报值会
   比 `cpus().length` 小（这是更准的"可用核数"，与旧值不同属预期变化）。
7. 未改 `client/client.js`（生效权限值通过 `/mesh/api/state` 暴露，UI 后续接）；
   未动已装副本；版本仍 0.5.4；`cordis.patch.yml` 未改。

---

## 8. 与任务的对照（task-5 逐条）

| 要求 | 状态 | 证据 |
|---|---|---|
| 新增 `permissionPresetOnDshGo`（默认 `''`，空=不覆盖） | ✅ | `lib/index.js:309` |
| 检测 dsh-go 且非空时入站使用该值 | ✅ | `lib/inbound-preset.js:44`、`lib/index.js:1235`、三处 set 调用点复用 |
| 不改现有 `permissionPreset` 语义 | ✅ | `selftest:inbound-preset` 覆盖 lan/tsnet 旧语义；桌面回归对照 |
| 不写进 `cordis.patch.yml` | ✅ | `git diff` 无该文件 |
| 离线自测：dsh-go true/false + 不写新键行为不变 | ✅ | `lib/_selftest-inbound-preset.mjs`（12）+ reply 端到端断言 |
| 新增 `lib/dshgo.js`（多信号、无耗时命令、getprop 绝对路径、不抛、缓存） | ✅ | `lib/dshgo.js:178,240`；`selftest:dshgo` 22 |
| osinfo：Android 宿主 + runtime Ubuntu + 纯增量 | ✅ | `lib/osinfo.js:162,357,215`；`selftest:osinfo` 26 |
| identity：serial → machine-id → hostname+model → 空 | ✅ | `lib/identity.js:71,130`；dshgo 自测 §5 |
| capabilities：cpuCores 三级兜底；memMb 不动；mac 失败不当没网卡 | ✅ | `lib/capabilities.js:798,850`；`selftest:caps` 78 |
| tsnet：dsh-go→android 资产 + `sidecarPlatform` 覆盖 + checksums 不动 | ✅ | `lib/tsnet/download.js:80,93`；`selftest` 74 |
| health diag 暴露 `sidecarTarget` 与 `dshGo` | ✅ | `lib/index.js:2206-2223`；reply 测试断言 |
| 自测全绿（check/selftest/selftest:caps/selftest:osinfo） | ✅ | `npm test` EXIT 0（caps 78/0、osinfo 26/0） |
| 提交 git（与 P0 不同提交） | ✅ | 见 `git log`（P0=`6855343`） |

> 说明：`dshgo-internals` 提出的两点已吸收 ——
> ① UI 用的 `config:` 快照补了 `permissionPresetEffective` / `permissionPresetSource`（`lib/index.js:2750-2751`）；
> ② 新增独立 `lib/_selftest-inbound-preset.mjs` 并挂进 `test` 链；
> ③ 其担心的"index.js 已 import 而 download.js 未导出"的中间态已随本次改动闭合（`lib/tsnet/download.js:57,113` 已导出）。
