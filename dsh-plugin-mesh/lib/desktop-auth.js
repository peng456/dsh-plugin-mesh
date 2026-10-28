/**
 * 「把本机另一个 DSH 引擎的 Web 界面转发出去」——给手机在应用内开面板用。
 *
 * 背景：同一台机器上可能同时跑着两个引擎（桌面 App 一个、CLI/web profile 一个），
 * 而用户要的是**桌面 App 那个**（有历史会话）。它只监听 127.0.0.1，且客户端
 * 会话 cookie 是 SameSite=Strict、token 又是进程级随机 —— 从网络侧直接打不开。
 *
 * 这里的做法：在**我们自己这个引擎**里开一条前缀路由，把请求转发到
 * 127.0.0.1:<desktopPort>，并自己签发一枚该 authority 的会话 cookie。
 *
 * 为什能签：cookie 只是 HMAC 签名，密钥持久化在 <DSH_HOME>/.credentials.yaml 的
 * `client-connection/browser-session` 记录里（同一 DSH_HOME 下的两个引擎共用）。
 * 签名算法：`v1.<b64url(json{version,authority,issuedAt,expiresAt})>.<b64url(hmac-sha256(secretBytes, body))>`，
 * cookie 名是 `dsh-auth-<b64url(sha256(authority))>`，密钥是**解码后的字节**而不是那串 base64。
 *
 * 边界：这是"同一台机器、同一个用户"的自我委托，不是跨用户授权；拿到它等于拿到
 * 该引擎的操作权，所以路由必须连同整条链路一起看成敏感面。
 */
import { createHmac, createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** 凭据文件里那条记录的键。 */
const AUTH_RECORD_KEY = "client-connection/browser-session";
/** cookie 名固定前缀（见 dsh-client-connection）。 */
const COOKIE_PREFIX = "dsh-auth-";
/** 签出来的 cookie 给多久：对齐上游默认的 30 天。 */
const COOKIE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function b64u(buffer) {
  return Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromB64u(text) {
  const padded = String(text).replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

/**
 * 从凭据 YAML 里抠出 browser-session 的 secret。
 *
 * 用一个只认这种形式的窄解析而不是引入 YAML 依赖：这里读的是本机自己的文件，
 * 结构由 dsh 写死（records → client-connection/browser-session → payload.secret）。
 * @returns {Buffer | undefined} 解码后的密钥字节
 */
function parseSecret(text) {
  const at = text.indexOf(`${AUTH_RECORD_KEY}:`);
  if (at === -1) return undefined;
  const rest = text.slice(at);
  const match = /secret:\s*(\S+)/.exec(rest);
  if (!match) return undefined;
  const bytes = fromB64u(match[1]);
  return bytes.byteLength > 0 ? bytes : undefined;
}

/**
 * 读（并缓存）浏览器会话密钥；凭据文件改动后自动重读。
 * @param credentialsPath - <DSH_HOME>/.credentials.yaml 的绝对路径
 * @returns {Buffer | undefined}
 */
export function createSecretReader(credentialsPath) {
  let cache;
  return () => {
    try {
      const st = statSync(credentialsPath);
      if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.secret;
      const secret = parseSecret(readFileSync(credentialsPath, "utf8"));
      cache = { mtimeMs: st.mtimeMs, size: st.size, secret };
      return secret;
    } catch {
      return undefined;
    }
  };
}

/**
 * 给某个 authority 签一枚会话 cookie。
 * @param secret - 解码后的密钥字节
 * @param authority - 目标 authority，必须与请求的 Host 完全一致（含端口）
 * @returns {{ name: string, header: string }}
 */
export function signSessionCookie(secret, authority) {
  const name = COOKIE_PREFIX + b64u(createHash("sha256").update(authority).digest());
  const issuedAt = Date.now();
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + COOKIE_MAX_AGE_MS };
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = b64u(createHmac("sha256", secret).update(body).digest());
  return { name, header: `${name}=v1.${body}.${signature}` };
}
