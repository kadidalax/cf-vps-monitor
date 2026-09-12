import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

async function reportAcrossAdminChange(action, basic) {
  const token = 'a'.repeat(64);
  let row = {
    uuid: 'node', name: 'Old name', hidden: false, token,
    token_hash: `sha256:${'b'.repeat(64)}`, updated_at: '2026-09-06T00:00:00.000Z',
    ipv4: '', ipv6: '', region: '', os: 'Old OS',
  };
  const viewer = createSocket({
    role: 'viewer', clientId: 'viewer', clientName: 'viewer', hidden: false,
    includeHidden: false, viewerExpiresAt: Date.now() + 120000,
  });
  const storage = createDurableState([], [viewer.ws]);
  const loader = createWorkerLoader({ db: {
    getClientByToken: async () => structuredClone(row), getClient: async () => structuredClone(row),
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    getSetting: async () => null, setSetting: async () => {},
    updateClient: async () => {}, markClientTokenUsed: async () => {},
    insertAuditLog: async () => {}, tryClaimAuditThrottle: async () => true,
    listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(storage.state, {});
  await object.fetch(new Request('https://do/admin-clients-snapshot', {
    method: 'PUT', body: JSON.stringify({ clients: [row] }),
  }));
  let authenticated;
  const started = new Promise(resolve => { authenticated = resolve; });
  const env = {
    LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: request => object.fetch(request) }) },
    RATE_LIMIT: { idFromName: value => value, get: () => ({ fetch: async request => {
      const bucket = await request.json();
      if (bucket.bucket === 'agent-report') authenticated();
      return Response.json({ allowed: true, limit: 100, remaining: 99, retryAfter: 0 });
    } }) },
  };
  const app = new Hono();
  app.route('/api', loader.load('worker/src/routes/client.ts').clientRoutes);
  let controller;
  let bodyClosed = false;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const pending = app.fetch(new Request('https://monitor.example.test/api/report', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '8.8.4.4' },
    body, duplex: 'half',
  }), env, { waitUntil: promise => storage.state.waitUntil(promise) });
  let deadline;
  try {
    await Promise.race([started, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Report never reached authenticated body read')), 10000);
    })]);
    clearTimeout(deadline);
    if (action !== 'none') {
      row = { ...row, name: 'Administrator new name', hidden: action === 'hide', updated_at: new Date().toISOString() };
      const control = await object.fetch(new Request(`https://do/client-${action === 'remove' ? 'remove' : 'meta'}`, {
        method: 'POST', body: JSON.stringify(action === 'remove'
          ? { uuid: row.uuid }
          : { uuid: row.uuid, name: row.name, hidden: row.hidden, client: row }),
      }));
      assert.equal(control.status, 200);
      if (action === 'remove') row = null;
    }
    const before = viewer.messages.length;
    controller.enqueue(new TextEncoder().encode(JSON.stringify({
      cpu: 6, timestamp: Date.now(), ...(basic ? { basic_info: { os: 'New Linux' } } : {}),
    })));
    controller.close();
    bodyClosed = true;
    const response = await pending;
    await storage.drain();
    return {
      status: response.status, publicLive: object.buildSnapshot(false), adminLive: object.buildSnapshot(true),
      publicEvents: viewer.messages.slice(before),
      snapshot: await (await object.fetch(new Request('https://do/admin-clients-snapshot'))).json(),
    };
  } finally {
    clearTimeout(deadline);
    if (!bodyClosed) controller.close();
    await pending;
    await storage.drain();
  }
}

for (const action of ['hide', 'remove', 'rename', 'none']) {
  for (const basic of [false, true]) {
    test(`AUD-03 late HTTP report ${basic ? 'with' : 'without'} basic info respects ${action}`, async () => {
      const result = await reportAcrossAdminChange(action, basic);
      if (action !== 'remove') assert.equal(result.status, 200, 'hidden and visible authorized Agents can still report');
      const stored = result.snapshot.clients.find(client => client.uuid === 'node');
      if (action === 'hide' || action === 'remove') {
        assert.deepEqual(result.publicLive.online, [], 'a later hide/delete must govern the delayed report');
        assert.ok(!result.publicEvents.some(message => message.type === 'update' && message.client === 'node'));
        assert.ok(!result.publicEvents.flatMap(message => message.clients?.upsert || []).some(client => client.uuid === 'node'));
      } else {
        assert.deepEqual(result.publicLive.online, ['node']);
        assert.equal(result.publicLive.data.node.cpu, 6);
        const expectedName = action === 'none' ? 'Old name' : 'Administrator new name';
        assert.ok(result.publicEvents.filter(message => message.type === 'update' && message.client === 'node')
          .every(message => message.name === expectedName), 'live reports also use the current administrator name');
      }
      if (action === 'remove') {
        assert.equal(stored, undefined);
        assert.ok(result.snapshot.removed.includes('node'));
        assert.deepEqual(result.adminLive.online, [], 'deleted authorization cannot recreate live state');
      } else {
        assert.equal(stored.hidden, action === 'hide');
        assert.equal(stored.name, action === 'none' ? 'Old name' : 'Administrator new name');
        assert.deepEqual(result.adminLive.online, ['node']);
      }
    });
  }
}
