/**
 * 决定「这次该不该发版、发哪个版本号」，可选地把版本号写回文件。
 *
 * 为什么要有它：发版的决定权以前在人的脑子里 —— 改完代码自己想"这算 patch 还是
 * minor"，然后手改 package.json、手改 lib/index.js 的 VERSION、手打 tag、手点
 * release、手跑 `npm publish`。五个动作里漏一个就是**半态**：tag 有了包没发、包
 * 发了版本号对不上、release 资产是上一版。这个项目已经在"看着接上了其实没接"
 * 上栽过好几次，所以这里把"该发什么版本"变成一条可跑、可测、可在 CI 里复现的
 * 命令，而不是一段记忆。
 *
 * 它只做三件事，不做任何网络请求：
 *   1. 认上一版在哪（git tag `plugin-v*` + npm 上的 latest，后者由调用方传入）
 *   2. 读 `上一版..HEAD` 的提交，按 Conventional Commits 推 bump 类型
 *   3. 说清楚下一步：bump（要发新版本）/ publish-existing（版本号已经改好、只差
 *      打 tag 和发）/ skip（没有值得发的东西）
 *
 * 用法：
 *   node scripts/release-plan.mjs                       # 只看计划，不改文件
 *   node scripts/release-plan.mjs --since origin/main   # 指定比较起点
 *   node scripts/release-plan.mjs --npm-latest 0.3.33    # 告诉它 npm 上是哪一版
 *   node scripts/release-plan.mjs --apply               # 真的把版本号写进文件
 *   node scripts/release-plan.mjs --bump minor --apply   # 强行指定 bump 类型
 *   node scripts/release-plan.mjs --github-output "$GITHUB_OUTPUT"
 *
 * --github-output 会把结论写成 `key=value` 追加进该文件，供 workflow 的
 * `steps.plan.outputs.*` 读取；人看的说明走 stdout。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TAG_PREFIX = "plugin-v";

/** 0.x 阶段把 breaking 当 minor：直接跳 1.0.0 是**替用户做决定**，不该由提交信息触发。 */
export const ZERO_MAJOR_AS_MINOR = true;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 小工具 ────────────────────────────────────────────────────────────────

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** 返回 -1 / 0 / 1；任一侧解析不出来就抛 —— 版本号问题必须当场炸，不能猜。 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`版本号不可比较：${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  for (const k of ["major", "minor", "patch"]) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return 0;
}

/** 0.x 阶段把 minor 收敛成 patch（breaking 走的 major 不受影响）。 */
function zeroFeatAsPatch(base, bump) {
  if (!ZERO_FEAT_AS_PATCH || bump !== "minor") return bump;
  const v = parseSemver(base);
  return v && v.major === 0 ? "patch" : bump;
}

export function applyBump(version, bump) {
  const v = parseSemver(version);
  if (!v) throw new Error(`当前版本号不合法：${version}`);
  switch (bump) {
    case "major":
      return ZERO_MAJOR_AS_MINOR && v.major === 0
        ? `0.${v.minor + 1}.0`
        : `${v.major + 1}.0.0`;
    case "minor":
      return `${v.major}.${v.minor + 1}.0`;
    case "patch":
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    default:
      throw new Error(`未知 bump 类型：${bump}`);
  }
}

// ── 提交信息解析 ──────────────────────────────────────────────────────────

/** 一行是不是 Conventional Commit；允许前面带列表符号（合并提交的正文会长这样）。 */
const HEADER = /^\s*(?:[-*+]\s*)?(feat|fix|perf|refactor|revert|docs|chore|ci|test|style|build)(?:\([^)]*\))?(!)?\s*:\s*/;

/**
 * 0.x 阶段把 `feat` 当 patch 处理。
 *
 * semver 允许 0.x 任意变动，而"加了个功能就 0.4.0、再修一个就 0.5.0"在真实使用里
 * 涨得太快 —— 0.3.36 一天之内变成 0.5.0，维护者直接反馈"版本增长不要这么大"。
 * 所以 0.x 期间：feat / fix / perf 都只升 patch，**只有 breaking 才升 minor**
 * （见 applyBump 里的 ZERO_MAJOR_AS_MINOR）。1.0 之后恢复标准 semver。
 */
const ZERO_FEAT_AS_PATCH = true;

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };
/** 只有这三种会让人真的想装新版本；其余（docs/chore/ci/test/style/build）不触发发版。 */
const TYPE_TO_BUMP = { feat: "minor", fix: "patch", perf: "patch", refactor: "patch", revert: "patch" };

/**
 * 从一条提交里读出 bump 类型。
 *
 * 为什么要连正文一起看：GitHub 的「Merge pull request」合并提交，标题是
 * `Merge pull request #12 from a/b`（不含类型），真正的 `feat: ...` 在正文第一行。
 * 只读标题会让这种仓库**永远不发版**，而且静默 —— 最坏的一类 bug。
 */
