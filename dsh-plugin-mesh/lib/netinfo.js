/**
 * 本机网络信息采集：**任何情况下都不抛**，并且把"为什么没拿到"一起带出来。
 *
 * 为什么单独一个模块（而不是继续散在 discovery.js 里）：
 *
 *   1. **Android/proot 的现实**：手机的 Native 环境可能让 `os.networkInterfaces()`
 *      失败、返回空、或者返回一份 MAC 全为 0 的地址表（SIOCGIFHWADDR 被 SELinux 拒）。
 *      这三种情况在数据上分别长得像"没有网卡""没有网络"，但**都是探测失败或部分失败**，
 *      不能当成"这机器没有局域网地址"这种硬事实（AGENTS.md 硬约束 1）。
 *      所以结果里必须同时有 `source` 与 `errors`。
 *   2. **兜底要有顺序且可观察**：配置覆盖 > `os.networkInterfaces()` > UDP 源地址 >
 *      `/proc/net`。每一步都记一条 error（若失败），调用方/诊断页能看到走到了哪一步。
 *   3. **可测试**：所有探测都可注入（`deps.networkInterfaces` / `deps.readFile` /
 *      `deps.udpConnect`），离线就能覆盖六种形态，不必真造一台 Android。
 *
 * 采集顺序与语义：
 *   · `advertiseAddress`（配置）：**最高优先级**。填了就用它当本机对外地址，
 *     用于公告与名片 `host`。只接受 IPv4（可带 `:port`，端口部分会被忽略 ——
 *     本机监听端口由 HTTP 服务决定）。
 *   · `os.networkInterfaces()`：首选。非回环 IPv4 里按接口名打分挑一个
 *     （wlan0/eth0/en0 优先，utun/docker/veth 最后）。
 *   · UDP 源地址：对一个外部地址做 `dgram.connect()`（**不发任何包**，内核只做路由
 *     选择），`socket.address()` 就是本机出站源地址。这是 Tailscale 官方
 *     `feature/androidbin` 在 Android 上用的同一招 —— 不需要 netlink，也不需要
 *     任何 Android 权限。因为 Node 的 dgram `connect` 是异步的，这里只提供
 *     `udpSourceAddress()`/`collectNetInfoAsync()`；同步的 `collectNetInfo()` 接受
 *     `udpSource` 注入口（由 `warmNetInfo()` 预热后缓存在模块里）。
 *   · `/proc/net/fib_trie`（+ `/proc/net/route`）：最后兜底。Android app UID 上
 *     常常 EACCES，但代价极低，值得一试。
 */
import os from "node:os";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";

/** `/proc/net/fib_trie`：LOCAL 地址表。 */
const PROC_FIB_TRIE = "/proc/net/fib_trie";
/** `/proc/net/route`：默认路由/网关。 */
const PROC_NET_ROUTE = "/proc/net/route";

/** UDP 源地址探测的候选目标（按顺序试；局域网网关会插在中间）。 */
export const DEFAULT_UDP_TARGETS = ["223.5.5.5", "8.8.8.8", "1.1.1.1"];

/**
 * UDP 探测目标的默认端口。用 53 是因为"任何网络都该放行"，而 `connect` 不发包，
 * 所以端口本身不影响结果，只是让内核去查路由表。
 */
const UDP_PROBE_PORT = 53;

/** 单次 UDP 探测的超时。只是路由查询，正常 <1ms；给 800ms 足够宽。 */
const UDP_PROBE_TIMEOUT_MS = 800;

/** IPv4 形态（只做形状校验；不追求完整合法性，别让 999.1.1.1 混进来即可）。 */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 模块级配置：由 index.js 的 apply 与 MeshDiscovery 构造时写入。 */
let settings = { advertiseAddress: "" };
/** 最近一次 UDP 兜底拿到的地址（`{address, target}`）；同步采集路径会用它。 */
let udpHint = null;

/** 把错误统一成 `{source, code, message}`：区分"没装/没权限/超时/其它"。 */
export function classifyError(err, source = "") {
  const raw = err && typeof err === "object" ? err : { message: String(err ?? "") };
  let code = String(raw.code ?? "").trim();
  if (!code) {
    const msg = String(raw.message ?? "");
    if (/timed?\s*out|timeout/i.test(msg)) code = "ETIMEDOUT";
    else if (/permission denied|EACCES|EPERM/i.test(msg)) code = "EPERM";
    else code = "UNKNOWN";
  }
  const message = String(raw.message ?? raw).replace(/\s+/g, " ").slice(0, 200);
  return source ? { source, code, message } : { code, message };
}

