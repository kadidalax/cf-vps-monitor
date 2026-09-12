package main

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type observedWriteConn struct {
	net.Conn
	once    sync.Once
	writing chan struct{}
}

// net.Pipe has no kernel send buffer, so a peer that stops reading reliably
// blocks a write on every test platform, including Windows.
type pipeListener struct {
	connection chan net.Conn
	closed     chan struct{}
	once       sync.Once
}

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case connection := <-l.connection:
		return connection, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *pipeListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *pipeListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 80}
}

func (c *observedWriteConn) Write(data []byte) (int, error) {
	if len(data) >= 1024 {
		c.once.Do(func() { close(c.writing) })
	}
	return c.Conn.Write(data)
}

func livenessConnection(t *testing.T, mode string) (*safeWebSocketConn, <-chan []Report, <-chan struct{}, *atomic.Int32) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan struct{})
	seen := make(chan []Report, 16)
	writing := make(chan struct{})
	heartbeats := &atomic.Int32{}
	peerDone := make(chan struct{})
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		defer close(peerDone)
		peer, err := (&websocket.Upgrader{}).Upgrade(w, request, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		peer.SetPingHandler(func(data string) error {
			heartbeats.Add(1)
			switch mode {
			case "acks":
				return peer.WriteJSON(serverMessage{Type: "ack"})
			case "policies":
				return peer.WriteJSON(serverMessage{Type: "policy"})
			case "invalid":
				return peer.WriteMessage(websocket.TextMessage, []byte("not JSON"))
			default:
				return peer.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
			}
		})
		close(ready)
		if mode == "backpressure" {
			<-ctx.Done()
			return
		}
		for {
			_, raw, err := peer.ReadMessage()
			if err != nil {
				return
			}
			reports, err := decodeWireReports(raw)
			if err != nil {
				return
			}
			select {
			case seen <- reports:
			case <-ctx.Done():
				return
			}
			if mode == "silent" {
				<-ctx.Done()
				return
			}
			if mode != "pongs" {
				if err := peer.WriteJSON(serverMessage{Type: "ack"}); err != nil {
					return
				}
			}
			// Reading control frames automatically answers Ping, including in no-ACK mode.
		}
	}))
	var pipeClient net.Conn
	if mode == "backpressure" {
		var pipeServer net.Conn
		pipeClient, pipeServer = net.Pipe()
		listener := &pipeListener{connection: make(chan net.Conn, 1), closed: make(chan struct{})}
		listener.connection <- pipeServer
		_ = server.Listener.Close()
		server.Listener = listener
	}
	server.Start()
	endpoint, _ := webSocketEndpoint(server.URL, "fixture")
	dialer := websocket.Dialer{HandshakeTimeout: time.Second, NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if pipeClient != nil {
			return &observedWriteConn{Conn: pipeClient, writing: writing}, nil
		}
		connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &observedWriteConn{Conn: connection, writing: writing}, nil
	}}
	raw, _, err := dialer.Dial(endpoint, nil)
	if err != nil {
		cancel()
		server.Close()
		t.Fatal(err)
	}
	conn := &safeWebSocketConn{conn: raw}
	t.Cleanup(func() {
		cancel()
		_ = raw.Close()
		server.Close()
		select {
		case <-peerDone:
		case <-time.After(time.Second):
			t.Error("peer goroutine did not stop")
		}
	})
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("peer was not ready")
	}
	return conn, seen, writing, heartbeats
}

func startLivenessSession(t *testing.T, conn *safeWebSocketConn, state *pingReportState, large bool) <-chan error {
	t.Helper()
	preparer := &reportPreparer{lastBasicInfoAt: time.Now(), collect: func(interval int) Report {
		report := Report{Timestamp: time.Now().UnixMilli(), ReportInterval: interval, Version: "fixture"}
		if large {
			report.GPUs = []GPUInfo{{DeviceName: strings.Repeat("x", 1<<20)}}
		}
		return report
	}}
	done := make(chan error, 1)
	go func() {
		done <- runWebSocketSession(conn, preparer, state, 3*time.Second, 50*time.Millisecond)
		close(done)
	}()
	t.Cleanup(func() {
		_ = conn.conn.Close() // Raw Close keeps the pre-fix failure from deadlocking test cleanup.
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("session goroutine did not stop after fixture cleanup")
		}
	})
	return done
}

func TestAUD24MissingResponsesEndSessionAndRetainResults(t *testing.T) {
	for _, mode := range []string{"silent", "pongs"} {
		t.Run(mode, func(t *testing.T) {
			state, _ := quietProbeFixture(t, 1)
			deadline := time.Now().Add(time.Second)
			for {
				state.mu.Lock()
				ready := len(state.pendingPing) == 1
				state.mu.Unlock()
				if ready {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("probe fixture did not complete")
				}
				time.Sleep(time.Millisecond)
			}
			conn, seen, _, _ := livenessConnection(t, mode)
			done := startLivenessSession(t, conn, state, false)
			var first []Report
			select {
			case first = <-seen:
			case <-time.After(time.Second):
				t.Fatal("peer did not receive initial report")
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("missing ACK should fail the session")
				}
			case <-time.After(500 * time.Millisecond):
				t.Fatal("unresponsive session did not end within its heartbeat budget")
			}
			retry := state.takeRetryReports()
			if len(retry) != 1 || len(retry[0].PingResults) != 1 || retry[0].Timestamp != first[0].Timestamp {
				t.Fatalf("unacknowledged sample was lost: %+v", retry)
			}
		})
	}
}

