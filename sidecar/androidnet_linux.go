//go:build linux

package main

// Android 上把 Go 的域名解析救活，并给出一份可诊断的自检报告。
//
// 背景（真机实测 2026-10，Android 5.10.43 aarch64 / Termux）：netlink 那层修好后
// sidecar 能起来、控制 API 可用，但节点一直停在 NeedsLogin 且 authUrl 为空。
// curl 打 login/controlplane 都是 302（bionic 的 getaddrinfo 走 netd，能用），
// 而 Go 的解析器是另一条路：
//
//   · Android 没有 /etc/resolv.conf；
//   · Go 的纯 Go 解析器读不到配置就回退到 defaultNS = 127.0.0.1:53，这台机器上
//     没人在听，于是每个查询都失败；
//   · tailscale 的 dnsfallback（控制面解析兜底）走 DoH 打 dns.google / quad9，
//     在国内多半也不通 —— 所以最后表现为"控制面怎么都连不上"。
//
// tailscale 为此提供了 feature/androiddns：它不读系统属性，而是直接跟 netd 的
// /dev/socket/dnsproxyd 说协议（和 bionic 的 getaddrinfo 同一条路），并在
// available() 连接成功时改写 net.DefaultResolver。这条路更好（顺带拿到
// per-network 配置与 Private DNS），所以**它接管了我们就不动**。
//
// 但它有前提：dnsproxyd 必须连得上。连不上时它静默什么都不做，现场就一点线索都
// 没有。这里补三件事：
//
//  1. 自检：先看当前解析器能不能解析 controlplane.tailscale.com（正是建链最需要
//     的那个名字），结果写进 /status 的 diag —— 不管后面成不成，至少下次不用猜。
//  2. 兜底：解析失败时，从系统属性里扫 DNS（不只看 net.dns1..4 —— 实测这台华为
//     ROM 上它们全空，只有 net.rmnet0.dns1 有值；所以按"键以 dnsN 结尾"来匹配）。
//  3. 再兜底：一个都没有就用公共解析器，并在报告里写明用了哪个。
//
// 装上自建解析器后会用同一个自检再验一次，成功/失败都进 diag。

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"tailscale.com/net/dnscache"
)

// probeHost 是自检用的域名：建链最需要的就是它。
const probeHost = "controlplane.tailscale.com"

// androidDNSProbeTimeout 是单次自检的上限。启动路径上不能等太久
// （插件等 sidecar 就绪的上限是 25s，自检最多跑三次）。
const androidDNSProbeTimeout = 4 * time.Second

// androidDNSFallback 是系统属性里一个 DNS 都找不到、或者找出来的都不通时的兜底。
// 前两个在国内可达（阿里/DNSPod），后两个是通用兜底。
var androidDNSFallback = []string{"223.5.5.5", "119.29.29.29", "8.8.8.8", "1.1.1.1"}

var (
	// getprop 的输出形如：[net.rmnet0.dns1]: [219.141.140.10]
	propLineRe = regexp.MustCompile(`^\[([^\]]+)\]: \[(.*)\]$`)
	// 只认以 dnsN（或 dns）结尾的键，避免把 ro.dns.mode 之类算进来。
	dnsKeyRe = regexp.MustCompile(`dns[0-9]*$`)
)

// dnsCandidate 是一组待验证的 DNS 服务器。
type dnsCandidate struct {
	label   string
	servers []string
}

