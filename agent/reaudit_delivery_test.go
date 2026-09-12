package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func basicInfoDeliveryFixture(t *testing.T) (*reportPreparer, *pingReportState) {
	t.Helper()
	publicIPCache.Lock()
	old4, old6, oldExpiry := publicIPCache.ipv4, publicIPCache.ipv6, publicIPCache.expiresAt
	publicIPCache.ipv4, publicIPCache.ipv6, publicIPCache.expiresAt = "192.0.2.10", "2001:db8::10", time.Now().Add(time.Hour)
	publicIPCache.Unlock()
	oldName := clientName
	clientName = "synthetic-basic-info"
	gpuDetailsMu.Lock()
	oldGPU := globalGPUDetails
	gpuDetailsMu.Unlock()
	t.Cleanup(func() {
		publicIPCache.Lock()
		publicIPCache.ipv4, publicIPCache.ipv6, publicIPCache.expiresAt = old4, old6, oldExpiry
		publicIPCache.Unlock()
		clientName = oldName
		gpuDetailsMu.Lock()
		globalGPUDetails = oldGPU
		gpuDetailsMu.Unlock()
	})
	var samples int64
	preparer := &reportPreparer{collect: func(seconds int) Report {
		samples++
		return Report{CPU: 12, Timestamp: 1800000000000 + samples*3000, ReportInterval: seconds}
	}}
	state := newPingReportState()
	t.Cleanup(state.close)
	return preparer, state
}

func TestReauditBasicInfoHTTPFailureRetainsUntilAccepted(t *testing.T) {
	for _, failure := range []string{"503", "negative ack"} {
		for _, refresh := range []bool{false, true} {
			for _, withProbes := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s_refresh_%t_probes_%t", failure, refresh, withProbes), func(t *testing.T) {
					preparer, state := basicInfoDeliveryFixture(t)
					if refresh {
						state.acknowledgeReports(prepareReportsWithPing(preparer, state, 3*time.Second))
						preparer.lastBasicInfoAt = time.Now().Add(-basicInfoRefreshInterval)
						clientName = "synthetic-refreshed-info"
					}
					var mutex sync.Mutex
					var received [][]Report
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
						raw, _ := io.ReadAll(request.Body)
						reports, err := decodeWireReports(raw)
						if err != nil {
							t.Error(err)
						}
						mutex.Lock()
						received = append(received, reports)
						attempt := len(received)
						mutex.Unlock()
						if attempt == 1 {
							if failure == "503" {
								http.Error(w, "synthetic outage", 503)
							} else {
								_, _ = io.WriteString(w, `{"success":false}`)
							}
							return
						}
						_, _ = io.WriteString(w, `{"success":true}`)
					}))
					defer server.Close()
					oldURL, oldToken := serverURL, token
					serverURL, token = server.URL, "synthetic-token"
					defer func() { serverURL, token = oldURL, oldToken }()
					first := prepareReportsWithPing(preparer, state, 3*time.Second)
					if withProbes {
						first[0].PingResults = []PingResult{{TaskID: 7}}
					}
					if first[0].BasicInfo == nil {
						t.Fatal("fixture did not collect initial basic info")
					}
					if err := deliverHTTPReports(state, first); err == nil {
						t.Fatal("injected rejection was accepted")
					}
					second := prepareReportsWithPing(preparer, state, 3*time.Second)
					if err := deliverHTTPReports(state, second); err != nil {
						t.Fatal(err)
					}
					mutex.Lock()
					accepted := received[1]
					mutex.Unlock()
					latest := accepted[len(accepted)-1]
					if (!withProbes && len(accepted) != 1) || latest.BasicInfo == nil || latest.BasicInfo.Name != first[0].BasicInfo.Name {
						t.Fatal("first accepted fresh report lost unacknowledged basic_info")
					}
					if latest.Timestamp <= first[0].Timestamp {
						t.Fatal("retry kept obsolete ordinary metrics instead of attaching metadata to a fresh sample")
					}
					if next := prepareReportsWithPing(preparer, state, 3*time.Second); next[0].BasicInfo != nil {
						t.Fatal("accepted metadata must stop resending until refresh")
					}
				})
			}
		}
	}
}

