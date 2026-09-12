import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BUNDLED_SUPABASE_MIGRATIONS } from '../../generated/supabase-migrations.ts';
import { applyApplicationMigrations, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

const migration = await readFile(new URL('../../../../supabase/migrations/4_rpc_api.sql', import.meta.url), 'utf8');
const generated = BUNDLED_SUPABASE_MIGRATIONS.find(({ version }) => version === '4_rpc_api')?.sql;
assert.ok(generated);

for (const source of [migration, generated]) {
  assert.match(source, /last_notified\s*=\s*case\s+when\s+excluded\.enable\s*=\s*0\s+then\s+null/i);
  assert.match(source, /set\s+last_notified\s*=\s*nullif\(input_time,\s*''\)::timestamptz/i);
  assert.match(source, /drop function if exists public\.cfm_mark_offline_notification_sent\(text, text\);/i);
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(source, new RegExp(`revoke all on function public\\.cfm_mark_offline_notification_sent\\(text, text, text\\) from ${role};`, 'i'));
  }
  assert.match(source, /grant execute on function public\.cfm_mark_offline_notification_sent\(text, text, text\) to service_role/i);
}

test('offline marker upgrade removes the old overload and preserves effective RPC privileges on replay', async () => {
  const database = await createTestDatabase({ migrate: false });
  try {
    // Simulate the legacy, tokenless overload before applying the real migrations.
    await database.exec(`create function public.cfm_mark_offline_notification_sent(text, text)
      returns boolean language sql as $$ select true $$;`);
    for (let install = 0; install < 2; install++) {
      await applyApplicationMigrations(database);
      const { rows } = await database.query(`select
        to_regprocedure('public.cfm_mark_offline_notification_sent(text,text)') is null as old_removed,
        has_function_privilege('anon', p.oid, 'execute') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'execute') as service_execute,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
          where grantee = 0 and privilege_type = 'EXECUTE') as public_execute
        from pg_proc p
        where p.oid = to_regprocedure('public.cfm_mark_offline_notification_sent(text,text,text)')`);
      assert.deepEqual(rows, [{ old_removed: true, anon_execute: false,
        authenticated_execute: false, service_execute: true, public_execute: false }]);
    }
    for (const role of ['anon', 'authenticated']) {
      await database.exec(`set role ${role}`);
      try {
        await assert.rejects(rpc(database, 'cfm_mark_offline_notification_sent', {
          input_client: 'offline-gate', input_time: '', input_token: 'synthetic-token',
        }), { code: '42501' });
      } finally { await database.exec('reset role'); }
    }

    await database.exec(`set role service_role;
      insert into clients(uuid, name) values ('offline-gate', 'Synthetic offline node');
      insert into offline_notifications(client, enable, last_notified)
        values ('offline-gate', 1, '2026-09-09T00:00:00Z');`);
    const marker = async () => (await database.query(
      "select last_notified from offline_notifications where client = 'offline-gate'")).rows[0].last_notified;
    await rpc(database, 'cfm_set_offline_notifications', {
      input_items: [{ client: 'offline-gate', enable: false }],
    });
    assert.equal(await marker(), null, 'disabling offline notifications clears the prior marker');
    await rpc(database, 'cfm_set_offline_notifications', {
      input_items: [{ client: 'offline-gate', enable: true }],
    });
    const claim = await rpc(database, 'cfm_claim_notification_delivery', {
      input_key: 'offline:offline-gate', input_event_id: 'synthetic-outage', input_now: '2026-09-09T00:00:00Z',
    });
    assert.equal(claim.claimed, true);
    assert.equal(await rpc(database, 'cfm_complete_notification_delivery', {
      input_key: 'offline:offline-gate', input_event_id: 'synthetic-outage', input_token: claim.token,
      input_success: true, input_now: '2026-09-09T00:00:01Z',
    }), true);
    const mark = input_time => rpc(database, 'cfm_mark_offline_notification_sent', {
      input_client: 'offline-gate', input_time, input_token: claim.token,
    });
    assert.equal(await mark('2026-09-09T00:00:01Z'), true);
    assert.equal((await marker()).toISOString(), '2026-09-09T00:00:01.000Z');
    assert.equal(await mark(''), true);
    assert.equal(await marker(), null,
      'confirmed recovery stores NULL, not an empty timestamp or the old outage marker');
  } finally { await database.close(); }
});
