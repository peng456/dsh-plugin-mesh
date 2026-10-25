/**
 * 本机到对端的 SSH 终端会话管理（含密钥自动登录）。
 *
 * 认证策略：
 *   1. 本机有私钥 → 先用密钥登录；
 *   2. 密钥不可用且给了密码 → 用密码登录，**成功后顺手把公钥部署过去**，
 *      并用"只有私钥"的新连接自测一次；通过后以后不用再输密码。
 *
 * 安全边界：私钥与（可选的）密码只存本机 profile 的 mesh 状态目录，0600；
 * 部署公钥只是往对端 ~/.ssh/authorized_keys 追加一行（幂等），不需要 sudo，
 * 也不改 sshd_config。
 */
import { Client } from "ssh2";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** 每个会话在内存里保留的最近输出上限。 */
const RING_LIMIT = 200 * 1024;

/** SSH 的 mpint 编码：4 字节长度 + 大端字节（最高位为 1 时补 0x00）。 */
function mpint(bytes) {
  let body = Buffer.from(bytes);
  while (body.length > 1 && body[0] === 0) body = body.subarray(1);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

/** 生成 OpenSSH 单行公钥（RSA）。 */
function publicKeyLine(keyObject) {
  const jwk = keyObject.export({ format: "jwk" });
  const e = Buffer.from(jwk.e, "base64url");
  const n = Buffer.from(jwk.n, "base64url");
  const type = Buffer.from("ssh-rsa");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(type.length);
  return `ssh-rsa ${Buffer.concat([len, type, mpint(e), mpint(n)]).toString("base64")} dsh-mesh`;
}

/**
 * 造一个 SSH 会话管理器。
 * @param options - stateDir（存私钥）、credentialsPath（存用户名/是否已部署）、log、warn
 */
export function createSshManager({ stateDir, credentialsPath, log = () => {}, warn = () => {} }) {
  const sessions = new Map();
  const keyPath = join(stateDir, "ssh-key", "id_rsa");
  let cache;

  const loadCredentials = () => {
    if (cache !== undefined) return cache;
    try {
      const raw = JSON.parse(readFileSync(credentialsPath, "utf8"));
      cache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      cache = {};
    }
    return cache;
  };
  const saveCredentials = () => {
    try {
      mkdirSync(dirname(credentialsPath), { recursive: true });
      writeFileSync(credentialsPath, JSON.stringify(loadCredentials(), null, 2), { mode: 0o600 });
    } catch (error) {
      warn(`保存 SSH 凭据失败：${error?.message ?? error}`);
    }
  };
  const remember = (machine, patch) => {
    if (!machine) return;
    loadCredentials()[machine] = { ...(loadCredentials()[machine] ?? {}), ...patch };
    saveCredentials();
  };
  const known = (machine) => loadCredentials()[machine] ?? undefined;

  /** 读（必要时生成）本机密钥对。 */
  const ensureKey = () => {
    try {
      if (existsSync(keyPath)) return { pem: readFileSync(keyPath, "utf8"), path: keyPath };
      // 用 RSA 而不是 ed25519：ssh2 只认 OpenSSH 格式的 ed25519 私钥，
      // 而 Node 导不出那个格式；PKCS#1 的 RSA PEM 两边都认。
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
      mkdirSync(dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
      writeFileSync(`${keyPath}.pub`, `${publicKeyLine(publicKey)}\n`, { mode: 0o644 });
      log(`已生成 SSH 密钥：${keyPath}`);
      return { pem: readFileSync(keyPath, "utf8"), path: keyPath };
    } catch (error) {
      warn(`读/生成 SSH 密钥失败：${error?.message ?? error}`);
      return undefined;
    }
  };
  const publicLine = () => {
    try {
      return readFileSync(`${keyPath}.pub`, "utf8").trim();
    } catch {
      return "";
    }
  };

  /** 在已建立的连接上执行一条命令，收集输出。 */
  const exec = (client, command) =>
    new Promise((resolve) => {
      client.exec(command, (error, stream) => {
        if (error) {
          resolve({ ok: false, output: error.message });
          return;
        }
        let output = "";
        stream.on("data", (chunk) => (output += chunk.toString()));
        stream.stderr.on("data", (chunk) => (output += chunk.toString()));
        stream.on("close", (code) => resolve({ ok: code === 0 || code === undefined, output: output.trim() }));
      });
    });

  /** 用"只有私钥"的新连接自测一次，确认免密可用。 */
  const verifyKeyLogin = ({ host, port, username, pem }) =>
    new Promise((resolve) => {
      const probe = new Client();
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try {
          probe.end();
        } catch {
          /* 已断 */
        }
        resolve(ok);
      };
      probe.on("ready", () => done(true));
      probe.on("error", () => done(false));
      try {
        probe.connect({ host, port, username, privateKey: pem, readyTimeout: 12000 });
      } catch {
        done(false);
      }
    });

  /** 把公钥追加到对端（幂等），然后自测。 */
  const deployKey = async (client, { host, port, username, machine }) => {
    const pub = publicLine();
    if (!pub) return false;
    const quoted = pub.replace(/'/g, "'\\''");
    const command =
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh && " +
      "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && " +
      `grep -qF '${quoted}' ~/.ssh/authorized_keys || echo '${quoted}' >> ~/.ssh/authorized_keys`;
    const result = await exec(client, command);
    if (!result.ok) {
      warn(`部署公钥失败：${result.output.slice(0, 200)}`);
      return false;
    }
    const ok = await verifyKeyLogin({ host, port, username, pem: ensureKey()?.pem ?? "" });
    if (!ok) {
      warn(`公钥已写入，但密钥登录自测没通过（${username}@${host}）`);
      return false;
    }
    remember(machine, { username, hasKey: true });
    log(`已为 ${machine || host} 部署公钥，之后免密登录`);
    return true;
  };

  /** 建立一个会话（给定连接参数）。 */
  const startSession = ({ host, port, username, password, privateKey, cols, rows, machine }) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const client = new Client();
      const session = { id, client, stream: undefined, ring: "", listeners: new Set(), machine: machine ?? "", closed: false };
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve({ session, client });
      };
      const fail = (error) => {
        session.closed = true;
        sessions.delete(id);
        try {
          client.end();
        } catch {
          /* 已断 */
        }
        finish(error instanceof Error ? error : new Error(String(error)));
      };

      client.on("ready", () => {
        client.shell({ term: "xterm-256color", cols, rows }, (error, stream) => {
          if (error) {
            fail(new Error(`开 shell 失败：${error.message}`));
            return;
          }
          session.stream = stream;
          stream.on("data", (chunk) => {
            const text = chunk.toString("utf8");
            session.ring = (session.ring + text).slice(-RING_LIMIT);
            for (const listener of session.listeners) {
              try {
                listener(text);
              } catch {
                /* 单个订阅者失败不影响其它 */
              }
            }
          });
          stream.on("close", () => {
            session.closed = true;
            sessions.delete(id);
            for (const listener of session.listeners) {
              try {
                listener(null);
              } catch {
                /* 同上 */
              }
            }
          });
          sessions.set(id, session);
          finish();
        });
      });
      client.on("error", (error) => fail(new Error(error.message)));
      client.on("close", () => {
        if (session.closed) return;
        session.closed = true;
        sessions.delete(id);
        for (const listener of session.listeners) {
          try {
            listener(null);
          } catch {
            /* 同上 */
          }
        }
      });

      const options = {
        host,
        port,
        username,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        // 不做 known_hosts：对端是自己的机器，这是明确取舍（写在这里而不是假装做到）
      };
      if (privateKey) options.privateKey = privateKey;
      else options.password = password;

      try {
        client.connect(options);
      } catch (error) {
        fail(error);
      }
    });

  /**
   * 开一个交互式 shell：先试密钥，再试密码；密码首登成功后自动部署公钥。
   * @returns {Promise<string>} 会话 id
   */
  const open = async ({ host, port = 22, username, password = "", cols = 80, rows = 24, machine = "" }) => {
    const key = ensureKey();
    const saved = known(machine) ?? {};
    // 密钥只对"当初部署它的那个用户名"有意义：换了用户名先试密钥只会换来一次
    // 认证失败，还多等一轮。所以用户名不一致时直接走密码。
    const keyApplies = !!key?.pem && (!saved.username || saved.username === username);
    const attempts = [];
    if (keyApplies) attempts.push("key");
    if (password) attempts.push("password");
    if (attempts.length === 0) throw new Error("没有可用凭据：请输入密码，或先部署密钥");

    let lastError;
    for (const mode of attempts) {
      try {
        const { session, client } = await startSession({
          host,
          port,
          username,
          cols,
          rows,
          machine,
          password,
          ...(mode === "key" ? { privateKey: key.pem } : {}),
        });
        log(`SSH 已连接 ${username}@${host}:${port}（${session.id.slice(0, 8)}，${mode === "key" ? "密钥" : "密码"}）`);
        if (mode === "password" && key?.pem && known(machine)?.hasKey !== true) {
          // 不阻塞会话：后台部署公钥 + 自测
          void deployKey(client, { host, port, username, machine });
        }
        return session.id;
      } catch (error) {
        lastError = error;
        warn(`SSH ${mode === "key" ? "密钥" : "密码"}登录失败 ${username}@${host}: ${error.message}`);
      }
    }
    throw lastError ?? new Error("连接失败");
  };

  const subscribe = (id, listener) => {
    const session = sessions.get(id);
    if (!session) return () => {};
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  };

  const write = (id, data) => {
    const session = sessions.get(id);
    if (!session?.stream) return false;
    try {
      session.stream.write(data);
      return true;
    } catch {
      return false;
    }
  };

  const resize = (id, cols, rows) => {
    const session = sessions.get(id);
    if (!session?.stream) return false;
    try {
      session.stream.setWindow(rows, cols, 0, 0);
      return true;
    } catch {
      return false;
    }
  };

  const close = (id) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.closed = true;
    try {
      session.stream?.end();
    } catch {
      /* 已断 */
    }
    try {
      session.client.end();
    } catch {
      /* 已断 */
    }
  };

  const closeAll = () => {
    for (const id of [...sessions.keys()]) close(id);
  };

  const list = () => [...sessions.values()].map((s) => ({ id: s.id, machine: s.machine, alive: !!s.stream, buffered: s.ring.length }));
  const ring = (id) => sessions.get(id)?.ring ?? "";

  /** 供面板使用：已知用户名 + 是否已部署密钥。 */
  const describe = (machine) => {
    const saved = known(machine) ?? {};
    return { username: saved.username ?? "", hasKey: saved.hasKey === true, keyPath };
  };

  return { open, subscribe, write, resize, close, closeAll, list, ring, describe, remember };
}
