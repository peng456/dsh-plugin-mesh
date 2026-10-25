/**
 * 对端 DSH Web 的回环反向代理。
 *
 * 为什么需要它：手机上"在应用内看对端 DSH"有两条路都被堵死——
 *   1) 壳的浏览器 WebView 在本机不可用（browserWebViewAvailable=false），
 *      sidebar 的 browser 页签只会显示"浏览器不可用"；
 *   2) 直接 iframe 对端地址会卡在 401：对端的会话 cookie 是 SameSite=Strict，
 *      跨站 iframe 里不发送；token 又会随对端重启轮换。
 *
 * 所以把认证搬到服务端：
 *   · 代理用 token 换一次对端的签名 cookie，之后每一个转发请求都自己带；
 *   · 浏览器只跟本机的这个回环端口说话，不需要任何 token、也没有 SameSite 问题；
 *   · 页面挂在**独立端口**上（不是 /mesh/... 子路径），所以对端 SPA 里的
 *     绝对路径 /api、/plugins 天然落在代理上，不用改写任何压缩后的 JS。
 *
 * 安全：只监听 127.0.0.1，并且首次访问必须带一次性 k=<nonce>（换一枚
 * HttpOnly cookie）。本机其它 App 拿不到 nonce 就用不了这条通道。
 * 这不是"安全方案"，只是别让它成为同机任意 App 的免费后门；
 * 真正的边界在"谁能碰到这台手机"。
 */
import { createServer, request as httpRequest } from "node:http";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { connect as netConnect } from "node:net";

/** 我们自己发的门禁 cookie：名字固定，值就是 nonce。 */
const GATE_COOKIE = "dshmesh-web";

/**
 * 老 WebView 垫片：Chrome 122 之前没有 `Iterator` 全局对象。
 *
 * 对端前端里有些库会这样"补方法"：`"function" != typeof Iterator.prototype.join
 * && (Iterator.prototype.join = ...)` —— 守卫只看了 `.join`，没先看 `Iterator`
 * 本身，于是在缺少 Iterator 的引擎上直接 ReferenceError，整个插件装不上
 * （实测报错：failed to import loader entry …documentpreview: Iterator is not defined）。
 *
 * 垫片只在真的没有 Iterator 时生效，现代引擎上是空转。
 */
const ITERATOR_SHIM =
  '<script>(function(){' +
  // 老 WebView 兼容层：这三类 API 缺一个，对端前端就会在启动阶段抛异常
  'try{if(typeof globalThis.Iterator!=="function"){var It=function Iterator(){throw new TypeError("Iterator is not constructible")};It.prototype={};globalThis.Iterator=It;}}catch(e){}' +
  'try{if(!Promise.withResolvers){Promise.withResolvers=function(){var res,rej;var p=new Promise(function(a,b){res=a;rej=b;});return{promise:p,resolve:res,reject:rej};};}}catch(e){}' +
  'try{if(!AbortSignal.any){AbortSignal.any=function(list){var c=new AbortController();var l=Array.prototype.slice.call(list||[]);function onAbort(){var hit=null;for(var i=0;i<l.length;i++){if(l[i]&&l[i].aborted){hit=l[i];break;}}cleanup();c.abort(hit?hit.reason:undefined);}function cleanup(){for(var i=0;i<l.length;i++){try{l[i].removeEventListener("abort",onAbort);}catch(e){}}}for(var i=0;i<l.length;i++){var sig=l[i];if(!sig)continue;if(sig.aborted){c.abort(sig.reason);return c.signal;}sig.addEventListener("abort",onAbort);}return c.signal;};}}catch(e){}' +
  'try{if(!AbortSignal.timeout){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort(new DOMException("signal timed out","TimeoutError"));},ms);return c.signal;};}}catch(e){}' +
  'try{var ap=Array.prototype;if(!ap.toSorted){ap.toSorted=function(f){return Array.prototype.slice.call(this).sort(f);};}if(!ap.toReversed){ap.toReversed=function(){return Array.prototype.slice.call(this).reverse();};}if(!ap.with){ap.with=function(i,v){var a=Array.prototype.slice.call(this);a[i<0?a.length+i:i]=v;return a;};}if(!ap.findLast){ap.findLast=function(fn,th){for(var i=this.length-1;i>=0;i--){if(fn.call(th,this[i],i,this))return this[i];}return undefined;};}}catch(e){}' +
  'try{if(!Object.groupBy){Object.groupBy=function(items,key){var out=Object.create(null);for(var it of items){var k=String(typeof key==="function"?key(it):it[key]);if(!out[k])out[k]=[];out[k].push(it);}return out;};}}catch(e){}' +
  // 前端错误回传：被控端看不到控制台时，只能靠这条通道排障
  'function rep(kind,msg){try{fetch("/__clientlog",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:kind,msg:String(msg).slice(0,600),url:location.href})});}catch(e){}}' +
  'addEventListener("error",function(e){rep("error",(e.message||"")+" @"+(e.filename||"")+":"+(e.lineno||0));});' +
  'addEventListener("unhandledrejection",function(e){rep("rejection",(e.reason&&(e.reason.stack||e.reason.message))||e.reason);});' +
  'var ce=console.error;console.error=function(){try{rep("console",Array.prototype.join.call(arguments," "));}catch(e){}return ce.apply(console,arguments);};' +
  '})();</script>';

