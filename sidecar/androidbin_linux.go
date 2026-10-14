//go:build linux

package main

// Tailscale 官方为「在 Android 上跑裸二进制」（Termux / adb / root shell）准备的
// 兼容包。真机实测（Android 5.10.43 aarch64，Termux）卡在这里：
//
//	{"event":"error","message":"tsnet: route ip+net: netlinkrib: permission denied","where":"start"}
//
// 根因：Android 对 app UID（untrusted_app）关掉了 NETLINK_ROUTE 与 /proc/net，
// 而 Go 标准库的 net.Interfaces() 在 linux（android 也算 linux）上一律走 netlink，
// 于是它永远失败，netmon.New() 直接返回错误，tsnet 起不来。旁证：同一身份下
// /proc/net/route、/proc/net/if_inet6 都是 EACCES，而 bionic 的 getifaddrs 正常。
// Tailscale 源码里对这件事有原话（net/netmon/state.go）：
//
//	// It exists because Android SDK 30 no longer permits Go's net.Interfaces
//	// to work (Issue 2293); this wrapper lets us the Android app register
//	// an alternate implementation.
//
// 官方 Android app 靠 Java 注册接口表，而裸二进制没有 Java 可依赖 —— 这正是
// androidbin 包的用途（其包注释第一句就是"makes Tailscale binaries work when run
// as raw (non-GUI app) executables on Android, such as under Termux"）。它做三件事：
//
//  1. 注册 netmon 的接口回退（net.Interfaces 已经失败之后才会用到）：报一个合成
//     的 "android" 接口，地址通过向内核要一条出站 UDP 路由取源地址拿到（合法且
//     不发包）；netmon.Interface.Addrs() 会优先用它给的 AltAddrs，所以连地址
//     枚举都不碰 netlink。
//  2. 拉进 androiddns（Android 上没有 /etc/resolv.conf）。
//  3. 把 CA 根证书指到 /system/etc/security/cacerts —— 这一条我们还没走到但一定会
//     踩：GOOS=linux 的二进制在 Android 上系统证书池是空的，控制面 TLS 会全挂。
//     它在普通 Linux 上是空操作（onAndroid() 为假），所以不影响桌面产物。
//
// tsnet **默认不引入**这个包，官方要求 tsnet 应用自己 blank import（见包注释
// "It is not linked into tsnet by default; tsnet apps and other programs opt in
// with a blank import of this package"）。
//
// 必须放在 linux 构建约束里：该包在 darwin/windows 下没有任何可编译文件，
// 直接在 main.go 里 import 会让 mac/win 构建报 "build constraints exclude all Go files"。
import _ "tailscale.com/feature/androidbin"
