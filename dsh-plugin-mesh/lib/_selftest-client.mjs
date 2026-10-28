/**
 * mesh Web 面板的「窄屏 / 手机适配」自测（P2b），并作为 selftest:client 的入口。
 *
 * 分工：
 *   1. 这里先跑**窄屏专项**断言（CSS 断点/单列卡片/底部派发条/详情折叠/触控尺寸）；
 *   2. 全绿后再动态 import `_selftest-workbench.mjs`（原有 42 项桌面渲染回归）。
 *
 * 为什么能这么测：client.js 是手写 bundle，`__test` 暴露了组件；用一个最小
 * react stub 直接调用组件函数即可拿到元素树，再用 window.matchMedia 桩切换
 * 宽/窄两种视口 —— 不需要浏览器、不需要构建。
 *
 *   node lib/_selftest-client.mjs
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "client", "client.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

// ── 最小 react stub（与 _selftest-workbench.mjs 同一套语义）──
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
  Fragment: Symbol("Fragment"),
};

function propsFor(node) {
  const kids = node.children && node.children.length ? (node.children.length === 1 ? node.children[0] : node.children) : undefined;
  return kids === undefined ? node.props : { ...node.props, children: kids };
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) textOf(c, out);
    return out;
  }
  if (typeof node === "object") {
    if (typeof node.type === "function") {
      textOf(node.type(propsFor(node)), out);
      return out;
    }
    // 折叠区仍然挂载（做高度动画），但文字对用户不可见；断言只看可见内容。
    if (
      node.props &&
      node.props["aria-hidden"] === true &&
      String(node.props.className || "").includes("mesh-collapse")
    ) {
      return out;
    }
    textOf(node.children, out);
    const kids = node.props && node.props.children;
    if (kids !== undefined) textOf(kids, out);
    return out;
  }
  return out;
}

function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn));
  if (typeof node.type === "function") return walk(node.type(propsFor(node)), fn);
  fn(node);
  walk(node.children, fn);
  if (node.props && node.props.children !== undefined) walk(node.props.children, fn);
}

function classesOf(node) {
  const out = new Set();
  walk(node, (n) => {
    const cls = String((n.props && n.props.className) || "");
    for (const part of cls.split(/\s+/)) if (part) out.add(part);
  });
  return out;
}

function countByClass(node, cls) {
  let count = 0;
  walk(node, (n) => {
    if (String((n.props && n.props.className) || "").split(/\s+/).includes(cls)) count += 1;
  });
  return count;
}

/** 在一个 Fold 自己的 header 里找标题（不深入嵌套的 Fold）。 */
function foldHeadOf(fold, isRoot = true) {
  const kids = [];
  if (Array.isArray(fold.children)) kids.push(...fold.children);
  if (fold.props && fold.props.children !== undefined) kids.push(fold.props.children);
  for (const child of kids.flat(Infinity)) {
    if (!child || typeof child !== "object") continue;
    const cls = String((child.props && child.props.className) || "").split(/\s+/);
    if (!isRoot && cls.includes("mesh-fold")) continue;
    if (cls.includes("mesh-fold-head")) return child;
    const found = foldHeadOf(child, false);
    if (found) return found;
  }
  return null;
}

/** 收集所有 Fold 的标题/右侧说明（用于区分"页面里本来就有的折叠"和 P2b 的「详情」）。 */
function foldTitles(node) {
  const out = [];
  walk(node, (n) => {
    const cls = String((n.props && n.props.className) || "").split(/\s+/);
    if (!cls.includes("mesh-fold")) return;
    const head = foldHeadOf(n);
    let title = "";
    const rights = [];
    if (head) {
      walk(head, (child) => {
        const c = String((child.props && child.props.className) || "").split(/\s+/);
        if (c.includes("mesh-fold-title")) title += textOf(child).join("");
        if (c.includes("mesh-fold-status")) rights.push(textOf(child).join(""));
      });
    }
    out.push({ title: title.trim(), right: rights.join(" ").trim() });
  });
  return out;
}

// ── 加载 bundle（window 桩要在加载前就位；组件闭包捕获同一个对象）──
const testWindow = {
  __ModuleLoader__: {
    load: (entry) => {
      captured = entry;
    },
  },
};
let captured = null;
globalThis.window = testWindow;
const source = readFileSync(BUNDLE, "utf8");
new Function("window", `${source}\n`)(testWindow);
const mod = captured.factory((name) => {
  if (name === "react") return react;
  throw new Error(`未预期的依赖：${name}`);
});
const __t = mod.__test;
const noop = () => {};

