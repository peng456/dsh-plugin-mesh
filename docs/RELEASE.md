# 发版流水线

> 目标：**合并进 `main` 就是发版**，人不需要记得任何一步。
> 维护者视角的日常操作是「点 merge」，其余全部在 CI 里。

涉及三个文件：

| 文件 | 干什么 |
|---|---|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | PR 与 `main` 上的门禁：`npm test` + 发布件校验 |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | 合并后：算版本号 → 测试 → 发 npm → 打 tag → 建 Release |
| [`scripts/release-plan.mjs`](../scripts/release-plan.mjs) | **唯一的决策逻辑**：该不该发、发几号。纯函数，有它自己的 selftest |

决策逻辑被单独抽出来并且单测，是因为它真的是全仓库最危险的一段代码：一旦误判，
就会往 npm 上推一个不该存在的版本号，而 **npm 的版本号不能覆盖、只能 deprecate**。

---

## 一、一次性配置（做完就再也不用碰）

### A. npm 可信发布（推荐：仓库里没有任何长期密钥）

1. 登录 <https://www.npmjs.com>，打开 <https://www.npmjs.com/package/dsh-plugin-mesh>
2. 进 **Settings** → **Trusted Publisher** → 选 **GitHub Actions**
3. 填三格（**逐字**，错一个字就认证不上）：

   | 字段 | 值 |
   |---|---|
   | Organization or user | `peng456` |
   | Repository | `dsh-plugin-mesh` |
   | Workflow filename | `release.yml` |
   | Environment | `npm-publish` |

   > ⚠️ **Environment 必须与 `release.yml` 里 release job 的 `environment: npm-publish`
   > 逐字一致。** 两边对不上时，npm 不会说"environment 不匹配"，而是直接回
   > `ENEEDAUTH / need auth`——和"压根没配 trusted publisher"的报错一模一样。
   > 曾因此在 environment 这一格上白排查两轮 release。
   >
   > 只用默认 environment（即 job 上没有 `environment:` 这一行）时，两边的
   > Environment 都必须留空。**要么都填同一个名字，要么都留空，不能一边有一边没有。**

4. 保存。账号需要已经开启 2FA（npm 的硬要求）。

从这里开始，`release.yml` 里的 `npm publish` 不需要任何 secret：GitHub 用 OIDC
签一张短期凭证，npm 校验"这个 workflow 来自这个仓库"后放行，并在包页面上打一个
`Built and signed on GitHub Actions`（provenance）。

**为什么不在仓库里存 `NPM_TOKEN`**：token 有有效期。到期那天你不会收到任何提示，
只会某次合并后发布红掉 —— 于是又变成"需要你注意"的事，而这正是这套流水线要消灭
的东西。

### B. 备选：用 `NPM_TOKEN`（没配 A 时）

1. npm → **Access Tokens** → **Generate New Token** → *Granular Access Token*
   - Packages: 仅 `dsh-plugin-mesh`，权限 **Read and write**
   - 勾上 **Bypass two-factor authentication**（否则有 2FA 的账号 publish 会被拒）
2. 仓库 → **Settings → Secrets and variables → Actions** → 新建 `NPM_TOKEN`
3. 改 `release.yml` 的 publish 步骤，加两行：

   ```yaml
       - name: npm publish
         env:
           NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```

   并且把前面「固定 registry」那步里的 `npm config delete ...` 去掉 —— 用 token
   方式时 `.npmrc` 需要一个 `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`。
   最省事的做法是给 `setup-node` 加回 `registry-url`（两条路不要混用）。

### C. main 分支保护（可选）

**能开就开**：要求 PR + `gate` 检查通过才能合 `main`。但要知道一个副作用：

- `release.yml` 会**推一个版本号提交**回 `main`（`chore(release): vX.Y.Z [skip ci]`）。
  开了 required status checks 之后，这次推送会被拒。
- 流水线对此是**容错**的：推送失败只报警告，不阻断发布。代价是仓库里的
  `package.json` 会落后 npm 一格；`release-plan` 以 npm 为基准，下一次发版会自动
  追平，所以不会死锁。
- 想彻底干净：用 **Rulesets** 的 bypass 名单（Repository admin / 特定 App，视套餐
  而定），或者把 workflow 的 `commit_version` 输入关掉、接受"版本号以 tag 为准"。

---

## 二、日常：什么都不用做

