import assert from 'node:assert/strict';
import test from 'node:test';
import { applyApplicationMigrations, createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';
import { createWorkerLoader } from '../../../test-support/worker-module.mjs';

const iso = ms => new Date(ms).toISOString();
async function fixture(run) {
  const sql = await createTestDatabase();
  try {
    await sql.exec('set role service_role');
    const start = Date.now();
    const claim = (key, event = 'event-a', offset = 0) => rpc(sql, 'cfm_claim_notification_delivery', {
      input_key: key, input_event_id: event, input_now: iso(start + offset), input_repeat_ms: 0,
    });
    const complete = (key, token, { event = 'event-a', success = true, offset = 1 } = {}) => rpc(sql, 'cfm_complete_notification_delivery', {
      input_key: key, input_event_id: event, input_token: token, input_success: success,
      input_now: iso(start + offset), input_repeat_ms: 0,
    });
    const rows = async () => (await sql.query('select * from cfm_internal.notification_delivery_state order by key')).rows;
    const website = async () => rpc(sql, 'cfm_create_website_monitor', { input_monitor: {
      name: 'Synthetic website', url: 'https://site.audit.example.com', agent_probe_mode: 'off',
    } });
    await run({ sql, start, claim, complete, rows, website });
  } finally { await sql.close(); }
}

test('R-D06 deleting a website retires its completed delivery state', async () => {
  await fixture(async ({ sql, claim, complete, rows, website }) => {
    const site = await website();
    const key = `website:${site.id}`;
    const attempt = await claim(key);
    assert.equal(await complete(key, attempt.token), true);
    assert.equal((await rows())[0].status, 'sent');
    await rpc(sql, 'cfm_delete_website_monitor', { input_id: site.id });
    assert.deepEqual(await rows(), [], 'a completed state for a removed entity must be reclaimed');
  });
});

test('R-D06 a different event cannot steal an unexpired pending lease', async () => {
  await fixture(async ({ claim, complete, rows, website }) => {
    const site = await website();
    const key = `website:${site.id}`;
    const first = await claim(key);
    assert.equal((await claim(key, 'event-b', 1_000)).claimed, false);
    assert.equal((await rows())[0].claim_token, first.token);
    assert.equal(await complete(key, first.token), true);
    const next = await claim(key, 'event-b', 2_000);
    assert.equal(next.claimed, true, 'a new event can start after the previous one completes');
    assert.notEqual(next.token, first.token);
    assert.equal(await complete(key, first.token), false);
  });
});

test('R-D06 deletion preserves an active token until matching completion retires it', async () => {
  await fixture(async ({ sql, claim, complete, rows, website }) => {
    const site = await website();
    const key = `website:${site.id}`;
    const first = await claim(key);
    await rpc(sql, 'cfm_delete_website_monitor', { input_id: site.id });
    assert.equal((await rows())[0].claim_token, first.token);
    assert.equal((await claim(key, 'event-b', 1_000)).claimed, false);
    assert.equal(await complete(key, 'wrong-token'), false);
    assert.equal((await rows())[0].claim_token, first.token);
    assert.equal(await complete(key, first.token), false,
      'retiring a completed old attempt must not authorize a replacement event marker');
    assert.deepEqual(await rows(), []);
  });
});

test('R-D06 client deletion cleans its full colon-containing identity without touching another client', async () => {
  await fixture(async ({ sql, claim, complete, rows }) => {
    await sql.exec(`
      insert into clients(uuid,name) values ('region:node','Synthetic colon node'), ('node','Synthetic survivor');
      insert into offline_notifications(client,enable) values ('region:node',1),('node',1);
      insert into expiry_notifications(client,enable) values ('region:node',1),('node',1);
      insert into load_notifications(id,name,clients) values (7,'Synthetic all nodes','[]');
    `);
    for (const client of ['region:node', 'node']) for (const prefix of ['offline', 'expiry', 'load:7']) {
      const key = `${prefix}:${client}`;
      const claimed = await claim(key);
      await complete(key, claimed.token);
    }
    await rpc(sql, 'cfm_delete_clients', { input_uuids: ['region:node'] });
    assert.deepEqual((await rows()).map(row => row.key), ['expiry:node', 'load:7:node', 'offline:node']);
  });
});

test('R-D06 notification rule deletion reclaims inactive states for all its targets', async () => {
  await fixture(async ({ sql, claim, complete, rows }) => {
    await sql.exec(`insert into clients(uuid,name) values ('node-a','A'),('node-b','B');
      insert into load_notifications(id,name,clients) values (7,'Removed rule','[]'),(8,'Kept rule','[]');`);
    for (const key of ['load:7:node-a', 'load:7:node-b', 'load:8:node-a']) {
      const attempt = await claim(key);
      await complete(key, attempt.token, { success: key !== 'load:7:node-b' });
    }
    await rpc(sql, 'cfm_delete_load_notification', { input_id: 7 });
    assert.deepEqual((await rows()).map(row => row.key), ['load:8:node-a']);
  });
});

for (const pending of [false, true]) {
  test(`R-D06 same-ID website restore retires ${pending ? 'pending' : 'sent'} previous lifecycle`, async () => {
    await fixture(async ({ sql, claim, complete, rows, website }) => {
      const site = await website();
      const key = `website:${site.id}`;
      const first = await claim(key);
      if (!pending) await complete(key, first.token);
      await rpc(sql, 'cfm_restore_backup_data', { input_backup: { website_monitors: [site] } });
      if (pending) {
        assert.equal((await claim(key, 'new-lifecycle', 1000)).claimed, false);
        assert.equal((await rows())[0].claim_token, first.token);
        assert.equal(await complete(key, first.token), false);
      }
      assert.deepEqual(await rows(), [], 'restore cannot inherit completed delivery suppression');
      assert.equal((await claim(key, 'event-a', 2000)).claimed, true, 'the reused event ID is independent after restoration');
    });
  });
}

for (const kind of ['expiry', 'load']) for (const restorePoint of ['none', 'before-complete', 'after-complete']) {
  test(`R-D06 actual ${kind} delivery with ${restorePoint} restoration cannot mark a replacement`, async () => {
    await fixture(async ({ sql, start }) => {
      const client = `${kind}-node`;
      await sql.query('insert into clients(uuid,name,expired_at) values ($1,$2,$3)', [client, 'Original node', iso(start + 86_400_000)]);
      if (kind === 'expiry') await sql.query('insert into expiry_notifications(client,enable,advance_days) values ($1,1,7)', [client]);
      else {
        await sql.exec("insert into load_notifications(id,name,clients,metric,threshold,ratio,interval_min) values (7,'Original rule','[]','cpu',80,0.8,15)");
        await sql.query('insert into records(client,time,cpu) values ($1,$2,99),($1,$3,99)', [client, iso(start - 60_000), iso(start - 30_000)]);
      }
      const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' };
      const database = { provider: 'supabase-api', env };
      let restores = 0;
      let sends = 0;
      const restore = async () => {
        restores += 1;
        await rpc(sql, 'cfm_restore_backup_data', { input_backup: {
          clients: [{ uuid: client, name: 'Restored same ID', expired_at: iso(start + 86_400_000) }],
          ...(kind === 'expiry'
            ? { expiry_notifications: [{ client, enable: true, advance_days: 7, last_notified: null }] }
            : { load_notifications: [{ id: 7, name: 'Restored same rule ID', clients: [], metric: 'cpu', threshold: 80,
              ratio: 0.8, interval_min: 15, last_notified: null }] }),
        } });
      };
      const loader = createWorkerLoader({ db: null, expose: { 'worker/src/index.ts': ['runExpiryCheck', 'runLoadCheck'] }, globals: {
        fetch: async (url, init) => {
          const parsed = new URL(String(url));
          if (parsed.origin !== env.SUPABASE_URL) {
            assert.equal(parsed.hostname, 'hook.audit.example.com', 'no real notification endpoints');
            sends += 1;
            if (restorePoint === 'before-complete') await restore();
            return new Response(null, { status: 200 });
          }
          const name = parsed.pathname.split('/').at(-1);
          const args = JSON.parse(init.body);
          const value = name === 'cfm_settings_by_keys'
            ? (await sql.query('select cfm_settings_by_keys($1::text[]) as result', [args.input_keys])).rows[0].result
            : await rpc(sql, name, args);
          if (restorePoint === 'after-complete' && name === 'cfm_complete_notification_delivery' && value === true) {
            // SQL has committed, but the Worker has not received completion yet.
            await restore();
          }
          return Response.json(value);
        },
      } });
      const queries = loader.load('worker/src/db/queries.ts');
      const pipeline = loader.load('worker/src/index.ts');
      await pipeline[kind === 'expiry' ? 'runExpiryCheck' : 'runLoadCheck']({
        database, env, getClients: async () => queries.listClients(database),
        getAdminSettings: async () => ({ notification_method: 'webhook', webhook_url: 'https://hook.audit.example.com/notify',
          webhook_format: 'generic', webhook_retry_count: '0' }),
      }, new Date(start));
      assert.equal(sends, 1);
      assert.equal(restores, restorePoint === 'none' ? 0 : 1);
      const saved = kind === 'expiry'
        ? await rpc(sql, 'cfm_expiry_notification', { input_client: client })
        : await rpc(sql, 'cfm_load_notification', { input_id: 7 });
      if (restorePoint === 'none') assert.ok(saved.last_notified, 'normal confirmed delivery marks its current event');
      else assert.equal(saved.last_notified, null, 'a completed old send has no authority over the restored entity');
    });
  });
}

test('R-D06 bounded cleanup retires legacy orphans and waits for active leases without erasing live sent events', async () => {
  await fixture(async ({ sql, start, rows, website }) => {
    const site = await website();
    await sql.exec("insert into clients(uuid,name) values ('live:client','Synthetic live client'); insert into load_notifications(id,name,clients) values (7,'Current rule','[]')");
    const legacy = [
      [`website:${site.id}`, 'sent', null, start - 86_400_000],
      ['load:7:live:client', 'sent', null, start - 86_400_000],
      ['custom:unclassified', 'sent', null, start - 86_400_000],
      ['website:999', 'sent', null, start - 86_400_000],
      ['load:77:live:client', 'failed', null, start - 86_400_000],
      ['load:7:missing:client', 'sent', null, start - 86_400_000],
      ['offline:removed:client', 'pending', 'active-legacy-token', start + 90_000],
    ];
    for (const [key, status, token, deadline] of legacy) await sql.query(`
      insert into cfm_internal.notification_delivery_state(key,event_id,status,attempts,next_attempt_at,claim_token,delivered_at,updated_at)
      values ($1,'legacy-event',$2,1,$3,$4,$5,$5)
    `, [key, status, iso(deadline), token, iso(start - 86_400_000)]);
    let deleted = 0;
    for (let batch = 0; batch < 4; batch += 1) {
      const result = await rpc(sql, 'cfm_cleanup_notification_delivery_state', {
        input_now: iso(start), input_batch_size: 2, input_max_batches: 1,
      });
      assert.equal(typeof result.notification_delivery_state, 'number');
      assert.ok(result.notification_delivery_state <= 2);
      assert.equal(result.has_more, true, 'an active retired lease requires a later cleanup pass');
      deleted += result.notification_delivery_state;
    }
    assert.equal(deleted, 3);
    const active = (await rows()).find(row => row.key === 'offline:removed:client');
    assert.equal(active.claim_token, 'active-legacy-token');
    assert.equal(active.status, 'pending');
    assert.ok(active.retired_at);
    const final = await rpc(sql, 'cfm_cleanup_notification_delivery_state', {
      input_now: iso(start + 90_001), input_batch_size: 2, input_max_batches: 1,
    });
    assert.deepEqual(final, { notification_delivery_state: 1, has_more: false });
    assert.deepEqual((await rows()).map(row => row.key), ['custom:unclassified', 'load:7:live:client', `website:${site.id}`]);
    const access = (await sql.query(`select
      has_function_privilege('anon','public.cfm_cleanup_notification_delivery_state(timestamptz,integer,integer)','execute') as anon,
      has_function_privilege('authenticated','public.cfm_cleanup_notification_delivery_state(timestamptz,integer,integer)','execute') as authenticated,
      has_function_privilege('service_role','public.cfm_cleanup_notification_delivery_state(timestamptz,integer,integer)','execute') as service
    `)).rows[0];
    assert.deepEqual(access, { anon: false, authenticated: false, service: true });
  });
});

test('R-D06 a legacy sent token is minted without resending and cannot cross a same-event restore', async () => {
  await fixture(async ({ sql, start, claim, complete }) => {
    await sql.query("insert into clients(uuid,name,expired_at) values ('node-a','Original',$1)", [iso(start + 86_400_000)]);
    await sql.exec("insert into expiry_notifications(client,enable,advance_days) values ('node-a',1,7)");
    await sql.query(`insert into cfm_internal.notification_delivery_state
      (key,event_id,status,attempts,next_attempt_at,claim_token,delivered_at,updated_at)
      values ('expiry:node-a','event-a','sent',1,$1,null,$1,$1)`, [iso(start - 1_000)]);
    const prior = await claim('expiry:node-a');
    assert.equal(prior.claimed, false);
    assert.equal(prior.delivered, true);
    assert.match(prior.token, /^[0-9a-f-]{36}$/);
    assert.equal((await claim('expiry:node-a')).token, prior.token);
    assert.equal(await rpc(sql, 'cfm_mark_expiry_notification_sent', {
      input_client: 'node-a', input_time: iso(start), input_token: prior.token,
    }), true);
    await rpc(sql, 'cfm_restore_backup_data', { input_backup: {
      clients: [{ uuid: 'node-a', name: 'Replacement', expired_at: iso(start + 86_400_000) }],
      expiry_notifications: [{ client: 'node-a', enable: true, advance_days: 7, last_notified: null }],
    } });
    const next = await claim('expiry:node-a');
    assert.equal(next.claimed, true, 'same key, event and time must get a new lifecycle credential');
    assert.notEqual(next.token, prior.token);
    assert.equal(await complete('expiry:node-a', next.token), true);
    assert.equal(await rpc(sql, 'cfm_mark_expiry_notification_sent', {
      input_client: 'node-a', input_time: iso(start), input_token: prior.token,
    }), false, 'event ID alone is not enough to identify the completed lifecycle');
    assert.equal((await rpc(sql, 'cfm_expiry_notification', { input_client: 'node-a' })).last_notified, null);
    assert.equal(await rpc(sql, 'cfm_mark_expiry_notification_sent', {
      input_client: 'node-a', input_time: iso(start), input_token: next.token,
    }), true);
    await sql.exec('reset role');
    await applyApplicationMigrations(sql);
    await sql.exec('set role service_role');
    const replayed = await claim('expiry:node-a');
    assert.equal(replayed.delivered, true);
    assert.equal(replayed.token, next.token, 'aggregate replay preserves live delivery suppression');
    assert.equal(await rpc(sql, 'cfm_mark_expiry_notification_sent', { input_client: 'node-a', input_time: iso(start) }), false,
      'an older caller with no completion token cannot advance the marker');
  });
});

test('R-D06 active retirement survives expiry and a new owner can acquire a fresh lease', async () => {
  await fixture(async ({ sql, claim, complete, rows, website }) => {
    const site = await website();
    const key = `website:${site.id}`;
    const first = await claim(key);
    await rpc(sql, 'cfm_restore_backup_data', { input_backup: { website_monitors: [site] } });
    assert.equal((await claim(key, 'event-a', 89_999)).claimed, false);
    const retry = await claim(key, 'event-a', 90_001);
    assert.equal(retry.claimed, true);
    assert.notEqual(retry.token, first.token);
    assert.equal((await rows())[0].retired_at, null);
    assert.equal(await complete(key, first.token), false);
    assert.equal(await complete(key, retry.token), true);
  });
});
