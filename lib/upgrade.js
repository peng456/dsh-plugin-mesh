/**
 * 一键升级：下载 → sha512 校验 → 解包 → 真实 import 可加载检查 → 原子替换。
 *
 * 为什么是这一套顺序：升级最大的风险不是"下载失败"，而是**半态** ——
 * 磁盘换了一半、或换了却加载不了，用户一重启 DSH 就崩（0.3.28 真踩过：
 * 文件级 cmp 全绿、node --check 全绿，重启当场崩）。所以这里每一道闸都
 * 放在"覆盖旧版"之前，任何一步不通过都保留旧版、清掉 staging。
 *
 * 为什么从 npm tarball 装、而不是 GitHub Release 资产：
 *   · npm 的 metadata 带 `dist.integrity`（sha512），能校验；GitHub 资产的
 *     digest 要问 api.github.com，而国内这个域名经常不通；
 *   · npm 官方源 + npmmirror 两条路，都不依赖 ghfast 这类代理；
 *   · npm 包里 `files` 与 GitHub 资产同源（都来自 package.json），内容等价，
 *     只是多一层 `package/` 前缀，解包时 strip 掉即可。
 *
 * 本文件不碰 HTTP 路由，也不决定"要不要重启"；那些在 index.js / client 里。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { compareVersions, parseVersion } from "./update.js";

export const PACKAGE_NAME = "dsh-plugin-mesh";
/** 版本元数据源：官方优先，国内镜像兜底（镜像可能滞后，滞后会明确报错）。 */
export const REGISTRY_BASES = [
  "https://registry.npmjs.org",
  "https://registry.npmmirror.com",
];
/** 安装目录同级的临时目录前缀：放同一个文件系统里，rename 才是原子的。 */
const STAGING_PREFIX = ".mesh-upgrade-staging-";
const BACKUP_PREFIX = ".mesh-upgrade-backup-";
/** 下载上限：当前包约 450KB，32MB 足够挡住错误的响应体。 */
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;

// ─────────────────────── 小工具 ───────────────────────

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "版本源");
  }
}

function errText(err, timeoutMs) {
  const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
  return timedOut ? `超时（${timeoutMs}ms）` : String(err?.message ?? err);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// ─────────────────────── 校验 ───────────────────────

/** 解析 npm 的 `dist.integrity`（`sha512-<base64>`）；不认识就返回 null。 */
export function parseIntegrity(raw) {
  const m = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  return { algorithm: m[1], digest: Buffer.from(m[2], "base64") };
}

/** 用 registry 记录的完整性校验下载内容。算法/长度不对一律 false。 */
export function verifyBuffer(buffer, integrity) {
  const parsed = parseIntegrity(integrity);
  if (!parsed || !Buffer.isBuffer(buffer)) return false;
  const actual = createHash(parsed.algorithm).update(buffer).digest();
  return actual.length === parsed.digest.length && timingSafeEqual(actual, parsed.digest);
}

// ─────────────────────── tar.gz ───────────────────────

/** 读 tar 头里的 C 字符串字段（NUL 或字段末尾为止）。 */
function cstr(tar, start, end) {
  let i = start;
  while (i < end && tar[i] !== 0) i += 1;
  return tar.subarray(start, i).toString("utf8");
}

/** 八进制字段；空字段按 0。 */
function octal(tar, start, end) {
  const raw = cstr(tar, start, end).trim();
  if (raw === "") return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 解 gzip 后的 tar，返回内存里的条目（不写盘，便于单测）。
 *
 * 只接受普通文件和目录；符号链接/设备直接跳过 —— 插件包里没有这些，
 * 而"解出符号链接"正是 tar 路径穿越最常见的利用方式。
 * `stripComponents` 用来去掉 npm 包的 `package/` 前缀。
 */
export function extractTarball(buffer, { stripComponents = 0 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("空的压缩包");
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch (err) {
    throw new Error(`不是有效的 .tar.gz：${err?.message ?? err}`);
  }
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 500);
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const mode = octal(header, 100, 108);
    const size = octal(header, 124, 136);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`压缩包被截断（${name}）`);
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type !== "0" && type !== "5") continue; // 链接/设备/扩展头：不落地
    const parts = name.split("/").filter((p) => p !== "" && p !== ".");
    if (name.startsWith("/") || parts.includes("..")) throw new Error(`压缩包里有不安全路径：${name}`);
    const stripped = parts.slice(stripComponents);
    if (stripped.length === 0) continue;
    entries.push({
      path: stripped.join("/"),
      dir: type === "5",
      mode: (mode || 0o644) & 0o777,
      data: type === "5" ? Buffer.alloc(0) : Buffer.from(data),
    });
  }
  if (entries.length === 0) throw new Error("压缩包里没有文件");
  return entries;
}

