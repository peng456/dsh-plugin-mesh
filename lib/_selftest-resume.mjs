/** 会话恢复路径的单元检查：注入前能否把「已结束但记录还在」的会话接回来。
 *
 * 背景：`liveSession()` 查的是 DSH 内存里的 agent 注册表。重启 DSH 之后注册表是空的，
 * 但磁盘上的对话记录完好无损。原实现直接新建会话，于是每重启一次所有跨机对话线
 * 都静默断开。这里验证新增的 `wakeAgentOrResume` 会先尝试 `agents.resume`。
 *
 * 不联网、不装 DSH：index.js 用 vm 加载，import 被替换成最小 mock。
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey } from "./conversation.js";

const root = mkdtempSync(join(tmpdir(), "mesh-resume-test-"));
const entryUrl = new URL("./index.js", import.meta.url);
const cleanupPaths = [];
const noop = () => {};

const TASK_TEXT = "这张会话在重启前处理过的工作，现在要对端回传结果，测试请勿联网执行任何命令。";

async function loadModule() {
  let source = readFileSync(entryUrl, "utf8");
  // 暴露内部函数（这些不是公开 API，只给测试用）
  source += "\nexport { handleInboundTask };";
  const schema = new Proxy(() => schema, { get: () => schema });
  const mocks = {
    "@deepseek-ai/schemastery": { default: schema },
    "@deepseek-ai/dsh-brand": { brandString: (value) => value },
    "@deepseek-ai/dsh-tools": { defineTool: (tool) => tool },
    "@deepseek-ai/dsh-llm": { createUserMessage: (message) => message },
  };
  const context = vm.createContext({ console, Buffer, URL, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, process });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: entryUrl.href,
    initializeImportMeta: (meta) => { meta.url = entryUrl.href; },
  });
  await module.link(async (specifier) => {
    const exports = mocks[specifier] ?? (await import(specifier.startsWith(".") ? new URL(specifier, entryUrl).href : specifier));
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const key of Object.keys(exports)) this.setExport(key, exports[key]);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

/** 跑一次入站任务，返回本次尝试的结果。 */
async function runInbound(ns, opts = {}) {
  const home = mkdtempSync(join(root, "home-"));
  mkdirSync(join(home, "mesh"), { recursive: true });
  writeFileSync(join(home, "mesh", "state.json"), JSON.stringify({ secret: "s" }));

  const messages = [];
  const resumedIds = [];
  const createdIds = [];
  const warnings = [];

  const makeHandle = (sessionId) => ({
    agent: { session: { id: sessionId }, followup: (m) => messages.push(m) },
    dispose: async () => {},
  });

  const agentApi = {
    resume: opts.withResume === false ? undefined : async ({ resumeSessionId }) => {
      resumedIds.push(resumeSessionId);
      if (opts.resumeFails) throw new Error("session log missing");
      return makeHandle(resumeSessionId);
    },
    create: async ({ sessionId }) => {
      createdIds.push(sessionId);
      return makeHandle(sessionId);
    },
  };

  const liveAgents = new Map();
  const ctx = {
    get: (name) => (name === "agents" ? { get: (id) => liveAgents.get(id), ...agentApi } : undefined),
    effect: () => () => {},
  };
  const services = {
    agentPresets: { resolve: async (id) => ({ id }), standingKeyFor: async () => {}, mount: async () => {} },
    workspaceRegistry: {
      create: async () => ({
        path: home,
        attachSession: async () => {},
        detachSession: async () => {},
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m", reasoningEffort: "low" }) },
    permissionPresets: { set: () => {} },
    sessionTitle: { rename: () => {} },
  };
  // wakeAgent 通过 waker.ctx 取服务（c.agents.create / c.agents.resume 都在这里）
  const wakerCtx = Object.assign(Object.create(ctx), services, {
    get: ctx.get,
    effect: () => () => {},
    agents: agentApi,
  });
  const waker = { ready: true, ctx: wakerCtx, missing: [] };

  const threadState = new Map();
  const thread = "重启前的对话";
  const key = conversationKey({ fromMachine: "B", thread });
  if (opts.boundSessionId) threadState.set(key, { sessionId: opts.boundSessionId, wakesAt: [] });
  if (opts.liveSessionId) liveAgents.set(opts.liveSessionId, { followup: noop });

  const task = {
    id: "t-resume-1",
    from: "B/u",
    fromMachine: "B",
    thread,
    task: TASK_TEXT,
    newSession: opts.newSession === true,
  };
  const inbound = [];
  const config = {
    port: 0,
    requestTimeoutMs: 500,
    minTaskChars: 10,
    maxWakesPerThread: 30,
    threadCooldownMs: 5000,
    threadWindowMs: 3600000,
    agentPreset: "standard",
    permissionPreset: "danger-full-access",
    workspaceRoot: home,
  };

  await ns.handleInboundTask(
    ctx, task, inbound, config, noop, (m) => warnings.push(String(m)),
    waker, threadState, () => config.maxWakesPerThread, new Map(),
  );
  // 等 wakeAgentOrResume 的 then/catch 落定：出现任一可见副作用即可
  const settled = () => r().messages.length > 0 || r().createdIds.length > 0 || r().resumedIds.length > 0 || r().warnings.length > 0;
  function r() { return { messages, createdIds, resumedIds, warnings }; }
  for (let i = 0; i < 200 && !settled(); i += 1) {
    await new Promise((res) => setTimeout(res, 10));
  }
  await new Promise((res) => setTimeout(res, 60));
  cleanupPaths.push(home);
  return { messages, resumedIds, createdIds, warnings, threadState, key, inbound, home };
}

const ns = await loadModule();

try {
  // 1) 绑定的会话不在注册表里，但能恢复 → 必须恢复，且不新建
  {
    const r = await runInbound(ns, { boundSessionId: "dead-session" });
    assert.deepEqual(r.resumedIds, ["dead-session"], "应当按绑定 id 恢复旧会话");
    assert.equal(r.createdIds.length, 0, "能恢复时不该新建会话");
    assert.equal(r.messages.length, 1, "恢复后要把任务提示注入进去");
    assert.equal(r.threadState.get(r.key).sessionId, "dead-session", "绑定仍是那个会话");
    console.log("✓ 已结束的会话被恢复：注入原会话，未新建");
  }

  // 2) 恢复失败 → 退回新建，且不能丢消息
  {
    const r = await runInbound(ns, { boundSessionId: "gone-session", resumeFails: true });
    assert.deepEqual(r.resumedIds, ["gone-session"], "先尝试恢复");
    assert.equal(r.createdIds.length, 1, "恢复失败后应新建会话");
    assert.equal(r.messages.length, 1, "任务提示仍要注入（不能丢回传）");
    assert.ok(r.warnings.some((w) => w.includes("恢复会话")), "恢复失败要留下 warn 原因");
    assert.equal(r.threadState.get(r.key).sessionId, r.createdIds[0], "绑定改到新会话");
    console.log("✓ 恢复失败时退回新建：消息不丢，原因有记录");
  }

  // 3) 旧版 DSH 没有 agents.resume → 直接新建，不抛错
  {
    const r = await runInbound(ns, { boundSessionId: "old-dsh", withResume: false });
    assert.equal(r.createdIds.length, 1, "没有 resume 时应新建");
    assert.equal(r.messages.length, 1);
    assert.ok(r.warnings.some((w) => w.includes("没有 resume")), "要说清是版本能力缺失");
    console.log("✓ 没有 resume API 时优雅降级为新建");
  }

  // 4) 发送方显式要求新会话 → 不许恢复
  {
    const r = await runInbound(ns, { boundSessionId: "dead-session", newSession: true });
    assert.equal(r.resumedIds.length, 0, "newSession=true 时不该恢复");
    assert.equal(r.createdIds.length, 1, "应新建会话");
    console.log("✓ newSession=true 时不恢复");
  }

  // 5) 会话仍活跃 → 走注入路径，既不恢复也不新建
  {
    const r = await runInbound(ns, { boundSessionId: "live-1", liveSessionId: "live-1" });
    assert.equal(r.resumedIds.length, 0, "活着就直接注入");
    assert.equal(r.createdIds.length, 0);
    console.log("✓ 会话仍活跃时直接注入，不触发恢复");
  }

  console.log("\n全部通过");
} finally {
  for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
