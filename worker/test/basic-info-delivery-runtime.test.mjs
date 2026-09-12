import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFixture } from '../test-support/runtime-fixture.mjs';

function receipt(ws, envelope) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error('Missing delivery result')); }, 8000);
    const listener = event => {
      const value = JSON.parse(event.data);
      if (!['ack', 'error'].includes(value.type)) return;
      clearTimeout(timer); ws.removeEventListener('message', listener); resolve(value);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify(envelope));
  });
}

test('R-A05 basic-information delivery is acknowledged only after the real SQL update', { timeout: 90000 }, async t => {
  let failUpdate = true;
  const f = await createRuntimeFixture({ rpcHook: ({ name, phase }) => {
    if (name === 'cfm_update_client' && phase === 'before' && failUpdate) {
      return Response.json({ code: 'SYNTHETIC_UNAVAILABLE', message: 'Synthetic metadata SQL outage' }, { status: 503 });
    }
  } });
  t.after(() => f.close());
  const token = 'synthetic-basic-info-token-'.padEnd(64, '0');
  await f.database.query("insert into clients(uuid,name,token,os) values ('basic-info-node','Synthetic basic info',$1,'before')", [token]);
  const storedOs = async () => (await f.database.query("select os from clients where uuid='basic-info-node'")).rows[0].os;
  const post = (path, body) => f.fetch(path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
  }, body: JSON.stringify(body) });
  t.beforeEach(async () => {
    failUpdate = true;
    await f.database.query("update clients set os='before' where uuid='basic-info-node'");
  });

  for (const path of ['/api/clients/uploadBasicInfo', '/api/clients/report']) {
    await t.test(`${path} retains delivery on SQL failure and saves an identical retry`, async () => {
      const basic = { os: `confirmed-${path.split('/').at(-1)}` };
      const body = path.endsWith('/report') ? { cpu: 21, basic_info: basic } : basic;
      const rejected = await post(path, body);
      assert.ok(rejected.status >= 500, 'An unsaved basic-info update must not look accepted');
      assert.equal(await storedOs(), 'before');
      failUpdate = false;
      const accepted = await post(path, body);
      assert.equal(accepted.status, 200, await accepted.clone().text());
      assert.equal(await storedOs(), basic.os, 'HTTP success must correspond to the persisted basic info');
    });
  }

  for (const type of ['report', 'reports']) {
    await t.test(`WebSocket ${type} retains basic info on error and acknowledges a persisted retry`, async () => {
      const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
      const stub = namespace.get(namespace.idFromName(`basic-info-${type}`));
      const upgraded = await stub.fetch('https://do/?role=agent&id=basic-info-node&name=Synthetic', { headers: { Upgrade: 'websocket' } });
      assert.equal(upgraded.status, 101);
      const ws = upgraded.webSocket;
      ws.accept();
      t.after(() => { try { ws.close(); } catch {} });
      const report = { cpu: 22, timestamp: Date.now(), basic_info: { os: `confirmed-${type}` } };
      const envelope = type === 'report' ? { type, data: report } : { type, reports: [report] };
      assert.equal((await receipt(ws, envelope)).type, 'error', 'An unsaved WebSocket basic-info update must retain its lease');
      assert.equal(await storedOs(), 'before');
      failUpdate = false;
      assert.equal((await receipt(ws, envelope)).type, 'ack');
      assert.equal(await storedOs(), report.basic_info.os);
    });
  }
});
