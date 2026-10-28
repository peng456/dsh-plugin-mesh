/**
 * dsh-go 原生 UI —— 通过 dsh-go-bridge 的 `dshGo` 服务把 Mesh 放进**手机原生界面**
 * （不是 Web 面板：不需要用户切 Web 模式）。
 *
 * 结构（真机需求 2026-10-29）：
 *   · `home`：**首屏**，可配置 widget（本机状态 / 在线设备 / 最近任务 / 快捷入口），
 *     默认全开、顺序可调；底部「调整主页」进入同一面板的 config 视图（选择 + 上移/下移/
 *     显示切换/保存/恢复默认/返回），配置持久化到 mesh state 的 `homeWidgets`。
 *   · `peers` / `tasks`：二级页面，从 home 的快捷入口用 `{open:"panel:peers"}` 直达。
 *   · `composer.strip`：`Mesh · N 在线 · usb/lan`，点击打开 peers。
 *
 * 设计边界（详见 analysis/MOBILE-UI-NATIVE.md）：
 *   · **只读**：数据全部来自 mesh 现有快照（discovery / inbound / outbound / selfRecord），
 *     不改发现、派发、协议任何一行。唯一"写"是用户点「派发探测」的主动派发与
 *     「调整主页」保存的 UI 偏好（写 mesh 自己的 state.json，与 settings 同机制）。
 *   · **没有 bridge 的主机（桌面 DSH）**：`ctx.inject(['dshGo'], …)` 回调永不执行 →
 *     整个模块 no-op；桌面零变化。
 *   · bridge 协议（dsh-go-bridge 0.4.0，rootfs:/opt/dsh-go/dsh-go-bridge/lib/native/）：
 *     `ctx.dshGo.*` 必须**方法调用**（core.js:353）；data 必须是对象、≤32KiB、≤4Hz；
 *     视图 ≤32KiB/120 节点/8 层；一次点按 ≤4 效果、≤3s；面板点按**没有** clipboard/draft
 *     context（routes.js:18），所以"复制"用 `{copy}` 效果而不是读剪贴板 —— 不需要 `wants`。
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
});

/** 本模块自己的展示预算（比协议限制更保守，留余量给 App 渲染）。 */
const LIMITS = Object.freeze({
  rateMs: 250, // = 4Hz（bridge dataHz）
  tickMs: 5000, // rtt / 在线状态被动刷新（没有事件也能自愈）
  maxPeers: 20, // peers 面板最多列 20 台
  maxHomeDevices: 5, // home「在线设备」最多 5 台
  maxHomeTasks: 3, // home「最近任务」最多 3 条
  maxTasks: 12, // tasks 面板最多 12 条
  maxSubtitle: 120,
  maxCapability: 40,
  maxWidgets: 8,
});

/** 「派发探测」发出的固定任务正文（≥8 字，避免对端 minTaskChars 闸门吞掉）。 */
const PROBE_TEXT = "mesh UI 探测：请在回执里报告本机名称与平台";
const PROBE_THREAD_PREFIX = "ui-probe";

/** 主页 widget 目录（顺序即默认顺序；`id` 与 state 的 `homeWidgets[].id` 对应）。 */
export const HOME_WIDGETS = Object.freeze([
  { id: "self", zh: "本机状态", en: "This device" },
  { id: "devices", zh: "在线设备", en: "Online devices" },
  { id: "tasks", zh: "最近任务", en: "Recent tasks" },
  { id: "quick", zh: "快捷入口", en: "Shortcuts" },
]);
export const HOME_WIDGET_IDS = Object.freeze(HOME_WIDGETS.map((w) => w.id));
export const DEFAULT_HOME_WIDGETS = Object.freeze(HOME_WIDGETS.map((w) => ({ id: w.id, visible: true })));

/** state.json 里存主页布局的键（与 settings 同级，不动用户配置文件）。 */
export const HOME_WIDGETS_STATE_KEY = "homeWidgets";

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

