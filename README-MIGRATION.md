# mesh 鈫?dsh-go 杩佺Щ鎶ュ憡锛堣繘琛屼腑锛?026-10-29 01:45锛?
> 鐩爣锛氭妸 `dsh-plugin-mesh` 瀹屽叏閫傞厤 **dsh-go**锛圓ndroid 15 鎵嬫満 App锛宲root Ubuntu 24.04 閲岃窇 DSH 0.2.1-rc.2 + Node 24.22.1锛夛紝鍋氬埌銆屾闈㈡淳浠诲姟鍒版墜鏈鸿嚜鍔ㄦ墽琛屻€佷笉闇€瑕佷汉褰撲腑闂翠汉銆嶃€?> 宸ヤ綔鍖猴細`E:\mesh`锛涜澶囷細Xiaomi 15 Ultra锛坄1441e87a`锛孉ndroid 15 / arm64锛宒sh-go 0.9.7锛宲rofile=`web`锛夈€?
## 1. 缁撹鍏堣锛堝凡杈炬垚锛?
| 鑳藉姏 | 鐘舵€?| 璇佹嵁 |
|---|---|---|
| dsh-go 閲岃窇閫?mesh 鑺傜偣 | 鉁?| `/mesh/v1/health` 200锛歚version 0.5.4`銆乣host 192.168.1.19` |
| dsh-go 鐜璇嗗埆锛圓ndroid 瀹夸富 + proot runtime锛?| 鉁?| health锛歚os: "android 15 (6.6.30-android15鈥?"`锛沗diag.dshGo.isDshGo=true`锛? 椤硅瘉鎹級锛沗diag.sidecarTarget.asset=dsh-mesh-tsnet-android-arm64.gz` |
| **鍏ョ珯浠诲姟鑷姩鎵ц锛堟秷鐏腑闂翠汉锛?* | 鉁?| health锛歚diag.inboundPermissionPreset=danger-full-access`銆乣source=dsh-go`锛涘疄娴嬫淳鍙戝崌绾т换鍔″悗**鎵嬫満鏃犱汉宸ョ‘璁?*鐩存帴鎵ц锛?1:37:47 鎵嬫満浠?`127.0.0.1:8792` 鎷夊彇 tarball 200锛?|
| 缃戝崱/鍦板潃閲囬泦鍏滃簳 | 鉁?| health锛歚diag.net.source=os`銆乣macsAvailable=false` + `MAC_UNAVAILABLE`锛圫ELinux 鎷?SIOCGIFHWADDR 鐨勬樉寮忚〃杈撅紝涓嶅啀浼鎴?娌℃湁缃戝崱"锛?|
| 妗岄潰 鈫?鎵嬫満鍙戠幇 | 鉁?| 妗岄潰 `/mesh/v1/peers` 鐪嬪埌 `localhost 192.168.1.19:45917 online=true`锛涙墜鏈?peers 鐪嬪埌妗岄潰 |
| **涓婃父 bug 淇锛堢湡鏈轰簨鏁咃級** | 鉁?| 0.5.4 鐨?package.json 缂?`@deepseek-ai/dsh-brand` peer锛岃€?`lib/index.js` import 瀹?鈫?dsh-go 鍔犺浇鍣ㄤ笉鎷︽埅 鈫?`ERR_MODULE_NOT_FOUND` 鈫?**鏁翠釜鎻掍欢 import 澶辫触**銆傚凡琛?peer + `scripts/check-peerdeps.mjs` 闂ㄧ锛堥槻鍥炲綊锛?|
| USB/adb 浼犺緭閫傞厤锛堟闈㈢粡 adb forward 鐩磋繛鎵嬫満 mesh锛?| 鉁?妯″潡绾э紙鐪熸満鍐掔儫閫氳繃锛?| `lib/usb.js` 24 绂荤嚎鐢ㄤ緥鍏ㄧ豢锛涚湡鏈哄啋鐑燂細璇嗗埆 `1441e87a` 鈫?澶嶇敤 forward 鈫?`GET /mesh/v1/health` 鈫?endpoint `usb:1441e87a`锛沗stop()` 淇濈暀澶嶇敤鏄犲皠銆傛帴绾垮凡杩?`lib/index.js`/`diagnostics`锛坄diag.usb`锛夛紝妗岄潰渚ч渶瑁呮柊鎻掍欢鍚庣敓鏁?|

