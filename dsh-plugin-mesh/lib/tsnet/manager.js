/**
 * tsnet sidecar 的进程管理（机器级，每个 tailnet 通道一个节点）。
 *
 * 为什么是「机器级」而不是「profile 级」：
 * 每个 sidecar 就是 tailnet 里的一个设备，会占用一个设备名额。同一台机器上
 * 跑 desktop / meshtest 两个 profile 不应该变成两台设备，所以整机每个通道只跑
 * 一个 sidecar，由第一个用到的实例拉起，后来的实例通过 rendezvous 文件复用。
 *
 * 为什么是「多个通道」：
 * 一台机器可能同时属于多个 tailnet（个人账号 / 公司 tailnet / 自建 Headscale）。
 * 一个 tsnet 节点只能加入一个 tailnet，所以每条通道各有自己的 sidecar、状态目录
 * 和 rendezvous。通道 id 是稳定标识：`default` 沿用旧目录，升级不丢设备身份；
 * 其它通道各占 `tsnet/<id>/`。**设备身份仍然只有一个** —— 多条通道只是同一个
 * mesh 节点的多条可达路径。
 *
 * 生命周期：
 *   · sidecar 监听 stdin EOF 自杀 —— 即使 DSH 被 kill -9，也不会留下野进程
 *   · 复用者（非 owner）在退出时不会杀掉 sidecar，只注销自己的 forward
 *   · 进程意外退出时按退避重启，超过上限就放弃并让上层显示错误
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { SIDECAR_PROTOCOL, binaryPath, ensureBinary, cacheIsCurrent, binaryInfo, clearBinary } from "./download.js";

/** 重启退避（毫秒）；用完就停手，避免疯狂重启把日志刷爆。 */
const RESTART_BACKOFF_MS = [2000, 8000, 20000];
/** 等 sidecar 报告 listening 的上限。首次启动要初始化用户态网络栈，给宽一点。 */
const HANDSHAKE_TIMEOUT_MS = 25000;
/** 状态轮询间隔。 */
const POLL_INTERVAL_MS = 5000;

function meshDir() {
  const base = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(base, "mesh");
}

/** 机器级共享目录：sidecar 状态、rendezvous、二进制缓存都挂在这下面。 */
export function tsnetRootDir() {
  return join(meshDir(), "tsnet");
}

/**
 * 通道 id 的合法化：只保留 [a-z0-9_-]。
 *
 * 通道 id 会进文件路径，所以这里必须挡掉 `/`、`..` 之类；空值兜底成
 * `default`，正好与旧版本的单节点目录对应。
 */
export function channelKey(raw, fallback = "default") {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || fallback;
}

/**
 * 通道的私有目录。
 *
 * `default` 沿用旧布局（`mesh/tsnet/` 根目录），这样升级前注册过的那台设备
 * 身份不丢；其它通道各自一个子目录 —— 每个 sidecar 是一个独立 tailnet 节点，
 * 状态目录绝不能共享，否则第二个节点会顶掉第一个的身份。
 */
export function channelDir(key) {
  const k = channelKey(key);
  return k === "default" ? tsnetRootDir() : join(tsnetRootDir(), k);
}

function rendezvousPath(key) {
  return join(channelDir(key), "rendezvous.json");
}

/** tsnet 的节点身份目录 —— 必须持久，否则每次重启都会注册成新设备。 */
export function channelStateDir(key) {
  return join(channelDir(key), "state");
}

/** 授权码指纹：只用来判断"rendezvous 里的节点是不是用同一把 key 拉起的"。 */
function authKeyTag(authKey) {
  const s = String(authKey ?? "").trim();
  return s ? createHash("sha256").update(s).digest("hex").slice(0, 12) : "";
}

function readRendezvous(key) {
  try {
    const raw = JSON.parse(readFileSync(rendezvousPath(key), "utf8"));
    if (raw && typeof raw.port === "number" && typeof raw.pid === "number") return raw;
  } catch {
    /* 没有或坏了，当作没有 */
  }
  return null;
}

function writeRendezvous(key, info) {
  const dir = channelDir(key);
  mkdirSync(dir, { recursive: true });
  const target = rendezvousPath(key);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}

