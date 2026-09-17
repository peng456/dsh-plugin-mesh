#!/usr/bin/env bash
# 搭建一个隔离的 DSH 测试环境来跑 dsh-plugin-mesh（不碰你日常使用的 profile）。
#
# 为什么要"复制"而不是软链：DSH 的 profile 包解析器会拒绝 realpath 落在
# <profile>/node_modules 之外的包（module-resolution-*.js 里那条判断）。
# 软链到工作区会被拒，所以这里把插件真实复制进 profile 的 node_modules。
#
# 用法:
#   ./dev-setup.sh [profile名] [home目录]
#
# 可用环境变量覆盖测试配置：
#   DSH_APP_DIR=...         手动指定 DSH 应用目录
#   MACHINE=winbox          对端列表里显示的机器名
#   PORT=45917              本机 mesh 端口
#   MULTICAST=false         关掉组播，只靠主动扫描
#   SCAN_PORTS="[45918]"    额外要扫的端口
#   SCAN_ON_START=true
#   PING_INTERVAL_MS=10000
#   REQUIRE_PAIRING=true
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${1:-meshtest}"
BASE="${2:-/tmp/dsh-mesh-dev}"

# ── 探测 DSH 应用目录 ──────────────────────────────────────────
detect_app_dir() {
  if [ -n "${DSH_APP_DIR:-}" ] && [ -f "$DSH_APP_DIR/lib/desktop-cli.js" ]; then
    echo "$DSH_APP_DIR"; return 0
  fi
  local cand
  for cand in \
    /Applications/"DSH Desktop"*.app/Contents/Resources/app \
    "$HOME"/Applications/"DSH Desktop"*.app/Contents/Resources/app
  do
    [ -f "$cand/lib/desktop-cli.js" ] && { echo "$cand"; return 0; }
  done
  return 1
}

if ! APPDIR="$(detect_app_dir)"; then
  echo "找不到 DSH 应用目录。用 DSH_APP_DIR 指定，例如：" >&2
  echo '  DSH_APP_DIR="/Applications/DSH Desktop 2.app/Contents/Resources/app" ./dev-setup.sh' >&2
  exit 1
fi
# 从 app 目录反推 .app 包名，拼出 Electron 可执行文件路径（仅用于打印提示）
APPBUNDLE="$(cd "$APPDIR/../../.." && pwd)"
BIN="$APPBUNDLE/MacOS/$(basename "$APPBUNDLE" .app)"
[ -x "$BIN" ] || BIN="<DSH Desktop 可执行文件>"

MACHINE="${MACHINE:-}"
PORT="${PORT:-45917}"
SCAN_PORTS="${SCAN_PORTS:-[]}"
MULTICAST="${MULTICAST:-true}"
REQUIRE_PAIRING="${REQUIRE_PAIRING:-false}"
SCAN_ON_START="${SCAN_ON_START:-true}"
PING_INTERVAL_MS="${PING_INTERVAL_MS:-10000}"

echo "插件:    $PLUGIN_DIR"
echo "应用:    $APPDIR"
echo "测试库:  $BASE/profiles/$PROFILE"
echo "machine=$MACHINE port=$PORT multicast=$MULTICAST pairing=$REQUIRE_PAIRING scanPorts=$SCAN_PORTS"

# 源依赖目录：用户真实 profile 的 node_modules（提供 @deepseek-ai/* 等）
SRC_MODULES="${DSH_HOME:-$HOME/.dsh}/profiles/node_modules"
if [ ! -d "$SRC_MODULES" ]; then
  echo "找不到 $SRC_MODULES —— 确认 DSH 已至少启动过一次。" >&2
  exit 1
fi

rm -rf "$BASE"
mkdir -p "$BASE/profiles/$PROFILE/node_modules"

# 1) 把共享 node_modules 逐个软链过来（复制整棵树太慢；解析器只看插件自己在不在
#    profile 的 node_modules 里，共享依赖用软链不影响）
for f in "$SRC_MODULES"/*; do
  ln -sfn "$f" "$BASE/profiles/$PROFILE/node_modules/$(basename "$f")"
done
echo "共享依赖: $(ls "$BASE/profiles/$PROFILE/node_modules" | wc -l | tr -d ' ') 项"

# 2) 真实复制插件本体（不带自己的 node_modules —— 依赖从上一层解析）
DEST="$BASE/profiles/$PROFILE/node_modules/dsh-plugin-mesh"
mkdir -p "$DEST"
cp -R "$PLUGIN_DIR/lib" "$PLUGIN_DIR/client" "$DEST/"
cp "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/cordis.patch.yml" "$DEST/"
echo "已复制插件 -> $DEST（$(find "$DEST" -type f | wc -l | tr -d ' ') 个文件）"

# 3) profile 清单：裸包名（真实安装形态），配合 dev-boot.mjs 安装的解析器
cat > "$BASE/profiles/$PROFILE/package.json" <<EOF
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": { "dsh-plugin-mesh": "*" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-mesh"],
      "patchReload": "startup"
    }
  }
}
EOF

# 4) 测试用的插件配置覆盖
cat > "$BASE/profiles/$PROFILE/cordis.patch.yml" <<EOF
- id: mesh
  config:
    machineName: '$MACHINE'
    port: $PORT
    scanPorts: $SCAN_PORTS
    useMulticast: $MULTICAST
    scanOnStart: $SCAN_ON_START
    pingIntervalMs: $PING_INTERVAL_MS
    requirePairing: $REQUIRE_PAIRING
EOF
echo "[]" > "$BASE/profiles/$PROFILE/cordis.yml"

echo
echo "启动:"
echo "  DSH_HOME=$BASE ELECTRON_RUN_AS_NODE=1 \\"
echo "    \"$BIN\" \"$PLUGIN_DIR/dev-boot.mjs\" --profile $PROFILE --port 8877"
