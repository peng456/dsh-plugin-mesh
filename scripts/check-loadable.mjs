/**
 * 校验一份**已落盘**的插件副本"真的能被加载"，而不只是"文件都对得上"。
 *
 * ── 为什么单独做这一步 ──────────────────────────────────────────────
 * 升级是"先落盘、后重启"两段式的，中间存在一个**半态窗口**：磁盘已经是新版本，
 * 进程还是旧版本（VERSION 是进程启动时读入的常量，不会跟着磁盘变）。这个窗口
 * 里如果新代码新增了一个 import，而落盘**漏了**那个文件，重启就会**当场崩**
 * —— DSH 加载插件时才会去解析 import，之前一切正常。
 *
 * 两种常规自检都兜不住这个失败模式：
 *   · `find lib -type f` + 逐字节 cmp：**被漏掉的文件根本不在磁盘上**，
 *     没有"不一致"可比对，cmp 只会报"全部一致"。
 *   · `node --check <file>`：只做**单文件语法**解析，不解析 import 图，
 *     缺文件照样通过。
 * 唯一能精确复现"重启即崩"的，是**从安装路径实际 import 一次入口**。
 *
 * 踩过：0.3.28 新增了 `lib/prompt.js`（index.js 顶层 import 它）。当时磁盘
 * 一度处于"新 index.js + 缺 prompt.js"的半态，cmp 全绿、--check 全绿，
 * 差点带着它重启。对端 hos 复现并给出这条做法，实测有效。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────
 *   # 校验本仓库（默认）
 *   node scripts/check-loadable.mjs
 *
 *   # 校验某个**安装路径**（升级脚本里应校验这个，而不是仓库）
 *   node scripts/check-loadable.mjs ~/.dsh/profiles/desktop/node_modules/dsh-plugin-mesh
 *
 * 退出码 0 = 可加载；非 0 = 不可加载（升级脚本应当据此**回滚**）。
 *
 * ⚠️ 必须在**装了运行时的位置**跑。index.js 顶层 import 了 DSH 运行时提供的
 * `@deepseek-ai/dsh-brand`；在仓库里直接跑会因为解析不到它而报
 * ERR_MODULE_NOT_FOUND —— 那是"仓库缺 node_modules"，**不是**半态，别误判。
 * 校验仓库时用 `--allow-missing-runtime-dep` 把这一类错误降级为警告。
 *
 * ✅ 这一步是**安全**的：`import` 只求值顶层代码，而 index.js 把起服务、绑端口、
 * 建 udp socket 全都放在 `apply()` 里，顶层没有副作用。实测连跑 3 次：
 * 不写 state.json / threads.json，也不抢 sidecar 的 45917（仍归运行中的进程）。
 * 所以可以放心放进发布门禁和升级脚本 —— 它不会干扰正在跑的实例。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY = "lib/index.js";

/** 报错里出现这些包名，说明缺的是 DSH 运行时提供的依赖，不是磁盘半态。 */
const RUNTIME_PROVIDED = ["@deepseek-ai/"];
/** 预期的入口导出 —— 少一个都说明这份代码和当前协议不匹配。 */
const EXPECTED_EXPORTS = ["Config", "MESH_DEFAULT_PORT", "apply", "inject", "name"];

function parseArgs(argv) {
  const args = { target: null, allowMissingRuntimeDep: false, quiet: false };
  for (const a of argv) {
    if (a === "--allow-missing-runtime-dep") args.allowMissingRuntimeDep = true;
    else if (a === "--quiet") args.quiet = true;
    else if (!a.startsWith("-")) args.target = a;
    else {
      console.error(`✗ 未知参数：${a}`);
      process.exit(2);
    }
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  args.dir = args.target
    ? resolve(isAbsolute(args.target) ? args.target : join(process.cwd(), args.target))
    : root;
  return args;
}

const args = parseArgs(process.argv.slice(2));
const say = (...m) => {
  if (!args.quiet) console.log(...m);
};

const entryPath = join(args.dir, ENTRY);
if (!existsSync(entryPath)) {
  console.error(`✗ 找不到入口：${entryPath}`);
  console.error("  这份副本不完整（连 lib/index.js 都没有），**不要重启**。");
  process.exit(1);
}

/** 读 package.json 的版本，仅用于打印；读不到不算失败。 */
function versionOf(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

/**
 * 读 lib/index.js 里的 `const VERSION = "x.y.z";` —— 这是**进程自述**的版本。
 * 不用 mod.version：index.js 并不导出 VERSION（导出只有 Config/apply/inject/name…），
 * 一开始就是这么写错的，别再踩。
 */
function declaredVersion(dir) {
  try {
    const src = readFileSync(join(dir, ENTRY), "utf8");
    return /^const VERSION = "([^"]+)";/m.exec(src)?.[1] ?? null;
  } catch {
    return null;
  }
}

say(`▶ 校验可加载性: ${args.dir}`);
say(`  版本(磁盘): ${versionOf(args.dir)}`);
say(`  入口: ${entryPath}`);

const started = Date.now();
let mod;
try {
  mod = await import(pathToFileURL(entryPath).href);
} catch (err) {
  const code = err?.code ?? "";
  const msg = String(err?.message ?? err);
  const missingRuntimeDep =
    code === "ERR_MODULE_NOT_FOUND" && RUNTIME_PROVIDED.some((p) => msg.includes(p));

  if (missingRuntimeDep && args.allowMissingRuntimeDep) {
    console.warn(`⚠ 跳过：缺的是 DSH 运行时依赖，不是磁盘半态。`);
    console.warn(`   ${msg.split("\n")[0]}`);
    process.exit(0);
  }

  console.error(`✗ 加载失败（${Date.now() - started}ms）：${code || "Error"}`);
  console.error(`   ${msg.split("\n")[0]}`);
  if (code === "ERR_MODULE_NOT_FOUND") {
    console.error("");
    console.error("   这是**半态**特征：入口 import 了磁盘上不存在的文件。");
    console.error("   带着这份磁盘去重启，DSH 会在加载插件时当场崩 —— 请先补齐文件或回滚。");
  }
  process.exit(1);
}

const exports = Object.keys(mod).sort();
const missing = EXPECTED_EXPORTS.filter((k) => !(k in mod));
if (missing.length) {
  console.error(`✗ 加载成功但导出不全，缺: ${missing.join(", ")}`);
  console.error(`   实际导出: ${exports.join(", ") || "(空)"}`);
  process.exit(1);
}

// 自述版本应当和 package.json 一致（两者不一致会让"装没装上"没法从界面判断）。
const diskVersion = versionOf(args.dir);
const selfVersion = declaredVersion(args.dir);

say(`✓ 可加载（${Date.now() - started}ms）：exports = ${exports.join(", ")}`);
if (selfVersion && diskVersion !== "?" && selfVersion !== diskVersion) {
  console.warn(`⚠ 自述 VERSION(${selfVersion}) ≠ package.json(${diskVersion})`);
  say("  （VERSION 是启动时冻结的常量，这通常说明**进程**还没重启 —— 磁盘已是新版本）");
} else if (selfVersion) {
  say(`  自述 VERSION: ${selfVersion}（与 package.json 一致）`);
}
process.exit(0);
