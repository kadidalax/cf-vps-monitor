import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applyApplicationMigrations, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

test('R-D03 upgrades an unversioned database and keeps configuration identity stable on replay', async () => {
  const sql = await createTestDatabase({ migrate: false });
  const run = async name => sql.exec(`begin;\n${await readFile(new URL(`../../../../supabase/migrations/${name}`, import.meta.url), 'utf8')}\ncommit;`);
  try {
    for (const name of ['1_core_schema.sql', '2_security_access.sql', '3_feature_schema.sql']) await run(name);
    await sql.exec(`
      alter table website_monitors drop column if exists config_revision;
      alter table website_checks drop column if exists config_revision;
      insert into website_monitors(id,name,url,status,last_checked_at)
        values (31,'Legacy website','https://legacy.audit.example.com','up',now() - interval '10 minutes');
      insert into website_checks(monitor_id,checked_at,ok,effective_status)
        values (31,now() - interval '10 minutes',true,'up');
    `);
    for (const name of ['4_rpc_api.sql', '5_runtime_defaults.sql']) await run(name);
    await sql.exec('set role service_role');
    const site = await rpc(sql, 'cfm_website_monitor', { input_id: 31 });
    assert.match(site.config_revision, /^[0-9a-f-]{36}$/);
    assert.equal((await sql.query('select config_revision from website_checks')).rows[0].config_revision, null,
      'historical samples have no evidence of the newly assigned generation');
    assert.deepEqual((await rpc(sql, 'cfm_public_website_monitor', { input_id: 31 })).checks, []);
    const checked = await rpc(sql, 'cfm_record_website_check', { input_check: {
      monitor_id: 31, config_revision: site.config_revision, checked_at: new Date().toISOString(),
      ok: true, effective_status: 'up', status_code: 200, raw_status_code: 200,
    } });
    assert.equal(checked.status, 'up');
    assert.equal(await rpc(sql, 'cfm_mark_website_monitor_notified', { input_id: 31, input_time: new Date().toISOString() }), false,
      'legacy marker calls lack the event observation and cannot mutate state');
    const grants = (await sql.query(`select
      has_function_privilege('anon','public.cfm_mark_website_monitor_notified(integer,text,jsonb)','execute') as anon,
      has_function_privilege('authenticated','public.cfm_mark_website_monitor_notified(integer,text,jsonb)','execute') as authenticated,
      has_function_privilege('service_role','public.cfm_mark_website_monitor_notified(integer,text,jsonb)','execute') as service,
      to_regprocedure('public.cfm_mark_website_monitor_notified(integer,text)') is null as old_removed
    `)).rows[0];
    assert.deepEqual(grants, { anon: false, authenticated: false, service: true, old_removed: true });
    await sql.exec('reset role');
    await applyApplicationMigrations(sql);
    const replayed = await rpc(sql, 'cfm_website_monitor', { input_id: 31 });
    assert.equal(replayed.config_revision, site.config_revision);
    assert.equal(replayed.last_checked_at, checked.last_checked_at);
    assert.equal((await rpc(sql, 'cfm_public_website_monitor', { input_id: 31 })).checks.length, 1);
    assert.equal((await sql.query('select count(*)::integer as n from website_checks')).rows[0].n, 2,
      'upgrade preserves old administrator history while public availability uses the current generation');
  } finally { await sql.close(); }
});
