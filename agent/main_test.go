package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v3/disk"
	gnet "github.com/shirou/gopsutil/v3/net"
)

func TestNormalizeServerURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "adds https", raw: "example.com/", want: "https://example.com"},
		{name: "keeps path", raw: "https://example.com/panel/?x=1#frag", want: "https://example.com/panel"},
		{name: "keeps localhost http", raw: "http://127.0.0.1:8787/", want: "http://127.0.0.1:8787"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeServerURL(tc.raw)
			if err != nil {
				t.Fatalf("normalizeServerURL() error = %v", err)
			}
			if got != tc.want {
				t.Fatalf("normalizeServerURL() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeServerURLRejectsInvalidInput(t *testing.T) {
	for _, raw := range []string{"", "ftp://example.com", "https:///missing-host", "http://example.com"} {
		if got, err := normalizeServerURL(raw); err == nil {
			t.Fatalf("normalizeServerURL(%q) = %q, want error", raw, got)
		}
	}
}

func TestWebSocketEndpoint(t *testing.T) {
	tests := []struct {
		server string
		want   string
	}{
		{server: "https://example.com", want: "wss://example.com/api/clients/report"},
		{server: "http://127.0.0.1:8787/base", want: "ws://127.0.0.1:8787/base/api/clients/report"},
	}

	for _, tc := range tests {
		got, err := webSocketEndpoint(tc.server, "token")
		if err != nil {
			t.Fatalf("webSocketEndpoint() error = %v", err)
		}
		if got != tc.want {
			t.Fatalf("webSocketEndpoint() = %q, want %q", got, tc.want)
		}
	}
}

func testWebSocketURL(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http")
}

func TestConnectWebSocketSendsBearerToken(t *testing.T) {
	upgrader := websocket.Upgrader{}
	authHeader := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader <- r.Header.Get("Authorization")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade websocket: %v", err)
			return
		}
		_ = conn.Close()
	}))
	defer server.Close()

	conn, err := connectWebSocket(testWebSocketURL(server.URL), "agent-token")
	if err != nil {
		t.Fatalf("connectWebSocket() error = %v", err)
	}
	conn.Close()

	select {
	case got := <-authHeader:
		if got != "Bearer agent-token" {
			t.Fatalf("Authorization = %q, want Bearer agent-token", got)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not receive websocket handshake")
	}
}

func TestWebSocketReconnectDelaySlowsAuthFailures(t *testing.T) {
	oldReconnectInterval := reconnectInterval
	reconnectInterval = 5
	defer func() { reconnectInterval = oldReconnectInterval }()

	if got := webSocketReconnectDelay(errors.New("401 Unauthorized")); got != 10*time.Minute {
		t.Fatalf("auth failure reconnect delay = %s, want 10m", got)
	}
	if got := webSocketReconnectDelay(errors.New("dial tcp timeout")); got != 5*time.Second {
		t.Fatalf("network failure reconnect delay = %s, want 5s", got)
	}
}

func TestReadWebSocketMessagesQueuesPoliciesOnly(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade websocket: %v", err)
			return
		}
		defer conn.Close()

		_ = conn.WriteMessage(websocket.TextMessage, []byte("{bad-json"))
		_ = conn.WriteJSON(serverMessage{Type: "ack", Timestamp: 123})
		_ = conn.WriteJSON(serverMessage{Type: "policy", SampleIntervalSec: 3, ReportIntervalSec: 7, ReportNow: true})
		_ = conn.WriteJSON(serverMessage{Type: "notice"})
	}))
	defer server.Close()

	rawConn, _, err := websocket.DefaultDialer.Dial(testWebSocketURL(server.URL), nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	conn := &safeWebSocketConn{conn: rawConn}
	defer conn.Close()

	done := make(chan error, 1)
	policies := make(chan serverMessage, 2)
	go readWebSocketMessages(conn, done, policies)

	select {
	case policy := <-policies:
		if policy.Type != "policy" || policy.SampleIntervalSec != 3 || policy.ReportIntervalSec != 7 || !policy.ReportNow {
			t.Fatalf("policy = %#v, want forwarded policy message", policy)
		}
	case <-time.After(time.Second):
		t.Fatal("policy message was not queued")
	}

	select {
	case <-policies:
		t.Fatal("non-policy websocket message was queued")
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("websocket reader did not stop after server close")
	}
}

