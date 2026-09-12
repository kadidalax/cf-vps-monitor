import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';

function fixture(client) {
  const loader = createWorkerLoader({
    db: {
      getSettingsByKeys: async () => ({}), getClient: async () => client,
      listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
    },
    expose: { 'worker/src/routes/client.ts': ['fallbackAgentPolicy'] },
  });
  return { loader, ...loader.load('worker/src/routes/client.ts') };
}

test('AUD-29: HTTP and WebSocket policies carry the same authoritative traffic reset day', async () => {
  const client = { uuid: 'node', traffic_reset_day: 15, token: 'synthetic-private-token' };
  const f = fixture(client);
  const http = await f.fallbackAgentPolicy(f.loader.database, 'node');
  assert.equal(http.traffic_reset_day, 15);
  assert.ok(!JSON.stringify(http).includes(client.token));
  const state = createDurableState([['admin-clients:snapshot', { clients: [client], removed: [], updatedAt: Date.now() }]]);
  const { LiveDataDO } = f.loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(state.state, {});
  const ws = await object.buildAgentPolicy(Date.now(), false, false, 'node');
  assert.equal(ws.traffic_reset_day, http.traffic_reset_day);
});

test('AUD-29: missing or invalid server reset day does not overwrite a locally configured day', async () => {
  for (const client of [null, {}, { traffic_reset_day: 0 }, { traffic_reset_day: 32 }]) {
    const f = fixture(client);
    const policy = JSON.parse(JSON.stringify(await f.fallbackAgentPolicy(f.loader.database, 'node')));
    assert.ok(!Object.hasOwn(policy, 'traffic_reset_day'));
  }
});
