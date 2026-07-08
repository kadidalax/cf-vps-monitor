package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	gnet "github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

var Version = "dev"

const basicInfoRefreshInterval = 30 * time.Minute
const defaultPingIntervalSec = 120
const minReportInterval = 3 * time.Second
const maxHTTPErrorBodyBytes = 4096
const publicIPProbeTimeout = 3 * time.Second
const publicIPProbeBodyLimit = 4096
const maxReasonableCgroupLimit = uint64(1 << 60)

var defaultExcludedNetworkInterfacePrefixes = []string{
	"br",
	"cni",
	"docker",
	"flannel",
	"lo",
	"podman",
	"veth",
	"virbr",
	"vmbr",
	"tap",
	"fwbr",
	"fwpr",
}

var (
	token               string
	serverURL           string
	reportInterval      int
	clientName          string
	reportMode          string
	reconnectInterval   int
	pingInterval        int
	trafficResetDay     int
	mountInclude        string
	mountExclude        string
	nicInclude          string
	nicExclude          string
	trafficTracker      *trafficResetTracker
	publicIPv4ProbeURLs = []string{
		"https://api.ipify.org",
		"https://ipv4.icanhazip.com",
	}
	publicIPv6ProbeURLs = []string{
		"https://api6.ipify.org",
		"https://ipv6.icanhazip.com",
	}
	publicIPCache = struct {
		sync.Mutex
		ipv4      string
		ipv6      string
		expiresAt time.Time
	}{}
)

var blockedPingTargetCIDRs = mustParseCIDRs(
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"::/128",
	"::1/128",
	"100::/64",
	"2001:db8::/32",
	"fc00::/7",
	"fe80::/10",
	"ff00::/8",
)

type BasicInfo struct {
	CPUName        string `json:"cpu_name"`
	Virtualization string `json:"virtualization"`
	Arch           string `json:"arch"`
	CPUCores       int    `json:"cpu_cores"`
	OS             string `json:"os"`
	KernelVersion  string `json:"kernel_version"`
	GPUName        string `json:"gpu_name"`
	IPv4           string `json:"ipv4,omitempty"`
	IPv6           string `json:"ipv6,omitempty"`
	Region         string `json:"region,omitempty"`
	Version        string `json:"version"`
	Name           string `json:"name,omitempty"`
	MemTotal       int64  `json:"mem_total"`
	SwapTotal      int64  `json:"swap_total"`
	DiskTotal      int64  `json:"disk_total"`
	Uptime         int64  `json:"uptime"`
}

type Report struct {
	CPU                 float64              `json:"cpu"`
	GPU                 float64              `json:"gpu"`
	RAM                 int64                `json:"ram"`
	RAMTotal            int64                `json:"ram_total"`
	Swap                int64                `json:"swap"`
	SwapTotal           int64                `json:"swap_total"`
	Load                float64              `json:"load"`
	Temp                float64              `json:"temp"`
	Disk                int64                `json:"disk"`
	DiskTotal           int64                `json:"disk_total"`
	NetIn               int64                `json:"net_in"`
	NetOut              int64                `json:"net_out"`
	NetTotalUp          int64                `json:"net_total_up"`
	NetTotalDown        int64                `json:"net_total_down"`
	ProcessCount        int                  `json:"process_count"`
	Connections         int                  `json:"connections"`
	ConnectionsUdp      int                  `json:"connections_udp"`
	Uptime              int64                `json:"uptime"`
	Version             string               `json:"version"`
	Name                string               `json:"name,omitempty"`
	ReportInterval      int                  `json:"report_interval,omitempty"`
	Timestamp           int64                `json:"timestamp,omitempty"`
	IPv4                string               `json:"ipv4,omitempty"`
	IPv6                string               `json:"ipv6,omitempty"`
	GPUs                []GPUInfo            `json:"gpus,omitempty"`
	BasicInfo           *BasicInfo           `json:"basic_info,omitempty"`
	PingResults         []PingResult         `json:"ping_results,omitempty"`
	WebsiteProbeResults []WebsiteProbeResult `json:"website_probe_results,omitempty"`

	hasRawNetTotals bool
	rawNetTotalUp   int64
	rawNetTotalDown int64
}

type memorySnapshot struct {
	ramUsed   uint64
	ramTotal  uint64
	swapUsed  uint64
	swapTotal uint64
	hasRAM    bool
	hasSwap   bool
}

type GPUInfo struct {
	DeviceIndex int     `json:"device_index"`
	DeviceName  string  `json:"device_name"`
	MemTotal    int64   `json:"mem_total"`
	MemUsed     int64   `json:"mem_used"`
	Utilization float64 `json:"utilization"`
	Temperature int     `json:"temperature"`
}

type PingTask struct {
	ID          int      `json:"id"`
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Target      string   `json:"target"`
	IntervalSec int      `json:"interval_sec"`
	Clients     []string `json:"clients"`
	AllClients  jsonBool `json:"all_clients"`
}

type PingResult struct {
	TaskID int     `json:"task_id"`
	Value  float64 `json:"value"`
}

type WebsiteProbeTask struct {
	ID                int    `json:"id"`
	Name              string `json:"name"`
	URL               string `json:"url"`
	Method            string `json:"method"`
	ExpectedStatusMin int    `json:"expected_status_min"`
	ExpectedStatusMax int    `json:"expected_status_max"`
	TimeoutSec        int    `json:"timeout_sec"`
	IntervalSec       int    `json:"interval_sec"`
}

type WebsiteProbeResult struct {
	MonitorID       int     `json:"monitor_id"`
	OK              bool    `json:"ok"`
	EffectiveStatus string  `json:"effective_status"`
	EffectiveReason string  `json:"effective_reason"`
	StatusCode      *int    `json:"status_code"`
	RawStatusCode   *int    `json:"raw_status_code"`
	LatencyMS       int64   `json:"latency_ms"`
	Error           *string `json:"error"`
}

type jsonBool bool

func (b *jsonBool) UnmarshalJSON(data []byte) error {
	text := strings.Trim(strings.ToLower(string(data)), `"`)
	switch text {
	case "true", "1":
		*b = true
		return nil
	case "false", "0", "", "null":
		*b = false
		return nil
	default:
		parsed, err := strconv.ParseBool(text)
		if err != nil {
			return err
		}
		*b = jsonBool(parsed)
		return nil
	}
}

type pingTaskScheduler struct {
	lastRunByTaskID map[int]time.Time
}

type websiteProbeScheduler struct {
	lastRunByTaskID map[int]time.Time
}

func newPingTaskScheduler() *pingTaskScheduler {
	return &pingTaskScheduler{lastRunByTaskID: make(map[int]time.Time)}
}

func pingTaskInterval(task PingTask) time.Duration {
	interval := task.IntervalSec
	if interval < 1 {
		interval = pingInterval
	}
	if interval < 1 {
		interval = defaultPingIntervalSec
	}
	return time.Duration(interval) * time.Second
}

func websiteProbeInterval(task WebsiteProbeTask) time.Duration {
	interval := task.IntervalSec
	if interval < 1 {
		interval = defaultPingIntervalSec
	}
	return time.Duration(interval) * time.Second
}

func (s *pingTaskScheduler) dueTasks(tasks []PingTask, now time.Time) []PingTask {
	if s.lastRunByTaskID == nil {
		s.lastRunByTaskID = make(map[int]time.Time)
	}

	seen := make(map[int]struct{}, len(tasks))
	due := make([]PingTask, 0, len(tasks))
	for _, task := range tasks {
		if task.ID <= 0 {
			continue
		}
		seen[task.ID] = struct{}{}
		lastRun, ok := s.lastRunByTaskID[task.ID]
		if ok && now.Sub(lastRun) < pingTaskInterval(task) {
			continue
		}

		s.lastRunByTaskID[task.ID] = now
		due = append(due, task)
	}

	for taskID := range s.lastRunByTaskID {
		if _, ok := seen[taskID]; !ok {
			delete(s.lastRunByTaskID, taskID)
		}
	}

	return due
}

func (s *websiteProbeScheduler) dueTasks(tasks []WebsiteProbeTask, now time.Time) []WebsiteProbeTask {
	if s.lastRunByTaskID == nil {
		s.lastRunByTaskID = make(map[int]time.Time)
	}
	seen := make(map[int]struct{}, len(tasks))
	due := make([]WebsiteProbeTask, 0, len(tasks))
	for _, task := range tasks {
		if task.ID <= 0 {
			continue
		}
		seen[task.ID] = struct{}{}
		lastRun, ok := s.lastRunByTaskID[task.ID]
		if ok && now.Sub(lastRun) < websiteProbeInterval(task) {
			continue
		}
		s.lastRunByTaskID[task.ID] = now
		due = append(due, task)
	}
	for taskID := range s.lastRunByTaskID {
		if _, ok := seen[taskID]; !ok {
			delete(s.lastRunByTaskID, taskID)
		}
	}
	return due
}

type reportEnvelope struct {
	Type string `json:"type"`
	Data Report `json:"data"`
}

type reportsEnvelope struct {
	Type    string   `json:"type"`
	Reports []Report `json:"reports"`
}

type serverMessage struct {
	Type              string             `json:"type"`
	Timestamp         int64              `json:"timestamp,omitempty"`
	Mode              string             `json:"mode,omitempty"`
	SampleIntervalSec int                `json:"sample_interval_sec,omitempty"`
	ReportIntervalSec int                `json:"report_interval_sec,omitempty"`
	PingIntervalSec   int                `json:"ping_interval_sec,omitempty"`
	PingPolicyVersion string             `json:"ping_policy_version,omitempty"`
	PingTasks         []PingTask         `json:"ping_tasks,omitempty"`
	WebsiteProbeTasks []WebsiteProbeTask `json:"website_probe_tasks,omitempty"`
	ReportNow         bool               `json:"report_now,omitempty"`
	ViewerCount       int                `json:"viewer_count,omitempty"`
	ViewerTTLSec      int                `json:"viewer_ttl_sec,omitempty"`
	PolicyTTL         int                `json:"policy_ttl_sec,omitempty"`
	IdlePolicyTTL     int                `json:"idle_policy_ttl_sec,omitempty"`
}

type agentPolicy = serverMessage

type reportPreparer struct {
	lastNetUp          int64
	lastNetDown        int64
	lastNetCountersRaw bool
	lastTimestampMs    int64
	lastBasicInfoAt    time.Time
	ready              bool
}

type pingReportState struct {
	scheduler        *pingTaskScheduler
	websiteScheduler *websiteProbeScheduler
	tasks            []PingTask
	websiteTasks     []WebsiteProbeTask
	policyVersion    string
	intervalSec      int
}

type safeWebSocketConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func init() {
	flag.StringVar(&token, "token", "", "Agent token from the admin panel")
	flag.StringVar(&serverURL, "server", "", "Worker URL, for example https://cf-vps-monitor.example.workers.dev")
	flag.IntVar(&reportInterval, "interval", 120, "Report interval in seconds")
	flag.StringVar(&clientName, "name", "", "Optional node name override")
	flag.StringVar(&reportMode, "mode", "websocket", "Report mode: websocket or http")
	flag.IntVar(&reconnectInterval, "reconnect-interval", 5, "WebSocket reconnect interval in seconds")
	flag.IntVar(&pingInterval, "ping-interval", defaultPingIntervalSec, "Ping task poll interval in seconds")
	flag.IntVar(&trafficResetDay, "traffic-reset-day", 1, "Monthly traffic reset day for network totals, from 1 to 31")
	flag.StringVar(&mountInclude, "mount-include", "", "Comma-separated mountpoint/device patterns to include in disk totals, for example /,/data,/dev/sd*")
	flag.StringVar(&mountExclude, "mount-exclude", "", "Comma-separated mountpoint/device patterns to exclude from disk totals, for example /boot,tmpfs,/run")
	flag.StringVar(&nicInclude, "nic-include", "", "Comma-separated network interface patterns to include in traffic totals, for example eth*,ens*")
	flag.StringVar(&nicExclude, "nic-exclude", "", "Comma-separated network interface patterns to exclude from traffic totals, for example lo,docker*,veth*")
}

func main() {
	flag.Parse()
	applyEnvDefaults()

	if reportInterval < int(minReportInterval/time.Second) {
		reportInterval = int(minReportInterval / time.Second)
	}
	if reconnectInterval < 1 {
		reconnectInterval = 1
	}
	if pingInterval < 1 {
		pingInterval = defaultPingIntervalSec
	}
	trafficResetDay = normalizeTrafficResetDay(trafficResetDay)

	normalizedServer, err := normalizeServerURL(serverURL)
	if err != nil {
		log.Fatalf("invalid server URL: %v", err)
	}
	serverURL = normalizedServer
	reportMode = strings.ToLower(strings.TrimSpace(reportMode))

	if token == "" {
		log.Fatal("missing token: pass --token or set CF_MONITOR_TOKEN")
	}
	trafficTracker = newTrafficResetTracker(trafficResetDay, token, trafficCounterScope())

	log.Printf("CF VPS Monitor Agent %s", Version)
	log.Printf("server: %s", serverURL)
	log.Printf("interval: %ds", reportInterval)
	log.Printf("mode: %s", reportMode)
	log.Printf("ping interval: every %ds", pingInterval)
	log.Printf("traffic reset day: %d", trafficResetDay)
	logFilter("disk include", mountInclude)
	logFilter("disk exclude", mountExclude)
	logFilter("network include", nicInclude)
	logFilter("network exclude", nicExclude)

	switch reportMode {
	case "websocket", "ws":
		runWebSocketReporter()
	case "http":
		runHTTPReporter()
	default:
		log.Fatalf("unsupported mode %q, expected websocket or http", reportMode)
	}
}

func applyEnvDefaults() {
	if token == "" {
		token = os.Getenv("CF_MONITOR_TOKEN")
	}
	if serverURL == "" {
		serverURL = os.Getenv("CF_MONITOR_SERVER")
	}
	if clientName == "" {
		clientName = os.Getenv("CF_MONITOR_NAME")
	}
	if mode := os.Getenv("CF_MONITOR_MODE"); reportMode == "websocket" && mode != "" {
		reportMode = mode
	}
	if mountInclude == "" {
		mountInclude = os.Getenv("CF_MONITOR_MOUNT_INCLUDE")
	}
	if mountExclude == "" {
		mountExclude = os.Getenv("CF_MONITOR_MOUNT_EXCLUDE")
	}
	if nicInclude == "" {
		nicInclude = os.Getenv("CF_MONITOR_NIC_INCLUDE")
	}
	if nicExclude == "" {
		nicExclude = os.Getenv("CF_MONITOR_NIC_EXCLUDE")
	}
	if !flagWasSet("traffic-reset-day") {
		if value := strings.TrimSpace(os.Getenv("CF_MONITOR_TRAFFIC_RESET_DAY")); value != "" {
			if parsed, err := strconv.Atoi(value); err == nil {
				trafficResetDay = parsed
			}
		}
	}
}

func flagWasSet(name string) bool {
	found := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
}

func logFilter(label string, value string) {
	value = strings.TrimSpace(value)
	if value != "" {
		log.Printf("%s: %s", label, value)
	}
}

// ==================== GPU Detection ====================

func detectGPU() (string, []GPUInfo) {
	var names []string
	var details []GPUInfo

	// Try NVIDIA
	if nvidiaNames, nvidiaDetails := detectNvidiaGPU(); len(nvidiaDetails) > 0 {
		names = append(names, nvidiaNames...)
		details = append(details, nvidiaDetails...)
	}

	// Try AMD
	if amdNames, amdDetails := detectAMDGPU(); len(amdDetails) > 0 {
		names = append(names, amdNames...)
		details = append(details, amdDetails...)
	}

	return strings.Join(names, "; "), details
}

func parseNvidiaGPUOutput(output string) ([]string, []GPUInfo) {
	var names []string
	var details []GPUInfo

	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		parts := strings.SplitN(line, ",", 6)
		if len(parts) < 6 {
			continue
		}
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}

		index, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		name := parts[1]
		memTotal, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			continue
		}
		memUsed, err := strconv.ParseInt(parts[3], 10, 64)
		if err != nil {
			continue
		}
		util, err := strconv.ParseFloat(parts[4], 64)
		if err != nil {
			continue
		}
		temp, err := strconv.Atoi(parts[5])
		if err != nil {
			continue
		}

		names = append(names, name)
		details = append(details, GPUInfo{
			DeviceIndex: index,
			DeviceName:  name,
			MemTotal:    memTotal * 1024 * 1024, // MiB to bytes
			MemUsed:     memUsed * 1024 * 1024,
			Utilization: util,
			Temperature: temp,
		})
	}

	return names, details
}

func detectNvidiaGPU() ([]string, []GPUInfo) {
	nvidiaSmi, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return nil, nil
	}

	cmd := exec.Command(nvidiaSmi,
		"--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
		"--format=csv,noheader,nounits",
	)
	output, err := cmd.Output()
	if err != nil {
		log.Printf("nvidia-smi query failed: %v", err)
		return nil, nil
	}

	names, details := parseNvidiaGPUOutput(string(output))
	for _, detail := range details {
		log.Printf("GPU[%d] %s: util=%.1f%% mem=%d/%dMiB temp=%dC",
			detail.DeviceIndex,
			detail.DeviceName,
			detail.Utilization,
			detail.MemUsed/1024/1024,
			detail.MemTotal/1024/1024,
			detail.Temperature,
		)
	}

	return names, details
}

func parseNumberPrefix(value string) (float64, error) {
	fields := strings.Fields(strings.TrimSpace(value))
	if len(fields) == 0 {
		return 0, fmt.Errorf("empty number")
	}
	return strconv.ParseFloat(strings.TrimSuffix(fields[0], "%"), 64)
}

func parseIntPrefix(value string) (int64, error) {
	parsed, err := parseNumberPrefix(value)
	if err != nil {
		return 0, err
	}
	return int64(parsed), nil
}

func parseAMDGPUOutput(output string) ([]string, []GPUInfo) {
	gpus := map[int]*GPUInfo{}
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "GPU[") {
			continue
		}
		closeIdx := strings.Index(line, "]")
		colonIdx := strings.Index(line, ":")
		if closeIdx < 4 || colonIdx < 0 || colonIdx <= closeIdx {
			continue
		}
		index, err := strconv.Atoi(strings.TrimSpace(line[4:closeIdx]))
		if err != nil {
			continue
		}
		gpu := gpus[index]
		if gpu == nil {
			gpu = &GPUInfo{DeviceIndex: index, DeviceName: "AMD GPU"}
			gpus[index] = gpu
		}
		field := strings.TrimSpace(line[colonIdx+1:])
		fieldName, fieldValue, ok := strings.Cut(field, ":")
		if !ok {
			continue
		}
		fieldName = strings.TrimSpace(fieldName)
		fieldValue = strings.TrimSpace(fieldValue)
		switch {
		case strings.EqualFold(fieldName, "Card series"):
			if fieldValue != "" {
				gpu.DeviceName = fieldValue
			}
		case strings.EqualFold(fieldName, "GPU use (%)"):
			if value, err := parseNumberPrefix(fieldValue); err == nil {
				gpu.Utilization = value
			}
		case strings.EqualFold(fieldName, "VRAM Total Used Memory (B)"):
			if value, err := parseIntPrefix(fieldValue); err == nil {
				gpu.MemUsed = value
			}
		case strings.EqualFold(fieldName, "VRAM Total Memory (B)"):
			if value, err := parseIntPrefix(fieldValue); err == nil {
				gpu.MemTotal = value
			}
		case strings.HasPrefix(fieldName, "Temperature") && strings.Contains(fieldName, "(C)"):
			if value, err := parseNumberPrefix(fieldValue); err == nil {
				gpu.Temperature = int(value)
			}
		}
	}

	if len(gpus) == 0 {
		return []string{"AMD GPU"}, []GPUInfo{{DeviceIndex: 0, DeviceName: "AMD GPU"}}
	}

	indexes := make([]int, 0, len(gpus))
	for index := range gpus {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)

	names := make([]string, 0, len(indexes))
	details := make([]GPUInfo, 0, len(indexes))
	for _, index := range indexes {
		detail := *gpus[index]
		names = append(names, detail.DeviceName)
		details = append(details, detail)
	}
	return names, details
}

func detectAMDGPU() ([]string, []GPUInfo) {
	rocmSmi, err := exec.LookPath("rocm-smi")
	if err != nil {
		return nil, nil
	}

	cmd := exec.Command(rocmSmi, "--showproductname", "--showmeminfo", "vram", "--showuse", "--showtemp")
	output, err := cmd.Output()
	if err != nil {
		log.Printf("rocm-smi query failed: %v", err)
		return nil, nil
	}

	return parseAMDGPUOutput(string(output))
}

// ==================== Ping Execution ====================

