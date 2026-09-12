package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

func TestReauditTemperatureUnknownReportJSON(t *testing.T) {
	body, err := json.Marshal(Report{})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatal(err)
	}
	if value := string(fields["temp"]); value != "null" {
		t.Fatalf("unmeasured host temperature = %s; want explicit JSON null", value)
	}
}

func assertReauditTemperatureJSON(t *testing.T, report Report, want *float64) {
	t.Helper()
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatal(err)
	}
	value, present := fields["temp"]
	if !present {
		t.Fatal("temperature field is missing")
	}
	if want == nil {
		if string(value) != "null" {
			t.Fatalf("unavailable temperature = %s, want null", value)
		}
		return
	}
	if string(value) == "null" {
		t.Fatalf("measured temperature became null, want %v", *want)
	}
	var got float64
	if err := json.Unmarshal(value, &got); err != nil || got != *want {
		t.Fatalf("temperature = %s, want %v (decode error: %v)", value, *want, err)
	}
}

func TestReauditTemperatureSensorContract(t *testing.T) {
	pointer := func(v float64) *float64 { return &v }
	for _, tc := range []struct {
		name    string
		sensors []host.TemperatureStat
		err     error
		want    *float64
	}{
		{
			name: "maximum identified CPU package and SoC, not GPU or disk",
			sensors: []host.TemperatureStat{
				{SensorKey: "coretemp_package_id_0", Temperature: 61.25},
				{SensorKey: "coretemp_core_1", Temperature: 58},
				{SensorKey: "cpu-thermal", Temperature: 72.125},
				{SensorKey: "amdgpu_edge", Temperature: 95},
				{SensorKey: "nvme_composite", Temperature: 110},
			},
			want: pointer(72.125),
		},
		{name: "real zero", sensors: []host.TemperatureStat{{SensorKey: "k10temp_tdie", Temperature: 0}}, want: pointer(0)},
		{name: "negative Celsius", sensors: []host.TemperatureStat{{SensorKey: "k8temp", Temperature: -7.5}}, want: pointer(-7.5)},
		{name: "lower bound", sensors: []host.TemperatureStat{{SensorKey: "soc_thermal", Temperature: -100}}, want: pointer(-100)},
		{name: "upper bound", sensors: []host.TemperatureStat{{SensorKey: "x86_pkg_temp", Temperature: 150}}, want: pointer(150)},
		{name: "unlabelled CPU driver", sensors: []host.TemperatureStat{{SensorKey: "coretemp", Temperature: 42}}, want: pointer(42)},
		{name: "explicit SoC driver", sensors: []host.TemperatureStat{{SensorKey: "bcm2835_thermal", Temperature: 38}}, want: pointer(38)},
		{name: "normalized known key", sensors: []host.TemperatureStat{{SensorKey: " Coretemp_Core_0 ", Temperature: 39}}, want: pointer(39)},
		{
			name: "invalid CPU readings do not hide valid measurements",
			sensors: []host.TemperatureStat{
				{SensorKey: "coretemp_core_0", Temperature: math.NaN()},
				{SensorKey: "coretemp_core_1", Temperature: math.Inf(1)},
				{SensorKey: "coretemp_core_2", Temperature: math.Inf(-1)},
				{SensorKey: "coretemp_core_3", Temperature: -100.1},
				{SensorKey: "coretemp_core_4", Temperature: 150.1},
				{SensorKey: "coretemp_core_5", Temperature: 31.5},
			},
			want: pointer(31.5),
		},
		{name: "only invalid", sensors: []host.TemperatureStat{{SensorKey: "coretemp", Temperature: math.NaN()}, {SensorKey: "cpu-thermal", Temperature: 1000}}},
		{name: "GPU only", sensors: []host.TemperatureStat{{SensorKey: "amdgpu_core", Temperature: 90}, {SensorKey: "nouveau_core", Temperature: 95}}},
		{name: "unknown ACPI and board sensors", sensors: []host.TemperatureStat{{SensorKey: `ACPI\ThermalZone\TZ00_0`, Temperature: 27}, {SensorKey: "acpitz", Temperature: 28}, {SensorKey: "board_cpu", Temperature: 80}, {SensorKey: "ambient", Temperature: 25}}},
		{name: "similar labels are not CPU proof", sensors: []host.TemperatureStat{{SensorKey: "coretemperature", Temperature: 75}, {SensorKey: "coretemp_gpu", Temperature: 85}, {SensorKey: "gpu_coretemp_core_1", Temperature: 90}, {SensorKey: "k10temp_tccd1_gpu", Temperature: 95}}},
		{name: "Tctl is not measured Celsius", sensors: []host.TemperatureStat{{SensorKey: "k10temp_tctl", Temperature: 95}, {SensorKey: "k10temp", Temperature: 85}}},
		{name: "Tdie and Tccd survive a hotter control value", sensors: []host.TemperatureStat{{SensorKey: "k10temp_tctl", Temperature: 100}, {SensorKey: "k10temp_tdie", Temperature: 45.25}, {SensorKey: "k10temp_tccd1", Temperature: 48.5}, {SensorKey: "k10temp_tccd2", Temperature: 47}}, want: pointer(48.5)},
		{name: "no devices"},
		{name: "read failed", err: errors.New("synthetic sensor read failed")},
		{name: "partial samples with read failure", sensors: []host.TemperatureStat{{SensorKey: "coretemp", Temperature: 42}}, err: errors.New("synthetic partial read")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sampler := newHostTemperatureSampler("linux", func(ctx context.Context) ([]host.TemperatureStat, error) {
				return tc.sensors, tc.err
			})
			value := sampler.sample(context.Background())
			assertReauditTemperatureJSON(t, Report{Temp: value, CPU: 17}, tc.want)
		})
	}
}