/** 把条目写进 staging 目录；再次拒绝越界路径（防御性，不依赖解包时的检查）。 */
export function writeEntries(dir, entries) {
  const root = resolve(dir);
  for (const entry of entries) {
    const target = resolve(root, entry.path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`拒绝写到目录之外：${entry.path}`);
    }
    if (entry.dir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    try {
      chmodSync(target, entry.mode & 0o777 || 0o644);
    } catch {
      /* Windows 上 chmod 基本无效，忽略 */
    }
  }
}

// ─────────────────────── 差异分类 ───────────────────────

function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".DS_Store") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, base, out);
    else if (st.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/**
 * 比对旧目录与新目录（按文件内容哈希），并回答两个问题：
 *   · 要不要重启宿主？只由 `lib/` 变化决定 —— 每版的 package.json 版本号都会变，
 *     但那只是元数据，不需要为它重启；
 *   · 要不要重载界面？只有当 **client 变了而 lib 没变** 时，才够用。
 * 其余变化（package.json 的版本号、scripts/、sidecar/ 源码、文档）不需要重启，
 * 也不影响正在跑的代码。
 */
export function collectChanges(oldDir, newDir) {
  const before = new Map(walkFiles(oldDir).map((f) => [f, sha256File(join(oldDir, f))]));
  const after = new Map(walkFiles(newDir).map((f) => [f, sha256File(join(newDir, f))]));
  const changed = [];
  for (const [file, hash] of after) {
    if (before.get(file) !== hash) changed.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push(file);
  }
  changed.sort();
  const isClient = (f) => f === "client" || f.startsWith("client/");
  const isHost = (f) => f === "lib" || f.startsWith("lib/");
  const clientChanged = changed.some(isClient);
  const hostChanged = changed.some(isHost);
  const pkgChanged = changed.includes("package.json");
  const otherChanged = changed.some((f) => !isClient(f) && !isHost(f) && f !== "package.json");
  return {
    changed,
    client: clientChanged,
    host: hostChanged,
    packageJson: pkgChanged,
    other: otherChanged,
    // 只改了版本号（既没动 lib 也没动 client）时也建议重启：进程里的 VERSION
    // 是启动常量，不重启的话界面会一直显示旧版本号（"装了却没生效"的观感）。
    restartRequired: hostChanged || (!hostChanged && !clientChanged && pkgChanged),
    reloadRequired: !hostChanged && clientChanged,
  };
}

// ─────────────────────── 下载 ───────────────────────

/** 取某个版本的 metadata（tarball + integrity），官方源优先、镜像兜底。 */
export async function fetchVersionMeta({
  version,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  bases = REGISTRY_BASES,
} = {}) {
  const failures = [];
  if (typeof fetchImpl !== "function") return { ok: false, error: "当前环境没有 fetch，无法下载", failures };
  const wanted = String(version ?? "").trim();
  if (!parseVersion(wanted)) return { ok: false, error: `版本号不合法：${wanted}`, failures };
  for (const base of bases) {
    const url = `${base}/${PACKAGE_NAME}/${wanted}`;
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: timeoutSignal(timeoutMs),
      });
      if (!res || res.ok !== true) {
        failures.push(`${hostOf(url)} HTTP ${res ? res.status : "无响应"}`);
        continue;
      }
      const meta = await res.json();
      const gotVersion = String(meta?.version ?? "").trim();
      const tarball = String(meta?.dist?.tarball ?? "").trim();
      const integrity = String(meta?.dist?.integrity ?? "").trim();
      if (gotVersion !== wanted) {
        failures.push(`${hostOf(url)} 返回 ${gotVersion || "空版本"}，不是 ${wanted}`);
        continue;
      }
      if (!tarball) {
        failures.push(`${hostOf(url)} 没有 dist.tarball`);
        continue;
      }
      if (!parseIntegrity(integrity)) {
        failures.push(`${hostOf(url)} 没有可用的 dist.integrity`);
        continue;
      }
      return { ok: true, version: wanted, tarball, integrity, source: base };
    } catch (err) {
      failures.push(`${hostOf(url)} ${errText(err, timeoutMs)}`);
    }
  }
  return {
    ok: false,
    failures,
    error: failures.length ? `取版本信息失败：${failures.join("；")}` : "没有可用的版本源",
  };
}

