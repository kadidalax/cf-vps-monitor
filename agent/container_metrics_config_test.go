package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const containerDiskConfigFlag = "container-disk-total-bytes"
const containerDiskConfigEnv = "CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES"

func containerDiskConfigFixture(t *testing.T) *flag.FlagSet {
	t.Helper()
	previousFlags := flag.CommandLine
	previousToken, previousServer, previousName, previousMode := token, serverURL, clientName, reportMode
	previousMountInclude, previousMountExclude := mountInclude, mountExclude
	previousNICInclude, previousNICExclude, previousReset := nicInclude, nicExclude, trafficResetDay
	flags := flag.NewFlagSet("container-metric-config", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	if registered := previousFlags.Lookup(containerDiskConfigFlag); registered != nil {
		previous := registered.Value.String()
		if err := registered.Value.Set("0"); err != nil {
			t.Fatal(err)
		}
		flags.Var(registered.Value, containerDiskConfigFlag, registered.Usage)
		t.Cleanup(func() {
			if err := registered.Value.Set(previous); err != nil {
				t.Error(err)
			}
		})
	}
	flag.CommandLine = flags
	t.Cleanup(func() {
		flag.CommandLine = previousFlags
		token, serverURL, clientName, reportMode = previousToken, previousServer, previousName, previousMode
		mountInclude, mountExclude = previousMountInclude, previousMountExclude
		nicInclude, nicExclude, trafficResetDay = previousNICInclude, previousNICExclude, previousReset
	})
	for _, name := range []string{"TOKEN", "SERVER", "NAME", "MODE", "MOUNT_INCLUDE", "MOUNT_EXCLUDE", "NIC_INCLUDE", "NIC_EXCLUDE", "TRAFFIC_RESET_DAY", "CONTAINER_DISK_TOTAL_BYTES"} {
		t.Setenv("CF_MONITOR_"+name, "")
	}
	return flags
}

func TestContainerMetricsConfiguredCapacityPrecedence(t *testing.T) {
	for _, tc := range []struct {
		name, environment string
		args              []string
		want              int64
	}{
		{"automatic default", "", nil, -1},
		{"verified environment allocation", "5024000000", nil, 5024000000},
		{"environment zero remains automatic", "0", nil, -1},
		{"CLI allocation", "", []string{"--container-disk-total-bytes=7000000"}, 7000000},
		{"CLI wins", "5024000000", []string{"--container-disk-total-bytes", "7000000"}, 7000000},
		{"explicit CLI zero wins", "5024000000", []string{"--container-disk-total-bytes=0"}, -1},
		{"explicit CLI overrides invalid environment", "not-bytes", []string{"--container-disk-total-bytes=7000000"}, 7000000},
		{"last CLI wins", "5024000000", []string{"--container-disk-total-bytes=1", "--container-disk-total-bytes=2"}, 2},
		{"largest counter accepted by Worker", "1000000000000000", nil, 1000000000000000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			flags := containerDiskConfigFixture(t)
			t.Setenv(containerDiskConfigEnv, tc.environment)
			if err := flags.Parse(tc.args); err != nil {
				t.Fatalf("valid container disk configuration was rejected: %v", err)
			}
			applyEnvDefaults()
			source := containerMetricFixture(t, sharedContainerMount)
			used, total := source.diskUsageTotals("", "")
			assertContainerMetricInt(t, "configured total", total, tc.want)
			assertContainerMetricInt(t, "unmeasured usage", used, -1)
			data, err := json.Marshal(Report{Disk: used, DiskTotal: total})
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(data, &fields); err != nil {
				t.Fatal(err)
			}
			if string(fields["disk"]) != "null" {
				t.Fatalf("configuration invented disk use: %s", fields["disk"])
			}
		})
	}
}

func TestContainerMetricsConfiguredCapacityScope(t *testing.T) {
	for _, tc := range []struct {
		name, mountinfo, include, exclude string
		container                         bool
		used, total                       int64
	}{
		{"shared root", sharedContainerMount, "", "", true, -1, 5024000000},
		{"explicit shared root", sharedContainerMount, "/", "", true, -1, 5024000000},
		{"root excluded", sharedContainerMount, "", "/", true, -1, -1},
		{"different requested mount", sharedContainerMount, "/data", "", true, -1, -1},
		{"independent disk wins", independentContainerMount, "", "", true, 20, 100},
		{"bare metal keeps automatic value", sharedContainerMount, "", "", false, 20, 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			containerDiskConfigFixture(t)
			t.Setenv(containerDiskConfigEnv, "5024000000")
			applyEnvDefaults()
			source := containerMetricFixture(t, tc.mountinfo)
			if !tc.container {
				source.root = t.TempDir()
			}
			used, total := source.diskUsageTotals(tc.include, tc.exclude)
			assertContainerMetricInt(t, "disk used", used, tc.used)
			assertContainerMetricInt(t, "disk total", total, tc.total)
		})
	}
}

func TestContainerMetricsInvalidCapacityStopsStartup(t *testing.T) {
	if os.Getenv("CONTAINER_METRIC_CONFIG_CHILD") == "1" {
		os.Args = []string{"agent", "--server=http://127.0.0.1:1", "--token=synthetic", "--mode=invalid"}
		if os.Getenv("CONTAINER_METRIC_CONFIG_CLI") == "1" {
			os.Args = append(os.Args, "--container-disk-total-bytes="+os.Getenv("CONTAINER_METRIC_CONFIG_VALUE"))
		}
		main()
		return
	}
	for _, value := range []string{"-1", "+1", "1.5", "5GB", "0x10", "1000000000000001", "9223372036854775808"} {
		for _, input := range []string{"environment", "CLI"} {
			t.Run(input+" "+value, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestContainerMetricsInvalidCapacityStopsStartup$")
				envValue, useCLI := value, "0"
				if input == "CLI" {
					envValue, useCLI = "0", "1"
				}
				command.Env = append(os.Environ(), "CONTAINER_METRIC_CONFIG_CHILD=1", "CONTAINER_METRIC_CONFIG_CLI="+useCLI,
					"CONTAINER_METRIC_CONFIG_VALUE="+value, containerDiskConfigEnv+"="+envValue,
					"CF_MONITOR_TRAFFIC_STATE_FILE="+filepath.Join(t.TempDir(), "traffic-state.json"))
				output, err := command.CombinedOutput()
				if err == nil || ctx.Err() != nil || !strings.Contains(string(output), "container disk total") {
					t.Fatalf("invalid capacity did not stop startup at config validation: err=%v deadline=%v output=%s", err, ctx.Err(), output)
				}
			})
		}
	}
}
