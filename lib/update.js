/**
 * 「检查更新」：版本比较 + 向 npm registry 问一次最新版本。
 *
 * 为什么放在主机侧、而不是让浏览器直接 fetch registry：
 *   · 渲染层在 DSH Desktop 里有 CSP / 请求门禁，外网请求不一定发得出去；
 *   · 主机侧可以**带超时、带镜像回退、带缓存**，一次失败不会让整页变慢；
 *   · 失败必须能和「已是最新」区分开 —— 这是本项目最贵的一条教训
 *     （见 AGENTS.md 硬约束 1：探测失败不能被说成否定事实）。
 *
 * 所以这里只有两类结果：
 *   { ok: true,  latest: "0.6.0", ... }            —— 真的问到了
 *   { ok: false, error: "…超时…", failures: [...] } —— 没问到，原因逐条列出
 * 绝不存在「问不到 → 当作没有更新」这种降级。
 *
 * 本文件是纯函数 + 一个可注入 fetch 的查询，便于无网络单测。
 */
import { fileURLToPath } from "node:url";

export const RELEASE_REPO = "peng456/dsh-plugin-mesh";
export const NPM_PACKAGE = "dsh-plugin-mesh";

/**
 * 版本源：官方 registry 优先，国内镜像兜底（作者的机器上官方源时常很慢）。
 * 不按「谁快」做并发竞速：先问到的那个就够了，而且同时打两个源没有必要。
 */
export const DEFAULT_REGISTRIES = [
  `https://registry.npmjs.org/${NPM_PACKAGE}/latest`,
  `https://registry.npmmirror.com/${NPM_PACKAGE}/latest`,
];

/** 从 `import.meta.url` 推出插件安装目录（带结尾斜杠，可直接放进 tar -C）。 */
export function pluginDirFromUrl(metaUrl) {
  try {
    return fileURLToPath(new URL("../", metaUrl));
  } catch {
    return "";
  }
}

/**
 * 解析语义化版本；不是 `x.y.z[-pre][+build]` 就返回 null。
 * 返回 null 意味着「无法比较」，调用方必须把它和「相等」区分开。
 */
export function parseVersion(raw) {
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".").filter(Boolean) : [],
  };
}

/** semver 的预发布段比较：1.0.0-beta < 1.0.0；数字段按数值、字母段按字典序。 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  // 有预发布段的版本**小于**同号正式版
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 比较两个版本：a > b → 1，a < b → -1，相等 → 0。
 * 任一版本无法解析时返回 **null**（不是 0）—— 让调用方去说"无法比较"。
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return comparePrerelease(pa.pre, pb.pre);
}

/** 更新的"量级"：用于界面上说人话（大版本 / 小版本 / 修订 / 预发布）。 */
export function updateKind(current, latest) {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return "unknown";
  if (compareVersions(latest, current) !== 1) return "none";
  if (l.major !== c.major) return "major";
  if (l.minor !== c.minor) return "minor";
  if (l.patch !== c.patch) return "patch";
  return "prerelease";
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "版本源");
  }
}

/**
 * 问一次最新版本。逐源尝试，**每条失败原因都保留**（超时 / HTTP 错误 / 响应
 * 里没有 version），最终失败时一起返回，界面才有话可说。
 *
 * @returns {Promise<{ok: true, version: string, registry: string}
 *                  | {ok: false, error: string, failures: string[]}>}
 */
export async function fetchLatestVersion({
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  registries = DEFAULT_REGISTRIES,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "当前运行环境没有 fetch，无法检查更新", failures: [] };
  }
  const failures = [];
  for (const url of registries) {
    try {
      const signal =
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
      const res = await fetchImpl(url, { signal, headers: { accept: "application/json" } });
      if (!res || res.ok !== true) {
        failures.push(`${hostOf(url)} HTTP ${res ? res.status : "无响应"}`);
        continue;
      }
      const doc = await res.json();
      const version = String(doc?.version ?? "").trim();
      if (!version) {
        failures.push(`${hostOf(url)} 响应里没有 version`);
        continue;
      }
      if (!parseVersion(version)) {
        failures.push(`${hostOf(url)} 返回了无法比较的版本号 ${version}`);
        continue;
      }
      return { ok: true, version, registry: url };
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      failures.push(`${hostOf(url)} ${timedOut ? `超时（${timeoutMs}ms）` : String(err?.message ?? err)}`);
    }
  }
  return {
    ok: false,
    failures,
    error: failures.length ? `检查更新失败：${failures.join("；")}` : "没有可用的版本源",
  };
}

/**
 * 升级命令（与 scripts/release-plugin.sh 打出来的那条一致：release 资产是
 * 不带顶层目录的源码包，所以可以直接 tar xz -C 插件目录覆盖）。
 *
 * 这里只给「下载并覆盖」这一条；重启、回滚与可加载校验写在 README 的升级小节，
 * 界面不要假装一键升级 —— 覆盖完不重启等于没升级（VERSION 是启动时常量）。
 */
export function buildUpgradeCommand({ version, pluginDir } = {}) {
  const v = String(version ?? "").trim();
  if (!v) return "";
  const dir = String(pluginDir ?? "").trim() || "<插件目录>";
  const asset = `${NPM_PACKAGE}-${v}.tar.gz`;
  const url = `https://ghfast.top/https://github.com/${RELEASE_REPO}/releases/download/plugin-v${v}/${asset}`;
  return `curl -L ${url} | tar xz -C "${dir}"`;
}

/**
 * 组装返回给界面的报告。**不抛异常、不联网**，所有字段显式传入便于测试。
 *
 * `latest.ok !== true` 时返回 ok:false 并把原因带出去；界面据此显示"检查失败"，
 * 而不是"已是最新"。
 */
export function buildUpdateReport({
  current = "",
  diskVersion = "",
  latest = null,
  pluginDir = "",
  now = Date.now(),
} = {}) {
  const currentVersion = String(current ?? "").trim();
  const onDisk = String(diskVersion ?? "").trim();
  const report = {
    current: currentVersion,
    diskVersion: onDisk,
    /** 磁盘上已经不是进程正在跑的版本 = 升级了没重启（界面要明说） */
    versionDrift: !!onDisk && onDisk !== currentVersion,
    pluginDir: String(pluginDir ?? ""),
    checkedAt: new Date(now).toISOString(),
    releaseUrl: `https://github.com/${RELEASE_REPO}/releases`,
    npmUrl: `https://www.npmjs.com/package/${NPM_PACKAGE}`,
  };

  if (!latest || latest.ok !== true) {
    return {
      ok: false,
      ...report,
      error: String(latest?.error || "没有可用的版本源"),
      failures: Array.isArray(latest?.failures) ? latest.failures : [],
    };
  }

  const latestVersion = String(latest.version);
  const cmp = compareVersions(latestVersion, currentVersion);
  const comparable = cmp !== null;
  return {
    ok: true,
    ...report,
    latest: latestVersion,
    registry: String(latest.registry || ""),
    /** false = 版本号无法比较（界面必须说"无法比较"，不能说"已是最新"） */
    comparable,
    /** 只有明确比较出「更新」才是 true */
    hasUpdate: comparable ? cmp === 1 : false,
    kind: comparable ? updateKind(currentVersion, latestVersion) : "unknown",
    releaseUrl: `https://github.com/${RELEASE_REPO}/releases/tag/plugin-v${latestVersion}`,
    npmUrl: `https://www.npmjs.com/package/${NPM_PACKAGE}/v/${latestVersion}`,
    upgradeCommand: buildUpgradeCommand({ version: latestVersion, pluginDir }),
  };
}
