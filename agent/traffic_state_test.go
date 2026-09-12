package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAUD21OneDirectionCounterReset(t *testing.T) {
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", filepath.Join(t.TempDir(), "traffic-state.json"))
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	boot := time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)
	tracker := newTrafficResetTracker(1, "fixture-token", "same-scope")
	tracker.adjustSinceBoot(100, 12000, now, boot)
	up, down := tracker.adjustSinceBoot(700, 800, now.Add(time.Minute), boot)
	if up != 700 || down != 12800 {
		t.Fatalf("same boot with only download reset: got %d/%d, want 700/12800", up, down)
	}
}

func TestAUD22PersistedPolicySurvivesProcessRestart(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	boot := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	type totals struct{ FirstUp, FirstDown, AfterUp, AfterDown int64 }
	if os.Getenv("CF_AUD22_CHILD") == "1" {
		trafficTracker = newTrafficResetTracker(trafficResetDay, "fixture", "policy-scope")
		firstUp, firstDown := trafficTracker.adjustSinceBoot(1000, 2000, now, boot)
		day, err := strconv.Atoi(os.Getenv("CF_AUD22_POLICY"))
		if err != nil {
			t.Fatal(err)
		}
		applyTrafficResetDayPolicy(agentPolicy{Type: "policy", TrafficResetDay: &day})
		afterUp, afterDown := trafficTracker.adjustSinceBoot(1000, 2000, now.Add(time.Minute), boot)
		encoded, _ := json.Marshal(totals{firstUp, firstDown, afterUp, afterDown})
		fmt.Println("AUD22_RESULT=" + string(encoded))
		return
	}
	previousDay, previousTracker := trafficResetDay, trafficTracker
	t.Cleanup(func() { trafficResetDay, trafficTracker = previousDay, previousTracker })
	for _, day := range []int{15, 20, 1} {
		t.Run(fmt.Sprint(day), func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "traffic-state.json")
			t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", file)
			trafficResetDay = 1
			trafficTracker = newTrafficResetTracker(1, "fixture", "policy-scope")
			serverDay := 15
			applyTrafficResetDayPolicy(agentPolicy{Type: "policy", TrafficResetDay: &serverDay})
			trafficTracker.adjustSinceBoot(900, 1800, now.Add(-2*time.Minute), boot)
			trafficTracker.adjustSinceBoot(1000, 2000, now.Add(-time.Minute), boot)
			command := exec.Command(os.Args[0], "-test.run=^TestAUD22PersistedPolicySurvivesProcessRestart$", "-traffic-reset-day=1")
			command.Env = append(os.Environ(), "CF_AUD22_CHILD=1", "CF_AUD22_POLICY="+strconv.Itoa(day))
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("child restart failed: %v\n%s", err, output)
			}
			var got totals
			found := false
			for _, line := range strings.Split(string(output), "\n") {
				if strings.HasPrefix(line, "AUD22_RESULT=") {
					if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "AUD22_RESULT=")), &got); err != nil {
						t.Fatal(err)
					}
					found = true
				}
			}
			if !found {
				t.Fatalf("missing child totals: %s", output)
			}
			if got.FirstUp != 100 || got.FirstDown != 200 {
				t.Fatalf("first sample erased persisted policy totals: %+v", got)
			}
			if day == 15 && (got.AfterUp != 100 || got.AfterDown != 200) {
				t.Fatalf("unchanged server policy erased history: %+v", got)
			}
			if day != 15 && (got.AfterUp != 0 || got.AfterDown != 0) {
				t.Fatalf("changed server policy did not restart the period: %+v", got)
			}
		})
	}
}

func TestAUD22ExplicitLocalDayChangeStillRestartsPeriod(t *testing.T) {
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", filepath.Join(t.TempDir(), "traffic-state.json"))
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	boot := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	previous := newTrafficResetTracker(15, "fixture", "local-scope")
	previous.adjustSinceBoot(900, 1800, now.Add(-time.Minute), boot)
	previous.adjustSinceBoot(1000, 2000, now, boot)
	changed := newTrafficResetTracker(1, "fixture", "local-scope")
	up, down := changed.adjustSinceBoot(1000, 2000, now.Add(time.Minute), boot)
	if up != 0 || down != 0 {
		t.Fatalf("explicit local cycle change must still restart: %d/%d", up, down)
	}
}

