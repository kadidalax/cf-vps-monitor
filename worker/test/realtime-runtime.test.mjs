import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFixture, eventually } from '../test-support/runtime-fixture.mjs';

function awaitMessage(ws, type, send) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error(`Missing ${type}`)); }, 8000);
    const listener = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'error') { clearTimeout(timeout); ws.removeEventListener('message', listener); reject(new Error(message.code)); }
      if (message.type !== type) return;
      clearTimeout(timeout);
      ws.removeEventListener('message', listener);
      resolve(message);
    };
    ws.addEventListener('message', listener);
    send?.();
  });
}

test('AUD-30/32/35/37: actual Durable Objects preserve bounded reports, all Ping batches and HTTP state', { timeout: 90000 }, async t => {
  const f = await createRuntimeFixture({ persistDurableObjects: true });
  t.after(() => f.close());
  await f.database.query("insert into clients(uuid,name) values ('runtime-node','Runtime fixture'), ('http-node','HTTP fixture')");
  await f.database.exec(`insert into ping_tasks(name,type,target,all_clients,interval_sec)
    select 'synthetic-'||i, 'tcp', 'example.test:443', 1, 120 from generate_series(1,1000) i`);
  const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
  const stub = namespace.get(namespace.idFromName('runtime-ws'));
  const response = await stub.fetch('https://do/?role=agent&id=runtime-node&name=Runtime', { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const ws = response.webSocket;
  ws.accept();
  t.after(() => { try { ws.close(); } catch {} });

  await t.test('a native attachment accepts large extensions without dropping metrics or history', async () => {
    const raw = {
      type: 'report', data: { cpu: 17, timestamp: Date.now() - 3600000,
        arbitrary_extension: 'x'.repeat(20000), basic_info: { os: '中'.repeat(9000), ipv4: '10.77.0.5' },
        gpus: Array.from({ length: 16 }, (_, device_index) => ({ device_index, device_name: '图'.repeat(128), mem_total: 1000, mem_used: 100, utilization: 10, temperature: 40 })),
      },
    };
    await awaitMessage(ws, 'ack', () => ws.send(JSON.stringify(raw)));
    await eventually(async () => (await f.database.query("select count(*)::int as count from records where client='runtime-node' and cpu=17")).rows[0].count === 1);
    const live = await (await stub.fetch('https://do/live')).json();
    assert.equal(live.data['runtime-node'].cpu, 17);
    assert.equal(live.data['runtime-node'].gpus.length, 16);
    assert.ok(!JSON.stringify(live).includes('10.77.0.5'));
    const liveness = await (await stub.fetch('https://do/offline-evaluate', { method: 'POST', body: JSON.stringify({ clients: [{ uuid: 'runtime-node', graceMs: 180000 }] }) })).json();
    assert.equal(liveness.clients['runtime-node'].offline, false);
  });

  await t.test('twenty fifty-item batches at one sample timestamp retain all 1000 task results', async () => {
    const timestamp = Date.now();
    const reports = Array.from({ length: 20 }, (_, batch) => ({ cpu: 17, timestamp,
      ping_results: Array.from({ length: 50 }, (_, offset) => ({ task_id: batch * 50 + offset + 1, value: 10 })),
    }));
    await awaitMessage(ws, 'ack', () => ws.send(JSON.stringify({ type: 'reports', reports })));
    await eventually(async () => (await f.database.query(`
      select count(distinct item.key)::int as count from ping_snapshots p
      cross join lateral jsonb_each(p.values_json) item where p.client='runtime-node'
    `)).rows[0].count === 1000, 15000);
  });

  await t.test('HTTP state survives a native Worker restart when history is disabled', async () => {
    await f.database.query("update settings set value='false' where key='record_enabled'");
    const http = namespace.get(namespace.idFromName('runtime-http'));
    const response = await http.fetch('https://do/client-report', { method: 'POST', body: JSON.stringify({
      uuid: 'http-node', name: 'HTTP fixture', ttl_ms: 180000, timestamp: Date.now(), report: { cpu: 29, timestamp: Date.now() },
    }) });
    assert.equal(response.status, 200);
    assert.equal((await (await http.fetch('https://do/live')).json()).data['http-node'].cpu, 29);
    await f.restart();
    const restartedNamespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    const restarted = restartedNamespace.get(restartedNamespace.idFromName('runtime-http'));
    const live = await (await restarted.fetch('https://do/live')).json();
    assert.equal(live.data['http-node'].cpu, 29);
    assert.equal((await f.database.query("select count(*)::int as count from records where client='http-node'")).rows[0].count, 0);
  });
});
