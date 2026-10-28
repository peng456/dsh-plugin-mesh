# 手机侧环境事实探测任务（通过 mesh_run 派给 dsh-go agent 执行）

> 目标：一次性拿到 GAP-ANALYSIS §9 需要的全部真机事实。命令可直接整段贴进 mesh_run 的 task 里。
> 前提：adb reverse tcp:8792 已建立（PC 上有 E:\mesh\dist 静态服务），PC 侧端口 8792。

## 要发给 dsh-go agent 的任务文本（复制整段）

```
【mesh 适配 · 真机环境事实采集，请原样执行 bash 并把完整输出贴回来，不要总结】
set +e
T=${TMPDIR:-/tmp}/mesh-probe-$$; mkdir -p $T; cd $T
{
echo "== A. platform =="
node -e 'const os=require("os");console.log(JSON.stringify({platform:process.platform,arch:process.arch,release:os.release(),hostname:os.hostname(),cpus:os.cpus().length,par:os.availableParallelism&&os.availableParallelism()}))'
echo "== B. paths =="
ls -ld /dev/__properties__ /system/build.prop /system/bin/getprop /system/bin/ip /opt/dsh-go /etc/dsh-app 2>&1
echo "== C. props =="
(/system/bin/getprop ro.product.model; /system/bin/getprop ro.build.version.release; /system/bin/getprop ro.serialno) 2>&1
echo "== D. resolv/identity =="
cat /etc/resolv.conf 2>&1; echo ---; wc -c /etc/machine-id 2>&1; echo ---; cat /proc/sys/kernel/hostname 2>&1
echo "== E. networkInterfaces =="
node -e 'try{const n=require("os").networkInterfaces();console.log(JSON.stringify(n))}catch(e){console.log("THROW",e.code,e.message)}'
echo "== F. udp-connect =="
node -e 'const d=require("dgram").createSocket("udp4");d.connect(53,"192.168.1.1",()=>{console.log("udp-local",JSON.stringify(d.address()));d.close()});d.on("error",e=>console.log("udp-err",e.code,e.message));setTimeout(()=>process.exit(0),3000)'
echo "== G. /proc/net =="
head -3 /proc/net/route 2>&1; echo ---; head -3 /proc/net/if_inet6 2>&1; echo ---; head -3 /proc/net/igmp 2>&1
echo "== H. cpuinfo =="
grep -c ^processor /proc/cpuinfo 2>&1; head -5 /proc/cpuinfo 2>&1
echo "== I. multicast receive 20s =="
timeout 22 node -e 'const d=require("dgram").createSocket({type:"udp4",reuseAddr:true});let n=0;d.on("message",()=>{n++});d.on("error",e=>console.log("sockerr",e.code,e.message));d.bind(45892,()=>{try{d.addMembership("239.255.42.99");console.log("joined")}catch(e){console.log("join-fail",e.code,e.message)}});setTimeout(()=>{console.log("MCAST_TOTAL",n);process.exit(0)},20000)' 2>&1
echo "== J. profiles =="
ls -la /root/.dsh/profiles/ 2>&1; echo ---; ls /root/.dsh/profiles/web/node_modules/ 2>&1 | head -30; echo ---; node -e 'console.log(require("/root/.dsh/profiles/web/node_modules/dsh-plugin-mesh/package.json").version)' 2>&1
echo "== K. mesh state =="
ls -la /root/.dsh/profiles/web/mesh/ 2>&1 | head -20
} > $T/probe.txt 2>&1
echo "PROBE_FILE=$T/probe.txt"; wc -l $T/probe.txt; echo "===== BEGIN ====="; cat $T/probe.txt; echo "===== END ====="
```

## 判读要点
- A: `platform` 必须是 `linux`，`release` 含 `android`；`cpus` 是否是 0（对应 health 里 cpuCores:0）
- B: `/dev/__properties__` 存在 → sidecar 的 androidbin `onAndroid()` 为真；rootfs 内没有 ip/getprop（要用 /system/bin/*）
- D: `/etc/machine-id` 0 字节 → fingerprint 空（预期）；`/proc/sys/kernel/hostname` 是 `localhost` → machine 名 localhost 的根因
- E: 正常返回 wlan0 IPv4 → netlink 未受限（G1 降级）；THROW EPERM → 必须先有 netinfo 兜底
- F: `udp-local` 应等于手机 LAN IP（192.168.1.19）→ UDP 兜底可用
- G: /proc/net/route 可读性（决定 sidecar linux 资产 controlC 是否可用）
- I: `MCAST_TOTAL` = 0 且 joined 无报错 → 组播收包被 ROM 丢（G3 成立），只能靠 scan/staticPeers
- J: profile = web；mesh 包已装；版本号核对
```
