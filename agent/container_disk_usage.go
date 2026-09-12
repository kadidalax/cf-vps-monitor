package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"time"
)

const maxDirectoryDiskCacheBytes = 4096
const maxGuestDiskDevicesBytes = 65536
const directoryDiskCacheLifetime = 900 * time.Second

var diskBootIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)
var containerDiskSizePattern = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)(B|kB|KB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|PiB)?$`)

// A snapshot keeps usage, capacity and provenance from the same cache read.
type diskUsageSnapshot struct {
	used, total *int64
	source      string
	sampledAt   int64
}

var diskUsageFile string

type diskRootIdentity struct {
	dev, ino uint64
	bootID   string
}

type directoryDiskCache struct {
	Version    int     `json:"version"`
	Scope      string  `json:"scope"`
	Source     string  `json:"source"`
	UsedBytes  *int64  `json:"used_bytes"`
	TotalBytes *int64  `json:"total_bytes,omitempty"`
	SampledAt  int64   `json:"sampled_at"`
	RootDev    *uint64 `json:"root_dev"`
	RootIno    *uint64 `json:"root_ino"`
	BootID     string  `json:"boot_id"`
	Complete   bool    `json:"complete"`
}

type directoryScanLimits struct {
	maxEntries int
	maxDepth   int
	timeout    time.Duration
}

type directoryScanResult struct {
	usedBytes int64
	rootDev   uint64
	rootIno   uint64
	entries   int
	sampledAt int64
}

func decodeDirectoryDiskCache(data []byte, identity diskRootIdentity, now time.Time) (diskUsageSnapshot, error) {
	invalid := func() (diskUsageSnapshot, error) {
		return diskUsageSnapshot{}, errors.New("invalid or expired directory disk cache")
	}
	if len(data) == 0 || len(data) > maxDirectoryDiskCacheBytes {
		return invalid()
	}
	fields, err := diskJSONObject(data)
	if err != nil {
		return invalid()
	}
	// encoding/json accepts case-insensitive struct tags. Require the cache's
	// canonical keys before decoding so aliases cannot bypass presence checks.
	for name := range fields {
		switch name {
		case "version", "scope", "source", "used_bytes", "total_bytes", "sampled_at", "root_dev", "root_ino", "boot_id", "complete":
		default:
			return invalid()
		}
	}
	var cache directoryDiskCache
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cache); err != nil {
		return invalid()
	}
	if cache.Version != 1 || cache.Scope != "root" || cache.Source != "directory" || !cache.Complete ||
		cache.UsedBytes == nil || *cache.UsedBytes < 0 || *cache.UsedBytes > maxConfiguredContainerDiskTotalBytes ||
		cache.RootDev == nil || cache.RootIno == nil || *cache.RootDev != identity.dev || *cache.RootIno != identity.ino ||
		!diskBootIDPattern.MatchString(cache.BootID) || cache.BootID != identity.bootID ||
		cache.SampledAt <= 0 || cache.SampledAt > now.UnixMilli()+5000 || cache.SampledAt < now.Add(-directoryDiskCacheLifetime).UnixMilli() {
		return invalid()
	}
	if cache.TotalBytes != nil {
		if *cache.TotalBytes <= 0 || *cache.TotalBytes > maxConfiguredContainerDiskTotalBytes {
			return invalid()
		}
	} else if _, present := fields["total_bytes"]; present {
		return invalid()
	}
	return diskUsageSnapshot{used: cache.UsedBytes, total: cache.TotalBytes, source: "directory", sampledAt: cache.SampledAt}, nil
}

// Reject duplicate keys and trailing values, so the same cache cannot have
// different interpretations in separate consumers.
func diskJSONObject(data []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, errors.New("expected a JSON object")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		name, ok := key.(string)
		if !ok {
			return nil, errors.New("invalid JSON object key")
		}
		if _, exists := fields[name]; exists {
			return nil, errors.New("duplicate JSON object key")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[name] = value
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return nil, errors.New("incomplete JSON object")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("unexpected trailing JSON")
	}
	return fields, nil
}

func parseContainerDiskSize(value string) (int64, error) {
	invalid := errors.New("invalid container disk allocation")
	if len(value) > 64 {
		return 0, invalid
	}
	parts := containerDiskSizePattern.FindStringSubmatch(value)
	if len(parts) != 3 {
		return 0, invalid
	}
	factor := map[string]int64{
		"": 1, "B": 1, "kB": 1000, "KB": 1000, "MB": 1000000, "GB": 1000000000,
		"TB": 1000000000000, "PB": 1000000000000000,
		"KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30, "TiB": 1 << 40, "PiB": 1 << 50,
	}[parts[2]]
	amount, ok := new(big.Rat).SetString(parts[1])
	if !ok {
		return 0, invalid
	}
	amount.Mul(amount, new(big.Rat).SetInt64(factor))
	if !amount.IsInt() || !amount.Num().IsInt64() {
		return 0, invalid
	}
	result := amount.Num().Int64()
	if result <= 0 || result > maxConfiguredContainerDiskTotalBytes {
		return 0, invalid
	}
	return result, nil
}

func parseContainerRootDevices(data []byte) (int64, error) {
	if len(data) > maxGuestDiskDevicesBytes {
		return 0, errors.New("guest device response exceeds limit")
	}
	devices, err := diskJSONObject(data)
	if err != nil {
		return 0, err
	}
	roots, size := 0, ""
	for _, raw := range devices {
		properties, err := diskJSONObject(raw)
		if err != nil {
			return 0, err
		}
		device := map[string]string{}
		for key, value := range properties {
			var text string
			if err := json.Unmarshal(value, &text); err != nil {
				return 0, errors.New("invalid guest device property")
			}
			device[key] = text
		}
		if device["type"] == "disk" && device["path"] == "/" {
			roots++
			size = device["size"]
		}
	}
	if roots != 1 {
		return 0, fmt.Errorf("guest devices contain %d root disks", roots)
	}
	return parseContainerDiskSize(size)
}
