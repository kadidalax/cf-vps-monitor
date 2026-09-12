package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v3/disk"
)

func TestDirectoryDiskLocalCLI(t *testing.T) {
	if os.Getenv("DIRECTORY_DISK_CLI_CHILD") == "1" {
		var args []string
		if err := json.Unmarshal([]byte(os.Getenv("DIRECTORY_DISK_CLI_ARGS")), &args); err != nil {
			t.Fatal(err)
		}
		nodeMetrics.platform, nodeMetrics.root = os.Getenv("DIRECTORY_DISK_CLI_PLATFORM"), os.Getenv("DIRECTORY_DISK_CLI_ROOT")
		nodeMetrics.partitions = func(bool) ([]disk.PartitionStat, error) {
			return []disk.PartitionStat{{Mountpoint: "/", Device: "/dev/synthetic", Fstype: "ext4"}}, nil
		}
		nodeMetrics.diskUsage = func(string) (*disk.UsageStat, error) {
			t.Fatal("local check sampled host usage")
			return nil, nil
		}
		os.Args = append([]string{"synthetic-agent"}, args...)
		main()
		return
	}
	for _, tc := range []struct {
		name, platform, mounts, envTotal string
		args                             []string
		want                             int
	}{
		{"shared root needs collector", "linux", sharedContainerMount, "0", []string{"--disk-usage-check"}, 0},
		{"native root needs no collector", "linux", independentContainerMount, "0", []string{"--disk-usage-check"}, 3},
		{"root excluded", "linux", sharedContainerMount, "0", []string{"--disk-usage-check", "--mount-exclude=/"}, 3},
		{"different selection", "linux", sharedContainerMount, "0", []string{"--disk-usage-check", "--mount-include=/data"}, 3},
		{"non Linux", "windows", sharedContainerMount, "0", []string{"--disk-usage-check"}, 3},
		{"CLI zero overrides bad environment", "linux", sharedContainerMount, "bad", []string{"--disk-usage-check", "--container-disk-total-bytes=0"}, 0},
		{"bad capacity stops local mode", "linux", sharedContainerMount, "bad", []string{"--disk-usage-check"}, 2},
		{"tokens are not collector flags", "linux", sharedContainerMount, "0", []string{"--disk-usage-check", "--token=synthetic"}, 2},
		{"network options are not collector flags", "linux", sharedContainerMount, "0", []string{"--disk-usage-check", "--server=http://127.0.0.1:1"}, 2},
		{"fixed output only", "linux", sharedContainerMount, "0", []string{"--disk-usage-check", "--disk-usage-file=/tmp/untrusted"}, 2},
		{"unsafe service rejected", "linux", sharedContainerMount, "0", []string{"--disk-usage-collector=../escape", "--disk-usage-once"}, 2},
		{"once requires service", "linux", sharedContainerMount, "0", []string{"--disk-usage-once"}, 2},
		{"check cannot start collector", "linux", sharedContainerMount, "0", []string{"--disk-usage-check", "--disk-usage-collector=safe"}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := containerMetricFixture(t, tc.mounts)
			state := filepath.Join(t.TempDir(), "must-not-exist.json")
			args, err := json.Marshal(tc.args)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDirectoryDiskLocalCLI$")
			cmd.Env = append(os.Environ(), "DIRECTORY_DISK_CLI_CHILD=1", "DIRECTORY_DISK_CLI_ARGS="+string(args),
				"DIRECTORY_DISK_CLI_PLATFORM="+tc.platform, "DIRECTORY_DISK_CLI_ROOT="+source.root,
				"CF_MONITOR_SERVER=://invalid-agent-url", "CF_MONITOR_TOKEN=synthetic-not-used", "CF_MONITOR_MODE=invalid",
				"CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES="+tc.envTotal, "CF_MONITOR_MOUNT_INCLUDE=", "CF_MONITOR_MOUNT_EXCLUDE=",
				"CF_MONITOR_TRAFFIC_STATE_FILE="+state)
			output, err := cmd.CombinedOutput()
			code := 0
			if err != nil {
				var ok bool
				if _, ok = err.(*exec.ExitError); !ok {
					t.Fatal(err)
				}
				code = err.(*exec.ExitError).ExitCode()
			}
			if ctx.Err() != nil || code != tc.want {
				t.Fatalf("local mode exit=%d want=%d timeout=%v output=%s", code, tc.want, ctx.Err(), output)
			}
			if strings.Contains(string(output), "invalid server URL") || strings.Contains(string(output), "missing token") || strings.Contains(string(output), "CF VPS Monitor Agent") {
				t.Fatalf("collector initialized network Agent: %s", output)
			}
			if _, err := os.Stat(state); !os.IsNotExist(err) {
				t.Fatalf("local mode touched token-scoped traffic state: %v", err)
			}
		})
	}
}
