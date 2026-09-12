import test from 'node:test';
import assert from 'node:assert/strict';
import { productionDeclaration, productionEffect, productionModule } from './helpers/production-module.mjs';
import { normalizePublicMonitorRecord, normalizePublicMonitorRecords, normalizePublicGpuRecord } from '../src/utils/publicHistory.ts';
import { buildMonitorChartData, getMonitorChartRenderData } from '../src/utils/monitorChartData.ts';

test('R-A11 unavailable host temperature preserves the rest of a history sample', () => {
  const base = { time: '2026-09-09T01:00:00Z', cpu: 23, ram: 512, ram_total: 1024, net_in: 4096 };
  for (const input of [{}, { temp: null }, { temp: undefined }, { temp: NaN }, { temp: Infinity }, { temp: 'unknown' }]) {
    const record = normalizePublicMonitorRecord({ ...base, ...input });
    assert.ok(record, 'unavailable temperature cannot discard CPU/network history');
    assert.equal(record.temp, null, 'unavailable temperature is not a measured zero');
    assert.equal(record.cpu, 23);
    assert.equal(record.net_in, 4096);
    const point = buildMonitorChartData([record])[0];
    assert.equal(point.temp, null);
    assert.equal(point.ram, 50);
  }
});

test('R-A11 measured zero and signed Celsius remain numeric and separate from GPU temperature', () => {
  for (const temp of [0, -12.5, 42.25]) {
    const record = normalizePublicMonitorRecord({ time: '2026-09-09T01:00:00Z', temp, temperature: 87 });
    assert.equal(record.temp, temp);
    assert.equal(buildMonitorChartData([record])[0].temp, temp);
  }
  assert.equal(normalizePublicGpuRecord({ time: '2026-09-09T01:00:00Z', temperature: 65, temp: null }).temperature, 65);
});

test('R-A11 mixed host temperature history retains null gaps without losing other metrics', () => {
  const temperatures = [10, 12, null, null, 0, -7, null, 25, 30];
  const records = normalizePublicMonitorRecords(temperatures.map((temp, index) => ({
    time: new Date(Date.parse('2026-09-09T01:00:00Z') + index * 1000).toISOString(), cpu: index + 1, temp,
  })));
  assert.equal(records.length, temperatures.length, 'every otherwise-valid sample survives');
  const points = buildMonitorChartData(records);
  assert.deepEqual(points.map(point => point.temp), temperatures);
  assert.deepEqual(points.map(point => point.cpu), temperatures.map((_temp, index) => index + 1));
});

test('R-A11 empty and raw missing-temperature chart points never fabricate zero', () => {
  const points = getMonitorChartRenderData([], 3600000, Date.parse('2026-09-09T02:00:00Z'));
  assert.equal(points.length, 2, 'empty history retains its time-axis bounds');
  assert.ok(points.every(point => point.temp === null), 'axis placeholders contain no measured temperature');
  assert.equal(buildMonitorChartData([{ time: '2026-09-09T01:00:00Z', cpu: 10 }])[0].temp, null);
});

test('R-A11 node-card fallback has no fabricated host temperature', () => {
  const fallback = productionDeclaration('src/components/NodeCard.tsx', 'defaultLive');
  assert.equal(fallback.temp, null, 'an absent live record is not a measured zero');
});

test('R-F01 website mutation events do not expose administrator rows', () => {
  const sent = [];
  const events = productionModule('src/utils/websiteMonitorEvents.ts', {
    './crossTabEvents': { broadcastCrossTab: (_name, detail) => sent.push(detail), subscribeCrossTab() {} },
  });
  const monitor = { id: 1, name: 'private name', url: 'https://private.invalid/path', hide_url: true, hidden: false, agent_probe_clients: ['private-node'] };
  for (const detail of [
    { upsert: [monitor] },
    { upsert: [{ ...monitor, enabled: false }] },
    { upsert: [{ ...monitor, hidden: true }] },
    { upsert: [monitor], reorder: [1] },
  ]) {
    events.notifyWebsiteMonitorsUpdated(detail);
    assert.equal(JSON.stringify(sent.at(-1)).includes('https://private.invalid/path'), false, 'private URL cannot enter public transport');
    assert.equal(JSON.stringify(sent.at(-1)).includes('private-node'), false, 'private probe selection cannot enter public transport');
  }
});