/** 数据超限时按顺序丢数组尾巴（先丢 options，再丢 rows），并标 truncated。 */
function fitData(data, order = ["options", "rows"], maxBytes = BRIDGE_LIMITS.dataBytes) {
  let out = data;
  for (const key of order) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    let copyList = list.slice();
    while (copyList.length > 0 && jsonBytes({ ...out, [key]: copyList }) > maxBytes) copyList = copyList.slice(0, -1);
    if (copyList.length !== list.length) out = { ...out, [key]: copyList, truncated: true };
  }
  if (jsonBytes(out) > maxBytes) {
    // 极端情况：只留一句说明，保证 emit 的数据永远合法。
    out = { selfItems: [], deviceRows: [], taskRows: [], rows: [], options: [], selected: out.selected ?? "", hint: clip(out.hint ?? "Mesh 数据过大已截断", 60), truncated: true };
  }
  return out;
}

/* ───────────────────────── 主页布局（持久化模型） ───────────────────────── */

/**
 * 把 state.json 里的 `homeWidgets` 规整成可用布局：
 * 未知/重复 id 丢弃、缺失的补默认（visible:true）、最多 8 项、至少一项可见。
 * 任何垃圾输入都返回合法布局，绝不抛（真机 state 文件可能被人手改坏）。
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

/** `host:port`；一个可用端点都没有时退回已知地址，再没有就「无地址」。 */
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

/** 设备副标题：平台 · 地址 · 通道 · 能力摘要。 */
export function peerSubtitle(peer) {
  const parts = [platformLabel(peer), addressOf(peer), transportTag(peer), capabilityOf(peer)].filter(Boolean);
  return clip(parts.join(" · "), LIMITS.maxSubtitle);
}

/** ISO 时间 → `MM-DD HH:MM`（解析失败显示「—」，不显示 Invalid Date）。 */
export function formatTime(iso) {
  try {
    const d = new Date(String(iso ?? ""));
    const ms = d.getTime();
    if (!Number.isFinite(ms)) return "—";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return "—";
  }
}

/** 一台设备的列表行（peers 面板与 home 在线设备共用）。 */
export function peerRow(peer, locale) {
  const rtt = chosenRtt(peer);
  return {
    title: `${peer?.online === true ? "●" : "○"} ${clip(displayName(peer), 60)}`,
    subtitle: peerSubtitle(peer),
    trailing: peer?.online === true ? (rtt ? `${rtt}ms` : t(locale, "在线", "online")) : peer?.restored === true ? t(locale, "上次见过", "last seen") : t(locale, "离线", "offline"),
    tone: peer?.online === true ? "good" : "muted",
    icon: "team",
  };
}

/** 通道集合 → 展示文本（固定 usb → lan → tsnet 顺序）。 */
export function channelTextOf(peers) {
  const tags = new Set((Array.isArray(peers) ? peers : []).map(transportTag).filter(Boolean));
  return ["usb", "lan", "tsnet"].filter((x) => tags.has(x)).join("/");
}

/* ───────────────────────── home 视图/数据 ───────────────────────── */