export function bumpFromCommit({ subject = "", body = "" } = {}) {
  let bump = "none";
  const hasBreaking = /(^|\n)BREAKING[ -]CHANGE:/.test(`${subject}\n${body}`);

  const take = (line) => {
    const m = HEADER.exec(line);
    if (!m) return;
    const type = m[1];
    const bang = Boolean(m[2]);
    if (bang || hasBreaking) {
      bump = RANK[bump] >= RANK.major ? bump : "major";
      return;
    }
    const t = TYPE_TO_BUMP[type];
    if (t && RANK[t] > RANK[bump]) bump = t;
  };

  take(subject);
  for (const line of body.split("\n")) take(line);
  return bump;
}

/** 一批提交 → 总体 bump 类型 + 触发它的那几条（用于日志里解释"为什么是这个版本号"）。 */
export function analyzeCommits(commits) {
  let bump = "none";
  const hits = [];
  for (const c of commits) {
    const b = bumpFromCommit(c);
    if (b !== "none" && RANK[b] > RANK[bump]) bump = b;
    if (b !== "none") hits.push({ bump: b, subject: c.subject });
  }
  const top = hits.filter((h) => h.bump === bump);
  return { bump, hits: top };
}

// ── git ───────────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

export function lastTag() {
  // ⚠ 必须 --match：仓库里还可能有 sidecar 用的其他 tag 命名（v0.3.x 等），
  //   混进来会把"插件版本"算到别的流水线上。
  return gitOrNull(["describe", "--tags", "--abbrev=0", "--match", `${TAG_PREFIX}*`]) || "";
}

export function tagVersion(tag) {
  if (!tag || !tag.startsWith(TAG_PREFIX)) return null;
  return tag.slice(TAG_PREFIX.length);
}

/** 读一段区间的提交；%x1f 分隔字段、%x1e 分隔记录 —— 正文里换行不会破坏结构。 */
export function readCommits(range) {
  const out = gitOrNull(["log", "--format=%s%x1f%b%x1e", range]);
  if (!out) return [];
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [subject = "", body = ""] = r.split("\x1f");
      return { subject: subject.trim(), body };
    });
}

// ── 计划 ──────────────────────────────────────────────────────────────────

/**
 * 纯函数：给状态，返回计划。抽出来是为了能在 selftest 里穷举半态
 * （tag 有了包没发、包发了版本没改、只在文档上改了……），不用真去改仓库。
 */
