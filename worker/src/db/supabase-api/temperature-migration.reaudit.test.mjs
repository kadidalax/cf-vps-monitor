import assert from 'node:assert/strict';
import test from 'node:test';
import { applyApplicationMigrations, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

test('R-A11 upgrading and replaying legacy temperature storage preserves old zero and new unavailable values', async () => {
  const sql = await createTestDatabase();
  try {
    await sql.exec(`insert into clients(uuid,name) values ('temperature-migration','Synthetic');
      alter table records alter column temp set not null;
      alter table records alter column temp set default 0;
      insert into records(client,time,temp) values ('temperature-migration','2026-09-08T00:00:00Z',0);`);
    await applyApplicationMigrations(sql);
    for (const [time, temp] of [['2026-09-09T00:00:00Z', undefined], ['2026-09-09T00:01:00Z', null], ['2026-09-09T00:02:00Z', 0]]) {
      await rpc(sql, 'cfm_insert_monitor_record', { input_record: { client: 'temperature-migration', time, cpu: 10, temp } });
    }
    assert.deepEqual((await sql.query("select temp from records where client='temperature-migration' order by time")).rows.map(row => row.temp), [0, null, null, 0]);
    await applyApplicationMigrations(sql);
    await sql.exec("insert into records(client,time) values ('temperature-migration','2026-09-09T00:03:00Z')");
    assert.deepEqual((await sql.query("select temp from records where client='temperature-migration' order by time")).rows.map(row => row.temp), [0, null, null, 0, null]);
  } finally { await sql.close(); }
});
