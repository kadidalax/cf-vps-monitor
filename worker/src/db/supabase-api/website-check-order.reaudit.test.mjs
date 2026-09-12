import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';
import { createWorkerLoader } from '../../../test-support/worker-module.mjs';

const env = {
  SUPABASE_URL: 'https://synthetic.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
};
const database = { provider: 'supabase-api', env };
const iso = offset => new Date(Date.now() + offset).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(run, externalFetch = async () => new Response(null, { status: 200 })) {
  const sql = await createTestDatabase();
  try {
    await sql.exec('set role service_role');
    const loader = createWorkerLoader({ db: null, globals: { fetch: async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.origin === env.SUPABASE_URL) {
        assert.equal(init.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
        const name = parsed.pathname.split('/').at(-1);
        return Response.json(await rpc(sql, name, JSON.parse(init.body)));
      }
      assert.ok(parsed.hostname.endsWith('.audit.example.com'), 'real external requests are forbidden');
      return externalFetch(url, init);
    } } });
    const queries = loader.load('worker/src/db/queries.ts');
    const probe = loader.load('worker/src/utils/website-monitor.ts');
    const create = extra => queries.createWebsiteMonitor(database, {
      name: 'Synthetic website', url: 'https://target.audit.example.com/a',
      interval_sec: 60, timeout_sec: 2, grace_period_sec: 30,
      agent_probe_mode: 'off', agent_probe_status_enabled: true, ...extra,
    });
    const current = id => queries.getWebsiteMonitor(database, id);
    const record = check => queries.recordWebsiteCheck(database, check);
    const history = async id => plain(await queries.listWebsiteChecks(database, id, 100));
    await run({ sql, queries, probe, create, current, record, history });
  } finally { await sql.close(); }
}

function result(site, checked_at, ok, extra = {}) {
  return {
    monitor_id: site.id, config_revision: site.config_revision, checked_at, ok,
    effective_status: ok ? 'up' : 'down', effective_reason: ok ? 'status_in_expected_range' : 'http_status_mismatch',
    status_code: ok ? 200 : 503, raw_status_code: ok ? 200 : 503,
    latency_ms: 8, error: ok ? null : 'http_503', ...extra,
  };
}

for (const latestOk of [true, false]) {
  test(`R-D03 a late ${latestOk ? 'failure' : 'success'} cannot replace a newer result`, async () => {
    await fixture(async ({ create, current, record, history }) => {
      const site = await create();
      const latest = await record(result(site, iso(-1_000), latestOk));
      const late = await record(result(site, iso(-10_000), !latestOk));
      assert.equal(late, null, 'reject stale work before it creates notification eligibility');
      const saved = await current(site.id);
      assert.equal(saved.status, latest.status);
      assert.equal(saved.last_checked_at, latest.last_checked_at);
      assert.equal((await history(site.id)).length, 1, 'stale work cannot enter current availability history');
    });
  });
}

test('R-D03 a duplicated or contradictory timestamp is committed only once', async () => {
  await fixture(async ({ create, current, record, history }) => {
    const site = await create();
    const first = result(site, iso(-1_000), true);
    await record(first);
    assert.equal(await record(first), null, 'lost-response replay must not append another check');
    assert.equal(await record({ ...first, ok: false, effective_status: 'down', error: 'http_503' }), null);
    assert.equal((await current(site.id)).status, 'up');
    assert.equal((await history(site.id)).length, 1);
  });
});

for (const status of [200, 503]) {
  test(`R-D03 pausing during a real HTTP ${status} check keeps public state paused`, async () => {
    const started = deferred();
    const finish = deferred();
    await fixture(async ({ create, queries, probe, record, history }) => {
      const site = await create();
      const checking = probe.checkWebsiteMonitorHttp(site);
      await started.promise;
      try { assert.equal(await queries.setWebsiteMonitorEnabled(database, site.id, false), true); }
      finally { finish.resolve(); }
      const completed = await checking;
      assert.equal(await record(completed), null, 'a result cannot undo the administrator pause');
      const publicSite = await queries.getPublicWebsiteMonitorById(database, site.id);
      assert.equal(publicSite.status, 'paused');
      assert.deepEqual(plain(await queries.listDueWebsiteMonitors(database, iso(120_000))), []);
      assert.equal((await history(site.id)).length, 0);
      assert.equal(probe.shouldNotifyWebsiteDown({ ...site, enabled: false, status: 'down', down_since: iso(-60_000) }), false);
      assert.equal(probe.shouldNotifyWebsiteRecovery({ ...site, enabled: false, status: 'up', last_notified_at: iso(-60_000) }), false);
    }, async () => { started.resolve(); await finish.promise; return new Response(null, { status }); });
  });
}

