import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFixture, eventually } from '../test-support/runtime-fixture.mjs';

function reportAndAck(ws, report) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timeout);
      ws.removeEventListener('message', listener);
      if (error) reject(error); else resolve(value);
    };
    const listener = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'error') finish(new Error(message.code));
      else if (message.type === 'ack') finish(null, message);
    };
    const timeout = setTimeout(() => finish(new Error('A durable report was not acknowledged')), 8000);
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ type: 'report', data: report }));
  });
}

test('native Durable Object storage retains offline HTTP and WebSocket metrics across Worker restarts', { timeout: 90000 }, async t => {
  const f = await createRuntimeFixture({
    persistDurableObjects: true,
    rpcHook: ({ name, phase }) => name === 'cfm_settings_by_keys' && phase === 'before'
      ? Response.json({ record_enabled: 'false' }) : undefined,
  });
  t.after(() => f.close());
  const controls = [
    { uuid: 'offline-ws', name: 'Stored socket', hidden: false, sort_order: 4 },
    { uuid: 'offline-http', name: 'Stored HTTP', hidden: false, sort_order: 2 },
  ];
  const getStub = async () => {
    const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    return namespace.get(namespace.idFromName('global'));
  };
  let stub = await getStub();
  const mutate = (path, value, method = 'POST') => stub.fetch(`https://do/${path}`, { method, body: JSON.stringify(value) });
  const snapshot = async (includeHidden = false) => (await stub.fetch(`https://do/live${includeHidden ? '?include_hidden=1' : ''}`)).json();
  assert.equal((await mutate('admin-clients-snapshot', { clients: controls }, 'PUT')).status, 200);

  const upgraded = await stub.fetch('https://do/?role=agent&id=offline-ws&name=Agent', { headers: { Upgrade: 'websocket' } });
  assert.equal(upgraded.status, 101);
  const ws = upgraded.webSocket;
  ws.accept();
  t.after(() => { try { ws.close(); } catch {} });
  const sampledAt = Date.now() - 2000;
  await reportAndAck(ws, { cpu: 47, disk: null, disk_total: 5024_000_000, uptime: null,
    sort_order: -999, timestamp: sampledAt, arbitrary_extension: 'PRIVATE_RUNTIME_EXTENSION' });
  ws.close();
  await eventually(async () => !(await snapshot()).online.includes('offline-ws'));

  await t.test('a closed native socket remains displayable through public HTTP without becoming online', async () => {
    const response = await f.fetch('/api/live/clients');
    assert.equal(response.status, 200);
    const live = await response.json();
    assert.deepEqual(live.online, []);
    assert.equal(live.last_known['offline-ws'].cpu, 47);
    assert.equal(live.last_known['offline-ws'].disk, null);
    assert.equal(live.last_known['offline-ws'].disk_total, 5024_000_000);
    assert.equal(live.last_known['offline-ws'].uptime, null);
    assert.equal(live.last_known['offline-ws'].timestamp, sampledAt);
    assert.equal(live.last_known['offline-ws'].sort_order, 4);
    assert.ok(!JSON.stringify(live).includes('PRIVATE_RUNTIME_EXTENSION'));
  });

  const httpAcceptedAt = Date.now();
  assert.equal((await mutate('client-report', { uuid: 'offline-http', name: 'HTTP', ttl_ms: 30000,
    report: { cpu: 19, disk: 0, disk_total: 1000, uptime: 45, timestamp: httpAcceptedAt },
  })).status, 200);
  const httpReceiptTime = (await snapshot()).data['offline-http'].lastReportTime;
  assert.ok(httpReceiptTime >= httpAcceptedAt);
  await f.restart();
  stub = await getStub();
  await t.test('native reconstruction keeps the HTTP lease and never recreates a closed WebSocket lease', async () => {
    const live = await snapshot();
    assert.deepEqual(live.online, ['offline-http']);
    assert.equal(live.data['offline-http'].cpu, 19);
    assert.equal(live.last_known['offline-ws'].cpu, 47);
  });

  // Exercise the actual minimum HTTP lease and native expiry alarm.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, httpReceiptTime + 31000 - Date.now())));
  await t.test('native HTTP expiry retains the original receipt time and final measurements', async () => {
    const live = await snapshot();
    assert.deepEqual(live.online, []);
    assert.equal(live.last_known['offline-http'].cpu, 19);
    assert.equal(live.last_known['offline-http'].disk, 0);
    assert.equal(live.last_known['offline-http'].disk_total, 1000);
    assert.equal(live.last_known['offline-http'].lastReportTime, httpReceiptTime);
  });

  const hidden = { ...controls[0], hidden: true, name: 'Hidden stored socket' };
  await mutate('client-meta', { uuid: hidden.uuid, name: hidden.name, hidden: true, client: hidden });
  await f.restart();
  stub = await getStub();
  await t.test('hidden offline reports remain private after a native restart', async () => {
    assert.equal((await snapshot()).last_known['offline-ws'], undefined);
    assert.equal((await snapshot(true)).last_known['offline-ws'].name, hidden.name);
    assert.equal((await snapshot()).last_known['offline-http'].cpu, 19);
  });
  await mutate('client-remove', { uuid: 'offline-ws' });
  await mutate('clients-restore', { clients: controls });
  await f.restart();
  stub = await getStub();
  const cleared = await snapshot(true);
  assert.deepEqual(cleared.online, []);
  assert.deepEqual(cleared.last_known, {});
});
