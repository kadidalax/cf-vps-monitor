import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';
import { encryptBackup } from '../utils/backup.ts';
import { hashAgentToken } from '../utils/client.ts';

const oldToken = 'synthetic-old-agent-token-0000000000000001';
const newToken = 'synthetic-new-agent-token-0000000000000002';

async function fixture({ sameUuid = false, removed = false, includeClients = true, clientRows,
  syncFails = false, expectedStatus = 200 } = {}) {
  const previous = { uuid: 'node-a', name: 'Before restore', hidden: false, token: oldToken, token_hash: await hashAgentToken(oldToken) };
  const restored = { uuid: sameUuid ? previous.uuid : 'node-b', name: 'After restore', hidden: false,
    token: newToken, token_hash: await hashAgentToken(newToken), traffic_reset_day: 17, group: 'restored-group' };
  let clients = [previous];
  const restoredRows = clientRows ?? [restored];
  let restoreCalls = 0;
  let syncCalls = 0;
  let failSync = syncFails;
  const db = {
    getBackupConfigurationSnapshot: async () => ({ clients: structuredClone(clients), settings: { record_enabled: 'false' },
      ping_tasks: [], website_monitors: [], offline_notifications: [], expiry_notifications: [], load_notifications: [] }),
    listClients: async () => structuredClone(clients),
    listPublicClientRows: async () => structuredClone(clients),
    getAllSettings: async () => ({ record_enabled: 'false' }),
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    getSetting: async () => null, setSetting: async () => {},
    listPingTasks: async () => [], listWebsiteMonitors: async () => [], listAgentWebsiteProbeTasks: async () => [],
    listOfflineNotifications: async () => [], listExpiryNotifications: async () => [], listLoadNotifications: async () => [],
    restoreBackupData: async (_db, backup) => {
      restoreCalls += 1;
      if (backup.clients) clients = structuredClone(backup.clients);
    },
    cleanupOrphanClientData: async () => ({}), insertAuditLog: async () => {},
    markClientTokenUsed: async () => false,
    getClientByToken: async (_db, token) => clients.find(client => client.token === token) || null,
    getClientIdentityByToken: async (_db, token) => clients.find(client => client.token === token) || null,
    getClient: async (_db, uuid) => clients.find(client => client.uuid === uuid) || null,
    getClientsByIds: async (_db, ids) => clients.filter(client => ids.includes(client.uuid)),
    updateClient: async () => {},
  };
  const loader = createWorkerLoader({ db });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const state = createDurableState();
  const object = new LiveDataDO(state.state, {});
  const doRequest = (path, body, method = 'POST') => object.fetch(new Request(`https://do${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const env = { LIVE_DATA: { idFromName: id => id, get: () => ({ fetch: request => {
    if (new URL(request.url).pathname === '/clients-restore') {
      syncCalls += 1;
      if (failSync) return Response.json({ error: 'Synthetic sync outage' }, { status: 503 });
    }
    return object.fetch(request);
  } }) } };
  const executionCtx = { waitUntil: job => state.state.waitUntil(job), passThroughOnException() {} };
  await doRequest('/admin-clients-snapshot', { clients: [previous] }, 'PUT');
  await doRequest('/agent-auth', { client: previous });
  const report = await doRequest('/client-report', { uuid: previous.uuid, name: previous.name, hidden: false, report: { cpu: 12 }, ttl_ms: 120000 });
  assert.equal(report.status, 200, 'precondition: the previous HTTP live state exists');
  assert.equal(state.values.has(`http-live:${previous.uuid}`), true);
  const agent = createSocket({ role: 'agent', clientId: previous.uuid, clientName: previous.name, hidden: false,
    lastReport: { cpu: 12 }, lastReportTime: Date.now() });
  object.registerSession(agent.ws, agent.ws.deserializeAttachment());
  state.sockets.push(agent.ws);
  const auth = loader.load('worker/src/routes/client.ts');
  assert.equal((await auth.getAgentClientByToken(loader.database, oldToken, env)).uuid, previous.uuid);
  if (removed) {
    await doRequest('/client-remove', { uuid: previous.uuid });
    clients = [];
  }
  const encrypted = await encryptBackup({ schema: 'cf-monitor.backup', version: '2.0.0', scope: 'configuration',
    timestamp: new Date().toISOString(), ...(includeClients ? { clients: restoredRows } : { settings: { record_enabled: 'false' } }) }, 'synthetic-backup-password');
  assert.equal(encrypted.ok, true);
  const { adminRoutes } = loader.load('worker/src/routes/admin.ts');
  async function restore() {
    const response = await adminRoutes.fetch(new Request('https://panel.synthetic.test/upload/backup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        backup: encrypted.encryptedBackup, backup_password: 'synthetic-backup-password', confirm_restore: true, acknowledge_overwrite: true,
      }),
    }), env, executionCtx);
    await state.drain();
    return { status: response.status, body: await response.json() };
  }
  const response = await restore();
  assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
  if (restoreCalls) assert.deepEqual(clients.map(client => client.uuid), (includeClients ? restoredRows : [previous]).map(client => client.uuid),
    'the actual route completed its database restore boundary');
  return { previous, restored, state, object, agent, auth, loader, env, doRequest, response, restore,
    setSyncFailure: value => { failSync = value; },
    get restoreCalls() { return restoreCalls; }, get syncCalls() { return syncCalls; }, get clients() { return clients; } };
}

test('AUD-06 backup restoration replaces the authoritative DO client snapshot', async () => {
  const f = await fixture();
  const snapshot = await (await f.doRequest('/admin-clients-snapshot', undefined, 'GET')).json();
  assert.deepEqual(snapshot.clients.map(client => client.uuid), [f.restored.uuid], 'a successful restore cannot retain the pre-restore node set');
  assert.equal(snapshot.clients[0].name, f.restored.name);
  assert.equal(snapshot.clients[0].group, f.restored.group);
});

test('AUD-06 restored Agent can report against the refreshed management snapshot', async () => {
  const f = await fixture();
  const response = await f.doRequest('/client-report', { uuid: f.restored.uuid, name: f.restored.name,
    hidden: false, report: { cpu: 23 }, ttl_ms: 120000 }).catch(error => ({ status: 500, error: String(error) }));
  assert.equal(response.status, 200, `a newly restored node must not be blocked by an obsolete snapshot: ${response.error || ''}`);
  await f.state.drain();
});

for (const sameUuid of [false, true]) {
  test(`AUD-06 restoration revokes old Agent token for ${sameUuid ? 'the same UUID' : 'a removed UUID'}`, async () => {
    const f = await fixture({ sameUuid });
    const oldAuth = await f.auth.getAgentClientByToken(f.loader.database, oldToken, f.env);
    assert.equal(oldAuth, null, 'clearing Worker memory must not allow the obsolete DO auth snapshot to authenticate again');
    assert.equal((await f.auth.getAgentClientByToken(f.loader.database, newToken, f.env))?.uuid, f.restored.uuid);
  });
}

test('AUD-06 restoration clears old HTTP persistence and closes pre-restore Agent sessions', async () => {
  const f = await fixture();
  assert.equal(f.agent.ws.readyState, 3, 'a connection authenticated before replacement cannot keep reporting');
  assert.equal(f.state.values.has(`http-live:${f.previous.uuid}`), false);
  const live = f.object.buildSnapshot(true);
  assert.equal(live.online.includes(f.previous.uuid), false);
  assert.equal(Object.hasOwn(live.data, f.previous.uuid), false);
});

test('AUD-06 restoring a previously removed UUID clears its tombstone and installs fresh metadata', async () => {
  const f = await fixture({ sameUuid: true, removed: true });
  const snapshot = await (await f.doRequest('/admin-clients-snapshot', undefined, 'GET')).json();
  assert.equal(snapshot.removed?.includes(f.restored.uuid), false, 'an explicitly restored node is no longer deleted');
  assert.equal(snapshot.clients.find(client => client.uuid === f.restored.uuid)?.name, f.restored.name);
});

test('AUD-06 a backup without the clients module preserves existing live state and credentials', async () => {
  const f = await fixture({ includeClients: false });
  assert.equal(f.syncCalls, 0);
  assert.equal(f.agent.ws.readyState, 1);
  assert.equal(f.state.values.has(`http-live:${f.previous.uuid}`), true);
  assert.equal((await f.auth.getAgentClientByToken(f.loader.database, oldToken, f.env))?.uuid, f.previous.uuid);
});

test('AUD-06 an explicitly empty clients module clears the authoritative snapshot and old state', async () => {
  const f = await fixture({ clientRows: [] });
  const snapshot = await (await f.doRequest('/admin-clients-snapshot', undefined, 'GET')).json();
  assert.deepEqual(snapshot.clients, []);
  assert.equal(snapshot.complete, true);
  assert.equal(f.agent.ws.readyState, 3);
  assert.equal(await f.auth.getAgentClientByToken(f.loader.database, oldToken, f.env), null);
});

test('AUD-06 a failed live sync reports committed database state and allows a complete retry', async () => {
  const f = await fixture({ syncFails: true, expectedStatus: 500 });
  assert.equal(f.response.body.database_restored, true);
  assert.equal(f.response.body.realtime_synchronized, false);
  assert.equal(f.response.body.retryable, true);
  assert.equal(f.restoreCalls, 1);
  assert.deepEqual(f.clients.map(client => client.uuid), [f.restored.uuid]);
  f.setSyncFailure(false);
  assert.equal((await f.restore()).status, 200);
  assert.equal(await f.auth.getAgentClientByToken(f.loader.database, oldToken, f.env), null);
  const snapshot = await (await f.doRequest('/admin-clients-snapshot', undefined, 'GET')).json();
  assert.deepEqual(snapshot.clients.map(client => client.uuid), [f.restored.uuid]);
});

test('AUD-06 a normal thousand-node backup can synchronize above the ordinary snapshot request limit', async () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ uuid: `restored-${index}`, name: `Restored ${index}`,
    cpu_name: 'x'.repeat(200), remark: 'r'.repeat(200) }));
  assert.ok(new TextEncoder().encode(JSON.stringify({ clients: rows })).byteLength > 256 * 1024);
  const f = await fixture({ clientRows: rows });
  const snapshot = await (await f.doRequest('/admin-clients-snapshot', undefined, 'GET')).json();
  assert.equal(snapshot.clients.length, 1000);
  assert.equal(snapshot.complete, true);
});

test('AUD-06 an oversized client snapshot is rejected before the database restore commits', async () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ uuid: `oversized-${index}`, name: `Oversized ${index}`,
    cpu_name: 'c'.repeat(500), os: 'o'.repeat(500), kernel_version: 'k'.repeat(500), remark: 'r'.repeat(500) }));
  const f = await fixture({ clientRows: rows, expectedStatus: 413 });
  assert.equal(f.restoreCalls, 0, 'the DO storage-size guard must run before any SQL restoration');
  assert.equal(f.response.body.database_restored, false);
  assert.match(f.response.body.error, /缩短|减少/);
  assert.deepEqual(f.clients.map(client => client.uuid), [f.previous.uuid]);
  assert.equal(f.agent.ws.readyState, 1);
});
