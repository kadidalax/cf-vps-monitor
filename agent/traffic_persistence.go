package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var errTrafficStateNewerFormat = errors.New("unsupported newer traffic counter format")

type trafficStateCorruption struct {
	paths []string
	err   error
}

func (e *trafficStateCorruption) Error() string {
	return "no valid traffic state generation: " + e.err.Error()
}
func (e *trafficStateCorruption) Unwrap() error { return e.err }

func decodeTrafficState(data []byte) (trafficResetState, error) {
	var state trafficResetState
	if err := json.Unmarshal(data, &state); err != nil {
		return state, err
	}
	if state.CounterVersion > 1 {
		return state, errTrafficStateNewerFormat
	}
	if state.PolicyResetDay != nil && (*state.PolicyResetDay < 1 || *state.PolicyResetDay > 31) {
		return state, errors.New("invalid saved traffic policy")
	}
	if state.LastRawUp < 0 || state.LastRawDown < 0 || state.PeriodUp < 0 || state.PeriodDown < 0 || state.BaselineUp < 0 || state.BaselineDown < 0 || state.LastBootUnix < 0 || state.CounterVersion < 0 {
		return state, errors.New("invalid saved traffic counters")
	}
	if state.Period == "" {
		if state.PolicyResetDay == nil || state.PeriodUp != 0 || state.PeriodDown != 0 {
			return state, errors.New("missing saved traffic period")
		}
	} else {
		if state.ResetDay < 1 || state.ResetDay > 31 {
			return state, errors.New("invalid saved reset day")
		}
		if _, err := time.Parse(time.DateOnly, state.Period); err != nil {
			return state, err
		}
	}
	return state, nil
}

func trafficStateCandidates(path string) ([]string, error) {
	paths := []string{path, path + ".bak", path + ".tmp"}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	base := filepath.Base(path)
	for _, entry := range entries {
		if !entry.IsDir() && (strings.HasPrefix(entry.Name(), base+".tmp-") || strings.HasPrefix(entry.Name(), base+".backup-")) {
			paths = append(paths, filepath.Join(filepath.Dir(path), entry.Name()))
		}
	}
	return paths, nil
}

// A complete staged snapshot is recoverable. Main wins ties for legacy files without revisions.
func readTrafficResetState(path string) (trafficResetState, []byte, string, error) {
	var best trafficResetState
	var bestData []byte
	var bestPath string
	var failures []error
	var corruptPaths []string
	var fatalErrors []error
	candidates, err := trafficStateCandidates(path)
	if err != nil {
		return best, nil, "", err
	}
	for _, candidate := range candidates {
		data, err := os.ReadFile(candidate)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			fatalErrors = append(fatalErrors, err)
			continue
		}
		state, err := decodeTrafficState(data)
		if err != nil {
			if errors.Is(err, errTrafficStateNewerFormat) {
				fatalErrors = append(fatalErrors, fmt.Errorf("%s: %w", filepath.Base(candidate), err))
				continue
			}
			failures = append(failures, fmt.Errorf("%s: %w", filepath.Base(candidate), err))
			corruptPaths = append(corruptPaths, candidate)
			continue
		}
		if bestPath == "" || state.Revision > best.Revision {
			best, bestData, bestPath = state, data, candidate
		}
	}
	// An unreadable or newer candidate could supersede the known generation.
	// Never overwrite it merely because an older readable backup exists.
	if len(fatalErrors) > 0 {
		return best, nil, "", errors.Join(fatalErrors...)
	}
	if bestPath != "" {
		return best, bestData, bestPath, nil
	}
	if len(failures) > 0 {
		return best, nil, "", &trafficStateCorruption{paths: corruptPaths, err: errors.Join(failures...)}
	}
	return best, nil, "", os.ErrNotExist
}

func quarantineTrafficState(statePath string, paths []string) error {
	for _, path := range paths {
		// Copy and sync the damaged bytes outside the recovery candidate names
		// before removing the original. A failed copy/remove remains retryable.
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if _, err := writeSyncedTrafficTemp(filepath.Dir(path), filepath.Base(statePath)+".corrupt-", data); err != nil {
			return err
		}
		if err := syncTrafficDirectory(filepath.Dir(path)); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return nil
}

func writeSyncedTrafficTemp(directory, prefix string, data []byte) (string, error) {
	file, err := os.CreateTemp(directory, prefix)
	if err != nil {
		return "", err
	}
	name := file.Name()
	count, writeErr := file.Write(data)
	if writeErr == nil && count != len(data) {
		writeErr = io.ErrShortWrite
	}
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		_ = os.Remove(name)
		return "", err
	}
	return name, nil
}

func syncTrafficDirectory(directory string) error {
	if runtime.GOOS == "windows" {
		// Windows uses MoveFileEx with WRITE_THROUGH and a separately synced prior generation.
		return nil
	}
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func writeTrafficResetState(path string, state trafficResetState, replace func(string, string) error) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	prior, priorData, _, readErr := readTrafficResetState(path)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		var corruption *trafficStateCorruption
		if !errors.As(readErr, &corruption) {
			return readErr
		}
		if err := quarantineTrafficState(path, corruption.paths); err != nil {
			return err
		}
		state.HistoryIncomplete = true
	}
	if prior.Period == state.Period && prior.HistoryIncomplete {
		state.HistoryIncomplete = true
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	staged, err := writeSyncedTrafficTemp(directory, filepath.Base(path)+".tmp-", data)
	if err != nil {
		return err
	}
	// Keep the complete staged file on failure so a subsequent process can recover it.
	if len(priorData) > 0 {
		backupStage, err := writeSyncedTrafficTemp(directory, filepath.Base(path)+".backup-", priorData)
		if err != nil {
			return err
		}
		if err := replace(backupStage, path+".bak"); err != nil {
			return err
		}
		if err := syncTrafficDirectory(directory); err != nil {
			return err
		}
	}
	if err := replace(staged, path); err != nil {
		return err
	}
	if err := syncTrafficDirectory(directory); err != nil {
		return err
	}
	candidates, err := trafficStateCandidates(path)
	if err != nil {
		return err
	}
	for _, candidate := range candidates {
		if candidate != path && candidate != path+".bak" {
			_ = os.Remove(candidate)
		}
	}
	return nil
}
