import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const frontend = fileURLToPath(new URL('../../', import.meta.url));
const project = dirname(frontend);
const require = createRequire(join(frontend, 'package.json'));

export function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

export async function deadline(promise, description, timeout = 15_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture deadline: ${description}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function settleRender(page) {
  await deadline(page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })), 'browser render after completed request');
}

export async function settleCall(page, call) {
  await deadline(call.finished, `request completion: ${call.method} ${call.path}`);
  await settleRender(page);
}

export async function waitForCall(data, predicate, after = 0) {
  const existing = data.calls.slice(after).find(predicate);
  if (existing) return existing;
  const next = deferred();
  const listener = call => { if (predicate(call)) next.resolve(call); };
  data.callListeners.add(listener);
  try {
    return await deadline(next.promise, 'expected intercepted API request');
  } finally {
    data.callListeners.delete(listener);
  }
}

export function fixture() {
  const now = new Date().toISOString();
  return {
    authenticated: true, calls: [], callListeners: new Set(), handlers: [], failures: {}, errors: [], observed: {},
    settings: { site_title: 'Synthetic Monitor', site_subtitle: 'Synthetic subtitle', site_logo_url: '', active_theme: 'monitor', script_domain: '', theme_settings: {} },
    general: { record_enabled: 'true', record_preserve_time: '48', ping_record_preserve_time: '48', live_poll_active_interval_sec: '3', live_poll_idle_interval_sec: '600', record_persist_interval_sec: '60', ping_record_persist_interval_sec: '300', live_poll_active_max_duration_sec: '600', record_high_watermark_rows: '700000', record_high_watermark_bytes: '419430400', capacity_daily_view_minutes: '0' },
    clients: [{ uuid: 'node-a', name: 'Alpha Server', cpu_name: 'Synthetic CPU', cpu_cores: 2, os: 'Debian', arch: 'amd64', region: 'CN', mem_total: 2147483648, disk_total: 10737418240, swap_total: 0, group: '', tags: '', hidden: false, price: 0, billing_cycle: 30, currency: '$', expired_at: '', traffic_limit: 0, traffic_reset_day: 1, traffic_limit_type: 'sum', sort_order: 0, gpu_name: '', public_remark: '', remark: '', version: 'v1.0.0', token_last_used_at: null, token_last_used_ip: '', token_rotated_at: null, created_at: now, updated_at: now, auto_renewal: false }],
    websites: [{ id: 1, name: 'Synthetic website', url: 'https://synthetic.invalid/private-path', method: 'GET', expected_status_min: 200, expected_status_max: 399, interval_sec: 120, timeout_sec: 10, grace_period_sec: 180, enabled: true, hidden: false, hide_url: false, agent_probe_mode: 'off', agent_probe_clients: [], agent_probe_limit: 3, agent_probe_status_enabled: false, status: 'up', last_checked_at: now, last_status_code: 200, last_raw_status_code: 200, last_latency_ms: 10, last_effective_reason: null, checks: [], sort_order: 1 }],
    checks: {},
    mfa: { enabled: false, enabled_at: null, recovery_codes_remaining: 0 },
  };
}

