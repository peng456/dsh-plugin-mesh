/**
 * 设备能力采集（Placement 步骤 ①：能力采集 + 名片携带）。
 *
 * 解决什么问题：Placement 要回答"这个任务该由哪台机器做"，前提是先知道
 * **每台机器能做什么**。这份数据由每台设备自述，搭现有名片（selfRecord）的
 * 便车扩散 —— 不新增协议、不新增定时器。详见 Placement设计.md 第 1 节。
 *
 * 三条设计约束（都是踩过的坑换来的）：
 *
 *   1. **绝不在心跳里探测。** 每 5 秒 spawn 9 个进程是不可接受的。所以启动时
 *      采集一次、结果缓存，心跳只是重复携带缓存值。
 *   2. **绝不阻塞启动。** 采集全是异步的，`currentCapabilities()` 同步返回缓存
 *      （首轮采集完成前是 null → 名片里 `capabilities: null`，对端当作"未知"
 *      而不是"什么都没有"，这个区分很重要）。
 *   3. **绝不往外抛。** 探测失败、命令不存在、平台不支持 —— 一律降级成"没有
 *      这一项"，绝不抛异常。这个模块跑在插件启动路径上，抛一次就是插件加载
 *      失败。
 *
 * 另一个容易被忽略的点：**PATH 必须补全**。macOS 上从 GUI 启动的 DSH 继承的
 * PATH 是 `/usr/bin:/bin:/usr/sbin:/sbin`（Electron 的 launchd 环境），
 * Homebrew 的 `/opt/homebrew/bin`、`/usr/local/bin`、`~/go/bin`、`~/.cargo/bin`
 * 全都不在里面。不补的话结果是"Mac 上什么运行时都没装"——静默错误，比采集
 * 失败更糟，因为它看起来像正常的空数据。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, release, totalmem, cpus, platform, arch } from "node:os";
import { join, delimiter } from "node:path";

/** 重新采集的间隔。设计上低频：装了新运行时最迟 10 分钟后上名片。 */
export const CAPABILITY_REFRESH_MS = 10 * 60 * 1000;

/**
 * 名片里的能力超过这个年龄就按"未知"处理。
 *
 * 阈值取刷新间隔的 3 倍：偶发一轮采集失败不该让对端立刻把我们看成"什么都不会"，
 * 但采集机制真的坏掉（时间戳冻结）时必须在有限时间内被发现。
 */
export const CAPABILITY_STALE_MS = 3 * CAPABILITY_REFRESH_MS;

/**
 * 单条探测命令的超时。健康时这些命令都是 ~50ms 返回，2500ms 是 50 倍余量。
 *
 * 为什么不能设得更短：实测踩过 —— 机器忙（DSH 刚启动、或在跑重活）时并行
 * spawn 9 个子进程会被自己的超时全部杀掉，结果是一份"这台机器什么运行时都
 * 没装"的名片。**那是错误的答案，而且看起来完全正常**，Placement 会据此把
 * 能跑的机器排除掉。所以超时给足，并且超时要能被识别 + 重试（见 collectRuntimes）。
 */
const PROBE_TIMEOUT_MS = 2500;

/**
 * 重试用的超时。更宽松，因为重试是**串行**的 —— 争用源已经消失了，
 * 再给一次足够的机会就能拿到真值。
 */
const RETRY_TIMEOUT_MS = 8000;

/** 重试前的退避：给机器一点时间把刚才那波负载消化掉。 */
const RETRY_BACKOFF_MS = 800;

/**
 * GPU 探测单独给更长超时：macOS 的 `system_profiler` 实测要 1~3 秒。
 * 它跟其它探测**并行**跑，所以只影响首轮采集的总时长，不影响心跳。
 */
const GPU_TIMEOUT_MS = 3500;

/**
 * 要探测的运行时。只取"名字 + 主版本号"，不带路径、不带编译选项 ——
 * 路径会泄露目录结构，而且对"这台机器能不能跑这个任务"没有增量信息。
 *
 * `fallback` 用于同一运行时的不同命令名（Linux/macOS 是 python3，
 * Windows 只有 python）。
 */
const RUNTIMES = [
  { name: "node", cmd: "node", args: ["--version"] },
  { name: "python", cmd: "python3", args: ["--version"], fallback: { cmd: "python", args: ["--version"] } },
  { name: "go", cmd: "go", args: ["version"] },
  { name: "docker", cmd: "docker", args: ["--version"] },
  { name: "git", cmd: "git", args: ["--version"] },
  { name: "rustc", cmd: "rustc", args: ["--version"] },
  // java 把版本写到 **stderr**，不是 stdout —— 只读 stdout 会永远采不到
  { name: "java", cmd: "java", args: ["-version"] },
  { name: "ffmpeg", cmd: "ffmpeg", args: ["-version"] },
  { name: "adb", cmd: "adb", args: ["version"] },
];

