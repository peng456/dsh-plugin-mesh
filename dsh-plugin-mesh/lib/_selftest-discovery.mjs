/**
 * 局域网发现的双进程测试：起两个实例，互相发现。
 *
 * 三种跑法：
 *
 *   1. 自动配对模式（npm run selftest:lan 用的就是这个）：
 *        node lib/_selftest-discovery.mjs --pair
 *      父进程起两个子进程（mac-a:45900 / mac-b:45901），两边都发现对端才算通过。
 *      **单进程模式永远只能看到 0 个对端**，所以不要用 `node lib/_selftest-discovery.mjs`
 *      的退出码判断回归 —— 那个退出码 3 是"没人和我配对"，不是失败。
 *
 *   2. 手动双终端：
 *        node lib/_selftest-discovery.mjs mac-a 45900 &
 *        node lib/_selftest-discovery.mjs mac-b 45901
 *
 *   3. 单实例探针（看自己的地址/诊断）：参数同上，不检查对端数量。
 *
 * ⚠ 用**私有组播组和端口**，不要改回生产的 239.255.42.99:45892 ——
 * 这个脚本会向组播组宣告自己，跑在生产组上会被同一网段的真实 DSH 登记成
 * 一台假机器。实测踩过：`npm run selftest` 每跑一次，就在真实网络里多出
 * 一条名为 test 的重名记录（身份带 pid，所以每次还都不一样）。
 *
 * 日常回归测试请用 `npm run selftest`（纯逻辑、不碰网络）。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MeshDiscovery, preferredAddress } from "./discovery.js";

/** 测试专用组播组/端口：与生产值刻意不同，避免污染真实网络。 */
export const TEST_GROUP = "239.255.42.98";
export const TEST_MULTICAST_PORT = 45893;

const SELF = fileURLToPath(import.meta.url);

/** 起一个子实例，返回 promise<exitCode>。 */
function runChild(machine, port, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, machine, String(port), String(timeoutMs)], {
      stdio: "inherit",
    });
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(Number(code)));
  });
}

/**
 * 自动配对模式：两个实例必须互相发现。
 *
 * 顺序有讲究：先起 A，等 1.5s 再起 B —— 两个同时 bind 同一个组播端口虽然
 * reuseAddr 允许，但错开发公告能让"发现"这件事更确定地发生（A 至少已经
 * 发过一轮心跳）。
 */
async function runPair() {
  console.log("[pair] 起 mac-a:45900，1.5s 后起 mac-b:45901（私有组播组，不碰生产网络）");
  const a = runChild("mac-a", 45900, 12000);
  await new Promise((r) => setTimeout(r, 1500));
  const b = runChild("mac-b", 45901, 9000);
  const [codeA, codeB] = await Promise.all([a, b]);
  const ok = codeA === 0 && codeB === 0;
  console.log(`\n[pair] 结果：mac-a exit=${codeA}，mac-b exit=${codeB} → ${ok ? "通过" : "失败"}`);
  if (!ok) {
    console.log("[pair] 提示：单实例退出码 3 表示「没发现对端」。若两端都是 3，多半是这台机器/网络");
    console.log("        拦了组播（Windows 防火墙、AP isolation、容器等），不是发现逻辑坏了。");
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--pair")) {
  await runPair();
} else {
  const machine = process.argv[2] ?? "selftest-probe";
  const port = Number(process.argv[3] ?? 45900);
  const id = `selftest-${machine}-${process.pid}`;

  const d = new MeshDiscovery({
    id,
    port,
    meta: { machine, user: "tester", profile: "selftest", version: "0.1.0" },
    intervalMs: 2000,
    ttlMs: 6000,
    group: TEST_GROUP,
    multicastPort: TEST_MULTICAST_PORT,
  });

  d.on("change", (peers) => {
    console.log(`[${machine}] 对端变化 (${peers.length}):`);
    for (const p of peers) {
      console.log(`   ${p.online ? "●" : "○"} ${p.machine}  ${p.host}:${p.port}  id=${p.id}  lastSeen=${new Date(p.lastSeen).toISOString()}`);
    }
  });
  d.on("diagnostic", (m) => console.log(`[${machine}] 诊断: ${m}`));

  console.log(`[${machine}] 本机地址 ${preferredAddress()}  实例 id=${id}`);
  d.start();
  d.announceNow();

  setTimeout(() => {
    const peers = d.peers();
    console.log(`[${machine}] === 最终结果: 发现 ${peers.length} 个对端 ===`);
    d.stop();
    process.exit(peers.length > 0 ? 0 : 3);
  }, Number(process.argv[4] ?? 9000));
}
