package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeCgroupFixture(t *testing.T, root, name, value string) {
	t.Helper()
	file := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestReauditCgroupAncestorScope(t *testing.T) {
	for _, tc := range []struct {
		name, leafMax, leafCurrent, parentMax, parentCurrent string
		wantTotal, wantUsed                                  uint64
		wantRAM                                              bool
	}{
		{"unlimited leaf", "max", "134217728", "536870912", "402653184", 536870912, 402653184, true},
		{"looser leaf", "2147483648", "134217728", "536870912", "402653184", 536870912, 402653184, true},
		{"tighter leaf", "268435456", "67108864", "536870912", "402653184", 268435456, 67108864, true},
		{"equal limit includes parent usage", "536870912", "134217728", "536870912", "402653184", 536870912, 402653184, true},
		{"all unlimited", "max", "134217728", "max", "402653184", 0, 0, false},
		{"missing binding usage", "max", "134217728", "536870912", "", 0, 0, false},
		{"zero limit is real", "0", "0", "536870912", "402653184", 0, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeCgroupFixture(t, root, "memory.max", tc.parentMax)
			if tc.parentCurrent != "" {
				writeCgroupFixture(t, root, "memory.current", tc.parentCurrent)
			}
			writeCgroupFixture(t, root, "system.slice/memory.max", "max")
			writeCgroupFixture(t, root, "system.slice/agent.service/memory.max", tc.leafMax)
			writeCgroupFixture(t, root, "system.slice/agent.service/memory.current", tc.leafCurrent)
			writeCgroupFixture(t, root, "self-cgroup", "0::/system.slice/agent.service\n")
			got := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
			if got.hasRAM != tc.wantRAM || got.ramTotal != tc.wantTotal || got.ramUsed != tc.wantUsed {
				t.Fatalf("effective group RAM = %+v; want available=%t total=%d used=%d", got, tc.wantRAM, tc.wantTotal, tc.wantUsed)
			}
		})
	}
}

func TestReauditCgroupV1AncestorRAMAndSwapUseSameScope(t *testing.T) {
	root := t.TempDir()
	for name, value := range map[string]string{
		"memory/memory.limit_in_bytes":               "536870912",
		"memory/memory.usage_in_bytes":               "402653184",
		"memory/memory.memsw.limit_in_bytes":         "805306368",
		"memory/memory.memsw.usage_in_bytes":         "469762048",
		"memory/memory.use_hierarchy":                "1",
		"memory/service/memory.limit_in_bytes":       "2147483648",
		"memory/service/memory.usage_in_bytes":       "134217728",
		"memory/service/memory.memsw.limit_in_bytes": "3221225472",
		"memory/service/memory.memsw.usage_in_bytes": "167772160",
		"self-cgroup": "5:memory:/service\n",
	} {
		writeCgroupFixture(t, root, name, value)
	}
	got := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
	if !got.hasRAM || got.ramTotal != 536870912 || got.ramUsed != 402653184 || !got.hasSwap || got.swapTotal != 268435456 || got.swapUsed != 67108864 {
		t.Fatalf("v1 effective parent RAM/swap = %+v", got)
	}
}

func TestReauditCgroupMountRootMappingAndBoundary(t *testing.T) {
	for _, processPath := range []string{"/tenant/service", "/tenant/../other/service"} {
		t.Run(processPath, func(t *testing.T) {
			base := t.TempDir()
			mount := filepath.Join(base, "mounted tree")
			writeCgroupFixture(t, base, "memory.max", "1")
			writeCgroupFixture(t, base, "memory.current", "1")
			writeCgroupFixture(t, mount, "memory.max", "536870912")
			writeCgroupFixture(t, mount, "memory.current", "402653184")
			writeCgroupFixture(t, mount, "service/memory.max", "max")
			writeCgroupFixture(t, mount, "service/memory.current", "134217728")
			writeCgroupFixture(t, base, "cgroup", "0::"+processPath+"\n")
			mountField := strings.ReplaceAll(filepath.ToSlash(mount), " ", `\040`)
			writeCgroupFixture(t, base, "mountinfo", fmt.Sprintf("29 23 0:26 /tenant %s rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n", mountField))
			got := readCgroupMemory(base, filepath.Join(base, "cgroup"))
			if processPath == "/tenant/service" {
				if !got.hasRAM || got.ramTotal != 536870912 || got.ramUsed != 402653184 {
					t.Fatalf("mounted subtree mapping escaped or missed parent: %+v", got)
				}
			} else if got.hasRAM {
				t.Fatalf("out-of-namespace path must not use an unrelated mount: %+v", got)
			}
		})
	}
}

func TestReauditCgroupUnreadableUsageFallsBackToProc(t *testing.T) {
	root := t.TempDir()
	writeCgroupFixture(t, root, "memory.max", "536870912")
	writeCgroupFixture(t, root, "service/memory.max", "2147483648")
	writeCgroupFixture(t, root, "service/memory.current", "134217728")
	writeCgroupFixture(t, root, "self-cgroup", "0::/service\n")
	if err := os.Mkdir(filepath.Join(root, "memory.current"), 0700); err != nil {
		t.Fatal(err)
	}
	cgroup := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
	if cgroup.hasRAM {
		t.Fatalf("unreadable binding usage must not become zero or leaf usage: %+v", cgroup)
	}
	proc := parseProcMeminfo("MemTotal: 1024 kB\nMemFree: 256 kB\n")
	got := mergeMemorySnapshot(proc, cgroup, false)
	if !got.hasRAM || got.ramTotal != 1048576 || got.ramUsed != 786432 {
		t.Fatalf("unavailable cgroup must preserve proc fallback: %+v", got)
	}
}

func TestReauditCgroupV2InheritedSwapScope(t *testing.T) {
	root := t.TempDir()
	for name, value := range map[string]string{
		"memory.swap.max": "268435456", "memory.swap.current": "67108864",
		"service/memory.max": "536870912", "service/memory.current": "134217728",
		"service/memory.swap.max": "max", "service/memory.swap.current": "16777216",
		"self-cgroup": "0::/service\n",
	} {
		writeCgroupFixture(t, root, name, value)
	}
	got := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
	if !got.hasSwap || got.swapTotal != 268435456 || got.swapUsed != 67108864 {
		t.Fatalf("swap must use its binding parent scope: %+v", got)
	}
}

func TestReauditCgroupV1DisabledLegacyHierarchyDoesNotBindDescendants(t *testing.T) {
	root := t.TempDir()
	for name, value := range map[string]string{
		"memory/memory.limit_in_bytes": "536870912", "memory/memory.usage_in_bytes": "402653184",
		"memory/memory.use_hierarchy":          "0",
		"memory/service/memory.limit_in_bytes": "2147483648", "memory/service/memory.usage_in_bytes": "134217728",
		"self-cgroup": "5:memory:/service\n",
	} {
		writeCgroupFixture(t, root, name, value)
	}
	got := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
	if !got.hasRAM || got.ramTotal != 2147483648 || got.ramUsed != 134217728 {
		t.Fatalf("nonhierarchical legacy ancestor cannot constrain the child: %+v", got)
	}
}
