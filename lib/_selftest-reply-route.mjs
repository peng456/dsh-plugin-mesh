/** Real tool → loopback HTTP → inbound routing; agents are inert test doubles.
 * No DSH installation, model calls, multicast, or external network required.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey } from "./conversation.js";

// Node 20 + Linux：这个套件会**稳定地** SIGSEGV（V8 在「两个 vm.SourceTextModule
// 上下文 + 原生 ESM 链接」这条路径上的上游 bug，2026-10-31 连续两次 CI 复现；
// 同版本的 macOS 和 Node 22/24 的 Linux 都正常）。段错误发生在任何断言之前，
// 进程里捕获不了，所以只能按环境跳过 —— 同样的行为由 node 24 gate 和
// node 22 的 linux portability 任务覆盖，其它 suite 在 node 20 上照常跑。
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (process.platform === "linux" && NODE_MAJOR === 20) {
  console.log("skip: Node 20 on Linux 在 vm.SourceTextModule 双上下文下会 SIGSEGV（上游 V8 bug）");
  console.log("      该套件由 Node 22（linux portability）与 Node 24 gate 覆盖");
  process.exit(0);
}

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
  const module = new vm.SourceTextModule(entrySource + "\nexport { registerTools, startPeerServer, dispatchTaskToPeer };", {
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
  // 一键关闭的门面：这里用可观测的替身，验证工具的参数处理与回报文案；
  // 真正的停/启逻辑由 applyUnsafe 的运行时 + /mesh/api/switch 承担。
  node.switchCalls = [];
  node.switchStatus = () => ({
    lan: { off: false, active: true, bind: "0.0.0.0", port: node.port, multicast: false, note: "" },
    internet: { off: false, active: false, running: 0, configured: 0, note: "" },
    all: false,
    at: "",
    by: "",
    summary: "局域网 开启 · 互联网 开启",
  });
  const meshSwitch = {
    status: () => node.switchStatus(),
    set: async (opts) => {
      node.switchCalls.push(opts);
      return { changed: true, scope: opts.scope, status: node.switchStatus() };
    },
  };
  const options = { ...node, discovery, config: node.config, log: noop, warn: noop, waker, meshSwitch, capFor: () => node.config.maxWakesPerThread, capOverrides: new Map(), throttled: new Map() };
  // startPeerServer 现在返回句柄（一键关闭要重绑监听地址），端口在 handle.port 上。
  node.options = options;
  node.dispatch = (input) => module.namespace.dispatchTaskToPeer(options, input);
  const handle = await module.namespace.startPeerServer(ctx, options);
  node.port = handle.port;
  node.server = handle.server;
  cleanups.push(() => handle.server.close());
  node.gate = module.namespace.transportGate;
  module.namespace.registerTools(ctx, options);
  node.peer = { machine, id: machine, online: true, host: "127.0.0.1", port: node.port,
    endpoints: [{ transport: "lan", host: "127.0.0.1", port: node.port, lastSeen: Date.now() }] };
  node.send = (peer, thread, sessionId, extra = {}) => node.tools.get("mesh_run").execute(
    { peer, thread, task: taskText, ...extra }, { agent: { session: { id: sessionId } } },
  );
  return node;
}

/**
 * 一键关闭的入站闸门必须真有牙：gate 关掉后连 health 都要 503，
 * 打开后立刻恢复。这条同时守住"别只改界面不改后端"。
 */
