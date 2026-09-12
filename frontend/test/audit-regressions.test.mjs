import test from 'node:test';
import assert from 'node:assert/strict';
import { getChangedSettings } from '../src/utils/settingsDiff.ts';
import { normalizeLiveDataResponse } from '../src/utils/liveDataResponse.ts';
import { normalizePublicClients } from '../src/utils/publicClients.ts';
import { normalizePublicMonitorRecords, normalizePublicGpuRecords } from '../src/utils/publicHistory.ts';
import { buildApiRequest } from '../src/utils/api.ts';
import { runWithMfaStepUpRetry } from '../src/utils/mfa.ts';
import { shouldClearAuthForStatus } from '../src/contexts/auth-state.ts';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { BroadcastChannel as NativeBroadcastChannel } from 'node:worker_threads';
import { productionDeclaration, productionJsx, productionModule, productionEffect, productionSelected } from './helpers/production-module.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { renderToStaticMarkup } = require('react-dom/server');
const { TextField, Text } = require('@radix-ui/themes');

const notifications = 'src/pages/admin/Notifications.tsx';

const capacitySettings = { record_enabled: 'true', record_preserve_time: '72', ping_record_preserve_time: '72', live_poll_active_interval_sec: '3', live_poll_idle_interval_sec: '120', record_persist_interval_sec: '120', ping_record_persist_interval_sec: '120', record_high_watermark_bytes: '419430400', record_high_watermark_rows: '700000', capacity_daily_view_minutes: '0' };
function capacityInput(overrides = {}) {
  return { clients: 50, gpu_clients: 0, ping_records_per_day: 36000, ping_tasks: [{ id: 1, target_client_count: 50 }, { id: 2, target_client_count: 50 }], history_total_bytes: 900 * 1024 ** 2, history_storage_usage: { live_rows: 100, live_row_bytes: 100 * 1024 ** 2, estimated_live_storage_bytes: 100 * 1024 ** 2, allocated_bytes: 900 * 1024 ** 2, reusable_bytes: null, measurement: 'live-row-bytes-plus-index-estimate' }, ...overrides };
}
function derivedCapacity(capacity, settings = capacitySettings) {
  return productionSelected('src/pages/admin/SettingsGeneral.tsx', 'derived', { capacity, settings, originalSettings: capacitySettings })();
}

test('AUD-07 partial maintenance reports remaining work and counts website checks', async () => {
  for (const hasMore of [true, false]) {
    let requests = 0;
    const messages = [];
    const cleanup = productionDeclaration('src/pages/admin/SettingsGeneral.tsx', 'handleMaintenanceCleanup', {
      setCleaning() {}, refreshCapacity: async () => true,
      apiFetch: async () => { requests += 1; if (requests > 1) throw new Error('Unexpected client cleanup loop'); return { success: true, has_more: hasMore, deleted: { records: 1, website_checks: 2 } }; },
      formatInteger: productionDeclaration('src/pages/admin/SettingsGeneral.tsx', 'formatInteger'),
      toast: { info: message => messages.push(['info', message]), success: message => messages.push(['success', message]), error: message => messages.push(['error', message]) },
    });
    await cleanup();
    assert.equal(messages[0][0], hasMore ? 'info' : 'success', 'remaining cleanup work must not be presented as complete');
    assert.match(messages[0][1], /3/);
    if (hasMore) assert.match(messages[0][1], /仍有|继续清理/);
    assert.equal(requests, 1);
  }
});

test('AUD-13 frontend history budget uses live data estimate instead of allocated file size', () => {
  const derived = derivedCapacity(capacityInput());
  assert.equal(derived.highWatermarkBytesPercent, 25, '100 MiB live data / 400 MiB budget must be 25%, despite 900 MiB allocated');
  const empty = derivedCapacity(capacityInput({ history_storage_usage: { estimated_live_storage_bytes: 0, allocated_bytes: 900 * 1024 ** 2 } }));
  assert.equal(empty.hasHistoryBytes, true, 'a measured empty table is a known zero');
  assert.equal(empty.highWatermarkBytesPercent, 0);
});

test('AUD-15 frontend estimates include separate DO writes and unknown resource dimensions', () => {
  const derived = derivedCapacity(capacityInput());
  const writes = derived.resourceEstimates?.find(row => row.key === 'durable_object_rows_written');
  // 36000 final snapshots + 36000 history markers + 72000 Ping task states.
  assert.equal(writes?.websocket, 144000, '50 nodes and two 120-second Ping tasks exceed the 100000 daily DO write allowance');
  assert.equal(writes.within_free_websocket, false);
  for (const key of ['durable_object_rows_read', 'durable_object_duration_gb_seconds', 'supabase_egress_bytes']) {
    assert.equal(derived.resourceEstimates.find(row => row.key === key).websocket, null, key + ' cannot be silently treated as zero');
  }
});

test('AUD-15 disabling history in the local preview retains final snapshot writes in both transports', () => {
  const derived = derivedCapacity(capacityInput(), { ...capacitySettings, record_enabled: 'false' });
  const writes = derived.resourceEstimates.find(row => row.key === 'durable_object_rows_written');
  assert.equal(writes.websocket, 36000, 'WebSocket final snapshots persist each monitor report even without Ping history');
  assert.equal(writes.http, 36000, 'HTTP live state still persists each monitor report without history');
  assert.equal(writes.within_free_websocket, true);
  assert.equal(writes.within_free_http, true);
});

test('AUD-16 frontend Paid comparison uses monthly demand and monthly included quota', () => {
  const derived = derivedCapacity(capacityInput());
  assert.equal(derived.mixedWorkerRequestsPerMonth, 23100, '770 estimated daily Worker requests must become 23100 for a 30-day comparison');
  assert.equal(derived.workerPaidMonthlyRequests, 10000000);
  assert.ok(Math.abs(derived.mixedPaidWorkerPercent - 0.231) < 1e-10);
});

function adminActionRunner(errors = []) {
  let run;
  return (...args) => {
    run ??= productionModule('src/hooks/useAdminAction.ts', {
      react: { useCallback: value => value, useRef: value => ({ current: value }), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] },
      sonner: { toast: { error: message => errors.push(message) } },
    }).useAdminAction().run;
    return run(...args);
  };
}
const passthroughAction = async (_key, action) => action();

