/**
 * tailnet 通道列表的解析（纯函数，便于自测）。
 *
 * 一台机器可以同时加入多个 tailnet：每个通道一个 sidecar、一个 tailnet 地址。
 * **设备身份仍然只有一个** —— instanceId 不变，通道只是这个节点的多条可达路径。
 *
 * 优先级：
 *   1. profile 配置里的 `tsnetChannels`（部署方钉死，界面改不了）
 *   2. `state.json` 里的 `tsnetChannels`（界面添加/编辑的，0600）
 *   3. 都没有时退回旧版单授权码字段，合成一个 id = `default` 的通道
 *
 * 这一层刻意不碰文件与网络：调用方把 config / state 传进来，输出可预测。
 * 通道 id 会进 sidecar 的状态目录，所以它的稳定性就是 tailnet 里的设备身份。
 */
import { createHash } from "node:crypto";
import { channelKey } from "./manager.js";

/** 没给 id 时按「显示名 + 控制服务器」推导一个稳定 id。 */
export function deriveChannelId(label, controlUrl) {
  return `ch-${createHash("sha256").update(`${label}\n${controlUrl}`).digest("hex").slice(0, 10)}`;
}

/**
 * @param {object} args
 * @param {object} args.config profile 配置（只读其中的 tsnet* 字段）
 * @param {object} args.state  state.json 解析结果
 * @returns {{id,label,authKey,controlUrl,hostname,enabled,legacy,source}[]}
 */
export function resolveTailnetChannels({ config = {}, state = {} } = {}) {
  const pick = (fromConfig, fromState) => String(fromConfig ?? "").trim() || String(fromState ?? "").trim();
  const cfgList = Array.isArray(config.tsnetChannels) ? config.tsnetChannels : [];
  const stList = Array.isArray(state.tsnetChannels) ? state.tsnetChannels : [];
  const raw = cfgList.length > 0 ? cfgList : stList;
  const fromConfigFile = cfgList.length > 0;

  const list = [];
  const used = new Set();
  const add = (item) => {
    let id = channelKey(item.id, "");
    if (!id) id = deriveChannelId(String(item.label ?? "").trim(), String(item.controlUrl ?? "").trim());
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    list.push({
      id,
      label: String(item.label ?? "").trim() || (id === "default" ? "Tailscale" : `Tailnet ${list.length + 1}`),
      authKey: String(item.authKey ?? "").trim(),
      controlUrl: String(item.controlUrl ?? "").trim(),
      hostname: String(item.hostname ?? "").trim(),
      enabled: item.enabled !== false,
      legacy: item.legacy === true,
      source: fromConfigFile ? "config" : "state",
    });
  };

  if (raw.length > 0) {
    for (const c of raw) if (c && typeof c === "object") add(c);
  } else {
    // 旧版单通道：`default` 沿用旧目录，升级不丢设备身份。
    const enabled = config.tsnetEnabled === true || state.tsnetEnabled === true;
    const authKey = pick(config.tsnetAuthKey, state.tsnetAuthKey);
    const controlUrl = pick(config.tsnetControlUrl, state.tsnetControlUrl);
    const hostname = pick(config.tsnetHostname, state.tsnetHostname);
    if (enabled || authKey || controlUrl) {
      add({ id: "default", label: "Tailscale", authKey, controlUrl, hostname, enabled, legacy: true });
    }
  }
  return list;
}