test('R-F01 public website normalization defends against an older full administrator event', () => {
  const file = 'src/pages/Index.tsx';
  const readWebsiteHidden = productionDeclaration(file, 'readWebsiteHidden');
  const normalize = productionDeclaration(file, 'normalizeWebsiteSummary', { readWebsiteHidden });
  const monitor = { id: 1, name: 'Synthetic', url: 'https://private.invalid/path', hidden: false, hide_url: true };
  assert.equal(normalize(monitor).url, null, 'anonymous consumer independently respects hide_url');
  assert.equal(normalize(monitor, { includeHidden: true }).url, monitor.url, 'explicit administrator view may retain the address');
  assert.equal(normalize({ ...monitor, hide_url: false, url: null }).url, null, 'null public API addresses stay null');
});

test('R-F02 invalid settings responses never become a confirmed cache baseline', async () => {
  for (const payload of [null, [], 'invalid', { record_preserve_time: null }]) {
    const settingsCacheRef = { current: {} };
    const settingsRequestsRef = { current: {} };
    const load = productionDeclaration('src/pages/admin/SettingsLayout.tsx', 'loadSettingsScope', {
      settingsCacheRef, settingsRequestsRef, apiFetch: async () => payload,
      setSettingsScope: (scope, value) => { settingsCacheRef.current[scope] = value; },
    });
    await assert.rejects(load('general'), /设置|settings|响应|格式/i, 'invalid response is a read failure');
    assert.equal(settingsCacheRef.current.general, undefined);
    assert.equal(settingsRequestsRef.current.general, undefined, 'a rejected request must be retryable');
  }
});

test('R-F03 a slow logo reset patches only the latest confirmed logo field', async () => {
  const response = Promise.withResolvers();
  const settingsCacheRef = { current: { site: { site_title: 'Original', site_logo_url: '/old.png' } } };
  const setSettingsScope = productionDeclaration('src/pages/admin/SettingsLayout.tsx', 'setSettingsScope', {
    settingsCacheRef, setSettingsCacheState() {},
  });
  const reset = productionDeclaration('src/pages/admin/SettingsSite.tsx', 'handleResetLogo', {
    settings: { site_title: 'Unsaved draft', site_logo_url: '/old.png' },
    apiFetch: () => response.promise, setLogoSaving() {}, setSettings() {}, setOriginalSettings() {},
    setSettingsScope, notifyPublicDataUpdated() {}, toast: { success() {}, error(message) { throw new Error(message); } },
  });
  const pending = reset();
  setSettingsScope('site', { site_title: 'Newer confirmed title', site_logo_url: '/old.png' });
  response.resolve({ success: true });
  await pending;
  assert.equal(settingsCacheRef.current.site.site_title, 'Newer confirmed title', 'a logo response cannot promote an older draft or revert a newer saved title');
  assert.equal(settingsCacheRef.current.site.site_logo_url, '');
});

test('R-F03 a slow title save preserves a logo confirmed while the request was pending', async () => {
  const response = Promise.withResolvers();
  const settingsCacheRef = { current: { site: { site_title: 'Original', site_logo_url: '/old.png' } } };
  const setSettingsScope = productionDeclaration('src/pages/admin/SettingsLayout.tsx', 'setSettingsScope', { settingsCacheRef, setSettingsCacheState() {} });
  const save = productionDeclaration('src/pages/admin/SettingsSite.tsx', 'handleSave', {
    settings: { site_title: 'Confirmed title', site_logo_url: '/old.png' }, originalSettings: { site_title: 'Original', site_logo_url: '/old.png' },
    settingsReady: true, loading: false, loadError: null, saving: false,
    getChangedSettings: productionModule('src/utils/settingsDiff.ts').getChangedSettings,
    apiFetch: () => response.promise, setSaving() {}, setOriginalSettings() {}, setSettingsScope,
    notifyPublicDataUpdated() {}, toast: { success() {}, info() {}, error(message) { throw new Error(message); } },
  });
  const pending = save();
  setSettingsScope('site', { site_title: 'Original', site_logo_url: '/confirmed-logo.png' });
  response.resolve({ success: true });
  await pending;
  assert.equal(settingsCacheRef.current.site.site_logo_url, '/confirmed-logo.png', 'an unrelated title response cannot roll back the confirmed logo');
  assert.equal(settingsCacheRef.current.site.site_title, 'Confirmed title');
});