func TestAUD21InterfaceSelectionChangesPreserveTotals(t *testing.T) {
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", filepath.Join(t.TempDir(), "traffic-state.json"))
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	boot := time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)
	tracker := newTrafficResetTracker(1, "fixture-token", "same-scope")
	cases := []struct {
		name     string
		counters map[string]interfaceCounters
		up, down int64
	}{
		{"initial", map[string]interfaceCounters{"eth0": {1000, 2000}, "eth1": {2000, 4000}}, 3000, 6000},
		{"remove", map[string]interfaceCounters{"eth0": {1100, 2200}}, 3100, 6200},
		{"reappear", map[string]interfaceCounters{"eth0": {1200, 2400}, "eth1": {3000, 6000}}, 3200, 6400},
		{"normal", map[string]interfaceCounters{"eth0": {1300, 2600}, "eth1": {3010, 6020}}, 3310, 6620},
		{"one direction resets", map[string]interfaceCounters{"eth0": {20, 2700}, "eth1": {3020, 6030}}, 3340, 6730},
	}
	for index, tc := range cases {
		up, down := tracker.adjustInterfacesSinceBoot(tc.counters, now.Add(time.Duration(index)*time.Minute), boot)
		if up != tc.up || down != tc.down {
			t.Fatalf("%s: got %d/%d, want %d/%d", tc.name, up, down, tc.up, tc.down)
		}
	}
	restarted := newTrafficResetTracker(1, "rotated-token", "same-scope")
	up, down := restarted.adjustInterfacesSinceBoot(cases[len(cases)-1].counters, now.Add(6*time.Minute), boot)
	if up != 3340 || down != 6730 {
		t.Fatalf("process restart changed totals: %d/%d", up, down)
	}
	newBoot := now.Add(7 * time.Minute)
	up, down = restarted.adjustInterfacesSinceBoot(map[string]interfaceCounters{"eth0": {100, 200}}, now.Add(8*time.Minute), newBoot)
	if up != 3440 || down != 6930 {
		t.Fatalf("new boot must add only its counters: %d/%d", up, down)
	}
	up, down = restarted.adjustInterfacesSinceBoot(map[string]interfaceCounters{"eth0": {110, 220}}, now.Add(9*time.Minute), newBoot)
	if up != 3450 || down != 6950 {
		t.Fatalf("new boot counted twice: %d/%d", up, down)
	}
}

func TestAUD21LegacyAggregateMigrationRetainsKnownHistory(t *testing.T) {
	file := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", file)
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	boot := time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)
	legacy := trafficResetState{ResetDay: 1, Period: "2026-09-01", Scope: "same-scope", LastRawUp: 3000, LastRawDown: 6000,
		PeriodUp: 3000, PeriodDown: 6000, LastBootUnix: boot.Unix()}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	tracker := newTrafficResetTracker(1, "fixture", "same-scope")
	up, down := tracker.adjustInterfacesSinceBoot(map[string]interfaceCounters{"eth0": {1100, 2200}}, now, boot)
	if up != 3000 || down != 6000 {
		t.Fatalf("migration invented or lost historical totals: %d/%d", up, down)
	}
	up, down = tracker.adjustInterfacesSinceBoot(map[string]interfaceCounters{"eth0": {1200, 2400}}, now.Add(time.Minute), boot)
	if up != 3100 || down != 6200 {
		t.Fatalf("post-migration delta: %d/%d", up, down)
	}
}