/** 下载并校验；校验不过一律丢弃，绝不返回"可疑但能用"的包。 */
export async function downloadTarball({
  tarball,
  integrity,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60000,
  maxBytes = MAX_TARBALL_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") return { ok: false, error: "当前环境没有 fetch，无法下载" };
  let res;
  try {
    res = await fetchImpl(tarball, {
      headers: { accept: "application/octet-stream" },
      signal: timeoutSignal(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: `下载失败：${errText(err, timeoutMs)}` };
  }
  if (!res || res.ok !== true) return { ok: false, error: `下载失败：HTTP ${res ? res.status : "无响应"}` };
  const declared = Number(res.headers?.get?.("content-length") ?? 0);
  if (declared > maxBytes) return { ok: false, error: `包太大（${declared} 字节），拒绝下载` };
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) return { ok: false, error: `包太大（${buffer.length} 字节），拒绝安装` };
  if (!verifyBuffer(buffer, integrity)) {
    return { ok: false, error: "sha512 校验失败：下载内容与 registry 记录不一致，已丢弃" };
  }
  return { ok: true, buffer };
}

// ─────────────────────── 安装 ───────────────────────

/** 默认的可加载检查：真的 import 一次入口。失败信息原样带出。 */
export async function defaultCheckLoadable(entryFile) {
  const url = `${pathToFileURL(entryFile).href}?mesh-upgrade=${Date.now()}`;
  const mod = await import(url);
  if (typeof mod?.apply !== "function") return { ok: false, error: "入口没有导出 apply()，不是可用的插件包" };
  return { ok: true, exports: Object.keys(mod).sort() };
}

/** 只保留最近 N 份本工具创建的备份，避免 node_modules 里越堆越多。 */
export function pruneBackups(parentDir, keep = 3) {
  let names;
  try {
    names = readdirSync(parentDir).filter((n) => n.startsWith(BACKUP_PREFIX)).sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(parentDir, name), { recursive: true, force: true });
  }
}

export function readUpgradeMarker(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

export function writeUpgradeMarker(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function clearUpgradeMarker(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    /* 清不掉不影响功能，下一次判断会重新覆盖 */
  }
}

/**
 * 真正的升级流程。所有输入显式传入（测试可以给假 fetch、临时目录、假可加载检查）。
 *
 * 返回 `{ok:false, error, stage}` 时**旧版一定还在原地**；只有 `ok:true && installed`
 * 才代表磁盘已经换成新版本（此时进程仍在跑旧代码，是否重启由调用方决定）。
 */
export async function installUpdate({
  version,
  current = "",
  pluginDir,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  checkLoadable = defaultCheckLoadable,
  markerPath = "",
  log = () => {},
} = {}) {
  const target = String(version ?? "").trim();
  const dir = String(pluginDir ?? "").trim();
  if (!dir) return { ok: false, error: "不知道插件的安装目录", stage: "input" };
  if (!parseVersion(target)) return { ok: false, error: `目标版本号不合法：${target}`, stage: "input" };
  if (current) {
    const cmp = compareVersions(target, current);
    if (cmp !== 1) {
      return {
        ok: false,
        error: `目标版本 v${target} 不比当前 v${current} 新，拒绝覆盖`,
        stage: "input",
      };
    }
  }
  if (!existsSync(join(dir, "package.json"))) {
    return { ok: false, error: `安装目录里没有 package.json：${dir}`, stage: "input" };
  }

  const started = Date.now();
  const meta = await fetchVersionMeta({ version: target, fetchImpl });
  if (!meta.ok) return { ok: false, error: meta.error, failures: meta.failures, stage: "meta" };
  const dl = await downloadTarball({ tarball: meta.tarball, integrity: meta.integrity, fetchImpl });
  if (!dl.ok) return { ok: false, error: dl.error, stage: "download" };

  let entries;
  try {
    entries = extractTarball(dl.buffer, { stripComponents: 1 });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), stage: "extract" };
  }

  const parent = dirname(dir);
  const staging = join(parent, `${STAGING_PREFIX}${target}-${now}`);
  const cleanupStaging = () => rmSync(staging, { recursive: true, force: true });
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeEntries(staging, entries);
  } catch (err) {
    cleanupStaging();
    return { ok: false, error: `解包失败：${err?.message ?? err}`, stage: "extract" };
  }

  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
  } catch {
    /* 下面统一报错 */
  }
  if (pkg?.name !== PACKAGE_NAME || String(pkg?.version ?? "") !== target) {
    cleanupStaging();
    return {
      ok: false,
      error: `新包身份不符：${String(pkg?.name ?? "缺 package.json")}@${String(pkg?.version ?? "?")}`,
      stage: "validate",
    };
  }

  const changed = collectChanges(dir, staging);
  if (changed.changed.length === 0) {
    cleanupStaging();
    return {
      ok: true,
      installed: false,
      upToDate: true,
      version: target,
      source: meta.source,
      changed,
      restartRequired: false,
      reloadRequired: false,
      durationMs: Date.now() - started,
    };
  }

  let load;
  try {
    load = await checkLoadable(join(staging, "lib", "index.js"));
  } catch (err) {
    load = { ok: false, error: String(err?.message ?? err) };
  }
  if (!load?.ok) {
    cleanupStaging();
    return {
      ok: false,
      error: `新版本不可加载，已保留旧版：${load?.error ?? "未知原因"}`,
      stage: "loadable",
      changed,
    };
  }

  const backup = join(parent, `${BACKUP_PREFIX}${String(current || "old")}-${now}`);
  try {
    renameSync(dir, backup);
  } catch (err) {
    cleanupStaging();
    return { ok: false, error: `无法备份旧版：${err?.message ?? err}`, stage: "swap" };
  }
  try {
    renameSync(staging, dir);
  } catch (err) {
    try {
      renameSync(backup, dir);
    } catch {
      /* 回滚也失败：保留 backup 路径，让人能手工救 */
    }
    cleanupStaging();
    return {
      ok: false,
      error: `替换失败，已尝试回滚：${err?.message ?? err}`,
      stage: "swap",
      rolledBack: true,
      backupDir: backup,
    };
  }
  pruneBackups(parent, 3);
  log(`升级完成：v${current || "?"} → v${target}（备份 ${backup}）`);
  const result = {
    ok: true,
    installed: true,
    version: target,
    previous: current,
    source: meta.source,
    registry: meta.source,
    integrity: meta.integrity,
    backupDir: backup,
    changed,
    restartRequired: changed.restartRequired,
    reloadRequired: changed.reloadRequired,
    durationMs: Date.now() - started,
  };
  if (markerPath) {
    writeUpgradeMarker(markerPath, {
      version: target,
      previous: current,
      at: new Date(now).toISOString(),
      restartRequired: changed.restartRequired,
      reloadRequired: changed.reloadRequired,
      changed: changed.changed,
    });
  }
  return result;
}

