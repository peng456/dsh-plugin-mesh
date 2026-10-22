/**
 * Mesh 发现模块：局域网内自动发现其他 DSH 实例。
 *
 * 用自建的 UDP 组播心跳，而不是 mDNS/Bonjour —— 理由：
 *   · 零依赖（只用 node:dgram），跨平台行为一致
 *   · 完全可控：报文格式、过期策略、多网卡处理都由我们决定
 *   · 我们只需要 DSH↔DSH 互相发现，不需要和 Bonjour 互操作
 *
 * 协议：每 5 秒向 239.255.42.99:45892 发一个 JSON 心跳，同时监听该组播组。
 *   超过 ttlMs 没心跳 → 标记 offline（仍保留在列表里，用户要看到"有这台机器"）
 *   超过 keepMs 没心跳 → 丢弃
 *
 * 安全：发现是完全公开的（局域网内谁都能看见谁），这是有意设计 ——
 *       先让你看见机器，再决定要不要和它配对。真正的操作要过 token。
 */
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import os from "node:os";
import { sanitizeCapabilities, isCapabilityStale, summarizeCapabilities, currentCapabilities } from "./capabilities.js";
import { osInfo, sanitizeOsInfo, systems, sanitizeSystems } from "./osinfo.js";

export const MESH_GROUP = "239.255.42.99";
export const MESH_PORT = 45892;
export const APP_TAG = "dsh-mesh";

/** 带横线的 UUID 形态：opencode-mesh 冒名时用的 id 形状，dsh-mesh 自己从不产出。 */
const UUID_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 这份自述记录*是不是*一个 dsh-mesh 对端。
 *
 * 为什么需要它：`app: "dsh-mesh"` 只是对方自报的一个字符串，不构成身份证明。
 * 2026-10-21 实测到一台装在同机的 OpenCode.app 在 45918 上照抄了
 * `/mesh/v1/health` 的形状，自报 `app: "dsh-mesh"`、`proto: "opencode-mesh"`、
 * `version: "0.1.0"`、id 是带横线的 UUID、没有 capabilities —— 旧准入只查
 * `app` 和 `id`，于是它被当成正经对端收进注册表，还进了快照。
 *
 * 三条判据都取「字段存在才校验」的宽容写法：`v` / `proto` 只有 live 记录里有
 * （persist.js 的快照不存这两个字段），硬要求它们会把 restore 路径整条打死。
 * 真正兜底的是 id 形态 —— `resolveInstanceId()` 用同一个正则校验自己，
 * 所以同血统的对端不可能产出非 16 位十六进制的 id。
 */
export function looksLikeDshPeer(record) {
  if (!record || record.app !== APP_TAG || !record.id) return false;
  if (record.v !== undefined && record.v !== 2) return false;
  if (record.proto !== undefined && record.proto !== "dsh-mesh") return false;
  // 已经落盘的老快照里没有 v/proto（见 persist.js 的字段表），那条路径上只剩
  // id 形态可判：dsh-mesh 自己用 randomBytes(8).toString("hex") 生成 id，
  // 同血统的对端不可能产出带横线的 UUID。这里刻意只挡 UUID 形态，而不要求
  // "必须是 16 位十六进制" —— 后者会误伤测试夹具和用户手填的旧 id。
  if (UUID_ID_RE.test(String(record.id))) return false;
  return true;
}

/** 「上次见过」缓存的保留期与条数上限：地址用不了那么久，也不该无限长。 */
const KNOWN_TTL_MS = 30 * 24 * 3600 * 1000;
const KNOWN_MAX = 200;

/** 一个缓存条目里最新的一条证据时间。 */
function newestOf(known) {
  return Object.values(known?.endpoints ?? {}).reduce((m, e) => Math.max(m, Number(e.lastSeen) || 0), 0);
}

/**
 * 名片协议版本。
 *
 * v2 相对 v1 的变化：名片里多了 `fingerprint`（认领指纹）与 `tailnetIp`
 * （本机的互联网地址）。对端记录内部从"单份 host/transport"改成了多端点
 * `endpoints[]`（这是本地数据结构，不上网线）。
 *
 * **刻意不做版本闸门**：现场有 Mac / Windows / Android 三台，不可能同时升级，
 * 硬拒绝等于"升级一台就全网断开"。v1 名片缺这两个字段 → 读出来是空串 →
 * 退化成"没有指纹、不知道 tailnet 地址"，其余功能照常。v2 对端发给 v1 对端时，
 * 多出来的字段会被旧版忽略。所以两边都能平滑过渡。
 */
export const PROTOCOL_VERSION = 2;

/** 列出本机所有可供局域网访问的 IPv4 地址（排除回环）。 */
export function lanIPv4Addresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push({ iface: name, address: a.address, mac: a.mac ?? "" });
    }
  }
  return out;
}

/** 找到承载指定 IPv4 的接口 MAC；找不到返回空串。 */
export function macForAddress(address) {
  for (const { address: addr, mac } of lanIPv4Addresses()) {
    if (addr === address) return mac;
  }
  return "";
}

/** 挑一个最可能被对端访问到的地址（优先 en0 / eth / wlan 这类物理网卡）。 */
export function preferredAddress() {
  const all = lanIPv4Addresses();
  if (all.length === 0) return "127.0.0.1";
  const score = (name) => {
    if (/^(en0|en1|eth0|wlan0|Wi-?Fi)$/i.test(name)) return 0;
    if (/^(en|eth|wlan|wl)/i.test(name)) return 1;
    if (/^(utun|tun|tap|bridge|vmnet|docker|veth|lo)/i.test(name)) return 9;
    return 5;
  };
  return all.slice().sort((a, b) => score(a.iface) - score(b.iface))[0].address;
}

