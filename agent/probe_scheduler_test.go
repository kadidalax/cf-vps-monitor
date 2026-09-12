package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestAUD30EveryTaskFitsInBoundedResultReports(t *testing.T) {
	previousResolver, previousLog := resolvePublicIPsForPing, log.Writer()
	resolvePublicIPsForPing = func(context.Context, string) ([]net.IP, error) { return nil, errors.New("synthetic probe failure") }
	log.SetOutput(io.Discard)
	t.Cleanup(func() { resolvePublicIPsForPing = previousResolver; log.SetOutput(previousLog) })
	for _, count := range []int{50, 51, 100, 1000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			state := newPingReportState()
			t.Cleanup(func() {
				if closer, ok := any(state).(interface{ close() }); ok {
					closer.close()
				}
			})
			tasks := make([]PingTask, count)
			for index := range tasks {
				tasks[index] = PingTask{ID: index + 1, Type: "tcp", Target: "fixture.invalid:443", IntervalSec: 120}
			}
			state.applyPolicy(agentPolicy{PingTasks: tasks, PingIntervalSec: 120})
			seen := make(map[int]bool)
			deadline := time.Now().Add(5 * time.Second)
			for len(seen) < count && time.Now().Before(deadline) {
				report := Report{}
				state.appendDueResults(&report, time.Now())
				if len(report.PingResults) > 50 {
					t.Fatalf("report contains %d ping results; the receiver accepts at most 50", len(report.PingResults))
				}
				for _, result := range report.PingResults {
					if result.TaskID < 1 || result.TaskID > count || seen[result.TaskID] {
						t.Fatalf("unexpected/duplicate task %d", result.TaskID)
					}
					seen[result.TaskID] = true
				}
				if len(report.PingResults) == 0 {
					time.Sleep(time.Millisecond)
				}
			}
			if len(seen) != count {
				t.Fatalf("only %d of %d task results were delivered", len(seen), count)
			}
		})
	}
}

func quietProbeFixture(t *testing.T, count int) (*pingReportState, *atomic.Int32) {
	t.Helper()
	previousResolver, previousLog := resolvePublicIPsForPing, log.Writer()
	calls := &atomic.Int32{}
	resolvePublicIPsForPing = func(context.Context, string) ([]net.IP, error) {
		calls.Add(1)
		return nil, errors.New("synthetic probe failure")
	}
	log.SetOutput(io.Discard)
	t.Cleanup(func() { resolvePublicIPsForPing = previousResolver; log.SetOutput(previousLog) })
	state := newPingReportState()
	t.Cleanup(func() {
		if closer, ok := any(state).(interface{ close() }); ok {
			closer.close()
		}
	})
	tasks := make([]PingTask, count)
	for index := range tasks {
		tasks[index] = PingTask{ID: index + 1, Type: "tcp", Target: "fixture.invalid:443", IntervalSec: 120}
	}
	state.applyPolicy(agentPolicy{PingTasks: tasks, PingIntervalSec: 120})
	return state, calls
}

func completedProbeReports(t *testing.T, state *pingReportState, count int) []Report {
	t.Helper()
	var reports []Report
	collected := 0
	stamp := time.Now().UnixMilli()
	deadline := time.Now().Add(5 * time.Second)
	for collected < count && time.Now().Before(deadline) {
		first := Report{Timestamp: stamp, Version: "fixture", ReportInterval: 3}
		state.appendDueResults(&first, time.Now())
		for _, report := range state.appendPendingReports(first) {
			if len(report.PingResults) > 0 {
				reports = append(reports, report)
				collected += len(report.PingResults)
			}
		}
		if collected < count {
			time.Sleep(time.Millisecond)
		}
	}
	if collected != count {
		t.Fatalf("received %d of %d probe results", collected, count)
	}
	return reports
}