## 2. 浠ｇ爜锛坓it锛宍E:\mesh`锛?
| commit | 鍐呭 |
|---|---|
| `da528da` | baseline锛歞sh-plugin-mesh 0.5.4 + 鍒嗘瀽/閮ㄧ讲鑴氭湰 |
| `6855343` | **P0**锛歚lib/netinfo.js`锛堝洓绾у湴鍧€鍏滃簳銆佹案涓嶆姏銆乻ource/errors 鍙瀵燂級銆乻can 鍏滃簳銆乣staticPeers` / `advertiseAddress` / `sidecarPlatform` 閰嶇疆 |
| `383b7c8` | **P1**锛歚lib/dshgo.js` 鐜鎺㈡祴锛沷sinfo=Android 瀹夸富+proot runtime锛沬dentity/cpuCores 鍏滃簳锛泃snet 璧勪骇閫夋嫨锛坙inux+dshGo鈫抋ndroid/arm64锛夛紱`permissionPresetOnDshGo` + `lib/inbound-preset.js` |
| `9aa8359` | **P1.5**锛歚lib/usb.js`锛圲SB/adb 浼犺緭锛?4 鑷祴锛? 璁捐鏂囨。 |
| `8ff25a2` | **P1.5 鎺ョ嚎**锛歚index.js` schema/apply/health diag + diagnostics锛坄selftest:usb-integration` 17/17锛?|
| `9e6816b` | dsh-go 涓?*榛樿** `danger-full-access`锛堟棤闇€鏀归厤缃紱妗岄潰闆跺彉鍖栵級+ 鐗堟湰 `0.5.4-dshgo.1` |
| `e2e4cd4` | **淇 peer 缂哄け**锛坉sh-brand锛? `check-peerdeps` 闂ㄧ + 鐗堟湰 `0.5.4-dshgo.2` |