/**
 * 通道优先级：**局域网优先**。
 *
 * 局域网免费、不经 DERP 中继、不走 tsnet 的用户态网络栈（后者要额外 CPU 和
 * 内存拷贝）。同网段时 Tailscale 自己也会走直连，所以实测延迟差不多，但走
 * tsnet 仍然多一层用户态转发，没有理由优先。
 */
export const TRANSPORT_RANK = { lan: 0, tsnet: 1 };

/** 一次失败后把端点标记为 down 的冷却时长；冷却期内不再尝试它。 */
export const ENDPOINT_COOLDOWN_MS = 30000;

/** 连续失败到这个次数才判定端点 down（单次失败可能只是抖动）。 */
export const ENDPOINT_FAIL_THRESHOLD = 2;

/**
 * 端点是否"活着"：最近有正面证据，且不在失败冷却期内。
 *
 * 注意"活着"和"在线"是两件事：一个端点可以活着（刚收到心跳），也可以
 * 处于冷却（刚发失败）。设备是否在线 = **任一**端点活着。
 */
export function endpointAlive(ep, now = Date.now(), ttlMs = 20000) {
  if (!ep) return false;
  if (ep.downUntil && now < ep.downUntil) return false;
  // "知道地址"不等于"在线"：sidecar 的 tailnet 节点表会把一堆还没探过的候选
  // 端点登记进来（决定 #2：局域网通就不实探 tailnet）。把它们算成在线，设备
  // 会显示通着、实际发不出去。所以必须有正面证据（verified）才算活着。
  if (ep.verified === false) return false;
  // 存活窗口必须**不小于该通道的探测间隔**，否则慢节奏的通道每次探测之间都会
  // 被判死。实测踩过：tailnet 探测间隔 60s，而 TTL 是 20s —— 探完 20 秒后通道
  // 就"死了"，于是整台设备显示离线，尽管它明明刚刚才探通过（ok=11 fail=0）。
  //
  // probeIntervalMs 缺失时按通道给个兜底：调用方漏传过一次（scanTailnet 那条
  // 路径），结果是通道明明探得通（ok=4 fail=0 rtt=473ms）却显示离线。
  // tailnet 天生比局域网慢，兜底取一个不激进的值，避免同类疏漏再次造成假离线。
  const fallbackInterval = ep.transport === "tsnet" ? 60000 : 0;
  const window = Math.max(ttlMs, Number(ep.probeIntervalMs ?? 0) * 2.5, Number(ep.probeIntervalMs ?? 0) > 0 ? 0 : fallbackInterval * 2.5);
  return now - Number(ep.lastSeen ?? 0) <= window;
}

/**
 * 从一台设备的所有端点里挑一个用于发送。
 *
 * 规则：局域网优先 → 同优先级按最近 RTT → 冷却中的端点排除在外。
 * 首选的端点不可用时**自动落到另一条通道**，这就是"两条通道绑一台设备"的
 * 实际用处：任意一条通，设备就可达。
 *
 * @returns endpoint 或 null（全都不可用）
 */
export function chooseEndpoint(peer, { now = Date.now(), ttlMs = 20000 } = {}) {
  // 只认"活着"的端点：这个函数用于**对外显示选中了哪条通道**，把冷却中的
  // 也算进来会显示成"选中了一条已知坏掉的通道"。发送路径请用 orderedEndpoints。
  return orderedEndpoints(peer, { now, ttlMs, aliveOnly: true })[0] ?? null;
}

/**
 * 按"该先试哪个"排好序的端点列表，供发送时**逐个失败切换**。
 *
 * 排序：局域网优先 → 已验证的优先 → RTT 小的优先；冷却中的排到最后。
 *
 * @param aliveOnly true = 只返回活着的（用于显示）；false = 也含冷却中的（用于
 *        发送时尽力一试——其他端点也没有的话，试一下比直接放弃好）
 */
export function orderedEndpoints(peer, { now = Date.now(), ttlMs = 20000, aliveOnly = false } = {}) {
  let eps = Object.values(peer?.endpoints ?? {});
  if (aliveOnly) eps = eps.filter((ep) => endpointAlive(ep, now, ttlMs));
  if (eps.length === 0) return [];
  const cooling = (ep) => (ep.downUntil && now < ep.downUntil ? 1 : 0);

  return eps.slice().sort((a, b) => {
    const ca = cooling(a);
    const cb = cooling(b);
    if (ca !== cb) return ca - cb;
    // 局域网优先
    const r = (TRANSPORT_RANK[a.transport] ?? 9) - (TRANSPORT_RANK[b.transport] ?? 9);
    if (r !== 0) return r;
    // 已验证的优先（"知道地址"不如"探通过"）
    const va = a.verified === false ? 1 : 0;
    const vb = b.verified === false ? 1 : 0;
    if (va !== vb) return va - vb;
    return Number(a.rttMs ?? Infinity) - Number(b.rttMs ?? Infinity);
  });
}

/** 设备是否在线 = 任一端点活着。 */
export function peerOnline(peer, now = Date.now(), ttlMs = 20000) {
  return Object.values(peer?.endpoints ?? {}).some((ep) => endpointAlive(ep, now, ttlMs));
}

/**
 * 组播发现。事件：
 *   "change"       —— 对端列表有任何变化（新增/离线/恢复/信息更新）
 *   "diagnostic"   —— 网络层问题（非致命），参数为字符串
 */
