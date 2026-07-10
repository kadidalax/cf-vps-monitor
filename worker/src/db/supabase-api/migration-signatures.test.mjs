import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const migrationSql = await readFile(new URL('../../../../supabase/migrations/4_rpc_api.sql', import.meta.url), 'utf8');
const generatedSql = await readFile(new URL('../../generated/supabase-migrations.ts', import.meta.url), 'utf8');

for (const source of [migrationSql, generatedSql]) {
  assert.doesNotMatch(source, /revoke all on function public\.cfm_public_website_monitor\(integer, integer\)/);
  assert.doesNotMatch(source, /grant execute on function public\.cfm_public_website_monitor\(integer, integer\)/);
}

assert.match(migrationSql, /drop function if exists public\.cfm_public_website_monitor\(integer, integer\);/);

const mfaMigrationUrl = new URL('../../../../supabase/migrations/7_totp_two_factor_authentication.sql', import.meta.url);
assert.ok(existsSync(mfaMigrationUrl), 'migration 7 must define TOTP two-factor authentication');

const mfaMigrationSql = await readFile(mfaMigrationUrl, 'utf8');
const mfaSources = [mfaMigrationSql, generatedSql];
const mfaFunctions = [
  'cfm_enable_user_totp',
  'cfm_disable_user_totp',
  'cfm_replace_user_recovery_codes',
  'cfm_consume_totp_step',
  'cfm_consume_recovery_code',
];

for (const source of mfaSources) {
  assert.match(source, /totp_secret_enc\s+text/i);
  assert.match(source, /totp_enabled_at\s+timestamptz/i);
  assert.match(source, /totp_last_used_step\s+bigint\s+not null\s+default\s+-1/i);
  assert.match(source, /recovery_code_hashes\s+jsonb\s+not null\s+default\s+'\[\]'::jsonb/i);

  for (const functionName of mfaFunctions) {
    assert.match(source, new RegExp(`create or replace function public\\.${functionName}\\(`, 'i'));
    assert.match(source, new RegExp(`revoke all on function public\\.${functionName}\\([^;]+\\) from public;`, 'i'));
    assert.match(source, new RegExp(`revoke all on function public\\.${functionName}\\([^;]+\\) from anon;`, 'i'));
    assert.match(source, new RegExp(`revoke all on function public\\.${functionName}\\([^;]+\\) from authenticated;`, 'i'));
    assert.match(source, new RegExp(`grant execute on function public\\.${functionName}\\([^;]+\\) to service_role;`, 'i'));
  }
}

assert.match(mfaMigrationSql, /create or replace function public\.cfm_recover_single_admin\(/i);
assert.match(mfaMigrationSql, /totp_secret_enc\s*=\s*null/i);
assert.match(mfaMigrationSql, /totp_enabled_at\s*=\s*null/i);
assert.match(mfaMigrationSql, /totp_last_used_step\s*=\s*-1/i);
assert.match(mfaMigrationSql, /recovery_code_hashes\s*=\s*'\[\]'::jsonb/i);
assert.match(mfaMigrationSql, /input_code_hash\s*!~\s*'\^\[A-Za-z0-9_-\]\{43\}\$'/i);
