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

# ── --check-only：只跑重启前检查，绝不碰 DSH ──────────────────
#
# 为什么需要它：否则"验证这个脚本"和"真的重启一次"没法分开，而重启会杀掉
# 正在验证它的那条会话 —— 结果是没人会去验证它。实测就是这么漏掉一个
# `unbound variable`（脚本在杀 DSH 之前 abort，日志里只有一行，看起来像
# "重启了但没生效"）。
CHECK_ONLY=0
if [ "${1:-}" = "--check-only" ]; then
  CHECK_ONLY=1
  DELAY=0
  shift || true
fi

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

  # ── 重启**之前**：磁盘上的插件必须真的能被加载 ──
  #
  # 这是下面"进程自述版本"那条的**互补轴**，缺一不可：
  #   · 这里挡的是**半态**（package.json/index.js 已是新版，但 lib/prompt.js
  #     之类还没拷进来）→ 进程 import 时 ERR_MODULE_NOT_FOUND 当场崩；
  #   · 下面那条挡的是"加载了但不是新代码"。
  # 只做下面那条会放过半态（version 会**正确地**报新版本、检查放行，然后崩）。
  #
  # 语义上刻意**只警告不中止**：DSH 此刻可能正跑得好好的，磁盘半态并不影响
  # 它。为了"磁盘可疑"就拒绝重启、把用户卡在旧代码上，弊大于利。但**必须**
  # 把话说清楚，否则用户会以为重启成功了。
  #
  # ⚠️ 门禁脚本从**插件自己的安装树**里取（`$INST_PLUGIN/scripts/`），不要用
  # 仓库路径。踩过：这里原本写 `$REPO_ROOT/scripts/...`，而 REPO_ROOT 在这个
  # 脚本里**从来没有定义过** —— 本脚本会被 `--install` 复制到 ~/.dsh/ 下运行，
  # 那时更没有"仓库"。`set -u` 让它在**杀掉 DSH 之前**直接 abort，于是
  # "延迟重启"变成静默不重启（日志里只有一行 unbound variable）。
  # `bash -n` 查不出这种错（只看语法），必须真跑一次。
  INST_PLUGIN="$HOME/.dsh/profiles/${DSH_PROFILE:-desktop}/node_modules/dsh-plugin-mesh"
  LOADABLE="$INST_PLUGIN/scripts/check-loadable.mjs"
  if [ ! -f "$LOADABLE" ]; then
    # **必须说出来**。以前这里是静默跳过，于是"门禁已接上"是个假象 ——
    # 安装树里没有 scripts/（install.sh 漏拷），门禁从来没跑过。
    echo "$(date '+%T') [WARN] 找不到半态门禁（$LOADABLE）—— 这一次**没有做**可加载性校验"
  elif [ -d "$INST_PLUGIN" ]; then
    if node "$LOADABLE" "$INST_PLUGIN" >/tmp/mesh-loadable.$$ 2>&1; then
      echo "$(date '+%T') [OK] 安装路径可加载（半态门禁通过）"
    else
      echo "$(date '+%T') [WARN] 安装路径**不可加载** —— 重启后插件会加载失败："
      sed 's/^/    /' /tmp/mesh-loadable.$$ | head -12
      echo "$(date '+%T') [WARN] 先补齐文件或回滚，再重启"
    fi
    rm -f /tmp/mesh-loadable.$$
  fi

  # `--check-only`：只做上面这些重启前检查就退出，**绝不碰 DSH**。
  # 存在的理由很直接：否则"验证这个脚本"和"真的重启一次"就没法分开，
  # 而重启会杀掉正在验证它的那条会话 —— 于是没人会去验证它（上面那个
  # unbound variable 就是这么漏过去的）。
  if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "$(date '+%T') --check-only：检查完毕，不重启（当前 pid [${pid_before:-无}]）"
    exit 0
  fi

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
    echo "$(date '+%T') 磁盘上的插件版本 $ver"
  fi

  # ── 决定性自检：问**运行中的进程**自己是什么版本 ──
  #
  # 上面那行读的是**磁盘**上的 package.json（原来自称"已安装插件版本"，其实
  # 跟进程无关）；"已重启"只证明**有个进程起来了**，不证明它加载的是新代码；
  # instanceIds 是**落盘持久**字段，上一版写进去的会一直留在 state.json 里，
  # 于是 grep 恒真。三个都不构成"新代码在跑"的证据。
  #
  # 踩过：升级窗口里磁盘 16:11:06 就是 0.3.28、进程到 16:14:06 才换 —— 那段
  # 时间日志里三行全是绿的，但跑的还是旧码。VERSION 是**启动时冻结**的常量，
  # 所以"进程自述的版本"才是唯一硬证据，而它只有 /mesh/v1/health 给得出。
  #
  # ⚠️ **只许比 version，绝不把 capabilities 拉进来"求更严"。**
  # 能力块（gpu / runtimes / capabilitiesAt）是**热刷新**的，与重启完全解耦：
  # 实测同一个 pid 在不重启的情况下 capabilitiesAt 一路前进，而 version 纹丝不动。
  # 把能力字段纳入比对会造成**反向误诊** —— 对端 hos 给过反例：它进程是 0.3.27
  # 旧码，但"磁盘代码采出的 gpu"与"进程报的 gpu"都是 null，两者相等 → 会误判成
  # "新码已加载"。**能力相等什么都证明不了。**
  #
  # 另一头：本检查**覆盖不到"半加载"**（package.json/index.js 已是新版本、
  # 但 lib/prompt.js 还没拷进来）。那种情况下 version 会**正确地**报新版本、
  # 这里会放行，而进程 import 时直接 ERR_MODULE_NOT_FOUND 崩掉。
  # 兜住那一类的是**重启前**的 `scripts/check-loadable.mjs`（从安装路径真 import
  # 一次入口）。两条是**互补的两轴**：① 重启前排除半加载 ② 重启后证明加载了当前磁盘。
  # 只做 ② 会漏半加载；只做 ① 会漏"加载了但没重启"。缺一不可。
  PORT="${MESH_PORT:-45917}"
  up=""
  for _ in $(seq 1 30); do
    up="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/mesh/v1/health" 2>/dev/null)" && [ -n "$up" ] && break
    up=""
    sleep 1
  done

  if [ -z "$up" ]; then
    echo "$(date '+%T') [WARN] 读不到 /mesh/v1/health，无法确认**进程**版本（磁盘=${ver:-未知}）"
  else
    # 不依赖 node：优先 python3 解 JSON，退回到正则抠 version 字段
    pver="$(printf '%s' "$up" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null)"
    if [ -z "$pver" ]; then
      pver="$(printf '%s' "$up" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    fi
    echo "$(date '+%T') [OK] 运行中进程自述版本 $pver"
    if [ -n "$ver" ] && [ "$pver" != "$ver" ]; then
      echo "$(date '+%T') [WARN] 进程 $pver ≠ 磁盘 $ver —— 新代码**没**被加载，检查 plugins 挂载"
    fi
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
