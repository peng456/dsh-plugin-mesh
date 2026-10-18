/**
 * 配对码二维码：把 `dsh-mesh://pair?code=<secret>` 编成 SVG data URL。
 *
 * 内容里**包含配对码**，所以只在本机 UI 按需生成，绝不调用在线 QR 服务。
 * 编码器是 lib/vendor/qrcode.mjs（qrcode-generator 2.0.4, MIT）。
 */
import qrcode from "./vendor/qrcode.mjs";

export const PAIR_URI_PREFIX = "dsh-mesh://pair?code=";

export function pairingPayload(secret) {
  const value = String(secret ?? "").trim();
  return value ? `${PAIR_URI_PREFIX}${encodeURIComponent(value)}` : "";
}

/** 返回 SVG 字符串；没有 secret 时返回空串。 */
export function pairingQrSvg(secret, { cellSize = 4, margin = 4 } = {}) {
  const text = pairingPayload(secret);
  if (text.length < PAIR_URI_PREFIX.length) return "";
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}

/** 给 <img src> 用的 data URL。 */
export function pairingQrDataUrl(secret, opts) {
  const svg = pairingQrSvg(secret, opts);
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : "";
}