/** 严格 IPv4 判断（0-255、无前导零之外的怪形态）。 */
export function isIPv4(value) {
  const m = IPV4_RE.exec(String(value ?? "").trim());
  if (!m) return false;
  for (let i = 1; i <= 4; i += 1) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

/** 能当"本机对外地址"用的 IPv4：合法、非回环、非 0.0.0.0、非 link-local。 */
export function isUsableIPv4(value) {
  if (!isIPv4(value)) return false;
  const s = String(value).trim();
  if (s.startsWith("127.") || s === "0.0.0.0" || s.startsWith("169.254.")) return false;
  return true;
}

/** 接口名打分：越小越优先（与 0.5.4 的 preferredAddress 完全一致，避免行为漂移）。 */
function scoreIface(name) {
  const n = String(name ?? "");
  if (/^(en0|en1|eth0|wlan0|Wi-?Fi)$/i.test(n)) return 0;
  if (/^(en|eth|wlan|wl)/i.test(n)) return 1;
  if (/^(utun|tun|tap|bridge|vmnet|docker|veth|lo)/i.test(n)) return 9;
  return 5;
}

/** 挑一个最可能被对端访问到的 IPv4（接口名打分；同分按原顺序，稳定）。 */
function pickPreferred(candidates) {
  const sorted = candidates
    .slice()
    .sort((a, b) => scoreIface(a.iface) - scoreIface(b.iface));
  return sorted[0]?.address ?? "";
}

/**
 * 判断一个 MAC 是不是"可用"的。
 *
 * Android 上 `os.networkInterfaces()` 常见返回 `00:00:00:00:00:00` —— 那是
 * SIOCGIFHWADDR 被拒后的填充值，不是"这台机器没有 MAC"。把它当"拿不到"上报，
 * 而不是悄悄显示成全 0（那会让人以为设备真没有网卡地址）。
 */
export function usableMac(mac) {
  const s = String(mac ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/.test(s)) return false;
  if (s === "00:00:00:00:00:00" || s === "00-00-00-00-00-00") return false;
  return true;
}

/** 解析 `host:port` / `host` / `ip`；返回 null 表示不可用。 */
export function parseHostPort(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.startsWith("[") || s.includes("/")) return null;
  const idx = s.lastIndexOf(":");
  if (idx < 0) return { host: s, port: 0 };
  const host = s.slice(0, idx).trim();
  const portRaw = s.slice(idx + 1).trim();
  if (!host || !portRaw) return null;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * `staticPeers` 的单条解析。允许主机名（扫描时直接 `http://<host>:<port>`），
 * 允许省略端口（省略 = 用本机端口与默认端口去试）。
 * @returns {{host: string, port: number} | null}
 */
export function parsePeerSpec(raw) {
  const parsed = parseHostPort(raw);
  if (!parsed) return null;
  // 主机名形态做最基本的字符约束，避免把 "http://x" 这类东西当主机名送进 fetch
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parsed.host)) return null;
  return parsed;
}

/** `staticPeers` → 去重后的主机列表（顺序保留）。 */
export function peerHostsFromSpecs(specs) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(specs) ? specs : []) {
    const spec = parsePeerSpec(raw);
    if (!spec || seen.has(spec.host)) continue;
    seen.add(spec.host);
    out.push(spec.host);
  }
  return out;
}

/** `staticPeers` → 去重后的显式端口列表（只有写了端口的条目才有）。 */
export function peerPortsFromSpecs(specs) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(specs) ? specs : []) {
    const spec = parsePeerSpec(raw);
    if (!spec || !spec.port || seen.has(spec.port)) continue;
    seen.add(spec.port);
    out.push(spec.port);
  }
  return out;
}

/**
 * 把 `os.networkInterfaces()` 的原始输出规整成统一形态。
 *
 * `family` 在旧 Node 上是数字 4/6、新 Node 上是 "IPv4"/"IPv6"，这里统一成字符串；
 * 缺失字段一律降级为空串，**不抛**（输入可能来自注入的探针）。
 */
export function normalizeInterfaces(raw) {
  const out = [];
  if (!raw || typeof raw !== "object") return out;
  for (const [iface, addrs] of Object.entries(raw)) {
    if (!Array.isArray(addrs)) continue;
    for (const a of addrs) {
      if (!a || typeof a !== "object") continue;
      const familyRaw = a.family;
      const family =
        familyRaw === 4 || String(familyRaw).toLowerCase() === "ipv4"
          ? "IPv4"
          : familyRaw === 6 || String(familyRaw).toLowerCase() === "ipv6"
            ? "IPv6"
            : "";
      const address = String(a.address ?? "").trim();
      if (!address) continue;
      const entry = {
        iface: String(iface),
        address,
        family,
        internal: a.internal === true,
      };
      const mac = String(a.mac ?? "").trim();
      if (mac) entry.mac = mac;
      out.push(entry);
    }
  }
  return out;
}

