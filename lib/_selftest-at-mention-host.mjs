/**
 * 聊天窗口 @ 派发（宿主侧）的端到端自测。
 *
 * 与 _selftest-reply-route.mjs 同一套手法：把 lib/index.js 放进 VM 里加载，
 * 用假对端 HTTP 服务收包，驱动真实的 `agent/pre-step` 监听器 —— 不装 DSH、
 * 不调模型、不出网。
 *
 * 盯住的是「静默失败」最容易发生的那几处：
 *   · 消息开头的 @目标 真的变成了一次 POST，正文被完整带过去；
 *   · 改写后的消息明确说「已派发 / 未派发」，不会让 agent 在本机重做一遍；
 *   · 离线 / 同名歧义 / 只有 @ 没正文 → 不发包，但原因必须写出来；
 *   · 同一条消息被 pre-step 拿到两次 → 只派发一次；
 *   · 正文中间的 @ 不自动派发。
 *
 *   node --experimental-vm-modules lib/_selftest-at-mention-host.mjs
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey } from "./conversation.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "mesh-at-test-"));
mkdirSync(join(root, "mesh"), { recursive: true });
writeFileSync(join(root, "mesh", "state.json"), JSON.stringify({ secret: "test-only-shared-secret" }));

// ── 假对端：收 /mesh/v1/task ──
const posts = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }
    posts.push({ url: req.url, token: req.headers["x-dsh-mesh-token"], body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const peerPort = server.address().port;

// ── 在 VM 里加载 lib/index.js，并暴露要测的内部函数 ──
const entryUrl = new URL("./index.js", import.meta.url);
const entrySource =
  readFileSync(entryUrl, "utf8") +
  "\nexport { registerAtMentions, dispatchTaskToPeer, resolvePeerTarget, classifyInbound };\n";

const context = vm.createContext({
  console,
  Buffer,
  URL,
  AbortSignal,
  AbortController,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch,
  process: { ...process, env: { ...process.env, DSH_HOME: root } },
});
const schema = new Proxy(() => schema, { get: () => schema });
const mocks = {
  "@deepseek-ai/schemastery": { default: schema },
  "@deepseek-ai/dsh-brand": { brandString: (value) => value },
  "@deepseek-ai/dsh-tools": { defineTool: (tool) => tool },
  "@deepseek-ai/dsh-llm": { createUserMessage: (message) => message },
};
const module = new vm.SourceTextModule(entrySource, {
  context,
  identifier: entryUrl.href,
  initializeImportMeta: (meta) => {
    meta.url = entryUrl.href;
  },
});
await module.link(async (specifier) => {
  const exports = mocks[specifier] ?? (await import(specifier.startsWith(".") ? new URL(specifier, entryUrl).href : specifier));
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const key of Object.keys(exports)) this.setExport(key, exports[key]);
    },
    { context },
  );
});
await module.evaluate();
const { registerAtMentions, resolvePeerTarget, classifyInbound } = module.namespace;

// ── 假环境 ──
const peer = (machine, extra = {}) => ({
  id: `id-${machine}`,
  machine,
  online: true,
  host: "127.0.0.1",
  port: peerPort,
  transport: "lan",
  endpoints: [{ transport: "lan", host: "127.0.0.1", port: peerPort, lastSeen: Date.now() }],
  ...extra,
});

function makeHarness({ peers = [peer("mac")], atDispatch = true, allOff = false } = {}) {
  const logs = [];
  const warns = [];
  const outbound = [];
  const threadState = new Map();
  const listeners = new Map();
  const ctx = {
    on: (name, fn, opts) => {
      listeners.set(name, { fn, opts });
      return () => listeners.delete(name);
    },
  };
  const deps = {
    discovery: {
      peers: () => peers,
      selfRecord: () => ({ machine: "me", id: "me", host: "127.0.0.1", port: 0 }),
    },
    identity: { name: "me" },
    config: { atDispatch, requestTimeoutMs: 2000 },
    outbound,
    threadState,
    hostDispatched: new Map(),
    log: (m) => logs.push(String(m)),
    warn: (m) => warns.push(String(m)),
    onHistoryChange: () => {},
    meshSwitch: { status: () => ({ all: allOff }) },
  };
  registerAtMentions(ctx, deps);
  const listener = listeners.get("agent/pre-step")?.fn;
  /**
   * 跑一次 pre-step：喂一条 user 消息，返回模型将看到的消息列表。
   */
  async function step(text, { agentSession = "s-1", id = `msg-${Math.random()}`, role } = {}) {
    assert.ok(listener, "agent/pre-step 监听器没有注册");
    const message = role || {
      id,
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text }],
    };
    const next = async () => ({ kind: "enter", messages: [message] });
    const decision = await listener({ agent: { session: { id: agentSession } }, signal: new AbortController().signal }, next);
    return { decision, message };
  }
  return { deps, listener, step, logs, warns, outbound, threadState };
}

