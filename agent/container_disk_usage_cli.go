package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

const directoryDiskScanInterval = 300 * time.Second
const directoryDiskScanTimeout = 30 * time.Second

type directoryCollectorOptions struct {
	service          string
	once, check      bool
	include, exclude string
	total            containerDiskTotalValue
}

func defaultDirectoryScanLimits() directoryScanLimits {
	return directoryScanLimits{maxEntries: 200000, maxDepth: 256, timeout: directoryDiskScanTimeout}
}

// This dispatch happens before normal flag parsing or Agent environment
// initialization. The local parser deliberately has no token/server options.
func handleDirectoryCollectorCLI(args []string, output io.Writer) (bool, int) {
	local := false
	for _, argument := range args {
		if argument == "--" {
			break
		}
		name, _, _ := strings.Cut(strings.TrimLeft(argument, "-"), "=")
		if strings.HasPrefix(argument, "-") && (name == "disk-usage-collector" || name == "disk-usage-check" || name == "disk-usage-once") {
			local = true
		}
	}
	if !local {
		return false, 0
	}
	options, err := parseDirectoryCollectorOptions(args, output)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return true, 0
		}
		fmt.Fprintf(output, "disk collector: %v\n", err)
		return true, 2
	}
	needed, err := directoryCollectorNeeded(nodeMetrics, options.include, options.exclude)
	if err != nil {
		fmt.Fprintf(output, "disk collector scope check failed: %v\n", err)
		return true, 1
	}
	if !needed {
		fmt.Fprintln(output, "directory disk collector is not required")
		return true, 3
	}
	if options.check {
		fmt.Fprintln(output, "directory disk collector is required")
		return true, 0
	}
	if err := runDirectoryCollector(options, output); err != nil {
		fmt.Fprintf(output, "disk collector failed: %v\n", err)
		return true, 1
	}
	return true, 0
}

func parseDirectoryCollectorOptions(args []string, output io.Writer) (directoryCollectorOptions, error) {
	var options directoryCollectorOptions
	flags := flag.NewFlagSet("local disk collector", flag.ContinueOnError)
	flags.SetOutput(output)
	flags.StringVar(&options.service, "disk-usage-collector", "", "Collect root directory allocation for this service")
	flags.BoolVar(&options.once, "disk-usage-once", false, "Collect once and exit")
	flags.BoolVar(&options.check, "disk-usage-check", false, "Exit 0 when required, 3 when not required")
	flags.StringVar(&options.include, "mount-include", "", "Selected disk mountpoints/devices")
	flags.StringVar(&options.exclude, "mount-exclude", "", "Excluded disk mountpoints/devices")
	flags.Var(&options.total, "container-disk-total-bytes", "Verified root allocation in bytes; 0 discovers the local device allocation")
	if err := flags.Parse(args); err != nil {
		return options, err
	}
	if flags.NArg() != 0 || (options.check && (options.service != "" || options.once)) || (!options.check && !directoryCollectorServiceName(options.service)) {
		return options, errors.New("choose --disk-usage-check or --disk-usage-collector SERVICE_NAME with an optional --disk-usage-once")
	}
	set := map[string]bool{}
	flags.Visit(func(f *flag.Flag) { set[f.Name] = true })
	// These three nonsecret inputs are the entire environment allowlist.
	if !set["mount-include"] {
		options.include = os.Getenv("CF_MONITOR_MOUNT_INCLUDE")
	}
	if !set["mount-exclude"] {
		options.exclude = os.Getenv("CF_MONITOR_MOUNT_EXCLUDE")
	}
	if !set["container-disk-total-bytes"] {
		if value := strings.TrimSpace(os.Getenv("CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES")); value != "" {
			if err := options.total.Set(value); err != nil {
				return options, err
			}
		}
	}
	return options, nil
}

func directoryCollectorServiceName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 || name[0] == '-' {
		return false
	}
	for _, c := range name {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.ContainsRune("_.@-", c) {
			continue
		}
		return false
	}
	return true
}

func directoryCollectorNeeded(source nodeMetricSource, include, exclude string) (bool, error) {
	if !source.containerized() {
		return false, nil
	}
	partitions, err := source.partitions(true)
	if err != nil {
		return false, errors.New("cannot read selected root filesystem")
	}
	selected := selectDiskPartitions(partitions, include, exclude)
	if len(selected) != 1 || selected[0].Mountpoint != "/" {
		return false, nil
	}
	mounts, ok := source.mounts()
	if !ok {
		return false, errors.New("cannot verify root mount scope")
	}
	return rootDiskNeedsDirectoryCache(selected, mounts), nil
}
