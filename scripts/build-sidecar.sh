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
#
# android/* 是**独立平台**，不是 linux 的别名 —— 它的产物形态必须不同，见
# 循环里的 ANDROID 分支。两者不能共用一个资产。
ALL_TARGETS=(
  "darwin/amd64"
  "darwin/arm64"
  "linux/amd64"
  "linux/arm64"
  "android/amd64"
  "android/arm64"
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

  # 默认：CGO_ENABLED=0 的**全静态 ET_EXEC**（-buildmode=exe），没有任何
  # PT_INTERP / DT_NEEDED，glibc 与 musl(Alpine) 上都能直接跑。
  #
  # 刻意**不给桌面 linux 加 -buildmode=pie**：PIE 会把解释器钉成
  # /lib64/ld-linux-x86-64.so.2（arm64 是 /lib/ld-linux-aarch64.so.1），
  # Alpine 这类 musl 发行版根本没有该路径，等于用一点安全加固换掉一整类系统。
  # Android 才真正需要 PIE，而且需要的形态还不一样 → 见下面的分支。
  go_os="$os"
  buildmode=()
  extra_ldflags=""

  if [ "$os" = "android" ]; then
    # ANDROID：**必须**是 PIE（ET_DYN）。
    #
    # Android 从 5.0 起只允许 PIE 可执行文件，静态 ET_EXEC 会在 exec 阶段被
    # bionic 直接拒掉，原话就一句（真机实测，2026-10）：
    #     error: "…/dsh-mesh-tsnet" has unexpected e_type: 2
    # 与 glibc/bionic、CGO_ENABLED 与否、权限都无关，就是 ELF 类型不对。
    #
    # 但**只加 -buildmode=pie 还不够**：Go 内部链接器产的 PIE 带
    #     PT_INTERP=/lib/ld-linux-aarch64.so.1
    # （实测 go1.25.5 linux/arm64），这个路径在 Android 上不存在 —— Android 的
    # 加载器是 /system/bin/linker64，内核按 PT_INTERP 找 loader 会以 ENOENT
    # 收场。所以必须用 -I 把解释器显式指到 bionic。
    #
    # 这么做的底气来自实测的 ELF 内容：这种 PIE 里
    #   · e_type=3(ET_DYN)、DT_NEEDED 为空、动态符号表无未定义符号
    #   · 重定位全是 R_AARCH64_RELATIVE（linux/arm64 实测 113089 条）、.rela.plt 为空
    # 也就是说它不依赖任何 libc，bionic 加载时只需要按 load bias 把 RELATIVE
    # 重定位刷一遍即可 —— 正是 Android 自家 PIE 可执行文件的形态。
    #
    # 用 GOOS=linux 而不是 GOOS=android：这里不需要 libc，而 GOOS=android 这个
    # port 需要 cgo + NDK 工具链。Termux 跑的本来就是 Linux ELF。
    go_os=linux
    buildmode=(-buildmode=pie)
    extra_ldflags="-I /system/bin/linker64"
  fi

  echo "  [start] $os/$arch  ($(date -u +%H:%M:%S))"
  if GOOS="$go_os" GOARCH="$arch" CGO_ENABLED=0 GOMAXPROCS="$JOBS" \
      go build -C "$SIDECAR_DIR" -p "$JOBS" -trimpath ${buildmode[@]+"${buildmode[@]}"} \
      -ldflags="-s -w -X main.buildStamp=$BUILD_STAMP $extra_ldflags" \
      -o "$DIST_DIR/$asset" . 2>"$DIST_DIR/.build-$os-$arch.err"; then
    if [ "$os" = "android" ]; then
      # Go 内部链接器把 PT_TLS 的 p_align 写成寄存器宽度(8)，ARM64 bionic 要求
      # ≥64，不改的话加载期就被拒。见 scripts/fix-android-tls-align.py 的说明。
      python3 "$REPO_ROOT/scripts/fix-android-tls-align.py" "$DIST_DIR/$asset"
    fi
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

# 断言 android 产物的 ELF 形态 —— 这一步是为了让这两类坑不可能再溜出去，它们
# 当初的表现都是「设备上直接起不来」而本地怎么看都"编好了"。构建期检查是唯一
# 能在发布前拦住它们的地方：
#   1) ET_EXEC（非 PIE）      → bionic: has unexpected e_type: 2
#   2) PT_TLS p_align=8       → bionic: TLS segment is underaligned (ARM64 要 >=64)
echo
echo "==> 校验 android 产物形态（ET_DYN + bionic 解释器 + TLS 对齐）"
python3 - "$DIST_DIR" <<'PY'
import gzip, os, struct, sys

dist = sys.argv[1]
EXPECTED_INTERP = b"/system/bin/linker64"
MIN_TLS_ALIGN = {183: 64, 62: 16}  # AArch64 / x86_64 上 bionic 的最低要求
bad = []
checked = 0
for name in sorted(os.listdir(dist)):
    if not (name.startswith("dsh-mesh-tsnet-android-") and name.endswith(".gz")):
        continue
    raw = gzip.open(os.path.join(dist, name), "rb").read()
    if raw[:4] != b"\x7fELF" or raw[4] != 2:
        bad.append(f"{name}: 不是 64 位 ELF")
        continue
    e_machine = struct.unpack_from("<H", raw, 18)[0]
    e_type = struct.unpack_from("<H", raw, 16)[0]
    phoff, = struct.unpack_from("<Q", raw, 32)
    phentsize, phnum = struct.unpack_from("<HH", raw, 54)
    interp, tls_align = None, None
    for i in range(phnum):
        off = phoff + i * phentsize
        p_type = struct.unpack_from("<I", raw, off)[0]
        if p_type == 3:  # PT_INTERP
            io_, sz = struct.unpack_from("<QQ", raw, off + 8)[0], struct.unpack_from("<Q", raw, off + 32)[0]
            interp = raw[io_:io_ + sz].rstrip(b"\0")
        elif p_type == 7:  # PT_TLS，p_align 在 +48
            tls_align = struct.unpack_from("<Q", raw, off + 48)[0]
    want_tls = MIN_TLS_ALIGN.get(e_machine)
    if e_type != 3:
        bad.append(f"{name}: e_type={e_type}，Android 只吃 ET_DYN(3)")
    elif interp != EXPECTED_INTERP:
        bad.append(f"{name}: 解释器是 {interp!r}，应为 {EXPECTED_INTERP!r}（Android 上没有 /lib/ld-linux-*）")
    elif want_tls is not None and (tls_align or 0) < want_tls:
        bad.append(f"{name}: PT_TLS p_align={tls_align}，bionic 要求 >= {want_tls}")
    else:
        checked += 1
        print(f"    ✓ {name}: ET_DYN + {interp.decode()} + TLS p_align={tls_align}")

if bad:
    print("\n".join("    ✗ " + b for b in bad), file=sys.stderr)
    sys.exit("android 产物形态不对，拒绝生成发布清单")
if checked == 0:
    sys.exit("没有找到任何 android 产物，构建清单不完整")
PY

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
