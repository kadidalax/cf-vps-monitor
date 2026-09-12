package main

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type cgroupMemoryPath struct {
	root string
	leaf string
	v2   bool
}

func readCgroupMemory(cgroupRoot string, procSelfCgroup string) memorySnapshot {
	for _, group := range memoryCgroupPaths(cgroupRoot, procSelfCgroup) {
		dirs := cgroupAncestorPaths(group.root, group.leaf)
		var snapshot memorySnapshot
		if group.v2 {
			snapshot.ramTotal, snapshot.ramUsed, _, snapshot.hasRAM = effectiveCgroupPair(dirs, "memory.max", "memory.current", false)
			snapshot.swapTotal, snapshot.swapUsed, _, snapshot.hasSwap = effectiveCgroupPair(dirs, "memory.swap.max", "memory.swap.current", false)
		} else {
			snapshot.ramTotal, snapshot.ramUsed, _, snapshot.hasRAM = effectiveCgroupPair(dirs, "memory.limit_in_bytes", "memory.usage_in_bytes", true)
			memswMax, memswCurrent, dir, ok := effectiveCgroupPair(dirs, "memory.memsw.limit_in_bytes", "memory.memsw.usage_in_bytes", true)
			if ok {
				// v1 memsw counts memory plus swap. Both subtractions must use
				// values from the same group as the selected memsw limit.
				ramMax, hasMax := readCgroupLimit(filepath.Join(dir, "memory.limit_in_bytes"))
				ramCurrent, hasCurrent := readCgroupLimit(filepath.Join(dir, "memory.usage_in_bytes"))
				if hasMax && hasCurrent && memswMax >= ramMax && memswCurrent >= ramCurrent {
					snapshot.swapTotal, snapshot.swapUsed, snapshot.hasSwap = memswMax-ramMax, memswCurrent-ramCurrent, true
				}
			}
		}
		if snapshot.hasRAM || snapshot.hasSwap {
			return snapshot
		}
	}
	return memorySnapshot{}
}

// Select the narrowest effective budget, including ancestors. Equal limits
// bind the wider group too, so retain its aggregate usage rather than a leaf's.
func effectiveCgroupPair(dirs []string, limitFile, usageFile string, v1 bool) (uint64, uint64, string, bool) {
	var limit uint64
	selected := ""
	for index, dir := range dirs {
		if v1 && index > 0 {
			if enabled, ok := readCgroupLimit(filepath.Join(dir, "memory.use_hierarchy")); ok && enabled == 0 {
				continue
			}
		}
		value, finite, err := readCgroupValue(filepath.Join(dir, limitFile))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, 0, "", false
		}
		if finite && (selected == "" || value <= limit) {
			limit, selected = value, dir
		}
	}
	if selected == "" {
		return 0, 0, "", false
	}
	used, ok := readCgroupLimit(filepath.Join(selected, usageFile))
	if !ok {
		return 0, 0, "", false
	}
	return limit, used, selected, true
}

func cgroupAncestorPaths(root, leaf string) []string {
	root, leaf = filepath.Clean(root), filepath.Clean(leaf)
	rel, err := filepath.Rel(root, leaf)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return nil
	}
	var result []string
	for dir := leaf; ; dir = filepath.Dir(dir) {
		result = append(result, dir)
		if dir == root {
			return result
		}
	}
}

func memoryCgroupPaths(cgroupRoot, procSelfCgroup string) []cgroupMemoryPath {
	data, err := os.ReadFile(procSelfCgroup)
	if err != nil {
		return nil
	}
	mountData, mountErr := os.ReadFile(filepath.Join(filepath.Dir(procSelfCgroup), "mountinfo"))
	if mountErr != nil && !errors.Is(mountErr, os.ErrNotExist) {
		return nil
	}
	var result []cgroupMemoryPath
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.SplitN(line, ":", 3)
		if len(fields) != 3 || !strings.HasPrefix(fields[2], "/") {
			continue
		}
		v2 := fields[1] == ""
		if !v2 && !strings.Contains(","+fields[1]+",", ",memory,") {
			continue
		}
		processPath := fields[2]
		if strings.Contains("/"+processPath+"/", "/../") {
			// cgroup namespaces may expose an out-of-root process as /.. .
			// Such a path cannot authorize reading a different visible group.
			continue
		}
		if mountErr == nil {
			result = append(result, mountedMemoryCgroups(string(mountData), processPath, v2)...)
			continue
		}
		// Compatibility for systems without mountinfo and synthetic fixtures.
		roots := []string{cgroupRoot}
		if !v2 {
			roots = []string{filepath.Join(cgroupRoot, "memory"), cgroupRoot}
		}
		for _, root := range roots {
			leaf := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(processPath, "/")))
			if info, err := os.Stat(leaf); err == nil && info.IsDir() {
				result = append(result, cgroupMemoryPath{root, leaf, v2})
			}
		}
	}
	return result
}

func mountedMemoryCgroups(mountinfo, processPath string, v2 bool) []cgroupMemoryPath {
	type candidate struct {
		group cgroupMemoryPath
		depth int
	}
	var candidates []candidate
	unescape := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	for _, line := range strings.Split(mountinfo, "\n") {
		parts := strings.SplitN(line, " - ", 2)
		if len(parts) != 2 {
			continue
		}
		before, after := strings.Fields(parts[0]), strings.Fields(parts[1])
		if len(before) < 6 || len(after) < 3 {
			continue
		}
		if (v2 && after[0] != "cgroup2") || (!v2 && (after[0] != "cgroup" || !strings.Contains(","+after[2]+",", ",memory,"))) {
			continue
		}
		mountRoot, mountPoint := unescape.Replace(before[3]), unescape.Replace(before[4])
		if !filepath.IsAbs(mountPoint) || (processPath != mountRoot && !strings.HasPrefix(processPath, strings.TrimSuffix(mountRoot, "/")+"/")) {
			continue
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(processPath, mountRoot), "/")
		leaf := filepath.Join(mountPoint, filepath.FromSlash(rel))
		if info, err := os.Stat(leaf); err == nil && info.IsDir() {
			candidates = append(candidates, candidate{cgroupMemoryPath{mountPoint, leaf, v2}, len(mountRoot)})
		}
	}
	// A broader readable mount exposes more applicable ancestors than a bind
	// mount of the leaf. Never walk above the actual mount to find them.
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].depth < candidates[j].depth })
	result := make([]cgroupMemoryPath, 0, len(candidates))
	for _, entry := range candidates {
		result = append(result, entry.group)
	}
	return result
}

func readCgroupValue(path string) (uint64, bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false, err
	}
	value := strings.TrimSpace(string(raw))
	if value == "max" {
		return 0, false, nil
	}
	limit, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, false, err
	}
	if limit > maxReasonableCgroupLimit {
		return 0, false, nil
	}
	return limit, true, nil
}

func readCgroupLimit(path string) (uint64, bool) {
	value, available, _ := readCgroupValue(path)
	return value, available
}
