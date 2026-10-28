/**
 * 会话路由键。
 *
 * 这是"这条消息属于哪场对话"的判定依据 —— manager 靠它在**已有会话**和
 * **新建会话**之间做选择，限速账本也按它记账。
 *
 * ## 为什么每端各算，而不协商一个 id
 *
 * 键 = hash(发送方机器名, thread 标签)。双方都能从收到的任务里算出同一个值，
 * **不需要任何协议协商**、不需要额外的握手指令。
 *
 * 注意键在两端是**不同**的：A 看到 `hash(对端=hos, thread)`，B 看到
 * `hash(对端=lipeng-mac, thread)`。这是对的 —— 每端只需要在**自己的**收件箱里
 * 唯一区分"这是哪场对话"。要求两端算出同一个字符串反而要引入协商，没有收益。
 *
 * ## 为什么要把机器名揉进去
 *
 * 原来直接用裸 thread 字符串当键。两个不同来源都起名 "deploy" 时会撞车：
 * 限速账本互相误伤（对方刷它的 deploy，把你的 deploy 一起限掉）、会话互相顶替。
 * 揉进发送方机器名即可彻底消除。实测踩过这个坑。
 *
 * ## 没有 thread 怎么办
 *
 * 返回空串，表示"一次性任务"：不参与限速、不复用会话、用完不绑定。
 * **刻意不做"复用与该对端的上一场对话"** —— 那会把不相关的话题悄悄并到一起。
 */
import { createHash } from "node:crypto";

/**
 * @param task 入站任务；只需要 fromMachine（或 from）与 thread 两个字段
 * @returns 会话键，形如 `lipeng-mac#a1b2c3d4e5f6`；无 thread 时返回空串
 */
export function conversationKey(task) {
  const who = String(task?.fromMachine || task?.from || "unknown").trim();
  const label = String(task?.thread || "").trim();
  if (!label) return "";
  const h = createHash("sha256").update(`${who}\u0000${label}`).digest("hex").slice(0, 12);
  // 前缀保留可读的机器名，日志里一眼能看懂是谁的哪场对话
  return `${who}#${h}`;
}

/**
 * 从任务里提取"回信地址"。
 *
 * 这与会话键是**两件事**，别混：
 *   · conversationKey 决定"本机用哪个会话处理这条消息"
 *   · 回信地址决定"结果送回发送方的哪个会话"
 *
 * 曾经的实现把 originSession（发送方的 session id）当成复用键去本机找会话 ——
 * 那是设计错误：对方的会话在本机根本不存在，那个分支永远返回 false。它只是
 * 回信地址，归发送方所有。
 */
export function replyTarget(task) {
  return {
    machine: String(task?.fromMachine || "").trim(),
    session: String(task?.originSession || "").trim(),
    thread: String(task?.thread || "").trim(),
  };
}
