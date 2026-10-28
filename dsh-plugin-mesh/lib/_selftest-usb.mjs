/**
 * USB/adb 传输（lib/usb.js）的自测：**全离线**，不调用真实 adb、不碰真机、不发网络请求。
 *
 * 跑法：node lib/_selftest-usb.mjs
 *
 * 为什么必须全离线：真机上 `adb forward` 是有状态的全局副作用（会占用本机端口、
 * 改动手机的端口映射），而且 CI/开发机上不一定有手机。所有对外的东西都走注入：
 *   · `execFile(file, args)` → 用 FakeAdb 记录每条命令、按需返回 fixture / 抛错；
 *   · `fetchImpl(url)` → 用 FakeFetch 按 URL 返回 health JSON / 404 / 永不返回。
 * 这样连"端口冲突顺延""设备中途拔掉""探测超时"这种真机上很难稳定复现的场景都能覆盖。
 *
 * 覆盖的核心风险（每条都对应一个真机上可能发生的坏结果）：
 *   1. `adb devices -l` 解析错了 → 把 unauthorized/offline 当可用设备，每轮都失败刷屏；
 *   2. 端口映射不稳定/冲突 → forward 建不起来、或抢占别人的端口；
 *   3. forward 不幂等 → 每 15s 重建一次，和用户手建的映射打架；
 *   4. 探测失败被误当成"设备不存在"（AGENTS.md 硬约束 1）→ 必须区分超时/端口被占/非 mesh；
 *   5. adb 没装（ENOENT）时抛异常或刷屏 → 整个 Mesh 不可用；
 *   6. start/stop 不幂等 → 定时器叠加、forward 泄漏；
 *   7. 任何注入实现抛错 → 传输层必须不抛。
 */
import assert from "node:assert/strict";
import {
  createUsbTransport,
  parseAdbDevices,
  parseForwardList,
  usbPortFor,
  looksLikeMeshHealth,
  classifyAdbFailure,
  DEFAULT_DEVICE_PORT,
  DEFAULT_FORWARD_BASE,
  DEFAULT_FORWARD_SPAN,
  TRANSPORT_NAME,
  __test,
} from "./usb.js";

const { sleep } = __test;

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

// ───────────────────────── fixtures ─────────────────────────

/** 真机实测形态：serial 1441e87a（Xiaomi 15 Ultra / Android 15），首次运行还夹着 daemon 噪声。 */
const REAL_DEVICES = [
  "* daemon not running; starting now at tcp:5037",
  "* daemon started successfully",
  "List of devices attached",
  "1441e87a               device usb:1-4 product:nuwa model:2510DPC0 device:nuwa transport_id:3",
  "",
].join("\n");

/** 三种"不可用但绝不能当成设备不存在"的状态。 */
const SKIPPED_DEVICES = [
  "List of devices attached",
  "1441e87b               unauthorized usb:1-5 transport_id:4",
  "1441e87c               offline usb:1-6 transport_id:5",
  "????????????           no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html]",
  "",
].join("\n");

const SERIAL = "1441e87a";
const SERIAL2 = "1441e87b";

/** 手机上的 /mesh/v1/health（字段来自真机自述 + analysis/00-CONTEXT.md）。 */
const PHONE_HEALTH = {
  ok: true,
  app: "dsh-mesh",
  v: 2,
  proto: "dsh-mesh",
  id: "9f1c2ab34de56780",
  machine: "dsh-go",
  hostname: "localhost",
  host: "192.168.1.55",
  port: DEFAULT_DEVICE_PORT,
  version: "0.5.4",
  os: "android 15 (6.6.30-android15)",
  user: "root",
  requirePairing: false,
};

function healthUrl(port) {
  return `http://127.0.0.1:${port}/mesh/v1/health`;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

/**
 * 假的 `fetchImpl`。
 * @param {object|Function} routes URL → {body,status} | 'timeout' | 'throw' | 直接当 body；
 *        也支持函数 `(url) => Response`；`'*'` 作为兜底 URL。
 */
function createFakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (typeof routes === "function") return routes(url, init);
    const entry = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : routes["*"];
    if (entry === undefined) return jsonResponse({ error: "not found" }, 404);
    if (entry === "timeout") return new Promise(() => {}); // 永不 settle
    if (entry === "throw") throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" });
    if (typeof entry === "function") return entry(url, init);
    if (entry && typeof entry === "object" && ("body" in entry || "status" in entry)) {
      return jsonResponse(entry.body ?? {}, entry.status ?? 200);
    }
    return jsonResponse(entry);
  };
  impl.calls = calls;
  return impl;
}