/** 从地址表里挑一个全局 IPv6（非回环、非 link-local）。没有返回空串。 */
export function pickLanIPv6(addresses) {
  for (const a of Array.isArray(addresses) ? addresses : []) {
    if (a.family !== "IPv6" || a.internal) continue;
    const s = String(a.address ?? "").toLowerCase();
    if (s.startsWith("fe80:") || s === "::1" || s === "::") continue;
    return a.address;
  }
  return "";
}

/** 十六进制小端（`0101A8C0`）→ `192.168.1.1`。 */
function hexToIPv4(hex) {
  const s = String(hex ?? "").trim();
  if (!/^[0-9a-fA-F]{8}$/.test(s)) return "";
  const b = [0, 2, 4, 6].map((i) => parseInt(s.slice(i, i + 2), 16));
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

/**
 * 解析 `/proc/net/route`（每行：Iface Destination Gateway Flags RefCnt Use Metric Mask …）。
 * 只关心默认路由（Destination=00000000）。失败/空输入返回空结构，不抛。
 */
export function parseProcNetRoute(text) {
  const routes = [];
  let defaultGateway = "";
  let defaultIface = "";
  for (const line of String(text ?? "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const [iface, destination, gateway, flags, , , metric, mask] = cols;
    if (!/^[0-9a-fA-F]{8}$/.test(destination ?? "") || !/^[0-9a-fA-F]{8}$/.test(gateway ?? "")) continue;
    const route = {
      iface,
      destination: hexToIPv4(destination),
      gateway: hexToIPv4(gateway),
      flags: parseInt(flags, 16) || 0,
      metric: Number(metric) || 0,
      mask: hexToIPv4(mask),
    };
    routes.push(route);
    if (destination === "00000000" && !defaultGateway) {
      defaultGateway = route.gateway;
      defaultIface = route.iface;
    }
  }
  return { routes, defaultGateway, defaultIface };
}

/**
 * 解析 `/proc/net/fib_trie` 里的 LOCAL 地址。
 *
 * 形态是两层：
 *   |-- 192.168.1.19
 *      /32 host LOCAL
 * 所以"上一行是地址、这一行是 host LOCAL"就把地址收下。跳过回环与 0.0.0.0。
 */
export function parseProcFibTrie(text) {
  const out = [];
  const seen = new Set();
  let candidate = "";
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*\|--\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(line);
    if (m) {
      candidate = m[1];
      continue;
    }
    if (candidate && /\/32\s+host\s+LOCAL/i.test(line)) {
      if (isUsableIPv4(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
      candidate = "";
    }
  }
  return out;
}

/** 读文件的默认实现；失败由调用方 catch。 */
function defaultReadFile(path) {
  return readFileSync(path, "utf8");
}

/**
 * UDP 源地址探测（**不发包**）：`connect()` 让内核查一次路由，`address()` 就是
 * 本机用于出站的那个源地址。Android app UID 上这是少数不依赖 netlink 的可靠手段
 * （Tailscale 官方 androidbin 用的就是它）。
 *
 * @returns {Promise<{address: string, target: string} | null>} 拿不到返回 null，绝不抛
 */
export async function udpSourceAddress({ targets = DEFAULT_UDP_TARGETS, deps = {}, timeoutMs = UDP_PROBE_TIMEOUT_MS } = {}) {
  const connect = deps.udpConnect ?? ((target) => defaultUdpConnect(target, timeoutMs));
  // 局域网网关排在第 3 位：它给出的源地址最贴近 LAN；前两个用于"没有默认路由信息"的情况。
  let list = targets;
  try {
    const route = parseProcNetRoute((deps.readFile ?? defaultReadFile)(PROC_NET_ROUTE));
    if (isIPv4(route.defaultGateway) && !list.includes(route.defaultGateway)) {
      list = [list[0], list[1], route.defaultGateway, ...list.slice(2)].filter(Boolean);
    }
  } catch {
    /* /proc/net/route 读不到不影响探测本身 */
  }
  for (const target of list) {
    try {
      const hit = await connect(target);
      const address = typeof hit === "string" ? hit : String(hit?.address ?? "");
      if (isUsableIPv4(address)) return { address, target: String(target) };
    } catch {
      /* 这个目标不可用，试下一个 */
    }
  }
  return null;
}

/** 默认的 UDP connect 实现（可被测试注入替换）。 */
function defaultUdpConnect(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, classifyError({ code: "ETIMEDOUT", message: "UDP 源地址探测超时" })), timeoutMs);
    timer.unref?.();
    socket.once("error", (err) => finish(reject, err));
    try {
      socket.connect(UDP_PROBE_PORT, String(target), () => {
        try {
          finish(resolve, socket.address().address);
        } catch (err) {
          finish(reject, err);
        }
      });
    } catch (err) {
      finish(reject, err);
    }
  });
}

