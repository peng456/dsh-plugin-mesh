/**
 * dsh-go 原生 UI（lib/dshgo-ui.js）的离线自测 —— 移动端重做版（task-1 + 产品收敛）。
 *
 * 跑法：node lib/_selftest-dshgo-ui.mjs
 *
 * 为什么值得单独一套：这套 UI 只在真机（dsh-go App + dsh-go-bridge）才会真正渲染，
 * 但**协议约束**（视图节点/字节上限、data 4Hz、toast 40 字、strip 24 字、点按效果类型）
 * 全都能离线断言；真机只负责"App 画得对不对"，不能替我们防回归。
 *
 * 这一版重点防的是真机验收反馈 + 产品收敛后的回归：
 *   1. **同一台设备出现两次** —— 旧版 peers 同时用 `list` + `options` 选设备，App 画成两组
 *      重复 UI。现在断言：所有视图里没有 `options` 组件；设备只出现在 list 行里；设备详情
 *      子视图里没有 list（同屏不重复）；peers 行的设备 id 唯一。
 *   2. **按钮全通栏大药丸** —— 断言每个 actions 节点 ≤4 项、整视图至多 1 个 primary，
 *      且视图/data 行引用的每个动作 id 都在对应面板的 actions 映射里（没有点不动的死按钮）。
 *   3. **产品收敛**：设备页只有「刷新 / 打开网页」两个动作，不再有 options 选择器 /
 *      复制地址 / 派发探测 / hint callout；home 快捷动作是导航型（刷新 primary / 设备列表 /
 *      打开网页 / 调整主页），不再有「派发探测」；设备详情只有「打开网页 / 返回」+ 信息展示。
 *      额外断言：遍历所有点按回调后 sendProbe **一次都没被调用**（原生 UI 不再派发任务）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BRIDGE_LIMITS,
  PANEL_HOME,
  PANEL_PEERS,
  PANEL_TASKS,
  STRIP_ID,
  DEFAULT_HOME_WIDGETS,
  HOME_WIDGET_IDS,
  HOME_WIDGETS_STATE_KEY,
  HOME_PEER_ACTION,
  PEERS_PEER_ACTION,
  HOME_TASK_ACTION,
  TASKS_TASK_ACTION,
  addressOf,
  buildHomeConfigView,
  buildHomeData,
  buildHomeView,
  buildPeerDetailView,
  buildPeersData,
  buildPeersView,
  buildStripData,
  buildTasksData,
  buildTasksView,
  channelTextOf,
  clip,
  createDshGoUI,
  displayName,
  flattenTasks,
  formatTime,
  jsonBytes,
  loadHomeWidgets,
  normalizeHomeWidgets,
  peerDetailItems,
  peerIcon,
  peerRow,
  registerDshGoUI,
  saveHomeWidgets,
  taskRow,
  taskTone,
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
    console.log(`  ✗ ${label}\n      ${err?.stack?.split("\n").slice(0, 4).join("\n      ") ?? err}`);
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
    version: "0.5.4-dshgo.9",
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
    version: "0.5.4-dshgo.8",
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

const EMPTY_TASKS = { inbound: [], outbound: [] };
const SELF = { id: "self-hos", machine: "hos-phone", host: "192.168.1.19", port: 45917, version: "0.5.4-dshgo.9" };

/** fake discovery：与 index.js 注入的 discovery 同形（peers/on/removeListener）。 */
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

async function withUI(deps, fn, options = opts) {
  const { scoped, reg } = makeFakeScoped();
  const ui = createDshGoUI(scoped, deps, options);
  try {
    return await fn(ui, reg, scoped);
  } finally {
    ui.dispose();
  }
}

/* ───────────────────────── 视图审计小工具 ───────────────────────── */

/** 遍历视图树，回调每个组件节点。 */
function walkView(view, fn) {
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (typeof v.type === "string") fn(v);
    for (const x of Object.values(v)) walk(x);
  };
  walk(view);
}

/** 视图里显式写出的动作 id（字符串 action / {id,args} / options.id 也算）。 */
function viewActionIds(view) {
  const ids = [];
  walkView(view, (node) => {
    const action = node.action;
    if (typeof action === "string") ids.push(action);
    else if (action && typeof action === "object" && typeof action.id === "string") ids.push(action.id);
    if (node.type === "options" && typeof node.id === "string") ids.push(node.id);
  });
  return [...new Set(ids)];
}

/** data 里各行自带的动作 id（list 行 action 就藏在这里）。 */
function dataActionIds(data) {
  const ids = [];
  for (const value of Object.values(data ?? {})) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      if (!row || typeof row !== "object") continue;
      const action = row.action;
      if (typeof action === "string") ids.push(action);
      else if (action && typeof action === "object" && typeof action.id === "string") ids.push(action.id);
    }
  }
  return [...new Set(ids)];
}

/** 每个 actions 节点的项数 + 整视图 primary 数。 */
function auditActions(view) {
  const nodes = [];
  walkView(view, (node) => {
    if (node.type === "actions" && Array.isArray(node.items)) nodes.push(node.items);
  });
  const primaries = nodes.flat().filter((item) => item && item.style === "primary").length;
  return { nodes, primaries };
}

