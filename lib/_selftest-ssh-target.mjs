/**
 * 「这次 SSH 连哪儿」的决策自测。
 *
 * 这段守着一个具体事故：宿主没有 100.x 路由，用 tailnet 地址去连 22 端口
 * 必然卡到 `timed out waiting for handshake`。所以：
 *   · 有实测可连的候选 → 直连（局域网优先，不占 sidecar 端口）
 *   · 一个都连不上但对端有 tailnet 端点 → 走本机回环 + tailnet 字节流
 *   · 两条都不成立 → 报清楚原因，不编地址
 *
 *   node lib/_selftest-ssh-target.mjs
 */
import { strict as assert } from "node:assert";
import { planSshTarget, sshDirectCandidates } from "./ssh-target.js";

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

console.log("\n── 直连优先 ──");

test("探测证明能连 → 直连，端口保留", () => {
  const plan = planSshTarget({ reachableHost: "192.168.1.8", port: 22, tsnetHost: "100.81.214.118" });
  assert.equal(plan.mode, "direct");
  assert.equal(plan.host, "192.168.1.8");
  assert.equal(plan.port, 22);
});

test("自定义端口不被吃掉", () => {
  const plan = planSshTarget({ reachableHost: "192.168.1.8", port: 8022, tsnetHost: "100.81.214.118" });
  assert.equal(plan.port, 8022);
});

console.log("\n── 直连不通 → 走 tailnet 字节流 ──");

test("有 tailnet 端点 → stream 到 <tailnet>:<port>", () => {
  const plan = planSshTarget({ port: 22, tsnetHost: "100.81.214.118" });
  assert.equal(plan.mode, "stream");
  assert.equal(plan.address, "100.81.214.118:22");
});

test("stream 模式也带自定义端口", () => {
  const plan = planSshTarget({ port: 8022, tsnetHost: "100.81.214.118" });
  assert.equal(plan.address, "100.81.214.118:8022");
});

console.log("\n── 两条都不成立：报原因，不编地址 ──");

test("没有 tailnet 端点 → none，且带上候选说明", () => {
  const plan = planSshTarget({
    endpoints: [{ host: "192.168.1.8", transport: "lan" }],
    port: 22,
    requestedHost: "192.168.1.8",
  });
  assert.equal(plan.mode, "none");
  assert.match(plan.note, /192\.168\.1\.8|局域网可达/);
  assert.doesNotMatch(plan.note, /^直连|^经本机/);
});

test("端口非法时退回 22（不产生 :0）", () => {
  const plan = planSshTarget({ port: 0, tsnetHost: "100.64.0.9" });
  assert.equal(plan.address, "100.64.0.9:22");
});

console.log("\n── 候选顺序：局域网优先，tailnet 不进直连候选 ──");

test("私有地址排在前面，重复项去掉", () => {
  const list = sshDirectCandidates(
    [
      { host: "100.81.214.118", transport: "tsnet" },
      { host: "192.168.1.8", transport: "lan" },
      { host: "192.168.1.8", transport: "ws" },
      { host: "120.244.161.183", transport: "lan" },
    ],
    "192.168.1.8",
  );
  assert.deepEqual(list, ["192.168.1.8", "120.244.161.183"]);
});

test("客户端给的私有地址即使不在端点表里也参与直连", () => {
  const list = sshDirectCandidates([{ host: "100.81.214.118", transport: "tsnet" }], "10.0.0.9");
  assert.deepEqual(list, ["10.0.0.9"]);
});

test("tailnet 地址绝不进直连候选（宿主没有路由）", () => {
  const list = sshDirectCandidates(
    [
      { host: "100.81.214.118", transport: "tsnet" },
      { host: "100.74.219.116", transport: "tsnet" },
    ],
    "",
  );
  assert.deepEqual(list, []);
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