func TestPolicyDecodesNumericAllClients(t *testing.T) {
	raw := []byte(`{"type":"policy","sample_interval_sec":120,"report_interval_sec":120,"ping_tasks":[{"id":1,"name":"tcp","type":"tcp","target":"example.com:80","interval_sec":120,"clients":[],"all_clients":1}]}`)
	var policy serverMessage
	if err := json.Unmarshal(raw, &policy); err != nil {
		t.Fatalf("decode policy with numeric all_clients: %v", err)
	}
	if len(policy.PingTasks) != 1 {
		t.Fatalf("decoded %d ping tasks, want 1", len(policy.PingTasks))
	}
	if !bool(policy.PingTasks[0].AllClients) {
		t.Fatal("numeric all_clients was not decoded as true")
	}
}

func TestDefaultIntervalsStartInBackgroundMode(t *testing.T) {
	if reportInterval != 120 {
		t.Fatalf("default report interval = %d, want 120 seconds", reportInterval)
	}
	if pingInterval != defaultPingIntervalSec {
		t.Fatalf("default ping interval = %d, want %d seconds", pingInterval, defaultPingIntervalSec)
	}
}

func TestReadCgroupMemoryUsesContainerLimits(t *testing.T) {
	root := t.TempDir()
	cgroupDir := filepath.Join(root, "lxc", "101")
	if err := os.MkdirAll(cgroupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name string, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(cgroupDir, name), []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("memory.max", "1073741824\n")
	write("memory.current", "268435456\n")
	write("memory.swap.max", "536870912\n")
	write("memory.swap.current", "134217728\n")

	procCgroup := filepath.Join(root, "self-cgroup")
	if err := os.WriteFile(procCgroup, []byte("0::/lxc/101\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := readCgroupMemory(root, procCgroup)
	if !got.hasRAM || got.ramTotal != 1073741824 || got.ramUsed != 268435456 {
		t.Fatalf("cgroup ram = %#v, want 1GiB total and 256MiB used", got)
	}
	if !got.hasSwap || got.swapTotal != 536870912 || got.swapUsed != 134217728 {
		t.Fatalf("cgroup swap = %#v, want 512MiB total and 128MiB used", got)
	}
}

func TestReadCgroupMemoryV1DerivesSwapFromMemsw(t *testing.T) {
	root := t.TempDir()
	cgroupDir := filepath.Join(root, "memory", "lxc", "101")
	if err := os.MkdirAll(cgroupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"memory.limit_in_bytes":       "1073741824\n",
		"memory.usage_in_bytes":       "268435456\n",
		"memory.memsw.limit_in_bytes": "1610612736\n",
		"memory.memsw.usage_in_bytes": "402653184\n",
	} {
		if err := os.WriteFile(filepath.Join(cgroupDir, name), []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	procCgroup := filepath.Join(root, "self-cgroup")
	if err := os.WriteFile(procCgroup, []byte("10:memory:/lxc/101\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := readCgroupMemory(root, procCgroup)
	if !got.hasSwap || got.swapTotal != 536870912 || got.swapUsed != 134217728 {
		t.Fatalf("cgroup v1 swap = %#v, want memsw minus memory", got)
	}
}

func TestParseProcMeminfoUsesKomariHtopLikeMemory(t *testing.T) {
	got := parseProcMeminfo(`MemTotal:       1000 kB
MemFree:         100 kB
Buffers:          50 kB
Cached:          200 kB
SwapCached:       25 kB
SwapTotal:       500 kB
SwapFree:        100 kB
Shmem:            10 kB
SReclaimable:     40 kB
`)

	if !got.hasRAM || got.ramTotal != 1000*1024 || got.ramUsed != 620*1024 {
		t.Fatalf("proc meminfo ram = %#v, want htop-like used memory", got)
	}
	if !got.hasSwap || got.swapTotal != 500*1024 || got.swapUsed != 375*1024 {
		t.Fatalf("proc meminfo swap = %#v, want total-free-cached", got)
	}
}

func TestMergeMemorySnapshotZerosContainerSwapWhenCgroupSwapMissing(t *testing.T) {
	procMem := parseProcMeminfo(`MemTotal:       65563288 kB
MemFree:        10000000 kB
Buffers:          100000 kB
Cached:          1000000 kB
SwapCached:            0 kB
SwapTotal:      65660924 kB
SwapFree:       60813916 kB
SReclaimable:     100000 kB
`)
	cgroup := memorySnapshot{
		ramUsed:  42 * 1024 * 1024,
		ramTotal: 512000000,
		hasRAM:   true,
	}

	got := mergeMemorySnapshot(procMem, cgroup, true)

	if !got.hasRAM || got.ramTotal != 512000000 || got.ramUsed != 42*1024*1024 {
		t.Fatalf("merged ram = %#v, want cgroup ram", got)
	}
	if !got.hasSwap || got.swapTotal != 0 || got.swapUsed != 0 {
		t.Fatalf("merged swap = %#v, want container swap cleared instead of host swap", got)
	}
}

func TestMergeMemorySnapshotZerosContainerSwapWhenCgroupMirrorsHostSwap(t *testing.T) {
	procMem := parseProcMeminfo(`MemTotal:       65563288 kB
MemFree:        10000000 kB
Buffers:          100000 kB
Cached:          1000000 kB
SwapCached:            0 kB
SwapTotal:      65660924 kB
SwapFree:       60813916 kB
SReclaimable:     100000 kB
`)
	cgroup := memorySnapshot{
		ramUsed:   42 * 1024 * 1024,
		ramTotal:  512000000,
		swapUsed:  procMem.swapUsed,
		swapTotal: procMem.swapTotal,
		hasRAM:    true,
		hasSwap:   true,
	}

	got := mergeMemorySnapshot(procMem, cgroup, true)

	if !got.hasSwap || got.swapTotal != 0 || got.swapUsed != 0 {
		t.Fatalf("merged swap = %#v, want host-sized cgroup swap cleared for LXC", got)
	}
}

func TestFormatMemoryBytesKeepsSubGiBReadable(t *testing.T) {
	if got := formatMemoryBytes(512000000); got != "488MiB" {
		t.Fatalf("formatMemoryBytes(512000000) = %q, want 488MiB", got)
	}
	if got := formatMemoryBytes(2 * 1024 * 1024 * 1024); got != "2.0GiB" {
		t.Fatalf("formatMemoryBytes(2GiB) = %q, want 2.0GiB", got)
	}
}

func TestKomariDiskPartitionsKeepRootAndDropVirtualMounts(t *testing.T) {
	parts := []disk.PartitionStat{
		{Device: "/dev/loop0", Mountpoint: "/", Fstype: "ext4"},
		{Device: "tmpfs", Mountpoint: "/run", Fstype: "tmpfs"},
		{Device: "overlay", Mountpoint: "/var/lib/docker/overlay2", Fstype: "overlay"},
		{Device: "/dev/sda1", Mountpoint: "/data", Fstype: "ext4"},
	}

	got := selectDiskPartitions(parts, "", "")
	if len(got) != 2 || got[0].Mountpoint != "/" || got[1].Mountpoint != "/data" {
		t.Fatalf("selected partitions = %#v, want root and physical data only", got)
	}
}

func TestProcNetConnectionsCountCountsIPv4AndIPv6Rows(t *testing.T) {
	root := t.TempDir()
	netDir := filepath.Join(root, "net")
	if err := os.MkdirAll(netDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"tcp":  "header\nrow1\nrow2\n",
		"tcp6": "header\nrow3\n",
		"udp":  "header\nrow1\n",
		"udp6": "header\n",
	} {
		if err := os.WriteFile(filepath.Join(netDir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	tcp, udp, err := procNetConnectionsCount(root)
	if err != nil {
		t.Fatal(err)
	}
	if tcp != 3 || udp != 1 {
		t.Fatalf("proc net counts = tcp %d udp %d, want 3/1", tcp, udp)
	}
}

func TestLinuxOSNameReadsPrettyName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "os-release")
	if err := os.WriteFile(path, []byte("NAME=Debian\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := linuxOSName(path); got != "Debian GNU/Linux 12 (bookworm)" {
		t.Fatalf("linuxOSName() = %q, want Debian pretty name", got)
	}
}

func TestDetectContainerFromCgroupFindsLXC(t *testing.T) {
	if got := detectContainerFromCgroup("0::/lxc/101\n"); got != "lxc" {
		t.Fatalf("detectContainerFromCgroup() = %q, want lxc", got)
	}
}

func TestPolicyDurationsKeepRealtimeAndBackgroundUploadsDistinct(t *testing.T) {
	realtimeSample, realtimeUpload := policyDurations(agentPolicy{
		Mode:              "active",
		SampleIntervalSec: 3,
		ReportIntervalSec: 3,
	}, 120*time.Second)
	if realtimeSample != 3*time.Second || realtimeUpload != 3*time.Second {
		t.Fatalf("realtime policy = sample %s upload %s, want 3s/3s", realtimeSample, realtimeUpload)
	}

	backgroundSample, backgroundUpload := policyDurations(agentPolicy{
		Mode:              "idle",
		SampleIntervalSec: 120,
		ReportIntervalSec: 120,
	}, 3*time.Second)
	if backgroundSample != 120*time.Second || backgroundUpload != 120*time.Second {
		t.Fatalf("background policy = sample %s upload %s, want 120s/120s", backgroundSample, backgroundUpload)
	}
}

func TestTrafficResetPeriodKey(t *testing.T) {
	loc := time.UTC
	tests := []struct {
		now      time.Time
		resetDay int
		want     string
	}{
		{now: time.Date(2026, time.June, 1, 0, 0, 0, 0, loc), resetDay: 1, want: "2026-06-01"},
		{now: time.Date(2026, time.June, 14, 0, 0, 0, 0, loc), resetDay: 15, want: "2026-05-15"},
		{now: time.Date(2026, time.March, 31, 0, 0, 0, 0, loc), resetDay: 31, want: "2026-03-31"},
		{now: time.Date(2026, time.March, 30, 0, 0, 0, 0, loc), resetDay: 31, want: "2026-03-01"},
		{now: time.Date(2026, time.February, 28, 0, 0, 0, 0, loc), resetDay: 31, want: "2026-01-31"},
	}

	for _, tc := range tests {
		got := trafficResetPeriodKey(tc.now, tc.resetDay)
		if got != tc.want {
			t.Fatalf("trafficResetPeriodKey(%s, %d) = %q, want %q", tc.now.Format(time.DateOnly), tc.resetDay, got, tc.want)
		}
	}
}

func TestTrafficResetStatePathIsStableAcrossTokenRotation(t *testing.T) {
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", "")

	pathA := trafficResetStatePath("token-a")
	pathB := trafficResetStatePath("token-b")
	if pathA != pathB {
		t.Fatalf("trafficResetStatePath changed across token rotation: %q != %q", pathA, pathB)
	}
	if strings.Contains(filepath.Base(pathA), shortHash("token-a")) {
		t.Fatalf("trafficResetStatePath(%q) = %q, must not key monthly traffic by token", "token-a", pathA)
	}
}

func TestTrafficResetTrackerKeepsMonthlyDeltasAcrossTokenRotation(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", statePath)

	scope := "wan"
	first := newTrafficResetTracker(1, "token-a", scope)
	now := time.Date(2026, time.June, 10, 12, 0, 0, 0, time.UTC)
	bootedBeforePeriod := time.Date(2026, time.May, 10, 12, 0, 0, 0, time.UTC)
	up, down := first.adjustSinceBoot(1000, 2000, now, bootedBeforePeriod)
	if up != 0 || down != 0 {
		t.Fatalf("initial monthly traffic = %d/%d, want 0/0", up, down)
	}
	up, down = first.adjustSinceBoot(1500, 2600, now.Add(time.Minute), bootedBeforePeriod)
	if up != 500 || down != 600 {
		t.Fatalf("monthly traffic after delta = %d/%d, want 500/600", up, down)
	}

	rotated := newTrafficResetTracker(1, "token-b", scope)
	up, down = rotated.adjustSinceBoot(1700, 3000, now.Add(2*time.Minute), bootedBeforePeriod)
	if up != 700 || down != 1000 {
		t.Fatalf("monthly traffic after token rotation = %d/%d, want 700/1000", up, down)
	}
}

func TestTrafficResetTrackerStartsWithSystemTotalsWhenBootedInCurrentPeriod(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", statePath)

	tracker := newTrafficResetTracker(1, "token", "wan")
	now := time.Date(2026, time.June, 10, 12, 0, 0, 0, time.UTC)
	bootedInPeriod := time.Date(2026, time.June, 2, 12, 0, 0, 0, time.UTC)
	up, down := tracker.adjustSinceBoot(1000, 2000, now, bootedInPeriod)
	if up != 1000 || down != 2000 {
		t.Fatalf("initial monthly traffic = %d/%d, want system totals 1000/2000", up, down)
	}
}

func TestTrafficResetTrackerRepairsInstallBaselineWhenBootedInCurrentPeriod(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", statePath)

	now := time.Date(2026, time.June, 10, 12, 0, 0, 0, time.UTC)
	state := trafficResetState{
		ResetDay:    1,
		Period:      trafficResetPeriodKey(now, 1),
		Scope:       "wan",
		LastRawUp:   1000,
		LastRawDown: 2000,
		PeriodUp:    0,
		PeriodDown:  0,
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	tracker := newTrafficResetTracker(1, "token", "wan")
	bootedInPeriod := time.Date(2026, time.June, 2, 12, 0, 0, 0, time.UTC)
	up, down := tracker.adjustSinceBoot(1500, 2600, now.Add(time.Minute), bootedInPeriod)
	if up != 1500 || down != 2600 {
		t.Fatalf("repaired monthly traffic = %d/%d, want system totals 1500/2600", up, down)
	}
}

func TestTrafficResetTrackerAddsCurrentBootCountersAfterCounterReset(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", statePath)

	now := time.Date(2026, time.June, 10, 12, 0, 0, 0, time.UTC)
	state := trafficResetState{
		ResetDay:    1,
		Period:      trafficResetPeriodKey(now, 1),
		Scope:       "wan",
		LastRawUp:   4000,
		LastRawDown: 10_000,
		PeriodUp:    5000,
		PeriodDown:  12_000,
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	tracker := newTrafficResetTracker(1, "token", "wan")
	bootedInPeriod := time.Date(2026, time.June, 9, 12, 0, 0, 0, time.UTC)
	up, down := tracker.adjustSinceBoot(700, 800, now.Add(time.Minute), bootedInPeriod)
	if up != 5700 || down != 12_800 {
		t.Fatalf("monthly traffic after counter reset = %d/%d, want previous period plus current boot 5700/12800", up, down)
	}
}

func TestTrafficResetTrackerKeepsMonthlyTrafficAfterRebootInCurrentPeriod(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", statePath)

	tracker := newTrafficResetTracker(1, "token", "wan")
	now := time.Date(2026, time.June, 10, 12, 0, 0, 0, time.UTC)
	bootedInPeriod := time.Date(2026, time.June, 2, 12, 0, 0, 0, time.UTC)
	tracker.adjustSinceBoot(5000, 12_000, now, bootedInPeriod)

	restarted := newTrafficResetTracker(1, "token", "wan")
	bootedAfterReboot := time.Date(2026, time.June, 10, 12, 1, 0, 0, time.UTC)
	up, down := restarted.adjustSinceBoot(700, 800, now.Add(2*time.Minute), bootedAfterReboot)
	if up != 5700 || down != 12_800 {
		t.Fatalf("monthly traffic after reboot = %d/%d, want previous period plus current boot 5700/12800", up, down)
	}
}

func TestTrafficResetTrackerDetectsRebootEvenWhenOneCounterIncreases(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", statePath)

	tracker := newTrafficResetTracker(1, "token", "wan")
	now := time.Date(2026, time.June, 10, 12, 0, 0, 0, time.UTC)
	bootedInPeriod := time.Date(2026, time.June, 2, 12, 0, 0, 0, time.UTC)
	tracker.adjustSinceBoot(100, 12_000, now, bootedInPeriod)

	restarted := newTrafficResetTracker(1, "token", "wan")
	bootedAfterReboot := time.Date(2026, time.June, 10, 12, 1, 0, 0, time.UTC)
	up, down := restarted.adjustSinceBoot(700, 800, now.Add(2*time.Minute), bootedAfterReboot)
	if up != 800 || down != 12_800 {
		t.Fatalf("monthly traffic after asymmetric reboot = %d/%d, want previous period plus current boot 800/12800", up, down)
	}
}

func TestTrafficResetTrackerTreatsAnyCounterDropAsCounterReset(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", statePath)

	tracker := newTrafficResetTracker(1, "token", "wan")
	now := time.Date(2026, time.June, 10, 12, 0, 0, 0, time.UTC)
	bootedInPeriod := time.Date(2026, time.June, 2, 12, 0, 0, 0, time.UTC)
	tracker.adjustSinceBoot(100, 12_000, now, bootedInPeriod)

	restarted := newTrafficResetTracker(1, "token", "wan")
	up, down := restarted.adjustSinceBoot(700, 800, now.Add(2*time.Minute), bootedInPeriod)
	if up != 800 || down != 12_800 {
		t.Fatalf("monthly traffic after counter reset = %d/%d, want previous period plus current counters 800/12800", up, down)
	}
}

func TestTrafficResetTrackerIgnoresExternalKomariNetStaticHistory(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "traffic-state.json")
	komariPath := filepath.Join(dir, "net_static.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", statePath)
	t.Setenv("CF_MONITOR_KOMARI_NET_STATIC_FILE", komariPath)

	now := time.Date(2026, time.June, 10, 12, 0, 0, 0, time.UTC)
	periodStart := lastTrafficResetDate(1, now)
	fixture := map[string]any{
		"interfaces": map[string]any{
			"eth0": []map[string]uint64{
				{"timestamp": uint64(periodStart.Add(time.Minute).Unix()), "tx": 100, "rx": 200},
				{"timestamp": uint64(now.Add(time.Minute).Unix()), "tx": 3000, "rx": 4000},
			},
			"lo": []map[string]uint64{
				{"timestamp": uint64(periodStart.Add(time.Minute).Unix()), "tx": 5000, "rx": 6000},
			},
		},
	}
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(komariPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	tracker := newTrafficResetTracker(1, "token", "wan")
	bootedBeforePeriod := time.Date(2026, time.May, 10, 12, 0, 0, 0, time.UTC)
	up, down := tracker.adjustSinceBoot(50, 70, now, bootedBeforePeriod)
	if up != 0 || down != 0 {
		t.Fatalf("monthly traffic = %d/%d, want 0/0 because external Komari history must not be imported", up, down)
	}
}

func TestTrafficResetTrackerDropsPreviousMonthlyPeriod(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", statePath)

	tracker := newTrafficResetTracker(15, "token", "wan")
	beforeReset := time.Date(2026, time.June, 14, 23, 0, 0, 0, time.UTC)
	bootedBeforePeriod := time.Date(2026, time.May, 10, 12, 0, 0, 0, time.UTC)
	tracker.adjustSinceBoot(1000, 1000, beforeReset, bootedBeforePeriod)
	tracker.adjustSinceBoot(1800, 1900, beforeReset.Add(time.Minute), bootedBeforePeriod)

	afterReset := time.Date(2026, time.June, 15, 0, 1, 0, 0, time.UTC)
	up, down := tracker.adjustSinceBoot(2000, 2200, afterReset, bootedBeforePeriod)
	if up != 200 || down != 300 {
		t.Fatalf("monthly traffic after reset day = %d/%d, want 200/300", up, down)
	}
}

func TestSumNetworkCountersExcludesCommonVirtualInterfacesByDefault(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "eth0", BytesSent: 100, BytesRecv: 200},
		{Name: "lo", BytesSent: 1000, BytesRecv: 2000},
		{Name: "Loopback Pseudo-Interface 1", BytesSent: 1000, BytesRecv: 2000},
		{Name: "docker0", BytesSent: 3000, BytesRecv: 4000},
		{Name: "vethabc", BytesSent: 5000, BytesRecv: 6000},
	}

	up, down := sumNetworkCounters(counters, "", "")
	if up != 100 || down != 200 {
		t.Fatalf("network totals = %d/%d, want physical interface totals 100/200", up, down)
	}
}

func TestNormalizeTrafficResetDay(t *testing.T) {
	for input, want := range map[int]int{-1: 1, 0: 1, 1: 1, 15: 15, 31: 31, 32: 31} {
		if got := normalizeTrafficResetDay(input); got != want {
			t.Fatalf("normalizeTrafficResetDay(%d) = %d, want %d", input, got, want)
		}
	}
}

func TestPostJSONWithContextSendsBearerJSON(t *testing.T) {
	var received map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("Content-Type = %q, want application/json", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer agent-token" {
			t.Fatalf("Authorization = %q, want Bearer token", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	err := postJSONWithContext(context.Background(), server.URL, map[string]string{"status": "ok"}, "agent-token")
	if err != nil {
		t.Fatalf("postJSONWithContext() error = %v", err)
	}
	if received["status"] != "ok" {
		t.Fatalf("request body status = %q, want ok", received["status"])
	}
}

func TestPreparedReportDoesNotSerializeToken(t *testing.T) {
	oldToken := token
	token = "agent-secret"
	defer func() { token = oldToken }()

	report := (&reportPreparer{}).prepareReportForInterval(Report{Timestamp: 1000}, 3)
	report.hasRawNetTotals = true
	report.rawNetTotalUp = 123
	report.rawNetTotalDown = 456
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	bodyText := string(body)
	if strings.Contains(bodyText, "agent-secret") || strings.Contains(bodyText, `"token"`) ||
		strings.Contains(bodyText, "rawNet") || strings.Contains(bodyText, "hasRaw") {
		t.Fatalf("prepared report leaked internal fields in body: %s", body)
	}
}

func TestPreparedReportUsesRawCountersForNetworkSpeed(t *testing.T) {
	preparer := &reportPreparer{}
	preparer.prepareReportForInterval(Report{
		Timestamp:    1000,
		NetTotalUp:   5000,
		NetTotalDown: 8000,
	}, 10)

	report := preparer.prepareReportForInterval(Report{
		Timestamp:    11_000,
		NetTotalUp:   200,
		NetTotalDown: 300,
	}, 10)
	if report.NetOut != 0 || report.NetIn != 0 {
		t.Fatalf("speed without raw counters = %d/%d, want 0/0 after monthly total reset", report.NetOut, report.NetIn)
	}

	preparer = &reportPreparer{}
	preparer.prepareReportForInterval(Report{
		Timestamp:       1000,
		NetTotalUp:      5000,
		NetTotalDown:    8000,
		hasRawNetTotals: true,
		rawNetTotalUp:   50_000,
		rawNetTotalDown: 80_000,
	}, 10)

	report = preparer.prepareReportForInterval(Report{
		Timestamp:       11_000,
		NetTotalUp:      200,
		NetTotalDown:    300,
		hasRawNetTotals: true,
		rawNetTotalUp:   50_400,
		rawNetTotalDown: 80_900,
	}, 10)
	if report.NetOut != 40 || report.NetIn != 90 {
		t.Fatalf("speed from raw counters = %d/%d, want 40/90", report.NetOut, report.NetIn)
	}
}

func TestPostJSONWithContextReturnsHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
	}))
	defer server.Close()

	err := postJSONWithContext(context.Background(), server.URL, map[string]string{"status": "ok"}, "agent-token")
	if err == nil || !strings.Contains(err.Error(), "HTTP 413") {
		t.Fatalf("postJSONWithContext() error = %v, want HTTP 413", err)
	}
}

func TestPostJSONWithContextTruncatesLargeHTTPErrorBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_, _ = w.Write([]byte(strings.Repeat("x", maxHTTPErrorBodyBytes+2048)))
	}))
	defer server.Close()

	err := postJSONWithContext(context.Background(), server.URL, map[string]string{"status": "ok"}, "agent-token")
	if err == nil {
		t.Fatal("postJSONWithContext() error = nil, want HTTP error")
	}
	if got := err.Error(); !strings.Contains(got, "HTTP 413") || !strings.Contains(got, "truncated") {
		t.Fatalf("postJSONWithContext() error = %q, want truncated HTTP 413", got)
	}
	if len(err.Error()) > maxHTTPErrorBodyBytes+128 {
		t.Fatalf("postJSONWithContext() error length = %d, want bounded detail", len(err.Error()))
	}
}

func TestPingTargetIPBoundary(t *testing.T) {
	blocked := []string{
		"0.0.0.0",
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.1.1",
		"172.16.0.1",
		"192.0.2.1",
		"192.168.1.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"::1",
		"100::1",
		"2001:db8::1",
		"fc00::1",
		"fe80::1",
		"ff02::1",
	}
	for _, raw := range blocked {
		if !isBlockedTargetIP(net.ParseIP(raw)) {
			t.Fatalf("isBlockedTargetIP(%q) = false, want true", raw)
		}
	}
	for _, raw := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if isBlockedTargetIP(net.ParseIP(raw)) {
			t.Fatalf("isBlockedTargetIP(%q) = true, want false", raw)
		}
	}
}

func TestResolvePublicIPsBlocksLocalTargets(t *testing.T) {
	for _, host := range []string{"localhost", "api.localhost", "metadata.google.internal", "127.0.0.1", "10.0.0.1", "[::1]"} {
		if ips, err := resolvePublicIPs(context.Background(), host); err == nil {
			t.Fatalf("resolvePublicIPs(%q) = %v, want error", host, ips)
		}
	}
}

func TestExecuteICMPPingUsesResolvedPublicIP(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "ping-args.txt")
	var script string
	if runtime.GOOS == "windows" {
		script = filepath.Join(dir, "ping.bat")
		if err := os.WriteFile(script, []byte("@echo off\r\necho %* > \"%PING_ARGS_FILE%\"\r\nexit /b 0\r\n"), 0o755); err != nil {
			t.Fatalf("write fake ping: %v", err)
		}
	} else {
		script = filepath.Join(dir, "ping")
		if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$PING_ARGS_FILE\"\nexit 0\n"), 0o755); err != nil {
			t.Fatalf("write fake ping: %v", err)
		}
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(script, 0o755); err != nil {
			t.Fatalf("chmod fake ping: %v", err)
		}
	}
	t.Setenv("PING_ARGS_FILE", argsFile)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	if elapsed := executeICMPPing("[2606:4700:4700::1111]"); elapsed < 0 {
		t.Fatalf("executeICMPPing() = %v, want successful fake ping", elapsed)
	}
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read fake ping args: %v", err)
	}
	args := strings.Fields(strings.TrimSpace(string(raw)))
	if len(args) == 0 {
		t.Fatalf("fake ping args = %q, want command arguments", raw)
	}
	if got, want := args[len(args)-1], "2606:4700:4700::1111"; got != want {
		t.Fatalf("ping target = %q, want resolved IP %q", got, want)
	}
}