const VALID_TONES = new Set(["good", "warn", "bad", "info", "muted"]);
const LOCALES = ["zh-CN", "en-US", ""];

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
    inject(deps) {
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

/* ───────────────────────── 2. 注册 / 视图结构 ───────────────────────── */

console.log("\n—— 2. 注册（面板/状态条）+ 视图结构审计 ——");

await check("注册 3 个面板（home/peers/tasks，home 排第一）+ 1 个状态条（mesh-status）", async () => {
  await withUI(depsOf(), async (_ui, reg) => {
    assert.deepEqual(reg.panels.map((p) => p.id), [PANEL_HOME, PANEL_PEERS, PANEL_TASKS]);
    assert.deepEqual(reg.strips.map((s) => s.id), [STRIP_ID]);
  });
});

await check("三个面板 def 都有 view/data/actions；home 动作名齐全（导航 + 调整主页）", async () => {
  await withUI(depsOf(), async (ui) => {
    const home = ui.panels[PANEL_HOME].def;
    const peers = ui.panels[PANEL_PEERS].def;
    const tasks = ui.panels[PANEL_TASKS].def;
    for (const def of [home, peers, tasks]) {
      assert.equal(typeof def.view, "function");
      assert.equal(typeof def.data, "function");
    }
    for (const k of ["refresh", "openPeers", "openWeb", "openConfig", "openHomePeer", "closeHomePeer", "openTasks", "selectWidget", "moveUp", "moveDown", "toggleWidget", "saveConfig", "resetConfig", "cancelConfig"]) {
      assert.equal(typeof home.actions[k], "function", `home.${k}`);
    }
    for (const k of ["refresh", "openPeer", "closePeer", "openWeb"]) assert.equal(typeof peers.actions[k], "function", `peers.${k}`);
    for (const k of ["refresh", "copyTask"]) assert.equal(typeof tasks.actions[k], "function", `tasks.${k}`);
  });
});

await check("产品收敛：home/peers 不再注册 probe/copy 类动作；设备页没有 selectPeer 选择器", async () => {
  await withUI(depsOf(), async (ui) => {
    const banned = /^(probe|copy|selectPeer)/i;
    for (const panel of [PANEL_HOME, PANEL_PEERS]) {
      for (const name of Object.keys(ui.panels[panel].def.actions)) assert.ok(!banned.test(name), `${panel}.${name} 应已删除`);
    }
    assert.equal(ui.panels[PANEL_PEERS].def.actions.selectPeer, undefined);
    assert.equal(ui.panels[PANEL_HOME].def.actions.probeQuick, undefined);
    assert.equal(ui.panels[PANEL_HOME].def.actions.probePeer, undefined);
    assert.equal(ui.panels[PANEL_HOME].def.actions.copyPeer, undefined);
  });
});

/** 收集面板可能出现的全部视图（home 三种子视图 / peers 两种 / tasks），用于结构审计。 */
function allViews(ui) {
  const scope = { sessionId: "audit" };
  const out = [];
  for (const locale of LOCALES) {
    const caps = { locale };
    out.push({ panel: PANEL_HOME, mode: "home", view: ui.panels[PANEL_HOME].def.view({ ...scope }, caps) });
    ui.panels[PANEL_HOME].def.actions.openConfig({ ...scope }, {});
    out.push({ panel: PANEL_HOME, mode: "config", view: ui.panels[PANEL_HOME].def.view({ ...scope }, caps) });
    ui.panels[PANEL_HOME].def.actions.cancelConfig({ ...scope }, {});
    ui.panels[PANEL_HOME].def.actions.openHomePeer({ ...scope }, { value: { id: "peer-win" } });
    out.push({ panel: PANEL_HOME, mode: "detail", view: ui.panels[PANEL_HOME].def.view({ ...scope }, caps) });
    ui.panels[PANEL_HOME].def.actions.closeHomePeer({ ...scope }, {});
    out.push({ panel: PANEL_PEERS, mode: "list", view: ui.panels[PANEL_PEERS].def.view({ ...scope }, caps) });
    ui.panels[PANEL_PEERS].def.actions.openPeer({ ...scope }, { value: { id: "peer-win" } });
    out.push({ panel: PANEL_PEERS, mode: "detail", view: ui.panels[PANEL_PEERS].def.view({ ...scope }, caps) });
    ui.panels[PANEL_PEERS].def.actions.closePeer({ ...scope }, {});
    out.push({ panel: PANEL_TASKS, mode: "list", view: ui.panels[PANEL_TASKS].def.view({ ...scope }, caps) });
  }
  return out;
}

await check("所有视图（home/detail/config/peers/tasks × 中英空 locale）都在 bridge limits 内", async () => {
  await withUI(depsOf(), async (ui) => {
    const views = allViews(ui);
    assert.ok(views.length >= 15, `views=${views.length}`);
    for (const { panel, mode, view } of views) {
      const st = viewStats(view);
      assert.ok(st.bytes <= BRIDGE_LIMITS.viewBytes, `${panel}/${mode} bytes=${st.bytes}`);
      assert.ok(st.nodes <= BRIDGE_LIMITS.viewNodes, `${panel}/${mode} nodes=${st.nodes}`);
      assert.ok(st.depth <= BRIDGE_LIMITS.viewDepth, `${panel}/${mode} depth=${st.depth}`);
      assert.equal(view.type, "stack");
    }
  });
});

await check("移动端重做：所有视图里都没有 options 组件（重复设备行的根源）", async () => {
  await withUI(depsOf(), async (ui) => {
    for (const { panel, mode, view } of allViews(ui)) {
      let options = 0;
      walkView(view, (node) => {
        if (node.type === "options") options += 1;
      });
      assert.equal(options, 0, `${panel}/${mode} 仍有 options 选择器`);
    }
  });
});

await check("每个 actions 节点 ≤4 项、整视图 primary ≤1（不再是两排大药丸）", async () => {
  await withUI(depsOf(), async (ui) => {
    for (const { panel, mode, view } of allViews(ui)) {
      const { nodes, primaries } = auditActions(view);
      for (const items of nodes) assert.ok(items.length <= BRIDGE_LIMITS.actions, `${panel}/${mode} actions=${items.length}`);
      assert.ok(primaries <= 1, `${panel}/${mode} primaries=${primaries}`);
    }
  });
});

await check("视图/data 行引用的动作 id 都真在对应面板的 actions 映射里（没有死按钮）", async () => {
  await withUI(depsOf(), async (ui) => {
    const data = {
      [PANEL_HOME]: buildHomeData({ peers: PEERS, tasks: TASKS, self: SELF, widgets: DEFAULT_HOME_WIDGETS, state: {}, locale: "zh-CN" }),
      [PANEL_PEERS]: buildPeersData({ peers: PEERS, state: {}, locale: "zh-CN" }),
      [PANEL_TASKS]: buildTasksData({ tasks: TASKS, state: {}, locale: "zh-CN" }),
    };
    for (const { panel, mode, view } of allViews(ui)) {
      const map = ui.panels[panel].def.actions;
      const ids = [...viewActionIds(view), ...dataActionIds(data[panel])];
      for (const id of ids) assert.equal(typeof map[id], "function", `${panel}/${mode} 引用动作 ${id} 不存在`);
    }
  });
});

/* ───────────────────────── 3. home 首屏 ───────────────────────── */

console.log("\n—— 3. home：metric 行 + 在线设备 + 最近任务 + 导航型快捷动作 ——");

await check("home 默认视图：标题 Mesh、metric 行 ×3、设备 list、任务 list、4 个导航型动作（刷新 primary）", async () => {
  await withUI(depsOf(), async (ui) => {
    const view = ui.panels[PANEL_HOME].def.view({ sessionId: "s1" }, { locale: "zh-CN" });
    assert.equal(view.title, "Mesh");
    const types = view.children.map((n) => n.type);
    assert.deepEqual(types.slice(0, 6), ["row", "text", "list", "text", "list", "actions"]);
    assert.equal(view.children[0].children.length, 3);
    assert.equal(view.children[0].children[0].type, "metric");
    assert.ok(!types.includes("keyValue"));
    const { nodes, primaries } = auditActions(view);
    assert.deepEqual(nodes.map((x) => x.length), [4]);
    assert.equal(primaries, 1);
    assert.deepEqual(
      nodes[0].map((item) => item.action),
      ["refresh", "openPeers", "openWeb", "openConfig"],
    );
    assert.equal(nodes[0][0].style, "primary");
    assert.ok(!nodes[0].some((item) => /probe|copy/i.test(String(item.action))), "快捷动作里不应再有派发/复制");
  });
});

await check("点设备行 → 同一面板内切「设备详情」：keyValue + 2 个动作，无 list（同屏不重复设备）", async () => {
  await withUI(depsOf(), async (ui) => {
    const scope = { sessionId: "s1" };
    const effect = ui.panels[PANEL_HOME].def.actions.openHomePeer(scope, { value: { id: "peer-win" } });
    assert.deepEqual(effect, { refresh: true });
    const view = ui.panels[PANEL_HOME].def.view(scope, { locale: "zh-CN" });
    assert.equal(view.title, "设备详情");
    assert.deepEqual(view.children.map((n) => n.type), ["keyValue", "actions"]);
    assert.ok(!view.children.some((n) => n.type === "list"), "详情页不能出现设备列表行");
    assert.deepEqual(
      view.children[1].items.map((item) => item.action),
      ["openWeb", "closeHomePeer"],
    );
    assert.ok(!view.children[1].items.some((item) => /probe|copy/i.test(String(item.action))), "详情页不应有派发/复制");
    const { emitted } = await runData(ui.panels[PANEL_HOME].def, { scope });
    assert.equal(emitted[0].detailItems[0].value, "文超-win");
    assert.equal(emitted[0].detailItems.length, 8);
    ui.panels[PANEL_HOME].def.actions.closeHomePeer(scope, {});
    assert.equal(ui.panels[PANEL_HOME].def.view(scope, { locale: "zh-CN" }).title, "Mesh");
  });
});

await check("home 数据：在线 2/3、任务 4、通道 lan/usb；设备行带行 action + args", async () => {
  await withUI(depsOf(), async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_HOME].def);
    const data = emitted[0];
    assert.equal(data.onlineLabel, "2/3");
    assert.equal(data.taskCount, "4");
    assert.equal(data.channelLabel, "usb/lan");
    assert.ok(data.deviceRows.length <= 5);
    for (const row of data.deviceRows) {
      assert.equal(row.action.id, HOME_PEER_ACTION, JSON.stringify(row));
      assert.equal(typeof row.action.args.id, "string");
      assert.ok(row.title && row.subtitle && row.trailing);
    }
    assert.deepEqual(new Set(data.deviceRows.map((r) => r.icon)), new Set(["robot", "terminal"]));
    assert.ok(data.taskRows.length <= 3);
    for (const row of data.taskRows) assert.equal(row.action, HOME_TASK_ACTION);
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes);
    cancel();
  });
});

