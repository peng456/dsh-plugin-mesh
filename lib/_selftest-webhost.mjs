/**
 * 常驻 Web 面板层（client.js 的 webPanelLayer）自测。
 *
 * 面板层是唯一直接碰 document.body 的部分，用假 DOM + 假 fetch 就能把生命周期
 * 从头到尾走一遍，不需要浏览器：
 *
 *   打开 → 收起（只隐藏）→ 宽限期内复开（不请求、不重建 = 秒切）
 *        → 空闲到期（unmount + 摘宿主 + force-close 宿主反代）
 *        → 换设备（旧面板先还给宿主）→ dispose（插件卸载不留孤儿）
 *
 *   node lib/_selftest-webhost.mjs
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "client", "client.js");

// ── 假 DOM ──
const created = [];
function fakeEl(tag) {
  return {
    tagName: tag,
    className: "",
    id: "",
    style: {},
    children: [],
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      child.parentNode = null;
    },
    textContent: "",
  };
}
const body = fakeEl("body");
/**
 * 真实 document 一定有 addEventListener/removeEventListener，这个桩以前没给，
 * 于是「面板支持 Esc 关闭」这类挂在 document 上的监听会把整条自测打崩
 * （TypeError: document.addEventListener is not a function）。
 * 这里补成可记录的空实现：监听存进 listeners，用例想模拟按键就自己取出来调。
 */
globalThis.document = {
  body,
  head: null, // installStyle() 直接早退：样式不在本自测的范围内
  createElement: (tag) => {
    const el = fakeEl(tag);
    created.push(el);
    return el;
  },
  getElementById: () => null,
  addEventListener: (name, fn) => listeners.set(`document:${name}`, fn),
  removeEventListener: (name) => listeners.delete(`document:${name}`),
};

// ── 假 localStorage / window ──
const store = new Map([["mesh.webPanelIdleMs", "25"]]);
const listeners = new Map();
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      captured = entry;
    },
  },
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  },
  addEventListener: (name, fn) => listeners.set(name, fn),
};

// ── 假 fetch（地址与失败都可由用例控制）──
const calls = [];
let hostUrl = "http://127.0.0.1:4321/?k=x";
let hostFail = false;
globalThis.fetch = async (url, init) => {
  const payload = init && init.body ? JSON.parse(init.body) : {};
  calls.push({ url: String(url), body: payload, keepalive: !!(init && init.keepalive) });
  if (String(url).endsWith("/mesh/api/web-panel")) {
    if (hostFail) {
      return { ok: true, status: 200, json: async () => ({ ok: false, error: "宿主说保不住了" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, url: hostUrl, hasSession: true }) };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

// ── 假 react / react-dom/client ──
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  Fragment: Symbol("Fragment"),
};
const rendered = [];
let unmounted = 0;
const reactDomStub = {
  createRoot: () => ({
    render: (node) => rendered.push(node),
    unmount: () => {
      unmounted += 1;
    },
  }),
};

const source = readFileSync(BUNDLE, "utf8");
new Function("window", `${source}\n`)(globalThis.window);
const mod = captured.factory((name) => {
  if (name === "react") return reactStub;
  if (name === "react-dom/client") return reactDomStub;
  throw new Error(`未预期的依赖：${name}`);
});

const layer = mod.__test.webPanelLayer;
const peer = { machine: "hos", id: "x1" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
async function okAsync(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await okAsync("打开：一次 /web-panel，宿主挂到 body 上", async () => {
  await layer.open(peer);
  assert.equal(layer.__alive(), true);
  assert.equal(layer.current().hidden, false);
  assert.equal(calls.length, 1);
  const host = created.find((el) => el.className === "mesh-web-hosted");
  assert.ok(host, "应创建 body 级宿主");
  assert.ok(body.children.includes(host), "宿主必须挂在 body 上");
});

ok("收起：只隐藏，不卸载 iframe", () => {
  layer.hide();
  assert.equal(layer.current().hidden, true);
  assert.equal(layer.__alive(), true);
  assert.equal(unmounted, 0);
});

await okAsync("宽限期内复开：不重建 iframe（秒切），只顺手续一次命", async () => {
  const before = rendered.length;
  const opens = calls.filter((call) => call.url.endsWith("/mesh/api/web-panel")).length;
  await layer.open(peer);
  assert.equal(layer.current().hidden, false);
  assert.equal(rendered.length, before + 1, "只重绘一次");
  assert.equal(unmounted, 0, "复开不该重建 root");
  await sleep(10);
  const after = calls.filter((call) => call.url.endsWith("/mesh/api/web-panel")).length;
  assert.equal(after, opens + 1, "复开应顺带打一次 /web-panel 续命（只刷新 lastUsedAt）");
});

await okAsync("空闲到期：unmount + 摘宿主 + force-close 宿主反代", async () => {
  layer.hide();
  await sleep(80);
  assert.equal(layer.__alive(), false);
  assert.equal(unmounted, 1);
  assert.equal(body.children.length, 0, "宿主应从 body 摘掉");
  const close = calls.find((call) => call.url.endsWith("/web-panel/close"));
  assert.ok(close, "到期应通知宿主 close");
  assert.equal(close.body.force, true, "到期必须 force-close");
  assert.equal(close.body.peer, "hos");
});

await okAsync("换设备：旧面板先还给宿主，不留孤儿端口", async () => {
  calls.length = 0;
  await layer.open(peer);
  await layer.open({ machine: "myserver-wb", id: "y2" });
  const closed = calls.filter((call) => call.url.endsWith("/web-panel/close"));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].body.peer, "hos");
  assert.equal(closed[0].body.force, true);
});

ok("dispose：插件卸载后 body 上不留宿主", () => {
  layer.dispose();
  assert.equal(layer.__alive(), false);
  assert.equal(body.children.length, 0);
});

// ── 回归：没配置 mesh.webPanelIdleMs 时必须落到默认 10 分钟 ──
// getItem 未命中返回 null，而 Number(null) 是 0 —— 曾经因此把「没配置」读成
// 「收起即拆」，每次 hide() 立刻销毁 iframe，秒切整个失效。
const emptyStore = new Map();
let captured2 = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      captured2 = entry;
    },
  },
  localStorage: {
    getItem: (key) => (emptyStore.has(key) ? emptyStore.get(key) : null),
    setItem: (key, value) => emptyStore.set(key, String(value)),
  },
  addEventListener: () => {},
};
new Function("window", `${readFileSync(BUNDLE, "utf8")}\n`)(globalThis.window);
const mod2 = captured2.factory((name) => {
  if (name === "react") return reactStub;
  if (name === "react-dom/client") return reactDomStub;
  throw new Error(`未预期的依赖：${name}`);
});

