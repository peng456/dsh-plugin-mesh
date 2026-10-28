/**
 * 极简 WebSocket 服务端（只做终端需要的部分）。
 *
 * 为什么不引 ws 依赖：这个插件是"复制即用"的（包里没有构建步骤、没有运行时依赖
 * 之外的东西），多一个依赖就多一次装包事故的机会 —— 这次 npm 误删就是这么来的。
 * 终端只用文本帧 + ping/pong + close，自己实现 100 行比装一个包更可控。
 */
import { createHash, randomBytes } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 8 * 1024 * 1024;

/** 计算握手应答的 Sec-WebSocket-Accept。 */
function acceptKey(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** 组一个服务端发往客户端的帧（服务端帧不掩码）。 */
export function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/**
 * 接受一次 WebSocket 升级，并返回收发原语。
 * @param req - HTTP upgrade 请求
 * @param socket - 已建立的 TCP 连接
 * @param head - 升级时可能已读到的首段数据
 * @param handlers - { onMessage(text), onClose() }
 * @returns {{ send: (text: string) => void, close: () => void } | undefined}
 */
export function acceptUpgrade(req, socket, head, handlers = {}) {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key === "") {
    socket.destroy();
    return undefined;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let closed = false;

  const destroy = () => {
    if (closed) return;
    closed = true;
    try {
      socket.destroy();
    } catch {
      /* 已经关了 */
    }
    handlers.onClose?.();
  };

  const send = (text) => {
    if (closed) return;
    try {
      socket.write(encodeFrame(text));
    } catch {
      destroy();
    }
  };

  const pong = (payload) => {
    if (closed) return;
    const head2 = payload.length < 126 ? Buffer.from([0x8a, payload.length]) : Buffer.from([0x8a, 126, 0, payload.length]);
    try {
      socket.write(Buffer.concat([head2, payload]));
    } catch {
      destroy();
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) {
          destroy();
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_FRAME) {
        destroy();
        return;
      }
      const need = offset + (masked ? 4 : 0) + len;
      if (buffer.length < need) return;
      let mask;
      if (masked) {
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + len);
      if (!fin) continue; // 终端只用单帧，分片帧直接丢弃后半段

      if (opcode === 0x8) {
        destroy();
        return;
      }
      if (opcode === 0x9) {
        pong(payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1) {
        try {
          handlers.onMessage?.(payload.toString("utf8"));
        } catch {
          /* 单个业务消息失败不打断通道 */
        }
      }
    }
  });

  socket.on("error", destroy);
  socket.on("close", () => {
    closed = true;
    handlers.onClose?.();
  });

  return { send, close: destroy, id: randomBytes(4).toString("hex") };
}
