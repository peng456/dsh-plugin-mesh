/**
 * dsh-go 原生 UI —— 通过 dsh-go-bridge 的 `dshGo` 服务把 Mesh 放进**手机原生界面**
 * （不是 Web 面板：不需要用户切 Web 模式）。
 *
 * 结构（2026-10-29 移动端重做，task-1 + 产品收敛版）：
 *   · `home`（默认入口）：一行 metric（在线 / 任务 / 通道）→「在线设备」list（行 action
 *     打开设备详情）→「最近任务」list（行 action 打开任务页）→ 导航型快捷 actions
 *     （刷新 primary / 设备列表 / 打开网页 / 调整主页）→ 底部一句 muted 提示。
 *     同一面板内切 `detail`（设备详情：keyValue + 打开网页/返回）与 `config`（调整主页）
 *     子视图，不新开面板、同屏不重复设备行。
 *   · `peers`：在线 metric（caption 兼作空态说明）+ 设备 list（**只用 list 行 action 选中
 *     设备**，不再用 options 选择器——那正是真机上「同一台设备出现两次」的来源）+
 *     两个导航型动作（刷新 / 打开网页）；行 action 在同一面板内切 `detail` 子视图。
 *     设备页**不放**派发/探测/复制地址（产品决定：这些只在完整 Web 面板做）。
 *   · `tasks`：入站/出站 metric + 任务 list（出入站 icon、状态 tone；行 action 复制完整 ID）。
 *   · `composer.strip`：`Mesh · N 在线 · usb/lan`，点击打开 peers。
 *
 * 设计边界（详见 analysis/MOBILE-UI-NATIVE.md）：
 *   · **只读**：数据全部来自 mesh 现有快照（discovery / inbound / outbound / selfRecord），
 *     不改发现、派发、协议任何一行。唯一"写"是「调整主页」保存的 UI 偏好（写 mesh 自己的
 *     state.json，与 settings 同机制）。原生 UI 不再派发任务/探测（避免误触唤醒对端 agent）。
 *   · **没有 bridge 的主机（桌面 DSH）**：`ctx.inject(['dshGo'], …)` 回调永不执行 →
 *     整个模块 no-op；桌面零变化。
 *   · bridge 协议（dsh-go-bridge 0.4.0，rootfs:/opt/dsh-go/dsh-go-bridge/lib/native/）：
 *     `ctx.dshGo.*` 必须**方法调用**（core.js:353）；data 必须是对象、≤32KiB、≤4Hz；
 *     视图 ≤32KiB/120 节点/8 层；一次点按 ≤4 效果、≤3s；面板点按**没有** clipboard/draft
 *     context（routes.js:18），所以"复制"用 `{copy}` 效果而不是读剪贴板 —— 不需要 `wants`。
 *   · 视图只用 SKILL.md 组件表里的稳定 v1 组件：stack/row/text/metric/list/keyValue/actions/
 *     callout；不碰 v2 控件（toggle/divider/badge…），也不赌 `image` 的资源路径（真机
 *     没法验证 asset:/同源 URL 时不加图片，平台一律用 kit icon）。
 */

/** 面板/状态条 id（与 package.json 的 dshGo.contributes 必须一致）。 */
export const PANEL_HOME = "home";
export const PANEL_PEERS = "peers";
export const PANEL_TASKS = "tasks";
export const STRIP_ID = "mesh-status";

/** bridge 协议限制（与 rootfs:/opt/dsh-go/dsh-go-bridge/lib/native/limits.js 对齐）。 */
export const BRIDGE_LIMITS = Object.freeze({
  viewBytes: 32768,
  viewNodes: 120,
  viewDepth: 8,
  dataBytes: 32768,
  patchBytes: 16384,
  dataHz: 4,
  stripText: 24,
  toast: 40,
  copy: 8000,
  listItems: 50,
  keyValues: 24,
  actions: 4,
});

/** 本模块自己的展示预算（比协议限制更保守，留余量给 App 渲染）。 */
const LIMITS = Object.freeze({
  rateMs: 250, // = 4Hz（bridge dataHz）
  tickMs: 5000, // rtt / 在线状态被动刷新（没有事件也能自愈）
  maxPeers: 20, // peers 面板最多列 20 台
  maxHomeDevices: 5, // home「在线设备」最多 5 台
  maxHomeTasks: 3, // home「最近任务」最多 3 条
  maxTasks: 12, // tasks 面板最多 12 条
  maxSubtitle: 80,
  maxTitle: 56,
  maxTrailing: 24,
  maxCapability: 40,
  maxWidgets: 8,
});

/** 主页 widget 目录（顺序即默认顺序；`id` 与 state 的 `homeWidgets[].id` 对应）。 */
export const HOME_WIDGETS = Object.freeze([
  { id: "self", zh: "概览", en: "Overview" },
  { id: "devices", zh: "在线设备", en: "Online devices" },
  { id: "tasks", zh: "最近任务", en: "Recent tasks" },
  { id: "quick", zh: "快捷动作", en: "Quick actions" },
]);
export const HOME_WIDGET_IDS = Object.freeze(HOME_WIDGETS.map((w) => w.id));
export const DEFAULT_HOME_WIDGETS = Object.freeze(HOME_WIDGETS.map((w) => ({ id: w.id, visible: true })));

/** state.json 里存主页布局的键（与 settings 同级，不动用户配置文件）。 */
export const HOME_WIDGETS_STATE_KEY = "homeWidgets";

/** 列表行里可点的动作 id（每个面板的 actions 映射必须真有同名处理函数）。 */
export const HOME_PEER_ACTION = "openHomePeer";
export const PEERS_PEER_ACTION = "openPeer";
export const HOME_TASK_ACTION = "openTasks";
export const TASKS_TASK_ACTION = "copyTask";

const isEn = (locale) => String(locale ?? "").toLowerCase().startsWith("en");
/** 双语选择：dsh-go 的 caps.locale 可能是 zh-CN / en-US。 */
const t = (locale, zh, en) => (isEn(locale) ? en : zh);
/** 稳定字典序（不用 localeCompare：ICU 排序随 Node 版本/语言环境变，行序会抖）。 */
const cmpText = (a, b) => {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};
const widgetLabel = (id, locale) => {
  const w = HOME_WIDGETS.find((x) => x.id === id);
  return w ? t(locale, w.zh, w.en) : String(id);
};
const widgetIcon = (id) => (id === "self" ? "chart" : id === "devices" ? "team" : id === "tasks" ? "todo" : "play");

/** 视图/数据绑定：`{ $: "data.a" }`（bridge 从 emit 的数据里取，取不到显示「—」）。 */
const bind = (path) => ({ $: `data.${path}` });

/** 按码点截断（中文不会切出半个代理对）。 */
export function clip(value, max) {
  const s = String(value ?? "");
  return [...s].slice(0, Math.max(0, max)).join("");
}

