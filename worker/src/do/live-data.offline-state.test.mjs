import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createDurableState, createSocket, createWorkerLoader } from '../../test-support/worker-module.mjs';

const node = { uuid: 'node', name: 'Managed node', hidden: false, sort_order: 7, disk_total: 983_000_000_000 };

function fixture({ initial = [], controls = [node], dbOverrides = {} } = {}) {
  let now = 1_800_000_000_000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const viewers = [false, true].map(includeHidden => createSocket({
    role: 'viewer', clientId: includeHidden ? 'admin-viewer' : 'public-viewer', clientName: 'viewer',
    hidden: false, includeHidden, viewerExpiresAt: now + 3_600_000,
  }));
  const storage = createDurableState([
    ...(controls ? [['admin-clients:snapshot', { clients: controls, complete: true, updatedAt: now - 1, removed: [] }]] : []),
    ...initial,
  ], viewers.map(viewer => viewer.ws));
  storage.state.getWebSockets = () => storage.sockets.filter(socket => socket.readyState === 1);
  const patches = [];
  const loader = createWorkerLoader({ globals: { Date: Clock }, db: {
    getSettingsByKeys: async () => ({ record_enabled: 'false' }),
    listPublicClientRows: async () => structuredClone(controls || []),
    getSetting: async () => null, setSetting: async () => {},
    updateClient: async (_database, uuid, patch) => patches.push({ uuid, ...patch }),
    listPingTasks: async () => [], listAgentWebsiteProbeTasks: async () => [],
    insertAuditLog: async () => {}, tryClaimAuditThrottle: async () => true,
    ...dbOverrides,
  } });
  const { LiveDataDO } = loader.load('worker/src/do/live-data.ts');
  const object = new LiveDataDO(storage.state, {});
  return {
    object, storage, viewers, loader, patches,
    get now() { return now; }, advance(ms) { now += ms; },
    cold: () => new LiveDataDO(storage.state, {}),
    agent(uuid = 'node') {
      const socket = createSocket({ role: 'agent', clientId: uuid, clientName: 'Agent supplied name', hidden: false });
      object.registerSession(socket.ws, socket.ws.deserializeAttachment());
      storage.sockets.push(socket.ws);
      return socket;
    },
  };
}

async function snapshot(object, includeHidden = false) {
  const response = await object.fetch(new Request(`https://do/live${includeHidden ? '?include_hidden=1' : ''}`));
  assert.equal(response.status, 200);
  return response.json();
}

function control(object, action, value) {
  return object.fetch(new Request(`https://do/${action}`, { method: 'POST', body: JSON.stringify(value) }));
}

async function httpReport(f, report = {}, uuid = 'node') {
  const response = await control(f.object, 'client-report', {
    uuid, name: 'Agent supplied name', ttl_ms: 180000,
    report: { cpu: 17, timestamp: f.now - 2000, ...report },
  });
  assert.equal(response.status, 200);
  await f.storage.drain();
}

async function wsReport(f, socket, report = {}) {
  await f.object.webSocketMessage(socket.ws, JSON.stringify({ type: 'report', data: { cpu: 23, timestamp: f.now - 2000, ...report } }));
  await f.storage.drain();
}

for (const transport of ['http', 'websocket']) {
  test(`${transport} directory disk source and sampling time survive offline state and cold restart`, async () => {
    const f = fixture();
    const receivedAt = f.now;
    const measuredAt = receivedAt - 300_000;
    const report = { disk: 8_388_608, disk_total: 5_024_000_000, disk_source: 'directory', disk_sampled_at: measuredAt };
    if (transport === 'http') {
      await httpReport(f, report);
      f.advance(180001);
      await f.object.alarm();
    } else {
      const agent = f.agent();
      await wsReport(f, agent, report);
      agent.ws.close();
      await f.object.webSocketClose(agent.ws);
    }
    await f.storage.drain();
    for (const object of [f.object, f.cold()]) {
      const live = await snapshot(object);
      assert.deepEqual(live.online, []);
      assert.equal(live.last_known.node.disk, 8_388_608);
      assert.equal(live.last_known.node.disk_source, 'directory');
      assert.equal(live.last_known.node.disk_sampled_at, measuredAt);
      assert.equal(live.last_known.node.lastReportTime, receivedAt);
    }
  });
}

