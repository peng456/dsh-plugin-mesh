#!/usr/bin/env python3
"""把**已经构建好**的产物发布到 GitHub release（不重新编译、不重新打包）。

为什么单独需要它：`build-sidecar.sh --publish` 与 `release-plugin.sh --publish` 都是
"先构建/打包、再上传"，而本仓库的构建戳里含着 git HEAD —— Go 会把 `vcs.revision`
编进二进制，所以**再构建一次得到的哈希与上一次不同**。发布必须是"原样上传这一份"：
已经过真机验证、已经写进 lib/tsnet/checksums.js、已经上了局域网镜像的那些文件，
一个字节都不能变。所以这个脚本只做上传。

用法：
    scripts/publish-assets.py                 # 发布 sidecar 全部资产 + 当前版本的插件源码包
    scripts/publish-assets.py --dry-run       # 只演练
    scripts/publish-assets.py --only sidecar  # 只发 sidecar
    scripts/publish-assets.py --only plugin   # 只发插件源码包
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"
REPO = "peng456/dsh-plugin-mesh"
SIDECAR_TAG = "sidecar-v1"  # 与 lib/tsnet/download.js 的 SIDECAR_PROTOCOL 绑定


def die(msg: str) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def read_token() -> str:
    """从 ~/.git-credentials 取 github.com 的 token。"""
    path = os.path.expanduser("~/.git-credentials")
    try:
        with open(path) as fh:
            for line in fh:
                m = re.match(r"https://([^:]+):([^@]+)@github\.com\s*$", line.strip())
                if m:
                    return m.group(2)
    except OSError as e:
        die(f"读不到 {path}：{e}")
    die("~/.git-credentials 里没有 github.com 的 https 凭证")


class Client:
    def __init__(self, token: str, dry_run: bool = False):
        self.token = token
        self.dry_run = dry_run

    def __call__(self, method: str, url: str, body: bytes | None = None, ctype: str = "application/json"):
        if not url.startswith("http"):
            url = API + url
        if self.dry_run:
            print(f"      [dry-run] {method} {url}" + (f"  ({len(body)} 字节)" if body else ""))
            return {}
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", f"token {self.token}")
        req.add_header("Accept", "application/vnd.github+json")
        if body is not None:
            req.add_header("Content-Type", ctype)
        # 这条网络很飘（实测会随机出现 SSL UNEXPECTED_EOF / 连接重置），
        # 而发布是幂等的（同名资产先删再传），所以对传输层错误重试几次。
        last = None
        for attempt in range(1, 5):
            try:
                with urllib.request.urlopen(req, timeout=600) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:400]
                if e.code == 404:
                    return {"__status": 404}
                if e.code >= 500 and attempt < 4:
                    last = f"HTTP {e.code}: {detail}"
                else:
                    die(f"{method} {url} → HTTP {e.code}: {detail}")
            except (urllib.error.URLError, OSError) as e:  # 含 ssl.SSLError / 超时
                last = str(e)
            if attempt < 4:
                wait = 2 * attempt
                print(f"      · 传输失败（{last}），{wait}s 后重试 {attempt}/3")
                time.sleep(wait)
        die(f"{method} {url} → 重试后仍失败：{last}")


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_release(client: Client, tag: str, title: str, body: str) -> int:
    rel = client("GET", f"/repos/{REPO}/releases/tags/{tag}")
    if rel.get("__status") == 404:
        print(f"  创建 release {tag}")
        rel = client(
            "POST",
            f"/repos/{REPO}/releases",
            json.dumps({"tag_name": tag, "name": title, "body": body}).encode(),
        )
    else:
        print(f"  复用 release {tag} (id={rel.get('id')})")
    rid = rel.get("id")
    if not rid:
        if client.dry_run:
            return 0  # 演练模式没有真 id，占位即可
        die(f"拿不到 release id：{rel}")
    return rid


def upload(client: Client, rid: int, path: str) -> None:
    name = os.path.basename(path)
    local = sha256(path)
    # 同名资产先删，否则 API 报 already_exists
    assets = client("GET", f"/repos/{REPO}/releases/{rid}/assets")
    for a in assets if isinstance(assets, list) else []:
        if a.get("name") == name:
            client("DELETE", f"/repos/{REPO}/releases/assets/{a['id']}")
            print(f"  替换 {name}")
            break
    else:
        print(f"  上传 {name} ({os.path.getsize(path)} 字节)")
    with open(path, "rb") as fh:
        payload = fh.read()
    res = client(
        "POST",
        f"{UPLOADS}/repos/{REPO}/releases/{rid}/assets?name={urllib.parse.quote(name)}",
        payload,
        ctype="application/octet-stream",
    )
    if client.dry_run:
        return
    # GitHub 现在会给资产算 digest，用它逐字核对上传结果 —— 这是"发上去的确实是
    # 本地这一份"的唯一硬证据。
    got = (res.get("digest") or "").removeprefix("sha256:")
    if got != local:
        die(f"{name} 上传后 digest 不一致：本地 {local[:16]}… 远端 {got[:16] or '(未返回)'}…")
    print(f"    ✓ {name}  sha256={local[:16]}…  size={res.get('size')}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", choices=["sidecar", "plugin"], default=None)
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dist = os.path.join(root, "dist")
    sidecar_dir = os.path.join(dist, "sidecar")
    client = Client(read_token(), args.dry_run)

    try:
        with open(os.path.join(root, "package.json")) as fh:
            version = json.load(fh)["version"]
    except (OSError, KeyError) as e:
        die(f"读 package.json 失败：{e}")

    print(f"仓库   : {REPO}")
    print(f"版本   : {version}")

    if args.only in (None, "sidecar"):
        if not os.path.isdir(sidecar_dir):
            die(f"没有 {sidecar_dir}；先跑 scripts/build-sidecar.sh")
        files = sorted(
            os.path.join(sidecar_dir, f)
            for f in os.listdir(sidecar_dir)
            # 只发 sidecar 自己的资产：dist/sidecar 里还放着给局域网镜像用的插件
            # 源码包，那个属于 plugin-* release，别混进来。
            if (f.startswith("dsh-mesh-tsnet-") and f.endswith(".gz")) or f == "checksums.txt"
        )
        if not files:
            die(f"{sidecar_dir} 里没有可发布的产物")
        print(f"\n=== sidecar → {SIDECAR_TAG}（{len(files)} 个文件）===")
        rid = ensure_release(
            client,
            SIDECAR_TAG,
            "tsnet sidecar v1",
            "DSH Mesh 互联网自组网 sidecar 二进制（协议 v1）。插件按平台自动下载，"
            "并用 lib/tsnet/checksums.js 里内置的 sha256 校验；终端用户无需安装 Go 或 Tailscale。",
        )
        for f in files:
            upload(client, rid, f)

    if args.only in (None, "plugin"):
        asset = os.path.join(dist, f"dsh-plugin-mesh-{version}.tar.gz")
        if not os.path.isfile(asset):
            die(f"没有 {asset}；先跑 scripts/release-plugin.sh")
        tag = f"plugin-v{version}"
        print(f"\n=== 插件源码包 → {tag} ===")
        rid = ensure_release(
            client,
            tag,
            f"dsh-plugin-mesh v{version}",
            "插件源码包。适合不能 git clone 的机器（github.com 的 git 端点在国内常被重置）。",
        )
        upload(client, rid, asset)

    print("\n完成。" if not args.dry_run else "\n(dry-run，未写入远端)")


if __name__ == "__main__":
    main()
