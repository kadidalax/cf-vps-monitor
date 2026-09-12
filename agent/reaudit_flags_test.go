package main

import (
	"context"
	"flag"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReauditExplicitModePrecedence(t *testing.T) {
	previousFlags, previousMode := flag.CommandLine, reportMode
	previousToken, previousServer, previousName := token, serverURL, clientName
	previousMountInclude, previousMountExclude := mountInclude, mountExclude
	previousNICInclude, previousNICExclude := nicInclude, nicExclude
	previousReset := trafficResetDay
	previousDiskAllocation := containerDiskTotalBytes
	t.Cleanup(func() {
		flag.CommandLine, reportMode = previousFlags, previousMode
		token, serverURL, clientName = previousToken, previousServer, previousName
		mountInclude, mountExclude = previousMountInclude, previousMountExclude
		nicInclude, nicExclude = previousNICInclude, previousNICExclude
		trafficResetDay = previousReset
		containerDiskTotalBytes = previousDiskAllocation
	})
	for _, name := range []string{"TOKEN", "SERVER", "NAME", "MOUNT_INCLUDE", "MOUNT_EXCLUDE", "NIC_INCLUDE", "NIC_EXCLUDE", "TRAFFIC_RESET_DAY", "CONTAINER_DISK_TOTAL_BYTES"} {
		t.Setenv("CF_MONITOR_"+name, "")
	}
	for _, tt := range []struct {
		name, environment, want string
		args                    []string
	}{
		{"explicit websocket", "http", "websocket", []string{"--mode", "websocket"}},
		{"explicit HTTP", "websocket", "http", []string{"--mode", "http"}},
		{"equals syntax", "http", "websocket", []string{"--mode=websocket"}},
		{"last explicit flag wins", "http", "websocket", []string{"--mode=http", "--mode=websocket"}},
		{"explicit mode overrides invalid environment", "invalid", "websocket", []string{"--mode", "websocket"}},
		{"environment only", "http", "http", nil},
		{"default", "", "websocket", nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			flags := flag.NewFlagSet("reaudit-mode", flag.ContinueOnError)
			flags.SetOutput(io.Discard)
			flags.StringVar(&reportMode, "mode", "websocket", "")
			flag.CommandLine = flags
			t.Setenv("CF_MONITOR_MODE", tt.environment)
			if err := flags.Parse(tt.args); err != nil {
				t.Fatal(err)
			}
			applyEnvDefaults()
			if reportMode != tt.want {
				t.Fatalf("mode=%q, want %q (CLI=%q, env=%q)", reportMode, tt.want, tt.args, tt.environment)
			}
		})
	}
}

func TestReauditExplicitModeRejectsInvalid(t *testing.T) {
	if os.Getenv("REAUDIT_MODE_MAIN") == "1" {
		flag.CommandLine = flag.NewFlagSet("reaudit-invalid-mode", flag.ExitOnError)
		flag.StringVar(&reportMode, "mode", "websocket", "")
		flag.StringVar(&serverURL, "server", "http://127.0.0.1:1", "")
		flag.StringVar(&token, "token", "synthetic-token", "")
		os.Args = []string{"reaudit-agent"}
		if selected := os.Getenv("REAUDIT_CLI_MODE"); selected != "" {
			os.Args = append(os.Args, "--mode", selected)
		}
		main()
		return
	}
	for _, cli := range []string{"invalid", ""} {
		t.Run("CLI="+cli, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestReauditExplicitModeRejectsInvalid$")
			command.Env = append(os.Environ(), "REAUDIT_MODE_MAIN=1", "REAUDIT_CLI_MODE="+cli, "CF_MONITOR_MODE=invalid",
				"CF_MONITOR_TRAFFIC_STATE_FILE="+filepath.Join(t.TempDir(), "traffic-state.json"),
				"CF_MONITOR_NAME=synthetic", "CF_MONITOR_MOUNT_INCLUDE=", "CF_MONITOR_MOUNT_EXCLUDE=",
				"CF_MONITOR_NIC_INCLUDE=", "CF_MONITOR_NIC_EXCLUDE=", "CF_MONITOR_TRAFFIC_RESET_DAY=1")
			command.Env = append(command.Env, "CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES=0")
			output, err := command.CombinedOutput()
			if ctx.Err() != nil || err == nil || !strings.Contains(string(output), `unsupported mode "invalid"`) {
				t.Fatalf("invalid selected mode did not fail at validation: err=%v deadline=%v output=%s", err, ctx.Err(), output)
			}
		})
	}
}