test('an expired HTTP node keeps its final metrics for new viewers and cold reconstruction', async () => {
  const f = fixture();
  const receivedAt = f.now;
  await httpReport(f, { disk: null, disk_total: null, uptime: null, arbitrary_extension: 'PRIVATE_REPORT_VALUE' });
  f.advance(180001);
  await f.object.alarm();
  await f.storage.drain();
  for (const object of [f.object, f.cold()]) {
    const live = await snapshot(object);
    assert.deepEqual(live.online, []);
    assert.deepEqual(live.clients, []);
    assert.deepEqual(live.data, {});
    assert.equal(live.count, 0);
    assert.equal(live.last_known?.node?.cpu, 17, 'last metrics must survive the online TTL');
    assert.equal(live.last_known.node.lastReportTime, receivedAt);
    assert.equal(live.last_known.node.timestamp, receivedAt - 2000);
    assert.equal(live.last_known.node.disk, null);
    assert.equal(live.last_known.node.disk_total, null);
    assert.equal(live.last_known.node.uptime, null);
    assert.ok(!JSON.stringify(live).includes('PRIVATE_REPORT_VALUE'));
  }
  const offline = f.viewers[0].messages.find(message => message.type === 'remove');
  assert.equal(offline?.reason, 'offline');
  assert.equal(offline?.last_known?.cpu, 17);
});

test('a disconnected WebSocket node is retained without restoring online from its stored report', async () => {
  const f = fixture();
  const agent = f.agent();
  await wsReport(f, agent);
  assert.ok(agent.messages.some(message => message.type === 'ack'));
  agent.ws.close();
  await f.object.webSocketClose(agent.ws);
  for (const object of [f.object, f.cold()]) {
    const live = await snapshot(object);
    assert.deepEqual(live.online, []);
    assert.equal(live.last_known?.node?.cpu, 23);
  }
  assert.equal(f.viewers[0].messages.find(message => message.type === 'remove')?.reason, 'offline');
});

test('legacy HTTP entries retain their TTL while expired entries remain displayable', async () => {
  const f = fixture({ controls: [node, { ...node, uuid: 'expired' }], initial: [
    ['http-live:node', { uuid: 'node', name: node.name, hidden: false, lastReportTime: 1_799_999_999_000,
      expiresAt: 1_800_000_180_000, lastReport: { cpu: 11 } }],
    ['http-live:expired', { uuid: 'expired', name: 'Expired', hidden: false, lastReportTime: 1_799_999_800_000,
      expiresAt: 1_799_999_999_999, lastReport: { cpu: 12 } }],
  ] });
  const live = await snapshot(f.object);
  assert.deepEqual(live.online, ['node']);
  assert.equal(live.last_known?.expired?.cpu, 12);
  assert.equal(live.last_known.node, undefined);
});

test('cold reconstruction keeps a newer HTTP fallback measurement over an older live socket attachment', async () => {
  const f = fixture();
  await httpReport(f, { cpu: 31, disk: null, disk_total: 5024_000_000 });
  const socket = createSocket({ role: 'agent', clientId: 'node', clientName: node.name, hidden: false,
    lastReportTime: f.now - 1000, lastReport: { cpu: 12, disk: 100, disk_total: 983_000_000_000 },
  });
  f.storage.sockets.push(socket.ws);
  const restored = f.cold();
  const live = await snapshot(restored);
  assert.deepEqual(live.online, ['node']);
  assert.equal(live.data.node.cpu, 31);
  assert.equal(live.data.node.disk, null);
  assert.equal(live.data.node.disk_total, 5024_000_000);
  socket.ws.close();
  await restored.webSocketClose(socket.ws);
  assert.equal((await snapshot(restored)).last_known.node.cpu, 31);
});

