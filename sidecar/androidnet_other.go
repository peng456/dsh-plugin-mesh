//go:build !linux

package main

import "context"

// 非 Linux 平台（macOS / Windows）没有 Android 那套解析器问题，
// 保留同名空实现，让 main.go 里的调用点保持无条件、无需再分平台。
func ensureDNS() []string { return nil }

func dnsUpCheck() string { return "" }

func probeControlPlane(context.Context) []string { return nil }
