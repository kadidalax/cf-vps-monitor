package main

import (
	"context"
	"math"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

const hostTemperatureReadBudget = 250 * time.Millisecond

type temperatureReader func(context.Context) ([]host.TemperatureStat, error)

type temperatureSampler struct {
	read temperatureReader

	mu       sync.Mutex
	inFlight bool
}

var nodeTemperatureSampler = newHostTemperatureSampler(runtime.GOOS, host.SensorsTemperaturesWithContext)

func newHostTemperatureSampler(goos string, read temperatureReader) *temperatureSampler {
	// The pinned library identifies Linux hwmon/thermal sources. Windows only
	// supplies generic ACPI zones, and its WMI timeout can leave a query running.
	// Current CGO=0 Darwin and FreeBSD builds have no sensor implementation.
	if goos != "linux" {
		read = nil
	}
	return &temperatureSampler{read: read}
}

func (s *temperatureSampler) sample(ctx context.Context) *float64 {
	if s.read == nil || ctx.Err() != nil {
		return nil
	}
	s.mu.Lock()
	if s.inFlight {
		s.mu.Unlock()
		return nil
	}
	s.inFlight = true
	s.mu.Unlock()

	readCtx, cancel := context.WithTimeout(ctx, hostTemperatureReadBudget)
	defer cancel()
	result := make(chan *float64, 1)
	go func() {
		sensors, err := s.read(readCtx)
		var value *float64
		if err == nil && readCtx.Err() == nil {
			value = measuredHostTemperature(sensors)
		}
		// Linux file reads may ignore cancellation. Keep the gate until the
		// actual read returns; timed-out samples are never reused as fresh data.
		s.mu.Lock()
		s.inFlight = false
		s.mu.Unlock()
		result <- value
	}()

	select {
	case <-readCtx.Done():
		return nil
	case value := <-result:
		if readCtx.Err() != nil {
			return nil
		}
		return value
	}
}

func measuredHostTemperature(sensors []host.TemperatureStat) *float64 {
	var hottest *float64
	for _, sensor := range sensors {
		if !isHostTemperatureSensor(sensor.SensorKey) {
			continue
		}
		value := sensor.Temperature
		if math.IsNaN(value) || math.IsInf(value, 0) || value < -100 || value > 150 {
			continue
		}
		if hottest == nil || value > *hottest {
			hottest = &value
		}
	}
	return hottest
}

func isHostTemperatureSensor(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	// gopsutil joins hwmon driver names and optional normalized labels. Match
	// known CPU drivers or explicit thermal-zone names, never a generic "core"
	// substring that could identify a GPU or an unrelated motherboard sensor.
	switch key {
	case "coretemp", "k8temp", "k10temp_tdie", "x86_pkg_temp",
		"cpu-thermal", "cpu_thermal", "soc-thermal", "soc_thermal", "bcm2835_thermal":
		return true
	}
	// AMD Tctl is a cooling-control value, not necessarily physical Celsius.
	// The driver's Tdie and numbered Tccd labels identify measured die values.
	for _, prefix := range []string{"coretemp_core_", "coretemp_package_id_", "k10temp_tccd"} {
		suffix, found := strings.CutPrefix(key, prefix)
		if !found || suffix == "" {
			continue
		}
		if strings.Trim(suffix, "0123456789") == "" {
			return true
		}
	}
	return false
}
