package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const websiteRevisionOld = "11111111-1111-4111-8111-111111111111"
const websiteRevisionNew = "22222222-2222-4222-8222-222222222222"

func websiteRevisionTask(t *testing.T, revision string) WebsiteProbeTask {
	t.Helper()
	var task WebsiteProbeTask
	if err := json.Unmarshal([]byte(fmt.Sprintf(`{"id":7,"url":"tcp://fixture.invalid:443","method":"TCP","timeout_sec":2,"interval_sec":120,"config_revision":%q}`, revision)), &task); err != nil {
		t.Fatal(err)
	}
	return task
}

func assertWebsiteResultRevision(t *testing.T, result WebsiteProbeResult, want string) {
	t.Helper()
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["config_revision"] != want {
		t.Fatalf("result lost executed task revision: got %v, want %s", wire["config_revision"], want)
	}
}

func TestReauditWebsiteRevisionEchoesExecutedTaskOnEveryResult(t *testing.T) {
	task := websiteRevisionTask(t, websiteRevisionOld)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer server.Close()
	httpTask := task
	httpTask.URL, httpTask.Method = server.URL, "GET"
	previous := resolvePublicIPsForPing
	resolvePublicIPsForPing = func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("127.0.0.1")}, nil }
	defer func() { resolvePublicIPsForPing = previous }()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	tcpTask := task
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	tcpTask.URL = "tcp://fixture.invalid:" + port
	for _, tc := range []struct {
		name string
		run  func() WebsiteProbeResult
	}{
		{"http success", func() WebsiteProbeResult { return executeWebsiteHTTPProbeWithClient(httpTask, server.Client()) }},
		{"http failure", func() WebsiteProbeResult { return normalizeWebsiteProbeHTTPResult(task, 500, 12) }},
		{"error", func() WebsiteProbeResult { return websiteProbeError(task, 7, "synthetic_error") }},
		{"tcp success", func() WebsiteProbeResult { return executeWebsiteTCPProbeWithContext(context.Background(), tcpTask) }},
	} {
		t.Run(tc.name, func(t *testing.T) { assertWebsiteResultRevision(t, tc.run(), websiteRevisionOld) })
	}
}

func TestReauditWebsiteRevisionChangeCancelsSameURLTask(t *testing.T) {
	previous := resolvePublicIPsForPing
	started, cancelled := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	resolvePublicIPsForPing = func(ctx context.Context, _ string) ([]net.IP, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-ctx.Done()
			close(cancelled)
			return nil, ctx.Err()
		}
		return nil, errors.New("synthetic newer probe failure")
	}
	defer func() { resolvePublicIPsForPing = previous }()
	state := newPingReportState()
	defer state.close()
	state.applyPolicy(agentPolicy{WebsiteProbeTasks: []WebsiteProbeTask{websiteRevisionTask(t, websiteRevisionOld)}})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("old probe did not start")
	}
	state.applyPolicy(agentPolicy{WebsiteProbeTasks: []WebsiteProbeTask{websiteRevisionTask(t, websiteRevisionNew)}})
	select {
	case <-cancelled:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("same URL with new configuration revision did not cancel old probe")
	}
	report := Report{}
	deadline := time.Now().Add(time.Second)
	for len(report.WebsiteProbeResults) == 0 && time.Now().Before(deadline) {
		state.appendDueResults(&report, time.Now())
		time.Sleep(time.Millisecond)
	}
	if len(report.WebsiteProbeResults) != 1 {
		t.Fatal("replacement task did not produce its own result")
	}
	assertWebsiteResultRevision(t, report.WebsiteProbeResults[0], websiteRevisionNew)
}

func TestReauditWebsiteRevisionChangeDropsQueuedOldResult(t *testing.T) {
	previous := resolvePublicIPsForPing
	resolvePublicIPsForPing = func(context.Context, string) ([]net.IP, error) { return nil, errors.New("synthetic failure") }
	defer func() { resolvePublicIPsForPing = previous }()
	state := newPingReportState()
	defer state.close()
	state.applyPolicy(agentPolicy{WebsiteProbeTasks: []WebsiteProbeTask{websiteRevisionTask(t, websiteRevisionOld)}})
	old := Report{}
	deadline := time.Now().Add(time.Second)
	for len(old.WebsiteProbeResults) == 0 && time.Now().Before(deadline) {
		state.appendDueResults(&old, time.Now())
		time.Sleep(time.Millisecond)
	}
	if len(old.WebsiteProbeResults) == 0 {
		t.Fatal("old result did not complete")
	}
	state.applyPolicy(agentPolicy{WebsiteProbeTasks: []WebsiteProbeTask{websiteRevisionTask(t, websiteRevisionNew)}})
	if current := state.currentReportResults([]Report{old}); len(current[0].WebsiteProbeResults) != 0 {
		t.Fatal("queued result from an old same-URL revision remained deliverable")
	}
}
