//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func directoryTestLimits() directoryScanLimits {
	return directoryScanLimits{maxEntries: 200000, maxDepth: 256, timeout: 30 * time.Second}
}

func TestDirectoryDiskNativePermissions(t *testing.T) {
	if mode := os.Getenv("DIRECTORY_DISK_PERMISSION_CHILD"); mode != "" {
		root, filename := os.Getenv("DIRECTORY_DISK_PERMISSION_ROOT"), os.Getenv("DIRECTORY_DISK_PERMISSION_FILE")
		if os.Geteuid() == 0 {
			t.Fatal("permission fixture did not drop root")
		}
		if mode == "denied scan" {
			result, err := scanDirectoryAllocated(context.Background(), root, directoryTestMounts, directoryTestLimits())
			if err == nil || result.usedBytes != 0 || !errors.Is(err, unix.EACCES) {
				t.Fatalf("unreadable subtree gave a partial sample: %+v err=%v", result, err)
			}
			return
		}
		sample, err := readDirectoryDiskCache(root, filename, time.Now())
		if err != nil {
			t.Fatalf("ordinary user cannot read trusted cache: %v", err)
		}
		assertContainerMetricInt(t, "ordinary user cache", sample.used, 8388608)
		if err := os.WriteFile(filename, []byte("forged"), 0644); err == nil {
			t.Error("ordinary user overwrote cache")
		}
		if err := os.Remove(filename); err == nil {
			t.Error("ordinary user removed cache")
		}
		if err := os.WriteFile(filepath.Join(filepath.Dir(filename), "replacement.json"), []byte("forged"), 0644); err == nil {
			t.Error("ordinary user can replace a cache-directory entry")
		}
		return
	}
	for _, mode := range []string{"read only cache", "denied scan"} {
		t.Run(mode, func(t *testing.T) {
			root, filename, cache := nativeDiskCacheFixture(t)
			for _, directory := range []string{filepath.Dir(root), root} {
				if err := os.Chmod(directory, 0755); err != nil {
					t.Fatal(err)
				}
			}
			oldMask := unix.Umask(0077)
			err := writeDirectoryDiskCacheFile(filename, cache)
			unix.Umask(oldMask)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "denied scan" {
				denied := filepath.Join(root, "unreadable")
				if err := os.Mkdir(denied, 0000); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDirectoryDiskNativePermissions$", "-test.v")
			cmd.Env = append(os.Environ(), "DIRECTORY_DISK_PERMISSION_CHILD="+mode, "DIRECTORY_DISK_PERMISSION_ROOT="+root, "DIRECTORY_DISK_PERMISSION_FILE="+filename)
			cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, NoSetGroups: true}}
			output, err := cmd.CombinedOutput()
			if err != nil || ctx.Err() != nil {
				t.Fatalf("native ordinary-user check failed: %v deadline=%v output=%s", err, ctx.Err(), output)
			}
		})
	}
}

func TestDirectoryDiskNativeGuestSocket(t *testing.T) {
	for _, mode := range []string{"devices", "root listing", "redirect", "too large", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			fd, err := unix.Open(directory, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer unix.Close(fd)
			// Keep the sockaddr shorter than 108 bytes even under a long
			// parent TMPDIR; the socket itself stays inside t.TempDir().
			socket := fmt.Sprintf("/proc/self/fd/%d/s", fd)
			listener, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != "GET" || r.URL.Path != "/1.0/devices" || r.Header.Get("Authorization") != "" {
					t.Error("guest request escaped its fixed local metadata contract")
				}
				switch mode {
				case "devices":
					fmt.Fprint(w, `{"root":{"type":"disk","path":"/","size":"5024MB"}}`)
				case "root listing":
					fmt.Fprint(w, `["/1.0"]`)
				case "redirect":
					http.Redirect(w, r, "http://guest/must-not-request", http.StatusFound)
				case "too large":
					fmt.Fprint(w, strings.Repeat(" ", maxGuestDiskDevicesBytes+1))
				case "deadline":
					w.WriteHeader(http.StatusOK)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
				}
			})}
			defer server.Close()
			go server.Serve(listener)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			if mode == "deadline" {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 50*time.Millisecond)
			}
			defer cancel()
			value, err := readGuestDiskDevices(ctx, socket)
			if mode == "devices" {
				if err != nil || value != 5024000000 {
					t.Fatalf("guest root bytes=%d err=%v", value, err)
				}
			} else if err == nil || value != 0 {
				t.Fatalf("invalid guest response became capacity: %d err=%v", value, err)
			}
			if requests.Load() != 1 {
				t.Fatalf("guest client followed a redirect or retried: requests=%d", requests.Load())
			}
		})
	}
}

