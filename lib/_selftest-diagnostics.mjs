/**
 * diagnostics 的自测：纯函数 + 临时目录里的 package.json/mtime。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildDiagnostics, entryInfo, readPackageVersion } from "./diagnostics.js";

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

console.log("\n── 版本三轴 ──");

check("进程版本与磁盘版本不一致 → versionMatches=false", () => {
  const d = buildDiagnostics({
    version: "0.3.33",
    packageVersion: "0.3.34",
    startedAt: 1_000,
    now: 1_500,
  });
  assert.equal(d.versionMatches, false);
  assert.equal(d.uptimeMs, 500);
});

check("入口 mtime 晚于进程启动 → diskNewerThanProcess=true", () => {
  const d = buildDiagnostics({
    version: "0.3.33",
    packageVersion: "0.3.33",
    entryMtimeMs: 2_000,
    startedAt: 1_000,
  });
  assert.equal(d.versionMatches, true);
  assert.equal(d.diskNewerThanProcess, true);
  assert.equal(d.entryMtime, new Date(2_000).toISOString());
});

check("入口 mtime 早于进程启动 → 不误报", () => {
  const d = buildDiagnostics({ entryMtimeMs: 500, startedAt: 1_000 });
  assert.equal(d.diskNewerThanProcess, false);
});

console.log("\n── 配置脱敏与能力摘要 ──");

check("配置只挑安全字段，绝不回传 secret / tsnetAuthKey", () => {
  const d = buildDiagnostics({
    config: {
      port: 45917,
      requirePairing: true,
      workspaceRoot: "/w",
      tsnetAuthKey: "tskey-auth-secret",
      secret: "pairing-secret",
    },
  });
  assert.equal(d.config.port, 45917);
  assert.equal(d.config.requirePairing, true);
  assert.ok(!("tsnetAuthKey" in d.config));
  assert.ok(!("secret" in d.config));
});

check("能力摘要只带数量/名字，不带 probeErrors 明细", () => {
  const d = buildDiagnostics({
    capabilities: {
      capabilitiesAt: 123,
      runtimesIncomplete: true,
      probeFailCount: 3,
      gpu: { name: "RTX 5060" },
      wsl: [{ name: "Ubuntu" }, { name: "" }],
      probeErrors: { node: "timeout" },
    },
  });
  assert.equal(d.capabilities.at, 123);
  assert.equal(d.capabilities.runtimesIncomplete, true);
  assert.equal(d.capabilities.probeFailCount, 3);
  assert.equal(d.capabilities.gpu, "RTX 5060");
  assert.deepEqual(d.capabilities.wsl, ["Ubuntu"]);
  assert.ok(!("probeErrors" in d.capabilities));
});

console.log("\n── 磁盘读取 ──");

const dir = mkdtempSync(join(tmpdir(), "mesh-diag-"));
try {
  mkdirSync(join(dir, "lib"), { recursive: true });
  const entry = join(dir, "lib", "index.js");
  writeFileSync(entry, "// entry\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  const url = pathToFileURL(entry);

  check("readPackageVersion 读入口同级的 package.json", () => {
    assert.equal(readPackageVersion(url), "9.9.9");
  });

  check("entryInfo 返回真实路径与 mtime", () => {
    const info = entryInfo(url);
    assert.equal(info.path, entry);
    assert.ok(info.mtimeMs > 0);
  });

  check("package.json 不存在时返回空串，不抛", () => {
    const missing = pathToFileURL(join(dir, "nope", "lib", "index.js"));
    assert.equal(readPackageVersion(missing), "");
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
