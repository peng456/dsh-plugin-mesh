/**
 * 「陌生设备首次派活要确认」的自测。
 *
 * 这道闸已经从配置项降级成「仅调试用」（DSH_MESH_REQUIRE_APPROVAL=1），
 * 判错的后果是静默的：界面上写着"默认不问"，实际上陌生机器会被挂起；或者
 * 反过来，明明开了闸却照样放行。所以用断言盯死这几件事：
 *   · enabled 不为 true = 不拦（默认关，装上就能派活）
 *   · 只有 enabled: true 才拦
 *   · 允许过一台，就只放行这一台（按机器名或地址命中）
 *   · 配对码开启时不重复问（它是更强的信任动作）
 *   · 撤销之后立刻重新拦
 *   · 坏数据（字符串、null、缺字段）不能把闸门炸开
 *
 *   node lib/_selftest-approval.mjs
 */
import { strict as assert } from "node:assert";
import {
  MAX_APPROVED_PEERS,
  approvePeer,
  isApproved,
  isReplyToOutbound,
  needsApproval,
  normalizeApproved,
  peerOfTask,
  revokePeer,
} from "./approval.js";

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

const taskFrom = (machine, address = "") => ({
  id: "t-1",
  from: `${machine}/peng`,
  fromMachine: machine,
  task: "报一下系统负载",
  sourceAddress: address,
});

console.log("\n── 默认放行：只有调试开关打开才拦 ──");

test("不传 enabled → 不拦（默认关，装上就能直接派活）", () => {
  const peer = peerOfTask(taskFrom("陌生机"));
  assert.equal(needsApproval({ approved: [], peer }), false);
});

test("enabled: false → 不拦", () => {
  const peer = peerOfTask(taskFrom("陌生机"));
  assert.equal(needsApproval({ enabled: false, approved: [], peer }), false);
});

test("enabled: true 才拦", () => {
  const peer = peerOfTask(taskFrom("陌生机"));
  assert.equal(needsApproval({ enabled: true, approved: [], peer }), true);
});

test("配对码已开启 → 不再重复问（配对码是更强的信任动作）", () => {
  const peer = peerOfTask(taskFrom("陌生机"));
  assert.equal(needsApproval({ enabled: true, approved: [], peer, pairingRequired: true }), false);
});

console.log("\n── 允许过的机器要记住，且只记这一台 ──");

test("开了闸之后：允许 A，A 免问、B 仍然要问", () => {
  const a = peerOfTask(taskFrom("A机"));
  const b = peerOfTask(taskFrom("B机"));
  const approved = approvePeer([], a, "2026-01-01T00:00:00.000Z");
  assert.equal(needsApproval({ enabled: true, approved, peer: a }), false);
  assert.equal(needsApproval({ enabled: true, approved, peer: b }), true);
});

test("机器名大小写不敏感（Windows 上尤其重要）", () => {
  const approved = approvePeer([], peerOfTask(taskFrom("DESKTOP-ABC")));
  assert.equal(isApproved(approved, peerOfTask(taskFrom("desktop-abc"))), true);
});

test("只给了地址的对端也能被记住（旧版本对端）", () => {
  // "unknown" 是老对端的占位符，不能当成一台叫 unknown 的机器
  const peer = peerOfTask({ from: "unknown", sourceAddress: "192.168.1.9" });
  assert.equal(peer.machine, "");
  const approved = approvePeer([], peer);
  assert.equal(isApproved(approved, { machine: "", address: "192.168.1.9" }), true);
  // 另一个地址不能被顺带放行
  assert.equal(isApproved(approved, { machine: "", address: "192.168.1.10" }), false);
});

test("有机器名就只认机器名 —— 不能因为地址相同就放行另一台（tailnet 反代下都是 127.0.0.1）", () => {
  const a = peerOfTask({ fromMachine: "A机", sourceAddress: "127.0.0.1" });
  const approved = approvePeer([], a);
  const b = peerOfTask({ fromMachine: "B机", sourceAddress: "127.0.0.1" });
  assert.equal(isApproved(approved, b), false);
});

test("重复允许同一台机器 → 幂等，不会长出两条记录", () => {
  const a = peerOfTask(taskFrom("A机"));
  const once = approvePeer([], a);
  const twice = approvePeer(once, a);
  assert.equal(twice.length, 1);
});

test("撤销之后立刻重新拦", () => {
  const a = peerOfTask(taskFrom("A机"));
  const approved = approvePeer([], a);
  const revoked = revokePeer(approved, "a机");
  assert.equal(needsApproval({ enabled: true, approved: revoked, peer: a }), true);
});

console.log("\n── 坏数据不能把闸门炸开 ──");

test("approvedPeers 是 null / 字符串 / 混入坏条目 → 归一化成空或只留好条目", () => {
  assert.deepEqual(normalizeApproved(null), []);
  assert.deepEqual(normalizeApproved("oops"), []);
  assert.deepEqual(normalizeApproved([null, 1, "x", {}, { machine: "ok" }]).length, 1);
});

test("开了闸时，认不出是谁的对端 → 必须问（不能因为认不出来就放行）", () => {
  const peer = peerOfTask({ from: "", sourceAddress: "" });
  assert.equal(needsApproval({ enabled: true, approved: [], peer }), true);
});

test("批准记录有上限，不会无限增长", () => {
  let list = [];
  for (let i = 0; i < MAX_APPROVED_PEERS + 10; i += 1) list = approvePeer(list, { machine: `m${i}`, address: "" });
  assert.equal(list.length, MAX_APPROVED_PEERS);
  // 最新的那台必须在，最旧的被挤掉
  assert.equal(isApproved(list, { machine: `m${MAX_APPROVED_PEERS + 9}`, address: "" }), true);
  assert.equal(isApproved(list, { machine: "m0", address: "" }), false);
});

console.log("\n── peerOfTask：机器名优先，地址兜底 ──");

test("优先用 fromMachine，不用 from 里拼出来的前缀", () => {
  const p = peerOfTask({ from: "旧名字/peng", fromMachine: "新名字", sourceAddress: "10.0.0.5" });
  assert.equal(p.machine, "新名字");
});

test("fromMachine 缺失时回退 from 的机器名部分", () => {
  assert.equal(peerOfTask({ from: "hos/peng" }).machine, "hos");
});

console.log("\n── 回执必须绕过闸门（否则结果永远回不来）──");

test("同一台机器 + 同一 thread 的回执 → 是回执", () => {
  const out = [{ toMachine: "hos", thread: "build-1" }];
  assert.equal(isReplyToOutbound({ fromMachine: "hos", thread: "build-1" }, out), true);
});

test("换一台机器或换一个 thread → 不是回执（不能借旧 thread 名绕过）", () => {
  const out = [{ toMachine: "hos", thread: "build-1" }];
  assert.equal(isReplyToOutbound({ fromMachine: "evilbox", thread: "build-1" }, out), false);
  assert.equal(isReplyToOutbound({ fromMachine: "hos", thread: "build-2" }, out), false);
});

test("没有 thread / 没有机器名 / outbound 不是数组 → 都不是回执", () => {
  assert.equal(isReplyToOutbound({ fromMachine: "hos" }, [{ toMachine: "hos", thread: "" }]), false);
  assert.equal(isReplyToOutbound({ thread: "x" }, [{ toMachine: "hos", thread: "x" }]), false);
  assert.equal(isReplyToOutbound({ fromMachine: "hos", thread: "x" }, null), false);
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
