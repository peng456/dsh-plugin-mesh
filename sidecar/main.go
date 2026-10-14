// Command dsh-mesh-tsnet joins a Tailscale tailnet in userspace using
// tailscale.com/tsnet and exposes it to the DSH Mesh plugin over loopback.
//
// It exists because tsnet runs its own userspace network stack: listeners bound
// on the host (0.0.0.0:45917) are NOT reachable from the tailnet IP, and the
// host cannot route to 100.x.y.z addresses. So this sidecar proxies both
// directions:
//
//	inbound : tailnet :PORT  -> 127.0.0.1:PORT  (HTTP reverse proxy, sets X-Forwarded-For)
//	outbound: POST /__tsnet/fetch -> dials through the tailnet on the caller's behalf
//
// The process is a machine-scoped singleton: several DSH profiles on one machine
// share one sidecar (and therefore one tailnet device) by reusing the loopback
// control port recorded in a rendezvous file.
//
// Protocol with the plugin:
//
//	stdout   one JSON object per line ("event" key), see emit()
//	stdin    closing it (EOF) makes the sidecar shut down, so DSH being killed
//	         with SIGKILL cannot leave an orphaned node behind
//	loopback HTTP control API, guarded by X-Mesh-Token
package main

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"
	"tailscale.com/types/views"
)

// ProtocolVersion is bumped whenever the control API changes shape, so the
// plugin can refuse a stale cached binary instead of failing in confusing ways.
const ProtocolVersion = 1

var (
	flHostname   = flag.String("hostname", "", "tailnet node name (DNS label); required")
	flDir        = flag.String("dir", "", "persistent state directory; required (keeps node identity stable)")
	flControlURL = flag.String("control-url", "", "control server URL; empty means the official Tailscale control plane")
	flToken      = flag.String("token", "", "shared secret required in X-Mesh-Token for the loopback control API")
	flEphemeral  = flag.Bool("ephemeral", false, "register as an ephemeral node: control removes it from the tailnet once it disconnects")
	flVersion    = flag.Bool("version", false, "print build info as JSON and exit")
)

// autoAuthKeyEnv is read from the environment rather than argv: on macOS any
// local user can read another process's command line via ps, but not its
// environment. Auth keys are tailnet join credentials, so they must not leak.
const autoAuthKeyEnv = "DSH_TSNET_AUTHKEY"

// ---------------------------------------------------------------------------
// stdout event channel
// ---------------------------------------------------------------------------

var (
	emitMu sync.Mutex
	enc    = json.NewEncoder(os.Stdout)
)

// emit writes one JSON line to stdout. The plugin reads these as the sidecar's
// progress/event stream, so every line must be valid JSON on a single line.
func emit(event string, extra map[string]any) {
	msg := map[string]any{"event": event}
	for k, v := range extra {
		msg[k] = v
	}
	emitMu.Lock()
	defer emitMu.Unlock()
	_ = enc.Encode(msg)
}

func emitError(where string, err error) {
	emit("error", map[string]any{"where": where, "message": err.Error()})
}

// ---------------------------------------------------------------------------
// control API payloads
// ---------------------------------------------------------------------------

type statusReply struct {
	OK       bool   `json:"ok"`
	Protocol int    `json:"protocol"`
	PID      int    `json:"pid"`
	Hostname string `json:"hostname"`
	// Ephemeral 是"本进程是否请求了临时节点"。控制面不回传节点的 ephemeral
	// 属性（PeerStatus/tailcfg.Node 里都没有这个字段），所以只能自报请求值 ——
	// 至少能验证开关确实传到了，而不是被静默忽略。
	Ephemeral    bool     `json:"ephemeral"`
	BackendState string   `json:"backendState"`
	AuthURL      string   `json:"authUrl"`
	MachineKey   string   `json:"machineKey"`
	SelfIPv4     string   `json:"selfIpv4"`
	SelfIPv6     string   `json:"selfIpv6"`
	SelfDNSName  string   `json:"selfDnsName"`
	Forwards     []int    `json:"forwards"`
	Diagnostics  []string `json:"diagnostics"`
}

