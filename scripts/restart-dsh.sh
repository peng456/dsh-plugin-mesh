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
# 「这个 .app 是否在运行」用多路检测，只要任一路看到就认为在运行。
#
# 为什么不能只认主进程的完整可执行路径：实测出现过「明明在运行却被判定为
# 没运行」——于是脚本走"已不在运行，直接打开"分支，`open -a` 只是把它切到
# 前台，重启被静默跳过，用户以为重启了其实没有。
# 这个方向的误判代价很高（修复没生效却以为生效了），所以宁可宽松：
# bundle 下任何进程（主进程或 helper）都算在运行。
app_pids() {
  {
    # 1) pgrep 匹配 bundle 内的可执行目录
    pgrep -f "$APP/Contents/MacOS" 2>/dev/null
    # 2) ps 兜底：排除掉管道自身的 awk/grep/ps，避免误报
    ps -eo pid=,comm=,command= 2>/dev/null \
      | awk -v p="$APP/Contents/MacOS" '$2 !~ /^(awk|grep|ps|bash|sh|zsh)$/ && index($0, p) {print $1}'
  } | grep -E '^[0-9]+$' | sort -u
}
app_running() { [ -n "$(app_pids)" ]; }
app_pid_list() { app_pids | tr '\n' ' '; }

{
  echo "=== $(date '+%F %T') 延迟重启开始（等 ${DELAY}s 让会话回复先送达）==="
  echo "目标: $APP"
  echo "可执行: $EXE"
  sleep "$DELAY"

  # 诊断：launchd 环境与交互 shell 不同，万一判定出错，这两行能直接说明原因
  echo "$(date '+%T') env: PATH=$PATH"
  echo "$(date '+%T') ps 可见进程数: $(ps -eo command= 2>&1 | wc -l | tr -d ' ')"

  # ── 用 PID 变化作为"到底重启成功没有"的硬证据 ──
  #
  # 不再用"当前是否在运行"来决定分支：那个判断实测出现过误判（明明在运行却
  # 判成没运行），于是脚本走"直接打开"分支、`open -a` 只把窗口切到前台，
  # 重启被静默跳过 —— 用户以为生效了其实没有，这比报错更糟。
  # 现在无论如何都先记录 PID，重启后再比一次；只要 PID 没变就明确报 FAIL。
  pid_before="$(app_pid_list)"
  echo "$(date '+%T') 重启前 pid: [${pid_before:-无}]"

  if [ -z "$pid_before" ]; then
    echo "$(date '+%T') 没检测到在运行的实例，直接打开"
  else
    echo "$(date '+%T') 请求优雅退出（AppleScript）"
    osascript -e "tell application \"$APP\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do
      [ -z "$(app_pid_list)" ] && break
      sleep 0.5
    done

    if [ -n "$(app_pid_list)" ]; then
      echo "$(date '+%T') 优雅退出超时，SIGTERM（只针对记录的 pid）"
      # shellcheck disable=SC2086
      kill -TERM $pid_before 2>/dev/null || true
      for _ in $(seq 1 20); do
        [ -z "$(app_pid_list)" ] && break
        sleep 0.5
      done
    fi

    if [ -n "$(app_pid_list)" ]; then
      echo "$(date '+%T') 仍未退出，SIGKILL"
      # shellcheck disable=SC2086
      kill -9 $pid_before 2>/dev/null || true
      sleep 3
    fi
    echo "$(date '+%T') 退出后残留 pid: [$(app_pid_list)]"
  fi

  # 等端口释放，避免新实例抢不到 43120
  sleep 2
  echo "$(date '+%T') 重新打开 DSH Desktop"
  open -a "$APP"

  pid_after=""
  for _ in $(seq 1 45); do
    sleep 1
    pid_after="$(app_pid_list)"
    [ -n "$pid_after" ] && break
  done
  echo "$(date '+%T') 重启后 pid: [${pid_after:-无}]"

  if [ -z "$pid_after" ]; then
    echo "$(date '+%T') [FAIL] 没有新实例起来，请手动打开 DSH Desktop"
  elif [ "$pid_after" = "$pid_before" ]; then
    echo "$(date '+%T') [FAIL] PID 没变（$pid_before）—— 只是切了前台，并没有重启"
  else
    echo "$(date '+%T') [OK] 已重启：[$pid_before] → [$pid_after]"
  fi

  # 插件有没有真的换上新代码：新版会把 instanceId 持久化，这是可判定的证据
  sleep 20
  if grep -q '"instanceIds"' "$HOME/.dsh/mesh/state.json" 2>/dev/null; then
    echo "$(date '+%T') [OK] 新代码已生效（state.json 出现 instanceIds）"
  else
    echo "$(date '+%T') [WARN] state.json 里没有 instanceIds —— 插件可能仍是旧代码"
  fi
  INST="$HOME/.dsh/profiles/${DSH_PROFILE:-desktop}/node_modules/dsh-plugin-mesh/package.json"
  if [ -f "$INST" ]; then
    ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INST" | head -1)"
    echo "$(date '+%T') 已安装插件版本 $ver"
  fi
  app_running \
    && echo "$(date '+%T') [OK] DSH Desktop 在运行" \
    || echo "$(date '+%T') [FAIL] DSH Desktop 没起来，可能需要手动打开"
  echo "=== $(date '+%F %T') 完成 ==="

  # 清理自身，避免每次登录都重跑
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null \
    || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
} >> "$LOG" 2>&1
