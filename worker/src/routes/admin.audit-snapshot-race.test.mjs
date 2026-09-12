import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

async function staleSnapshot(kind, action, cold = false) {
  const old = { uuid: 'node', name: 'Old node name', hidden: false, sort_order: 2, updated_at: '2026-09-06T00:00:00Z' };
  const other = { ...old, uuid: 'second-node', name: 'Another authorized node' };
  let databaseRows = cold ? [old, other] : [old];
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const viewer = createSocket({ role: 'viewer', clientId: 'viewer', clientName: 'viewer', hidden: false,
    includeHidden: false, viewerExpiresAt: Date.now() + 120000 });
  const storage = createDurableState([], [viewer.ws]);
  const loader = createWorkerLoader({ db: {
    listClients: async () => {
      const captured = [{ ...old, sort_order: kind === 'reorder' ? 1 : old.sort_order }, ...(cold ? [other] : [])];
      if (kind !== 'repair-write') { enteredResolve(); await release; }
      return captured;
    },
    getClientsByIds: async () => [old], reorderClients: async () => 1,
    listPublicClientRows: async () => structuredClone(databaseRows),
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    updateClient: async () => {}, insertAuditLog: async () => {},
    getSetting: async () => null, setSetting: async () => {},
    listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(storage.state, {});
  if (cold) {
    await object.fetch(new Request('https://do/client-report', { method: 'POST', body: JSON.stringify({
      uuid: old.uuid, name: old.name, hidden: false, report: { cpu: 7 },
    }) }));
    await storage.drain();
    assert.equal((await object.fetch(new Request('https://do/admin-clients-snapshot'))).status, 404);
  } else {
    await object.fetch(new Request('https://do/admin-clients-snapshot', { method: 'PUT', body: JSON.stringify({ clients: [old] }) }));
  }
  if (kind === 'repair-write') {
    await object.fetch(new Request('https://do/client-remove', { method: 'POST', body: JSON.stringify({ uuid: 'previously-deleted' }) }));
  }
  const env = { LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: async request => {
    if (kind === 'repair-write' && request.method === 'PUT' && new URL(request.url).pathname === '/admin-clients-snapshot') {
      enteredResolve(); await release;
    }
    return object.fetch(request);
  } }) } };
  const context = { waitUntil: promise => storage.state.waitUntil(promise) };
  const { adminRoutes } = loader.load('worker/src/routes/admin.ts');
  const request = kind === 'reorder'
    ? new Request('https://panel.example.test/clients/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuids: ['node'] }) })
    : new Request('https://panel.example.test/clients?refresh=1');
  const pending = adminRoutes.fetch(request, env, context);
  let deadline;
  try {
    await Promise.race([entered, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Snapshot boundary never reached')), 10000); })]);
    clearTimeout(deadline);
    if (action !== 'none') {
      const current = { ...old, name: 'Current administrator name', hidden: action === 'hide', updated_at: new Date().toISOString() };
      databaseRows = [...(action === 'remove' ? [] : [current]), ...(cold ? [other] : [])];
      const control = await object.fetch(new Request(`https://do/client-${action === 'remove' ? 'remove' : 'meta'}`, {
        method: 'POST', body: JSON.stringify(action === 'remove' ? { uuid: old.uuid }
          : { uuid: old.uuid, name: current.name, hidden: current.hidden, client: current }),
      }));
      assert.equal(control.status, 200);
    }
    const before = viewer.messages.length;
    if (cold) {
      const second = await object.fetch(new Request('https://do/client-report', { method: 'POST', body: JSON.stringify({
        uuid: other.uuid, name: other.name, hidden: false, report: { cpu: 8 },
      }) }));
      assert.equal(second.status, 200, 'a partial control snapshot cannot reject another authorized node');
    }
    releaseResolve();
    const response = await pending;
    assert.equal(response.status, 200);
    await storage.drain();
    const snapshot = await (await object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
    const publicResponse = await loader.load('worker/src/routes/public.ts').publicRoutes.fetch(
      new Request('https://panel.example.test/clients?fresh=1'), env, context);
    assert.equal(publicResponse.status, 200);
    try {
      await object.fetch(new Request('https://do/client-report', { method: 'POST', body: JSON.stringify({
        uuid: old.uuid, name: 'Current administrator name', hidden: action === 'hide', report: { cpu: 6 },
      }) }));
    } catch (error) {
      if (action !== 'remove') throw error;
      assert.match(error.message, /removed/);
    }
    await storage.drain();
    return { snapshot, publicClients: await publicResponse.json(), live: object.buildSnapshot(false),
      events: viewer.messages.slice(before), responseBody: await response.json() };
  } finally {
    clearTimeout(deadline);
    releaseResolve();
    await pending;
    await storage.drain();
  }
}

for (const action of ['hide', 'remove', 'rename', 'none']) {
  test(`AUD-03 cold snapshot preserves ${action} and other authorized nodes`, async () => {
    const result = await staleSnapshot('refresh', action, true);
    const row = result.snapshot.clients.find(client => client.uuid === 'node');
    if (action === 'remove') {
      assert.equal(row, undefined);
      assert.ok(result.snapshot.removed.includes('node'));
    } else {
      assert.equal(row.hidden, action === 'hide');
      assert.equal(row.name, action === 'none' ? 'Old node name' : 'Current administrator name');
    }
    if (action === 'hide' || action === 'remove') {
      assert.ok(!result.live.online.includes('node'));
      assert.ok(!result.publicClients.some(client => client.uuid === 'node'));
    }
    assert.ok(result.live.online.includes('second-node'));
    assert.equal(result.live.data['second-node'].cpu, 8);
  });
}

for (const kind of ['refresh', 'reorder', 'repair-write']) {
  for (const action of ['hide', 'remove', 'rename', 'none']) {
    test(`AUD-03 stale admin ${kind} preserves later ${action}`, async () => {
      const result = await staleSnapshot(kind, action);
      const row = result.snapshot.clients.find(client => client.uuid === 'node');
      if (action === 'remove') {
        assert.equal(row, undefined, 'snapshot replacement must not recreate a deleted row');
        assert.ok(result.snapshot.removed.includes('node'), 'cache repairs do not revoke deletion markers');
      } else {
        assert.equal(row.hidden, action === 'hide');
        assert.equal(row.name, action === 'none' ? 'Old node name' : 'Current administrator name');
        if (kind === 'reorder') assert.equal(row.sort_order, 1, 'sorting still applies without replacing control fields');
      }
      if (action === 'hide' || action === 'remove') {
        assert.deepEqual(result.publicClients, []);
        assert.deepEqual(result.live.online, []);
        assert.ok(!result.events.flatMap(message => message.clients?.upsert || []).some(client => client.uuid === 'node'));
      } else {
        assert.deepEqual(result.live.online, ['node']);
      }
      if (kind === 'refresh' && action === 'remove') assert.deepEqual(result.responseBody, []);
    });
  }
}
