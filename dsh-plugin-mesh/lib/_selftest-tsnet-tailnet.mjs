/**
 * tailnet 双节点演练：验证互联网自组网真的能跨节点发现与通信。
 *
 * 跑法：node lib/_selftest-tsnet-tailnet.mjs
 *   授权码从 ~/.dsh/mesh/state.json 的 tsnetAuthKey 读，或从环境变量
 *   DSH_TSNET_AUTHKEY 读。**不接受命令行参数** —— 授权码等同进网凭证，
 *   不能出现在 ps 可见的地方。
 *
 * 为什么在本机起两个节点：
 *   产品里的 manager 是**整机单实例**（一台机器只占一个 tailscale 设备名额），
 *   所以两个 DSH profile 在同一台机器上只会共享一个节点，没法互相发现。
 *   这里绕过 manager 直接驱动两个 sidecar（不同 hostname + 不同 state 目录
 *   = tailnet 里两台独立设备），把 tailnet 数据通路验穿：
 *
 *     A 的节点表里能看到 B → A 能跨隧道 fetch 到 B → B 收到的
 *     X-Forwarded-For 是 A 的 tailnet IP（而不是 127.0.0.1）
 *
 *   最后一条是入站识别的关键：tailnet 流量是 sidecar 反代过来的，
 *   socket 上永远是回环地址，真实来源只能靠 XFF。
 *
 * 两个节点都用 -ephemeral 启动：断开后由控制面自动移除，不占设备名额，
 * 也不会在你的 tailnet 里留下垃圾设备。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { binaryInfo, binaryPath, ensureBinary, looksExecutable } from "./tsnet/download.js";

let passed = 0;
let failed = 0;
const step = (label) => console.log(`\n── ${label} ──`);
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    failed += 1;
  }
}
const log = (m) => console.log(`      · ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 授权码只从 state.json 或环境变量取，不走 argv。 */
function loadAuthKey() {
  const fromEnv = String(process.env.DSH_TSNET_AUTHKEY ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const p = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "mesh", "state.json");
    return String(JSON.parse(readFileSync(p, "utf8")).tsnetAuthKey ?? "").trim();
  } catch {
    return "";
  }
}

// ── 直接驱动 sidecar 的最小客户端 ─────────────────────────────