// ensureDNS 在 Android 上把 Go 的解析器救活，返回一份人可读的报告。
// 非 Android（普通 Linux 桌面）上它什么都不做。
func ensureDNS() []string {
	// 有可用的 resolv.conf 就不插手：那是系统/用户自己的配置。
	if fi, err := os.Stat("/etc/resolv.conf"); err == nil && fi.Size() > 0 {
		return nil
	}
	if !runningOnAndroid() {
		return nil
	}
	rep := []string{"dns: 没有 /etc/resolv.conf（Android 的正常现象）"}

	// tailscale 的 androiddns 走 /dev/socket/dnsproxyd（与 bionic getaddrinfo 同一条
	// 路），顺带拿到 per-network 配置与 Private DNS，比我们自己扫属性强 —— 它真能
	// 用就复用它。**但它只改 net.DefaultResolver**，而控制面解析根本不走那里（见
	// controlResolver 的说明），所以必须把它的 dial 复制到控制面用的解析器上。
	if ad := net.DefaultResolver.Dial; ad != nil {
		if addrs, err := probeWith(net.DefaultResolver); err == nil {
			applyResolver(ad)
			if a2, err2 := probeWith(controlResolver()); err2 == nil {
				rep = append(rep, fmt.Sprintf("dns: 复用 androiddns/dnsproxyd（自身自检 %s）并装到控制面解析器 → %s", joinAddrs(addrs), joinAddrs(a2)))
			} else {
				rep = append(rep, fmt.Sprintf("dns: 复用 androiddns 的 dial 后控制面自检仍失败：%v", err2))
			}
			return rep
		}
		rep = append(rep, "dns: androiddns 已接管 net.DefaultResolver 但自检失败，改用自建解析器")
	} else {
		rep = append(rep, "dns: net.DefaultResolver 未被接管（androiddns 没装上）")
	}

	var cands []dnsCandidate
	if props := androidDNSServers(); len(props) > 0 {
		cands = append(cands, dnsCandidate{"系统属性 " + strings.Join(props, ","), props})
	} else {
		rep = append(rep, "dns: 系统属性里没有任何以 dnsN 结尾的键")
	}
	cands = append(cands, dnsCandidate{"公共解析器 " + strings.Join(androidDNSFallback, ","), androidDNSFallback})

	// 逐个候选集自检。**必须在这一层换候选**，不能靠 Dial 里轮询：
	// UDP "连接"一台不可达的服务器不会失败（只会让查询超时），所以 Dial
	// 永远返回第一个候选，后面的根本轮不到。
	for _, c := range cands {
		applyResolver(dialAnyDNSServer(c.servers))
		if addrs, err := probeWith(controlResolver()); err == nil {
			rep = append(rep, fmt.Sprintf("dns: 用 %s 自检通过 → %s", c.label, joinAddrs(addrs)))
			return rep
		} else {
			rep = append(rep, fmt.Sprintf("dns: 用 %s 自检失败：%v", c.label, err))
		}
	}
	rep = append(rep, "dns: 所有兜底都失败，控制面大概率连不上")
	return rep
}

// controlResolver 返回"控制面真正会用"的那个解析器。
//
// 真机实测的根因就在这里：tailscale 的控制面解析**不走 net.DefaultResolver**。
// controlclient 用的是 net/dnscache 的 Forward，而 dnscache 在**包初始化时自己
// new 了一个** `&net.Resolver{PreferGo: preferGoResolver()}`（dnscache.go 里的
// single），和 net.DefaultResolver 是两个对象。于是 androiddns 把
// net.DefaultResolver 接管得再好，控制面照样没用上 —— 表现为我们自检通过、
// TryLogin 却报 `failed to resolve "controlplane.tailscale.com"`，然后退到
// DERP bootstrap（裸 IP 被出口代理挡掉）彻底失败。
//
// 自检必须打在这个解析器上，否则就是自欺欺人。
func controlResolver() *net.Resolver {
	if r := dnscache.Get(); r != nil && r.Forward != nil {
		return r.Forward
	}
	return net.DefaultResolver
}

// applyResolver 把 dial 装到两个解析器上。
//
// 都**原地改字段**，绝不替换 net.DefaultResolver 那块指针：有代码在 init 时就把
// 那个指针存下来了，替换指针它们看不到（dnscache 的 single.Forward 就是独立对象，
// 但同样的道理适用于任何持有者）。
func applyResolver(dial func(ctx context.Context, network, address string) (net.Conn, error)) {
	net.DefaultResolver.PreferGo = true
	net.DefaultResolver.Dial = dial
	if r := dnscache.Get(); r != nil && r.Forward != nil {
		r.Forward.PreferGo = true
		r.Forward.Dial = dial
	}
}