// ─────────────────────── 控制请求守卫 / 重启 ───────────────────────

/**
 * 进程控制类接口只接受「同源回环」请求。和 dshmarket 的守卫同一套判断：
 * 回环 peer + 没有转发头 + Origin 与 Host 一致 —— 防止局域网页面或代理
 * 借用户的浏览器点一下就把宿主重启了。
 */
export function trustedControlRequest(req) {
  const address = req?.socket?.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const headers = req?.headers;
  if (!headers) return false;
  if (headers.forwarded !== undefined || headers["x-forwarded-for"] !== undefined || headers["x-real-ip"] !== undefined) {
    return false;
  }
  const origin = headers.origin;
  const host = headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}

/**
 * 用宿主自己的重启入口，而不是 shell 脚本。
 *
 * DSH Desktop 提供 `desktopSettingsController.restart()`：原生确认框 + 有序
 * relaunch（和切换 profile 同一条路），不需要 osascript/launchctl，也就没有
 * "重启循环"那一类风险。返回值里的 `afterResponse` 约定由路由层在响应结束后
 * 调用，插件直接调用时要自己触发。
 */
/**
 * 重载渲染器（只改了 client 时用）。
 *
 * DSH Desktop 提供 `desktopSettingsController.reloadRenderer()`：和「设置 → 开发者
 * 选项 → 重新加载界面」同一个动作，由 Electron 替换当前文档（同时绕开缓存），
 * 比页面自己 `location.reload()` 更可靠。没有这个入口的宿主（dsh web/headless）
 * 返回 mode:"self"，由调用方退到页面自身重载 —— 客户端半的更新不需要重启宿主。
 */
