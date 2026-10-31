/**
 * 一键升级的自测：校验、解包、差异分类、原子替换与回滚。
 *
 * 这一块最贵的 bug 不是"装不上"，而是**装一半**：磁盘被覆盖了、新代码加载
 * 不了，用户下次重启 DSH 就崩。所以断言的重点是：
 *   · 任何失败路径下，旧目录一个字节都不能变；
 *   · 只有「可加载检查通过」才允许 rename 覆盖；
 *   · 只改客户端时不能要求重启（否则等于白折腾）。
 *
 * 全部无网络：fetch 是注入的假实现，tar 包在测试里现做。
 *
 *   node lib/_selftest-upgrade.mjs
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  PACKAGE_NAME,
  collectChanges,
  downloadTarball,
  extractTarball,
  fetchVersionMeta,
  installUpdate,
  parseIntegrity,
  pruneBackups,
  requestHostReload,
  requestHostRestart,
  trustedControlRequest,
  verifyBuffer,
  writeEntries,
} from "./upgrade.js";

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

// ── tar 夹具 ─────────────────────────────────────────────

function tarBlock(name, data, { mode = 0o644, type = "0" } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${(mode & 0o7777).toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8); // 校验和字段先留空格
  header.write(type, 156, 1);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function makeTarGz(files) {
  const chunks = [];
  for (const file of files) {
    const data = file.dir ? Buffer.alloc(0) : Buffer.from(file.content, "utf8");
    chunks.push(tarBlock(file.name, data, { mode: file.mode ?? (file.dir ? 0o755 : 0o644), type: file.dir ? "5" : "0" }));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function integrityOf(buffer) {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

function jsonRes(body, status = 200) {
  return { ok: status === 200, status, headers: { get: () => null }, json: async () => body };
}

function bufRes(buffer, status = 200) {
  return {
    ok: status === 200,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(buffer.length) : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "mesh-upgrade-test-"));
}

function seedPlugin(dir, { version = "0.5.7", lib = "old", client = "old" } = {}) {
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "client"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }, null, 2));
  writeFileSync(join(dir, "lib", "index.js"), `export const marker = ${JSON.stringify(lib)};\n`);
  writeFileSync(join(dir, "client", "client.js"), `// ${client}\n`);
  return dir;
}

function npmTarball({ version = "0.5.8", lib = "new", client = "new" } = {}) {
  return makeTarGz([
    { name: "package/", dir: true },
    { name: "package/package.json", content: JSON.stringify({ name: PACKAGE_NAME, version }, null, 2) },
    { name: "package/lib/index.js", content: `export const marker = ${JSON.stringify(lib)};\n` },
    { name: "package/client/client.js", content: `// ${client}\n` },
  ]);
}

console.log("\n── 完整性校验 ──");

test("sha512 integrity 能验过；内容改一字节就失败", () => {
  const buf = Buffer.from("hello mesh");
  const integrity = integrityOf(buf);
  assert.deepEqual(parseIntegrity(integrity)?.algorithm, "sha512");
  assert.equal(verifyBuffer(buf, integrity), true);
  assert.equal(verifyBuffer(Buffer.from("hello mesa"), integrity), false);
});

test("不认识的 integrity 一律不通过（不能把「没有哈希」当成通过）", () => {
  for (const bad of ["", "sha512", "md5-abc", "sha512-***", null, undefined]) {
    assert.equal(parseIntegrity(bad), null, JSON.stringify(bad));
    assert.equal(verifyBuffer(Buffer.from("x"), bad), false, JSON.stringify(bad));
  }
});

console.log("\n── 解包 ──");

test("npm 包的 package/ 前缀能 strip 掉，目录与文件都还原", () => {
  const entries = extractTarball(npmTarball(), { stripComponents: 1 });
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, ["client/client.js", "lib/index.js", "package.json"]);
});

test("带 ../ 的路径直接拒绝（不解出目录穿越）", () => {
  const evil = makeTarGz([{ name: "package/../../etc/passwd", content: "x" }]);
  assert.throws(() => extractTarball(evil, { stripComponents: 1 }), /不安全路径/);
});

test("writeEntries 再兜一层：不接受写到目标目录之外", () => {
  const dir = tempDir();
  try {
    assert.throws(() => writeEntries(dir, [{ path: "../evil.txt", dir: false, mode: 0o644, data: Buffer.from("x") }]), /目录之外/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("写盘保留可执行位（脚本类文件不会丢权限）", () => {
  const dir = tempDir();
  try {
    const entries = extractTarball(makeTarGz([{ name: "package/run.sh", content: "#!/bin/sh\n", mode: 0o755 }]), { stripComponents: 1 });
    writeEntries(dir, entries);
    const mode = statSync(join(dir, "run.sh")).mode & 0o777;
    assert.equal(mode, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\n── 差异分类：该重启还是该重载 ──");

test("只改 client → 重载界面就够，不要求重启", () => {
  const root = tempDir();
  try {
    const oldDir = seedPlugin(join(root, "old"));
    const newDir = seedPlugin(join(root, "new"), { version: "0.5.8", lib: "old", client: "new" });
    const r = collectChanges(oldDir, newDir);
    assert.equal(r.client, true);
    assert.equal(r.host, false);
    assert.equal(r.reloadRequired, true);
    assert.equal(r.restartRequired, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("改了 lib → 必须重启", () => {
  const root = tempDir();
  try {
    const oldDir = seedPlugin(join(root, "old"));
    const newDir = seedPlugin(join(root, "new"), { version: "0.5.8", lib: "new", client: "old" });
    const r = collectChanges(oldDir, newDir);
    assert.equal(r.host, true);
    assert.equal(r.restartRequired, true);
    assert.equal(r.reloadRequired, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("只改了版本号 → 建议重启（否则进程里的 VERSION 一直是旧的）", () => {
  const root = tempDir();
  try {
    const oldDir = seedPlugin(join(root, "old"));
    const newDir = seedPlugin(join(root, "new"), { version: "0.5.8", lib: "old", client: "old" });
    const r = collectChanges(oldDir, newDir);
    assert.equal(r.host, false);
    assert.equal(r.client, false);
    assert.equal(r.packageJson, true);
    assert.equal(r.restartRequired, true);
    assert.equal(r.reloadRequired, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("只改文档/脚本 → 既不需要重启也不需要重载", () => {
  const root = tempDir();
  try {
    const oldDir = seedPlugin(join(root, "old"));
    const newDir = seedPlugin(join(root, "new"), { lib: "old", client: "old" });
    writeFileSync(join(newDir, "README.md"), "new docs\n");
    const r = collectChanges(oldDir, newDir);
    assert.equal(r.restartRequired, false);
    assert.equal(r.reloadRequired, false);
    assert.equal(r.other, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("\n── 版本元数据 / 下载 ──");

const META_URL = "https://registry.npmjs.org/dsh-plugin-mesh/0.5.8";
const MIRROR_META_URL = "https://registry.npmmirror.com/dsh-plugin-mesh/0.5.8";
const TARBALL_URL = "https://registry.npmjs.org/dsh-plugin-mesh/-/dsh-plugin-mesh-0.5.8.tgz";

await testAsync("官方源成功 → 拿到 tarball 与 integrity", async () => {
  const tar = npmTarball();
  const meta = {
    version: "0.5.8",
    dist: { tarball: TARBALL_URL, integrity: integrityOf(tar) },
  };
  const r = await fetchVersionMeta({
    version: "0.5.8",
    fetchImpl: async (url) => (url === META_URL ? jsonRes(meta) : jsonRes({ error: "no" }, 404)),
  });
  assert.equal(r.ok, true);
  assert.equal(r.tarball, TARBALL_URL);
  assert.equal(r.integrity, integrityOf(tar));
  assert.equal(r.source, "https://registry.npmjs.org");
});

await testAsync("官方源 500 → 镜像兜底；两边都挂则逐条报出原因", async () => {
  const tar = npmTarball();
  const ok = await fetchVersionMeta({
    version: "0.5.8",
    fetchImpl: async (url) => {
      if (url === META_URL) return jsonRes({ error: "boom" }, 500);
      return jsonRes({ version: "0.5.8", dist: { tarball: TARBALL_URL, integrity: integrityOf(tar) } });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.source, "https://registry.npmmirror.com");

  const bad = await fetchVersionMeta({
    version: "0.5.8",
    fetchImpl: async (url) => {
      if (url === META_URL) throw new Error("ENOTFOUND");
      return jsonRes({}, 502);
    },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failures.length, 2, JSON.stringify(bad.failures));
  assert.ok(bad.failures[0].includes("ENOTFOUND"));
});

await testAsync("镜像滞后（返回别的版本）/ 缺 integrity → 不算成功", async () => {
  const stale = await fetchVersionMeta({
    version: "0.5.8",
    bases: ["https://registry.npmmirror.com"],
    fetchImpl: async () => jsonRes({ version: "0.5.7", dist: { tarball: TARBALL_URL, integrity: "sha512-AAAA" } }),
  });
  assert.equal(stale.ok, false);
  const noIntegrity = await fetchVersionMeta({
    version: "0.5.8",
    bases: ["https://registry.npmjs.org"],
    fetchImpl: async () => jsonRes({ version: "0.5.8", dist: { tarball: TARBALL_URL } }),
  });
  assert.equal(noIntegrity.ok, false);
  assert.ok(noIntegrity.error.includes("integrity"), noIntegrity.error);
});

await testAsync("下载校验：内容与 integrity 不一致就丢弃", async () => {
  const tar = npmTarball();
  const good = await downloadTarball({
    tarball: TARBALL_URL,
    integrity: integrityOf(tar),
    fetchImpl: async () => bufRes(tar),
  });
  assert.equal(good.ok, true);

  const tampered = Buffer.from(tar);
  tampered[tampered.length - 1] ^= 0xff;
  const bad = await downloadTarball({
    tarball: TARBALL_URL,
    integrity: integrityOf(tar),
    fetchImpl: async () => bufRes(tampered),
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes("校验失败"), bad.error);
});

await testAsync("下载超过上限 / HTTP 错误 → 明确拒绝", async () => {
  const tooBig = await downloadTarball({
    tarball: TARBALL_URL,
    integrity: "sha512-AAAA",
    maxBytes: 8,
    fetchImpl: async () => bufRes(Buffer.from("0123456789")),
  });
  assert.equal(tooBig.ok, false);
  assert.ok(tooBig.error.includes("太大"), tooBig.error);

  const http = await downloadTarball({
    tarball: TARBALL_URL,
    integrity: "sha512-AAAA",
    fetchImpl: async () => jsonRes({}, 404),
  });
  assert.equal(http.ok, false);
  assert.ok(http.error.includes("404"), http.error);
});

console.log("\n── 安装：失败必须保留旧版 ──");

/** 把安装流程要用的假 fetch 组装好。 */
function fakeUpgradeFetch({ version = "0.5.8", tar = npmTarball({ version }), badTar = null } = {}) {
  return async (url) => {
    if (url === META_URL) {
      const meta = { version, dist: { tarball: TARBALL_URL, integrity: integrityOf(tar) } };
      return jsonRes(meta);
    }
    if (url === TARBALL_URL) return bufRes(badTar ?? tar);
    if (url === MIRROR_META_URL) return jsonRes({ error: "not found" }, 404);
    throw new Error(`unexpected url: ${url}`);
  };
}