func TestAUD24BackpressuredSessionWriteHasDeadline(t *testing.T) {
	state := newPingReportState()
	t.Cleanup(state.close)
	conn, _, writing, _ := livenessConnection(t, "backpressure")
	done := startLivenessSession(t, conn, state, true)
	select {
	case <-writing:
	case <-time.After(time.Second):
		t.Fatal("large write never reached the socket")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("backpressured write unexpectedly succeeded")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("socket write stayed blocked without a write deadline")
	}
}

func TestAUD24CloseInterruptsAnAlreadyBlockedWriter(t *testing.T) {
	conn, _, writing, _ := livenessConnection(t, "backpressure")
	writeDone := make(chan error, 1)
	go func() {
		writeDone <- conn.WriteMessage(websocket.BinaryMessage, bytes.Repeat([]byte{'x'}, 1<<20))
		close(writeDone)
	}()
	select {
	case <-writing:
	case <-time.After(time.Second):
		t.Fatal("large write never reached the socket")
	}
	select {
	case err := <-writeDone:
		t.Fatalf("fixture did not block the ordinary writer: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	closed := make(chan struct{})
	go func() { conn.Close(); close(closed) }()
	t.Cleanup(func() { _ = conn.conn.Close(); <-closed; <-writeDone })
	select {
	case <-closed:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Close is blocked by the ordinary writer mutex")
	}
}

func TestAUD24HealthyResponsesRenewLiveness(t *testing.T) {
	for _, mode := range []string{"responsive", "acks", "policies"} {
		t.Run(mode, func(t *testing.T) {
			state := newPingReportState()
			t.Cleanup(state.close)
			conn, seen, _, heartbeats := livenessConnection(t, mode)
			done := startLivenessSession(t, conn, state, false)
			select {
			case <-seen:
			case <-time.After(time.Second):
				t.Fatal("peer did not receive initial report")
			}
			select {
			case err := <-done:
				t.Fatalf("healthy %s session ended: %v", mode, err)
			case <-time.After(500 * time.Millisecond):
			}
			if heartbeats.Load() < 4 {
				t.Fatalf("only %d heartbeats reached peer", heartbeats.Load())
			}
		})
	}
}

func TestAUD24InvalidFramesDoNotRenewReadDeadline(t *testing.T) {
	state := newPingReportState()
	t.Cleanup(state.close)
	conn, seen, _, heartbeats := livenessConnection(t, "invalid")
	done := startLivenessSession(t, conn, state, false)
	select {
	case <-seen:
	case <-time.After(time.Second):
		t.Fatal("peer did not receive initial report")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("invalid frames should not keep the connection alive")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("invalid frames kept the connection alive past its read deadline")
	}
	if heartbeats.Load() == 0 {
		t.Fatal("fixture did not send any invalid responses")
	}
}

func TestAUD24HeartbeatContinuesWhileCollecting(t *testing.T) {
	state := newPingReportState()
	t.Cleanup(state.close)
	conn, seen, _, heartbeats := livenessConnection(t, "responsive")
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	preparer := &reportPreparer{lastBasicInfoAt: time.Now(), collect: func(interval int) Report {
		close(started)
		<-release
		return Report{Timestamp: time.Now().UnixMilli(), ReportInterval: interval}
	}}
	done := make(chan error, 1)
	go func() {
		done <- runWebSocketSession(conn, preparer, state, 3*time.Second, 50*time.Millisecond)
		close(done)
	}()
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		_ = conn.conn.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("session did not stop after collector release")
		}
	})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("collector did not start")
	}
	deadline := time.Now().Add(400 * time.Millisecond)
	for heartbeats.Load() < 4 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if count := heartbeats.Load(); count < 4 {
		t.Fatalf("collection blocked heartbeat: only %d pings reached peer", count)
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-seen:
	case err := <-done:
		t.Fatalf("session ended before collection completed: %v", err)
	case <-time.After(time.Second):
		t.Fatal("released collection did not produce a report")
	}
}

func TestAUD24RepeatedSessionsLeaveNoSocketGoroutines(t *testing.T) {
	countSocketGoroutines := func() int {
		stack := make([]byte, 1<<20)
		n := runtime.Stack(stack, true)
		return strings.Count(string(stack[:n]), ".readWebSocketMessages(") +
			strings.Count(string(stack[:n]), ".runWebSocketHeartbeat(")
	}
	before := countSocketGoroutines()
	for index := 0; index < 8; index++ {
		t.Run(string(rune('a'+index)), func(t *testing.T) {
			state := newPingReportState()
			t.Cleanup(state.close)
			conn, seen, _, _ := livenessConnection(t, "responsive")
			done := startLivenessSession(t, conn, state, false)
			select {
			case <-seen:
			case <-time.After(time.Second):
				t.Fatal("peer did not receive report")
			}
			conn.Close()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("session did not stop after close")
			}
		})
	}
	deadline := time.Now().Add(time.Second)
	for countSocketGoroutines() > before && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if after := countSocketGoroutines(); after > before {
		t.Fatalf("socket goroutines grew from %d to %d after sessions exited", before, after)
	}
}