test('AUD-49 notification write failures are caught and expose the real error', async () => {
  const methods = [['saveSingleEdit', []], ['saveBatchEdit', []], ['toggleOffline', ['node-a', true]], ['toggleExpiry', ['node-a', true]], ['saveExpirySingleEdit', []], ['saveExpiryBatchEdit', []], ['saveLoadNotification', []], ['deleteLoadNotification', [1]], ['sendTestMessage', []]];
  for (const [name, args] of methods) {
    const errors = [];
    let closed = false;
    const action = productionDeclaration(notifications, name, {
      apiFetch: async () => { throw new Error('Synthetic service rejection'); },
      runAction: adminActionRunner(errors), toast: { error: message => errors.push(message), success() {} },
      editingOffline: 'node-a', editForm: { enable: true, grace_period: 1200 }, selectedClients: ['node-a'], batchForm: { enable: true, grace_period: 1200 },
      editingExpiry: 'node-a', expiryEditForm: { enable: true, advance_days: 7 }, expiryBatchForm: { enable: true, advance_days: 7 },
      notificationMap: new Map(), expiryNotificationMap: new Map(), DEFAULT_GRACE_PERIOD_SEC: 360, DEFAULT_EXPIRY_ADVANCE_DAYS: 7,
      editingLoad: null, loadForm: { name: 'Synthetic', metric: 'cpu', all_clients: true, clients: [] }, settings: { notification_method: 'telegram' },
      setEditDialogOpen: () => { closed = true; }, setBatchDialogOpen: () => { closed = true; }, setExpiryEditDialogOpen: () => { closed = true; }, setExpiryBatchDialogOpen: () => { closed = true; }, setLoadDialogOpen: () => { closed = true; },
      loadOfflineTab() {}, loadExpiryTab() {}, loadLoadTab() {}, setSelectedClients() {},
    });
    let rejected;
    try { await action(...args); } catch (error) { rejected = error; }
    assert.equal(rejected, undefined, `${name} must handle event promise failures`);
    assert.deepEqual(errors, ['Synthetic service rejection'], `${name} must show the real failure once`);
    assert.equal(closed, false, 'failed edits stay open for retry');
  }
});

test('AUD-49 a pending notification save cannot submit twice', async () => {
  const pending = Promise.withResolvers();
  let requests = 0;
  const save = productionDeclaration(notifications, 'saveSingleEdit', {
    editingOffline: 'node-a', editForm: { enable: true, grace_period: 1200 }, runAction: adminActionRunner(),
    apiFetch: () => { requests += 1; return pending.promise; }, toast: { success() {}, error() {} }, setEditDialogOpen() {}, loadOfflineTab() {},
  });
  const first = save();
  const second = save();
  pending.resolve({ success: true });
  await Promise.all([first, second]);
  assert.equal(requests, 1, 'pending guard must act before a React render disables the button');
});

test('AUD-49 Ping loading and deletion failures remain visible and handled', async () => {
  for (const name of ['loadData', 'handleDelete']) {
    const errors = [];
    let loadError = null;
    const action = productionDeclaration('src/pages/admin/PingTasks.tsx', name, {
      apiFetch: async () => { throw new Error('Synthetic Ping failure'); }, runAction: adminActionRunner(errors), deleteTask: { id: 1 },
      toast: { error: message => errors.push(message), success() {} }, setLoading() {}, setTasks() {}, setDeleteTask() {}, setLoadError: value => { loadError = value; },
    });
    let rejected;
    try { await action(); } catch (error) { rejected = error; }
    assert.equal(rejected, undefined, `${name} must catch asynchronous failures`);
    assert.ok(errors.includes('Synthetic Ping failure') || loadError === 'Synthetic Ping failure');
  }
});

test('AUD-52 restore invalidates prefetched general settings and reloads restored values', async () => {
  const settingsCacheRef = { current: { site: { site_title: 'A' }, general: { record_preserve_time: '24' } } };
  const settingsRequestsRef = { current: {} };
  const base = { settingsCacheRef, settingsRequestsRef, setSettingsCacheState() {} };
  const setSettingsScope = productionDeclaration('src/pages/admin/SettingsLayout.tsx', 'setSettingsScope', base);
  const apiFetch = async path => path.includes('/upload/backup') ? { success: true } : path.endsWith('scope=site') ? { site_title: 'B' } : { record_preserve_time: '72' };
  const loadSettingsScope = productionDeclaration('src/pages/admin/SettingsLayout.tsx', 'loadSettingsScope', { ...base, apiFetch, setSettingsScope });
  const restore = productionDeclaration('src/pages/admin/SettingsSite.tsx', 'handleUploadBackup', {
    requestPassword: async () => 'synthetic-password', downloadBackupFile: async () => {}, apiFetch,
    backupEncryptPasswordError: productionDeclaration('src/pages/admin/SettingsSite.tsx', 'backupEncryptPasswordError', { MIN_BACKUP_PASSWORD_LENGTH: 6 }),
    toast: { success() {}, error(message) { throw new Error(message); } },
    setSettings() {}, setOriginalSettings() {}, setSettingsScope, loadSettingsScope,
    invalidateSettingsScopes: () => productionDeclaration('src/pages/admin/SettingsLayout.tsx', 'invalidateSettingsScopes', base)(),
    clearCachedPublicSettings() {}, notifyPublicDataUpdated() {},
  });
  await restore({ target: { files: [{ text: async () => '{"synthetic":"encrypted backup"}' }], value: 'synthetic.json' } });
  const general = await loadSettingsScope('general');
  assert.equal(general.record_preserve_time, '72', 'a restored general setting must replace the old prefetched value without page reload');
  assert.equal(settingsCacheRef.current.site.site_title, 'B');
});

test('AUD-05 initial administrator form requires and sends ownership key', async () => {
  for (const adminPresent of [false, true]) {
    for (const key of ['', 'synthetic-owner-proof']) {
      const bodies = [];
      const errors = [];
      const submit = productionDeclaration('src/pages/Login.tsx', 'handleRecoverySubmit', {
        recoveryStatus: { admin_present: adminPresent }, recoveryKey: key, recoveryUsername: 'synthetic-owner', recoveryPassword: 'synthetic-password',
        fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ mode: 'created' })); },
        toast: { error: message => errors.push(message), success() {} }, setRecoveryLoading() {}, setUsername() {}, setPassword() {}, setRecoveryPassword() {}, setRecoveryKey() {}, setRecoveryStatus() {}, setRecoveryMode() {},
      });
      await submit({ preventDefault() {} });
      assert.equal(bodies.length, key ? 1 : 0, 'ownership is required for initial creation as well as recovery');
      if (key) assert.equal(bodies[0].supabase_secret_key, 'synthetic-owner-proof');
      else assert.equal(errors.length, 1);
    }
  }
});