function clearRendezvous(key) {
  try {
    unlinkSync(rendezvousPath(key));
  } catch {
    /* 本来就没有 */
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * 把机器名变成合法的 DNS label；tsnet 用它派生 MagicDNS 名字。
 *
 * 中文机器名里非 ASCII 部分会被清洗掉：`立朋-mac` 只剩 `mac`。所以：
 *   · 统一加 `dsh-` 前缀 —— 清洗后往往只剩一两个泛化字母，不加前缀很难辨认
 *   · 清洗后什么都不剩（纯中文名，如 `我的电脑`）时用短哈希兜底，
 *     否则所有这类机器都会叫同一个名字，在 tailnet 里互相顶掉
 */
export function toHostname(raw) {
  const original = String(raw ?? "").trim();
  let s = original
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s) s = `node-${createHash("sha256").update(original || "dsh").digest("hex").slice(0, 8)}`;
  let name = `dsh-${s}`;
  if (name.length > 63) name = name.slice(0, 63).replace(/-+$/, "");
  return name;
}

/**
 * 连接参数指纹：授权码 / 控制服务器 / 节点名。
 *
 * 上层用它判断"配置变了没有"：没变就复用活着的节点，变了才重建 sidecar。
 * 只输出哈希，不泄露授权码明文。
 */
export function channelSignature(channel = {}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        String(channel.authKey ?? "").trim(),
        String(channel.controlUrl ?? "").trim(),
        String(channel.hostname ?? "").trim(),
      ]),
    )
    .digest("hex")
    .slice(0, 12);
}

/**
 * 一个 tsnet 节点的句柄。可以自己拉起 sidecar，也可以复用它人已拉起的。
 */
export class TsnetNode extends EventEmitter {
  #channel;
  #key;
  #label;
  #signature;
  #log;
  #warn;
  #child = null;
  #ownsProcess = false;
  #token = "";
  #port = 0;
  #rendezvous = null;
  #events = [];
  #status = { phase: "idle", backendState: "", authUrl: "", selfIpv4: "", selfDnsName: "", error: "", hostname: "", pid: 0 };
  #pollTimer = null;
  #restarts = 0;
  #stopping = false;
  #forwards = new Set();
  #hostname;

