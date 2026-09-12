package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
)

func TestContainerMetricsUnknownReportJSON(t *testing.T) {
	report := Report{
		CPU: 17, RAM: 46612480, RAMTotal: 128000000,
		BasicInfo: &BasicInfo{DiskTotal: 1055735824384, Uptime: 330000},
	}
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"disk", "disk_total", "uptime"} {
		t.Run(name, func(t *testing.T) {
			if string(fields[name]) != "null" {
				t.Fatalf("unavailable %s = %s, want explicit JSON null", name, fields[name])
			}
		})
	}
	if string(fields["cpu"]) != "17" || string(fields["ram_total"]) != "128000000" {
		t.Fatal("known container metrics changed while encoding unavailable metrics")
	}
}

const independentContainerMount = "31 20 253:1 / / rw,relatime - ext4 /dev/mapper/vg-container rw\n"
const sharedContainerMount = "31 20 253:0 /containers/example/rootfs / rw,relatime,idmapped - ext4 /dev/bcache0 rw\n"
const lxcfsUptimeMount = "32 20 0:54 /proc/uptime /proc/uptime rw,nosuid,nodev - fuse.lxcfs lxcfs rw,allow_other\n"

func containerMetricFixture(t *testing.T, mountinfo string) nodeMetricSource {
	t.Helper()
	root := t.TempDir()
	writeFileTree(t, root, map[string]string{
		"run/systemd/container": "lxc\n",
		"proc/self/mountinfo":   mountinfo,
		"proc/uptime":           "123.45 456.78\n",
	})
	return nodeMetricSource{
		platform: "linux",
		root:     root,
		partitions: func(all bool) ([]disk.PartitionStat, error) {
			if !all {
				t.Fatal("disk selection must see the actual mount list")
			}
			return []disk.PartitionStat{{Device: "/dev/mapper/vg-container", Mountpoint: "/", Fstype: "ext4"}}, nil
		},
		diskUsage: func(name string) (*disk.UsageStat, error) {
			return &disk.UsageStat{Path: name, Total: 100, Used: 20}, nil
		},
		hostUptime: func() (uint64, error) { return 9000000, nil },
	}
}

func assertContainerMetricInt(t *testing.T, label string, got *int64, want int64) {
	t.Helper()
	if want < 0 {
		if got != nil {
			t.Errorf("%s = %d, want unavailable", label, *got)
		}
		return
	}
	if got == nil {
		t.Errorf("%s = unavailable, want %d", label, want)
	} else if *got != want {
		t.Errorf("%s = %d, want %d", label, *got, want)
	}
}

func TestContainerMetricsDiskScope(t *testing.T) {
	for _, tc := range []struct {
		name, mountinfo, fstype, source string
		want                            int64
	}{
		{"independent ext4", independentContainerMount, "ext4", "/dev/mapper/vg-container", 100},
		{"independent xfs", "31 20 253:1 / / rw - xfs /dev/mapper/vg-container rw\n", "xfs", "/dev/dm-1", 100},
		{"shared host directory", sharedContainerMount, "ext4", "/dev/bcache0", -1},
		{"escaped shared directory", "31 20 253:1 /containers/name\\040space/rootfs / rw - ext4 /dev/vda1 rw\n", "ext4", "/dev/vda1", -1},
		{"overlay host backing store", "31 20 0:10 / / rw - overlay overlay rw,lowerdir=/lower,upperdir=/upper\n", "overlay", "overlay", -1},
		{"unproven zfs quota", "31 20 0:10 / / rw - zfs pool/container rw\n", "zfs", "pool/container", -1},
		{"unproven btrfs subvolume", "31 20 0:10 /@container / rw - btrfs /dev/vda1 rw\n", "btrfs", "/dev/vda1", -1},
		{"unidentified block source", "31 20 0:10 / / rw - ext4 none rw\n", "ext4", "none", -1},
		{"conflicting stacked mount", independentContainerMount + "32 20 0:10 / / rw - overlay overlay rw\n", "ext4", "/dev/mapper/vg-container", -1},
		{"missing root mount", lxcfsUptimeMount, "ext4", "/dev/mapper/vg-container", -1},
		{"malformed mount evidence", "31 20 253:1 / / rw ext4 /dev/vda1\n", "ext4", "/dev/vda1", -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := containerMetricFixture(t, tc.mountinfo)
			source.partitions = func(bool) ([]disk.PartitionStat, error) {
				return []disk.PartitionStat{{Device: tc.source, Mountpoint: "/", Fstype: tc.fstype}}, nil
			}
			var calls int
			source.diskUsage = func(name string) (*disk.UsageStat, error) {
				calls++
				return &disk.UsageStat{Path: name, Used: 20, Total: 100}, nil
			}
			used, total := source.diskUsageTotals("", "")
			wantUsed := int64(20)
			if tc.want < 0 {
				wantUsed = -1
				if calls != 0 {
					t.Errorf("sampled %d unproven host filesystems", calls)
				}
			}
			assertContainerMetricInt(t, "disk used", used, wantUsed)
			assertContainerMetricInt(t, "disk total", total, tc.want)
		})
	}
}