test('AUD-44 backup downloads participate in MFA step-up and stop on cancellation', async () => {
  for (const approved of [true, false]) {
    let requests = 0;
    let stepUps = 0;
    let downloads = 0;
    const fetch = async () => {
      requests += 1;
      return requests === 1 ? new Response(JSON.stringify({ error: 'MFA_REQUIRED' }), { status: 428 }) : new Response('synthetic encrypted backup');
    };
    const requestMfaStepUp = async () => { stepUps += 1; return approved; };
    const apiResponseFetch = (...args) => productionDeclaration('src/contexts/AuthContext.tsx', 'useApiResponse', {
      useAuth: () => ({ logout() {} }), useCallback: value => value,
      buildApiRequest, runWithMfaStepUpRetry, requestMfaStepUp, fetch,
      shouldClearAuthForStatus, readJson: productionDeclaration('src/contexts/AuthContext.tsx', 'readJson'),
    })()(...args);
    const download = productionDeclaration('src/pages/admin/SettingsSite.tsx', 'downloadBackupFile', {
      buildApiRequest, fetch, apiResponseFetch, requestMfaStepUp,
      URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
      document: { createElement: () => ({ click: () => { downloads += 1; } }) },
    });
    let failure;
    try { await download('synthetic.json', 'synthetic-backup-password'); } catch (error) { failure = error; }
    assert.equal(stepUps, 1, 'a 428 download must offer MFA verification');
    assert.equal(requests, approved ? 2 : 1);
    assert.equal(downloads, approved ? 1 : 0);
    assert.equal(Boolean(failure), !approved);
  }
});

function syntheticStorage(seed = []) {
  const values = new Map(seed);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

const collectCursorHistory = (...args) => productionModule('src/utils/publicHistory.ts').collectCursorHistory(...args);

test('AUD-43 monitoring and GPU history include the oldest and newest available three-day points', async () => {
  for (const kind of ['monitor', 'gpu']) {
    const done = Promise.withResolvers();
    let calls = 0;
    let records = [];
    const bindings = {
      uuid: 'node-a', client: { uuid: 'node-a', gpu_name: 'Synthetic GPU' }, authLoading: false, isAuthenticated: false, timeRange: '3d', AbortController,
      recordsRequestRef: { current: 0 },
      timeRangeMs: productionDeclaration('src/pages/Instance.tsx', 'timeRangeMs'),
      timeRangePointLimit: productionDeclaration('src/pages/Instance.tsx', 'timeRangePointLimit'),
      historyQuery: productionDeclaration('src/pages/Instance.tsx', 'historyQuery'),
      collectCursorHistory, normalizePublicMonitorRecords, normalizePublicGpuRecords,
      publicFetch: async url => {
        calls += 1;
        const end = Date.parse(new URL(url, 'https://synthetic.invalid').searchParams.get('end'));
        const time = new Date(end - (calls === 1 ? 3600000 : 70 * 3600000)).toISOString();
        return { data: [{ time, cpu: calls === 1 ? 99 : 11, utilization: calls === 1 ? 99 : 11 }], has_more: calls === 1, next_cursor: time };
      },
      setRecords: value => { records = value; },
      setGpuRecords: value => { records = value; if (value.length) done.resolve(); },
      setRecordsLoading() {}, setGpuLoading() {}, setRecordsRangeEnd() {}, setRecordsError() {}, setGpuError: value => { if (value) done.reject(new Error(value)); },
    };
    let cleanup;
    if (kind === 'monitor') await productionDeclaration('src/pages/Instance.tsx', 'loadRecords', bindings)('3d');
    else {
      cleanup = productionEffect('src/pages/Instance.tsx', '/records/gpu?', bindings)();
      await done.promise;
    }
    try {
      assert.deepEqual([...records].map(record => kind === 'monitor' ? record.cpu : record.utilization), [11, 99], `${kind} history must cover both ends of the available range in chronological order`);
      assert.equal(calls, 2);
    } finally { cleanup?.(); }
  }
});

test('AUD-43 long-range Ping history continues beyond a full recent batch', async () => {
  const end = Date.parse('2026-09-06T00:00:00Z');
  const batch = Array.from({ length: 360 }, (_, index) => ({ time: new Date(end - (index + 1) * 120000).toISOString(), value: 10, task_id: 1 }));
  let continuations = 0;
  const ping = productionModule('src/utils/pingChart.ts', {}, {
    fetch: async url => {
      const path = new URL(url, 'https://synthetic.invalid').pathname;
      if (path === '/api/task/ping') return new Response(JSON.stringify([{ id: 1, name: 'Synthetic ping', clients: ['node-a'], interval: 120, interval_sec: 120 }]));
      if (path === '/api/records/ping/batch') return new Response(JSON.stringify({ 1: batch }));
      if (path === '/api/records/ping') { continuations += 1; return new Response(JSON.stringify({ data: [{ time: new Date(end - 70 * 3600000).toISOString(), value: 25, task_id: 1 }], has_more: false })); }
      throw new Error(`Unexpected path ${path}`);
    },
  });
  const series = await ping.fetchPingTaskSeries('node-a', { rangeHours: 72, cursor: new Date(end).toISOString() });
  assert.equal(Math.min(...series[0].records.map(record => Date.parse(record.time))), end - 70 * 3600000, 'three-day Ping chart must include its oldest available point');
  assert.equal(continuations, 1);
});

test('AUD-43 cursor traversal rejects repeated cursors and is bounded and abortable', async () => {
  const collect = productionModule('src/utils/publicHistory.ts').collectCursorHistory;
  const options = { cursor: '2026-09-06T00:00:00Z', start: '2026-09-03T00:00:00Z', normalize: normalizePublicMonitorRecords };
  await assert.rejects(() => collect(async () => ({ data: [], has_more: true, next_cursor: options.cursor }), options), /游标无效/);
  let calls = 0;
  await assert.rejects(() => collect(async cursor => {
    calls += 1;
    return { data: [], has_more: true, next_cursor: new Date(Date.parse(cursor) - 3600000).toISOString() };
  }, { ...options, maxPages: 2 }), /历史记录过多/);
  assert.equal(calls, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => collect(async () => { throw new Error('fetch must not run'); }, { ...options, signal: controller.signal }), { name: 'AbortError' });
});

test('AUD-42 older bootstrap and settings responses cannot overwrite newer cache state', async () => {
  for (const kind of ['bootstrap', 'settings']) {
    const requests = [];
    const module = productionModule(`src/utils/public${kind === 'bootstrap' ? 'Bootstrap' : 'Settings'}.ts`, {}, {
      localStorage: syntheticStorage(),
      fetch: () => new Promise(resolve => requests.push(resolve)),
    });
    const request = kind === 'bootstrap' ? module.fetchPublicBootstrap : module.fetchPublicSettings;
    const older = request();
    const newer = request(kind === 'bootstrap' ? { cacheBust: true } : { force: true });
    assert.equal(requests.length, 2);
    const payload = name => kind === 'bootstrap' ? { clients: [{ uuid: 'node-a', name }] } : { site_title: name };
    requests[1](new Response(JSON.stringify(payload('new B'))));
    await newer;
    requests[0](new Response(JSON.stringify(payload('old A'))));
    await older;
    const current = kind === 'bootstrap' ? module.getCachedPublicBootstrap().clients[0].name : (await request()).site_title;
    assert.equal(current, 'new B', `${kind} must keep the latest request's response`);
  }
});

test('AUD-42 invalidation replaces pending fresh bootstrap requests in both visibility scopes', async (t) => {
  for (const includeHidden of [false, true]) {
    await t.test(includeHidden ? 'administrator view' : 'public view', async () => {
      const requests = [];
      const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
        localStorage: syntheticStorage(), fetch: () => new Promise(resolve => requests.push(resolve)),
      });
      const older = bootstrap.fetchPublicBootstrap({ cacheBust: true, includeHidden });
      bootstrap.clearCachedPublicBootstrap();
      const newer = bootstrap.fetchPublicBootstrap({ cacheBust: true, includeHidden });
      assert.equal(requests.length, 2, 'an invalidated request cannot satisfy a later metadata refresh');
      requests[1](new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'new B', hidden: includeHidden }] })));
      const current = await newer;
      requests[0](new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'old A', hidden: includeHidden }] })));
      await older;
      assert.equal(current.clients[0].name, 'new B');
    });
  }
});

