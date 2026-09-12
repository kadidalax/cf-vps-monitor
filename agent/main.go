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

// defaultExcludedNetworkInterfacePrefixes 是默认不计入流量/速率的网卡前缀。
//
// 两类：
//   - 桥接、容器、虚拟交换机（br/docker/veth/...）——本机内部转发，不是进出 VPS 的流量。
//   - 隧道与 VPN（wg/tun/tailscale/warp/...）——**与物理网卡承载同一份流量**，
//     同时统计会把同一份流量数两遍，正是面板远高于商家计量的原因。
//
// ⚠️ 常见的反向直觉是「不统计隧道会漏算」，方向是反的：数据要离开本机必然经过
// 物理网卡，那里已经算过一遍；隧道口上再算一遍才是多算。
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
	// 隧道 / VPN / 叠加网络
	"wg",
	"tun",
	"utun",
	"tailscale",
	"warp",
	"zt",
	"nordlynx",
	"proton",
	"mullvad",
	"gre",
	"ipip",
	"sit",
	"ip6tnl",
	"vxlan",
	"geneve",
	"nebula",
	"gif",
	"stf",
	"awdl",
	"llw",
	// 纯本地/测试用虚拟设备
	"dummy",
	"ifb",
}

var (
	token                   string
	serverURL               string
	reportInterval          int
	clientName              string
	reportMode              string
	reconnectInterval       int
	pingInterval            int
	trafficResetDay         int
	mountInclude            string
	mountExclude            string
	containerDiskTotalBytes containerDiskTotalValue
	nicInclude              string
	nicExclude              string
	trafficTracker          *trafficResetTracker
	publicIPv4ProbeURLs     = []string{
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
	CPU       float64 `json:"cpu"`
	GPU       float64 `json:"gpu"`
	RAM       int64   `json:"ram"`
	RAMTotal  int64   `json:"ram_total"`
	Swap      int64   `json:"swap"`
	SwapTotal int64   `json:"swap_total"`
	// Load 为空指针表示「本机负载不可取信」（例如 lxcfs 未虚拟化 loadavg 的 LXC
	// 容器，/proc/loadavg 直接透传宿主机数值）。序列化成 null，服务端据此跳过负载告警。
	// 不能报 0——0 会被读成「空闲」，比报错值更误导。
	Load *float64 `json:"load"`
	Temp *float64 `json:"temp"`
	// A nil disk or uptime value is unavailable, including host data that
	// cannot be attributed to the current container. Keep JSON null explicit.
	Disk                *int64               `json:"disk"`
	DiskTotal           *int64               `json:"disk_total"`
	DiskSource          string               `json:"disk_source,omitempty"`
	DiskSampledAt       int64                `json:"disk_sampled_at,omitempty"`
	NetIn               int64                `json:"net_in"`
	NetOut              int64                `json:"net_out"`
	NetTotalUp          int64                `json:"net_total_up"`
	NetTotalDown        int64                `json:"net_total_down"`
	ProcessCount        int                  `json:"process_count"`
	Connections         int                  `json:"connections"`
	ConnectionsUdp      int                  `json:"connections_udp"`
	Uptime              *int64               `json:"uptime"`
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
	// 按接口名分列的累计计数，用于计算速率。
	// 不能只靠上面的汇总标量做差：一旦参与统计的接口集合发生变化
	//（隧道/VPN 接口起来、容器网卡出现），汇总值会跳增该接口的历史累计流量，
	// 被当成一个采样周期内的增量，算出几百 MB/s 的荒谬速率。
	netPerInterface     map[string]interfaceCounters
	pingResultLeases    map[int]uint64
	websiteResultLeases map[int]uint64
	basicInfoOwner      *reportPreparer
	basicInfoRevision   uint64
}

// interfaceCounters 是单个网卡的累计收发字节数。
type interfaceCounters struct {
	sent uint64
	recv uint64
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
	ConfigRevision    string `json:"config_revision"`
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
	ConfigRevision  string  `json:"config_revision"`
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

func (s *pingTaskScheduler) dueTasks(tasks []PingTask, now time.Time, blocked ...map[int]bool) []PingTask {
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
		if len(blocked) > 0 && blocked[0][task.ID] {
			continue
		}
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

func (s *websiteProbeScheduler) dueTasks(tasks []WebsiteProbeTask, now time.Time, blocked ...map[int]bool) []WebsiteProbeTask {
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
		if len(blocked) > 0 && blocked[0][task.ID] {
			continue
		}
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
	// 指针：字段缺席表示「后台没有这个节点的重置日」，此时保留本地取值，
	// 不能被一个默认 1 悄悄改掉安装时指定的 --traffic-reset-day。
	TrafficResetDay *int `json:"traffic_reset_day,omitempty"`
}

type agentPolicy = serverMessage

type reportPreparer struct {
	collect             func(int) Report
	lastNetUp           int64
	lastNetDown         int64
	lastNetCountersRaw  bool
	lastNetPerInterface map[string]interfaceCounters
	lastTimestampMs     int64
	lastBasicInfoAt     time.Time
	basicInfoMu         sync.Mutex
	pendingBasicInfo    *BasicInfo
	basicInfoRevision   uint64
	ready               bool
}

type pingReportState struct {
	mu               sync.Mutex
	scheduler        *pingTaskScheduler
	websiteScheduler *websiteProbeScheduler
	tasks            []PingTask
	websiteTasks     []WebsiteProbeTask
	policyVersion    string
	intervalSec      int
	pendingPing      map[int]*queuedPingResult
	pendingWebsites  map[int]*queuedWebsiteResult
	pingOrder        []int
	websiteOrder     []int
	nextResultID     uint64
	retryQueue       []Report
	ctx              context.Context
	cancel           context.CancelFunc
	probeWake        chan struct{}
	probeDone        chan struct{}
	probeWorkers     sync.WaitGroup
	runningPing      map[int]*probeRun
	runningWebsites  map[int]*probeRun
	activeProbes     int
	preferWebsite    bool
}

type safeWebSocketConn struct {
	conn         *websocket.Conn
	mu           sync.Mutex
	readTimeout  time.Duration
	writeTimeout time.Duration
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
	flag.Var(&containerDiskTotalBytes, "container-disk-total-bytes", "Verified container root disk allocation in decimal bytes, used only when automatic capacity is unavailable (0 = automatic)")
	flag.StringVar(&diskUsageFile, "disk-usage-file", "", "Read a root-owned container file allocation cache (empty = disabled)")
	flag.String("disk-usage-collector", "", "Local-only root disk collector for SERVICE_NAME; does not start the Agent")
	flag.Bool("disk-usage-once", false, "With --disk-usage-collector, collect one sample and exit")
	flag.Bool("disk-usage-check", false, "Check whether root directory collection is required (exit 0 required, 3 not required)")
	flag.StringVar(&nicInclude, "nic-include", "", "Comma-separated network interface patterns to include in traffic totals, for example eth*,ens*")
	flag.StringVar(&nicExclude, "nic-exclude", "", "Comma-separated network interface patterns to exclude from traffic totals, for example lo,docker*,veth*")
}

func main() {
	if handled, code := handleDirectoryCollectorCLI(os.Args[1:], os.Stderr); handled {
		os.Exit(code)
	}
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
	trafficResetDay = trafficTracker.resetDay

	log.Printf("CF VPS Monitor Agent %s", Version)
	log.Printf("server: %s", serverURL)
	log.Printf("interval: %ds", reportInterval)
	log.Printf("mode: %s", reportMode)
	log.Printf("ping interval: every %ds", pingInterval)
	log.Printf("traffic reset day: %d", trafficResetDay)
	logFilter("disk include", mountInclude)
	logFilter("disk exclude", mountExclude)
	if containerDiskTotalBytes > 0 {
		log.Printf("configured container root disk allocation: %d bytes; this does not measure used space", containerDiskTotalBytes)
	}
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
	if mode := os.Getenv("CF_MONITOR_MODE"); !flagWasSet("mode") && mode != "" {
		reportMode = mode
	}
	if mountInclude == "" {
		mountInclude = os.Getenv("CF_MONITOR_MOUNT_INCLUDE")
	}
	if mountExclude == "" {
		mountExclude = os.Getenv("CF_MONITOR_MOUNT_EXCLUDE")
	}
	if !flagWasSet("container-disk-total-bytes") {
		if value := strings.TrimSpace(os.Getenv("CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES")); value != "" {
			if err := containerDiskTotalBytes.Set(value); err != nil {
				log.Fatalf("invalid CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES: %v", err)
			}
		}
	}
	if !flagWasSet("disk-usage-file") {
		diskUsageFile = os.Getenv("CF_MONITOR_DISK_USAGE_FILE")
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

	output, err := runBoundedCommand(context.Background(), auxiliaryCommandTimeout, nvidiaSmi,
		"--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
		"--format=csv,noheader,nounits",
	)
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

	output, err := runBoundedCommand(context.Background(), auxiliaryCommandTimeout, rocmSmi, "--showproductname", "--showmeminfo", "vram", "--showuse", "--showtemp")
	if err != nil {
		log.Printf("rocm-smi query failed: %v", err)
		return nil, nil
	}

	return parseAMDGPUOutput(string(output))
}

// ==================== Ping Execution ====================

func newPingReportState() *pingReportState {
	ctx, cancel := context.WithCancel(context.Background())
	state := &pingReportState{
		scheduler:        newPingTaskScheduler(),
		websiteScheduler: &websiteProbeScheduler{lastRunByTaskID: make(map[int]time.Time)},
		intervalSec:      defaultPingIntervalSec,
		pendingPing:      make(map[int]*queuedPingResult),
		pendingWebsites:  make(map[int]*queuedWebsiteResult),
		ctx:              ctx, cancel: cancel, probeWake: make(chan struct{}, 1), probeDone: make(chan struct{}),
		runningPing: make(map[int]*probeRun), runningWebsites: make(map[int]*probeRun), preferWebsite: true,
	}
	go state.runProbeScheduler()
	return state
}

func (s *pingReportState) applyPolicy(policy agentPolicy) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
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
	websiteTasks := make([]WebsiteProbeTask, 0, len(policy.WebsiteProbeTasks))
	for _, task := range policy.WebsiteProbeTasks {
		if task.IntervalSec < 1 {
			task.IntervalSec = s.intervalSec
		}
		websiteTasks = append(websiteTasks, task)
	}
	s.invalidateResultsForPolicyLocked(tasks, websiteTasks)
	s.tasks, s.websiteTasks = tasks, websiteTasks
	s.policyVersion = policy.PingPolicyVersion
	s.signalProbeScheduler()
	if len(tasks) > 0 || len(websiteTasks) > 0 {
		log.Printf("policy updated: %d ping task(s), %d website probe(s), interval=%ds, version=%s", len(tasks), len(websiteTasks), s.intervalSec, s.policyVersion)
	}
}

func (s *pingReportState) appendDueResults(report *Report, now time.Time) {
	if s == nil || report == nil {
		return
	}
	s.mu.Lock()
	s.appendPendingResultsLocked(report)
	s.mu.Unlock()
	s.signalProbeScheduler()
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
		if err := ctx.Err(); err != nil {
			return nil, err
		}
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
	return executeICMPPingWithContext(context.Background(), target)
}

func executeICMPPingWithContext(parent context.Context, target string) float64 {
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	ips, err := resolvePublicIPsForPing(ctx, target)
	if err != nil {
		log.Printf("ICMP target resolution failed for %q: %v", target, err)
		return -1
	}
	program, args, err := icmpPingCommand(runtime.GOOS, ips[0])
	if err != nil {
		log.Printf("ICMP command unavailable for %q: %v", target, err)
		return -1
	}
	started := time.Now()
	output, err := runBoundedCommand(ctx, 2*time.Second, program, args...)
	if err != nil {
		log.Printf("ICMP ping failed for %q: %v: %s", target, err, strings.TrimSpace(string(output)))
		return -1
	}
	return float64(time.Since(started).Milliseconds())
}

func executeTCPPing(target string) float64 {
	value, err := executeTCPProbeWithContext(context.Background(), target, 3*time.Second)
	if err != nil {
		log.Printf("TCP ping failed for %q: %v", target, err)
	}
	return value
}

func executeTCPProbeWithContext(parent context.Context, target string, timeout time.Duration) (float64, error) {
	address, host, port, err := normalizeTCPTargetAddress(target)
	if err != nil {
		return -1, err
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	ips, err := resolvePublicIPsForPing(ctx, host)
	if err != nil {
		return -1, fmt.Errorf("%s: %w", address, err)
	}
	// The budget includes DNS, but TCP latency still measures only the connect phase.
	started := time.Now()
	conn, err := dialResolvedTCP(ctx, "tcp", ips, port, timeout)
	elapsed := time.Since(started).Milliseconds()
	if err != nil {
		return -1, err
	}
	_ = conn.Close()
	return float64(elapsed), nil
}

func executeHTTPPing(target string) float64 {
	return executeHTTPPingWithContext(context.Background(), target)
}

func executeHTTPPingWithContext(parent context.Context, target string) float64 {
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		target = "https://" + target
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Hostname() == "" {
		return -1
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return -1
	}
	started := time.Now()
	client := &http.Client{Timeout: 5 * time.Second, Transport: publicHTTPTransport(5 * time.Second)}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return -1
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return -1
	}
	return float64(time.Since(started).Milliseconds())
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
		ConfigRevision:  task.ConfigRevision,
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
		ConfigRevision:  task.ConfigRevision,
		OK:              false,
		EffectiveStatus: "down",
		EffectiveReason: reason,
		LatencyMS:       latency,
		Error:           stringPtr(reason),
	}
}

func websiteProbeTimeout(task WebsiteProbeTask) time.Duration {
	seconds := task.TimeoutSec
	if seconds <= 0 {
		seconds = 5
	}
	if seconds > 30 {
		seconds = 30
	}
	return time.Duration(seconds) * time.Second
}

func probeFailureReason(err error) string {
	var networkError net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) || strings.Contains(strings.ToLower(err.Error()), "timeout") {
		return "timeout"
	}
	return "network_error"
}

func executeWebsiteHTTPProbe(task WebsiteProbeTask) WebsiteProbeResult {
	return executeWebsiteHTTPProbeWithContext(context.Background(), task)
}

func executeWebsiteHTTPProbeWithContext(ctx context.Context, task WebsiteProbeTask) WebsiteProbeResult {
	timeout := websiteProbeTimeout(task)
	client := &http.Client{Timeout: timeout, Transport: publicHTTPTransport(timeout)}
	defer client.CloseIdleConnections()
	return executeWebsiteHTTPProbeWithClientContext(ctx, task, client)
}

func executeWebsiteHTTPProbeWithClient(task WebsiteProbeTask, client *http.Client) WebsiteProbeResult {
	return executeWebsiteHTTPProbeWithClientContext(context.Background(), task, client)
}

func executeWebsiteHTTPProbeWithClientContext(parent context.Context, task WebsiteProbeTask, client *http.Client) WebsiteProbeResult {
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
	ctx, cancel := context.WithTimeout(parent, websiteProbeTimeout(task))
	defer cancel()
	started := time.Now()
	request, err := http.NewRequestWithContext(ctx, method, parsed.String(), nil)
	if err != nil {
		return websiteProbeError(task, 0, "invalid_url")
	}
	request.Header.Set("User-Agent", "cf-vps-monitor-agent/"+Version)
	response, err := client.Do(request)
	if err != nil {
		return websiteProbeError(task, time.Since(started).Milliseconds(), probeFailureReason(err))
	}
	defer response.Body.Close()
	if _, err := io.Copy(io.Discard, io.LimitReader(response.Body, 512)); err != nil {
		return websiteProbeError(task, time.Since(started).Milliseconds(), probeFailureReason(err))
	}
	return normalizeWebsiteProbeHTTPResult(task, response.StatusCode, time.Since(started).Milliseconds())
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
	return executeWebsiteTCPProbeWithContext(context.Background(), task)
}

func executeWebsiteTCPProbeWithContext(ctx context.Context, task WebsiteProbeTask) WebsiteProbeResult {
	target := task.URL
	if strings.HasPrefix(strings.ToLower(target), "tcp://") {
		parsed, err := url.Parse(target)
		if err != nil || parsed.Hostname() == "" || parsed.Port() == "" {
			return websiteProbeError(task, 0, "invalid_url")
		}
		target = net.JoinHostPort(parsed.Hostname(), parsed.Port())
	}
	started := time.Now()
	value, err := executeTCPProbeWithContext(ctx, target, websiteProbeTimeout(task))
	if err != nil {
		return websiteProbeError(task, time.Since(started).Milliseconds(), probeFailureReason(err))
	}
	return WebsiteProbeResult{MonitorID: task.ID, ConfigRevision: task.ConfigRevision, OK: true, EffectiveStatus: "up", EffectiveReason: "tcp_connect", LatencyMS: int64(value)}
}

// ==================== Original Functions (Enhanced) ====================

func runHTTPReporter() {
	log.Println("HTTP reporter started")
	preparer := &reportPreparer{}
	pingState := newPingReportState()
	defer pingState.close()
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
				applyTrafficResetDayPolicy(policy)
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
					pending = append(pending, prepareReportsWithPing(preparer, pingState, currentSampleInterval)...)
					_ = deliverHTTPReports(pingState, pending)
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

		pending = append(pending, prepareReportsWithPing(preparer, pingState, currentSampleInterval)...)
		if currentUploadInterval <= currentSampleInterval || !time.Now().Before(nextUploadAt) {
			_ = deliverHTTPReports(pingState, pending)
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
	defer pingState.close()

	for {
		conn, err := connectWebSocket(endpoint, token)
		if err != nil {
			delay := webSocketReconnectDelay(err)
			log.Printf("WebSocket connect failed: %v; reconnecting in %s", err, delay)
			time.Sleep(delay)
			continue
		}

		log.Println("WebSocket connected")
		err = runWebSocketSession(
			conn,
			preparer,
			pingState,
			time.Duration(reportInterval)*time.Second,
			30*time.Second,
		)
		if err != nil {
			log.Printf("WebSocket session ended: %v", err)
		}
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
	if heartbeatInterval <= 0 {
		heartbeatInterval = 30 * time.Second
	}
	if err := conn.configureLiveness(heartbeatInterval); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 2) // Reader and heartbeat each send at most one failure.
	policies := make(chan serverMessage, 8)
	acks := make(chan struct{}, 1)
	var socketWorkers sync.WaitGroup
	socketWorkers.Add(2)
	go func() {
		defer socketWorkers.Done()
		defer conn.Close()
		readWebSocketMessages(conn, done, policies, acks)
	}()
	go func() {
		defer socketWorkers.Done()
		if err := runWebSocketHeartbeat(ctx, conn, heartbeatInterval); err != nil {
			done <- err
			conn.Close()
		}
	}()
	defer func() {
		cancel()
		conn.Close()
		socketWorkers.Wait()
	}()

	ackTimer := time.NewTimer(conn.readTimeout)
	ackTimer.Stop()
	defer ackTimer.Stop()
	var ackDeadline <-chan time.Time
	stopAckTimer := func() {
		if !ackTimer.Stop() {
			select {
			case <-ackTimer.C:
			default:
			}
		}
		ackDeadline = nil
	}

	currentInterval := normalizeReportDuration(dataInterval)
	currentUploadInterval := currentInterval
	pending := prepareReportsWithPing(preparer, pingState, currentInterval)
	var inFlight []Report
	uploadReady := true
	defer func() {
		// A reconnect retries the original probe sample and timestamp, without executing it again.
		pingState.retryReports(inFlight)
		pingState.retryReports(pending)
	}()
	flush := func() error {
		if !uploadReady || len(inFlight) > 0 || len(pending) == 0 {
			return nil
		}
		for len(acks) > 0 {
			<-acks
		}
		count := min(len(pending), maxReportsPerEnvelope)
		inFlight = pingState.currentReportResults(pending[:count])
		pending = pending[count:]
		uploadReady = len(pending) > 0
		if err := sendWebSocketReports(conn, inFlight); err != nil {
			return err
		}
		// Pong proves socket liveness; only ACK accepts this report batch.
		ackTimer.Reset(conn.readTimeout)
		ackDeadline = ackTimer.C
		return nil
	}
	if err := flush(); err != nil {
		return err
	}
	sampleTimer := time.NewTimer(currentInterval)
	defer sampleTimer.Stop()
	uploadTimer := time.NewTimer(currentUploadInterval)
	defer uploadTimer.Stop()

	for {
		select {
		case <-sampleTimer.C:
			pending = append(pending, prepareReportsWithPing(preparer, pingState, currentInterval)...)
			if currentUploadInterval <= currentInterval {
				uploadReady = true
				if err := flush(); err != nil {
					return err
				}
				resetTimer(uploadTimer, currentUploadInterval)
			}
			resetTimer(sampleTimer, currentInterval)
		case <-uploadTimer.C:
			uploadReady = len(pending) > 0
			if err := flush(); err != nil {
				return err
			}
			resetTimer(uploadTimer, currentUploadInterval)
		case <-acks:
			if len(inFlight) > 0 {
				stopAckTimer()
				pingState.acknowledgeReports(inFlight)
				inFlight = nil
				if err := flush(); err != nil {
					return err
				}
			}
		case policy := <-policies:
			if policy.Type != "policy" {
				continue
			}
			pingState.applyPolicy(policy)
			applyTrafficResetDayPolicy(policy)
			currentInterval, currentUploadInterval = policyDurations(policy, currentInterval)
			reportInterval = int(currentInterval / time.Second)
			if policy.ReportNow {
				pending = append(pending, prepareReportsWithPing(preparer, pingState, currentInterval)...)
				uploadReady = true
				if err := flush(); err != nil {
					return err
				}
			}
			resetTimer(sampleTimer, currentInterval)
			resetTimer(uploadTimer, currentUploadInterval)
		case <-ackDeadline:
			return errors.New("WebSocket report acknowledgement timed out")
		case err := <-done:
			return err
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
	}
	if uptime := nodeMetrics.uptime(); uptime != nil {
		info.Uptime = *uptime
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
	if _, diskTotal := nodeMetrics.diskUsageTotals(mountInclude, mountExclude); diskTotal != nil {
		info.DiskTotal = *diskTotal
	}

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
	if out, err := runBoundedCommand(context.Background(), auxiliaryCommandTimeout, "systemd-detect-virt"); err == nil {
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

// selectTrafficInterfaces 决定参与统计的网卡集合。
//
// **累计流量与实时速率必须共用同一个集合**，否则两个数字会互相矛盾（曾出现过：
// 速率按网卡独立基线算、流量按标量汇总算，同一台机器上速率正常而总量翻倍）。
// 因此这里只算一次，两条路径都吃这份结果。
//
// 规则（优先级由上到下）：
//  1. 显式 --nic-include：完全听用户的，只在其中再应用 --nic-exclude。
//     多公网口分走不同线路的机器要靠这个。
//  2. 否则先剔除虚拟/隧道网卡（见 defaultExcludedNetworkInterfacePrefixes）。
//  3. 若剩下的网卡里有承载默认路由的，只统计它们——这正是商家计量的那个口，
//     也能避开内网网卡把内部流量算进去。
//  4. 若默认路由落在被剔除的隧道上（全流量走 VPN 的机器），第 3 步会得到空集，
//     此时退回第 2 步的全部物理网卡：流量终究要从物理口出去，仍是单份计量。
//  5. 最后应用 --nic-exclude。
func selectTrafficInterfaces(names []string, include string, exclude string, defaultRouteNames []string) map[string]bool {
	includeFilters := parseFilterList(include)
	excludeFilters := parseFilterList(exclude)
	selected := make(map[string]bool, len(names))

	if len(includeFilters) > 0 {
		for _, name := range names {
			if includeNetworkInterface(name, includeFilters, excludeFilters) {
				selected[name] = true
			}
		}
		return selected
	}

	candidates := make([]string, 0, len(names))
	for _, name := range names {
		if isDefaultExcludedNetworkInterface(name) {
			continue
		}
		candidates = append(candidates, name)
	}

	if len(defaultRouteNames) > 0 {
		routeSet := make(map[string]bool, len(defaultRouteNames))
		for _, name := range defaultRouteNames {
			if trimmed := strings.ToLower(strings.TrimSpace(name)); trimmed != "" {
				routeSet[trimmed] = true
			}
		}
		preferred := make([]string, 0, len(candidates))
		for _, name := range candidates {
			if routeSet[strings.ToLower(name)] {
				preferred = append(preferred, name)
			}
		}
		if len(preferred) > 0 {
			candidates = preferred
		}
	}

	for _, name := range candidates {
		if interfaceMatchesFilter(name, excludeFilters) {
			continue
		}
		selected[name] = true
	}
	return selected
}

// parseIPv4DefaultRouteInterfaces 从 /proc/net/route 的内容里取出承载默认路由的网卡名。
// 字段序：Iface Destination Gateway Flags RefCnt Use Metric Mask ...
// 默认路由即目标与掩码都是 0.0.0.0。
func parseIPv4DefaultRouteInterfaces(data string) []string {
	var names []string
	for index, line := range strings.Split(data, "\n") {
		if index == 0 {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 8 {
			continue
		}
		if !isZeroHexField(fields[1]) || !isZeroHexField(fields[7]) {
			continue
		}
		names = appendUniqueInterfaceName(names, fields[0])
	}
	return names
}

// parseIPv6DefaultRouteInterfaces 从 /proc/net/ipv6_route 的内容里取出承载默认路由的网卡名。
// 字段序：dest dest_prefixlen src src_prefixlen next_hop metric refcnt use flags dev
// 默认路由即目标地址全零且前缀长度为 0。
func parseIPv6DefaultRouteInterfaces(data string) []string {
	var names []string
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		if !isZeroHexField(fields[0]) || !isZeroHexField(fields[1]) {
			continue
		}
		names = appendUniqueInterfaceName(names, fields[9])
	}
	return names
}

func isZeroHexField(field string) bool {
	if field == "" {
		return false
	}
	return strings.Trim(field, "0") == ""
}

func appendUniqueInterfaceName(names []string, candidate string) []string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" || strings.EqualFold(candidate, "lo") {
		return names
	}
	for _, existing := range names {
		if strings.EqualFold(existing, candidate) {
			return names
		}
	}
	return append(names, candidate)
}

func procDefaultRouteInterfaces(root string) []string {
	names := []string{}
	if data, err := os.ReadFile(filepath.Join(root, "net", "route")); err == nil {
		for _, name := range parseIPv4DefaultRouteInterfaces(string(data)) {
			names = appendUniqueInterfaceName(names, name)
		}
	}
	if data, err := os.ReadFile(filepath.Join(root, "net", "ipv6_route")); err == nil {
		for _, name := range parseIPv6DefaultRouteInterfaces(string(data)) {
			names = appendUniqueInterfaceName(names, name)
		}
	}
	return names
}

// outboundRouteInterfaces 是非 Linux 平台的默认路由探测：向公网地址建一个 UDP
// “连接”（不发包）拿到内核选出的源地址，再反查这个地址属于哪块网卡。
func outboundRouteInterfaces() []string {
	names := []string{}
	for _, probe := range []struct{ network, address string }{
		{"udp4", "8.8.8.8:53"},
		{"udp6", "[2001:4860:4860::8888]:53"},
	} {
		ip := outboundIP(probe.network, probe.address)
		if ip == "" {
			continue
		}
		if name := interfaceNameForIP(ip); name != "" {
			names = appendUniqueInterfaceName(names, name)
		}
	}
	return names
}

func interfaceNameForIP(target string) string {
	parsed := net.ParseIP(target)
	if parsed == nil {
		return ""
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range interfaces {
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
			if ip != nil && ip.Equal(parsed) {
				return iface.Name
			}
		}
	}
	return ""
}

const defaultRouteInterfaceCacheTTL = time.Minute

var (
	defaultRouteInterfaceMu     sync.Mutex
	defaultRouteInterfaceCache  []string
	defaultRouteInterfaceStamp  time.Time
	trafficInterfaceSelectionMu sync.Mutex
	trafficInterfaceSelectionID string
)

// cachedDefaultRouteInterfaces 缓存默认路由网卡，避免每个采样周期都读 /proc 或建探测连接。
// 路由变化（切线路、隧道起落）最迟一分钟后被采纳。
func cachedDefaultRouteInterfaces() []string {
	defaultRouteInterfaceMu.Lock()
	defer defaultRouteInterfaceMu.Unlock()

	if !defaultRouteInterfaceStamp.IsZero() && time.Since(defaultRouteInterfaceStamp) < defaultRouteInterfaceCacheTTL {
		return defaultRouteInterfaceCache
	}

	names := []string{}
	if runtime.GOOS == "linux" {
		names = procDefaultRouteInterfaces("/proc")
	}
	if len(names) == 0 {
		names = outboundRouteInterfaces()
	}

	defaultRouteInterfaceCache = names
	defaultRouteInterfaceStamp = time.Now()
	return names
}

// trafficInterfaceSelection 算出本轮采样参与统计的网卡集合，并在集合变化时打一条日志。
// 「面板上的流量到底算了哪些网卡」是排查口径问题的第一个问题，日志里必须能查到。
func trafficInterfaceSelection(counters []gnet.IOCountersStat) map[string]bool {
	names := make([]string, 0, len(counters))
	for _, counter := range counters {
		names = append(names, counter.Name)
	}
	selected := selectTrafficInterfaces(names, nicInclude, nicExclude, cachedDefaultRouteInterfaces())

	sorted := make([]string, 0, len(selected))
	for name := range selected {
		sorted = append(sorted, name)
	}
	sort.Strings(sorted)
	fingerprint := strings.Join(sorted, ",")

	trafficInterfaceSelectionMu.Lock()
	changed := fingerprint != trafficInterfaceSelectionID
	trafficInterfaceSelectionID = fingerprint
	trafficInterfaceSelectionMu.Unlock()

	if changed {
		if fingerprint == "" {
			log.Printf("traffic interfaces: none matched (check --nic-include/--nic-exclude)")
		} else {
			log.Printf("traffic interfaces: %s", fingerprint)
		}
	}
	return selected
}

func sumNetworkCounters(counters []gnet.IOCountersStat, selected map[string]bool) (int64, int64) {
	var sent, received int64
	for _, counter := range counters {
		if !selected[counter.Name] {
			continue
		}
		sent += int64(counter.BytesSent)
		received += int64(counter.BytesRecv)
	}
	return sent, received
}

// collectPerInterfaceCounters 按接口名返回参与统计的网卡累计计数。
// 速率计算需要它来做「按接口独立基线」，避免接口集合变化时把某块网卡的
// 历史累计流量误算成一个采样周期内的增量。
func collectPerInterfaceCounters(counters []gnet.IOCountersStat, selected map[string]bool) map[string]interfaceCounters {
	perInterface := make(map[string]interfaceCounters, len(counters))
	for _, counter := range counters {
		if !selected[counter.Name] {
			continue
		}
		perInterface[counter.Name] = interfaceCounters{
			sent: counter.BytesSent,
			recv: counter.BytesRecv,
		}
	}
	return perInterface
}

// networkDelta 计算两次采样之间的收发增量，按接口独立处理：
//   - 只累加「两次采样中都存在」的接口的增量；
//   - 新出现的接口本轮只建基线、计 0，其历史累计流量不会被算成本周期增量；
//   - 单个接口计数器回绕或重置（新值小于旧值）时只重建该接口基线，
//     不影响同一轮里其他接口的正常增量。
func networkDelta(previous, current map[string]interfaceCounters) (int64, int64) {
	var up, down int64
	for name, now := range current {
		last, existed := previous[name]
		if !existed {
			continue
		}
		if now.sent >= last.sent {
			up += int64(now.sent - last.sent)
		}
		if now.recv >= last.recv {
			down += int64(now.recv - last.recv)
		}
	}
	return up, down
}

// ===== 负载可信度判定 =====
//
// LXC 容器上 lxcfs 若没开 lxcfs.loadavg=1，/proc/loadavg 会**直接透传宿主机数值**。
// test2-LXC 实测：1 核容器上报负载 9.29，而容器内 CPU 只有 26%、进程数 17，
// loadavg 的任务总数却是 9500——这个数字只可能来自宿主机。
// 后果是任何「负载 > N」的告警规则在这类容器上长期处于触发态。
//
// 判定只在**容器里**做，物理机 / KVM 一律直接信任 /proc/loadavg，
// 从结构上保证非容器环境零回归。

// 任务总数超过本机可见线程数这么多倍，且绝对差额也够大，才判为宿主机穿透。
// 用线程数而不是进程数比较：容器内跑多线程应用（17 进程 500 线程）时，
// 拿进程数做分母会把正常值误判成穿透。
const loadAverageTaskRatioLimit = 4
const loadAverageTaskAbsoluteGap = 100
const loadAverageTrustCacheTTL = 5 * time.Minute

var (
	loadAverageTrustMu     sync.Mutex
	loadAverageTrustValue  = true
	loadAverageTrustStamp  time.Time
	loadAverageTrustLogged bool
)

// containerRuntimeName 检测容器环境，返回运行时名称，空字符串表示不是容器。
// 只用世界可读的信号：agent 以非 root 用户运行，/proc/1/environ 读不到。
func containerRuntimeName(root string) string {
	if data, err := os.ReadFile(filepath.Join(root, "run", "systemd", "container")); err == nil {
		if name := strings.TrimSpace(string(data)); name != "" {
			return name
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".dockerenv")); err == nil {
		return "docker"
	}
	if _, err := os.Stat(filepath.Join(root, "run", ".containerenv")); err == nil {
		return "podman"
	}
	if data, err := os.ReadFile(filepath.Join(root, "proc", "mounts")); err == nil {
		if strings.Contains(string(data), "lxcfs") {
			return "lxc"
		}
	}
	if data, err := os.ReadFile(filepath.Join(root, "proc", "1", "cgroup")); err == nil {
		content := string(data)
		for _, marker := range []string{"/docker/", "/lxc/", "/kubepods", "/podman"} {
			if strings.Contains(content, marker) {
				return strings.Trim(marker, "/")
			}
		}
	}
	return ""
}

// parseLoadAverageTaskTotal 取 /proc/loadavg 第四字段 running/total 里的 total。
func parseLoadAverageTaskTotal(line string) int {
	fields := strings.Fields(line)
	if len(fields) < 4 {
		return 0
	}
	parts := strings.SplitN(fields[3], "/", 2)
	if len(parts) != 2 {
		return 0
	}
	total, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || total < 0 {
		return 0
	}
	return total
}

// countVisibleThreads 统计本 PID 命名空间里可见的线程数（/proc/<pid>/task 的条目数）。
func countVisibleThreads(root string) int {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	total := 0
	for _, entry := range entries {
		if _, err := strconv.ParseInt(entry.Name(), 10, 64); err != nil {
			continue
		}
		tasks, err := os.ReadDir(filepath.Join(root, entry.Name(), "task"))
		if err != nil {
			// 进程可能在扫描过程中退出；至少按一个线程计。
			total++
			continue
		}
		total += len(tasks)
	}
	return total
}

// loadAverageTrustworthy 判断 /proc/loadavg 是否反映本机（而非宿主机）。
func loadAverageTrustworthy(taskTotal int, visibleThreads int, inContainer bool) bool {
	if !inContainer {
		return true
	}
	// 数据不足时按可信处理：宁可保留一个可能不准的值，也不要凭猜测把好节点的负载抹掉。
	if taskTotal <= 0 || visibleThreads <= 0 {
		return true
	}
	if taskTotal <= visibleThreads*loadAverageTaskRatioLimit {
		return true
	}
	return taskTotal-visibleThreads <= loadAverageTaskAbsoluteGap
}

func evaluateLoadAverageTrust(root string) (bool, string) {
	runtimeName := containerRuntimeName(root)
	if runtimeName == "" {
		return true, ""
	}
	data, err := os.ReadFile(filepath.Join(root, "proc", "loadavg"))
	if err != nil {
		return true, runtimeName
	}
	taskTotal := parseLoadAverageTaskTotal(string(data))
	visibleThreads := countVisibleThreads(filepath.Join(root, "proc"))
	if loadAverageTrustworthy(taskTotal, visibleThreads, true) {
		return true, runtimeName
	}
	return false, fmt.Sprintf("%s container, loadavg reports %d tasks but only %d threads are visible here",
		runtimeName, taskTotal, visibleThreads)
}

// loadAverageReportable 决定本轮是否上报负载。判定结果缓存，避免每个采样周期都扫 /proc。
func loadAverageReportable() bool {
	if runtime.GOOS != "linux" {
		return true
	}

	loadAverageTrustMu.Lock()
	defer loadAverageTrustMu.Unlock()

	if !loadAverageTrustStamp.IsZero() && time.Since(loadAverageTrustStamp) < loadAverageTrustCacheTTL {
		return loadAverageTrustValue
	}

	trusted, detail := evaluateLoadAverageTrust("/")
	loadAverageTrustValue = trusted
	loadAverageTrustStamp = time.Now()
	if !trusted && !loadAverageTrustLogged {
		loadAverageTrustLogged = true
		log.Printf("load average is not container-local (%s); reporting load as unavailable", detail)
	}
	if trusted {
		loadAverageTrustLogged = false
	}
	return trusted
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

type trafficInterfaceState struct {
	Sent uint64 `json:"sent"`
	Recv uint64 `json:"recv"`
}

type trafficResetState struct {
	ResetDay          int                              `json:"reset_day"`
	Period            string                           `json:"period"`
	Scope             string                           `json:"scope"`
	LastRawUp         int64                            `json:"last_raw_up"`
	LastRawDown       int64                            `json:"last_raw_down"`
	PeriodUp          int64                            `json:"period_up"`
	PeriodDown        int64                            `json:"period_down"`
	BaselineUp        int64                            `json:"baseline_up,omitempty"`
	BaselineDown      int64                            `json:"baseline_down,omitempty"`
	LastBootUnix      int64                            `json:"last_boot_unix,omitempty"`
	CounterVersion    int                              `json:"counter_version,omitempty"`
	Interfaces        map[string]trafficInterfaceState `json:"interfaces,omitempty"`
	ResetDaySource    string                           `json:"reset_day_source,omitempty"`
	PolicyResetDay    *int                             `json:"policy_reset_day,omitempty"`
	Revision          uint64                           `json:"revision,omitempty"`
	HistoryIncomplete bool                             `json:"history_incomplete,omitempty"`
}

type trafficResetTracker struct {
	mu             sync.Mutex
	resetDay       int
	scope          string
	statePath      string
	state          trafficResetState
	loaded         bool
	resetDaySource string
	policyResetDay *int
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
	tracker := &trafficResetTracker{
		resetDay:       normalizeTrafficResetDay(resetDay),
		scope:          scope,
		statePath:      trafficResetStatePath(token),
		resetDaySource: "local",
	}
	tracker.load()
	tracker.loaded = true
	if day := tracker.state.PolicyResetDay; day != nil && *day >= 1 && *day <= 31 {
		tracker.resetDay, tracker.policyResetDay, tracker.resetDaySource = *day, intPtr(*day), "server"
	} else if tracker.state.ResetDay >= 1 && tracker.state.ResetDay <= 31 && tracker.state.Period != "" && tracker.state.ResetDaySource != "local" {
		// Legacy state did not record policy origin. Preserve its valid effective cycle until a fresh policy arrives.
		tracker.resetDay, tracker.resetDaySource = tracker.state.ResetDay, "restored"
	}
	return tracker
}

// setResetDay 更新重置日。改动会让下一次 adjust 因 period key 变化而走重建分支，
// 当期累计从此刻重新起算——这是设计意图（周期定义变了，旧累计无法换算），
// 所以后台表单上必须提示用户。
func (t *trafficResetTracker) setResetDay(day int) bool {
	if t == nil {
		return false
	}
	day = normalizeTrafficResetDay(day)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.resetDay == day {
		return false
	}
	t.resetDay = day
	t.resetDaySource = "local"
	t.policyResetDay = nil
	return true
}

func (t *trafficResetTracker) setPolicyResetDay(day int) bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	changed := t.resetDay != day
	known := t.policyResetDay != nil && *t.policyResetDay == day
	t.resetDay = day
	t.resetDaySource = "server"
	t.policyResetDay = intPtr(day)
	if !known {
		// Keep period counters intact until adjust applies an intentional cycle change.
		t.state.PolicyResetDay = intPtr(day)
		t.state.ResetDaySource = "server"
		t.save()
	}
	return changed
}

// applyTrafficResetDayPolicy 应用后台下发的流量重置日。
// 优先级：policy > --traffic-reset-day > 环境变量 > 默认 1。
// 非法值一律忽略而不是钳到边界：服务端已校验 1~31，能到这里的越界值只可能是异常，
// 钳成 1 会把用户的配置悄悄改掉。
func applyTrafficResetDayPolicy(policy agentPolicy) {
	if policy.TrafficResetDay == nil {
		return
	}
	day := *policy.TrafficResetDay
	if day < 1 || day > 31 {
		return
	}
	previous := trafficResetDay
	trafficResetDay = day
	if trafficTracker.setPolicyResetDay(day) {
		log.Printf("traffic reset day updated by server policy: %d -> %d (current period restarts)", previous, day)
	}
}

func trafficCounterScope() string {
	// 统计口径的版本号。scope 一变，adjust 会走「重建」分支重新起基线；
	// 不变则旧的 traffic-state.json 基线继续有效。
	//
	// 因此**只要参与统计的网卡集合的算法变了，这里就必须跟着变**——
	// 不只是用户传的 --nic-include/--nic-exclude。v2 收敛到默认路由网卡、
	// 并把 wg/tun/ipip/warp 等隧道前缀加进内置排除表，raw 计数因此骤降；
	// 若沿用 v1 的 scope，旧基线会被当成有效值，负 delta 被当作计数器回绕处理，
	// 把整个物理网卡计数器再加一遍到当期累计上（一次性虚增）。
	const counterBasisVersion = "v2-default-route"
	return shortHash(counterBasisVersion + "\n" + strings.TrimSpace(nicInclude) + "\n" + strings.TrimSpace(nicExclude))
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
	// An empty interface name represents the original single-counter API.
	return t.adjustInterfacesSinceBoot(map[string]interfaceCounters{
		"": {sent: uint64(maxInt64(0, rawUp)), recv: uint64(maxInt64(0, rawDown))},
	}, now, bootedAt)
}

func (t *trafficResetTracker) adjustInterfaces(current map[string]interfaceCounters, now time.Time) (int64, int64) {
	return t.adjustInterfacesSinceBoot(current, now, trafficBootTime(now))
}

func trafficCounterDelta(previous, current uint64) int64 {
	if current < previous {
		return int64(current)
	}
	return int64(current - previous)
}

func (t *trafficResetTracker) adjustInterfacesSinceBoot(current map[string]interfaceCounters, now time.Time, bootedAt time.Time) (int64, int64) {
	var rawUp, rawDown int64
	snapshot := make(map[string]trafficInterfaceState, len(current))
	for name, counter := range current {
		rawUp += int64(counter.sent)
		rawDown += int64(counter.recv)
		snapshot[name] = trafficInterfaceState{Sent: counter.sent, Recv: counter.recv}
	}
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
	bootChanged := bootUnix != 0 && t.state.LastBootUnix != 0 && t.state.LastBootUnix != bootUnix
	if t.state.ResetDay != t.resetDay || t.state.Period == "" || t.state.Scope != t.scope {
		t.state = trafficResetState{ResetDay: t.resetDay, Period: period, Scope: t.scope, Revision: t.state.Revision, HistoryIncomplete: t.state.HistoryIncomplete}
		if rawCoversPeriod {
			t.state.PeriodUp, t.state.PeriodDown = rawUp, rawDown
		}
		log.Printf("traffic tracker initialized for period %s", period)
	} else {
		previous := t.state.Interfaces
		migratedTotals := false
		if t.state.CounterVersion == 0 {
			switch {
			case t.state.Period == period && t.state.LastRawUp == 0 && t.state.LastRawDown == 0 &&
				(t.state.BaselineUp != 0 || t.state.BaselineDown != 0):
				t.state.PeriodUp = maxInt64(0, rawUp-t.state.BaselineUp)
				t.state.PeriodDown = maxInt64(0, rawDown-t.state.BaselineDown)
				migratedTotals = true
			case t.state.Period == period && rawCoversPeriod && t.state.PeriodUp == 0 && t.state.PeriodDown == 0:
				// Repair the historical zero-install baseline only during old-format migration.
				t.state.PeriodUp, t.state.PeriodDown = rawUp, rawDown
				migratedTotals = true
			default:
				if _, singleCounter := current[""]; singleCounter {
					previous = map[string]trafficInterfaceState{"": {
						Sent: uint64(maxInt64(0, t.state.LastRawUp)), Recv: uint64(maxInt64(0, t.state.LastRawDown)),
					}}
				}
			}
			log.Printf("traffic state migrated to per-interface counters; prior period totals retained")
		}
		var deltaUp, deltaDown int64
		if !migratedTotals {
			for name, counter := range snapshot {
				if prior, exists := previous[name]; exists {
					deltaUp += trafficCounterDelta(prior.Sent, counter.Sent)
					deltaDown += trafficCounterDelta(prior.Recv, counter.Recv)
				}
			}
		}
		if bootChanged && rawCoversPeriod {
			deltaUp, deltaDown = rawUp, rawDown
		}
		if t.state.Period != period {
			if rawCoversPeriod {
				deltaUp, deltaDown = rawUp, rawDown
			}
			t.state.Period = period
			t.state.HistoryIncomplete = false
			t.state.PeriodUp, t.state.PeriodDown = deltaUp, deltaDown
			log.Printf("traffic period rotated to %s", period)
		} else {
			t.state.PeriodUp += deltaUp
			t.state.PeriodDown += deltaDown
		}
	}
	t.state.ResetDay = t.resetDay
	t.state.Scope = t.scope
	t.state.LastRawUp, t.state.LastRawDown = rawUp, rawDown
	t.state.BaselineUp, t.state.BaselineDown = 0, 0
	if bootUnix != 0 {
		t.state.LastBootUnix = bootUnix
	}
	t.state.CounterVersion = 1
	t.state.Interfaces = snapshot
	t.state.ResetDaySource = t.resetDaySource
	t.state.PolicyResetDay = t.policyResetDay
	t.save()
	return t.state.PeriodUp, t.state.PeriodDown
}

func (t *trafficResetTracker) load() {
	if t.statePath == "" {
		return
	}
	state, _, recoveredFrom, err := readTrafficResetState(t.statePath)
	if err != nil {
		var corruption *trafficStateCorruption
		if errors.As(err, &corruption) {
			t.state.HistoryIncomplete = true
			log.Printf("traffic history is incomplete; corrupt generations will be retained while new accumulation resumes")
		}
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("traffic reset state recovery failed; existing files retained: %v", err)
		}
		return
	}
	if recoveredFrom != t.statePath {
		log.Printf("traffic reset state recovered from %s", filepath.Base(recoveredFrom))
	}
	t.state = state
}

func (t *trafficResetTracker) save() {
	if t.statePath == "" {
		return
	}
	t.state.Revision++
	if err := writeTrafficResetState(t.statePath, t.state, replaceTrafficStateFile); err != nil {
		log.Printf("traffic reset state save failed; recovery generations retained: %v", err)
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
	if loadInfo, err := load.Avg(); err == nil && loadAverageReportable() {
		value := loadInfo.Load1
		r.Load = &value
	}
	r.Temp = nodeMetrics.temperature(context.Background())
	diskSnapshot := nodeMetrics.diskSnapshot(mountInclude, mountExclude)
	r.Disk, r.DiskTotal = diskSnapshot.used, diskSnapshot.total
	r.DiskSource, r.DiskSampledAt = diskSnapshot.source, diskSnapshot.sampledAt
	if netIO, err := gnet.IOCounters(true); err == nil && len(netIO) > 0 {
		// 只算一次网卡集合，累计流量与实时速率共用，避免两个数字用不同口径。
		selected := trafficInterfaceSelection(netIO)
		rawUp, rawDown := sumNetworkCounters(netIO, selected)
		r.hasRawNetTotals = true
		r.rawNetTotalUp = rawUp
		r.rawNetTotalDown = rawDown
		r.netPerInterface = collectPerInterfaceCounters(netIO, selected)
		if trafficTracker != nil {
			r.NetTotalUp, r.NetTotalDown = trafficTracker.adjustInterfaces(r.netPerInterface, now)
		} else {
			r.NetTotalUp, r.NetTotalDown = rawUp, rawDown
		}
	}
	r.ProcessCount = processCount()
	r.Connections, r.ConnectionsUdp = connectionsCount()
	r.Uptime = nodeMetrics.uptime()

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
	collect := p.collect
	if collect == nil {
		collect = collectReportWithInterval
	}
	report := collect(intervalSec)
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

func prepareReportsWithPing(preparer *reportPreparer, pingState *pingReportState, interval time.Duration) []Report {
	retry := pingState.takeRetryReports()
	first := prepareReportWithPing(preparer, pingState, interval)
	return append(retry, pingState.appendPendingReports(first)...)
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
		p.lastNetPerInterface = report.netPerInterface
		p.lastTimestampMs = report.Timestamp
		p.ready = true
		return report
	}
	if p.lastNetCountersRaw != report.hasRawNetTotals {
		p.lastNetUp = speedTotalUp
		p.lastNetDown = speedTotalDown
		p.lastNetCountersRaw = report.hasRawNetTotals
		p.lastNetPerInterface = report.netPerInterface
		p.lastTimestampMs = report.Timestamp
		return report
	}

	var upDelta, downDelta int64
	if report.netPerInterface != nil && p.lastNetPerInterface != nil {
		// 按接口独立基线：只累加两次采样都存在的接口的增量。
		// 新接口（隧道/VPN 起来）本轮只建基线，其历史累计流量不会被算成本周期增量。
		upDelta, downDelta = networkDelta(p.lastNetPerInterface, report.netPerInterface)
	} else {
		// 拿不到分接口数据时退回汇总差值，并保留原有的负值钳位。
		upDelta = speedTotalUp - p.lastNetUp
		downDelta = speedTotalDown - p.lastNetDown
		if upDelta < 0 {
			upDelta = 0
		}
		if downDelta < 0 {
			downDelta = 0
		}
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
	p.lastNetPerInterface = report.netPerInterface
	p.lastTimestampMs = report.Timestamp

	return report
}

func (p *reportPreparer) attachBasicInfoIfDue(report *Report, now time.Time) {
	if p == nil || report == nil {
		return
	}
	p.basicInfoMu.Lock()
	defer p.basicInfoMu.Unlock()
	if p.lastBasicInfoAt.IsZero() || now.Sub(p.lastBasicInfoAt) >= basicInfoRefreshInterval {
		info := getBasicInfo()
		p.pendingBasicInfo = &info
		p.basicInfoRevision++
		p.lastBasicInfoAt = now
	}
	if p.pendingBasicInfo != nil {
		report.BasicInfo = p.pendingBasicInfo
		report.basicInfoOwner, report.basicInfoRevision = p, p.basicInfoRevision
	}
}

func sendHTTPReports(reports []Report) error {
	if len(reports) == 0 {
		return nil
	}
	if len(reports) > maxReportsPerEnvelope {
		return fmt.Errorf("report envelope exceeds %d reports", maxReportsPerEnvelope)
	}
	endpoint := serverURL + "/api/clients/report"
	payload := any(reports[0])
	if len(reports) > 1 {
		payload = map[string]any{"reports": reports}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := postJSONResponse(ctx, endpoint, payload, token)
	if err != nil {
		log.Printf("HTTP report failed: %v", err)
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return httpStatusError(resp)
	}
	var accepted struct{ Success bool }
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxHTTPErrorBodyBytes)).Decode(&accepted); err != nil {
		return fmt.Errorf("invalid report acknowledgement: %w", err)
	}
	if !accepted.Success {
		return errors.New("server did not accept the report")
	}
	if len(reports) == 1 {
		logReport("HTTP report accepted", reports[0])
	} else {
		log.Printf("HTTP report batch accepted: %d reports", len(reports))
	}
	return nil
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
	resp, err := postJSONResponse(ctx, endpoint, data, bearerToken)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return httpStatusError(resp)
	}
	return nil
}

func postJSONResponse(ctx context.Context, endpoint string, data interface{}, bearerToken string) (*http.Response, error) {
	body, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	return client.Do(req)
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

func readWebSocketMessages(conn *safeWebSocketConn, done chan<- error, policies chan<- serverMessage, acknowledgements ...chan<- struct{}) {
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
		if message.Type == "ack" || message.Type == "policy" {
			if err := conn.renewReadDeadline(); err != nil {
				done <- err
				return
			}
		}
		if message.Type == "ack" {
			log.Printf("WebSocket ack received: %d", message.Timestamp)
			if len(acknowledgements) > 0 {
				select {
				case acknowledgements[0] <- struct{}{}:
				default:
				}
			}
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
