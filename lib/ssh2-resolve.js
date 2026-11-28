/**
 * 找一份能用的 `ssh2`。
 *
 * 两层，顺序固定：
 *
 *   1. **本机自己装的**（profile 的 `node_modules/ssh2`）。谁为了拿到原生加速
 *      特意装过，就用他那份，不被插件自带版本盖掉；
 *   2. **插件自带的**（`lib/vendor/ssh2`，由 `scripts/vendor-ssh2.mjs` 生成）。
 *      它是纯 JS、零安装脚本的一份 ssh2 —— 上游那个"编译可选加速件"的
 *      `install.js` 在打包时就被拿掉了，所以它能跟着 npm 包一起解压落地，
 *      不触发任何宿主的安装期门禁。
 *
 * 为什么不再要求用户 `pnpm add ssh2`：那是一条只有**有 shell 的桌面**才走得通
 * 的路。iPad 上的 DSH Go 既没有 pnpm，也不允许依赖跑构建脚本，于是 SSH 面板
 * 在那一端是永久不可用的 —— 一个可选功能不该有这种代价（见
 * `scripts/check-install-safe.mjs` 与 `docs/DESIGN-NOTES.md`）。
 *
 * 两层都找不到时才抛错；错误里必须同时给出两条原因，且是**单行**的（原始
 * ERR_MODULE_NOT_FOUND 带多行 "Require stack:"，塞进面板会糊成一片）。
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 自带副本的入口；也供自测判断"这一份到底在不在"。 */
export const VENDORED_SSH2_DIR = join(HERE, "vendor", "ssh2");
export const VENDORED_SSH2_ENTRY = join(VENDORED_SSH2_DIR, "lib", "index.js");

const firstLine = (error) => String(error?.message ?? error).split("\n")[0].trim();

/** 兼容 CJS 默认导出与 `module.default` 两种形态，只要里面有 Client。 */
function asSsh2(mod) {
  const candidate = mod?.Client ? mod : mod?.default?.Client ? mod.default : undefined;
  return candidate?.Client ? candidate : undefined;
}

export function vendoredSsh2Present() {
  return existsSync(VENDORED_SSH2_ENTRY);
}

/**
 * @returns {{ module: object, source: "dependency" | "vendored", path: string }}
 * @throws 两条来源都不行时抛出带原因的单行错误
 */
export function resolveSsh2() {
  const reasons = [];

  try {
    const mod = createRequire(import.meta.url)("ssh2");
    const ssh2 = asSsh2(mod);
    if (ssh2) return { module: ssh2, source: "dependency", path: "ssh2" };
    reasons.push("本机那份里没有 Client");
  } catch (error) {
    reasons.push(`本机：${firstLine(error)}`);
  }

  if (vendoredSsh2Present()) {
    try {
      const mod = createRequire(VENDORED_SSH2_ENTRY)(VENDORED_SSH2_ENTRY);
      const ssh2 = asSsh2(mod);
      if (ssh2) return { module: ssh2, source: "vendored", path: VENDORED_SSH2_ENTRY };
      reasons.push("自带那份里没有 Client");
    } catch (error) {
      reasons.push(`自带：${firstLine(error)}`);
    }
  } else {
    reasons.push("自带副本不存在");
  }

  throw new Error(
    "SSH 终端需要 ssh2，这台机器上没装（" +
      reasons.join("；") +
      "）。SSH 是可选项，其余 mesh 功能不受影响；可在 profile 目录执行 " +
      "`pnpm add ssh2` 补上，或确认安装器没有裁掉插件里的 lib/vendor/ssh2。",
  );
}
