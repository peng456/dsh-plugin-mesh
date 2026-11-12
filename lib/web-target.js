/**
 * 「在我这台机器上，怎么才能真的打开对端的 DSH 界面」—— 纯决策，不做 IO。
 *
 * 为什么需要单独一层：对端 `GET /mesh/v1/web-url` 的自报地址是**站在它自己角度**
 * 算出来的（`preferredAddress()`），手机在移动数据下那会是运营商 CGNAT 的 10.x；
 * 它再顺带自报一个 `lanReachable`（判据只是"我绑了 0.0.0.0"）。这两样都不是
 * "观看端能不能到"的证据，照单全收的结果就是面板永远 502：
 *
 *     连不上对端 10.12.225.124:3080：socket hang up
 *
 * 所以判断权必须留在观看端：
 *   1. 地址能拨通（真的拿到 HTTP 响应）→ 直接用它，行为和以前一致；
 *   2. 拨不通，但对端有一条 tailnet 通道 → 在本机开一个回环端口，由 sidecar
 *      把字节流打进 tailnet（宿主机路由不到 100.x，且 WebSocket 升级也走这条）；
 *   3. 两条都不可用 → 如实说"哪一条试过、怎么失败的"，不许把探测失败伪装成
 *      对端已关闭（AGENTS.md 硬约束 1）。
 *
 * @typedef {{ prefix: string, ticket: string, header: string } | null} TunnelInfo
 * @typedef {{ mode: "direct" | "stream" | "none", remoteBase?: string, address?: string,
 *             prefix?: string, ticket?: string, header?: string, note: string }} WebTargetPlan
 */

/**
 * 从对端给的 tunnel 描述里取出**相对前缀**。
 *
 * 新版本对端发 `{ prefix: "/mesh/peer-web", ticket }`；老版本发的是一条绝对地址
 * `{ url: "http://<它自己的地址>:<mesh端口>/mesh/peer-web/" }` —— 那种地址的主机
 * 部分同样可能是不可达的 10.x，所以**只取路径**，主机由观看端用自己的通道决定。
 * @returns {string} 带前导斜杠、不带尾斜杠的前缀；无则空串。
 */
export function tunnelPrefixOf(tunnel) {
  if (!tunnel || typeof tunnel !== "object") return "";
  const raw = String(tunnel.prefix ?? "").trim();
  if (raw) {
    const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
    return withSlash.replace(/\/+$/, "");
  }
  const url = String(tunnel.url ?? "").trim();
  if (!url) return "";
  try {
    return new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    // 解析不了的地址当"没有前缀"，不要凭空猜一个出来。
    return "";
  }
}

/**
 * 决定观看端用哪条路。
 *
 * @param {object} input
 * @param {string} input.reportedBase 对端自报的绝对地址（`http://host:port/`）
 * @param {number} [input.reportedPort] 对端 GUI 端口，缺省取地址里的端口
 * @param {boolean} [input.reachable] 本机真的拨通过没有；`undefined` = 没测（按可达处理，保持旧行为）
 * @param {TunnelInfo} [input.tunnel] 对端 mesh 口隧道
 * @param {string} [input.tsnetHost] 对端的 tailnet 地址（100.64/10）；没有就走不了公网
 * @param {number} [input.meshPort] 对端 mesh 口端口（隧道挂在它上面）
 * @param {boolean} [input.guiBoundEverywhere] 对端 GUI 是否绑在所有网卡（bind=0.0.0.0）；
 *   `undefined` = 对端没报（老版本），按"绑了"处理以保持旧行为
 * @param {string} [input.probeNote] 探测失败时的原始描述，需原样带进 note
 * @returns {WebTargetPlan}
 */