```
你：推一个 feat: ... 的提交（或 squash merge 一个 PR）
机器：测试 → 0.3.33 → 0.4.0 → npm publish → tag plugin-v0.4.0 → GitHub Release（自动笔记 + 源码包）
```

只有文档、测试、CI 配置、格式化的提交**不会**产生新版本 —— 值得发版的是
`feat` / `fix` / `perf` / `refactor` / `revert` / 破坏性变更。

提交信息的写法见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

---

## 三、手动触发（想发就发、或演练）

**Actions → release → Run workflow**：

| 输入 | 用途 |
|---|---|
| `bump` | `auto`（按提交信息）/ `patch` / `minor` / `major` / `none`（强制不发） |
| `commit_version` | 关掉 = 不推版本号提交（用于分支保护挡路时） |
| `dry_run` | 只跑测试 + 打印计划，不发布、不打 tag |

本地预演同一套决策（不联网、不改文件）：

```bash
npm run release:plan                          # 用上一个 tag 当基准
npm run release:plan -- --since HEAD~5        # 只看最近 5 条提交
npm run release:plan -- --npm-latest 0.3.35   # 假装 npm 上已经是 0.3.35
npm run release:plan -- --bump patch --apply  # 真的写回版本号
```

`--apply` 会把 `package.json` 与 `lib/index.js` 的 `VERSION` 一起改掉，改完
`npm test` 照样会跑 `check-version` 复核。

---

## 四、状态机（重跑会长什么样）

流水线每一步都可重跑，靠的是这个判断表（`scripts/release-plan.mjs` 里的 `planRelease`）：

| 现场 | 结论 | 说明 |
|---|---|---|
| tag / npm / 仓库都是 `0.3.33`，新提交里有 `feat` | `bump` → `0.4.0` | 正常推进 |
| 同上，但只有 `docs`/`chore` | `skip` | 不值得发版 |
| 仓库 `0.3.34`，npm 还是 `0.3.33`（上次 publish 挂了） | `publish-existing` → 发 `0.3.34` | **不重复 bump**，这是重试路径 |
| tag 已推 `0.3.34`，npm 还是 `0.3.33` | `publish-existing` | tag 先到、包后到 |
| npm 是 `0.3.34`，仓库停在 `0.3.33` | 以 `0.3.34` 为基准继续 bump → `0.3.35` | 版本号提交没推上去时自动追平，**不会死锁** |
| npm 上已有目标版本 | 跳过 `publish`，继续建 release | 重跑安全 |
| 目标 tag 的 release 已存在 | 只 `upload --clobber` 换资产 | 重跑安全 |

---

## 五、发布之后，肉眼只需要看三条

机器已经替你做完了 ⑥ 之前的一切，但"发布成功"和"发布**能用**"不是一回事，所以
发布完顺手确认：

1. `https://www.npmjs.com/package/dsh-plugin-mesh/v/<版本>` 存在，且页面上有
   **Built and signed on GitHub Actions**（说明 provenance 生效了）。
2. Release 页有 `plugin-v<版本>`，且附件里有 `dsh-plugin-mesh-<版本>.tar.gz`
   （不能 `git clone` 的机器靠它）。
3. 日志里那一行 `✓ tarball 可下载：https://registry.npmjs.org/.../dsh-plugin-mesh-<版本>.tgz`
   —— 没有它就别对外宣布，见下面「staged publishing」。

---

## 六、出错怎么办

| 症状 | 原因 | 处理 |
|---|---|---|
| `ENEEDAUTH` / 401 | 可信发布没配对，或 `.npmrc` 里留了空的 authToken 占位符 | 核对 A 的三格；确认 workflow 名就是 `release.yml`；`id-token: write` 权限在 |
| `E403 ... two-factor` | 用了 token 方式但没勾 Bypass 2FA | 重新生成 B 的 token |
| `cannot publish over previously published version` | 版本号重复 | 正常不该发生（`publish` 前会查）；手动 `--bump patch` 触发一次 |
| 日志：`tarball 拿不到（25 分钟）` | npm staged publishing：元数据先出现，包体后到（0.5.1 实测慢了 12 分钟） | 等 tarball 200 后按下面「补建 Release」补齐，**不要改版本号、也不要重跑整个 job**（重跑会算成 `skip`） |
| 测试红在 `gate` | 真的坏了 | 修；`main` 上已经红的那次不会产生任何发布 |
| 测试红在 `portability / linux` | 见 `lib/_selftest-capabilities.mjs` 里的注释 | 不阻断，但连续红要当回事 |