func TestLinuxServiceAllowsIcmpPingCapability(t *testing.T) {
	raw, err := os.ReadFile("install-linux.sh")
	if err != nil {
		t.Fatalf("read install-linux.sh: %v", err)
	}
	unit := string(raw)
	for _, want := range []string{
		"AmbientCapabilities=CAP_NET_RAW",
		"CapabilityBoundingSet=CAP_NET_RAW",
		"NoNewPrivileges=true",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("install-linux.sh missing %s", want)
		}
	}
}

func TestUniversalInstallerSupportsOpenRCAndUserMode(t *testing.T) {
	raw, err := os.ReadFile("install.sh")
	if err != nil {
		t.Fatalf("read install.sh: %v", err)
	}
	script := string(raw)
	for _, want := range []string{
		"#!/bin/sh",
		"rc-update add",
		"rc-service",
		"nohup",
		"crontab",
		"cf-vps-monitor:",
		"freebsd",
		"install_mode",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("install.sh missing %s", want)
		}
	}
}

func TestAgentReleasePublishesUniversalInstallerAndFreeBSD(t *testing.T) {
	raw, err := os.ReadFile("../.github/workflows/release-agent.yml")
	if err != nil {
		t.Fatalf("read release-agent.yml: %v", err)
	}
	workflow := string(raw)
	for _, want := range []string{
		"build freebsd amd64 cf-vps-monitor-agent-freebsd-amd64",
		"cp install.sh dist/install.sh",
		"cp install-linux.sh dist/install-linux.sh",
		"SHA256SUMS",
	} {
		if !strings.Contains(workflow, want) {
			t.Fatalf("release-agent.yml missing %s", want)
		}
	}
}

