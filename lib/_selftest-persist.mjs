/**
 * 持久化自测：任务记录与机器列表在重启后能不能恢复，以及恢复出来的语义对不对。
 *
 * 重点不是"文件能读回来"，而是**恢复出来的机器必须是离线状态**：
 * 如果恢复时把 lastSeen 刷成 now，页面会先把一堆关机机器显示成在线，
 * 然后逐个变灰 —— 那是比"看不到机器"更糟的错觉。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTaskHistory,
  saveTaskHistory,
  trimTaskRecord,
  loadPeerSnapshot,
  savePeerSnapshot,
  toPeerSnapshot,
  MAX_RECORDS,
  TASK_TEXT_LIMIT,
} from "./persist.js";
import { MeshDiscovery, APP_TAG } from "./discovery.js";

const root = mkdtempSync(join(tmpdir(), "mesh-persist-test-"));
const cleanups = [];

function freshDir() {
  const d = mkdtempSync(join(root, "d-"));
  cleanups.push(d);
  return d;
}

try {
  // ── 任务记录：往返 ──
  {
    const dir = freshDir();
    const inbound = [{ id: "t-1", from: "B/u", task: "hello", status: "dispatched" }];
    const outbound = [{ id: "t-2", toMachine: "B", task: "hi", ok: true, status: 200 }];
    assert.equal(saveTaskHistory(dir, inbound, outbound), true, "应当写成功");
    const back = loadTaskHistory(dir);
    assert.equal(back.inbound.length, 1);
    assert.equal(back.outbound.length, 1);
    assert.equal(back.inbound[0].id, "t-1");
    assert.equal(back.outbound[0].status, 200);
    assert.ok(back.savedAt > 0);
    console.log("✓ 任务记录写入后能原样读回");
  }

  // ── 任务记录：上限与截断 ──
  {
    const dir = freshDir();
    const many = Array.from({ length: MAX_RECORDS + 37 }, (_, i) => ({ id: `t-${i}`, task: "x" }));
    saveTaskHistory(dir, many, []);
    const back = loadTaskHistory(dir);
    assert.equal(back.inbound.length, MAX_RECORDS, `只保留最后 ${MAX_RECORDS} 条`);
    assert.equal(back.inbound.at(-1).id, `t-${MAX_RECORDS + 36}`, "保留的是最新的那批");

    const long = { id: "t-long", task: "啊".repeat(TASK_TEXT_LIMIT + 500) };
    const trimmed = trimTaskRecord(long);
    assert.ok(trimmed.task.length < long.task.length, "超长正文必须被截断");
    assert.equal(trimmed.taskTruncated, true, "截断要留标记，不能假装完整");
    assert.ok(trimmed.task.includes("已截断"), "要说明被截断了");
    console.log("✓ 超量滚动、超长正文截断且留标记");
  }

  // ── 坏文件不能把启动搞挂 ──
  {
    const dir = freshDir();
    saveTaskHistory(dir, [{ id: "a" }], []);
    // 模拟写到一半被杀
    const p = join(dir, "tasks.json");
    const raw = readFileSync(p, "utf8");
    writeFileSync(p, raw.slice(0, Math.floor(raw.length / 2)));
    const back = loadTaskHistory(dir);
    assert.deepEqual(back.inbound, [], "半截 JSON 应当当成没有历史");
    console.log("✓ 半截文件按「没有历史」处理，不抛错");
  }

  // ── 机器列表：快照往返 ──
  {
    const dir = freshDir();
    const now = Date.now();
    const peers = [{
      id: "peer-1", machine: "hos", hostname: "localhost", mac: "", os: "android",
      user: "u0", profile: "web", version: "0.3.36", host: "192.168.1.9", port: 45917,
      ts: now - 5000, capabilities: null,
      endpoints: [{ transport: "lan", host: "192.168.1.9", port: 45917, lastSeen: now - 5000, lastOkAt: now - 5000, verified: true }],
    }];
    assert.equal(savePeerSnapshot(dir, peers), true);
    const snap = loadPeerSnapshot(dir);
    assert.equal(snap.peers.length, 1);
    assert.equal(snap.peers[0].record.id, "peer-1");
    assert.equal(snap.peers[0].record.app, APP_TAG);
    assert.equal(snap.peers[0].endpoints[0].lastSeen, now - 5000, "必须保留原始 lastSeen");
    console.log("✓ 机器列表快照往返，lastSeen 原样保留");
  }

  // ── 恢复语义：离线、带标记、不覆盖现网 ──
  {
    const dir = freshDir();
    const d = new MeshDiscovery({ id: "me", port: 0, meta: { machine: "me" } });
    const stale = Date.now() - 3600_000; // 一小时前见过
    const peer = {
      id: "old-peer", machine: "old", host: "10.0.0.9", port: 45917, ts: stale,
      endpoints: [{ transport: "lan", host: "10.0.0.9", port: 45917, lastSeen: stale, lastOkAt: stale, verified: true }],
    };
    savePeerSnapshot(dir, [peer]);

    const n = d.restore(loadPeerSnapshot(dir).peers);
    assert.equal(n, 1, "应当恢复 1 台");
    const after = d.peers().find((p) => p.id === "old-peer");
    assert.ok(after, "恢复的机器要出现在列表里");
    assert.equal(after.restored, true, "要能区分「上次见到」与「这次见到」");
    assert.equal(after.online, false, "一小时前的记录不能算在线");
    assert.equal(after.host, "10.0.0.9", "地址要能显示出来");
    // 恢复的机器没有任何通道在用：以前这里填了"最近一条端点"，界面就标成「在用」，
    // 而对方其实已经离线 —— 真机一眼看出来的那个错。
    assert.equal(after.transport, null, "不能让界面以为某条通道在用");
    assert.equal(d.isRestoredOnly("old-peer"), true, "应当被标成「只在缓存里」");

    // 再次恢复同一份快照：不能重复插入
    assert.equal(d.peers().filter((p) => p.id === "old-peer").length, 1, "不能出现两条");

    // 现网重新发现 → 只剩活记录，且不再是"恢复的"
    d.note({
      app: APP_TAG, id: "old-peer", machine: "old", host: "10.0.0.9", port: 45917,
      hostname: "old.local", ts: Date.now(),
    }, "10.0.0.9");
    const hits = d.peers().filter((p) => p.id === "old-peer");
    assert.equal(hits.length, 1, "缓存与活记录不能同时存在");
    assert.equal(hits[0].restored, false, "重新发现后要去掉「上次见到」标记");
    assert.equal(hits[0].online, true, "刚收到心跳就是在线");
    assert.equal(d.isRestoredOnly("old-peer"), false);

    // 自己的 id 不能被"恢复"成一台对端
    assert.equal(d.restore([{ record: { app: APP_TAG, id: "me", machine: "me" }, endpoints: [{ transport: "lan", host: "1.1.1.1", port: 1 }] }]), 0);
    console.log("✓ 恢复语义正确：离线、带标记、不重复、不冒充自己、重新发现后转在线");
  }

  // ── 回归：恢复出来的机器不能被清扫删掉 ──
  //
  // 第一版实现把缓存塞进活跃注册表，而 #sweep() 会摘掉 keepMs 之外的端点、
  // 端点全没了就删设备。缓存条目的 lastSeen 天然是旧的，于是恢复出来的离线机器
  // 活不过一个清扫周期（实测 5 秒内消失）—— 而离线机器正是恢复功能唯一的价值。
  // 这里用很小的 ttlMs 逼出清扫，直接验证它活着。
  {
    const d = new MeshDiscovery({ id: "me2", port: 0, meta: { machine: "me2" }, ttlMs: 1200 });
    const veryOld = Date.now() - 10 * 3600_000; // 十小时前
    d.restore([{
      record: { app: APP_TAG, id: "offline-peer", machine: "offline", host: "10.0.0.7", port: 45917, ts: veryOld },
      endpoints: [{ transport: "lan", host: "10.0.0.7", port: 45917, lastSeen: veryOld, lastOkAt: veryOld, verified: true }],
    }]);
    d.start({ multicast: false }); // 只为了让清扫定时器跑起来
    await new Promise((r) => setTimeout(r, 2200)); // 至少跨过一个清扫周期
    const kept = d.peers().find((p) => p.id === "offline-peer");
    assert.ok(kept, "恢复出来的离线机器必须扛得住清扫（第一版就是在这里丢的）");
    assert.equal(kept.online, false);
    d.stop?.();
    console.log("✓ 恢复的机器跨过清扫周期仍在（回归已钉住）");
  }

  // ── 列表排序：在线的排前面 ──
  //
  // 真机反馈：离线的 hos 排在了在线的 myserver 前面（原来只按机器名排）。
  {
    const d = new MeshDiscovery({ id: "me3", port: 0, meta: { machine: "me3" }, ttlMs: 60000 });
    const old = Date.now() - 3600_000;
    // 缓存里放一台机器名靠前的离线机器（hos），活的放一台机器名靠后的（myserver）
    d.restore([{
      record: { app: APP_TAG, id: "p-hos", machine: "hos", host: "10.0.0.5", port: 45917, ts: old },
      endpoints: [{ transport: "lan", host: "10.0.0.5", port: 45917, lastSeen: old, verified: true }],
    }]);
    d.note({
      app: APP_TAG, id: "p-myserver", machine: "myserver", host: "10.0.0.6", port: 45917, ts: Date.now(),
    }, "10.0.0.6");
    const order = d.peers().map((p) => p.machine);
    assert.deepEqual(order, ["myserver", "hos"], `在线应排在离线前，实际：${order.join(",")}`);
    assert.equal(d.peers()[0].online, true);
    console.log("✓ 列表排序：在线优先，离线的「上次见到」排最后");
  }

  // ── 缺文件 / 空目录 ──
  {
    const dir = freshDir();
    assert.deepEqual(loadTaskHistory(dir), { inbound: [], outbound: [], savedAt: 0 });
    assert.deepEqual(loadPeerSnapshot(dir), { peers: [], savedAt: 0 });
    assert.equal(existsSync(join(dir, "tasks.json")), false);
    console.log("✓ 没有历史文件时安静返回空，不抛错");
  }

  console.log("\n全部通过");
} finally {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