test('AUD-42 Index keeps newer client state when an earlier bootstrap succeeds or fails late', async (t) => {
  for (const oldStatus of [200, 500]) {
    await t.test(`old HTTP ${oldStatus}`, async () => {
    const requests = [];
    const promises = [];
    const window = new EventTarget();
    Object.assign(window, { location: { origin: 'http://synthetic.invalid' }, setInterval: () => 1, clearInterval() {} });
    const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
      window, localStorage: syntheticStorage(), fetch: () => new Promise(resolve => requests.push(resolve)),
    });
    const publicClients = productionModule('src/utils/publicClients.ts');
    let current = [];
    let refresh;
    let fallbackCalls = 0;
    const effect = productionEffect('src/pages/Index.tsx', 'const refreshPublicClients', {
      authLoading: false, monitorMode: 'servers', isAuthenticated: false, window, document: new EventTarget(),
      fetchPublicBootstrap: (...args) => { const pending = bootstrap.fetchPublicBootstrap(...args); promises.push(pending); return pending; },
      fetchWithBootstrapRetry: () => { fallbackCalls += 1; return Promise.reject(new Error('Unexpected obsolete fallback')); },
      normalizePublicClients: publicClients.normalizePublicClients,
      applyPublicClientUpdate: productionDeclaration('src/pages/Index.tsx', 'applyPublicClientUpdate', { mergePublicClientPatch: publicClients.mergePublicClientPatch }),
      setClients: update => { current = typeof update === 'function' ? update(current) : update; },
      setClientsLoading() {}, setClientsError() {}, notifyPublicDataReady() {},
      subscribePublicDataUpdated: callback => { refresh = callback; return () => {}; },
    });
    const cleanup = effect();
    try {
      bootstrap.clearCachedPublicBootstrap();
      refresh({ force: true });
      assert.equal(requests.length, 2);
      requests[1](new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'new B' }] })));
      await promises[1];
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(current[0].name, 'new B');
      requests[0](new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'old A' }] }), { status: oldStatus }));
      await promises[0].catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(bootstrap.getCachedPublicBootstrap().clients[0].name, 'new B', 'cache control');
      assert.equal(current[0].name, 'new B', 'rendered client state must not regress to old A');
      assert.equal(fallbackCalls, 0, 'an obsolete response must not launch another request');
    } finally { cleanup(); }
    });
  }
});

function indexBootstrapFixture(includeHidden = false) {
  const requests = [];
  const state = { clients: [], loading: false, error: null, ready: 0 };
  const window = new EventTarget();
  const document = new EventTarget();
  Object.assign(window, { location: { origin: 'http://synthetic.invalid' }, setInterval: () => 1, clearInterval() {} });
  const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
    window, localStorage: syntheticStorage(),
    fetch: url => new Promise(resolve => requests.push({ url, resolve })),
  }, 'fetchWithBootstrapRetry');
  const publicClients = productionModule('src/utils/publicClients.ts');
  const applyUpdate = productionDeclaration('src/utils/publicDataEvents.ts', 'applyPublicDataUpdate', {
    patchCachedPublicBootstrapClients: bootstrap.patchCachedPublicBootstrapClients,
    clearCachedPublicBootstrap: bootstrap.clearCachedPublicBootstrap,
    clearCachedPublicSettings() {},
  });
  let refresh;
  const effect = productionEffect('src/pages/Index.tsx', 'const refreshPublicClients', {
    authLoading: false, monitorMode: 'servers', isAuthenticated: includeHidden, window, document,
    fetchPublicBootstrap: bootstrap.fetchPublicBootstrap, fetchWithBootstrapRetry: bootstrap.auditSelected,
    normalizePublicClients: publicClients.normalizePublicClients,
    applyPublicClientUpdate: productionDeclaration('src/pages/Index.tsx', 'applyPublicClientUpdate', { mergePublicClientPatch: publicClients.mergePublicClientPatch }),
    setClients: update => { state.clients = typeof update === 'function' ? update(state.clients) : update; },
    setClientsLoading: value => { state.loading = value; },
    setClientsError: value => { state.error = value; },
    notifyPublicDataReady: () => { state.ready += 1; },
    subscribePublicDataUpdated: callback => { refresh = callback; return () => {}; },
  });
  const cleanup = effect();
  return {
    state, requests, cleanup,
    visible() { document.dispatchEvent(new Event('visibilitychange')); },
    emit(detail) { applyUpdate(detail); refresh(detail); },
    async reply(index, payload, status = 200) {
      assert.ok(requests[index], `request ${index} must have reached the real fetch boundary`);
      requests[index].resolve(new Response(JSON.stringify(payload), { status }));
      await new Promise(resolve => setImmediate(resolve));
    },
    rows: () => Array.from(state.clients, client => [client.uuid, client.name]).sort(([left], [right]) => left.localeCompare(right)),
  };
}