await check("home 空态：无设备/无任务时列表为空但底部提示说明原因（不崩）", async () => {
  const deps = depsOf({ discovery: makeDiscovery({ peers: [] }), getTasks: () => EMPTY_TASKS });
  await withUI(deps, async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_HOME].def);
    const data = emitted[0];
    assert.deepEqual(data.deviceRows, []);
    assert.deepEqual(data.taskRows, []);
    assert.equal(data.onlineLabel, "0/0");
    assert.equal(data.channelLabel, "无");
    assert.match(data.hint, /0\/0 在线/);
    assert.match(data.hint, /确认对端已装 mesh/);
    cancel();
  });
});

await check("home 截断：10 台在线只显示 5 台、10 条任务只显示 3 条，并给提示", async () => {
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
    assert.match(data.hint, /还有 5 台未显示/);
    assert.match(data.hint, /共 10 条任务/);
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
    const types = view.children.map((n) => n.type);
    assert.equal(types[0], "text");
    assert.equal(types[1], "list");
    assert.equal(types[2], "row");
    const { nodes } = auditActions(view);
    assert.equal(nodes.length, 0);
  });
});

/* ───────────────────────── 4. peers 面板 ───────────────────────── */

console.log("\n—— 4. peers：在线 metric + 设备 list（无 options / 无 callout / 无派发复制）——");

