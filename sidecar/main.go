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
	OK           bool     `json:"ok"`
	Protocol     int      `json:"protocol"`
	PID          int      `json:"pid"`
	Hostname     string   `json:"hostname"`
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

func (sc *sidecar) note(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	sc.mu.Lock()
	sc.diagnostics = append(sc.diagnostics, line)
	if len(sc.diagnostics) > 40 {
		sc.diagnostics = sc.diagnostics[len(sc.diagnostics)-40:]
	}
	sc.mu.Unlock()
	emit("log", map[string]any{"message": line})
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

func main() {
	flag.Parse()

	if *flVersion {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"protocol": ProtocolVersion,
			"built":    buildStamp,
		})
		return
	}

	if *flHostname == "" || *flDir == "" {
		emitError("args", errors.New("-hostname and -dir are required"))
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
			// tsnet is chatty at info level; keep the stream useful by only
			// forwarding warnings and errors.
			msg := fmt.Sprintf(format, args...)
			if strings.HasPrefix(msg, "tsnet: ") {
				lower := strings.ToLower(msg)
				if strings.Contains(lower, "error") || strings.Contains(lower, "fail") || strings.Contains(lower, "warning") {
					emit("log", map[string]any{"message": msg})
				}
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
