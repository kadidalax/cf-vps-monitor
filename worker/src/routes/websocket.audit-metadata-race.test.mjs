import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

for (const action of ['hide', 'remove', 'rename', 'none']) {
  test(`AUD-03 WebSocket route network metadata respects a later ${action}`, async () => {
    const old = { uuid: 'node', name: 'Old route name', hidden: false, region: '', token: 'a'.repeat(64), token_hash: `sha256:${'b'.repeat(64)}` };
    let startedResolve, releaseResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const release = new Promise(resolve => { releaseResolve = resolve; });
    const viewer = createSocket({ role: 'viewer', clientId: 'viewer', clientName: 'viewer', hidden: false,
      includeHidden: false, viewerExpiresAt: Date.now() + 120000 });
    const storage = createDurableState([], [viewer.ws]);
    const loader = createWorkerLoader({ db: {
      getClientIdentityByToken: async () => structuredClone(old), getClient: async () => structuredClone(old),
      getSettingsByKeys: async () => ({ record_enabled: 'false' }),
      markClientTokenUsed: async () => {}, insertAuditLog: async () => {},
      updateClient: async () => { startedResolve(); await release; },
      getSetting: async () => null, setSetting: async () => {},
      listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
    } });
    const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
    const object = new LiveDataDO(storage.state, {});
    await object.fetch(new Request('https://do/admin-clients-snapshot', { method: 'PUT', body: JSON.stringify({ clients: [old] }) }));
    await object.fetch(new Request('https://do/client-report', { method: 'POST', body: JSON.stringify({
      uuid: old.uuid, name: old.name, hidden: false, report: { cpu: 7 },
    }) }));
    await storage.drain();
    const env = { LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: request => object.fetch(request) }) } };
    const { wsRoutes } = loader.load('worker/src/routes/websocket.ts');
    const pending = wsRoutes.fetch(new Request('https://panel.example.test/clients/report', {
      headers: { Authorization: `Bearer ${old.token}`, 'CF-IPCountry': 'US' },
    }), env, { waitUntil: promise => storage.state.waitUntil(promise) });
    let deadline;
    try {
      await Promise.race([started, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Network update did not start')), 10000); })]);
      clearTimeout(deadline);
      if (action !== 'none') {
        const current = { ...old, name: 'Current administrator name', hidden: action === 'hide' };
        const response = await object.fetch(new Request(`https://do/client-${action === 'remove' ? 'remove' : 'meta'}`, {
          method: 'POST', body: JSON.stringify(action === 'remove' ? { uuid: old.uuid }
            : { uuid: old.uuid, name: current.name, hidden: current.hidden, client: current }),
        }));
        assert.equal(response.status, 200);
      }
      const before = viewer.messages.length;
      releaseResolve();
      assert.equal((await pending).status, 400, 'the real route rejects missing Upgrade after its metadata I/O');
      await storage.drain();
      const snapshot = await (await object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
      const row = snapshot.clients.find(client => client.uuid === old.uuid);
      const events = viewer.messages.slice(before);
      if (action === 'remove') {
        assert.equal(row, undefined);
        assert.ok(snapshot.removed.includes(old.uuid));
      } else {
        assert.equal(row.name, action === 'none' ? old.name : 'Current administrator name');
        assert.equal(row.hidden, action === 'hide');
        assert.equal(row.region, 'US', 'legitimate Agent observations still synchronize');
      }
      if (action === 'hide' || action === 'remove') {
        assert.deepEqual(object.buildSnapshot(false).online, []);
        assert.ok(!events.some(message => message.type === 'update' && message.client === old.uuid));
        assert.ok(!events.flatMap(message => message.clients?.upsert || []).some(client => client.uuid === old.uuid));
      } else {
        assert.ok(events.filter(message => message.type === 'update').every(message => message.name === (action === 'none' ? old.name : 'Current administrator name')));
      }
    } finally {
      clearTimeout(deadline);
      releaseResolve();
      await pending;
      await storage.drain();
    }
  });
}
