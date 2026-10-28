/** Real tool → loopback HTTP → inbound routing; agents are inert test doubles.
 * No DSH installation, model calls, multicast, or external network required.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey } from "./conversation.js";
import { __setDshGoForTest, __resetDshGoCacheForTest } from "./dshgo.js";

const root = mkdtempSync(join(tmpdir(), "mesh-reply-test-"));
const cleanups = [];
const entryUrl = new URL("./index.js", import.meta.url);
let entrySource = readFileSync(entryUrl, "utf8");
// Mutation guard: prove the HTTP roundtrip fails with the original missing bind.
if (process.env.MESH_TEST_WITHOUT_REPLY_BINDING === "1") {
  entrySource = entrySource.replace("if (replyKey && payload.originSession)", "if (false)");
}
entrySource = entrySource.replace(
  'async function wakeAgent(waker, config, task, warn = () => {}) {',
  'async function wakeAgent(waker, config, task, warn = () => {}) { return waker.runtime.wake();',
);
const noop = () => {};
const taskText = "Please complete this deterministic routing test without calling any model.";

async function makeNode(machine) {
  const home = join(root, machine);
  mkdirSync(join(home, "mesh"), { recursive: true });
  writeFileSync(join(home, "mesh", "state.json"), JSON.stringify({ secret: "test-only-shared-secret" }));
  const node = { machine, home, peers: [], tools: new Map(), agents: new Map(), inbound: [], outbound: [], threadState: new Map(), hostDispatched: new Map(), created: 0, sent: 0 };
  const context = vm.createContext({
    console, Buffer, URL, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { ...process, env: { ...process.env, DSH_HOME: home } },
    fetch: async (...args) => {
      node.sent++;
      if (node.fetchOverride) return node.fetchOverride(...args);
      const response = await fetch(...args);
      if (node.beforeAck) { const hook = node.beforeAck; node.beforeAck = undefined; await hook(); }
      return response;
    },
  });
  const schema = new Proxy(() => schema, { get: () => schema });
  const mocks = {
    "@deepseek-ai/schemastery": { default: schema },
    "@deepseek-ai/dsh-brand": { brandString: (value) => value },
    "@deepseek-ai/dsh-tools": { defineTool: (tool) => tool },
    "@deepseek-ai/dsh-llm": { createUserMessage: (message) => message },
  };
  const module = new vm.SourceTextModule(entrySource + "\nexport { registerTools, startPeerServer, permissionPresetFor };", {
    context, identifier: entryUrl.href, initializeImportMeta: (meta) => { meta.url = entryUrl.href; },
  });
  await module.link(async (specifier) => {
    const exports = mocks[specifier] ?? await import(specifier.startsWith(".") ? new URL(specifier, entryUrl).href : specifier);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const key of Object.keys(exports)) this.setExport(key, exports[key]);
    }, { context });
  });
  await module.evaluate();
  const ctx = {
    get: (name) => name === "agents" ? node.agents : undefined,
    effect: (fn) => cleanups.push(fn()),
    tools: { register: (tool) => node.tools.set(tool.name, tool) },
  };
  const discovery = {
    instanceId: machine, peers: () => node.peers,
    selfRecord: () => ({ machine, id: machine, host: "127.0.0.1", port: node.port }),
  };
  node.config = { port: 0, requestTimeoutMs: 500, requirePairing: true, minTaskChars: 24, maxWakesPerThread: 30, threadCooldownMs: 5000, threadWindowMs: 3600000 };
  const waker = { ready: true, ctx, runtime: { wake: async () => {
    const id = `mesh-${machine}-${++node.created}`;
    node.agents.set(id, { messages: [], followup(message) { this.messages.push(message); } });
    return id;
  } } };
  const options = { ...node, discovery, config: node.config, log: noop, warn: noop, waker, capFor: () => node.config.maxWakesPerThread, capOverrides: new Map(), throttled: new Map() };
  node.port = await module.namespace.startPeerServer(ctx, options);
  module.namespace.registerTools(ctx, options);
  // P1-0：暴露 index.js 里真正的入站权限选择函数 —— 会话创建时传给
  // permissionPresets.set() 的就是它的返回值，这里直接断言"传进去的是什么"。
  node.permissionPresetFor = module.namespace.permissionPresetFor;
  node.peer = { machine, id: machine, online: true, host: "127.0.0.1", port: node.port,
    endpoints: [{ transport: "lan", host: "127.0.0.1", port: node.port, lastSeen: Date.now() }] };
  node.send = (peer, thread, sessionId, extra = {}) => node.tools.get("mesh_run").execute(
    { peer, thread, task: taskText, ...extra }, { agent: { session: { id: sessionId } } },
  );
  return node;
}

async function until(check) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("routing did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  const a = await makeNode("A");
  const b = await makeNode("B");
  a.peers.push(b.peer); b.peers.push(a.peer);
  const original = { messages: [], followup(message) { this.messages.push(message); } };
  a.agents.set("original-session", original);
  const key = (thread) => conversationKey({ fromMachine: "B", thread });
  const disk = () => JSON.parse(readFileSync(join(a.home, "mesh", "threads.json"), "utf8"));

  // P0：/mesh/v1/health 必须带"地址探测摘要 + sidecarPlatform"（diag），且不能被
  // 探测失败打成 500。这里的 fake discovery 没有 netInfo()，正好顺带验证兜底；
  // 真实 MeshDiscovery 有 netInfo()，会给出 source/errors。
  const health = await (await fetch(`http://127.0.0.1:${a.port}/mesh/v1/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.diag?.net?.source, "string", "health 应带地址探测来源");
  assert.equal(typeof health.diag?.net?.macsAvailable, "boolean");
  assert.equal(health.diag?.sidecarPlatform, "auto");
  console.log("✓ /mesh/v1/health carries net diag (source/macsAvailable) + sidecarPlatform");

  // P1-0（真机阻塞项）：入站会话用的是 permissionPresetFor() 的返回值 ——
  // 这里直接断言"会话创建时会传进 permissionPresets.set() 的那个值"。
  // dsh-go 上没有沙箱后端，默认 workspace-write = approval:ask → 每个入站任务
  // 停在「待确认」；配了 permissionPresetOnDshGo 必须覆盖成 danger-full-access。
  const defaultInbound = { ...a.config, permissionPreset: "workspace-write", tsnetPermissionPreset: "", permissionPresetOnDshGo: "danger-full-access" };
  try {
    __resetDshGoCacheForTest();
    assert.equal(a.permissionPresetFor(defaultInbound, { transport: "lan" }), "workspace-write", "非 dsh-go 上不得改变既有语义");
    __setDshGoForTest({ isDshGo: true, runtime: "proot" });
    assert.equal(a.permissionPresetFor(defaultInbound, { transport: "lan" }), "danger-full-access", "dsh-go 上必须用覆盖值");
    assert.equal(
      a.permissionPresetFor({ ...defaultInbound, permissionPresetOnDshGo: "" }, { transport: "lan" }),
      "danger-full-access",
      "dsh-go 上覆盖值为空 → 内置默认 danger-full-access（proot 无沙箱后端，无人值守的前提）",
    );
    // 用户显式设了更严格的值时不擅自升级（尊重意图）
    assert.equal(
      a.permissionPresetFor({ ...defaultInbound, permissionPresetOnDshGo: "", permissionPreset: "read-only" }, { transport: "lan" }),
      "read-only",
      "dsh-go 上用户显式 read-only 不得被升级",
    );
    // health 的 diag 也要能读到"入站会用哪个权限"，排障时不用猜。
    const health2 = await (await fetch(`http://127.0.0.1:${a.port}/mesh/v1/health`)).json();
    assert.ok(health2.diag?.dshGo, "health diag 应带 dsh-go 判定");
    assert.equal(typeof health2.diag?.inboundPermissionPreset, "string");
    assert.ok(health2.diag?.sidecarTarget, "health diag 应带 sidecar 目标资产");
  } finally {
    __resetDshGoCacheForTest();
  }
  console.log("✓ inbound permission preset: dsh-go override + diag exposure (P1-0)");

  // First dispatch: persistence must be visible before B returns any reply.
  assert.match(await a.send("B", "roundtrip", "original-session"), /已派发/);
  assert.equal(disk().threads[key("roundtrip")].sessionId, "original-session");
  await until(() => b.inbound.at(-1)?.status === "dispatched");
  assert.match(await b.send("A", "roundtrip", "mesh-B-1"), /已派发/);
  assert.equal(original.messages.length, 1);
  assert.equal(a.inbound.at(-1).status, "injected-thread-session");
  assert.equal(a.created, 0, "reply must not create a new A session");
  console.log("✓ real mesh_run/HTTP roundtrip: original session receives reply, zero new A sessions");

  // 宿主（页面派发）已经替用户发过同一 thread：绑定会话里的 agent 再调 mesh_run
  // 就是对端收两份，必须在 HTTP 之前挡住。这条也顺带守住 hostDispatched 的作用域
  // —— 它曾经只在 applyUnsafe 里声明，而用点在 registerTools/registerUiRoutes，
  // 结果每次带 thread 的 mesh_run 都抛 ReferenceError（真机 + 本测试都撞上）。
  a.hostDispatched.set("host-thread", Date.now());
  a.threadState.set(key("host-thread"), { sessionId: "original-session", wakesAt: [] });
  const sentBeforeGuard = a.sent;
  assert.match(await a.send("B", "host-thread", "original-session"), /已经由宿主发出去/);
  assert.equal(a.sent, sentBeforeGuard, "被挡下的重复派发不能真的发出 HTTP");
  console.log("✓ host-dispatched thread is refused in the bound session, no duplicate HTTP");

  // Very fast return before the sending tool receives its acknowledgement.
  a.beforeAck = async () => {
    assert.equal(disk().threads[key("fast")].sessionId, "original-session");
    await until(() => b.inbound.at(-1)?.status === "dispatched");
    assert.match(await b.send("A", "fast", "mesh-B-2"), /已派发/);
  };
  await a.send(`${b.peer.host}:${b.port}`, "fast", "original-session");
  assert.equal(original.messages.length, 2);
  assert.equal(a.created, 0);
  console.log("✓ early reply and ip:port target resolve to the peer's machine name");

  // Conflicting origin must be refused before HTTP; do not silently steal replies.
  const sentBefore = a.sent;
  assert.match(await a.send("B", "roundtrip", "another-session"), /任务未派发.*另一会话/);
  assert.equal(a.sent, sentBefore);
  assert.equal(a.threadState.get(key("roundtrip")).sessionId, "original-session");

  // Delivery uncertainty must not erase the destination of a late reply.
  a.fetchOverride = async () => { throw new Error("simulated timeout after possible delivery"); };
  assert.match(await a.send("B", "uncertain", "original-session"), /派发失败/);
  assert.equal(disk().threads[key("uncertain")].sessionId, "original-session");
  a.fetchOverride = undefined;
  console.log("✓ conflict refused; uncertain delivery keeps late-reply route");

  // Existing inbound gates and explicit newSession remain in force.
  await b.send("A", "roundtrip", "mesh-B-1", { noWake: true });
  assert.equal(a.inbound.at(-1).status, "noted-only");
  assert.equal(original.messages.length, 2);
  a.config.maxWakesPerThread = 1;
  await b.send("A", "roundtrip", "mesh-B-1");
  assert.equal(a.inbound.at(-1).status, "throttled");
  a.config.maxWakesPerThread = 30;
  a.config.threadCooldownMs = 0;
  await b.send("A", "roundtrip", "mesh-B-1", { newSession: true });
  await until(() => a.inbound.at(-1).status === "dispatched");
  assert.equal(a.created, 1);
  console.log("✓ noWake, wake cap and explicit newSession still apply");

  // Missing thread or originating session must not create a reply binding.
  const bindings = a.threadState.size;
  await a.send("B", "", "original-session", { noWake: true });
  await a.send("B", "no-origin", "", { noWake: true });
  assert.equal(a.threadState.size, bindings);
  console.log("✓ absent thread/session does not bind");
} finally {
  for (const cleanup of cleanups.reverse()) cleanup?.();
  rmSync(root, { recursive: true, force: true });
}