type peerInfo struct {
	Hostname string   `json:"hostname"`
	DNSName  string   `json:"dnsName"`
	IPv4     string   `json:"ipv4"`
	IPv6     string   `json:"ipv6"`
	Online   bool     `json:"online"`
	OS       string   `json:"os"`
	LastSeen string   `json:"lastSeen"`
	Tags     []string `json:"tags"`
	ExitNode bool     `json:"exitNode"`
}

type fetchRequest struct {
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	BodyB64   string            `json:"bodyBase64"`
	TimeoutMs int               `json:"timeoutMs"`
}

type fetchReply struct {
	OK      bool                `json:"ok"`
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
	BodyB64 string              `json:"bodyBase64"`
	Error   string              `json:"error"`
}

// ---------------------------------------------------------------------------
// sidecar state
// ---------------------------------------------------------------------------

type sidecar struct {
	srv      *tsnet.Server
	token    string
	hostname string

	mu          sync.Mutex
	forwards    map[int]net.Listener
	diagnostics []string
}

// diagnosticsCap 是 /status 里 diag 字段保留的日志行数。
//
// 原来是 40，真机排查时不够用：tsnet 在建链过程中会打一堆行，40 行只够看到尾巴。
const diagnosticsCap = 200

func (sc *sidecar) note(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	sc.noteQuiet(line)
	emit("log", map[string]any{"message": line})
}

// noteQuiet 只进 diagnostics（/status 的 diag），不往 stdout 发。
// tsnet 很啰嗦，但"卡在 NeedsLogin 却一条日志都没有"更糟 —— 所以全都留着，
// 只是不全部实时推出去。
func (sc *sidecar) noteQuiet(line string) {
	sc.mu.Lock()
	sc.diagnostics = append(sc.diagnostics, line)
	if len(sc.diagnostics) > diagnosticsCap {
		sc.diagnostics = sc.diagnostics[len(sc.diagnostics)-diagnosticsCap:]
	}
	sc.mu.Unlock()
}

