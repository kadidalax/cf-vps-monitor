import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const loader = createWorkerLoader();
const { normalizeMonitorReport, toMonitorRecord } = loader.load('worker/src/utils/monitor-report.ts');
const { compactLiveReport } = loader.load('worker/src/utils/live-report-state.ts');
const { toPublicReport } = loader.load('worker/src/utils/public-report.ts');
const time = 1_789_100_000_000;
const sample = { disk: 8_388_608, disk_total: 5_024_000_000, disk_source: 'directory', disk_sampled_at: time, timestamp: time + 120_000 };

test('directory disk measurement retains its original sample time through public and persisted live projections', () => {
  const normalized = normalizeMonitorReport({ ...sample, scan_path: '/private/root', scan_error: 'private extension' });
  const stored = JSON.parse(JSON.stringify(compactLiveReport(normalized)));
  for (const value of [toPublicReport(normalized), toPublicReport(compactLiveReport(normalizeMonitorReport(stored)))]) {
    assert.equal(value.disk, 8_388_608);
    assert.equal(value.disk_source, 'directory');
    assert.equal(value.disk_sampled_at, time, 'receipt time cannot refresh a cached measurement');
    assert.equal(value.timestamp, time + 120_000);
    assert.equal(value.scan_path, undefined);
    assert.equal(value.scan_error, undefined);
  }
});

for (const invalid of [
  { disk_source: 'quota' }, { disk_source: null }, { disk_source: undefined },
  { disk_sampled_at: undefined }, { disk_sampled_at: null }, { disk_sampled_at: 0 },
  { disk_sampled_at: -1 }, { disk_sampled_at: time + 0.5 }, { disk_sampled_at: String(time) },
  { disk_sampled_at: 8_640_000_000_000_001 }, { disk: undefined }, { disk: null },
]) {
  test(`invalid attempted disk estimate is unavailable instead of silently exact: ${JSON.stringify(invalid)}`, () => {
    const report = normalizeMonitorReport({ ...sample, ...invalid });
    assert.equal(report.disk, null);
    assert.equal(report.disk_total, 5_024_000_000);
    assert.equal(report.disk_source, undefined);
    assert.equal(report.disk_sampled_at, undefined);
    assert.equal(compactLiveReport(report).disk, null);
  });
}

test('directory measurements preserve real zero, over-allocation and report-time numeric history', () => {
  for (const used of [0, 6_000_000_000]) {
    const value = normalizeMonitorReport({ ...sample, disk: used });
    const record = toMonitorRecord('synthetic-node', '2026-09-11T07:00:00Z', value);
    assert.equal(value.disk, used);
    assert.equal(value.disk_source, 'directory');
    assert.equal(record.disk, used);
    assert.equal(record.time, '2026-09-11T07:00:00Z');
  }
  const legacy = normalizeMonitorReport({ disk: 12, disk_total: 100 });
  assert.equal(legacy.disk, 12);
  assert.equal(legacy.disk_source, undefined);
  assert.equal(legacy.disk_sampled_at, undefined);
});

test('directory history retains measured bytes when capacity is unknown without inventing a percentage', () => {
  for (const used of [0, 8_388_608]) {
    const normalized = normalizeMonitorReport({ ...sample, disk: used, disk_total: null });
    const record = toMonitorRecord('synthetic-node', '2026-09-11T07:00:00Z', normalized);
    assert.equal(normalized.disk_source, 'directory');
    assert.equal(record.disk, used);
    assert.equal(record.disk_total, 0, 'zero total keeps the historical percentage unavailable');
    assert.equal(record.time, '2026-09-11T07:00:00Z');
  }
});
