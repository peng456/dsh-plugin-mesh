/**
 * netinfo 的自测：**全离线**，不依赖真实网卡/真实网络。
 *
 * 跑法：node lib/_selftest-netinfo.mjs
 *
 * 为什么需要它：lib/netinfo.js 是 P0 的"安全网"——它的所有调用点（构造函数、
 * 每 5s 心跳、HTTP 健康检查、UI state）都假定它**绝不抛**。这几条路径一旦有
 * 一条抛异常，Android 上就是"整个 Mesh 不可用/整页 500"，而桌面上根本复现
 * 不出来（桌面网卡正常）。所以必须用注入把六种形态都钉住：
 *
 *   1. 正常路径（os 给出可用地址与 MAC）
 *   2. `os.networkInterfaces()` 抛 EPERM（Android app UID 的典型形态）
 *   3. 返回空对象（"看起来正常但没有内容"）
 *   4. UDP 源地址兜底（成功 / 无网 / 回环）
 *   5. `advertiseAddress` 覆盖（合法 / 带端口 / 非法 / 空）
 *   6. 永不抛（垃圾输入 + 各探测点全炸）
 *
 * 另附：MAC 不可用的显式表达、/proc 解析器、staticPeers 规格解析、以及
 * discovery/scan 层在"网卡枚举抛错"时仍能工作的回归用例。
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  collectNetInfo,
  collectNetInfoAsync,
  configureNetInfo,
  currentNetInfo,
  preferredAddressFrom,
  udpSourceAddress,
  normalizeInterfaces,
  usableMac,
  isIPv4,
  isUsableIPv4,
  parseHostPort,
  parsePeerSpec,
  peerHostsFromSpecs,
  peerPortsFromSpecs,
  parseProcNetRoute,
  parseProcFibTrie,
  __resetNetInfoForTest,
  __getNetInfoStateForTest,
} from "./netinfo.js";
import { MeshDiscovery, preferredAddress } from "./discovery.js";
import { candidateAddresses, scanForPeers } from "./scan.js";
import { createServer } from "node:http";

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

/** 一份"桌面正常机器"的网卡 fixture：Wi-Fi 有 IPv4/IPv6，另有一个 WSL 网桥。 */
function normalInterfaces() {
  return {
    "Wi-Fi": [
      { family: "IPv4", address: "192.168.1.19", internal: false, mac: "ac:f2:3c:d9:26:3d" },
      { family: "IPv6", address: "2408:8207:60a0:8720:2823:9f38:b338:6b68", internal: false, mac: "ac:f2:3c:d9:26:3d" },
      { family: "IPv4", address: "127.0.0.1", internal: true, mac: "00:00:00:00:00:00" },
    ],
    "vEthernet (WSL)": [{ family: "IPv4", address: "172.18.176.1", internal: false, mac: "00:15:5d:ee:27:3c" }],
  };
}

/** EPERM 形态的错误（uv_interface_addresses 被 SELinux 拒时 Node 报的样子）。 */
function eperm() {
  return Object.assign(new Error("uv_interface_addresses returned Unknown system error 13, Permission denied"), {
    code: "EPERM",
  });
}

/** 读文件永远失败（模拟 /proc 不可读）。 */
function readFileFails(code = "EACCES") {
  return () => {
    throw Object.assign(new Error(`${code}: read failed`), { code });
  };
}

const FIB_TRIE_FIXTURE = [
  "Main:",
  "  +-- 0.0.0.0/0 3 0 5",
  "     |-- 0.0.0.0",
  "        /0 universe UNICAST",
  "Local:",
  "  +-- 192.168.1.0/24 3 0 2",
  "     |-- 192.168.1.0",
  "        /32 link BROADCAST",
  "        /24 link UNICAST",
  "     |-- 192.168.1.19",
  "        /32 host LOCAL",
  "     |-- 127.0.0.1",
  "        /32 host LOCAL",
  "",
].join("\n");

const PROC_ROUTE_FIXTURE = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "wlan0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
  "wlan0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0",
  "",
].join("\n");

__resetNetInfoForTest();

// ───────────────────────── 1. 正常路径 ─────────────────────────
console.log("\n── 1. 正常路径（os 给出可用地址与 MAC）──");

