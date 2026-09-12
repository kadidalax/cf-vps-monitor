package main

import (
	"encoding/json"
	"errors"
	"flag"
	"strings"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v3/disk"
)

// This boundary fixture catches fallback being ignored, leaking host statfs,
// applying the root cache to another disk, or clamping allocation overruns.
func TestDirectoryDiskFallback(t *testing.T) {
	for _, tc := range []struct {
		name, mountinfo, include, exclude string
		cacheErr                          bool
		configured, used, total           int64
		wantUsed, wantTotal               int64
		wantCache                         bool
	}{
		{"shared root cache", sharedContainerMount, "", "", false, 0, 8388608, 5024000000, 8388608, 5024000000, true},
		{"explicit root", sharedContainerMount, "/", "", false, 0, 8388608, 5024000000, 8388608, 5024000000, true},
		{"root excluded", sharedContainerMount, "", "/", false, 0, 8388608, 5024000000, -1, -1, false},
		{"other requested mount", sharedContainerMount, "/data", "", false, 0, 8388608, 5024000000, -1, -1, false},
		{"native filesystem", independentContainerMount, "", "", false, 0, 8388608, 5024000000, 20, 100, false},
		{"wrong cache root", sharedContainerMount, "", "", true, 5024000000, 8388608, 5024000000, -1, 5024000000, true},
		{"over allocation remains visible", sharedContainerMount, "", "", false, 0, 6000000000, 5024000000, 6000000000, 5024000000, true},
		{"explicit capacity wins", sharedContainerMount, "", "", false, 7000000000, 8388608, 5024000000, 8388608, 7000000000, true},
		{"usage without capacity", sharedContainerMount, "", "", false, 0, 8388608, -1, 8388608, -1, true},
		{"real empty root", sharedContainerMount, "", "", false, 0, 0, 5024000000, 0, 5024000000, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previousTotal, previousFile := containerDiskTotalBytes, diskUsageFile
			t.Cleanup(func() { containerDiskTotalBytes, diskUsageFile = previousTotal, previousFile })
			containerDiskTotalBytes, diskUsageFile = containerDiskTotalValue(tc.configured), "/run/cf-vps-monitor-disk/synthetic/usage.json"
			source := containerMetricFixture(t, tc.mountinfo)
			cacheCalls, hostCalls := 0, 0
			source.diskCache = func(root, filename string, now time.Time) (diskUsageSnapshot, error) {
				cacheCalls++
				if root != source.root || filename != diskUsageFile || now.IsZero() {
					t.Fatal("cache reader was not bound to the selected root, configured file and current time")
				}
				if tc.cacheErr {
					return diskUsageSnapshot{}, errors.New("cache root identity mismatch")
				}
				used := tc.used
				sample := diskUsageSnapshot{used: &used, source: "directory", sampledAt: 1789100000000}
				if tc.total >= 0 {
					total := tc.total
					sample.total = &total
				}
				return sample, nil
			}
			source.diskUsage = func(string) (*disk.UsageStat, error) {
				hostCalls++
				return &disk.UsageStat{Used: 20, Total: 100}, nil
			}
			used, total := source.diskUsageTotals(tc.include, tc.exclude)
			assertContainerMetricInt(t, "used", used, tc.wantUsed)
			assertContainerMetricInt(t, "total", total, tc.wantTotal)
			if (cacheCalls != 0) != tc.wantCache {
				t.Errorf("cache reads = %d, want fallback %t", cacheCalls, tc.wantCache)
			}
			if tc.mountinfo == sharedContainerMount && hostCalls != 0 {
				t.Error("shared root sampled host statfs")
			}
		})
	}
}

