#!/usr/bin/env python3
"""把 dsh-plugin-mesh 提交到 awesome-dsh-plugin（DSH 插件目录）。

为什么走 REST API 而不是 git：这台机器上 git-over-https 到 github.com 会被
Connection reset（实测），但 api.github.com 通。上架这条路只有一条：往
`awesome-dsh-plugin/awesome-dsh-plugin` 提一个 PR，加**一个** YAML 文件
（`data/plugins/<owner>__<repo>.yml`）—— 两个 README 是生成物，不能手改。

流程：fork → 开分支 → 用 Contents API 提交那一个文件 → 开 PR。
每一步都断言，失败即停，绝不盲重试。

用法：
    scripts/submit-to-awesome.py --dry-run     # 只打印将要提交的内容
    scripts/submit-to-awesome.py               # 真的提交
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"
UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin"
FORK_OWNER = "peng456"
FORK = f"{FORK_OWNER}/awesome-dsh-plugin"
BRANCH = "add-dsh-plugin-mesh"
ENTRY_PATH = "data/plugins/peng456__dsh-plugin-mesh.yml"

# 描述**必须属实**：目录指南明确说它会被当作对插件的声明并与代码核对，夸大是
# 被打回的首要原因。所以下面每一句都能在仓库里指出来：
#   · UDP 组播发现        → lib/discovery.js（MESH_GROUP / MESH_PORT）
#   · 端口扫描            → lib/scan.js
#   · 侧栏面板列出对端能力 → client/client.js 的 CapabilityLine + sidebar.panellist
#   · 双向派发任务        → mesh_run / mesh_peers / mesh_tasks + 入站唤醒
#   · 用户态 tailscale    → sidecar/（Go tsnet），按平台自动下载
ENTRY = """url: https://github.com/peng456/dsh-plugin-mesh
name: peng456/dsh-plugin-mesh
category: remote
description:
  en: Discovers other DSH instances on the local network by UDP multicast or port scan, lists them in a sidebar panel together with the capabilities each one reports, and dispatches tasks between machines in both directions over the LAN or over an automatically downloaded userspace Tailscale node.
  zh: 通过 UDP 组播或端口扫描发现局域网内的其他 DSH 实例，在侧栏面板中列出它们以及各自上报的能力，并可经局域网或自动下载的用户态 Tailscale 节点在两台机器之间双向派发任务。
"""

PR_TITLE = "Add peng456/dsh-plugin-mesh"
PR_BODY = """Adds `peng456/dsh-plugin-mesh` to the list.

**What it does.** Discovers other DSH instances on the local network by UDP multicast or port scan, lists them in a sidebar panel together with the capabilities each one reports, and dispatches tasks between machines in both directions over the LAN or over an automatically downloaded userspace Tailscale node.

**Checklist from `contributing.md`:**