for (const domain of ['clients', 'websites']) {
  test(`R-F04 a failed ${domain} reorder cannot undo another confirmed edit`, async () => {
    const response = Promise.withResolvers();
    const initial = domain === 'clients'
      ? [{ uuid: 'a', name: 'Alpha', sort_order: 0 }, { uuid: 'b', name: 'Beta', sort_order: 1 }]
      : [{ id: 1, name: 'Alpha', sort_order: 1 }, { id: 2, name: 'Beta', sort_order: 2 }];
    let current = structuredClone(initial);
    const update = value => { current = typeof value === 'function' ? value(current) : value; };
    const reorder = productionDeclaration(`src/pages/admin/${domain === 'clients' ? 'Dashboard' : 'Websites'}.tsx`, 'handleDragEnd', {
      clients: initial, monitors: initial, filtered: initial, dragDisabled: false,
      setClients: update, setMonitors: update, updateClients: update, updateMonitors: update,
      clientOrderRef: { current: 0 }, monitorOrderRef: { current: 0 },
      apiFetch: () => response.promise,
      loadClients: async () => {}, loadMonitors: async () => {},
      moveAdminNodeInVisibleOrder: productionModule('src/utils/adminNodeOrder.ts').moveAdminNodeInVisibleOrder,
      arrayMove: (items, from, to) => { const list = [...items]; list.splice(to, 0, list.splice(from, 1)[0]); return list; },
      assertSuccess: result => { if (!result.success) throw new Error('Rejected reorder'); },
      notifyPublicDataUpdated() {}, notifyWebsiteMonitorsUpdated() {},
      toast: { error() {}, success() {} },
    });
    const pending = reorder({ active: { id: domain === 'clients' ? 'a' : 1 }, over: { id: domain === 'clients' ? 'b' : 2 } });
    current = current.map(item => item.name === 'Alpha' ? { ...item, name: 'Newest persisted name' } : item);
    response.resolve({ success: false });
    await pending;
    assert.ok(current.some(item => item.name === 'Newest persisted name'), 'rollback changes order only, preserving newer fields');
    assert.equal(current[0].name, 'Newest persisted name', 'the original order is restored');
  });
}

test('R-F06 logout waits for confirmation, deduplicates and preserves authentication on failure', async () => {
  const response = Promise.withResolvers();
  let requests = 0;
  let clears = 0;
  const logout = productionDeclaration('src/contexts/AuthContext.tsx', 'logout', {
    clearAuth: () => { clears += 1; }, API_BASE: '/api', CSRF_COOKIE_NAME: 'csrf', readCookie: () => 'synthetic',
    logoutRequestRef: { current: null }, authRevisionRef: { current: 0 },
    readJson: response => response.json(), fetch: () => { requests += 1; return response.promise; },
  });
  const first = logout();
  const second = logout();
  response.resolve(new Response(JSON.stringify({ error: 'Rejected logout' }), { status: 500 }));
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(requests, 1, 'one server logout while pending');
  assert.equal(clears, 0, 'a failed logout cannot clear the displayed session');
  assert.equal(outcomes[0].status, 'rejected', 'the caller receives the error and can offer retry');
});

test('R-F06 an authenticated API rejection clears local state without an explicit logout request', async () => {
  let clears = 0;
  let logouts = 0;
  const api = productionDeclaration('src/contexts/AuthContext.tsx', 'useApiResponse', {
    useAuth: () => ({ clearAuth: () => { clears += 1; }, logout: () => { logouts += 1; } }),
    useCallback: value => value, runWithMfaStepUpRetry: request => request(), requestMfaStepUp() {},
    buildApiRequest: path => ({ url: path, init: {} }),
    fetch: async () => new Response(JSON.stringify({ error: 'Session expired' }), { status: 401 }),
    readJson: response => response.json(), shouldClearAuthForStatus: status => status === 401,
  })();
  await assert.rejects(api('/admin/synthetic'), /Session expired/);
  assert.equal(clears, 1, 'session rejection invalidates local authentication');
  assert.equal(logouts, 0, '401 handling does not create an extra authenticated mutation');
});