func newPingReportState() *pingReportState {
	return &pingReportState{
		scheduler:        newPingTaskScheduler(),
		websiteScheduler: &websiteProbeScheduler{lastRunByTaskID: make(map[int]time.Time)},
		intervalSec:      defaultPingIntervalSec,
	}
}

func (s *pingReportState) applyPolicy(policy agentPolicy) {
	if s == nil {
		return
	}
	if policy.PingIntervalSec > 0 {
		s.intervalSec = policy.PingIntervalSec
	}
	if s.intervalSec < 1 {
		s.intervalSec = defaultPingIntervalSec
	}
	tasks := make([]PingTask, 0, len(policy.PingTasks))
	for _, task := range policy.PingTasks {
		if task.IntervalSec < 1 {
			task.IntervalSec = s.intervalSec
		}
		tasks = append(tasks, task)
	}
	s.tasks = tasks
	websiteTasks := make([]WebsiteProbeTask, 0, len(policy.WebsiteProbeTasks))
	for _, task := range policy.WebsiteProbeTasks {
		if task.IntervalSec < 1 {
			task.IntervalSec = s.intervalSec
		}
		websiteTasks = append(websiteTasks, task)
	}
	s.websiteTasks = websiteTasks
	s.policyVersion = policy.PingPolicyVersion
	if len(tasks) > 0 || len(websiteTasks) > 0 {
		log.Printf("policy updated: %d ping task(s), %d website probe(s), interval=%ds, version=%s", len(tasks), len(websiteTasks), s.intervalSec, s.policyVersion)
	}
}

func (s *pingReportState) appendDueResults(report *Report, now time.Time) {
	if s == nil || report == nil {
		return
	}
	if len(s.tasks) > 0 {
		dueTasks := s.scheduler.dueTasks(s.tasks, now)
		if len(dueTasks) > 0 {
			results := runPingTasks(dueTasks)
			if len(results) > 0 {
				report.PingResults = append(report.PingResults, results...)
			}
		}
	}
	if len(s.websiteTasks) == 0 {
		return
	}
	dueWebsiteTasks := s.websiteScheduler.dueTasks(s.websiteTasks, now)
	if len(dueWebsiteTasks) == 0 {
		return
	}
	websiteResults := runWebsiteProbeTasks(dueWebsiteTasks)
	if len(websiteResults) > 0 {
		report.WebsiteProbeResults = append(report.WebsiteProbeResults, websiteResults...)
	}
}

func runPingTasks(tasks []PingTask) []PingResult {
	log.Printf("executing %d ping task(s)", len(tasks))
	results := make([]PingResult, 0, len(tasks))
	for _, task := range tasks {
		var value float64
		switch strings.ToLower(task.Type) {
		case "icmp":
			value = executeICMPPing(task.Target)
		case "tcp":
			value = executeTCPPing(task.Target)
		case "http", "https":
			value = executeHTTPPing(task.Target)
		default:
			value = executeTCPPing(task.Target)
		}
		results = append(results, PingResult{
			TaskID: task.ID,
			Value:  value,
		})
	}
	return results
}

func runWebsiteProbeTasks(tasks []WebsiteProbeTask) []WebsiteProbeResult {
	log.Printf("executing %d website probe task(s)", len(tasks))
	results := make([]WebsiteProbeResult, 0, len(tasks))
	for _, task := range tasks {
		if strings.EqualFold(task.Method, "TCP") {
			results = append(results, executeWebsiteTCPProbe(task))
		} else {
			results = append(results, executeWebsiteHTTPProbe(task))
		}
	}
	return results
}

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	networks := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			panic(err)
		}
		networks = append(networks, network)
	}
	return networks
}

func isBlockedTargetHost(host string) bool {
	normalized := strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]"))
	return normalized == "" ||
		normalized == "localhost" ||
		strings.HasSuffix(normalized, ".localhost") ||
		normalized == "metadata.google.internal"
}

func isBlockedTargetIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		ip = ip4
	}
	for _, network := range blockedPingTargetCIDRs {
		if network.Contains(ip) {
			return true
		}
	}
	return ip.IsUnspecified() ||
		ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsMulticast()
}

func resolvePublicIPs(ctx context.Context, host string) ([]net.IP, error) {
	host = strings.Trim(strings.TrimSpace(host), "[]")
	if isBlockedTargetHost(host) {
		return nil, fmt.Errorf("blocked ping target host %q", host)
	}
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedTargetIP(ip) {
			return nil, fmt.Errorf("blocked ping target IP %s", ip.String())
		}
		return []net.IP{ip}, nil
	}

	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		if isBlockedTargetIP(addr.IP) {
			return nil, fmt.Errorf("blocked ping target resolved IP %s", addr.IP.String())
		}
		ips = append(ips, addr.IP)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no IP addresses for %q", host)
	}
	return ips, nil
}

var resolvePublicIPsForPing = resolvePublicIPs

func normalizeTCPTargetAddress(target string) (string, string, string, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return "", "", "", fmt.Errorf("empty TCP ping target")
	}
	host, port, err := net.SplitHostPort(target)
	if err == nil {
		return net.JoinHostPort(host, port), strings.Trim(host, "[]"), port, nil
	}
	trimmed := strings.Trim(target, "[]")
	if ip := net.ParseIP(trimmed); ip != nil {
		return net.JoinHostPort(trimmed, "80"), trimmed, "80", nil
	}
	if !strings.Contains(target, ":") {
		host, port = target, "80"
		return net.JoinHostPort(host, port), host, port, nil
	}
	return "", "", "", err
}

func dialPublicTCP(ctx context.Context, network, host, port string, timeout time.Duration) (net.Conn, error) {
	ips, err := resolvePublicIPsForPing(ctx, host)
	if err != nil {
		return nil, err
	}
	return dialResolvedTCP(ctx, network, ips, port, timeout)
}

func dialResolvedTCP(ctx context.Context, network string, ips []net.IP, port string, timeout time.Duration) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: timeout}
	var lastErr error
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("no dialable IP addresses")
}

func executeICMPPing(target string) float64 {
	ips, err := resolvePublicIPs(context.Background(), target)
	if err != nil {
		log.Printf("blocked ICMP ping target %q: %v", target, err)
		return -1
	}
	pingTarget := ips[0].String()

	start := time.Now()

	// Use system ping command for cross-platform ICMP
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "1", "-w", "2000", pingTarget)
	} else {
		cmd = exec.Command("ping", "-c", "1", "-W", "2", pingTarget)
	}

	output, err := cmd.CombinedOutput()
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		detail := strings.TrimSpace(string(output))
		if detail != "" {
			log.Printf("ICMP ping failed for %q (%s): %v: %s", target, pingTarget, err, detail)
		} else {
			log.Printf("ICMP ping failed for %q (%s): %v", target, pingTarget, err)
		}
		return -1
	}
	return float64(elapsed)
}

func executeTCPPing(target string) float64 {
	address, host, port, err := normalizeTCPTargetAddress(target)
	if err != nil {
		return -1
	}
	ctx := context.Background()
	ips, err := resolvePublicIPsForPing(ctx, host)
	if err != nil {
		log.Printf("TCP ping failed for %q: %v", address, err)
		return -1
	}

	start := time.Now()
	conn, err := dialResolvedTCP(ctx, "tcp", ips, port, 3*time.Second)
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		log.Printf("TCP ping failed for %q: %v", address, err)
		return -1
	}
	conn.Close()
	return float64(elapsed)
}

func executeHTTPPing(target string) float64 {
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		target = "https://" + target
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Hostname() == "" {
		return -1
	}

	start := time.Now()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		return dialPublicTCP(ctx, network, host, port, 5*time.Second)
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 5 * time.Second, Transport: transport}
	resp, err := client.Get(parsed.String())
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		return -1
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return -1
	}
	return float64(elapsed)
}

func intPtr(value int) *int {
	return &value
}

func stringPtr(value string) *string {
	return &value
}

func normalizeWebsiteProbeHTTPResult(task WebsiteProbeTask, status int, latency int64) WebsiteProbeResult {
	minStatus := task.ExpectedStatusMin
	if minStatus < 100 {
		minStatus = 200
	}
	maxStatus := task.ExpectedStatusMax
	if maxStatus < minStatus || maxStatus > 599 {
		maxStatus = 399
	}
	inRange := status >= minStatus && status <= maxStatus
	challengeReachable := minStatus == 200 && maxStatus == 399 && (status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusMethodNotAllowed || status == http.StatusPreconditionFailed || status == http.StatusTooManyRequests)
	ok := inRange || challengeReachable
	reason := "http_status_mismatch"
	if inRange {
		reason = "status_in_expected_range"
	} else if challengeReachable {
		reason = "reachable_challenge"
	}
	result := WebsiteProbeResult{
		MonitorID:       task.ID,
		OK:              ok,
		EffectiveStatus: "down",
		EffectiveReason: reason,
		StatusCode:      intPtr(status),
		RawStatusCode:   intPtr(status),
		LatencyMS:       latency,
	}
	if ok {
		result.EffectiveStatus = "up"
		return result
	}
	result.Error = stringPtr(fmt.Sprintf("http_%d", status))
	return result
}

func websiteProbeError(task WebsiteProbeTask, latency int64, reason string) WebsiteProbeResult {
	return WebsiteProbeResult{
		MonitorID:       task.ID,
		OK:              false,
		EffectiveStatus: "down",
		EffectiveReason: reason,
		LatencyMS:       latency,
		Error:           stringPtr(reason),
	}
}

func executeWebsiteHTTPProbe(task WebsiteProbeTask) WebsiteProbeResult {
	timeout := time.Duration(task.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	client := &http.Client{Timeout: timeout, Transport: publicHTTPTransport(timeout)}
	defer client.CloseIdleConnections()
	return executeWebsiteHTTPProbeWithClient(task, client)
}

func executeWebsiteHTTPProbeWithClient(task WebsiteProbeTask, client *http.Client) WebsiteProbeResult {
	target := task.URL
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		target = "https://" + target
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return websiteProbeError(task, 0, "invalid_url")
	}
	method := strings.ToUpper(task.Method)
	if method != http.MethodHead {
		method = http.MethodGet
	}
	start := time.Now()
	req, err := http.NewRequest(method, parsed.String(), nil)
	if err != nil {
		return websiteProbeError(task, 0, "invalid_url")
	}
	req.Header.Set("User-Agent", "cf-vps-monitor-agent/"+Version)
	resp, err := client.Do(req)
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		reason := "network_error"
		if errors.Is(err, context.DeadlineExceeded) || strings.Contains(strings.ToLower(err.Error()), "timeout") {
			reason = "timeout"
		}
		return websiteProbeError(task, elapsed, reason)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 512))
	return normalizeWebsiteProbeHTTPResult(task, resp.StatusCode, elapsed)
}