await check("peers 视图：metric + list + 「刷新 / 打开网页(primary)」，没有 text/callout，设备只出现一次", async () => {
  await withUI(depsOf(), async (ui) => {
    const view = ui.panels[PANEL_PEERS].def.view({}, { locale: "zh-CN" });
    assert.equal(view.title, "设备");
    assert.deepEqual(view.children.map((n) => n.type), ["metric", "list", "actions"]);
    assert.equal(view.children[0].type, "metric");
    assert.deepEqual(view.children[0].value, { $: "data.onlineLabel" });
    const { nodes, primaries } = auditActions(view);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].length, 2);
    assert.equal(primaries, 1);
    assert.deepEqual(nodes[0].map((item) => item.action), ["refresh", "openWeb"]);
    assert.equal(nodes[0].find((item) => item.action === "openWeb").style, "primary");
    const { emitted, cancel } = await runData(ui.panels[PANEL_PEERS].def);
    const data = emitted[0];
    assert.equal(data.total, 3);
    assert.equal(data.online, 2);
    assert.equal(data.onlineLabel, "2/3");
    assert.match(data.summary, /usb\/lan/);
    assert.match(data.summary, /2\/3 在线/);
    const ids = data.rows.map((r) => r.action.args.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(new Set(ids), new Set(["peer-hos", "peer-win", "peer-off"]));
    for (const row of data.rows) assert.equal(row.action.id, PEERS_PEER_ACTION);
    assert.ok(!("options" in data), "peers 数据不应再有 options");
    assert.ok(!("hint" in data), "设备页不应再有 hint/callout 文案");
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes);
    cancel();
  });
});

await check("peers 行 action → 同一面板切详情（keyValue + 打开网页/返回）；返回回列表", async () => {
  await withUI(depsOf(), async (ui) => {
    const scope = { sessionId: "s1" };
    const effect = ui.panels[PANEL_PEERS].def.actions.openPeer(scope, { value: { id: "peer-hos" } });
    assert.deepEqual(effect, { refresh: true });
    const detail = ui.panels[PANEL_PEERS].def.view(scope, { locale: "zh-CN" });
    assert.equal(detail.title, "设备详情");
    assert.deepEqual(detail.children.map((n) => n.type), ["keyValue", "actions"]);
    assert.deepEqual(
      detail.children[1].items.map((item) => item.action),
      ["openWeb", "closePeer"],
    );
    assert.equal(ui.panels[PANEL_HOME].def.view(scope, { locale: "zh-CN" }).title, "Mesh");
    ui.panels[PANEL_PEERS].def.actions.closePeer(scope, {});
    assert.equal(ui.panels[PANEL_PEERS].def.view(scope, { locale: "zh-CN" }).title, "设备");
  });
});

await check("peers 空态：metric 0/0 + caption 提示去确认对端（没有 callout 也不空白）", async () => {
  const deps = depsOf({ discovery: makeDiscovery({ peers: [] }) });
  await withUI(deps, async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_PEERS].def);
    const data = emitted[0];
    assert.deepEqual(data.rows, []);
    assert.equal(data.onlineLabel, "0/0");
    assert.match(data.summary, /还没有发现其他设备/);
    assert.match(data.summary, /确认对端已装 mesh/);
    cancel();
  });
});