// worthStreaming 决定哪些 tsnet 日志值得实时发到 stdout。
//
// 原来只放 `tsnet: ` 前缀且含 error/fail/warning 的行。真机实测（2026-10）：
// DNS 不通导致节点卡在 NeedsLogin 时，stdout 上一行线索都没有，排查只能靠猜。
// 这里把建链关键路径（control/dns/login/auth/derp/magicsock）也放出来。
func worthStreaming(msg string) bool {
	lower := strings.ToLower(msg)
	for _, kw := range []string{
		"error", "fail", "warning", "warn",
		"control", "dns", "login", "auth", "derp", "magicsock",
		"timeout", "refused", "unreachable", "no route",
	} {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

func (sc *sidecar) diagnosticsSnapshot() []string {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	out := make([]string, len(sc.diagnostics))
	copy(out, sc.diagnostics)
	return out
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// normalizeArgs 丢掉命令行开头那些「不是选项」的元素。
//
// 为什么需要：Android/Termux 上 exec 经常要经 /system/bin/linker64 转发
// （`linker64 <本程序> -hostname …`）。bionic 只在 __libc_init 里把
// "linker64 <本程序>" 这两段摘掉，而纯 Go 程序从不调用 __libc_init —— 它直接
// 按内核初始栈读 argc/argv，于是 os.Args 前面多出一个 exe 路径。
//
// 后果特别隐蔽：flag.Parse() 一遇到非选项就停止解析，后面的开关全部被静默
// 丢掉，看起来像"程序收不到任何参数"（真机实测 2026-10：-version 和故意写错的
// -zzz 都得到同一句 "-hostname and -dir are required"；对照组 node/bash 正常，
// 因为它们是 C 程序，会走 __libc_init，那里的 argv 是被修正过的）。
//
// sidecar 只接受选项、不接受位置参数，所以"把第一个以 - 开头的元素之前的东西
// 全丢掉"是安全的；正常启动（不经 linker64）时它什么都不做。
func normalizeArgs() {
	for i := 1; i < len(os.Args); i++ {
		if strings.HasPrefix(os.Args[i], "-") {
			if i > 1 {
				os.Args = append(os.Args[:1], os.Args[i:]...)
			}
			return
		}
	}
}

// redactArgs 给错误现场用的 argv 摘要：只看前几项，并把 -token 的值打码
// （插件拉起 sidecar 时命令行里确实带着共享密钥，这条错误是要进日志的）。
func redactArgs(argv []string) []string {
	const maxN = 6
	out := make([]string, 0, maxN+1)
	maskNext := false
	for i, a := range argv {
		if i >= maxN {
			out = append(out, "…")
			break
		}
		if maskNext {
			out = append(out, "***")
			maskNext = false
			continue
		}
		if a == "-token" {
			maskNext = true
		}
		out = append(out, a)
	}
	return out
}

func main() {
	normalizeArgs()
	flag.Parse()

	if *flVersion {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"protocol": ProtocolVersion,
			"built":    buildStamp,
		})
		return
	}

	if *flHostname == "" || *flDir == "" {
		// 把 argv 现场一起打出去：真机上"参数全丢"和"参数被错位"表现完全一样，
		// 只有把 argc/argv 打出来才分辨得了（第一轮就是卡在这里靠猜）。
		emit("error", map[string]any{
			"where":   "args",
			"message": "-hostname and -dir are required",
			"argc":    len(os.Args),
			"argv":    redactArgs(os.Args),
		})
		os.Exit(2)
	}
	hostname := sanitizeHostname(*flHostname)
	if hostname == "" {
		emitError("args", fmt.Errorf("hostname %q has no usable DNS-label characters", *flHostname))
		os.Exit(2)
	}
	if err := os.MkdirAll(*flDir, 0o700); err != nil {
		emitError("state-dir", err)
		os.Exit(1)
	}

	sc := &sidecar{token: *flToken, hostname: hostname, forwards: map[int]net.Listener{}}

	srv := &tsnet.Server{
		Hostname: hostname,
		Dir:      *flDir,
		AuthKey:  os.Getenv(autoAuthKeyEnv),
		// 临时节点：断开后由控制面自动移除，不长期占用设备名额。
		// 主要给测试/演练用 —— 否则每跑一次就多两台设备，要手动去后台删。
		Ephemeral: *flEphemeral,
		Logf: func(format string, args ...any) {
			// 全部进 diag，只把重要的实时推给 stdout。旧实现只放
			// "tsnet: " + error/fail/warning，结果 DNS 卡住时一条都看不到。
			msg := fmt.Sprintf(format, args...)
			sc.noteQuiet(msg)
			if worthStreaming(msg) {
				emit("log", map[string]any{"message": msg})
			}
		},
	}
	if *flControlURL != "" {
		srv.ControlURL = strings.TrimRight(*flControlURL, "/")
		sc.note("using custom control server %s", srv.ControlURL)
	}
	if srv.AuthKey == "" {
		sc.note("no auth key supplied; interactive login will be required")
	}
	sc.srv = srv

	// Control API first, so the plugin can observe auth progress while Up()
	// is still blocked waiting for a human to approve the node.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		emitError("control-listen", err)
		os.Exit(1)
	}
	controlPort := ln.Addr().(*net.TCPAddr).Port
	go func() {
		if err := http.Serve(ln, sc.controlMux()); err != nil && !errors.Is(err, net.ErrClosed) {
			emitError("control-serve", err)
		}
	}()

	if err := srv.Start(); err != nil {
		emitError("start", err)
		os.Exit(1)
	}

	// Announce the control port immediately: the plugin can now poll /status
	// even though the node is not on the tailnet yet.
	emit("listening", map[string]any{
		"protocol": ProtocolVersion,
		"port":     controlPort,
		"pid":      os.Getpid(),
		"hostname": hostname,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// stdin EOF means the parent DSH process is gone (even on SIGKILL), so the
	// sidecar must not outlive it.
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		sc.note("stdin closed; shutting down")
		cancel()
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		sc.note("signal received; shutting down")
		cancel()
	}()

	// Watch login progress and surface the auth URL as soon as it appears.
	go sc.watchStatus(ctx)

	upDone := make(chan error, 1)
	go func() {
		// DNS 兜底放在这里而不是更早：控制 API 已经在监听、插件立刻就能看到
		// listening，而自检最多花十几秒 —— 不该让它卡住握手。
		// Android 上没有 /etc/resolv.conf，Go 的纯 Go 解析器会去试 127.0.0.1:53
		// 然后每个查询都失败，表现就是节点永远停在 NeedsLogin。
		for _, line := range ensureDNS() {
			sc.note("%s", line)
		}
		_, err := srv.Up(ctx)
		upDone <- err
	}()

	select {
	case <-ctx.Done():
		sc.shutdown()
		return
	case err := <-upDone:
		if err != nil {
			if ctx.Err() != nil {
				sc.shutdown()
				return
			}
			emitError("up", err)
			sc.shutdown()
			os.Exit(1)
		}
	}

	st := sc.currentStatus(ctx)
	emit("ready", map[string]any{
		"protocol":    ProtocolVersion,
		"hostname":    hostname,
		"selfIpv4":    firstIPv4(st),
		"selfIpv6":    firstIPv6(st),
		"selfDnsName": selfDNSName(st),
	})
	sc.note("tailnet node up as %s (%s)", hostname, firstIPv4(st))

	<-ctx.Done()
	sc.shutdown()
}

// shutdown closes the tsnet node and any tailnet listeners.
func (sc *sidecar) shutdown() {
	sc.mu.Lock()
	for port, ln := range sc.forwards {
		_ = ln.Close()
		delete(sc.forwards, port)
	}
	sc.mu.Unlock()
	if sc.srv != nil {
		_ = sc.srv.Close()
	}
}

// ---------------------------------------------------------------------------
// status helpers
// ---------------------------------------------------------------------------

func (sc *sidecar) currentStatus(ctx context.Context) *statusView {
	lc, err := sc.srv.LocalClient()
	if err != nil {
		return &statusView{BackendState: "NoState", diag: []string{"LocalClient: " + err.Error()}}
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return &statusView{BackendState: "NoState", diag: []string{"Status: " + err.Error()}}
	}
	view := &statusView{
		BackendState: string(st.BackendState),
		AuthURL:      st.AuthURL,
	}
	if st.Self != nil {
		// StableNodeID is the durable identity of this node in the tailnet;
		// the plugin uses it to detect "same machine, new process".
		view.MachineKey = string(st.Self.ID)
		view.SelfIPv4 = ipv4Of(st.Self.TailscaleIPs)
		view.SelfIPv6 = ipv6Of(st.Self.TailscaleIPs)
		view.SelfDNSName = strings.TrimSuffix(st.Self.DNSName, ".")
	}
	return view
}

// watchStatus polls for the interactive login URL so the UI can offer a
// clickable link instead of leaving the user staring at "connecting".
func (sc *sidecar) watchStatus(ctx context.Context) {
	lastURL := ""
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			view := sc.currentStatus(ctx)
			if view.AuthURL != "" && view.AuthURL != lastURL {
				lastURL = view.AuthURL
				emit("auth-required", map[string]any{"url": view.AuthURL})
			}
		}
	}
}

