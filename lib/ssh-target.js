/**
 * 「这次 SSH 该连哪个地址」—— 纯决策，不做 IO。
 *
 * 背景：SSH 是裸 TCP，而 tailnet 在这台机器上是**用户态**的（tsnet sidecar），
 * 宿主根本没有 100.x 的路由。所以「用对端的 tailnet 地址去连 22 端口」永远
 * 只会卡到 `timed out waiting for handshake` —— index.js 里原先那句注释就是
 * 踩过这个坑之后写的。
 *
 * 正确做法分两步：
 *   1. 先在**能直连**的地址里挑一个（局域网/局域网同段）；
 *   2. 都不通、但对端有 tailnet 端点时，让 sidecar 在本机开一个回环端口，
 *      把字节流打进 tailnet（`openStream`），SSH 再连 127.0.0.1:<那个端口>。
 *
 * 这样「SSH 走 tailnet」在两端都成立，且不需要系统级 tailscaled、不需要改 sshd。
 *
 * @typedef {{ mode: "direct" | "stream" | "none", host?: string, port?: number,
 *             address?: string, note: string }} SshTargetPlan
 */

/**
 * 从对端的端点候选里挑出 SSH 要用的地址。
 *
 * @param {object} input
 * @param {Array<{host?: string, transport?: string}>} [input.endpoints] 对端端点（已按健康排序）
 * @param {number} [input.port] SSH 端口，缺省 22
 * @param {string} [input.requestedHost] 客户端指定的主机（兜底）
 * @param {string} [input.tsnetHost] 对端 tailnet 地址（100.64/10）；有它才可能走通道
 * @param {string} [input.reachableHost] 探测下来**确实连得上**的主机；没有则不直连
 * @returns {SshTargetPlan}
 */
export function planSshTarget({
  endpoints = [],
  port = 22,
  requestedHost = "",
  tsnetHost = "",
  reachableHost = "",
} = {}) {
  const wanted = Number(port) > 0 ? Number(port) : 22;

  // 1) 探测已经证明能连 → 直连（局域网最快，且不占 sidecar 端口）。
  const direct = String(reachableHost ?? "").trim();
  if (direct) {
    return { mode: "direct", host: direct, port: wanted, note: `直连 ${direct}:${wanted}` };
  }

  // 2) 拨不通，但对端在 tailnet 上 → 本机回环端口 + tailnet 字节流。
  const tailnet = String(tsnetHost ?? "").trim();
  if (tailnet) {
    return {
      mode: "stream",
      address: `${tailnet}:${wanted}`,
      port: wanted,
      note: `经本机 tailnet 通道直连 ${tailnet}:${wanted}（对端 ${wanted} 端口在 tailnet 上）`,
    };
  }

  // 3) 两条都不成立：如实说清"没有 tailnet 端点"，不要编一个地址出来。
  const requested = String(requestedHost ?? "").trim();
  const candidates = endpoints.map((ep) => String(ep?.host ?? "").trim()).filter(Boolean);
  return {
    mode: "none",
    host: requested,
    port: wanted,
    note:
      `对端没有可用的 tailnet 端点，直连候选（${candidates.join("、") || requested || "无"}）` +
      `也都拨不通 —— SSH 需要局域网可达，或对端插件带 tailnet 通道`,
  };
}

/**
 * SSH 的直连候选顺序：**局域网地址优先**，其次才是其它（tailnet 地址不进候选，
 * 因为宿主拨不到；它只作为 `tsnetHost` 走通道）。
 *
 * @param {Array<{host?: string, transport?: string}>} endpoints
 * @param {string} requestedHost
 * @returns {string[]}
 */
export function sshDirectCandidates(endpoints = [], requestedHost = "") {
  const isPrivate = (h) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(h ?? ""));
  const out = [];
  const push = (host) => {
    const value = String(host ?? "").trim();
    if (value && !out.includes(value)) out.push(value);
  };
  for (const ep of endpoints) {
    if (ep?.transport === "tsnet") continue;
    if (isPrivate(ep?.host)) push(ep.host);
  }
  const requested = String(requestedHost ?? "").trim();
  if (isPrivate(requested)) push(requested);
  for (const ep of endpoints) {
    if (ep?.transport === "tsnet") continue;
    push(ep?.host);
  }
  push(requested);
  return out;
}