/**
 * 常见运行时安装目录。GUI 启动的进程 PATH 极简，这些都要补上。
 * 顺序按"越具体越靠前"无关紧要 —— 只是补进 PATH，由 shell 语义决定命中哪个。
 *
 * ⚠️ **必须分平台**。这个函数原本只列 Unix 路径，在 Windows 上等于**没补** ——
 * 而 Windows 恰好最需要补：从 GUI 启动的 DSH 继承的 PATH 里往往没有 node
 * （实测对端 `文超-win` 因此报回 `runtimes: {}` 且 `runtimesIncomplete: false`，
 * 等于宣称"确定没装任何运行时"，而它自己就跑在 Node 上）。补完 Windows 后，
 * 那个假阴性才从根上消失。见下面 collectCapabilities 里的"形状守卫"作为第二道防线。
 */
function extraPathDirs(p = platform(), env = process.env) {
  const home = homedir();

  if (p === "win32") {
    // Windows 的 PATH 用 `;` 分隔、目录名大小写不敏感、且**没有** POSIX 那套固定位置。
    // 这里只列"装了就在这"的常见根；环境变量缺失时该段直接跳过。
    const cand = [
      env.ProgramFiles && join(env.ProgramFiles, "nodejs"),
      env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "nodejs"),
      env.APPDATA && join(env.APPDATA, "npm"),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Python"),
      // 不要把 WindowsApps 补进探测 PATH：那里几乎全是 0 字节的 Store 别名存根，
      // 前置后会遮住后面真正的 python.exe / node.exe（spawn 得 exit 9009）。
      env.ProgramFiles && join(env.ProgramFiles, "Git", "cmd"),
      env.ProgramFiles && join(env.ProgramFiles, "Docker", "Docker", "resources", "bin"),
      env.ProgramData && join(env.ProgramData, "chocolatey", "bin"),
      env.USERPROFILE && join(env.USERPROFILE, "scoop", "shims"),
      env.USERPROFILE && join(env.USERPROFILE, ".cargo", "bin"),
      env.USERPROFILE && join(env.USERPROFILE, "go", "bin"),
      env.USERPROFILE && join(env.USERPROFILE, ".bun", "bin"),
      env.USERPROFILE && join(env.USERPROFILE, ".deno", "bin"),
    ].filter(Boolean);
    return cand.filter(isDir);
  }

  const dirs = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/opt/local/bin",
    join(home, ".local", "bin"),
    join(home, "go", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    "/usr/local/go/bin",
    // Termux / Android：DSH 手机端跑在这里，PATH 由 app 继承，通常已经对了，
    // 但显式列出无害（不存在就跳过）。
    "/data/data/com.termux/files/usr/bin",
  ];
  return dirs.filter(isDir);
}

/** 目录存在才补进去；任何异常都当作"不存在"。 */
function isDir(d) {
  try {
    return existsSync(d);
  } catch {
    return false;
  }
}

/**
 * 归一化一个 PATH 项，**只用于判重**，不改写真正写进 PATH 的字符串
 * （原样保留：装到别人机器上的东西不该被我悄悄换个写法）。
 *
 * 为什么需要它：`/usr/local/bin` 与 `/usr/local/bin/` 是同一个目录，但字符串不等。
 * 只做精确比对时，"补全"会把同一个目录再插一遍。这不是理论问题 —— 自测里那条
 * "PATH 里不该有重复目录"在 GitHub 的 runner 上首跑就红了，本机不红（本机 PATH
 * 的写法恰好一致）。判重必须按**目录**判，不能按字符串判。
 */
function normPathForCompare(d, p = platform()) {
  let s = String(d).trim();
  // 根目录去掉尾分隔符就没意义了（"/" → ""），原样返回
  const isRoot = s === "/" || /^[A-Za-z]:[\\/]?$/.test(s);
  if (!isRoot) s = s.replace(/[\\/]+$/, "");
  return p === "win32" ? s.toLowerCase() : s;
}

/** 补全后的 PATH 字符串。 */
export function augmentedPath(current = String(process.env.PATH ?? ""), p = platform()) {
  // 分隔符必须跟平台走：Windows 是 `;`，POSIX 是 `:`。写死 `:` 会让 Windows 上
  // 整个 PATH 变成一个"目录名"，比不补还糟。
  const sep = p === "win32" ? ";" : delimiter;
  const parts = String(current).split(sep).filter(Boolean);
  const present = new Set(parts);
  const seen = new Set(parts.map((d) => normPathForCompare(d, p)));
  const extra = [];
  for (const d of extraPathDirs(p)) {
    const key = normPathForCompare(d, p);
    if (!key || seen.has(key)) continue; // 已经在 PATH 里（哪怕写法不同）就不再插
    seen.add(key);
    extra.push(d);
  }
  // 注意：**无条件重建**，不能"没有可补的就 return current"。
  // 那条捷径会把调用方 PATH 里本来就有的重复项原样带出去 —— 当所有补全候选都
  // 已经在 PATH 里时（GitHub 的 runner 上正是如此），"没有重复项"这条自测就会红，
  // 而且红得莫名其妙：我们明明一个目录都没加。
  return [...extra, ...present].join(sep);
}
/** 探测用的环境变量：补全 PATH，保留其余。 */
function probeEnv() {
  return { ...process.env, PATH: augmentedPath() };
}

