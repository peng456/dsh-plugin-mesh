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

export const MESH_GROUP = "239.255.42.99";
export const MESH_PORT = 45892;
export const APP_TAG = "dsh-mesh";

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
  return now - Number(ep.lastSeen ?? 0) <= ttlMs;
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
   * mac 也跟着用新地址现算，避免"旧 IP 找不到对应网卡 → mac 变空"。
   */
  selfRecord() {
    this.#address = preferredAddress();
    return {
      v: PROTOCOL_VERSION,
      app: APP_TAG,
      id: this.#id,
      machine: this.#meta.machine ?? os.hostname(),
      hostname: os.hostname(),
      mac: macForAddress(this.#address),
      host: this.#address,
      port: this.#port,
      os: `${os.platform()} ${os.release()}`,
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
      ts: Date.now(),
    };
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
      this.#upsert(msg, rinfo);
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
    return [...this.#peers.values()]
      .map((p) => this.#project(p, now))
      .sort((a, b) => String(a.machine).localeCompare(String(b.machine)) || String(a.id).localeCompare(String(b.id)));
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
      // 兼容字段：调用方按这三项发请求
      transport: chosen?.transport ?? null,
      host: chosen?.host ?? "",
      port: chosen?.port ?? 0,
      sourceAddress: chosen?.host ?? "",
      // 一个端点都没选中时（例如全在冷却），把已知地址摆出来供 UI 显示
      knownAddresses: endpoints.filter((ep) => ep.host).map((ep) => `${ep.transport}:${ep.host}:${ep.port}`),
    };
  }

  get(id) {
    const p = this.#peers.get(id);
    return p ? this.#project(p) : undefined;
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
    if (!record || record.app !== APP_TAG || !record.id || record.id === this.#id) return false;
    return this.#upsert(record, { address: sourceAddress ?? record.host ?? "?", ...meta });
  }

  /**
   * 登记一个"知道地址但还没探过"的 tailnet 候选端点。
   *
   * 为什么需要它：决定 #2 是"局域网通就不实探 tailnet"，但那样会丢掉 tailnet
   * 地址。sidecar 的节点表是本地 HTTP 调用、几乎免费，用它先把地址记下来
   * （verified=false），局域网一断就能直接拿去探，不必重新发现。
   */
  noteTailnetCandidate(record, address, port) {
    if (!record || record.app !== APP_TAG || !record.id || record.id === this.#id) return false;
    return this.#upsert(record, { address, transport: "tsnet", port, probe: false });
  }

  /**
   * 记录一次端点探测/发送的结果。
   * 成功刷新该端点 lastSeen 并清零失败计数；失败累计，达到阈值就进冷却。
   */
  markEndpoint(id, transport, { ok, rttMs = 0, address, port, verified = true } = {}) {
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
    const payload = Buffer.from(JSON.stringify(this.selfRecord()), "utf8");
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
    const host = transport === "tsnet" ? address : selfHost || address;
    const port = Number(rinfo.port ?? msg.port) || 0;
    const verified = rinfo.probe === false ? false : true;

    const peer = prev ?? {
      id,
      machine: "",
      hostname: "",
      mac: "",
      os: "",
      user: "",
      profile: "",
      version: "",
      fingerprint: "",
      fingerprintConflict: null,
      firstSeen: now,
      endpoints: {},
    };

    // 元数据每次刷新（对端改名、升级、换用户都要跟上）
    peer.machine = String(msg.machine ?? peer.machine ?? "unknown");
    peer.hostname = String(msg.hostname ?? peer.hostname ?? "");
    peer.mac = String(msg.mac ?? peer.mac ?? "");
    peer.os = String(msg.os ?? peer.os ?? "");
    peer.user = String(msg.user ?? peer.user ?? "");
    peer.profile = String(msg.profile ?? peer.profile ?? "");
    peer.version = String(msg.version ?? peer.version ?? "");
    peer.ts = Number(msg.ts) || now;

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
      failCount: 0,
      rttMs: prevEp?.rttMs ?? 0,
      downUntil: 0,
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
    const claimed = [];
    if (peer.fingerprint) {
      for (const [otherId, other] of this.#peers) {
        if (otherId === id) continue;
        if (other.fingerprint && other.fingerprint === peer.fingerprint) {
          claimed.push(otherId);
          this.emit("diagnostic", `认领：${peer.machine || id} 的指纹与旧记录 ${otherId} 相同，判定为同一台机器换了 instanceId`);
        }
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