/** 解析 `advertiseAddress`：只接受 IPv4（可带端口，端口忽略）。返回 `{host}` 或 `{error}`。 */
function parseAdvertise(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const parsed = parseHostPort(s);
  if (!parsed) return { error: "advertiseAddress 格式应为 <IPv4> 或 <IPv4>:<port>" };
  if (!isIPv4(parsed.host)) return { error: "advertiseAddress 只接受 IPv4 地址（例如 192.168.1.19）" };
  return { host: parsed.host };
}

/**
 * 同步采集一次本机网络信息。**任何情况下都不抛**（调用点在构造函数、每 5s 心跳、
 * 以及 HTTP 响应路径上；一次抛异常就是整台机器掉线/整个插件停用）。
 *
 * @param {object} opts
 * @param {string} [opts.advertiseAddress] 配置覆盖（缺省用模块级配置）
 * @param {{address?: string} | string | null} [opts.udpSource] UDP 兜底结果（缺省用模块缓存）
 * @param {object} [opts.deps] 测试注入口：networkInterfaces / readFile / udpConnect
 * @returns {{lanIPv4: string, lanIPv6?: string, addresses: object[], source: "os"|"udp"|"proc"|"config"|"none", macsAvailable: boolean, errors: object[]}}
 */
export function collectNetInfo(opts = {}) {
  const out = {
    lanIPv4: "",
    addresses: [],
    source: "none",
    macsAvailable: false,
    errors: [],
  };
  try {
    const safeOpts = opts && typeof opts === "object" ? opts : {};
    const deps = safeOpts.deps && typeof safeOpts.deps === "object" ? safeOpts.deps : {};
    const networkInterfaces = deps.networkInterfaces ?? (() => os.networkInterfaces());
    const readFile = deps.readFile ?? defaultReadFile;
    const advertiseRaw = "advertiseAddress" in safeOpts ? safeOpts.advertiseAddress : settings.advertiseAddress;
    const udpSource = "udpSource" in safeOpts ? safeOpts.udpSource : udpHint;

    // ① 配置覆盖先解析（格式错要留下证据，然后继续探测 —— 不能因为填错就变"没有地址"）
    let advertised = "";
    try {
      const parsed = parseAdvertise(advertiseRaw);
      if (parsed?.error) out.errors.push({ source: "config", code: "INVALID", message: parsed.error });
      else if (parsed?.host) advertised = parsed.host;
    } catch (err) {
      out.errors.push(classifyError(err, "config"));
    }

    // ② 首选 os.networkInterfaces()
    let osAddresses = [];
    try {
      const raw = networkInterfaces();
      osAddresses = normalizeInterfaces(raw);
      out.addresses.push(...osAddresses);
      if (osAddresses.length === 0) {
        out.errors.push({ source: "os", code: "EMPTY", message: "os.networkInterfaces() 没有返回任何地址" });
      }
    } catch (err) {
      out.errors.push(classifyError(err, "os"));
    }

    // MAC 可用性：有地址但 MAC 全是 0 —— Android 的典型形态，必须显式说出来
    if (osAddresses.length > 0) {
      out.macsAvailable = osAddresses.some((a) => a.family === "IPv4" && !a.internal && usableMac(a.mac));
      if (!out.macsAvailable) {
        out.errors.push({
          source: "os",
          code: "MAC_UNAVAILABLE",
          message: "网卡 MAC 不可用（全 0 或读不到；Android 上 SIOCGIFHWADDR 常被 SELinux 拒）",
        });
      }
    }

    // ③ 选主地址：config > os > udp(hint) > proc
    let primary = "";
    let source = "none";
    const lanCandidates = osAddresses.filter((a) => a.family === "IPv4" && !a.internal && isUsableIPv4(a.address));
    if (lanCandidates.length > 0) {
      primary = pickPreferred(lanCandidates);
      source = "os";
    }

    if (!primary && udpSource) {
      const candidate = String(typeof udpSource === "string" ? udpSource : (udpSource.address ?? "")).trim();
      if (isUsableIPv4(candidate)) {
        primary = candidate;
        source = "udp";
        if (!out.addresses.some((a) => a.address === candidate)) {
          out.addresses.push({ iface: "udp", address: candidate, family: "IPv4", internal: false });
        }
      }
    }

    if (!primary) {
      try {
        const fib = parseProcFibTrie(String(readFile(PROC_FIB_TRIE) ?? ""));
        if (fib.length > 0) {
          let iface = "proc";
          try {
            const route = parseProcNetRoute(String(readFile(PROC_NET_ROUTE) ?? ""));
            if (route.defaultIface) iface = route.defaultIface;
          } catch {
            /* 路由表读不到就只报地址 */
          }
          for (const address of fib) {
            if (!out.addresses.some((a) => a.address === address)) {
              out.addresses.push({ iface, address, family: "IPv4", internal: false });
            }
          }
          primary = pickPreferred(fib.map((address) => ({ iface, address })));
          source = "proc";
        }
      } catch (err) {
        out.errors.push(classifyError(err, "proc"));
      }
    }

    if (advertised) {
      primary = advertised;
      source = "config";
      if (!out.addresses.some((a) => a.address === advertised)) {
        out.addresses.push({ iface: "config", address: advertised, family: "IPv4", internal: false });
      }
    }

    out.lanIPv4 = primary;
    out.source = source;
    const ipv6 = pickLanIPv6(osAddresses);
    if (ipv6) out.lanIPv6 = ipv6;
    return out;
  } catch (err) {
    // 最后一道防线：本函数的所有调用点都假定它"不会抛"。
    try {
      out.errors.push(classifyError(err, "netinfo"));
    } catch {
      /* 连错误都记不下就算了，至少返回一个空结构 */
    }
    return { lanIPv4: "", addresses: [], source: "none", macsAvailable: false, errors: out.errors };
  }
}

