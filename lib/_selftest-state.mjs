/**
 * state.json 落盘的自测：原子写、.bak 回退、损坏时留现场。
 *
 * 为什么单独测：它**踩在安全边界上** —— state.json 里存着配对码和
 * `requirePairing` 开关。原来的实现解析失败一律返回 `{}`，等于「文件损坏 →
 * 配对静默关闭」；写坏了还会把 secret / instanceIds 一起抹掉。
 *
 * 全部在临时目录里跑，不碰真实的 ~/.dsh。
 *
 *   node lib/_selftest-state.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveCorrupt, readJsonFile, writeJsonFile } from "./state.js";

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "mesh-state-"));
const file = join(dir, "state.json");
const bak = `${file}.bak`;
const clean = () => {
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true });
};

try {
  console.log("\n── 正常读写 ──");

  check("文件不存在 → 空状态 + healthy（首次运行不算损坏）", () => {
    clean();
    const { data, health } = readJsonFile(file);
    assert.deepEqual(data, {});
    assert.deepEqual(health, { ok: true, recovered: false, error: "" });
  });

  check("写入后能读回，且不残留 tmp 文件", () => {
    clean();
    writeJsonFile(file, { secret: "s".repeat(32), instanceIds: { desktop: "a0072fdf3f2e72e3" } });
    const { data, health } = readJsonFile(file);
    assert.equal(data.secret, "s".repeat(32));
    assert.deepEqual(data.instanceIds, { desktop: "a0072fdf3f2e72e3" });
    assert.equal(health.ok, true);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
  });

  check("第二次写入把上一版留成 .bak", () => {
    writeJsonFile(file, { secret: "new-secret" });
    assert.ok(existsSync(bak), "应当生成 .bak");
    assert.equal(JSON.parse(readFileSync(bak, "utf8")).secret, "s".repeat(32));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).secret, "new-secret");
  });

  console.log("\n── 损坏与恢复 ──");

  check("主文件损坏 → 从 .bak 恢复，并标记 recovered", () => {
    writeFileSync(file, "{ 这不是 JSON");
    const { data, health } = readJsonFile(file);
    assert.equal(data.secret, "s".repeat(32), "应当从 .bak 读回上一版");
    assert.equal(health.ok, true);
    assert.equal(health.recovered, true);
    assert.match(health.error, /JSON/);
  });

  check("主文件与 .bak 都坏 → ok=false，交给调用方 fail-closed", () => {
    writeFileSync(file, "半个{");
    writeFileSync(bak, "[1,2,3");
    const { data, health } = readJsonFile(file);
    assert.deepEqual(data, {});
    assert.equal(health.ok, false);
    assert.equal(health.recovered, false);
  });

  check("顶层不是对象也算损坏（数组/字符串不能当状态用）", () => {
    writeFileSync(file, "[1,2,3]");
    rmSync(bak, { force: true });
    assert.equal(readJsonFile(file).health.ok, false);
    writeFileSync(file, '"just a string"');
    assert.equal(readJsonFile(file).health.ok, false);
  });

  check("损坏时写入不会用好文件覆盖 .bak", () => {
    clean();
    writeJsonFile(file, { secret: "good" });
    writeJsonFile(file, { secret: "good-2" });
    writeFileSync(file, "{ 坏了");
    writeJsonFile(file, { secret: "rebuilt" });
    assert.equal(JSON.parse(readFileSync(bak, "utf8")).secret, "good", ".bak 必须还是上一份能解析的内容");
  });

  console.log("\n── 保留现场 ──");

  check("preserveCorrupt 复制出 .corrupt-*，内容与坏文件一致", () => {
    clean();
    writeFileSync(file, "{ 坏掉的内容");
    const kept = preserveCorrupt(file, 1700000000000);
    assert.equal(kept, `${file}.corrupt-1700000000000`);
    assert.equal(readFileSync(kept, "utf8"), "{ 坏掉的内容");
  });

  check("没有坏文件时 preserveCorrupt 不制造空副本", () => {
    clean();
    assert.equal(preserveCorrupt(file), "");
    assert.deepEqual(readdirSync(dir), []);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
