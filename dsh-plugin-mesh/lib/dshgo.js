/**
 * dsh-go（Android App + proot Ubuntu）环境探测。
 *
 * 为什么需要它：dsh-go 里 Node 跑在 **proot 的 Ubuntu** 下，`process.platform` 是
 * `linux`、`os.release()` 是 Android 内核串。插件里所有"Android 专项"（平台身份、
 * 沙箱/审批、tsnet 资产风味、机型信息）都不能靠 `process.platform === "android"`
 * 判断 —— 那条分支在 dsh-go 里永远不触发。这里把"我们到底在什么环境里"收敛成
 * 一个带证据的探测结果。
 *
 * 判定信号（真机已实测，见 analysis/GAP-ANALYSIS.md 与 DSHGO-BRIDGE-INTEGRATION.md）：
 *
 *   · `DSH_GO_RUNTIME_ROOT` 环境变量 —— App 某版本会设；真机上**不存在**，
 *     所以只能当"强证据之一"，不能当唯一判据。
 *   · `/opt/dsh-go/`（bridge + direct 运行时）、`/etc/dsh-app/`（App 的 patch/配置）
 *     —— 这两个是 dsh-go rootfs 的包装层标记。
 *   · `/system/build.prop` 存在 —— proot 把宿主 Android 的 `/system` 挂进来了。
 *   · `os.release()` 含 `android` —— Android 内核串。
 *   · `/system/bin/getprop` 存在 —— 真机 PATH 里**没有** getprop，必须用绝对路径。
 *   · `/dev/__properties__` 存在 —— bionic 属性服务的后端（也是 tailscale
 *     androidbin 的 `onAndroid()` 判据）。
 *
 * 结论语义：
 *   · `wrapper=true`（/opt/dsh-go 或 /etc/dsh-app 或环境变量）= 明确是 dsh-go 包装；
 *   · 没有包装标记、但"Android 内核 + /system 已挂载"= Android 上的其它 Node
 *     proot/Termux 类环境（同样没有 Java 沙箱、同样需要 Android 身份）；
 *   · `isDshGo = wrapper || (androidKernel && systemMounted)` —— 两类都按 dsh-go
 *     类环境对待，因为后续消费方（权限默认值、tsnet 资产、平台身份）要的是
 *     "在 Android 内核上跑、没有桌面沙箱"这个事实。
 *
 * 约束：
 *   · **任何探测都不抛**（这里是启动路径，抛一次就是插件加载失败）；
 *   · 只读、不执行耗时命令；进程内缓存一次（环境在进程生命周期内不变）。
 */
import os from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

/** dsh-go rootfs 的包装层标记。 */
const DSH_GO_DIR = "/opt/dsh-go";
const DSH_APP_DIR = "/etc/dsh-app";
/** 宿主 Android 的挂载点（proot -b /system）。 */
const BUILD_PROP = "/system/build.prop";
/** 真机 PATH 里没有 getprop，必须走绝对路径。 */
const GETPROP_BIN = "/system/bin/getprop";
/** 属性服务后端：tailscale androidbin 也用它判 Android。 */
const PROPS_DIR = "/dev/__properties__";

/** 单条 getprop 的超时（只是读属性，正常毫秒级）。 */
const GETPROP_TIMEOUT_MS = 1500;

/** 探测结果的兜底形状（探测异常时用它，绝不抛）。 */
const FALLBACK = Object.freeze({
  isDshGo: false,
  runtime: "",
  wrapper: false,
  androidKernel: false,
  systemMounted: false,
  deviceModel: "",
  androidVersion: "",
  evidence: [],
});

/** 进程内缓存（含自测注入）。 */
let cached;
/** 自测注入：非 null 时 `dshGoInfo()` 直接返回它。 */
let forced = null;
/** 自测注入：Android 属性表；非 null 时 `androidProp()` 只查它。 */
let propOverride = null;
/** `/system/build.prop` 解析缓存。 */
let buildPropsCache;

function safe(fn, fallback = false) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function isFile(path) {
  return safe(() => statSync(path).isFile(), false);
}

function isExecutableFile(path) {
  return safe(() => {
    const st = statSync(path);
    if (!st.isFile()) return false;
    // Android 上的可执行位是 0755；proot 里 stat 会给出解释后的 mode。
    // Windows（开发机）没有 mode 语义，只要文件存在就算 —— 它不参与判定主结论。
    return (st.mode & 0o111) !== 0 || process.platform === "win32";
  }, false);
}

/** 解析 build.prop（`key=value`，跳过注释/空行）。 */
function parseBuildProps(text) {
  const map = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const idx = s.indexOf("=");
    if (idx <= 0) continue;
    const key = s.slice(0, idx).trim();
    let value = s.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) map.set(key, value);
  }
  return map;
}

function buildProps() {
  if (buildPropsCache === undefined) {
    buildPropsCache = new Map();
    try {
      buildPropsCache = parseBuildProps(readFileSync(BUILD_PROP, "utf8"));
    } catch {
      /* 读不到就退回 getprop（下面按需） */
    }
  }
  return buildPropsCache;
}

/**
 * 读一条 Android 系统属性（`ro.product.model` 之类）。
 *
 * 顺序：build.prop（纯文件读，不 exec）→ `/system/bin/getprop`（绝对路径）。
 * **绝不抛**；拿不到返回空串。
 */
