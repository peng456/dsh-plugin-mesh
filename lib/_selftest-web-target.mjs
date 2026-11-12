/**
 * 「观看端怎么到对端 GUI」的决策自测。
 *
 * 这段是**故障复现的护栏**：真实现场是手机在移动数据下把自己报成运营商
 * CGNAT 的 `10.73.218.12:3080`，观看端照单全收 → 反向代理永远 502
 * `socket hang up`。所以这里盯着四件事：
 *   · 自报地址真拨通时，行为与以前一字不差（局域网不能被加戏）
 *   · 拨不通但对端有 tailnet 通道 → 必须改成"本机回环端口 + tailnet 字节流"
 *   · 隧道前缀只认相对前缀；老版本对端给的绝对地址只取路径、不取主机
 *   · 两条都不可用时，报错要说清"试过什么、怎么失败"，不许说成对端已关闭
 *
 *   node lib/_selftest-web-target.mjs
 */
import { strict as assert } from "node:assert";
import { needsReachabilityProbe, planWebTarget, tunnelPrefixOf } from "./web-target.js";

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

console.log("\n── 直连：能拨通就一动不动 ──");

test("没探测（undefined）按可达处理，不加任何延迟", () => {
  const plan = planWebTarget({ reportedBase: "http://192.168.1.8:3080/", reachable: undefined });
  assert.equal(plan.mode, "direct");
  assert.equal(plan.remoteBase, "http://192.168.1.8:3080/");
});

test("探测通过 → 直连，地址原样保留", () => {
  const plan = planWebTarget({ reportedBase: "http://192.168.1.8:3080/", reachable: true });
  assert.equal(plan.mode, "direct");
  assert.equal(plan.remoteBase, "http://192.168.1.8:3080/");
});

console.log("\n── 现实故障：对端自报运营商地址 + GUI 绑 0.0.0.0（无隧道）──");

const carrier = "http://10.73.218.12:3080/";

test("拨不通但有 tailnet 地址 → 走本机回环 + tailnet 字节流", () => {
  const plan = planWebTarget({
    reportedBase: carrier,
    reportedPort: 3080,
    reachable: false,
    tunnel: null,
    tsnetHost: "100.81.214.118",
    meshPort: 45917,
    probeNote: "1500ms 内没有响应（This operation was aborted）",
  });
  assert.equal(plan.mode, "stream");
  assert.equal(plan.address, "100.81.214.118:3080");
  assert.equal(plan.prefix, "");
  assert.match(plan.note, /100\.81\.214\.118:3080/);
});

test("端口取对端报的 port，不硬编码 3080", () => {
  const plan = planWebTarget({
    reportedBase: "http://10.0.0.9:8080/",
    reportedPort: 8080,
    reachable: false,
    tsnetHost: "100.64.0.9",
    meshPort: 45917,
  });
  assert.equal(plan.address, "100.64.0.9:8080");
});

test("没有 tsnet 地址 → 不许假装能连，报错要带上失败原因", () => {
  const plan = planWebTarget({
    reportedBase: carrier,
    reportedPort: 3080,
    reachable: false,
    tsnetHost: "",
    probeNote: "1500ms 内没有响应（aborted）",
  });
  assert.equal(plan.mode, "none");
  assert.equal(plan.remoteBase, carrier);
  assert.match(plan.note, /1500ms 内没有响应/);
  assert.doesNotMatch(plan.note, /关闭|不存在|offline/);
});

console.log("\n── 隧道：对端 GUI 只听回环时走 mesh 口 ──");

test("有相对前缀 + 票据 → 目标是 mesh 口，不是 GUI 口", () => {
  const plan = planWebTarget({
    reportedBase: "http://127.0.0.1:3080/",
    reportedPort: 3080,
    reachable: false,
    tunnel: { prefix: "/mesh/peer-web", ticket: "abc.def", header: "x-dsh-peer-web" },
    tsnetHost: "100.100.1.2",
    meshPort: 45917,
  });
  assert.equal(plan.mode, "stream");
  assert.equal(plan.address, "100.100.1.2:45917");
  assert.equal(plan.prefix, "/mesh/peer-web");
  assert.equal(plan.ticket, "abc.def");
});

test("前缀缺尾斜杠/带尾斜杠都能收敛成同一种写法", () => {
  assert.equal(tunnelPrefixOf({ prefix: "mesh/peer-web/" }), "/mesh/peer-web");
  assert.equal(tunnelPrefixOf({ prefix: "/mesh/peer-web///" }), "/mesh/peer-web");
});