export function planWebTarget({
  reportedBase,
  reportedPort,
  reachable,
  tunnel = null,
  tsnetHost = "",
  meshPort = 0,
  guiBoundEverywhere,
  probeNote = "",
} = {}) {
  const base = String(reportedBase ?? "");
  const port = Number(reportedPort) || portOf(base) || 0;
  const reportedHost = hostOf(base);

  // 对端自报 `127.0.0.1` 表示「我的 GUI 只听回环」——那不是本机能直连的地址，
  // 直连过去只会打到**本机自己**的 3080（一个非常难查的假成功）。
  // 所以这类地址一律不按直连处理，只能走它给的 mesh 口隧道。
  const loopbackReport = isLoopbackHost(reportedHost);
  const direct = reachable !== false && !loopbackReport;

  // 没探测 / 探测通过 → 照旧直连。局域网路径上不多花一毫秒。
  if (direct) {
    return { mode: "direct", remoteBase: base, note: "" };
  }

  const host = String(tsnetHost ?? "").trim();
  if (!host) {
    return {
      mode: "none",
      remoteBase: base,
      note: loopbackReport
        ? `对端只报了回环地址 ${base}（它的 GUI 只听 127.0.0.1），且没有 tailnet 通道可用`
        : `对端自报地址 ${base} 从本机拨不通（${probeNote || "无响应"}），且没有 tailnet 通道可用`,
    };
  }

  const prefix = tunnelPrefixOf(tunnel);
  const ticket = String(tunnel?.ticket ?? "");
  const header = String(tunnel?.header ?? "x-dsh-peer-web");

  // 隧道挂在**对端的 mesh 口**上：目标是对端 mesh 端口 + 相对前缀。
  // 这条路把 Host/Origin/会话 cookie 的改写留在对端进程里完成，所以对端 GUI
  // 只绑回环也能看；WebSocket（/api/remote.mux）同样走这条。
  if (prefix && ticket && meshPort > 0) {
    return {
      mode: "stream",
      address: `${host}:${meshPort}`,
      prefix,
      ticket,
      header,
      note: `经对端 mesh 口隧道（对端自报地址 ${base} 不可达）`,
    };
  }

  // 没有隧道（对端认为它"局域网可达"，其实只有运营商地址）：直接打通它的 GUI。
  // 前提是**对端 GUI 真的绑在所有网卡上**（它报的 bind=0.0.0.0）。只绑回环的
  // 宿主连它自己的 tailnet 地址都不听，拨过去只会被拒。
  const boundEverywhere = guiBoundEverywhere !== false;
  if (port > 0 && boundEverywhere && !loopbackReport) {
    return {
      mode: "stream",
      address: `${host}:${port}`,
      prefix: "",
      ticket: "",
      header,
      note: `经本机 tailnet 通道直连对端 GUI ${host}:${port}（对端自报地址 ${base} 不可达）`,
    };
  }

  return {
    mode: "none",
    remoteBase: base,
    note: loopbackReport || !boundEverywhere
      ? `对端 GUI 只听回环（${base}），且没给 mesh 口隧道 —— 需要把对端插件升级到带隧道的版本`
      : `对端自报地址 ${base} 从本机拨不通（${probeNote || "无响应"}），且没拿到对端 GUI 端口`,
  };
}

/** 从 `http://host:port/` 里取主机名；取不到返回空串。 */
function hostOf(base) {
  try {
    return new URL(String(base ?? "")).hostname;
  } catch {
    return "";
  }
}

/** 这个主机名是不是"本机回环"（对端自称只听回环时会给它）。 */
export function isLoopbackHost(host) {
  const text = String(host ?? "").trim().toLowerCase();
  if (!text) return false;
  if (text === "localhost" || text.endsWith(".localhost")) return true;
  if (text === "::1" || text === "0:0:0:0:0:0:0:1") return true;
  if (/^127\./.test(text)) return true;
  return false;
}

/** 从 `http://host:port/` 里取端口；取不到返回 0。 */
function portOf(base) {
  try {
    const parsed = new URL(base);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
}

/**
 * 这个主机名需不需要先探测一次可达性。
 *
 * 只用来决定"要不要探测"：同网段地址拨不通会在面板里立刻明确报出来，没必要
 * 每次都先花 1.5 秒探测；跨网段的地址（运营商 CGNAT、别的子网）才是对端自报
 * 地址最容易骗人的地方 —— 10.x 尤其：手机在移动数据下的自报地址就长这样。
 * @param {string} host
 * @param {string[]} localAddresses 本机 IPv4 列表
 */
export function needsReachabilityProbe(host, localAddresses = []) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host ?? ""));
  if (!m) return true;
  if (m[1] === "127") return false;
  const wanted = `${m[1]}.${m[2]}.${m[3]}`;
  for (const address of localAddresses) {
    const n = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(String(address ?? ""));
    if (!n) continue;
    if (`${n[1]}.${n[2]}.${n[3]}` === wanted) return false;
  }
  return true;
}