await check("超过 maxPeers 截断 20 台并提示；行数/字节不超限", async () => {
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

/* ───────────────────────── 5. tasks 面板 ───────────────────────── */

console.log("\n—— 5. tasks：入/出站 metric + 带 tone 的任务行 ——");

await check("tasks 视图：metric 行 ×2 + list + 刷新；数据 4 条、状态 tone 合法、行可复制 ID", async () => {
  await withUI(depsOf(), async (ui) => {
    const view = ui.panels[PANEL_TASKS].def.view({}, { locale: "zh-CN" });
    assert.equal(view.title, "任务");
    assert.deepEqual(view.children.map((n) => n.type), ["row", "list", "actions", "text"]);
    assert.equal(view.children[0].children.length, 2);
    const { emitted, cancel } = await runData(ui.panels[PANEL_TASKS].def);
    const data = emitted[0];
    assert.equal(data.inboundCount, "2");
    assert.equal(data.outboundCount, "2");
    assert.ok(data.rows.length <= 12);
    for (const row of data.rows) {
      assert.equal(row.action.id, TASKS_TASK_ACTION);
      assert.equal(typeof row.action.args.id, "string");
      assert.ok(VALID_TONES.has(row.tone), row.tone);
      assert.ok(["mail", "link"].includes(row.icon));
    }
    assert.ok(data.rows.some((r) => r.tone === "bad"));
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes);
    cancel();
  });
});

await check("tasks 空态：行空但提示去桌面 mesh_run（不崩）", async () => {
  const deps = depsOf({ getTasks: () => EMPTY_TASKS });
  await withUI(deps, async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_TASKS].def);
    const data = emitted[0];
    assert.deepEqual(data.rows, []);
    assert.match(data.hint, /mesh_run/);
    cancel();
  });
});

await check("getTasks() 抛错时返回空任务（绝不抛）", async () => {
  const deps = depsOf({
    getTasks: () => {
      throw new Error("tasks boom");
    },
  });
  await withUI(deps, async (ui) => {
    const { emitted, cancel } = await runData(ui.panels[PANEL_TASKS].def);
    const data = emitted[0];
    assert.equal(data.inboundCount, "0");
    assert.equal(data.outboundCount, "0");
    assert.ok(data.hint.length > 0);
    cancel();
  });
});

/* ───────────────────────── 6. 状态条 ───────────────────────── */

console.log("\n—— 6. 状态条（strip，≤24 字）——");

