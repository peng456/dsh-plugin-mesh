/**
 * dsh-plugin-mesh —— 主机侧（Host half）
 *
 * 做四件事：
 *   1. 用 UDP 组播自动发现局域网内的其他 DSH 实例
 *   2. 起一个对端 HTTP 服务，接受其他 DSH 派来的任务
 *   3. 注册 agent 工具（mesh_peers / mesh_run / mesh_tasks），让 agent 能"下命令"
 *   4. 在本地 web server 上开 /mesh/api/*，给 UI 页面用
 *
 * 收到对端任务时怎么唤醒本机 agent（双路，见 IM协作架构设计.md）：
 *   · 任务带了 originSession 且该会话仍活跃 → ctx.agents.get(id).followup() 注入原会话
 *   · 否则                                 → ctx.webhookRuntime.dispatch() 新建会话执行
 *
 * 安全模型：发现是公开的（同一网段谁都能看见谁），但所有控制操作都要过共享配对码。
 *           首次运行自动生成配对码，用户在 UI 上复制到另一台机器即可。
 */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir, hostname, userInfo, platform } from "node:os";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { MeshDiscovery, preferredAddress, lanIPv4Addresses } from "./discovery.js";
import { candidateAddresses, scanForPeers } from "./scan.js";

export const name = "dsh-plugin-mesh";
export const inject = ["tools", "webServer"];

const VERSION = "0.2.0";
const RULE_ID = "mesh-inbound";
const RULE_KIND = "mesh";
const MAX_BODY = 256 * 1024;
const MAX_HISTORY = 200;
/** 默认固定端口：内网里"扫这个端口 + ping 一下"就能建立连接，无需任何配置。 */
export const MESH_DEFAULT_PORT = 45917;

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 本机在对端列表里显示的名字；留空用主机名 */
  machineName: z.string().default(""),
  /**
   * 对端 HTTP 端口。默认固定，这样可以直接扫端口发现彼此。
   * 同机跑多个实例时会被占用，此时自动退回随机端口（仍能用组播互相发现）。
   */
  port: z.natural().default(MESH_DEFAULT_PORT),
  announceIntervalMs: z.natural().default(5000),
  /** 超过这么久没心跳、也没 ping 通，算离线 */
  peerTtlMs: z.natural().default(20000),
  requestTimeoutMs: z.natural().default(20000),

  // ── 发现方式（两者互补，默认都开）──
  /** 用 UDP 组播做被动发现：零配置、即时 */
  useMulticast: z.boolean().default(true),
  /** 启动时主动扫一遍本网段的固定端口：组播被路由器/防火墙挡掉时靠它兜底 */
  scanOnStart: z.boolean().default(true),
  /** 周期性重扫（毫秒），0 = 关闭。默认 60s：一次扫描约 1~2 秒，代价很低 */
  scanIntervalMs: z.natural().default(60000),
  /** 额外要扫的网段，如 ["192.168.1.0/24"]；留空则扫本机所在 /24 */
  scanRanges: z.array(String).default([]),
  /** 除了本机端口，额外还要扫的端口（同机多实例、或对端端口被占用时会用到） */
  scanPorts: z.array(z.natural()).default([]),
  scanConcurrency: z.natural().default(64),
  scanTimeoutMs: z.natural().default(800),
  /** 定期 ping 已知对端（毫秒），0 = 关闭。这条让发现不依赖组播也能保活 */
  pingIntervalMs: z.natural().default(10000),

  // ── 访问控制 ──
  /**
   * 是否要求两端配对码一致。默认 false —— 内网里发现即可连，零配置。
   * 如果你在不完全可信的网络里（合租、公司、有访客设备），把它设为 true。
   */
  requirePairing: z.boolean().default(false),

  /** 对端任务在本机新建会话时用的 agent preset */
  agentPreset: z.string().default("standard"),
  /** 对端任务在本机新建会话时的权限；默认不给 danger-full-access */
  permissionPreset: z.string().default("workspace-write"),
  /** 对端任务新建会话的工作目录；留空用用户主目录 */
  workspaceRoot: z.string().default(""),
});

// ───────────────────────── 本地状态（配对码） ─────────────────────────

function stateDir() {
  const base = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(base, "mesh");
}