func publicHTTPTransport(timeout time.Duration) *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		return dialPublicTCP(ctx, network, host, port, timeout)
	}
	return transport
}

func executeWebsiteTCPProbe(task WebsiteProbeTask) WebsiteProbeResult {
	target := task.URL
	if strings.HasPrefix(strings.ToLower(target), "tcp://") {
		parsed, err := url.Parse(target)
		if err != nil || parsed.Hostname() == "" || parsed.Port() == "" {
			return websiteProbeError(task, 0, "invalid_url")
		}
		target = net.JoinHostPort(parsed.Hostname(), parsed.Port())
	}
	start := time.Now()
	value := executeTCPPing(target)
	elapsed := time.Since(start).Milliseconds()
	if value < 0 {
		return websiteProbeError(task, elapsed, "network_error")
	}
	return WebsiteProbeResult{
		MonitorID:       task.ID,
		OK:              true,
		EffectiveStatus: "up",
		EffectiveReason: "tcp_connect",
		LatencyMS:       int64(value),
	}
}

// ==================== Original Functions (Enhanced) ====================

func runHTTPReporter() {
	log.Println("HTTP reporter started")
	preparer := &reportPreparer{}
	pingState := newPingReportState()
	currentSampleInterval := normalizeReportDuration(time.Duration(reportInterval) * time.Second)
	currentUploadInterval := currentSampleInterval
	nextUploadAt := time.Now()
	var pending []Report

	// Policy caching — only refetch when TTL expires.
	// On first cycle policyExpiresAt is zero so we fetch immediately.
	var policy agentPolicy
	var policyExpiresAt time.Time

	for {
		if time.Now().After(policyExpiresAt) {
			if newPolicy, err := fetchAgentPolicy(); err == nil {
				policy = newPolicy
				// Pick TTL: use service-provided value, otherwise default idle=120s active=30s.
				ttl := policy.IdlePolicyTTL
				if ttl < 1 {
					ttl = 120
				}
				if policy.Mode == "active" {
					ttl = policy.PolicyTTL
					if ttl < 1 {
						ttl = 30
					}
				}
				policyExpiresAt = time.Now().Add(time.Duration(ttl) * time.Second)
				pingState.applyPolicy(policy)
				nextSampleInterval, nextUploadInterval := policyDurations(policy, currentSampleInterval)
				if nextSampleInterval != currentSampleInterval || nextUploadInterval != currentUploadInterval {
					currentSampleInterval = nextSampleInterval
					currentUploadInterval = nextUploadInterval
					reportInterval = int(currentSampleInterval / time.Second)
					nextUploadAt = time.Now().Add(currentUploadInterval)
					log.Printf("HTTP policy: mode=%s sample=%s upload=%s viewers=%d ttl=%ds cache=%ds",
						policy.Mode,
						currentSampleInterval,
						currentUploadInterval,
						policy.ViewerCount,
						policy.ViewerTTLSec,
						ttl,
					)
				}
				if policy.ReportNow {
					pending = append(pending, prepareReportWithPing(preparer, pingState, currentSampleInterval))
					sendHTTPReports(pending)
					pending = nil
					nextUploadAt = time.Now().Add(currentUploadInterval)
				}
			} else {
				log.Printf("HTTP policy fetch failed: %v", err)
				// Keep current policy but force a short retry.
				if policyExpiresAt.IsZero() {
					policyExpiresAt = time.Now().Add(30 * time.Second)
				} else {
					policyExpiresAt = time.Now().Add(60 * time.Second)
				}
			}
		}

		pending = append(pending, prepareReportWithPing(preparer, pingState, currentSampleInterval))
		if currentUploadInterval <= currentSampleInterval || !time.Now().Before(nextUploadAt) {
			sendHTTPReports(pending)
			pending = nil
			nextUploadAt = time.Now().Add(currentUploadInterval)
		}
		time.Sleep(currentSampleInterval)
	}
}

func runWebSocketReporter() {
	endpoint, err := webSocketEndpoint(serverURL, token)
	if err != nil {
		log.Fatalf("invalid WebSocket endpoint: %v", err)
	}

	log.Printf("WebSocket reporter started: %s", endpoint)
	preparer := &reportPreparer{}
	pingState := newPingReportState()

	for {
		conn, err := connectWebSocket(endpoint, token)
		if err != nil {
			delay := webSocketReconnectDelay(err)
			log.Printf("WebSocket connect failed: %v; reconnecting in %s", err, delay)
			time.Sleep(delay)
			continue
		}

		log.Println("WebSocket connected")
		_ = runWebSocketSession(
			conn,
			preparer,
			pingState,
			time.Duration(reportInterval)*time.Second,
			30*time.Second,
		)
		log.Printf("reconnecting in %ds", reconnectInterval)
		time.Sleep(time.Duration(reconnectInterval) * time.Second)
	}
}

func webSocketReconnectDelay(err error) time.Duration {
	if err != nil && (strings.HasPrefix(err.Error(), "401 ") || strings.HasPrefix(err.Error(), "403 ")) {
		return 10 * time.Minute
	}
	return time.Duration(reconnectInterval) * time.Second
}

func runWebSocketSession(
	conn *safeWebSocketConn,
	preparer *reportPreparer,
	pingState *pingReportState,
	dataInterval time.Duration,
	heartbeatInterval time.Duration,
) error {
	defer conn.Close()

	done := make(chan error, 1)
	policies := make(chan serverMessage, 8)
	go readWebSocketMessages(conn, done, policies)

	currentInterval := normalizeReportDuration(dataInterval)
	currentUploadInterval := currentInterval
	var pending []Report

	pending = append(pending, prepareReportWithPing(preparer, pingState, currentInterval))
	if err := sendWebSocketReports(conn, pending); err != nil {
		log.Printf("WebSocket initial report failed: %v", err)
		return err
	}
	pending = nil

	sampleTimer := time.NewTimer(currentInterval)
	defer sampleTimer.Stop()
	uploadTimer := time.NewTimer(currentUploadInterval)
	defer uploadTimer.Stop()
	heartbeatTicker := time.NewTicker(heartbeatInterval)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-sampleTimer.C:
			pending = append(pending, prepareReportWithPing(preparer, pingState, currentInterval))
			if currentUploadInterval <= currentInterval {
				if err := sendWebSocketReports(conn, pending); err != nil {
					log.Printf("WebSocket report failed: %v", err)
					return err
				}
				pending = nil
				resetTimer(uploadTimer, currentUploadInterval)
			}
			resetTimer(sampleTimer, currentInterval)
		case <-uploadTimer.C:
			if len(pending) > 0 {
				if err := sendWebSocketReports(conn, pending); err != nil {
					log.Printf("WebSocket report batch failed: %v", err)
					return err
				}
				pending = nil
			}
			resetTimer(uploadTimer, currentUploadInterval)
		case policy := <-policies:
			if policy.Type != "policy" {
				continue
			}
			pingState.applyPolicy(policy)
			nextInterval, nextUploadInterval := policyDurations(policy, currentInterval)
			if nextInterval != currentInterval || nextUploadInterval != currentUploadInterval {
				currentInterval = nextInterval
				currentUploadInterval = nextUploadInterval
				reportInterval = int(currentInterval / time.Second)
				log.Printf("WebSocket policy: mode=%s sample=%s upload=%s viewers=%d ttl=%ds",
					policy.Mode,
					currentInterval,
					currentUploadInterval,
					policy.ViewerCount,
					policy.ViewerTTLSec,
				)
			}
			if policy.ReportNow {
				pending = append(pending, prepareReportWithPing(preparer, pingState, currentInterval))
				if err := sendWebSocketReports(conn, pending); err != nil {
					log.Printf("WebSocket immediate report failed: %v", err)
					return err
				}
				pending = nil
			}
			resetTimer(sampleTimer, currentInterval)
			resetTimer(uploadTimer, currentUploadInterval)
		case <-heartbeatTicker.C:
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("WebSocket heartbeat failed: %v", err)
				return err
			}
		case err := <-done:
			if err != nil {
				log.Printf("WebSocket read stopped: %v", err)
				return err
			}
			return nil
		}
	}
}

func policyDurations(policy agentPolicy, fallback time.Duration) (time.Duration, time.Duration) {
	reportSec := policy.ReportIntervalSec
	if reportSec < 1 {
		reportSec = intervalSeconds(fallback)
	}
	sampleSec := policy.SampleIntervalSec
	if sampleSec < 1 {
		sampleSec = reportSec
	}
	return normalizeReportDuration(time.Duration(sampleSec) * time.Second),
		normalizeReportDuration(time.Duration(reportSec) * time.Second)
}

func normalizeReportDuration(interval time.Duration) time.Duration {
	if interval < minReportInterval {
		return minReportInterval
	}
	return interval
}

func intervalSeconds(interval time.Duration) int {
	return int(normalizeReportDuration(interval) / time.Second)
}

func resetTimer(timer *time.Timer, interval time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(normalizeReportDuration(interval))
}

func outboundIP(network, address string) string {
	conn, err := net.DialTimeout(network, address, time.Second)
	if err != nil {
		return ""
	}
	defer conn.Close()

	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && addr.IP != nil {
		return addr.IP.String()
	}
	return ""
}

func fallbackInterfaceIPs() (string, string) {
	var ipv4, ipv6 string
	interfaces, err := net.Interfaces()
	if err != nil {
		return "", ""
	}

	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch value := addr.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip4 := ip.To4(); ip4 != nil {
				if ipv4 == "" {
					ipv4 = ip4.String()
				}
				continue
			}
			if ip.To16() != nil && ipv6 == "" {
				ipv6 = ip.String()
			}
		}
	}

	return ipv4, ipv6
}

func publicIPHTTPClient(network string) *http.Client {
	dialer := &net.Dialer{Timeout: publicIPProbeTimeout}
	return &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: func(ctx context.Context, _ string, addr string) (net.Conn, error) {
				return dialer.DialContext(ctx, network, addr)
			},
			TLSHandshakeTimeout: publicIPProbeTimeout,
		},
		Timeout: publicIPProbeTimeout,
	}
}

func extractPublicIP(body string, wantIPv6 bool) string {
	fields := strings.FieldsFunc(body, func(r rune) bool {
		return !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') || r == '.' || r == ':')
	})
	for _, field := range fields {
		ip := net.ParseIP(strings.Trim(field, "[]"))
		if ip == nil || isBlockedTargetIP(ip) {
			continue
		}
		if (ip.To4() == nil) == wantIPv6 {
			return ip.String()
		}
	}
	return ""
}