/**
 * 切换视口：只影响窄屏 hook 读取的 `(max-width: 760px)`；
 * reduced-motion 之类其它媒体查询一律 false。
 */
function withNarrow(narrow, fn) {
  const prev = testWindow.matchMedia;
  testWindow.matchMedia = (media) => ({
    media: String(media),
    matches: String(media).includes("max-width") ? !!narrow : false,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
  });
  try {
    return fn();
  } finally {
    if (prev === undefined) delete testWindow.matchMedia;
    else testWindow.matchMedia = prev;
  }
}

const now = Date.now();
const peer = {
  id: "phone-1",
  machine: "phone",
  online: true,
  host: "192.168.1.19",
  port: 45917,
  hostname: "phone-host",
  mac: "00:00:00:00:00:00",
  os: "android 15 (6.6.30-android15)",
  user: "root",
  profile: "web",
  version: "0.5.4",
  lastSeen: now,
  transport: "lan",
  endpoints: [
    { transport: "lan", host: "192.168.1.19", port: 45917, verified: true, rttMs: 8 },
    { transport: "usb", channel: "usb:1441e87a", host: "127.0.0.1", port: 46000, verified: true, rttMs: 3 },
  ],
  capabilities: { runtimes: { node: "24.22.1" }, cpuCores: 8, memMb: 15112, arch: "arm64" },
  capabilitiesStale: false,
};

console.log("\n── 窄屏（P2b）：CSS 断点与关键规则 ──");

test("bundle 契约与 P2b 导出仍在（id 仍是包名，__test 暴露窄屏能力）", () => {
  assert.equal(captured.id, "dsh-plugin-mesh");
  assert.equal(__t.MOBILE_MAX_WIDTH, 760);
  assert.equal(typeof __t.useNarrowViewport, "function");
  assert.equal(typeof __t.isNarrowViewport, "function");
  assert.equal(typeof __t.MobileDispatchBar, "function");
  assert.equal(typeof __t.peerTransportBadges, "function");
});

test("CSS 有 ≤760px 媒体查询与单列卡片/大触控规则，且 reduced-motion 块仍在", () => {
  const css = source;
  assert.ok(css.includes("@media (max-width: 760px)"), "缺少 760px 断点");
  assert.ok(css.includes(".mesh-list.is-narrow"), "缺少窄屏单列设备列表样式");
  assert.ok(/\.mesh-list\.is-narrow \.mesh-row \{[^}]*min-height:\s*64px/.test(css), "设备卡触控高度应 ≥64px");
  assert.ok(css.includes(".mesh-row-badges"), "缺少小屏状态/transport 徽章样式");
  assert.ok(css.includes(".mesh-mobile-bar"), "缺少底部派发条样式");
  assert.ok(/\.mesh-mobile-bar \.mesh-btn \{[^}]*min-height:\s*48px/.test(css), "底部主按钮应 ≥48px");
  assert.ok(css.includes("env(safe-area-inset-bottom"), "底部条要照顾 iPhone/Android 手势区安全边");
  assert.ok(css.includes(".mesh-mobile-bar-panel"), "缺少可展开的底部面板样式");
  assert.ok(css.includes(".mesh-detail.is-narrow"), "缺少窄屏详情大触控样式");
  assert.ok(css.includes("@media (prefers-reduced-motion: reduce)"), "reduced-motion 块被误删");
  assert.ok(
    css.indexOf("@media (max-width: 760px)") < css.indexOf("@media (prefers-reduced-motion: reduce)"),
    "窄屏块应在 reduced-motion 之前（后者是兜底覆盖）",
  );
});

console.log("\n── 窄屏：设备列表单列卡片 + transport 徽章 ──");

test("宽屏 DeviceList/DeviceRow：没有 is-narrow、没有徽章（桌面外观不变）", () => {
  withNarrow(false, () => {
    const list = __t.DeviceList({ selfPeer: null, peers: [peer], selectedId: null, onSelect: noop, now, lastOk: now, onScan: noop, scanning: false });
    const classes = classesOf(list);
    assert.ok(classes.has("mesh-list"));
    assert.ok(!classes.has("is-narrow"), "宽屏不该带 is-narrow");
    assert.ok(![...classes].some((c) => c === "mesh-row-badges"), "宽屏不该渲染小屏徽章");
    const txt = textOf(list).join(" ");
    assert.ok(!txt.includes("USB"), `宽屏不该出现 USB 通道徽章：${txt}`);
  });
});

