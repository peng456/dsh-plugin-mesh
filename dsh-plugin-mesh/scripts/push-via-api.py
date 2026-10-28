#!/usr/bin/env python3
"""通过 GitHub REST API 推送 git 提交。

为什么需要它：这台机器上 git-over-https 到 github.com 会被 Connection reset
（实测数次），SSH 密钥也没注册到账号；但 api.github.com 是通的（发布 release
走的就是它）。

关键在于**精确复刻**而不是"用文件内容新建一个提交"：git 的 commit SHA 是
(tree, parents, author, committer, message) 的哈希，只要这些字段逐一相同，
API 造出来的 commit 就会得到**与本地完全一致的 SHA**。因此远端历史不会和
本地分裂，之后 git fetch/push 恢复时不会冲突。

每一步都会断言 SHA 与本地一致；对不上就中止、绝不更新远端 ref。

用法：
    scripts/push-via-api.py                  # 推送 origin/main..HEAD
    scripts/push-via-api.py --dry-run        # 只演练，不写远端
    scripts/push-via-api.py --remote origin --branch main
"""
from __future__ import annotations

import argparse
import base64
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"


def die(msg: str) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def git(*args: str, binary: bool = False, strip: bool = True):
    """跑一条 git 命令并返回输出。

    strip=False 时保留原始文本：commit 对象结尾的换行是内容的一部分，
    去掉它就会算出不同的 SHA。

    强制 `core.quotepath=false`：git 默认把非 ASCII 路径转义成
    `"\\350\\256\\276..."` 这种形式输出，脚本再拿它去 cat-file / ls-tree
    就找不到文件了（实测挂在中文文件名上）。
    """
    proc = subprocess.run(["git", "-c", "core.quotepath=false", *args], capture_output=True)
    if proc.returncode != 0:
        die(f"git {' '.join(args)} 失败：{proc.stderr.decode('utf-8', 'replace').strip()}")
    if binary:
        return proc.stdout
    text = proc.stdout.decode("utf-8", "replace")
    return text.rstrip("\n") if strip else text


def read_token() -> str:
    """从 ~/.git-credentials 取 github.com 的 token。"""
    path = os.path.expanduser("~/.git-credentials")
    if not os.path.exists(path):
        die(f"找不到 {path}")
    for line in open(path, encoding="utf-8"):
        m = re.match(r"https://([^:]+):([^@]+)@github\.com\s*$", line.strip())
        if m:
            return m.group(2)
    die("~/.git-credentials 里没有 github.com 的 https 凭证")


class Client:
    def __init__(self, token: str, dry_run: bool = False):
        self.token = token
        self.dry_run = dry_run
        self.calls = 0

    def __call__(self, method: str, path: str, payload=None):
        if self.dry_run and method != "GET":
            print(f"      [dry-run] {method} {path}")
            return {}
        url = path if path.startswith("http") else f"{API}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"token {self.token}")
        req.add_header("Accept", "application/vnd.github+json")
        if data:
            req.add_header("Content-Type", "application/json")
        self.calls += 1
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body.strip() else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            die(f"{method} {path} → HTTP {e.code}\n{detail[:600]}")
        except urllib.error.URLError as e:
            die(f"{method} {path} → 网络错误 {e.reason}")


def parse_commit(sha: str) -> dict:
    """把 git commit 对象拆成 API 需要的字段。"""
    raw = git("cat-file", "commit", sha, strip=False)
    head, _, message = raw.partition("\n\n")
    out = {"tree": None, "parents": [], "author": None, "committer": None, "message": message}

    ident = re.compile(r"^(.*) <(.*)> (\d+) ([+-]\d{4})$")
    for line in head.split("\n"):
        if line.startswith("tree "):
            out["tree"] = line[5:].strip()
        elif line.startswith("parent "):
            out["parents"].append(line[7:].strip())
        elif line.startswith("author "):
            m = ident.match(line[7:].strip())
            if not m:
                die(f"看不懂 author 行：{line}")
            out["author"] = {"name": m.group(1), "email": m.group(2), "date": f"{m.group(3)} {m.group(4)}"}
        elif line.startswith("committer "):
            m = ident.match(line[10:].strip())
            if not m:
                die(f"看不懂 committer 行：{line}")
            out["committer"] = {"name": m.group(1), "email": m.group(2), "date": f"{m.group(3)} {m.group(4)}"}
    if not out["tree"] or not out["author"] or not out["committer"]:
        die(f"commit {sha} 缺少必要字段")
    # API 的 date 要 ISO8601；git 给的是 "epoch +0800"
    for key in ("author", "committer"):
        epoch, tz = out[key]["date"].split(" ")
        sign = 1 if tz[0] == "+" else -1
        offset = f"{tz[0]}{tz[1:3]}:{tz[3:5]}"
        iso = datetime.datetime.fromtimestamp(
            int(epoch),
            datetime.timezone(datetime.timedelta(hours=sign * int(tz[1:3]), minutes=sign * int(tz[3:5]))),
        )
        out[key]["date"] = iso.strftime("%Y-%m-%dT%H:%M:%S") + offset
    return out