func fetchPublicIPFromURLs(ctx context.Context, client *http.Client, urls []string, wantIPv6 bool) string {
	for _, rawURL := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "cf-vps-monitor-agent/"+Version)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, publicIPProbeBodyLimit))
		_ = resp.Body.Close()
		if readErr != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			continue
		}
		if ip := extractPublicIP(string(body), wantIPv6); ip != "" {
			return ip
		}
	}
	return ""
}

func publicIPAddresses() (string, string) {
	ctx, cancel := context.WithTimeout(context.Background(), publicIPProbeTimeout)
	defer cancel()

	var ipv4, ipv6 string
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		ipv4 = fetchPublicIPFromURLs(ctx, publicIPHTTPClient("tcp4"), publicIPv4ProbeURLs, false)
	}()
	go func() {
		defer wg.Done()
		ipv6 = fetchPublicIPFromURLs(ctx, publicIPHTTPClient("tcp6"), publicIPv6ProbeURLs, true)
	}()
	wg.Wait()
	return ipv4, ipv6
}

func cachedPublicIPAddresses() (string, string) {
	now := time.Now()
	publicIPCache.Lock()
	if now.Before(publicIPCache.expiresAt) {
		ipv4, ipv6 := publicIPCache.ipv4, publicIPCache.ipv6
		publicIPCache.Unlock()
		return ipv4, ipv6
	}
	publicIPCache.Unlock()

	ipv4, ipv6 := publicIPAddresses()
	ttl := basicInfoRefreshInterval
	if ipv4 == "" && ipv6 == "" {
		ttl = 5 * time.Minute
	}
	publicIPCache.Lock()
	publicIPCache.ipv4 = ipv4
	publicIPCache.ipv6 = ipv6
	publicIPCache.expiresAt = time.Now().Add(ttl)
	publicIPCache.Unlock()
	return ipv4, ipv6
}

func localIPAddresses() (string, string) {
	ipv4, ipv6 := cachedPublicIPAddresses()
	if ipv4 != "" && ipv6 != "" {
		return ipv4, ipv6
	}

	if ipv4 == "" {
		ipv4 = outboundIP("udp4", "1.1.1.1:80")
	}
	if ipv6 == "" {
		ipv6 = outboundIP("udp6", "[2606:4700:4700::1111]:80")
	}
	if ipv4 != "" && ipv6 != "" {
		return ipv4, ipv6
	}

	fallbackIPv4, fallbackIPv6 := fallbackInterfaceIPs()
	if ipv4 == "" {
		ipv4 = fallbackIPv4
	}
	if ipv6 == "" {
		ipv6 = fallbackIPv6
	}
	return ipv4, ipv6
}

func getBasicInfo() BasicInfo {
	info := BasicInfo{
		Arch:    runtime.GOARCH,
		OS:      runtime.GOOS,
		Version: Version,
	}
	if clientName != "" {
		info.Name = clientName
	}
	info.IPv4, info.IPv6 = localIPAddresses()

	if hostInfo, err := host.Info(); err == nil {
		info.KernelVersion = hostInfo.KernelVersion
		info.OS = strings.TrimSpace(hostInfo.Platform + " " + hostInfo.PlatformVersion)
		if runtime.GOOS == "linux" {
			info.OS = linuxOSName("/etc/os-release")
		}
		info.Virtualization = detectVirtualization(hostInfo.VirtualizationSystem)
		info.Uptime = int64(hostInfo.Uptime)
	}
	if cpuName, cpuCores := readCPUBasicInfo(); cpuName != "" || cpuCores > 0 {
		info.CPUName = cpuName
		info.CPUCores = cpuCores
	}
	if memory := readMemorySnapshot(); memory.hasRAM {
		info.MemTotal = int64(memory.ramTotal)
		if memory.hasSwap {
			info.SwapTotal = int64(memory.swapTotal)
		}
	}
	_, info.DiskTotal = diskUsageTotals()

	// GPU detection
	gpuName, gpuDetails := detectGPU()
	info.GPUName = gpuName

	// Store detailed GPU info globally for reports
	gpuDetailsMu.Lock()
	globalGPUDetails = gpuDetails
	gpuDetailsMu.Unlock()

	return info
}

func linuxOSName(osReleasePath string) string {
	data, err := os.ReadFile(osReleasePath)
	if err != nil {
		return "Linux"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
		}
	}
	return "Linux"
}

func detectVirtualization(current string) string {
	if runtime.GOOS != "linux" {
		return current
	}
	if out, err := exec.Command("systemd-detect-virt").Output(); err == nil {
		if virt := strings.TrimSpace(string(out)); virt != "" {
			return virt
		}
	}
	if data, err := os.ReadFile("/proc/self/cgroup"); err == nil {
		if container := detectContainerFromCgroup(string(data)); container != "" {
			return container
		}
	}
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "docker"
	}
	if _, err := os.Stat("/run/.containerenv"); err == nil {
		return "container"
	}
	if _, err := os.Stat("/dev/.lxc-boot-id"); err == nil {
		return "lxc"
	}
	if current != "" {
		return current
	}
	return "none"
}

func detectContainerFromCgroup(data string) string {
	lower := strings.ToLower(data)
	switch {
	case strings.Contains(lower, "/lxc/"):
		return "lxc"
	case strings.Contains(lower, "/docker/") || strings.Contains(lower, "/docker-") || strings.Contains(lower, "/cri-containerd/"):
		return "docker"
	case strings.Contains(lower, "/libpod") || strings.Contains(lower, "/podman"):
		return "podman"
	case strings.Contains(lower, "/kubepods"):
		return "kubernetes"
	case strings.Contains(lower, "/crio-"):
		return "container"
	default:
		return ""
	}
}

func readCPUBasicInfo() (string, int) {
	cpuName := "Unknown"
	if cpuInfo, err := cpu.Info(); err == nil && len(cpuInfo) > 0 {
		cpuName = strings.TrimSpace(cpuInfo[0].ModelName)
		if cpuName == "" {
			cpuName = strings.TrimSpace(cpuInfo[0].VendorID + " " + cpuInfo[0].Family)
		}
	}
	if cpuName == "" || cpuName == "Unknown" {
		if name, err := readCPUNameFromProc("/proc/cpuinfo"); err == nil && name != "" {
			cpuName = name
		}
	}
	cores := 1
	if count, err := cpu.Counts(true); err == nil && count > 0 {
		cores = count
	}
	return cpuName, cores
}

func readCPUNameFromProc(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "Model\t") || strings.HasPrefix(line, "Hardware\t") ||
			strings.HasPrefix(line, "Processor\t") || strings.HasPrefix(line, "model name") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1]), nil
			}
		}
	}
	return "", nil
}

func readMemorySnapshot() memorySnapshot {
	snapshot := memorySnapshot{}
	if runtime.GOOS == "linux" {
		procMem, _ := readProcMeminfo("/proc/meminfo")
		cgroup := readCgroupMemory("/sys/fs/cgroup", "/proc/self/cgroup")
		snapshot = mergeMemorySnapshot(procMem, cgroup, isLinuxContainer())
	}
	if !snapshot.hasRAM {
		if memInfo, err := mem.VirtualMemory(); err == nil {
			snapshot.ramUsed = memInfo.Used
			snapshot.ramTotal = memInfo.Total
			snapshot.hasRAM = true
		}
	}
	if !snapshot.hasSwap {
		if swapInfo, err := mem.SwapMemory(); err == nil {
			snapshot.swapUsed = swapInfo.Used
			snapshot.swapTotal = swapInfo.Total
			snapshot.hasSwap = true
		}
	}
	if snapshot.ramUsed > snapshot.ramTotal {
		snapshot.ramUsed = snapshot.ramTotal
	}
	if snapshot.swapUsed > snapshot.swapTotal {
		snapshot.swapUsed = snapshot.swapTotal
	}
	return snapshot
}

func mergeMemorySnapshot(procMem memorySnapshot, cgroup memorySnapshot, containerized bool) memorySnapshot {
	snapshot := procMem
	if cgroup.hasRAM {
		snapshot.ramUsed = cgroup.ramUsed
		snapshot.ramTotal = cgroup.ramTotal
		snapshot.hasRAM = true
	}
	if containerized && cgroup.hasRAM && procMem.hasSwap {
		snapshot.swapUsed = procMem.swapUsed
		snapshot.swapTotal = procMem.swapTotal
		snapshot.hasSwap = true
		if snapshot.swapTotal > snapshot.ramTotal*4 {
			snapshot.swapUsed = 0
			snapshot.swapTotal = 0
		}
	} else if cgroup.hasSwap {
		snapshot.swapUsed = cgroup.swapUsed
		snapshot.swapTotal = cgroup.swapTotal
		snapshot.hasSwap = true
	} else if containerized && cgroup.hasRAM {
		snapshot.swapUsed = 0
		snapshot.swapTotal = 0
		snapshot.hasSwap = true
	}
	if snapshot.ramUsed > snapshot.ramTotal {
		snapshot.ramUsed = snapshot.ramTotal
	}
	if snapshot.swapUsed > snapshot.swapTotal {
		snapshot.swapUsed = snapshot.swapTotal
	}
	return snapshot
}

func isLinuxContainer() bool {
	if data, err := os.ReadFile("/proc/self/cgroup"); err == nil && detectContainerFromCgroup(string(data)) != "" {
		return true
	}
	if _, err := os.Stat("/run/.containerenv"); err == nil {
		return true
	}
	if _, err := os.Stat("/dev/.lxc-boot-id"); err == nil {
		return true
	}
	return false
}

func readProcMeminfo(path string) (memorySnapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return memorySnapshot{}, err
	}
	return parseProcMeminfo(string(data)), nil
}

func parseProcMeminfo(data string) memorySnapshot {
	values := map[string]uint64{}
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		values[strings.TrimSuffix(fields[0], ":")] = value * 1024
	}

	total := values["MemTotal"]
	free := values["MemFree"]
	cached := values["Cached"]
	reclaimable := values["SReclaimable"]
	buffers := values["Buffers"]
	shmem := values["Shmem"]
	swapTotal, hasSwapTotal := values["SwapTotal"]
	swapFree := values["SwapFree"]
	swapCached := values["SwapCached"]

	snapshot := memorySnapshot{}
	if total > 0 {
		usedDiff := free + cached + reclaimable + buffers
		if total >= usedDiff {
			snapshot.ramUsed = total - usedDiff
		} else {
			snapshot.ramUsed = total - free
		}
		snapshot.ramUsed += shmem
		snapshot.ramTotal = total
		snapshot.hasRAM = true
	}
	if hasSwapTotal {
		usedDiff := swapFree + swapCached
		if swapTotal >= usedDiff {
			snapshot.swapUsed = swapTotal - usedDiff
		} else {
			snapshot.swapUsed = swapTotal - swapFree
		}
		snapshot.swapTotal = swapTotal
		snapshot.hasSwap = true
	}
	return snapshot
}