check("os 可用：source=os，选中 Wi-Fi 的 192.168.1.19（接口名打分优先）", () => {
  const info = collectNetInfo({ deps: { networkInterfaces: normalInterfaces } });
  assert.equal(info.source, "os");
  assert.equal(info.lanIPv4, "192.168.1.19");
  assert.equal(info.macsAvailable, true);
  assert.deepEqual(info.errors, []);
});

check("os 可用：全局 IPv6 被带出来（回环/link-local 不算）", () => {
  const info = collectNetInfo({ deps: { networkInterfaces: normalInterfaces } });
  assert.match(String(info.lanIPv6 ?? ""), /^2408:/);
});

check("preferredAddressFrom 取采集结果；拿不到才退回 127.0.0.1", () => {
  const info = collectNetInfo({ deps: { networkInterfaces: normalInterfaces } });
  assert.equal(preferredAddressFrom(info), "192.168.1.19");
  assert.equal(preferredAddressFrom(null), "127.0.0.1");
  assert.equal(preferredAddressFrom({ lanIPv4: "0.0.0.0" }), "127.0.0.1");
});

check("normalizeInterfaces：family 数字 4/6 归一化，坏条目跳过", () => {
  const out = normalizeInterfaces({
    eth0: [
      { family: 4, address: "10.0.0.5", internal: false, mac: "aa:bb:cc:dd:ee:ff" },
      { family: 6, address: "fe80::1", internal: false },
      null,
      { family: "IPv4" }, // 没有 address → 跳过
    ],
    broken: "not-an-array",
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].family, "IPv4");
  assert.equal(out[1].family, "IPv6");
});

// ───────────────────────── 2. EPERM ─────────────────────────
console.log("\n── 2. os.networkInterfaces() 抛 EPERM（Android app UID 形态）──");

check("EPERM：不抛、source=none、错误里带 EPERM（而不是伪装成没有地址）", () => {
  const info = collectNetInfo({
    deps: { networkInterfaces: () => { throw eperm(); }, readFile: readFileFails("EACCES") },
  });
  assert.equal(info.source, "none");
  assert.equal(info.lanIPv4, "");
  assert.equal(info.macsAvailable, false);
  const osErr = info.errors.find((e) => e.source === "os");
  assert.ok(osErr, `应记录 os 探测错误：${JSON.stringify(info.errors)}`);
  assert.equal(osErr.code, "EPERM");
  assert.ok(info.errors.some((e) => e.source === "proc" && e.code === "EACCES"), "proc 失败也应记录");
});

check("MAC 全为 0：macsAvailable=false 且显式报 MAC_UNAVAILABLE", () => {
  const info = collectNetInfo({
    deps: {
      networkInterfaces: () => ({
        wlan0: [{ family: "IPv4", address: "192.168.1.19", internal: false, mac: "00:00:00:00:00:00" }],
      }),
    },
  });
  assert.equal(info.source, "os");
  assert.equal(info.macsAvailable, false);
  assert.ok(
    info.errors.some((e) => e.code === "MAC_UNAVAILABLE"),
    `应在 errors 里明说 MAC 不可用：${JSON.stringify(info.errors)}`,
  );
});

check("usableMac：全 0 / 空 / 非法形态都算不可用，正常 MAC 可用", () => {
  assert.equal(usableMac("ac:f2:3c:d9:26:3d"), true);
  assert.equal(usableMac("AC-F2-3C-D9-26-3D"), true);
  assert.equal(usableMac("00:00:00:00:00:00"), false);
  assert.equal(usableMac(""), false);
  assert.equal(usableMac("not-a-mac"), false);
});

// ───────────────────────── 3. 空对象 ─────────────────────────
console.log("\n── 3. os.networkInterfaces() 返回空对象 ──");

check("空对象：不抛；报 EMPTY；用 /proc 兜底拿到 192.168.1.19（source=proc）", () => {
  const info = collectNetInfo({
    deps: {
      networkInterfaces: () => ({}),
      readFile: (path) => (String(path).includes("fib_trie") ? FIB_TRIE_FIXTURE : PROC_ROUTE_FIXTURE),
    },
  });
  assert.equal(info.source, "proc");
  assert.equal(info.lanIPv4, "192.168.1.19");
  assert.ok(info.errors.some((e) => e.source === "os" && e.code === "EMPTY"));
});