test("老版本对端的绝对地址只取路径，主机一律丢掉（那台主机同样可能不可达）", () => {
  assert.equal(tunnelPrefixOf({ url: "http://10.12.225.124:45917/mesh/peer-web/" }), "/mesh/peer-web");
  assert.equal(tunnelPrefixOf({ url: "http://10.12.225.124:45917/mesh/peer-web" }), "/mesh/peer-web");
});

test("前缀优先于 url（新版本两个都给时按前缀走）", () => {
  assert.equal(
    tunnelPrefixOf({ prefix: "/mesh/peer-web", url: "http://10.1.2.3:45917/mesh/other/" }),
    "/mesh/peer-web",
  );
});

test("给了前缀但没有票据 → 不冒充隧道，退回直连 GUI", () => {
  const plan = planWebTarget({
    reportedBase: "http://10.9.9.9:3080/",
    reportedPort: 3080,
    reachable: false,
    tunnel: { prefix: "/mesh/peer-web" },
    tsnetHost: "100.64.1.1",
    meshPort: 45917,
  });
  assert.equal(plan.mode, "stream");
  assert.equal(plan.address, "100.64.1.1:3080");
  assert.equal(plan.prefix, "");
});

test("有票据但没有 mesh 端口 → 同样不冒充隧道", () => {
  const plan = planWebTarget({
    reportedBase: "http://10.9.9.9:3080/",
    reportedPort: 3080,
    reachable: false,
    tunnel: { prefix: "/mesh/peer-web", ticket: "abc.def" },
    tsnetHost: "100.64.1.1",
    meshPort: 0,
  });
  assert.equal(plan.address, "100.64.1.1:3080");
});

console.log("\n── 回环自报：绝不能连到本机自己 ──");

test("对端报 127.0.0.1 + 给了隧道 → 必须走隧道，不能直连", () => {
  const plan = planWebTarget({
    reportedBase: "http://127.0.0.1:3080/",
    reportedPort: 3080,
    // 故意给 true：就算探测环节误判"可达"，回环自报也必须被否掉
    reachable: true,
    tunnel: { prefix: "/mesh/peer-web", ticket: "abc.def" },
    tsnetHost: "100.100.1.2",
    meshPort: 45917,
  });
  assert.equal(plan.mode, "stream");
  assert.equal(plan.address, "100.100.1.2:45917");
  assert.equal(plan.prefix, "/mesh/peer-web");
});

test("对端报 127.0.0.1 但没给隧道 → 如实说不可用，不要假装直连", () => {
  const plan = planWebTarget({
    reportedBase: "http://127.0.0.1:3080/",
    reportedPort: 3080,
    reachable: true,
    tunnel: null,
    tsnetHost: "100.100.1.2",
    meshPort: 45917,
    guiBoundEverywhere: false,
  });
  assert.equal(plan.mode, "none");
  assert.match(plan.note, /只听回环/);
  assert.doesNotMatch(plan.note, /关闭|offline/);
});

test("对端 GUI 只绑回环、又没隧道 → 不许拨它的 3080（那里没有监听）", () => {
  const plan = planWebTarget({
    reportedBase: "http://10.9.9.9:3080/",
    reportedPort: 3080,
    reachable: false,
    tunnel: null,
    tsnetHost: "100.64.1.1",
    meshPort: 45917,
    guiBoundEverywhere: false,
  });
  assert.equal(plan.mode, "none");
});

console.log("\n── 什么时候该探测（别给局域网加延迟）──");

test("同网段地址不探测", () => {
  assert.equal(needsReachabilityProbe("192.168.1.8", ["192.168.1.5"]), false);
});

test("回环不探测", () => {
  assert.equal(needsReachabilityProbe("127.0.0.1", ["192.168.1.5"]), false);
});

test("运营商 CGNAT 的 10.x 要探测（这正是骗人的那一类）", () => {
  assert.equal(needsReachabilityProbe("10.73.218.12", ["192.168.1.5"]), true);
});

test("主机名（非 IPv4 字面量）要探测", () => {
  assert.equal(needsReachabilityProbe("peer.example", ["192.168.1.5"]), true);
});

test("没有任何本机地址时，IPv4 也要探测", () => {
  assert.equal(needsReachabilityProbe("192.168.1.8", []), true);
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