function bindError(localPort) {
  return Object.assign(
    new Error(
      `adb: error: cannot bind listener: cannot bind to 127.0.0.1:${localPort}: ` +
        "Only one usage of each socket address (protocol/network address/port) is normally permitted.",
    ),
    { code: 1 },
  );
}

/**
 * 假的 `execFile`：模拟 adb 的四个子命令（version / devices -l / forward --list / forward|--remove）。
 * 记录每条命令，便于断言"没有多建 forward""stop 真的清了"。
 */
function createFakeAdb({ version = "1.0.41", devices = REAL_DEVICES, forwards = [], versionError = null } = {}) {
  const fake = {
    calls: [],
    lastOptions: null,
    /** 目前存在的端口映射（与 adb forward --list 对应） */
    forwards: forwards.map((f) => ({ ...f })),
    /** 设备列表：可以是字符串，也可以是函数（模拟中途拔线） */
    devices,
    /** 这些本地端口一 bind 就报 cannot bind（模拟被别的进程占用） */
    bindConflicts: new Set(),
    /** 设备命令行为异常时由用例覆盖 */
    onCommand: null,
    execFile: async (file, args, options) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      fake.calls.push({ file, args: argv });
      fake.lastOptions = options;
      if (typeof fake.onCommand === "function") {
        const override = fake.onCommand(argv, fake);
        if (override !== undefined) return override;
      }
      if (argv[0] === "version") {
        if (versionError) throw versionError;
        return { stdout: `Android Debug Bridge version ${version}\nInstalled as /usr/local/bin/adb\n`, stderr: "" };
      }
      if (argv[0] === "devices") {
        const raw = typeof fake.devices === "function" ? fake.devices() : fake.devices;
        return { stdout: raw, stderr: "" };
      }
      if (argv[0] === "forward" && argv[1] === "--list") {
        const lines = fake.forwards.map((f) => `${f.serial} tcp:${f.localPort} tcp:${f.remotePort}`);
        return { stdout: lines.length ? `${lines.join("\n")}\n` : "", stderr: "" };
      }
      if (argv[0] === "-s" && argv[2] === "forward" && argv[3] === "--remove") {
        const localPort = Number(String(argv[4] ?? "").replace(/^tcp:/, ""));
        const before = fake.forwards.length;
        fake.forwards = fake.forwards.filter((f) => !(f.serial === argv[1] && f.localPort === localPort));
        if (fake.forwards.length === before) {
          throw Object.assign(new Error(`adb: error: listener 'tcp:${localPort}' not found`), { code: 1 });
        }
        return { stdout: "", stderr: "" };
      }
      if (argv[0] === "-s" && argv[2] === "forward") {
        const localPort = Number(String(argv[3] ?? "").replace(/^tcp:/, ""));
        const remotePort = Number(String(argv[4] ?? "").replace(/^tcp:/, ""));
        if (fake.bindConflicts.has(localPort)) throw bindError(localPort);
        // adb 对同一 local 端口重复 forward 是覆盖（不报错），这里保持一致
        fake.forwards = fake.forwards.filter((f) => !(f.serial === argv[1] && f.localPort === localPort));
        fake.forwards.push({ serial: argv[1], localPort, remotePort });
        return { stdout: "", stderr: "" };
      }
      throw Object.assign(new Error(`unexpected adb command: ${argv.join(" ")}`), { code: "UNEXPECTED" });
    },
  };
  return fake;
}

function forwardCalls(fake) {
  return fake.calls.filter((c) => c.args[0] === "-s" && c.args[2] === "forward");
}
function createForwardCalls(fake) {
  return forwardCalls(fake).filter((c) => c.args[3] !== "--remove");
}
function removeForwardCalls(fake) {
  return forwardCalls(fake).filter((c) => c.args[3] === "--remove");
}

/** 装一台"手机在线、health 正常"的传输；返回 { transport, fakeAdb, fakeFetch, errors, endpointLists }。 */
function onlineTransport({ extraRoutes = {}, forwardBase = DEFAULT_FORWARD_BASE } = {}) {
  const port = usbPortFor(SERIAL, forwardBase, DEFAULT_FORWARD_SPAN);
  const fakeAdb = createFakeAdb();
  const fakeFetch = createFakeFetch({ [healthUrl(port)]: PHONE_HEALTH, ...extraRoutes });
  const errors = [];
  const endpointLists = [];
  const transport = createUsbTransport({
    execFile: fakeAdb.execFile,
    fetchImpl: fakeFetch,
    forwardBase,
    pollMs: 1000,
    probeTimeoutMs: 300,
    log: () => {},
    onError: (e) => errors.push(e),
    onEndpoints: (list) => endpointLists.push(list),
  });
  return { transport, fakeAdb, fakeFetch, errors, endpointLists, port };
}