func TestContainerMetricsDiskFiltersAndAggregation(t *testing.T) {
	for _, tc := range []struct {
		name, include, exclude string
		container              bool
		used, total            int64
	}{
		{"container cannot count host bind", "", "", true, -1, -1},
		{"exclude shared bind", "", "/shared", true, 20, 100},
		{"explicit root", "/", "", true, 20, 100},
		{"explicit host bind stays unknown", "/shared", "", true, -1, -1},
		{"exclude wins over include", "/", "/", true, -1, -1},
		{"bare metal preserves device dedup", "", "", false, 900, 10000},
		{"bare metal preserves explicit mount sum", "/,/shared", "", false, 920, 10100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := containerMetricFixture(t, independentContainerMount+"32 20 253:1 /host/shared /shared rw - ext4 /dev/mapper/vg-container rw\n")
			if !tc.container {
				if err := os.Remove(filepath.Join(source.root, "run", "systemd", "container")); err != nil {
					t.Fatal(err)
				}
			}
			source.partitions = func(bool) ([]disk.PartitionStat, error) {
				return []disk.PartitionStat{
					{Device: "/dev/mapper/vg-container", Mountpoint: "/", Fstype: "ext4"},
					{Device: "/dev/mapper/vg-container", Mountpoint: "/shared", Fstype: "ext4"},
					{Device: "tmpfs", Mountpoint: "/run", Fstype: "tmpfs"},
				}, nil
			}
			source.diskUsage = func(name string) (*disk.UsageStat, error) {
				switch name {
				case "/":
					return &disk.UsageStat{Path: name, Used: 20, Total: 100}, nil
				case "/shared":
					return &disk.UsageStat{Path: name, Used: 900, Total: 10000}, nil
				default:
					t.Fatalf("unexpected disk path %q", name)
					return nil, errors.New("unexpected disk path")
				}
			}
			used, total := source.diskUsageTotals(tc.include, tc.exclude)
			assertContainerMetricInt(t, "used", used, tc.used)
			assertContainerMetricInt(t, "total", total, tc.total)
		})
	}
}

func TestContainerMetricsDiskReadFailures(t *testing.T) {
	for _, name := range []string{"partitions", "mountinfo", "usage", "zero total", "used exceeds total", "overflow", "partial multiple disks"} {
		t.Run(name, func(t *testing.T) {
			source := containerMetricFixture(t, independentContainerMount)
			switch name {
			case "partitions":
				source.partitions = func(bool) ([]disk.PartitionStat, error) { return nil, errors.New("denied") }
			case "mountinfo":
				if err := os.Remove(filepath.Join(source.root, "proc", "self", "mountinfo")); err != nil {
					t.Fatal(err)
				}
			case "usage":
				source.diskUsage = func(string) (*disk.UsageStat, error) { return nil, errors.New("denied") }
			case "zero total":
				source.diskUsage = func(string) (*disk.UsageStat, error) { return &disk.UsageStat{}, nil }
			case "used exceeds total":
				source.diskUsage = func(string) (*disk.UsageStat, error) { return &disk.UsageStat{Used: 101, Total: 100}, nil }
			case "overflow":
				source.diskUsage = func(string) (*disk.UsageStat, error) { return &disk.UsageStat{Total: 1 << 63}, nil }
			case "partial multiple disks":
				writeFileTree(t, source.root, map[string]string{"proc/self/mountinfo": independentContainerMount + "32 20 253:2 / /data rw - xfs /dev/vdb1 rw\n"})
				source.partitions = func(bool) ([]disk.PartitionStat, error) {
					return []disk.PartitionStat{{Device: "/dev/mapper/vg-container", Mountpoint: "/", Fstype: "ext4"}, {Device: "/dev/vdb1", Mountpoint: "/data", Fstype: "xfs"}}, nil
				}
				source.diskUsage = func(name string) (*disk.UsageStat, error) {
					if name == "/data" {
						return nil, errors.New("denied")
					}
					return &disk.UsageStat{Used: 20, Total: 100}, nil
				}
			}
			used, total := source.diskUsageTotals("", "")
			assertContainerMetricInt(t, "used", used, -1)
			assertContainerMetricInt(t, "total", total, -1)
		})
	}
}