// ---------------------------------------------------------------------------
// control API
// ---------------------------------------------------------------------------

func (sc *sidecar) controlMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/__tsnet/status", sc.auth(sc.handleStatus))
	mux.HandleFunc("/__tsnet/peers", sc.auth(sc.handlePeers))
	mux.HandleFunc("/__tsnet/fetch", sc.auth(sc.handleFetch))
	mux.HandleFunc("/__tsnet/forward", sc.auth(sc.handleForward))
	mux.HandleFunc("/__tsnet/unforward", sc.auth(sc.handleUnforward))
	mux.HandleFunc("/__tsnet/shutdown", sc.auth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true})
		go func() {
			time.Sleep(50 * time.Millisecond)
			sc.shutdown()
			os.Exit(0)
		}()
	}))
	return mux
}

// auth enforces the shared token. The listener is loopback-only, but any local
// process could otherwise seize control of this machine's tailnet node.
func (sc *sidecar) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if sc.token != "" {
			got := r.Header.Get("X-Mesh-Token")
			if subtle.ConstantTimeCompare([]byte(got), []byte(sc.token)) != 1 {
				writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "bad token"})
				return
			}
		}
		next(w, r)
	}
}

func (sc *sidecar) handleStatus(w http.ResponseWriter, r *http.Request) {
	view := sc.currentStatus(r.Context())
	sc.mu.Lock()
	forwards := make([]int, 0, len(sc.forwards))
	for port := range sc.forwards {
		forwards = append(forwards, port)
	}
	sc.mu.Unlock()
	sort.Ints(forwards)
	diag := sc.diagnosticsSnapshot()
	writeJSON(w, 200, statusReply{
		OK:           true,
		Protocol:     ProtocolVersion,
		PID:          os.Getpid(),
		Hostname:     sc.hostname,
		Ephemeral:    *flEphemeral,
		BackendState: view.BackendState,
		AuthURL:      view.AuthURL,
		MachineKey:   view.MachineKey,
		SelfIPv4:     view.SelfIPv4,
		SelfIPv6:     view.SelfIPv6,
		SelfDNSName:  view.SelfDNSName,
		Forwards:     forwards,
		Diagnostics:  append(diag, view.diag...),
	})
}