/** home 视图：按当前布局拼 widget（顺序/显隐都在这里体现）。 */
export function buildHomeView(locale, widgets = DEFAULT_HOME_WIDGETS) {
  const layout = Array.isArray(widgets) && widgets.length > 0 ? widgets : DEFAULT_HOME_WIDGETS;
  const children = [];
  for (const w of layout) {
    if (!w || w.visible === false) continue;
    if (w.id === "self") {
      children.push({ type: "keyValue", items: { $: "data.selfItems" } });
    } else if (w.id === "devices") {
      children.push({ type: "text", text: t(locale, "在线设备", "Online devices"), tone: "muted" });
      children.push({ type: "list", items: { $: "data.deviceRows" } });
    } else if (w.id === "tasks") {
      children.push({ type: "text", text: t(locale, "最近任务", "Recent tasks"), tone: "muted" });
      children.push({
        type: "table",
        columns: [t(locale, "时间", "Time"), t(locale, "对端", "Peer"), t(locale, "状态", "Status")],
        rows: { $: "data.taskRows" },
      });
    } else if (w.id === "quick") {
      // actions 组件每行最多 4 项，所以快捷入口拆成两行（3 + 3）。
      children.push({
        type: "actions",
        items: [
          { label: t(locale, "刷新", "Refresh"), icon: "refresh", action: "refresh" },
          { label: t(locale, "探测派发", "Probe"), icon: "link", action: "probeQuick", style: "primary" },
          { label: t(locale, "设备列表", "Devices"), icon: "team", action: "openPeers" },
        ],
      });
      children.push({
        type: "actions",
        items: [
          { label: t(locale, "任务队列", "Tasks"), icon: "todo", action: "openTasks" },
          { label: t(locale, "打开网页", "Open web"), icon: "globe", action: "openWeb" },
          { label: t(locale, "复制本机地址", "Copy this address"), icon: "document", action: "copySelf" },
        ],
      });
    }
  }
  children.push({ type: "actions", items: [{ label: t(locale, "调整主页", "Customize home"), icon: "wrench", action: "openConfig", style: "plain" }] });
  children.push({ type: "callout", text: { $: "data.hint" }, tone: "info" });
  return { type: "stack", title: t(locale, "Mesh", "Mesh"), children };
}

/** home 的「调整主页」视图：选择 widget + 上移/下移/显隐/保存/恢复默认/返回。 */
export function buildHomeConfigView(locale) {
  return {
    type: "stack",
    title: t(locale, "调整主页", "Customize home"),
    children: [
      { type: "text", text: t(locale, "先选一项，再用按钮调整顺序或显示/隐藏", "Pick a widget, then reorder or show/hide it"), tone: "muted" },
      { type: "list", items: { $: "data.cfgRows" } },
      { type: "options", id: "selectWidget", options: { $: "data.cfgOptions" }, selected: { $: "data.cfgSelected" } },
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
          { label: t(locale, "保存", "Save"), action: "saveConfig", style: "primary" },
          { label: t(locale, "恢复默认", "Reset"), icon: "refresh", action: "resetConfig" },
          { label: t(locale, "返回", "Back"), action: "cancelConfig" },
        ],
      },
      { type: "callout", text: { $: "data.hint" }, tone: "info" },
    ],
  };
}

/** 本机名片 → keyValue 行（名称 / 地址 / 版本 / 通道 / 在线数）。 */
export function buildSelfItems(self, peers, locale) {
  const list = Array.isArray(peers) ? peers : [];
  const online = list.filter((p) => p?.online === true).length;
  const name = displayName(self);
  const address = addressOf({ host: self?.host, port: self?.port });
  const version = String(self?.version ?? "").trim() || "—";
  const channel = channelTextOf(list) || t(locale, "无", "none");
  return [
    [t(locale, "名称", "Name"), clip(name, 40)],
    [t(locale, "地址", "Address"), address],
    [t(locale, "版本", "Version"), clip(version, 24)],
    [t(locale, "通道", "Links"), channel],
    [t(locale, "在线设备", "Online"), `${online}/${list.length}`],
  ];
}