for (const returnToOriginal of [false, true]) {
  test(`R-D03 a held HTTP check cannot overwrite ${returnToOriginal ? 'an A to B to A configuration' : 'a new URL'}`, async () => {
    const started = deferred();
    const finish = deferred();
    await fixture(async ({ create, queries, probe, record, current, history }) => {
      const site = await create();
      const checking = probe.checkWebsiteMonitorHttp(site);
      await started.promise;
      try {
        await queries.updateWebsiteMonitor(database, site.id, { url: 'https://other.audit.example.com/b' });
        if (returnToOriginal) await queries.updateWebsiteMonitor(database, site.id, { url: site.url });
      } finally { finish.resolve(); }
      const completed = await checking;
      assert.equal(await record(completed), null, 'the completed old target has no authority over the replacement');
      const saved = await current(site.id);
      assert.equal(saved.status, 'pending');
      assert.equal(saved.last_checked_at, null);
      assert.notEqual(saved.config_revision, site.config_revision);
      assert.equal(completed.config_revision, site.config_revision, 'echo the revision captured when the check started');
      assert.equal((await history(site.id)).length, 0);
    }, async () => { started.resolve(); await finish.promise; return new Response(null, { status: 503 }); });
  });
}

for (const connectOk of [true, false]) {
  test(`R-D03 TCP ${connectOk ? 'success' : 'failure'} carries the executed configuration`, async () => {
    await fixture(async ({ create, queries, probe, record, current }) => {
      const site = await create({ method: 'TCP', url: 'tcp://target.audit.example.com:443' });
      const opened = deferred();
      const checking = probe.checkWebsiteMonitorTcp(site, () => ({
        opened: opened.promise.then(() => { if (!connectOk) throw new Error('synthetic connection failed'); }),
        close: async () => {},
      }));
      try { await queries.updateWebsiteMonitor(database, site.id, { url: 'tcp://other.audit.example.com:443' }); }
      finally { opened.resolve(); }
      const completed = await checking;
      assert.equal(completed.ok, connectOk);
      assert.equal(await record(completed), null);
      assert.equal((await current(site.id)).status, 'pending');
      assert.equal(completed.config_revision, site.config_revision);
    });
  });
}

test('R-D03 valid Worker and Agent results retain fallback policy and reject Agent failure replay', async () => {
  await fixture(async ({ sql, create, record, current, history }) => {
    await sql.exec("insert into clients(uuid,name,token) values ('node-a','Synthetic Agent A','synthetic-a'), ('node-b','Synthetic Agent B','synthetic-b')");
    const site = await create({ agent_probe_mode: 'selected', agent_probe_clients: ['node-a'] });
    const checked = iso(-20_000);
    const failure = result(site, checked, false, { source_type: 'agent', source_client: 'node-a' });
    const fallback = await record(failure);
    assert.equal(fallback.status, 'pending', 'Agent failure requests fallback without directly marking down');
    assert.equal((await current(site.id)).last_checked_at, null);
    assert.equal(await record(failure), null, 'replayed failure must not trigger fallback again');
    assert.equal((await history(site.id)).length, 1);
    assert.equal((await record(result(site, iso(-15_000), false))).status, 'down');
    assert.equal((await record(result(site, iso(-10_000), true, { source_type: 'agent', source_client: 'node-b' }))).status, 'up');
    assert.equal(await record(result(site, iso(-5_000), false, { source_type: 'agent', source_client: 'node-a' })), null,
      'recent same-configuration success suppresses a redundant fallback');
    assert.equal((await current(site.id)).status, 'up');
  });
});