func TestAUD36RecoveryAcrossWriteStages(t *testing.T) {
	if os.Getenv("CF_AUD36_CHILD") == "1" {
		tracker := newTrafficResetTracker(1, "fixture", "persist")
		up, down := tracker.adjustSinceBoot(1100, 2100, time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC), time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
		fmt.Printf("AUD36_RESULT=%d/%d\n", up, down)
		return
	}
	old := `{"reset_day":1,"period":"2026-09-01","scope":"persist","last_raw_up":1000,"last_raw_down":2000,"period_up":100,"period_down":200,"counter_version":1,"interfaces":{"":{"sent":1000,"recv":2000}},"reset_day_source":"local","revision":1}`
	newer := `{"reset_day":1,"period":"2026-09-01","scope":"persist","last_raw_up":1100,"last_raw_down":2100,"period_up":200,"period_down":300,"counter_version":1,"interfaces":{"":{"sent":1100,"recv":2100}},"reset_day_source":"local","revision":2}`
	cases := []struct {
		name  string
		files map[string]string
	}{
		{"before staging", map[string]string{"": old}},
		{"partial stage", map[string]string{"": old, ".tmp-new": `{"period":`}},
		{"complete stage", map[string]string{"": old, ".tmp-new": newer}},
		{"backup staging", map[string]string{"": old, ".tmp-new": newer, ".backup-new": old}},
		{"legacy main missing", map[string]string{".tmp": newer}},
		{"main missing with backup", map[string]string{".bak": old, ".tmp-new": newer}},
		{"corrupt main with backup", map[string]string{"": `{"broken":`, ".bak": old}},
		{"replacement committed", map[string]string{"": newer, ".bak": old}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "traffic-state.json")
			t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", file)
			for suffix, content := range tc.files {
				if err := os.WriteFile(file+suffix, []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
			}
			command := exec.Command(os.Args[0], "-test.run=^TestAUD36RecoveryAcrossWriteStages$")
			command.Env = append(os.Environ(), "CF_AUD36_CHILD=1")
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("restart process failed: %v\n%s", err, output)
			}
			if !strings.Contains(string(output), "AUD36_RESULT=200/300") {
				t.Fatalf("known persisted traffic was lost after %s:\n%s", tc.name, output)
			}
		})
	}
}

func TestAUD36ReplacementFailureRetainsOldOrNewState(t *testing.T) {
	for _, suffix := range []string{".bak", ""} {
		t.Run("replace"+suffix, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "traffic-state.json")
			t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", file)
			old := trafficResetState{ResetDay: 1, Period: "2026-09-01", Scope: "persist", LastRawUp: 1000, LastRawDown: 2000,
				PeriodUp: 100, PeriodDown: 200, CounterVersion: 1, Interfaces: map[string]trafficInterfaceState{"": {1000, 2000}}, ResetDaySource: "local", Revision: 1}
			data, _ := json.Marshal(old)
			if err := os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
			newer := old
			newer.LastRawUp, newer.LastRawDown, newer.PeriodUp, newer.PeriodDown, newer.Revision = 1100, 2100, 200, 300, 2
			newer.Interfaces = map[string]trafficInterfaceState{"": {1100, 2100}}
			injected := errors.New("injected replace failure")
			err := writeTrafficResetState(file, newer, func(from, to string) error {
				if _, err := os.Stat(file); err != nil {
					t.Fatalf("sole committed file was removed before replacement: %v", err)
				}
				if to == file+suffix {
					return injected
				}
				return replaceTrafficStateFile(from, to)
			})
			if !errors.Is(err, injected) {
				t.Fatalf("wanted replacement failure, got %v", err)
			}
			restarted := newTrafficResetTracker(1, "fixture", "persist")
			up, down := restarted.adjustSinceBoot(1100, 2100, time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC), time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
			if up != 200 || down != 300 {
				t.Fatalf("replacement failure lost traffic: %d/%d", up, down)
			}
		})
	}
}

func TestAUD36RevisionSurvivesIntentionalCycleReset(t *testing.T) {
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", filepath.Join(t.TempDir(), "traffic-state.json"))
	previousDay, previousTracker := trafficResetDay, trafficTracker
	t.Cleanup(func() { trafficResetDay, trafficTracker = previousDay, previousTracker })
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	boot := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	trafficResetDay = 1
	trafficTracker = newTrafficResetTracker(1, "fixture", "persist")
	day := 15
	applyTrafficResetDayPolicy(agentPolicy{Type: "policy", TrafficResetDay: &day})
	trafficTracker.adjustSinceBoot(900, 1800, now, boot)
	trafficTracker.adjustSinceBoot(1000, 2000, now.Add(time.Minute), boot)
	day = 20
	applyTrafficResetDayPolicy(agentPolicy{Type: "policy", TrafficResetDay: &day})
	trafficTracker.adjustSinceBoot(1000, 2000, now.Add(2*time.Minute), boot)
	trafficTracker.adjustSinceBoot(1100, 2200, now.Add(3*time.Minute), boot)
	restarted := newTrafficResetTracker(1, "fixture", "persist")
	up, down := restarted.adjustSinceBoot(1100, 2200, now.Add(4*time.Minute), boot)
	if up != 100 || down != 200 {
		t.Fatalf("old backup overrode the new cycle: %d/%d", up, down)
	}
}