function statePath() {
  return join(stateDir(), "state.json");
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = { ...loadState(), ...patch };
  writeFileSync(statePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** 首次运行生成配对码；用户只需把它复制到另一台机器。 */
function ensureSecret() {
  const st = loadState();
  if (typeof st.secret === "string" && st.secret.length >= 16) return st.secret;
  const secret = randomBytes(24).toString("base64url");
  saveState({ secret, createdAt: new Date().toISOString() });
  return secret;
}

function currentSecret() {
  const s = loadState().secret;
  return typeof s === "string" ? s : "";
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 可被 stop 打断的等待（定时器 unref，不阻止进程退出）。 */
function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

// ───────────────────────── 身份与命名 ─────────────────────────

/**
 * 本机名字的解析优先级：**插件配置 > 用户首次启动时填的 > 主机名**。
 *
 * @returns {{name: string, source: 'config'|'saved'|'hostname'}}
 *   source 用来决定 UI 要不要弹"给这台机器起个名字"——
 *   只有落到 hostname 时才算"用户还没命名过"。
 */
function resolveMachineName(config) {
  const fromConfig = String(config.machineName ?? "").trim();
  if (fromConfig) return { name: fromConfig, source: "config" };
  const saved = String(loadState().machineName ?? "").trim();
  if (saved) return { name: saved, source: "saved" };
  return { name: hostname(), source: "hostname" };
}

/** 校验用户填的名字；地址格式是「机器名/agent 名」，所以斜杠要挡住。 */
function validateMachineName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) throw new Error("名字不能为空");
  if (name.length > 32) throw new Error("名字最长 32 个字符");
  if (name.includes("/") || name.includes("\\")) throw new Error("名字不能包含斜杠 —— 地址格式是「机器名/agent 名」");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) throw new Error("名字不能包含控制字符");
  return name;
}

// ───────────────────────── 插件入口 ─────────────────────────

export function apply(ctx, config) {
  if (config.enabled === false) {
    ctx.logger?.info?.("mesh: 已禁用");
    return;
  }
  // 安全网：这是个"附加能力"插件，任何自身故障都不该让 DSH 起不来。
  // 出问题时只禁用自己，并把原因写进日志。
  try {
    applyUnsafe(ctx, config);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    ctx.logger?.error?.(`mesh: 初始化失败，插件已停用（不影响 DSH 其他功能）：${detail}`);
    try {
      ctx.logger?.warn?.("mesh: 插件已停用；修好后重启 DSH 即可恢复。");
    } catch {
      /* logger 本身不可用 */
    }
  }
}

