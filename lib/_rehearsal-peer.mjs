/**
 * 演练用的"假 DSH 对端"。
 *
 * 起一个 tailnet 临时节点，并把它的入站端口反代到本机一个假 mesh 服务上，
 * 于是它在 tailnet 里看起来就是另一台装了 mesh 插件的 DSH。
 *
 * 为什么需要它：产品里的 manager 是整机单实例，同一台机器上的多个 DSH
 * profile 会共享一个 tailnet 节点，没法互相发现。要验证插件的"tailnet 发现
 * → 登记进 peer 注册表"这条整合路径，就需要一个外部的、看起来像独立机器的
 * 对端。有了它，不用等第二台物理机器就能把这条路验穿。
 *
 * 用法：
 *   node lib/_rehearsal-peer.mjs --machine fake-peer --port 46150
 *   （读到 stdout 上的一行 JSON 表示就绪，进程持续运行直到 stdin 关闭或 SIGTERM）
 *
 * 授权码只从 ~/.dsh/mesh/state.json 或 DSH_TSNET_AUTHKEY 读，不走 argv。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { binaryPath } from "./tsnet/download.js";

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const MACHINE = argOf("--machine", "fake-peer");
const PORT = Number(argOf("--port", "46150"));
const EPHEMERAL = argv.includes("--ephemeral");

function loadAuthKey() {
  const fromEnv = String(process.env.DSH_TSNET_AUTHKEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const p = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "mesh", "state.json");
  return String(JSON.parse(readFileSync(p, "utf8")).tsnetAuthKey ?? "").trim();
}

function controlCall(port, token, pathname, { method = "GET", body, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        timeout: timeoutMs,
        headers: { "X-Mesh-Token": token, ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(new Error(e.message));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const authKey = loadAuthKey();
if (!authKey) {
  console.error("没有授权码");
  process.exit(1);
}

// 假 mesh 服务：提供 /mesh/v1/health（被插件的 scanTailnet 探到）与
// /mesh/v1/task（接收派来的任务，用来验证"下大命令"这条完整路径）
const receivedTasks = [];
const meshServer = createServer((req, res) => {
  if (req.url === "/mesh/v1/task" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* 忽略 */
      }
      receivedTasks.push({ ...body, at: Date.now(), xff: String(req.headers["x-forwarded-for"] ?? "") });
      // 把收到的任务写到 stderr，调用方可以从日志里确认内容
      console.error(`[task] 收到 ${body.id} from ${body.from}: ${String(body.task).slice(0, 80)}`);
      const out = Buffer.from(JSON.stringify({ ok: true, id: body.id, duplicate: false }), "utf8");
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": out.length });
      res.end(out);
    });
    return;
  }
  if (req.url === "/mesh/v1/health") {
    const body = Buffer.from(
      JSON.stringify({
        ok: true,
        v: 1,
        app: "dsh-mesh",
        id: `rehearsal-${MACHINE}`,
        machine: MACHINE,
        hostname: `${MACHINE}.local`,
        // 故意填一个不可达的局域网地址：调用方必须忽略它，改用观察到的 tailnet IP
        host: "192.168.1.99",
        port: PORT,
        os: "rehearsal",
        user: "rehearsal",
        profile: "",
        version: "rehearsal",
        requirePairing: false,
        ts: Date.now(),
      }),
      "utf8",
    );
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
});

await new Promise((r) => meshServer.listen(PORT, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), `mesh-peer-${MACHINE}-`));
const token = randomBytes(16).toString("hex");
const nodeName = `dsh-${MACHINE}`.slice(0, 60);
const child = spawn(binaryPath(), ["-hostname", nodeName, "-dir", dir, "-token", token, ...(EPHEMERAL ? ["-ephemeral"] : [])], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, DSH_TSNET_AUTHKEY: authKey },
  windowsHide: true,
});

let buf = "";
let ctlPort = 0;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.event === "listening" && !ctlPort) ctlPort = ev.port;
      if (ev.event === "error") console.error(`[sidecar] ${ev.where}: ${ev.message}`);
    } catch {
      /* 忽略非 JSON */
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  for (const l of String(c).split("\n")) {
    if (l.trim() && !/^tsnet:/.test(l.trim())) console.error(`[sidecar] ${l.trim()}`);
  }
});

const deadline = Date.now() + 90000;
while (!ctlPort && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
if (!ctlPort) {
  console.error("sidecar 没有报告控制端口");
  process.exit(1);
}

let status = null;
while (Date.now() < deadline) {
  try {
    status = await controlCall(ctlPort, token, "/__tsnet/status");
    if (status.backendState === "Running") break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!status || status.backendState !== "Running") {
  console.error(`未能加入 tailnet（backendState=${status?.backendState}）`);
  process.exit(1);
}

await controlCall(ctlPort, token, "/__tsnet/forward", { method: "POST", body: { port: PORT } });

// 就绪信号：一行 JSON，方便调用方解析
console.log(
  JSON.stringify({
    ready: true,
    machine: MACHINE,
    meshPort: PORT,
    tailnetIp: status.selfIpv4,
    dnsName: status.selfDnsName,
    controlPort: ctlPort,
    pid: child.pid,
    ephemeral: status.ephemeral === true,
  }),
);

const shutdown = async () => {
  try {
    child.stdin.end();
  } catch {
    /* 忽略 */
  }
  await new Promise((r) => setTimeout(r, 1500));
  try {
    child.kill("SIGKILL");
  } catch {
    /* 忽略 */
  }
  try {
    meshServer.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  process.exit(0);
};

process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
