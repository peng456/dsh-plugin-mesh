/**
 * 头像净化 / 默认头像读取的离线自测。
 *
 *   node lib/_selftest-avatar.mjs
 */
import { strict as assert } from "node:assert";
import { sanitizeAvatar, avatarFromFile, detectDefaultAvatar, AVATAR_MAX_CHARS } from "./avatar.js";

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

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const WEBP = "data:image/webp;base64,UklGRg==";

test("接受 png / jpeg / webp 的 data URL", () => {
  assert.equal(sanitizeAvatar(PNG), PNG);
  assert.equal(sanitizeAvatar(JPEG), JPEG);
  assert.equal(sanitizeAvatar(WEBP), WEBP);
});

test("拒绝 http / javascript / 非图片 mime", () => {
  for (const bad of [
    "https://example.com/a.png",
    "javascript:alert(1)",
    "data:text/html;base64,PGI+",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "not a string",
    null,
    undefined,
    "",
  ]) {
    assert.equal(sanitizeAvatar(bad), "", String(bad));
  }
});

test("拒绝超过上限的头像", () => {
  const big = "data:image/png;base64," + "A".repeat(AVATAR_MAX_CHARS + 4);
  assert.equal(sanitizeAvatar(big), "");
});

test("文件不存在/扩展名未知 → 空串，不抛", () => {
  assert.equal(avatarFromFile("Z:/definitely/not/here.png"), "");
  assert.equal(avatarFromFile("E:/HKS/README.md"), "");
});

test("默认头像读取不抛，返回 string", () => {
  assert.equal(typeof detectDefaultAvatar(), "string");
});

console.log(`\n${failed ? `有失败：${passed} 通过 / ${failed} 失败` : `全部通过：${passed} 通过 / 0 失败`}`);
process.exit(failed ? 1 : 0);