test('AUD-42 a partial update during first load retains unaffected nodes and the latest rename', async (t) => {
  for (const includeHidden of [false, true]) {
    await t.test(includeHidden ? 'administrator view' : 'public view', async () => {
      const fixture = indexBootstrapFixture(includeHidden);
      try {
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Renamed B' }] } });
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Latest B' }] } });
        const loadingAfterPatch = fixture.state.loading;
        const readyAfterPatch = fixture.state.ready;
        await fixture.reply(0, { clients: [
          { uuid: 'node-a', name: 'Unaffected A', hidden: includeHidden },
          { uuid: 'node-b', name: 'Old B' },
        ] });
        assert.deepEqual(fixture.rows(), [['node-a', 'Unaffected A'], ['node-b', 'Latest B']], 'a partial patch cannot replace the full snapshot');
        assert.equal(loadingAfterPatch, true, 'a partial patch cannot complete the first full load');
        assert.equal(readyAfterPatch, 0, 'the full list was not ready when only a patch arrived');
        assert.equal(fixture.state.loading, false);
        assert.equal(fixture.state.ready, 1);
      } finally { fixture.cleanup(); }
    });
  }
});

test('AUD-42 visibility refresh preserves patches when the full request is coalesced', async (t) => {
  for (const includeHidden of [false, true]) {
    await t.test(includeHidden ? 'administrator view' : 'public view', async () => {
      const fixture = indexBootstrapFixture(includeHidden);
      try {
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Latest B' }] } });
        fixture.visible();
        assert.equal(fixture.requests.length, 1, 'the real bootstrap cache coalesces the visible-page refresh');
        await fixture.reply(0, { clients: [{ uuid: 'node-a', name: 'Unaffected A' }, { uuid: 'node-b', name: 'Old B' }] });
        assert.deepEqual(fixture.rows(), [['node-a', 'Unaffected A'], ['node-b', 'Latest B']], 'coalescing must preserve partial updates even without the public cache overlay');
        assert.equal(fixture.state.ready, 1);
      } finally { fixture.cleanup(); }
    });
  }
});

test('AUD-42 partial updates preserve ownership of the latest full refresh', async (t) => {
  for (const includeHidden of [false, true]) {
    await t.test(includeHidden ? 'administrator view' : 'public view', async () => {
      const fixture = indexBootstrapFixture(includeHidden);
      try {
        fixture.emit({ force: true });
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Latest B' }], remove: ['node-c'] } });
        await fixture.reply(1, { clients: [
          { uuid: 'node-a', name: 'New A', hidden: includeHidden },
          { uuid: 'node-b', name: 'Old B' },
          { uuid: 'node-c', name: 'Deleted C' },
        ] });
        assert.deepEqual(fixture.rows(), [['node-a', 'New A'], ['node-b', 'Latest B']], 'the new full snapshot must retain patches received while pending');
        await fixture.reply(0, { clients: [{ uuid: 'node-a', name: 'Obsolete A' }] });
        assert.deepEqual(fixture.rows(), [['node-a', 'New A'], ['node-b', 'Latest B']], 'an older full request remains obsolete after the partial update');
        assert.equal(fixture.state.ready, 1, 'the old request cannot announce another completion');
      } finally { fixture.cleanup(); }
    });
  }
});

test('AUD-42 a partial update cannot discard full-snapshot fallback or hide its failure', async (t) => {
  for (const fails of [false, true]) {
    await t.test(fails ? 'fallback failure stays visible' : 'fallback retains all nodes and patches', async () => {
      const fixture = indexBootstrapFixture(true);
      try {
        await fixture.reply(0, { clients: [{ uuid: 'node-b', name: 'Original B' }] });
        fixture.emit({ force: true });
        fixture.emit({ clients: { upsert: [{ uuid: 'node-b', name: 'Latest B' }] } });
        await fixture.reply(1, { error: 'Synthetic service unavailable' }, 500);
        assert.equal(fixture.requests.length, 3, 'a patch is not a replacement for the failed full refresh');
        if (fails) {
          await fixture.reply(2, { error: 'Synthetic service unavailable' }, 500);
          await fixture.reply(3, { error: 'Synthetic list unavailable' }, 502);
          assert.equal(fixture.state.error, 'HTTP 502', 'the partial list cannot be silently presented as a successful full read');
          assert.deepEqual(fixture.rows(), [['node-b', 'Latest B']]);
        } else {
          await fixture.reply(2, { clients: [{ uuid: 'node-a', name: 'Unaffected A' }, { uuid: 'node-b', name: 'Old B' }] });
          assert.deepEqual(fixture.rows(), [['node-a', 'Unaffected A'], ['node-b', 'Latest B']]);
          fixture.emit({ force: true });
          await fixture.reply(3, { clients: [{ uuid: 'node-a', name: 'Server A' }, { uuid: 'node-b', name: 'Server B' }] });
          assert.deepEqual(fixture.rows(), [['node-a', 'Server A'], ['node-b', 'Server B']], 'later authoritative reads retire the completed request\'s patches');
        }
        assert.equal(fixture.state.loading, false);
      } finally { fixture.cleanup(); }
    });
  }
});

