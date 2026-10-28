/**
 * 一键关闭（kill switch）判定的自测。
 *
 * 这段和配对码一样**安全相关**，而且判错的后果同样是静默的：界面显示
 * "已关闭"，端口却还开在 0.0.0.0 上。必须用断言盯着这几件事：
 *   · 缺省是"开着"（升级不会突然断开所有人）
 *   · 关"全部"必须两个范围都关（不能只关一半）
 *   · 只认严格布尔 true（防手工编辑/YAML 字符串坑）
 *   · 打开其中一个范围时，另一个范围保持原样（不能顺带把别人开了/关了）
 *
 *   node lib/_selftest-switch.mjs
 */
import { strict as assert } from "node:assert";
import {
  MESH_SWITCH_SCOPES,
  applyMeshSwitch,
  describeMeshSwitch,
  normalizeSwitchScope,
  resolveMeshSwitch,
} from "./switch.js";

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

console.log("\n── 缺省：都开着（升级不会突然断开）──");

test("空 state / 空入参 → 都开着", () => {
  for (const st of [{}, null, undefined, { shutdown: null }, { shutdown: {} }]) {
    const r = resolveMeshSwitch(st);
    assert.equal(r.lan, false);
    assert.equal(r.internet, false);
    assert.equal(r.all, false);
  }
});

test("只写了一个范围 → 另一个范围仍是开着", () => {
  const r = resolveMeshSwitch({ shutdown: { lan: true } });
  assert.equal(r.lan, true);
  assert.equal(r.internet, false);
  assert.equal(r.all, false);
});

console.log("\n── 只认严格布尔 true ──");

test('字符串 "true" / 数字 1 都不算关闭 —— 否则会让人以为关了、实际没关', () => {
  for (const v of ["true", 1, "1", "yes", {}, []]) {
    const r = resolveMeshSwitch({ shutdown: { lan: v, internet: v } });
    assert.equal(r.lan, false, `lan=${JSON.stringify(v)}`);
    assert.equal(r.internet, false, `internet=${JSON.stringify(v)}`);
  }
});

console.log("\n── 合并：关全部 = 两个都关，别只关一半 ──");

test("关 all → lan 与 internet 都为 true（已关闭）", () => {
  const next = applyMeshSwitch(resolveMeshSwitch({}), { scope: "all", off: true, by: "ui", at: "T" });
  assert.deepEqual(next, { lan: true, internet: true, at: "T", by: "ui" });
});

test("只关局域网 → 互联网不受影响", () => {
  const next = applyMeshSwitch(resolveMeshSwitch({}), { scope: "lan", off: true, at: "T" });
  assert.equal(next.lan, true);
  assert.equal(next.internet, false);
});

test("只关互联网 → 局域网不受影响", () => {
  const next = applyMeshSwitch(resolveMeshSwitch({}), { scope: "internet", off: true, at: "T" });
  assert.equal(next.lan, false);
  assert.equal(next.internet, true);
});

test("从「全部关闭」只打开局域网 → 互联网保持关闭（不能顺带全开）", () => {
  const closed = resolveMeshSwitch({ shutdown: { lan: true, internet: true } });
  const next = applyMeshSwitch(closed, { scope: "lan", off: false, at: "T" });
  assert.equal(next.lan, false);
  assert.equal(next.internet, true);
  assert.equal(resolveMeshSwitch({ shutdown: next }).all, false);
});

test("从「全部关闭」打开全部 → 都开", () => {
  const closed = resolveMeshSwitch({ shutdown: { lan: true, internet: true } });
  const next = applyMeshSwitch(closed, { scope: "all", off: false, at: "T" });
  assert.equal(next.lan, false);
  assert.equal(next.internet, false);
});

test("applyMeshSwitch 不修改入参", () => {
  const before = { lan: false, internet: true, at: "", by: "" };
  const frozen = JSON.stringify(before);
  applyMeshSwitch(before, { scope: "all", off: true });
  assert.equal(JSON.stringify(before), frozen);
});

test("off 漏传时按「关闭」处理（一键关闭是主动作）", () => {
  const next = applyMeshSwitch(resolveMeshSwitch({}), { scope: "lan" });
  assert.equal(next.lan, true);
});

console.log("\n── 范围归一化：中英文都收，不认识的必须报错而不是乱猜 ──");

test("英文 id 与界面中文词都能识别", () => {
  assert.equal(normalizeSwitchScope("all"), "all");
  assert.equal(normalizeSwitchScope("LAN"), "lan");
  assert.equal(normalizeSwitchScope(" 互联网 "), "internet");
  assert.equal(normalizeSwitchScope("局域网 mesh"), "lan");
  assert.equal(normalizeSwitchScope("全部"), "all");
});

test("不认识的 scope 直接抛错（不静默关掉全部，也不静默什么都不做）", () => {
  for (const bad of ["", "everything", "wifi", null, undefined, 0]) {
    assert.throws(() => applyMeshSwitch(resolveMeshSwitch({}), { scope: bad }), /未知的开关范围/);
  }
});

test("MESH_SWITCH_SCOPES 与界面顺序一致", () => {
  assert.deepEqual(MESH_SWITCH_SCOPES, ["all", "lan", "internet"]);
});

console.log("\n── 摘要文案：读的人要能判断现在能不能派任务 ──");

test("全部关闭时明确说「全部关闭」", () => {
  assert.match(describeMeshSwitch({ lan: true, internet: true }), /全部关闭/);
});
test("只说一个范围时，另一个也要说清楚是开着的", () => {
  const txt = describeMeshSwitch({ lan: true, internet: false });
  assert.match(txt, /局域网 已关闭/);
  assert.match(txt, /互联网 开启/);
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
