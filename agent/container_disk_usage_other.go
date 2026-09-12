//go:build !linux

package main

import (
	"errors"
	"io"
	"time"
)

func readDirectoryDiskCache(string, string, time.Time) (diskUsageSnapshot, error) {
	return diskUsageSnapshot{}, errors.New("directory disk cache is supported only on Linux")
}

func runDirectoryCollector(directoryCollectorOptions, io.Writer) error {
	return errors.New("directory disk collector is supported only on Linux")
}