/** 紧凑 JSON 的字节数（bridge 的 data/patch 限制按这个口径算）。 */
export function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** bridge 的节点统计口径：只数「带字符串 type 的对象」，数组本身不算。 */
export function viewStats(view) {
  let nodes = 0;
  let depth = 0;
  const walk = (v, d) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, d);
      return;
    }
    if (v === null || typeof v !== "object") return;
    let next = d;
    if (typeof v.type === "string") {
      nodes += 1;
      next = d + 1;
      if (next > depth) depth = next;
    }
    for (const x of Object.values(v)) walk(x, next);
  };
  walk(view, 0);
  return { nodes, depth, bytes: jsonBytes(view) };
}

/** 视图超限时退化成一张说明卡，绝不把非法视图交给 App。 */
function fitView(view, fallback) {
  try {
    const st = viewStats(view);
    if (st.bytes <= BRIDGE_LIMITS.viewBytes && st.nodes <= BRIDGE_LIMITS.viewNodes && st.depth <= BRIDGE_LIMITS.viewDepth) return view;
  } catch {
    /* 落到 fallback */
  }
  return fallback;
}

/** 数据超限时按顺序丢数组尾巴（先丢列表，再丢详情），并标 truncated。 */
function fitData(data, order = ["deviceRows", "taskRows", "rows", "cfgRows", "detailItems"], maxBytes = BRIDGE_LIMITS.dataBytes) {
  let out = data;
  for (const key of order) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    let kept = list.slice();
    while (kept.length > 0 && jsonBytes({ ...out, [key]: kept }) > maxBytes) kept = kept.slice(0, -1);
    if (kept.length !== list.length) out = { ...out, [key]: kept, truncated: true };
  }
  if (jsonBytes(out) > maxBytes) {
    // 极端情况：只留一句说明，保证 emit 的数据永远合法。
    out = {
      deviceRows: [],
      taskRows: [],
      rows: [],
      cfgRows: [],
      detailItems: [],
      onlineLabel: "0/0",
      onlineTone: "info",
      summary: "",
      hint: clip(out.hint ?? "Mesh 数据过大已截断", 80),
      cfgHint: "",
      truncated: true,
    };
  }
  return out;
}

/* ───────────────────────── 主页布局（持久化模型） ───────────────────────── */

/**
 * 把 state.json 里的 `homeWidgets` 规整成可用布局：
 * 未知/重复 id 丢弃、缺失的补默认（visible:true）、最多 8 项、至少一项可见。
 * 任何垃圾输入都返回合法布局，绝不抛（真机 state 文件可能被人手改坏）。
 * 旧版本的 `self`（本机状态卡）沿用同名 id，现在渲染成顶部 metric 概览行。
 */
