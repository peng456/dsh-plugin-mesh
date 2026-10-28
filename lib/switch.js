/**
 * Mesh 一键关闭（kill switch）的判定与合并 —— 纯函数，便于单测。
 *
 * 单独成模块的理由和 pairing.js 一样：这是**安全相关**的判定。用户点了一键
 * 关闭，如果判定写错（比如把字符串 "true" 当关闭、或者"关闭全部"只关了一半），
 * 界面上照样显示"已关闭"，实际上端口还开着、组播还发着 —— 这种错误看不见。
 * 埋在一个 3000 行的文件里没人会为它写测试，所以拆出来、单测它。
 *
 * 三种范围：
 *   · `lan`       局域网 mesh：组播广播、主动扫描、ping，对端 HTTP 端口只绑回环
 *   · `internet`  互联网 mesh：停掉全部 tailnet sidecar（通道配置保留，可再打开）
 *   · `all`       两者都关 —— 就是「一键关闭 Mesh」
 *
 * 状态存在 state.json 的 `shutdown` 字段里：
 *
 *   { "lan": true, "internet": false, "at": "2026-01-01T00:00:00.000Z", "by": "ui" }
 *
 * `true` = **已关闭**；缺失 / false = 开着（与历史行为一致 —— 升级不会突然把
 * 所有人的 mesh 断开）。落盘而不是只放内存：一键关闭的语义是"我现在不想让这台
 * 机器被找到、被派活"，重启 DSH 后自己悄悄恢复是最坏的结果。
 */

/** 允许的范围。顺序即界面顺序：全部 → 局域网 → 互联网。 */
export const MESH_SWITCH_SCOPES = ["all", "lan", "internet"];

/** 范围的中文名（日志、工具回执、界面共用同一套说法）。 */
export const MESH_SWITCH_LABEL = {
  all: "全部 mesh",
  lan: "局域网 mesh",
  internet: "互联网 mesh",
};

/**
 * 把用户/agent 传来的范围归一化。
 *
 * 除了英文 id，也接受界面上那三个中文词 —— agent 很容易直接照着界面文案
 * 传「局域网」，拒掉它只会让人以为功能坏了。
 *
 * @returns {"all"|"lan"|"internet"|""} 不认识时返回空串（调用方报错）
 */
export function normalizeSwitchScope(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s === "all" || s === "全部" || s === "全部mesh" || s === "全部 mesh") return "all";
  if (s === "lan" || s === "局域网" || s === "局域网mesh" || s === "局域网 mesh") return "lan";
  if (s === "internet" || s === "互联网" || s === "互联网mesh" || s === "互联网 mesh") return "internet";
  return "";
}

/**
 * state.json 里的 `shutdown` → 期望状态。
 *
 * 只有严格的布尔 true 才算关闭。从 YAML / 手工编辑里读出来的字符串 "true"
 * 不算 —— 和 pairing.js 同一条规则：宁可当作"没关"，也不要让一个看起来
 * 生效、实际没生效的开关骗人。
 *
 * @param {object} state state.json 解析结果
 * @returns {{lan: boolean, internet: boolean, all: boolean, at: string, by: string}}
 *   lan/internet = **是否已关闭**；all = 两者都关。
 */
export function resolveMeshSwitch(state = {}) {
  const raw = state && typeof state === "object" ? state.shutdown : null;
  const off = (v) => v === true;
  const lan = off(raw?.lan);
  const internet = off(raw?.internet);
  return {
    lan,
    internet,
    all: lan && internet,
    at: typeof raw?.at === "string" ? raw.at : "",
    by: typeof raw?.by === "string" ? raw.by : "",
  };
}

/**
 * 一次开关操作之后要写进 `state.shutdown` 的对象（不修改入参）。
 *
 * `off` 默认 **true**：一键关闭是主动作，调用方漏传时按"关"处理更像用户的意图。
 * 但这只影响 `off` 的缺省，不影响范围 —— 范围不认识就直接抛错，绝不猜。
 *
 * @param {{lan?: boolean, internet?: boolean}|null} current 当前状态（resolveMeshSwitch 的结果）
 * @param {{scope?: string, off?: boolean, by?: string, at?: string}} op
 * @returns {{lan: boolean, internet: boolean, at: string, by: string}}
 */
export function applyMeshSwitch(current, { scope, off = true, by = "ui", at = new Date().toISOString() } = {}) {
  const s = normalizeSwitchScope(scope);
  if (!s) {
    throw new Error(`未知的开关范围：${String(scope)}（应为 all / lan / internet）`);
  }
  const want = off !== false;
  const next = {
    lan: current ? current.lan === true : false,
    internet: current ? current.internet === true : false,
  };
  if (s === "all" || s === "lan") next.lan = want;
  if (s === "all" || s === "internet") next.internet = want;
  return { ...next, at, by: String(by || "ui") };
}

/**
 * 一行中文摘要，给工具回执 / mesh_peers 用。
 *
 * 刻意把"关"和"开"都说出来（不只说关了什么）：agent 读到这行时要能判断
 * 现在到底能不能派任务，而不是靠猜。
 */
export function describeMeshSwitch(sw = {}) {
  const state = (off) => (off ? "已关闭" : "开启");
  if (sw.lan === true && sw.internet === true) return "mesh 已全部关闭（局域网 + 互联网）";
  return `局域网 ${state(sw.lan)} · 互联网 ${state(sw.internet)}`;
}
