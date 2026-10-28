/**
 * USB/adb 传输接线的集成自测（**离线**：不跑 adb、不碰真机）。
 *
 * 跑法：node --experimental-vm-modules lib/_selftest-usb-integration.mjs
 *
 * 为什么要这一层：`lib/usb.js` 自己已有 24 个模块级用例（真/假 adb、forward、
 * 探测都覆盖了），但"接进主流程"这层仍是裸的 —— 端点没登记、登记错通道、
 * 卸载没停定时器、健康检查把 adb 路径泄出去，这些都只有接线后才会发生。
 * 这里用 vm 加载真实的 `lib/index.js`（与 `_selftest-reply-route.mjs` 同一手法），
 * 只把传输层换成 fake，其余全是真的（真的 `MeshDiscovery` 注册表、真的 peer
 * server、真的 `/mesh/v1/health`）。
 *
 * 覆盖（task-9 item 8）：
 *   1. usbEnabled=false → 不创建传输、不探测、diag 明确 enabled:false
 *   2. usbEnabled=true → 配置映射正确（adbPath/devicePort/forwardBase/pollMs/区间钳制）
 *   3. onEndpoints → 端点登记；与 LAN 同一设备时**合并为多端点**，不造第二个设备条目
 *   4. start/stop 被调用（卸载路径必须停传输）
 *   5. health diag 有 usb 段且**脱敏**（无 adb 路径、无错误原文）
 *   6. 任何情况下不抛（工厂抛错、status 抛错、垃圾端点、非法配置）
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshDiscovery } from "./discovery.js";
import { buildDiagnostics } from "./diagnostics.js";

const root = mkdtempSync(join(tmpdir(), "mesh-usb-wiring-"));
const cleanups = [];
const noop = () => {};

const entryUrl = new URL("./index.js", import.meta.url);
// startPeerServer 是内部函数（未 export）；追加一条导出仅为测试健康检查路由。
const entrySource = readFileSync(entryUrl, "utf8") + "\nexport { startPeerServer };"
// 与 reply-route 相同的最小 vm 环境：只桩掉 DSH 运行时包，相对 import 全是真的。
const schema = new Proxy(() => schema, { get: () => schema });
const mocks = {
  "@deepseek-ai/schemastery": { default: schema },
  "@deepseek-ai/dsh-brand": { brandString: (value) => value },
  "@deepseek-ai/dsh-tools": { defineTool: (tool) => tool },
  "@deepseek-ai/dsh-llm": { createUserMessage: (message) => message },
};
const context = vm.createContext({
  console,
  Buffer,
  URL,
  AbortSignal,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  process: { ...process, env: { ...process.env, DSH_HOME: join(root, "dsh-home") } },
  fetch: async (...args) => fetch(...args),
});
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
const { createUsbWiring } = module.namespace;

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err?.message ?? err}`);
    failed += 1;
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err?.message ?? err}`);
    failed += 1;
  }
}

/** 假传输：记录调用、保存 options，可手动 emit 端点。 */
function fakeTransportFactory() {
  const calls = { factory: 0, start: 0, stop: 0, options: null, emit: null };
  const statusFixture = () => ({
    transport: "usb",
    available: true,
    detected: true,
    reason: "",
    adbPath: "C:\\AndroidSDK\\platform-tools\\adb.exe",
    adbVersion: "1.0.41",
    started: true,
    polling: true,
    pollCount: 3,
    lastPollAt: 1761000000000,
    pollMs: 15000,
    devicePort: 45917,
    forwardBase: 46000,
    forwardSpan: 100,
    devices: [{ serial: "1441e87a", model: "2510DPC0" }],
    skipped: [{ serial: "bogus", reason: "unauthorized" }],
    forwards: [{ serial: "1441e87a", localPort: 46000, createdByUs: true }],
    endpoints: [
      { key: "usb:1441e87a", transport: "usb", host: "127.0.0.1", port: 46000, serial: "1441e87a", machine: "phone", id: "phone-1", rttMs: 3 },
    ],
    errors: [
      {
        serial: "1441e87a",
        phase: "probe",
        code: "ETIMEDOUT",
        message: "connect ETIMEDOUT 127.0.0.1 — C:\\Users\\secret\\token.txt",
        at: 1761000000000,
      },
    ],
    errCount: 1,
  });
  const transport = {
    startCount: 0,
    stopCount: 0,
    start() {
      calls.start += 1;
      transport.startCount += 1;
      return Promise.resolve({ available: true, devices: [], skipped: [] });
    },
    stop() {
      calls.stop += 1;
      transport.stopCount += 1;
      return { available: true };
    },
    status: () => statusFixture(),
    emit(list) {
      calls.emit = list;
      calls.options?.onEndpoints?.(list, { available: true });
    },
  };
  const factory = (options) => {
    calls.factory += 1;
    calls.options = options;
    return transport;
  };
  return { calls, transport, factory };
}

