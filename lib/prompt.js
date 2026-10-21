/**
 * 生成投递给 agent 的任务提示词。
 *
 * 单独成一个模块（而不是留在 index.js 里）的原因：它是**纯文本生成**、不碰
 * 任何 DSH 上下文，而 index.js 依赖一堆 `@deepseek-ai/*` 包、单测里 import 不了。
 * 实测教训：这里曾经把 `from`（形状是 `机器名/用户`）写进"回派给谁"的指令，
 * 而 `mesh_run` 的 peer 参数要的是**机器名** —— 于是每个收到任务的对端 agent
 * 都会拿着 `lipeng-mac/peng` 去派发、被 findPeer 拒绝、白费一轮。
 * 这种 bug 只有能单测才防得住。
 */

/**
 * 「手动派发」在会话里留下的第一条消息。
 *
 * 为什么需要：派发时会预建一个会话等回执，但如果它是空的，用户点进去只看到
 * 「暂无消息」，不知道自己发了什么。这里把原文摆进第一条，并明确告诉 agent
 * **不要再调 mesh_run** —— 宿主已经替它发出去了，重复调用会让对端收到两份。
 */
/**
 * @param input 入参可能是两种形状：webhook delivery（deliveryId/source）或
 *   mesh task（id/from）。两条入站路径都会走到这里，所以统一做一次归一化 ——
 *   曾经因为只认前者，导致提示词里出现 "任务 undefined / 来自 undefined"。
 */
export function buildPrompt(input) {
  const id = input?.deliveryId ?? input?.id ?? "unknown";
  const from = input?.source ?? input?.from ?? "unknown";
  const thread = input?.thread || id;

  // 回派时该填的机器名。
  //
  // `from` 的形状是 `${machine}/${user}`（见 mesh_run / /mesh/api/send 里构造
  // payload 的地方），而 **mesh_run 的 peer 参数要的是机器名**，不是"机器名/用户"。
  // 直接把它塞进指令，对端 agent 就会派发到不存在的名字上。实测被 hos 抓到：
  // 它按指令直发被拒，自己改成机器名才成功 —— **agent 能自救不代表指令是对的**。
  //
  // 优先用 fromMachine（payload 里本来就有，最可靠）；老版本对端不带这个字段时，
  // 退化成把 `/user` 后缀切掉。
  const replyTo = String(input?.fromMachine || "").trim() || String(from).split("/")[0] || "unknown";

  // 「这条是回执」和「这是一条新任务」必须给 agent 完全相反的指令。
  //
  // 真机事故（2026-10-21 手动派发）：对端的回执被注入会话后，提示词仍然写着
  // 「做完后用 mesh_run 回派给 X」→ 会话里的 agent 认真照做 → 对端又把它的回执
  // 注回它自己的会话 → 两边互相回执，停不下来。
  // 回执的处理方式只有一个：**转述给用户，不要再回派**。
  const isReply = input?.isReply === true;

  return [
    `[DSH Mesh 任务 ${id}]`,
    `来自: ${from}${input?.fromMachine ? ` (${input.fromMachine})` : ""}`,
    input?.thread ? `线程: ${input.thread}` : "",
    "",
    String(input?.task ?? ""),
    "",
    // 精简原则：每条只留**可执行的动作**，删掉解释性长句。
    // 「为什么」留给本文件的注释和 docs，不放进取景框 —— 对端 agent 不需要被说服，
    // 它只需要知道做什么、别做什么。
    isReply
      ? "—— 这是回执，不是新任务：直接转述给用户，**不要再用 mesh_run 回派**（回执套回执会循环）。"
      : [
          `—— 对端派给你的任务。做完后用 mesh_run 把结果回派给 ${replyTo}（thread ${thread}），` +
            `peer 填**机器名**（${replyTo}），不要填 "机器名/用户"。`,
          "回派一次即可；纯回执带 noWake: true，否则会来回循环。",
        ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}
