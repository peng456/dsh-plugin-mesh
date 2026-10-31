/**
 * 聊天窗口「@ 一台在线设备」的纯逻辑（宿主侧）。
 *
 * 用户在 composer 里打 `@`，菜单把**在线的 mesh 机器**列出来（client/client.js
 * 注册的那个 @ source）；选中后插入 `@机器名 `。发送时宿主在
 * `agent/pre-step` 里把消息开头的 @目标 认出来，把正文直接派发到那些机器 ——
 * 于是「在聊天窗口 @ 一台机器」就等于「把这句话交给那台机器」。
 *
 * 为什么只认**开头**的 @：
 *   · 正文中间的 @ 通常是「提到某台机器」或者让本机 agent 自己用 mesh_run，
 *     自动派发会在这种地方误伤；
 *   · 文件引用的序列化形式也是 `@path`（见 @deepseek-ai/dsh-client-ui-reference），
 *     而开头的 @路径 不会被误认成机器名（名字必须精确命中已知机器）。
 *
 * 本模块不读文件、不联网、不碰 ctx，全部单测覆盖（lib/_selftest-at-mention.mjs）。
 */

/** 一条消息最多认几个派发目标：再多就不是派活了，是广播。 */
export const AT_MENTION_LIMIT = 8;

/**
 * 机器名是否允许出现在 mention 里。
 *
 * 名字由用户起（validateMachineName 允许空格、禁止斜杠与控制字符），所以这里
 * 只挡掉「会破坏 mention 语法」的字符：换行、@ 本身。@ 在名字里会让
 * `@@名字` 这种写法歧义。
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isMentionableName(name) {
  const value = String(name ?? "").trim();
  if (!value) return false;
  // eslint-disable-next-line no-control-regex
  return !/[@\r\n\t\x00-\x1f\x7f]/.test(value);
}

/**
 * 从消息开头认出连续的 `@机器名`。
 *
 * 机器名可以含空格（用户起的名字），所以不能按空白切词 —— 这里按「已知名字
 * 最长优先」逐个试，命中后要求下一个字符是空白或结尾（整词边界）。匹配对大小写
 * 不敏感，返回的名字始终取已知列表里的规范写法。
 *
 * @param {string} text 消息原文（通常就是 composer 里那段文本）。
 * @param {string[]} names 当前已知的机器名（含离线；在线与否由调用方再判）。
 * @returns {{ mentions: { machine: string, raw: string }[], body: string }}
 *   `mentions` 是按出现顺序认出的目标；`body` 是去掉这些 @目标 后的任务正文。
 */
export function matchLeadingMentions(text, names) {
  const source = typeof text === "string" ? text : "";
  const known = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n ?? "").trim()).filter(isMentionableName))].sort(
    (a, b) => b.length - a.length,
  );

  const mentions = [];
  let cursor = 0;
  const skipSpace = () => {
    while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
  };
  skipSpace();
  while (mentions.length < AT_MENTION_LIMIT && source[cursor] === "@") {
    const nameStart = cursor + 1;
    let hit = null;
    for (const name of known) {
      if (source.slice(nameStart, nameStart + name.length).toLocaleLowerCase() !== name.toLocaleLowerCase()) continue;
      const after = nameStart + name.length;
      if (after < source.length && !/\s/u.test(source[after])) continue;
      hit = { machine: name, raw: source.slice(cursor, after) };
      break;
    }
    if (!hit) break;
    mentions.push(hit);
    cursor = nameStart + hit.machine.length;
    skipSpace();
  }

  return { mentions, body: source.slice(cursor).trim() };
}

/**
 * 生成这一轮要给模型看的新消息正文。
 *
 * 派发成功时告诉 agent「已经发出去了，别在本机再做一遍」（少了这句话，agent 会
 * 把正文当成本地任务直接执行 —— `/mesh/api/send` 那条路径踩过一次）；失败时
 * 把原因说清楚，并明确「没有在本机执行」，让 agent 转告用户、等用户决定。
 *
 * @param {{ body: string, results: { machine: string, id?: string, error?: string }[] }} input
 * @returns {string}
 */
export function buildAtPrompt({ body, results }) {
  const text = String(body ?? "").trim();
  const lines = [text || "（这条消息只有 @ 设备名，没有正文）", ""];
  for (const item of Array.isArray(results) ? results : []) {
    const machine = String(item?.machine ?? "").trim();
    if (item?.id) {
      lines.push(
        `[Mesh 聊天窗口派发 → ${machine}／${item.id}] 已发出。现在什么都不用做：不要调用任何工具、不要回派，` +
          `回一句「已派发给 ${machine}，等待回执」即可。`,
      );
    } else {
      lines.push(
        `[Mesh 未能派发 @${machine}：${item?.error || "未知原因"}] 这条任务没有发出，也没有在本机执行。` +
          "请把原因直接告诉用户，等用户决定下一步（不要自己动手执行这条任务）。",
      );
    }
  }
  return lines.join("\n");
}