娴嬭瘯锛歚npm test` 鍏ㄧ豢锛坣etinfo 28 / dshgo 22 / inbound-preset 13 / usb 24 / usb-integration 17 / tsnet 74 / caps 78 / osinfo 26 / 鈥︼級锛宍npm run check` 鍚柊 peer 闂ㄧ鍏ㄧ豢銆?
浜х墿锛歚E:\mesh\dist\dsh-plugin-mesh-0.5.4-dshgo.2.tgz`锛?66,959 B锛夈€?
## 3. 閮ㄧ讲/鍥炴粴

- 涓€閿儴缃诧紙鎵嬫満 guest 鍐?bash锛夛細`E:\mesh\scripts\deploy-task-v2.txt`锛堝惈澶囦唤銆乴oadable 鑷銆乧url 鍏滃簳锛?- 閫氶亾锛歚adb reverse tcp:8792 tcp:8792` + PC `E:\mesh\dist` 闈欐€佹湇鍔★紙`scripts/serve-dist.ps1`锛?- 閲嶅惎寮曟搸锛歚adb shell am force-stop io.github.ccch1mneyyy.dsh_app && am start -n 鈥?.LauncherMist`锛堟棤闇€鐐瑰嚮锛屽凡楠岃瘉锛?- 鍥炴粴锛氭崲鍥?`${PLUGIN}.bak-*` / `${PLUGIN}.bak2-*`锛宲rofile patch 鎹㈠洖 `.bak-*`锛岄噸鍚紩鎿?- 閰嶇疆锛?*鏃犻渶浠讳綍閰嶇疆**锛?.5.4-dshgo.2 鍦?dsh-go 涓婅嚜鍔?`danger-full-access`锛屾闈㈣涓轰笉鍙橈級

## 4. 鍏抽敭浜嬪疄锛堢湡鏈猴級

- dsh-go锛歚process.platform==="linux"`銆乣os.release()` 鍚?`android15`銆乣hostname=localhost`銆乣/etc/machine-id` 绌恒€乣/system/build.prop` 瀛樺湪銆乣getprop` 涓嶅湪 PATH锛堢敤 `/system/bin/getprop`锛?- `os.networkInterfaces()` **姝ｅ父**锛坵lan0 绛?7 涓綉鍗★紝MAC 鍏?0 鍥?SELinux 鎷?`SIOCGIFHWADDR`锛夛紱`os.cpus().length=0` 浣?`availableParallelism=8`锛堝凡鍦?P1 淇級
- DSH 鎻掍欢鍔犺浇鍣細鍙嫤鎴彃浠?package.json 閲?*澹版槑杩囩殑 peer**锛涙紡澹版槑 鈫?鍘熺敓瑙ｆ瀽 鈫?缂哄寘 鈫?鏁翠釜鎻掍欢 import 澶辫触锛堟湰娆′簨鏁呮牴鍥狅級
- 鍏ョ珯浼氳瘽鏉冮檺锛歮esh 鍘熸潵鎭掑畾 `workspace-write`锛沝sh-go 鐨?proot 鏃犳矙绠卞悗绔?鈫?`sandbox+approval:ask` 鈫?姣忎釜浠诲姟鍗°€屽緟纭銆嶏紱`danger-full-access` 鎵嶆嬁鍒?`approval:"never"`

## 5. 寰呮敹灏撅紙闃诲鍦ㄨ澶囪繛閫氭€э級

- [ ] 鎵嬫満閲嶈繛锛圲SB 绋冲畾 + 涓?PC 鍚岀綉娈碉級鈫?閲嶅惎寮曟搸 鈫?纭 `version=0.5.4-dshgo.2`銆乨iag 淇濇寔銆佷换鍔¤嚜鍔ㄦ墽琛屼笉琚‘璁ゆ墦鏂?- [ ] 鍙屽悜 `mesh_run` 鍚勪竴娆★紙妗岄潰鈫掓墜鏈恒€佹墜鏈衡啋妗岄潰锛夌暀璇佹嵁
- [ ] 鍏?Wi-Fi 鍚?USB 閫氶亾娲惧彂锛堟渶寮洪獙鏀讹紝闇€瑕佹闈晶瑁呮柊鎻掍欢锛?- [ ] ui.json island 闆朵唬鐮佸祵鍏ワ紙闇€瑕?guest 鍐欏叆 `/root/.dsh/dsh-go/ui.json`锛?- [ ] 妗岄潰渚у畨瑁呴€傞厤鐗堟彃浠讹紙鍙€夛細闇€閲嶅惎妗岄潰 DSH锛屼細鏂紑褰撳墠浼氳瘽锛?

## 6. 最终验证证据（2026-10-29 02:0x，真机）

### 6.1 版本与能力（手机 /mesh/v1/health）
- `version: 0.5.4-dshgo.2`
- `os: "android 15 (6.6.30-android15-8-g8a843ce91753-abogki383952401-4k)"`（Android 宿主已识别）
- `diag.dshGo.isDshGo=true`，7 项证据（env /opt/dsh-go /etc/dsh-app 内核串 build.prop getprop /dev/__properties__）
- `diag.sidecarTarget = android/arm64`（`dsh-mesh-tsnet-android-arm64.gz`）
- `diag.net.source="os"`、`macsAvailable=false` + `MAC_UNAVAILABLE`（显式表达，不是"没网卡"）
- `capabilities.cpuCores=8`（修好 0）
- `diag.inboundPermissionPreset="danger-full-access"`、`source="dsh-go"`
- 桌面 `/mesh/v1/peers`：`localhost 192.168.1.19:45917 online=true transport=lan`，版本 `0.5.4-dshgo.2`
- 手机 `/mesh/v1/peers`：`Rosmontis喵 192.168.1.6:45917 online=true transport=lan`

### 6.2 双向派发 E2E（无人工确认）
- 桌面 → 手机：`mesh_run(phone, ...)` → 手机 agent **自动执行**（无「待确认」）：
  - `E2E_OK 1793210436656`
  - `Linux localhost 6.6.30-android15… aarch64`（proot Ubuntu）
  - `PLUGIN 0.5.4-dshgo.2`
  - 回执回到桌面（task `t-4ec24aa23354`, status noted-only）
- 手机 → 桌面：手机 agent 调 `mesh_run(Rosmontis喵, thread=e2e-reverse)` → 桌面收到入站任务 `t-83633c66cdef`（status dispatched）

### 6.3 关键排障记录（供复现）
- 0.5.4 上游 bug：`package.json` 漏 `@deepseek-ai/dsh-brand` peer → dsh-go 加载器不拦截未声明 peer → `ERR_MODULE_NOT_FOUND` → 整个插件 import 失败（fiberPhase=null、health 404）。修复：补 peer + `scripts/check-peerdeps.mjs` 门禁（已进 `npm run check`）。
- 手机 Wi-Fi 节电会让 mesh 探测 RTT 涨到 2~2.5s、超过探测超时 → 对端显示离线（endpoints 记录实际还在，`downUntil` 冷却）。缓解：`adb shell svc power stayon true` / 保持充电亮屏；后续可用 USB 传输绕过 Wi-Fi。
- 部署后若 mesh 不激活：先 `adb shell am force-stop … && am start -n …/.LauncherMist` 重启引擎（无需手点），再看 health。

### 6.4 可选 UI 增强（零代码，验证中）
- `/root/.dsh/dsh-go/ui.json` 写 `plugins.seats["sidebar.panellist"]={"dsh-plugin-mesh":"island"}` → mesh Web 面板嵌入 dsh-go 原生侧栏（1~2 秒生效、免重启，回滚删文件）。
## 7. 妗岄潰绔畨瑁呴€傞厤鐗堬紙2026-10-29 02:10锛屽凡鎵ц锛?
- 宸插浠斤細`E:\DSH-Home\profiles\desktop\node_modules\dsh-plugin-mesh.bak-20261029-020932\`
- 宸叉浛鎹负 `0.5.4-dshgo.2`锛坙ib/client/scripts/sidecar/package.json/cordis.patch.yml/llms.txt锛涗繚鐣欏師 `node_modules` 閲岀殑 ssh2 渚濊禆锛?- profile 閰嶇疆 `E:\DSH-Home\profiles\desktop\cordis.patch.yml` 鐨?mesh 鍧楀凡鍔?USB 浼犺緭閰嶇疆锛堝師鏈夐敭淇濈暀锛夛細
  ```yaml
  - id: mesh
    name: dsh-plugin-mesh
    config:
      usbEnabled: true
      usbAdbPath: 'E:\AndroidSDK\platform-tools\adb.exe'
      usbForwardBase: 46000
      usbPollMs: 15000
      minTaskChars: 2
      maxWakesPerThread: 200
  ```
  锛堥厤缃浠斤細`cordis.patch.yml.mesh-usb-bak-20261029-021003`锛沋AML 宸茬敤 `yaml` 瑙ｆ瀽鏍￠獙閫氳繃锛?3 涓?entry锛?- 閲嶅惎鑴氭湰锛歚.tmp\restart-dsh.ps1`锛堝欢杩?20s 鏉€ `DeepSeek Harness` 鍐嶅惎鍔級锛屾棩蹇?`.tmp\restart-dsh.log`