### 补建 Release（publish 成功、但源码包/Release 没建出来）

这种半态的特征很明确：npm 上有版本、tag 也推上去了，Release 页却没有对应条目。
此时 **重跑 job 没用** —— `release-plan.mjs` 按 tag 算「上一版」，重跑时提交数为 0，
结论是 `skip`，后面所有发版步骤都会被跳过。手动补齐即可：

```bash
V=0.5.1                 # 换成实际版本
TAG=plugin-v$V
ASSET=dist/dsh-plugin-mesh-$V.tar.gz

# 1) 源码包（workflow 里也是这一步）
bash scripts/pack-release-tarball.sh dist

# 2) 建 Release（正文用 GitHub 自动生成的分组笔记）
PREV=$(git describe --tags --abbrev=0 --exclude="$TAG")   # 上一版的 tag
if [ -n "$PREV" ]; then
  gh release create "$TAG" "$ASSET" --title "dsh-plugin-mesh v$V" \
    --generate-notes --notes-start-tag "$PREV" --target "$(git rev-parse HEAD)"
else
  gh release create "$TAG" "$ASSET" --title "dsh-plugin-mesh v$V" \
    --generate-notes --target "$(git rev-parse HEAD)"
fi
```

没有 `gh`（比如这台 Mac 上被网络挡住）时用 REST API：`POST /releases` 带
`generate_release_notes: true` + `previous_tag_name`，再 `POST` 到
`https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=<文件名>`
上传 `$ASSET`。补完别忘了在 Release 正文里补一段中文的「本版主要变化」——
自动生成的笔记只按 PR 分组，直接推到 main 的提交不会出现。
| 合并了但**没发版** | 提交里只有 `docs`/`chore`/`ci`/`test` | 要发就手动 `bump=patch` |
| `gh release create` 403 | workflow 缺 `contents: write` | 别改，它在文件顶部；改了要还原 |

**撤回 / 回滚**

```bash
# 72 小时内可以直接 unpublish（超时只能 deprecate，别指望删掉）
npm unpublish dsh-plugin-mesh@0.4.0

# 更常见也更好：让旧版本自己说出来
npm deprecate dsh-plugin-mesh@0.4.0 "有严重问题，请用 0.4.1"

# 然后把有问题的提交 revert 掉，提交信息写 fix: —— 自动发一个 patch
git revert <sha> && git commit --amend -m "fix: 回滚 0.4.0 的问题"
```

---

## 七、跨网段/无外网的分发（CI 进不了你的内网）

`release.yml` 只发到互联网（npm + GitHub）。局域网镜像那一步**留在本机**，因为
GitHub 的 runner 摸不到你的内网：

```bash
# 本机（有外网）：照旧，一条命令同时发 release 与镜像
npm run release-plugin -- --publish     # 会同步到 $MESH_MIRROR_DIR 并打印对端升级命令

# 只想从 CI 发好的 release 拉一份到镜像目录（不发版）
V=0.4.0
curl -fL -o "$MESH_MIRROR_DIR/dsh-plugin-mesh-$V.tar.gz" \
  "https://ghfast.top/https://github.com/peng456/dsh-plugin-mesh/releases/download/plugin-v$V/dsh-plugin-mesh-$V.tar.gz"
```

---

## 八、几个会浪费时间的小坑

1. **不要给 `setup-node` 加 `registry-url` 再用可信发布。** 它会往 `.npmrc` 写
   `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`；OIDC 模式下没有这个变量，
   npm 会拿空 token 去请求，报 `ENEEDAUTH` —— 报错信息完全不指向真正的原因。
2. **`[skip ci]`**：版本号回写提交带它，GitHub 因此不会为这条提交再跑一遍
   workflow。只要动了提交信息的措辞，这个标记就要跟着留。
3. **`fetch-depth: 0` 不能省**：浅克隆会让 `git describe --tags` 找不到 tag，
   流水线会以为"从来没发过版"，然后做出一堆错误判断。
4. **`plugin-v` 前缀是契约**：`release-plugin.sh`、安装文档、镜像脚本都按它取资产。
   改前缀等于让所有不能 `git clone` 的机器升级失败。
5. **macOS runner 的 `rustc`/`go` 是预装的**：`_selftest-capabilities.mjs` 里有
   "找不到就是真没装"这类断言，换平台前先看那一节的注释。