func TestDirectoryDiskCacheDocument(t *testing.T) {
	const raw = `{"version":1,"scope":"root","source":"directory","used_bytes":8388608,"total_bytes":5024000000,"sampled_at":1789100000000,"root_dev":2049,"root_ino":1234,"boot_id":"e213fcde-1109-4de9-a67f-319f734be915","complete":true}`
	identity := diskRootIdentity{dev: 2049, ino: 1234, bootID: "e213fcde-1109-4de9-a67f-319f734be915"}
	now := time.UnixMilli(1789100000000)
	for _, tc := range []struct {
		name, old, new string
		age            time.Duration
		valid          bool
		used, total    int64
	}{
		{"fresh", "", "", 0, true, 8388608, 5024000000},
		{"zero is known", `"used_bytes":8388608`, `"used_bytes":0`, 0, true, 0, 5024000000},
		{"over allocation", `"used_bytes":8388608`, `"used_bytes":6000000000`, 0, true, 6000000000, 5024000000},
		{"unknown total", `"total_bytes":5024000000,`, ``, 0, true, 8388608, -1},
		{"expiry boundary", "", "", 900 * time.Second, true, 8388608, 5024000000},
		{"future tolerance", "", "", -5 * time.Second, true, 8388608, 5024000000},
		{"expired", "", "", 900*time.Second + time.Millisecond, false, 0, 0},
		{"future", "", "", -5*time.Second - time.Millisecond, false, 0, 0},
		{"wrong version", `"version":1`, `"version":2`, 0, false, 0, 0},
		{"wrong scope", `"scope":"root"`, `"scope":"other"`, 0, false, 0, 0},
		{"wrong source", `"source":"directory"`, `"source":"quota"`, 0, false, 0, 0},
		{"partial", `"complete":true`, `"complete":false`, 0, false, 0, 0},
		{"missing used", `"used_bytes":8388608,`, ``, 0, false, 0, 0},
		{"null used", `"used_bytes":8388608`, `"used_bytes":null`, 0, false, 0, 0},
		{"negative used", `"used_bytes":8388608`, `"used_bytes":-1`, 0, false, 0, 0},
		{"fractional used", `"used_bytes":8388608`, `"used_bytes":1.5`, 0, false, 0, 0},
		{"huge used", `"used_bytes":8388608`, `"used_bytes":1000000000000001`, 0, false, 0, 0},
		{"zero total", `"total_bytes":5024000000`, `"total_bytes":0`, 0, false, 0, 0},
		{"huge total", `"total_bytes":5024000000`, `"total_bytes":1000000000000001`, 0, false, 0, 0},
		{"null total", `"total_bytes":5024000000`, `"total_bytes":null`, 0, false, 0, 0},
		{"negative total", `"total_bytes":5024000000`, `"total_bytes":-1`, 0, false, 0, 0},
		{"upper case negative total", `"total_bytes":5024000000`, `"TOTAL_BYTES":-1`, 0, false, 0, 0},
		{"mixed case huge total", `"total_bytes":5024000000`, `"Total_Bytes":1000000000000001`, 0, false, 0, 0},
		{"upper case null total", `"total_bytes":5024000000`, `"TOTAL_BYTES":null`, 0, false, 0, 0},
		{"noncanonical valid total", `"total_bytes":5024000000`, `"TOTAL_BYTES":5024000000`, 0, false, 0, 0},
		{"case duplicate total before canonical", `"total_bytes":5024000000`, `"TOTAL_BYTES":-1,"total_bytes":5024000000`, 0, false, 0, 0},
		{"case duplicate total after canonical", `"total_bytes":5024000000`, `"total_bytes":5024000000,"Total_Bytes":-1`, 0, false, 0, 0},
		{"case duplicate valid total", `"total_bytes":5024000000`, `"total_bytes":5024000000,"Total_Bytes":5024000000`, 0, false, 0, 0},
		{"noncanonical used", `"used_bytes":8388608`, `"USED_BYTES":8388608`, 0, false, 0, 0},
		{"wrong root device", `"root_dev":2049`, `"root_dev":2050`, 0, false, 0, 0},
		{"wrong root inode", `"root_ino":1234`, `"root_ino":1235`, 0, false, 0, 0},
		{"missing root identity", `"root_dev":2049,`, ``, 0, false, 0, 0},
		{"wrong boot", `e213fcde`, `ffffffff`, 0, false, 0, 0},
		{"missing time", `"sampled_at":1789100000000,`, ``, 0, false, 0, 0},
		{"trailing value", `}`, `} {}`, 0, false, 0, 0},
		{"duplicate field", `"used_bytes":8388608`, `"used_bytes":4,"used_bytes":8388608`, 0, false, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := raw
			if tc.old != "" {
				data = strings.Replace(data, tc.old, tc.new, 1)
			}
			sample, err := decodeDirectoryDiskCache([]byte(data), identity, now.Add(tc.age))
			if !tc.valid {
				if err == nil || sample.used != nil || sample.source != "" || sample.sampledAt != 0 {
					t.Fatalf("invalid cache emitted a measurement: %+v err=%v", sample, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			assertContainerMetricInt(t, "used", sample.used, tc.used)
			assertContainerMetricInt(t, "total", sample.total, tc.total)
			if sample.source != "directory" || sample.sampledAt != 1789100000000 {
				t.Fatal("reading cache changed source or sampling time")
			}
		})
	}
	if _, err := decodeDirectoryDiskCache([]byte(raw+strings.Repeat(" ", 4096)), identity, now); err == nil {
		t.Fatal("oversized cache accepted")
	}
}

func TestDirectoryDiskConfiguredSize(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  int64
	}{
		{"5024MB", 5024000000}, {"5GB", 5000000000}, {"5GiB", 5368709120}, {"65536", 65536},
		{"1.5MiB", 1572864}, {"1.25kB", 1250}, {"1KB", 1000}, {"128B", 128}, {"1PB", 1000000000000000},
		{"", -1}, {"0", -1}, {"0GB", -1}, {"-1GB", -1}, {"+1GB", -1}, {"1e3", -1},
		{"1gb", -1}, {"1G", -1}, {"1 GB", -1}, {"1.1B", -1}, {"NaNGB", -1}, {"2PB", -1}, {"999999999999999999999999TB", -1},
	} {
		t.Run(tc.input, func(t *testing.T) {
			got, err := parseContainerDiskSize(tc.input)
			if tc.want < 0 {
				if err == nil {
					t.Fatalf("invalid capacity %q accepted as %d", tc.input, got)
				}
			} else if err != nil || got != tc.want {
				t.Fatalf("capacity %q = %d, err=%v, want %d", tc.input, got, err, tc.want)
			}
		})
	}
}

func TestDirectoryDiskGuestDevices(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		want       int64
	}{
		{"root device", `{"root":{"type":"disk","path":"/","size":"5024MB"},"eth0":{"type":"nic"}}`, 5024000000},
		{"any root device name", `{"volume":{"type":"disk","path":"/","size":"5GiB"}}`, 5368709120},
		{"HTTP200 root listing", `["/1.0"]`, -1},
		{"no root", `{"other":{"type":"disk","path":"/data","size":"5GB"}}`, -1},
		{"wrong type", `{"root":{"type":"nic","path":"/","size":"5GB"}}`, -1},
		{"missing allocation", `{"root":{"type":"disk","path":"/"}}`, -1},
		{"ambiguous roots", `{"one":{"type":"disk","path":"/","size":"5GB"},"two":{"type":"disk","path":"/","size":"6GB"}}`, -1},
		{"invalid size", `{"root":{"type":"disk","path":"/","size":"-5GB"}}`, -1},
		{"trailing JSON", `{"root":{"type":"disk","path":"/","size":"5GB"}} {}`, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseContainerRootDevices([]byte(tc.body))
			if tc.want < 0 {
				if err == nil || got != 0 {
					t.Fatalf("non-device response supplied capacity=%d err=%v", got, err)
				}
			} else if err != nil || got != tc.want {
				t.Fatalf("root size=%d err=%v want=%d", got, err, tc.want)
			}
		})
	}
}