const usbPhoneRecord = {
  app: "dsh-mesh",
  id: "phone-1",
  machine: "phone",
  host: "192.168.1.19",
  port: 45917,
  version: "0.5.4",
  os: "android 15 (6.6.30-android15)",
};

const baseConfig = (overrides = {}) => ({
  usbEnabled: false,
  usbAdbPath: "",
  usbForwardBase: 46000,
  usbPollMs: 15000,
  pingIntervalMs: 10000,
  requestTimeoutMs: 20000,
  ...overrides,
});

console.log("\n── 1. usbEnabled=false：不创建、不探测、行为零变化 ──");

check("false → 工厂不被调用、transport=null、diag.enabled=false", () => {
  const fake = fakeTransportFactory();
  const w = createUsbWiring({ config: baseConfig(), discovery: null, log: noop, warn: noop, createTransport: fake.factory });
  assert.equal(w.enabled, false);
  assert.equal(w.transport, null);
  assert.equal(fake.calls.factory, 0, "关闭时不得创建传输（否则会去探测 adb）");
  assert.equal(w.diag().enabled, false);
  assert.equal(w.diag({ detail: true }).enabled, false);
});

check("非严格 true（字符串 'true'）也按关闭处理（schema 保证 bool，防御手写配置）", () => {
  const fake = fakeTransportFactory();
  const w = createUsbWiring({ config: baseConfig({ usbEnabled: "true" }), discovery: null, createTransport: fake.factory });
  assert.equal(w.enabled, false);
  assert.equal(fake.calls.factory, 0);
});

await checkAsync("关闭时 start/stop 是安全 no-op", async () => {
  const w = createUsbWiring({ config: baseConfig(), discovery: null });
  assert.equal(await w.start(), null);
  assert.equal(w.stop(), null);
  assert.equal(w.diag().endpoints, 0);
});

console.log("\n── 2. usbEnabled=true：配置映射与区间钳制 ──");

check("创建一次，options 映射正确（默认 adb/PATH、手机端口 45917、轮询 15s）", () => {
  const fake = fakeTransportFactory();
  const w = createUsbWiring({ config: baseConfig({ usbEnabled: true }), discovery: null, log: noop, warn: noop, createTransport: fake.factory });
  assert.equal(w.enabled, true);
  assert.equal(fake.calls.factory, 1);
  const o = fake.calls.options;
  assert.equal(o.adbPath, "adb", "空 usbAdbPath = PATH 里的 adb");
  assert.equal(o.devicePort, 45917, "手机侧 mesh 默认端口");
  assert.equal(o.forwardBase, 46000);
  assert.equal(o.pollMs, 15000);
  assert.ok(o.probeTimeoutMs > 0 && o.probeTimeoutMs <= 1200, `probeTimeoutMs=${o.probeTimeoutMs}`);
  assert.equal(typeof o.onEndpoints, "function");
  assert.equal(typeof o.onError, "function");
});

check("自定义 adbPath 去空白；越界 forwardBase/pollMs 被钳制", () => {
  const fake = fakeTransportFactory();
  createUsbWiring({
    config: baseConfig({ usbEnabled: true, usbAdbPath: "  /opt/platform-tools/adb ", usbForwardBase: 80, usbPollMs: 5 }),
    discovery: null,
    createTransport: fake.factory,
  });
  assert.equal(fake.calls.options.adbPath, "/opt/platform-tools/adb");
  assert.equal(fake.calls.options.forwardBase, 1024, "低于下限应钳到 1024");
  assert.equal(fake.calls.options.pollMs, 1000, "低于下限应钳到 1000");
});

