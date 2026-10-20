#!/usr/bin/env bash
# 打「插件源码包」：给不能 git clone 的机器准备的 GitHub Release 资产。
#
# 为什么单独抽成脚本：这条打包命令现在有两个调用方 —— 本机手工发版
# （scripts/release-plugin.sh）和 CI 自动发版（.github/workflows/release.yml）。
# 复制两份的必然结局是漂移：某天 files 白名单加了个目录，手发的那份带上了、
# CI 那份没带，而两边都不会报错（这项目在"看着接上了其实没接"上栽过好几次）。
#
# stdout 只输出机器可读的三行，日志走 stderr：
#   asset=/abs/path/dsh-plugin-mesh-0.3.33.tar.gz
#   size=101K
#   sha256=...
#
# 用法：
#   scripts/pack-release-tarball.sh [输出目录]     # 默认 dist/
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
ASSET="dsh-plugin-mesh-$VERSION.tar.gz"
OUT_DIR="${1:-$REPO_ROOT/dist}"

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$ASSET"
rm -f "$OUT"

{
  echo "==> 打包插件 v$VERSION"
  # sidecar 的 Go 源码要带上：用户可据此审计下载回来的二进制是用什么编出来的。
} >&2

tar --exclude='.git' \
    --exclude='dist' \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    -czf "$OUT" \
    -C "$REPO_ROOT" \
    lib client sidecar scripts cordis.patch.yml package.json README.md LICENSE install.sh

SIZE="$(du -h "$OUT" | cut -f1)"
SHA="$(shasum -a 256 "$OUT" 2>/dev/null | cut -d' ' -f1 || sha256sum "$OUT" | cut -d' ' -f1)"

echo "  产物: $OUT  ($SIZE, $(tar -tzf "$OUT" | wc -l | tr -d ' ') 个条目)" >&2

echo "asset=$OUT"
echo "size=$SIZE"
echo "sha256=$SHA"
