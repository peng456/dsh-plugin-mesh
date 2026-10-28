# 给一台机器开 tailnet（tsnet）组网 —— 安全步骤

> 这份文档解决一个已经真实坑过人的问题：**`cordis.patch.yml` 的 patch 是
> 「整体替换 config」，不是按 key 合并。**

## 一句话规则

目标机器上**已经有** `- id: mesh` 时，**永远不要整块替换 config**，
只把要改的键合并进去。

## 为什么

`@deepseek-ai/cordis-plugin-include` 应用非 insert patch 时是浅赋值：

```js
for (const [key, value] of Object.entries(overrides)) target[key] = value
// src/index.ts L121-124
```

`config` 只是**一个** key。所以下面这种「只写几行」的片段

```yaml
- id: mesh
  config:
    tsnetEnabled: true
    tsnetAuthKey: '...'
```

**不是**「只改这两个键」，而是把整个 config 换掉。原本写在这一块里的
`permissionPreset` / `workspaceRoot` / `port` / 限速参数等全部消失，
回落 schema 默认值。

最致命的一条：`permissionPreset` 默认 `workspace-write`（`lib/index.js` L139）、
`workspaceRoot` 默认 `''` → 主目录（L141）。在 Windows 上这会让 ACL 沙箱
fail-closed：

```
Windows ACL temp root must be outside the workspace
```

**该机所有入站 mesh 任务的命令执行全部失败** —— 包括刚从 tailnet 进来的，
因为 tsnet 读的是同一个值（`tsnetPermissionPreset || permissionPreset`，L692/L714）。
也就是说：整块替换会让「组网刚开」反而「入站全挂」，正好废掉这次变更的目的。

## 推荐做法

### 第 1 步：开关和授权码 —— 不用碰文件

`tsnetEnabled` / `tsnetAuthKey` / `tsnetControlUrl` / `tsnetHostname` 都有
`state.json` 兜底（`effectiveTsnetConfig`，L328-339）：

- 在 **Mesh 页面**上填一次即可，存 `state.json`（0600），重启不用再填；
- 或者 POST 本机接口（无需重启，即时生效）：

  ```
  POST /mesh/api/tsnet/config   {"enabled":true,"authKey":"tskey-auth-...","hostname":"..."}
  POST /mesh/api/tsnet/start    {}
  ```

这一步**完全不碰 `cordis.patch.yml`**，自然不会踩「整体替换」。

### 第 2 步：只有需要局域网镜子时，才合并一个键

`tsnetDownloadSources` 是**唯一没有 state 兜底**的键（`manager.js` 只读
`this.#config`），所以它必须进 config。用工具做键级合并：

```bash
# 预览（默认不写盘）
python3 mesh-tsnet-merge.py --file <cordis.patch.yml> \
    --download-source http://192.168.1.6:8791/

# 落地（自动在同目录留 .bak-merge-<时间戳>）
python3 mesh-tsnet-merge.py --file <cordis.patch.yml> \
    --download-source http://192.168.1.6:8791/ --apply

# 只看当前结构统计
python3 mesh-tsnet-merge.py --file <cordis.patch.yml> --check
```

工具保证：只增删指定的 tsnet 键，其他键 / 注释 / 缩进 / 行尾（LF/CRLF）/ BOM
原样保留；幂等（跑两次结果逐字节一致）；发现重复的 `- id: mesh` 会**拒写**而不是猜。

本机无法跑 Python 时，手工等价操作只有一条：**只**在 `config:` 下方插入
`tsnetDownloadSources:` 及其列表项，其余一个字都不要动。

### 第 3 步：校验（别靠目测）

- `- id: mesh` 出现次数 == 1
- `permissionPreset` 仍是你原来的值（Windows 上通常是 `danger-full-access`）
- `tsnetDownloadSources` 只有 1 处，值是镜子的前缀
- 文件仍是 UTF-8 无 BOM、行尾风格未变
- 用真 YAML 解析器实跑一遍，根节点是 array

## 别做的事

- ❌ 把「只含几个 tsnet 键」的片段当整体贴进已有的 `- id: mesh`
- ❌ 用 `Get-Content` / `Set-Content` 读写（会把 LF 变 CRLF，`-Raw` 也可能吃掉缩进）
- ❌ 改完不重启就断言失败 —— 配置要重启才生效，重启由机器主人执行
