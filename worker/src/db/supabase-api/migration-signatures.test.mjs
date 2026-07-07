import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationSql = await readFile(new URL('../../../../supabase/migrations/4_rpc_api.sql', import.meta.url), 'utf8');
const generatedSql = await readFile(new URL('../../generated/supabase-migrations.ts', import.meta.url), 'utf8');

for (const source of [migrationSql, generatedSql]) {
  assert.doesNotMatch(source, /revoke all on function public\.cfm_public_website_monitor\(integer, integer\)/);
  assert.doesNotMatch(source, /grant execute on function public\.cfm_public_website_monitor\(integer, integer\)/);
}

assert.match(migrationSql, /drop function if exists public\.cfm_public_website_monitor\(integer, integer\);/);
