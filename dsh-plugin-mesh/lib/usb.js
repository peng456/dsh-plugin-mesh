/**
 * USB / adb 传输适配：桌面 DSH 经 `adb forward` 直连 Android 手机上的 mesh 节点。
 *
 * 为什么需要第三个传输（lan / tsnet 之外）：
 *
 *   1. **组播在这类设备上不可靠**。dsh-go 里 Node 跑在 proot Ubuntu 下（`platform=linux`），
 *      底层却是 Android app UID：拿不到 MulticastLock、后台会被省电策略限流、路由器
 *      还常有 AP isolation。手机插着 USB 线时，"一条确定存在的线"比"希望组播能过去"
 *      可靠得多。
 *   2. **免同网段、免账号**。adb 隧道不需要手机和桌面在同一个 Wi-Fi、不需要 Tailscale
 *      登录，也不需要手机有 root。只要 USB 调试打开、用户点了"允许调试"，就能通。
 *   3. **确定性**。`adb forward tcp:<local> tcp:<device>` 是 adb 自己维护的 TCP 转发，
 *      端点固定为 `127.0.0.1:<local>`，不依赖任何地址探测/网卡枚举的结果 ——
 *      那些在 Android/proot 上恰好是最容易探不到、最容易"看起来没有地址"的东西。
 *
 * 这个模块**刻意不依赖 discovery.js / index.js**（自包含 + 全部可注入），原因：
 *   · 它要在 proot/Android 这种"探测本身会失败"的环境里跑，必须能被离线自测覆盖；
 *   · lib/index.js 与其它模块正在被并发修改，把它做成独立模块可以先落地、后接线；
 *   · 传输层只负责"发现设备 → 建隧道 → 探测健康 → 产出端点"，注册表/派发是调用方的事。
 *
 * 与现有代码的接线（详见 `analysis/USB-ADAPTER-DESIGN.md`，锚点均为函数名）：
 *   · `applyUnsafe()` 里创建本传输，`onEndpoints` 拿到端点后对每条调用
 *     `discovery.note(ep.record, ep.host, { transport: "usb", channel: ep.key, port: ep.port, probeIntervalMs })`；
 *   · 派发路径无需改动：`peerFetch()` 对非 `tsnet` 端点走 `fetchViaLan()`，而 USB 端点的
 *     host 就是 `127.0.0.1`，普通 fetch 直接命中 adb 隧道（`lib/index.js` 的 `fetchViaLan`）。
 *   · `notify` 失败时用 `discovery.markEndpoint(id, ep.key, {ok:false})` 记失败，**不要**
 *     把"探测超时"当成"设备不存在"（AGENTS.md 硬约束 1）。
 *
 * 生命周期（调用方负责）：
 *   模块**默认不启动**（不在 import 时碰 adb）。调用方在插件 apply 里 `start()`，
 *   在 `ctx.effect(() => () => transport.stop())` 里清理。
 *
 * 依赖注入（全部可选，测试用 fake 覆盖，缺省等价于生产行为）：
 *   · `execFile(file, args, options)` → Promise<{stdout, stderr}> | string；抛错时
 *     `err.code` / `err.stderr` / `err.stdout` 会被读到。
 *   · `fetchImpl(url, init)` → Response 形状（`{ok, status, json()}`）。
 *   · `log(message)`、`onEndpoints(list, meta)`、`onError({serial, phase, code, message, at})`。
 *
 * **任何情况下都不抛**：所有公开方法返回结构化的结果/状态。原因是这些调用点在
 * 定时器、HTTP 健康检查、UI 状态里 —— 一次抛异常就是"整个 Mesh 不可用"，
 * 而在桌面上根本复现不出来（桌面上 adb 恰好正常）。
 */
import { execFile as nodeExecFile } from "node:child_process";

/** 设备侧 mesh 监听端口：dsh-go 真机实测 `0.0.0.0:45917`。 */
export const DEFAULT_DEVICE_PORT = 45917;
/**
 * 桌面侧 forward 本地端口基址。刻意与 mesh 默认端口（45917）错开，避免和
 * 本机 mesh 服务、以及手机上的 45917 撞号（虽然一个是本机端口一个是设备端口，
 * 但日志里同号最容易把人看糊涂）。
 */
export const DEFAULT_FORWARD_BASE = 46000;
/** 每个 serial 的稳定端口区间长度：`[forwardBase, forwardBase+span)`。 */
export const DEFAULT_FORWARD_SPAN = 100;
/** 端点的 transport 名（UI 与日志都用它）。 */
export const TRANSPORT_NAME = "usb";

/** `adb version` 只是客户端自检，不启动 adb server，代价极低。 */
const ADB_VERSION_TIMEOUT_MS = 5000;
/** `adb devices -l` 可能顺带拉起 adb server（首次会慢一点）。 */
const ADB_DEVICES_TIMEOUT_MS = 8000;
const ADB_FORWARD_TIMEOUT_MS = 5000;
/** adb 不可用时，多久重试一次探测（例如用户后来才装 adb / 才把 adb 加进 PATH）。 */
const DETECT_RETRY_MS = 60000;
/** 同一个错误在这个窗口内只回调 `onError` 一次（不刷屏）。 */
const ERROR_REPEAT_MS = 60000;
/** 错误历史环形缓冲长度（给 UI/诊断读）。 */
const ERROR_HISTORY_MAX = 50;
/** 绑端口冲突时最多顺延几次（正常 1~2 次就够，100 个端口全占满属于异常）。 */
const MAX_BIND_ATTEMPTS = 8;

/**
 * 与 `discovery.js` 的 `UUID_ID_RE` 保持一致的"不是 mesh id"判据。
 *
 * 为什么本地复制一份而不是 import：本模块刻意自包含（见文件头）。真正兜底的
 * 准入仍由 `discovery.note()` 里的 `looksLikeDshPeer()` 做 —— 这里只要求
 * "不比它宽松"，避免把非 mesh 服务当端点喂进注册表。
 */