func decodeWireReports(raw []byte) ([]Report, error) {
	var envelope struct {
		Data    *Report  `json:"data"`
		Reports []Report `json:"reports"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if envelope.Reports != nil {
		return envelope.Reports, nil
	}
	if envelope.Data != nil {
		return []Report{*envelope.Data}, nil
	}
	var report Report
	if err := json.Unmarshal(raw, &report); err != nil {
		return nil, err
	}
	return []Report{report}, nil
}

func TestAUD30HTTPRetriesOriginalResultsAndTimestampUntilAccepted(t *testing.T) {
	for _, failure := range []string{"status", "negative", "invalid"} {
		t.Run(failure, func(t *testing.T) {
			state, calls := quietProbeFixture(t, 51)
			reports := completedProbeReports(t, state, 51)
			var mutex sync.Mutex
			var received []map[int]int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				raw, _ := io.ReadAll(request.Body)
				batch, err := decodeWireReports(raw)
				if err != nil {
					t.Error(err)
				}
				seen := make(map[int]int64)
				for _, report := range batch {
					if len(report.PingResults) > 50 {
						t.Errorf("oversize report: %d", len(report.PingResults))
					}
					for _, result := range report.PingResults {
						seen[result.TaskID] = report.Timestamp
					}
				}
				mutex.Lock()
				received = append(received, seen)
				attempt := len(received)
				mutex.Unlock()
				if attempt == 1 {
					switch failure {
					case "status":
						w.WriteHeader(503)
						_, _ = io.WriteString(w, `{"error":"retry"}`)
					case "negative":
						_, _ = io.WriteString(w, `{"success":false}`)
					case "invalid":
						_, _ = io.WriteString(w, `{`)
					}
					return
				}
				_, _ = io.WriteString(w, `{"success":true,"persisted":false,"queued":true}`)
			}))
			defer server.Close()
			oldURL, oldToken := serverURL, token
			serverURL, token = server.URL, "fixture-token"
			defer func() { serverURL, token = oldURL, oldToken }()
			if err := deliverHTTPReports(state, reports); err == nil {
				t.Fatal("unsuccessful response released results")
			}
			state.mu.Lock()
			retained := len(state.pendingPing)
			state.mu.Unlock()
			if retained != 51 {
				t.Fatalf("only %d results retained", retained)
			}
			retry := state.takeRetryReports()
			if err := deliverHTTPReports(state, retry); err != nil {
				t.Fatal(err)
			}
			state.mu.Lock()
			remaining := len(state.pendingPing)
			state.mu.Unlock()
			if remaining != 0 {
				t.Fatalf("ACK did not release %d results", remaining)
			}
			mutex.Lock()
			snapshots := append([]map[int]int64(nil), received...)
			mutex.Unlock()
			if len(snapshots) != 2 || len(snapshots[0]) != 51 || !reflect.DeepEqual(snapshots[0], snapshots[1]) {
				t.Fatalf("retry changed results or observation times: %#v", snapshots)
			}
			if calls.Load() != 51 {
				t.Fatalf("retry re-executed probes: %d calls", calls.Load())
			}
		})
	}
}

func TestAUD30OldAcknowledgementCannotReleaseNewPolicyResults(t *testing.T) {
	state, _ := quietProbeFixture(t, 1)
	old := completedProbeReports(t, state, 1)
	state.applyPolicy(agentPolicy{PingTasks: []PingTask{{ID: 1, Type: "tcp", Target: "changed.invalid:443", IntervalSec: 120}}})
	newer := completedProbeReports(t, state, 1)
	state.acknowledgeReports(old)
	state.mu.Lock()
	pending := len(state.pendingPing)
	state.mu.Unlock()
	if pending != 1 {
		t.Fatal("old acknowledgement released a different probe generation")
	}
	state.acknowledgeReports(newer)
}

func TestAUD30WebSocketWaitsForAckAndRetriesAfterDisconnect(t *testing.T) {
	state, calls := quietProbeFixture(t, 1)
	events := make(chan Report, 4)
	decisions := make(chan bool, 4)
	stop := make(chan struct{})
	var stopOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(w, request, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		for {
			_, raw, err := peer.ReadMessage()
			if err != nil {
				return
			}
			reports, err := decodeWireReports(raw)
			if err != nil {
				t.Error(err)
				return
			}
			var measured *Report
			for index := range reports {
				if len(reports[index].PingResults) > 0 {
					measured = &reports[index]
					break
				}
			}
			if measured != nil {
				select {
				case events <- *measured:
				case <-stop:
					return
				}
				select {
				case acknowledge := <-decisions:
					if !acknowledge {
						return
					}
				case <-stop:
					return
				}
			}
			if err := peer.WriteJSON(serverMessage{Type: "ack", Timestamp: time.Now().UnixMilli()}); err != nil {
				return
			}
		}
	}))
	var connections []*safeWebSocketConn
	var sessions []chan error
	t.Cleanup(func() {
		stopOnce.Do(func() { close(stop) })
		for _, conn := range connections {
			conn.Close()
		}
		for _, done := range sessions {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("session did not stop")
			}
		}
		server.Close()
	})
	start := func() (*safeWebSocketConn, chan error) {
		endpoint, err := webSocketEndpoint(server.URL, "fixture")
		if err != nil {
			t.Fatal(err)
		}
		conn, err := connectWebSocket(endpoint, "fixture")
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, conn)
		done := make(chan error, 1)
		sessions = append(sessions, done)
		preparer := &reportPreparer{lastBasicInfoAt: time.Now(), collect: func(interval int) Report {
			return Report{Timestamp: time.Now().UnixMilli(), ReportInterval: interval, Version: "fixture"}
		}}
		go func() { done <- runWebSocketSession(conn, preparer, state, 3*time.Second, time.Second); close(done) }()
		return conn, done
	}
	_, firstDone := start()
	var first Report
	select {
	case first = <-events:
	case <-time.After(6 * time.Second):
		t.Fatal("first probe report missing")
	}
	state.mu.Lock()
	pending := len(state.pendingPing)
	state.mu.Unlock()
	if pending != 1 {
		t.Fatal("successful socket write released result before ACK")
	}
	decisions <- false
	select {
	case <-firstDone:
	case <-time.After(3 * time.Second):
		t.Fatal("closed session did not return")
	}
	_, _ = start()
	var retried Report
	select {
	case retried = <-events:
	case <-time.After(6 * time.Second):
		t.Fatal("reconnected session lost result")
	}
	if !reflect.DeepEqual(first.PingResults, retried.PingResults) || first.Timestamp != retried.Timestamp {
		t.Fatalf("retry changed original probe sample: %#v => %#v", first, retried)
	}
	if calls.Load() != 1 {
		t.Fatalf("retry re-executed probe %d times", calls.Load())
	}
	decisions <- true
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		state.mu.Lock()
		pending = len(state.pendingPing)
		state.mu.Unlock()
		if pending == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("received ACK did not release result")
}

func TestAUD23SlowProbesDoNotBlockReportsAndUseBoundedConcurrency(t *testing.T) {
	previousResolver, previousLog := resolvePublicIPsForPing, log.Writer()
	var active, maximum atomic.Int32
	resolvePublicIPsForPing = func(context.Context, string) ([]net.IP, error) {
		count := active.Add(1)
		for prior := maximum.Load(); count > prior && !maximum.CompareAndSwap(prior, count); prior = maximum.Load() {
		}
		defer active.Add(-1)
		time.Sleep(50 * time.Millisecond)
		return nil, context.DeadlineExceeded
	}
	log.SetOutput(io.Discard)
	t.Cleanup(func() { resolvePublicIPsForPing = previousResolver; log.SetOutput(previousLog) })
	state := newPingReportState()
	t.Cleanup(func() {
		if closer, ok := any(state).(interface{ close() }); ok {
			closer.close()
		}
	})
	tasks := make([]WebsiteProbeTask, 20)
	for index := range tasks {
		tasks[index] = WebsiteProbeTask{ID: index + 1, URL: "tcp://fixture.invalid:443", Method: "TCP", TimeoutSec: 30, IntervalSec: 120}
	}
	state.applyPolicy(agentPolicy{WebsiteProbeTasks: tasks})
	first := Report{}
	started := time.Now()
	state.appendDueResults(&first, time.Now())
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("report waited for probe batch: %s", elapsed)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		state.mu.Lock()
		count := len(state.pendingWebsites)
		state.mu.Unlock()
		if count == 20 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d probes completed", count)
		}
		time.Sleep(time.Millisecond)
	}
	if max := maximum.Load(); max < 2 || max > 4 {
		t.Fatalf("probe concurrency = %d, want 2..4", max)
	}
	last := Report{}
	state.appendDueResults(&last, time.Now())
	if len(first.WebsiteProbeResults)+len(last.WebsiteProbeResults) != 20 {
		t.Fatal("completed website results were lost")
	}
}

func TestAUD23TCPWebsiteBudgetIncludesDNS(t *testing.T) {
	previous := resolvePublicIPsForPing
	t.Cleanup(func() { resolvePublicIPsForPing = previous })
	for _, timeout := range []int{1, 30} {
		t.Run(fmt.Sprint(timeout), func(t *testing.T) {
			var budget time.Duration
			hasDeadline := false
			resolvePublicIPsForPing = func(ctx context.Context, _ string) ([]net.IP, error) {
				deadline, ok := ctx.Deadline()
				hasDeadline = ok
				budget = time.Until(deadline)
				return nil, context.DeadlineExceeded
			}
			executeWebsiteTCPProbe(WebsiteProbeTask{ID: 1, URL: "tcp://fixture.invalid:443", Method: "TCP", TimeoutSec: timeout})
			want := time.Duration(timeout) * time.Second
			if !hasDeadline || budget <= want-150*time.Millisecond || budget > want {
				t.Fatalf("DNS deadline budget = %s (present=%v), want %s", budget, hasDeadline, want)
			}
		})
	}
}

func TestAUD23HTTPBodyTimeoutIsAProbeFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Length", "10")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-request.Context().Done():
		case <-time.After(time.Second):
			_, _ = io.WriteString(w, "0123456789")
		}
	}))
	defer server.Close()
	client := server.Client()
	client.Timeout = 150 * time.Millisecond
	result := executeWebsiteHTTPProbeWithClient(WebsiteProbeTask{ID: 1, URL: server.URL, Method: "GET", TimeoutSec: 1}, client)
	if result.OK || result.EffectiveReason != "timeout" {
		t.Fatalf("timed-out body reported as successful/reachable: %+v", result)
	}
}

func TestAUD23DNSActuallyStopsAtWebsiteTimeout(t *testing.T) {
	previous := resolvePublicIPsForPing
	t.Cleanup(func() { resolvePublicIPsForPing = previous })
	resolvePublicIPsForPing = func(ctx context.Context, _ string) ([]net.IP, error) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(1500 * time.Millisecond):
			return nil, errors.New("resolver remained unbounded")
		}
	}
	started := time.Now()
	result := executeWebsiteTCPProbe(WebsiteProbeTask{ID: 1, URL: "tcp://fixture.invalid:443", Method: "TCP", TimeoutSec: 1})
	if elapsed := time.Since(started); elapsed > 1300*time.Millisecond {
		t.Fatalf("one-second total probe budget took %s", elapsed)
	}
	if result.OK || result.EffectiveReason != "timeout" {
		t.Fatalf("unexpected timeout result: %+v", result)
	}
}

func TestAUD23CommandCancellationStopsActualChild(t *testing.T) {
	if os.Getenv("CF_AUD23_COMMAND_CHILD") == "1" {
		time.Sleep(5 * time.Second)
		return
	}
	t.Setenv("CF_AUD23_COMMAND_CHILD", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := runBoundedCommand(ctx, 3*time.Second, os.Args[0], "-test.run=^TestAUD23CommandCancellationStopsActualChild$")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("child was not cancelled: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 700*time.Millisecond {
		t.Fatalf("cancelled child still blocked caller: %s", elapsed)
	}
}

func TestAUD23PolicyChangeCancelsOldProbeBeforeStartingReplacement(t *testing.T) {
	previous := resolvePublicIPsForPing
	oldStarted, oldStopped, newStarted := make(chan struct{}), make(chan struct{}), make(chan struct{})
	newRelease := make(chan struct{})
	var overlap atomic.Bool
	resolvePublicIPsForPing = func(ctx context.Context, host string) ([]net.IP, error) {
		if host == "old.invalid" {
			close(oldStarted)
			<-ctx.Done()
			close(oldStopped)
			return nil, ctx.Err()
		}
		select {
		case <-oldStopped:
		default:
			overlap.Store(true)
		}
		close(newStarted)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-newRelease:
			return nil, errors.New("synthetic new result")
		}
	}
	t.Cleanup(func() { resolvePublicIPsForPing = previous })
	state := newPingReportState()
	t.Cleanup(state.close)
	state.applyPolicy(agentPolicy{PingTasks: []PingTask{{ID: 1, Type: "tcp", Target: "old.invalid:443", IntervalSec: 120}}})
	select {
	case <-oldStarted:
	case <-time.After(time.Second):
		t.Fatal("old task did not start")
	}
	state.applyPolicy(agentPolicy{PingTasks: []PingTask{{ID: 1, Type: "tcp", Target: "new.invalid:443", IntervalSec: 120}}})
	select {
	case <-newStarted:
	case <-time.After(time.Second):
		t.Fatal("replacement was not scheduled after cancellation")
	}
	if overlap.Load() {
		t.Fatal("two generations of the same task overlapped")
	}
	report := Report{}
	state.appendDueResults(&report, time.Now())
	if len(report.PingResults) != 0 {
		t.Fatal("cancelled old target leaked a result")
	}
	close(newRelease)
	completedProbeReports(t, state, 1)
}

func TestAUD23BasicReportsContinueWhileTwentyProbesTimeOut(t *testing.T) {
	previous := resolvePublicIPsForPing
	var active, completed atomic.Int32
	resolvePublicIPsForPing = func(ctx context.Context, _ string) ([]net.IP, error) {
		active.Add(1)
		defer active.Add(-1)
		<-ctx.Done()
		completed.Add(1)
		return nil, ctx.Err()
	}
	t.Cleanup(func() { resolvePublicIPsForPing = previous })
	state := newPingReportState()
	t.Cleanup(state.close)
	tasks := make([]WebsiteProbeTask, 20)
	for index := range tasks {
		tasks[index] = WebsiteProbeTask{ID: index + 1, URL: "tcp://fixture.invalid:443", Method: "TCP", TimeoutSec: 1, IntervalSec: 120}
	}
	state.applyPolicy(agentPolicy{WebsiteProbeTasks: tasks})
	reportsSeen := make(chan int64, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		peer, err := (&websocket.Upgrader{}).Upgrade(w, request, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		for {
			_, raw, err := peer.ReadMessage()
			if err != nil {
				return
			}
			reports, err := decodeWireReports(raw)
			if err != nil {
				return
			}
			if len(reports) > 0 {
				reportsSeen <- reports[len(reports)-1].Timestamp
			}
			if err := peer.WriteJSON(serverMessage{Type: "ack"}); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	endpoint, _ := webSocketEndpoint(server.URL, "fixture")
	conn, err := connectWebSocket(endpoint, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	preparer := &reportPreparer{lastBasicInfoAt: time.Now(), collect: func(interval int) Report {
		return Report{CPU: 42, Timestamp: time.Now().UnixMilli(), ReportInterval: interval, Version: "fixture"}
	}}
	go func() { done <- runWebSocketSession(conn, preparer, state, 3*time.Second, time.Second) }()
	defer func() {
		conn.Close()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("report session failed to stop")
		}
	}()
	var first, second int64
	select {
	case first = <-reportsSeen:
	case <-time.After(time.Second):
		t.Fatal("initial basic report was blocked")
	}
	select {
	case second = <-reportsSeen:
	case <-time.After(4 * time.Second):
		t.Fatal("next basic report waited for all twenty timeouts")
	}
	if second <= first {
		t.Fatal("report samples did not advance")
	}
	if completed.Load() >= 20 || active.Load() == 0 {
		t.Fatal("probe fixture was no longer running during the next basic report")
	}
}
