/**
 * 「检查更新」的自测：版本比较 + registry 查询失败时的语义。
 *
 * 这一块的**核心断言不是"能查出新版本"，而是"查不到时必须说查不到"**。
 * 本项目最贵的教训（AGENTS.md 硬约束 1）：探测失败被当成否定事实 ——
 * 这里如果写成「没问到 → 当作已是最新」，用户会永远升不了级，而且看不出来。
 *
 * 全部无网络：fetch 是注入的假实现。
 *
 *   node lib/_selftest-update.mjs
 */
import { strict as assert } from "node:assert";
import {
  buildUpdateReport,
  buildUpgradeCommand,
  compareVersions,
  fetchLatestVersion,
  parseVersion,
  pluginDirFromUrl,
  updateKind,
  DEFAULT_REGISTRIES,
} from "./update.js";

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

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

console.log("\n── 版本解析与比较 ──");

test("解析 x.y.z / v 前缀 / 预发布 / build 元数据", () => {
  assert.deepEqual(parseVersion("0.5.6"), { major: 0, minor: 5, patch: 6, pre: [] });
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseVersion(" 1.2.3-beta.2 "), { major: 1, minor: 2, patch: 3, pre: ["beta", "2"] });
  assert.deepEqual(parseVersion("1.2.3+build.9"), { major: 1, minor: 2, patch: 3, pre: [] });
});

test("不是语义化版本 → null（不能假装能比）", () => {
  for (const bad of ["", "latest", "1.2", "1.2.3.4", "x.y.z", null, undefined, "1.2.x"]) {
    assert.equal(parseVersion(bad), null, JSON.stringify(bad));
  }
});

