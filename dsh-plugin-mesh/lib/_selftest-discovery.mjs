/**
 * 局域网发现的双进程手动测试：起两个实例，互相发现。
 *
 *   node lib/_selftest-discovery.mjs mac-a 45900 &
 *   node lib/_selftest-discovery.mjs mac-b 45901
 *
 * ⚠ 用**私有组播组和端口**，不要改回生产的 239.255.42.99:45892 ——
 * 这个脚本会向组播组宣告自己，跑在生产组上会被同一网段的真实 DSH 登记成
 * 一台假机器。实测踩过：`npm run selftest` 每跑一次，就在真实网络里多出
 * 一条名为 test 的重名记录（身份带 pid，所以每次还都不一样）。
 *
 * 日常回归测试请用 `npm run selftest`（纯逻辑、不碰网络）。
 */
import { MeshDiscovery, preferredAddress } from "./discovery.js";

/** 测试专用组播组/端口：与生产值刻意不同，避免污染真实网络。 */
export const TEST_GROUP = "239.255.42.98";
export const TEST_MULTICAST_PORT = 45893;

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
