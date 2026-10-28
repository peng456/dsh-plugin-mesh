/**
 * tailnet（tailscale 用户态网络）与局域网发现之间的桥。
 *
 * 为什么需要这一层：宿主机没有 TUN 设备，**路由不到 100.x.y.z**，所有指向
 * tailnet 对端的 HTTP 都必须借 sidecar 的 /__tsnet/fetch 隧道出去。所以这里
 * 提供两个东西：
 *
 *   1. tailnetFetch —— 一个 fetch 形状的封装，让上面的调用点不用关心出口差异
 *   2. tailnetOrigin —— 从入站请求里还原真实的 tailnet 来源地址
 *
 * 发现流程刻意与局域网保持同构：sidecar 给出 tailnet 节点表 → 逐个探
 * /mesh/v1/health → 拿到自述记录 → 走同一个 discovery.note() 进注册表。
 * 因此 mesh_run/任务/UI 完全不需要知道对端是怎么找到的。
 */

/**
 * 借 sidecar 的隧道发 HTTP 请求，返回 fetch 形状的响应。
 *
 * @param {import("./manager.js").TsnetNode} node
 * @param {string} url 必须是 http://100.x.y.z:port/... 形式
 * @param {{method?: string, headers?: Record<string,string>, body?: string, timeoutMs?: number}} opts
 */
export async function tailnetFetch(node, url, opts = {}) {
  const { method = "GET", headers = {}, body, timeoutMs = 20000 } = opts;
  const res = await node.fetchOverTailnet({ url, method, headers, body, timeoutMs });
  const buf = res.body ?? Buffer.alloc(0);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: res.headers ?? {},
    // 与 fetch 的 Response 保持同样的消费接口，调用点才能无差别使用。
    async text() {
      return buf.toString("utf8");
    },
    async json() {
      return JSON.parse(buf.toString("utf8"));
    },
  };
}

/**
 * 从入站请求还原对端真实地址。
 *
 * tailnet 的入站流量是 sidecar 反代过来的，socket 上看到的是 127.0.0.1；
 * 真实地址在 X-Forwarded-For 里（httputil.ReverseProxy 自动加）。
 * 只有当请求确实来自本机回环时才采信该头，否则局域网对端可以伪造来源。
 */
export function tailnetOrigin(req) {
  const remote = req.socket?.remoteAddress ?? "";
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLoopback) return { address: remote, transport: "lan" };

  const xff = String(req.headers["x-forwarded-for"] ?? "");
  if (!xff) return { address: remote, transport: "lan" };

  // XFF 是逗号分隔的链，最左边是原始客户端。
  const first = xff.split(",")[0].trim();
  if (!first) return { address: remote, transport: "lan" };
  // 去掉可能的端口（IPv4:port / [v6]:port）。
  const addr = first.startsWith("[") ? first.slice(1, first.indexOf("]")) : first.replace(/:\d+$/, "");
  return { address: addr, transport: "tsnet" };
}

/** 判断一个地址是不是 tailnet 的 100.64.0.0/10 网段。 */
export function isTailnetAddress(address) {
  const m = /^(\d+)\.(\d+)\./.exec(String(address ?? ""));
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}