test('offline visibility and names follow current controls, and deletion erases retained storage', async () => {
  const f = fixture();
  await httpReport(f);
  f.advance(180001);
  await f.object.alarm();
  await control(f.object, 'client-meta', { uuid: 'node', name: 'Hidden current name', hidden: true,
    client: { ...node, name: 'Hidden current name', hidden: true } });
  const publicLive = await snapshot(f.cold());
  assert.deepEqual(publicLive.last_known, {});
  const adminLive = await snapshot(f.cold(), true);
  assert.equal(adminLive.last_known?.node?.name, 'Hidden current name');
  const publicRemovals = f.viewers[0].messages.filter(message => message.type === 'remove');
  assert.ok(publicRemovals.some(message => message.client === 'node' && message.reason !== 'offline'), 'hiding must invalidate previously retained public metrics');
  await control(f.object, 'client-remove', { uuid: 'node' });
  assert.deepEqual((await snapshot(f.cold(), true)).last_known, {});
  assert.equal(f.storage.values.has('http-live:node'), false);
});

test('restoring client configuration clears all retained reports even if the UUID remains authorized', async () => {
  const f = fixture();
  await httpReport(f);
  f.advance(180001);
  await f.object.alarm();
  const response = await control(f.object, 'clients-restore', { clients: [node] });
  assert.equal(response.status, 200);
  const live = await snapshot(f.cold(), true);
  assert.deepEqual(live.online, []);
  assert.deepEqual(live.last_known, {});
});

