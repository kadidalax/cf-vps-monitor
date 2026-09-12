//go:build linux

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const maxDirectoryMountInfoBytes = 1 << 20

type directoryDiskInode struct{ dev, ino uint64 }

type directoryDiskWalker struct {
	ctx         context.Context
	limits      directoryScanLimits
	rootDev     uint64
	rootMountID uint64
	openat2     bool
	excluded    map[string]bool
	seen        map[directoryDiskInode]bool
	usedBytes   int64
	entries     int
}

func scanDirectoryAllocated(ctx context.Context, root string, mountInfo func() ([]byte, error), limits directoryScanLimits) (directoryScanResult, error) {
	if !path.IsAbs(root) || path.Clean(root) != root || mountInfo == nil || limits.maxEntries < 1 || limits.maxEntries > 200000 ||
		limits.maxDepth < 1 || limits.maxDepth > 256 || limits.timeout <= 0 || limits.timeout > directoryDiskScanTimeout {
		return directoryScanResult{}, errors.New("invalid directory scan limits or root")
	}
	ctx, cancel := context.WithTimeout(ctx, limits.timeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return directoryScanResult{}, err
	}
	before, err := mountInfo()
	if err != nil {
		return directoryScanResult{}, err
	}
	excluded, err := directoryScanMounts(before, root)
	if err != nil {
		return directoryScanResult{}, err
	}
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return directoryScanResult{}, err
	}
	file := os.NewFile(uintptr(fd), root)
	defer file.Close()
	var rootStat unix.Stat_t
	if err := unix.Fstat(fd, &rootStat); err != nil {
		return directoryScanResult{}, err
	}
	mountID, err := directoryFDModeMountID(fd)
	if err != nil {
		return directoryScanResult{}, err
	}
	walker := directoryDiskWalker{ctx: ctx, limits: limits, rootDev: uint64(rootStat.Dev), rootMountID: mountID,
		openat2: true, excluded: excluded, seen: make(map[directoryDiskInode]bool), entries: 1}
	if err := walker.countBlocks(&rootStat); err != nil {
		return directoryScanResult{}, err
	}
	if err := walker.walkDirectory(file, "", 0); err != nil {
		return directoryScanResult{}, err
	}
	after, err := mountInfo()
	if err != nil || !bytes.Equal(before, after) {
		return directoryScanResult{}, errors.New("mount topology changed or became unreadable during the scan")
	}
	var currentRoot unix.Stat_t
	if err := unix.Lstat(root, &currentRoot); err != nil || currentRoot.Dev != rootStat.Dev || currentRoot.Ino != rootStat.Ino || currentRoot.Mode&unix.S_IFMT != unix.S_IFDIR {
		return directoryScanResult{}, errors.New("scan root changed during traversal")
	}
	if err := ctx.Err(); err != nil {
		return directoryScanResult{}, err
	}
	return directoryScanResult{usedBytes: walker.usedBytes, rootDev: uint64(rootStat.Dev), rootIno: uint64(rootStat.Ino), entries: walker.entries}, nil
}