func readCgroupMemory(cgroupRoot string, procSelfCgroup string) memorySnapshot {
	snapshot := memorySnapshot{}
	lines, err := os.ReadFile(procSelfCgroup)
	if err != nil {
		return snapshot
	}

	for _, rawLine := range strings.Split(string(lines), "\n") {
		fields := strings.Split(rawLine, ":")
		if len(fields) < 3 {
			continue
		}
		controllers := fields[1]
		rel := strings.TrimPrefix(filepath.Clean("/"+fields[2]), string(os.PathSeparator))
		if controllers == "" {
			dir := filepath.Join(cgroupRoot, rel)
			if max, ok := readCgroupLimit(filepath.Join(dir, "memory.max")); ok {
				current, _ := readCgroupLimit(filepath.Join(dir, "memory.current"))
				snapshot.ramTotal = max
				snapshot.ramUsed = current
				snapshot.hasRAM = true
			}
			if max, ok := readCgroupLimit(filepath.Join(dir, "memory.swap.max")); ok {
				current, _ := readCgroupLimit(filepath.Join(dir, "memory.swap.current"))
				snapshot.swapTotal = max
				snapshot.swapUsed = current
				snapshot.hasSwap = true
			}
			return snapshot
		}
		if strings.Contains(","+controllers+",", ",memory,") {
			for _, dir := range []string{filepath.Join(cgroupRoot, "memory", rel), filepath.Join(cgroupRoot, rel)} {
				if max, ok := readCgroupLimit(filepath.Join(dir, "memory.limit_in_bytes")); ok {
					current, _ := readCgroupLimit(filepath.Join(dir, "memory.usage_in_bytes"))
					snapshot.ramTotal = max
					snapshot.ramUsed = current
					snapshot.hasRAM = true
					if memswMax, ok := readCgroupLimit(filepath.Join(dir, "memory.memsw.limit_in_bytes")); ok {
						memswCurrent, _ := readCgroupLimit(filepath.Join(dir, "memory.memsw.usage_in_bytes"))
						if memswMax >= max {
							snapshot.swapTotal = memswMax - max
							snapshot.hasSwap = true
						}
						if memswCurrent >= current {
							snapshot.swapUsed = memswCurrent - current
						}
					}
					break
				}
			}
			return snapshot
		}
	}
	return snapshot
}

func readCgroupLimit(path string) (uint64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	value := strings.TrimSpace(string(raw))
	if value == "" || value == "max" {
		return 0, false
	}
	limit, err := strconv.ParseUint(value, 10, 64)
	if err != nil || limit > maxReasonableCgroupLimit {
		return 0, false
	}
	return limit, true
}

func parseFilterList(value string) []string {
	parts := strings.Split(value, ",")
	filters := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			filters = append(filters, part)
		}
	}
	return filters
}

func matchFilter(value string, filters []string) bool {
	for _, filter := range filters {
		if filter == value {
			return true
		}
		if matched, err := filepath.Match(filter, value); err == nil && matched {
			return true
		}
	}
	return false
}

func partitionMatchesFilter(partition disk.PartitionStat, filters []string) bool {
	if len(filters) == 0 {
		return false
	}
	return matchFilter(partition.Mountpoint, filters) ||
		matchFilter(partition.Device, filters) ||
		matchFilter(partition.Fstype, filters)
}

func selectDiskPartitions(partitions []disk.PartitionStat, include string, exclude string) []disk.PartitionStat {
	includeFilters := parseFilterList(include)
	excludeFilters := parseFilterList(exclude)
	selected := make([]disk.PartitionStat, 0, len(partitions))
	for _, partition := range partitions {
		if len(includeFilters) > 0 && !partitionMatchesFilter(partition, includeFilters) {
			continue
		}
		if len(includeFilters) == 0 && !isKomariPhysicalDisk(partition) {
			continue
		}
		if partitionMatchesFilter(partition, excludeFilters) {
			continue
		}
		selected = append(selected, partition)
	}
	return selected
}

func isKomariPhysicalDisk(partition disk.PartitionStat) bool {
	if partition.Mountpoint == "/" {
		return true
	}
	mountpoint := strings.ToLower(partition.Mountpoint)
	for _, prefix := range []string{
		"/tmp", "/var/tmp", "/dev", "/run", "/var/lib/containers", "/var/lib/docker",
		"/proc", "/sys", "/sys/fs/cgroup", "/etc/resolv.conf", "/etc/host", "/nix/store",
	} {
		if mountpoint == prefix || strings.HasPrefix(mountpoint, prefix) {
			return false
		}
	}

	fstype := strings.ToLower(partition.Fstype)
	if fstype == "autofs" && !strings.HasPrefix(partition.Device, "/dev/") {
		return false
	}
	if fstype == "fuseblk" {
		return true
	}
	for _, fs := range []string{
		"tmpfs", "devtmpfs", "udev", "nfs", "cifs", "smb", "vboxsf", "9p", "fuse",
		"overlay", "proc", "devpts", "sysfs", "cgroup", "mqueue", "hugetlbfs",
		"debugfs", "binfmt_misc", "securityfs",
	} {
		if fstype == fs || strings.HasPrefix(fstype, fs) {
			return false
		}
	}

	opts := strings.ToLower(strings.Join(partition.Opts, ","))
	if strings.Contains(opts, "remote") || strings.Contains(opts, "network") {
		return false
	}
	return !strings.HasPrefix(partition.Device, "/dev/loop")
}

func diskDeviceID(partition disk.PartitionStat) string {
	if strings.ToLower(partition.Fstype) == "zfs" {
		if idx := strings.Index(partition.Device, "/"); idx != -1 {
			return partition.Device[:idx]
		}
	}
	return partition.Device
}

func diskUsageTotals() (int64, int64) {
	partitions, err := disk.Partitions(true)
	if err != nil {
		return 0, 0
	}
	selected := selectDiskPartitions(partitions, mountInclude, mountExclude)
	if strings.TrimSpace(mountInclude) != "" {
		var usedDisk, totalDisk int64
		for _, partition := range selected {
			if usage, err := disk.Usage(partition.Mountpoint); err == nil {
				usedDisk += int64(usage.Used)
				totalDisk += int64(usage.Total)
			}
		}
		return usedDisk, totalDisk
	}

	deviceMap := map[string]*disk.UsageStat{}
	for _, partition := range selected {
		usage, err := disk.Usage(partition.Mountpoint)
		if err != nil {
			continue
		}
		deviceID := diskDeviceID(partition)
		if existing, ok := deviceMap[deviceID]; ok && existing.Total >= usage.Total {
			continue
		}
		deviceMap[deviceID] = usage
	}

	var usedDisk, totalDisk int64
	for _, usage := range deviceMap {
		usedDisk += int64(usage.Used)
		totalDisk += int64(usage.Total)
	}
	return usedDisk, totalDisk
}

func interfaceMatchesFilter(name string, filters []string) bool {
	if len(filters) == 0 {
		return false
	}
	return matchFilter(name, filters)
}

func isDefaultExcludedNetworkInterface(name string) bool {
	name = strings.ToLower(name)
	for _, prefix := range defaultExcludedNetworkInterfacePrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func includeNetworkInterface(name string, includeFilters []string, excludeFilters []string) bool {
	if len(includeFilters) > 0 && !interfaceMatchesFilter(name, includeFilters) {
		return false
	}
	if len(includeFilters) == 0 && isDefaultExcludedNetworkInterface(name) {
		return false
	}
	return !interfaceMatchesFilter(name, excludeFilters)
}

func sumNetworkCounters(counters []gnet.IOCountersStat, include string, exclude string) (int64, int64) {
	includeFilters := parseFilterList(include)
	excludeFilters := parseFilterList(exclude)
	var sent, received int64
	for _, counter := range counters {
		if !includeNetworkInterface(counter.Name, includeFilters, excludeFilters) {
			continue
		}
		sent += int64(counter.BytesSent)
		received += int64(counter.BytesRecv)
	}
	return sent, received
}

func processCount() int {
	if runtime.GOOS == "linux" {
		if count := processCountFromProc("/proc"); count > 0 {
			return count
		}
	}
	if processes, err := process.Processes(); err == nil {
		return len(processes)
	}
	return 0
}

func processCountFromProc(root string) int {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if _, err := strconv.ParseInt(entry.Name(), 10, 64); err == nil {
			count++
		}
	}
	return count
}

func connectionsCount() (int, int) {
	if runtime.GOOS == "linux" {
		if tcp, udp, err := procNetConnectionsCount("/proc"); err == nil {
			return tcp, udp
		}
	}
	tcpConns, tcpErr := gnet.Connections("tcp")
	udpConns, udpErr := gnet.Connections("udp")
	if tcpErr != nil || udpErr != nil {
		return 0, 0
	}
	return len(tcpConns), len(udpConns)
}

func procNetConnectionsCount(root string) (int, int, error) {
	tcp, err := countProcNetFiles(root, "tcp", "tcp6")
	if err != nil {
		return 0, 0, err
	}
	udp, err := countProcNetFiles(root, "udp", "udp6")
	if err != nil {
		return 0, 0, err
	}
	return tcp, udp, nil
}

func countProcNetFiles(root string, names ...string) (int, error) {
	total := 0
	readAny := false
	for _, name := range names {
		count, err := countProcNetFile(filepath.Join(root, "net", name))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return 0, err
		}
		total += count
		readAny = true
	}
	if !readAny {
		return 0, fmt.Errorf("no proc net files found under %s", filepath.Join(root, "net"))
	}
	return total, nil
}

