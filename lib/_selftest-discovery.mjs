/**
 * 发现模块的独立测试：起实例、打印对端。
 *
 *   node lib/_selftest-discovery.mjs mac 45900
 *
 * 两个进程同时跑，应能互相发现（同一台机器上用组播回环验证）。
 */
import { MeshDiscovery, preferredAddress } from "./discovery.js";

const machine = process.argv[2] ?? "test";
const port = Number(process.argv[3] ?? 45900);
const id = `selftest-${machine}-${process.pid}`;

const d = new MeshDiscovery({
  id,
  port,
  meta: { machine, user: "tester", profile: "selftest", version: "0.1.0" },
  intervalMs: 2000,
  ttlMs: 6000,
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
