/**
 * dsh-plugin-mesh —— 主机侧（Host half）
 *
 * 做四件事：
 *   1. 用 UDP 组播自动发现局域网内的其他 DSH 实例
 *   2. 起一个对端 HTTP 服务，接受其他 DSH 派来的任务
 *   3. 注册 agent 工具（mesh_peers / mesh_run / mesh_tasks），让 agent 能"下命令"
 *   4. 在本地 web server 上开 /mesh/api/*，给 UI 页面用
 *
 * 收到对端任务时怎么唤醒本机 agent（双路，见 IM协作架构设计.md）：
 *   · 会话键命中且该会话仍活跃 → followup() 注入原会话（originSession 只是回信地址，不复用）
 *   · 否则                                 → 自己建会话并 followup（自包含实现）
 *
 * 安全模型：发现是公开的（同一网段谁都能看见谁），但所有控制操作都要过共享配对码。
 *           首次运行自动生成配对码，用户在 UI 上复制到另一台机器即可。
 */
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname, userInfo, platform, arch } from "node:os";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { brandString } from "@deepseek-ai/dsh-brand";
import { MeshDiscovery, preferredAddress, lanIPv4Addresses, macForAddress, orderedEndpoints } from "./discovery.js";
import { collectNetInfo, configureNetInfo, peerHostsFromSpecs, peerPortsFromSpecs } from "./netinfo.js";
import { dshGoInfo, dshGoSummary, isDshGo } from "./dshgo.js";
import { resolveInboundPermissionPreset, describeInboundPermissionPreset } from "./inbound-preset.js";
import { candidateAddresses, scanForPeers } from "./scan.js";
import { machineFingerprint } from "./identity.js";
import {
  profileDirFromModuleUrl,
  isProfileDir,
  chooseMeshRoot,
  receiveWorkspaceDir,
  legacyMeshDir,
  copyLegacyFiles,
} from "./layout.js";
import {
  startCapabilities,
  currentCapabilities,
  summarizeCapabilities,
  describePeerCapabilities,
  augmentedPath,
  CAPABILITY_REFRESH_MS,
  CAPABILITY_STALE_MS,
} from "./capabilities.js";
import { conversationKey, replyTarget } from "./conversation.js";
import { sanitizeAvatar, detectDefaultAvatar } from "./avatar.js";
import { buildDiagnostics, entryInfo, readPackageVersion } from "./diagnostics.js";
import { buildPrompt } from "./prompt.js";
import { resolvePairing } from "./pairing.js";
import {
  loadTaskHistory,
  saveTaskHistory,
  loadPeerSnapshot,
  savePeerSnapshot,
} from "./persist.js";
import { TsnetNode, channelKey, channelSignature } from "./tsnet/manager.js";
import { configureSidecarPlatform, describeSidecarTarget } from "./tsnet/download.js";
import { createUsbTransport } from "./usb.js";
import { resolveTailnetChannels } from "./tsnet/channels.js";
import { tailnetFetch, tailnetOrigin } from "./tsnet/bridge.js";
import { createWebProxy } from "./web-proxy.js";
import { createSecretReader } from "./desktop-auth.js";
import { createSshManager } from "./ssh-host.js";
import { acceptUpgrade } from "./ws-mini.js";
import {
  createDesktopWebForwarder,
  createDesktopWebUpgrade,
  DESKTOP_WEB_PREFIX,
  DESKTOP_WEB_STREAM_PATH,
} from "./desktop-web.js";

export const name = "dsh-plugin-mesh";
export const inject = ["tools", "webServer"];

// 本地 fork：在 0.5.4 之上做 dsh-go 适配（P0/P1/P1.5）。预发布后缀便于真机 /mesh/v1/health 一眼确认装的是适配版。
const VERSION = "0.5.4-dshgo.2";
// 诊断用：进程启动时间、入口真实路径、**磁盘上** package.json 的版本。
// 这三样放一起才能回答"现在跑的到底是哪份代码" —— 只看 state.json 或重启日志
// 都答不了（真踩过：磁盘升到 0.5.1，进程还在 0.5.0，界面显示 0.5.0）。
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const ENTRY_INFO = entryInfo(import.meta.url);
const DISK_VERSION = readPackageVersion(import.meta.url);
/** 一次性取文件用的 nonce：进程每次启动都换，写进日志给运维/agent 取。 */
const FILE_TRANSFER_NONCE = randomBytes(9).toString("base64url");
const RULE_ID = "mesh-inbound";
const RULE_KIND = "mesh";
const MAX_BODY = 256 * 1024;
const MAX_HISTORY = 200;
/** 默认固定端口：内网里"扫这个端口 + ping 一下"就能建立连接，无需任何配置。 */
export const MESH_DEFAULT_PORT = 45917;

/**
 * 可以在 Mesh 设置页里改的配置项。
 * 只允许白名单键；保存到 state.json 的 settings，启动时覆盖 profile 配置。
 * restart=true 的项需要重启 DSH 才真正生效（端口/定时器/路由在启动时固定）。
 */
const EDITABLE_SETTINGS = {
  useMulticast: { type: "boolean", restart: true },
  scanOnStart: { type: "boolean", restart: true },
  scanIntervalMs: { type: "natural", restart: true, max: 3600000 },
  pingIntervalMs: { type: "natural", restart: true, max: 3600000 },
  scanRanges: { type: "stringArray" },
  permissionPreset: { type: "string", max: 80 },
  agentPreset: { type: "string", max: 80 },
  workspaceRoot: { type: "string", max: 1024 },
  tsnetPermissionPreset: { type: "string", max: 80 },
  desktopWebPort: { type: "natural", restart: true, max: 65535 },
  experimentalRemoteControl: { type: "boolean" },
  minTaskChars: { type: "natural", max: 10000 },
  maxWakesPerThread: { type: "natural", max: 10000 },
  threadWindowMs: { type: "natural", max: 86400000 },
  threadCooldownMs: { type: "natural", max: 3600000 },
};

function coerceSetting(spec, raw) {
  if (spec.type === "boolean") {
    if (typeof raw !== "boolean") return { error: "需要 true/false" };
    return { value: raw };
  }
  if (spec.type === "natural") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > (spec.max ?? Number.MAX_SAFE_INTEGER)) {
      return { error: `需要 0..${spec.max ?? "∞"} 的整数` };
    }
    return { value: n };
  }
  if (spec.type === "stringArray") {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\n]/) : null;
    if (!list) return { error: "需要字符串数组" };
    const value = list.map((s) => String(s).trim()).filter(Boolean);
    if (value.length > 32) return { error: "最多 32 项" };
    for (const s of value) {
      if (s.length > 80 || !/^[0-9a-fA-F:./]+$/.test(s)) return { error: `非法网段：${s}` };
    }
    return { value };
  }
  if (typeof raw !== "string" || raw.length > (spec.max ?? 1024)) {
    return { error: `需要最长 ${spec.max ?? 1024} 字符的字符串` };
  }
  return { value: raw };
}

/** 启动时把设置页保存的覆盖值叠回 profile 配置。 */
function applyStoredSettings(config) {
  const saved = loadState().settings;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  for (const key of Object.keys(EDITABLE_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) {
      try {
        config[key] = saved[key];
      } catch {
        /* 配置对象只读时忽略；设置页仍会保存，下次启动再试 */
      }
    }
  }
}
/** 对端 DSH Web 的部署默认端口（回环代理拿不到对端自报地址时按它拼）。 */
const WEB_PANEL_DEFAULT_PORT = 3080;

/**
 * 互联网自组网（tailnet）通道：通道 id → 节点句柄。
 *
 * 宿主机路由不到 100.x.y.z，所有指向 tailnet 对端的请求都要经对应 sidecar
 * 中转，所以这里用模块级引用，让 peerFetch / scanTailnet 能拿到当前实例。
 * 一台机器可以同时有多条通道（多个 tailnet），每个通道一个 sidecar。
 */
const tailnetNodes = new Map();

/**
 * 当前实例的发现注册表。
 * peerFetch 用它回报每条端点的成败（成功刷新、失败进冷却），所以发送路径会
 * 反过来驱动发现层的健康状态 —— 这也是"主动健康探测"的一半：不用额外心跳，
 * 真正发过请求就是最好的探针。
 */
let activeDiscovery = null;

/**
 * 会话键 → 正在为它建会话期间堆积的消息。
 *
 * 为什么需要：`followup` 注入是**同步**的（所以同一会话内的到达顺序天然保住），
 * 但**建会话是异步的** —— 两条同会话键的消息几乎同时到达时，第二条查 threadState
 * 仍然查不到（第一条的 wakeAgent 还没落库），于是也去建会话，**同一场对话被建出
 * 两个 session**：上下文分裂，threads.json 只记住最后一个。
 *
 * 这里做"占位锁 + 排队"：第一条建会话期间把这个键占住，后来的消息排队等它，
 * 会话建好后按到达顺序排空 —— 顺序与"只建一个"同时得到保证。
 */
const pendingByConv = new Map();

/**
 * 宿主替用户派发过的 thread → 时间戳。
 *
 * 用途：会话里的 agent 看到「我派发了一个任务」，很可能自己再调一次 mesh_run，
 * 对端就会收到两份。这里记一笔，mesh_run 命中同一 thread 且调用方正是被绑定的
 * 那个会话时直接拒绝。
 *
 * 放模块级而不是 applyUnsafe 内部：`/mesh/api/send` 与 `mesh_run` 分属两个
 * 注册函数，只有模块级才同时可见（踩过：声明在里面 → "hostDispatched is not defined"）。
 */
const hostDispatched = new Map();

/**
 * 单个会话的排队上限。超过就**背压**：明确回一个"忙"，而不是无脑排队。
 *
 * 为什么需要：无脑排队会让对方以为"已受理"，实际上消息可能永远等不到会话
 * （会话建失败时队列已经排了）；而且队列无上限时对方的失控循环会在这里堆内存。
 */
