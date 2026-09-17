/**
 * dsh-plugin-mesh —— 浏览器侧（Client half）
 *
 * 手写的 __ModuleLoader__ bundle，不需要打包工具。
 * 只依赖 react，数据走相对路径 fetch('/mesh/api/*')（同源）。
 *
 * 挂两个槽位：
 *   sidebar.panellist  (list,  key=id)  → 侧栏一个图标，点击切到本面板
 *   main               (keyed, key)     → 面板内容（layout 按 activePanelId 取 entry）
 *
 * 用 ctx.slots.inject(name, cb) 注册：槽位还没声明时会自动等待，
 * 所以不依赖插件加载顺序。
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

    // ─────────────────────── 数据 ───────────────────────

    function useMeshState(intervalMs) {
      const [state, setState] = react.useState(null);
      const [error, setError] = react.useState(null);
      react.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const r = await fetch(`${API}/state`, { headers: { accept: "application/json" } });
            const j = await r.json();
            if (alive) {
              setState(j);
              setError(null);
            }
          } catch (e) {
            if (alive) setError(String((e && e.message) || e));
          }
        };
        load();
        const t = setInterval(load, intervalMs || 3000);
        return () => {
          alive = false;
          clearInterval(t);
        };
      }, [intervalMs]);
      return { state, error };
    }

    async function call(path, body) {
      const r = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return r.json().catch(() => ({}));
    }

    // ─────────────────────── 样式 ───────────────────────

    const S = {
      /**
       * 页面根容器。必须自己当滚动容器：
       * layout 的 centerCol 是 `display:flex; flex-direction:column; overflow:hidden`，
       * 面板内容一旦溢出会被直接裁掉、页面滚不动。官方面板用的是同一套
       * （conversation 的 scrollBody = flex:1 + min-height:0 + overflow-y:auto）。
       * minHeight:0 不能省 —— flex 子项默认 min-height:auto，会拒绝收缩。
       */
      page: {
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        width: "100%",
        boxSizing: "border-box",
        padding: "24px 28px",
        color: "var(--dsw-alias-label-primary, #111)",
        font: "14px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif",
      },
      /** 内容限宽居中；与滚动容器分开，滚动条才会贴窗口边缘而不是卡在 1080px 处 */
      pageInner: { maxWidth: 1080, margin: "0 auto" },
      h1: { fontSize: 20, fontWeight: 600, margin: "0 0 4px" },
      sub: { color: "var(--dsw-alias-label-secondary, #666)", fontSize: 13, marginBottom: 20 },
      card: { border: "1px solid var(--dsw-alias-border-secondary, #e3e5e8)", borderRadius: 10, padding: 16, marginBottom: 16, background: "var(--dsw-alias-bg-elevated, transparent)" },
      cardTitle: { fontSize: 13, fontWeight: 600, margin: "0 0 12px", color: "var(--dsw-alias-label-secondary, #666)" },
      row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
      input: { flex: 1, minWidth: 180, padding: "7px 10px", border: "1px solid var(--dsw-alias-border-secondary, #d5d8dc)", borderRadius: 7, background: "var(--dsw-alias-bg-base, #fff)", color: "inherit", font: "inherit" },
      textarea: { width: "100%", minHeight: 68, padding: "8px 10px", border: "1px solid var(--dsw-alias-border-secondary, #d5d8dc)", borderRadius: 7, background: "var(--dsw-alias-bg-base, #fff)", color: "inherit", font: "inherit", resize: "vertical", boxSizing: "border-box" },
      btn: { padding: "7px 14px", border: "1px solid var(--dsw-alias-border-secondary, #d5d8dc)", borderRadius: 7, background: "var(--dsw-alias-bg-elevated, #f6f7f8)", color: "inherit", cursor: "pointer", font: "inherit", whiteSpace: "nowrap" },
      btnPrimary: { padding: "7px 14px", border: "1px solid transparent", borderRadius: 7, background: "var(--dsw-alias-button-primary-fill, #111)", color: "#fff", cursor: "pointer", font: "inherit", whiteSpace: "nowrap" },
      btnSm: { padding: "4px 10px", fontSize: 12, border: "1px solid var(--dsw-alias-border-secondary, #d5d8dc)", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
      peer: { display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px solid var(--dsw-alias-border-secondary, #e8eaed)", borderRadius: 8, marginBottom: 8 },
      dot: (on) => ({ width: 8, height: 8, borderRadius: 4, flex: "0 0 auto", background: on ? "#2ea043" : "#9aa0a6" }),
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 },
      muted: { color: "var(--dsw-alias-label-secondary, #777)", fontSize: 12 },
      tag: { fontSize: 11, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-secondary, #d5d8dc)", color: "var(--dsw-alias-label-secondary, #666)" },
      log: { ...{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }, maxHeight: 220, overflow: "auto" },
      logRow: { padding: "5px 0", borderBottom: "1px solid var(--dsw-alias-border-secondary, #f0f1f3)" },
    };

    const label = { fontWeight: 600, color: "var(--dsw-alias-label-secondary, #666)", fontSize: 12, marginBottom: 4, display: "block" };

    // ─────────────────────── 小组件 ───────────────────────

    // ─────────────────────── 命名 ───────────────────────

    /**
     * 本机名字。首次使用（还落在主机名上）时主动询问一次 ——
     * 别的机器就是靠这个名字找到你的，所以值得让用户确认一下。
     */
    function NameCard({ self, onSaved }) {
      const needs = !!self.needsName;
      const fromConfig = self.machineSource === "config";
      const [editing, setEditing] = react.useState(false);
      const [value, setValue] = react.useState(self.hostname || "");
      const [msg, setMsg] = react.useState("");
      const [busy, setBusy] = react.useState(false);

      // 首次进入自动展开
      react.useEffect(() => {
        if (needs) setEditing(true);
      }, [needs]);

      const save = async () => {
        setBusy(true);
        const r = await call("/name", { name: value });
        setBusy(false);
        if (r && r.ok) {
          setMsg(`已改名为「${r.name}」，已重新广播`);
          setEditing(false);
          onSaved && onSaved();
        } else {
          setMsg(`失败：${(r && r.error) || "未知错误"}`);
        }
        setTimeout(() => setMsg(""), 4000);
      };

      if (!needs && !editing) {
        return h(
          "div",
          { style: { ...S.row, marginBottom: 12 } },
          h("span", { style: S.muted }, "本机名字"),
          h("strong", { style: { fontSize: 15 } }, self.machine || "?"),
          h("span", { style: S.tag }, fromConfig ? "由配置指定" : "已命名"),
          fromConfig
            ? null
            : h("button", { style: S.btnSm, onClick: () => { setValue(self.machine || ""); setEditing(true); } }, "改名"),
          msg ? h("span", { style: { fontSize: 12 } }, msg) : null,
        );
      }

      return h(
        "div",
        { style: { ...S.card, borderColor: needs ? "#bf8700" : undefined } },
        h("div", { style: S.cardTitle }, needs ? "首次使用：给这台机器起个名字" : "改本机名字"),
        h(
          "div",
          { style: S.muted },
          needs
            ? "其他机器会用它来找到你、把任务派给你。留空或直接用主机名也行。"
            : "别的机器正在用这个名字找你，改完会立刻重新广播。",
        ),
        h(
          "div",
          { style: { ...S.row, marginTop: 12 } },
          h("input", {
            style: S.input,
            placeholder: self.hostname || "例如 livingroom-mac",
            value,
            onChange: (e) => setValue(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter" && value.trim()) save();
            },
          }),
          h("button", { style: S.btnPrimary, onClick: save, disabled: busy || !value.trim() }, busy ? "保存中…" : "就这个"),
          h("button", { style: S.btn, onClick: () => { setValue(self.hostname || ""); } }, "用主机名"),
          editing && !needs ? h("button", { style: S.btnSm, onClick: () => setEditing(false) }, "取消") : null,
        ),
        msg ? h("div", { style: { marginTop: 8, fontSize: 12 } }, msg) : null,
      );
    }

    function SecretBox({ self, config, onSaved }) {
      const [open, setOpen] = react.useState(false);
      const [reveal, setReveal] = react.useState(false);
      const [paste, setPaste] = react.useState("");
      const [msg, setMsg] = react.useState("");
      const secret = (self && self.secret) || "";
      const required = !!(config && config.requirePairing);

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(secret);
          setMsg("已复制到剪贴板");
        } catch {
          setMsg("复制失败，请手动选择文本");
        }
        setTimeout(() => setMsg(""), 2500);
      };

      const save = async () => {
        const r = await call("/secret", { secret: paste.trim() });
        setMsg(r && r.ok ? "已保存，正在重新广播" : `保存失败：${(r && r.error) || "未知错误"}`);
        if (r && r.ok) {
          setPaste("");
          onSaved && onSaved();
        }
        setTimeout(() => setMsg(""), 3000);
      };

      return h(
        "div",
        { style: S.card },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
          h(
            "div",
            null,
            h("span", { style: S.cardTitle }, "配对码"),
            h("span", { style: { ...S.tag, marginLeft: 8 } }, required ? "已启用" : "未启用（默认）"),
          ),
          h("button", { style: S.btnSm, onClick: () => setOpen(!open) }, open ? "收起" : "展开"),
        ),
        h(
          "div",
          { style: { ...S.muted, marginTop: 8 } },
          required
            ? "当前要求两端配对码一致才能互相派发任务。"
            : "默认不需要配对：同一内网发现即可互相派发任务。若你的网络不完全可信（合租/公司/有访客设备），在插件配置里把 requirePairing 设为 true 再回来对码。",
        ),
        open
          ? h(
              "div",
              { style: { marginTop: 14 } },
              h(
                "div",
                { style: S.row },
                h("span", { style: S.muted }, "本机配对码"),
                h("code", { style: { ...S.mono, flex: 1, wordBreak: "break-all" } }, reveal ? secret || "(未生成)" : "•".repeat(Math.min(28, (secret || "").length || 28))),
                h("button", { style: S.btnSm, onClick: () => setReveal(!reveal) }, reveal ? "隐藏" : "显示"),
                h("button", { style: S.btnSm, onClick: copy }, "复制"),
              ),
              h(
                "div",
                { style: { ...S.row, marginTop: 12 } },
                h("input", {
                  style: S.input,
                  placeholder: "把另一台机器的配对码粘贴到这里，然后点保存",
                  value: paste,
                  onChange: (e) => setPaste(e.target.value),
                }),
                h("button", { style: S.btn, onClick: save, disabled: paste.trim().length < 16 }, "保存对端配对码"),
              ),
            )
          : null,
        msg ? h("div", { style: { marginTop: 8, fontSize: 12 } }, msg) : null,
      );
    }

    function PeerRow({ peer, onSend, onProbe, probe }) {
      const target = peer.machine;
      return h(
        "div",
        { style: S.peer },
        h("div", { style: S.dot(peer.online) }),
        h(
          "div",
          { style: { flex: 1, minWidth: 0 } },
          h(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            h("strong", null, peer.machine),
            peer.online ? null : h("span", { style: S.tag }, "离线"),
            h("span", { style: { ...S.muted, ...S.mono } }, `${peer.host}:${peer.port}`),
          ),
          h(
            "div",
            { style: S.muted },
            `${peer.os || "?"} · user=${peer.user || "?"}`,
            peer.profile ? ` · profile=${peer.profile}` : "",
            ` · 最后心跳 ${new Date(peer.lastSeen).toLocaleTimeString()}`,
          ),
          peer.hostname || peer.mac
            ? h(
                "div",
                { style: { ...S.mono, ...S.muted, fontSize: 11 } },
                [peer.hostname ? `hostname=${peer.hostname}  ` : "", peer.mac ? `mac=${peer.mac}` : ""],
              )
            : null,
          probe && probe.machine === target
            ? h(
                "div",
                { style: { ...S.mono, marginTop: 4, color: probe.reachable ? (probe.paired ? "#2ea043" : "#bf8700") : "#c0392b" } },
                probe.reachable ? (probe.paired ? "✓ 可达且已配对" : "⚠ 可达但配对码不一致，无法派发") : `✗ 不可达：${probe.error || ""}`,
              )
            : null,
        ),
        h("button", { style: S.btnSm, onClick: () => onProbe(target) }, "探测"),
        h("button", { style: S.btnSm, onClick: () => onSend(target), disabled: !peer.online }, "派发任务"),
      );
    }

    /**
     * 限速提示卡：某个 thread 撞到唤醒上限时，让用户决定要不要提高上限。
     *
     * 为什么要有这个：限速是为了防两个 agent 互相回执停不下来，但正常的
     * 长线程也可能撞上。所以不静默丢弃，而是把选择权交回用户：
     * 「提高上限」→ 调高该 thread 的窗口上限，并立刻放行最新一条；
     * 「忽略」→ 只清提示，上限不变，被挡的任务仍留在收件箱。
     */
    function ThrottleCard({ items, onDone }) {
      const [busy, setBusy] = react.useState("");
      if (!items || items.length === 0) return null;

      const raise = async (thread) => {
        setBusy(thread);
        const r = await call("/throttle/raise", { thread });
        setBusy("");
        onDone(
          r && r.ok
            ? `已把 ${thread} 的上限提到 ${r.cap}${r.replayed ? `，并放行最新一条（其余 ${r.remaining} 条仍在收件箱）` : ""}`
            : `提高上限失败：${(r && r.error) || "未知错误"}`,
        );
      };

      const dismiss = async (thread) => {
        setBusy(thread);
        await call("/throttle/dismiss", { thread });
        setBusy("");
        onDone(`已忽略 ${thread} 的限速提示（上限不变，被挡的任务仍在收件箱）`);
      };

      return h(
        "div",
        { style: { ...S.card, borderColor: "#d29922" } },
        h("div", { style: S.cardTitle }, "⚠ 有 thread 撞到唤醒上限，已暂停自动唤醒"),
        h(
          "div",
          { style: { ...S.muted, marginBottom: 12 } },
          "这是防「两个 agent 互相回执停不下来」的限速。下面这些线程在窗口内已用满配额，" +
            "新消息仍收进收件箱、但不会自动开跑 —— 你可以决定是否放宽。",
        ),
        items.map((it) =>
          h(
            "div",
            { key: it.thread, style: { ...S.row, justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--dsw-alias-border-secondary, #eee)" } },
            h(
              "div",
              null,
              h("div", { style: { fontWeight: 600 } }, it.thread, it.overridden ? h("span", { style: { ...S.muted, fontWeight: 400 } }, "（已手动提高过）") : null),
              h(
                "div",
                { style: S.muted },
                `上限 ${it.cap} 次 / ${Math.round(it.windowMs / 60000)} 分钟 · 已挡下 ${it.blocked} 条`,
                it.overridden ? ` · 配置默认 ${it.defaultCap}` : "",
              ),
            ),
            h(
              "div",
              { style: S.row },
              h(
                "button",
                { style: S.btnSm, disabled: busy === it.thread, onClick: () => raise(it.thread) },
                busy === it.thread ? "处理中…" : "提高上限并放行最新一条",
              ),
              h("button", { style: S.btnSm, disabled: busy === it.thread, onClick: () => dismiss(it.thread) }, "忽略"),
            ),
          ),
        ),
      );
    }

    function MeshPage() {
      const { state, error } = useMeshState(3000);
      const [target, setTarget] = react.useState("");
      const [task, setTask] = react.useState("");
      const [thread, setThread] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [toast, setToast] = react.useState("");
      const [probe, setProbe] = react.useState(null);
      const [tab, setTab] = react.useState("peers");
      const [scanning, setScanning] = react.useState(false);

      const refresh = async () => {
        await call("/refresh", {});
      };

      const doScan = async () => {
        setScanning(true);
        setToast("正在扫描本网段的 " + ((state && state.self && state.self.port) || "") + " 端口…");
        const r = await call("/scan", {});
        setScanning(false);
        setToast(
          r && r.ok
            ? `扫描完成：探测 ${r.scanned} 个地址，命中 ${r.found} 台`
            : `扫描失败：${(r && r.error) || "未知错误"}`,
        );
        setTimeout(() => setToast(""), 4000);
      };

      const doProbe = async (machine) => {
        setProbe({ machine, pending: true });
        const r = await call("/probe", { peer: machine });
        setProbe({ machine, ...r });
      };

      const doSend = async () => {
        if (!target || !task.trim()) return;
        setBusy(true);
        const r = await call("/send", { peer: target, task, thread });
        setBusy(false);
        setToast(r && r.ok ? `已派发给 ${target}（id ${r.id}）—— 对端会在它自己的会话里执行` : `派发失败：${(r && r.error) || "未知错误"}`);
        if (r && r.ok) setTask("");
        setTimeout(() => setToast(""), 5000);
      };

      if (error && !state) {
        return h("div", { style: S.page }, h("div", { style: S.pageInner }, h("h1", { style: S.h1 }, "局域网 Mesh"), h("div", { style: S.card }, `无法读取本机 mesh 状态：${error}`, h("div", { style: { ...S.muted, marginTop: 8 } }, "请确认主机侧插件 dsh-plugin-mesh 已加载。"))));
      }
      if (!state) return h("div", { style: S.page }, h("div", { style: S.pageInner }, "正在加载…"));

      const self = state.self || {};
      const cfg = state.config || {};
      const peers = state.peers || [];
      const online = peers.filter((p) => p.online);

      return h(
        "div",
        { style: S.page },
        h(
          "div",
          { style: S.pageInner },
        h("h1", { style: S.h1 }, "局域网 Mesh"),
        h(
          "div",
          { style: S.sub },
          `本机 ${self.machine} · ${self.host}:${self.port} · 发现 ${peers.length} 台，在线 ${online.length} 台`,
          h("br"),
          h("span", { style: { ...S.mono, fontSize: 11 } }, `hostname=${self.hostname || "?"}${self.mac ? "  ·  mac=" + self.mac : ""}`),
          h("br"),
          h(
            "span",
            { style: { fontSize: 12 } },
            `发现方式：${cfg.useMulticast === false ? "主动扫描" : "组播 + 扫描"}`,
            cfg.scanIntervalMs ? `（每 ${Math.round(cfg.scanIntervalMs / 1000)}s 重扫）` : "",
            cfg.pingIntervalMs ? ` · ping 保活每 ${Math.round(cfg.pingIntervalMs / 1000)}s` : "",
            ` · 配对要求：${cfg.requirePairing ? "开" : "关"}`,
          ),
        ),

        toast ? h("div", { style: { ...S.card, borderColor: "#2ea043" } }, toast) : null,

        h(ThrottleCard, { items: state.throttled || [], onDone: (msg) => { setToast(msg); setTimeout(() => setToast(""), 6000); } }),

        h(NameCard, { self, onSaved: refresh }),

        (state.duplicateNames || []).length > 0
          ? h(
              "div",
              { style: { ...S.card, borderColor: "#c0392b" } },
              `⚠ 有重名：${state.duplicateNames.join("、")}。派任务时会因为分不清目标而失败，请给其中一台改名。`,
            )
          : null,

        h(SecretBox, { self, config: cfg, onSaved: refresh }),

        h(
          "div",
          { style: S.card },
          h(
            "div",
            { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            h("div", { style: S.cardTitle }, "发现的机器"),
            h(
              "div",
              { style: S.row },
              h("button", { style: S.btnSm, onClick: doScan, disabled: scanning }, scanning ? "扫描中…" : "扫描本网段"),
              h("button", { style: S.btnSm, onClick: refresh }, "重新广播"),
              h("button", { style: S.btnSm, onClick: () => setTab(tab === "peers" ? "tasks" : "peers") }, tab === "peers" ? "看任务记录" : "看机器列表"),
            ),
          ),
          tab === "peers"
            ? peers.length === 0
              ? h(
                  "div",
                  { style: S.muted },
                  "还没有发现其他 DSH。点上面的「扫描本网段」试一次；若仍没有，对照检查：",
                  h(
                    "ul",
                    { style: { margin: "6px 0 0 18px", padding: 0 } },
                    h("li", null, "两台机器在同一网段吗"),
                    h("li", null, `对端也装了 dsh-plugin-mesh、并且用的是同一个端口（本机 ${self.port}）吗`),
                    h("li", null, "对端防火墙是否放行这个 TCP 端口（以及 UDP 45892 组播）"),
                  ),
                )
              : peers.map((p) =>
                  h(PeerRow, {
                    key: p.id,
                    peer: p,
                    onProbe: doProbe,
                    onSend: (m) => {
                      setTarget(m);
                    },
                    probe,
                  }),
                )
            : null,
        ),

        h(
          "div",
          { style: S.card },
          h("div", { style: S.cardTitle }, "派发任务"),
          h(
            "div",
            { style: { ...S.row, marginBottom: 8 } },
            h(
              "select",
              { style: { ...S.input, flex: "0 0 220px" }, value: target, onChange: (e) => setTarget(e.target.value) },
              h("option", { value: "" }, "选择目标机器…"),
              online.map((p) => h("option", { key: p.id, value: p.machine }, `${p.machine} (${p.host})`)),
            ),
            h("input", { style: { ...S.input, flex: "0 0 180px" }, placeholder: "线程标识（可选）", value: thread, onChange: (e) => setThread(e.target.value) }),
          ),
          h("textarea", { style: S.textarea, placeholder: "要对方 agent 做什么？例如：拉取最新代码，重新构建并重启 web 服务，然后回报结果。", value: task, onChange: (e) => setTask(e.target.value) }),
          h(
            "div",
            { style: { ...S.row, marginTop: 10, justifyContent: "space-between" } },
            h("div", { style: S.muted }, "异步：派发只代表对方已接收，结果会由对端 agent 回派。"),
            h("button", { style: S.btnPrimary, onClick: doSend, disabled: busy || !target || !task.trim() }, busy ? "派发中…" : "派发"),
          ),
        ),

        tab === "tasks"
          ? h(
              "div",
              { style: S.card },
              h("div", { style: S.cardTitle }, "收到的任务（对端派给本机）"),
              h(
                "div",
                { style: S.log },
                (state.inbound || []).length === 0
                  ? h("div", { style: S.muted }, "（无）")
                  : state.inbound.map((t) => h("div", { key: t.id, style: S.logRow }, h("code", { style: S.mono }, `[${t.id}]`), ` ${t.status}  `, h("strong", null, t.from), " — ", String(t.task).slice(0, 120))),
              ),
              h("div", { style: { ...S.cardTitle, marginTop: 18 } }, "派出的任务"),
              h(
                "div",
                { style: S.log },
                (state.outbound || []).length === 0
                  ? h("div", { style: S.muted }, "（无）")
                  : state.outbound.map((t, i) => h("div", { key: `${t.id}-${i}`, style: S.logRow }, h("code", { style: S.mono }, `[${t.id}]`), ` → ${t.toMachine} ${t.ok ? "已送达" : "失败"}  `, String(t.task).slice(0, 100))),
              ),
            )
          : null,
        ),
      );
    }

    /** 侧栏图标；props: {size, active} */
    function MeshIcon(props) {
      const size = (props && props.size) || 16;
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" },
        h("circle", { cx: 12, cy: 5, r: 2.4 }),
        h("circle", { cx: 5.5, cy: 18, r: 2.4 }),
        h("circle", { cx: 18.5, cy: 18, r: 2.4 }),
        h("path", { d: "M12 7.4 6.6 15.8M12 7.4l5.4 8.4M7.9 18h8.2" }),
      );
    }

    // ─────────────────────── 注册 ───────────────────────

    function apply(ctx) {
      // 侧栏面板入口
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 50, label: "Mesh" },
          MeshIcon,
        ),
      );

      // 面板内容：layout 的 MainPanel 用 activePanelId 作 key 取 main 槽
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, MeshPage),
      );

      ctx.logger?.info?.("mesh client: 已注册侧栏面板 Mesh");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
