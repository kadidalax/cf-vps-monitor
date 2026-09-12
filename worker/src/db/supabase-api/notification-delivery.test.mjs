import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

test('AUD-08 a delivery lease deduplicates attempts and retains failed events for bounded retry', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec(`
      insert into clients(uuid, name) values ('node-a', 'Synthetic node');
      insert into offline_notifications(client, enable) values ('node-a', 1);
    `);
    const hasClaims = (await database.query("select to_regprocedure('public.cfm_claim_notification_delivery(text,text,timestamptz,bigint)') is not null as present")).rows[0].present;
    // Before the fix there is no persistent claim: two simultaneous evaluators
    // can both reach the transport. Retain that old behavior for the red fixture.
    const claim = async (minute, event = 'outage-1') => hasClaims ? rpc(database, 'cfm_claim_notification_delivery', {
      input_key: 'offline:node-a', input_event_id: event,
      input_now: new Date(Date.parse('2026-09-06T00:00:00Z') + minute * 60_000).toISOString(), input_repeat_ms: 0,
    }) : { claimed: true, delivered: false, token: 'old-unclaimed' };
    const first = await claim(0);
    assert.equal(first.claimed, true);
    assert.equal((await claim(0)).claimed, false, 'a duplicate invocation must not acquire an in-flight delivery');
    assert.equal(await rpc(database, 'cfm_complete_notification_delivery', {
      input_key: 'offline:node-a', input_event_id: 'outage-1', input_token: first.token,
      input_success: false, input_now: '2026-09-06T00:00:00Z', input_repeat_ms: 0,
    }), true);
    assert.equal((await claim(1)).claimed, false, 'failed delivery observes its retry delay');
    const retry = await claim(2);
    assert.equal(retry.claimed, true, 'failure does not permanently consume the event');
    assert.notEqual(retry.token, first.token);
    assert.equal(await rpc(database, 'cfm_complete_notification_delivery', {
      input_key: 'offline:node-a', input_event_id: 'outage-1', input_token: first.token,
      input_success: true, input_now: '2026-09-06T00:02:00Z', input_repeat_ms: 0,
    }), false, 'stale completion cannot override a newer attempt');
    await rpc(database, 'cfm_complete_notification_delivery', {
      input_key: 'offline:node-a', input_event_id: 'outage-1', input_token: retry.token,
      input_success: true, input_now: '2026-09-06T00:02:00Z', input_repeat_ms: 0,
    });
    assert.equal((await claim(4)).delivered, true);
    assert.equal((await claim(4, 'outage-2')).claimed, true, 'a distinct event is not suppressed by the prior success');
  } finally { await database.close(); }
});