check("工厂抛错不抛给调用方：createError 可见、diag 降级", () => {
  const w = createUsbWiring({
    config: baseConfig({ usbEnabled: true }),
    discovery: null,
    createTransport: () => {
      throw new Error("boom");
    },
  });
  assert.equal(w.enabled, true);
  assert.equal(w.transport, null);
  assert.match(w.createError, /boom/);
  const d = w.diag();
  assert.equal(d.enabled, true);
  assert.equal(d.available, false);
  assert.equal(d.reason, "CREATE_FAILED");
});

console.log("\n── 3. onEndpoints → discovery 注册 + 同设备多端点合并 ──");

check("USB 端点与 LAN 是同一台手机 → 只有一个 peer，endpoints={lan, usb:<serial>}", () => {
  const discovery = new MeshDiscovery({ id: "self-usb", port: 45917, meta: { machine: "desktop" } });
  // 手机已经通过 LAN 被发现了（同一 instanceId）
  discovery.note({ ...usbPhoneRecord, host: "192.168.1.19" }, "192.168.1.19");
  const fake = fakeTransportFactory();
  const w = createUsbWiring({ config: baseConfig({ usbEnabled: true }), discovery, createTransport: fake.factory, warn: noop });
  fake.transport.emit([
    {
      key: "usb:1441e87a",
      transport: "usb",
      host: "127.0.0.1",
      port: 46000,
      rttMs: 3,
      record: usbPhoneRecord,
    },
  ]);
  const peers = discovery.peers();
  assert.equal(peers.length, 1, `同一台手机不得造第二个设备条目，实际 ${JSON.stringify(peers.map((p) => p.id))}`);
  const peer = peers[0];
  assert.equal(peer.id, "phone-1");
  assert.equal(peer.machine, "phone");
  // peers() 的端点是数组（每项带 key/transport/host/port）
  const eps = Array.isArray(peer.endpoints) ? peer.endpoints : [];
  const lan = eps.find((e) => e.key === "lan" || e.transport === "lan");
  const usb = eps.find((e) => e.key === "usb:1441e87a" || e.transport === "usb");
  assert.ok(lan, `缺 lan 端点：${JSON.stringify(eps)}`);
  assert.ok(usb, `缺 usb 端点：${JSON.stringify(eps)}`);
  assert.equal(usb.transport, "usb");
  assert.equal(usb.host, "127.0.0.1", "USB 端点 host 必须是 adb forward 的本地端");
  assert.equal(usb.port, 46000);
  assert.equal(usb.verified, true);
  assert.ok(Number(usb.probeIntervalMs) >= 1000, "应把 pingIntervalMs 作为端点存活窗口传进去");
  assert.equal(peer.online, true, "任一端点活着即在线");
});

check("同一个 USB 端点重复上报 → 仍然只有 1 个 peer（幂等）", () => {
  const discovery = new MeshDiscovery({ id: "self-usb", port: 45917, meta: { machine: "desktop" } });
  const fake = fakeTransportFactory();
  createUsbWiring({ config: baseConfig({ usbEnabled: true }), discovery, createTransport: fake.factory });
  const ep = { key: "usb:1441e87a", transport: "usb", host: "127.0.0.1", port: 46000, rttMs: 3, record: usbPhoneRecord };
  fake.transport.emit([ep]);
  fake.transport.emit([ep]);
  fake.transport.emit([ep]);
  assert.equal(discovery.peers().length, 1);
});

check("垃圾端点（null / 没有 record）不会抛、也不污染注册表", () => {
  const discovery = new MeshDiscovery({ id: "self-usb", port: 45917, meta: { machine: "desktop" } });
  const fake = fakeTransportFactory();
  createUsbWiring({ config: baseConfig({ usbEnabled: true }), discovery, createTransport: fake.factory });
  assert.doesNotThrow(() => fake.transport.emit([null, {}, { key: "usb:x" }, { record: null }]));
  assert.equal(discovery.peers().length, 0);
});

console.log("\n── 4. start / stop（卸载路径）──");

