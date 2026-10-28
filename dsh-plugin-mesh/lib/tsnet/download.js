/**
 * tsnet sidecar 二进制的获取与缓存。
 *
 * 设计要点：
 *
 * 1. **终端用户零依赖**：不需要装 Go，也不需要装 Tailscale 客户端。
 *    sidecar 由插件在首次启用自组网时按平台下载，解压后缓存到本地。
 *
 * 2. **校验和钉在插件源码里**（checksums.js），不是从同一个 release 拉
 *    checksums.txt —— 否则一个恶意镜像可以同时替换二进制和校验和文件，
 *    校验就成了摆设。钉在源码里，镜像就无法伪造。
 *
 * 3. **镜像优先**：实测本机直连 github.com 是断的（HTTP 000），而
 *    ghfast.top 等镜像 1 秒内就能拿到真内容。所以默认顺序是
 *    「配置的源 → 多个镜像 → 直连 GitHub」，任一成功即止。
 *
 * 4. **原子安装**：先写 .part 再 rename，避免半个文件被当成可用二进制。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { PINNED_CHECKSUMS } from "./checksums.js";
import { dshGoInfo } from "../dshgo.js";

/** Sidecar 控制协议版本；与 sidecar/main.go 的 ProtocolVersion 必须一致。 */
export const SIDECAR_PROTOCOL = 1;
const RELEASE_TAG = `sidecar-v${SIDECAR_PROTOCOL}`;
const REPO = "peng456/dsh-plugin-mesh";
const ASSET_BASE = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}`;

/**
 * GitHub release 的直连在国内基本不通（实测 HTTP 000），所以把镜像放在前面。
 * 每个镜像都是一个纯前缀转发：`<mirror>/<原始 GitHub URL>`。
 */
const MIRROR_PREFIXES = [
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://ghproxy.net/",
  "https://hk.gh-proxy.com/",
];

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 4000;
const IDLE_TIMEOUT_MS = 30000;

/**
 * `sidecarPlatform` 配置的生效值：`"linux" | "android"`（空 = auto）。
 * 由 index.js 的 apply 在启动时写入（`configureSidecarPlatform(config.sidecarPlatform)`）。
 */
let sidecarPlatformOverride = "";

/** 写入 `sidecarPlatform` 覆盖（auto/非法值 = 清空，走自动判断）。 */
export function configureSidecarPlatform(value) {
  const v = String(value ?? "").trim().toLowerCase();
  sidecarPlatformOverride = v === "linux" || v === "android" ? v : "";
}

/** 当前 sidecar 平台配置的生效值（`auto` 表示未覆盖）。 */
export function sidecarPlatformSettingValue() {
  return sidecarPlatformOverride || "auto";
}

/**
 * 解析"当前环境该用哪一族的 sidecar 资产"。
 *
 * 规则（P1-3）：
 *   1. `sidecarPlatform` 显式配置（linux/android）优先 —— 逃生通道，真机出问题
 *      时可以一键换风味，不用等发版；
 *   2. 否则 `platform === "linux"` 且探测到 dsh-go/Android proot → **android**：
 *      dsh-go 的 proot 里 `/system` 已挂载、`/dev/__properties__` 存在，所以
 *      tailscale androidbin 的 `onAndroid()` 为真、net.Interfaces 的回退会生效；
 *      而 linux 静态资产（GOOS=linux 全静态 ET_EXEC）会死在 `netns` 的
 *      controlC（它会读 `/proc/net/route`，Android app UID 上是 EACCES）；
 *   3. 其余保持原映射（darwin/windows/linux 桌面不变）。
 */
function resolveTargetOs(baseOs) {
  if (sidecarPlatformOverride) return sidecarPlatformOverride;
  if (baseOs === "linux") {
    try {
      if (dshGoInfo().isDshGo === true) return "android";
    } catch {
      /* 探测失败就用默认映射 */
    }
  }
  return baseOs;
}

/** 把 Node 的 platform/arch 映射成 sidecar 的资产命名。 */
export function detectTarget() {
  // Termux 下 os.platform() 返回的是 "android"，不是 "linux"（实测那台 Android 的
  // 自述记录是 `os: 'android 5.10.43'`）。
  //
  // android **不能**再映射到 linux 资产了：两者需要的 ELF 形态不同。Android 从
  // 5.0 起只允许 PIE(ET_DYN)，而给桌面准备的是全静态 ET_EXEC（为了 glibc/musl
  // 通吃），真机上 exec 会直接被 bionic 拒掉 —— 原话是
  //     error: "…/dsh-mesh-tsnet" has unexpected e_type: 2
  // 所以 build-sidecar.sh 为 android 单独出一份 PIE + bionic 解释器的产物。
  const baseOs = { darwin: "darwin", win32: "windows", linux: "linux", android: "android" }[process.platform];
  if (!baseOs) throw new Error(`不支持的系统：${process.platform}`);
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (!arch) throw new Error(`不支持的架构：${process.arch}（已发布 amd64 / arm64，见 sidecar-v1 release）`);
  return { os: resolveTargetOs(baseOs), arch };
}

/**
 * 诊断用：当前会选哪个资产、为什么（不下载、不联网、**不抛**）。
 * 健康检查/诊断卡片读它，排障时一眼看出"是不是选错风味了"。
 */
export function describeSidecarTarget() {
  try {
    const target = detectTarget();
    let dshGo = false;
    try {
      dshGo = dshGoInfo().isDshGo === true;
    } catch {
      /* 探测不可用就按 false */
    }
    return {
      os: target.os,
      arch: target.arch,
      asset: assetName(),
      platform: process.platform,
      executableArch: process.arch,
      configured: sidecarPlatformSettingValue(),
      dshGo,
    };
  } catch (err) {
    return {
      error: String(err?.message ?? err),
      platform: process.platform,
      executableArch: process.arch,
      configured: sidecarPlatformSettingValue(),
    };
  }
}

/** 本平台对应的资产名，例如 dsh-mesh-tsnet-darwin-amd64.gz */
export function assetName() {
  const { os, arch } = detectTarget();
  // Windows release assets carry .exe before .gz (see build-sidecar.sh and
  // PINNED_CHECKSUMS). Without it every mirror 404s and the checksum lookup
  // silently misses, so the binary is never verified and never refreshed.
  const exe = os === "windows" ? ".exe" : "";
  return `dsh-mesh-tsnet-${os}-${arch}${exe}.gz`;
}

/** 缓存目录：~/.dsh/mesh/bin/sidecar-v1/ */
export function binDir() {
  const base = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(base, "mesh", "bin", RELEASE_TAG);
}

/** 缓存中的可执行文件路径（不含 .gz）。 */
export function binaryPath() {
  const { os } = detectTarget();
  return join(binDir(), `dsh-mesh-tsnet${os === "windows" ? ".exe" : ""}`);
}

/**
 * 旁挂的标记文件，内容是这份二进制**来源 .gz 的 sha256**。
 *
 * 为什么需要它：校验和是给 .gz 算的，而缓存里存的是解压后的二进制，没法直接
 * 比对。没有这个标记就只能靠"文件存在"来判断，于是 sidecar 重新发布但协议号
 * 没变时（比如只加了一个命令行开关），老安装会一直用着旧二进制。
 */
function markerPath() {
  return `${binaryPath()}.source-sha256`;
}

function readSourceMarker() {
  try {
    return readFileSync(markerPath(), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * 缓存里那份二进制现在处于什么状态：
 *
 *   "ok"        —— 文件在、体积正常、来源 sha256 与当前 PINNED_CHECKSUMS 一致
 *   "missing"   —— 文件不在（或读不到）
 *   "truncated" —— 体积小得像半个文件，不能信
 *   "stale"     —— 是上一次发布的旧二进制
 *
 * 单独抽出来是因为 manager 也要问同一个问题（好决定要不要显示「下载中」），
 * 而这里藏着「sidecar 重新发布后必须重下」这条规则 —— 两份实现必然会漂移。
 */
function cacheState() {
  try {
    const target = binaryPath();
    if (!existsSync(target)) return "missing";
    if (statSync(target).size <= 1024 * 1024) return "truncated";
    const expected = PINNED_CHECKSUMS[assetName()] ?? "";
    // 没有内置校验和时无从判断新旧，只能沿用「文件在就算有」的老行为
    if (!expected) return "ok";
    return readSourceMarker() === expected ? "ok" : "stale";
  } catch {
    return "missing";
  }
}

/**
 * 缓存里的二进制对当前这一版插件而言是否已是最新。
 *
 * 给 manager 用：它必须在**每次**拉起 sidecar 前问一遍这个，否则重新发布的
 * sidecar 永远进不了老装置（见 lib/tsnet/manager.js 的注释）。
 */
export function cacheIsCurrent() {
  return cacheState() === "ok";
}

/**
 * 候选下载 URL，按尝试顺序排列。
 * @param extraSources 用户在配置里指定的额外源（可含 {url} 占位符或纯前缀）
 *
 * 额外源允许 `http://`（GitHub 与所有镜像都被墙时，把 .gz 放在同网段另一台
 * 机器上用 http 提供是最省事的逃生通道；资产仍受 checksums.js 里钉死的 sha256
 * 约束，明文传输改不了内容）。内置镜像与直连一律 https。
 */