func TestDirectoryDiskNativeScanLock(t *testing.T) {
	_, name, _ := nativeDiskCacheFixture(t)
	lockName := filepath.Join(filepath.Dir(name), "scan.lock")
	first, err := acquireDirectoryScanLock(context.Background(), lockName)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	second, err := acquireDirectoryScanLock(ctx, lockName)
	if err == nil {
		second.Close()
		t.Fatal("two processes can hold the scan lock")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := acquireDirectoryScanLock(context.Background(), lockName)
	if err != nil {
		t.Fatalf("completed scan retained its lock: %v", err)
	}
	third.Close()
}

func TestDirectoryDiskNativeFailedRefreshKeepsTimestamp(t *testing.T) {
	root, name, _ := nativeDiskCacheFixture(t)
	if _, err := collectDirectoryDiskUsage(context.Background(), root, name, 5024000000, directoryTestMounts, directoryTestLimits()); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	limits := directoryTestLimits()
	limits.maxEntries = 1
	if _, err := collectDirectoryDiskUsage(context.Background(), root, name, 5024000000, directoryTestMounts, limits); err == nil {
		t.Fatal("incomplete refresh reported success")
	}
	after, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed refresh changed the last complete sample or its timestamp")
	}
}

func directoryTestMounts() ([]byte, error) { return os.ReadFile("/proc/self/mountinfo") }

func TestDirectoryDiskNativeAllocatedTree(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	regular := filepath.Join(root, "regular")
	if err := os.WriteFile(regular, make([]byte, 65537), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "not-in-root"), make([]byte, 131072), 0600); err != nil {
		t.Fatal(err)
	}
	sparse := filepath.Join(root, "sparse")
	f, err := os.Create(sparse)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(32 << 20); err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte("allocated"), (32<<20)-32); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(regular, filepath.Join(nested, "hardlink")); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	var expected int64
	for _, name := range []string{root, regular, sparse, nested, link} {
		var stat unix.Stat_t
		if err := unix.Lstat(name, &stat); err != nil {
			t.Fatal(err)
		}
		expected += stat.Blocks * 512
	}
	result, err := scanDirectoryAllocated(context.Background(), root, directoryTestMounts, directoryTestLimits())
	if err != nil || result.usedBytes != expected {
		t.Fatalf("allocated root scan = %d, err=%v; independent lstat blocks=%d", result.usedBytes, err, expected)
	}
	if result.usedBytes >= 32<<20 {
		t.Fatal("scanner counted sparse apparent size")
	}
}

// The child directory really has the same st_dev as the root. A parser that
// relies only on device numbers includes its visible contents and fails.
func TestDirectoryDiskNativeSameDeviceMountExcluded(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "child mount")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(child, "foreign"), make([]byte, 131072), 0600); err != nil {
		t.Fatal(err)
	}
	var rootStat, childStat unix.Stat_t
	if err := unix.Lstat(root, &rootStat); err != nil {
		t.Fatal(err)
	}
	if err := unix.Lstat(child, &childStat); err != nil {
		t.Fatal(err)
	}
	if rootStat.Dev != childStat.Dev {
		t.Fatal("fixture requires a same-device child")
	}
	info := fmt.Sprintf("31 20 253:0 / / rw - ext4 /dev/synthetic rw\n32 31 253:0 /another %s rw - ext4 /dev/synthetic rw\n", escapeMountInfoField(child))
	result, err := scanDirectoryAllocated(context.Background(), root, func() ([]byte, error) { return []byte(info), nil }, directoryTestLimits())
	if err != nil || result.usedBytes != rootStat.Blocks*512 {
		t.Fatalf("same-device mount contributed blocks: used=%d want=%d err=%v", result.usedBytes, rootStat.Blocks*512, err)
	}
}

func TestDirectoryDiskNativeIncompleteScanRejected(t *testing.T) {
	for _, reason := range []string{"entry limit", "depth limit", "deadline", "mount topology changed", "mount read error", "malformed mounts"} {
		t.Run(reason, func(t *testing.T) {
			root := t.TempDir()
			if err := os.MkdirAll(filepath.Join(root, "a", "b"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "a", "b", "file"), []byte("nonzero"), 0600); err != nil {
				t.Fatal(err)
			}
			limits, ctx := directoryTestLimits(), context.Background()
			mounts := directoryTestMounts
			switch reason {
			case "entry limit":
				limits.maxEntries = 1
			case "depth limit":
				limits.maxDepth = 1
			case "deadline":
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
				defer cancel()
			case "mount topology changed":
				calls := 0
				mounts = func() ([]byte, error) {
					calls++
					return []byte(fmt.Sprintf("%d 20 253:0 / / rw - ext4 /dev/synthetic rw\n", 30+calls)), nil
				}
			case "mount read error":
				calls := 0
				mounts = func() ([]byte, error) {
					calls++
					if calls > 1 {
						return nil, errors.New("synthetic I/O failure")
					}
					return directoryTestMounts()
				}
			case "malformed mounts":
				mounts = func() ([]byte, error) { return []byte("broken mount evidence"), nil }
			}
			result, err := scanDirectoryAllocated(ctx, root, mounts, limits)
			if err == nil || result.usedBytes != 0 || result.rootIno != 0 {
				t.Fatalf("partial scan advertised as complete: %+v err=%v", result, err)
			}
		})
	}
}