func TestExecuteTCPPingExcludesDNSResolutionTime(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp: %v", err)
	}
	defer ln.Close()

	accepted := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			_ = conn.Close()
		}
		close(accepted)
	}()

	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split listener address: %v", err)
	}

	oldResolve := resolvePublicIPsForPing
	resolveDelay := 400 * time.Millisecond
	resolvePublicIPsForPing = func(context.Context, string) ([]net.IP, error) {
		time.Sleep(resolveDelay)
		return []net.IP{net.ParseIP("127.0.0.1")}, nil
	}
	t.Cleanup(func() { resolvePublicIPsForPing = oldResolve })

	elapsed := executeTCPPing(net.JoinHostPort("example.test", port))
	if elapsed < 0 {
		t.Fatalf("executeTCPPing() = %v, want successful TCP ping", elapsed)
	}
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("tcp listener did not accept connection")
	}
	if elapsed >= float64(resolveDelay.Milliseconds()/2) {
		t.Fatalf("executeTCPPing() = %.0fms, want DNS resolution time excluded", elapsed)
	}
}

func TestFetchPublicIPFromURLsKeepsOnlyRequestedPublicFamily(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("10.0.0.2 203.0.113.10 8.8.8.8 fc00::1 2001:db8::1 2606:4700:4700::1111"))
	}))
	defer server.Close()

	if got := fetchPublicIPFromURLs(context.Background(), server.Client(), []string{server.URL}, false); got != "8.8.8.8" {
		t.Fatalf("fetchPublicIPFromURLs(v4) = %q, want 8.8.8.8", got)
	}
	if got := fetchPublicIPFromURLs(context.Background(), server.Client(), []string{server.URL}, true); got != "2606:4700:4700::1111" {
		t.Fatalf("fetchPublicIPFromURLs(v6) = %q, want 2606:4700:4700::1111", got)
	}
}

