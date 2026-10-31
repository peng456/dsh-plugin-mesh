/**
 * 聊天窗口 @ 设备的纯逻辑自测。
 *
 * 这里盯住的是**最容易悄悄出错、又最难在界面上一眼看出来**的几件事：
 *   · 只认消息开头的 @（正文中间的 @ 不能自动派发）
 *   · 机器名可以含空格 → 按最长名字优先匹配，不按空白切词
 *   · 名字大小写不敏感，但派发目标必须是已知名字的规范写法
 *   · 改写后的消息必须明确「已派发 / 未派发」以及「不要在本机执行」
 *
 *   node lib/_selftest-at-mention.mjs
 */
import { strict as assert } from "node:assert";
import { matchLeadingMentions, buildAtPrompt, isMentionableName, AT_MENTION_LIMIT } from "./at-mention.js";

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

const NAMES = ["mac", "文超-win", "mac studio", "hos"];

console.log("\n── 认出开头的 @目标 ──");

test("单个 @名字 + 正文", () => {
  const r = matchLeadingMentions("@mac 看看磁盘空间", NAMES);
  assert.deepEqual(r.mentions.map((m) => m.machine), ["mac"]);
  assert.equal(r.body, "看看磁盘空间");
});

test("多个 @目标（空格分隔）", () => {
  const r = matchLeadingMentions("@mac @hos 都看看磁盘", NAMES);
  assert.deepEqual(r.mentions.map((m) => m.machine), ["mac", "hos"]);
  assert.equal(r.body, "都看看磁盘");
});

test("开头有空白也算开头", () => {
  const r = matchLeadingMentions("   \n@mac hi", NAMES);
  assert.deepEqual(r.mentions.map((m) => m.machine), ["mac"]);
  assert.equal(r.body, "hi");
});

test("只有 @名字、没有正文 → 认出目标，正文为空", () => {
  const r = matchLeadingMentions("@mac", NAMES);
  assert.equal(r.mentions.length, 1);
  assert.equal(r.body, "");
});

test("名字可以含空格，按最长名字优先匹配", () => {
  const r = matchLeadingMentions("@mac studio 编译一下", NAMES);
  assert.deepEqual(r.mentions.map((m) => m.machine), ["mac studio"]);
  assert.equal(r.body, "编译一下");
});

test("中文/带连字符的名字", () => {
  const r = matchLeadingMentions("@文超-win 打个补丁", NAMES);
  assert.deepEqual(r.mentions.map((m) => m.machine), ["文超-win"]);
  assert.equal(r.body, "打个补丁");
});

test("大小写不敏感，但目标取已知规范写法", () => {
  const r = matchLeadingMentions("@MAC hi", NAMES);
  assert.deepEqual(r.mentions.map((m) => m.machine), ["mac"]);
});

console.log("\n── 不该派发的地方 ──");

test("正文中间的 @ 不算：那是提到某台机器", () => {
  const r = matchLeadingMentions("请让 @mac 看看磁盘", NAMES);
  assert.deepEqual(r.mentions, []);
  assert.equal(r.body, "请让 @mac 看看磁盘");
});

test("不是已知名字的 @ 不算（文件引用 / 打错字都走这条路）", () => {
  for (const text of ["@AGENTS.md 看看", "@macx hi", "@ src/index.js"]) {
    const r = matchLeadingMentions(text, NAMES);
    assert.deepEqual(r.mentions, [], text);
  }
});

test("前缀相同但不是整词：@macx 不能被当成 @mac", () => {
  const r = matchLeadingMentions("@macx hi", NAMES);
  assert.deepEqual(r.mentions, []);
});

test("没给名字列表时什么都不认", () => {
  assert.deepEqual(matchLeadingMentions("@mac hi", []).mentions, []);
  assert.deepEqual(matchLeadingMentions("@mac hi", undefined).mentions, []);
});

test(`一条消息最多认 ${AT_MENTION_LIMIT} 个目标（再多是广播，不是派活）`, () => {
  const many = Array.from({ length: 20 }, (_, i) => `m${i}`);
  const text = many.map((m) => `@${m}`).join(" ") + " hi";
  const r = matchLeadingMentions(text, many);
  assert.equal(r.mentions.length, AT_MENTION_LIMIT);
});

test("空消息 / 非字符串都不炸", () => {
  for (const v of ["", null, undefined, 42]) {
    const r = matchLeadingMentions(v, NAMES);
    assert.deepEqual(r.mentions, []);
    assert.equal(r.body, "");
  }
});

console.log("\n── 名字本身的可提及性 ──");

test("带 @ 或控制字符的名字不可提及（会破坏 mention 语法）", () => {
  assert.equal(isMentionableName("mac"), true);
  assert.equal(isMentionableName("mac studio"), true);
  assert.equal(isMentionableName(""), false);
  assert.equal(isMentionableName("@mac"), false);
  assert.equal(isMentionableName("mac\nwin"), false);
});

console.log("\n── 改写后的模型消息 ──");

test("派发成功：说明已发出，并明确不要在本机执行/回派", () => {
  const text = buildAtPrompt({ body: "看看磁盘", results: [{ machine: "mac", id: "t-abc" }] });
  assert.match(text, /看看磁盘/);
  assert.match(text, /已派发/);
  assert.match(text, /t-abc/);
  assert.match(text, /不要调用任何工具/);
  assert.match(text, /等待回执/);
});

test("派发失败：原因写出来，且明确「没有在本机执行」", () => {
  const text = buildAtPrompt({ body: "看看磁盘", results: [{ machine: "mac", error: "这台机器当前离线" }] });
  assert.match(text, /未能派发/);
  assert.match(text, /当前离线/);
  assert.match(text, /没有在本机执行/);
  assert.match(text, /不要自己动手/);
});

test("成功与失败混在一起：两种结论都在", () => {
  const text = buildAtPrompt({
    body: "一起看看",
    results: [
      { machine: "mac", id: "t-1" },
      { machine: "hos", error: "找不到机器 hos" },
    ],
  });
  assert.match(text, /已派发/);
  assert.match(text, /未能派发/);
});

test("正文为空时不留一条空白消息，而是说出原因", () => {
  const text = buildAtPrompt({ body: "", results: [{ machine: "mac", error: "消息里只有 @ 设备名，没有正文" }] });
  assert.match(text, /没有正文/);
  assert.doesNotMatch(text.split("\n")[0], /^\s*$/);
});

test("正文里的反引号 / 换行原样保留（不改写用户内容）", () => {
  const body = "第一行\n第二行 `code`";
  const text = buildAtPrompt({ body, results: [{ machine: "mac", id: "t-1" }] });
  assert.ok(text.startsWith(body), text);
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
