/**
 * Mesh 工作台（client.js）的渲染自测。
 *
 * 与旧的 _selftest-client.mjs 不同：这一版不依赖具体组件的旧名字，
 * 而是直接拿 __test 导出的新组件，用最小 react stub 渲染成元素树，
 * 断言“用户能看到的文案”和“坏数据不崩”。
 *
 *   node lib/_selftest-workbench.mjs
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

async function testAsync(name, fn) {
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

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
  Fragment: Symbol("Fragment"),
};

/** 真实 react 会把第三个参数塞进 props.children；stub 里要手动补上。 */
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
    // Collapsed sections are still mounted for the height animation, but their
    // text is not user-visible; the assertions describe visible content.
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

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      captured = entry;
    },
  },
};

const source = readFileSync(BUNDLE, "utf8");
new Function("window", `${source}\n`)(globalThis.window);
const mod = captured.factory((name) => {
  if (name === "react") return react;
  throw new Error(`未预期的依赖：${name}`);
});
const {
  MeshApp,
  HomeView,
  HomeBoard,
  DeviceDetail,
  DeviceRow,
  CapabilityChips,
  TaskRow,
  TaskDetail,
  SettingsView,
  Diagnostics,
  Composer,
  DispatchPanel,
  DeviceList,
  TasksView,
  TopBar,
  TransferComposer,
  TransferLog,
  deriveAnchor,
  snapshotFor,
  anchorLabel,
  transferPrompt,
  transferMarkdown,
  currentSessionId,
  sendToAgent,
  PairingBody,
  TsnetBody,
} = mod.__test;

const noop = () => {};
const now = Date.now();
const peer = {
  id: "p1",
  machine: "winbox",
  online: true,
  host: "192.168.1.9",
  port: 45917,
  hostname: "winbox-host",
  mac: "aa:bb",
  os: "win32 10.0",
  user: "u",
  profile: "desktop",
  version: "0.3.33",
  lastSeen: now,
  transport: "lan",
  endpoints: [{ transport: "lan", host: "192.168.1.9", port: 45917, verified: true, okCount: 10, failCount: 0, rttMs: 8 }],
  capabilities: { runtimes: { go: "1.25", python: "3.12" }, cpuCores: 8, memMb: 16384, arch: "amd64", gpu: { present: true, name: "RTX 3060", vramMb: 12288 } },
  capabilitiesStale: false,
};

console.log("\n── bundle 能被加载 ──");
test("bundle 的 id 是包名，apply 注册两个槽位", () => {
  assert.equal(captured.id, "dsh-plugin-mesh");
  const regs = [];
  mod.apply({
    slots: {
      inject: (name, cb) => {
        cb();
        regs.push(name);
      },
      register: (spec) => regs.push(spec),
    },
  });
  assert.ok(regs.includes("sidebar.panellist"));
  assert.ok(regs.includes("main"));
});

console.log("\n── 设备行 / 详情：离线与缺地址 ──");
test("设备行显示名字、在线状态与系统", () => {
  const txt = textOf(DeviceRow({ peer, active: true, onSelect: noop, now })).join(" ");
  assert.ok(txt.includes("winbox"), txt);
  assert.ok(txt.includes("在线"), txt);
  assert.ok(txt.includes("Windows"), txt);
});

test("离线 + host 为空 + 有 endpoint 时，用 endpoint 地址，不显示 ?:? / :0", () => {
  const offline = { ...peer, online: false, host: "", port: 0, transport: null };
  const txt = textOf(DeviceDetail({ peer: offline, now, onCompose: noop, onProbe: noop, onBack: noop })).join(" ");
  assert.ok(txt.includes("离线"), txt);
  assert.ok(txt.includes("192.168.1.9:45917"), txt);
  assert.ok(!txt.includes("?:?"), txt);
  assert.ok(!txt.includes(":0"), txt);
});