test("窄屏 DeviceList/DeviceRow：is-narrow + 单列徽章（在线 / USB / 局域网）", () => {
  withNarrow(true, () => {
    const list = __t.DeviceList({ selfPeer: null, peers: [peer], selectedId: null, onSelect: noop, now, lastOk: now, onScan: noop, scanning: false });
    const classes = classesOf(list);
    assert.ok(classes.has("is-narrow"), "窄屏设备列表要带 is-narrow（单列卡片）");
    assert.ok(classes.has("mesh-row-badges"), "窄屏设备行要有状态/通道徽章");
    const txt = textOf(list).join(" ");
    assert.ok(txt.includes("在线"), txt);
    assert.ok(txt.includes("USB"), `窄屏应显示 USB 通道徽章：${txt}`);
    assert.ok(txt.includes("局域网"), `窄屏应显示局域网通道徽章：${txt}`);
    const row = __t.DeviceRow({ peer, active: false, onSelect: noop, now, index: 0 });
    assert.ok(classesOf(row).has("is-narrow"), "DeviceRow 本身也要带 is-narrow（触控/字号）");
  });
});

test("窄屏：同一个 peer 多个通道只各显示一次，最多 3 个徽章，不崩", () => {
  const badges = __t.peerTransportBadges({
    endpoints: [
      { transport: "lan" },
      { transport: "lan" },
      { transport: "usb" },
      { transport: "tsnet" },
      { transport: "weird" },
    ],
  });
  assert.deepEqual(badges.map((b) => b.label), ["局域网", "USB", "互联网"]);
  assert.deepEqual(__t.peerTransportBadges({}), []);
  assert.deepEqual(__t.peerTransportBadges(null), []);
});

console.log("\n── 窄屏：设备详情折叠 / 主操作大按钮 ──");

test("窄屏 DeviceDetail：能力/通道/身份收进「详情」折叠（默认收起）", () => {
  withNarrow(true, () => {
    const el = __t.DeviceDetail({ peer, now, onCompose: noop, onProbe: noop, onBack: noop });
    assert.ok(classesOf(el).has("is-narrow"), "详情根节点要带 is-narrow");
    const folds = foldTitles(el);
    assert.ok(
      folds.some((f) => f.title === "详情" && f.right.includes("能力 · 通道 · 身份")),
      `窄屏应有 P2b「详情」折叠，实际：${JSON.stringify(folds)}`,
    );
    const txt = textOf(el).join(" ");
    assert.ok(!txt.includes("node 24.22.1"), `折叠收起时能力细节不该占首屏：${txt.slice(0, 200)}`);
    assert.ok(txt.includes("运行中") || txt.includes("在线"), "状态要留在首屏");
  });
});

test("宽屏 DeviceDetail：保持原样（三段直接铺开、没有 P2b「详情」折叠）", () => {
  withNarrow(false, () => {
    const el = __t.DeviceDetail({ peer, now, onCompose: noop, onProbe: noop, onBack: noop });
    assert.ok(!classesOf(el).has("is-narrow"));
    const folds = foldTitles(el);
    assert.ok(
      !folds.some((f) => f.title === "详情" && f.right.includes("能力 · 通道 · 身份")),
      `宽屏不该出现 P2b「详情」折叠：${JSON.stringify(folds)}`,
    );
    const txt = textOf(el).join(" ");
    assert.ok(txt.includes("24.22.1"), `宽屏能力信息应直接可见：${txt.slice(0, 200)}`);
  });
});

console.log("\n── 窄屏：底部固定派发条 + 可展开面板 ──");

test("MobileDispatchBar：收起只留一条（≥48px 主按钮），展开出现完整派发面板", () => {
  const closed = __t.MobileDispatchBar({ peers: [peer], hostDown: false, open: false, onToggle: noop, onScan: noop, scanning: false, onDispatched: noop });
  const closedClasses = classesOf(closed);
  assert.ok(closedClasses.has("mesh-mobile-bar"));
  assert.ok(!closedClasses.has("mesh-mobile-bar-panel"), "收起时不该展开面板");
  const closedText = textOf(closed).join(" ");
  assert.ok(closedText.includes("派发任务"), closedText);
  assert.ok(closedText.includes("1 / 1 台在线"), `应显示在线设备数：${closedText}`);

  const open = __t.MobileDispatchBar({ peers: [peer], hostDown: false, open: true, onToggle: noop, onScan: noop, scanning: false, onDispatched: noop });
  const openClasses = classesOf(open);
  assert.ok(openClasses.has("mesh-mobile-bar-panel"), "展开时应有面板");
  assert.ok(openClasses.has("mesh-mobile-dispatch"));
  const openText = textOf(open).join(" ");
  assert.ok(openText.includes("要对方做什么？"), `展开后应复用完整派发表单：${openText.slice(0, 200)}`);
  assert.ok(openText.includes("收起派发"), openText.slice(0, 80));
});

