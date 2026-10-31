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
import { buildDiagnostics, entryInfo, readPackageVersion } from "./diagnostics.js";
import { buildUpdateReport, compareVersions, fetchLatestVersion, pluginDirFromUrl } from "./update.js";
import {
  clearUpgradeMarker,
  installUpdate,
  readUpgradeMarker,
  requestHostReload,
  requestHostRestart,
  trustedControlRequest,
} from "./upgrade.js";
import { buildPrompt } from "./prompt.js";
import { matchLeadingMentions, buildAtPrompt } from "./at-mention.js";
import { resolvePairing } from "./pairing.js";
import {
  applyMeshSwitch,
  describeMeshSwitch,
  normalizeSwitchScope,
  resolveMeshSwitch,
  MESH_SWITCH_LABEL,
} from "./switch.js";
import {
  loadTaskHistory,
  saveTaskHistory,
  loadPeerSnapshot,
  savePeerSnapshot,
} from "./persist.js";
import { TsnetNode, channelKey, channelSignature } from "./tsnet/manager.js";
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

const VERSION = "0.5.8";
// 诊断用：进程启动时间 + 入口真实路径。磁盘上的版本**不在这里缓存** ——
// 升级之后进程还跑旧代码，版本号必须现读磁盘才能立刻反映出来（真踩过：
// 磁盘升到 0.5.1，进程还在 0.5.0，界面显示 0.5.0）。
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const ENTRY_INFO = entryInfo(import.meta.url);
/** 本插件的安装目录：一键升级要在这里替换文件，手工命令也用它填路径。 */
const PLUGIN_DIR = pluginDirFromUrl(import.meta.url);
/** 一次性取文件用的 nonce：进程每次启动都换，写进日志给运维/agent 取。 */
const FILE_TRANSFER_NONCE = randomBytes(9).toString("base64url");
const RULE_ID = "mesh-inbound";
const RULE_KIND = "mesh";
const MAX_BODY = 256 * 1024;
const MAX_HISTORY = 200;
/** 默认固定端口：内网里"扫这个端口 + ping 一下"就能建立连接，无需任何配置。 */
export const MESH_DEFAULT_PORT = 45917;
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
 * 传输开关（一键关闭）：`true` = 这条路径可用。
 *
 * 由 applyUnsafe 按 state.json 里的 `shutdown` 维护，发送路径（peerFetch）、
 * 扫描（runScan / scanTailnet）、保活（pingKnownPeers）都读它 —— 关掉一条
 * 路径之后，不能再"从别的地方偷偷用它"：那正是这类开关最典型的 bug
 * （界面显示已关闭，实际还在发包）。
 *
 * 放模块级的原因和 activeDiscovery 一样：peerFetch / runScan / pingKnownPeers
 * 都是模块级函数，而开关状态属于本次挂载的实例。
 */
