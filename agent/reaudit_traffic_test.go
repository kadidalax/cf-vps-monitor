package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReauditCorruptTrafficStateCanPersistAgain(t *testing.T) {
	for _, backup := range []bool{false, true} {
		t.Run(fmt.Sprintf("corrupt_backup_%t", backup), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "traffic-state.json")
			corrupt := []string{`{"truncated":`}
			if backup {
				corrupt = append(corrupt, `{"also_truncated":`)
			}
			for i, data := range corrupt {
				candidate := path
				if i == 1 {
					candidate += ".bak"
				}
				if err := os.WriteFile(candidate, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", path)
			now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
			boot := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
			tracker := newTrafficResetTracker(1, "synthetic-token", "reaudit-scope")
			tracker.adjustSinceBoot(1000, 2000, now, boot)
			if up, down := tracker.adjustSinceBoot(1100, 2200, now.Add(time.Minute), boot); up != 100 || down != 200 {
				t.Fatalf("new in-memory totals = %d/%d, want 100/200", up, down)
			}
			restarted := newTrafficResetTracker(1, "synthetic-token", "reaudit-scope")
			if up, down := restarted.adjustSinceBoot(1100, 2200, now.Add(2*time.Minute), boot); up != 100 || down != 200 {
				t.Fatalf("new traffic lost after restart: got %d/%d, want 100/200", up, down)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var saved map[string]any
			if err := json.Unmarshal(data, &saved); err != nil {
				t.Fatal(err)
			}
			if saved["history_incomplete"] != true {
				t.Fatal("unrecoverable old history was not marked incomplete")
			}
			entries, err := os.ReadDir(filepath.Dir(path))
			if err != nil {
				t.Fatal(err)
			}
			for _, expected := range corrupt {
				found := false
				for _, entry := range entries {
					preserved, err := os.ReadFile(filepath.Join(filepath.Dir(path), entry.Name()))
					if err == nil && string(preserved) == expected {
						found = true
					}
				}
				if !found {
					t.Fatalf("corrupt evidence was discarded: %s", expected)
				}
			}
		})
	}
}

func TestReauditTrafficUnreadableOrNewerGenerationIsNotDiscarded(t *testing.T) {
	valid := `{"reset_day":1,"period":"2026-09-01","counter_version":1,"revision":1}`
	for _, withBackup := range []bool{false, true} {
		for _, kind := range []string{"unreadable", "newer"} {
			t.Run(fmt.Sprintf("%s_backup_%t", kind, withBackup), func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "traffic-state.json")
				var original []byte
				if kind == "unreadable" {
					if err := os.Mkdir(path, 0700); err != nil {
						t.Fatal(err)
					}
				} else {
					original = []byte(`{"counter_version":2,"revision":100}`)
					if err := os.WriteFile(path, original, 0600); err != nil {
						t.Fatal(err)
					}
				}
				if withBackup {
					if err := os.WriteFile(path+".bak", []byte(valid), 0600); err != nil {
						t.Fatal(err)
					}
				}
				err := writeTrafficResetState(path, trafficResetState{ResetDay: 1, Period: "2026-09-01", Revision: 2}, replaceTrafficStateFile)
				if err == nil {
					t.Fatal("save must reject an unreadable or unsupported newer generation")
				}
				if original != nil {
					data, err := os.ReadFile(path)
					if err != nil || string(data) != string(original) {
						t.Fatalf("unsupported generation was changed: %s, %v", data, err)
					}
				}
				if withBackup {
					data, err := os.ReadFile(path + ".bak")
					if err != nil || string(data) != valid {
						t.Fatalf("backup changed despite a fatal read error: %s, %v", data, err)
					}
				}
			})
		}
	}
}

func TestReauditTrafficNewGenerationRecoverableAfterCorruptReplacementFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "traffic-state.json")
	if err := os.WriteFile(path, []byte(`{"truncated":`), 0600); err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected new-generation replacement failure")
	err := writeTrafficResetState(path, trafficResetState{ResetDay: 1, Period: "2026-09-01", PeriodUp: 100, PeriodDown: 200, Revision: 1}, func(string, string) error { return injected })
	if !errors.Is(err, injected) {
		t.Fatalf("new generation did not reach the replacement boundary: %v", err)
	}
	state, _, _, err := readTrafficResetState(path)
	if err != nil || state.PeriodUp != 100 || state.PeriodDown != 200 {
		t.Fatalf("fully staged new accumulation is not recoverable: %+v, %v", state, err)
	}
}

func TestReauditTrafficCorruptStagedBytesSurviveLaterSaves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "traffic-state.json")
	suffixes := []string{"", ".tmp-partial", ".backup-partial"}
	for _, suffix := range suffixes {
		if err := os.WriteFile(path+suffix, []byte(`{"broken":"`+suffix), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for revision := uint64(1); revision <= 2; revision++ {
		if err := writeTrafficResetState(path, trafficResetState{ResetDay: 1, Period: "2026-09-01", Revision: revision}, replaceTrafficStateFile); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range suffixes {
		found := false
		for _, entry := range entries {
			data, err := os.ReadFile(filepath.Join(filepath.Dir(path), entry.Name()))
			if err == nil && string(data) == `{"broken":"`+suffix {
				found = true
			}
		}
		if !found {
			t.Errorf("corrupt generation %q was removed by later cleanup", suffix)
		}
	}
}
