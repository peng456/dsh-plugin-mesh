/**
 * 诊断信息（纯函数 + 两个小 IO 辅助）。
 *
 * 移植自 PR #17，只保留「诊断」这半：任务记录详情主干已有，不再重复。
 *
 * 为什么需要它：这个项目反复在“进程版本 ≠ 磁盘版本”上误诊 —— 重启日志、
 * state.json、磁盘 package.json 都不能证明**当前进程加载的是哪份代码**。
 * 诊断块把三件事摆在一起：
 *   · 进程自述版本（VERSION 常量，来自已加载的代码）
 *   · 磁盘 package.json 的版本
 *   · 入口文件 mtime 与进程启动时间的先后
 *
 * 输出只包含排障必需的信息，**不含** secret / tsnetAuthKey。
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 读入口同级 package.json 的版本；失败返回空串。 */
export function readPackageVersion(entryUrl) {
  try {
    const pkg = new URL("../package.json", entryUrl);
    const raw = JSON.parse(readFileSync(pkg, "utf8"));
    return typeof raw?.version === "string" ? raw.version : "";
  } catch {
    return "";
  }
}

/** 入口文件的真实路径与 mtime；失败返回空。 */
export function entryInfo(entryUrl) {
  try {
    const path = fileURLToPath(entryUrl);
    const stat = statSync(path);
    return { path, mtimeMs: stat.mtimeMs };
  } catch {
    return { path: "", mtimeMs: 0 };
  }
}

/**
 * 组装诊断块。所有输入显式传入，方便单测；不做任何探测。
 *
 * @param config 插件配置（只挑安全字段输出，绝不回传 secret / tsnetAuthKey）
 */
export function buildDiagnostics({
  version = "",
  packageVersion = "",
  entry = "",
  entryMtimeMs = 0,
  startedAt = Date.now(),
  now = Date.now(),
  pid = process.pid,
  node = process.version,
  platform = process.platform,
  arch = process.arch,
  hostname = "",
  machine = "",
  config = {},
  capabilities = null,
} = {}) {
  const safeConfig = {};
  for (const key of [
    "port",
    "useMulticast",
    "scanOnStart",
    "scanIntervalMs",
    "pingIntervalMs",
    "requirePairing",
    "agentPreset",
    "permissionPreset",
    "workspaceRoot",
    "tsnetEnabled",
  ]) {
    if (config?.[key] !== undefined) safeConfig[key] = config[key];
  }

  return {
    ok: true,
    app: "dsh-mesh",
    version: String(version ?? ""),
    packageVersion: String(packageVersion ?? ""),
    // 进程自述版本 vs 磁盘 package.json
    versionMatches: !!version && String(version) === String(packageVersion),
    // 入口文件比进程启动还新 → 磁盘换了代码但没重启
    diskNewerThanProcess: entryMtimeMs > 0 && entryMtimeMs > startedAt,
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Math.max(0, Number(now) - Number(startedAt)),
    pid,
    node,
    platform,
    arch,
    hostname: String(hostname ?? ""),
    machine: String(machine ?? ""),
    entry: String(entry ?? ""),
    entryMtime: entryMtimeMs > 0 ? new Date(entryMtimeMs).toISOString() : "",
    config: safeConfig,
    capabilities: capabilities
      ? {
          at: Number(capabilities.capabilitiesAt) || 0,
          runtimesIncomplete: capabilities.runtimesIncomplete === true,
          probeFailCount: Number(capabilities.probeFailCount) || 0,
          gpu: String(capabilities.gpu?.name ?? ""),
          wsl: Array.isArray(capabilities.wsl)
            ? capabilities.wsl.map((w) => String(w?.name ?? "")).filter(Boolean)
            : [],
        }
      : null,
  };
}