func (sc *sidecar) handlePeers(w http.ResponseWriter, r *http.Request) {
	lc, err := sc.srv.LocalClient()
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	st, err := lc.Status(r.Context())
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	peers := make([]peerInfo, 0, len(st.Peer))
	for _, p := range st.Peer {
		if p == nil {
			continue
		}
		info := peerInfo{
			Hostname: p.HostName,
			DNSName:  strings.TrimSuffix(p.DNSName, "."),
			IPv4:     ipv4Of(p.TailscaleIPs),
			IPv6:     ipv6Of(p.TailscaleIPs),
			Online:   p.Online,
			OS:       p.OS,
			ExitNode: p.ExitNode,
			Tags:     tagsOf(p.Tags),
		}
		if !p.LastSeen.IsZero() {
			info.LastSeen = p.LastSeen.UTC().Format(time.RFC3339)
		}
		peers = append(peers, info)
	}
	sort.Slice(peers, func(i, j int) bool { return peers[i].Hostname < peers[j].Hostname })
	writeJSON(w, 200, map[string]any{"ok": true, "peers": peers})
}

// handleFetch performs an HTTP request from inside the tailnet. The plugin
// cannot route to 100.x.y.z itself, so every outbound mesh call to a tailnet
// peer arrives here.
func (sc *sidecar) handleFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "POST required"})
		return
	}
	var req fetchRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&req); err != nil {
		writeJSON(w, 200, fetchReply{Error: "bad request body: " + err.Error()})
		return
	}
	target, err := url.Parse(req.URL)
	if err != nil {
		writeJSON(w, 200, fetchReply{Error: "bad url: " + err.Error()})
		return
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		writeJSON(w, 200, fetchReply{Error: "unsupported scheme " + target.Scheme})
		return
	}

	var body io.Reader
	if req.BodyB64 != "" {
		raw, err := base64.StdEncoding.DecodeString(req.BodyB64)
		if err != nil {
			writeJSON(w, 200, fetchReply{Error: "bad body base64: " + err.Error()})
			return
		}
		body = strings.NewReader(string(raw))
	}

	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 || timeout > 5*time.Minute {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, strings.ToUpper(req.Method), target.String(), body)
	if err != nil {
		writeJSON(w, 200, fetchReply{Error: err.Error()})
		return
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := sc.srv.HTTPClient().Do(httpReq)
	if err != nil {
		writeJSON(w, 200, fetchReply{Error: err.Error()})
		return
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		writeJSON(w, 200, fetchReply{Error: "read body: " + err.Error()})
		return
	}
	writeJSON(w, 200, fetchReply{
		OK:      true,
		Status:  resp.StatusCode,
		Headers: map[string][]string(resp.Header),
		BodyB64: base64.StdEncoding.EncodeToString(raw),
	})
}

type forwardRequest struct {
	Port int `json:"port"`
}