test('R-F06 an earlier session lookup cannot restore an authenticated user after logout', async () => {
  const response = Promise.withResolvers();
  let user = { uuid: 'old', username: 'Old administrator' };
  const authRevisionRef = { current: 0 };
  const setUser = update => { user = typeof update === 'function' ? update(user) : update; };
  const clearAuth = () => { authRevisionRef.current += 1; user = null; };
  const effect = productionEffect('src/contexts/AuthContext.tsx', 'shouldCheckSession', {
    API_BASE: '/api', window: { location: { pathname: '/admin' } }, shouldCheckAdminSessionOnLoad: () => true,
    authRevisionRef, setAuthLoading() {}, clearAuth, setUser, writeStoredUser() {},
    normalizeAuthUser: payload => payload.uuid ? payload : null, readJson: response => response.json(), fetch: () => response.promise,
  });
  const cleanup = effect();
  clearAuth();
  response.resolve(new Response(JSON.stringify({ uuid: 'old', username: 'Old administrator' })));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(user, null, 'a completed logout retires pending session hydration');
  cleanup();
});

test('R-F08 a retired verification cannot finish a newer MFA dialog', async () => {
  const response = Promise.withResolvers();
  const completed = [];
  const resolver = { current: value => completed.push(['old', value]) };
  const pendingRequestRef = { current: null };
  const finish = productionDeclaration('src/components/MfaStepUpDialog.tsx', 'finish', {
    resolver, pendingRequestRef, setOpen() {}, setSubmitting() {}, setCode() {}, setError() {}, setMethod() {},
  });
  const submit = productionDeclaration('src/components/MfaStepUpDialog.tsx', 'submit', {
    resolver, pendingRequestRef, code: '123456', method: 'totp', AbortController,
    normalizeMfaCode: productionModule('src/utils/mfa.ts').normalizeMfaCode,
    setSubmitting() {}, setError() {}, buildApiRequest: () => ({ url: '/synthetic', init: {} }), fetch: () => response.promise, finish,
  });
  const pending = submit();
  finish(false);
  resolver.current = value => completed.push(['new', value]);
  response.resolve(new Response(JSON.stringify({ success: true })));
  await pending;
  assert.deepEqual(completed, [['old', false]], 'late success cannot resolve the newer dialog');
  assert.equal(typeof resolver.current, 'function', 'the new dialog stays pending');
});

test('R-F08 unmount retires verification errors and resolves cancellation', async () => {
  const response = Promise.withResolvers();
  const completed = [];
  let changes = 0;
  const resolver = { current: value => completed.push(value) };
  const pendingRequestRef = { current: null };
  const bindings = {
    resolver, pendingRequestRef, code: '123456', method: 'totp', AbortController,
    normalizeMfaCode: productionModule('src/utils/mfa.ts').normalizeMfaCode,
    setSubmitting: () => { changes += 1; }, setError: () => { changes += 1; },
    buildApiRequest: () => ({ url: '/synthetic', init: {} }), fetch: () => response.promise, finish() {},
  };
  const pending = productionDeclaration('src/components/MfaStepUpDialog.tsx', 'submit', bindings)();
  changes = 0;
  productionEffect('src/components/MfaStepUpDialog.tsx', 'resolver.current?.(false)', bindings)()();
  response.resolve(new Response(JSON.stringify({ error: 'Late failure' }), { status: 500 }));
  await pending;
  assert.equal(changes, 0, 'unmounted verification cannot write error/loading state');
  assert.deepEqual(completed, [false], 'unmount cancels the suspended original operation');
});

test('R-F09 an initial removal and later update survive a full read without reviving removed fields', () => {
  const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
  scope.patch({ type: 'remove', client: 'a', timestamp: 1 });
  const read = scope.beginRead();
  scope.patch({ type: 'update', client: 'a', data: { cpu: 70 }, timestamp: 2 });
  const result = scope.complete(read, { online: ['a', 'b'], clients: [], data: { a: { cpu: 10, ram: 99 }, b: { cpu: 30 } }, count: 2, timestamp: 0 });
  assert.equal(result.data.a.cpu, 70);
  assert.equal(result.data.a.ram, undefined, 'removal before reappearance discards the obsolete node record');
  assert.equal(result.data.b.cpu, 30, 'unaffected full-snapshot nodes remain');
});