// ───────────────────────── 1. 解析 ─────────────────────────
console.log("\n── 1. adb 输出解析 ──");

check("parseAdbDevices 解析真机样例（忽略 daemon 噪声，字段齐全）", () => {
  const { devices, skipped } = parseAdbDevices(REAL_DEVICES);
  assert.equal(devices.length, 1);
  assert.equal(skipped.length, 0);
  const d = devices[0];
  assert.equal(d.serial, SERIAL);
  assert.equal(d.state, "device");
  assert.equal(d.model, "2510DPC0");
  assert.equal(d.product, "nuwa");
  assert.equal(d.device, "nuwa");
  assert.equal(d.transport, "usb:1-4");
  assert.equal(d.transportId, 3);
  assert.equal(d.usb, true);
});

check("parseAdbDevices 跳过 unauthorized/offline/no-permissions，并记录原因", () => {
  const { devices, skipped } = parseAdbDevices(SKIPPED_DEVICES);
  assert.equal(devices.length, 0, "不可用状态不能进可用设备列表");
  assert.deepEqual(
    skipped.map((s) => s.reason),
    ["unauthorized", "offline", "no-permissions"],
  );
  assert.equal(skipped[0].transport, "usb:1-5");
});

check("parseAdbDevices 对空输出/垃圾行/无线调试条目都不抛", () => {
  assert.deepEqual(parseAdbDevices(""), { devices: [], skipped: [] });
  assert.deepEqual(parseAdbDevices(null), { devices: [], skipped: [] });
  assert.deepEqual(parseAdbDevices("garbage\n\tsomething weird\n").devices, []);
  // 无线调试（ip:port 当 serial）也是合法条目：forward 一样能用
  const wifi = parseAdbDevices("192.168.1.77:43987 device product:nuwa model:2510DPC0 transport_id:9\n");
  assert.equal(wifi.devices.length, 1);
  assert.equal(wifi.devices[0].serial, "192.168.1.77:43987");
  assert.equal(wifi.devices[0].usb, false);
});

check("parseForwardList 只认 tcp→tcp，忽略本地 socket 与垃圾", () => {
  const list = parseForwardList(
    [
      "1441e87a tcp:46000 tcp:45917",
      "emulator-5554 tcp:46001 tcp:45917",
      "1441e87a localabstract:webview_devtools_remote_1 tcp:9",
      "   ",
      "garbage",
      "",
    ].join("\n"),
  );
  assert.deepEqual(list, [
    { serial: "1441e87a", localPort: 46000, remotePort: 45917 },
    { serial: "emulator-5554", localPort: 46001, remotePort: 45917 },
  ]);
  assert.deepEqual(parseForwardList(""), []);
  assert.deepEqual(parseForwardList(null), []);
});

// ───────────────────────── 2. 端口分配与准入 ─────────────────────────
console.log("\n── 2. 端口分配与 health 准入 ──");

check("usbPortFor 按 serial 稳定（重启不变），落在区间内，不同 serial 有区分度", () => {
  const p1 = usbPortFor(SERIAL);
  const p2 = usbPortFor(SERIAL);
  assert.equal(p1, p2, "同一 serial 必须稳定");
  assert.ok(p1 >= DEFAULT_FORWARD_BASE && p1 < DEFAULT_FORWARD_BASE + DEFAULT_FORWARD_SPAN, `端口越界：${p1}`);
  // 换一个基址，映射仍稳定（同一 serial 的相对偏移不变）
  assert.equal(usbPortFor(SERIAL, 47000, 100) - 47000, p1 - DEFAULT_FORWARD_BASE);
  const ports = new Set([SERIAL, SERIAL2, "emulator-5554", "R58M12345", "1441e87c"].map((s) => usbPortFor(s)));
  assert.ok(ports.size > 1, "不同 serial 不应全挤在同一个端口");
  // 垃圾输入也不抛：null/undefined 按空串处理
  assert.equal(usbPortFor(null), usbPortFor(""));
  assert.equal(usbPortFor(undefined), usbPortFor(""));
});

