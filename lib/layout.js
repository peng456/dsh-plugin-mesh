/**
 * Mesh 目录布局。
 *
 * 每个 DSH profile 根目录下有一个 `mesh/`：
 *
 *   <profile>/mesh/
 *     state.json       本 profile 的身份、配对码、tsnet 设置
 *     threads.json     conversationId ↔ 本地 session 绑定
 *     sessions/
 *       <sessionId>/   该会话的工作目录（cwd）
 *
 * 为什么按 profile 而不是按 DSH_HOME：同一个 DSH_HOME 下可能跑多个 profile
 * （desktop / meshtest / 不同账号），state.json 里的配对码是信任边界，不能
 * 跨 profile 共享。按 profile 分目录后，每个 profile 有自己的配对码与会话工作区。
 *
 * 例外：tsnet 的 sidecar 仍是整机一个 tailnet 节点，继续放在共享目录，
 * 不在本模块的职责内（见 lib/tsnet/manager.js）。
 */
import { basename, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 从 import.meta.url 推导 profile 根目录。
 *
 * 插件被 DSH 加载时路径是：
 *   <profileDir>/node_modules/dsh-plugin-mesh/lib/index.js
 * 从 lib/index.js 往上三层正好是 profileDir。
 * 开发目录（如 <repo>/lib/index.js）会推到 repo 的上级，由 isProfileDir 再确认。
 */
export function profileDirFromModuleUrl(moduleUrl) {
  try {
    const dir = resolve(fileURLToPath(new URL("../../..", moduleUrl)));
    return dir && basename(dir) ? dir : "";
  } catch {
    return "";
  }
}

/**
 * profile 根目录的判据：package.json 里有 dsh.profile。
 *
 * 不用「目录存在」当判据：开发目录也有一堆 package.json，但那是插件/仓库，
 * 不是 DSH profile。写错位置的后果是把 mesh/ 建到仓库根目录。
 */
export function isProfileDir(dir) {
  if (!dir) return false;
  try {
    // Windows 上手工编辑过的 package.json 可能带 BOM；JSON.parse 不认。
    const raw = readFileSync(join(dir, "package.json"), "utf8").replace(/^\uFEFF/, "");
    const pkg = JSON.parse(raw);
    return Boolean(pkg?.dsh?.profile);
  } catch {
    return false;
  }
}

/**
 * 选择 mesh 根目录。只做路径计算，不创建目录。
 *
 * 优先级：profileDir/mesh > DSH_HOME/mesh > ~/.dsh/mesh。
 */
export function chooseMeshRoot({ profileDir = "", dshHome = "", homeDir = "" } = {}) {
  if (profileDir) return join(profileDir, "mesh");
  const base = dshHome || join(homeDir || ".", ".dsh");
  return join(base, "mesh");
}

/** 每个会话的独立工作目录：<meshRoot>/sessions/<safeSessionId>。 */
export function sessionDirFor(meshRoot, sessionId) {
  return join(meshRoot, "sessions", safeSegment(sessionId));
}

/**
 * 收到的 mesh 任务统一使用的**共享**工作区。
 *
 * 为什么不再按 session 分目录：每来一条任务就在 `sessions/<uuid>` 下新开一个
 * 工作区，会话列表里会看到一堆散落的目录/会话，用户根本分不清哪个是哪个；
 * 而 mesh 任务多数是"看一眼、回一句"，本来也不需要在独立目录里隔离。
 *
 * 代价：同一时间多条任务共用一个 cwd，文件会互相看见。对 mesh 的用法来说这是
 * 可接受的；确实需要隔离时用 task.workspace 指定即可（resolveWorkspace 已优先）。
 */
export function receiveWorkspaceDir(meshRoot) {
  return join(meshRoot, "mesh-receive-task");
}

/**
 * 把 sessionId 变成安全目录名。
 *
 * sessionId 是 `mesh-<uuid>`，本来只含 [a-z0-9-]；这里仍然过滤一次，
 * 防止未来换 id 生成方式后出现 `../` 或路径分隔符。
 */
export function safeSegment(id) {
  const s = String(id ?? "").trim();
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "session";
}

/** 旧版状态目录：<DSH_HOME>/mesh。只用于迁移，不用于新状态。 */
export function legacyMeshDir({ dshHome = "", homeDir = "" } = {}) {
  const base = dshHome || join(homeDir || ".", ".dsh");
  return join(base, "mesh");
}

/** 新状态文件是否已存在（迁移判据）。 */
export function hasState(meshRoot) {
  return existsSync(join(meshRoot, "state.json"));
}

/**
 * 把旧共享目录里的状态文件复制到新 mesh 根。
 *
 * 只复制不删除；目标已存在或源不存在就跳过，所以幂等、可回退。
 * 返回实际复制的文件名（测试/日志用）。
 */
export function copyLegacyFiles(root, legacy, names = ["state.json", "threads.json"]) {
  if (!root || !legacy || resolve(root) === resolve(legacy)) return [];
  const copied = [];
  for (const name of names) {
    const src = join(legacy, name);
    const dst = join(root, name);
    if (existsSync(dst) || !existsSync(src)) continue;
    try {
      writeFileSync(dst, readFileSync(src), { mode: 0o600 });
      copied.push(name);
    } catch {
      /* 迁移失败不阻塞启动；下次启动再试 */
    }
  }
  return copied;
}