test("窄屏 HomeBoard：不再重复渲染内联派发卡（交给底部条）；宽屏保持有", () => {
  const boardProps = {
    state: { config: {}, tsnet: { channels: [], enabled: false } },
    self: {},
    peers: [],
    tasks: [],
    now,
    lastOk: now,
    focus: false,
    layout: [],
    sizes: {},
    customCards: [],
    density: "comfortable",
    onLayoutChange: noop,
    onFocusChange: noop,
    onSizesChange: noop,
    onCustomCardsChange: noop,
    onDensityChange: noop,
    onReset: noop,
    onDevices: noop,
    onTasks: noop,
    onConnect: noop,
    onWeb: noop,
    onSsh: noop,
    onScan: noop,
    scanning: false,
    firstRun: null,
    hostDown: false,
    onDispatched: noop,
  };
  withNarrow(true, () => {
    const el = __t.HomeBoard(boardProps);
    assert.ok(classesOf(el).has("is-narrow"));
    assert.equal(countByClass(el, "mesh-dispatch"), 0, "窄屏主页不该再有内联派发卡");
  });
  withNarrow(false, () => {
    const el = __t.HomeBoard(boardProps);
    assert.ok(!classesOf(el).has("is-narrow"));
    assert.equal(countByClass(el, "mesh-dispatch"), 1, "宽屏主页应保留原来的派发面板");
  });
});

console.log("\n── 视口探测的健壮性（无 matchMedia / 抛错也不能崩）──");

test("isNarrowViewport：matchMedia 优先；没有 matchMedia 时退回 innerWidth", () => {
  withNarrow(true, () => assert.equal(__t.isNarrowViewport(), true));
  withNarrow(false, () => assert.equal(__t.isNarrowViewport(), false));
  delete testWindow.matchMedia;
  testWindow.innerWidth = 390;
  assert.equal(__t.isNarrowViewport(), true, "手机 WebView 无 matchMedia 时应按宽度判窄屏");
  testWindow.innerWidth = 1280;
  assert.equal(__t.isNarrowViewport(), false);
  delete testWindow.innerWidth;
  assert.equal(__t.isNarrowViewport(), false, "探测不到就按宽屏（桌面默认优先）");
});

test("matchMedia 抛错时按宽屏兜底，组件照常渲染不崩", () => {
  const prev = testWindow.matchMedia;
  testWindow.matchMedia = () => {
    throw new Error("no media support");
  };
  try {
    const row = __t.DeviceRow({ peer, active: false, onSelect: noop, now, index: 0 });
    assert.ok(textOf(row).join(" ").includes("phone"));
    const list = __t.DeviceList({ selfPeer: null, peers: [peer], selectedId: null, onSelect: noop, now, lastOk: now, onScan: noop, scanning: false });
    assert.ok(textOf(list).join(" ").includes("phone"));
    const detail = __t.DeviceDetail({ peer, now, onCompose: noop, onProbe: noop, onBack: noop });
    assert.ok(textOf(detail).join(" ").includes("phone"));
  } finally {
    if (prev === undefined) delete testWindow.matchMedia;
    else testWindow.matchMedia = prev;
  }
});

test("MeshApp 无 state（加载态）：窄屏带 is-narrow，宽屏不带 —— 都不会崩", () => {
  withNarrow(true, () => {
    const el = __t.MeshApp({});
    assert.ok(classesOf(el).has("is-narrow"));
  });
  withNarrow(false, () => {
    const el = __t.MeshApp({});
    assert.ok(!classesOf(el).has("is-narrow"));
  });
});

console.log(`\n窄屏专项：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.error("窄屏专项失败，跳过桌面回归（先修上面的 ✗）");
  process.exit(1);
}

// 原有 42 项桌面渲染回归（动态 import：它会在结束时自行 process.exit）
await import("./_selftest-workbench.mjs");
