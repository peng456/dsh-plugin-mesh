/**
 * 页面里的发现：汇合点名单 + WebSocket 探测 + 手填。
 *
 * 浏览器拿不到 group 播组，也没有能被别人连进来的端口，所以「发现」在页面里
 * 只能反过来做：页面主动往外连。可行的手段只有三种，按代价从小到大——
 *
 *   1. 问汇合点（它提供本页面，也提供 `/__mesh/api/peers`）：一次 HTTP 请求
 *   2. 主动探测：对候选地址开一条 WebSocket，用 `hello` 帧问对面是谁
 *   3. 手填：用户自己写 `192.168.1.9:45917`
 *
 * 每条探测都走汇合点的同源隧道（`/__mesh/tunnel?target=`），因为页面常常是
 * https，而桌面是明文 ws —— 混合内容策略不允许页面直接连 `ws://`。
 *
 * 结果是**喂给 discovery**，而不是另建一份名单：这样主面板、派任务、端点冷却
 * 全都不用改，页面里的节点和真机器长得一样。
 */

/** 一条探测结果的形状，与 `discovery.note()` 期望的记录一致。 */
const APPS = "dsh-mesh";

/**
 * 把汇合点的地址拼成页面能用的 ws 隧道 URL。
 * @param {string} target - `host:port`。
 * @param {string} hubBase - 汇合点 origin（页面自己的 origin）。
 * @param {string} token - 隧道令牌，没有则不带。
 * @returns {string} ws(s) URL。
 */
export function tunnelUrl(target, hubBase, token = "") {
  const url = new URL("/__mesh/tunnel", hubBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("target", target);
  if (token !== "") url.searchParams.set("t", token);
  return url.href;
}

/**
 * 打开一条隧道并完成 hello 握手。
 * @param {string} target - `host:port`。
 * @param {object} options - `hubBase`、`token`、`timeoutMs`。
 * @returns {Promise<object|null>} 对端自述的名片，或 null（超时/不像 DSH）。
 */
export function probePeer(target, { hubBase, token = "", timeoutMs = 900 } = {}) {
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* 已经关了 */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      socket = new WebSocket(tunnelUrl(target, hubBase, token));
    } catch {
      finish(null);
      return;
    }
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: "" }));
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      // 隧道自己会回 `{type:"error"}`（不在私网段、端口不对、对端拒连）。
      if (message?.type === "error") { finish(null); return; }
      if (message?.type !== "hello") return;
      if (message.app !== APPS || !message.id) { finish(null); return; }
      finish(message);
    };
    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);
  });
}

/**
 * 从汇合点的地址推出要扫的 /24。
 *
 * 页面拿不到网络拓扑，但知道自己是从哪台机器加载的——那台机器就在同一个
 * 局域网里，所以它的 /24 就是最合理的猜测。扫不到也不影响什么：手填兜底。
 * @param {URL} hub - 汇合点地址。
 * @returns {string[]} 254 个候选地址。
 */
export function subnetCandidates(hub) {
  const parts = hub.hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return [];
  const prefix = parts.slice(0, 3).join(".");
  const self = parts[3];
  const out = [];
  for (let host = 1; host < 255; host += 1) {
    if (host === self) continue;
    out.push(`${prefix}.${host}`);
  }
  return out;
}

/**
 * 发现页面能连的桌面节点，并把它们记进 discovery。
 *
 * 顺序即优先级：先问汇合点（一次请求，最快），再扫网段（并发有上限，最慢），
 * 手填的地址永远参与（用户明确说了那里有东西，不要再替他决定）。
 * @param options.hubBase - 汇合点 origin。
 * @param options.discovery - MeshDiscovery 实例。
 * @param options.port - 对端 mesh 端口，默认 45917。
 * @param options.manual - 手填的 `host:port` 列表。
 * @param options.scan - 是否扫网段，默认 true。
 * @param options.token - 隧道令牌。
 * @param options.concurrency - 并发探测数，默认 30（手机端建议 10）。
 * @param options.onProgress - 每探到一个就回调一次。
 * @returns {Promise<{hub: number, scanned: number, manual: number, found: string[]}>}
 */
export async function discoverWebPeers({
  hubBase,
  discovery,
  port = 45917,
  manual = [],
  scan = true,
  token = "",
  concurrency = 30,
  onProgress,
} = {}) {
  const hub = new URL(hubBase);
  const found = [];
  let fromHub = 0;
  let scanned = 0;
  let fromManual = 0;

  /** 记一条：名片来自对端，地址是我们观察到的。 */
  const remember = (record, host) => {
    if (record.id === undefined) return false;
    const changed = discovery.note(record, host, {
      transport: "ws",
      channel: `ws:${host}`,
      port: Number(record.port) || port,
      probeIntervalMs: 60_000,
    });
    if (changed) {
      found.push(`${record.machine || host} (${host})`);
      onProgress?.(record, host);
    }
    return changed;
  };

  // ── 1. 汇合点名单 ──────────────────────────────────────────────────────
  try {
    const response = await fetch(new URL("/__mesh/api/peers", hub), { cache: "no-store" });
    if (response.ok) {
      const body = await response.json();
      // 汇合点列出的**桌面**节点：它们自己登记过，地址就是 registry 里那个。
      for (const entry of body?.desktops ?? []) {
        if (!entry?.address) continue;
        const record = { app: APPS, id: entry.id, machine: entry.machine, port: port, transports: ["ws"] };
        if (remember(record, String(entry.address).split(":")[0])) fromHub += 1;
      }
    }
  } catch {
    // 汇合点不可达不影响后面两步
  }

  // ── 2. 手填 ────────────────────────────────────────────────────────────
  for (const entry of manual ?? []) {
    const [host, rawPort] = String(entry).split(":");
    const target = `${host}:${Number(rawPort) || port}`;
    const card = await probePeer(target, { hubBase, token });
    scanned += 1;
    if (card === null) continue;
    if (remember({ ...card, port: Number(rawPort) || port }, host)) fromManual += 1;
  }

  // ── 3. 扫网段（并发上限，探到就停） ────────────────────────────────────
  if (scan) {
    const candidates = subnetCandidates(hub);
    for (let index = 0; index < candidates.length; index += concurrency) {
      const batch = candidates.slice(index, index + concurrency);
      const results = await Promise.all(batch.map(async (host) => {
        const card = await probePeer(`${host}:${port}`, { hubBase, token });
        return card === null ? null : { host, card };
      }));
      for (const hit of results) {
        if (hit === null || hit === undefined) continue;
        scanned += 1;
        remember({ ...hit.card, port }, hit.host);
      }
    }
  }

  return { hub: fromHub, scanned, manual: fromManual, found };
}
