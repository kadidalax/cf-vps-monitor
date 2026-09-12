package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
)

// Match the Worker's counter limit so an accepted configuration is not
// silently truncated when its JSON report reaches the server.
const maxConfiguredContainerDiskTotalBytes = int64(1_000_000_000_000_000)

type containerDiskTotalValue int64

func (v *containerDiskTotalValue) String() string {
	if v == nil {
		return "0"
	}
	return strconv.FormatInt(int64(*v), 10)
}

func (v *containerDiskTotalValue) Set(raw string) error {
	value := strings.TrimSpace(raw)
	parsed, err := strconv.ParseInt(value, 10, 64)
	if value == "" || strings.Trim(value, "0123456789") != "" || err != nil || parsed < 0 || parsed > maxConfiguredContainerDiskTotalBytes {
		return fmt.Errorf("container disk total must be a decimal integer from 0 to %d bytes", maxConfiguredContainerDiskTotalBytes)
	}
	*v = containerDiskTotalValue(parsed)
	return nil
}

// Keep OS reads at this boundary so metric scope can be checked before a
// filesystem or a physical sensor is sampled.
type nodeMetricSource struct {
	platform   string
	root       string
	partitions func(bool) ([]disk.PartitionStat, error)
	diskUsage  func(string) (*disk.UsageStat, error)
	diskCache  func(string, string, time.Time) (diskUsageSnapshot, error)
	hostUptime func() (uint64, error)
}

var nodeMetrics = nodeMetricSource{
	platform:   runtime.GOOS,
	root:       "/",
	partitions: disk.Partitions,
	diskUsage:  disk.Usage,
	diskCache:  readDirectoryDiskCache,
	hostUptime: func() (uint64, error) {
		info, err := host.Info()
		if err != nil {
			return 0, err
		}
		return info.Uptime, nil
	},
}

func (s nodeMetricSource) containerized() bool {
	if s.platform != "linux" {
		return false
	}
	if data, err := os.ReadFile(filepath.Join(s.root, "run", "systemd", "container")); err == nil {
		if name := strings.TrimSpace(string(data)); name != "" && name != "none" {
			return true
		}
	}
	for _, marker := range []string{".dockerenv", "run/.containerenv", "dev/.lxc-boot-id"} {
		if _, err := os.Stat(filepath.Join(s.root, filepath.FromSlash(marker))); err == nil {
			return true
		}
	}
	for _, name := range []string{"self", "1"} {
		data, err := os.ReadFile(filepath.Join(s.root, "proc", name, "cgroup"))
		if err == nil && detectContainerFromCgroup(string(data)) != "" {
			return true
		}
	}
	// The LXC host also mounts LXCFS, normally at /var/lib/lxcfs. Only
	// virtualization of a specific proc/sys file identifies a container.
	if data, err := os.ReadFile(filepath.Join(s.root, "proc", "mounts")); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 3 && lxcfsContainerMetricMount(fields[1], fields[2]) {
				return true
			}
		}
	}
	if mounts, ok := s.mounts(); ok {
		for _, mount := range mounts {
			if lxcfsContainerMetricMount(mount.point, mount.fstype) {
				return true
			}
		}
	}
	return false
}

func lxcfsContainerMetricMount(point, fstype string) bool {
	if fstype != "fuse.lxcfs" {
		return false
	}
	switch point {
	case "/proc/cpuinfo", "/proc/diskstats", "/proc/loadavg", "/proc/meminfo",
		"/proc/slabinfo", "/proc/stat", "/proc/swaps", "/proc/uptime",
		"/sys/devices/system/cpu", "/sys/devices/system/cpu/online":
		return true
	}
	return false
}

type nodeMetricMount struct {
	root, point, fstype, source string
}

func (s nodeMetricSource) mounts() ([]nodeMetricMount, bool) {
	data, err := os.ReadFile(filepath.Join(s.root, "proc", "self", "mountinfo"))
	if err != nil {
		return nil, false
	}
	unescape := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	var mounts []nodeMetricMount
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, " - ", 2)
		if len(parts) != 2 {
			return nil, false
		}
		before, after := strings.Fields(parts[0]), strings.Fields(parts[1])
		if len(before) < 6 || len(after) < 3 {
			return nil, false
		}
		mount := nodeMetricMount{
			root: unescape.Replace(before[3]), point: unescape.Replace(before[4]),
			fstype: after[0], source: unescape.Replace(after[1]),
		}
		if !path.IsAbs(mount.root) || !path.IsAbs(mount.point) {
			return nil, false
		}
		mounts = append(mounts, mount)
	}
	return mounts, len(mounts) > 0
}

// statfs describes a filesystem, not a container's configured storage quota.
// A full, supported block filesystem can be measured. A directory bind,
// overlay, or unverified subvolume can expose its host backing filesystem.
func containerDiskMountReportable(partition disk.PartitionStat, mounts []nodeMetricMount) bool {
	found := false
	for _, mount := range mounts {
		if mount.point != partition.Mountpoint {
			continue
		}
		// Conflicting stacked mounts do not prove which filesystem statfs
		// will observe. Require every matching entry to satisfy the scope.
		if mount.root != "/" || mount.fstype != partition.Fstype || !strings.HasPrefix(mount.source, "/dev/") {
			return false
		}
		switch mount.fstype {
		case "ext2", "ext3", "ext4", "xfs":
			found = true
		default:
			return false
		}
	}
	return found
}

