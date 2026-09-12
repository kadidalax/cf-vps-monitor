import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFixture, eventually } from '../test-support/runtime-fixture.mjs';

test('R-A11 native reports preserve null, zero and measured Celsius in SQL and cold public live state', { timeout: 45000 }, async t => {
  const f = await createRuntimeFixture({ persistDurableObjects: true });
  t.after(() => f.close());
  const temperatures = [null, 0, -5, 42.25];
  const getStub = async name => {
    const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    return namespace.get(namespace.idFromName(name));
  };
  for (const [index, temp] of temperatures.entries()) {
    const uuid = `synthetic-temperature-${index}`;
    await f.database.query('insert into clients(uuid,name) values ($1,$2)', [uuid, 'Synthetic temperature']);
    const stub = await getStub(uuid);
    const response = await stub.fetch('https://do/client-report', { method: 'POST', body: JSON.stringify({
      uuid, name: 'Synthetic temperature', report: { cpu: 37, temp, timestamp: Date.now() },
    }) });
    assert.equal(response.status, 200);
    await eventually(async () => (await f.database.query('select temp from records where client=$1', [uuid])).rows.length === 1);
    const row = (await f.database.query('select temp,cpu from records where client=$1', [uuid])).rows[0];
    assert.deepEqual(row, { temp, cpu: 37 }, 'Unknown temperature must not remove the CPU sample or turn into zero');
    const live = await (await stub.fetch('https://do/live')).json();
    assert.equal(live.data[uuid].temp, temp);
  }
  await f.restart();
  for (const [index, temp] of temperatures.entries()) {
    const uuid = `synthetic-temperature-${index}`;
    const live = await (await (await getStub(uuid)).fetch('https://do/live')).json();
    assert.equal(live.data[uuid].temp, temp, 'A cold public snapshot preserves the measured/unavailable distinction');
    assert.equal(live.data[uuid].cpu, 37);
  }
});