export const transportGate = { lan: true, internet: true };

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
  /** 对端任务新建会话的工作目录；留空用用户主目录 */
  workspaceRoot: z.string().default(""),

  // ── 聊天窗口 @ 派发 ──
  /**
   * 聊天窗口里 `@` 一台在线机器后，发送时把这段正文直接派发过去（默认开）。
   *
   * 关掉后 `@` 只当普通文本：想自己决定派不派、或者让本机 agent 用 mesh_run
   * 时用它。识别规则只有一条 —— **消息开头**的 @机器名（见 lib/at-mention.js）。
   */
  atDispatch: z.boolean().default(true),

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

  const resolved = resolveMachineName(config);
  const identity = { name: resolved.name, source: resolved.source };
  ensureSecret();
  const instanceId = resolveInstanceId();
  const log = (m) => ctx.logger?.info?.(`mesh: ${m}`);
  const warn = (m) => ctx.logger?.warn?.(`mesh: ${m}`);

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

  const discovery = new MeshDiscovery({
    id: instanceId,
    port: 0,
    meta: {
      machine: identity.name,
      user: safeUser(),
      profile: process.env.DSH_PROFILE ?? "",
      version: VERSION,
      // 认领指纹：对端 state.json 丢了/插件重装时，靠它认出"这是同一台物理机"，
      // 从而立刻顶掉旧记录而不是多出一条重名。见 lib/identity.js 里
      // 为什么不用 MAC 当身份（多网卡 / 随机 MAC / Android 拿不到）。
      fingerprint: machineFingerprint(),
    },
    intervalMs: config.announceIntervalMs,
    ttlMs: config.peerTtlMs,
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

  /** 诊断块：进程自述版本 / 磁盘版本 / 入口 mtime / 安全字段的配置 / 能力摘要。 */
  const diagnosticsPayload = () =>
    buildDiagnostics({
      version: VERSION,
      packageVersion: readPackageVersion(import.meta.url),
      entry: ENTRY_INFO.path,
      entryMtimeMs: ENTRY_INFO.mtimeMs,
      startedAt: PROCESS_STARTED_AT,
      machine: identity.name,
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      config,
      capabilities: currentCapabilities(),
    });

  // ── 一键关闭（kill switch）的运行时 ──
  //
  // 三条原则：
  //   1. **不卸载插件、不注销 UI 路由**。关掉之后面板还得能打开 —— 否则
  //      「一键关闭」就成了「一键把自己锁在外面」。
  //   2. 关掉一条路径之后，任何出站/入站都不能再偷偷用它（发送、扫描、ping、
  //      对端 HTTP 都读 transportGate）。这类开关最典型的 bug 就是界面显示
  //      已关闭、实际还在发包。
  //   3. 期望状态和真实状态**分开回报**。重绑回环失败时界面必须看得见，
  //      不能拿"用户点了关闭"当"已经关好了"。
  //
  // 局域网关 = 组播停发、不再扫本网段 / ping，对端端口从 0.0.0.0 收回 127.0.0.1
  // （tailnet 的 sidecar 是反代到本机回环的，所以互联网那半还能用）。
  // 互联网关 = 停掉全部 tailnet sidecar；通道配置保留，打开即恢复。
  // 期望状态写进 state.json 的 shutdown，重启后照旧。
  let switchDesired = resolveMeshSwitch(loadState());
  transportGate.lan = !switchDesired.lan;
  transportGate.internet = !switchDesired.internet;

  /** 当前监听中的对端服务句柄：{ port, host, server }。关闭时为 null。 */
  let peerServer = null;
  /** 上一次成功监听的端口：重开时优先沿用它，别让对端记着的地址失效。 */
  let lastPort = 0;
  /** 互联网是否已经尝试启动过（避免每次点开关都重走一遍 sidecar 启动）。 */
  let internetUp = false;
  /** 本次运行时起的定时器（扫描 / ping），重排时统一清掉。 */
  let runtimeTimers = [];
  /** 每次重排 +1：旧的异步扫描循环靠它自杀，不会在关闭后继续发包。 */
  let lanGeneration = 0;
  /** discovery 当前是否带组播启动（null = 没启动）。 */
  let discoveryMulticast = null;
  /** 运行时偏差说明：非空 = 没能完全按开关执行，界面要显示。 */
  const switchNote = { lan: "", internet: "" };
  /** 开关操作串行化：界面和 agent 可能同时点，不能让两个 reconcile 交错。 */
  let switching = Promise.resolve();

  const serialize = (fn) => {
    const run = switching.then(fn, fn);
    switching = run.then(() => undefined, () => undefined);
    return run;
  };

  const shutRuntimeTimers = () => {
    for (const t of runtimeTimers) clearInterval(t);
    runtimeTimers = [];
  };

  /**
   * 关掉对端服务并等它真正释放端口。
   *
   * 必须等 close 回调：紧接着就要在同一端口用另一个地址重新 listen，
   * 不等的话会撞 EADDRINUSE，重绑静默失败 —— 那正是"显示关了、其实还开着"。
   * 1.5s 兜底：极端情况下不让开关卡死。
   */
  const closePeerServer = () =>
    new Promise((resolveClose) => {
      const handle = peerServer;
      peerServer = null;
      if (!handle) {
        resolveClose();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolveClose();
      };
      try {
        handle.server.closeAllConnections?.();
      } catch {
        /* 老版本 Node 没有这个方法 */
      }
      try {
        handle.server.close(done);
      } catch {
        done();
      }
      const t = setTimeout(done, 1500);
      t.unref?.();
    });

  /**
   * 起 / 重绑对端服务。`bindHost` 决定局域网是否可达：
   *   0.0.0.0   → 局域网可连（局域网打开时）
   *   127.0.0.1 → 只有本机（和 sidecar 反代）能连
   *
   * 重绑沿用**上一次的真实端口**，否则对端记着的地址、tailnet 的 forward 全部失效。
   */
  const ensurePeerServer = async (bindHost) => {
    if (peerServer && peerServer.host === bindHost) return peerServer;
    const keepPort = peerServer ? peerServer.port : lastPort || undefined;
    await closePeerServer();
    const handle = await startPeerServer(ctx, {
      config,
      discovery,
      inbound,
      outbound,
      log,
      warn,
      waker,
      threadState,
      capFor,
      capOverrides,
      throttled,
      onHistoryChange: scheduleHistorySave,
      diagnostics: diagnosticsPayload,
      port: keepPort,
      bindHost,
    });
    peerServer = handle;
    lastPort = handle.port;
    discovery.setPort(handle.port);
    return handle;
  };

  /**
   * 起互联网（tailnet）通道。
   *
   * 串行启动：每条 sidecar 首次都要下载 30MB 二进制，并发会互相抢。
   * 一条失败不影响其它条，也不影响局域网 —— 这是硬要求。
   */
  const ensureInternet = async (reason = "") => {
    if (!transportGate.internet) return;
    const channels = effectiveTailnetChannels(config).filter((c) => c.enabled);
    if (channels.length === 0) {
      log("互联网自组网未启用（没有启用的 tailnet 通道）");
      return;
    }
    internetUp = true;
    switchNote.internet = "";
    for (const channel of channels) {
      if (!transportGate.internet) {
        // 启动途中被关掉：立刻收手，并把可能已经拉起来的 sidecar 收干净
        await stopTailnetChannel(channel.id, discovery).catch(() => 0);
        return;
      }
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
        switchNote.internet = `通道「${channel.label}」启动失败：${err?.message ?? err}`;
      }
    }
    if (!transportGate.internet) return;
    // 所有通道都起来之后再扫一轮，让 tailnet 设备尽快进列表
    await scanTailnet({
      discovery,
      config,
      log,
      reason: reason || "tailnet 启动扫描",
      ports: scanPortList(discovery, config),
    }).catch(() => {});
  };

  /**
   * 局域网发现：启动扫描（含退避重试）与周期扫描。
   * ping 保活由 syncRuntime 统一管（互联网开着也要 ping）。
   */
  const startLanDiscovery = () => {
    const gen = lanGeneration;
    if (config.scanOnStart) {
      // 启动扫描常常抢在对方起来之前跑完，所以没找到就退避重试几次。
      // 这直接决定"刚装好能不能自动发现"，值得多试几下。
      const delays = [0, 8000, 20000, 45000];
      (async () => {
        for (let i = 0; i < delays.length; i += 1) {
          if (gen !== lanGeneration || !transportGate.lan) return;
          if (delays[i] > 0) await sleep(delays[i]);
          if (gen !== lanGeneration || !transportGate.lan) return;
          await runScan({ discovery, config, log, warn, reason: `启动扫描#${i + 1}` });
          if (discovery.peers().length > 0) return; // 找到了就不再重试
        }
        log("启动扫描未发现对端；之后靠组播与周期扫描继续尝试");
      })().catch(() => {});
    }
    if (config.scanIntervalMs > 0) {
      const t = setInterval(
        () => runScan({ discovery, config, log, warn, reason: "周期扫描" }).catch(() => {}),
        config.scanIntervalMs,
      );
      t.unref?.();
      runtimeTimers.push(t);
    }
  };

  /**
   * 把运行时对齐到期望的开关状态。幂等：启动时调一次，之后每次开关都调。
   */
  const syncRuntime = async ({ reason = "" } = {}) => {
    lanGeneration += 1;
    shutRuntimeTimers();
    const wantLan = !switchDesired.lan;
    const wantNet = !switchDesired.internet;
    transportGate.lan = wantLan;
    transportGate.internet = wantNet;

    // ── 互联网 ──
    if (!wantNet) {
      const stopped = await stopTailnetChannel("", discovery).catch(() => 0);
      internetUp = false;
      switchNote.internet = "";
      if (stopped > 0) log(`互联网 mesh 已关闭：停止 ${stopped} 条 tailnet 通道（通道配置保留）`);
    }

    // ── 局域网 ──
    if (!wantLan && !wantNet) {
      await closePeerServer();
      if (discoveryMulticast !== null) {
        discovery.stop();
        discoveryMulticast = null;
      }
      switchNote.lan = "";
    } else {
      // 互联网开着就必须留着对端服务（tailnet 入站靠 sidecar 反代到本机回环）
      const bindHost = wantLan ? "0.0.0.0" : "127.0.0.1";
      try {
        await ensurePeerServer(bindHost);
        switchNote.lan = "";
      } catch (err) {
        switchNote.lan = `对端服务未能监听 ${bindHost}:${discovery.port || "?"} —— ${err?.message ?? err}`;
        warn(switchNote.lan);
      }
      // 组播只在局域网打开时启用：关掉之后连收包都不做。
      const multicast = wantLan && config.useMulticast !== false;
      if (discoveryMulticast !== multicast) {
        if (discoveryMulticast !== null) discovery.stop();
        discovery.start({ multicast });
        discoveryMulticast = multicast;
      }
      if (multicast) {
        discovery.announceNow();
      } else if (wantNet) {
        log("局域网 mesh 已关闭：不广播、不扫本网段，对端端口只绑回环");
      } else {
        log("已关闭组播，仅使用主动扫描 + ping");
      }
      if (wantLan) startLanDiscovery();
    }

    // ── 互联网启动（后台跑：首次要下载 sidecar，不能让界面/接口干等）──
    if (wantNet && !internetUp) {
      void ensureInternet(reason).catch((err) => warn(`互联网通道启动异常：${err?.message ?? err}`));
    }

    // ── ping 保活：只要还有一条通道活着就要跑；pingKnownPeers 自己按开关过滤 ──
    if ((wantLan || wantNet) && config.pingIntervalMs > 0) {
      const t = setInterval(
        () => pingKnownPeers({ discovery, config, warn }).catch(() => {}),
        config.pingIntervalMs,
      );
      t.unref?.();
      runtimeTimers.push(t);
    }
  };

  /**
   * 对外回报的开关状态：期望值 + 真实运行情况 + 偏差说明。
   * 界面和 agent 都读这一份，避免两处各编一套说法。
   */
  const switchStatus = () => {
    const lanOff = switchDesired.lan;
    const netOff = switchDesired.internet;
    const bind = peerServer?.host ?? "";
    let lanNote = switchNote.lan;
    // 说得到就要做得到：关闭状态下如果还听着 0.0.0.0，必须明说。
    if (lanOff && bind && bind !== "127.0.0.1" && bind !== "::1" && bind !== "::ffff:127.0.0.1") {
      lanNote = lanNote || "端口仍对局域网开放（未能收回回环，检查端口占用）";
    }
    const running = runningTailnetNodes().length;
    // 互联网侧的真实麻烦（连不上控制面 / 授权码失效）必须出现在这里：
    // 「开启但没连上」如果只说成"未连接"，用户会以为是正常在等。
    const stalled = [...tailnetNodes.values()]
      .map((n) => n.status())
      .filter((s) => s && s.stalled);
    const internetNote =
      switchNote.internet ||
      (stalled.length > 0
        ? `有 ${stalled.length} 条通道启动受阻：${stalled[0].stalledReason || "控制面没有回应"}` +
          (stalled[0].stalledHint ? `（${stalled[0].stalledHint}）` : "")
        : "");
    return {
      lan: {
        off: lanOff,
        // active 表示"真的在监听"，不是"用户说它开着" —— 绑定失败时要能看出来
        active: !lanOff && Boolean(peerServer),
        bind,
        port: peerServer?.port ?? 0,
        multicast: discoveryMulticast === true,
        note: lanNote,
      },
      internet: {
        off: netOff,
        active: !netOff && running > 0,
        running,
        configured: effectiveTailnetChannels(config).filter((c) => c.enabled).length,
        /** 启动受阻的通道数（卡在控制面/登录，界面要说话，不能一直转圈） */
        stalled: stalled.length,
        note: internetNote,
      },
      all: lanOff && netOff,
      at: switchDesired.at,
      by: switchDesired.by,
      summary: describeMeshSwitch(switchDesired),
    };
  };

  /**
   * 执行一次开关操作（界面按钮与 mesh_switch 工具共用）。
   *
   * 先落盘再动运行时：写盘失败时**不**去停服务，避免"这一秒关了、重启又开着"
   * 这种更糟的半态。
   */
  const setSwitch = (opts = {}) =>
    serialize(async () => {
      const scope = normalizeSwitchScope(opts.scope);
      if (!scope) throw new Error(`未知的开关范围：${String(opts.scope)}（应为 all / lan / internet）`);
      const next = applyMeshSwitch(switchDesired, { scope, off: opts.off, by: opts.by ?? "ui" });
      const before = { lan: switchDesired.lan, internet: switchDesired.internet };
      saveState({ shutdown: next });
      switchDesired = resolveMeshSwitch({ shutdown: next });
      const changed = before.lan !== switchDesired.lan || before.internet !== switchDesired.internet;
      if (changed) {
        const label = MESH_SWITCH_LABEL[scope] ?? scope;
        log(`一键关闭「${label}」→ ${describeMeshSwitch(switchDesired)}（来源 ${next.by}，立即生效，重启后保持）`);
        await syncRuntime({ reason: `一键关闭：${label}` });
      }
      return { changed, scope, status: switchStatus() };
    });

  // 1) 按开关状态起对端服务与发现；局域网/互联网各自独立
  (async () => {
    await syncRuntime({ reason: "启动" });
    log(
      `已启动 machine=${identity.name}（来源 ${identity.source}）` +
        ` 文件搬运 nonce=${FILE_TRANSFER_NONCE}` +
        ` 地址=${preferredAddress()}:${discovery.port || "?"} 实例=${instanceId} ` +
        `配对要求=${config.requirePairing ? "开" : "关"} ` +
        `开关=${describeMeshSwitch(switchDesired)}`,
    );
    if (switchDesired.all) {
      log("上次退出前处于「全部关闭」状态：保持关闭，Mesh 面板里可以重新打开");
    }
  })().catch((err) => warn(`对端服务启动失败，发现功能未启用: ${err?.message ?? err}`));

  // 2) 入站唤醒：注册一次 webhook 规则，之后每个任务只 dispatch
  setupInbound(ctx, config, log, warn, waker);

  /** 一键关闭的对外门面：UI 路由与 agent 工具共用同一份实现。 */
  const meshSwitch = { status: switchStatus, set: setSwitch };

  // 3) agent 工具
  registerTools(ctx, { discovery, config, inbound, outbound, log, warn, threadState, hostDispatched, onHistoryChange: scheduleHistorySave, meshSwitch });

  // 4) UI 接口
  registerUiRoutes(ctx, { discovery, config, identity, inbound, outbound, log, warn, threadState, hostDispatched, capFor, capOverrides, throttled, waker, onHistoryChange: scheduleHistorySave, diagnostics: diagnosticsPayload, meshSwitch });

  // 5) 聊天窗口 @ 设备：消息以 @机器名 开头时，发送即派发到那台机器
  registerAtMentions(ctx, { discovery, identity, config, outbound, threadState, hostDispatched, log, warn, onHistoryChange: scheduleHistorySave, meshSwitch });

  ctx.effect(() => () => {
    // 卸载时一并收干净：定时器、对端端口、tailnet sidecar。
    // 一键关闭只是"暂停"，卸载才是"拆走"。
    lanGeneration += 1;
    shutRuntimeTimers();
    void closePeerServer();
    for (const node of tailnetNodes.values()) node.stop().catch(() => {});
    tailnetNodes.clear();
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

/**
 * 对端「收下了但没唤醒 agent」的入站状态。
 *
 * 这三种都不算投递失败（消息在收件箱里），但**用户会以为任务跑了** ——
 * 聊天窗口 @ 派发要把它们翻成一句人话（见 at-mention.js 的 buildAtPrompt）。
 */
const NOT_WOKEN_STATUS = new Set(["noted-only", "stored-only", "throttled"]);

/**
 * 在「同名时优先选唯一在线的那台」规则下解析一个派发目标。
 *
 * `/mesh/api/send`、`mesh_run` 和聊天窗口 @ 三条路共用同一套判断 —— 名字是
 * 用户手填的，可能重复，随便挑一台就会把任务派到错的机器上。
 *
 * @returns {{ peer: object } | { error: string }} 失败时 `error` 是给人看的中文原因。
 */
function resolvePeerTarget(discovery, name) {
  const matches = findPeersByName(discovery, name);
  if (matches.length === 0) return { error: `找不到机器 ${name}` };
  if (matches.length > 1) {
    // 重名时优先选**唯一在线**的那台：对端重启后 instanceId 变了，旧记录要等
    // keepMs 才过期，此时目标是明确的。只有"在线的也不止一台"才需要用户指定。
    const online = matches.filter((p) => p.online);
    if (online.length === 1) return { peer: online[0] };
    return { error: `名字 "${name}" 匹配到 ${matches.length} 台机器，请用 <ip>:<port> 指定` };
  }
  return { peer: matches[0] };
}

/**
 * 宿主替用户派发一条任务到某台机器（`/mesh/api/send` 与聊天窗口 @ 共用）。
 *
 * 与 `mesh_run` 的差别只在入口：这里不拼提示词、不做工具参数校验，只负责
 * 「先绑定会话键 → HTTP 派发 → 记流水」。绑定必须在 HTTP **之前**，因为对端
 * 可能先回执；失败也保留绑定（超时不等于没送到）。
 *
 * @param {object} deps 需要 discovery / config / outbound / threadState / onHistoryChange。
 * @param {object} input target、task、thread、originSession、noWake、newSession、workspace。
 * @returns {Promise<{ ok: boolean, id: string, error?: string, conflict?: string }>}
 */
async function dispatchTaskToPeer(
  { discovery, config, outbound, threadState, hostDispatched, onHistoryChange },
  input,
) {
  const target = input.target;
  const id = input.id ? String(input.id) : `t-${randomBytes(6).toString("hex")}`;
  const payload = {
    id,
    from: `${machineOf(discovery)}/${safeUser()}`,
    fromMachine: machineOf(discovery),
    task: String(input.task ?? ""),
    thread: String(input.thread ?? ""),
    noWake: input.noWake === true,
    newSession: input.newSession === true,
    workspace: input.workspace ? String(input.workspace) : "",
    originSession: input.originSession ? String(input.originSession) : "",
    // 人手动派发的（聊天窗口 @ / Mesh 面板「派发任务」）。
    // 对端据此跳过"太短 / 纯寒暄"闸门 —— 那道闸门是给 agent 互刷准备的，
    // 不是用来吞掉人敲的一句「看下磁盘」的。
    human: input.human === true,
  };
  // 没给 thread 就自己生成一个：没有 thread → 没有会话键 → 对端回执只能新开会话。
  if (!payload.thread) payload.thread = `ui-${id}`;

  const replyKey = conversationKey({ fromMachine: target.machine, thread: payload.thread });
  if (replyKey && payload.originSession) {
    if (pendingByConv.has(replyKey)) {
      return { ok: false, id, conflict: "pending", error: "此 thread 正在建立会话，请稍后重试" };
    }
    const previous = threadState.get(replyKey);
    if (previous?.sessionId && previous.sessionId !== payload.originSession) {
      return { ok: false, id, conflict: "bound", error: "该 thread 已绑定另一会话，请换一个 thread" };
    }
    threadState.set(replyKey, { ...previous, wakesAt: previous?.wakesAt ?? [], sessionId: payload.originSession });
    saveThreads(threadState);
    hostDispatched.set(payload.thread, Date.now());
    // 顺手清理过期条目，别让它无限增长
    for (const [thread, at] of hostDispatched) {
      if (Date.now() - at > 3600_000) hostDispatched.delete(thread);
    }
  }

  try {
    const r = await peerFetch(target, "/mesh/v1/task", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dsh-Mesh-Token": currentSecret() },
      body: JSON.stringify(payload),
      timeoutMs: input.timeoutMs ?? config.requestTimeoutMs,
    });
    const rb = await r.json().catch(() => ({}));
    // 对端"收下了但没唤醒 agent"要能看出来。旧版本对端不回 status，
    // 这时只能当"已派发"（绝不倒过来假装失败 —— 送达是事实）。
    const notWoken = NOT_WOKEN_STATUS.has(String(rb?.status ?? ""))
      ? { status: String(rb.status), reason: String(rb?.routeDecision ?? "") }
      : null;
    outbound.push({
      ...payload,
      toMachine: target.machine,
      at: new Date().toISOString(),
      ok: r.ok,
      status: r.status,
      remoteStatus: rb?.status ?? "",
      ...(notWoken ? { noted: true, note: notWoken.reason } : {}),
    });
    onHistoryChange?.();
    if (outbound.length > MAX_HISTORY) outbound.shift();
    if (!r.ok) {
      return {
        ok: false,
        id,
        status: r.status,
        error:
          String(rb?.error ?? `HTTP ${r.status}`) +
          (r.status === 403 ? "（对端开启了 requirePairing 且两端配对码不一致 —— 在「配对码」里对齐）" : ""),
      };
    }
    return { ok: true, id, status: r.status, noted: notWoken };
  } catch (err) {
    outbound.push({
      ...payload,
      toMachine: target.machine,
      at: new Date().toISOString(),
      ok: false,
      error: String(err?.message ?? err),
    });
    onHistoryChange?.();
    if (outbound.length > MAX_HISTORY) outbound.shift();
    return { ok: false, id, error: err?.name === "TimeoutError" ? "派发超时（对方可能仍在处理）" : String(err?.message ?? err) };
  }
}

/**
 * 聊天窗口 @ 设备：消息以 @机器名 开头时，把正文直接派发到那台机器。
 *
 * 与 `/mesh/api/send` 走同一份派发实现，只是入口不同：用户在 composer 里
 * 打 @、从菜单里选中在线设备，发送时就等于把这句正文交给了那台机器。
 * 识别规则与失败文案在 lib/at-mention.js（纯逻辑，单测覆盖）。
 *
 * 三条必须守住的边界：
 *   1. 只认**消息开头**的 @；正文中间的 @ 不自动派发（多半是"提到某台机器"）。
 *   2. 派发失败必须说出来，并且明确"没有在本机执行" —— 静默失败会让人以为
 *      任务已经在对面跑了，或者让 agent 顺手在本机把远端任务执行一遍。
 *   3. 同一条消息只派发一次：pre-step 在某些路径上会拿到同一批 claimed 消息，
 *      按 message.id 记账即可（改写后的正文里已经没有 @ 了，但重试路径拿到的
 *      仍是原始消息）。
 */
function registerAtMentions(
  ctx,
  { discovery, identity, config, outbound, threadState, hostDispatched, log, warn, onHistoryChange, meshSwitch },
) {
  // 派发依赖集中一份：dispatchTaskToPeer 与 /mesh/api/send 用同一组入参。
  const deps = { discovery, config, outbound, threadState, hostDispatched, onHistoryChange };
  if (config.atDispatch === false) {
    log("聊天窗口 @ 派发已关闭（config.atDispatch = false）");
    return;
  }
  if (typeof ctx?.on !== "function") {
    log("聊天窗口 @ 派发未启用：本机 DSH 没有 agent/pre-step 事件");
    return;
  }

  /** 已派发过的消息 id（上限 200 条，只用来挡 pre-step 的重复投喂）。 */
  const handled = new Set();
  const markHandled = (id) => {
    if (!id) return;
    handled.add(id);
    if (handled.size > 200) handled.delete(handled.values().next().value);
  };

  /** 目前已知的机器名（含离线）：mention 必须先命中一个已知名字。 */
  const knownNames = () =>
    [...new Set([identity.name, ...discovery.peers().map((p) => String(p?.machine ?? "").trim())])].filter(Boolean);

  /**
   * 处理一条消息：认出开头的 @目标 → 派发 → 返回改写后的消息（没有目标时返回 null）。
   *
   * @returns {Promise<object|null>} 改写后的消息；null = 这条消息不需要动。
   */
  async function dispatchMessage(message, agent, signal) {
    const head = Array.isArray(message?.content) ? message.content[0] : undefined;
    if (!head || head.type !== "text" || typeof head.text !== "string") return null;
    const parsed = matchLeadingMentions(head.text, knownNames());
    if (parsed.mentions.length === 0) return null;
    if (message.id && handled.has(message.id)) return null;

    const originSession = agent?.session?.id ? String(agent.session.id) : "";
    const results = [];
    const body = parsed.body;
    for (const mention of parsed.mentions) {
      if (signal?.aborted) break;
      if (!body) {
        results.push({ machine: mention.machine, error: "消息里只有 @ 设备名，没有正文" });
        continue;
      }
      const found = resolvePeerTarget(discovery, mention.machine);
      if (found.error) {
        results.push({ machine: mention.machine, error: found.error });
        continue;
      }
      const target = found.peer;
      if (String(target.machine) === identity.name) {
        results.push({ machine: target.machine, error: "这就是本机，不需要跨机派发" });
        continue;
      }
      if (!target.online) {
        results.push({ machine: target.machine, error: "这台机器当前离线" });
        continue;
      }
      if (meshSwitch && meshSwitch.status().all) {
        results.push({ machine: target.machine, error: "本机 mesh 已全部关闭（局域网 + 互联网）" });
        continue;
      }
      const id = `t-${randomBytes(6).toString("hex")}`;
      const result = await dispatchTaskToPeer(deps, {
        id,
        target,
        task: body,
        // 每条 @ 派发各自一个 thread：回执落回这个会话，不同机器/不同条不串线。
        thread: `at-${id}`,
        originSession,
        // 交互式发送要等人：不能因为一条通道挂着就把用户这一轮卡满 20 秒。
        timeoutMs: Math.min(Number(config.requestTimeoutMs) || 8000, 8000),
        // 聊天窗口里的话是人敲的：对端不该用"太短/寒暄"闸门把它吞成「仅记录」。
        human: true,
      });
      if (result.ok && result.noted) {
        results.push({
          machine: target.machine,
          id: result.id,
          note: result.noted.reason || result.noted.status || "对端没有唤醒 agent",
        });
      } else if (result.ok) {
        results.push({ machine: target.machine, id: result.id });
      } else {
        results.push({ machine: target.machine, error: result.error || "派发失败" });
      }
    }

    markHandled(message.id);
    const summary = results
      .map((r) => (r.id ? `${r.machine}（${r.id}）` : `${r.machine} 未派发：${r.error}`))
      .join("；");
    log(`聊天窗口 @ 派发：${summary}`);
    return {
      ...message,
      content: [{ type: "text", text: buildAtPrompt({ body, results }) }, ...message.content.slice(1)],
    };
  }

  ctx.on(
    "agent/pre-step",
    async ({ agent, messages, signal }, next) => {
      const decision = await next();
      if (!decision || decision.kind === "reject" || !Array.isArray(decision.messages)) return decision;
      let changed = false;
      const rewritten = [];
      for (const message of decision.messages) {
        if (message?.role !== "user" || message?.source?.kind !== "user") {
          rewritten.push(message);
          continue;
        }
        let replaced = null;
        try {
          replaced = await dispatchMessage(message, agent, signal);
        } catch (err) {
          // 派发出错不能让这一轮直接失败：消息原样放行，把原因留在日志里。
          warn(`聊天窗口 @ 派发出错（消息未改写）：${err?.message ?? err}`);
        }
        if (replaced) {
          rewritten.push(replaced);
          changed = true;
        } else {
          rewritten.push(message);
        }
      }
      return changed ? { ...decision, messages: rewritten } : decision;
    },
    { prepend: true },
  );
  log("聊天窗口 @ 设备已就绪（消息以 @机器名 开头时，发送即派发到那台机器）");
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
 * 默认两者完全一致（tailnet 与局域网功能同等级）。留出这个开关是因为信任
 * 边界不同 —— 进局域网要物理接入，进 tailnet 只要拿到授权码；而一旦进网，
 * 对方就能对你所有机器下 mesh_run。只想收紧互联网那一侧就填它。
 */
function permissionPresetFor(config, task) {
  if (task?.transport === "tsnet") return config.tsnetPermissionPreset || config.permissionPreset;
  return config.permissionPreset;
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
    // 提前校验 preset，配错了在启动时就能看到，而不是等收到任务才失败
    try {
      scoped.permissionPresets.resolve(config.permissionPreset);
      const tsnetPreset = config.tsnetPermissionPreset || config.permissionPreset;
      if (tsnetPreset !== config.permissionPreset) scoped.permissionPresets.resolve(tsnetPreset);
      log(
        `入站唤醒已就绪（自包含实现，权限 preset=${config.permissionPreset}` +
          (tsnetPreset !== config.permissionPreset ? `，tailnet=${tsnetPreset}` : "，tailnet 同局域网") +
          "）",
      );
    } catch (err) {
      waker.ready = false;
      warn(`permissionPreset "${config.permissionPreset}" 无效，入站唤醒已停用：${err?.message ?? err}`);
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
function classifyInbound(task, threadState, config, now, capFor, { canInject = false, humanReply = false } = {}) {
  const body = String(task.task ?? "").trim();
  // 人手动派发的（聊天窗口 @ 设备 / 面板「派发任务」），以及**它们的回执**，
  // 不适用下面两道内容闸门：闸门是给 agent 互刷 ping/ack 用的，不是用来吞掉
  // 人敲的一句话（「看下磁盘」4 个字）或它的答案的。
  const humanTask = task.human === true;
  const bypassGates = humanTask || humanReply;

  // 1) 显式豁免：发送方声明"这条只回执，别开跑"
  //
  //    例外：这是**人发起的派发**的回执（humanReply）。人性的期待是"我 @ 了它、
  //    它会答"，而对端 agent 常把自己的结果也标成"回执"→ noWake → 被扣在收件箱
  //    （2026-10-30 真机：dshgo-dsh 的机器状态回报停在 noted-only，会话里看不到）。
  //    回执本身就是用户问题的答案，必须投递。
  if (task.noWake === true && !humanReply) return { wake: false, kind: "noWake", reason: "发送方标记 noWake" };

  // 2) 内容闸门：太短或纯寒暄
  const minChars = config.minTaskChars ?? 24;
  if (!bypassGates && body.length < minChars) {
    return { wake: false, kind: "short", reason: `正文仅 ${body.length} 字符 < minTaskChars(${minChars})` };
  }
  if (!bypassGates && NOTICE_ONLY.test(body)) return { wake: false, kind: "notice", reason: "纯寒暄/回执内容" };

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
    const sameThread = (o) => String(o.toMachine || "") === from && String(o.thread || "") === String(task.thread);
    task.isReply = (outbound ?? []).some(sameThread);
    // 人发起的派发（聊天窗口 @ / 面板手动派发）的回执：即使发送方标了 noWake，
    // 也要投递回会话 —— 那是用户等着的答案，不是可以静默丢掉的寒暄。
    task.humanReply = task.isReply && (outbound ?? []).some((o) => sameThread(o) && o.human === true);
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

  if (task.noWake === true && task.humanReply === true) {
    log(`任务 ${task.id} 标了 noWake，但它是人发起派发的回执：照常投递到会话`);
  }
  const verdict = classifyInbound(task, threadState, config, now, capFor, { canInject, humanReply: task.humanReply === true });
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
  const all = orderedEndpoints(peer);
  if (all.length === 0) throw new Error(`对端 ${peer?.machine ?? "?"} 没有任何已知通道`);

  // 一键关闭掉的路径不许用于出站。
  // 宁可明确说"这条通道关了"，也不要让它退化成"所有通道都失败" —— 后者会让
  // 用户以为对端掉线了，实际是本机自己关的（这类误判在这个项目里踩过）。
  const eps = all.filter((ep) => (ep.transport === "tsnet" ? transportGate.internet : transportGate.lan));
  if (eps.length === 0) {
    const closed = new Set();
    for (const ep of all) {
      const transport = ep.transport === "tsnet" ? "internet" : "lan";
      if (!transportGate[transport]) closed.add(transport === "internet" ? "互联网 mesh" : "局域网 mesh");
    }
    throw new Error(
      `本机已关闭${[...closed].join("、")}，对端 ${peer?.machine ?? "?"} 没有可用通道。` +
        "可在 Mesh 面板「连接 → 一键关闭」里打开后重试。",
    );
  }

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
  // 互联网 mesh 被一键关闭时一律不扫：sidecar 已经停了，扫也只会报一堆
  // "节点未启动"，反而像故障。
  if (!transportGate.internet) return { scanned: 0, found: 0, channels: [], closed: true };
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
  return [...new Set([discovery.port, MESH_DEFAULT_PORT, ...(config.scanPorts ?? [])])].filter((p) => Number(p) > 0);
}

/**
 * 扫本网段的固定端口，命中即登记为对端。
 * 这是"组播被挡时"的兜底路径，也是首次连接最快的方式。
 * tailnet 是并行的第二条路径，见 scanTailnet。
 */
async function runScan({ discovery, config, log, warn, signal, reason = "扫描" }) {
  const port = discovery.port;
  if (!port) return { scanned: 0, found: 0 };
  const addresses = candidateAddresses(config.scanRanges ?? []);
  const ports = scanPortList(discovery, config);
  let lanFound = 0;

  // 局域网 mesh 一键关闭后不再发任何探测包（这是一条真实的出网行为，
  // 不能因为"只是扫描"就留着）。tailnet 那半段仍按各自的开关决定。
  if (!transportGate.lan) {
    log(`${reason}: 局域网 mesh 已关闭，只扫互联网通道`);
    const tailOnly = await scanTailnet({ discovery, config, log, reason, ports });
    return { scanned: tailOnly.scanned, found: tailOnly.found, lan: false, tailnet: tailOnly };
  }

  if (addresses.length === 0) {
    warn(`${reason}: 没有可扫描的地址（检查 scanRanges 是否合法 / 网卡是否存在）`);
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
      const targets = endpoints.filter((ep) => (ep.transport === "tsnet" ? transportGate.internet : transportGate.lan)).filter((ep) => {
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

/**
 * 起一个对端 HTTP 服务。
 *
 * 返回值从"端口号"改成了句柄 `{ port, host, server }`：一键关闭需要把监听
 * 从 0.0.0.0 收回到 127.0.0.1（局域网不可达，tailnet 的 sidecar 反代仍在
 * 本机回环上），恢复时再重新绑回去。没有句柄就没法做这件事。
 *
 * @param options.port 指定端口；省略用 config.port。重绑时传上一次的真实端口，
 *   否则对端记着的端口会变（tailnet 的 forward 也会失效）。
 * @param options.bindHost 监听地址。局域网关着时传 "127.0.0.1"。
 */
function startPeerServer(ctx, { config, discovery, inbound, outbound, log, warn, waker, threadState, capFor, capOverrides, throttled, onHistoryChange, diagnostics, port: fixedPort, bindHost = "0.0.0.0" }) {
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

  /**
   * 一键关闭的入站闸门。
   *
   * 只绑回环已经能挡住局域网（连接直接被拒），但这一层仍必须有：重绑失败
   * （端口被占、系统限制）时不能变成"界面显示关了、实际还收任务"。tailnet
   * 的入站由 sidecar 反代到回环，带 X-Forwarded-For，按 transport 区分。
   */
  const inboundClosedReason = (req) => {
    const origin = tailnetOrigin(req);
    if (origin.transport === "tsnet") return transportGate.internet ? "" : "互联网 mesh 已关闭";
    return transportGate.lan ? "" : "局域网 mesh 已关闭";
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const self = { ...discovery.selfRecord(), instanceId: discovery.instanceId };

    // 关闭期间连 health 都不答（否则对端会认为我们还活着）。503 带上原因，
    // 排障时能一眼看出是本机自己关的，而不是网络不通。
    const closed = inboundClosedReason(req);
    if (closed) return send(res, 503, { ok: false, closed: true, error: `本机已关闭${closed}（Mesh 面板可重新打开）` });

    // 免鉴权：只暴露身份，用于连通性探测、主动扫描与配对握手
    if (path === "/mesh/v1/health") return send(res, 200, { ok: true, ...self, requirePairing: pairingRequired(config) });
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
        // 人手动派发（聊天窗口 @ / 面板「派发任务」）。旧版本发送方不带这个字段，
        // 缺省 false —— 对它们保持原来的闸门行为。
        human: body.human === true,
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
      // 路由结论同步可见：闸门类拦截（太短/寒暄/限速/唤醒不可用）在
      // handleInboundTask 里是**同步**写进记录的，所以这里已经能读到；
      // 派发成功是异步的，此时通常还是 accepted，发送方按"已派发"处理即可。
      return send(res, 200, {
        ok: true,
        id: task.id,
        duplicate,
        status: task.status,
        routeDecision: task.routeDecision ?? "",
      });
    }

    return send(res, 404, { ok: false, error: "not found" });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    const wanted = fixedPort ?? config.port ?? MESH_DEFAULT_PORT;
    const start = (port, isFallback) => {
      server.once("error", (err) => {
        if (!isFallback && err?.code === "EADDRINUSE") {
          warn(`端口 ${wanted} 被占用，退回随机端口（组播仍可用，但主动扫描扫不到本机）`);
          start(0, true);
          return;
        }
        rejectPromise(err);
      });
      server.listen(port, bindHost, () => {
        const addr = server.address();
        log(`对端服务监听 ${addr.address}:${addr.port}${isFallback ? "（随机）" : "（固定）"}`);
        resolvePromise({ port: addr.port, host: addr.address, server });
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

function registerTools(ctx, { discovery, config, inbound, outbound, log, warn, threadState, hostDispatched, onHistoryChange, meshSwitch }) {
  const text = (v) => [{ type: "text", text: v }];
  /**
   * 当前开关的一行摘要。所有工具的输出都带上它 —— agent 看到"没有对端"
   * 时，第一件要能分清的事是"真没有"还是"本机自己关了"（这个项目里
   * 把"没答"当成"没有"已经出过一次事故）。
   */
  const switchLine = () => (meshSwitch ? meshSwitch.status().summary : "局域网 开启 · 互联网 开启");
  const lanOff = () => !!(meshSwitch && meshSwitch.status().lan.off);
  const netOff = () => !!(meshSwitch && meshSwitch.status().internet.off);
  const allOff = () => !!(meshSwitch && meshSwitch.status().all);

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
          if (allOff()) {
            return (
              `本机 mesh 已全部关闭（${switchLine()}），所以看不到任何对端 —— 这不代表网络里没有机器。\n` +
              "需要时用 mesh_switch（scope=all, action=on）打开，或让用户在 Mesh 面板「连接 → 一键关闭」里打开。"
            );
          }
          if (lanOff()) {
            return (
              `本机局域网 mesh 已关闭（${switchLine()}），本网段的机器目前不可见。\n` +
              "互联网通道若已配置，可继续用 mesh_peers 看到 tailnet 上的机器。"
            );
          }
          return (
            "没有发现其他 DSH 机器。\n" +
            "用 mesh_scan 主动扫一次本网段（组播常被路由器/防火墙挡住）。\n" +
            "仍找不到就排查：1) 两台机器是否同一网段 2) 对端是否装了 dsh-plugin-mesh 并已重启 DSH " +
            "3) 对端防火墙是否放行这个 TCP 端口\n" +
            `本机: ${machineOf(discovery)} (${preferredAddress()})  · 开关: ${switchLine()}`
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
        return (
          `发现 ${list.length} 台机器：\n${lines.join("\n")}\n\n` +
          `本机: ${machineOf(discovery)} (${preferredAddress()})  · 开关: ${switchLine()}`
        );
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
        if (allOff()) {
          return "未扫描：本机 mesh 已全部关闭。用 mesh_switch（scope=all, action=on）打开后再扫。";
        }
        if (lanOff()) {
          return (
            "未扫描：本机局域网 mesh 已关闭（不会向本网段发包）。\n" +
            (netOff()
              ? "互联网 mesh 也关着，所以两条路径都不可用。"
              : "互联网通道仍可用：需要找 tailnet 上的机器请用 mesh_switch 之外的方式，或先打开局域网。")
          );
        }
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
        if (allOff()) {
          return (
            "任务未派发：本机 mesh 已全部关闭（局域网 + 互联网）。\n" +
            "用 mesh_switch（scope=all, action=on）打开，或请用户在 Mesh 面板「连接 → 一键关闭」里打开。"
          );
        }

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

  /**
   * 一键关闭 / 打开。
   *
   * 为什么做成工具而不只是界面按钮：用户经常是在对话里说"把 mesh 关了"，
   * 而且关掉之后往往正是要 agent 继续干活（离线跑长任务）。做成工具，agent
   * 能自己执行并立刻回报"现在还有哪条通道是活的"。
   *
   * 默认动作是**关闭**：这是主动作，也是用户说"关掉"时的意思；打开必须显式传。
   */
  ctx.tools.register(
    defineTool({
      name: "mesh_switch",
      description:
        "一键关闭 / 打开本机 mesh。三种范围：all（全部）、lan（局域网）、internet（互联网 tailnet）。" +
        "关闭立即生效：局域网关闭后不再组播广播、不再扫本网段，对端端口只绑回环；" +
        "互联网关闭后停掉全部 tailnet sidecar（通道配置保留）。" +
        "状态写入 state.json，重启 DSH 后仍保持，直到显式打开。" +
        "界面上同一组开关在 Mesh 面板「连接 → 一键关闭」。",
      parameters: {
        scope: {
          type: "string",
          required: true,
          description: "关闭/打开的范围：all（全部 mesh）、lan（局域网 mesh）、internet（互联网 mesh）",
        },
        action: {
          type: "string",
          description: "off = 关闭（默认），on = 打开",
        },
      },
      output: { schema: { type: "string" }, render: (_a, v) => text(v) },
      async execute(args) {
        if (!meshSwitch) return "本机没有可用的 mesh 开关实现（插件版本过旧）。";
        const scope = normalizeSwitchScope(args?.scope);
        if (!scope) {
          return `scope 不合法：${String(args?.scope ?? "")}。用 all / lan / internet 之一。`;
        }
        const rawAction = String(args?.action ?? "off").trim().toLowerCase();
        if (!["off", "on", "close", "open", "disable", "enable"].includes(rawAction)) {
          return `action 不合法：${rawAction}。用 off（关闭）或 on（打开）。`;
        }
        const wantOff = ["off", "close", "disable"].includes(rawAction);
        const result = await meshSwitch.set({ scope, off: wantOff, by: "tool" });
        const st = result.status;
        const label = MESH_SWITCH_LABEL[scope] ?? scope;
        const lines = [
          `${label}已${wantOff ? "关闭" : "打开"}${result.changed ? "" : "（状态本来就是这样，没有变化）"}。`,
          `当前：${st.summary}`,
          `局域网：${st.lan.off ? "已关闭" : "开启"}` +
            (st.lan.off
              ? ` · 对端端口${st.lan.bind ? `只绑 ${st.lan.bind}` : "已停"}`
              : ` · 监听 ${st.lan.bind || "—"}:${st.lan.port || "—"} · 组播 ${st.lan.multicast ? "开" : "关"}`) +
            (st.lan.note ? ` · 注意：${st.lan.note}` : ""),
          `互联网：${st.internet.off ? "已关闭" : "开启"}` +
            (st.internet.off
              ? ` · 运行中 sidecar ${st.internet.running} 条（配置里启用 ${st.internet.configured} 条，配置保留）`
              : ` · 运行中 ${st.internet.running}/${st.internet.configured} 条`) +
            (st.internet.note ? ` · 注意：${st.internet.note}` : ""),
        ];
        if (!wantOff && scope !== "lan" && st.internet.configured === 0) {
          lines.push("提示：互联网 mesh 没有启用的 tailnet 通道，需要在 Mesh 面板里添加授权码。");
        }
        return lines.join("\n");
      },
    }),
  );

  log("已注册工具 mesh_peers / mesh_run / mesh_tasks / mesh_switch");
}

// ───────────────────────── UI 接口（本地回环） ─────────────────────────

function registerUiRoutes(ctx, { discovery, config, identity, inbound, outbound, log, warn, threadState, hostDispatched, capFor, capOverrides, throttled, waker, onHistoryChange, diagnostics, meshSwitch }) {
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

  /** 返回 { peer } 或 { error }，避免撞名时静默挑错机器（规则见模块级 resolvePeerTarget） */
  const findPeer = (name) => resolvePeerTarget(discovery, name);

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
    // 磁盘版本**每次现读**：装好新版本但没重启时，这个接口要立刻显示"磁盘已是新版"，
    // 否则界面会一直按启动时的常量说"没有更新"。
    const diskVersion = readPackageVersion(import.meta.url);
    return {
      ok: true,
      self: {
        machine: identity.name,
        machineSource: identity.source,
        needsName: identity.source === "hostname",
        hostname: hostname(),
        mac: macForAddress(preferredAddress()),
        host: preferredAddress(),
        port: discovery.port,
        instanceId: discovery.instanceId,
        addresses: lanIPv4Addresses(),
        platform: platform(),
        version: VERSION,
        // 磁盘上的版本 vs 本进程加载的版本。两者不一致 = 升级了但没重启，
        // 界面要明说"重启后生效"，否则用户会拿旧行为当新版本的 bug 报上来。
        diskVersion,
        versionDrift: !!diskVersion && diskVersion !== VERSION,
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
        workspaceRoot: config.workspaceRoot,
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
      },
      // 一键关闭：期望值 + 真实运行情况 + 偏差说明（界面按它渲染三个开关）
      switch: meshSwitch ? meshSwitch.status() : null,
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
   * 检查更新：向 npm registry 问一次最新版本。
   *
   * 只读（GET），但要带缓存：
   *   · 成功缓存 30 分钟 —— 主页每次进入都会问一次，不能让面板变成 registry 的
   *     高频客户端；
   *   · 失败只缓存 1 分钟 —— 网络刚恢复时用户点「重新检查」应该马上能成功，
   *     但也不能让离线状态下的反复点按变成打点风暴。
   * 失败一律返回 200 + `{ok:false,error}`：这是「没问到」，不是 HTTP 故障，
   * 界面要把它和「已是最新」分开显示。
   */
  const UPDATE_OK_TTL_MS = 30 * 60 * 1000;
  const UPDATE_FAIL_TTL_MS = 60 * 1000;
  let updateCache = null;
  /** 升级完成后的「待生效」标记：进程仍是旧代码，界面据它给重启/重载而不是再装一次。 */
  const upgradeMarkerPath = () => join(stateDir(), "upgrade.json");
  const pendingUpgradeFrom = (diskVersion) => {
    if (!diskVersion || compareVersions(diskVersion, VERSION) !== 1) return null;
    const marker = readUpgradeMarker(upgradeMarkerPath());
    if (marker && marker.version === diskVersion) {
      return {
        version: diskVersion,
        previous: String(marker.previous || VERSION),
        at: String(marker.at || ""),
        restartRequired: marker.restartRequired === true,
        reloadRequired: marker.reloadRequired === true,
        inferred: false,
      };
    }
    // 没有标记但磁盘比进程新 = 手工装过（或标记没写成），只能保守地提示重启。
    return {
      version: diskVersion,
      previous: VERSION,
      at: "",
      restartRequired: true,
      reloadRequired: false,
      inferred: true,
    };
  };

  route("/mesh/api/update", async (req, res) => {
    const force = /[?&]force=1(?:&|$)/.test(String(req.url || ""));
    const now = Date.now();
    if (!force && updateCache) {
      const ttl = updateCache.report.ok ? UPDATE_OK_TTL_MS : UPDATE_FAIL_TTL_MS;
      if (now - updateCache.at < ttl) {
        return send(res, 200, { ...updateCache.report, cached: true });
      }
    }
    // 磁盘版本**每次现读**：装好新版本但没重启时，这里必须立刻反映磁盘上的版本。
    const diskVersion = readPackageVersion(import.meta.url);
    const marker = readUpgradeMarker(upgradeMarkerPath());
    if (marker && marker.version === VERSION) {
      clearUpgradeMarker(upgradeMarkerPath()); // 已经重启生效
    } else if (marker && marker.version !== diskVersion) {
      clearUpgradeMarker(upgradeMarkerPath()); // 磁盘被回滚或手工改过，标记已失效
    }
    const pendingUpgrade = pendingUpgradeFrom(diskVersion);
    // 5 秒：主页是首屏，等不起更久；两源合计最坏也就 10 秒。
    const latest = await fetchLatestVersion({ timeoutMs: 5000 });
    const report = buildUpdateReport({
      current: VERSION,
      diskVersion,
      latest,
      pluginDir: PLUGIN_DIR,
      pendingUpgrade,
      now: Date.now(),
    });
    updateCache = { at: Date.now(), report };
    if (!report.ok) log(`检查更新失败（不是「已是最新」）: ${report.error}`);
    send(res, 200, report);
  });

  /**
   * 一键升级（写操作，POST + 同源回环守卫）。
   *
   * 顺序：下载新包 → sha512 校验 → 解包到 staging → 真实 import 可加载检查
   * → 备份旧目录 → 原子替换。任何一步失败都保留旧版；只有 ok:true 且
   * installed:true 才代表磁盘已换新（进程仍跑旧代码，需重启或重载界面）。
   */
  let upgradeRunning = false;
  post("/mesh/api/upgrade", async (req, res) => {
    if (!trustedControlRequest(req)) {
      return send(res, 403, { ok: false, error: "升级接口只接受同源回环请求" });
    }
    if (upgradeRunning) return send(res, 409, { ok: false, error: "已经有一次升级在进行中" });
    const body = await readJson(req);
    const version = String(body?.version ?? "").trim();
    const diskVersion = readPackageVersion(import.meta.url);
    // 磁盘已经是目标版本：不重复下载/覆盖，直接按"已装好"回报。
    if (diskVersion === version && compareVersions(version, VERSION) === 1) {
      const pendingUpgrade = pendingUpgradeFrom(diskVersion);
      return send(res, 200, {
        ok: true,
        installed: false,
        upToDate: true,
        version,
        changed: null,
        restartRequired: pendingUpgrade ? pendingUpgrade.restartRequired : true,
        reloadRequired: pendingUpgrade ? pendingUpgrade.reloadRequired : false,
      });
    }
    upgradeRunning = true;
    try {
      const report = await installUpdate({
        version,
        current: VERSION,
        pluginDir: PLUGIN_DIR,
        markerPath: upgradeMarkerPath(),
        log,
      });
      updateCache = null; // 下一次 /update 重新读磁盘版本
      if (!report.ok) warn(`升级失败（${report.stage || "?"}）：${report.error}`);
      send(res, 200, report);
    } finally {
      upgradeRunning = false;
    }
  });

  /**
   * 重启宿主，让新装好的宿主半生效。
   *
   * 走 DSH Desktop 自带的 `desktopSettingsController.restart()`（原生确认 + 有序
   * relaunch，和切换 profile 同一条路）；没有这个入口的宿主返回 mode:"manual"，
   * 让界面明确告诉用户手动重启 —— 不用 shell 脚本，也就没有重启循环那类风险。
   */
  post("/mesh/api/upgrade/restart", async (req, res) => {
    if (!trustedControlRequest(req)) {
      return send(res, 403, { ok: false, error: "重启接口只接受同源回环请求" });
    }
    if (upgradeRunning) return send(res, 409, { ok: false, error: "升级还没结束，稍后再重启" });
    send(res, 200, await requestHostRestart(ctx));
  });

  /**
   * 重载渲染器，让只改了 client 的新版本生效（不重启宿主）。
   * DSH Desktop 有内置入口；其它宿主返回 mode:"self"，由页面自己 reload。
   */
  post("/mesh/api/upgrade/reload", async (req, res) => {
    if (!trustedControlRequest(req)) {
      return send(res, 403, { ok: false, error: "重载接口只接受同源回环请求" });
    }
    send(res, 200, requestHostReload(ctx));
  });

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

  post("/mesh/api/refresh", (_req, res) => {
    const st = meshSwitch ? meshSwitch.status() : null;
    // 关着局域网时 announceNow 是空操作。如实回报，别让界面以为"广播过了"。
    const announced = Boolean(st && !st.lan.off && st.lan.multicast);
    if (announced) discovery.announceNow();
    send(res, 200, { ok: true, announced });
  });

  post("/mesh/api/scan", async (_req, res) => {
    // 局域网关着就别发包（按钮叫「局域网探测」，不能偷偷改成只扫 tailnet）
    if (meshSwitch && meshSwitch.status().lan.off) {
      return send(res, 409, {
        ok: false,
        closed: true,
        error: "局域网 mesh 已关闭 —— 在「连接 → 一键关闭」里打开后再探测",
      });
    }
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

  /**
   * 界面上的「一键关闭」。
   *
   * body: `{ scope: "all"|"lan"|"internet", off: boolean }`
   *
   * 和配对码开关一样写 state.json（不改用户的 cordis.patch.yml），
   * 但**会跨重启保持**：一键关闭的语义是"我现在不想让这台机器被找到、被派活"，
   * 重启后自己悄悄恢复是最坏的结果。
   *
   * `off` 必须是布尔值：`body?.off === true` 这种写法在 GET/空 body 上会变成
   * false，那是"悄悄打开"—— 和 pairing 那次 fail-open 同一类错误，这里直接
   * 400 拒掉。
   */
  post("/mesh/api/switch", async (req, res) => {
    const body = await readJson(req);
    const scope = normalizeSwitchScope(body?.scope);
    if (!scope) {
      return send(res, 400, { ok: false, error: "scope 必须是 all / lan / internet 之一" });
    }
    if (typeof body?.off !== "boolean") {
      return send(res, 400, { ok: false, error: "off 必须是布尔值（true = 关闭，false = 打开）" });
    }
    if (!meshSwitch) return send(res, 503, { ok: false, error: "开关实现不可用（插件版本过旧）" });
    try {
      const result = await meshSwitch.set({ scope, off: body.off, by: "ui" });
      return send(res, 200, { ok: true, changed: result.changed, scope, switch: result.status });
    } catch (err) {
      return send(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
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
    if (meshSwitch && meshSwitch.status().internet.off) {
      return send(res, 409, {
        ok: false,
        closed: true,
        error: "互联网 mesh 已关闭 —— 在「连接 → 一键关闭」里打开后再启动通道",
      });
    }
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
    if (meshSwitch && meshSwitch.status().internet.off) {
      return send(res, 409, {
        ok: false,
        closed: true,
        error: "互联网 mesh 已关闭 —— 在「连接 → 一键关闭」里打开后再扫描",
      });
    }
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
    if (meshSwitch && meshSwitch.status().all) {
      return send(res, 409, {
        ok: false,
        closed: true,
        error: "本机 mesh 已全部关闭 —— 在「连接 → 一键关闭」里打开后再派发",
      });
    }
    const found = findPeer(peerName);
    if (found.error) return send(res, found.error.startsWith("名字") ? 409 : 404, { ok: false, error: found.error });
    const target = found.peer;

    const id = `t-${randomBytes(6).toString("hex")}`;
    // 页面派发如果没填 thread，就自己生成一个。
    //
    // 「线程标识（可选）」留空时没有绑定键 → 对端按提示词里的兜底（thread 填任务 id）
    // 回执 → 我们这边算出的键完全对不上，只能新开会话。真机复测就是这样：
    // 回执的 thread 是 t-xxxx（对方任务 id）。
    const thread = body?.thread ? String(body.thread) : `ui-${id}`;
    let originSession = body?.originSession ? String(body.originSession) : "";
    let createdSessionId = "";

    // 页面派发时**预建一个会话**，回执才有地方可去。
    //
    // 只靠 UI 传当前会话不够：Mesh 面板拿不到 selection 时 sessionId 是空的，
    // 绑定整段被跳过，回执就只能新开会话（真机反馈「mac 没有预先生成会话」）。
    // 这里在宿主侧兜底：还没绑定、但有 thread、且唤醒能力可用 → 先建一个空会话。
    if (!originSession && waker?.ready) {
      try {
        originSession = await createIdleSession(
          waker,
          config,
          {
            id,
            from: `${machineOf(discovery)}/${safeUser()}`,
            thread,
            toMachine: target.machine,
            transport: target.transport,
          },
          warn,
          // 格式（用户指定）：第一行「向 X 发送的消息」→ 原文 → 末行「等待 X 回复」。
          // 末行同时承担「别在本机执行」的职责：只写「等待回复」是状态描述，
          // agent 仍会把上面的原文当任务执行，必须让它明确知道别动手。
          { text: `向 ${target.machine} 发送的消息 如下:\n${task}\n———\n[Mesh 已派发 → ${target.machine}／${id}] 现在什么都不用做：不要调用任何工具、不要回派，回一句「等待回执」即可。` },
        );
        createdSessionId = originSession;
      } catch (err) {
        warn(`预建会话失败（回执将新建会话）：${err?.message ?? err}`);
      }
    }

    const result = await dispatchTaskToPeer(
      { discovery, config, outbound, threadState, hostDispatched, onHistoryChange },
      {
        id,
        target,
        task,
        thread,
        originSession,
        noWake: body?.noWake === true,
        newSession: body?.newSession === true,
        workspace: body?.workspace ? String(body.workspace) : "",
        human: true,
      },
    );
    if (!result.ok && result.conflict) return send(res, 409, { ok: false, error: result.error });
    return send(res, result.ok ? 200 : 502, {
      ok: result.ok,
      id: result.id,
      sessionId: originSession || createdSessionId,
      error: result.error,
      ...(result.noted ? { noted: true, reason: result.noted.reason } : {}),
    });
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
    const body = await readJson(req);
    const machine = String(body?.machine ?? "").trim();
    // 只回用户名与"是否已部署密钥"，不回密码：密码没有再穿过一次网络的理由
    const info = ssh.describe(machine);
    return send(res, 200, { ok: true, username: info.username, hasKey: info.hasKey, saved: !!info.username });
  });

  post("/mesh/api/ssh/sessions", (_req, res) => send(res, 200, { ok: true, sessions: ssh.list() }));

  // 一条 upgrade 路由承载所有终端（按会话 id 多路复用）
  const sshUpgrade = (req, socket, head) => {
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

  log("UI 接口已挂载: /mesh/api/state|diagnostics|update|upgrade|upgrade/restart|upgrade/reload|refresh|secret|send|probe|web-url|web-panel|ssh");
}