test('R-D03 an old Agent success cannot suppress due work or enter new public availability', async () => {
  await fixture(async ({ sql, create, queries, record, current }) => {
    await sql.exec("insert into clients(uuid,name,token) values ('node-a','Synthetic Agent','synthetic-node-token')");
    const site = await create({ agent_probe_mode: 'selected', agent_probe_clients: ['node-a'] });
    await record(result(site, iso(-5_000), true, { source_type: 'agent', source_client: 'node-a' }));
    await queries.updateWebsiteMonitor(database, site.id, { url: 'https://other.audit.example.com/b' });
    assert.equal((await current(site.id)).status, 'pending');
    assert.deepEqual(plain(await queries.listDueWebsiteMonitors(database, iso(0))).map(row => row.id), [site.id]);
    const listed = await queries.listPublicWebsiteMonitors(database);
    assert.deepEqual(plain(listed[0].checks), []);
    assert.deepEqual(plain((await queries.getPublicWebsiteMonitorById(database, site.id)).checks), []);
    const tasks = await queries.listAgentWebsiteProbeTasks(database, 'node-a', iso(0));
    assert.equal(tasks[0].config_revision, (await current(site.id)).config_revision);
    assert.notEqual(tasks[0].config_revision, site.config_revision);
  });
});

test('R-D03 restore with the same ID and target invalidates an earlier check', async () => {
  await fixture(async ({ create, queries, record, current }) => {
    const site = await create();
    await queries.restoreBackupData(database, { website_monitors: [site] });
    assert.equal(await record(result(site, iso(0), false)), null);
    const restored = await current(site.id);
    assert.equal(restored.status, 'pending');
    assert.notEqual(restored.config_revision, site.config_revision);
  });
});

test('R-D03 missing or invalid revision never borrows the current configuration', async () => {
  await fixture(async ({ create, record, current, history }) => {
    const site = await create();
    for (const revision of [undefined, '', 'invalid', '00000000-0000-0000-0000-000000000001']) {
      assert.equal(await record(result(site, iso(0), false, { config_revision: revision })), null);
    }
    assert.equal((await current(site.id)).status, 'pending');
    assert.equal((await history(site.id)).length, 0);
  });
});

test('R-D03 metadata edits preserve a valid in-flight check and ignore supplied revision', async () => {
  await fixture(async ({ create, queries, record, current }) => {
    const site = await create();
    await queries.updateWebsiteMonitor(database, site.id, {
      name: 'Renamed', hidden: true, hide_url: true, config_revision: '00000000-0000-0000-0000-000000000001',
    });
    assert.equal((await current(site.id)).config_revision, site.config_revision);
    assert.equal((await record(result(site, iso(-1_000), true))).status, 'up');
    assert.equal((await current(site.id)).name, 'Renamed');
  });
});

for (const change of ['configuration', 'event', 'pause']) {
  test(`R-D03 notification completion cannot mark a changed ${change}`, async () => {
    await fixture(async ({ create, queries, record, current }) => {
      const site = await create();
      const observed = await record(result(site, iso(-60_000), false));
      if (change === 'configuration') await queries.updateWebsiteMonitor(database, site.id, { url: 'https://other.audit.example.com/b' });
      else if (change === 'pause') await queries.setWebsiteMonitorEnabled(database, site.id, false);
      else {
        await record(result(site, iso(-40_000), true));
        await record(result(site, iso(-20_000), false));
      }
      assert.equal(await queries.markWebsiteMonitorNotified(database, site.id, iso(0), observed), false,
        'a send started from a stale observation cannot set the new event cooldown');
      assert.equal((await current(site.id)).last_notified_at, null);
    });
  });
}

test('R-D03 matching notification completion and recovery clear still succeed', async () => {
  await fixture(async ({ create, queries, record, current }) => {
    const site = await create();
    const down = await record(result(site, iso(-60_000), false));
    assert.equal(await queries.markWebsiteMonitorNotified(database, site.id, iso(-50_000), down), true);
    const up = await record(result(site, iso(-40_000), true));
    assert.ok(up.last_notified_at);
    assert.equal(await queries.markWebsiteMonitorNotified(database, site.id, null, up), true);
    assert.equal((await current(site.id)).last_notified_at, null);
    assert.equal(await queries.markWebsiteMonitorNotified(database, site.id, iso(0), down), false,
      'an already completed observation cannot be replayed later');
  });
});