const textOf = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

console.log("\n── 正常路径：开头 @在线机器 → 真的发出去 ──");

await test("派发一次 POST：完整正文、带配对码、thread 绑定到当前会话", async () => {
  posts.length = 0;
  const h = makeHarness();
  const { decision } = await h.step("@mac 看看磁盘空间");
  assert.equal(posts.length, 1, "应当正好发一条");
  const post = posts[0];
  assert.equal(post.url, "/mesh/v1/task");
  assert.equal(post.token, "test-only-shared-secret");
  assert.equal(post.body.task, "看看磁盘空间", "正文必须去掉 @目标");
  assert.equal(post.body.originSession, "s-1", "回执要落回当前会话");
  assert.equal(post.body.human, true, "聊天窗口 @ 是人敲的，要带 human 标记（对端才不会被长度闸门吞掉）");
  assert.match(post.body.thread, /^at-t-[0-9a-f]+$/, `thread 形态：${post.body.thread}`);
  assert.equal(h.threadState.size, 1, "thread 必须绑定到本机会话");

  const shown = textOf(decision.messages[0]);
  assert.match(shown, /看看磁盘空间/);
  assert.match(shown, /已派发/);
  assert.match(shown, /等待回执/);
  assert.match(shown, /不要调用任何工具/);
  assert.ok(shown.includes(post.body.id), "改写里要带任务 id，方便对账");
});

await test("多个 @目标 → 每个目标各发一次", async () => {
  posts.length = 0;
  const h = makeHarness({ peers: [peer("mac"), peer("hos")] });
  const { decision } = await h.step("@mac @hos 一起看看");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => p.body.task), ["一起看看", "一起看看"]);
  const shown = textOf(decision.messages[0]);
  assert.match(shown, /mac/);
  assert.match(shown, /hos/);
});

await test("同一条消息被 pre-step 拿到两次 → 只派发一次", async () => {
  posts.length = 0;
  const h = makeHarness();
  await h.step("@mac 看看磁盘", { id: "same-id" });
  const second = await h.step("@mac 看看磁盘", { id: "same-id" });
  assert.equal(posts.length, 1, "重复投喂不能重复派发");
  assert.match(textOf(second.decision.messages[0]), /@mac/, "第二次原样放行（不做第二次改写）");
});

console.log("\n── 不该派发 / 必须说出原因 ──");

await test("正文中间的 @ 不自动派发，消息原样放行", async () => {
  posts.length = 0;
  const h = makeHarness();
  const { decision } = await h.step("请让 @mac 看看磁盘");
  assert.equal(posts.length, 0);
  assert.equal(decision.messages[0].content[0].text, "请让 @mac 看看磁盘");
});

await test("未知名字的 @ 不当派发目标（文件引用 / 打错字）", async () => {
  posts.length = 0;
  const h = makeHarness();
  for (const text of ["@AGENTS.md 看看", "@macx hi"]) {
    const { decision } = await h.step(text);
    assert.equal(decision.messages[0].content[0].text, text, `${text} 不该被改写`);
  }
  assert.equal(posts.length, 0);
});

await test("离线机器：不发包，但必须写清「当前离线」且「没有在本机执行」", async () => {
  posts.length = 0;
  const h = makeHarness({ peers: [peer("mac", { online: false })] });
  const { decision } = await h.step("@mac 看看磁盘");
  assert.equal(posts.length, 0, "离线不该发包");
  const shown = textOf(decision.messages[0]);
  assert.match(shown, /当前离线/);
  assert.match(shown, /没有在本机执行/);
});

await test("只有 @ 名字没有正文：不发包，并说明原因", async () => {
  posts.length = 0;
  const h = makeHarness();
  const { decision } = await h.step("@mac");
  assert.equal(posts.length, 0);
  const shown = textOf(decision.messages[0]);
  assert.match(shown, /没有正文/);
});

await test("同名且多台在线：歧义要报出来，不猜目标", async () => {
  posts.length = 0;
  const h = makeHarness({ peers: [peer("mac"), peer("mac", { id: "id-mac-2", port: peerPort + 1 })] });
  const resolved = resolvePeerTarget(h.deps.discovery, "mac");
  assert.match(String(resolved.error || ""), /匹配到 2 台机器/);
  const { decision } = await h.step("@mac 看看磁盘");
  assert.equal(posts.length, 0);
  assert.match(textOf(decision.messages[0]), /匹配到 2 台机器/);
});

await test("一键关闭（全部关）：不发包，并说明是本机自己关的", async () => {
  posts.length = 0;
  const h = makeHarness({ allOff: true });
  const { decision } = await h.step("@mac 看看磁盘");
  assert.equal(posts.length, 0);
  assert.match(textOf(decision.messages[0]), /已全部关闭/);
});

