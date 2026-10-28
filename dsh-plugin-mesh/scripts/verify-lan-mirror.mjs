/**
 * 验证一个局域网 sidecar 镜像真的可用 —— 用「那台机器的平台」走一遍完整安装。
 *
 * 背景：Android/Termux 上 github.com 与所有公共镜像都不通，只能靠同网段的机器
 * 用 http 当镜子（scripts 同级目录的 lan-sidecar-mirror.py，在仓库外）。但
 * "我这边能打开"不等于"那边能装上"：平台映射、协议、sha256、解压、可执行位
 * 任何一环都可能断。这个脚本就地把这些全跑一遍，且**不碰真的缓存目录**
 * （DSH_HOME 指向临时目录）。
 *
 * 用法：
 *   node scripts/verify-lan-mirror.mjs --url http://192.168.1.6:8791/ --platform android --arch arm64
 *   node scripts/verify-lan-mirror.mjs --url http://192.168.1.6:8791/   # 用本机平台
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, dflt = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const url = arg("url");
if (!url) {
  console.error("必须给 --url，例如 --url http://192.168.1.6:8791/");
  process.exit(2);
}
const platform = arg("platform");
const arch = arg("arch");

const home = mkdtempSync(join(tmpdir(), "mesh-mirror-check-"));
process.env.DSH_HOME = home;
if (platform) Object.defineProperty(process, "platform", { value: platform, configurable: true });
if (arch) Object.defineProperty(process, "arch", { value: arch, configurable: true });

const dl = await import("../lib/tsnet/download.js");

console.log(`资产     ${dl.assetName()}`);
console.log(`首个源   ${dl.candidateUrls([url])[0]}`);
console.log(`安装到   ${home}（临时目录，不动真实缓存）`);

let ok = false;
try {
  const t0 = Date.now();
  const res = await dl.ensureBinary({ extraSources: [url], log: (m) => console.log(`  ${m}`) });
  const info = dl.binaryInfo();
  console.log(`→ 下载成功：${(info.size / 1048576).toFixed(1)}MB，来源 ${res.source}，耗时 ${Date.now() - t0}ms`);
  if (!dl.looksExecutable()) throw new Error("文件头不是本平台的可执行格式（可能是错误页或错平台资产）");
  console.log("→ 文件头校验通过（Linux 平台应为 ELF）");
  console.log("\n镜像可用。对端配置：tsnetDownloadSources = [\"" + url + "\"]");
  ok = true;
} catch (err) {
  console.error(`\n✗ 失败：${err.message}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
