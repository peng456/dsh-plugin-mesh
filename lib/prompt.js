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

  return [
    `[DSH Mesh 任务 ${id}]`,
    `来自: ${from}${input?.fromMachine ? ` (${input.fromMachine})` : ""}`,
    input?.thread ? `线程: ${input.thread}` : "",
    "",
    String(input?.task ?? ""),
    "",
    "—— 这是同一局域网内另一台机器上的 agent 派给你的任务。",
    `做完后用 mesh_run 工具把结果回派给 ${replyTo}（thread 填 ${thread}）。`,
    `注意 peer 参数填**机器名**（${replyTo}），不要填 "机器名/用户"。`,
    "不要只在本地回复，对方看不到本会话。",
    "",
    "收敛要求：回派一次结果即可，不要为了『确认收到』再回一轮 —— 纯回执请带 noWake: true，" +
      "否则两边会互相回执停不下来。若本轮没有产生新的结论或文件变更，就不要回派。",
  ]
    .filter(Boolean)
    .join("\n");
}
