//go:build linux

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func readDirectoryDiskCache(root, filename string, now time.Time) (diskUsageSnapshot, error) {
	identity, err := readDiskRootIdentity(root)
	if err != nil {
		return diskUsageSnapshot{}, err
	}
	parent, name, err := openDiskCacheParent(filename, false)
	if err != nil {
		return diskUsageSnapshot{}, err
	}
	defer unix.Close(parent)
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return diskUsageSnapshot{}, err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	var before, after unix.Stat_t
	if err := unix.Fstat(fd, &before); err != nil {
		return diskUsageSnapshot{}, err
	}
	if err := verifyDiskCacheFile(&before); err != nil || before.Size < 1 || before.Size > maxDirectoryDiskCacheBytes {
		return diskUsageSnapshot{}, errors.New("untrusted or oversized disk cache")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxDirectoryDiskCacheBytes+1))
	if err != nil {
		return diskUsageSnapshot{}, err
	}
	if err := unix.Fstat(fd, &after); err != nil {
		return diskUsageSnapshot{}, err
	}
	if err := verifyDiskCacheFile(&after); err != nil || before.Size != after.Size || before.Mtim != after.Mtim || before.Ctim != after.Ctim {
		return diskUsageSnapshot{}, errors.New("disk cache changed while reading")
	}
	afterIdentity, err := readDiskRootIdentity(root)
	if err != nil || afterIdentity != identity {
		return diskUsageSnapshot{}, errors.New("root identity changed while reading disk cache")
	}
	return decodeDirectoryDiskCache(data, identity, now)
}

func writeDirectoryDiskCacheFile(filename string, cache directoryDiskCache) error {
	if os.Geteuid() != 0 {
		return errors.New("disk cache writer requires root")
	}
	data, err := json.Marshal(cache)
	if err != nil {
		return err
	}
	if cache.RootDev == nil || cache.RootIno == nil {
		return errors.New("disk cache lacks root identity")
	}
	identity := diskRootIdentity{dev: *cache.RootDev, ino: *cache.RootIno, bootID: cache.BootID}
	if _, err := decodeDirectoryDiskCache(data, identity, time.Now()); err != nil {
		return err
	}
	parent, name, err := openDiskCacheParent(filename, true)
	if err != nil {
		return err
	}
	defer unix.Close(parent)
	if err := verifyDiskCacheDestination(parent, name); err != nil {
		return err
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	temporary := ".usage-" + hex.EncodeToString(nonce[:]) + ".tmp"
	fd, err := unix.Openat(parent, temporary, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0644)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), temporary)
	defer file.Close()
	defer unix.Unlinkat(parent, temporary, 0)
	if err := file.Chmod(0644); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := verifyDiskCacheDestination(parent, name); err != nil {
		return err
	}
	if err := unix.Renameat(parent, temporary, parent, name); err != nil {
		return err
	}
	// The directory handle pins the already verified parent through rename.
	dir, err := unix.Openat(parent, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	return unix.Fsync(dir)
}

func verifyDiskCacheFile(stat *unix.Stat_t) error {
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != 0 || stat.Mode&0022 != 0 || stat.Nlink != 1 {
		return errors.New("disk cache must be a root-owned, non-writable, single-link regular file")
	}
	return nil
}

func verifyDiskCacheDestination(parent int, name string) error {
	var stat unix.Stat_t
	if err := unix.Fstatat(parent, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return err
	}
	return verifyDiskCacheFile(&stat)
}

func openDiskCacheParent(filename string, create bool) (int, string, error) {
	if !filepath.IsAbs(filename) || filepath.Clean(filename) != filename || filepath.Base(filename) == "/" {
		return -1, "", errors.New("disk cache requires a clean absolute file path")
	}
	fd, err := openTrustedDiskDirectory(filepath.Dir(filename), create)
	return fd, filepath.Base(filename), err
}

// Walk one component at a time, holding directory descriptors. Checking a
// path with Lstat and later reopening its full string would allow a parent
// symlink/rename race in a root process.
func openTrustedDiskDirectory(directory string, create bool) (int, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return -1, errors.New("invalid disk cache directory")
	}
	fd, err := unix.Open("/", unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	components := strings.Split(strings.TrimPrefix(directory, "/"), "/")
	for index := -1; index < len(components); index++ {
		created := false
		if index >= 0 {
			component := components[index]
			if component == "" {
				continue
			}
			next, openErr := unix.Openat(fd, component, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if errors.Is(openErr, unix.ENOENT) && create {
				makeErr := unix.Mkdirat(fd, component, 0755)
				if makeErr != nil && !errors.Is(makeErr, unix.EEXIST) {
					unix.Close(fd)
					return -1, makeErr
				}
				created = makeErr == nil
				next, openErr = unix.Openat(fd, component, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
			unix.Close(fd)
			if openErr != nil {
				return -1, openErr
			}
			fd = next
		}
		var stat unix.Stat_t
		if err := unix.Fstat(fd, &stat); err != nil {
			unix.Close(fd)
			return -1, err
		}
		if stat.Mode&unix.S_IFMT != unix.S_IFDIR || stat.Uid != 0 || stat.Mode&0022 != 0 {
			unix.Close(fd)
			return -1, errors.New("disk cache ancestor must be root-owned and not group/world writable")
		}
		if created {
			// A service may inherit umask 077. Only directories created by
			// this call are made traversable by the ordinary Agent user.
			owned, openErr := unix.Openat(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if openErr == nil {
				openErr = unix.Fchmod(owned, 0755)
				unix.Close(owned)
			}
			if openErr != nil {
				unix.Close(fd)
				return -1, openErr
			}
		}
	}
	return fd, nil
}

func readDiskRootIdentity(root string) (diskRootIdentity, error) {
	fd, err := unix.Open(root, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return diskRootIdentity{}, err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return diskRootIdentity{}, err
	}
	data, err := readBoundedDiskMetadata(filepath.Join(root, "proc/sys/kernel/random/boot_id"), 128)
	if err != nil {
		return diskRootIdentity{}, err
	}
	bootID := strings.TrimSpace(string(data))
	if !diskBootIDPattern.MatchString(bootID) {
		return diskRootIdentity{}, errors.New("invalid root boot identity")
	}
	return diskRootIdentity{dev: uint64(stat.Dev), ino: uint64(stat.Ino), bootID: bootID}, nil
}

func readBoundedDiskMetadata(filename string, maximum int64) ([]byte, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, fmt.Errorf("disk metadata exceeds %d bytes", maximum)
	}
	return data, nil
}