/**
 * 跑一条命令，stdout + stderr 一起收（java 这类把版本写 stderr）。
 * 任何失败都解析成空串，绝不抛。
 *
 * 返回 `{ output, error }`，`error` 是**短的错误码**而不是零/非零二值：
 *   · ""        成功
 *   · "ENOENT"  命令不存在 → 确定「没装」
 *   · "timeout" 被我们的超时杀掉 → **不确定**（机器忙 / 启动期事件循环阻塞）
 *   · "exit-N"  命令存在但退出码非零 → 通常「没装好」
 *
 * 为什么非要分开：`ENOENT` 和 `timeout` 都被当成"没有"时，一台正在忙的机器会
 * 被报成"什么运行时都没装"，而 Placement 会据此把它排除。**这是静默的错误
 * 答案，比报错更糟**——和 routeDecision / dispatchError 是同一个教训。
 */
function runProbe(cmd, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = execFile(
        cmd,
        args,
        { timeout: timeoutMs, windowsHide: true, env: probeEnv(), maxBuffer: 1 << 20 },
        (err, stdout, stderr) => {
          const out = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
          // 有输出就先认输出：部分 JDK 的 `java -version` 退出码非零，
          // 但版本已经完整打出来了。被超时杀掉时也可能已经收到了输出。
          if (out) return done({ output: out, error: "" });
          if (!err) return done({ output: "", error: "" });
          if (err.code === "ENOENT") return done({ output: "", error: "ENOENT" });
          if (err.killed) return done({ output: "", error: "timeout" });
          return done({ output: "", error: `exit-${err.code ?? err.signal ?? "?"}` });
        },
      );
    } catch (err) {
      return done({ output: "", error: err?.code === "ENOENT" ? "ENOENT" : "spawn-failed" });
    }
    child.on?.("error", (err) => done({ output: "", error: err?.code === "ENOENT" ? "ENOENT" : "spawn-failed" }));
  });
}

/**
 * 从版本输出里取 `主.次`。
 *
 * 只报主次版本：对"能不能跑"来说，补丁号没有意义，而少一个字段就少一份
 * 需要同步的协议面。取第一个匹配，避免把 `go1.25.1 darwin/amd64` 里的
 * 架构数字当成版本。
 */
export function parseVersion(output) {
  const m = String(output ?? "").match(/(\d+)\.(\d+)/);
  if (m) return `${m[1]}.${m[2]}`;
  const one = String(output ?? "").match(/(\d+)/);
  return one ? one[1] : "";
}

/** 探测单个运行时；没装返回 `{version:"", error:"ENOENT"}`。 */
async function probeRuntime(spec, timeoutMs = PROBE_TIMEOUT_MS) {
  let r = await runProbe(spec.cmd, spec.args, timeoutMs);
  if (!r.output && spec.fallback) r = await runProbe(spec.fallback.cmd, spec.fallback.args, timeoutMs);
  return { version: parseVersion(r.output), error: r.output ? "" : r.error };
}

/**
 * 探测结果"不确定"吗（我们没能问出答案，而不是对方明确说"没有"）。
 *
 * `ENOENT` / `exit-N` 是**确定**的否定；`timeout` / `spawn-failed` / `throw:`
 * 是**不确定** —— 不能当作"没装"。
 */
function isUncertain(error) {
  return (
    error === "timeout" ||
    error === "spawn-failed" ||
    // Windows Store 别名存根：文件 0 字节，spawn 得到 exit 9009、无输出。
    // 这是“没问出答案”，不是“确定没装”。
    error === "exit-9009" ||
    String(error).startsWith("throw:")
  );
}

/**
 * 采集所有运行时。
 *
 * 返回 `{ runtimes, errors }`：
 *   · runtimes 只含探测到的（没装的不出现）
 *   · errors 只含失败项及其短错误码，供日志 / UI 诊断用
 *
 * **不确定的项要串行重试一次。** 这不是"多试一次总没坏处"的迷信，而是针对
 * 实测的失败模式：首轮是 9 个 spawn **并行**发出的，机器忙的时候它们会互相
 * 争用，一起被自己的超时杀掉 → 名片变成"什么都没装"。重试改成**串行**，
 * 正好消除了那个争用源，所以第二次基本都能拿到真值。
 *
 * 整个函数不抛：单项失败降级成该项缺失。
 *
 * @param specs 探测清单。默认用内置的 RUNTIMES；自测传假命令来验证重试行为。
 */
export async function collectRuntimes(specs = RUNTIMES) {
  const runtimes = {};
  const errors = {};

  const results = await Promise.all(
    specs.map(async (spec) => {
      try {
        return { spec, ...(await probeRuntime(spec)) };
      } catch (err) {
        return { spec, version: "", error: `throw:${err?.code ?? "?"}` };
      }
    }),
  );

  // 串行重试"不确定"的那些
  const uncertain = results.filter((r) => !r.version && isUncertain(r.error));
  if (uncertain.length > 0) {
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    for (const item of uncertain) {
      try {
        const again = await probeRuntime(item.spec, RETRY_TIMEOUT_MS);
        if (again.version) {
          item.version = again.version;
          item.error = "";
        } else if (!isUncertain(again.error)) {
          // 重试给出了明确答案（确实没装）→ 采纳这个更确定的结论
          item.error = again.error;
        }
        // 仍然不确定 → 保留 "timeout"，调用方据此把整份名片标记为不完整
      } catch (err) {
        item.error = `throw:${err?.code ?? "?"}`;
      }
    }
  }

  for (const r of results) {
    if (r.version) runtimes[r.spec.name] = r.version;
    else errors[r.spec.name] = r.error || "empty-output";
  }
  return { runtimes, errors };
}