export function planRelease({ pkgVersion, tag = "", npmLatest = "", since = "", forcedBump = "", commits = null }) {
  let base = pkgVersion;
  const tagVer = tagVersion(tag);
  const notes = [];
  const warn = [];

  if (forcedBump && !["major", "minor", "patch", "none"].includes(forcedBump)) {
    throw new Error(`--bump 只能是 major/minor/patch/none，收到 ${forcedBump}`);
  }

  // 基准 = 仓库版本与 npm latest 中**较大**的那个。
  //
  // 为什么不是"仓库版本为准"：上一次的版本号提交如果被分支保护挡住、或者有人在本机
  // 手发过一次，仓库就会永远落后 npm 一格。这时若还拿仓库版本当基准，算出来的
  // 版本号是"npm 上已经有的那个"，publish 会被拒，而下一轮又算出同一个号 —— 死锁，
  // 而且每轮都红一次。取最大值既解开死锁，也让漂移在下一次发版时自动追平。
  if (npmLatest) {
    const rel = compareSemver(npmLatest, pkgVersion);
    if (rel > 0) {
      base = npmLatest;
      warn.push(
        `仓库版本 ${pkgVersion} 落后于 npm ${npmLatest}（上次的版本号提交没推上去？）—— 以 npm 为基准，这次会顺带追平`,
      );
    } else if (rel < 0) {
      notes.push(`仓库 ${pkgVersion} 比 npm ${npmLatest} 新 → 直接发 ${pkgVersion}`);
    }
  }

  // npm 上有这一版 = 发过了。拿不到 npm（离线演练）时才退回看 tag。
  const published = npmLatest ? compareSemver(npmLatest, base) === 0 : tagVer === base;

  // base 还没进 npm → 版本号早就改好了，只差发。**这一步是失败重试的入口**：
  // 上一次 publish 挂了（可信发布没配好、网络抖动），重跑时不该再 bump 一次。
  if (!published) {
    if (npmLatest) notes.push(`npm latest=${npmLatest}，基准=${base} → 直接发 ${base}（不 bump）`);
    else notes.push(`没有 npm latest，按 tag ${tag || "(无)"} 推断 ${base} 尚未发布`);
    return {
      mode: "publish-existing",
      release: true,
      version: base,
      tag: `${TAG_PREFIX}${base}`,
      base,
      bump: "none",
      commits: commits?.length ?? 0,
      reason: `版本号 ${base} 还没发布，直接发它`,
      notes,
      warn,
      hits: [],
    };
  }

  // 已发布：看有没有值得发的新提交。
  if (forcedBump === "none") {
    return {
      mode: "skip", release: false, version: base, tag: `${TAG_PREFIX}${base}`, base,
      bump: "none", commits: commits?.length ?? 0, reason: "手动指定 none", notes, warn, hits: [],
    };
  }

  if (commits === null) {
    throw new Error("已发布状态下必须提供提交列表（commits），否则无法判断该不该发新版");
  }

  const analyzed = forcedBump
    ? { bump: forcedBump, hits: [] }
    : analyzeCommits(commits);
  // 手动 --bump 是显式意图，不收敛；只有自动分析出来的才套 0.x 规则
  const bump = forcedBump ? analyzed.bump : zeroFeatAsPatch(base, analyzed.bump);

  if (bump === "none") {
    return {
      mode: "skip",
      release: false,
      version: base,
      tag: `${TAG_PREFIX}${base}`,
      base,
      bump: "none",
      commits: commits.length,
      reason: `${commits.length} 条提交里没有 feat/fix/perf/refactor/revert —— 只有文档/杂务，不值得发版`,
      notes,
      warn,
      hits: [],
    };
  }

  const version = applyBump(base, bump);
  return {
    mode: "bump",
    release: true,
    version,
    tag: `${TAG_PREFIX}${version}`,
    base,
    bump,
    commits: commits.length,
    reason: `${bump}：${analyzed.hits.map((h) => h.subject).slice(0, 3).join(" / ") || "手动指定"}`,
    notes,
    warn,
    hits: analyzed.hits,
  };
}

// ── 写回文件 ──────────────────────────────────────────────────────────────

