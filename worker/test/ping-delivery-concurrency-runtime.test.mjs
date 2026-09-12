import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFixture } from '../test-support/runtime-fixture.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('V-W01 all Ping entry points share the same per-client persistence reservation', { timeout: 90000 }, async t => {
  let gate = null;
  const f = await createRuntimeFixture({ rpcHook: async ({ name, args, phase }) => {
    if (name !== 'cfm_insert_ping_snapshot' || phase !== 'before' || args.input_client !== 'serial-node' || !gate || gate.entered) return;
    gate.entered = true;
    gate.started.resolve();
    await gate.release.promise;
  } });
  t.after(() => f.close());
  await f.database.query("insert into clients(uuid,name,token) values ('serial-node','Synthetic serial','synthetic-serial'),('other-node','Synthetic other','synthetic-other')");
  await f.database.query("insert into ping_tasks(id,name,type,target,all_clients,interval_sec) values (1,'Synthetic ping','tcp','target.audit.example.com:443',1,120)");
  const stubFor = async name => {
    const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    return namespace.get(namespace.idFromName(name));
  };
  const post = (stub, format, timestamp, clientId = 'serial-node') => format === 'standalone'
    ? stub.fetch('https://do/ping-result', { method: 'POST', body: JSON.stringify({
      client_id: clientId, timestamp, results: [{ task_id: 1, value: 23, interval_sec: 120 }],
    }) })
    : stub.fetch('https://do/client-report', { method: 'POST', body: JSON.stringify({
      uuid: clientId, name: 'Synthetic serial', report: { cpu: 21, timestamp, ping_results: [{ task_id: 1, value: 23 }] },
    }) });
  const rows = async client => (await f.database.query('select count(*)::int as n from ping_snapshots where client=$1', [client])).rows[0].n;

  for (const firstFormat of ['standalone', 'report']) for (const secondFormat of ['standalone', 'report']) {
    await t.test(`${firstFormat} followed by ${secondFormat} preserves one interval while SQL is waiting`, async () => {
      await f.database.exec('delete from ping_snapshots');
      const stub = await stubFor(`ping-serial-${firstFormat}-${secondFormat}`);
      gate = { entered: false, started: deferred(), release: deferred() };
      const timestamp = Date.now();
      const first = post(stub, firstFormat, timestamp);
      await gate.started.promise;
      const second = post(stub, secondFormat, timestamp + 1);
      // Allow a second native event to reach its reservation while the first
      // SQL request is held. Correctness is asserted on saved rows, not timing.
      await new Promise(resolve => setTimeout(resolve, 60));
      gate.release.resolve();
      const responses = await Promise.all([first, second]);
      gate = null;
      for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
      assert.equal(await rows('serial-node'), 1, 'Overlapping entry points cannot each consume the same Ping interval');
    });
  }

  await t.test('one client waiting for SQL does not block another client', async () => {
    await f.database.exec('delete from ping_snapshots');
    const stub = await stubFor('ping-serial-independent-client');
    gate = { entered: false, started: deferred(), release: deferred() };
    const first = post(stub, 'report', Date.now());
    await gate.started.promise;
    let completedBeforeRelease = false;
    const other = post(stub, 'standalone', Date.now(), 'other-node').then(response => {
      completedBeforeRelease = !released;
      return response;
    });
    let released = false;
    let timer;
    try {
      await Promise.race([other, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    } finally {
      clearTimeout(timer);
      released = true;
      gate.release.resolve();
    }
    const [firstResponse, otherResponse] = await Promise.all([first, other]);
    gate = null;
    assert.equal(firstResponse.status, 200);
    assert.equal(otherResponse.status, 200);
    assert.equal(completedBeforeRelease, true, 'Reservations are per client, not one global external-I/O gate');
    assert.equal(await rows('serial-node'), 1);
    assert.equal(await rows('other-node'), 1);
  });
});