func TestReauditTemperaturePlatformReadBoundary(t *testing.T) {
	for _, goos := range []string{"linux", "windows", "darwin", "freebsd", "unknown"} {
		t.Run(goos, func(t *testing.T) {
			var calls atomic.Int32
			sampler := newHostTemperatureSampler(goos, func(ctx context.Context) ([]host.TemperatureStat, error) {
				calls.Add(1)
				return []host.TemperatureStat{{SensorKey: "coretemp", Temperature: 23}}, nil
			})
			value := sampler.sample(context.Background())
			if goos == "linux" {
				if calls.Load() != 1 || value == nil || *value != 23 {
					t.Fatal("identified Linux source was not read")
				}
			} else if calls.Load() != 0 || value != nil {
				t.Fatalf("unsupported platform queried the sensor driver: calls=%d", calls.Load())
			}
		})
	}
}

func TestReauditTemperatureCollectorWiring(t *testing.T) {
	previousSampler, previousTraffic := nodeTemperatureSampler, trafficTracker
	previousSource := nodeMetrics
	// This test exercises a supported physical host sensor regardless of
	// whether the CI process itself happens to run inside a container.
	nodeMetrics.root = t.TempDir()
	gpuDetailsMu.Lock()
	previousGPU := globalGPUDetails
	globalGPUDetails = nil
	gpuDetailsMu.Unlock()
	trafficTracker = nil
	t.Cleanup(func() {
		nodeTemperatureSampler, trafficTracker = previousSampler, previousTraffic
		nodeMetrics = previousSource
		gpuDetailsMu.Lock()
		globalGPUDetails = previousGPU
		gpuDetailsMu.Unlock()
	})
	for _, tc := range []struct {
		name    string
		present bool
		value   float64
	}{
		{"missing", false, 0},
		{"measured zero", true, 0},
		{"measured negative", true, -2.75},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			nodeTemperatureSampler = newHostTemperatureSampler("linux", func(ctx context.Context) ([]host.TemperatureStat, error) {
				calls.Add(1)
				if !tc.present {
					return nil, nil
				}
				return []host.TemperatureStat{{SensorKey: "cpu-thermal", Temperature: tc.value}}, nil
			})
			report := collectReportWithInterval(3)
			if calls.Load() != 1 || report.ReportInterval != 3 || report.Timestamp <= 0 {
				t.Fatal("normal report collection did not include exactly one sensor sample")
			}
			var want *float64
			if tc.present {
				want = &tc.value
			}
			assertReauditTemperatureJSON(t, report, want)
		})
	}
}

