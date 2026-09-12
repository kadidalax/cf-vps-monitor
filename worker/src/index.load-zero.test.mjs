import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../scripts/test-support/postgres.mjs';
import { notificationHarness } from '../../scripts/test-support/notifications.mjs';

for (const fixture of [{ threshold: 0, ratio: 1 }, { threshold: 80, ratio: 0 }]) {
  test(`AUD-50 load evaluation preserves threshold=${fixture.threshold}, ratio=${fixture.ratio}`, async () => {
    const database = await createTestDatabase();
    try {
      await database.exec(`
        insert into clients(uuid,name) values ('node-a','A');
        insert into records(client,time,cpu) values ('node-a','2026-09-05T23:58:00Z',10),('node-a','2026-09-05T23:59:00Z',10);
      `);
      await database.query("insert into load_notifications(id,name,clients,metric,threshold,ratio,interval_min) values(1,'Zero test','[\"node-a\"]','cpu',$1,$2,15)", [fixture.threshold, fixture.ratio]);
      const delivered = [];
      const h = await notificationHarness(database, subject => { delivered.push(subject); return true; }, {
        getLoadMetricWindowStatsForClients: async (_db, clients, start, end, metric, threshold) => {
          const rows = await rpc(database, 'cfm_load_metric_window_stats', {
            input_clients: clients, input_start: start, input_end: end, input_metric: metric, input_threshold: threshold,
          });
          return new Map(rows.map(row => [row.client, row]));
        },
      });
      await h.run('runLoadCheck', 0);
      assert.deepEqual(delivered, ['load:A'], 'zero is a configured value and must not be replaced by a nonzero default');
    } finally { await database.close(); }
  });
}
