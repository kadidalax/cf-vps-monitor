import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFixture, eventually } from '../test-support/runtime-fixture.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('V-W01: actual probe delivery acknowledges only accepted data and retries SQL failures', { timeout: 90000 }, async t => {
  let mode = 'pass';
  let target = 'cfm_insert_ping_snapshot';
  let gate = deferred();
  let reached = deferred();
  const f = await createRuntimeFixture({ persistDurableObjects: true, rpcHook: async ({ name, phase }) => {
    if (name !== target) return;
    if (phase === 'after') {
      if (mode === 'lost-receipt') return Response.json({ code: 'SYNTHETIC_LOST_RECEIPT', message: 'Committed result, lost response' }, { status: 503 });
      return;
    }
    reached.resolve();
    if (mode === 'delay') await gate.promise;
    if (mode === 'reject') return Response.json({ code: 'SYNTHETIC_UNAVAILABLE', message: 'Synthetic SQL outage' }, { status: 503 });
  } });
  t.after(() => f.close());
  const token = 'synthetic-probe-token-'.padEnd(64, '0');
  await f.database.query("insert into clients(uuid,name,token) values ('probe-node','Synthetic probe fixture',$1)", [token]);
  await f.database.query("insert into ping_tasks(id,name,type,target,all_clients,interval_sec) values (1,'Synthetic TCP','tcp','example.test:443',1,120)");
  await f.database.query("insert into website_monitors(id,name,url,agent_probe_mode,agent_probe_clients) values (1,'Synthetic website','https://example.test/','selected','[\"probe-node\"]')");
  const getStub = async name => {
    const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    return namespace.get(namespace.idFromName(name));
  };
  const report = { cpu: 19, timestamp: Date.now(), ping_results: [{ task_id: 1, value: 23 }] };
  const postReport = (stub, data = report) => stub.fetch('https://do/client-report', { method: 'POST', body: JSON.stringify({
    uuid: 'probe-node', name: 'Synthetic probe fixture', report: data,
  }) });
  const publicReport = data => f.fetch('/api/clients/report', { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
  }, body: JSON.stringify(data) });
  const rowCount = async () => (await f.database.query("select count(*)::int as count from ping_snapshots where client='probe-node'")).rows[0].count;
  const nextTurn = () => new Promise(resolve => setTimeout(resolve, 40));
  t.beforeEach(async () => {
    mode = 'pass'; target = 'cfm_insert_ping_snapshot'; gate = deferred(); reached = deferred();
    await f.database.exec('delete from ping_snapshots');
    await f.database.query("update settings set value='true' where key='record_enabled'");
  });

  await t.test('HTTP success waits for the probe insert', async () => {
    const stub = await getStub('probe-http-delay');
    mode = 'delay';
    let settled = false;
    const pending = postReport(stub).then(response => { settled = true; return response; });
    await reached.promise;
    await nextTurn();
    const early = settled;
    const rowsWhileBlocked = await rowCount();
    gate.resolve();
    const response = await pending;
    await eventually(async () => await rowCount() === 1);
    assert.equal(rowsWhileBlocked, 0);
    assert.equal(early, false, 'HTTP success must not release Agent leases before the delayed SQL insert');
    assert.equal(response.status, 200);
    assert.equal(await rowCount(), 1);
  });

  for (const format of ['report', 'reports']) await t.test(`WebSocket ${format} ACK waits for the probe insert`, async () => {
    const stub = await getStub(`probe-ws-delay-${format}`);
    const upgraded = await stub.fetch('https://do/?role=agent&id=probe-node&name=Synthetic', { headers: { Upgrade: 'websocket' } });
    assert.equal(upgraded.status, 101);
    const ws = upgraded.webSocket;
    ws.accept();
    t.after(() => { try { ws.close(); } catch {} });
    const ack = deferred();
    let acknowledged = false;
    ws.addEventListener('message', event => {
      if (JSON.parse(event.data).type === 'ack') { acknowledged = true; ack.resolve(); }
    });
    mode = 'delay';
    ws.send(JSON.stringify(format === 'report' ? { type: format, data: report } : { type: format, reports: [report] }));
    await reached.promise;
    await nextTurn();
    const early = acknowledged;
    gate.resolve();
    await ack.promise;
    await eventually(async () => await rowCount() === 1);
    assert.equal(early, false, 'A WebSocket ACK must not precede the delayed SQL insert');
    assert.equal(await rowCount(), 1);
  });

  await t.test('a rejected write returns failure, then the identical HTTP report survives a cold retry', async () => {
    let stub = await getStub('probe-http-retry');
    mode = 'reject';
    const rejected = await postReport(stub);
    await reached.promise;
    await nextTurn();
    const rejectedStatus = rejected.status;
    assert.equal(await rowCount(), 0);
    mode = 'pass';
    await f.restart();
    stub = await getStub('probe-http-retry');
    const accepted = await postReport(stub);
    await nextTurn();
    assert.ok(rejectedStatus >= 500, 'Database rejection must not return a successful report acknowledgement');
    assert.equal(accepted.status, 200);
    assert.equal(await rowCount(), 1, 'A failed write cannot consume the retry interval across a cold reconstruction');
    assert.equal((await postReport(stub)).status, 200);
    assert.equal(await rowCount(), 1, 'An already accepted report is not duplicated on retry');
  });

  await t.test('the public HTTP Agent route propagates a rejected probe instead of success', async () => {
    mode = 'reject';
    const response = await publicReport(report);
    assert.notEqual(response.status, 404, 'The test must use the real report route');
    await reached.promise;
    assert.ok(response.status >= 500, 'The outer route must retain the Agent probe lease too');
    assert.equal(await rowCount(), 0);
  });

  await t.test('a committed insert with a lost response is retryable without duplicate history', async () => {
    let stub = await getStub('probe-lost-receipt');
    mode = 'lost-receipt';
    const response = await postReport(stub);
    await eventually(async () => await rowCount() === 1);
    mode = 'pass';
    await f.restart();
    stub = await getStub('probe-lost-receipt');
    const retry = await postReport(stub);
    assert.ok(response.status >= 500, 'Lost database confirmation cannot be treated as receipt');
    assert.equal(retry.status, 200);
    assert.equal(await rowCount(), 1, 'A database retry after commit must be idempotent');
  });

  await t.test('an explicit disabled-history policy accepts the report without trying to save probes', async () => {
    await f.database.query("update settings set value='false' where key='record_enabled'");
    const stub = await getStub('probe-disabled');
    mode = 'reject';
    const response = await postReport(stub);
    assert.equal(response.status, 200);
    assert.equal(await rowCount(), 0);
  });

  for (const rpcName of ['cfm_record_website_check', 'cfm_agent_website_probe_tasks']) await t.test(`website probe ${rpcName} failure prevents report acceptance`, async () => {
    const monitor = (await f.database.query('select * from website_monitors where id=1')).rows[0];
    const stub = await getStub(`website-probe-failure-${rpcName}`);
    target = rpcName; mode = 'reject';
    const response = await postReport(stub, { cpu: 19, timestamp: Date.now(), website_probe_results: [{
      monitor_id: 1, config_revision: monitor.config_revision,
      ok: true, effective_status: 'up', status_code: 200, raw_status_code: 200, latency_ms: 23,
    }] });
    await reached.promise;
    assert.ok(response.status >= 500, 'A website result is covered by the same delivery receipt');
  });
});