check("空对象 + /proc 也不可用：source=none、lanIPv4 空，但不抛", () => {
  const info = collectNetInfo({
    deps: { networkInterfaces: () => ({}), readFile: readFileFails("ENOENT") },
  });
  assert.equal(info.source, "none");
  assert.equal(info.lanIPv4, "");
});

check("/proc 解析器：默认网关小端解码、fib_trie 取 LOCAL 地址（跳过回环）", () => {
  const route = parseProcNetRoute(PROC_ROUTE_FIXTURE);
  assert.equal(route.defaultGateway, "192.168.1.1");
  assert.equal(route.defaultIface, "wlan0");
  assert.deepEqual(parseProcFibTrie(FIB_TRIE_FIXTURE), ["192.168.1.19"]);
});

// ───────────────────────── 4. UDP 兜底 ─────────────────────────
console.log("\n── 4. UDP 源地址兜底 ──");

await checkAsync("collectNetInfoAsync：os/proc 全失败时用 UDP 兜底（source=udp）并写缓存", async () => {
  __resetNetInfoForTest();
  const deps = {
    networkInterfaces: () => {
      throw eperm();
    },
    readFile: readFileFails("ENOENT"),
    udpConnect: async (target) => ({ address: "192.168.1.19", target }),
  };
  const info = await collectNetInfoAsync({ deps, targets: ["223.5.5.5"] });
  assert.equal(info.lanIPv4, "192.168.1.19");
  assert.equal(info.source, "udp");
  // 缓存写进去了：之后的同步采集（同样的坏 deps）不再需要网络
  assert.equal(__getNetInfoStateForTest().udpHint?.address, "192.168.1.19");
  const sync = collectNetInfo({ deps: { networkInterfaces: deps.networkInterfaces, readFile: deps.readFile } });
  assert.equal(sync.source, "udp");
  assert.equal(sync.lanIPv4, "192.168.1.19");
  __resetNetInfoForTest();
});

await checkAsync("UDP 无网时安全返回 null（不抛、不卡死）", async () => {
  const out = await udpSourceAddress({
    targets: ["223.5.5.5"],
    deps: {
      readFile: readFileFails("ENOENT"),
      udpConnect: async () => {
        throw Object.assign(new Error("ENETUNREACH"), { code: "ENETUNREACH" });
      },
    },
  });
  assert.equal(out, null);
});

await checkAsync("UDP 探测拒绝回环/未指定地址（不能把 127.0.0.1 当对外地址）", async () => {
  assert.equal(
    await udpSourceAddress({ targets: ["223.5.5.5"], deps: { readFile: readFileFails("ENOENT"), udpConnect: async () => "127.0.0.1" } }),
    null,
  );
  assert.equal(
    await udpSourceAddress({ targets: ["223.5.5.5"], deps: { readFile: readFileFails("ENOENT"), udpConnect: async () => "0.0.0.0" } }),
    null,
  );
});

await checkAsync("UDP 成功：返回 {address, target}；目标按顺序试到第一个可用的", async () => {
  const tried = [];
  const out = await udpSourceAddress({
    targets: ["10.9.9.9", "223.5.5.5"],
    deps: {
      readFile: readFileFails("ENOENT"),
      udpConnect: async (target) => {
        tried.push(target);
        if (target === "10.9.9.9") throw Object.assign(new Error("ENETUNREACH"), { code: "ENETUNREACH" });
        return { address: "192.168.1.19" };
      },
    },
  });
  assert.deepEqual(tried, ["10.9.9.9", "223.5.5.5"]);
  assert.deepEqual(out, { address: "192.168.1.19", target: "223.5.5.5" });
});

await checkAsync("UDP 兜底也失败：errors 里留一条 udp 记录，整体仍不抛", async () => {
  __resetNetInfoForTest();
  const info = await collectNetInfoAsync({
    deps: {
      networkInterfaces: () => {
        throw eperm();
      },
      readFile: readFileFails("ENOENT"),
      udpConnect: async () => {
        throw Object.assign(new Error("ENETUNREACH"), { code: "ENETUNREACH" });
      },
    },
    targets: ["223.5.5.5"],
  });
  assert.equal(info.lanIPv4, "");
  assert.ok(info.errors.some((e) => e.source === "udp"));
  __resetNetInfoForTest();
});

