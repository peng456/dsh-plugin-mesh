/**
 * newSession 端到端验证脚本。
 *
 * 思路：本机（生产 DSH，profile=desktop）与被测的隔离实例（dev，profile=meshtest）
 * 通过多播互相发现。dev 的 web server 没有被 Desktop 的 permits 闸门保护，所以
 * 可以用 curl/node 直接驱动；生产实例作为接收方，把路由结果写进
 * ~/.dsh/mesh/threads.json —— 读这个文件就能看到"复用还是新建"。
 *
 * 断言：同一 thread 的第 2 条带 newSession:true 时，必须绑定到**不同的** sessionId。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEV = "http://127.0.0.1:8877";
const PEER = process.argv[2] ?? "lipeng-mac";
const GAP_MS = Number(process.argv[3] ?? 8000);
const THREAD = `nsverify-${Date.now()}`;

const threadsPath = join(homedir(), ".dsh", "mesh", "threads.json");

function snapshot() {
  try {
    const t = JSON.parse(readFileSync(threadsPath, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(t.threads ?? {})) out[k] = v.sessionId;
    return out;
  } catch {
    return {};
  }
}

async function send(task, newSession) {
  const res = await fetch(`${DEV}/mesh/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: PEER, thread: THREAD, newSession, task }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 找到本 thread 对应的会话键 —— 键里带发送方机器名，所以按后缀匹配。 */
function findKey(snap) {
  const hits = Object.keys(snap).filter((k) => k.startsWith("meshdev#"));
  return hits.length === 1 ? hits[0] : hits[hits.length - 1];
}

const before = snapshot();
console.log(`thread=${THREAD}  peer=${PEER}  gap=${GAP_MS}ms`);

console.log("\n[1] newSession=false →");
const r1 = await send("【自动测试】newSession 功能验证的第 1 条消息。请只回复 ok 两个字，不要调用任何工具，也不要做别的事情。", false);
console.log("   ", r1.status, JSON.stringify(r1.body));

console.log(`\n    等 ${GAP_MS}ms（必须大于 threadCooldownMs=5000，否则会被冷却拦下）…`);
await new Promise((r) => setTimeout(r, GAP_MS));

const mid = snapshot();
const key = findKey(mid);
const s1 = key ? mid[key] : undefined;
console.log(`    第 1 条绑定：${key} -> ${s1}`);

if (!s1) {
  console.log("\n[FAIL] 第 1 条没有绑定任何会话 —— 检查对端是否真的开跑了。");
  console.log("       生产实例 inbound 记录：");
  const r = await fetch(`${DEV}/mesh/api/state`);
  const st = await r.json();
  console.log(JSON.stringify(st.outbound?.slice(-3), null, 2));
  process.exit(1);
}

// CONTROL=1：第 2 条也不带 newSession。此时应当**复用**第 1 条建的会话 ——
// 这是对照实验：同样的间隔、同样的 thread，唯一变量就是 newSession。
// 没有这个对照，"两个 session 不同"可能来自别的原因（比如注入失败回退新建）。
const CONTROL = process.env.CONTROL === "1";
console.log(`\n[2] newSession=${CONTROL ? "false（对照组，应复用）" : "true（应新建）"} →`);
const r2 = await send("【自动测试】newSession 功能验证的第 2 条消息。请只回复 ok 两个字，不要调用任何工具，也不要做别的事情。", !CONTROL);
console.log("   ", r2.status, JSON.stringify(r2.body));

await new Promise((r) => setTimeout(r, 8000));
const after = snapshot();
const s2 = after[key];
console.log(`    第 2 条绑定：${key} -> ${s2}`);

console.log("");
if (CONTROL) {
  if (s2 && s1 && s2 === s1) {
    console.log(`[PASS] 对照组符合预期：不带 newSession 时复用了同一会话 ${s1}`);
    console.log(`       → 说明上一轮的"两个不同会话"确实是 newSession 造成的`);
    process.exit(0);
  }
  console.log(`[FAIL] 对照组异常：期望复用 ${s1}，实际 ${s2}`);
  process.exit(1);
}
if (s2 && s1 && s2 !== s1) {
  console.log(`[PASS] newSession 生效：同一会话键绑到了两个不同会话`);
  console.log(`       ${s1}`);
  console.log(`       ${s2}`);
  process.exit(0);
}
if (s2 === s1) {
  console.log(`[FAIL] newSession 没生效：第 2 条仍复用 ${s1}`);
  process.exit(1);
}
console.log(`[FAIL] 第 2 条没有绑定会话（s2=${s2}）`);
process.exit(1);
