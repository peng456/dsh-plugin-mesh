/**
 * release-plan 的自测。
 *
 * 为什么这段逻辑值得单独测：它现在**真的会替人做发版决定** —— 一次误判就是往
 * npm 上推一个错误版本号，而 npm 的版本号不能覆盖、只能 deprecate。所以这里把
 * 那些真实发生过的半态穷举一遍（tag 有了包没发、包发了版本没改、只改了文档、
 * squash 与 merge commit 两种历史形状），而不是等它在 CI 里第一次运行时才发现。
 *
 * 跑法：node scripts/_selftest-release-plan.mjs   （已挂在 npm test 里）
 */
import assert from "node:assert/strict";
import {
  TAG_PREFIX,
  analyzeCommits,
  applyBump,
  bumpFromCommit,
  compareSemver,
  parseSemver,
  planRelease,
  tagVersion,
} from "./release-plan.mjs";

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message.split("\n")[0]}`);
  }
}

console.log("\n── semver ──");

test("解析与比较", () => {
  assert.deepEqual(parseSemver("0.3.33"), { major: 0, minor: 3, patch: 33 });
  assert.equal(compareSemver("0.3.33", "0.3.34"), -1);
  assert.equal(compareSemver("0.4.0", "0.3.99"), 1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(parseSemver("0.3"), null, "两段的「版本号」不是 semver，必须拒绝而不是猜");
  assert.throws(() => compareSemver("abc", "1.0.0"), /不可比较/);
});

test("bump：0.x 阶段 breaking 只能升到 0.(y+1).0，不能替用户跳到 1.0.0", () => {
  assert.equal(applyBump("0.3.33", "patch"), "0.3.34");
  assert.equal(applyBump("0.3.33", "minor"), "0.4.0");
  assert.equal(applyBump("0.3.33", "major"), "0.4.0", "0.x 的 major 必须降级成 minor");
  assert.equal(applyBump("1.2.3", "major"), "2.0.0", "到了 1.x 之后 major 才是 major");
  assert.throws(() => applyBump("1.0.0", "none"), /未知 bump/);
});

console.log("\n── 提交信息 → bump 类型 ──");

test("常规类型", () => {
  assert.equal(bumpFromCommit({ subject: "feat: 加个按钮" }), "minor");
  assert.equal(bumpFromCommit({ subject: "fix(ui): 配对码没显示" }), "patch");
  assert.equal(bumpFromCommit({ subject: "perf: 少扫一遍" }), "patch");
  assert.equal(bumpFromCommit({ subject: "refactor: 拆函数" }), "patch");
  assert.equal(bumpFromCommit({ subject: "revert: 回滚 xx" }), "patch");
});

test("不该发版的类型（改文档不等于用户要装新版）", () => {
  for (const s of ["docs: 补说明", "chore: 收拾", "ci: 加个 action", "test: 补用例", "style: 空格", "build: 版本"]) {
    assert.equal(bumpFromCommit({ subject: s }), "none", s);
  }
  assert.equal(bumpFromCommit({ subject: "随手改了点什么" }), "none");
});

test("breaking：`!` 与正文里的 BREAKING CHANGE 都算", () => {
  assert.equal(bumpFromCommit({ subject: "feat!: 换协议" }), "major");
  assert.equal(bumpFromCommit({ subject: "feat(cli)!: 换参数" }), "major");
  assert.equal(
    bumpFromCommit({ subject: "feat: 换协议", body: "说明\n\nBREAKING CHANGE: 旧客户端连不上" }),
    "major",
  );
  assert.equal(
    bumpFromCommit({ subject: "feat: 换协议", body: "BREAKING-CHANGE: 连字符写法" }),
    "major",
    "连字符写法也是规范的一部分",
  );
});

test("GitHub「Merge pull request」提交：类型藏在正文里，不能因此静默不发版", () => {
  const merge = {
    subject: "Merge pull request #12 from someone/feat-x",
    body: "feat: 支持跨网段派单\n\n细节说明",
  };
  assert.equal(bumpFromCommit(merge), "minor");
});

test("正文里的列表式提交行也认（- feat: xxx）", () => {
  assert.equal(bumpFromCommit({ subject: "Merge pull request #3", body: "- fix: 修个 null" }), "patch");
});

test("一批提交取最高级别，并给出理由", () => {
  const r = analyzeCommits([
    { subject: "docs: a" },
    { subject: "fix: b" },
    { subject: "feat: c" },
    { subject: "chore: d" },
  ]);
  assert.equal(r.bump, "minor");
  assert.deepEqual(r.hits.map((h) => h.subject), ["feat: c"]);

  const major = analyzeCommits([{ subject: "fix: a" }, { subject: "feat!: b" }]);
  assert.equal(major.bump, "major");
  assert.equal(major.hits.length, 1);
});

console.log("\n── tag 解析 ──");

test("只认 plugin-v 前缀，别把 sidecar 的 tag 当插件版本", () => {
  assert.equal(tagVersion(`${TAG_PREFIX}0.3.33`), "0.3.33");
  assert.equal(tagVersion("v0.3.33"), null);
  assert.equal(tagVersion(""), null);
});

console.log("\n── 状态机：真实半态 ──");

test("正常推进：tag=npm=仓库=0.3.33，有 feat → 0.4.0", () => {
  const p = planRelease({
    pkgVersion: "0.3.33",
    tag: "plugin-v0.3.33",
    npmLatest: "0.3.33",
    commits: [{ subject: "feat: 新面板" }],
  });
  assert.equal(p.mode, "bump");
  assert.equal(p.version, "0.4.0");
  assert.equal(p.tag, "plugin-v0.4.0");
});

test("只有文档改动 → 不发版（每改一句话就发一版是最贵的注意力税）", () => {
  const p = planRelease({
    pkgVersion: "0.3.33",
    tag: "plugin-v0.3.33",
    npmLatest: "0.3.33",
    commits: [{ subject: "docs: 补一段" }, { subject: "chore: 格式化" }],
  });
  assert.equal(p.mode, "skip");
  assert.equal(p.release, false);
});

test("重试路径：版本号已改（0.3.34）、tag 还停在 0.3.33、npm 也停在 0.3.33 → 直接发 0.3.34", () => {
  const p = planRelease({
    pkgVersion: "0.3.34",
    tag: "plugin-v0.3.33",
    npmLatest: "0.3.33",
    commits: [{ subject: "fix: 上次发版挂了" }],
  });
  assert.equal(p.mode, "publish-existing");
  assert.equal(p.version, "0.3.34");
});

test("重试路径（tag 已推、包没发）：tag=仓库=0.3.34、npm=0.3.33 → 发 0.3.34，不再 bump", () => {
  const p = planRelease({
    pkgVersion: "0.3.34",
    tag: "plugin-v0.3.34",
    npmLatest: "0.3.33",
    commits: [{ subject: "fix: x" }],
  });
  assert.equal(p.mode, "publish-existing");
  assert.equal(p.version, "0.3.34");
});

test("npm 比仓库新 → 以 npm 为基准继续 bump，而不是停手（否则会死锁）", () => {
  // 现实来源：上次的版本号提交被分支保护挡住、或者有人在别的机器上手发过一次。
  // 若按"仓库版本"算，算出来的号 npm 上已经有了 → publish 被拒 → 下一轮又算同一个号。
  const bumped = planRelease({
    pkgVersion: "0.3.33",
    tag: "plugin-v0.3.33",
    npmLatest: "0.3.34",
    commits: [{ subject: "fix: x" }],
  });
  assert.equal(bumped.base, "0.3.34", "基准必须取 npm 上的版本");
  assert.equal(bumped.mode, "bump");
  assert.equal(bumped.version, "0.3.35", "不能算出一个已经存在的版本号");
  assert.match(bumped.warn.join(" "), /落后/);

  // 但"没有值得发的东西"时仍然不发 —— 漂移不该成为发空版的理由。
  const idle = planRelease({
    pkgVersion: "0.3.33",
    tag: "plugin-v0.3.33",
    npmLatest: "0.3.34",
    commits: [{ subject: "docs: 只改了说明" }],
  });
  assert.equal(idle.mode, "skip");
  assert.match(idle.warn.join(" "), /落后/);
});

test("没有 npm latest 时按 tag 推断（本地演练常见）", () => {
  // tag 是"这一版真的发过"的证据：tag 与仓库同版本 → 当成已发布，正常往上 bump。
  const published = planRelease({
    pkgVersion: "0.3.33",
    tag: "plugin-v0.3.33",
    npmLatest: "",
    commits: [{ subject: "fix: x" }],
  });
  assert.equal(published.mode, "bump");
  assert.equal(published.version, "0.3.34");

  // tag 落后于仓库 → 版本号改过了但没发，直接发，不再叠一层。
  const pending = planRelease({
    pkgVersion: "0.3.34",
    tag: "plugin-v0.3.33",
    npmLatest: "",
    commits: [{ subject: "fix: x" }],
  });
  assert.equal(pending.mode, "publish-existing");
  assert.equal(pending.version, "0.3.34");
});

test("手动指定 --bump：跳过提交分析也要真的往上升", () => {
  const p = planRelease({
    pkgVersion: "0.3.33",
    tag: "plugin-v0.3.33",
    npmLatest: "0.3.33",
    forcedBump: "patch",
    commits: [],
  });
  assert.equal(p.mode, "bump");
  assert.equal(p.version, "0.3.34");

  const none = planRelease({
    pkgVersion: "0.3.33",
    tag: "plugin-v0.3.33",
    npmLatest: "0.3.33",
    forcedBump: "none",
    commits: [{ subject: "feat: x" }],
  });
  assert.equal(none.mode, "skip");
});

test("已发布却没给提交列表 → 直接报错，不猜", () => {
  assert.throws(
    () => planRelease({ pkgVersion: "0.3.33", tag: "plugin-v0.3.33", npmLatest: "0.3.33", commits: null }),
    /必须提供提交列表/,
  );
});

test("非法 bump 类型立刻炸", () => {
  assert.throws(
    () => planRelease({ pkgVersion: "0.3.33", tag: "", npmLatest: "", forcedBump: "huge", commits: [] }),
    /--bump/,
  );
});

console.log(`\n全部${fail === 0 ? "通过" : "结束"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
