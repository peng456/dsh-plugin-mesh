# 参与 dsh-plugin-mesh

> **一句话**：你只需要写代码、把提交信息写对。版本号、tag、CHANGELOG、npm 发布、
> GitHub Release 全部由机器完成。
>
> 维护者视角的"我唯一要做的事"是**点 merge**。流水线本身见
> [`docs/RELEASE.md`](docs/RELEASE.md)。

---

## 0. 30 秒版

```bash
git clone https://github.com/peng456/dsh-plugin-mesh.git
cd dsh-plugin-mesh
npm run check        # 2 秒：版本号一致性、TDZ、语法、可加载性、文档同步
npm test             # ~90 秒：上面那些 + 6 套 selftest，全程不碰网络
```

然后：开分支 → 提交 → 发 PR → 等 CI 绿 → 合并。

**不要**改 `package.json` 里的 `version`，**不要**改 `lib/index.js` 里的 `VERSION` 常量，
**不要**打 tag，**不要**跑 `npm publish`。这些都交给流水线，手改反而会和它打架
（`check:version` 会在两处不一致时直接拦下来）。

---

## 1. 提交信息决定版本号（唯一需要你想一下的地方）

合并进 `main` 就会发版，而发哪个号**完全由提交信息推出来**。规则在
[`scripts/release-plan.mjs`](scripts/release-plan.mjs)，规则本身有自测
（`scripts/_selftest-release-plan.mjs`，在 `npm test` 里）。

| 提交信息 | 发行级别 | 结果 |
|---|---|---|
| `feat: 支持跨网段唤醒` | minor | `0.3.33 → 0.4.0` |
| `fix(ui): 配对码不显示` | patch | `0.3.33 → 0.3.34` |
| `perf: 少扫一遍路由表` | patch | 同上 |
| `refactor: 拆开 handleInboundTask` | patch | 同上 |
| `revert: 回滚 xx` | patch | 同上 |
| `feat!: 换掉握手协议` / 正文含 `BREAKING CHANGE:` | major | `0.x` 阶段落到 `0.4.0`，不擅自跳 `1.0.0` |
| `docs:` `chore:` `ci:` `test:` `style:` `build:` | **不发版** | 改了就跑 CI，不会产生新版本 |

两条约定：

1. **用 squash merge，PR 标题就是提交信息。** `feat: ...` 开头的 PR 标题 =
   minor 发版，`fix: ...` = patch。用别的合并方式也能跑（`Merge pull request`
   提交的正文里那行 `- feat: ...` 会被认出来），但 squash 最省事、历史最干净。
2. **一次 PR 只做一件事。** 把两件事塞进一个 PR，等于强迫机器按最重的那个类型发版。

为什么把这件事交给机器：版本号不是维护者的个人偏好，而是**对使用者的承诺** ——
`feat` 意味着"可以放心升"，`fix` 意味着"这只是修 bug"。让规则推，比让"我觉得这算
小改动"推更稳定，也不会因为维护者累了就漏一次。

---

## 2. 合并之后，机器做了什么

```
push main
   │
   ├─ ① 计划：读上一个 plugin-v* tag + npm 上的 latest + 这次的提交
   │        → bump 类型、下一版号（没有值得发的东西就在这里停）
   ├─ ② 全量测试：npm test（check + 6 套 selftest）
   ├─ ③ 发布件门禁：npm pack → 解开 → 校验真正要发出去的 tar
   ├─ ④ 版本号写回：package.json 与 lib/index.js 一起改，提交回 main
   │        （提交信息带 [skip ci]，不会自己触发自己）
   ├─ ⑤ npm publish --provenance（可信发布，用 OIDC，仓库里没有任何长期密钥）
   ├─ ⑥ 等 tarball 真的能下（npm 的元数据会先出现，别急着对外说"发好了"）
   └─ ⑦ 打 tag plugin-v<版本> + GitHub Release（自动生成分类笔记）+ 插件源码包
```

任何一步红了，后面的都不会执行；已经做过的那部分**可以重跑** —— 重跑时状态机
会认出"版本号都改好了、只是没发出去"，直接发，不会叠两层版本号。

PR 上跑的是同一套门禁（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)）：

| 任务 | 平台 | 阻断合并？ |
|---|---|---|
| `gate / node 20`、`gate / node 24` | macOS（与发布任务同款） | 是 |
| `portability / linux` | Ubuntu | 否（信号，不是门禁） |

