#!/usr/bin/env python3
"""_selftest-tsnet-merge.py —— 验证 mesh-tsnet-merge.py 真的「只改该改的键」。

核心用例是复现对端 文超-win 的那份 cordis.patch.yml：`- id: mesh` 里已经有
22 个键（含 permissionPreset: danger-full-access）、中文注释、以及一个**已经
存在的** tsnetDownloadSources（带列表子行）。合格的合并必须做到：
  · permissionPreset 等兄弟键一个不丢
  · tsnetDownloadSources 被整体替换，且不留孤儿 `- 'url'` 子行
  · 幂等（跑两次结果一致）
  · 注释、行尾、BOM 原样
"""
import os
import re
import sys
import tempfile

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import importlib.util

_spec = importlib.util.spec_from_file_location(
    "mtm", os.path.join(os.path.dirname(os.path.abspath(__file__)), "mesh-tsnet-merge.py")
)
mtm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mtm)

FAILS = []
PASSES = []


def check(name, cond, detail=""):
    if cond:
        PASSES.append(name)
    else:
        FAILS.append("%s  %s" % (name, detail))


# 复现对端状态：22 个 config 键 + 注释 + 已存在的 tsnetDownloadSources
FIXTURE_A = """\
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries.

# 2026-09-17 mesh 加固。历史故障记录：permissionPreset 回落 workspace-write 后
# Windows ACL 沙箱 fail-closed，入站任务全挂，所以这里必须钉死 danger-full-access。
- id: mesh
  config:
    enabled: true
    machineName: ''
    port: 45917
    useMulticast: true
    scanOnStart: true
    scanIntervalMs: 60000
    scanRanges: []
    scanPorts: []
    scanConcurrency: 64
    scanTimeoutMs: 800
    pingIntervalMs: 10000
    announceIntervalMs: 5000
    peerTtlMs: 20000
    requirePairing: false
    agentPreset: standard
    # 这条是保命设置，不能被 tsnet 的合并冲掉
    permissionPreset: danger-full-access
    workspaceRoot: 'C:\\Users\\86189'
    maxWakesPerThread: 30
    threadWindowMs: 3600000
    threadCooldownMs: 20000
    minTaskChars: 24
    tsnetDownloadSources:
      - 'http://old.example/'
- id: server-deck
  disabled: true
"""

NON_TSNET_KEYS = [
    "enabled", "machineName", "port", "useMulticast", "scanOnStart", "scanIntervalMs",
    "scanRanges", "scanPorts", "scanConcurrency", "scanTimeoutMs", "pingIntervalMs",
    "announceIntervalMs", "peerTtlMs", "requirePairing", "agentPreset",
    "permissionPreset", "workspaceRoot", "maxWakesPerThread", "threadWindowMs",
    "threadCooldownMs", "minTaskChars",
]

# ── 用例 1：对端的真实场景 ──
new_text, notes = mtm.merge(FIXTURE_A, {
    "tsnetEnabled": True,
    "tsnetDownloadSources": ["http://192.168.1.6:8791/"],
})
doc = yaml.safe_load(new_text)
mesh = doc[0]["config"]

check("1.1 根节点仍是数组且只有 mesh/server-deck 两条", isinstance(doc, list) and len(doc) == 2, repr(doc)[:120])
check("1.2 `- id: mesh` 仍只有 1 处", len(re.findall(r"^\s*-\s*id:\s*mesh\s*$", new_text, re.M)) == 1)
check("1.3 保命键 permissionPreset 存活", mesh.get("permissionPreset") == "danger-full-access", repr(mesh.get("permissionPreset")))
for k in NON_TSNET_KEYS:
    check("1.4 兄弟键保留: %s" % k, k in mesh, "丢失")
check("1.5 workspaceRoot 原样（Windows 路径没被转义搞坏）", mesh.get("workspaceRoot") == "C:\\Users\\86189", repr(mesh.get("workspaceRoot")))
check("1.6 port 保持 45917", mesh.get("port") == 45917)
check("1.7 tsnetEnabled=true", mesh.get("tsnetEnabled") is True)
check("1.8 tsnetDownloadSources 换成新源", mesh.get("tsnetDownloadSources") == ["http://192.168.1.6:8791/"], repr(mesh.get("tsnetDownloadSources")))
check("1.9 旧源没有残留", "old.example" not in new_text)
check("1.10 没有孤儿列表行（每个 `- ` 都在列表键之下）", len(re.findall(r"^\s+- ", new_text, re.M)) == len(re.findall(r"^\s+- ", new_text, re.M)))
check("1.11 注释保留（含中文）", "保命设置" in new_text and "历史故障记录" in new_text)
check("1.12 另一个条目未被动过", doc[1] == {"id": "server-deck", "disabled": True})
check("1.13 tsnetEnabled 只出现一次", len(re.findall(r"^\s*tsnetEnabled:", new_text, re.M)) == 1)
check("1.14 tsnetDownloadSources 只出现一次", len(re.findall(r"^\s*tsnetDownloadSources:", new_text, re.M)) == 1)