/** home 数据：默认模式给 widget 数据；config 模式给布局编辑器数据。 */
export function buildHomeData({ peers, tasks, self, widgets, state, locale, mode = "home", maxDevices = LIMITS.maxHomeDevices, maxTasks = LIMITS.maxHomeTasks } = {}) {
  const list = Array.isArray(peers) ? peers.filter((p) => p && typeof p === "object") : [];
  const layout = Array.isArray(widgets) && widgets.length > 0 ? widgets : DEFAULT_HOME_WIDGETS;
  const cursor = Number.isInteger(state?.widgetCursor) ? state.widgetCursor : 0;
  if (mode === "config") {
    const cfgRows = layout.map((w, i) => ({
      title: `${i + 1}. ${widgetLabel(w.id, locale)}`,
      subtitle: w.visible ? t(locale, "显示中", "shown") : t(locale, "已隐藏", "hidden"),
      trailing: w.visible ? "✓" : "—",
      tone: w.visible ? "good" : "muted",
      icon: w.id === "self" ? "home" : w.id === "devices" ? "team" : w.id === "tasks" ? "todo" : w.id === "quick" ? "play" : "puzzle",
    }));
    const cfgOptions = layout.map((w, i) => ({ label: `${i + 1}. ${widgetLabel(w.id, locale)}`, value: String(i) }));
    const selected = String(Math.min(Math.max(0, cursor), Math.max(0, layout.length - 1)));
    return fitData(
      {
        cfgRows,
        cfgOptions,
        cfgSelected: selected,
        hint: t(locale, "保存后立即生效；配置写在 mesh 的 state.json，不动 DSH 配置", "Saved immediately; stored in mesh state.json, not DSH config"),
      },
      ["cfgOptions", "cfgRows"],
    );
  }
  const sorted = [...list].sort((a, b) => (b.online === true) - (a.online === true) || cmpText(a?.machine, b?.machine));
  const onlinePeers = sorted.filter((p) => p.online === true).slice(0, Math.max(1, maxDevices));
  const deviceRows = onlinePeers.map((p) => peerRow(p, locale));
  const inbound = Array.isArray(tasks?.inbound) ? tasks.inbound : [];
  const outbound = Array.isArray(tasks?.outbound) ? tasks.outbound : [];
  const allTasks = [
    ...inbound.map((x) => ({ dir: "in", id: String(x?.id ?? ""), peer: String(x?.fromMachine ?? x?.from ?? "?"), status: String(x?.status ?? "?"), at: x?.receivedAt ?? x?.at ?? "" })),
    ...outbound.map((x) => ({ dir: "out", id: String(x?.id ?? ""), peer: String(x?.toMachine ?? "?"), status: x?.ok === false ? `fail${x?.error ? `(${clip(x.error, 20)})` : ""}` : `ok${x?.status ? `(${x.status})` : ""}`, at: x?.at ?? "" })),
  ];
  allTasks.sort((a, b) => cmpText(b.at, a.at));
  const taskRows = allTasks.slice(0, Math.max(1, maxTasks)).map((x) => [formatTime(x.at), clip(x.peer, 24), clip(x.status, 24)]);
  const onlineCount = list.filter((p) => p?.online === true).length;
  const hintParts = [];
  if (onlineCount === 0) hintParts.push(t(locale, "还没有在线设备：确认对端已装 mesh 并开启", "No online devices yet: check peers' mesh install"));
  else hintParts.push(t(locale, `共 ${onlineCount} 台在线`, `${onlineCount} online`));
  if (allTasks.length > taskRows.length) hintParts.push(t(locale, `最近 ${allTasks.length} 条任务`, `${allTasks.length} total tasks`));
  hintParts.push(t(locale, "「调整主页」可改 widget 顺序与显隐", "Customize home to reorder or hide widgets"));
  return fitData(
    {
      selfItems: buildSelfItems(self, list, locale),
      deviceRows,
      taskRows,
      onlineLabel: `${onlineCount}/${list.length}`,
      hint: clip(hintParts.join("；"), 160),
      truncated: sorted.length > onlinePeers.length,
    },
    ["taskRows", "deviceRows"],
  );
}

/* ───────────────────────── peers / tasks 视图/数据 ───────────────────────── */

/** peers 面板视图：6 节点 / 深度 2 / 约 1.1KB（limits 120 节点 / 8 层 / 32KiB）。 */
export function buildPeersView(locale) {
  return {
    type: "stack",
    title: t(locale, "Mesh 设备", "Mesh devices"),
    children: [
      { type: "metric", label: t(locale, "在线", "Online"), value: { $: "data.onlineLabel" }, tone: "good", caption: { $: "data.summary" } },
      { type: "list", items: { $: "data.rows" } },
      { type: "options", id: "selectPeer", options: { $: "data.options" }, selected: { $: "data.selected" } },
      {
        type: "actions",
        items: [
          { label: t(locale, "刷新", "Refresh"), icon: "refresh", action: "refresh" },
          { label: t(locale, "复制地址", "Copy address"), icon: "document", action: "copyAddress" },
          { label: t(locale, "打开网页", "Open web"), icon: "globe", action: "openWeb" },
          { label: t(locale, "派发探测", "Probe"), icon: "link", action: "probe", style: "primary" },
        ],
      },
      { type: "callout", text: { $: "data.hint" }, tone: "info" },
    ],
  };
}