Linux 那个之所以不阻断：`lib/_selftest-capabilities.mjs` 里有一批断言是按"开发机是
Mac"写的（文件里已注明）。它天天红说明真的坏了，但"红在 Linux"不该挡住 macOS 上的
发布 —— 两边都是真实信息，只是权重不同。

---

## 3. 提交前请自己先跑

```bash
npm run check   # 快，总是先跑这个
npm test        # 全量，~90 秒
```

### 门禁要有牙 —— 这个仓库的硬规矩

仓库里已经出现过好几次"看着接上了、其实没接"（一个只写在注释里的校验、
`install.sh` 漏拷 `scripts/`、一个占位符掩盖了缺失的文件）。所以：

- **新增行为要带 selftest**，放在 `lib/_selftest-*.mjs` 或 `scripts/_selftest-*.mjs`，
  并接进 `npm test`。
- **改了门禁要证明它会失败**：把输入弄坏，看它是不是真的红。绿得不明不白的门禁，
  比没有门禁更危险。
- **文档里出现的每条命令都得真存在**。README 会原样出现在 npm 页面上，插件目录
  也会拿描述去和代码核对 —— 一个编出来的 flag 会被抓出来。

---

## 4. 会被 review 挡下的写法

完整的硬约束在 [`AGENTS.md`](AGENTS.md)，最常踩的几条：

1. **探针失败 ≠ 否定事实。** `ENOENT` 是"没装"，超时是"没问到"。两者必须可区分、
   必须可见（`probeErrors` / `runtimesIncomplete` / `routeDecision` / `dispatchError`）。
   把它们揉成一个"没有"，曾经让一台很忙的 Mac 报出"什么都没装"。
2. **零运行依赖。** `@deepseek-ai/*` 全部是 optional peerDependency（宿主提供）。
   往 `dependencies` 里加东西等于给每个用户装上第二个 Node 生态。
3. **改 schema 的 `.default()` 通常不够。** `cordis.patch.yml` 里钉着值，用户的
   profile 里也钉着一份。三处都要看。
4. **`config:` 在 patch 里是整体替换，不是合并。** 加一个键而不重述其他键 = 把其他
   键静默重置成默认值。
5. **`node --check` 抓不到 TDZ**，所以有 `scripts/check-tdz.mjs`，别把它从
   `npm run check` 里摘掉。
6. **`client/client.js` 是手写 bundle**：必须 `__ModuleLoader__.load({ id: "<包名>" })`，
   `id` 要与包名逐字相同；只能 `require("react")` 和 `require("react/jsx-runtime")`。
7. **`llms.txt` 与 `docs/llms.txt` 必须逐字节相同**（`npm run check` 会验；
   改完跑 `node scripts/sync-llms.mjs --write`）。

---

## 5. 网络不通也能贡献

这个项目就是在一台 `git` 到 github.com 会被 reset 的机器上写出来的，所以"网络"
不应该是能不能贡献的门槛：

| 你的处境 | 可以这么做 |
|---|---|
| `git clone` / `git push` 被 reset | 用 GitHub 网页直接改文件、发 PR |
| 连不了 GitHub | 把 `git format-patch` 的补丁发到 issue 或邮箱 `geekstartup@163.com` |
| 只是要装/升级 | 用 GitHub Release 里的源码包（国内镜像 `https://ghfast.top/<release 资产 URL>`） |
| 同网段有别的机器 | 用本插件的 `mesh_run` 把任务派过去跑 |
| 要在受限机器上推代码 | `scripts/push-via-api.py`（走 REST API 精确复刻提交，SHA 与本地一致） |

---

## 6. 合并节奏与权限

- 目前是单人维护，**48 小时内**会看 PR。纯文档/拼写/测试补充会直接合。
- 连续几个高质量 PR 的贡献者会被加成 collaborator —— 那时候你可以直接推 `main`，
  流水线会把关（测试不过就不发版），所以不需要逐个人工 review 每一行。
- **不需要签 CLA 或 DCO**。仓库是 MIT，提 PR 即表示同意以 MIT 分发你的改动。
- 有安全相关的问题不要开公开 issue，见 [`SECURITY.md`](SECURITY.md)。

---

## 7. 出问题了找谁

- 一般问题：<https://github.com/peng456/dsh-plugin-mesh/issues>
- 邮箱：`geekstartup@163.com`
- 发版流水线本身的问题：先看 [`docs/RELEASE.md`](docs/RELEASE.md) 里的状态机与恢复表