/** 版本号写在两个地方，必须一起改 —— 这正是 check-version.mjs 存在的理由。 */
export function writeVersion(version, root = ROOT) {
  const pkgPath = join(root, "package.json");
  const indexPath = join(root, "lib/index.js");

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const before = pkg.version;
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const src = readFileSync(indexPath, "utf8");
  const m = /^const VERSION = "[^"]+";$/m;
  if (!m.test(src)) throw new Error("lib/index.js 里找不到 `const VERSION = \"...\";` —— 不能瞎改");
  writeFileSync(indexPath, src.replace(m, `const VERSION = "${version}";`));

  const after = JSON.parse(readFileSync(pkgPath, "utf8"));
  const verify = /^const VERSION = "([^"]+)";$/m.exec(readFileSync(indexPath, "utf8"))?.[1];
  if (after.version !== version || verify !== version) {
    throw new Error(`写回后自检失败：package.json=${after.version} lib/index.js=${verify}`);
  }
  return { from: before, to: version };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { apply: false, since: "", npmLatest: "", forcedBump: "", githubOutput: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--since") out.since = argv[++i] ?? "";
    else if (a.startsWith("--since=")) out.since = a.slice(8);
    else if (a === "--npm-latest") out.npmLatest = argv[++i] ?? "";
    else if (a.startsWith("--npm-latest=")) out.npmLatest = a.slice(13);
    else if (a === "--bump") out.forcedBump = argv[++i] ?? "";
    else if (a.startsWith("--bump=")) out.forcedBump = a.slice(7);
    else if (a === "--github-output") out.githubOutput = argv[++i] ?? "";
    else if (a.startsWith("--github-output=")) out.githubOutput = a.slice(16);
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("用法: node scripts/release-plan.mjs [--since REF] [--npm-latest VER] [--bump TYPE] [--apply] [--github-output FILE]");
    return 0;
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const base = pkg.version;
  const tag = lastTag();

  // 比较起点：--since 优先；否则上一个 plugin-v tag；都没有就**不发** ——
  // 没有起点时"从第一个提交算起"会把整个历史当成新功能，静默发一个大版本。
  let since = args.since;
  if (!since) {
    if (!tag) {
      const plan = {
        mode: "skip", release: false, version: base, tag: `${TAG_PREFIX}${base}`, base, bump: "none", lastTag: "",
        commits: 0, reason: "仓库里没有 plugin-v* tag，也没有 --since，无法确定哪些提交是新的",
        notes: [], warn: ["首次发布请显式指定：--since <ref> 或 --bump <type>"], hits: [],
      };
      report(plan, args);
      return 0;
    }
    since = tag;
  }

  const commits = readCommits(`${since}..HEAD`);
  const plan = planRelease({
    pkgVersion: base,
    tag,
    npmLatest: args.npmLatest,
    since,
    forcedBump: args.forcedBump,
    commits,
  });
  plan.since = since;
  plan.lastTag = tag;
  report(plan, args);

  if (plan.release && args.apply) {
    if (plan.mode === "bump") {
      const r = writeVersion(plan.version);
      console.log(`✓ 已写回版本号：${r.from} → ${r.to}（package.json + lib/index.js）`);
    } else {
      console.log("✓ 版本号已经是目标值，无需写回");
    }
  }

  if (args.githubOutput) {
    const kv = {
      release: String(plan.release),
      mode: plan.mode,
      version: plan.version,
      tag: plan.tag,
      base: plan.base,
      bump: plan.bump,
      commits: String(plan.commits),
      since: plan.since ?? since,
    };
    appendFileSync(args.githubOutput, `${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
  }
  return 0;
}

function report(plan, args) {
  console.log(`▶ release-plan（仓库 ${plan.base}，上次 tag ${plan.lastTag || "(无)"}）`);
  if (args.since) console.log(`  比较起点：${args.since}`);
  if (args.npmLatest) console.log(`  npm latest：${args.npmLatest}`);
  console.log(`  提交数：${plan.commits}`);
  for (const n of plan.notes) console.log(`  · ${n}`);
  for (const w of plan.warn) console.log(`  ⚠ ${w}`);

  if (!plan.release) {
    console.log(`\n结论：不发版 —— ${plan.reason}`);
    return;
  }
  if (plan.mode === "publish-existing") {
    console.log(`\n结论：发布 ${plan.version}（版本号已就位，${plan.reason}）`);
    console.log(`  演示：git tag ${plan.tag} && npm publish`);
    return;
  }
  console.log(`\n结论：${plan.bump} bump → ${plan.base} → ${plan.version}（tag ${plan.tag}）`);
  console.log(`  理由：${plan.reason}`);
  if (!args.apply) console.log("  （只算不改；加 --apply 才会把版本号写进 package.json 和 lib/index.js）");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
}