func countProcNetFile(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	count := 0
	header := true
	for _, line := range strings.Split(string(data), "\n") {
		if header {
			header = false
			continue
		}
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count, nil
}

type trafficResetState struct {
	ResetDay     int    `json:"reset_day"`
	Period       string `json:"period"`
	Scope        string `json:"scope"`
	LastRawUp    int64  `json:"last_raw_up"`
	LastRawDown  int64  `json:"last_raw_down"`
	PeriodUp     int64  `json:"period_up"`
	PeriodDown   int64  `json:"period_down"`
	BaselineUp   int64  `json:"baseline_up,omitempty"`
	BaselineDown int64  `json:"baseline_down,omitempty"`
	LastBootUnix int64  `json:"last_boot_unix,omitempty"`
}

type trafficResetTracker struct {
	mu        sync.Mutex
	resetDay  int
	scope     string
	statePath string
	state     trafficResetState
	loaded    bool
}

func normalizeTrafficResetDay(day int) int {
	if day < 1 {
		return 1
	}
	if day > 31 {
		return 31
	}
	return day
}

func newTrafficResetTracker(resetDay int, token string, scope string) *trafficResetTracker {
	return &trafficResetTracker{
		resetDay:  normalizeTrafficResetDay(resetDay),
		scope:     scope,
		statePath: trafficResetStatePath(token),
	}
}

func trafficCounterScope() string {
	return shortHash(strings.TrimSpace(nicInclude) + "\n" + strings.TrimSpace(nicExclude))
}

func trafficResetStatePath(_ string) string {
	if override := strings.TrimSpace(os.Getenv("CF_MONITOR_TRAFFIC_STATE_FILE")); override != "" {
		return override
	}
	if exePath, err := os.Executable(); err == nil {
		if dir := filepath.Dir(exePath); strings.TrimSpace(dir) != "" && dir != "." {
			return filepath.Join(dir, "traffic-state.json")
		}
	}
	baseDir, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(baseDir) == "" {
		baseDir = os.TempDir()
	}
	return filepath.Join(baseDir, "cf-vps-monitor-agent", "traffic-state.json")
}

func shortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:16]
}

func trafficResetPeriodKey(now time.Time, resetDay int) string {
	resetDay = normalizeTrafficResetDay(resetDay)
	return lastTrafficResetDate(resetDay, now).Format(time.DateOnly)
}

func lastTrafficResetDate(resetDay int, currentDate time.Time) time.Time {
	resetDay = normalizeTrafficResetDay(resetDay)
	thisMonth := actualTrafficResetDate(currentDate.Year(), currentDate.Month(), resetDay, currentDate.Location())
	if !currentDate.Before(thisMonth) {
		return thisMonth
	}
	previousMonth := time.Date(currentDate.Year(), currentDate.Month(), 1, 0, 0, 0, 0, currentDate.Location()).AddDate(0, -1, 0)
	return actualTrafficResetDate(previousMonth.Year(), previousMonth.Month(), resetDay, currentDate.Location())
}

func actualTrafficResetDate(year int, month time.Month, resetDay int, location *time.Location) time.Time {
	firstDayOfNextMonth := time.Date(year, month+1, 1, 0, 0, 0, 0, location)
	lastDayOfMonth := firstDayOfNextMonth.AddDate(0, 0, -1).Day()
	if resetDay <= lastDayOfMonth {
		return time.Date(year, month, resetDay, 0, 0, 0, 0, location)
	}
	return firstDayOfNextMonth
}

func trafficBootTime(now time.Time) time.Time {
	info, err := host.Info()
	if err != nil || info.BootTime == 0 {
		return time.Time{}
	}
	return time.Unix(int64(info.BootTime), 0).In(now.Location())
}

func rawTrafficCoversPeriod(periodStart time.Time, now time.Time, bootedAt time.Time) bool {
	return !bootedAt.IsZero() && !bootedAt.Before(periodStart) && !bootedAt.After(now)
}

func trafficBootUnix(bootedAt time.Time) int64 {
	if bootedAt.IsZero() {
		return 0
	}
	return bootedAt.Unix()
}

func maxInt64(a int64, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func (t *trafficResetTracker) adjust(rawUp int64, rawDown int64, now time.Time) (int64, int64) {
	return t.adjustSinceBoot(rawUp, rawDown, now, trafficBootTime(now))
}

func (t *trafficResetTracker) adjustSinceBoot(rawUp int64, rawDown int64, now time.Time, bootedAt time.Time) (int64, int64) {
	if t == nil {
		return rawUp, rawDown
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	if !t.loaded {
		t.load()
		t.loaded = true
	}

	periodStart := lastTrafficResetDate(t.resetDay, now)
	period := periodStart.Format(time.DateOnly)
	rawCoversPeriod := rawTrafficCoversPeriod(periodStart, now, bootedAt)
	bootUnix := trafficBootUnix(bootedAt)
	samePeriod := t.state.ResetDay == t.resetDay && t.state.Period == period && t.state.Scope == t.scope
	bootChanged := bootUnix != 0 && t.state.LastBootUnix != 0 && t.state.LastBootUnix != bootUnix
	if samePeriod && rawCoversPeriod && bootChanged {
		t.state.PeriodUp += rawUp
		t.state.PeriodDown += rawDown
		t.state.LastRawUp = rawUp
		t.state.LastRawDown = rawDown
		t.state.LastBootUnix = bootUnix
		t.state.BaselineUp = 0
		t.state.BaselineDown = 0
		t.save()
		return t.state.PeriodUp, t.state.PeriodDown
	}
	if t.state.ResetDay == t.resetDay && t.state.Period == period && t.state.Scope == t.scope && rawCoversPeriod &&
		rawUp >= t.state.PeriodUp && rawDown >= t.state.PeriodDown &&
		(t.state.PeriodUp < rawUp || t.state.PeriodDown < rawDown) {
		t.state.PeriodUp = maxInt64(t.state.PeriodUp, rawUp)
		t.state.PeriodDown = maxInt64(t.state.PeriodDown, rawDown)
		t.state.LastRawUp = rawUp
		t.state.LastRawDown = rawDown
		t.state.LastBootUnix = bootUnix
		t.state.BaselineUp = 0
		t.state.BaselineDown = 0
		t.save()
		return t.state.PeriodUp, t.state.PeriodDown
	}
	if t.state.LastRawUp == 0 && t.state.LastRawDown == 0 && (t.state.BaselineUp != 0 || t.state.BaselineDown != 0) {
		t.state.LastRawUp = rawUp
		t.state.LastRawDown = rawDown
		if t.state.ResetDay == t.resetDay && t.state.Period == period && t.state.Scope == t.scope {
			t.state.PeriodUp = rawUp - t.state.BaselineUp
			t.state.PeriodDown = rawDown - t.state.BaselineDown
			if t.state.PeriodUp < 0 {
				t.state.PeriodUp = 0
			}
			if t.state.PeriodDown < 0 {
				t.state.PeriodDown = 0
			}
		} else {
			t.state.ResetDay = t.resetDay
			t.state.Period = period
			t.state.Scope = t.scope
			t.state.PeriodUp = 0
			t.state.PeriodDown = 0
		}
		t.state.LastBootUnix = bootUnix
		t.state.BaselineUp = 0
		t.state.BaselineDown = 0
		t.save()
		return t.state.PeriodUp, t.state.PeriodDown
	}

	if t.state.ResetDay != t.resetDay || t.state.Period == "" || t.state.Scope != t.scope {
		periodUp, periodDown := int64(0), int64(0)
		if rawCoversPeriod {
			periodUp = rawUp
			periodDown = rawDown
		}
		t.state = trafficResetState{
			ResetDay:     t.resetDay,
			Period:       period,
			Scope:        t.scope,
			LastRawUp:    rawUp,
			LastRawDown:  rawDown,
			PeriodUp:     periodUp,
			PeriodDown:   periodDown,
			LastBootUnix: bootUnix,
		}
		t.save()
		log.Printf("traffic tracker initialized for period %s", period)
		return periodUp, periodDown
	}

	deltaUp := rawUp - t.state.LastRawUp
	deltaDown := rawDown - t.state.LastRawDown
	if deltaUp < 0 || deltaDown < 0 {
		if rawCoversPeriod {
			deltaUp = rawUp
			deltaDown = rawDown
		} else {
			if deltaUp < 0 {
				deltaUp = 0
			}
			if deltaDown < 0 {
				deltaDown = 0
			}
		}
	}

	if t.state.Period != period {
		t.state.Period = period
		if rawCoversPeriod {
			deltaUp = rawUp
			deltaDown = rawDown
		}
		t.state.PeriodUp = deltaUp
		t.state.PeriodDown = deltaDown
		log.Printf("traffic period rotated to %s", period)
	} else {
		t.state.PeriodUp += deltaUp
		t.state.PeriodDown += deltaDown
	}

	t.state.ResetDay = t.resetDay
	t.state.Scope = t.scope
	t.state.LastRawUp = rawUp
	t.state.LastRawDown = rawDown
	t.state.LastBootUnix = bootUnix
	t.save()
	return t.state.PeriodUp, t.state.PeriodDown
}

func (t *trafficResetTracker) load() {
	if t.statePath == "" {
		return
	}
	data, err := os.ReadFile(t.statePath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("traffic reset state read failed: %v", err)
		}
		return
	}
	var state trafficResetState
	if err := json.Unmarshal(data, &state); err != nil {
		log.Printf("traffic reset state parse failed: %v", err)
		return
	}
	t.state = state
}

func (t *trafficResetTracker) save() {
	if t.statePath == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(t.statePath), 0o700); err != nil {
		log.Printf("traffic reset state directory create failed: %v", err)
		return
	}
	data, err := json.MarshalIndent(t.state, "", "  ")
	if err != nil {
		log.Printf("traffic reset state encode failed: %v", err)
		return
	}
	tmpPath := t.statePath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o600); err != nil {
		log.Printf("traffic reset state write failed: %v", err)
		return
	}
	_ = os.Remove(t.statePath)
	if err := os.Rename(tmpPath, t.statePath); err != nil {
		log.Printf("traffic reset state replace failed: %v", err)
		_ = os.Remove(tmpPath)
	}
}

var (
	globalGPUDetails []GPUInfo
	gpuDetailsMu     sync.Mutex
)

