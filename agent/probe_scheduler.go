package main

import (
	"context"
	"strings"
	"time"
)

const maxConcurrentProbes = 4

type probeRun struct{ cancel context.CancelFunc }

func (s *pingReportState) close() {
	if s == nil {
		return
	}
	s.cancel()
	<-s.probeDone
	s.probeWorkers.Wait()
}

func (s *pingReportState) signalProbeScheduler() {
	if s == nil {
		return
	}
	select {
	case s.probeWake <- struct{}{}:
	default:
	}
}

func (s *pingReportState) runProbeScheduler() {
	defer close(s.probeDone)
	timer := time.NewTimer(time.Hour)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()
	for {
		if s.ctx.Err() != nil {
			return
		}
		next := s.launchDueProbes(time.Now())
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		var tick <-chan time.Time
		if !next.IsZero() {
			delay := time.Until(next)
			if delay < time.Millisecond {
				delay = time.Millisecond
			}
			timer.Reset(delay)
			tick = timer.C
		}
		select {
		case <-s.ctx.Done():
			return
		case <-s.probeWake:
		case <-tick:
		}
	}
}

func (s *pingReportState) nextPingLocked() (PingTask, time.Time, bool) {
	var best PingTask
	var due time.Time
	found := false
	for _, task := range s.tasks {
		if task.ID <= 0 || s.pendingPing[task.ID] != nil || s.runningPing[task.ID] != nil {
			continue
		}
		candidate := time.Time{}
		if last, ok := s.scheduler.lastRunByTaskID[task.ID]; ok {
			candidate = last.Add(pingTaskInterval(task))
		}
		if !found || candidate.Before(due) {
			best, due, found = task, candidate, true
		}
	}
	return best, due, found
}

func (s *pingReportState) nextWebsiteLocked() (WebsiteProbeTask, time.Time, bool) {
	var best WebsiteProbeTask
	var due time.Time
	found := false
	for _, task := range s.websiteTasks {
		if task.ID <= 0 || s.pendingWebsites[task.ID] != nil || s.runningWebsites[task.ID] != nil {
			continue
		}
		candidate := time.Time{}
		if last, ok := s.websiteScheduler.lastRunByTaskID[task.ID]; ok {
			candidate = last.Add(websiteProbeInterval(task))
		}
		if !found || candidate.Before(due) {
			best, due, found = task, candidate, true
		}
	}
	return best, due, found
}

func (s *pingReportState) launchDueProbes(now time.Time) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.activeProbes < maxConcurrentProbes && s.ctx.Err() == nil {
		ping, pingDue, hasPing := s.nextPingLocked()
		website, websiteDue, hasWebsite := s.nextWebsiteLocked()
		if !hasPing && !hasWebsite {
			return time.Time{}
		}
		useWebsite := hasWebsite && (!hasPing || websiteDue.Before(pingDue) || (websiteDue.Equal(pingDue) && s.preferWebsite))
		due := pingDue
		if useWebsite {
			due = websiteDue
		}
		if due.After(now) {
			return due
		}
		if hasPing && hasWebsite && websiteDue.Equal(pingDue) {
			s.preferWebsite = !s.preferWebsite
		}
		ctx, cancel := context.WithCancel(s.ctx)
		run := &probeRun{cancel: cancel}
		s.activeProbes++
		s.probeWorkers.Add(1)
		if useWebsite {
			s.runningWebsites[website.ID] = run
			s.websiteScheduler.lastRunByTaskID[website.ID] = now
			go s.runWebsiteProbe(ctx, website, run)
		} else {
			s.runningPing[ping.ID] = run
			s.scheduler.lastRunByTaskID[ping.ID] = now
			go s.runPingProbe(ctx, ping, run)
		}
	}
	return time.Time{}
}

func (s *pingReportState) runPingProbe(ctx context.Context, task PingTask, run *probeRun) {
	defer s.probeWorkers.Done()
	defer run.cancel()
	var value float64
	switch strings.ToLower(task.Type) {
	case "icmp":
		value = executeICMPPingWithContext(ctx, task.Target)
	case "http", "https":
		value = executeHTTPPingWithContext(ctx, task.Target)
	default:
		value, _ = executeTCPProbeWithContext(ctx, task.Target, 3*time.Second)
	}
	s.mu.Lock()
	if s.runningPing[task.ID] == run {
		delete(s.runningPing, task.ID)
		if ctx.Err() == nil {
			s.queuePingResultsLocked([]PingResult{{TaskID: task.ID, Value: value}})
		}
	}
	s.activeProbes--
	s.mu.Unlock()
	s.signalProbeScheduler()
}

func (s *pingReportState) runWebsiteProbe(ctx context.Context, task WebsiteProbeTask, run *probeRun) {
	defer s.probeWorkers.Done()
	defer run.cancel()
	var result WebsiteProbeResult
	if strings.EqualFold(task.Method, "TCP") {
		result = executeWebsiteTCPProbeWithContext(ctx, task)
	} else {
		result = executeWebsiteHTTPProbeWithContext(ctx, task)
	}
	s.mu.Lock()
	if s.runningWebsites[task.ID] == run {
		delete(s.runningWebsites, task.ID)
		if ctx.Err() == nil {
			s.queueWebsiteResultsLocked([]WebsiteProbeResult{result})
		}
	}
	s.activeProbes--
	s.mu.Unlock()
	s.signalProbeScheduler()
}