async function withPlugin(fn) {
  const root = tempDir();
  try {
    const pluginDir = seedPlugin(join(root, "node_modules", PACKAGE_NAME));
    const markerPath = join(root, "upgrade.json");
    return await fn({ root, pluginDir, markerPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await testAsync("成功：替换文件、留备份、写待重启标记", () =>
  withPlugin(async ({ pluginDir, markerPath }) => {
    const r = await installUpdate({
      version: "0.5.8",
      current: "0.5.7",
      pluginDir,
      markerPath,
      fetchImpl: fakeUpgradeFetch(),
      checkLoadable: async () => ({ ok: true }),
      now: 1700000000000,
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.installed, true);
    assert.equal(r.restartRequired, true);
    assert.ok(r.backupDir && existsSync(r.backupDir), "旧版备份应存在");
    assert.equal(JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).version, "0.5.8");
    assert.equal(readFileSync(join(pluginDir, "lib", "index.js"), "utf8"), 'export const marker = "new";\n');
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(marker.version, "0.5.8");
    assert.equal(marker.restartRequired, true);
    assert.equal(readdirSync(dirname(pluginDir)).filter((n) => n.startsWith(".mesh-upgrade-staging-")).length, 0, "staging 要清掉");
  }));

await testAsync("只改客户端：安装成功但 restartRequired=false", () =>
  withPlugin(async ({ pluginDir }) => {
    const tar = npmTarball({ client: "new", lib: "old" });
    const r = await installUpdate({
      version: "0.5.8",
      current: "0.5.7",
      pluginDir,
      fetchImpl: fakeUpgradeFetch({ tar }),
      checkLoadable: async () => ({ ok: true }),
      now: 1700000000001,
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.restartRequired, false);
    assert.equal(r.reloadRequired, true);
  }));

await testAsync("可加载检查失败：旧版原封不动，不留备份/staging", () =>
  withPlugin(async ({ pluginDir, root }) => {
    const before = readFileSync(join(pluginDir, "lib", "index.js"), "utf8");
    const r = await installUpdate({
      version: "0.5.8",
      current: "0.5.7",
      pluginDir,
      fetchImpl: fakeUpgradeFetch(),
      checkLoadable: async () => ({ ok: false, error: "Cannot find package '@deepseek-ai/dsh-brand'" }),
      now: 1700000000002,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "loadable");
    assert.ok(r.error.includes("不可加载"), r.error);
    assert.equal(readFileSync(join(pluginDir, "lib", "index.js"), "utf8"), before);
    assert.equal(readdirSync(dirname(pluginDir)).filter((n) => n.startsWith(".mesh-upgrade-backup-")).length, 0, "不该产生备份（还没交换）");
    assert.equal(readdirSync(dirname(pluginDir)).filter((n) => n.startsWith(".mesh-upgrade-staging-")).length, 0, "staging 要清掉");
  }));

await testAsync("哈希不符：不落地、不备份，报下载阶段失败", () =>
  withPlugin(async ({ pluginDir, root }) => {
    const tar = npmTarball();
    const bad = Buffer.from(tar);
    bad[bad.length - 1] ^= 0xff;
    const r = await installUpdate({
      version: "0.5.8",
      current: "0.5.7",
      pluginDir,
      fetchImpl: fakeUpgradeFetch({ tar, badTar: bad }),
      checkLoadable: async () => ({ ok: true }),
      now: 1700000000003,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "download");
    assert.ok(r.error.includes("校验失败"), r.error);
    assert.equal(readdirSync(dirname(pluginDir)).filter((n) => n.startsWith(".mesh-upgrade-")).length, 0);
  }));

await testAsync("目标版本不比当前新 / 版本号非法：直接拒绝，不碰磁盘", () =>
  withPlugin(async ({ pluginDir }) => {
    const same = await installUpdate({ version: "0.5.7", current: "0.5.7", pluginDir, fetchImpl: fakeUpgradeFetch() });
    assert.equal(same.ok, false);
    assert.equal(same.stage, "input");
    const older = await installUpdate({ version: "0.5.6", current: "0.5.7", pluginDir, fetchImpl: fakeUpgradeFetch() });
    assert.equal(older.ok, false);
    const weird = await installUpdate({ version: "latest", current: "0.5.7", pluginDir, fetchImpl: fakeUpgradeFetch() });
    assert.equal(weird.ok, false);
  }));

await testAsync("包身份不符（版本/名字对不上）：拒绝覆盖", () =>
  withPlugin(async ({ pluginDir }) => {
    const tar = npmTarball({ version: "9.9.9" });
    const r = await installUpdate({
      version: "0.5.8",
      current: "0.5.7",
      pluginDir,
      fetchImpl: fakeUpgradeFetch({ tar }),
      checkLoadable: async () => ({ ok: true }),
      now: 1700000000004,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "validate");
    assert.equal(JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).version, "0.5.7");
  }));

await testAsync("内容完全一样：报 up-to-date，不覆盖、不备份", () =>
  withPlugin(async ({ pluginDir, root }) => {
    // 旧版内容与"新版"一致，仅版本号相同才无差异；这里让旧版也标记 new
    writeFileSync(join(pluginDir, "lib", "index.js"), 'export const marker = "new";\n');
    writeFileSync(join(pluginDir, "client", "client.js"), "// new\n");
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "0.5.8" }, null, 2));
    const r = await installUpdate({
      version: "0.5.8",
      current: "0.5.7",
      pluginDir,
      fetchImpl: fakeUpgradeFetch(),
      checkLoadable: async () => ({ ok: true }),
      now: 1700000000005,
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.installed, false);
    assert.equal(r.upToDate, true);
    assert.equal(readdirSync(dirname(pluginDir)).filter((n) => n.startsWith(".mesh-upgrade-backup-")).length, 0);
  }));

console.log("\n── 备份清理 / 请求守卫 / 重启入口 ──");

test("只保留最近 3 份本工具创建的备份", () => {
  const root = tempDir();
  try {
    for (let i = 1; i <= 5; i += 1) mkdirSync(join(root, `.mesh-upgrade-backup-0.5.${i}-${i}`));
    mkdirSync(join(root, "unrelated"));
    pruneBackups(root, 3);
    const left = readdirSync(root).filter((n) => n.startsWith(".mesh-upgrade-backup-")).sort();
    assert.equal(left.length, 3, left.join(","));
    assert.ok(readdirSync(root).includes("unrelated"), "不相干的目录不能删");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("控制请求只认同源回环：转发头 / 非回环 / Origin 不符全部拒绝", () => {
  const req = (over = {}) => ({
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:43120", origin: "http://127.0.0.1:43120" },
    ...over,
  });
  assert.equal(trustedControlRequest(req()), true);
  assert.equal(trustedControlRequest(req({ socket: { remoteAddress: "192.168.1.9" } })), false);
  assert.equal(
    trustedControlRequest(req({ headers: { host: "127.0.0.1:43120", origin: "http://127.0.0.1:43120", "x-forwarded-for": "1.2.3.4" } })),
    false,
  );
  assert.equal(trustedControlRequest(req({ headers: { host: "127.0.0.1:43120" } })), false);
  assert.equal(
    trustedControlRequest(req({ headers: { host: "127.0.0.1:43120", origin: "http://evil.example" } })),
    false,
  );
});

await testAsync("有 desktopSettingsController 就调它的 restart（并触发 afterResponse）", async () => {
  let called = 0;
  const ctx = {
    get: (name) =>
      name === "desktopSettingsController"
        ? {
            restart: () => {
              called += 1;
              return { afterResponse: () => (called += 1) };
            },
          }
        : undefined,
  };
  const r = await requestHostRestart(ctx);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "desktop");
  assert.equal(called, 2, "restart 与 afterResponse 都要被调用");
});

test("有 desktopSettingsController.reloadRenderer 就调它（内置重载入口）", () => {
  let called = 0;
  const ctx = {
    get: (name) =>
      name === "desktopSettingsController"
        ? {
            reloadRenderer: () => {
              called += 1;
              return { afterResponse: () => (called += 1) };
            },
          }
        : undefined,
  };
  const r = requestHostReload(ctx);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "desktop");
  assert.equal(called, 2, "reloadRenderer 与 afterResponse 都要被调用");
});

test("没有内置重载入口 → mode:self（由页面自己 reload，不假装做了事）", () => {
  const r = requestHostReload({ get: () => undefined });
  assert.equal(r.ok, false);
  assert.equal(r.mode, "self");
  assert.ok(r.error.includes("页面自身重载"), r.error);
});

await testAsync("没有桌面控制器但有 web 端口 → 退到 dshmarket 的自重启（同源回环请求）", async () => {
  let seen = null;
  const ctx = { get: () => undefined, webServer: { port: 43120 } };
  const r = await requestHostRestart(ctx, {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "market");
  assert.equal(seen.url, "http://127.0.0.1:43120/dsh-market/api/v1/restart");
  assert.equal(seen.init.headers.host, "127.0.0.1:43120");
  assert.equal(seen.init.headers.origin, "http://127.0.0.1:43120");
});

await testAsync("市场自重启也不可用时：说清两条路都失败，并给手动重启", async () => {
  const ctx = { get: () => undefined, webServer: { port: 43120 } };
  const r = await requestHostRestart(ctx, {
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "not found" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.mode, "manual");
  assert.ok(r.error.includes("404"), r.error);
  assert.ok(r.error.includes("手动重启"), r.error);
});

await testAsync("既没有桌面控制器、也没有 web 端口 → 直接说手动重启（不假装成功）", async () => {
  const r = await requestHostRestart({ get: () => undefined });
  assert.equal(r.ok, false);
  assert.equal(r.mode, "manual");
  assert.ok(r.error.includes("手动重启"), r.error);
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