test('R-F09 cached startup data cannot override a confirmed snapshot and disposed scopes cannot commit', () => {
  const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
  const current = { online: ['a'], clients: [], data: { a: { cpu: 70 } }, count: 1, timestamp: 2 };
  scope.snapshot(current);
  assert.equal(scope.seed({ ...current, data: { a: { cpu: 10 } } }), undefined, 'cached reconnect seed cannot replace known live state');
  const read = scope.beginRead();
  scope.dispose();
  assert.equal(scope.complete(read, current), undefined);
  assert.equal(scope.canReportError(read), false, 'late scope errors are also obsolete');
  assert.equal(scope.patch({ type: 'update', client: 'a', data: { cpu: 10 }, timestamp: 3 }), undefined);
});

for (const type of ['update', 'remove']) {
  test(`R-F09 retry discards a pre-retry ${type} superseded by the new full snapshot`, () => {
    const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
    const first = scope.beginRead();
    scope.patch({ type, client: 'a', data: { cpu: 10 }, timestamp: 100 });
    assert.equal(scope.canReportError(first), true, 'a partial update never conceals the initial full-read failure');
    scope.finishRead(first);
    const retry = scope.beginRead();
    const snapshot = { online: ['a', 'b'], clients: [], data: { a: { cpu: 20, ram: 200 }, b: { cpu: 30 } }, count: 2, timestamp: 200 };
    const result = scope.complete(retry, snapshot);
    assert.equal(result.data.a?.cpu, 20, 'a successful newer snapshot supersedes pre-retry socket history');
    assert.equal(result.data.a.ram, 200);
    assert.equal(result.data.b.cpu, 30);
    assert.equal(result.timestamp, 200, 'the read must not roll snapshot freshness backward');
  });
}

test('R-F09 retry preserves pre-read patches that are newer than a returned cached snapshot', () => {
  for (const type of ['update', 'remove']) {
    const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
    const first = scope.beginRead();
    scope.patch({ type, client: 'a', data: { cpu: 70 }, timestamp: 100 });
    scope.finishRead(first);
    const retry = scope.beginRead();
    const result = scope.complete(retry, { online: ['a', 'b'], clients: [], data: { a: { cpu: 20 }, b: { cpu: 30 } }, count: 2, timestamp: 50 });
    assert.equal(result.data.a?.cpu, type === 'update' ? 70 : undefined);
    assert.equal(result.data.b.cpu, 30);
  }
});

test('R-F09 retry replays during-read updates without resurrecting an older removal', () => {
  const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
  const first = scope.beginRead();
  scope.patch({ type: 'remove', client: 'a', timestamp: 100 });
  scope.finishRead(first);
  const retry = scope.beginRead();
  scope.patch({ type: 'update', client: 'a', data: { cpu: 70 }, timestamp: 300 });
  const result = scope.complete(retry, { online: ['a', 'b'], clients: [], data: { a: { cpu: 20, ram: 200 }, b: { cpu: 30 } }, count: 2, timestamp: 200 });
  assert.equal(result.data.a.cpu, 70);
  assert.equal(result.data.a.ram, 200, 'a removal already superseded before the retry cannot erase fields from its fresh baseline');
  assert.equal(result.data.b.cpu, 30);
});

test('R-F09 cache seed compares initial socket history with the snapshot timestamp', () => {
  for (const snapshotTime of [50, 200]) {
    const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
    scope.patch({ type: 'update', client: 'a', data: { cpu: 10 }, timestamp: 100 });
    const result = scope.seed({ online: ['a', 'b'], clients: [], data: { a: { cpu: 20 }, b: { cpu: 30 } }, count: 2, timestamp: snapshotTime });
    assert.equal(result.data.a.cpu, snapshotTime === 50 ? 10 : 20);
    assert.equal(result.data.b.cpu, 30);
  }
});