export async function createHarness({ selection = 'ALL', playwrightModule } = {}) {
  let modulePath;
  try {
    modulePath = playwrightModule ? resolve(playwrightModule) : require.resolve('playwright');
  } catch (error) {
    throw new Error('Browser fixture prerequisite: install Playwright locally or pass --playwright-module <installed entry point>.', { cause: error });
  }
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
  const temporaryRoot = join(project, '.tmp', 'frontend-reaudit-browser');
  const envDir = join(temporaryRoot, 'empty-env');
  await mkdir(envDir, { recursive: true });
  process.chdir(frontend);
  const startedAt = new Date().toISOString();
  const server = await createServer({
    root: frontend, configFile: false, envDir,
    cacheDir: join(temporaryRoot, 'vite-cache'), plugins: [react()],
    define: { __BUILD_TIME__: JSON.stringify(startedAt) },
    server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error',
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
    });
  } catch (error) {
    await server.close();
    throw error;
  }
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  const results = [];

  async function contextFor(data, width) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const requests = new WeakMap();
    const lifecycleFor = request => {
      let lifecycle = requests.get(request);
      if (!lifecycle) { lifecycle = deferred(); requests.set(request, lifecycle); }
      return lifecycle;
    };
    context.on('request', lifecycleFor);
    context.on('requestfinished', request => lifecycleFor(request).resolve('finished'));
    context.on('requestfailed', request => lifecycleFor(request).resolve('failed'));
    context.on('page', page => {
      page.setDefaultTimeout(12_000);
      page.on('pageerror', error => data.errors.push(error.message));
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { await route.abort('blockedbyclient'); return; }
      const path = url.pathname;
      if (!path.startsWith('/api/')) { await route.continue(); return; }
      let body;
      try { body = request.postDataJSON(); } catch { body = '[synthetic non-JSON request]'; }
      const call = { path, search: url.search, method: request.method(), body };
      Object.defineProperty(call, 'finished', { value: lifecycleFor(request).promise });
      data.calls.push(call);
      for (const listener of data.callListeners) listener(call);
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      for (const handler of data.handlers) {
        if (await handler({ route, request, url, path, body, call, json })) return;
      }
      const failure = data.failures[`${request.method()} ${path}`] || data.failures[path];
      if (failure) return json({ error: typeof failure === 'string' ? failure : failure.error }, typeof failure === 'string' ? 500 : failure.status);
      if (path === '/api/me') return data.authenticated ? json({ uuid: 'synthetic-admin', username: 'synthetic-owner' }) : json({ error: 'Not signed in' }, 401);
      if (path === '/api/login' || path === '/api/login/mfa') { data.authenticated = true; return json({ user: { uuid: 'synthetic-admin', username: 'synthetic-owner' } }); }
      if (path === '/api/logout') { data.authenticated = false; return json({ success: true }); }
      if (path === '/api/version') return json({ version: 'dev', hash: 'dev' });
      if (path === '/api/admin/update-check') return json({ current_version: 'dev', latest_version: 'dev', has_update: false, source_url: 'https://github.com/example/synthetic', upgrade_url: null });
      if (path === '/api/admin/recovery/status') return json({ admin_present: true, recoverable: true });
      if (path === '/api/public') return json(data.settings);
      if (path === '/api/theme/active.css') return route.fulfill({ contentType: 'text/css', body: '' });
      const isPublic = !url.searchParams.has('include_hidden');
      const clients = data.clients.filter(client => !isPublic || !client.hidden);
      const live = {
        online: clients.map(client => client.uuid), clients: clients.map(client => ({ uuid: client.uuid, name: client.name, lastReportTime: Date.now() })),
        data: Object.fromEntries(clients.map(client => [client.uuid, { cpu: 20, ram: 1024, ram_total: 2048, disk: 1024, disk_total: 4096, load: 0.5, net_in: 0, net_out: 0, time: new Date().toISOString() }])),
        timestamp: Date.now(), count: clients.length, metadata_version: 'synthetic-v1',
      };
      if (path === '/api/public/bootstrap') return json({ clients, nodes: clients, settings: data.settings, live, metadata_version: 'synthetic-v1' });
      if (path === '/api/live/clients') return json(live);
      if (path === '/api/ws/live-token') return json({ error: 'Synthetic HTTP-only fixture' }, 401);
      if (path === '/api/admin/clients') return json(data.clients);
      if (path === '/api/admin/clients/batch-hide') {
        for (const client of data.clients) if (body.uuids.includes(client.uuid)) client.hidden = true;
        return json({ success: true, updated: body.uuids.length });
      }
      if (path === '/api/admin/clients/reorder') {
        data.clients = body.uuids.map((uuid, index) => ({ ...data.clients.find(client => client.uuid === uuid), sort_order: index }));
        return json({ success: true });
      }
      if (path === '/api/clients' || path === '/api/nodes') return json(clients);
      const clientEdit = /^\/api\/admin\/clients\/([^/]+)\/edit$/.exec(path);
      if (clientEdit) {
        const client = data.clients.find(item => item.uuid === clientEdit[1]);
        Object.assign(client, body); return json({ success: true, client });
      }
      if (path === '/api/admin/settings') {
        if (request.method() === 'GET') return json(url.searchParams.get('scope') === 'general' ? data.general : Object.fromEntries(Object.entries(data.settings).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])));
        for (const [key, value] of Object.entries(body)) {
          if (key in data.general) data.general[key] = value;
          else data.settings[key] = value;
        }
        return json({ success: true });
      }
      if (path === '/api/admin/site-logo' || path === '/api/admin/site-logo/reset') {
        data.settings.site_logo_url = path.endsWith('/reset') ? '' : '/fixture-logo.png';
        return json({ success: true, site_logo_url: data.settings.site_logo_url });
      }
      if (path === '/api/admin/capacity') return json({ clients: data.clients.length, gpu_clients: 0, ping_records_per_day: 0, ping_tasks: [], history_storage_usage: { estimated_live_storage_bytes: 1024, allocated_bytes: 2048 }, history_total_bytes: 2048 });
      if (path === '/api/admin/websites') return json(data.websites);
      if (path === '/api/admin/websites/reorder') {
        data.websites = body.ids.map((id, index) => ({ ...data.websites.find(monitor => monitor.id === id), sort_order: index + 1 }));
        return json({ success: true });
      }
      if (path === '/api/websites') return json(data.websites.filter(monitor => !isPublic || !monitor.hidden).map(monitor => ({ ...monitor, url: isPublic && monitor.hide_url ? null : monitor.url })));
      const checks = /^\/api\/admin\/websites\/(\d+)\/checks$/.exec(path);
      if (checks) return json(data.checks[checks[1]] || []);
      const checkNow = /^\/api\/admin\/websites\/(\d+)\/check$/.exec(path);
      if (checkNow) return json({ success: true, monitor: data.websites.find(monitor => monitor.id === Number(checkNow[1])) });
      if (path === '/api/admin/websites/delete') {
        data.websites = data.websites.filter(monitor => monitor.id !== body.id);
        return json({ success: true });
      }
      if (path === '/api/admin/websites/edit') {
        const monitor = data.websites.find(item => item.id === body.id);
        Object.assign(monitor, body); return json({ success: true, monitor });
      }
      if (path === '/api/admin/websites/visibility' || path === '/api/admin/websites/enabled') { Object.assign(data.websites.find(item => item.id === body.id), body); return json({ success: true, changed: 1 }); }
      if (path === '/api/records/load' || path === '/api/records/gpu' || path === '/api/records/ping') return json({ data: [], has_more: false });
      if (path === '/api/ping' || path === '/api/ping/tasks') return json([]);
      if (path === '/api/admin/account/mfa') return json(data.mfa);
      if (path === '/api/admin/account/mfa/step-up') return json({ success: true });
      return json({ error: `Unmapped synthetic API: ${request.method()} ${path}` }, 501);
    });
    return context;
  }

  async function check(id, name, run, { width = 1280 } = {}) {
    if (selection !== 'ALL' && !id.startsWith(selection)) return;
    const data = fixture();
    const context = await contextFor(data, width);
    const page = await context.newPage();
    try {
      await run(page, data, context);
      assert.deepEqual(data.errors, [], 'No unhandled browser errors');
      results.push({ id, name, status: 'passed', observed: data.observed, pageErrors: data.errors, requests: data.calls });
      console.log(`PASS ${id}: ${name}`);
    } catch (error) {
      results.push({ id, name, status: 'failed', failureKind: error?.code === 'ERR_ASSERTION' ? 'behavior' : 'fixture-or-unclassified', error: error.stack || String(error), observed: data.observed, pageErrors: data.errors, requests: data.calls });
      console.error(`FAIL ${id}: ${error.stack || error}`);
    } finally {
      await context.close();
    }
  }

  async function finish() {
    const receipt = { startedAt, finishedAt: new Date().toISOString(), browser: await browser.version(), selection, sourceMode: 'Current Vite source; empty environment; synthetic API interception; external requests blocked', results };
    console.log(JSON.stringify(receipt, null, 2));
    await browser.close();
    await server.close();
    if (!results.length) throw new Error(`No browser tests selected: ${selection}`);
    if (results.some(result => result.status === 'failed')) process.exitCode = 1;
  }

  return { origin, check, finish };
}
