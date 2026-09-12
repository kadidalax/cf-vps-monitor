import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBackup, encryptBackup, validateBackup } from '../../utils/backup.ts';
import { configurationOnly, makeWebsiteBackup, websiteConfiguration } from '../../../../scripts/test-support/backup-fixture.mjs';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

test('AUD-06 restore replaces website configuration transactionally and resets its identity', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec("insert into website_monitors (id,name,url) values (99,'Existing synthetic website','https://example.org/');");
    const encrypted = await encryptBackup(makeWebsiteBackup(), 'synthetic-backup-password');
    const decrypted = await decryptBackup(encrypted.encryptedBackup, 'synthetic-backup-password');
    assert.equal(decrypted.ok, true);
    await rpc(database, 'cfm_restore_backup_data', { input_backup: decrypted.backup });
    const actual = await rpc(database, 'cfm_website_monitors');
    assert.deepEqual(configurationOnly(actual), websiteConfiguration, 'restore must replace the old website module');
    assert.ok(actual.every(row => row.last_checked_at === null), 'history/health state is not restored as configuration');
    const created = await rpc(database, 'cfm_create_website_monitor', {
      input_monitor: { name: 'Next synthetic website', url: 'https://example.com/next' },
    });
    assert.ok(created.id > 11, 'new website identity follows the restored maximum');
    await rpc(database, 'cfm_restore_backup_data', { input_backup: { settings: { site_title: 'Old backup' } } });
    assert.equal((await rpc(database, 'cfm_website_monitors')).length, 4, 'absent module preserves websites');
    await rpc(database, 'cfm_restore_backup_data', { input_backup: { website_monitors: [] } });
    assert.deepEqual(await rpc(database, 'cfm_website_monitors'), [], 'explicit empty module clears websites');
  } finally {
    await database.close();
  }
});

test('AUD-06 raw restore rejects duplicate IDs and unknown agent references before committing settings', async () => {
  const database = await createTestDatabase();
  try {
    await rpc(database, 'cfm_set_settings', { input_settings: { site_title: 'Before restore' } });
    const bad = makeWebsiteBackup();
    bad.settings = { site_title: 'Must roll back' };
    bad.website_monitors[1].agent_probe_clients = ['missing-node'];
    await assert.rejects(rpc(database, 'cfm_restore_backup_data', { input_backup: bad }), /website.*agent|agent.*website/i);
    assert.equal((await rpc(database, 'cfm_public_settings')).site_title, 'Before restore');
    const duplicate = makeWebsiteBackup();
    duplicate.website_monitors[1].id = duplicate.website_monitors[0].id;
    await assert.rejects(rpc(database, 'cfm_restore_backup_data', { input_backup: duplicate }), /duplicate.*website|website.*duplicate/i);
  } finally {
    await database.close();
  }
});

test('AUD-06 website identity stays usable after unknown-agent rollback', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec('set role service_role');
    for (let index = 0; index < 5; index++) {
      await rpc(database, 'cfm_create_website_monitor', {
        input_monitor: { name: `Existing ${index}`, url: 'https://example.com/' },
      });
    }
    const backup = makeWebsiteBackup();
    delete backup.clients;
    backup.website_monitors = [{
      ...websiteConfiguration[0], id: 1, agent_probe_mode: 'selected', agent_probe_clients: ['missing-agent'],
    }];
    const validated = validateBackup(backup);
    assert.equal(validated.ok, true, 'a website-only import cannot resolve stored client references in JavaScript');
    await assert.rejects(rpc(database, 'cfm_restore_backup_data', { input_backup: validated.backup }), /unknown agent/);
    assert.deepEqual((await database.query('select id from website_monitors order by id')).rows.map(row => row.id), [1, 2, 3, 4, 5]);
    const created = await rpc(database, 'cfm_create_website_monitor', {
      input_monitor: { name: 'After rejected restore', url: 'https://example.org/' },
    });
    assert.ok(created.id > 5, 'a failed restore must not rewind identity into existing records');
  } finally {
    await database.close();
  }
});

const identityModules = [
  { table: 'website_monitors', create: 'cfm_create_website_monitor', argument: 'input_monitor', fields: { url: 'https://example.com/' } },
  { table: 'ping_tasks', create: 'cfm_create_ping_task', argument: 'input_task', fields: { target: 'example.com', type: 'icmp' } },
  { table: 'load_notifications', create: 'cfm_create_load_notification', argument: 'input_item', fields: { metric: 'cpu', threshold: 80 } },
];

for (const { table, create, argument, fields } of identityModules) {
  test(`AUD-06 ${table} identity remains usable after a later transaction rollback`, async () => {
    const database = await createTestDatabase();
    try {
      await database.exec('set role service_role');
      for (let index = 0; index < 5; index++) {
        await rpc(database, create, { [argument]: { ...fields, name: `Existing ${index}` } });
      }
      await database.exec('begin');
      await rpc(database, 'cfm_restore_backup_data', {
        input_backup: { [table]: [{ ...fields, id: 1, name: 'Rolled back replacement' }] },
      });
      await database.exec('rollback');
      assert.deepEqual((await database.query(`select id from ${table} order by id`)).rows.map(row => row.id), [1, 2, 3, 4, 5]);
      await rpc(database, create, { [argument]: { ...fields, name: 'New after rollback' } });
      const rows = (await database.query(`select id, name from ${table} order by id`)).rows;
      assert.equal(rows.length, 6);
      assert.ok(rows.find(row => row.name === 'New after rollback').id > 5);
    } finally {
      await database.close();
    }
  });

  test(`AUD-06 ${table} identity reserves mixed explicit and automatic IDs without unsafe rollback resets`, async () => {
    const database = await createTestDatabase();
    try {
      await database.exec('set role service_role');
      await rpc(database, 'cfm_restore_backup_data', {
        input_backup: { [table]: [
          { ...fields, id: 1, name: 'Explicit identity' },
          { ...fields, name: 'Automatic identity' },
        ] },
      });
      const rows = (await database.query(`select id, name from ${table} order by id`)).rows;
      assert.equal(rows.length, 2, 'both configuration entries survive a mixed-ID restore');
      assert.equal(rows.find(row => row.name === 'Explicit identity').id, 1);
      assert.ok(rows.find(row => row.name === 'Automatic identity').id > 1);
      await rpc(database, create, { [argument]: { ...fields, name: 'After successful restore' } });
      assert.equal((await database.query(`select count(*)::int as count from ${table}`)).rows[0].count, 3);
    } finally {
      await database.close();
    }
  });
}
