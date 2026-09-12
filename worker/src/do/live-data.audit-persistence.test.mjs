import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class UpgradeResponse extends Response {
  constructor(body, init) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    this.upgraded = init?.status === 101;
    this.webSocket = init?.webSocket;
  }
  get status() { return this.upgraded ? 101 : super.status; }
}

function fixture({ initial = [], settings = {}, overrides = {} } = {}) {
  const writes = [];
  const state = createDurableState(initial);
  const db = {
    getSettingsByKeys: async () => ({ record_enabled: 'true', record_persist_interval_sec: '120', ...settings }),
    getHistoryStorageRowCounts: async () => ({ records: 1, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0 }),
    getHistoryStorageBytes: async () => ({ total: 420 }),
    getHistoryStorageUsage: async () => ({ live_rows: 1, live_row_bytes: 228, estimated_live_storage_bytes: 420, allocated_bytes: 420, reusable_bytes: null, measurement: 'live-row-bytes-plus-index-estimate' }),
    insertRecord: async (_database, record) => { writes.push(record); },
    updateClient: async () => {}, listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
    getSetting: async () => null, setSetting: async () => {},
    tryClaimAuditThrottle: async () => true, insertAuditLog: async () => {},
    ...overrides,
  };
  const loader = createWorkerLoader({ db, globals: {
    Response: UpgradeResponse,
    WebSocketPair: class { constructor() { this[0] = createSocket({}).ws; this[1] = createSocket({}).ws; } },
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  return { object: new LiveDataDO(state.state, {}), LiveDataDO, state, writes, db };
}

test('AUD-31: a cold object loads the configured interval before its first persistence decision', async () => {
  const now = Date.now();
  const f = fixture({ initial: [['record:persist:node', now - 125000]], settings: { record_persist_interval_sec: '3600' } });
  assert.equal(await f.object.persistReport('node', { cpu: 10 }, now), false);
  assert.equal(f.writes.length, 0);
  const due = fixture({ initial: [['record:persist:node', now - 3601000]], settings: { record_persist_interval_sec: '3600' } });
  assert.equal(await due.object.persistReport('node', { cpu: 10 }, now), true);
  assert.equal(due.writes.length, 1);
});

test('AUD-31: the first cold viewer receives the configured lifetime', async () => {
  const f = fixture({ settings: { live_poll_active_max_duration_sec: '600' } });
  const before = Date.now();
  const response = await f.object.fetch(new Request('https://do/?role=viewer&id=fixture-viewer', { headers: { Upgrade: 'websocket' } }));
  assert.equal(response.status, 101);
  const attachment = f.state.sockets[0].deserializeAttachment();
  assert.ok(attachment.viewerExpiresAt - before >= 599000, 'configured ten-minute viewer lifetime was replaced with the two-minute default');
  await f.state.drain();
});

test('AUD-33: twenty reports arriving during an external wait reserve one per-client write', async () => {
  const gate = deferred();
  const reached = deferred();
  const f = fixture({ overrides: { getSettingsByKeys: async () => {
    reached.resolve(); await gate.promise; return { record_enabled: 'true', record_persist_interval_sec: '120' };
  } } });
  const now = Date.now();
  const first = f.object.persistReport('node', { cpu: 1 }, now);
  await reached.promise;
  const remaining = Array.from({ length: 19 }, (_, index) => f.object.persistReport('node', { cpu: index + 2 }, now + index + 1));
  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  await Promise.all([first, ...remaining]);
  assert.equal(f.writes.length, 1);
});

test('AUD-33: failed writes release the reservation without consuming the interval', async () => {
  let attempts = 0;
  const f = fixture({ overrides: { insertRecord: async () => { if (++attempts === 1) throw new Error('synthetic temporary failure'); } } });
  const now = Date.now();
  assert.equal(await f.object.persistReport('node', { cpu: 1 }, now), false);
  assert.equal(await f.object.persistReport('node', { cpu: 1 }, now + 1), true);
  assert.equal(attempts, 2);
});

test('AUD-33: a slow client does not serialize unrelated clients behind its database write', async () => {
  const gate = deferred();
  const reached = deferred();
  const f = fixture({ overrides: { insertRecord: async (_db, record) => {
    if (record.client === 'slow') { reached.resolve(); await gate.promise; }
  } } });
  const first = f.object.persistReport('slow', { cpu: 1 }, Date.now());
  await reached.promise;
  try {
    const result = await Promise.race([
      f.object.persistReport('fast', { cpu: 2 }, Date.now()),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 250)),
    ]);
    assert.equal(result, true);
  } finally { gate.resolve(); await first; }
});

test('AUD-34: failed basic information writes retry unchanged values before deduplicating success', async () => {
  let attempts = 0;
  const f = fixture({ overrides: { updateClient: async () => { if (++attempts === 1) throw new Error('synthetic temporary failure'); } } });
  const report = { basic_info: { os: 'synthetic Linux', cpu_cores: 2 } };
  await assert.rejects(f.object.syncBasicInfoFromReport('node', 'node', false, report), /synthetic temporary failure/);
  await f.object.syncBasicInfoFromReport('node', 'node', false, report);
  await f.object.syncBasicInfoFromReport('node', 'node', false, report);
  assert.equal(attempts, 2);
});

test('AUD-34: failed network writes retry unchanged values and successful concurrent values coalesce', async () => {
  let attempts = 0;
  const f = fixture({ overrides: { updateClient: async () => { if (++attempts === 1) throw new Error('synthetic temporary failure'); } } });
  const report = { ipv4: '8.8.4.4', region: 'Fixture City, US' };
  await f.object.syncNetworkMetadataFromReport('node', 'node', false, report, Date.now()).catch(() => {});
  await Promise.all(Array.from({ length: 20 }, () => f.object.syncNetworkMetadataFromReport('node', 'node', false, report, Date.now())));
  assert.equal(attempts, 2);
});
