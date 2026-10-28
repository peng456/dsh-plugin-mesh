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
    // 对端 DSH Web 的监听端口：dsh-web-app 的部署默认值就是 3080。对端用
    // `--port` 改过的话，在本机 localStorage 写 mesh.webPort 覆盖。
    const DSH_WEB_PORT = 3080;
    const WEB_PORT_KEY = "mesh.webPort";
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

    const SETTINGS_CATS = [
      { id: "general", label: "常规", icon: "device", desc: "本机名称、系统与地址" },
      { id: "network", label: "连接与发现", icon: "plug", desc: "端口、发现方式与保活" },
      { id: "security", label: "安全与配对", icon: "key", desc: "配对码与入站权限" },
      { id: "tsnet", label: "互联网组网", icon: "tailscale", desc: "跨网络 Tailscale 通道" },
      { id: "remote", label: "实验性", icon: "terminal", desc: "远程 Web 与 SSH" },
      { id: "diagnostics", label: "诊断", icon: "code", desc: "版本、端口与排障信息" },
      { id: "about", label: "关于", icon: "mesh", desc: "版本与项目链接" },
    ];
    const SETTINGS_ALIAS = { me: "general", pairing: "security", diag: "diagnostics" };

    const RUNTIME_DURATION_OPTIONS = {
      scan: [{ value: 0, label: "关闭" }, { value: 30000, label: "30 秒" }, { value: 60000, label: "1 分钟" }, { value: 300000, label: "5 分钟" }, { value: 900000, label: "15 分钟" }],
      ping: [{ value: 0, label: "关闭" }, { value: 5000, label: "5 秒" }, { value: 10000, label: "10 秒" }, { value: 30000, label: "30 秒" }, { value: 60000, label: "1 分钟" }],
      window: [{ value: 300000, label: "5 分钟" }, { value: 900000, label: "15 分钟" }, { value: 3600000, label: "1 小时" }, { value: 21600000, label: "6 小时" }, { value: 86400000, label: "24 小时" }],
      cooldown: [{ value: 0, label: "不限" }, { value: 60000, label: "1 分钟" }, { value: 300000, label: "5 分钟" }, { value: 900000, label: "15 分钟" }, { value: 3600000, label: "1 小时" }],
    };
    const PERMISSION_OPTIONS = [
      { value: "read-only", label: "read-only" },
      { value: "workspace-write", label: "workspace-write" },
      { value: "danger-full-access", label: "danger-full-access" },
    ];
    const SETTINGS_FIELDS = [
      { cat: "network", key: "useMulticast", label: "组播发现", type: "switch", restart: true },
      { cat: "network", key: "scanOnStart", label: "启动时扫描", type: "switch", restart: true },
      { cat: "network", key: "scanIntervalMs", label: "扫描间隔", type: "select", options: RUNTIME_DURATION_OPTIONS.scan, valueType: "number", restart: true },
      { cat: "network", key: "pingIntervalMs", label: "保活间隔", type: "select", options: RUNTIME_DURATION_OPTIONS.ping, valueType: "number", restart: true },
      { cat: "network", key: "scanRanges", label: "额外扫描网段", type: "list" },
      { cat: "security", key: "permissionPreset", label: "入站权限", type: "select", options: PERMISSION_OPTIONS },
      { cat: "security", key: "agentPreset", label: "入站 agent preset", type: "text" },
      { cat: "security", key: "workspaceRoot", label: "工作目录（留空默认）", type: "text" },
      { cat: "security", key: "tsnetPermissionPreset", label: "tailnet 权限", type: "select", options: [{ value: "", label: "同局域网" }, ...PERMISSION_OPTIONS] },
      { cat: "security", key: "minTaskChars", label: "最短任务长度（字符）", type: "number" },
      { cat: "security", key: "maxWakesPerThread", label: "每会话唤醒上限（0 不限）", type: "number" },
      { cat: "security", key: "threadWindowMs", label: "限速窗口", type: "select", options: RUNTIME_DURATION_OPTIONS.window, valueType: "number" },
      { cat: "security", key: "threadCooldownMs", label: "唤醒冷却", type: "select", options: RUNTIME_DURATION_OPTIONS.cooldown, valueType: "number" },
      { cat: "remote", key: "experimentalRemoteControl", label: "远程控制（实验性）", type: "switch" },
      { cat: "remote", key: "desktopWebPort", label: "本机引擎转发端口（0 关闭）", type: "number", restart: true, requires: "experimentalRemoteControl" },
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

    /**
     * 头像：有图用图，没图/加载失败回退首字母。
     * 图片来自 host 自述的 data URL，不额外请求文件服务。
     */
    function Avatar({ name, avatar, className, children }) {
      const [failed, setFailed] = react.useState(false);
      react.useEffect(() => setFailed(false), [avatar]);
      const image = typeof avatar === "string" && avatar.startsWith("data:image/") && !failed;
      return h(
        "span",
        { className: `${className || "mesh-avatar"}${image ? " has-image" : ""}` },
        image
          ? h("img", {
              src: avatar,
              alt: "",
              draggable: false,
              onError: () => setFailed(true),
            })
          : initial(name),
        children,
      );
    }

    /** 把用户选的图片压成 96×96 JPEG data URL；太大再降一次质量。 */
    function imageFileToAvatar(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          try {
            const size = 96;
            const canvas = document.createElement("canvas");
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext("2d");
            const scale = Math.max(size / img.width, size / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
            let out = canvas.toDataURL("image/jpeg", 0.78);
            if (out.length > 90 * 1024) out = canvas.toDataURL("image/jpeg", 0.6);
            URL.revokeObjectURL(url);
            resolve(out);
          } catch (err) {
            URL.revokeObjectURL(url);
            reject(err);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("图片读取失败"));
        };
        img.src = url;
      });
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

    /** 对端的局域网主机名/IP（不带 mesh 端口）：优先 peer.host，其次第一个 endpoint。 */
    function peerHost(peer) {
      if (!peer) return "";
      if (peer.host) return String(peer.host);
      const eps = Array.isArray(peer.endpoints) ? peer.endpoints : [];
      const ep = eps.find((x) => x && x.host);
      return ep ? String(ep.host) : "";
    }

    /** 对端 DSH Web 的地址；没有地址时返回空串（不编一个出来）。 */
    function dshWebUrl(peer) {
      const host = peerHost(peer);
      if (!host) return "";
      let port = DSH_WEB_PORT;
      try {
        const custom = Number(localStorage.getItem(WEB_PORT_KEY));
        if (Number.isFinite(custom) && custom > 0 && custom < 65536) port = Math.floor(custom);
      } catch {
        /* 存储不可用就用默认端口 */
      }
      return `http://${host}:${port}/`;
    }

    /**
     * 要一条能直接打开的地址。
     *
     * 优先问本机宿主（/mesh/api/web-url）：它去对端的配对通道里取一条带启动
     * token 的地址，端口和 bind 都是对端自报的真值。对端是老版本插件、或者
     * 取不到时，退回按约定拼出来的 http://<host>:3080/——那种情况浏览器会
     * 停在 401 页，提示用户去对端取一次 token 地址。
     * @returns {{ url: string, source: string, lanReachable?: boolean, reason?: string }}
     */
    async function resolveWebUrl(peer) {
      const fallback = dshWebUrl(peer);
      try {
        const r = await api("/web-url", { peer: (peer && (peer.machine || peer.id)) || "" });
        if (r && r.ok === true && typeof r.url === "string" && r.url)
          return { url: r.url, source: "host", lanReachable: r.lanReachable === true };
        return { url: fallback, source: "computed", reason: (r && r.error) || "" };
      } catch (error) {
        return { url: fallback, source: "computed", reason: String((error && error.message) || error) };
      }
    }

    /**
     * 壳里的原生浏览器是否可用（只读探测）。
     *
     * 这台 Android 壳会明确报 browserWebViewAvailable=false（工位 WebView 未就绪），
     * 此时开 browser 页签只会落到一个"浏览器不可用"的空页面 —— 那比直接退回
     * 外部浏览器更糟。所以先问一句：**壳明确说不可用才降级**，问不出来照常试。
     */
    function nativeBrowserUsable(sessionId) {
      try {
        const bridge = window.androidBridge;
        if (!bridge || typeof bridge.browserHostCommand !== "function") return false;
        if (!sessionId) return true; // 没有会话就无从判断，按可用处理
        const raw = bridge.browserHostCommand(
          JSON.stringify({ action: "status", session: sessionId, uiTabId: "mesh-probe" }),
        );
        if (typeof raw !== "string" || raw === "") return true; // 没答上来：不据此降级
        const value = JSON.parse(raw);
        return !(value && value.available === false);
      } catch {
        return true;
      }
    }

    /**
     * 在对端的 DSH Web 上开一个页面。
     * 先走应用内浏览器（sidebar.right 的 browser 页签）——它就是壳里的那个
     * WebView，不跳出 DSH；浏览器页不可用时退回外部浏览器。
     * @returns {Promise<{ ok: boolean, how: string, url: string, lanReachable?: boolean, reason?: string }>}
     */
    async function openDshWebPage(peer) {
      const resolved = await resolveWebUrl(peer);
      const url = resolved.url;
      if (!url) return { ok: false, how: "none", url: "", reason: resolved.reason || "这台设备没有上报地址" };
      const extra = {
        lanReachable: resolved.lanReachable,
        viaHost: resolved.source === "host",
      };
      const sidebar = pluginCtx && pluginCtx.get ? pluginCtx.get("sidebarRight") : null;
      const sessionId = currentSessionId();
      const browserUsable = nativeBrowserUsable(sessionId);
      // 先试强校验的 openTab（没有在屏会话会抛），再退化到按 session 的 openTabIn。
      try {
        if (browserUsable && sidebar && typeof sidebar.openTab === "function") {
          sidebar.openTab("browser", { params: { url }, revealIfOpened: false });
          return { ok: true, how: "browser", url, ...extra };
        }
      } catch {
        /* 落到 openTabIn */
      }
      try {
        if (browserUsable && sidebar && typeof sidebar.openTabIn === "function" && sessionId) {
          sidebar.openTabIn(sessionId, "browser", { params: { url }, revealIfOpened: false });
          return { ok: true, how: "browser", url, ...extra };
        }
      } catch {
        /* 落到外部浏览器 */
      }
      const bridge = window.androidBridge;
      if (bridge && typeof bridge.openExternalLink === "function") {
        try {
          bridge.openExternalLink(url);
          return { ok: true, how: "external", url, ...extra, browserUnavailable: !browserUsable };
        } catch {
          return { ok: false, how: "none", url, reason: "外部浏览器也打不开" };
        }
      }
      if (typeof window.open === "function") {
        window.open(url, "_blank");
        return { ok: true, how: "window", url, ...extra };
      }
      return { ok: false, how: "none", url, reason: "没有可用的打开方式" };
    }

    function apiErr(r) {
      if (r && r.status === 402) return "设置接口未就绪：重启 DSH 后再试";
      if (r && r.status === 404) return "设置接口不存在：重启 DSH 后再试";
      if (r && r.status === 405) return "设置接口拒绝写入：重启 DSH 后再试";
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
      j.status = r.status;
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
/* 主面板的"出口"：宿主只给插件管理页注入返回键，Mesh 面板得自己带一个。 */
.mesh-panel-back {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; gap: 4px;
  height: 30px; padding: 0 10px 0 7px;
  border: 1px solid var(--mesh-line); border-radius: 8px;
  background: var(--mesh-surface); color: var(--mesh-muted);
  font-size: 12px; line-height: 1; cursor: pointer;
  transition: background var(--mesh-dur-fast) var(--mesh-ease-out),
    color var(--mesh-dur-fast) var(--mesh-ease-out),
    transform var(--mesh-dur-press) var(--mesh-ease-out);
}
.mesh-panel-back:hover { background: var(--mesh-surface-2); color: var(--mesh-fg); }
.mesh-panel-back:active { transform: scale(0.97); }
.mesh-panel-back:focus-visible { outline: 2px solid var(--mesh-accent); outline-offset: 2px; }
/* ── 对端 DSH Web 的应用内面板 ── */
.mesh-web-layer {
  position: absolute; inset: 0; z-index: 60;
  display: flex; flex-direction: column;
  background: var(--mesh-bg);
}
.mesh-web-bar {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--mesh-line);
  background: var(--mesh-bg);
}
.mesh-web-title {
  flex: 1 1 auto; min-width: 0;
  font-size: 12.5px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mesh-web-sub { color: var(--mesh-muted); font-weight: 400; }
.mesh-web-mark { flex: 0 0 auto; display: inline-flex; align-items: center; color: var(--mesh-fg); }
.mesh-web-frame { flex: 1 1 auto; width: 100%; min-height: 0; border: 0; background: var(--mesh-bg); }
.mesh-web-status {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px;
  font-size: 11.5px; line-height: 1.5;
  color: var(--mesh-muted);
}
.mesh-web-status.is-warn { color: var(--mesh-warn); }

/* ── SSH 终端面板 ── */
.mesh-ssh-form { display: flex; flex-direction: column; gap: 10px; padding: 16px; max-width: 520px; }
.mesh-ssh-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--mesh-muted); }
.mesh-ssh-field input {
  height: 36px; padding: 0 10px;
  border: 1px solid var(--mesh-line-2); border-radius: 8px;
  background: var(--mesh-surface); color: var(--mesh-fg); font-size: 14px;
}
.mesh-ssh-note { font-size: 11.5px; color: var(--mesh-muted); line-height: 1.5; }
.mesh-ssh-error { font-size: 12px; color: var(--mesh-err); }
.mesh-ssh-out {
  flex: 1 1 auto; min-height: 0; margin: 0; padding: 10px 12px;
  overflow: auto; white-space: pre-wrap; word-break: break-all;
  background: #111418; color: #d7dde5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; line-height: 1.5;
}
.mesh-ssh-inputrow {
  flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; border-top: 1px solid var(--mesh-line);
  background: var(--mesh-bg);
}
.mesh-ssh-inputrow input {
  flex: 1 1 auto; min-width: 0; height: 36px; padding: 0 10px;
  border: 1px solid var(--mesh-line-2); border-radius: 8px;
  background: var(--mesh-surface); color: var(--mesh-fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
}
.mesh-ssh-key, .mesh-ssh-send {
  flex: 0 0 auto; height: 36px; padding: 0 10px;
  border: 1px solid var(--mesh-line-2); border-radius: 8px;
  background: var(--mesh-surface); color: var(--mesh-fg); font-size: 12px; cursor: pointer;
}
.mesh-ssh-send { background: var(--mesh-fg); color: var(--mesh-bg); border-color: transparent; }

.mesh-logo {
  width: 26px; height: 26px; border-radius: 8px;
  display: grid; place-items: center;
  background: linear-gradient(145deg, var(--mesh-surface-2), var(--mesh-surface));
  border: 1px solid var(--mesh-line);
  color: var(--mesh-accent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
  transition: transform var(--mesh-dur-fast) var(--mesh-ease-out), border-color var(--mesh-dur-fast) var(--mesh-ease-out);
}
.mesh-logo:hover { transform: translateY(-1px); border-color: var(--mesh-line-2); }
.mesh-logo .mesh-mark { display: block; }
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
.mesh-avatar img, .mesh-detail-avatar img {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover; object-position: center;
  border-radius: inherit;
  display: block;
}
.mesh-avatar .mesh-dot, .mesh-detail-avatar .mesh-dot { z-index: 2; }
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
  padding: 3px 8px; border: 0; border-radius: 6px;
  background: var(--mesh-surface-2);
  font: inherit; font-size: 11px; line-height: 1.5; color: var(--mesh-fg);
  text-align: left; cursor: pointer;
  transition: background var(--mesh-dur-fast) var(--mesh-ease-out), box-shadow var(--mesh-dur-fast) var(--mesh-ease-out), transform var(--mesh-dur-press) var(--mesh-ease-out);
}
.mesh-chip:hover { background: var(--mesh-surface); box-shadow: inset 0 0 0 1px var(--mesh-line); }
.mesh-chip:active { transform: scale(.98); }
.mesh-chip:focus-visible { outline: 2px solid var(--mesh-accent); outline-offset: 1px; }
.mesh-chip.is-muted { background: transparent; border: 1px solid var(--mesh-line); color: var(--mesh-muted); }
.mesh-chip svg { flex: 0 0 auto; }
.mesh-chip-label { color: var(--mesh-muted); }
.mesh-chip-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; }
.mesh-specs { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--mesh-muted); }