await checkAsync("start() 调传输层 start；stop() 调传输层 stop（卸载必须清定时器/forward）", async () => {
  const discovery = new MeshDiscovery({ id: "self-usb", port: 45917, meta: { machine: "desktop" } });
  const fake = fakeTransportFactory();
  const w = createUsbWiring({ config: baseConfig({ usbEnabled: true }), discovery, createTransport: fake.factory });
  const st = await w.start();
  assert.equal(fake.calls.start, 1, "start 应被调用");
  assert.equal(st?.available, true);
  w.stop();
  assert.equal(fake.calls.stop, 1, "stop 应被调用（ctx.effect 的清理）");
});

await checkAsync("传输层 start 抛错/返回 rejected 也不抛", async () => {
  const bad = {
    start() {
      throw new Error("boom");
    },
    stop() {
      throw new Error("boom-stop");
    },
    status() {
      throw new Error("boom-status");
    },
  };
  const w = createUsbWiring({ config: baseConfig({ usbEnabled: true }), discovery: null, createTransport: () => bad });
  assert.equal(await w.start(), null);
  assert.doesNotThrow(() => w.stop());
  const d = w.diag();
  assert.equal(d.available, false);
  assert.equal(d.reason, "STATUS_UNAVAILABLE");
});

console.log("\n── 5. 诊断脱敏（health 是未鉴权接口）──");

check("diag() 只给计数/错误码：无 adbPath、无错误原文", () => {
  const fake = fakeTransportFactory();
  const w = createUsbWiring({ config: baseConfig({ usbEnabled: true }), discovery: null, createTransport: fake.factory });
  const d = w.diag();
  assert.equal(d.available, true);
  assert.equal(d.adbVersion, "1.0.41");
  assert.equal(d.devices, 1);
  assert.equal(d.endpoints, 1);
  assert.equal(d.errors.length, 1);
  assert.equal(d.errors[0].code, "ETIMEDOUT");
  assert.ok(!("message" in d.errors[0]), "错误原文不得出现在 health diag");
  const text = JSON.stringify(d);
  assert.ok(!text.includes("C:\\\\Users") && !text.includes("secret"), `diag 泄露了路径：${text}`);
  assert.ok(!("adbPath" in d), "adb 路径不得出现在 health diag");
});

check("diag({detail:true}) 给排障细节但同样不含路径/原文", () => {
  const fake = fakeTransportFactory();
  const w = createUsbWiring({ config: baseConfig({ usbEnabled: true }), discovery: null, createTransport: fake.factory });
  const d = w.diag({ detail: true });
  assert.equal(d.devicePort, 45917);
  assert.equal(d.pollMs, 15000);
  assert.equal(d.forwards, 1);
  assert.equal(d.skipped[0].reason, "unauthorized");
  assert.equal(d.endpointKeys[0].key, "usb:1441e87a");
  const text = JSON.stringify(d);
  assert.ok(!text.includes("C:\\\\Users") && !text.includes("secret"));
});

console.log("\n── 6. /mesh/v1/health 真实路由：diag.usb 出现且脱敏 ──");