func TestReauditTemperatureSlowReadBudgetAndSingleFlight(t *testing.T) {
	started, release, readerReturned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	var calls atomic.Int32
	sampler := newHostTemperatureSampler("linux", func(ctx context.Context) ([]host.TemperatureStat, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-release // Model an OS read that does not observe ctx cancellation.
			close(readerReturned)
			return []host.TemperatureStat{{SensorKey: "coretemp", Temperature: 88}}, nil
		}
		return []host.TemperatureStat{{SensorKey: "coretemp", Temperature: 37}}, nil
	})
	firstResult := make(chan *float64, 1)
	start := time.Now()
	go func() { firstResult <- sampler.sample(context.Background()) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("sensor read did not start")
	}
	select {
	case value := <-firstResult:
		if value != nil {
			t.Fatal("unresponsive sensor reported a value")
		}
	case <-time.After(time.Second):
		t.Fatal("sensor read blocked the report beyond its budget")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("temperature timeout took %s, budget is %s", elapsed, hostTemperatureReadBudget)
	}

	var retries sync.WaitGroup
	for range 100 {
		retries.Go(func() {
			if value := sampler.sample(context.Background()); value != nil {
				t.Error("blocked reader produced a later sample")
			}
		})
	}
	retries.Wait()
	if count := calls.Load(); count != 1 {
		t.Fatalf("timed-out OS read accumulated %d sensor calls, want 1", count)
	}
	unblock()
	select {
	case <-readerReturned:
	case <-time.After(time.Second):
		t.Fatal("synthetic reader was not released")
	}
	deadline := time.Now().Add(time.Second)
	for {
		value := sampler.sample(context.Background())
		if value != nil {
			if *value != 37 || calls.Load() != 2 {
				t.Fatalf("late sample was reused or retries leaked: value=%v, calls=%d", *value, calls.Load())
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("sampler did not recover after the old OS read returned")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestReauditTemperatureCancelledReadKeepsGateUntilReturn(t *testing.T) {
	started, release, readerReturned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	var calls atomic.Int32
	sampler := newHostTemperatureSampler("linux", func(ctx context.Context) ([]host.TemperatureStat, error) {
		calls.Add(1)
		close(started)
		<-release
		close(readerReturned)
		return []host.TemperatureStat{{SensorKey: "coretemp", Temperature: 20}}, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan *float64, 1)
	go func() { result <- sampler.sample(ctx) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("sensor read did not start")
	}
	cancel()
	select {
	case value := <-result:
		if value != nil {
			t.Fatal("cancelled reading became a measurement")
		}
	case <-time.After(time.Second):
		t.Fatal("caller cancellation did not release reporting")
	}
	for range 10 {
		if value := sampler.sample(context.Background()); value != nil {
			t.Fatal("cancelled but unfinished read became a later measurement")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("cancelled OS read accumulated %d calls", calls.Load())
	}
	unblock()
	select {
	case <-readerReturned:
	case <-time.After(time.Second):
		t.Fatal("synthetic reader was not released")
	}
}

func TestReauditTemperatureAlreadyCancelledDoesNotRead(t *testing.T) {
	var calls atomic.Int32
	sampler := newHostTemperatureSampler("linux", func(ctx context.Context) ([]host.TemperatureStat, error) {
		calls.Add(1)
		return nil, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if sampler.sample(ctx) != nil || calls.Load() != 0 {
		t.Fatal("a previously cancelled sample still queried sensors")
	}
}