func TestDirectoryDiskCacheFlagPrecedence(t *testing.T) {
	for _, tc := range []struct {
		name, environment, want string
		args                    []string
	}{
		{"environment", "/run/admin/usage.json", "/run/admin/usage.json", nil},
		{"explicit CLI", "/run/env/usage.json", "/run/cli/usage.json", []string{"--disk-usage-file=/run/cli/usage.json"}},
		{"explicit disable", "/run/env/usage.json", "", []string{"--disk-usage-file="}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			oldFlags, oldFile := flag.CommandLine, diskUsageFile
			flags := containerDiskConfigFixture(t)
			t.Cleanup(func() { diskUsageFile = oldFile })
			diskUsageFile = ""
			if registered := oldFlags.Lookup("disk-usage-file"); registered != nil {
				flags.Var(registered.Value, "disk-usage-file", registered.Usage)
			}
			t.Setenv("CF_MONITOR_DISK_USAGE_FILE", tc.environment)
			if err := flags.Parse(tc.args); err != nil {
				t.Fatalf("cache flag rejected: %v", err)
			}
			applyEnvDefaults()
			if diskUsageFile != tc.want {
				t.Fatalf("cache file=%q want=%q", diskUsageFile, tc.want)
			}
		})
	}
}

func TestDirectoryDiskReportKeepsSampleTime(t *testing.T) {
	oldSource, oldFile, oldInclude, oldExclude, oldTotal := nodeMetrics, diskUsageFile, mountInclude, mountExclude, containerDiskTotalBytes
	t.Cleanup(func() {
		nodeMetrics, diskUsageFile, mountInclude, mountExclude, containerDiskTotalBytes = oldSource, oldFile, oldInclude, oldExclude, oldTotal
	})
	nodeMetrics = containerMetricFixture(t, sharedContainerMount)
	diskUsageFile, mountInclude, mountExclude, containerDiskTotalBytes = "/run/synthetic/usage.json", "", "", 0
	used, total := int64(8388608), int64(5024000000)
	reads := 0
	nodeMetrics.diskCache = func(string, string, time.Time) (diskUsageSnapshot, error) {
		reads++
		return diskUsageSnapshot{used: &used, total: &total, source: "directory", sampledAt: 1789100000000}, nil
	}
	// This path samples ordinary local metrics but has no report transport.
	t.Setenv("PATH", t.TempDir())
	report := collectReportWithInterval(3)
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	for field, want := range map[string]string{"disk": "8388608", "disk_total": "5024000000", "disk_source": `"directory"`, "disk_sampled_at": "1789100000000"} {
		if string(fields[field]) != want {
			t.Errorf("reported %s = %s want=%s", field, fields[field], want)
		}
	}
	if reads != 1 {
		t.Fatalf("report read %d independent disk samples, want one coherent snapshot", reads)
	}
	if report.Timestamp <= 1789100000000 {
		t.Error("disk sampling time replaced the report receipt-time input")
	}
}
