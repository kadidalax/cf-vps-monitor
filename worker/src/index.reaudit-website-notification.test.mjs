import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../scripts/test-support/postgres.mjs';
import { notificationHarness } from '../../scripts/test-support/notifications.mjs';

test('R-D03 website notification completion is scoped to its configuration and observed event', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const downSince = '2026-09-05T00:00:00Z';
  await database.query(`insert into website_monitors(id,name,url,interval_sec,grace_period_sec,status,down_since,agent_probe_mode)
    values (1,'Synthetic site','https://target.audit.example.com/a',60,30,'down',$1,'off')`, [downSince]);
  const sent = [];
  let mutateDuringSend = false;
  const h = await notificationHarness(database, async subject => {
    sent.push(subject);
    if (mutateDuringSend) await rpc(database, 'cfm_update_website_monitor', {
      input_id: 1, input_monitor: { url: 'https://target.audit.example.com/c' },
    });
    return true;
  });
  await h.run('runWebsiteMonitorChecks', 0);
  let site = (await rpc(database, 'cfm_website_monitors'))[0];
  assert.ok(site.last_notified_at, 'A matching successful down notice must mark the observed event');
  const firstRevision = site.config_revision;
  const firstEvent = (await database.query("select event_id from cfm_internal.notification_delivery_state where key='website:1'")).rows[0].event_id;
  assert.ok(firstEvent.includes(firstRevision), 'Delivery ownership must include the executed configuration');

  await rpc(database, 'cfm_update_website_monitor', { input_id: 1, input_monitor: { url: 'https://target.audit.example.com/b' } });
  await database.query("update website_monitors set status='down',down_since=$1 where id=1", [downSince]);
  mutateDuringSend = true;
  await h.run('runWebsiteMonitorChecks', 2);
  site = (await rpc(database, 'cfm_website_monitors'))[0];
  assert.equal(sent.length, 2, 'A new configuration with the same down time must not inherit the old delivery receipt');
  assert.equal(site.status, 'pending');
  assert.equal(site.last_notified_at, null, 'Completion of the old send cannot consume the replacement event');
});