await checkAsync("/mesh/v1/health 的 diag.usb 有 available/devices/endpoints/errors 且无敏感原文", async () => {
  const fake = fakeTransportFactory();
  const wiring = createUsbWiring({ config: baseConfig({ usbEnabled: true }), discovery: null, createTransport: fake.factory });
  const ctx = { get: () => undefined, effect: (fn) => cleanups.push(fn()), tools: { register: noop }, inject: noop };
  const fakeDiscovery = {
    instanceId: "self-usb",
    netInfo: () => null,
    peers: () => [],
    selfRecord: () => ({ app: "dsh-mesh", id: "self-usb", machine: "desktop", host: "127.0.0.1", port: 0 }),
  };
  const port = await module.namespace.startPeerServer(ctx, {
    config: {
      port: 0,
      requirePairing: false,
      useMulticast: false,
      requestTimeoutMs: 500,
      minTaskChars: 8,
      maxWakesPerThread: 30,
      threadCooldownMs: 5000,
      threadWindowMs: 3600000,
    },
    discovery: fakeDiscovery,
    inbound: [],
    outbound: [],
    log: noop,
    warn: noop,
    waker: { ready: false },
    threadState: new Map(),
    capFor: () => 0,
    capOverrides: new Map(),
    throttled: new Map(),
    onHistoryChange: noop,
    diagnostics: () => ({}),
    usbStatus: () => wiring.diag(),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mesh/v1/health`);
    assert.equal(res.status, 200);
    const health = await res.json();
    assert.ok(health.diag?.usb, "health 必须带 diag.usb");
    const u = health.diag.usb;
    assert.equal(u.enabled, true);
    assert.equal(u.available, true);
    assert.equal(u.devices, 1);
    assert.equal(u.endpoints, 1);
    assert.ok(Array.isArray(u.errors));
    assert.equal(u.errors[0].code, "ETIMEDOUT");
    const text = JSON.stringify(health);
    assert.ok(!text.includes("C:\\\\Users") && !text.includes("secret"), "health 泄露了 adb 路径/错误原文");
  } finally {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* 关服务失败不影响断言 */
      }
    }
  }
});

await checkAsync("health diag 的 usbStatus 抛错 → 有安全兜底，health 不 500", async () => {
  const ctx = { get: () => undefined, effect: (fn) => cleanups.push(fn()), tools: { register: noop }, inject: noop };
  const fakeDiscovery = {
    instanceId: "self-usb",
    netInfo: () => null,
    peers: () => [],
    selfRecord: () => ({ app: "dsh-mesh", id: "self-usb", machine: "desktop", host: "127.0.0.1", port: 0 }),
  };
  const port = await module.namespace.startPeerServer(ctx, {
    config: { port: 0, requirePairing: false, useMulticast: false, requestTimeoutMs: 500, minTaskChars: 8, maxWakesPerThread: 30, threadCooldownMs: 5000, threadWindowMs: 3600000 },
    discovery: fakeDiscovery,
    inbound: [],
    outbound: [],
    log: noop,
    warn: noop,
    waker: { ready: false },
    threadState: new Map(),
    capFor: () => 0,
    capOverrides: new Map(),
    throttled: new Map(),
    onHistoryChange: noop,
    diagnostics: () => ({}),
    usbStatus: () => {
      throw new Error("diag-boom");
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mesh/v1/health`);
    assert.equal(res.status, 200, "usb diag 异常不得把 health 打成 500");
    const health = await res.json();
    assert.equal(health.diag.usb.reason, "DIAG_FAILED");
  } finally {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
  }
});

console.log("\n── 7. lib/diagnostics.js：USB 状态汇总进诊断快照（脱敏）──");

check("buildDiagnostics({usb}) 输出只读汇总：计数 + 错误码，无 message/路径", () => {
  const diag = buildDiagnostics({
    version: "0.5.4",
    packageVersion: "0.5.4",
    hostname: "desktop",
    machine: "desktop",
    config: { usbEnabled: true, usbAdbPath: "C:\\AndroidSDK\\adb.exe", usbForwardBase: 46000, usbPollMs: 15000 },
    usb: {
      enabled: true,
      available: true,
      reason: "",
      adbVersion: "1.0.41",
      started: true,
      pollCount: 3,
      devices: 2,
      endpoints: 1,
      forwards: 1,
      errors: [{ serial: "1441e87a", phase: "probe", code: "ETIMEDOUT", message: "C:\\Users\\secret\\token.txt", at: 1 }],
    },
  });
  assert.equal(diag.usb.enabled, true);
  assert.equal(diag.usb.available, true);
  assert.equal(diag.usb.devices, 2);
  assert.equal(diag.usb.endpoints, 1);
  assert.equal(diag.usb.forwards, 1);
  assert.equal(diag.usb.errCount, 1);
  assert.equal(diag.usb.errors[0].code, "ETIMEDOUT");
  assert.ok(!("message" in diag.usb.errors[0]), "诊断快照不得带错误原文");
  // 配置白名单也覆盖了 usb 键（排障时能看到当时配置）
  assert.equal(diag.config.usbEnabled, true);
  assert.equal(diag.config.usbForwardBase, 46000);
  assert.equal(diag.config.usbPollMs, 15000);
  const text = JSON.stringify(diag);
  assert.ok(!text.includes("C:\\\\Users") && !text.includes("secret"), `诊断快照泄露路径：${text}`);
});

check("未接 USB（usb=null）时诊断快照保留 usb:null（与「没配置」区分开）", () => {
  const diag = buildDiagnostics({ usb: null });
  assert.equal(diag.usb, null);
});

// 收尾
rmSync(root, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);