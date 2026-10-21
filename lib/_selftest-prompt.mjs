/**
 * 任务提示词的自测。
 *
 *   node lib/_selftest-prompt.mjs
 *
 * 这组测试的存在理由是**一个真发出去的 bug**：提示词里让对端把结果"回派给
 * `lipeng-mac/peng`"，而 `mesh_run` 的 peer 参数要的是机器名 —— 对端 agent
 * 拿着它去派发会被 findPeer 拒绝，白费一轮。hos 实测撞上并按自己的判断改成
 * 机器名才成功。**agent 能自救，不代表指令是对的。**
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { buildPrompt } from "./prompt.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

/** 取出"回派给 X"里的 X。 */
function replyPeerOf(text) {
  const m = text.match(/把结果回派给 ([^\s（(]+)/);
  return m ? m[1] : "";
}

console.log("\n── 回派目标必须是机器名，不能是「机器名/用户」──");

test("fromMachine 存在时用它（这是最可靠的来源）", () => {
  const t = buildPrompt({ id: "t1", from: "lipeng-mac/peng", fromMachine: "lipeng-mac", task: "x", thread: "th" });
  assert.equal(replyPeerOf(t), "lipeng-mac", t);
});

test("from 里的 /用户 后缀绝不能进回派目标（就是踩过的那个 bug）", () => {
  const t = buildPrompt({ id: "t1", from: "hos/u0_a267", fromMachine: "hos", task: "x", thread: "th" });
  assert.equal(replyPeerOf(t), "hos");
  assert.ok(!replyPeerOf(t).includes("/"), "回派目标里不该有斜杠");
});

test("老版本对端没有 fromMachine 时，切掉 /user 兜底", () => {
  const t = buildPrompt({ id: "t1", from: "文超-win/86189", task: "x", thread: "th" });
  assert.equal(replyPeerOf(t), "文超-win", t);
});

test("fromMachine 是空串时也走兜底（不能因为空串就退化成空目标）", () => {
  const t = buildPrompt({ id: "t1", from: "winbox/86189", fromMachine: "   ", task: "x" });
  assert.equal(replyPeerOf(t), "winbox", t);
});

test("指令里额外用一句话点明「填机器名」", () => {
  const t = buildPrompt({ id: "t1", from: "hos/u0_a267", fromMachine: "hos", task: "x" });
  assert.ok(t.includes("不要填 \"机器名/用户\""), t);
});

console.log("\n── 归一化：webhook 与 mesh 两种形状都要认 ──");

test("mesh 形状（id/from）", () => {
  const t = buildPrompt({ id: "t-abc", from: "hos/u0_a267", fromMachine: "hos", task: "干活", thread: "th-1" });
  assert.ok(t.includes("[DSH Mesh 任务 t-abc]"), t);
  assert.ok(t.includes("线程: th-1"), t);
  assert.ok(t.includes("干活"), t);
});

test("webhook 形状（deliveryId/source）也能归一化", () => {
  const t = buildPrompt({ deliveryId: "d-1", source: "somewhere", task: "干活" });
  assert.ok(t.includes("[DSH Mesh 任务 d-1]"), t);
  assert.ok(t.includes("来自: somewhere"), t);
  assert.ok(!t.includes("undefined"), `不该出现 undefined：${t}`);
});

test("没有 thread 时用 id 兜底", () => {
  const t = buildPrompt({ id: "t-9", from: "a/u", fromMachine: "a", task: "x" });
  assert.ok(t.includes("thread 填 t-9"), t);
});

test("全空入参不崩，也不产出 undefined", () => {
  const t = buildPrompt({});
  assert.ok(t.includes("[DSH Mesh 任务 unknown]"), t);
  assert.ok(!t.includes("undefined"), t);
  assert.equal(replyPeerOf(t), "unknown");
});

test("task 正文原样保留（不被指令淹没）", () => {
  const body = "第一行\n第二行\n  缩进行";
  const t = buildPrompt({ id: "t1", from: "a/u", fromMachine: "a", task: body });
  assert.ok(t.includes(body), "正文必须逐字保留");
});

// ── 回执：必须明确禁止再回派 ──
//
// 2026-10-21 真机事故：手动派发后，对端回执被注入会话，提示词仍写着
// 「做完后用 mesh_run 回派」→ agent 照做 → 两边互相回执，一轮几十条。
console.log("\n── 回执 vs 新任务：指令必须相反 ──");

test("回执：明确禁止再回派，并说明会形成循环", () => {
  const p = buildPrompt({
    id: "t-1", from: "hos/u0", fromMachine: "hos", thread: "T", task: "结果如下", isReply: true,
  });
  assert.ok(p.includes("回执"), p.slice(0, 200));
  assert.ok(!/做完后用 mesh_run 工具把结果回派/.test(p), "回执不该再给「做完后回派」的指令");
  assert.ok(p.includes("不要再用 mesh_run 回派"), p.slice(0, 300));
  assert.ok(p.includes("循环"), "要说清后果，agent 才会真的停下");
});

test("新任务：仍然要求回派（否则对端永远收不到结果）", () => {
  const p = buildPrompt({
    id: "t-2", from: "hos/u0", fromMachine: "hos", thread: "T", task: "做点事",
  });
  assert.ok(/做完后用 mesh_run 工具把结果回派给 hos/.test(p), p.slice(0, 300));
  assert.ok(!p.includes("不要再用 mesh_run 回派"));
});

// ── 手动派发：用户气泡里只能是用户自己那句话 ──
//
// 真机事故（2026-10-21 splitmsg → lipeng-mac，t-d5176adbec0a）：预建会话里先注入
// 一条给 agent 的说明、再注入用户原文，结果第二条被当成「下一轮排队消息」插进
// inbox，随本轮结束被清掉 —— 用户点进去看到的是那条说明，自己发的那句话一个字
// 都没有。所以这里断言的不是措辞，是**只注入一条、内容就是原文、且必须
// kind:"user"**（kind 不是 user 会被渲染成折叠的「上下文注入」，气泡就没了）。
console.log("\n── 手动派发：气泡只放原文 ──");

function announceBlock() {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const start = src.indexOf("if (announce?.text)");
  assert.ok(start > 0, "找不到预建会话注入 announce 的分支");
  return { src, block: src.slice(start, src.indexOf("} catch (err)", start)) };
}

test("预建会话只注入一条消息（多条时后面的会被吞掉）", () => {
  const { block } = announceBlock();
  const followups = block.match(/handle\.agent\.followup\(/g) ?? [];
  assert.equal(
    followups.length,
    1,
    "连续两次 followup 时第二条会被当排队消息吞掉（实测：说明留下、原文被吞，正好反了）",
  );
});

test("注入的内容就是原文，不加任何说明文字", () => {
  const { block } = announceBlock();
  assert.ok(
    /text:\s*announce\.text\s*\}/.test(block),
    "必须是 announce.text 原样注入，不能拼前缀/后缀",
  );
  assert.ok(!/announce\.note/.test(announceBlock().src), "说明不能再作为第二条消息注入");
});

test("必须是 kind:\"user\"，否则被折叠成上下文注入、不成为气泡", () => {
  const { block } = announceBlock();
  assert.ok(/source:\s*\{\s*kind:\s*"user"/.test(block), "原文必须 kind:\"user\" 才渲染成正常气泡");
  assert.ok(!/kind:\s*"webhook"/.test(block), "气泡里不能掺进 webhook/notice");
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