export function candidateUrls(extraSources = []) {
  const asset = assetName();
  const canonical = `${ASSET_BASE}/${asset}`;
  const urls = [];

  for (const raw of extraSources) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    urls.push(s.includes("{url}") ? s.replaceAll("{url}", canonical) : `${s.replace(/\/+$/, "")}/${canonical}`);
  }
  for (const prefix of MIRROR_PREFIXES) urls.push(`${prefix}${canonical}`);
  urls.push(canonical); // 直连兜底：非国内网络下这才是最快的
  return [...new Set(urls)];
}

/**
 * 下载一个 URL 到 Buffer，自动跟随重定向。
 * GitHub release 会 302 到 objects.githubusercontent.com，不跟随就拿不到内容。
 *
 * 按 URL 协议选 http/https 模块：只 import node:https 的话，局域网 http 源会
 * 直接 ERR_INVALID_PROTOCOL —— 而被迫用局域网源的那些机器，恰恰是最没法自己
 * 排查的一类。
 *
 * 导出只为自测能直接打一发本地 http 请求（见 _selftest-tsnet.mjs）。
 */
export function downloadToBuffer(url, { timeoutMs, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const controller = { settled: false };
    const finish = (fn, arg) => {
      if (controller.settled) return;
      controller.settled = true;
      fn(arg);
    };

    const visit = (current, redirectsLeft) => {
      let req;
      try {
        const get = new URL(current).protocol === "http:" ? httpGet : httpsGet;
        req = get(current, { headers: { "User-Agent": "dsh-plugin-mesh", Accept: "*/*" } }, (res) => {
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return finish(reject, new Error("重定向次数过多"));
            const next = new URL(res.headers.location, current).toString();
            return visit(next, redirectsLeft - 1);
          }
          if (status !== 200) {
            res.resume();
            return finish(reject, new Error(`HTTP ${status}`));
          }
          const total = Number(res.headers["content-length"] ?? 0) || 0;
          const chunks = [];
          let received = 0;
          let idle = null;

          const armIdle = () => {
            if (idle) clearTimeout(idle);
            idle = setTimeout(() => {
              req.destroy(new Error("下载停滞超时"));
            }, IDLE_TIMEOUT_MS);
          };
          armIdle();

          res.on("data", (chunk) => {
            chunks.push(chunk);
            received += chunk.length;
            armIdle();
            if (onProgress) onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 });
          });
          res.on("end", () => {
            if (idle) clearTimeout(idle);
            finish(resolve, Buffer.concat(chunks));
          });
          res.on("error", (err) => {
            if (idle) clearTimeout(idle);
            finish(reject, err);
          });
        });
      } catch (err) {
        return finish(reject, err);
      }

      req.setTimeout(timeoutMs, () => req.destroy(new Error("连接超时")));
      req.on("error", (err) => finish(reject, err));
    };

    visit(url, MAX_REDIRECTS);
  });
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 确保 sidecar 二进制存在且可用。
 *
 * @returns {Promise<{path: string, downloaded: boolean, source: string}>}
 */