test("主/次/修订逐段比较", () => {
  assert.equal(compareVersions("0.5.6", "0.5.7"), -1);
  assert.equal(compareVersions("0.6.0", "0.5.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0, "v 前缀不影响比较");
});

test("预发布小于同号正式版；预发布之间按 semver 规则", () => {
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1, "数字段按数值比");
  assert.equal(compareVersions("1.0.0-beta", "1.0.0-beta.1"), -1, "少的段更小");
});

test("任一侧无法解析 → null，不是 0", () => {
  assert.equal(compareVersions("0.5.6", "latest"), null);
  assert.equal(compareVersions("", "0.5.6"), null);
});

test("更新量级：major / minor / patch / prerelease / none", () => {
  assert.equal(updateKind("0.5.6", "1.0.0"), "major");
  assert.equal(updateKind("0.5.6", "0.6.0"), "minor");
  assert.equal(updateKind("0.5.6", "0.5.7"), "patch");
  assert.equal(updateKind("0.6.0-beta.1", "0.6.0"), "prerelease");
  assert.equal(updateKind("0.5.6", "0.5.6-rc.1"), "none", "预发布比正式版旧");
  assert.equal(updateKind("0.5.6", "0.5.6"), "none");
  assert.equal(updateKind("0.5.7", "0.5.6"), "none", "更旧不叫更新");
  assert.equal(updateKind("0.5.6", "latest"), "unknown");
});

console.log("\n── 升级命令 / 安装目录 ──");

test("插件安装目录从 import.meta.url 推出（lib/ 的上一级，带结尾斜杠）", () => {
  const dir = pluginDirFromUrl("file:///Users/peng/.dsh/profiles/desktop/node_modules/dsh-plugin-mesh/lib/index.js");
  assert.equal(dir, "/Users/peng/.dsh/profiles/desktop/node_modules/dsh-plugin-mesh/");
});

test("升级命令用的是 release 真实资产名与 tag（与 scripts/release-plugin.sh 一致）", () => {
  const cmd = buildUpgradeCommand({ version: "0.6.0", pluginDir: "/tmp/plugin/" });
  assert.ok(cmd.includes("plugin-v0.6.0"), cmd);
  assert.ok(cmd.includes("dsh-plugin-mesh-0.6.0.tar.gz"), cmd);
  assert.ok(cmd.includes('tar xz -C "/tmp/plugin/"'), cmd);
  assert.ok(cmd.startsWith("curl -L https://ghfast.top/https://github.com/peng456/dsh-plugin-mesh/releases/download/"), cmd);
});

test("没有版本就不编一条假命令", () => {
  assert.equal(buildUpgradeCommand({ version: "", pluginDir: "/x/" }), "");
});

console.log("\n── 报告组装：失败绝不能说成「已是最新」──");

const okLatest = { ok: true, version: "0.6.0", registry: DEFAULT_REGISTRIES[0] };

test("有新版本 → hasUpdate / kind / 链接 / 可复制命令都在", () => {
  const r = buildUpdateReport({
    current: "0.5.6",
    diskVersion: "0.5.6",
    latest: okLatest,
    pluginDir: "/p/",
    now: Date.parse("2026-10-29T00:00:00Z"),
  });
  assert.equal(r.ok, true);
  assert.equal(r.current, "0.5.6");
  assert.equal(r.latest, "0.6.0");
  assert.equal(r.comparable, true);
  assert.equal(r.hasUpdate, true);
  assert.equal(r.kind, "minor");
  assert.equal(r.versionDrift, false);
  assert.equal(r.checkedAt, "2026-10-29T00:00:00.000Z");
  assert.ok(r.releaseUrl.endsWith("/releases/tag/plugin-v0.6.0"), r.releaseUrl);
  assert.ok(r.npmUrl.endsWith("/v/0.6.0"), r.npmUrl);
  assert.ok(r.upgradeCommand.includes("0.6.0"));
  assert.ok(r.upgradeCommand.includes('"/p/"'));
});

test("同版本 → 已是最新（hasUpdate=false, kind=none）", () => {
  const r = buildUpdateReport({ current: "0.6.0", latest: okLatest, pluginDir: "/p/" });
  assert.equal(r.ok, true);
  assert.equal(r.hasUpdate, false);
  assert.equal(r.kind, "none");
  assert.equal(r.comparable, true);
});

test("版本号无法比较 → comparable=false，且 hasUpdate 不能是 true", () => {
  const r = buildUpdateReport({
    current: "0.5.6",
    latest: { ok: true, version: "2026.1", registry: "x" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.comparable, false);
  assert.equal(r.hasUpdate, false);
  assert.equal(r.kind, "unknown");
});

test("registry 查询失败 → ok:false 且带原因；不能有 latest，也不能说没有更新", () => {
  const r = buildUpdateReport({
    current: "0.5.6",
    latest: { ok: false, error: "检查更新失败：registry.npmjs.org 超时（5000ms）", failures: ["a 超时", "b HTTP 502"] },
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("超时"), r.error);
  assert.deepEqual(r.failures, ["a 超时", "b HTTP 502"]);
  assert.equal("latest" in r, false, "没问到最新版本就不能回报 latest");
  assert.equal("hasUpdate" in r, false, "没问到就不能声称有/没有更新");
});

test("磁盘版本与进程版本不一致 → versionDrift=true（升级了没重启）", () => {
  const r = buildUpdateReport({ current: "0.5.6", diskVersion: "0.6.0", latest: okLatest });
  assert.equal(r.versionDrift, true);
  const same = buildUpdateReport({ current: "0.6.0", diskVersion: "0.6.0", latest: okLatest });
  assert.equal(same.versionDrift, false);
});

console.log("\n── registry 查询：逐源尝试，失败原因全留 ──");

await testAsync("官方源成功 → 直接用，不再问镜像", async () => {
  const calls = [];
  const r = await fetchLatestVersion({
    registries: ["https://a.test/latest", "https://b.test/latest"],
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ version: "0.6.0" });
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.version, "0.6.0");
  assert.equal(r.registry, "https://a.test/latest");
  assert.deepEqual(calls, ["https://a.test/latest"]);
});

await testAsync("官方源 HTTP 500 → 回退镜像成功", async () => {
  const r = await fetchLatestVersion({
    registries: ["https://a.test/latest", "https://b.test/latest"],
    fetchImpl: async (url) =>
      url.startsWith("https://a.test") ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ version: "0.7.0" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.version, "0.7.0");
  assert.equal(r.registry, "https://b.test/latest");
});

await testAsync("两个源都挂 → ok:false，且每个原因都保留（能看出是谁挂了）", async () => {
  const r = await fetchLatestVersion({
    registries: ["https://a.test/latest", "https://b.test/latest"],
    fetchImpl: async (url) => {
      if (url.startsWith("https://a.test")) throw new Error("ENOTFOUND a.test");
      return jsonResponse({}, 502);
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 2, JSON.stringify(r.failures));
  assert.ok(r.failures[0].includes("ENOTFOUND"), r.failures[0]);
  assert.ok(r.failures[1].includes("HTTP 502"), r.failures[1]);
  assert.ok(r.error.includes("检查更新失败"), r.error);
});

await testAsync("超时要写成「超时」，不能和 HTTP 错误混为一谈", async () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const r = await fetchLatestVersion({
    registries: ["https://a.test/latest"],
    timeoutMs: 1234,
    fetchImpl: async () => {
      throw timeout;
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.failures[0].includes("超时（1234ms）"), r.failures[0]);
});

await testAsync("响应里没有 version → 该源不算成功，继续下一个", async () => {
  const r = await fetchLatestVersion({
    registries: ["https://a.test/latest", "https://b.test/latest"],
    fetchImpl: async (url) =>
      url.startsWith("https://a.test") ? jsonResponse({ name: "dsh-plugin-mesh" }) : jsonResponse({ version: "0.6.0" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.version, "0.6.0");
});

await testAsync("registry 返回无法比较的版本 → 该源不算成功，最终报失败", async () => {
  const r = await fetchLatestVersion({
    registries: ["https://a.test/latest"],
    fetchImpl: async () => jsonResponse({ version: "2026.1" }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.failures[0].includes("2026.1"), r.failures[0]);
});

await testAsync("没有 fetch 的运行环境 → 说清楚无法检查，而不是静默", async () => {
  const r = await fetchLatestVersion({ fetchImpl: null, registries: [] });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("fetch"), r.error);
});

test("pendingUpgrade 原样带出：磁盘装好了但进程没重启，界面靠它给重启/重载", () => {
  const pending = { version: "0.6.0", previous: "0.5.6", restartRequired: true, reloadRequired: false, inferred: false };
  const r = buildUpdateReport({ current: "0.5.6", diskVersion: "0.6.0", latest: okLatest, pendingUpgrade: pending });
  assert.equal(r.pendingUpgrade.restartRequired, true);
  assert.equal(r.pendingUpgrade.version, "0.6.0");
  const none = buildUpdateReport({ current: "0.6.0", diskVersion: "0.6.0", latest: okLatest });
  assert.equal(none.pendingUpgrade, null);
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
