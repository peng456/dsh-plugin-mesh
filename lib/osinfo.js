/**
 * 设备系统身份（osInfo / systems）：平台、展示名、版本、发行版、内核、桌面环境、架构。
 *
 * 三层数据：
 *   · osInfo     —— 宿主机（老 UI / 老对端只认这一份）
 *   · systems[]  —— 这台机器上可用的系统列表：宿主机 + WSL 发行版（Windows）
 *   · capabilities —— 运行时环境（node/python/...），仍走原来的能力名片
 *
 * 为什么单独一个模块：
 *   · 探测有平台分支（sw_vers / /etc/os-release / 注册表 / getprop），散在 discovery 里很难测；
 *   · 结果在进程生命周期内不变，探测一次即可 —— 心跳每 5s 一次，不能每条都跑子进程；
 *   · 对端名片是网络输入，接收侧必须清洗（sanitizeOsInfo / sanitizeSystems）。
 *
 * WSL 只读注册表，不启动已停止的发行版：要的是"这台机器上有哪些系统"，不是把它们
 * 一个个拉起来（那会有几十秒副作用）。运行中的发行版才尝试读 /etc/os-release 补版本。
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
const KINDS = new Set(["host", "wsl", "vm", "container"]);
/** 一台机器的名片最多列几个系统（宿主机 + 3 个额外环境），避免名片无限膨胀。 */
const MAX_SYSTEMS = 4;
/** Docker/Rancher/Podman 的 WSL 发行版不是用户系统，不列。 */
const NON_USER_WSL = /^(docker-desktop|rancher-desktop|podman-machine)/i;
const WSL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";

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

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * 探测宿主机系统身份。所有参数都可注入，方便在非目标平台上用 fixture 单测。
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
  const run = opts.run ?? defaultRun;

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
 * 清洗对端名片里的单个系统。
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

/** 解析 `reg query ...\Lxss /s` 的输出，每个 `{guid}` 块一条记录。 */
function parseWslRegistry(text) {
  const blocks = [];
  let cur = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^HKEY_/i.test(line)) {
      if (cur) blocks.push(cur);
      cur = {};
      continue;
    }
    const m = /^(\w+)\s+REG_(?:SZ|DWORD|EXPAND_SZ)\s+(.+)$/i.exec(line);
    if (m && cur) cur[m[1]] = m[2].trim();
  }
  if (cur) blocks.push(cur);
  return blocks.filter((b) => b && b.DistributionName);
}

/**
 * 运行中的 WSL 发行版，尝试从 9p 挂载读 /etc/os-release 补版本。
 * 停着的发行版不碰（不启动它）；读不到就只报注册表里的名字。
 */
function readWslOsRelease(name, readFile) {
  for (const root of ["\\\\wsl.localhost\\", "\\\\wsl$\\"]) {
    try {
      const rel = parseOsRelease(readFile(`${root}${name}\\etc\\os-release`));
      if (rel.NAME || rel.ID) return rel;
    } catch {
      /* 没运行 / 9p 不可访问 */
    }
  }
  return null;
}

/**
 * 从注册表列 WSL 发行版（只读，不启动任何发行版）。
 * 运行时探测也用它判断哪些发行版处于 running 状态。
 */
export function wslTargets(opts = {}) {
  const run = opts.run ?? defaultRun;
  let text;
  try {
    text = run("reg", ["query", WSL_KEY, "/s"]);
  } catch {
    return [];
  }

  const out = [];
  for (const block of parseWslRegistry(text)) {
    const name = String(block.DistributionName ?? "").trim();
    if (!name || NON_USER_WSL.test(name)) continue;
    out.push({
      name,
      running: parseInt(String(block.State ?? ""), 0) === 1,
      osVersion: String(block.OsVersion ?? "").trim(),
      flavor: String(block.Flavor ?? "").trim().toLowerCase(),
    });
    if (out.length >= MAX_SYSTEMS - 1) break;
  }
  return out;
}

/** 把注册表目标变成 systems[] 里的条目（运行中的才补 os-release 版本）。 */
function detectWsl(opts = {}) {
  const readFile = opts.readFile ?? ((path) => readFileSync(path, "utf8"));
  const out = [];
  for (const target of wslTargets(opts)) {
    let name = target.name;
    let version = target.osVersion;
    let distro = target.flavor;

    if ((!version || !distro) && target.running) {
      const rel = readWslOsRelease(target.name, readFile);
      if (rel) {
        name = clean(rel.NAME || name, FIELD_MAX.name);
        version = version || clean(rel.VERSION_ID || "", FIELD_MAX.version);
        distro = distro || clean(rel.ID || "", FIELD_MAX.distro).toLowerCase();
      }
    }

    out.push({
      kind: "wsl",
      platform: "linux",
      name: clean(name, FIELD_MAX.name),
      version: clean(version, FIELD_MAX.version),
      distro: clean(distro, FIELD_MAX.distro),
      // WSL 的 kernel/desktop/arch 不启动发行版拿不到，留空比瞎猜好。
      kernel: "",
      desktop: "",
      arch: "",
    });
  }
  return out;
}

/** 本机系统列表：宿主机第一，后面是 WSL 等额外环境。 */
export function detectSystems(opts = {}) {
  const host = detectOsInfo(opts);
  const platform = String(opts.platform ?? process.platform);
  const extra = platform === "win32" ? detectWsl(opts) : [];
  return sanitizeSystems([{ kind: "host", ...host }, ...extra]) ?? [];
}

/**
 * 清洗对端名片里的 systems[]：逐项复用 sanitizeOsInfo，kind 走白名单，
 * 去重、最多 MAX_SYSTEMS 项，宿主机排第一。
 */
export function sanitizeSystems(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const info = sanitizeOsInfo(item);
    if (!info) continue;
    const kindRaw = String(item?.kind ?? "").toLowerCase();
    const kind = KINDS.has(kindRaw) ? kindRaw : "";
    const key = `${kind}|${info.platform}|${info.name}|${info.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, ...info });
    if (out.length >= MAX_SYSTEMS * 2) break;
  }
  if (out.length === 0) return null;
  // 宿主机排第一；其余保持到达顺序（stable sort）。
  out.sort((a, b) => (a.kind === "host" ? 0 : 1) - (b.kind === "host" ? 0 : 1));
  return out.slice(0, MAX_SYSTEMS);
}

let cached;
let cachedSystems;

/** 宿主机系统身份，进程内只探测一次。 */
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

/** 本机系统列表（宿主机 + WSL），进程内只探测一次。 */
export function systems() {
  if (cachedSystems === undefined) {
    try {
      const host = osInfo();
      const extra = process.platform === "win32" ? detectWsl() : [];
      cachedSystems = sanitizeSystems(host ? [{ kind: "host", ...host }, ...extra] : extra);
    } catch {
      cachedSystems = null;
    }
  }
  return cachedSystems;
}

/** 只为自测：清掉缓存，避免 fixture 之间互相污染。 */
export function __resetOsInfoCache() {
  cached = undefined;
  cachedSystems = undefined;
}
