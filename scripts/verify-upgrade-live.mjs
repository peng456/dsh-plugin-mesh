/**
 * 升级「落盘 + 重启」之后的**真机**验收：进程里跑的到底是不是磁盘上的那一版。
 *
 * ── 为什么需要这个脚本 ──────────────────────────────────────────────
 * 升级是两段式的：先换磁盘文件，再重启进程。中间存在一个"半态窗口"——
 * 磁盘 0.5.23、进程 0.5.19。这个窗口**没有任何自动门禁能看见**：
 *
 *   · `check-loadable.mjs` 只证明"这份磁盘代码能被 import"，它跑在磁盘上，
 *     不知道正在跑的进程是哪一版；
 *   · CI 跑在干净的 runner 上，没有"升级前的老进程"，更没有真机的 state.json；
 *   · 面板显示的版本来自 `/mesh/api/*`（渲染器 token 门禁后面），
 *     shell 里 curl 不到，只能靠人眼看界面。
 *
 * 真踩过：磁盘升到 0.5.1，进程还跑 0.5.0，界面上一直显示 0.5.0，被当成"升级失败"。
 * 所以升级之后必须问**进程本人** —— 用 `/mesh/v1/diagnostics` 里它自报的版本，
 * 跟磁盘上的 `package.json` 对一遍。这个脚本就是那个"问"的动作。
 *
 * ── 它查什么（每一条都能独立失败）──────────────────────────────────
 *   1. 磁盘版本可读（ENOENT = 没装，不是"版本不认识"）
 *   2. 进程可达（/mesh/v1/health，免鉴权）
 *   3. 进程自述版本 = 磁盘版本（health.version / diagnostics.version）
 *   4. 无版本漂移（diagnostics.diskNewerThanProcess === false）
 *   5. state.json 健康（可解析、无 .corrupt-* 残留）—— 0.5.23 起损坏会 fail-closed
 *   6. upgrade.json 不处于"待重启"（磁盘比进程新）
 *   7. 进程稳定（隔 settle 秒再问一次 pid，变了说明在重启）
 *   8. 没有残留的一次性重启任务（macOS launchctl）
 *   9. （可选）对端数量 ≥ --expect-peers
 *
 * ── 三条口径（这个项目反复踩过的地方）──────────────────────────────
 *   · **连不上就是"没问到"**，不许改写成"版本不对"或"已是最新"；
 *   · **403 是配对闸门**，不是版本问题 —— 别把"没权限问"说成"版本不一致"；
 *   · 只读：不发派发请求、不写 state.json、不碰 sidecar。可以随时跑。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────
 *   node scripts/verify-upgrade-live.mjs                  # 本机 desktop profile
 *   node scripts/verify-upgrade-live.mjs --profile web    # 别的 profile
 *   node scripts/verify-upgrade-live.mjs --port 45930 --expect-peers 1
 *   node scripts/verify-upgrade-live.mjs --json           # 机器可读
 *   node scripts/verify-upgrade-live.mjs --self-test      # 判据自测（不碰网络，CI 跑）
 *
 * 退出码：0 = 全部通过；1 = 有用例失败；2 = 用法/环境错误（找不到插件目录等）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 与 lib/index.js 的 MESH_DEFAULT_PORT 一致。不 import：仓库里解析不到 host 依赖。 */
const DEFAULT_MESH_PORT = 45917;
/** 间隔多久再问一次 pid（只关心"有没有被重启"，不需要精确）。 */
const DEFAULT_SETTLE_SEC = 6;

// ─────────────────────────── 参数 ───────────────────────────

