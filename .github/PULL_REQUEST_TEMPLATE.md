## 这个 PR 做了什么

<!-- 一句话说清。如果是修 bug，先说"用户看到的现象是什么"。 -->

## 影响的类型（决定自动发版的级别）

<!-- 标题请用 Conventional Commits 前缀，机器按它算版本号：
     feat: → minor ／ fix: perf: refactor: revert: → patch
     feat!: 或正文含 BREAKING CHANGE: → major（0.x 阶段落到 minor）
     docs: chore: ci: test: style: build: → 不发版
     详见 CONTRIBUTING.md 第 1 节 -->

- [ ] `feat` / `fix` / `perf` / `refactor`（会发版）
- [ ] 只有文档、测试、CI、格式（**不会**发版）

## 自查

- [ ] `npm run check` 通过
- [ ] `npm test` 通过（约 90 秒）
- [ ] 新行为带了 selftest，并且**故意弄坏过输入、确认它真的会红**
- [ ] 没有新增运行依赖（`@deepseek-ai/*` 保持 optional peerDependency）
- [ ] 探针失败没有被写成否定事实（`ENOENT` ≠ 超时）
- [ ] 文档里出现的每条命令都真的存在
- [ ] 改过 `llms.txt` 的话，跑过 `node scripts/sync-llms.mjs --write`

## 备注

<!-- 想要 reviewer 特别注意的地方、或者你不确定的设计取舍。 -->