/** 把垫片插到 <head> 之后（越早越好：模块脚本是 defer，但内联脚本会先跑）。 */
function injectShim(html) {
  const at = html.indexOf("<head>");
  if (at === -1) return ITERATOR_SHIM + html;
  const cut = at + "<head>".length;
  return html.slice(0, cut) + ITERATOR_SHIM + html.slice(cut);
}

/** 从 Set-Cookie 头里取 name=value 对（Node 20 有 getSetCookie，旧版退化到 raw）。 */
function setCookiePairs(headers) {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : (headers.raw?.()["set-cookie"] ?? []);
  return list.map((line) => String(line).split(";")[0].trim()).filter((pair) => pair.includes("="));
}

/** 把服务端持有的对端 cookie 与请求自带的（我们自己的门禁 cookie 要剔除）合并。 */
function mergeCookie(serverCookie, incoming) {
  const kept = String(incoming ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${GATE_COOKIE}=`));
  return [serverCookie, ...kept].filter(Boolean).join("; ");
}

function hasGate(req, nonce) {
  const raw = String(req.headers.cookie ?? "");
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === GATE_COOKIE && rest.join("=") === nonce) return true;
  }
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("k") === nonce;
  } catch {
    return false;
  }
}

/**
 * 起一个指向 `remoteBase` 的回环代理。
 * @param options - remoteBase（对端 http://host:port/）、token（启动 token，可空）、
 *   nonce、initialCookie（上次持久化下来的对端会话 cookie）、onCookie（换到新 cookie 时的落盘回调）、log、warn
 * @returns {Promise<{ port: number, url: string, remote: string, hasSession: () => boolean, close: () => Promise<void> }>}
 */
export async function createWebProxy({
  remoteBase,
  token = "",
  nonce,
  initialCookie = "",
  onCookie = () => {},
  pathPrefix = "",
  passthrough = false,
  log = () => {},
  warn = () => {},
}) {
  const remote = new URL(remoteBase);
  if (remote.protocol !== "http:") throw new Error(`只支持 http 对端，收到 ${remote.protocol}`);
  const authority = remote.host;
  const remotePort = Number(remote.port || 80);
  const hostname = remote.hostname;

  // 对端 cookie 是 30 天、由对端持久密钥签名的，跨对端重启仍有效 —— 所以
  // 优先复用上次存下来的，token 只在"没 cookie 或 cookie 被拒"时才需要。
  const prefix = String(pathPrefix || "").replace(/\/+$/, "");
  let cookie = initialCookie || "";
  // cookie 在手里不等于对端认它：真收到 401 才翻成 false，供 UI 如实提示。
  let healthy = true;
  let minting = null;

  /** 用 token 换一枚对端签名 cookie（并发调用只换一次）。 */
  async function mint() {
    if (!token) return false;
    if (minting) return minting;
    minting = (async () => {
      try {
        const url = new URL(remote.origin);
        url.searchParams.set("token", token);
        const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(6000) });
        const pairs = setCookiePairs(res.headers);
        if (pairs.length === 0) {
          warn(`换 cookie 没拿到 Set-Cookie（HTTP ${res.status}）`);
          return false;
        }
        cookie = pairs.join("; ");
        try {
          onCookie(cookie);
        } catch (error) {
          warn(`保存对端 cookie 失败：${error?.message ?? error}`);
        }
        log(`已换到对端会话 cookie（HTTP ${res.status}）`);
        return true;
      } catch (error) {
        warn(`换 cookie 失败：${error?.message ?? error}`);
        return false;
      } finally {
        minting = null;
      }
    })();
    return minting;
  }

  /** 一次转发；不改写路径，只是把 Host/Cookie 换掉。 */
  function forward(req, res, retried = false) {
    const headers = { ...req.headers, host: authority };
    const merged = mergeCookie(cookie, headers.cookie);
    if (merged) headers.cookie = merged;
    else delete headers.cookie;
    // 文档要改写（插垫片），所以这一条必须拿明文；静态资源照旧走压缩。
    const wantsHtml = String(headers.accept ?? "").includes("text/html");
    if (wantsHtml) headers["accept-encoding"] = "identity";

    const up = httpRequest(
      { host: hostname, port: remotePort, method: req.method, path: `${prefix}${req.url ?? "/"}`, headers },
      (reply) => {
        // 401 = 我们的服务端 cookie 过期/轮换过：换一次再重试（只重试幂等方法）。
        const idempotent = req.method === "GET" || req.method === "HEAD";
        if (reply.statusCode === 401 && !retried && idempotent && token && !passthrough) {
          reply.resume();
          mint()
            .then((ok) => {
              if (!ok) {
                res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
                res.end("对端拒绝认证，且无法用 token 重新换取会话。\n");
                return;
              }
              forward(req, res, true);
            })
            .catch(() => {
              res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
              res.end("对端认证重试失败。\n");
            });
          return;
        }

        if (reply.statusCode === 401) healthy = false;
        else if ((reply.statusCode ?? 0) < 400) healthy = true;

        const out = { ...reply.headers };
        // 认证由服务端维护，别把对端的 Set-Cookie 泄到浏览器上（会覆盖/堆积）。
        delete out["set-cookie"];
        delete out["transfer-encoding"];
        // 绝对 Location 指回对端时改成本代理的相对路径。
        if (typeof out.location === "string" && out.location.startsWith(remote.origin)) {
          const tail = out.location.slice(remote.origin.length);
          out.location = tail.startsWith("/") ? tail : `/${tail}`;
        }

        // 文档：读完再插垫片（此时 accept-encoding 已被压成 identity，是明文）。
        const type = String(reply.headers["content-type"] ?? "");
        if (reply.statusCode === 200 && type.startsWith("text/html") && (req.method === "GET" || req.method === "HEAD")) {
          const chunks = [];
          reply.on("data", (chunk) => chunks.push(chunk));
          reply.on("end", () => {
            try {
              const body = Buffer.from(injectShim(Buffer.concat(chunks).toString("utf8")), "utf8");
              delete out["content-encoding"];
              out["content-length"] = String(body.length);
              res.writeHead(200, out);
              res.end(req.method === "HEAD" ? undefined : body);
              log(`已给文档注入兼容垫片（${body.length}B）`);
            } catch (error) {
              warn(`文档注入失败，按原样返回：${error?.message ?? error}`);
              if (!res.headersSent) res.writeHead(200, out);
              res.end(req.method === "HEAD" ? undefined : Buffer.concat(chunks));
            }
          });
          reply.on("error", () => res.destroy());
          return;
        }

        res.writeHead(reply.statusCode ?? 502, out);
        reply.pipe(res);
      },
    );

    up.on("error", (error) => {
      warn(`转发失败：${error?.message ?? error}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`连不上对端 ${authority}：${error?.message ?? error}\n`);
    });

    // 请求体直接流过去；没有 body 时 end()，避免挂住。
    if (req.readableEnded) up.end();
    else req.pipe(up);
  }

  const audit = (line) => {
    try {
      appendFileSync(join(homedir(), "tmp/webpanel-access.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* 日志失败不影响转发 */
    }
  };

  const server = createServer((req, res) => {
    // 前端错误回传：被控端看不到控制台，这是唯一的排障通道
    if (req.url === "/__clientlog" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        audit(`CLIENT ${Buffer.concat(chunks).toString("utf8").slice(0, 900)}`);
        res.writeHead(204);
        res.end();
      });
      return;
    }
    audit(`${req.method} ${req.url} gate=${hasGate(req, nonce)}`);
    if (!hasGate(req, nonce)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("这个端口只服务于 DSH 的 Web 面板，请从应用里打开。\n");
      return;
    }
    // 首次带 ?k= 进来时种下门禁 cookie，之后（包括 SPA 的绝对路径请求）都能过。
    if (req.url && req.url.includes("k=")) {
      res.setHeader("set-cookie", `${GATE_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Strict`);
    }
    forward(req, res);
  });

  /** WebSocket 升级：对端的会话流全靠它，HTTP 代理不管用。 */
  server.on("upgrade", (req, socket, head) => {
    audit(`UPGRADE ${req.url} gate=${hasGate(req, nonce)}`);
    if (!hasGate(req, nonce)) {
      socket.destroy();
      return;
    }
    const target = netConnect(remotePort, hostname, () => {
      audit(`UPGRADE-CONNECTED upstream=${hostname}:${remotePort} path=${prefix}${req.url}`);
      // 前缀必须带上，否则对端的 upgrade 路由匹配不上（WS 直接握手失败）
      const lines = [`${req.method} ${prefix}${req.url ?? "/"} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const name = key.toLowerCase();
        if (name === "host" || name === "cookie") continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
      }
      lines.push(`host: ${authority}`);
      const merged = mergeCookie(cookie, req.headers.cookie);
      if (merged) lines.push(`cookie: ${merged}`);
      target.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head && head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    target.on("error", (error) => {
      audit(`UPGRADE-ERROR upstream=${hostname}:${remotePort} ${error?.message ?? error}`);
      warn(`WebSocket 转发失败：${error?.message ?? error}`);
      socket.destroy();
    });
    socket.on("error", () => target.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  // 没有可用 cookie 时才去换：让第一次点开就是已登录状态，而不是先吃一个 401。
  if (!passthrough && !cookie) await mint();

  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/?k=${encodeURIComponent(nonce)}`;
  log(`代理已启动 ${url} → ${remote.origin}`);

  return {
    port,
    url,
    remote: remote.origin,
    // 直通模式（对端自己负责认证）我们不持有 cookie，按"正常"处理。
    hasSession: () => (passthrough ? healthy : cookie !== "" && healthy),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
