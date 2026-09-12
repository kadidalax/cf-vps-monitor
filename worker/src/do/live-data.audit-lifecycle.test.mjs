import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

for (const count of [128, 129, 257]) {
  test(`AUD-32 ${count} expired HTTP reports remain available while invalid snapshots respect the 128-key deletion limit`, async () => {
    const now = Date.now();
    const entries = Array.from({ length: count }, (_, index) => {
      const uuid = `expired-${index}`;
      return [`http-live:${uuid}`, { uuid, name: uuid, hidden: false, lastReportTime: now - 10000,
        expiresAt: now - 1, lastReport: { cpu: 1 } }];
    });
    entries.push(...Array.from({ length: count }, (_, index) => {
      const uuid = `invalid-${index}`;
      return [`http-live:${uuid}`, { uuid, name: uuid, hidden: false, lastReportTime: 'invalid',
        expiresAt: now - 1, lastReport: { cpu: 1 } }];
    }));
    entries.push(['http-live:valid-node', { uuid: 'valid-node', name: 'Valid node', hidden: false,
      lastReportTime: now, expiresAt: now + 600000, lastReport: { cpu: 9 } }]);
    const state = createDurableState(entries);
    const remove = state.state.storage.delete;
    state.state.storage.delete = async keys => {
      if (Array.isArray(keys) && keys.length > 128) throw new RangeError('Storage delete accepts at most 128 keys');
      return remove(keys);
    };
    const { LiveDataDO } = createWorkerLoader().load('worker/src/do/live-data.ts');
    const object = new LiveDataDO(state.state, {});
    const response = await object.fetch(new Request('https://do/live'));
    assert.equal(response.status, 200);
    const live = await response.json();
    assert.deepEqual(live.online, ['valid-node']);
    assert.equal(live.data['valid-node'].cpu, 9);
    assert.ok(state.values.has('http-live:valid-node'));
    assert.equal(Object.keys(live.last_known).length, count);
    assert.equal(live.last_known['expired-0'].cpu, 1);
    assert.ok(![...state.values.keys()].some(key => key.startsWith('http-live:invalid-')));
  });
}

function fixture({ recordEnabled = false } = {}) {
  let now = Date.now();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const state = createDurableState();
  const records = [];
  const db = {
    getSettingsByKeys: async () => ({ record_enabled: String(recordEnabled), record_persist_interval_sec: '120' }),
    getHistoryStorageRowCounts: async () => ({ records: 1, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0 }),
    getHistoryStorageBytes: async () => ({ total: 420 }),
    getHistoryStorageUsage: async () => ({ live_rows: 1, live_row_bytes: 228, estimated_live_storage_bytes: 420, allocated_bytes: 420, reusable_bytes: null, measurement: 'live-row-bytes-plus-index-estimate' }),
    insertRecord: async (_db, record) => records.push(record), insertGPURecords: async () => {},
    updateClient: async () => {}, listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
    getSetting: async () => null, setSetting: async () => {}, tryClaimAuditThrottle: async () => true, insertAuditLog: async () => {},
  };
  const { LiveDataDO } = createWorkerLoader({ db, globals: { Date: Clock } }).load('worker/src/do/live-data.ts');
  return {
    object: new LiveDataDO(state.state, {}), state, records,
    get now() { return now; }, advance: ms => { now += ms; },
    cold: () => new LiveDataDO(state.state, {}),
  };
}

async function snapshot(object, includeHidden = false) {
  const response = await object.fetch(new Request(`https://do/live${includeHidden ? '?include_hidden=1' : ''}`));
  assert.equal(response.status, 200);
  return response.json();
}

async function httpReport(f, extra = {}) {
  const response = await f.object.fetch(new Request('https://do/client-report', {
    method: 'POST', body: JSON.stringify({ uuid: 'node', name: 'fixture', ttl_ms: 180000, timestamp: f.now, report: { cpu: 17, timestamp: f.now }, ...extra }),
  }));
  assert.equal(response.status, 200);
  await f.state.drain();
}