func TestContainerMetricsUptimeSource(t *testing.T) {
	for _, tc := range []struct {
		name, mountinfo, contents string
		want                      int64
	}{
		{"lxcfs seconds", lxcfsUptimeMount, "123.45 456.78\n", 123},
		{"measured zero", lxcfsUptimeMount, "0.00 0.00\n", 0},
		{"native proc is not container proof", "32 20 0:1 / /proc rw - proc proc rw\n", "9000000.00 0.00\n", -1},
		{"lxcfs elsewhere is not uptime proof", "32 20 0:54 /proc/stat /proc/stat rw - fuse.lxcfs lxcfs rw\n", "9000000.00 0.00\n", -1},
		{"missing mount", "", "9000000.00 0.00\n", -1},
		{"negative", lxcfsUptimeMount, "-1.00 0\n", -1},
		{"empty", lxcfsUptimeMount, "", -1},
		{"not a number", lxcfsUptimeMount, "NaN 0\n", -1},
		{"infinity", lxcfsUptimeMount, "+Inf 0\n", -1},
		{"overflow", lxcfsUptimeMount, "9223372036854775808 0\n", -1},
		{"nonnumeric", lxcfsUptimeMount, "oops 0\n", -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := containerMetricFixture(t, independentContainerMount+tc.mountinfo)
			writeFileTree(t, source.root, map[string]string{"proc/uptime": tc.contents})
			var calls int
			source.hostUptime = func() (uint64, error) { calls++; return 9000000, nil }
			assertContainerMetricInt(t, "uptime", source.uptime(), tc.want)
			if calls != 0 {
				t.Errorf("container uptime fell back to host uptime %d times", calls)
			}
		})
	}
	t.Run("unreadable uptime", func(t *testing.T) {
		source := containerMetricFixture(t, independentContainerMount+lxcfsUptimeMount)
		if err := os.Remove(filepath.Join(source.root, "proc", "uptime")); err != nil {
			t.Fatal(err)
		}
		assertContainerMetricInt(t, "uptime", source.uptime(), -1)
	})
	for _, platform := range []string{"linux", "windows", "darwin", "freebsd"} {
		t.Run("original host uptime on "+platform, func(t *testing.T) {
			source := containerMetricFixture(t, "")
			source.platform, source.root = platform, t.TempDir()
			assertContainerMetricInt(t, "uptime", source.uptime(), 9000000)
			source.hostUptime = func() (uint64, error) { return 0, errors.New("unavailable") }
			assertContainerMetricInt(t, "failed host uptime", source.uptime(), -1)
		})
	}
}

func TestContainerMetricsTemperatureScope(t *testing.T) {
	previous := nodeTemperatureSampler
	t.Cleanup(func() { nodeTemperatureSampler = previous })
	for _, tc := range []struct {
		name, platform string
		files          map[string]string
		container      bool
	}{
		{"systemd lxc", "linux", map[string]string{"run/systemd/container": "lxc\n"}, true},
		{"lxcfs on Alpine", "linux", map[string]string{"proc/mounts": "lxcfs /proc/stat fuse.lxcfs rw 0 0\n"}, true},
		{"lxc boot marker", "linux", map[string]string{"dev/.lxc-boot-id": "fixture"}, true},
		{"cgroup self marker", "linux", map[string]string{"proc/self/cgroup": "0::/lxc/example\n"}, true},
		{"docker", "linux", map[string]string{".dockerenv": ""}, true},
		{"podman", "linux", map[string]string{"run/.containerenv": ""}, true},
		{"bare metal", "linux", map[string]string{"proc/mounts": "/dev/vda1 / ext4 rw 0 0\n"}, false},
		{"physical host running LXCFS", "linux", map[string]string{"proc/mounts": "lxcfs /var/lib/lxcfs fuse.lxcfs rw 0 0\n"}, false},
		{"non-Linux with incidental marker", "windows", map[string]string{".dockerenv": ""}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := containerMetricFixture(t, "")
			source.root, source.platform = t.TempDir(), tc.platform
			writeFileTree(t, source.root, tc.files)
			var calls atomic.Int32
			nodeTemperatureSampler = newHostTemperatureSampler("linux", func(context.Context) ([]host.TemperatureStat, error) {
				calls.Add(1)
				return []host.TemperatureStat{{SensorKey: "coretemp_package_id_0", Temperature: 60}}, nil
			})
			value := source.temperature(context.Background())
			if tc.container {
				if value != nil || calls.Load() != 0 {
					t.Fatal("container reported or sampled a host hardware sensor")
				}
			} else if value == nil || *value != 60 || calls.Load() != 1 {
				t.Fatal("noncontainer host sensor behavior changed")
			}
		})
	}
}