test("完全没地址时显示“地址未知”，而不是空白或问号", () => {
  const offline = { ...peer, online: false, host: "", port: 0, endpoints: [], capabilities: null };
  const txt = textOf(DeviceDetail({ peer: offline, now, onCompose: noop, onProbe: noop, onBack: noop })).join(" ");
  assert.ok(txt.includes("地址未知"), txt);
});

console.log("\n── 能力：三种“不知道”分开 ──");
test("有运行时 → 徽章；没上报 → 说明“还没有上报能力”", () => {
  const has = textOf(CapabilityChips({ caps: peer.capabilities })).join(" ");
  assert.ok(has.includes("python"), has);
  assert.ok(has.includes("3.12"), has);
  assert.ok(has.includes("RTX 3060"), has);
  assert.ok(has.includes("8 核"), has);

  const unknown = textOf(DeviceDetail({ peer: { ...peer, capabilities: null }, now, onCompose: noop, onProbe: noop, onBack: noop })).join(" ");
  assert.ok(unknown.includes("对端还没有上报能力"), unknown);
});

test("上报了但确实没有运行时 → 说“未探到运行时”", () => {
  const txt = textOf(CapabilityChips({ caps: { runtimes: {} } })).join(" ");
  assert.ok(txt.includes("未探到运行时"), txt);
});

test("能力过期 / 探测未探准 → 显示可见提示（不只 hover）", () => {
  const stale = textOf(DeviceDetail({ peer: { ...peer, capabilitiesStale: true }, now, onCompose: noop, onProbe: noop, onBack: noop })).join(" ");
  assert.ok(stale.includes("能力可能过期") || stale.includes("数据可能已过期"), stale);
  const incomplete = textOf(DeviceDetail({ peer: { ...peer, capabilities: { ...peer.capabilities, runtimesIncomplete: true } }, now, onCompose: noop, onProbe: noop, onBack: noop })).join(" ");
  assert.ok(incomplete.includes("不能当结论"), incomplete);
});

test("坏数据不崩", () => {
  for (const junk of ["python", 42, [], undefined, { runtimes: "nope" }]) {
    const el = DeviceDetail({ peer: { ...peer, capabilities: junk }, now, onCompose: noop, onProbe: noop, onBack: noop });
    assert.ok(el);
  }
});

console.log("\n── 任务：状态与详情 ──");
test("任务行把英文状态翻成中文", () => {
  const task = { key: "k", dir: "in", id: "t1", peer: "winbox", at: now, text: "跑一下构建", thread: "", status: "noted-only", raw: {} };
  const txt = textOf(TaskRow({ task, active: true, onSelect: noop, now })).join(" ");
  assert.ok(txt.includes("仅记录"), txt);
  assert.ok(!txt.includes("noted-only"), txt);
});

test("失败的发出任务能看到原因与重试", () => {
  const task = { key: "k", dir: "out", id: "t2", peer: "winbox", at: now, text: "构建", thread: "", status: "failed", raw: { ok: false, status: 500, error: "boom" } };
  const txt = textOf(TaskDetail({ task, now, onCopy: noop, onRetry: noop, onBack: noop })).join(" ");
  assert.ok(txt.includes("失败原因：boom"), txt);
  assert.ok(txt.includes("重试"), txt);
});

console.log("\n── 连接：配对码 / Tailscale ──");
test("配对关闭时给出“启用配对码”，不是让人改 YAML", () => {
  const txt = textOf(PairingBody({ self: { secret: "x".repeat(32) }, cfg: { requirePairing: false }, push: noop, reload: async () => {} })).join(" ");
  assert.ok(txt.includes("启用配对码"), txt);
  assert.ok(!txt.includes("改 YAML"), txt);
});

test("配对开启时给出“停用配对码”", () => {
  const txt = textOf(PairingBody({ self: { secret: "x".repeat(32) }, cfg: { requirePairing: true }, push: noop, reload: async () => {} })).join(" ");
  assert.ok(txt.includes("停用配对码"), txt);
});

