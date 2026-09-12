import assert from 'node:assert/strict';
import test from 'node:test';
import { applyApplicationMigrations, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

async function unrelatedPrivileges(database) {
  const { rows } = await database.query(`
    select
      has_schema_privilege('anon', 'public', 'usage') as schema_usage,
      has_schema_privilege('authenticated', 'public', 'usage') as authenticated_schema_usage,
      has_table_privilege('anon', 'public.unrelated_application_data', 'select') as table_select,
      has_table_privilege('authenticated', 'public.unrelated_application_data', 'insert') as table_insert,
      has_function_privilege('anon', 'public.unrelated_application_value()', 'execute') as function_execute,
      has_sequence_privilege('anon', 'public.unrelated_application_sequence', 'usage') as sequence_usage,
      (select nspacl::text from pg_namespace where nspname = 'public') as schema_acl,
      (select jsonb_agg(jsonb_build_array(defaclrole, defaclnamespace, defaclobjtype, defaclacl::text)
        order by defaclrole, defaclnamespace, defaclobjtype) from pg_default_acl) as default_acls
  `);
  return rows[0];
}

test('AUD-09 installation preserves unrelated shared-schema access and defaults', async () => {
  const database = await createTestDatabase({ migrate: false });
  try {
    await database.exec(`
      create table public.unrelated_application_data (id integer primary key, value text);
      create sequence public.unrelated_application_sequence;
      create function public.unrelated_application_value() returns integer language sql as $$ select 42 $$;
      grant select on public.unrelated_application_data to anon;
      grant insert on public.unrelated_application_data to authenticated;
      grant usage on public.unrelated_application_sequence to anon;
      grant execute on function public.unrelated_application_value() to anon;
      alter default privileges in schema public grant select on tables to anon;
      alter default privileges in schema public grant execute on functions to authenticated;
    `);
    const before = await unrelatedPrivileges(database);
    assert.equal(before.table_select, true, 'fixture starts with a working unrelated app');
    await applyApplicationMigrations(database);
    const after = await unrelatedPrivileges(database);
    // This app may add its own role's schema USAGE; existing ACL entries must survive.
    assert.equal(after.schema_usage, true, 'installation must preserve anon schema usage');
    assert.equal(after.authenticated_schema_usage, true);
    assert.equal(after.table_select, true, 'installation must preserve unrelated SELECT');
    assert.equal(after.table_insert, true);
    assert.equal(after.function_execute, true);
    assert.equal(after.sequence_usage, true);
    assert.deepEqual(after.default_acls, before.default_acls, 'unrelated future objects keep their owner defaults');

    const appAccess = (await database.query(`
      select
        has_table_privilege('cf_monitor_app', 'public.unrelated_application_data', 'select') as unrelated_select,
        has_sequence_privilege('cf_monitor_app', 'public.unrelated_application_sequence', 'usage') as unrelated_sequence,
        has_table_privilege('anon', 'public.settings', 'select') as public_settings,
        (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname in ('clients','records','gpu_records','gpu_snapshots',
          'users','login_rate_limits','settings','themes','theme_assets','ping_tasks','ping_records',
          'ping_snapshots','website_monitors','website_checks','offline_notifications',
          'expiry_notifications','load_notifications','audit_logs') and c.relrowsecurity and c.relforcerowsecurity) as protected_tables,
        (select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname like 'cfm_%' and
          (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))) as public_rpcs
    `)).rows[0];
    assert.deepEqual(appAccess, {
      unrelated_select: false, unrelated_sequence: false, public_settings: false,
      protected_tables: 18, public_rpcs: 0,
    });
    await applyApplicationMigrations(database);
    assert.deepEqual(await unrelatedPrivileges(database), after, 'repeat install preserves the same ACLs');
  } finally {
    await database.close();
  }
});

test('AUD-09 restore has the sequence privileges it needs without broad platform defaults', async () => {
  const database = await createTestDatabase({ migrate: false });
  try {
    await database.exec(`
      alter default privileges in schema public revoke all on sequences from service_role;
      create sequence public.unrelated_restore_sequence;
    `);
    for (let install = 0; install < 2; install++) {
      await applyApplicationMigrations(database);
      await database.exec('set role service_role');
      await assert.doesNotReject(rpc(database, 'cfm_restore_backup_data', { input_backup: {
        website_monitors: [{ id: 11, name: 'Restored website', url: 'https://example.com/' }],
        ping_tasks: [{ id: 11, name: 'Restored ping', target: 'example.com', type: 'icmp' }],
        load_notifications: [{ id: 11, name: 'Restored load rule', metric: 'cpu', threshold: 80 }],
      } }), 'application migrations must explicitly grant the privileges used by restore');
      const website = await rpc(database, 'cfm_create_website_monitor', { input_monitor: { name: 'Next website', url: 'https://example.org/' } });
      const ping = await rpc(database, 'cfm_create_ping_task', { input_task: { name: 'Next ping', target: 'example.org' } });
      await rpc(database, 'cfm_create_load_notification', { input_item: { name: 'Next load rule', metric: 'cpu' } });
      assert.ok(website.id > 11);
      assert.ok(ping.id > 11);
      assert.ok((await database.query("select id from load_notifications where name = 'Next load rule'")).rows[0].id > 11);
      await database.exec('reset role');
      const unrelated = (await database.query(`select
        has_sequence_privilege('service_role', 'public.unrelated_restore_sequence', 'update') as unrelated_update,
        has_sequence_privilege('service_role', pg_get_serial_sequence('website_checks', 'id'), 'update') as unused_update
      `)).rows[0];
      assert.deepEqual(unrelated, { unrelated_update: false, unused_update: false }, 'restore privileges stay scoped to the identities it advances');
    }
  } finally {
    await database.close();
  }
});