export function androidProp(key) {
  const k = String(key ?? "").trim();
  if (!k) return "";
  if (propOverride) return String(propOverride[k] ?? "");
  try {
    const fromFile = buildProps().get(k);
    if (fromFile) return fromFile;
  } catch {
    /* 读文件失败，继续试 getprop */
  }
  try {
    const out = execFileSync(GETPROP_BIN, [k], {
      encoding: "utf8",
      timeout: GETPROP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    if (out) {
      try {
        buildProps().set(k, out);
      } catch {
        /* 缓存失败无所谓 */
      }
      return out;
    }
  } catch {
    /* 没有 getprop / 属性不存在：返回空串 */
  }
  return "";
}

/** 从注入的 props 或系统属性里取值（detectDshGo 用；测试可注入）。 */
function pickProp(key, props) {
  if (props && typeof props === "object") return String(props[key] ?? "");
  return androidProp(key);
}

/**
 * 探测 dsh-go/Android proot 环境。**不抛**，所有依赖可注入（离线单测用）。
 *
 * @param {object} [opts]
 * @param {object} [opts.deps] { env, release, exists, isFile, isExecutable, props }
 * @returns {{isDshGo: boolean, runtime: string, wrapper: boolean, androidKernel: boolean,
 *   systemMounted: boolean, deviceModel: string, androidVersion: string, evidence: string[]}}
 */
export function detectDshGo(opts = {}) {
  const deps = {
    env: process.env,
    release: () => os.release(),
    exists: existsSync,
    isFile,
    isExecutable: isExecutableFile,
    props: null,
    ...(opts && typeof opts === "object" ? (opts.deps ?? {}) : {}),
  };
  const evidence = [];
  try {
    const env = deps.env && typeof deps.env === "object" ? deps.env : {};
    const release = String(safe(() => deps.release(), "") ?? "");

    const envRoot = String(env.DSH_GO_RUNTIME_ROOT ?? "").trim();
    if (envRoot) evidence.push("env:DSH_GO_RUNTIME_ROOT");
    const hasGoDir = safe(() => deps.exists(DSH_GO_DIR), false) === true;
    if (hasGoDir) evidence.push(`dir:${DSH_GO_DIR}`);
    const hasAppDir = safe(() => deps.exists(DSH_APP_DIR), false) === true;
    if (hasAppDir) evidence.push(`dir:${DSH_APP_DIR}`);

    const androidKernel = /android/i.test(release);
    if (androidKernel) evidence.push(`kernel:${release.slice(0, 40)}`);

    const systemMounted = safe(() => deps.exists(BUILD_PROP), false) === true || safe(() => deps.isFile(BUILD_PROP), false) === true;
    if (systemMounted) evidence.push(`file:${BUILD_PROP}`);

    const hasGetprop = safe(() => deps.isExecutable(GETPROP_BIN), false) === true;
    if (hasGetprop) evidence.push(`bin:${GETPROP_BIN}`);
    const hasPropsDir = safe(() => deps.exists(PROPS_DIR), false) === true;
    if (hasPropsDir) evidence.push(`dev:${PROPS_DIR}`);

    const wrapper = !!envRoot || hasGoDir || hasAppDir;
    const isDshGo = wrapper || (androidKernel && systemMounted);
    const runtime = isDshGo ? "proot" : "";
    let deviceModel = "";
    let androidVersion = "";
    if (isDshGo) {
      deviceModel = pickProp("ro.product.model", deps.props) || pickProp("ro.product.brand", deps.props);
      androidVersion = pickProp("ro.build.version.release", deps.props);
    }
    return {
      isDshGo,
      runtime,
      wrapper,
      androidKernel,
      systemMounted,
      deviceModel: String(deviceModel ?? "").trim().slice(0, 64),
      androidVersion: String(androidVersion ?? "").trim().slice(0, 24),
      evidence: evidence.slice(0, 8),
    };
  } catch {
    /* 探测本身异常也只是一条空结论，绝不影响插件启动 */
    return { ...FALLBACK, evidence: evidence.slice(0, 8) };
  }
}

/**
 * 进程内缓存的探测结果（env 级：判据在进程生命周期内不会变）。
 * 首次调用后固定；`__resetDshGoCacheForTest()` 可清。
 */
export function dshGoInfo() {
  if (forced) return forced;
  if (cached === undefined) {
    try {
      cached = detectDshGo();
    } catch {
      cached = FALLBACK;
    }
  }
  return cached;
}

/** 是否运行在 dsh-go/Android proot 类环境（供权限/资产/osInfo 判断）。 */
export function isDshGo() {
  try {
    return dshGoInfo().isDshGo === true;
  } catch {
    return false;
  }
}

/** 诊断用摘要（健康检查/日志；不含路径探针细节以外的敏感信息）。 */
export function dshGoSummary() {
  try {
    const info = dshGoInfo();
    return {
      isDshGo: info.isDshGo === true,
      runtime: String(info.runtime ?? ""),
      wrapper: info.wrapper === true,
      androidKernel: info.androidKernel === true,
      deviceModel: String(info.deviceModel ?? ""),
      androidVersion: String(info.androidVersion ?? ""),
      evidence: Array.isArray(info.evidence) ? info.evidence.slice(0, 8) : [],
    };
  } catch {
    return { isDshGo: false, runtime: "", wrapper: false, androidKernel: false, deviceModel: "", androidVersion: "", evidence: [] };
  }
}

/** 只为自测：注入探测结果（null = 恢复真实探测）。 */
export function __setDshGoForTest(facts) {
  forced = facts ? { ...FALLBACK, ...facts } : null;
}

/** 只为自测：注入 Android 属性（null = 恢复真实读取）。 */
export function __setAndroidPropsForTest(props) {
  propOverride = props && typeof props === "object" ? { ...props } : null;
}

/** 只为自测：清空缓存（探测结果、属性、build.prop 解析）。 */
export function __resetDshGoCacheForTest() {
  cached = undefined;
  forced = null;
  propOverride = null;
  buildPropsCache = undefined;
}