test("Tailscale 未启用时，授权地址是可见文本，并说明 Reusable", () => {
  const tsnet = { enabled: false, authKeySaved: false, controlUrl: "", node: null, recentEvents: [] };
  const el = TsnetBody({ tsnet, push: noop, reload: async () => {} });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("https://console.tailscale.com/admin/settings/keys"), txt.slice(0, 300));
  assert.ok(txt.includes("Reusable"), txt);
  assert.ok(txt.includes("授权码"), txt);
  let disabled = false;
  walk(el, (n) => {
    if (n.type === "button" && n.props && n.props.disabled === true) disabled = true;
  });
  assert.ok(disabled, "没有授权码时，连接按钮应禁用");
});

console.log("\n── 外壳 / 设置 / 派发 sheet ──");
test("无 state 时 MeshApp 渲染加载态与顶栏，不崩", () => {
  const txt = textOf(MeshApp({})).join(" ");
  assert.ok(txt.includes("Mesh"), txt);
  assert.ok(txt.includes("正在读取 Mesh 状态"), txt);
  assert.ok(txt.includes("设备"), txt);
  assert.ok(txt.includes("任务"), txt);
  assert.ok(txt.includes("连接"), txt);
});

const state = {
  ok: true,
  self: { machine: "Rosmontis喵", host: "10.30.191.107", port: 45917, hostname: "Rosmontis", mac: "ac:f2", platform: "win32", version: "0.3.33", addresses: ["10.30.191.107"], capabilities: peer.capabilities, secret: "x".repeat(32), needsName: false },
  config: { requirePairing: false, scanIntervalMs: 60000, pingIntervalMs: 10000, useMulticast: true },
  tsnet: { enabled: false, authKeySaved: false, controlUrl: "", node: null, recentEvents: [] },
  peers: [peer],
  inbound: [],
  outbound: [],
  throttled: [],
  duplicateNames: [],
};

test("主页默认卡片：概览/设备/任务/配对/联网，诊断默认隐藏", () => {
  const txt = textOf(HomeView({
    state,
    self: state.self,
    peers: [peer],
    tasks: [],
    now,
    lastOk: now,
    focus: false,
    layout: ["overview", "devices", "tasks", "pairing", "tsnet"],
    onLayoutChange: noop,
    onFocusChange: noop,
    onReset: noop,
    onDevices: noop,
    onTasks: noop,
    onConnect: noop,
    onScan: noop,
    scanning: false,
    firstRun: null,
  })).join(" ");
  assert.ok(txt.includes("主页"), txt);
  assert.ok(txt.includes("概览"), txt);
  assert.ok(txt.includes("设备"), txt);
  assert.ok(txt.includes("最近任务"), txt);
  assert.ok(txt.includes("配对码"), txt);
  assert.ok(txt.includes("互联网组网"), txt);
  assert.ok(!txt.includes("诊断"), "诊断默认隐藏在自定义里");
});

test("专注模式在主页可见", () => {
  const txt = textOf(HomeView({
    state,
    self: state.self,
    peers: [peer],
    tasks: [],
    now,
    lastOk: now,
    focus: true,
    layout: ["overview"],
    onLayoutChange: noop,
    onFocusChange: noop,
    onReset: noop,
    onDevices: noop,
    onTasks: noop,
    onConnect: noop,
    onScan: noop,
    scanning: false,
    firstRun: null,
  })).join(" ");
  assert.ok(txt.includes("专注模式"), txt);
  assert.ok(txt.includes("每 15 秒刷新"), txt);
});

test("主页把派发任务面板放在最底下（卡片之后）", () => {
  const txt = textOf(HomeBoard({
    state,
    self: state.self,
    peers: [peer],
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
    onScan: noop,
    scanning: false,
    hostDown: false,
    onDispatched: noop,
    firstRun: null,
  })).join(" ");
  assert.ok(txt.includes("派发任务"), txt);
  assert.ok(txt.includes("要对方做什么"), txt);
  const cardTail = txt.indexOf("主页上的卡片都收起来了");
  const dispatch = txt.indexOf("派发任务");
  assert.ok(cardTail >= 0 && dispatch > cardTail, "派发面板应在卡片区之后");
});