function controlCall(port, token, pathname, { method = "GET", body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        timeout: timeoutMs,
        headers: {
          "X-Mesh-Token": token,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(new Error(`非 JSON 响应: ${e.message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("控制 API 超时")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 起一个 sidecar 并等它真正上到 tailnet。 */
async function startNode({ name, authKey, forwardPort }) {
  const dir = mkdtempSync(join(tmpdir(), `mesh-tsnet-${name}-`));
  const token = randomBytes(16).toString("hex");
  const child = spawn(binaryPath(), ["-hostname", name, "-dir", dir, "-token", token, "-ephemeral"], {
    stdio: ["pipe", "pipe", "pipe"],
    // 授权码走环境变量：macOS 上任何本地用户都能通过 ps 看到别人的命令行
    env: { ...process.env, DSH_TSNET_AUTHKEY: authKey },
    windowsHide: true,
  });

  let buf = "";
  // 记住 sidecar 报出的致命错误：它随后会退出，之后只能看到 ECONNREFUSED，
  // 那样"授权码无效"这类关键原因就被埋掉了。
  let fatal = "";
  let port = 0;
  const deadline = Date.now() + 90000;
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => stderr.push(String(c)));

  await new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.event === "listening" && !port) {
          port = ev.port;
          resolve();
        }
        if (ev.event === "error") {
          // 记住真正的原因：进程随后会退出，后面只会看到 ECONNREFUSED，
          // 那样会把"授权码无效"这类关键信息埋掉。
          fatal = `${ev.where}: ${ev.message}`;
          log(`[${name}] error: ${fatal}`);
        }
      }
    });
    child.once("exit", (code, sig) => reject(new Error(`${name} 启动即退出（code=${code} sig=${sig}）${fatal ? ` —— ${fatal}` : ""}\n${stderr.join("")}`)));
    setTimeout(() => reject(new Error(`${name} 90s 内没有报告 listening`)), 90000);
  });

  // 等它真的上到 tailnet
  let status = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${name} 进程已退出${fatal ? ` —— ${fatal}` : ""}\n${stderr.join("").slice(-500)}`);
    }
    try {
      status = await controlCall(port, token, "/__tsnet/status", { timeoutMs: 8000 });
    } catch (e) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${name} 进程已退出${fatal ? ` —— ${fatal}` : ""}\n${stderr.join("").slice(-500)}`);
      }
      await sleep(1500);
      continue;
    }
    if (status.backendState === "Running") break;
    if (status.authUrl) log(`[${name}] 需要授权：${status.authUrl}`);
    await sleep(2000);
  }
  if (!status || status.backendState !== "Running") {
    throw new Error(`${name} 未能加入 tailnet（backendState=${status?.backendState}）\n${stderr.join("")}`);
  }

  await controlCall(port, token, "/__tsnet/forward", { method: "POST", body: { port: forwardPort } });

  return {
    name,
    dir,
    token,
    port,
    child,
    ephemeral: status.ephemeral === true,
    selfIpv4: status.selfIpv4,
    selfDnsName: status.selfDnsName,
    call: (p, o) => controlCall(port, token, p, o),
    async stop() {
      try {
        child.stdin.end(); // stdin EOF → 自杀，不留孤儿
      } catch {
        /* 管道可能已断 */
      }
      const until = Date.now() + 6000;
      while (Date.now() < until && child.exitCode === null && child.signalCode === null) await sleep(150);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已经没了 */
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 假 DSH 节点：回应 /mesh/v1/health，并记下收到的 X-Forwarded-For。 */
function startFakeNode(machine, port) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, xff: String(req.headers["x-forwarded-for"] ?? ""), remote: req.socket.remoteAddress });
    if (req.url === "/mesh/v1/health") {
      const body = Buffer.from(
        JSON.stringify({
          ok: true,
          app: "dsh-mesh",
          id: `fake-${machine}`,
          machine,
          hostname: `${machine}.local`,
          host: "192.168.1.99", // 故意填一个不可达的局域网地址，验证调用方不会采信它
          port,
          version: "rehearsal",
        }),
        "utf8",
      );
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, seen, close: () => server.close() })));
}

// ── 主流程 ────────────────────────────────────────────────────

const authKey = loadAuthKey();
const nodes = [];
let fakeA = null;
let fakeB = null;
const PORT_A = 46101;
const PORT_B = 46102;

try {
  step("0. 前置条件");
  // 走和插件完全一样的下载路径：按内置 sha256 校验、解压、原子安装。
  // 缓存里是旧版时会自动重下（靠 .source-sha256 标记比对）。
  const bin = await ensureBinary({ log });
  check("sidecar 二进制已就绪且是可执行文件", () => {
    const info = binaryInfo();
    assert.ok(info.installed, `未找到 sidecar：${info.path}`);
    assert.ok(looksExecutable(), "文件头不像可执行文件，可能下载损坏");
    log(`${info.path}（${(info.size / 1048576).toFixed(1)}MB，${bin.downloaded ? "本次新下载" : "用缓存"}，来源 ${bin.source}）`);
  });
  if (!authKey) {
    console.log("\n✗ 没有授权码。请先在 Mesh 页面填入，或设 DSH_TSNET_AUTHKEY。");
    process.exit(1);
  }
  log(`授权码已就绪（长度 ${authKey.length}，不回显）`);

  step("1. 起两个假 DSH 节点（本机回环）");
  fakeA = await startFakeNode("rehearsal-a", PORT_A);
  fakeB = await startFakeNode("rehearsal-b", PORT_B);
  check("两个假节点已监听", () => {
    assert.ok(fakeA && fakeB);
    log(`rehearsal-a → 127.0.0.1:${PORT_A}，rehearsal-b → 127.0.0.1:${PORT_B}`);
  });

  step("2. 起两个临时 tailnet 节点（-ephemeral，用完自动摘除）");
  const nodeA = await startNode({ name: "dsh-rehearsal-a", authKey, forwardPort: PORT_A });
  nodes.push(nodeA);
  log(`A 已上线：${nodeA.selfIpv4}（${nodeA.selfDnsName}）`);
  const nodeB = await startNode({ name: "dsh-rehearsal-b", authKey, forwardPort: PORT_B });
  nodes.push(nodeB);
  log(`B 已上线：${nodeB.selfIpv4}（${nodeB.selfDnsName}）`);

  check("两个节点拿到了不同的 tailnet IP", () => {
    assert.ok(nodeA.selfIpv4?.startsWith("100."), `A 的地址异常：${nodeA.selfIpv4}`);
    assert.ok(nodeB.selfIpv4?.startsWith("100."), `B 的地址异常：${nodeB.selfIpv4}`);
    assert.notEqual(nodeA.selfIpv4, nodeB.selfIpv4, "两个节点拿到了同一个地址，说明复用了设备身份");
  });
  // 控制面不回传节点的 ephemeral 属性，所以这里至少确认开关真的传到了 sidecar，
  // 而不是被静默忽略（曾经就是靠"设备还在列表里"才发现开关没生效）
  check("sidecar 确实收到了 -ephemeral", () => {
    assert.equal(nodeA.ephemeral, true, `A 的 status.ephemeral=${nodeA.ephemeral}`);
    assert.equal(nodeB.ephemeral, true, `B 的 status.ephemeral=${nodeB.ephemeral}`);
  });

  step("3. 节点表互见（发现的前提）");
  let peersA = [];
  for (let i = 0; i < 20 && !peersA.some((p) => p.hostname === "dsh-rehearsal-b"); i += 1) {
    await sleep(2000);
    peersA = (await nodeA.call("/__tsnet/peers")).peers ?? [];
  }
  check("A 的 tailnet 节点表里能看到 B", () => {
    const b = peersA.find((p) => p.hostname === "dsh-rehearsal-b");
    assert.ok(b, `A 只看到：${peersA.map((p) => p.hostname).join(", ") || "（空）"}`);
    assert.equal(b.ipv4, nodeB.selfIpv4, `B 的地址对不上：${b.ipv4} vs ${nodeB.selfIpv4}`);
    log(`A 看到 ${peersA.length} 个节点，其中 B = ${b.ipv4} online=${b.online}`);
  });

  step("4. 跨隧道出站：A 借自己的 sidecar 去 fetch B");
  let got = null;
  for (let i = 0; i < 10; i += 1) {
    const r = await nodeA.call("/__tsnet/fetch", {
      method: "POST",
      timeoutMs: 25000,
      body: {
        url: `http://${nodeB.selfIpv4}:${PORT_B}/mesh/v1/health`,
        method: "GET",
        headers: { accept: "application/json" },
        timeoutMs: 15000,
      },
    });
    if (r.ok) {
      got = JSON.parse(Buffer.from(r.bodyBase64, "base64").toString("utf8"));
      break;
    }
    await sleep(2000);
  }
  check("A 成功拿到 B 的 health 记录", () => {
    assert.ok(got, "10 次尝试都没通");
    assert.equal(got.app, "dsh-mesh");
    assert.equal(got.machine, "rehearsal-b", `机器名不对：${got.machine}`);
    log(`拿到 ${got.machine}（自述 host=${got.host} —— 这是不可达的局域网地址，调用方必须忽略它）`);
  });

  step("5. 入站来源还原：B 必须看到 A 的 tailnet IP，而不是 127.0.0.1");
  const seenB = fakeB.seen.filter((s) => s.url === "/mesh/v1/health");
  check("B 收到了请求", () => {
    assert.ok(seenB.length > 0, "B 一条都没收到");
  });
  check("socket 上确实是回环（这正是需要 XFF 的原因）", () => {
    assert.ok(seenB.every((s) => s.remote === "127.0.0.1" || s.remote === "::ffff:127.0.0.1"), `remoteAddress=${seenB.map((s) => s.remote).join(",")}`);
  });
  check("X-Forwarded-For 里是 A 的 tailnet IP", () => {
    const last = seenB[seenB.length - 1];
    assert.ok(last.xff, "B 没收到 X-Forwarded-For");
    const first = last.xff.split(",")[0].trim();
    assert.equal(first, nodeA.selfIpv4, `XFF=${last.xff}，期望 ${nodeA.selfIpv4}`);
    log(`B 看到来源 ${first}（A 的 tailnet IP）`);
  });

  step("6. 反方向也通（双向）");
  let gotA = null;
  for (let i = 0; i < 10; i += 1) {
    const r = await nodeB.call("/__tsnet/fetch", {
      method: "POST",
      timeoutMs: 25000,
      body: { url: `http://${nodeA.selfIpv4}:${PORT_A}/mesh/v1/health`, method: "GET", timeoutMs: 15000 },
    });
    if (r.ok) {
      gotA = JSON.parse(Buffer.from(r.bodyBase64, "base64").toString("utf8"));
      break;
    }
    await sleep(2000);
  }
  check("B 也能拿到 A 的记录", () => {
    assert.ok(gotA, "反方向 10 次都没通");
    assert.equal(gotA.machine, "rehearsal-a");
  });
  check("A 侧同样看到 B 的 tailnet IP", () => {
    const seenA = fakeA.seen.filter((s) => s.url === "/mesh/v1/health");
    assert.ok(seenA.length > 0, "A 一条都没收到");
    const first = seenA[seenA.length - 1].xff.split(",")[0].trim();
    assert.equal(first, nodeB.selfIpv4, `XFF=${seenA[seenA.length - 1].xff}，期望 ${nodeB.selfIpv4}`);
  });

  step("7. 用插件自己的 bridge 函数走一遍（不是仅裸 HTTP）");
  const { tailnetFetch, tailnetOrigin, isTailnetAddress } = await import("./tsnet/bridge.js");
  const fakeNode = { fetchOverTailnet: (o) => nodeA.call("/__tsnet/fetch", { method: "POST", body: { ...o, url: o.url }, timeoutMs: 25000 }).then((r) => ({ status: r.status, headers: r.headers, body: Buffer.from(r.bodyBase64, "base64"), error: r.error })) };
  const res = await tailnetFetch(fakeNode, `http://${nodeB.selfIpv4}:${PORT_B}/mesh/v1/health`, { timeoutMs: 15000 });
  const body = await res.json();
  check("tailnetFetch 能按 fetch 语义取回 JSON", () => {
    assert.equal(res.ok, true, `status=${res.status}`);
    assert.equal(body.machine, "rehearsal-b");
  });
  check("tailnetOrigin 能从反代请求还原来源", () => {
    const seenB2 = fakeB.seen.filter((s) => s.url === "/mesh/v1/health");
    const o = tailnetOrigin({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": seenB2[seenB2.length - 1].xff } });
    assert.equal(o.address, nodeA.selfIpv4);
    assert.equal(o.transport, "tsnet");
    assert.equal(isTailnetAddress(o.address), true);
  });
} catch (err) {
  console.log(`\n✗ 演练中断：${err?.stack ?? err}`);
  failed += 1;
} finally {
  step("清理（节点是 ephemeral，控制面会自动摘除）");
  for (const n of nodes) {
    try {
      await n.stop();
      log(`${n.name} 已停止`);
    } catch (e) {
      log(`${n.name} 停止失败：${e.message}`);
    }
  }
  try {
    fakeA?.close();
    fakeB?.close();
  } catch {
    /* 忽略 */
  }
  // 确认没有留下 sidecar 进程
  const { execSync } = await import("node:child_process");
  try {
    const left = execSync("pgrep -f 'dsh-rehearsal-' || true", { encoding: "utf8" }).trim();
    log(left ? `⚠ 仍有残留进程：${left}` : "无残留 sidecar 进程");
  } catch {
    log("无残留 sidecar 进程");
  }
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
