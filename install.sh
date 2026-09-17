#!/usr/bin/env bash
# dsh-plugin-mesh 本地安装 / 卸载
#
#   ./install.sh                    # 安装到 ~/.dsh/profiles/desktop
#   ./install.sh --uninstall        # 卸载
#   ./install.sh --profile web      # 装到别的 profile
#   ./install.sh --home /tmp/x      # 指定 DSH_HOME（测试用）
#   ./install.sh --dry-run          # 只看会做什么，不落盘
#
# 为什么是"复制"而不是软链：
#   DSH 的 profile 包解析器会拒绝 realpath 落在 <profile>/node_modules 之外的包
#   （module-resolution-*.js 里那条判断，防止陈旧的外部状态覆盖已封装安装）。
#   把插件软链到你的工作目录会被直接拒掉，启动时报 ERR_MODULE_NOT_FOUND。
#
# 安装后必须**重启 DSH Desktop** 才会加载。
set -euo pipefail

PROFILE="desktop"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DRY_RUN=0
UNINSTALL=0
PKG="dsh-plugin-mesh"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --home)    HOME_DIR="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall|--remove) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
DEST="$PROFILE_DIR/node_modules/$PKG"

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" = 1 ]; then say "  [dry-run] $*"; else eval "$*"; fi; }

# ── 前置检查 ──────────────────────────────────────────────────
if [ ! -f "$MANIFEST" ]; then
  say "✗ 找不到 profile 清单：$MANIFEST"
  say "  确认 profile 名字对不对（可用：ls $HOME_DIR/profiles）"
  say "  如果 DSH 装在别处，用 --home 指定 DSH_HOME"
  exit 1
fi
if [ ! -f "$SRC/package.json" ] || [ ! -f "$SRC/lib/index.js" ]; then
  say "✗ 这个脚本要从插件目录里运行（找不到 $SRC/lib/index.js）"
  exit 1
fi

# 改 package.json 用 python（避免 sed 改坏 JSON，也避免依赖 jq）
edit_manifest() {  # $1 = add | remove
  python3 - "$MANIFEST" "$PKG" "$1" "$DRY_RUN" <<'PY'
import json, sys, shutil, os
path, pkg, action, dry = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
with open(path, encoding="utf-8") as fh:
    raw = fh.read()
try:
    data = json.loads(raw)
except json.JSONDecodeError as exc:
    print(f"✗ {path} 不是合法 JSON：{exc}")
    sys.exit(1)
profile = data.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
if not isinstance(bundles, list):
    print("✗ dsh.profile.bundles 不是数组，请手动修改")
    sys.exit(1)

if action == "add":
    if pkg in bundles:
        print("  bundles 里已有该插件，跳过")
        sys.exit(0)
    bundles.append(pkg)
else:
    if pkg not in bundles:
        print("  bundles 里没有该插件，跳过")
        sys.exit(0)
    bundles.remove(pkg)

out = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
if dry:
    print("  [dry-run] 会把 bundles 改为: " + json.dumps(bundles, ensure_ascii=False))
    sys.exit(0)
shutil.copy2(path, path + ".bak")
with open(path, "w", encoding="utf-8") as fh:
    fh.write(out)
print("  bundles -> " + json.dumps(bundles, ensure_ascii=False))
print(f"  已备份原文件到 {os.path.basename(path)}.bak")
PY
}

# ── 卸载 ──────────────────────────────────────────────────────
if [ "$UNINSTALL" = 1 ]; then
  say "卸载 $PKG（profile=$PROFILE, home=$HOME_DIR）"
  if [ -d "$DEST" ]; then
    run "rm -rf '$DEST'"
    say "  ✓ 已删除 $DEST"
  else
    say "  插件目录不存在，跳过"
  fi
  edit_manifest remove
  say ""
  say "完成。重启 DSH Desktop 生效。"
  exit 0
fi

# ── 安装 ──────────────────────────────────────────────────────
say "安装 $PKG"
say "  源:     $SRC"
say "  目标:   $DEST"
say "  清单:   $MANIFEST"

if [ "$DRY_RUN" = 0 ]; then mkdir -p "$PROFILE_DIR/node_modules"; fi

# 1) 复制真实目录（先删旧的，避免残留已删除的文件）
if [ -d "$DEST" ]; then
  say "  检测到已安装，先移除旧版本"
  run "rm -rf '$DEST'"
fi
run "mkdir -p '$DEST'"
for item in lib client package.json cordis.patch.yml README.md LICENSE; do
  [ -e "$SRC/$item" ] || continue
  run "cp -R '$SRC/$item' '$DEST/'"
done
say "  ✓ 已复制插件文件"

# 2) 注册进 profile 的 bundles
say "  更新 bundles…"
edit_manifest add

say ""
say "完成。现在**重启 DSH Desktop**，重启后侧栏会出现 Mesh 图标。"
say ""
say "卸载：$0 --uninstall --profile $PROFILE"