export function normalizeHomeWidgets(value) {
  const seen = new Set();
  const out = [];
  const list = Array.isArray(value) ? value : [];
  for (const item of list) {
    const id = typeof item === "string" ? item : String(item?.id ?? "");
    if (!HOME_WIDGET_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    const visible = typeof item === "object" && item !== null ? item.visible !== false : true;
    out.push({ id, visible });
  }
  for (const w of HOME_WIDGETS) if (!seen.has(w.id)) out.push({ id: w.id, visible: true });
  if (out.length > LIMITS.maxWidgets) out.length = LIMITS.maxWidgets;
  if (!out.some((w) => w.visible)) out[0] = { ...out[0], visible: true };
  return out;
}

/** 从 mesh state 读主页布局（deps.loadState 由 index.js 注入）。失败用默认值。 */
export function loadHomeWidgets(deps) {
  try {
    const state = typeof deps?.loadState === "function" ? deps.loadState() : undefined;
    return normalizeHomeWidgets(state?.[HOME_WIDGETS_STATE_KEY]);
  } catch {
    return normalizeHomeWidgets(undefined);
  }
}

/** 写回 mesh state（deps.saveState 由 index.js 注入）。返回 true/false，不抛。 */
export function saveHomeWidgets(deps, widgets) {
  try {
    if (typeof deps?.saveState !== "function") return false;
    deps.saveState({ [HOME_WIDGETS_STATE_KEY]: normalizeHomeWidgets(widgets) });
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────── 对端/任务/本机的展示投影（纯函数） ───────────────────────── */

/** 设备显示名：`machine` 是 localhost/空时不拿它当名字（真机上就是 localhost）。 */
export function displayName(peer) {
  const machine = String(peer?.machine ?? "").trim();
  if (machine && machine.toLowerCase() !== "localhost") return machine;
  const host = String(peer?.host ?? "").trim();
  if (host) return host;
  const id = String(peer?.id ?? "").trim();
  return id ? `peer-${id.slice(0, 8)}` : "peer";
}

/** 平台/系统一行：优先结构化 osInfo，老对端回退 os 字符串。 */
export function platformLabel(peer) {
  const info = peer?.osInfo;
  if (info && typeof info === "object") {
    const label = [info.name, info.version].filter(Boolean).join(" ").trim();
    if (label) return clip(label, 40);
    if (info.platform) return clip(String(info.platform), 40);
  }
  const os = String(peer?.os ?? "").trim();
  return os ? clip(os.split(/\s+/)[0], 40) : "?";
}

/**
 * 平台 → kit icon（icon 白名单见 SKILL.md）。
 * android→robot、windows→terminal、mac→image、linux→code；未知回退 team。
 * 不用 image 组件做系统 logo：真机加载 `asset:`/同源 URL 未验证，不赌。
 */
export function peerIcon(peer) {
  const platform = String(peer?.osInfo?.platform ?? "").toLowerCase();
  if (platform === "android") return "robot";
  if (platform === "win32" || platform === "windows") return "terminal";
  if (platform === "darwin") return "image";
  if (platform === "linux") return "code";
  const os = String(peer?.os ?? "").toLowerCase();
  if (os.includes("android")) return "robot";
  if (os.includes("win")) return "terminal";
  if (os.includes("darwin") || os.includes("mac")) return "image";
  if (os.includes("linux")) return "code";
  return "team";
}

/** 通道标签：lan / usb / tsnet（多 tailnet 统一显示 tsnet，细节留在 peers JSON 里）。 */
export function transportTag(peer) {
  const tr = String(peer?.transport ?? "").toLowerCase();
  if (!tr) return "";
  if (tr.startsWith("tsnet")) return "tsnet";
  if (tr === "usb" || tr === "lan") return tr;
  return clip(tr, 12);
}

/** 当前选中端点的 RTT（拿不到返回 0，不编造）。 */
export function chosenRtt(peer) {
  try {
    const key = String(peer?.channel ?? peer?.transport ?? "");
    const endpoints = Array.isArray(peer?.endpoints) ? peer.endpoints : [];
    const ep = endpoints.find((e) => String(e?.channel ?? e?.transport) === key) ?? endpoints[0];
    const rtt = Number(ep?.rttMs);
    return Number.isFinite(rtt) && rtt > 0 ? Math.round(rtt) : 0;
  } catch {
    return 0;
  }
}

/** `host:port`；一个可用端点都没有时退回已知地址，再没有就「—」。 */
export function addressOf(peer) {
  const host = String(peer?.host ?? "").trim();
  const port = Number(peer?.port);
  if (host && port > 0) return `${host}:${port}`;
  const known = Array.isArray(peer?.knownAddresses) ? peer.knownAddresses.filter(Boolean) : [];
  if (known.length > 0) return clip(known[0], 60);
  return "—";
}

/** 能力摘要：mesh 的 `capabilitySummary` 已是单行文本，空串表示「对端没报」。 */
export function capabilityOf(peer) {
  const summary = String(peer?.capabilitySummary ?? "").trim();
  return summary ? clip(summary, LIMITS.maxCapability) : "";
}

/** 设备副标题：平台 · 地址（移动端两行足够；通道/能力在详情里）。 */
export function peerSubtitle(peer, locale) {
  const parts = [platformLabel(peer), addressOf(peer)].filter((x) => x && x !== "—");
  return clip(parts.join(" · "), LIMITS.maxSubtitle) || t(locale, "地址未知", "address unknown");
}

/** 设备状态文字：在线（带延迟）/ 上次见过 / 离线。 */
export function peerStatusText(peer, locale) {
  if (peer?.online === true) {
    const rtt = chosenRtt(peer);
    return rtt ? `${rtt}ms` : t(locale, "在线", "online");
  }
  return peer?.restored === true ? t(locale, "上次见过", "last seen") : t(locale, "离线", "offline");
}

/** 时间 → `MM-DD HH:MM`（毫秒数或 ISO 字符串；解析失败显示「—」，不显示 Invalid Date）。 */
export function formatTime(value) {
  try {
    const raw = typeof value === "number" ? value : String(value ?? "").trim();
    let ms;
    if (typeof raw === "number") ms = raw;
    else if (/^\d{10,}$/.test(raw)) ms = Number(raw);
    else ms = new Date(raw).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return "—";
  }
}

/** 任务状态 → 语义 tone（移动端靠颜色区分成败，不靠读完整状态串）。 */
export function taskTone(task) {
  if (task?.dir === "out" && task?.ok === false) return "bad";
  const status = `${task?.status ?? ""} ${task?.error ?? ""}`.toLowerCase();
  if (/(fail|error|timeout|reject|denied|cancel)/.test(status)) return "bad";
  if (/(pending|queue|wait|dispatch|running|progress|accepted)/.test(status)) return status.includes("accepted") ? "good" : "warn";
  if (/(ok|success|done|complete|deliver|replied)/.test(status)) return "good";
  return "info";
}

/** 一台设备的列表行（home 与 peers 共用；action 由调用方决定，行本身可点）。 */
export function peerRow(peer, locale, actionId = PEERS_PEER_ACTION) {
  const id = String(peer?.id ?? "");
  const row = {
    title: clip(displayName(peer), LIMITS.maxTitle),
    subtitle: peerSubtitle(peer, locale),
    trailing: clip(peerStatusText(peer, locale), LIMITS.maxTrailing),
    icon: peerIcon(peer),
    tone: peer?.online === true ? "good" : "muted",
  };
  if (id) row.action = { id: actionId, args: { id } };
  return row;
}

/** 设备详情信息（地址/系统/版本/通道/能力摘要等）。详情页只展示，不提供派发/复制——那些只在完整 Web 面板里做。 */
export function peerDetailItems(peer, locale) {
  const online = peer?.online === true;
  const version = String(peer?.version ?? "").trim();
  const tagText = transportTag(peer);
  const cap = capabilityOf(peer);
  return [
    { label: t(locale, "设备", "Device"), value: clip(displayName(peer), LIMITS.maxTitle) },
    { label: t(locale, "状态", "Status"), value: peerStatusText(peer, locale), tone: online ? "good" : "muted" },
    { label: t(locale, "地址", "Address"), value: addressOf(peer) },
    { label: t(locale, "系统", "System"), value: platformLabel(peer) },
    { label: t(locale, "版本", "Version"), value: version ? clip(version, 24) : "—" },
    { label: t(locale, "通道", "Link"), value: tagText || "—" },
    {
      label: t(locale, "能力", "Capabilities"),
      value: cap ? clip(`${cap}${peer?.capabilitiesStale === true ? t(locale, "（缓存）", " (cached)") : ""}`, 48) : t(locale, "未上报", "not reported"),
      tone: cap ? "info" : "muted",
    },
    { label: t(locale, "最后活跃", "Last seen"), value: formatTime(peer?.lastSeen) },
  ];
}

/** 一条任务的列表行（tasks 面板用；home 传入不同 action 直达任务页）。 */
export function taskRow(task, locale, action) {
  const dir = task.dir === "out" ? "out" : "in";
  const shortId = clip(task.id, 10);
  const subtitle = [formatTime(task.at), task.thread ? `#${clip(task.thread, 16)}` : "", dir === "in" ? "" : ""].filter(Boolean).join(" · ");
  const row = {
    title: clip(`${clip(task.peer, 24) || "?"} · ${shortId || "—"}`, LIMITS.maxTitle),
    subtitle: clip(subtitle || "—", LIMITS.maxSubtitle),
    trailing: clip(task.status, LIMITS.maxTrailing),
    icon: dir === "in" ? "mail" : "link",
    tone: taskTone(task),
  };
  if (action) row.action = action;
  return row;
}

/** 通道集合 → 展示文本（固定 usb → lan → tsnet 顺序）。 */
export function channelTextOf(peers) {
  const tags = new Set((Array.isArray(peers) ? peers : []).map(transportTag).filter(Boolean));
  return ["usb", "lan", "tsnet"].filter((x) => tags.has(x)).join("/");
}

/** 任务快照 → 扁平数组（入站 + 出站，时间倒序）。 */
export function flattenTasks(tasks) {
  const inbound = Array.isArray(tasks?.inbound) ? tasks.inbound : [];
  const outbound = Array.isArray(tasks?.outbound) ? tasks.outbound : [];
  const items = [];
  for (const task of inbound) {
    if (!task || typeof task !== "object") continue;
    items.push({
      dir: "in",
      id: String(task.id ?? ""),
      peer: String(task.fromMachine ?? task.from ?? "?"),
      status: String(task.status ?? "?"),
      thread: String(task.thread ?? ""),
      at: task.receivedAt ?? task.at ?? "",
    });
  }
  for (const task of outbound) {
    if (!task || typeof task !== "object") continue;
    const ok = task.ok !== false;
    items.push({
      dir: "out",
      id: String(task.id ?? ""),
      peer: String(task.toMachine ?? "?"),
      status: ok ? `ok${task.status ? `(${task.status})` : ""}` : `fail${task.error ? `(${clip(task.error, 24)})` : ""}`,
      thread: String(task.thread ?? ""),
      at: task.at ?? "",
      ok,
    });
  }
  items.sort((a, b) => cmpText(b.at, a.at));
  return items;
}

/** 对端排序：在线 → 离线 → 上次见过；同级按最后活跃时间倒序，机器名兜底稳定。 */
function sortPeers(list) {
  const rank = (p) => (p?.online === true ? 0 : p?.restored === true ? 2 : 1);
  return [...list].sort(
    (a, b) => rank(a) - rank(b) || (Number(b?.lastSeen) || 0) - (Number(a?.lastSeen) || 0) || cmpText(a?.machine, b?.machine) || cmpText(a?.id, b?.id),
  );
}

/* ───────────────────────── home 视图/数据 ───────────────────────── */

/**
 * home 主视图：按当前布局拼 widget（顺序/显隐都在这里体现）。
 * 节点 11 / 深度 3 / ~2.3KB（limits 120 节点 / 8 层 / 32KiB）。
 */
export function buildHomeView(locale, widgets = DEFAULT_HOME_WIDGETS) {
  const layout = Array.isArray(widgets) && widgets.length > 0 ? widgets : DEFAULT_HOME_WIDGETS;
  const children = [];
  for (const w of layout) {
    if (!w || w.visible === false) continue;
    if (w.id === "self") {
      // 一行三块指标：在线 / 任务 / 通道（App 窄屏时 row 会自动折行）。
      children.push({
        type: "row",
        children: [
          { type: "metric", label: t(locale, "在线", "Online"), value: bind("onlineLabel"), tone: bind("onlineTone"), caption: bind("onlineCaption") },
          { type: "metric", label: t(locale, "任务", "Tasks"), value: bind("taskCount"), tone: bind("taskTone"), caption: bind("taskCaption") },
          { type: "metric", label: t(locale, "通道", "Link"), value: bind("channelLabel"), tone: bind("channelTone") },
        ],
      });
    } else if (w.id === "devices") {
      children.push({ type: "text", text: t(locale, "在线设备", "Online devices"), tone: "muted" });
      children.push({ type: "list", items: bind("deviceRows") });
    } else if (w.id === "tasks") {
      children.push({ type: "text", text: t(locale, "最近任务", "Recent tasks"), tone: "muted" });
      children.push({ type: "list", items: bind("taskRows") });
    } else if (w.id === "quick") {
      // 导航型快捷动作（≤4，只有一个 primary=刷新）。派发探测/复制地址只在完整 Web 面板做，
      // 手机原生这里不放 —— 免得一排大药丸里混进会唤醒对端 agent 的操作。
      children.push({
        type: "actions",
        items: [
          { label: t(locale, "刷新", "Refresh"), icon: "refresh", action: "refresh", style: "primary" },
          { label: t(locale, "设备列表", "Devices"), icon: "team", action: "openPeers" },
          { label: t(locale, "打开网页", "Open web"), icon: "globe", action: "openWeb" },
          { label: t(locale, "调整主页", "Customize"), icon: "wrench", action: "openConfig" },
        ],
      });
    }
  }
  children.push({ type: "text", text: bind("hint"), tone: "muted" });
  return { type: "stack", title: t(locale, "Mesh", "Mesh"), children };
}

/**
 * 设备详情子视图（home / peers 共用；`back` 是各面板自己的返回动作 id）。
 * 只有 keyValue + 两个动作（打开网页 / 返回）—— **没有设备列表行**，同屏不会重复出现
 * 同一台设备；也**没有复制地址/派发探测**（按产品决定只在完整 Web 面板做）。
 * 节点 3 / 深度 2 / ~0.5KB。
 */
export function buildPeerDetailView(locale, back = "closePeer") {
  return {
    type: "stack",
    title: t(locale, "设备详情", "Device"),
    children: [
      { type: "keyValue", items: bind("detailItems") },
      {
        type: "actions",
        items: [
          { label: t(locale, "打开网页", "Open web"), icon: "globe", action: "openWeb", style: "primary" },
          { label: t(locale, "返回", "Back"), action: back },
        ],
      },
    ],
  };
}

/**
 * home「调整主页」子视图：list 行 action 选择 widget，再用两组动作调顺序/显隐/保存。
 * **没有 options 选择器**（真机上 options 和 list 会被画成两组重复 UI）。
 * 节点 6 / 深度 2 / ~1.0KB。
 */
export function buildHomeConfigView(locale) {
  return {
    type: "stack",
    title: t(locale, "调整主页", "Customize home"),
    children: [
      { type: "text", text: t(locale, "点按一行选中，再用按钮调整顺序或显示/隐藏", "Tap a row, then reorder or show/hide it"), tone: "muted" },
      { type: "list", items: bind("cfgRows") },
      {
        type: "actions",
        items: [
          { label: t(locale, "上移", "Move up"), action: "moveUp" },
          { label: t(locale, "下移", "Move down"), action: "moveDown" },
          { label: t(locale, "显示/隐藏", "Show/hide"), action: "toggleWidget" },
        ],
      },
      {
        type: "actions",
        items: [
          { label: t(locale, "保存", "Save"), icon: "refresh", action: "saveConfig", style: "primary" },
          { label: t(locale, "恢复默认", "Reset"), action: "resetConfig" },
          { label: t(locale, "返回", "Back"), action: "cancelConfig" },
        ],
      },
      { type: "callout", text: bind("cfgHint"), tone: "info" },
    ],
  };
}

/** home 数据：metric 行 / 在线设备 / 最近任务 / 底部提示 + 详情与调整页的绑定值。 */
export function buildHomeData({ peers, tasks, self, widgets, state, locale, maxDevices = LIMITS.maxHomeDevices, maxTasks = LIMITS.maxHomeTasks } = {}) {
  const list = Array.isArray(peers) ? peers.filter((p) => p && typeof p === "object") : [];
  const layout = Array.isArray(widgets) && widgets.length > 0 ? widgets : DEFAULT_HOME_WIDGETS;
  const sorted = sortPeers(list);
  const onlinePeers = sorted.filter((p) => p.online === true);
  const shownPeers = onlinePeers.slice(0, Math.max(1, maxDevices));
  const deviceRows = shownPeers.map((p) => peerRow(p, locale, HOME_PEER_ACTION));

  const allTasks = flattenTasks(tasks);
  const shownTasks = allTasks.slice(0, Math.max(1, maxTasks));
  const taskRows = shownTasks.map((task) => taskRow(task, locale, HOME_TASK_ACTION));

  const onlineCount = onlinePeers.length;
  const total = list.length;
  const channel = channelTextOf(list);
  const inbound = Array.isArray(tasks?.inbound) ? tasks.inbound.length : 0;
  const outbound = Array.isArray(tasks?.outbound) ? tasks.outbound.length : 0;
  const selected = list.find((p) => String(p?.id ?? "") === String(state?.selectedPeer ?? "")) ?? sorted[0] ?? null;
  const selfName = self && typeof self === "object" ? clip(displayName(self), 24) : "";

  const hintParts = [];
  hintParts.push(`${onlineCount}/${total} ${t(locale, "在线", "online")}${channel ? ` · ${channel}` : ""}`);
  if (onlineCount === 0) hintParts.push(t(locale, "确认对端已装 mesh 并开启", "check peers' mesh install"));
  if (onlinePeers.length > shownPeers.length) hintParts.push(t(locale, `还有 ${onlinePeers.length - shownPeers.length} 台未显示`, `${onlinePeers.length - shownPeers.length} more hidden`));
  if (allTasks.length > shownTasks.length) hintParts.push(t(locale, `共 ${allTasks.length} 条任务`, `${allTasks.length} tasks`));
  hintParts.push(t(locale, "点设备看详情 · 点任务看全部", "tap a device/task for more"));
  if (selfName) hintParts.unshift(selfName);

  const cfgRows = layout.map((w, i) => ({
    title: `${i + 1}. ${widgetLabel(w.id, locale)}`,
    subtitle: w.visible ? t(locale, "显示中", "shown") : t(locale, "已隐藏", "hidden"),
    trailing: state && Number.isInteger(state.widgetCursor) && state.widgetCursor === i ? t(locale, "已选", "selected") : "",
    tone: w.visible ? "good" : "muted",
    icon: widgetIcon(w.id),
    action: { id: "selectWidget", args: { index: i } },
  }));
  const cursor = Number.isInteger(state?.widgetCursor) ? state.widgetCursor : 0;
  const cursorRow = layout[Math.min(Math.max(0, cursor), Math.max(0, layout.length - 1))];

  return fitData(
    {
      onlineLabel: `${onlineCount}/${total}`,
      onlineCaption: total ? t(locale, `共 ${total} 台`, `${total} total`) : t(locale, "还没有对端", "no peers yet"),
      onlineTone: onlineCount > 0 ? "good" : "info",
      taskCount: String(inbound + outbound),
      taskCaption: t(locale, `入 ${inbound} · 出 ${outbound}`, `${inbound} in · ${outbound} out`),
      // metric 的 tone 只认 good/warn/bad/info（kit 的 metric 不接受 muted）：有失败任务就标红。
      taskTone: allTasks.some((task) => taskTone(task) === "bad") ? "bad" : "info",
      channelLabel: channel || (total ? t(locale, "未接通", "offline") : t(locale, "无", "none")),
      channelTone: channel ? "info" : total ? "warn" : "info",
      deviceRows,
      taskRows,
      hint: clip(hintParts.filter(Boolean).join(" · "), 160),
      detailItems: selected ? peerDetailItems(selected, locale) : [{ label: t(locale, "设备", "Device"), value: "—" }],
      cfgRows,
      cfgHint: cursorRow
        ? t(locale, `已选 ${cursor + 1}. ${widgetLabel(cursorRow.id, locale)}；保存后立即生效`, `Selected ${cursor + 1}. ${widgetLabel(cursorRow.id, locale)}; saved immediately`)
        : t(locale, "保存后立即生效", "Saved immediately"),
      truncated: sorted.length > shownPeers.length || allTasks.length > shownTasks.length,
    },
    ["taskRows", "deviceRows", "cfgRows", "detailItems"],
  );
}

/* ───────────────────────── peers / tasks 视图/数据 ───────────────────────── */

/**
 * peers 面板：在线 metric + 设备 list + 两个导航型动作（刷新 / 打开网页）。
 * **没有任何 options 选择器**：选中设备靠 list 行自己的 action。
 * 按产品决定，设备页不放派发/探测/复制地址（那些只在完整 Web 面板），也不放 hint callout。
 * 节点 4 / 深度 2 / ~0.7KB。
 */
export function buildPeersView(locale) {
  return {
    type: "stack",
    title: t(locale, "设备", "Devices"),
    children: [
      { type: "metric", label: t(locale, "在线", "Online"), value: bind("onlineLabel"), tone: bind("onlineTone"), caption: bind("summary") },
      { type: "list", items: bind("rows") },
      {
        type: "actions",
        items: [
          { label: t(locale, "刷新", "Refresh"), icon: "refresh", action: "refresh" },
          { label: t(locale, "打开网页", "Open web"), icon: "globe", action: "openWeb", style: "primary" },
        ],
      },
    ],
  };
}

/** peers 面板数据：在线 metric + 设备行（行 action 打开详情）+ 详情绑定值。 */
export function buildPeersData({ peers, state, locale, maxPeers = LIMITS.maxPeers } = {}) {
  const list = Array.isArray(peers) ? peers.filter((p) => p && typeof p === "object") : [];
  const sorted = sortPeers(list);
  const online = list.filter((p) => p.online === true).length;
  const shown = sorted.slice(0, Math.max(1, maxPeers));
  const rows = shown.map((p) => peerRow(p, locale, PEERS_PEER_ACTION));
  const channel = channelTextOf(list);
  const selected = list.find((p) => String(p?.id ?? "") === String(state?.selectedPeer ?? "")) ?? sorted[0] ?? null;

  // metric 的 caption 兼作空态说明（没有 callout：设备页保持 list 干净）。
  const summary =
    list.length === 0
      ? t(locale, "还没有发现其他设备：确认对端已装 mesh 并开启", "No peers yet: check peers' mesh install")
      : `${channel || t(locale, "无通道", "no link")} · ${online}/${list.length} ${t(locale, "在线", "online")} · ${t(locale, "点按设备查看详情", "tap a device for details")}`;
  return fitData(
    {
      onlineLabel: `${online}/${list.length}`,
      onlineTone: online > 0 ? "good" : "info",
      summary: clip(summary, 80),
      rows,
      detailItems: selected ? peerDetailItems(selected, locale) : [{ label: t(locale, "设备", "Device"), value: "—" }],
      truncated: sorted.length > shown.length,
      total: list.length,
      online,
    },
    ["rows", "detailItems"],
  );
}

/**
 * tasks 面板：入站/出站 metric + 任务 list（状态 tone）+ 刷新 + 提示。
 * 节点 7 / 深度 3 / ~1.0KB。
 */
export function buildTasksView(locale) {
  return {
    type: "stack",
    title: t(locale, "任务", "Tasks"),
    children: [
      {
        type: "row",
        children: [
          { type: "metric", label: t(locale, "入站", "Inbound"), value: bind("inboundCount"), tone: "info" },
          { type: "metric", label: t(locale, "出站", "Outbound"), value: bind("outboundCount"), tone: "info" },
        ],
      },
      { type: "list", items: bind("rows") },
      { type: "actions", items: [{ label: t(locale, "刷新", "Refresh"), icon: "refresh", action: "refresh", style: "primary" }] },
      { type: "text", text: bind("hint"), tone: "muted" },
    ],
  };
}

/** tasks 面板数据：入站/出站最近 N 条（时间倒序），行 action 复制完整 ID。 */
export function buildTasksData({ tasks, state, locale, maxTasks = LIMITS.maxTasks } = {}) {
  const inbound = Array.isArray(tasks?.inbound) ? tasks.inbound : [];
  const outbound = Array.isArray(tasks?.outbound) ? tasks.outbound : [];
  const items = flattenTasks(tasks);
  const shown = items.slice(0, Math.max(1, maxTasks));
  const rows = shown.map((task) => taskRow(task, locale, task.id ? { id: TASKS_TASK_ACTION, args: { id: task.id } } : ""));
  const hintParts = [];
  if (items.length === 0) hintParts.push(t(locale, "还没有任务；在桌面用 mesh_run 派一条试试", "No tasks yet; try mesh_run from the desktop"));
  else {
    hintParts.push(t(locale, `共 ${items.length} 条 · 显示最近 ${shown.length} 条`, `${items.length} total · latest ${shown.length}`));
    hintParts.push(t(locale, "点按任务行复制完整 ID", "tap a row to copy its full ID"));
  }
  return fitData(
    {
      inboundCount: String(inbound.length),
      outboundCount: String(outbound.length),
      rows,
      hint: clip(hintParts.join("；"), 160),
      selected: String(state?.selectedTask ?? ""),
      truncated: items.length > shown.length,
      total: items.length,
    },
    ["rows"],
  );
}

/** 状态条数据：`Mesh · N 在线 · usb/lan`（≤24 字；超长先压成紧凑格式，再截断）。 */
export function buildStripData(peers, locale) {
  const list = Array.isArray(peers) ? peers.filter((p) => p && typeof p === "object") : [];
  const online = list.filter((p) => p.online === true).length;
  if (online === 0) return { text: clip(t(locale, "Mesh · 无在线设备", "Mesh · no peers"), BRIDGE_LIMITS.stripText), icon: "team", tone: "muted" };
  const tagText = channelTextOf(list);
  const onlineWord = t(locale, "在线", "online");
  // 先试完整写法，再压掉分隔空格，最后只剩在线数 —— 24 字硬限制下保证语义完整。
  const candidates = [
    `Mesh · ${online} ${onlineWord}${tagText ? ` · ${tagText}` : ""}`,
    `Mesh ${online}${tagText ? `·${tagText}` : ""}`,
    `Mesh·${online}`,
  ];
  const text = candidates.find((c) => [...c].length <= BRIDGE_LIMITS.stripText) ?? candidates[candidates.length - 1];
  return { text: clip(text, BRIDGE_LIMITS.stripText), icon: "team", tone: "good" };
}

/* ───────────────────────── 注册与回调 ───────────────────────── */

const noop = () => {};
const safePeers = (deps) => {
  try {
    const peers = deps?.discovery?.peers?.();
    return Array.isArray(peers) ? peers : [];
  } catch {
    return [];
  }
};
const safeSelf = (deps) => {
  try {
    const self = deps?.getSelf?.();
    return self && typeof self === "object" ? self : {};
  } catch {
    return {};
  }
};
const safeTasks = (deps) => {
  try {
    const tasks = deps?.getTasks?.();
    return { inbound: Array.isArray(tasks?.inbound) ? tasks.inbound : [], outbound: Array.isArray(tasks?.outbound) ? tasks.outbound : [] };
  } catch {
    return { inbound: [], outbound: [] };
  }
};
/** 每个会话一份 UI 状态；features 里的面板没有 sessionId，用 _global。 */
const stateFor = (states, scope) => {
  const key = String(scope?.sessionId ?? scope?.callId ?? "_global");
  let st = states.get(key);
  if (!st) {
    states.set(
      key,
      (st = {
        homeMode: "home", // home | detail | config
        peersMode: "list", // list | detail
        selectedPeer: "",
        selectedTask: "",
        widgetCursor: 0,
        widgets: null,
        draftWidgets: null,
        _kick: null,
      }),
    );
  }
  return st;
};
const shortToast = (text) => clip(text, BRIDGE_LIMITS.toast);
const pickedId = (event) => {
  const v = event?.value;
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    if (typeof v.id === "string") return v.id;
    if (typeof v.value === "string") return v.value;
  }
  return "";
};
const pickedIndex = (event, fallback = 0) => {
  const v = event?.value;
  const raw = v && typeof v === "object" ? (v.index ?? v.value ?? v.id) : v;
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

/** 懒加载主页布局（state → 内存），每个 UI 实例只读一次；加载失败用默认值。 */
function ensureWidgets(st, deps) {
  if (!Array.isArray(st.widgets)) st.widgets = loadHomeWidgets(deps);
  if (!Array.isArray(st.draftWidgets)) st.draftWidgets = st.widgets.map((w) => ({ ...w }));
  return st.widgets;
}

/**
 * 建一套 UI（不经过 cordis，便于离线自测）：调用方给一个带 `dshGo` 的 ctx。
 * @returns {{ panels: object, strip: object, states: Map, actions: object, limits: object, dispose: Function }}
 */
export function createDshGoUI(scopedCtx, deps = {}, options = {}) {
  const g = scopedCtx?.dshGo;
  if (!g || typeof g.panel !== "function" || typeof g.strip !== "function") throw new Error("dshGo 服务不可用");
  const warn = typeof deps.warn === "function" ? deps.warn : noop;
  const states = new Map();
  const cancels = new Set();
  const opts = {
    rateMs: Number.isFinite(options.rateMs) && options.rateMs >= 0 ? options.rateMs : LIMITS.rateMs,
    tickMs: Number.isFinite(options.tickMs) && options.tickMs > 0 ? options.tickMs : LIMITS.tickMs,
    maxPeers: Number.isInteger(options.maxPeers) && options.maxPeers > 0 ? options.maxPeers : LIMITS.maxPeers,
    maxHomeDevices: Number.isInteger(options.maxHomeDevices) && options.maxHomeDevices > 0 ? options.maxHomeDevices : LIMITS.maxHomeDevices,
    maxHomeTasks: Number.isInteger(options.maxHomeTasks) && options.maxHomeTasks > 0 ? options.maxHomeTasks : LIMITS.maxHomeTasks,
    maxTasks: Number.isInteger(options.maxTasks) && options.maxTasks > 0 ? options.maxTasks : LIMITS.maxTasks,
  };

  /** 数据函数工厂：节流 + 定时刷新 + discovery 事件；返回 bridge 要的 cancel。 */
  const makeData = (kind) => (scope, emit, caps = {}) => {
    const locale = caps?.locale ?? "";
    const st = stateFor(states, scope);
    let stopped = false;
    let timer = null;
    let tick = null;
    let queued = false;
    let lastPush = 0;
    const build = () => {
      if (kind === PANEL_HOME) {
        ensureWidgets(st, deps);
        return buildHomeData({
          peers: safePeers(deps),
          tasks: safeTasks(deps),
          self: safeSelf(deps),
          widgets: st.draftWidgets,
          state: st,
          locale,
          maxDevices: opts.maxHomeDevices,
          maxTasks: opts.maxHomeTasks,
        });
      }
      if (kind === PANEL_PEERS) return buildPeersData({ peers: safePeers(deps), state: st, locale, maxPeers: opts.maxPeers });
      return buildTasksData({ tasks: safeTasks(deps), state: st, locale, maxTasks: opts.maxTasks });
    };
    const push = () => {
      if (stopped) return;
      lastPush = Date.now();
      let data;
      try {
        data = build();
      } catch (err) {
        warn(`dsh-go UI 数据构建失败：${err?.message ?? err}`);
        data = {
          deviceRows: [],
          taskRows: [],
          rows: [],
          cfgRows: [],
          detailItems: [],
          onlineLabel: "0/0",
          onlineTone: "info",
          summary: "",
          hint: shortToast("Mesh 数据暂时不可用"),
          cfgHint: "",
          truncated: true,
        };
      }
      try {
        emit(data);
      } catch {
        /* emit 在 bridge 停止后会抛/忽略；这里不向上传播（"绝不抛"） */
      }
    };
    const schedule = () => {
      if (stopped || queued) return;
      queued = true;
      const wait = Math.max(0, opts.rateMs - (Date.now() - lastPush));
      timer = setTimeout(() => {
        queued = false;
        push();
      }, wait);
      timer.unref?.();
    };
    const onChange = () => schedule();
    st._kick = schedule;
    push();
    tick = setInterval(push, opts.tickMs);
    tick.unref?.();
    const discovery = deps?.discovery;
    if (discovery && typeof discovery.on === "function") {
      try {
        discovery.on("change", onChange);
      } catch {
        /* 订阅失败不影响面板 */
      }
    }
    const cancel = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
      if (st._kick === schedule) st._kick = null;
      try {
        discovery?.removeListener?.("change", onChange);
      } catch {
        /* 忽略 */
      }
      cancels.delete(cancel);
    };
    cancels.add(cancel);
    return cancel;
  };

  /** 视图兜底：任何异常/超限都退化成一张说明卡（绝不把非法视图交给 App）。 */
  const fallbackView = (locale, title) => ({
    type: "stack",
    title,
    children: [{ type: "callout", text: t(locale, "Mesh 面板暂时不可用", "Mesh panel is unavailable"), tone: "warn" }],
  });

  const homeView = (scope, caps = {}) => {
    const locale = caps?.locale ?? "";
    const st = stateFor(states, scope);
    ensureWidgets(st, deps);
    if (st.homeMode === "detail") return fitView(buildPeerDetailView(locale, "closeHomePeer"), fallbackView(locale, t(locale, "设备详情", "Device")));
    if (st.homeMode === "config") return fitView(buildHomeConfigView(locale), fallbackView(locale, t(locale, "调整主页", "Customize home")));
    return fitView(buildHomeView(locale, st.widgets), fallbackView(locale, t(locale, "Mesh", "Mesh")));
  };
  const peersView = (scope, caps = {}) => {
    const locale = caps?.locale ?? "";
    const st = stateFor(states, scope);
    if (st.peersMode === "detail") return fitView(buildPeerDetailView(locale, "closePeer"), fallbackView(locale, t(locale, "设备详情", "Device")));
    return fitView(buildPeersView(locale), fallbackView(locale, t(locale, "设备", "Devices")));
  };
  const tasksView = (_scope, caps = {}) => {
    const locale = caps?.locale ?? "";
    return fitView(buildTasksView(locale), fallbackView(locale, t(locale, "任务", "Tasks")));
  };

  /** 点按统一兜底：任何异常都变成一条 toast（bridge 把抛错记成 violation）。 */
  const safeAction = (name, fn, fallbackText) => (scope, event) => {
    try {
      return fn(scope, event);
    } catch (err) {
      warn(`dsh-go UI 动作 ${name} 失败：${err?.message ?? err}`);
      return { toast: shortToast(fallbackText) };
    }
  };

  const refreshAction = () => ({ refresh: true });

  /** 进入设备详情（各面板自己的入口动作）。 */
  const enterPeerDetail = (scope, event, field) => {
    const st = stateFor(states, scope);
    const peer = safePeers(deps).find((p) => String(p?.id ?? "") === pickedId(event));
    if (!peer) return { toast: shortToast("设备已不在列表") };
    st.selectedPeer = String(peer.id ?? "");
    st[field] = "detail";
    st._kick?.();
    return { refresh: true };
  };

  /** config 视图要用"草稿"，并保证界面上确实在 config 模式。 */
  const configState = (statesMap, scope, deps2) => {
    const st = stateFor(statesMap, scope);
    ensureWidgets(st, deps2);
    if (!Array.isArray(st.draftWidgets)) st.draftWidgets = st.widgets.map((w) => ({ ...w }));
    st.homeMode = "config";
    return { st, draft: st.draftWidgets };
  };

  const homeActions = {
    refresh: safeAction("refresh", refreshAction, "刷新失败"),
    openWeb: safeAction("openWeb", () => ({ open: "web" }), "打开网页失败"),
    openPeers: safeAction("openPeers", () => ({ open: `panel:${PANEL_PEERS}` }), "打开设备页失败"),
    openTasks: safeAction("openTasks", () => ({ open: `panel:${PANEL_TASKS}` }), "打开任务页失败"),
    openHomePeer: safeAction("openHomePeer", (scope, event) => enterPeerDetail(scope, event, "homeMode"), "打开设备失败"),
    closeHomePeer: safeAction("closeHomePeer", (scope) => {
      const st = stateFor(states, scope);
      st.homeMode = "home";
      st._kick?.();
      return { refresh: true };
    }, "返回失败"),
    openConfig: safeAction("openConfig", (scope) => {
      const { st } = configState(states, scope, deps);
      st.widgetCursor = 0;
      st._kick?.();
      return { refresh: true };
    }, "打开调整页失败"),
    selectWidget: safeAction("selectWidget", (scope, event) => {
      const { st, draft } = configState(states, scope, deps);
      const idx = pickedIndex(event, st.widgetCursor);
      st.widgetCursor = Math.min(Math.max(0, idx), Math.max(0, draft.length - 1));
      st._kick?.();
      return { refresh: true };
    }, "选择失败"),
    moveUp: safeAction("moveUp", (scope) => {
      const { st, draft } = configState(states, scope, deps);
      const i = st.widgetCursor;
      if (i <= 0) return { toast: shortToast("已经是第一项") };
      if (i < draft.length) [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]];
      st.widgetCursor = i - 1;
      st._kick?.();
      return { refresh: true, toast: shortToast("已上移") };
    }, "上移失败"),
    moveDown: safeAction("moveDown", (scope) => {
      const { st, draft } = configState(states, scope, deps);
      const i = st.widgetCursor;
      if (i >= draft.length - 1) return { toast: shortToast("已经是最后一项") };
      [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]];
      st.widgetCursor = i + 1;
      st._kick?.();
      return { refresh: true, toast: shortToast("已下移") };
    }, "下移失败"),
    toggleWidget: safeAction("toggleWidget", (scope) => {
      const { st, draft } = configState(states, scope, deps);
      const item = draft[st.widgetCursor];
      if (!item) return { toast: shortToast("先选一项") };
      const nextVisible = item.visible === false;
      const visibleCount = draft.filter((w) => w.visible !== false).length;
      if (!nextVisible && visibleCount <= 1) return { toast: shortToast("至少保留一项") };
      draft[st.widgetCursor] = { ...item, visible: nextVisible };
      st._kick?.();
      return { refresh: true, toast: shortToast(nextVisible ? "已显示" : "已隐藏") };
    }, "切换失败"),
    saveConfig: safeAction("saveConfig", (scope) => {
      const { st, draft } = configState(states, scope, deps);
      const ok = saveHomeWidgets(deps, draft);
      st.widgets = normalizeHomeWidgets(draft);
      st.draftWidgets = st.widgets.map((w) => ({ ...w }));
      st.homeMode = "home";
      st.widgetCursor = 0;
      st._kick?.();
      return { refresh: true, toast: shortToast(ok ? "主页已保存" : "保存失败（留在本页）") };
    }, "保存失败"),
    resetConfig: safeAction("resetConfig", (scope) => {
      const { st } = configState(states, scope, deps);
      st.draftWidgets = DEFAULT_HOME_WIDGETS.map((w) => ({ ...w }));
      st.widgetCursor = 0;
      const ok = saveHomeWidgets(deps, st.draftWidgets);
      st.widgets = normalizeHomeWidgets(st.draftWidgets);
      st.homeMode = "home";
      st._kick?.();
      return { refresh: true, toast: shortToast(ok ? "已恢复默认" : "恢复默认失败") };
    }, "恢复默认失败"),
    cancelConfig: safeAction("cancelConfig", (scope) => {
      const st = stateFor(states, scope);
      ensureWidgets(st, deps);
      st.draftWidgets = st.widgets.map((w) => ({ ...w }));
      st.homeMode = "home";
      st.widgetCursor = 0;
      st._kick?.();
      return { refresh: true };
    }, "返回失败"),
  };

  const peersActions = {
    refresh: safeAction("refresh", refreshAction, "刷新失败"),
    openPeer: safeAction("openPeer", (scope, event) => enterPeerDetail(scope, event, "peersMode"), "打开设备失败"),
    closePeer: safeAction("closePeer", (scope) => {
      const st = stateFor(states, scope);
      st.peersMode = "list";
      st._kick?.();
      return { refresh: true };
    }, "返回失败"),
    openWeb: safeAction("openWeb", () => ({ open: "web" }), "打开网页失败"),
  };

  const tasksActions = {
    refresh: safeAction("refresh", refreshAction, "刷新失败"),
    copyTask: safeAction("copyTask", (scope, event) => {
      const st = stateFor(states, scope);
      const tasks = safeTasks(deps);
      const all = [...tasks.inbound, ...tasks.outbound].filter((x) => x && typeof x === "object" && typeof x.id === "string");
      const id = pickedId(event) || st.selectedTask;
      const picked = all.find((x) => x.id === id) ?? all[all.length - 1];
      if (!picked) return { toast: shortToast("还没有任务 id") };
      st.selectedTask = picked.id;
      return { copy: clip(picked.id, BRIDGE_LIMITS.copy), toast: shortToast("已复制任务 ID") };
    }, "复制失败"),
  };

  const homeDef = { view: homeView, data: makeData(PANEL_HOME), actions: homeActions };
  const peersDef = { view: peersView, data: makeData(PANEL_PEERS), actions: peersActions };
  const tasksDef = { view: tasksView, data: makeData(PANEL_TASKS), actions: tasksActions };
  const homeHandle = g.panel(PANEL_HOME, homeDef);
  const peersHandle = g.panel(PANEL_PEERS, peersDef);
  const tasksHandle = g.panel(PANEL_TASKS, tasksDef);

  const stripHandle = g.strip(STRIP_ID, (scope, emit, caps = {}) => {
    const locale = caps?.locale ?? "";
    let stopped = false;
    const push = () => {
      if (stopped) return;
      try {
        emit(buildStripData(safePeers(deps), locale));
      } catch {
        /* 同 data：绝不向外抛 */
      }
    };
    push();
    const tick = setInterval(push, opts.tickMs);
    tick.unref?.();
    const cancel = () => {
      stopped = true;
      clearInterval(tick);
    };
    cancels.add(cancel);
    return cancel;
  });

  const dispose = () => {
    for (const cancel of [...cancels]) {
      try {
        cancel();
      } catch {
        /* 忽略 */
      }
    }
    cancels.clear();
    states.clear();
    // bridge 的注册本身绑在插件 fiber 的 ctx.effect 上（core.js:371-374），
    // 插件卸载时自动摘除；这里只清我们自己的定时器/订阅。
  };

  return {
    panels: {
      [PANEL_HOME]: { id: PANEL_HOME, def: homeDef, handle: homeHandle },
      [PANEL_PEERS]: { id: PANEL_PEERS, def: peersDef, handle: peersHandle },
      [PANEL_TASKS]: { id: PANEL_TASKS, def: tasksDef, handle: tasksHandle },
    },
    strip: { id: STRIP_ID, handle: stripHandle },
    states,
    actions: { home: homeActions, peers: peersActions, tasks: tasksActions },
    limits: opts,
    dispose,
  };
}

