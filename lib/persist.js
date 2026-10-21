/**
 * 把「内存态」的两样东西落到磁盘，重启后还能看见：
 *
 *   1. 任务记录（收件箱 / 发件箱）—— 原来只是两个数组，重启即清空，
 *      排查"刚才到底派了什么"时只能去翻会话记录。
 *   2. 机器列表 —— 靠组播/扫描重新发现，重启后的头几十秒里页面是空的，
 *      离线机器更是要等下一次扫到才回来。
 *
 * 设计取舍：
 *   · **只存展示与恢复所需的最小集**，不存整条内部记录（避免把内部字段固化）。
 *   · 任务正文有上限（TASK_TEXT_LIMIT）：单个任务最大 256KB，200 条不设限会写出
 *     几十 MB 的文件，而且是每次派发都写。超限截断并留标记，不假装完整。
 *   · 写入用「临时文件 + rename」，避免进程在写一半时被杀导致 JSON 半截、
 *     下次启动整个文件读不出来。
 *   · 读失败一律当成"没有历史"，绝不让恢复流程把插件启动搞挂。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { APP_TAG } from "./discovery.js";

/** 与 index.js 的 MAX_HISTORY 对齐（两边都 200；这里独立常量避免循环依赖）。 */
export const MAX_RECORDS = 200;

/** 单条任务正文的持久化上限。超出截断并打标记。 */
export const TASK_TEXT_LIMIT = 4000;

const tasksFile = (dir) => join(dir, "tasks.json");
const peersFile = (dir) => join(dir, "peers.json");

function atomicWrite(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path); // 同一目录内 rename 是原子的
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 截断过长的任务正文；保持其它字段原样。 */
export function trimTaskRecord(rec) {
  if (!rec || typeof rec !== "object") return null;
  const out = { ...rec };
  const text = typeof out.task === "string" ? out.task : "";
  if (text.length > TASK_TEXT_LIMIT) {
    out.task = `${text.slice(0, TASK_TEXT_LIMIT)}…（已截断，原文 ${text.length} 字）`;
    out.taskTruncated = true;
  }
  return out;
}

/**
 * 读任务历史。
 * @returns {{inbound: object[], outbound: object[], savedAt: number}}
 */
export function loadTaskHistory(dir) {
  try {
    const raw = JSON.parse(readFileSync(tasksFile(dir), "utf8"));
    const pick = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []).slice(-MAX_RECORDS);
    return {
      inbound: pick(raw?.inbound),
      outbound: pick(raw?.outbound),
      savedAt: Number(raw?.savedAt) || 0,
    };
  } catch {
    return { inbound: [], outbound: [], savedAt: 0 };
  }
}

/**
 * 写任务历史（只保留最后 MAX_RECORDS 条）。
 * @returns {boolean} 是否写成功（失败不影响派发）
 */
export function saveTaskHistory(dir, inbound, outbound) {
  try {
    ensureDir(dir);
    const body = {
      version: 1,
      savedAt: Date.now(),
      inbound: (inbound ?? []).slice(-MAX_RECORDS).map(trimTaskRecord).filter(Boolean),
      outbound: (outbound ?? []).slice(-MAX_RECORDS).map(trimTaskRecord).filter(Boolean),
    };
    atomicWrite(tasksFile(dir), JSON.stringify(body, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 discover.peers() 的投影列表压成可恢复的快照。
 * 只留自述字段 + 端点，能力名片原样带上（它已经被净化过）。
 */
export function toPeerSnapshot(peers) {
  return (peers ?? [])
    .filter((p) => p && p.id)
    .map((p) => ({
      record: {
        app: APP_TAG,
        id: String(p.id),
        machine: String(p.machine ?? ""),
        hostname: String(p.hostname ?? ""),
        mac: String(p.mac ?? ""),
        os: String(p.os ?? ""),
        user: String(p.user ?? ""),
        profile: String(p.profile ?? ""),
        version: String(p.version ?? ""),
        // 设备级 lastSeen 不在 health 记录里，用端点时间还原；这里给 ts 兜底
        ts: Number(p.ts) || 0,
        port: Number(p.port) || 0,
        host: String(p.host ?? ""),
        capabilities: p.capabilities ?? null,
      },
      endpoints: (Array.isArray(p.endpoints) ? p.endpoints : [])
        .filter((e) => e && e.transport)
        .map((e) => ({
          transport: String(e.transport),
          host: String(e.host ?? ""),
          port: Number(e.port) || 0,
          lastSeen: Number(e.lastSeen) || 0,
          lastOkAt: Number(e.lastOkAt) || 0,
          verified: e.verified === true,
        })),
    }));
}

export function loadPeerSnapshot(dir) {
  try {
    const raw = JSON.parse(readFileSync(peersFile(dir), "utf8"));
    const list = Array.isArray(raw?.peers) ? raw.peers : [];
    return {
      peers: list.filter((p) => p && p.record && typeof p.record.id === "string"),
      savedAt: Number(raw?.savedAt) || 0,
    };
  } catch {
    return { peers: [], savedAt: 0 };
  }
}

export function savePeerSnapshot(dir, peers) {
  try {
    ensureDir(dir);
    const body = { version: 1, savedAt: Date.now(), peers: toPeerSnapshot(peers) };
    atomicWrite(peersFile(dir), JSON.stringify(body, null, 2));
    return true;
  } catch {
    return false;
  }
}
