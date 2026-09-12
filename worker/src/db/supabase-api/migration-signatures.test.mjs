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
// 建节点必须同时落库明文 token 与 token_hash——漏掉哪一个都会让新节点的
// 安装 Token 读不回来（2026-07-12 的既有故障）。
// 这里只锁「token/token_hash 进了 insert 列并被赋值」，不锁整张列清单：
// 列清单会随功能增长（如 traffic_reset_day），锁死会让每次加字段都误报。
assert.match(migrationSql, /insert into clients \([\s\S]*?\btoken\b[\s\S]*?\btoken_hash\b[\s\S]*?\)[\s\S]*?input_client->>'token',[\s\S]*?input_client->>'token_hash'/i);
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

// 审计节流靠「一条 insert … on conflict do update … where」串行化。任何把它拆回
// 先 select 再 update 的改法都会让并发请求同时判定可写，同一条错误落多行审计日志。
// 这里锁三件事：函数在（且两份 SQL 一致）、on conflict 分支在、比较方向没被写反。
for (const source of [migrationSql, generatedSql]) {
  assert.match(source, /create or replace function public\.cfm_try_claim_audit_throttle\(/i);
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(source, new RegExp(`revoke all on function public\\.cfm_try_claim_audit_throttle\\([^;]+\\) from ${role};`, 'i'));
  }
  assert.match(source, /grant execute on function public\.cfm_try_claim_audit_throttle\([^;]+\) to service_role;/i);
}
const throttleBody = migrationSql.match(
  /create or replace function public\.cfm_try_claim_audit_throttle\([\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(throttleBody, 'cfm_try_claim_audit_throttle 函数体没截到');
assert.match(throttleBody, /insert into settings \(key, value\)[\s\S]*?on conflict \(key\) do update/i);
// 过期才放行：上次写入时间 <= 现在 - 节流窗口。写成 >= 会变成「越新越放行」。
assert.match(throttleBody, /settings\.value collate "C" <= to_char\(/i);
assert.match(throttleBody, /input_now - make_interval\(secs => input_throttle_ms \/ 1000\.0\)/i);
// 时间戳取调用方传入的 input_now，服务端 now() 会引入第二套时钟。
assert.doesNotMatch(throttleBody, /\bnow\(\)/i);