test("多 tailnet：两条通道各自显示状态与操作，页头汇总为 1/2 条", () => {
  const channels = [
    {
      id: "ch-aaa",
      label: "个人",
      enabled: true,
      authKeySaved: true,
      controlUrl: "",
      node: { phase: "running", hostname: "dsh-mac", selfIpv4: "100.64.0.9", selfDnsName: "dsh-mac.tailnet.ts.net", forwards: [], diagnostics: [] },
      recentEvents: [],
    },
    {
      id: "ch-bbb",
      label: "公司",
      enabled: true,
      authKeySaved: true,
      controlUrl: "https://hs.example",
      node: { phase: "idle", hostname: "dsh-mac" },
      recentEvents: [],
    },
  ];
  const tsnet = { enabled: true, channels, node: channels[0].node, recentEvents: [] };
  const body = textOf(TsnetBody({ tsnet, push: noop, reload: async () => {} })).join(" ");
  assert.ok(body.includes("个人"), body.slice(0, 300));
  assert.ok(body.includes("公司"), body.slice(0, 300));
  assert.ok(body.includes("100.64.0.9"), "要显示每条通道自己的 tailnet 地址");
  assert.ok(body.includes("断开"), "已连接的通道要能单独断开");
  assert.ok(body.includes("连接"), "未连接的通道要能单独连接");
  assert.ok(body.includes("ch-aaa"), "显示通道 id，便于区分同名/多条 tailnet");
  assert.ok(body.includes("添加通道"), "要能继续添加通道");

  const view = textOf(
    SettingsView({ ...{ state: { ...state, tsnet } }, open: null, onOpen: noop, onSaveName: async () => true, nameBusy: false, push: noop, reload: async () => {} }),
  ).join(" ");
  assert.ok(view.includes("已连接 1/2 条"), view.slice(0, 400));
});

test("多 tailnet：全部断开时不再显示“已连接”，但仍列出通道", () => {
  const tsnet = {
    enabled: true,
    channels: [
      { id: "ch-aaa", label: "个人", enabled: true, authKeySaved: true, node: { phase: "exited" }, recentEvents: [] },
      { id: "ch-bbb", label: "公司", enabled: false, authKeySaved: false, node: null, recentEvents: [] },
    ],
  };
  const view = textOf(
    SettingsView({ state: { ...state, tsnet }, open: "tsnet", onOpen: noop, onSaveName: async () => true, nameBusy: false, push: noop, reload: async () => {} }),
  ).join(" ");
  assert.ok(!view.includes("已连接 1/2"), view.slice(0, 400));
  assert.ok(view.includes("个人"));
  assert.ok(view.includes("公司"));
});

console.log("\n── 视图里不再重复 tab 名 ──");

/** 收集某个 class 上的可见文字，用来钉住「标题写了什么」。 */
function textsOfClass(el, className) {
  const out = [];
  walk(el, (n) => {
    if (n.props && n.props.className === className) out.push(textOf(n).join("").trim());
  });
  return out;
}

test("主页不再重复写「主页」标题（tab 上已经有）", () => {
  const el = HomeBoard({
    state, self: state.self, peers: [peer], tasks: [], now, lastOk: now, focus: false,
    layout: [], sizes: {}, customCards: [], density: "comfortable",
    onLayoutChange: noop, onFocusChange: noop, onSizesChange: noop, onCustomCardsChange: noop,
    onDensityChange: noop, onReset: noop, onDevices: noop, onTasks: noop, onConnect: noop,
    onScan: noop, scanning: false, hostDown: false, onDispatched: noop, firstRun: null,
  });
  assert.deepEqual(textsOfClass(el, "mesh-home-title"), [], "不该再有 mesh-home-title 这种重复标题");
});

