import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { buildAdminSettings } from '../settings/schema.ts';
import * as quota from './quota.ts';
import { loadTypeScriptFunctions } from '../../../scripts/test-support/typescript.mjs';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

const helperUrl = new URL('./capacity-estimate.ts', import.meta.url);
const helpers = existsSync(helperUrl) ? await import(helperUrl) : {};

async function estimate({ pingCount = 2, recordEnabled = true, viewMinutes = 0 } = {}) {
  const pingTasks = Array.from({ length: pingCount }, (_, i) => ({ id: i + 1, name: `Ping ${i + 1}`, all_clients: true, clients: [], interval_sec: 120 }));
  const functions = await loadTypeScriptFunctions(new URL('../routes/admin.ts', import.meta.url), [
    'parsePositiveNumber', 'parseBoundedNumber', 'parseJsonArray', 'estimatePingSnapshotRowsPerDay',
    'estimateAgentPingTaskPullsPerDay', 'estimateCapacityCountCheckIntervalSec', 'buildCapacityEstimate',
  ], {
    ...quota, ...helpers, buildAdminSettings,
    capacityEstimateCache: null, CAPACITY_ESTIMATE_CACHE_MS: 30_000, CAPACITY_ESTIMATE_SETTING_KEYS: [],
    DEFAULT_UNIFIED_PING_INTERVAL_SEC: 120, MIN_UNIFIED_PING_INTERVAL_SEC: 60, MAX_UNIFIED_PING_INTERVAL_SEC: 3600,
    EMPTY_AGENT_PING_TASK_POLL_SEC: 600, AGENT_BASIC_INFO_REPORTS_PER_DAY: 48,
    WORKER_CRON_INTERVAL_SEC: 120, WEBSOCKET_MESSAGE_BILLING_RATIO: 20,
    CAPACITY_COUNT_FAR_CHECK_SEC: 21_600, CAPACITY_COUNT_NEAR_CHECK_SEC: 600, CAPACITY_COUNT_CRITICAL_CHECK_SEC: 60,
    ADMIN_TOUR_WORKER_REQUESTS: 23, CAPACITY_ROW_COUNT_CACHE_MS: 60_000,
    getCapacityRowCounts: async () => null,
    db: {
      countClientCapacityTargets: async () => ({ clients: 50, gpu_clients: 0 }),
      getSettingsByKeys: async () => ({ record_enabled: String(recordEnabled), record_persist_interval_sec: '120',
        ping_record_persist_interval_sec: '120', live_poll_active_interval_sec: '3', live_poll_idle_interval_sec: '120',
        capacity_daily_view_minutes: String(viewMinutes) }),
      listPingTaskEstimateRows: async () => pingTasks,
      getHistoryStorageBytes: async () => ({ total: 0 }),
      getHistoryStorageUsage: async () => null,
    },
  });
  return functions.buildCapacityEstimate({}, { forceCounts: true });
}

test('AUD-15 fifty nodes and two Ping tasks exceed the independent free DO write allowance', async () => {
  const result = await estimate();
  const writes = result.resource_estimates?.find(row => row.key === 'durable_object_rows_written');
  assert.equal(writes?.websocket, 144_000, '36,000 history markers, 72,000 per-task states and 36,000 final snapshots must be counted');
  assert.equal(writes.http, 144_000, 'both transports persist 36,000 final live states');
  assert.equal(writes.within_free_websocket, false);
  assert.equal(writes.within_free_http, false);
  assert.equal(result.monitor_reports_per_day, 36_000);
  assert.equal(result.agent_websocket_messages_per_day, 110_400, 'monitor reports are actual incoming messages too');
  assert.equal(result.free_tier_assessment, 'exceeds');
});

test('AUD-15 task count, disabled history, and active reporting affect the right resource dimensions', async () => {
  for (const [pingCount, expected] of [[0, 72_000], [1, 108_000], [2, 144_000]]) {
    const result = await estimate({ pingCount });
    assert.equal(result.resource_estimates?.find(row => row.key === 'durable_object_rows_written')?.websocket, expected);
  }
  const disabled = await estimate({ recordEnabled: false });
  assert.equal(disabled.resource_estimates.find(row => row.key === 'durable_object_rows_written').websocket, 36_000);
  assert.equal(disabled.resource_estimates.find(row => row.key === 'durable_object_rows_written').http, 36_000);
  const active = await estimate({ viewMinutes: 1440 });
  assert.equal(active.monitor_reports_per_day, 1_440_000);
  assert.equal(active.resource_estimates.find(row => row.key === 'durable_object_rows_written').websocket, 1_548_000);
  assert.equal(active.resource_estimates.find(row => row.key === 'durable_object_rows_written').http, 1_548_000);
  for (const key of ['durable_object_rows_read', 'durable_object_duration_gb_seconds', 'supabase_egress_bytes']) {
    const row = active.resource_estimates.find(item => item.key === key);
    assert.equal(row.websocket, null, `${key} is unknown, not zero`);
    assert.equal(row.estimate, 'unknown');
  }
});

