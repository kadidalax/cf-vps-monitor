//go:build !windows

package main

import "os"

func replaceTrafficStateFile(from, to string) error { return os.Rename(from, to) }
