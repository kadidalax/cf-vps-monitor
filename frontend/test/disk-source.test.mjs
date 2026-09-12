import assert from 'node:assert/strict';
import test from 'node:test';
import { productionModule } from './helpers/production-module.mjs';
import { normalizeLastKnownRecord } from '../src/utils/liveDataResponse.ts';

const module = productionModule('src/utils/nodeMetrics.ts');
const liveModule = productionModule('src/contexts/LiveDataContext.tsx');
const time = 1_789_100_000_000;
const sample = { disk: 8_388_608, disk_total: 5_024_000_000, disk_source: 'directory', disk_sampled_at: time };

test('offline disk state keeps estimate source and original sample time through removal and normalization', () => {
  const record = { uuid: 'a', name: 'A', lastReportTime: time + 120_000, ...sample };
  const normalized = normalizeLastKnownRecord(record, 'a');
  assert.equal(normalized.disk_source, 'directory');
  assert.equal(normalized.disk_sampled_at, time);
  const state = { online: ['a'], clients: [record], data: { a: record }, last_known: {}, count: 1, timestamp: time + 120_000 };
  const offline = liveModule.applyLiveRemove(state, { type: 'remove', client: 'a', reason: 'offline', timestamp: time + 300_000 });
  assert.equal(offline.last_known.a.disk_sampled_at, time);
  assert.equal(offline.last_known.a.disk_source, 'directory');
  assert.equal(offline.last_known.a.lastReportTime, time + 120_000);
});

test('disk presentation exposes numeric allocated bytes, estimate label and sample time together', () => {
  assert.equal(typeof module.diskUsagePresentation, 'function', 'a shared presentation must carry the measurement source');
  const result = module.diskUsagePresentation(sample);
  assert.equal(result.detail, '≈ 8.00 MB / 4.7 GB');
  assert.equal(result.estimated, true);
  assert.equal(result.sampledAt, time);
  assert.match(result.description, /文件占用估算/);
  assert.match(result.sampleLabel, /采样/);
  assert.equal(module.diskUsagePresentation({ ...sample, disk: 0 }).detail, '≈ 0 B / 4.7 GB');
  assert.equal(module.diskUsagePresentation({ disk: 8_388_608, disk_total: 5_024_000_000 }).detail, '8.00 MB / 4.7 GB');
  assert.equal(module.diskUsagePresentation({ disk: null, disk_total: 5_024_000_000 }).detail, '— / 4.7 GB');
});

test('invalid estimate metadata cannot make an unqualified number visible in offline state or formatting', () => {
  for (const values of [{ disk_source: 'other' }, { disk_sampled_at: 0 }, { disk_sampled_at: undefined }]) {
    const record = { uuid: 'a', name: 'A', lastReportTime: time, ...sample, ...values };
    assert.equal(normalizeLastKnownRecord(record, 'a').disk, null);
    assert.equal(typeof module.diskUsagePresentation, 'function');
    assert.equal(module.diskUsagePresentation(record).used, null);
  }
});
