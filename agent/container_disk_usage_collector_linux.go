//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func runDirectoryCollector(options directoryCollectorOptions, output io.Writer) error {
	if os.Geteuid() != 0 || !directoryCollectorServiceName(options.service) {
		return errors.New("local disk collector requires root and a valid service name")
	}
	// Keep the metadata walk on the thread whose Linux nice/I/O priorities
	// were lowered. Other existing runtime threads are lowered as well.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	runtime.GOMAXPROCS(1)
	lowerDirectoryCollectorPriority(output)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	filename := filepath.Join("/run/cf-vps-monitor-disk", options.service, "usage.json")
	for {
		started := time.Now()
		needed, err := directoryCollectorNeeded(nodeMetrics, options.include, options.exclude)
		if err == nil && !needed {
			err = errors.New("selected root no longer requires directory collection")
		}
		var result directoryScanResult
		if err == nil {
			// Root and output are fixed here; neither is an arbitrary CLI path.
			result, err = collectDirectoryDiskUsage(ctx, "/", filename, options.total, readDirectoryMountInfo, defaultDirectoryScanLimits())
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			fmt.Fprintf(output, "disk collector: refresh failed; previous sample time retained: %v\n", err)
			if options.once {
				return err
			}
		} else {
			fmt.Fprintf(output, "disk collector: used_bytes=%d sampled_at=%d entries=%d duration_ms=%d\n",
				result.usedBytes, result.sampledAt, result.entries, time.Since(started).Milliseconds())
			if options.once {
				return nil
			}
		}
		pause := max(time.Duration(0), directoryDiskScanInterval-time.Since(started))
		timer := time.NewTimer(pause)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

func collectDirectoryDiskUsage(ctx context.Context, root, filename string, total containerDiskTotalValue, mountInfo func() ([]byte, error), limits directoryScanLimits) (directoryScanResult, error) {
	lock, err := acquireDirectoryScanLock(ctx, filepath.Join(filepath.Dir(filename), "scan.lock"))
	if err != nil {
		return directoryScanResult{}, err
	}
	defer lock.Close()
	ctx, cancel := context.WithTimeout(ctx, limits.timeout)
	defer cancel()
	identity, err := readDiskRootIdentity(root)
	if err != nil {
		return directoryScanResult{}, err
	}
	var capacity *int64
	if total > 0 {
		bytes := int64(total)
		capacity = &bytes
	} else if value, err := readGuestRootDiskAllocation(ctx); err == nil {
		capacity = &value
	}
	result, err := scanDirectoryAllocated(ctx, root, mountInfo, limits)
	if err != nil {
		return directoryScanResult{}, err
	}
	after, err := readDiskRootIdentity(root)
	if err != nil || after != identity || result.rootDev != identity.dev || result.rootIno != identity.ino {
		return directoryScanResult{}, errors.New("root identity changed during disk collection")
	}
	if err := ctx.Err(); err != nil {
		return directoryScanResult{}, err
	}
	result.sampledAt = time.Now().UnixMilli()
	cache := directoryDiskCache{Version: 1, Scope: "root", Source: "directory", UsedBytes: &result.usedBytes, TotalBytes: capacity,
		SampledAt: result.sampledAt, RootDev: &result.rootDev, RootIno: &result.rootIno, BootID: identity.bootID, Complete: true}
	if err := writeDirectoryDiskCacheFile(filename, cache); err != nil {
		return directoryScanResult{}, err
	}
	return result, nil
}

func acquireDirectoryScanLock(ctx context.Context, filename string) (*os.File, error) {
	if os.Geteuid() != 0 {
		return nil, errors.New("directory scan lock requires root")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	parent, name, err := openDiskCacheParent(filename, true)
	if err != nil {
		return nil, err
	}
	defer unix.Close(parent)
	fd, err := unix.Openat(parent, name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0600)
	created := err == nil
	if errors.Is(err, unix.EEXIST) {
		fd, err = unix.Openat(parent, name, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	}
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	success := false
	defer func() {
		if !success {
			file.Close()
		}
	}()
	if created {
		if err := file.Chmod(0600); err != nil {
			return nil, err
		}
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, err
	}
	if err := verifyDiskCacheFile(&stat); err != nil || stat.Mode&0777 != 0600 || stat.Size != 0 {
		return nil, errors.New("untrusted disk scan lock file")
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("waiting for existing disk scan: %w", err)
		}
		if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err == nil {
			success = true
			return file, nil
		} else if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return nil, err
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}

func lowerDirectoryCollectorPriority(output io.Writer) {
	threads, err := os.ReadDir("/proc/self/task")
	if err != nil {
		threads = nil
	}
	ids := []int{unix.Gettid()}
	for _, thread := range threads {
		if id, err := strconv.Atoi(thread.Name()); err == nil {
			ids = append(ids, id)
		}
	}
	var niceErr, ioErr error
	for _, id := range ids {
		if err := unix.Setpriority(unix.PRIO_PROCESS, id, 19); err != nil && !errors.Is(err, unix.ESRCH) {
			niceErr = err
		}
		// IOPRIO_WHO_PROCESS=1, class 2 (best effort), priority 7. Idle I/O
		// class can starve a tiny container and repeatedly exhaust its limit.
		_, _, errno := unix.Syscall(unix.SYS_IOPRIO_SET, 1, uintptr(id), uintptr((2<<13)|7))
		if errno != 0 && errno != unix.ESRCH {
			ioErr = errno
		}
	}
	if niceErr != nil {
		fmt.Fprintf(output, "disk collector: nice 19 unavailable: %v\n", niceErr)
	}
	if ioErr != nil {
		fmt.Fprintf(output, "disk collector: low best-effort I/O priority unavailable: %v\n", ioErr)
	}
}

func readGuestRootDiskAllocation(ctx context.Context) (int64, error) {
	// Guest sockets expose instance metadata only; never use a host LXD
	// management socket, a configurable URL, HTTP proxies or credentials.
	for _, socket := range []string{"/dev/lxd/sock", "/dev/incus/sock"} {
		if value, err := readGuestDiskDevices(ctx, socket); err == nil {
			return value, nil
		}
		if err := ctx.Err(); err != nil {
			return 0, err
		}
	}
	return 0, errors.New("local guest root allocation is unavailable")
}

func readGuestDiskDevices(ctx context.Context, socket string) (int64, error) {
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			dialer := net.Dialer{Timeout: 2 * time.Second}
			return dialer.DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives: true, ResponseHeaderTimeout: 2 * time.Second, MaxResponseHeaderBytes: 8192,
	}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: 2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("guest device redirects are not allowed")
		}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://guest/1.0/devices", nil)
	if err != nil {
		return 0, err
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, errors.New("guest device request was not accepted")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxGuestDiskDevicesBytes+1))
	if err != nil {
		return 0, err
	}
	return parseContainerRootDevices(body)
}
