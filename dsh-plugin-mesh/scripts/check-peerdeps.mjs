#!/usr/bin/env node
/**
 * 自检：lib/ 里静态 import 的 `@deepseek-ai/*` 必须都在 package.json 的
 * peerDependencies 里声明。
 *
 * 为什么必须做这一条（真机事故，dsh-go 0.9.7 / DSH 0.2.1-rc.2，2026-10-29）：
 *   lib/index.js 里 `import { brandString } from "@deepseek-ai/dsh-brand"`，
 *   但 package.json 的 peerDependencies 漏了 @deepseek-ai/dsh-brand。
 *   DSH 的插件加载器只拦截"插件自己声明过的 peer"，没声明就走原生 ESM 解析；
 *   手机（dsh-go profile）里没有这个包 → ERR_MODULE_NOT_FOUND → **整个插件 import 失败**
 *   （fiberPhase=null、/mesh/v1/health 404、入站路由全没了）。
 *   npm 打包不会报错，`node --check` 也查不出——只有真机能暴露，所以加这个门禁。
 *
 * 判定：只看静态 import（含 `import "x"`、`import ... from "x"`）与字面量
 * `import("x")`；忽略注释里的示例与 `client/client.js`（它只 require react，
 * 其余模块由 DSH 的 __ModuleLoader__ 注入，不受 peerDependencies 约束）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "lib");

/** 递归收集 lib 下的 .js / .mjs 文件。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(mjs|cjs|js)$/u.test(entry)) out.push(full);
  }
  return out;
}

/** 去掉行注释与块注释（够用即可，不追求解析器级正确）。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

const IMPORT_RE = /\bimport\s+(?:[\s\S]*?\s+from\s+)?["'](@deepseek-ai\/[^"']+)["']|import\(\s*["'](@deepseek-ai\/[^"']+)["']\s*\)/gu;

const found = new Map(); // spec -> [{file, line}]
for (const file of walk(LIB)) {
  const text = stripComments(readFileSync(file, "utf8"));
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(lines[i])) !== null) {
      const spec = m[1] || m[2];
      if (!spec) continue;
      if (!found.has(spec)) found.set(spec, []);
      found.get(spec).push({ file: relative(ROOT, file), line: i + 1 });
    }
  }
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
} catch (err) {
  console.error(`✗ 读不到 package.json：${err?.message ?? err}`);
  process.exit(1);
}
const declared = new Set(Object.keys(pkg.peerDependencies || {}));
const meta = pkg.peerDependenciesMeta || {};

const missing = [];
const notOptional = [];
for (const [spec, uses] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (!declared.has(spec)) missing.push({ spec, uses });
  else if (meta[spec]?.optional !== true) notOptional.push(spec);
}

console.log(`▶ 检查 @deepseek-ai/* peer 声明：lib/ 内共 ${found.size} 个包被 import`);
for (const spec of [...found.keys()].sort()) console.log(`  · ${spec}${declared.has(spec) ? "" : "   <-- 未声明"}`);

if (notOptional.length > 0) {
  console.log(`⚠ 以下 peer 没标 optional（安装环境可能直接报缺包）：${notOptional.join(", ")}`);
}

if (missing.length > 0) {
  console.error("\n✗ 以下包被 lib/ import 但没写进 peerDependencies（DSH 加载器不会拦截，真机会 ERR_MODULE_NOT_FOUND）：");
  for (const { spec, uses } of missing) {
    console.error(`  - ${spec}`);
    for (const u of uses.slice(0, 5)) console.error(`      ${u.file}:${u.line}`);
  }
  console.error("\n修法：把缺的包加进 package.json 的 peerDependencies + peerDependenciesMeta(optional:true)。");
  process.exit(1);
}

console.log("✓ 所有 lib/ 静态 import 的 @deepseek-ai/* 都已在 peerDependencies 里声明");
