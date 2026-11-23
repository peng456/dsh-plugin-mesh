/**
 * 校验「这个包能装进跑不了构建脚本的宿主」。
 *
 * ── 为什么要有这道闸（真实事故，2026-11-23）─────────────────────────
 * 0.5.6 起把 `ssh2` 写进了 `dependencies`。ssh2 自带一个安装脚本
 * `install: node install.js`（去编译可选的原生加速模块 cpu-features），于是
 * 每个装这个插件的宿主都会被要求跑一次构建：
 *
 *   · macOS / Linux / Android(termux) 上有 node 和编译器，装得上，所以没人发现；
 *   · iPad 上的 DSH Go 装不上 —— 宿主不允许依赖跑构建脚本，pnpm 直接抛
 *
 *       [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts:
 *         cpu-features@0.0.10, ssh2@1.17.0
 *
 *     整次安装失败，插件根本装不上去。对照实验：同为 iPad 的 0.5.5 零依赖，
 *     同一个安装器里 `Done in 2.6s`，干净通过。
 *
 * 结论写进规则：**运行时依赖必须为空**，或者只能是已核实「没有 preinstall /
 * install / postinstall 脚本、纯 JS」的包 —— 后者要显式进下面的 ALLOW，
 * 并写清核实方式，别靠"看起来没问题"。
 *
 * 需要可选能力（比如 SSH 用的 ssh2）时：不要放依赖里。按需 `import()` / `require()`
 * 并在缺失时给一句能动手的话（见 `lib/ssh-host.js`），装不装由用户决定。
 *
 * 跑法：node scripts/check-install-safe.mjs （已挂在 npm run check 里）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/**
 * 允许出现在 dependencies / optionalDependencies 里的包。
 *
 * **当前必须为空**：加任何一项之前，先确认它没有 preinstall/install/postinstall
 * 脚本（`npm view <包>@<版本> scripts`），并把核实结论写在下面。
 * optionalDependencies 也一样会触发构建脚本，别指望"可选"能绕过 —— 实测
 * `optionalDependencies: { ssh2 }` 在同一个受限安装器里仍然抛
 * ERR_PNPM_IGNORED_BUILDS。
 */
const ALLOW = /** @type {Record<string, string>} */ ({});

/** 包自己的安装脚本同样会在用户机器上跑，一律不要。 */
const FORBIDDEN_SELF_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

const failures = [];

for (const name of FORBIDDEN_SELF_SCRIPTS) {
  if (pkg.scripts?.[name]) {
    failures.push(
      `package.json 的 scripts.${name} 会在用户安装时执行；这个包必须"装即用、不跑脚本"。`,
    );
  }
}

const declared = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.optionalDependencies ?? {}),
};

for (const name of Object.keys(declared)) {
  if (ALLOW[name]) continue;
  failures.push(
    `运行时依赖 ${name}@${declared[name]} 未核实「无构建脚本」。\n` +
      `      依赖的安装脚本在 iPad 这类宿主上跑不了，会让整次安装失败（0.5.6–0.5.20 真踩过）。\n` +
      `      要保留它：先 npm view ${name}@<版本> scripts 确认没有 preinstall/install/postinstall，\n` +
      `      再加进 scripts/check-install-safe.mjs 的 ALLOW 并写明核实结论。\n` +
      `      只是"要用的时候才需要"的能力（如 ssh2）：从依赖里去掉，按需 import() 即可。`,
  );
}

if (failures.length > 0) {
  console.error("✗ 安装安全性检查未通过：");
  for (const line of failures) console.error(`    - ${line}`);
  process.exit(1);
}

const deps = Object.keys(declared);
console.log(
  deps.length === 0
    ? "✓ 零运行时依赖（安装不需要构建脚本）"
    : `✓ 运行时依赖均已核实无构建脚本：${deps.join(", ")}`,
);
