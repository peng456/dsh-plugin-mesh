/**
 * 配对码开关的判定。
 *
 * 单独成模块的理由：这段逻辑**安全相关** —— 判错了配对码会悄悄不生效，
 * 而表面上一切正常（任务照样能派过去）。埋在大文件里的三行 `if` 没人会为它
 * 写测试，所以拆出来、单测它。
 *
 * 三种来源，优先级从高到低：
 *   · 插件配置里写 `requirePairing: true` → **钉死开启**（部署方强制，界面关不掉）
 *   · `state.json` 不可信（主文件与 `.bak` 都坏）→ **fail-closed 强制开启**：
 *     开关本身就存在那个文件里，读不出来时绝不能默认「关闭」
 *   · 否则看 `state.json` 里的 `requirePairing` —— 那是界面上那个开关写的
 *
 * 默认是**关闭**：同一内网发现即可派任务，降低上手的门槛。这一点没变过 ——
 * 界面开关只是让它变得可发现、可操作，而不是改变默认。
 *
 * @param {{config?: object, state?: object, healthy?: boolean}} input
 *   `healthy=false` 表示 state.json 已不可信（读不出来，也没有可用的备份）
 * @returns {{required: boolean, pinned: boolean}} pinned = 由配置钉死，界面不可改
 */
export function resolvePairing({ config, state, healthy = true } = {}) {
  // 只有严格的布尔 true 才算开启。字符串 "true"、数字 1 都不算 ——
  // 从 YAML 里读出来的 "true" 是字符串，把它当开启会让人以为配对生效了。
  if (config && config.requirePairing === true) {
    return { required: true, pinned: true };
  }
  // fail-closed：读不出开关时按「开启」处理。反过来会在文件损坏时静默解除配对。
  if (healthy === false) {
    return { required: true, pinned: false };
  }
  return { required: !!(state && state.requirePairing === true), pinned: false };
}