test('AUD-42 LiveDataProvider keeps newer live/settings when an earlier bootstrap succeeds or fails late', async (t) => {
  for (const oldStatus of [200, 500]) {
    await t.test(`old HTTP ${oldStatus}`, async () => {
    const requests = [];
    const promises = [];
    const window = new EventTarget();
    window.location = { origin: 'http://synthetic.invalid' };
    const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
      window, localStorage: syntheticStorage(), fetch: () => new Promise(resolve => requests.push(resolve)),
    });
    const settingsModule = productionModule('src/utils/publicSettings.ts');
    let current;
    let title;
    let clientMetadata;
    let refresh;
    let fallbackCalls = 0;
    const effect = productionEffect('src/contexts/LiveDataContext.tsx', 'const applyBootstrap', {
      authLoading: false, enabled: true, viewer: true, includeHidden: false, window,
      liveScopeRef: { current: productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope() },
      LIVE_POLL_SETTINGS_UPDATED_EVENT: 'synthetic-settings',
      normalizePublicSettings: settingsModule.normalizePublicSettings,
      setCachedPublicSettings: settings => { title = settings.site_title; },
      normalizeLivePollConfig: () => ({}), pollConfigRef: { current: {} }, DEFAULT_LIVE_POLL_CONFIG: {},
      normalizeLiveDataResponse, rememberInitialLiveMetadataVersion() {}, setLoading() {}, setError() {},
      setLiveData: value => { current = value; },
      setClientMetadata: update => { clientMetadata = typeof update === 'function' ? update(clientMetadata) : update; },
      mergePublicClientPatch: productionModule('src/utils/publicClients.ts').mergePublicClientPatch,
      fetchPublicBootstrap: (...args) => { const pending = bootstrap.fetchPublicBootstrap(...args); promises.push(pending); return pending; },
      fetchPublicSettings: () => { fallbackCalls += 1; return Promise.reject(new Error('Unexpected obsolete settings fallback')); },
      subscribePublicDataUpdated: callback => { refresh = callback; return () => {}; },
    });
    const payload = name => ({
      clients: [{ uuid: 'node-a', name }], settings: { site_title: name },
      live: { online: ['node-a'], clients: [{ uuid: 'node-a', name, lastReportTime: 1 }], data: {}, count: 1, timestamp: 1 },
    });
    const cleanup = effect();
    try {
      bootstrap.clearCachedPublicBootstrap();
      refresh({ force: true });
      assert.equal(requests.length, 2);
      requests[1](new Response(JSON.stringify(payload('new B'))));
      await promises[1];
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(current.clients[0].name, 'new B');
      requests[0](new Response(JSON.stringify(payload('old A')), { status: oldStatus }));
      await promises[0].catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(bootstrap.getCachedPublicBootstrap().clients[0].name, 'new B', 'cache control');
      assert.deepEqual([current.clients[0].name, title], ['new B', 'new B'], 'live state and settings must belong to the latest request');
      assert.equal(clientMetadata[0].name, 'new B', 'the retained metadata list also belongs to the latest request');
      assert.equal(fallbackCalls, 0, 'an obsolete response must not refresh settings again');
    } finally { cleanup(); }
    });
  }
});

test('AUD-42 late node metadata cannot replace the current node', async () => {
  const pending = new Map();
  const clientRequestRef = { current: 0 };
  let current;
  const load = uuid => productionDeclaration('src/pages/Instance.tsx', 'loadClient', {
    uuid, authLoading: false, isAuthenticated: false, clientRequestRef,
    publicFetch: () => new Promise(resolve => pending.set(uuid, resolve)),
    normalizePublicClients, setClientLoading() {}, setError() {}, setClients() {},
    setClient: value => { current = value; },
  });
  const a = load('node-a')();
  const b = load('node-b')();
  const nodes = [{ uuid: 'node-a', name: 'A' }, { uuid: 'node-b', name: 'B' }];
  pending.get('node-b')(nodes);
  await b;
  pending.get('node-a')(nodes);
  await a;
  assert.equal(current.uuid, 'node-b', 'route B must not display late node A metadata');
});

test('AUD-42 late node history cannot replace the current node history', async () => {
  const pending = new Map();
  const recordTime = new Date(Date.now() - 30 * 60_000).toISOString();
  const recordsRequestRef = { current: 0 };
  let current = [];
  const load = uuid => productionDeclaration('src/pages/Instance.tsx', 'loadRecords', {
    uuid, authLoading: false, isAuthenticated: false, recordsRequestRef,
    timeRangeMs: productionDeclaration('src/pages/Instance.tsx', 'timeRangeMs'),
    timeRangePointLimit: productionDeclaration('src/pages/Instance.tsx', 'timeRangePointLimit'),
    historyQuery: productionDeclaration('src/pages/Instance.tsx', 'historyQuery'),
    publicFetch: () => new Promise(resolve => pending.set(uuid, resolve)),
    normalizePublicMonitorRecords,
    collectCursorHistory,
    setRecordsLoading() {}, setRecordsRangeEnd() {}, setRecordsError() {},
    setRecords: value => { current = value; },
  });
  const a = load('node-a')('1h');
  const b = load('node-b')('3d');
  pending.get('node-b')([{ time: recordTime, cpu: 22 }]);
  await b;
  pending.get('node-a')([{ time: recordTime, cpu: 91 }]);
  await a;
  assert.equal(current[0].cpu, 22, 'route B history must not be replaced by late A history');
});

test('AUD-41 a fresh server snapshot supersedes older optimistic client patches', async () => {
  let responseName = 'original';
  const cache = productionModule('src/utils/publicBootstrap.ts', {}, {
    localStorage: syntheticStorage(),
    fetch: async () => new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: responseName, price: 5, billing_cycle: 30 }] })),
  });
  await cache.fetchPublicBootstrap();
  cache.patchCachedPublicBootstrapClients({ clients: { upsert: [{ uuid: 'node-a', name: 'old optimistic name' }] } });
  responseName = 'latest server truth';
  const fresh = await cache.fetchPublicBootstrap({ cacheBust: true, cache: 'reload' });
  assert.equal(fresh.clients[0].name, 'latest server truth');
  assert.equal(cache.getCachedPublicBootstrap().clients[0].name, 'latest server truth');
});

test('AUD-41 explicit free pricing and cleared text survive client cache updates', async () => {
  const cache = productionModule('src/utils/publicBootstrap.ts', {}, {
    localStorage: syntheticStorage(),
    fetch: async () => new Response(JSON.stringify({ clients: [{ uuid: 'node-a', name: 'A', price: 5, billing_cycle: 30, public_remark: 'Old note', group: 'Old group' }] })),
  });
  await cache.fetchPublicBootstrap();
  cache.patchCachedPublicBootstrapClients({ clients: { upsert: [{ uuid: 'node-a', price: 0, billing_cycle: 0, public_remark: '', group: '' }] } });
  const client = cache.getCachedPublicBootstrap().clients[0];
  assert.deepEqual([client.price, client.billing_cycle, client.public_remark, client.group, client.name], [0, 0, '', '', 'A']);
});

