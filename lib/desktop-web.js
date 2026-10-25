/**
 * 前缀反向代理：把 `/mesh/web/...` 转发到本机另一个 DSH 引擎的 Web 界面。
 *
 * 前缀只在**本机之间**用：对端（手机上的代理）把浏览器请求原样带过来，
 * 这里去掉前缀再打给 loopback。浏览器一侧看到的永远是根的绝对路径，
 * 所以对端前端里的 /api、/plugins 不需要任何改写。
 */
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { signSessionCookie } from "./desktop-auth.js";

/** 前缀本身。 */
export const DESKTOP_WEB_PREFIX = "/mesh/web";

/**
 * 客户端的流式载波（WebSocket）：`new WebSocket(remoteStreamUrl(...))` 开的就是它。
 * 少了这条 upgrade 转发，前端会永远停在"自动重连中"，工作区与会话列表也就不会出现
 * ——POST 请求都能通，所以症状看起来像"只有一部分功能好了"。
 */
export const DESKTOP_WEB_STREAM_PATH = `${DESKTOP_WEB_PREFIX}/api/remote.mux`;

/** 去掉前缀；不是这个前缀下的请求返回 undefined。 */
function remainder(url) {
  if (url === DESKTOP_WEB_PREFIX || url === `${DESKTOP_WEB_PREFIX}/`) return "/";
  if (!url.startsWith(`${DESKTOP_WEB_PREFIX}/`)) return undefined;
  return url.slice(DESKTOP_WEB_PREFIX.length);
}

/**
 * 造一个转发 handler。
 * @param options - port（目标引擎端口）、secretOf（读密钥的函数）、log、warn
 * @returns {(req, res) => Promise<void>}
 */
export function createDesktopWebForwarder({ port, secretOf, log = () => {}, warn = () => {} }) {
  const authority = `127.0.0.1:${port}`;

  function forward(req, res, retried) {
    const secret = secretOf();
    if (!secret) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("读不到本机的浏览器会话密钥（.credentials.yaml 里没有 browser-session 记录）。\n");
      return;
    }
    const path = remainder(req.url ?? "/");
    if (path === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    // 探针：不转发，直接回答"这条链路在不在"。
    if (path === "/__probe") {
      const body = Buffer.from(JSON.stringify({ ok: true, target: authority }), "utf8");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length) });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    const headers = { ...req.headers, host: authority, cookie: signSessionCookie(secret, authority).header };
    // 浏览器是从"手机代理的 origin"发起的：Origin 与 Host 不一致会被对端的
    // 同源栅栏拒成 403（而插件自己的路由不过栅栏，所以看起来"一部分能用"）。
    // 我们本来就是替浏览器发的，这里把来源改写成目标 authority。
    headers.origin = `http://${authority}`;
    if (headers.referer !== undefined) headers.referer = `http://${authority}/`;
    if (String(headers["sec-fetch-site"] ?? "") === "cross-site") headers["sec-fetch-site"] = "same-origin";
    const up = httpRequest({ host: "127.0.0.1", port, method: req.method, path, headers }, (reply) => {
      // 401 = 密钥换过或算错了：重读一次密钥再试一遍（幂等方法）。
      if (reply.statusCode === 401 && !retried && (req.method === "GET" || req.method === "HEAD")) {
        reply.resume();
        forward(req, res, true);
        return;
      }
      const out = { ...reply.headers };
      // 认证由这里维护，别把对端的 Set-Cookie 泄到上一层。
      delete out["set-cookie"];
      delete out["transfer-encoding"];
      res.writeHead(reply.statusCode ?? 502, out);
      reply.pipe(res);
    });

    up.on("error", (error) => {
      warn(`桌面引擎转发失败（${authority}）：${error?.message ?? error}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`连不上本机 ${authority}：${error?.message ?? error}\n`);
    });

    if (req.readableEnded) up.end();
    else req.pipe(up);
  }

  return async function handle(req, res) {
    log(`${req.method ?? "GET"} ${req.url ?? "/"} → ${authority}`);
    forward(req, res, false);
  };
}


/**
 * 造一个 upgrade 转发器：把流式端点的握手原样转给本机 loopback 引擎。
 * @param options - port、secretOf、log、warn
 * @returns {(req, socket, head) => void}
 */
export function createDesktopWebUpgrade({ port, secretOf, log = () => {}, warn = () => {} }) {
  const authority = `127.0.0.1:${port}`;
  return function handleUpgrade(req, socket, head) {
    const secret = secretOf();
    if (!secret) {
      warn("读不到会话密钥，无法转发 WebSocket");
      socket.destroy();
      return;
    }
    const url = req.url ?? "/";
    const path = url.startsWith(DESKTOP_WEB_PREFIX) ? url.slice(DESKTOP_WEB_PREFIX.length) || "/" : url;
    try {
      const h = req.headers;
      appendFileSync("/tmp/mesh-web.log", `UPGRADE-REQ ${path} ext=${h["sec-websocket-extensions"] ?? "-"} origin=${h.origin ?? "-"} ua=${String(h["user-agent"] ?? "-").slice(0, 30)}\n`);
    } catch {}
    log(`UPGRADE ${path} → ${authority}`);
    const target = netConnect(port, "127.0.0.1", () => {
      const lines = [`${req.method} ${path} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const name = key.toLowerCase();
        // 这几个由代理改写（见 HTTP 分支同样的理由：同源栅栏 + 认证）。
        if (name === "host" || name === "cookie" || name === "origin" || name === "referer" || name === "sec-fetch-site") continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
      }
      lines.push(`host: ${authority}`);
      lines.push(`cookie: ${signSessionCookie(secret, authority).header}`);
      lines.push(`origin: http://${authority}`);
      lines.push("sec-fetch-site: same-origin");
      target.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head && head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    target.on("error", (error) => {
      warn(`WebSocket 转发失败：${error?.message ?? error}`);
      socket.destroy();
    });
    socket.on("error", () => target.destroy());
  };
}