function parseArgs(argv) {
  const opts = {
    profile: "desktop",
    pluginDir: "",
    stateDir: join(homedir(), ".dsh", "mesh"),
    port: DEFAULT_MESH_PORT,
    settle: DEFAULT_SETTLE_SEC,
    expectPeers: null,
    json: false,
    quiet: false,
    selfTest: false,
    host: "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} 需要一个值`);
      i += 1;
      return v;
    };
    if (a === "--profile") opts.profile = next();
    else if (a === "--plugin") opts.pluginDir = next();
    else if (a === "--state-dir") opts.stateDir = next();
    else if (a === "--port") opts.port = Number(next());
    else if (a === "--host") opts.host = next();
    else if (a === "--settle") opts.settle = Number(next());
    else if (a === "--expect-peers") opts.expectPeers = Number(next());
    else if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--self-test") opts.selfTest = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0) throw new Error("--port 必须是正整数");
  if (!Number.isFinite(opts.settle) || opts.settle < 0) throw new Error("--settle 必须是非负秒数");
  if (opts.expectPeers !== null && (!Number.isFinite(opts.expectPeers) || opts.expectPeers < 0)) {
    throw new Error("--expect-peers 必须是非负整数");
  }
  if (!opts.pluginDir) {
    opts.pluginDir = join(homedir(), ".dsh", "profiles", opts.profile, "node_modules", "dsh-plugin-mesh");
  }
  return opts;
}

// ─────────────────────────── 只读采集 ───────────────────────────

function readJsonFile(path) {
  if (!existsSync(path)) return { ok: true, data: {}, error: "", missing: true };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, data: {}, error: "顶层不是对象", missing: false };
    }
    return { ok: true, data, error: "", missing: false };
  } catch (err) {
    return { ok: false, data: {}, error: String(err?.message ?? err), missing: false };
  }
}

