/**
 * 「经 mesh 口转发对端 Web GUI」的自测。
 *
 * 断言的重点不是"能转发"，而是**改写是否真的到位** —— 这条通道的全部难点都在
 * 那三个头上：Host / Origin（对端围栏按它判同源，不改就 403）、Cookie（会话只能
 * 由被看端自己签）。历史教训是"看着接好了、其实一用就 403"，所以这里逐条验，
 * 并且验票据被抹掉、Set-Cookie 不外泄。
 *
 * 全部无外网：上游与被测转发器都只监听 127.0.0.1，端口由系统分配。
 *
 *   node lib/_selftest-peer-web.mjs
 */
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { connect as netConnect } from "node:net";
import {
  PEER_WEB_PREFIX,
  PEER_WEB_TICKET_HEADER,
  PEER_WEB_TICKET_TTL_MS,
  createPeerWebForwarder,
  createPeerWebTicket,
  inspectPeerWebTicket,
  peerWebRemainder,
  verifyPeerWebTicket,
} from "./peer-web.js";
import { signSessionCookie } from "./desktop-auth.js";
import { createWebProxy } from "./web-proxy.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) return result.then(
      () => { passed += 1; console.log(`  ✓ ${name}`); },
      (error) => { failed += 1; console.log(`  ✗ ${name}\n      ${error?.message ?? error}`); },
    );
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
  return Promise.resolve();
}

