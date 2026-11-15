/**
 * 对端 GUI 的 `/api` 浏览器信任围栏 —— 「拨通」不等于「能用」。
 *
 * 复现过的现场（2026-11-13，Mac 看 Android 机 `hos`：`192.168.1.6:3080`）：
 *   · `GET http://192.168.1.6:3080/` → `200`，于是观看端判定"局域网可达"，开直连代理；
 *   · 同一台机器 `GET /api/anything` → `403 forbidden`。对端 `client-connection` 的
 *     `isTrustedApiRequest` 只认**回环权威**或 `trustedHosts` 里登记过的权威；它明明
 *     绑在 `0.0.0.0`，却没把局域网 IP 派生进 `trustedHosts`（Android 壳起 Web 时常见）；
 *   · 结果：页面能渲染（index 靠 cookie 过），`/api/remote.mux` 的 WS 升级被拒，
 *     DSH 客户端按指数退避无限重试 —— 界面永远停在「重新连接中…」。
 *
 * 判别式只有一条，而且干净，看同一个探测请求的状态码：
 *   · `403` = 围栏把**本机权威**拒了（页面通、接口不通，直连没有意义，该改走隧道）；
 *   · `401`/`200`/`404` = 围栏过了，只是没有会话（"能用，只是要登录"）；
 *   · 超时/连不上 = `undefined`：别把探测失败伪装成否定事实（AGENTS.md 硬约束 1）。
 *
 * 探测是只读 GET、不带任何凭据、不改对端状态；路径落在 `/api` 前缀下即可 ——
 * 围栏在路由匹配**之前**执行，所以随便一个不存在的端点也能问出答案。
 */

/** 探测路径：只要在 `/api` 前缀下就会先过围栏。 */
export const API_FENCE_PROBE_PATH = "/api/__mesh-fence-probe";
/** 探测超时：一次局域网来回；超时也只是"没结论"，不改变后续决策。 */
export const API_FENCE_PROBE_MS = 1500;

/** 目标地址的权威（`host:port`），用于把话说清楚。 */
function authorityOf(base) {
  try {
    return new URL(String(base)).host;
  } catch {
    return "";
  }
}

/**
 * 问一次对端：`/api` 的围栏认不认本机这个权威？
 *
 * @param {string} base - 对端 GUI 的绝对地址（`http://host:port/`，不含 token 参数）
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - 探测超时
 * @param {Function} [options.fetchImpl] - 注入用（自测替身）
 * @returns {Promise<{ fenced: boolean | undefined, note: string }>}
 *   `fenced: true` 才代表"直连不可用"；`undefined` 表示没问出结论。
 */
export async function probeApiFence(base, { timeoutMs = API_FENCE_PROBE_MS, fetchImpl = globalThis.fetch } = {}) {
  let url;
  try {
    url = new URL(API_FENCE_PROBE_PATH, String(base)).href;
  } catch {
    return { fenced: undefined, note: `地址 ${String(base)} 解析不了` };
  }
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 只关心状态码；响应体一律不要（别把对端的错误页留在内存里）。
    try {
      await res.body?.cancel?.();
    } catch {
      /* 取消除失败无所谓 */
    }
    if (res.status === 403) {
      const authority = authorityOf(base);
      return {
        fenced: true,
        note: `对端 /api 拒绝本机权威（HTTP 403）：${authority || "本机"} 不在对端的 trustedHosts 里，/api/remote.mux 会被永久拒绝`,
      };
    }
    return { fenced: false, note: `HTTP ${res.status}` };
  } catch (err) {
    return { fenced: undefined, note: `${timeoutMs}ms 内没有响应（${err?.message ?? err}）` };
  }
}