async function getJson(url, headers = {}, timeoutMs = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body, error: "" };
  } catch (err) {
    // 超时与拒连都归"没问到"，但对人要说清是哪一种
    const msg = err?.name === "AbortError" ? `超时（${timeoutMs}ms）` : String(err?.cause?.code ?? err?.message ?? err);
    return { status: 0, body: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** macOS 上的一次性重启任务（技能 dsh-restart-safely 用的 label）。 */
function launchdRestartJob() {
  if (process.platform !== "darwin") return { skip: true, present: false };
  const out = spawnSync("launchctl", ["list"], { encoding: "utf8", timeout: 5000 });
  if (out.error || out.status !== 0) return { skip: true, present: false };
  return { skip: false, present: /com\.dsh\.restart-once/.test(String(out.stdout ?? "")) };
}

async function collect(opts) {
  const input = {
    pluginDir: opts.pluginDir,
    stateDir: opts.stateDir,
    port: opts.port,
    host: opts.host,
    expectPeers: opts.expectPeers,
    diskVersion: "",
    diskError: "",
    diskMissing: false,
    health: null,
    healthError: "",
    healthStatus: 0,
    diag: null,
    diagError: "",
    diagStatus: 0,
    diagNote: "",
    state: { ok: true, error: "", missing: false, corruptRemnants: [] },
    marker: null,
    pidFirst: null,
    pidSecond: null,
    launchd: { skip: false, present: false },
    peers: null,
    peersError: "",
  };

  // 1) 磁盘版本
  const pkgPath = join(opts.pluginDir, "package.json");
  input.diskMissing = !existsSync(pkgPath);
  if (input.diskMissing) {
    input.diskError = `找不到 ${pkgPath}`;
  } else {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      input.diskVersion = String(pkg.version ?? "");
      if (!input.diskVersion) input.diskError = "package.json 里没有 version";
    } catch (err) {
      input.diskError = `package.json 解析失败：${err?.message ?? err}`;
    }
  }

  const base = `http://${opts.host}:${opts.port}`;

  // 2) 进程可达（免鉴权路由）
  const health = await getJson(`${base}/mesh/v1/health`);
  input.healthStatus = health.status;
  if (health.status === 200 && health.body?.app === "dsh-mesh") {
    input.health = health.body;
  } else if (health.status === 503) {
    input.healthError = `本机 mesh 被一键关闭了：${health.body?.error ?? "503"}`;
  } else if (health.status === 0) {
    input.healthError = `没问到：${health.error}`;
  } else {
    input.healthError = `端口 ${opts.port} 有响应但不是 mesh（HTTP ${health.status}）`;
  }

  // 3) 进程自述（带配对码；关了配对时回环也放行）
  const stateFile = join(opts.stateDir, "state.json");
  const state = readJsonFile(stateFile);
  input.state.missing = state.missing;
  input.state.ok = state.ok;
  input.state.error = state.error;
  try {
    input.state.corruptRemnants = readdirSync(opts.stateDir).filter((n) => /^state\.json\.corrupt-/.test(n));
  } catch {
    input.state.corruptRemnants = [];
  }
  const secret = typeof state.data?.secret === "string" ? state.data.secret : "";
  const authHeaders = secret ? { "X-Dsh-Mesh-Token": secret } : {};
  if (!secret && !state.missing) input.diagNote = "state.json 里没有 secret，只能无凭据问";

  const diag = await getJson(`${base}/mesh/v1/diagnostics`, authHeaders);
  input.diagStatus = diag.status;
  if (diag.status === 200 && diag.body && typeof diag.body === "object") {
    input.diag = diag.body;
    input.pidFirst = diag.body.pid ?? null;
  } else if (diag.status === 403) {
    input.diagError = "403：本机开了 requirePairing 但凭据不对（不是版本问题）";
  } else if (diag.status === 0) {
    input.diagError = `没问到：${diag.error}`;
  } else {
    input.diagError = `HTTP ${diag.status}`;
  }

  // 4) 升级标记
  const marker = readJsonFile(join(opts.stateDir, "upgrade.json"));
  if (marker.ok && marker.data && marker.data.version) input.marker = marker.data;

  // 5) 对端数量（可选）
  if (opts.expectPeers !== null) {
    const peers = await getJson(`${base}/mesh/v1/peers`, authHeaders);
    if (peers.status === 200 && Array.isArray(peers.body?.peers)) input.peers = peers.body.peers.length;
    else input.peersError = peers.status === 0 ? `没问到：${peers.error}` : `HTTP ${peers.status}`;
  }

  // 6) 重启任务残留 + pid 稳定性
  input.launchd = launchdRestartJob();
  if (opts.settle > 0 && input.pidFirst !== null) {
    await new Promise((r) => setTimeout(r, opts.settle * 1000));
    const again = await getJson(`${base}/mesh/v1/diagnostics`, authHeaders);
    input.pidSecond = again.status === 200 ? again.body?.pid ?? null : null;
  }

  return input;
}

// ─────────────────────────── 判据（纯函数，自测直接喂它）───────────────────────────

/**
 * 把采集结果判成一串检查项。**不猜**：缺数据就那条失败，并说清是"没问到"还是"不对"。
 * @returns {{name: string, ok: boolean, detail: string}[]}
 */
export function judge(input) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail ?? "") });

  // 1. 磁盘版本
  add(
    "磁盘版本可读",
    !input.diskMissing && !input.diskError && !!input.diskVersion,
    input.diskMissing
      ? `没装：${input.diskError}`
      : input.diskError || `${input.pluginDir} → ${input.diskVersion}`,
  );

  // 2. 进程可达
  const reachable = !!input.health;
  add(
    "进程可达（/mesh/v1/health）",
    reachable,
    reachable
      ? `${input.health.machine ?? "?"} · ${input.health.os ?? "?"} · 端口 ${input.port}`
      : input.healthError || "没问到",
  );

  // 3. 自述版本 = 磁盘版本（两个来源各一条：health 是广播口径，diagnostics 是自述口径）
  const healthVersion = reachable ? String(input.health.version ?? "") : "";
  add(
    "health 自述版本 = 磁盘版本",
    reachable && !!healthVersion && healthVersion === input.diskVersion,
    !reachable ? "没问到，无法比对（不等于版本一致）" : `health=${healthVersion || "缺"} · 磁盘=${input.diskVersion || "缺"}`,
  );

  const diag = input.diag;
  add(
    "进程内版本 = 磁盘版本（升级是否生效）",
    !!diag && String(diag.version ?? "") === input.diskVersion && !!input.diskVersion,
    diag
      ? `进程=${diag.version ?? "缺"} · 磁盘=${input.diskVersion || "缺"}`
      : input.diagError || "没问到进程版本",
  );

  add(
    "diagnostics 现读磁盘版本一致",
    !!diag && String(diag.packageVersion ?? "") === input.diskVersion && !!input.diskVersion,
    diag ? `packageVersion=${diag.packageVersion ?? "缺"}` : "没问到",
  );

  // 4. 版本漂移（专门一条：这就是"装了没重启"的那个坑）
  add(
    "无版本漂移（diskNewerThanProcess=false）",
    !!diag && diag.diskNewerThanProcess === false,
    diag ? `diskNewerThanProcess=${String(diag.diskNewerThanProcess)}` : "没问到",
  );

  // 5. state.json 健康（0.5.23 起损坏会 fail-closed，真机要确认没被误触发）
  const remnants = input.state.corruptRemnants ?? [];
  add(
    "state.json 可解析",
    input.state.ok === true,
    input.state.missing ? "文件不存在（首次运行，正常）" : input.state.ok ? "ok" : `解析失败：${input.state.error}`,
  );
  add(
    "无 state.json.corrupt-* 残留",
    remnants.length === 0,
    remnants.length ? `发现 ${remnants.length} 个：${remnants.slice(0, 3).join(", ")}` : "无",
  );

  // 6. 升级标记：磁盘比进程新 = 还没重启
  const marker = input.marker;
  const markerVersion = marker ? String(marker.version ?? "") : "";
  const processVersion = diag ? String(diag.version ?? "") : healthVersion;
  const pendingRestart = !!markerVersion && !!processVersion && compareVersion(markerVersion, processVersion) > 0;
  add(
    "无待生效的升级标记",
    !pendingRestart,
    !marker ? "无标记" : pendingRestart ? `标记版本 ${markerVersion} 比进程 ${processVersion} 新 → 需要重启` : `标记 ${markerVersion} ≤ 进程 ${processVersion}（已被面板消费或无害）`,
  );

  // 7. 进程稳定
  const pid = input.pidFirst;
  const stable = pid !== null && input.pidSecond !== null && pid === input.pidSecond;
  add(
    "进程稳定（pid 未变）",
    input.pidSecond === null ? true : stable,
    input.pidSecond === null
      ? `未采样（--settle 0）`
      : stable
        ? `pid=${pid}`
        : `pid ${String(pid)} → ${String(input.pidSecond)}：采样期间被重启过`,
  );

  // 8. 重启任务残留（残留 = 还有一次重启在路上，可能循环）
  add(
    "无残留的一次性重启任务",
    input.launchd?.skip ? true : input.launchd?.present === false,
    input.launchd?.skip ? "非 macOS，跳过" : input.launchd?.present ? "launchctl 里还有 com.dsh.restart-once" : "无",
  );

  // 9. 可选：对端数量
  if (input.expectPeers !== null) {
    add(
      `对端数量 ≥ ${input.expectPeers}`,
      input.peers !== null && input.peers >= input.expectPeers,
      input.peers === null ? input.peersError || "没问到" : `实际 ${input.peers}`,
    );
  }

  return checks;
}