// ───────────────────────── 5. advertiseAddress ─────────────────────────
console.log("\n── 5. advertiseAddress 覆盖 ──");

check("合法 IPv4：source=config，覆盖 os 探测结果", () => {
  __resetNetInfoForTest();
  const info = collectNetInfo({ advertiseAddress: "192.168.1.100", deps: { networkInterfaces: normalInterfaces } });
  assert.equal(info.source, "config");
  assert.equal(info.lanIPv4, "192.168.1.100");
  // 探测到的网卡信息仍然保留（UI/MAC 还需要它）
  assert.ok(info.addresses.some((a) => a.address === "192.168.1.19"));
});

check("带端口写法：端口被忽略，只取 host", () => {
  const info = collectNetInfo({ advertiseAddress: "192.168.1.100:45917", deps: { networkInterfaces: normalInterfaces } });
  assert.equal(info.source, "config");
  assert.equal(info.lanIPv4, "192.168.1.100");
});

check("非法值：记 config/INVALID，然后继续用探测结果（绝不变成没有地址）", () => {
  const info = collectNetInfo({ advertiseAddress: "10.0.0.999", deps: { networkInterfaces: normalInterfaces } });
  assert.equal(info.source, "os");
  assert.equal(info.lanIPv4, "192.168.1.19");
  assert.ok(info.errors.some((e) => e.source === "config" && e.code === "INVALID"));
});

check("空字符串 = 自动探测；configureNetInfo/currentNetInfo 写入生效", () => {
  __resetNetInfoForTest();
  assert.equal(collectNetInfo({ advertiseAddress: "", deps: { networkInterfaces: normalInterfaces } }).source, "os");
  configureNetInfo({ advertiseAddress: "192.168.1.101" });
  assert.equal(__getNetInfoStateForTest().advertiseAddress, "192.168.1.101");
  assert.equal(currentNetInfo().source, "config");
  assert.equal(currentNetInfo().lanIPv4, "192.168.1.101");
  __resetNetInfoForTest();
});

// ───────────────────────── 6. 永不抛 ─────────────────────────
console.log("\n── 6. 永不抛（垃圾输入 / 所有探测点都炸）──");

check("deps 全炸（含非 Error 值）也不抛，返回空结构", () => {
  const info = collectNetInfo({
    deps: {
      networkInterfaces: () => {
        throw "boom"; // eslint-disable-line no-throw-literal
      },
      readFile: () => {
        throw null; // eslint-disable-line no-throw-literal
      },
    },
  });
  assert.equal(typeof info, "object");
  assert.equal(info.lanIPv4, "");
  assert.equal(info.source, "none");
  assert.ok(Array.isArray(info.errors));
});

check("垃圾 advertiseAddress（对象/数组）不抛，只记 INVALID", () => {
  const info = collectNetInfo({ advertiseAddress: {}, deps: { networkInterfaces: normalInterfaces } });
  assert.equal(info.source, "os");
  assert.ok(info.errors.some((e) => e.code === "INVALID"));
  assert.doesNotThrow(() => collectNetInfo({ advertiseAddress: [] }));
});

check("形状校验：isIPv4 / isUsableIPv4 不把怪值当地址", () => {
  assert.equal(isIPv4("192.168.1.19"), true);
  assert.equal(isIPv4("999.1.1.1"), false);
  assert.equal(isIPv4("192.168.1"), false);
  assert.equal(isUsableIPv4("127.0.0.1"), false);
  assert.equal(isUsableIPv4("169.254.1.1"), false);
  assert.equal(isUsableIPv4("192.168.1.19"), true);
});