// handleForward makes the plugin's local mesh server reachable inside the
// tailnet. tsnet's userspace stack is separate from the host stack, so the
// only way in is to accept on the tailnet and reverse-proxy to 127.0.0.1.
func (sc *sidecar) handleForward(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "POST required"})
		return
	}
	var req forwardRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if req.Port <= 0 || req.Port > 65535 {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "port out of range"})
		return
	}

	sc.mu.Lock()
	if _, exists := sc.forwards[req.Port]; exists {
		sc.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "already": true, "port": req.Port})
		return
	}
	sc.mu.Unlock()

	ln, err := sc.srv.Listen("tcp", ":"+strconv.Itoa(req.Port))
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "listen: " + err.Error()})
		return
	}

	target := &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(req.Port)}
	proxy := httputil.NewSingleHostReverseProxy(target)
	// ReverseProxy sets X-Forwarded-For itself: that is how the plugin learns
	// the real tailnet address of an inbound peer instead of 127.0.0.1.
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		sc.note("forward :%d -> loopback failed: %v", req.Port, err)
		w.WriteHeader(http.StatusBadGateway)
	}
	proxy.FlushInterval = -1

	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 15 * time.Second}
	go func() {
		if err := server.Serve(ln); err != nil && !errors.Is(err, net.ErrClosed) {
			sc.note("forward :%d stopped: %v", req.Port, err)
		}
	}()

	sc.mu.Lock()
	sc.forwards[req.Port] = ln
	sc.mu.Unlock()

	sc.note("forwarding tailnet :%d -> 127.0.0.1:%d", req.Port, req.Port)
	writeJSON(w, 200, map[string]any{"ok": true, "port": req.Port})
}

// handleUnforward stops exposing one port. Profiles other than the one that
// registered a forward are unaffected, which keeps a shared machine-level
// sidecar usable after one DSH instance shuts down.
func (sc *sidecar) handleUnforward(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "POST required"})
		return
	}
	var req forwardRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	sc.mu.Lock()
	ln, exists := sc.forwards[req.Port]
	if exists {
		delete(sc.forwards, req.Port)
	}
	sc.mu.Unlock()

	if !exists {
		writeJSON(w, 200, map[string]any{"ok": true, "absent": true, "port": req.Port})
		return
	}
	// Closing the listener makes the serving goroutine return.
	_ = ln.Close()
	sc.note("stopped forwarding tailnet :%d", req.Port)
	writeJSON(w, 200, map[string]any{"ok": true, "port": req.Port})
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

type statusView struct {
	BackendState string
	AuthURL      string
	MachineKey   string
	SelfIPv4     string
	SelfIPv6     string
	SelfDNSName  string
	diag         []string
}

func selfDNSName(st *statusView) string {
	if st == nil {
		return ""
	}
	return st.SelfDNSName
}

func firstIPv4(st *statusView) string {
	if st == nil {
		return ""
	}
	return st.SelfIPv4
}

func firstIPv6(st *statusView) string {
	if st == nil {
		return ""
	}
	return st.SelfIPv6
}

// ipv4Of returns the node's IPv4 tailnet address (100.x.y.z), if any.
func ipv4Of(addrs []netip.Addr) string {
	for _, a := range addrs {
		if a.Is4() {
			return a.String()
		}
	}
	return ""
}

// ipv6Of returns the node's IPv6 tailnet address (the fd7a: ULA), if any.
func ipv6Of(addrs []netip.Addr) string {
	for _, a := range addrs {
		if a.Is6() && !a.Is4In6() {
			return a.String()
		}
	}
	return ""
}

// tagsOf dereferences the lazy views.Slice; the pointer may legitimately be nil
// for untagged nodes, and AsSlice has a value receiver so it would panic.
func tagsOf(t *views.Slice[string]) []string {
	if t == nil {
		return nil
	}
	return t.AsSlice()
}

var hostnameStrip = regexp.MustCompile(`[^a-z0-9-]+`)

// sanitizeHostname turns an arbitrary machine name into a valid DNS label.
// tsnet derives the MagicDNS name from it, so invalid characters would make
// the node fail to register.
func sanitizeHostname(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = hostnameStrip.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	if len(s) > 63 {
		s = strings.Trim(s[:63], "-")
	}
	return s
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

// buildStamp is injected at link time; see scripts/build-sidecar.sh.
var buildStamp = "dev"
