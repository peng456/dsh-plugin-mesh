/**
 * dsh-plugin-mesh —— 浏览器侧（Client half）
 *
 * 一个“层层相扣”的 Mesh 工作台：
 *   0 层：工作台外壳（顶栏 + 三个子页：设备 / 任务 / 连接）
 *   1 层：列表（设备 / 任务）
 *   2 层：详情（选中项的完整信息）
 *   3 层：动作面板（派发任务的 sheet、配对码确认、Tailscale 高级设置）
 *
 * 设计原则只有三条：
 *   1. 首屏只回答“谁在线、能不能派活”，设置永远在第二层之后；
 *   2. 一次只给一个主操作，其余收进折叠或列表；
 *   3. 颜色、边框、状态全部走主题 token，深色模式不用另写一套。
 *
 * 仍然是一个手写 bundle：只依赖 react，不引入构建步骤；
 * 样式通过一次注入的 <style> 提供，这样才有 :hover / :focus-visible /
 * @media / prefers-reduced-motion —— 内联样式做不到这些。
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-mesh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    const PANEL_ID = "mesh";
    const API = "/mesh/api";
    const inject = ["slots"];
    const TS_KEYS_URL = "https://console.tailscale.com/admin/settings/keys";
    const TRANSFER_KEY = "mesh.transfers.v1";
    const TRANSFER_LIMIT = 50;
    let pluginCtx = null;

    const HOME_PREF_KEY = "mesh.home.v1";
    const HOME_CARDS = [
      { id: "overview", title: "概览", icon: "mesh", full: true },
      { id: "devices", title: "设备", icon: "device" },
      { id: "tasks", title: "最近任务", icon: "tasks" },
      { id: "pairing", title: "配对码", icon: "key" },
      { id: "tsnet", title: "互联网组网", icon: "tailscale" },
      { id: "diagnostics", title: "诊断", icon: "terminal" },
    ];
    // 诊断默认收起：主页先给“现在要做什么”，排障信息按需加回。
    const DEFAULT_HOME = ["overview", "devices", "tasks", "pairing", "tsnet"];
    const HOME_IDS = new Set(HOME_CARDS.map((c) => c.id));
    const CUSTOM_TYPES = [
      { value: "note", label: "便签", icon: "note" },
      { value: "link", label: "链接", icon: "link" },
      { value: "status", label: "指标", icon: "activity" },
      { value: "peers", label: "设备", icon: "device" },
      { value: "tasks", label: "任务", icon: "tasks" },
    ];
    const CUSTOM_ICONS = ["note", "link", "activity", "device", "tasks", "key", "tailscale", "terminal", "home", "focus"];
    const HOME_METRICS = [
      { value: "online", label: "在线设备" },
      { value: "pairing", label: "配对码" },
      { value: "tsnet", label: "互联网组网" },
      { value: "updated", label: "上次更新" },
      { value: "port", label: "端口" },
    ];

    function newCustomId() {
      try {
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
          return `custom-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
        }
      } catch {
        /* fall through */
      }
      return `custom-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
    }

    function isCustomCard(card) {
      return !!(card && card.custom === true);
    }

    // ─────────────────────── 小工具 ───────────────────────

    function cls(...xs) {
      return xs.filter(Boolean).join(" ");
    }

    function tsOf(v) {
      if (!v) return 0;
      const n = typeof v === "number" ? v : Date.parse(String(v));
      return Number.isFinite(n) ? n : 0;
    }

    function ago(v, now) {
      const t = tsOf(v);
      if (!t) return "—";
      const s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
      if (s < 5) return "刚刚";
      if (s < 60) return `${s} 秒前`;
      if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
      if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
      return `${Math.floor(s / 86400)} 天前`;
    }

    function fmtTime(v) {
      const t = tsOf(v);
      if (!t) return "—";
      try {
        return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } catch {
        return new Date(t).toISOString();
      }
    }

    function fmtDateTime(v) {
      const t = tsOf(v);
      if (!t) return "—";
      try {
        return new Date(t).toLocaleString();
      } catch {
        return new Date(t).toISOString();
      }
    }

    function initial(name) {
      const s = String(name || "?").trim();
      return s ? Array.from(s)[0].toUpperCase() : "?";
    }

    function osLabel(os) {
      const s = String(os || "").toLowerCase();
      if (!s) return "系统未知";
      if (s.startsWith("darwin") || s.includes("mac")) return "macOS";
      if (s.startsWith("win")) return "Windows";
      if (s.includes("android")) return "Android";
      if (s.includes("linux")) return "Linux";
      return String(os).split(/\s+/)[0];
    }

    /** 结构化系统身份：新对端有 osInfo，老对端只有 os 字符串，回退解析。 */
    function osInfoLabel(peer) {
      const info = peer && peer.osInfo;
      if (!info) return osLabel(peer && peer.os);
      const label = [info.name, info.version].filter(Boolean).join(" ");
      return label || osLabel(peer && peer.os);
    }

    /**
     * 一台机器上的「额外系统」（目前是 WSL 发行版）。
     * 宿主机不在这里返回 —— 它已经由 osInfoLabel 表示了。
     */
    function extraSystems(peer) {
      const list = peer && Array.isArray(peer.systems) ? peer.systems : [];
      return list
        .filter((s) => s && s.kind && s.kind !== "host")
        .map((s, i) => ({
          key: `${s.kind}-${s.name || i}`,
          kind: s.kind,
          text: [s.kind === "wsl" ? "WSL" : s.kind, s.name, s.version].filter(Boolean).join(" "),
        }));
    }

    /** WSL 发行版里的运行时，压成一行；没有就返回空串。 */
    function wslSummary(caps) {
      const list = caps && Array.isArray(caps.wsl) ? caps.wsl : [];
      return list
        .map((w) => {
          const rts = Object.entries(w.runtimes || {})
            .map(([n, v]) => `${n} ${v}`)
            .join("、");
          return `${w.name}${rts ? `：${rts}` : ""}`;
        })
        .join(" · ");
    }

    function shortAddress(host, port) {
      if (!host) return "地址未知";
      return port ? `${host}:${port}` : String(host);
    }

    function peerAddress(peer) {
      if (!peer) return "地址未知";
      if (peer.host) return shortAddress(peer.host, peer.port);
      const eps = Array.isArray(peer.endpoints) ? peer.endpoints : [];
      const ep = eps.find((x) => x && x.host);
      return ep ? shortAddress(ep.host, ep.port) : "地址未知";
    }

    function apiErr(r) {
      return (r && (r.error || r.message)) || "未知错误";
    }

    async function api(path, body) {
      const r = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      let j = {};
      try {
        j = await r.json();
      } catch {
        j = {};
      }
      if (!r.ok && !j.error) j.error = `HTTP ${r.status}`;
      return j;
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* fall through */
      }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }

    // ─────────────────────── 锚定传输 ───────────────────────

    function transferId() {
      try {
        return `tr-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      } catch {
        return `tr-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
      }
    }

    function escapeSel(value) {
      if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
      return String(value).replace(/["\\]/g, "\\$&");
    }

    function selectorFor(el) {
      if (!el || el.nodeType !== 1) return "";
      if (el.id) return `#${escapeSel(el.id)}`;
      const parts = [];
      let node = el;
      for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth += 1) {
        const testId = node.getAttribute && node.getAttribute("data-testid");
        let part = node.tagName ? node.tagName.toLowerCase() : "node";
        if (testId) {
          part += `[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
          parts.unshift(part);
          break;
        }
        const aria = node.getAttribute && node.getAttribute("aria-label");
        if (aria) part += `[aria-label="${String(aria).replace(/"/g, '\\"').slice(0, 80)}"]`;
        const parent = node.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        if (typeof document !== "undefined" && node === document.body) break;
        node = parent;
      }
      return parts.join(" > ");
    }

    function visibleText(el) {
      if (!el) return "";
      const raw = el.innerText ?? el.textContent ?? "";
      return String(raw).replace(/\s+/g, " ").trim().slice(0, 800);
    }

    function rectOf(el) {
      try {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      } catch {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
    }

    /**
     * Turn a DOM element into a mesh-domain anchor. Semantic data-mesh-*
     * attributes win; the CSS selector is only the human-readable fallback.
     */
    function deriveAnchor(el, state) {
      if (!el || el.nodeType !== 1) return null;
      const capEl = el.closest ? el.closest("[data-mesh-cap]") : null;
      const taskEl = el.closest ? el.closest("[data-mesh-task]") : null;
      const settingEl = el.closest ? el.closest("[data-mesh-setting]") : null;
      const peerEl = el.closest ? el.closest("[data-mesh-peer]") : null;
      const cardEl = el.closest ? el.closest("[data-mesh-card]") : null;
      const viewEl = el.closest ? el.closest("[data-mesh-view]") : null;
      const anchor = {
        kind: "element",
        view: (viewEl && viewEl.getAttribute("data-mesh-view")) || "mesh",
        selector: selectorFor(el).slice(0, 1200),
        text: visibleText(el),
        tag: (el.tagName || "").toLowerCase(),
        rect: rectOf(el),
        pageUrl: typeof location !== "undefined" ? location.href : "",
      };
      const attr = (node, name) => (node && node.getAttribute ? node.getAttribute(name) || "" : "");
      if (capEl) {
        anchor.kind = "capability";
        anchor.cap = attr(capEl, "data-mesh-cap");
        anchor.machine = attr(capEl, "data-mesh-peer") || attr(peerEl, "data-mesh-peer");
        anchor.instanceId = attr(capEl, "data-mesh-instance") || attr(peerEl, "data-mesh-instance");
      } else if (taskEl) {
        anchor.kind = "task";
        anchor.taskKey = attr(taskEl, "data-mesh-task");
        anchor.taskId = attr(taskEl, "data-mesh-task-id") || anchor.taskKey;
        anchor.thread = attr(taskEl, "data-mesh-thread");
        anchor.machine = attr(taskEl, "data-mesh-peer");
      } else if (settingEl) {
        anchor.kind = "setting";
        anchor.key = attr(settingEl, "data-mesh-setting");
      } else if (peerEl) {
        anchor.kind = "peer";
        anchor.machine = attr(peerEl, "data-mesh-peer");
        anchor.instanceId = attr(peerEl, "data-mesh-instance");
      } else if (cardEl) {
        anchor.kind = "card";
        anchor.card = attr(cardEl, "data-mesh-card");
      }
      if (!anchor.machine && anchor.kind === "element") {
        const self = state && state.self;
        if (self && self.machine) anchor.machine = self.machine;
      }
      return anchor;
    }

    function anchorLabel(anchor) {
      if (!anchor) return "未选择";
      if (anchor.kind === "capability") {
        return `${anchor.machine || "peer"} / capability:${anchor.cap || "?"}`;
      }
      if (anchor.kind === "task") {
        return `task:${anchor.taskId || anchor.taskKey || "?"}${anchor.thread ? ` / thread:${anchor.thread}` : ""}`;
      }
      if (anchor.kind === "setting") return `setting:${anchor.key || "?"}`;
      if (anchor.kind === "peer") return `peer:${anchor.machine || "?"}`;
      if (anchor.kind === "card") return `card:${anchor.card || "?"}`;
      return `element:${anchor.tag || "?"}${anchor.text ? ` · ${anchor.text.slice(0, 42)}` : ""}`;
    }

    function anchorKindLabel(anchor) {
      if (!anchor) return "元素";
      return {
        capability: "能力",
        task: "任务",
        setting: "设置",
        peer: "设备",
        card: "卡片",
        element: "元素",
      }[anchor.kind] || "元素";
    }

    /**
     * A compact snapshot of the entity at capture time. The receiver should
     * never have to re-query the sender to know what the anchor pointed at.
     */
    function snapshotFor(anchor, state) {
      const out = { capturedAt: new Date().toISOString() };
      if (!state || !anchor) return out;
      const peers = Array.isArray(state.peers) ? state.peers : [];
      const self = state.self || null;
      const peer =
        (anchor.instanceId && peers.find((p) => p.id === anchor.instanceId)) ||
        (anchor.machine && peers.find((p) => p.machine === anchor.machine)) ||
        null;
      const selfMatch = !!(self && anchor.machine && self.machine === anchor.machine);
      if (peer || selfMatch) {
        const p = peer || self;
        const caps = p.capabilities || {};
        out.peer = {
          machine: p.machine || anchor.machine,
          self: selfMatch,
          online: selfMatch || !!p.online,
          host: p.host || "",
          port: p.port || 0,
          os: p.os || p.platform || "",
          version: p.version || "",
          lastSeen: p.lastSeen || "",
          capabilitiesStale: !!p.capabilitiesStale,
          capabilitiesAt: caps.capabilitiesAt || "",
          runtimes: caps.runtimes && typeof caps.runtimes === "object" ? Object.keys(caps.runtimes).slice(0, 12) : [],
          gpu: (caps.gpu && caps.gpu.name) || "",
        };
      }
      if (anchor.kind === "task") {
        const task = taskList(state).find(
          (t) => t.key === anchor.taskKey || t.id === anchor.taskId,
        );
        if (task) {
          out.task = {
            id: task.id,
            dir: task.dir,
            peer: task.peer,
            thread: task.thread,
            at: task.at,
            status: task.status,
            text: String(task.text || "").slice(0, 600),
          };
        }
      }
      if (anchor.kind === "capability") {
        const caps = (peer && peer.capabilities) || (selfMatch && self && self.capabilities) || {};
        let value = "";
        if (anchor.cap === "gpu") value = (caps.gpu && caps.gpu.name) || "";
        else if (caps.runtimes) value = caps.runtimes[anchor.cap] || "";
        out.capability = { key: anchor.cap, value: String(value).slice(0, 200) };
      }
      if (anchor.kind === "setting") {
        const config = state.config || {};
        const value = config[anchor.key];
        out.setting = {
          key: anchor.key,
          value: value === undefined ? null : String(JSON.stringify(value)).slice(0, 300),
        };
      }
      try {
        if (JSON.stringify(out).length > 5000) {
          if (out.peer) out.peer.runtimes = [];
          if (out.task) out.task.text = out.task.text.slice(0, 200);
        }
      } catch {
        /* noop */
      }
      return out;
    }

    function transferThread(id) {
      return `transfer:${id}`;
    }

    function transferPrompt(record) {
      const a = record.anchor || {};
      const lines = [
        `[Mesh 锚定传输 #${record.id}]`,
        "这是一条从 Mesh 工作台直接点选的上下文；不需要再问“你指的是哪个元素”。",
        `目标: ${anchorLabel(a)}`,
        a.view ? `界面: ${a.view}` : "",
        a.selector ? `选择器: ${a.selector}` : "",
        a.text ? `引用: ${a.text}` : "",
        `现场: ${JSON.stringify(record.snapshot || {})}`,
        record.intent ? `用户意图: ${record.intent}` : "",
        record.route === "mesh" ? `线程: ${record.thread}（回复请沿用这个线程）` : "",
        "请据此处理；完成后回复结果。",
      ];
      return lines.filter(Boolean).join("\n").slice(0, 8000);
    }

    function transferMarkdown(record) {
      const a = record.anchor || {};
      const lines = [
        `> **锚定传输** \`${record.id}\` · ${anchorKindLabel(a)} · ${record.route === "mesh" ? "mesh 对端" : record.route === "agent" ? "当前会话" : "剪贴板"}`,
        `> 目标：${anchorLabel(a)}`,
        a.text ? `> 引用：${a.text}` : "",
        a.selector ? `> 选择器：\`${a.selector}\`` : "",
        `> 现场：\`${JSON.stringify(record.snapshot || {}).slice(0, 1200)}\``,
        "",
        record.intent ? `意图：${record.intent}` : "意图：（未填写）",
      ];
      return lines.filter((line) => line !== "").join("\n");
    }

    const TRANSFER_STATUS = {
      sent: ["已发送", "warn"],
      delivered: ["已送达", "ok"],
      replied: ["已回复", "ok"],
      failed: ["失败", "err"],
      prefilled: ["已填入输入框", "idle"],
      copied: ["已复制", "idle"],
    };

    function transferStatusMeta(status) {
      const m = TRANSFER_STATUS[status] || [status || "未知", "idle"];
      return { label: m[0], kind: m[1] };
    }

    function loadTransfers() {
      try {
        const raw = localStorage.getItem(TRANSFER_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((item) => item && item.id).slice(0, TRANSFER_LIMIT) : [];
      } catch {
        return [];
      }
    }

    function saveTransfers(list) {
      try {
        localStorage.setItem(TRANSFER_KEY, JSON.stringify((list || []).slice(0, TRANSFER_LIMIT)));
      } catch {
        /* private mode */
      }
    }

    function currentSessionId() {
      try {
        const uiWorkspace = pluginCtx && pluginCtx.get ? pluginCtx.get("uiWorkspace") : null;
        const id = uiWorkspace && uiWorkspace.selection && uiWorkspace.selection.getSnapshot
          ? uiWorkspace.selection.getSnapshot().sessionId
          : "";
        if (id) return id;
      } catch {
        /* noop */
      }
      try {
        const sidebarRight = pluginCtx && pluginCtx.get ? pluginCtx.get("sidebarRight") : null;
        const id = sidebarRight && sidebarRight.mounted && sidebarRight.mounted.getSnapshot
          ? sidebarRight.mounted.getSnapshot()
          : "";
        if (id) return id;
      } catch {
        /* noop */
      }
      return "";
    }

    async function sendToAgent(prompt, sessionId) {
      const ctx = pluginCtx;
      const sessions = (ctx && ctx.get && ctx.get("sessions")) || (ctx && ctx.sessions);
      const conversation = ctx && ctx.get ? ctx.get("conversation") : null;
      if (!sessionId) throw new Error("没有当前会话（先打开一个会话）");
      const scope = sessions && sessions.scope ? sessions.scope(sessionId) : undefined;
      if (!conversation || !conversation.input || !scope) throw new Error("当前会话的输入服务不可用");
      const input = conversation.input.for(scope);
      input.setDraft(prompt);
      // Return to the conversation first: the composer must be mounted for the
      // enter transaction to have a live default sink. The draft is already in
      // the input store, so the composer shows the packet while it mounts.
      try {
        const layout = (ctx.get && ctx.get("layout")) || ctx.layout;
        layout?.selectPanel?.(null);
      } catch {
        /* noop */
      }
      await new Promise((resolve) => setTimeout(resolve, 140));
      if (typeof input.submit === "function") {
        try {
          input.submit("queue");
          return "sent";
        } catch {
          /* fall through to prefill */
        }
      }
      return "prefilled";
    }

    function transferRouteLabel(route, record) {
      if (route === "mesh") return record && record.anchor && record.anchor.machine ? record.anchor.machine : "mesh 对端";
      if (route === "agent") return "当前会话";
      return "剪贴板";
    }

    function buildDiagnostics(state) {
      const self = (state && state.self) || {};
      const cfg = (state && state.config) || {};
      const peers = state && Array.isArray(state.peers) ? state.peers : [];
      const ts = (state && state.tsnet) || {};
      return [
        `Mesh ${self.version || ""}`.trim(),
        self.diskVersion && self.diskVersion !== self.version
          ? `disk: ${self.diskVersion} (已升级，进程未重启)`
          : "",
        `machine: ${self.machine || ""}`,
        `address: ${shortAddress(self.host, self.port)}`,
        `hostname: ${self.hostname || ""}`,
        `mac: ${self.mac || ""}`,
        `platform: ${self.platform || ""}`,
        `discovery: ${cfg.useMulticast === false ? "scan" : "multicast+scan"}`,
        `scanIntervalMs: ${cfg.scanIntervalMs == null ? "" : cfg.scanIntervalMs}`,
        `pingIntervalMs: ${cfg.pingIntervalMs == null ? "" : cfg.pingIntervalMs}`,
        `pairing: ${cfg.requirePairing ? "on" : "off"}${cfg.requirePairingPinned ? " (pinned)" : ""}`,
        `tsnet: ${ts.enabled ? "enabled" : "off"}${ts.node && ts.node.phase ? ` / ${ts.node.phase}` : ""}`,
        `peers: ${peers.length} (online ${peers.filter((p) => p && p.online).length})`,
      ].join("\n");
    }

    // ─────────────────────── 样式 ───────────────────────

    const CSS = `
.mesh-root {
  --mesh-bg: var(--dsw-alias-bg-base);
  --mesh-surface: var(--dsw-alias-bg-layer-1);
  --mesh-surface-2: var(--dsw-alias-bg-layer-2);
  --mesh-line: var(--dsw-alias-border-l1);
  --mesh-line-2: var(--dsw-alias-border-l2);
  --mesh-fg: var(--dsw-alias-label-primary);
  --mesh-muted: var(--dsw-alias-label-secondary);
  --mesh-accent: var(--dsw-alias-brand-primary);
  --mesh-ok: var(--dsw-alias-state-success-primary);
  --mesh-warn: var(--dsw-alias-state-warn-primary);
  --mesh-err: var(--dsw-alias-state-error-primary);
  --mesh-idle: var(--dsw-alias-state-idle-primary);
  --mesh-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --mesh-ease-inout: cubic-bezier(0.77, 0, 0.175, 1);
  --mesh-ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
  --mesh-dur-press: 120ms;
  --mesh-dur-fast: 160ms;
  --mesh-dur-base: 220ms;
  --mesh-dur-slow: 280ms;
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--mesh-bg);
  color: var(--mesh-fg);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
  overscroll-behavior: contain;
}
.mesh-root *, .mesh-root *::before, .mesh-root *::after { box-sizing: border-box; }
.mesh-root :where(button) { font: inherit; }
.mesh-root a { color: var(--mesh-accent); text-decoration: none; }
.mesh-root a:hover { text-decoration: underline; }
.mesh-root ::-webkit-scrollbar { width: 10px; height: 10px; }
.mesh-root ::-webkit-scrollbar-thumb {
  background: var(--mesh-line-2);
  border: 3px solid transparent;
  background-clip: content-box;
  border-radius: 999px;
}
.mesh-root ::-webkit-scrollbar-track { background: transparent; }

/* ── 顶栏 ── */
.mesh-topbar {
  position: relative;
  flex: 0 0 auto;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 20px;
  border-bottom: 1px solid var(--mesh-line);
  background: var(--mesh-bg);
}
.mesh-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mesh-logo {
  width: 26px; height: 26px; border-radius: 8px;
  display: grid; place-items: center;
  background: var(--mesh-surface-2);
  border: 1px solid var(--mesh-line);
  color: var(--mesh-fg);
}
.mesh-wordmark { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.mesh-wordsub { font-size: 11px; color: var(--mesh-muted); }
.mesh-tabs {
  display: flex; align-items: center; gap: 2px;
  padding: 3px; border-radius: 9px;
  background: var(--mesh-surface-2);
}
.mesh-tab {
  display: inline-flex; align-items: center; gap: 6px;
  border: 0; background: transparent; color: var(--mesh-muted);
  font-size: 12px; font-weight: 500; line-height: 1;
  padding: 6px 10px; border-radius: 7px; cursor: pointer;
  white-space: nowrap;
  transition: background var(--mesh-dur-fast) var(--mesh-ease-out),
    color var(--mesh-dur-fast) var(--mesh-ease-out),
    box-shadow var(--mesh-dur-fast) var(--mesh-ease-out),
    transform var(--mesh-dur-press) var(--mesh-ease-out);
}
.mesh-tab:active { transform: scale(0.98); }
.mesh-tab:hover { color: var(--mesh-fg); }
.mesh-tab[aria-selected="true"] {
  background: var(--mesh-surface);
  color: var(--mesh-accent);
  box-shadow: inset 0 -2px 0 var(--mesh-accent);
  font-weight: 600;
}
.mesh-count {
  min-width: 16px; padding: 0 5px; border-radius: 999px;
  background: var(--mesh-bg); color: var(--mesh-muted);
  font-size: 10px; line-height: 16px; text-align: center;
  font-variant-numeric: tabular-nums;
}
.mesh-topright { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.mesh-health {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 11.5px; color: var(--mesh-muted); white-space: nowrap;
}
.mesh-health-text { color: var(--mesh-fg); font-weight: 500; }
.mesh-health-sub { color: var(--mesh-muted); font-variant-numeric: tabular-nums; }
.mesh-value { display: inline-block; animation: mesh-value-in var(--mesh-dur-fast) var(--mesh-ease-out) both; }
.mesh-progress {
  position: absolute; left: 0; right: 0; bottom: -1px;
  height: 2px; overflow: hidden; pointer-events: none; z-index: 6;
}
.mesh-progress-bar {
  display: block; width: 42%; height: 100%;
  background: linear-gradient(90deg, transparent, var(--mesh-accent), transparent);
  animation: mesh-progress 1.1s linear infinite;
}

/* ── 横幅 ── */
.mesh-banner {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 9px;
  padding: 7px 20px;
  border-bottom: 1px solid var(--mesh-line);
  background: var(--mesh-surface);
  font-size: 12px;
  animation: mesh-banner-in var(--mesh-dur-base) var(--mesh-ease-out) both;
}
.mesh-banner > svg { flex: 0 0 auto; color: var(--mesh-warn); }
.mesh-banner.is-error > svg { color: var(--mesh-err); }
.mesh-banner.is-warn > svg { color: var(--mesh-warn); }
.mesh-banner-main { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.mesh-banner-title { font-weight: 600; }
.mesh-banner-detail { color: var(--mesh-muted); font-size: 11.5px; }

/* ── 视图 / 分栏 ── */
.mesh-view { flex: 1; min-height: 0; display: flex; flex-direction: column; animation: mesh-view-in var(--mesh-dur-fast) var(--mesh-ease-out) both; }
.mesh-split { flex: 1; min-height: 0; display: flex; }
.mesh-list-pane {
  flex: 0 0 308px; width: 308px; min-height: 0;
  display: flex; flex-direction: column;
  background: var(--mesh-surface);
  border-right: 1px solid var(--mesh-line);
}
.mesh-pane-head {
  flex: 0 0 auto;
  display: flex; align-items: baseline; gap: 8px;
  padding: 15px 16px 9px;
}
.mesh-pane-title { font-size: 12px; font-weight: 600; letter-spacing: .01em; }
.mesh-pane-sub { margin-left: auto; font-size: 10.5px; color: var(--mesh-muted); white-space: nowrap; }
.mesh-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 8px 12px; }
.mesh-list-heading {
  padding: 10px 8px 5px;
  font-size: 10px; font-weight: 600; letter-spacing: .08em;
  color: var(--mesh-muted);
}
.mesh-list-empty { padding: 10px 8px 12px; font-size: 11.5px; color: var(--mesh-muted); line-height: 1.6; }
.mesh-list-actions { padding: 10px 8px 0; }
.mesh-row {
  position: relative;
  width: 100%;
  display: flex; align-items: center; gap: 10px;
  padding: 8px;
  border: 1px solid transparent; border-radius: 10px;
  background: transparent; text-align: left; cursor: pointer;
  color: inherit;
  animation: mesh-row-in var(--mesh-dur-base) var(--mesh-ease-out) backwards;
  transition: background var(--mesh-dur-fast) ease,
    border-color var(--mesh-dur-fast) ease,
    transform var(--mesh-dur-press) var(--mesh-ease-out);
}
.mesh-row:hover { background: var(--mesh-surface-2); }
.mesh-row:active { transform: scale(0.995); }
.mesh-row.is-active { background: var(--mesh-surface-2); border-color: var(--mesh-line); }
.mesh-row.is-active::before {
  content: ""; position: absolute; left: 0; top: 9px; bottom: 9px;
  width: 2px; border-radius: 2px; background: var(--mesh-accent);
  transform-origin: center;
  animation: mesh-bar-in var(--mesh-dur-base) var(--mesh-ease-out) both;
}
.mesh-row.is-offline .mesh-row-name, .mesh-row.is-offline .mesh-avatar { opacity: .62; }
.mesh-row-name { transition: opacity .35s var(--mesh-ease-out); }
.mesh-avatar {
  position: relative; flex: 0 0 auto;
  width: 34px; height: 34px; border-radius: 10px;
  display: grid; place-items: center;
  background: var(--mesh-bg);
  border: 1px solid var(--mesh-line);
  color: var(--mesh-muted);
  font-size: 12px; font-weight: 600;
  transition: opacity .35s var(--mesh-ease-out), border-color var(--mesh-dur-fast) ease, background var(--mesh-dur-fast) ease;
}
.mesh-avatar .mesh-dot {
  position: absolute; right: -2px; bottom: -2px;
  box-shadow: 0 0 0 2px var(--mesh-surface-2);
}
.mesh-row-main { flex: 1; min-width: 0; }
.mesh-row-name {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mesh-row-sub {
  display: flex; align-items: center; gap: 5px;
  margin-top: 2px;
  font-size: 10.5px; color: var(--mesh-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mesh-dot-sep { opacity: .5; }
.mesh-row-side { flex: 0 0 auto; color: var(--mesh-muted); display: flex; align-items: center; }

/* ── 详情 ── */
.mesh-detail-pane { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; background: var(--mesh-bg); }
.mesh-detail { max-width: 860px; padding: 26px 30px 52px; animation: mesh-detail-in var(--mesh-dur-base) var(--mesh-ease-out) both; }
.mesh-back {
  display: none; align-items: center; gap: 3px;
  border: 0; background: transparent; color: var(--mesh-muted);
  font-size: 12px; padding: 0; margin-bottom: 10px; cursor: pointer;
}
.mesh-detail-head { display: flex; align-items: flex-start; gap: 14px; }
.mesh-detail-avatar {
  position: relative; flex: 0 0 auto;
  width: 48px; height: 48px; border-radius: 14px;
  display: grid; place-items: center;
  background: var(--mesh-surface-2);
  border: 1px solid var(--mesh-line);
  font-size: 18px; font-weight: 600; color: var(--mesh-muted);
}
.mesh-detail-avatar::after {
  content: ""; position: absolute; inset: -4px;
  border: 1px solid var(--mesh-line-2); border-radius: 18px;
  pointer-events: none; opacity: .35;
  animation: mesh-halo 4.2s ease-in-out infinite;
}
.mesh-detail-avatar .mesh-dot { position: absolute; right: -2px; bottom: -2px; box-shadow: 0 0 0 3px var(--mesh-bg); }
.mesh-detail-copy { flex: 1; min-width: 0; }
.mesh-eyebrow {
  font-size: 10px; font-weight: 600; letter-spacing: .1em;
  text-transform: uppercase; color: var(--mesh-muted);
  margin-bottom: 5px;
}
.mesh-h1 {
  margin: 0;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 24px; line-height: 1.2; font-weight: 600; letter-spacing: -0.02em;
  word-break: break-word;
}
.mesh-meta {
  display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap;
  margin-top: 7px;
  font-size: 11.5px; color: var(--mesh-muted);
}
.mesh-address { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.mesh-detail-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: 0 0 auto; }

.mesh-section { border-top: 1px solid var(--mesh-line); padding: 18px 0; }
.mesh-section-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.mesh-section-title { font-size: 12px; font-weight: 600; letter-spacing: .01em; }
.mesh-section-note { margin-left: auto; font-size: 10.5px; color: var(--mesh-muted); }
.mesh-p { margin: 0; color: var(--mesh-muted); font-size: 12px; line-height: 1.7; }

.mesh-note {
  display: flex; align-items: flex-start; gap: 8px;
  margin: 0 0 14px; padding: 9px 11px;
  border-radius: 8px;
  background: var(--mesh-surface-2);
  font-size: 11.5px; line-height: 1.6; color: var(--mesh-muted);
  animation: mesh-note-in var(--mesh-dur-base) var(--mesh-ease-out) both;
}
.mesh-note > svg { flex: 0 0 auto; margin-top: 1px; }
.mesh-note.is-warn { color: var(--mesh-warn); }
.mesh-note.is-err { color: var(--mesh-err); }
.mesh-note > span { flex: 1; }

.mesh-caps { display: flex; flex-direction: column; gap: 8px; }
.mesh-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mesh-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 8px; border-radius: 6px;
  background: var(--mesh-surface-2);
  font-size: 11px; line-height: 1.5; color: var(--mesh-fg);
}
.mesh-chip.is-muted { background: transparent; border: 1px solid var(--mesh-line); color: var(--mesh-muted); }
.mesh-chip-label { color: var(--mesh-muted); }
.mesh-chip-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; }
.mesh-specs { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--mesh-muted); }
.mesh-text-btn {
  align-self: flex-start; border: 0; background: transparent;
  color: var(--mesh-muted); font-size: 11px; padding: 0; cursor: pointer;
}
.mesh-text-btn:hover { color: var(--mesh-fg); text-decoration: underline; }

.mesh-channel { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid var(--mesh-line); }
.mesh-channel:first-child { border-top: 0; padding-top: 0; }
.mesh-channel-icon {
  flex: 0 0 auto; width: 28px; height: 28px; border-radius: 8px;
  display: grid; place-items: center;
  background: var(--mesh-surface-2); color: var(--mesh-muted);
}
.mesh-channel-main { flex: 1; min-width: 0; }
.mesh-channel-title { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; }
.mesh-channel-sub { margin-top: 1px; font-size: 10.5px; color: var(--mesh-muted); font-variant-numeric: tabular-nums; }

.mesh-fold { border-top: 1px solid var(--mesh-line); margin-top: 14px; padding-top: 4px; }
.mesh-fold-head {
  width: 100%; display: flex; align-items: center; gap: 7px;
  padding: 7px 0; border: 0; background: transparent;
  cursor: pointer; text-align: left; color: var(--mesh-muted);
}
.mesh-fold-head:hover { color: var(--mesh-fg); }
.mesh-fold-title { font-size: 11.5px; font-weight: 500; }
.mesh-fold-sub { margin-left: auto; font-size: 10.5px; color: var(--mesh-muted); }
.mesh-fold-status { margin-left: auto; }
.mesh-fold-chevron { margin-left: auto; display: inline-flex; transition: transform .16s ease; }
.mesh-fold-chevron.is-open { transform: rotate(90deg); }
.mesh-fold-status + .mesh-fold-chevron { margin-left: 0; }
.mesh-fold-body { padding: 4px 0 8px; }
.mesh-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--mesh-dur-base) var(--mesh-ease-inout);
}
.mesh-collapse.is-open { grid-template-rows: 1fr; }
.mesh-collapse-inner { min-height: 0; overflow: hidden; }
.mesh-collapse-inner > * {
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity var(--mesh-dur-fast) ease, transform var(--mesh-dur-base) var(--mesh-ease-out);
}
.mesh-collapse.is-open .mesh-collapse-inner > * { opacity: 1; transform: none; }
.mesh-kv { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 7px 14px; margin: 0; font-size: 11.5px; }
.mesh-kv dd { overflow-wrap: anywhere; }
.mesh-kv dt { color: var(--mesh-muted); }
.mesh-kv dd { margin: 0; color: var(--mesh-fg); word-break: break-all; }

/* ── 状态 / 徽章 ── */
.mesh-dot {
  position: relative;
  display: inline-block; width: 6px; height: 6px; border-radius: 999px;
  background: var(--mesh-idle); flex: 0 0 auto;
  transition: background-color .25s ease, box-shadow .25s ease;
}
.mesh-dot.is-ok { background: var(--mesh-ok); }
.mesh-dot.is-warn { background: var(--mesh-warn); }
.mesh-dot.is-err { background: var(--mesh-err); }
.mesh-dot.is-idle { background: var(--mesh-idle); }
.mesh-row.is-active .mesh-dot.is-ok::after,
.mesh-health .mesh-dot.is-ok::after,
.mesh-detail-avatar .mesh-dot.is-ok::after {
  content: ""; position: absolute; inset: -2px;
  border: 1px solid var(--mesh-ok); border-radius: 999px;
  pointer-events: none; opacity: 0;
  animation: mesh-dot-ping 3.8s var(--mesh-ease-out) infinite;
}
.mesh-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--mesh-fg); white-space: nowrap; }
.mesh-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 6px; border-radius: 999px;
  background: var(--mesh-surface-2);
  font-size: 10px; line-height: 1.6; font-weight: 500;
  color: var(--mesh-muted); white-space: nowrap;
  transition: color var(--mesh-dur-fast) ease, background var(--mesh-dur-fast) ease;
}
.mesh-badge.is-ok { color: var(--mesh-ok); }
.mesh-badge.is-warn { color: var(--mesh-warn); }
.mesh-badge.is-err { color: var(--mesh-err); }
.mesh-badge.is-accent { color: var(--mesh-accent); }

/* ── 按钮 ── */
.mesh-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 11px;
  border: 1px solid transparent; border-radius: 7px;
  background: transparent;
  color: var(--mesh-fg);
  font-size: 12px; font-weight: 500; line-height: 1;
  cursor: pointer; white-space: nowrap;
  transition: background var(--mesh-dur-fast) ease,
    border-color var(--mesh-dur-fast) ease,
    color var(--mesh-dur-fast) ease,
    opacity var(--mesh-dur-fast) ease,
    transform var(--mesh-dur-press) var(--mesh-ease-out);
}
.mesh-btn:active:not(:disabled) { transform: scale(0.97); }
.mesh-btn--icon:active:not(:disabled) { transform: scale(0.94); }
.mesh-btn:disabled { opacity: .42; cursor: not-allowed; }
.mesh-btn--primary { background: var(--mesh-fg); color: var(--mesh-bg); }
.mesh-btn--primary:hover:not(:disabled) { opacity: .88; }
.mesh-btn--secondary { background: var(--mesh-surface); border-color: var(--mesh-line-2); color: var(--mesh-fg); }
.mesh-btn--secondary:hover:not(:disabled) { background: var(--mesh-surface-2); }
.mesh-btn--ghost { color: var(--mesh-muted); }
.mesh-btn--ghost:hover:not(:disabled) { background: var(--mesh-surface-2); color: var(--mesh-fg); }
.mesh-btn.is-active { background: var(--mesh-surface-2); color: var(--mesh-accent); }
.mesh-btn--danger { color: var(--mesh-err); }
.mesh-btn--danger:hover:not(:disabled) { background: var(--mesh-surface-2); }
.mesh-btn--sm { height: 26px; padding: 0 9px; font-size: 11.5px; border-radius: 6px; }
.mesh-btn--icon { width: 30px; padding: 0; }
.mesh-btn--icon.mesh-btn--sm { width: 26px; }
.mesh-btn:focus-visible, .mesh-tab:focus-visible, .mesh-row:focus-visible,
.mesh-task-row:focus-visible, .mesh-fold-head:focus-visible, .mesh-set-head:focus-visible,
.mesh-switch:focus-visible, .mesh-seg button:focus-visible, .mesh-text-btn:focus-visible,
.mesh-back:focus-visible, .mesh-toast-close:focus-visible, .mesh-toast-action:focus-visible {
  outline: 2px solid var(--mesh-accent); outline-offset: 2px;
}
.mesh-spinner {
  width: 12px; height: 12px; border-radius: 999px;
  border: 1.5px solid currentColor; border-top-color: transparent;
  animation: mesh-spin .7s linear infinite;
}

/* ── 表单 ── */
.mesh-input, .mesh-textarea {
  width: 100%;
  border: 1px solid var(--mesh-line-2); border-radius: 8px;
  background: var(--mesh-bg); color: var(--mesh-fg);
  padding: 8px 10px; font: inherit; font-size: 12.5px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.mesh-input::placeholder, .mesh-textarea::placeholder { color: var(--mesh-muted); opacity: .8; }
.mesh-input:focus, .mesh-textarea:focus {
  outline: none;
  border-color: var(--mesh-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--mesh-accent) 16%, transparent);
}
.mesh-textarea { min-height: 148px; resize: vertical; line-height: 1.65; }
.mesh-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.mesh-field-label { font-size: 11.5px; font-weight: 600; color: var(--mesh-fg); }
.mesh-field-hint { font-size: 10.5px; color: var(--mesh-muted); line-height: 1.6; }
.mesh-switch {
  position: relative; flex: 0 0 auto;
  width: 34px; height: 20px; padding: 0;
  border: 1px solid var(--mesh-line-2); border-radius: 999px;
  background: var(--mesh-surface-2); cursor: pointer;
  transition: background .18s ease, border-color .18s ease;
}
.mesh-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 999px;
  background: var(--mesh-muted);
  transition: transform .18s ease, background .18s ease;
}
.mesh-switch[aria-checked="true"] { background: var(--mesh-fg); border-color: var(--mesh-fg); }
.mesh-switch[aria-checked="true"]::after { transform: translateX(14px); background: var(--mesh-bg); }
.mesh-switch:disabled { opacity: .4; cursor: not-allowed; }
.mesh-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--mesh-surface-2); }
.mesh-seg button {
  border: 0; background: transparent; color: var(--mesh-muted);
  font-size: 11px; padding: 4px 8px; border-radius: 6px; cursor: pointer;
  white-space: nowrap;
  transition: background var(--mesh-dur-fast) ease, color var(--mesh-dur-fast) ease;
}
.mesh-seg button[aria-pressed="true"] {
  background: var(--mesh-surface); color: var(--mesh-fg);
  box-shadow: 0 1px 2px rgba(0,0,0,.06);
}
.mesh-seg-count { margin-left: 4px; color: var(--mesh-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.mesh-list-toolbar { padding: 0 12px 8px; }

/* ── 派发 sheet ── */
.mesh-sheet-layer {
  position: absolute; inset: 0; z-index: 40;
  display: flex; justify-content: flex-end;
  background: rgba(0,0,0,.24);
  opacity: 0; pointer-events: none;
  transition: opacity var(--mesh-dur-base) ease;
}
.mesh-sheet-layer.is-open { opacity: 1; pointer-events: auto; }
.mesh-sheet {
  width: 440px; max-width: 100%; height: 100%;
  display: flex; flex-direction: column;
  background: var(--mesh-surface);
  border-left: 1px solid var(--mesh-line);
  box-shadow: -16px 0 48px rgba(0,0,0,.16);
  opacity: .55;
  transform: translateX(24px);
  transition: transform 200ms var(--mesh-ease-out), opacity 160ms ease;
}
.mesh-sheet-layer.is-open .mesh-sheet {
  opacity: 1;
  transform: none;
  transition: transform var(--mesh-dur-slow) var(--mesh-ease-drawer), opacity 200ms ease;
}
.mesh-sheet-head, .mesh-sheet-body, .mesh-sheet-foot {
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 160ms ease, transform 200ms var(--mesh-ease-out);
}
.mesh-sheet-layer.is-open .mesh-sheet-head { opacity: 1; transform: none; transition-delay: 40ms; }
.mesh-sheet-layer.is-open .mesh-sheet-body { opacity: 1; transform: none; transition-delay: 60ms; }
.mesh-sheet-layer.is-open .mesh-sheet-foot { opacity: 1; transform: none; transition-delay: 80ms; }
.mesh-sheet-head {
  flex: 0 0 auto;
  display: flex; align-items: flex-start; gap: 12px;
  padding: 20px 20px 14px;
  border-bottom: 1px solid var(--mesh-line);
}
.mesh-sheet-head .mesh-detail-avatar { width: 38px; height: 38px; border-radius: 11px; font-size: 14px; }
.mesh-sheet-title { flex: 1; min-width: 0; }
.mesh-sheet-eyebrow { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--mesh-muted); margin-bottom: 3px; }
.mesh-sheet-name { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.mesh-sheet-body { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px; }
.mesh-sheet-foot { flex: 0 0 auto; padding: 14px 20px 18px; border-top: 1px solid var(--mesh-line); }
.mesh-sheet-error { margin-top: 10px; font-size: 11.5px; color: var(--mesh-err); animation: mesh-note-in var(--mesh-dur-fast) var(--mesh-ease-out) both; }
.mesh-target {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 10px; margin-bottom: 14px;
  border-radius: 8px; background: var(--mesh-surface-2);
  font-size: 11.5px; color: var(--mesh-muted);
}
.mesh-target strong { color: var(--mesh-fg); font-weight: 600; }
.mesh-hint { margin: 8px 0 0; font-size: 10.5px; color: var(--mesh-muted); line-height: 1.6; }

/* ── 任务 ── */
.mesh-task-row {
  position: relative;
  width: 100%;
  display: flex; align-items: flex-start; gap: 9px;
  padding: 9px 8px;
  border: 1px solid transparent; border-radius: 10px;
  background: transparent; text-align: left; cursor: pointer;
  animation: mesh-row-in var(--mesh-dur-base) var(--mesh-ease-out) backwards;
  transition: background var(--mesh-dur-fast) ease,
    border-color var(--mesh-dur-fast) ease,
    transform var(--mesh-dur-press) var(--mesh-ease-out);
}
.mesh-task-row:hover { background: var(--mesh-surface-2); }
.mesh-task-row:active { transform: scale(0.995); }
.mesh-task-row.is-active { background: var(--mesh-surface-2); border-color: var(--mesh-line); }
.mesh-task-row.is-active::before {
  content: ""; position: absolute; left: 0; top: 10px; bottom: 10px;
  width: 2px; border-radius: 2px; background: var(--mesh-accent);
  transform-origin: center;
  animation: mesh-bar-in var(--mesh-dur-base) var(--mesh-ease-out) both;
}
.mesh-task-icon {
  flex: 0 0 auto; width: 27px; height: 27px; border-radius: 8px;
  display: grid; place-items: center;
  background: var(--mesh-bg); border: 1px solid var(--mesh-line); color: var(--mesh-muted);
}
.mesh-task-main { flex: 1; min-width: 0; }
.mesh-task-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mesh-task-peer { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mesh-task-time { margin-left: auto; font-size: 10px; color: var(--mesh-muted); white-space: nowrap; }
.mesh-task-preview { margin-top: 0; font-size: 10.5px; color: var(--mesh-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mesh-task-status {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 6px; border-radius: 999px;
  background: var(--mesh-bg); color: var(--mesh-muted);
  font-size: 9.5px; white-space: nowrap; flex: 0 0 auto;
  transition: color var(--mesh-dur-fast) ease, background var(--mesh-dur-fast) ease;
}
.mesh-task-status.is-ok { color: var(--mesh-ok); }
.mesh-task-status.is-warn { color: var(--mesh-warn); }
.mesh-task-status.is-err { color: var(--mesh-err); }
.mesh-task-text {
  margin: 18px 0;
  padding: 14px 16px;
  border: 1px solid var(--mesh-line); border-radius: 10px;
  background: var(--mesh-surface);
  font-size: 12.5px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
}
.mesh-task-error {
  margin: 0 0 16px; padding: 10px 12px;
  border-radius: 8px; background: var(--mesh-surface-2);
  font-size: 11.5px; line-height: 1.6; color: var(--mesh-err);
  white-space: pre-wrap; word-break: break-word;
}
.mesh-recent {
  width: 100%; display: flex; align-items: flex-start; gap: 9px;
  padding: 9px 0; border: 0; border-top: 1px solid var(--mesh-line);
  background: transparent; text-align: left; cursor: pointer;
  transition: background var(--mesh-dur-fast) ease, transform var(--mesh-dur-press) var(--mesh-ease-out);
}
.mesh-recent:hover { background: var(--mesh-surface-2); }
.mesh-recent:active { transform: scale(0.997); }
.mesh-recent-icon {
  flex: 0 0 auto; width: 24px; height: 24px; border-radius: 7px;
  display: grid; place-items: center;
  background: var(--mesh-surface-2); color: var(--mesh-muted);
}
.mesh-recent-main { flex: 1; min-width: 0; }
.mesh-recent-top { display: flex; align-items: center; gap: 7px; }
.mesh-recent-time { margin-left: auto; font-size: 10px; color: var(--mesh-muted); white-space: nowrap; }
.mesh-recent-preview { display: block; margin-top: 2px; font-size: 11px; color: var(--mesh-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mesh-notice {
  flex: 0 0 auto;
  margin: 10px 14px 0;
  padding: 10px 12px;
  border: 1px solid var(--mesh-line); border-left: 2px solid var(--mesh-warn);
  border-radius: 8px;
  background: var(--mesh-surface);
  animation: mesh-note-in var(--mesh-dur-base) var(--mesh-ease-out) both;
}
.mesh-notice-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mesh-notice-head > svg { flex: 0 0 auto; color: var(--mesh-warn); }
.mesh-notice-title { font-size: 12px; font-weight: 600; }
.mesh-notice-sub { font-size: 10.5px; color: var(--mesh-muted); }
.mesh-notice-list { margin-top: 8px; border-top: 1px solid var(--mesh-line); max-height: 190px; overflow-y: auto; }
.mesh-notice-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0; border-bottom: 1px solid var(--mesh-line);
  font-size: 11.5px;
}
.mesh-notice-item:last-child { border-bottom: 0; }
.mesh-notice-thread { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mesh-notice-meta { color: var(--mesh-muted); font-size: 10.5px; white-space: nowrap; }

/* ── 连接 / 设置 ── */
.mesh-settings-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.mesh-settings { max-width: 840px; margin: 0 auto; padding: 28px 32px 64px; }
.mesh-settings-head { margin-bottom: 10px; }
.mesh-settings-head h1 { margin: 0; font-size: 24px; line-height: 1.2; font-weight: 600; letter-spacing: -0.02em; }
.mesh-settings-head p { margin: 6px 0 0; font-size: 12px; color: var(--mesh-muted); }
.mesh-set { border-top: 1px solid var(--mesh-line); }
.mesh-set-head {
  width: 100%; display: flex; align-items: center; gap: 12px;
  padding: 16px 0; border: 0; background: transparent;
  cursor: pointer; text-align: left;
  transition: color var(--mesh-dur-fast) ease;
}
.mesh-set-head:hover .mesh-set-title { color: var(--mesh-accent); }
.mesh-set-title { transition: color var(--mesh-dur-fast) ease; }
.mesh-set-icon {
  flex: 0 0 auto; width: 30px; height: 30px; border-radius: 8px;
  display: grid; place-items: center;
  color: var(--mesh-accent);
  background: color-mix(in srgb, var(--mesh-accent) 8%, transparent);
}
.mesh-set-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mesh-set-title { font-size: 13px; font-weight: 600; color: var(--mesh-fg); }
.mesh-set-sub { font-size: 11.5px; color: var(--mesh-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mesh-set-status { flex: 0 0 auto; }
.mesh-set-body { padding: 0 0 20px 42px; }
.mesh-me { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.mesh-me-name { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
.mesh-me-actions { margin-left: auto; display: flex; gap: 8px; }
.mesh-inline-form { display: flex; align-items: center; gap: 8px; }
.mesh-inline-form .mesh-input { flex: 1; min-width: 0; }
.mesh-code {
  display: block; padding: 8px 10px; border-radius: 7px;
  background: var(--mesh-surface-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; line-height: 1.6;
  word-break: break-all; color: var(--mesh-fg);
}
.mesh-code-row { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
.mesh-code-row .mesh-code { flex: 1; min-width: 0; }
.mesh-log {
  display: flex; flex-direction: column; gap: 4px;
  max-height: 160px; overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; line-height: 1.6; color: var(--mesh-muted);
}
.mesh-log-row { padding-bottom: 4px; border-bottom: 1px solid var(--mesh-line); word-break: break-word; }
.mesh-actions-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.mesh-divider { height: 1px; background: var(--mesh-line); margin: 14px 0; }

/* ── 主页（卡片工作台） ── */
.mesh-home { flex: 1; min-height: 0; overflow-y: auto; }
.mesh-home-inner { max-width: 1040px; margin: 0 auto; padding: 26px 30px 60px; }
.mesh-home-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.mesh-home-title { margin: 0; font-size: 24px; line-height: 1.2; font-weight: 600; letter-spacing: -0.02em; }
.mesh-home-sub { margin: 6px 0 0; font-size: 11.5px; color: var(--mesh-muted); line-height: 1.6; }
.mesh-home-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mesh-focus-toggle { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--mesh-muted); }
.mesh-focus-toggle.is-on { color: var(--mesh-accent); }
.mesh-home-edit-hint { margin: -4px 0 14px; font-size: 11px; color: var(--mesh-muted); line-height: 1.6; }
.mesh-home-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: stretch; }
.mesh-card {
  display: flex; flex-direction: column; gap: 10px;
  min-width: 0; min-height: 148px;
  padding: 15px 16px 14px;
  border: 1px solid var(--mesh-line); border-radius: 14px;
  background: var(--mesh-surface);
  animation: mesh-card-in var(--mesh-dur-base) var(--mesh-ease-out) backwards;
  transition: transform var(--mesh-dur-fast) var(--mesh-ease-out),
    box-shadow var(--mesh-dur-fast) var(--mesh-ease-out),
    border-color var(--mesh-dur-fast) ease;
}
.mesh-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 26px rgba(0,0,0,.07);
  border-color: var(--mesh-line-2);
}
.mesh-card:active { transform: translateY(0); }
.mesh-card.is-full { grid-column: 1 / -1; min-height: 168px; }
.mesh-card.is-editing { border-style: dashed; }
.mesh-card.is-editing .mesh-card-body { opacity: .72; pointer-events: none; }
.mesh-card-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mesh-card-logo {
  flex: 0 0 auto; width: 36px; height: 36px; border-radius: 10px;
  display: grid; place-items: center;
  color: var(--mesh-accent);
  background: color-mix(in srgb, var(--mesh-accent) 9%, transparent);
}
.mesh-card.is-full .mesh-card-logo { width: 42px; height: 42px; border-radius: 12px; }
.mesh-card-headtext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mesh-card-title { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
.mesh-card-sub { font-size: 10.5px; color: var(--mesh-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mesh-card-status { margin-left: auto; flex: 0 0 auto; }
.mesh-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.mesh-card-text { margin: 0; font-size: 11.5px; line-height: 1.65; color: var(--mesh-muted); }
.mesh-card-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.mesh-card-tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.mesh-card-tools .mesh-btn { color: var(--mesh-muted); }
.mesh-hero-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.mesh-hero-name { font-size: 22px; line-height: 1.2; font-weight: 600; letter-spacing: -0.02em; }
.mesh-hero-address { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--mesh-muted); }
.mesh-hero-stats { display: flex; flex-wrap: wrap; gap: 22px; margin-top: 14px; }
.mesh-hero-stat { display: flex; flex-direction: column; gap: 2px; min-width: 54px; }
.mesh-hero-stat-value { font-size: 17px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
.mesh-hero-stat-label { font-size: 10px; color: var(--mesh-muted); }
.mesh-mini-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: 1px solid var(--mesh-line); font-size: 11.5px; min-width: 0; }
.mesh-mini-row:first-child { border-top: 0; padding-top: 0; }
.mesh-mini-name { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mesh-mini-meta { flex: 0 0 auto; font-size: 10.5px; color: var(--mesh-muted); }
.mesh-home-hidden {
  margin-top: 18px; padding-top: 14px;
  border-top: 1px solid var(--mesh-line);
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.mesh-home-hidden-title { font-size: 10.5px; color: var(--mesh-muted); font-weight: 600; margin-right: 2px; }
.mesh-home-empty { margin-top: 16px; border: 1px dashed var(--mesh-line-2); border-radius: 14px; padding: 28px; text-align: center; }
.mesh-home-empty p { margin: 0 0 12px; font-size: 12px; color: var(--mesh-muted); }
.mesh-home .mesh-firstrun { margin: 0 0 16px; }

/* 主页底部的派发面板：视觉上跟卡片同级，但不参与拖动/隐藏。 */
.mesh-dispatch {
  margin-top: 16px;
  padding: 15px 16px 13px;
  border: 1px solid var(--mesh-line);
  border-radius: 14px;
  background: var(--mesh-surface);
  display: flex; flex-direction: column; gap: 11px;
  min-width: 0;
}
.mesh-dispatch-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mesh-dispatch-icon {
  flex: 0 0 auto; width: 32px; height: 32px; border-radius: 9px;
  display: grid; place-items: center;
  color: var(--mesh-accent);
  background: color-mix(in srgb, var(--mesh-accent) 9%, transparent);
}
.mesh-dispatch-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mesh-dispatch-name { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
.mesh-dispatch-sub { font-size: 10.5px; color: var(--mesh-muted); line-height: 1.5; }
.mesh-dispatch-status { flex: 0 0 auto; margin-left: auto; }
.mesh-dispatch-form { display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); gap: 12px; align-items: start; }
.mesh-dispatch-form .mesh-field { min-width: 0; }
.mesh-dispatch-text { min-height: 92px; }
.mesh-dispatch-msg { font-size: 11.5px; line-height: 1.6; }
.mesh-dispatch-msg.is-ok { color: var(--mesh-ok); }
.mesh-dispatch-msg.is-err { color: var(--mesh-err); }
.mesh-dispatch-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.mesh-dispatch-hint { font-size: 10.5px; color: var(--mesh-muted); line-height: 1.6; min-width: 0; }
.mesh-dispatch-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.mesh-home.is-dense .mesh-dispatch { padding: 11px 12px 10px; gap: 8px; border-radius: 12px; }
.mesh-home.is-dense .mesh-dispatch-text { min-height: 76px; }
.mesh-home.is-dense .mesh-home-grid { gap: 10px; }
.mesh-home.is-dense .mesh-card { padding: 11px 12px; gap: 7px; min-height: 0; border-radius: 12px; }
.mesh-home.is-dense .mesh-card-title { font-size: 12px; }
.mesh-home.is-dense .mesh-card-sub,
.mesh-home.is-dense .mesh-card-text,
.mesh-home.is-dense .mesh-mini-row { font-size: 10.5px; }
.mesh-home.is-dense .mesh-hero-name { font-size: 19px; }
.mesh-home.is-dense .mesh-hero-stats { gap: 14px; margin-top: 9px; }
.mesh-home.is-dense .mesh-hero-stat-value { font-size: 15px; }
.mesh-card { position: relative; }
.mesh-card.is-wide { grid-column: 1 / -1; }
.mesh-card.is-sized { min-height: 0; overflow: hidden; }
.mesh-card.is-sized .mesh-card-body { min-height: 0; overflow-y: auto; }
.mesh-card-head, .mesh-card-foot, .mesh-card-tools { flex: 0 0 auto; }
.mesh-card.is-dragging { opacity: .45; }
.mesh-card.is-drop-target { outline: 2px dashed var(--mesh-accent); outline-offset: 2px; }
.mesh-card.is-resizing { outline: 2px solid var(--mesh-accent); outline-offset: 2px; }
.mesh-card-drag { color: var(--mesh-muted); cursor: grab; display: inline-flex; margin-left: 2px; }
.mesh-card-drag:active { cursor: grabbing; }
.mesh-card-resize {
  position: absolute; right: 4px; bottom: 4px;
  width: 22px; height: 22px; display: grid; place-items: center;
  border-radius: 6px; color: var(--mesh-muted);
  cursor: nwse-resize; opacity: .6; touch-action: none;
}
.mesh-card-resize:hover { opacity: 1; background: var(--mesh-surface-2); color: var(--mesh-fg); }
.mesh-home.is-dense .mesh-card-resize { width: 18px; height: 18px; }
.mesh-home-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: -2px 0 14px; }
.mesh-home-density { display: inline-flex; align-items: center; gap: 7px; font-size: 10.5px; color: var(--mesh-muted); }
.mesh-drop-end {
  margin-top: 12px; padding: 10px; text-align: center;
  border: 1px dashed var(--mesh-line-2); border-radius: 10px;
  font-size: 11px; color: var(--mesh-muted);
}
.mesh-drop-end.is-over {
  border-color: var(--mesh-accent);
  color: var(--mesh-accent);
  background: color-mix(in srgb, var(--mesh-accent) 7%, transparent);
}
.mesh-icon-pick {
  width: 30px; height: 30px; border-radius: 8px;
  border: 1px solid var(--mesh-line-2); background: transparent;
  color: var(--mesh-muted); display: grid; place-items: center; cursor: pointer;
}
.mesh-icon-pick.is-on {
  border-color: var(--mesh-accent);
  color: var(--mesh-accent);
  background: color-mix(in srgb, var(--mesh-accent) 9%, transparent);
}
.mesh-editor-layer {
  position: fixed; inset: 0; z-index: 90;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; background: rgba(0,0,0,.32);
  animation: mesh-note-in 160ms var(--mesh-ease-out) both;
}
.mesh-editor {
  width: min(480px, 100%); max-height: 88vh; overflow-y: auto;
  padding: 20px;
  border: 1px solid var(--mesh-line); border-radius: 16px;
  background: var(--mesh-surface);
  box-shadow: 0 24px 70px rgba(0,0,0,.24);
  animation: mesh-detail-in 200ms var(--mesh-ease-out) both;
}
.mesh-editor h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
.mesh-editor > p { margin: 0 0 16px; font-size: 11.5px; color: var(--mesh-muted); }
.mesh-editor-error { margin: 8px 0; font-size: 11.5px; color: var(--mesh-err); }
.mesh-editor-foot { display: flex; align-items: center; gap: 8px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }
.mesh-card-text.is-pre { white-space: pre-wrap; }
.mesh-card-link { color: var(--mesh-accent); text-decoration: none; }
.mesh-card-link:hover { text-decoration: underline; }
.mesh-focus .mesh-dot.is-ok::after,
.mesh-focus .mesh-health .mesh-dot.is-ok::after,
.mesh-focus .mesh-detail-avatar .mesh-dot.is-ok::after,
.mesh-focus .mesh-detail-avatar::after,
.mesh-focus .mesh-empty-icon::after { animation: none !important; }
.mesh-focus .mesh-card:hover { transform: none; box-shadow: none; }

/* ── 空状态 / 加载 / 错误 ── */
.mesh-empty {
  height: 100%; min-height: 280px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 36px; text-align: center;
  animation: mesh-detail-in var(--mesh-dur-base) var(--mesh-ease-out) both;
}
.mesh-empty-icon {
  position: relative;
  width: 46px; height: 46px; border-radius: 13px;
  display: grid; place-items: center;
  background: var(--mesh-surface-2); color: var(--mesh-muted);
  margin-bottom: 12px;
}
.mesh-empty-icon::after {
  content: ""; position: absolute; inset: -6px;
  border: 1px solid var(--mesh-line-2); border-radius: 17px;
  pointer-events: none; opacity: .2;
  animation: mesh-ping 3.4s var(--mesh-ease-out) infinite;
}
.mesh-empty h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.mesh-empty p { margin: 0 0 14px; max-width: 330px; font-size: 11.5px; line-height: 1.65; color: var(--mesh-muted); }
.mesh-loading {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; color: var(--mesh-muted); font-size: 12px;
}
.mesh-spinner-lg {
  width: 22px; height: 22px; border-radius: 999px;
  border: 2px solid var(--mesh-line-2); border-top-color: var(--mesh-accent);
  animation: mesh-spin .8s linear infinite;
}
.mesh-error { flex: 1; display: flex; align-items: center; justify-content: center; padding: 32px; }
.mesh-error-card {
  width: 100%; max-width: 520px;
  padding: 24px; border: 1px solid var(--mesh-line); border-radius: 14px;
  background: var(--mesh-surface);
  animation: mesh-detail-in var(--mesh-dur-base) var(--mesh-ease-out) both;
}
.mesh-error-card h2 { margin: 12px 0 6px; font-size: 16px; font-weight: 600; }
.mesh-error-card p { margin: 0 0 12px; font-size: 12px; color: var(--mesh-muted); line-height: 1.6; }
.mesh-error-detail {
  margin: 0 0 14px; padding: 10px;
  background: var(--mesh-surface-2); border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px; line-height: 1.6;
  color: var(--mesh-muted); white-space: pre-wrap; word-break: break-word;
  max-height: 160px; overflow-y: auto;
}

/* ── 首次使用 ── */
.mesh-firstrun {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 10px;
  margin: 12px 16px 0; padding: 10px 12px;
  border: 1px solid var(--mesh-line); border-left: 2px solid var(--mesh-accent);
  border-radius: 9px; background: var(--mesh-surface);
  animation: mesh-banner-in var(--mesh-dur-base) var(--mesh-ease-out) both;
}
.mesh-firstrun-icon {
  flex: 0 0 auto; width: 28px; height: 28px; border-radius: 8px;
  display: grid; place-items: center;
  background: var(--mesh-surface-2); color: var(--mesh-accent);
}
.mesh-firstrun-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.mesh-firstrun-text strong { font-size: 12px; font-weight: 600; }
.mesh-firstrun-text span { font-size: 10.5px; color: var(--mesh-muted); }
.mesh-firstrun .mesh-input { flex: 0 1 220px; width: 220px; }

/* ── Toast ── */
.mesh-toasts {
  position: absolute; right: 18px; bottom: 18px; z-index: 60;
  width: min(344px, calc(100% - 36px));
  display: flex; flex-direction: column; gap: 8px;
}
.mesh-toast {
  position: relative; overflow: hidden;
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 11px;
  border: 1px solid var(--mesh-line-2); border-radius: 10px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 12px 34px rgba(0,0,0,.16);
  opacity: 0; transform: translateY(8px) scale(.98);
  transition: opacity 180ms var(--mesh-ease-out), transform 180ms var(--mesh-ease-out);
}
.mesh-toast.is-shown { opacity: 1; transform: none; }
.mesh-toast.is-leaving {
  opacity: 0; transform: translateY(6px) scale(.98);
  transition-duration: 140ms;
}
.mesh-toast-progress {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  background: var(--mesh-accent); opacity: .5;
  transform-origin: left;
  animation: mesh-toast-timer linear forwards;
}
.mesh-toast.is-error .mesh-toast-progress { background: var(--mesh-err); }
.mesh-toast.is-leaving .mesh-toast-progress { opacity: 0; }
.mesh-toast-icon { flex: 0 0 auto; margin-top: 1px; color: var(--mesh-muted); }
.mesh-toast.is-success .mesh-toast-icon { color: var(--mesh-ok); }
.mesh-toast.is-error .mesh-toast-icon { color: var(--mesh-err); }
.mesh-toast.is-warn .mesh-toast-icon { color: var(--mesh-warn); }
.mesh-toast-text { flex: 1; min-width: 0; font-size: 11.5px; line-height: 1.55; word-break: break-word; }
.mesh-toast-action {
  align-self: center; border: 0; background: transparent;
  color: var(--mesh-accent); font-size: 11px; font-weight: 600;
  padding: 0; cursor: pointer; white-space: nowrap;
}
.mesh-toast-close {
  flex: 0 0 auto; border: 0; background: transparent;
  color: var(--mesh-muted); padding: 0; cursor: pointer;
  display: grid; place-items: center;
}

/* ── 动效 ── */
@keyframes mesh-spin { to { transform: rotate(360deg); } }
@keyframes mesh-view-in { from { opacity: .72; transform: translateY(2px); } to { opacity: 1; transform: none; } }
@keyframes mesh-detail-in { from { opacity: .68; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes mesh-row-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes mesh-card-in { from { opacity: .7; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes mesh-banner-in { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: none; } }
@keyframes mesh-note-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
@keyframes mesh-value-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@keyframes mesh-bar-in { from { transform: scaleY(0); opacity: 0; } to { transform: scaleY(1); opacity: 1; } }
@keyframes mesh-dot-ping {
  0% { transform: scale(.8); opacity: .5; }
  70% { transform: scale(2.2); opacity: 0; }
  100% { opacity: 0; }
}
@keyframes mesh-halo {
  0%, 100% { opacity: .24; transform: scale(.98); }
  50% { opacity: .65; transform: scale(1.01); }
}
@keyframes mesh-ping {
  0% { transform: scale(.92); opacity: .5; }
  70% { transform: scale(1.14); opacity: 0; }
  100% { opacity: 0; }
}
@keyframes mesh-progress {
  from { transform: translateX(-110%); }
  to { transform: translateX(260%); }
}
@keyframes mesh-toast-timer {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}
@keyframes mesh-push-in {
  from { opacity: 0; transform: translateX(16px); }
  to { opacity: 1; transform: none; }
}
@keyframes mesh-push-back {
  from { opacity: 0; transform: translateX(-12px); }
  to { opacity: 1; transform: none; }
}

/* ── 窄屏：从“两栏”收成“一栏两层” ── */
/* ─────────────── 锚定传输 ─────────────── */
.mesh-btn--icon { position: relative; }
.mesh-icon-badge {
  position: absolute; top: -3px; right: -3px;
  min-width: 14px; height: 14px; padding: 0 4px;
  border-radius: 999px; background: var(--mesh-accent); color: var(--mesh-bg);
  font-size: 9px; line-height: 14px; text-align: center; font-weight: 700;
  box-shadow: 0 0 0 2px var(--mesh-bg);
}
.mesh-transfer-sheet { width: 540px; }
.mesh-transfer-log-sheet { width: 580px; }
.mesh-transfer-kind {
  display: inline-flex; align-items: center;
  padding: 1px 6px; border-radius: 4px;
  border: 1px solid var(--mesh-line); background: var(--mesh-surface);
  color: var(--mesh-muted); font-size: 9.5px; white-space: nowrap;
}
.mesh-transfer-anchor {
  padding: 10px 11px; margin-bottom: 14px;
  border-left: 2px solid var(--mesh-accent);
  border-radius: 0 8px 8px 0; background: var(--mesh-surface-2);
}
.mesh-transfer-text { font-size: 12px; line-height: 1.55; word-break: break-word; }
.mesh-transfer-sel {
  margin-top: 5px; color: var(--mesh-muted);
  font: 9.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mesh-transfer-targets { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.mesh-transfer-target {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 10px; border: 1px solid var(--mesh-line); border-radius: 9px;
  background: var(--mesh-bg); color: inherit; text-align: left; cursor: pointer;
  transition: border-color var(--mesh-dur-fast) ease, background var(--mesh-dur-fast) ease, box-shadow var(--mesh-dur-fast) ease;
}
.mesh-transfer-target:hover:not(:disabled) { background: var(--mesh-surface-2); }
.mesh-transfer-target.is-active {
  border-color: var(--mesh-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mesh-accent) 18%, transparent);
  background: var(--mesh-surface);
}
.mesh-transfer-target:disabled { opacity: .45; cursor: not-allowed; }
.mesh-transfer-target-main { font-size: 12px; font-weight: 600; }
.mesh-transfer-target-hint { margin-left: auto; color: var(--mesh-muted); font-size: 10px; }
.mesh-transfer-preview { margin-top: 12px; padding-top: 9px; border-top: 1px solid var(--mesh-line); }
.mesh-transfer-preview summary { cursor: pointer; color: var(--mesh-muted); font-size: 10.5px; }
.mesh-transfer-preview pre {
  margin: 8px 0 0; padding: 9px; max-height: 220px; overflow: auto;
  border-radius: 7px; background: var(--mesh-surface-2);
  font: 10px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word;
}
.mesh-transfer-log { display: flex; flex-direction: column; gap: 8px; }
.mesh-transfer-log-row {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 9px; border: 1px solid var(--mesh-line); border-radius: 9px;
  background: var(--mesh-bg);
}
.mesh-transfer-log-main { flex: 1; min-width: 0; }
.mesh-transfer-log-top { display: flex; align-items: baseline; gap: 8px; }
.mesh-transfer-log-top b { font-size: 12px; font-weight: 600; }
.mesh-transfer-log-time { color: var(--mesh-muted); font-size: 9.5px; }
.mesh-transfer-log-anchor {
  margin-top: 2px; color: var(--mesh-muted);
  font: 9.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mesh-transfer-log-intent { margin-top: 4px; font-size: 11.5px; line-height: 1.55; }
.mesh-transfer-log-error { margin-top: 3px; color: var(--mesh-err); font-size: 10.5px; }
.mesh-transfer-log-actions { display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }

@media (max-width: 900px) {
  .mesh-topbar { height: 52px; padding: 0 12px; gap: 10px; }
  .mesh-wordsub { display: none; }
  .mesh-tabs { margin-left: 0; }
  .mesh-tab { padding: 6px 8px; font-size: 11.5px; }
  .mesh-count { display: none; }
  .mesh-health-sub { display: none; }
  .mesh-split { display: block; }
  .mesh-list-pane { width: 100%; height: 100%; border-right: 0; }
  .mesh-detail-pane { height: 100%; }
  .mesh-split[data-pane="list"] .mesh-detail-pane { display: none; }
  .mesh-split[data-pane="detail"] .mesh-list-pane { display: none; }
  .mesh-split[data-pane="detail"] .mesh-detail-pane { animation: mesh-push-in var(--mesh-dur-base) var(--mesh-ease-out) both; }
  .mesh-split[data-pane="list"] .mesh-list-pane { animation: mesh-push-back var(--mesh-dur-fast) var(--mesh-ease-out) both; }
  .mesh-back { display: inline-flex; }
  .mesh-detail { padding: 18px 18px 44px; animation: none; }
  .mesh-detail-head { flex-wrap: wrap; }
  .mesh-detail-actions { width: 100%; margin: 10px 0 0; }
  .mesh-h1 { font-size: 21px; }
  .mesh-settings { padding: 22px 18px 48px; }
  .mesh-home-inner { padding: 20px 18px 48px; }
  .mesh-home-head { flex-wrap: wrap; }
  .mesh-home-actions { width: 100%; margin-left: 0; }
  .mesh-home-grid { grid-template-columns: 1fr; }
  .mesh-card.is-full { grid-column: auto; min-height: 0; }
  .mesh-card.is-wide { grid-column: auto; }
  .mesh-card { min-height: 0; }
  .mesh-card-sub { white-space: normal; }
  .mesh-set-body { padding-left: 0; }
  .mesh-set-sub { white-space: normal; }
  .mesh-firstrun { flex-wrap: wrap; }
  .mesh-firstrun .mesh-input { flex: 1 1 180px; width: auto; }
  .mesh-sheet { width: 100%; height: auto; max-height: 90%; align-self: flex-end; border-left: 0; border-top: 1px solid var(--mesh-line); border-radius: 16px 16px 0 0; transform: translateY(28px); }
  .mesh-sheet-layer.is-open .mesh-sheet { transform: none; animation: none; }
  .mesh-sheet-layer { align-items: flex-end; }
  .mesh-transfer-sheet, .mesh-transfer-log-sheet { width: 100%; }
  .mesh-transfer-log-actions { flex-direction: row; flex-wrap: wrap; }
  .mesh-toasts { right: 12px; bottom: 12px; }
  .mesh-banner { padding: 7px 12px; }
  .mesh-notice { margin: 8px 10px 0; }
}
@media (max-width: 640px) {
  .mesh-topbar {
    height: auto;
    flex-wrap: wrap;
    padding: 8px 12px;
    gap: 8px;
  }
  .mesh-brand { order: 1; }
  .mesh-topright { order: 2; }
  .mesh-tabs { order: 3; flex: 0 0 100%; width: 100%; }
  .mesh-tab { flex: 1 1 0; justify-content: center; padding: 7px 6px; }
  .mesh-health { font-size: 11px; }
  .mesh-editor-layer { padding: 0; align-items: flex-end; }
  .mesh-editor { width: 100%; max-height: 92vh; border-radius: 16px 16px 0 0; }
}

@media (max-width: 720px) {
  /* 窄屏上「发给」和「内容」上下排，否则两个输入框都挤得没法用。 */
  .mesh-dispatch-form { grid-template-columns: 1fr; }
  .mesh-dispatch-actions { margin-left: 0; width: 100%; justify-content: flex-end; }
}

/* ── 手机端：安全区 / 触控 / 键盘 ──
   只作用于窄屏或粗指针；桌面鼠标端不受影响。 */
@media (max-width: 767px) {
  .mesh-root {
    max-height: 100dvh;
    --mesh-safe-top: env(safe-area-inset-top, 0px);
    --mesh-safe-bottom: env(safe-area-inset-bottom, 0px);
    --mesh-safe-left: env(safe-area-inset-left, 0px);
    --mesh-safe-right: env(safe-area-inset-right, 0px);
  }
  .mesh-topbar {
    padding-top: calc(8px + var(--mesh-safe-top));
    padding-left: calc(12px + var(--mesh-safe-left));
    padding-right: calc(12px + var(--mesh-safe-right));
  }
  .mesh-detail,
  .mesh-home-inner,
  .mesh-settings {
    padding-left: calc(18px + var(--mesh-safe-left));
    padding-right: calc(18px + var(--mesh-safe-right));
    padding-bottom: calc(48px + var(--mesh-safe-bottom));
  }
  .mesh-banner,
  .mesh-notice { margin-left: calc(10px + var(--mesh-safe-left)); margin-right: calc(10px + var(--mesh-safe-right)); }
  .mesh-sheet {
    max-height: calc(100dvh - var(--mesh-safe-top) - 8px);
    padding-bottom: 0;
  }
  .mesh-sheet-head { padding-top: calc(20px + var(--mesh-safe-top)); }
  .mesh-sheet-body { padding-bottom: calc(18px + var(--mesh-safe-bottom)); }
  .mesh-sheet-foot { padding-bottom: calc(18px + var(--mesh-safe-bottom)); }
  .mesh-toasts { bottom: calc(12px + var(--mesh-safe-bottom)); }
  .mesh-list-pane,
  .mesh-detail-pane,
  .mesh-settings-scroll,
  .mesh-sheet-body { overscroll-behavior: contain; }
  .mesh-tabs {
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .mesh-tabs::-webkit-scrollbar { display: none; }
  .mesh-tab { flex: 0 0 auto; min-width: 58px; }
}

@media (pointer: coarse) {
  .mesh-tab,
  .mesh-btn,
  .mesh-icon-btn,
  .mesh-back,
  .mesh-text-btn,
  .mesh-fold-head,
  .mesh-row,
  .mesh-task-row {
    touch-action: manipulation;
  }
  .mesh-tab { min-height: 44px; }
  .mesh-btn,
  .mesh-btn--sm,
  .mesh-icon-btn,
  .mesh-icon-btn.mesh-btn--sm { min-height: 44px; }
  .mesh-icon-btn,
  .mesh-icon-btn.mesh-btn--sm { width: 44px; }
  .mesh-row,
  .mesh-task-row { min-height: 56px; }
  .mesh-back { min-height: 44px; }
  .mesh-input,
  .mesh-textarea { font-size: 16px; line-height: 1.5; }
  .mesh-textarea { resize: none; }
  .mesh-sheet { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .mesh-root *, .mesh-root *::before, .mesh-root *::after {
    animation-duration: 120ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 120ms !important;
  }
  .mesh-row, .mesh-task-row, .mesh-detail, .mesh-view, .mesh-sheet,
  .mesh-sheet-head, .mesh-sheet-body, .mesh-sheet-foot, .mesh-toast,
  .mesh-banner, .mesh-note, .mesh-notice, .mesh-empty, .mesh-value,
  .mesh-collapse-inner > *, .mesh-empty-icon::after, .mesh-detail-avatar::after {
    transform: none !important;
  }
  .mesh-progress-bar, .mesh-dot.is-ok::after, .mesh-empty-icon::after,
  .mesh-detail-avatar::after, .mesh-row.is-active::before,
  .mesh-task-row.is-active::before { animation: none !important; }
  .mesh-collapse { transition: none !important; }
  .mesh-toast-progress { animation: none !important; opacity: 0 !important; }
}
`;

    function installStyle() {
      if (typeof document === "undefined" || !document.head) return;
      const existing = document.getElementById("dsh-mesh-ui");
      if (existing) {
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      const el = document.createElement("style");
      el.id = "dsh-mesh-ui";
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    installStyle();

    // ─────────────────────── 数据 ───────────────────────

    function useMeshState(intervalMs) {
      const [state, setState] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [lastOk, setLastOk] = react.useState(0);
      const [loading, setLoading] = react.useState(true);
      const [refreshing, setRefreshing] = react.useState(false);
      const alive = react.useRef(true);

      const load = react.useCallback(async (silent) => {
        if (!silent) setLoading(true);
        try {
          const r = await fetch(`${API}/state`, {
            headers: { accept: "application/json" },
            cache: "no-store",
          });
          const j = await r.json();
          if (!alive.current) return;
          if (j && j.ok === false) {
            setError(String(j.error || "主机返回错误"));
          } else {
            setState(j);
            setError(null);
            setLastOk(Date.now());
          }
        } catch (e) {
          if (alive.current) setError(String((e && e.message) || e));
        } finally {
          if (alive.current) setLoading(false);
        }
      }, []);

      react.useEffect(() => {
        alive.current = true;
        load(false);
        const tick = () => {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          load(true);
        };
        const t = setInterval(tick, intervalMs || 3000);
        return () => {
          alive.current = false;
          clearInterval(t);
        };
      }, [load, intervalMs]);

      const reload = react.useCallback(async () => {
        setRefreshing(true);
        try {
          await load(true);
        } finally {
          if (alive.current) setRefreshing(false);
        }
      }, [load]);

      return { state, error, lastOk, loading, refreshing, reload };
    }

    function useNow(ms) {
      const [now, setNow] = react.useState(Date.now());
      react.useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), ms || 5000);
        return () => clearInterval(t);
      }, [ms]);
      return now;
    }

    function prefersReducedMotion() {
      try {
        return typeof window !== "undefined" && window.matchMedia
          ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
          : false;
      } catch {
        return false;
      }
    }

    /** Keep an element mounted long enough to play its exit transition. */
    function usePresence(open, ms) {
      const [mounted, setMounted] = react.useState(!!open);
      const [visible, setVisible] = react.useState(false);
      react.useEffect(() => {
        if (open) {
          setMounted(true);
          let raf2;
          const raf1 = requestAnimationFrame(() => {
            raf2 = requestAnimationFrame(() => setVisible(true));
          });
          return () => {
            cancelAnimationFrame(raf1);
            if (raf2) cancelAnimationFrame(raf2);
          };
        }
        setVisible(false);
        const timer = setTimeout(() => setMounted(false), ms || 240);
        return () => clearTimeout(timer);
      }, [open, ms]);
      return { mounted, visible };
    }

    function sanitizeCustomCards(raw) {
      if (!Array.isArray(raw)) return [];
      const types = new Set(CUSTOM_TYPES.map((t) => t.value));
      const out = [];
      for (const item of raw.slice(0, 8)) {
        if (!item || typeof item !== "object") continue;
        const id = typeof item.id === "string" && item.id.startsWith("custom-") ? item.id : "";
        if (!id || out.some((c) => c.id === id)) continue;
        const type = types.has(item.type) ? item.type : "note";
        const fallback = CUSTOM_TYPES.find((t) => t.value === type) || CUSTOM_TYPES[0];
        const icon = CUSTOM_ICONS.includes(item.icon) ? item.icon : fallback.icon;
        const title = String(item.title || "").trim().slice(0, 40) || fallback.label;
        let url = String(item.url || "").slice(0, 800);
        if (type === "link") {
          try {
            const parsed = new URL(url);
            if (!/^https?:$/.test(parsed.protocol)) url = "";
          } catch {
            url = "";
          }
        }
        out.push({
          id,
          custom: true,
          type,
          icon,
          title,
          text: String(item.text || "").slice(0, 1000),
          url,
          metric: HOME_METRICS.some((m) => m.value === item.metric) ? item.metric : "online",
          filter: ["all", "online", "in", "out"].includes(item.filter) ? item.filter : "all",
        });
      }
      return out;
    }

    function sanitizeSizes(raw, known) {
      const out = {};
      if (!raw || typeof raw !== "object") return out;
      for (const [id, value] of Object.entries(raw)) {
        if (!known.has(id) || !value || typeof value !== "object") continue;
        const h = Number(value.h);
        out[id] = {
          w: value.w === 2 ? 2 : 1,
          h: Number.isFinite(h) && h >= 140 && h <= 520 ? Math.round(h) : null,
        };
      }
      return out;
    }

    function readHomePrefs() {
      const fallback = {
        layout: DEFAULT_HOME.slice(),
        focus: false,
        sizes: {},
        customCards: [],
        density: "comfortable",
      };
      try {
        if (typeof localStorage === "undefined") return fallback;
        const raw = localStorage.getItem(HOME_PREF_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        const customCards = sanitizeCustomCards(parsed.customCards);
        const known = new Set([...HOME_IDS, ...customCards.map((c) => c.id)]);
        const layout = Array.isArray(parsed.layout)
          ? [...new Set(parsed.layout.filter((id) => known.has(id)))]
          : fallback.layout.slice();
        return {
          layout,
          focus: parsed.focus === true,
          sizes: sanitizeSizes(parsed.sizes, known),
          customCards,
          density: parsed.density === "compact" ? "compact" : "comfortable",
        };
      } catch {
        return fallback;
      }
    }

    function useHomePrefs() {
      const [prefs, setPrefs] = react.useState(readHomePrefs);
      react.useEffect(() => {
        try {
          if (typeof localStorage !== "undefined") localStorage.setItem(HOME_PREF_KEY, JSON.stringify(prefs));
        } catch {
          /* private mode or quota */
        }
      }, [prefs]);
      const setLayout = react.useCallback((next) => {
        setPrefs((p) => ({ ...p, layout: typeof next === "function" ? next(p.layout) : next }));
      }, []);
      const setFocus = react.useCallback((next) => {
        setPrefs((p) => ({ ...p, focus: !!next }));
      }, []);
      const setSize = react.useCallback((id, size) => {
        setPrefs((p) => {
          const sizes = { ...p.sizes };
          if (!size) {
            delete sizes[id];
          } else {
            const h = Number(size.h);
            sizes[id] = {
              w: size.w === 2 ? 2 : 1,
              h: Number.isFinite(h) && h >= 140 && h <= 520 ? Math.round(h) : null,
            };
          }
          return { ...p, sizes };
        });
      }, []);
      const setCustomCards = react.useCallback((next) => {
        setPrefs((p) => ({ ...p, customCards: typeof next === "function" ? next(p.customCards) : next }));
      }, []);
      const setDensity = react.useCallback((next) => {
        setPrefs((p) => ({ ...p, density: next === "compact" ? "compact" : "comfortable" }));
      }, []);
      const reset = react.useCallback(() => {
        setPrefs((p) => ({
          layout: DEFAULT_HOME.slice(),
          focus: false,
          sizes: {},
          density: "comfortable",
          customCards: p.customCards,
        }));
      }, []);
      return {
        layout: prefs.layout,
        focus: prefs.focus,
        sizes: prefs.sizes,
        customCards: prefs.customCards,
        density: prefs.density,
        setLayout,
        setFocus,
        setSize,
        setCustomCards,
        setDensity,
        reset,
      };
    }

    function useToasts() {
      const [items, setItems] = react.useState([]);
      const seq = react.useRef(0);
      const close = react.useCallback((id) => {
        setItems((xs) => xs.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
        setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 180);
      }, []);
      const push = react.useCallback((kind, text, action) => {
        const id = ++seq.current;
        const duration = kind === "error" ? 7000 : 4500;
        setItems((xs) => [...xs.slice(-3), { id, kind: kind || "info", text, action, duration, shown: false }]);
        const show = () => setItems((xs) => xs.map((t) => (t.id === id ? { ...t, shown: true } : t)));
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => requestAnimationFrame(show));
        } else {
          show();
        }
        setTimeout(() => close(id), duration);
      }, [close]);
      return { items, push, close };
    }

    // ─────────────────────── 图标 ───────────────────────

    function iconChildren(name) {
      switch (name) {
        case "mesh":
          return [
            h("circle", { key: "a", cx: 12, cy: 5, r: 2.2 }),
            h("circle", { key: "b", cx: 5.5, cy: 18.5, r: 2.2 }),
            h("circle", { key: "c", cx: 18.5, cy: 18.5, r: 2.2 }),
            h("path", { key: "d", d: "M12 7.2 6.4 16.3M12 7.2l5.6 9.1M7.7 18.5h8.6" }),
          ];
        case "device":
          return [
            h("rect", { key: "a", x: 3, y: 4, width: 18, height: 12, rx: 2 }),
            h("path", { key: "b", d: "M8 20h8M12 16v4" }),
          ];
        case "home":
          return [
            h("path", { key: "a", d: "M3 10.5 12 3l9 7.5" }),
            h("path", { key: "b", d: "M5 9.5V21h14V9.5" }),
            h("path", { key: "c", d: "M10 21v-6h4v6" }),
          ];
        case "tailscale":
          return [
            [7, 7], [12, 7], [17, 7],
            [7, 12], [12, 12], [17, 12],
            [7, 17], [12, 17], [17, 17],
          ].map(([cx, cy], i) =>
            h("circle", { key: `d${i}`, cx, cy, r: 1.5, fill: "currentColor", stroke: "none" }),
          );
        case "focus":
          return [
            h("path", { key: "a", d: "M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" }),
          ];
        case "edit":
          return [
            h("path", { key: "a", d: "M4 6h16M4 12h16M4 18h16" }),
            h("circle", { key: "b", cx: 9, cy: 6, r: 2 }),
            h("circle", { key: "c", cx: 15, cy: 12, r: 2 }),
            h("circle", { key: "d", cx: 8, cy: 18, r: 2 }),
          ];
        case "arrowUp":
          return [
            h("path", { key: "a", d: "M12 19V5" }),
            h("path", { key: "b", d: "m6 11 6-6 6 6" }),
          ];
        case "arrowDown":
          return [
            h("path", { key: "a", d: "M12 5v14" }),
            h("path", { key: "b", d: "m6 13 6 6 6-6" }),
          ];
        case "hide":
          return [
            h("path", { key: "a", d: "M3 3l18 18" }),
            h("path", { key: "b", d: "M10.6 10.6a2 2 0 0 0 2.8 2.8" }),
            h("path", { key: "c", d: "M9.9 5.2A10.4 10.4 0 0 1 12 5c5.5 0 9 7 9 7a17 17 0 0 1-2.2 3.1" }),
            h("path", { key: "d", d: "M6.6 6.7A17.6 17.6 0 0 0 3 12s3.5 7 9 7a10 10 0 0 0 3.4-.6" }),
          ];
        case "plus":
          return [
            h("path", { key: "a", d: "M12 5v14" }),
            h("path", { key: "b", d: "M5 12h14" }),
          ];
        case "note":
          return [
            h("path", { key: "a", d: "M6 3h9l4 4v14H6z" }),
            h("path", { key: "b", d: "M14 3v5h5" }),
            h("path", { key: "c", d: "M9 13h6M9 17h5" }),
          ];
        case "link":
          return [
            h("path", { key: "a", d: "M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.2-2.2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1" }),
            h("path", { key: "b", d: "M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.2 2.2a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1" }),
          ];
        case "activity":
          return [h("path", { key: "a", d: "M3 12h4l2.5-7 4 14 2.5-7h5" })];
        case "grip":
          return [9, 12, 15].flatMap((cy) =>
            [8, 16].map((cx) => h("circle", { key: `g${cx}-${cy}`, cx, cy, r: 1.35, fill: "currentColor", stroke: "none" })),
          );
        case "resize":
          return [
            h("path", { key: "a", d: "M15 21h6v-6" }),
            h("path", { key: "b", d: "M9 3H3v6" }),
            h("path", { key: "c", d: "M21 21 14 14M3 3l7 7" }),
          ];
        case "trash":
          return [
            h("path", { key: "a", d: "M4 7h16" }),
            h("path", { key: "b", d: "M9 7V4h6v3" }),
            h("path", { key: "c", d: "M7 7l1 14h8l1-14" }),
            h("path", { key: "d", d: "M10 11v6M14 11v6" }),
          ];
        case "tasks":
          return [
            h("path", { key: "a", d: "M8 6h12" }),
            h("path", { key: "b", d: "M4 6h.01" }),
            h("path", { key: "c", d: "M8 12h9" }),
            h("path", { key: "d", d: "M4 12h.01" }),
            h("path", { key: "e", d: "M8 18h12" }),
            h("path", { key: "f", d: "M4 18h.01" }),
          ];
        case "plug":
          return [
            h("path", { key: "a", d: "M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.2-2.2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1" }),
            h("path", { key: "b", d: "M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.2 2.2a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1" }),
          ];
        case "scan":
          // 局域网探测：中心一个点、两侧扩散的弧线（像雷达/无线电波）。
          // 原来那个「四角 + 一条横线」的取景框在 13px 下几乎就是个二维码，
          // 真机上第一眼容易误读，所以换成这个。
          return [
            h("path", { key: "a", d: "M4.9 19.1C1 15.2 1 8.8 4.9 4.9" }),
            h("path", { key: "b", d: "M7.8 16.2C5.5 13.9 5.5 10.1 7.8 7.8" }),
            h("path", { key: "c", d: "M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" }),
            h("path", { key: "d", d: "M19.1 4.9C23 8.8 23 15.1 19.1 19" }),
            h("circle", { key: "e", cx: 12, cy: 12, r: 2 }),
          ];
        case "probe":
          // 单台设备的能力探测：准星。与网段级别的「局域网探测」区分开。
          return [
            h("circle", { key: "a", cx: 12, cy: 12, r: 7.5 }),
            h("path", { key: "b", d: "M12 2v3.2M12 18.8V22M2 12h3.2M18.8 12H22" }),
            h("circle", { key: "c", cx: 12, cy: 12, r: 2.2 }),
          ];
        case "refresh":
          return [
            h("path", { key: "a", d: "M20 11a8 8 0 1 0-2.4 5.7" }),
            h("path", { key: "b", d: "M20 5v6h-6" }),
          ];
        case "send":
          return [
            h("path", { key: "a", d: "M22 2 11 13" }),
            h("path", { key: "b", d: "M22 2 15 22l-4-9-9-4 20-7z" }),
          ];
        case "chevron":
          return [h("path", { key: "a", d: "M9 6l6 6-6 6" })];
        case "close":
          return [
            h("path", { key: "a", d: "M6 6l12 12" }),
            h("path", { key: "b", d: "M18 6 6 18" }),
          ];
        case "copy":
          return [
            h("rect", { key: "a", x: 9, y: 9, width: 12, height: 12, rx: 2 }),
            h("path", { key: "b", d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }),
          ];
        case "check":
          return [h("path", { key: "a", d: "M20 6 9 17l-5-5" })];
        case "alert":
          return [
            h("path", { key: "a", d: "M12 9v4" }),
            h("path", { key: "b", d: "M12 17h.01" }),
            h("path", { key: "c", d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" }),
          ];
        case "arrowIn":
          return [
            h("path", { key: "a", d: "M12 3v12" }),
            h("path", { key: "b", d: "m7 10 5 5 5-5" }),
            h("path", { key: "c", d: "M5 21h14" }),
          ];
        case "arrowOut":
          return [
            h("path", { key: "a", d: "M12 21V9" }),
            h("path", { key: "b", d: "m7 14 5-5 5 5" }),
            h("path", { key: "c", d: "M5 3h14" }),
          ];
        case "globe":
          return [
            h("circle", { key: "a", cx: 12, cy: 12, r: 9 }),
            h("path", { key: "b", d: "M3 12h18" }),
            h("path", { key: "c", d: "M12 3a15 15 0 0 1 0 18" }),
            h("path", { key: "d", d: "M12 3a15 15 0 0 0 0 18" }),
          ];
        case "wifi":
          return [
            h("path", { key: "a", d: "M5 12.5a10 10 0 0 1 14 0" }),
            h("path", { key: "b", d: "M8.5 16a5 5 0 0 1 7 0" }),
            h("path", { key: "c", d: "M12 19h.01" }),
          ];
        case "key":
          return [
            h("circle", { key: "a", cx: 8, cy: 15, r: 4 }),
            h("path", { key: "b", d: "m10.8 12.2 9.2-9.2" }),
            h("path", { key: "c", d: "m16 7 3 3" }),
          ];
        case "terminal":
          return [
            h("rect", { key: "a", x: 3, y: 4, width: 18, height: 16, rx: 2 }),
            h("path", { key: "b", d: "m7 9 3 3-3 3" }),
            h("path", { key: "c", d: "M13 15h4" }),
          ];
        case "clock":
          return [
            h("circle", { key: "a", cx: 12, cy: 12, r: 9 }),
            h("path", { key: "b", d: "M12 7v5l3 2" }),
          ];
        case "chip":
          return [
            h("rect", { key: "a", x: 6, y: 6, width: 12, height: 12, rx: 2 }),
            h("path", { key: "b", d: "M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" }),
          ];
        case "spark":
          return [
            h("path", { key: "a", d: "M12 3v4M12 17v4M3 12h4M17 12h4" }),
            h("path", { key: "b", d: "m5.6 5.6 2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" }),
          ];
        default:
          return [h("circle", { key: "a", cx: 12, cy: 12, r: 8 })];
      }
    }

    function Icon({ name, size, stroke, className }) {
      return h(
        "svg",
        {
          className,
          width: size || 14,
          height: size || 14,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: stroke || 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        iconChildren(name),
      );
    }

    // ─────────────────────── 基础组件 ───────────────────────

    function Button({ variant, size, icon, loading, disabled, children, onClick, title }) {
      return h(
        "button",
        {
          type: "button",
          className: cls("mesh-btn", `mesh-btn--${variant || "secondary"}`, size === "sm" && "mesh-btn--sm"),
          disabled: disabled || loading,
          onClick,
          title,
          "aria-busy": loading || undefined,
        },
        loading ? h("span", { className: "mesh-spinner" }) : icon ? h(Icon, { name: icon, size: 14 }) : null,
        children ? h("span", null, children) : null,
      );
    }

    function IconButton({ icon, label, onClick, disabled, loading, active, badge }) {
      return h(
        "button",
        {
          type: "button",
          className: cls("mesh-btn", "mesh-btn--ghost", "mesh-btn--icon", active && "is-active"),
          onClick,
          disabled: disabled || loading,
          title: label,
          "aria-label": label,
          "aria-pressed": active === undefined ? undefined : !!active,
        },
        loading ? h("span", { className: "mesh-spinner" }) : h(Icon, { name: icon, size: 15 }),
        badge ? h("span", { className: "mesh-icon-badge" }, badge > 9 ? "9+" : String(badge)) : null,
      );
    }

    function Dot({ kind }) {
      return h("span", { className: cls("mesh-dot", `is-${kind || "idle"}`) });
    }

    function Status({ kind, children }) {
      return h("span", { className: "mesh-status" }, h(Dot, { kind }), h("span", null, children));
    }

    function Badge({ kind, children, title }) {
      return h("span", { className: cls("mesh-badge", `is-${kind || "muted"}`), title }, children);
    }

    function Segmented({ value, onChange, items, label }) {
      return h(
        "div",
        { className: "mesh-seg", role: "group", "aria-label": label },
        (items || []).map((it) =>
          h(
            "button",
            {
              key: it.value,
              type: "button",
              "aria-pressed": value === it.value,
              onClick: () => onChange(it.value),
            },
            it.label,
            it.count == null ? null : h("span", { className: "mesh-seg-count" }, it.count),
          ),
        ),
      );
    }

    function Switch({ checked, onChange, disabled, label }) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": !!checked,
        "aria-label": label,
        className: "mesh-switch",
        disabled,
        onClick: () => onChange(!checked),
      });
    }

    function Collapse({ open, children, className }) {
      return h(
        "div",
        {
          className: cls("mesh-collapse", open && "is-open", className),
          "aria-hidden": !open,
          inert: open ? undefined : "true",
        },
        h("div", { className: "mesh-collapse-inner" }, h("div", { className: "mesh-collapse-content" }, children)),
      );
    }

    function Fold({ title, children, defaultOpen, right, className }) {
      const [open, setOpen] = react.useState(!!defaultOpen);
      return h(
        "div",
        { className: cls("mesh-fold", className) },
        h(
          "button",
          {
            type: "button",
            className: "mesh-fold-head",
            "aria-expanded": open,
            onClick: () => setOpen((v) => !v),
          },
          h("span", { className: "mesh-fold-title" }, title),
          right ? h("span", { className: "mesh-fold-status" }, right) : null,
          h("span", { className: cls("mesh-fold-chevron", open && "is-open") }, h(Icon, { name: "chevron", size: 13 })),
        ),
        h(Collapse, { open }, h("div", { className: "mesh-fold-body" }, children)),
      );
    }

    function ConfirmButton({ label, confirmLabel, onConfirm, disabled, variant }) {
      const [armed, setArmed] = react.useState(false);
      react.useEffect(() => {
        if (!armed) return;
        const t = setTimeout(() => setArmed(false), 4000);
        return () => clearTimeout(t);
      }, [armed]);
      return h(
        Button,
        {
          variant: armed ? "danger" : variant || "ghost",
          size: "sm",
          disabled,
          onClick: () => {
            if (armed) {
              setArmed(false);
              onConfirm();
            } else {
              setArmed(true);
            }
          },
        },
        armed ? confirmLabel || "再点一次确认" : label,
      );
    }

    function Field({ label, hint, children }) {
      return h(
        "div",
        { className: "mesh-field" },
        label ? h("div", { className: "mesh-field-label" }, label) : null,
        children,
        hint ? h("div", { className: "mesh-field-hint" }, hint) : null,
      );
    }

    function Toasts({ items, onClose }) {
      return h(
        "div",
        { className: "mesh-toasts", "aria-live": "polite", "aria-atomic": "false" },
        (items || []).map((t) =>
          h(
            "div",
            { key: t.id, className: cls("mesh-toast", `is-${t.kind}`, t.shown && "is-shown", t.leaving && "is-leaving"), role: "status" },
            h("span", { className: "mesh-toast-icon" }, h(Icon, { name: t.kind === "error" ? "alert" : t.kind === "success" ? "check" : "clock", size: 14 })),
            h("span", { className: "mesh-toast-text" }, t.text),
            t.action
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "mesh-toast-action",
                    onClick: () => {
                      onClose(t.id);
                      t.action.onClick();
                    },
                  },
                  t.action.label,
                )
              : null,
            h(
              "button",
              { type: "button", className: "mesh-toast-close", onClick: () => onClose(t.id), "aria-label": "关闭提示" },
              h(Icon, { name: "close", size: 13 }),
            ),
            h("span", {
              className: "mesh-toast-progress",
              style: { animationDuration: `${t.duration || 4500}ms` },
            }),
          ),
        ),
      );
    }

    function Banner({ kind, title, detail, action }) {
      return h(
        "div",
        { className: cls("mesh-banner", kind === "error" && "is-error", kind === "warn" && "is-warn"), role: kind === "error" ? "alert" : "status" },
        h(Icon, { name: kind === "error" ? "alert" : "clock", size: 14 }),
        h(
          "div",
          { className: "mesh-banner-main" },
          h("span", { className: "mesh-banner-title" }, title),
          detail ? h("span", { className: "mesh-banner-detail" }, detail) : null,
        ),
        action ? h(Button, { variant: "ghost", size: "sm", onClick: action.onClick }, action.label) : null,
      );
    }

    function EmptyState({ icon, title, children, action }) {
      return h(
        "div",
        { className: "mesh-empty" },
        h("div", { className: "mesh-empty-icon" }, h(Icon, { name: icon || "device", size: 21 })),
        h("h3", null, title),
        children ? h("p", null, children) : null,
        action || null,
      );
    }

    function LoadingView() {
      return h("div", { className: "mesh-loading" }, h("span", { className: "mesh-spinner-lg" }), h("span", null, "正在读取 Mesh 状态…"));
    }

    function ErrorView({ error, onRetry, onCopy }) {
      return h(
        "div",
        { className: "mesh-error" },
        h(
          "div",
          { className: "mesh-error-card" },
          h(Icon, { name: "alert", size: 20 }),
          h("h2", null, "读不到 Mesh 状态"),
          h("p", null, "主机侧插件没有返回状态。确认 dsh-plugin-mesh 已经加载，然后重试。"),
          h("div", { className: "mesh-error-detail" }, String(error || "（没有错误信息）")),
          h(
            "div",
            { className: "mesh-actions-row" },
            h(Button, { variant: "primary", icon: "refresh", onClick: onRetry }, "重试"),
            h(Button, { variant: "ghost", icon: "copy", onClick: onCopy }, "复制错误"),
          ),
        ),
      );
    }

    // ─────────────────────── 能力 ───────────────────────

    function runtimeEntries(caps) {
      const raw = caps && caps.runtimes;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      return Object.entries(raw);
    }

    function CapabilityChips({ caps, peer }) {
      const [all, setAll] = react.useState(false);
      const runtimes = runtimeEntries(caps);
      const shown = all ? runtimes : runtimes.slice(0, 6);
      const specs = [];
      if (caps && caps.cpuCores) specs.push(`${caps.cpuCores} 核`);
      if (caps && caps.memMb) specs.push(`${Math.round(caps.memMb / 1024)} GB 内存`);
      if (caps && caps.arch) specs.push(String(caps.arch));

      return h(
        "div",
        {
          className: "mesh-caps",
          "data-mesh-view": "devices",
          "data-mesh-peer": (peer && peer.machine) || "",
          "data-mesh-instance": (peer && (peer.instanceId || peer.id)) || "",
        },
        h(
          "div",
          { className: "mesh-chips" },
          shown.map(([name, ver]) =>
            h(
              "span",
              {
                key: `rt-${name}`,
                className: "mesh-chip",
                "data-mesh-cap": name,
                "data-mesh-peer": (peer && peer.machine) || "",
                "data-mesh-instance": (peer && (peer.instanceId || peer.id)) || "",
              },
              h("span", { className: "mesh-chip-label" }, name),
              h("span", { className: "mesh-chip-mono" }, String(ver)),
            ),
          ),
          caps && caps.gpu && caps.gpu.name
            ? h(
                "span",
                {
                  className: "mesh-chip",
                  title: caps.gpu.vramMb ? `${caps.gpu.vramMb} MB 显存` : undefined,
                  "data-mesh-cap": "gpu",
                  "data-mesh-peer": (peer && peer.machine) || "",
                  "data-mesh-instance": (peer && (peer.instanceId || peer.id)) || "",
                },
                h(Icon, { name: "chip", size: 12 }),
                String(caps.gpu.name),
              )
            : null,
          !runtimes.length ? h("span", { className: "mesh-chip is-muted" }, "未探到运行时") : null,
        ),
        // WSL 发行版里的运行时单独一行：Windows 上的 Python 和 WSL 里的 Python
        // 是两个环境，混进同一排 chip 会让人以为"装过了"，从而把任务派到没有它的地方。
        wslSummary(caps)
          ? h(
              "div",
              { className: "mesh-chips", style: { marginTop: 6 } },
              h("span", { className: "mesh-chip is-muted" }, `WSL · ${wslSummary(caps)}`),
            )
          : null,
        runtimes.length > 6
          ? h(
              "button",
              { type: "button", className: "mesh-text-btn", onClick: () => setAll((v) => !v) },
              all ? "收起" : `展开全部 ${runtimes.length} 项`,
            )
          : null,
        specs.length ? h("div", { className: "mesh-specs" }, specs.join("  ·  ")) : null,
      );
    }

    function CapabilitySection({ peer, isSelf }) {
      const caps = peer && peer.capabilities;
      const stale = !!(peer && peer.capabilitiesStale);
      const incomplete = !!(caps && caps.runtimesIncomplete);

      return h(
        "section",
        { className: "mesh-section" },
        h(
          "div",
          { className: "mesh-section-head" },
          h("span", { className: "mesh-section-title" }, "能做什么"),
          h("span", { className: "mesh-section-note" }, caps ? (stale ? "数据可能已过期" : "对端上报") : "尚未上报"),
        ),
        caps
          ? h(CapabilityChips, { caps, peer })
          : h("p", { className: "mesh-p" }, isSelf ? "正在采集本机能力。" : "对端还没有上报能力名片。旧版本插件或刚启动时可能如此——这不代表它什么都跑不了。"),
        stale
          ? h(
              "div",
              { className: "mesh-note is-warn" },
              h(Icon, { name: "clock", size: 13 }),
              h("span", null, `能力名片采集于 ${caps && caps.capabilitiesAt ? ago(caps.capabilitiesAt, Date.now()) : "之前"}。如果对端中途装了新运行时，这里可能还没更新。`),
            )
          : null,
        incomplete
          ? h(
              "div",
              { className: "mesh-note is-warn" },
              h(Icon, { name: "alert", size: 13 }),
              h("span", null, "对端有探测项没探准（多半是当时机器忙、探测超时）。所以这里“没有某个运行时”不能当结论用。"),
            )
          : null,
        caps
          ? h(
              Fold,
              { title: "能力详情" },
              h(
                "dl",
                { className: "mesh-kv" },
                h("dt", null, "操作系统"),
                h("dd", null, caps.os || "未上报"),
                h("dt", null, "显卡"),
                h("dd", null, caps.gpu && caps.gpu.name ? `${caps.gpu.name}${caps.gpu.vramMb ? ` · ${caps.gpu.vramMb} MB` : ""}` : "未探到或没有独立显卡"),
                h("dt", null, "常用目录"),
                h("dd", null, Array.isArray(caps.workspaceHints) && caps.workspaceHints.length ? caps.workspaceHints.join("  ") : "未上报"),
                h("dt", null, "采集时间"),
                h("dd", null, caps.capabilitiesAt ? fmtDateTime(caps.capabilitiesAt) : "未知"),
              ),
            )
          : null,
      );
    }

    function ChannelSection({ peer, isSelf, now }) {
      const eps = peer && Array.isArray(peer.endpoints) ? peer.endpoints : [];
      const addresses = peer && Array.isArray(peer.addresses) ? peer.addresses : [];

      return h(
        "section",
        { className: "mesh-section" },
        h(
          "div",
          { className: "mesh-section-head" },
          h("span", { className: "mesh-section-title" }, isSelf ? "本机地址" : "连接"),
          h("span", { className: "mesh-section-note" }, isSelf ? `${addresses.length} 个网络地址` : "任意一条通即可派发"),
        ),
        isSelf
          ? h(
              "div",
              null,
              h(
                "div",
                { className: "mesh-channel" },
                h("span", { className: "mesh-channel-icon" }, h(Icon, { name: "wifi", size: 14 })),
                h(
                  "span",
                  { className: "mesh-channel-main" },
                  h("span", { className: "mesh-channel-title" }, "首选地址"),
                  h("span", { className: "mesh-channel-sub" }, shortAddress(peer.host, peer.port)),
                ),
              ),
              addresses.length
                ? h("div", { className: "mesh-specs", style: { marginTop: 8 } }, addresses.join("  ·  "))
                : null,
            )
          : eps.length === 0
            ? h("p", { className: "mesh-p" }, "对端还没有报告通道信息。等它下一次广播后会出现。")
            : eps.map((ep, i) => {
                const cooling = ep.downUntil && now < ep.downUntil;
                // 多 tailnet：通道 key 才是端点身份（lan / tsnet:<id>），
                // 只比 transport 会把"局域网在用"错标到每条 tailnet 上。
                const epKey = ep.channel || ep.transport || "";
                const active = !!(peer.online && (peer.channel || peer.transport) && epKey === (peer.channel || peer.transport));
                const state = active ? "在用" : cooling ? "冷却中" : ep.verified === false ? "未探测" : "备用";
                const kind = active ? "ok" : cooling ? "warn" : "idle";
                const channelTag =
                  ep.transport === "tsnet"
                    ? epKey.startsWith("tsnet:cand:")
                      ? "候选地址"
                      : epKey.startsWith("tsnet:")
                        ? epKey.slice("tsnet:".length)
                        : ""
                    : "";
                const label = ep.transport === "tsnet" ? (channelTag ? `互联网 · ${channelTag}` : "互联网") : "局域网";
                return h(
                  "div",
                  { key: `ep-${epKey}-${i}`, className: "mesh-channel" },
                  h("span", { className: "mesh-channel-icon" }, h(Icon, { name: ep.transport === "tsnet" ? "tailscale" : "wifi", size: 14 })),
                  h(
                    "span",
                    { className: "mesh-channel-main" },
                    h(
                      "span",
                      { className: "mesh-channel-title" },
                      label,
                      h(Badge, { kind }, state),
                    ),
                    h(
                      "span",
                      { className: "mesh-channel-sub" },
                      `${shortAddress(ep.host, ep.port)}${ep.rttMs ? `  ·  ${ep.rttMs}ms` : ""}  ·  成功 ${ep.okCount || 0} / 失败 ${ep.failCount || 0}`,
                    ),
                  ),
                );
              }),
      );
    }

    function IdentitySection({ peer, isSelf }) {
      const rows = [
        ["主机名", peer.hostname],
        ["系统用户", peer.user],
        ["DSH profile", peer.profile],
        ["MAC", peer.mac],
        ["设备 ID", peer.id],
        ["版本", peer.version],
      ].filter(([k, v]) => v && v !== "?" && !(isSelf && k === "设备 ID"));

      if (!rows.length) return null;

      return h(
        Fold,
        { title: "身份与诊断", className: "mesh-section" },
        h(
          "dl",
          { className: "mesh-kv" },
          rows.map(([k, v]) =>
            h(react.Fragment, { key: k },
              h("dt", null, k),
              h("dd", null, String(v)),
            ),
          ),
          isSelf ? h(react.Fragment, null, h("dt", null, "来源"), h("dd", null, "本机直接读取")) : null,
        ),
      );
    }

    // ─────────────────────── 设备 ───────────────────────

    function RecentTasks({ tasks, now, onOpenTask, onAll }) {
      if (!tasks || !tasks.length) return null;
      return h(
        "section",
        { className: "mesh-section" },
        h(
          "div",
          { className: "mesh-section-head" },
          h("span", { className: "mesh-section-title" }, "最近任务"),
          h("button", { type: "button", className: "mesh-text-btn", style: { marginLeft: "auto" }, onClick: onAll }, "查看全部"),
        ),
        tasks.map((t) => {
          const meta = taskMeta(t);
          return h(
            "button",
            { key: t.key, type: "button", className: "mesh-recent", onClick: () => onOpenTask(t.key) },
            h("span", { className: "mesh-recent-icon" }, h(Icon, { name: t.dir === "out" ? "arrowOut" : "arrowIn", size: 12 })),
            h(
              "span",
              { className: "mesh-recent-main" },
              h(
                "span",
                { className: "mesh-recent-top" },
                h("span", { className: cls("mesh-task-status", `is-${meta.kind}`) }, meta.label),
                h("span", { className: "mesh-recent-time" }, ago(t.at, now)),
              ),
              h("span", { className: "mesh-recent-preview" }, t.text.replace(/\s+/g, " ").trim().slice(0, 80) || "（空任务）"),
            ),
          );
        }),
      );
    }

    function DeviceRow({ peer, isSelf, active, onSelect, now, index }) {
      const online = !!peer.online || !!isSelf;
      const name = peer.machine || "未命名设备";
      return h(
        "button",
        {
          type: "button",
          className: cls("mesh-row", active && "is-active", !online && "is-offline"),
          onClick: () => onSelect(peer.id),
          "aria-label": `${name}，${online ? "在线" : "离线"}`,
          "data-mesh-view": "devices",
          "data-mesh-peer": peer.machine || "",
          "data-mesh-instance": peer.instanceId || peer.id || "",
          style: { animationDelay: `${Math.min(index || 0, 8) * 28}ms` },
        },
        h(
          "span",
          { className: "mesh-avatar" },
          initial(name),
          h(Dot, { kind: online ? "ok" : "idle" }),
        ),
        h(
          "span",
          { className: "mesh-row-main" },
          h("span", { className: "mesh-row-name" }, name, isSelf ? h(Badge, { kind: "accent" }, "本机") : null),
          h(
            "span",
            { className: "mesh-row-sub" },
            h("span", null, online ? "在线" : "离线"),
            h("span", { className: "mesh-dot-sep" }, "·"),
            h("span", null, osLabel(peer.os)),
            h("span", { className: "mesh-dot-sep" }, "·"),
            h("span", null, isSelf ? "现在" : ago(peer.lastSeen, now)),
          ),
        ),
        h("span", { className: "mesh-row-side" }, h(Icon, { name: "chevron", size: 13 })),
      );
    }

    function DeviceList({ selfPeer, peers, selectedId, onSelect, now, lastOk, onScan, scanning }) {
      return h(
        "aside",
        { className: "mesh-list-pane" },
        h(
          "div",
          { className: "mesh-pane-head" },
          // tab 已经叫「设备」了，这里只留台数，不再重复标题。
          h("span", { className: "mesh-pane-title" }, `${peers.length} 台设备`),
          h("span", { className: "mesh-pane-sub", title: `更新于 ${ago(lastOk, now)}` },
            h("span", { key: peers.length, className: "mesh-value" }, `更新于 ${ago(lastOk, now)}`),
          ),
        ),
        h(
          "div",
          { className: "mesh-list" },
          selfPeer
            ? h(
                react.Fragment,
                null,
                h("div", { className: "mesh-list-heading" }, "本机"),
                h(DeviceRow, { peer: selfPeer, isSelf: true, active: selectedId === "self", onSelect, now, index: 0 }),
              )
            : null,
          h("div", { className: "mesh-list-heading" }, "其他设备"),
          peers.length
            ? peers.map((p, i) => h(DeviceRow, { key: p.id, peer: p, active: selectedId === p.id, onSelect, now, index: i + 1 }))
            : h("div", { className: "mesh-list-empty" }, "还没有发现其他设备。点下面探测一次本网段。"),
          h(
            "div",
            { className: "mesh-list-actions" },
            peers.length === 0
              ? h(Button, { variant: "ghost", size: "sm", icon: "scan", loading: scanning, onClick: onScan }, "局域网探测")
              : null,
          ),
        ),
      );
    }

    function DeviceDetail({ peer, isSelf, onCompose, onProbe, probe, hostDown, now, onBack, onRename, onScan, recentTasks, onOpenTask, onAllTasks }) {
      const paneRef = react.useRef(null);
      react.useEffect(() => {
        const el = paneRef.current;
        if (!el || !el.scrollTo) return;
        el.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      }, [peer && peer.id]);

      if (!peer) {
        return h(
          "section",
          { className: "mesh-detail-pane", ref: paneRef },
          h(
            EmptyState,
            {
              icon: "device",
              title: "选择一台设备",
              action: onScan ? h(Button, { variant: "secondary", icon: "scan", onClick: onScan }, "局域网探测") : null,
            },
            "在左侧选一台设备，查看它的能力、连接方式，或直接派一个任务。",
          ),
        );
      }

      const online = !!peer.online || !!isSelf;
      const probeFor = probe && probe.id === peer.id ? probe : null;
      const address = peerAddress(peer);

      return h(
        "section",
        {
          className: "mesh-detail-pane",
          ref: paneRef,
          "data-mesh-view": "devices",
          "data-mesh-peer": peer.machine || "",
          "data-mesh-instance": peer.instanceId || peer.id || "",
        },
        h(
          "div",
          { className: "mesh-detail", key: peer.id },
          h(
            "button",
            { type: "button", className: "mesh-back", onClick: onBack },
            h(Icon, { name: "chevron", size: 13 }),
            "设备",
          ),
          h(
            "header",
            { className: "mesh-detail-head" },
            h("span", { className: "mesh-detail-avatar" }, initial(peer.machine), h(Dot, { kind: online ? "ok" : "idle" })),
            h(
              "div",
              { className: "mesh-detail-copy" },
              h("div", { className: "mesh-eyebrow" }, isSelf ? "本机" : "设备"),
              h("h1", { className: "mesh-h1" }, peer.machine || "未命名设备", isSelf ? h(Badge, { kind: "accent" }, "本机") : null),
              h(
                "div",
                { className: "mesh-meta" },
                h(Status, { kind: online ? "ok" : "idle" }, isSelf ? "运行中" : online ? "在线" : "离线"),
                h("span", null, osInfoLabel(peer)),
                h("span", { className: "mesh-address" }, address),
                isSelf ? null : h("span", null, `最后心跳 ${ago(peer.lastSeen, now)}`),
                peer.capabilitiesStale ? h(Badge, { kind: "warn" }, "能力可能过期") : null,
              ),
              // 同一台机器上的其它系统（WSL）。分开显示：Windows 上的 Python 和
              // WSL 里的 Python 是两个环境，混成一行会让 Placement 判断错。
              extraSystems(peer).length
                ? h(
                    "div",
                    { className: "mesh-meta" },
                    extraSystems(peer).map((sys) =>
                      h("span", { key: sys.key, className: "mesh-chip" }, h("span", { className: "mesh-chip-label" }, sys.text)),
                    ),
                  )
                : null,
            ),
            h(
              "div",
              { className: "mesh-detail-actions" },
              isSelf
                ? h(Button, { variant: "secondary", icon: "key", onClick: onRename }, "改名")
                : h(
                    react.Fragment,
                    null,
                    h(
                      Button,
                      { variant: "ghost", icon: "probe", onClick: () => onProbe(peer), loading: probeFor && probeFor.pending, disabled: hostDown },
                      "探测",
                    ),
                    h(
                      Button,
                      {
                        variant: "primary",
                        icon: "send",
                        onClick: () => onCompose(peer),
                        disabled: !online || hostDown,
                        title: !online ? "设备离线，无法派发" : hostDown ? "与主机失去联系" : "派发任务",
                      },
                      "发任务",
                    ),
                  ),
            ),
          ),
          !online
            ? h(
                "div",
                { className: "mesh-note" },
                h(Icon, { name: "clock", size: 13 }),
                h("span", null, `这台设备当前离线，最后心跳 ${ago(peer.lastSeen, now)}。能力信息可能已经不新鲜，派发会失败。`),
              )
            : null,
          probeFor
            ? h(
                "div",
                { className: cls("mesh-note", !probeFor.pending && (probeFor.reachable ? (probeFor.paired ? "" : "is-warn") : "is-err")) },
                probeFor.pending ? h("span", { className: "mesh-spinner" }) : h(Icon, { name: probeFor.reachable ? (probeFor.paired ? "check" : "alert") : "alert", size: 13 }),
                h(
                  "span",
                  null,
                  probeFor.pending
                    ? "正在探测…"
                    : probeFor.reachable
                      ? probeFor.paired
                        ? "可达，配对码一致。"
                        : "可达，但两端配对码不一致——派发会被拒绝。去「连接 → 配对码」对齐。"
                      : `不可达：${probeFor.error || "未知原因"}`,
                ),
              )
            : null,
          h(CapabilitySection, { peer, isSelf }),
          h(ChannelSection, { peer, isSelf, now }),
          h(RecentTasks, { tasks: recentTasks, now, onOpenTask, onAll: onAllTasks }),
          h(IdentitySection, { peer, isSelf }),
        ),
      );
    }

    function FirstRun({ self, onSave, onLater, busy }) {
      const [name, setName] = react.useState((self && (self.hostname || self.machine)) || "");
      return h(
        "div",
        { className: "mesh-firstrun" },
        h("span", { className: "mesh-firstrun-icon" }, h(Icon, { name: "spark", size: 15 })),
        h(
          "span",
          { className: "mesh-firstrun-text" },
          h("strong", null, "先给这台电脑起个名字"),
          h("span", null, "其他设备会用它来找到你。"),
        ),
        h("input", {
          className: "mesh-input",
          value: name,
          placeholder: "例如 livingroom-mac",
          onChange: (e) => setName(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && name.trim()) onSave(name);
          },
          "aria-label": "本机名字",
        }),
        h(Button, { variant: "primary", size: "sm", loading: busy, disabled: !name.trim(), onClick: () => onSave(name) }, "保存"),
        h(Button, { variant: "ghost", size: "sm", onClick: onLater }, "稍后"),
      );
    }

    function DeviceView(props) {
      const { selfPeer, peers, selectedPeer, selectedId, onSelect, mobilePane, onBack, onCompose, onProbe, probe, hostDown, now, lastOk, onScan, scanning, firstRun, onRename, recentTasks, onOpenTask, onAllTasks } = props;
      return h(
        react.Fragment,
        null,
        firstRun,
        h(
          "div",
          { className: "mesh-split", "data-pane": mobilePane },
          h(DeviceList, { selfPeer, peers, selectedId, onSelect, now, lastOk, onScan, scanning }),
          h(DeviceDetail, { peer: selectedPeer, isSelf: selectedId === "self", onCompose, onProbe, probe, hostDown, now, onBack, onRename, onScan, recentTasks, onOpenTask, onAllTasks }),
        ),
      );
    }

    // ─────────────────────── 派发 sheet ───────────────────────

    function Composer({ target: incomingTarget, onClose, onSent, hostDown, open }) {
      const [task, setTask] = react.useState("");
      const [thread, setThread] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [sent, setSent] = react.useState(false);
      const [error, setError] = react.useState("");
      const taRef = react.useRef(null);
      const lastTarget = react.useRef(null);
      const returnFocus = react.useRef(null);
      const { mounted, visible } = usePresence(open, 260);
      if (incomingTarget) lastTarget.current = incomingTarget;
      const target = incomingTarget || lastTarget.current;
      const targetId = incomingTarget && incomingTarget.id;

      react.useEffect(() => {
        if (!open) return;
        setTask("");
        setThread("");
        setError("");
        setSent(false);
        returnFocus.current = typeof document !== "undefined" ? document.activeElement : null;
        const t = setTimeout(() => {
          if (taRef.current) taRef.current.focus();
        }, 80);
        return () => {
          clearTimeout(t);
          const previous = returnFocus.current;
          if (previous && typeof previous.focus === "function") {
            try {
              previous.focus();
            } catch {
              /* the trigger may be gone */
            }
          }
        };
      }, [open, targetId]);

      react.useEffect(() => {
        if (!mounted) return;
        const onKey = (e) => {
          if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [mounted, onClose]);

      if (!mounted || !target) return null;

      const online = !!target.online;
      const canSend = !!task.trim() && online && !hostDown && !busy && !sent;

      const send = async () => {
        if (!canSend) return;
        setBusy(true);
        setError("");
        try {
          const r = await api("/send", { peer: target.machine, task, thread: thread.trim() });
          if (r && r.ok) {
            setSent(true);
            setTimeout(() => onSent(r), 360);
          } else {
            setError(`派发失败：${apiErr(r)}`);
          }
        } catch (e) {
          setError(`派发失败：${String((e && e.message) || e)}`);
        } finally {
          setBusy(false);
        }
      };

      return h(
        "div",
        {
          className: cls("mesh-sheet-layer", visible && "is-open"),
          "aria-hidden": !visible,
          onMouseDown: (e) => {
            if (e.target === e.currentTarget) onClose();
          },
        },
        h(
          "div",
          { className: "mesh-sheet", role: "dialog", "aria-modal": "true", "aria-label": "派发任务", inert: visible ? undefined : "true" },
          h(
            "div",
            { className: "mesh-sheet-head" },
            h("span", { className: "mesh-detail-avatar" }, initial(target.machine), h(Dot, { kind: online ? "ok" : "idle" })),
            h(
              "div",
              { className: "mesh-sheet-title" },
              h("div", { className: "mesh-sheet-eyebrow" }, "派发任务"),
              h("div", { className: "mesh-sheet-name" }, target.machine || "未命名设备"),
              h("div", { className: "mesh-meta" }, h(Status, { kind: online ? "ok" : "idle" }, online ? "在线" : "离线"), h("span", { className: "mesh-address" }, peerAddress(target))),
            ),
            h(IconButton, { icon: "close", label: "关闭", onClick: onClose }),
          ),
          h(
            "div",
            { className: "mesh-sheet-body" },
            h(
              "div",
              { className: "mesh-target" },
              h(Icon, { name: "send", size: 13 }),
              h("span", null, "发给 "),
              h("strong", null, target.machine || "?"),
              h("span", { style: { marginLeft: "auto" } }, online ? "对端会在自己的会话里执行" : "设备离线"),
            ),
            h(
              Field,
              { label: "要对方做什么？" },
              h("textarea", {
                ref: taRef,
                className: "mesh-textarea",
                value: task,
                readOnly: sent,
                placeholder: "例如：拉取最新代码，重新构建并重启 web 服务，然后把结果回报给我。",
                onChange: (e) => setTask(e.target.value),
                onKeyDown: (e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    send();
                  }
                },
                "aria-label": "任务内容",
              }),
            ),
            h(
              Fold,
              { title: "高级", right: "线程标识" },
              h(
                Field,
                { hint: "同一个线程标识会把多次派发串成一段对话。不填也可以。" },
                h("input", {
                  className: "mesh-input",
                  value: thread,
                  placeholder: "例如 build-web",
                  onChange: (e) => setThread(e.target.value),
                }),
              ),
            ),
            error ? h("div", { className: "mesh-sheet-error" }, error) : null,
            h("p", { className: "mesh-hint" }, "派发是异步的：这里成功只代表对端已接收，执行结果会由对端回派。⌘/Ctrl + Enter 发送。"),
          ),
          h(
            "div",
            { className: "mesh-sheet-foot" },
            h(
              "div",
              { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
              h(Button, { variant: "ghost", onClick: onClose }, "取消"),
              h(
                Button,
                {
                  variant: sent ? "secondary" : "primary",
                  icon: sent ? "check" : "send",
                  loading: busy,
                  disabled: !canSend,
                  onClick: send,
                },
                sent ? "已发送" : busy ? "派发中…" : "发送",
              ),
            ),
          ),
        ),
      );
    }

    // ─────────────────────── 锚定传输 UI ───────────────────────

    function TransferLayer({ active, state, onPick, onCancel }) {
      const stateRef = react.useRef(state);
      const pickRef = react.useRef(onPick);
      const cancelRef = react.useRef(onCancel);
      stateRef.current = state;
      pickRef.current = onPick;
      cancelRef.current = onCancel;

      react.useEffect(() => {
        if (!active) return undefined;
        const layer = document.createElement("div");
        layer.setAttribute("data-mesh-transfer-ui", "");
        layer.style.cssText = [
          "position:fixed", "inset:0", "z-index:2147482600", "pointer-events:none",
          "font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
        ].join(";");

        const box = document.createElement("div");
        box.style.cssText = [
          "position:fixed", "display:none", "pointer-events:none",
          "border:1.5px solid var(--mesh-accent,#4f6bff)", "border-radius:7px",
          "background:color-mix(in srgb, var(--mesh-accent,#4f6bff) 8%, transparent)",
          "box-shadow:0 0 0 3px color-mix(in srgb, var(--mesh-accent,#4f6bff) 16%, transparent)",
          "transition:left .04s linear,top .04s linear,width .04s linear,height .04s linear",
        ].join(";");

        const label = document.createElement("div");
        label.style.cssText = [
          "position:fixed", "display:none", "pointer-events:none", "max-width:70vw",
          "padding:4px 8px", "border-radius:5px", "background:#14181f", "color:#fff",
          "font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
          "white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis",
          "box-shadow:0 8px 22px rgba(0,0,0,.28)",
        ].join(";");

        const bar = document.createElement("div");
        bar.setAttribute("data-mesh-transfer-ui", "");
        bar.style.cssText = [
          "position:fixed", "top:14px", "left:50%", "transform:translateX(-50%)",
          "display:flex", "align-items:center", "gap:12px", "pointer-events:auto",
          "padding:9px 12px", "border-radius:10px",
          "background:rgba(20,24,31,.96)", "color:#fff",
          "box-shadow:0 12px 34px rgba(0,0,0,.3)", "border:1px solid rgba(255,255,255,.12)",
        ].join(";");
        const barText = document.createElement("span");
        barText.textContent = "锚定传输：点选设备 / 任务 / 能力 / 设置，把现场和一句意图发出去";
        barText.style.cssText = "font-size:12px;white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Esc 取消";
        cancel.style.cssText = [
          "pointer-events:auto", "border:1px solid rgba(255,255,255,.24)",
          "background:rgba(255,255,255,.08)", "color:#fff", "border-radius:6px",
          "padding:4px 8px", "cursor:pointer", "font-size:11px",
        ].join(";");
        bar.appendChild(barText);
        bar.appendChild(cancel);
        layer.appendChild(box);
        layer.appendChild(label);
        layer.appendChild(bar);
        document.body.appendChild(layer);

        const previousUserSelect = document.body.style.userSelect;
        const previousCursor = document.body.style.cursor;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "crosshair";
        let cleaned = false;

        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          document.body.style.userSelect = previousUserSelect;
          document.body.style.cursor = previousCursor;
          document.removeEventListener("mousemove", onMove, true);
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("keydown", onKey, true);
          layer.remove();
        };

        const hide = () => {
          box.style.display = "none";
          label.style.display = "none";
        };

        const onMove = (event) => {
          const el = document.elementFromPoint(event.clientX, event.clientY);
          if (!el || el === document.documentElement || el === document.body || el.closest?.("[data-mesh-transfer-ui], .mesh-sheet-layer")) {
            hide();
            return;
          }
          const anchor = deriveAnchor(el, stateRef.current);
          if (!anchor) {
            hide();
            return;
          }
          const r = el.getBoundingClientRect();
          box.style.display = "block";
          box.style.left = `${Math.max(0, r.left - 2)}px`;
          box.style.top = `${Math.max(0, r.top - 2)}px`;
          box.style.width = `${Math.max(0, r.width + 4)}px`;
          box.style.height = `${Math.max(0, r.height + 4)}px`;
          label.style.display = "block";
          label.textContent = anchorLabel(anchor);
          const top = r.top > 34 ? r.top - 30 : r.bottom + 8;
          label.style.left = `${Math.min(window.innerWidth - 120, Math.max(8, r.left))}px`;
          label.style.top = `${Math.max(5, top)}px`;
        };

        const onClick = (event) => {
          const el = document.elementFromPoint(event.clientX, event.clientY);
          if (!el || el === document.documentElement || el === document.body || el.closest?.("[data-mesh-transfer-ui], .mesh-sheet-layer")) return;
          const anchor = deriveAnchor(el, stateRef.current);
          if (!anchor) return;
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          const draft = { anchor, snapshot: snapshotFor(anchor, stateRef.current) };
          cleanup();
          pickRef.current?.(draft);
        };

        const onKey = (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cleanup();
            cancelRef.current?.();
          }
        };

        cancel.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          cleanup();
          cancelRef.current?.();
        });

        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("click", onClick, true);
        document.addEventListener("keydown", onKey, true);
        return cleanup;
      }, [active]);

      return null;
    }

    function TransferComposer({ draft, state, sessionId, onClose, onSend }) {
      const anchor = draft && draft.anchor;
      const snapshot = draft && draft.snapshot;
      const selfMachine = (state && state.self && state.self.machine) || "";
      const meshTarget = anchor && anchor.machine && anchor.machine !== selfMachine ? anchor.machine : "";
      const peerOnline = !snapshot || !snapshot.peer || snapshot.peer.online !== false;
      const targets = [
        { id: "agent", label: "当前会话", hint: sessionId ? "注入当前对话" : "没有当前会话", icon: "send", disabled: !sessionId },
        meshTarget ? { id: "mesh", label: meshTarget, hint: peerOnline ? "作为任务派发" : "对端离线", icon: "globe", disabled: !peerOnline } : null,
        { id: "clipboard", label: "剪贴板", hint: "复制 Markdown", icon: "copy", disabled: false },
      ].filter(Boolean);
      const defaultRoute = meshTarget && peerOnline ? "mesh" : sessionId ? "agent" : "clipboard";
      const initialRoute = draft && draft.route && targets.some((item) => item.id === draft.route && !item.disabled)
        ? draft.route
        : defaultRoute;
      const [route, setRoute] = react.useState(initialRoute);
      const [intent, setIntent] = react.useState((draft && draft.intent) || "");
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState("");
      const taRef = react.useRef(null);

      react.useEffect(() => {
        const timer = setTimeout(() => taRef.current && taRef.current.focus(), 80);
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => {
          clearTimeout(timer);
          document.removeEventListener("keydown", onKey);
        };
      }, [onClose]);

      if (!draft || !anchor) return null;

      const send = async () => {
        if (busy) return;
        const target = targets.find((item) => item.id === route);
        if (!target || target.disabled) return;
        setBusy(true);
        setError("");
        try {
          await onSend(route, intent.trim());
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      const previewRecord = {
        id: "预览",
        route,
        thread: "transfer:预览",
        anchor,
        snapshot,
        intent,
      };

      return h(
        "div",
        {
          className: "mesh-sheet-layer is-open",
          "data-mesh-transfer-ui": "",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          "div",
          { className: "mesh-sheet mesh-transfer-sheet", role: "dialog", "aria-modal": "true", "aria-label": "锚定传输" },
          h(
            "div",
            { className: "mesh-sheet-head" },
            h("span", { className: "mesh-detail-avatar" }, h(Icon, { name: "send", size: 17 })),
            h(
              "div",
              { className: "mesh-sheet-title" },
              h("div", { className: "mesh-sheet-eyebrow" }, "锚定传输"),
              h("div", { className: "mesh-sheet-name" }, anchorLabel(anchor)),
              h(
                "div",
                { className: "mesh-meta" },
                h("span", { className: "mesh-transfer-kind" }, anchorKindLabel(anchor)),
                anchor.view ? h("span", { className: "mesh-address" }, `view:${anchor.view}`) : null,
                snapshot && snapshot.peer ? h(Status, { kind: snapshot.peer.online ? "ok" : "idle" }, snapshot.peer.online ? "对端在线" : "对端离线") : null,
              ),
            ),
            h(IconButton, { icon: "close", label: "关闭", onClick: onClose }),
          ),
          h(
            "div",
            { className: "mesh-sheet-body" },
            h(
              "div",
              { className: "mesh-transfer-anchor" },
              h("span", { className: "mesh-transfer-kind" }, anchorKindLabel(anchor)),
              h("div", { className: "mesh-transfer-text" }, anchor.text || "（这个元素没有可见文字）"),
              anchor.selector ? h("div", { className: "mesh-transfer-sel" }, anchor.selector) : null,
            ),
            h(
              "div",
              { className: "mesh-transfer-targets" },
              h("div", { className: "mesh-field-label" }, "发到"),
              targets.map((item) =>
                h(
                  "button",
                  {
                    key: item.id,
                    type: "button",
                    className: cls("mesh-transfer-target", route === item.id && "is-active"),
                    disabled: item.disabled,
                    onClick: () => setRoute(item.id),
                    title: item.hint,
                  },
                  h(Icon, { name: item.icon, size: 14 }),
                  h("span", { className: "mesh-transfer-target-main" }, item.label),
                  h("span", { className: "mesh-transfer-target-hint" }, item.hint),
                ),
              ),
            ),
            h(
              Field,
              { label: "一句话意图（可选）", hint: "只写你要对方做什么；指到的对象和现场由锚点携带。" },
              h("textarea", {
                ref: taRef,
                className: "mesh-textarea",
                rows: 3,
                value: intent,
                placeholder: "例如：显存信息过期了，重新探一下；或：这个卡片间距不对，和上面那行对齐。",
                onChange: (event) => setIntent(event.target.value),
                onKeyDown: (event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    send();
                  }
                },
              }),
            ),
            h(
              "details",
              { className: "mesh-transfer-preview" },
              h("summary", null, "查看将发送的内容"),
              h("pre", null, transferPrompt(previewRecord)),
            ),
            error ? h("div", { className: "mesh-sheet-error" }, error) : null,
          ),
          h(
            "div",
            { className: "mesh-sheet-foot" },
            h(
              "div",
              { style: { display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" } },
              h("span", { className: "mesh-hint", style: { marginRight: "auto" } }, "⌘/Ctrl + Enter 发送"),
              h(Button, { variant: "ghost", onClick: onClose }, "取消"),
              h(Button, { variant: "primary", icon: "send", loading: busy, disabled: busy, onClick: send }, busy ? "发送中…" : "发送"),
            ),
          ),
        ),
      );
    }

    function TransferLog({ items, onClose, onRetry, onLocate, onCopy }) {
      return h(
        "div",
        {
          className: "mesh-sheet-layer is-open",
          "data-mesh-transfer-ui": "",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          "div",
          { className: "mesh-sheet mesh-transfer-log-sheet", role: "dialog", "aria-modal": "true", "aria-label": "传输记录" },
          h(
            "div",
            { className: "mesh-sheet-head" },
            h("span", { className: "mesh-detail-avatar" }, h(Icon, { name: "clock", size: 17 })),
            h(
              "div",
              { className: "mesh-sheet-title" },
              h("div", { className: "mesh-sheet-eyebrow" }, "传输记录"),
              h("div", { className: "mesh-sheet-name" }, `最近 ${items.length} 条`),
              h("div", { className: "mesh-meta" }, "只存在本机浏览器；重试会从原锚点重新生成同一份上下文。"),
            ),
            h(IconButton, { icon: "close", label: "关闭", onClick: onClose }),
          ),
          h(
            "div",
            { className: "mesh-sheet-body" },
            items.length === 0
              ? h(EmptyState, { icon: "send", title: "还没有传输记录" }, "在 Mesh 里点右上角的发送图标，指一个设备、任务、能力或设置，写下意图发出去。")
              : h(
                  "div",
                  { className: "mesh-transfer-log" },
                  items.map((item) => {
                    const status = transferStatusMeta(item.status);
                    const canRetry = item.status === "failed" || item.status === "sent";
                    return h(
                      "div",
                      { key: item.id, className: "mesh-transfer-log-row" },
                      h(Status, { kind: status.kind }, status.label),
                      h(
                        "div",
                        { className: "mesh-transfer-log-main" },
                        h(
                          "div",
                          { className: "mesh-transfer-log-top" },
                          h("b", null, transferRouteLabel(item.route, item)),
                          h("span", { className: "mesh-transfer-log-time" }, ago(item.at, Date.now())),
                        ),
                        h("div", { className: "mesh-transfer-log-anchor" }, anchorLabel(item.anchor)),
                        item.intent ? h("div", { className: "mesh-transfer-log-intent" }, item.intent) : null,
                        item.error ? h("div", { className: "mesh-transfer-log-error" }, item.error) : null,
                      ),
                      h(
                        "div",
                        { className: "mesh-transfer-log-actions" },
                        h(Button, { variant: "ghost", size: "sm", onClick: () => onLocate(item) }, "定位"),
                        canRetry ? h(Button, { variant: "ghost", size: "sm", onClick: () => onRetry(item) }, "重试") : null,
                        h(Button, { variant: "ghost", size: "sm", icon: "copy", onClick: () => onCopy(item) }, "复制"),
                      ),
                    );
                  }),
                ),
          ),
          h(
            "div",
            { className: "mesh-sheet-foot" },
            h(
              "div",
              { style: { display: "flex", justifyContent: "flex-end" } },
              h(Button, { variant: "secondary", onClick: onClose }, "关闭"),
            ),
          ),
        ),
      );
    }

    // ─────────────────────── 任务 ───────────────────────

    const TASK_STATUS = {
      delivered: ["已送达", "ok"],
      failed: ["派发失败", "err"],
      "pairing-mismatch": ["配对不一致", "err"],
      accepted: ["已接收", "ok"],
      throttled: ["已限速", "warn"],
      "noted-only": ["仅记录", "idle"],
      "stored-only": ["已存收件箱", "idle"],
      busy: ["忙碌 · 已排队", "warn"],
      "queued-for-session": ["已排队", "idle"],
      dispatched: ["已派发", "ok"],
      "queued-lost": ["排队丢失", "err"],
      "dispatch-failed": ["派发失败", "err"],
    };

    function taskList(state) {
      const inbound = (state && Array.isArray(state.inbound) ? state.inbound : []).map((t, i) => ({
        key: `in-${t.id}-${i}`,
        dir: "in",
        id: t.id,
        // 入站记录的 from 形如「机器名/用户」，而设备行的 machine 只有机器名 ——
        // 之前直接拿 from 当 peer 去和 machine 比较，永远不相等，于是「最近任务」
        // 永远是空的（真机反馈 #1）。优先用 fromMachine，回退时再去掉 /user 后缀。
        peer: t.fromMachine || String(t.from || "").split("/")[0] || "未知设备",
        at: tsOf(t.receivedAt),
        text: String(t.task || ""),
        thread: t.thread || "",
        status: t.status || "accepted",
        raw: t,
      }));
      const outbound = (state && Array.isArray(state.outbound) ? state.outbound : []).map((t, i) => ({
        key: `out-${t.id}-${i}`,
        dir: "out",
        id: t.id,
        peer: t.toMachine || "未知设备",
        at: tsOf(t.at),
        text: String(t.task || ""),
        thread: t.thread || "",
        status: t.ok ? "delivered" : t.status === 403 ? "pairing-mismatch" : "failed",
        raw: t,
      }));
      return [...inbound, ...outbound].sort((a, b) => b.at - a.at);
    }

    function taskMeta(task) {
      if (task.dir === "in" && task.status === "dispatched") return { label: "已交给本机", kind: "ok" };
      const m = TASK_STATUS[task.status] || [String(task.status || "未知"), "idle"];
      return { label: m[0], kind: m[1] };
    }

    function TaskRow({ task, active, onSelect, now, index }) {
      const meta = taskMeta(task);
      return h(
        "button",
        {
          type: "button",
          className: cls("mesh-task-row", active && "is-active"),
          onClick: () => onSelect(task.key),
          "data-mesh-view": "tasks",
          "data-mesh-task": task.key,
          "data-mesh-task-id": task.id,
          "data-mesh-thread": task.thread || "",
          "data-mesh-peer": (task.raw && (task.raw.toMachine || task.raw.fromMachine)) || "",
          style: { animationDelay: `${Math.min(index || 0, 8) * 28}ms` },
        },
        h("span", { className: "mesh-task-icon" }, h(Icon, { name: task.dir === "out" ? "arrowOut" : "arrowIn", size: 13 })),
        h(
          "span",
          { className: "mesh-task-main" },
          h(
            "span",
            { className: "mesh-task-top" },
            h("span", { className: "mesh-task-peer" }, task.dir === "out" ? `→ ${task.peer}` : `← ${task.peer}`),
            h("span", { className: "mesh-task-time" }, ago(task.at, now)),
          ),
          h(
            "span",
            { className: "mesh-task-top", style: { marginTop: 3 } },
            h("span", { className: cls("mesh-task-status", `is-${meta.kind}`) }, meta.label),
            h("span", { className: "mesh-task-preview" }, task.text.replace(/\s+/g, " ").trim().slice(0, 80) || "（空任务）"),
          ),
        ),
      );
    }

    function TaskDetail({ task, now, onCopy, onRetry, onBack }) {
      const paneRef = react.useRef(null);
      react.useEffect(() => {
        const el = paneRef.current;
        if (!el || !el.scrollTo) return;
        el.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      }, [task && task.key]);

      if (!task) {
        return h(
          "section",
          { className: "mesh-detail-pane", ref: paneRef },
          h(EmptyState, { icon: "tasks", title: "选择一条任务" }, "左侧是最近的收发记录。选一条查看全文、状态和失败原因。"),
        );
      }
      const meta = taskMeta(task);
      const raw = task.raw || {};
      const failed = task.dir === "out" && !raw.ok;
      return h(
        "section",
        {
          className: "mesh-detail-pane",
          ref: paneRef,
          "data-mesh-view": "tasks",
          "data-mesh-task": task.key,
          "data-mesh-task-id": task.id,
          "data-mesh-thread": task.thread || "",
          "data-mesh-peer": raw.toMachine || raw.fromMachine || "",
        },
        h(
          "div",
          { className: "mesh-detail", key: task.key },
          h("button", { type: "button", className: "mesh-back", onClick: onBack }, h(Icon, { name: "chevron", size: 13 }), "任务"),
          h(
            "header",
            { className: "mesh-detail-head" },
            h(
              "div",
              { className: "mesh-detail-copy" },
              h("div", { className: "mesh-eyebrow" }, task.dir === "out" ? "发出" : "收到"),
              h("h1", { className: "mesh-h1" }, task.dir === "out" ? `派给 ${task.peer}` : `来自 ${task.peer}`),
              h(
                "div",
                { className: "mesh-meta" },
                h(Badge, { kind: meta.kind }, meta.label),
                h("span", null, fmtDateTime(task.at)),
                task.thread ? h("span", { className: "mesh-address" }, task.thread) : null,
              ),
            ),
            h(
              "div",
              { className: "mesh-detail-actions" },
              h(Button, { variant: "ghost", icon: "copy", onClick: () => onCopy(task.text) }, "复制任务"),
              failed
                ? h(Button, { variant: "secondary", icon: "refresh", onClick: () => onRetry(task.peer) }, "重试")
                : null,
            ),
          ),
          h("div", { className: "mesh-task-text" }, task.text || "（空任务）"),
          failed && raw.error ? h("div", { className: "mesh-task-error" }, `失败原因：${raw.error}`) : null,
          h(
            "dl",
            { className: "mesh-kv" },
            h("dt", null, "任务 ID"),
            h("dd", null, String(task.id || "—")),
            h("dt", null, "方向"),
            h("dd", null, task.dir === "out" ? "本机发出" : "对端发来"),
            h("dt", null, "线程"),
            h("dd", null, task.thread || "未指定"),
            h("dt", null, "时间"),
            h("dd", null, `${fmtDateTime(task.at)}（${ago(task.at, now)}）`),
          ),
          h(
            Fold,
            { title: "技术信息" },
            h(
              "dl",
              { className: "mesh-kv" },
              h("dt", null, "状态码"),
              h("dd", null, String(task.status || "—")),
              task.dir === "out"
                ? h(react.Fragment, null, h("dt", null, "HTTP 状态"), h("dd", null, raw.status == null ? "—" : String(raw.status)))
                : h(react.Fragment, null,
                    h("dt", null, "来源地址"), h("dd", null, raw.sourceAddress || "—"),
                    h("dt", null, "通道"), h("dd", null, raw.transport === "tsnet" ? "互联网" : raw.transport === "lan" ? "局域网" : raw.transport || "—"),
                  ),
            ),
          ),
          h(
            Fold,
            { title: "路由与回信" },
            h(
              "dl",
              { className: "mesh-kv" },
              h("dt", null, "会话决策"),
              h("dd", null, raw.routeDecision || "—"),
              raw.dispatchError
                ? h(react.Fragment, null, h("dt", null, "派发错误"), h("dd", null, raw.dispatchError))
                : null,
              raw.replyTo
                ? h(
                    react.Fragment,
                    null,
                    h("dt", null, "回信地址"),
                    h("dd", null, `${raw.replyTo.machine || "?"}${raw.replyTo.thread ? ` · ${raw.replyTo.thread}` : ""}`),
                  )
                : null,
            ),
          ),
        ),
      );
    }

    function ThrottleNotice({ items, push, reload }) {
      const [open, setOpen] = react.useState(false);
      const [busy, setBusy] = react.useState("");
      if (!items || !items.length) return null;

      const run = async (thread, path) => {
        setBusy(thread);
        try {
          const r = await api(path, { thread });
          if (r && r.ok) {
            push("success", path.endsWith("raise") ? `已提高 ${thread} 的自动唤醒上限` : `已忽略 ${thread} 的限速提示`);
            await reload();
          } else {
            push("error", apiErr(r));
          }
        } catch (e) {
          push("error", String((e && e.message) || e));
        } finally {
          setBusy("");
        }
      };

      return h(
        "div",
        { className: "mesh-notice" },
        h(
          "div",
          { className: "mesh-notice-head" },
          h(Icon, { name: "alert", size: 14 }),
          h("span", { className: "mesh-notice-title" }, `${items.length} 个对话触发了自动唤醒上限`),
          h("span", { className: "mesh-notice-sub" }, "新任务仍会进入收件箱，但不会自动开跑。"),
          h(
            "button",
            { type: "button", className: "mesh-text-btn", style: { marginLeft: "auto" }, onClick: () => setOpen((v) => !v) },
            open ? "收起" : "查看",
          ),
        ),
        h(
          Collapse,
          { open },
          h(
            "div",
            { className: "mesh-notice-list" },
            items.map((it) =>
              h(
                "div",
                { key: it.thread, className: "mesh-notice-item" },
                h("span", { className: "mesh-notice-thread" }, it.thread),
                h("span", { className: "mesh-notice-meta" }, `已挡下 ${it.blocked || 0} 条 · 上限 ${it.cap || 0} 次 / ${Math.round((it.windowMs || 0) / 60000)} 分钟`),
                h(
                  Button,
                  { variant: "ghost", size: "sm", loading: busy === it.thread, onClick: () => run(it.thread, "/throttle/raise") },
                  "提高上限",
                ),
                h(
                  Button,
                  { variant: "ghost", size: "sm", disabled: busy === it.thread, onClick: () => run(it.thread, "/throttle/dismiss") },
                  "忽略",
                ),
              ),
            ),
          ),
        ),
      );
    }

    function TasksView({ state, filter, onFilter, selectedKey, onSelect, pane, onBack, onRetry, onCopy, push, reload, now, onGoDevices }) {
      const tasks = taskList(state);
      const filtered = filter === "all" ? tasks : tasks.filter((t) => t.dir === filter);
      const selected = filtered.find((t) => t.key === selectedKey) || null;

      return h(
        react.Fragment,
        null,
        h(ThrottleNotice, { items: state.throttled || [], push, reload }),
        h(
          "div",
          { className: "mesh-split", "data-pane": pane },
          h(
            "aside",
            { className: "mesh-list-pane" },
            h(
              "div",
              { className: "mesh-pane-head" },
              // tab 已经叫「任务」了，这里只留条数。
              h("span", { className: "mesh-pane-title" }, `${tasks.length} 条任务`),
              h(
                "span",
                { className: "mesh-pane-sub" },
                h("span", { key: tasks.length, className: "mesh-value" }, `收到 ${tasks.filter((t) => t.dir === "in").length} · 发出 ${tasks.filter((t) => t.dir === "out").length}`),
              ),
            ),
            h(
              "div",
              { className: "mesh-list-toolbar" },
              h(Segmented, {
                value: filter,
                onChange: onFilter,
                label: "任务筛选",
                items: [
                  { value: "all", label: "全部", count: tasks.length },
                  { value: "in", label: "收到", count: tasks.filter((t) => t.dir === "in").length },
                  { value: "out", label: "发出", count: tasks.filter((t) => t.dir === "out").length },
                ],
              }),
            ),
            h(
              "div",
              { className: "mesh-list" },
              filtered.length
                ? filtered.map((t, i) => h(TaskRow, { key: t.key, task: t, active: selectedKey === t.key, onSelect, now, index: i }))
                : h("div", { className: "mesh-list-empty" }, tasks.length ? "这个筛选下没有任务。" : "还没有任务。去「设备」里给某台机器派一个。"),
              tasks.length === 0
                ? h(
                    "div",
                    { className: "mesh-list-actions" },
                    h(Button, { variant: "ghost", size: "sm", icon: "send", onClick: onGoDevices }, "去派发任务"),
                  )
                : null,
            ),
          ),
          h(TaskDetail, { task: selected, now, onCopy, onRetry, onBack }),
        ),
      );
    }

    // ─────────────────────── 连接 / 设置 ───────────────────────

    function SettingsSection({ id, icon, title, subtitle, status, open, onToggle, children }) {
      return h(
        "section",
        {
          className: "mesh-set",
          "data-mesh-view": "connect",
          "data-mesh-setting": id,
        },
        h(
          "button",
          { type: "button", className: "mesh-set-head", "aria-expanded": open, onClick: onToggle },
          h("span", { className: "mesh-set-icon" }, h(Icon, { name: icon, size: 15 })),
          h(
            "span",
            { className: "mesh-set-copy" },
            h("span", { className: "mesh-set-title" }, title),
            subtitle ? h("span", { className: "mesh-set-sub" }, subtitle) : null,
          ),
          status ? h("span", { className: "mesh-set-status" }, status) : null,
          h("span", { className: cls("mesh-fold-chevron", open && "is-open") }, h(Icon, { name: "chevron", size: 14 })),
        ),
        h(Collapse, { open }, h("div", { className: "mesh-set-body" }, children)),
      );
    }

    function NameEditor({ self, onSave, busy, push }) {
      const [editing, setEditing] = react.useState(false);
      const [value, setValue] = react.useState((self && self.machine) || "");

      react.useEffect(() => {
        setValue((self && self.machine) || "");
      }, [self && self.machine]);

      if (self && self.machineSource === "config") {
        return h(
          "div",
          { className: "mesh-me" },
          h("span", { className: "mesh-me-name" }, self.machine || "?"),
          h("span", { className: "mesh-set-sub" }, "由插件配置 machineName 指定"),
        );
      }

      const save = async () => {
        const ok = await onSave(value);
        if (ok) setEditing(false);
      };

      return h(
        "div",
        null,
        h(
          "div",
          { className: "mesh-me" },
          h("span", { className: "mesh-me-name" }, (self && self.machine) || "未命名"),
          self && self.needsName ? h(Badge, { kind: "warn" }, "待命名") : null,
          h(
            "span",
            { className: "mesh-me-actions" },
            editing
              ? null
              : h(Button, { variant: "ghost", size: "sm", icon: "key", onClick: () => { setValue((self && self.machine) || ""); setEditing(true); } }, "改名"),
            h(
              Button,
              {
                variant: "ghost",
                size: "sm",
                icon: "copy",
                onClick: async () => {
                  const ok = await copyText((self && self.machine) || "");
                  push(ok ? "success" : "error", ok ? "已复制名字" : "复制失败，请手动选择");
                },
              },
              "复制名字",
            ),
          ),
        ),
        self && self.needsName ? h("p", { className: "mesh-hint" }, "第一次使用，建议起一个好记的名字。其他设备就是靠它找到你的。") : null,
        editing
          ? h(
              "div",
              { className: "mesh-inline-form", style: { marginTop: 4 } },
              h("input", {
                className: "mesh-input",
                value,
                autoFocus: true,
                placeholder: "例如 livingroom-mac",
                onChange: (e) => setValue(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter" && value.trim()) save();
                  if (e.key === "Escape") setEditing(false);
                },
                "aria-label": "本机名字",
              }),
              h(Button, { variant: "primary", size: "sm", loading: busy, disabled: !value.trim(), onClick: save }, "保存"),
              h(Button, { variant: "ghost", size: "sm", onClick: () => setEditing(false) }, "取消"),
            )
          : null,
      );
    }

    function PairingBody({ self, cfg, push, reload }) {
      const secret = (self && self.secret) || "";
      const required = !!(cfg && cfg.requirePairing);
      const pinned = !!(cfg && cfg.requirePairingPinned);
      const [confirming, setConfirming] = react.useState(false);
      const [reveal, setReveal] = react.useState(false);
      const [paste, setPaste] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [error, setError] = react.useState("");

      const copy = async () => {
        if (!secret) return push("error", "还没有生成配对码");
        const ok = await copyText(secret);
        push(ok ? "success" : "error", ok ? "本机配对码已复制" : "复制失败，请手动选择文本");
      };

      const enable = async () => {
        setBusy("enable");
        setError("");
        try {
          const r = await api("/pairing", { enabled: true });
          if (r && r.ok) {
            setConfirming(false);
            setReveal(false);
            push("success", "配对码已启用。把本机配对码粘贴到另一台机器的同一位置。");
            await reload();
          } else {
            setError(apiErr(r));
          }
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy("");
        }
      };

      const disable = async () => {
        setBusy("disable");
        setError("");
        try {
          const r = await api("/pairing", { enabled: false });
          if (r && r.ok) {
            push("success", "配对码已停用。同网设备发现即可派发。");
            await reload();
          } else {
            setError(apiErr(r));
          }
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy("");
        }
      };

      const saveSecret = async () => {
        if (paste.trim().length < 16) return;
        setBusy("secret");
        setError("");
        try {
          const r = await api("/secret", { secret: paste.trim() });
          if (r && r.ok) {
            setPaste("");
            push("success", "已保存对端配对码，正在重新广播。");
            await reload();
          } else {
            setError(apiErr(r));
          }
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy("");
        }
      };

      return h(
        "div",
        null,
        h(
          "p",
          { className: "mesh-p", style: { marginBottom: 12 } },
          required
            ? "已开启。两端必须使用同一个配对码，否则派发会被直接拒绝。"
            : "同一局域网默认无需配对：发现即可派发。若网络不完全可信（合租 / 公司 / 有访客设备），再开启。",
        ),
        pinned
          ? h("p", { className: "mesh-hint", style: { marginBottom: 10 } }, "由插件配置 requirePairing: true 固定开启，界面不能关闭。")
          : null,
        !required && !confirming
          ? h(
              "div",
              { className: "mesh-actions-row" },
              h(Button, { variant: "secondary", icon: "key", disabled: pinned, onClick: () => setConfirming(true) }, "启用配对码"),
            )
          : null,
        h(
          Collapse,
          { open: !required && confirming },
          h(
            "div",
            null,
            h("div", { className: "mesh-note is-warn" }, h(Icon, { name: "alert", size: 13 }), h("span", null, "开启后，这台机器会要求两端配对码一致。先把本机配对码复制到另一台机器，再点启用——否则对方会立刻派不进来。")),
            h(
              "div",
              { className: "mesh-code-row" },
              h("code", { className: "mesh-code" }, reveal ? secret || "尚未生成" : secret ? "••••••••••••••••" : "尚未生成"),
              h(Button, { variant: "ghost", size: "sm", onClick: () => setReveal((v) => !v) }, reveal ? "隐藏" : "显示"),
              h(Button, { variant: "ghost", size: "sm", icon: "copy", onClick: copy }, "复制"),
            ),
            h(
              "div",
              { className: "mesh-actions-row" },
              h(Button, { variant: "primary", size: "sm", loading: busy === "enable", onClick: enable }, "我已复制，启用配对码"),
              h(Button, { variant: "ghost", size: "sm", onClick: () => setConfirming(false) }, "取消"),
            ),
          ),
        ),
        h(
          Collapse,
          { open: required },
          h(
            "div",
            null,
            h(
              "div",
              { className: "mesh-code-row" },
              h("code", { className: "mesh-code" }, reveal ? secret || "尚未生成" : secret ? "••••••••••••••••" : "尚未生成"),
              h(Button, { variant: "ghost", size: "sm", onClick: () => setReveal((v) => !v) }, reveal ? "隐藏" : "显示"),
              h(Button, { variant: "ghost", size: "sm", icon: "copy", onClick: copy }, "复制"),
            ),
            h(
              "div",
              { className: "mesh-inline-form", style: { marginTop: 12 } },
              h("input", {
                className: "mesh-input",
                value: paste,
                placeholder: "把另一台机器的配对码粘贴到这里",
                onChange: (e) => setPaste(e.target.value),
                "aria-label": "对端配对码",
              }),
              h(Button, { variant: "secondary", size: "sm", loading: busy === "secret", disabled: paste.trim().length < 16, onClick: saveSecret }, "保存对端配对码"),
            ),
            h("p", { className: "mesh-hint" }, "两台都保存同一个码后，派发才会通过。开启/停用和保存都立即生效，不用重启。"),
            h(
              "div",
              { className: "mesh-actions-row" },
              h(Button, { variant: "ghost", size: "sm", disabled: pinned, loading: busy === "disable", onClick: disable }, "停用配对码"),
            ),
          ),
        ),
        error ? h("div", { className: "mesh-sheet-error" }, error) : null,
      );
    }

    /** 单条通道的阶段 → 文案/颜色。 */
    function channelPhase(ch) {
      const p = ch && ch.node && ch.node.phase ? ch.node.phase : ch && ch.enabled ? "idle" : "off";
      const map = {
        off: ["未启用", "idle"],
        idle: ["未连接", "idle"],
        starting: ["正在启动", "warn"],
        downloading: ["正在下载组件", "warn"],
        "needs-login": ["需要授权", "warn"],
        running: ["已连接", "ok"],
        exited: ["已停止", "idle"],
        error: ["出错", "err"],
      };
      const m = map[p] || [p, "idle"];
      return { phase: p, label: m[0], kind: m[1] };
    }

    /**
     * 汇总多条 tailnet 通道的状态。
     *
     * 多 tailnet 之后"连上没连上"不再是一个布尔值：3 条通道里连上 2 条，
     * 既要显示"已连接"，又要让用户看见还差一条。所以标签带分数。
     */
    function tsnetPhase(tsnet) {
      if (!tsnet) return { phase: "off", label: "未启用", kind: "idle", channels: [], running: 0 };
      const channels = Array.isArray(tsnet.channels) ? tsnet.channels.slice() : [];
      // 旧主机只有单节点字段：合成一个通道视图，界面逻辑不分叉
      if (channels.length === 0 && tsnet.node) {
        channels.push({
          id: "default",
          label: "Tailscale",
          enabled: tsnet.enabled === true,
          authKeySaved: tsnet.authKeySaved === true,
          controlUrl: tsnet.controlUrl || "",
          hostname: (tsnet.node && tsnet.node.hostname) || "",
          node: tsnet.node,
          recentEvents: tsnet.recentEvents || [],
        });
      }
      const phases = channels.map((c) => channelPhase(c).phase);
      const running = phases.filter((p) => p === "running").length;
      let phase = tsnet.enabled ? "idle" : "off";
      if (running > 0) phase = "running";
      else if (phases.includes("needs-login")) phase = "needs-login";
      else if (phases.includes("downloading")) phase = "downloading";
      else if (phases.includes("starting")) phase = "starting";
      else if (phases.includes("error")) phase = "error";
      else if (phases.includes("exited")) phase = "exited";
      else if (channels.length === 0) phase = tsnet.enabled ? "idle" : "off";
      const base = channelPhase({ enabled: tsnet.enabled, node: null });
      const map = {
        off: ["未启用", "idle"],
        idle: ["已启用 · 未启动", "idle"],
        starting: ["正在启动", "warn"],
        downloading: ["正在下载组件", "warn"],
        "needs-login": ["需要授权", "warn"],
        running: ["已连接", "ok"],
        exited: ["已停止", "idle"],
        error: ["出错", "err"],
      };
      const m = map[phase] || base;
      let label = m[0];
      if (phase === "running" && channels.length > 1) label = `已连接 ${running}/${channels.length} 条`;
      return { phase, label, kind: m[1], channels, running };
    }

    /** 通道列表的公共视图：旧主机没有 channels 时用旧字段兜底。 */
    function tsnetChannelsOf(tsnet) {
      const list = tsnet && Array.isArray(tsnet.channels) ? tsnet.channels.slice() : [];
      if (list.length > 0) return list;
      if (tsnet && tsnet.node) {
        return [
          {
            id: "default",
            label: "Tailscale",
            enabled: tsnet.enabled === true,
            authKeySaved: tsnet.authKeySaved === true,
            controlUrl: tsnet.controlUrl || "",
            hostname: (tsnet.node && tsnet.node.hostname) || "",
            node: tsnet.node,
            recentEvents: tsnet.recentEvents || [],
          },
        ];
      }
      return [];
    }

    /** 已连接通道的 tailnet 地址（供设置页/卡片显示一行摘要）。 */
    function tsnetAddressList(tsnet) {
      return tsnetChannelsOf(tsnet)
        .filter((c) => c.node && c.node.phase === "running")
        .map((c) => (c.node && c.node.selfIpv4) || "")
        .filter(Boolean);
    }

    function TsnetBody({ tsnet, push, reload }) {
      const [busy, setBusy] = react.useState("");
      const [error, setError] = react.useState("");
      const [draftLabel, setDraftLabel] = react.useState("");
      const [draftKey, setDraftKey] = react.useState("");
      const [draftControl, setDraftControl] = react.useState("");

      if (!tsnet) {
        return h("p", { className: "mesh-p" }, "当前主机版本还没有跨网络组网能力。升级插件后会出现在这里。");
      }

      const channels = tsnetChannelsOf(tsnet);
      const phase = tsnetPhase(tsnet);
      const running = phase.running;
      const events = (channels.find((c) => c.node && c.node.phase === "running")?.recentEvents || channels[0]?.recentEvents || tsnet.recentEvents || []).slice(-6);

      const run = async (path, body, okText) => {
        const tag = `${path}${body && body.id ? `:${body.id}` : ""}`;
        setBusy(tag);
        setError("");
        try {
          const r = await api(path, body || {});
          if (r && r.ok) {
            push("success", okText || "完成");
            await reload();
            return r;
          }
          setError(apiErr(r));
          return r;
        } catch (e) {
          setError(String((e && e.message) || e));
          return null;
        } finally {
          setBusy("");
        }
      };

      // 保存通道列表时只回传非敏感字段；授权码留空 = 保留原值（宿主按 id 合并）。
      const payloadOf = (list) =>
        list.map((c) => ({
          id: c.id,
          label: c.label,
          controlUrl: c.controlUrl || "",
          hostname: c.hostname || "",
          enabled: c.enabled !== false,
        }));

      const addChannel = async () => {
        if (!draftKey.trim()) {
          setError("先填入授权码。");
          return;
        }
        setBusy("add");
        setError("");
        try {
          const next = [
            ...payloadOf(channels),
            {
              label: draftLabel.trim() || `Tailnet ${channels.length + 1}`,
              authKey: draftKey.trim(),
              controlUrl: draftControl.trim(),
              enabled: true,
            },
          ];
          const saved = await api("/tsnet/config", { channels: next });
          if (!saved || !saved.ok) {
            setError(`保存失败：${apiErr(saved)}`);
            return;
          }
          const created = (saved.channels || []).find((c) => !channels.some((x) => x.id === c.id));
          if (created) {
            const started = await api("/tsnet/start", { id: created.id });
            if (started && started.ok) push("success", `通道「${created.label}」已开始连接。授权码只保存在本机。`);
            else push("error", `通道已保存，但启动失败：${apiErr(started)}`);
          }
          setDraftLabel("");
          setDraftKey("");
          setDraftControl("");
          await reload();
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy("");
        }
      };

      const removeChannel = async (ch) => {
        const next = payloadOf(channels.filter((c) => c.id !== ch.id));
        // 最后一条也允许删：宿主会顺带清掉旧版单通道字段并关闭组网，
        // 否则"删不掉、也关不干净"会变成又一处静默残留。
        await run(
          "/tsnet/config",
          { channels: next },
          next.length === 0 ? "所有通道已删除，跨网络组网已关闭" : `通道「${ch.label || ch.id}」已删除`,
        );
      };

      const updateEnabled = async (ch, enabled) => {
        const next = payloadOf(channels).map((c) => (c.id === ch.id ? { ...c, enabled } : c));
        await run("/tsnet/config", { channels: next }, enabled ? "通道已启用" : "通道已停用");
      };

      return h(
        "div",
        null,
        h(
          "p",
          { className: "mesh-p", style: { marginBottom: 12 } },
          "让不在同一网络的电脑也能互相派发任务。使用同一套设备列表，不需要另装 Tailscale 客户端。一台机器可以同时加入多个 tailnet：设备身份仍然只有一个，每条通道只是它的一条路。",
        ),
        channels.length === 0
          ? h(
              "div",
              { className: "mesh-note" },
              h(Icon, { name: "key", size: 13 }),
              h("span", null,
                "还没有配置 tailnet 通道。需要一个 Tailscale 授权码：打开 ",
                h("a", { href: TS_KEYS_URL, target: "_blank", rel: "noreferrer" }, TS_KEYS_URL),
                " 登录后点 Generate auth key；生成时勾选 Reusable，如果后台开了设备审批再勾 Pre-approved。",
              ),
            )
          : null,
        channels.map((ch) => {
          const cp = channelPhase(ch);
          const node = ch.node || null;
          const isBusy = !!busy;
          return h(
            "div",
            { key: ch.id, className: "mesh-channel-card", style: { marginBottom: 10 } },
            h(
              "div",
              { className: "mesh-channel" },
              h("span", { className: "mesh-channel-icon" }, h(Icon, { name: "tailscale", size: 14 })),
              h(
                "span",
                { className: "mesh-channel-main" },
                h(
                  "span",
                  { className: "mesh-channel-title" },
                  ch.label || "Tailscale",
                  h(Badge, { kind: cp.kind }, cp.label),
                  ch.id !== "default" ? h("span", { className: "mesh-channel-sub", style: { marginLeft: 6 } }, ch.id) : null,
                ),
                h(
                  "span",
                  { className: "mesh-channel-sub" },
                  node && node.selfIpv4
                    ? [node.selfIpv4, node.selfDnsName].filter(Boolean).join("  ·  ")
                    : ch.authKeySaved
                      ? `已保存授权码${ch.controlUrl ? ` · ${ch.controlUrl}` : " · 官方 Tailscale"}`
                      : "未设置授权码",
                ),
              ),
              cp.phase === "running"
                ? h(
                    Button,
                    {
                      variant: "ghost",
                      size: "sm",
                      loading: busy === `/tsnet/stop:${ch.id}`,
                      disabled: isBusy && busy !== `/tsnet/stop:${ch.id}`,
                      onClick: () => run("/tsnet/stop", { id: ch.id }, `通道「${ch.label || ch.id}」已断开`),
                    },
                    "断开",
                  )
                : h(
                    Button,
                    {
                      variant: "ghost",
                      size: "sm",
                      loading: busy === `/tsnet/start:${ch.id}`,
                      disabled: isBusy && busy !== `/tsnet/start:${ch.id}`,
                      onClick: () => run("/tsnet/start", { id: ch.id }, `通道「${ch.label || ch.id}」已启动`),
                    },
                    "连接",
                  ),
            ),
            node && node.authUrl
              ? h(
                  "div",
                  { className: "mesh-note is-warn" },
                  h(Icon, { name: "alert", size: 13 }),
                  h("span", null,
                    "这条通道需要你授权加入 tailnet：",
                    h("a", { href: node.authUrl, target: "_blank", rel: "noreferrer", style: { marginLeft: 4, wordBreak: "break-all" } }, "打开授权页"),
                  ),
                )
              : null,
            node && node.error
              ? h(
                  "div",
                  { className: "mesh-note is-err" },
                  h(Icon, { name: "alert", size: 13 }),
                  h("span", null, String(node.error)),
                )
              : null,
            cp.phase === "downloading"
              ? h(
                  "div",
                  { className: "mesh-note" },
                  h("span", { className: "mesh-spinner" }),
                  h("span", null, `正在下载组件${node && node.downloadPercent ? ` · ${node.downloadPercent}%` : ""}。第一次使用会稍慢，之后不再下载。`),
                )
              : null,
            h(
              Fold,
              { title: "通道设置", right: ch.controlUrl ? "自定义控制服务器" : "官方 Tailscale" },
              h(
                "dl",
                { className: "mesh-kv" },
                h("dt", null, "通道 id"), h("dd", null, ch.id),
                h("dt", null, "节点名"), h("dd", null, (node && node.hostname) || ch.hostname || "—"),
                h("dt", null, "控制服务器"), h("dd", null, ch.controlUrl || "官方"),
                h("dt", null, "授权码"), h("dd", null, ch.authKeySaved ? "已保存（不会显示内容）" : "未设置"),
              ),
              h(
                "div",
                { className: "mesh-actions-row" },
                h(Button, { variant: "ghost", size: "sm", disabled: !!busy || cp.phase !== "running", loading: busy === `/tsnet/scan:${ch.id}`, onClick: () => run("/tsnet/scan", { id: ch.id }, "已扫描该通道") }, "扫描该通道"),
                h(ConfirmButton, {
                  label: "重新登录",
                  confirmLabel: "确认清除身份？",
                  disabled: !!busy || !ch.authKeySaved,
                  onConfirm: () => run("/tsnet/relogin", { id: ch.id }, "已清除节点身份，等待重新授权"),
                }),
                h(ConfirmButton, {
                  label: "删除通道",
                  confirmLabel: "确认删除？",
                  disabled: !!busy,
                  onConfirm: () => removeChannel(ch),
                }),
              ),
            ),
          );
        }),
        h(
          Fold,
          { title: channels.length ? "添加通道" : "配置第一条通道", right: "多 tailnet", defaultOpen: channels.length === 0 },
          h(
            "div",
            null,
            h(
              "div",
              { className: "mesh-note" },
              h(Icon, { name: "key", size: 13 }),
              h("span", null,
                "每条通道对应一个 tailnet（一把 tskey 一把钥匙，但可以加多条）。名称只用于本机显示；重命名不影响设备身份。",
              ),
            ),
            h(
              Field,
              { label: "名称（可选）", hint: "例如「个人」「公司」；留空自动命名。" },
              h("input", {
                className: "mesh-input",
                value: draftLabel,
                placeholder: "公司 tailnet",
                onChange: (e) => setDraftLabel(e.target.value),
              }),
            ),
            h(
              Field,
              { label: "授权码", hint: "只保存在本机；粘贴新值会新增一条通道。" },
              h("input", {
                className: "mesh-input",
                type: "password",
                autoComplete: "off",
                value: draftKey,
                placeholder: "tskey-auth-…",
                onChange: (e) => setDraftKey(e.target.value),
              }),
            ),
            h(
              Field,
              { label: "控制服务器（可选）", hint: "留空用官方 Tailscale；Headscale 用户填自己的地址。" },
              h("input", {
                className: "mesh-input",
                value: draftControl,
                placeholder: "https://controlplane.tailscale.com",
                onChange: (e) => setDraftControl(e.target.value),
              }),
            ),
            h(
              "div",
              { className: "mesh-actions-row" },
              h(
                Button,
                { variant: "primary", icon: "plug", loading: busy === "add", disabled: !!busy || !draftKey.trim(), onClick: addChannel },
                "添加并连接",
              ),
            ),
          ),
        ),
        h(
          Fold,
          { title: "维护", right: running ? "扫描与组件" : undefined },
          h(
            "div",
            { className: "mesh-actions-row" },
            h(Button, { variant: "ghost", size: "sm", disabled: !!busy || running === 0, loading: busy === "/tsnet/scan", onClick: () => run("/tsnet/scan", {}, "已扫描所有通道") }, "扫描所有通道"),
            h(ConfirmButton, {
              label: "重新下载组件",
              confirmLabel: "确认重新下载？",
              disabled: !!busy,
              onConfirm: () => run("/tsnet/reinstall", {}, "已重新下载组件"),
            }),
          ),
          events.length
            ? h(
                "div",
                { className: "mesh-log", style: { marginTop: 12 } },
                events.map((ev, i) =>
                  h("div", { key: i, className: "mesh-log-row" }, `${fmtTime(ev.at)}  ${ev.event}${ev.message ? `  ${ev.message}` : ""}`),
                ),
              )
            : null,
        ),
        error ? h("div", { className: "mesh-sheet-error" }, error) : null,
      );
    }

    function Diagnostics({ state, push }) {
      const self = (state && state.self) || {};
      const cfg = (state && state.config) || {};
      const peers = state && Array.isArray(state.peers) ? state.peers : [];
      const copyAll = async () => {
        const ok = await copyText(buildDiagnostics(state));
        push(ok ? "success" : "error", ok ? "诊断信息已复制" : "复制失败，请手动选择");
      };
      return h(
        "div",
        null,
        h(
          "dl",
          { className: "mesh-kv" },
          h("dt", null, "发现方式"), h("dd", null, cfg.useMulticast === false ? "主动扫描" : "组播 + 扫描"),
          h("dt", null, "扫描间隔"), h("dd", null, cfg.scanIntervalMs ? `${Math.round(cfg.scanIntervalMs / 1000)} 秒` : "关闭"),
          h("dt", null, "保活"), h("dd", null, cfg.pingIntervalMs ? `每 ${Math.round(cfg.pingIntervalMs / 1000)} 秒` : "关闭"),
          h("dt", null, "端口"), h("dd", null, String(self.port || "—")),
          h("dt", null, "主机名"), h("dd", null, self.hostname || "—"),
          h("dt", null, "MAC"), h("dd", null, self.mac || "—"),
          h("dt", null, "版本（进程）"), h("dd", null, self.version || "—"),
          // 进程版本 ≠ 磁盘版本 = 升级了没重启。光看一个版本号永远发现不了，
          // 于是用户会拿旧行为当新版本的 bug 报上来（真踩过）。
          h("dt", null, "版本（磁盘）"), h("dd", null, self.diskVersion || "—"),
          h("dt", null, "对端"), h("dd", null, `${peers.length} 台，在线 ${peers.filter((p) => p && p.online).length} 台`),
        ),
        self.versionDrift
          ? h(
              "div",
              { className: "mesh-notice", role: "status" },
              `磁盘上是 ${self.diskVersion}，当前进程还在跑 ${self.version}：重启 DSH 后新版本才生效。`,
            )
          : null,
        h(
          "div",
          { className: "mesh-actions-row" },
          h(Button, { variant: "ghost", size: "sm", icon: "copy", onClick: copyAll }, "复制诊断信息"),
        ),
        h("p", { className: "mesh-hint" }, "这些信息只在排障时需要。遇到连接问题时，把复制出来的内容发给开发者。"),
      );
    }

    function SettingsView({ state, open, onOpen, onSaveName, nameBusy, push, reload }) {
      const self = (state && state.self) || {};
      const cfg = (state && state.config) || {};
      const tsnet = state && state.tsnet;
      const phase = tsnetPhase(tsnet);
      const toggle = (id) => onOpen(open === id ? null : id);

      return h(
        "div",
        { className: "mesh-settings-scroll" },
        h(
          "div",
          { className: "mesh-settings" },
          h(
            "header",
            { className: "mesh-settings-head" },
            // tab 已经叫「连接」了，标题再写一遍是重复；这里只留一句说明。
            h("p", null, "本机身份、配对码与跨网络互联。改动立即生效，不需要重启。"),
          ),
          h(
            SettingsSection,
            {
              id: "me",
              icon: "device",
              title: "本机",
              subtitle: `${self.machine || "未命名"} · ${shortAddress(self.host, self.port)}`,
              status: self.needsName ? h(Badge, { kind: "warn" }, "待命名") : null,
              open: open === "me",
              onToggle: () => toggle("me"),
            },
            h(NameEditor, { self, onSave: onSaveName, busy: nameBusy, push }),
            h(
              "dl",
              { className: "mesh-kv", style: { marginTop: 14 } },
              h("dt", null, "地址"), h("dd", null, shortAddress(self.host, self.port)),
              h("dt", null, "系统"), h("dd", null, osLabel(self.platform)),
              h("dt", null, "版本"), h("dd", null, self.version || "—"),
              h("dt", null, "其他地址"), h("dd", null, Array.isArray(self.addresses) && self.addresses.length ? self.addresses.join("  ·  ") : "—"),
            ),
          ),
          h(
            SettingsSection,
            {
              id: "pairing",
              icon: "key",
              title: "配对码",
              subtitle: cfg.requirePairing ? "已开启 · 两端需使用同一个配对码" : "未开启 · 同一局域网发现即可派发",
              status: h(Badge, { kind: cfg.requirePairing ? "ok" : "muted" }, cfg.requirePairing ? "开" : "关"),
              open: open === "pairing",
              onToggle: () => toggle("pairing"),
            },
            h(PairingBody, { self, cfg, push, reload }),
          ),
          tsnet
            ? h(
                SettingsSection,
                {
                  id: "tsnet",
                  icon: "tailscale",
                  title: "互联网组网",
                  subtitle: tsnet.enabled || tsnetAddressList(tsnet).length
                    ? `${phase.label}${tsnetAddressList(tsnet).length ? ` · ${tsnetAddressList(tsnet)[0]}` : ""}`
                    : "未启用 · 跨网络互联（Tailscale）",
                  status: h(Badge, { kind: phase.kind }, phase.label),
                  open: open === "tsnet",
                  onToggle: () => toggle("tsnet"),
                },
                h(TsnetBody, { tsnet, push, reload }),
              )
            : null,
          h(
            SettingsSection,
            {
              id: "diag",
              icon: "terminal",
              title: "诊断",
              subtitle: "发现方式、端口、版本与对端统计",
              open: open === "diag",
              onToggle: () => toggle("diag"),
            },
            h(Diagnostics, { state, push }),
          ),
        ),
      );
    }

    // ─────────────────────── 主页（卡片） ───────────────────────

    function HomeStat({ label, value }) {
      return h(
        "div",
        { className: "mesh-hero-stat" },
        h("span", { className: "mesh-hero-stat-value" }, value),
        h("span", { className: "mesh-hero-stat-label" }, label),
      );
    }

    function HomeCard({ card, subtitle, status, editing, index, count, onMove, onHide, children, footer }) {
      return h(
        "article",
        {
          className: cls("mesh-card", card.full && "is-full", editing && "is-editing"),
          "data-mesh-view": "home",
          "data-mesh-card": card.id,
          style: { animationDelay: `${Math.min(index || 0, 8) * 26}ms` },
        },
        h(
          "div",
          { className: "mesh-card-head" },
          h("span", { className: "mesh-card-logo" }, h(Icon, { name: card.icon, size: card.full ? 19 : 17 })),
          h(
            "div",
            { className: "mesh-card-headtext" },
            h("div", { className: "mesh-card-title" }, card.title),
            subtitle ? h("div", { className: "mesh-card-sub" }, subtitle) : null,
          ),
          status ? h("span", { className: "mesh-card-status" }, status) : null,
        ),
        h("div", { className: "mesh-card-body" }, children),
        editing
          ? h(
              "div",
              { className: "mesh-card-tools" },
              h(Button, { variant: "ghost", size: "sm", icon: "arrowUp", disabled: index === 0, onClick: () => onMove(card.id, -1) }, "上移"),
              h(Button, { variant: "ghost", size: "sm", icon: "arrowDown", disabled: index === count - 1, onClick: () => onMove(card.id, 1) }, "下移"),
              h(Button, { variant: "ghost", size: "sm", icon: "hide", onClick: () => onHide(card.id) }, "隐藏"),
            )
          : footer
            ? h("div", { className: "mesh-card-foot" }, footer)
            : null,
      );
    }

    function HomeView({
      state,
      self,
      peers,
      tasks,
      now,
      lastOk,
      focus,
      layout,
      onLayoutChange,
      onFocusChange,
      onReset,
      onDevices,
      onTasks,
      onConnect,
      onScan,
      scanning,
      firstRun,
    }) {
      const [editing, setEditing] = react.useState(false);
      const cfg = (state && state.config) || {};
      const tsnet = state && state.tsnet;
      const phase = tsnetPhase(tsnet);
      const online = peers.filter((p) => p && p.online).length;
      const cards = layout.map((id) => HOME_CARDS.find((c) => c.id === id)).filter(Boolean);
      const hidden = HOME_CARDS.filter((c) => !layout.includes(c.id));

      const move = (id, dir) => {
        const i = layout.indexOf(id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= layout.length) return;
        const next = layout.slice();
        [next[i], next[j]] = [next[j], next[i]];
        onLayoutChange(next);
      };
      const hide = (id) => onLayoutChange(layout.filter((x) => x !== id));
      const show = (id) => onLayoutChange([...layout, id]);

      const renderCard = (card, index) => {
        const common = {
          key: card.id,
          card,
          editing,
          index,
          count: cards.length,
          onMove: move,
          onHide: hide,
        };

        if (card.id === "overview") {
          return h(HomeCard, {
            ...common,
            subtitle: `${osLabel(self.platform)} · 本机`,
            status: h(Status, { kind: "ok" }, "本机在线"),
            children: h(
              react.Fragment,
              null,
              h(
                "div",
                { className: "mesh-hero-row" },
                h("span", { className: "mesh-hero-name" }, self.machine || "本机"),
                h("span", { className: "mesh-hero-address" }, shortAddress(self.host, self.port)),
              ),
              h(
                "div",
                { className: "mesh-hero-stats" },
                h(HomeStat, { label: "在线设备", value: `${online} / ${peers.length}` }),
                h(HomeStat, { label: "配对码", value: cfg.requirePairing ? "开" : "关" }),
                h(HomeStat, { label: "跨网络", value: tsnet ? phase.label : "未启用" }),
                h(HomeStat, { label: "更新", value: ago(lastOk, now) }),
              ),
            ),
            footer: h(
              react.Fragment,
              null,
              h(Button, { variant: "secondary", icon: "scan", loading: scanning, onClick: onScan }, "局域网探测"),
              h(Button, { variant: "primary", icon: "device", onClick: onDevices }, "查看设备"),
            ),
          });
        }

        if (card.id === "devices") {
          return h(HomeCard, {
            ...common,
            subtitle: `${peers.length} 台其他设备`,
            status: h(Badge, { kind: online ? "ok" : "muted" }, `${online} 在线`),
            children: peers.length
              ? peers.slice(0, 3).map((p) =>
                  h(
                    "div",
                    { key: p.id, className: "mesh-mini-row" },
                    h(Dot, { kind: p.online ? "ok" : "idle" }),
                    h("span", { className: "mesh-mini-name" }, p.machine || "未命名设备"),
                    h("span", { className: "mesh-mini-meta" }, p.online ? `在线 · ${osLabel(p.os)}` : `${ago(p.lastSeen, now)}`),
                  ),
                )
              : h("p", { className: "mesh-card-text" }, "还没有发现其他设备。扫描本网段，或让对方也打开 Mesh。"),
            footer: h(Button, { variant: "ghost", size: "sm", icon: "device", onClick: onDevices }, "查看全部设备"),
          });
        }

        if (card.id === "tasks") {
          return h(HomeCard, {
            ...common,
            subtitle: `${tasks.length} 条记录`,
            children: tasks.length
              ? tasks.slice(0, 2).map((t) => {
                  const meta = taskMeta(t);
                  return h(
                    "div",
                    { key: t.key, className: "mesh-mini-row" },
                    h(Icon, { name: t.dir === "out" ? "arrowOut" : "arrowIn", size: 12 }),
                    h("span", { className: "mesh-mini-name" }, t.peer),
                    h("span", { className: "mesh-mini-meta" }, `${meta.label} · ${ago(t.at, now)}`),
                  );
                })
              : h("p", { className: "mesh-card-text" }, "还没有任务。去设备页给某台电脑派一个。"),
            footer: h(Button, { variant: "ghost", size: "sm", icon: "tasks", onClick: onTasks }, "查看全部任务"),
          });
        }

        if (card.id === "pairing") {
          return h(HomeCard, {
            ...common,
            subtitle: cfg.requirePairing ? "已开启 · 两端需使用同一个码" : "未开启 · 同一局域网直接派发",
            status: h(Badge, { kind: cfg.requirePairing ? "ok" : "muted" }, cfg.requirePairing ? "开" : "关"),
            children: h(
              "p",
              { className: "mesh-card-text" },
              cfg.requirePairing
                ? "同一内网也要两端码一致才能派发。把本机配对码复制到另一台机器的同一位置。"
                : "默认无需配对：发现即可派发。网络不完全可信（合租 / 公司 / 访客设备）时再开启。",
            ),
            footer: h(Button, { variant: "ghost", size: "sm", icon: "key", onClick: () => onConnect("pairing") }, "管理配对码"),
          });
        }

        if (card.id === "tsnet") {
          return h(HomeCard, {
            ...common,
            subtitle: tsnet ? "Tailscale · 跨网络互联" : "当前主机版本不支持",
            status: h(Badge, { kind: phase.kind }, phase.label),
            children: h(
              "p",
              { className: "mesh-card-text" },
              tsnetAddressList(tsnet).length
                ? `已连接 ${tsnetAddressList(tsnet).length} 条通道 · ${tsnetAddressList(tsnet).join(" · ")}`
                : "让不在同一网络的电脑也能互相派发任务。需要免费的 Tailscale 账号，授权码只保存一次。",
            ),
            footer: h(Button, { variant: "ghost", size: "sm", icon: "tailscale", onClick: () => onConnect("tsnet") }, "设置互联网组网"),
          });
        }

        return h(HomeCard, {
          ...common,
          subtitle: "发现方式、端口与版本",
          status: h(Badge, { kind: "muted" }, "只读"),
          children: h(
            react.Fragment,
            null,
            h("div", { className: "mesh-mini-row" }, h("span", { className: "mesh-mini-name" }, "发现"), h("span", { className: "mesh-mini-meta" }, cfg.useMulticast === false ? "主动扫描" : "组播 + 扫描")),
            h("div", { className: "mesh-mini-row" }, h("span", { className: "mesh-mini-name" }, "端口"), h("span", { className: "mesh-mini-meta" }, String(self.port || "—"))),
            h("div", { className: "mesh-mini-row" }, h("span", { className: "mesh-mini-name" }, "版本"), h("span", { className: "mesh-mini-meta" }, self.version || "—")),
          ),
          footer: h(Button, { variant: "ghost", size: "sm", icon: "terminal", onClick: () => onConnect("diag") }, "查看诊断"),
        });
      };

      return h(
        "div",
        { className: "mesh-home" },
        h(
          "div",
          { className: "mesh-home-inner" },
          firstRun,
          h(
            "div",
            { className: "mesh-home-head" },
            h(
              "div",
              null,
              h("h1", { className: "mesh-home-title" }, "主页"),
              h(
                "p",
                { className: "mesh-home-sub" },
                `${self.machine || "本机"} · 在线 ${online} / ${peers.length}`,
                focus ? " · 专注模式 · 每 15 秒刷新" : ` · 更新于 ${ago(lastOk, now)}`,
              ),
            ),
            h(
              "div",
              { className: "mesh-home-actions" },
              h(
                "div",
                { className: cls("mesh-focus-toggle", focus && "is-on") },
                h(Switch, { checked: focus, onChange: onFocusChange, label: "专注模式" }),
                h("span", { style: { cursor: "pointer" }, onClick: () => onFocusChange(!focus) }, focus ? "专注模式" : "专注"),
              ),
              editing
                ? h(Button, { variant: "primary", size: "sm", icon: "check", onClick: () => setEditing(false) }, "完成")
                : h(Button, { variant: "secondary", size: "sm", icon: "edit", onClick: () => setEditing(true) }, "自定义"),
              editing ? h(Button, { variant: "ghost", size: "sm", onClick: onReset }, "恢复默认") : null,
            ),
          ),
          editing
            ? h(
                "p",
                { className: "mesh-home-edit-hint" },
                "用 ↑ ↓ 调整顺序，用眼睛图标隐藏卡片；诊断默认隐藏，可以在下面加回来。专注模式会放慢刷新、关闭环境动效。",
              )
            : null,
          cards.length
            ? h("div", { className: "mesh-home-grid" }, cards.map((card, i) => renderCard(card, i)))
            : h(
                "div",
                { className: "mesh-home-empty" },
                h("p", null, "主页上的卡片都收起来了。"),
                h(Button, { variant: "secondary", size: "sm", onClick: onReset }, "恢复默认"),
              ),
          editing && hidden.length
            ? h(
                "div",
                { className: "mesh-home-hidden" },
                h("span", { className: "mesh-home-hidden-title" }, "已隐藏"),
                hidden.map((c) =>
                  h(Button, { key: c.id, variant: "ghost", size: "sm", icon: "plus", onClick: () => show(c.id) }, c.title),
                ),
              )
            : null,
        ),
      );
    }

    // ─────────────────────── 主页（自由卡片） ───────────────────────

    function HomeEditor({ mode, draft, onClose, onSave, onDelete }) {
      const [value, setValue] = react.useState(draft);
      const [error, setError] = react.useState("");
      const titleRef = react.useRef(null);
      const isEdit = mode === "edit";
      const typeDef = CUSTOM_TYPES.find((t) => t.value === value.type) || CUSTOM_TYPES[0];

      react.useEffect(() => {
        const t = setTimeout(() => {
          if (titleRef.current) titleRef.current.focus();
        }, 80);
        return () => clearTimeout(t);
      }, []);

      react.useEffect(() => {
        const onKey = (e) => {
          if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [onClose]);

      const set = (key, next) => setValue((v) => ({ ...v, [key]: next }));
      const changeType = (next) => {
        const def = CUSTOM_TYPES.find((t) => t.value === next) || CUSTOM_TYPES[0];
        setValue((v) => ({ ...v, type: next, icon: def.icon }));
      };

      const save = () => {
        const title = String(value.title || "").trim();
        if (!title) {
          setError("先给卡片起个标题。");
          return;
        }
        const url = String(value.url || "").trim();
        if (value.type === "link") {
          try {
            const parsed = new URL(url);
            if (!/^https?:$/.test(parsed.protocol)) throw new Error("scheme");
          } catch {
            setError("链接必须是 http(s):// 开头。");
            return;
          }
        }
        onSave({
          ...value,
          title,
          url,
          text: String(value.text || "").slice(0, 1000),
          icon: value.icon || typeDef.icon,
        });
      };

      return h(
        "div",
        {
          className: "mesh-editor-layer",
          onMouseDown: (e) => {
            if (e.target === e.currentTarget) onClose();
          },
        },
        h(
          "div",
          { className: "mesh-editor", role: "dialog", "aria-modal": "true", "aria-label": isEdit ? "编辑卡片" : "新建卡片" },
          h("h2", null, isEdit ? "编辑卡片" : "新建卡片"),
          h("p", null, "选一种内容，填标题和图标；保存后会出现在主页。"),
          h(
            Field,
            { label: "类型" },
            h(Segmented, {
              value: value.type,
              onChange: changeType,
              label: "卡片类型",
              items: CUSTOM_TYPES.map((t) => ({ value: t.value, label: t.label })),
            }),
          ),
          h(
            Field,
            { label: "标题" },
            h("input", {
              ref: titleRef,
              className: "mesh-input",
              value: value.title,
              maxLength: 40,
              placeholder: "例如：本周构建任务",
              onChange: (e) => set("title", e.target.value),
            }),
          ),
          h(
            Field,
            { label: "图标" },
            h(
              "div",
              { className: "mesh-chips" },
              CUSTOM_ICONS.map((icon) =>
                h(
                  "button",
                  {
                    key: icon,
                    type: "button",
                    className: cls("mesh-icon-pick", value.icon === icon && "is-on"),
                    onClick: () => set("icon", icon),
                    title: icon,
                  },
                  h(Icon, { name: icon, size: 15 }),
                ),
              ),
            ),
          ),
          value.type === "note"
            ? h(
                Field,
                { label: "内容" },
                h("textarea", {
                  className: "mesh-textarea",
                  style: { minHeight: 100 },
                  value: value.text,
                  placeholder: "写点什么…",
                  onChange: (e) => set("text", e.target.value),
                }),
              )
            : null,
          value.type === "link"
            ? h(
                react.Fragment,
                null,
                h(
                  Field,
                  { label: "链接地址" },
                  h("input", {
                    className: "mesh-input",
                    value: value.url,
                    placeholder: "https://…",
                    onChange: (e) => set("url", e.target.value),
                  }),
                ),
                h(
                  Field,
                  { label: "说明（可选）" },
                  h("textarea", {
                    className: "mesh-textarea",
                    style: { minHeight: 72 },
                    value: value.text,
                    placeholder: "这个链接是做什么的",
                    onChange: (e) => set("text", e.target.value),
                  }),
                ),
              )
            : null,
          value.type === "status"
            ? h(
                Field,
                { label: "显示指标" },
                h(
                  "select",
                  { className: "mesh-input", value: value.metric, onChange: (e) => set("metric", e.target.value) },
                  HOME_METRICS.map((m) => h("option", { key: m.value, value: m.value }, m.label)),
                ),
              )
            : null,
          value.type === "peers"
            ? h(
                Field,
                { label: "显示哪些设备" },
                h(
                  "select",
                  { className: "mesh-input", value: value.filter, onChange: (e) => set("filter", e.target.value) },
                  h("option", { value: "all" }, "全部设备"),
                  h("option", { value: "online" }, "仅在线"),
                ),
              )
            : null,
          value.type === "tasks"
            ? h(
                Field,
                { label: "显示哪些任务" },
                h(
                  "select",
                  { className: "mesh-input", value: value.filter, onChange: (e) => set("filter", e.target.value) },
                  h("option", { value: "all" }, "全部"),
                  h("option", { value: "in" }, "收到"),
                  h("option", { value: "out" }, "发出"),
                ),
              )
            : null,
          error ? h("div", { className: "mesh-editor-error" }, error) : null,
          h(
            "div",
            { className: "mesh-editor-foot" },
            isEdit
              ? h(
                  "div",
                  { style: { marginRight: "auto" } },
                  h(ConfirmButton, {
                    label: "删除卡片",
                    confirmLabel: "确认删除？",
                    variant: "danger",
                    onConfirm: () => onDelete(value.id),
                  }),
                )
              : null,
            h(Button, { variant: "ghost", onClick: onClose }, "取消"),
            h(Button, { variant: "primary", icon: "check", onClick: save }, "保存"),
          ),
        ),
      );
    }

    function BoardCard({
      card,
      subtitle,
      status,
      editing,
      index,
      count,
      onMove,
      onHide,
      onEdit,
      onDelete,
      custom,
      size,
      onResizeStart,
      onResetSize,
      drag,
      onDragStart,
      onDragEnd,
      onDragOver,
      onDrop,
      onDragEndZone,
      children,
      footer,
    }) {
      const wide = size && size.w === 2;
      const height = size && size.h;
      const isDragging = drag && drag.draggingId === card.id;
      const isDropTarget = drag && drag.dropId === card.id;
      const isResizing = drag && drag.resizingId === card.id;
      const beginDrag = (e) => {
        if (!editing) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.id);
        onDragStart(card.id);
      };
      return h(
        "article",
        {
          className: cls(
            "mesh-card",
            card.full && "is-full",
            wide && !card.full && "is-wide",
            height && "is-sized",
            editing && "is-editing",
            isDragging && "is-dragging",
            isDropTarget && "is-drop-target",
            isResizing && "is-resizing",
          ),
          "data-mesh-view": "home",
          "data-mesh-card": card.id,
          style: {
            animationDelay: `${Math.min(index || 0, 8) * 26}ms`,
            ...(height ? { height } : null),
          },
          draggable: editing || undefined,
          onDragStart: (e) => {
            if (!editing) return;
            if (e.target.closest("button, input, textarea, .mesh-card-resize")) {
              e.preventDefault();
              return;
            }
            beginDrag(e);
          },
          onDragEnd: () => onDragEnd(),
          onDragOver: (e) => {
            if (!editing) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            onDragOver(card.id);
          },
          onDrop: (e) => {
            if (!editing) return;
            e.preventDefault();
            onDrop(card.id);
          },
        },
        h(
          "div",
          { className: "mesh-card-head" },
          h("span", { className: "mesh-card-logo" }, h(Icon, { name: card.icon, size: card.full ? 19 : 17 })),
          h(
            "div",
            { className: "mesh-card-headtext" },
            h("div", { className: "mesh-card-title" }, card.title),
            subtitle ? h("div", { className: "mesh-card-sub" }, subtitle) : null,
          ),
          status ? h("span", { className: "mesh-card-status" }, status) : null,
          editing
            ? h(
                "span",
                {
                  className: "mesh-card-drag",
                  title: "拖动排序",
                  draggable: editing || undefined,
                  onDragStart: (e) => {
                    e.stopPropagation();
                    beginDrag(e);
                  },
                },
                h(Icon, { name: "grip", size: 13 }),
              )
            : null,
        ),
        h("div", { className: "mesh-card-body" }, children),
        editing
          ? h(
              "div",
              { className: "mesh-card-tools" },
              h(Button, { variant: "ghost", size: "sm", icon: "arrowUp", disabled: index === 0, onClick: () => onMove(card.id, -1) }, "上移"),
              h(Button, { variant: "ghost", size: "sm", icon: "arrowDown", disabled: index === count - 1, onClick: () => onMove(card.id, 1) }, "下移"),
              h(Button, { variant: "ghost", size: "sm", icon: "hide", onClick: () => onHide(card.id) }, "隐藏"),
              custom && onEdit ? h(Button, { variant: "ghost", size: "sm", icon: "edit", onClick: () => onEdit(card.id) }, "编辑") : null,
              custom && onDelete
                ? h(ConfirmButton, {
                    label: "删除",
                    confirmLabel: "确认删除？",
                    variant: "danger",
                    onConfirm: () => onDelete(card.id),
                  })
                : null,
            )
          : footer
            ? h("div", { className: "mesh-card-foot" }, footer)
            : null,
        editing
          ? h(
              "span",
              {
                className: "mesh-card-resize",
                title: "拖动调整大小；双击恢复自适应",
                onPointerDown: (e) => onResizeStart(card, e),
                onDoubleClick: (e) => {
                  e.stopPropagation();
                  onResetSize(card.id);
                },
              },
              h(Icon, { name: "resize", size: 12 }),
            )
          : null,
      );
    }

    // ─────────────────────── 主页 · 派发任务 ───────────────────────

    /**
     * 主页底部的常驻派发入口。
     *
     * 设备页的派发是「先选设备再写指令」的弹层；主页这里反过来——目标默认取
     * 第一台设备，写完成文直接 ⌘/Ctrl+Enter 发出去。所以目标选择器必须显示
     * 在线状态，离线时按钮禁用并说明原因，不能静默失败。
     */
    function DispatchPanel({ peers, hostDown, disabled, onScan, scanning, onDispatched, density }) {
      const targets = (peers || []).filter((p) => p && !p.self);
      const onlineCount = targets.filter((p) => p.online).length;
      const [peerId, setPeerId] = react.useState("");
      const [task, setTask] = react.useState("");
      const [thread, setThread] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [note, setNote] = react.useState(null);
      const taRef = react.useRef(null);

      const chosen = targets.find((p) => p.id === peerId) || targets[0] || null;
      const canSend = !!chosen && !!chosen.online && !!String(task).trim() && !busy && !hostDown && !disabled;

      const send = async () => {
        if (!canSend) return;
        setBusy(true);
        setNote(null);
        try {
          const r = await api("/send", { peer: chosen.machine, task, thread: String(thread).trim() });
          if (r && r.ok) {
            setNote({ ok: true, text: `已派发给 ${chosen.machine}${r.id ? `（${r.id}）` : ""}，回执会进入新会话` });
            setTask("");
            if (onDispatched) onDispatched(chosen, r);
          } else {
            setNote({ ok: false, text: `派发失败：${apiErr(r)}` });
          }
        } catch (e) {
          setNote({ ok: false, text: `派发失败：${String((e && e.message) || e)}` });
        } finally {
          setBusy(false);
        }
      };

      const reason = hostDown
        ? "与主机失去联系，暂时发不出去"
        : disabled
          ? "当前不可用"
          : !targets.length
            ? "还没有发现其他设备，先让对端也打开 Mesh"
            : !chosen || !chosen.online
              ? `${(chosen && chosen.machine) || "这台设备"}当前离线，换一台在线设备`
              : "";

      return h(
        "section",
        { className: cls("mesh-dispatch", density === "compact" && "is-dense"), "aria-label": "派发任务" },
        h(
          "div",
          { className: "mesh-dispatch-head" },
          h("span", { className: "mesh-dispatch-icon" }, h(Icon, { name: "send", size: 15 })),
          h(
            "div",
            { className: "mesh-dispatch-title" },
            h("div", { className: "mesh-dispatch-name" }, "派发任务"),
            h(
              "div",
              { className: "mesh-dispatch-sub" },
              targets.length
                ? `${onlineCount} / ${targets.length} 台在线 · 指令交给对端执行，结果由对端回派`
                : "还没有发现其他设备，先让对端也打开 Mesh",
            ),
          ),
          targets.length
            ? h(
                "div",
                { className: "mesh-dispatch-status" },
                h(Badge, { kind: chosen && chosen.online ? "ok" : "muted" }, chosen && chosen.online ? "在线" : "离线"),
              )
            : h(Button, { variant: "secondary", size: "sm", icon: "scan", onClick: onScan, loading: !!scanning }, "局域网探测"),
        ),
        h(
          "div",
          { className: "mesh-dispatch-form" },
          h(
            Field,
            { label: "发给" },
            h(
              "select",
              {
                className: "mesh-input",
                value: chosen ? chosen.id : "",
                disabled: !targets.length,
                onChange: (e) => setPeerId(e.target.value),
                "aria-label": "目标设备",
              },
              targets.length
                ? targets.map((p) =>
                    h("option", { key: p.id, value: p.id }, `${p.machine || "未命名设备"}${p.online ? "" : "（离线）"}`),
                  )
                : h("option", { value: "" }, "暂无设备"),
            ),
          ),
          h(
            Field,
            { label: "要对方做什么？" },
            h("textarea", {
              ref: taRef,
              className: "mesh-textarea mesh-dispatch-text",
              value: task,
              placeholder: "例如：拉取最新代码，重新构建并重启 web 服务，然后把结果回报给我。",
              onChange: (e) => setTask(e.target.value),
              onKeyDown: (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  send();
                }
              },
              "aria-label": "任务内容",
            }),
          ),
        ),
        h(
          Fold,
          { title: "高级", right: String(thread).trim() ? String(thread).trim() : "线程标识" },
          h(
            Field,
            { hint: "同一个线程标识会把多次派发串成一段对话。留空也可以。" },
            h("input", {
              className: "mesh-input",
              value: thread,
              placeholder: "例如 build-web",
              onChange: (e) => setThread(e.target.value),
            }),
          ),
        ),
        note
          ? h("div", { className: cls("mesh-dispatch-msg", note.ok ? "is-ok" : "is-err"), role: "status" }, note.text)
          : null,
        h(
          "div",
          { className: "mesh-dispatch-foot" },
          h(
            "span",
            { className: "mesh-dispatch-hint" },
            reason || "派发是异步的：这里成功只代表对端已接收。⌘/Ctrl + Enter 发送。",
          ),
          h(
            "div",
            { className: "mesh-dispatch-actions" },
            h(Button, { variant: "ghost", size: "sm", disabled: !String(task) || busy, onClick: () => setTask("") }, "清空"),
            h(
              Button,
              { variant: "primary", size: "sm", icon: "send", loading: busy, disabled: !canSend, onClick: send },
              busy ? "派发中…" : "发送",
            ),
          ),
        ),
      );
    }

    function HomeBoard({
      state,
      self,
      peers,
      tasks,
      now,
      lastOk,
      focus,
      layout,
      sizes = {},
      customCards = [],
      density = "comfortable",
      onLayoutChange,
      onFocusChange,
      onSizesChange,
      onCustomCardsChange,
      onDensityChange,
      onReset,
      onDevices,
      onTasks,
      onConnect,
      onScan,
      scanning,
      firstRun,
      hostDown,
      onDispatched,
    }) {
      const [editing, setEditing] = react.useState(false);
      const [drag, setDrag] = react.useState({ draggingId: null, dropId: null, resizingId: null });
      const dragRef = react.useRef({ draggingId: null, dropId: null, resizingId: null });
      const [resizing, setResizing] = react.useState(null);
      const [editor, setEditor] = react.useState(null);
      const cfg = (state && state.config) || {};
      const tsnet = state && state.tsnet;
      const phase = tsnetPhase(tsnet);
      const online = peers.filter((p) => p && p.online).length;
      const allCards = [...HOME_CARDS, ...customCards];
      const cards = layout.map((id) => allCards.find((c) => c.id === id)).filter(Boolean);
      const hidden = allCards.filter((c) => !layout.includes(c.id));

      const move = (id, dir) => {
        const i = layout.indexOf(id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= layout.length) return;
        const next = layout.slice();
        [next[i], next[j]] = [next[j], next[i]];
        onLayoutChange(next);
      };
      const hide = (id) => onLayoutChange(layout.filter((x) => x !== id));
      const show = (id) => onLayoutChange([...layout, id]);

      const dragStart = (id) => {
        dragRef.current = { ...dragRef.current, draggingId: id, dropId: null };
        setDrag((d) => ({ ...d, draggingId: id, dropId: null }));
      };
      const dragOver = (id) => {
        dragRef.current = { ...dragRef.current, dropId: id };
        setDrag((d) => (d.dropId === id ? d : { ...d, dropId: id }));
      };
      const dragEnd = () => {
        dragRef.current = { draggingId: null, dropId: null, resizingId: null };
        setDrag({ draggingId: null, dropId: null, resizingId: null });
      };
      const dropCard = (targetId) => {
        const draggingId = dragRef.current.draggingId;
        const from = layout.indexOf(draggingId);
        if (from < 0) {
          dragEnd();
          return;
        }
        const to = targetId === "__end__" ? layout.length : layout.indexOf(targetId);
        if (to < 0) {
          dragEnd();
          return;
        }
        const next = layout.slice();
        const [item] = next.splice(from, 1);
        const insertAt = targetId === "__end__" ? next.length : to;
        next.splice(insertAt, 0, item);
        onLayoutChange(next);
        dragEnd();
      };

      const startResize = (card, e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget.closest(".mesh-card");
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const base = sizes[card.id] || { w: card.full ? 2 : 1, h: null };
        const start = {
          id: card.id,
          x: e.clientX,
          y: e.clientY,
          w: base.w === 2 ? 2 : 1,
          h: rect.height,
          full: !!card.full,
        };
        let last = { w: start.w, h: Math.round(rect.height) };
        setResizing({ ...start, ...last });
        dragRef.current = { ...dragRef.current, resizingId: card.id };
        setDrag((d) => ({ ...d, resizingId: card.id }));
        const move = (ev) => {
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          const w = start.full ? 2 : dx > 90 ? 2 : dx < -90 ? 1 : start.w;
          const h = Math.max(140, Math.min(520, Math.round((start.h + dy) / 8) * 8));
          last = { w, h };
          setResizing({ ...start, w, h });
        };
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
          onSizesChange(card.id, { w: last.w, h: last.h });
          setResizing(null);
          dragRef.current = { ...dragRef.current, resizingId: null };
          setDrag((d) => ({ ...d, resizingId: null }));
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
      };

      const sizeFor = (card) => {
        if (resizing && resizing.id === card.id) return { w: resizing.w, h: resizing.h };
        const s = sizes[card.id];
        return s || { w: card.full ? 2 : 1, h: null };
      };

      const openNew = () =>
        setEditor({
          mode: "new",
          draft: {
            id: newCustomId(),
            custom: true,
            type: "note",
            icon: "note",
            title: "",
            text: "",
            url: "",
            metric: "online",
            filter: "all",
          },
        });
      const openEdit = (id) => {
        const card = customCards.find((c) => c.id === id);
        if (card) setEditor({ mode: "edit", draft: { ...card } });
      };
      const saveCustom = (value) => {
        if (editor && editor.mode === "new") {
          const card = { ...value, custom: true };
          onCustomCardsChange([...customCards, card]);
          onLayoutChange([...layout, card.id]);
        } else {
          onCustomCardsChange(customCards.map((c) => (c.id === value.id ? { ...c, ...value, custom: true } : c)));
        }
        setEditor(null);
      };
      const removeCustom = (id) => {
        onCustomCardsChange(customCards.filter((c) => c.id !== id));
        onLayoutChange(layout.filter((x) => x !== id));
        onSizesChange(id, null);
      };

      const metricValue = (metric) => {
        if (metric === "online") return `${online} / ${peers.length}`;
        if (metric === "pairing") return cfg.requirePairing ? "开" : "关";
        if (metric === "tsnet") return tsnet ? phase.label : "未启用";
        if (metric === "updated") return ago(lastOk, now);
        return String(self.port || "—");
      };
      const metricLabel = (metric) => (HOME_METRICS.find((m) => m.value === metric) || HOME_METRICS[0]).label;

      const miniPeers = (filter) => {
        const list = peers.filter((p) => filter !== "online" || p.online);
        return list.length
          ? list.slice(0, 3).map((p) =>
              h(
                "div",
                { key: p.id, className: "mesh-mini-row" },
                h(Dot, { kind: p.online ? "ok" : "idle" }),
                h("span", { className: "mesh-mini-name" }, p.machine || "未命名设备"),
                h("span", { className: "mesh-mini-meta" }, p.online ? `在线 · ${osLabel(p.os)}` : `${ago(p.lastSeen, now)}`),
              ),
            )
          : h("p", { className: "mesh-card-text" }, "还没有发现其他设备。扫描本网段，或让对方也打开 Mesh。");
      };
      const miniTasks = (filter) => {
        const list = tasks.filter((t) => filter === "all" || t.dir === filter);
        return list.length
          ? list.slice(0, 2).map((t) => {
              const meta = taskMeta(t);
              return h(
                "div",
                { key: t.key, className: "mesh-mini-row" },
                h(Icon, { name: t.dir === "out" ? "arrowOut" : "arrowIn", size: 12 }),
                h("span", { className: "mesh-mini-name" }, t.peer),
                h("span", { className: "mesh-mini-meta" }, `${meta.label} · ${ago(t.at, now)}`),
              );
            })
          : h("p", { className: "mesh-card-text" }, filter === "all" ? "还没有任务。去设备页给某台电脑派一个。" : "这个方向还没有任务。");
      };

      const renderCard = (card, index) => {
        const common = {
          key: card.id,
          card,
          editing,
          index,
          count: cards.length,
          onMove: move,
          onHide: hide,
          size: sizeFor(card),
          onResizeStart: startResize,
          onResetSize: (id) => onSizesChange(id, null),
          drag,
          onDragStart: dragStart,
          onDragEnd: dragEnd,
          onDragOver: dragOver,
          onDrop: dropCard,
        };

        if (isCustomCard(card)) {
          let subtitle = "自定义卡片";
          let status = h(Badge, { kind: "accent" }, "自定义");
          let children = null;
          let footer = null;
          if (card.type === "note") {
            subtitle = "便签";
            children = h("p", { className: "mesh-card-text is-pre" }, card.text || "空便签");
          } else if (card.type === "link") {
            subtitle = "链接";
            children = h(
              react.Fragment,
              null,
              card.text ? h("p", { className: "mesh-card-text" }, card.text) : null,
              card.url
                ? h("a", { className: "mesh-card-link", href: card.url, target: "_blank", rel: "noreferrer" }, "打开链接 ↗")
                : h("p", { className: "mesh-card-text" }, "还没有填写链接"),
            );
          } else if (card.type === "status") {
            subtitle = metricLabel(card.metric);
            children = h(
              "div",
              { className: "mesh-hero-stat" },
              h("span", { className: "mesh-hero-stat-value" }, metricValue(card.metric)),
              h("span", { className: "mesh-hero-stat-label" }, metricLabel(card.metric)),
            );
          } else if (card.type === "peers") {
            const list = peers.filter((p) => card.filter !== "online" || p.online);
            subtitle = `${list.length} 台${card.filter === "online" ? "在线" : "设备"}`;
            status = h(Badge, { kind: list.length ? "ok" : "muted" }, `${list.length}`);
            children = miniPeers(card.filter);
            footer = h(Button, { variant: "ghost", size: "sm", icon: "device", onClick: onDevices }, "查看全部设备");
          } else {
            const list = tasks.filter((t) => card.filter === "all" || t.dir === card.filter);
            subtitle = `${list.length} 条任务`;
            status = h(Badge, { kind: "muted" }, `${list.length}`);
            children = miniTasks(card.filter);
            footer = h(Button, { variant: "ghost", size: "sm", icon: "tasks", onClick: onTasks }, "查看全部任务");
          }
          return h(BoardCard, {
            ...common,
            subtitle,
            status,
            custom: true,
            onEdit: openEdit,
            onDelete: removeCustom,
            children,
            footer,
          });
        }

        if (card.id === "overview") {
          return h(BoardCard, {
            ...common,
            subtitle: `${osLabel(self.platform)} · 本机`,
            status: h(Status, { kind: "ok" }, "本机在线"),
            children: h(
              react.Fragment,
              null,
              h(
                "div",
                { className: "mesh-hero-row" },
                h("span", { className: "mesh-hero-name" }, self.machine || "本机"),
                h("span", { className: "mesh-hero-address" }, shortAddress(self.host, self.port)),
              ),
              h(
                "div",
                { className: "mesh-hero-stats" },
                h(HomeStat, { label: "在线设备", value: `${online} / ${peers.length}` }),
                h(HomeStat, { label: "配对码", value: cfg.requirePairing ? "开" : "关" }),
                h(HomeStat, { label: "跨网络", value: tsnet ? phase.label : "未启用" }),
                h(HomeStat, { label: "更新", value: ago(lastOk, now) }),
              ),
            ),
            footer: h(
              react.Fragment,
              null,
              h(Button, { variant: "secondary", icon: "scan", loading: scanning, onClick: onScan }, "局域网探测"),
              h(Button, { variant: "primary", icon: "device", onClick: onDevices }, "查看设备"),
            ),
          });
        }

        if (card.id === "devices") {
          return h(BoardCard, {
            ...common,
            subtitle: `${peers.length} 台其他设备`,
            status: h(Badge, { kind: online ? "ok" : "muted" }, `${online} 在线`),
            children: miniPeers("all"),
            footer: h(Button, { variant: "ghost", size: "sm", icon: "device", onClick: onDevices }, "查看全部设备"),
          });
        }

        if (card.id === "tasks") {
          return h(BoardCard, {
            ...common,
            subtitle: `${tasks.length} 条记录`,
            children: miniTasks("all"),
            footer: h(Button, { variant: "ghost", size: "sm", icon: "tasks", onClick: onTasks }, "查看全部任务"),
          });
        }

        if (card.id === "pairing") {
          return h(BoardCard, {
            ...common,
            subtitle: cfg.requirePairing ? "已开启 · 两端需使用同一个码" : "未开启 · 同一局域网直接派发",
            status: h(Badge, { kind: cfg.requirePairing ? "ok" : "muted" }, cfg.requirePairing ? "开" : "关"),
            children: h(
              "p",
              { className: "mesh-card-text" },
              cfg.requirePairing
                ? "同一内网也要两端码一致才能派发。把本机配对码复制到另一台机器的同一位置。"
                : "默认无需配对：发现即可派发。网络不完全可信（合租 / 公司 / 访客设备）时再开启。",
            ),
            footer: h(Button, { variant: "ghost", size: "sm", icon: "key", onClick: () => onConnect("pairing") }, "管理配对码"),
          });
        }

        if (card.id === "tsnet") {
          return h(BoardCard, {
            ...common,
            subtitle: tsnet ? "Tailscale · 跨网络互联" : "当前主机版本不支持",
            status: h(Badge, { kind: phase.kind }, phase.label),
            children: h(
              "p",
              { className: "mesh-card-text" },
              tsnetAddressList(tsnet).length
                ? `已连接 ${tsnetAddressList(tsnet).length} 条通道 · ${tsnetAddressList(tsnet).join(" · ")}`
                : "让不在同一网络的电脑也能互相派发任务。需要免费的 Tailscale 账号，授权码只保存一次。",
            ),
            footer: h(Button, { variant: "ghost", size: "sm", icon: "tailscale", onClick: () => onConnect("tsnet") }, "设置互联网组网"),
          });
        }

        return h(BoardCard, {
          ...common,
          subtitle: "发现方式、端口与版本",
          status: h(Badge, { kind: "muted" }, "只读"),
          children: h(
            react.Fragment,
            null,
            h("div", { className: "mesh-mini-row" }, h("span", { className: "mesh-mini-name" }, "发现"), h("span", { className: "mesh-mini-meta" }, cfg.useMulticast === false ? "主动扫描" : "组播 + 扫描")),
            h("div", { className: "mesh-mini-row" }, h("span", { className: "mesh-mini-name" }, "端口"), h("span", { className: "mesh-mini-meta" }, String(self.port || "—"))),
            h("div", { className: "mesh-mini-row" }, h("span", { className: "mesh-mini-name" }, "版本"), h("span", { className: "mesh-mini-meta" }, self.version || "—"))),
          footer: h(Button, { variant: "ghost", size: "sm", icon: "terminal", onClick: () => onConnect("diag") }, "查看诊断"),
        });
      };

      return h(
        react.Fragment,
        null,
        h(
          "div",
          { className: cls("mesh-home", density === "compact" && "is-dense") },
          h(
            "div",
            { className: "mesh-home-inner" },
            firstRun,
            h(
              "div",
              { className: "mesh-home-head" },
              h(
                "div",
                null,
                // 不再重复写「主页」：tab 上已经写了一次，页面里再来一遍只是噪音。
                h(
                  "p",
                  { className: "mesh-home-sub", style: { margin: 0 } },
                  h(
                    react.Fragment,
                    null,
                    h("span", null, `${self.machine || "本机"} · 在线 ${online} / ${peers.length}`),
                    self.version
                      ? h("span", { style: { marginLeft: 18, opacity: 0.75 } }, `v${self.version}`)
                      : null,
                  ),
                  focus ? " · 专注模式 · 每 15 秒刷新" : ` · 更新于 ${ago(lastOk, now)}`,
                ),
              ),
              h(
                "div",
                { className: "mesh-home-actions" },
                h(
                  "div",
                  { className: cls("mesh-focus-toggle", focus && "is-on") },
                  h(Switch, { checked: focus, onChange: onFocusChange, label: "专注模式" }),
                  h("span", { style: { cursor: "pointer" }, onClick: () => onFocusChange(!focus) }, focus ? "专注模式" : "专注"),
                ),
                editing
                  ? h(Button, { variant: "primary", size: "sm", icon: "check", onClick: () => setEditing(false) }, "完成")
                  : h(Button, { variant: "secondary", size: "sm", icon: "edit", onClick: () => setEditing(true) }, "自定义"),
                editing ? h(Button, { variant: "ghost", size: "sm", onClick: onReset }, "恢复默认") : null,
              ),
            ),
            h(
              "div",
              {
                className: "mesh-star-banner",
                    title: "这是对作者最直接的反馈",
                    style: {
                      margin: "8px 0 10px",
                      padding: "6px 10px",
                      borderRadius: 8,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minHeight: 0,
                      background: "var(--dsw-alias-bg-secondary, #f6f7f9)",
                      border: "1px solid var(--dsw-alias-border-secondary, #e6e8eb)",
                      fontSize: 12,
                      lineHeight: "18px",
                    },
                  },
                  h("span", { style: { fontSize: 13, lineHeight: 1 } }, "⭐"),
                  h("span", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "觉得有用？在 GitHub 给 Mesh 点个 Star"),
                  h(
                    "a",
                    {
                      href: "https://github.com/peng456/dsh-plugin-mesh",
                      target: "_blank",
                      rel: "noreferrer",
                      className: "mesh-star-link",
                      title: "在浏览器中打开 GitHub 仓库",
                      style: {
                        color: "var(--dsw-alias-state-info-primary, #0969da)",
                        textDecoration: "underline",
                        textUnderlineOffset: 2,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      },
                    },
                    "peng456/dsh-plugin-mesh",
                  ),
                ),
            editing
              ? h(
                  "div",
                  { className: "mesh-home-toolbar" },
                  h(Button, { variant: "secondary", size: "sm", icon: "plus", onClick: openNew }, "添加卡片"),
                  h(
                    "div",
                    { className: "mesh-home-density" },
                    h("span", null, "密度"),
                    h(Segmented, {
                      value: density,
                      onChange: onDensityChange,
                      label: "卡片密度",
                      items: [
                        { value: "comfortable", label: "舒适" },
                        { value: "compact", label: "紧凑" },
                      ],
                    }),
                  ),
                  h("span", { className: "mesh-home-edit-hint", style: { margin: 0 } }, "拖动卡片排序，拖右下角改大小；双击右下角恢复自适应。"),
                )
              : null,
            cards.length
              ? h(
                  "div",
                  { className: "mesh-home-grid" },
                  cards.map((card, i) => renderCard(card, i)),
                  editing && drag.draggingId
                    ? h(
                        "div",
                        {
                          className: cls("mesh-drop-end", drag.dropId === "__end__" && "is-over"),
                          onDragOver: (e) => {
                            e.preventDefault();
                            dragOver("__end__");
                          },
                          onDrop: (e) => {
                            e.preventDefault();
                            dropCard("__end__");
                          },
                        },
                        "拖到这里放到最后",
                      )
                    : null,
                )
              : h(
                  "div",
                  { className: "mesh-home-empty" },
                  h("p", null, "主页上的卡片都收起来了。"),
                  h(Button, { variant: "secondary", size: "sm", onClick: onReset }, "恢复默认"),
                ),
            editing && hidden.length
              ? h(
                  "div",
                  { className: "mesh-home-hidden" },
                  h("span", { className: "mesh-home-hidden-title" }, "已隐藏"),
                  hidden.map((c) =>
                    h(Button, { key: c.id, variant: "ghost", size: "sm", icon: "plus", onClick: () => show(c.id) }, c.title),
                  ),
                )
              : null,
            // 派发放最底下：先看设备状态，再写指令，最后才是这个动作面板。
            h(DispatchPanel, {
              peers,
              hostDown: !!hostDown,
              disabled: !!hostDown,
              onScan,
              scanning,
              onDispatched,
              density,
            }),
          ),
        ),
        editor
          ? h(HomeEditor, {
              mode: editor.mode,
              draft: editor.draft,
              onClose: () => setEditor(null),
              onSave: saveCustom,
              onDelete: (id) => {
                removeCustom(id);
                setEditor(null);
              },
            })
          : null,
      );
    }

    // ─────────────────────── 工作台外壳 ───────────────────────

    function TopBar({ view, onView, online, total, taskCount, error, lastOk, now, refreshing, onRefresh, scanning, onScan, disabled, busy, focus, onToggleFocus, onTransfer, transferActive, onLog, transferCount }) {
      const tabs = [
        { value: "home", label: "主页", icon: "home" },
        { value: "devices", label: "设备", icon: "device", count: total },
        { value: "tasks", label: "任务", icon: "tasks", count: taskCount },
        { value: "connect", label: "连接", icon: "plug" },
      ];
      const healthText = error ? "连接中断" : total === 0 ? "未发现设备" : `${online} / ${total} 在线`;

      return h(
        "header",
        { className: "mesh-topbar", "aria-busy": !!busy },
        h(
          "div",
          { className: "mesh-brand" },
          h("span", { className: "mesh-logo" }, h(Icon, { name: "mesh", size: 16 })),
          h("span", { className: "mesh-wordmark" }, "Mesh"),
          h("span", { className: "mesh-wordsub" }, "工作台"),
        ),
        h(
          "nav",
          { className: "mesh-tabs", role: "tablist", "aria-label": "Mesh 子页" },
          tabs.map((t) =>
            h(
              "button",
              {
                key: t.value,
                type: "button",
                role: "tab",
                "aria-selected": view === t.value,
                className: "mesh-tab",
                onClick: () => onView(t.value),
              },
              h(Icon, { name: t.icon, size: 13 }),
              t.label,
              t.count ? h("span", { className: "mesh-count" }, t.count) : null,
            ),
          ),
        ),
        h(
          "div",
          { className: "mesh-topright" },
          h(
            "span",
            { className: "mesh-health", title: lastOk ? `更新于 ${ago(lastOk, now)}` : "还没有成功更新" },
            h(Dot, { kind: error ? "warn" : online > 0 ? "ok" : "idle" }),
            h("span", { key: healthText, className: "mesh-health-text mesh-value" }, healthText),
          ),
          h(IconButton, {
            icon: "send",
            label: transferActive ? "退出锚定传输" : "锚定传输：点选元素发出去",
            active: transferActive,
            onClick: onTransfer,
            disabled: disabled,
          }),
          h(IconButton, {
            icon: "clock",
            label: "传输记录",
            onClick: onLog,
            badge: transferCount,
          }),
          h(IconButton, {
            icon: "focus",
            label: focus ? "退出专注模式" : "进入专注模式",
            active: focus,
            onClick: onToggleFocus,
          }),
          h(IconButton, { icon: "refresh", label: "刷新状态", onClick: onRefresh, loading: refreshing, disabled }),
          h(IconButton, { icon: "scan", label: scanning ? "正在探测局域网" : "局域网探测", onClick: onScan, loading: scanning, disabled }),
        ),
        busy
          ? h(
              "span",
              { className: "mesh-progress", role: "progressbar", "aria-label": "正在刷新 Mesh 状态" },
              h("span", { className: "mesh-progress-bar" }),
            )
          : null,
      );
    }

    function MeshApp() {
      const {
        layout,
        focus,
        sizes,
        customCards,
        density,
        setLayout,
        setFocus,
        setSize,
        setCustomCards,
        setDensity,
        reset: resetHome,
      } = useHomePrefs();
      const { state, error, lastOk, loading, refreshing, reload } = useMeshState(focus ? 15000 : 3000);
      const now = useNow(5000);
      const { items: toasts, push, close } = useToasts();

      react.useEffect(() => {
        if (!state) return;
        setTransfers((prev) => {
          let changed = false;
          const next = prev.map((item) => {
            if (item.route !== "mesh" || item.status === "replied") return item;
            const inbound = Array.isArray(state.inbound) ? state.inbound : [];
            const outbound = Array.isArray(state.outbound) ? state.outbound : [];
            if (item.thread && inbound.some((task) => task && task.thread === item.thread)) {
              changed = true;
              return { ...item, status: "replied", repliedAt: new Date().toISOString(), error: "" };
            }
            const sent = outbound.find(
              (task) => task && (task.id === item.taskId || (item.thread && task.thread === item.thread)),
            );
            if (sent) {
              if (sent.ok && item.status !== "delivered") {
                changed = true;
                return { ...item, status: "delivered", error: "" };
              }
              if (!sent.ok && item.status !== "failed") {
                changed = true;
                return { ...item, status: "failed", error: String(sent.error || `HTTP ${sent.status || "?"}`) };
              }
            }
            return item;
          });
          if (changed) saveTransfers(next);
          return changed ? next : prev;
        });
      }, [state]);

      const [view, setView] = react.useState("home");
      const [selectedId, setSelectedId] = react.useState(null);
      const [mobilePane, setMobilePane] = react.useState("list");
      const [selectedTaskKey, setSelectedTaskKey] = react.useState(null);
      const [taskPane, setTaskPane] = react.useState("list");
      const [taskFilter, setTaskFilter] = react.useState("all");
      const [composer, setComposer] = react.useState(null);
      const [probe, setProbe] = react.useState(null);
      const [scanning, setScanning] = react.useState(false);
      const [nameBusy, setNameBusy] = react.useState(false);
      const [nameDismissed, setNameDismissed] = react.useState(false);
      const [settingsOpen, setSettingsOpen] = react.useState(null);
      const [transferMode, setTransferMode] = react.useState(false);
      const [transferDraft, setTransferDraft] = react.useState(null);
      const [transferLogOpen, setTransferLogOpen] = react.useState(false);
      const [transfers, setTransfers] = react.useState(() => loadTransfers());
      const sessionId = currentSessionId();

      const self = state && state.self ? state.self : null;
      const peers = state && Array.isArray(state.peers) ? state.peers : [];
      const online = peers.filter((p) => p && p.online).length;
      const tasks = react.useMemo(() => taskList(state), [state]);
      const sortedPeers = react.useMemo(
        () =>
          // 只按「在线 → 机器名」排：lastSeen 每 3 秒轮询都会变，
          // 用它当主键会让两台设备在列表里反复互换位置，看起来就是「频繁闪烁」。
          [...peers].sort((a, b) => {
            if (!!a.online !== !!b.online) return a.online ? -1 : 1;
            return String(a.machine || "").localeCompare(String(b.machine || ""));
          }),
        [peers],
      );

      const selfPeer = react.useMemo(
        () =>
          self
            ? {
                id: "self",
                machine: self.machine || "本机",
                self: true,
                online: true,
                host: self.host || "",
                port: self.port || 0,
                hostname: self.hostname || "",
                mac: self.mac || "",
                os: self.platform || "",
                user: "",
                profile: "",
                lastSeen: now,
                version: self.version || "",
                capabilities: self.capabilities || null,
                capabilitiesStale: false,
                endpoints: [],
                addresses: Array.isArray(self.addresses) ? self.addresses : [],
                machineSource: self.machineSource,
                needsName: self.needsName,
              }
            : null,
        [self, now],
      );

      react.useEffect(() => {
        if (!state) return;
        if (selectedId === "self" && state.self) return;
        if (selectedId && peers.some((p) => p.id === selectedId)) return;
        const first = peers.find((p) => p.online) || peers[0];
        setSelectedId(first ? first.id : state.self ? "self" : null);
      }, [state]);

      react.useEffect(() => {
        if (!state) return;
        if (selectedTaskKey && tasks.some((t) => t.key === selectedTaskKey)) return;
        setSelectedTaskKey(tasks[0] ? tasks[0].key : null);
      }, [state]);

      const selectedPeer = selectedId === "self" ? selfPeer : sortedPeers.find((p) => p.id === selectedId) || null;
      const selectedTask = tasks.find((t) => t.key === selectedTaskKey) || null;
      const recentTasks = selectedPeer && !selectedPeer.self
        ? tasks.filter((t) => String(t.peer).split("/")[0] === selectedPeer.machine).slice(0, 3)
        : [];
      const composerTarget = composer
        ? composer.id === "self"
          ? selfPeer
          : sortedPeers.find((p) => p.id === composer.id) || peers.find((p) => p.id === composer.id) || null
        : null;
      const hostDown = !!error;

      const saveName = async (raw) => {
        const name = String(raw || "").trim();
        if (!name) return false;
        setNameBusy(true);
        try {
          const r = await api("/name", { name });
          if (r && r.ok) {
            push("success", `本机名字已改为「${r.name || name}」`);
            await reload();
            return true;
          }
          push("error", `改名失败：${apiErr(r)}`);
          return false;
        } catch (e) {
          push("error", `改名失败：${String((e && e.message) || e)}`);
          return false;
        } finally {
          setNameBusy(false);
        }
      };

      const firstRunNode = self && self.needsName && !nameDismissed
        ? h(FirstRun, {
            self,
            busy: nameBusy,
            onSave: async (v) => {
              const ok = await saveName(v);
              if (ok) setNameDismissed(true);
            },
            onLater: () => setNameDismissed(true),
          })
        : null;

      const doScan = async () => {
        if (hostDown) return;
        setScanning(true);
        try {
          const r = await api("/scan", {});
          if (r && r.ok) {
            push("success", `局域网探测完成：发现 ${r.found ?? 0} 台（探测了 ${r.scanned ?? "?"} 个地址）`);
            await reload();
          } else {
            push("error", `局域网探测失败：${apiErr(r)}`);
          }
        } catch (e) {
          push("error", `局域网探测失败：${String((e && e.message) || e)}`);
        } finally {
          setScanning(false);
        }
      };

      const doProbe = async (peer) => {
        if (!peer || peer.self || hostDown) return;
        setProbe({ id: peer.id, pending: true });
        try {
          const r = await api("/probe", { peer: peer.machine });
          setProbe({ id: peer.id, pending: false, ...r });
        } catch (e) {
          setProbe({ id: peer.id, pending: false, reachable: false, error: String((e && e.message) || e) });
        }
      };

      const selectPeer = (id) => {
        setSelectedId(id);
        setMobilePane("detail");
      };

      const selectTask = (key) => {
        setSelectedTaskKey(key);
        setTaskPane("detail");
      };

      const openTask = (key) => {
        setView("tasks");
        setTaskFilter("all");
        setSelectedTaskKey(key);
        setTaskPane("detail");
      };

      const openAllTasks = () => {
        setView("tasks");
        setTaskFilter("all");
      };

      const openConnect = (section) => {
        setView("connect");
        setSettingsOpen(section || null);
      };

      const goDevices = () => {
        setView("devices");
        setMobilePane("list");
      };

      const goTasks = () => {
        setView("tasks");
        setTaskFilter("all");
        setTaskPane("list");
      };

      const changeTaskFilter = (f) => {
        setTaskFilter(f);
        const list = taskList(state).filter((t) => f === "all" || t.dir === f);
        setSelectedTaskKey(list[0] ? list[0].key : null);
      };

      const openComposer = (peer) => {
        if (!peer || peer.self) return;
        setComposer({ id: peer.id });
      };

      /**
       * 派发成功的统一收尾：toast + 让轮询立刻刷新。
       * 设备页弹层和主页的派发面板共用它，免得两处提示文案慢慢走散。
       */
      const notifyDispatched = (name, r) => {
        push("success", `已派发给 ${name || "对端"}${r && r.id ? `（${r.id}）` : ""}`, {
          label: "查看任务",
          onClick: () => {
            setView("tasks");
            setTaskFilter("all");
          },
        });
        reload();
      };

      const onSent = (r) => {
        const name = composerTarget && composerTarget.machine ? composerTarget.machine : "对端";
        setComposer(null);
        notifyDispatched(name, r);
      };

      const sendTransfer = async (route, intent) => {
        const draft = transferDraft;
        if (!draft) throw new Error("没有待发送的锚点");
        const id = transferId();
        const record = {
          id,
          at: new Date().toISOString(),
          route,
          target: {
            machine: route === "mesh" ? draft.anchor.machine || "" : "",
            sessionId: route === "agent" ? sessionId : "",
          },
          anchor: draft.anchor,
          snapshot: draft.snapshot,
          intent: intent || "",
          thread: route === "mesh" ? transferThread(id) : "",
          status: "sent",
          error: "",
        };
        try {
          if (route === "mesh") {
            const r = await api("/send", {
              peer: draft.anchor.machine,
              task: transferPrompt(record),
              thread: record.thread,
              // 回执要落回**当前这个会话**。不带的话宿主无法登记绑定，
              // 对端回传时只能新开一个 mesh-* 会话（真机反馈 #4）。
              originSession: sessionId || "",
            });
            record.taskId = r && r.id ? r.id : "";
            // 宿主会同回一个它**预建**的会话 id；回执会注入那里。
            record.sessionId = r && r.sessionId ? r.sessionId : "";
            if (!r || !r.ok) throw new Error(apiErr(r));
            record.status = "sent";
            if (record.sessionId) push("ok", "已预建会话，回执会进入其中", null);
          } else if (route === "agent") {
            record.status = await sendToAgent(transferPrompt(record), sessionId);
          } else {
            const ok = await copyText(transferMarkdown(record));
            if (!ok) throw new Error("复制失败");
            record.status = "copied";
          }
          setTransfers((prev) => {
            const next = [record, ...prev].slice(0, TRANSFER_LIMIT);
            saveTransfers(next);
            return next;
          });
          setTransferDraft(null);
          setTransferMode(false);
          push(
            "success",
            route === "mesh"
              ? `已派发给 ${draft.anchor.machine || "对端"}`
              : route === "agent"
                ? record.status === "prefilled"
                  ? "已填入输入框，按 Enter 发送"
                  : "已注入当前会话"
                : "已复制锚定上下文",
          );
          reload();
        } catch (e) {
          record.status = "failed";
          record.error = String((e && e.message) || e);
          setTransfers((prev) => {
            const next = [record, ...prev].slice(0, TRANSFER_LIMIT);
            saveTransfers(next);
            return next;
          });
          throw e;
        }
      };

      const retryTransfer = (item) => {
        setTransferLogOpen(false);
        setTransferDraft({
          anchor: item.anchor,
          snapshot: item.snapshot,
          intent: item.intent || "",
          route: item.route,
        });
      };

      const locateTransfer = (item) => {
        const a = (item && item.anchor) || {};
        if (a.kind === "task") {
          setView("tasks");
          setTaskFilter("all");
          setSelectedTaskKey(a.taskKey || null);
          setTaskPane("detail");
        } else if (a.kind === "setting") {
          setView("connect");
          setSettingsOpen(a.key || null);
        } else if (a.kind === "card") {
          setView("home");
        } else {
          setView("devices");
          const peer = peers.find(
            (p) => (a.instanceId && p.id === a.instanceId) || (a.machine && p.machine === a.machine),
          );
          if (peer) setSelectedId(peer.id);
          else if (a.machine && self && a.machine === self.machine) setSelectedId("self");
          setMobilePane("detail");
        }
        setTransferLogOpen(false);
      };

      const copyTransfer = async (item) => {
        const ok = await copyText(transferMarkdown(item));
        push(ok ? "success" : "error", ok ? "已复制锚定上下文" : "复制失败");
      };

      const retryTask = (machine) => {
        const p = peers.find((x) => x.machine === machine);
        if (!p) {
          push("error", "对端已不在设备列表里，无法重试。");
          return;
        }
        setView("devices");
        setSelectedId(p.id);
        setMobilePane("detail");
        setComposer({ id: p.id });
      };

      const copy = async (text) => {
        const ok = await copyText(String(text || ""));
        push(ok ? "success" : "error", ok ? "已复制到剪贴板" : "复制失败，请手动选择文本");
      };

      if (!state) {
        return h(
          "div",
          { className: cls("mesh-root", focus && "mesh-focus") },
          h(TopBar, {
            view,
            onView: setView,
            online: 0,
            total: 0,
            taskCount: 0,
            error,
            lastOk,
            now,
            refreshing,
            onRefresh: reload,
            scanning: false,
            onScan: doScan,
            disabled: true,
            busy: loading,
            focus,
            onToggleFocus: () => setFocus(!focus),
            onTransfer: () => {},
            transferActive: false,
            onLog: () => setTransferLogOpen(true),
            transferCount: transfers.length,
          }),
          loading ? h(LoadingView) : h(ErrorView, { error, onRetry: reload, onCopy: () => copy(error) }),
        );
      }

      return h(
        "div",
        { className: cls("mesh-root", focus && "mesh-focus"), "data-mesh-view": view },
        h(TopBar, {
          view,
          onView: (v) => {
            setComposer(null);
            setView(v);
          },
          online,
          total: peers.length,
          taskCount: tasks.length,
          error,
          lastOk,
          now,
          refreshing,
          onRefresh: reload,
          scanning,
          onScan: doScan,
          disabled: false,
          busy: refreshing || scanning,
          focus,
          onToggleFocus: () => setFocus(!focus),
          onTransfer: () => {
            setTransferLogOpen(false);
            setTransferMode((value) => !value);
          },
          transferActive: transferMode,
          onLog: () => {
            setTransferMode(false);
            setTransferLogOpen(true);
          },
          transferCount: transfers.filter((item) => item.status === "sent" || item.status === "delivered").length,
        }),
        error
          ? h(Banner, {
              kind: "warn",
              title: "与主机失去联系，正在重试",
              detail: lastOk ? `上次更新 ${ago(lastOk, now)}` : "还没有成功更新",
              action: { label: "重试", onClick: reload },
            })
          : null,
        state.duplicateNames && state.duplicateNames.length
          ? h(Banner, {
              kind: "warn",
              title: `有重名设备：${state.duplicateNames.join("、")}`,
              detail: "派发时可能分不清目标。",
              action: {
                label: "去改名",
                onClick: () => {
                  setView("connect");
                  setSettingsOpen("me");
                },
              },
            })
          : null,
        h(
          "main",
          { key: view, className: "mesh-view", role: "tabpanel", "aria-label": view === "home" ? "主页" : view === "devices" ? "设备" : view === "tasks" ? "任务" : "连接" },
          view === "home"
            ? h(HomeBoard, {
                state,
                self: self || {},
                peers: sortedPeers,
                tasks,
                now,
                lastOk,
                focus,
                layout,
                sizes,
                customCards,
                density,
                onLayoutChange: setLayout,
                onFocusChange: setFocus,
                onSizesChange: setSize,
                onCustomCardsChange: setCustomCards,
                onDensityChange: setDensity,
                onReset: resetHome,
                onDevices: goDevices,
                onTasks: goTasks,
                onConnect: openConnect,
                onScan: doScan,
                scanning,
                firstRun: firstRunNode,
                hostDown,
                onDispatched: (peer, r) => notifyDispatched((peer && peer.machine) || "", r),
              })
            : view === "devices"
            ? h(DeviceView, {
                selfPeer,
                peers: sortedPeers,
                selectedPeer,
                selectedId,
                onSelect: selectPeer,
                mobilePane,
                onBack: () => setMobilePane("list"),
                onCompose: openComposer,
                onProbe: doProbe,
                probe,
                hostDown,
                now,
                lastOk,
                onScan: doScan,
                scanning,
                recentTasks,
                onOpenTask: openTask,
                onAllTasks: openAllTasks,
                firstRun: firstRunNode,
                onRename: () => openConnect("me"),
              })
            : view === "tasks"
              ? h(TasksView, {
                  state,
                  filter: taskFilter,
                  onFilter: changeTaskFilter,
                  selectedKey: selectedTaskKey,
                  onSelect: selectTask,
                  pane: taskPane,
                  onBack: () => setTaskPane("list"),
                  onRetry: retryTask,
                  onCopy: copy,
                  push,
                  reload,
                  now,
                  onGoDevices: () => setView("devices"),
                })
              : h(SettingsView, {
                  state,
                  open: settingsOpen,
                  onOpen: setSettingsOpen,
                  onSaveName: saveName,
                  nameBusy,
                  push,
                  reload,
                }),
        ),
        h(Composer, {
          target: composerTarget,
          open: !!composer,
          onClose: () => setComposer(null),
          onSent,
          hostDown,
        }),
        h(TransferLayer, {
          active: transferMode,
          state,
          onPick: (draft) => {
            setTransferMode(false);
            setTransferDraft(draft);
          },
          onCancel: () => setTransferMode(false),
        }),
        transferDraft
          ? h(TransferComposer, {
              draft: transferDraft,
              state,
              sessionId,
              onClose: () => setTransferDraft(null),
              onSend: sendTransfer,
            })
          : null,
        transferLogOpen
          ? h(TransferLog, {
              items: transfers,
              onClose: () => setTransferLogOpen(false),
              onRetry: retryTransfer,
              onLocate: locateTransfer,
              onCopy: copyTransfer,
            })
          : null,
        h(Toasts, { items: toasts, onClose: close }),
      );
    }

    // ─────────────────────── 侧栏图标 ───────────────────────

    function MeshIcon(props) {
      const size = (props && props.size) || 16;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        iconChildren("mesh"),
      );
    }

    // ─────────────────────── 注册 ───────────────────────

    function apply(ctx) {
      pluginCtx = ctx;
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 50, label: "Mesh" },
          MeshIcon,
        ),
      );
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, MeshApp),
      );
      ctx.logger?.info?.("mesh client: 已注册 Mesh 工作台");
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = {
      MeshApp,
      HomeView,
      HomeBoard,
      DispatchPanel,
      DeviceList,
      TasksView,
      DeviceDetail,
      DeviceRow,
      CapabilityChips,
      TaskRow,
      TaskDetail,
      SettingsView,
      Diagnostics,
      Composer,
      TopBar,
      TransferLayer,
      TransferComposer,
      TransferLog,
      deriveAnchor,
      snapshotFor,
      anchorLabel,
      transferPrompt,
      transferMarkdown,
      transferStatusMeta,
      loadTransfers,
      saveTransfers,
      currentSessionId,
      sendToAgent,
      PairingBody,
      TsnetBody,
    };
    return module.exports;
  },
});