/**
 * 探测失败的项里有没有"不确定"的（超时 / spawn 失败）。
 *
 * 与"确定没装"（ENOENT、exit-N）分开：**不确定的不能让 Placement 据此排除
 * 这台机器** —— 机器忙导致的探测超时，不代表它没装这个运行时。
 */
function hasUncertainProbe(errors) {
  return Object.values(errors ?? {}).some((e) => isUncertain(e));
}

/**
 * **形状守卫**：一个运行时都没探到，却又存在失败项 → 一律当作"未探准"。
 *
 * 为什么需要它（这是拿真实事故换的）：`isUncertain()` 把 ENOENT 当作**确定**答案
 * （"命令不在 PATH 里" ≈ "没装"）。这个等号在正常情况下成立，但只要 PATH 本身
 * 是错的，它就会把"找不到"整批翻译成"确定没装"。
 *
 * 实测对端 `文超-win`：`runtimes: {}` 且 `runtimesIncomplete: false` —— 即在名片上
 * 宣称"这台机器确定没有任何运行时"，而它自己**就跑在 Node 上**（DSH 是 Node 应用）。
 * 根因是当时 `extraPathDirs()` 没有 Windows 分支、PATH 补全失效（已修）。
 *
 * 为什么用"整批全空"当信号而不是逐个判：误报的代价是**不对称**的。
 *   · 误报"没装" → Placement 把一台能跑的机器**排除**掉，且无声无息；
 *   · 误报"未探准" → 只是让人多问一句。
 * 所以宁可把这种可疑形状标成"未探准"。真·干净机器（容器/精简镜像）会因此被标为
 * 未探准 —— 可接受：那种机器上本来就该由人来确认，不该由探测替人拍板。
 *
 * 注意：`runtimes` 非空时**不**触发（探到过东西就说明 PATH 基本可用，剩下的
 * ENOENT 是可信的"没装"）。这条守卫只兜"整批归零"这个说谎形状。
 */
function isEmptyButFailed({ runtimes, errors } = {}) {
  return Object.keys(runtimes ?? {}).length === 0 && Object.keys(errors ?? {}).length > 0;
}

/**
 * **PATH 补全到底有没有生效** —— 自校验式判据，不用硬编码"本平台工具目录"。
 *
 * 判据就一句：`extraPathDirs()` 在**这台机器上**能不能真的加进一个存在的目录。
 *   · 能（darwin/linux 正常机器，`/opt/homebrew/bin`、`/usr/local/bin`… 存在）
 *     → 补全生效 → 找不到的命令是**真的不在**，"ENOENT = 没装"可信；
 *   · 不能（Windows 从 GUI 启动时 `%ProgramFiles%\nodejs` 等都不存在；
 *     Android/Termux 那套路径同样不存在）
 *     → 补全等于没做 → PATH 可能不全 → ENOENT **不可信**。
 *
 * 为什么用这个而不是"目录白名单"：白名单是**硬编码的根**，一旦某台机器的
 * 运行时装在白名单之外的 prefix（对端实测：它的 `usr/bin` 是
 * `/data/data/com.dsharnessmobile.shell/files/usr/bin`，不在任何常见白名单里），
 * 白名单就会**假阳性判残缺**。而"补全有没有真的加进目录"是自校验的：
 * 它问的是**我们自己的兜底机制有没有起作用**，与平台布局无关，也不需要维护清单。
 *
 * 对端走过的弯路值得记下来：它先用"本机 PATH 里有没有 `/system/bin`"当佐证，
 * 又撤回（重测发现 `/system/bin` 其实**在**它的 PATH 里）；随后它自己跑了
 * `command -v`，确认那 6 个工具**确实都没装** —— 也就是说**它那台根本没有缺陷**。
 * 这条判据的意义不是"保护某个平台"，而是：**只有当我们连兜底都没做成时，
 * 才不许把 ENOENT 当成结论。**
 */
/**
 * Store 别名目录（WindowsApps）**不能当作"这里有运行时"的证据**。
 *
 * 对端 文超-win 实测：该目录里 18 个 .exe **全部**是 0 字节 + ReparsePoint 的
 * Store 别名存根（python.exe / winget.exe / notepad.exe …），spawn 得到 exit=9009、
 * 空输出；而该目录几乎在每台 Win10/11 上都存在。
 *
 * 为什么必须排除：本判据的形状是"补全能不能真的加进一个存在的目录"。若把
 * WindowsApps 算进去，Windows 上会**恒判"可信"** → 假阴性原样复发 —— 实测
 * 文超-win 的候选表去掉 WindowsApps 后恰好为 0，带上它则为 1。
 *
 * 注意范围：这个正则本身只用于**健康判据**；探测用的 PATH 里也**不再**补
 * WindowsApps（见 extraPathDirs）。原先这里写着"留着无害"，是错的：把它前置到
 * PATH 会挡住真正的 python.exe / node.exe，spawn 得到 exit=9009 + 空输出，
 * 于是"装了"被当成"没装"。现在这种输出记为**不确定**（见 isUncertain），
 * 而不是当作反向证据。
 */