test("设备页左栏只写台数，不重复「设备」", () => {
  const titles = textsOfClass(DeviceList({ selfPeer: state.self, peers: [peer], selectedId: null, onSelect: noop, now, lastOk: now, onScan: noop, scanning: false }), "mesh-pane-title");
  assert.deepEqual(titles, ["1 台设备"]);
});

test("任务页左栏只写条数，不重复「任务」", () => {
  const el = TasksView({ state, filter: "all", onFilter: noop, selectedKey: null, onSelect: noop, pane: "list", onBack: noop, onRetry: noop, onCopy: noop, push: noop, reload: async () => {}, now, onGoDevices: noop });
  const titles = textsOfClass(el, "mesh-pane-title");
  assert.equal(titles.length, 1, titles.join("|"));
  assert.ok(/条任务$/.test(titles[0]), titles[0]);
  assert.notEqual(titles[0], "任务");
});

test("诊断卡显示「进程版本 / 磁盘版本」，漂移时说清要重启", () => {
  const drift = {
    self: { version: "0.5.2", diskVersion: "0.5.3", versionDrift: true, port: 45917 },
    config: {},
    peers: [],
  };
  const txt = textOf(Diagnostics({ state: drift, push: noop })).join(" ");
  assert.ok(txt.includes("版本（进程）"), txt);
  assert.ok(txt.includes("版本（磁盘）"), txt);
  assert.ok(txt.includes("重启 DSH 后新版本才生效"), txt);

  // 没漂移时不该吓人
  const same = { self: { version: "0.5.2", diskVersion: "0.5.2", versionDrift: false }, config: {}, peers: [] };
  assert.ok(!textOf(Diagnostics({ state: same, push: noop })).join(" ").includes("重启 DSH"));
});

test("连接页不再重复写「连接」大标题", () => {
  const el = SettingsView({ state, open: null, onOpen: noop, onSaveName: async () => true, nameBusy: false, push: noop, reload: async () => {} });
  let h1 = 0;
  walk(el, (n) => {
    if (n.type === "h1") h1 += 1;
  });
  assert.equal(h1, 0, "tab 已经叫「连接」，正文不必再来一个 h1");
});

console.log("\n── 系统身份（osInfo / systems / WSL）──");

const winPeer = {
  ...peer,
  os: "win32 10.0.22631",
  osInfo: { platform: "win32", name: "Windows 11 Home China", version: "10.0.22631", distro: "", kernel: "10.0.22631", desktop: "", arch: "x64" },
  systems: [
    { kind: "host", platform: "win32", name: "Windows 11 Home China", version: "10.0.22631" },
    { kind: "wsl", platform: "linux", name: "Ubuntu", version: "22.04", distro: "ubuntu" },
  ],
  capabilities: { ...peer.capabilities, wsl: [{ name: "Ubuntu", runtimes: { node: "22.1", python: "3.12" }, error: "" }] },
};

test("设备详情用结构化 osInfo（不再是 win32 10.0.xxx 这种机器串）", () => {
  const txt = textOf(DeviceDetail({ peer: winPeer, now, onCompose: noop, onProbe: noop, onBack: noop })).join(" ");
  assert.ok(txt.includes("Windows 11 Home China"), txt);
});

test("同一台机器上的 WSL 单独标出来，不混进宿主机", () => {
  const txt = textOf(DeviceDetail({ peer: winPeer, now, onCompose: noop, onProbe: noop, onBack: noop })).join(" ");
  assert.ok(txt.includes("WSL Ubuntu 22.04"), `应显示 WSL 发行版：${txt}`);
});

test("老对端（只有 os 字符串）不能崩，回退到 osLabel", () => {
  const legacy = { ...peer, os: "linux 6.1", osInfo: null, systems: null, capabilities: { runtimes: {} } };
  const txt = textOf(DeviceDetail({ peer: legacy, now, onCompose: noop, onProbe: noop, onBack: noop })).join(" ");
  assert.ok(txt.includes("Linux"), txt);
});

