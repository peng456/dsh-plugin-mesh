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

	// tailscale 的 androiddns 走 /dev/socket/dnsproxyd，比我们任何兜底都好
	// （顺带拿到 per-network 配置与 Private DNS），所以它真能用就不动它。
	// 但真机实测这条路常因 socket 权限连不上，而它连不上时**静默什么都不做** ——
	// 所以这里以"自检能不能解析"为准，而不是只看它有没有接管。
	if net.DefaultResolver.Dial != nil {
		if addrs, err := probeLookup(); err == nil {
			rep = append(rep, fmt.Sprintf("dns: 现有解析器（androiddns/dnsproxyd 已接管）自检通过 → %s", joinAddrs(addrs)))
			return rep
		} else {
			rep = append(rep, fmt.Sprintf("dns: androiddns 已接管 dnsproxyd，但自检失败：%v", err))
		}
	} else {
		rep = append(rep, "dns: androiddns 没有接管（/dev/socket/dnsproxyd 连不上，真机实测是 Permission denied）")
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
		net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: dialAnyDNSServer(c.servers)}
		if addrs, err := probeLookup(); err == nil {
			rep = append(rep, fmt.Sprintf("dns: 用 %s 自检通过 → %s", c.label, joinAddrs(addrs)))
			return rep
		} else {
			rep = append(rep, fmt.Sprintf("dns: 用 %s 自检失败：%v", c.label, err))
		}
	}
	rep = append(rep, "dns: 所有兜底都失败，控制面大概率连不上")
	return rep
}

// probeLookup 用当前 net.DefaultResolver 解析 probeHost。
func probeLookup() ([]net.IP, error) {
	ctx, cancel := context.WithTimeout(context.Background(), androidDNSProbeTimeout)
	defer cancel()
	return net.DefaultResolver.LookupIP(ctx, "ip4", probeHost)
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
