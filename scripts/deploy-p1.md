# P1/P1.5 部署与验收（dsh-go 真机）

> 前置：P1（权限修复+环境识别）与 P1.5（USB 传输）已提交到 E:\mesh git，工作区干净。
> 手机：Xiaomi 15 Ultra（serial 1441e87a），dsh-go 0.9.7，profile=web。
> 分发通道：PC `127.0.0.1:8792`（E:\mesh\dist 静态服务）+ `adb reverse tcp:8792 tcp:8792`。

## 0. 打包（只从 clean commit 打包，不要在 P1 中间态打包）
```powershell
cd E:\mesh
git status --short            # 必须干净（或只含 .tmp）
powershell -File E:\mesh\scripts\pack-plugin.ps1
Get-ChildItem E:\mesh\dist\*.tgz | Select-Object Name,Length,LastWriteTime
```

## 1. 部署到手机（经 mesh_run 让 dsh-go agent 执行；需要一次审批）
任务文本（thread 复用 `lead-dshgo-adapt`）：
```
【mesh 适配 · 安装补丁包（P1）。请原样执行 bash 并贴输出；不要动其它文件】
set -x
T=$(mktemp -d)
curl -fL --max-time 120 -o $T/mesh.tgz http://127.0.0.1:8792/dsh-plugin-mesh-0.5.4.tgz
ls -l $T/mesh.tgz
PLUGIN=/root/.dsh/profiles/web/node_modules/dsh-plugin-mesh
cp -a $PLUGIN ${PLUGIN}.bak-$(date +%Y%m%d-%H%M%S) || true
/usr/local/bin/dsh plugin --profile web add $T/mesh.tgz
ls -l $PLUGIN/lib/netinfo.js $PLUGIN/lib/dshgo.js $PLUGIN/lib/usb.js $PLUGIN/lib/inbound-preset.js 2>&1
node -e "console.log('plugin-version', require('$PLUGIN/package.json').version)"
node -e "console.log('loadable', Object.keys(require('$PLUGIN/lib/netinfo.js')).length>=1)"
完成一句话 OK。
```
> 若 `dsh plugin add` 因 registry 慢/失败：备用 `tar xzf $T/mesh.tgz -C /tmp && cp -a /tmp/package/lib/* $PLUGIN/lib/ …`（保留 ssh2 依赖不动），或先 `dsh plugin --profile web add dsh-plugin-mesh@0.5.4` 装官方版拿依赖再覆盖 lib/。

## 2. 重启引擎（无需用户点击）
```powershell
E:\AndroidSDK\platform-tools\adb.exe -s 1441e87a shell am force-stop io.github.ccch1mneyyy.dsh_app
Start-Sleep 2
E:\AndroidSDK\platform-tools\adb.exe -s 1441e87a shell am start -n io.github.ccch1mneyyy.dsh_app/.LauncherMist
Start-Sleep 25
```
> 已验证：force-stop+start 后 App 自动起引擎（proot+node），mesh 的 instanceId 不变（6e2c99cd5d31b00d）。

## 3. 验收矩阵
```powershell
# 桌面侧（本机 DSH 的 mesh 在 192.168.1.6:45917）
(Invoke-WebRequest -UseBasicParsing http://192.168.1.6:45917/mesh/v1/peers).Content | ConvertFrom-Json | % { $_.peers } | ft machine,host,port,transport,version
# 手机侧（经 adb forward）
E:\AndroidSDK\platform-tools\adb.exe -s 1441e87a forward tcp:45917 tcp:45917
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:45917/mesh/v1/health).Content
```
必须成立：
- [ ] 手机 health：`osInfo.platform === "android"`（或 os 以 android 开头）、`systems` 里同时有 Android host 与 Ubuntu runtime、`diag.net` 有 `source/macsAvailable`、`dshGo.isDshGo === true`、`sidecarTarget === "android/arm64"`
- [ ] 手机 health：`machine` 不再是 `localhost`（=设备型号/自定义名）、`fingerprint` 非空或显式说明
- [ ] 手机 health：`capabilities.cpuCores === 8`（或 >0）
- [ ] 桌面 peers：手机条目出现，且 **transport 含 `usb`**（USB 传输生效后）
- [ ] 手机 tasks：desktop 派发的任务 **不再停在「待确认」**，状态走到执行完成并回派（P1-0 `permissionPresetOnDshGo=danger-full-access` 生效）
- [ ] 关掉手机 Wi-Fi 后（可选），USB 传输仍能 dispatch（最强验收）

## 4. 配置（手机上，装完后由 agent 写入 profile patch）
> 注意：`cordis.patch.yml` 的 `config:` 是**整份替换**——合并而不是整块替换。
需要注入的键：
```yaml
- id: mesh
  config:
    # 现有键全部保留（从手机现有 patch 里读出再合并）
    permissionPresetOnDshGo: danger-full-access   # P1 新增（也可留空，靠 schema 默认；显式写更直观）
    staticPeers: ["<桌面IP>:45917"]               # 可选，USB/LAN 兜底
    sidecarPlatform: auto
    usbEnabled: true                               # P1.5 新配置（桌面侧才需要；手机侧无 adb 会 no-op）
```
手机侧实际只需 `permissionPresetOnDshGo`（若实现为默认值生效则无需写）。
桌面侧（E:\DSH-Home\profiles\desktop\cordis.patch.yml）加 `usbEnabled: true` 与 `adbPath`（若 PATH 里没有 adb）。

## 5. ui.json island（零代码，让 mesh 面板进手机原生侧栏）
```bash
# 手机 agent 执行
mkdir -p /root/.dsh/dsh-go
cat > /root/.dsh/dsh-go/ui.json <<'EOF'
{ "version": 1, "plugins": { "seats": { "sidebar.panellist": { "dsh-plugin-mesh": "island" } } } }
EOF
cat /root/.dsh/dsh-go/ui.json
```
生效 1~2 秒（免重启）；回滚：删掉该键或 App 设置里「来自 ui.json → 恢复默认」。
（示例 JSON 已用 APK 内官方 checker 离线校验通过：`ui.json：已应用 1 项`）

## 6. 回滚
```bash
PLUGIN=/root/.dsh/profiles/web/node_modules/dsh-plugin-mesh
rm -rf $PLUGIN && mv ${PLUGIN}.bak-<ts> $PLUGIN
# 或 dsh plugin --profile web add dsh-plugin-mesh@0.5.4
```
然后 adb force-stop/start 重启引擎。
