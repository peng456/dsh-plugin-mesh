# dsh-go 部署手册（mesh 插件�?
## 拓扑
```
[本机 Windows]                                   [手机 Xiaomi 15 Ultra / dsh-go]
E:\mesh\dsh-plugin-mesh  --npm pack-->  dist/*.tgz
python -m http.server 8792  <--adb reverse tcp:8792 -->  手机 127.0.0.1:8792
                                                          agent bash: curl http://127.0.0.1:8792/mesh.tgz
                                                          /root/.dsh/profiles/web/node_modules/dsh-plugin-mesh
```
- 手机 dsh-go �?DSH profile = **web**，插件目录：`/root/.dsh/profiles/web/node_modules/<pkg>`，mesh 状态目�?`/root/.dsh/profiles/web/mesh/`
- 引擎进程：`node --import=/opt/dsh-go/boot-cache.mjs /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web ... --host 127.0.0.1 --port 3080`
- 需要重启引擎才能加�?host 侧改动（App 里「设置→本机引擎→重启」一键）

## 一次性准�?```powershell
# 1) 打包（产�?E:\mesh\dist\dsh-plugin-mesh-0.5.4.tgz�?powershell -File E:\mesh\scripts\pack-plugin.ps1

# 2) 起本�?HTTP 分发�?27.0.0.1:8792�?powershell -File E:\mesh\scripts\serve-dist.ps1

# 3) 反向端口映射（手�?localhost:8792 �?PC 127.0.0.1:8792�?E:\AndroidSDK\platform-tools\adb.exe -s 1441e87a reverse tcp:8792 tcp:8792
```

## 手机端安装（通过 mesh 派发�?dsh-go agent 执行�?�?agent 的任务文本（换成实际版本�?路径）：

```
【mesh 适配 · 插件升级任务，请原样执行 bash 并贴出输出�?set -x
T=$(mktemp -d)
curl -fL --max-time 120 -o $T/mesh.tgz http://127.0.0.1:8792/dsh-plugin-mesh-0.5.4.tgz
ls -l $T/mesh.tgz
PLUGIN=/root/.dsh/profiles/web/node_modules/dsh-plugin-mesh
cp -a $PLUGIN ${PLUGIN}.bak-$(date +%s) 2>/dev/null || true
/usr/local/bin/dsh plugin --profile web add $T/mesh.tgz
ls -l $PLUGIN/lib/netinfo.js $PLUGIN/package.json
node -e "const p=require('$PLUGIN/package.json');console.log('version',p.version)"
```

安装完成�?*重启引擎**：App 里「设�?�?本机引擎 �?重启」（用户点一下，�?USB 安全调试开了以后由 Lead 点）�?重启后自检�?```powershell
powershell -File E:\mesh\scripts\probe-phone-mesh.ps1
```
- 期望 `/mesh/v1/health` 里多�?`netinfo` 诊断（P0 生效后），`/mesh/v1/peers` 能看到桌面�?- 桌面 `mesh_peers` 能看到手机（名字应该不再�?localhost，P1 生效后）�?
## 回滚
```bash
PLUGIN=/root/.dsh/profiles/web/node_modules/dsh-plugin-mesh
rm -rf $PLUGIN && mv ${PLUGIN}.bak-<ts> $PLUGIN
# �?npm/pnpm 装回官方版：dsh plugin --profile web add dsh-plugin-mesh@0.5.4
```

## 注意
- 不要�?`/root/.dsh/profiles/web/mesh/state.json`（设备身�?UUID）；升级只换 node_modules 里的包�?- 升级�?mesh 的自�?`machine` 若变，是预期的（P1 �?osInfo/命名）；`id` 不变�?- �?`dsh plugin add` �?registry 失败：备用方�?`tar xzf` 解压到插件目�?+ 手动保证 `ssh2` 依赖存在（`dsh plugin add dsh-plugin-mesh@0.5.4` 先装一次可得到依赖）�?
