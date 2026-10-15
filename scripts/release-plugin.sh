#!/usr/bin/env bash
# 把插件源码打成 tar.gz 并发到 GitHub Release。
#
# 为什么需要它：本机（以及同一网络里的其他机器）git-over-https 到 github.com
# 会被 Connection reset，装插件常用的 `git clone` 走不通。而 release 资产可以
# 经国内镜像正常下载，所以给不能 clone 的机器留一条路：
#
#   curl -L https://ghfast.top/<release 资产 URL> | tar xz -C <插件目录>
#
# sidecar 二进制走的是同一套思路（见 scripts/build-sidecar.sh），区别是这个包
# 只有约 100KB，随便下。
#
# 用法：
#   scripts/release-plugin.sh              # 只打包
#   scripts/release-plugin.sh --publish    # 打包并发布
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="peng456/dsh-plugin-mesh"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
TAG="plugin-v$VERSION"
ASSET="dsh-plugin-mesh-$VERSION.tar.gz"
DIST="$REPO_ROOT/dist"

PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1

echo "==> 打包插件 v$VERSION"
mkdir -p "$DIST"
rm -f "$DIST/$ASSET"
# sidecar 的 Go 源码要带上：用户可据此审计下载回来的二进制是用什么编出来的。
tar --exclude='.git' \
    --exclude='dist' \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    -czf "$DIST/$ASSET" \
    -C "$REPO_ROOT" \
    lib client sidecar scripts cordis.patch.yml package.json README.md LICENSE install.sh

echo "  产物: $DIST/$ASSET  ($(du -h "$DIST/$ASSET" | cut -f1), $(tar -tzf "$DIST/$ASSET" | wc -l | tr -d ' ') 个条目)"
sha256sum "$DIST/$ASSET" 2>/dev/null || shasum -a 256 "$DIST/$ASSET"

if [ "$PUBLISH" -eq 0 ]; then
  echo
  echo "未发布。加 --publish 会创建 release $TAG 并上传。"
  exit 0
fi

TOKEN="$(python3 - <<'PY'
import os, re
for line in open(os.path.expanduser("~/.git-credentials")):
    m = re.match(r'https://([^:]+):([^@]+)@github\.com\s*$', line.strip())
    if m:
        print(m.group(2)); break
PY
)"
[ -n "$TOKEN" ] || { echo "找不到 github token" >&2; exit 1; }
API="https://api.github.com/repos/$REPO"

echo
echo "==> 发布到 GitHub release $TAG"
RELEASE_ID="$(curl -s -m 30 -H "Authorization: token $TOKEN" "$API/releases/tags/$TAG" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"
if [ -z "$RELEASE_ID" ]; then
  RELEASE_ID="$(curl -s -m 30 -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
    "$API/releases" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"dsh-plugin-mesh v$VERSION\",\"body\":\"插件源码包。适合不能 git clone 的机器（github.com 的 git 端点在国内常被重置）：\\n\\n\`\`\`\\ncurl -L https://ghfast.top/https://github.com/$REPO/releases/download/$TAG/$ASSET | tar xz -C ~/.dsh/profiles/<profile>/node_modules/dsh-plugin-mesh/\\n\`\`\`\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"
  echo "  已创建 release $TAG"
else
  echo "  复用 release $TAG (id=$RELEASE_ID)"
fi
[ -n "$RELEASE_ID" ] || { echo "创建 release 失败" >&2; exit 1; }

# 同名资产先删，否则 API 报 already_exists
OLD_ID="$(curl -s -m 30 -H "Authorization: token $TOKEN" "$API/releases/$RELEASE_ID/assets" \
  | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if a.get('name')=='$ASSET': print(a.get('id')); break
" 2>/dev/null)"
[ -n "$OLD_ID" ] && curl -s -m 30 -X DELETE -H "Authorization: token $TOKEN" "$API/releases/assets/$OLD_ID" >/dev/null && echo "  替换已有资产"

curl -s -m 300 -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary "@$DIST/$ASSET" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$ASSET" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  ✓", d.get("name"), d.get("size"), "字节") if d.get("id") else print("  ✗", d.get("message"))'

echo "✓ https://github.com/$REPO/releases/tag/$TAG"

# ── 同步到局域网镜像，并打印可直接粘贴的升级命令 ──
#
# 为什么这一步要自动化：不能 git clone 的机器（实测那台 Android）连 github.com /
# ghfast.top / gh-proxy.com 全都不通，唯一可用的通路就是同网段的镜像。以前每次
# 发版都要手工 `cp` 一次到镜像目录，忘了就会出现"release 发了但对端下不到"——
# 而且是**静默**的，对端只会报 404/超时。所以发完版顺手同步，并把命令打出来。
#
# 镜像目录可用 MESH_MIRROR_DIR 覆盖；目录不存在就跳过（不是每台机器都当镜子）。
MIRROR_DIR="${MESH_MIRROR_DIR:-/Users/peng/mesh-mirror-8791}"
if [ -d "$MIRROR_DIR" ]; then
  cp "$DIST/$ASSET" "$MIRROR_DIR/" && echo "✓ 已同步到镜像 $MIRROR_DIR"
  MIRROR_HOST="${MESH_MIRROR_HOST:-192.168.1.6:8791}"
  cat <<EOF

── 让对端升级（把 <PLUGIN> 换成它的插件目录）──────────────────
# ⚠ Android 上**没有 /tmp**（根文件系统只读），必须用 \$TMPDIR
T="\${TMPDIR:-\$HOME/tmp}"; mkdir -p "\$T"
curl -fL -o "\$T/mesh-$VERSION.tar.gz" http://$MIRROR_HOST/$ASSET
mkdir -p "\$T/mesh-new" && tar xzf "\$T/mesh-$VERSION.tar.gz" -C "\$T/mesh-new"
grep -m1 '"version"' "\$T/mesh-new/package.json"     # 应显示 $VERSION

PLUGIN=<对端插件目录>                                  # 例：\$HOME/.dsh/profiles/web/node_modules/dsh-plugin-mesh
cp -R "\$PLUGIN" "\$PLUGIN.bak-$VERSION"
rm -rf "\$PLUGIN/lib" "\$PLUGIN/client" "\$PLUGIN/scripts" "\$PLUGIN/sidecar"
cp -R "\$T/mesh-new/lib" "\$T/mesh-new/client" "\$T/mesh-new/scripts" "\$T/mesh-new/sidecar" "\$PLUGIN/"
cp "\$T/mesh-new/package.json" "\$T/mesh-new/cordis.patch.yml" "\$PLUGIN/"
grep -m1 '"version"' "\$PLUGIN/package.json"          # 应显示 $VERSION

# ⚠ 重启前必须验「可加载」，光验"文件对得上"兜不住半态：新代码若新增了 import
#   而落盘漏了那个文件，文件级 cmp 全绿、node --check 也全绿，但重启时 DSH
#   加载插件会**当场崩**。只有真的 import 一次入口才复现得出来。
node -e "(async()=>{const m=await import('file://\$PLUGIN/lib/index.js');console.log('✓ 可加载',Object.keys(m).join(','))})().catch(e=>{console.error('✗ 不可加载，**不要重启**，先回滚:',e.code||e.message);process.exit(1)})"
# 退出码 0 才继续。回滚：rm -rf "\$PLUGIN" && mv "\$PLUGIN.bak-$VERSION" "\$PLUGIN"
# 然后**重启对端的 DSH** 才会加载新版本
────────────────────────────────────────────────────────────
EOF
else
  echo "（跳过镜像同步：$MIRROR_DIR 不存在）"
fi