const UUID_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `adb devices -l` 认得的设备状态（`no` = Linux 上 udev 权限不足时的 `no permissions`）。 */
const ADB_STATES = new Set([
  "device",
  "offline",
  "unauthorized",
  "recovery",
  "sideload",
  "bootloader",
  "no",
  "authorizing",
  "connecting",
  "host",
  "detached",
  "unknown",
]);

/** 只有 `device` 状态的设备能建 forward / 探测；其余一律跳过并记原因。 */
const USABLE_STATE = "device";

const KEY_VALUE_RE = /^(\S+)\s+([A-Za-z()]+)(?:\s+(.*))?$/;

/** 截断 + 折叠空白：错误消息要能进日志/JSON，不能带换行（会撑坏行式日志）。 */
function shortText(value, max = 200) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** FNV-1a 32 位：稳定、短、无依赖。只用来把 serial 映射到端口区间。 */
function fnv1a32(text) {
  let hash = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 按 serial 稳定分配 forward 起始端口。
 *
 * 为什么需要稳定：forward 是 adb 的全局状态（`adb forward --list`），进程重启后
 * 如果端口漂移，上一轮建的隧道就成了"占用端口的垃圾"，还得额外清理逻辑。
 * 稳定映射让"同一台手机永远是同一个本地端口"，进程重启也能直接复用。
 *
 * @returns {number} `[forwardBase, forwardBase+span)` 内的端口
 */
export function usbPortFor(serial, forwardBase = DEFAULT_FORWARD_BASE, span = DEFAULT_FORWARD_SPAN) {
  const base = Number.isInteger(forwardBase) && forwardBase > 0 && forwardBase < 65536 ? forwardBase : DEFAULT_FORWARD_BASE;
  const width = Number.isInteger(span) && span > 0 ? span : DEFAULT_FORWARD_SPAN;
  return base + (fnv1a32(String(serial ?? "")) % width);
}

/**
 * 解析 `adb devices -l` 的输出。
 *
 * 真机形态（Xiaomi 15 Ultra / Android 15，serial `1441e87a`）：
 * ```
 * List of devices attached
 * 1441e87a               device usb:1-4 product:nuwa model:2510DPC0 device:nuwa transport_id:3
 * ```
 * 首次运行还可能夹着 adb server 的启动噪声：
 * ```
 * * daemon not running; starting now at tcp:5037
 * * daemon started successfully
 * ```
 *
 * @param {string} stdout
 * @returns {{devices: object[], skipped: object[]}} devices 只含 `device` 状态；
 *          skipped 里的每一条都带 `reason`（unauthorized / offline / no-permissions …）
 */
export function parseAdbDevices(stdout) {
  const devices = [];
  const skipped = [];
  try {
    for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("*")) continue;
      if (/^List of devices attached/i.test(line)) continue;
      if (/^adb server/i.test(line)) continue;
      if (/^\d+\s+devices?$/i.test(line)) continue; // "2 devices"
      const m = KEY_VALUE_RE.exec(line);
      if (!m) continue;
      const serial = m[1];
      const state = m[2].toLowerCase();
      if (!ADB_STATES.has(state)) continue;
      const kv = {};
      for (const token of String(m[3] ?? "").split(/\s+/)) {
        if (!token) continue;
        const idx = token.indexOf(":");
        if (idx <= 0 || idx === token.length - 1) continue;
        kv[token.slice(0, idx)] = token.slice(idx + 1);
      }
      const entry = {
        serial,
        state,
        model: kv.model ? String(kv.model) : "",
        product: kv.product ? String(kv.product) : "",
        device: kv.device ? String(kv.device) : "",
        // `usb:1-4` 这种就是 USB 连接的物理位置；无线调试的条目没有它
        transport: kv.usb ? `usb:${kv.usb}` : "",
        transportId: Number(kv.transport_id) || 0,
        usb: Boolean(kv.usb),
      };
      if (state === USABLE_STATE) devices.push(entry);
      else skipped.push({ ...entry, reason: state === "no" ? "no-permissions" : state });
    }
  } catch {
    /* 输出来自 adb，理论上不会怪到抛异常；真抛了就当没设备，不往上抛 */
  }
  return { devices, skipped };
}

/**
 * 解析 `adb forward --list` 的输出。
 *
 * 形态（每行一个映射）：
 * ```
 * 1441e87a tcp:46000 tcp:45917
 * emulator-5554 tcp:46001 tcp:45917
 * ```
 * 只认 tcp→tcp（`localabstract:`/`localreserved:` 之类不是本模块建的，跳过）。
 *
 * @returns {{serial: string, localPort: number, remotePort: number}[]}
 */
export function parseForwardList(stdout) {
  const out = [];
  try {
    for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = /^(\S+)\s+tcp:(\d+)\s+tcp:(\d+)\s*$/.exec(line);
      if (!m) continue;
      const localPort = Number(m[2]);
      const remotePort = Number(m[3]);
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) continue;
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) continue;
      out.push({ serial: m[1], localPort, remotePort });
    }
  } catch {
    /* 同上：不抛 */
  }
  return out;
}

/**
 * 这个 health 响应是不是一个正经的 dsh-mesh 节点（与 `discovery.looksLikeDshPeer` 同判据）。
 *
 * 为什么要单独判：本地端口是 adb forward 的共享资源，任何东西都可能监听在
 * `127.0.0.1:<local>`（比如上一轮遗留的另一个服务）。200 OK 不代表"这是 mesh"，
 * 只有这样判过才能生成端点；否则会把陌生服务当对端派发任务。
 */
export function looksLikeMeshHealth(record) {
  if (!record || typeof record !== "object") return false;
  if (record.app !== "dsh-mesh" || !record.id) return false;
  if (record.v !== undefined && record.v !== 2) return false;
  if (record.proto !== undefined && record.proto !== "dsh-mesh") return false;
  if (UUID_ID_RE.test(String(record.id))) return false;
  return true;
}