// probeWith 用指定解析器解析 probeHost。
func probeWith(r *net.Resolver) ([]net.IP, error) {
	ctx, cancel := context.WithTimeout(context.Background(), androidDNSProbeTimeout)
	defer cancel()
	return r.LookupIP(ctx, "ip4", probeHost)
}

// dnsUpCheck 在真正拉起 tailnet 之前复查一遍控制面解析器。
//
// 上一版就是"安装晚于第一次 TryLogin"，表现是自检通过、登录却解析失败。
// 这一行让下一次 diag 一眼能看出是不是又抢跑了。
func dnsUpCheck() string {
	r := controlResolver()
	if r.Dial == nil {
		return "dns: 拉起 tailnet 前复查：控制面解析器 Dial=nil（从未被装过，仍按系统配置走）"
	}
	if addrs, err := probeWith(r); err != nil {
		return fmt.Sprintf("dns: 拉起 tailnet 前复查：控制面解析器已装 Dial，但自检失败：%v", err)
	} else {
		return fmt.Sprintf("dns: 拉起 tailnet 前复查：控制面解析器已装 Dial，自检 OK → %s", joinAddrs(addrs))
	}
}

func joinAddrs(addrs []net.IP) string {
	if len(addrs) == 0 {
		return "（空）"
	}
	out := make([]string, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, a.String())
	}
	return strings.Join(out, ", ")
}

// dialAnyDNSServer 返回一个 net.Resolver.Dial 钩子：无视 Go 自己选的服务器
// （没有 resolv.conf 时它只会去试 127.0.0.1:53），改成依次试我们找到的这些。
//
// 返回的是普通 UDP/TCP 连接，Go 的解析器会直接在上面读写 DNS 报文，
// 所以不需要额外封装。
func dialAnyDNSServer(servers []string) func(ctx context.Context, network, address string) (net.Conn, error) {
	return func(ctx context.Context, network, _ string) (net.Conn, error) {
		var lastErr error
		for _, s := range servers {
			d := net.Dialer{Timeout: 3 * time.Second}
			c, err := d.DialContext(ctx, network, net.JoinHostPort(s, "53"))
			if err == nil {
				return c, nil
			}
			lastErr = err
		}
		if lastErr == nil {
			lastErr = errors.New("androidnet: 没有可用的 DNS 服务器")
		}
		return nil, lastErr
	}
}

// androidDNSServers 扫系统属性找 DNS 服务器。
//
// 刻意不只看 net.dns1..4：实测那台华为 ROM（SDK 31）上它们全是空的，只有
// net.rmnet0.dns1 有值 —— 只认固定那几个键就会一无所获。
func androidDNSServers() []string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/system/bin/getprop").Output()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var servers []string
	for _, line := range strings.Split(string(out), "\n") {
		m := propLineRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		key, val := m[1], strings.TrimSpace(m[2])
		if val == "" || !strings.Contains(strings.ToLower(key), "dns") || !dnsKeyRe.MatchString(key) {
			continue
		}
		if net.ParseIP(val) == nil || seen[val] {
			continue
		}
		seen[val] = true
		servers = append(servers, val)
	}
	return servers
}

// runningOnAndroid 判断是不是跑在 Android 内核上，即使二进制是 GOOS=linux。
// 判据同 tailscale：/dev/__properties__ 是 bionic 属性服务的后端存储，
// 从 5.0 起一直存在，且普通 Linux 上绝不会有。
func runningOnAndroid() bool {
	if runtime.GOOS == "android" {
		return true
	}
	_, err := os.Stat("/dev/__properties__")
	return err == nil
}