test('partial control snapshots do not drop unrelated retained nodes but full membership removes them', async () => {
  const f = fixture({ controls: null });
  await httpReport(f);
  f.advance(180001);
  await f.object.alarm();
  await control(f.object, 'client-meta', { uuid: 'other', name: 'Other node', hidden: false,
    client: { uuid: 'other', name: 'Other node', hidden: false } });
  assert.equal((await snapshot(f.cold())).last_known?.node?.cpu, 17);
  const previous = await (await f.object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
  const response = await f.object.fetch(new Request('https://do/admin-clients-snapshot', { method: 'PUT',
    body: JSON.stringify({ clients: previous.clients, expected_version: previous.updatedAt }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await snapshot(f.cold(), true)).last_known, {});
});

test('sort order in live and retained data belongs to administrator metadata', async () => {
  const f = fixture();
  await httpReport(f, { sort_order: -999, basic_info: { sort_order: -999 } });
  const online = await snapshot(f.object);
  assert.equal(online.clients[0].sort_order, 7);
  assert.equal(online.data.node.sort_order, 7);
  assert.equal(f.viewers[0].messages.find(message => message.type === 'update')?.data.sort_order, 7);
  assert.equal(f.viewers[1].messages.find(message => message.type === 'update')?.data.sort_order, 7);
  f.advance(180001);
  assert.equal((await snapshot(f.cold())).last_known?.node?.sort_order, 7);
});

test('without administrator ordering, an Agent cannot inject ordering through a viewer update', async () => {
  const f = fixture({ controls: [{ uuid: 'node', name: node.name, hidden: false }] });
  await httpReport(f, { sort_order: -999 });
  for (const viewer of f.viewers) {
    const update = viewer.messages.find(message => message.type === 'update');
    assert.equal(Object.hasOwn(update.data, 'sort_order'), false);
  }
});

test('renaming an expired HTTP node before its alarm runs does not broadcast an online update', async () => {
  const f = fixture();
  await httpReport(f);
  f.advance(180001);
  assert.deepEqual((await snapshot(f.object)).online, []);
  const before = f.viewers[0].messages.length;
  await control(f.object, 'client-meta', { uuid: 'node', name: 'Renamed offline', hidden: false,
    client: { ...node, name: 'Renamed offline' } });
  const events = f.viewers[0].messages.slice(before);
  assert.ok(!events.some(message => message.type === 'update'));
  assert.equal(events.find(message => message.reason === 'offline')?.last_known?.name, 'Renamed offline');
  assert.deepEqual((await snapshot(f.object)).online, []);
});

test('background report enrichment obeys a newer complete visibility snapshot', async () => {
  const f = fixture();
  await httpReport(f);
  const metadata = await (await f.object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
  const response = await f.object.fetch(new Request('https://do/admin-clients-snapshot', { method: 'PUT',
    body: JSON.stringify({ clients: [{ ...node, hidden: true }], expected_version: metadata.updatedAt }),
  }));
  assert.equal(response.status, 200);
  const before = f.viewers[0].messages.length;
  f.object.applyInferredNetworkMetadataToLiveReport('node', { region: 'New region' }, f.now);
  assert.ok(!f.viewers[0].messages.slice(before).some(message => message.type === 'update'));
  assert.deepEqual((await snapshot(f.object)).online, []);
});

test('a failed post-write control read preserves the previous acknowledged report after a cold restart', async () => {
  const f = fixture();
  const agent = f.agent();
  await wsReport(f, agent);
  const acknowledgements = agent.messages.filter(message => message.type === 'ack').length;
  const put = f.storage.state.storage.put;
  const get = f.storage.state.storage.get;
  let armed = true;
  let failRead = false;
  f.storage.state.storage.put = async (key, value) => {
    await put(key, value);
    if (key === 'http-live:node' && armed) { armed = false; failRead = true; }
  };
  f.storage.state.storage.get = async key => {
    if (key === 'admin-clients:snapshot' && failRead) {
      failRead = false;
      throw new Error('Synthetic temporary storage read failure');
    }
    return get(key);
  };
  await wsReport(f, agent, { cpu: 99 });
  assert.equal(agent.messages.filter(message => message.type === 'ack').length, acknowledgements);
  agent.ws.close();
  await f.object.webSocketClose(agent.ws);
  assert.equal((await snapshot(f.cold())).last_known?.node?.cpu, 23);
});

test('public HTTP and bootstrap readers keep retained reports and public field filtering', async () => {
  const f = fixture();
  await httpReport(f, { arbitrary_extension: 'PRIVATE_REPORT_VALUE', ipv4: '10.23.0.1' });
  f.advance(180001);
  await f.object.alarm();
  const app = new Hono();
  app.route('/api', f.loader.load('worker/src/routes/public.ts').publicRoutes);
  app.route('/api', f.loader.load('worker/src/routes/websocket.ts').wsRoutes);
  const env = { LIVE_DATA: { idFromName: value => value, get: () => ({ fetch: request => f.object.fetch(request) }) } };
  for (const path of ['/api/live', '/api/live/clients', '/api/public/bootstrap?fresh=1']) {
    const response = await app.fetch(new Request(`https://monitor.example.test${path}`, {
      headers: { 'CF-Connecting-IP': '1.1.1.1' },
    }), env, { waitUntil: promise => f.storage.state.waitUntil(promise) });
    assert.equal(response.status, 200, path);
    const body = await response.json();
    const live = body.live || body;
    assert.deepEqual(live.online, []);
    assert.equal(live.last_known?.node?.cpu, 17, path);
    assert.ok(!JSON.stringify(body).includes('PRIVATE_REPORT_VALUE'));
    assert.ok(!JSON.stringify(body).includes('10.23.0.1'));
  }
  await f.storage.drain();
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function pauseReportStorage(f) {
  const entered = deferred();
  const release = deferred();
  const put = f.storage.state.storage.put;
  let pending = true;
  let reached = false;
  f.storage.state.storage.put = async (key, value) => {
    if (key === 'http-live:node' && pending) {
      pending = false;
      reached = true;
      entered.resolve();
      await release.promise;
    }
    return put(key, value);
  };
  return { entered, release, get reached() { return reached; } };
}

test('WebSocket ACK and viewer update wait for the final report to become durable', async () => {
  const f = fixture();
  const agent = f.agent();
  const gate = pauseReportStorage(f);
  const pending = f.object.webSocketMessage(agent.ws, JSON.stringify({ type: 'report', data: { cpu: 33 } }));
  try {
    await Promise.race([gate.entered.promise, pending]);
    assert.equal(gate.reached, true, 'the accepted WebSocket report skipped durable storage');
    assert.equal(agent.messages.some(message => message.type === 'ack'), false);
    assert.equal(f.viewers[0].messages.some(message => message.type === 'update'), false);
    gate.release.resolve();
    await pending;
    assert.ok(agent.messages.some(message => message.type === 'ack'));
    assert.equal((await snapshot(f.cold())).data.node.cpu, 33);
  } finally { gate.release.resolve(); await pending; await f.storage.drain(); }
});

for (const action of ['hide', 'remove', 'restore']) {
  test(`an administrator ${action} during report persistence cannot resurrect public data`, async () => {
    const f = fixture();
    const agent = f.agent();
    const gate = pauseReportStorage(f);
    const pending = f.object.webSocketMessage(agent.ws, JSON.stringify({ type: 'report', data: { cpu: 44 } }));
    try {
      await Promise.race([gate.entered.promise, pending]);
      assert.equal(gate.reached, true, 'the WebSocket report must reach its durability boundary');
      if (action === 'hide') await control(f.object, 'client-meta', { uuid: 'node', name: node.name, hidden: true, client: { ...node, hidden: true } });
      else if (action === 'remove') await control(f.object, 'client-remove', { uuid: 'node' });
      else await control(f.object, 'clients-restore', { clients: [node] });
      const before = f.viewers[0].messages.length;
      gate.release.resolve();
      await pending;
      await f.storage.drain();
      assert.deepEqual((await snapshot(f.object)).online, []);
      assert.deepEqual((await snapshot(f.cold())).last_known, {});
      assert.ok(!f.viewers[0].messages.slice(before).some(message => message.type === 'update'));
      if (action !== 'hide') {
        assert.deepEqual((await snapshot(f.cold(), true)).last_known, {});
        assert.equal(f.storage.values.has('http-live:node'), false);
        assert.equal(agent.messages.some(message => message.type === 'ack'), false);
      }
    } finally { gate.release.resolve(); await pending; await f.storage.drain(); }
  });
}

for (const format of ['report', 'reports']) {
  for (const [value, expected] of [[0, 0], [null, 0], [undefined, 983_000_000_000], [5024_000_000, 5024_000_000]]) {
    test(`Go ${format} envelope basic_info disk_total=${value} clears unknown or preserves known metadata`, async () => {
    const f = fixture();
    const agent = f.agent();
    // Go Report uses nullable pointers, while its backward-compatible BasicInfo
    // struct serializes an unavailable numeric DiskTotal as zero.
    const report = { cpu: 23, disk: null, disk_total: value > 0 ? value : null, uptime: null, timestamp: f.now,
      basic_info: { cpu_name: 'Fixture CPU', virtualization: 'lxc', arch: 'amd64', cpu_cores: 1,
        os: 'Linux', kernel_version: 'fixture', gpu_name: '', version: 'fixture', mem_total: 512_000_000,
        swap_total: 0, uptime: 0, ...(value === undefined ? {} : { disk_total: value }) } };
    const envelope = format === 'reports' ? { type: format, reports: [{ cpu: 11 }, report] } : { type: format, data: report };
    await f.object.webSocketMessage(agent.ws, JSON.stringify(envelope));
    await f.storage.drain();
    const stored = await (await f.object.fetch(new Request('https://do/admin-clients-snapshot'))).json();
    assert.equal(stored.clients[0].disk_total, expected);
    assert.ok(agent.messages.some(message => message.type === 'ack'));
    if (value === null || value === 0) assert.ok(f.patches.some(patch => patch.disk_total === 0));
    });
  }
}

function queuedBatchFixture({ failProbe = false } = {}) {
  const started = deferred();
  const release = deferred();
  let pause = true;
  const f = fixture({ controls: [node, { ...node, uuid: 'other' }], dbOverrides: {
    getSettingsByKeys: async (_database, keys) => {
      if (pause && keys.includes('record_enabled')) {
        pause = false;
        started.resolve();
        await release.promise;
      }
      return { record_enabled: String(failProbe) };
    },
    listPingTasks: async () => [{ id: 1, name: 'Fixture probe', all_clients: true, clients: [], interval_sec: 120 }],
    getHistoryStorageRowCounts: async () => ({ records: 0, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0 }),
    getHistoryStorageBytes: async () => ({ total: 0 }),
    getHistoryStorageUsage: async () => ({ live_rows: 0, estimated_live_storage_bytes: 0 }),
    insertPingSnapshot: async () => { if (failProbe) throw new Error('Synthetic required Ping snapshot failure'); },
    insertRecord: async () => {}, insertGPURecords: async () => {},
  } });
  const writes = [];
  const put = f.storage.state.storage.put;
  f.storage.state.storage.put = async (key, value) => {
    if (typeof key === 'string' && key.startsWith('http-live:')) writes.push({ uuid: value.uuid, cpu: value.lastReport.cpu });
    return put(key, value);
  };
  return { ...f, get now() { return f.now; }, started, release, writes };
}

function submitReports(f, transport, reports, agent, uuid = 'node') {
  if (transport === 'http') return control(f.object, 'client-report', {
    uuid, name: 'Managed node', ttl_ms: 180000, ...(reports.length === 1 ? { report: reports[0] } : { reports }),
  });
  return f.object.webSocketMessage(agent.ws, JSON.stringify(reports.length === 1
    ? { type: 'report', data: reports[0] } : { type: 'reports', reports }));
}

function blockedReports(f, cpu = 99) {
  return [{ cpu: 11, timestamp: f.now, ping_results: [{ task_id: 1, value: 20 }] }, { cpu, timestamp: f.now }];
}

async function expireAndRead(f, object = f.object) {
  for (const socket of f.storage.sockets) {
    if (socket.deserializeAttachment()?.role !== 'agent') continue;
    socket.close();
    await object.webSocketClose(socket);
  }
  f.advance(180001);
  await object.alarm();
  return snapshot(f.cold(), true);
}

for (const transport of ['http', 'websocket']) for (const action of ['restore', 'remove', 'keepMetadata']) {
  test(`whole ${transport} batch cannot survive ${action} while its first Ping waits`, async () => {
    const f = queuedBatchFixture();
    const agent = f.agent();
    const pending = submitReports(f, transport, blockedReports(f), agent);
    const settled = pending.then(value => ({ value }), error => ({ error }));
    try {
      await Promise.race([f.started.promise, settled.then(() => { throw new Error('The batch did not reach its first external probe wait'); })]);
      if (action === 'restore') await control(f.object, 'clients-restore', { clients: [node] });
      else await control(f.object, 'client-remove', { uuid: 'node', ...(action === 'keepMetadata' ? { keepMetadata: true } : {}) });
      assert.deepEqual((await snapshot(f.object, true)).last_known, {});
      const before = f.viewers[0].messages.length;
      f.release.resolve();
      const result = await settled;
      await f.storage.drain();
      assert.deepEqual((await snapshot(f.object, true)).online, []);
      assert.deepEqual((await snapshot(f.cold(), true)).last_known, {});
      assert.equal(f.storage.values.has('http-live:node'), false);
      assert.ok(!f.viewers[0].messages.slice(before).some(message => message.type === 'update' || message.reason === 'offline'));
      if (transport === 'http') assert.ok(result.error || result.value.status >= 400, 'a retired batch cannot report HTTP success');
      else assert.equal(agent.messages.some(message => message.type === 'ack'), false);
    } finally { f.release.resolve(); await settled; await f.storage.drain(); }
  });
}

for (const first of ['http', 'websocket']) {
  const second = first === 'http' ? 'websocket' : 'http';
  test(`whole-batch reservation orders older ${first} before newer ${second} through persistence and ACK`, async () => {
    const f = queuedBatchFixture();
    const agent = f.agent();
    const firstAt = f.now;
    const initial = submitReports(f, first, blockedReports(f, 12), agent);
    let latest;
    try {
      await f.started.promise;
      f.advance(1000);
      const latestAt = f.now;
      let secondCompleted = false;
      latest = submitReports(f, second, [{ cpu: 88, timestamp: latestAt }], agent).then(value => { secondCompleted = true; return value; });
      await new Promise(resolve => setImmediate(resolve));
      const completedBeforeRelease = secondCompleted;
      f.release.resolve();
      const values = await Promise.all([initial, latest]);
      await f.storage.drain();
      const live = await snapshot(f.object, true);
      assert.equal(live.data.node.cpu, 88);
      assert.equal(live.data.node.lastReportTime, latestAt);
      assert.equal(completedBeforeRelease, false, 'the newer same-node receipt must wait for the earlier full batch');
      assert.deepEqual(f.writes.filter(write => write.uuid === 'node').map(write => write.cpu), [12, 88], 'one final live write per batch, in receipt order');
      assert.deepEqual(f.viewers[0].messages.filter(message => message.type === 'update').map(message => message.data.cpu), [12, 88]);
      const acknowledgements = agent.messages.filter(message => message.type === 'ack');
      assert.deepEqual(acknowledgements.map(message => message.timestamp), [first === 'websocket' ? firstAt : latestAt]);
      assert.equal(values[first === 'http' ? 0 : 1].status, 200);
      assert.equal((await expireAndRead(f)).last_known.node.cpu, 88);
    } finally { f.release.resolve(); await Promise.allSettled([initial, ...(latest ? [latest] : [])]); await f.storage.drain(); }
  });
}

test('a full batch waiting for a probe does not block another node', async () => {
  const f = queuedBatchFixture();
  const agent = f.agent();
  const initial = submitReports(f, 'http', blockedReports(f), agent);
  let deadline;
  try {
    await f.started.promise;
    const response = await Promise.race([
      submitReports(f, 'http', [{ cpu: 55, timestamp: f.now }], undefined, 'other'),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('An unrelated node was serialized behind a probe')), 1500); }),
    ]);
    assert.equal(response.status, 200);
    assert.equal((await snapshot(f.object)).data.other.cpu, 55);
  } finally { clearTimeout(deadline); f.release.resolve(); await initial; await f.storage.drain(); }
});

for (const first of ['http', 'websocket']) {
  test(`a failed ${first} batch releases its reservation for a later acknowledged WebSocket report`, async () => {
    const f = queuedBatchFixture({ failProbe: true });
    const agent = f.agent();
    const initial = submitReports(f, first, blockedReports(f), agent);
    const settled = initial.then(value => ({ value }), error => ({ error }));
    let next;
    try {
      await f.started.promise;
      f.advance(1000);
      const nextAt = f.now;
      next = submitReports(f, 'websocket', [{ cpu: 66, timestamp: nextAt }], agent);
      await new Promise(resolve => setImmediate(resolve));
      f.release.resolve();
      const failed = await settled;
      await next;
      await f.storage.drain();
      if (first === 'http') assert.ok(failed.error || failed.value.status >= 400);
      assert.deepEqual(agent.messages.filter(message => message.type === 'ack').map(message => message.timestamp), [nextAt]);
      assert.equal((await snapshot(f.object)).data.node.cpu, 66);
      assert.deepEqual(f.writes.filter(write => write.uuid === 'node').map(write => write.cpu), [66]);
    } finally { f.release.resolve(); await settled; if (next) await next; await f.storage.drain(); }
  });
}

test('restore retires an old socket batch while a new socket receives only its own successful ACK', async () => {
  const f = queuedBatchFixture();
  const oldSocket = f.agent();
  const oldBatch = submitReports(f, 'websocket', blockedReports(f), oldSocket);
  let newBatch;
  try {
    await f.started.promise;
    await control(f.object, 'clients-restore', { clients: [node] });
    f.advance(1000);
    const newSocket = f.agent();
    newBatch = submitReports(f, 'websocket', [{ cpu: 77, timestamp: f.now }], newSocket);
    f.release.resolve();
    await Promise.all([oldBatch, newBatch]);
    await f.storage.drain();
    assert.equal(oldSocket.messages.some(message => message.type === 'ack'), false);
    assert.deepEqual(newSocket.messages.filter(message => message.type === 'ack').map(message => message.timestamp), [f.now]);
    assert.deepEqual(f.writes.filter(write => write.uuid === 'node').map(write => write.cpu), [77]);
    assert.equal((await expireAndRead(f)).last_known.node.cpu, 77);
  } finally { f.release.resolve(); await oldBatch; if (newBatch) await newBatch; await f.storage.drain(); }
});