func (s nodeMetricSource) diskUsageTotals(include, exclude string) (*int64, *int64) {
	snapshot := s.diskSnapshot(include, exclude)
	return snapshot.used, snapshot.total
}

func (s nodeMetricSource) diskSnapshot(include, exclude string) diskUsageSnapshot {
	container := s.containerized()
	partitions, err := s.partitions(true)
	if err != nil {
		if container {
			return diskUsageSnapshot{}
		}
		used, total := int64(0), int64(0)
		return diskUsageSnapshot{used: &used, total: &total}
	}
	selected := selectDiskPartitions(partitions, include, exclude)
	unavailable := func() diskUsageSnapshot {
		// The optional allocation belongs to the container root disk. It
		// cannot replace another selected mount, a partial multi-disk total,
		// or real filesystem usage. Never combine it with host statfs Used.
		if container && containerDiskTotalBytes > 0 && len(selected) == 1 && selected[0].Mountpoint == "/" {
			total := int64(containerDiskTotalBytes)
			return diskUsageSnapshot{total: &total}
		}
		return diskUsageSnapshot{}
	}
	if container {
		mounts, ok := s.mounts()
		if !ok || len(selected) == 0 {
			return unavailable()
		}
		for _, partition := range selected {
			if !containerDiskMountReportable(partition, mounts) {
				if rootDiskNeedsDirectoryCache(selected, mounts) && diskUsageFile != "" && s.diskCache != nil {
					if cached, err := s.diskCache(s.root, diskUsageFile, time.Now()); err == nil && cached.used != nil {
						if containerDiskTotalBytes > 0 {
							total := int64(containerDiskTotalBytes)
							cached.total = &total
						}
						return cached
					}
				}
				return unavailable()
			}
		}
	}

	explicitInclude := strings.TrimSpace(include) != ""
	var samples []*disk.UsageStat
	deviceMap := map[string]*disk.UsageStat{}
	for _, partition := range selected {
		usage, err := s.diskUsage(partition.Mountpoint)
		if err != nil || usage == nil {
			if container {
				return unavailable()
			}
			continue
		}
		if container && (usage.Total == 0 || usage.Total > math.MaxInt64 || usage.Used > usage.Total) {
			return unavailable()
		}
		if explicitInclude {
			samples = append(samples, usage)
			continue
		}
		deviceID := diskDeviceID(partition)
		if existing, ok := deviceMap[deviceID]; ok && existing.Total >= usage.Total {
			continue
		}
		deviceMap[deviceID] = usage
	}
	for _, usage := range deviceMap {
		samples = append(samples, usage)
	}

	var usedDisk, totalDisk int64
	for _, usage := range samples {
		if container && (int64(usage.Used) > math.MaxInt64-usedDisk || int64(usage.Total) > math.MaxInt64-totalDisk) {
			return unavailable()
		}
		usedDisk += int64(usage.Used)
		totalDisk += int64(usage.Total)
	}
	return diskUsageSnapshot{used: &usedDisk, total: &totalDisk}
}

func rootDiskNeedsDirectoryCache(selected []disk.PartitionStat, mounts []nodeMetricMount) bool {
	if len(selected) != 1 || selected[0].Mountpoint != "/" || containerDiskMountReportable(selected[0], mounts) {
		return false
	}
	for _, mount := range mounts {
		if mount.point == "/" {
			return true
		}
	}
	return false
}

func (s nodeMetricSource) uptime() *int64 {
	if s.containerized() {
		mounts, ok := s.mounts()
		if !ok {
			return nil
		}
		trusted := false
		for _, mount := range mounts {
			if mount.point != "/proc/uptime" {
				continue
			}
			if mount.fstype != "fuse.lxcfs" {
				return nil
			}
			trusted = true
		}
		if !trusted {
			return nil
		}
		// gopsutil v3.23.2 uses sysinfo on Linux, which bypasses LXCFS.
		// Missing or invalid LXCFS data must not fall back to host uptime.
		data, err := os.ReadFile(filepath.Join(s.root, "proc", "uptime"))
		if err != nil {
			return nil
		}
		fields := strings.Fields(string(data))
		if len(fields) == 0 {
			return nil
		}
		seconds, err := strconv.ParseFloat(fields[0], 64)
		if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 || seconds >= float64(math.MaxInt64) {
			return nil
		}
		uptime := int64(seconds)
		return &uptime
	}
	value, err := s.hostUptime()
	if err != nil || value > math.MaxInt64 {
		return nil
	}
	uptime := int64(value)
	return &uptime
}

func (s nodeMetricSource) temperature(ctx context.Context) *float64 {
	if s.containerized() {
		// Containers share the physical CPU; a valid hwmon sensor still
		// describes that shared host hardware, not a container temperature.
		return nil
	}
	return nodeTemperatureSampler.sample(ctx)
}
