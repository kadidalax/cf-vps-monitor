import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

const sourceIp = '8.8.4.4';
const privateV4 = '10.77.0.5';
const privateV6 = 'fd00::77';
const publicClient = {
  uuid: 'public-fixture', name: 'Public fixture', hidden: false,
  ipv4: sourceIp, ipv6: '', remark: 'ADMIN_PRIVATE_NOTE', public_remark: 'public note',
  tags: 'fixture', traffic_reset_day: 1,
};
const hiddenClient = { ...publicClient, uuid: 'hidden-fixture', name: 'HIDDEN_PRIVATE_NAME', hidden: true, remark: 'HIDDEN_PRIVATE_NOTE' };

async function fixture({ overrides = {} } = {}) {
  const viewers = [false, true].map(includeHidden => createSocket({
    role: 'viewer', clientId: includeHidden ? 'admin-viewer' : 'public-viewer',
    clientName: 'viewer', hidden: false, includeHidden, viewerExpiresAt: Date.now() + 120000,
  }));
  const storage = createDurableState([], viewers.map(viewer => viewer.ws));
  const db = {
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    listPublicClientRows: async () => structuredClone([publicClient, hiddenClient]),
    getHistoryStorageRowCounts: async () => ({ records: 0, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0 }),
    getHistoryStorageBytes: async () => ({ total: 0 }),
    getHistoryStorageUsage: async () => ({ live_rows: 0, live_row_bytes: 0, estimated_live_storage_bytes: 0, allocated_bytes: 0, reusable_bytes: null, measurement: 'live-row-bytes-plus-index-estimate' }),
    insertRecord: async () => {}, updateClient: async () => {},
    listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
    ...overrides,
  };
  const loader = createWorkerLoader({ db, expose: {
    'worker/src/routes/admin.ts': ['syncLiveClientMeta', 'hideAdminClientToken'],
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(storage.state, {});
  const env = {
    JWT_SECRET: 'audit-synthetic-secret-at-least-32-bytes',
    LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: request => object.fetch(request) }) },
  };
  const executionCtx = { waitUntil: promise => storage.state.waitUntil(promise), passThroughOnException() {} };
  await object.fetch(new Request('https://do/admin-clients-snapshot', {
    method: 'PUT', body: JSON.stringify({ clients: [publicClient, hiddenClient] }),
  }));
  const app = new Hono();
  app.route('/api', loader.load('worker/src/routes/public.ts').publicRoutes);
  app.route('/api', loader.load('worker/src/routes/websocket.ts').wsRoutes);
  return { object, storage, viewers, loader, env, executionCtx, app };
}

function assertPublicBytes(value, label) {
  const serialized = JSON.stringify(value);
  for (const secret of [sourceIp, privateV4, privateV6, 'ADMIN_PRIVATE_NOTE', 'SYNTHETIC_SECRET', 'HIDDEN_PRIVATE_NAME']) {
    assert.ok(!serialized.includes(secret), `${label} disclosed ${secret}`);
  }
}

test('AUD-02: all anonymous HTTP and WebSocket live outputs apply the public field boundary', async () => {
  const f = await fixture();
  for (const client of [publicClient, hiddenClient]) {
    const socket = createSocket({ role: 'agent', clientId: client.uuid, clientName: client.name, hidden: client.hidden, sourceIp });
    f.object.registerSession(socket.ws, socket.ws.deserializeAttachment());
    await f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: {
      cpu: 4, timestamp: Date.now(), ipv4: privateV4, ipv6: privateV6,
      basic_info: { os: 'Linux', ipv4: privateV4, ipv6: privateV6, password: 'SYNTHETIC_SECRET' },
      remark: 'ADMIN_PRIVATE_NOTE', arbitrary_extension: { credential: 'SYNTHETIC_SECRET' },
    } }));
  }
  await f.storage.drain();
  const update = f.viewers[0].messages.find(message => message.type === 'update');
  assert.equal(update?.data.cpu, 4);
  assertPublicBytes(f.viewers[0].messages.filter(message => message.type === 'update'), 'anonymous WS update');
  f.object.sendSnapshot(f.viewers[0].ws);
  assertPublicBytes(f.viewers[0].messages.at(-1), 'anonymous WS snapshot');
  for (const route of ['/api/live', '/api/ws/live', '/api/live/clients', '/api/public/bootstrap?fresh=1', '/api/live?include_hidden=1']) {
    const response = await f.app.fetch(new Request(`https://monitor.example.test${route}`, {
      headers: { 'CF-Connecting-IP': '1.1.1.1' },
    }), f.env, f.executionCtx);
    assert.equal(response.status, 200, route);
    const body = await response.json();
    assertPublicBytes(body, route);
    const snapshot = body.live || body;
    assert.deepEqual(snapshot.online, [publicClient.uuid]);
    assert.equal(snapshot.data[publicClient.uuid].cpu, 4);
  }
  assert.equal(f.object.buildSnapshot(true).data[publicClient.uuid].ipv4, sourceIp, 'authorized internal source IP remains available');
  await f.storage.drain();
});