  /**
   * @param channel 通道描述：{ id, label, authKey, controlUrl, hostname, downloadSources }
   *   也兼容旧调用方式（直接传 config，单通道 = default）。
   */
  constructor({ config = {}, channel = null, log = () => {}, warn = () => {}, machineName = "" }) {
    super();
    this.#log = log;
    this.#warn = warn;
    const ch = channel ?? {
      id: "default",
      label: "Tailscale",
      authKey: config.tsnetAuthKey ?? "",
      controlUrl: config.tsnetControlUrl ?? "",
      hostname: config.tsnetHostname ?? "",
    };
    this.#key = channelKey(ch.id);
    this.#label = String(ch.label ?? "").trim() || this.#key;
    this.#channel = {
      id: this.#key,
      label: this.#label,
      authKey: String(ch.authKey ?? "").trim(),
      controlUrl: String(ch.controlUrl ?? "").trim(),
      hostname: String(ch.hostname ?? "").trim(),
      downloadSources: Array.isArray(ch.downloadSources) ? ch.downloadSources : (config.tsnetDownloadSources ?? []),
    };
    // 机器级节点名：整机一个，不带 profile 后缀。多通道同一台机器在不同 tailnet
    // 里可以同名（互不相干）；同一 tailnet 里挂两条通道才会撞名，由用户显式命名。
    this.#hostname = toHostname(this.#channel.hostname || machineName || "dsh-node");
    this.#status.hostname = this.#hostname;
    // 连接参数的指纹：上层用它判断"配置变了没有"，没变就复用活着的节点，
    // 不要在用户重试时把等待授权的 sidecar 反复踢掉重来。
    this.#signature = channelSignature(this.#channel);
  }

  get hostname() {
    return this.#hostname;
  }

  /** 通道 id（稳定，进文件路径与端点 key）。 */
  get channelKey() {
    return this.#key;
  }

  /** 通道显示名。 */
  get label() {
    return this.#label;
  }

  /** 连接参数指纹（授权码/控制服务器/节点名）。不含明文授权码。 */
  get signature() {
    return this.#signature;
  }

  /** 本机在这条 tailnet 上的地址（未连接时为空）。 */
  get selfIpv4() {
    return this.#status.selfIpv4;
  }

  get phase() {
    return this.#status.phase;
  }

  get ownsProcess() {
    return this.#ownsProcess;
  }

  /**
   * 给 UI/状态接口用的快照。
   *
   * **绝不抛异常**：它被 /mesh/api/state 每次轮询都会调用，一抛就把整个
   * Mesh 页面打成 500（表现为「本机 undefined」+ 卡片消失）。
   */
  status() {
    let binary;
    try {
      binary = binaryInfo();
    } catch (err) {
      binary = { installed: false, path: "", size: 0, error: String(err?.message ?? err) };
    }
    return {
      ...this.#status,
      channelKey: this.#key,
      label: this.#label,
      controlUrl: this.#channel.controlUrl,
      protocol: SIDECAR_PROTOCOL,
      ownsProcess: this.#ownsProcess,
      port: this.#port,
      binary,
    };
  }

  /** 最近若干条 sidecar 事件，给 UI 做诊断用。 */
  recentEvents() {
    return this.#events.slice(-30);
  }

  #setStatus(patch) {
    const next = { ...this.#status, ...patch };
    const changed = Object.keys(patch).some((k) => this.#status[k] !== next[k]);
    this.#status = next;
    if (changed) this.emit("status", this.status());
  }

  #record(event) {
    this.#events.push({ at: Date.now(), ...event });
    if (this.#events.length > 200) this.#events.splice(0, this.#events.length - 200);
  }

  // ───────────────────────── 控制 API 调用 ─────────────────────────

  #call(pathname, { method = "GET", body, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.#port) return reject(new Error("sidecar 尚未就绪"));
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: this.#port,
          path: pathname,
          method,
          timeout: timeoutMs,
          headers: {
            "X-Mesh-Token": this.#token,
            ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new Error(`sidecar 返回了非 JSON：${text.slice(0, 200)}`));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("sidecar 响应超时")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async statusRemote() {
    return this.#call("/__tsnet/status", { timeoutMs: 8000 });
  }

  async peersRemote() {
    const res = await this.#call("/__tsnet/peers", { timeoutMs: 15000 });
    if (!res?.ok) throw new Error(res?.error ?? "sidecar 未能返回节点列表");
    return Array.isArray(res.peers) ? res.peers : [];
  }

  /**
   * 借 sidecar 的隧道发一个 HTTP 请求。
   * 宿主机路由不到 100.x.y.z，所有出站都必须走这里。
   */
  async fetchOverTailnet({ url, method = "GET", headers = {}, body, timeoutMs = 20000 }) {
    const res = await this.#call("/__tsnet/fetch", {
      method: "POST",
      timeoutMs: timeoutMs + 5000,
      body: {
        url,
        method,
        headers,
        bodyBase64: body ? Buffer.from(body).toString("base64") : "",
        timeoutMs,
      },
    });
    if (res?.error) throw new Error(res.error);
    return {
      status: res.status,
      headers: res.headers ?? {},
      body: res.bodyBase64 ? Buffer.from(res.bodyBase64, "base64") : Buffer.alloc(0),
    };
  }

  /** 让本机的 mesh HTTP 服务在 tailnet 上可达（tailnet :port → 127.0.0.1:port）。 */
  async registerForward(port) {
    if (this.#forwards.has(port)) return;
    const res = await this.#call("/__tsnet/forward", { method: "POST", body: { port }, timeoutMs: 15000 });
    if (!res?.ok) throw new Error(res?.error ?? `注册 forward :${port} 失败`);
    this.#forwards.add(port);
    this.#log(`tailnet 入站已开启：:${port} → 127.0.0.1:${port}`);
  }

  // ───────────────────────── 启动 ─────────────────────────

  /**
   * 启动或复用一个 sidecar。
   * @returns {Promise<{reused: boolean}>}
   */
  async start() {
    try {
      return await this.#startInner();
    } catch (err) {
      // 兜底：任何「启动早期失败」（平台不支持、二进制缺失、下载源全挂…）都必须把
      // phase 落到 error。否则 phase 会永远停在上面那句 "starting"，UI 显示
      // 「正在组网中」永不结束 —— 一个永不停止的转圈比一条明确的失败更难排查。
      // 实测：Android 上 detectTarget() 抛「不支持的系统：android」，异常一路 reject
      // 到调用方只留一条 warning，页面则永远转圈。
      this.#setStatus({ phase: "error", error: String(err?.message ?? err) });
      throw err;
    }
  }

  async #startInner() {
    this.#setStatus({ phase: "starting", error: "" });

    // 先看有没有已在跑的 sidecar 可以复用 —— 整机一个设备，不重复注册。
    const reused = await this.#tryAdopt();
    if (reused) {
      this.#setStatus({ phase: "running" });
      this.#startPolling();
      await this.#refreshStatus();
      return { reused: true };
    }

    await this.#spawnOwn();
    this.#startPolling();
    await this.#refreshStatus();
    return { reused: false };
  }

  /** 尝试接管 rendezvous 里记录的 sidecar；成功返回 true。 */
  async #tryAdopt() {
    const rv = readRendezvous(this.#key);
    if (!rv) return false;
    if (!pidAlive(rv.pid)) {
      this.#log(`[${this.#label}] rendezvous 里的 sidecar（pid ${rv.pid}）已不在，清理后重新拉起`);
      clearRendezvous(this.#key);
      return false;
    }
    if (rv.protocol !== SIDECAR_PROTOCOL) {
      this.#log(`[${this.#label}] 运行中的 sidecar 协议 v${rv.protocol} 与本插件 v${SIDECAR_PROTOCOL} 不一致，重启它`);
      await this.#killStale(rv);
      return false;
    }
    if (rv.hostname && rv.hostname !== this.#hostname) {
      // 机器名改了：旧节点的 MagicDNS 名字已经不对，重启以应用新名字。
      this.#log(`[${this.#label}] sidecar 节点名 ${rv.hostname} 与当前机器名 ${this.#hostname} 不一致，重启它`);
      await this.#killStale(rv);
      return false;
    }
    // 授权码换了：旧 sidecar 还在旧 tailnet / 旧账号里，必须重建。
    // 兼容没有 authKeyTag 的老 rendezvous：不确定就不动它（宁可沿用，不要无故踢掉）。
    const tag = authKeyTag(this.#channel.authKey);
    if (rv.authKeyTag && tag && rv.authKeyTag !== tag) {
      this.#log(`[${this.#label}] 授权码已变更，重启 sidecar 以加入新的 tailnet`);
      await this.#killStale(rv);
      return false;
    }

    const prevPort = this.#port;
    const prevToken = this.#token;
    this.#port = rv.port;
    this.#token = rv.token;
    try {
      const st = await this.statusRemote();
      if (!st?.ok) throw new Error("status 未返回 ok");
      this.#rendezvous = rv;
      this.#ownsProcess = false;
      this.#setStatus({ pid: rv.pid });
      this.#log(`[${this.#label}] 复用已在运行的 sidecar（pid ${rv.pid}，端口 ${rv.port}）`);
      return true;
    } catch (err) {
      this.#port = prevPort;
      this.#token = prevToken;
      this.#log(`[${this.#label}] rendezvous 里的 sidecar 无响应（${err.message}），清理后重新拉起`);
      clearRendezvous(this.#key);
      return false;
    }
  }

  /** 杀掉一个确认属于本插件、但需要重建的旧 sidecar。 */
  async #killStale(rv) {
    try {
      process.kill(rv.pid, "SIGTERM");
    } catch {
      /* 已经没了 */
    }
    clearRendezvous(this.#key);
    // 等它释放 tailnet 监听，否则紧接着的 bind 会撞端口。
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && pidAlive(rv.pid)) await sleep(150);
    if (pidAlive(rv.pid)) {
      try {
        process.kill(rv.pid, "SIGKILL");
      } catch {
        /* 忽略 */
      }
      await sleep(200);
    }
  }

  async #spawnOwn() {
    try {
      return await this.#spawnOwnInner();
    } catch (err) {
      // 与 start() 同一个理由，但这条路径必须单独兜：自动重启（#onExit 的退避重试）
      // 直接调 #spawnOwn()，不经过 start()。早期抛错（binaryInfo/looksExecutable/
      // binaryPath 都在任何 try 之外）同样不能把 phase 留在 downloading/starting。
      this.#setStatus({ phase: "error", error: String(err?.message ?? err) });
      throw err;
    }
  }

  async #spawnOwnInner() {
    // 这里**必须无条件**走一遍 ensureBinary：只有它知道 PINNED_CHECKSUMS 变没变
    // （它比对解压时旁挂的 source-sha256 标记）。原来外面套了一层
    // `!installed || !looksExecutable()` 的前置判断，于是 sidecar 重新发布、
    // 校验值变了的时候这一步永远走不到，老装置会一直复用旧二进制 —— 真机实测
    // 踩过：新的 android 资产都发布了，却只有手动删缓存才会去下载。
    // 命中缓存时它只做一次 stat + 读一个几十字节的标记文件，不联网。
    if (!cacheIsCurrent()) this.#setStatus({ phase: "downloading", error: "" });
    const res = await ensureBinary({
      extraSources: this.#channel.downloadSources ?? [],
      log: (m) => {
        this.#log(m);
        this.#setStatus({ lastLog: m });
      },
      onProgress: (p) => this.#setStatus({ downloadPercent: p.percent, downloadReceived: p.received, downloadTotal: p.total }),
    });
    this.#setStatus({ downloadPercent: 100, binaryPath: res.path });

    const dir = channelStateDir(this.#key);
    mkdirSync(dir, { recursive: true });
    const token = randomBytes(24).toString("hex");
    const args = ["-hostname", this.#hostname, "-dir", dir, "-token", token];
    if (this.#channel.controlUrl) args.push("-control-url", this.#channel.controlUrl);

    const authKey = this.#channel.authKey;
    const env = { ...process.env };
    if (authKey) env.DSH_TSNET_AUTHKEY = authKey; // 走环境变量：macOS 上 ps 能看到命令行，看不到环境
    else delete env.DSH_TSNET_AUTHKEY;

    this.#log(
      `[${this.#label}] 拉起 sidecar：${binaryPath()} -hostname ${this.#hostname}` +
        `${authKey ? " (已带授权码)" : " (无授权码，需交互登录)"}`,
    );
    const child = spawn(binaryPath(), args, { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true });
    this.#child = child;
    this.#ownsProcess = true;
    this.#token = token;

    const listening = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sidecar 在 ${HANDSHAKE_TIMEOUT_MS / 1000}s 内没有就绪`)), HANDSHAKE_TIMEOUT_MS);
      const onListening = (ev) => {
        clearTimeout(timer);
        this.off("listening", onListening);
        resolve(ev);
      };
      this.on("listening", onListening);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`sidecar 启动即退出（code=${code} signal=${signal}）`));
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.#attachReader(child);

    let ev;
    try {
      ev = await listening;
    } catch (err) {
      this.#setStatus({ phase: "error", error: err.message });
      throw err;
    }

    this.#port = ev.port;
    // 让上层能直接看到 sidecar 的 pid（诊断和"是否留了孤儿"的判断都要用）
    this.#setStatus({ pid: ev.pid ?? child.pid ?? 0 });
    this.#rendezvous = {
      pid: child.pid,
      port: ev.port,
      token,
      hostname: this.#hostname,
      channelKey: this.#key,
      authKeyTag: authKeyTag(authKey),
      protocol: SIDECAR_PROTOCOL,
      startedAt: Date.now(),
    };
    writeRendezvous(this.#key, this.#rendezvous);
    this.#log(`[${this.#label}] sidecar 已就绪（pid ${child.pid}，控制端口 ${ev.port}）`);

    child.on("exit", (code, signal) => this.#onExit(code, signal));
  }

  /** 逐行解析 sidecar 的 stdout 事件流。 */
  #attachReader(child) {
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          this.#log(`[sidecar] ${line}`);
          continue;
        }
        this.#handleEvent(ev);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        const t = line.trim();
        // tsnet 在 stderr 上输出自己的日志，过滤掉常规噪声。
        if (t && !/^(tsnet:|StartLoginInteractive|To start this tsnet)/.test(t)) this.#log(`[sidecar] ${t}`);
      }
    });
  }

  #handleEvent(ev) {
    this.#record(ev);
    switch (ev.event) {
      case "listening":
        this.emit("listening", ev);
        break;
      case "auth-required":
        this.#setStatus({ phase: "needs-login", authUrl: ev.url, error: "" });
        this.#log(`需要登录 Tailscale：${ev.url}`);
        break;
      case "ready":
        this.#restarts = 0;
        this.#setStatus({
          phase: "running",
          backendState: "Running",
          authUrl: "",
          selfIpv4: ev.selfIpv4 ?? "",
          selfDnsName: ev.selfDnsName ?? "",
          error: "",
        });
        this.#log(`tailnet 已连接：${ev.selfIpv4 || "?"}（${ev.selfDnsName || this.#hostname}）`);
        this.emit("ready", ev);
        break;
      case "error":
        this.#setStatus({ phase: "error", error: `${ev.where}: ${ev.message}` });
        this.#warn(`[sidecar] ${ev.where}: ${ev.message}`);
        break;
      case "log":
        this.#log(`[sidecar] ${ev.message}`);
        break;
      default:
        break;
    }
  }

  #onExit(code, signal) {
    if (this.#stopping) return;
    this.#setStatus({ phase: "exited", backendState: "", error: `sidecar 退出（code=${code} signal=${signal}）` });
    this.#warn(`[${this.#label}] sidecar 意外退出（code=${code} signal=${signal}）`);
    clearRendezvous(this.#key);
    this.#port = 0;
    this.#child = null;

    if (this.#restarts < RESTART_BACKOFF_MS.length) {
      const delay = RESTART_BACKOFF_MS[this.#restarts];
      this.#restarts += 1;
      this.#log(`${delay / 1000}s 后重启 sidecar（第 ${this.#restarts} 次）`);
      setTimeout(() => {
        if (this.#stopping) return;
        this.#spawnOwn()
          .then(() => this.#refreshStatus())
          .catch((err) => this.#warn(`重启 sidecar 失败：${err.message}`));
      }, delay);
    } else {
      this.#setStatus({ phase: "error", error: "sidecar 反复退出，已停止自动重启；请查看诊断信息" });
    }
  }

  // ───────────────────────── 状态轮询 ─────────────────────────

  #startPolling() {
    this.#stopPolling();
    this.#pollTimer = setInterval(() => {
      this.#refreshStatus().catch(() => {});
    }, POLL_INTERVAL_MS);
    if (this.#pollTimer.unref) this.#pollTimer.unref();
  }

  #stopPolling() {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  async #refreshStatus() {
    if (!this.#port) return;
    try {
      const st = await this.statusRemote();
      const phase =
        st.backendState === "Running" ? "running" : st.authUrl ? "needs-login" : st.backendState === "NeedsLogin" ? "needs-login" : this.#status.phase;
      this.#setStatus({
        pid: st.pid || this.#status.pid,
        backendState: st.backendState ?? "",
        authUrl: st.authUrl || this.#status.authUrl,
        selfIpv4: st.selfIpv4 || "",
        selfDnsName: st.selfDnsName || "",
        machineKey: st.machineKey || "",
        forwards: st.forwards ?? [],
        diagnostics: st.diagnostics ?? [],
        phase: phase === "idle" ? this.#status.phase : phase,
      });
    } catch (err) {
      if (!this.#ownsProcess && !pidAlive(this.#rendezvous?.pid ?? 0)) {
        // 复用的 sidecar 消失了：下次扫描时上层会重新 start()。
        this.#setStatus({ phase: "exited", error: `共享 sidecar 已消失：${err.message}` });
        clearRendezvous(this.#key);
        this.#port = 0;
      }
    }
  }

  /** 重新下载二进制（UI 的「重新下载」按钮）。会先停掉当前 sidecar。 */
  async reinstallBinary() {
    await this.stop({ keepRemote: false });
    clearBinary();
    this.#setStatus({ phase: "idle", error: "" });
    return ensureBinary({
      extraSources: this.#channel.downloadSources ?? [],
      log: (m) => this.#log(m),
      onProgress: (p) => this.#setStatus({ downloadPercent: p.percent }),
      force: true,
    });
  }

  /** 要求 sidecar 重新走一次交互登录（清掉节点身份后重启）。 */
  async relogin() {
    await this.stop({ keepRemote: false });
    try {
      rmSync(channelStateDir(this.#key), { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    this.#restarts = 0;
    this.#stopping = false;
    await this.start();
  }

  /**
   * 停止。
   * @param keepRemote true 时只注销自己的 forward，不关掉共享的 sidecar
   */
  async stop({ keepRemote = false } = {}) {
    this.#stopping = true;
    this.#stopPolling();
    // 只注销自己注册过的入站端口：sidecar 可能是别的 profile 拉起的，不能连坐。
    for (const port of this.#forwards) {
      try {
        await this.#call("/__tsnet/unforward", { method: "POST", body: { port }, timeoutMs: 5000 });
      } catch {
        /* 尽力而为；owner 关闭时整个 sidecar 会一起走 */
      }
    }
    this.#forwards.clear();

    if (!this.#ownsProcess || keepRemote) {
      this.#log("保留共享的 sidecar（非本实例拉起）");
      this.#port = 0;
      return;
    }

    const child = this.#child;
    if (!child) return;
    this.#log("关闭 sidecar（stdin EOF）");
    try {
      child.stdin.end();
    } catch {
      /* 管道可能已经断了 */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已经没了 */
        }
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    clearRendezvous(this.#key);
    this.#port = 0;
    this.#child = null;
  }
}

export { ensureBinary, binaryInfo, clearBinary, binaryPath };
