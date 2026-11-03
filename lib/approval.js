/**
 * 陌生设备第一次派活时的「确认一下」闸门 —— 纯函数，便于单测。
 *
 * 为什么要有它：默认零配置意味着同一网段里任何连得上 45917 的机器都能让本机
 * 开一个 agent 会话跑东西。对"自己家三台电脑"这是方便，对"公司网络 / 合租 /
 * 咖啡厅"就是敞着门。原来的答案是"你去开配对码"，但那是个**设置项**，没人会
 * 主动打开 —— 而恐惧是装之前就有的，不是用完才有的。
 *
 * 所以默认改成：陌生设备第一次派活 → 本机弹一次确认；你点过「允许」之后，
 * 这台机器才不再问你。配对码（requirePairing）比它更强，开了配对码就说明
 * 你已经用共享密钥表达过信任，不再多问一遍。
 *
 * 规则写在这里而不是埋进 3000 行的 index.js：这是安全相关判定，写错了会
 * "看起来拦住了、实际放行"，而这种错误没人会为它写测试。拆出来，单测它。
 */

/** 一次批准记录最多留多少条：设备是有限的，留太多只会让 state.json 变脏。 */
export const MAX_APPROVED_PEERS = 50;

/**
 * 从一条入站任务里取出"这是谁"。
 *
 * 识别优先级：机器名 > 来源地址。**机器名优先**，因为它稳定、可读，用户在
 * 确认框里看到的就是这个名字；地址只作为兜底（旧版本对端、或机器名没填）。
 *
 * @param {object} task `/mesh/v1/task` 落下来的任务对象
 * @returns {{machine: string, address: string, key: string}}
 */
export function peerOfTask(task = {}) {
  let machine = String(task?.fromMachine || "").trim() || String(task?.from || "").split("/")[0].trim();
  // "unknown" 是旧版本对端没填名字时的占位符，不能当成一台叫 unknown 的机器 ——
  // 否则所有老对端会共用一张信任记录。
  if (machine.toLowerCase() === "unknown") machine = "";
  const address = String(task?.sourceAddress || "").trim();
  return { machine, address, key: (machine || address).toLowerCase() };
}

/** 把磁盘上读出来的批准列表归一化 —— 坏数据不能让闸门炸掉。 */
export function normalizeApproved(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      machine: String(x.machine ?? "").trim(),
      address: String(x.address ?? "").trim(),
      at: typeof x.at === "string" ? x.at : "",
    }))
    .filter((x) => x.machine || x.address)
    .slice(-MAX_APPROVED_PEERS);
}

/**
 * 这台设备是否已经被允许过。
 *
 * **有机器名就只认机器名**；没有名字（旧版本对端）才退回地址。
 * 不能"任一命中"：tailnet 反代下多台对端的 sourceAddress 都是 127.0.0.1，
 * 按地址匹配会让允许一台 = 允许全部 —— 闸门形同虚设（本地联调时实测到了）。
 * 机器名大小写不敏感（Windows 上尤其重要）。
 *
 * @param {Array} approved state.json 里的 approvedPeers
 * @param {{machine: string, address: string}} peer peerOfTask 的返回值
 */
export function isApproved(approved, peer) {
  const list = normalizeApproved(approved);
  // 调用方可以只传 {machine, address}，不必先过 peerOfTask；
  // 认不出是谁才返回 false（宁可多问一次，也不默认放行）。
  const machine = String(peer?.machine || "").trim().toLowerCase();
  if (machine && machine !== "unknown") {
    return list.some((x) => x.machine && x.machine.toLowerCase() === machine);
  }
  const address = String(peer?.address || "").trim();
  if (!address) return false;
  return list.some((x) => !x.machine && x.address === address);
}

/** 追加一条批准记录（幂等；超过上限丢最旧的）。 */
export function approvePeer(approved, peer, at = new Date().toISOString()) {
  const machineKey = String(peer?.machine || "").trim().toLowerCase();
  const addressKey = String(peer?.address || "").trim();
  const list = normalizeApproved(approved).filter((x) => {
    // 和 isApproved 同一套规则：有机器名只按机器名去重，没名字才按地址。
    if (machineKey) return !(x.machine && x.machine.toLowerCase() === machineKey);
    return !(!x.machine && addressKey && x.address === addressKey);
  });
  const entry = {
    machine: String(peer?.machine ?? "").trim(),
    address: String(peer?.address ?? "").trim(),
    at,
  };
  if (!entry.machine && !entry.address) return normalizeApproved(approved);
  return [...list, entry].slice(-MAX_APPROVED_PEERS);
}

/**
 * 撤销一条批准（按机器名或地址，大小写不敏感）。
 *
 * @returns {Array} 新列表；没命中时原样返回
 */
export function revokePeer(approved, target) {
  const t = String(target ?? "").trim().toLowerCase();
  if (!t) return normalizeApproved(approved);
  return normalizeApproved(approved).filter(
    (x) => x.machine.toLowerCase() !== t && String(x.address).toLowerCase() !== t,
  );
}

/**
 * 这条任务要不要先问用户。
 *
 * 只看三件事：配置开关、配对码是否已生效、这台设备是否已被允许。
 * **不要**在这里判断"是不是自己派给自己"——那属于路由层，不属于信任层。
 *
 * @param {object} input
 * @param {object} input.config 插件配置（读 requireApproval）
 * @param {Array}  input.approved state.json 的 approvedPeers
 * @param {object} input.peer peerOfTask 的返回值
 * @param {boolean} input.pairingRequired pairingRequired(config) 的结果
 * @returns {boolean}
 */
export function needsApproval({ config = {}, approved = [], peer = {}, pairingRequired = false }) {
  // 显式 false 才关；缺省按开（schema 默认也是 true）。
  if (config?.requireApproval === false) return false;
  // 配对码是比"点一次允许"更强的信任动作：开了它就不再重复问。
  if (pairingRequired) return false;
  if (!peer || !(peer.machine || peer.address)) return true;
  return !isApproved(approved, peer);
}

/**
 * 这条入站任务是不是在「回答问题」而不是派新活？
 *
 * 判据和 handleInboundTask 里的一致：同一台机器 + 同一个 thread 上，我们确实
 * 往外派过任务。回执**必须绕过**首次确认闸门，否则对方把结果派回来时会被本机
 * 拦下，整条回路卡死在"等允许"。
 *
 * 抽成纯函数是为了能单测这条绕过 —— 写错了是静默灾难：要么结果回不来，
 * 要么陌生机器能借一个旧 thread 名绕过闸门。
 *
 * @param {object} task 入站任务
 * @param {Array} outbound 本机发出的任务记录
 */
export function isReplyToOutbound(task = {}, outbound = []) {
  const thread = String(task?.thread || "").trim();
  if (!thread) return false;
  const machine = String(task?.fromMachine || String(task?.from || "").split("/")[0] || "").trim();
  if (!machine) return false;
  return (Array.isArray(outbound) ? outbound : []).some(
    (o) =>
      String(o?.toMachine || "").trim() === machine &&
      String(o?.thread || "").trim() === thread,
  );
}
