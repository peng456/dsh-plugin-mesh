/**
 * 校验 lib/index.js 里的 VERSION 常量与 package.json 的 version 一致。
 *
 * 为什么单独做这一步：版本号写在两个地方，发版时很容易只改一个 —— 实测就漏过
 * 一次（package.json 升到 0.3.0，插件自报还是 0.2.0），而 UI 和日志都用这个常量，
 * 于是"装没装上"变得没法从界面上判断。
 *
 * 跑法：node scripts/check-version.mjs   （已挂在 npm run check 里）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const src = readFileSync(join(root, "lib/index.js"), "utf8");

const m = /^const VERSION = "([^"]+)";/m.exec(src);
if (!m) {
  console.error("✗ lib/index.js 里找不到 `const VERSION = \"...\";`");
  process.exit(1);
}

if (m[1] !== pkg.version) {
  console.error(`✗ 版本号不一致：`);
  console.error(`    package.json  : ${pkg.version}`);
  console.error(`    lib/index.js  : ${m[1]}`);
  console.error(`  两处必须相同，否则界面和日志会报错的版本号。`);
  process.exit(1);
}

console.log(`✓ 版本号一致：${pkg.version}`);
