import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

async function reportDiskTotal(path, diskTotal) {
  const token = 'a'.repeat(64);
  let row = { uuid: 'node', name: 'Managed node', hidden: false, token,
    disk_total: 983_000_000_000, os: 'Linux', ipv4: '', ipv6: '', region: '',
    updated_at: '2026-09-10T00:00:00Z' };
  const storage = createDurableState([['admin-clients:snapshot', {
    clients: [structuredClone(row)], updatedAt: Date.now() - 1, removed: [], complete: true,
  }]]);
  const loader = createWorkerLoader({ db: {
    getClientByToken: async () => structuredClone(row), getClient: async () => structuredClone(row),
    getSettingsByKeys: async () => ({ record_enabled: 'false' }), getSetting: async () => null,
    updateClient: async (_database, _uuid, patch) => { row = { ...row, ...patch }; },
    markClientTokenUsed: async () => false, listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
    insertAuditLog: async () => {}, tryClaimAuditThrottle: async () => true, setSetting: async () => {},
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(storage.state, {});
  const env = {
    LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: request => object.fetch(request) }) },
    RATE_LIMIT: { idFromName: value => value, get: () => ({ fetch: async () => Response.json({ allowed: true, limit: 100, remaining: 99, retryAfter: 0 }) }) },
  };
  const app = new Hono();
  app.route('/api', loader.load('worker/src/routes/client.ts').clientRoutes);
  const basicInfo = { os: 'Fresh Linux', ...(diskTotal === undefined ? {} : { disk_total: diskTotal }) };
  const response = await app.fetch(new Request(`https://monitor.example.test/api${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(path === '/uploadBasicInfo' ? basicInfo : { cpu: 2, basic_info: basicInfo }),
  }), env, { waitUntil: promise => storage.state.waitUntil(promise) });
  assert.equal(response.status, 200, await response.text());
  await storage.drain();
  const metadata = await (await object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
  return { row, cached: metadata.clients.find(client => client.uuid === 'node') };
}

for (const path of ['/uploadBasicInfo', '/report']) {
  for (const [value, expected] of [[null, 0], [undefined, 983_000_000_000], [5024_000_000, 5024_000_000]]) {
    test(`${path} disk total ${value} clears unknown metadata without losing known quotas or legacy omission`, async () => {
      const result = await reportDiskTotal(path, value);
      assert.equal(result.row.disk_total, expected);
      assert.equal(result.cached.disk_total, expected);
    });
  }
}