const MAX_PENDING_PER_CONV = 8;

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 本机在对端列表里显示的名字；留空用主机名 */
  machineName: z.string().default(""),
  /**
   * 对端 HTTP 端口。默认固定，这样可以直接扫端口发现彼此。
   * 同机跑多个实例时会被占用，此时自动退回随机端口（仍能用组播互相发现）。
   */
  port: z.natural().default(MESH_DEFAULT_PORT),
  /**
   * 本机另一个 DSH 引擎（通常是桌面 App）的 Web 端口：0 = 关闭这条前缀代理。
   * 开了之后 `<本机>:<port>/mesh/web/...` 会转发到 127.0.0.1:<desktopWebPort>，
   * 并自带签名 cookie —— 供手机在应用内查看"有历史会话的那个引擎"。
   */
  desktopWebPort: z.natural().max(65535).default(0),
  /** 实验性：允许在 Mesh 里打开对端 DSH Web / SSH 并操作。默认关闭。 */
  experimentalRemoteControl: z.boolean().default(false),
  announceIntervalMs: z.natural().default(5000),
  /** 超过这么久没心跳、也没 ping 通，算离线 */
  peerTtlMs: z.natural().default(20000),
  requestTimeoutMs: z.natural().default(20000),

  // ── 发现方式（两者互补，默认都开）──
  /** 用 UDP 组播做被动发现：零配置、即时 */
  useMulticast: z.boolean().default(true),
  /** 启动时主动扫一遍本网段的固定端口：组播被路由器/防火墙挡掉时靠它兜底 */
  scanOnStart: z.boolean().default(true),
  /** 周期性重扫（毫秒），0 = 关闭。默认 60s：一次扫描约 1~2 秒，代价很低 */
  scanIntervalMs: z.natural().default(60000),
  /** 额外要扫的网段，如 ["192.168.1.0/24"]；留空则扫本机所在 /24 */
  scanRanges: z.array(String).default([]),
  /** 除了本机端口，额外还要扫的端口（同机多实例、或对端端口被占用时会用到） */
  scanPorts: z.array(z.natural()).default([]),
  scanConcurrency: z.natural().default(64),
  scanTimeoutMs: z.natural().default(800),
  /** 定期 ping 已知对端（毫秒），0 = 关闭。这条让发现不依赖组播也能保活 */
  pingIntervalMs: z.natural().default(10000),
  /**
   * 静态对端：**手动发现入口**。组播被路由器/防火墙挡住、或本机拿不到可靠网卡
   * 信息时（Android/proot），这里点名的地址会直接并入扫描候选并进同一个注册表
   * —— 对端列表可见、ping 保活、`mesh_run` 派发全都照旧。
   *
   * 形如 `["192.168.1.6:45917", "192.168.1.6"]`；省略端口时用本机端口与默认端口去试。
   * 允许主机名（交给系统解析）。默认空 = 不改变原有零配置行为。
   */
  staticPeers: z.array(String).default([]),
  /**
   * 本机对外地址（空 = 自动探测）。填了就用它做公告与自述 `host`。
   *
   * 用于 Android/proot 这类"网卡能枚举但地址不可信/拿不到"的环境；
   * 形如 `"192.168.1.19"` 或 `"192.168.1.19:45917"`（端口部分忽略 —— 本机监听端口
   * 由 HTTP 服务决定）。填错时只记一条诊断，不会变成"没有地址"。
   */
  advertiseAddress: z.string().default(""),
  /**
   * tsnet sidecar 资产风味：`auto` | `linux` | `android`。
   *
   * P0 只做"存值 + 诊断可见"（`/mesh/v1/health` 的 diag 里能看到），真正的资产选择
   * 逻辑在 P1 实现；因此这里不校验枚举，非法值按 auto 处理。
   */
  sidecarPlatform: z.string().default("auto"),
  /**
   * USB/adb 传输（P1.5）：桌面把手机插 USB 时，走 `adb forward` 的
   * `127.0.0.1:<本地端口>` 隧道访问手机 mesh，不依赖局域网/Wi-Fi。
   *
   * **默认关闭**（opt-in）：不配 = 桌面与手机行为完全不变。
   * 没有 adb 时只探测为 `available:false`，不影响局域网/tsnet 发现
   * （ENOENT = 没装 adb，不是"没有手机"，见 AGENTS.md 硬约束 1）。
   */
  usbEnabled: z.boolean().default(false),
  /** adb 可执行文件路径；空 = 用 PATH 里的 adb（Windows 可填绝对路径） */
  usbAdbPath: z.string().default(""),
  /** 本地转发端口区间基址（每个 serial 在 [base, base+span) 里稳定取一个端口） */
  usbForwardBase: z.natural().min(1024).max(65000).default(46000),
  /** USB 轮询间隔（毫秒）：设备枚举 + forward 维护 + health 探测 */
  usbPollMs: z.natural().min(1000).max(3600000).default(15000),
  /**
   * tailnet 通道的探测间隔（毫秒）。局域网走 pingIntervalMs。
   *
   * 为什么单独一个更慢的节奏：局域网免费且不占用户态网络栈，可以勤快；tailnet
   * 要走 sidecar 的隧道（跨网时还会经 DERP 中继），没必要跟局域网一样频繁。
   * 但**必须探**——没验证过的备份通道不算备份，等真需要时才发现不通就晚了。
   */
  tsnetProbeIntervalMs: z.natural().default(60000),

  // ── 访问控制 ──
  /**
   * 是否要求两端配对码一致。默认 false —— 内网里发现即可连，零配置。
   * 如果你在不完全可信的网络里（合租、公司、有访客设备），把它设为 true。
   */
  requirePairing: z.boolean().default(false),

  /** 对端任务在本机新建会话时用的 agent preset */
  agentPreset: z.string().default("standard"),
  /** 对端任务在本机新建会话时的权限；默认不给 danger-full-access */
  permissionPreset: z.string().default("workspace-write"),
  /**
   * dsh-go（Android App + proot）上的入站会话权限 preset；**留空 = 不覆盖**
   * （完全保持 permissionPreset 的现有语义，桌面端零变化）。
   *
   * 为什么需要这个键（真机阻塞项，见 analysis/DSHGO-BRIDGE-INTEGRATION.md §7）：
   * 手机 proot 里没有可用沙箱后端（bubblewrap/Landlock 都没有），
   * `workspace-write` 会解析成 sandbox(workspace-write) + approval:ask；
   * 后台会话没有 answerer，于是**每个入站任务都停在「待确认」**，
   * 桌面派任务要手机用户手工点确认 —— 无人值守不可能。
   * 填 `danger-full-access` 才会得到 approval:"never"，任务自动跑完。
   *
   * 生效条件：只在本机被探测为 dsh-go/Android proot 环境（lib/dshgo.js）时生效；
   * 桌面上配这个键不产生任何行为变化。dsh-go 上**推荐**显式配成
   * `danger-full-access`（入站内容来自外部，安全性靠 requirePairing/局域网可信度兜底）。
   */
  permissionPresetOnDshGo: z.string().default(""),
  /** 对端任务新建会话的工作目录；留空用用户主目录 */
  workspaceRoot: z.string().default(""),

  // ── 互联网自组网（Tailscale / tsnet）──
  //
  // 开启后插件会自动下载一个用户态 Tailscale 节点（sidecar）并加入 tailnet，
  // 让发现与派发跨互联网可用，与局域网路径同等级。
  // 终端用户不需要装 Go，也不需要装 Tailscale 客户端：二进制随插件自动下载。
  // 一台机器可以同时加入**多个 tailnet**：每个通道一个 sidecar、一个 tailnet
  // 地址。设备身份仍然只有一个（instanceId 不变），通道只是多条可达路径。
  // 下面三个 tsnetAuthKey / tsnetControlUrl / tsnetHostname 是**旧版单通道**
  // 字段，保留以兼容已部署的配置与界面；有多通道需求时用 tsnetChannels。
  /** 是否启用互联网自组网（旧版单通道开关；仅在 tsnetChannels 为空时生效） */
  tsnetEnabled: z.boolean().default(false),
  /** Tailscale 授权码（tskey-auth-...）；旧版单通道字段，也可以只在界面上填 */
  tsnetAuthKey: z.string().default(""),
  /** 控制服务器地址；旧版单通道字段。留空用官方 Tailscale，Headscale 用户填自己的 */
  tsnetControlUrl: z.string().default(""),
  /** tailnet 节点名（合法 DNS label）；旧版单通道字段。留空用机器名 */
  tsnetHostname: z.string().default(""),
  /**
   * 多 tailnet 通道。每项：
   *   { id, label, authKey, controlUrl, hostname, enabled }
   *
   * `id` 是稳定标识（进 sidecar 状态目录，决定 tailnet 里的设备身份），
   * 配置文件里手写时**务必显式给**；留空会按 label + controlUrl 推导，
   * 改显示名就会变成新设备。界面添加的通道由宿主生成 `ch-xxxxxxxx`。
   *
   * 这里配了通道后优先于 state.json（配置钉死），也优先于上面三个旧字段。
   */
  tsnetChannels: z
    .array(
      z.object({
        id: z.string().default(""),
        label: z.string().default(""),
        authKey: z.string().default(""),
        controlUrl: z.string().default(""),
        hostname: z.string().default(""),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
  /** 自定义下载源前缀，可含 {url} 占位符；留空用内置镜像列表 */
  tsnetDownloadSources: z.array(String).default([]),
  /**
   * tailnet 对端任务在本机使用的权限 preset；**留空 = 与局域网完全一致**。
   *
   * 单独留一个开关，是因为两者的信任边界不同：进局域网要物理接入，
   * 进 tailnet 只要拿到授权码；而一旦进网，对方就能对你所有机器下 mesh_run。
   * 想收紧就填 "workspace-write" 之类。
   */
  tsnetPermissionPreset: z.string().default(""),

  // ── 循环熔断（2026-09-17 加）──
  //
  // 背景：入站任务会自动新建会话并立刻开跑，而插件原本没有任何回合数上限、
  // 没有派发冷却。两个 agent 互相回执时（如 diet-reconcile 线程）会形成
  // 自持的 ping-pong：实测 2.5 小时内自动开了 54 个会话、约 800 万 token。
  // 下面这些开关就是刹车，任何一条触发都只入箱、不再唤醒 agent。
  //
  // maxWakesPerThread 是**滑动窗口**限速，不是终身配额：只统计最近
  // threadWindowMs 内的唤醒。这样正常的跨机长线程（几轮/小时）永不触发，
  // 而失控循环（那次约 22 轮/小时）会被拦。早先版本是累计计数、进程内
  // 不重置，会把复用的 thread 名字永久毒死，已改掉。
  /** 每个 thread 在窗口内最多自动唤醒多少次；超过后只入箱。0 = 不限制 */
  maxWakesPerThread: z.natural().default(30),
  /** 上面那个计数的滑动窗口长度（毫秒）。默认 1 小时 */
  threadWindowMs: z.natural().default(3600000),
  /**
   * 两次自动唤醒之间的最小间隔（毫秒），管突发；0 = 不限制。
   *
   * 默认 5s：冷却只在**需要新建会话**时生效（注入已有会话不受它约束）。
   * 原来 20s 对对话语义太激进 —— 人连发两条后续，第二条就被静默吞掉了。
   * 突发建会话已由排队锁接管，冷却现在只是一层安全网，不需要那么长。
   */
  threadCooldownMs: z.natural().default(5000),
  /**
   * 单条任务正文短于这个长度就只入箱不唤醒（挡掉 ping/ack 这类寒暄）。
   *
   * 默认从 24 降到 8：中文的信息密度远高于英文，24 字对中文太苛刻 ——
   * 「查看你的硬件配置，已经网络环境」只有 15 字，是一条真实任务，却被静默
   * 吞成 noted-only（真机反馈）。真正该挡的寒暄由 NOTICE_ONLY 正则负责，
   * 长度闸门只留一个很小的地板值。
   */
  minTaskChars: z.natural().default(8),
});

// ───────────────────────── 本地状态（配对码） ─────────────────────────

/** 旧版共享目录：<DSH_HOME>/mesh。只用于迁移，不再写新状态。 */
function legacyRoot() {
  return legacyMeshDir({ dshHome: process.env.DSH_HOME, homeDir: homedir() });
}

function migrateLegacyState(root) {
  copyLegacyFiles(root, legacyRoot());
}

let cachedMeshRoot = "";

/** mesh 根目录：<profile>/mesh。 */
function meshRoot() {
  if (cachedMeshRoot) return cachedMeshRoot;
  const profileDir = currentProfileDir();
  let root = chooseMeshRoot({
    profileDir,
    dshHome: process.env.DSH_HOME,
    homeDir: homedir(),
  });
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch {
    root = chooseMeshRoot({ dshHome: process.env.DSH_HOME, homeDir: homedir() });
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch {
      /* 交给后续读写报错 */
    }
  }
  cachedMeshRoot = root;
  migrateLegacyState(root);
  return root;
}

function stateDir() {
  return meshRoot();
}

function statePath() {
  return join(stateDir(), "state.json");
}

function threadsPath() {
  return join(stateDir(), "threads.json");
}

/**
 * 本插件所在的 profile 名与根目录。
 *
 * 开发目录（不是 DSH profile）会被 isProfileDir 拒绝，退回到 DSH_PROFILE /
 * DSH_HOME 推导，避免把 mesh/ 建到仓库根目录。
 */
function currentProfileDir() {
  const fromPath = profileDirFromModuleUrl(import.meta.url);
  if (fromPath && isProfileDir(fromPath)) return fromPath;
  const profile = String(process.env.DSH_PROFILE ?? "").trim();
  if (!profile) return "";
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const fromEnv = join(home, "profiles", profile);
  return isProfileDir(fromEnv) ? fromEnv : "";
}

function currentProfileName() {
  const dir = currentProfileDir();
  if (dir) return basename(dir) || "default";
  return String(process.env.DSH_PROFILE ?? "").trim() || "default";
}

/**
 * 稳定的实例标识。
 *
 * 为什么必须持久化：instanceId 是"同名机器里区分是哪一台"的依据。原来每次
 * 插件加载都随机生成，于是**对端每重启一次就换一个新身份**，旧记录要等
 * keepMs（默认 5 分钟）才过期 —— 这 5 分钟里同一个名字出现两次，既弹
 * 「有重名」警告，派发也会因为分不清目标而失败。
 *
 * 按 profile 分别保存（不是整机一个）：同一台机器上跑 desktop / meshtest
 * 两个实例时，它们共用同一个 state.json，若共用一个 id 就会互相顶替、
 * 状态来回翻。
 */
function resolveInstanceId() {
  const profile = currentProfileName();
  const st = loadState();
  const saved = st.instanceIds?.[profile];
  if (typeof saved === "string" && /^[0-9a-f]{16}$/.test(saved)) return saved;
  const id = randomBytes(8).toString("hex");
  try {
    saveState({ instanceIds: { ...(st.instanceIds ?? {}), [profile]: id } });
  } catch {
    /* 落盘失败只是退化成"每次重启换 id"，不该影响启动 */
  }
  return id;
}

/**
 * 读取唤醒账本（thread → { wakesAt: number[], sessionId }）。
 *
 * 为什么要落盘：限速账本如果只存内存，重启 DSH 就归零 —— 对端只要等到
 * 你重启就能重新灌满窗口，等于没限。落盘后窗口跨重启连续。
 */
function loadThreads() {
  const out = new Map();
  try {
    const raw = JSON.parse(readFileSync(threadsPath(), "utf8"));
    for (const [key, val] of Object.entries(raw?.threads ?? {})) {
      const wakesAt = Array.isArray(val?.wakesAt) ? val.wakesAt.filter((n) => Number.isFinite(n)) : [];
      out.set(key, { wakesAt, sessionId: typeof val?.sessionId === "string" ? val.sessionId : "" });
    }
  } catch {
    /* 首次运行 / 文件损坏：都当空账本 */
  }
  return out;
}

/**
 * 用户手动提高的上限：thread → 次数。
 *
 * 达到限速上限时不再静默丢弃，而是在 Mesh 页面提示用户，由用户决定是否
 * 提高。这个覆盖值落盘，重启后仍有效；只在内存里会一重启就退回默认值。
 */
function loadCapOverrides() {
  const out = new Map();
  try {
    const raw = JSON.parse(readFileSync(threadsPath(), "utf8"));
    for (const [key, val] of Object.entries(raw?.capOverrides ?? {})) {
      if (Number.isFinite(val) && val > 0) out.set(key, val);
    }
  } catch {
    /* 同上 */
  }
  return out;
}

function saveThreads(map, capOverrides) {
  try {
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const threads = {};
    for (const [key, val] of map) threads[key] = { wakesAt: val.wakesAt, sessionId: val.sessionId || "" };
    // 未显式传入时保留磁盘上已有的覆盖值 —— 否则"记一次唤醒"这种高频写入
    // 会把用户手动提高的上限冲掉。
    const caps = {};
    for (const [key, val] of capOverrides ?? loadCapOverrides()) caps[key] = val;
    writeFileSync(threadsPath(), JSON.stringify({ version: 1, threads, capOverrides: caps }, null, 2), { mode: 0o600 });
  } catch {
    /* 落盘失败不该影响派发本身 */
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = { ...loadState(), ...patch };
  writeFileSync(statePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/**
 * 配对码是否真的要用 —— **每次请求都现算**，所以界面上一开关就立即生效。
 *
 * 两种来源，规则和 tsnet 一致：
 *   · 配置里写 `requirePairing: true` → **钉死开启**（部署方强制，界面关不掉）
 *   · 否则看 `state.json` 里的 `requirePairing` —— 那是界面上那个开关写的
 *
 * 为什么要界面开关：原来只有配置文件一条路，页面上写着"未启用（默认）"却
 * 没有开关，用户只能去翻 YAML。用户实测就卡在这里（"启动开关在哪？"）。
 * 默认值仍然是**关闭** —— 这一点没变，打开只是变得可发现、可操作。
 */
function pairingState(config) {
  return resolvePairing({ config, state: loadState() });
}

function pairingRequired(config) {
  return pairingState(config).required;
}

/** 配置是否把开关钉死了（钉死时界面只能显示、不能改）。 */
function pairingPinned(config) {
  return pairingState(config).pinned;
}

/**
 * 解析 tailnet 的**有效通道列表**（多 tailnet）。
 *
 * 一台机器可以同时加入多个 tailnet：个人账号、公司 tailnet、自建 Headscale
 * 各一个，每个通道一个 sidecar、一个 tailnet 地址。设备身份只有一个，通道只是
 * 这个节点的多条可达路径（见 MESH-DEFINITION.md）。
 *
 * 解析规则（配置 > state.json > 旧版单通道字段）在 lib/tsnet/channels.js 里，
 * 那里是纯函数、有独立自测 —— 这段只负责把磁盘上的 state 读出来。
 */
function effectiveTailnetChannels(config) {
  return resolveTailnetChannels({ config, state: loadState() });
}

/** 通道的对外视图：**绝不回传授权码内容**，只回报是否已配置。 */
function tailnetChannelView(channel, node) {
  const status = node ? node.status() : null;
  return {
    id: channel.id,
    label: channel.label,
    controlUrl: channel.controlUrl,
    hostname: channel.hostname || status?.hostname || "",
    enabled: channel.enabled === true,
    authKeySaved: Boolean(channel.authKey),
    source: channel.source,
    node: status,
    recentEvents: node ? node.recentEvents().slice(-12) : [],
  };
}

/** 当前运行的通道节点里，每条的 tailnet 地址（写进对外名片，供对端提前记下）。 */
function tailnetMetaAddresses() {
  const out = [];
  for (const node of tailnetNodes.values()) {
    if (node.phase !== "running") continue;
    const ip = node.selfIpv4;
    if (ip) out.push(ip);
  }
  return out;
}

/** 把本机的 tailnet 地址同步进名片（任何一条通道起落都要调）。 */
function syncTailnetMeta(discovery) {
  if (!discovery) return;
  discovery.setMeta({ tailnetIps: tailnetMetaAddresses() });
}

/** 当前在跑的通道节点。 */
function runningTailnetNodes() {
  return [...tailnetNodes.values()].filter((n) => n.phase === "running");
}

/**
 * 启动（或重建）一条 tailnet 通道。
 *
 * 授权码/控制服务器/主机名任何一项变了都要重建 sidecar：一个 tsnet 节点只
 * 认一个 tailnet，沿用旧进程会继续待在旧网络里。
 *
 * **失败只影响这条通道**：异常原样抛给调用方，局域网与其它通道不受影响。
 */
async function startTailnetChannel(channel, { config, discovery, log, warn, machineName }) {
  const existing = tailnetNodes.get(channel.id);
  // 配置没变、节点还活着（含等待授权）→ 复用。重试不该把登录流程推倒重来；
  // 配置变了才重建，否则会一直在旧 tailnet 里。
  const signature = channelSignature(channel);
  const live = existing && ["running", "needs-login", "starting", "downloading"].includes(existing.phase);
  if (live && existing.signature === signature) {
    if (existing.phase === "running" && discovery?.port) {
      await existing.registerForward(discovery.port).catch(() => {});
    }
    return { node: existing, reused: true };
  }
  if (existing) {
    tailnetNodes.delete(channel.id);
    await existing.stop().catch(() => {});
  }

  const tag = `tailnet:${channel.label}`;
  const tsnode = new TsnetNode({
    config,
    channel,
    log: (m) => log(`[${tag}] ${m}`),
    warn,
    machineName,
  });
  tailnetNodes.set(channel.id, tsnode);
  tsnode.on("status", (s) => {
    if (s.phase === "error" && s.error) warn(`通道 ${channel.label}：${s.error}`);
    // 侧车起落会改变本机的 tailnet 地址，名片要跟着更新
    syncTailnetMeta(discovery);
  });

  try {
    const { reused } = await tsnode.start();
    // 让本机 mesh 服务在**这条** tailnet 上可达（tailnet :port → 127.0.0.1:port）。
    // 多条通道可以注册同一个端口：每个 sidecar 的监听在各自的用户态网络栈里。
    if (discovery?.port) await tsnode.registerForward(discovery.port);
    syncTailnetMeta(discovery);
    return { node: tsnode, reused };
  } catch (err) {
    // 节点留在表里：界面要能看到这条通道的错误与诊断，而不是"它凭空消失了"
    syncTailnetMeta(discovery);
    throw err;
  }
}

/** 停掉一条通道（不传 id 停全部）。返回实际停掉的通道数。 */
async function stopTailnetChannel(id, discovery) {
  const ids = id ? [String(id)] : [...tailnetNodes.keys()];
  let stopped = 0;
  for (const key of ids) {
    const node = tailnetNodes.get(key);
    if (!node) continue;
    tailnetNodes.delete(key);
    await node.stop().catch(() => {});
    stopped += 1;
  }
  if (stopped > 0) syncTailnetMeta(discovery);
  return stopped;
}


/** 首次运行生成配对码；用户只需把它复制到另一台机器。 */
function ensureSecret() {
  const st = loadState();
  if (typeof st.secret === "string" && st.secret.length >= 16) return st.secret;
  const secret = randomBytes(24).toString("base64url");
  saveState({ secret, createdAt: new Date().toISOString() });
  return secret;
}

function currentSecret() {
  const s = loadState().secret;
  return typeof s === "string" ? s : "";
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 可被 stop 打断的等待（定时器 unref，不阻止进程退出）。 */
function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

// ───────────────────────── 身份与命名 ─────────────────────────

/**
 * 本机名字的解析优先级：**插件配置 > 用户首次启动时填的 > 主机名**。
 *
 * @returns {{name: string, source: 'config'|'saved'|'hostname'}}
 *   source 用来决定 UI 要不要弹"给这台机器起个名字"——
 *   只有落到 hostname 时才算"用户还没命名过"。
 */
function resolveMachineName(config) {
  const fromConfig = String(config.machineName ?? "").trim();
  if (fromConfig) return { name: fromConfig, source: "config" };
  const saved = String(loadState().machineName ?? "").trim();
  if (saved) return { name: saved, source: "saved" };
  return { name: hostname(), source: "hostname" };
}

/** 校验用户填的名字；地址格式是「机器名/agent 名」，所以斜杠要挡住。 */
function validateMachineName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) throw new Error("名字不能为空");
  if (name.length > 32) throw new Error("名字最长 32 个字符");
  if (name.includes("/") || name.includes("\\")) throw new Error("名字不能包含斜杠 —— 地址格式是「机器名/agent 名」");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) throw new Error("名字不能包含控制字符");
  return name;
}

// ───────────────────────── 插件入口 ─────────────────────────

/**
 * `sidecarPlatform` 的生效值：只认 auto/linux/android，其余按 auto（并保留原文，
 * 让诊断里能看出用户填了什么怪值）。P0 只用于展示，选择逻辑在 P1。
 */
function sidecarPlatformValue(config) {
  const raw = String(config?.sidecarPlatform ?? "").trim().toLowerCase();
  return raw === "linux" || raw === "android" ? raw : "auto";
}

/**
 * 网络探测结果的可观察摘要（诊断/健康检查用）。
 *
 * 只带"从哪来 / 能不能用 / 哪一步失败"，不带地址列表（地址本身在 selfRecord 里，
 * 而且健康检查是未鉴权的，别往外多送东西）。**绝不抛**。
 */
function netSummary(info) {
  try {
    if (!info) return { source: "none", macsAvailable: false, errors: [] };
    return {
      source: String(info.source ?? "none"),
      macsAvailable: info.macsAvailable === true,
      errors: (Array.isArray(info.errors) ? info.errors : [])
        .slice(0, 6)
        .map((e) => ({ source: String(e?.source ?? ""), code: String(e?.code ?? "") })),
    };
  } catch (err) {
    return { source: "error", macsAvailable: false, errors: [{ source: "netinfo", code: "THROW" }] };
  }
}

/**
 * USB 诊断的安全包装：`/mesh/v1/health` 是**未鉴权**接口，只允许计数/错误码，
 * 不给 adb 路径、错误原文（可能含本机路径）。传入的是 `createUsbWiring().diag()`
 * （本身已脱敏），这里再兜一层异常。**永不抛**。
 */
function usbStatusSafe(usbStatus) {
  const empty = { enabled: false, available: false, devices: 0, endpoints: 0, errors: [] };
  try {
    if (typeof usbStatus !== "function") return empty;
    const out = usbStatus();
    return out && typeof out === "object" ? out : empty;
  } catch {
    return { enabled: true, available: false, reason: "DIAG_FAILED", devices: 0, endpoints: 0, errors: [] };
  }
}

/** 数字配置的区间钳制（config 来自 schema，但热更新/手写 patch 仍可能越界）。 */
function usbClampNumber(value, min, max, fallback) {  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * USB/adb 传输的接线：把 `lib/usb.js` 的端点事件翻译成 discovery 注册。
 *
 * 为什么独立成函数（而不是直接塞进 applyUnsafe）：
 *   · 这段逻辑是真机验收的关键（端点登记/去重/诊断），必须能**离线单测**；
 *   · `lib/usb.js` 自包含（不 import discovery/index），这里也只依赖
 *     `discovery.note()` 一个入口，fake 掉 transport 就能在 Node 里跑全链路。
 *
 * 契约（见 analysis/USB-ADAPTER-DESIGN.md §4.2）：
 *   · `onEndpoints(list)` → 对每个 endpoint **原样**把 `ep.record` 交给
 *     `discovery.note(record, ep.host, {transport:"usb", channel: ep.key, port, rttMs, probeIntervalMs})`。
 *     端点身份用 `usb:<serial>`（channel），所以同一台手机的 LAN 与 USB 通道会落在
 *     **同一个 peer** 的多 endpoint 下（discovery.#upsert 按 instanceId 合并），
 *     不会造出第二个设备条目。
 *   · `onError` → 记环形错误（诊断用）+ 一条 warn；传输层自己已按
 *     serial|phase|code 限流 60s，这里不重复限流、也不把错误翻译成"没有设备"。
 *   · 任何情况下不抛：调用点在定时器、HTTP 健康检查、卸载路径上。
 *
 * @returns {{enabled: boolean, transport: object|null, createError: string,
 *   start: () => Promise<object|null>, stop: () => void,
 *   status: () => object|null, diag: (opts?: {detail?: boolean}) => object}}
 */
export function createUsbWiring({ config = {}, discovery = null, log = () => {}, warn = () => {}, createTransport = null } = {}) {
  const enabled = config?.usbEnabled === true;
  const factory = typeof createTransport === "function" ? createTransport : null;
  /** 最近错误（给 diag 用；传输层 status().errors 也有一份，取并集）。 */
  const recentErrors = [];
  const rememberError = (raw) => {
    const e = raw && typeof raw === "object" ? raw : {};
    recentErrors.push({
      serial: String(e.serial ?? "").slice(0, 64),
      phase: String(e.phase ?? "").slice(0, 32),
      code: String(e.code ?? "INTERNAL").slice(0, 32),
      at: Number(e.at) || Date.now(),
    });
    if (recentErrors.length > 20) recentErrors.shift();
  };

  let transport = null;
  let createError = "";
  let lastEndpoints = [];
  let probeIntervalMs = 10000;
  let pollMs = 15000;

  if (enabled) {
    if (typeof factory !== "function") {
      createError = "NO_FACTORY";
      rememberError({ phase: "create", code: "NO_FACTORY" });
    } else {
      pollMs = usbClampNumber(config.usbPollMs, 1000, 3600000, 15000);
      const forwardBase = usbClampNumber(config.usbForwardBase, 1024, 65000, 46000);
      probeIntervalMs = Math.max(1000, Number(config.pingIntervalMs) || 10000);
      try {
        transport = factory({
          adbPath: String(config.usbAdbPath ?? "").trim() || "adb",
          // 手机侧 mesh 端口：目前固定默认端口（手机配置里就是 45917）。
          devicePort: MESH_DEFAULT_PORT,
          forwardBase,
          pollMs,
          // 这只是 health 探测的本地超时，不是任务 HTTP 的超时（后者默认 20s）
          probeTimeoutMs: Math.min(1200, Number(config.requestTimeoutMs) || 20000),
          log: (m) => log(`usb: ${m}`),
          onError: (e) => {
            rememberError(e);
            warn(`USB ${e?.serial || "adb"} ${e?.phase || "?"}/${e?.code || "?"}：${e?.message || ""}`);
          },
          onEndpoints: (list, meta) => {
            lastEndpoints = Array.isArray(list) ? list.slice() : [];
            for (const ep of lastEndpoints) {
              try {
                if (!ep || !ep.record) continue;
                // 端点注册唯一入口：record 原样交给 discovery（协议字段一个都不改）
                discovery?.note?.(ep.record, ep.host || "127.0.0.1", {
                  transport: "usb",
                  channel: String(ep.key || `usb:${ep.serial || "unknown"}`),
                  port: Number(ep.port) || 0,
                  rttMs: Number(ep.rttMs) || 0,
                  probeIntervalMs,
                });
              } catch {
                /* note() 自己不该抛；这里兜底，一个坏端点不能拖垮整轮 */
              }
            }
            void meta;
          },
        });
      } catch (err) {
        createError = String(err?.message ?? err).slice(0, 200);
        rememberError({ phase: "create", code: "INTERNAL" });
        transport = null;
      }
    }
  }

  /** 传输层 status 的安全包装（永不抛）。 */
  const status = () => {
    try {
      return transport && typeof transport.status === "function" ? transport.status() : null;
    } catch {
      return null;
    }
  };

  /**
   * 诊断快照。`detail=false`（health，未鉴权）只给计数/错误码；
   * `detail=true`（诊断页/日志）补 devicePort/forwards/skipped/endpointKeys。
   * **永不抛**。
   */
  const diag = (opts = {}) => {
    const detail = opts && opts.detail === true;
    if (!enabled) return { enabled: false, available: false, devices: 0, endpoints: 0, errors: [] };
    const st = status();
    const base = {
      enabled: true,
      available: false,
      reason: createError ? "CREATE_FAILED" : "STATUS_UNAVAILABLE",
      adbVersion: "",
      started: false,
      pollCount: 0,
      devices: 0,
      endpoints: lastEndpoints.length,
      errors: recentErrors.slice(-5),
    };
    if (!st) return detail ? { ...base, ...(createError ? { createError } : {}) } : base;
    const statusErrors = (Array.isArray(st.errors) ? st.errors : [])
      .slice(-5)
      .map((e) => ({
        serial: String(e?.serial ?? "").slice(0, 64),
        phase: String(e?.phase ?? "").slice(0, 32),
        code: String(e?.code ?? "").slice(0, 32),
      }));
    const summary = {
      enabled: true,
      available: st.available === true,
      reason: st.available === true ? "" : String(st.reason || "UNAVAILABLE").slice(0, 40),
      adbVersion: String(st.adbVersion || "").slice(0, 32),
      started: st.started === true,
      pollCount: Number(st.pollCount) || 0,
      devices: Array.isArray(st.devices) ? st.devices.length : 0,
      endpoints: Array.isArray(st.endpoints) ? st.endpoints.length : lastEndpoints.length,
      errors: (statusErrors.length > 0 ? statusErrors : recentErrors.slice(-5)).slice(-5),
    };
    if (!detail) return summary;
    return {
      ...summary,
      devicePort: Number(st.devicePort) || MESH_DEFAULT_PORT,
      pollMs: Number(st.pollMs) || pollMs,
      forwards: Array.isArray(st.forwards) ? st.forwards.length : 0,
      skipped: (Array.isArray(st.skipped) ? st.skipped : []).slice(0, 5).map((s) => ({
        serial: String(s?.serial ?? "").slice(0, 64),
        reason: String(s?.reason ?? "").slice(0, 40),
      })),
      endpointKeys: (Array.isArray(st.endpoints) ? st.endpoints : []).slice(0, 8).map((e) => ({
        key: String(e?.key ?? ""),
        machine: String(e?.machine ?? ""),
        rttMs: Number(e?.rttMs) || 0,
      })),
    };
  };

  /** 启动（幂等由传输层保证）；失败返回 null，不抛。 */
  const start = () => {
    try {
      if (!transport || typeof transport.start !== "function") return Promise.resolve(null);
      return Promise.resolve(transport.start()).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };

  /** 停止（卸载路径）；不抛。传输层只删除自己建的 forward。 */
  const stop = () => {
    try {
      if (transport && typeof transport.stop === "function") return transport.stop();
    } catch {
      /* 卸载路径不能抛 */
    }
    return null;
  };

  return { enabled, transport, createError, start, stop, status, diag };
}

export function apply(ctx, config) {
  if (config.enabled === false) {
    ctx.logger?.info?.("mesh: 已禁用");
    return;
  }
  // 安全网：这是个"附加能力"插件，任何自身故障都不该让 DSH 起不来。
  // 出问题时只禁用自己，并把原因写进日志。
  try {
    applyUnsafe(ctx, config);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    ctx.logger?.error?.(`mesh: 初始化失败，插件已停用（不影响 DSH 其他功能）：${detail}`);
    try {
      ctx.logger?.warn?.("mesh: 插件已停用；修好后重启 DSH 即可恢复。");
    } catch {
      /* logger 本身不可用 */
    }
  }
}

function applyUnsafe(ctx, config) {

  applyStoredSettings(config);
  // 地址采集的配置必须在任何 selfRecord()/公告/健康检查之前生效：这些路径都会
  // 同步读 netinfo 的模块级配置（advertiseAddress 是最高优先级来源）。
  configureNetInfo({ advertiseAddress: config.advertiseAddress ?? "" });
  // dsh-go/Android proot 探测（只读、进程内缓存一次）。它决定三件事：
  //   ① 入站权限默认值（permissionPresetOnDshGo）；
  //   ② tsnet sidecar 资产风味（auto → android/arm64）；
  //   ③ 平台身份/CPU 核数（osinfo/identity/capabilities）。
  const dshGo = dshGoInfo();
  // sidecar 资产选择也读这个配置（auto 时 dsh-go→android/arm64）。
  configureSidecarPlatform(config.sidecarPlatform ?? "");
  const resolved = resolveMachineName(config);
  const identity = { name: resolved.name, source: resolved.source };
  ensureSecret();
  const instanceId = resolveInstanceId();
  const log = (m) => ctx.logger?.info?.(`mesh: ${m}`);
  const warn = (m) => ctx.logger?.warn?.(`mesh: ${m}`);

  if (dshGo.isDshGo) {
    log(
      `检测到 dsh-go/Android proot 环境：${dshGo.deviceModel || "未知机型"} Android ${dshGo.androidVersion || "?"}` +
        `（证据 ${dshGo.evidence.join(", ")}）`,
    );
  }

  const inbound = [];
  const outbound = [];

  // ── 任务记录的持久化 ──
  //
  // 这两个数组原来是纯内存态（上限各 200 条），重启即清空 —— 排查"刚才到底
  // 派发了什么"只能去翻会话记录。启动时捞回上次的记录，之后每次增删延时落盘。
  const restoredHistory = loadTaskHistory(stateDir());
  if (restoredHistory.inbound.length > 0) inbound.push(...restoredHistory.inbound);
  if (restoredHistory.outbound.length > 0) outbound.push(...restoredHistory.outbound);
  if (inbound.length > 0 || outbound.length > 0) {
    log(
      `已恢复重启前的任务记录：收件 ${inbound.length} 条 / 发件 ${outbound.length} 条` +
        (restoredHistory.savedAt ? `（快照 ${new Date(restoredHistory.savedAt).toISOString()}）` : ""),
    );
  }
  let historyTimer = null;
  /** 延时落盘：一次密集来包可能连推好几条，没必要每条都写一次磁盘。 */
  const scheduleHistorySave = () => {
    if (historyTimer) return;
    historyTimer = setTimeout(() => {
      historyTimer = null;
      saveTaskHistory(stateDir(), inbound, outbound);
    }, 500);
    historyTimer.unref?.();
  };
  /**
   * 每个 thread 的唤醒账本：{ wakesAt: number[], sessionId }。
   * wakesAt 只保留滑动窗口内的时间戳，既给限速/冷却用，也让后续消息
   * 能复用同一个会话。落盘到 threads.json —— 重启不清零，否则对端等到
   * 你重启就能重新灌满窗口。
   */
  const threadState = loadThreads();
  /** 用户手动提高的上限：thread → 次数（落盘） */
  const capOverrides = loadCapOverrides();
  /**
   * 被限速挡下的 thread：thread → { taskIds: string[], firstAt, lastAt, cap }。
   * 只用来在 Mesh 页面提示用户"要不要提高上限"；任务本身仍在 inbound 收件箱里。
   */
  const throttled = new Map();
  /** 该 thread 的生效上限：用户覆盖值优先，否则用配置默认 */
  const capFor = (key) => capOverrides.get(key) ?? config.maxWakesPerThread ?? 0;
  // 剪掉早已过期的 thread，别让文件随时间无限长大
  {
    const cutoff = Date.now() - (config.threadWindowMs ?? 3600000);
    for (const [k, v] of threadState) {
      v.wakesAt = (v.wakesAt ?? []).filter((t) => t > cutoff);
      if (v.wakesAt.length === 0 && !v.sessionId) threadState.delete(k);
    }
  }

  const initialAvatar = sanitizeAvatar(loadState().avatar) || detectDefaultAvatar();
  const discovery = new MeshDiscovery({
    id: instanceId,
    port: 0,
    meta: {
      machine: identity.name,
      user: safeUser(),
      avatar: initialAvatar,
      profile: process.env.DSH_PROFILE ?? "",
      version: VERSION,
      // 认领指纹：对端 state.json 丢了/插件重装时，靠它认出"这是同一台物理机"，
      // 从而立刻顶掉旧记录而不是多出一条重名。见 lib/identity.js 里
      // 为什么不用 MAC 当身份（多网卡 / 随机 MAC / Android 拿不到）。
      fingerprint: machineFingerprint(),
    },
    intervalMs: config.announceIntervalMs,
    ttlMs: config.peerTtlMs,
    // 手工指定的对外地址（空 = 自动探测）。Android/proot 上网卡信息可能不可靠，
    // 这个值进 netinfo 的 config 分支，优先级最高。
    advertiseAddress: config.advertiseAddress ?? "",
  });
  // 让发送路径能回报端点成败（见 peerFetch）
  activeDiscovery = discovery;
  discovery.on("diagnostic", (m) => warn(m));
  discovery.on("change", () => {
    try {
      ctx.emit?.("mesh/peers-changed", discovery.peers());
    } catch {
      /* 没有监听者 */
    }
  });

  // ── 机器列表的持久化 ──
  //
  // 重启后不必干等组播/扫描重新发现：先把上次见过的机器按「离线但已知地址」
  // 放回来（restore 保留原 lastSeen，不会假装在线）。离线机器尤其需要它 ——
  // 对端关机时永远等不到重新发现，页面就会一直是空的。
  {
    const snap = loadPeerSnapshot(stateDir());
    if (snap.peers.length > 0) {
      const restored = discovery.restore(snap.peers);
      if (restored > 0) {
        log(
          `已恢复 ${restored} 台上次见过的机器（离线，重新发现后转为在线）` +
            (snap.savedAt ? `，快照时间 ${new Date(snap.savedAt).toISOString()}` : ""),
        );
      }
    }
  }
  let peerSnapshotTimer = null;
  const schedulePeerSnapshot = () => {
    if (peerSnapshotTimer) return;
    peerSnapshotTimer = setTimeout(() => {
      peerSnapshotTimer = null;
      savePeerSnapshot(stateDir(), discovery.peers());
    }, 2000);
    peerSnapshotTimer.unref?.();
  };
  discovery.on("change", schedulePeerSnapshot);

  // ── USB/adb 传输（P1.5，默认关闭）──
  //
  // 桌面把手机插 USB 时，走 adb forward 的 127.0.0.1 隧道发现/派发手机 mesh，
  // 与局域网/tsnet 并列。默认 usbEnabled=false → 不创建、不探测、零行为变化。
  // 端点注册全部经 discovery.note()：channel=`usb:<serial>`，同一台手机在
  // LAN 与 USB 上会合并成同一个 peer 的多端点（不会造第二个设备条目）。
  const usbWiring = createUsbWiring({
    config,
    discovery,
    log,
    warn,
    createTransport: createUsbTransport,
  });
  if (usbWiring.enabled) {
    // 卸载/热重载即清定时器；forward 只删本模块自己建的（用户手工建的保留）
    ctx.effect(() => () => usbWiring.stop());
    log(`USB 传输已启用（adb=${config.usbAdbPath || "PATH"}，轮询 ${config.usbPollMs}ms），等待 HTTP 服务就绪后启动`);
  } else {
    log("USB 传输未启用（usbEnabled=false）");
  }

  // ── 能力采集（Placement 步骤 ①）──
  //
  // 尽早启动：采集是异步的、绝不阻塞启动（首轮可能要等 GPU 探测 ~3.5s）。
  // 采集结果**缓存**在 capabilities.js 里，心跳只重复携带缓存值 ——
  // 每 5 秒 spawn 9 个进程是不可接受的。
  //
  // 采完立刻重播一次心跳，对端不必等下一个周期。注意这里**不写 #meta**：
  // selfRecord() 直接读缓存，能力只有一个数据源（见 discovery.js 里的说明）。
  ctx.effect(() =>
    startCapabilities((caps) => {
      const found = summarizeCapabilities(caps) || "（未探测到运行时）";
      log(`能力采集完成：${found}`);
      // 探测失败必须**说出原因**，否则"机器忙导致超时"和"确实没装"在数据上
      // 长得一模一样，Placement 会把能跑的机器排除掉。实测就是被这个坑到：
      // dev 实例报"什么运行时都没有"，查了半天才发现是探测本身没成功。
      const failed = Object.entries(caps.probeErrors ?? {});
      if (failed.length > 0) {
        warn(
          `能力探测有 ${failed.length} 项未成功：${failed.map(([k, v]) => `${k}=${v}`).join(", ")}` +
            `${caps.runtimesIncomplete ? "（含「不确定」项，这份名片不能用来断言「没有某运行时」）" : ""}\n` +
            `  探测用 PATH=${augmentedPath()}`,
        );
      }
      discovery.announceNow();
    }, { refreshMs: CAPABILITY_REFRESH_MS, hints: config.workspaceRoot ? [config.workspaceRoot] : [] }),
  );

  // 入站唤醒的"能力位"：服务齐备后由 setupInbound 置位
  const waker = { ready: false, ctx: undefined };

  /** 诊断块：进程自述版本 / 磁盘版本 / 入口 mtime / 安全字段的配置 / 能力摘要 / 网络探测。 */
  const diagnosticsPayload = () => ({
    ...buildDiagnostics({
      version: VERSION,
      packageVersion: DISK_VERSION,
      entry: ENTRY_INFO.path,
      entryMtimeMs: ENTRY_INFO.mtimeMs,
      startedAt: PROCESS_STARTED_AT,
      machine: identity.name,
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      config,
      capabilities: currentCapabilities(),
      // P1.5：USB/adb 传输状态（detail=true 带 devicePort/forwards/skipped；
      // 数据已在 createUsbWiring().diag() 里脱敏，不含 adb 路径/错误原文）。
      usb: usbWiring.diag({ detail: true }),
    }),
    // P0：地址与 MAC 的探测过程必须可查（source/errors），不能只给一个结论。
    net: netSummary(collectNetInfo()),
    // P1：dsh-go 环境识别 / sidecar 资产选择 / 入站权限来源，全部可查。
    dshGo: dshGoSummary(),
    sidecarPlatform: sidecarPlatformValue(config),
    sidecarTarget: describeSidecarTarget(),
    inboundPermissionPreset: (() => {
      try {
        return describeInboundPermissionPreset({ config, task: { transport: "lan" }, dshGo: isDshGo() });
      } catch {
        return { value: "", source: "none" };
      }
    })(),
  });

  // 1) 先起对端 HTTP（拿到真实端口），再开始发现
  startPeerServer(ctx, { config, discovery, inbound, outbound, log, warn, waker, threadState, capFor, capOverrides, throttled, onHistoryChange: scheduleHistorySave, diagnostics: diagnosticsPayload, usbStatus: () => usbWiring.diag() })
    .then(async (port) => {
      discovery.setPort(port);

      // 始终 start：sweep（离线判定）在里面，与组播无关。
      // 关掉组播只影响被动发现，主动扫描 / ping 仍会用同一个注册表。
      discovery.start({ multicast: config.useMulticast !== false });
      if (config.useMulticast !== false) {
        discovery.announceNow();
      } else {
        log("已关闭组播，仅使用主动扫描 + ping");
      }

      // 地址探测结果必须在启动日志里可见：Android/proot 上"没地址"和"地址探不到"
      // 是两件完全不同的事，日志里不写来源就永远只能靠猜（AGENTS.md 硬约束 1）。
      const bootNet = netSummary(discovery.netInfo());
      log(
        `已启动 machine=${identity.name}（来源 ${identity.source}）` +
          ` 文件搬运 nonce=${FILE_TRANSFER_NONCE}` +
        ` 地址=${preferredAddress()}:${port}（来源 ${bootNet.source}，MAC ${bootNet.macsAvailable ? "可用" : "不可用"}）` +
          ` 实例=${instanceId} 配对要求=${config.requirePairing ? "开" : "关"}`,
      );
      if (bootNet.errors.length > 0) {
        warn(`地址探测有 ${bootNet.errors.length} 项未成功：${bootNet.errors.map((e) => `${e.source}=${e.code}`).join(", ")}`);
      }
      const staticPeers = peerHostsFromSpecs(config.staticPeers ?? []);
      if (staticPeers.length > 0) {
        log(`静态对端 ${staticPeers.length} 个：${staticPeers.join(", ")}（并入扫描候选，不改变零配置发现）`);
      }

      // USB/adb 传输：HTTP 服务已就绪后启动首轮轮询（设计锚点 4）。
      // 失败只记 warning，不影响局域网/tsnet —— 三条发现路径互相独立。
      if (usbWiring.enabled) {
        usbWiring
          .start()
          .then((st) => {
            const d = usbWiring.diag();
            const devices = d?.devices ?? (Array.isArray(st?.devices) ? st.devices.length : 0);
            if (d?.available) {
              log(`USB 传输已启动：adb ${d.adbVersion || "?"}，可用设备 ${devices} 台，端点 ${d.endpoints} 个（轮询 ${config.usbPollMs}ms）`);
            } else {
              // ENOENT = 没装 adb，不是"没有手机"；原样带出 reason
              warn(`USB 传输不可用（${d?.reason || st?.reason || "UNKNOWN"}）：${config.usbAdbPath || "adb"} —— 不影响局域网/tsnet 发现`);
            }
          })
          .catch(() => {});
      }

      // 主动发现 + 保活
      const stop = { aborted: false };
      ctx.effect(() => () => {
        stop.aborted = true;
      });

      // 互联网自组网：与局域网并行的第二条发现路径，功能同等级。
      // 任何一步失败都只影响对应通道 —— 局域网发现照常工作，这是硬要求。
      //
      // 多 tailnet：每条启用的通道各起一个 sidecar（串行启动，避免并发争用
      // 二进制下载）；一条失败不影响其它条，也不影响局域网。
      const tailnetChannels = effectiveTailnetChannels(config).filter((c) => c.enabled);
      if (tailnetChannels.length > 0) {
        ctx.effect(() => () => {
          for (const node of tailnetNodes.values()) node.stop().catch(() => {});
          tailnetNodes.clear();
        });

        (async () => {
          for (const channel of tailnetChannels) {
            if (stop.aborted) return;
            try {
              const { node, reused } = await startTailnetChannel(channel, {
                config,
                discovery,
                log,
                warn,
                machineName: identity.name,
              });
              const st = node.status();
              log(
                `通道「${channel.label}」已启动：节点=${node.hostname} tailnet=${st.selfIpv4 || "待登录"}` +
                  `${reused ? "（复用已有 sidecar）" : ""}${st.authUrl ? ` 授权链接=${st.authUrl}` : ""}`,
              );
            } catch (err) {
              warn(`通道「${channel.label}」启动失败（局域网与其它通道不受影响）：${err?.message ?? err}`);
            }
          }
          if (stop.aborted) return;
          // 所有通道都起来之后再扫一轮，让 tailnet 设备尽快进列表
          await runScan({ discovery, config, log, warn, signal: stop, reason: "tailnet 启动扫描" });
        })().catch((err) => warn(`tailnet 启动扫描失败（不影响发现）：${err?.message ?? err}`));
      } else {
        log("互联网自组网未启用（没有启用的 tailnet 通道）");
      }

      if (config.scanOnStart) {
        // 启动扫描常常抢在对方起来之前跑完，所以没找到就退避重试几次。
        // 这直接决定"刚装好能不能自动发现"，值得多试几下。
        const delays = [0, 8000, 20000, 45000];
        (async () => {
          for (let i = 0; i < delays.length; i += 1) {
            if (stop.aborted) return;
            if (delays[i] > 0) await sleep(delays[i]);
            if (stop.aborted) return;
            await runScan({ discovery, config, log, warn, signal: stop, reason: `启动扫描#${i + 1}` });
            if (discovery.peers().length > 0) return; // 找到了就不再重试
          }
          log("启动扫描未发现对端；之后靠组播与周期扫描继续尝试");
        })().catch(() => {});
      }

      if (config.scanIntervalMs > 0) {
        const t = setInterval(
          () => runScan({ discovery, config, log, warn, signal: stop, reason: "周期扫描" }).catch(() => {}),
          config.scanIntervalMs,
        );
        t.unref?.();
        ctx.effect(() => () => clearInterval(t));
      }

      if (config.pingIntervalMs > 0) {
        const t = setInterval(
          () => pingKnownPeers({ discovery, config, warn }).catch(() => {}),
          config.pingIntervalMs,
        );
        t.unref?.();
        ctx.effect(() => () => clearInterval(t));
      }
    })
    .catch((err) => warn(`对端服务启动失败，发现功能未启用: ${err?.message ?? err}`));

  // 2) 入站唤醒：注册一次 webhook 规则，之后每个任务只 dispatch
  setupInbound(ctx, config, log, warn, waker);

  // 3) agent 工具
  registerTools(ctx, { discovery, config, inbound, outbound, log, warn, threadState, hostDispatched, onHistoryChange: scheduleHistorySave });

  // 4) UI 接口
  registerUiRoutes(ctx, { discovery, config, identity, inbound, outbound, log, warn, threadState, hostDispatched, capFor, capOverrides, throttled, waker, onHistoryChange: scheduleHistorySave, diagnostics: diagnosticsPayload });

  ctx.effect(() => () => {
    discovery.stop();
    log("已停止");
  });
}

function machineOf(discovery) {
  return discovery.selfRecord().machine;
}

/**
 * 对端的系统身份，单行文本（mesh_peers 工具用）。
 * 新对端有结构化 osInfo；老对端只有 os 字符串，原样回退。
 */
function osLine(peer) {
  const info = peer?.osInfo;
  if (!info) return peer?.os || "?";
  const label = [info.name, info.version].filter(Boolean).join(" ") || peer?.os || "?";
  const extra = [info.arch, info.distro, info.desktop].filter(Boolean).join(" / ");
  return extra ? `${label} (${extra})` : label;
}

/** 一台机器的全部系统（宿主机 + WSL 等），单行文本。 */
function systemsLine(peer) {
  const list = Array.isArray(peer?.systems) && peer.systems.length ? peer.systems : null;
  if (!list) return osLine(peer);
  return list
    .map((s) => {
      const label = [s.name, s.version].filter(Boolean).join(" ") || s.platform || "?";
      const extra = [s.kind === "wsl" ? "WSL" : "", s.distro, s.desktop, s.arch].filter(Boolean).join("/");
      return extra ? `${label} (${extra})` : label;
    })
    .join(" + ");
}

/**
 * 把对端的能力名片渲染成几行文本（mesh_peers 工具用）。
 * 渲染逻辑在 capabilities.js 里（可单测），这里只做转发。
 */
function capabilityLine(peer) {
  return describePeerCapabilities(peer);
}

/**
 * 按"机器名 / 实例 id / ip:port"查找对端，返回**所有**匹配。
 * 名字是用户手填的，可能重复，所以调用方必须处理多匹配的情况 ——
 * 随便挑一台会把任务派到错的机器上。
 */
function findPeersByName(discovery, name) {
  const q = String(name ?? "").trim();
  if (!q) return [];
  return discovery.peers().filter(
    (p) => p.machine === q || p.id === q || `${p.host}:${p.port}` === q,
  );
}

// ───────────────────────── 入站唤醒（自包含） ─────────────────────────

/**
 * 入站唤醒所需的官方服务。
 *
 * 这里刻意**不复用 @deepseek-ai/dsh-webhook**：那是个独立插件，桌面 profile 默认不启用，
 * 靠补丁替用户插一行会带来两个问题 ——
 *   1. 用户看到"装一个插件却多出两行"，困惑
 *   2. 万一它已经被启用（比如以后装了 GitHub webhook 插件），
 *      cordis 的 provide 遇到重名会直接抛错，且那是在它的构造函数里，本插件的安全网拦不住
 * 所以这里按官方 createWebhookSession 的做法自己走一遍，插件真正做到自包含。
 */
const WAKE_SERVICES = [
  "agents",
  "agentPresets",
  "permissionPresets",
  "sessionTitle",
  "workspaceRegistry",
  "agentDefaultModel",
];

/**
 * 入站任务该用哪个权限 preset。
 *
 * 解析逻辑抽到 `lib/inbound-preset.js`（纯函数，可离线单测）：dsh-go 覆盖 >
 * tailnet 收紧 > 默认。这里只负责把"本机是不是 dsh-go"喂进去。
 *
 * 默认两者完全一致（tailnet 与局域网功能同等级）。留出 tailnet 开关是因为信任
 * 边界不同 —— 进局域网要物理接入，进 tailnet 只要拿到授权码；而一旦进网，
 * 对方就能对你所有机器下 mesh_run。只想收紧互联网那一侧就填它。
 */
function permissionPresetFor(config, task) {
  return resolveInboundPermissionPreset({ config, task, dshGo: isDshGo() });
}

/** 实验性远程控制（对端 Web / SSH）开关；所有远程入口都必须先过这里。 */
function experimentalRemoteEnabled(config) {
  return !!config && config.experimentalRemoteControl === true;
}

/** 探测服务是否齐备；齐了就置位 waker，入站任务才能真唤醒 agent。 */
function setupInbound(ctx, config, log, warn, waker) {
  ctx.inject(WAKE_SERVICES, (scoped) => {
    const missing = WAKE_SERVICES.filter((n) => {
      const svc = scoped[n] ?? scoped.get?.(n);
      return svc === undefined || svc === null;
    });
    if (missing.length > 0) {
      // 记下来，稍后写进任务记录，让对端能远程读到到底缺哪个服务
      waker.missing = missing;
      warn(`入站唤醒不可用（缺少服务 ${missing.join(", ")}）；任务仍会进收件箱，但不会自动开跑`);
      return;
    }
    waker.ready = true;
    waker.ctx = scoped;
    // 提前校验**生效值**（而不是只校验 config.permissionPreset）：dsh-go 上可能
    // 走 permissionPresetOnDshGo，校验错对象等于没校验，要等收到任务才炸。
    try {
      const inbound = describeInboundPermissionPreset({ config, task: { transport: "lan" }, dshGo: isDshGo() });
      const tsnet = describeInboundPermissionPreset({ config, task: { transport: "tsnet" }, dshGo: isDshGo() });
      scoped.permissionPresets.resolve(inbound.value);
      if (tsnet.value !== inbound.value) scoped.permissionPresets.resolve(tsnet.value);
      const dshGoNote = [];
      if (isDshGo()) {
        dshGoNote.push(
          inbound.source === "dsh-go"
            ? "dsh-go 环境，已启用 permissionPresetOnDshGo 覆盖"
            : inbound.source === "dsh-go-default"
              ? `dsh-go 环境，未显式配置 → 使用内置默认 ${inbound.value}（proot 无沙箱后端）`
              : "dsh-go 环境但用户显式指定了权限 preset —— 若为 workspace-write 会停在「待确认」",
        );
      }
      log(
        `入站唤醒已就绪（自包含实现，权限 preset=${inbound.value}（来源 ${inbound.source}）` +
          (tsnet.value !== inbound.value ? `，tailnet=${tsnet.value}（来源 ${tsnet.source}）` : "，tailnet 同局域网") +
          (dshGoNote.length > 0 ? `；${dshGoNote.join("；")}` : "") +
          "）",
      );
    } catch (err) {
      waker.ready = false;
      warn(`入站权限 preset 无效，入站唤醒已停用：${err?.message ?? err}`);
    }
  });
}

/**
 * 建一个会话并让 agent 开跑 —— 等价于官方 webhook runtime 的 createWebhookSession，
 * 但用本插件自己的会话前缀，便于在会话列表里一眼认出来源。
 */
async function wakeAgent(waker, config, task, warn = () => {}) {
  const c = waker.ctx;
  const preset = await c.agentPresets.resolve(config.agentPreset);
  // standingKeyFor 不是所有 DSH 版本都有。
  //
  // 实测踩过：Android/Termux 那台报 "c.agentPresets.standingKeyFor is not a
  // function"，于是**所有入站任务永远 dispatch-failed**，而当时状态里只记了
  // status、没记原因，查了好几轮才定位。它是给 preset 取"常驻键"的；真正把
  // preset 挂到会话上的是后面的 mount()，所以缺失时跳过即可，不该让整条入站
  // 唤醒链断掉。
  if (typeof c.agentPresets.standingKeyFor === "function") {
    await c.agentPresets.standingKeyFor(preset.id);
  } else {
    warn(`本机 DSH 的 agentPresets 没有 standingKeyFor（版本较旧？），已跳过；继续尝试建会话`);
  }

  const sessionId = brandString(`mesh-${randomUUID()}`);
  const workspace = await c.workspaceRegistry.create(resolveWorkspace(config, sessionId));
  const selection = c.agentDefaultModel.currentSelection();

  const handle = await c.agents.create({
    sessionId,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
    setup: async (agentCtx) => {
      await c.agentPresets.mount(agentCtx, preset.id);
    },
  });

  let attached = false;
  try {
    await workspace.attachSession(sessionId);
    attached = true;
    c.permissionPresets.set(handle.agent.session, permissionPresetFor(config, task));
    c.sessionTitle.rename(handle.agent.session, `Mesh 任务 ${task.id.slice(0, 14)} ← ${task.from}`);
    handle.agent.followup(
      createUserMessage({
        content: [{ type: "text", text: buildPrompt(task) }],
        source: {
          kind: "webhook",
          provider: RULE_KIND,
          source: task.from,
          deliveryId: task.id,
          ruleId: RULE_ID,
          form: "notice",
          summary: `mesh task from ${task.from}`,
        },
      }),
    );
  } catch (err) {
    // 尽力回滚，别留下半个会话
    if (attached) {
      try {
        await workspace.detachSession(sessionId);
      } catch {
        /* 回滚失败不覆盖原始错误 */
      }
    }
    try {
      await handle.dispose();
    } catch {
      /* 同上 */
    }
    throw err;
  }
  return sessionId;
}

/**
 * 只建一个**空**会话（不注入任何提示、不启动一轮 agent），供「派发时预建会话」用。
 *
 * 为什么要预建：页面手动派发时，回执需要一个已存在的会话可以注入。只靠 UI 传
 * 当前会话 id 不够 —— 面板拿不到 selection 时那个 id 是空的，绑定就被整段跳过，
 * 回执只能新开一个会话（真机反馈「mac 没有预先生成会话」）。
 *
 * 为什么不直接复用 wakeAgent：那会在派发时就注入一条提示、立刻烧一轮 token。
 * 预建只需要「会话存在且可注入」，等回执真的回来了再让 agent 开跑。
 */
async function createIdleSession(waker, config, task, warn = () => {}, announce = null) {
  const c = waker.ctx;
  const preset = await c.agentPresets.resolve(config.agentPreset);
  if (typeof c.agentPresets.standingKeyFor === "function") {
    await c.agentPresets.standingKeyFor(preset.id);
  }
  const sessionId = brandString(`mesh-${randomUUID()}`);
  const workspace = await c.workspaceRegistry.create(resolveWorkspace(config, sessionId));
  const selection = c.agentDefaultModel.currentSelection();
  const handle = await c.agents.create({
    sessionId,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
    setup: async (agentCtx) => {
      await c.agentPresets.mount(agentCtx, preset.id);
    },
  });
  let attached = false;
  try {
    await workspace.attachSession(sessionId);
    attached = true;
    c.permissionPresets.set(handle.agent.session, permissionPresetFor(config, task));
    c.sessionTitle.rename(handle.agent.session, `Mesh 派发 ${String(task.thread || task.id).slice(0, 16)} → ${task.toMachine || "对端"}`);
    if (announce?.text) {
      // 消息必须可见，而可见的文字 agent 也读得到 —— DSH 的用户气泡是纯文本
      // 渲染（white-space: pre-wrap），没有 markdown/注释可以藏字；而
      // session.append 无论在建会话后还是 setup 里写，都会让 agent loop 跑起来
      // （setup 里写甚至会让 create 直接失败）。
      // 所以调用方在正文末尾拼一行极短说明：已派发、等待回执、无需在本机执行。
      // 少了这行，agent 会把原文当成本地任务直接执行（真机反馈）。
      handle.agent.followup(
        createUserMessage({ content: [{ type: "text", text: announce.text }], source: { kind: "user" } }),
      );
    }
  } catch (err) {
    if (attached) {
      try {
        await workspace.detachSession(sessionId);
      } catch {
        /* 回滚失败不覆盖原始错误 */
      }
    }
    try {
      await handle.dispose();
    } catch {
      /* 同上 */
    }
    throw err;
  }
  return sessionId;
}

/**
 * 把一条入站任务喂进一个**已存在但已结束**的会话，而不是新建一个。
 *
 * 为什么需要：`liveSession()` 看的是 DSH 内存里的 agent 注册表，重启 DSH 或
 * 会话空闲被回收之后，注册表里就没有它了 —— 哪怕磁盘上的对话记录完好无损。
 * 原来的做法是直接 `agents.create` 一个全新的 `mesh-<uuid>`，于是每重启一次，
 * 所有跨机对话线都在下一次回传时静默断开（上下文还在旧会话里，新会话从零开始）。
 *
 * DSH 本身支持按 id 从持久化日志恢复会话：`agents.resume({ resumeSessionId })`。
 * 这里就用它把旧会话接回来再注入。
 *
 * 失败（版本太旧没有 resume、会话记录被删、没配 sessionPersistence）时返回 null，
 * 由调用方回退到新建会话 —— 恢复是**尽力而为**，不能因为它挂了就让回传丢失。
 */
async function resumeAgent(waker, config, task, sessionId, warn = () => {}) {
  const c = waker.ctx;
  if (typeof c.agents?.resume !== "function") {
    warn("本机 DSH 的 agents 没有 resume，无法恢复已结束的会话；将新建会话");
    return null;
  }
  const preset = await c.agentPresets.resolve(config.agentPreset);
  if (typeof c.agentPresets.standingKeyFor === "function") {
    await c.agentPresets.standingKeyFor(preset.id);
  }
  const selection = c.agentDefaultModel.currentSelection();
  const handle = await c.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
    setup: async (agentCtx) => {
      await c.agentPresets.mount(agentCtx, preset.id);
    },
  });
  try {
    c.permissionPresets.set(handle.agent.session, permissionPresetFor(config, task));
    // 恢复的会话**不重命名**：原标题承载着"这场对话原来是什么"，改掉就丢了这段历史。
    handle.agent.followup(
      createUserMessage({
        content: [{ type: "text", text: buildPrompt(task) }],
        source: {
          kind: "webhook",
          provider: RULE_KIND,
          source: task.from,
          deliveryId: task.id,
          ruleId: RULE_ID,
          form: "notice",
          summary: `mesh task from ${task.from} (resumed)`,
        },
      }),
    );
  } catch (err) {
    try {
      await handle.dispose();
    } catch {
      /* 回滚失败不覆盖原始错误 */
    }
    throw err;
  }
  return sessionId;
}

/**
 * 唤醒会话：能恢复就恢复，恢复不了才新建。
 *
 * 优先级是「接续旧上下文」高于「开一个干净的新会话」—— 后者会让用户丢掉
 * 整场对话的记忆，而这个 plugin 的全部价值就在于把上下文带过去。
 */
async function wakeAgentOrResume(waker, config, task, resumeSessionId, warn = () => {}) {
  if (resumeSessionId && task?.newSession !== true) {
    try {
      const resumed = await resumeAgent(waker, config, task, resumeSessionId, warn);
      if (resumed) return resumed;
    } catch (err) {
      // 恢复失败不该让这条回传丢掉：退回新建，并把原因记下来。
      warn(`恢复会话 ${String(resumeSessionId).slice(0, 20)}… 失败，改为新建：${err?.message ?? err}`);
    }
  }
  return wakeAgent(waker, config, task, warn);
}

function resolveWorkspace(config, sessionId) {
  if (config.workspaceRoot && isAbsolute(config.workspaceRoot)) return config.workspaceRoot;
  // 每个 profile 一个 mesh-receive-task 工作区：既按实例隔离，又不会按会话爆炸。
  const dir = receiveWorkspaceDir(meshRoot());
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* 交给 workspaceRegistry.create 报错 */
  }
  return dir;
}


/**
 * 只值一条回执、不值得开一个 agent 会话的内容。
 *
 * 挡的是"礼貌性往返"：ping / ack / 收到 / 好的 / 谢谢…… 这类消息一旦被
 * 当成任务开跑，就会走完一整套探索 + 回派，而对端又会回一句 ack —— 循环
 * 就是这么起来的。注意这里只判"整条正文就是一个寒暄词"，不误伤正文本体。
 */
const NOTICE_ONLY = /^\s*(?:\[?(?:ping|pong|ack|ok|roger|hello|hi|hey)\]?|收到|好的|好|了解|明白|在吗|谢谢|多谢|辛苦了|确认|已阅)\s*[.!。！？~]*\s*$/i;

/**
 * 判断一条入站任务该不该唤醒 agent。
 *
 * `kind` 让调用方能区分"为什么被挡"：只有 `cap` 值得提示用户去提高上限，
 * 寒暄/冷却/过短都是正常拦截，不该打扰人。
 *
 * @param {(thread: string) => number} capFor 取该 thread 的生效上限（含用户手动提高的覆盖值）
 * @returns {{wake: true} | {wake: false, kind: string, reason: string}}
 */
function classifyInbound(task, threadState, config, now, capFor, { canInject = false } = {}) {
  const body = String(task.task ?? "").trim();

  // 1) 显式豁免：发送方声明"这条只回执，别开跑"
  if (task.noWake === true) return { wake: false, kind: "noWake", reason: "发送方标记 noWake" };

  // 2) 内容闸门：太短或纯寒暄
  const minChars = config.minTaskChars ?? 24;
  if (body.length < minChars) {
    return { wake: false, kind: "short", reason: `正文仅 ${body.length} 字符 < minTaskChars(${minChars})` };
  }
  if (NOTICE_ONLY.test(body)) return { wake: false, kind: "notice", reason: "纯寒暄/回执内容" };

  // 3) 限速：同一**会话**在滑动窗口内的自动唤醒次数（不是终身配额）
  //
  // 键用 conversationKey 而不是裸 thread：限速是按这个键记账的，两个来源用
  // 同名 thread 会互相误伤（对方刷它的 "deploy"，把你的 "deploy" 一起限掉）。
  const key = conversationKey(task);
  if (!key) return { wake: true }; // 没 thread 的一次性任务，不参与限速

  const st = threadState.get(key);
  if (!st) return { wake: true };

  const maxWakes = typeof capFor === "function" ? capFor(key) : config.maxWakesPerThread ?? 0;
  if (maxWakes > 0) {
    const windowMs = config.threadWindowMs ?? 3600000;
    const since = now - windowMs;
    const inWindow = (st.wakesAt ?? []).filter((t) => t > since).length;
    if (inWindow >= maxWakes) {
      const oldest = Math.min(...st.wakesAt.filter((t) => t > since));
      const freeIn = Math.max(0, Math.ceil((oldest + windowMs - now) / 1000));
      return {
        wake: false,
        kind: "cap",
        reason: `会话 ${key} 近 ${Math.round(windowMs / 60000)} 分钟内已唤醒 ${inWindow} 次（上限 ${maxWakes}），约 ${freeIn}s 后释放`,
      };
    }
  }

  // 4) 节流：同一会话两次唤醒之间的冷却，管突发
  //
  // **只在需要新建会话时生效**。注入已有会话是便宜的（不建会话、不放大成本），
  // 而冷却要防的"建会话风暴"已由 pendingByConv 的排队锁接管（突发只会建一个
  // 会话，其余排队后被排空进去）。所以能注入时空过冷却。
  //
  // 不改的话会出现实测到的问题：人在 20 秒内对同一场对话连发两条后续，
  // 第二条被静默吞掉（status='noted-only'、routeDecision=None）。
  // 失控互刷仍由会话级上限 maxWakesPerThread 挡住 —— 那才是它的职责。
  const cooldown = canInject ? 0 : (config.threadCooldownMs ?? 0);
  const lastWakeAt = st.wakesAt?.length ? Math.max(...st.wakesAt) : 0;
  if (cooldown > 0 && lastWakeAt && now - lastWakeAt < cooldown) {
    const wait = Math.ceil((cooldown - (now - lastWakeAt)) / 1000);
    return { wake: false, kind: "cooldown", reason: `会话 ${key} 冷却中，还需 ${wait}s` };
  }

  return { wake: true };
}

/**
 * 收到对端任务：会话键命中且会话仍活跃就复用，否则新建，
 * 最后才新建会话。复用是为了避免"每条消息都从零重新探索上下文"。
 */
function handleInboundTask(ctx, task, inbound, config, log, warn, waker, threadState, capFor, throttled, onHistoryChange, outbound) {
  // ── 这条入站是「回执」还是「新任务」？ ──
  //
  // 判据：同一台机器 + 同一个 thread 上，我们确实往外派过任务。
  // 是回执的话，提示词要明确禁止再回派，否则两边会互相回执形成循环
  // （2026-10-21 手动派发实测：一轮几十条）。
  if (task?.thread) {
    const from = String(task.fromMachine || String(task.from || "").split("/")[0] || "");
    task.isReply = (outbound ?? []).some(
      (o) => String(o.toMachine || "") === from && String(o.thread || "") === String(task.thread),
    );
  }
  const rec = inbound.find((t) => t.id === task.id);
  // 记下"回信地址"，与"本机用哪个会话处理"是两件事。对端可以 GET
  // /mesh/v1/tasks 读到它，调试时能看清结果该送回哪里。
  if (rec) rec.replyTo = replyTarget(task);

  // 会话键：把发送方机器名揉进去，避免不同来源的同名 thread 撞车。
  // **必须在函数开头声明** —— 下面的 canInject 判断在闸门之前就要用到它。
  const key = conversationKey(task);

  /** 本机某个会话是否还活着且可注入；不可用返回 null。 */
  const liveSession = (sessionId) => {
    if (!sessionId) return null;
    try {
      const live = ctx.get?.("agents")?.get?.(sessionId);
      return live && typeof live.followup === "function" ? live : null;
    } catch {
      return null;
    }
  };
  const now = Date.now();

  // 闸门：先判断值不值得开跑，再决定走哪条路径
  // 先判断"能不能注入已有会话"：能的话冷却不适用（见 classifyInbound 的说明）
  const knownSessionId = key ? (threadState.get(key)?.sessionId ?? "") : "";
  // 发送方显式要求新起会话时，"能注入"对它是无效的 —— 它就是要一个新的。
  // 冷却对它照常生效（因为确实要建会话）。
  const canInject = task.newSession !== true && !!liveSession(knownSessionId);

  const verdict = classifyInbound(task, threadState, config, now, capFor, { canInject });
  if (!verdict.wake) {
    if (rec) {
      rec.status = verdict.kind === "cap" ? "throttled" : "noted-only";
      onHistoryChange?.();
      // 原因必须写出来。之前这里什么都不记，于是 status='noted-only' 时
      // routeDecision 是 None —— 看不出为什么没处理，又回到"只能靠猜"的老路
      rec.routeDecision = `未唤醒：${verdict.reason}`;
    }
    // 只有"撞上限"值得提示用户去提高上限；寒暄/冷却/过短都是正常拦截
    if (verdict.kind === "cap") {
      const k = String(task.thread || "").trim();
      const entry = throttled.get(k) ?? { taskIds: [], firstAt: now, lastAt: now, cap: capFor(key), key };
      // The ledger and the cap override are keyed by conversationKey (machine +
      // thread), not by the bare thread label the UI displays. Remember it so
      // "/mesh/api/throttle/raise" can write the override under the right key.
      entry.key = key || entry.key || "";
      entry.taskIds.push(task.id);
      entry.lastAt = now;
      entry.cap = capFor(entry.key || k);
      throttled.set(k, entry);
      warn(`任务 ${task.id} 因限速未唤醒（${verdict.reason}）；可在 Mesh 页面提高 ${k} 的上限`);
    } else {
      log(`任务 ${task.id} 仅入箱未唤醒（${verdict.reason}）`);
    }
    return;
  }

  // 放行了：这个 thread 不再处于"被限速"状态
  if (task.thread && throttled.has(String(task.thread).trim())) throttled.delete(String(task.thread).trim());

  // 注：会话键 key 已提到函数开头声明 —— 它现在被闸门之前的 canInject 判断用到，
  // 留在原位会形成 TDZ（const 在声明前使用 → ReferenceError，而且会被入站处理的
  // try/catch 吞掉，任务永远停在 accepted，属于静默失败）。
  /**
   * 记一次唤醒：追加时间戳并剪掉窗口外的旧记录，然后落盘。
   * 只留窗口内的点，账本不会无限增长。
   */
  const noteWake = () => {
    if (!key) return;
    const windowMs = config.threadWindowMs ?? 3600000;
    const st = threadState.get(key) ?? { wakesAt: [], sessionId: "" };
    const cutoff = now - windowMs;
    st.wakesAt = [...st.wakesAt.filter((t) => t > cutoff), now];
    threadState.set(key, st);
    saveThreads(threadState);
  };

  /**
   * 把一个任务注入本机某个仍在运行的会话。
   *
   * 泛化成收 targetTask/targetRec（而不是闭包捕外层 task），因为排空队列时要
   * 把**排队中的那些**消息依次注入同一个会话。
   */
  const injectTaskInto = (sessionId, targetTask, targetRec, status, label) => {
    const live = liveSession(sessionId);
    if (!live) return false;
    try {
      live.followup(
        createUserMessage({
          content: [{ type: "text", text: buildPrompt(targetTask) }],
          source: {
            kind: "webhook",
            provider: RULE_KIND,
            source: targetTask.from,
            deliveryId: targetTask.id,
            ruleId: RULE_ID,
            form: "notice",
          },
        }),
      );
      if (targetRec) {
        targetRec.status = status;
        onHistoryChange?.();
        // 决策留痕：对端可以 GET /mesh/v1/tasks 读到"为什么这么路由"。
        // 没有这个，出问题时只能靠猜（dispatchError 那次就是这么加的）。
        targetRec.routeDecision = `${label} ${sessionId}（会话键 ${conversationKey(targetTask) || "无"}）`;
      }
      if (targetTask === task) noteWake();
      log(`任务 ${targetTask.id} 已注入${label} ${sessionId}`);
      return true;
    } catch (err) {
      warn(`注入${label} ${sessionId} 失败: ${err?.message ?? err}`);
      return false;
    }
  };

  /** 复用已有会话的简写（针对当前这条消息） */
  const injectInto = (sessionId, status, label) => injectTaskInto(sessionId, task, rec, status, `复用${label}`);

  // 路径 A：同 thread 已有活跃会话 → 复用它，保持上下文连续
  // 除非发送方显式要求新起会话（task.newSession），此时跳过复用直接建新的
  if (key && task.newSession !== true) {
    const known = threadState.get(key)?.sessionId;
    if (known && injectInto(known, "injected-thread-session", "同 thread 会话")) return;
  }

  // 路径 B 已移除 —— 原来这里是拿 `task.originSession` 去本机找活跃会话。
  //
  // 那是个**设计错误**：originSession 是**发送方**的 session id，那台机器上的
  // 会话在本机根本不存在，所以这个分支永远返回 false。它不只是死代码，还会
  // 误导人以为"可以复用对方的会话"。
  //
  // 它的正确语义是**回信地址**：结果要送回发送方的哪个会话。那件事由回派的
  // payload 承担，跟"本机用哪个会话处理"没有关系。

  // 路径 C：都没有 → 新建会话
  if (!waker?.ready) {
    if (rec) {
      rec.status = "stored-only";
      onHistoryChange?.();
      rec.routeDecision = key ? `无法新建会话（会话键 ${key}）` : "无法新建会话（无会话键）";
      // 记下原因，让对端能远程读到（GET /mesh/v1/tasks）。一台没有界面或
      // 日志访问权的机器（比如 Android/Termux）出问题，否则只能靠猜。
      rec.dispatchError = waker?.missing?.length ? `唤醒所需服务缺失：${waker.missing.join(", ")}` : "唤醒能力不可用";
    }
    warn(`任务 ${task.id} 已入收件箱，但唤醒能力不可用，未开跑`);
    return;
  }
  // ── 同一会话键的并发保护 + 背压 ──
  //
  // 建会话是异步的，两条同键消息几乎同时到达时，第二条查 threadState 仍查不到
  // （第一条还没落库），于是也去建会话 → **同一场对话被建出两个 session**。
  // 这里占位：第一条建会话期间把键占住，后来的排队等它，建好后按到达顺序排空。
  if (key) {
    const pending = pendingByConv.get(key);
    if (pending) {
      if (pending.length >= MAX_PENDING_PER_CONV) {
        // 背压：明确回"忙"，而不是无脑排队让对方以为已受理
        if (rec) {
          rec.status = "busy";
          onHistoryChange?.();
          rec.routeDecision = `会话 ${key} 积压 ${pending.length} 条（上限 ${MAX_PENDING_PER_CONV}），已背压`;
        }
        warn(`任务 ${task.id} 被背压：会话 ${key} 积压已达上限 ${MAX_PENDING_PER_CONV}`);
        return;
      }
      pending.push({ task, rec });
      if (rec) {
        rec.status = "queued-for-session";
        onHistoryChange?.();
        rec.routeDecision = `会话 ${key} 正在建会话，已排队（队内第 ${pending.length} 条）`;
      }
      log(`任务 ${task.id} 排队等待会话 ${key} 建立`);
      return;
    }
    pendingByConv.set(key, []);
  }

  noteWake();
  // 走到这里说明「能注入」不成立。若这个键绑过会话，先试着把它**恢复**回来
  // （重启 DSH / 会话被回收后，记录还在磁盘，注册表里却没有了），
  // 恢复不了再新建 —— 见 wakeAgentOrResume。
  wakeAgentOrResume(waker, config, task, knownSessionId, warn)
    .then((sessionId) => {
      if (rec) {
        rec.status = "dispatched";
        onHistoryChange?.();
        // 三分支文案要互斥：恢复成功时不能再挂「首次出现，或原会话已结束」——
        // 那句话正好与事实相反（实测时读出来自相矛盾）。
        const resumed = sessionId === knownSessionId;
        const why = resumed
          ? "重启或会话被回收后接回原上下文"
          : task.newSession === true
            ? "发送方显式要求新会话"
            : "首次出现，或原会话已结束";
        rec.routeDecision = key
          ? `${resumed ? "恢复了已结束的会话" : "新建会话"}并绑定会话键 ${key}（${why}）`
          : "新建会话（无会话键，一次性任务，用完不绑定）";
      }
      if (key) {
        const st = threadState.get(key) ?? { wakesAt: [now], sessionId: "" };
        st.sessionId = String(sessionId);
        threadState.set(key, st);
        saveThreads(threadState);
      }
      log(`任务 ${task.id} 已派发，会话 ${String(sessionId).slice(0, 20)}…`);

      // 排空队列：排队那些消息和第一条属于同一场对话，按到达顺序注入同一个会话
      const queued = pendingByConv.get(key) ?? [];
      pendingByConv.delete(key);
      let drained = 0;
      for (const item of queued) {
        if (!injectTaskInto(sessionId, item.task, item.rec, "injected-queued", "排队消息注入")) break;
        drained += 1;
      }
      if (queued.length > 0) log(`会话 ${key} 建好后注入 ${drained}/${queued.length} 条排队消息`);
      // 注不进去的（会话可能已结束）不能无声消失，明确标出来
      for (const item of queued.slice(drained)) {
        if (item.rec) {
          item.rec.status = "queued-lost";
          onHistoryChange?.();
          item.rec.routeDecision = `会话 ${key} 建好后已不可注入（会话可能已结束）`;
        }
      }
    })
    .catch((err) => {
      // 建会话失败必须释放占位，否则同键的后续消息会被永久卡在队列里
      if (key) pendingByConv.delete(key);
      if (rec) {
        rec.status = "dispatch-failed";
        onHistoryChange?.();
        // 同上：原因必须随任务记录一起能被远端读到
        rec.dispatchError = String(err?.message ?? err);
        rec.routeDecision = `${key ? `新建会话（会话键 ${key}）` : "新建会话（无会话键，一次性任务）"} → 失败`;
      }
      warn(`派发任务 ${task.id} 失败: ${err?.message ?? err}`);
    });
}

// ───────────────────────── 主动发现与保活 ─────────────────────────

/** 端点的稳定 key：`lan` / `tsnet:<通道 id>`（兼容旧端点的 `tsnet`）。 */
function endpointKeyOf(ep) {
  return String(ep?.channel ?? ep?.transport ?? "lan");
}

/**
 * 按端点健康**逐个失败切换**地发一个请求。
 *
 * 这是"多条通道绑一台设备"的实际收益：局域网不通就走某条 tailnet，一条
 * tailnet 不通还可以走另一条。以前只看 `peer.transport`（最后探测到的那个），
 * 一条通道坏掉整个对端就不可达。
 *
 * 只有**网络层失败**才切换通道：HTTP 4xx/5xx 说明端点本身是通的，换一条也
 * 一样，不该白试一遍、更不该把好端点的健康记录打坏。
 *
 * 顺带承担一半的"主动健康探测"：真正发过请求就是最好的探针，成功刷新该端点、
 * 失败累计到阈值就把它打进冷却，之后排序自然把它排到最后。
 */
async function peerFetch(peer, path, opts = {}) {
  const { timeoutMs = 20000, ...rest } = opts;
  const eps = orderedEndpoints(peer);
  if (eps.length === 0) throw new Error(`对端 ${peer?.machine ?? "?"} 没有任何已知通道`);

  const failures = [];
  for (const ep of eps) {
    // URL 必须**按这一条端点**现拼，不能由调用方用 peer.host/peer.port 预先拼好。
    //
    // peer.host/port 只是"当前选中端点"的投影值：当一个端点都不算 alive 时
    // （全在冷却、或还没验证过），投影出来是空串和 0，于是会拼出
    // `http://:0/mesh/v1/hello` —— 端点明明选对了，URL 却是坏的。
    // 实测就是这个报错：`Get "http://:0/mesh/v1/hello": lookup : no such host`。
    if (!ep.host || !ep.port) {
      failures.push(`${endpointKeyOf(ep)} 端点地址不完整（${ep.host}:${ep.port}）`);
      continue;
    }
    const url = `http://${ep.host}:${ep.port}${path}`;
    const started = Date.now();
    try {
      const res =
        ep.transport === "tsnet"
          ? await fetchViaTailnet(ep, url, { ...rest, timeoutMs })
          : await fetchViaLan(ep, url, { ...rest, timeoutMs });
      activeDiscovery?.markEndpoint(peer.id, endpointKeyOf(ep), { ok: true, rttMs: Date.now() - started });
      return res;
    } catch (err) {
      failures.push(`${endpointKeyOf(ep)}(${ep.host}:${ep.port}) ${err?.message ?? err}`);
      activeDiscovery?.markEndpoint(peer.id, endpointKeyOf(ep), { ok: false });
    }
  }
  throw new Error(`所有通道都失败 —— ${failures.join("；")}`);
}

/** 局域网直连。 */
async function fetchViaLan(ep, url, opts = {}) {
  const { timeoutMs = 20000, ...rest } = opts;
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * 经 sidecar 的用户态隧道出去。
 * 宿主机没有 TUN 设备，`fetch("http://100.x.y.z:...")` 会直接 ENETUNREACH。
 *
 * 出口选择：
 *   · 端点带通道（`tsnet:<id>`）→ 优先走那条通道的 sidecar；它不可用时再依次
 *     试其它通道（IP 本来就属于哪条 tailnet 是连通性说的，不必猜）。
 *   · 端点没有通道（对端名片里报来的候选地址）→ 依次试所有通道。
 *
 * 多条 tailnet 可能有重叠的 100.x 网段，所以"试"是唯一可靠的做法；失败的
 * 通道不会留下状态（真实健康记录由调用方 markEndpoint 写）。
 */
async function fetchViaTailnet(ep, url, opts = {}) {
  const key = endpointKeyOf(ep);
  const wantId = key.startsWith("tsnet:") ? key.slice("tsnet:".length) : "";
  const wanted = wantId ? tailnetNodes.get(wantId) : null;
  const candidates = [];
  if (wanted && wanted.phase === "running") candidates.push(wanted);
  for (const node of runningTailnetNodes()) {
    if (!candidates.includes(node)) candidates.push(node);
  }
  if (candidates.length === 0) throw new Error("tailnet 节点尚未启动");
  let lastErr = null;
  for (const node of candidates) {
    try {
      return await tailnetFetch(node, url, opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("没有可用的 tailnet 通道");
}

/**
 * 借每条 tailnet 通道的 sidecar 节点表做第二轮探测。
 *
 * 与局域网扫描刻意保持同构：拿候选地址 → 探 /mesh/v1/health → 自述记录进
 * 同一个注册表。区别是：候选地址来自 tailnet，请求必须走对应的 sidecar 隧道，
 * 且**每条通道各扫一遍** —— 一台设备可能在多个 tailnet 里，每个 tailnet 给的
 * 地址不同，端点要按通道分别记录。
 *
 * @param channelId 只扫某一条通道；省略 = 所有在跑的通道
 */
async function scanTailnet({ discovery, config, log, reason, ports, channelId = "" }) {
  const nodes = runningTailnetNodes().filter((n) => !channelId || n.channelKey === channelId);
  if (nodes.length === 0) return { scanned: 0, found: 0, channels: [] };

  // tailnet 上没有"端口先验"，但同机单实例 + 默认端口是常态，命中率很高。
  const targetPorts = [...new Set([...ports, MESH_DEFAULT_PORT])].filter((p) => Number(p) > 0);
  const probeIntervalMs = Math.max(config.pingIntervalMs, config.tsnetProbeIntervalMs ?? 60000);
  const perChannel = [];

  await Promise.all(
    nodes.map(async (node) => {
      const channel = `tsnet:${node.channelKey}`;
      const summary = { id: node.channelKey, label: node.label, scanned: 0, found: 0, error: "" };
      perChannel.push(summary);

      let peers;
      try {
        peers = await node.peersRemote();
      } catch (err) {
        summary.error = String(err?.message ?? err);
        log(`${reason}(${node.label}): 取节点表失败 —— ${summary.error}`);
        return;
      }

      // 只看在线且有 IPv4 的；自己不在 Peer 列表里，不用排除。
      const candidates = peers.filter((p) => p.online && p.ipv4);
      summary.scanned = candidates.length * targetPorts.length;
      if (candidates.length === 0) return;

      let found = 0;
      let added = 0;
      await Promise.all(
        candidates.flatMap((p) =>
          targetPorts.map(async (tp) => {
            try {
              const started = Date.now();
              const res = await tailnetFetch(node, `http://${p.ipv4}:${tp}/mesh/v1/health`, {
                timeoutMs: Math.min(4000, config.requestTimeoutMs),
              });
              if (!res.ok) return;
              const body = await res.json();
              if (body?.app !== "dsh-mesh" || !body.id) return;
              found += 1;
              // 强制记 tailnet IP：对端自述的 host 是它的局域网地址，跨互联网不可达。
              // 通道 key 必须带上：同一台设备可能同时出现在多条 tailnet 里，
              // 不区分就会互相覆盖，一条通道断了另一条也跟着消失。
              // 同时带上探测间隔与 RTT —— 漏了 interval 会让这条通道按默认 TTL(20s)
              // 判活，而它 60s 才探一次，于是探完 20 秒就"死了"、整台设备假离线。
              // 实测踩过：ok=4 fail=0 rtt=473ms 却显示 online=False。
              if (
                discovery.note(body, p.ipv4, {
                  transport: "tsnet",
                  channel,
                  port: tp,
                  rttMs: Date.now() - started,
                  probeIntervalMs,
                })
              )
                added += 1;
            } catch {
              /* 该地址上没有 DSH 节点，或端口没开 —— 正常情况，不打扰用户 */
            }
          }),
        ),
      );

      summary.found = found;
      if (found > 0) log(`${reason}(${node.label}): 命中 ${found} 台（新登记 ${added}）`);
    }),
  );

  const found = perChannel.reduce((n, c) => n + c.found, 0);
  const scanned = perChannel.reduce((n, c) => n + c.scanned, 0);
  return { scanned, found, channels: perChannel };
}

/**
 * 扫描要探的端口列表。
 *
 * 手动扫描和周期扫描**必须共用这一份**：手动扫描曾经硬编码成
 * [本机端口, 默认端口]，漏掉了 scanPorts —— 于是对端跑在非默认端口时
 * （同机多实例、或端口被占用退回随机端口），只有启动扫描能找到它，
 * 用户点「扫描 tailnet」反而找不到，看起来像功能坏了。
 * 局域网路径也一样需要它，所以做成共用的一个来源。
 */
function scanPortList(discovery, config) {
  // staticPeers 里写了端口的条目也要扫：显式地址通常就是"对端不在默认端口"的情况。
  const peerPorts = peerPortsFromSpecs(config.staticPeers ?? []);
  return [...new Set([discovery.port, MESH_DEFAULT_PORT, ...(config.scanPorts ?? []), ...peerPorts])].filter((p) => Number(p) > 0);
}

/**
 * 扫本网段的固定端口，命中即登记为对端。
 * 这是"组播被挡时"的兜底路径，也是首次连接最快的方式。
 * tailnet 是并行的第二条路径，见 scanTailnet。
 */
async function runScan({ discovery, config, log, warn, signal, reason = "扫描" }) {
  const port = discovery.port;
  if (!port) return { scanned: 0, found: 0 };
  // staticPeers 是配置点名要扫的地址，必须能进候选（网段展开可能被 limit 截断）。
  const peerHosts = peerHostsFromSpecs(config.staticPeers ?? []);
  const addresses = candidateAddresses(config.scanRanges ?? [], 1024, peerHosts);
  const ports = scanPortList(discovery, config);
  let lanFound = 0;

  if (addresses.length === 0) {
    warn(`${reason}: 没有可扫描的地址（检查 scanRanges / staticPeers 是否合法，或网卡是否存在）`);
  }
  if (addresses.length > 0) {
    log(`${reason}: 探测 ${addresses.length} 个地址的 ${ports.join("/")} 端口…`);
    const started = Date.now();
    const found = await scanForPeers({
      ports,
      addresses,
      timeoutMs: config.scanTimeoutMs,
      concurrency: config.scanConcurrency,
      signal,
    });

    let added = 0;
    for (const rec of found) {
      if (discovery.note(rec, rec.sourceAddress)) added += 1;
    }
    const elapsed = Date.now() - started;
    if (found.length > 0) {
      log(`${reason}完成: 命中 ${found.length} 台（新登记 ${added}），耗时 ${elapsed}ms → ${found.map((r) => r.machine).join(", ")}`);
    } else {
      log(`${reason}完成: 未命中，耗时 ${elapsed}ms`);
    }
    lanFound = found.length;
  }

  const tail = await scanTailnet({ discovery, config, log, reason, ports });
  return { scanned: addresses.length + tail.scanned, found: lanFound + tail.found, tailnet: tail };
}

/**
 * 定期 ping 已知对端。
 * 这条让"发现"不再依赖组播：即使组播完全不通，只要扫描见过一次，
 * 之后就能靠 ping 维持在线状态、并在对方重启换端口后重新对齐。
 */
async function pingKnownPeers({ discovery, config, warn }) {
  const peers = discovery.peers();
  if (peers.length === 0) return;
  const now = Date.now();

  await Promise.all(
    peers.map(async (p) => {
      const endpoints = Array.isArray(p.endpoints) ? p.endpoints : [];
      if (endpoints.length === 0) return;

      // 每条通道都要探，但**节奏不同**。
      //
      // 最初按"局域网通就不探 tailnet"做（省 DERP 流量和用户态网络栈开销），
      // 但那样备选通道永远是「未探测」状态 —— 而**没验证过的备份不算备份**：
      // 等真需要时才发现不通就晚了。所以改成：局域网按 pingIntervalMs 常规保活，
      // tailnet 按 tsnetProbeIntervalMs（默认 60s）低频验证；另外**还没探通过的
      // 通道立刻探一次**，让它尽快有个真实状态而不是停在"未探测"。
      const tsnetInterval = Math.max(config.pingIntervalMs, config.tsnetProbeIntervalMs ?? 60000);
      const targets = endpoints.filter((ep) => {
        const interval = ep.transport === "tsnet" ? tsnetInterval : config.pingIntervalMs;
        if (ep.verified === false) {
          // 首次立刻探一次；失败后按通道节奏重试，并尊重 markEndpoint 记下
          // 的冷却时间。原来的 `return true` 让未验证端点每个 ping tick 都
          // 被探一次（默认 10s），完全绕过 tsnetProbeIntervalMs（60s）。
          if (!ep.lastFailAt) return true;
          if (Number(ep.downUntil ?? 0) > now) return false;
          return now - Number(ep.lastFailAt ?? 0) >= interval;
        }
        return now - Number(ep.lastSeen ?? 0) >= interval;
      });
      if (targets.length === 0) return;

      await Promise.all(
        targets.map(async (ep) => {
          if (!ep.host || !ep.port) return;
          const started = Date.now();
          try {
            const res = await peerFetchEndpoint(ep, `http://${ep.host}:${ep.port}/mesh/v1/health`, {
              timeoutMs: Math.min(3000, config.requestTimeoutMs),
              headers: { accept: "application/json" },
            });
            if (!res.ok) {
              // 端点通但返回错误：不打坏健康记录，也不换通道重试（换了也一样）
              discovery.markEndpoint(p.id, endpointKeyOf(ep), { ok: true, rttMs: Date.now() - started });
              return;
            }
            const body = await res.json();
            if (body?.app === "dsh-mesh" && body.id) {
              // 对方可能重启过、换了端口 —— 以 ping 到的为准，并刷新这条端点。
              // channel 用**这条端点自己的 key**：多 tailnet 时若统一写成 tsnet，
              // 不同通道会互相覆盖，一条断了另一条也跟着假死。
              // 候选端点（tsnet:cand:…）探通后就此转正，保持同一个 key，
              // 发送时按"依次试所有通道"解析。
              discovery.note(body, ep.host, {
                transport: ep.transport,
                channel: endpointKeyOf(ep),
                port: ep.port,
                // 把探测结果一起带上：note() 是成功路径的入口，RTT 与探测间隔
                // 在这里接住，通道的存活窗口才会跟着自己的节奏走
                rttMs: Date.now() - started,
                probeIntervalMs: ep.transport === "tsnet" ? tsnetInterval : config.pingIntervalMs,
              });
            }
          } catch {
            // 这条通道不通：记一次失败，累计到阈值就进冷却，排序会把它排到最后
            discovery.markEndpoint(p.id, endpointKeyOf(ep), {
              ok: false,
              probeIntervalMs: ep.transport === "tsnet" ? tsnetInterval : config.pingIntervalMs,
            });
          }
        }),
      );
    }),
  );
}

/** 按**指定**端点发一个请求（保活探测用，不做失败切换）。 */
async function peerFetchEndpoint(ep, url, opts = {}) {
  const { timeoutMs = 20000, ...rest } = opts;
  if (ep.transport === "tsnet") return fetchViaTailnet(ep, url, { ...rest, timeoutMs });
  return fetchViaLan(ep, url, { ...rest, timeoutMs });
}

// ───────────────────────── 对端 HTTP 服务 ─────────────────────────

function startPeerServer(ctx, { config, discovery, inbound, outbound, log, warn, waker, threadState, capFor, capOverrides, throttled, onHistoryChange, diagnostics, usbStatus = null }) {
  const send = (res, code, payload) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  };

  // 默认免配对：内网里发现即可连。开启配对后才校验配对码。
  // 注意这里调 pairingRequired() 而**不是**读 config —— 界面上的开关要立即生效，
  // 不能要求重启（重启会打断用户正在做的事）。
  const authed = (req) =>
    !pairingRequired(config) || safeEqual(req.headers["x-dsh-mesh-token"], currentSecret());

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const self = { ...discovery.selfRecord(), instanceId: discovery.instanceId };

    // 地址/MAC 探测 + dsh-go 环境 + sidecar 资产的可观察摘要。免鉴权接口只给
    // "来源与是否可用"，不给地址列表 / 不执行会写盘的动作。
    // 为什么放在这里：Android/proot 上"没有地址"与"地址探不到"在数据上一样，
    // 不把 source/errors 带出来就只能靠猜（AGENTS.md 硬约束 1）。
    const netDiag = () => {
      try {
        const info = typeof discovery.netInfo === "function" ? discovery.netInfo() : null;
        const inbound = describeInboundPermissionPreset({ config, task: { transport: "lan" }, dshGo: isDshGo() });
        return {
          net: netSummary(info),
          sidecarPlatform: sidecarPlatformValue(config),
          sidecarTarget: describeSidecarTarget(),
          dshGo: dshGoSummary(),
          inboundPermissionPreset: inbound.value,
          inboundPermissionPresetSource: inbound.source,
          // P1.5：USB/adb 传输状态（脱敏：只给计数/错误码，不给路径/错误原文）。
          // 免鉴权接口也要能验收"USB 端点有没有被登记"，否则真机只能翻日志。
          usb: usbStatusSafe(usbStatus),
        };
      } catch {
        return {
          net: { source: "error", macsAvailable: false, errors: [{ source: "netinfo", code: "THROW" }] },
          sidecarPlatform: sidecarPlatformValue(config),
          sidecarTarget: { error: "diag-failed" },
          dshGo: dshGoSummary(),
          inboundPermissionPreset: "",
          inboundPermissionPresetSource: "none",
          usb: usbStatusSafe(usbStatus),
        };
      }
    };

    // 免鉴权：只暴露身份，用于连通性探测、主动扫描与配对握手
    if (path === "/mesh/v1/health") {
      return send(res, 200, { ok: true, ...self, requirePairing: pairingRequired(config), diag: netDiag() });
    }
    if (path === "/mesh/v1/hello") {
      return send(res, 200, {
        ok: true,
        ...self,
        requirePairing: pairingRequired(config),
        // true = 由插件配置钉死，界面上不能关（界面据此禁用开关并说明原因）
        requirePairingPinned: pairingPinned(config),
        peerPaired: authed(req),
      });
    }

    if (!authed(req)) return send(res, 403, { ok: false, error: "未配对：两台机器的配对码不一致（本机开启了 requirePairing）" });

    // 一次性文件搬运：给对端取本机插件包里的文件（同版本部署用）。
    // 只认启动时生成的 nonce，且路径必须落在插件包目录内 —— 不是通用文件服务。
    if (path === "/mesh/v1/file" && req.method === "GET") {
      const nonce = url.searchParams.get("k") ?? "";
      // 两个都认：进程内的随机 nonce，或本机的 mesh 密钥（可从 state.json 读到，
      // 方便"人在旁边"时一次搬运；两者都不用改配置）。
      if (!safeEqual(nonce, FILE_TRANSFER_NONCE) && !safeEqual(nonce, currentSecret())) {
        return send(res, 403, { ok: false, error: "nonce 不对" });
      }
      const wanted = url.searchParams.get("path") ?? "";
      const packageRoot = resolve(ENTRY_INFO.path, "..", "..");
      const absolute = resolve(wanted);
      if (!absolute.startsWith(`${packageRoot}/`)) {
        return send(res, 400, { ok: false, error: "路径超出插件包目录" });
      }
      try {
        const body = readFileSync(absolute);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
        });
        res.end(body);
        return;
      } catch (err) {
        return send(res, 404, { ok: false, error: String(err?.message ?? err) });
      }
    }

    // 诊断：进程版本 vs 磁盘版本。**必须在对端鉴权之后** —— 里面有本机路径。
    if (path === "/mesh/v1/diagnostics") return send(res, 200, diagnostics());

    // 本机 DSH Web GUI 的入口地址（带启动 token）。
    //
    // 只在这里按需发放，**绝不**放进 discovery 广播：那条是明文组播，
    // 谁加入组播谁就能读到 token，等于把本机的 RCE 交给整个网段。
    // 走这条路径时要过 authed()，也就是跟着配对开关一起受保护。
    //
    // token 是进程级的、随重启轮换；浏览器第一次带 token 打开后会拿到
    // 一枚 30 天、绑定 authority 的签名 cookie，之后不带 token 也能开。
    if (path === "/mesh/v1/web-url" && req.method === "GET") {
      if (!experimentalRemoteEnabled(config)) {
        return send(res, 403, { ok: false, supported: false, error: "实验性远程控制未开启" });
      }
      try {
        const connection = ctx.get("connection");
        const port = ctx.get("webServer")?.port;
        const bind = ctx.get("webServer")?.host ?? "";
        if (!connection || typeof connection.authenticatedUrl !== "function" || !port) {
          return send(res, 200, { ok: false, supported: false, error: "本端没有可用的 Web GUI（不是 web profile）" });
        }
        const lanHost = preferredAddress();
        // 只绑了回环时如实说：地址虽然给得出来，但局域网里连不通。
        const lanReachable = bind === "0.0.0.0" && !!lanHost;
        const host = lanReachable ? lanHost : "127.0.0.1";
        return send(res, 200, {
          ok: true,
          supported: true,
          url: connection.authenticatedUrl(`http://${host}:${port}/`),
          bind,
          lanReachable,
          port,
        });
      } catch (err) {
        return send(res, 200, { ok: false, supported: false, error: String(err?.message ?? err) });
      }
    }

    if (path === "/mesh/v1/peers") return send(res, 200, { ok: true, peers: discovery.peers() });

    if (path === "/mesh/v1/tasks" && req.method === "GET") {
      return send(res, 200, { ok: true, tasks: inbound.slice(-50).reverse() });
    }

    if (path === "/mesh/v1/task" && req.method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.task !== "string" || !body.task.trim()) {
        return send(res, 400, { ok: false, error: "task 必填" });
      }
      // tailnet 的入站流量是 sidecar 反代来的，socket 上是 127.0.0.1，
      // 真实来源在 X-Forwarded-For 里（且只在回环来源时才采信）。
      const origin = tailnetOrigin(req);
      const task = {
        id: body.id || `t-${randomBytes(6).toString("hex")}`,
        from: String(body.from || "unknown"),
        fromMachine: String(body.fromMachine || ""),
        task: body.task,
        thread: body.thread ? String(body.thread) : "",
        originSession: body.originSession ? String(body.originSession) : "",
        noWake: body.noWake === true,
        newSession: body.newSession === true,
        workspace: body.workspace ? String(body.workspace) : "",
        receivedAt: new Date().toISOString(),
        sourceAddress: origin.address,
        transport: origin.transport,
        status: "accepted",
      };
      const duplicate = inbound.some((t) => t.id === task.id);
      if (!duplicate) {
        inbound.push(task);
        onHistoryChange?.();
        if (inbound.length > MAX_HISTORY) inbound.shift();
      }
      log(`收到任务 ${task.id} 来自 ${task.from}${duplicate ? "（重复，忽略）" : ""}`);
      if (!duplicate) {
        try {
          handleInboundTask(ctx, task, inbound, config, log, warn, waker, threadState, capFor, throttled, onHistoryChange, outbound);
        } catch (err) {
          warn(`处理入站任务异常: ${err?.message ?? err}`);
        }
      }
      return send(res, 200, { ok: true, id: task.id, duplicate });
    }

    return send(res, 404, { ok: false, error: "not found" });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    const wanted = config.port ?? MESH_DEFAULT_PORT;
    const start = (port, isFallback) => {
      server.once("error", (err) => {
        if (!isFallback && err?.code === "EADDRINUSE") {
          warn(`端口 ${wanted} 被占用，退回随机端口（组播仍可用，但主动扫描扫不到本机）`);
          start(0, true);
          return;
        }
        rejectPromise(err);
      });
      server.listen(port, "0.0.0.0", () => {
        const addr = server.address();
        log(`对端服务监听 0.0.0.0:${addr.port}${isFallback ? "（随机）" : "（固定）"}`);
        ctx.effect(() => () => server.close());
        resolvePromise(addr.port);
      });
    };
    start(wanted, false);
  });
}