func (w *directoryDiskWalker) walkDirectory(directory *os.File, relative string, depth int) error {
	if depth > w.limits.maxDepth {
		return errors.New("directory scan depth limit exceeded")
	}
	for {
		if err := w.ctx.Err(); err != nil {
			return err
		}
		names, readErr := directory.Readdirnames(128)
		for _, name := range names {
			if err := w.ctx.Err(); err != nil {
				return err
			}
			if name == "." || name == ".." {
				continue
			}
			if name == "" || strings.ContainsRune(name, '/') {
				return errors.New("invalid directory entry")
			}
			if w.entries >= w.limits.maxEntries {
				return errors.New("directory scan entry limit exceeded")
			}
			w.entries++
			childPath := name
			if relative != "" {
				childPath = relative + "/" + name
			}
			if w.excluded[childPath] {
				continue
			}
			if err := w.visitEntry(directory, name, childPath, depth); err != nil {
				if errors.Is(err, unix.ENOENT) {
					// Concurrent removal is expected in a live filesystem.
					continue
				}
				return err
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func (w *directoryDiskWalker) visitEntry(parent *os.File, name, relative string, depth int) error {
	fd, err := w.openEntry(int(parent.Fd()), name)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return err
	}
	if uint64(stat.Dev) != w.rootDev {
		return errors.New("unexpected filesystem boundary in directory scan")
	}
	if err := w.countBlocks(&stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return nil
	}
	// Open through the pinned O_PATH descriptor, not the entry name again.
	// Replacing that name with a symlink cannot redirect this directory read.
	dirFD, err := unix.Openat(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(dirFD), relative)
	defer directory.Close()
	if err := w.walkDirectory(directory, relative, depth+1); err != nil {
		return err
	}
	var after unix.Stat_t
	if err := unix.Fstatat(int(parent.Fd()), name, &after, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if after.Dev != stat.Dev || after.Ino != stat.Ino || after.Mode&unix.S_IFMT != unix.S_IFDIR {
		return errors.New("directory was replaced during traversal")
	}
	return nil
}

func (w *directoryDiskWalker) countBlocks(stat *unix.Stat_t) error {
	key := directoryDiskInode{dev: uint64(stat.Dev), ino: uint64(stat.Ino)}
	if w.seen[key] {
		if stat.Mode&unix.S_IFMT == unix.S_IFDIR {
			return errors.New("directory appeared twice in one root scan")
		}
		return nil
	}
	w.seen[key] = true
	if stat.Blocks < 0 || stat.Blocks > maxConfiguredContainerDiskTotalBytes/512 || stat.Blocks*512 > maxConfiguredContainerDiskTotalBytes-w.usedBytes {
		return errors.New("directory allocation counter exceeds supported range")
	}
	w.usedBytes += stat.Blocks * 512
	return nil
}

func (w *directoryDiskWalker) openEntry(parent int, name string) (int, error) {
	flags := unix.O_PATH | unix.O_NOFOLLOW | unix.O_CLOEXEC
	if w.openat2 {
		fd, err := unix.Openat2(parent, name, &unix.OpenHow{Flags: uint64(flags), Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_XDEV | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
		if err == nil {
			return fd, nil
		}
		if !errors.Is(err, unix.ENOSYS) && !errors.Is(err, unix.EINVAL) {
			return -1, err
		}
		w.openat2 = false
	}
	fd, err := unix.Openat(parent, name, flags, 0)
	if err != nil {
		return -1, err
	}
	// Kernels without openat2 still need a mount identity check, including
	// same-device bind mounts. st_dev alone cannot establish this boundary.
	mountID, err := directoryFDModeMountID(fd)
	if err != nil || mountID != w.rootMountID {
		unix.Close(fd)
		return -1, errors.New("cannot prove directory entry belongs to the root mount")
	}
	return fd, nil
}

func directoryFDModeMountID(fd int) (uint64, error) {
	var stat unix.Statx_t
	if err := unix.Statx(fd, "", unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &stat); err == nil && stat.Mask&unix.STATX_MNT_ID != 0 && stat.Mnt_id != 0 {
		return stat.Mnt_id, nil
	}
	// mnt_id has been exposed in fdinfo since Linux 3.15. This fallback only
	// reads fixed proc metadata for a descriptor opened by this process.
	data, err := readBoundedDiskMetadata(fmt.Sprintf("/proc/self/fdinfo/%d", fd), 4096)
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "mnt_id:" {
			id, err := strconv.ParseUint(fields[1], 10, 64)
			if err == nil && id != 0 {
				return id, nil
			}
		}
	}
	return 0, errors.New("root mount identity is unavailable")
}

func readDirectoryMountInfo() ([]byte, error) {
	return readBoundedDiskMetadata("/proc/self/mountinfo", maxDirectoryMountInfoBytes)
}

func directoryScanMounts(data []byte, root string) (map[string]bool, error) {
	if len(data) == 0 || len(data) > maxDirectoryMountInfoBytes {
		return nil, errors.New("invalid mount table size")
	}
	excluded, rootFound := map[string]bool{}, false
	prefix := strings.TrimSuffix(root, "/") + "/"
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, " - ", 2)
		if len(parts) != 2 {
			return nil, errors.New("malformed mount table")
		}
		before, after := strings.Fields(parts[0]), strings.Fields(parts[1])
		if len(before) < 6 || len(after) < 3 {
			return nil, errors.New("incomplete mount entry")
		}
		if _, err := strconv.ParseUint(before[0], 10, 64); err != nil {
			return nil, errors.New("invalid mount identity")
		}
		mountRoot, err := directoryMountField(before[3])
		if err != nil || !path.IsAbs(mountRoot) {
			return nil, errors.New("invalid mount root")
		}
		point, err := directoryMountField(before[4])
		if err != nil || !path.IsAbs(point) || path.Clean(point) != point {
			return nil, errors.New("invalid mount point")
		}
		if point == root || point == "/" || strings.HasPrefix(root, strings.TrimSuffix(point, "/")+"/") {
			rootFound = true
		}
		if point != root && strings.HasPrefix(point, prefix) {
			excluded[strings.TrimPrefix(point, prefix)] = true
		}
	}
	if !rootFound {
		return nil, errors.New("root filesystem is missing from the mount table")
	}
	return excluded, nil
}

func directoryMountField(field string) (string, error) {
	var decoded strings.Builder
	for index := 0; index < len(field); index++ {
		if field[index] != '\\' {
			decoded.WriteByte(field[index])
			continue
		}
		if len(field)-index < 4 {
			return "", errors.New("truncated mount path escape")
		}
		switch field[index : index+4] {
		case `\040`:
			decoded.WriteByte(' ')
		case `\011`:
			decoded.WriteByte('\t')
		case `\012`:
			decoded.WriteByte('\n')
		case `\134`:
			decoded.WriteByte('\\')
		default:
			return "", errors.New("unsupported mount path escape")
		}
		index += 3
	}
	return decoded.String(), nil
}
