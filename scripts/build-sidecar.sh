#!/usr/bin/env bash
# Cross-compile the DSH Mesh tsnet sidecar for every supported platform,
# gzip each binary, and emit a sha256 manifest for the plugin's downloader.
#
# End users never run this: the plugin downloads the published artifacts and
# verifies them against checksums.txt. This script only runs when cutting a
# sidecar release.
#
# Usage:
#   scripts/build-sidecar.sh              # build into dist/sidecar/
#   scripts/build-sidecar.sh --publish    # build, then create/update the GitHub release
#
# Requires: go (build-time only). No cgo, so no cross toolchain is needed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/sidecar"
DIST_DIR="$REPO_ROOT/dist/sidecar"

# The release tag is tied to the sidecar control-API protocol, not the plugin
# version: the plugin pins a protocol number and refuses mismatched binaries.
PROTOCOL_VERSION=1
RELEASE_TAG="sidecar-v${PROTOCOL_VERSION}"
# 发布目标仓库。必须与 lib/tsnet/download.js 里的 REPO 一致，否则插件会去
# 另一个仓库找二进制。
REPO="peng456/dsh-plugin-mesh"

# Windows/arm64 is omitted deliberately: it is vanishingly rare and each extra
# target costs a full rebuild of the whole tailscale dependency tree.
ALL_TARGETS=(
  "darwin/amd64"
  "darwin/arm64"
  "linux/amd64"
  "linux/arm64"
  "windows/amd64"
)
TARGETS=("${ALL_TARGETS[@]}")

# 构建串行、且限制单个 go build 的包级并行度。
# 这台机器只有 2 物理核 / 8GB 内存：先前按目标并行的做法把 load average
# 推到 300+、疯狂换页，总耗时反而长得多。
JOBS="${DSH_BUILD_JOBS:-2}"

PUBLISH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1; shift ;;
    --targets)
      IFS=',' read -r -a TARGETS <<< "$2"
      shift 2
      ;;
    --jobs)
      JOBS="$2"
      shift 2
      ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v go >/dev/null 2>&1 || { echo "go toolchain not found; it is required only for building releases" >&2; exit 1; }

# Derive the protocol version straight from the source so the tag can never
# drift from what the binary actually speaks.
SRC_PROTOCOL="$(grep -E '^const ProtocolVersion = ' "$SIDECAR_DIR/main.go" | grep -oE '[0-9]+')"
if [ "$SRC_PROTOCOL" != "$PROTOCOL_VERSION" ]; then
  echo "ProtocolVersion mismatch: main.go says $SRC_PROTOCOL, script says $PROTOCOL_VERSION" >&2
  exit 1
fi

# 构建戳用 sidecar 源码的 git 提交哈希，而不是时间戳。
#
# Go 构建是可复现的（实测：同输入连编两次逐字节相同），所以拿内容哈希当戳时，
# **未改动的平台重编后产物完全一致、sha256 不变**。这样补一个新平台（比如后来
# 才需要 linux/arm64）不会让已装的机器被迫重下 8.5MB。用时间戳则每次发版全平台
# 哈希都变，所有机器都要重下一遍。
BUILD_STAMP="$(git -C "$REPO_ROOT" log -1 --format=%h -- sidecar 2>/dev/null || true)"
[ -n "$BUILD_STAMP" ] || BUILD_STAMP="nogit"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- sidecar 2>/dev/null)" ]; then
  BUILD_STAMP="${BUILD_STAMP}-dirty"
fi
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

echo "==> 编译 tsnet sidecar  (protocol=v$PROTOCOL_VERSION, stamp=$BUILD_STAMP)"
echo "==> Go: $(go version)"
echo

# 串行构建：每个目标都要完整重编整棵 tailscale 依赖树，并行只会互相抢 CPU。
failed=0
for target in "${TARGETS[@]}"; do
  os="${target%%/*}"
  arch="${target##*/}"
  asset="dsh-mesh-tsnet-${os}-${arch}"
  [ "$os" = "windows" ] && asset="${asset}.exe"

  echo "  [start] $os/$arch  ($(date -u +%H:%M:%S))"
  if GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 GOMAXPROCS="$JOBS" \
      go build -C "$SIDECAR_DIR" -p "$JOBS" -trimpath \
      -ldflags="-s -w -X main.buildStamp=$BUILD_STAMP" \
      -o "$DIST_DIR/$asset" . 2>"$DIST_DIR/.build-$os-$arch.err"; then
    gzip -9 -f "$DIST_DIR/$asset"
    echo "  [done ] $os/$arch  $(du -h "$DIST_DIR/${asset}.gz" | cut -f1)  ($(date -u +%H:%M:%S))"
  else
    echo "  [FAIL ] $os/$arch"
    sed 's/^/          /' "$DIST_DIR/.build-$os-$arch.err" | head -20
    failed=1
  fi
done
rm -f "$DIST_DIR"/.build-*.err

if [ "$failed" -ne 0 ]; then
  echo
  echo "构建失败，未生成发布产物。" >&2
  exit 1
fi

