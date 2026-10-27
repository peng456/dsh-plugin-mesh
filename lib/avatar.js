/**
 * 机器头像：默认读系统用户头像，也允许 Mesh 里手动覆盖。
 *
 * 存的是 data URL，不是文件路径：对端收到后直接 <img>，不需要再开文件服务。
 * 因此必须严格限制大小/类型，否则心跳包会变成图片搬运工。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

/** 心跳里会带一份；超过这个大小就拒绝，避免组播/TCP 心跳被图片撑爆。 */
export const AVATAR_MAX_BYTES = 64 * 1024;
export const AVATAR_MAX_CHARS = 96 * 1024;

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** 校验并规范化一个 data URL；不认识/太大/类型不对都返回空串。 */
export function sanitizeAvatar(value) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length > AVATAR_MAX_CHARS) return "";
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(compact)) return "";
  const payload = compact.slice(compact.indexOf(",") + 1);
  // base64 长度 * 3/4 是上界；再留一点编码余量。
  if (payload.length > Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 8) return "";
  return compact;
}

/** 读一个本地图片文件并转成 data URL；不存在/太大/未知扩展名返回空串。 */
export function avatarFromFile(file) {
  if (typeof file !== "string" || !file || !existsSync(file)) return "";
  const mime = MIME_BY_EXT[extname(file).toLowerCase()];
  if (!mime) return "";
  try {
    const buf = readFileSync(file);
    if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) return "";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

/** Windows 当前登录用户的账户图片（注册表 Image96）。 */
function windowsAccountAvatar() {
  try {
    const sidOut = execFileSync("whoami", ["/user"], { encoding: "utf8", windowsHide: true });
    const sid = /S-1-[0-9-]+/.exec(sidOut)?.[0];
    if (!sid) return "";
    const key = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AccountPicture\\Users\\${sid}`;
    const out = execFileSync("reg", ["query", key, "/v", "Image96"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const path = /Image96\s+REG_SZ\s+(.+?)\s*$/m.exec(out)?.[1]?.trim();
    return path ? avatarFromFile(path) : "";
  } catch {
    return "";
  }
}

/**
 * 默认用户头像。顺序：
 *   1. Mesh 自己的 ~/.dsh/avatar.*（显式放这里最优先）
 *   2. Windows 账户图片
 *   3. Linux/Unix 惯例 ~/.face / ~/.face.icon
 *
 * 读不到返回空串，UI 回退到首字母。
 */
export function detectDefaultAvatar() {
  const home = homedir();
  const candidates = [
    join(home, ".dsh", "avatar.png"),
    join(home, ".dsh", "avatar.jpg"),
    join(home, ".dsh", "avatar.jpeg"),
    join(home, ".dsh", "avatar.webp"),
    join(home, ".face"),
    join(home, ".face.icon"),
  ];
  for (const file of candidates) {
    const avatar = avatarFromFile(file);
    if (avatar) return avatar;
  }
  if (process.platform === "win32") {
    const avatar = windowsAccountAvatar();
    if (avatar) return avatar;
  }
  return "";
}
