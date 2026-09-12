import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applyApplicationMigrations, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';
import { createWorkerLoader } from '../../../test-support/worker-module.mjs';

const migrations = new URL('../../../../supabase/migrations/', import.meta.url);
const disabledProbe = { agent_probe_mode: 'off', agent_probe_status_enabled: false };
const defaultProbe = { agent_probe_mode: 'country_auto', agent_probe_status_enabled: true };

async function probeSettings(sql, id) {
  return (await sql.query('select agent_probe_mode,agent_probe_status_enabled from website_monitors where id=$1', [id])).rows[0];
}

async function runFiles(sql, files) {
  for (const file of files) await sql.exec(`begin;\n${await readFile(new URL(file, migrations), 'utf8')}\ncommit;`);
}

test('R-D02 direct aggregate replay preserves a saved explicit probe disable', async () => {
  const sql = await createTestDatabase();
  try {
    const site = await rpc(sql, 'cfm_create_website_monitor', { input_monitor: { name: 'Synthetic', url: 'https://site.audit.example.com' } });
    assert.deepEqual(await probeSettings(sql, site.id), defaultProbe);
    await rpc(sql, 'cfm_update_website_monitor', { input_id: site.id, input_monitor: disabledProbe });
    await applyApplicationMigrations(sql);
    assert.deepEqual(await probeSettings(sql, site.id), disabledProbe, 'replaying unrelated RPC updates must not turn probes back on');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await sql.exec(`set role ${role}`);
      try {
        await assert.rejects(sql.query('delete from cfm_internal.data_migrations'), /permission denied/,
          'application/browser roles cannot reset the migration decision');
      } finally { await sql.exec('reset role'); }
    }
  } finally { await sql.close(); }
});

test('R-D02 actual setup preserves explicit choices on same checksum and changed RPC checksum', async () => {
  const sql = await createTestDatabase({ migrate: false });
  try {
    const loader = createWorkerLoader({
      expose: { 'worker/src/routes/setup.ts': ['applyBundledMigrations'] },
      globals: { fetch: async (url, init) => {
        assert.equal(String(url), 'https://api.supabase.com/v1/projects/synthetic-project/database/query');
        assert.equal(init.headers.Authorization, 'Bearer synthetic-management-token');
        const result = await sql.exec(JSON.parse(init.body).query);
        return Response.json(result.flatMap(item => item.rows || []));
      } },
    });
    const { applyBundledMigrations } = loader.load('worker/src/routes/setup.ts');
    const apply = () => applyBundledMigrations('synthetic-project', 'synthetic-management-token');
    assert.equal((await apply()).applied, 5);
    const site = await rpc(sql, 'cfm_create_website_monitor', { input_monitor: {
      name: 'Synthetic', url: 'https://site.audit.example.com', ...disabledProbe,
    } });
    assert.equal((await apply()).applied, 0);
    assert.deepEqual(await probeSettings(sql, site.id), disabledProbe);
    await sql.exec("update cfm_internal.setup_migrations set checksum='synthetic-older-rpc-checksum' where version='4_rpc_api'");
    assert.equal((await apply()).applied, 1);
    assert.deepEqual(await probeSettings(sql, site.id), disabledProbe, 'a changed aggregate checksum must preserve user choices');
  } finally { await sql.close(); }
});

test('R-D02 schema-proven legacy defaults migrate once and a later explicit disable survives', async () => {
  const sql = await createTestDatabase({ migrate: false });
  try {
    await runFiles(sql, ['1_core_schema.sql', '2_security_access.sql', '3_feature_schema.sql']);
    // The legacy schema could not have stored an explicit probe choice: neither
    // configuration column existed. Other table/data constraints remain real.
    await sql.exec(`alter table website_monitors drop column agent_probe_mode;
      alter table website_monitors drop column agent_probe_status_enabled;
      insert into website_monitors(id,name,url,enabled) values
        (41,'Enabled legacy','https://legacy.audit.example.com',true),
        (42,'Paused legacy','https://paused.audit.example.com',false);`);
    await runFiles(sql, ['4_rpc_api.sql', '5_runtime_defaults.sql']);
    assert.deepEqual(await probeSettings(sql, 41), defaultProbe);
    assert.deepEqual(await probeSettings(sql, 42), disabledProbe);
    await rpc(sql, 'cfm_update_website_monitor', { input_id: 41, input_monitor: disabledProbe });
    await applyApplicationMigrations(sql);
    assert.deepEqual(await probeSettings(sql, 41), disabledProbe, 'the historical conversion can run only once');
    const added = await rpc(sql, 'cfm_create_website_monitor', { input_monitor: { name: 'New', url: 'https://new.audit.example.com' } });
    assert.deepEqual(await probeSettings(sql, added.id), defaultProbe);
  } finally { await sql.close(); }
});

test('R-D02 an older database with existing ambiguous off fields keeps them on its first new upgrade', async () => {
  const sql = await createTestDatabase({ migrate: false });
  try {
    await runFiles(sql, ['1_core_schema.sql', '2_security_access.sql', '3_feature_schema.sql']);
    await sql.exec("insert into website_monitors(id,name,url,agent_probe_mode,agent_probe_status_enabled) values (61,'Existing choice','https://choice.audit.example.com','off',false)");
    await runFiles(sql, ['4_rpc_api.sql', '5_runtime_defaults.sql']);
    assert.deepEqual(await probeSettings(sql, 61), disabledProbe, 'no row data distinguishes an old default from an intentional disable');
  } finally { await sql.close(); }
});
