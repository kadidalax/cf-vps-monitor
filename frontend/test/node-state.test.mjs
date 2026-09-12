import test from 'node:test';
import assert from 'node:assert/strict';
import { productionModule } from './helpers/production-module.mjs';
import { normalizeLiveDataResponse } from '../src/utils/liveDataResponse.ts';
import { normalizePublicMonitorRecord } from '../src/utils/publicHistory.ts';
import { buildMonitorChartData, getMonitorChartRenderData } from '../src/utils/monitorChartData.ts';

const liveModule = productionModule('src/contexts/LiveDataContext.tsx');
const snapshot = (extra = {}) => ({ online: [], clients: [], data: {}, count: 0, timestamp: 2000, ...extra });
const last = { uuid: 'a', name: 'Node A', lastReportTime: 1000, cpu: 47, ram: 0, disk: null, disk_total: null, uptime: null, temp: 0 };

test('node state: an offline snapshot retains only public last readings without marking them online', () => {
  const value = normalizeLiveDataResponse(snapshot({ last_known: { a: { ...last, token: 'synthetic-private', ipv4: '192.0.2.1' } } }));
  assert.deepEqual(value.last_known?.a, last);
  assert.deepEqual(value.online, []);
  assert.equal(value.count, 0);
  assert.deepEqual(value.data, {});
});

test('node state: malformed last readings cannot supply another node or a fabricated sampling time', () => {
  const value = normalizeLiveDataResponse(snapshot({ last_known: { a: { ...last, uuid: 'b' }, b: { ...last, uuid: 'b', lastReportTime: null } } }));
  assert.deepEqual(value.last_known, {});
  assert.deepEqual(normalizeLiveDataResponse(snapshot()).last_known, {}, 'old complete snapshots are compatible and clear last-known data');
});

test('node state: an explicit offline event retains the last sample time while removing current data', () => {
  const current = snapshot({ online: ['a'], clients: [last], data: { a: { cpu: 47, disk: null, disk_total: null, uptime: null } }, count: 1, last_known: {} });
  const result = liveModule.applyLiveRemove(current, { type: 'remove', client: 'a', reason: 'offline', timestamp: 3000 });
  assert.equal(result.last_known?.a?.cpu, 47);
  assert.equal(result.last_known.a.lastReportTime, 1000, 'offline detection time is not the last sample time');
  assert.equal(result.last_known.a.disk_total, null);
  assert.deepEqual(Array.from(result.online), []);
  assert.equal(result.data.a, undefined);
  assert.equal(result.clients.length, 0);
});

test('node state: explicit offline payload works before the first full snapshot but cannot complete that load', () => {
  const scope = liveModule.createLiveSnapshotScope();
  const result = scope.patch({ type: 'remove', client: 'a', reason: 'offline', last_known: last, timestamp: 3000 });
  assert.equal(result?.last_known?.a?.cpu, 47);
  assert.equal(scope.hasSnapshot, false);
});

test('node state: ordinary removal purges both current and last data and an update removes the offline copy', () => {
  const current = snapshot({ last_known: { a: last } });
  const removed = liveModule.applyLiveRemove(current, { type: 'remove', client: 'a', timestamp: 3000 });
  assert.equal(removed.last_known?.a, undefined);
  const recovered = liveModule.applyLiveUpdate(current, { type: 'update', client: 'a', name: 'Node A', data: { cpu: 0, disk: 0, disk_total: 100 }, timestamp: 4000 });
  assert.equal(recovered.last_known?.a, undefined);
  assert.equal(recovered.data.a.cpu, 0);
  assert.equal(recovered.data.a.disk_total, 100);
});

test('node state: full snapshots clear missing or empty last-known maps while during-read deletion wins', () => {
  for (const extra of [{}, { last_known: {} }]) {
    const scope = liveModule.createLiveSnapshotScope();
    scope.snapshot(snapshot({ last_known: { a: last } }));
    const read = scope.beginRead();
    const result = scope.complete(read, snapshot(extra));
    assert.deepEqual(Object.keys(result.last_known ?? {}), []);
  }
  const scope = liveModule.createLiveSnapshotScope();
  const read = scope.beginRead();
  scope.patch({ type: 'remove', client: 'a', timestamp: 3000 });
  const result = scope.complete(read, snapshot({ last_known: { a: last } }));
  assert.equal(result.last_known?.a, undefined, 'a pending full read must replay the newer deletion');
  scope.dispose();
  assert.equal(scope.patch({ type: 'remove', client: 'a', reason: 'offline', last_known: last, timestamp: 4000 }), undefined);
});

test('node state: offline grouping preserves the input manual order and unknown startup never reorders it', () => {
  const { filterMonitorNodes } = productionModule('src/utils/monitorView.ts');
  const nodes = [{ uuid: 'a', name: 'Zulu', sort_order: 0 }, { uuid: 'b', name: 'Alpha', sort_order: 1 }, { uuid: 'c', name: 'Beta', sort_order: 2 }];
  const grouped = filterMonitorNodes(nodes, { online: ['a', 'b'], data: {} }, { offlinePosition: 'last' });
  assert.deepEqual(Array.from(grouped, node => node.uuid), ['a', 'b', 'c']);
  const unknown = filterMonitorNodes(nodes, { online: ['b'], data: {}, statusReady: false }, { offlinePosition: 'last' });
  assert.deepEqual(Array.from(unknown, node => node.uuid), ['a', 'b', 'c']);
});

test('node state: unavailable disk and uptime do not discard valid CPU history or fabricate zero percent', () => {
  for (const values of [{ disk: null, disk_total: null, uptime: null }, { disk: 0, disk_total: 0 }, {}]) {
    const record = normalizePublicMonitorRecord({ time: '2026-09-10T01:00:00Z', cpu: 47, ...values });
    assert.ok(record, 'unavailable disk/uptime cannot remove an otherwise-valid history sample');
    assert.equal(record.cpu, 47);
    assert.equal(buildMonitorChartData([record])[0].disk, null, 'unknown disk capacity is not measured 0% usage');
  }
  assert.ok(getMonitorChartRenderData([], 1000, 2000).every(point => point.disk === null), 'axis placeholders do not invent disk measurements');
});

test('node state: measured zero disk usage remains valid when total capacity is known', () => {
  const record = normalizePublicMonitorRecord({ time: '2026-09-10T01:00:00Z', cpu: 0, disk: 0, disk_total: 100, uptime: 0 });
  assert.equal(record.disk, 0);
  assert.equal(record.uptime, 0);
  assert.equal(buildMonitorChartData([record])[0].disk, 0);
});

test('node state: explicit unavailable fields override metadata while missing fields may fall back', () => {
  const { resourceUsage, formatMetricUptime } = productionModule('src/utils/nodeMetrics.ts');
  const unknown = resourceUsage(null, null, 983);
  assert.equal(unknown.used, null);
  assert.equal(unknown.total, null);
  assert.equal(unknown.percent, null);
  const capacityOnly = resourceUsage(null, 5, 983);
  assert.equal(capacityOnly.total, 5);
  assert.equal(capacityOnly.percent, null);
  const missing = resourceUsage(0, undefined, 5);
  assert.equal(missing.total, 5);
  assert.equal(missing.percent, 0);
  assert.equal(resourceUsage(0, 0, 983).percent, null);
  assert.equal(formatMetricUptime(null), '—');
  assert.equal(formatMetricUptime(0), '0s');
});