console.log("\n── 开关与作用域 ──");

await test("atDispatch=false → 完全不挂监听器", async () => {
  const h = makeHarness({ atDispatch: false });
  assert.equal(h.listener, undefined);
  assert.ok(h.logs.some((l) => l.includes("已关闭")), "关闭也要留一句话，别让人以为坏了");
});

await test("非 user 来源的消息（对端回执 / 插件注入）不参与 @ 派发", async () => {
  posts.length = 0;
  const h = makeHarness();
  const webhook = {
    id: "w-1",
    role: "user",
    source: { kind: "webhook" },
    content: [{ type: "text", text: "@mac 看看磁盘" }],
  };
  await h.step("@mac 看看磁盘", { role: webhook });
  assert.equal(posts.length, 0);
});

console.log("\n── 对端闸门：人手动派发的短消息不能被吞成「仅记录」──");

const gateConfig = { minTaskChars: 8, maxWakesPerThread: 30, threadWindowMs: 3600000, threadCooldownMs: 5000 };

await test("6 个字的 @ 任务：带 human 时放行（否则就是真机遇到的「仅记录」）", () => {
  const task = { fromMachine: "lipeng-mac", thread: "at-t-1", task: "你的磁盘占用", human: true };
  const verdict = classifyInbound(task, new Map(), gateConfig, Date.now(), () => 30);
  assert.equal(verdict.wake, true, `被判成 ${verdict.kind}: ${verdict.reason}`);
});

await test("同样的短消息，没有 human 标记 → 仍然只入箱（agent 互刷的闸门不能被拆掉）", () => {
  const task = { fromMachine: "lipeng-mac", thread: "at-t-1", task: "你的磁盘占用" };
  const verdict = classifyInbound(task, new Map(), gateConfig, Date.now(), () => 30);
  assert.equal(verdict.wake, false);
  assert.equal(verdict.kind, "short");
  assert.match(verdict.reason, /minTaskChars/);
});

await test("纯寒暄（「收到」）带 human 也放行；不带 human 仍被拦成 notice", () => {
  // minTaskChars 调到 1，让这条只测"寒暄闸门"（默认 8 时它先被长度闸门拦住）。
  const noLengthGate = { ...gateConfig, minTaskChars: 1 };
  const human = classifyInbound({ fromMachine: "a", thread: "t", task: "收到", human: true }, new Map(), noLengthGate, Date.now(), () => 30);
  assert.equal(human.wake, true, `被判成 ${human.kind}: ${human.reason}`);
  const agent = classifyInbound({ fromMachine: "a", thread: "t", task: "收到" }, new Map(), noLengthGate, Date.now(), () => 30);
  assert.equal(agent.wake, false);
  assert.equal(agent.kind, "notice");
});

await test("noWake 的优先级高于 human：显式回执仍不唤醒", () => {
  const verdict = classifyInbound(
    { fromMachine: "a", thread: "t", task: "你的磁盘占用", human: true, noWake: true },
    new Map(),
    gateConfig,
    Date.now(),
    () => 30,
  );
  assert.equal(verdict.wake, false);
  assert.equal(verdict.kind, "noWake");
});

await test("限速闸门对 human 仍然生效（人类也不能把对端刷爆）", () => {
  const now = Date.now();
  const key = conversationKey({ fromMachine: "a", thread: "t" });
  const state = new Map([[key, { wakesAt: Array.from({ length: 3 }, () => now - 1000), sessionId: "s" }]]);
  const verdict = classifyInbound({ fromMachine: "a", thread: "t", task: "看下磁盘和内存", human: true }, state, gateConfig, now, () => 3);
  assert.equal(verdict.wake, false);
  assert.equal(verdict.kind, "cap");
});

console.log("\n── 假对端记录 ──");
await test("派发失败（对端 500）也要改写消息并说出原因", async () => {
  const failing = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "对端内部错误" }));
  });
  await new Promise((resolve) => failing.listen(0, "127.0.0.1", resolve));
  const failPort = failing.address().port;
  const h = makeHarness({
    peers: [
      {
        id: "id-bad",
        machine: "bad",
        online: true,
        host: "127.0.0.1",
        port: failPort,
        transport: "lan",
        endpoints: [{ transport: "lan", host: "127.0.0.1", port: failPort, lastSeen: Date.now() }],
      },
    ],
  });
  const { decision } = await h.step("@bad 看看磁盘");
  const shown = textOf(decision.messages[0]);
  assert.match(shown, /未能派发/);
  assert.match(shown, /对端内部错误/);
  assert.equal(h.outbound.length, 1);
  assert.equal(h.outbound[0].ok, false);
  await new Promise((resolve) => failing.close(resolve));
});

server.close();
rmSync(root, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
