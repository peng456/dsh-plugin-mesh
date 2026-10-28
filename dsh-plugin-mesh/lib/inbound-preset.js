/**
 * 入站任务用哪个权限 preset —— 纯函数，便于离线单测。
 *
 * 为什么单独一个模块：这段判断在 P1 之前散在 `lib/index.js` 的
 * `permissionPresetFor()` 里（tailnet 收紧 / 局域网默认），现在多了一层
 * **dsh-go 环境修正**，而这一层是真机阻塞项的根因修复，必须能被离线断言
 * （不能每次改都上手机试）。纯函数 + 显式 `dshGo` 入参也让"桌面端零变化"
 * 变成可断言的事实，而不是一句承诺。
 *
 * 解析顺序（前者优先）：
 *
 *   1. **dsh-go 环境（`permissionPresetOnDshGo` 显式覆盖 → 内置默认）**
 *      只在"检测到 dsh-go/Android proot 环境"时生效。
 *      背景（真机实测，analysis/DSHGO-BRIDGE-INTEGRATION.md §7）：
 *      dsh-go 的 proot 里没有可用沙箱后端（bubblewrap/Landlock 都没有），
 *      `workspace-write` 会解析成 sandbox(workspace-write) + approval:ask；
 *      后台会话没有 answerer → 每个入站任务都停在「待确认」，无人值守不可能。
 *      填 `danger-full-access` 才能拿到 approval:"never"。
 *      这是**环境约束**，所以它优先于 tailnet 的收紧策略（tailnet 收紧只是
 *      信任边界，环境不支持时收紧也没有意义 —— 见报告里的取舍说明）。
 *      **未显式配置时使用内置默认 `danger-full-access`**（`DSH_GO_DEFAULT_PRESET`）：
 *      mesh 的卖点就是"不需要人当中间人"，让用户为了能用而必须手改配置就违背了它；
 *      用户显式配置的 `permissionPresetOnDshGo` 或更严格 `permissionPreset` 仍然优先。
 *
 *   2. **`tsnetPermissionPreset`（tailnet 收紧）**
 *      原有语义不变：走 tailnet 进来的任务可以用更紧的权限；空 = 与局域网一致。
 *
 *   3. **`permissionPreset`（默认）**
 *      原有语义不变，桌面端行为零变化。
 */

/**
 * dsh-go（Android proot）上的内置默认 preset。
 * 只在检测到 dsh-go 且用户没有显式配置/显式配置为工作区默认时生效；桌面端永不生效。
 */
export const DSH_GO_DEFAULT_PRESET = "danger-full-access";

/** 把配置值规整成"非空字符串或空串"（空白 = 未配置）。 */
function nonEmpty(value) {
  const s = String(value ?? "").trim();
  return s;
}

/**
 * 解析入站任务生效的权限 preset。
 *
 * @param {object} opts
 * @param {object} [opts.config] 插件配置（permissionPreset / tsnetPermissionPreset / permissionPresetOnDshGo）
 * @param {{transport?: string}|null} [opts.task] 入站任务（只关心 transport：lan|tsnet）
 * @param {boolean} [opts.dshGo] 是否运行在 dsh-go/Android proot 环境（由 lib/dshgo.js 探测）
 * @returns {string} 生效的 preset 名；配置全空时返回空串（调用方按"未配置"处理）
 */
export function resolveInboundPermissionPreset({ config = {}, task = null, dshGo = false } = {}) {
  const base = nonEmpty(config?.permissionPreset);

  if (dshGo === true) {
    const dshGoOverride = nonEmpty(config?.permissionPresetOnDshGo);
    if (dshGoOverride) return dshGoOverride;
    // dsh-go 的 proot 环境没有可用沙箱后端：`workspace-write` 会被解析成
    // sandbox(workspace-write) + approval:ask，而后台入站会话没有 answerer，
    // 于是每个任务都停在「待确认」——无人值守不可能成立。所以**未显式配置时默认给完全访问**；
    // 用户若显式设了更严格的值（read-only 等）则尊重其意图，不擅自升级。
    if (!base || base === "workspace-write") return DSH_GO_DEFAULT_PRESET;
    return base;
  }

  const tsnetPreset = nonEmpty(config?.tsnetPermissionPreset);
  if (task?.transport === "tsnet" && tsnetPreset) return tsnetPreset;

  return base;
}

/**
 * 同一次解析的"来源"说明（日志/诊断用）。
 *
 * @returns {{value: string, source: "dsh-go"|"dsh-go-default"|"tsnet"|"default"|"none"}}
 */
export function describeInboundPermissionPreset({ config = {}, task = null, dshGo = false } = {}) {
  const value = resolveInboundPermissionPreset({ config, task, dshGo });
  if (dshGo === true) {
    const dshGoOverride = nonEmpty(config?.permissionPresetOnDshGo);
    if (dshGoOverride) return { value, source: "dsh-go" };
    const base = nonEmpty(config?.permissionPreset);
    if (!base || base === "workspace-write") return { value, source: "dsh-go-default" };
  }
  if (task?.transport === "tsnet" && nonEmpty(config?.tsnetPermissionPreset)) return { value, source: "tsnet" };
  return { value, source: value ? "default" : "none" };
}