check("looksLikeMeshHealth 只接受正经 dsh-mesh 记录（非 mesh / UUID id / 无 id 都拒绝）", () => {
  assert.equal(looksLikeMeshHealth(PHONE_HEALTH), true);
  assert.equal(looksLikeMeshHealth({ app: "dsh-mesh", id: "abc" }), true, "老版本缺 v/proto 也认");
  assert.equal(looksLikeMeshHealth({ app: "other-app", id: "abc" }), false);
  assert.equal(looksLikeMeshHealth({ app: "dsh-mesh" }), false);
  assert.equal(looksLikeMeshHealth({ app: "dsh-mesh", id: "0f8fad5b-d9cb-469f-a165-70867728950e" }), false, "UUID 形态不是 mesh id");
  assert.equal(looksLikeMeshHealth({ app: "dsh-mesh", id: "abc", proto: "opencode-mesh" }), false);
  assert.equal(looksLikeMeshHealth(null), false);
});

check("classifyAdbFailure 把 adb 的 stderr 归类成可区分的 code", () => {
  assert.equal(classifyAdbFailure(bindError(46000)).code, "EADDRINUSE");
  assert.equal(classifyAdbFailure(new Error("error: device unauthorized. This adbd's $ADB_VENDOR_KEYS...")).code, "UNAUTHORIZED");
  assert.equal(classifyAdbFailure(new Error("error: device offline")).code, "DEVICE_OFFLINE");
  assert.equal(classifyAdbFailure(Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" })).code, "ENOENT");
  assert.equal(classifyAdbFailure(new Error("error: more than one device/emulator")).code, "MULTIPLE_DEVICES");
  assert.equal(classifyAdbFailure(new Error("something else")).code, "ADB_FAILED");
});

// ───────────────────────── 3. adb 不可用 / 设备不可用 ─────────────────────────
console.log("\n── 3. adb 不可用 / 设备不可用的可观察性 ──");

await checkAsync("adb ENOENT：available=false + reason=ENOENT，只报一次、不刷屏、不抛", async () => {
  const fakeAdb = createFakeAdb({ versionError: Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" }) });
  const fakeFetch = createFakeFetch({ "*": PHONE_HEALTH });
  const errors = [];
  const transport = createUsbTransport({
    execFile: fakeAdb.execFile,
    fetchImpl: fakeFetch,
    probeTimeoutMs: 100,
    log: () => {},
    onError: (e) => errors.push(e),
  });
  const st = await transport.start();
  assert.equal(st.available, false);
  assert.equal(st.reason, "ENOENT");
  assert.equal(st.errors.length, 1, "第一个错误必须进历史");
  assert.equal(errors.length, 1, "onError 只回调一次");
  assert.match(st.errors[0].message, /不代表没有 USB 设备/);
  // 再轮询两次：60s 内不再重试 adb，也不新增错误
  await transport.poll();
  await transport.poll();
  assert.equal(transport.status().errors.length, 1, "同类错误必须折叠，不能每 15s 刷一条");
  assert.equal(errors.length, 1, "onError 不能重复刷屏");
  // 强制重探也不会把同一个错误再记一遍（状态没变）
  await transport.detect();
  assert.equal(transport.status().errors.length, 1);
  assert.equal(fakeFetch.calls.length, 0, "adb 不可用时不应该去探测 health");
  await transport.stop();
});

await checkAsync("设备 unauthorized/offline：跳过并记原因，不建 forward、不探 health", async () => {
  const fakeAdb = createFakeAdb({ devices: SKIPPED_DEVICES });
  const fakeFetch = createFakeFetch({ "*": PHONE_HEALTH });
  const errors = [];
  const transport = createUsbTransport({
    execFile: fakeAdb.execFile,
    fetchImpl: fakeFetch,
    log: () => {},
    onError: (e) => errors.push(e),
  });
  const st = await transport.start();
  assert.equal(st.devices.length, 0);
  assert.deepEqual(st.skipped.map((s) => s.reason), ["unauthorized", "offline", "no-permissions"]);
  const codes = errors.map((e) => `${e.phase}:${e.code}`);
  assert.deepEqual(codes, ["device:UNAUTHORIZED", "device:OFFLINE", "device:NO_PERMISSIONS"]);
  assert.equal(createForwardCalls(fakeAdb).length, 0, "不可用设备不该建 forward");
  assert.equal(fakeFetch.calls.length, 0, "不可用设备不该探 health");
  assert.deepEqual(st.endpoints, []);
  await transport.stop();
});

// ───────────────────────── 4. 正常路径 ─────────────────────────
console.log("\n── 4. 正常路径：forward + health → endpoint ──");

await checkAsync("device + health 200 → endpoint 字段齐全，forward 参数正确", async () => {
  const { transport, fakeAdb, fakeFetch, endpointLists } = onlineTransport();
  const st = await transport.start();
  const expectedPort = usbPortFor(SERIAL);
  assert.equal(st.available, true);
  assert.equal(st.devices.length, 1);
  assert.equal(st.endpoints.length, 1);
  const ep = st.endpoints[0];
  assert.equal(ep.key, `usb:${SERIAL}`);
  assert.equal(ep.transport, TRANSPORT_NAME);
  assert.equal(ep.host, "127.0.0.1");
  assert.equal(ep.port, expectedPort);
  assert.equal(ep.serial, SERIAL);
  assert.equal(ep.machine, PHONE_HEALTH.machine);
  assert.equal(ep.id, PHONE_HEALTH.id);
  // 完整的 endpoint（含 record）在 onEndpoints 里
  assert.equal(endpointLists.length >= 1, true, "onEndpoints 必须回调");
  const full = endpointLists[endpointLists.length - 1][0];
  assert.equal(full.version, PHONE_HEALTH.version);
  assert.equal(full.os, PHONE_HEALTH.os);
  assert.equal(full.record.app, "dsh-mesh");
  assert.equal(full.remotePort, DEFAULT_DEVICE_PORT);
  assert.ok(full.rttMs >= 0);
  // 命令形状：adb -s <serial> forward tcp:<local> tcp:<devicePort>
  const creates = createForwardCalls(fakeAdb);
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].args, ["-s", SERIAL, "forward", `tcp:${expectedPort}`, `tcp:${DEFAULT_DEVICE_PORT}`]);
  // health 只探了一次，且是 127.0.0.1
  assert.equal(fakeFetch.calls.length, 1);
  assert.equal(fakeFetch.calls[0].url, healthUrl(expectedPort));
  await transport.stop();
});

await checkAsync("两个设备 → 两个端点、端口互不相同、key 不串", async () => {
  const devices = [
    "List of devices attached",
    "1441e87a device usb:1-4 product:nuwa model:2510DPC0 device:nuwa transport_id:3",
    "1441e87c device usb:1-6 product:nuwa model:2510DPC0 device:nuwa transport_id:5",
    "",
  ].join("\n");
  const fakeAdb = createFakeAdb({ devices });
  const portA = usbPortFor(SERIAL);
  const portB = usbPortFor("1441e87c");
  const fakeFetch = createFakeFetch({
    [healthUrl(portA)]: { ...PHONE_HEALTH, id: "aaaaaaaaaaaaaaaa", machine: "phone-a" },
    [healthUrl(portB)]: { ...PHONE_HEALTH, id: "bbbbbbbbbbbbbbbb", machine: "phone-b" },
  });
  const transport = createUsbTransport({ execFile: fakeAdb.execFile, fetchImpl: fakeFetch, log: () => {} });
  const st = await transport.start();
  assert.equal(st.endpoints.length, 2);
  const keys = st.endpoints.map((e) => e.key).sort();
  assert.deepEqual(keys, [`usb:1441e87a`, `usb:1441e87c`]);
  assert.notEqual(st.endpoints[0].port, st.endpoints[1].port);
  await transport.stop();
});

// ───────────────────────── 5. 幂等与复用 ─────────────────────────
console.log("\n── 5. forward 幂等 / 复用已有映射 ──");

await checkAsync("重复轮询只建一次 forward；public ensureForward 第二次返回 reused", async () => {
  const { transport, fakeAdb } = onlineTransport();
  await transport.start();
  await transport.poll();
  await transport.poll();
  assert.equal(createForwardCalls(fakeAdb).length, 1, "每轮轮询都重建 forward 是不可接受的");
  assert.equal(fakeAdb.forwards.length, 1);
  // 直接调用 ensureForward：已有映射 → reused，且不再发 create 命令
  const port = usbPortFor(SERIAL);
  const r = await transport.ensureForward(SERIAL, port);
  assert.equal(r.ok, true);
  assert.equal(r.reused, true);
  assert.equal(createForwardCalls(fakeAdb).length, 1);
  await transport.stop();
});

await checkAsync("复用已有 forward（用户手建 tcp:45917）→ 不重复创建；stop 不删别人的映射", async () => {
  const fakeAdb = createFakeAdb({ forwards: [{ serial: SERIAL, localPort: 45917, remotePort: DEFAULT_DEVICE_PORT }] });
  const fakeFetch = createFakeFetch({ [healthUrl(45917)]: PHONE_HEALTH });
  const transport = createUsbTransport({ execFile: fakeAdb.execFile, fetchImpl: fakeFetch, log: () => {} });
  const st = await transport.start();
  assert.equal(st.endpoints.length, 1);
  assert.equal(st.endpoints[0].port, 45917, "复用已有映射，不另开端口");
  assert.equal(createForwardCalls(fakeAdb).length, 0, "已有映射时不该再建");
  assert.equal(st.forwards[0].createdByUs, false);
  assert.equal(st.forwards[0].adopted, true);
  assert.equal(fakeAdb.forwards.length, 1);
  await transport.stop();
  assert.equal(removeForwardCalls(fakeAdb).length, 0, "复用来的 forward 不是我们建的，stop 不能删");
  assert.equal(fakeAdb.forwards.length, 1);
});

// ───────────────────────── 6. 端口冲突 ─────────────────────────
console.log("\n── 6. 端口冲突顺延 ──");

await checkAsync("hash 端口已被别的设备映射占用 → 顺延到下一个空闲端口", async () => {
  const hashPort = usbPortFor(SERIAL);
  const span = DEFAULT_FORWARD_SPAN;
  const offset = (hashPort - DEFAULT_FORWARD_BASE) % span;
  const nextPort = DEFAULT_FORWARD_BASE + ((offset + 1) % span);
  const fakeAdb = createFakeAdb({ forwards: [{ serial: "otherphone", localPort: hashPort, remotePort: DEFAULT_DEVICE_PORT }] });
  const fakeFetch = createFakeFetch({ [healthUrl(nextPort)]: PHONE_HEALTH });
  const transport = createUsbTransport({ execFile: fakeAdb.execFile, fetchImpl: fakeFetch, log: () => {} });
  const st = await transport.start();
  assert.equal(st.endpoints.length, 1);
  assert.equal(st.endpoints[0].port, nextPort, "被占的端口必须跳过");
  assert.equal(fakeAdb.forwards.length, 2, "原映射必须保留");
  const created = fakeAdb.forwards.find((f) => f.serial === SERIAL);
  assert.equal(created.localPort, nextPort);
  await transport.stop();
});

await checkAsync("adb 报 cannot bind（端口被别的进程占用）→ 自动换端口成功，并留下 EADDRINUSE 证据", async () => {
  const hashPort = usbPortFor(SERIAL);
  const span = DEFAULT_FORWARD_SPAN;
  const offset = (hashPort - DEFAULT_FORWARD_BASE) % span;
  const nextPort = DEFAULT_FORWARD_BASE + ((offset + 1) % span);
  const fakeAdb = createFakeAdb();
  fakeAdb.bindConflicts.add(hashPort);
  const fakeFetch = createFakeFetch({ [healthUrl(nextPort)]: PHONE_HEALTH });
  const errors = [];
  const transport = createUsbTransport({
    execFile: fakeAdb.execFile,
    fetchImpl: fakeFetch,
    log: () => {},
    onError: (e) => errors.push(e),
  });
  const st = await transport.start();
  assert.equal(st.endpoints.length, 1);
  assert.equal(st.endpoints[0].port, nextPort, "绑定失败后必须顺延");
  const created = fakeAdb.forwards.find((f) => f.serial === SERIAL);
  assert.equal(created.localPort, nextPort);
  assert.ok(st.errors.some((e) => e.code === "EADDRINUSE"), "端口冲突必须可观察，不能静默换端口");
  assert.ok(errors.some((e) => e.code === "EADDRINUSE"));
  await transport.stop();
});

// ───────────────────────── 7. 探测失败分类 ─────────────────────────
console.log("\n── 7. 探测失败不伪装成「设备不存在」──");

await checkAsync("health 200 但不是 mesh（端口被别的服务占用）→ NOT_MESH，无端点", async () => {
  const fakeAdb = createFakeAdb();
  const fakeFetch = createFakeFetch({ "*": { body: { app: "other-app", id: "x" }, status: 200 } });
  const errors = [];
  const t2 = createUsbTransport({ execFile: fakeAdb.execFile, fetchImpl: fakeFetch, log: () => {}, onError: (e) => errors.push(e) });
  const st = await t2.start();
  assert.equal(st.endpoints.length, 0);
  assert.equal(st.devices.length, 1, "设备仍然在，只是没探测成功");
  assert.ok(st.errors.some((e) => e.code === "NOT_MESH"), `期望 NOT_MESH，实际 ${st.errors.map((e) => e.code).join(",")}`);
  assert.match(st.errors.find((e) => e.code === "NOT_MESH").message, /不是 dsh-mesh/);
  await t2.stop();
});

await checkAsync("health 404 → HTTP_404（有服务但不是 mesh），无端点", async () => {
  const fakeAdb = createFakeAdb();
  const fakeFetch = createFakeFetch({ "*": { body: { error: "nope" }, status: 404 } });
  const transport = createUsbTransport({ execFile: fakeAdb.execFile, fetchImpl: fakeFetch, log: () => {} });
  const st = await transport.start();
  assert.equal(st.endpoints.length, 0);
  assert.ok(st.errors.some((e) => e.code === "HTTP_404"), st.errors.map((e) => e.code).join(","));
  await transport.stop();
});

await checkAsync("探测超时（fetch 永不返回）→ ETIMEDOUT，按时返回、不崩、不挂死", async () => {
  const fakeAdb = createFakeAdb();
  const fakeFetch = createFakeFetch({ "*": "timeout" });
  const errors = [];
  const transport = createUsbTransport({
    execFile: fakeAdb.execFile,
    fetchImpl: fakeFetch,
    probeTimeoutMs: 30,
    log: () => {},
    onError: (e) => errors.push(e),
  });
  const started = Date.now();
  const st = await transport.start();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `探测超时必须按时返回，实际 ${elapsed}ms`);
  assert.equal(st.endpoints.length, 0);
  assert.ok(st.errors.some((e) => e.code === "ETIMEDOUT"), st.errors.map((e) => e.code).join(","));
  assert.equal(st.available, true, "探测超时不等于 adb 不可用");
  assert.equal(st.devices.length, 1, "探测超时不等于设备不存在");
  await transport.stop();
});

await checkAsync("设备中途拔掉：端点清空、回调空列表、不崩", async () => {
  let devices = REAL_DEVICES;
  const fakeAdb = createFakeAdb({ devices: () => devices });
  const fakeFetch = createFakeFetch({ "*": PHONE_HEALTH });
  const endpointLists = [];
  const transport = createUsbTransport({
    execFile: fakeAdb.execFile,
    fetchImpl: fakeFetch,
    log: () => {},
    onEndpoints: (list) => endpointLists.push(list.length),
  });
  let st = await transport.start();
  assert.equal(st.endpoints.length, 1);
  devices = "List of devices attached\n";
  st = await transport.poll();
  assert.equal(st.endpoints.length, 0);
  assert.equal(st.devices.length, 0);
  assert.equal(endpointLists[endpointLists.length - 1], 0, "拔掉后必须回调空列表，让注册表撤下端点");
  await transport.stop();
});

// ───────────────────────── 8. 生命周期 ─────────────────────────
console.log("\n── 8. start/stop 幂等与清理 ──");

await checkAsync("重复 start 幂等：只发起一次 adb version，不叠加定时器", async () => {
  const { transport, fakeAdb } = onlineTransport();
  await transport.start();
  const pollCountAfterFirst = transport.status().pollCount;
  await transport.start();
  await transport.start();
  assert.equal(transport.status().pollCount, pollCountAfterFirst, "重复 start 不应再轮询一轮");
  assert.equal(fakeAdb.calls.filter((c) => c.args[0] === "version").length, 1);
  assert.equal(transport.status().started, true);
  await transport.stop();
});

await checkAsync("stop 清理本模块创建的 forward 与定时器；重复 stop 无副作用", async () => {
  const fakeAdb = createFakeAdb();
  // 用一个很短的轮询周期，确认 stop 之后定时器真的不再触发
  const fakeTransport = createUsbTransport({
    execFile: fakeAdb.execFile,
    fetchImpl: createFakeFetch({ "*": PHONE_HEALTH }),
    pollMs: 30,
    log: () => {},
  });
  await fakeTransport.start();
  await sleep(150);
  const pollsBeforeStop = fakeTransport.status().pollCount;
  assert.ok(pollsBeforeStop >= 2, `定时轮询应已触发多次，实际 ${pollsBeforeStop}`);
  const created = fakeAdb.forwards.find((f) => f.serial === SERIAL);
  assert.ok(created, "开始阶段应已建立 forward");
  const st = await fakeTransport.stop();
  assert.equal(st.started, false);
  assert.equal(st.endpoints.length, 0);
  assert.ok(
    removeForwardCalls(fakeAdb).some((c) => c.args[4] === `tcp:${created.localPort}`),
    "stop 必须移除自己建的 forward",
  );
  assert.equal(fakeAdb.forwards.length, 0, "清理后不应留下自己建的映射");
  const removesAfterFirstStop = removeForwardCalls(fakeAdb).length;
  await fakeTransport.stop();
  assert.equal(removeForwardCalls(fakeAdb).length, removesAfterFirstStop, "重复 stop 不该再发清理命令");
  await sleep(120);
  assert.equal(fakeTransport.status().pollCount, pollsBeforeStop, "stop 之后定时器必须不再轮询");
});

await checkAsync("stop 打断进行中的轮询：停止后不再发布端点、不遗留 forward", async () => {
  // 真实场景：插件被卸载（ctx.effect 清理）时，定时轮询可能正探到一半。
  // 如果这一轮回来后还继续"发布端点 + 建 forward"，就是卸载后的资源泄漏。
  const fakeAdb = createFakeAdb();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fakeFetch = createFakeFetch(async () => {
    await gate; // 把探测挂住，等 stop 先跑
    return jsonResponse(PHONE_HEALTH);
  });
  const endpointLists = [];
  const transport = createUsbTransport({
    execFile: fakeAdb.execFile,
    fetchImpl: fakeFetch,
    pollMs: 1000,
    probeTimeoutMs: 5000,
    log: () => {},
    onEndpoints: (list) => endpointLists.push(list.length),
  });
  const started = transport.start();
  await sleep(30); // 让轮询执行到 probe（fake adb 都是立即返回）
  const stopped = transport.stop();
  release();
  await Promise.all([started, stopped]);
  const st = transport.status();
  assert.equal(st.started, false);
  assert.equal(st.polling, false);
  assert.equal(st.endpoints.length, 0, "stop 之后不许再发布端点");
  assert.equal(endpointLists.filter((n) => n > 0).length, 0, "作废的轮询不能发布非空端点列表");
  assert.equal(fakeAdb.forwards.length, 0, "stop 清理后不能遗留 forward");
  await transport.stop();
});

await checkAsync("probe 无 forward / ensureForward 非法参数 → 结构化失败，不抛", async () => {
  const fakeAdb = createFakeAdb();
  const transport = createUsbTransport({ execFile: fakeAdb.execFile, fetchImpl: createFakeFetch({}), log: () => {} });
  const noForward = await transport.probe(SERIAL);
  assert.equal(noForward.ok, false);
  assert.equal(noForward.error.code, "NO_FORWARD");
  const emptySerial = await transport.probe("");
  assert.equal(emptySerial.ok, false);
  assert.equal(emptySerial.error.code, "INVALID_ARGUMENT");
  const badForward = await transport.ensureForward("", 0);
  assert.equal(badForward.ok, false);
  assert.equal(badForward.code, "INVALID_ARGUMENT");
  const removeNothing = await transport.removeForward("nope");
  assert.equal(removeNothing.ok, true);
  assert.equal(removeNothing.removed, false);
  // 全程不应向 adb 发任何命令（参数校验在调用前就完成）
  assert.equal(fakeAdb.calls.length, 0);
});

await checkAsync("永不 throw：垃圾 opts / execFile 同步抛 / fetch 同步抛 / adb 输出乱码", async () => {
  // ① 构造时传垃圾参数，status/getOptions 也不能抛
  const empty = createUsbTransport(null);
  assert.equal(empty.status().transport, TRANSPORT_NAME);
  assert.equal(empty.status().available, false);
  assert.equal(empty.getOptions().devicePort, DEFAULT_DEVICE_PORT);
  assert.equal(createUsbTransport("garbage").status().started, false);

  // ② execFile 同步抛（模拟注入实现写错）
  const throwingExec = createUsbTransport({
    execFile: () => {
      throw new Error("sync boom");
    },
    fetchImpl: () => {
      throw new Error("fetch boom");
    },
    log: () => {},
  });
  const st1 = await throwingExec.start();
  assert.equal(st1.available, false);
  assert.equal(st1.errors.length >= 1, true);

  // ③ adb 回复乱码：当作没有可用设备，不崩
  const garbageAdb = createFakeAdb({ devices: "完全不是 adb 的输出\n\x00\x01" });
  const garbage = createUsbTransport({ execFile: garbageAdb.execFile, fetchImpl: createFakeFetch({}), log: () => {} });
  const st2 = await garbage.start();
  assert.deepEqual(st2.devices, []);
  assert.deepEqual(st2.endpoints, []);

  // ④ 所有方法在异常状态下仍然返回结构
  await throwingExec.poll();
  await throwingExec.detect();
  await throwingExec.listDevices();
  await throwingExec.stop();
  await garbage.stop();
  assert.equal(typeof throwingExec.status(), "object");
  assert.equal(Array.isArray(await throwingExec.listDevices()), true);
});

// ───────────────────────── 汇总 ─────────────────────────
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