def changed_paths(parent: str, sha: str) -> list[tuple[str, str]]:
    """返回 [(status, path)]，status ∈ A/M/D/T。"""
    raw = git("diff-tree", "-r", "--name-status", "--no-renames", parent, sha)
    out = []
    for line in raw.split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        out.append((parts[0][0], parts[-1]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote", default="origin")
    ap.add_argument("--branch", default=None, help="默认取当前分支")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    branch = args.branch or git("rev-parse", "--abbrev-ref", "HEAD")
    head = git("rev-parse", "HEAD")

    # 远端 URL → owner/repo
    url = git("remote", "get-url", args.remote)
    m = re.search(r"github\.com[:/]([^/]+)/([^/\s]+?)(?:\.git)?$", url)
    if not m:
        die(f"看不懂远端 URL：{url}")
    owner, repo = m.group(1), m.group(2)
    print(f"仓库   : {owner}/{repo}")
    print(f"分支   : {branch}")

    ref = Client(read_token(), args.dry_run)("GET", f"/repos/{owner}/{repo}/git/ref/heads/{branch}")
    if not ref or "object" not in ref:
        die(f"取不到远端 ref（分支 {branch} 是否已存在？）")
    remote_head = ref["object"]["sha"]
    print(f"远端头 : {remote_head[:12]}")
    print(f"本地头 : {head[:12]}")

    if remote_head == head:
        print("✓ 已经一致，无需推送")
        return 0

    # 远端头必须是本地头的祖先，否则本地落后或有分叉 —— 先让用户自己处理
    if subprocess.run(["git", "merge-base", "--is-ancestor", remote_head, head]).returncode != 0:
        die("远端头不是本地头的祖先（历史分叉或本地落后）。请先 git fetch/reset 再试。")

    commits = [c for c in git("rev-list", "--reverse", f"{remote_head}..{head}").split("\n") if c]
    print(f"待推送 : {len(commits)} 个提交\n")

    client = Client(read_token(), args.dry_run)
    for idx, sha in enumerate(commits, 1):
        info = parse_commit(sha)
        subject = info["message"].split("\n", 1)[0]
        print(f"[{idx}/{len(commits)}] {sha[:12]}  {subject}")

        parent = info["parents"][0] if info["parents"] else None
        base_tree = git("rev-parse", f"{parent}^{{tree}}") if parent else None
        if not parent:
            die("不支持推送根提交（仓库应当已有历史）")

        tree_entries = []
        for status, path in changed_paths(parent, sha):
            if status == "D":
                tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
                continue
            blob = git("cat-file", "blob", f"{sha}:{path}", binary=True)
            created = client("POST", f"/repos/{owner}/{repo}/git/blobs",
                             {"content": base64.b64encode(blob).decode("ascii"), "encoding": "base64"})
            if not args.dry_run:
                expect = git("rev-parse", f"{sha}:{path}")
                if created.get("sha") != expect:
                    die(f"blob SHA 不一致：{path}\n  API={created.get('sha')}\n  本地={expect}")
            mode = git("ls-tree", sha, "--", path).split()[0]  # "100644 blob <sha>\t<path>"
            tree_entries.append({"path": path, "mode": mode, "type": "blob", "sha": created.get("sha")})
            print(f"      blob {path}")

        new_tree = client("POST", f"/repos/{owner}/{repo}/git/trees", {"base_tree": base_tree, "tree": tree_entries})
        if not args.dry_run and new_tree.get("sha") != info["tree"]:
            die(f"tree SHA 不一致：\n  API={new_tree.get('sha')}\n  本地={info['tree']}\n"
                f"（可能是被 .gitignore 影响，或路径含特殊字符）")

        created_commit = client("POST", f"/repos/{owner}/{repo}/git/commits", {
            "message": info["message"],
            "tree": new_tree.get("sha", info["tree"]),
            "parents": info["parents"],
            "author": info["author"],
            "committer": info["committer"],
        })
        if not args.dry_run and created_commit.get("sha") != sha:
            # 出问题时把 API 侧的 commit 拉回来逐字段对比，不让人瞎猜
            got = client("GET", f"/repos/{owner}/{repo}/git/commits/{created_commit.get('sha')}")
            print("\n  字段对比（本地 vs API）:", file=sys.stderr)
            pairs = (
                ("tree", info["tree"], (got.get("tree") or {}).get("sha")),
                ("parents", info["parents"], [p["sha"] for p in got.get("parents", [])]),
                ("author.name", info["author"]["name"], (got.get("author") or {}).get("name")),
                ("author.email", info["author"]["email"], (got.get("author") or {}).get("email")),
                ("author.date", info["author"]["date"], (got.get("author") or {}).get("date")),
                ("committer.name", info["committer"]["name"], (got.get("committer") or {}).get("name")),
                ("committer.date", info["committer"]["date"], (got.get("committer") or {}).get("date")),
                ("message", repr(info["message"][-60:]), repr((got.get("message") or "")[-60:])),
            )
            for label, local_v, api_v in pairs:
                flag = "  " if local_v == api_v else "≠ "
                print(f"    {flag}{label:16} 本地={local_v!r}", file=sys.stderr)
                if local_v != api_v:
                    print(f"      {'':16} API ={api_v!r}", file=sys.stderr)
            die(f"commit SHA 不一致：\n  API={created_commit.get('sha')}\n  本地={sha}")
        print(f"      commit 复刻一致 ✓")

        if not args.dry_run:
            client("PATCH", f"/repos/{owner}/{repo}/git/refs/heads/{branch}",
                   {"sha": created_commit["sha"], "force": False})

    if not args.dry_run:
        # 本地把远端跟踪 ref 对齐，这样 git status 立刻显示同步、不会误以为还要推
        git("update-ref", f"refs/remotes/{args.remote}/{branch}", head)
        print(f"\n✓ 已推送 {len(commits)} 个提交，并把 refs/remotes/{args.remote}/{branch} 对齐到 {head[:12]}")
    else:
        print("\n(dry-run，未写入远端)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
