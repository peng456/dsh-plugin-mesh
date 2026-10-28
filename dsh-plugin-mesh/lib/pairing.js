/**
 * 配对码开关的判定。
 *
 * 单独成模块的理由：这段逻辑**安全相关** —— 判错了配对码会悄悄不生效，
 * 而表面上一切正常（任务照样能派过去）。埋在大文件里的三行 `if` 没人会为它
 * 写测试，所以拆出来、单测它。
 *
 * 两种来源，规则和 tsnet 开关一致：
 *   · 插件配置里写 `requirePairing: true` → **钉死开启**（部署方强制，界面关不掉）
 *   · 否则看 `state.json` 里的 `requirePairing` —— 那是界面上那个开关写的
 *
 * 默认是**关闭**：同一内网发现即可派任务，降低上手的门槛。这一点没变过 ——
 * 界面开关只是让它变得可发现、可操作，而不是改变默认。
 *
 * @param {{config?: object, state?: object}} input
 * @returns {{required: boolean, pinned: boolean}} pinned = 由配置钉死，界面不可改
 */
export function resolvePairing({ config, state } = {}) {
  // 只有严格的布尔 true 才算开启。字符串 "true"、数字 1 都不算 ——
  // 从 YAML 里读出来的 "true" 是字符串，把它当开启会让人以为配对生效了。
  if (config && config.requirePairing === true) {
    return { required: true, pinned: true };
  }
  return { required: !!(state && state.requirePairing === true), pinned: false };
}