test("能力 chip 里 WSL 运行时单独一行（Windows 的 Python ≠ WSL 的 Python）", () => {
  const txt = textOf(CapabilityChips({ caps: winPeer.capabilities, peer: winPeer })).join(" ");
  assert.ok(txt.includes("WSL"), txt);
  assert.ok(txt.includes("Ubuntu"), txt);
  assert.ok(txt.includes("node 22.1"), txt);
});

console.log("\n── 图标：网段探测 vs 单机探测 ──");

/** 收集组件树里所有按钮/图标按钮的 icon 名（含函数组件展开）。 */
function iconsIn(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) iconsIn(c, out);
    return out;
  }
  const props = node.props || {};
  if (typeof props.icon === "string") out.push(props.icon);
  if (typeof node.type === "function") {
    iconsIn(node.type(propsFor(node)), out);
    return out;
  }
  iconsIn(node.children, out);
  if (props.children !== undefined) iconsIn(props.children, out);
  return out;
}

test("设备详情的「探测」用准星图标，不再复用网段扫描那个", () => {
  const icons = iconsIn(DeviceDetail({ peer, now, onCompose: noop, onProbe: noop, onBack: noop, onRename: noop }));
  assert.ok(icons.includes("probe"), `探测按钮应使用 probe 图标：${icons.join(",")}`);
  assert.ok(!icons.includes("scan"), `设备详情里不该再出现网段扫描图标：${icons.join(",")}`);
});

test("网段探测的入口按钮统一显示「局域网探测」", () => {
  const empty = textOf(DeviceList({ selfPeer: state.self, peers: [], selectedId: null, onSelect: noop, now, lastOk: now, onScan: noop, scanning: false })).join(" ");
  assert.ok(empty.includes("局域网探测"), empty);
  assert.ok(!empty.includes("扫描"), `设备页左栏不该再说「扫描」：${empty}`);
});

test("自定义卡片能渲染便签内容", () => {
  const custom = [{
    id: "custom-test",
    custom: true,
    type: "note",
    title: "构建便签",
    icon: "note",
    text: "部署前先跑测试",
    metric: "online",
    filter: "all",
  }];
  const txt = textOf(HomeBoard({
    state,
    self: state.self,
    peers: [peer],
    tasks: [],
    now,
    lastOk: now,
    focus: false,
    layout: ["overview", "custom-test"],
    sizes: {},
    customCards: custom,
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
    onScan: noop,
    scanning: false,
    firstRun: null,
  })).join(" ");
  assert.ok(txt.includes("构建便签"), txt);
  assert.ok(txt.includes("部署前先跑测试"), txt);
});

test("设置页有四个入口，且默认全部收起", () => {
  const txt = textOf(SettingsView({ state, open: null, onOpen: noop, onSaveName: async () => true, nameBusy: false, push: noop, reload: async () => {} })).join(" ");
  assert.ok(txt.includes("本机"), txt);
  assert.ok(txt.includes("配对码"), txt);
  assert.ok(txt.includes("互联网组网"), txt);
  assert.ok(txt.includes("诊断"), txt);
  assert.ok(!txt.includes("Generate auth key"), "收起时不该出现 Tailscale 教程");
});

test("派发 sheet 显示目标与输入框，空任务时发送禁用", () => {
  const el = Composer({ target: peer, open: true, onClose: noop, onSent: noop, hostDown: false });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("派发任务"), txt);
  assert.ok(txt.includes("winbox"), txt);
  let sendDisabled = false;
  walk(el, (n) => {
    if (n.type === "button" && n.props && n.props.disabled === true && textOf(n).join("").includes("发送")) sendDisabled = true;
  });
  assert.ok(sendDisabled, "空任务时发送按钮应禁用");
});

console.log("\n── 主页 · 派发任务面板 ──");

