/**
 * 图标 / 设计 token 注册表门禁。
 *
 * 运行时真正的数据源仍是 client/client.js：
 *   - BRAND_ICONS：品牌 icon 的 color
 *   - RUNTIME_ICONS：运行时名 → 品牌 icon 的别名
 *   - --mesh-*: var(--dsw-alias-*)：设计 token 映射
 *
 * client/registry.json 是给人看、给外部工具读的快照。两边不一致时此脚本失败，
 * 防止“注册表写了但 UI 没接”或“UI 改了但注册表没更新”。
 *
 *   node scripts/check-registry.mjs
 *   node scripts/check-registry.mjs --write   # 重新生成 registry.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientPath = join(root, "client", "client.js");
const registryPath = join(root, "client", "registry.json");
const src = readFileSync(clientPath, "utf8");

const brandBlock = /const BRAND_ICONS = \{([\s\S]*?)\n\};/.exec(src);
const aliasBlock = /const RUNTIME_ICONS = \{([\s\S]*?)\n\};/.exec(src);
if (!brandBlock || !aliasBlock) {
  console.error("✗ client/client.js 里找不到 BRAND_ICONS / RUNTIME_ICONS");
  process.exit(1);
}

const icons = {};
for (const line of brandBlock[1].split("\n")) {
  const m = /^\s{2}([a-z0-9]+): \{ color: "([^"]+)"/.exec(line);
  if (m) icons[m[1]] = m[2];
}

const aliases = {};
for (const m of aliasBlock[1].matchAll(/(?:"([^"]+)"|([a-z0-9+#-]+)):\s*"([a-z0-9]+)"/g)) {
  aliases[m[1] || m[2]] = m[3];
}

const tokens = {};
for (const m of src.matchAll(/--mesh-([a-z0-9-]+):\s*var\((--dsw-alias-[a-z0-9-]+)\)/g)) {
  tokens[m[1]] = m[2];
}

const current = JSON.parse(readFileSync(registryPath, "utf8"));
const next = {
  version: 1,
  generatedFrom: "client/client.js",
  icons: Object.fromEntries(
    Object.entries(current.icons).map(([name, v]) => [name, { ...v, color: icons[name] ?? v.color }]),
  ),
  aliases,
  tokens,
};

const problems = [];
for (const [name, meta] of Object.entries(icons)) {
  if (!next.icons[name]) next.icons[name] = { color: meta, category: "tool" };
  if (next.icons[name].color !== meta) {
    problems.push(`icon ${name}: registry=${next.icons[name].color} client=${meta}`);
  }
}
for (const name of Object.keys(next.icons)) {
  if (!icons[name]) problems.push(`icon ${name}: registry 有、client 没有`);
}
for (const [alias, target] of Object.entries(aliases)) {
  if (target !== "code" && !icons[target]) problems.push(`alias ${alias} -> ${target}：目标不存在`);
}
const missingTokens = Object.keys(tokens).filter((k) => !next.tokens[k]);
const badTokens = Object.keys(tokens).filter((k) => next.tokens[k] !== tokens[k]);
if (missingTokens.length) problems.push(`tokens 缺失：${missingTokens.join(", ")}`);
if (badTokens.length) problems.push(`tokens 不一致：${badTokens.join(", ")}`);

if (process.argv.includes("--write")) {
  writeFileSync(registryPath, JSON.stringify(next, null, 2) + "\n");
  console.log(`✓ 已写入 ${registryPath}`);
  process.exit(0);
}

if (problems.length) {
  console.error(`✗ 注册表与 client 不一致（${problems.length} 项）：`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

console.log(`✓ 注册表一致：${Object.keys(icons).length} icons / ${Object.keys(aliases).length} aliases / ${Object.keys(tokens).length} tokens`);