async function actualPingStateWrites(recordEnabled, transport) {
  const state = createDurableState();
  let pingWrites = 0;
  let historyWrites = 0;
  const put = state.state.storage.put;
  state.state.storage.put = async (key, value) => {
    const keys = typeof key === 'object' ? Object.keys(key) : [key];
    pingWrites += keys.filter(name => name.startsWith('ping-result:')).length;
    return put(key, value);
  };
  const tasks = [1, 2].map(id => ({ id, name: `Ping ${id}`, all_clients: true, clients: [], interval_sec: 120 }));
  const db = {
    getSettingsByKeys: async () => ({ record_enabled: String(recordEnabled), ping_record_persist_interval_sec: '120' }),
    getHistoryStorageRowCounts: async () => ({ records: 0, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0 }),
    getHistoryStorageUsage: async () => ({ live_rows: 0, estimated_live_storage_bytes: 0 }),
    listPingTasks: async () => tasks,
    insertPingSnapshot: async () => { historyWrites += 1; },
    getSetting: async () => null, setSetting: async () => {},
    tryClaimAuditThrottle: async () => true, insertAuditLog: async () => {},
  };
  const { LiveDataDO } = createWorkerLoader({ db }).load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(state.state, {});
  const now = Date.now();
  const results = tasks.map(task => ({ task_id: task.id, value: 20, interval_sec: 120 }));
  for (let node = 0; node < 50; node += 1) {
    if (transport === 'websocket') {
      await object.persistPingResult(`node-${node}`, { results }, now);
    } else {
      const response = await object.updateHttpPingResult(new Request('https://synthetic.invalid/ping-result', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: `node-${node}`, timestamp: now, results }),
      }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.accepted, recordEnabled ? 2 : 0);
      if (!recordEnabled) assert.equal(body.disabled, true);
    }
  }
  await state.drain();
  return { pingWrites, historyWrites };
}

test('AUD-15 disabled-history estimates agree with real DO Ping persistence in both transports', async () => {
  const disabled = await estimate({ recordEnabled: false });
  for (const transport of ['websocket', 'http']) {
    const actual = await actualPingStateWrites(false, transport);
    assert.equal(actual.pingWrites, 0, `${transport}: actual DO skips task-state writes when history is disabled`);
    assert.equal(actual.historyWrites, 0);
    assert.equal(disabled.do_write_breakdown.ping_task_state, actual.pingWrites,
      `${transport}: a lower bound cannot include writes that the actual DO does not perform`);
    const enabled = await actualPingStateWrites(true, transport);
    assert.ok(enabled.pingWrites >= 100, `${transport}: positive control exercises two real task writes for all 50 nodes`);
    assert.equal(enabled.historyWrites, 50);
  }
});

test('four continuously active nodes still exceed the free daily DO write reference with history disabled', () => {
  const result = helpers.buildResourceEstimates({
    clientCount: 4, activeSecondsPerDay: 86400, sampleIntervalSec: 3, idleIntervalSec: 120,
    monitorRecordsPerDay: 0, pingTaskStateWritesPerDay: 0, pingTaskPullsPerDay: 0,
    pingResultReportsPerDay: 0, basicInfoReportsPerDay: 0, connectionsPerDay: 4,
    cronInvocationsPerDay: 720, estimatedSupabaseStorageBytes: 0,
  });
  const writes = result.resource_estimates.find(row => row.key === 'durable_object_rows_written');
  assert.equal(result.monitor_reports_per_day, 115200);
  assert.equal(writes.websocket, 115200);
  assert.equal(writes.http, 115200);
  assert.equal(writes.free_included, 100000);
  assert.equal(writes.within_free_websocket, false);
  assert.equal(result.do_write_breakdown.websocket_live_state, 115200);
  assert.equal(result.do_write_breakdown.http_live_state, 115200);
});

test('the snapshot write estimate agrees with actual accepted WebSocket messages and batches without history', async () => {
  const state = createDurableState();
  const writes = [];
  const put = state.state.storage.put;
  state.state.storage.put = async (key, value) => {
    if (typeof key === 'string' && key.startsWith('http-live:')) writes.push(value.lastReport.cpu);
    return put(key, value);
  };
  const { LiveDataDO } = createWorkerLoader({ db: {
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
  } }).load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(state.state, {});
  const socket = createSocket({ role: 'agent', clientId: 'node', clientName: 'Fixture', hidden: false });
  object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  for (const cpu of [1, 2, 3]) await object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: { cpu } }));
  await object.webSocketMessage(socket.ws, JSON.stringify({ type: 'reports', reports: [{ cpu: 4 }, { cpu: 5 }, { cpu: 6 }] }));
  await state.drain();
  assert.deepEqual(writes, [1, 2, 3, 6]);
  assert.equal(socket.messages.filter(message => message.type === 'ack').length, 4);
  const result = helpers.buildResourceEstimates({
    clientCount: 1, activeSecondsPerDay: 86400, sampleIntervalSec: 21600, idleIntervalSec: 120,
    monitorRecordsPerDay: 0, pingTaskStateWritesPerDay: 0, pingTaskPullsPerDay: 0,
    pingResultReportsPerDay: 0, basicInfoReportsPerDay: 0, connectionsPerDay: 1,
    cronInvocationsPerDay: 0, estimatedSupabaseStorageBytes: 0,
  });
  assert.equal(result.resource_estimates.find(row => row.key === 'durable_object_rows_written').websocket, writes.length);
});
