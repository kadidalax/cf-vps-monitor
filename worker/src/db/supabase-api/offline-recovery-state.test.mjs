import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BUNDLED_SUPABASE_MIGRATIONS } from '../../generated/supabase-migrations.ts';

const migration = await readFile(new URL('../../../../supabase/migrations/4_rpc_api.sql', import.meta.url), 'utf8');
const generated = BUNDLED_SUPABASE_MIGRATIONS.find(({ version }) => version === '4_rpc_api')?.sql;
assert.ok(generated);

for (const source of [migration, generated]) {
  assert.match(source, /last_notified\s*=\s*case\s+when\s+excluded\.enable\s*=\s*0\s+then\s+null/i);
  assert.match(source, /set\s+last_notified\s*=\s*nullif\(input_time,\s*''\)::timestamptz/i);
  assert.match(source, /revoke all on function public\.cfm_mark_offline_notification_sent\(text, text\) from public/i);
  assert.match(source, /grant execute on function public\.cfm_mark_offline_notification_sent\(text, text\) to service_role/i);
}
