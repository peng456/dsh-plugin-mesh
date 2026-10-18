/**
 * 配对二维码的自测：生成的是 SVG/data URL，内容里带编码后的 secret。
 * 不依赖浏览器、不联网。
 */
import assert from "node:assert/strict";
import { pairingPayload, pairingQrDataUrl, pairingQrSvg } from "./qr.js";

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

check("pairingPayload 是 dsh-mesh://pair?code=<encoded secret>", () => {
  assert.equal(pairingPayload(secret), `dsh-mesh://pair?code=${encodeURIComponent(secret)}`);
  assert.equal(pairingPayload(""), "");
});

check("生成 SVG，包含 viewBox 与 path", () => {
  const svg = pairingQrSvg(secret);
  assert.ok(svg.startsWith("<svg"), svg.slice(0, 80));
  assert.ok(svg.includes("</svg>"));
  assert.ok(svg.includes("viewBox"));
  assert.ok(svg.length > 1000, `SVG 太小：${svg.length}`);
});

check("data URL 可解码回同一份 SVG", () => {
  const svg = pairingQrSvg(secret);
  const url = pairingQrDataUrl(secret);
  assert.ok(url.startsWith("data:image/svg+xml;charset=utf-8,"), url.slice(0, 60));
  assert.equal(decodeURIComponent(url.slice(url.indexOf(",") + 1)), svg);
});

check("空 secret / undefined 不生成二维码", () => {
  assert.equal(pairingQrSvg(""), "");
  assert.equal(pairingQrSvg(undefined), "");
  assert.equal(pairingQrDataUrl(""), "");
});

check("不同 secret 生成不同内容", () => {
  assert.notEqual(pairingQrSvg(secret), pairingQrSvg(`${secret}-other`));
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
