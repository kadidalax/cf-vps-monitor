import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeFixture } from '../test-support/runtime-fixture.mjs';

test('V-W01 native storage accepts the maximum 50-result batch and preserves every interval after a cold restart', { timeout: 90000 }, async t => {
  const f = await createRuntimeFixture({ persistDurableObjects: true });
  t.after(() => f.close());
  const token = 'synthetic-max-ping-batch-token-'.padEnd(64, '0');
  await f.database.query("insert into clients(uuid,name,token) values ('max-batch-node','Synthetic maximum Ping batch',$1)", [token]);
  await f.database.exec(`
    insert into ping_tasks(id,name,type,target,all_clients,interval_sec)
    select id, 'Synthetic Ping ' || id, 'tcp', 'target.audit.example.com:443', 1, 120
    from generate_series(1,50) as tasks(id)
  `);
  const results = Array.from({ length: 50 }, (_, index) => ({ task_id: index + 1, value: 10 + index }));
  const post = () => f.fetch('/api/clients/ping/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ results }),
  });
  const savedValues = async () => (await f.database.query(
    "select values_json from ping_snapshots where client='max-batch-node' order by id",
  )).rows.map(row => row.values_json);
  const expected = Object.fromEntries(results.map(result => [String(result.task_id), result.value]));

  const first = await post();
  assert.equal(first.status, 200, await first.clone().text());
  assert.deepEqual(await first.json(), { success: true, accepted: 50 });
  assert.deepEqual(await savedValues(), [expected], 'all 50 results must reach the real SQL snapshot');

  // The fixture recreates native workerd while retaining its SQLite DO store.
  // A zero accepted count proves all interval markers survived, rather than
  // relying on SQL deduplication alone to conceal missing local state.
  await f.restart();
  const retry = await post();
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.deepEqual(await retry.json(), { success: true, accepted: 0 });
  assert.deepEqual(await savedValues(), [expected], 'a cold retry must retain exactly one complete snapshot');
});