ok("未配置空闲时长 → 默认 10 分钟（不是 0）", () => {
  assert.equal(mod2.__test.WEB_PANEL_IDLE_DEFAULT, 10 * 60 * 1000);
  assert.equal(mod2.__test.readWebPanelIdleMs(), mod2.__test.WEB_PANEL_IDLE_DEFAULT);
});

await okAsync("默认配置下收起：宽限期内 iframe 必须还活着", async () => {
  const layer2 = mod2.__test.webPanelLayer;
  await layer2.open({ machine: "hos", id: "x1" });
  layer2.hide();
  await sleep(40);
  assert.equal(layer2.__alive(), true, "收起后立刻销毁 = 秒切失效");
  layer2.dispose();
  assert.equal(layer2.__alive(), false);
});

await okAsync("可见期间心跳：按时续命，地址不变就不重载", async () => {
  const layer2 = mod2.__test.webPanelLayer;
  hostUrl = "http://127.0.0.1:5555/?k=keep";
  await layer2.open({ machine: "hos", id: "x1" });
  const base = calls.filter((call) => call.url.endsWith("/mesh/api/web-panel")).length;
  const before = rendered.length;
  layer2.__setHeartbeatMs(20);
  await sleep(70);
  const after = calls.filter((call) => call.url.endsWith("/mesh/api/web-panel")).length;
  assert.ok(after > base, "心跳应持续打 /web-panel");
  assert.equal(rendered.length, before, "地址没变就不该重绘/重载");
  assert.equal(layer2.__alive(), true);
  layer2.dispose();
});

await okAsync("心跳自愈：宿主回收后重建过（地址变了）→ iframe 换到新地址重载", async () => {
  const layer3 = mod2.__test.webPanelLayer;
  hostUrl = "http://127.0.0.1:6666/?k=old";
  await layer3.open({ machine: "hos", id: "x1" });
  const before = rendered.length;
  hostUrl = "http://127.0.0.1:7777/?k=new";
  layer3.__setHeartbeatMs(20);
  await sleep(70);
  const last = rendered[rendered.length - 1];
  assert.equal(rendered.length, before + 1, "地址变了应重绘一次");
  assert.ok(last && last.props && last.props.panel, "最后一次渲染应带 panel");
  assert.equal(last.props.panel.url, "http://127.0.0.1:7777/?k=new");
  assert.equal(last.props.panel.reloadKey, 1, "重载计数应 +1");
  layer3.dispose();
});

await okAsync("心跳失败：宿主说保不住 → 拆面板并提示重开", async () => {
  const layer4 = mod2.__test.webPanelLayer;
  hostUrl = "http://127.0.0.1:8888/?k=x";
  hostFail = false;
  await layer4.open({ machine: "hos", id: "x1" });
  hostFail = true;
  layer4.__setHeartbeatMs(20);
  await sleep(70);
  assert.equal(layer4.__alive(), false, "保不住时应销毁面板");
  layer4.dispose();
  hostFail = false;
});

console.log(`\n全部通过：${passed} 通过 / 0 失败`);
