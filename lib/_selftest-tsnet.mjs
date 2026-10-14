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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTarget, assetName, candidateUrls, binDir, binaryPath, binaryInfo, downloadToBuffer, SIDECAR_PROTOCOL } from "./tsnet/download.js";
import { toHostname, TsnetNode } from "./tsnet/manager.js";
import { tailnetOrigin, isTailnetAddress } from "./tsnet/bridge.js";
import { MeshDiscovery } from "./discovery.js";

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
  assert.ok(["darwin", "windows", "linux"].includes(t.os), `os=${t.os}`);
  assert.ok(["amd64", "arm64"].includes(t.arch), `arch=${t.arch}`);
});

check("assetName 命名与 sidecar 构建脚本一致", () => {
  const name = assetName();
  assert.match(name, /^dsh-mesh-tsnet-(darwin|windows|linux)-(amd64|arm64)\.gz$/);
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

check("transport 由首次发现决定，后续心跳不丢标记", () => {
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "peer-ts", machine: "远端", host: "192.168.1.50", port: 45917 }, "100.64.0.9", { transport: "tsnet" });
  // 之后对端自己也发组播心跳（不带 transport），不能把标记冲掉
  d.note({ app: "dsh-mesh", id: "peer-ts", machine: "远端", host: "192.168.1.50", port: 45917 }, "100.64.0.9");
  const p = d.peers().find((x) => x.id === "peer-ts");
  assert.equal(p.transport, "tsnet", "transport 被心跳冲掉了");
  assert.equal(p.host, "100.64.0.9", "host 退回了不可达的局域网地址");
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

check("android 映射到 linux（Termux 下 os.platform() 返回 android，不是 linux）", () => {
  // 实测踩过：那台 Android 的自述记录是 `os: 'android 5.10.43'`，
  // 而 detectTarget 原来只认 darwin/win32/linux，于是抛「不支持的系统：android」。
  // 这个抛发生在 binaryInfo→binaryPath 里面，一抛就把整个 /mesh/api/state 打成
  // 500，页面显示「本机 undefined」，互联网组网卡片也一起消失。
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "android", configurable: true });
  try {
    const t = detectTarget();
    assert.equal(t.os, "linux", `android 应映射为 linux，实际 ${t.os}`);
    assert.match(assetName(), /^dsh-mesh-tsnet-linux-(amd64|arm64)\.gz$/);
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