func escapeMountInfoField(value string) string {
	var escaped string
	for _, c := range value {
		switch c {
		case ' ':
			escaped += `\040`
		case '\t':
			escaped += `\011`
		case '\n':
			escaped += `\012`
		case '\\':
			escaped += `\134`
		default:
			escaped += string(c)
		}
	}
	return escaped
}

func nativeDiskCacheFixture(t *testing.T) (string, string, directoryDiskCache) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("root-owned cache integration requires a root test process; use a synthetic TMPDIR under /run")
	}
	root := t.TempDir()
	writeFileTree(t, root, map[string]string{"proc/sys/kernel/random/boot_id": "e213fcde-1109-4de9-a67f-319f734be915\n"})
	var st unix.Stat_t
	if err := unix.Lstat(root, &st); err != nil {
		t.Fatal(err)
	}
	used, total, dev, ino := int64(8388608), int64(5024000000), uint64(st.Dev), uint64(st.Ino)
	cache := directoryDiskCache{Version: 1, Scope: "root", Source: "directory", UsedBytes: &used, TotalBytes: &total,
		SampledAt: time.Now().UnixMilli(), RootDev: &dev, RootIno: &ino, BootID: "e213fcde-1109-4de9-a67f-319f734be915", Complete: true}
	return root, filepath.Join(root, "cache", "usage.json"), cache
}

func TestDirectoryDiskNativeProtectedCacheRoundTrip(t *testing.T) {
	root, name, cache := nativeDiskCacheFixture(t)
	if err := writeDirectoryDiskCacheFile(name, cache); err != nil {
		t.Fatalf("write root-controlled cache (TMPDIR must have no writable ancestors): %v", err)
	}
	sample, err := readDirectoryDiskCache(root, name, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	assertContainerMetricInt(t, "cache used", sample.used, 8388608)
	assertContainerMetricInt(t, "cache total", sample.total, 5024000000)
	if sample.source != "directory" || sample.sampledAt != cache.SampledAt {
		t.Fatal("cache source/time were lost or refreshed")
	}
	var st unix.Stat_t
	if err := unix.Lstat(name, &st); err != nil || st.Uid != 0 || st.Mode&0777 != 0644 || st.Nlink != 1 {
		t.Fatalf("cache ownership/mode/link count invalid: %+v err=%v", st, err)
	}
	if _, err := readDirectoryDiskCache(root, name, time.UnixMilli(cache.SampledAt).Add(901*time.Second)); err == nil {
		t.Fatal("stale cache remained valid")
	}
}

func TestDirectoryDiskNativeUntrustedCacheRejected(t *testing.T) {
	for _, reason := range []string{"writable parent", "parent symlink", "file symlink", "hardlink", "FIFO", "wrong owner", "writable file"} {
		t.Run(reason, func(t *testing.T) {
			root, name, cache := nativeDiskCacheFixture(t)
			if err := os.Mkdir(filepath.Dir(name), 0755); err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(cache)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(name, data, 0644); err != nil {
				t.Fatal(err)
			}
			switch reason {
			case "writable parent":
				err = os.Chmod(filepath.Dir(name), 0777)
			case "parent symlink":
				alias := filepath.Join(root, "alias")
				err = os.Symlink(filepath.Dir(name), alias)
				name = filepath.Join(alias, "usage.json")
			case "file symlink":
				alias := filepath.Join(filepath.Dir(name), "alias.json")
				err = os.Symlink(name, alias)
				name = alias
			case "hardlink":
				err = os.Link(name, filepath.Join(root, "hardlink.json"))
			case "FIFO":
				if err = os.Remove(name); err == nil {
					err = unix.Mkfifo(name, 0644)
				}
			case "wrong owner":
				err = os.Chown(name, 65534, 65534)
			case "writable file":
				err = os.Chmod(name, 0666)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := readDirectoryDiskCache(root, name, time.Now()); err == nil {
				t.Fatal("untrusted cache was accepted")
			}
			if err := writeDirectoryDiskCacheFile(name, cache); err == nil {
				t.Fatal("collector wrote through an untrusted cache path")
			}
		})
	}
}