echo
echo "==> 生成 sha256 清单"
(
  cd "$DIST_DIR"
  # sha256sum on Linux, shasum on macOS; the manifest format is identical.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum ./*.gz > checksums.txt
  else
    shasum -a 256 ./*.gz > checksums.txt
  fi
  cat checksums.txt
)

echo
echo "==> 写入 lib/tsnet/checksums.js（插件内置的 sha256 白名单）"
node - "$DIST_DIR/checksums.txt" "$REPO_ROOT/lib/tsnet/checksums.js" <<'NODE'
const fs = require("node:fs");
const [, , manifestPath, outPath] = process.argv;
const entries = fs
  .readFileSync(manifestPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [hash, name] = line.split(/\s+/);
    return [name.replace(/^\.\//, ""), hash];
  })
  .sort(([a], [b]) => a.localeCompare(b));

const rows = entries.map(([name, hash]) => `  "${name}": "${hash}",`).join("\n");
const content = `/**
 * sidecar 二进制的 sha256 白名单 —— 由 scripts/build-sidecar.sh 发布时生成，请勿手改。
 *
 * 为什么钉在这里而不是下载 release 里的 checksums.txt：
 * 下载源在国内必须走第三方镜像（直连 GitHub 实测不通）。如果校验和也跟着
 * 二进制一起从镜像拿，一个恶意镜像就能同时替换两者，校验形同虚设。钉在
 * 插件源码里（与二进制分属不同渠道）才构成真正的完整性约束。
 *
 * 键是资产名，值是 gzip 压缩后的 sha256。
 */
export const PINNED_CHECKSUMS = {
${rows}
};
`;
fs.writeFileSync(outPath, content);
console.log(`  已写入 ${entries.length} 条校验和 → ${outPath}`);
NODE

echo
echo "==> 产物目录: $DIST_DIR"
ls -lh "$DIST_DIR" | tail -n +2 | awk '{printf "    %-42s %s\n", $9, $5}'

if [ "$PUBLISH" -eq 0 ]; then
  echo
  echo "未发布。加 --publish 会创建 GitHub release $RELEASE_TAG 并上传资产。"
  exit 0
fi

echo
echo "==> 发布到 GitHub release $RELEASE_TAG"

# 优先用 gh；没装就走 REST API（这台机器上没装 gh，且 releases API 与
# uploads 域名实测都通，所以 API 这条路是可靠的）。
if command -v gh >/dev/null 2>&1; then
  if gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
    gh release upload "$RELEASE_TAG" "$DIST_DIR"/*.gz "$DIST_DIR"/checksums.txt --clobber
  else
    gh release create "$RELEASE_TAG" \
      --title "tsnet sidecar v$PROTOCOL_VERSION" \
      --notes "DSH Mesh 互联网自组网 sidecar 二进制（协议 v$PROTOCOL_VERSION，构建 $BUILD_STAMP）。" \
      "$DIST_DIR"/*.gz "$DIST_DIR"/checksums.txt
  fi
else
  TOKEN="$(python3 - <<'PY'
import os, re
p = os.path.expanduser("~/.git-credentials")
for line in open(p):
    m = re.match(r'https://([^:]+):([^@]+)@github\.com\s*$', line.strip())
    if m:
        print(m.group(2))
        break
PY
)"
  [ -n "$TOKEN" ] || { echo "找不到 github token（~/.git-credentials），无法发布" >&2; exit 1; }

  API="https://api.github.com/repos/$REPO"
  # 已存在就复用，不存在就创建。release id 是上传资产的必填项。
  RELEASE_ID="$(curl -s -m 30 -H "Authorization: token $TOKEN" "$API/releases/tags/$RELEASE_TAG" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"

  if [ -z "$RELEASE_ID" ]; then
    echo "  创建 release $RELEASE_TAG"
    RELEASE_ID="$(curl -s -m 30 -X POST \
      -H "Authorization: token $TOKEN" \
      -H "Content-Type: application/json" \
      "$API/releases" \
      -d "{\"tag_name\":\"$RELEASE_TAG\",\"name\":\"tsnet sidecar v$PROTOCOL_VERSION\",\"body\":\"DSH Mesh 互联网自组网 sidecar 二进制（协议 v$PROTOCOL_VERSION，构建 $BUILD_STAMP）。\\n\\n插件会自动下载对应平台的 .gz 并按 lib/tsnet/checksums.js 里内置的 sha256 校验，终端用户无需安装 Go 或 Tailscale。\"}" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"
  else
    echo "  复用已有 release $RELEASE_TAG (id=$RELEASE_ID)"
  fi
  [ -n "$RELEASE_ID" ] || { echo "创建/查找 release 失败" >&2; exit 1; }

  for f in "$DIST_DIR"/*.gz "$DIST_DIR"/checksums.txt; do
    name="$(basename "$f")"
    # 同名资产已存在时先删掉，否则 API 会报 already_exists
    OLD_ID="$(curl -s -m 30 -H "Authorization: token $TOKEN" "$API/releases/$RELEASE_ID/assets" \
      | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if a.get('name')=='$name': print(a.get('id')); break
" 2>/dev/null)"
    if [ -n "$OLD_ID" ]; then
      curl -s -m 30 -X DELETE -H "Authorization: token $TOKEN" "$API/releases/assets/$OLD_ID" >/dev/null
      echo "  替换 $name"
    else
      echo "  上传 $name"
    fi
    curl -s -m 600 -X POST \
      -H "Authorization: token $TOKEN" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$f" \
      "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$name" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("    ✓", d.get("name"), d.get("size"), "字节") if d.get("id") else print("    ✗", d.get("message"))'
  done
fi

echo "✓ 已发布: https://github.com/$REPO/releases/tag/$RELEASE_TAG"
