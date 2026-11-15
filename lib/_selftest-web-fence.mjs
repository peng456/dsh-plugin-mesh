/**
 * `/api` 信任围栏探测的自测（`lib/web-fence.js`）。
 *
 * 这段护栏盯的是**一次真实误判**（2026-11-13，Mac 看 Android 机 `hos`）：
 * 对端 `/` 返回 200，观看端就判定"局域网可达"并开直连代理；可对端 `/api`
 * 的信任围栏只认它自己的权威，于是 `/api/remote.mux` 的 WS 升级永远 403，
 * 界面停在「重新连接中…」。判别式只有状态码一条，所以要钉死三件事：
 *   · `403` 才算"被围栏挡住"（页面通、接口不通）；
 *   · `401`/`200`/`404` 是"围栏过了，只是没登录"——绝不能误判成 fenced；
 *   · 超时/连不上返回 `undefined`，不许把探测失败伪装成"对端拒绝我"。
 *
 *   node lib/_selftest-web-fence.mjs
 */
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { API_FENCE_PROBE_PATH, probeApiFence } from "./web-fence.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

/** 起一个只回答固定状态码的假对端，返回基址与关闭函数。 */
async function fakePeer(status, { onRequest } = {}) {
  const server = createServer((req, res) => {
    onRequest?.(req);
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(status));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

console.log("\n── 403 = 围栏把本机权威拒了 ──");

await test("403 → fenced=true，note 说清是 /api 围栏与 host:port", async () => {
  const peer = await fakePeer(403);
  try {
    const probe = await probeApiFence(peer.base);
    assert.equal(probe.fenced, true);
    assert.match(probe.note, /403/);
    // note 里要带上**对端权威**（host:port），否则用户不知道该给对端登记什么。
    assert.ok(probe.note.includes(new URL(peer.base).host), `note 里没有权威 ${new URL(peer.base).host}`);
    assert.match(probe.note, /trustedHosts/);
  } finally {
    await peer.close();
  }
});

await test("探测路径落在 /api 前缀下（围栏在路由之前执行）", async () => {
  let seen = "";
  const peer = await fakePeer(403, { onRequest: (req) => { seen = req.url ?? ""; } });
  try {
    await probeApiFence(peer.base);
    assert.equal(seen, API_FENCE_PROBE_PATH);
    assert.ok(seen.startsWith("/api/"), `${seen} 不在 /api 前缀下`);
  } finally {
    await peer.close();
  }
});

await test("探测是只读的：不带 Cookie、不带 Authorization", async () => {
  let headers = {};
  const peer = await fakePeer(403, { onRequest: (req) => { headers = req.headers; } });
  try {
    await probeApiFence(peer.base);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["x-dsh-mesh-token"], undefined);
  } finally {
    await peer.close();
  }
});

console.log("\n── 401/200/404 = 围栏过了，只是没登录（不能误判） ──");

for (const status of [401, 200, 404]) {
  await test(`${status} → fenced=false`, async () => {
    const peer = await fakePeer(status);
    try {
      const probe = await probeApiFence(peer.base);
      assert.equal(probe.fenced, false, `${status} 被误判成围栏拒绝`);
      assert.match(probe.note, new RegExp(String(status)));
    } finally {
      await peer.close();
    }
  });
}

console.log("\n── 没有结论时不撒谎 ──");

await test("连不上 → fenced=undefined（不是 false，也不是 true）", async () => {
  const probe = await probeApiFence("http://127.0.0.1:1/", { timeoutMs: 300 });
  assert.equal(probe.fenced, undefined);
  assert.match(probe.note, /300ms|没有响应/);
});

await test("地址解析不了 → fenced=undefined", async () => {
  const probe = await probeApiFence("not-a-url");
  assert.equal(probe.fenced, undefined);
  assert.match(probe.note, /解析不了/);
});

await test("对端不答（挂住）→ 超时后 fenced=undefined，如实报超时", async () => {
  const server = createServer(() => { /* 永不响应 */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const started = Date.now();
    const probe = await probeApiFence(`http://127.0.0.1:${port}/`, { timeoutMs: 200 });
    assert.equal(probe.fenced, undefined);
    assert.ok(Date.now() - started < 2000, "超时没生效");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

console.log(`\n${failed === 0 ? "✓" : "✗"} web-fence: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
