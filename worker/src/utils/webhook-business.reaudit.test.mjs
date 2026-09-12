import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const notification = { subject: 'Synthetic alert', body: 'Synthetic notification only' };
const hookUrl = 'https://hooks.audit.example.com/hook?key=synthetic-request-secret';
const providers = [
  { format: 'feishu', failure: { code: 19024, msg: 'synthetic-response-secret' }, success: { code: 0, data: {}, msg: 'success' }, transient: { code: 11232, msg: 'rate limited' } },
  { format: 'dingtalk', failure: { errcode: 310000, errmsg: 'synthetic-response-secret' }, success: { errcode: 0, errmsg: 'ok' }, transient: { errcode: -1, errmsg: 'system busy' } },
  { format: 'wecom', failure: { errcode: 93000, errmsg: 'synthetic-response-secret' }, success: { errcode: 0, errmsg: 'ok' }, transient: { errcode: -1, errmsg: 'system busy' } },
];

function loadSender() {
  return createWorkerLoader().load('worker/src/utils/webhook.ts').sendWebhookMessage;
}

test('R-D04 provider outcomes propagate through real dispatch, health and SQL delivery state', async t => {
  const sql = await createTestDatabase();
  try {
    let nextId = 1;
    for (const provider of providers) {
      for (const successful of [false, true]) {
        await t.test(`${provider.format} explicit ${successful ? 'success' : 'business rejection'}`, async () => {
          const id = nextId++;
          await sql.query('insert into website_monitors(id,name,url) values ($1,$2,$3)', [id, 'Synthetic', 'https://site.audit.example.com']);
          let requests = 0;
          const loader = createWorkerLoader({ db: null, globals: {
            fetch: async (input, init) => {
              const url = new URL(String(input));
              if (url.origin === 'https://database.audit.example.com') {
                assert.equal(init.method, 'POST');
                assert.match(url.pathname, /^\/rest\/v1\/rpc\/cfm_[a-z_]+$/);
                await sql.exec('begin; set local role service_role');
                try {
                  const name = url.pathname.split('/').at(-1);
                  const args = JSON.parse(init.body);
                  const result = name === 'cfm_settings_by_keys'
                    ? (await sql.query('select cfm_settings_by_keys($1::text[]) as result', [args.input_keys])).rows[0].result
                    : await rpc(sql, name, args);
                  await sql.exec('commit');
                  return Response.json(result);
                } catch (error) {
                  await sql.exec('rollback');
                  throw error;
                }
              }
              assert.equal(url.toString(), hookUrl, 'all provider traffic stays at the synthetic boundary');
              requests += 1;
              return Response.json(successful ? provider.success : provider.failure);
            },
          } });
          const queries = loader.load('worker/src/db/queries.ts');
          const { recordHealthEvent } = loader.load('worker/src/utils/observability.ts');
          const { deliverNotification, dispatchNotification } = loader.load('worker/src/utils/notification-dispatch.ts');
          const database = { provider: 'supabase', env: { SUPABASE_URL: 'https://database.audit.example.com', SUPABASE_SECRET_KEY: 'sb_secret_synthetic' } };
          const key = `website:${id}`;
          const eventId = `down:${id}`;
          const now = '2026-09-09T10:00:00Z';
          const deliver = () => deliverNotification({
            claim: () => queries.claimNotificationDelivery(database, key, eventId, now, 0),
            complete: (token, sent) => queries.completeNotificationDelivery(database, key, eventId, token, sent, now, 0),
            send: () => dispatchNotification(database, {
              notification_method: 'webhook', webhook_format: provider.format,
              webhook_url: hookUrl, webhook_retry_count: '3',
            }, notification, { deps: { recordHealth: recordHealthEvent } }),
          });
          const delivered = await deliver();
          const state = (await sql.query('select status from cfm_internal.notification_delivery_state where key=$1', [key])).rows[0];
          const health = JSON.parse((await sql.query("select value from settings where key='health:webhook'")).rows[0].value);
          assert.deepEqual({ delivered, deliveryStatus: state.status, healthStatus: health.status, requests }, {
            delivered: successful,
            deliveryStatus: successful ? 'sent' : 'failed',
            healthStatus: successful ? 'ok' : 'error',
            requests: 1,
          });
          assert.doesNotMatch(health.detail, /synthetic-(response|request)-secret/);
          if (successful) {
            assert.equal(await deliver(), true);
            assert.equal(requests, 1, 'a completed event is not sent a second time');
          }
        });
      }
    }
  } finally { await sql.close(); }
});

for (const provider of providers) {
  const field = provider.format === 'feishu' ? 'code' : 'errcode';
  for (const [label, body] of [
    ['missing code', '{}'], ['null body', 'null'], ['array body', '[]'],
    ['null code', JSON.stringify({ [field]: null })],
    ['false code', JSON.stringify({ [field]: false })],
    ['empty code', JSON.stringify({ [field]: '' })],
    ['invalid JSON', '<html>synthetic-response-secret</html>'],
    ['incomplete JSON', `{"${field}":0`],
    ['oversized body', JSON.stringify({ [field]: 0, detail: 'x'.repeat(64 * 1024) })],
  ]) {
    test(`R-D04 ${provider.format} rejects ${label} without exposing response text`, async () => {
      const result = await loadSender()({ url: hookUrl, format: provider.format, retryCount: 3 }, notification, {
        fetch: async () => new Response(body, { status: 200 }),
      });
      assert.equal(result.ok, false);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-(response|request)-secret/);
    });
  }

  test(`R-D04 ${provider.format} retries a documented transient failure within its configured limit`, async () => {
    let requests = 0;
    const result = await loadSender()({ url: hookUrl, format: provider.format, retryCount: 3 }, notification, {
      fetch: async () => Response.json(++requests === 1 ? provider.transient : provider.success),
    });
    assert.equal(result.ok, true);
    assert.equal(requests, 2, 'a transient business failure must not be mistaken for delivery');
  });

  test(`R-D04 ${provider.format} does not disclose an HTTP error body`, async () => {
    const result = await loadSender()({ url: hookUrl, format: provider.format }, notification, {
      fetch: async () => new Response('synthetic-response-secret', { status: 403 }),
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /synthetic-response-secret/);
  });
}

test('R-D04 DingTalk also accepts the strict string-zero code in its official example', async () => {
  const result = await loadSender()({ url: hookUrl, format: 'dingtalk' }, notification, {
    fetch: async () => Response.json({ errcode: '0', errmsg: 'ok' }),
  });
  assert.equal(result.ok, true);
});

for (const format of ['generic', 'custom', 'slack', 'discord']) {
  test(`R-D04 ${format} keeps its HTTP success contract for arbitrary response fields`, async () => {
    const result = await loadSender()({ url: hookUrl, format }, notification, {
      fetch: async () => Response.json({ code: 19024, errcode: 93000, arbitrary: 'application-specific' }),
    });
    assert.equal(result.ok, true);
  });
}