/** 只用于比较 "a 是否比 b 新"；解析不出来就当相等（宁可不报警）。 */
export function compareVersion(a, b) {
  const pa = String(a).replace(/^v/, "").split(/[.+-]/).map((n) => Number(n) || 0);
  const pb = String(b).replace(/^v/, "").split(/[.+-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

// ─────────────────────────── 自测：判据必须有牙 ───────────────────────────

function selfTest() {
  const base = {
    pluginDir: "/tmp/p",
    stateDir: "/tmp/s",
    port: 45917,
    host: "127.0.0.1",
    expectPeers: null,
    diskVersion: "0.5.23",
    diskError: "",
    diskMissing: false,
    health: { app: "dsh-mesh", version: "0.5.23", machine: "m", os: "darwin" },
    healthError: "",
    healthStatus: 200,
    diag: { version: "0.5.23", packageVersion: "0.5.23", diskNewerThanProcess: false, pid: 100 },
    diagError: "",
    diagStatus: 200,
    state: { ok: true, error: "", missing: false, corruptRemnants: [] },
    marker: null,
    pidFirst: 100,
    pidSecond: 100,
    launchd: { skip: false, present: false },
    peers: null,
    peersError: "",
  };
  const withInput = (patch) => ({ ...base, ...patch });
  const byName = (checks, frag) => checks.find((c) => c.name.includes(frag));
  const failNames = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

  let passed = 0;
  let failed = 0;
  const check = (label, fn) => {
    try {
      fn();
      passed += 1;
      console.log(`  ✓ ${label}`);
    } catch (err) {
      failed += 1;
      console.log(`  ✗ ${label}`);
      console.log(`      ${err?.message ?? err}`);
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  console.log("\n── 正常路径 ──");
  check("全部正常 → 0 条失败", () => {
    assert(failNames(judge(withInput({}))).length === 0, `不该有失败：${failNames(judge(withInput({})))}`);
  });

  console.log("\n── 升级没生效（就是最容易误判成失败的那个）──");
  check("进程还跑旧版 → 命中版本不一致与漂移两条", () => {
    const c = judge(
      withInput({
        diag: { version: "0.5.19", packageVersion: "0.5.23", diskNewerThanProcess: true, pid: 100 },
        health: { app: "dsh-mesh", version: "0.5.19", machine: "m" },
      }),
    );
    const names = failNames(c);
    assert(names.some((n) => n.includes("进程内版本")), `应报进程版本不一致：${names}`);
    assert(names.some((n) => n.includes("漂移")), `应报漂移：${names}`);
  });

  check("只有 diskNewerThanProcess=true 也必须报", () => {
    const c = judge(withInput({ diag: { ...base.diag, diskNewerThanProcess: true } }));
    assert(failNames(c).some((n) => n.includes("漂移")), `应报漂移：${failNames(c)}`);
  });

  console.log("\n── 没问到 ≠ 版本不对 ≠ 通过 ──");
  check("连不上：报「没问到」，且不得声称版本一致", () => {
    const c = judge(withInput({ health: null, healthError: "没问到：ECONNREFUSED", diag: null, diagError: "没问到：ECONNREFUSED", pidFirst: null, pidSecond: null }));
    const v = byName(c, "health 自述版本");
    assert(v.ok === false, "没问到不能算通过");
    assert(/没问到/.test(v.detail), `要说清是没问到：${v.detail}`);
    assert(!/一致$/.test(v.detail.replace("不等于版本一致", "")), "不许暗示版本一致");
    assert(failNames(c).length >= 3, `应有多条失败：${failNames(c)}`);
  });

  check("403（配对闸门）：说清是权限，不是版本", () => {
    const c = judge(withInput({ diag: null, diagError: "403：本机开了 requirePairing 但凭据不对（不是版本问题）", pidFirst: null, pidSecond: null }));
    const d = byName(c, "进程内版本");
    assert(d.ok === false, "没权限问不能算通过");
    assert(/403/.test(d.detail) && /不是版本问题/.test(d.detail), `口径不对：${d.detail}`);
  });

  console.log("\n── state.json（0.5.23 新增的 fail-closed 面）──");
  check("state.json 解析不了 → 失败", () => {
    const c = judge(withInput({ state: { ok: false, error: "Unexpected token", missing: false, corruptRemnants: [] } }));
    assert(byName(c, "state.json 可解析").ok === false, "应报解析失败");
  });

  check("有 .corrupt-* 残留 → 失败（说明真坏过）", () => {
    const c = judge(withInput({ state: { ok: true, error: "", missing: false, corruptRemnants: ["state.json.corrupt-1"] } }));
    assert(byName(c, "corrupt").ok === false, "应报残留");
  });

  check("文件不存在（首次运行）→ 不算失败", () => {
    const c = judge(withInput({ state: { ok: true, error: "", missing: true, corruptRemnants: [] } }));
    assert(byName(c, "state.json 可解析").ok === true, "首次运行不该判失败");
  });

  console.log("\n── 待重启标记 / 稳定性 / 重启残留 / 对端数 ──");
  check("marker 比进程新 → 报需要重启", () => {
    const c = judge(withInput({ marker: { version: "0.5.24" } }));
    assert(byName(c, "待生效").ok === false, "应报待重启");
  });

  check("marker 与进程同版本 → 无害通过", () => {
    const c = judge(withInput({ marker: { version: "0.5.23" } }));
    assert(byName(c, "待生效").ok === true, "不该报警");
  });

  check("pid 变了 → 报采样期间被重启", () => {
    const c = judge(withInput({ pidSecond: 101 }));
    assert(byName(c, "进程稳定").ok === false, "应报不稳定");
  });

  check("launchctl 还有重启任务 → 失败", () => {
    const c = judge(withInput({ launchd: { skip: false, present: true } }));
    assert(byName(c, "重启任务").ok === false, "应报残留");
  });

  check("非 macOS → 跳过而不是判失败", () => {
    const c = judge(withInput({ launchd: { skip: true, present: false } }));
    assert(byName(c, "重启任务").ok === true, "跳过不应判失败");
  });

  check("--expect-peers 没达标 → 失败；没问到 → 也说没问到", () => {
    const low = judge(withInput({ expectPeers: 2, peers: 1 }));
    assert(byName(low, "对端数量").ok === false, "应报不达标");
    const unknown = judge(withInput({ expectPeers: 2, peers: null, peersError: "没问到：超时" }));
    const item = byName(unknown, "对端数量");
    assert(item.ok === false && /没问到/.test(item.detail), `口径不对：${item.detail}`);
  });

  check("磁盘版本读不到（没装）→ 报没装，不是版本不符", () => {
    const c = judge(withInput({ diskMissing: true, diskError: "找不到 /x/package.json", diskVersion: "" }));
    const d = byName(c, "磁盘版本");
    assert(d.ok === false && /没装/.test(d.detail), `口径不对：${d.detail}`);
  });

  check("compareVersion：0.5.23 > 0.5.9，预发布小于正式", () => {
    assert(compareVersion("0.5.23", "0.5.9") === 1, "0.5.23 应大于 0.5.9");
    assert(compareVersion("v0.5.23", "0.5.23") === 0, "v 前缀应等价");
    assert(compareVersion("0.5.23-rc.1", "0.5.23") === 0, "预发布按同号处理（宁可不报警）");
  });

  console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
  return failed === 0 ? 0 : 1;
}

// ─────────────────────────── 输出 ───────────────────────────

function renderText(input, checks) {
  const lines = [];
  lines.push(`▶ 真机升级验收：${input.pluginDir}`);
  lines.push(`  mesh 端口 ${input.port} · state 目录 ${input.stateDir}`);
  for (const c of checks) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  const bad = checks.filter((c) => !c.ok);
  lines.push("");
  if (bad.length === 0) {
    lines.push(`全部通过：${checks.length} 项 —— 进程内跑的确实是磁盘上的 ${input.diskVersion || "?"}。`);
  } else {
    lines.push(`失败 ${bad.length}/${checks.length} 项：`);
    for (const c of bad) lines.push(`  · ${c.name}：${c.detail}`);
    if (!input.diag && input.diagError) lines.push(`\n提示：进程版本没问到（${input.diagError}）。需要重启或换端口，不代表升级失败。`);
  }
  return lines.join("\n");
}

// ─────────────────────────── 入口 ───────────────────────────

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err?.message ?? err}`);
    process.exit(2);
  }

  if (opts.selfTest) process.exit(selfTest());

  const input = await collect(opts);
  const checks = judge(input);

  if (opts.json) {
    console.log(JSON.stringify({ ok: checks.every((c) => c.ok), input, checks }, null, 2));
  } else if (!opts.quiet) {
    console.log(renderText(input, checks));
  }
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
