/**
 * 设备身份：**持久 UUID 当身份，OS 机器 ID 当"认领指纹"**。
 *
 * 为什么分成两层（而不是直接用 MAC 当身份）：
 *
 *   1. 多网卡 —— 一台笔记本同时有 Wi-Fi / 有线 / Thunderbolt 网桥 / VPN 的
 *      utun。换网（Wi-Fi → 插网线）MAC 就变，身份跟着变，对端会认为这是一台
 *      **新设备**，于是重新出现"重名"。实测这台机器有 4 个网卡，切换随时发生。
 *   2. 随机 MAC 已是默认 —— iOS / Android / macOS 现在默认**按 SSID** 使用随机
 *      MAC。手机在公司与家里会是两个身份。
 *   3. Android 拿不到稳定 ID —— ANDROID_ID 在 Android 8+ 按"应用签名 + 用户"
 *      隔离，重装即变；Termux 的纯 shell 环境也读不到它。
 *   4. 隐私 —— MAC 是硬件标识。用它当身份会把"在组播里广播硬件 ID"从展示字段
 *      升级成架构必需。
 *
 * 所以：**身份用持久 UUID**（存在 state.json，见 index.js 的 resolveInstanceId），
 * **指纹只用来认领**——当某个 instanceId 变了、但指纹是我们认识的，就说明
 * "同一台物理机、state.json 丢了/插件重装了"，于是用新记录立刻顶掉旧记录，
 * 而不是把它当成第二台设备。
 *
 * 指纹经过 sha256 截断后才上网：不可逆推硬件 ID，但代价是**同一台设备在不同
 * 网络里可被关联**（见设计文档"遗留问题"）。这是为了让认领机制能工作必须付的
 * 代价——指纹必须在所有设备上对同一台物理机算出同一个值，所以不能加盐。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** 采集子进程的超时；这些命令都该秒回，卡住说明环境异常，不值得等。 */
const CMD_TIMEOUT_MS = 3000;

/** 跑一条命令拿 stdout；失败/超时/非零退出都返回空串。 */
function tryExec(cmd, args = []) {
  try {
    return String(
      execFileSync(cmd, args, { encoding: "utf8", timeout: CMD_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }),
    ).trim();
  } catch {
    return "";
  }
}

/** 读一个文件并 trim；失败返回空串。 */
function tryRead(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * 采集"这台物理机"的原始标识。
 * 返回值是**平台相关、可能为空**的字符串；空表示采集不到（不影响功能）。
 */
export function rawMachineId() {
  const p = process.platform;

  if (p === "darwin") {
    // IOPlatformUUID：主板级 UUID，与网卡无关，重装系统前不变
    const out = tryExec("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
    if (m) return m[1];
    return "";
  }

  if (p === "win32") {
    // MachineGuid：Windows 安装时生成，与网卡无关
    const out = tryExec("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
    if (m) return m[1];
    return "";
  }

  if (p === "android") {
    // Termux 下没有可靠的稳定 ID：
    //   · Settings.Secure.ANDROID_ID 是 Java API，shell 拿不到；且 Android 8+
    //     按"应用签名 + 用户"隔离，重装即变
    //   · ro.serialno 在多数新机型上被限制/为空
    // 所以尽力试几个，全都拿不到就返回空 —— **退化成纯 UUID，不影响功能**。
    for (const [cmd, args] of [
      ["getprop", ["ro.serialno"]],
      ["getprop", ["ro.boot.serialno"]],
      ["getprop", ["net.hostname"]],
    ]) {
      const v = tryExec(cmd, args);
      if (v && v !== "unknown") return `android:${v}`;
    }
    return "";
  }

  // linux 及其它 unix：machine-id 是安装时生成、换网卡不变的
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const v = tryRead(f);
    if (v) return `linux:${v}`;
  }
  // 兜底：DMI 产品 UUID（多数 x86 机器有；容器里通常没有）
  const dmi = tryRead("/sys/class/dmi/id/product_uuid");
  if (dmi) return `dmi:${dmi}`;
  return "";
}

let cached = null;

/**
 * 认领指纹：对原始标识做 sha256 后截断成 16 位 hex。
 *
 * 截断的目的是**不把硬件 ID 原样播到网上**；代价是同一台机器在不同网络里
 * 可被关联（因为不能加盐，否则各设备算出来不一致，认领机制就失效了）。
 *
 * @returns 16 位 hex；采集不到时返回空串（调用方必须容忍空值）
 */
export function machineFingerprint() {
  if (cached !== null) return cached;
  const raw = rawMachineId();
  cached = raw ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : "";
  return cached;
}

/**
 * 判断两条记录是否是"同一台物理机换了 instanceId"。
 *
 * 只有当**双方指纹都非空且相等**、同时 instanceId 不同时才成立。
 * 空指纹绝不参与判断 —— 否则所有采集不到指纹的设备会互相认领，变成一团乱。
 */
export function isSameMachineOtherInstance(a, b) {
  if (!a || !b) return false;
  const fa = String(a.fingerprint ?? "");
  const fb = String(b.fingerprint ?? "");
  if (!fa || !fb || fa !== fb) return false;
  return String(a.id ?? "") !== String(b.id ?? "");
}

export const __resetFingerprintCache = () => {
  cached = null;
};