await check("有在线设备：Mesh · N 在线 · usb/lan，≤24 字，tone=good", async () => {
  await withUI(depsOf(), async (_ui, reg) => {
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
  await withUI(depsOf(), async (_ui, reg) => {
    const emitted = [];
    const cancel = reg.strips[0].fn({}, (d) => emitted.push(d), { locale: "en-US" });
    assert.ok([...emitted[0].text].length <= BRIDGE_LIMITS.stripText, emitted[0].text);
    cancel();
  });
  assert.equal(buildStripData([], "zh-CN").tone, "muted");
  assert.equal(buildStripData([], "zh-CN").text, "Mesh · 无在线设备");
});

/* ───────────────────────── 7. 点按效果 ───────────────────────── */

console.log("\n—— 7. 点按：refresh / open / detail / tasks（无 probe/copy）——");

await check("refresh → {refresh:true}；openPeers/openTasks/openWeb 直达对应页面", async () => {
  await withUI(depsOf(), async (ui) => {
    assert.deepEqual(ui.panels[PANEL_PEERS].def.actions.refresh(), { refresh: true });
    assert.deepEqual(ui.panels[PANEL_TASKS].def.actions.refresh(), { refresh: true });
    assert.deepEqual(ui.panels[PANEL_HOME].def.actions.openWeb({}, {}), { open: "web" });
    assert.deepEqual(ui.panels[PANEL_HOME].def.actions.openPeers({}, {}), { open: "panel:peers" });
    assert.deepEqual(ui.panels[PANEL_HOME].def.actions.openTasks({}, {}), { open: "panel:tasks" });
    assert.deepEqual(ui.panels[PANEL_PEERS].def.actions.openWeb({}, {}), { open: "web" });
  });
});

await check("产品收敛：遍历所有点按回调后 sendProbe 一次都没被调用（原生 UI 不再派发任务）", async () => {
  const calls = [];
  const deps = depsOf({
    sendProbe: async (arg) => {
      calls.push(arg);
      return { id: "should-not-happen" };
    },
  });
  await withUI(deps, async (ui) => {
    const scope = { sessionId: "s1" };
    for (const panel of [PANEL_HOME, PANEL_PEERS, PANEL_TASKS]) {
      for (const fn of Object.values(ui.panels[panel].def.actions)) {
        assert.doesNotThrow(() => fn(scope, { value: { id: "peer-hos", index: 0 } }));
        assert.doesNotThrow(() => fn(scope, {}));
      }
    }
    await sleep(20);
    assert.equal(calls.length, 0, `sendProbe 不应被原生 UI 调用，实际 ${calls.length} 次`);
  });
});

await check("任务行「复制 ID」：event.args.id 优先，无参数回退最后一条；无任务时 toast", async () => {
  await withUI(depsOf(), async (ui) => {
    const effect = ui.panels[PANEL_TASKS].def.actions.copyTask({ sessionId: "s1" }, { value: { id: "t-in-0001" } });
    assert.equal(effect.copy, "t-in-0001");
    assert.ok([...effect.copy].length <= BRIDGE_LIMITS.copy);
    assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
  });
  const emptyDeps = depsOf({ getTasks: () => EMPTY_TASKS });
  await withUI(emptyDeps, async (ui) => {
    const effect = ui.panels[PANEL_TASKS].def.actions.copyTask({}, {});
    assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
  });
});

await check("打开不存在的设备 → toast，不抛", async () => {
  await withUI(depsOf(), async (ui) => {
    const effect = ui.panels[PANEL_HOME].def.actions.openHomePeer({ sessionId: "s1" }, { value: { id: "nope" } });
    assert.match(effect.toast, /已不在列表/);
    assert.equal(ui.panels[PANEL_HOME].def.view({ sessionId: "s1" }, { locale: "zh-CN" }).title, "Mesh");
  });
});

await check("点按回调遇到垃圾 event 不抛", async () => {
  await withUI(depsOf(), async (ui) => {
    for (const panel of [PANEL_HOME, PANEL_PEERS, PANEL_TASKS]) {
      for (const fn of Object.values(ui.panels[panel].def.actions)) {
        assert.doesNotThrow(() => fn(undefined, undefined));
        assert.doesNotThrow(() => fn({}, { value: 42 }));
      }
    }
  });
});

/* ───────────────────────── 8. 调整主页（无 options） ───────────────────────── */

console.log("\n—— 8. home「调整主页」：list 行选中 + 按钮调整（无 options）——");

await check("openConfig 切到 config 视图（标题/结构），cfgRows 4 行且每行 action=selectWidget", async () => {
  await withUI(depsOf(), async (ui) => {
    const scope = { sessionId: "s1" };
    assert.deepEqual(ui.panels[PANEL_HOME].def.actions.openConfig(scope, {}), { refresh: true });
    const view = ui.panels[PANEL_HOME].def.view(scope, { locale: "zh-CN" });
    assert.equal(view.title, "调整主页");
    let options = 0;
    walkView(view, (n) => {
      if (n.type === "options") options += 1;
    });
    assert.equal(options, 0);
    const { emitted, cancel } = await runData(ui.panels[PANEL_HOME].def, { scope });
    const data = emitted[0];
    assert.equal(data.cfgRows.length, 4);
    for (const row of data.cfgRows) assert.equal(row.action.id, "selectWidget");
    assert.match(data.cfgRows[0].title, /1\. 概览/);
    assert.match(data.cfgHint, /已选 1\./);
    cancel();
  });
});

await check("selectWidget 用行 args 选行；moveDown/moveUp 改草稿顺序；cfgHint 跟着走", async () => {
  await withUI(depsOf(), async (ui) => {
    const scope = { sessionId: "s1" };
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    ui.panels[PANEL_HOME].def.actions.selectWidget(scope, { value: { index: 1 } });
    let data = (await runData(ui.panels[PANEL_HOME].def, { scope })).emitted[0];
    assert.match(data.cfgHint, /已选 2\./);
    ui.panels[PANEL_HOME].def.actions.moveDown(scope, {});
    data = (await runData(ui.panels[PANEL_HOME].def, { scope })).emitted[0];
    // 默认顺序 [概览, 在线设备, 最近任务, 快捷动作]：选中「在线设备」下移后它排到「最近任务」后面
    assert.match(data.cfgRows[1].title, /2\. 最近任务/);
    assert.match(data.cfgHint, /已选 3\./);
    ui.panels[PANEL_HOME].def.actions.moveUp(scope, {});
    data = (await runData(ui.panels[PANEL_HOME].def, { scope })).emitted[0];
    assert.match(data.cfgRows[1].title, /2\. 在线设备/);
  });
});

await check("toggleWidget：显示/隐藏，且不允许把最后一项也隐藏", async () => {
  await withUI(depsOf(), async (ui) => {
    const scope = { sessionId: "s1" };
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    ui.panels[PANEL_HOME].def.actions.toggleWidget(scope, {});
    const data = (await runData(ui.panels[PANEL_HOME].def, { scope })).emitted[0];
    assert.match(data.cfgRows[0].subtitle, /已隐藏/);
    for (let i = 1; i < 4; i += 1) {
      ui.panels[PANEL_HOME].def.actions.selectWidget(scope, { value: { index: i } });
      ui.panels[PANEL_HOME].def.actions.toggleWidget(scope, {});
    }
    ui.panels[PANEL_HOME].def.actions.selectWidget(scope, { value: { index: 3 } });
    const last = ui.panels[PANEL_HOME].def.actions.toggleWidget(scope, {});
    assert.match(last.toast ?? "", /至少保留一项/);
  });
});

await check("saveConfig：写 state（homeWidgets 数组）+ 回主页；saveState 抛错只 toast", async () => {
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
    assert.equal(ui.panels[PANEL_HOME].def.view(scope, { locale: "zh-CN" }).title, "Mesh");
    assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
  });
  const bad = depsOf({
    saveState: () => {
      throw new Error("disk boom");
    },
  });
  await withUI(bad, async (ui) => {
    const scope = { sessionId: "s2" };
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    const effect = ui.panels[PANEL_HOME].def.actions.saveConfig(scope, {});
    assert.ok([...effect.toast].length <= BRIDGE_LIMITS.toast);
  });
});

