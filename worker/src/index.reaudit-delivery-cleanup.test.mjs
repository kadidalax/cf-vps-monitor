import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../scripts/test-support/postgres.mjs';
import { loadTypeScriptFunctions } from '../../scripts/test-support/typescript.mjs';
import { ScheduledBudget, ScheduledBudgetExceeded } from './utils/scheduled-budget.ts';

async function fixture(t) {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const calls = [];
  const transport = (name, args) => { calls.push(name); return rpc(database, name, args); };
  const history = name => (_db, before) => transport(name, { input_before_time: before });
  const { runRecordCleanup } = await loadTypeScriptFunctions(new URL('./index.ts', import.meta.url), ['runRecordCleanup'], {
    RECORD_CLEANUP_LAST_RUN_KEY: 'maintenance_last_cleanup_at', RECORD_CLEANUP_INTERVAL_MS: 86400000,
    db: {
      deleteOldRecords: history('cfm_delete_old_records'),
      deleteOldWebsiteChecks: history('cfm_delete_old_website_checks'),
      deleteOldPingRecords: history('cfm_delete_old_ping_records'),
      deleteOldAuditLogs: history('cfm_delete_old_audit_logs'),
      cleanupNotificationDeliveryState: (_db, now, options = {}) => transport('cfm_cleanup_notification_delivery_state', {
        input_now: now, input_batch_size: options.batchSize, input_max_batches: options.maxBatches,
      }),
      setSetting: (_db, key, value) => transport('cfm_set_settings', { input_settings: { [key]: value } }),
      insertAuditLog: (_db, user, action, detail) => transport('cfm_insert_audit_log', { input_user: user, input_action: action, input_detail: detail }),
    },
  });
  const run = (now, budget) => runRecordCleanup({ database: {}, budget, getSettings: () => rpc(database, 'cfm_public_settings') }, new Date(now));
  const count = async () => (await database.query('select count(*)::int as n from cfm_internal.notification_delivery_state')).rows[0].n;
  const completion = async () => (await rpc(database, 'cfm_public_settings')).maintenance_last_cleanup_at;
  return { database, calls, run, count, completion };
}

test('R-D06 orphan delivery cleanup continues bounded batches before the daily completion stamp', async t => {
  const f = await fixture(t);
  await f.database.exec(`insert into cfm_internal.notification_delivery_state(key,event_id,status,attempts,next_attempt_at,updated_at)
    select 'website:'||n,'synthetic-old-event','failed',1,'2026-01-01','2026-01-01' from generate_series(1,1001) n`);
  await f.run('2026-09-09T00:00:00Z');
  assert.equal(await f.count(), 1, 'One bounded 1000-row batch leaves the remaining orphan for continuation');
  assert.equal(await f.completion(), undefined, 'Do not skip the remaining ledger backlog for the next day');
  await f.run('2026-09-09T00:02:00Z');
  assert.equal(await f.count(), 0);
  assert.equal(await f.completion(), '2026-09-09T00:02:00.000Z');
  const calls = f.calls.length;
  await f.run('2026-09-09T00:04:00Z');
  assert.equal(f.calls.length, calls, 'Drained cleanup returns to the low-frequency schedule');
});

test('R-D06 a live orphan lease is retained and drained by the next Cron after expiry', async t => {
  const f = await fixture(t);
  await f.database.exec(`insert into cfm_internal.notification_delivery_state(key,event_id,status,attempts,next_attempt_at,updated_at,claim_token)
    values ('website:999','synthetic-sending','pending',1,'2026-09-09T00:01:30Z','2026-09-09T00:00:00Z','synthetic-active-token')`);
  await f.run('2026-09-09T00:00:00Z');
  assert.equal(await f.count(), 1, 'An in-flight provider send cannot lose its lease');
  assert.equal(await f.completion(), undefined, 'A retained retired lease needs near-term continuation');
  await f.run('2026-09-09T00:02:00Z');
  assert.equal(await f.count(), 0);
  assert.equal(await f.completion(), '2026-09-09T00:02:00.000Z');
});

test('R-D06 cleanup without enough scheduled budget defers before starting database work', async t => {
  const f = await fixture(t);
  const budget = new ScheduledBudget({ maxSubrequests: 7, reserveRequests: 0 });
  await assert.rejects(f.run('2026-09-09T00:00:00Z', budget), ScheduledBudgetExceeded);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.completion(), undefined);
});
