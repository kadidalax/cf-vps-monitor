package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

// Only ping-platform.test.mjs replaces runtime.GOOS within the existing ICMP
// function. No other platform-sensitive collection or process code is replaced.
var reauditPingPlatform = runtime.GOOS

func TestReauditICMPPlatform(t *testing.T) {
	if os.Getenv("REAUDIT_PING_OVERLAY") != "1" {
		t.Skip("run the real command matrix with node --test agent/ping-platform.test.mjs")
	}
	fixture, err := os.ReadFile(os.Getenv("REAUDIT_PING_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	prepare := func(t *testing.T, programs ...string) string {
		t.Helper()
		dir := t.TempDir()
		for _, name := range programs {
			if runtime.GOOS == "windows" {
				name += ".exe"
			}
			if err := os.WriteFile(filepath.Join(dir, name), fixture, 0700); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv("PATH", dir)
		t.Setenv("REAUDIT_PING_ARGS", filepath.Join(dir, "args.json"))
		t.Setenv("REAUDIT_PING_DELAY_MS", "0")
		return dir
	}
	const ip4 = "8.8.8.8"
	const ip6 = "2606:4700:4700::1111"
	tests := []struct {
		name, platform, target, program string
		args                            []string
		withoutAlias                    bool
	}{
		{"windows4", "windows", ip4, "ping", []string{"-4", "-n", "1", "-w", "2000", ip4}, false},
		{"windows6", "windows", "[" + ip6 + "]", "ping", []string{"-6", "-n", "1", "-w", "2000", ip6}, false},
		{"linux4", "linux", ip4, "ping", []string{"-4", "-n", "-c", "1", "-W", "2", ip4}, false},
		{"linux6", "linux", ip6, "ping", []string{"-6", "-n", "-c", "1", "-W", "2", ip6}, false},
		{"darwin4", "darwin", ip4, "ping", []string{"-n", "-c", "1", "-W", "2000", ip4}, false},
		{"darwin6", "darwin", ip6, "ping6", []string{"-n", "-c", "1", ip6}, false},
		{"freebsd4", "freebsd", ip4, "ping", []string{"-n", "-c", "1", "-W", "2000", ip4}, false},
		{"freebsd6-old-or-alias", "freebsd", ip6, "ping6", []string{"-n", "-c", "1", ip6}, false},
		{"freebsd6-merged-without-alias", "freebsd", ip6, "ping", []string{"-6", "-n", "-c", "1", "-W", "2000", ip6}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			programs := []string{"ping", "ping6"}
			if tt.withoutAlias {
				programs = []string{"ping"}
			}
			prepare(t, programs...)
			reauditPingPlatform = tt.platform
			if result := executeICMPPingWithContext(context.Background(), tt.target); result < 0 {
				t.Fatalf("fake command was not successfully called: %v", result)
			}
			raw, err := os.ReadFile(os.Getenv("REAUDIT_PING_ARGS"))
			if err != nil {
				t.Fatal(err)
			}
			var command struct {
				Name string   `json:"name"`
				Args []string `json:"args"`
			}
			if err := json.Unmarshal(raw, &command); err != nil {
				t.Fatal(err)
			}
			if command.Name != tt.program || !reflect.DeepEqual(command.Args, tt.args) {
				t.Fatalf("executed %s %q; want %s %q", command.Name, command.Args, tt.program, tt.args)
			}
		})
	}
	t.Run("darwin IPv6 tool unavailable", func(t *testing.T) {
		prepare(t, "ping")
		reauditPingPlatform = "darwin"
		if got := executeICMPPingWithContext(context.Background(), ip6); got != -1 {
			t.Fatalf("missing ping6 must be unavailable, got %v", got)
		}
		if _, err := os.Stat(os.Getenv("REAUDIT_PING_ARGS")); !os.IsNotExist(err) {
			t.Fatal("the IPv4-only command must not run as an IPv6 fallback")
		}
	})
	t.Run("unknown platform unavailable", func(t *testing.T) {
		prepare(t, "ping", "ping6")
		reauditPingPlatform = "unsupported"
		if got := executeICMPPingWithContext(context.Background(), ip4); got != -1 {
			t.Fatalf("unknown platform must be unavailable, got %v", got)
		}
	})
	t.Run("response beyond two milliseconds", func(t *testing.T) {
		prepare(t, "ping")
		reauditPingPlatform = "darwin"
		t.Setenv("REAUDIT_PING_DELAY_MS", "120")
		if got := executeICMPPingWithContext(context.Background(), ip4); got < 100 {
			t.Fatalf("valid delayed child response must not be unavailable: %v", got)
		}
	})
	t.Run("cancel an actual child", func(t *testing.T) {
		prepare(t, "ping")
		reauditPingPlatform = "windows"
		t.Setenv("REAUDIT_PING_DELAY_MS", "5000")
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan float64, 1)
		go func() { done <- executeICMPPingWithContext(ctx, ip4) }()
		readyBy := time.Now().Add(time.Second)
		for {
			if _, err := os.Stat(os.Getenv("REAUDIT_PING_ARGS")); err == nil {
				break
			}
			if time.Now().After(readyBy) {
				t.Fatal("child failed to reach the deterministic start barrier")
			}
			time.Sleep(5 * time.Millisecond)
		}
		cancel()
		select {
		case result := <-done:
			if result != -1 {
				t.Fatalf("cancelled child result = %v", result)
			}
		case <-time.After(500 * time.Millisecond):
			t.Fatal("ICMP command ignored parent cancellation")
		}
	})
	t.Run("total two-second budget", func(t *testing.T) {
		prepare(t, "ping6")
		reauditPingPlatform = "darwin"
		t.Setenv("REAUDIT_PING_DELAY_MS", "5000")
		started := time.Now()
		got := executeICMPPingWithContext(context.Background(), ip6)
		elapsed := time.Since(started)
		if got != -1 || elapsed < 1500*time.Millisecond || elapsed > 2500*time.Millisecond {
			t.Fatalf("no-response child result=%v elapsed=%v; want unavailable within two seconds", got, elapsed)
		}
	})
}