export function requestHostReload(ctx) {
  let controller = null;
  try {
    controller = ctx?.get?.("desktopSettingsController") ?? null;
  } catch {
    controller = null;
  }
  if (controller && typeof controller.reloadRenderer === "function") {
    try {
      const result = controller.reloadRenderer();
      if (result && typeof result.afterResponse === "function") result.afterResponse();
      return { ok: true, mode: "desktop" };
    } catch (err) {
      return { ok: false, mode: "desktop", error: `内置重载入口调用失败：${err?.message ?? err}` };
    }
  }
  return { ok: false, mode: "self", error: "当前宿主没有内置重载入口，改用页面自身重载" };
}

export async function requestHostRestart(ctx, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  let controller = null;
  try {
    controller = ctx?.get?.("desktopSettingsController") ?? null;
  } catch {
    controller = null;
  }
  if (controller && typeof controller.restart === "function") {
    try {
      const result = controller.restart();
      if (result && typeof result.afterResponse === "function") result.afterResponse();
      return { ok: true, mode: "desktop" };
    } catch (err) {
      return { ok: false, mode: "desktop", error: `宿主重启入口调用失败：${err?.message ?? err}` };
    }
  }

  // 没有桌面控制器（dsh web / headless / CLI）时，退到 dshmarket 的自重启：
  // 它用相同启动参数 detach 重开，并自己做 supervisor 检测与端口等待。
  // 我们自己不去 spawn：那是最容易写出"重启循环"的地方。
  const port = Number(ctx?.webServer?.port) || 0;
  if (port > 0 && typeof fetchImpl === "function") {
    const origin = `http://127.0.0.1:${port}`;
    try {
      const res = await fetchImpl(`${origin}/dsh-market/api/v1/restart`, {
        method: "POST",
        // 市场的守卫按「同源回环」判：Host 与 Origin 必须一致，且不能带转发头。
        headers: { origin, host: `127.0.0.1:${port}`, "content-type": "application/json", accept: "application/json" },
        body: "{}",
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (res && res.ok === true) return { ok: true, mode: "market" };
      let detail = "";
      try {
        detail = String(await res.text()).slice(0, 300);
      } catch {
        /* 读不出原因就只报状态码 */
      }
      return {
        ok: false,
        mode: "manual",
        error: `没有桌面重启入口，市场自重启也不可用（HTTP ${res ? res.status : "无响应"}${detail ? `：${detail}` : ""}）。请手动重启 DSH。`,
      };
    } catch (err) {
      return {
        ok: false,
        mode: "manual",
        error: `没有桌面重启入口，市场自重启也没成功（${err?.message ?? err}）。请手动重启 DSH。`,
      };
    }
  }

  return {
    ok: false,
    mode: "manual",
    error: "当前宿主没有内置重启入口（不是 DSH Desktop，也没装市场）。请手动重启 DSH 使新版本生效。",
  };
}
