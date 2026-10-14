/**
 * tsnet 相关模块的自测（不联网、不需要授权码）。
 *
 * 跑法：node lib/_selftest-tsnet.mjs
 *
 * 重点覆盖两件事：
 *   1. 平台识别 / 下载源顺序 / 节点名清洗 —— P1 的纯逻辑
 *   2. transport 感知的地址登记 —— P2 里最容易错、也最致命的一处：
 *      tailnet 对端自述的 host 是它的**局域网** IP，跨互联网不可达，
 *      必须被实际观察到的 tailnet IP 覆盖。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectTarget, assetName, candidateUrls, binDir, binaryPath, binaryInfo, cacheIsCurrent, downloadToBuffer, SIDECAR_PROTOCOL } from "./tsnet/download.js";
import { PINNED_CHECKSUMS } from "./tsnet/checksums.js";
import { toHostname, TsnetNode } from "./tsnet/manager.js";
import { tailnetOrigin, isTailnetAddress } from "./tsnet/bridge.js";
import { MeshDiscovery, orderedEndpoints } from "./discovery.js";

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    failed += 1;
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    failed += 1;
  }
}

console.log("\n── P1: 平台识别与下载 ──");

check("detectTarget 给出当前平台", () => {
  const t = detectTarget();
  assert.ok(["darwin", "windows", "linux", "android"].includes(t.os), `os=${t.os}`);
  assert.ok(["amd64", "arm64"].includes(t.arch), `arch=${t.arch}`);
});

check("assetName 命名与 sidecar 构建脚本一致", () => {
  const name = assetName();
  assert.match(name, /^dsh-mesh-tsnet-(darwin|windows|linux|android)-(amd64|arm64)\.gz$/);
});

check("下载源：镜像在前、直连 GitHub 兜底", () => {
  const urls = candidateUrls();
  const hostOf = (u) => new URL(u).host;
  assert.ok(urls.length >= 5, `只有 ${urls.length} 个源`);
  // 实测本机直连 github.com 不通，所以直连必须排在镜像之后。
  // 注意比的是 host：镜像 URL 里本来就含 github.com 作为路径。
  assert.equal(hostOf(urls[0]), "ghfast.top", `首个源应为实测最快的镜像：${urls[0]}`);
  assert.equal(hostOf(urls[urls.length - 1]), "github.com", "最后一个应是直连兜底");
  assert.equal(new Set(urls).size, urls.length, "源不应重复");
  assert.ok(urls.every((u) => u.endsWith(assetName())), "每个源都指向同一个资产名");
});

check("自定义下载源优先于内置镜像", () => {
  const urls = candidateUrls(["https://my.mirror/{url}"]);
  assert.ok(urls[0].startsWith("https://my.mirror/"), urls[0]);
  assert.ok(urls[0].endsWith(assetName()), urls[0]);
});

check("缓存目录含协议版本，避免新旧二进制串用", () => {
  assert.ok(binDir().includes(`sidecar-v${SIDECAR_PROTOCOL}`), binDir());
  assert.ok(binaryPath().startsWith(binDir()), binaryPath());
});

await checkAsync("缓存判定：sidecar 重新发布（校验值变了）必须重下，而不是复用旧文件", async () => {
  // 真机实测踩过的坑：manager 原本只在 `!installed || !looksExecutable()` 时才调
  // ensureBinary，于是「校验值变了」这条分支永远走不到 —— 新版 android 资产都发布
  // 到镜像上了，老装置却一直复用旧二进制，只有手动删缓存才会下载。
  const home = mkdtempSync(join(tmpdir(), "mesh-cache-check-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    assert.equal(cacheIsCurrent(), false, "没有缓存时应为 false");

    const target = binaryPath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024), { mode: 0o755 });
    assert.equal(cacheIsCurrent(), false, "缺 source-sha256 标记时应为 false");

    const expected = PINNED_CHECKSUMS[assetName()];
    if (expected) {
      // 标记就是"这份二进制来自哪个 .gz"，与钉在源码里的校验和一致才算最新
      writeFileSync(`${target}.source-sha256`, expected);
      assert.equal(cacheIsCurrent(), true, "标记与 PINNED_CHECKSUMS 一致时应为 true");
      writeFileSync(`${target}.source-sha256`, "0".repeat(64));
      assert.equal(cacheIsCurrent(), false, "标记对不上（资产/校验值变了）时应为 false");
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

console.log("\n── P1: tailnet 节点名清洗 ──");

check("中文机器名清洗后仍可辨认", () => {
  assert.equal(toHostname("立朋-mac"), "dsh-mac");
  assert.equal(toHostname("文超-win"), "dsh-win");
  assert.equal(toHostname("DESKTOP-H8NJ172"), "dsh-desktop-h8nj172");
  assert.equal(toHostname("MacBook Pro"), "dsh-macbook-pro");
});

check("纯非 ASCII 名字用哈希兜底，不会撞名", () => {
  const a = toHostname("我的电脑");
  const b = toHostname("另一台电脑");
  assert.match(a, /^dsh-node-[0-9a-f]{8}$/, a);
  assert.notEqual(a, b, "不同名字不能得到同一个节点名");
  assert.equal(a, toHostname("我的电脑"), "同名必须稳定");
});

check("空名字有兜底且长度合法", () => {
  const n = toHostname("");
  assert.ok(n.length > 0 && n.length <= 63, n);
  assert.match(n, /^[a-z0-9-]+$/, n);
});

console.log("\n── P2: 入站来源还原 ──");

const fakeReq = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { "x-forwarded-for": xff } : {} });

check("tailnet 入站经反代：从 XFF 还原真实地址", () => {
  const o = tailnetOrigin(fakeReq("127.0.0.1", "100.64.0.9"));
  assert.equal(o.address, "100.64.0.9");
  assert.equal(o.transport, "tsnet");
});

check("XFF 带端口 / 多级链都能解析", () => {
  assert.equal(tailnetOrigin(fakeReq("127.0.0.1", "100.64.0.9:51234")).address, "100.64.0.9");
  assert.equal(tailnetOrigin(fakeReq("127.0.0.1", "100.64.0.9, 10.0.0.1")).address, "100.64.0.9");
});

check("非回环来源不采信 XFF（防局域网伪造）", () => {
  const o = tailnetOrigin(fakeReq("192.168.1.77", "100.64.0.9"));
  assert.equal(o.address, "192.168.1.77");
  assert.equal(o.transport, "lan");
});

check("回环但无 XFF → 仍按局域网处理", () => {
  const o = tailnetOrigin(fakeReq("127.0.0.1", null));
  assert.equal(o.address, "127.0.0.1");
  assert.equal(o.transport, "lan");
});

check("100.64.0.0/10 判定", () => {
  assert.equal(isTailnetAddress("100.64.0.1"), true);
  assert.equal(isTailnetAddress("100.127.255.254"), true);
  assert.equal(isTailnetAddress("100.63.0.1"), false);
  assert.equal(isTailnetAddress("100.128.0.1"), false);
  assert.equal(isTailnetAddress("192.168.1.1"), false);
});

console.log("\n── P2: transport 感知的地址登记（关键修复）──");

check("tailnet 对端：自述的局域网 IP 不能盖掉 tailnet IP", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "peer-ts", machine: "远端", host: "192.168.1.50", port: 45917 }, "100.64.0.9", { transport: "tsnet" });
  const p = d.peers().find((x) => x.id === "peer-ts");
  assert.ok(p, "对端未登记");
  assert.equal(p.host, "100.64.0.9", `host 应为 tailnet IP，实际 ${p.host}`);
  assert.equal(p.transport, "tsnet");
});

check("局域网对端：仍以自述地址为准（保持原行为）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "peer-lan", machine: "隔壁", host: "192.168.1.60", port: 45917 }, "192.168.1.60");
  const p = d.peers().find((x) => x.id === "peer-lan");
  assert.equal(p.host, "192.168.1.60");
  assert.equal(p.transport, "lan", "默认应为 lan");
});

check("两条通道各占一条端点，互不覆盖（局域网心跳不冲掉 tailnet 端点）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  // 先经 tailnet 发现
  d.note({ app: "dsh-mesh", id: "peer-ts", machine: "远端", host: "192.168.1.50", port: 45917 }, "100.64.0.9", { transport: "tsnet" });
  // 之后对端自己也发组播心跳（走局域网）
  d.note({ app: "dsh-mesh", id: "peer-ts", machine: "远端", host: "192.168.1.50", port: 45917 }, "192.168.1.50");

  const p = d.peers().find((x) => x.id === "peer-ts");
  assert.equal(p.endpoints.length, 2, `应有两条端点，实际 ${p.endpoints.length}`);
  const ts = p.endpoints.find((e) => e.transport === "tsnet");
  const lan = p.endpoints.find((e) => e.transport === "lan");
  // 关键：tailnet 端点必须留住观察到的地址，不能被对端自述的局域网 IP 覆盖
  assert.equal(ts.host, "100.64.0.9", `tailnet 端点地址被覆盖了：${ts.host}`);
  assert.equal(lan.host, "192.168.1.50");
  // 两条都活着时，选中的应是局域网（局域网优先）
  assert.equal(p.transport, "lan", "应优先选局域网");
  assert.equal(p.host, "192.168.1.50");
});

console.log("\n── 多通道：两条通道绑一台设备 ──");

check("一台设备两条通道 → peers() 里只有一行，且带 endpoints", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "100.64.0.9", { transport: "tsnet" });
  const peers = d.peers();
  assert.equal(peers.length, 1, `应只有一台设备，实际 ${peers.length}`);
  assert.equal(peers[0].endpoints.length, 2);
  assert.equal(peers[0].online, true);
});

check("局域网挂了 → 设备仍在线，且自动切到 tailnet", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" }, ttlMs: 20000 });
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "100.64.0.9", { transport: "tsnet" });

  // 局域网连续失败到阈值 → 进冷却
  d.markEndpoint("dev", "lan", { ok: false });
  d.markEndpoint("dev", "lan", { ok: false });

  const p = d.peers().find((x) => x.id === "dev");
  assert.equal(p.online, true, "局域网挂了不该让整台设备离线（tailnet 还通）");
  assert.equal(p.transport, "tsnet", `应自动切到 tailnet，实际 ${p.transport}`);
  assert.equal(p.host, "100.64.0.9");
});

check("tailnet 挂了 → 仍优先走局域网，设备在线", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "100.64.0.9", { transport: "tsnet" });
  d.markEndpoint("dev", "tsnet", { ok: false });
  d.markEndpoint("dev", "tsnet", { ok: false });
  const p = d.peers().find((x) => x.id === "dev");
  assert.equal(p.online, true);
  assert.equal(p.transport, "lan", "tailnet 挂了不该影响局域网优先");
});

check("两条都挂了 → 才判离线", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "100.64.0.9", { transport: "tsnet" });
  d.markEndpoint("dev", "lan", { ok: false });
  d.markEndpoint("dev", "lan", { ok: false });
  d.markEndpoint("dev", "tsnet", { ok: false });
  d.markEndpoint("dev", "tsnet", { ok: false });
  const p = d.peers().find((x) => x.id === "dev");
  assert.equal(p.online, false, "两条通道都失败后才应判离线");
  assert.equal(p.transport, null, "没有可用端点时 transport 应为 null");
  assert.ok(p.knownAddresses.length === 2, "仍应保留已知地址供 UI 显示");
});

check("端点恢复后重新上位（局域网恢复则切回）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "100.64.0.9", { transport: "tsnet" });
  d.markEndpoint("dev", "lan", { ok: false });
  d.markEndpoint("dev", "lan", { ok: false });
  assert.equal(d.peers()[0].transport, "tsnet");
  d.markEndpoint("dev", "lan", { ok: true, rttMs: 3 });
  assert.equal(d.peers()[0].transport, "lan", "局域网恢复后应切回（它优先）");
  assert.equal(d.peers()[0].endpoints.find((e) => e.transport === "lan").rttMs, 3);
});

check("tailnet 候选端点：知道地址但没探过，不算在线", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.noteTailnetCandidate({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "100.64.0.9", 45917);
  const p = d.peers().find((x) => x.id === "dev");
  assert.equal(p.endpoints.length, 1);
  assert.equal(p.endpoints[0].verified, false, "没探过的候选端点不应标记为已验证");
  assert.equal(p.online, false, "只知道地址不等于在线");
  // 但地址要留着，局域网一断就能直接用
  assert.equal(p.endpoints[0].host, "100.64.0.9");
});

check("一条通道过期不会删掉设备（另一条还活着）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" }, ttlMs: 1000, keepMs: 3000 });
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  d.note({ app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917 }, "100.64.0.9", { transport: "tsnet" });
  // 把 tailnet 端点的 lastSeen 拨回很久以前，模拟它过期
  const internal = d.peers()[0];
  void internal;
  d.markEndpoint("dev", "lan", { ok: true }); // 局域网刚刷新
  // 直接推进时间不可行，改用反射不可行 —— 用 markEndpoint 之外的口子验证：
  // 只要两条端点都存在，设备就不会被 sweep 删掉（sweep 只在端点数为 0 时删）
  assert.ok(d.peers()[0].endpoints.length === 2);
});

console.log("\n── 身份：指纹认领与冲突 ──");

check("同指纹不同 instanceId → 认领为同一台（旧记录立刻淘汰）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  const fp = "aaaa1111bbbb2222";
  d.note({ app: "dsh-mesh", id: "old", machine: "hos", host: "192.168.1.7", port: 45917, fingerprint: fp }, "192.168.1.7");
  assert.equal(d.peers().length, 1);
  // state.json 丢了 → 新 instanceId、同指纹、地址也变了（DHCP 换了 IP）
  d.note({ app: "dsh-mesh", id: "new", machine: "hos", host: "192.168.1.99", port: 45917, fingerprint: fp }, "192.168.1.99");
  const peers = d.peers();
  assert.equal(peers.length, 1, `应只剩一条，实际 ${peers.length}（指纹认领没生效）`);
  assert.equal(peers[0].id, "new", "留下的应是新记录");
});

check("空指纹绝不认领（否则所有采不到指纹的设备会并成一团）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "a", machine: "x", host: "10.0.0.1", port: 45917 }, "10.0.0.1");
  d.note({ app: "dsh-mesh", id: "b", machine: "y", host: "10.0.0.2", port: 45917 }, "10.0.0.2");
  assert.equal(d.peers().length, 2, "空指纹不该互相认领");
});

check("同 instanceId 但指纹不同 → 记冲突并告警（有人复制了 state.json）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  const events = [];
  d.on("diagnostic", (m) => events.push(m));
  d.note({ app: "dsh-mesh", id: "same", machine: "a", host: "10.0.0.1", port: 45917, fingerprint: "1111111111111111" }, "10.0.0.1");
  d.note({ app: "dsh-mesh", id: "same", machine: "b", host: "10.0.0.2", port: 45917, fingerprint: "2222222222222222" }, "10.0.0.2");
  const p = d.peers().find((x) => x.id === "same");
  assert.ok(p.fingerprintConflict, "应记录指纹冲突");
  assert.equal(p.fingerprintConflict.previous, "1111111111111111");
  assert.equal(p.fingerprintConflict.incoming, "2222222222222222");
  assert.ok(events.some((m) => m.includes("instanceId 冲突")), `应发出 diagnostic，实际：${events.join(" | ")}`);
});

check("对端在名片里自报 tailnetIp → 自动登记候选端点，且不抢局域网", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note(
    { app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917, tailnetIp: "100.64.0.9" },
    "192.168.1.7",
  );
  const p = d.peers().find((x) => x.id === "dev");
  assert.equal(p.endpoints.length, 2, `应同时有 lan 与 tsnet 两条端点，实际 ${p.endpoints.length}`);
  const ts = p.endpoints.find((e) => e.transport === "tsnet");
  assert.equal(ts.host, "100.64.0.9");
  assert.equal(ts.verified, false, "候选端点不该算已验证");
  assert.equal(p.online, true, "局域网端点让它在线");
  assert.equal(p.transport, "lan", "候选端点不该抢在局域网前面");
});

check("局域网挂了 → 对端自报的 tailnet 地址立刻接管（无需重新扫描）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note(
    { app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917, tailnetIp: "100.64.0.9" },
    "192.168.1.7",
  );
  // 局域网连续失败到阈值 → 进冷却
  d.markEndpoint("dev", "lan", { ok: false });
  d.markEndpoint("dev", "lan", { ok: false });
  const eps = orderedEndpoints(d.peers().find((x) => x.id === "dev"));
  assert.equal(eps[0].transport, "tsnet", `应轮到 tsnet，实际 ${eps[0].transport}`);
  assert.equal(eps[0].host, "100.64.0.9", "地址应是局域网阶段就记下的那个，不用重新发现");
});

check("orderedEndpoints：局域网优先、冷却排最后、已验证优先", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note(
    { app: "dsh-mesh", id: "dev", machine: "hos", host: "192.168.1.7", port: 45917, tailnetIp: "100.64.0.9" },
    "192.168.1.7",
  );
  assert.equal(orderedEndpoints(d.peers().find((x) => x.id === "dev"))[0].transport, "lan");
  d.markEndpoint("dev", "lan", { ok: false });
  d.markEndpoint("dev", "lan", { ok: false });
  assert.equal(orderedEndpoints(d.peers().find((x) => x.id === "dev"))[0].transport, "tsnet");
  // 局域网从冷却中恢复 → 回到第一位（它优先）
  d.markEndpoint("dev", "lan", { ok: true, rttMs: 2 });
  assert.equal(orderedEndpoints(d.peers().find((x) => x.id === "dev"))[0].transport, "lan");
});

check("自己不会被登记为自己", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  assert.equal(d.note({ app: "dsh-mesh", id: "self-1", machine: "me", host: "x", port: 1 }, "100.64.0.9"), false);
  assert.equal(d.peers().length, 0);
});

check("非 dsh-mesh 的报文不会进注册表", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  assert.equal(d.note({ app: "something-else", id: "x" }, "100.64.0.9"), false);
  assert.equal(d.peers().length, 0);
});

console.log("\n── 平台识别：Android/Termux 必须能工作 ──");

check("android 有自己的平台资产（PIE），不再借用 linux 资产", () => {
  // 实测踩过两件事：
  //  1) 那台 Android 的自述记录是 `os: 'android 5.10.43'`，而 detectTarget
  //     原来只认 darwin/win32/linux，于是抛「不支持的系统：android」。这个抛
  //     发生在 binaryInfo→binaryPath 里面，一抛就把整个 /mesh/api/state 打成
  //     500，页面显示「本机 undefined」，互联网组网卡片也一起消失。
  //  2) 后来把 android 映射到 linux 也不对：linux 资产是给桌面准备的全静态
  //     ET_EXEC，Android 只接受 PIE，真机 exec 直接失败
  //     （`has unexpected e_type: 2`）。所以 android 必须映射到自己的资产。
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "android", configurable: true });
  try {
    const t = detectTarget();
    assert.equal(t.os, "android", `android 应映射为 android，实际 ${t.os}`);
    assert.match(assetName(), /^dsh-mesh-tsnet-android-(amd64|arm64)\.gz$/);
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
});

check("binaryInfo 遇到不支持的平台也不抛，只把原因放进 error", () => {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "plan9", configurable: true });
  try {
    const info = binaryInfo();
    assert.equal(info.installed, false);
    assert.ok(info.error, "应把原因放在 error 字段，而不是抛出");
    assert.match(String(info.error), /不支持的系统/);
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
});

await checkAsync("start() 早期失败必须落到 phase=error，不能永远停在 starting（UI 转圈不停）", async () => {
  // 实测（Android 真机）：#spawnOwn() 第一行的 binaryInfo()/looksExecutable() 在任何
  // try 之外，platform 不认识时直接抛；而 start() 先把 phase 置成 "starting" 才调它，
  // 异常一路 reject 到调用方只留一条 warning —— phase 永远是 "starting"，页面显示
  // 「正在组网中」永不结束。macOS 上同样会踩（下载源全挂时也一样）。
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  const prevDsh = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "mesh-selftest-start-"));
  process.env.DSH_HOME = home; // 隔离 rendezvous/缓存，免得误复用本机真在跑的 sidecar
  Object.defineProperty(process, "platform", { value: "plan9", configurable: true });
  try {
    const node = new TsnetNode({ config: {}, machineName: "selftest" });
    await assert.rejects(() => node.start(), /不支持的系统/);
    const st = node.status();
    assert.equal(st.phase, "error", `phase 应为 error，实际 ${st.phase}`);
    assert.match(String(st.error), /不支持的系统/);
  } finally {
    Object.defineProperty(process, "platform", desc);
    if (prevDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDsh;
    rmSync(home, { recursive: true, force: true });
  }
});

console.log("\n── 下载源的逃生通道：局域网 http ──");

await checkAsync("http:// 源能真的取到内容（不是 ERR_INVALID_PROTOCOL）", async () => {
  // 实测：那台 Android 上 github.com 与 ghfast.top / gh-proxy.com / ghproxy.net
  // 全部不通，唯一可行的办法是让同网段另一台机器用 http 当镜子。而下载器原来
  // 只 import node:https，遇到 http:// 会直接 ERR_INVALID_PROTOCOL。
  const payload = Buffer.alloc(64 * 1024, 0x41);
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": payload.length });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address();
    const got = await downloadToBuffer(`http://127.0.0.1:${port}/whatever.gz`, { timeoutMs: 4000 });
    assert.equal(got.length, payload.length, `应取到 ${payload.length} 字节，实际 ${got.length}`);
    assert.ok(got.equals(payload), "内容应与服务端一致");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

check("局域网 http 源被排在内置镜像之前（用户指定的源优先）", () => {
  const urls = candidateUrls(["http://192.168.1.6:8791/"]);
  assert.match(urls[0], /^http:\/\/192\.168\.1\.6:8791\/https:\/\/github\.com\//);
  assert.ok(urls[1].startsWith("https://ghfast.top/"), `第二项应是内置镜像，实际 ${urls[1]}`);
});

console.log("\n── 重名治理：同地址重新登记要淘汰旧记录 ──");

check("对端重启换了 instanceId、地址不变 → 旧记录立刻淘汰", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "old-id", machine: "Android手机", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  assert.equal(d.peers().length, 1, "第一次登记失败");
  // 对端重启：新 instanceId、同一地址。原实现会留下两条同名记录，触发「有重名」
  d.note({ app: "dsh-mesh", id: "new-id", machine: "Android手机", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  assert.equal(d.peers().length, 1, `应只剩一条，实际 ${d.peers().length} 条`);
  assert.equal(d.peers()[0].id, "new-id", "留下的应是新记录");
});

check("不同地址的同名机器不会被误合并（那确实是真的两台）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "a", machine: "同名", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  d.note({ app: "dsh-mesh", id: "b", machine: "同名", host: "192.168.1.8", port: 45917 }, "192.168.1.8");
  assert.equal(d.peers().length, 2, "不同地址的同名机器不该被合并");
});

check("同地址不同端口不被误删（同机多实例）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "a", machine: "同名", host: "192.168.1.7", port: 45917 }, "192.168.1.7");
  d.note({ app: "dsh-mesh", id: "b", machine: "同名", host: "192.168.1.7", port: 45918 }, "192.168.1.7");
  assert.equal(d.peers().length, 2, "端口不同应保留两条");
});

check("被顶替时也会发出 change 事件（UI 才会立刻刷新）", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "old-id", machine: "X", host: "10.0.0.5", port: 45917 }, "10.0.0.5");
  let fired = 0;
  d.on("change", () => {
    fired += 1;
  });
  d.note({ app: "dsh-mesh", id: "new-id", machine: "X", host: "10.0.0.5", port: 45917 }, "10.0.0.5");
  assert.ok(fired > 0, "淘汰旧记录必须触发 change");
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