test("派发面板列出在线设备，空任务时发送禁用", () => {
  const el = DispatchPanel({ peers: [peer], hostDown: false, onScan: noop, scanning: false });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("派发任务"), txt);
  assert.ok(txt.includes("winbox"), "目标下拉里应有设备名");
  assert.ok(txt.includes("1 / 1 台在线"), txt);
  let options = 0;
  let sendDisabled = false;
  walk(el, (n) => {
    if (n.type === "option" && n.props && n.props.value === "p1") options += 1;
    if (n.type === "button" && n.props && n.props.disabled === true && textOf(n).join("").includes("发送")) sendDisabled = true;
  });
  assert.equal(options, 1, "每台设备一个 option");
  assert.ok(sendDisabled, "没写内容时不该能发");
});

test("没有设备时给局域网探测入口，而不是一个空的下拉", () => {
  const el = DispatchPanel({ peers: [], hostDown: false, onScan: noop, scanning: false });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("还没有发现其他设备"), txt);
  assert.ok(txt.includes("局域网探测"), "应引导用户去探测局域网");
  let disabled = false;
  walk(el, (n) => {
    if (n.type === "select" && n.props && n.props.disabled === true) disabled = true;
  });
  assert.ok(disabled, "没有设备时下拉应禁用");
});

test("目标离线时说清原因，不静默失败", () => {
  const offline = { ...peer, online: false };
  const txt = textOf(DispatchPanel({ peers: [offline], hostDown: false, onScan: noop, scanning: false })).join(" ");
  assert.ok(txt.includes("离线"), txt);
  assert.ok(txt.includes("当前离线"), txt);
  assert.ok(txt.includes("winbox（离线）"), "下拉项要标出离线");
});

test("与主机失联时派发按钮禁用并说明原因", () => {
  const el = DispatchPanel({ peers: [peer], hostDown: true, onScan: noop, scanning: false });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("与主机失去联系"), txt);
  let sendDisabled = false;
  walk(el, (n) => {
    if (n.type === "button" && n.props && n.props.disabled === true && textOf(n).join("").includes("发送")) sendDisabled = true;
  });
  assert.ok(sendDisabled, "主机关联不上时不能假装能发");
});

console.log("\n── 锚定传输 ──");

const fakeCap = {
  nodeType: 1,
  tagName: "SPAN",
  innerText: "3.12",
  parentElement: null,
  getAttribute(name) {
    const attrs = { "data-mesh-cap": "python", "data-mesh-peer": "winbox", "data-mesh-instance": "p1" };
    return attrs[name] ?? null;
  },
  getBoundingClientRect() {
    return { left: 1, top: 2, width: 3, height: 4 };
  },
  closest(selector) {
    return selector.includes("data-mesh-cap") ? this : null;
  },
};

test("deriveAnchor 从 data-mesh-cap 生成语义锚点", () => {
  const anchor = deriveAnchor(fakeCap, state);
  assert.equal(anchor.kind, "capability");
  assert.equal(anchor.cap, "python");
  assert.equal(anchor.machine, "winbox");
  assert.equal(anchor.instanceId, "p1");
  assert.equal(anchor.rect.width, 3);
  assert.ok(anchorLabel(anchor).includes("winbox"));
  assert.ok(anchorLabel(anchor).includes("python"));
});

test("snapshotFor 带上 peer 与 capability 现场", () => {
  const anchor = deriveAnchor(fakeCap, state);
  const snapshot = snapshotFor(anchor, state);
  assert.equal(snapshot.peer.machine, "winbox");
  assert.equal(snapshot.peer.online, true);
  assert.equal(snapshot.capability.key, "python");
  assert.equal(snapshot.capability.value, "3.12");
});