### 閲嶅惎鍚庢€庝箞缁х画
1. 鎵撳紑 DSH 妗岄潰绔?鈫?渚ф爮鍘嗗彶浼氳瘽璇淬€岀户缁€嶅嵆鍙紙鏈細璇濇湭鍒狅級銆?2. 棰勬湡鍙樺寲锛?   - 妗岄潰 mesh 鐗堟湰 `0.5.4-dshgo.2`锛坄/mesh/v1/health`锛?   - `/mesh/v1/health` 鐨?`diag.usb` 鍑虹幇 `available:true`銆乣endpoints:[usb:1441e87a]`
   - `/mesh/v1/peers` 閲屾墜鏈烘潯鐩?endpoints 澶氫竴鏉?`transport:"usb"`锛圠AN+USB 鍙岄€氶亾锛屽悓涓€璁惧锛?   - **鍏虫帀鎵嬫満 Wi-Fi 鍚庝粛鑳?`mesh_run` 娲惧彂**锛圲SB 閫氶亾锛?3. 楠岃瘉鍛戒护锛?   ```powershell
   (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:45917/mesh/v1/health).Content
   (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:45917/mesh/v1/peers).Content
   ```

### 鍥炴粴锛堟闈㈢锛?```powershell
$dst='E:\DSH-Home\profiles\desktop\node_modules\dsh-plugin-mesh'
Remove-Item -Recurse -Force $dst
Rename-Item "$dst.bak-20261029-020932" 'dsh-plugin-mesh'
# 閰嶇疆鍥炴粴锛?Copy-Item 'E:\DSH-Home\profiles\desktop\cordis.patch.yml.mesh-usb-bak-20261029-021003' 'E:\DSH-Home\profiles\desktop\cordis.patch.yml' -Force
# 鐒跺悗閲嶅惎 DSH 妗岄潰绔?```

## 8. 宸茬煡/寰呭姙
- 鎵嬫満 mesh 鏄剧ず鍚嶄粛鏄?`localhost`锛坰tate.json 鏀瑰悕浠诲姟鍦ㄦ墜鏈轰晶鎺掗槦锛岄噸鍚紩鎿庡悗鍙兘鍙?`Xiaomi15Ultra`锛涙垨鎵嬪姩鍦?mesh 椤甸潰鏀瑰悕锛?- 鎵嬫満 Wi-Fi 鑺傜數浼氭媺楂樻帰娴?RTT 鈫?鍋跺彂"绂荤嚎"锛涘凡鎵ц `adb shell svc power stayon true`锛岄暱鏈熷缓璁敤 USB 閫氶亾
- tsnet锛堣法浜掕仈缃戠粍缃戯級鏈仛鐪熸満楠岃瘉锛堥渶瑕?tailscale 鎺堟潈鐮侊紝鍙€夛級
- ui.json island锛坢esh 闈㈡澘杩涙墜鏈哄師鐢熶晶鏍忥級宸插啓鍏?`/root/.dsh/dsh-go/ui.json`锛屽緟鐪熸満纭鏄剧ず

