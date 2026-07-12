import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { BUNDLED_SUPABASE_MIGRATIONS } from '../../generated/supabase-migrations.ts';

const migrationsUrl = new URL('../../../../supabase/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationsUrl)).filter((name) => name.endsWith('.sql')).sort();
assert.deepEqual(migrationFiles, [
  '1_core_schema.sql',
  '2_security_access.sql',
  '3_feature_schema.sql',
  '4_rpc_api.sql',
  '5_runtime_defaults.sql',
]);
assert.deepEqual(BUNDLED_SUPABASE_MIGRATIONS.map(({ version }) => version), [
  '1_core_schema',
  '2_security_access',
  '3_feature_schema',
  '4_rpc_api',
  '5_runtime_defaults',
]);

const featureSchemaSql = await readFile(new URL('3_feature_schema.sql', migrationsUrl), 'utf8');
const migrationSql = await readFile(new URL('../../../../supabase/migrations/4_rpc_api.sql', import.meta.url), 'utf8');
const runtimeDefaultsSql = await readFile(new URL('5_runtime_defaults.sql', migrationsUrl), 'utf8');
const generatedSql = await readFile(new URL('../../generated/supabase-migrations.ts', import.meta.url), 'utf8');
const agentRoutesSql = await readFile(new URL('../../routes/client.ts', import.meta.url), 'utf8');
const allMigrationSql = await Promise.all(migrationFiles.map((name) => readFile(new URL(name, migrationsUrl), 'utf8'))).then((sources) => sources.join('\n'));

assert.doesNotMatch(allMigrationSql, /^\+/m);
assert.doesNotMatch(allMigrationSql, /set token\s*=\s*null/i);
assert.doesNotMatch(allMigrationSql, /create or replace function public\.cfm_set_client_install_token/i);
assert.doesNotMatch(allMigrationSql, /grant execute on function public\.cfm_set_client_install_token/i);
assert.doesNotMatch(agentRoutesSql, /rotateClientToken\(/);
assert.equal((allMigrationSql.match(/create or replace function public\.cfm_create_client\(/gi) || []).length, 1);
assert.equal((allMigrationSql.match(/create or replace function public\.cfm_rotate_client_token\(input_uuid text, input_token text, input_token_hash text\)/gi) || []).length, 1);
assert.doesNotMatch(allMigrationSql, /create or replace function public\.cfm_rotate_client_token\(input_uuid text, input_token_hash text\)/i);
assert.match(migrationSql, /insert into clients \(uuid, token, token_hash, token_rotated_at, name, sort_order\)[\s\S]*?input_client->>'token',[\s\S]*?input_client->>'token_hash'/i);
assert.match(migrationSql, /create or replace function public\.cfm_rotate_client_token\(input_uuid text, input_token text, input_token_hash text\)[\s\S]*?set token = input_token,[\s\S]*?token_hash = input_token_hash/i);
assert.doesNotMatch(featureSchemaSql, /create or replace function public\.cfm_(?:create_client|rotate_client_token)\(/i);
assert.doesNotMatch(runtimeDefaultsSql, /create or replace function public\.cfm_(?:create_client|rotate_client_token)\(/i);

for (const source of [migrationSql, generatedSql]) {
  assert.doesNotMatch(source, /revoke all on function public\.cfm_public_website_monitor\(integer, integer\)/);
  assert.doesNotMatch(source, /grant execute on function public\.cfm_public_website_monitor\(integer, integer\)/);
}

assert.match(migrationSql, /drop function if exists public\.cfm_public_website_monitor\(integer, integer\);/);

const mfaSources = [featureSchemaSql + migrationSql, generatedSql];
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

assert.match(migrationSql, /create or replace function public\.cfm_recover_single_admin\(/i);
assert.match(migrationSql, /totp_secret_enc\s*=\s*null/i);
assert.match(migrationSql, /totp_enabled_at\s*=\s*null/i);
assert.match(migrationSql, /totp_last_used_step\s*=\s*-1/i);
assert.match(migrationSql, /recovery_code_hashes\s*=\s*'\[\]'::jsonb/i);
assert.match(migrationSql, /input_code_hash\s*!~\s*'\^\[A-Za-z0-9_-\]\{43\}\$'/i);
assert.match(runtimeDefaultsSql, /\('webhook_url', ''\)/i);
