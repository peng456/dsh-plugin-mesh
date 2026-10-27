# Mesh 协议兼容矩阵

> 适用：dsh-plugin-mesh 0.5.x（`PROTOCOL_VERSION = 2`）
> 目标：说清“老对端、新对端、部分升级”三种情况各能用到什么，以及哪些字段是纯增量。

## 版本与字段

| 字段 | v1 | v2 | 说明 |
|---|---|---|---|
| `id` / `machine` / `host` / `port` | ✅ | ✅ | 基础名片，v1 起就有 |
| `os` / `user` / `version` / `mac` | ✅ | ✅ | 展示与人工识别 |
| `fingerprint` | ✗ | ✅ | 只用于认领；缺失时退化为 UUID |
| `tailnetIp` | ✗ | ✅ | 单 tailnet 地址；缺失时该通道不可用 |
| `tailnetIps` | ✗ | ✅（增量） | 多 tailnet；老对端忽略，新对端回退到 `tailnetIp` |
| `capabilities` | ✗ | ✅ | 运行时/GPU/规格；缺失时 UI 显示“未知”，不显示“没有” |
| `osInfo` / `systems` | ✗ | ✅（增量） | 系统身份、WSL 等；缺失时退回 `os` 字符串 |
| `avatar` | ✗ | ✅（增量） | 本机头像 data URL；缺失/非法时回退首字母，不影响发现 |
| `profile` | ✗ | ✅（增量） | 同机多 profile 区分 |

> `endpoints[]` 是**本地收到名片后的数据结构**，不在网线上传输；不要把它当成协议字段。

## 兼容策略

1. **不做版本闸门**：`v` 只用于识别和诊断，不因为版本不同拒绝通信。
2. **未知字段忽略**：老对端收到新字段不会崩；新对端读不到新字段时逐项降级。
3. **缺失 ≠ 否定**：`capabilities` 缺失时 UI 显示“未知”，不能显示成“没装运行时”。
4. **协议内新增保持纯增量**：`tailnetIps` 保留 `tailnetIp` 作为第一项，老对端可继续用。
5. **HTTP API 路径不变**：`/mesh/v1/task`、`/mesh/v1/health`、`/mesh/v1/peers` 等老路径继续存在；新能力走新路径。

## 混合版本场景

| A | B | 结果 |
|---|---|---|
| v2 新 | v2 新 | 全功能：多通道、能力名片、WSL、远程面板/SSH（若分支启用） |
| v2 新 | v1 老 | 基础发现/派发/回执可用；指纹认领、tailnet 多地址、能力名片缺失 |
| v1 老 | v2 新 | 同上，老端不认识的字段被忽略 |
| v2 新 | 第三方假服务 | `looksLikeDshPeer` 准入拒收；不进入设备列表 |

## 回归覆盖

| 套件 | 覆盖 |
|---|---|
| `npm run selftest` | 发现、端点、多通道、会话键 |
| `npm run selftest:caps` | 能力净化、旧名片兼容、认领边界 |
| `npm run selftest:persist` | 历史快照恢复、旧快照字段缺失 |
| `npm run selftest:reply` / `resume` | 回信路由与会话恢复 |

## 不做

- 不做跨大版本的字段重命名兼容层；需要时通过新增字段完成。
- 不把 `originSession` 当跨机会话键；它只是回信地址。
- 不要求两端 session 相同；跨机只共享 thread/conversation，session 各自本地。