const STORE_ALIAS_DIR = /[\\/]Microsoft[\\/]WindowsApps$/i;

function pathLookupUnreliable(p = platform()) {
  return extraPathDirs(p).filter((d) => !STORE_ALIAS_DIR.test(d)).length === 0;
}

/**
 * 失败项数（含 ENOENT）—— 上名片，让对端能自行判断这份运行时列表有多可信。
 *
 * 与 `pathLookupUnreliable()` 配套：补全失效**且**有失败项时，这份"没探到"
 * 的清单就不能当结论用（对端看到非零计数 + `runtimesIncomplete=true` 能自行判断）。
 */
export function probeFailCount({ errors } = {}) {
  return Object.keys(errors ?? {}).length;
}

/** 只为自测导出：形状守卫的判据本身值得单测（真实机器很难复现"整批归零"）。 */
export const __isEmptyButFailed = isEmptyButFailed;
/** 只为自测导出：让测试能注入平台/PATH 验证"PATH 残缺"判据，不必真改本机 PATH。 */
export const __extraPathDirs = extraPathDirs;
export const __pathLookupUnreliable = pathLookupUnreliable;
/** 只为自测导出：目录判重的归一化规则（"换了写法"这种失败本机极难自然复现）。 */
export const __normPathForCompare = normPathForCompare;
/** 只为自测导出：原始 GPU 探测输出 —— 用来区分"这台机器没有显卡"和"解析器坏了"。 */
export const __probeGpu = probeGpu;
export const __isUncertain = isUncertain;
/** 只为自测导出：Store 别名目录的排除规则（Mac 上没有该目录，无法端到端复现）。 */
export const __storeAliasDir = STORE_ALIAS_DIR;
/** 只为自测导出：让自测能按判据反推 runtimesIncomplete 的期望值，而不是写死。 */
export const __hasUncertainProbe = hasUncertainProbe;
export const __probeFailCount = probeFailCount;

/**
 * 型号解析的**类型收口**。
 *
 * 传进来的必须是字符串。刻意不写 `String(text)` —— 那会把「调用方传了个对象」
 * 这种**我们自己的 bug** 变成字符串 `"[object Object]"`，然后被当成一个真实
 * 型号报出去。踩过：runProbe 的返回值从 string 改成 `{output,error}` 时漏改了
 * collectGpu，Mac 上就悄悄报成 `present:false`（"确定没有 GPU"），Android 上
 * 报出型号 `[object Object]`。
 *
 * 类型不对 → 返回 null（**未知**），而不是 `{present:false}`（**确定没有**）：
 * 我们自己的错误不该伪装成对端的事实，否则 Placement 会据此把机器排除。
 */
function gpuText(text) {
  return typeof text === "string" ? text : null;
}

/**
 * 从 system_profiler 的文本里抠出显卡型号与显存（MB）。
 *
 * ⚠️ **解析不出型号 → 返回 null（未知），不返回 `{present:false}`。**
 * 为什么：`present:false` 契约上是"探过了，确实没有"，但这里"没解析出名字"的
 * 真实含义是"这次的输出里没有我们认得的字段"—— 那是**探测没给出结论**，不是
 * 对端事实。两者混淆有两个代价：
 *   ① 假阴性会被当成结论（headless Mac / VM 的 system_profiler 输出里只有
 *      Display 段、没有 Chipset Model，就会走到这条 —— 那是"没探到"，不是"没有"）；
 *   ② 就算报出去，接收侧 `sanitizeCapabilities` 也会因为 name 为空把整块 gpu
 *      折成 `null`，于是"确定没有"被**悄悄提升成"未知"**，语义在中途被改写。
 * 根上收口成 null，两个代价一起消失。见下方 collectGpu 的契约说明。
 */
export function parseMacGpu(text) {
  const s = gpuText(text);
  if (s === null) return null;
  const name = s.match(/Chipset Model:\s*(.+)/)?.[1]?.trim() ?? "";
  if (!name) return null; // 没解析出型号 = 不知道，不是"确定没有"
  const vram = s.match(/VRAM[^:]*:\s*(\d+)\s*MB/)?.[1] ?? "";
  return { present: true, name, vramMb: vram ? Number(vram) : 0 };
}

/** 从 nvidia-smi 的 CSV 行里抠出型号与显存（MB）。解析不出型号 → null，理由同上。 */
export function parseNvidiaGpu(text) {
  const s = gpuText(text);
  if (s === null) return null;
  const line = s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const parts = line.split(",").map((x) => x.trim());
  // ⚠️ 必须校验 CSV 形状，不能"首行非空就当型号"——这是"假阳性"那半边：
  // runProbe 把 stdout 与 stderr **合并**成 output，所以 nvidia-smi 把错误打到
  // stdout（或包装脚本/shim 往 stdout 吐一行提示）时，那行文字会被当成**真实
  // 型号**报给 Placement。实测（修复前）：
  //   parseNvidiaGpu("ERROR: nvidia-smi not found")
  //     -> {present:true, name:"ERROR: nvidia-smi not found", vramMb:0}
  // 而 sanitizeCapabilities 不拦它（名字非空即保留）→ 报错信息变成显卡型号。
  // 我们请求的是 --format=csv,noheader,nounits，正常输出必然是 `型号, 显存数字`。
  if (parts.length < 2) return null; // 没有逗号 = 不是我们请求的 CSV 形状
  const [name = "", vram = ""] = parts;
  if (!name) return null;
  // 显存必须真的是个数，否则这行更像提示/报错文本而不是数据行。
  if (vram === "" || !Number.isFinite(Number(vram))) return null;
  return { present: true, name, vramMb: Number(vram) || 0 };
}