export class MeshDiscovery extends EventEmitter {
  #id;
  #port;
  #meta;
  #intervalMs;
  #ttlMs;
  #keepMs;
  #peers = new Map();
  /**
   * 「上次见过的机器」缓存：id → {record, endpoints, restoredAt}。
   *
   * **刻意与 #peers 分开**：活跃注册表的所有规则（TTL、keepMs、清扫、在线判定）
   * 都是为"现在活着"服务的。把缓存塞进 #peers 会被 #sweep() 立刻删掉 —— 因为
   * 缓存的 lastSeen 天然是旧的（这正是它诚实的地方）。第一版实现就是这么错的：
   * 恢复出来的离线机器活不过一个清扫周期。
   */
  #known = new Map();
  #socket = null;
  #announceTimer = null;
  #sweepTimer = null;
  #started = false;
  #multicast = true;
  #address;
  #group;
  #multicastPort;

  constructor({ id, port, meta = {}, intervalMs = 5000, ttlMs = 20000, keepMs = 300000, group = MESH_GROUP, multicastPort = MESH_PORT }) {
    super();
    this.#id = id;
    this.#port = port;
    this.#meta = meta;
    this.#intervalMs = intervalMs;
    this.#ttlMs = ttlMs;
    this.#keepMs = keepMs;
    this.#address = preferredAddress();
    // 组播组与端口可注入：测试必须用私有组，否则测试实例会向真实局域网
    // 宣告自己，被同一网段的真实 DSH 登记成一台假机器（实测踩过：
    // 每跑一次 `npm run selftest` 就多一条名为 test 的重名记录）。
    this.#group = group;
    this.#multicastPort = multicastPort;
  }

  get instanceId() {
    return this.#id;
  }

  get address() {
    return this.#address;
  }

