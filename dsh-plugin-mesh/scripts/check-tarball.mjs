/**
 * 发布门禁：校验**打出来的包**，而不是源码树。
 *
 * 为什么不能只跑 check-loadable 就完事：那个查的是仓库目录，而真正发出去的是
 * `npm pack` 按 `files` 白名单挑出来的 tar。两者可以不一致 —— `files` 里漏写一个
 * 目录，源码树完好、发布件残缺，装到别人机器上才炸。
 * 本项目已经栽过好几次"看着接上了、其实没接"（cordis.patch.yml 钉死默认值、
 * install.sh 漏拷 scripts/、门禁只被注释提到），所以这里刻意校验**产物本身**。
 *
 * 做四件事：
 *   1. 真打一个 tgz（--ignore-scripts，避免递归触发 pre* 脚本）
 *   2. 解到临时目录，检查运行必需的条目一个不少
 *   3. 对**解出来的那棵树**跑 check-loadable：它能抓出"入口 import 了包内不存在
 *      的文件"这种半态（缺 @deepseek-ai/* 运行时依赖不算错，那是宿主提供的）
 *   4. 打印体积与文件数
 *
 *   node scripts/check-tarball.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 发布件里**必须**存在的条目。缺任何一个，装到别人机器上就是坏的。 */
const REQUIRED = [
  "package.json",
  "cordis.patch.yml", // dsh.bundle.patch 指向它，没有它插件根本挂不上
  "lib/index.js", // 入口
  "lib/capabilities.js",
  "lib/prompt.js",
  "lib/discovery.js",
  "lib/conversation.js",
  "lib/identity.js",
  "lib/tsnet/manager.js",
  "client/client.js", // dsh.client 指向它
  "scripts/check-loadable.mjs",
  "README.md",
  "LICENSE",
];

let failed = 0;
const bad = (m) => {
  failed += 1;
  console.error(`✗ ${m}`);
};

const tmp = mkdtempSync(join(tmpdir(), "mesh-pack-"));
try {
  console.log("▶ 打包（npm pack --ignore-scripts）");
  const out = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", tmp, "--silent"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const tgz = join(tmp, out.split("\n").pop().trim());
  if (!existsSync(tgz)) {
    bad(`没生成 tgz（npm pack 输出：${out}）`);
    process.exit(1);
  }
  const sizeKb = Math.round(statSync(tgz).size / 1024);
  console.log(`  产物 ${out}（${sizeKb} KB）`);

  // 解包：tar 在各平台上都有（macOS / Linux 自带，Windows 10+ 自带 bsdtar）
  const dest = join(tmp, "unpacked");
  execFileSync("mkdir", ["-p", dest]);
  execFileSync("tar", ["-xzf", tgz, "-C", dest]);

  // npm 打出来的包固定多一层 package/
  const pkgRoot = join(dest, "package");
  if (!existsSync(pkgRoot)) {
    bad("解出来没有 package/ 目录，包结构不对");
    process.exit(1);
  }

  console.log("▶ 必需条目");
  for (const rel of REQUIRED) {
    if (existsSync(join(pkgRoot, rel))) console.log(`  ✓ ${rel}`);
    else bad(`缺文件：${rel}`);
  }

  const count = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1), 0);
  console.log(`  文件总数：${count(pkgRoot)}`);

  console.log("▶ 对**发布件**跑可加载性门禁");
  try {
    const r = execFileSync("node", [join(pkgRoot, "scripts", "check-loadable.mjs"), pkgRoot, "--allow-missing-runtime-dep"], {
      encoding: "utf8",
      cwd: pkgRoot,
    });
    process.stdout.write(r.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n"));
  } catch (e) {
    bad("发布件不可加载");
    process.stdout.write(String(e.stdout ?? ""));
    process.stderr.write(String(e.stderr ?? ""));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n✗ 发布门禁未通过（${failed} 项）—— 不要发布`);
  process.exit(1);
}
console.log("\n✓ 发布门禁通过：打出来的包完整且可加载");
