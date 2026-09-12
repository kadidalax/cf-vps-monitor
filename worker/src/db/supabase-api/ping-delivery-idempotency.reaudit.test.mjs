import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

test('V-W01 Ping retries are idempotent without losing separate task batches at one timestamp', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await database.query("insert into clients(uuid,name) values ('delivery-node','Synthetic delivery fixture')");
  const args = { input_client: 'delivery-node', input_time: '2026-09-09T00:00:00Z' };
  await rpc(database, 'cfm_insert_ping_snapshot', { ...args, input_results: [{ taskId: 1, value: 10 }, { taskId: 2, value: 20 }] });
  await rpc(database, 'cfm_insert_ping_snapshot', { ...args, input_results: [{ taskId: 2, value: 20 }, { taskId: 1, value: 10 }] });
  await rpc(database, 'cfm_insert_ping_snapshot', { ...args, input_results: [{ taskId: 3, value: 30 }] });
  const rows = (await database.query('select values_json from ping_snapshots order by id')).rows;
  assert.equal(rows.length, 2, 'Reordered delivery retries must not duplicate already committed history');
  assert.deepEqual(rows.map(row => row.values_json), [{ 1: 10, 2: 20 }, { 3: 30 }]);
});