/**
 * 从 powershell `Get-CimInstance Win32_VideoController` 的输出里取第一行型号。
 *
 * 注意 `Name -join "\`n"` 在多显卡时给出多行；只取第一行是有意的 ——
 * 名片只报"有没有 GPU + 主卡型号"，不报全部。
 */
export function parseWindowsGpu(text) {
  const s = gpuText(text);
  if (s === null) return null;
  const name = s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
  return name ? { present: true, name, vramMb: 0 } : null;
}

/**
 * GPU 探测：尽力而为，采不到返回 null（**不是** `{present:false}`）。
 *
 * 为什么区分：`null` = 不知道（没探），`{present:false}` = 探过了，确实没有
 * 独立显卡。Placement 面对"要求 GPU"的任务时，前者应该去问人，后者应该直接
 * 排除 —— 混淆这两者会导致"把 GPU 任务派到没 GPU 的机器上"。
 *
 * ⚠️ 每个分支都必须读 `r.output`（runProbe 返回的是 `{output,error}`）。
 * 直接把 `r` 交给解析函数就是上面说的那个 bug。
 */
/** 每个平台"怎么问 + 用哪个解析器"集中一张表：自测与生产共用同一条命令。 */
function gpuProbeSpec(p = platform()) {
  switch (p) {
    case "darwin":
      return { cmd: "system_profiler", args: ["SPDisplaysDataType"], parse: parseMacGpu };
    case "linux":
    case "android":
      return {
        cmd: "nvidia-smi",
        args: ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
        parse: parseNvidiaGpu,
      };
    case "win32":
      return {
        cmd: "powershell",
        args: ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name -join \"`n\""],
        parse: parseWindowsGpu,
      };
    default:
      return null;
  }
}

/**
 * 原始输出 + 解析结果一起返回。
 *
 * 为什么要把 output 也带出来：虚拟机/headless Mac 的 `system_profiler` 输出里
 * 只有 Display 段、没有 Chipset Model，这时解析出 null 是**正确**结果；而"输出里
 * 明明有 Chipset Model 却解析成 null"才是解析器回归。自测必须能区分这两者，
 * 否则在有显卡的机器上永远绿、在 VM 上永远红（GitHub runner 上就是这么红的）。
 */
async function probeGpu() {
  const spec = gpuProbeSpec();
  if (!spec) return { output: "", gpu: null };
  const r = await runProbe(spec.cmd, spec.args, GPU_TIMEOUT_MS);
  const output = r.output ?? "";
  if (!output) return { output: "", gpu: null };
  return { output, gpu: spec.parse(output) };
}

async function collectGpu() {
  try {
    return (await probeGpu()).gpu;
  } catch {
    /* 探测本身就不可靠，失败即"不知道" */
    return null;
  }
}

/**
 * "这台机器习惯把活放哪"。
 *
 * 两个来源：
 *   1. 调用方给的（插件的 `workspaceRoot` 配置）—— 这是**权威**答案，
 *      因为它就是这台机器实际跑活的地方。
 *   2. 常见目录名探测 —— 兜底，工作区没配时也能给出点线索。
 *
 * 只报**确实存在**的目录，且把家目录缩写成 `~` —— 不暴露用户名
 * （组播是二层广播，同网段谁都能收到）。
 */
function collectWorkspaceHints(extra = []) {
  const home = homedir();
  const out = [];
  const seen = new Set();
  const push = (abs) => {
    if (!abs || out.length >= 8) return;
    let exists = false;
    try {
      exists = existsSync(abs);
    } catch {
      /* 权限/奇怪的路径：当作不存在 */
    }
    if (!exists) return;
    const text = String(abs);
    // 家目录缩写成 `~`：组播是二层广播，同网段谁都能收到，不该带上用户名
    const shown = home && text.startsWith(home) ? `~${text.slice(home.length)}` : text;
    if (seen.has(shown)) return;
    seen.add(shown);
    out.push(shown);
  };

  // 1) 权威来源：插件配置的工作区（这台机器实际跑活的地方）
  for (const p of Array.isArray(extra) ? extra : [extra]) push(p);

  // 2) 兜底：常见目录名。工作区没配时也能给出点线索。
  for (const name of ["projects", "code", "work", "dev", "src", "workspace"]) push(join(home, name));
  push("/data");
  push("/srv");

  return out;
}

/** 当前缓存的采集结果；首轮采集完成前是 null。 */
let cache = null;
let refreshTimer = null;
let initialTimer = null;
let inflight = null;

