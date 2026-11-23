/**
 * 「ssh2 没装」这句话的自测。
 *
 * 守的是一个用户可见的误导：ssh2 不再是插件的依赖（原因见 `lib/ssh-host.js`
 * 文件头和 `scripts/check-install-safe.mjs`），所以**大部分机器上它都没装**。
 * 而 `open()` 会先拿密钥试一次，模块缺失会让那一步失败 —— 如果不管，最后会被包成
 *
 *   对端拒绝了本机保存的密钥（…）。改用密码登录一次即可…
 *
 * 用户照着这句话去重新部署密钥，永远修不好一个"没装模块"的问题（2026-11-23 实测
 * 就是这个错法）。所以这里把两条都钉住：
 *   · 缺 ssh2 → 说"没装"，并给出能动手的命令；
 *   · 这条错误不许出现"对端拒绝了本机保存的密钥"。
 *
 * 做法是把 `ssh-host.js`（只依赖 node 内置模块）复制到一个没有 node_modules 的
 * 临时目录里 import —— 那个位置一定解析不到 ssh2，等于真实缺依赖的机器。
 *
 *   node lib/_selftest-ssh-dep.mjs
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const sandbox = mkdtempSync(join(tmpdir(), "mesh-ssh-dep-"));

/** 在沙箱里跑一次 open()，把真实错误消息捞回来。 */
function openWithoutSsh2() {
  copyFileSync(join(here, "ssh-host.js"), join(sandbox, "ssh-host.js"));
  const code = `
    const { createSshManager } = await import(${JSON.stringify(join(sandbox, "ssh-host.js"))});
    const stateDir = ${JSON.stringify(join(sandbox, "state"))};
    const ssh = createSshManager({ stateDir, credentialsPath: stateDir + "/creds.json" });
    try {
      await ssh.open({ machine: "peer", host: "127.0.0.1", port: 1, username: "nobody" });
      console.log("NO_ERROR");
    } catch (err) {
      console.log(String(err && err.message ? err.message : err));
    }
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 20000,
    cwd: sandbox,
  }).trim();
}

console.log("\n── 缺 ssh2 时的说法 ──");

let message = "";
test("能拿到一条错误消息（不是静默成功）", () => {
  message = openWithoutSsh2();
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

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