test('AUD-53 fallback broadcast never writes private client details into browser storage', () => {
  const storage = new Map();
  const writes = [];
  const window = new EventTarget();
  let localDetail;
  window.addEventListener('cf-monitor:public-data-updated', event => { localDetail = event.detail; });
  const module = productionModule('src/utils/publicDataEvents.ts', {}, {
    window, CustomEvent, BroadcastChannel: undefined,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); writes.push(value); }, removeItem: key => storage.delete(key) },
  });
  module.notifyPublicDataUpdated({ clients: { upsert: [{ uuid: 'node-a', name: 'Public node', token: 'SYNTHETIC_AGENT_SECRET', remark: 'SYNTHETIC_PRIVATE_NOTE', ipv4: '192.0.2.123', public_remark: 'Public note', sort_order: 2 }] } });
  const serialized = JSON.stringify({ writes, localDetail, stored: [...storage.values()] });
  for (const secret of ['SYNTHETIC_AGENT_SECRET', 'SYNTHETIC_PRIVATE_NOTE', '192.0.2.123']) {
    assert.ok(!serialized.includes(secret), `${secret} must not enter storage or the public update payload`);
  }
  assert.equal(localDetail.clients.upsert[0].name, 'Public node');
  assert.equal(localDetail.clients.upsert[0].public_remark, 'Public note');
  assert.equal(storage.has('cf-monitor:public-data-updated'), false, 'fallback envelope is transient');
});