  /**
   * 回填真实的监听端口。
   * HTTP 服务通常绑 0（随机端口），要等它 listening 之后才知道端口号，
   * 所以发现模块允许在 start() 之前或之后设置。
   */
  setPort(port) {
    this.#port = Number(port) || 0;
    if (this.#started) this.#announce(); // 端口变了，立刻重新广播一次
    return this;
  }

  get port() {
    return this.#port;
  }

  /**
   * 改本机在对端列表里显示的名字。
   * 立即重新广播一次，对端不用等下一个心跳周期就能看到新名字。
   * @returns 旧名字
   */
  setMachine(name) {
    const previous = this.#meta.machine;
    this.#meta.machine = String(name);
    if (this.#started) this.#announce();
    return previous;
  }

  /**
   * 本机对外名片。
   *
   * 这里每次都重新探测一次对外地址，而不是复用启动时缓存 ——
   * 网络切换（换 WiFi / 热点 / 插网线）后 #address 会过时，导致心跳里广播旧 IP，
   * 别的机器用旧 IP 连不上。广播每 5s 一次，所以切网后最多 5s 就能自愈。
   *
   * @param options.forMulticast true = 这份是拿去**组播广播**的，此时**不带 mac**。
   *
   * 为什么要按用途分两种：组播是二层广播，同网段任何人都能被动收到，等于把
   * 硬件 ID 白送出去（咖啡馆、酒店这类不可信网络尤其不该）。健康检查的响应是
   * "对方主动问了才给"，所以那里保留 mac —— 对端探测一次就能拿到，不再是无差别
   * 泄露。本机页面上显示的 mac 是**本地现算**的（见 index.js 的 state()），
   * 压根不依赖这份名片。
   *
   * 身份已经改用指纹（fingerprint）承担，mac 在身份上没有用处了。
   */
  selfRecord({ forMulticast = false } = {}) {
    this.#address = preferredAddress();
    const rec = {
      v: PROTOCOL_VERSION,
      app: APP_TAG,
      id: this.#id,
      machine: this.#meta.machine ?? os.hostname(),
      hostname: os.hostname(),
      host: this.#address,
      port: this.#port,
      os: `${os.platform()} ${os.release()}`,
      // 结构化系统身份（平台/系统名/版本/发行版/内核/桌面/架构）。
      // 老对端没有这两个字段；UI 会回退解析 os 字符串，所以是纯增量协议。
      osInfo: osInfo(),
      // 这台机器上可用的系统列表（宿主机 + WSL 等）；宿主机排第一。
      systems: systems(),
      user: this.#meta.user ?? os.userInfo().username,
      profile: this.#meta.profile ?? "",
      version: this.#meta.version ?? "",
      // 认领指纹：只在"对端 instanceId 变了"时用来认出"这是同一台物理机"。
      // 已做 sha256 截断，不是硬件 ID 原文（见 lib/identity.js 的说明）。
      fingerprint: this.#meta.fingerprint ?? "",
      // 本机的 tailnet 地址（没接入互联网组网时为空）。
      //
      // 为什么要在名片里带上它：局域网发现的设备只能知道对方的局域网地址，
      // 想让"局域网断了自动切 tailnet"成立，就必须提前知道备选地址。让对端
      // 自己报出来，比等探到再发现划算得多——**局域网通的时候一次 tailnet
      // 探测都不用做**（决定 #2）。
      tailnetIp: this.#meta.tailnetIp ?? "",
      // 能力名片（Placement 步骤 ①）。**直接读采集缓存**，不经过 #meta ——
      // 刻意只留一个数据源。
      //
      // 为什么不用 setMeta 推进来：那样能力就有"缓存"和"meta"两份，只要有一处
      // 忘了同步，名片里就会永远空着，而且**看起来像正常的空数据**（正是这个项目
      // 反复吃亏的静默失败）。现在采集一完成，下一个心跳自动带上，没有中间环节。
      //
      // 首轮采集完成前是 null。**null 与 `{}` 必须区分**：null = 这台机器还
      // 没报能力（可能是老版本、也可能刚开始采集），`{}` = 报过了，确实什么
      // 运行时都没探到。Placement 对前者的正确反应是"去问人"，对后者是
      // "直接排除"。把它俩混起来就会把任务派到跑不了的机器上。
      capabilities: currentCapabilities(),
      ts: Date.now(),
    };
    // mac 跟着当前地址现算，避免"旧 IP 找不到对应网卡 → mac 变空"
    if (!forMulticast) rec.mac = macForAddress(this.#address);
    return rec;
  }

  /**
   * 启动发现。
   * @param options.multicast 是否启用 UDP 组播。关掉它只影响"被动发现"，
   *   过期清理（sweep）照常运行 —— 因为主动扫描 / ping 也会往注册表里写对端，
   *   它们同样需要被标记离线。这个解耦是必须的，否则关掉组播后对端永不过期。
   */
  start({ multicast = true } = {}) {
    if (this.#started) return this;
    this.#started = true;
    this.#multicast = multicast;

    // 过期清理：与组播无关，始终运行
    this.#sweepTimer = setInterval(() => this.#sweep(), Math.max(2000, Math.floor(this.#ttlMs / 4)));
    this.#sweepTimer.unref?.();

    if (!multicast) return this;

    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.#socket = socket;

    socket.on("error", (err) => {
      this.emit("diagnostic", `discovery socket error: ${err.message}`);
    });

    socket.on("message", (buf, rinfo) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString("utf8"));
      } catch {
        return; // 不是我们的报文，忽略
      }
      if (!msg || msg.app !== APP_TAG) return;
      if (msg.id === this.#id) return; // 自己发的
      // 只传 address、**不传 port**：dgram 的 rinfo.port 是 UDP 源端口
      // （组播端口 45892），不是对端 HTTP 服务的端口。之前写成
      // `rinfo.port ?? msg.port` 让 45892 盖掉了记录里真正的 45917，
      // 于是局域网探测全部打到一个没有 HTTP 服务的端口上（实测 fail=28）。
      this.#upsert(msg, { address: rinfo.address });
    });

    socket.on("listening", () => {
      try {
        socket.setMulticastTTL(1); // 只在本网段
        socket.setMulticastLoopback(true); // 同机多实例也能互相看见（便于调试）
        socket.addMembership(this.#group);
      } catch (err) {
        this.emit("diagnostic", `join multicast failed: ${err.message}`);
      }
      this.#announce();
    });

    try {
      socket.bind(this.#multicastPort);
    } catch (err) {
      this.emit("diagnostic", `bind ${this.#multicastPort} failed: ${err.message}`);
    }

    this.#announceTimer = setInterval(() => this.#announce(), this.#intervalMs);
    this.#announceTimer.unref?.();

    return this;
  }

  stop() {
    if (!this.#started) return;
    this.#started = false;
    if (this.#announceTimer) clearInterval(this.#announceTimer);
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#announceTimer = this.#sweepTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.dropMembership(this.#group);
      } catch {
        /* 已经关闭 */
      }
      try {
        socket.close();
      } catch {
        /* 已经关闭 */
      }
    }
  }

  /** 立刻广播一次（配对/刷新时用）。 */
  announceNow() {
    this.#announce();
  }

  /** 当前对端快照，按 machine 名排序。 */
  peers() {
    const now = Date.now();
    const live = [...this.#peers.values()].map((p) => this.#project(p, now));
    const liveIds = new Set(live.map((p) => p.id));
    // 缓存里、但这次启动还没重新发现的机器：作为「上次见到」补进列表。
    // 它们不受 TTL / 清扫影响 —— 这正是与活跃注册表分开的意义。
    const known = [...this.#known.entries()]
      .filter(([id]) => !liveIds.has(id))
      .map(([, k]) => this.#projectKnown(k));
    // 排序规则（真机上被指出来的问题：离线的 hos 排在了在线的 myserver 前面，
    // 因为原来只按机器名排）。用户首先关心"谁能用"：
    //   1. 在线
    //   2. 离线但这次启动见过（刚掉线，地址可信）
    //   3. 只在缓存里（上次见到，地址可能已失效）
    // 同级按最后活跃时间倒序，最后用机器名兜底保证稳定。
    const rank = (p) => (p.online ? 0 : p.restored === true ? 2 : 1);
    return [...live, ...known].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0) ||
        String(a.machine).localeCompare(String(b.machine)) ||
        String(a.id).localeCompare(String(b.id)),
    );
  }

  /**
   * 把「上次见过的机器」投影成与活机器同形的记录：
   * online 恒为 false，restored 恒为 true，地址取最近有一个端点。
   */
  #projectKnown(k) {
    const eps = Object.values(k.endpoints ?? {});
    const last = eps.slice().sort((a, b) => Number(b.lastSeen) - Number(a.lastSeen))[0] ?? null;
    return {
      ...k.record,
      endpoints: eps.map((e) => ({ ...e })),
      online: false,
      restored: true,
      restoredAt: k.restoredAt,
      lastSeen: newestOf(k) || k.record.ts || k.restoredAt,
      // **没有通道在用**：这些端点是历史地址，一条都没验过。
      // 以前这里填「最近一条端点的 transport」，界面就把它标成「在用」——
      // 与实际相反（对方已经离线），这是真机上被一眼看出来的那个错。
      transport: null,
      host: last?.host ?? "",
      port: last?.port ?? 0,
      sourceAddress: last?.host ?? "",
      knownAddresses: eps.filter((e) => e.host).map((e) => `${e.transport}:${e.host}:${e.port}`),
      // 缓存里的能力名片可能已经过期；交给 UI 按 restored 处理，别谎称新鲜
      capabilitiesStale: true,
      capabilitySummary: summarizeCapabilities(k.record.capabilities),
    };
  }

  /**
   * 把内部的多端点记录投影成对外的扁平记录。
   *
   * 对外**保留** host/port/transport 三个老字段（值 = 当前选中的端点），这样
   * 工具、UI、任务派发都不用改；同时多给一个 endpoints 数组，让需要的地方能
   * 看到这台设备有几条通道、各自什么状态。
   *
   * 这就是"两条通道绑一台设备"的落点：内部一台设备 = 一个 id + 多个端点，
   * 外部仍然看到一台设备，只是多知道它有几条路可走。
   */
  #project(p, now = Date.now()) {
    const chosen = chooseEndpoint(p, { now, ttlMs: this.#ttlMs });
    const endpoints = Object.values(p.endpoints).map((ep) => ({ ...ep }));
    return {
      ...p,
      endpoints,
      online: peerOnline(p, now, this.#ttlMs),
      // 活记录恒为 false（缓存投影那边是 true）。显式给值，别让调用方靠 undefined 猜。
      restored: false,
      // 设备级 lastSeen = 最新一条端点的证据时间。
      // 内部记录已经改成**端点级** lastSeen，这里是补一个设备级的给 UI/工具用 ——
      // 漏了它客户端会渲染出「最后心跳 Invalid Date」（new Date(undefined)）。
      lastSeen: endpoints.reduce((max, ep) => Math.max(max, Number(ep.lastSeen ?? 0)), 0) || p.ts || p.firstSeen || now,
      // 兼容字段：调用方按这三项发请求
      transport: chosen?.transport ?? null,
      host: chosen?.host ?? "",
      port: chosen?.port ?? 0,
      sourceAddress: chosen?.host ?? "",
      // 一个端点都没选中时（例如全在冷却），把已知地址摆出来供 UI 显示
      knownAddresses: endpoints.filter((ep) => ep.host).map((ep) => `${ep.transport}:${ep.host}:${ep.port}`),
      // 能力的两个派生视图（原始数据在 p.capabilities 里，随 ...p 透出）：
      //   · stale：自述时间戳超过 CAPABILITY_STALE_MS → 按"未知"处理
      //   · summary：单行摘要，UI 直接显示，不必自己拼
      // 老版本对端 capabilities 为 null → stale=false、summary=""，
      // 表示"没报"，而不是"过期"或"什么都不会"。
      capabilitiesStale: isCapabilityStale(p.capabilities, now),
      capabilitySummary: summarizeCapabilities(p.capabilities),
    };
  }

  get(id) {
    const p = this.#peers.get(id);
    if (p) return this.#project(p);
    const k = this.#known.get(id);
    return k ? this.#projectKnown(k) : undefined;
  }

  /** 这个 id 是不是只存在于「上次见过」缓存里（不算活机器）。 */
  isRestoredOnly(id) {
    return !this.#peers.has(id) && this.#known.has(id);
  }

  /**
   * 从外部来源登记一个对端（主动扫描、组播心跳、tailnet 探测都走这里）。
   *
   * @param record 对方 /mesh/v1/health 返回的自述记录
   * @param sourceAddress 实际观察到它的 IP（优先于自述，防伪造）
   * @param meta.transport "lan" | "tsnet"；meta.probe=false 表示"只知道地址还没探过"
   * @returns 是否造成可见变化
   */
  note(record, sourceAddress, meta = {}) {
    if (!looksLikeDshPeer(record) || record.id === this.#id) return false;
    return this.#upsert(record, { address: sourceAddress ?? record.host ?? "?", ...meta });
  }

  /**
   * 用磁盘快照把「上次见过的机器」放回来。
   *
   * 与 note() 的关键区别：**保留快照里的 lastSeen / lastOkAt，不刷新成 now**，
   * 端点一律标记为未验证。因此恢复出来的机器通常显示为**离线**——它表达的是
   * "我们上次知道它在这个地址"，而不是"它现在在线"。这条区别很重要：如果恢复
   * 时把 lastSeen 改成 now，页面会先把一堆离线机器显示成在线，然后逐个变灰。
   *
   * 已经被现网重新发现的（#peers 里已有同 id）直接跳过，以现网为准。
   * @param {{record: object, endpoints: object[]}[]} snapshot
   * @returns {number} 实际恢复的台数
   */
  restore(snapshot) {
    const now = Date.now();
    let changed = 0;
    const cutoff = now - KNOWN_TTL_MS;
    for (const item of snapshot ?? []) {
      const msg = item?.record;
      // 快照同样要过准入：幽灵 peer 一旦落盘，会以离线行的形态躺满 KNOWN_TTL_MS。
      if (!looksLikeDshPeer(msg) || msg.id === this.#id) continue;
      const peerId = String(msg.id);
      // 现网已经发现的，以现网为准，不写缓存
      if (this.#peers.has(peerId)) continue;

      const endpoints = {};
      for (const ep of item.endpoints ?? []) {
        if (!ep?.transport) continue;
        endpoints[ep.transport] = {
          transport: String(ep.transport),
          host: String(ep.host ?? ""),
          port: Number(ep.port) || 0,
          lastSeen: Number(ep.lastSeen) || 0,
          lastOkAt: Number(ep.lastOkAt) || 0,
          verified: ep.verified === true,
        };
      }
      if (Object.keys(endpoints).length === 0) continue;
      // 太旧的快照没有恢复价值（地址大概率早已失效）
      const newest = Object.values(endpoints).reduce((m, e) => Math.max(m, e.lastSeen), 0);
      if (newest && newest < cutoff) continue;

      this.#known.set(peerId, {
        record: {
          id: peerId,
          machine: String(msg.machine ?? "unknown"),
          hostname: String(msg.hostname ?? ""),
          mac: String(msg.mac ?? ""),
          os: String(msg.os ?? ""),
          osInfo: sanitizeOsInfo(msg.osInfo),
          systems: sanitizeSystems(msg.systems),
          user: String(msg.user ?? ""),
          profile: String(msg.profile ?? ""),
          version: String(msg.version ?? ""),
          capabilities: sanitizeCapabilities(msg.capabilities) ?? null,
          ts: Number(msg.ts) || 0,
        },
        endpoints,
        restoredAt: now,
      });
      changed += 1;
    }
    // 缓存只留最近的一批，避免年久失修地无限增长
    if (this.#known.size > KNOWN_MAX) {
      const drop = [...this.#known.entries()]
        .sort((a, b) => newestOf(a[1]) - newestOf(b[1]))
        .slice(0, this.#known.size - KNOWN_MAX);
      for (const [id] of drop) this.#known.delete(id);
    }
    if (changed > 0) this.emit("change", this.peers());
    return changed;
  }

  /**
   * 登记一个"知道地址但还没探过"的 tailnet 候选端点。
   *
   * 为什么需要它：决定 #2 是"局域网通就不实探 tailnet"，但那样会丢掉 tailnet
   * 地址。sidecar 的节点表是本地 HTTP 调用、几乎免费，用它先把地址记下来
   * （verified=false），局域网一断就能直接拿去探，不必重新发现。
   */
  noteTailnetCandidate(record, address, port) {
    if (!looksLikeDshPeer(record) || record.id === this.#id) return false;
    return this.#upsert(record, { address, transport: "tsnet", port, probe: false });
  }

  /**
   * 记录一次端点探测/发送的结果。
   * 成功刷新该端点 lastSeen 并清零失败计数；失败累计，达到阈值就进冷却。
   */
  markEndpoint(id, transport, { ok, rttMs = 0, address, port, verified = true, probeIntervalMs = 0 } = {}) {
    const p = this.#peers.get(id);
    const ep = p?.endpoints?.[transport];
    if (!ep) return false;
    const now = Date.now();
    const onlineBefore = peerOnline(p, now, this.#ttlMs);

    if (ok) {
      ep.lastSeen = now;
      ep.lastOkAt = now;
      ep.okCount += 1;
      ep.failCount = 0;
      ep.downUntil = 0;
      if (verified) ep.verified = true;
      if (rttMs > 0) ep.rttMs = rttMs;
      // 记下这条通道的探测节奏：endpointAlive 用它放宽存活窗口
      if (probeIntervalMs > 0) ep.probeIntervalMs = Number(probeIntervalMs);
    } else {
      ep.lastFailAt = now;
      ep.failCount += 1;
      if (ep.failCount >= ENDPOINT_FAIL_THRESHOLD) ep.downUntil = now + ENDPOINT_COOLDOWN_MS;
    }
    if (address) ep.host = String(address);
    if (port) ep.port = Number(port);

    const changed = ok || onlineBefore !== peerOnline(p, now, this.#ttlMs);
    if (changed) this.emit("change", this.peers());
    return changed;
  }

  /**
   * 更新对外名片里的动态字段（例如接入 tailnet 之后才知道的 tailnet 地址）。
   * 已启动的话立刻重新广播，对端不用等下一个心跳周期就知道我们的新地址。
   */
  setMeta(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (this.#meta[k] !== v) {
        this.#meta[k] = v;
        changed = true;
      }
    }
    if (changed && this.#started) this.#announce();
    return this;
  }

  /**
   * 把某对端标记为已确认可达（ping 成功），刷新对应端点的 lastSeen。
   */
  touch(id, sourceAddress, transport = "lan") {
    return this.markEndpoint(id, transport, { ok: true, address: sourceAddress });
  }

  #announce() {
    const socket = this.#socket;
    if (!socket || !this.#multicast) return;
    // 组播用"不含 mac"的那份名片：二层广播不该带硬件 ID
    const payload = Buffer.from(JSON.stringify(this.selfRecord({ forMulticast: true })), "utf8");
    socket.send(payload, 0, payload.length, this.#multicastPort, this.#group, (err) => {
      if (err) this.emit("diagnostic", `announce failed: ${err.message}`);
    });
  }

  #upsert(msg, rinfo) {
    const id = String(msg.id);
    const now = Date.now();
    const prev = this.#peers.get(id);
    // 变更判定用的前后快照：必须在改动任何字段**之前**取
    const before = prev ? this.#project(prev, now) : null;

    // 端点身份由 transport 决定；对端自述的 host 只在局域网通道可信。
    const transport = rinfo.transport ?? "lan";
    const selfHost = String(msg.host ?? "").trim();
    const address = String(rinfo.address ?? selfHost ?? "?").trim();
    // tailnet 通道**必须**用观察到的地址：对端自述的 host 是它的局域网 IP，
    // 跨互联网根本不可达。
    // Prefer the observed source address on every transport. The peer's
    // self-reported host/port is unauthenticated; trusting it on the LAN lets a
    // spoofed heartbeat redirect task dispatch (and X-Dsh-Mesh-Token) to an
    // arbitrary host. note()'s contract has always said observed wins.
    const host = address || selfHost;
    const port = Number(rinfo.port ?? msg.port) || 0;
    const verified = rinfo.probe === false ? false : true;

    const peer = prev ?? {
      id,
      machine: "",
      hostname: "",
      mac: "",
      os: "",
      // 结构化系统身份；老对端只报 os 字符串时为 null。
      osInfo: null,
      systems: null,
      user: "",
      profile: "",
      version: "",
      fingerprint: "",
      fingerprintConflict: null,
      // 对端自述的能力名片；null = 未知（老版本对端，或还没收到）
      capabilities: null,
      firstSeen: now,
      endpoints: {},
    };

    // 元数据每次刷新（对端改名、升级、换用户都要跟上）
    peer.machine = String(msg.machine ?? peer.machine ?? "unknown");
    peer.hostname = String(msg.hostname ?? peer.hostname ?? "");
    peer.mac = String(msg.mac ?? peer.mac ?? "");
    peer.os = String(msg.os ?? peer.os ?? "");
    // 系统身份是**网络输入**：清洗后再存。没报/报坏了就保持原值，让 UI 回退到
    // 老的 os 字符串，而不是伪造一个空系统。
    const incomingOs = sanitizeOsInfo(msg.osInfo);
    if (incomingOs) peer.osInfo = incomingOs;
    const incomingSystems = sanitizeSystems(msg.systems);
    if (incomingSystems) peer.systems = incomingSystems;
    peer.user = String(msg.user ?? peer.user ?? "");
    peer.profile = String(msg.profile ?? peer.profile ?? "");
    peer.version = String(msg.version ?? peer.version ?? "");
    peer.ts = Number(msg.ts) || now;

    // 现网又见到它了 → 缓存条目作废，以活记录为准（避免同一台机器出现两次）。
    this.#known.delete(id);

    // ── 能力名片（Placement 步骤 ①）──
    //
    // 净化后再存：这块数据来自网络，之后会进 UI、也会喂给 Placement 做决策，
    // 不能直接信（见 capabilities.js 的 sanitizeCapabilities）。
    //
    // 只在**更新**的时候覆盖：同一台机器可能从两条通道各送来一份名片
    // （局域网心跳 + tailnet 探测），晚到的旧包不该把新数据顶掉。缺
    // capabilitiesAt 的（老版本对端）在 sanitize 里会变成 0，因此永远不会
    // 覆盖已有的有效数据 —— 老对端可以继续只报其它字段，互不干扰。
    const incomingCaps = sanitizeCapabilities(msg.capabilities);
    if (incomingCaps) {
      const prevAt = Number(peer.capabilities?.capabilitiesAt) || 0;
      if (incomingCaps.capabilitiesAt >= prevAt) peer.capabilities = incomingCaps;
    }

    // ── 指纹冲突：同一个 instanceId 却报出不同指纹 ──
    //
    // 说明有人复制了 state.json（克隆 profile 目录）。两台设备会互相顶掉对方的
    // 记录、无限翻转，比"多出一条重名"严重得多。所以**拒绝静默合并**，把冲突
    // 记下来并报出去，让 UI 能告警。
    const fp = String(msg.fingerprint ?? "");
    if (fp && peer.fingerprint && fp !== peer.fingerprint) {
      peer.fingerprintConflict = { previous: peer.fingerprint, incoming: fp, at: now };
      this.emit(
        "diagnostic",
        `instanceId 冲突：${peer.machine || id} 自述指纹与已记录的不一致（${peer.fingerprint} → ${fp}）；可能有人复制了 state.json`,
      );
    } else if (fp) {
      peer.fingerprint = fp;
      peer.fingerprintConflict = null;
    }

    // ── 只更新这一条端点，绝不整体覆盖 ──
    //
    // 这是本次改造的核心：局域网和 tailnet 各占一条、互不影响。以前 host 和
    // transport 是单字段，两条通道争同一个槽位、来回翻转，于是出现"局域网明明
    // 通却显示离线"——因为 ping 只打最后赢的那个地址。
    const prevEp = peer.endpoints[transport];
    peer.endpoints[transport] = {
      transport,
      host: host || prevEp?.host || "",
      port: port || prevEp?.port || 0,
      lastSeen: now,
      lastOkAt: verified ? now : (prevEp?.lastOkAt ?? 0),
      lastFailAt: prevEp?.lastFailAt ?? 0,
      okCount: verified ? (prevEp?.okCount ?? 0) + 1 : (prevEp?.okCount ?? 0),
      // An inbound heartbeat proves the peer can reach us, not that we can
      // reach it. Keep the outbound failure state; only a successful probe or
      // send (markEndpoint ok) may clear it.
      failCount: prevEp?.failCount ?? 0,
      // RTT 与探测间隔由调用方按实际结果带进来（成功路径走的是 note()，
      // 不是 markEndpoint，所以要在这里一并接住，否则 RTT 永远是 0）
      rttMs: Number(rinfo.rttMs) > 0 ? Number(rinfo.rttMs) : (prevEp?.rttMs ?? 0),
      probeIntervalMs: Number(rinfo.probeIntervalMs) > 0 ? Number(rinfo.probeIntervalMs) : (prevEp?.probeIntervalMs ?? 0),
      downUntil: prevEp?.downUntil ?? 0,
      verified: prevEp?.verified === true || verified,
    };

    // ── 对端在名片里自报了 tailnet 地址 → 记成一条**未验证**的候选端点 ──
    //
    // 这样局域网一断就能直接拿它试，不必先扫一遍 tailnet —— 这就是决定 #2
    // "局域网通就不实探 tailnet"能成立的前提：备选地址是**对端自己送上门的**，
    // 不花我们一次探测。
    //
    // verified=false 很关键：候选端点**不算在线**（endpointAlive 会拒绝它），
    // 也不会抢在局域网前面被选中。它只是"万一局域网没了，可以从这儿试"。
    const peerTailnetIp = String(msg.tailnetIp ?? "").trim();
    if (transport === "lan" && peerTailnetIp && !peer.endpoints.tsnet) {
      peer.endpoints.tsnet = {
        transport: "tsnet",
        host: peerTailnetIp,
        port: Number(msg.port) || 0,
        lastSeen: now,
        lastOkAt: 0,
        lastFailAt: 0,
        okCount: 0,
        failCount: 0,
        rttMs: 0,
        downUntil: 0,
        verified: false,
      };
    }

    // ── 指纹认领：同一台物理机换了 instanceId ──
    //
    // state.json 丢了 / 插件重装 → 新 id、旧指纹。若不认领会重名，而且旧记录
    // 要等 keepMs（默认 5 分钟）才过期。这是"硬件指纹用来认领身份"的实际用处。
    // 注意：**空指纹绝不参与认领**，否则所有采不到指纹的设备会互相认领成一团。
    //
    // ⚠ 但指纹是**按物理机**算的（OS 机器 ID），所以同一台机器上的每个 DSH
    // profile 指纹都相同。无条件认领会造成实测到的后果：同一台 Mac 上跑两个
    // profile（生产 + 测试）时，**它们会互相顶掉对方的记录**，连自己都删 ——
    // 表现为"对端列表里这两台互相看不见、只剩最后广播的那一个"。
    //
    // 所以认领要加条件：只有"确实是同一台逻辑设备"才认领。
    //   · 机器名相同   → 同一台设备（重装/丢 state.json 后名字一般不变）
    //   · 或者旧记录已离线 → 典型的"重启残留"，这正是认领要解决的场景
    // 两条都不满足时不认领：那是**两个都活着的不同实例**，各自合法，不该互相顶掉。
    const claimed = [];
    if (peer.fingerprint) {
      for (const [otherId, other] of this.#peers) {
        if (otherId === id) continue;
        if (!other.fingerprint || other.fingerprint !== peer.fingerprint) continue;
        const nameMatches = !!other.machine && other.machine === peer.machine;
        const otherOffline = !peerOnline(other, now, this.#ttlMs);
        if (!nameMatches && !otherOffline) {
          this.emit(
            "diagnostic",
            `指纹相同但两台都在线（${peer.machine || id} 与 ${other.machine || otherId}）——` +
              `同一台物理机上的两个实例，各自保留、不认领`,
          );
          continue;
        }
        claimed.push(otherId);
        this.emit(
          "diagnostic",
          `认领：${peer.machine || id} 的指纹与旧记录 ${otherId}（${other.machine || "?"}）相同，判定为同一台机器换了 instanceId`,
        );
      }
    }
    for (const otherId of claimed) this.#peers.delete(otherId);

    // ── 按地址去重 ──
    //
    // 一个 IP:port 只可能有一个活着的实例。对端重启换 id 时旧记录若不立刻清掉，
    // 会在 keepMs 内和新记录重名、让派发因分不清目标而失败。
    // 这一条对**跑着旧版插件（没有指纹）的对端**仍然必要 —— 我们控制不了对端。
    const superseded = [];
    for (const [otherId, other] of this.#peers) {
      if (otherId === id) continue;
      const clash = Object.values(other.endpoints).some((ep) => ep.host === host && Number(ep.port) === Number(port));
      if (clash) superseded.push(otherId);
    }
    for (const otherId of superseded) this.#peers.delete(otherId);

    this.#peers.set(id, peer);
    const after = this.#project(peer, now);
    const changed =
      claimed.length + superseded.length > 0 ||
      !before ||
      before.online !== after.online ||
      before.machine !== after.machine ||
      before.host !== after.host ||
      before.port !== after.port ||
      before.transport !== after.transport ||
      before.endpoints.length !== after.endpoints.length;
    if (changed) this.emit("change", this.peers());
    return changed;
  }

  #sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.#peers) {
      const onlineBefore = peerOnline(p, now, this.#ttlMs);

      // 端点级过期：某条通道超过 keepMs 没有任何证据，就把它从这台设备上摘掉。
      // 注意是"摘端点"而不是"删设备" —— 局域网断了但 tailnet 还通时设备必须
      // 保持在线。以前是整体判一个 lastSeen，两条通道会互相掩盖。
      let removedEndpoint = false;
      for (const [t, ep] of Object.entries(p.endpoints)) {
        if (now - Number(ep.lastSeen ?? 0) > this.#keepMs) {
          delete p.endpoints[t];
          removedEndpoint = true;
        }
      }

      // 只有**所有**通道都过期了，才把这台设备删掉
      if (Object.keys(p.endpoints).length === 0) {
        this.#peers.delete(id);
        changed = true;
        continue;
      }
      if (removedEndpoint || onlineBefore !== peerOnline(p, now, this.#ttlMs)) changed = true;
    }
    if (changed) this.emit("change", this.peers());
  }
}