await check("resetConfig 写回默认布局并回主页；cancelConfig 不写 state 直接回主页", async () => {
  const saved = [];
  const deps = depsOf({ saveState: (patch) => saved.push(patch) });
  await withUI(deps, async (ui) => {
    const scope = { sessionId: "s1" };
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    ui.panels[PANEL_HOME].def.actions.resetConfig(scope, {});
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0][HOME_WIDGETS_STATE_KEY], DEFAULT_HOME_WIDGETS);
    assert.equal(ui.panels[PANEL_HOME].def.view(scope, { locale: "zh-CN" }).title, "Mesh");
    const before = saved.length;
    ui.panels[PANEL_HOME].def.actions.openConfig(scope, {});
    ui.panels[PANEL_HOME].def.actions.cancelConfig(scope, {});
    assert.equal(saved.length, before, "cancel 不应写 state");
    assert.equal(ui.panels[PANEL_HOME].def.view(scope, { locale: "zh-CN" }).title, "Mesh");
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
  assert.deepEqual(HOME_WIDGET_IDS, ["self", "devices", "tasks", "quick"]);
  assert.equal(
    loadHomeWidgets({
      loadState: () => {
        throw new Error("boom");
      },
    }).length,
    4,
  );
  assert.equal(
    saveHomeWidgets(
      {
        saveState: () => {
          throw new Error("boom");
        },
      },
      DEFAULT_HOME_WIDGETS,
    ),
    false,
  );
});

/* ───────────────────────── 9. 限流与清理 ───────────────────────── */

console.log("\n—— 9. 4Hz 限流、事件订阅与清理 ——");

await check("discovery change 事件被节流（≤4Hz），且 cancel 后不再 emit", async () => {
  const discovery = makeDiscovery();
  const deps = depsOf({ discovery });
  const ui = createDshGoUI(makeFakeScoped().scoped, deps, { rateMs: 60, tickMs: 10 * 60 * 1000, maxPeers: 20, maxTasks: 12 });
  const emitted = [];
  const cancel = ui.panels[PANEL_PEERS].def.data({ sessionId: "s1" }, (d) => emitted.push(d), { locale: "zh-CN" });
  assert.equal(emitted.length, 1);
  for (let i = 0; i < 6; i += 1) discovery.emitChange();
  await sleep(140);
  assert.ok(emitted.length <= 3, `emits=${emitted.length}`);
  const after = emitted.length;
  cancel();
  discovery.emitChange();
  await sleep(80);
  assert.equal(emitted.length, after, "cancel 之后不应再收到 change 推送");
  assert.equal(discovery.listenerCount("change"), 0, "cancel 应移除 change 监听");
  ui.dispose();
});

