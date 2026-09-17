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
export const PROTOCOL_VERSION = 1;

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

  constructor({ id, port, meta = {}, intervalMs = 5000, ttlMs = 20000, keepMs = 300000 }) {
    super();
    this.#id = id;
    this.#port = port;
    this.#meta = meta;
    this.#intervalMs = intervalMs;
    this.#ttlMs = ttlMs;
    this.#keepMs = keepMs;
    this.#address = preferredAddress();
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
        socket.addMembership(MESH_GROUP);
      } catch (err) {
        this.emit("diagnostic", `join multicast failed: ${err.message}`);
      }
      this.#announce();
    });

    try {
      socket.bind(MESH_PORT);
    } catch (err) {
      this.emit("diagnostic", `bind ${MESH_PORT} failed: ${err.message}`);
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
        socket.dropMembership(MESH_GROUP);
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
    return [...this.#peers.values()]
      .map((p) => ({ ...p, online: p.online }))
      .sort((a, b) => String(a.machine).localeCompare(String(b.machine)) || String(a.id).localeCompare(String(b.id)));
  }

  get(id) {
    return this.#peers.get(id);
  }

  /**
   * 从外部来源登记一个对端（主动扫描命中、或 ping 到已知对端）。
   * 复用与组播心跳完全一样的记录结构，所以两条发现路径天然一致。
   * @param record 对方 /mesh/v1/health 返回的自述记录
   * @param sourceAddress 实际观察到它的 IP（优先于自述，防伪造）
   * @returns 是否造成可见变化
   */
  note(record, sourceAddress) {
    if (!record || record.app !== APP_TAG || !record.id || record.id === this.#id) return false;
    return this.#upsert(record, { address: sourceAddress ?? record.host ?? "?" });
  }

  /** 把某对端标记为已确认可达（ping 成功），刷新 lastSeen。 */
  touch(id, sourceAddress) {
    const p = this.#peers.get(id);
    if (!p) return;
    const wasOffline = !p.online;
    p.lastSeen = Date.now();
    p.online = true;
    if (sourceAddress) p.sourceAddress = sourceAddress;
    if (wasOffline) this.emit("change", this.peers());
  }

  #announce() {
    const socket = this.#socket;
    if (!socket || !this.#multicast) return;
    const payload = Buffer.from(JSON.stringify(this.selfRecord()), "utf8");
    socket.send(payload, 0, payload.length, MESH_PORT, MESH_GROUP, (err) => {
      if (err) this.emit("diagnostic", `announce failed: ${err.message}`);
    });
  }

  #upsert(msg, rinfo) {
    const id = String(msg.id);
    const now = Date.now();
    const prev = this.#peers.get(id);
    const next = {
      id,
      machine: String(msg.machine ?? "unknown"),
      hostname: String(msg.hostname ?? ""),
      mac: String(msg.mac ?? ""),
      host: String(msg.host || rinfo.address), // 心跳里的地址不可信时用来源 IP
      sourceAddress: rinfo.address,
      port: Number(msg.port) || 0,
      os: String(msg.os ?? ""),
      user: String(msg.user ?? ""),
      profile: String(msg.profile ?? ""),
      version: String(msg.version ?? ""),
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      online: true,
    };
    const changed =
      !prev ||
      !prev.online ||
      prev.machine !== next.machine ||
      prev.host !== next.host ||
      prev.port !== next.port ||
      prev.profile !== next.profile;
    this.#peers.set(id, next);
    if (changed) this.emit("change", this.peers());
    return changed;
  }

  #sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.#peers) {
      if (now - p.lastSeen > this.#keepMs) {
        this.#peers.delete(id);
        changed = true;
      } else if (p.online && now - p.lastSeen > this.#ttlMs) {
        p.online = false;
        changed = true;
      }
    }
    if (changed) this.emit("change", this.peers());
  }
}
