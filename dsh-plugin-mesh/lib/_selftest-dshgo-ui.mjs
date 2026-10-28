/**
 * dsh-go 原生 UI（lib/dshgo-ui.js）的离线自测。
 *
 * 跑法：node lib/_selftest-dshgo-ui.mjs
 *
 * 为什么值得单独一套：这套 UI 只在真机（dsh-go App + dsh-go-bridge）才会真正渲染，
 * 但**协议约束**（视图节点/字节上限、data 4Hz、toast 40 字、strip 24 字、点按效果类型）
 * 全都能离线断言；真机只负责"App 画得对不对"，不能替我们防回归。
 * 这里用 fake ctx/fake discovery 覆盖：桌面 no-op、注册、两个面板视图与数据、
 * 状态条、四类点按、限流、清理、以及"任何情况下不抛"。
 */
import assert from "node:assert/strict";
import {
  BRIDGE_LIMITS,
  PANEL_PEERS,
  PANEL_TASKS,
  PANEL_HOME,
  STRIP_ID,
  DEFAULT_HOME_WIDGETS,
  HOME_WIDGET_IDS,
  HOME_WIDGETS_STATE_KEY,
  buildHomeConfigView,
  buildHomeData,
  buildHomeView,
  buildPeersData,
  buildPeersView,
  buildStripData,
  buildTasksData,
  buildTasksView,
  createDshGoUI,
  jsonBytes,
  loadHomeWidgets,
  normalizeHomeWidgets,
  registerDshGoUI,
  saveHomeWidgets,
  viewStats,
} from "./dshgo-ui.js";

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err?.stack?.split("\n").slice(0, 3).join("\n      ") ?? err}`);
    failed += 1;
  }
}

/* ───────────────────────── fixtures ───────────────────────── */

const NOW = Date.now();
const PEERS = [
  {
    id: "peer-hos",
    machine: "hos",
    hostname: "localhost",
    host: "127.0.0.1",
    port: 46001,
    online: true,
    transport: "usb",
    channel: "usb:abc",
    os: "linux 6.1.0",
    osInfo: { platform: "android", name: "Android", version: "15" },
    capabilitySummary: "8 核 · python 3.12",
    endpoints: [{ channel: "usb:abc", transport: "usb", rttMs: 12 }],
    lastSeen: NOW,
  },
  {
    id: "peer-win",
    machine: "文超-win",
    host: "192.168.1.6",
    port: 45917,
    online: true,
    transport: "lan",
    channel: "lan",
    os: "win32 10.0.22631",
    osInfo: { platform: "win32", name: "Windows", version: "11" },
    capabilitySummary: "16 核",
    endpoints: [{ channel: "lan", transport: "lan", rttMs: 3 }],
    lastSeen: NOW,
  },
  { id: "peer-off", machine: "localhost", host: "", port: 0, online: false, restored: true, lastSeen: NOW - 300000 },
];

const TASKS = {
  inbound: [
    { id: "t-in-0001", from: "文超-win/u", fromMachine: "文超-win", status: "dispatched", thread: "abc", receivedAt: new Date(NOW).toISOString() },
    { id: "t-in-0002", from: "hos/u", fromMachine: "hos", status: "accepted", thread: "", receivedAt: new Date(NOW - 60000).toISOString() },
  ],
  outbound: [
    { id: "t-out-0001", toMachine: "hos", ok: true, status: 200, thread: "xyz", at: new Date(NOW - 30000).toISOString() },
    { id: "t-out-0002", toMachine: "文超-win", ok: false, error: "timeout", thread: "", at: new Date(NOW - 90000).toISOString() },
  ],
};

/** 本机名片（与 index.js 传给 UI 的 discovery.selfRecord() 同形）。 */
const SELF = { id: "self-hos", machine: "hos-phone", host: "192.168.1.19", port: 45917, version: "0.5.4-dshgo.2" };

function makeDiscovery({ peers = PEERS, throwOnPeers = false } = {}) {
  const listeners = new Map();
  const calls = { on: 0, remove: 0, emitted: 0 };
  return {
    calls,
    on(event, fn) {
      calls.on += 1;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    removeListener(event, fn) {
      calls.remove += 1;
      listeners.get(event)?.delete(fn);
    },
    peers() {
      if (throwOnPeers) throw new Error("peers boom");
      return peers;
    },
    emitChange() {
      calls.emitted += 1;
      for (const fn of listeners.get("change") ?? []) fn();
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

function makeFakeScoped({ panelThrows = false, stripThrows = false } = {}) {
  const reg = { panels: [], strips: [], effects: 0 };
  const scoped = {
    dshGo: {
      panel(id, def) {
        if (panelThrows) throw new Error("panel boom");
        reg.panels.push({ id, def });
        return () => {};
      },
      strip(id, fn) {
        if (stripThrows) throw new Error("strip boom");
        reg.strips.push({ id, fn });
        return () => {};
      },
    },
    effect(fn) {
      reg.effects += 1;
    },
  };
  return { scoped, reg };
}

const depsOf = ({
  discovery = makeDiscovery(),
  getTasks = () => TASKS,
  getSelf = () => SELF,
  sendProbe = async () => ({ id: "t-probe" }),
  loadState = () => ({}),
  saveState = () => {},
  warn,
  log,
} = {}) => ({
  discovery,
  getTasks,
  getSelf,
  sendProbe,
  loadState,
  saveState,
  ...(warn ? { warn } : {}),
  ...(log ? { log } : {}),
});

const opts = { rateMs: 0, tickMs: 10 * 60 * 1000, maxPeers: 20, maxTasks: 12 };

/** 驱动一次数据函数，拿到首个 emit 与 cancel。 */
async function runData(def, { scope = { sessionId: "s1" }, caps = { locale: "zh-CN" } } = {}) {
  const emitted = [];
  const cancel = def.data(scope, (data) => emitted.push(data), caps);
  await sleep(5);
  return { emitted, cancel };
}

async function withUI(deps, fn) {
  const { scoped, reg } = makeFakeScoped();
  const ui = createDshGoUI(scoped, deps, opts);
  try {
    return await fn(ui, reg, scoped);
  } finally {
    ui.dispose();
  }
}

/* ───────────────────────── 1. 桌面 no-op / 永不抛 ───────────────────────── */

console.log("\n—— 1. 无 bridge（桌面）与异常输入 ——");

await check("registerDshGoUI(null) 不抛，返回清理函数", () => {
  const cleanup = registerDshGoUI(null, {});
  assert.equal(typeof cleanup, "function");
  cleanup();
});

await check("桌面 ctx：inject 被调用但回调不执行（没有 dshGo 服务）", () => {
  const calls = { injected: [], panels: [] };
  const ctx = {
    inject(deps, cb) {
      calls.injected.push(deps);
      // 模拟 cordis：服务不存在时回调永不执行
    },
  };
  const cleanup = registerDshGoUI(ctx, depsOf(), opts);
  assert.deepEqual(calls.injected, [["dshGo"]]);
  assert.equal(calls.panels.length, 0);
  assert.equal(typeof cleanup, "function");
  cleanup();
});

await check("ctx.inject 抛错时被吞掉并 warn", () => {
  const warns = [];
  const ctx = {
    inject() {
      throw new Error("inject boom");
    },
  };
  const cleanup = registerDshGoUI(ctx, depsOf({ warn: (m) => warns.push(m) }), opts);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /inject boom/);
  cleanup();
});

await check("dshGo 存在但 panel 抛错：注册失败只 warn，不向外抛", () => {
  const warns = [];
  const { scoped } = makeFakeScoped({ panelThrows: true });
  const ctx = { inject: (_d, cb) => cb(scoped) };
  const cleanup = registerDshGoUI(ctx, depsOf({ warn: (m) => warns.push(m) }), opts);
  assert.ok(warns.some((m) => /dsh-go 原生 UI 注册失败/.test(m)));
  cleanup();
});

/* ───────────────────────── 2. 注册结果 ───────────────────────── */

console.log("\n—— 2. 注册（面板/状态条/回调）——");

await check("注册 3 个面板（home/peers/tasks）+ 1 个状态条（mesh-status），home 排第一", async () => {
  await withUI(depsOf(), async (_ui, reg) => {
    assert.deepEqual(reg.panels.map((p) => p.id), [PANEL_HOME, PANEL_PEERS, PANEL_TASKS]);
    assert.deepEqual(reg.strips.map((s) => s.id), [STRIP_ID]);
  });
});

await check("面板 def 含 view/data/actions；点按动作齐全（含 home 的快捷入口/调整主页）", async () => {
  await withUI(depsOf(), async (ui) => {
    const home = ui.panels[PANEL_HOME].def;
    const peers = ui.panels[PANEL_PEERS].def;
    const tasks = ui.panels[PANEL_TASKS].def;
    for (const def of [home, peers, tasks]) {
      assert.equal(typeof def.view, "function");
      assert.equal(typeof def.data, "function");
    }
    for (const k of ["refresh", "probeQuick", "openPeers", "openTasks", "openWeb", "copySelf", "openConfig", "selectWidget", "moveUp", "moveDown", "toggleWidget", "saveConfig", "resetConfig", "cancelConfig"]) {
      assert.equal(typeof home.actions[k], "function", `home.${k}`);
    }
    for (const k of ["refresh", "copyAddress", "openWeb", "probe", "selectPeer"]) assert.equal(typeof peers.actions[k], "function", `peers.${k}`);
    for (const k of ["refresh", "copyTask", "selectTask"]) assert.equal(typeof tasks.actions[k], "function", `tasks.${k}`);
  });
});

await check("三个面板视图 + 主页调整视图都满足 bridge limits（字节/节点/深度），中英文都一样", async () => {
  await withUI(depsOf(), async (ui) => {
    for (const locale of ["zh-CN", "en-US", ""]) {
      for (const panel of [PANEL_HOME, PANEL_PEERS, PANEL_TASKS]) {
        const view = ui.panels[panel].def.view({ sessionId: "s1" }, { locale });
        const st = viewStats(view);
        assert.ok(st.bytes <= BRIDGE_LIMITS.viewBytes, `${panel}/${locale} bytes=${st.bytes}`);
        assert.ok(st.nodes <= BRIDGE_LIMITS.viewNodes, `${panel}/${locale} nodes=${st.nodes}`);
        assert.ok(st.depth <= BRIDGE_LIMITS.viewDepth, `${panel}/${locale} depth=${st.depth}`);
        assert.equal(view.type, "stack");
      }
      const cfg = buildHomeConfigView(locale);
      const cfgStats = viewStats(cfg);
      assert.ok(cfgStats.bytes <= BRIDGE_LIMITS.viewBytes && cfgStats.nodes <= BRIDGE_LIMITS.viewNodes && cfgStats.depth <= BRIDGE_LIMITS.viewDepth, `config/${locale}`);
    }
    // 视图声明了 options 的 id，必须与 actions 里同名（bridge 按 action id 回调）
    const peersView = ui.panels[PANEL_PEERS].def.view({}, { locale: "zh-CN" });
    const optsNode = peersView.children.find((n) => n.type === "options");
    assert.equal(optsNode.id, "selectPeer");
    assert.equal(typeof ui.panels[PANEL_PEERS].def.actions[optsNode.id], "function");
    const cfgView = buildHomeConfigView("zh-CN");
    const cfgOpts = cfgView.children.find((n) => n.type === "options");
    assert.equal(cfgOpts.id, "selectWidget");
    assert.equal(typeof ui.panels[PANEL_HOME].def.actions[cfgOpts.id], "function");
  });
});

await check("视图函数遇到空 caps / 伪造 caps 不抛", async () => {
  await withUI(depsOf(), async (ui) => {
    assert.doesNotThrow(() => ui.panels[PANEL_PEERS].def.view({}, undefined));
    assert.doesNotThrow(() => ui.panels[PANEL_PEERS].def.view({}, { locale: 42 }));
    assert.doesNotThrow(() => ui.panels[PANEL_TASKS].def.view(undefined, null));
  });
});

/* ───────────────────────── 3. peers 数据 ───────────────────────── */

console.log("\n—— 3. peers 面板数据 ——");

await check("设备行/选项/摘要齐全，数据 ≤32KiB", async () => {
  await withUI(depsOf(), async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_PEERS].def);
    const data = emitted[0];
    assert.equal(data.total, 3);
    assert.equal(data.onlineLabel, "2 / 3");
    assert.ok(data.rows.length <= 20);
    assert.ok(data.rows[0].title.startsWith("●"));
    // 行序是稳定的字典序（hos < 文超-win），但断言不依赖 ICU 排序：只要两行都在。
    assert.ok(data.rows.some((r) => /Android 15/.test(r.subtitle)), JSON.stringify(data.rows.map((r) => r.subtitle)));
    assert.ok(data.rows.some((r) => /usb/.test(r.subtitle)));
    assert.ok(data.options.some((o) => o.value === "peer-hos"));
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes, `bytes=${jsonBytes(data)}`);
    cancel();
  });
});

await check("超过 maxPeers 时截断并给 hint（不超限、不抛）", async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    id: `p-${i}`,
    machine: `m-${i}`,
    host: `10.0.0.${i}`,
    port: 45917,
    online: i % 2 === 0,
    transport: i % 3 === 0 ? "usb" : "lan",
    capabilitySummary: "x".repeat(40),
  }));
  const deps = depsOf({ discovery: makeDiscovery({ peers: many }) });
  await withUI(deps, async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_PEERS].def);
    const data = emitted[0];
    assert.equal(data.rows.length, 20);
    assert.equal(data.truncated, true);
    assert.match(data.hint, /还有 30 台/);
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes);
    cancel();
  });
});

await check("discovery.peers() 抛错时仍 emit 合法空数据（绝不抛）", async () => {
  const deps = depsOf({ discovery: makeDiscovery({ throwOnPeers: true }) });
  await withUI(deps, async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_PEERS].def);
    const data = emitted[0];
    assert.equal(data.total, 0);
    assert.deepEqual(data.rows, []);
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes);
    cancel();
  });
});

/* ───────────────────────── 4. tasks 数据 ───────────────────────── */

console.log("\n—— 4. tasks 面板数据 ——");

await check("入站/出站计数与表格行（≤12 行、6 列）", async () => {
  await withUI(depsOf(), async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_TASKS].def);
    const data = emitted[0];
    assert.equal(data.inboundCount, "2");
    assert.equal(data.outboundCount, "2");
    assert.ok(data.rows.length <= 12);
    assert.ok(data.rows.every((r) => Array.isArray(r) && r.length === 6));
    assert.ok(data.options.some((o) => o.value === "t-in-0001"));
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes);
    const view = ui.panels[PANEL_TASKS].def.view({}, { locale: "zh-CN" });
    const table = view.children.find((n) => n.type === "table");
    assert.equal(table.columns.length, 6);
    cancel();
  });
});

await check("getTasks() 抛错时返回空任务（绝不抛）", async () => {
  const deps = depsOf({ getTasks: () => { throw new Error("tasks boom"); } });
  await withUI(deps, async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_TASKS].def);
    const data = emitted[0];
    assert.equal(data.inboundCount, "0");
    assert.equal(data.outboundCount, "0");
    assert.ok(data.hint.length > 0);
    cancel();
  });
});

/* ───────────────────────── 5. 状态条 ───────────────────────── */

console.log("\n—— 5. 状态条（strip，≤24 字）——");

await check("有在线设备：Mesh · N 在线 · usb/lan，≤24 字", async () => {
  await withUI(depsOf(), async (ui, reg) => {
    const emitted = [];
    const cancel = reg.strips[0].fn({}, (d) => emitted.push(d), { locale: "zh-CN" });
    assert.equal(emitted[0].text, "Mesh · 2 在线 · usb/lan");
    assert.ok([...emitted[0].text].length <= BRIDGE_LIMITS.stripText);
    assert.equal(emitted[0].tone, "good");
    assert.equal(emitted[0].icon, "team");
    cancel();
  });
});

await check("英文/无设备：不超 24 字，无在线时 tone=muted", async () => {
  await withUI(depsOf(), async (ui, reg) => {
    const emitted = [];
    const cancel = reg.strips[0].fn({}, (d) => emitted.push(d), { locale: "en-US" });
    assert.ok([...emitted[0].text].length <= BRIDGE_LIMITS.stripText, emitted[0].text);
    cancel();
    const emptyDeps = depsOf({ discovery: makeDiscovery({ peers: [] }) });
    const ui2 = createDshGoUI(makeFakeScoped().scoped, emptyDeps, opts);
    const reg2 = [];
    ui2.dispose();
    assert.equal(buildStripData([], "zh-CN").tone, "muted");
    assert.equal(buildStripData([], "zh-CN").text, "Mesh · 无在线设备");
  });
});

/* ───────────────────────── 6. 点按 —— 四类动作 ───────────────────────── */

console.log("\n—— 6. invoke：refresh / copy / open / select / probe ——");

await check("refresh → {refresh:true}（由 bridge 按来源面板补 id）", async () => {
  await withUI(depsOf(), async (ui) => {
    assert.deepEqual(ui.panels[PANEL_PEERS].def.actions.refresh(), { refresh: true });
    assert.deepEqual(ui.panels[PANEL_TASKS].def.actions.refresh(), { refresh: true });
  });
});

await check("selectPeer → patch 选中 + toast ≤40 字", async () => {
  await withUI(depsOf(), async (ui) => {
    const effect = ui.panels[PANEL_PEERS].def.actions.selectPeer({ sessionId: "s1" }, { value: { value: "peer-win" } });
    assert.deepEqual(effect.patch, { selected: "peer-win" });
    assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
    // 选中后 copyAddress 复制的是这台
    const copy = ui.panels[PANEL_PEERS].def.actions.copyAddress({ sessionId: "s1" }, {});
    assert.match(copy.copy, /^文超-win 192\.168\.1\.6:45917$/);
  });
});

await check("没有选中设备时 copyAddress 回退到在线设备；没有任何设备时给 toast", async () => {
  await withUI(depsOf(), async (ui) => {
    const copy = ui.panels[PANEL_PEERS].def.actions.copyAddress({ sessionId: "s2" }, {});
    assert.match(copy.copy, /:45917|:46001/);
    assert.ok([...copy.copy].length <= BRIDGE_LIMITS.copy);
  });
  const emptyDeps = depsOf({ discovery: makeDiscovery({ peers: [] }) });
  const ui = createDshGoUI(makeFakeScoped().scoped, emptyDeps, opts);
  const effect = ui.panels[PANEL_PEERS].def.actions.copyAddress({}, {});
  assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
  ui.dispose();
});

await check("openWeb → {open:'web'}（App 页面 id，非 https 链接）", async () => {
  await withUI(depsOf(), async (ui) => {
    assert.deepEqual(ui.panels[PANEL_PEERS].def.actions.openWeb({}, {}), { open: "web" });
  });
});

await check("probe：有选中且在线 → 立刻 toast，后台调用 sendProbe", async () => {
  const calls = [];
  const deps = depsOf({
    sendProbe: async (arg) => {
      calls.push(arg);
      return { id: "t-probe-1" };
    },
  });
  await withUI(deps, async (ui) => {
    ui.panels[PANEL_PEERS].def.actions.selectPeer({ sessionId: "s1" }, { value: { value: "peer-hos" } });
    const effect = ui.panels[PANEL_PEERS].def.actions.probe({ sessionId: "s1" }, {});
    assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
    await sleep(10);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target.id, "peer-hos");
    assert.match(calls[0].thread, /^ui-probe-/);
    assert.ok(String(calls[0].text).length >= 8);
  });
});

await check("probe：未选/离线 → toast；sendProbe 失败只 warn，不抛", async () => {
  const warns = [];
  const deps = depsOf({
    sendProbe: async () => {
      throw new Error("probe boom");
    },
    warn: (m) => warns.push(m),
  });
  await withUI(deps, async (ui) => {
    const none = ui.panels[PANEL_PEERS].def.actions.probe({ sessionId: "s1" }, {});
    assert.ok([...none.toast].length <= BRIDGE_LIMITS.toast);
    ui.panels[PANEL_PEERS].def.actions.selectPeer({ sessionId: "s1" }, { value: { value: "peer-off" } });
    const offline = ui.panels[PANEL_PEERS].def.actions.probe({ sessionId: "s1" }, {});
    assert.match(offline.toast, /离线/);
    ui.panels[PANEL_PEERS].def.actions.selectPeer({ sessionId: "s1" }, { value: { value: "peer-hos" } });
    const ok = ui.panels[PANEL_PEERS].def.actions.probe({ sessionId: "s1" }, {});
    assert.ok([...ok.toast].length <= BRIDGE_LIMITS.toast);
    await sleep(10);
    assert.ok(warns.some((m) => /probe boom/.test(m)));
  });
});

await check("selectTask + copyTask → 复制完整 id（≤8000）；无任务时 toast", async () => {
  await withUI(depsOf(), async (ui) => {
    ui.panels[PANEL_TASKS].def.actions.selectTask({ sessionId: "s1" }, { value: { value: "t-out-0001" } });
    const copy = ui.panels[PANEL_TASKS].def.actions.copyTask({ sessionId: "s1" }, {});
    assert.equal(copy.copy, "t-out-0001");
    assert.ok([...copy.copy].length <= BRIDGE_LIMITS.copy);
  });
  const emptyDeps = depsOf({ getTasks: () => ({ inbound: [], outbound: [] }) });
  const ui = createDshGoUI(makeFakeScoped().scoped, emptyDeps, opts);
  const effect = ui.panels[PANEL_TASKS].def.actions.copyTask({}, {});
  assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
  ui.dispose();
});

await check("点按回调遇到垃圾 event 不抛", async () => {
  await withUI(depsOf(), async (ui) => {
    for (const fn of Object.values(ui.panels[PANEL_PEERS].def.actions)) {
      assert.doesNotThrow(() => fn(undefined, undefined));
      assert.doesNotThrow(() => fn({}, { value: 42 }));
    }
    for (const fn of Object.values(ui.panels[PANEL_TASKS].def.actions)) {
      assert.doesNotThrow(() => fn(undefined, null));
    }
  });
});

/* ───────────────────────── 7. 限流与清理 ───────────────────────── */

console.log("\n—— 7. 4Hz 限流、事件订阅与清理 ——");

await check("discovery change 事件被节流（≤4Hz），且 cancel 后不再 emit", async () => {
  const discovery = makeDiscovery();
  const deps = depsOf({ discovery });
  const ui = createDshGoUI(makeFakeScoped().scoped, deps, { rateMs: 60, tickMs: 10 * 60 * 1000, maxPeers: 20, maxTasks: 12 });
  const emitted = [];
  const cancel = ui.panels[PANEL_PEERS].def.data({ sessionId: "s1" }, (d) => emitted.push(d), { locale: "zh-CN" });
  assert.equal(emitted.length, 1); // 首次立即推
  for (let i = 0; i < 6; i += 1) discovery.emitChange();
  await sleep(140);
  assert.ok(emitted.length <= 3, `emits=${emitted.length}`); // 1 次首推 + 最多 2 次节流后的推送
  const after = emitted.length;
  cancel();
  discovery.emitChange();
  await sleep(80);
  assert.equal(emitted.length, after, "cancel 之后不应再收到 change 推送");
  assert.equal(discovery.listenerCount("change"), 0, "cancel 应移除 change 监听");
  ui.dispose();
});

await check("dispose 幂等、清理所有 data/strip 定时器", async () => {
  const discovery = makeDiscovery();
  const deps = depsOf({ discovery });
  const ui = createDshGoUI(makeFakeScoped().scoped, deps, { rateMs: 0, tickMs: 30, maxPeers: 20, maxTasks: 12 });
  const peersEmit = [];
  const dataCancel = ui.panels[PANEL_PEERS].def.data({}, (d) => peersEmit.push(d), {});
  // strip 也注册一个（用注册结果里的 fn 不可见，这里经 reg 不可达 —— 用 build 函数已覆盖；只验证 data 定时器）
  await sleep(5);
  const before = peersEmit.length;
  ui.dispose();
  assert.doesNotThrow(() => ui.dispose());
  await sleep(80);
  assert.equal(peersEmit.length, before, "dispose 后定时刷新应停止");
  dataCancel();
});

await check("registerDshGoUI 返回的 cleanup 可安全重复调用", async () => {
  const { scoped } = makeFakeScoped();
  const ctx = { inject: (_d, cb) => cb(scoped), effect() {} };
  const cleanup = registerDshGoUI(ctx, depsOf(), opts);
  cleanup();
  cleanup();
  assert.ok(true);
});

await check("视图/数据函数的输出口径与 bridge 一致（jsonBytes=紧凑 JSON，节点只数 type）", async () => {
  const view = buildPeersView("zh-CN");
  const st = viewStats(view);
  assert.equal(st.nodes, 6);
  assert.equal(st.depth, 2);
  assert.equal(st.bytes, jsonBytes(view));
  const data = buildPeersData({ peers: PEERS, state: {}, locale: "zh-CN" });
  assert.equal(jsonBytes(data), Buffer.byteLength(JSON.stringify(data), "utf8"));
  const tasks = buildTasksData({ tasks: TASKS, state: {}, locale: "en-US" });
  assert.ok(Array.isArray(tasks.rows));
  assert.ok(buildTasksView("en-US").children.length >= 4);
});

/* ───────────────────────── 8. home（可配置主页） ───────────────────────── */

console.log("\n—— 8. home 主页（widget 默认全开 / 数据对等 / 截断）——");

await check("默认布局：self → devices → tasks → quick 四个 widget 都在，顺序与默认一致", async () => {
  const view = buildHomeView("zh-CN", DEFAULT_HOME_WIDGETS);
  const kinds = view.children.map((n) => n.type);
  assert.equal(kinds[0], "keyValue"); // self
  assert.ok(kinds.includes("list")); // devices
  assert.ok(kinds.includes("table")); // tasks
  const actionRows = view.children.filter((n) => n.type === "actions");
  assert.ok(actionRows.length >= 3, "quick 两行 + 调整主页一行");
  const st = viewStats(view);
  assert.ok(st.nodes <= BRIDGE_LIMITS.viewNodes && st.bytes <= BRIDGE_LIMITS.viewBytes && st.depth <= BRIDGE_LIMITS.viewDepth);
  assert.deepEqual(HOME_WIDGET_IDS, ["self", "devices", "tasks", "quick"]);
});

await check("home 数据与本机名片对等：名称/地址/版本/通道/在线数 + 设备行 ≤5 + 任务行 ≤3", async () => {
  await withUI(depsOf(), async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_HOME].def);
    const data = emitted[0];
    const kv = Object.fromEntries(data.selfItems);
    assert.equal(kv["名称"], "hos-phone");
    assert.equal(kv["地址"], "192.168.1.19:45917");
    assert.equal(kv["版本"], "0.5.4-dshgo.2");
    assert.match(kv["通道"], /usb/);
    assert.equal(kv["在线设备"], "2/3");
    assert.ok(data.deviceRows.length <= 5);
    assert.ok(data.deviceRows.every((r) => r.title && r.subtitle && r.tone));
    assert.ok(data.taskRows.length <= 3);
    assert.ok(data.taskRows.every((r) => Array.isArray(r) && r.length === 3));
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes);
    cancel();
  });
});

await check("home 截断：10 台在线只显示 5 台、10 条任务只显示 3 条，并给 hint", async () => {
  const manyPeers = Array.from({ length: 10 }, (_, i) => ({ id: `p-${i}`, machine: `m-${i}`, host: `10.0.0.${i}`, port: 45917, online: true, transport: "lan" }));
  const manyTasks = {
    inbound: Array.from({ length: 10 }, (_, i) => ({ id: `t-in-${i}`, fromMachine: "m", status: "dispatched", receivedAt: new Date(NOW - i * 1000).toISOString() })),
    outbound: [],
  };
  const deps = depsOf({ discovery: makeDiscovery({ peers: manyPeers }), getTasks: () => manyTasks });
  await withUI(deps, async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_HOME].def);
    const data = emitted[0];
    assert.equal(data.deviceRows.length, 5);
    assert.equal(data.taskRows.length, 3);
    assert.equal(data.truncated, true);
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes);
    cancel();
  });
});

await check("布局状态生效：隐藏 quick、把 tasks 调到 self 前面（来自 loadState）", async () => {
  const saved = [
    { id: "tasks", visible: true },
    { id: "self", visible: true },
    { id: "quick", visible: false },
    { id: "devices", visible: true },
  ];
  const deps = depsOf({ loadState: () => ({ [HOME_WIDGETS_STATE_KEY]: saved }) });
  await withUI(deps, async (ui) => {
    const view = ui.panels[PANEL_HOME].def.view({ sessionId: "s1" }, { locale: "zh-CN" });
    const kinds = view.children.map((n) => n.type);
    // tasks 的 table 在 self 的 keyValue 之前（widget 顺序来自 loadState）
    const idxTable = kinds.indexOf("table");
    const idxKv = kinds.indexOf("keyValue");
    assert.ok(idxTable >= 0 && idxKv >= 0 && idxTable < idxKv, `order kinds=${kinds}`);
    // quick 隐藏 → 只剩「调整主页」一行 actions
    assert.equal(view.children.filter((n) => n.type === "actions").length, 1);
    const { emitted, cancel } = await runData(ui.panels[PANEL_HOME].def);
    assert.ok(Array.isArray(emitted[0].taskRows));
    cancel();
  });
});

await check("normalizeHomeWidgets：未知/重复丢弃、缺失补齐、全隐藏时至少留一项、垃圾输入不抛", () => {
  const a = normalizeHomeWidgets([{ id: "tasks", visible: false }, { id: "nope" }, { id: "tasks", visible: true }]);
  assert.deepEqual(a.map((w) => w.id), ["tasks", "self", "devices", "quick"]);
  assert.equal(a[0].visible, false);
  const b = normalizeHomeWidgets([{ id: "self", visible: false }]);
  assert.ok(b.some((w) => w.visible === true), "全隐藏时至少一项可见");
  assert.doesNotThrow(() => normalizeHomeWidgets(null));
  assert.doesNotThrow(() => normalizeHomeWidgets([42, null, "devices"]));
  assert.deepEqual(normalizeHomeWidgets(undefined).map((w) => w.id), HOME_WIDGET_IDS);
  assert.equal(loadHomeWidgets({ loadState: () => { throw new Error("boom"); } }).length, 4);
  assert.equal(saveHomeWidgets({ saveState: () => { throw new Error("boom"); } }, DEFAULT_HOME_WIDGETS), false);
});

/* ───────────────────────── 9. home 调整页（配置模型 + 持久化） ───────────────────────── */

console.log("\n—— 9. home「调整主页」（选择/上移/下移/显隐/保存/恢复默认/返回）——");

await check("openConfig：切到 config 视图并返回 refresh；config 数据有行/选项/选中", async () => {
  await withUI(depsOf(), async (ui) => {
    const effect = ui.panels[PANEL_HOME].def.actions.openConfig({ sessionId: "s1" }, {});
    assert.deepEqual(effect, { refresh: true });
    const view = ui.panels[PANEL_HOME].def.view({ sessionId: "s1" }, { locale: "zh-CN" });
    assert.equal(view.title, "调整主页");
    const { emitted, cancel } = await runData(ui.panels[PANEL_HOME].def, { scope: { sessionId: "s1" } });
    const data = emitted[0];
    assert.equal(data.cfgRows.length, 4);
    assert.equal(data.cfgOptions.length, 4);
    assert.equal(data.cfgSelected, "0");
    assert.match(data.cfgRows[0].title, /1\. 本机状态/);
    cancel();
  });
});

await check("moveDown / moveUp 改草稿顺序；selectWidget 改选中", async () => {
  await withUI(depsOf(), async (ui) => {
    const scope = { sessionId: "s1" };
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    ui.panels[PANEL_HOME].def.actions.moveDown(scope, {});
    let { emitted, cancel } = await runData(ui.panels[PANEL_HOME].def, { scope });
    assert.match(emitted[0].cfgRows[0].title, /1\. 在线设备/);
    cancel();
    ui.panels[PANEL_HOME].def.actions.selectWidget(scope, { value: { value: "1" } });
    ui.panels[PANEL_HOME].def.actions.moveUp(scope, {});
    ({ emitted, cancel } = await runData(ui.panels[PANEL_HOME].def, { scope }));
    assert.match(emitted[0].cfgRows[0].title, /1\. 本机状态/);
    cancel();
  });
});

await check("toggleWidget：隐藏/显示，且不允许把最后一项也隐藏", async () => {
  await withUI(depsOf(), async (ui) => {
    const scope = { sessionId: "s1" };
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    ui.panels[PANEL_HOME].def.actions.toggleWidget(scope, {});
    let { emitted, cancel } = await runData(ui.panels[PANEL_HOME].def, { scope });
    assert.match(emitted[0].cfgRows[0].subtitle, /已隐藏/);
    cancel();
    // 把剩下的 3 项也隐藏 → 第 4 次应被拒（至少保留一项）
    for (let i = 1; i < 3; i += 1) {
      ui.panels[PANEL_HOME].def.actions.selectWidget(scope, { value: { value: String(i) } });
      ui.panels[PANEL_HOME].def.actions.toggleWidget(scope, {});
    }
    ui.panels[PANEL_HOME].def.actions.selectWidget(scope, { value: { value: "3" } });
    const last = ui.panels[PANEL_HOME].def.actions.toggleWidget(scope, {});
    assert.match(last.toast ?? "", /至少保留一项/);
  });
});

await check("saveConfig：写 state（homeWidgets 数组）+ 回主页 + refresh；saveState 抛错只 toast", async () => {
  const saved = [];
  const deps = depsOf({ saveState: (patch) => saved.push(patch) });
  await withUI(deps, async (ui) => {
    const scope = { sessionId: "s1" };
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    ui.panels[PANEL_HOME].def.actions.moveDown(scope, {});
    const effect = ui.panels[PANEL_HOME].def.actions.saveConfig(scope, {});
    assert.deepEqual(effect.refresh, true);
    assert.equal(saved.length, 1);
    assert.ok(Array.isArray(saved[0][HOME_WIDGETS_STATE_KEY]));
    assert.equal(saved[0][HOME_WIDGETS_STATE_KEY][0].id, "devices");
    const view = ui.panels[PANEL_HOME].def.view(scope, { locale: "zh-CN" });
    assert.equal(view.title, "Mesh"); // 已回主页
    assert.equal(typeof effect.toast, "string");
    assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
  });
  const bad = depsOf({ saveState: () => { throw new Error("disk boom"); } });
  await withUI(bad, async (ui) => {
    const scope = { sessionId: "s2" };
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    const effect = ui.panels[PANEL_HOME].def.actions.saveConfig(scope, {});
    assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
  });
});

await check("resetConfig 写回默认布局；cancelConfig 不写 state 直接回主页", async () => {
  const saved = [];
  const deps = depsOf({ saveState: (patch) => saved.push(patch) });
  await withUI(deps, async (ui) => {
    const scope = { sessionId: "s1" };
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    ui.panels[PANEL_HOME].def.actions.resetConfig(scope, {});
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0][HOME_WIDGETS_STATE_KEY], DEFAULT_HOME_WIDGETS);
    const before = saved.length;
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    ui.panels[PANEL_HOME].def.actions.cancelConfig(scope, {});
    assert.equal(saved.length, before, "cancel 不应写 state");
    assert.equal(ui.panels[PANEL_HOME].def.view(scope, { locale: "zh-CN" }).title, "Mesh");
  });
});

/* ───────────────────────── 10. home 快捷入口（功能入口要能直达） ───────────────────────── */

console.log("\n—— 10. home 快捷入口 ——");

await check("openPeers/openTasks/openWeb → bridge open effect 直达；copySelf 复制本机地址", async () => {
  await withUI(depsOf(), async (ui) => {
    assert.deepEqual(ui.panels[PANEL_HOME].def.actions.openPeers({}, {}), { open: "panel:peers" });
    assert.deepEqual(ui.panels[PANEL_HOME].def.actions.openTasks({}, {}), { open: "panel:tasks" });
    assert.deepEqual(ui.panels[PANEL_HOME].def.actions.openWeb({}, {}), { open: "web" });
    const copy = ui.panels[PANEL_HOME].def.actions.copySelf({}, {});
    assert.match(copy.copy, /192\.168\.1\.19:45917/);
    assert.ok([...copy.copy].length <= BRIDGE_LIMITS.copy);
  });
});

await check("probeQuick：无选中时打第一台在线；后台调用 sendProbe；失败只 warn", async () => {
  const calls = [];
  const warns = [];
  const deps = depsOf({
    sendProbe: async (arg) => {
      calls.push(arg);
      throw new Error("probe boom");
    },
    warn: (m) => warns.push(m),
  });
  await withUI(deps, async (ui) => {
    const effect = ui.panels[PANEL_HOME].def.actions.probeQuick({ sessionId: "s1" }, {});
    assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
    await sleep(10);
    assert.equal(calls.length, 1);
    assert.match(calls[0].thread, /^ui-probe-/);
    assert.ok(warns.some((m) => /probe boom/.test(m)));
  });
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