function readJson(req) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolvePromise(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolvePromise(null);
      }
    });
    req.on("error", () => resolvePromise(null));
  });
}

// ───────────────────────── agent 工具 ─────────────────────────

function registerTools(ctx, { discovery, config, inbound, outbound, log, warn, threadState, hostDispatched, onHistoryChange }) {
  const text = (v) => [{ type: "text", text: v }];

  ctx.tools.register(
    defineTool({
      name: "mesh_peers",
      description:
        "列出局域网内自动发现的其他 DSH 机器（在线状态、地址、系统、用户、**能力**）。" +
        "派任务前先用它确认目标机器名，并看它有没有任务需要的运行时。",
      parameters: {
        includeOffline: { type: "boolean", description: "是否也列出离线机器，默认 true" },
      },
      output: { schema: { type: "string" }, render: (_a, v) => text(v) },
      async execute(args) {
        const peers = discovery.peers();
        const list = args?.includeOffline === false ? peers.filter((p) => p.online) : peers;
        if (list.length === 0) {
          return (
            "没有发现其他 DSH 机器。\n" +
            "用 mesh_scan 主动扫一次本网段（组播常被路由器/防火墙挡住）。\n" +
            "仍找不到就排查：1) 两台机器是否同一网段 2) 对端是否装了 dsh-plugin-mesh 并已重启 DSH " +
            "3) 对端防火墙是否放行这个 TCP 端口\n" +
            `本机: ${machineOf(discovery)} (${preferredAddress()})`
          );
        }
        const lines = list.map((p) => {
          const caps = capabilityLine(p);
          return (
            `${p.online ? "● 在线" : "○ 离线"}  ${p.machine}  ${p.host}:${p.port}  ${systemsLine(p)}  user=${p.user}` +
            (p.hostname ? `\n    hostname=${p.hostname}` : "") +
            (p.mac ? `  mac=${p.mac}` : "") +
            (caps ? `\n${caps}` : "")
          );
        });
        return `发现 ${list.length} 台机器：\n${lines.join("\n")}\n\n本机: ${machineOf(discovery)} (${preferredAddress()})`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mesh_scan",
      description:
        "主动扫描本网段的 mesh 端口，寻找还没被发现的其他 DSH 机器。" +
        "组播被路由器或防火墙挡住时用这个。扫描需要几秒。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => text(v) },
      async execute() {
        const before = discovery.peers().length;
        const r = await runScan({ discovery, config, log, warn, reason: "agent 触发扫描" });
        const after = discovery.peers();
        const lines = after.map((p) => `${p.online ? "●" : "○"}  ${p.machine}  ${p.host}:${p.port}`).join("\n");
        return (
          `扫描完成：探测 ${r.scanned} 个地址，命中 ${r.found} 台，` +
          `对端总数 ${before} → ${after.length}。\n` +
          (lines || "（仍未发现任何机器）")
        );
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mesh_run",
      description:
        "把一条任务派给局域网内另一台 DSH 机器上的 agent 执行。异步：立刻返回『已派发』，" +
        "不代表已完成。对端会新建一个会话来跑这个任务，完成后会用同样的方式回派结果。" +
        "注意：纯回执/确认（收到、好的、ack、ping）不要用本工具，那会凭空开一个 agent 会话；" +
        "确实要发这类内容就带 noWake: true。" +
        "同一件事请始终复用同一个 thread 值 —— 对端会据此复用同一个会话，" +
        "既省 token 也让它记得前几轮的结论。不同发起会话请使用不同 thread，避免回复串线。",
      parameters: {
        peer: { type: "string", required: true, description: "目标机器名（用 mesh_peers 查）" },
        task: { type: "string", required: true, description: "任务内容，自然语言描述清楚" },
        thread: { type: "string", description: "线程标识，把同一件事的多条消息串起来；对端据此复用会话" },
        noWake: {
          type: "boolean",
          description: "true = 对端只收进收件箱、不唤醒 agent（用于纯回执/确认，避免开新会话）",
        },
        newSession: {
          type: "boolean",
          description:
            "true = 强制新起一个会话（但会话键不变，仍属于同一场对话）。" +
            "用于『同一件事，但想把上下文清干净重开』；默认 false = 复用同 thread 的既有会话",
        },
        workspace: { type: "string", description: "建议对端使用的工作目录（绝对路径）" },
      },
      output: { schema: { type: "string" }, render: (_a, v) => text(v) },
      async execute(args, exec) {
        const peerName = String(args?.peer ?? "").trim();
        const task = String(args?.task ?? "").trim();
        if (!peerName || !task) return "peer 和 task 都必填。";

        const matches = findPeersByName(discovery, peerName);
        if (matches.length === 0) {
          const known = discovery.peers().map((p) => p.machine).join(", ") || "（无）";
          return `找不到机器 ${peerName}。当前发现的是: ${known}`;
        }
        if (matches.length > 1) {
          const list = matches.map((p) => `  ${p.machine} @ ${p.host}:${p.port}`).join("\n");
          return (
            `名字 "${peerName}" 同时匹配到 ${matches.length} 台机器，无法确定目标：\n${list}\n` +
            "请改用 <ip>:<port> 指定，或者给其中一台改个名字（Mesh 页面里可以改）。"
          );
        }
        const target = matches[0];
        if (!target.online) return `机器 ${target.machine} 当前离线，任务未派发。`;

        const id = `t-${randomBytes(6).toString("hex")}`;
        const payload = {
          id,
          from: `${machineOf(discovery)}/${safeUser()}`,
          fromMachine: machineOf(discovery),
          task,
          thread: args?.thread ? String(args.thread) : "",
          noWake: args?.noWake === true,
          newSession: args?.newSession === true,
          workspace: args?.workspace ? String(args.workspace) : "",
          originSession: exec?.agent?.session?.id ? String(exec.agent.session.id) : "",
        };

        // 宿主已经替用户派发过这个 thread：同一个会话再调一次就是对端收两份。
        // 真机上 agent 看到会话里的「派发」很容易这么做，所以在入口挡住。
        if (payload.thread && hostDispatched.has(payload.thread)) {
          const bound = threadState.get(conversationKey({ fromMachine: target.machine, thread: payload.thread }))?.sessionId;
          const here = exec?.agent?.session?.id ? String(exec.agent.session.id) : "";
          if (bound && here && bound === here) {
            return "这条任务已经由宿主发出去（会话里已记录），不需要再调用 mesh_run。请直接告诉用户「等待回执」。";
          }
        }

        // Replies arrive from the target machine, so bind its inbound key
        // before HTTP: the peer may reply before this request completes.
        const replyKey = conversationKey({ fromMachine: target.machine, thread: payload.thread });
        if (replyKey && payload.originSession) {
          if (pendingByConv.has(replyKey)) return "任务未派发：此 thread 正在建立会话，请稍后重试。";
          const previous = threadState.get(replyKey);
          if (previous?.sessionId && previous.sessionId !== payload.originSession) {
            return "任务未派发：thread 已绑定另一会话，请使用新的 thread。";
          }
          threadState.set(replyKey, { ...previous, wakesAt: previous?.wakesAt ?? [], sessionId: payload.originSession });
          saveThreads(threadState);
          // Retain the binding on failure: a timeout does not prove non-delivery.
        }

        const started = Date.now();
        try {
          const res = await peerFetch(target, "/mesh/v1/task", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Dsh-Mesh-Token": currentSecret() },
            body: JSON.stringify(payload),
            timeoutMs: config.requestTimeoutMs,
          });
          const body = await res.json().catch(() => ({}));
          outbound.push({ ...payload, toMachine: target.machine, at: new Date().toISOString(), ok: res.ok, status: res.status });
          onHistoryChange?.();
          if (outbound.length > MAX_HISTORY) outbound.shift();

          if (!res.ok) {
            return (
              `派发失败（HTTP ${res.status}）：${body?.error ?? "未知错误"}\n` +
              (res.status === 403 ? "对端开启了 requirePairing 且两端配对码不一致 —— 在插件页面的「配对码」里对齐。" : "")
            );
          }
          return (
            `已派发给 ${target.machine}，任务 id = ${id}，耗时 ${Date.now() - started}ms。\n` +
            "注意：这只代表对方已接收。对端 agent 会在它自己的会话里执行，完成后会把结果回派给你。"
          );
        } catch (err) {
          outbound.push({ ...payload, toMachine: target.machine, at: new Date().toISOString(), ok: false, error: String(err?.message ?? err) });
          onHistoryChange?.();
          return `派发失败：${err?.name === "TimeoutError" ? "超时" : err?.message ?? err}`;
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mesh_tasks",
      description: "查看本机收到的 mesh 任务（对端派来的）和本机派出去的记录。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => text(v) },
      async execute() {
        const fmt = (t) => `  [${t.id}] ${t.status}  ${t.from ?? t.toMachine} — ${String(t.task).slice(0, 70)}`;
        const inc = inbound.slice(-20).reverse().map(fmt).join("\n") || "  （无）";
        const out = outbound.slice(-20).reverse().map(fmt).join("\n") || "  （无）";
        return `本机收到的任务:\n${inc}\n\n本机派出的任务:\n${out}`;
      },
    }),
  );

  log("已注册工具 mesh_peers / mesh_run / mesh_tasks");
}

// ───────────────────────── UI 接口（本地回环） ─────────────────────────

function registerUiRoutes(ctx, { discovery, config, identity, inbound, outbound, log, warn, threadState, hostDispatched, capFor, capOverrides, throttled, waker, onHistoryChange, diagnostics }) {
  const send = (res, code, payload) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  };

  const route = (path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: "exact",
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res);
          } catch (err) {
            warn(`UI 路由 ${path} 异常: ${err?.message ?? err}`);
            if (!res.headersSent) send(res, 500, { ok: false, error: String(err?.message ?? err) });
          }
        },
      }),
    );

  /**
   * POST-only wrapper for state-changing routes.
   *
   * Without this a GET (an <img>, a link prefetch, or any local process) can
   * trigger mutations. "/mesh/api/pairing" was the worst: readJson() returns
   * null for a body-less GET, `body?.enabled === true` becomes false, and the
   * empty result was persisted as "pairing disabled" -- a fail-open.
   */
  const post = (path, handler) =>
    route(path, (req, res) =>
      req.method === "POST"
        ? handler(req, res)
        : send(res, 405, { ok: false, error: `method ${req.method} not allowed; use POST` }),
    );

  /** 实验性远程控制的入口守卫：关掉后这些路由一律 403。 */
  const requireExperimental = (res) => {
    if (experimentalRemoteEnabled(config)) return true;
    send(res, 403, { ok: false, error: "实验性远程控制未开启" });
    return false;
  };

  /** 返回 { peer } 或 { error }，避免撞名时静默挑错机器 */
  const findPeer = (name) => {
    const matches = findPeersByName(discovery, name);
    if (matches.length === 0) return { error: `找不到机器 ${name}` };
    if (matches.length > 1) {
      // 重名时优先选**唯一在线**的那台。
      //
      // 典型场景：对端重启后 instanceId 变了（旧版插件不持久化 id），旧记录
      // 要等 keepMs 才过期，于是同名两条、其中一条在线。此时目标是明确的 ——
      // 离线那条要么是同一台机器的残留，要么本来就派不过去。只有"在线的也
      // 不止一台"才真的需要用户用 <ip>:<port> 指明。
      const online = matches.filter((p) => p.online);
      if (online.length === 1) return { peer: online[0] };
      return { error: `名字 "${name}" 匹配到 ${matches.length} 台机器，请用 <ip>:<port> 指定` };
    }
    return { peer: matches[0] };
  };

  /** 重名检测：名字是人手填的，撞名会让 mesh_run --peer 有歧义 */
  /**
   * 重名检测：只在**真正会造成歧义**时报警，即同名且在线的不止一台。
   *
   * 离线的那条不该算 —— 派发本来就会跳过它（findPeer 优先选唯一在线的），
   * 而且它多半是对端重启后的残留、几分钟内自动过期。原来把离线也算进去，
   * 于是对端每重启一次就弹一次「有重名」，用户既改不了（那台机器已经没了），
   * 又要等到过期才消失。
   */
  const duplicateNames = () => {
    const groups = new Map();
    for (const p of discovery.peers()) {
      if (!groups.has(p.machine)) groups.set(p.machine, []);
      groups.get(p.machine).push(p);
    }
    if (!groups.has(identity.name)) groups.set(identity.name, []);
    groups.get(identity.name).push({ host: preferredAddress(), port: discovery.port, online: true, self: true });

    return [...groups.entries()]
      .filter(([, list]) => list.filter((p) => p.online).length > 1)
      .map(([name, list]) => {
        // 带上地址，用户才知道要去哪台机器上改名
        const where = list.filter((p) => p.online).map((p) => `${p.host}:${p.port}`).join("、");
        return `${name}（${where}）`;
      });
  };

  const state = () => {
    // state.json 只读一次：这个接口会被页面轮询，而通道解析内部每次都读文件，
    // 逐字段调用会把一次轮询变成多次磁盘读。
    const tailnetChannels = effectiveTailnetChannels(config);
    const channelViews = tailnetChannels.map((c) => tailnetChannelView(c, tailnetNodes.get(c.id) ?? null));
    // 兼容旧界面：node / hostname / authKeySaved 取"第一条启用的通道"
    const primary = channelViews.find((c) => c.enabled) ?? channelViews[0] ?? null;
    // 入站权限生效值只算一次（页面轮询时被 self/config/诊断多处读）。
    const inboundPreset = describeInboundPermissionPreset({ config, task: { transport: "lan" }, dshGo: isDshGo() });
    return {
      ok: true,
      self: {
        machine: identity.name,
        machineSource: identity.source,
        needsName: identity.source === "hostname",
        avatar: discovery.selfRecord().avatar,
        hostname: hostname(),
        mac: macForAddress(preferredAddress()),
        host: preferredAddress(),
        port: discovery.port,
        instanceId: discovery.instanceId,
        addresses: lanIPv4Addresses(),
        // 地址从哪来 / MAC 能不能用。Android/proot 上这两个结论经常是"探测失败"
        // 而不是"设备没有"，必须让排障的人一眼看见（P0）。
        net: netSummary(discovery.netInfo()),
        // dsh-go/Android proot 环境识别结果（P1）：机型/Android 版本/证据。
        dshGo: dshGoSummary(),
        // 入站任务实际会用的权限 preset 及来源（dsh-go 覆盖 / tailnet / 默认）。
        // 真机「待确认」问题的第一现场就这里 —— 让 UI/排障能直接看到。
        inboundPermissionPreset: inboundPreset,
        platform: platform(),
        version: VERSION,
        // 磁盘上的版本 vs 本进程加载的版本。两者不一致 = 升级了但没重启，
        // 界面要明说"重启后生效"，否则用户会拿旧行为当新版本的 bug 报上来。
        diskVersion: DISK_VERSION,
        versionDrift: !!DISK_VERSION && DISK_VERSION !== VERSION,
        secret: currentSecret(),
        // 本机的能力名片（对端看到的也是这一份）。**本机直接读采集缓存**，
        // 不走网络 —— 和 mac 一样，"自己的信息"没必要绕一圈。
        capabilities: currentCapabilities(),
        capabilitySummary: summarizeCapabilities(currentCapabilities()),
        // 探测用的 PATH。**只在自检/排障时有意义**：能力采集是在子进程里跑的，
        // 而 DSH 从 GUI 启动时继承的 PATH 可能极简（Homebrew / ~/go/bin 都不在），
        // 于是"机器上明明装了 python 却报没有"。把实际用的 PATH 摆出来，
        // 这类问题一眼可查，不必再靠猜。
        capabilityProbePath: augmentedPath(),
      },
      config: {
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        // P1：UI 要能看到"入站任务实际会用什么权限"（dsh-go 上可能被覆盖）。
        // 直接给生效值+来源，避免界面自己再算一遍规则（两处规则必然漂移）。
        permissionPresetEffective: inboundPreset.value,
        permissionPresetSource: inboundPreset.source,
        workspaceRoot: config.workspaceRoot,
        desktopWebPort: config.desktopWebPort,
        experimentalRemoteControl: config.experimentalRemoteControl === true,
        peerTtlMs: config.peerTtlMs,
        announceIntervalMs: config.announceIntervalMs,
        // 必须用生效值，不能用 config —— 这个接口是 UI 读的，
        // 界面开关一改就得立刻反映出来（端到端测试就是在这抓到过一次 stale）。
        requirePairing: pairingRequired(config),
        requirePairingPinned: pairingPinned(config),
        useMulticast: config.useMulticast !== false,
        scanOnStart: config.scanOnStart !== false,
        scanIntervalMs: config.scanIntervalMs,
        pingIntervalMs: config.pingIntervalMs,
        scanRanges: config.scanRanges ?? [],
        // P0 新增：静态对端 / 手工对外地址 / sidecar 风味。UI 可以只读展示，
        // 旧客户端不认识这些键会直接忽略（纯增量，不破坏协议）。
        staticPeers: config.staticPeers ?? [],
        advertiseAddress: config.advertiseAddress ?? "",
        sidecarPlatform: sidecarPlatformValue(config),
        // P1：dsh-go 上的入站权限覆盖（空 = 使用内置默认，dsh-go 上为 danger-full-access）。
        // UI 只读展示；生效值与来源见 self.inboundPermissionPreset。
        permissionPresetOnDshGo: config.permissionPresetOnDshGo ?? "",
        // 对端能力名片超过这个年龄就按"未知"处理（UI 用它渲染"能力信息已过期"）
        capabilityStaleMs: CAPABILITY_STALE_MS,
      },
      // 互联网自组网状态。注意：**绝不回传授权码本身**，只回报"是否已配置"。
      tsnet: {
        // 多 tailnet 通道列表：UI 的主视图
        channels: channelViews,
        /** 有任意一条启用的通道即为 true（旧界面兼容） */
        enabled: channelViews.some((c) => c.enabled),
        /** 旧单通道字段：取第一条启用通道 */
        authKeySaved: Boolean(primary?.authKeySaved),
        controlUrl: primary?.controlUrl ?? "",
        hostname: primary?.hostname ?? "",
        permissionPreset: config.tsnetPermissionPreset || "",
        /** 留空时实际生效的权限，与局域网一致 */
        permissionPresetEffective: config.tsnetPermissionPreset || config.permissionPreset,
        node: primary?.node ?? null,
        recentEvents: primary?.recentEvents ?? [],
        // P1：按当前环境/配置会选哪个 sidecar 资产（dsh-go → android/arm64）。
        // 只是"会选哪个"，不代表已下载/已启动。
        target: describeSidecarTarget(),
      },
      peers: discovery.peers(),
      duplicateNames: duplicateNames(),
      inbound: inbound.slice(-30).reverse(),
      outbound: outbound.slice(-30).reverse(),
      // 被限速挡下的 thread：给页面渲染"是否提高上限"的提示
      throttled: [...throttled.entries()].map(([thread, v]) => ({
        thread,
        blocked: v.taskIds.length,
        cap: v.cap,
        defaultCap: config.maxWakesPerThread ?? 0,
        windowMs: config.threadWindowMs ?? 3600000,
        key: v.key || thread,
        overridden: capOverrides.has(v.key || thread),
        firstAt: new Date(v.firstAt).toISOString(),
        lastAt: new Date(v.lastAt).toISOString(),
      })),
    };
  };

  route("/mesh/api/state", (_req, res) => send(res, 200, state()));
  // 只读诊断：UI 的「诊断」卡片用它；与 /mesh/v1/diagnostics 同一份数据。
  route("/mesh/api/diagnostics", (_req, res) => send(res, 200, diagnostics()));

  /**
   * 用户决定提高某个 thread 的限速上限。
   *
   * 提高后立刻放行**最近被挡的那一条**（对话的最新一环），其余仍留在收件箱 ——
   * 一次性全部重放会造成一个新的突发，反而失去限速的意义。
   */
  post("/mesh/api/throttle/raise", async (req, res) => {
    const body = await readJson(req);
    const thread = String(body?.thread ?? "").trim();
    if (!thread) return send(res, 400, { ok: false, error: "thread 必填" });
    const entry = throttled.get(thread);
    if (!entry) return send(res, 404, { ok: false, error: `thread "${thread}" 当前没有被限速` });

    const capKey = entry.key || thread;
    const current = capFor(capKey);
    const requested = Number(body?.cap);
    // 默认在当前基础上翻倍（至少 +10），也可由调用方指定
    const next = Number.isFinite(requested) && requested > current
      ? Math.floor(requested)
      : Math.max(current + 10, current * 2);
    capOverrides.set(capKey, next);
    // 必须显式传入，否则 saveThreads 会从磁盘读回旧值、把手动提高冲掉
    saveThreads(threadState, capOverrides);

    // 放行最新一条；其余保留在收件箱
    const lastId = entry.taskIds[entry.taskIds.length - 1];
    const task = inbound.find((t) => t.id === lastId);
    throttled.delete(thread);
    if (task) {
      log(`用户将 thread "${thread}" 上限提高到 ${next}，放行最新任务 ${lastId}`);
      handleInboundTask(ctx, task, inbound, config, log, warn, waker, threadState, capFor, throttled, onHistoryChange, outbound);
    } else {
      log(`用户将 thread "${thread}" 上限提高到 ${next}（未找到可重放的任务）`);
    }
    return send(res, 200, {
      ok: true,
      thread,
      cap: next,
      replayed: task ? lastId : null,
      remaining: Math.max(0, entry.taskIds.length - 1),
    });
  });

  /** 用户选择"忽略"：清掉提示，不改上限。任务仍留在收件箱。 */
  post("/mesh/api/throttle/dismiss", async (req, res) => {
    const body = await readJson(req);
    const thread = String(body?.thread ?? "").trim();
    if (!thread) return send(res, 400, { ok: false, error: "thread 必填" });
    const entry = throttled.get(thread);
    throttled.delete(thread);
    log(`用户忽略了 thread "${thread}" 的限速提示（上限不变，${entry?.taskIds.length ?? 0} 条仍在收件箱）`);
    return send(res, 200, { ok: true, thread });
  });

  // 首次启动的"起名"接口：存进 state.json，并立刻重新广播
  post("/mesh/api/name", async (req, res) => {
    const body = await readJson(req);
    let name;
    try {
      name = validateMachineName(body?.name);
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
    if (identity.source === "config") {
      return send(res, 409, {
        ok: false,
        error: "名字由插件配置里的 machineName 指定；要改请改配置，页面上的修改会被配置覆盖。",
      });
    }
    const previous = identity.name;
    saveState({ machineName: name });
    identity.name = name;
    identity.source = "saved";
    discovery.setMachine(name);
    log(`机器名已从 "${previous}" 改为 "${name}"，已重新广播`);
    send(res, 200, { ok: true, name, previous });
  });

  // 本机头像：手动上传/清除；默认会自动读系统用户头像（见 lib/avatar.js）
  post("/mesh/api/avatar", async (req, res) => {
    const body = await readJson(req);
    if (body?.clear === true) {
      const fallback = detectDefaultAvatar();
      saveState({ avatar: "" });
      discovery.setMeta({ avatar: fallback });
      discovery.announceNow();
      log("本机头像已恢复默认（系统用户头像）");
      return send(res, 200, { ok: true, avatar: fallback });
    }
    const avatar = sanitizeAvatar(body?.avatar);
    if (!avatar) {
      return send(res, 400, {
        ok: false,
        error: "头像必须是 png/jpeg/webp 的 data URL，且不超过 64 KB",
      });
    }
    saveState({ avatar });
    discovery.setMeta({ avatar });
    discovery.announceNow();
    log("本机头像已更新，已重新广播");
    send(res, 200, { ok: true, avatar });
  });

  // 设置页：只接受白名单键，落盘到 state.json 的 settings，并立即覆盖内存 config。
  // restart=true 的键要重启 DSH 才真正生效。
  post("/mesh/api/settings", async (req, res) => {
    const body = await readJson(req);
    const values = body && typeof body.values === "object" && body.values ? body.values : null;
    if (!values || Array.isArray(values)) {
      return send(res, 400, { ok: false, error: "values 必须是对象" });
    }
    const st = loadState();
    const next = { ...(st.settings && typeof st.settings === "object" ? st.settings : {}) };
    const restart = [];
    for (const [key, raw] of Object.entries(values)) {
      const spec = EDITABLE_SETTINGS[key];
      if (!spec) return send(res, 400, { ok: false, error: `不支持的设置项：${key}` });
      const checked = coerceSetting(spec, raw);
      if (checked.error) return send(res, 400, { ok: false, error: `${key}: ${checked.error}` });
      next[key] = checked.value;
      try {
        config[key] = checked.value;
      } catch {
        /* 只读配置对象：落盘后下次启动生效 */
      }
      if (spec.restart) restart.push(key);
    }
    saveState({ settings: next });
    log(`设置已保存：${Object.keys(values).join(", ")}${restart.length ? `（重启后生效：${restart.join(", ")}）` : ""}`);
    send(res, 200, { ok: true, settings: next, restart });
  });

  post("/mesh/api/refresh", (_req, res) => {
    discovery.announceNow();
    send(res, 200, { ok: true });
  });

  post("/mesh/api/scan", async (_req, res) => {
    try {
      const result = await runScan({ discovery, config, log, warn, reason: "手动扫描" });
      send(res, 200, { ok: true, ...result, peers: discovery.peers() });
    } catch (err) {
      send(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });

  /**
   * 界面上的「配对码开关」。
   *
   * 为什么需要这个接口：原来开启配对只能改 profile 的 cordis.patch.yml 再重启，
   * 而页面上却明晃晃写着"未启用（默认）"—— 用户在页面上找不到开关，实测就问
   * 了一句"启动开关在哪？"。状态能看见、却改不了，比不显示更让人困惑。
   *
   * 写进 state.json 而不是改写用户的配置文件：配置文件是用户手写的、还带着注释，
   * 程序去改它风险太大（YAML 注释会被吃掉）。这也是 tsnet 开关一直在用的做法。
   * 配置里写死 requirePairing: true 的情况仍然优先（部署方能强制）。
   */
  post("/mesh/api/pairing", async (req, res) => {
    const body = await readJson(req);
    if (typeof body?.enabled !== "boolean") {
      return send(res, 400, { ok: false, error: "enabled 必须是布尔值" });
    }
    const want = body.enabled;
    if (pairingPinned(config)) {
      return send(res, 409, {
        ok: false,
        error: "配对码已由插件配置 requirePairing: true 固定开启，界面无法关闭",
      });
    }
    saveState({ requirePairing: want });
    log(`配对码${want ? "已启用" : "已停用"}（界面切换，立即生效，无需重启）`);
    return send(res, 200, { ok: true, requirePairing: want });
  });

  post("/mesh/api/secret", async (req, res) => {
    const body = await readJson(req);
    const secret = String(body?.secret ?? "").trim();
    if (secret.length < 16) return send(res, 400, { ok: false, error: "配对码至少 16 个字符" });
    saveState({ secret });
    discovery.announceNow();
    log("配对码已更新");
    send(res, 200, { ok: true });
  });

  // ─────────────── 互联网自组网（tailnet）───────────────

  // 无论节点是启动时创建还是后来从界面启动的，插件卸载时都收干净。
  ctx.effect(() => () => {
    for (const node of tailnetNodes.values()) node.stop().catch(() => {});
    tailnetNodes.clear();
  });

  /** 通道列表是否被插件配置钉死（此时界面只能看，不能改）。 */
  const tailnetChannelsPinned = () => Array.isArray(config.tsnetChannels) && config.tsnetChannels.length > 0;

  /** 把当前生效的通道列表转成对外视图（不回传授权码）。 */
  const tailnetViews = () =>
    effectiveTailnetChannels(config).map((c) => tailnetChannelView(c, tailnetNodes.get(c.id) ?? null));

  /**
   * 保存 tailnet 配置（多通道）。
   *
   * 两种形态：
   *   · `{ channels: [...] }` —— 整体替换通道列表（界面走这条）
   *   · 旧的单通道字段 `{ authKey, controlUrl, hostname, enabled }` —— 兼容老页面
   *
   * 授权码存进 state.json（0600），所以**只需要输入一次**，重启不用再填。
   * 某项的 `authKey` 传空串表示"不改动已保存的值"；要清掉就传
   * `clearAuthKey: true`，避免界面回显后又被空值覆盖。
   */
  post("/mesh/api/tsnet/config", async (req, res) => {
    const body = await readJson(req);

    if (Array.isArray(body?.channels)) {
      if (tailnetChannelsPinned()) {
        return send(res, 409, {
          ok: false,
          error: "通道列表已由插件配置 tsnetChannels 固定，界面不能修改",
        });
      }
      const existing = effectiveTailnetChannels(config);
      const byId = new Map(existing.map((c) => [c.id, c]));
      const used = new Set();
      const next = [];
      for (const item of body.channels) {
        if (!item || typeof item !== "object") continue;
        const rawLabel = String(item.label ?? "").trim().slice(0, 60);
        const rawControl = String(item.controlUrl ?? "").trim();
        let id = channelKey(item.id, "");
        if (!id) {
          // 新通道：宿主生成稳定 id。之后改显示名不会改变设备身份。
          do {
            id = `ch-${randomBytes(4).toString("hex")}`;
          } while (used.has(id) || byId.has(id) && !item.id);
        }
        if (used.has(id)) {
          return send(res, 400, { ok: false, error: `通道 id 重复：${id}` });
        }
        used.add(id);
        const prev = byId.get(id);
        const incomingKey = typeof item.authKey === "string" ? item.authKey.trim() : "";
        const authKey = item.clearAuthKey === true ? "" : incomingKey || prev?.authKey || "";
        next.push({
          id,
          label: rawLabel || prev?.label || `Tailnet ${next.length + 1}`,
          authKey,
          controlUrl: rawControl || prev?.controlUrl || "",
          hostname: String(item.hostname ?? "").trim() || prev?.hostname || "",
          enabled: item.enabled !== false,
        });
      }
      // 允许清空：这是"彻底关掉跨网络组网"的唯一可靠路径。必须同时清掉旧版
      // 单通道字段 —— 否则空列表会退回旧字段，把刚删掉的通道又变出来。
      if (next.length === 0) {
        await stopTailnetChannel("", discovery);
        saveState({
          tsnetChannels: [],
          tsnetEnabled: false,
          tsnetAuthKey: "",
          tsnetControlUrl: "",
          tsnetHostname: "",
        });
        log("tailnet 通道已全部删除，跨网络组网关闭");
        return send(res, 200, { ok: true, channels: [], enabled: false, authKeySaved: false, controlUrl: "", hostname: "" });
      }
      saveState({
        tsnetChannels: next,
        // 旧字段跟着走，避免老版本页面/回退时看到"未启用"
        tsnetEnabled: next.some((c) => c.enabled),
      });
      // 停掉被删掉、已禁用、或连接参数已变的通道；新配置由 /tsnet/start 拉起。
      // 参数变了却继续跑旧 sidecar，会留下"配置显示 A、实际连的是 B"的假象。
      for (const [id, node] of [...tailnetNodes.entries()]) {
        const spec = next.find((c) => c.id === id);
        const keep = spec && spec.enabled && node.signature === channelSignature(spec);
        if (!keep) {
          tailnetNodes.delete(id);
          await node.stop().catch(() => {});
        }
      }
      syncTailnetMeta(discovery);
      const views = tailnetViews();
      log(`tailnet 通道已保存：${next.map((c) => `${c.label}(${c.id})`).join("、")}`);
      return send(res, 200, {
        ok: true,
        channels: views,
        // 旧界面字段（取第一条启用通道）
        enabled: next.some((c) => c.enabled),
        authKeySaved: views.some((v) => v.authKeySaved),
        controlUrl: views[0]?.controlUrl ?? "",
        hostname: views[0]?.hostname ?? "",
      });
    }

    // ── 旧版单通道字段（兼容已部署页面 / 脚本）──
    //
    // 如果已经有多通道列表，就作用到第一条（优先 default）通道上。
    // 直接忽略会变成"界面说保存成功、实际什么都没变"—— 这个项目最怕的静默失败。
    const currentChannels = effectiveTailnetChannels(config);
    if (currentChannels.length > 0 && !tailnetChannelsPinned()) {
      const next = currentChannels.map((c) => ({
        id: c.id,
        label: c.label,
        authKey: c.authKey,
        controlUrl: c.controlUrl,
        hostname: c.hostname,
        enabled: c.enabled,
      }));
      const target = next.find((c) => c.id === "default") ?? next[0];
      if (typeof body?.authKey === "string" && body.authKey.trim()) target.authKey = body.authKey.trim();
      if (body?.clearAuthKey === true) target.authKey = "";
      if (typeof body?.controlUrl === "string") target.controlUrl = body.controlUrl.trim();
      if (typeof body?.hostname === "string") target.hostname = body.hostname.trim();
      if (typeof body?.enabled === "boolean") target.enabled = body.enabled;
      saveState({ tsnetChannels: next, tsnetEnabled: next.some((c) => c.enabled) });
      log(`tailnet 配置已更新（作用于通道 ${target.id}）：启用=${target.enabled} 授权码=${target.authKey ? "已保存" : "未设置"}`);
      const views = tailnetViews();
      return send(res, 200, {
        ok: true,
        channels: views,
        authKeySaved: views.some((v) => v.authKeySaved),
        controlUrl: target.controlUrl ?? "",
        hostname: target.hostname ?? "",
        enabled: views.some((v) => v.enabled),
      });
    }

    const patch = {};
    if (typeof body?.authKey === "string" && body.authKey.trim()) patch.tsnetAuthKey = body.authKey.trim();
    if (body?.clearAuthKey === true) patch.tsnetAuthKey = "";
    if (typeof body?.controlUrl === "string") patch.tsnetControlUrl = body.controlUrl.trim();
    if (typeof body?.hostname === "string") patch.tsnetHostname = body.hostname.trim();
    if (typeof body?.enabled === "boolean") patch.tsnetEnabled = body.enabled;
    const saved = saveState(patch);
    log(
      `tailnet 旧版单通道配置已更新：启用=${saved.tsnetEnabled === true} ` +
        `授权码=${patch.tsnetAuthKey ? "已保存" : saved.tsnetAuthKey ? "保留原值" : "未设置"} ` +
        `控制服务器=${saved.tsnetControlUrl || "官方"}`,
    );
    return send(res, 200, {
      ok: true,
      channels: tailnetViews(),
      // 绝不回传授权码内容，只回报是否已配置
      authKeySaved: Boolean(saved.tsnetAuthKey),
      controlUrl: saved.tsnetControlUrl ?? "",
      hostname: saved.tsnetHostname ?? "",
      enabled: saved.tsnetEnabled === true,
    });
  });

  /**
   * 启动（或按最新配置重启）tailnet 通道。
   *
   * body.id 省略 = 启动所有启用的通道（兼容旧页面点「只启动」）。
   */
  post("/mesh/api/tsnet/start", async (req, res) => {
    const body = await readJson(req);
    const wantId = String(body?.id ?? "").trim();
    const all = effectiveTailnetChannels(config);
    const targets = wantId ? all.filter((c) => c.id === channelKey(wantId)) : all.filter((c) => c.enabled);
    if (targets.length === 0) {
      return send(res, 404, { ok: false, error: wantId ? `没有 id 为 ${wantId} 的通道` : "没有启用的 tailnet 通道" });
    }
    const started = [];
    for (const channel of targets) {
      try {
        const { reused } = await startTailnetChannel(channel, {
          config,
          discovery,
          log,
          warn,
          machineName: identity.name,
        });
        started.push({ id: channel.id, ok: true, reused });
      } catch (err) {
        started.push({ id: channel.id, ok: false, error: String(err?.message ?? err) });
      }
    }
    await runScan({ discovery, config, log, warn, reason: "tailnet 手动扫描" }).catch(() => {});
    const ok = started.some((r) => r.ok);
    const first = targets[0];
    return send(res, 200, {
      ok,
      results: started,
      error: ok ? undefined : started.map((r) => `${r.id}: ${r.error}`).join("；"),
      node: tailnetNodes.get(first.id)?.status() ?? null,
      channels: tailnetViews(),
    });
  });

  /**
   * 停止 tailnet 通道（body.id 省略 = 全部）。
   *
   * 这里**不能**传 keepRemote：stop() 在 "非 owner 或 keepRemote" 时走保留分支，
   * 而无条件传 true 会让本实例自己拉起的 sidecar 也停不掉（实测点「停止」后
   * 进程仍在跑、rendezvous 也没清）。不传参数即按归属判断：自己拉起的关掉，
   * 复用别人的只注销自己的 forward。
   */
  post("/mesh/api/tsnet/stop", async (req, res) => {
    const body = await readJson(req);
    const wantId = String(body?.id ?? "").trim();
    const stopped = await stopTailnetChannel(wantId ? channelKey(wantId) : "", discovery);
    log(`tailnet ${wantId ? `通道 ${wantId} ` : "全部通道"}已停止（${stopped} 个）`);
    return send(res, 200, { ok: true, stopped, channels: tailnetViews() });
  });

  /** 清掉节点身份重新登录（授权码失效 / 换账号时用）。body.id 省略 = 所有在跑的通道。 */
  post("/mesh/api/tsnet/relogin", async (req, res) => {
    const body = await readJson(req);
    const wantId = String(body?.id ?? "").trim();
    const ids = wantId ? [channelKey(wantId)] : [...tailnetNodes.keys()];
    const nodes = ids.map((id) => tailnetNodes.get(id)).filter(Boolean);
    if (nodes.length === 0) return send(res, 409, { ok: false, error: "互联网组网未启动" });
    const done = [];
    for (const node of nodes) {
      try {
        await node.relogin();
        if (discovery.port) await node.registerForward(discovery.port);
        done.push({ id: node.channelKey, ok: true, node: node.status() });
      } catch (err) {
        done.push({ id: node.channelKey, ok: false, error: String(err?.message ?? err), node: node.status() });
      }
    }
    syncTailnetMeta(discovery);
    const ok = done.some((r) => r.ok);
    return send(res, 200, {
      ok,
      results: done,
      node: nodes[0].status(),
      channels: tailnetViews(),
    });
  });

  /**
   * 重新下载 sidecar 二进制（下载损坏或换平台时用）。
   *
   * 二进制是**整机共享**的：先停掉所有通道再换文件，否则 Windows 上文件锁着
   * 换不掉；换完不自动重启，按旧行为留给用户点「连接」。
   */
  post("/mesh/api/tsnet/reinstall", async (req, res) => {
    const body = await readJson(req);
    const wantId = String(body?.id ?? "").trim();
    const channels = effectiveTailnetChannels(config);
    const target = (wantId ? channels.find((c) => c.id === channelKey(wantId)) : null) ?? channels[0] ?? null;
    if (!target) return send(res, 409, { ok: false, error: "还没有配置 tailnet 通道" });
    await stopTailnetChannel("", discovery);
    const node = new TsnetNode({ config, channel: target, log, warn, machineName: identity.name });
    try {
      const r = await node.reinstallBinary();
      return send(res, 200, { ok: true, path: r.path, source: r.source });
    } catch (err) {
      return send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
  });

  /** 只扫 tailnet，不扫局域网。body.id 省略 = 所有在跑的通道。 */
  post("/mesh/api/tsnet/scan", async (req, res) => {
    const body = await readJson(req);
    const wantId = String(body?.id ?? "").trim();
    const before = new Set(discovery.peers().map((p) => p.id));
    const result = await scanTailnet({
      discovery,
      config,
      log,
      reason: "tailnet 手动扫描",
      ports: scanPortList(discovery, config),
      channelId: wantId ? channelKey(wantId) : "",
    });
    const added = discovery.peers().filter((p) => !before.has(p.id));
    return send(res, 200, {
      ok: true,
      ...result,
      added: added.map((p) => ({ machine: p.machine, host: p.host, port: p.port, channel: p.channel })),
    });
  });

  post("/mesh/api/send", async (req, res) => {
    const body = await readJson(req);
    const peerName = String(body?.peer ?? "").trim();
    const task = String(body?.task ?? "").trim();
    if (!peerName || !task) return send(res, 400, { ok: false, error: "peer 和 task 必填" });
    const found = findPeer(peerName);
    if (found.error) return send(res, found.error.startsWith("名字") ? 409 : 404, { ok: false, error: found.error });
    const target = found.peer;

    const id = `t-${randomBytes(6).toString("hex")}`;
    let createdSessionId = "";
    const payload = {
      id,
      from: `${machineOf(discovery)}/${safeUser()}`,
      fromMachine: machineOf(discovery),
      task,
      thread: body?.thread ? String(body.thread) : "",
      noWake: body?.noWake === true,
      newSession: body?.newSession === true,
      workspace: body?.workspace ? String(body.workspace) : "",
      // 页面手动派发时，UI 会带上「当前会话 id」，回执就能落回那个会话。
      // 不带的话宿主没有绑定可登记，对端回传只能新开一个 mesh-* 会话 ——
      // 这正是「手动派发后回执自己长出一个新会话」的原因。
      originSession: body?.originSession ? String(body.originSession) : "",
    };

    // 页面派发如果没填 thread，就自己生成一个。
    //
    // 「线程标识（可选）」留空时，payload.thread 是空串 → 没有绑定键 →
    // 对端按提示词里的兜底（thread 填任务 id）回执 → 我们这边算出的键完全对不上，
    // 只能新开会话。真机复测就是这样：回执的 thread 是 t-xxxx（对方任务 id）。
    if (!payload.thread) {
      payload.thread = `ui-${id}`;
    }

    // 页面派发时**预建一个会话**，回执才有地方可去。
    //
    // 只靠 UI 传当前会话不够：Mesh 面板拿不到 selection 时 sessionId 是空的，
    // 绑定整段被跳过，回执就只能新开会话（真机反馈「mac 没有预先生成会话」）。
    // 这里在宿主侧兜底：还没绑定、但有 thread、且唤醒能力可用 → 先建一个空会话。
    if (!payload.originSession && payload.thread && waker?.ready) {
      try {
        payload.originSession = await createIdleSession(
          waker,
          config,
          { id, from: payload.from, thread: payload.thread, toMachine: target.machine, transport: target.transport },
          warn,
          // 格式（用户指定）：第一行「向 X 发送的消息」→ 原文 → 末行「等待 X 回复」。
          // 末行同时承担「别在本机执行」的职责：只写「等待回复」是状态描述，
          // agent 仍会把上面的原文当任务执行，必须让它明确知道别动手。
          { text: `向 ${target.machine} 发送的消息 如下:\n${task}\n———\n[Mesh 已派发 → ${target.machine}／${id}] 现在什么都不用做：不要调用任何工具、不要回派，回一句「等待回执」即可。` },
        );
        createdSessionId = payload.originSession;
      } catch (err) {
        warn(`预建会话失败（回执将新建会话）：${err?.message ?? err}`);
      }
    }

    // 与 mesh_run 相同的登记：必须在 HTTP **之前**绑定，因为对端可能先回执。
    const replyKey = conversationKey({ fromMachine: target.machine, thread: payload.thread });
    if (replyKey && payload.originSession) {
      if (pendingByConv.has(replyKey)) {
        return send(res, 409, { ok: false, error: "此 thread 正在建立会话，请稍后重试" });
      }
      const previous = threadState.get(replyKey);
      if (previous?.sessionId && previous.sessionId !== payload.originSession) {
        return send(res, 409, { ok: false, error: "该 thread 已绑定另一会话，请换一个 thread" });
      }
      threadState.set(replyKey, { ...previous, wakesAt: previous?.wakesAt ?? [], sessionId: payload.originSession });
      saveThreads(threadState);
      hostDispatched.set(payload.thread, Date.now());
      // 顺手清理过期条目，别让它无限增长
      for (const [t, at] of hostDispatched) {
        if (Date.now() - at > 3600_000) hostDispatched.delete(t);
      }
    }

    try {
      const r = await peerFetch(target, "/mesh/v1/task", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dsh-Mesh-Token": currentSecret() },
        body: JSON.stringify(payload),
        timeoutMs: config.requestTimeoutMs,
      });
      const rb = await r.json().catch(() => ({}));
      outbound.push({ ...payload, toMachine: target.machine, at: new Date().toISOString(), ok: r.ok, status: r.status });
      onHistoryChange?.();
      if (outbound.length > MAX_HISTORY) outbound.shift();
      return send(res, r.ok ? 200 : 502, { ok: r.ok, id, sessionId: payload.originSession || "", error: rb?.error });
    } catch (err) {
      return send(res, 502, { ok: false, error: String(err?.message ?? err) });
    }
  });

  post("/mesh/api/probe", async (req, res) => {
    const body = await readJson(req);
    const found = findPeer(String(body?.peer ?? "").trim());
    if (found.error) return send(res, 404, { ok: false, error: found.error });
    const target = found.peer;
    try {
      const r = await peerFetch(target, "/mesh/v1/hello", {
        headers: { "X-Dsh-Mesh-Token": currentSecret() },
        timeoutMs: 6000,
      });
      const rb = await r.json().catch(() => ({}));
      return send(res, 200, { ok: true, reachable: r.ok, paired: rb?.peerPaired === true, remote: rb });
    } catch (err) {
      return send(res, 200, { ok: true, reachable: false, paired: false, error: String(err?.message ?? err) });
    }
  });

  post("/mesh/api/web-url", async (req, res) => {
    if (!requireExperimental(res)) return;
    const body = await readJson(req);
    const found = findPeer(String(body?.peer ?? "").trim());
    if (found.error) return send(res, 404, { ok: false, error: found.error });
    const target = found.peer;
    try {
      const r = await peerFetch(target, "/mesh/v1/web-url", {
        headers: { "X-Dsh-Mesh-Token": currentSecret() },
        timeoutMs: 5000,
      });
      const rb = await r.json().catch(() => ({}));
      // 400/404 = 对端是老版本插件，没有这条路由。如实区分"不支持"和"取不到"。
      if (!r.ok || rb?.ok !== true || typeof rb?.url !== "string") {
        return send(res, 200, {
          ok: false,
          supported: rb?.supported === true,
          error: rb?.error || `对端 HTTP ${r.status}`,
        });
      }
      return send(res, 200, {
        ok: true,
        url: rb.url,
        bind: rb.bind ?? "",
        lanReachable: rb.lanReachable === true,
        port: rb.port ?? 0,
      });
    } catch (err) {
      return send(res, 200, { ok: false, supported: false, error: String(err?.message ?? err) });
    }
  });

  // ── 对端 DSH Web 的应用内面板（回环反代 + 服务端认证）─────────────────
  //
  // 为什么不直接把对端地址塞进 iframe：对端会话 cookie 是 SameSite=Strict，
  // 跨站 iframe 里不发送，token 又随对端重启轮换 —— 页面会永远停在 401。
  // 所以认证搬到服务端：代理用 token 换一次 cookie，之后每个请求自己带；
  // 浏览器只跟本机 127.0.0.1 的这个端口说话。
  const webPanels = new Map(); // 机器名 -> { proxy, remote }

  // 对端会话 cookie 落盘：token 每次重启都会轮换，而 cookie 是 30 天、由对端
  // 持久密钥签名的 —— 存住它就等于以后不必再问 token（到期或换密钥再补一次）。
  const panelStatePath = () => join(stateDir(), "web-panels.json");
  const readPanelCookies = () => {
    try {
      const value = JSON.parse(readFileSync(panelStatePath(), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };
  const writePanelCookie = (origin, cookie) => {
    try {
      const all = readPanelCookies();
      all[origin] = cookie;
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(panelStatePath(), JSON.stringify(all, null, 2));
    } catch (err) {
      warn(`保存对端 cookie 失败：${err?.message ?? err}`);
    }
  };

  const closeWebPanels = async () => {
    const entries = [...webPanels.values()];
    webPanels.clear();
    for (const entry of entries) {
      try {
        await entry.proxy.close();
      } catch (err) {
        warn(`关闭 Web 面板代理失败：${err?.message ?? err}`);
      }
    }
  };
  ctx.effect(() => () => {
    void closeWebPanels();
  });

  /** 取对端的 Web 地址与启动 token；老版本对端只能退回按约定拼地址。 */
  /**
   * 取对端的 Web 地址与启动 token。
   * @param target - 对端名片
   * @param tokenOverride - 调用方手工给的 token（对端插件还没升级时的逃生口）
   */
  async function resolveWebTarget(target, tokenOverride = "") {
    // 优先：对端开了 desktopWebPort 时，会有一条 /mesh/web/ 前缀转发到它自己的
    // 另一个引擎（桌面 App 那个，有历史会话）。有就直接用它，认证在对端完成。
    // 端点可能有多个（局域网 + tailnet），且顺序会变 —— 逐个试，别只认第一个。
    for (const ep of orderedEndpoints(target)) {
      if (!ep?.host) continue;
      const base = `http://${ep.host}:${WEB_PANEL_DEFAULT_PORT}`;
      try {
        const probe = await fetch(`${base}${DESKTOP_WEB_PREFIX}/__probe`, { signal: AbortSignal.timeout(2000) });
        const body = await probe.json().catch(() => ({}));
        if (probe.ok && body?.ok === true) {
          return {
            remoteBase: `${base}/`,
            pathPrefix: DESKTOP_WEB_PREFIX,
            passthrough: true,
            lanReachable: true,
            note: `转发到对端 ${body.target}`,
          };
        }
      } catch {
        /* 这条端点不通，试下一条 */
      }
    }

    let remoteBase = "";
    let token = tokenOverride;
    let lanReachable;
    let note = "";
    try {
      const r = await peerFetch(target, "/mesh/v1/web-url", {
        headers: { "X-Dsh-Mesh-Token": currentSecret() },
        timeoutMs: 5000,
      });
      const rb = await r.json().catch(() => ({}));
      if (rb?.ok === true && typeof rb.url === "string") {
        const parsed = new URL(rb.url);
        token = parsed.searchParams.get("token") || token;
        // token 只用来换 cookie，别留在浏览器的地址栏里。
        parsed.searchParams.delete("token");
        remoteBase = parsed.href;
        lanReachable = rb.lanReachable === true;
      } else {
        note = rb?.error ? String(rb.error) : `对端 HTTP ${r.status}`;
      }
    } catch (err) {
      note = String(err?.message ?? err);
    }
    if (!remoteBase) {
      const ep = orderedEndpoints(target)[0];
      if (!ep?.host) return { error: note || "对端没有上报地址" };
      remoteBase = `http://${ep.host}:${WEB_PANEL_DEFAULT_PORT}/`;
    }
    if (!token) note = note || "对端没有给出 token（对端插件需升级到带 /mesh/v1/web-url 的版本）";
    return { remoteBase, token, lanReachable, note };
  }

  post("/mesh/api/web-panel", async (req, res) => {
    if (!requireExperimental(res)) return;
    const body = await readJson(req);
    const found = findPeer(String(body?.peer ?? "").trim());
    if (found.error) return send(res, 404, { ok: false, error: found.error });
    const target = found.peer;
    const machine = target.machine || String(body?.peer ?? "");

    const resolved = await resolveWebTarget(
      target,
      typeof body?.token === "string" ? body.token.trim() : "",
    );
    if (resolved.error) return send(res, 400, { ok: false, error: resolved.error });

    const signature = `${resolved.remoteBase}|${resolved.pathPrefix || ""}|${resolved.passthrough ? "p" : "c"}`;
    try {
      const existing = webPanels.get(machine);
      if (existing && existing.signature === signature) {
        return send(res, 200, {
          ok: true,
          url: existing.proxy.url,
          remote: existing.proxy.remote,
          hasSession: existing.proxy.hasSession(),
          note: resolved.note,
          lanReachable: resolved.lanReachable,
        });
      }
      if (existing) {
        webPanels.delete(machine);
        await existing.proxy.close();
      }
      const proxy = await createWebProxy({
        remoteBase: resolved.remoteBase,
        token: resolved.token,
        nonce: randomBytes(18).toString("base64url"),
        initialCookie: readPanelCookies()[resolved.remoteBase] || "",
        onCookie: (cookie) => writePanelCookie(resolved.remoteBase, cookie),
        pathPrefix: resolved.pathPrefix || "",
        passthrough: resolved.passthrough === true,
        log,
        warn,
      });
      webPanels.set(machine, { proxy, remote: resolved.remoteBase, signature });
      return send(res, 200, {
        ok: true,
        url: proxy.url,
        remote: proxy.remote,
        hasSession: proxy.hasSession(),
        note: resolved.note,
        lanReachable: resolved.lanReachable,
      });
    } catch (err) {
      return send(res, 502, { ok: false, error: String(err?.message ?? err) });
    }
  });

  post("/mesh/api/web-panel/close", async (req, res) => {
    const body = await readJson(req);
    const machine = String(body?.peer ?? "").trim();
    const entry = webPanels.get(machine);
    if (entry) {
      webPanels.delete(machine);
      try {
        await entry.proxy.close();
      } catch (err) {
        warn(`关闭 Web 面板代理失败：${err?.message ?? err}`);
      }
    }
    return send(res, 200, { ok: true });
  });

  // ── 「本机另一个引擎」的前缀转发（desktopWebPort > 0 才开）────────────
  //
  // 同一台机器上通常有两个引擎：桌面 App（有历史会话，只听 loopback）和
  // CLI/web 引擎（就是我们）。手机要看的往往是前者，所以这里开一条
  // `/mesh/web/...`：去掉前缀转发到 127.0.0.1:<desktopWebPort>，并自带
  // 签名 cookie（密钥与那个引擎共用，见 desktop-auth.js）。
  if (typeof config.desktopWebPort === "number" && config.desktopWebPort > 0) {
    const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
    const secretOf = createSecretReader(join(dshHome, ".credentials.yaml"));
    const targetPort = config.desktopWebPort;
    const handle = createDesktopWebForwarder({ port: targetPort, secretOf, log, warn });
    ctx.effect(() =>
      ctx.webServer.register({
        kind: "prefix",
        path: DESKTOP_WEB_PREFIX,
        handler: async (req, res) => {
          if (!experimentalRemoteEnabled(config)) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end("experimental remote control disabled\n");
            return;
          }
          try {
            await handle(req, res);
          } catch (err) {
            warn(`桌面引擎转发异常：${err?.message ?? err}`);
            if (!res.headersSent) {
              res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
              res.end("monitor forwarder failed\n");
            }
          }
        },
      }),
    );
    // 流式载波（WebSocket）：工作区/会话的实时数据走它，缺了这条前端会一直"自动重连中"。
    const upgrade = createDesktopWebUpgrade({ port: targetPort, secretOf, log, warn });
    ctx.effect(() => ctx.webServer.registerUpgrade({ path: DESKTOP_WEB_STREAM_PATH, handler: upgrade }));
    log(`已开启本机引擎转发：${DESKTOP_WEB_PREFIX}/* → 127.0.0.1:${targetPort}（含 ${DESKTOP_WEB_STREAM_PATH}）`);
  }

  // ── 应用内 SSH 终端 ───────────────────────────────────────────────────
  //
  // 入口在设备行（与「访问 DSH Web」同一位置）。会话由本机发起，凭据只存本机；
  // 传输走同源 WebSocket（/mesh/api/ssh/ws），所以不需要经过上面对端的 web 转发。
  const ssh = createSshManager({
    stateDir: stateDir(),
    credentialsPath: join(stateDir(), "ssh-credentials.json"),
    log,
    warn,
  });
  ctx.effect(() => () => ssh.closeAll());

  post("/mesh/api/ssh/known", async (req, res) => {
    if (!requireExperimental(res)) return;
    const body = await readJson(req);
    const machine = String(body?.machine ?? "").trim();
    // 只回用户名与"是否已部署密钥"，不回密码：密码没有再穿过一次网络的理由
    const info = ssh.describe(machine);
    return send(res, 200, { ok: true, username: info.username, hasKey: info.hasKey, saved: !!info.username });
  });

  post("/mesh/api/ssh/sessions", (_req, res) => {
    if (!requireExperimental(res)) return;
    return send(res, 200, { ok: true, sessions: ssh.list() });
  });

  // 一条 upgrade 路由承载所有终端（按会话 id 多路复用）
  const sshUpgrade = (req, socket, head) => {
    if (!experimentalRemoteEnabled(config)) {
      socket.destroy();
      return;
    }
    const chan = acceptUpgrade(req, socket, head, {
      onMessage: async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        try {
          if (msg?.type === "open") {
            const cols = Number(msg.cols) > 0 ? Number(msg.cols) : 80;
            const rows = Number(msg.rows) > 0 ? Number(msg.rows) : 24;
            // 地址不要直接信客户端传来的 peer.host：端点顺序会变（tailnet 可能排前面），
            // 用 tailnet 地址去连 22 端口会卡到 "timed out waiting for handshake"。
            // 这里按 discover 的端点表优先挑局域网地址，其次才用它给的。
            const machine = String(msg.machine ?? "");
            let host = String(msg.host ?? "");
            try {
              const found = machine ? findPeer(machine) : { error: "缺少机器名" };
              const target = found && found.peer;
              if (target) {
                const eps = orderedEndpoints(target);
                const isPrivate = (h) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(h ?? ""));
                host = (eps.find((e) => isPrivate(e.host)) ?? eps.find((e) => e.host))?.host ?? host;
              }
            } catch {
              /* 解析失败就用客户端给的地址 */
            }
            const id = await ssh.open({
              host,
              port: Number(msg.port) > 0 ? Number(msg.port) : 22,
              username: String(msg.username ?? ""),
              password: typeof msg.password === "string" ? msg.password : "",
              cols,
              rows,
              machine,
            });
            chan.send(JSON.stringify({ type: "ready", id, buffer: ssh.ring(id) }));
            ssh.subscribe(id, (chunk) => {
              chan.send(JSON.stringify(chunk === null ? { type: "exit", id } : { type: "data", id, data: chunk }));
            });
            return;
          }
          const id = String(msg?.id ?? "");
          if (msg?.type === "input") ssh.write(id, String(msg.data ?? ""));
          else if (msg?.type === "resize") ssh.resize(id, Number(msg.cols) || 80, Number(msg.rows) || 24);
          else if (msg?.type === "close") ssh.close(id);
        } catch (error) {
          chan.send(JSON.stringify({ type: "error", message: String(error?.message ?? error) }));
        }
      },
    });
  };
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: "/mesh/api/ssh/ws", handler: sshUpgrade }));

  log("UI 接口已挂载: /mesh/api/state|refresh|secret|send|probe|web-url|web-panel|ssh");
}