/** 同步读取缓存结果（名片用这个 —— 名片必须是同步的）。 */
export function currentCapabilities() {
  return cache;
}

/** 直接写入缓存（自测用；正常路径由采集写入）。 */
export function setCapabilitiesForTest(value) {
  cache = value;
}

/**
 * 采集一次。并发探测所有项，返回完整能力块。
 * 这个函数**不抛**：任何单项失败都降级。
 *
 * @param options.hints 额外的"常用目录"（插件传 config.workspaceRoot）
 */
export async function collectCapabilities({ now = Date.now(), hints = [] } = {}) {
  const [rt, gpu] = await Promise.all([
    collectRuntimes().catch(() => ({ runtimes: {}, errors: { _: "collect-threw" } })),
    collectGpu().catch(() => null),
  ]);
  // 三种触发（对端 hos 逼出来的完整版）：
  //   ① 探测本身没给出结论（超时 / spawn 失败 / 抛异常）
  //   ② 一个都没探到却又存在失败项 —— "整批归零"的形状，几乎必定是 PATH 问题
  //   ③ **主 PATH 本身残缺** —— 此时"找不到"可能只是"没覆盖到"，
  //      于是所有 ENOENT 结论都不可信（含"非空但部分失败"这种通例）
  // ③ 是关键补齐：只看 ①② 会漏掉"非空 + 部分失败"，而那正是 Android 那台的样子；
  // 同时它**不会**误伤我这种"PATH 健全、rustc/adb 确实没装"的正常机器。
  const uncertain =
    hasUncertainProbe(rt.errors) || isEmptyButFailed(rt) || pathLookupUnreliable();
  return {
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpuCores: cpus()?.length ?? 0,
    memMb: Math.round(totalmem() / 1048576),
    runtimes: rt.runtimes,
    // 探测失败明细（**只在本地**用：日志 + UI 诊断，不上名片）。
    // 没有它的时候，"探测超时"和"没装"在数据上完全一样，只能靠猜 ——
    // 实测就是这样：dev 实例报"什么运行时都没有"，而真相是探测被超时杀掉。
    // ⚠️ 注意它**不上名片**（sanitize 不保留）：对端看不到失败明细，
    // 只能看下面这两个由它派生的字段。
    probeErrors: rt.errors,
    // 有"不确定"的探测项 → 这张名片**不能**用来断言"这台机器没有某运行时"。
    // 这个布尔上名片，因为 Placement 必须知道该不该信这份数据。
    runtimesIncomplete: uncertain,
    // 失败项数。**必须上名片**：让对端能自行判断这份运行时列表有多可信 ——
    // 只看 `runtimes` 的投影时，"3 项没探到"和"8 项全没探到"长得一样。
    probeFailCount: probeFailCount(rt),
    gpu,
    workspaceHints: collectWorkspaceHints(hints),
    capabilitiesAt: now,
  };
}

/**
 * 启动后台刷新：延迟一小段后采一次，之后每 refreshMs 一次。
 *
 * @param onUpdate 采集完成后回调（用来把新能力推进名片并立刻广播）
 * @param options.hints 额外的"常用目录"（插件传 config.workspaceRoot）
 * @param options.initialDelayMs 首轮延迟。**不要设成 0**：插件加载正是 DSH 启动
 *   最忙的时刻，那时 spawn 子进程最容易超时 → 采出一份"什么都没装"的假名片。
 *   延迟的代价只是名片晚几秒才有能力（期间对端看到 null = 未知，这是正确的
 *   语义，不是错误状态）。
 * @returns 停止函数
 */
