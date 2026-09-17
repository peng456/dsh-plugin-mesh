/**
 * 开发用启动器：复现真实 Electron 主进程的模块解析行为。
 *
 * 为什么需要它 —— `desktop-cli.js:78` 只在 `app.asar` 内才安装 profile 包解析器，
 * 而未打包的安装（`Resources/app` 是普通目录）走 CLI 时解析不到 profile 里的插件，
 * 裸包名会报 ERR_MODULE_NOT_FOUND，客户端 bundle 也不会被提供。
 * 真实 Electron 主进程（`main.js:4478`）是**无条件**安装解析器的，所以真实应用没这个问题。
 * 这个脚本就干那一件事：装上解析器，再进 CLI。
 *
 * 用法:
 *   DSH_HOME=/tmp/mesh-dsh ELECTRON_RUN_AS_NODE=1 \
 *     "<DSH Desktop 可执行文件>" \
 *     dev-boot.mjs --profile meshtest --port 8877
 *
 * 应用目录探测顺序：
 *   1. 环境变量 DSH_APP_DIR
 *   2. 常见安装位置（macOS / Windows / Linux）
 * 解析器文件名带内容哈希（如 module-resolution-C8mVg9xZ.js），
 * 所以这里用 glob 匹配而不是写死，避免 DSH 升级后失效。
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// ── 探测 DSH 应用目录 ──────────────────────────────────────────

function candidateAppDirs() {
  const out = [];
  if (process.env.DSH_APP_DIR) out.push(process.env.DSH_APP_DIR);

  const home = homedir();
  if (process.platform === "darwin") {
    for (const base of ["/Applications", join(home, "Applications")]) {
      try {
        for (const name of readdirSync(base)) {
          if (!/^DSH Desktop.*\.app$/i.test(name)) continue;
          out.push(join(base, name, "Contents", "Resources", "app"));
        }
      } catch {
        /* 目录不存在 */
      }
    }
  } else if (process.platform === "win32") {
    for (const base of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]]) {
      if (!base) continue;
      for (const name of ["DSH Desktop", "dsh-desktop", "DeepSeek Harness"]) {
        out.push(join(base, name, "resources", "app"));
      }
    }
  } else {
    for (const base of ["/opt", "/usr/lib", "/usr/local/lib", join(home, ".local/share")]) {
      for (const name of ["dsh-desktop", "DSH Desktop", "deepseek-harness-desktop"]) {
        out.push(join(base, name, "resources", "app"));
      }
    }
  }
  // 本仓库相对位置（如果插件被放在 checkout 里）
  out.push(join(process.cwd(), "..", "app"));
  return out;
}

function findAppDir() {
  for (const dir of candidateAppDirs()) {
    if (dir && existsSync(join(dir, "lib", "desktop-cli.js"))) return dir;
  }
  return undefined;
}

/** 解析器文件名带内容哈希，用前缀匹配；不同版本可能不带哈希。 */
function findResolverModule(appDir) {
  const libDir = join(appDir, "lib");
  let names;
  try {
    names = readdirSync(libDir);
  } catch {
    return undefined;
  }
  const hashed = names.find((n) => /^module-resolution-.*\.js$/.test(n));
  if (hashed) return join(libDir, hashed);
  return names.includes("module-resolution.js") ? join(libDir, "module-resolution.js") : undefined;
}

// ── 主流程 ────────────────────────────────────────────────────

const APP = findAppDir();
if (!APP) {
  console.error(
    "[dev-boot] 找不到 DSH 应用目录。\n" +
      "          用 DSH_APP_DIR 指定，例如：\n" +
      '          DSH_APP_DIR="/Applications/DSH Desktop 2.app/Contents/Resources/app" ...',
  );
  process.exit(1);
}

const resolverPath = findResolverModule(APP);
if (!resolverPath) {
  console.error(
    `[dev-boot] 在 ${join(APP, "lib")} 里找不到 module-resolution-*.js。\n` +
      "          这个安装的 DSH 版本可能不一样，或者不需要解析器（已打包成 asar）。",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const profileIdx = argv.findIndex((a) => a === "--profile");
const profile = profileIdx >= 0 ? argv[profileIdx + 1] : "meshtest";
const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const manifestPath = join(home, "profiles", profile, "package.json");

if (!existsSync(manifestPath)) {
  console.error(
    `[dev-boot] 找不到 profile 清单 ${manifestPath}\n` +
      "          先用 dev-setup.sh 建一个测试 profile。",
  );
  process.exit(1);
}

const { t: installProfilePackageResolver } = await import(pathToFileURL(resolverPath).href);
const release = installProfilePackageResolver(pathToFileURL(manifestPath).href);
process.once("exit", release);

console.error(`[dev-boot] app      = ${APP}`);
console.error(`[dev-boot] resolver = ${resolverPath.split("/").pop()}`);
console.error(`[dev-boot] profile  = ${profile}   home = ${home}`);

try {
  const entry = pathToFileURL(join(APP, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")).href;
  await (await import(entry)).runCli({ allowDesktopProfile: true });
} finally {
  release();
}
