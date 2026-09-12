import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const loader = createWorkerLoader();
const { normalizeMonitorReport, toMonitorRecord } = loader.load('worker/src/utils/monitor-report.ts');
const { compactLiveReport } = loader.load('worker/src/utils/live-report-state.ts');
const { toPublicReport } = loader.load('worker/src/utils/public-report.ts');

test('unknown container disk and uptime remain null in live and compact public reports', () => {
  const report = normalizeMonitorReport({ disk: null, disk_total: null, uptime: null });
  for (const value of [report, compactLiveReport(report), toPublicReport(compactLiveReport(report))]) {
    assert.equal(value.disk, null);
    assert.equal(value.disk_total, null);
    assert.equal(value.uptime, null);
  }
  const record = toMonitorRecord('node', '2026-09-10T00:00:00Z', report);
  assert.equal(record.disk, 0, 'the existing numeric history schema keeps its zero placeholder');
  assert.equal(record.disk_total, 0);
  assert.equal(record.uptime, 0);
});

test('missing legacy metrics and valid empty disks keep their existing numeric behavior', () => {
  const missing = normalizeMonitorReport({ cpu: 1 });
  assert.equal(missing.disk, 0);
  assert.equal(missing.disk_total, 0);
  assert.equal(missing.uptime, 0);
  const empty = normalizeMonitorReport({ disk: { used: 0, total: 1024 }, uptime: 0 });
  assert.equal(empty.disk, 0);
  assert.equal(empty.disk_total, 1024);
  assert.equal(empty.uptime, 0);
});

for (const [disk, total] of [[null, 5024_000_000], [123, null]]) {
  test(`independent disk availability ${disk}/${total} stays visible without a fake historical percentage`, () => {
    const report = normalizeMonitorReport({ disk, disk_total: total, uptime: 45 });
    assert.equal(report.disk, disk);
    assert.equal(report.disk_total, total);
    const record = toMonitorRecord('node', '2026-09-10T00:00:00Z', report);
    assert.equal(record.disk, disk ?? 0, 'known used bytes survive even without capacity');
    assert.equal(record.disk_total, 0);
    assert.equal(record.uptime, 45);
  });
}
