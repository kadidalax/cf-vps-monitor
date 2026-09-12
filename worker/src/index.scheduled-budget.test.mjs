import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import * as sba from './db/supabase-api/client.ts';
import * as dispatch from './utils/notification-dispatch.ts';
import * as offline from './utils/offline-notification.ts';
import * as websites from './utils/website-monitor.ts';
import * as templates from './utils/notification-templates.ts';
import { buildAdminSettings } from './settings/schema.ts';
import { createTestDatabase, rpc } from '../../scripts/test-support/postgres.mjs';
import { loadTypeScriptFunctions } from '../../scripts/test-support/typescript.mjs';

const budgetUrl = new URL('./utils/scheduled-budget.ts', import.meta.url);
const budgets = existsSync(budgetUrl) ? await import(budgetUrl) : {};

async function harness({ slow = false, redirects = false, offlineCount = 0, webhookFails = false, loadRules = 0 } = {}) {
  const database = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const base = Date.now();
  let clock = base;
  let requests = 0;
  const attempted = new Set();
  class ClockDate extends Date {
    constructor(value) { super(value === undefined ? clock : value); }
    static now() { return clock; }
  }
  const env = { SUPABASE_URL: 'https://synthetic.supabase.test', SUPABASE_SECRET_KEY: 'sb_secret_synthetic',
    LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: async (_url, init) => {
      const items = JSON.parse(init.body).clients;
      return Response.json({ ok: true, clients: Object.fromEntries(items.map(item => [item.uuid, { lastSeen: base - 86_400_000, offline: true, streak: 3 }])) });
    } }) } };
  const queries = await loadTypeScriptFunctions(new URL('./db/queries.ts', import.meta.url), null, { sba, redactDatabaseSecrets: value => value });
  const connection = { provider: 'supabase-api', env };
  const health = async (_db, component, status) => {
    await queries.getSetting(connection, `health:${component}`);
    await queries.setSetting(connection, `health:${component}`, JSON.stringify({ status }));
    if (status === 'error') {
      const claimed = await queries.tryClaimAuditThrottle(connection, `test:${component}`, new ClockDate().toISOString(), 60_000);
      if (claimed) await queries.insertAuditLog(connection, 'system', 'test_health', 'synthetic failure');
    }
  };
  globalThis.fetch = async (input, init = {}) => {
    requests += 1;
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.hostname === 'synthetic.supabase.test') {
      const name = url.pathname.split('/').at(-1);
      const body = JSON.parse(init.body);
      if (name === 'cfm_claim_notification_delivery') attempted.add(body.input_key);
      const value = name === 'cfm_settings_by_keys'
        ? (await database.query('select cfm_settings_by_keys($1::text[]) as value', [body.input_keys])).rows[0].value
        : await rpc(database, name, body);
      return value === undefined ? new Response(null, { status: 204 }) : Response.json(value);
    }
    if (url.hostname === 'website.example.com') {
      if (slow) {
        const remaining = budgets.currentScheduledBudget?.()?.remainingMs() ?? Infinity;
        const elapsed = Math.min(30_000, remaining);
        clock += elapsed;
        if (elapsed < 30_000) throw new DOMException('scheduled deadline', 'AbortError');
      }
      return new Response(null, { status: redirects ? 302 : slow ? 504 : 200,
        ...(redirects ? { headers: { Location: 'https://website.example.com/next' } } : {}) });
    }
    if (url.hostname === 'notify.example.com') return new Response(null, { status: webhookFails ? 503 : 200 });
    throw new Error(`Unexpected external request in synthetic test: ${url.hostname}`);
  };
  await rpc(database, 'cfm_set_settings', { input_settings: {
    maintenance_last_cleanup_at: new Date(base).toISOString(), notification_method: offlineCount ? 'webhook' : 'none',
    webhook_url: 'https://notify.example.com/hook', webhook_retry_count: '3', offline_confirm_rounds: '1',
  } });
  if (offlineCount) {
    await database.exec(`insert into clients(uuid,name,created_at) select 'node-'||n,'Node '||n,'2026-01-01' from generate_series(1,${offlineCount}) n;
      insert into offline_notifications(client,enable,grace_period) select uuid,1,30 from clients;`);
    if (loadRules) {
      await database.exec(`insert into load_notifications(name,metric,threshold,ratio,interval_min)
        select 'Rule '||n,'cpu',50+n,0.8,15 from generate_series(1,${loadRules}) n;
        insert into records(client,time,cpu) select uuid,now(),99 from clients cross join generate_series(1,2);`);
    }
  } else {
    await database.exec("insert into website_monitors(name,url,interval_sec,timeout_sec,grace_period_sec,agent_probe_mode) select 'Website '||n,'https://website.example.com/'||n,86400,30,86400,'off' from generate_series(1,50) n;");
  }
  const functions = await loadTypeScriptFunctions(new URL('./index.ts', import.meta.url), null, {
    ...dispatch, ...offline, ...websites, ...templates, ...budgets,
    ...(budgets.ScheduledBudget ? { ScheduledBudget: class extends budgets.ScheduledBudget { constructor() { super({ now: () => clock }); } } } : {}),
    Date: ClockDate, db: queries, getDatabase: () => connection, buildAdminSettings,
    bestEffortRecordHealthEvent: health, errorDetail: error => String(error),
    SCHEDULED_CURSOR_KEY: 'maintenance_cron_cursors',
    SCHEDULED_SETTING_KEYS: [...dispatch.NOTIFICATION_DISPATCH_SETTING_KEYS, 'maintenance_cron_cursors', 'maintenance_last_cleanup_at', 'record_preserve_time', 'ping_record_preserve_time', 'audit_log_preserve_time', 'offline_confirm_rounds'],
    RECORD_CLEANUP_LAST_RUN_KEY: 'maintenance_last_cleanup_at', RECORD_CLEANUP_INTERVAL_MS: 86_400_000,
  });
  return {
    database, attempted,
    run: async () => {
      requests = 0;
      const started = clock;
      await functions.runScheduled(env);
      const result = { requests, elapsed: clock - started };
      clock += 120_000;
      return result;
    },
    runLoadOnly: async () => {
      requests = 0;
      await database.query('update records set time=$1::timestamptz', [new Date(clock - 60_000).toISOString()]);
      const budget = new budgets.ScheduledBudget({ now: () => clock });
      await budgets.withScheduledBudget(budget, async () => {
        const context = functions.createScheduledRunContext(env);
        try { await functions.runLoadCheck(context, new ClockDate()); }
        catch (error) { if (!(error instanceof budgets.ScheduledBudgetExceeded)) throw error; }
        finally { await budget.complete(() => context.flushScheduledCursors()); }
      });
      clock += 600_000; // Same modulo as a five-stage Cron: exposes phase-locked group rotation.
      return requests;
    },
    close: async () => { globalThis.fetch = originalFetch; await database.close(); },
  };
}

