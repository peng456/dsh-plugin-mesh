/**
 * 让 `llms.txt` 和 `docs/llms.txt` 保持一致。
 *
 * 为什么需要它：`llms.txt` 是给 agent 的机器入口（llmstxt.org 约定）。它要被
 * 两个地方拿到：
 *   · 仓库根 —— clone 下来的 agent 直接读本地文件
 *   · `docs/` —— 站点上 `https://<site>/llms.txt`，这是约定里 agent 会去找的路径
 *
 * 两份必须逐字节相同，否则 agent 会读到两个版本的"事实"，而且**没人会察觉**
 * （这项目已经栽过好几次"复制了一份、然后忘了同步"）。所以改成一份源 + 校验：
 *
 *   node scripts/sync-llms.mjs           # 校验（默认，CI / npm run check 用）
 *   node scripts/sync-llms.mjs --write   # 用根目录那份覆盖 docs/
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "llms.txt");
const DST = join(ROOT, "docs", "llms.txt");

if (!existsSync(SRC)) {
  console.error("✗ 找不到 llms.txt —— 它是给 agent 的机器入口，不能少");
  process.exit(1);
}

const src = readFileSync(SRC, "utf8");

if (process.argv.includes("--write")) {
  writeFileSync(DST, src);
  console.log(`✓ 已同步 docs/llms.txt（${src.length} 字符）`);
  process.exit(0);
}

if (!existsSync(DST)) {
  console.error("✗ docs/llms.txt 不存在 —— 跑 `node scripts/sync-llms.mjs --write`");
  process.exit(1);
}

const dst = readFileSync(DST, "utf8");
if (dst !== src) {
  // 给出行数差异，别只丢一句"不一致"
  const a = src.split("\n");
  const b = dst.split("\n");
  const firstDiff = a.findIndex((line, i) => line !== b[i]);
  console.error(
    `✗ docs/llms.txt 与 llms.txt 不一致（首个差异在根文件第 ${firstDiff + 1} 行）。\n` +
      `  两份都是 agent 会读的"事实来源"，必须相同。\n` +
      `  修复：node scripts/sync-llms.mjs --write`,
  );
  process.exit(1);
}
console.log(`✓ llms.txt 与 docs/llms.txt 一致（${src.length} 字符）`);