function applyUnsafe(ctx, config) {

  const resolved = resolveMachineName(config);
  const identity = { name: resolved.name, source: resolved.source };
  ensureSecret();
  const instanceId = randomBytes(8).toString("hex");
  const log = (m) => ctx.logger?.info?.(`mesh: ${m}`);
  const warn = (m) => ctx.logger?.warn?.(`mesh: ${m}`);

  const inbound = [];
  const outbound = [];

  const discovery = new MeshDiscovery({
    id: instanceId,
    port: 0,
    meta: { machine: identity.name, user: safeUser(), profile: process.env.DSH_PROFILE ?? "", version: VERSION },
    intervalMs: config.announceIntervalMs,
    ttlMs: config.peerTtlMs,
  });
  discovery.on("diagnostic", (m) => warn(m));
  discovery.on("change", () => {
    try {
      ctx.emit?.("mesh/peers-changed", discovery.peers());
    } catch {
      /* 没有监听者 */
    }
  });

  // 1) 先起对端 HTTP（拿到真实端口），再开始发现
  startPeerServer(ctx, { config, discovery, inbound, log, warn })
    .then(async (port) => {
      discovery.setPort(port);

      // 始终 start：sweep（离线判定）在里面，与组播无关。
      // 关掉组播只影响被动发现，主动扫描 / ping 仍会用同一个注册表。
      discovery.start({ multicast: config.useMulticast !== false });
      if (config.useMulticast !== false) {
        discovery.announceNow();
      } else {
        log("已关闭组播，仅使用主动扫描 + ping");
      }

      log(
        `已启动 machine=${identity.name}（来源 ${identity.source}）` +
          ` 地址=${preferredAddress()}:${port} 实例=${instanceId} ` +
          `配对要求=${config.requirePairing ? "开" : "关"}`,
      );

      // 主动发现 + 保活
      const stop = { aborted: false };
      ctx.effect(() => () => {
        stop.aborted = true;
      });

      if (config.scanOnStart) {
        // 启动扫描常常抢在对方起来之前跑完，所以没找到就退避重试几次。
        // 这直接决定"刚装好能不能自动发现"，值得多试几下。
        const delays = [0, 8000, 20000, 45000];
        (async () => {
          for (let i = 0; i < delays.length; i += 1) {
            if (stop.aborted) return;
            if (delays[i] > 0) await sleep(delays[i]);
            if (stop.aborted) return;
            await runScan({ discovery, config, log, warn, signal: stop, reason: `启动扫描#${i + 1}` });
            if (discovery.peers().length > 0) return; // 找到了就不再重试
          }
          log("启动扫描未发现对端；之后靠组播与周期扫描继续尝试");
        })().catch(() => {});
      }

      if (config.scanIntervalMs > 0) {
        const t = setInterval(
          () => runScan({ discovery, config, log, warn, signal: stop, reason: "周期扫描" }).catch(() => {}),
          config.scanIntervalMs,
        );
        t.unref?.();
        ctx.effect(() => () => clearInterval(t));
      }

      if (config.pingIntervalMs > 0) {
        const t = setInterval(
          () => pingKnownPeers({ discovery, config, warn }).catch(() => {}),
          config.pingIntervalMs,
        );
        t.unref?.();
        ctx.effect(() => () => clearInterval(t));
      }
    })
    .catch((err) => warn(`对端服务启动失败，发现功能未启用: ${err?.message ?? err}`));

  // 2) 入站唤醒：注册一次 webhook 规则，之后每个任务只 dispatch
  setupInbound(ctx, config, log, warn);

  // 3) agent 工具
  registerTools(ctx, { discovery, config, inbound, outbound, log, warn });

  // 4) UI 接口
  registerUiRoutes(ctx, { discovery, config, identity, inbound, outbound, log, warn });

  ctx.effect(() => () => {
    discovery.stop();
    log("已停止");
  });
}

function machineOf(discovery) {
  return discovery.selfRecord().machine;
}

/**
 * 按"机器名 / 实例 id / ip:port"查找对端，返回**所有**匹配。
 * 名字是用户手填的，可能重复，所以调用方必须处理多匹配的情况 ——
 * 随便挑一台会把任务派到错的机器上。
 */
function findPeersByName(discovery, name) {
  const q = String(name ?? "").trim();
  if (!q) return [];
  return discovery.peers().filter(
    (p) => p.machine === q || p.id === q || `${p.host}:${p.port}` === q,
  );
}

// ───────────────────────── 入站唤醒（webhookRuntime） ─────────────────────────

function setupInbound(ctx, config, log, warn) {
  ctx.inject(["webhookRuntime"], (scoped) => {
    const runtime = scoped.webhookRuntime ?? scoped.get?.("webhookRuntime");
    if (!runtime || typeof runtime.register !== "function") {
      warn("webhookRuntime 不可用，入站任务只能存进收件箱，无法自动唤醒 agent");
      return;
    }
    const dispose = runtime.register({
      id: RULE_ID,
      kind: RULE_KIND,
      // 每次 dispatch 都会调用，用 delivery 里的内容现算请求
      run: (delivery) => ({
        workspacePath: resolveWorkspace(config),
        title: `Mesh 任务 ${String(delivery.deliveryId).slice(0, 14)} ← ${delivery.source}`,
        prompt: buildPrompt(delivery),
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
      }),
    });
    scoped.effect(() => () => void dispose(), "mesh.webhook-rule");
    log("入站唤醒已就绪（webhookRuntime 规则已注册）");
  });
}

function resolveWorkspace(config) {
  if (config.workspaceRoot && isAbsolute(config.workspaceRoot)) return config.workspaceRoot;
  return resolve(homedir());
}

