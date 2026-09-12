import assert from 'node:assert/strict';
import test from 'node:test';
import * as sba from './client.ts';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';
import { loadTypeScriptFunctions } from '../../../../scripts/test-support/typescript.mjs';

test('AUD-17 narrow settings readers transfer only the requested keys from the database', async () => {
  const database = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const payloads = [];
  try {
    await rpc(database, 'cfm_set_settings', { input_settings: {
      record_enabled: 'true', site_logo_data: 'A'.repeat(1_000_000), email_smtp_password: 'synthetic-private-value',
    } });
    globalThis.fetch = async (url, init) => {
      const functionName = new URL(url).pathname.split('/').at(-1);
      const body = JSON.parse(init.body);
      const value = functionName === 'cfm_settings_by_keys'
        ? (await database.query('select cfm_settings_by_keys($1::text[]) as settings', [body.input_keys])).rows[0].settings
        : await rpc(database, functionName, body);
      payloads.push(value);
      return Response.json(value);
    };
    const queries = await loadTypeScriptFunctions(new URL('../queries.ts', import.meta.url), [
      'filterSettings', 'getSetting', 'getSettingsByKeys', 'getRawSettingsByKeys', 'getAllSettings',
    ], { sba });
    const connection = { provider: 'supabase-api', env: { SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SECRET_KEY: 'sb_secret_synthetic' } };
    assert.equal(await queries.getSetting(connection, 'record_enabled'), 'true');
    assert.deepEqual(Object.keys(payloads.at(-1)).sort(), ['record_enabled'], 'logo and unrelated secrets must not cross the RPC response boundary');
    assert.deepEqual(await queries.getSettingsByKeys(connection, ['record_enabled', 'missing']), { record_enabled: 'true' });
    assert.deepEqual(payloads.at(-1), { record_enabled: 'true' });
    assert.deepEqual(await queries.getRawSettingsByKeys(connection, ['record_enabled']), { record_enabled: 'true' });
    const calls = payloads.length;
    assert.deepEqual(await queries.getSettingsByKeys(connection, []), {});
    assert.equal(payloads.length, calls, 'empty key list does not need a database request');
    await rpc(database, 'cfm_set_settings', { input_settings: { record_enabled: 'false' } });
    assert.equal(await queries.getSetting(connection, 'record_enabled'), 'false', 'no stale process-wide cache');
    const all = await queries.getAllSettings(connection);
    assert.equal(all.site_logo_data.length, 1_000_000, 'deliberate complete backup reads remain available');
  } finally {
    globalThis.fetch = originalFetch;
    await database.close();
  }
});