export function startCapabilities(
  onUpdate,
  { refreshMs = CAPABILITY_REFRESH_MS, hints = [], initialDelayMs = 1500 } = {},
) {
  if (refreshTimer || initialTimer) return () => {};
  const run = () => {
    // 上一轮还没回来就跳过这一轮：并发采集只会浪费 CPU，不会更快
    if (inflight) return inflight;
    inflight = collectCapabilities({ hints })
      .then((caps) => {
        cache = caps;
        try {
          onUpdate?.(caps);
        } catch {
          /* 回调不该拖垮刷新循环 */
        }
        return caps;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  initialTimer = setTimeout(() => {
    initialTimer = null;
    run();
  }, Math.max(0, initialDelayMs));
  initialTimer.unref?.();
  refreshTimer = setInterval(run, refreshMs);
  refreshTimer.unref?.();
  return () => {
    if (initialTimer) clearTimeout(initialTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    initialTimer = null;
    refreshTimer = null;
  };
}

/** 距上次采集过了多久（毫秒）；没采集过返回 Infinity。 */
export function capabilityAge(caps, now = Date.now()) {
  const at = Number(caps?.capabilitiesAt);
  return Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : Number.POSITIVE_INFINITY;
}

/** 名片里的能力是否已过期（过期按"未知"处理，而不是"没有"）。 */
export function isCapabilityStale(caps, now = Date.now()) {
  if (!caps) return false; // 没报能力（老版本对端）—— 不是"过期"，是"未知"
  return capabilityAge(caps, now) > CAPABILITY_STALE_MS;
}

// ───────────────────────── 接收侧净化 ─────────────────────────

/** 字符串字段：限长、去控制字符。 */
function safeStr(v, max = 40) {
  return String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, max);
}

/** 数字字段：必须有限且非负，否则 0。 */
function safeNum(v, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
}

/**
 * 净化**对端自述**的能力块。
 *
 * 这块数据来自网络，会被存进 peer 记录并渲染到 UI —— 不能直接信。
 * 上限都取得很小：能力摘要是"够用就好"的信息，没有理由让对端塞进
 * 一万个运行时名字把 UI 和内存撑爆。
 *
 * 返回 null 表示"对端没报 / 报的东西完全不可用" → 调用方按"未知"处理。
 */
export function sanitizeCapabilities(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const runtimes = {};
  const rawRuntimes = raw.runtimes && typeof raw.runtimes === "object" && !Array.isArray(raw.runtimes) ? raw.runtimes : {};
  let count = 0;
  for (const [k, v] of Object.entries(rawRuntimes)) {
    if (count >= 24) break;
    const name = safeStr(k, 24).toLowerCase();
    // 版本号只留数字和点，避免对端塞进可执行内容
    const version = safeStr(v, 16).replace(/[^0-9.]/g, "");
    if (name && version) {
      runtimes[name] = version;
      count += 1;
    }
  }

  let gpu = null;
  if (raw.gpu && typeof raw.gpu === "object" && !Array.isArray(raw.gpu)) {
    const name = safeStr(raw.gpu.name, 60);
    if (name) gpu = { present: raw.gpu.present !== false, name, vramMb: safeNum(raw.gpu.vramMb, 1 << 20) };
  }

  const hints = Array.isArray(raw.workspaceHints)
    ? raw.workspaceHints.slice(0, 8).map((h) => safeStr(h, 40)).filter(Boolean)
    : [];

  const at = Number(raw.capabilitiesAt);
  return {
    os: safeStr(raw.os, 60),
    arch: safeStr(raw.arch, 20),
    cpuCores: safeNum(raw.cpuCores, 4096),
    memMb: safeNum(raw.memMb, 1 << 24),
    runtimes,
    // 对端自述"有探测项没探准" → 这份运行时的**缺失**不能当结论用
    runtimesIncomplete: raw.runtimesIncomplete === true,
    // 失败项数：让本端能自行判断这份运行时列表有多可信（"3 项没探到"和
    // "8 项全没探到"是两回事）。旧对端没有这个字段 → 0（当作"没失败"）。
    probeFailCount: safeNum(raw.probeFailCount, 64),
    gpu,
    workspaceHints: hints,
    // 时间戳不能用 safeNum 的"非法即 0"——0 会让 capabilityAge 变成
    // "1970 年采的"，也就是永远过期。非法就置 0 并在下面按"未知"处理。
    capabilitiesAt: Number.isFinite(at) && at > 0 ? at : 0,
  };
}

/** 供 UI/工具用的单行摘要，例如 `py3.11 · node20.19 · docker24.0`。 */
export function summarizeCapabilities(caps, { max = 6 } = {}) {
  if (!caps) return "";
  const parts = Object.entries(caps.runtimes ?? {})
    .slice(0, max)
    .map(([k, v]) => `${k}${v}`);
  if (caps.gpu?.name) parts.push(`gpu:${safeStr(caps.gpu.name, 20)}`);
  return parts.join(" · ");
}

/**
 * 把**对端**的能力渲染成几行文本（`mesh_peers` 工具、UI 提示都用它）。
 *
 * 三种状态必须明说区分，这是 Placement 的前提：
 *   · 没报   → "未知"（老版本对端 / 刚开始采集）→ 该去问人
 *   · 过期了 → 标出来但仍展示 → 仅供参考
 *   · 未探准 → 标出来（`runtimesIncomplete`）→ 不能据此断言"没有某运行时"
 * 把"未知"渲染成"什么都没装"，就会把任务派到跑不了的机器上。
 *
 * @param peer discovery 投影出来的对端记录（用 capabilitiesStale 等派生字段）
 */
export function describePeerCapabilities(peer) {
  const caps = peer?.capabilities;
  if (!caps) return "    能力：未知（对端未上报；可能是旧版本插件，或还没采集完）";

  const specs = [];
  if (caps.cpuCores) specs.push(`${caps.cpuCores} 核`);
  if (caps.memMb) specs.push(`${Math.round(caps.memMb / 1024)} GB 内存`);
  if (caps.arch) specs.push(caps.arch);

  const marks = [];
  if (peer.capabilitiesStale) marks.push("**已过期**，仅供参考");
  if (caps.runtimesIncomplete) marks.push("**有探测项没探准**，不能据此断定「没有某运行时」");

  const lines = [
    `    能力${marks.length ? `（${marks.join("；")}）` : ""}：${specs.join(" / ") || "规格未知"}`,
    `    运行时：${summarizeCapabilities(caps) || "（未探到）"}`,
  ];
  if (caps.workspaceHints?.length) lines.push(`    常用目录：${caps.workspaceHints.join("  ")}`);
  if (caps.capabilitiesAt) {
    lines.push(`    采集于 ${new Date(caps.capabilitiesAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  }
  return lines.join("\n");
}
