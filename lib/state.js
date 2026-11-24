/**
 * `state.json` 的读写：原子落盘、损坏时用 `.bak` 恢复、坏文件留现场。
 *
 * 为什么单独成模块：这几段逻辑**踩在安全边界上** —— state.json 里存着配对码、
 * `requirePairing` 开关、`instanceIds` 和 tsnet 配置。原来的实现有两个坑：
 *
 *   · `writeFileSync` 直接写：进程在写一半时挂掉，文件就是半截 JSON；
 *   · 解析失败一律 `catch { return {} }`：配对开关随之变回默认的「关闭」，
 *     也就是**损坏 = 静默关掉配对**（fail-open）。下次 saveState 还会用 `{}`
 *     打底覆盖，把 secret 和 instanceIds 一起抹掉。
 *
 * 路径**由调用方传入**，这里不猜 `DSH_HOME`：0.5.0 起 mesh 根目录是按 profile
 * 分的（`<profile>/mesh`），再自己拼一遍路径必然和 `meshRoot()` 漂移。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/** 目录不存在、文件不存在都算「首次运行」，不是损坏。 */
const MISSING = "ENOENT";

function parsed(text, what) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} 顶层不是对象`);
  return value;
}

/**
 * 读一个 JSON 状态文件（state.json / threads.json）。
 *
 * 返回值里的 `health` 是判断「要不要 fail-closed」的唯一依据：
 *   · `{ ok: true, recovered: false }` —— 正常（含文件不存在）
 *   · `{ ok: true, recovered: true }`  —— 主文件坏了，已从 `.bak` 恢复
 *   · `{ ok: false }`                  —— 两者都坏；调用方必须当成「不可信」
 *
 * @param {string} path 文件的绝对路径
 */
export function readJsonFile(path) {
  try {
    return { data: parsed(readFileSync(path, "utf8"), basename(path)), health: { ok: true, recovered: false, error: "" } };
  } catch (err) {
    if (err?.code === MISSING) return { data: {}, health: { ok: true, recovered: false, error: "" } };
    const primary = String(err?.message ?? err);
    try {
      const data = parsed(readFileSync(`${path}.bak`, "utf8"), `${basename(path)}.bak`);
      return { data, health: { ok: true, recovered: true, error: primary } };
    } catch {
      return { data: {}, health: { ok: false, recovered: false, error: primary } };
    }
  }
}

/**
 * 原子写：先写同目录 tmp，再把**可解析**的旧文件留成 `.bak`，最后 rename。
 *
 * rename 在同一目录内是原子的，所以任何时刻读到的都是完整 JSON；`.bak` 只在
 * 旧内容确实能解析时才覆盖，避免"用坏文件盖掉最后一份好备份"。
 *
 * @param {string} path 目标文件
 * @param {unknown} value 要写入的 JSON
 * @param {{ mode?: number }} [options]
 */
export function writeJsonFile(path, value, { mode = 0o600 } = {}) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  try {
    try {
      parsed(readFileSync(path, "utf8"), basename(path));
      copyFileSync(path, `${path}.bak`);
    } catch {
      /* 首次写 / 旧文件已损坏：不动 .bak */
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 已经被 rename 走了 */
    }
    throw err;
  }
}

/**
 * 把损坏的 state.json 另存一份现场，方便排查时找回 secret / instanceIds。
 * 调用方负责「只留一份」——重复复制会把目录塞满。
 *
 * @returns {string} 复制出来的路径；没有可复制的内容时返回空串
 */
export function preserveCorrupt(path, now = Date.now()) {
  if (!existsSync(path)) return "";
  const target = `${path}.corrupt-${now}`;
  try {
    copyFileSync(path, target);
    return target;
  } catch {
    return "";
  }
}