/** tasks 面板视图：8 节点 / 深度 3 / 约 1.2KB。 */
export function buildTasksView(locale) {
  return {
    type: "stack",
    title: t(locale, "Mesh 任务", "Mesh tasks"),
    children: [
      {
        type: "row",
        children: [
          { type: "metric", label: t(locale, "入站", "Inbound"), value: { $: "data.inboundCount" } },
          { type: "metric", label: t(locale, "出站", "Outbound"), value: { $: "data.outboundCount" } },
        ],
      },
      {
        type: "table",
        columns: [t(locale, "时间", "Time"), t(locale, "方向", "Dir"), t(locale, "对端", "Peer"), t(locale, "状态", "Status"), t(locale, "线程", "Thread"), "ID"],
        rows: { $: "data.rows" },
      },
      { type: "options", id: "selectTask", options: { $: "data.options" }, selected: { $: "data.selected" } },
      {
        type: "actions",
        items: [
          { label: t(locale, "刷新", "Refresh"), icon: "refresh", action: "refresh" },
          { label: t(locale, "复制 ID", "Copy ID"), icon: "note", action: "copyTask" },
        ],
      },
      { type: "callout", text: { $: "data.hint" }, tone: "info" },
    ],
  };
}

/** peers 面板数据：设备行 + 可选项 + 摘要。任何异常输入都返回合法对象。 */
export function buildPeersData({ peers, state, locale, maxPeers = LIMITS.maxPeers } = {}) {
  const list = Array.isArray(peers) ? peers.filter((p) => p && typeof p === "object") : [];
  const online = list.filter((p) => p.online === true);
  const sorted = [...list].sort((a, b) => (b.online === true) - (a.online === true) || cmpText(a?.machine, b?.machine));
  const shown = sorted.slice(0, Math.max(1, maxPeers));
  const rows = shown.map((p) => peerRow(p, locale));
  const options = shown.map((p) => ({ label: clip(`${displayName(p)} · ${addressOf(p)}`, 80), value: String(p?.id ?? "") })).filter((o) => o.value !== "");
  const tagText = channelTextOf(list);
  const summaryParts = [];
  if (list.length > 0) {
    if (tagText) summaryParts.push(tagText);
    summaryParts.push(`${online.length}/${list.length} ${t(locale, "在线", "online")}`);
  } else {
    summaryParts.push(t(locale, "还没有发现其他设备", "No peers discovered yet"));
  }
  const truncated = sorted.length > shown.length;
  const hintParts = [];
  if (truncated) hintParts.push(t(locale, `还有 ${sorted.length - shown.length} 台未显示`, `${sorted.length - shown.length} more not shown`));
  if (options.length > 0) hintParts.push(t(locale, "先选一台设备，再复制地址 / 派发探测", "Pick a device, then copy or probe"));
  else hintParts.push(t(locale, "点「刷新」重新探测；可在 DSH Web 的 Mesh 面板做完整设置", "Tap Refresh to re-probe; full settings live in the DSH Web Mesh panel"));
  return fitData(
    {
      onlineLabel: `${online.length} / ${list.length}`,
      summary: clip(summaryParts.join(" · "), 80),
      rows,
      options,
      selected: String(state?.selectedPeer ?? ""),
      hint: clip(hintParts.join("；"), 160),
      truncated,
      total: list.length,
    },
    ["options", "rows"],
  );
}