/** 起一个只监听回环的服务器，返回 { port, close }。 */
function listen(server) {
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const SECRET = "mesh-secret-for-test";
const WEB_SECRET = Buffer.from("browser-session-secret-for-test", "utf8");

console.log("── 票据 ──");
await test("合法票据：12 小时内有效", () => {
  const ticket = createPeerWebTicket(SECRET, { now: 1_000_000 });
  assert.deepEqual(inspectPeerWebTicket(SECRET, ticket, { now: 1_000_000 }), { ok: true });
  assert.equal(verifyPeerWebTicket(SECRET, ticket, { now: 1_000_000 + PEER_WEB_TICKET_TTL_MS - 1 }), true);
});

await test("过期票据：报 expired，不报 malformed", () => {
  const ticket = createPeerWebTicket(SECRET, { now: 1_000_000, ttlMs: 1000 });
  // expiresAt = 1_001_000：到期那一刻就该拒绝（<= now）
  assert.deepEqual(inspectPeerWebTicket(SECRET, ticket, { now: 1_001_000 }), { ok: false, reason: "expired" });
});

await test("换密钥签的票据：报 signature（不是过期、不是格式）", () => {
  const ticket = createPeerWebTicket("someone-else", { now: 1_000_000 });
  assert.deepEqual(inspectPeerWebTicket(SECRET, ticket, { now: 1_000_000 }), { ok: false, reason: "signature" });
});

await test("篡改有效期：报 signature", () => {
  const ticket = createPeerWebTicket(SECRET, { now: 1_000_000, ttlMs: 1000 });
  const forged = Buffer.from(String(Date.now() + 10 * PEER_WEB_TICKET_TTL_MS)).toString("base64url")
    + ticket.slice(ticket.lastIndexOf("."));
  assert.deepEqual(inspectPeerWebTicket(SECRET, forged, { now: 1_000_000 }), { ok: false, reason: "signature" });
});

await test("空/畸形票据：报 malformed", () => {
  assert.deepEqual(inspectPeerWebTicket(SECRET, ""), { ok: false, reason: "malformed" });
  assert.deepEqual(inspectPeerWebTicket(SECRET, "nodot"), { ok: false, reason: "malformed" });
  assert.deepEqual(inspectPeerWebTicket(SECRET, "a."), { ok: false, reason: "malformed" });
});

console.log("── 路径还原 ──");
await test("剥前缀 + 抹掉票据参数", () => {
  assert.equal(peerWebRemainder(`${PEER_WEB_PREFIX}/api/state`), "/api/state");
  assert.equal(peerWebRemainder(`${PEER_WEB_PREFIX}/api/x?a=1&t=zzz`), "/api/x?a=1");
  assert.equal(peerWebRemainder(`${PEER_WEB_PREFIX}/plugins/p.js?t=zzz`), "/plugins/p.js");
});

await test("DSH 的 /plugins/??a,b&rev=… 逐字节保留（回归：编码坏会让模块脚本吃到 index.html）", () => {
  const raw = `${PEER_WEB_PREFIX}/plugins/??@deepseek-ai/dsh-client-modules/client.js,@x/y/client.js&rev=cddf5581d5d5`;
  assert.equal(
    peerWebRemainder(raw),
    "/plugins/??@deepseek-ai/dsh-client-modules/client.js,@x/y/client.js&rev=cddf5581d5d5",
  );
  assert.equal(
    peerWebRemainder(`${raw}&t=ticket`),
    "/plugins/??@deepseek-ai/dsh-client-modules/client.js,@x/y/client.js&rev=cddf5581d5d5",
  );
});

await test("只摘 t 参数：&t=、?t= 都不误伤邻居参数", () => {
  assert.equal(peerWebRemainder(`${PEER_WEB_PREFIX}/a?x=1&t=zz&y=2`), "/a?x=1&y=2");
  assert.equal(peerWebRemainder(`${PEER_WEB_PREFIX}/a?t=zz`), "/a");
});

await test("前缀本身 → /", () => {
  assert.equal(peerWebRemainder(PEER_WEB_PREFIX), "/");
  assert.equal(peerWebRemainder(`${PEER_WEB_PREFIX}/`), "/");
});

await test("前缀外 → undefined", () => {
  assert.equal(peerWebRemainder("/mesh/v1/health"), undefined);
  assert.equal(peerWebRemainder("/mesh/peer-webx/a"), undefined);
});

console.log("── HTTP 转发 ──");
{
  const seen = [];
  const upgraded = [];
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=forbidden-to-leak" });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  // 上游的流式载波：只回 101，稍后关掉（这里不需要真的说 WS 帧）
  upstream.on("upgrade", (req, socket) => {
    upgraded.push({ url: req.url, headers: req.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    setTimeout(() => socket.destroy(), 150);
  });
  const upstreamInfo = await listen(upstream);
  const forwarder = createPeerWebForwarder({
    portOf: () => upstreamInfo.port,
    secretOf: () => WEB_SECRET,
  });
  const mesh = createServer((req, res) => forwarder.handle(req, res));
  mesh.on("upgrade", (req, socket, head) => forwarder.upgrade(req, socket, head));
  const meshInfo = await listen(mesh);

  await test("转发到上游：路径正确、票据被抹掉", async () => {
    const res = await fetch(`http://127.0.0.1:${meshInfo.port}${PEER_WEB_PREFIX}/api/state?a=1&t=secret-ticket`, {
      headers: { [PEER_WEB_TICKET_HEADER]: "secret-ticket", "x-dsh-mesh-token": "mesh-secret" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.url, "/api/state?a=1");
    assert.equal(seen.length, 1);
  });

  await test("Host / Origin / Referer 都改写成上游自己的 authority", () => {
    const { headers } = seen[0];
    const authority = `127.0.0.1:${upstreamInfo.port}`;
    assert.equal(headers.host, authority);
    assert.equal(headers.origin, `http://${authority}`);
    assert.equal(headers.origin, `http://${headers.host}`, "Origin 必须与 Host 同源，否则对端围栏 403");
  });

  await test("会话 cookie 由转发器按上游 authority 自己签", () => {
    const { headers } = seen[0];
    const authority = `127.0.0.1:${upstreamInfo.port}`;
    const expected = signSessionCookie(WEB_SECRET, authority);
    const cookie = String(headers.cookie ?? "");
    const name = cookie.slice(0, cookie.indexOf("="));
    // cookie 名绑定 authority；payload 里也必须写的就是上游 authority。
    // （签名含 issuedAt，所以不能拿两次签名做字符串比较 —— 只验结构。
    assert.equal(name, expected.name);
    const payload = JSON.parse(Buffer.from(cookie.split(".")[1], "base64url").toString("utf8"));
    assert.equal(payload.authority, authority);
    assert.equal(payload.version, 1);
  });

  await test("票据头与 mesh 密钥头都不会带给上游", () => {
    assert.equal(seen[0].headers[PEER_WEB_TICKET_HEADER], undefined);
    assert.equal(seen[0].headers["x-dsh-mesh-token"], undefined);
  });

  await test("上游的 Set-Cookie 不会泄进隧道", async () => {
    const res = await fetch(`http://127.0.0.1:${meshInfo.port}${PEER_WEB_PREFIX}/api/state`);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  await test("没有 Web 端口时如实 503，不装作转发成功", async () => {
    const noGui = createServer((req, res) => {
      createPeerWebForwarder({ portOf: () => 0, secretOf: () => WEB_SECRET }).handle(req, res);
    });
    const noGuiInfo = await listen(noGui);
    const res = await fetch(`http://127.0.0.1:${noGuiInfo.port}${PEER_WEB_PREFIX}/`);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.match(text, /Web GUI/);
    await noGuiInfo.close();
  });

  console.log("── WebSocket 升级 ──");
  await test("升级请求被搬到上游并回 101", async () => {
    const reply = await new Promise((resolvePromise, reject) => {
      const socket = netConnect(meshInfo.port, "127.0.0.1", () => {
        socket.write(
          [
            `GET ${PEER_WEB_PREFIX}/api/remote.mux HTTP/1.1`,
            `host: 127.0.0.1:${meshInfo.port}`,
            "connection: Upgrade",
            "upgrade: websocket",
            "sec-websocket-version: 13",
            "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
            `${PEER_WEB_TICKET_HEADER}: t`,
            "",
            "",
          ].join("\r\n"),
        );
      });
      let buffer = "";
      socket.setTimeout(4000);
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\r\n")) {
          socket.destroy();
          resolvePromise(buffer.split("\r\n")[0]);
        }
      });
      socket.on("timeout", () => { socket.destroy(); reject(new Error("升级超时")); });
      socket.on("error", reject);
    });
    assert.match(reply, /101/);
  });

  await upstreamInfo.close();
  await meshInfo.close();
}


console.log("── 端到端：本机反代 → mesh 隧道 → GUI（含同源围栏）──");
{
  const SESSION = Buffer.from("e2e-browser-session-secret", "utf8");
  const fenceSeen = [];
  /**
   * 按真实服务端的**验证**语义校验 cookie（而不是重新签一次做字符串比较 ——
   * 签名里含 issuedAt，两次签名天然不同，比字符串会假失败）。
   */
  const cookieValid = (cookie, host) => {
    const eq = String(cookie).indexOf("=");
    if (eq === -1) return false;
    const [head, value] = [String(cookie).slice(0, eq), String(cookie).slice(eq + 1)];
    if (head !== signSessionCookie(SESSION, host).name) return false;
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return false;
    if (parts[2] !== createHmac("sha256", SESSION).update(parts[1]).digest("base64url")) return false;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      return payload.authority === host && payload.expiresAt > Date.now();
    } catch {
      return false;
    }
  };
  // 模拟真实 GUI 的围栏：Host 必须是回环，Origin 必须与 Host 同源，cookie 必须验得过
  const gui = createServer((req, res) => {
    const host = String(req.headers.host ?? "");
    const origin = req.headers.origin;
    const cookie = String(req.headers.cookie ?? "");
    fenceSeen.push({ url: req.url, host, origin, cookie });
    const originOk = origin === undefined || new URL(String(origin)).host === host;
    if (!/^127\.0\.0\.1:\d+$/.test(host) || !originOk) { res.writeHead(403); res.end("forbidden"); return; }
    if (!cookieValid(cookie, host)) { res.writeHead(401); res.end("unauthorized"); return; }
    // 宿主 Web 可能自己压过：这里照做，覆盖「注入垫片前先解压」这条路径。
    const body = Buffer.from("<title>peer gui</title>");
    const wantsGzip = String(req.headers["accept-encoding"] ?? "").includes("gzip");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...wantsGzip ? { "content-encoding": "gzip" } : {},
    });
    res.end(wantsGzip ? gzipSync(body) : body);
  });
  const guiInfo = await listen(gui);
  const forwarder = createPeerWebForwarder({ portOf: () => guiInfo.port, secretOf: () => SESSION });
  const mesh = createServer((req, res) => forwarder.handle(req, res));
  mesh.on("upgrade", (req, socket, head) => forwarder.upgrade(req, socket, head));
  const meshInfo = await listen(mesh);

  const proxy = await createWebProxy({
    remoteBase: `http://127.0.0.1:${meshInfo.port}/`,
    nonce: "e2e-nonce",
    pathPrefix: PEER_WEB_PREFIX,
    passthrough: true,
    upstreamHeaders: { [PEER_WEB_TICKET_HEADER]: "e2e-ticket" },
  });

  await test("浏览器的 Origin（回环代理端口）不会让对端 403", async () => {
    const res = await fetch(`${proxy.url}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /peer gui/);
    const last = fenceSeen.at(-1);
    assert.equal(last.origin, `http://${last.host}`, "隧道必须把 Origin 改写成上游同源，否则 403");
    assert.equal(last.url, "/", "根路径要落到上游 /");
  });

  await test("带门禁 cookie 打一个围栏接口：200（不是 403/401）", async () => {
    const first = await fetch(`${proxy.url}`);
    const gate = String(first.headers.get("set-cookie") ?? "").split(";")[0];
    first.body?.cancel?.();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/state`, { headers: { cookie: gate } });
    assert.equal(res.status, 200);
    assert.equal(fenceSeen.at(-1).url, "/api/state");
  });

  await proxy.close();
  await guiInfo.close();
  await meshInfo.close();
}

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed === 0 ? 0 : 1;
