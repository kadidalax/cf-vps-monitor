import assert from 'node:assert/strict';
import test from 'node:test';
import { generateToken } from '../src/auth/jwt.ts';
import { createRuntimeFixture, runtimeSecrets } from '../test-support/runtime-fixture.mjs';

test('AUD-14: real Scheduled and authenticated manual invocations respect budgets and continue unfinished websites', { timeout: 90000 }, async t => {
  const checked = new Set();
  const f = await createRuntimeFixture({
    triggerScheduled: true,
    externalResponse: request => { checked.add(new URL(request.url).hostname); return new Response('healthy'); },
  });
  t.after(() => f.close());
  await f.database.query("insert into users(uuid,username,passwd) values ('cron-owner','cron-owner','synthetic-unused-password')");
  await f.database.query("update settings set value=$1 where key='maintenance_last_cleanup_at'", [new Date().toISOString()]);
  await f.database.exec(`insert into website_monitors(name,url,interval_sec,timeout_sec,grace_period_sec,agent_probe_mode)
    select 'Website '||i, 'https://site-'||i||'.audit.example.com/', 86400, 5, 86400, 'off'
    from generate_series(1,50) i`);
  const token = await generateToken('cron-owner', 'cron-owner', 1, runtimeSecrets);
  const csrf = 'a'.repeat(32);
  let maxScheduled = 0;
  let maxManual = 0;
  for (let round = 0; round < 24 && checked.size < 50; round += 1) {
    const before = f.outboundCalls.length;
    const manual = round % 2 === 1;
    const response = manual
      ? await f.fetch('/api/admin/cron/run', { method: 'POST', headers: {
        Cookie: `cf_monitor_session=${token}; cf_monitor_csrf=${csrf}`, 'X-CSRF-Token': csrf,
      } })
      : await f.fetch('/cdn-cgi/handler/scheduled?cron=*%2F2+*+*+*+*');
    assert.equal(response.status, 200, await response.clone().text());
    const requests = f.outboundCalls.length - before;
    assert.ok(requests > 0, 'the native handler must actually perform work');
    assert.ok(requests <= (manual ? 50 : 44), `${manual ? 'manual' : 'scheduled'} made ${requests} external requests`);
    if (manual) maxManual = Math.max(maxManual, requests); else maxScheduled = Math.max(maxScheduled, requests);
  }
  assert.equal(checked.size, 50, 'persistent cursors must eventually visit the tail of the target list');
  assert.equal((await f.database.query('select count(*)::int as count from website_monitors where last_checked_at is not null')).rows[0].count, 50);
  t.diagnostic(`Maximum observed external requests: scheduled=${maxScheduled}, manual including authentication=${maxManual}`);
});
