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
import { createRequire } from "node:module";
import { randomUUID, generateKeyPairSync, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** 每个会话在内存里保留的最近输出上限。 */
const RING_LIMIT = 200 * 1024;

/**
 * ssh2 必须**懒加载**，不能在模块顶层静态 import。
 *
 * 为什么：CI 里跑 `npm test` 的机器不装依赖（这个项目原来零运行时依赖，测试
 * 也不需要 node_modules）；静态 import 会让 `lib/index.js` 一被加载就
 * ERR_MODULE_NOT_FOUND，连不碰 SSH 的整套自测都红（实测 2026-10-29，ci 三条
 * job 全红）。改成用 createRequire 在真正要连 SSH 时再取，缺依赖就给出
 * 一句能动手的话，而不是把插件拖垮。
 */
let ssh2Module;
function loadSsh2() {
  if (ssh2Module) return ssh2Module;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("ssh2");
    ssh2Module = mod?.Client ? mod : mod?.default?.Client ? mod.default : mod;
    if (!ssh2Module?.Client) throw new Error("模块里没有 Client");
    return ssh2Module;
  } catch (err) {
    throw new Error(
      `SSH 依赖 ssh2 不可用（插件安装不完整）：${err?.message ?? err}。` +
        "重装插件（会自动装依赖），或在插件目录执行 npm i ssh2。",
    );
  }
}

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
  // 新代密钥：ed25519。RSA 只作为 ssh2 不可用时的退路（原因见 ensureKey）。
  const edKeyPath = join(stateDir, "ssh-key", "id_ed25519");
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

  /** 已经确定过的私钥，避免每次调用都读盘/重新判断。 */
  let activeKey;

  /**
   * 读（必要时生成）本机密钥对。
   *
   * 优先 ed25519，而不是最初那版无条件 RSA。两个理由：
   *   1. Node 的 crypto 导不出 OpenSSH 格式的 ed25519 私钥，所以老版只能退而用
   *      PKCS#1 RSA；但 ssh2 自带的 utils.generateKeyPairSync 能生成并解析
   *      OpenSSH 格式的 ed25519，这条路已经通了。
   *   2. RSA 还有一层额外风险：一部分自实现 sshd（例如手机侧基于 ssh2 的那套）
   *      只按老 ssh-rsa(SHA-1) 格式验签，而 ssh2 客户端会跟随对端 server-sig-algs
   *      优先用 rsa-sha2-256 签名，结果是「服务器接受了公钥、随后仍认证失败」，
   *      并且 1.17 没有客户端开关能强制降级（实测 algorithms.pubKey 不被支持）。
   *      ed25519 不走这套验签逻辑，从根上绕开。
   *
   * @returns {{pem: string, path: string} | undefined}
   */
  const ensureKey = () => {
    if (activeKey) return activeKey;
    const read = (path) => ({ pem: readFileSync(path, "utf8"), path });
    try {
      if (existsSync(edKeyPath)) {
        activeKey = read(edKeyPath);
        return activeKey;
      }
      // ssh2 可用就生成 ed25519（懒加载失败会抛，落到下面的 RSA 退路）
      try {
        const { utils } = loadSsh2();
        if (typeof utils?.generateKeyPairSync === "function") {
          const pair = utils.generateKeyPairSync("ed25519");
          if (pair?.private && pair?.public) {
            mkdirSync(dirname(edKeyPath), { recursive: true });
            writeFileSync(edKeyPath, pair.private, { mode: 0o600 });
            writeFileSync(`${edKeyPath}.pub`, `${String(pair.public).trim()}\n`, { mode: 0o644 });
            log(`已生成 SSH 密钥（ed25519）：${edKeyPath}`);
            activeKey = read(edKeyPath);
            return activeKey;
          }
        }
      } catch (error) {
        warn(`生成 ed25519 密钥失败，退回 RSA：${error?.message ?? error}`);
      }
      if (existsSync(keyPath)) {
        activeKey = read(keyPath);
        return activeKey;
      }
      // 最后退路：Node 自己生成的 PKCS#1 RSA
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
      mkdirSync(dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
      writeFileSync(`${keyPath}.pub`, `${publicKeyLine(publicKey)}\n`, { mode: 0o644 });
      log(`已生成 SSH 密钥：${keyPath}`);
      activeKey = read(keyPath);
      return activeKey;
    } catch (error) {
      warn(`读/生成 SSH 密钥失败：${error?.message ?? error}`);
      return undefined;
    }
  };
  const publicLine = () => {
    try {
      const key = activeKey ?? ensureKey();
      if (!key?.path) return "";
      return readFileSync(`${key.path}.pub`, "utf8").trim();
    } catch {
      return "";
    }
  };

  /** 公钥指纹（base64 主体部分的 sha256 前 16 位十六进制），用来判断对端那份是不是当前这把。 */
  const fingerprint = (pubLine) => {
    const body = String(pubLine).trim().split(/\s+/)[1] ?? "";
    if (!body) return "";
    return createHash("sha256").update(body).digest("hex").slice(0, 16);
  };

  /** 当前这把公钥是否确实已经部署到这台对端。 */
  const isDeployed = (machine) => {
    const saved = known(machine) ?? {};
    const fp = fingerprint(publicLine());
    return saved.hasKey === true && !!fp && saved.keyFp === fp;
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

  /**
   * 只用私钥连一次，确认免密可用。
   *
   * 注：这里**不给** ssh2 传任何签名算法偏好。1.17 的 Client 没有能强制
   * ssh-rsa(SHA-1) 的开关（algorithms.pubKey 不被支持），签名算法由对端的
   * server-sig-algs 决定；这也是把密钥换成 ed25519 的原因。
   */
  const verifyKeyLogin = ({ host, port, username, pem }) =>
    new Promise((resolve) => {
      const probe = new (loadSsh2().Client)();
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
    const how = await verifyKeyLogin({ host, port, username, pem: ensureKey()?.pem ?? "" });
    if (!how) {
      warn(`公钥已写入，但密钥登录自测没通过（${username}@${host}）`);
      return false;
    }
    // 连指纹一起落盘：换过密钥（RSA→ed25519）以后，旧记录里的 hasKey 就不该再被当真
    remember(machine, { username, hasKey: true, keyFp: fingerprint(pub) });
    log(`已为 ${machine || host} 部署公钥，之后免密登录`);
    return true;
  };

  /** 建立一个会话（给定连接参数）。 */
  const startSession = ({ host, port, username, password, privateKey, cols, rows, machine }) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const client = new (loadSsh2().Client)();
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
    // 这里的 port 是**实际连接用的端口**：直连时是用户的端口，走 tailnet 出站流时
    // 是本机回环端口。所以绝不能当"用户想用的端口"记下来——曾经就这么错过，
    // 面板回填成 55889 这种一次性隧道端口，下次必然连不上。用户意图那个端口
    // 由调用方（/mesh/api/ssh/ws）用 remember() 单独记。
    //
    // 密钥只对"当初部署它的那个用户名"有意义：换了用户名先试密钥只会换来一次
    // 认证失败，还多等一轮。所以用户名不一致时直接走密码。
    const keyApplies = !!key?.pem && (!saved.username || saved.username === username);
    // 用户这次明确给了密码、而本机这把密钥并不知道已部署到这台对端时，直接走密码：
    // 先拿密钥去试只会多一次注定失败的认证，还可能让对端多记一次失败次数。
    const deployed = isDeployed(machine);
    const attempts = [];
    if (keyApplies && (deployed || !password)) attempts.push("key");
    if (password) attempts.push("password");
    if (attempts.length === 0) throw new Error("没有可用凭据：请输入密码，或先部署密钥");

    const label = (mode) => (mode === "password" ? "密码" : "密钥");

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
          ...(mode === "password" ? {} : { privateKey: key.pem }),
        });
        log(`SSH 已连接 ${username}@${host}:${port}（${session.id.slice(0, 8)}，${label(mode)}）`);
        // 只固化"这台对端认不认本机这把密钥"；端口由调用方记，别在这里猜
        remember(machine, {
          username,
          ...(mode === "password" ? {} : { hasKey: true, keyFp: fingerprint(publicLine()) }),
        });
        if (mode === "password" && key?.pem && !deployed) {
          // 不阻塞会话：后台部署公钥 + 自测，成功后下次就是免密
          void deployKey(client, { host, port, username, machine });
        }
        return session.id;
      } catch (error) {
        lastError = error;
        warn(`SSH ${label(mode)}登录失败 ${username}@${host}: ${error.message}`);
      }
    }
    // 只试过密钥就全灭时，必须说清"是密钥被拒"，别让人以为是网络不通：
    // 历史上部署过的公钥会堆在 authorized_keys 里，当前那把对不上时密钥认证
    // 必然失败，而这时用户往往还没填密码 —— 笼统一句"认证失败"会把人带偏。
    const keyOnly = !attempts.includes("password");
    if (keyOnly) {
      throw new Error(
        `对端拒绝了本机保存的密钥（${lastError?.message ?? "认证失败"}）。` +
          "改用密码登录一次即可；要恢复密钥登录，请在设备行里重新部署密钥。" +
          "（如果对端 authorized_keys 里堆了多个历史 dsh-mesh 公钥，那些旧项不会被新密钥取代。）",
      );
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

  /**
   * 供面板使用：已知用户名 + 是否已部署密钥 + 上次用过的端口。
   *
   * hasKey 只在对端那份公钥就是本机当前这把时为真：换了密钥（RSA→ed25519）
   * 之后旧记录必须失效，否则面板会骗人地说"免密可用"，然后连接失败。
   */
  const describe = (machine) => {
    const saved = known(machine) ?? {};
    const key = activeKey ?? ensureKey();
    return {
      username: saved.username ?? "",
      hasKey: isDeployed(machine),
      port: Number(saved.port) > 0 ? Number(saved.port) : 0,
      keyPath: key?.path ?? keyPath,
    };
  };

  return { open, subscribe, write, resize, close, closeAll, list, ring, describe, remember };
}