test('AUD-14 each scheduled run stays within request budget and eventually checks all 50 websites', async () => {
  const h = await harness();
  try {
    let checked = 0;
    for (let round = 0; round < 12 && checked < 50; round += 1) {
      const run = await h.run();
      assert.ok(run.requests <= 50, `one invocation issued ${run.requests} external requests`);
      checked = (await h.database.query('select count(*)::integer as count from website_monitors where last_checked_at is not null')).rows[0].count;
    }
    assert.equal(checked, 50, 'bounded work must continue without starving later websites');
  } finally { await h.close(); }
});

test('AUD-14 slow/redirecting websites respect the total deadline without false failures from budget cancellation', async () => {
  const h = await harness({ slow: true, redirects: true });
  try {
    let checked = 0;
    for (let round = 0; round < 70 && checked < 50; round += 1) {
      const run = await h.run();
      assert.ok(run.elapsed <= 60_000, `invocation exceeded deadline: ${run.elapsed}ms`);
      assert.ok(run.requests <= 50);
      checked = (await h.database.query('select count(*)::integer as count from website_monitors where last_checked_at is not null')).rows[0].count;
    }
    assert.equal(checked, 50);
    assert.equal((await h.database.query("select count(*)::integer as count from website_checks where effective_status='down'")).rows[0].count, 0,
      'an invocation deadline is deferred work, not a failed website check');
  } finally { await h.close(); }
});

test('AUD-14 many offline notifications and webhook retries share the same budget and fair cursor', async () => {
  const h = await harness({ offlineCount: 60, webhookFails: true });
  try {
    for (let round = 0; round < 50 && h.attempted.size < 60; round += 1) {
      const run = await h.run();
      assert.ok(run.requests <= 50, `notification invocation issued ${run.requests} external requests`);
    }
    assert.equal(h.attempted.size, 60, 'repeated failures at the beginning cannot starve later alert targets');
    assert.equal((await h.database.query('select count(*)::integer as count from offline_notifications where last_notified is not null')).rows[0].count, 0);
  } finally { await h.close(); }
});

test('AUD-14 repeated partial load stages cannot phase-lock onto one of five rule groups', async () => {
  const h = await harness({ offlineCount: 60, loadRules: 5 });
  try {
    for (let round = 0; round < 10; round += 1) assert.ok(await h.runLoadOnly() <= 44);
    const visited = (await h.database.query("select distinct split_part(key,':',2) as rule from cfm_internal.notification_delivery_state where key like 'load:%'")).rows;
    assert.equal(visited.length, 5, 'all rule groups must get work even when the stage receives time on the same Cron phase');
  } finally { await h.close(); }
});