test('AUD-03: metadata updates isolate public and administrative audiences', async () => {
  const f = await fixture();
  const { syncLiveClientMeta, hideAdminClientToken } = f.loader.load('worker/src/routes/admin.ts');
  for (const client of [publicClient, hiddenClient, { ...publicClient, hidden: true }]) {
    await syncLiveClientMeta({ env: f.env }, hideAdminClientToken({
      ...client, token: 'SYNTHETIC_SECRET', token_hash: 'SYNTHETIC_SECRET',
      token_last_used_ip: privateV4, arbitrary_extension: 'SYNTHETIC_SECRET',
    }));
    await f.storage.drain();
  }
  const publicEvents = f.viewers[0].messages.filter(message => message.type === 'metadata_changed');
  assertPublicBytes(publicEvents, 'anonymous metadata');
  assert.ok(!JSON.stringify(publicEvents).includes('HIDDEN_PRIVATE_NOTE'));
  const publicUpserts = publicEvents.flatMap(message => message.clients?.upsert || []);
  assert.ok(publicUpserts.some(client => client.uuid === publicClient.uuid && client.public_remark === 'public note'));
  assert.ok(!publicUpserts.some(client => client.hidden || client.uuid === hiddenClient.uuid));
  assert.ok(publicEvents.some(message => message.clients?.remove?.includes(publicClient.uuid)), 'public-to-hidden transition removes visible client');
  const adminUpserts = f.viewers[1].messages.flatMap(message => message.clients?.upsert || []);
  assert.ok(adminUpserts.some(client => client.uuid === hiddenClient.uuid && client.remark === 'HIDDEN_PRIVATE_NOTE'));
  assert.ok(!JSON.stringify(adminUpserts).includes('SYNTHETIC_SECRET'), 'agent credentials are never sent to viewers');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const action of ['hide', 'remove', 'rename']) {
  test(`AUD-03: a stale handshake cannot undo administrator ${action}`, async () => {
    const f = await fixture();
    const updated = { ...publicClient, name: 'CURRENT_ADMIN_NAME', hidden: action === 'hide' };
    await f.object.fetch(new Request(`https://do/client-${action === 'remove' ? 'remove' : 'meta'}`, {
      method: 'POST', body: JSON.stringify(action === 'remove'
        ? { uuid: publicClient.uuid }
        : { uuid: publicClient.uuid, name: updated.name, hidden: updated.hidden, client: updated }),
    }));
    const before = f.viewers[0].messages.length;
    const agent = createSocket({ role: 'agent', clientId: publicClient.uuid, clientName: publicClient.name, hidden: false });
    f.object.registerSession(agent.ws, agent.ws.deserializeAttachment());
    await f.object.webSocketMessage(agent.ws, JSON.stringify({ type: 'report', data: { cpu: 6 } }));
    await f.storage.drain();
    const snapshot = f.object.buildSnapshot(false);
    const events = f.viewers[0].messages.slice(before).filter(message => message.type === 'update');
    if (action === 'rename') {
      assert.deepEqual(snapshot.online, [publicClient.uuid]);
      assert.equal(events.at(-1)?.name, 'CURRENT_ADMIN_NAME');
    } else {
      assert.deepEqual(snapshot.online, []);
      assert.equal(events.length, 0);
    }
    if (action === 'remove') assert.deepEqual(f.object.buildSnapshot(true).online, []);
  });
}

for (const kind of ['basic', 'network']) {
  for (const action of ['hide', 'remove', 'rename']) {
    test(`AUD-03: in-flight ${kind} metadata cannot undo an administrator ${action}`, async () => {
      const started = deferred();
      const release = deferred();
      const f = await fixture({ overrides: { updateClient: async () => {
        started.resolve();
        await release.promise;
      } } });
      const pending = kind === 'basic'
        ? f.object.syncBasicInfoFromReport(publicClient.uuid, publicClient.name, false, { basic_info: { os: 'Fresh OS after await' } })
        : f.object.syncNetworkMetadataFromReport(publicClient.uuid, publicClient.name, false, { region: 'Fixture City, US' }, Date.now());
      try {
        await started.promise;
        const updated = { ...publicClient, name: 'ADMIN_RENAMED', hidden: action === 'hide', updated_at: '2026-09-06T14:00:00.000Z' };
        const response = await f.object.fetch(new Request(`https://do/${action === 'remove' ? 'client-remove' : 'client-meta'}`, {
          method: 'POST', body: JSON.stringify(action === 'remove'
            ? { uuid: publicClient.uuid }
            : { uuid: publicClient.uuid, name: updated.name, hidden: updated.hidden, client: updated }),
        }));
        assert.equal(response.status, 200);
        const beforePublic = f.viewers[0].messages.length;
        const beforeAdmin = f.viewers[1].messages.length;
        release.resolve();
        await pending;
        await f.storage.drain();
        const snapshot = await (await f.object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
        const stored = snapshot.clients.find(client => client.uuid === publicClient.uuid);
        const publicUpserts = f.viewers[0].messages.slice(beforePublic).flatMap(message => message.clients?.upsert || []);
        if (action === 'remove') {
          assert.equal(stored, undefined, 'an old Agent completion must not resurrect removed metadata');
          assert.ok(snapshot.removed.includes(publicClient.uuid), 'the deletion marker must survive');
          assert.ok(!f.viewers[1].messages.slice(beforeAdmin).flatMap(message => message.clients?.upsert || []).some(client => client.uuid === publicClient.uuid));
        } else {
          assert.equal(stored.hidden, updated.hidden, 'the current administrator visibility wins');
          assert.equal(stored.name, 'ADMIN_RENAMED', 'Agent metadata cannot restore an old administrator name');
          assert.equal(stored.updated_at, updated.updated_at);
        }
        if (action !== 'rename') {
          assert.ok(!publicUpserts.some(client => client.uuid === publicClient.uuid), 'a hidden/deleted node must not reappear in anonymous updates');
        } else {
          assert.ok(publicUpserts.every(client => client.uuid !== publicClient.uuid || client.name === 'ADMIN_RENAMED'));
        }
      } finally {
        release.resolve();
        await pending;
        await f.storage.drain();
      }
    });
  }
}
