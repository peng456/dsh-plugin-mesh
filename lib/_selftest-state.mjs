/**
 * state.json 原子写 / 备份恢复 / fail-closed 的自测。
 *
 * 全部在临时 DSH_HOME 里跑，不碰真实的 ~/.dsh。
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, loadState, saveState, stateHealth, statePath, threadsPath } from "./state.js";

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

const home = mkdtempSync(join(tmpdir(), "mesh-state-"));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;

function reset() {
  rmSync(join(home, "mesh"), { recursive: true, force: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

try {
  console.log("\n── 原子写与 .bak ──");

  check("save/load 往返，目录自动创建，无残留 tmp/lock", () => {
    reset();
    saveState({ secret: "s".repeat(32), instanceIds: { desktop: "a0072fdf3f2e72e3" } });
    assert.ok(existsSync(statePath()));
    const loaded = loadState();
    assert.equal(loaded.secret, "s".repeat(32));
    assert.equal(loaded.instanceIds.desktop, "a0072fdf3f2e72e3");
    assert.equal(stateHealth().ok, true);
    const leftovers = readdirSync(join(home, "mesh")).filter((n) => n.includes(".tmp") || n.endsWith(".lock"));
    assert.deepEqual(leftovers, []);
  });

  check("第二次写入前把可解析的旧文件留成 .bak", () => {
    reset();
    saveState({ secret: "first", machineName: "before" });
    saveState({ machineName: "after" });
    const bak = readJson(`${statePath()}.bak`);
    assert.equal(bak.secret, "first");
    assert.equal(bak.machineName, "before");
    assert.equal(loadState().machineName, "after");
  });

  console.log("\n── 损坏恢复与 fail-closed ──");

  check("主文件损坏 + .bak 有效 → 从 .bak 恢复并标记 recovered", () => {
    reset();
    saveState({ secret: "good", requirePairing: true });
    const bak = readJson(statePath());
    writeFileSync(`${statePath()}.bak`, JSON.stringify(bak));
    writeFileSync(statePath(), "{ this is not json");
    const loaded = loadState();
    assert.equal(loaded.secret, "good");
    assert.equal(stateHealth().ok, true);
    assert.equal(stateHealth().recovered, true);
    assert.match(stateHealth().error, /损坏/);
  });

  check("主文件与 .bak 都坏 → health.ok=false（调用方必须 fail-closed）", () => {
    reset();
    mkdirSync(join(home, "mesh"), { recursive: true });
    writeFileSync(statePath(), "{ bad");
    writeFileSync(`${statePath()}.bak`, "also bad");
    assert.deepEqual(loadState(), {});
    assert.equal(stateHealth().ok, false);
  });

  check("损坏后 saveState：保留 .corrupt-* 现场，再写新状态", () => {
    reset();
    mkdirSync(join(home, "mesh"), { recursive: true });
    writeFileSync(statePath(), "{ bad");
    saveState({ secret: "rebuilt", requirePairing: true });
    const corrupt = readdirSync(join(home, "mesh")).filter((n) => n.includes(".corrupt-"));
    assert.equal(corrupt.length, 1, `应保留一份损坏现场，实际 ${corrupt}`);
    assert.equal(readJson(statePath()).secret, "rebuilt");
    assert.equal(stateHealth().ok, true);
  });

  console.log("\n── threads.json 与锁 ──");

  check("threads.json 也走原子写", () => {
    reset();
    atomicWriteJson(threadsPath(), { version: 1, threads: { k: { wakesAt: [1, 2], sessionId: "s" } }, capOverrides: {} });
    assert.equal(readJson(threadsPath()).threads.k.sessionId, "s");
    const leftovers = readdirSync(join(home, "mesh")).filter((n) => n.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  check("过期锁（>5s）会被清掉，写入继续", () => {
    reset();
    mkdirSync(join(home, "mesh"), { recursive: true });
    const lock = `${statePath()}.lock`;
    writeFileSync(lock, "999");
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    saveState({ secret: "after-stale-lock" });
    assert.equal(loadState().secret, "after-stale-lock");
    assert.equal(existsSync(lock), false);
  });

  check("锁被活进程占用时等 300ms 后仍原子写入（不让派发挂死）", () => {
    reset();
    mkdirSync(join(home, "mesh"), { recursive: true });
    const lock = `${statePath()}.lock`;
    writeFileSync(lock, "123");
    const started = Date.now();
    saveState({ secret: "best-effort" });
    const waited = Date.now() - started;
    assert.ok(waited >= 250, `应至少等一次锁超时，实际 ${waited}ms`);
    assert.equal(readJson(statePath()).secret, "best-effort");
    assert.equal(existsSync(lock), true, "别人的锁不该被我们删");
  });
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