test('AUD-40 each subscriber receives exactly once across pages and transports', async () => {
  for (const transport of ['broadcast', 'storage']) {
    const pages = [new EventTarget(), new EventTarget()];
    const counts = [[0, 0], [0, 0]];
    const modules = pages.map((window, pageIndex) => productionModule('src/utils/crossTabEvents.ts', {}, {
      window, CustomEvent,
      BroadcastChannel: transport === 'broadcast' ? NativeBroadcastChannel : undefined,
      localStorage: {
        setItem: (key, newValue) => pages.forEach((target, index) => {
          if (index === pageIndex) return;
          const event = new Event('storage');
          Object.assign(event, { key, newValue });
          queueMicrotask(() => target.dispatchEvent(event));
        }),
        removeItem() {},
      },
    }));
    const name = `audit-${transport}-${Date.now()}`;
    const stops = modules.flatMap((module, pageIndex) => [0, 1].map(subscriber => module.subscribeCrossTab(name, () => { counts[pageIndex][subscriber] += 1; })));
    try {
      modules[0].broadcastCrossTab(name, { value: 'synthetic' });
      const deadline = Date.now() + 5000;
      while (counts.some(page => page.some(count => count === 0)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(counts, [[1, 1], [1, 1]], `${transport}: every local and remote listener must receive one delivery`);
      stops.forEach(stop => stop());
      modules[0].broadcastCrossTab(name, { value: 'after-unsubscribe' });
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.deepEqual(counts, [[1, 1], [1, 1]], 'unsubscribed listeners must not receive updates');
    } finally {
      stops.forEach(stop => stop());
    }
  }
});

test('AUD-40 a genuine settings invalidation is delivered after an optimistic client update', () => {
  const module = productionModule('src/utils/publicDataEvents.ts', {}, { window: new EventTarget(), CustomEvent, BroadcastChannel: undefined, localStorage: syntheticStorage() });
  const counts = [0, 0];
  const stops = counts.map((_, index) => module.subscribePublicDataUpdated(() => { counts[index] += 1; }));
  try {
    module.notifyPublicDataUpdated({ clients: { upsert: [{ uuid: 'node-a', name: 'A' }] } });
    module.notifyPublicDataUpdated();
    assert.deepEqual(counts, [2, 2], 'a later real settings change is not a duplicate of the client patch');
  } finally { stops.forEach(stop => stop()); }
});

test('AUD-39 authoritative empty live snapshot clears stale online state', async () => {
  let state = { online: ['node-a'], clients: [{ uuid: 'node-a', name: 'A', lastReportTime: 1 }], data: { 'node-a': { cpu: 50 } }, count: 1, timestamp: 1 };
  let error = 'old error';
  let rejectFetch = false;
  const scopeOwner = {};
  const load = productionDeclaration('src/contexts/LiveDataContext.tsx', 'fetchLiveData', {
    authLoading: false, includeHidden: false, enabled: true, scopeOwner,
    liveScopeRef: { current: productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope(scopeOwner) },
    fetch: async () => { if (rejectFetch) throw new Error('Synthetic network failure'); return new Response(JSON.stringify({ online: [], clients: [], data: {}, count: 0, timestamp: 2 })); },
    normalizeLiveDataResponse,
    isEmptyLiveSnapshot: productionDeclaration('src/contexts/LiveDataContext.tsx', 'isEmptyLiveSnapshot'),
    applyLiveMetadataVersion() {},
    setLiveData: value => { state = typeof value === 'function' ? value(state) : value; },
    setError: value => { error = value; }, setLoading() {}, getErrorMessage: value => value.message,
  });
  await load();
  assert.deepEqual(state.online, [], 'valid empty 200 snapshot is authoritative after the final node goes offline');
  assert.equal(state.count, 0);
  assert.equal(Object.keys(state.data).length, 0);
  assert.equal(error, null);
  rejectFetch = true;
  await load();
  assert.equal(error, 'Synthetic network failure');
});

test('AUD-39 authoritative empty client list removes the last deleted client', async () => {
  const fixture = indexBootstrapFixture();
  try {
    await fixture.reply(0, { clients: [{ uuid: 'node-a', name: 'A' }] });
    assert.deepEqual(fixture.rows(), [['node-a', 'A']]);
    fixture.visible();
    await fixture.reply(1, { clients: [] });
    assert.equal(fixture.state.clients.length, 0, 'deleting the final client must remove the old list item');
    assert.equal(fixture.state.error, null);
  } finally { fixture.cleanup(); }
});

test('AUD-38 Windows command data retains literal PowerShell argument values', () => {
  const { buildAgentInstallCommand, defaultAgentInstallOptions } = productionModule('src/utils/agentInstallCommand.ts');
  const evaluateOutputOnly = (probe) => {
    const guard = `$probe=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(probe, 'utf16le').toString('base64')}')); $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseInput($probe,[ref]$tokens,[ref]$errors); if($errors.Count) { throw 'Probe parse error' }; $commands=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)); foreach($command in $commands) { if($command.GetCommandName() -ne 'Write-Output') { throw 'Unexpected command boundary' } }; if($ast.Find({param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst]},$true)) { throw 'Unexpected member invocation' }; & ([scriptblock]::Create($probe))`;
    return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' + guard, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  };
  const allowedSentinel = evaluateOutputOnly("Write-Output 'AUDIT_SAFE_RECEIVER'");
  assert.equal(allowedSentinel.status, 0);
  assert.equal(allowedSentinel.stdout.trim(), 'AUDIT_SAFE_RECEIVER');
  const blockedSentinel = evaluateOutputOnly("Invoke-WebRequest 'https://synthetic.invalid'");
  assert.notEqual(blockedSentinel.status, 0);
  assert.ok(blockedSentinel.stderr.includes('Unexpected command boundary'));
  console.log('AUD-38 sentinel: only Write-Output is executable; download boundary was rejected before invocation');
  for (const nodeName of ['audit $(Write-Output AUDIT_INTERPOLATED)', '中文 空格 \' single " double ` backtick $variable']) {
      const command = buildAgentInstallCommand({
        platform: 'windows', serverUrl: 'https://synthetic.invalid', token: 'synthetic-token', instanceId: 'audit-node', nodeName,
        options: { ...defaultAgentInstallOptions, dir: 'C:\\audit path', serviceName: 'audit-service' },
      });
      let script;
      const encoded = / -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
      if (encoded) {
        script = Buffer.from(encoded[1], 'base64').toString('utf16le');
      } else {
        // Only evaluate the known harmless first fixture's OUTER STRING. Never execute its script.
        assert.equal(nodeName, 'audit $(Write-Output AUDIT_INTERPOLATED)', 'legacy quoting is only probed with the fixed harmless expression fixture');
        const outerArgument = command.slice(command.indexOf(' -Command ') + ' -Command '.length);
        const result = evaluateOutputOnly(`Write-Output ${outerArgument}`);
        assert.equal(result.status, 0, result.stderr);
        script = result.stdout.trim();
        assert.ok(script.includes(nodeName), 'the generated outer string must not evaluate the literal node-name expression');
      }
      // The original command is DATA for the PowerShell parser, never a scriptblock to invoke.
      const parser = `$text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf16le').toString('base64')}')); $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors); if($errors.Count) { throw 'Generated command has parse errors' }; $install=$ast.Find({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.CommandElements[0].Value -eq '.\\install-windows.ps1' },$true); $values=@{}; for($i=1;$i -lt $install.CommandElements.Count;$i+=2) { $values[$install.CommandElements[$i].ParameterName]=$install.CommandElements[$i+1].Value }; $values | ConvertTo-Json -Compress`;
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' + parser, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      const received = JSON.parse(result.stdout.trim());
      assert.equal(received.n, nodeName);
      assert.equal(received.InstallDir, 'C:\\audit path');
      assert.equal(received.ServiceName, 'audit-service');
  }
});

test('AUD-46 toggling offline notification preserves saved grace period', async () => {
  for (const [savedGrace, expected] of [[1200, 1200], [undefined, 360]]) {
    const requests = [];
    const toggle = productionDeclaration(notifications, 'toggleOffline', {
      runAction: passthroughAction,
      DEFAULT_GRACE_PERIOD_SEC: 360,
      notificationMap: new Map([['node-a', { grace_period: savedGrace }]]),
      apiFetch: async (_path, options) => { requests.push(JSON.parse(options.body)); return { success: true }; },
      toast: { success() {}, error() {} }, loadOfflineTab() {},
    });
    await toggle('node-a', false);
    await toggle('node-a', true);
    assert.deepEqual(requests.map(item => item.grace_period), [expected, expected]);
  }
});

test('AUD-47 legal stored intervals survive opening and unrelated saving', () => {
  const stored = { record_persist_interval_sec: '60', ping_record_persist_interval_sec: '300', live_poll_idle_interval_sec: '600', record_preserve_time: '24' };
  const normalize = productionDeclaration('src/pages/admin/SettingsGeneral.tsx', 'normalizeGeneralSettings');
  const opened = normalize(stored);
  assert.deepEqual({ ...opened }, stored, 'opening the form must not rewrite legitimate saved intervals');
  assert.deepEqual(getChangedSettings({ ...opened, record_preserve_time: '48' }, stored), { record_preserve_time: '48' });
});

test('AUD-48 Telegram test pins Telegram independently of global channel', async () => {
  for (const method of ['none', 'email', 'webhook', 'telegram']) {
    let body;
    const send = productionDeclaration(notifications, 'sendTestMessage', {
      runAction: passthroughAction,
      settings: { notification_method: method },
      apiFetch: async (_path, options) => { body = JSON.parse(options.body); return { success: true }; },
      toast: { success() {}, error() {} },
    });
    await send();
    assert.equal(body.channel, 'telegram', `Telegram action must ignore global method ${method}`);
  }
});

test('AUD-45 directed load rules reject an empty target list before posting', async () => {
  const requests = [];
  const errors = [];
  const save = productionDeclaration(notifications, 'saveLoadNotification', {
    runAction: passthroughAction,
    editingLoad: null,
    loadForm: { name: 'Synthetic rule', metric: 'cpu', threshold: 80, ratio: 0.8, interval_min: 15, all_clients: false, clients: [] },
    apiFetch: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return { success: true }; },
    toast: { success() {}, error(message) { errors.push(message); } },
    setLoadDialogOpen() {}, loadLoadTab() {},
  });
  await save();
  assert.equal(requests.length, 0, 'a directed rule with zero selected nodes must not be posted as a global rule');
  assert.equal(errors.length, 1, 'the user must receive a target-selection error');
});

test('AUD-50 controlled load threshold and ratio render legitimate zero values', () => {
  for (const field of ['threshold', 'ratio']) {
    const element = productionJsx(notifications, (node, ast, ts) => {
      if (!ts.isJsxSelfClosingElement(node) || node.tagName.getText(ast) !== 'TextField.Root') return false;
      const attribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === 'value');
      return attribute?.initializer?.getText(ast).includes(`loadForm.${field}`);
    }, { TextField, loadForm: { threshold: 0, ratio: 0 }, setLoadForm() {} });
    const markup = renderToStaticMarkup(element);
    assert.match(markup, /value="0"/, `${field}=0 must be the visible controlled input value`);
  }
});

test('AUD-50 load rule summaries use metric units and keep zero', () => {
  for (const [metric, threshold, expected] of [['temp', 0, '0°C'], ['load', 0.5, '0.5'], ['cpu', 0, '0%']]) {
    const element = productionJsx(notifications, (node, ast, ts) => ts.isJsxElement(node)
      && node.openingElement.tagName.getText(ast) === 'Text'
      && node.getText(ast).includes('item.threshold'), {
      Text, item: { metric, threshold },
      loadMetricUnit: (value) => productionDeclaration(notifications, 'loadMetricUnit')(value),
    });
    const visible = renderToStaticMarkup(element).replace(/<[^>]*>/g, '');
    assert.equal(visible, expected, `${metric} rule must show its stored threshold in the metric's real unit`);
  }
});
