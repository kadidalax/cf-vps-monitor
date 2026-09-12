//go:build windows

package main

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func trafficWindowsPath(path string) (*uint16, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if len(absolute) >= 248 && !strings.HasPrefix(absolute, `\\?\`) {
		if strings.HasPrefix(absolute, `\\`) {
			absolute = `\\?\UNC\` + absolute[2:]
		} else {
			absolute = `\\?\` + absolute
		}
	}
	return windows.UTF16PtrFromString(absolute)
}

func replaceTrafficStateFile(from, to string) error {
	source, err := trafficWindowsPath(from)
	if err != nil {
		return err
	}
	target, err := trafficWindowsPath(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(source, target, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
