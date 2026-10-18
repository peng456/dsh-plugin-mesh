/**
 * 本地状态落盘（state.json / threads.json）。
 *
 * 为什么要单独一层：
 *   · DSH 允许同一台机器跑多个 profile，它们共用同一个 state.json；
 *     直接 writeFileSync 时，另一个进程可能读到写了一半的 JSON。
 *   · state.json 里有配对开关与配对码。解析失败时如果当成 {}，配对会**静默关闭**
 *     （fail-open），这是安全边界上的事故。
 *   · 写坏一次就会连带丢 instanceIds / machineName / tsnet 配置。
 *
 * 做法：
 *   · 原子写：先写同目录 tmp，再 rename；rename 前把可解析的旧文件留成 .bak。
 *   · 读取失败先尝试 .bak；两者都坏才标记 unhealthy，由调用方 fail-closed。
 *   · 跨进程写用 state.json.lock 串行化（拿不到锁也继续原子写，至少不会写坏）。
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

let health = { ok: true, error: "", recovered: false, checkedAt: 0 };

export function stateDir() {
  const base = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(base, "mesh");
}

export function statePath() {
  return join(stateDir(), "state.json");
}

export function threadsPath() {
  return join(stateDir(), "threads.json");
}

function backupPath(file) {
  return `${file}.bak`;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 最近一次读取/写入的健康状况，给 UI/诊断用。 */
export function stateHealth() {
  return { ...health };
}

function readJson(file) {
  const text = readFileSync(file, "utf8");
  return JSON.parse(text);
}

/**
 * 读取 state.json。
 *   · 文件不存在 → {}（首次运行）
 *   · 解析失败 → 尝试 .bak；成功则标记 recovered
 *   · 两者都失败 → health.ok=false，返回 {}；调用方必须 fail-closed
 */
export function loadState() {
  const file = statePath();
  try {
    const data = readJson(file);
    if (!isPlainObject(data)) throw new Error("state.json 顶层不是对象");
    health = { ok: true, error: "", recovered: false, checkedAt: Date.now() };
    return data;
  } catch (err) {
    if (err?.code === "ENOENT") {
      health = { ok: true, error: "", recovered: false, checkedAt: Date.now() };
      return {};
    }
    const primaryError = String(err?.message ?? err);
    try {
      const bak = readJson(backupPath(file));
      if (isPlainObject(bak)) {
        health = {
          ok: true,
          error: `state.json 损坏（${primaryError}），已从 .bak 恢复`,
          recovered: true,
          checkedAt: Date.now(),
        };
        return bak;
      }
    } catch {
      /* .bak 也没有 / 也坏了 */
    }
    health = { ok: false, error: primaryError, recovered: false, checkedAt: Date.now() };
    return {};
  }
}

/** 同步小睡，供锁重试；不阻塞事件循环太久（最多几百毫秒）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(timeoutMs = 300) {
  const lock = `${statePath()}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeFileSync(fd, String(process.pid));
      } catch {
        /* 内容只是辅助排障 */
      }
      return { fd, lock };
    } catch (err) {
      if (err?.code !== "EEXIST") return null;
      try {
        // 崩溃残留的锁：超过 5s 视为失效
        if (Date.now() - statSync(lock).mtimeMs > 5000) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        /* 锁刚好被释放 */
      }
      if (Date.now() >= deadline) return null;
      sleepSync(10);
    }
  }
}

function releaseLock(lock) {
  if (!lock) return;
  try {
    closeSync(lock.fd);
  } catch {
    /* 已关闭 */
  }
  try {
    unlinkSync(lock.lock);
  } catch {
    /* 已删除 */
  }
}

/**
 * 原子写 JSON：tmp → rename；rename 前把**可解析**的旧文件留成 .bak。
 * 返回 undefined；失败会抛，调用方自己决定是否吞掉。
 */
export function atomicWriteJson(file, value, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  try {
    try {
      // 只有能解析的旧内容才值得当备份
      JSON.parse(readFileSync(file, "utf8"));
      copyFileSync(file, backupPath(file));
    } catch {
      /* 首次写 / 旧文件已损坏：不覆盖 .bak */
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 已经 rename 走了 */
    }
    throw err;
  }
}

/**
 * 读-改-写 state.json。锁拿不到也继续写：原子 rename 仍能保证不会出现半截 JSON，
 * 最坏情况是两个 profile 的并发更新丢掉其中一个 key（原来的实现会直接写坏）。
 */
export function saveState(patch) {
  const file = statePath();
  const lock = acquireLock();
  try {
    const current = loadState();
    if (!stateHealth().ok && existsSync(file)) {
      // 保留现场，方便用户/排障找回 secret、instanceIds
      try {
        copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* 留证据失败不阻塞恢复 */
      }
    }
    const next = { ...current, ...patch };
    atomicWriteJson(file, next);
    health = { ok: true, error: "", recovered: false, checkedAt: Date.now() };
    return next;
  } finally {
    releaseLock(lock);
  }
}