async function probeHealth(node) {
  const res = await fetch(`http://127.0.0.1:${node.port}/mesh/v1/health`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
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

  // 人发起的派发（聊天窗口 @ 设备）→ 对端回执即使标了 noWake 也必须投递。
  //
  // 真机 2026-10-30：dshgo-dsh 把"机器状态回报"当成回执发了 noWake，结果
  // 停在 noted-only，会话里一个字都看不到 —— 用户等着的答案被"只记录"吞了。
  // 闸门该拦的是 agent 互刷的寒暄，不是人问的问题的答案。
  const humanDispatch = await a.dispatch({
    id: "t-human-1",
    target: b.peer,
    task: "查一下你的机器负载，内存网络等",
    thread: "at-t-human-1",
    originSession: "original-session",
    human: true,
  });
  assert.equal(humanDispatch.ok, true, JSON.stringify(humanDispatch));
  await until(() => ["dispatched", "injected-thread-session"].includes(b.inbound.at(-1)?.status));
  const humanReplyBefore = original.messages.length;
  // 对端 agent 的回执从它为本任务建的那个会话来发（originSession 必须与
  // 它本机绑定的会话一致，否则 mesh_run 会拒绝跨会话派发）。
  const humanSession = [...b.agents.keys()].at(-1);
  assert.match(String(humanSession), /^mesh-B-/, "对端应当为本任务建了会话");
  const humanSendText = await b.send("A", "at-t-human-1", humanSession, { noWake: true });
  assert.match(String(humanSendText), /已派发/, String(humanSendText));
  const humanReplyRec = a.inbound.at(-1);
  assert.equal(humanReplyRec.thread, "at-t-human-1");
  assert.notEqual(humanReplyRec.status, "noted-only", "人发起派发的回执不能被「仅记录」吞掉");
  await until(() => original.messages.length > humanReplyBefore);
  assert.equal(a.created, 1, "回执要注入原会话，不能再新建会话");
  console.log("✓ noWake reply to a human-initiated dispatch still lands in the live session");

  // 但 agent 之间没有 human 标记的 noWake 回执，仍然只记录（循环刹车不能被拆）。
  const agentReplyBefore = original.messages.length;
  const sentAgent = await a.dispatch({
    id: "t-agent-1",
    target: b.peer,
    task: "agent 之间的例行核对：这是一条没有 human 标记的普通长任务文本",
    thread: "agent-thread-1",
    originSession: "original-session",
  });
  assert.equal(sentAgent.ok, true);
  await until(() => ["dispatched", "injected-thread-session"].includes(b.inbound.at(-1)?.status));
  const agentSession = [...b.agents.keys()].at(-1);
  assert.match(String(await b.send("A", "agent-thread-1", agentSession, { noWake: true })), /已派发/);
  assert.equal(a.inbound.at(-1).status, "noted-only");
  assert.equal(original.messages.length, agentReplyBefore, "agent 互刷的 noWake 仍然不唤醒");
  console.log("✓ agent-originated noWake replies stay recorded-only");

  // 一键关闭的工具面：三个范围、默认关闭、不认识的范围要明确报错。
  const switchTool = b.tools.get("mesh_switch");
  assert.ok(switchTool, "必须注册 mesh_switch");
  const offText = await switchTool.execute({ scope: "局域网", action: "off" });
  assert.match(offText, /局域网 mesh已关闭/, offText);
  assert.match(offText, /当前：局域网 开启/, offText);
  // 注意：工具在 vm 里执行，跨 realm 的对象原型不同，不能 deepStrictEqual
  assert.equal(b.switchCalls.at(-1).scope, "lan");
  assert.equal(b.switchCalls.at(-1).off, true);
  assert.equal(b.switchCalls.at(-1).by, "tool");
  await switchTool.execute({ scope: "all" });
  assert.equal(b.switchCalls.at(-1).off, true, "action 省略时默认关闭");
  const onText = await switchTool.execute({ scope: "internet", action: "on" });
  assert.equal(b.switchCalls.at(-1).off, false);
  assert.match(onText, /互联网 mesh已打开/, onText);
  assert.match(await switchTool.execute({ scope: "wifi" }), /scope 不合法/);
  assert.match(await switchTool.execute({ scope: "lan", action: "shutdown" }), /action 不合法/);
  assert.match(await b.tools.get("mesh_peers").execute({}), /开关: 局域网 开启/, "mesh_peers 要带上开关状态");

  // 全部关闭时，派发与扫描都必须直接拒绝并说明原因（不是"对端离线"）。
  b.switchStatus = () => ({
    lan: { off: true, active: false, bind: "", port: 0, multicast: false, note: "" },
    internet: { off: true, active: false, running: 0, configured: 0, note: "" },
    all: true,
    at: "",
    by: "tool",
    summary: "mesh 已全部关闭（局域网 + 互联网）",
  });
  assert.match(await b.send("A", "closed", "mesh-B-1"), /已全部关闭/);
  assert.match(await b.tools.get("mesh_scan").execute({}), /已全部关闭/);
  assert.match(await b.tools.get("mesh_peers").execute({}), /已全部关闭/);
  assert.doesNotMatch(await b.tools.get("mesh_peers").execute({}), /^没有发现其他 DSH 机器/, "关闭导致的空列表不能说成「没发现」");
  console.log("✓ mesh_switch: scopes, default off, invalid input, and closed-state refusals");

  // 一键关闭：入站闸门要对 health 也生效，打开后立刻恢复。
  a.gate.lan = false;
  const closed = await probeHealth(a);
  assert.equal(closed.status, 503, "局域网关闭后，对端健康探测必须被拒绝");
  assert.equal(closed.body.closed, true);
  assert.match(String(closed.body.error || ""), /局域网 mesh 已关闭/);
  a.gate.lan = true;
  const reopened = await probeHealth(a);
  assert.equal(reopened.status, 200, "打开后必须恢复");
  assert.equal(reopened.body.ok, true);
  console.log("✓ kill switch closes the inbound peer API and reopens it");

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