function buildPrompt(delivery) {
  const thread = delivery.thread || delivery.deliveryId;
  return [
    `[DSH Mesh 任务 ${delivery.deliveryId}]`,
    `来自: ${delivery.source}${delivery.fromMachine ? ` (${delivery.fromMachine})` : ""}`,
    delivery.thread ? `线程: ${delivery.thread}` : "",
    "",
    String(delivery.task ?? ""),
    "",
    "—— 这是同一局域网内另一台机器上的 agent 派给你的任务。",
    `做完后用 mesh_run 工具把结果回派给 ${delivery.source}（thread 填 ${thread}）。`,
    "不要只在本地回复，对方看不到本会话。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 收到对端任务：优先注入原活跃会话，否则 dispatch 新建会话。 */
function handleInboundTask(ctx, task, inbound, log, warn) {
  const rec = inbound.find((t) => t.id === task.id);

  if (task.originSession) {
    let live;
    try {
      live = ctx.get?.("agents")?.get?.(task.originSession);
    } catch {
      live = undefined;
    }
    if (live && typeof live.followup === "function") {
      try {
        live.followup(
          createUserMessage({
            content: [{ type: "text", text: buildPrompt({ deliveryId: task.id, source: task.from, task: task.task, thread: task.thread, fromMachine: task.fromMachine }) }],
            source: { kind: "webhook", provider: RULE_KIND, source: task.from, deliveryId: task.id, ruleId: RULE_ID },
          }),
        );
        if (rec) rec.status = "injected-live-session";
        log(`任务 ${task.id} 已注入活跃会话 ${task.originSession}`);
        return;
      } catch (err) {
        warn(`注入活跃会话失败，改用新建会话: ${err?.message ?? err}`);
      }
    }
  }

  const runtime = ctx.get?.("webhookRuntime") ?? ctx.webhookRuntime;
  if (!runtime || typeof runtime.dispatch !== "function") {
    if (rec) rec.status = "stored-only";
    warn(`任务 ${task.id} 已入收件箱，但 webhookRuntime 不可用，未唤醒 agent`);
    return;
  }
  try {
    runtime.dispatch({
      kind: RULE_KIND,
      source: task.from,
      deliveryId: task.id,
      receivedAt: Date.now(),
      task: task.task,
      thread: task.thread,
      fromMachine: task.fromMachine,
    });
    if (rec) rec.status = "dispatched";
    log(`任务 ${task.id} 已派发，将新建会话执行`);
  } catch (err) {
    if (rec) rec.status = "dispatch-failed";
    warn(`派发任务 ${task.id} 失败: ${err?.message ?? err}`);
  }
}

// ───────────────────────── 主动发现与保活 ─────────────────────────

/**
 * 扫本网段的固定端口，命中即登记为对端。
 * 这是"组播被挡时"的兜底路径，也是首次连接最快的方式。
 */
async function runScan({ discovery, config, log, warn, signal, reason = "扫描" }) {
  const port = discovery.port;
  if (!port) return { scanned: 0, found: 0 };
  const addresses = candidateAddresses(config.scanRanges ?? []);
  if (addresses.length === 0) return { scanned: 0, found: 0 };

  const ports = [port, ...(config.scanPorts ?? []).filter((p) => p !== port)];
  log(`${reason}: 探测 ${addresses.length} 个地址的 ${ports.join("/")} 端口…`);
  const started = Date.now();
  const found = await scanForPeers({
    ports,
    addresses,
    timeoutMs: config.scanTimeoutMs,
    concurrency: config.scanConcurrency,
    signal,
  });

  let added = 0;
  for (const rec of found) {
    if (discovery.note(rec, rec.sourceAddress)) added += 1;
  }
  const elapsed = Date.now() - started;
  if (found.length > 0) {
    log(`${reason}完成: 命中 ${found.length} 台（新登记 ${added}），耗时 ${elapsed}ms → ${found.map((r) => r.machine).join(", ")}`);
  } else {
    log(`${reason}完成: 未命中，耗时 ${elapsed}ms`);
  }
  return { scanned: addresses.length, found: found.length };
}

/**
 * 定期 ping 已知对端。
 * 这条让"发现"不再依赖组播：即使组播完全不通，只要扫描见过一次，
 * 之后就能靠 ping 维持在线状态、并在对方重启换端口后重新对齐。
 */
async function pingKnownPeers({ discovery, config, warn }) {
  const peers = discovery.peers();
  if (peers.length === 0) return;

  await Promise.all(
    peers.map(async (p) => {
      if (!p.host || !p.port) return;
      try {
        const res = await fetch(`http://${p.host}:${p.port}/mesh/v1/health`, {
          signal: AbortSignal.timeout(Math.min(3000, config.requestTimeoutMs)),
          headers: { accept: "application/json" },
        });
        if (!res.ok) return;
        const body = await res.json();
        if (body?.app === "dsh-mesh" && body.id) {
          // 对方可能重启过、换了端口——以 ping 到的为准
          discovery.note(body, p.host);
        }
      } catch {
        /* ping 不通就让 sweep 按 ttl 标记离线，这里不额外处理 */
      }
    }),
  );
}

// ───────────────────────── 对端 HTTP 服务 ─────────────────────────

function startPeerServer(ctx, { config, discovery, inbound, log, warn }) {
  const send = (res, code, payload) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  };

  // 默认免配对：内网里发现即可连。只有显式开启 requirePairing 才校验配对码。
  const authed = (req) =>
    !config.requirePairing || safeEqual(req.headers["x-dsh-mesh-token"], currentSecret());

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const self = { ...discovery.selfRecord(), instanceId: discovery.instanceId };

    // 免鉴权：只暴露身份，用于连通性探测、主动扫描与配对握手
    if (path === "/mesh/v1/health") return send(res, 200, { ok: true, ...self, requirePairing: config.requirePairing === true });
    if (path === "/mesh/v1/hello") {
      return send(res, 200, {
        ok: true,
        ...self,
        requirePairing: config.requirePairing === true,
        peerPaired: authed(req),
      });
    }

    if (!authed(req)) return send(res, 403, { ok: false, error: "未配对：两台机器的配对码不一致（本机开启了 requirePairing）" });

    if (path === "/mesh/v1/peers") return send(res, 200, { ok: true, peers: discovery.peers() });

    if (path === "/mesh/v1/tasks" && req.method === "GET") {
      return send(res, 200, { ok: true, tasks: inbound.slice(-50).reverse() });
    }

    if (path === "/mesh/v1/task" && req.method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.task !== "string" || !body.task.trim()) {
        return send(res, 400, { ok: false, error: "task 必填" });
      }
      const task = {
        id: body.id || `t-${randomBytes(6).toString("hex")}`,
        from: String(body.from || "unknown"),
        fromMachine: String(body.fromMachine || ""),
        task: body.task,
        thread: body.thread ? String(body.thread) : "",
        originSession: body.originSession ? String(body.originSession) : "",
        workspace: body.workspace ? String(body.workspace) : "",
        receivedAt: new Date().toISOString(),
        sourceAddress: req.socket.remoteAddress,
        status: "accepted",
      };
      const duplicate = inbound.some((t) => t.id === task.id);
      if (!duplicate) {
        inbound.push(task);
        if (inbound.length > MAX_HISTORY) inbound.shift();
      }
      log(`收到任务 ${task.id} 来自 ${task.from}${duplicate ? "（重复，忽略）" : ""}`);
      if (!duplicate) {
        try {
          handleInboundTask(ctx, task, inbound, log, warn);
        } catch (err) {
          warn(`处理入站任务异常: ${err?.message ?? err}`);
        }
      }
      return send(res, 200, { ok: true, id: task.id, duplicate });
    }

    return send(res, 404, { ok: false, error: "not found" });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    const wanted = config.port ?? MESH_DEFAULT_PORT;
    const start = (port, isFallback) => {
      server.once("error", (err) => {
        if (!isFallback && err?.code === "EADDRINUSE") {
          warn(`端口 ${wanted} 被占用，退回随机端口（组播仍可用，但主动扫描扫不到本机）`);
          start(0, true);
          return;
        }
        rejectPromise(err);
      });
      server.listen(port, "0.0.0.0", () => {
        const addr = server.address();
        log(`对端服务监听 0.0.0.0:${addr.port}${isFallback ? "（随机）" : "（固定）"}`);
        ctx.effect(() => () => server.close());
        resolvePromise(addr.port);
      });
    };
    start(wanted, false);
  });
}