# ── 用例 2：幂等 ──
again, _ = mtm.merge(new_text, {
    "tsnetEnabled": True,
    "tsnetDownloadSources": ["http://192.168.1.6:8791/"],
})
check("2.1 跑两次结果逐字节一致（幂等）", again == new_text)
yaml.safe_load(again)
check("2.2 二次合并后 permissionPreset 仍在", yaml.safe_load(again)[0]["config"].get("permissionPreset") == "danger-full-access")

# ── 用例 3：完全没有 mesh 条目 ──
fresh = "# 新 profile\n- id: server-deck\n  disabled: true\n"
t3, n3 = mtm.merge(fresh, {"tsnetDownloadSources": ["http://192.168.1.6:8791/"]})
d3 = yaml.safe_load(t3)
check("3.1 无 mesh 条目时新建", len(d3) == 2 and d3[1]["id"] == "mesh", repr(d3))
check("3.2 新条目 config 正确", d3[1]["config"]["tsnetDownloadSources"] == ["http://192.168.1.6:8791/"])

# ── 用例 4：CRLF + BOM 原样保留 ──
crlf = ("\ufeff# 头\n- id: mesh\n  config:\n    enabled: true\n    permissionPreset: danger-full-access\n").replace("\n", "\r\n")
t4, _ = mtm.merge(crlf, {"tsnetEnabled": True})
check("4.1 BOM 保留", t4.startswith("\ufeff"))
check("4.2 CRLF 保留且未混入裸 LF", t4.count("\r\n") == t4.count("\n") and t4.count("\r\n") > 0, "crlf=%d lf=%d" % (t4.count("\r\n"), t4.count("\n")))
check("4.3 CRLF 下结构正确", yaml.safe_load(t4)[0]["config"]["permissionPreset"] == "danger-full-access")

# ── 用例 5：重复 mesh 条目要拒写，而不是猜 ──
dup = "- id: mesh\n  config:\n    enabled: true\n- id: mesh\n  config:\n    enabled: false\n"
try:
    mtm.merge(dup, {"tsnetEnabled": True})
    check("5.1 重复条目应报错", False, "居然没报错")
except mtm.MergeError as e:
    check("5.1 重复条目拒写并说明原因", "重复" in str(e) or "2 个" in str(e), str(e))

# ── 用例 6：条目存在但没有 config ──
noconf = "- id: mesh\n  name: mesh\n- id: server-deck\n  disabled: true\n"
t6, _ = mtm.merge(noconf, {"tsnetEnabled": True})
check("6.1 无 config 时补上", yaml.safe_load(t6)[0]["config"]["tsnetEnabled"] is True)

# ── 用例 7：真写盘 + 备份 + --check ──
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "cordis.patch.yml")
    with open(p, "wb") as fh:
        fh.write(FIXTURE_A.encode("utf-8"))
    before = open(p, "rb").read()
    sys.argv = ["x", "--file", p, "--download-source", "http://192.168.1.6:8791/", "--enabled", "--apply"]
    mtm.main()
    after = open(p, "rb").read()
    baks = [f for f in os.listdir(td) if f.startswith("cordis.patch.yml.bak-merge-")]
    check("7.1 写盘后文件真的变了", after != before)
    check("7.2 留下了备份", len(baks) == 1, repr(os.listdir(td)))
    check("7.3 备份内容 == 改动前", open(os.path.join(td, baks[0]), "rb").read() == before)
    check("7.4 写盘结果结构正确", yaml.safe_load(after.decode("utf-8"))[0]["config"]["permissionPreset"] == "danger-full-access")
    check("7.5 写盘后仍是 LF、无 BOM", after.count(b"\r\n") == 0 and not after.startswith(b"\xef\xbb\xbf"))

print("=" * 60)
for p_ in PASSES:
    print("  PASS  %s" % p_)
for f_ in FAILS:
    print("  FAIL  %s" % f_)
print("=" * 60)
print("通过 %d / 失败 %d" % (len(PASSES), len(FAILS)))
sys.exit(1 if FAILS else 0)
