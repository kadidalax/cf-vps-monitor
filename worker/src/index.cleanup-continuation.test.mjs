import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../scripts/test-support/postgres.mjs';
import { loadTypeScriptFunctions } from '../../scripts/test-support/typescript.mjs';

async function cleanupHarness(database) {
  let recordCalls = 0;
  const deletes = name => async (_connection, before, options = {}) => {
    if (name === 'cfm_delete_old_records') recordCalls += 1;
    return rpc(database, name, { input_before_time: before, input_max_batches: options.maxBatches });
  };
  const { runRecordCleanup } = await loadTypeScriptFunctions(new URL('./index.ts', import.meta.url), ['runRecordCleanup'], {
    RECORD_CLEANUP_LAST_RUN_KEY: 'maintenance_last_cleanup_at', RECORD_CLEANUP_INTERVAL_MS: 86_400_000,
    db: {
      deleteOldRecords: deletes('cfm_delete_old_records'),
      deleteOldWebsiteChecks: deletes('cfm_delete_old_website_checks'),
      deleteOldPingRecords: deletes('cfm_delete_old_ping_records'),
      deleteOldAuditLogs: deletes('cfm_delete_old_audit_logs'),
      cleanupNotificationDeliveryState: (_connection, now, options = {}) => rpc(database, 'cfm_cleanup_notification_delivery_state', {
        input_now: now, input_batch_size: options.batchSize, input_max_batches: options.maxBatches,
      }),
      setSetting: (_connection, key, value) => rpc(database, 'cfm_set_settings', { input_settings: { [key]: value } }),
      insertAuditLog: (_connection, user, action, detail) => rpc(database, 'cfm_insert_audit_log', {
        input_user: user, input_action: action, input_detail: detail,
      }),
    },
  });
  return {
    run: now => runRecordCleanup({ database: {}, getSettings: () => rpc(database, 'cfm_public_settings') }, now),
    calls: () => recordCalls,
  };
}

test('AUD-07 a full cleanup batch continues next Cron before recording completion', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec(`
      insert into clients (uuid, name) values ('node-a', 'Synthetic');
      insert into records (client,time) select 'node-a', '2026-09-01T00:00:00Z'::timestamptz - n * interval '1 second'
        from generate_series(1,36000) n;
      insert into records (client,time) values ('node-a','2026-09-06T00:00:00Z');
    `);
    const cleanup = await cleanupHarness(database);
    await cleanup.run(new Date('2026-09-06T00:00:00Z'));
    assert.equal((await database.query('select count(*)::integer as count from records')).rows[0].count, 16001);
    assert.equal((await rpc(database, 'cfm_public_settings')).maintenance_last_cleanup_at, undefined,
      'unfinished cleanup must not be stamped completed for the next 24 hours');
    await cleanup.run(new Date('2026-09-06T00:02:00Z'));
    assert.equal(cleanup.calls(), 2);
    assert.deepEqual((await database.query('select client from records')).rows, [{ client: 'node-a' }]);
    assert.equal((await rpc(database, 'cfm_public_settings')).maintenance_last_cleanup_at, '2026-09-06T00:02:00.000Z');
    await cleanup.run(new Date('2026-09-06T00:04:00Z'));
    assert.equal(cleanup.calls(), 2, 'drained cleanup keeps its low-frequency idle schedule');
  } finally {
    await database.close();
  }
});

test('AUD-07 seven days of 50 nodes at 120 seconds do not accumulate expired history', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec("insert into clients (uuid) select 'node-' || n from generate_series(1,50) n;");
    const cleanup = await cleanupHarness(database);
    for (let day = 0; day < 7; day += 1) {
      const start = Date.parse('2026-09-01T00:00:00Z') + day * 86_400_000;
      await database.query(`
        insert into records (client,time)
        select 'node-' || ((n-1) % 50 + 1), $1::timestamptz + ((n-1) / 50) * interval '120 seconds'
        from generate_series(1,36000) n
      `, [new Date(start).toISOString()]);
      let expired = 0;
      for (let round = 0; round < 12; round += 1) {
        const now = new Date(start + 86_400_000 + round * 120_000);
        await cleanup.run(now);
        expired = (await database.query(
          'select count(*)::integer as count from records where time < $1::timestamptz',
          [new Date(now.getTime() - 72 * 3_600_000).toISOString()],
        )).rows[0].count;
        if (expired === 0) break;
      }
      assert.equal(expired, 0, `day ${day + 1} backlog must drain through bounded continuation`);
    }
  } finally {
    await database.close();
  }
});

test('AUD-07 small delete budgets report remaining work for every history family', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec(`
      insert into clients (uuid) values ('node-a');
      insert into website_monitors (id,name,url) values (1,'Synthetic','https://example.com');
      insert into website_checks (monitor_id,checked_at,ok) select 1,'2026-01-01',true from generate_series(1,101);
      insert into ping_snapshots (client,time) select 'node-a','2026-01-01' from generate_series(1,101);
      insert into audit_logs (time) select '2026-01-01' from generate_series(1,101);
    `);
    for (const name of ['cfm_delete_old_website_checks', 'cfm_delete_old_ping_records', 'cfm_delete_old_audit_logs']) {
      const input = { input_before_time: '2026-09-01', input_max_batches: 1 };
      assert.equal((await rpc(database, name, input)).has_more, true, `${name} reports bounded backlog`);
      assert.equal((await rpc(database, name, input)).has_more, false, `${name} reports drained backlog`);
    }
  } finally {
    await database.close();
  }
});
