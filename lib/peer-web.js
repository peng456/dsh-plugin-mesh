/**
 * 经 **mesh 口**把自己这台机器的 DSH Web GUI 转发给对端 —— 零证书、零新端口。
 *
 * 为什么需要它：DSH 的 Web GUI 默认只监听 127.0.0.1，而 DSH Desktop **连改都不让改**
 * （`desktopWebServerHost()` 硬编码回环，LAN 意图只作用于它的 HTTPS 边缘）。于是
 * "在另一台机器的面板里打开对端界面"这件事，靠"对端开个端口"是做不到的 —— 除非
 * 额外起一个 web profile，或者让用户去装一张自签证书用 HTTPS 边缘。
 *
 * 这条通道走的是**本来就在局域网上**的 mesh 口：
 *   · 观看端：`GET http://<对端>:<mesh端口>/mesh/peer-web/<原路径>`，
 *     带一枚 `/mesh/v1/web-url` 下发的票据（`x-dsh-peer-web` 头，或 `?t=`）。
 *   · 被看端：校验票据 → 转发到 `127.0.0.1:<本地 Web 端口>`，顺手把
 *     Host/Origin/Referer 改写成回环同源、并签好本机的会话 cookie。
 *
 * 票据 = `base64url(expiresAt).HMAC-SHA256(mesh 密钥, "peer-web:"+body)`，12 小时。
 * 密钥是本机 state.json 里的 mesh 密钥；票据只在**过了鉴权**的 `/mesh/v1/web-url`
 * 上发放（`requirePairing` 打开时就是配对过的对端）。
 *
 * 边界：这不是 TLS —— 局域网明文，和 mesh 通道本身同级；不可信网络请开配对码，
 * 或者自己套 SSH/反代。转发只发生在被看端进程内部，所以它的 GUI 不必对外开端口。
 *
 * **鉴权策略与 mesh 口的其它路由完全一致**（不另立一套）：
 *   · 一键关闭（局域网/互联网 mesh 关掉）时整条隧道跟着 503 —— 它在 mesh server
 *     的请求处理里，和任务路由共用同一个闸门；
 *   · `requirePairing` 打开时，每个隧道请求都要带共享密钥（`x-dsh-mesh-token`，
 *     由观看端代理附着），和派发任务同权；
 *   · 票据是额外一层：只在**鉴权之后**的 `/mesh/v1/web-url` 发放、12 小时过期，
 *     用来把"见过地址"和"能长期用"分开；它不替代上面两道。
 * 共享密钥与票据都**不转发给上游 GUI**（见 rewrite()）。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { signSessionCookie } from "./desktop-auth.js";
import { createGzip } from "node:zlib";
// [mesh-keepalive] 复用上游连接：几十个 bundle 请求不该各建一次 TCP。
// tailnet 上每次握手就是一个 RTT；局域网/回环上也省掉握手与端口分配。
const upstreamAgent = new HttpAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, timeout: 30000 });


/** 隧道前缀（挂在 mesh 口上，和 Web 口上的 /mesh/web 不是一回事）。 */
export const PEER_WEB_PREFIX = "/mesh/peer-web";
/** 票据头：观看端每个请求都带；也接受 `?t=` 方便 curl 手工验证。 */
export const PEER_WEB_TICKET_HEADER = "x-dsh-peer-web";
/** 票据有效期：一次浏览会话足够长，又不至于永久。 */
export const PEER_WEB_TICKET_TTL_MS = 12 * 3600 * 1000;

