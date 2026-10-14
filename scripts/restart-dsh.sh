#!/bin/bash
# DSH Desktop 延迟重启（由 launchd 托管的一次性任务）
#
# 为什么需要延迟：改完插件必须重启 DSH 才生效，但重启会杀掉发起这件事的那条
# 会话，回复就送不出去了。所以先等一会儿，让回复送达，再重启。
#
# 为什么要交给 launchd：重启要杀掉 DSH 自己；脚本若还是 DSH 的子进程就会跟着死，
# 永远走不到"重新打开"那一步。交给 launchd 后脚本归系统所有，应用退出不影响它。
#
# 流程：等待 → 优雅退出 → 降级强杀 → 重新打开 → 自检插件 → 清理自身
#
# 用法：
#   scripts/restart-dsh.sh --install [延迟秒数]   # 装成 launchd 一次性任务，立即生效
#   scripts/restart-dsh.sh                        # 直接跑（前台，会等你指定时长）
#
# 装的时候会把自己复制到 ~/.dsh/ ，再写 plist 并 bootstrap。

set -uo pipefail

LOG="$HOME/.dsh/mesh-restart.log"
LABEL="com.dsh.mesh-restart"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SELF_DEST="$HOME/.dsh/mesh-restart.sh"
DELAY="${MESH_RESTART_DELAY:-45}"

# ── 探测该重启哪个 .app ────────────────────────────────────────
#
# 机器上可能并存多个 .app（实测 /Applications/DSH Desktop.app v2.0.13 与
# /Applications/DSH Desktop 2.app v2.0.10）。写死路径或按字母序取第一个都会
# 选错 —— 那样"重启"会去关一个没在运行的 app，再开一个用户没在用的旧版本。
# 所以：优先正在运行的那个，否则取版本号最高的。
detect_app() {
  local running bundle best="" best_ver="" ver
  running="$(ps -eo command= 2>/dev/null | grep -oE '/Applications/DSH Desktop[^/]*\.app/Contents/MacOS/' | head -1)"
  if [ -n "$running" ]; then
    printf '%s' "${running%/Contents/MacOS/}"
    return 0
  fi
  for bundle in /Applications/"DSH Desktop"*.app "$HOME"/Applications/"DSH Desktop"*.app; do
    [ -d "$bundle" ] || continue
    [ -f "$bundle/Contents/Resources/app/lib/desktop-cli.js" ] || continue
    ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
           "$bundle/Contents/Resources/app/package.json" 2>/dev/null | head -1)"
    [ -n "$ver" ] || ver="0"
    if [ -z "$best_ver" ] || [ "$(printf '%s\n%s\n' "$best_ver" "$ver" | sort -V | tail -1)" = "$ver" ]; then
      best="$bundle"; best_ver="$ver"
    fi
  done
  [ -n "$best" ] && printf '%s' "$best"
}

# ── --install：装成 launchd 任务 ───────────────────────────────
if [ "${1:-}" = "--install" ]; then
  [ -n "${2:-}" ] && DELAY="$2"
  mkdir -p "$HOME/.dsh" "$HOME/Library/LaunchAgents"
  # 复制自身，否则脚本留在工作目录里，工作目录一移动任务就失效
  if [ "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" != "$SELF_DEST" ]; then
    cp "$0" "$SELF_DEST"
    chmod +x "$SELF_DEST"
  fi
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SELF_DEST</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>MESH_RESTART_DELAY</key><string>$DELAY</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
  echo "✓ 已安排：${DELAY}s 后重启 DSH Desktop"
  echo "  日志：$LOG"
  exit 0
fi

APP="$(detect_app)"
[ -n "$APP" ] || APP="/Applications/DSH Desktop.app"

# 可执行文件名不等于 .app 名：DSH Desktop 2.app 里的可执行文件就叫 "DSH Desktop"。
# 所以从 Info.plist 读，别用 basename 拼。
BUNDLE_EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null)"
[ -n "$BUNDLE_EXE" ] || BUNDLE_EXE="DSH Desktop"
EXE="$APP/Contents/MacOS/$BUNDLE_EXE"

# 不用 pgrep：这台机器上 pgrep -f 对带空格的长路径匹配不到主进程（helper 能匹配到）。
# ps 整行精确匹配可靠 —— 主进程没有参数，命令行就是裸路径。
app_running() { ps -eo command= | grep -Fqx "$EXE"; }

{
  echo "=== $(date '+%F %T') 延迟重启开始（等 ${DELAY}s 让会话回复先送达）==="
  echo "目标: $APP"
  sleep "$DELAY"

  if ! app_running; then
    echo "$(date '+%T') DSH Desktop 已不在运行，直接打开"
  else
    echo "$(date '+%T') 请求优雅退出（AppleScript）"
    osascript -e "tell application \"$APP\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      app_running || break
      sleep 0.5
    done

    if app_running; then
      echo "$(date '+%T') 优雅退出超时，发 SIGTERM"
      pkill -TERM -f "$EXE" 2>/dev/null || true
      for _ in $(seq 1 20); do
        app_running || break
        sleep 0.5
      done
    fi

    if app_running; then
      echo "$(date '+%T') 仍未退出，SIGKILL"
      pkill -9 -f "$EXE" 2>/dev/null || true
      sleep 2
    fi
    app_running \
      && echo "$(date '+%T') ! 进程仍活着，后面的 open 可能只是切前台" \
      || echo "$(date '+%T') 已退出"
  fi

  # 等端口释放，避免新实例抢不到 43120
  sleep 2
  echo "$(date '+%T') 重新打开 DSH Desktop"
  open -a "$APP"

  # 等它起来，顺便确认插件加载了（apply 跑过就会写 state.json），并报出版本
  sleep 25
  if [ -f "$HOME/.dsh/mesh/state.json" ]; then
    echo "$(date '+%T') [OK] mesh 插件已加载"
  else
    echo "$(date '+%T') [FAIL] 没看到 state.json —— 插件可能没加载"
  fi
  INST="$HOME/.dsh/profiles/${DSH_PROFILE:-desktop}/node_modules/dsh-plugin-mesh/package.json"
  if [ -f "$INST" ]; then
    ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INST" | head -1)"
    echo "$(date '+%T') [OK] 已安装插件版本 $ver"
  fi
  app_running \
    && echo "$(date '+%T') [OK] DSH Desktop 进程在运行" \
    || echo "$(date '+%T') [FAIL] DSH Desktop 没起来，可能需要手动打开"
  echo "=== $(date '+%F %T') 完成 ==="

  # 清理自身，避免每次登录都重跑
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null \
    || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
} >> "$LOG" 2>&1