function readJson(req) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolvePromise(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolvePromise(null);
      }
    });
    req.on("error", () => resolvePromise(null));
  });
}

// ───────────────────────── agent 工具 ─────────────────────────

function registerTools(ctx, { discovery, config, inbound, outbound, log }) {
  const text = (v) => [{ type: "text", text: v }];

  ctx.tools.register(
    defineTool({
      name: "mesh_peers",
      description:
        "列出局域网内自动发现的其他 DSH 机器（在线状态、地址、系统、用户）。" +
        "派任务前先用它确认目标机器名。",
      parameters: {
        includeOffline: { type: "boolean", description: "是否也列出离线机器，默认 true" },
      },
      output: { schema: { type: "string" }, render: (_a, v) => text(v) },
      async execute(args) {
        const peers = discovery.peers();
        const list = args?.includeOffline === false ? peers.filter((p) => p.online) : peers;
        if (list.length === 0) {
          return (
            "没有发现其他 DSH 机器。\n" +
            "用 mesh_scan 主动扫一次本网段（组播常被路由器/防火墙挡住）。\n" +
            "仍找不到就排查：1) 两台机器是否同一网段 2) 对端是否装了 dsh-plugin-mesh 并已重启 DSH " +
            "3) 对端防火墙是否放行这个 TCP 端口\n" +
            `本机: ${machineOf(discovery)} (${preferredAddress()})`
          );
        }
        const lines = list.map(
          (p) =>
            `${p.online ? "● 在线" : "○ 离线"}  ${p.machine}  ${p.host}:${p.port}  ${p.os}  user=${p.user}`,
        );
        return `发现 ${list.length} 台机器：\n${lines.join("\n")}\n\n本机: ${machineOf(discovery)} (${preferredAddress()})`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mesh_scan",
      description:
        "主动扫描本网段的 mesh 端口，寻找还没被发现的其他 DSH 机器。" +
        "组播被路由器或防火墙挡住时用这个。扫描需要几秒。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => text(v) },
      async execute() {
        const before = discovery.peers().length;
        const r = await runScan({ discovery, config, warn, reason: "agent 触发扫描" });
        const after = discovery.peers();
        const lines = after.map((p) => `${p.online ? "●" : "○"}  ${p.machine}  ${p.host}:${p.port}`).join("\n");
        return (
          `扫描完成：探测 ${r.scanned} 个地址，命中 ${r.found} 台，` +
          `对端总数 ${before} → ${after.length}。\n` +
          (lines || "（仍未发现任何机器）")
        );
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mesh_run",
      description:
        "把一条任务派给局域网内另一台 DSH 机器上的 agent 执行。异步：立刻返回『已派发』，" +
        "不代表已完成。对端会新建一个会话来跑这个任务，完成后会用同样的方式回派结果。",
      parameters: {
        peer: { type: "string", required: true, description: "目标机器名（用 mesh_peers 查）" },
        task: { type: "string", required: true, description: "任务内容，自然语言描述清楚" },
        thread: { type: "string", description: "线程标识，把同一件事的多条消息串起来" },
        workspace: { type: "string", description: "建议对端使用的工作目录（绝对路径）" },
      },
      output: { schema: { type: "string" }, render: (_a, v) => text(v) },
      async execute(args, exec) {
        const peerName = String(args?.peer ?? "").trim();
        const task = String(args?.task ?? "").trim();
        if (!peerName || !task) return "peer 和 task 都必填。";

        const matches = findPeersByName(discovery, peerName);
        if (matches.length === 0) {
          const known = discovery.peers().map((p) => p.machine).join(", ") || "（无）";
          return `找不到机器 ${peerName}。当前发现的是: ${known}`;
        }
        if (matches.length > 1) {
          const list = matches.map((p) => `  ${p.machine} @ ${p.host}:${p.port}`).join("\n");
          return (
            `名字 "${peerName}" 同时匹配到 ${matches.length} 台机器，无法确定目标：\n${list}\n` +
            "请改用 <ip>:<port> 指定，或者给其中一台改个名字（Mesh 页面里可以改）。"
          );
        }
        const target = matches[0];
        if (!target.online) return `机器 ${target.machine} 当前离线，任务未派发。`;

        const id = `t-${randomBytes(6).toString("hex")}`;
        const payload = {
          id,
          from: `${machineOf(discovery)}/${safeUser()}`,
          fromMachine: machineOf(discovery),
          task,
          thread: args?.thread ? String(args.thread) : "",
          workspace: args?.workspace ? String(args.workspace) : "",
          originSession: exec?.agent?.session?.id ? String(exec.agent.session.id) : "",
        };

        const started = Date.now();
        try {
          const res = await fetch(`http://${target.host}:${target.port}/mesh/v1/task`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Dsh-Mesh-Token": currentSecret() },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(config.requestTimeoutMs),
          });
          const body = await res.json().catch(() => ({}));
          outbound.push({ ...payload, toMachine: target.machine, at: new Date().toISOString(), ok: res.ok, status: res.status });
          if (outbound.length > MAX_HISTORY) outbound.shift();

          if (!res.ok) {
            return (
              `派发失败（HTTP ${res.status}）：${body?.error ?? "未知错误"}\n` +
              (res.status === 403 ? "对端开启了 requirePairing 且两端配对码不一致 —— 在插件页面的「配对码」里对齐。" : "")
            );
          }
          return (
            `已派发给 ${target.machine}，任务 id = ${id}，耗时 ${Date.now() - started}ms。\n` +
            "注意：这只代表对方已接收。对端 agent 会在它自己的会话里执行，完成后会把结果回派给你。"
          );
        } catch (err) {
          outbound.push({ ...payload, toMachine: target.machine, at: new Date().toISOString(), ok: false, error: String(err?.message ?? err) });
          return `派发失败：${err?.name === "TimeoutError" ? "超时" : err?.message ?? err}`;
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mesh_tasks",
      description: "查看本机收到的 mesh 任务（对端派来的）和本机派出去的记录。",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => text(v) },
      async execute() {
        const fmt = (t) => `  [${t.id}] ${t.status}  ${t.from ?? t.toMachine} — ${String(t.task).slice(0, 70)}`;
        const inc = inbound.slice(-20).reverse().map(fmt).join("\n") || "  （无）";
        const out = outbound.slice(-20).reverse().map(fmt).join("\n") || "  （无）";
        return `本机收到的任务:\n${inc}\n\n本机派出的任务:\n${out}`;
      },
    }),
  );

  log("已注册工具 mesh_peers / mesh_run / mesh_tasks");
}

// ───────────────────────── UI 接口（本地回环） ─────────────────────────

function registerUiRoutes(ctx, { discovery, config, identity, inbound, outbound, log, warn }) {
  const send = (res, code, payload) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  };

  const route = (path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: "exact",
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res);
          } catch (err) {
            warn(`UI 路由 ${path} 异常: ${err?.message ?? err}`);
            if (!res.headersSent) send(res, 500, { ok: false, error: String(err?.message ?? err) });
          }
        },
      }),
    );

  /** 返回 { peer } 或 { error }，避免撞名时静默挑错机器 */
  const findPeer = (name) => {
    const matches = findPeersByName(discovery, name);
    if (matches.length === 0) return { error: `找不到机器 ${name}` };
    if (matches.length > 1) {
      return { error: `名字 "${name}" 匹配到 ${matches.length} 台机器，请用 <ip>:<port> 指定` };
    }
    return { peer: matches[0] };
  };

  /** 重名检测：名字是人手填的，撞名会让 mesh_run --peer 有歧义 */
  const duplicateNames = () => {
    const counts = new Map();
    for (const p of discovery.peers()) counts.set(p.machine, (counts.get(p.machine) ?? 0) + 1);
    counts.set(identity.name, (counts.get(identity.name) ?? 0) + 1); // 算上自己
    return [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
  };

  const state = () => ({
    ok: true,
    self: {
      machine: identity.name,
      machineSource: identity.source,
      needsName: identity.source === "hostname",
      hostname: hostname(),
      host: preferredAddress(),
      port: discovery.port,
      instanceId: discovery.instanceId,
      addresses: lanIPv4Addresses(),
      platform: platform(),
      version: VERSION,
      secret: currentSecret(),
    },
    config: {
      agentPreset: config.agentPreset,
      permissionPreset: config.permissionPreset,
      workspaceRoot: config.workspaceRoot,
      peerTtlMs: config.peerTtlMs,
      announceIntervalMs: config.announceIntervalMs,
      requirePairing: config.requirePairing === true,
      useMulticast: config.useMulticast !== false,
      scanOnStart: config.scanOnStart !== false,
      scanIntervalMs: config.scanIntervalMs,
      pingIntervalMs: config.pingIntervalMs,
      scanRanges: config.scanRanges ?? [],
    },
    peers: discovery.peers(),
    duplicateNames: duplicateNames(),
    inbound: inbound.slice(-30).reverse(),
    outbound: outbound.slice(-30).reverse(),
  });

  route("/mesh/api/state", (_req, res) => send(res, 200, state()));

  // 首次启动的"起名"接口：存进 state.json，并立刻重新广播
  route("/mesh/api/name", async (req, res) => {
    const body = await readJson(req);
    let name;
    try {
      name = validateMachineName(body?.name);
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
    if (identity.source === "config") {
      return send(res, 409, {
        ok: false,
        error: "名字由插件配置里的 machineName 指定；要改请改配置，页面上的修改会被配置覆盖。",
      });
    }
    const previous = identity.name;
    saveState({ machineName: name });
    identity.name = name;
    identity.source = "saved";
    discovery.setMachine(name);
    log(`机器名已从 "${previous}" 改为 "${name}"，已重新广播`);
    send(res, 200, { ok: true, name, previous });
  });

  route("/mesh/api/refresh", (_req, res) => {
    discovery.announceNow();
    send(res, 200, { ok: true });
  });

  route("/mesh/api/scan", async (_req, res) => {
    try {
      const result = await runScan({ discovery, config, log, warn, reason: "手动扫描" });
      send(res, 200, { ok: true, ...result, peers: discovery.peers() });
    } catch (err) {
      send(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });

  route("/mesh/api/secret", async (req, res) => {
    const body = await readJson(req);
    const secret = String(body?.secret ?? "").trim();
    if (secret.length < 16) return send(res, 400, { ok: false, error: "配对码至少 16 个字符" });
    saveState({ secret });
    discovery.announceNow();
    log("配对码已更新");
    send(res, 200, { ok: true });
  });

  route("/mesh/api/send", async (req, res) => {
    const body = await readJson(req);
    const peerName = String(body?.peer ?? "").trim();
    const task = String(body?.task ?? "").trim();
    if (!peerName || !task) return send(res, 400, { ok: false, error: "peer 和 task 必填" });
    const found = findPeer(peerName);
    if (found.error) return send(res, found.error.startsWith("名字") ? 409 : 404, { ok: false, error: found.error });
    const target = found.peer;

    const id = `t-${randomBytes(6).toString("hex")}`;
    const payload = {
      id,
      from: `${machineOf(discovery)}/${safeUser()}`,
      fromMachine: machineOf(discovery),
      task,
      thread: body?.thread ? String(body.thread) : "",
      workspace: body?.workspace ? String(body.workspace) : "",
    };
    try {
      const r = await fetch(`http://${target.host}:${target.port}/mesh/v1/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dsh-Mesh-Token": currentSecret() },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      const rb = await r.json().catch(() => ({}));
      outbound.push({ ...payload, toMachine: target.machine, at: new Date().toISOString(), ok: r.ok, status: r.status });
      if (outbound.length > MAX_HISTORY) outbound.shift();
      return send(res, r.ok ? 200 : 502, { ok: r.ok, id, error: rb?.error });
    } catch (err) {
      return send(res, 502, { ok: false, error: String(err?.message ?? err) });
    }
  });

  route("/mesh/api/probe", async (req, res) => {
    const body = await readJson(req);
    const found = findPeer(String(body?.peer ?? "").trim());
    if (found.error) return send(res, 404, { ok: false, error: found.error });
    const target = found.peer;
    try {
      const r = await fetch(`http://${target.host}:${target.port}/mesh/v1/hello`, {
        headers: { "X-Dsh-Mesh-Token": currentSecret() },
        signal: AbortSignal.timeout(6000),
      });
      const rb = await r.json().catch(() => ({}));
      return send(res, 200, { ok: true, reachable: r.ok, paired: rb?.peerPaired === true, remote: rb });
    } catch (err) {
      return send(res, 200, { ok: true, reachable: false, paired: false, error: String(err?.message ?? err) });
    }
  });

  log("UI 接口已挂载: /mesh/api/state|refresh|secret|send|probe");
}
