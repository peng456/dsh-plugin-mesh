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
globalThis.document = {
  body,
  head: null, // installStyle() 直接早退：样式不在本自测的范围内
  createElement: (tag) => {
    const el = fakeEl(tag);
    created.push(el);
    return el;
  },
  getElementById: () => null,
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

// ── 假 fetch ──
const calls = [];
globalThis.fetch = async (url, init) => {
  const payload = init && init.body ? JSON.parse(init.body) : {};
  calls.push({ url: String(url), body: payload, keepalive: !!(init && init.keepalive) });
  if (String(url).endsWith("/mesh/api/web-panel")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: `http://127.0.0.1:9${calls.length}/?k=x`, hasSession: true }),
    };
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

await okAsync("宽限期内复开：不请求宿主、不重建 iframe（秒切）", async () => {
  const before = rendered.length;
  await layer.open(peer);
  assert.equal(calls.length, 1, "复开不该再请求 /web-panel");
  assert.equal(layer.current().hidden, false);
  assert.equal(rendered.length, before + 1, "只重绘一次");
  assert.equal(unmounted, 0, "复开不该重建 root");
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

console.log(`\n全部通过：${passed} 通过 / 0 失败`);