- [x] `package.json` declares `dsh.bundle.patch` (plus `dsh.client`, since it ships a browser panel)
- [x] `cordis.patch.yml` is at the repository root
- [x] Real, working code — not a placeholder or README-only repo
- [x] Repository is ~29 days old (well past the 1-day check)
- [x] [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic is set
- [x] Entry adds exactly one file; the generated READMEs are untouched

**Category**: `remote` — it is host-to-host networking between DSH instances, the same area as `chicheng-gate`, `dsh-winrm` and `huahua-dsh-chatroom`. `identity` looked plausible at first but in this list it means agent personas and prompts, which this plugin does not do.

**About the description.** It is deliberately claim-by-claim checkable: multicast discovery is `lib/discovery.js`, port scanning is `lib/scan.js`, the sidebar panel with per-peer capabilities is `client/client.js`, and the userspace Tailscale node is the Go sidecar in `sidecar/` which is downloaded per platform at first use. No npm package yet — installs go through the prebuilt GitHub Release tarball (`plugin-v0.3.29`).
"""


def token() -> str:
    for line in open(os.path.expanduser("~/.git-credentials")):
        m = re.match(r"https://([^:]+):([^@]+)@github\.com\s*$", line.strip())
        if m:
            return m.group(2)
    sys.exit("找不到 github token")


TOKEN = token()


def call(method: str, path: str, body=None, *, ok=(200, 201, 204), raw=False, tries=4):
    """一次 API 调用。

    **网络层重试是必须的**：这台机器到 api.github.com 会偶发
    `SSL: UNEXPECTED_EOF_WHILE_READING`（实测），不重试就会把一次成功的上架
    误报成失败，然后人可能再跑一遍、重复开 PR。只重试"连接都没建起来"的错；
    HTTP 错误码照常返回给调用方判断（那是有意义的答案，不是故障）。
    """
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "dsh-plugin-mesh-submit")
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                payload = r.read()
                return r.status, (payload if raw else (json.loads(payload) if payload else None))
        except urllib.error.HTTPError as e:
            payload = e.read()
            try:
                parsed = json.loads(payload)
            except Exception:
                parsed = payload.decode("utf-8", "replace")
            return e.code, parsed
        except Exception as e:  # URLError / ssl.SSLError / timeout
            last = e
            if attempt < tries - 1:
                wait = 2 * (attempt + 1)
                print(f"  … 网络错误（{type(e).__name__}），{wait}s 后重试 {attempt + 2}/{tries}")
                time.sleep(wait)
    raise last


def die(msg, detail=None):
    print(f"✗ {msg}", file=sys.stderr)
    if detail is not None:
        print(f"  {json.dumps(detail, ensure_ascii=False)[:400]}", file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    print(f"上游   : {UPSTREAM}")
    print(f"分支   : {BRANCH}")
    print(f"文件   : {ENTRY_PATH}")
    print("─" * 60)
    print(ENTRY)

    if args.dry_run:
        print("─" * 60)
        print("（--dry-run：未做任何改动）")
        return

    # 1) fork（已存在则复用）
    st, d = call("GET", f"/repos/{FORK}")
    if st == 200:
        print(f"✓ 已有 fork：{d['full_name']}")
    else:
        st, d = call("POST", f"/repos/{UPSTREAM}/forks")
        if st not in (200, 201, 202):
            die("创建 fork 失败", d)
        print(f"✓ 已创建 fork：{d.get('full_name')}")

    # 2) 等 fork 的 git 数据可用，并取默认分支
    default = None
    for i in range(30):
        st, d = call("GET", f"/repos/{FORK}")
        if st == 200 and d.get("default_branch"):
            default = d["default_branch"]
            break
        time.sleep(2)
    if not default:
        die("fork 迟迟没就绪")
    print(f"✓ fork 就绪，默认分支 {default}")

    # 3) 从默认分支建工作分支（已存在就用它，天然幂等）
    st, d = call("GET", f"/repos/{FORK}/git/ref/heads/{BRANCH}")
    if st == 200:
        print(f"✓ 分支 {BRANCH} 已存在（复用）")
    else:
        st, d = call("GET", f"/repos/{FORK}/git/ref/heads/{default}")
        if st != 200:
            die("读不到默认分支的 SHA", d)
        sha = d["object"]["sha"]
        st, d = call("POST", f"/repos/{FORK}/git/refs", {"ref": f"refs/heads/{BRANCH}", "sha": sha})
        if st not in (200, 201):
            die("建分支失败", d)
        print(f"✓ 已建分支 {BRANCH}（基于 {sha[:8]}）")

    # 4) 提交那一个文件
    st, cur = call("GET", f"/repos/{FORK}/contents/{ENTRY_PATH}?ref={BRANCH}")
    body = {
        "message": PR_TITLE,
        "content": base64.b64encode(ENTRY.encode()).decode(),
        "branch": BRANCH,
    }
    if st == 200:
        body["sha"] = cur["sha"]          # 更新已有文件
        print("  （该文件已存在，将更新）")
    st, d = call("PUT", f"/repos/{FORK}/contents/{ENTRY_PATH}", body)
    if st not in (200, 201):
        die("提交文件失败", d)
    print(f"✓ 已提交 {ENTRY_PATH}（{d['commit']['sha'][:8]}）")

    # 5) 开 PR（已存在则给出链接）
    st, d = call("POST", f"/repos/{UPSTREAM}/pulls", {
        "title": PR_TITLE,
        "head": f"{FORK_OWNER}:{BRANCH}",
        "base": default,
        "body": PR_BODY,
        "maintainer_can_modify": True,
    })
    if st == 201:
        print(f"\n✓ PR 已创建：{d['html_url']}")
    elif st == 422 and "already exists" in json.dumps(d):
        st2, d2 = call("GET", f"/repos/{UPSTREAM}/pulls?head={FORK_OWNER}:{BRANCH}&state=open")
        url = d2[0]["html_url"] if isinstance(d2, list) and d2 else "(已存在，但取不到链接)"
        print(f"\n✓ PR 已存在：{url}")
    else:
        die("开 PR 失败", d)


if __name__ == "__main__":
    main()