func TestReauditBasicInfoWebSocketDisconnectDoesNotAcknowledge(t *testing.T) {
	for _, refresh := range []bool{false, true} {
		for _, withProbes := range []bool{false, true} {
			t.Run(fmt.Sprintf("refresh_%t_probes_%t", refresh, withProbes), func(t *testing.T) {
				preparer, state := basicInfoDeliveryFixture(t)
				if refresh {
					state.acknowledgeReports(prepareReportsWithPing(preparer, state, 3*time.Second))
					preparer.lastBasicInfoAt = time.Now().Add(-basicInfoRefreshInterval)
					clientName = "synthetic-refreshed-info"
				}
				if withProbes {
					collect := preparer.collect
					first := true
					preparer.collect = func(seconds int) Report {
						report := collect(seconds)
						if first {
							first = false
							report.PingResults = []PingResult{{TaskID: 7}}
						}
						return report
					}
				}
				var connection atomic.Int32
				seen := make(chan []Report, 3)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
					peer, err := (&websocket.Upgrader{}).Upgrade(w, request, nil)
					if err != nil {
						return
					}
					defer peer.Close()
					number := connection.Add(1)
					_, raw, err := peer.ReadMessage()
					if err != nil {
						return
					}
					reports, _ := decodeWireReports(raw)
					seen <- reports
					if number == 1 {
						return // A completed write without ACK does not accept metadata.
					}
					_ = peer.WriteJSON(serverMessage{Type: "ack"})
					_ = peer.WriteJSON(serverMessage{Type: "policy", ReportNow: true, SampleIntervalSec: 3, ReportIntervalSec: 3})
					_, raw, err = peer.ReadMessage()
					if err == nil {
						reports, _ = decodeWireReports(raw)
						seen <- reports
					}
				}))
				defer server.Close()
				oldInterval := reportInterval
				defer func() { reportInterval = oldInterval }()
				for index := 0; index < 2; index++ {
					endpoint, _ := webSocketEndpoint(server.URL, "synthetic-token")
					conn, err := connectWebSocket(endpoint, "synthetic-token")
					if err != nil {
						t.Fatal(err)
					}
					conn.readTimeout = time.Second
					_ = runWebSocketSession(conn, preparer, state, 3*time.Second, 100*time.Millisecond)
				}
				first, retried, afterAck := <-seen, <-seen, <-seen
				if len(first) != 1 || first[0].BasicInfo == nil {
					t.Fatal("first socket report did not contain bootstrap info")
				}
				if (!withProbes && len(retried) != 1) || retried[len(retried)-1].BasicInfo == nil || retried[len(retried)-1].BasicInfo.Name != first[0].BasicInfo.Name {
					t.Fatal("reconnected socket report lost basic_info before an ACK")
				}
				if afterAck[len(afterAck)-1].BasicInfo != nil {
					t.Fatal("WS ACK did not release accepted basic_info")
				}
			})
		}
	}
}

func TestReauditBasicInfoOldAckCannotReleaseLatestRefresh(t *testing.T) {
	preparer, state := basicInfoDeliveryFixture(t)
	old := prepareReportsWithPing(preparer, state, 3*time.Second)
	preparer.lastBasicInfoAt = time.Now().Add(-basicInfoRefreshInterval)
	clientName = "synthetic-latest-info"
	latest := prepareReportsWithPing(preparer, state, 3*time.Second)
	state.acknowledgeReports(old)
	stillPending := prepareReportsWithPing(preparer, state, 3*time.Second)
	if stillPending[0].BasicInfo == nil || stillPending[0].BasicInfo.Name != "synthetic-latest-info" {
		t.Fatal("an old acknowledgement released the newest pending metadata")
	}
	if stale := state.currentReportResults(old); stale[0].BasicInfo != nil {
		t.Fatal("obsolete retry metadata could overwrite the current revision")
	}
	state.acknowledgeReports(latest)
	if next := prepareReportsWithPing(preparer, state, 3*time.Second); next[0].BasicInfo != nil {
		t.Fatal("latest accepted metadata remains pending")
	}
}
