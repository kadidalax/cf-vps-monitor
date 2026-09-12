import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

const loader = createWorkerLoader({ expose: { 'worker/src/routes/client.ts': ['updateLiveReport'] } });
const { updateLiveReport } = loader.load('worker/src/routes/client.ts');
const { normalizeMonitorReport } = loader.load('worker/src/utils/monitor-report.ts');

function context(reply) {
  return {
    env: { LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: reply }) } },
    req: { raw: new Request('https://monitor.example.test/api/report'), header: () => undefined },
  };
}

for (const status of [409, 503]) {
  test(`ordinary HTTP reports propagate a rejected durable receipt (${status})`, async () => {
    await assert.rejects(updateLiveReport(context(async () => Response.json({ error: 'Report was not accepted' }, { status })),
      'node', 'Fixture', false, normalizeMonitorReport({ cpu: 23 }), Date.now()));
  });
}

test('a valid live receipt is accepted while ordinary history remains asynchronous', async () => {
  const persisted = await updateLiveReport(context(async () => Response.json({ success: true, persisted: false, queued: true })),
    'node', 'Fixture', false, normalizeMonitorReport({ cpu: 23 }), Date.now());
  assert.equal(persisted, false);
});

test('the authenticated ordinary HTTP route fails an unpersisted report and accepts its saved retry', async () => {
  const token = 'a'.repeat(64);
  const row = { uuid: 'node', name: 'Fixture', token, hidden: false, ipv4: '', ipv6: '', region: '' };
  const state = createDurableState();
  const put = state.state.storage.put;
  let fail = true;
  state.state.storage.put = async (key, value) => {
    if (fail && key === 'http-live:node') throw new Error('Synthetic durable snapshot rejection');
    return put(key, value);
  };
  const production = createWorkerLoader({ db: {
    getClientByToken: async () => row, getClient: async () => row,
    markClientTokenUsed: async () => false, getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    getSetting: async () => null, setSetting: async () => {}, updateClient: async () => {},
    listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
    insertAuditLog: async () => {}, tryClaimAuditThrottle: async () => true,
  } });
  const { LiveDataDO } = production.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(state.state, {});
  const env = {
    LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: request => object.fetch(request) }) },
    RATE_LIMIT: { idFromName: value => value, get: () => ({ fetch: async () => Response.json({ allowed: true, limit: 100, remaining: 99, retryAfter: 0 }) }) },
  };
  const app = new Hono();
  app.route('/api', production.load('worker/src/routes/client.ts').clientRoutes);
  const send = cpu => app.fetch(new Request('https://monitor.example.test/api/report', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cpu }),
  }), env, { waitUntil: promise => state.state.waitUntil(promise) });
  const rejected = await send(23);
  assert.equal(rejected.status, 500);
  assert.equal(state.values.has('http-live:node'), false);
  fail = false;
  const accepted = await send(24);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { success: true, persisted: false });
  assert.equal(state.values.get('http-live:node').lastReport.cpu, 24);
  await state.drain();
});