test('AUD-32: HTTP live state survives hibernation with history disabled and expires at its original TTL', async () => {
  const f = fixture();
  await httpReport(f);
  assert.equal((await snapshot(f.object)).count, 1);
  f.advance(11000);
  const restored = await snapshot(f.cold());
  assert.equal(restored.count, 1);
  assert.equal(restored.data.node.cpu, 17);
  assert.equal(f.records.length, 0, 'live survival must not require history persistence');
  f.advance(180000);
  assert.equal((await snapshot(f.cold())).count, 0);
});

test('AUD-32: hidden metadata and explicit removal cannot resurrect old HTTP state', async () => {
  const f = fixture();
  await httpReport(f);
  await f.object.fetch(new Request('https://do/client-meta', {
    method: 'POST', body: JSON.stringify({ uuid: 'node', name: 'hidden fixture', hidden: true, client: { uuid: 'node', name: 'hidden fixture', hidden: true } }),
  }));
  assert.equal((await snapshot(f.cold())).count, 0);
  assert.equal((await snapshot(f.cold(), true)).data.node?.name, 'hidden fixture');
  await f.object.fetch(new Request('https://do/client-remove', { method: 'POST', body: JSON.stringify({ uuid: 'node' }) }));
  assert.equal((await snapshot(f.cold(), true)).count, 0);
});

test('AUD-35: a legal large report still acknowledges, persists and restores within attachment limits', async () => {
  const f = fixture({ recordEnabled: true });
  const socket = createSocket({ role: 'agent', clientId: 'node', clientName: 'fixture', hidden: false });
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.state.sockets.push(socket.ws);
  const report = {
    cpu: 17, timestamp: f.now, arbitrary_extension: 'x'.repeat(20000),
    basic_info: { os: '中'.repeat(9000), cpu_cores: 2 },
    gpus: Array.from({ length: 16 }, (_, device_index) => ({ device_index, device_name: '图'.repeat(128), mem_total: 1000, mem_used: 100, utilization: 10, temperature: 40 })),
  };
  await f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: report }));
  await f.state.drain();
  assert.ok(socket.messages.some(message => message.type === 'ack'), 'legal report was silently dropped before ACK');
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].cpu, 17);
  const attachment = socket.ws.deserializeAttachment();
  assert.ok(new TextEncoder().encode(JSON.stringify(attachment)).byteLength <= 16384);
  assert.equal(attachment.lastReport.gpus.length, 16);
  const restored = await snapshot(f.cold(), true);
  assert.equal(restored.data.node.cpu, 17);
  assert.equal(restored.data.node.gpus.length, 16);
});

async function offline(object) {
  const response = await object.fetch(new Request('https://do/offline-evaluate', {
    method: 'POST', body: JSON.stringify({ clients: [{ uuid: 'node', graceMs: 180000 }] }),
  }));
  assert.equal(response.status, 200);
  return (await response.json()).clients.node;
}

test('AUD-37: slow and out-of-order Agent timestamps cannot make a freshly received report offline', async () => {
  const f = fixture();
  const socket = createSocket({ role: 'agent', clientId: 'node', clientName: 'fixture', hidden: false });
  f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
  f.state.sockets.push(socket.ws);
  await f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: { cpu: 17, timestamp: f.now - 3600000 } }));
  await f.state.drain();
  assert.equal((await offline(f.object)).offline, false);
  f.advance(10000);
  await f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: { cpu: 18, timestamp: f.now - 7200000 } }));
  await f.state.drain();
  assert.equal((await offline(f.cold())).lastSeen, f.now);
  f.advance(180001);
  assert.equal((await offline(f.object)).offline, true);
});

test('AUD-37: HTTP liveness uses the service clock while historical samples retain their sampling time', async () => {
  const f = fixture({ recordEnabled: true });
  const sampledAt = f.now - 3600000;
  await httpReport(f, { timestamp: sampledAt, report: { cpu: 17, timestamp: sampledAt } });
  assert.equal((await offline(f.object)).offline, false);
  assert.equal((await snapshot(f.object)).data.node.lastReportTime, f.now);
  assert.equal(Date.parse(f.records[0].time), sampledAt);
});