/* ── 能力细节弹窗 ── */
.mesh-cap-layer {
  position: fixed; inset: 0; z-index: 95;
  display: flex; align-items: center; justify-content: center;
  padding: 20px; background: rgba(0,0,0,.45);
  animation: mesh-banner-in var(--mesh-dur-fast) var(--mesh-ease-out) both;
}
.mesh-cap-panel {
  width: min(760px, 100%); max-height: min(80vh, 620px);
  display: flex; overflow: hidden;
  background: var(--mesh-surface); border: 1px solid var(--mesh-line-2);
  border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.35);
}
.mesh-cap-side {
  flex: 0 0 220px; width: 220px; min-height: 0;
  display: flex; flex-direction: column;
  border-right: 1px solid var(--mesh-line);
  background: var(--mesh-surface-2);
}
.mesh-cap-side-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 12px 6px; font-size: 12px; font-weight: 600;
}
.mesh-cap-side-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 6px 10px; }
.mesh-cap-side-machine { padding: 0 12px 8px; color: var(--mesh-muted); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mesh-cap-side-item {
  width: 100%; display: flex; align-items: center; gap: 7px;
  padding: 6px 8px; border: 0; border-radius: 6px; background: transparent;
  color: var(--mesh-muted); font: inherit; font-size: 11.5px; text-align: left;
  cursor: pointer;
}
.mesh-cap-side-item:hover { color: var(--mesh-fg); }
.mesh-cap-side-item.is-active { background: var(--mesh-surface); color: var(--mesh-fg); }
.mesh-cap-side-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mesh-cap-side-ver { margin-left: auto; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--mesh-muted); }
.mesh-cap-detail { flex: 1; min-width: 0; overflow-y: auto; padding: 24px 26px; }
.mesh-cap-detail-mark {
  width: 46px; height: 46px; border-radius: 12px; display: grid; place-items: center;
  background: var(--mesh-surface-2); color: var(--mesh-fg); margin-bottom: 14px;
}
.mesh-cap-detail h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -.02em; overflow-wrap: anywhere; }
.mesh-cap-detail-ver { margin-top: 3px; color: var(--mesh-muted); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.mesh-cap-kv {
  display: grid; grid-template-columns: 76px 1fr; gap: 8px 14px;
  margin: 22px 0 0; font-size: 12px;
}
.mesh-cap-kv dt { color: var(--mesh-muted); }
.mesh-cap-kv dd { margin: 0; color: var(--mesh-fg); overflow-wrap: anywhere; }
.mesh-cap-age { margin-top: 18px; color: var(--mesh-muted); font-size: 10.5px; }
@media (max-width: 767px) {
  .mesh-cap-layer { padding: 10px; align-items: flex-end; }
  .mesh-cap-panel { flex-direction: column; max-height: 88dvh; border-radius: 14px 14px 0 0; }
  .mesh-cap-side { flex: 0 0 auto; width: 100%; border-right: 0; border-bottom: 1px solid var(--mesh-line); }
  .mesh-cap-side-list { display: flex; gap: 2px; overflow-x: auto; overflow-y: hidden; padding: 2px 8px 8px; }
  .mesh-cap-side-item { flex: 0 0 auto; width: auto; white-space: nowrap; }
  .mesh-cap-side-item .mesh-cap-side-ver { margin-left: 4px; }
  .mesh-cap-detail { padding: 18px 16px calc(20px + env(safe-area-inset-bottom, 0px)); }
}
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

/* ── 设置：VS Code 式分栏 ── */
.mesh-settings-page { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.mesh-settings-nav {
  flex: 0 0 224px; width: 224px; min-height: 0;
  display: flex; flex-direction: column;
  border-right: 1px solid var(--mesh-line); background: var(--mesh-surface);
}
.mesh-settings-nav-head { padding: 16px 14px 8px; }
.mesh-settings-nav-head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -.01em; }
.mesh-settings-nav-head p { margin: 3px 0 0; font-size: 10.5px; color: var(--mesh-muted); }
.mesh-settings-search { padding: 0 10px 8px; }
.mesh-settings-search .mesh-input { width: 100%; min-width: 0; height: 30px; padding: 5px 8px; font-size: 11.5px; }
.mesh-settings-navlist { flex: 1; min-height: 0; overflow-y: auto; padding: 0 6px 12px; }
.mesh-settings-navitem {
  position: relative;
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 7px 9px; border: 0; border-radius: 6px; background: transparent;
  color: var(--mesh-muted); font: inherit; font-size: 12px; text-align: left;
  cursor: pointer; white-space: nowrap;
  transition: background var(--mesh-dur-fast) var(--mesh-ease-out), color var(--mesh-dur-fast) var(--mesh-ease-out);
}
.mesh-settings-navitem::before {
  content: ""; position: absolute; left: -1px; top: 7px; bottom: 7px; width: 2px;
  border-radius: 2px; background: var(--mesh-accent);
  opacity: 0; transform: scaleY(.3); transform-origin: center;
  transition: opacity var(--mesh-dur-fast) var(--mesh-ease-out), transform var(--mesh-dur-fast) var(--mesh-ease-out);
}
.mesh-settings-navitem.is-active::before { opacity: 1; transform: scaleY(1); }
.mesh-settings-navitem:hover { background: var(--mesh-surface-2); color: var(--mesh-fg); }
.mesh-settings-navitem.is-active { background: var(--mesh-surface-2); color: var(--mesh-fg); }
.mesh-settings-navitem svg { flex: 0 0 auto; opacity: .85; }
.mesh-settings-nav-empty { padding: 10px; color: var(--mesh-muted); font-size: 11px; line-height: 1.5; }
.mesh-settings-content { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }
.mesh-settings-pane-wrap { animation: mesh-settings-pane-in var(--mesh-dur-base) var(--mesh-ease-out) both; }
.mesh-settings-pane { max-width: 820px; margin: 0 auto; padding: 22px 30px 64px; }
.mesh-settings-pane-title { margin: 0; font-size: 20px; line-height: 1.25; font-weight: 600; letter-spacing: -.02em; }
.mesh-settings-pane-desc { margin: 4px 0 20px; color: var(--mesh-muted); font-size: 11.5px; line-height: 1.6; }
.mesh-setting-group { margin-bottom: 24px; }
.mesh-setting-group-title {
  margin: 0 0 4px; color: var(--mesh-muted); font-size: 10.5px;
  font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
}
.mesh-setting-row {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 18px; padding: 11px 0; border-bottom: 1px solid var(--mesh-line);
}
.mesh-setting-row:last-child { border-bottom: 0; }
.mesh-setting-copy { flex: 1; min-width: 0; }
.mesh-setting-title { font-size: 12.5px; font-weight: 500; }
.mesh-setting-desc { margin-top: 2px; color: var(--mesh-muted); font-size: 11px; line-height: 1.55; }
.mesh-setting-control { flex: 0 0 auto; min-width: 150px; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.mesh-setting-value { color: var(--mesh-muted); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-align: right; overflow-wrap: anywhere; }
.mesh-setting-input { width: 220px; min-width: 160px; }
.mesh-select { cursor: pointer; }
textarea.mesh-setting-input { min-height: 54px; resize: vertical; }
.mesh-setting-block { padding: 12px 0; border-bottom: 1px solid var(--mesh-line); }
.mesh-setting-block:last-child { border-bottom: 0; }
.mesh-setting-block .mesh-me { margin-top: 8px; }
.mesh-settings-empty { padding: 48px 0; text-align: center; color: var(--mesh-muted); font-size: 12px; }
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
.mesh-me-avatar { width: 40px; height: 40px; border-radius: 12px; font-size: 15px; }
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
.mesh-mini-actions { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.mesh-mini-act {
  width: 28px; height: 28px; display: grid; place-items: center;
  border: 1px solid var(--mesh-line); border-radius: 7px;
  background: var(--mesh-surface); color: var(--mesh-muted); cursor: pointer;
}
.mesh-mini-act:active:not(:disabled) { transform: scale(0.95); }
.mesh-mini-act:disabled { opacity: .4; cursor: not-allowed; }
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
.mesh-empty-art {
  width: 180px; height: 96px; margin-bottom: 14px;
  color: var(--mesh-accent); opacity: .9;
}
.mesh-constellation { width: 100%; height: 100%; overflow: visible; }
.mesh-constellation-node {
  transform-box: fill-box; transform-origin: center;
  animation: mesh-node-pulse 3.6s var(--mesh-ease-out) infinite;
}
.mesh-constellation-node.n2 { animation-delay: .4s; }
.mesh-constellation-node.n3 { animation-delay: .8s; }
.mesh-constellation-node.n4 { animation-delay: 1.2s; }
.mesh-constellation-node.n5 { animation-delay: 1.6s; }
.mesh-constellation-node.n6 { animation-delay: 2s; }
.mesh-constellation-node.n7 { animation-delay: 2.4s; }
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
@keyframes mesh-node-pulse { 0%, 100% { opacity: .42; transform: scale(.88); } 50% { opacity: 1; transform: scale(1.12); } }
@keyframes mesh-settings-pane-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
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
  .mesh-panel-back { order: 0; height: 28px; padding: 0 8px 0 6px; font-size: 11.5px; }
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
  .mesh-settings-page { flex-direction: column; }
  .mesh-settings-nav {
    flex: 0 0 auto; width: 100%; border-right: 0;
    border-bottom: 1px solid var(--mesh-line);
  }
  .mesh-settings-nav-head { padding: 10px 14px 4px; }
  .mesh-settings-navlist {
    display: flex; gap: 4px; padding: 4px 8px 8px;
    overflow-x: auto; overflow-y: hidden;
    scrollbar-width: none;
  }
  .mesh-settings-navlist::-webkit-scrollbar { display: none; }
  .mesh-settings-navitem { flex: 0 0 auto; width: auto; white-space: nowrap; }
  .mesh-settings-content { flex: 1; }
  .mesh-settings-pane {
    padding: 14px calc(14px + var(--mesh-safe-left)) calc(40px + var(--mesh-safe-bottom)) calc(14px + var(--mesh-safe-right));
  }
  .mesh-setting-row { flex-direction: column; gap: 6px; }
  .mesh-setting-control { width: 100%; min-width: 0; justify-content: flex-start; }
  .mesh-setting-value { text-align: left; }
  .mesh-setting-input { width: 100%; min-width: 0; }
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
  .mesh-panel-back { touch-action: manipulation; }
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

/* ── P2b：窄屏（≤760px）单列设备卡 / 底部派发条 / 大触控 ──
   只在这里覆盖窄屏表现；宽屏样式完全不动（桌面回归靠 _selftest 断言）。
   断点必须与 client.js 的 MOBILE_MAX_WIDTH 保持一致。 */
@media (max-width: 760px) {
  /* 设备列表：一行一张卡片，单列铺满，触控目标 ≥64px */
  .mesh-list.is-narrow {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px 10px 16px;
  }
  .mesh-list.is-narrow .mesh-list-heading { margin: 6px 2px 0; }
  .mesh-list.is-narrow .mesh-list-empty { padding: 12px 4px; font-size: 12.5px; line-height: 1.65; }
  .mesh-list.is-narrow .mesh-row {
    min-height: 64px;
    padding: 12px;
    border: 1px solid var(--mesh-line);
    border-radius: 14px;
    background: var(--mesh-surface);
  }
  .mesh-list.is-narrow .mesh-row.is-active {
    border-color: var(--mesh-accent);
    background: var(--mesh-surface-2);
  }
  .mesh-list.is-narrow .mesh-row-name { font-size: 15px; }
  .mesh-list.is-narrow .mesh-row-sub { font-size: 11.5px; white-space: normal; }
  .mesh-list.is-narrow .mesh-list-actions .mesh-btn { min-height: 44px; }
  /* 小屏上在线状态 + transport(lan/usb) 用徽章明示（不只靠一列小字） */
  .mesh-row-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .mesh-row-badges .mesh-badge { height: 24px; padding: 0 8px; font-size: 11px; }

  /* 底部固定派发条：flex 子项（不是 absolute），内容区自动让出高度，不遮列表 */
  .mesh-mobile-bar-wrap {
    flex: 0 0 auto;
    position: relative;
    border-top: 1px solid var(--mesh-line);
    background: var(--mesh-bg);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .mesh-mobile-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px calc(12px + env(safe-area-inset-right, 0px)) 10px calc(12px + env(safe-area-inset-left, 0px));
  }
  .mesh-mobile-bar-meta {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--mesh-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mesh-mobile-bar .mesh-btn { min-height: 48px; border-radius: 12px; font-size: 14px; }
  .mesh-mobile-bar-panel {
    max-height: min(62dvh, 520px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--mesh-line);
    background: var(--mesh-surface);
  }
  .mesh-mobile-dispatch .mesh-dispatch { padding: 0; border: 0; background: transparent; }
  .mesh-mobile-dispatch .mesh-dispatch-text { min-height: 96px; font-size: 16px; }

  /* 设备详情：窄屏加大留白与触控，能力/端点/身份收进「详情」折叠 */
  .mesh-detail.is-narrow .mesh-h1 { font-size: 20px; }
  .mesh-detail.is-narrow .mesh-detail-actions { gap: 8px; }
  .mesh-detail.is-narrow .mesh-detail-actions .mesh-btn { flex: 1 1 0; min-height: 46px; justify-content: center; }
  .mesh-detail.is-narrow .mesh-fold-head { min-height: 44px; }
  .mesh-detail.is-narrow .mesh-meta { row-gap: 6px; }
  .mesh-detail.is-narrow .mesh-badge { height: 24px; padding: 0 8px; font-size: 11px; }
  .mesh-detail.is-narrow .mesh-section-head { flex-wrap: wrap; row-gap: 4px; }

  /* 空态/错误态：手机上一行放不下，放宽行高、留出底部条的安全距离 */
  .mesh-empty { padding-left: 16px; padding-right: 16px; }
  .mesh-error { padding-left: 16px; padding-right: 16px; }
  .mesh-home.is-narrow .mesh-home-grid { gap: 12px; }
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

    // ── 手机 / 窄屏适配（P2b）──
    /** 窄屏断点：必须与 CSS 里的 `@media (max-width: 760px)` 保持一致。 */
    const MOBILE_MAX_WIDTH = 760;

    /**
     * 当前是否窄屏（同步读取）。
     * 无 window / 无 matchMedia（SSR、旧宿主、单元测试）时按**宽屏**处理 ——
     * 桌面渲染必须是默认分支，不能因为探测环境缺失就掉进移动布局。
     */
    function isNarrowViewport() {
      try {
        if (typeof window === "undefined") return false;
        if (typeof window.matchMedia === "function") {
          return window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches === true;
        }
        const width = Number(window.innerWidth);
        return Number.isFinite(width) && width > 0 && width <= MOBILE_MAX_WIDTH;
      } catch {
        return false;
      }
    }

    /**
     * 订阅窄屏状态：首次渲染同步取值（桌面不会先闪一下移动布局），之后跟随
     * matchMedia change / resize 更新。宽屏返回 false，组件走原分支。
     */
    function useNarrowViewport() {
      const [narrow, setNarrow] = react.useState(isNarrowViewport);
      react.useEffect(() => {
        if (typeof window === "undefined") return undefined;
        const sync = () => setNarrow(isNarrowViewport());
        let mq = null;
        const onMedia = () => sync();
        try {
          if (typeof window.matchMedia === "function") {
            mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
            if (mq && typeof mq.addEventListener === "function") mq.addEventListener("change", onMedia);
            else if (mq && typeof mq.addListener === "function") mq.addListener(onMedia);
          }
          if (typeof window.addEventListener === "function") window.addEventListener("resize", sync);
        } catch {
          /* 宿主不支持事件订阅：只保留初始值 */
        }
        return () => {
          try {
            if (mq && typeof mq.removeEventListener === "function") mq.removeEventListener("change", onMedia);
            else if (mq && typeof mq.removeListener === "function") mq.removeListener(onMedia);
            if (typeof window.removeEventListener === "function") window.removeEventListener("resize", sync);
          } catch {
            /* ignore */
          }
        };
      }, []);
      return narrow;
    }

    /**
     * 窄屏设备行底部的 transport/状态徽章：把端点通道去重成
     * USB / 局域网 / 互联网，最多 3 个（小屏不刷屏）。
     * 宽屏不渲染这些徽章（DeviceRow 里按 narrow 分支），桌面外观不变。
     */
    function peerTransportBadges(peer) {
      const out = [];
      const push = (label, kind) => {
        if (!out.some((item) => item.label === label)) out.push({ label, kind });
      };
      const endpoints = Array.isArray(peer && peer.endpoints) ? peer.endpoints : [];
      for (const ep of endpoints) {
        const transport = String((ep && ep.transport) || "");
        if (transport === "usb") push("USB", "accent");
        else if (transport === "tsnet") push("互联网", "warn");
        else if (transport === "lan") push("局域网", "muted");
      }
      if (out.length === 0) {
        const transport = String((peer && peer.transport) || "");
        if (transport === "usb") push("USB", "accent");
        else if (transport === "tsnet") push("互联网", "warn");
        else if (transport === "lan") push("局域网", "muted");
      }
      return out.slice(0, 3);
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
        case "back":
          return [h("path", { key: "a", d: "M15 6l-6 6 6 6" })];
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
        case "node":
          return [
            h("path", { key: "a", d: "M12 2.7 20.4 7.4v9.2L12 21.3 3.6 16.6V7.4z" }),
            h("path", { key: "b", d: "M12 7.5v9" }),
          ];
        case "python":
          return [
            h("path", { key: "a", d: "M8.2 3h5.1A3.7 3.7 0 0 1 17 6.7v3.4H9.3A3.3 3.3 0 0 0 6 13.4v1.9" }),
            h("path", { key: "b", d: "M15.8 21h-5.1A3.7 3.7 0 0 1 7 17.3v-3.4h7.7a3.3 3.3 0 0 0 3.3-3.3v-1.9" }),
            h("circle", { key: "c", cx: 10, cy: 6.3, r: 1, fill: "currentColor", stroke: "none" }),
            h("circle", { key: "d", cx: 14, cy: 17.7, r: 1, fill: "currentColor", stroke: "none" }),
          ];
        case "go":
          return [
            h("circle", { key: "a", cx: 12, cy: 13, r: 6 }),
            h("circle", { key: "b", cx: 7.2, cy: 7.2, r: 2.4 }),
            h("circle", { key: "c", cx: 16.8, cy: 7.2, r: 2.4 }),
            h("circle", { key: "d", cx: 9.5, cy: 12, r: 0.9, fill: "currentColor", stroke: "none" }),
            h("circle", { key: "e", cx: 14.5, cy: 12, r: 0.9, fill: "currentColor", stroke: "none" }),
            h("path", { key: "f", d: "M10 16h4" }),
          ];
        case "docker":
          return [
            h("rect", { key: "a", x: 4.5, y: 10, width: 3, height: 3, rx: 0.4 }),
            h("rect", { key: "b", x: 9, y: 10, width: 3, height: 3, rx: 0.4 }),
            h("rect", { key: "c", x: 13.5, y: 10, width: 3, height: 3, rx: 0.4 }),
            h("rect", { key: "d", x: 7, y: 6, width: 3, height: 3, rx: 0.4 }),
            h("rect", { key: "e", x: 11.5, y: 6, width: 3, height: 3, rx: 0.4 }),
            h("path", { key: "f", d: "M3 15c0 2.2 2 4 4.5 4H16c2.8 0 5-1.8 5-4.2 0-.5-.4-.8-.9-.8H3.8c-.4 0-.8.4-.8 1z" }),
          ];
        case "git":
          return [
            h("circle", { key: "a", cx: 6, cy: 5, r: 2 }),
            h("circle", { key: "b", cx: 18, cy: 7, r: 2 }),
            h("circle", { key: "c", cx: 6, cy: 19, r: 2 }),
            h("path", { key: "d", d: "M6 7v10" }),
            h("path", { key: "e", d: "M16 8.5c-2 0-3 1.5-3 4v1c0 2.5-1 4-3 4" }),
          ];
        case "rust":
          return [
            h("circle", { key: "a", cx: 12, cy: 12, r: 4.2 }),
            h("path", { key: "b", d: "M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" }),
            h("path", { key: "c", d: "M10 11h2v4M14 11h-2" }),
          ];
        case "wsl":
          return [
            h("rect", { key: "a", x: 3, y: 4, width: 8, height: 7, rx: 0.6 }),
            h("rect", { key: "b", x: 13, y: 4, width: 8, height: 7, rx: 0.6 }),
            h("rect", { key: "c", x: 3, y: 13, width: 8, height: 7, rx: 0.6 }),
            h("rect", { key: "d", x: 13, y: 13, width: 8, height: 7, rx: 0.6 }),
          ];
        case "gpu":
          return [
            h("rect", { key: "a", x: 3, y: 6, width: 18, height: 11, rx: 2 }),
            h("circle", { key: "b", cx: 9, cy: 11.5, r: 2.4 }),
            h("path", { key: "c", d: "M14.5 9h3v5h-3z" }),
            h("path", { key: "d", d: "M7 17v3M17 17v3" }),
          ];
        case "code":
          return [
            h("path", { key: "a", d: "m8 8-4 4 4 4M16 8l4 4-4 4M13 5l-2 14" }),
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

    const DSHPATH =
      "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z";

    /** DSH 官方图标（来自 dist/favicon.svg 的单条 path），颜色跟随 currentColor。 */
    function DshMark({ size }) {
      return h(
        "svg",
        {
          width: size || 16,
          height: size || 16,
          viewBox: "0 0 50 50",
          fill: "none",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", { d: DSHPATH, fill: "currentColor" }),
      );
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

const BRAND_ICONS = {
  node: { color: "#5FA04E", path: "M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z" },
  python: { color: "#3776AB", path: "M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z" },
  go: { color: "#00ADD8", path: "M1.811 10.231c-.047 0-.058-.023-.035-.059l.246-.315c.023-.035.081-.058.128-.058h4.172c.046 0 .058.035.035.07l-.199.303c-.023.036-.082.07-.117.07zM.047 11.306c-.047 0-.059-.023-.035-.058l.245-.316c.023-.035.082-.058.129-.058h5.328c.047 0 .07.035.058.07l-.093.28c-.012.047-.058.07-.105.07zm2.828 1.075c-.047 0-.059-.035-.035-.07l.163-.292c.023-.035.07-.07.117-.07h2.337c.047 0 .07.035.07.082l-.023.28c0 .047-.047.082-.082.082zm12.129-2.36c-.736.187-1.239.327-1.963.514-.176.046-.187.058-.34-.117-.174-.199-.303-.327-.548-.444-.737-.362-1.45-.257-2.115.175-.795.514-1.204 1.274-1.192 2.22.011.935.654 1.706 1.577 1.835.795.105 1.46-.175 1.987-.77.105-.13.198-.27.315-.434H10.47c-.245 0-.304-.152-.222-.35.152-.362.432-.97.596-1.274a.315.315 0 01.292-.187h4.253c-.023.316-.023.631-.07.947a4.983 4.983 0 01-.958 2.29c-.841 1.11-1.94 1.8-3.33 1.986-1.145.152-2.209-.07-3.143-.77-.865-.655-1.356-1.52-1.484-2.595-.152-1.274.222-2.419.993-3.424.83-1.086 1.928-1.776 3.272-2.02 1.098-.2 2.15-.07 3.096.571.62.41 1.063.97 1.356 1.648.07.105.023.164-.117.2m3.868 6.461c-1.064-.024-2.034-.328-2.852-1.029a3.665 3.665 0 01-1.262-2.255c-.21-1.32.152-2.489.947-3.529.853-1.122 1.881-1.706 3.272-1.95 1.192-.21 2.314-.095 3.33.595.923.63 1.496 1.484 1.648 2.605.198 1.578-.257 2.863-1.344 3.962-.771.783-1.718 1.273-2.805 1.495-.315.06-.63.07-.934.106zm2.78-4.72c-.011-.153-.011-.27-.034-.387-.21-1.157-1.274-1.81-2.384-1.554-1.087.245-1.788.935-2.045 2.033-.21.912.234 1.835 1.075 2.21.643.28 1.285.244 1.905-.07.923-.48 1.425-1.228 1.484-2.233z" },
  docker: { color: "#2496ED", path: "M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" },
  git: { color: "#F05032", path: "M13.09 23.549a1.54 1.54 0 0 1-2.18 0L.451 13.089a1.54 1.54 0 0 1 0-2.179l7.191-7.19 2.733 2.733a1.85 1.85 0 0 0 .964 2.326v6.66a1.849 1.849 0 1 0 1.54 0V8.957l2.508 2.508a1.85 1.85 0 1 0 1.09-1.09l-2.634-2.634a1.85 1.85 0 0 0-2.378-2.377L8.73 2.63 10.91.451a1.54 1.54 0 0 1 2.179 0l10.459 10.46a1.54 1.54 0 0 1 0 2.179z" },
  rust: { color: "#CE422B", path: "M23.8346 11.7033l-1.0073-.6236a13.7268 13.7268 0 00-.0283-.2936l.8656-.8069a.3483.3483 0 00-.1154-.578l-1.1066-.414a8.4958 8.4958 0 00-.087-.2856l.6904-.9587a.3462.3462 0 00-.2257-.5446l-1.1663-.1894a9.3574 9.3574 0 00-.1407-.2622l.49-1.0761a.3437.3437 0 00-.0274-.3361.3486.3486 0 00-.3006-.154l-1.1845.0416a6.7444 6.7444 0 00-.1873-.2268l.2723-1.153a.3472.3472 0 00-.417-.4172l-1.1532.2724a14.0183 14.0183 0 00-.2278-.1873l.0415-1.1845a.3442.3442 0 00-.49-.328l-1.076.491c-.0872-.0476-.1742-.0952-.2623-.1407l-.1903-1.1673A.3483.3483 0 0016.256.955l-.9597.6905a8.4867 8.4867 0 00-.2855-.086l-.414-1.1066a.3483.3483 0 00-.5781-.1154l-.8069.8666a9.2936 9.2936 0 00-.2936-.0284L12.2946.1683a.3462.3462 0 00-.5892 0l-.6236 1.0073a13.7383 13.7383 0 00-.2936.0284L9.9803.3374a.3462.3462 0 00-.578.1154l-.4141 1.1065c-.0962.0274-.1903.0567-.2855.086L7.744.955a.3483.3483 0 00-.5447.2258L7.009 2.348a9.3574 9.3574 0 00-.2622.1407l-1.0762-.491a.3462.3462 0 00-.49.328l.0416 1.1845a7.9826 7.9826 0 00-.2278.1873L3.8413 3.425a.3472.3472 0 00-.4171.4171l.2713 1.1531c-.0628.075-.1255.1509-.1863.2268l-1.1845-.0415a.3462.3462 0 00-.328.49l.491 1.0761a9.167 9.167 0 00-.1407.2622l-1.1662.1894a.3483.3483 0 00-.2258.5446l.6904.9587a13.303 13.303 0 00-.087.2855l-1.1065.414a.3483.3483 0 00-.1155.5781l.8656.807a9.2936 9.2936 0 00-.0283.2935l-1.0073.6236a.3442.3442 0 000 .5892l1.0073.6236c.008.0982.0182.1964.0283.2936l-.8656.8079a.3462.3462 0 00.1155.578l1.1065.4141c.0273.0962.0567.1914.087.2855l-.6904.9587a.3452.3452 0 00.2268.5447l1.1662.1893c.0456.088.0922.1751.1408.2622l-.491 1.0762a.3462.3462 0 00.328.49l1.1834-.0415c.0618.0769.1235.1528.1873.2277l-.2713 1.1541a.3462.3462 0 00.4171.4161l1.153-.2713c.075.0638.151.1255.2279.1863l-.0415 1.1845a.3442.3442 0 00.49.327l1.0761-.49c.087.0486.1741.0951.2622.1407l.1903 1.1662a.3483.3483 0 00.5447.2268l.9587-.6904a9.299 9.299 0 00.2855.087l.414 1.1066a.3452.3452 0 00.5781.1154l.8079-.8656c.0972.0111.1954.0203.2936.0294l.6236 1.0073a.3472.3472 0 00.5892 0l.6236-1.0073c.0982-.0091.1964-.0183.2936-.0294l.8069.8656a.3483.3483 0 00.578-.1154l.4141-1.1066a8.4626 8.4626 0 00.2855-.087l.9587.6904a.3452.3452 0 00.5447-.2268l.1903-1.1662c.088-.0456.1751-.0931.2622-.1407l1.0762.49a.3472.3472 0 00.49-.327l-.0415-1.1845a6.7267 6.7267 0 00.2267-.1863l1.1531.2713a.3472.3472 0 00.4171-.416l-.2713-1.1542c.0628-.0749.1255-.1508.1863-.2278l1.1845.0415a.3442.3442 0 00.328-.49l-.49-1.076c.0475-.0872.0951-.1742.1407-.2623l1.1662-.1893a.3483.3483 0 00.2258-.5447l-.6904-.9587.087-.2855 1.1066-.414a.3462.3462 0 00.1154-.5781l-.8656-.8079c.0101-.0972.0202-.1954.0283-.2936l1.0073-.6236a.3442.3442 0 000-.5892zm-6.7413 8.3551a.7138.7138 0 01.2986-1.396.714.714 0 11-.2997 1.396zm-.3422-2.3142a.649.649 0 00-.7715.5l-.3573 1.6685c-1.1035.501-2.3285.7795-3.6193.7795a8.7368 8.7368 0 01-3.6951-.814l-.3574-1.6684a.648.648 0 00-.7714-.499l-1.473.3158a8.7216 8.7216 0 01-.7613-.898h7.1676c.081 0 .1356-.0141.1356-.088v-2.536c0-.074-.0536-.0881-.1356-.0881h-2.0966v-1.6077h2.2677c.2065 0 1.1065.0587 1.394 1.2088.0901.3533.2875 1.5044.4232 1.8729.1346.413.6833 1.2381 1.2685 1.2381h3.5716a.7492.7492 0 00.1296-.0131 8.7874 8.7874 0 01-.8119.9526zM6.8369 20.024a.714.714 0 11-.2997-1.396.714.714 0 01.2997 1.396zM4.1177 8.9972a.7137.7137 0 11-1.304.5791.7137.7137 0 011.304-.579zm-.8352 1.9813l1.5347-.6824a.65.65 0 00.33-.8585l-.3158-.7147h1.2432v5.6025H3.5669a8.7753 8.7753 0 01-.2834-3.348zm6.7343-.5437V8.7836h2.9601c.153 0 1.0792.1772 1.0792.8697 0 .575-.7107.7815-1.2948.7815zm10.7574 1.4862c0 .2187-.008.4363-.0243.651h-.9c-.09 0-.1265.0586-.1265.1477v.413c0 .973-.5487 1.1846-1.0296 1.2382-.4576.0517-.9648-.1913-1.0275-.4717-.2704-1.5186-.7198-1.8436-1.4305-2.4034.8817-.5599 1.799-1.386 1.799-2.4915 0-1.1936-.819-1.9458-1.3769-2.3153-.7825-.5163-1.6491-.6195-1.883-.6195H5.4682a8.7651 8.7651 0 014.907-2.7699l1.0974 1.151a.648.648 0 00.9182.0213l1.227-1.1743a8.7753 8.7753 0 016.0044 4.2762l-.8403 1.8982a.652.652 0 00.33.8585l1.6178.7188c.0283.2875.0425.577.0425.8717zm-9.3006-9.5993a.7128.7128 0 11.984 1.0316.7137.7137 0 01-.984-1.0316zm8.3389 6.71a.7107.7107 0 01.9395-.3625.7137.7137 0 11-.9405.3635z" },
  nvidia: { color: "#76B900", path: "M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z" },
  linux: { color: "#FCC624", path: "M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z" },
  openjdk: { color: "#ED8B00", path: "M11.915 0 11.7.215C9.515 2.4 7.47 6.39 6.046 10.483c-1.064 1.024-3.633 2.81-3.711 3.551-.093.87 1.746 2.611 1.55 3.235-.198.625-1.304 1.408-1.014 1.939.1.188.823.011 1.277-.491a13.389 13.389 0 0 0-.017 2.14c.076.906.27 1.668.643 2.232.372.563.956.911 1.667.911.397 0 .727-.114 1.024-.264.298-.149.571-.33.91-.5.68-.34 1.634-.666 3.53-.604 1.903.062 2.872.39 3.559.704.687.314 1.15.664 1.925.664.767 0 1.395-.336 1.807-.9.412-.563.631-1.33.72-2.24.06-.623.055-1.32 0-2.066.454.45 1.117.604 1.213.424.29-.53-.816-1.314-1.013-1.937-.198-.624 1.642-2.366 1.549-3.236-.08-.748-2.707-2.568-3.748-3.586C16.428 6.374 14.308 2.394 12.13.215zm.175 6.038a2.95 2.95 0 0 1 2.943 2.942 2.95 2.95 0 0 1-2.943 2.943A2.95 2.95 0 0 1 9.148 8.98a2.95 2.95 0 0 1 2.942-2.942zM8.685 7.983a3.515 3.515 0 0 0-.145.997c0 1.951 1.6 3.55 3.55 3.55 1.95 0 3.55-1.598 3.55-3.55 0-.329-.046-.648-.132-.951.334.095.64.208.915.336a42.699 42.699 0 0 1 2.042 5.829c.678 2.545 1.01 4.92.846 6.607-.082.844-.29 1.51-.606 1.94-.315.431-.713.651-1.315.651-.593 0-.932-.27-1.673-.61-.741-.338-1.825-.694-3.792-.758-1.974-.064-3.073.293-3.821.669-.375.188-.659.373-.911.5s-.466.2-.752.2c-.53 0-.876-.209-1.16-.64-.285-.43-.474-1.101-.545-1.948-.141-1.693.176-4.069.823-6.614a43.155 43.155 0 0 1 1.934-5.783c.348-.167.749-.31 1.192-.425zm-3.382 4.362a.216.216 0 0 1 .13.031c-.166.56-.323 1.116-.463 1.665a33.849 33.849 0 0 0-.547 2.555 3.9 3.9 0 0 0-.2-.39c-.58-1.012-.914-1.642-1.16-2.08.315-.24 1.679-1.755 2.24-1.781zm13.394.01c.562.027 1.926 1.543 2.24 1.783-.246.438-.58 1.068-1.16 2.08a4.428 4.428 0 0 0-.163.309 32.354 32.354 0 0 0-.562-2.49 40.579 40.579 0 0 0-.482-1.652.216.216 0 0 1 .127-.03z" },
  ruby: { color: "#CC342D", path: "M20.156.083c3.033.525 3.893 2.598 3.829 4.77L24 4.822 22.635 22.71 4.89 23.926h.016C3.433 23.864.15 23.729 0 19.139l1.645-3 2.819 6.586.503 1.172 2.805-9.144-.03.007.016-.03 9.255 2.956-1.396-5.431-.99-3.9 8.82-.569-.615-.51L16.5 2.114 20.159.073l-.003.01zM0 19.089zM5.13 5.073c3.561-3.533 8.157-5.621 9.922-3.84 1.762 1.777-.105 6.105-3.673 9.636-3.563 3.532-8.103 5.734-9.864 3.957-1.766-1.777.045-6.217 3.612-9.75l.003-.003z" },
  php: { color: "#777BB4", path: "M7.01 10.207h-.944l-.515 2.648h.838c.556 0 .97-.105 1.242-.314.272-.21.455-.559.55-1.049.092-.47.05-.802-.124-.995-.175-.193-.523-.29-1.047-.29zM12 5.688C5.373 5.688 0 8.514 0 12s5.373 6.313 12 6.313S24 15.486 24 12c0-3.486-5.373-6.312-12-6.312zm-3.26 7.451c-.261.25-.575.438-.917.551-.336.108-.765.164-1.285.164H5.357l-.327 1.681H3.652l1.23-6.326h2.65c.797 0 1.378.209 1.744.628.366.418.476 1.002.33 1.752a2.836 2.836 0 0 1-.305.847c-.143.255-.33.49-.561.703zm4.024.715l.543-2.799c.063-.318.039-.536-.068-.651-.107-.116-.336-.174-.687-.174H11.46l-.704 3.625H9.388l1.23-6.327h1.367l-.327 1.682h1.218c.767 0 1.295.134 1.586.401s.378.7.263 1.299l-.572 2.944h-1.389zm7.597-2.265a2.782 2.782 0 0 1-.305.847c-.143.255-.33.49-.561.703a2.44 2.44 0 0 1-.917.551c-.336.108-.765.164-1.286.164h-1.18l-.327 1.682h-1.378l1.23-6.326h2.649c.797 0 1.378.209 1.744.628.366.417.477 1.001.331 1.751zM17.766 10.207h-.943l-.516 2.648h.838c.557 0 .971-.105 1.242-.314.272-.21.455-.559.551-1.049.092-.47.049-.802-.125-.995s-.524-.29-1.047-.29z" },
  dotnet: { color: "#512BD4", path: "M24 8.77h-2.468v7.565h-1.425V8.77h-2.462V7.53H24zm-6.852 7.565h-4.821V7.53h4.63v1.24h-3.205v2.494h2.953v1.234h-2.953v2.604h3.396zm-6.708 0H8.882L4.78 9.863a2.896 2.896 0 0 1-.258-.51h-.036c.032.189.048.592.048 1.21v5.772H3.157V7.53h1.659l3.965 6.32c.167.261.275.442.323.54h.024c-.04-.233-.06-.629-.06-1.185V7.529h1.372zm-8.703-.693a.868.829 0 0 1-.869.829.868.829 0 0 1-.868-.83.868.829 0 0 1 .868-.828.868.829 0 0 1 .869.829Z" },
  kotlin: { color: "#7F52FF", path: "M24 24H0V0h24L12 12Z" },
  swift: { color: "#F05138", path: "M7.508 0c-.287 0-.573 0-.86.002-.241.002-.483.003-.724.01-.132.003-.263.009-.395.015A9.154 9.154 0 0 0 4.348.15 5.492 5.492 0 0 0 2.85.645 5.04 5.04 0 0 0 .645 2.848c-.245.48-.4.972-.495 1.5-.093.52-.122 1.05-.136 1.576a35.2 35.2 0 0 0-.012.724C0 6.935 0 7.221 0 7.508v8.984c0 .287 0 .575.002.862.002.24.005.481.012.722.014.526.043 1.057.136 1.576.095.528.25 1.02.495 1.5a5.03 5.03 0 0 0 2.205 2.203c.48.244.97.4 1.498.495.52.093 1.05.124 1.576.138.241.007.483.009.724.01.287.002.573.002.86.002h8.984c.287 0 .573 0 .86-.002.241-.001.483-.003.724-.01a10.523 10.523 0 0 0 1.578-.138 5.322 5.322 0 0 0 1.498-.495 5.035 5.035 0 0 0 2.203-2.203c.245-.48.4-.972.495-1.5.093-.52.124-1.05.138-1.576.007-.241.009-.481.01-.722.002-.287.002-.575.002-.862V7.508c0-.287 0-.573-.002-.86a33.662 33.662 0 0 0-.01-.724 10.5 10.5 0 0 0-.138-1.576 5.328 5.328 0 0 0-.495-1.5A5.039 5.039 0 0 0 21.152.645 5.32 5.32 0 0 0 19.654.15a10.493 10.493 0 0 0-1.578-.138 34.98 34.98 0 0 0-.722-.01C17.067 0 16.779 0 16.492 0H7.508zm6.035 3.41c4.114 2.47 6.545 7.162 5.549 11.131-.024.093-.05.181-.076.272l.002.001c2.062 2.538 1.5 5.258 1.236 4.745-1.072-2.086-3.066-1.568-4.088-1.043a6.803 6.803 0 0 1-.281.158l-.02.012-.002.002c-2.115 1.123-4.957 1.205-7.812-.022a12.568 12.568 0 0 1-5.64-4.838c.649.48 1.35.902 2.097 1.252 3.019 1.414 6.051 1.311 8.197-.002C9.651 12.73 7.101 9.67 5.146 7.191a10.628 10.628 0 0 1-1.005-1.384c2.34 2.142 6.038 4.83 7.365 5.576C8.69 8.408 6.208 4.743 6.324 4.86c4.436 4.47 8.528 6.996 8.528 6.996.154.085.27.154.36.213.085-.215.16-.437.224-.668.708-2.588-.09-5.548-1.893-7.992z" },
  bun: { color: "currentColor", path: "M12 22.596c6.628 0 12-4.338 12-9.688 0-3.318-2.057-6.248-5.219-7.986-1.286-.715-2.297-1.357-3.139-1.89C14.058 2.025 13.08 1.404 12 1.404c-1.097 0-2.334.785-3.966 1.821a49.92 49.92 0 0 1-2.816 1.697C2.057 6.66 0 9.59 0 12.908c0 5.35 5.372 9.687 12 9.687v.001ZM10.599 4.715c.334-.759.503-1.58.498-2.409 0-.145.202-.187.23-.029.658 2.783-.902 4.162-2.057 4.624-.124.048-.199-.121-.103-.209a5.763 5.763 0 0 0 1.432-1.977Zm2.058-.102a5.82 5.82 0 0 0-.782-2.306v-.016c-.069-.123.086-.263.185-.172 1.962 2.111 1.307 4.067.556 5.051-.082.103-.23-.003-.189-.126a5.85 5.85 0 0 0 .23-2.431Zm1.776-.561a5.727 5.727 0 0 0-1.612-1.806v-.014c-.112-.085-.024-.274.114-.218 2.595 1.087 2.774 3.18 2.459 4.407a.116.116 0 0 1-.049.071.11.11 0 0 1-.153-.026.122.122 0 0 1-.022-.083 5.891 5.891 0 0 0-.737-2.331Zm-5.087.561c-.617.546-1.282.76-2.063 1-.117 0-.195-.078-.156-.181 1.752-.909 2.376-1.649 2.999-2.778 0 0 .155-.118.188.085 0 .304-.349 1.329-.968 1.874Zm4.945 11.237a2.957 2.957 0 0 1-.937 1.553c-.346.346-.8.565-1.286.62a2.178 2.178 0 0 1-1.327-.62 2.955 2.955 0 0 1-.925-1.553.244.244 0 0 1 .064-.198.234.234 0 0 1 .193-.069h3.965a.226.226 0 0 1 .19.07c.05.053.073.125.063.197Zm-5.458-2.176a1.862 1.862 0 0 1-2.384-.245 1.98 1.98 0 0 1-.233-2.447c.207-.319.503-.566.848-.713a1.84 1.84 0 0 1 1.092-.11c.366.075.703.261.967.531a1.98 1.98 0 0 1 .408 2.114 1.931 1.931 0 0 1-.698.869v.001Zm8.495.005a1.86 1.86 0 0 1-2.381-.253 1.964 1.964 0 0 1-.547-1.366c0-.384.11-.76.32-1.079.207-.319.503-.567.849-.713a1.844 1.844 0 0 1 1.093-.108c.367.076.704.262.968.534a1.98 1.98 0 0 1 .4 2.117 1.932 1.932 0 0 1-.702.868Z" },
  deno: { color: "currentColor", path: "M1.105 18.02A11.9 11.9 0 0 1 0 12.985q0-.698.078-1.376a12 12 0 0 1 .231-1.34A12 12 0 0 1 4.025 4.02a12 12 0 0 1 5.46-2.771 12 12 0 0 1 3.428-.23c1.452.112 2.825.477 4.077 1.05a12 12 0 0 1 2.78 1.774 12.02 12.02 0 0 1 4.053 7.078A12 12 0 0 1 24 12.985q0 .454-.036.914a12 12 0 0 1-.728 3.305 12 12 0 0 1-2.38 3.875c-1.33 1.357-3.02 1.962-4.43 1.936a4.4 4.4 0 0 1-2.724-1.024c-.99-.853-1.391-1.83-1.53-2.919a5 5 0 0 1 .128-1.518c.105-.38.37-1.116.76-1.437-.455-.197-1.04-.624-1.226-.829-.045-.05-.04-.13 0-.183a.155.155 0 0 1 .177-.053c.392.134.869.267 1.372.35.66.111 1.484.25 2.317.292 2.03.1 4.153-.813 4.812-2.627s.403-3.609-1.96-4.685-3.454-2.356-5.363-3.128c-1.247-.505-2.636-.205-4.06.582-3.838 2.121-7.277 8.822-5.69 15.032a.191.191 0 0 1-.315.19 12 12 0 0 1-1.25-1.634 12 12 0 0 1-.769-1.404M11.57 6.087c.649-.051 1.214.501 1.31 1.236.13.979-.228 1.99-1.41 2.013-1.01.02-1.315-.997-1.248-1.614.066-.616.574-1.575 1.35-1.635" },
  npm: { color: "#CB3837", path: "M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" },
  pnpm: { color: "#F69220", path: "M0 0v7.5h7.5V0zm8.25 0v7.5h7.498V0zm8.25 0v7.5H24V0zM2 2h3.5v3.5H2zm8.25 0h3.498v3.5H10.25zm8.25 0H22v3.5h-3.5zM8.25 8.25v7.5h7.498v-7.5zm8.25 0v7.5H24v-7.5zm2 2H22v3.5h-3.5zM0 16.5V24h7.5v-7.5zm8.25 0V24h7.498v-7.5zm8.25 0V24H24v-7.5z" },
  yarn: { color: "#2C8EBB", path: "M12 0C5.375 0 0 5.375 0 12s5.375 12 12 12 12-5.375 12-12S18.625 0 12 0zm.768 4.105c.183 0 .363.053.525.157.125.083.287.185.755 1.154.31-.088.468-.042.551-.019.204.056.366.19.463.375.477.917.542 2.553.334 3.605-.241 1.232-.755 2.029-1.131 2.576.324.329.778.899 1.117 1.825.278.774.31 1.478.273 2.015a5.51 5.51 0 0 0 .602-.329c.593-.366 1.487-.917 2.553-.931.714-.009 1.269.445 1.353 1.103a1.23 1.23 0 0 1-.945 1.362c-.649.158-.95.278-1.821.843-1.232.797-2.539 1.242-3.012 1.39a1.686 1.686 0 0 1-.704.343c-.737.181-3.266.315-3.466.315h-.046c-.783 0-1.214-.241-1.45-.491-.658.329-1.51.19-2.122-.134a1.078 1.078 0 0 1-.58-1.153 1.243 1.243 0 0 1-.153-.195c-.162-.25-.528-.936-.454-1.946.056-.723.556-1.367.88-1.71a5.522 5.522 0 0 1 .408-2.256c.306-.727.885-1.348 1.32-1.737-.32-.537-.644-1.367-.329-2.21.227-.602.412-.936.82-1.08h-.005c.199-.074.389-.153.486-.259a3.418 3.418 0 0 1 2.298-1.103c.037-.093.079-.185.125-.283.31-.658.639-1.029 1.024-1.168a.94.94 0 0 1 .328-.06zm.006.7c-.507.016-1.001 1.519-1.001 1.519s-1.27-.204-2.266.871c-.199.218-.468.334-.746.44-.079.028-.176.023-.417.672-.371.991.625 2.094.625 2.094s-1.186.839-1.626 1.881c-.486 1.144-.338 2.261-.338 2.261s-.843.732-.899 1.487c-.051.663.139 1.2.343 1.515.227.343.51.176.51.176s-.561.653-.037.931c.477.25 1.283.394 1.71-.037.31-.31.371-1.001.486-1.283.028-.065.12.111.209.199.097.093.264.195.264.195s-.755.324-.445 1.066c.102.246.468.403 1.066.398.222-.005 2.664-.139 3.313-.296.375-.088.505-.283.505-.283s1.566-.431 2.998-1.357c.917-.598 1.293-.76 2.034-.936.612-.148.57-1.098-.241-1.084-.839.009-1.575.44-2.196.825-1.163.718-1.742.672-1.742.672l-.018-.032c-.079-.13.371-1.293-.134-2.678-.547-1.515-1.413-1.881-1.344-1.997.297-.5 1.038-1.297 1.334-2.78.176-.899.13-2.377-.269-3.151-.074-.144-.732.241-.732.241s-.616-1.371-.788-1.483a.271.271 0 0 0-.157-.046z" },
  ffmpeg: { color: "#007808", path: "M21.72 17.91V6.5l-.53-.49L9.05 18.52l-1.29-.06L24 1.53l-.33-.95-11.93 1-5.75 6.6v-.23l4.7-5.39-1.38-.77-9.11.77v2.85l1.91.46v.01l.19-.01-.56.66v10.6c.609-.126 1.22-.241 1.83-.36L14.12 5.22l.83-.04L0 21.44l9.67.82 1.35-.77 6.82-6.74v2.15l-5.72 5.57 11.26.95.35-.94v-3.16l-3.29-.18c.434-.403.858-.816 1.28-1.23z" },
  android: { color: "#34A853", path: "M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z" },
  bash: { color: "#4EAA25", path: "M21.038,4.9l-7.577-4.498C13.009,0.134,12.505,0,12,0c-0.505,0-1.009,0.134-1.462,0.403L2.961,4.9 C2.057,5.437,1.5,6.429,1.5,7.503v8.995c0,1.073,0.557,2.066,1.462,2.603l7.577,4.497C10.991,23.866,11.495,24,12,24 c0.505,0,1.009-0.134,1.461-0.402l7.577-4.497c0.904-0.537,1.462-1.529,1.462-2.603V7.503C22.5,6.429,21.943,5.437,21.038,4.9z M15.17,18.946l0.013,0.646c0.001,0.078-0.05,0.167-0.111,0.198l-0.383,0.22c-0.061,0.031-0.111-0.007-0.112-0.085L14.57,19.29 c-0.328,0.136-0.66,0.169-0.872,0.084c-0.04-0.016-0.057-0.075-0.041-0.142l0.139-0.584c0.011-0.046,0.036-0.092,0.069-0.121 c0.012-0.011,0.024-0.02,0.036-0.026c0.022-0.011,0.043-0.014,0.062-0.006c0.229,0.077,0.521,0.041,0.802-0.101 c0.357-0.181,0.596-0.545,0.592-0.907c-0.003-0.328-0.181-0.465-0.613-0.468c-0.55,0.001-1.064-0.107-1.072-0.917 c-0.007-0.667,0.34-1.361,0.889-1.8l-0.007-0.652c-0.001-0.08,0.048-0.168,0.111-0.2l0.37-0.236 c0.061-0.031,0.111,0.007,0.112,0.087l0.006,0.653c0.273-0.109,0.511-0.138,0.726-0.088c0.047,0.012,0.067,0.076,0.048,0.151 l-0.144,0.578c-0.011,0.044-0.036,0.088-0.065,0.116c-0.012,0.012-0.025,0.021-0.038,0.028c-0.019,0.01-0.038,0.013-0.057,0.009 c-0.098-0.022-0.332-0.073-0.699,0.113c-0.385,0.195-0.52,0.53-0.517,0.778c0.003,0.297,0.155,0.387,0.681,0.396 c0.7,0.012,1.003,0.318,1.01,1.023C16.105,17.747,15.736,18.491,15.17,18.946z M19.143,17.859c0,0.06-0.008,0.116-0.058,0.145 l-1.916,1.164c-0.05,0.029-0.09,0.004-0.09-0.056v-0.494c0-0.06,0.037-0.093,0.087-0.122l1.887-1.129 c0.05-0.029,0.09-0.004,0.09,0.056V17.859z M20.459,6.797l-7.168,4.427c-0.894,0.523-1.553,1.109-1.553,2.187v8.833 c0,0.645,0.26,1.063,0.66,1.184c-0.131,0.023-0.264,0.039-0.398,0.039c-0.42,0-0.833-0.114-1.197-0.33L3.226,18.64 c-0.741-0.44-1.201-1.261-1.201-2.142V7.503c0-0.881,0.46-1.702,1.201-2.142l7.577-4.498c0.363-0.216,0.777-0.33,1.197-0.33 c0.419,0,0.833,0.114,1.197,0.33l7.577,4.498c0.624,0.371,1.046,1.013,1.164,1.732C21.686,6.557,21.12,6.411,20.459,6.797z" },
  sqlite: { color: "currentColor", path: "M21.678.521c-1.032-.92-2.28-.55-3.513.544a8.71 8.71 0 0 0-.547.535c-2.109 2.237-4.066 6.38-4.674 9.544.237.48.422 1.093.544 1.561a13.044 13.044 0 0 1 .164.703s-.019-.071-.096-.296l-.05-.146a1.689 1.689 0 0 0-.033-.08c-.138-.32-.518-.995-.686-1.289-.143.423-.27.818-.376 1.176.484.884.778 2.4.778 2.4s-.025-.099-.147-.442c-.107-.303-.644-1.244-.772-1.464-.217.804-.304 1.346-.226 1.478.152.256.296.698.422 1.186.286 1.1.485 2.44.485 2.44l.017.224a22.41 22.41 0 0 0 .056 2.748c.095 1.146.273 2.13.5 2.657l.155-.084c-.334-1.038-.47-2.399-.41-3.967.09-2.398.642-5.29 1.661-8.304 1.723-4.55 4.113-8.201 6.3-9.945-1.993 1.8-4.692 7.63-5.5 9.788-.904 2.416-1.545 4.684-1.931 6.857.666-2.037 2.821-2.912 2.821-2.912s1.057-1.304 2.292-3.166c-.74.169-1.955.458-2.362.629-.6.251-.762.337-.762.337s1.945-1.184 3.613-1.72C21.695 7.9 24.195 2.767 21.678.521m-18.573.543A1.842 1.842 0 0 0 1.27 2.9v16.608a1.84 1.84 0 0 0 1.835 1.834h9.418a22.953 22.953 0 0 1-.052-2.707c-.006-.062-.011-.141-.016-.2a27.01 27.01 0 0 0-.473-2.378c-.121-.47-.275-.898-.369-1.057-.116-.197-.098-.31-.097-.432 0-.12.015-.245.037-.386a9.98 9.98 0 0 1 .234-1.045l.217-.028c-.017-.035-.014-.065-.031-.097l-.041-.381a32.8 32.8 0 0 1 .382-1.194l.2-.019c-.008-.016-.01-.038-.018-.053l-.043-.316c.63-3.28 2.587-7.443 4.8-9.791.066-.069.133-.128.198-.194Z" },
  postgresql: { color: "#4169E1", path: "M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z" },
  mysql: { color: "#4479A1", path: "M16.405 5.501c-.115 0-.193.014-.274.033v.013h.014c.054.104.146.18.214.273.054.107.1.214.154.32l.014-.015c.094-.066.14-.172.14-.333-.04-.047-.046-.094-.08-.14-.04-.067-.126-.1-.18-.153zM5.77 18.695h-.927a50.854 50.854 0 00-.27-4.41h-.008l-1.41 4.41H2.45l-1.4-4.41h-.01a72.892 72.892 0 00-.195 4.41H0c.055-1.966.192-3.81.41-5.53h1.15l1.335 4.064h.008l1.347-4.064h1.095c.242 2.015.384 3.86.428 5.53zm4.017-4.08c-.378 2.045-.876 3.533-1.492 4.46-.482.716-1.01 1.073-1.583 1.073-.153 0-.34-.046-.566-.138v-.494c.11.017.24.026.386.026.268 0 .483-.075.647-.222.197-.18.295-.382.295-.605 0-.155-.077-.47-.23-.944L6.23 14.615h.91l.727 2.36c.164.536.233.91.205 1.123.4-1.064.678-2.227.835-3.483zm12.325 4.08h-2.63v-5.53h.885v4.85h1.745zm-3.32.135l-1.016-.5c.09-.076.177-.158.255-.25.433-.506.648-1.258.648-2.253 0-1.83-.718-2.746-2.155-2.746-.704 0-1.254.232-1.65.697-.43.508-.646 1.256-.646 2.245 0 .972.19 1.686.574 2.14.35.41.877.615 1.583.615.264 0 .506-.033.725-.098l1.325.772.36-.622zM15.5 17.588c-.225-.36-.337-.94-.337-1.736 0-1.393.424-2.09 1.27-2.09.443 0 .77.167.977.5.224.362.336.936.336 1.723 0 1.404-.424 2.108-1.27 2.108-.445 0-.77-.167-.978-.5zm-1.658-.425c0 .47-.172.856-.516 1.156-.344.3-.803.45-1.384.45-.543 0-1.064-.172-1.573-.515l.237-.476c.438.22.833.328 1.19.328.332 0 .593-.073.783-.22a.754.754 0 00.3-.615c0-.33-.23-.61-.648-.845-.388-.213-1.163-.657-1.163-.657-.422-.307-.632-.636-.632-1.177 0-.45.157-.81.47-1.085.315-.278.72-.415 1.22-.415.512 0 .98.136 1.4.41l-.213.476a2.726 2.726 0 00-1.064-.23c-.283 0-.502.068-.654.206a.685.685 0 00-.248.524c0 .328.234.61.666.85.393.215 1.187.67 1.187.67.433.305.648.63.648 1.168zm9.382-5.852c-.535-.014-.95.04-1.297.188-.1.04-.26.04-.274.167.055.053.063.14.11.214.08.134.218.313.346.407.14.11.28.216.427.31.26.16.555.255.81.416.145.094.293.213.44.313.073.05.12.14.214.172v-.02c-.046-.06-.06-.147-.105-.214-.067-.067-.134-.127-.2-.193a3.223 3.223 0 00-.695-.675c-.214-.146-.682-.35-.77-.595l-.013-.014c.146-.013.32-.066.46-.106.227-.06.435-.047.67-.106.106-.027.213-.06.32-.094v-.06c-.12-.12-.21-.283-.334-.395a8.867 8.867 0 00-1.104-.823c-.21-.134-.476-.22-.697-.334-.08-.04-.214-.06-.26-.127-.12-.146-.19-.34-.275-.514a17.69 17.69 0 01-.547-1.163c-.12-.262-.193-.523-.34-.763-.69-1.137-1.437-1.826-2.586-2.5-.247-.14-.543-.2-.856-.274-.167-.008-.334-.02-.5-.027-.11-.047-.216-.174-.31-.235-.38-.24-1.364-.76-1.644-.072-.18.434.267.862.422 1.082.115.153.26.328.34.5.047.116.06.235.107.356.106.294.207.622.347.897.073.14.153.287.247.413.054.073.146.107.167.227-.094.136-.1.334-.154.5-.24.757-.146 1.693.194 2.25.107.166.362.534.703.393.3-.12.234-.5.32-.835.02-.08.007-.133.048-.187v.015c.094.188.188.367.274.555.206.328.566.668.867.895.16.12.287.328.487.402v-.02h-.015c-.043-.058-.1-.086-.154-.133a3.445 3.445 0 01-.35-.4 8.76 8.76 0 01-.747-1.218c-.11-.21-.202-.436-.29-.643-.04-.08-.04-.2-.107-.24-.1.146-.247.273-.32.453-.127.288-.14.642-.188 1.01-.027.007-.014 0-.027.014-.214-.052-.287-.274-.367-.46-.2-.475-.233-1.238-.06-1.785.047-.14.247-.582.167-.716-.042-.127-.174-.2-.247-.303a2.478 2.478 0 01-.24-.427c-.16-.374-.24-.788-.414-1.162-.08-.173-.22-.354-.334-.513-.127-.18-.267-.307-.368-.52-.033-.073-.08-.194-.027-.274.014-.054.042-.075.094-.09.088-.072.335.022.422.062.247.1.455.194.662.334.094.066.195.193.315.226h.14c.214.047.455.014.655.073.355.114.675.28.962.46a5.953 5.953 0 012.085 2.286c.08.154.115.295.188.455.14.33.313.663.455.982.14.315.275.636.476.897.1.14.502.213.682.286.133.06.34.115.46.188.23.14.454.3.67.454.11.076.443.243.463.378z" },
  redis: { color: "#DC382D", path: "M22.71 13.145c-1.66 2.092-3.452 4.483-7.038 4.483-3.203 0-4.397-2.825-4.48-5.12.701 1.484 2.073 2.685 4.214 2.63 4.117-.133 6.94-3.852 6.94-7.239 0-4.05-3.022-6.972-8.268-6.972-3.752 0-8.4 1.428-11.455 3.685C2.59 6.937 3.885 9.958 4.35 9.626c2.648-1.904 4.748-3.13 6.784-3.744C8.12 9.244.886 17.05 0 18.425c.1 1.261 1.66 4.648 2.424 4.648.232 0 .431-.133.664-.365a100.49 100.49 0 0 0 5.54-6.765c.222 3.104 1.748 6.898 6.014 6.898 3.819 0 7.604-2.756 9.33-8.965.2-.764-.73-1.361-1.261-.73zm-4.349-5.013c0 1.959-1.926 2.922-3.685 2.922-.941 0-1.664-.247-2.235-.568 1.051-1.592 2.092-3.225 3.21-4.973 1.972.334 2.71 1.43 2.71 2.619z" },
  nginx: { color: "#009639", path: "M12 0L1.605 6v12L12 24l10.395-6V6L12 0zm6 16.59c0 .705-.646 1.29-1.529 1.29-.631 0-1.351-.255-1.801-.81l-6-7.141v6.66c0 .721-.57 1.29-1.274 1.29H7.32c-.721 0-1.29-.6-1.29-1.29V7.41c0-.705.63-1.29 1.5-1.29.646 0 1.38.255 1.83.81l5.97 7.141V7.41c0-.721.6-1.29 1.29-1.29h.075c.72 0 1.29.6 1.29 1.29v9.18H18z" },
  cplusplus: { color: "#00599C", path: "M22.394 6c-.167-.29-.398-.543-.652-.69L12.926.22c-.509-.294-1.34-.294-1.848 0L2.26 5.31c-.508.293-.923 1.013-.923 1.6v10.18c0 .294.104.62.271.91.167.29.398.543.652.69l8.816 5.09c.508.293 1.34.293 1.848 0l8.816-5.09c.254-.147.485-.4.652-.69.167-.29.27-.616.27-.91V6.91c.003-.294-.1-.62-.268-.91zM12 19.11c-3.92 0-7.109-3.19-7.109-7.11 0-3.92 3.19-7.11 7.11-7.11a7.133 7.133 0 016.156 3.553l-3.076 1.78a3.567 3.567 0 00-3.08-1.78A3.56 3.56 0 008.444 12 3.56 3.56 0 0012 15.555a3.57 3.57 0 003.08-1.778l3.078 1.78A7.135 7.135 0 0112 19.11zm7.11-6.715h-.79v.79h-.79v-.79h-.79v-.79h.79v-.79h.79v.79h.79zm2.962 0h-.79v.79h-.79v-.79h-.79v-.79h.79v-.79h.79v.79h.79z" },
  cmake: { color: "#064F8C", path: "M11.769.066L.067 23.206l12.76-10.843zM23.207 23.934L7.471 17.587 0 23.934zM24 23.736L12.298.463l1.719 19.24zM12.893 12.959l-5.025 4.298 5.62 2.248z" },
  gradle: { color: "currentColor", path: "M22.695 4.297a3.807 3.807 0 0 0-5.29-.09.368.368 0 0 0 0 .533l.46.47a.363.363 0 0 0 .474.032 2.182 2.182 0 0 1 2.86 3.291c-3.023 3.02-7.056-5.447-16.211-1.083a1.24 1.24 0 0 0-.534 1.745l1.571 2.713a1.238 1.238 0 0 0 1.681.461l.037-.02-.029.02.688-.384a16.083 16.083 0 0 0 2.193-1.635.384.384 0 0 1 .499-.016.357.357 0 0 1 .016.534 16.435 16.435 0 0 1-2.316 1.741H8.77l-.696.39a1.958 1.958 0 0 1-.963.25 1.987 1.987 0 0 1-1.726-.989L3.9 9.696C1.06 11.72-.686 15.603.26 20.522a.363.363 0 0 0 .354.296h1.675a.363.363 0 0 0 .37-.331 2.478 2.478 0 0 1 4.915 0 .36.36 0 0 0 .357.317h1.638a.363.363 0 0 0 .357-.317 2.478 2.478 0 0 1 4.914 0 .363.363 0 0 0 .358.317h1.627a.363.363 0 0 0 .363-.357c.037-2.294.656-4.93 2.42-6.25 6.108-4.57 4.502-8.486 3.088-9.9zm-6.229 6.901l-1.165-.584a.73.73 0 1 1 1.165.587z" },
  apachemaven: { color: "#C71A36", path: "M4.237.001c-.312-.013-.665.072-.828.457-.158.374-.283 1.188-.34 2.276l1.223.591c-.02-.737.007-1.43.076-2.066-.026.299-.056.96.006 2.039.019.342.049.725.088 1.15.002.024.002.047.007.069a45.485 45.485 0 0 0 .309 2.412c.057.368.126.752.195 1.16l-.01.01c.014.01.015.018.014.023l.03.16c.03.162.06.328.093.494l.108.553.056.289a61.72 61.72 0 0 0 .457 2.068c.09.382.186.78.287 1.186.098.386.199.783.309 1.193.096.362.199.735.303 1.117.003.018.012.036.015.055a145.826 145.826 0 0 0 .34 1.185l.049.174c.078.261.158.533.242.805a4.2 4.2 0 0 1-.293-.135l-.19-.654c-.02-.077-.042-.148-.062-.225l-.002-.004-.004-.002c-.087-.3-.17-.607-.257-.916-.023-.087-.044-.173-.069-.263l-.314-1.178c-.1-.381-.194-.765-.29-1.154-.094-.39-.185-.78-.277-1.172-.093-.401-.181-.8-.265-1.203-.085-.396-.161-.798-.24-1.193a50.315 50.315 0 0 1-.211-1.17c-.004-.013-.006-.03-.01-.041l.004-.002c-.057-.386-.116-.77-.174-1.15a60.905 60.905 0 0 1-.154-1.204 27.447 27.447 0 0 1-.172-2.41l-1.22-.59c-.004.074-.01.15-.013.23-.012.294-.02.605-.023.93a45.3 45.3 0 0 0 .006 1.157c.009.37.025.755.045 1.148.02.336.042.675.07 1.022l.002.039.006.004c.003.023.007.05.006.076.033.368.064.739.107 1.115a34.493 34.493 0 0 0 .303 2.125c.01.064.024.131.035.195a23.418 23.418 0 0 0 .547 2.32c.07.237.14.464.21.68.063.182.13.365.194.545.155.422.327.832.512 1.232l.006.004a.318.318 0 0 0 .02.05c.225.485.475.95.755 1.395.01.013.02.033.03.047-.455-.183-1.259-.098-1.253-.097.83.288 1.557.64 2.016 1.175-.183.2-.523.352-.953.477.594.064.924-.039 1.045-.092-.31.26-.483.732-.635 1.24.35-.57.696-.949 1.033-1.094.078.258.162.524.244.788A147.532 147.532 0 0 0 5.157 24a.56.56 0 0 0 .43-.312c.13-.282.83-1.775 1.908-3.875.413 1.303.88 2.679 1.386 4.109a.494.494 0 0 0 .076-.465 103.735 103.735 0 0 1-1.308-3.945c.154-.299.316-.612.484-.932.125.04.255.094.389.155.203.186.352.491.482.84a1.515 1.515 0 0 0-.334-1.098c1.335.258 2.547.09 3.287-.81a3.97 3.97 0 0 0 .192-.258c-.325.304-.682.404-1.313.273.996-.281 1.523-.617 2.035-1.22.12-.145.244-.303.371-.48-.943.722-1.927.822-2.9.493l-.045-.018c.914.02 2.203-.474 3.092-1.189.41-.33.796-.73 1.17-1.21.28-.359.55-.76.82-1.216.234-.393.468-.824.7-1.293a2.83 2.83 0 0 1-.74.137l-.144.008c-.048.002-.093 0-.146.002.885-.198 1.5-.74 1.994-1.447-.24.117-.628.262-1.07.297-.058.006-.12.006-.182.006-.013-.002-.028 0-.047-.002.306-.078.574-.178.81-.309a3.363 3.363 0 0 0 .358-.236c.044-.037.088-.07.13-.106.099-.086.193-.18.28-.287.028-.034.056-.063.08-.098.036-.05.073-.098.104-.146a8.388 8.388 0 0 0 .51-.828c.015-.031.032-.057.046-.088.04-.084.08-.16.11-.227.042-.099.074-.179.092-.238a.515.515 0 0 1-.108.051c-.273.112-.727.187-1.086.201-.004 0-.008 0-.013.004h-.067c.72-.214 1.067-.45 1.422-.818a13.883 13.883 0 0 0 1.154-1.428c.264-.37.505-.738.692-1.072a6.5 6.5 0 0 0 .298-.592c.066-.157.122-.305.172-.45-.466.01-.986.011-1.48 0 .495.01 1.015.007 1.484-.005.5-1.485.063-2.262.063-2.262s-.526-1.212-1.4-.851c-.426.175-1.172.73-2.083 1.56l.514 1.45a17.561 17.561 0 0 1 1.703-1.602c-.257.22-.807.726-1.615 1.644-.256.29-.537.624-.844.997-.017.02-.035.038-.047.06a51.435 51.435 0 0 0-1.666 2.187c-.248.34-.498.704-.765 1.088h-.016c.002.02-.004.028-.01.032l-.101.152c-.104.155-.213.31-.318.47l-.352.534c-.061.09-.124.181-.186.277-.184.282-.367.573-.558.873a97.351 97.351 0 0 0-1.428 2.338 96.866 96.866 0 0 0-1.341 2.343c-.012.017-.02.04-.034.057a197.256 197.256 0 0 0-.668 1.223l-.097.181c-.17.318-.346.642-.52.979 0 .004-.005.008-.006.013-.026.048-.05.093-.072.141-.117.222-.218.424-.45.87a1.352 1.352 0 0 0-.233-.182l.345-.65c.047-.089.096-.177.143-.27l.04-.077.546-1.001.13-.233v-.006l-.001-.006c.169-.31.345-.62.52-.94.051-.087.102-.173.153-.265.224-.395.454-.794.684-1.197a91.685 91.685 0 0 1 2.135-3.504c.247-.386.503-.77.754-1.152.092-.138.182-.272.279-.41a72.9 72.9 0 0 1 .48-.701c.007-.012.019-.024.026-.037h.006c.26-.356.517-.713.773-1.065.278-.373.554-.735.83-1.09a31.075 31.075 0 0 1 1.777-2.075l-.515-1.446c-.06.057-.126.116-.192.178a32.37 32.37 0 0 0-.758.729c-.295.294-.597.606-.912.935a46.032 46.032 0 0 0-1.632 1.838l-.03.033.002.008c-.017.02-.033.044-.054.064-.266.323-.538.649-.801.985a39.105 39.105 0 0 0-1.445 1.95c-.043.06-.085.126-.127.186a26.458 26.458 0 0 0-1.403 2.303c-.13.247-.256.485-.37.715-.096.195-.187.395-.278.591-.21.463-.398.93-.566 1.399l.002.006a.36.36 0 0 0-.026.058c-.108.303-.203.608-.29.914-.14.174-.302.325-.483.46a3.505 3.505 0 0 0-.131-.153 5.148 5.148 0 0 0 .824-2.211 6.4 6.4 0 0 0-.016-1.488c-.046-.4-.126-.82-.238-1.274-.097-.393-.217-.81-.363-1.248-.091.185-.22.367-.379.545l-.086.094c-.029.032-.06.06-.092.094.434-.674.486-1.397.358-2.148a2.722 2.722 0 0 1-.49.85c-.033.038-.072.077-.11.116-.01.007-.019.018-.033.028.144-.24.25-.467.318-.698a1.29 1.29 0 0 0 .04-.146 2.85 2.85 0 0 0 .038-.225l.018-.146a2.11 2.11 0 0 0-.002-.354c-.003-.04-.004-.076-.01-.113-.01-.055-.016-.105-.027-.154a7.416 7.416 0 0 0-.193-.84c-.01-.028-.015-.056-.026-.084-.027-.079-.048-.149-.072-.209a2.1 2.1 0 0 0-.09-.209.455.455 0 0 1-.035.1c-.102.24-.34.57-.557.8-.003.003-.007.005-.007.01l-.04.043c.318-.58.39-.946.385-1.398a12.274 12.274 0 0 0-.16-1.615 10.68 10.68 0 0 0-.232-1.104 5.853 5.853 0 0 0-.18-.558 6.337 6.337 0 0 0-.172-.391 26.18 26.18 0 0 0 .002-.004C5.576.341 4.82.124 4.82.124s-.27-.11-.582-.123zm3.38 15.783l.032.082v.002c-.06.033-.116.067-.178.097-.012.004-.024.012-.039.018a2.41 2.41 0 0 0 .186-.2zm-.603 1.626c.13.136.25.242.354.32l.07.227a1.866 1.866 0 0 0-.246.053l-.03-.098c-.024-.084-.048-.17-.076-.257l-.021-.073zm.26.875a2.34 2.34 0 0 1 .271.01l.07.229a.778.778 0 0 1 .247-.004l-.326.627a127.643 127.643 0 0 1-.262-.862z" },
  amd: { color: "#ED1C24", path: "M18.324 9.137l1.559 1.56h2.556v2.557L24 14.814V9.137zM2 9.52l-2 4.96h1.309l.37-.982H3.9l.408.982h1.338L3.432 9.52zm4.209 0v4.955h1.238v-3.092l1.338 1.562h.188l1.338-1.556v3.091h1.238V9.52H10.47l-1.592 1.845L7.287 9.52zm6.283 0v4.96h2.057c1.979 0 2.88-1.046 2.88-2.472 0-1.36-.937-2.488-2.747-2.488zm1.237.91h.792c1.17 0 1.63.711 1.63 1.57 0 .728-.372 1.572-1.616 1.572h-.806zm-10.985.273l.791 1.932H2.008zm17.137.307l-1.604 1.603v2.25h2.246l1.604-1.607h-2.246z" },
  intel: { color: "#0071C5", path: "M20.42 7.345v9.18h1.651v-9.18zM0 7.475v1.737h1.737V7.474zm9.78.352v6.053c0 .513.044.945.13 1.292.087.34.235.618.44.828.203.21.475.359.803.451.334.093.754.136 1.255.136h.216v-1.533c-.24 0-.445-.012-.593-.037a.672.672 0 0 1-.39-.173.693.693 0 0 1-.173-.377 4.002 4.002 0 0 1-.037-.606v-2.182h1.193v-1.416h-1.193V7.827zm-3.505 2.312c-.396 0-.76.08-1.082.241-.327.161-.6.384-.822.668l-.087.117v-.902H2.658v6.256h1.639v-3.214c.018-.588.16-1.02.433-1.299.29-.297.642-.445 1.044-.445.476 0 .841.149 1.082.433.235.284.359.686.359 1.2v3.324h1.663V12.97c.006-.89-.229-1.595-.686-2.09-.458-.495-1.1-.742-1.917-.742zm10.065.006a3.252 3.252 0 0 0-2.306.946c-.29.29-.525.637-.692 1.033a3.145 3.145 0 0 0-.254 1.273c0 .452.08.878.241 1.274.161.395.39.742.674 1.032.284.29.637.526 1.045.693.408.173.86.26 1.342.26 1.397 0 2.262-.637 2.782-1.23l-1.187-.904c-.248.297-.841.699-1.583.699-.464 0-.847-.105-1.138-.321a1.588 1.588 0 0 1-.593-.872l-.019-.056h4.915v-.587c0-.451-.08-.872-.235-1.267a3.393 3.393 0 0 0-.661-1.033 3.013 3.013 0 0 0-1.02-.692 3.345 3.345 0 0 0-1.311-.248zm-16.297.118v6.256h1.651v-6.256zm16.278 1.286c1.132 0 1.664.797 1.664 1.255l-3.32.006c0-.458.525-1.255 1.656-1.261zm7.073 3.814a.606.606 0 0 0-.606.606.606.606 0 0 0 .606.606.606.606 0 0 0 .606-.606.606.606 0 0 0-.606-.606zm-.008.105a.5.5 0 0 1 .002 0 .5.5 0 0 1 .5.501.5.5 0 0 1-.5.5.5.5 0 0 1-.5-.5.5.5 0 0 1 .498-.5zm-.233.155v.699h.13v-.285h.093l.173.285h.136l-.18-.297a.191.191 0 0 0 .118-.056c.03-.03.05-.074.05-.136 0-.068-.02-.117-.063-.154-.037-.038-.105-.056-.185-.056zm.13.099h.154c.019 0 .037.006.056.012a.064.064 0 0 1 .037.031c.013.013.012.031.012.056a.124.124 0 0 1-.012.055.164.164 0 0 1-.037.031c-.019.006-.037.013-.056.013h-.154Z" },
  apple: { color: "currentColor", path: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" },
  dart: { color: "#0175C2", path: "M4.105 4.105S9.158 1.58 11.684.316a3.079 3.079 0 0 1 1.481-.315c.766.047 1.677.788 1.677.788L24 9.948v9.789h-4.263V24H9.789l-9-9C.303 14.5 0 13.795 0 13.105c0-.319.18-.818.316-1.105l3.789-7.895zm.679.679v11.787c.002.543.021 1.024.498 1.508L10.204 23h8.533v-4.263L4.784 4.784zm12.055-.678c-.899-.896-1.809-1.78-2.74-2.643-.302-.267-.567-.468-1.07-.462-.37.014-.87.195-.87.195L6.341 4.105l10.498.001z" },
  lua: { color: "#2C2D72", path: "M.38 10.377l-.272-.037c-.048.344-.082.695-.101 1.041l.275.016c.018-.34.051-.682.098-1.02zM4.136 3.289l-.184-.205c-.258.232-.509.48-.746.734l.202.188c.231-.248.476-.49.728-.717zM5.769 2.059l-.146-.235c-.296.186-.586.385-.863.594l.166.219c.27-.203.554-.399.843-.578zM1.824 18.369c.185.297.384.586.593.863l.22-.164c-.205-.271-.399-.555-.58-.844l-.233.145zM1.127 16.402l-.255.104c.129.318.274.635.431.943l.005.01.245-.125-.005-.01c-.153-.301-.295-.611-.421-.922zM.298 9.309l.269.063c.076-.332.168-.664.272-.986l-.261-.087c-.108.332-.202.672-.28 1.01zM.274 12.42l-.275.01c.012.348.04.699.083 1.043l.273-.033c-.042-.336-.069-.68-.081-1.02zM.256 14.506c.073.34.162.682.264 1.014l.263-.08c-.1-.326-.187-.658-.258-.99l-.269.056zM11.573.275L11.563 0c-.348.012-.699.039-1.044.082l.034.273c.338-.041.68-.068 1.02-.08zM23.221 8.566c.1.326.186.66.256.992l.27-.059c-.072-.34-.16-.682-.262-1.014l-.264.081zM17.621 1.389c-.309-.164-.627-.314-.947-.449l-.107.252c.314.133.625.281.926.439l.128-.242zM15.693.572c-.332-.105-.67-.199-1.01-.277l-.063.268c.332.076.664.168.988.273l.085-.264zM6.674 1.545c.298-.15.606-.291.916-.418L7.486.873c-.317.127-.632.272-.937.428l-.015.008.125.244.015-.008zM23.727 11.588l.275-.01a11.797 11.797 0 0 0-.082-1.045l-.273.033c.041.338.068.682.08 1.022zM13.654.105c-.346-.047-.696-.08-1.043-.098l-.014.273c.339.018.683.051 1.019.098l.038-.273zM9.544.527l-.058-.27c-.34.072-.681.16-1.014.264l.081.262c.325-.099.659-.185.991-.256zM1.921 5.469l.231.15c.185-.285.384-.566.592-.834l-.217-.17c-.213.276-.417.563-.606.854zM.943 7.318l.253.107c.132-.313.28-.625.439-.924l-.243-.128c-.163.307-.314.625-.449.945zM18.223 21.943l.145.234c.295-.186.586-.385.863-.594l-.164-.219c-.272.204-.557.4-.844.579zM21.248 19.219l.217.17c.215-.273.418-.561.607-.854l-.23-.148c-.186.285-.385.564-.594.832zM19.855 20.715l.184.203c.258-.23.51-.479.746-.732l-.201-.188c-.23.248-.477.488-.729.717zM22.359 17.504l.244.129c.162-.307.314-.625.449-.945l-.254-.107a11.27 11.27 0 0 1-.439.923zM23.617 13.629l.273.039c.049-.346.082-.695.102-1.043l-.275-.014c-.018.338-.051.682-.1 1.018zM23.156 15.621l.264.086c.107-.332.201-.67.279-1.01l-.268-.063c-.077.333-.169.665-.275.987zM22.453 6.672c.154.303.297.617.424.932l.256-.104c-.131-.322-.277-.643-.436-.953l-.244.125zM8.296 23.418c.331.107.67.201 1.009.279l.062-.268c-.331-.076-.663-.168-.986-.273l-.085.262zM10.335 23.889c.345.049.696.082 1.043.102l.014-.275c-.339-.018-.682-.051-1.019-.098l-.038.271zM17.326 22.449c-.303.154-.613.297-.926.424l.104.256c.318-.131.639-.275.947-.434l.004-.002-.123-.246-.006.002zM4.613 21.467c.274.213.562.418.854.605l.149-.23c-.285-.184-.565-.385-.833-.592l-.17.217zM12.417 23.725l.009.275c.348-.014.699-.041 1.045-.084l-.035-.271c-.336.041-.68.068-1.019.08zM6.37 22.604c.307.162.625.314.946.449l.107-.254c-.313-.133-.624-.279-.924-.439l-.129.244zM3.083 20.041c.233.258.48.51.734.746l.188-.201c-.249-.23-.49-.477-.717-.729l-.205.184zM14.445 23.475l.059.27c.34-.074.68-.162 1.014-.266l-.082-.262c-.325.099-.659.185-.991.258zM21.18.129A2.689 2.689 0 1 0 21.18 5.507 2.689 2.689 0 1 0 21.18.129zM15.324 15.447c0 .471.314.66.852.66.67 0 1.297-.396 1.297-1.016v-.645c-.23.107-.379.141-1.107.24-.735.109-1.042.306-1.042.761zM12 2.818c-5.07 0-9.18 4.109-9.18 9.18 0 5.068 4.11 9.18 9.18 9.18 5.07 0 9.18-4.111 9.18-9.18 0-5.07-4.11-9.18-9.18-9.18zm-2.487 13.77H5.771v-6.023h.769v5.346h2.974v.677zm4.13 0h-.619v-.67c-.405.57-.811.793-1.446.793-.843 0-1.38-.463-1.38-1.182v-3.271h.686v3c0 .52.347.85.893.85.719 0 1.181-.578 1.181-1.461v-2.389h.686v4.33zm-.53-8.393c0-1.484 1.205-2.689 2.689-2.689s2.688 1.205 2.688 2.689-1.203 2.688-2.688 2.688-2.689-1.203-2.689-2.688zm5.567 7.856v.52c-.223.059-.33.074-.471.074-.34 0-.637-.238-.711-.57-.381.406-.918.637-1.471.637-.877 0-1.422-.463-1.422-1.248 0-.527.256-.916.76-1.123.266-.107.414-.141 1.389-.264.545-.066.719-.191.719-.48v-.182c0-.412-.348-.645-.967-.645-.645 0-.957.24-1.016.77h-.693c.041-1 .686-1.404 1.734-1.404 1.066 0 1.627.412 1.627 1.182v2.412c0 .215.133.338.373.338.041-.002.074-.002.149-.017z" },
  r: { color: "#276DC3", path: "M12 2.746c-6.627 0-12 3.599-12 8.037 0 3.897 4.144 7.144 9.64 7.88V16.26c-2.924-.915-4.925-2.755-4.925-4.877 0-3.035 4.084-5.494 9.12-5.494 5.038 0 8.757 1.683 8.757 5.494 0 1.976-.999 3.379-2.662 4.272.09.066.174.128.258.216.169.149.25.363.372.544 2.128-1.45 3.44-3.437 3.44-5.631 0-4.44-5.373-8.038-12-8.038zm-2.111 4.99v13.516l4.093-.002-.002-5.291h1.1c.225 0 .321.066.549.25.272.22.715.982.715.982l2.164 4.063 4.627-.002-2.864-4.826s-.086-.193-.265-.383a2.22 2.22 0 00-.582-.416c-.422-.214-1.149-.434-1.149-.434s3.578-.264 3.578-3.826c0-3.562-3.744-3.63-3.744-3.63zm4.127 2.93l2.478.002s1.149-.062 1.149 1.127c0 1.165-1.149 1.17-1.149 1.17h-2.478zm1.754 6.119c-.494.049-1.012.079-1.54.088v1.807a16.622 16.622 0 002.37-.473l-.471-.891s-.108-.183-.248-.394c-.039-.054-.08-.098-.111-.137z" },
  julia: { color: "#9558B2", path: "M11.138 17.569a5.569 5.569 0 1 1-11.138 0 5.569 5.569 0 1 1 11.138 0zm6.431-11.138a5.569 5.569 0 1 1-11.138 0 5.569 5.569 0 1 1 11.138 0zM24 17.569a5.569 5.569 0 1 1-11.138 0 5.569 5.569 0 1 1 11.138 0z" },
  perl: { color: "#39457E", path: "M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0m.157 1.103a10.91 10.91 0 0 1 9.214 5.404c-1.962.152-3.156 1.698-5.132 3.553-2.81 2.637-4.562.582-5.288-.898-.447-1.004-.847-2.117-1.544-2.769A.4.4 0 0 1 9.3 6.02l.08-.37a.083.083 0 0 0-.074-.1c-.33-.022-.601.093-.84.368a2.5 2.5 0 0 0-.375-.064c-.863-.093-1.036.345-1.873.345H5.81c-.758 0-1.391.361-1.7.892-.248.424-.257.884.15.93-.126.445.292.62 1.224.192 0 0 .733.421 1.749.421.549 0 .712.087.914.967.486 2.138 2.404 5.655 6.282 5.655l.118.166c.659.934.86 2.113.48 3.184-.307.867-.697 1.531-.697 1.531q.01.178.01.349c0 .81-.175 1.553-.387 2.23a10.91 10.91 0 0 1-11.989-6.342A10.91 10.91 0 0 1 7.608 2.01a10.9 10.9 0 0 1 4.55-.907M7.524 6.47c.288 0 .575.231.477.272a.4.4 0 0 1-.1.02.38.38 0 0 1-.375.327.384.384 0 0 1-.378-.326.4.4 0 0 1-.101-.02c-.098-.042.19-.273.477-.273m10.193 10.49q.05 0 .101.007.326.054.694.096.135.01.269.026a13.4 13.4 0 0 0 2.846-.007 10.9 10.9 0 0 1-2.007 2.705c-.11-.23-.547-1.19-.573-2.196q-.156-.01-.313-.026-.13-.014-.256-.022a18 18 0 0 1-.735-.102h-.003c-.032 0-.06.01-.074.035l-.003.012q-.081.265-.182.544c.428 1.084.652 2.078.652 2.078.14.22.258.432.363.64a11 11 0 0 1-2.168 1.264 11 11 0 0 1-1.205.426 13.3 13.3 0 0 1 1.055-2.531s.678-1.445 1.027-2.564v-.004a.55.55 0 0 1 .512-.38" },
  elixir: { color: "#4B275F", path: "M19.793 16.575c0 3.752-2.927 7.426-7.743 7.426-5.249 0-7.843-3.71-7.843-8.29 0-5.21 3.892-12.952 8-15.647a.397.397 0 0 1 .61.371 9.716 9.716 0 0 0 1.694 6.518c.522.795 1.092 1.478 1.763 2.352.94 1.227 1.637 1.906 2.644 3.842l.015.028a7.107 7.107 0 0 1 .86 3.4z" },
  erlang: { color: "#A90533", path: "M8.859 7.889c.154-1.863 1.623-3.115 3.344-3.119 1.734.004 2.986 1.256 3.029 3.119zm12.11 11.707c.802-.86 1.52-1.872 2.172-3.03l-3.616-1.807c-1.27 2.064-3.127 3.965-5.694 3.977-3.738-.012-5.206-3.208-5.198-7.322h13.966c.019-.464.019-.68 0-.904.091-2.447-.558-4.504-1.737-6.106l-.007.005H24v15.186h-3.039zm-17.206-.001C1.901 17.62.811 14.894.813 11.64c-.002-2.877.902-5.35 2.456-7.232H0v15.187h3.761Z" },
  scala: { color: "#DC322F", path: "M4.589 24c4.537 0 13.81-1.516 14.821-3v-5.729c-.957 1.408-10.284 2.912-14.821 2.912V24zM4.589 16.365c4.537 0 13.81-1.516 14.821-3V7.636c-.957 1.408-10.284 2.912-14.821 2.912v5.817zM4.589 8.729c4.537 0 13.81-1.516 14.821-3V0C18.453 1.408 9.126 2.912 4.589 2.912v5.817z" },
  clojure: { color: "#5881D8", path: "M11.503 12.216c-.119.259-.251.549-.387.858-.482 1.092-1.016 2.42-1.21 3.271a4.91 4.91 0 0 0-.112 1.096c0 .164.009.337.022.514.682.25 1.417.388 2.186.39a6.39 6.39 0 0 0 2.001-.326 3.808 3.808 0 0 1-.418-.441c-.854-1.089-1.329-2.682-2.082-5.362M8.355 6.813A6.347 6.347 0 0 0 5.657 12a6.347 6.347 0 0 0 2.625 5.134c.39-1.622 1.366-3.107 2.83-6.084-.087-.239-.186-.5-.297-.775-.406-1.018-.991-2.198-1.513-2.733a4.272 4.272 0 0 0-.947-.729M17.527 19.277c-.84-.105-1.533-.232-2.141-.446A7.625 7.625 0 0 1 4.376 12a7.6 7.6 0 0 1 2.6-5.73 5.582 5.582 0 0 0-1.324-.162c-2.236.02-4.597 1.258-5.58 4.602-.092.486-.07.854-.07 1.29 0 6.627 5.373 12 12 12 4.059 0 7.643-2.017 9.815-5.101-1.174.293-2.305.433-3.271.436-.362 0-.702-.02-1.019-.058M15.273 16.952c.074.036.242.097.475.163a6.354 6.354 0 0 0 2.6-5.115h-.002a6.354 6.354 0 0 0-6.345-6.345 6.338 6.338 0 0 0-1.992.324c1.289 1.468 1.908 3.566 2.507 5.862l.001.003c.001.002.192.637.518 1.48.326.842.789 1.885 1.293 2.645.332.51.697.876.945.983M12.001 0a11.98 11.98 0 0 0-9.752 5.013c1.134-.71 2.291-.967 3.301-.957 1.394.004 2.491.436 3.017.732.127.073.248.152.366.233A7.625 7.625 0 0 1 19.625 12a7.605 7.605 0 0 1-2.268 5.425c.344.038.709.063 1.084.061 1.328 0 2.766-.293 3.842-1.198.703-.592 1.291-1.458 1.617-2.757.065-.502.1-1.012.1-1.531 0-6.627-5.371-12-11.999-12" },
  haskell: { color: "#5D4F85", path: "M0 3.535L5.647 12 0 20.465h4.235L9.883 12 4.235 3.535zm5.647 0L11.294 12l-5.647 8.465h4.235l3.53-5.29 3.53 5.29h4.234L9.883 3.535zm8.941 4.938l1.883 2.822H24V8.473zm2.824 4.232l1.882 2.822H24v-2.822z" },
  ocaml: { color: "#EC6813", path: "M12.178 21.637c-.085-.17-.187-.524-.255-.676-.067-.135-.27-.506-.37-.625-.22-.253-.27-.27-.338-.608-.12-.574-.405-1.588-.76-2.296-.187-.372-.49-.677-.761-.947-.236-.236-.777-.624-.878-.607-.895.169-1.166 1.046-1.587 1.739-.237.388-.473.71-.66 1.115-.167.371-.151.793-.439 1.115a2.952 2.952 0 00-.624 1.097c-.034.084-.101.929-.186 1.131l1.318-.084c1.233.085.877.557 2.787.456l3.022-.1a5.376 5.376 0 00-.27-.71zM20.96 1.539H3.023A3.02 3.02 0 000 4.56v6.587c.44-.152 1.047-1.08 1.25-1.3.337-.389.405-.895.574-1.2.389-.709.456-1.215 1.334-1.215.406 0 .575.1.845.473.186.253.523.743.675 1.064.186.371.474.86.609.962.1.068.185.136.27.17.135.05.253-.051.354-.12.118-.1.17-.286.287-.556.17-.39.339-.827.44-.997.169-.27.236-.608.422-.76.27-.236.641-.253.743-.27.557-.118.81.27 1.08.507.186.168.423.49.609.91.135.339.304.661.388.846.068.185.237.49.338.86.101.322.337.575.44.744 0 0 .152.406 1.03.778a7.505 7.505 0 00.81.286c.39.135.76.12 1.233.068.338 0 .524-.49.676-.878.084-.237.185-.895.236-1.081.05-.185-.085-.32.034-.49.135-.186.22-.203.287-.439.17-.523 1.114-.54 1.655-.54.456 0 .389.44 1.149.287.439-.085.86.05 1.318.185.388.102.76.22.98.473.134.17.489.997.134 1.031.033.033.067.118.118.151-.085.322-.422.085-.625.051-.253-.05-.44 0-.693.118-.439.187-1.063.17-1.452.49-.32.271-.32.861-.473 1.2 0 0-.422 1.063-1.317 1.722-.237.17-.692.574-1.672.726-.44.068-.86.068-1.318.05-.22-.016-.438-.016-.658-.016-.136 0-.575-.017-.558.034l-.05.119a.6.6 0 00.033.169c.017.1.017.185.034.27 0 .185-.017.388 0 .574.017.388.17.743.186 1.148.017.44.236.913.456 1.267.085.135.203.152.254.32.067.186 0 .406.033.609.118.794.355 1.638.71 2.364v.017c.439-.067.895-.236 1.47-.32 1.063-.153 2.532-.085 3.478-.17 2.399-.22 3.7.98 5.844.49V4.562a3.045 3.045 0 00-3.04-3.023zm-8.951 14.187c0-.034 0-.034 0 0zm-6.47 2.769c.17-.372.271-.778.406-1.15.135-.354.337-.86.693-1.046-.05-.05-.744-.068-.929-.085a7.406 7.406 0 01-.608-.084 22.976 22.976 0 01-1.15-.236c-.22-.051-.979-.322-1.13-.39-.39-.168-.642-.658-.93-.607-.185.034-.37.101-.49.287-.1.152-.134.423-.202.608-.084.203-.22.405-.32.608-.238.354-.626.676-.795 1.03-.033.085-.05.169-.084.254v4.07c.202.034.405.068.624.135 1.69.456 2.095.49 3.75.304l.152-.017c.118-.27.22-1.165.304-1.435.067-.22.153-.39.187-.591.033-.203 0-.406-.017-.59-.034-.491.354-.661.54-1.065z" },
  fsharp: { color: "#378BBA", path: "M0 12 11.39.61v5.695L5.695 12l5.695 5.695v5.695L0 12zm7.322 0 4.068-4.068v8.136L7.322 12zM24 12 12.203.61v5.695L17.898 12l-5.695 5.695v5.695L24 12z" },
  zig: { color: "#F7A41D", path: "m23.53 1.02-7.686 3.45h-7.06l-2.98 3.452h7.173L.47 22.98l7.681-3.607h7.065v-.002l2.978-3.45-7.148-.001 12.482-14.9zM0 4.47v14.901h1.883l2.98-3.45H3.451v-8h.942l2.824-3.45H0zm22.117 0-2.98 3.608h1.412v7.844h-.942l-2.98 3.45H24V4.47h-1.883z" },
  nim: { color: "#FFC200", path: "M12.095 3.2s-.92.778-1.857 1.55c-.964-.032-2.856.199-3.88.598C5.412 4.708 4.582 4 4.582 4s-.709 1.305-1.154 2.07c-.662.377-1.325.8-1.917 1.36C.824 7.14.026 6.782 0 6.77c.911 1.967 1.524 3.936 3.19 5.12 2.654-4.483 14.983-4.07 17.691-.025 1.75-.977 2.43-3.078 3.119-5.018-.075.026-1.012.362-1.619.61-.363-.423-1.217-1.072-1.702-1.385a96.008 96.008 0 00-1.131-2.122s-.794.632-1.715 1.322c-1.243-.246-2.747-.544-4.012-.47A52.988 52.988 0 0112.095 3.2zM.942 10.95l2.189 5.67c3.801 5.367 13.508 5.74 17.74.105 1.001-2.415 2.352-5.808 2.352-5.808-1.086 1.72-2.852 2.909-3.94 3.549-.774.453-2.558.727-2.558.727l-4.684-2.597-4.71 2.545s-1.761-.303-2.558-.701c-1.608-.92-2.69-2.004-3.83-3.49z" },
  crystal: { color: "currentColor", path: "M23.964 15.266l-8.687 8.669c-.034.035-.086.052-.121.035L3.29 20.79c-.052-.017-.087-.052-.087-.086L.007 8.856c-.018-.053 0-.087.035-.122L8.728.065c.035-.035.087-.052.121-.035l11.866 3.18c.052.017.087.052.087.086l3.18 11.848c.034.053.016.087-.018.122zm-11.64-9.433L.667 8.943c-.017 0-.035.034-.017.052l8.53 8.512c.017.017.052.017.052-.017l3.127-11.64c.017 0-.018-.035-.035-.017Z" },
  apachegroovy: { color: "#4298B8", path: "M11.997 6.012S10.315 8.8 9.516 10.155c-.155.058-.172.041-.341.207-.41-.47-.897-.041-1.028.22-.057-.566-.151-.567-.279-.694.074-.496.316-1.305-.241-1.884-1.078-.727-2.326 1.05-3.021 1.982l-.375.622c-1.546-.032-2.763.008-4.231-.021 1.79.67 1.864.686 4.026 1.506 0 .066.161.372.34.552.147.15.308.234.389.284-.106.054-.32.138-.385.258-.292.546.139.672.418 1.107.315.568.382.944 1.126.625.254-.11.562-.148.758-.21-.693 1.094-.87 1.392-2.083 3.274l.012.004c4.85-1.893 4.974-1.942 7.373-2.89 3.448 1.338 3.646 1.448 7.432 2.891-.529-.826-.89-1.343-1.274-1.995.151-.013.483-.046.777-.233.213-.135.463-.288.688-.574.443-.565.551-1.277.39-2.166-.078-.423-.235-.834-.213-.85 2.061-.778 2.304-.862 4.226-1.587-2.31.034-2.422.01-4.591.016-.036-.414-.244-.627-.882-.606-.238.039-.389.12-.5.445-.357-.657-.85-.464-1.06-.14-.275-.282-.917-.377-1.24-.17-.238-.112-.514-.112-.757.177-.175-.146-.23-.188-.614-.342-.886-1.497-1.622-2.692-2.36-3.951zm.012.802c.35.535 1.552 2.61 1.849 3.074-.337.023-.668.202-.918.562-.217-.224-.47-.445-.917-.463-.544-.093-.834.148-1.2.568-.108-.365-.53-.45-.896-.28.327-.519 1.872-3.122 2.082-3.46zM7.45 9.128c-.05 1.434-1.068 2.712-1.798 2.245-.551-.449.149-1.584.59-1.985-.033.307.246.498.023.77-.446.543-.27.936-.078.996.513.162 1.004-1.227 1.004-2.201 0-.625-.366-.613-1.086.136-.983 1.022-1.513 2.012-1.16 2.69.197.38.485.651.959.594.925-.11 1.483-1.254 1.543-1.988.148-.003.109.01.148-.02 0 .129.177.755.317 1.166.183.702.964 2.11-1.369 2.658-.44.11-.614.148-1.05.32-.213-.443-.263-.585-.697-1.013.588-.205.593-.185.972-.317 1.467-.51 1.908-.947 1.857-1.57 0 0 .018-.32-.185-.588a2.613 2.613 0 0 1-.293.645c-.437.68-1.296 1.101-2.06.833-.417-.146-.596-.466-.596-1.015 0-.703 1.601-2.735 2.387-3.08.555-.165.579.293.571.724zm6.502 1.3c.26.006.543.133.735.34.594.64.529 1.417.163 1.905-.435.581-1.532.324-1.791-.488-.12-.378.095-1.312.475-1.624a.628.628 0 0 1 .418-.132zm-2.113.066a.502.502 0 0 1 .117.017c.503.03.61.313.701.56.231.626.173 1.212-.301 1.691-.711.719-1.54.401-1.536-.567.014-.69.443-1.715 1.02-1.7zm1.868.038c-.383.287-.432 1.023-.08 1.296.138.13.215.22.613.256.273.024.704-.253.725-.527.01-.125-.013-.333-.312-.67-.252-.283-.579-.349-.661-.3-.265.156.021.28.125.383.162.163.2.234.125.282a.447.447 0 0 1-.372.057c-.105-.049-.456-.246-.163-.777zm3.759.003c.167.26.215.316.402.965.24.838.546 1.163.816 1.01.74-.418.148-1.476-.113-1.974.167-.002.134.007.286.005.12.471.086.387.407 1.813.385 1.706.442 2.16-.528 2.926-.446.352-1.103.37-1.667.34l-.636-.095c.438-.287.545-.557.542-1.116 1.278.535 1.959.132 2.23-.526.132-.317.086-.735-.04-1.471.008.6-.005.71-.084 1.007-.158.595-.547.76-.812.34-.102-.163-.345-.702-.42-1.282-.075-.58-.132-1.395-.5-1.736.04-.08.082-.17.117-.206zm-1.247.01c.258.068.572.204.74.52.234.436.388.668.376 1.447-.014.832-.34 1.055-.557 1.086-.278.04-.762.034-1.049-1.598-.095-.541-.268-1.056-.45-1.224.09-.11.097-.096.165-.204.091.1.17.27.298.777.202.808.387.975.745 1.02.558.072.778-.78.318-1.391-.1-.134-.365-.307-.503-.236.008.236.113.162.114.318-.026.185-.053.219-.113.32-.142-.056-.21-.078-.334-.291-.157-.31-.055-.6.25-.544zm-4.597.076c-.263.185-.594.8-.304 1.35.143.205.297.372.638.3.245-.051.671-.34.73-.749.052-.35-.456-1.028-.738-.87-.327.183-.128.314.074.511.185.18.052.289-.077.342-.258.106-.403.003-.467-.203-.065-.205-.01-.38.144-.68zm-2.867.064c.056.172.1.402.218.624.028.023.132 0 .269-.157.086-.1.185-.238.357-.463.104.095.113.166.142.219.073.13.225.12.273.106.168-.167.195-.275.306-.29.01.216.021.35-.257.677a.535.535 0 0 1-.501.172c-.12-.034-.199-.108-.389-.205-.258.04-.19.315-.143.546.12.611.5.855.832.675.116-.062.09-.062.312-.153-.038.388-.06.463.01.896-.541.301-.982.25-1.102-.506-.091-.632-.261-1.4-.415-1.556-.145-.147-.205-.195-.205-.195l.293-.39zm-7.114.082c.753.01 1.602.01 2.506.017-.13.318-.175.54-.193.854-.422-.163-1.877-.684-2.313-.871zm20.723.01c-.997.359-1.715.637-2.677 1.004-.105-.45-.124-.588-.219-.994 1.601-.005 1.628-.002 2.896-.01zm-6.978 2.04c.105.43.253.641.253.641.202.348.454.545.84.645.085.136.115.163.148.236.037.457.01.514-.344.774-.209.204-.218.497-.003.769.231.22.474.298 1.375.064.174.3.418.653.776 1.217-1.206-.455-2.868-1.103-6.43-2.49 0 0-4.169 1.62-6.404 2.491.935-1.474 1.012-1.599 1.677-2.63.225-.089.149-.053.349-.155.459-.245.827-.61 1.028-1.145.368.83.779.925 1.636.655.177-.082.38-.2.424-.518.46.413 1.432.49 2.142-.382.612.717 2.001.785 2.533-.171zm2.157.865s.04.129.064.169c-.101.003-.213 0-.213 0a.905.905 0 0 0 .149-.17z" },
  bazel: { color: "#43A047", path: "m11.7473 23.8198-5.4987-5.4987v-5.5349l5.4987 5.4986v5.535zm-.1036-17.6412-.0001-.0001.1768-.1768L5.9986.1799.1768 6.0018l.0001.0001 5.8217 5.8271 5.6451-5.6504zM0 6.5323v5.5347l5.7486 5.7539v-5.5347l-.1035-.1035.0001-.0001L0 6.5323zm17.6478 5.6504-5.6505-5.6505-5.6452 5.6504 5.6452 5.6453 5.6505-5.6452zm.1036 5.8885v-5.2853l-5.5042 5.4991v5.5351l5.5042-5.4991v-.2498zM24 6.5323l-5.6451 5.6503.0001.0001-.1036.1035v5.5346L24 12.067V6.5323zm-.1769-.5304.0001-.0001L18.0014.18l-5.8273 5.822 5.8273 5.8272 5.8217-5.8273z" },
  llvm: { color: "currentColor", path: "M20.83 2.978l-.086.095a16.245 16.245 0 0 0-1.19 1.487 5.773 5.773 0 0 0-.446.719 2.88 2.88 0 0 0-.249.596.497.497 0 0 0-.033.177v.004a.297.297 0 0 0-.21.29.3.3 0 0 0 .187.284c.038.371.08 1.142.07 2.2l-.004.142a8.001 8.001 0 0 1-.434 2.327c-.016-.01-.03-.014-.04-.013-.03.003-.11.12-.19.251-.058.09-.119.195-.154.291a.37.37 0 0 0-.03.14.249.249 0 0 0 .01.088c.01.037.022.058.022.058a6.836 6.836 0 0 1-.003.007.144.144 0 0 0-.028.067l-.012.029a6.836 6.836 0 0 1-.257.527l-.077.142a6.836 6.836 0 0 1-.07.115.157.157 0 0 0-.022-.014.16.16 0 0 0-.113.024c-.047.035-.151.194-.498.368a1.384 1.384 0 0 1-.32.114 14.1 14.1 0 0 0 .248-2.07 5.072 5.072 0 0 0-.064-1.057c.003-.01.003-.017.003-.017l-.005.01a4.345 4.345 0 0 0-.104-.458 3.554 3.554 0 0 0-.724-1.385c-.631-.754-1.496-1.14-2.256-1.165l-.125-.002c0-.008 0-.015.002-.022.02-.098.024-.127-.087-.032a.872.872 0 0 0-.057.054 2.986 2.986 0 0 0-.146.007.716.716 0 0 1-.003-.108c.004-.076.024-.127-.087-.032a.553.553 0 0 0-.142.167c-.05.008-.08.015-.08.015l.045-.002-.047.008c-.016-.042-.053-.105-.048-.16.01-.118.043-.14-.037-.065-.098.09-.202.226-.22.3l-.096.03c-.018-.019-.074-.07-.086-.179-.013-.11-.012-.166-.08-.05a1.14 1.14 0 0 0-.13.348c-.032.015-.063.03-.093.046a.27.27 0 0 1-.057-.173c-.005-.144.04-.26-.067-.068a1.634 1.634 0 0 0-.146.406 1.6 1.6 0 0 0-.105.08 2.7 2.7 0 0 1-.008-.17c-.002-.143.021-.296-.067-.026a1.832 1.832 0 0 0-.07.321c-.404.385-.65.917-.644 1.572v.007a3.42 3.42 0 0 0 .014.33c.02.238.057.438.107.605-.095.13-.103.689-.01.818.073.104.496.35.586.399a.367.367 0 0 1 .094.093c.115.188.115.567.027.762-.107.238.107.285.285.32.178.036.415-.023.463-.118.047-.095-.154-.31-.237-.748-.084-.439.13-.474.13-.474s.095.024.237.249c.11.175.227.313.336.413a.727.727 0 0 1-.201.172c.12.005.24-.051.304-.087a.77.77 0 0 0 .07.045 1.015 1.015 0 0 1-.05.05.506.506 0 0 0 .109-.022.295.295 0 0 0 .084.022c.155.012.57-.368.57-.439 0-.018-.015-.04-.038-.063-.042-.045-.12-.1-.207-.177a1.03 1.03 0 0 1-.11-.116.723.723 0 0 1-.141-.374v-.01l-.003-.031s.007-.007.016-.02v.004l.004-.01c.052-.08.15-.379-.47-1.078a3.045 3.045 0 0 0-.924-.706c-.042-.472.15-.913.626-1.13l-.005.005.008-.006c.227-.102.517-.155.877-.136.69.036 1.22.36 1.59.845.514.712.738 1.78.575 2.856-.068.065-.055.075-.013.077a4.616 4.616 0 0 1-.055.273l-.027.015c-.123.074-.071.073 0 .092l-.006.02a3.98 3.98 0 0 1-.066.193.956.956 0 0 0-.087.03c-.135.053-.08.06-.012.09l.044.023a5.62 5.62 0 0 1-.101.237.746.746 0 0 0-.08.017c-.142.036-.088.05-.024.09a.52.52 0 0 1 .04.027 6.783 6.783 0 0 1-.107.214.76.76 0 0 0-.153.025c-.14.036-.087.05-.023.09.034.02.06.04.08.059a8.021 8.021 0 0 1-.094.165l-.023.036a.59.59 0 0 0-.206.024c-.142.036-.088.05-.024.09a.67.67 0 0 1 .104.079 8.61 8.61 0 0 1-.126.18.514.514 0 0 0-.23-.005c-.144.02-.092.04-.033.086.068.053.1.099.118.118l-.062.084c-.044-.058-.15-.124-.246-.193a.85.85 0 0 0-.29-.13c-.048 0-.2.268-1.017.197-.819-.071-.87-.15-.942-.15a.978.978 0 0 0-.228.059l-.034-.02a11.03 11.03 0 0 1-.972-.674c-.464-.37-.72-.647-.72-.647s.137-.125-.047-.284a3.32 3.32 0 0 0-.338-.277 2.157 2.157 0 0 0-.242-.166 3.57 3.57 0 0 1-.088-.127 11.485 11.485 0 0 1-.363-.628 10.455 10.455 0 0 1-.25-.527c-.16-.36-.27-.682-.346-.964a5.62 5.62 0 0 1-.148-.923 2.257 2.257 0 0 1 .004-.242.411.411 0 0 0 .158-.323.411.411 0 0 0-.358-.407c-.204-.427-.982-1.477-3.881-3.68l-.127-.097.005.004-.036-.027C7.067 6.599 7.644 7.587 7.795 8a.411.411 0 0 0-.027.033 18.69 18.69 0 0 0-.018-.013c.018 0 .025-.005.025-.005s-.672-.546-1.787-1.23c-1.118-.687-1.748-.849-1.88-.877l-.026-.006s.206.19.174.285c-.01.032-.168.022-.421.028a3.948 3.948 0 0 0-.725.07 4.1 4.1 0 0 0-1.567.63C.238 7.785 0 8.401 0 8.401s.55-.768 1.58-1.305c-.014.337-.047 1.97.445 4.12.53 2.32 1.53 4.487 1.614 4.665.004.178.016.272.016.272s.148-1.79.756-3.647c.175.283.758 1.117 2.075 2.096 1.628 1.21 2.37 1.536 2.4 1.548.001.157.005.24.005.24s.005-.1.018-.263a4.69 4.69 0 0 1 .552-.67 3.58 3.58 0 0 1 .54-.435c.032.11.063.204.093.276-.02-.097-.036-.19-.052-.282.107.01.538.066 1.206.393.343.168.609.395.798.595a.167.167 0 0 0-.014.006s.123.112.269.403a2.416 2.416 0 0 0-.73.084 2.913 2.913 0 0 0-.098-.19.484.484 0 0 0-.039-.134c-.027-.061-.095-.1-.164-.14a.397.397 0 0 0-.104-.073.225.225 0 0 1-.055-.073c-.084-.184-.798.012-.942.18-.175.204-.209.464-.14.608.021.045.07.082.138.11.002.22.137.75.404 1.133a4.964 4.964 0 0 1-.108-.666c-.009-.16 0-.274.015-.35.047.328.174.684.577 1.124-.248-.54-.22-.861-.195-1.143l.01-.044.005-.001c.036.263.142.534.482.963a.412.412 0 0 1-.014-.028l.014.021a1.626 1.626 0 0 1-.167-1.03l.008-.002c.046.03.091.07.134.126.128.172.188.349.212.47a.528.528 0 0 0 .067.383 18.33 18.33 0 0 1-.72.501c-.23.15-.49.313-.757.47-.14.08-.279.158-.414.23l-.135-.077h.002l-.008-.004c-.97-.559-1.69-.932-2.518-1.082-.93-.166-1.786.283-1.982 1.082a1.284 1.284 0 0 0 .552 1.38l.012.008c.013.01.026.017.04.026l.06.036h.002a2.1 2.1 0 0 0 .69.237l.028.005h.006a3.5 3.5 0 0 0 .412.044c.975.047 2.156-.408 3.323-.982.1.054.202.108.306.166 2.547 1.403 4.098 1.585 6.154.728-.502.151-1.208.356-2.094.344a.05.05 0 0 0-.02-.006v.006a5.46 5.46 0 0 1-.647-.05l-.03-.004v-.003a.267.267 0 0 0-.001.002 6.25 6.25 0 0 1-1.556-.436 7.792 7.792 0 0 1-.745-.362 57.065 57.065 0 0 1-1.006-.569c.348-.178.692-.363 1.026-.545.355-.189.672-.362.918-.5l.009-.004h.007s.083-.019.16-.043c.17-.052.41-.149.695-.283.028.117.095.215.195.253.235.091.407.027.522-.102l.018-.01.047-.037c.05-.03.107-.067.156-.09a1.14 1.14 0 0 1 .053-.022c.04-.01.078-.023.116-.037l.033-.01c-.145.297-.091.581-.091.581.043-.37.22-.608.392-.715.064-.027.13-.05.2-.067.064 0 .116.023.144.07.07.12.217.194.364.226.024.15-.045.404-.4.866l.09-.062.004-.003.072-.053c.143-.108.252-.21.334-.305a.97.97 0 0 0 .19-.305c.013.2-.042.507-.31 1.036 0 0 .317-.276.514-.63.006.191-.01.443-.063.785.345-.673.325-1.085.239-1.326l-.01-.036a.433.433 0 0 0-.01-.065l.042-.057c.118-.166-.048-.344-.154-.414-.06-.04-.2-.154-.454-.157-.225-.27-.51-.15-.958.145a1.297 1.297 0 0 1-.166.092.725.725 0 0 0-.055-.116c.16-.096.326-.2.494-.308.317-.207.553-.416.728-.615.51-.517.69-1.02 1.21-1.446h-.013l.06-.031c.854-.458 1.306-.547 1.338-.553l-.003.128.018-.125a1.795 1.795 0 0 1 .481.344 2.12 2.12 0 0 1 .362.487l.044.3s0-.116-.01-.33c.153-.151 1.02-1.043 1.724-2.466.694-1.404.944-2.523 1.017-2.924a18.188 18.188 0 0 1 .665 2.466s-.002-.133-.03-.374c.096-.336.515-1.872.626-3.756.1-1.68-.065-2.78-.14-3.173.648.536.995 1.306.995 1.306s-.04-.163-.188-.437l.02.027s-.236-.455-.644-.904a6.45 6.45 0 0 0-.157-.172c-.432-.46-.854-.617-1.17-.672a1.57 1.57 0 0 0-.308-.03h-.019c-.125-.003-.2.002-.207-.026-.02-.095.11-.285.11-.285s-.177.046-.554.33c-.23.167-.52.41-.853.76a13.689 13.689 0 0 0-.89.994l-.075.095a.203.203 0 0 0-.023-.017c.076-.33.362-1.117 1.788-3.111zM11.92 14.09a.351.351 0 0 1 .012.006zm-.263 2.606c.088.044.19.106.303.194h-.005a.484.484 0 0 0-.155.07.956.956 0 0 1-.126-.224zm-4.855 1.57c.132 0 .276.013.432.047l.02.005.017.004c.11.027.223.062.337.102l.057.021c.191.074.395.156.611.248.32.14.62.277.838.375l.183.088c-.22.106-.424.196-.577.261-1.014.416-1.83.536-2.338.391-.944-.269-.76-1.536.42-1.542z" },
  xcode: { color: "#147EFB", path: "M19.06 5.3327c.4517-.1936.7744-.2581 1.097-.1936.5163.1291.7744.5163.968.7098.1936.3872.9034.7744 1.2261.8389.2581.0645.7098-.6453 1.0325-1.2906.3227-.5808.5163-1.3552.4517-1.5488-.0645-.1936-.968-.5808-1.1616-.5808-.1291 0-.3872.1291-.8389.0645-.4517-.0645-.9034-.5808-1.1616-.968-.4517-.6453-1.097-1.0325-1.6778-1.3552-.6453-.3227-1.3552-.5163-2.065-.6453-1.0325-.2581-2.065-.4517-3.0975-.3227-.5808.0645-1.2906.1291-1.8069.3227-.0645 0-.1936.1936-.0645.1936s.5808.0645.5808.0645-.5807.1292-.5807.2583c0 .1291.0645.1291.1291.1291.0645 0 1.4842-.0645 2.065 0 .6453.1291 1.3552.4517 1.8069 1.2261.7744 1.4197.4517 2.7749.2581 3.2266-.968 2.1295-8.6472 15.2294-9.0344 16.1328-.3873.9034-.5163 1.4842.5807 2.065s1.6778.3227 2.0005-.0645c.3872-.5163 7.0339-17.1654 9.2925-18.2624zm-3.6138 8.7117h1.5488c1.0325 0 1.2261.5163 1.2261.7098.0645.5163-.1936 1.1616-1.2261 1.1616h-.968l.7744 1.2906c.4517.7744.2581 1.1616 0 1.4197-.3872.3872-1.2261.3872-1.6778-.4517l-.9034-1.5488c-.6453 1.4197-1.2906 2.9684-2.065 4.7753h4.0009c1.9359 0 3.5492-1.6133 3.5492-3.5492V6.5588c-.0645-.1291-.1936-.0645-.2581 0-.3872.4517-1.4842 2.0004-4.001 7.4856zm-9.8087 8.0019h-.3227c-2.3231 0-4.1945-1.8714-4.1945-4.1945V7.0105c0-2.3231 1.8714-4.1945 4.1945-4.1945h9.3571c-.1936-.1936-.968-.5163-1.7423-.4517-.3227 0-.968.1291-1.3552-.1291-.3872-.3227-.3227-.5163-.9034-.5163H4.9277c-2.6458 0-4.7753 2.1295-4.7753 4.7753v11.7447c0 2.6458 2.1295 4.7753 4.4527 4.7108.6452 0 .8388-.5162 1.0324-.9034zM20.4152 6.9459v10.9058c0 2.3231-1.8714 4.1945-4.1945 4.1945H11.897s-.3872 1.0325.8389 1.0325h3.8719c2.6458 0 4.7753-2.1295 4.7753-4.7753V8.8173c.0646-.9034-.7098-1.4842-.9679-1.8714zm-18.5851.0646v10.8413c0 1.9359 1.6133 3.5492 3.5492 3.5492h.5808c0-.0645.7744-1.4197 2.4522-4.2591.1936-.3872.4517-.7744.7098-1.2261H4.4114c-.5808 0-.9034-.3872-.968-.7098-.1291-.5163.1936-1.1616.9034-1.1616h2.3877l3.033-5.2916s-.7098-1.2906-.9034-1.6133c-.2582-.4517-.1291-.9034.129-1.1615.3872-.3872 1.0325-.5808 1.6778.4517l.2581.3872.2581-.3872c.5808-.8389.968-.7744 1.2906-.7098.5163.1291.8389.7098.3872 1.6133L8.864 14.0444h1.3552c.4517-.7744.9034-1.5488 1.3552-2.3877-.0645-.3227-.1291-.7098-.0645-1.0325.0645-.5163.3227-.968.6453-1.3552l.3872.6453c1.2261-2.1295 2.1295-3.9364 2.3877-4.6463.1291-.3872.3227-1.1616.1291-1.8069H5.3794c-2.0005.0001-3.5493 1.6134-3.5493 3.5494zM4.605 17.7872c0-.0645.7744-1.4197.7744-1.4197 1.2261-.3227 1.8069.4517 1.8714.5163 0 0-.8389 1.4842-1.097 1.7423s-.5808.3227-.9034.2581c-.5164-.129-.839-.6453-.6454-1.097z" },
  podman: { color: "#892CA0", path: "M17.2.275L6.75.308a.259.259 0 0 0-.203.098L.056 8.602a.259.259 0 0 0-.05.219l2.356 10.194a.26.26 0 0 0 .14.174l9.43 4.511a.258.258 0 0 0 .224-.002l9.401-4.566a.259.259 0 0 0 .141-.175L23.993 8.75a.258.258 0 0 0-.051-.22L17.403.374A.259.259 0 0 0 17.2.275zm-.123.517l6.385 7.966-2.242 9.964-9.177 4.457-9.205-4.402L.54 8.827 6.875.824zM11.46 2.857c-.933 0-1.84.1-2.426.332h-.002c-1.554.569-2.725 2.105-3.074 3.952v.004c-.309 1.463-.392 2.703-.556 3.824-.07.481-.159.94-.283 1.387-.628.497-1.079 1.263-1.244 2.138v.004c-.116.547-.181 1.04-.237 1.5h-.644v.518h8.891c-.061.464-.122.996-.181 1.42H7.596v.517h7.939c-.242-.078-.486-.218-.756-.502h-.697l-.85.488-.232-.396.162-.092h-1.069c.113-.776.17-1.601.373-2.564v-.004c.22-1.164.96-2.112 1.895-2.453l.004-.002h.002c.318-.127.928-.205 1.543-.205.613 0 1.244.075 1.622.207.935.341 1.676 1.29 1.895 2.453v.004c.204.963.26 1.788.373 2.564h-.742l.162.092-.233.396-.85-.488h-.75c-.219.25-.474.412-.747.502h4.392v-.518h-.842c-.103-.743-.181-1.67-.382-2.623v-.002a4.14 4.14 0 0 0-.264-.863h1.863v-.517h-2.13a3.488 3.488 0 0 0-.8-.906h1.8v-.518H17.95a8.862 8.862 0 0 1-.193-.775h1.484v-.518h-1.576c-.013-.081-.027-.161-.039-.244-.164-1.12-.246-2.36-.555-3.824v-.004c-.348-1.848-1.52-3.383-3.075-3.952l-.002-.002h-.002c-.65-.227-1.596-.33-2.531-.33zm0 .386c.904 0 1.833.11 2.404.309h.002c1.4.514 2.5 1.934 2.826 3.666v.003c.303 1.436.385 2.66.552 3.805.076.515.173 1.013.315 1.505-.449-.135-1.05-.197-1.648-.197-.12 0-.236.003-.352.008l-1.863-1.865a2.17 2.17 0 0 0 .11-.246l2.13 1.23.13-.224-2.185-1.262c.016-.069.027-.14.036-.21l2.302.616.068-.248-2.354-.63c-.02-1.153-1.008-2.078-2.208-2.078-1.205 0-2.196.931-2.206 2.091l-2.303.617.066.25 2.252-.605c.01.076.024.151.041.224L7.436 11.24l.129.222 2.087-1.207c.034.089.074.176.12.258l-1.266 1.266a6.959 6.959 0 0 0-1.045-.075c-.603 0-1.186.064-1.578.22a2.668 2.668 0 0 0-.285.124c.076-.335.137-.675.187-1.021.168-1.144.248-2.37.551-3.805l.002-.001v-.002c.326-1.733 1.426-3.153 2.828-3.666h.002l.004-.002c.488-.194 1.381-.307 2.287-.307zM8.473 5.194a1.295 1.295 0 0 0-.965.502l-.117.153.306.236.12-.152a.923.923 0 0 1 .673-.352.92.92 0 0 1 .67.262l.139.134.271-.275-.136-.137a1.293 1.293 0 0 0-.961-.37zm6.39 0a1.289 1.289 0 0 0-.96.371l-.138.137.274.275.136-.134a.923.923 0 0 1 .672-.262.923.923 0 0 1 .674.352l.119.152.307-.236-.12-.153c-.23-.3-.587-.486-.964-.502zM8.53 6.708c-.642 0-1.164.538-1.164 1.19 0 .65.522 1.187 1.164 1.187.643 0 1.164-.536 1.164-1.188 0-.651-.521-1.19-1.164-1.19zm6.273 0c-.643 0-1.162.538-1.162 1.19 0 .65.52 1.187 1.162 1.187.643 0 1.164-.536 1.164-1.188 0-.651-.521-1.19-1.164-1.19zm-6.273.387c.428 0 .776.355.776.802 0 .447-.348.8-.776.8a.785.785 0 0 1-.775-.8c0-.035.002-.07.006-.103.07.191.248.318.445.318a.487.487 0 0 0 .477-.496.49.49 0 0 0-.383-.486.759.759 0 0 1 .23-.035zm6.273 0c.428 0 .777.355.777.802 0 .447-.349.8-.777.8a.785.785 0 0 1-.77-.9c.072.19.248.315.444.315a.486.486 0 0 0 .479-.496.491.491 0 0 0-.383-.484.755.755 0 0 1 .23-.037zm-3.08.716c1.012 0 1.819.775 1.819 1.723 0 .947-.807 1.722-1.819 1.722s-1.82-.775-1.82-1.722c0-.948.808-1.723 1.82-1.723zm-.002.528c-.142 0-.258.043-.355.076a.804.804 0 0 1-.232.054c-.107 0-.2.047-.268.127a.568.568 0 0 0-.104.207c-.04.134-.062.268-.08.315a.276.276 0 0 0 .032.25c.033.056.071.1.117.146.09.092.206.183.322.268.12.088.237.166.326.224l-.008.09c-.043.036-.14.102-.324.178a.533.533 0 0 1-.299.025.43.43 0 0 1-.236-.172c.015-.138.044-.293.068-.449l-.376-.095c-.05.238-.067.43-.094.64l.037.059c.143.224.318.344.506.392a.908.908 0 0 0 .52-.033 1.57 1.57 0 0 0 .444-.242c.088.067.244.174.446.242a.908.908 0 0 0 .52.033.868.868 0 0 0 .507-.392l.037-.059a6.292 6.292 0 0 0-.096-.637l-.377.092c.032.148.051.32.07.451a.434.434 0 0 1-.237.17.533.533 0 0 1-.3-.025c-.178-.068-.272-.14-.325-.178l-.006-.084c.09-.058.209-.137.336-.23.115-.085.231-.176.322-.268a.72.72 0 0 0 .117-.146.273.273 0 0 0 .031-.25c-.018-.047-.039-.181-.08-.315a.564.564 0 0 0-.103-.207.343.343 0 0 0-.268-.127.815.815 0 0 1-.234-.054c-.097-.033-.212-.076-.354-.076zm.002.386c.057 0 .134.024.23.057.09.03.208.07.337.076.04.102.06.237.09.338a.361.361 0 0 1-.041.045 2.66 2.66 0 0 1-.276.228c-.165.122-.271.188-.342.233a5.287 5.287 0 0 1-.34-.233 2.557 2.557 0 0 1-.275-.228.34.34 0 0 1-.04-.047c.035-.119.046-.234.089-.34.08.012.246-.042.336-.072a.837.837 0 0 1 .232-.057zm-3.234.61a.635.635 0 0 0-.611.517l1.084-.289a.614.614 0 0 0-.473-.228zm6.336 0a.61.61 0 0 0-.436.187c.352.096.69.184 1.033.275a.632.632 0 0 0-.597-.462zm-.623.607c-.007.035-.002.07-.002.103l.921.532a.648.648 0 0 0 .276-.313l-1.195-.322zm-5.086.05l-1.18.315c.078.15.207.264.362.316l.797-.46c.018-.059.015-.12.021-.17zm4.441.714l1.656 1.658a4.19 4.19 0 0 0-.826.146l-.95-1.647a2.51 2.51 0 0 0 .12-.157zm-3.646.03c.04.055.083.118.129.169l-.658 1.134a2.656 2.656 0 0 0-.276-.119l-.002-.002a3.3 3.3 0 0 0-.292-.082zm3.338.317l.892 1.547c-.623.251-1.149.725-1.523 1.33h-1.652c-.262-.75-.741-1.38-1.358-1.764l.623-1.082c.394.347.919.559 1.492.559a2.25 2.25 0 0 0 1.526-.59zM7.46 12.09c.574 0 1.167.073 1.518.195.867.319 1.555 1.203 1.76 2.285l.001.002v.002c.109.513.173.98.227 1.424H9.86a.386.386 0 0 0-.494 0H9.11a1.351 1.351 0 0 0-.078-.418.799.799 0 0 0 .569.238c.45 0 .814-.375.814-.828a.824.824 0 0 0-.814-.828.822.822 0 0 0-.791 1.016 1.495 1.495 0 0 0-1.18-.559c-.798 0-1.46.611-1.48 1.38h-.342a.386.386 0 0 0-.494 0H4.028c.054-.445.116-.912.224-1.425l.002-.002v-.002c.205-1.084.894-1.97 1.764-2.287h.002l.004-.002c.295-.117.863-.191 1.437-.19zm-1.91 1.105a.898.898 0 0 0-.67.348l-.119.154.307.237.119-.155a.525.525 0 0 1 .379-.197.52.52 0 0 1 .377.147l.138.136.272-.275-.137-.137a.895.895 0 0 0-.666-.258zm4.094 0a.9.9 0 0 0-.668.258l-.137.137.273.275.137-.136a.522.522 0 0 1 .377-.147.525.525 0 0 1 .379.197l.119.155.307-.237-.12-.154a.894.894 0 0 0-.667-.348zm4.222.735a.947.947 0 0 0-.707.365l-.117.154.306.237.12-.155a.568.568 0 0 1 .413-.213.571.571 0 0 1 .414.159l.14.136.27-.275-.138-.137a.942.942 0 0 0-.701-.271zm4.374 0a.942.942 0 0 0-.7.271l-.14.137.272.275.139-.136a.571.571 0 0 1 .414-.159.568.568 0 0 1 .414.213l.119.155.306-.237-.117-.154a.947.947 0 0 0-.707-.365zm-12.65.232a.824.824 0 0 0-.815.828c0 .453.365.828.814.828.45 0 .815-.375.815-.828a.824.824 0 0 0-.815-.828zm5.518.285h1.242a4.137 4.137 0 0 0-.263.864v.002c-.05.237-.092.464-.127.685h-.602a16.77 16.77 0 0 0-.236-1.5l-.002-.002c-.003-.016-.009-.032-.012-.049zm-5.519.102a.43.43 0 0 1 .426.441.43.43 0 0 1-.426.442c-.22 0-.4-.171-.422-.397a.298.298 0 0 0 .215.092.31.31 0 0 0 .305-.316.317.317 0 0 0-.129-.258c.01-.001.02-.004.031-.004zm4.014 0c.235 0 .427.193.427.441a.433.433 0 0 1-.427.442.427.427 0 0 1-.422-.405.3.3 0 0 0 .256.145.31.31 0 0 0 .304-.317.314.314 0 0 0-.207-.298c.023-.004.045-.008.069-.008zm4.304.414a.865.865 0 0 0-.856.87c0 .478.382.874.856.874a.868.868 0 0 0 .857-.873.867.867 0 0 0-.857-.871zm4.292 0a.867.867 0 0 0-.814 1.14 1.597 1.597 0 0 0-1.295-.652c-.846 0-1.546.65-1.568 1.463l-1.525.408.066.248 1.477-.394c.004.028.009.06.015.087l-1.418.817.131.222 1.367-.789c.235.552.801.94 1.455.94.66 0 1.233-.397 1.463-.957l1.398.806.13-.222-1.45-.836c.005-.025.008-.053.012-.078l1.511.404.067-.248-1.563-.418a1.438 1.438 0 0 0-.107-.5c.157.186.39.303.648.303a.867.867 0 0 0 .856-.873.865.865 0 0 0-.856-.871zm-10.567.043c.598 0 1.071.444 1.092.992h-.41c.007-.01.016-.02.023-.033a.24.24 0 0 0 .025-.22c-.005-.016-.021-.102-.05-.196a.416.416 0 0 0-.078-.156.282.282 0 0 0-.225-.108.499.499 0 0 1-.129-.031c-.062-.021-.142-.05-.248-.05-.106 0-.188.029-.25.05a.49.49 0 0 1-.127.031.29.29 0 0 0-.225.108.424.424 0 0 0-.08.156c-.029.094-.043.18-.048.195a.242.242 0 0 0 .023.22c.008.014.017.023.025.034h-.41c.02-.548.494-.992 1.092-.992zm6.275.344c.259 0 .47.211.47.484a.477.477 0 0 1-.47.486.472.472 0 0 1-.467-.453.322.322 0 0 0 .246.115c.18 0 .326-.15.326-.338a.34.34 0 0 0-.156-.289c.017-.002.033-.005.05-.005zm4.292 0c.26 0 .469.211.469.484 0 .272-.21.486-.469.486a.477.477 0 0 1-.47-.486c0-.016.002-.031.004-.047a.33.33 0 0 0 .312.24c.18 0 .326-.15.326-.338a.338.338 0 0 0-.256-.332.475.475 0 0 1 .084-.007zm-10.567.24c.021 0 .063.01.125.031.086.03.117.039.186.049.012.041.022.088.033.129a1.475 1.475 0 0 1-.168.138c-.038.028-.064.045-.088.061h-.176c-.024-.016-.052-.033-.09-.06a1.602 1.602 0 0 1-.168-.14l.034-.128c.107-.014.146-.04.185-.049a.504.504 0 0 1 .127-.031zm8.458.25c.661 0 1.184.502 1.184 1.113 0 .156-.035.304-.096.44l-.002-.024-.022-.156a2.443 2.443 0 0 0-.04-.24l-.377.093.044.274a.24.24 0 0 1-.115.074.299.299 0 0 1-.168-.014c-.087-.03-.132-.063-.18-.094.057-.037.13-.084.198-.134.08-.06.16-.123.226-.19a.542.542 0 0 0 .092-.111.245.245 0 0 0 .026-.225c-.008-.019-.022-.112-.053-.21a.444.444 0 0 0-.084-.163.286.286 0 0 0-.23-.107.566.566 0 0 1-.14-.037c-.065-.022-.152-.055-.263-.055-.11 0-.195.032-.262.055a.575.575 0 0 1-.14.037.294.294 0 0 0-.23.107.436.436 0 0 0-.083.162c-.03.1-.045.192-.052.211a.246.246 0 0 0 .025.225.534.534 0 0 0 .09.111c.066.067.146.13.226.19.068.05.138.095.194.132a.57.57 0 0 1-.18.096.305.305 0 0 1-.17.014.237.237 0 0 1-.111-.076c.008-.09.026-.177.04-.272l-.376-.094c-.032.146-.045.286-.063.409a1.052 1.052 0 0 1-.09-.428c0-.611.521-1.113 1.182-1.113zm0 .623c.026 0 .074.01.14.033.066.025.169.052.206.055l.035.156c-.04.04-.112.1-.184.152-.095.07-.14.095-.197.131-.056-.036-.1-.061-.195-.13a1.236 1.236 0 0 1-.184-.157l.035-.152a1.04 1.04 0 0 0 .206-.055.523.523 0 0 1 .138-.033zm-2.22.353a.43.43 0 0 0-.385.272l.656-.176a.416.416 0 0 0-.271-.096zm4.333 0a.414.414 0 0 0-.22.07l.603.16a.426.426 0 0 0-.383-.23zm-4.054.567l-.607.162a.436.436 0 0 0 .125.113zm3.925.002l.407.234a.443.443 0 0 0 .087-.102zm-1.986.234c.067.047.165.108.285.148a.68.68 0 0 0 .389.024.57.57 0 0 0 .232-.121 1.201 1.201 0 0 1-.904.394c-.356 0-.67-.145-.885-.375a.58.58 0 0 0 .207.102c.144.036.28.014.391-.024.12-.04.218-.1.285-.148zm-9.524 1.61v.517h6.214v-.518zm3.619 1.292v.517H15.3v-.517z" },
  kubernetes: { color: "#326CE5", path: "M10.204 14.35l.007.01-.999 2.413a5.171 5.171 0 0 1-2.075-2.597l2.578-.437.004.005a.44.44 0 0 1 .484.606zm-.833-2.129a.44.44 0 0 0 .173-.756l.002-.011L7.585 9.7a5.143 5.143 0 0 0-.73 3.255l2.514-.725.002-.009zm1.145-1.98a.44.44 0 0 0 .699-.337l.01-.005.15-2.62a5.144 5.144 0 0 0-3.01 1.442l2.147 1.523.004-.002zm.76 2.75l.723.349.722-.347.18-.78-.5-.623h-.804l-.5.623.179.779zm1.5-3.095a.44.44 0 0 0 .7.336l.008.003 2.134-1.513a5.188 5.188 0 0 0-2.992-1.442l.148 2.615.002.001zm10.876 5.97l-5.773 7.181a1.6 1.6 0 0 1-1.248.594l-9.261.003a1.6 1.6 0 0 1-1.247-.596l-5.776-7.18a1.583 1.583 0 0 1-.307-1.34L2.1 5.573c.108-.47.425-.864.863-1.073L11.305.513a1.606 1.606 0 0 1 1.385 0l8.345 3.985c.438.209.755.604.863 1.073l2.062 8.955c.108.47-.005.963-.308 1.34zm-3.289-2.057c-.042-.01-.103-.026-.145-.034-.174-.033-.315-.025-.479-.038-.35-.037-.638-.067-.895-.148-.105-.04-.18-.165-.216-.216l-.201-.059a6.45 6.45 0 0 0-.105-2.332 6.465 6.465 0 0 0-.936-2.163c.052-.047.15-.133.177-.159.008-.09.001-.183.094-.282.197-.185.444-.338.743-.522.142-.084.273-.137.415-.242.032-.024.076-.062.11-.089.24-.191.295-.52.123-.736-.172-.216-.506-.236-.745-.045-.034.027-.08.062-.111.088-.134.116-.217.23-.33.35-.246.25-.45.458-.673.609-.097.056-.239.037-.303.033l-.19.135a6.545 6.545 0 0 0-4.146-2.003l-.012-.223c-.065-.062-.143-.115-.163-.25-.022-.268.015-.557.057-.905.023-.163.061-.298.068-.475.001-.04-.001-.099-.001-.142 0-.306-.224-.555-.5-.555-.275 0-.499.249-.499.555l.001.014c0 .041-.002.092 0 .128.006.177.044.312.067.475.042.348.078.637.056.906a.545.545 0 0 1-.162.258l-.012.211a6.424 6.424 0 0 0-4.166 2.003 8.373 8.373 0 0 1-.18-.128c-.09.012-.18.04-.297-.029-.223-.15-.427-.358-.673-.608-.113-.12-.195-.234-.329-.349-.03-.026-.077-.062-.111-.088a.594.594 0 0 0-.348-.132.481.481 0 0 0-.398.176c-.172.216-.117.546.123.737l.007.005.104.083c.142.105.272.159.414.242.299.185.546.338.743.522.076.082.09.226.1.288l.16.143a6.462 6.462 0 0 0-1.02 4.506l-.208.06c-.055.072-.133.184-.215.217-.257.081-.546.11-.895.147-.164.014-.305.006-.48.039-.037.007-.09.02-.133.03l-.004.002-.007.002c-.295.071-.484.342-.423.608.061.267.349.429.645.365l.007-.001.01-.003.129-.029c.17-.046.294-.113.448-.172.33-.118.604-.217.87-.256.112-.009.23.069.288.101l.217-.037a6.5 6.5 0 0 0 2.88 3.596l-.09.218c.033.084.069.199.044.282-.097.252-.263.517-.452.813-.091.136-.185.242-.268.399-.02.037-.045.095-.064.134-.128.275-.034.591.213.71.248.12.556-.007.69-.282v-.002c.02-.039.046-.09.062-.127.07-.162.094-.301.144-.458.132-.332.205-.68.387-.897.05-.06.13-.082.215-.105l.113-.205a6.453 6.453 0 0 0 4.609.012l.106.192c.086.028.18.042.256.155.136.232.229.507.342.84.05.156.074.295.145.457.016.037.043.09.062.129.133.276.442.402.69.282.247-.118.341-.435.213-.71-.02-.039-.045-.096-.065-.134-.083-.156-.177-.261-.268-.398-.19-.296-.346-.541-.443-.793-.04-.13.007-.21.038-.294-.018-.022-.059-.144-.083-.202a6.499 6.499 0 0 0 2.88-3.622c.064.01.176.03.213.038.075-.05.144-.114.28-.104.266.039.54.138.87.256.154.06.277.128.448.173.036.01.088.019.13.028l.009.003.007.001c.297.064.584-.098.645-.365.06-.266-.128-.537-.423-.608zM16.4 9.701l-1.95 1.746v.005a.44.44 0 0 0 .173.757l.003.01 2.526.728a5.199 5.199 0 0 0-.108-1.674A5.208 5.208 0 0 0 16.4 9.7zm-4.013 5.325a.437.437 0 0 0-.404-.232.44.44 0 0 0-.372.233h-.002l-1.268 2.292a5.164 5.164 0 0 0 3.326.003l-1.27-2.296h-.01zm1.888-1.293a.44.44 0 0 0-.27.036.44.44 0 0 0-.214.572l-.003.004 1.01 2.438a5.15 5.15 0 0 0 2.081-2.615l-2.6-.44-.004.005z" },
  helm: { color: "#0F1689", path: "M12.337 0c-.475 0-.861 1.016-.861 2.269 0 .527.069 1.011.183 1.396a8.514 8.514 0 0 0-3.961 1.22 5.229 5.229 0 0 0-.595-1.093c-.606-.866-1.34-1.436-1.79-1.43a.381.381 0 0 0-.217.066c-.39.273-.123 1.326.596 2.353.267.381.559.705.84.948a8.683 8.683 0 0 0-1.528 1.716h1.734a7.179 7.179 0 0 1 5.381-2.421 7.18 7.18 0 0 1 5.382 2.42h1.733a8.687 8.687 0 0 0-1.32-1.53c.35-.249.735-.643 1.078-1.133.719-1.027.986-2.08.596-2.353a.382.382 0 0 0-.217-.065c-.45-.007-1.184.563-1.79 1.43a4.897 4.897 0 0 0-.676 1.325 8.52 8.52 0 0 0-3.899-1.42c.12-.39.193-.887.193-1.429 0-1.253-.386-2.269-.862-2.269zM1.624 9.443v5.162h1.358v-1.968h1.64v1.968h1.357V9.443H4.62v1.838H2.98V9.443zm5.912 0v5.162h3.21v-1.108H8.893v-.95h1.64v-1.142h-1.64v-.84h1.853V9.443zm4.698 0v5.162h3.218v-1.362h-1.86v-3.8zm4.706 0v5.162h1.364v-2.643l1.357 1.225 1.35-1.232v2.65h1.365V9.443h-.614l-2.1 1.914-2.109-1.914zm-11.82 7.28a8.688 8.688 0 0 0 1.412 1.548 5.206 5.206 0 0 0-.841.948c-.719 1.027-.985 2.08-.596 2.353.39.273 1.289-.338 2.007-1.364a5.23 5.23 0 0 0 .595-1.092 8.514 8.514 0 0 0 3.961 1.219 5.01 5.01 0 0 0-.183 1.396c0 1.253.386 2.269.861 2.269.476 0 .862-1.016.862-2.269 0-.542-.072-1.04-.193-1.43a8.52 8.52 0 0 0 3.9-1.42c.121.4.352.865.675 1.327.719 1.026 1.617 1.637 2.007 1.364.39-.273.123-1.326-.596-2.353-.343-.49-.727-.885-1.077-1.135a8.69 8.69 0 0 0 1.202-1.36h-1.771a7.174 7.174 0 0 1-5.227 2.252 7.174 7.174 0 0 1-5.226-2.252z" },
  terraform: { color: "#7B42BC", path: "M1.44 0v7.575l6.561 3.79V3.787zm21.12 4.227l-6.561 3.791v7.574l6.56-3.787zM8.72 4.23v7.575l6.561 3.787V8.018zm0 8.405v7.575L15.28 24v-7.578z" },
  ansible: { color: "#EE0000", path: "M10.617 11.473l4.686 3.695-3.102-7.662zM12 0C5.371 0 0 5.371 0 12s5.371 12 12 12 12-5.371 12-12S18.629 0 12 0zm5.797 17.305c-.011.471-.403.842-.875.83-.236 0-.416-.09-.664-.293l-6.19-5-2.079 5.203H6.191L11.438 5.44c.124-.314.427-.52.764-.506.326-.014.63.189.742.506l4.774 11.494c.045.111.08.234.08.348-.001.009-.001.009-.001.023z" },
  caddy: { color: "#1F88C0", path: "M11.094.47c-.842 0-1.696.092-2.552.288a11.37 11.37 0 0 0-4.87 2.423 10.632 10.632 0 0 0-2.36 2.826A10.132 10.132 0 0 0 .305 8.582c-.398 1.62-.4 3.336-.043 5.048.085.405.183.809.31 1.212a11.85 11.85 0 0 0 1.662 3.729 3.273 3.273 0 0 0-.086.427 3.323 3.323 0 0 0 2.848 3.71 3.279 3.279 0 0 0 1.947-.346c1.045.51 2.17.864 3.339 1.04a11.66 11.66 0 0 0 4.285-.155 11.566 11.566 0 0 0 4.936-2.485 10.643 10.643 0 0 0 2.352-2.894 11.164 11.164 0 0 0 1.356-4.424 11.214 11.214 0 0 0-.498-4.335c.175-.077.338-.175.486-.293a.444.444 89.992 0 0 .001 0c.402-.322.693-.794.777-1.342a2.146 2.146 0 0 0-1.79-2.434 2.115 2.115 0 0 0-1.205.171c-.038-.043-.078-.086-.113-.13a11.693 11.693 0 0 0-3.476-2.93 13.348 13.348 0 0 0-1.76-.81 13.55 13.55 0 0 0-2.06-.613A12.121 12.121 0 0 0 11.093.47Zm.714.328c.345-.004.688.01 1.028.042a9.892 9.892 0 0 1 2.743.639c.984.39 1.89.958 2.707 1.632.803.662 1.502 1.45 2.091 2.328.026.039.048.08.07.12a2.12 2.12 0 0 0-.435 2.646c-.158.114-.97.692-1.634 1.183-.414.308-.733.557-.733.557l.581.68s.296-.276.665-.638c.572-.562 1.229-1.233 1.395-1.403a2.122 2.122 0 0 0 1.907.677 11.229 11.229 0 0 1-.013 4.046 11.41 11.41 0 0 1-1.475 3.897 12.343 12.343 0 0 1-2.079 2.587c-1.19 1.125-2.633 2.022-4.306 2.531a10.826 10.826 0 0 1-3.973.484 11.04 11.04 0 0 1-3.057-.652 3.304 3.304 0 0 0 1.417-2.294 3.275 3.275 0 0 0-.294-1.842c.18-.162.403-.363.656-.6 1.015-.955 2.353-2.303 2.353-2.303l-.47-.599s-1.63.972-2.801 1.728c-.307.198-.573.378-.777.517a3.273 3.273 0 0 0-1.516-.611c-1.507-.198-2.927.672-3.487 2.017a10.323 10.323 0 0 1-.695-1.078A10.92 10.92 0 0 1 .728 14.8a10.35 10.35 0 0 1-.2-1.212c-.164-1.653.103-3.258.629-4.754a12.95 12.95 0 0 1 1.087-2.288c.57-.968 1.248-1.872 2.069-2.656A11.013 11.013 0 0 1 11.808.797Zm-.147 3.257a3.838 3.838 0 0 0-3.82 3.82v2.36h-.94c-.751 0-1.377.625-1.377 1.377v3.8h1.46v-3.718h9.354v6.264H10.02v1.46h6.4c.751 0 1.377-.625 1.377-1.377v-6.43c0-.751-.626-1.377-1.377-1.377h-.94v-2.36a3.838 3.838 0 0 0-3.82-3.819zm0 1.46a2.371 2.371 0 0 1 2.36 2.36v2.36H9.3v-2.36a2.372 2.372 0 0 1 2.36-2.36zm10.141.392a1.253 1.253 0 0 1 1.296 1.434c-.049.319-.217.59-.453.78-.266.213-.61.318-.968.264a1.253 1.253 0 0 1-1.045-1.42 1.255 1.255 0 0 1 1.17-1.058zM5.384 17.425a2.02 2.02 0 0 1 1.917 1.298c.116.3.159.628.114.967a2.015 2.015 0 0 1-2.249 1.728 2.016 2.016 0 0 1-1.727-2.25 2.017 2.017 0 0 1 1.945-1.743z" },
  traefikproxy: { color: "#24A1C1", path: "M12 1.19c1.088 0 2.056.768 2.056 1.714 0 .947-.921 1.715-2.056 1.715-.13 0-.3-.022-.509-.064a.685.685 0 0 0-.475.076l-7.37 4.195a.344.344 0 0 0 .001.597l7.99 4.49c.208.116.461.116.669 0l8.034-4.468a.343.343 0 0 0 .003-.598l-2.507-1.424a.683.683 0 0 0-.67-.003l-2.647 1.468a.234.234 0 0 0-.119.18l-.001.025c0 .946-.921 1.714-2.056 1.714s-2.056-.768-2.056-1.714c0-.947.921-1.715 2.056-1.715.042 0 .09.002.145.007l.087.008.096.013a.685.685 0 0 0 .425-.08l3.913-2.173c.3-.166.662-.171.965-.017l.04.023 5.465 3.104c.686.39.693 1.368.03 1.773l-.037.021-3.656 2.033a.343.343 0 0 0 .007.604l3.62 1.906c.72.378.736 1.402.03 1.804l-10.995 6.272a1.03 1.03 0 0 1-1.019 0L.526 16.43a1.03 1.03 0 0 1 .034-1.806l3.66-1.911a.343.343 0 0 0 .01-.603L.524 10.029a1.03 1.03 0 0 1-.041-1.77l.036-.021L9.618 3.06a.688.688 0 0 0 .308-.369l.011-.036c.32-.952 1.046-1.466 2.063-1.466Zm5.076 12.63-4.492 2.586-.041.022c-.306.158-.671.152-.973-.018l-4.478-2.527a.682.682 0 0 0-.65-.01L3.86 15.224a.343.343 0 0 0-.012.602l7.887 4.515c.21.12.467.121.677 0l7.956-4.547a.343.343 0 0 0-.01-.602l-2.623-1.384a.683.683 0 0 0-.659.012z" },
  wireguard: { color: "#88171A", path: "M23.98 11.645S24.533 0 11.735 0C.418 0 .064 11.17.064 11.17S-1.6 24 11.997 24C25.04 24 23.98 11.645 23.98 11.645zM8.155 7.576c2.4-1.47 5.469-.571 6.618 1.638.218.419.246 1.063.108 1.503-.477 1.516-1.601 2.366-3.145 2.728.455-.39.817-.832.933-1.442a2.112 2.112 0 0 0-.364-1.677 2.14 2.14 0 0 0-2.465-.75c-.95.36-1.47 1.228-1.377 2.294.087.99.839 1.632 2.245 1.876-.21.111-.372.193-.53.281a5.113 5.113 0 0 0-1.644 1.43c-.143.192-.24.208-.458.075-2.827-1.729-3.009-6.067.078-7.956zM6.04 18.258c-.455.116-.895.286-1.359.438.227-1.532 2.021-2.943 3.539-2.782a3.91 3.91 0 0 0-.74 2.072c-.504.093-.98.155-1.44.272zM15.703 3.3c.448.017.898.01 1.347.02a2.324 2.324 0 0 1 .334.047 3.249 3.249 0 0 1-.34.434c-.16.15-.341.296-.573.069-.055-.055-.187-.042-.283-.044-.447-.005-.894-.02-1.34-.003a8.323 8.323 0 0 0-1.154.118c-.072.013-.178.25-.146.338.078.207.191.435.359.567.619.49 1.277.928 1.9 1.413.604.472 1.167.99 1.51 1.7.446.928.46 1.9.267 2.877-.322 1.63-1.147 2.98-2.483 3.962-.538.395-1.205.62-1.821.903-.543.25-1.1.465-1.644.712-.98.446-1.53 1.51-1.369 2.615.149 1.015 1.04 1.862 2.059 2.037 1.223.21 2.486-.586 2.785-1.83.336-1.397-.423-2.646-1.845-3.024l-.256-.066c.38-.17.708-.291 1.012-.458q.793-.437 1.558-.925c.15-.096.231-.096.36.014.977.846 1.56 1.898 1.724 3.187.27 2.135-.74 4.096-2.646 5.101-2.948 1.555-6.557-.215-7.208-3.484-.558-2.8 1.418-5.34 3.797-5.83 1.023-.211 1.958-.637 2.685-1.425.47-.508.697-.944.775-1.141a3.165 3.165 0 0 0 .217-1.158 2.71 2.71 0 0 0-.237-.992c-.248-.566-1.2-1.466-1.435-1.656l-2.24-1.754c-.079-.065-.168-.06-.36-.047-.23.016-.815.048-1.067-.018.204-.155.76-.38 1-.56-.726-.49-1.554-.314-2.315-.46.176-.328 1.046-.831 1.541-.888a7.323 7.323 0 0 0-.135-.822c-.03-.111-.154-.22-.263-.283-.262-.154-.541-.281-.843-.434a1.755 1.755 0 0 1 .906-.28 3.385 3.385 0 0 1 .908.088c.54.123.97.042 1.399-.324-.338-.136-.676-.26-1.003-.407a9.843 9.843 0 0 1-.942-.493c.85.118 1.671.437 2.54.32l.022-.118-2.018-.47c1.203-.11 2.323-.128 3.384.388.299.146.61.266.897.432.14.08.233.24.348.365.09.098.164.23.276.29.424.225.89.234 1.366.223l.01-.16c.479.15 1.017.702 1.017 1.105-.776 0-1.55-.003-2.325.004-.083 0-.165.061-.247.094.078.046.155.128.235.131z M14.703 2.153a.118.118 0 0 0-.016.19.179.179 0 0 0 .246.065c.075-.038.148-.078.238-.125-.072-.062-.13-.114-.19-.163-.106-.087-.193-.032-.278.033z" },
  zerotier: { color: "#FFB441", path: "M4.01 0A3.999 3.999 0 0 0 .014 4v16c0 2.209 1.79 4 3.996 4h15.98a3.998 3.998 0 0 0 3.996-4V4c0-2.209-1.79-4-3.996-4zm-.672 2.834h17.326a.568.568 0 1 1 0 1.137h-8.129c.021.059.033.123.033.19v1.804A6.06 6.06 0 0 1 18.057 12c0 3.157-2.41 5.75-5.489 6.037v2.56a.568.568 0 1 1-1.136 0v-2.56A6.061 6.061 0 0 1 5.943 12a6.06 6.06 0 0 1 5.489-6.035V4.16c0-.066.012-.13.033-.19H3.338a.568.568 0 1 1 0-1.136zm8.094 4.307A4.89 4.89 0 0 0 7.113 12a4.89 4.89 0 0 0 4.319 4.86zm1.136 0v9.718A4.892 4.892 0 0 0 16.888 12a4.892 4.892 0 0 0-4.32-4.86z" },
  pytorch: { color: "#EE4C2C", path: "M12.005 0L4.952 7.053a9.865 9.865 0 000 14.022 9.866 9.866 0 0014.022 0c3.984-3.9 3.986-10.205.085-14.023l-1.744 1.743c2.904 2.905 2.904 7.634 0 10.538s-7.634 2.904-10.538 0-2.904-7.634 0-10.538l4.647-4.646.582-.665zm3.568 3.899a1.327 1.327 0 00-1.327 1.327 1.327 1.327 0 001.327 1.328A1.327 1.327 0 0016.9 5.226 1.327 1.327 0 0015.573 3.9z" },
  tensorflow: { color: "#FF6F00", path: "M1.292 5.856L11.54 0v24l-4.095-2.378V7.603l-6.168 3.564.015-5.31zm21.43 5.311l-.014-5.31L12.46 0v24l4.095-2.378V14.87l3.092 1.788-.018-4.618-3.074-1.756V7.603l6.168 3.564z" },
  onnx: { color: "#005CED", path: "M23.0325 11.2963c-.0503 0-.1006 0-.1508.0126l-4.021-7.4387c.0754-.1383.1131-.289.1131-.4524 0-.5403-.4398-.9675-.9675-.9675-.2765 0-.5278.113-.7037.3015L9.286 1.156C9.2357.6785 8.821.3016 8.3184.3016c-.5277 0-.9675.4398-.9675.9675 0 .1634.0377.3141.113.4524l-6.245 8.9591c-.0753-.0251-.1633-.0377-.2513-.0377-.5403 0-.9675.4398-.9675.9676 0 .5403.4398.9675.9675.9675h.0377l3.3676 8.3309c-.0503.1257-.088.2639-.088.402 0 .5404.4398.9676.9676.9676.2764 0 .5277-.113.7036-.3015l10.1152.9926c.1005.4273.49.7288.9424.7288.5403 0 .9676-.4398.9676-.9675 0-.2388-.088-.465-.2262-.6283l5.1141-8.8712c.0503.0126.1005.0126.1634.0126.5403 0 .9675-.4398.9675-.9676 0-.5403-.4272-.98-.9675-.98zM17.2272 4.021c.1131.1508.2765.264.4524.3267l-1.533 11.5728c-.1005.0252-.1885.0503-.2764.1005L7.4513 8.708c.0251-.0754.0377-.1634.0377-.2514 0-.0628-.0126-.1256-.0126-.1884zm4.8754 8.5068l-5.177 3.556a1.105 1.105 0 0 0-.1256-.0753L18.3455 4.335h.0126l3.9456 7.288c-.1508.1759-.2388.3895-.2388.6408 0 .1005.0126.1885.0377.2638zM6.3832 7.5016c-.4649.0754-.8293.4775-.8293.955v.0628l-3.4555 2.0481 5.378-7.7026zm.3519 1.91c.1256-.0252.2513-.088.3518-.1634l8.356 7.2628c-.0377.113-.0628.2262-.0628.3518v.0503l-9.311 3.845c-.1382-.201-.3518-.3518-.6031-.402zm8.8963 8.1172c.1257.1382.3016.2513.5026.289l.465 4.046c-.201.1006-.3519.264-.4524.4524l-9.8136-.955zm1.1435.2136c.3267-.1633.5403-.49.5403-.867 0-.088-.0126-.1634-.0377-.2513l4.7372-3.2545-4.8 8.331zm.2513-14.3497l-9.889 4.31-.1131-.0755 1.2565-5.3906h.0377c.3393 0 .6409-.1759.8168-.4397l7.891 1.5706zM1.935 11.6105c0-.0629-.0126-.1257-.0126-.1885l3.9079-2.2995c.0754.0754.1633.1508.2638.201L4.8252 20.243l-3.2043-7.9036c.1885-.176.3142-.4398.3142-.7288Z" },
  opencv: { color: "#5C3EE8", path: "M11.8992.8525C8.735.8525 6.17 3.4175 6.17 6.5817c0 2.102 1.1321 3.9398 2.8198 4.9366l1.6412-2.7849c.0411-.0699.0176-.1593-.0495-.2048-.6233-.4227-1.0328-1.137-1.0328-1.947 0-1.298 1.0524-2.3504 2.3505-2.3504 1.2981 0 2.3505 1.0524 2.3505 2.3505 0 .8098-.4095 1.5242-1.0328 1.947-.0671.0454-.0907.1348-.0495.2047l1.6414 2.785c1.6878-.9969 2.8199-2.8346 2.8199-4.9367 0-3.1642-2.5653-5.7292-5.7295-5.7292zm-6.17 10.8366C2.565 11.6891 0 14.2541 0 17.4183c0 3.1642 2.565 5.7292 5.7292 5.7292 3.1798 0 5.8074-2.6995 5.7275-5.8762H8.2313c-.0847 0-.1513.0717-.1519.1564-.0082 1.266-1.0644 2.3411-2.3502 2.3411-1.2981 0-2.3505-1.0524-2.3505-2.3505 0-1.2982 1.0524-2.3505 2.3505-2.3505.34 0 .663.0724.9547.2022.0713.0318.1566.0077.1962-.0595l1.6464-2.7935c-.8273-.4636-1.7815-.7279-2.7973-.7279zm15.4424.7614l-1.6366 2.7878c-.041.07-.0172.1594.05.2048.624.4217 1.0348 1.1354 1.0363 1.9452.0022 1.298-1.0483 2.352-2.3465 2.3542-1.298.0023-2.3523-1.0482-2.3545-2.3462-.0015-.8098.4068-1.5248 1.0294-1.9486.067-.0457.0905-.1353.0492-.2051l-1.6464-2.7818c-1.6859.9998-2.8146 2.8394-2.811 4.9415.0056 3.1641 2.575 5.7248 5.7393 5.7192 3.1641-.0054 5.7246-2.575 5.7192-5.7392-.0037-2.1022-1.139-3.938-2.8284-4.9318z" },
  ollama: { color: "currentColor", path: "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z" },
  huggingface: { color: "#FFD21E", path: "M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624" },
  ubuntu: { color: "#E95420", path: "M17.61.455a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zM12.92.8C8.923.777 5.137 2.941 3.148 6.451a4.5 4.5 0 0 1 .26-.007 4.92 4.92 0 0 1 2.585.737A8.316 8.316 0 0 1 12.688 3.6 4.944 4.944 0 0 1 13.723.834 11.008 11.008 0 0 0 12.92.8zm9.226 4.994a4.915 4.915 0 0 1-1.918 2.246 8.36 8.36 0 0 1-.273 8.303 4.89 4.89 0 0 1 1.632 2.54 11.156 11.156 0 0 0 .559-13.089zM3.41 7.932A3.41 3.41 0 0 0 0 11.342a3.41 3.41 0 0 0 3.41 3.409 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zm2.027 7.866a4.908 4.908 0 0 1-2.915.358 11.1 11.1 0 0 0 7.991 6.698 11.234 11.234 0 0 0 2.422.249 4.879 4.879 0 0 1-.999-2.85 8.484 8.484 0 0 1-.836-.136 8.304 8.304 0 0 1-5.663-4.32zm11.405.928a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41z" },
  debian: { color: "#A81D33", path: "M13.88 12.685c-.4 0 .08.2.601.28.14-.1.27-.22.39-.33a3.001 3.001 0 01-.99.05m2.14-.53c.23-.33.4-.69.47-1.06-.06.27-.2.5-.33.73-.75.47-.07-.27 0-.56-.8 1.01-.11.6-.14.89m.781-2.05c.05-.721-.14-.501-.2-.221.07.04.13.5.2.22M12.38.31c.2.04.45.07.42.12.23-.05.28-.1-.43-.12m.43.12l-.15.03.14-.01V.43m6.633 9.944c.02.64-.2.95-.38 1.5l-.35.181c-.28.54.03.35-.17.78-.44.39-1.34 1.22-1.62 1.301-.201 0 .14-.25.19-.34-.591.4-.481.6-1.371.85l-.03-.06c-2.221 1.04-5.303-1.02-5.253-3.842-.03.17-.07.13-.12.2a3.551 3.552 0 012.001-3.501 3.361 3.362 0 013.732.48 3.341 3.342 0 00-2.721-1.3c-1.18.01-2.281.76-2.651 1.57-.6.38-.67 1.47-.93 1.661-.361 2.601.66 3.722 2.38 5.042.27.19.08.21.12.35a4.702 4.702 0 01-1.53-1.16c.23.33.47.66.8.91-.55-.18-1.27-1.3-1.48-1.35.93 1.66 3.78 2.921 5.261 2.3a6.203 6.203 0 01-2.33-.28c-.33-.16-.77-.51-.7-.57a5.802 5.803 0 005.902-.84c.44-.35.93-.94 1.07-.95-.2.32.04.16-.12.44.44-.72-.2-.3.46-1.24l.24.33c-.09-.6.74-1.321.66-2.262.19-.3.2.3 0 .97.29-.74.08-.85.15-1.46.08.2.18.42.23.63-.18-.7.2-1.2.28-1.6-.09-.05-.28.3-.32-.53 0-.37.1-.2.14-.28-.08-.05-.26-.32-.38-.861.08-.13.22.33.34.34-.08-.42-.2-.75-.2-1.08-.34-.68-.12.1-.4-.3-.34-1.091.3-.25.34-.74.54.77.84 1.96.981 2.46-.1-.6-.28-1.2-.49-1.76.16.07-.26-1.241.21-.37A7.823 7.824 0 0017.702 1.6c.18.17.42.39.33.42-.75-.45-.62-.48-.73-.67-.61-.25-.65.02-1.06 0C15.082.73 14.862.8 13.8.4l.05.23c-.77-.25-.9.1-1.73 0-.05-.04.27-.14.53-.18-.741.1-.701-.14-1.431.03.17-.13.36-.21.55-.32-.6.04-1.44.35-1.18.07C9.6.68 7.847 1.3 6.867 2.22L6.838 2c-.45.54-1.96 1.611-2.08 2.311l-.131.03c-.23.4-.38.85-.57 1.261-.3.52-.45.2-.4.28-.6 1.22-.9 2.251-1.16 3.102.18.27 0 1.65.07 2.76-.3 5.463 3.84 10.776 8.363 12.006.67.23 1.65.23 2.49.25-.99-.28-1.12-.15-2.08-.49-.7-.32-.85-.7-1.34-1.13l.2.35c-.971-.34-.57-.42-1.361-.67l.21-.27c-.31-.03-.83-.53-.97-.81l-.34.01c-.41-.501-.63-.871-.61-1.161l-.111.2c-.13-.21-1.52-1.901-.8-1.511-.13-.12-.31-.2-.5-.55l.14-.17c-.35-.44-.64-1.02-.62-1.2.2.24.32.3.45.33-.88-2.172-.93-.12-1.601-2.202l.15-.02c-.1-.16-.18-.34-.26-.51l.06-.6c-.63-.74-.18-3.102-.09-4.402.07-.54.53-1.1.88-1.981l-.21-.04c.4-.71 2.341-2.872 3.241-2.761.43-.55-.09 0-.18-.14.96-.991 1.26-.7 1.901-.88.7-.401-.6.16-.27-.151 1.2-.3.85-.7 2.421-.85.16.1-.39.14-.52.26 1-.49 3.151-.37 4.562.27 1.63.77 3.461 3.011 3.531 5.132l.08.02c-.04.85.13 1.821-.17 2.711l.2-.42M9.54 13.236l-.05.28c.26.35.47.73.8 1.01-.24-.47-.42-.66-.75-1.3m.62-.02c-.14-.15-.22-.34-.31-.52.08.32.26.6.43.88l-.12-.36m10.945-2.382l-.07.15c-.1.76-.34 1.511-.69 2.212.4-.73.65-1.541.75-2.362M12.45.12c.27-.1.66-.05.95-.12-.37.03-.74.05-1.1.1l.15.02M3.006 5.142c.07.57-.43.8.11.42.3-.66-.11-.18-.1-.42m-.64 2.661c.12-.39.15-.62.2-.84-.35.44-.17.53-.2.83" },
  archlinux: { color: "#1793D1", path: "M11.39.605C10.376 3.092 9.764 4.72 8.635 7.132c.693.734 1.543 1.589 2.923 2.554-1.484-.61-2.496-1.224-3.252-1.86C6.86 10.842 4.596 15.138 0 23.395c3.612-2.085 6.412-3.37 9.021-3.862a6.61 6.61 0 01-.171-1.547l.003-.115c.058-2.315 1.261-4.095 2.687-3.973 1.426.12 2.534 2.096 2.478 4.409a6.52 6.52 0 01-.146 1.243c2.58.505 5.352 1.787 8.914 3.844-.702-1.293-1.33-2.459-1.929-3.57-.943-.73-1.926-1.682-3.933-2.713 1.38.359 2.367.772 3.137 1.234-6.09-11.334-6.582-12.84-8.67-17.74zM22.898 21.36v-.623h-.234v-.084h.562v.084h-.234v.623h.331v-.707h.142l.167.5.034.107a2.26 2.26 0 01.038-.114l.17-.493H24v.707h-.091v-.593l-.206.593h-.084l-.205-.602v.602h-.091" },
  alpinelinux: { color: "#0D597F", path: "M5.998 1.607L0 12l5.998 10.393h12.004L24 12 18.002 1.607H5.998zM9.965 7.12L12.66 9.9l1.598 1.595.002-.002 2.41 2.363c-.2.14-.386.252-.563.344a3.756 3.756 0 01-.496.217 2.702 2.702 0 01-.425.111c-.131.023-.25.034-.358.034-.13 0-.242-.014-.338-.034a1.317 1.317 0 01-.24-.072.95.95 0 01-.2-.113l-1.062-1.092-3.039-3.041-1.1 1.053-3.07 3.072a.974.974 0 01-.2.111 1.274 1.274 0 01-.237.073c-.096.02-.209.033-.338.033-.108 0-.227-.009-.358-.031a2.7 2.7 0 01-.425-.114 3.748 3.748 0 01-.496-.217 5.228 5.228 0 01-.563-.343l6.803-6.727zm4.72.785l4.579 4.598 1.382 1.353a5.24 5.24 0 01-.564.344 3.73 3.73 0 01-.494.217 2.697 2.697 0 01-.426.111c-.13.023-.251.034-.36.034-.129 0-.241-.014-.337-.034a1.285 1.285 0 01-.385-.146c-.033-.02-.05-.036-.053-.04l-1.232-1.218-2.111-2.111-.334.334L12.79 9.8l1.896-1.897zm-5.966 4.12v2.529a2.128 2.128 0 01-.356-.035 2.765 2.765 0 01-.422-.116 3.708 3.708 0 01-.488-.214 5.217 5.217 0 01-.555-.34l1.82-1.825Z" },
  fedora: { color: "#51A2DA", path: "M12.001 0C5.376 0 .008 5.369.004 11.992H.002v9.287h.002A2.726 2.726 0 0 0 2.73 24h9.275c6.626-.004 11.993-5.372 11.993-11.997C23.998 5.375 18.628 0 12 0zm2.431 4.94c2.015 0 3.917 1.543 3.917 3.671 0 .197.001.395-.03.619a1.002 1.002 0 0 1-1.137.893 1.002 1.002 0 0 1-.842-1.175 2.61 2.61 0 0 0 .013-.337c0-1.207-.987-1.672-1.92-1.672-.934 0-1.775.784-1.777 1.672.016 1.027 0 2.046 0 3.07l1.732-.012c1.352-.028 1.368 2.009.016 1.998l-1.748.013c-.004.826.006.677.002 1.093 0 0 .015 1.01-.016 1.776-.209 2.25-2.124 4.046-4.424 4.046-2.438 0-4.448-1.993-4.448-4.437.073-2.515 2.078-4.492 4.603-4.469l1.409-.01v1.996l-1.409.013h-.007c-1.388.04-2.577.984-2.6 2.47a2.438 2.438 0 0 0 2.452 2.439c1.356 0 2.441-.987 2.441-2.437l-.001-7.557c0-.14.005-.252.02-.407.23-1.848 1.883-3.256 3.754-3.256z" },
  raspberrypi: { color: "#A22846", path: "m19.8955 10.8961-.1726-.3028c.0068-2.1746-1.0022-3.061-2.1788-3.7348.356-.0938.7237-.1711.8245-.6182.6118-.1566.7397-.4398.8011-.7398.16-.1066.6955-.4061.6394-.9211.2998-.2069.4669-.4725.3819-.8487.3222-.3515.407-.6419.2702-.9096.3868-.4805.2152-.7295.05-.9817.2897-.5254.0341-1.0887-.7758-.9944-.3221-.4733-1.0244-.3659-1.133-.3637-.1215-.1519-.2819-.2821-.7755-.219-.3197-.2851-.6771-.2364-1.0458-.0964-.4378-.3403-.7275-.0675-1.0584.0356-.53-.1706-.6513.0631-.9117.1583-.5781-.1203-.7538.1416-1.0309.4182l-.3224-.0063c-.8719.5061-1.305 1.5366-1.4585 2.0664-.1536-.5299-.5858-1.5604-1.4575-2.0664l-.3223.0063C9.942.5014 9.7663.2394 9.1883.3597 8.9279.2646 8.807.0309 8.2766.2015c-.2172-.0677-.417-.2084-.6522-.2012l.0004.0002C7.5017.0041 7.369.049 7.2185.166c-.3688-.1401-.7262-.1887-1.0459.0964-.4936-.0631-.654.0671-.7756.219C5.2887.4791 4.5862.3717 4.264.845c-.8096-.0943-1.0655.4691-.7756.9944-.1653.2521-.3366.5013.05.9819-.1367.2677-.0519.5581.2703.9096-.085.3763.0822.6418.3819.8487-.0561.515.4795.8144.6394.9211.0614.3001.1894.5832.8011.7398.1008.4472.4685.5244.8245.6183-1.1766.6737-2.1856 1.56-2.1788 3.7348l-.1724.3028c-1.3491.8082-2.5629 3.4056-.6648 5.5167.124.6609.3319 1.1355.5171 1.6609.2769 2.117 2.0841 3.1082 2.5608 3.2255.6984.524 1.4423 1.0212 2.449 1.3696.949.964 1.977 1.3314 3.0107 1.3308.0152 0 .0306.0002.0457 0 1.0337.0006 2.0618-.3668 3.0107-1.3308 1.0067-.3483 1.7506-.8456 2.4491-1.3696.4766-.1173 2.2838-1.1085 2.5607-3.2255.1851-.5253.3931-1 .517-1.6609 1.8981-2.1113.6843-4.7089-.6649-5.517zm-1.0386-.3715c-.0704.8759-4.6354-3.0504-3.8472-3.1808 2.1391-.3558 3.9191.896 3.8472 3.1808zm-2.0155 4.3649c-1.1481.7409-2.8025.2626-3.6953-1.0681-.8928-1.3306-.6858-3.0101.4623-3.7509 1.1481-.7409 2.8025-.2627 3.6953 1.068.8927 1.3307.6858 3.0101-.4623 3.751zM13.6591 1.3721c.0396.1967.0843.321.1354.3577.2537-.272.4611-.5506.7878-.8123.0011.1537-.0776.3205.1169.4425.1752-.2356.4119-.4459.7263-.6244-.1514.2611-.026.3404.0554.4486.24-.2059.4681-.4144.9109-.5759-.121.1474-.2902.2914-.1108.4607.2473-.1544.496-.3086 1.0833-.4183-.1323.1475-.4059.295-.2401.4426.3104-.1186.6539-.2047 1.034-.2546-.182.1496-.3337.2963-.1846.4122.3323-.1022.7899-.2398 1.2372-.1212l-.2832.2849c-.0314.0382.6623.0297 1.1202.0364-.167.2321-.3375.4562-.437.8548.0454.0459.2723.0204.4862 0-.2194.4618-.6004.5783-.6893.776.134.1015.32.075.5232.006-.158.3254-.4892.5484-.7509.8123.0662.047.1818.075.4555.0425-.2418.257-.5339.492-.8802.7032.0614.0708.2722.0681.4678.0727-.3136.3069-.7173.466-1.0955.6668.1885.1288.3234.0988.4678.097-.2676.2198-.7225.3342-1.1448.4668.0803.1249.1607.1589.3324.194-.447.2473-1.0873.1343-1.2679.2607.0435.1243.1665.2053.3139.2728-.7197.0418-2.6879-.0262-3.0652-1.5156.7367-.8094 2.0813-1.7593 4.394-2.934-1.7994.6022-3.4229 1.405-4.7817 2.5096-1.5978-.7436-.4965-2.6197.283-3.3645zm-1.6126 5.3718c1.1329-.0123 2.5356.8325 2.53 1.6286-.005.7027-.9851 1.2715-2.5213 1.2607-1.5043-.0177-2.5172-.7148-2.5137-1.3957.003-.5603 1.2282-1.5263 2.505-1.4936zm-5.7646-.6006c.1717-.0351.252-.0692.3323-.194-.4223-.1327-.8772-.247-1.1448-.4668.1444.0018.2792.0318.4678-.097-.3783-.2008-.782-.3599-1.0956-.6668.1955-.0048.4064-.002.4677-.0728-.3462-.2113-.6383-.4463-.8801-.7033.2738.0325.3893.0045.4555-.0425-.2617-.264-.593-.487-.7509-.8123.2032.069.3892.0954.5232-.006-.089-.1977-.47-.3142-.6894-.776.214.0204.4409.0459.4863 0-.0994-.3985-.2698-.6226-.4369-.8547.4579-.0067 1.1516.0018 1.1202-.0364l-.2831-.2849c.4472-.1186.9049.019 1.2371.1213.1492-.1159-.0026-.2626-.1847-.4123.3801.05.7236.1361 1.034.2547.1659-.1476-.1076-.2951-.24-.4426.5872.1097.8361.2639 1.0833.4183.1794-.1694.0103-.3133-.1108-.4607.4428.1615.6709.37.911.5759.0814-.1082.2068-.1875.0554-.4486.3143.1785.5511.3888.7263.6244.1945-.122.1159-.2888.1169-.4426.3267.2618.534.5404.7879.8124.0511-.0366.0959-.161.1354-.3577.7794.7448 1.8807 2.6208.2831 3.3646-1.3589-1.1039-2.9817-1.9064-4.78-2.5086 2.3115 1.174 3.6556 2.1239 4.392 2.9328-.3773 1.4895-2.3455 1.5575-3.0651 1.5157.1473-.0676.2703-.1485.3139-.2728-.1806-.1264-.8209-.0134-1.2679-.2607zm2.8175 1.1334c.7881.1304-3.7769 4.0567-3.8472 3.1809-.0719-2.2846 1.7079-3.5367 3.8472-3.1809zm-4.847 8.7567c-1.1094-.8789-1.4668-3.4529.5901-4.6097 1.2394-.3273.4184 5.051-.5901 4.6097zm4.2656 4.5989c-.6257.3719-2.1452.2187-3.2252-1.3095-.7283-1.2823-.6345-2.5872-.123-2.9705.7648-.4589 1.9464.1609 2.8559 1.2003.7923.9405 1.1536 2.5927.4923 3.0797zm-1.2415-5.6086c-1.1481-.7409-1.3551-2.4203-.4623-3.7511.8928-1.3307 2.5472-1.8089 3.6952-1.068 1.1481.7409 1.3551 2.4203.4623 3.7509-.8926 1.3308-2.5471 1.809-3.6952 1.0682zm4.7948 8.2279c-1.3763.0584-2.7258-1.1105-2.7081-1.5157-.0206-.594 1.6758-1.0578 2.782-1.0306 1.1131-.0479 2.6068.3531 2.6097.8851.0184.5166-1.3547 1.6838-2.6836 1.6612zm2.7584-5.8578c.0081 1.3899-1.226 2.5225-2.7562 2.5299-1.5302.0073-2.7773-1.1135-2.7854-2.5033v-.0265c-.008-1.3899 1.2259-2.5226 2.7562-2.5299 1.5302-.0073 2.7773 1.1134 2.7853 2.5033a.7794.7794 0 0 1 .0001.0265zm3.855 2.0029c-1.186 1.6208-2.7916 1.684-3.3896 1.2325-.6255-.5811-.148-2.3854.7094-3.3747v-.0003c.9812-1.0912 2.0302-1.8037 2.7609-1.2469.4919.4828.7805 2.3008-.0807 3.3894zm1.0724-3.4301c-1.0086.4413-1.8298-4.9372-.5901-4.61 2.0568 1.1569 1.6994 3.731.5901 4.61zm-.0256-8.3279h.2985v-.5304h.2986c.1502 0 .2053.0624.2262.2052.0152.1088.0113.2395.0477.3253h.2984c-.0533-.0763-.0515-.2358-.0571-.3213-.0097-.1373-.0513-.2796-.1977-.3176v-.0037c.1502-.061.2149-.1807.2149-.341 0-.2048-.1539-.3738-.3974-.3738h-.732v1.3573zm.2985-1.1255h.3269c.1333 0 .2054.0573.2054.188 0 .1369-.0721.1942-.2054.1942H20.03v-.3822zm-1.0337.4633c0 .7009.5682 1.2694 1.2695 1.2694s1.2695-.5684 1.2695-1.2694c0-.7013-.5683-1.2697-1.2695-1.2697-.7013 0-1.2695.5684-1.2695 1.2697zm2.3275 0c0 .5845-.4737 1.058-1.058 1.058s-1.058-.4735-1.058-1.058c0-.5849.4737-1.058 1.058-1.058s1.058.4731 1.058 1.058z" },
  homebrew: { color: "#FBB040", path: "M7.938 0a.214.214 0 0 0-.206.156c-.316 1.104.179 2.15.838 2.935.153.181.313.347.476.501a2.039 2.039 0 0 0-.665.02c-1.184.233-2.193.985-2.74 2.532a3.893 3.893 0 0 0-.2 1.466 1.565 1.565 0 0 0-1.156 1.504 1.59 1.59 0 0 0 1.227 1.541l.026 12.046c0 .195.1.377.264.482a.214.214 0 0 0 .008.005c.537.31 2.047.812 5.21.812 3.238 0 4.7-.678 5.181-1.04a.214.214 0 0 0 .008-.007.571.571 0 0 0 .206-.439c.002-.344.002-1.136.002-1.604a.143.143 0 0 1 .147-.144c.397.006.869.006 1.318.005a1.826 1.826 0 0 0 1.832-1.825v-5.804a1.826 1.826 0 0 0-1.825-1.826H16.56a.14.14 0 0 1-.143-.144V10.6h.007v-.001a1.573 1.573 0 0 0 1.356-1.556c0-.816-.627-1.489-1.424-1.563-.025-1.438-.437-2.126-.736-2.58a.214.214 0 0 0-.005-.007c-.364-.51-1.193-1.282-2.275-1.316-.503-.016-.842.124-1.125.254-.217.1-.42.177-.67.22.002-1.286.945-1.981.945-1.981a.214.214 0 0 0 .05-.298s-.087-.122-.21-.26c-.121-.136-.269-.294-.47-.378a.214.214 0 0 0-.079-.017.214.214 0 0 0-.145.055 4.308 4.308 0 0 0-.875 1.101 3.42 3.42 0 0 0-.133.273 3.497 3.497 0 0 0-.381-.846C9.794.978 9.063.436 8.017.016A.214.214 0 0 0 7.939 0zm.156.524c.85.378 1.43.83 1.79 1.403.274.438.426.962.484 1.584a3.07 3.07 0 0 0-.012.462 6.897 6.897 0 0 1-.168-.052 5.487 5.487 0 0 1-1.29-1.106c-.551-.657-.935-1.46-.804-2.291zM11.8 1.618c.07.054.141.101.212.18.034.039.032.04.058.073-.332.308-1.07 1.144-.952 2.453a.214.214 0 0 0 .222.195c.469-.017.782-.172 1.056-.299.273-.126.508-.228.931-.214.875.027 1.639.715 1.939 1.134.295.449.65 1 .663 2.36a1.66 1.66 0 0 0-.41.142 1.938 1.938 0 0 0-1.77-1.16 1.94 1.94 0 0 0-1.87 1.448 1.783 1.783 0 0 0-1.356-.64c-.484 0-.91.205-1.233.517a1.873 1.873 0 0 0-1.85-1.625c-.649 0-1.218.335-1.552.84a3.1 3.1 0 0 1 .157-.735c.51-1.437 1.355-2.045 2.42-2.254.367-.073.664-.011.99.095.325.106.671.262 1.094.342a.214.214 0 0 0 .252-.245c-.112-.67.073-1.266.336-1.744a3.71 3.71 0 0 1 .663-.863zM7.44 6.611a1.442 1.442 0 0 1 1.363 1.925.214.214 0 0 0 .168.283h.005a.214.214 0 0 0 .238-.146 1.373 1.373 0 0 1 2.613-.01.214.214 0 0 0 .417-.09 1.509 1.509 0 0 1 1.504-1.664c.678 0 1.249.445 1.442 1.056a.214.214 0 0 0 .259.143l.15-.04a.214.214 0 0 0 .051-.02 1.139 1.139 0 0 1 1.702.995 1.14 1.14 0 0 1-.985 1.131.214.214 0 0 0-.001 0 2.215 2.215 0 0 0-.485.126 10.65 10.65 0 0 1-1.176.365.214.214 0 0 0-.162.186 1.276 1.276 0 0 1-.146.478 2.07 2.07 0 0 0-.239 1.111l.001.151a.438.438 0 0 1-.16.36.665.665 0 0 1-.43.14.586.586 0 0 1-.588-.59.803.803 0 0 0-.38-.681.214.214 0 0 0-.002-.002c-.24-.145-.43-.37-.532-.636a.214.214 0 0 0-.207-.138 19.469 19.469 0 0 1-5.37-.6l-.003-.002a9.007 9.007 0 0 0-.838-.194h.003a1.16 1.16 0 0 1-.937-1.134c0-.619.488-1.118 1.101-1.14a.214.214 0 0 0 .204-.176 1.443 1.443 0 0 1 1.42-1.187zm8.549 4.106v.455c0 .314.259.573.572.573h1.329a1.397 1.397 0 0 1 1.397 1.397v5.804a1.396 1.396 0 0 1-1.402 1.396.214.214 0 0 0-.002 0c-.448.002-.918 0-1.31-.005a.573.573 0 0 0-.584.573c0 .468 0 1.262-.002 1.603a.214.214 0 0 0 0 .001c0 .042-.019.08-.05.107-.346.26-1.75.95-4.915.95-3.107 0-4.587-.52-4.99-.752a.143.143 0 0 1-.065-.118l-.025-11.955c.145.033.288.07.431.11a.214.214 0 0 0 .003 0c.115.031.246.064.383.097v10.37c0 .129.069.247.18.31.453.217 1.767.732 4.071.732 2.32 0 3.595-.626 4.022-.884a.357.357 0 0 0 .164-.3l.001-10.21c.267-.075.531-.158.792-.254zm-7.99.894a.493.493 0 0 1 .494.493v8.578a.493.493 0 0 1-.493.493.493.493 0 0 1-.494-.493v-8.578A.493.493 0 0 1 8 11.611zm8.652 1.14a.663.663 0 0 0-.662.662v5.208a.663.663 0 0 0 .662.662h1.14a.663.663 0 0 0 .662-.662v-5.209a.663.663 0 0 0-.662-.662zm0 .428h1.14a.233.233 0 0 1 .233.233v5.21a.233.233 0 0 1-.233.232h-1.14a.233.233 0 0 1-.233-.233v-5.209a.233.233 0 0 1 .233-.233z" },
  pypi: { color: "#3775A9", path: "M23.922 13.58v3.912L20.55 18.72l-.078.055.052.037 3.45-1.256.026-.036v-3.997l-.053-.036-.025.092z M23.621 5.618l-3.04 1.107v3.912l3.339-1.215V5.509zM23.92 13.457V9.544l-3.336 1.215v3.913zM20.47 14.71V10.8L17.17 12v3.913zM17.034 19.996v-3.912l-3.313 1.206v3.912zM17.17 16.057v3.868l3.314-1.206V14.85l-3.314 1.206zm2.093 1.882c-.367.134-.663-.074-.663-.463s.296-.814.663-.947c.365-.133.662.075.662.464s-.297.814-.662.946z M13.225 9.315l.365-.132-3.285-1.197-3.323 1.21.102.037 3.184 1.16zM20.507 10.664V6.751L17.17 7.965v3.913zM17.058 11.918V8.005l-3.302 1.202v3.912zM13.643 9.246l-3.336 1.215v3.913l3.336-1.215zM6.907 13.165l3.322 1.209v-3.913L6.907 9.252z M10.34 7.873l3.281 1.193V5.198l-3.28-1.193zM20.507 2.715L17.19 3.922v3.913l3.317-1.207zM16.95 3.903L13.724 2.73l-3.269 1.19 3.225 1.174zM15.365 4.606l-1.624.592v3.868l3.317-1.207V3.991l-1.693.615zm-.391 2.778c-.367.134-.662-.074-.662-.464s.295-.813.662-.946c.366-.133.663.074.663.464s-.297.813-.663.946z M10.229 18.41v-3.914l-3.322-1.209V17.2zM13.678 17.182v-3.913l-3.371 1.227v3.913z M13.756 17.154l3.3-1.2V12.04l-3.3 1.2zM13.678 21.217l-3.371 1.227v-3.912h-.078v3.912l-3.322-1.209v-3.913l-.053-.058-.025-.06-3.336-1.21v-3.948l.034.013 3.287 1.196.015-.078-3.261-1.187 3.26-1.187v-.109L3.876 9.62l-.307-.112 3.26-1.188v.877l.079-.055V6.769l3.257 1.185.058-.061L7.084 6.75l-.102-.037 3.24-1.179v-.083L6.854 6.677v.018l-.025.018v1.523L3.44 9.47v.02l-.025.017v4.007l-3.39 1.233v.019L0 14.784v3.995l.025.037 3.4 1.237.008-.006.007.01 3.4 1.238.008-.006.006.01 3.4 1.237.014-.009.012.01 3.45-1.256.026-.037-.078-.027zM3.493 9.563l3.257 1.185-3.257 1.187V9.562zM3.4 19.96L.078 18.752v-3.913l2.361.86.96.349v3.913zm.015-3.99L.335 14.85l-.182-.066 3.262-1.187v2.374zm3.399 5.231l-3.321-1.209v-3.912l3.321 1.209v3.912zM23.791 5.434l-3.21-1.17v2.338zM20.387 2.643l-3.24-1.18-3.27 1.19 3.247 1.182z" },
  condaforge: { color: "#44A833", path: "M8.206 5.866l.005.396H6.754l.006.655v.005l-6.758.002v.211L0 7.973l.02.041c.212.467.663.901 1.257 1.313.594.411 1.335.796 2.145 1.13 1.62.664 3.502 1.12 5.006 1.1.746-.01 1.265.228 1.62.672.341.426.51 1.092.524 1.92L7.94 16.239l.008 1.896H20.29l-.004-1.76-2.63-2.22c.055-2.013.708-3.443 1.777-4.405 1.087-.979 2.61-1.49 4.37-1.616l.195-.015L24 5.872zm.425.422l14.946.006-.004 1.457c-1.737.155-3.29.666-4.424 1.685-.912.822-1.433 2.062-1.691 3.534l-1.617.004.002.422 1.535-.004c-.027.226-.113.4-.123.64l-.893-.003-.002.422.995.004 2.138 1.802-2.941.002c-.724-.675-1.552-1.116-2.416-1.158-.817-.04-1.638.324-2.387 1.04l-2.978-.024 2.248-1.781v-.102c.002-.943-.2-1.72-.64-2.269-.396-.496-1.007-.749-1.741-.79l-.008-4.49h.008zm-1.45.396h1.026l.008 4.404c-1.387-.02-3.125-.404-4.631-1.023-.787-.324-1.507-.698-2.066-1.086C.968 8.6.587 8.203.424 7.86v-.514l6.336-.002v2.16h.422v-2.16h.004l-.004-.435v-.226zm6.935 8.839c.75.037 1.503.436 2.18 1.078l-.002 1.112h-4.345l-.006-1.2c.706-.717 1.443-1.026 2.173-.99zM8.36 16.537l3.16.023.006 1.153h-3.16zm11.5.142l.002 1.034h-3.148V16.68z" },
  vscodium: { color: "#2F80ED", path: "M11.583.54a1.467 1.467 0 0 0-.441 2.032c2.426 3.758 2.999 6.592 2.75 9.075-1.004 4.756-3.187 5.721-5.094 5.721-1.863 0-1.364-3.065.036-3.962.836-.522 1.906-.861 2.728-.861.814 0 1.474-.658 1.474-1.47 0-.812-.66-1.47-1.474-1.47-.96 0-1.901.202-2.78.545.18-.847.246-1.762.014-2.735-.352-1.477-1.367-2.889-3.128-4.257a1.476 1.476 0 0 0-2.069.256c-.5.64-.384 1.564.259 2.063 1.435 1.114 1.908 1.939 2.07 2.618.162.679.032 1.407-.293 2.408-.416 1.349-.9 2.553-1.11 3.708-.105.568-.114 1.187-.14 1.68-1.034-1.006-1.438-2.336-1.438-4.279 0-.811-.66-1.47-1.474-1.47-.814.001-1.473.659-1.473 1.47 0 2.654.776 5.179 2.855 6.863 1.883 1.793 6.67 1.13 6.67 4.01 0 .812 1.19 1.208 2.004 1.208.834 0 1.885-.558 1.885-1.208 0-3.267 3.443-5.253 9.11-5.244A1.472 1.472 0 0 0 24 15.773 1.472 1.472 0 0 0 22.53 14.3c-.388 0-.765.013-1.138.035.634-1.49.915-3.13.857-4.903a1.473 1.473 0 0 0-1.522-1.42 1.472 1.472 0 0 0-1.425 1.517c.076 2.32-.01 4.393-1.74 5.485-.49.31-1.062.58-1.604.58.42-1.145.738-2.353.869-3.655.083-.83.091-1.818-.003-2.585-.148-1.188-.325-2.535.126-3.55.405-.874 1.313-1.24 2.645-1.24.814 0 1.473-.659 1.473-1.47 0-.811-.659-1.47-1.473-1.47-1.98 0-3.481 1.042-4.332 2.3-.445-.95-.987-1.929-1.642-2.943a1.474 1.474 0 0 0-2.037-.44z" },
};

function BrandIcon({ name, size }) {
  const icon = BRAND_ICONS[name];
  if (!icon) return h(Icon, { name: "code", size: size || 12 });
  return h("svg", { width: size || 12, height: size || 12, viewBox: "0 0 24 24", fill: icon.color, "aria-hidden": "true", focusable: "false" }, h("path", { d: icon.path }));
}

    /** Mesh 自己的标记：六个节点 + 外框，与品牌图标区分开。 */
    function MeshMark({ size }) {
      const id = "mesh-mark-gradient";
      return h(
        "svg",
        { width: size || 18, height: size || 18, viewBox: "0 0 32 32", fill: "none", className: "mesh-mark", "aria-hidden": "true", focusable: "false" },
        h(
          "defs",
          null,
          h(
            "linearGradient",
            { id, x1: "4", y1: "4", x2: "28", y2: "28", gradientUnits: "userSpaceOnUse" },
            h("stop", { offset: "0", stopColor: "currentColor", stopOpacity: "0.95" }),
            h("stop", { offset: "1", stopColor: "currentColor", stopOpacity: "0.38" }),
          ),
        ),
        h("path", { d: "M16 3.8 27.4 10.4v11.2L16 28.2 4.6 21.6V10.4z", stroke: `url(#${id})`, strokeWidth: 1.5, strokeLinejoin: "round" }),
        h("path", { d: "M16 9.2v13.6M9.4 12.9l13.2 7.2M22.6 12.9 9.4 20.1", stroke: `url(#${id})`, strokeWidth: 1, strokeLinecap: "round", opacity: ".65" }),
        h("circle", { cx: 16, cy: 9.2, r: 1.55, fill: "currentColor" }),
        h("circle", { cx: 16, cy: 22.8, r: 1.55, fill: "currentColor" }),
        h("circle", { cx: 9.4, cy: 12.9, r: 1.35, fill: "currentColor" }),
        h("circle", { cx: 22.6, cy: 20.1, r: 1.35, fill: "currentColor" }),
        h("circle", { cx: 22.6, cy: 12.9, r: 1.1, fill: "currentColor", opacity: ".75" }),
        h("circle", { cx: 9.4, cy: 20.1, r: 1.1, fill: "currentColor", opacity: ".75" }),
      );
    }

    /** 空状态插画：几个节点用细线连起来，呼吸动画；比一个灰图标更像“网络”。 */
    function MeshConstellation() {
      return h(
        "svg",
        { className: "mesh-constellation", viewBox: "0 0 180 96", fill: "none", "aria-hidden": "true", focusable: "false" },
        h("path", { d: "M18 66 52 34 92 52 134 22 162 52", stroke: "currentColor", strokeWidth: 1, opacity: ".18", strokeLinecap: "round" }),
        h("path", { d: "M52 34 58 78 92 52 122 76 134 22", stroke: "currentColor", strokeWidth: 1, opacity: ".12", strokeLinecap: "round" }),
        h("circle", { className: "mesh-constellation-node n1", cx: 18, cy: 66, r: 2.5, fill: "currentColor", opacity: ".55" }),
        h("circle", { className: "mesh-constellation-node n2", cx: 52, cy: 34, r: 3.2, fill: "currentColor", opacity: ".8" }),
        h("circle", { className: "mesh-constellation-node n3", cx: 92, cy: 52, r: 4, fill: "currentColor", opacity: ".9" }),
        h("circle", { className: "mesh-constellation-node n4", cx: 134, cy: 22, r: 2.8, fill: "currentColor", opacity: ".7" }),
        h("circle", { className: "mesh-constellation-node n5", cx: 162, cy: 52, r: 2.2, fill: "currentColor", opacity: ".5" }),
        h("circle", { className: "mesh-constellation-node n6", cx: 58, cy: 78, r: 2.2, fill: "currentColor", opacity: ".45" }),
        h("circle", { className: "mesh-constellation-node n7", cx: 122, cy: 76, r: 2.4, fill: "currentColor", opacity: ".55" }),
      );
    }

    function IconButton({ icon, iconNode, label, onClick, disabled, loading, active, badge }) {
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
        loading ? h("span", { className: "mesh-spinner" }) : iconNode || h(Icon, { name: icon, size: 15 }),
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
        h("div", { className: "mesh-empty-art" }, h(MeshConstellation)),
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

    const RUNTIME_ICONS = {
  node: "node", nodejs: "node",
  python: "python", python3: "python",
  go: "go", golang: "go",
  docker: "docker", git: "git",
  rust: "rust", rustc: "rust", cargo: "rust",
  java: "openjdk", jdk: "openjdk", jre: "openjdk",
  ruby: "ruby", php: "php",
  dotnet: "dotnet", "dotnet-sdk": "dotnet", csharp: "dotnet", "c#": "dotnet", mono: "dotnet",
  kotlin: "kotlin", swift: "swift", dart: "dart", flutter: "dart",
  lua: "lua", luajit: "lua", r: "r", rscript: "r", julia: "julia", perl: "perl",
  elixir: "elixir", erlang: "erlang", scala: "scala", clojure: "clojure",
  haskell: "haskell", ghc: "haskell", cabal: "haskell", stack: "haskell",
  ocaml: "ocaml", opam: "ocaml", fsharp: "fsharp", zig: "zig", nim: "nim", crystal: "crystal",
  groovy: "apachegroovy", apachegroovy: "apachegroovy",
  bun: "bun", deno: "deno", npm: "npm", pnpm: "pnpm", yarn: "yarn",
  ffmpeg: "ffmpeg", adb: "android", android: "android",
  bash: "bash", sh: "bash", zsh: "bash",
  sqlite: "sqlite", sqlite3: "sqlite",
  postgres: "postgresql", postgresql: "postgresql", psql: "postgresql",
  mysql: "mysql", mariadb: "mysql", redis: "redis", nginx: "nginx",
  gcc: "cplusplus", "g++": "cplusplus", cc: "cplusplus", cpp: "cplusplus", "c++": "cplusplus",
  clang: "llvm", llvm: "llvm", cmake: "cmake", bazel: "bazel", buck: "bazel",
  gradle: "gradle", mvn: "apachemaven", maven: "apachemaven",
  xcode: "xcode", podman: "podman",
  kubernetes: "kubernetes", kubectl: "kubernetes", k8s: "kubernetes", k3s: "kubernetes", minikube: "kubernetes",
  helm: "helm", terraform: "terraform", tofu: "terraform", ansible: "ansible",
  caddy: "caddy", traefik: "traefikproxy", traefikproxy: "traefikproxy",
  wireguard: "wireguard", wg: "wireguard", zerotier: "zerotier",
  pytorch: "pytorch", torch: "pytorch", tensorflow: "tensorflow", tf: "tensorflow",
  onnx: "onnx", onnxruntime: "onnx", opencv: "opencv", cv2: "opencv",
  ollama: "ollama", huggingface: "huggingface", hf: "huggingface",
  ubuntu: "ubuntu", debian: "debian", archlinux: "archlinux", arch: "archlinux",
  alpinelinux: "alpinelinux", alpine: "alpinelinux", fedora: "fedora",
  raspberrypi: "raspberrypi", rpi: "raspberrypi",
  homebrew: "homebrew", brew: "homebrew", pypi: "pypi", pip: "pypi",
  conda: "condaforge", mamba: "condaforge", condaforge: "condaforge",
  vscode: "vscodium", vscodium: "vscodium",
  macos: "apple", osx: "apple", darwin: "apple", ios: "apple", wsl: "linux",
  amd: "amd", radeon: "amd", intel: "intel", arc: "intel", iris: "intel", uhd: "intel",
  apple: "apple", metal: "apple",
};

function runtimeIcon(name) {
  const key = String(name || "").toLowerCase();
  if (RUNTIME_ICONS[key]) return RUNTIME_ICONS[key];
  if (key.startsWith("python")) return "python";
  if (key.startsWith("node")) return "node";
  if (key.startsWith("go")) return "go";
  if (key.startsWith("rust")) return "rust";
  if (key.startsWith("java")) return "openjdk";
  if (key.startsWith("ruby")) return "ruby";
  if (key.startsWith("php")) return "php";
  if (key.startsWith("dotnet") || key.startsWith("csharp")) return "dotnet";
  if (key.startsWith("kotlin")) return "kotlin";
  if (key.startsWith("swift")) return "swift";
  if (key.startsWith("dart") || key.startsWith("flutter")) return "dart";
  if (key.startsWith("lua")) return "lua";
  if (key.startsWith("julia")) return "julia";
  if (key.startsWith("perl")) return "perl";
  if (key.startsWith("elixir")) return "elixir";
  if (key.startsWith("erlang")) return "erlang";
  if (key.startsWith("scala")) return "scala";
  if (key.startsWith("clojure")) return "clojure";
  if (key.startsWith("haskell") || key.startsWith("ghc")) return "haskell";
  if (key.startsWith("ocaml")) return "ocaml";
  if (key.startsWith("fsharp")) return "fsharp";
  if (key.startsWith("zig")) return "zig";
  if (key.startsWith("nim")) return "nim";
  if (key.startsWith("crystal")) return "crystal";
  if (key.startsWith("groovy")) return "apachegroovy";
  if (key.startsWith("bun")) return "bun";
  if (key.startsWith("deno")) return "deno";
  if (key.startsWith("npm")) return "npm";
  if (key.startsWith("pnpm")) return "pnpm";
  if (key.startsWith("yarn")) return "yarn";
  if (key.startsWith("ffmpeg")) return "ffmpeg";
  if (key.startsWith("adb") || key.startsWith("android")) return "android";
  if (key.startsWith("bash") || key === "sh" || key === "zsh") return "bash";
  if (key.startsWith("sqlite")) return "sqlite";
  if (key.startsWith("postgres")) return "postgresql";
  if (key.startsWith("mysql") || key.startsWith("mariadb")) return "mysql";
  if (key.startsWith("redis")) return "redis";
  if (key.startsWith("nginx")) return "nginx";
  if (key.startsWith("gcc") || key.startsWith("g++") || key.startsWith("clang") || key.startsWith("c++")) return "cplusplus";
  if (key.startsWith("llvm")) return "llvm";
  if (key.startsWith("cmake")) return "cmake";
  if (key.startsWith("bazel")) return "bazel";
  if (key.startsWith("gradle")) return "gradle";
  if (key.startsWith("mvn") || key.startsWith("maven")) return "apachemaven";
  if (key.startsWith("podman")) return "podman";
  if (key.startsWith("kubernetes") || key.startsWith("k8s") || key.startsWith("k3s") || key.startsWith("kubectl")) return "kubernetes";
  if (key.startsWith("helm")) return "helm";
  if (key.startsWith("terraform") || key.startsWith("tofu")) return "terraform";
  if (key.startsWith("ansible")) return "ansible";
  if (key.startsWith("caddy")) return "caddy";
  if (key.startsWith("traefik")) return "traefikproxy";
  if (key.startsWith("wireguard") || key === "wg") return "wireguard";
  if (key.startsWith("zerotier")) return "zerotier";
  if (key.startsWith("pytorch") || key.startsWith("torch")) return "pytorch";
  if (key.startsWith("tensorflow")) return "tensorflow";
  if (key.startsWith("onnx")) return "onnx";
  if (key.startsWith("opencv") || key === "cv2") return "opencv";
  if (key.startsWith("ollama")) return "ollama";
  if (key.startsWith("huggingface") || key === "hf") return "huggingface";
  if (key.startsWith("ubuntu")) return "ubuntu";
  if (key.startsWith("debian")) return "debian";
  if (key.startsWith("archlinux") || key === "arch") return "archlinux";
  if (key.startsWith("alpine")) return "alpinelinux";
  if (key.startsWith("fedora")) return "fedora";
  if (key.startsWith("raspberrypi") || key === "rpi") return "raspberrypi";
  if (key.startsWith("homebrew") || key === "brew") return "homebrew";
  if (key.startsWith("pypi") || key === "pip") return "pypi";
  if (key.startsWith("conda") || key.startsWith("mamba")) return "condaforge";
  if (key.startsWith("vscode")) return "vscodium";
  return "code";
}
function CapabilityChips({ caps, peer }) {
      const [all, setAll] = react.useState(false);
      const [inspect, setInspect] = react.useState(null);
      const runtimes = runtimeEntries(caps);
      const shown = all ? runtimes : runtimes.slice(0, 6);
      const entries = capabilityEntries(caps);
      const wslEntries = entries.filter((e) => e.source && e.source.startsWith("WSL"));
      const specs = [];
      const gpuName = String((caps && caps.gpu && caps.gpu.name) || "");
      const gpuBrand = /nvidia|geforce|rtx|quadro/i.test(gpuName)
        ? "nvidia"
        : /amd|radeon/i.test(gpuName)
          ? "amd"
          : /intel|arc|iris|uhd/i.test(gpuName)
            ? "intel"
            : /apple|metal/i.test(gpuName)
              ? "apple"
              : "";
      if (caps && caps.cpuCores) specs.push(`${caps.cpuCores} 核`);
      if (caps && caps.memMb) specs.push(`${Math.round(caps.memMb / 1024)} GB 内存`);
      if (caps && caps.arch) specs.push(String(caps.arch));

      const chip = (entry, key, children, extra) =>
        h(
          "button",
          {
            key,
            type: "button",
            className: "mesh-chip",
            title: "查看细节",
            "aria-label": `查看 ${entry.label || entry.version} 的细节`,
            "data-mesh-cap": entry.cap || entry.label,
            "data-mesh-peer": (peer && peer.machine) || "",
            "data-mesh-instance": (peer && (peer.instanceId || peer.id)) || "",
            onClick: (event) => {
              event.stopPropagation();
              setInspect(entry.id);
            },
            ...extra,
          },
          children,
        );

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
            chip(
              { id: `rt:${name}`, cap: name, label: name, version: String(ver) },
              `rt-${name}`,
              [
                h(BrandIcon, { key: "icon", name: runtimeIcon(name), size: 12 }),
                h("span", { key: "label", className: "mesh-chip-label" }, name),
                h("span", { key: "ver", className: "mesh-chip-mono" }, String(ver)),
              ],
            ),
          ),
          caps && caps.gpu && caps.gpu.name
            ? chip(
                { id: "gpu", cap: "gpu", label: String(caps.gpu.name) },
                "gpu",
                [
                  h(gpuBrand ? BrandIcon : Icon, { key: "icon", name: gpuBrand || "gpu", size: 12 }),
                  String(caps.gpu.name),
                ],
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
              h(
                "button",
                {
                  type: "button",
                  className: "mesh-chip is-muted",
                  title: "查看 WSL 细节",
                  "data-mesh-cap": "wsl",
                  "data-mesh-peer": (peer && peer.machine) || "",
                  "data-mesh-instance": (peer && (peer.instanceId || peer.id)) || "",
                  onClick: (event) => {
                    event.stopPropagation();
                    if (wslEntries.length) setInspect(wslEntries[0].id);
                  },
                },
                h(BrandIcon, { name: "linux", size: 12 }),
                `WSL · ${wslSummary(caps)}`,
              ),
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
        inspect
          ? h(CapabilityInspector, {
              entries,
              activeId: inspect,
              onSelect: setInspect,
              onClose: () => setInspect(null),
              peer,
              caps,
            })
          : null,
      );
    }

    const RUNTIME_TITLES = {
      python: "Python", node: "Node.js", go: "Go", rust: "Rust", docker: "Docker", git: "Git",
      java: "Java", dotnet: ".NET", ruby: "Ruby", php: "PHP", kotlin: "Kotlin", swift: "Swift",
      dart: "Dart", lua: "Lua", julia: "Julia", perl: "Perl", elixir: "Elixir", erlang: "Erlang",
      scala: "Scala", clojure: "Clojure", haskell: "Haskell", ocaml: "OCaml", zig: "Zig",
      ffmpeg: "FFmpeg", adb: "ADB", bash: "Bash", sqlite: "SQLite", postgresql: "PostgreSQL",
      mysql: "MySQL", redis: "Redis", nginx: "Nginx", gcc: "GCC", clang: "Clang", cmake: "CMake",
    };

    function runtimeFamily(name) {
      const key = String(name || "").toLowerCase();
      if (key.startsWith("python")) return "python";
      if (key.startsWith("node")) return "node";
      if (key === "go" || key === "golang") return "go";
      if (key.startsWith("rust") || key === "cargo") return "rust";
      if (key.startsWith("java") || key === "jdk" || key === "jre") return "java";
      if (key.startsWith("dotnet") || key === "csharp") return "dotnet";
      if (key.startsWith("kotlin")) return "kotlin";
      if (key.startsWith("swift")) return "swift";
      if (key.startsWith("dart") || key.startsWith("flutter")) return "dart";
      if (key.startsWith("lua")) return "lua";
      if (key.startsWith("julia")) return "julia";
      if (key.startsWith("perl")) return "perl";
      if (key.startsWith("elixir")) return "elixir";
      if (key.startsWith("erlang")) return "erlang";
      if (key.startsWith("scala")) return "scala";
      if (key.startsWith("clojure")) return "clojure";
      if (key.startsWith("haskell") || key.startsWith("ghc")) return "haskell";
      if (key.startsWith("ocaml")) return "ocaml";
      if (key.startsWith("ruby")) return "ruby";
      if (key.startsWith("php")) return "php";
      return key;
    }

    function runtimeTitle(family) {
      return RUNTIME_TITLES[family] || (family ? family.charAt(0).toUpperCase() + family.slice(1) : "运行时");
    }

    function gpuVendor(name) {
      const s = String(name || "");
      if (/nvidia|geforce|rtx|quadro|tesla/i.test(s)) return "nvidia";
      if (/amd|radeon/i.test(s)) return "amd";
      if (/intel|arc|iris|uhd/i.test(s)) return "intel";
      if (/apple|metal/i.test(s)) return "apple";
      return "";
    }

    function capabilityEntries(caps) {
      const out = [];
      for (const [name, version] of runtimeEntries(caps)) {
        out.push({
          id: `rt:${name}`,
          cap: name,
          label: name,
          version: String(version || ""),
          kind: "runtime",
          family: runtimeFamily(name),
          command: name,
          path: (caps && caps.runtimePaths && caps.runtimePaths[name]) || "",
          environment: "本机",
          source: "本机",
        });
      }
      if (caps && caps.gpu && caps.gpu.name) {
        out.push({ id: "gpu", cap: "gpu", label: String(caps.gpu.name), version: "", kind: "gpu", family: "gpu", source: "本机", gpu: caps.gpu });
      }
      const wsl = Array.isArray(caps && caps.wsl) ? caps.wsl : [];
      wsl.forEach((distro, di) => {
        const distroName = distro && distro.name ? String(distro.name) : `WSL ${di + 1}`;
        const rts = distro && distro.runtimes && typeof distro.runtimes === "object" ? distro.runtimes : {};
        out.push({
          id: `wsl:${di}`,
          cap: "wsl",
          label: distroName,
          version: String((distro && distro.version) || ""),
          kind: "wsl",
          family: "wsl",
          source: `WSL · ${distroName}`,
          distroName,
          runtimes: rts,
        });
        for (const [name, version] of Object.entries(rts)) {
          out.push({
            id: `wsl:${di}:${name}`,
            cap: name,
            label: name,
            version: String(version || ""),
            kind: "runtime",
            family: runtimeFamily(name),
            command: name,
            environment: `WSL · ${distroName}`,
            source: `WSL · ${distroName}`,
          });
        }
      });
      return out;
    }

    function CapabilityInspector({ entries, activeId, onSelect, onClose, peer, caps }) {
      react.useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose]);
      const active = entries.find((entry) => entry.id === activeId) || entries[0];
      if (!active) return null;
      const scope = active.kind === "gpu" ? "gpu" : active.kind === "wsl" ? "wsl" : active.family;
      const scoped = entries.filter((entry) =>
        scope === "gpu" ? entry.kind === "gpu" : scope === "wsl" ? entry.kind === "wsl" : entry.kind === "runtime" && entry.family === scope,
      );
      const machine = (peer && peer.machine) || "本机";
      const isGpu = active.kind === "gpu";
      const isWsl = active.kind === "wsl";
      const vendorKey = isGpu ? gpuVendor(active.label) : "";
      const icon = isGpu
        ? vendorKey
          ? h(BrandIcon, { name: vendorKey, size: 24 })
          : h(Icon, { name: "gpu", size: 24 })
        : h(BrandIcon, { name: isWsl ? "linux" : runtimeIcon(active.label), size: 24 });
      const title = isGpu ? "GPU" : isWsl ? "WSL" : runtimeTitle(active.family);
      const rows = [];
      if (isGpu) {
        const vendorLabel = { nvidia: "NVIDIA", amd: "AMD", intel: "Intel", apple: "Apple" }[vendorKey] || "";
        if (vendorLabel) rows.push(["厂商", vendorLabel]);
        const vram = active.gpu && active.gpu.vramMb;
        if (vram) {
          const gb = vram / 1024;
          rows.push(["显存", `${vram} MB（${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB）`]);
        } else {
          rows.push(["显存", "未上报"]);
        }
        if (active.gpu && active.gpu.driverVersion) rows.push(["驱动", active.gpu.driverVersion]);
        if (active.gpu && active.gpu.cudaVersion) rows.push(["CUDA", active.gpu.cudaVersion]);
        rows.push(["来源", "本机"]);
      } else if (isWsl) {
        if (active.version) rows.push(["版本", active.version]);
        const rts = Object.entries(active.runtimes || {}).map(([name, ver]) => `${name} ${ver}`.trim()).join("  ·  ");
        rows.push(["运行时", rts || "未探测到"]);
        if (active.error) rows.push(["错误", active.error]);
      } else {
        rows.push(["环境", active.environment || "本机"]);
        if (active.path) rows.push(["路径", active.path]);
        rows.push(["命令", active.command || active.label]);
        if (caps && caps.runtimesIncomplete) rows.push(["探测", "结果不完整"]);
      }

      return h(
        "div",
        {
          className: "mesh-cap-layer",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": `${title} 细节`,
          onClick: onClose,
        },
        h(
          "div",
          { className: "mesh-cap-panel", onClick: (event) => event.stopPropagation() },
          h(
            "aside",
            { className: "mesh-cap-side" },
            h(
              "div",
              { className: "mesh-cap-side-head" },
              h("span", null, isGpu ? "GPU" : isWsl ? "WSL" : `${runtimeTitle(scope)} 版本`),
              h("button", { type: "button", className: "mesh-icon-btn", onClick: onClose, "aria-label": "关闭" }, h(Icon, { name: "close", size: 14 })),
            ),
            h("div", { className: "mesh-cap-side-machine" }, machine),
            h(
              "div",
              { className: "mesh-cap-side-list" },
              scoped.map((entry) =>
                h(
                  "button",
                  {
                    key: entry.id,
                    type: "button",
                    className: cls("mesh-cap-side-item", entry.id === active.id && "is-active"),
                    onClick: () => onSelect(entry.id),
                  },
                  entry.kind === "gpu"
                    ? gpuVendor(entry.label)
                      ? h(BrandIcon, { name: gpuVendor(entry.label), size: 13 })
                      : h(Icon, { name: "gpu", size: 13 })
                    : h(BrandIcon, { name: entry.kind === "wsl" ? "linux" : runtimeIcon(entry.label), size: 13 }),
                  h("span", { className: "mesh-cap-side-name" }, entry.kind === "runtime" ? entry.version || "未知版本" : entry.label),
                  entry.kind === "runtime" && entry.environment !== "本机"
                    ? h("span", { className: "mesh-cap-side-ver" }, entry.environment.replace(/^WSL · /, ""))
                    : null,
                ),
              ),
            ),
          ),
          h(
            "section",
            { className: "mesh-cap-detail" },
            h("div", { className: "mesh-cap-detail-mark" }, icon),
            h("h2", null, isGpu ? active.label : isWsl ? `WSL · ${active.label}` : title),
            !isGpu && !isWsl && active.version ? h("div", { className: "mesh-cap-detail-ver" }, active.version) : null,
            h(
              "dl",
              { className: "mesh-cap-kv" },
              rows.flatMap(([k, v]) => [h("dt", { key: `k-${k}` }, k), h("dd", { key: `v-${k}` }, v)]),
            ),
            caps && caps.capabilitiesAt
              ? h("div", { className: "mesh-cap-age" }, `采集于 ${ago(caps.capabilitiesAt, Date.now())}`)
              : null,
          ),
        ),
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

    function DeviceRow({ peer, isSelf, active, onSelect, onWeb, onSsh, now, index }) {
      const online = !!peer.online || !!isSelf;
      const narrow = useNarrowViewport();
      const name = peer.machine || "未命名设备";
      const webUrl = isSelf ? "" : dshWebUrl(peer);
      const select = () => onSelect(peer.id);
      return h(
        "div",
        {
          role: "button",
          tabIndex: 0,
          className: cls("mesh-row", active && "is-active", !online && "is-offline", narrow && "is-narrow"),
          onClick: select,
          onKeyDown: (event) => {
            // 只处理落在行本身上的回车/空格；行内按钮自己处理自己的键盘事件。
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
              event.preventDefault();
              select();
            }
          },
          "aria-label": `${name}，${online ? "在线" : "离线"}`,
          "aria-pressed": !!active,
          "data-mesh-view": "devices",
          "data-mesh-peer": peer.machine || "",
          "data-mesh-instance": peer.instanceId || peer.id || "",
          style: { animationDelay: `${Math.min(index || 0, 8) * 28}ms` },
        },
        h(
          Avatar,
          { name, avatar: peer.avatar, className: "mesh-avatar" },
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
          // 窄屏：在线状态 + transport(lan/usb) 用徽章明示，手指一眼能看清。
          // 宽屏不渲染这一行（桌面外观与 0.5.4 一致）。
          narrow
            ? h(
                "span",
                { className: "mesh-row-badges" },
                h(Badge, { kind: online ? "ok" : "muted" }, online ? "在线" : "离线"),
                peerTransportBadges(peer).map((badge) => h(Badge, { key: badge.label, kind: badge.kind }, badge.label)),
              )
            : null,
        ),
        h(
          "span",
          { className: "mesh-row-side" },
          // 「访问 DSH Web」：不选中设备，直接在对端的 DSH Web 上开一个页面。
          webUrl && onWeb
            ? h(IconButton, {
                // 用 DSH 官方 logo 而不是地球：这一格代表的是"那台机器上的 DSH"
                iconNode: h(DshMark, { size: 14 }),
                label: `访问 ${name} 的 DSH Web（${webUrl}）`,
                disabled: !online,
                onClick: (event) => {
                  event.stopPropagation();
                  onWeb(peer);
                },
              })
            : null,
          // SSH 终端：与「访问 DSH Web」同一位置，连的是对端 22 端口
          !isSelf && onSsh
            ? h(IconButton, {
                icon: "terminal",
                label: `SSH 连接到 ${name}`,
                disabled: !online,
                onClick: (event) => {
                  event.stopPropagation();
                  onSsh(peer);
                },
              })
            : null,
          h(Icon, { name: "chevron", size: 13 }),
        ),
      );
    }

    function DeviceList({ selfPeer, peers, selectedId, onSelect, onWeb, onSsh, now, lastOk, onScan, scanning }) {
      const narrow = useNarrowViewport();
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
          // 窄屏：一行一张设备卡片（CSS 里 .mesh-list.is-narrow 负责单列/大触控）
          { className: cls("mesh-list", narrow && "is-narrow") },
          selfPeer
            ? h(
                react.Fragment,
                null,
                h("div", { className: "mesh-list-heading" }, "本机"),
                h(DeviceRow, { peer: selfPeer, isSelf: true, active: selectedId === "self", onSelect, onWeb, onSsh, now, index: 0 }),
              )
            : null,
          h("div", { className: "mesh-list-heading" }, "其他设备"),
          peers.length
            ? peers.map((p, i) => h(DeviceRow, { key: p.id, peer: p, active: selectedId === p.id, onSelect, onWeb, onSsh, now, index: i + 1 }))
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
      const narrow = useNarrowViewport();
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
          // 窄屏加 is-narrow：大触控 + 能力/端点/身份收进「详情」折叠（CSS/下方分支）
          { className: cls("mesh-detail", narrow && "is-narrow"), key: peer.id },
          h(
            "button",
            { type: "button", className: "mesh-back", onClick: onBack },
            h(Icon, { name: "chevron", size: 13 }),
            "设备",
          ),
          h(
            "header",
            { className: "mesh-detail-head" },
            h(Avatar, { name: peer.machine, avatar: peer.avatar, className: "mesh-detail-avatar" }, h(Dot, { kind: online ? "ok" : "idle" })),
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
          h(RecentTasks, { tasks: recentTasks, now, onOpenTask, onAll: onAllTasks }),
          // 窄屏：能力/通道/身份收进一个「详情」折叠（默认收起），首屏只留
          // 状态 + 主操作；宽屏保持原来的三段直接铺开（桌面外观不变）。
          ...(narrow
            ? [
                h(
                  Fold,
                  { title: "详情", right: "能力 · 通道 · 身份" },
                  h(CapabilitySection, { peer, isSelf }),
                  h(ChannelSection, { peer, isSelf, now }),
                  h(IdentitySection, { peer, isSelf }),
                ),
              ]
            : [
                h(CapabilitySection, { peer, isSelf }),
                h(ChannelSection, { peer, isSelf, now }),
                h(IdentitySection, { peer, isSelf }),
              ]),
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
      const { selfPeer, peers, selectedPeer, selectedId, onSelect, onWeb, onSsh, mobilePane, onBack, onCompose, onProbe, probe, hostDown, now, lastOk, onScan, scanning, firstRun, onRename, recentTasks, onOpenTask, onAllTasks } = props;
      return h(
        react.Fragment,
        null,
        firstRun,
        h(
          "div",
          { className: "mesh-split", "data-pane": mobilePane },
          h(DeviceList, { selfPeer, peers, selectedId, onSelect, onWeb, onSsh, now, lastOk, onScan, scanning }),
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
            h(Avatar, { name: target.machine, avatar: target.avatar, className: "mesh-detail-avatar" }, h(Dot, { kind: online ? "ok" : "idle" })),
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
          "padding:4px 8px", "border-radius:5px", "background:var(--dsw-alias-bg-layer-3, #14181f)", "color:var(--dsw-alias-label-primary, #fff)",
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
          "background:var(--dsw-alias-bg-overlay, rgba(20,24,31,.96))", "color:var(--dsw-alias-label-primary, #fff)",
          "box-shadow:0 12px 34px rgba(0,0,0,.3)", "border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))",
        ].join(";");
        const barText = document.createElement("span");
        barText.textContent = "锚定传输：点选设备 / 任务 / 能力 / 设置，把现场和一句意图发出去";
        barText.style.cssText = "font-size:12px;white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Esc 取消";
        cancel.style.cssText = [
          "pointer-events:auto", "border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.24))",
          "background:var(--dsw-alias-bg-layer-2, rgba(255,255,255,.08))", "color:var(--dsw-alias-label-primary, #fff)", "border-radius:6px",
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

    /**
     * 对端 DSH Web 的应用内面板。
     *
     * 承载方式是同源 iframe —— 指向**本机**的一个回环反代端口（宿主的
     * /mesh/api/web-panel 起出来的），对端认证在服务端完成。所以这里不需要
     * token、不依赖壳的浏览器 WebView，也不受对端 cookie SameSite 限制。
     */
    function WebPanel({ panel, onClose, onReload }) {
      if (!panel) return null;
      const ready = panel.state === "ready";
      const name = panel.name || "对端";
      return h(
        "div",
        {
          className: "mesh-web-layer",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": `${name} 的 DSH Web`,
          "data-mesh-view": "web",
        },
        h(
          "div",
          { className: "mesh-web-bar" },
          h(
            "button",
            { type: "button", className: "mesh-panel-back", onClick: onClose, "aria-label": "关闭面板" },
            h(Icon, { name: "back", size: 14 }),
            h("span", null, "返回"),
          ),
          h("span", { className: "mesh-web-mark", "aria-hidden": "true" }, h(DshMark, { size: 16 })),
          h(
            "span",
            { className: "mesh-web-title", title: panel.remote || "" },
            name,
            h("span", { className: "mesh-web-sub" }, " · DSH Web"),
          ),
          h(IconButton, { icon: "refresh", label: "重新加载面板", onClick: onReload }),
        ),
        !ready
          ? h(
              "div",
              { className: "mesh-web-status" },
              h("span", { className: "mesh-spinner" }),
              h("span", null, "正在起回环代理…"),
            )
          : null,
        ready && panel.hasSession === false
          ? h(
              "div",
              { className: "mesh-web-status is-warn" },
              h(Icon, { name: "alert", size: 14 }),
              h("span", null, panel.note || "对端没给出可用 token，面板可能停在登录页。"),
            )
          : null,
        ready
          ? h("iframe", {
              key: panel.reloadKey || 0,
              className: "mesh-web-frame",
              src: panel.url,
              title: `${name} 的 DSH Web`,
              // 对端界面里要用剪贴板（复制命令/日志），别让它被静默拒绝。
              allow: "clipboard-read; clipboard-write; fullscreen",
              referrerPolicy: "no-referrer",
            })
          : null,
      );
    }


    /** 去掉终端控制序列：没有 xterm 时，把 ANSI 转义剥掉才不会满屏乱码。 */
    function stripAnsi(text) {
      return String(text)
        .replace(/\u001b\][^\u0007]*\u0007/g, "")
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\r(?!\n)/g, "");
    }

    /**
     * 应用内 SSH 终端。
     *
     * 传输走同源 WebSocket（/mesh/api/ssh/ws），SSH 本身由本机宿主发起；
     * 这里只是个"哑终端"：输出按行渲染、输入整行发送，另给 Ctrl+C / Tab 两个键。
     * 没做完整 VT100（没有 xterm 依赖），够用来跑命令、看日志。
     */
    function SshPanel({ peer, onClose }) {
      const machine = (peer && peer.machine) || "";
      const [phase, setPhase] = react.useState("form");
      const [username, setUsername] = react.useState("");
      const [password, setPassword] = react.useState("");
      const [hasKey, setHasKey] = react.useState(false);
      // 密钥属于哪个用户名：换了用户名就不能再拿它去认证（否则只会得到认证失败）
      const [keyUser, setKeyUser] = react.useState("");
      // 密钥失效时不至于卡死：允许手动切回密码登录
      const [forcePassword, setForcePassword] = react.useState(false);
      const [output, setOutput] = react.useState("");
      const [line, setLine] = react.useState("");
      const [error, setError] = react.useState("");
      const wsRef = react.useRef(null);
      const idRef = react.useRef("");
      const outRef = react.useRef(null);

      react.useEffect(() => {
        let alive = true;
        api("/ssh/known", { machine })
          .then((r) => {
            if (!alive || !r || !r.ok) return;
            if (r.username) {
              setUsername(r.username);
              setKeyUser(r.username);
            }
            if (r.hasKey) setHasKey(true);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [machine]);

      react.useEffect(() => {
        const el = outRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [output]);

      const closeSocket = () => {
        try {
          wsRef.current?.close();
        } catch {
          /* 已关 */
        }
        wsRef.current = null;
        idRef.current = "";
      };

      react.useEffect(() => () => closeSocket(), []);

      const connect = () => {
        setError("");
        setOutput("");
        setPhase("connecting");
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        let ws;
        try {
          ws = new WebSocket(`${scheme}://${location.host}/mesh/api/ssh/ws`);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
          setPhase("error");
          return;
        }
        wsRef.current = ws;
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "open",
              machine,
              host: peer.host || "",
              port: 22,
              username: username.trim(),
              password: keyApplies && !forcePassword ? "" : password,
              cols: 100,
              rows: 30,
            }),
          );
        };
        ws.onmessage = (event) => {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }
          if (msg.type === "ready") {
            idRef.current = msg.id;
            setPhase("open");
            if (msg.buffer) setOutput(stripAnsi(msg.buffer));
            return;
          }
          if (msg.type === "data") {
            setOutput((prev) => (prev + stripAnsi(msg.data)).slice(-200000));
            return;
          }
          if (msg.type === "exit") {
            setPhase("closed");
            return;
          }
          if (msg.type === "error") {
            setError(String(msg.message || "未知错误"));
            setPhase("error");
          }
        };
        ws.onerror = () => {
          setError("连接通道错误（WebSocket）");
          setPhase("error");
        };
        ws.onclose = () => {
          setPhase((prev) => (prev === "error" ? prev : "closed"));
        };
      };

      const sendInput = (data) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== 1 || !idRef.current) return;
        ws.send(JSON.stringify({ type: "input", id: idRef.current, data }));
      };

      const submit = (event) => {
        event.preventDefault();
        if (!line.trim()) return;
        sendInput(line + "\r");
        setLine("");
      };

      const disconnect = () => {
        const id = idRef.current;
        if (id) sendInput.call(null, ""); // 占位，避免 eslint 抱怨
        try {
          if (id) wsRef.current?.send(JSON.stringify({ type: "close", id }));
        } catch {
          /* 忽略 */
        }
        closeSocket();
        onClose();
      };

      const keyApplies = hasKey && keyUser !== "" && username.trim() === keyUser;
      const name = machine || "对端";
      return h(
        "div",
        { className: "mesh-web-layer", role: "dialog", "aria-modal": "true", "aria-label": `${name} 的 SSH 终端` },
        h(
          "div",
          { className: "mesh-web-bar" },
          h("button", { type: "button", className: "mesh-panel-back", onClick: disconnect }, h(Icon, { name: "back", size: 14 }), h("span", null, "返回")),
          h("span", { className: "mesh-web-title" }, name, h("span", { className: "mesh-web-sub" }, " · SSH")),
          phase === "open"
            ? h(IconButton, { icon: "close", label: "断开连接", onClick: disconnect })
            : null,
        ),
        phase === "form" || phase === "connecting" || phase === "error"
          ? h(
              "div",
              { className: "mesh-ssh-form" },
              h(
                "div",
                { className: "mesh-ssh-note" },
                keyApplies
                  ? "已部署本机公钥，直接连接即可（免密）。"
                  : hasKey
                    ? `公钥属于 ${keyUser}；当前用户名不同，请输入密码。`
                    : "首次连接需要用户名和密码；成功后会自动把本机公钥写到对端，之后免密。",
              ),
              h("label", { className: "mesh-ssh-field" }, h("span", null, "用户名"), h("input", { value: username, onChange: (e) => setUsername(e.target.value), autoCapitalize: "none", spellCheck: false })),
              keyApplies && !forcePassword
                ? null
                : h("label", { className: "mesh-ssh-field" }, h("span", null, "密码"), h("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value) })),
              keyApplies && !forcePassword && (phase === "error" || phase === "form")
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "mesh-ssh-key",
                      onClick: () => {
                        setForcePassword(true);
                        setError("");
                        setPhase("form");
                      },
                    },
                    "改用密码连接",
                  )
                : null,
              error ? h("div", { className: "mesh-ssh-error" }, error) : null,
              h(
                Button,
                { variant: "primary", onClick: connect, disabled: !username.trim() || phase === "connecting" },
                phase === "connecting" ? "连接中…" : "连接",
              ),
            )
          : null,
        phase === "open" || phase === "closed"
          ? h(
              react.Fragment,
              null,
              h("pre", { className: "mesh-ssh-out", ref: outRef }, output || "已连接，等输出…"),
              phase === "closed" ? h("div", { className: "mesh-ssh-note" }, "会话已结束") : null,
              h(
                "form",
                { className: "mesh-ssh-inputrow", onSubmit: submit },
                h("input", { value: line, onChange: (e) => setLine(e.target.value), placeholder: "输入命令，回车执行", autoCapitalize: "none", spellCheck: false }),
                h("button", { type: "button", className: "mesh-ssh-key", onClick: () => sendInput("\u0003") }, "Ctrl-C"),
                h("button", { type: "button", className: "mesh-ssh-key", onClick: () => sendInput("\t") }, "Tab"),
                h("button", { type: "submit", className: "mesh-ssh-send" }, "发送"),
              ),
            )
          : null,
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

    function NameEditor({ self, onSave, busy, push, onAvatar }) {
      const [editing, setEditing] = react.useState(false);
      const [value, setValue] = react.useState((self && self.machine) || "");
      const [avatarBusy, setAvatarBusy] = react.useState(false);
      const fileRef = react.useRef(null);
      const nameLocked = !!(self && self.machineSource === "config");

      react.useEffect(() => {
        setValue((self && self.machine) || "");
      }, [self && self.machine]);

      const save = async () => {
        const ok = await onSave(value);
        if (ok) setEditing(false);
      };

      const uploadAvatar = async (file) => {
        if (!file) return;
        setAvatarBusy(true);
        try {
          const avatar = await imageFileToAvatar(file);
          const r = await api("/avatar", { avatar });
          if (!r.ok) {
            push("error", r.error || "头像更新失败");
            return;
          }
          push("success", "头像已更新");
          if (onAvatar) onAvatar();
        } catch (err) {
          push("error", `头像更新失败：${err?.message ?? err}`);
        } finally {
          setAvatarBusy(false);
          if (fileRef.current) fileRef.current.value = "";
        }
      };

      const resetAvatar = async () => {
        setAvatarBusy(true);
        try {
          const r = await api("/avatar", { clear: true });
          if (!r.ok) {
            push("error", r.error || "恢复默认头像失败");
            return;
          }
          push("success", "已恢复系统用户头像");
          if (onAvatar) onAvatar();
        } catch (err) {
          push("error", `恢复默认头像失败：${err?.message ?? err}`);
        } finally {
          setAvatarBusy(false);
        }
      };

      return h(
        "div",
        null,
        h(
          "div",
          { className: "mesh-me" },
          h(Avatar, { name: self && self.machine, avatar: self && self.avatar, className: "mesh-avatar mesh-me-avatar" }),
          h("span", { className: "mesh-me-name" }, (self && self.machine) || "未命名"),
          self && self.needsName ? h(Badge, { kind: "warn" }, "待命名") : null,
          h(
            "span",
            { className: "mesh-me-actions" },
            editing || nameLocked
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
        nameLocked ? h("p", { className: "mesh-hint" }, "名字由插件配置 machineName 指定；头像仍可在这里改。") : null,
        h(
          "div",
          { className: "mesh-inline-form", style: { marginTop: 6 } },
          h(
            Button,
            {
              variant: "ghost",
              size: "sm",
              icon: "edit",
              loading: avatarBusy,
              onClick: () => fileRef.current && fileRef.current.click(),
            },
            "换头像",
          ),
          self && self.avatar
            ? h(Button, { variant: "ghost", size: "sm", disabled: avatarBusy, onClick: resetAvatar }, "恢复默认")
            : null,
          h("span", { className: "mesh-hint" }, "默认读取系统用户头像；支持 png / jpg / webp"),
          h("input", {
            ref: fileRef,
            type: "file",
            accept: "image/png,image/jpeg,image/webp",
            style: { display: "none" },
            onChange: (e) => uploadAvatar(e.target.files && e.target.files[0]),
            "aria-label": "选择头像图片",
          }),
        ),
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

    function SettingRow({ title, description, children }) {
      return h(
        "div",
        { className: "mesh-setting-row" },
        h(
          "div",
          { className: "mesh-setting-copy" },
          h("div", { className: "mesh-setting-title" }, title),
          description ? h("div", { className: "mesh-setting-desc" }, description) : null,
        ),
        children ? h("div", { className: "mesh-setting-control" }, children) : null,
      );
    }

    function SettingValue({ children }) {
      return h("span", { className: "mesh-setting-value" }, children);
    }

    function SettingBlock({ title, description, children }) {
      return h(
        "div",
        { className: "mesh-setting-block" },
        h("div", { className: "mesh-setting-title" }, title),
        description ? h("div", { className: "mesh-setting-desc" }, description) : null,
        children,
      );
    }

    function SettingField({ field, cfg, push, reload }) {
      const current = cfg && cfg[field.key];
      const display = field.type === "list"
        ? Array.isArray(current) ? current.join("\n") : current == null ? "" : String(current)
        : current == null ? "" : String(current);
      const [value, setValue] = react.useState(display);
      const [busy, setBusy] = react.useState(false);
      react.useEffect(() => setValue(display), [display]);

      const commit = async (next) => {
        if (busy) return;
        let payload = next;
        if (field.type === "number" || field.valueType === "number") payload = Number(next);
        if (field.type === "list") payload = String(next).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
        setBusy(true);
        try {
          const r = await api("/settings", { values: { [field.key]: payload } });
          if (r && r.ok) {
            const restart = Array.isArray(r.restart) && r.restart.includes(field.key);
            push("success", restart ? "已保存，重启后生效" : "已保存");
            await reload();
          } else {
            push("error", apiErr(r));
          }
        } catch (e) {
          push("error", String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      if (field.type === "switch") {
        return h(Switch, {
          checked: current === true,
          disabled: busy,
          label: field.label,
          onChange: (v) => commit(v),
        });
      }

      if (field.type === "select") {
        const currentValue = current == null ? "" : String(current);
        const options = [...(field.options || [])];
        if (!options.some((o) => String(o.value) === currentValue)) {
          options.unshift({ value: currentValue, label: currentValue || "未设置" });
        }
        return h(
          "select",
          {
            className: "mesh-input mesh-setting-input mesh-select",
            value: currentValue,
            disabled: busy,
            onChange: (e) => commit(e.target.value),
          },
          options.map((o) => h("option", { key: String(o.value), value: String(o.value) }, o.label)),
        );
      }

      const common = {
        className: field.type === "list" ? "mesh-textarea mesh-setting-input" : "mesh-input mesh-setting-input",
        value,
        disabled: busy,
        onChange: (e) => setValue(e.target.value),
        onBlur: () => commit(value),
        onKeyDown: (e) => {
          if (e.key === "Enter" && field.type !== "list") {
            e.preventDefault();
            commit(value);
          }
        },
      };
      if (field.type === "list") {
        return h("textarea", { ...common, rows: 2, placeholder: "192.168.1.0/24" });
      }
      return h("input", {
        ...common,
        type: field.type === "number" ? "number" : "text",
        min: field.type === "number" ? 0 : undefined,
      });
    }

    function SettingsFields({ cat, cfg, push, reload }) {
      const fields = SETTINGS_FIELDS.filter(
        (f) => f.cat === cat && (!f.requires || (cfg && cfg[f.requires] === true)),
      );
      if (!fields.length) return null;
      return h(
        "div",
        { className: "mesh-setting-group" },
        fields.map((f) =>
          h(
            SettingRow,
            {
              key: f.key,
              title: f.label,
              description: f.restart ? "重启后生效" : undefined,
            },
            h(SettingField, { field: f, cfg, push, reload }),
          ),
        ),
      );
    }

    function SettingsView({ state, open, onOpen, onSaveName, nameBusy, push, reload }) {
      const self = (state && state.self) || {};
      const cfg = (state && state.config) || {};
      const tsnet = state && state.tsnet;
      const phase = tsnetPhase(tsnet);
      const [query, setQuery] = react.useState("");
      const q = query.trim().toLowerCase();
      const visible = SETTINGS_CATS.filter((c) => !q || `${c.label} ${c.desc}`.toLowerCase().includes(q));
      const wanted = SETTINGS_ALIAS[open] || open;
      const active = visible.some((c) => c.id === wanted) ? wanted : visible[0] && visible[0].id;

      const pane = (title, ...children) =>
        h(
          "div",
          { className: "mesh-settings-pane" },
          h("div", { className: "mesh-settings-pane-title" }, title),
          ...children,
        );

      const general = () =>
        pane(
          "常规",
          h(
            SettingBlock,
            { title: "本机名称" },
            h(NameEditor, { self, onSave: onSaveName, busy: nameBusy, push, onAvatar: reload }),
          ),
          h(
            "div",
            { className: "mesh-setting-group" },
            h("div", { className: "mesh-setting-group-title" }, "本机信息"),
            h(SettingRow, { title: "地址" }, h(SettingValue, null, shortAddress(self.host, self.port))),
            h(SettingRow, { title: "系统" }, h(SettingValue, null, osLabel(self.platform))),
            h(SettingRow, { title: "版本" }, h(SettingValue, null, self.version || "—")),
            h(SettingRow, { title: "其他地址" }, h(SettingValue, null, Array.isArray(self.addresses) && self.addresses.length ? self.addresses.join("  ·  ") : "—")),
          ),
        );

      const network = () =>
        pane(
          "连接与发现",
          h(SettingRow, { title: "对端端口" }, h(SettingValue, null, String(self.port || "—"))),
          h(SettingsFields, { cat: "network", cfg, push, reload }),
        );

      const security = () =>
        pane(
          "安全与配对",
          h(
            SettingBlock,
            { title: "配对码" },
            h(PairingBody, { self, cfg, push, reload }),
          ),
          h(SettingsFields, { cat: "security", cfg, push, reload }),
        );

      const tsnetPane = () =>
        pane(
          "互联网组网",
          phase.label
            ? h(
                "div",
                { className: "mesh-setting-group" },
                h(SettingRow, { title: "状态" }, h(SettingValue, null, phase.label)),
              )
            : null,
          tsnet
            ? h(TsnetBody, { tsnet, push, reload })
            : h("div", { className: "mesh-settings-empty" }, "当前版本没有上报互联网组网状态。"),
        );

      const remote = () =>
        pane(
          "远程访问",
          h(SettingsFields, { cat: "remote", cfg, push, reload }),
        );

      const diagnostics = () =>
        pane(
          "诊断",
          h(Diagnostics, { state, push }),
        );

      const about = () =>
        pane(
          "关于",
          h(
            "div",
            { className: "mesh-setting-group" },
            h(SettingRow, { title: "插件版本" }, h(SettingValue, null, self.version || "—")),
            h(SettingRow, { title: "项目仓库" }, h("a", { className: "mesh-card-link", href: "https://github.com/peng456/dsh-plugin-mesh", target: "_blank", rel: "noreferrer" }, "peng456/dsh-plugin-mesh")),
            h(SettingRow, { title: "问题反馈" }, h("a", { className: "mesh-card-link", href: "https://github.com/peng456/dsh-plugin-mesh/issues", target: "_blank", rel: "noreferrer" }, "GitHub Issues")),
            h(SettingRow, { title: "许可证" }, h(SettingValue, null, "MIT")),
          ),
        );

      const render = {
        general,
        network,
        security,
        tsnet: tsnetPane,
        remote,
        diagnostics,
        about,
      };

      return h(
        "div",
        { className: "mesh-settings-page" },
        h(
          "aside",
          { className: "mesh-settings-nav" },
          h(
            "div",
            { className: "mesh-settings-nav-head" },
            h("h2", null, "设置"),
          ),
          h(
            "div",
            { className: "mesh-settings-search" },
            h("input", {
              className: "mesh-input",
              type: "search",
              placeholder: "搜索设置",
              "aria-label": "搜索设置",
              value: query,
              onChange: (e) => setQuery(e.target.value),
            }),
          ),
          h(
            "nav",
            { className: "mesh-settings-navlist", "aria-label": "设置栏目" },
            visible.map((cat) =>
              h(
                "button",
                {
                  key: cat.id,
                  type: "button",
                  className: cls("mesh-settings-navitem", active === cat.id && "is-active"),
                  onClick: () => onOpen(cat.id),
                  "aria-current": active === cat.id ? "page" : undefined,
                },
                h(Icon, { name: cat.icon, size: 14 }),
                cat.label,
              ),
            ),
            !visible.length ? h("div", { className: "mesh-settings-nav-empty" }, "没有匹配的栏目") : null,
          ),
        ),
        h(
          "section",
          { className: "mesh-settings-content" },
          active && render[active]
            ? h("div", { key: active, className: "mesh-settings-pane-wrap" }, render[active]())
            : h("div", { className: "mesh-settings-empty" }, q ? `没有匹配「${query}」的设置` : "选择一个设置栏目"),
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
      onWeb,
      onSsh,
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
      onWeb,
      onSsh,
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
      // 窄屏：派发面板挪到 MeshApp 的底部固定操作条里，主页不再重复一份。
      const narrow = useNarrowViewport();
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
                // 与「设备」页同一组入口：访问 DSH Web / SSH 终端
                h(
                  "span",
                  { className: "mesh-mini-actions" },
                  onWeb
                    ? h(
                        "button",
                        {
                          type: "button",
                          className: "mesh-mini-act",
                          title: `访问 ${p.machine || "对端"} 的 DSH Web`,
                          "aria-label": `访问 ${p.machine || "对端"} 的 DSH Web`,
                          disabled: !p.online,
                          onClick: () => onWeb(p),
                        },
                        h(DshMark, { size: 14 }),
                      )
                    : null,
                  onSsh
                    ? h(
                        "button",
                        {
                          type: "button",
                          className: "mesh-mini-act",
                          title: `SSH 连接到 ${p.machine || "对端"}`,
                          "aria-label": `SSH 连接到 ${p.machine || "对端"}`,
                          disabled: !p.online,
                          onClick: () => onSsh(p),
                        },
                        h(Icon, { name: "terminal", size: 14 }),
                      )
                    : null,
                ),
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
          { className: cls("mesh-home", density === "compact" && "is-dense", narrow && "is-narrow") },
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
                      background: "var(--mesh-surface-2)",
                      color: "var(--mesh-fg)",
                      border: "1px solid var(--mesh-line)",
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
                        color: "var(--mesh-accent)",
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
            // 窄屏改由 MeshApp 的底部固定「派发任务」条承载（避免重复 + 节省首屏）。
            narrow
              ? null
              : h(DispatchPanel, {
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

    function TopBar({ view, onView, online, total, taskCount, error, lastOk, now, refreshing, onRefresh, scanning, onScan, disabled, busy, focus, onToggleFocus, onTransfer, transferActive, onLog, transferCount, onExit }) {
      const tabs = [
        { value: "home", label: "主页", icon: "home" },
        { value: "devices", label: "设备", icon: "device", count: total },
        { value: "tasks", label: "任务", icon: "tasks", count: taskCount },
        { value: "connect", label: "设置", icon: "edit" },
      ];
      const healthText = error ? "连接中断" : total === 0 ? "未发现设备" : `${online} / ${total} 在线`;

      return h(
        "header",
        { className: "mesh-topbar", "aria-busy": !!busy },
        // 主面板是"点进去出不来"的：宿主只在插件管理页注入返回键，Mesh 这个
        // 主面板没有，窄屏上连侧边栏都被抽屉挡住。这里自带一个，直接回到会话。
        onExit
          ? h(
              "button",
              {
                type: "button",
                className: "mesh-panel-back",
                onClick: onExit,
                title: "返回会话（退出 Mesh 面板）",
                "aria-label": "返回会话",
                "data-mesh-view": "back",
              },
              h(Icon, { name: "back", size: 14 }),
              h("span", { className: "mesh-panel-back-text" }, "返回"),
            )
          : null,
        h(
          "div",
          { className: "mesh-brand" },
          h("span", { className: "mesh-logo" }, h(MeshMark, { size: 18 })),
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

    /**
     * 窄屏底部固定派发条（P2b）。
     *
     * 为什么单独一个组件：手机上主页的派发卡在首屏之外，先看设备还要滚很久；
     * 底部固定条让「派发任务」永远一只手够得到，点开后在条上方展开完整面板
     * （复用同一个 DispatchPanel，不复制业务逻辑）。
     *
     * 宽屏不渲染（MeshApp 里按 narrow 分支），桌面行为零变化。
     */
    function MobileDispatchBar({ peers, hostDown, open, onToggle, onScan, scanning, onDispatched, density }) {
      const targets = (peers || []).filter((p) => p && !p.self);
      const online = targets.filter((p) => p.online).length;
      return h(
        "div",
        { className: cls("mesh-mobile-bar-wrap", open && "is-open"), "data-mesh-mobile": "dispatch" },
        open
          ? h(
              "div",
              { className: "mesh-mobile-bar-panel mesh-mobile-dispatch" },
              h(DispatchPanel, {
                peers,
                hostDown: !!hostDown,
                disabled: !!hostDown,
                onScan,
                scanning,
                onDispatched,
                density,
              }),
            )
          : null,
        h(
          "div",
          { className: "mesh-mobile-bar" },
          h(
            "div",
            { className: "mesh-mobile-bar-meta" },
            h(Dot, { kind: online > 0 ? "ok" : "idle" }),
            h("span", null, targets.length ? `${online} / ${targets.length} 台在线` : "还没有其他设备"),
          ),
          h(
            Button,
            { variant: "primary", icon: "send", onClick: onToggle, disabled: !!hostDown },
            open ? "收起派发" : "派发任务",
          ),
        ),
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
      // 窄屏（手机 WebView / island 嵌入）：只影响移动分支，宽屏渲染保持原样。
      const narrow = useNarrowViewport();
      const { state, error, lastOk, loading, refreshing, reload } = useMeshState(focus ? 15000 : 3000);
      const cfg = (state && state.config) || {};
      const remoteEnabled = cfg.experimentalRemoteControl === true;
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
      // 窄屏底部派发条展开状态（宽屏不渲染这个条）
      const [mobileDispatchOpen, setMobileDispatchOpen] = react.useState(false);
      const [selectedTaskKey, setSelectedTaskKey] = react.useState(null);
      const [taskPane, setTaskPane] = react.useState("list");
      const [taskFilter, setTaskFilter] = react.useState("all");
      const [composer, setComposer] = react.useState(null);
      const [probe, setProbe] = react.useState(null);
      // 对端 DSH Web 的应用内面板：{ peer, name, state: loading|ready, url, note, hasSession, reloadKey }
      const [webPanel, setWebPanel] = react.useState(null);
      // SSH 终端面板：null 或某个 peer
      const [sshPeer, setSshPeer] = react.useState(null);
      react.useEffect(() => {
        if (!remoteEnabled) {
          setWebPanel(null);
          setSshPeer(null);
        }
      }, [remoteEnabled]);
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
                avatar: self.avatar || "",
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
       * 打开对端的 DSH Web。
       *
       * 主路是**应用内面板**：宿主起一个回环反代（认证在服务端做），这里只
       * 把它的地址塞进同源 iframe —— 不依赖壳的浏览器 WebView（本机没有），
       * 也不受对端 cookie 的 SameSite=Strict 影响。
       * 反代起不来时才退回老的"浏览器页签 / 外部浏览器"那条链。
       */
      const openWeb = async (peer) => {
        const name = (peer && peer.machine) || "对端";
        setWebPanel({ peer, name, state: "loading", reloadKey: 0 });
        try {
          const r = await api("/web-panel", { peer: (peer && (peer.machine || peer.id)) || "" });
          if (r && r.ok === true && typeof r.url === "string") {
            setWebPanel((prev) => ({
              ...(prev || { peer, name }),
              state: "ready",
              url: r.url,
              remote: r.remote || "",
              hasSession: r.hasSession !== false,
              note: r.note || "",
              reloadKey: 0,
            }));
            if (r.hasSession === false) {
              push("warn", `${name} 那边没给出可用 token，面板可能停在登录页。`);
            }
            return;
          }
          setWebPanel(null);
          push("warn", `应用内面板起不来（${(r && r.error) || "未知原因"}），改用外部方式打开。`);
        } catch (error) {
          setWebPanel(null);
          push("warn", `应用内面板起不来（${String((error && error.message) || error)}），改用外部方式打开。`);
        }

        let result;
        try {
          result = await openDshWebPage(peer);
        } catch (error) {
          push("error", `打不开 ${name} 的 Web：${String((error && error.message) || error)}`);
          return;
        }
        if (!result.ok) {
          push("error", `打不开 ${name} 的 Web：${result.reason || "未知原因"}`);
          return;
        }
        if (result.lanReachable === false) {
          push("warn", `${name} 只监听 127.0.0.1，手机连不通；在那边把 webserver.host 改成 0.0.0.0 再重启。`);
          return;
        }
        if (result.browserUnavailable) {
          push("warn", `这台壳没有可用的浏览器 WebView，已改用外部浏览器打开 ${result.url}`);
          return;
        }
        if (result.how === "browser" && result.viaHost) {
          push("success", `已打开 ${result.url}`);
          return;
        }
        if (result.how === "browser") {
          push("info", `已打开 ${result.url}`);
          return;
        }
        push("info", `应用内浏览器不可用，已用外部浏览器打开 ${result.url}`);
      };

      /**
       * 回到会话：上游 layout.selectPanel(null)。
       *
       * 宿主（Android 壳）只会给**插件管理页**注入返回键，任何其它主面板都得
       * 自己带出口——否则窄屏上点进 Mesh 就只剩浏览器的返回手势。
       */
      const leavePanel = () => {
        try {
          const layout = (pluginCtx && pluginCtx.get ? pluginCtx.get("layout") : null) || null;
          if (layout && typeof layout.selectPanel === "function") {
            layout.selectPanel(null);
            return;
          }
        } catch (error) {
          // 落到下面的兜底提示，不要静默失效
        }
        push("warn", "当前宿主没有 layout 服务，无法自动回到会话；用侧边栏切回对话即可。");
      };

      /**
       * 关掉对端 Web 面板：先卸载前端这一层，再尽力让宿主把反代也停掉
       * （停不掉只是多一个回环端口，不影响正确性）。
       */
      const closeWebPanel = () => {
        const machine = webPanel && webPanel.peer ? webPanel.peer.machine || webPanel.peer.id || "" : "";
        setWebPanel(null);
        if (!machine) return;
        api("/web-panel/close", { peer: machine }).catch(() => {
          /* 关闭是尽力而为 */
        });
      };

      /** 重新拉起面板（对端重启过、或 iframe 白屏时用）。 */
      const reloadWebPanel = () => {
        const peer = webPanel && webPanel.peer;
        if (!peer) return;
        void openWeb(peer);
      };

      /** 派发成功的统一收尾：toast + 让轮询立刻刷新。
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
          { className: cls("mesh-root", focus && "mesh-focus", narrow && "is-narrow") },
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
            onExit: leavePanel,
          }),
          loading ? h(LoadingView) : h(ErrorView, { error, onRetry: reload, onCopy: () => copy(error) }),
        );
      }

      return h(
        "div",
        { className: cls("mesh-root", focus && "mesh-focus", narrow && "is-narrow"), "data-mesh-view": view },
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
          onExit: leavePanel,
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
                onWeb: remoteEnabled ? openWeb : undefined,
                onSsh: remoteEnabled ? (peer) => setSshPeer(peer) : undefined,
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
                onWeb: remoteEnabled ? openWeb : undefined,
                onSsh: remoteEnabled ? (peer) => setSshPeer(peer) : undefined,
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
        // 窄屏底部固定派发条：任何页签都能一键展开派发（宽屏不渲染）。
        narrow
          ? h(MobileDispatchBar, {
              peers: sortedPeers,
              hostDown: !!hostDown,
              open: mobileDispatchOpen,
              onToggle: () => setMobileDispatchOpen((open) => !open),
              onScan: doScan,
              scanning,
              onDispatched: (peer, r) => notifyDispatched((peer && peer.machine) || "", r),
              density,
            })
          : null,
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
        h(WebPanel, { panel: remoteEnabled ? webPanel : null, onClose: closeWebPanel, onReload: reloadWebPanel }),
        sshPeer && remoteEnabled ? h(SshPanel, { peer: sshPeer, onClose: () => setSshPeer(null) }) : null,
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
      // P2b：窄屏适配（测试用；也便于宿主/调试面板读取断点常量）
      MOBILE_MAX_WIDTH,
      isNarrowViewport,
      useNarrowViewport,
      peerTransportBadges,
      MobileDispatchBar,
      dshWebUrl,
      resolveWebUrl,
      openDshWebPage,
      WebPanel,
      CapabilityChips,
      CapabilityInspector,
      capabilityEntries,
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
;
//# sourceMappingURL=??dsh-plugin-mesh/client.js.map&rev=81fe4f4a3488