func collectReportWithInterval(intervalSec int) Report {
	now := time.Now()
	r := Report{Version: Version, ReportInterval: intervalSec, Timestamp: now.UnixMilli()}
	r.IPv4, r.IPv6 = localIPAddresses()

	if percent, err := cpu.Percent(time.Second, false); err == nil && len(percent) > 0 {
		r.CPU = percent[0]
	}
	if memory := readMemorySnapshot(); memory.hasRAM {
		r.RAM = int64(memory.ramUsed)
		r.RAMTotal = int64(memory.ramTotal)
		if memory.hasSwap {
			r.Swap = int64(memory.swapUsed)
			r.SwapTotal = int64(memory.swapTotal)
		}
	}
	if loadInfo, err := load.Avg(); err == nil {
		r.Load = loadInfo.Load1
	}
	r.Disk, r.DiskTotal = diskUsageTotals()
	if netIO, err := gnet.IOCounters(true); err == nil && len(netIO) > 0 {
		rawUp, rawDown := sumNetworkCounters(netIO, nicInclude, nicExclude)
		r.hasRawNetTotals = true
		r.rawNetTotalUp = rawUp
		r.rawNetTotalDown = rawDown
		if trafficTracker != nil {
			r.NetTotalUp, r.NetTotalDown = trafficTracker.adjust(rawUp, rawDown, now)
		} else {
			r.NetTotalUp, r.NetTotalDown = rawUp, rawDown
		}
	}
	r.ProcessCount = processCount()
	r.Connections, r.ConnectionsUdp = connectionsCount()
	if hostInfo, err := host.Info(); err == nil {
		r.Uptime = int64(hostInfo.Uptime)
	}

	// GPU details
	gpuDetailsMu.Lock()
	if len(globalGPUDetails) > 0 {
		// Refresh GPU data for each report
		_, gpuDetails := detectGPU()
		r.GPUs = gpuDetails
		if len(gpuDetails) > 0 {
			// Average utilization across all GPUs
			var totalUtil float64
			for _, g := range gpuDetails {
				totalUtil += g.Utilization
			}
			r.GPU = totalUtil / float64(len(gpuDetails))
		}
	}
	gpuDetailsMu.Unlock()

	return r
}

func collectReport() Report {
	return collectReportWithInterval(reportInterval)
}

func (p *reportPreparer) prepare() Report {
	return p.prepareForInterval(time.Duration(reportInterval) * time.Second)
}

func (p *reportPreparer) prepareForInterval(interval time.Duration) Report {
	intervalSec := intervalSeconds(interval)
	report := collectReportWithInterval(intervalSec)
	prepared := p.prepareReportForInterval(report, intervalSec)
	p.attachBasicInfoIfDue(&prepared, time.Now())
	return prepared
}

func prepareReportWithPing(preparer *reportPreparer, pingState *pingReportState, interval time.Duration) Report {
	report := preparer.prepareForInterval(interval)
	if pingState != nil {
		pingState.appendDueResults(&report, time.Now())
	}
	return report
}

func (p *reportPreparer) prepareReport(report Report) Report {
	intervalSec := report.ReportInterval
	if intervalSec < 1 {
		intervalSec = reportInterval
	}
	return p.prepareReportForInterval(report, intervalSec)
}

func (p *reportPreparer) prepareReportForInterval(report Report, intervalSec int) Report {
	if intervalSec < 1 {
		intervalSec = 1
	}
	report.ReportInterval = intervalSec
	if clientName != "" {
		report.Name = clientName
	}

	speedTotalUp, speedTotalDown := report.NetTotalUp, report.NetTotalDown
	if report.hasRawNetTotals {
		speedTotalUp = report.rawNetTotalUp
		speedTotalDown = report.rawNetTotalDown
	}

	if !p.ready {
		p.lastNetUp = speedTotalUp
		p.lastNetDown = speedTotalDown
		p.lastNetCountersRaw = report.hasRawNetTotals
		p.lastTimestampMs = report.Timestamp
		p.ready = true
		return report
	}
	if p.lastNetCountersRaw != report.hasRawNetTotals {
		p.lastNetUp = speedTotalUp
		p.lastNetDown = speedTotalDown
		p.lastNetCountersRaw = report.hasRawNetTotals
		p.lastTimestampMs = report.Timestamp
		return report
	}

	upDelta := speedTotalUp - p.lastNetUp
	downDelta := speedTotalDown - p.lastNetDown
	if upDelta < 0 {
		upDelta = 0
	}
	if downDelta < 0 {
		downDelta = 0
	}

	effectiveIntervalSec := intervalSec
	if report.Timestamp > 0 && p.lastTimestampMs > 0 {
		elapsedMs := report.Timestamp - p.lastTimestampMs
		if elapsedMs > 0 {
			effectiveIntervalSec = int((elapsedMs + 500) / 1000)
		}
	}
	minIntervalSec := int(minReportInterval / time.Second)
	if effectiveIntervalSec < minIntervalSec {
		effectiveIntervalSec = minIntervalSec
	}
	report.ReportInterval = effectiveIntervalSec
	report.NetOut = upDelta / int64(effectiveIntervalSec)
	report.NetIn = downDelta / int64(effectiveIntervalSec)
	p.lastNetUp = speedTotalUp
	p.lastNetDown = speedTotalDown
	p.lastTimestampMs = report.Timestamp

	return report
}

func (p *reportPreparer) attachBasicInfoIfDue(report *Report, now time.Time) {
	if p == nil || report == nil {
		return
	}
	if !p.lastBasicInfoAt.IsZero() && now.Sub(p.lastBasicInfoAt) < basicInfoRefreshInterval {
		return
	}
	info := getBasicInfo()
	report.BasicInfo = &info
	p.lastBasicInfoAt = now
}

func sendHTTPReports(reports []Report) {
	if len(reports) == 0 {
		return
	}
	endpoint := serverURL + "/api/clients/report"
	payload := any(reports[0])
	if len(reports) > 1 {
		payload = map[string]any{"reports": reports}
	}
	if err := postJSON(endpoint, payload, token); err != nil {
		log.Printf("HTTP report failed: %v", err)
		return
	}
	if len(reports) == 1 {
		logReport("HTTP report sent", reports[0])
	} else {
		log.Printf("HTTP report batch sent: %d reports", len(reports))
	}
}

func fetchAgentPolicy() (agentPolicy, error) {
	endpoint := serverURL + "/api/clients/policy"
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return agentPolicy{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return agentPolicy{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return agentPolicy{}, httpStatusError(resp)
	}

	var policy agentPolicy
	if err := json.NewDecoder(resp.Body).Decode(&policy); err != nil {
		return agentPolicy{}, err
	}
	if policy.Type != "policy" {
		return agentPolicy{}, fmt.Errorf("unexpected policy type %q", policy.Type)
	}
	if policy.ReportIntervalSec < 1 {
		return agentPolicy{}, fmt.Errorf("invalid policy interval %d", policy.ReportIntervalSec)
	}
	if policy.SampleIntervalSec < 1 {
		policy.SampleIntervalSec = policy.ReportIntervalSec
	}
	return policy, nil
}

func sendWebSocketReports(conn *safeWebSocketConn, reports []Report) error {
	if len(reports) == 0 {
		return nil
	}
	if len(reports) == 1 {
		if err := conn.WriteJSON(reportEnvelope{Type: "report", Data: reports[0]}); err != nil {
			return err
		}
		logReport("WebSocket report sent", reports[0])
		return nil
	}
	if err := conn.WriteJSON(reportsEnvelope{Type: "reports", Reports: reports}); err != nil {
		return err
	}
	log.Printf("WebSocket report batch sent: %d reports", len(reports))
	return nil
}

func logReport(prefix string, report Report) {
	log.Printf("%s: CPU %.1f%%, RAM %s/%s, Net in=%dB/s out=%dB/s",
		prefix,
		report.CPU,
		formatMemoryBytes(report.RAM),
		formatMemoryBytes(report.RAMTotal),
		report.NetIn,
		report.NetOut,
	)
}

func formatMemoryBytes(value int64) string {
	if value < 1024*1024*1024 {
		return fmt.Sprintf("%dMiB", value/1024/1024)
	}
	return fmt.Sprintf("%.1fGiB", float64(value)/1024/1024/1024)
}

func postJSON(endpoint string, data interface{}, bearerToken string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return postJSONWithContext(ctx, endpoint, data, bearerToken)
}

func postJSONWithContext(ctx context.Context, endpoint string, data interface{}, bearerToken string) error {
	body, err := json.Marshal(data)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return httpStatusError(resp)
	}

	return nil
}

func httpStatusError(resp *http.Response) error {
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxHTTPErrorBodyBytes+1))
	truncated := len(respBody) > maxHTTPErrorBodyBytes
	if truncated {
		respBody = respBody[:maxHTTPErrorBodyBytes]
	}
	detail := strings.TrimSpace(string(respBody))
	if detail == "" {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if truncated {
		return fmt.Errorf("HTTP %d: %s...(truncated)", resp.StatusCode, detail)
	}
	return fmt.Errorf("HTTP %d: %s", resp.StatusCode, detail)
}

func normalizeServerURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("empty server URL")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("unsupported scheme %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("missing host")
	}
	if parsed.Scheme == "http" && !isLocalHTTPHost(parsed.Hostname()) {
		return "", fmt.Errorf("http server URL is allowed only for localhost")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func isLocalHTTPHost(host string) bool {
	host = strings.ToLower(strings.Trim(host, "[]"))
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func webSocketEndpoint(server string, _ string) (string, error) {
	parsed, err := url.Parse(server)
	if err != nil {
		return "", err
	}

	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported scheme %q", parsed.Scheme)
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/clients/report"
	parsed.RawQuery = ""
	return parsed.String(), nil
}

func redactURLSecret(rawURL string, keys ...string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	query := parsed.Query()
	changed := false
	for _, key := range keys {
		if query.Has(key) {
			query.Set(key, "REDACTED")
			changed = true
		}
	}
	if !changed {
		return rawURL
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func connectWebSocket(endpoint string, agentToken string) (*safeWebSocketConn, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		Proxy:            http.ProxyFromEnvironment,
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+agentToken)
	conn, resp, err := dialer.Dial(endpoint, headers)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("%s", resp.Status)
		}
		return nil, err
	}
	return &safeWebSocketConn{conn: conn}, nil
}

func readWebSocketMessages(conn *safeWebSocketConn, done chan<- error, policies chan<- serverMessage) {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			done <- err
			return
		}

		var message serverMessage
		if err := json.Unmarshal(raw, &message); err != nil {
			log.Printf("WebSocket message: %s", string(raw))
			continue
		}
		if message.Type == "ack" {
			log.Printf("WebSocket ack received: %d", message.Timestamp)
			continue
		}
		if message.Type == "policy" {
			select {
			case policies <- message:
			default:
				log.Printf("WebSocket policy dropped: queue full")
			}
			continue
		}
		log.Printf("WebSocket message type=%s", message.Type)
	}
}

func (c *safeWebSocketConn) WriteMessage(messageType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(messageType, data)
}

func (c *safeWebSocketConn) WriteJSON(data interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(data)
}

func (c *safeWebSocketConn) ReadMessage() (int, []byte, error) {
	return c.conn.ReadMessage()
}

func (c *safeWebSocketConn) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.Close()
}