/**
 * 插件 apply() 里的入口：只在装了 dsh-go-bridge 的主机上注册；桌面 DSH 上是 no-op。
 *
 * @param ctx cordis ctx（插件上下文）
 * @param deps { discovery, getSelf, getTasks, loadState, saveState, log, warn }
 *   注：index.js 仍会注入 sendProbe，但原生 UI 按产品决定不再派发探测（只在 Web 面板做），
 *   这里保持不读它，避免误触唤醒对端 agent。
 * @returns 清理函数（bridge 注册由插件 fiber 自动回收，这里清定时器/事件订阅）
 */
export function registerDshGoUI(ctx, deps = {}, options = {}) {
  const warn = typeof deps.warn === "function" ? deps.warn : noop;
  const log = typeof deps.log === "function" ? deps.log : noop;
  const cleanups = [];
  const cleanupAll = () => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* 忽略 */
      }
    }
  };
  try {
    if (!ctx || typeof ctx.inject !== "function") return cleanupAll;
    ctx.inject(["dshGo"], (scopedCtx) => {
      let ui;
      try {
        ui = createDshGoUI(scopedCtx, deps, options);
      } catch (err) {
        warn(`dsh-go 原生 UI 注册失败（不影响 Web 面板与工具）：${err?.message ?? err}`);
        return;
      }
      cleanups.push(ui.dispose);
      log(`dsh-go 原生 UI 已就绪：面板 ${PANEL_HOME}/${PANEL_PEERS}/${PANEL_TASKS}、状态条 ${STRIP_ID}`);
      try {
        if (typeof scopedCtx?.effect === "function") scopedCtx.effect(() => () => ui.dispose());
        else if (typeof ctx.effect === "function") ctx.effect(() => () => ui.dispose());
      } catch {
        /* effect 不可用也不影响注册本身 */
      }
    });
  } catch (err) {
    warn(`dsh-go 原生 UI 挂载失败（不影响其它功能）：${err?.message ?? err}`);
  }
  return cleanupAll;
}

export default registerDshGoUI;
