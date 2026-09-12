import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

test('AUD-05 a late initial creation cannot replace the first administrator', async () => {
  const database = await createTestDatabase();
  try {
    // Both HTTP callers observed zero before either SQL write. The fallback is
    // exactly the old initial-creation route's RPC; it exposes the old overwrite.
    const initialCount = await rpc(database, 'cfm_users_count');
    assert.equal(initialCount, 0);
    const hasInsertOnly = (await database.query(
      "select to_regprocedure('public.cfm_create_initial_admin(text,text,text)') is not null as present",
    )).rows[0].present;
    const create = hasInsertOnly
      ? (uuid, username, hash) => rpc(database, 'cfm_create_initial_admin', {
        p_uuid: uuid, p_username: username, p_password_hash: hash,
      })
      : async (uuid, username, hash) => Boolean(await rpc(database, 'cfm_recover_single_admin', {
        input_uuid: uuid, input_username: username, input_passwd: hash,
      }));

    assert.equal(await create('synthetic-owner', 'owner', 'synthetic-owner-hash'), true);
    const lateResult = await create('synthetic-late', 'late', 'synthetic-late-hash');
    const users = (await database.query('select uuid, username, passwd as password_hash from public.users')).rows;
    assert.deepEqual(users, [{
      uuid: 'synthetic-owner', username: 'owner', password_hash: 'synthetic-owner-hash',
    }], 'a stale count=0 must never authorize a password reset');
    assert.equal(lateResult, false);

    const access = (await database.query(`
      select has_function_privilege('anon','public.cfm_create_initial_admin(text,text,text)','execute') as anon,
        has_function_privilege('authenticated','public.cfm_create_initial_admin(text,text,text)','execute') as authenticated,
        has_function_privilege('service_role','public.cfm_create_initial_admin(text,text,text)','execute') as service_role
    `)).rows[0];
    assert.deepEqual(access, { anon: false, authenticated: false, service_role: true });
  } finally {
    await database.close();
  }
});