func TestContainerMetricsCollectorWiring(t *testing.T) {
	for _, tc := range []struct {
		trustedUptime   bool
		configuredTotal string
		wantTotal       int64
	}{
		{false, "0", -1},
		{true, "0", -1},
		{true, "5024000000", 5024000000},
	} {
		t.Run(fmt.Sprintf("trusted uptime %t capacity %s", tc.trustedUptime, tc.configuredTotal), func(t *testing.T) {
			containerDiskConfigFixture(t)
			t.Setenv(containerDiskConfigEnv, tc.configuredTotal)
			applyEnvDefaults()
			preparer, _ := basicInfoDeliveryFixture(t)
			previousSource, previousSampler, previousTraffic := nodeMetrics, nodeTemperatureSampler, trafficTracker
			previousInclude, previousExclude := mountInclude, mountExclude
			t.Cleanup(func() {
				nodeMetrics, nodeTemperatureSampler, trafficTracker = previousSource, previousSampler, previousTraffic
				mountInclude, mountExclude = previousInclude, previousExclude
			})
			mountinfo := sharedContainerMount
			if tc.trustedUptime {
				mountinfo += lxcfsUptimeMount
			}
			nodeMetrics = containerMetricFixture(t, mountinfo)
			nodeMetrics.partitions = func(bool) ([]disk.PartitionStat, error) {
				return []disk.PartitionStat{{Device: "/dev/bcache0", Mountpoint: "/", Fstype: "ext4"}}, nil
			}
			nodeMetrics.diskUsage = func(string) (*disk.UsageStat, error) {
				return &disk.UsageStat{Used: 12951896064, Total: 1055735824384}, nil
			}
			var reads atomic.Int32
			nodeTemperatureSampler = newHostTemperatureSampler("linux", func(context.Context) ([]host.TemperatureStat, error) {
				reads.Add(1)
				return []host.TemperatureStat{{SensorKey: "coretemp", Temperature: 60}}, nil
			})
			trafficTracker, mountInclude, mountExclude = nil, "", ""
			gpuDetailsMu.Lock()
			globalGPUDetails = nil
			gpuDetailsMu.Unlock()
			// Avoid real GPU/virtualization subprocesses in this source fixture.
			t.Setenv("PATH", t.TempDir())
			report := collectReportWithInterval(3)
			preparer.attachBasicInfoIfDue(&report, time.Now())
			wantBasicTotal := max(tc.wantTotal, 0)
			if report.BasicInfo == nil || report.BasicInfo.DiskTotal != wantBasicTotal {
				t.Errorf("basic disk total did not match verified capacity: %#v", report.BasicInfo)
			}
			wantUptime, wantBasicUptime := int64(-1), int64(0)
			if tc.trustedUptime {
				wantUptime, wantBasicUptime = 123, 123
			}
			assertContainerMetricInt(t, "report uptime", report.Uptime, wantUptime)
			if report.BasicInfo != nil && report.BasicInfo.Uptime != wantBasicUptime {
				t.Errorf("basic uptime = %d, want %d", report.BasicInfo.Uptime, wantBasicUptime)
			}
			assertContainerMetricInt(t, "reported total", report.DiskTotal, tc.wantTotal)
			if report.Disk != nil || report.Temp != nil || reads.Load() != 0 {
				t.Error("normal report collector retained host disk or temperature")
			}
			data, err := json.Marshal(report)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(data, &fields); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"disk", "temp"} {
				if string(fields[name]) != "null" {
					t.Errorf("prepared report %s = %s, want null", name, fields[name])
				}
			}
			if report.ReportInterval != 3 || report.Timestamp <= 0 || report.RAMTotal <= 0 {
				t.Error("normal interval, timestamp or memory collection was lost")
			}
		})
	}
}
