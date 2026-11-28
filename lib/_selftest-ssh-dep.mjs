/**
 * 「ssh2 从哪来」这条链路的自测。
 *
 * 守两个用户可见的误导，它们本来是同一个 bug 的两面：
 *
 *   1. **没有 ssh2 时不许沉默、不许说错话。** `open()` 会先拿密钥试一次，
 *      模块缺失会让那一步失败 —— 如果不管，最后会被包成
 *        对端拒绝了本机保存的密钥（…）。改用密码登录一次即可…
 *      用户照着这句话去重新部署密钥，永远修不好一个"没装模块"的问题
 *      （2026-11-23 实测就是这个错法）。
 *   2. **有自带副本时必须真的用上。** 现在插件在 `lib/vendor/ssh2` 里带了
 *      一份纯 JS 的 ssh2（`scripts/vendor-ssh2.mjs` 生成）。如果这段回退只在
 *      注释里存在，那么 iPad 上的 SSH 面板会永远停在"没装"上，而 CI 依然全绿
 *      —— 这正是这个项目反复踩过的"接好了但没接通"。
 *
 * 做法是在临时目录里搭一个**只有 `lib/` 的小插件**（`ssh-host.js` +
 * `ssh2-resolve.js` + 可选的自带副本），再从里面真的 import 一次。那个位置
 * 一定解析不到 profile 的 ssh2，等价于一台干净机器。全程不联网。
 *
 *   node lib/_selftest-ssh-dep.mjs
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const here = dirname(fileURLToPath(import.meta.url));
const sandboxes = [];

/**
 * 搭一个最小插件目录。
 * @param {{ vendored?: boolean, dependency?: string }} options
 *   vendored  —— 在 lib/vendor/ssh2 放一个假 ssh2（内容是 `body`）
 *   dependency —— 在 node_modules/ssh2 放一个假 ssh2
 */
function makeSandbox({ vendored = false, dependency = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mesh-ssh-dep-"));
  sandboxes.push(root);
  const lib = join(root, "lib");
  mkdirSync(lib, { recursive: true });
  copyFileSync(join(here, "ssh-host.js"), join(lib, "ssh-host.js"));
  copyFileSync(join(here, "ssh2-resolve.js"), join(lib, "ssh2-resolve.js"));

  const stub = (dir) => {
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ssh2", version: "0.0.0-stub", main: "lib/index.js" }));
    // 假 Client 必须**异步**报错，不能永远挂着：真 ssh2 在连不上时会 emit("error")，
    // open() 靠这个 reject。让假货静静待着，测试就会等成一个超时，看起来像"慢"，
    // 实际是"根本没接上"（这正是本文件要守的那类假绿）。
    writeFileSync(
      join(dir, "lib", "index.js"),
      [
        'const { EventEmitter } = require("events");',
        "class Client extends EventEmitter {",
        "  connect() { setImmediate(() => this.emit(\"error\", new Error(\"stub: 端口上没有服务器\"))); }",
        "  end() {}",
        "}",
        "module.exports = { Client };",
        "",
      ].join("\n"),
    );
  };

  if (vendored) stub(join(lib, "vendor", "ssh2"));
  if (dependency) stub(join(root, "node_modules", "ssh2"));
  return root;
}

/** 在沙箱里跑一段 ESM 代码，返回 stdout。 */
function runIn(root, code) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 20000,
    cwd: root,
  }).trim();
}

/** 调一次 open()，把真实错误消息捞回来。 */
function openMessage(root) {
  const code = `
    // Windows 上不能直接 import("C:\\...")：ESM loader 只认 file:// URL，
    // 直接给绝对路径会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME（CI 的 windows job 实测）。
    const { createSshManager } = await import(${JSON.stringify(pathToFileURL(join(root, "lib", "ssh-host.js")).href)});
    const stateDir = ${JSON.stringify(join(root, "state"))};
    const ssh = createSshManager({ stateDir, credentialsPath: stateDir + "/creds.json" });
    try {
      await ssh.open({ machine: "peer", host: "127.0.0.1", port: 1, username: "nobody" });
      console.log("NO_ERROR");
    } catch (err) {
      console.log(String(err && err.message ? err.message : err));
    }
  `;
  return runIn(root, code);
}

/** 直接问解析器"你用的是哪一份"。 */
function resolvesTo(root) {
  const code = `
    const { resolveSsh2 } = await import(${JSON.stringify(pathToFileURL(join(root, "lib", "ssh2-resolve.js")).href)});
    try { console.log(resolveSsh2().source); } catch (err) { console.log("ERROR: " + err.message); }
  `;
  return runIn(root, code);
}

console.log("\n── 两条来源都没有时 ──");

let message = "";
test("能拿到一条错误消息（不是静默成功）", () => {
  message = openMessage(makeSandbox());
  assert.ok(message && message !== "NO_ERROR", `期望报错，实际：${message}`);
});

test("说清是「没装 ssh2」，而不是其它原因", () => {
  assert.match(message, /ssh2/);
  assert.match(message, /没装/);
});

test("给出能动手的命令", () => {
  assert.match(message, /pnpm add ssh2/);
});

test("不把「没装模块」伪装成「对端拒绝了密钥」", () => {
  assert.doesNotMatch(message, /对端拒绝了本机保存的密钥/);
});

test("是单行消息（原始 Require stack 不糊进面板）", () => {
  assert.equal(message.split("\n").length, 1, `实际：${JSON.stringify(message)}`);
});

console.log("\n── 有自带副本时（0.5.24 起的主要路径，即现在唯一需要保证的路径）──");

test("解析器选中自带那份", () => {
  assert.equal(resolvesTo(makeSandbox({ vendored: true })), "vendored");
});

test("open() 不再报「没装」，而是真的走到连接那一步", () => {
  const got = openMessage(makeSandbox({ vendored: true }));
  assert.ok(got && got !== "NO_ERROR", `端口 1 应当连不上，实际：${got}`);
  assert.doesNotMatch(got, /没装/, `不该再提「没装」：${got}`);
  assert.doesNotMatch(got, /pnpm add ssh2/, `不该再让人去装：${got}`);
});

test("本机自己装的那份优先于自带副本", () => {
  assert.equal(resolvesTo(makeSandbox({ vendored: true, dependency: true })), "dependency");
});

test("自带副本坏了要说清楚是它坏了，而不是笼统的「没装」", () => {
  const root = makeSandbox({ vendored: true });
  writeFileSync(join(root, "lib", "vendor", "ssh2", "lib", "index.js"), "throw new Error('自带副本被拆坏了');\n");
  const got = resolvesTo(root);
  assert.match(got, /^ERROR: /);
  assert.match(got, /自带/);
  assert.match(got, /自带副本被拆坏了/);
});

for (const root of sandboxes) rmSync(root, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