function b64u(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

/**
 * 签一枚隧道票据。
 * @param secret - mesh 密钥（state.json 里那条）
 * @param options.ttlMs - 有效期，默认 12 小时
 * @param options.now - 注入时间便于测试
 * @returns {string} `body.signature`
 */
export function createPeerWebTicket(secret, { ttlMs = PEER_WEB_TICKET_TTL_MS, now = Date.now() } = {}) {
  const body = b64u(Buffer.from(String(now + ttlMs), "utf8"));
  const signature = b64u(createHmac("sha256", String(secret)).update(`peer-web:${body}`).digest());
  return `${body}.${signature}`;
}

/**
 * 校验一枚隧道票据。
 *
 * 三条独立的拒绝理由都要能分开（AGENTS.md 硬约束 1：别把探测失败当成否定事实）：
 * 格式不对 / 签名不对 / 过期 —— 前两条是"不是我们发的"，最后一条是"发过但超时"。
 * @returns {{ ok: boolean, reason?: "malformed" | "signature" | "expired" }}
 */
export function inspectPeerWebTicket(secret, ticket, { now = Date.now() } = {}) {
  const text = String(ticket ?? "");
  const cut = text.lastIndexOf(".");
  if (cut <= 0 || cut === text.length - 1) return { ok: false, reason: "malformed" };
  const body = text.slice(0, cut);
  const signature = text.slice(cut + 1);
  const expected = createHmac("sha256", String(secret)).update(`peer-web:${body}`).digest();
  let given;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature" };
  }
  const expiresAt = Number(Buffer.from(body, "base64url").toString("utf8"));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** 便捷布尔版（路由里只关心能不能过）。 */
export function verifyPeerWebTicket(secret, ticket, options) {
  return inspectPeerWebTicket(secret, ticket, options).ok;
}

/**
 * 把 `/mesh/peer-web/...` 还原成对端 Web 口上的原路径，并抹掉票据参数。
 *
 * ⚠️ 这里**必须按原字符串处理**，不能 `new URL()` + `searchParams` 转一圈：
 * DSH 的插件脚本地址是 `/plugins/??a/client.js,b/client.js&rev=…` 这种
 * 多问号 + 逗号的非常规形式，`URLSearchParams.toString()` 会把 `?` 编码成 `%3F`、
 * `@`→`%40`、`/`→`%2F`，对端静态路由就匹配不上，兜底返回 index.html ——
 * 浏览器拿到 HTML 当脚本解析，前端只报一句
 * `client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js`。
 * @returns {string | undefined} `undefined` 表示不在这个前缀下
 */
export function peerWebRemainder(url) {
  const text = String(url ?? "/");
  const at = text.indexOf("?");
  const pathname = at === -1 ? text : text.slice(0, at);
  if (pathname !== PEER_WEB_PREFIX && !pathname.startsWith(`${PEER_WEB_PREFIX}/`)) return undefined;
  const rest = pathname.slice(PEER_WEB_PREFIX.length) || "/";
  if (at === -1) return rest;
  // 只摘掉我们自己的票据参数（`t` / `t=`），其余逐字节保留。
  const kept = text
    .slice(at + 1)
    .split("&")
    .filter((part) => part !== "t" && !part.startsWith("t="));
  return kept.length ? `${rest}?${kept.join("&")}` : rest;
}

/**
 * 造一个「转发到本机 Web GUI」的处理器。
 *
 * 与 `desktop-web.js` 的区别只有一个：那里目标是**另一个**引擎的固定端口，
 * 这里目标是**本进程自己的** Web 口，而且端口可能在运行期才确定（所以传函数）。
 * 认证照旧在服务端完成：按目标 authority 签会话 cookie，浏览器侧永远不见 token。
 *
 * @param options.portOf - 返回本机 Web 端口（0/缺省表示没有 GUI）
 * @param options.secretOf - 返回浏览器会话密钥（Buffer）
 * @param options.log - 正常日志
 * @param options.warn - 异常日志
 * @returns {{ handle: (req, res) => void, upgrade: (req, socket, head) => void }}
 */
export function createPeerWebForwarder({ portOf, secretOf, log = () => {}, warn = () => {} }) {
  /**
   * 把入站请求改写成"本机浏览器直接打开对端 GUI"的样子。
   *
   * 三件事缺一不可：
   *   1. Host 换回环 —— 对端围栏按 Host 判断"是不是自己的 authority"；
   *   2. Origin/Referer 同步改写 —— 围栏要求 `new URL(origin).host === host.host`，
   *      不改就会被判跨站 403（实测：Cordis 清单接口 403、`/api/remote.mux` 升级被拒，
   *      界面停在「重新连接中…」）；
   *   3. 自己签会话 cookie —— 浏览器那条路要走 token 才能换到 cookie。
   */
  function rewrite(incoming, authority) {
    const headers = { ...incoming, host: authority };
    headers.origin = `http://${authority}`;
    if (headers.referer !== undefined) headers.referer = `http://${authority}/`;
    if (String(headers["sec-fetch-site"] ?? "") === "cross-site") headers["sec-fetch-site"] = "same-origin";
    delete headers[PEER_WEB_TICKET_HEADER];
    // mesh 密钥只属于 mesh 层，别带进上游 GUI 的请求/日志里。
    delete headers["x-dsh-mesh-token"];
    // 隧道票据不是给上游看的，Cookie 也由这里全权维护（浏览器那侧没有 token）。
    const secret = secretOf();
    if (secret) headers.cookie = signSessionCookie(secret, authority).header;
    else delete headers.cookie;
    return headers;
  }

  function handle(req, res) {
    const port = portOf();
    const path = peerWebRemainder(req.url ?? "/");
    if (!port) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("本端没有可用的 Web GUI（不是 web profile）。\n");
      return;
    }
    if (path === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    const authority = `127.0.0.1:${port}`;
    const up = httpRequest(
      { host: "127.0.0.1", port, method: req.method, path, headers: rewrite(req.headers, authority), agent: upstreamAgent },
      (reply) => {
        const out = { ...reply.headers };
        // 会话由本转发维护，别把 Set-Cookie 泄到隧道外（观看端没有对应的 authority）。
        delete out["set-cookie"];
        delete out["transfer-encoding"];
        // [mesh-gzip] 上游没压时在隧道这一跳压缩（tailnet 是细管，收益最大）
        if (out["content-encoding"] === undefined
            && String(req.headers["accept-encoding"] ?? "").includes("gzip")
            // HTML 不压：观看端代理要往文档里注入垫片，必须拿到明文；
            // 大文档也就几十 KB，压不压对总时长没有意义，而注入冲突是硬错误。
            && /^text\/|javascript|json|svg|css/i.test(String(out["content-type"] ?? ""))
            && !/^text\/html/i.test(String(out["content-type"] ?? ""))) {
          out["content-encoding"] = "gzip";
          out["vary"] = "accept-encoding";
          delete out["content-length"];
          res.writeHead(reply.statusCode ?? 502, out);
          reply.pipe(createGzip({ level: 1 })).pipe(res);
          return;
        }
        res.writeHead(reply.statusCode ?? 502, out);
        reply.pipe(res);
      },
    );
    up.on("error", (error) => {
      warn(`对端 GUI 隧道转发失败（${authority}）：${error?.message ?? error}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("连不上本机 Web GUI。\n");
    });
    if (req.readableEnded) up.end();
    else req.pipe(up);
  }

  /** 流式载波（`/api/remote.mux`）：HTTP 代理不管 WS，必须单独搬字节。 */
  function upgrade(req, socket, head) {
    const port = portOf();
    const path = peerWebRemainder(req.url ?? "/");
    if (!port || path === undefined) {
      socket.destroy();
      return;
    }
    const authority = `127.0.0.1:${port}`;
    const headers = rewrite(req.headers, authority);
    const target = netConnect(port, "127.0.0.1", () => {
      log(`对端 GUI 隧道已接通 ${path}`);
      const lines = [`${req.method} ${path} HTTP/1.1`];
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
      }
      target.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head && head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    target.on("error", (error) => {
      warn(`对端 GUI 隧道升级失败（${authority}）：${error?.message ?? error}`);
      socket.destroy();
    });
    socket.on("error", () => target.destroy());
  }

  return { handle, upgrade };
}