await check("dispose 幂等、清理所有 data 定时器", async () => {
  const deps = depsOf({ discovery: makeDiscovery() });
  const ui = createDshGoUI(makeFakeScoped().scoped, deps, { rateMs: 0, tickMs: 30, maxPeers: 20, maxTasks: 12 });
  const peersEmit = [];
  const dataCancel = ui.panels[PANEL_PEERS].def.data({}, (d) => peersEmit.push(d), {});
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

/* ───────────────────────── 10. 纯函数投影 + 清单一致性 ───────────────────────── */

console.log("\n—— 10. 投影函数 / 数据上限 / 清单标题 ——");

await check("平台 icon 映射：android→robot / win32→terminal / darwin→image / linux→code / 未知→team", () => {
  assert.equal(peerIcon({ osInfo: { platform: "android" } }), "robot");
  assert.equal(peerIcon({ osInfo: { platform: "win32" } }), "terminal");
  assert.equal(peerIcon({ osInfo: { platform: "darwin" } }), "image");
  assert.equal(peerIcon({ osInfo: { platform: "linux" } }), "code");
  assert.equal(peerIcon({}), "team");
  assert.equal(peerIcon({ os: "Windows 11" }), "terminal");
});

await check("peerRow / peerDetailItems：行带 action、详情 8 项（地址/系统/版本/通道/能力）、离线给「上次见过」", () => {
  const row = peerRow(PEERS[1], "zh-CN", "openPeer");
  assert.equal(row.title, "文超-win");
  assert.match(row.subtitle, /Windows 11/);
  assert.match(row.subtitle, /192\.168\.1\.6:45917/);
  assert.equal(row.trailing, "3ms");
  assert.equal(row.icon, "terminal");
  assert.deepEqual(row.action, { id: "openPeer", args: { id: "peer-win" } });
  const off = peerRow(PEERS[2], "zh-CN");
  assert.equal(off.trailing, "上次见过");
  assert.deepEqual(off.action, { id: PEERS_PEER_ACTION, args: { id: "peer-off" } });
  const items = peerDetailItems(PEERS[0], "zh-CN");
  assert.equal(items.length, 8);
  assert.deepEqual(
    items.map((x) => x.label),
    ["设备", "状态", "地址", "系统", "版本", "通道", "能力", "最后活跃"],
  );
  assert.match(items[2].value, /127\.0\.0\.1:46001/);
  assert.equal(items[1].tone, "good");
});

await check("taskRow / taskTone：成功→good、失败→bad、时间/线程副标题", () => {
  const flat = flattenTasks(TASKS);
  assert.equal(flat.length, 4);
  const okRow = taskRow(flat.find((x) => x.id === "t-out-0001"), "zh-CN", { id: "copyTask", args: { id: "t-out-0001" } });
  assert.equal(okRow.tone, "good");
  assert.equal(okRow.icon, "link");
  const failRow = taskRow(flat.find((x) => x.id === "t-out-0002"), "zh-CN");
  assert.equal(failRow.tone, "bad");
  assert.match(failRow.trailing, /fail/);
  assert.ok(failRow.subtitle.length > 0);
  assert.equal(taskTone({ dir: "out", ok: false }), "bad");
});

await check("formatTime：ISO 与毫秒时间戳都能格式化，垃圾输入给「—」", () => {
  assert.match(formatTime("2026-10-29T04:00:00.000Z"), /^10-29 \d{2}:\d{2}$/);
  assert.match(formatTime(new Date(2026, 0, 2, 3, 4).getTime()), /^01-02 03:04$/);
  assert.equal(formatTime("garbage"), "—");
  assert.equal(formatTime(undefined), "—");
  assert.equal(formatTime(0), "—");
});

await check("addressOf / channelTextOf / clip / displayName 基础投影", () => {
  assert.equal(addressOf({ host: "10.0.0.1", port: 42 }), "10.0.0.1:42");
  assert.equal(addressOf({ knownAddresses: ["lan:10.0.0.2:9"] }), "lan:10.0.0.2:9");
  assert.equal(addressOf({}), "—");
  assert.equal(channelTextOf(PEERS), "usb/lan");
  assert.equal(channelTextOf([]), "");
  assert.equal(clip("你好世界", 2), "你好");
  assert.equal(displayName({ machine: "localhost", host: "10.1.1.1" }), "10.1.1.1");
  assert.equal(displayName({ id: "abcdefghij" }), "peer-abcdefgh");
});

await check("所有面板数据都 ≤32KiB（极端 60 台设备 + 60 条任务）", () => {
  const manyPeers = Array.from({ length: 60 }, (_, i) => ({
    id: `p-${i}`,
    machine: `machine-${i}-长名字`,
    host: `10.0.0.${i}`,
    port: 45917,
    online: i < 30,
    transport: i % 3 === 0 ? "usb" : "lan",
    osInfo: { platform: "android", name: "Android", version: "15" },
    capabilitySummary: "8 核 · python 3.12 · 一堆能力摘要",
    version: "0.5.4-dshgo.9",
  }));
  const manyTasks = {
    inbound: Array.from({ length: 30 }, (_, i) => ({ id: `t-in-${i}`, fromMachine: "m", status: "dispatched", thread: "thread-name", receivedAt: new Date(NOW - i * 1000).toISOString() })),
    outbound: Array.from({ length: 30 }, (_, i) => ({ id: `t-out-${i}`, toMachine: "m", ok: i % 2 === 0, status: 200, thread: "thread", at: new Date(NOW - i * 1000).toISOString() })),
  };
  const home = buildHomeData({ peers: manyPeers, tasks: manyTasks, self: SELF, widgets: DEFAULT_HOME_WIDGETS, state: {}, locale: "zh-CN" });
  const peers = buildPeersData({ peers: manyPeers, state: {}, locale: "zh-CN" });
  const tasks = buildTasksData({ tasks: manyTasks, state: {}, locale: "zh-CN" });
  for (const [name, data] of [
    ["home", home],
    ["peers", peers],
    ["tasks", tasks],
  ]) {
    assert.ok(jsonBytes(data) <= BRIDGE_LIMITS.dataBytes, `${name} bytes=${jsonBytes(data)}`);
  }
  assert.equal(home.deviceRows.length, 5);
  assert.equal(home.taskRows.length, 3);
  assert.equal(peers.rows.length, 20);
  assert.equal(tasks.rows.length, 12);
});

await check("节点数变化（真机重做前后对照）：peers 5→4、detail 4→3、tasks 7、config 6、home 11", () => {
  const view = buildPeersView("zh-CN");
  const st = viewStats(view);
  assert.equal(st.nodes, 4);
  assert.equal(st.depth, 2);
  assert.equal(st.bytes, jsonBytes(view));
  assert.equal(viewStats(buildHomeView("zh-CN")).nodes, 11);
  assert.equal(viewStats(buildPeerDetailView("zh-CN", "closeHomePeer")).nodes, 3);
  assert.equal(viewStats(buildHomeConfigView("zh-CN")).nodes, 6);
  assert.equal(viewStats(buildTasksView("zh-CN")).nodes, 7);
  const data = buildPeersData({ peers: PEERS, state: {}, locale: "zh-CN" });
  assert.equal(jsonBytes(data), Buffer.byteLength(JSON.stringify(data), "utf8"));
});

await check("清单（package.json → dshGo）：home=Mesh / peers=设备 / tasks=任务，strip 指向 peers", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const panels = pkg.dshGo?.contributes?.panels ?? [];
  assert.deepEqual(panels.map((p) => p.id), ["home", "peers", "tasks"]);
  assert.equal(panels[0].title.zh, "Mesh");
  assert.equal(panels[1].title.zh, "设备");
  assert.equal(panels[2].title.zh, "任务");
  assert.equal(panels[1].title.en, "Devices");
  assert.equal(panels[2].title.en, "Tasks");
  const strip = pkg.dshGo?.contributes?.["composer.strip"] ?? [];
  assert.equal(strip.length, 1);
  assert.equal(strip[0].id, STRIP_ID);
  assert.equal(strip[0].panel, PANEL_PEERS);
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