func TestWebsiteHTTPProbeReportsStatusAndLatency(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	result := executeWebsiteHTTPProbeWithClient(WebsiteProbeTask{
		ID:                1,
		URL:               server.URL,
		Method:            "GET",
		ExpectedStatusMin: 200,
		ExpectedStatusMax: 299,
		TimeoutSec:        5,
	}, server.Client())

	if !result.OK || result.EffectiveStatus != "up" || result.StatusCode == nil || *result.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.LatencyMS < 0 {
		t.Fatalf("latency = %d, want non-negative", result.LatencyMS)
	}
}

func TestNormalizeTCPTargetAddress(t *testing.T) {
	address, host, port, err := normalizeTCPTargetAddress("example.com")
	if err != nil {
		t.Fatalf("normalizeTCPTargetAddress() error = %v", err)
	}
	if address != "example.com:80" || host != "example.com" || port != "80" {
		t.Fatalf("normalizeTCPTargetAddress(example.com) = %q %q %q", address, host, port)
	}

	address, host, port, err = normalizeTCPTargetAddress("2606:4700:4700::1111")
	if err != nil {
		t.Fatalf("normalizeTCPTargetAddress(bare ipv6) error = %v", err)
	}
	if address != "[2606:4700:4700::1111]:80" || host != "2606:4700:4700::1111" || port != "80" {
		t.Fatalf("normalizeTCPTargetAddress(bare ipv6) = %q %q %q", address, host, port)
	}

	address, host, port, err = normalizeTCPTargetAddress("[2606:4700:4700::1111]:443")
	if err != nil {
		t.Fatalf("normalizeTCPTargetAddress(ipv6) error = %v", err)
	}
	if address != "[2606:4700:4700::1111]:443" || host != "2606:4700:4700::1111" || port != "443" {
		t.Fatalf("normalizeTCPTargetAddress(ipv6) = %q %q %q", address, host, port)
	}
}