/**
 * 把 adb 的失败归类成稳定的 code。
 *
 * 为什么不用 `err.code` 了事：adb 自己的退出码永远是 1，真正的原因只存在于
 * stderr 文本里（`cannot bind listener` / `device unauthorized` / `device offline`）。
 * 不归类就无法区分"端口占用（换个端口就好）"和"设备掉线（换端口没用）"，
 * 更没法把"没装 adb"与"没有设备"区分开（AGENTS.md 硬约束 1）。
 */
export function classifyAdbFailure(err, phase = "adb") {
  const raw = err && typeof err === "object" ? err : { message: String(err ?? "") };
  const text = [raw.message, raw.stderr, raw.stdout].filter(Boolean).join(" ");
  const codeRaw = String(raw.code ?? "").trim();
  let code = "";
  if (/cannot bind|address already in use|only one usage of each socket address|bind failed/i.test(text)) code = "EADDRINUSE";
  else if (/unauthorized|authoriz(e|ing)/i.test(text)) code = "UNAUTHORIZED";
  else if (/device offline|offline/i.test(text)) code = "DEVICE_OFFLINE";
  else if (/device '.*' not found|device .* not found|no devices\/emulators found|device not found/i.test(text)) code = "DEVICE_GONE";
  else if (/more than one (device|emulator)/i.test(text)) code = "MULTIPLE_DEVICES";
  else if (/permission denied|EACCES|EPERM/i.test(text)) code = "EPERM";
  else if (/timed?\s*out|ETIMEDOUT/i.test(text)) code = "ETIMEDOUT";
  else if (/command not found|not recognized|ENOENT/i.test(text) || codeRaw === "ENOENT") code = "ENOENT";
  else if (codeRaw) code = codeRaw;
  else code = "ADB_FAILED";
  return { phase: String(phase), code, message: shortText(text || codeRaw || code) };
}

/** 默认 execFile：把 node 的回调风格包成 Promise；失败时把 stdout/stderr 挂在 err 上。 */
function defaultExecFile(file, args, options) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout ?? "");
        err.stderr = String(stderr ?? "");
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** 只在 selftest 里 sleep 用，生产代码不调用。刻意不 unref：测试里它是"让事件循环继续跑"的锚。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 选项归一化：**任何输入都不抛**（调用方可能把整个 config 对象传进来，里面什么都有）。
 * 越界/非法值一律退回默认值，而不是让"配错一个端口"变成"传输层崩掉"。
 */
function normalizeOptions(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const int = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  const forwardBase = int(safe.forwardBase, DEFAULT_FORWARD_BASE, 1024, 65000);
  const forwardSpan = int(safe.forwardSpan, DEFAULT_FORWARD_SPAN, 1, Math.max(1, 65536 - forwardBase));
  return {
    // 默认读 PATH 里的 adb；Windows 上也可以传 "E:\\AndroidSDK\\platform-tools\\adb.exe"
    adbPath: typeof safe.adbPath === "string" && safe.adbPath.trim() ? safe.adbPath.trim() : "adb",
    devicePort: int(safe.devicePort, DEFAULT_DEVICE_PORT, 1, 65535),
    forwardBase,
    forwardSpan,
    // 轮询 15s：与 mesh 默认 pingIntervalMs 同量级，但对 USB 这种"插着就没变化"的
    // 通道已经足够快；测试可以调到 50ms。
    pollMs: int(safe.pollMs, 15000, 20, 3600000),
    // 探测超时很短：adb 隧道是本机回环，正常 <5ms；探不通要快速让位给其它通道
    probeTimeoutMs: int(safe.probeTimeoutMs, 1200, 10, 60000),
    execFile: typeof safe.execFile === "function" ? safe.execFile : defaultExecFile,
    fetchImpl:
      typeof safe.fetchImpl === "function"
        ? safe.fetchImpl
        : (url, init) => {
            if (typeof globalThis.fetch !== "function") return Promise.reject(Object.assign(new Error("当前 Node 没有全局 fetch"), { code: "ENOFETCH" }));
            return globalThis.fetch(url, init);
          },
    log: typeof safe.log === "function" ? safe.log : () => {},
    onError: typeof safe.onError === "function" ? safe.onError : null,
    onEndpoints: typeof safe.onEndpoints === "function" ? safe.onEndpoints : null,
  };
}

/**
 * 创建 USB 传输实例。
 *
 * 默认**不启动**（构造时不碰 adb、不建隧道）；调用方显式 `await start()`。
 *
 * @param {object} [opts]
 * @param {string} [opts.adbPath="adb"]
 * @param {number} [opts.devicePort=45917] 设备侧 mesh 端口
 * @param {number} [opts.forwardBase=46000] 本地端口基址
 * @param {number} [opts.forwardSpan=100] 端口区间长度
 * @param {number} [opts.pollMs=15000]
 * @param {number} [opts.probeTimeoutMs=1200]
 * @param {Function} [opts.execFile]
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.log]
 * @param {Function} [opts.onEndpoints] `(list, meta)`
 * @param {Function} [opts.onError] `({serial, phase, code, message, at})`
 */