/** tasks 面板数据：入站/出站最近 N 条（时间倒序）。 */
export function buildTasksData({ tasks, state, locale, maxTasks = LIMITS.maxTasks } = {}) {
  const inbound = Array.isArray(tasks?.inbound) ? tasks.inbound : [];
  const outbound = Array.isArray(tasks?.outbound) ? tasks.outbound : [];
  const items = [];
  for (const task of inbound) {
    if (!task || typeof task !== "object") continue;
    items.push({ dir: "in", id: String(task.id ?? ""), peer: String(task.fromMachine ?? task.from ?? "?"), status: String(task.status ?? "?"), thread: String(task.thread ?? ""), at: task.receivedAt ?? task.at ?? "" });
  }
  for (const task of outbound) {
    if (!task || typeof task !== "object") continue;
    const ok = task.ok !== false;
    items.push({ dir: "out", id: String(task.id ?? ""), peer: String(task.toMachine ?? "?"), status: ok ? `ok${task.status ? `(${task.status})` : ""}` : `fail${task.error ? `(${clip(task.error, 24)})` : ""}`, thread: String(task.thread ?? ""), at: task.at ?? "" });
  }
  items.sort((a, b) => cmpText(b.at, a.at));
  const shown = items.slice(0, Math.max(1, maxTasks));
  const rows = shown.map((it) => [
    formatTime(it.at),
    it.dir === "in" ? t(locale, "入", "in") : t(locale, "出", "out"),
    clip(it.peer, 24),
    clip(it.status, 24),
    clip(it.thread, 16) || "—",
    clip(it.id, 12) || "—",
  ]);
  const options = shown.filter((it) => it.id).map((it) => ({ label: clip(`${it.dir === "in" ? "↓" : "↑"} ${it.id.slice(0, 10)} · ${it.peer}`, 80), value: it.id }));
  return fitData(
    {
      inboundCount: String(inbound.length),
      outboundCount: String(outbound.length),
      rows,
      options,
      selected: String(state?.selectedTask ?? ""),
      hint:
        items.length === 0
          ? t(locale, "还没有任务；在桌面用 mesh_run 派一条试试", "No tasks yet; try mesh_run from the desktop")
          : clip(t(locale, `共 ${inbound.length + outbound.length} 条，显示最近 ${shown.length} 条；选中后可复制完整 ID`, `${inbound.length + outbound.length} total, latest ${shown.length} shown; pick one to copy its full ID`), 160),
      truncated: items.length > shown.length,
      total: items.length,
    },
    ["options", "rows"],
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
  if (!st) states.set(key, (st = { mode: "home", selectedPeer: "", selectedTask: "", widgetCursor: 0, widgets: null, draftWidgets: null, _kick: null }));
  return st;
};
const shortToast = (text) => clip(text, BRIDGE_LIMITS.toast);
const pickedId = (event) => {
  const v = event?.value;
  if (v && typeof v === "object") {
    if (typeof v.value === "string") return v.value;
    if (typeof v.id === "string") return v.id;
  }
  if (typeof v === "string") return v;
  return "";
};
const pickedIndex = (event, fallback = 0) => {
  const raw = pickedId(event);
  const n = Number.parseInt(raw, 10);
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
        const layout = st.mode === "config" ? st.draftWidgets : st.widgets;
        return buildHomeData({ peers: safePeers(deps), tasks: safeTasks(deps), self: safeSelf(deps), widgets: layout, state: st, locale, mode: st.mode, maxDevices: opts.maxHomeDevices, maxTasks: opts.maxHomeTasks });
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
        data = { selfItems: [], deviceRows: [], taskRows: [], cfgRows: [], cfgOptions: [], rows: [], options: [], selected: "", hint: shortToast("Mesh 数据暂时不可用"), truncated: true };
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

  const safeView = (fn, kind) => (scope, caps = {}) => {
    const locale = caps?.locale ?? "";
    const fallback = {
      type: "stack",
      title: kind === PANEL_HOME ? t(locale, "Mesh", "Mesh") : kind === PANEL_PEERS ? t(locale, "Mesh 设备", "Mesh devices") : t(locale, "Mesh 任务", "Mesh tasks"),
      children: [{ type: "callout", text: t(locale, "Mesh 面板暂时不可用", "Mesh panel is unavailable"), tone: "warn" }],
    };
    try {
      if (kind === PANEL_HOME) {
        const st = stateFor(states, scope);
        ensureWidgets(st, deps);
        return fitView(st.mode === "config" ? buildHomeConfigView(locale) : buildHomeView(locale, st.widgets), fallback);
      }
      return fitView(fn(locale), fallback);
    } catch (err) {
      warn(`dsh-go UI 视图构建失败：${err?.message ?? err}`);
      return fallback;
    }
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

  /** 探测派发：home/peers 共用；后台跑、立刻 toast（handler ≤3s）。 */
  const dispatchProbe = (scope) => {
    const st = stateFor(states, scope);
    const list = safePeers(deps);
    const peer = list.find((p) => String(p?.id ?? "") === st.selectedPeer) ?? list.find((p) => p?.online === true);
    if (!peer) return { toast: shortToast("没有在线设备") };
    if (peer.online !== true) return { toast: shortToast("设备当前离线") };
    if (typeof deps.sendProbe !== "function") return { toast: shortToast("当前主机不支持派发") };
    const thread = `${PROBE_THREAD_PREFIX}-${String(peer.id ?? "peer").slice(0, 8)}-${Date.now().toString(36)}`;
    Promise.resolve()
      .then(() => deps.sendProbe({ target: peer, text: PROBE_TEXT, thread }))
      .catch((err) => warn(`dsh-go UI 探测派发失败：${err?.message ?? err}`));
    return { toast: shortToast(`已派发探测 → ${displayName(peer)}`) };
  };

  const homeActions = {
    refresh: safeAction("refresh", refreshAction, "刷新失败"),
    probeQuick: safeAction("probeQuick", (scope) => dispatchProbe(scope), "派发失败"),
    openPeers: safeAction("openPeers", () => ({ open: `panel:${PANEL_PEERS}` }), "打开设备列表失败"),
    openTasks: safeAction("openTasks", () => ({ open: `panel:${PANEL_TASKS}` }), "打开任务队列失败"),
    openWeb: safeAction("openWeb", () => ({ open: "web" }), "打开网页失败"),
    copySelf: safeAction("copySelf", () => {
      const self = safeSelf(deps);
      const name = displayName(self);
      const address = addressOf({ host: self?.host, port: self?.port });
      return { copy: clip(`${name} ${address}`, BRIDGE_LIMITS.copy) };
    }, "复制失败"),
    openConfig: safeAction("openConfig", (scope) => {
      const st = stateFor(states, scope);
      ensureWidgets(st, deps);
      st.mode = "config";
      st.draftWidgets = st.widgets.map((w) => ({ ...w }));
      st.widgetCursor = 0;
      st._kick?.();
      return { refresh: true };
    }, "打开调整页失败"),
    selectWidget: safeAction("selectWidget", (scope, event) => {
      const st = stateFor(states, scope);
      ensureWidgets(st, deps);
      const idx = pickedIndex(event, st.widgetCursor);
      st.widgetCursor = Math.min(Math.max(0, idx), Math.max(0, st.draftWidgets.length - 1));
      st._kick?.();
      return { patch: { cfgSelected: String(st.widgetCursor) } };
    }, "选择失败"),
    moveUp: safeAction("moveUp", (scope) => {
      const { st, draft } = configState(states, scope, deps);
      const i = st.widgetCursor;
      if (i > 0 && i < draft.length) [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]];
      st.widgetCursor = Math.max(0, i - 1);
      st._kick?.();
      return { refresh: true, toast: shortToast("已上移") };
    }, "上移失败"),
    moveDown: safeAction("moveDown", (scope) => {
      const { st, draft } = configState(states, scope, deps);
      const i = st.widgetCursor;
      if (i >= 0 && i < draft.length - 1) [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]];
      st.widgetCursor = Math.min(draft.length - 1, i + 1);
      st._kick?.();
      return { refresh: true, toast: shortToast("已下移") };
    }, "下移失败"),
    toggleWidget: safeAction("toggleWidget", (scope) => {
      const { st, draft } = configState(states, scope, deps);
      const i = st.widgetCursor;
      const item = draft[i];
      if (!item) return { toast: shortToast("先选一项") };
      const nextVisible = item.visible === false;
      const visibleCount = draft.filter((w) => w.visible !== false).length;
      if (!nextVisible && visibleCount <= 1) return { toast: shortToast("至少保留一项") };
      draft[i] = { ...item, visible: nextVisible };
      st._kick?.();
      return { refresh: true, toast: shortToast(nextVisible ? "已显示" : "已隐藏") };
    }, "切换失败"),
    saveConfig: safeAction("saveConfig", (scope) => {
      const { st, draft } = configState(states, scope, deps);
      const ok = saveHomeWidgets(deps, draft);
      st.widgets = normalizeHomeWidgets(draft);
      st.mode = "home";
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
      st._kick?.();
      return { refresh: true, toast: shortToast(ok ? "已恢复默认" : "恢复默认失败") };
    }, "恢复默认失败"),
    cancelConfig: safeAction("cancelConfig", (scope) => {
      const st = stateFor(states, scope);
      st.mode = "home";
      st.widgetCursor = 0;
      st._kick?.();
      return { refresh: true };
    }, "返回失败"),
  };

  /** config 视图要用"草稿"，并保证界面上确实在 config 模式。 */
  function configState(statesMap, scope, deps2) {
    const st = stateFor(statesMap, scope);
    ensureWidgets(st, deps2);
    if (!Array.isArray(st.draftWidgets)) st.draftWidgets = st.widgets.map((w) => ({ ...w }));
    st.mode = "config";
    return { st, draft: st.draftWidgets };
  }

  const peersActions = {
    selectPeer: safeAction("selectPeer", (scope, event) => {
      const id = pickedId(event);
      const st = stateFor(states, scope);
      st.selectedPeer = id;
      return { patch: { selected: id }, toast: shortToast(id ? "已选中设备" : "未选中") };
    }, "选择设备失败"),
    refresh: safeAction("refresh", refreshAction, "刷新失败"),
    copyAddress: safeAction("copyAddress", (scope) => {
      const st = stateFor(states, scope);
      const list = safePeers(deps);
      const peer = list.find((p) => String(p?.id ?? "") === st.selectedPeer) ?? list.find((p) => p?.online === true) ?? list[0];
      if (!peer) return { toast: shortToast("还没有可复制的设备") };
      return { copy: clip(`${displayName(peer)} ${addressOf(peer)}`, BRIDGE_LIMITS.copy) };
    }, "复制失败"),
    openWeb: safeAction("openWeb", () => ({ open: "web" }), "打开网页失败"),
    probe: safeAction("probe", (scope) => dispatchProbe(scope), "派发失败"),
  };

  const tasksActions = {
    selectTask: safeAction("selectTask", (scope, event) => {
      const id = pickedId(event);
      const st = stateFor(states, scope);
      st.selectedTask = id;
      return { patch: { selected: id }, toast: shortToast(id ? "已选中任务" : "未选中") };
    }, "选择任务失败"),
    refresh: safeAction("refresh", refreshAction, "刷新失败"),
    copyTask: safeAction("copyTask", (scope) => {
      const st = stateFor(states, scope);
      const tasks = safeTasks(deps);
      const all = [...tasks.inbound, ...tasks.outbound].filter((x) => x && typeof x === "object" && typeof x.id === "string");
      const picked = all.find((x) => x.id === st.selectedTask) ?? all[all.length - 1];
      if (!picked) return { toast: shortToast("还没有任务 id") };
      return { copy: clip(picked.id, BRIDGE_LIMITS.copy) };
    }, "复制失败"),
  };

  const homeDef = { view: safeView(null, PANEL_HOME), data: makeData(PANEL_HOME), actions: homeActions };
  const peersDef = { view: safeView(buildPeersView, PANEL_PEERS), data: makeData(PANEL_PEERS), actions: peersActions };
  const tasksDef = { view: safeView(buildTasksView, PANEL_TASKS), data: makeData(PANEL_TASKS), actions: tasksActions };
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
 * @param deps { discovery, getSelf, getTasks, sendProbe, loadState, saveState, log, warn }
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
