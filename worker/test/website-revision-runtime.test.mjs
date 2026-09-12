import assert from 'node:assert/strict';
import test from 'node:test';
import { generateToken } from '../src/auth/jwt.ts';
import { createRuntimeFixture, runtimeSecrets } from '../test-support/runtime-fixture.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function websocketReceipt(ws, envelope) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error('Missing website report receipt')); }, 8000);
    const listener = event => {
      const value = JSON.parse(event.data);
      if (!['ack', 'error'].includes(value.type)) return;
      clearTimeout(timer); ws.removeEventListener('message', listener); resolve(value);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify(envelope));
  });
}

test('R-D03 native Agent and manual-check paths respect website configuration ownership', { timeout: 120000 }, async t => {
  let lostReceiptFor = null;
  let blockedCheck = null;
  const forwarded = [];
  const f = await createRuntimeFixture({
    persistDurableObjects: true,
    externalResponse: async request => {
      if (blockedCheck && new URL(request.url).pathname === blockedCheck.path) {
        blockedCheck.started.resolve();
        await blockedCheck.release.promise;
        return new Response(null, { status: blockedCheck.status });
      }
      return new Response(null, { status: 200 });
    },
    rpcHook: ({ name, args, phase }) => {
      if (name !== 'cfm_record_website_check') return;
      if (phase === 'before') forwarded.push(args.input_check);
      if (phase === 'after' && args.input_check.monitor_id === lostReceiptFor) {
        return Response.json({ code: 'SYNTHETIC_LOST_RECEIPT', message: 'Saved website check but response lost' }, { status: 503 });
      }
    },
  });
  t.after(() => f.close());
  const agentToken = 'synthetic-website-revision-token-'.padEnd(64, '0');
  await f.database.query("insert into clients(uuid,name,token) values ('revision-node','Synthetic revision Agent',$1)", [agentToken]);
  await f.database.query("insert into ping_tasks(id,name,type,target,all_clients,interval_sec) values (1,'Synthetic ping','tcp','target.audit.example.com:443',1,120)");
  await f.database.query("insert into users(uuid,username,passwd) values ('revision-admin','revision-admin','synthetic-unused-password')");
  const token = await generateToken('revision-admin', 'revision-admin', 1, runtimeSecrets);
  const csrf = 'b'.repeat(32);
  const adminPost = (path, body) => f.fetch(path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Cookie: `cf_monitor_session=${token}; cf_monitor_csrf=${csrf}`, 'X-CSRF-Token': csrf,
  }, body: JSON.stringify(body) });
  let counter = 0;
  const create = async () => (await f.database.query(`insert into website_monitors(name,url,agent_probe_mode,agent_probe_clients,agent_probe_status_enabled)
    values ('Synthetic site',$1,'selected','["revision-node"]',true) returning *`, [`https://target.audit.example.com/site-${++counter}`])).rows[0];
  const current = async site => (await f.database.query('select * from website_monitors where id=$1', [site.id])).rows[0];
  const history = async site => (await f.database.query('select * from website_checks where monitor_id=$1 order by checked_at', [site.id])).rows;
  const stubFor = async name => {
    const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
    return namespace.get(namespace.idFromName(name));
  };
  const reportFor = (site, revision = site.config_revision) => ({ cpu: 17, timestamp: Date.now(), website_probe_results: [{
    monitor_id: site.id, config_revision: revision, ok: true, effective_status: 'up',
    status_code: 200, raw_status_code: 200, latency_ms: 11,
  }] });
  const post = (stub, report) => stub.fetch('https://do/client-report', { method: 'POST', body: JSON.stringify({
    uuid: 'revision-node', name: 'Synthetic revision Agent', report,
  }) });

  for (const format of ['http', 'report', 'reports']) await t.test(`${format} saves a valid Agent result with its original revision`, async () => {
    const site = await create();
    const report = reportFor(site);
    const stub = await stubFor(`website-valid-${format}`);
    if (format === 'http') {
      const response = await f.fetch('/api/clients/report', { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}`,
      }, body: JSON.stringify(report) });
      assert.equal(response.status, 200, await response.clone().text());
    } else {
      const response = await stub.fetch('https://do/?role=agent&id=revision-node&name=Synthetic', { headers: { Upgrade: 'websocket' } });
      assert.equal(response.status, 101);
      const ws = response.webSocket;
      ws.accept();
      t.after(() => { try { ws.close(); } catch {} });
      const envelope = format === 'report' ? { type: format, data: report } : { type: format, reports: [report] };
      assert.equal((await websocketReceipt(ws, envelope)).type, 'ack');
    }
    const saved = await history(site);
    assert.equal(saved.length, 1, 'An acknowledged current Agent result must actually be saved');
    assert.equal(saved[0].config_revision, site.config_revision);
    assert.equal((await current(site)).status, 'up');
  });

  await t.test('old and missing revisions are discarded while current metrics and Ping remain usable', async () => {
    const site = await create();
    await f.database.query('update website_monitors set url=$2 where id=$1', [site.id, `${site.url}/changed`]);
    const active = await current(site);
    const report = reportFor(site);
    report.website_probe_results.push({ ...report.website_probe_results[0], config_revision: undefined });
    report.website_probe_results.push({ ...report.website_probe_results[0], config_revision: 'invalid-revision' });
    report.ping_results = [{ task_id: 1, value: 11 }];
    const response = await post(await stubFor('website-stale-mixed'), report);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await history(site)).length, 0);
    assert.equal((await current(site)).status, 'pending');
    assert.notEqual(active.config_revision, site.config_revision);
    const submitted = forwarded.filter(check => check.monitor_id === site.id);
    assert.equal(submitted.length, 1, 'Malformed revisions are dropped at the Agent boundary');
    assert.equal(submitted[0].config_revision, site.config_revision, 'Never substitute the current revision for a stale result');
    assert.equal((await f.database.query("select count(*)::int as n from ping_snapshots where client='revision-node'")).rows[0].n, 1);
  });

  await t.test('lost SQL confirmation followed by cold retry keeps one original website check', async () => {
    const site = await create();
    const report = reportFor(site);
    let stub = await stubFor('website-lost-receipt');
    lostReceiptFor = site.id;
    const first = await post(stub, report);
    lostReceiptFor = null;
    assert.ok(first.status >= 500, 'The Agent must retain a report without a successful SQL receipt');
    assert.equal((await history(site)).length, 1, 'The injected loss happens after the SQL commit');
    await f.restart();
    stub = await stubFor('website-lost-receipt');
    assert.equal((await post(stub, report)).status, 200);
    const saved = await history(site);
    assert.equal(saved.length, 1, 'Original sample time and revision make the cold replay idempotent');
    assert.equal(new Date(saved[0].checked_at).getTime(), report.timestamp);
  });

  for (const status of [200, 503]) await t.test(`authenticated pause during a held HTTP ${status} check preserves paused public state`, async () => {
    const site = await create();
    blockedCheck = { path: new URL(site.url).pathname, status, started: deferred(), release: deferred() };
    const request = adminPost(`/api/admin/websites/${site.id}/check`, {});
    await blockedCheck.started.promise;
    try {
      const paused = await adminPost('/api/admin/websites/enabled', { id: site.id, enabled: false });
      assert.equal(paused.status, 200, await paused.clone().text());
    } finally { blockedCheck.release.resolve(); }
    const completed = await request;
    blockedCheck = null;
    assert.equal(completed.status, 200, await completed.clone().text());
    assert.equal((await completed.json()).monitor, null, 'A rejected late check cannot grant notification eligibility');
    const publicResponse = await f.fetch(`/api/websites/${site.id}`);
    assert.equal(publicResponse.status, 200, await publicResponse.clone().text());
    assert.equal((await publicResponse.json()).status, 'paused');
    assert.equal((await history(site)).length, 0);
    assert.equal((await current(site)).last_notified_at, null);
  });
});