export function createUsbTransport(opts = {}) {
  const options = normalizeOptions(opts);
  const state = {
    // null = 还没探测过；true/false = adb 是否可用（ENOENT 就是 false + reason ENOENT）
    available: null,
    reason: "",
    detectAt: 0,
    adbVersion: "",
    started: false,
    polling: false,
    /**
     * 生命周期代数：每次 start/stop 自增。进行中的轮询带着旧代数回来时直接丢弃结果 ——
     * 否则 stop() 之后一拍之差的轮询会把端点重新发布/把 forward 重新建起来
     * （插件卸载后还去建 adb 隧道，属于典型的"清理泄漏"）。
     */
    generation: 0,
    pollCount: 0,
    lastPollAt: 0,
    timer: null,
    /** 最近一次 `adb devices -l` 的可用设备 / 被跳过的设备（含原因）。 */
    devices: [],
    skipped: [],
    /** serial → {serial, localPort, remotePort, createdByUs, adopted, since} */
    forwards: new Map(),
    /** 最近一次探测成功的 USB 端点（给 status()/UI 用）。 */
    endpoints: [],
    /** 上一轮可达的 serial，用来只在"通→不通/不通→通"时打日志。 */
    upSet: new Set(),
    /** 错误历史（环形缓冲，连续同类错误折叠成 repeat 计数）。 */
    errors: [],
    /** 错误回调的限流表：`serial|phase|code` → {count, lastReportedAt}。 */
    errorStats: new Map(),
    errCount: 0,
  };

  // ───────────────────────── 小工具 ─────────────────────────

  function safeLog(message) {
    try {
      options.log(`usb: ${message}`);
    } catch {
      /* 日志实现自己抛错不能影响传输 */
    }
  }

  function makeError(serial, phase, code, message) {
    return {
      serial: shortText(serial, 64),
      phase: shortText(phase, 32) || "unknown",
      code: shortText(code, 64) || "UNKNOWN",
      message: shortText(message),
      at: Date.now(),
    };
  }

  /**
   * 记录一个错误：进错误历史（供诊断/UI），**并限流回调 `onError`**。
   *
   * 为什么必须限流：轮询每 15s 跑一次，"手机没授权调试"这种状态会稳定复现。
   * 不限流就是每 15s 一条日志 —— 实测这类刷屏会淹没真正的故障信息。
   * 注意：**限流的是回调，不是事实** —— 状态里的 `errors`/`reason` 始终是最新的。
   */
  function recordError(raw) {
    try {
      const err = raw && raw.at && raw.code ? raw : makeError(raw?.serial, raw?.phase, raw?.code, raw?.message);
      state.errCount += 1;
      const last = state.errors[state.errors.length - 1];
      if (
        last &&
        last.serial === err.serial &&
        last.phase === err.phase &&
        last.code === err.code &&
        err.at - last.at <= ERROR_REPEAT_MS
      ) {
        last.repeat = Number(last.repeat ?? 1) + 1;
        last.at = err.at;
      } else {
        state.errors.push(err);
        if (state.errors.length > ERROR_HISTORY_MAX) state.errors.shift();
      }
      const key = `${err.serial}|${err.phase}|${err.code}`;
      const stat = state.errorStats.get(key) ?? { count: 0, lastReportedAt: 0 };
      stat.count += 1;
      const shouldReport = err.at - stat.lastReportedAt >= ERROR_REPEAT_MS;
      if (shouldReport) {
        stat.lastReportedAt = err.at;
        try {
          options.onError?.(err);
        } catch {
          /* 回调实现自己抛错不能影响传输 */
        }
      }
      state.errorStats.set(key, stat);
      return err;
    } catch {
      return null;
    }
  }

  /** 发布当前端点集合（每次都发：调用方可以据此定期刷新注册表，15s 一次代价可忽略）。 */
  function publishEndpoints(list, extra = {}) {
    state.endpoints = Array.isArray(list) ? list : [];
    try {
      options.onEndpoints?.(state.endpoints, {
        at: Date.now(),
        available: state.available === true,
        started: state.started,
        ...extra,
      });
    } catch {
      /* 同上 */
    }
  }

  // ───────────────────────── adb 调用层 ─────────────────────────

  /**
   * 跑一条 adb 命令。**永不抛**：失败返回 `{ok:false, code, message}`。
   *
   * @param {string[]} args
   * @param {number} timeoutMs
   */
  async function runAdb(args, timeoutMs = ADB_FORWARD_TIMEOUT_MS) {
    const argv = Array.isArray(args) ? args.map((a) => String(a)) : [];
    try {
      const raw = options.execFile(options.adbPath, argv, {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      const res = await Promise.resolve(raw);
      const stdout = typeof res === "string" ? res : String(res?.stdout ?? "");
      const stderr = typeof res === "string" ? "" : String(res?.stderr ?? "");
      return { ok: true, stdout, stderr, argv };
    } catch (err) {
      const failure = classifyAdbFailure(err, "adb");
      return {
        ok: false,
        stdout: String(err?.stdout ?? ""),
        stderr: String(err?.stderr ?? ""),
        argv,
        code: failure.code,
        message: failure.message,
      };
    }
  }

  /**
   * 探测 adb 是否可用（`adb version`）。
   *
   * 为什么用 `version` 而不是 `devices`：`adb devices` 会在 adb server 没起来时
   * **顺手把它拉起来**（起后台进程）。"只是看看 adb 装没装"不该有这种副作用。
   */
  async function detect(force = false) {
    const at = Date.now();
    if (!force) {
      // adb 可用时不必每次轮询都自检（进程生命周期内它不会凭空消失）
      if (state.available === true) return { available: true, reason: "" };
      // adb 不可用时按 DETECT_RETRY_MS 重试，给"后来才装/adb 才进 PATH"留机会
      if (state.available === false && at - state.detectAt < DETECT_RETRY_MS) {
        return { available: false, reason: state.reason };
      }
    }
    const res = await runAdb(["version"], ADB_VERSION_TIMEOUT_MS);
    state.detectAt = at;
    if (res.ok) {
      const m = /Android Debug Bridge version\s+(\S+)/i.exec(res.stdout);
      state.adbVersion = m?.[1] ?? shortText(res.stdout, 64);
      const wasAvailable = state.available === true;
      state.available = true;
      state.reason = "";
      if (!wasAvailable) safeLog(`adb 可用（${options.adbPath}${state.adbVersion ? ` ${state.adbVersion}` : ""}）`);
      return { available: true, reason: "" };
    }
    const firstSeen = state.available !== false;
    state.available = false;
    state.reason = res.code || "ADB_UNAVAILABLE";
    if (firstSeen) {
      // 关键区分：ENOENT = 这台机器没装 adb（不是"没有 USB 设备"）；
      // 其它（超时/权限）= adb 在但这次没答上来。两者都必须说清楚。
      const message =
        state.reason === "ENOENT"
          ? `找不到 adb（${options.adbPath}）——USB 传输不可用；这只说明 adb 没装/不在 PATH，不代表没有 USB 设备`
          : `adb 探测失败（${options.adbPath}）：${res.message || state.reason}——只说明这次没拿到回答，不代表没有 USB 设备`;
      recordError({ serial: "", phase: "adb", code: state.reason, message });
    }
    return { available: false, reason: state.reason };
  }

  /** `adb devices -l` → 可用设备列表；同时把跳过原因记进 status/onError。 */
  async function readDevices() {
    const res = await runAdb(["devices", "-l"], ADB_DEVICES_TIMEOUT_MS);
    if (!res.ok) {
      recordError({ serial: "", phase: "devices", code: res.code || "ADB_FAILED", message: res.message });
      state.devices = [];
      state.skipped = [];
      return { ok: false, devices: [], skipped: [] };
    }
    const parsed = parseAdbDevices(res.stdout);
    state.devices = parsed.devices;
    state.skipped = parsed.skipped;
    // 跳过原因必须可见：unauthorized 是"用户在手机上还没点允许"，
    // offline 是"线在但设备没响应" —— 这两种都不是"没有设备"，也都不是本模块能修的。
    for (const item of parsed.skipped) {
      const code = String(item.reason ?? "unknown").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      recordError({
        serial: item.serial,
        phase: "device",
        code,
        message: `设备 ${item.serial} 状态 ${item.state}，已跳过（USB 传输需要已授权的 device 状态）`,
      });
    }
    return { ok: true, ...parsed };
  }

  /** `adb forward --list` → 映射数组；命令失败返回 null（"不知道" != "没有映射"）。 */
  async function listForwards() {
    const res = await runAdb(["forward", "--list"], ADB_FORWARD_TIMEOUT_MS);
    if (!res.ok) {
      recordError({ serial: "", phase: "forward-list", code: res.code || "ADB_FAILED", message: res.message });
      return null;
    }
    return parseForwardList(res.stdout);
  }

  // ───────────────────────── forward 管理 ─────────────────────────

  /**
   * 幂等建 forward：`adb -s <serial> forward tcp:<localPort> tcp:<devicePort>`。
   *
   * 幂等性来自两步：
   *   ① 先查 `adb forward --list`，已有同 serial + 同 local + 同 remote 的映射就直接复用；
   *   ② 真的执行时，adb 对"同一 local 端口重复 forward"本身也是覆盖而非报错。
   *
   * 注意 `createdByUs` 的语义：复用到的映射可能是用户手建的（真机上 Lead 手工
   * `adb forward tcp:45917 tcp:45917`），`stop()` 时**不能**删它 —— 删除别人建的
   * 隧道属于越权副作用。
   */
  async function ensureForward(serialValue, localPortValue, { checkExisting = true } = {}) {
    const serial = String(serialValue ?? "").trim();
    const localPort = Number(localPortValue);
    try {
      if (!serial || !Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
        return { ok: false, code: "INVALID_ARGUMENT", message: `forward 需要合法 serial 与端口（serial=${serial} port=${localPort}）` };
      }
      if (checkExisting) {
        const list = await listForwards();
        if (list) {
          const hit = list.find((f) => f.serial === serial && f.localPort === localPort && f.remotePort === options.devicePort);
          if (hit) {
            const tracked = state.forwards.get(serial);
            const entry =
              tracked && tracked.localPort === localPort
                ? tracked
                : { serial, localPort, remotePort: options.devicePort, createdByUs: false, adopted: true, since: Date.now() };
            state.forwards.set(serial, entry);
            return { ok: true, reused: true, adopted: entry.createdByUs !== true, localPort, remotePort: options.devicePort };
          }
        }
      }
      const res = await runAdb(["-s", serial, "forward", `tcp:${localPort}`, `tcp:${options.devicePort}`]);
      if (!res.ok) return { ok: false, code: res.code || "FORWARD_FAILED", message: res.message };
      state.forwards.set(serial, { serial, localPort, remotePort: options.devicePort, createdByUs: true, adopted: false, since: Date.now() });
      safeLog(`已建立 adb forward（${serial} tcp:${localPort} → tcp:${options.devicePort}）`);
      return { ok: true, reused: false, adopted: false, localPort, remotePort: options.devicePort };
    } catch (err) {
      return { ok: false, code: "INTERNAL", message: shortText(err?.message ?? err) };
    }
  }

  /** 移除本模块创建的 forward（复用的不动）。永不抛。 */
  async function removeForward(serialValue) {
    const serial = String(serialValue ?? "").trim();
    try {
      const entry = state.forwards.get(serial);
      if (!entry) return { ok: true, removed: false, reason: "not-tracked" };
      state.forwards.delete(serial);
      if (!entry.createdByUs) {
        // 复用到的映射可能属于用户会话/别的工具：保留它，我们不拥有它的生命周期
        return { ok: true, removed: false, reason: "adopted", localPort: entry.localPort };
      }
      const res = await runAdb(["-s", serial, "forward", "--remove", `tcp:${entry.localPort}`]);
      if (!res.ok) {
        recordError({ serial, phase: "cleanup", code: res.code || "REMOVE_FAILED", message: res.message });
        return { ok: false, code: res.code || "REMOVE_FAILED", message: res.message };
      }
      safeLog(`已移除 adb forward（${serial} tcp:${entry.localPort}）`);
      return { ok: true, removed: true, localPort: entry.localPort };
    } catch (err) {
      return { ok: false, code: "INTERNAL", message: shortText(err?.message ?? err) };
    }
  }

  /**
   * 为一个 serial 选定/建立 forward。
   *
   * 顺序：内存缓存 → 复用已有映射（任意本地端口，含用户手建的 45917）→
   * serial 稳定 hash → 端口被占/绑定失败时在区间内顺延（最多 MAX_BIND_ATTEMPTS 次）。
   *
   * @returns {Promise<{ok: boolean, localPort?: number, code?: string, message?: string}>}
   */
  async function assignForward(serial, forwardList, usedPorts) {
    // ① 内存里的记录优先（本进程上一轮建的，adb 侧仍存在就直接用）
    const cached = state.forwards.get(serial);
    if (cached) {
      const stillThere =
        forwardList === null
          ? true
          : forwardList.some((f) => f.serial === serial && f.localPort === cached.localPort && f.remotePort === options.devicePort);
      if (stillThere) return { ok: true, ...cached, reused: true };
      // 设备重插/adb 重启会丢 forward：内存记录作废，下面重建
      state.forwards.delete(serial);
    }
    // ② 复用已有映射：手机可能已经有一条到 45917 的 forward（用户手建、或上一轮插件活着）
    if (forwardList) {
      const existing = forwardList.find((f) => f.serial === serial && f.remotePort === options.devicePort);
      if (existing) {
        const entry = {
          serial,
          localPort: existing.localPort,
          remotePort: existing.remotePort,
          createdByUs: false,
          adopted: true,
          since: Date.now(),
        };
        state.forwards.set(serial, entry);
        safeLog(
          `复用已有 adb forward（${serial} tcp:${entry.localPort} → tcp:${entry.remotePort}），不再重复创建` +
            (entry.localPort < options.forwardBase || entry.localPort >= options.forwardBase + options.forwardSpan
              ? `；该端口不在默认区间 [${options.forwardBase}, ${options.forwardBase + options.forwardSpan})，按"已有映射优先"处理`
              : ""),
        );
        return { ok: true, ...entry, reused: true, adopted: true };
      }
    }
    // ③ 稳定 hash 起步，冲突顺延
    const base = options.forwardBase;
    const span = options.forwardSpan;
    const startOffset = (usbPortFor(serial, base, span) - base) % span;
    const conflicts = [];
    let attempts = 0;
    for (let step = 0; step < span && attempts < MAX_BIND_ATTEMPTS; step += 1) {
      const candidate = base + ((startOffset + step) % span);
      if (usedPorts.has(candidate)) continue;
      attempts += 1;
      // checkExisting=false：调用方刚拿到的 forwardList 里没有这条映射，不必再查一次
      const res = await ensureForward(serial, candidate, { checkExisting: false });
      if (res.ok) {
        usedPorts.add(candidate);
        if (conflicts.length > 0) {
          safeLog(`本地端口冲突 ${conflicts.length} 次（${conflicts.map((p) => `tcp:${p}`).join(", ")}），已顺延到 tcp:${candidate}`);
        }
        return { ...res, localPort: candidate, conflicts };
      }
      if (res.code === "EADDRINUSE") {
        // 端口被别的进程占了：换下一个，不是设备问题
        usedPorts.add(candidate);
        conflicts.push(candidate);
        recordError({
          serial,
          phase: "forward",
          code: "EADDRINUSE",
          message: `tcp:${candidate} 被占用，顺延下一个候选端口（${res.message}）`,
        });
        continue;
      }
      // 其它失败（设备掉线/未授权/多设备）：换端口也没用，如实上报
      recordError({ serial, phase: "forward", code: res.code || "FORWARD_FAILED", message: res.message });
      return { ok: false, code: res.code || "FORWARD_FAILED", message: res.message };
    }
    recordError({
      serial,
      phase: "forward",
      code: "PORT_ALLOC_FAILED",
      message: `连续 ${attempts} 个候选端口都不可用（${conflicts.map((p) => `tcp:${p}`).join(", ") || "无冲突记录"}）`,
    });
    return { ok: false, code: "PORT_ALLOC_FAILED" };
  }

  // ───────────────────────── 探测 ─────────────────────────

  /** 带超时的 fetch：**Promise.race 兜底**，即使注入的 fetchImpl 忽略 AbortSignal 也不会挂死。 */
  async function fetchWithTimeout(url, timeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller?.abort?.();
        } catch {
          /* 已结束 */
        }
        reject(Object.assign(new Error(`探测超时（${timeoutMs}ms）`), { code: "ETIMEDOUT" }));
      }, Math.max(10, Number(timeoutMs) || 10));
      // 刻意不 unref：探测超时是"必须给出的结果"。unref 后如果事件循环恰好只剩
      // 这一个定时器（例如宿主正在退出、或测试里没有别的 handle），Promise 就永远
      // 不 settle —— 那会把"超时"退化成"挂死"。定时器最多活 probeTimeoutMs（默认 1.2s）。
    });
    const request = Promise.resolve().then(() =>
      options.fetchImpl(url, {
        signal: controller?.signal,
        headers: { accept: "application/json" },
        redirect: "error",
      }),
    );
    // 超时先到时，request 之后仍可能 reject —— 挂一个空 catch，避免 unhandledRejection
    request.catch(() => {});
    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 探测一条 forward 后面的 mesh 健康接口，生成端点。
   *
   * 失败分类（每一条都不是"设备不存在"）：
   *   · ETIMEDOUT      —— 这次没拿到回答
   *   · ECONNREFUSED   —— 隧道在但设备侧没人监听（mesh 没起）
   *   · HTTP_<code>    —— 隧道通了，但响应不是 200（端口被别的服务占用）
   *   · NOT_MESH       —— 200 且是 JSON，但不是 dsh-mesh（同样可能是端口被占）
   *   · BAD_JSON       —— 200 但不是 JSON
   *
   * @returns {Promise<{ok: true, rttMs: number, record: object, endpoint: object} | {ok: false, error: object}>}
   */
  async function probe(serialValue, localPortValue) {
    const serial = String(serialValue ?? "").trim();
    try {
      const tracked = state.forwards.get(serial);
      const explicitPort = Number(localPortValue);
      const localPort = Number.isInteger(explicitPort) && explicitPort > 0 ? explicitPort : Number(tracked?.localPort ?? 0);
      if (!serial) return { ok: false, error: makeError("", "probe", "INVALID_ARGUMENT", "probe 需要 serial") };
      if (!localPort) {
        return {
          ok: false,
          error: makeError(serial, "probe", "NO_FORWARD", `serial ${serial} 还没有 adb forward，先 ensureForward() 再 probe()`),
        };
      }
      const url = `http://127.0.0.1:${localPort}/mesh/v1/health`;
      const started = Date.now();
      let res = null;
      try {
        res = await fetchWithTimeout(url, options.probeTimeoutMs);
      } catch (err) {
        const code = String(err?.code ?? "") || (err?.name === "AbortError" ? "ETIMEDOUT" : "PROBE_FAILED");
        return { ok: false, error: makeError(serial, "probe", code, `GET ${url} 失败：${err?.message ?? err}`) };
      }
      const rttMs = Date.now() - started;
      if (!res) return { ok: false, error: makeError(serial, "probe", "NO_RESPONSE", `GET ${url} 没有返回响应`) };
      if (res.ok !== true) {
        return {
          ok: false,
          error: makeError(
            serial,
            "probe",
            `HTTP_${Number(res.status) || "ERROR"}`,
            `GET ${url} 返回 ${res.status ?? "?"}——本地端口有服务，但不是 mesh 健康响应（端口可能被别的进程占用）`,
          ),
        };
      }
      let body = null;
      try {
        body = await res.json();
      } catch (err) {
        return { ok: false, error: makeError(serial, "probe", "BAD_JSON", `GET ${url} 响应不是 JSON：${err?.message ?? err}`) };
      }
      if (!looksLikeMeshHealth(body)) {
        return {
          ok: false,
          error: makeError(
            serial,
            "probe",
            "NOT_MESH",
            `GET ${url} 返回的不是 dsh-mesh 记录（app=${String(body?.app ?? "?")}）——可能是别的服务占用了这个本地端口`,
          ),
        };
      }
      const dev = state.devices.find((d) => d.serial === serial) ?? { serial };
      return { ok: true, rttMs, record: body, endpoint: buildEndpoint(dev, localPort, rttMs, body) };
    } catch (err) {
      // 最后一道防线：probe 的调用点（定时轮询/UI/诊断）都不处理异常
      return { ok: false, error: makeError(serial, "probe", "INTERNAL", err?.message ?? err) };
    }
  }

  /**
   * 生成接入 peer 注册表用的端点。
   *
   * 字段对齐 `discovery.js` 的端点结构（key/transport/channel/host/port），并额外带
   * `record`（原始 health 记录）供接线处直接 `discovery.note(ep.record, ep.host, {...})`。
   * **不要把 `record.host` 当成可达地址**：那是手机自述的局域网 IP，桌面到它不一定通；
   * USB 端点的可达地址永远是 `127.0.0.1:<localPort>`。
   */
  function buildEndpoint(dev, localPort, rttMs, record) {
    const serial = String(dev?.serial ?? "");
    const rec = record && typeof record === "object" ? record : {};
    return {
      key: `${TRANSPORT_NAME}:${serial}`,
      channel: `${TRANSPORT_NAME}:${serial}`,
      transport: TRANSPORT_NAME,
      host: "127.0.0.1",
      port: Number(localPort),
      serial,
      model: String(dev?.model ?? ""),
      product: String(dev?.product ?? ""),
      deviceTransport: String(dev?.transport ?? ""),
      usb: dev?.usb !== false,
      // 自述字段（UI/日志用；注册表的权威值仍是 note() 里那份 record）
      id: String(rec.id ?? ""),
      machine: String(rec.machine ?? ""),
      hostname: String(rec.hostname ?? ""),
      version: String(rec.version ?? ""),
      os: String(rec.os ?? ""),
      app: String(rec.app ?? ""),
      remotePort: options.devicePort,
      rttMs: Number(rttMs) || 0,
      probedAt: Date.now(),
      // 原始 health 记录（接线时原样喂给 discovery.note()，不要在这里改字段语义）
      record: rec,
    };
  }

  // ───────────────────────── 轮询 / 生命周期 ─────────────────────────

  /** 跑一轮：探测 adb → 列设备 → 建 forward → 探测健康 → 发布端点。永不抛。 */
  async function pollOnce() {
    if (state.polling) return status(); // 上一轮还没跑完（start 的首次轮询 + 定时器撞车）：跳过这一轮
    state.polling = true;
    state.pollCount += 1;
    state.lastPollAt = Date.now();
    const generation = state.generation;
    /** 这一轮是否已经被 stop()/start() 作废（有 await 的地方都要重新确认）。 */
    const stale = () => generation !== state.generation;
    try {
      const det = await detect();
      // 关键：stop() 可能在任意 await 点插进来。作废后连"发布空列表"都不做 ——
      // 那会让调用方以为传输又刷新了一次（也掩盖真正的生命周期结束）。
      if (stale()) return status();
      if (!det.available) {
        // adb 不可用 ≠ 没有 USB 设备：状态里已有 reason/errors 说清楚，这里只发空列表
        publishEndpoints([]);
        return status();
      }
      const read = await readDevices();
      if (stale()) return status();
      if (!read.ok || read.devices.length === 0) {
        publishEndpoints([]);
        return status();
      }
      const forwardList = await listForwards();
      if (stale()) return status();
      const usedPorts = new Set();
      if (forwardList) for (const f of forwardList) usedPorts.add(f.localPort);
      // 设备已经拔掉的：忘掉内存里的 forward 记录（adb 自己会在设备断连时清理映射）
      for (const serial of [...state.forwards.keys()]) {
        if (!read.devices.some((d) => d.serial === serial)) state.forwards.delete(serial);
      }

      const endpoints = [];
      const alive = new Set();
      for (const dev of read.devices) {
        // stop 之后不许再建 forward：否则卸载清理跑完了，这里又建一条，等于泄漏
        if (stale()) return status();
        const assign = await assignForward(dev.serial, forwardList, usedPorts);
        if (assign.ok) {
          usedPorts.add(assign.localPort);
          const pr = await probe(dev.serial, assign.localPort);
          if (stale()) return status();
          if (pr.ok) {
            endpoints.push(pr.endpoint);
            alive.add(dev.serial);
          } else {
            // 探测失败只记错误：端点不进列表，但**设备本身仍在**（状态里 devices 还在）
            recordError(pr.error);
          }
        }
      }
      if (stale()) return status();

      // 只在"通 ↔ 不通"切换时打日志，避免每 15s 一行
      for (const serial of alive) {
        if (!state.upSet.has(serial)) {
          const ep = endpoints.find((e) => e.serial === serial);
          safeLog(`USB 对端可达（${serial} → 127.0.0.1:${ep?.port ?? "?"}，${ep?.machine || "未报机器名"}）`);
        }
      }
      for (const serial of [...state.upSet]) {
        if (!alive.has(serial)) {
          safeLog(`USB 对端不可达（${serial}）——端点暂时移除；这是"没答上来"，不是"设备不存在"，原因见 status().errors`);
        }
      }
      state.upSet = alive;
      publishEndpoints(endpoints);
      return status();
    } catch (err) {
      recordError({ serial: "", phase: "poll", code: "POLL_FAILED", message: shortText(err?.message ?? err) });
      return status();
    } finally {
      state.polling = false;
    }
  }

  /** 启动定时轮询（幂等：重复调用直接返回当前状态）。 */
  async function start() {
    if (state.started) return status();
    state.started = true;
    state.generation += 1; // 作废可能存在的上一轮轮询（stop→start 的快速切换）
    safeLog(
      `USB 传输启动（adb=${options.adbPath} devicePort=${options.devicePort} ` +
        `forward=${options.forwardBase}~${options.forwardBase + options.forwardSpan - 1} pollMs=${options.pollMs}）`,
    );
    try {
      await pollOnce();
    } catch (err) {
      recordError({ serial: "", phase: "start", code: "START_FAILED", message: shortText(err?.message ?? err) });
    }
    if (state.started && !state.timer) {
      state.timer = setInterval(() => {
        pollOnce().catch(() => {});
      }, options.pollMs);
      state.timer.unref?.();
    }
    return status();
  }

  /**
   * 停止：清定时器 + 移除**本模块创建的** forward + 发布空端点。
   * 幂等：未启动时调用也安全（仍会清掉可能残留的 forward 记录）。
   */
  async function stop() {
    const wasStarted = state.started;
    state.started = false;
    // 先作废进行中的轮询，再清资源：否则一轮差之毫厘的轮询会在清理之后
    // 又建一条 forward / 又重新发布端点（插件卸载后的泄漏）。
    state.generation += 1;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    for (const serial of [...state.forwards.keys()]) {
      try {
        await removeForward(serial);
      } catch (err) {
        recordError({ serial, phase: "stop", code: "CLEANUP_FAILED", message: shortText(err?.message ?? err) });
      }
    }
    state.upSet = new Set();
    if (state.endpoints.length > 0 || wasStarted) publishEndpoints([], { reason: "stop" });
    if (wasStarted) safeLog("USB 传输已停止（定时器已清理；本模块创建的 adb forward 已移除，复用的映射保留）");
    return status();
  }

  // ───────────────────────── 公开 API ─────────────────────────

  /** 一次性轮询（等一轮完成）。 */
  function poll() {
    return pollOnce();
  }

  /**
   * `adb devices -l` → 可用设备数组（只含 `device` 状态）。
   * 跳过原因在 `status().skipped` 与 `onError` 里。永不抛（失败返回 []）。
   */
  async function listDevices() {
    try {
      const det = await detect();
      if (!det.available) return [];
      const read = await readDevices();
      return read.devices;
    } catch (err) {
      recordError({ serial: "", phase: "devices", code: "INTERNAL", message: shortText(err?.message ?? err) });
      return [];
    }
  }

  /** 状态快照（诊断/UI/测试）。**永不抛**。 */
  function status() {
    try {
      return {
        transport: TRANSPORT_NAME,
        available: state.available === true,
        detected: state.available !== null,
        reason: state.available === false ? state.reason : "",
        adbPath: options.adbPath,
        adbVersion: state.adbVersion,
        started: state.started,
        polling: state.polling,
        pollCount: state.pollCount,
        lastPollAt: state.lastPollAt,
        pollMs: options.pollMs,
        devicePort: options.devicePort,
        forwardBase: options.forwardBase,
        forwardSpan: options.forwardSpan,
        devices: state.devices.map((d) => ({ ...d })),
        skipped: state.skipped.map((d) => ({ ...d })),
        forwards: [...state.forwards.values()].map((f) => ({ ...f })),
        endpoints: state.endpoints.map((ep) => ({
          key: ep.key,
          transport: ep.transport,
          host: ep.host,
          port: ep.port,
          serial: ep.serial,
          machine: ep.machine,
          id: ep.id,
          rttMs: ep.rttMs,
        })),
        errors: state.errors.map((e) => ({ ...e })),
        errCount: state.errCount,
      };
    } catch (err) {
      // status() 也不许抛：它会被 HTTP 健康检查与 UI 直接调用
      return {
        transport: TRANSPORT_NAME,
        available: false,
        detected: false,
        reason: "STATUS_FAILED",
        adbPath: options.adbPath,
        adbVersion: "",
        started: false,
        polling: false,
        pollCount: 0,
        lastPollAt: 0,
        pollMs: options.pollMs,
        devicePort: options.devicePort,
        forwardBase: options.forwardBase,
        forwardSpan: options.forwardSpan,
        devices: [],
        skipped: [],
        forwards: [],
        endpoints: [],
        errors: [{ serial: "", phase: "status", code: "STATUS_FAILED", message: shortText(err?.message ?? err), at: Date.now() }],
        errCount: state.errCount,
      };
    }
  }

  /** 只读选项快照（接线处要读 pollMs 传 probeIntervalMs）。 */
  function getOptions() {
    return {
      adbPath: options.adbPath,
      devicePort: options.devicePort,
      forwardBase: options.forwardBase,
      forwardSpan: options.forwardSpan,
      pollMs: options.pollMs,
      probeTimeoutMs: options.probeTimeoutMs,
    };
  }

  return {
    start,
    stop,
    poll,
    refresh: poll,
    detect: () => detect(true),
    listDevices,
    listForwards,
    ensureForward,
    removeForward,
    probe,
    status,
    getOptions,
    // 自测与诊断用：等价于 status()，但语义上更明确
    __statusForTest: status,
  };
}

/** 仅为自测导出（生产代码不需要 sleep）。 */
export const __test = { sleep };