/**
 * 异步采集：先跑同步路径；只有"一个可用地址都没有"时才做 UDP 探测（做完写缓存，
 * 后续同步调用立刻受益）。**不抛**。
 */
export async function collectNetInfoAsync(opts = {}) {
  let info = collectNetInfo(opts);
  if (info.lanIPv4) return info;
  try {
    const hit = await udpSourceAddress({ targets: opts.targets, deps: opts.deps ?? {}, timeoutMs: opts.timeoutMs });
    if (hit) {
      udpHint = hit;
      return collectNetInfo({ ...opts, udpSource: hit });
    }
    info = {
      ...info,
      errors: [...info.errors, { source: "udp", code: "UNAVAILABLE", message: "UDP 源地址探测未拿到可用地址" }],
    };
  } catch (err) {
    info = { ...info, errors: [...info.errors, classifyError(err, "udp")] };
  }
  return info;
}

/**
 * 预热：给同步路径准备 UDP 兜底地址。启动时调一次即可（拿到后会重播公告）。
 */
export function warmNetInfo(opts = {}) {
  return collectNetInfoAsync(opts);
}

/** 从采集结果里取"本机对外地址"；拿不到就退回 127.0.0.1（与 0.5.4 行为一致）。 */
export function preferredAddressFrom(info) {
  try {
    const ip = String(info?.lanIPv4 ?? "");
    return isUsableIPv4(ip) ? ip : "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

/** 写入模块级配置（advertiseAddress）。index.js 的 apply 与 MeshDiscovery 构造时调用。 */
export function configureNetInfo(patch = {}) {
  try {
    if (!patch || typeof patch !== "object") return;
    if ("advertiseAddress" in patch) settings.advertiseAddress = String(patch.advertiseAddress ?? "");
  } catch {
    /* 配置写不进来只影响覆盖，不影响探测 */
  }
}

/** 按当前模块级配置采集一次（自述/诊断/UI 用）。 */
export function currentNetInfo(opts = {}) {
  return collectNetInfo({ advertiseAddress: settings.advertiseAddress, ...opts });
}

/** 只为自测：清掉模块级配置与 UDP 缓存，避免用例之间互相污染。 */
export function __resetNetInfoForTest() {
  settings = { advertiseAddress: "" };
  udpHint = null;
}

/** 只为自测：看模块级状态（确认 configure/warm 的写入生效）。 */
export function __getNetInfoStateForTest() {
  return { advertiseAddress: settings.advertiseAddress, udpHint };
}