check("staticPeers 规格解析：host:port / 纯 host / 非法值；主机与端口各取所需", () => {
  assert.deepEqual(parseHostPort("192.168.1.6:45917"), { host: "192.168.1.6", port: 45917 });
  assert.deepEqual(parseHostPort("192.168.1.6"), { host: "192.168.1.6", port: 0 });
  assert.equal(parseHostPort("192.168.1.6:99999"), null);
  assert.equal(parsePeerSpec("http://192.168.1.6"), null);
  assert.deepEqual(parsePeerSpec("desktoppc.local:45917"), { host: "desktoppc.local", port: 45917 });
  assert.deepEqual(peerHostsFromSpecs(["192.168.1.6:45917", "192.168.1.6", "bad host", "10.0.0.2"]), [
    "192.168.1.6",
    "10.0.0.2",
  ]);
  assert.deepEqual(peerPortsFromSpecs(["192.168.1.6:45917", "192.168.1.6", "10.0.0.2:5000"]), [45917, 5000]);
});

// ───────────────────────── 7. 调用点回归（discovery/scan）─────────────────────────
console.log("\n── 7. 调用点回归：网卡枚举抛错时 discovery/scan 仍工作 ──");

check("preferredAddress() 在 os.networkInterfaces 抛错时返回 127.0.0.1（不抛）", () => {
  const real = os.networkInterfaces;
  os.networkInterfaces = () => {
    throw eperm();
  };
  try {
    assert.equal(preferredAddress(), "127.0.0.1");
  } finally {
    os.networkInterfaces = real;
  }
});

check("MeshDiscovery 在网卡枚举抛错时仍能构造（不再导致插件被停用）", () => {
  const real = os.networkInterfaces;
  os.networkInterfaces = () => {
    throw eperm();
  };
  try {
    const d = new MeshDiscovery({ id: "selftest-netinfo", port: 45917, meta: { machine: "netinfo-probe" } });
    assert.equal(d.address, "127.0.0.1");
    assert.equal(d.selfRecord().host, "127.0.0.1");
    assert.equal(d.netInfo().macsAvailable, false);
    assert.ok(Array.isArray(d.netInfo().errors) && d.netInfo().errors.length > 0);
  } finally {
    os.networkInterfaces = real;
  }
});

check("candidateAddresses：网卡枚举抛错时 scanRanges 与 staticPeers 仍然生效", () => {
  const real = os.networkInterfaces;
  os.networkInterfaces = () => {
    throw eperm();
  };
  try {
    const list = candidateAddresses(["192.168.1.0/30"], 1024, ["192.168.1.6"]);
    assert.ok(list.includes("192.168.1.6"), `staticPeers 应进候选：${list.join(",")}`);
    assert.ok(list.includes("192.168.1.2"), `scanRanges 应生效：${list.join(",")}`);
    assert.ok(!list.some((x) => x.startsWith("127.")), "不应退化成回环");
  } finally {
    os.networkInterfaces = real;
  }
});

check("MeshDiscovery 的 advertiseAddress 选项生效（自述 host 用它）", () => {
  __resetNetInfoForTest();
  const d = new MeshDiscovery({
    id: "selftest-netinfo-2",
    port: 45917,
    meta: { machine: "netinfo-probe" },
    advertiseAddress: "192.168.1.102",
  });
  try {
    assert.equal(d.address, "192.168.1.102");
    assert.equal(d.selfRecord().host, "192.168.1.102");
    assert.equal(d.netInfo().source, "config");
  } finally {
    __resetNetInfoForTest();
  }
});

await checkAsync("显式候选地址（staticPeers 的扫描路径）能直接探到 /mesh/v1/health 并带出记录", async () => {
  // 这条覆盖 P0-3/P0-4 的实际动作：`staticPeers` 最终就是"拿显式地址去 scanForPeers"。
  // 用 127.0.0.1 的本机 http 服务，不碰外网。
  const server = createServer((req, res) => {
    if (req.url !== "/mesh/v1/health") {
      res.writeHead(404).end("{}");
      return;
    }
    const body = JSON.stringify({ app: "dsh-mesh", id: "fake-peer", machine: "static-peer", host: "127.0.0.1", port: 45917 });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const found = await scanForPeers({ addresses: ["127.0.0.1"], ports: [port], timeoutMs: 1500, concurrency: 2 });
    assert.equal(found.length, 1, `应命中 1 台，实际 ${found.length}`);
    assert.equal(found[0].app, "dsh-mesh");
    assert.equal(found[0].sourceAddress, "127.0.0.1");
    assert.equal(found[0].port, 45917, "命中记录必须带对端 HTTP 端口（注册要用）");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ───────────────────────── 汇总 ─────────────────────────
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