test("transferPrompt 包含锚点、现场和线程", () => {
  const anchor = deriveAnchor(fakeCap, state);
  const snapshot = snapshotFor(anchor, state);
  const prompt = transferPrompt({ id: "tr-test", route: "mesh", thread: "transfer:tr-test", anchor, snapshot, intent: "重新探一下" });
  assert.ok(prompt.includes("Mesh 锚定传输 #tr-test"), prompt);
  assert.ok(prompt.includes("winbox"), prompt);
  assert.ok(prompt.includes("python"), prompt);
  assert.ok(prompt.includes("transfer:tr-test"), prompt);
  assert.ok(prompt.includes("重新探一下"), prompt);
  const md = transferMarkdown({ id: "tr-test", route: "mesh", anchor, snapshot, intent: "重新探一下" });
  assert.ok(md.includes("锚定传输"), md);
  assert.ok(md.includes("winbox"), md);
});

test("TransferComposer 显示目标、意图和预览", () => {
  const anchor = deriveAnchor(fakeCap, state);
  const snapshot = snapshotFor(anchor, state);
  const txt = textOf(TransferComposer({
    draft: { anchor, snapshot },
    state,
    sessionId: "s1",
    onClose: noop,
    onSend: async () => {},
  })).join(" ");
  assert.ok(txt.includes("锚定传输"), txt);
  assert.ok(txt.includes("当前会话"), txt);
  assert.ok(txt.includes("winbox"), txt);
  assert.ok(txt.includes("剪贴板"), txt);
  assert.ok(txt.includes("查看将发送的内容"), txt);
});

test("TransferLog 显示记录与状态", () => {
  const anchor = deriveAnchor(fakeCap, state);
  const snapshot = snapshotFor(anchor, state);
  const txt = textOf(TransferLog({
    items: [{ id: "tr-1", at: new Date().toISOString(), route: "mesh", status: "sent", anchor, snapshot, intent: "重新探一下" }],
    onClose: noop,
    onRetry: noop,
    onLocate: noop,
    onCopy: noop,
  })).join(" ");
  assert.ok(txt.includes("传输记录"), txt);
  assert.ok(txt.includes("winbox"), txt);
  assert.ok(txt.includes("已发送"), txt);
  assert.ok(txt.includes("重新探一下"), txt);
});

test("TopBar 提供锚定传输与记录入口", () => {
  const el = TopBar({
    view: "devices",
    onView: noop,
    online: 1,
    total: 1,
    taskCount: 0,
    error: null,
    lastOk: now,
    now,
    refreshing: false,
    onRefresh: noop,
    scanning: false,
    onScan: noop,
    disabled: false,
    busy: false,
    focus: false,
    onToggleFocus: noop,
    onTransfer: noop,
    transferActive: true,
    onLog: noop,
    transferCount: 3,
  });
  const labels = [];
  walk(el, (node) => {
    if (node.type === "button" && node.props && node.props["aria-label"]) labels.push(node.props["aria-label"]);
  });
  assert.ok(labels.some((label) => label.includes("锚定传输")), labels.join(","));
  assert.ok(labels.some((label) => label.includes("传输记录")), labels.join(","));
  assert.ok(textOf(el).join(" ").includes("3"), "记录角标应显示条数");
});

await testAsync("sendToAgent 写入并提交当前会话草稿", async () => {
  const calls = { draft: "", submitted: false, panel: "unchanged" };
  mod.apply({
    slots: {
      inject: (name, cb) => cb(),
      register: () => {},
    },
    get(name) {
      if (name === "uiWorkspace") return { selection: { getSnapshot: () => ({ sessionId: "s1" }) } };
      if (name === "sessions") return { scope: () => ({}) };
      if (name === "conversation") {
        return {
          input: {
            for: () => ({
              setDraft: (text) => {
                calls.draft = text;
              },
              submit: () => {
                calls.submitted = true;
              },
            }),
          },
        };
      }
      if (name === "layout") return { selectPanel: (value) => { calls.panel = value; } };
      return null;
    },
  });
  assert.equal(currentSessionId(), "s1");
  const status = await sendToAgent("hello mesh", "s1");
  assert.equal(calls.draft, "hello mesh");
  assert.equal(calls.submitted, true);
  assert.equal(calls.panel, null);
  assert.equal(status, "sent");
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
