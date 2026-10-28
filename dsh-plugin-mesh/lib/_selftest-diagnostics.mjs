/**
 * 诊断块自测（`lib/diagnostics.js`）。
 *
 * 这组断言盯着一个反复踩的坑：**"进程版本 ≠ 磁盘版本"肉眼看不出来**。
 * 磁盘已经升到 0.5.3、宿主进程还在跑 0.5.2 时，界面必须能自己说清楚，
 * 否则用户会把旧行为当成新版本的 bug 报上来。
 *
 *   node lib/_selftest-diagnostics.mjs
 */
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDiagnostics, entryInfo, readPackageVersion } from "./diagnostics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = new URL("index.js", new URL(`file://${HERE}/`)).href;

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

console.log("\n── 版本漂移：进程 vs 磁盘 ──");

test("版本一致时 versionMatches=true，且不报磁盘更新", () => {
  const d = buildDiagnostics({ version: "0.5.3", packageVersion: "0.5.3", entryMtimeMs: 0, startedAt: Date.now() });
  assert.equal(d.versionMatches, true);
  assert.equal(d.diskNewerThanProcess, false);
});

test("升级了没重启：versionMatches=false，能看出磁盘比进程新", () => {
  const startedAt = Date.now() - 60_000;
  const d = buildDiagnostics({ version: "0.5.2", packageVersion: "0.5.3", entryMtimeMs: Date.now(), startedAt });
  assert.equal(d.versionMatches, false);
  assert.equal(d.diskNewerThanProcess, true, "入口文件比进程启动还新 → 就是没重启");
});

test("入口 mtime 拿不到时不能诬告「磁盘更新」", () => {
  const d = buildDiagnostics({ version: "0.5.3", packageVersion: "0.5.3", entryMtimeMs: 0, startedAt: Date.now() });
  assert.equal(d.diskNewerThanProcess, false, "mtime 未知 ≠ 磁盘更新");
});

test("空版本号不算匹配（宁可说不知道）", () => {
  const d = buildDiagnostics({ version: "", packageVersion: "0.5.3" });
  assert.equal(d.versionMatches, false);
});

console.log("\n── 不泄露密钥 ──");

test("config 只挑安全字段，tsnetAuthKey / secret 一律不出现", () => {
  const d = buildDiagnostics({
    version: "0.5.3",
    packageVersion: "0.5.3",
    config: { port: 45917, requirePairing: true, tsnetAuthKey: "tskey-auth-SECRET", secret: "s2", apiToken: "tok" },
  });
  assert.equal(d.config.port, 45917);
  assert.equal(d.config.requirePairing, true);
  const text = JSON.stringify(d);
  assert.ok(!text.includes("SECRET"), "tsnet 授权码泄进了诊断块");
  assert.ok(!text.includes("\"tok\""), "apiToken 泄进了诊断块");
  assert.ok(!("secret" in d.config));
});

console.log("\n── 真实磁盘读取 ──");

test("readPackageVersion 读得到本仓库版本号", () => {
  const v = readPackageVersion(ENTRY);
  assert.match(v, /^\d+\.\d+\.\d+/, `读到的版本号是 ${JSON.stringify(v)}`);
});

test("entryInfo 给出真实路径与 mtime", () => {
  const info = entryInfo(ENTRY);
  assert.ok(info.path.endsWith(join("lib", "index.js")), info.path);
  assert.ok(info.mtimeMs > 0);
});

test("入口 URL 是垃圾时安静返回空，不抛", () => {
  assert.equal(readPackageVersion("not-a-url"), "");
  assert.deepEqual(entryInfo("not-a-url"), { path: "", mtimeMs: 0 });
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
