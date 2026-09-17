/**
 * 主动扫描：直接扫本网段的固定端口，靠一次 HTTP ping 建立连接。
 *
 * 为什么需要它 —— 组播不是万能的：
 *   · 很多路由器/AP 的 AP isolation 会隔离客户端之间的组播
 *   · Windows 防火墙默认拦入站组播，很容易被忽略
 *   · 跨 VLAN / 子网时组播根本不走
 * 而"TCP 直连固定端口"只要网络通就能成，所以它是更可靠的那条路。
 *
 * 两者是互补的：组播负责"零配置即时发现"，扫描负责"组播被挡时也能找到"。
 */
import { lanIPv4Addresses } from "./discovery.js";

/**
 * 由本机网卡推导出候选地址列表（默认扫同 /24 网段）。
 * @param extraRanges 额外网段，如 ["192.168.1.0/24"]；不传则用本机所有非回环 IPv4 的 /24
 * @param limit 最多返回多少个候选（防止超大网段扫太久）
 */
export function candidateAddresses(extraRanges = [], limit = 1024) {
  const seen = new Set();
  const out = [];
  const push = (ip) => {
    if (seen.has(ip) || out.length >= limit) return;
    seen.add(ip);
    out.push(ip);
  };

  for (const range of extraRanges) {
    for (const ip of expandCidr(range)) push(ip);
  }

  // 没给额外网段就扫本机所在 /24
  //
  // 注意：这里**不排除本机 IP**。因为同机跑多个实例时它们共用一个 IP，
  // 排掉就永远发现不了彼此；而扫到自己也无害 —— discovery.note() 会按
  // 实例 id 把自身拒掉。
  if (extraRanges.length === 0) {
    for (const { address } of lanIPv4Addresses()) {
      const prefix = address.slice(0, address.lastIndexOf("."));
      for (let host = 1; host <= 254; host += 1) push(`${prefix}.${host}`);
    }
  }
  return out;
}

/** 展开一个 a.b.c.d/nn 网段（只支持 /16~/32，避免手滑写出天量地址）。 */
function expandCidr(cidr) {
  const [base, bitsRaw] = String(cidr).split("/");
  const bits = Number(bitsRaw ?? 24);
  const parts = base.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return [];
  if (!Number.isInteger(bits) || bits < 16 || bits > 32) return [];
  const baseNum = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const size = 2 ** (32 - bits);
  const out = [];
  for (let i = 0; i < size; i += 1) {
    const n = (baseNum + i) >>> 0;
    out.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  return out;
}

/**
 * 并发探测一批地址（可跨多个端口）的 mesh 服务。
 * @param ports 要探测的端口数组；通常就是本机端口，也支持多端口
 * @returns 命中的对端记录数组（已带 sourceAddress 与 port）
 */
export async function scanForPeers({
  port,
  ports,
  addresses,
  timeoutMs = 800,
  concurrency = 64,
  onProgress,
  signal,
} = {}) {
  const found = [];
  const portList = (ports ?? (port === undefined ? [] : [port])).filter(
    (p) => Number.isInteger(p) && p >= 1 && p <= 65535,
  );
  if (portList.length === 0) return found;

  const targets = [];
  for (const p of portList) {
    for (const ip of addresses ?? candidateAddresses()) targets.push({ ip, port: p });
  }

  let index = 0;
  let done = 0;

  const worker = async () => {
    while (index < targets.length) {
      if (signal?.aborted) return;
      const { ip, port: p } = targets[index];
      index += 1;
      try {
        const res = await fetch(`http://${ip}:${p}/mesh/v1/health`, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "application/json" },
        });
        if (res.ok) {
          const body = await res.json();
          // 必须是我们的协议、且不是自己
          if (body && body.app === "dsh-mesh" && body.id) {
            found.push({ ...body, sourceAddress: ip });
          }
        }
      } catch {
        /* 绝大多数地址不会有响应，这是正常的 */
      }
      done += 1;
      onProgress?.(done, targets.length, found.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, worker));
  return found;
}
