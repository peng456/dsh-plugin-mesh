/**
 * 配对码开关的自测。
 *
 * 为什么单独测这一段：它**安全相关**，而且判错的后果是**静默的** ——
 * 配对码没生效时，任务照样能派过去，一切看起来正常，只是不再有保护。
 * 这种东西必须有断言盯着。
 *
 *   node lib/_selftest-pairing.mjs
 */
import { strict as assert } from "node:assert";
import { resolvePairing } from "./pairing.js";

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

console.log("\n── 默认必须是关闭（降低上手成本，也是历史默认值）──");

test("配置与 state 都没有 → 不需要配对", () => {
  assert.deepEqual(resolvePairing({ config: {}, state: {} }), { required: false, pinned: false });
});
test("全空入参 → 不需要配对，且不崩", () => {
  assert.deepEqual(resolvePairing(), { required: false, pinned: false });
  assert.deepEqual(resolvePairing({}), { required: false, pinned: false });
});

console.log("\n── 界面开关：写 state.json，不钉死 ──");

test("state.requirePairing = true → 启用，但界面可以再关掉", () => {
  assert.deepEqual(resolvePairing({ config: {}, state: { requirePairing: true } }), {
    required: true,
    pinned: false,
  });
});
test("state.requirePairing = false → 关闭", () => {
  assert.equal(resolvePairing({ config: {}, state: { requirePairing: false } }).required, false);
});

console.log("\n── 配置钉死：部署方强制，界面关不掉 ──");

test("config.requirePairing = true → 启用且 pinned", () => {
  assert.deepEqual(resolvePairing({ config: { requirePairing: true }, state: {} }), {
    required: true,
    pinned: true,
  });
});
test("配置钉死时，state 里写 false 也关不掉（配置优先）", () => {
  const r = resolvePairing({ config: { requirePairing: true }, state: { requirePairing: false } });
  assert.equal(r.required, true);
  assert.equal(r.pinned, true);
});

console.log("\n── 只认严格的布尔 true（防 YAML 字符串坑）──");

test('字符串 "true" 不算开启 —— 否则会让人以为配对生效了，实际没有', () => {
  assert.equal(resolvePairing({ config: { requirePairing: "true" }, state: {} }).required, false);
  assert.equal(resolvePairing({ config: {}, state: { requirePairing: "true" } }).required, false);
});
test("数字 1 / 空对象等非 true 值都不算开启", () => {
  for (const v of [1, "1", "yes", {}, [], null, undefined]) {
    assert.equal(resolvePairing({ config: { requirePairing: v }, state: {} }).required, false, `config=${JSON.stringify(v)}`);
    assert.equal(resolvePairing({ config: {}, state: { requirePairing: v } }).required, false, `state=${JSON.stringify(v)}`);
  }
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
