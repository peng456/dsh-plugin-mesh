/**
 * 设备系统身份（osInfo）：平台、展示名、版本、发行版、内核、桌面环境、架构。
 *
 * 为什么单独一个模块：
 *   · 探测有平台分支（sw_vers / /etc/os-release / getprop），散在 discovery 里会很难测；
 *   · 结果在进程生命周期内不变，探测一次即可 —— 心跳每 5s 一次，不能每条都跑子进程；
 *   · 对端名片是网络输入，接收侧必须清洗（sanitizeOsInfo），不能直接信。
 *
 * 这里的字段是**展示用**的：老对端只报 `os: "win32 10.0.26200"`，新对端多报一个
 * `osInfo` 对象；UI 没有 osInfo 时回退解析老字段，所以是纯增量协议。
 */
import os from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FIELD_MAX = {
  name: 48,
  version: 48,
  distro: 32,
  kernel: 64,
  desktop: 32,
  arch: 16,
};

const PLATFORMS = new Set(["win32", "darwin", "linux", "android"]);

/** 去控制字符、折叠空白、按字段截断。 */
function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 命令输出只取第一行（getprop / sw_vers 都可能带换行）。 */
function firstLine(value, max) {
  return clean(String(value ?? "").split("\n")[0], max);
}

/** 解析 /etc/os-release；引号可有可无，值里允许 `=`。 */
function parseOsRelease(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** XDG_CURRENT_DESKTOP 常是 "ubuntu:GNOME"，取最后一段。 */
function desktopEnv(env) {
  const raw = String(env?.XDG_CURRENT_DESKTOP || env?.DESKTOP_SESSION || "").trim();
  if (!raw) return "";
  const parts = raw.split(":").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * 探测本机系统身份。所有参数都可注入，方便在非目标平台上用 fixture 单测。
 *
 * 失败一律降级为空字段 / 平台通用名，**绝不抛**：名片的缺失不能拖垮启动，
 * 也不能把"没探到"伪装成某个具体结论。
 */
export function detectOsInfo(opts = {}) {
  const platformRaw = String(opts.platform ?? process.platform).toLowerCase();
  const platform = PLATFORMS.has(platformRaw) ? platformRaw : "";
  const release = clean(opts.release ?? os.release(), FIELD_MAX.kernel);
  const arch = clean(opts.arch ?? os.arch(), FIELD_MAX.arch);
  const env = opts.env ?? process.env;
  const osVersion =
    opts.osVersion ??
    (() => {
      try {
        return os.version();
      } catch {
        return "";
      }
    });
  const readFile = opts.readFile ?? ((path) => readFileSync(path, "utf8"));
  const run =
    opts.run ??
    ((cmd, args) =>
      execFileSync(cmd, args, {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim());

  let name = "";
  let version = "";
  let distro = "";
  let desktop = "";

  if (platformRaw === "win32") {
    // Node 13+ 的 os.version() 已经是 "Windows 11 Home China" 这类产品名。
    name = firstLine(osVersion(), FIELD_MAX.name) || "Windows";
    version = release;
  } else if (platformRaw === "darwin") {
    try {
      name = firstLine(run("sw_vers", ["-productName"]), FIELD_MAX.name);
    } catch {
      name = "";
    }
    try {
      version = firstLine(run("sw_vers", ["-productVersion"]), FIELD_MAX.version);
    } catch {
      version = "";
    }
    name = name || "macOS";
  } else if (platformRaw === "linux") {
    try {
      const rel = parseOsRelease(readFile("/etc/os-release"));
      name = clean(rel.NAME || rel.PRETTY_NAME || rel.ID || "Linux", FIELD_MAX.name);
      version = clean(rel.VERSION_ID || "", FIELD_MAX.version);
      distro = clean(rel.ID || "", FIELD_MAX.distro);
    } catch {
      name = "Linux";
    }
    desktop = clean(desktopEnv(env), FIELD_MAX.desktop);
  } else if (platformRaw === "android") {
    name = "Android";
    try {
      version = firstLine(run("getprop", ["ro.build.version.release"]), FIELD_MAX.version);
    } catch {
      version = "";
    }
  } else {
    // 未知平台（FreeBSD 等）至少给个可读名字；platform 留空让 UI 用回退徽章。
    name = clean(platformRaw, FIELD_MAX.name);
    version = release;
  }

  return sanitizeOsInfo({
    platform,
    name,
    version,
    distro,
    kernel: release,
    desktop,
    arch,
  });
}

/**
 * 清洗对端名片里的 osInfo。
 *
 * platform 走白名单（UI 的 logo 映射只认这四个）；文本字段控制字符剥掉并截断。
 * 返回 null 表示"对端没报 / 报的东西不可用"，UI 应回退到老的 os 字符串。
 */
export function sanitizeOsInfo(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const platform = PLATFORMS.has(String(raw.platform ?? "").toLowerCase())
    ? String(raw.platform).toLowerCase()
    : "";
  const out = {
    platform,
    name: clean(raw.name, FIELD_MAX.name),
    version: clean(raw.version, FIELD_MAX.version),
    distro: clean(raw.distro, FIELD_MAX.distro),
    kernel: clean(raw.kernel, FIELD_MAX.kernel),
    desktop: clean(raw.desktop, FIELD_MAX.desktop),
    arch: clean(raw.arch, FIELD_MAX.arch),
  };
  if (!out.platform && !out.name) return null;
  return out;
}

let cached;
/** 本机系统身份，进程内只探测一次。 */
export function osInfo() {
  if (cached === undefined) {
    try {
      cached = detectOsInfo();
    } catch {
      cached = null;
    }
  }
  return cached;
}

/** 只为自测：清掉缓存，避免 fixture 之间互相污染。 */
export function __resetOsInfoCache() {
  cached = undefined;
}