export async function ensureBinary({ extraSources = [], log = () => {}, onProgress, force = false } = {}) {
  const target = binaryPath();
  const asset = assetName();
  const expected = PINNED_CHECKSUMS[asset] ?? "";

  if (!force) {
    switch (cacheState()) {
      case "ok":
        return { path: target, downloaded: false, source: "cache" };
      case "truncated": {
        // 0 字节文件说明上次安装中途挂了，不能信。
        let size = 0;
        try {
          size = statSync(target).size;
        } catch {
          /* 刚好被删掉了，报 0 也无所谓 */
        }
        log(`缓存的 sidecar 体积异常（${size} 字节），重新下载`);
        break;
      }
      case "stale":
        // 缓存里是**旧的** sidecar。
        //
        // 每个安装都会在解压时记下"这份二进制来自哪个 .gz（sha256）"。sidecar 重新
        // 发布但协议号没变时（例如只加了一个命令行开关），只凭"文件存在"就会一直
        // 用着旧二进制、永远拿不到新能力 —— 这是实际踩到的坑。所以这里比对标记：
        // 对不上就重新下载。校验和也是因此才钉在插件源码里，而不是随二进制走。
        log("缓存的 sidecar 与当前版本不一致，重新下载");
        break;
    }
  }

  const urls = candidateUrls(extraSources);
  const errors = [];

  for (const url of urls) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    try {
      log(`下载 sidecar：${host} …`);
      const gz = await downloadToBuffer(url, { timeoutMs: CONNECT_TIMEOUT_MS, onProgress });

      if (gz.length < 1024 * 1024) {
        throw new Error(`内容过小（${gz.length} 字节），可能是错误页而非二进制`);
      }
      if (expected) {
        const actual = sha256(gz);
        if (actual !== expected) {
          // 校验和不匹配必须换源重试，而不是直接用 —— 这是防篡改的最后一道闸。
          throw new Error(`sha256 不匹配（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
        }
      } else {
        log(`⚠ 插件未内置 ${asset} 的校验和，跳过完整性校验`);
      }

      const bin = gunzipSync(gz);
      if (bin.length < 1024 * 1024) throw new Error(`解压后体积异常（${bin.length} 字节）`);

      mkdirSync(dirname(target), { recursive: true });
      const part = `${target}.part`;
      writeFileSync(part, bin, { mode: 0o755 });
      chmodSync(part, 0o755);
      renameSync(part, target);
      // 记下来源 .gz 的 sha256：下次启动据此判断缓存是否已过时
      try {
        writeFileSync(markerPath(), sha256(gz), { mode: 0o600 });
      } catch {
        /* 标记写不进去只是退化成"总是用缓存"，不该让安装失败 */
      }
      try {
        unlinkSync(`${target}.part`);
      } catch {
        /* rename 已经搬走了，忽略 */
      }

      log(`✓ sidecar 就绪：${target}（${(bin.length / 1048576).toFixed(1)}MB，来源 ${host}）`);
      return { path: target, downloaded: true, source: host };
    } catch (err) {
      errors.push(`${host}: ${err.message}`);
      log(`  ✗ ${host} 失败：${err.message}`);
    }
  }

  const detail = errors.map((e) => `  · ${e}`).join("\n");
  throw new Error(`所有下载源都失败了：\n${detail}\n\n可以手动下载 ${asset} 解压后放到：${target}`);
}

/** 删除缓存的二进制，供「重新下载」按钮使用。 */
export function clearBinary() {
  const target = binaryPath();
  for (const p of [target, `${target}.part`, markerPath()]) {
    try {
      unlinkSync(p);
    } catch {
      /* 不存在就算了 */
    }
  }
}

/**
 * 缓存里二进制的信息。
 *
 * **本身绝不抛异常**：它只是个"报告一下状态"的函数，却会被
 * TsnetNode.status() → /mesh/api/state 一路调用。一旦它抛，整页就变成
 * 「本机 undefined」而且看不到原因（实测踩过：Android 上 detectTarget 抛
 * 「不支持的系统：android」，把整个 Mesh 页面打成 500，连互联网组网卡片
 * 都一起消失了）。
 */
export function binaryInfo() {
  try {
    const target = binaryPath();
    if (!existsSync(target)) return { installed: false, path: target, size: 0 };
    return { installed: true, path: target, size: statSync(target).size };
  } catch (err) {
    // 把原因带出去，但用 error 字段而不是抛出 —— 上层可以显示它，页面不会塌
    return { installed: false, path: "", size: 0, error: String(err?.message ?? err) };
  }
}

/** 读取缓存的二进制头部，确认它是可执行文件而不是残留的错误页。 */
export function looksExecutable() {
  const target = binaryPath();
  try {
    const head = readFileSync(target, { flag: "r" }).subarray(0, 4);
    const { os } = detectTarget();
    if (os === "windows") return head[0] === 0x4d && head[1] === 0x5a; // MZ
    if (os === "darwin") {
      const magic = head.readUInt32BE(0);
      return magic === 0xcffaedfe || magic === 0xfeedfacf || magic === 0xcafebabe || magic === 0xfeedface;
    }
    return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46; // ELF
  } catch {
    return false;
  }
}
