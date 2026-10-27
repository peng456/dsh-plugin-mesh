/**
 * 真机 Android 冒烟 E2E（ADB，USB 连接）。
 *
 *   node scripts/e2e-android.mjs [--port 45917] [--expect-peer <machine>]
 *
 * 它验证的是“手机作为 mesh 节点真的在跑”，不是 UI 点击：
 *   1. adb devices 里有且只有一台可用设备
 *   2. 设备上装了 dsh-mobile APK（com.dsharnessmobile.shell）
 *   3. adb forward 后能读到手机 mesh 的 /mesh/v1/health
 *   4. 自述 app=dsh-mesh，version 非空
 *   5. 可选：/mesh/v1/peers 里能看到指定桌面节点
 *
 * UI 点击级 E2E 需要 dsh-mobile 的 CDP/虚拟屏通道，不在这里做；这个脚本先把
 * “节点活着、协议通、能看见对端”钉住。
 *
 * 退出码：0 通过 / 1 断言失败 / 2 没有设备（不是产品失败）
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argOf("--port", "45917"));
const EXPECT_PEER = argOf("--expect-peer", "");

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

let failures = 0;
const ok = (name, detail = "") => console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
const bad = (name, detail = "") => {
  failures += 1;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
};

let devices = [];
try {
  const lines = run("adb", ["devices"]).split("\n").slice(1).filter(Boolean);
  devices = lines
    .map((l) => l.trim().split(/\s+/))
    .filter(([id, state]) => id && state === "device")
    .map(([id]) => id);
} catch (err) {
  console.error(`无法执行 adb：${err?.message ?? err}`);
  process.exit(2);
}

if (devices.length === 0) {
  console.error("没有可用 Android 设备（adb devices 为空）。接上手机并开 USB 调试后重跑。");
  process.exit(2);
}
if (devices.length > 1) {
  console.error(`检测到多台设备：${devices.join(", ")}。本脚本只跑单台，先断开多余的。`);
  process.exit(2);
}
const serial = devices[0];
const adb = (...a) => run("adb", ["-s", serial, ...a]);
ok("设备在线", serial);

try {
  const packages = adb("shell", "pm", "list", "packages");
  if (packages.includes("com.dsharnessmobile.shell")) ok("dsh-mobile APK 已安装");
  else bad("dsh-mobile APK 未安装", "com.dsharnessmobile.shell");
} catch (err) {
  bad("读取设备包列表失败", String(err?.message ?? err));
}

let forwarded = false;
try {
  adb("forward", `tcp:${PORT}`, `tcp:${PORT}`);
  forwarded = true;
  const health = await (await fetch(`http://127.0.0.1:${PORT}/mesh/v1/health`)).json();
  if (health && health.app === "dsh-mesh") ok("手机 mesh 自述正确", `machine=${health.machine || "?"}`);
  else bad("手机 mesh 自述异常", JSON.stringify(health).slice(0, 160));
  if (health && typeof health.version === "string" && health.version) ok("版本非空", health.version);
  else bad("版本为空");

  const peersResp = await (await fetch(`http://127.0.0.1:${PORT}/mesh/v1/peers`)).json();
  const peers = Array.isArray(peersResp?.peers) ? peersResp.peers : [];
  ok("对端列表可读", `${peers.length} 台`);
  if (EXPECT_PEER) {
    if (peers.some((p) => p.machine === EXPECT_PEER || p.id === EXPECT_PEER)) {
      ok(`能看到指定对端 ${EXPECT_PEER}`);
    } else {
      bad(`看不到指定对端 ${EXPECT_PEER}`, peers.map((p) => p.machine).join(", ") || "空");
    }
  }
} catch (err) {
  bad("读取手机 mesh 失败", String(err?.message ?? err));
} finally {
  if (forwarded) {
    try {
      adb("forward", "--remove", `tcp:${PORT}`);
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

console.log(failures ? `\n${failures} 项失败` : "\n真机冒烟通过");
process.exit(failures ? 1 : 0);
