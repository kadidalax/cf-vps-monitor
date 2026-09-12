import assert from 'node:assert/strict';
import { createHarness, deadline, deferred, settleCall, settleRender } from './helpers/harness.mjs';

const moduleFlag = process.argv.indexOf('--playwright-module');
const { origin, check, finish } = await createHarness({
  selection: process.argv[2] || 'ALL',
  playwrightModule: moduleFlag >= 0 ? process.argv[moduleFlag + 1] : process.env.CF_MONITOR_PLAYWRIGHT_MODULE,
});

function fourClients(data) {
  const base = data.clients[0];
  data.clients = [
    { ...base, uuid: 'node-a', name: 'Zulu Server', sort_order: 0 },
    { ...base, uuid: 'node-b', name: '香港123', sort_order: 1 },
    { ...base, uuid: 'node-c', name: 'Alpha Server', sort_order: 2 },
    { ...base, uuid: 'node-d', name: 'Beta Server', sort_order: 3 },
  ];
}

function snapshot(data, online = data.clients.map(client => client.uuid), cpu = 47) {
  const now = Date.now();
  const record = { cpu, ram: 1073741824, ram_total: 2147483648, swap: 0, swap_total: 0, disk: 5368709120, disk_total: 10737418240, load: 0.5, temp: 0, net_in: 1048576, net_out: 2097152, net_total_up: 10737418240, net_total_down: 21474836480, uptime: 43200, process_count: 12, connections: 4, connections_udp: 0 };
  return {
    online,
    clients: online.map(uuid => ({ uuid, name: data.clients.find(client => client.uuid === uuid).name, lastReportTime: now })),
    data: Object.fromEntries(online.map(uuid => [uuid, { ...record }])),
    count: online.length,
    timestamp: now,
    metadata_version: 'synthetic-v1',
  };
}

async function cardOrder(page) {
  return page.locator('.node-card').evaluateAll(cards => cards.map(card => card.id));
}

try {
  await check('NODE-return-order', 'returning from detail never renders report-arrival order', async (page, data, context) => {
    fourClients(data);
    const sockets = [];
    await context.routeWebSocket('**/api/ws/live*', socket => {
      sockets.push(socket);
      socket.send(JSON.stringify({ type: 'snapshot', ...snapshot(data) }));
    });
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => { window.nodeStateLastMessage = JSON.parse(event.data); });
        }
      };
    });
    const entered = deferred();
    const release = deferred();
    let holdBootstrap = false;
    data.handlers.push(async ({ path, call, json }) => {
      if (path === '/api/ws/live-token') { await json({ token: 'synthetic-token', expires_at: Date.now() + 60000 }); return true; }
      if (path === '/api/public/bootstrap' && holdBootstrap) {
        entered.resolve(call);
        await release.promise;
        await json({ clients: data.clients, settings: data.settings, live: snapshot(data), metadata_version: 'synthetic-v1' });
        return true;
      }
      return false;
    });
    try {
      await page.goto(origin + '/');
      await page.waitForFunction(() => document.querySelectorAll('.node-card').length === 4 && document.querySelector('#node-a .node-card-title-row')?.textContent.includes('Zulu'));
      const before = await cardOrder(page);
      await page.locator('#node-b .node-card-link').click();
      await page.locator('.instance-page').waitFor();
      const timestamp = Date.now();
      sockets.at(-1).send(JSON.stringify({ type: 'update', client: 'node-b', name: '香港123', data: { cpu: 77 }, timestamp }));
      await page.waitForFunction(timestamp => window.nodeStateLastMessage?.timestamp === timestamp, timestamp);
      await settleRender(page);
      holdBootstrap = true;
      await page.getByRole('button', { name: '返回', exact: true }).click();
      await page.locator('.monitor-dashboard-page').waitFor();
      const heldCall = await deadline(entered.promise, 'return bootstrap begins');
      await settleRender(page);
      const during = await cardOrder(page);
      const duringText = await page.locator('#node-b').innerText();
      release.resolve();
      await settleCall(page, heldCall);
      const after = await cardOrder(page);
      data.observed = { before, during, after, duringText, socketCount: sockets.length, publicCache: await page.evaluate(() => localStorage.getItem('cf_monitor_public_bootstrap')) };
      assert.deepEqual(during, before, 'NODE-return-order: returning must retain the confirmed manual order before metadata reload completes');
      assert.deepEqual(after, before);
    } finally { release.resolve(); }
  });

  await check('NODE-offline-last-values', 'offline cards keep their last measurement and explain its age', async (page, data, context) => {
    fourClients(data);
    const socketReady = deferred();
    await context.routeWebSocket('**/api/ws/live*', socket => socketReady.resolve(socket));
    data.handlers.push(async ({ path, json }) => {
      if (path === '/api/ws/live-token') { await json({ token: 'synthetic-token', expires_at: Date.now() + 60000 }); return true; }
      if (path === '/api/public/bootstrap') { await json({ clients: data.clients, settings: data.settings, live: snapshot(data) }); return true; }
      if (path === '/api/live/clients') { await json(snapshot(data)); return true; }
      return false;
    });
    await page.goto(origin + '/');
    const socket = await deadline(socketReady.promise, 'live socket opens');
    await page.locator('#node-b .node-resource-ring-chart').getByText('47%', { exact: true }).waitFor();
    const before = await page.locator('#node-b').innerText();
    const last = snapshot(data);
    socket.send(JSON.stringify({ type: 'snapshot', ...snapshot(data, ['node-a', 'node-c', 'node-d']), last_known: { 'node-b': { ...last.data['node-b'], ...last.clients.find(client => client.uuid === 'node-b') } } }));
    await page.locator('#node-b').getByText('离线', { exact: true }).waitFor();
    await settleRender(page);
    const after = await page.locator('#node-b').innerText();
    data.observed = { before, after, order: await cardOrder(page) };
    assert.equal(await page.locator('#node-b .node-resource-ring-chart').getByText('47%', { exact: true }).count(), 1, 'NODE-offline-last-values: confirmed offline does not turn the last CPU reading into zero');
    assert.match(after, /最后上报|最后状态|最后采样/);
    assert.equal((await cardOrder(page)).at(-1), 'node-b');
  });

  await check('NODE-offline-stable-groups', 'offline-last preserves manual order inside each group', async (page, data, context) => {
    fourClients(data);
    await context.addInitScript(() => localStorage.setItem('offlineServerPosition', 'last'));
    const live = snapshot(data, ['node-a', 'node-b', 'node-d']);
    data.handlers.push(async ({ path, json }) => {
      if (path === '/api/public/bootstrap') { await json({ clients: data.clients, settings: data.settings, live }); return true; }
      if (path === '/api/live/clients') { await json(live); return true; }
      return false;
    });
    await page.goto(origin + '/');
    await page.locator('#node-c').getByText('离线', { exact: true }).waitFor();
    await page.locator('#node-a .node-card-title-row').getByText('Zulu Server', { exact: true }).waitFor();
    await settleRender(page);
    data.observed = { gridOrder: await cardOrder(page) };
    await page.getByRole('button', { name: '表格视图', exact: true }).click();
    await page.locator('.node-table-root').waitFor();
    data.observed.tableOrder = await page.locator('.node-table-root a[href^="/instance/"]').evaluateAll(links => links.map(link => link.getAttribute('href').split('/').at(-1)));
    assert.deepEqual(data.observed.gridOrder, ['node-a', 'node-b', 'node-d', 'node-c'], 'NODE-offline-stable-groups: grouping by status must not alphabetize manually ordered peers');
    assert.deepEqual(data.observed.tableOrder, ['node-a', 'node-b', 'node-d', 'node-c'], 'NODE-offline-stable-groups: the table must keep offline rows last');
  });

  await check('NODE-confirmed-removal', 'an authorized metadata removal cannot revive the final node from live fallback', async (page, data) => {
    data.authenticated = false;
    await page.goto(origin + '/');
    await page.locator('#node-a .node-card-title-row').getByText('Alpha Server', { exact: true }).waitFor();
    await page.evaluate(async () => {
      const { notifyPublicDataUpdated } = await import('/src/utils/publicDataEvents.ts');
      notifyPublicDataUpdated({ clients: { remove: ['node-a'] } });
    });
    await settleRender(page);
    data.observed = { remainingCards: await cardOrder(page), publicCache: await page.evaluate(async () => (await import('/src/utils/publicBootstrap.ts')).getCachedPublicBootstrap()?.clients) };
    assert.deepEqual(data.observed.publicCache, [], 'Fixture: the final authorized public client was removed');
    assert.equal(await page.locator('.node-card').count(), 0, 'NODE-confirmed-removal: a successful empty metadata list takes precedence over a prior live list');
  });
  await check('NODE-cold-offline', 'a new visitor sees offline last readings consistently across grid, table and detail', async (page, data) => {
    fourClients(data);
    data.authenticated = false;
    const prior = snapshot(data);
    const last = { ...prior.data['node-b'], ...prior.clients.find(client => client.uuid === 'node-b'), lastReportTime: Date.now() - 3600000 };
    const live = { ...snapshot(data, ['node-a', 'node-c', 'node-d']), last_known: { 'node-b': last } };
    data.handlers.push(async ({ path, json }) => {
      if (path === '/api/public/bootstrap') { await json({ clients: data.clients, settings: data.settings, live }); return true; }
      if (path === '/api/live/clients') { await json(live); return true; }
      return false;
    });
    await page.goto(origin + '/');
    await page.locator('#node-b').getByText('离线', { exact: true }).waitFor();
    await page.locator('#node-b .node-resource-ring-chart').getByText('47%', { exact: true }).waitFor();
    data.observed = { gridOrder: await cardOrder(page), card: await page.locator('#node-b').innerText() };
    assert.deepEqual(data.observed.gridOrder, ['node-a', 'node-c', 'node-d', 'node-b']);
    assert.match(data.observed.card, /最后上报/);
    assert.match(data.observed.card, /上报时网速/);
    await page.getByRole('button', { name: '表格视图', exact: true }).click();
    const row = page.locator('.node-table-root a[href="/instance/node-b"]').locator('xpath=ancestor::tr');
    await row.waitFor();
    assert.match(await row.locator('.node-table-resource-cell').first().innerText(), /47\.0%/);
    assert.match(await row.innerText(), /最后上报/);
    await row.locator('a[href="/instance/node-b"]').click();
    await page.locator('.instance-top-summary').waitFor();
    data.observed.detail = await page.locator('.instance-top-summary').innerText();
    assert.match(data.observed.detail, /离线/);
    assert.match(data.observed.detail, /最后上报/);
    assert.equal(await page.locator('.instance-top-summary .rt-Badge[data-accent-color="green"]').count(), 0, 'last uptime must not make an offline node appear online');
  });

  await check('NODE-initial-unknown', 'an initial pending full live read is not an offline verdict', async (page, data) => {
    fourClients(data);
    data.authenticated = false;
    const entered = deferred();
    const release = deferred();
    data.handlers.push(async ({ path, call, json }) => {
      if (path === '/api/public/bootstrap') { await json({ clients: data.clients, settings: data.settings }); return true; }
      if (path === '/api/live/clients') { entered.resolve(call); await release.promise; await json(snapshot(data)); return true; }
      return false;
    });
    try {
      await page.goto(origin + '/');
      const heldCall = await deadline(entered.promise, 'initial full live read starts');
      await page.locator('#node-a .node-card-title-row').waitFor();
      await settleRender(page);
      data.observed = { orderBefore: await cardOrder(page), cardBefore: await page.locator('#node-a').innerText() };
      assert.equal(await page.locator('.node-card').getByText('离线', { exact: true }).count(), 0, 'unseen nodes remain unknown until a complete snapshot');
      assert.equal(await page.locator('.node-card').getByText('确认中', { exact: true }).count(), 4);
      assert.deepEqual(data.observed.orderBefore, ['node-a', 'node-b', 'node-c', 'node-d']);
      release.resolve();
      await settleCall(page, heldCall);
      await page.locator('#node-a').getByText('在线', { exact: true }).waitFor();
      assert.deepEqual(await cardOrder(page), data.observed.orderBefore);
    } finally { release.resolve(); }
  });

  await check('NODE-auth-last-known', 'an obsolete administrator read cannot restore private metadata or last readings', async (page, data) => {
    data.clients.push({ ...data.clients[0], uuid: 'private-node', name: 'Private offline node', hidden: true, sort_order: 1 });
    const entered = deferred();
    const release = deferred();
    let holdPrivate = false;
    data.handlers.push(async ({ path, url, call, json }) => {
      if (path !== '/api/public/bootstrap' && path !== '/api/live/clients') return false;
      const includeHidden = url.searchParams.has('include_hidden');
      const clients = data.clients.filter(client => includeHidden || !client.hidden);
      const live = { ...snapshot(data, ['node-a']), last_known: includeHidden ? { 'private-node': { uuid: 'private-node', name: 'Private offline node', cpu: 91, lastReportTime: Date.now() - 60000 } } : {} };
      if (path === '/api/live/clients' && includeHidden && holdPrivate) { entered.resolve(call); await release.promise; }
      await json(path === '/api/public/bootstrap' ? { clients, settings: data.settings, live } : live);
      return true;
    });
    try {
      await page.goto(origin + '/test/browser-fixture.html');
      await page.evaluate(() => window.mountAuditFixture('live'));
      await page.waitForFunction(() => JSON.parse(document.querySelector('#live-result').textContent).liveData?.last_known?.['private-node']?.cpu === 91);
      holdPrivate = true;
      await page.locator('#live-refresh').click();
      const oldCall = await deadline(entered.promise, 'private read starts');
      data.authenticated = false;
      await page.locator('#live-clear-auth').click();
      await page.waitForFunction(() => {
        const state = JSON.parse(document.querySelector('#live-result').textContent);
        return state.snapshotReady && state.clientMetadata?.length === 1 && !state.liveData?.last_known?.['private-node'];
      });
      release.resolve();
      await settleCall(page, oldCall);
      const state = JSON.parse(await page.locator('#live-result').textContent());
      data.observed = state;
      assert.equal(state.liveData.last_known['private-node'], undefined);
      assert.equal(state.clientMetadata.some(client => client.uuid === 'private-node'), false);
      assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes('Private offline node')), false);
    } finally { release.resolve(); }
  });

  await check('NODE-last-known-removal', 'removed and newly hidden offline nodes cannot return from their old last snapshots', async (page, data, context) => {
    data.authenticated = false;
    data.clients.push({ ...data.clients[0], uuid: 'node-b', name: 'Beta Server', sort_order: 1 });
    const original = snapshot(data);
    const known = Object.fromEntries(original.clients.map(client => [client.uuid, { ...original.data[client.uuid], ...client }]));
    const socketReady = deferred();
    await context.routeWebSocket('**/api/ws/live*', socket => socketReady.resolve(socket));
    data.handlers.push(async ({ path, json }) => {
      if (path === '/api/ws/live-token') { await json({ token: 'synthetic-token', expires_at: Date.now() + 60000 }); return true; }
      if (path !== '/api/public/bootstrap' && path !== '/api/live/clients') return false;
      const clients = data.clients.filter(client => !client.hidden);
      const live = { online: [], clients: [], data: {}, count: 0, timestamp: Date.now(), last_known: Object.fromEntries(clients.map(client => [client.uuid, known[client.uuid]])) };
      await json(path === '/api/public/bootstrap' ? { clients, settings: data.settings, live } : live);
      return true;
    });
    await page.goto(origin + '/');
    const socket = await deadline(socketReady.promise, 'offline metadata socket');
    await page.locator('#node-a').getByText('离线', { exact: true }).waitFor();
    data.clients = data.clients.filter(client => client.uuid !== 'node-a');
    socket.send(JSON.stringify({ type: 'metadata_changed', clients: { remove: ['node-a'] }, timestamp: Date.now() }));
    await page.locator('#node-a').waitFor({ state: 'detached' });
    socket.send(JSON.stringify({ type: 'snapshot', online: [], clients: [], data: {}, count: 0, timestamp: Date.now(), last_known: known }));
    await settleRender(page);
    assert.equal(await page.locator('#node-a').count(), 0, 'a removed metadata row has priority over stale last-known content');
    data.clients[0].hidden = true;
    socket.send(JSON.stringify({ type: 'metadata_changed', clients: { upsert: [{ uuid: 'node-b', hidden: true }] }, timestamp: Date.now() }));
    await page.locator('#node-b').waitFor({ state: 'detached' });
    await page.getByText('暂无节点数据', { exact: true }).waitFor();
    data.observed = { cards: await cardOrder(page) };
    assert.deepEqual(data.observed.cards, []);
  });

  for (const kind of ['unknown', 'capacity-only', 'zero']) {
    await check(`NODE-metrics-${kind}`, 'cards, tables and detail agree on measured zero versus unavailable disk and uptime', async (page, data) => {
      data.clients[0].disk_total = 983 * 1024 ** 3;
      const live = snapshot(data);
      Object.assign(live.data['node-a'], {
        disk: kind === 'zero' ? 0 : null,
        disk_total: kind === 'unknown' ? null : 5 * 1024 ** 3,
        uptime: kind === 'zero' ? 0 : null,
      });
      data.handlers.push(async ({ path, json }) => {
        if (path === '/api/public/bootstrap') { await json({ clients: data.clients, settings: data.settings, live }); return true; }
        if (path === '/api/live/clients') { await json(live); return true; }
        return false;
      });
      await page.goto(origin + '/');
      await page.locator('#node-a .node-card-title-row').waitFor();
      await settleRender(page);
      const diskRing = page.locator('#node-a .node-resource-ring').filter({ hasText: 'Disk' });
      data.observed = { card: await page.locator('#node-a').innerText(), ring: await diskRing.innerText() };
      await page.getByRole('button', { name: '表格视图', exact: true }).click();
      const row = page.locator('.node-table-root a[href="/instance/node-a"]').locator('xpath=ancestor::tr');
      await row.waitFor();
      data.observed.tableDisk = await row.locator('.node-table-resource-cell').nth(2).innerText();
      await row.getByRole('button', { name: /展开/ }).click();
      const detail = page.locator('.node-table-expanded');
      await detail.waitFor();
      data.observed.tableDetail = await detail.innerText();
      await row.locator('a[href="/instance/node-a"]').click();
      await page.locator('.instance-top-summary').waitFor();
      data.observed.detail = await page.locator('.instance-top-summary').innerText();
      assert.match(data.observed.ring, kind === 'zero' ? /0\.0%/ : /—/, 'an unknown used amount cannot produce a measured percentage');
      assert.match(data.observed.tableDisk, kind === 'zero' ? /0\.0%/ : /—/);
      assert.equal(data.observed.tableDetail.includes('983'), false, 'explicit live null/known capacity overrides stale metadata');
      assert.equal(data.observed.detail.includes('983'), false);
      if (kind === 'zero') assert.match(data.observed.card, /0s/, 'a real uptime zero remains visible');
      else assert.equal(/已运行 0|在线时长\n0/.test(data.observed.detail + data.observed.card), false, 'unknown uptime does not appear as a fresh restart');
      if (kind === 'capacity-only') assert.match(data.observed.tableDetail, /5\.0 GB/, 'known capacity survives an unavailable used amount');
    });
  }
  await check('NODE-history-disk', 'unknown disk history keeps CPU history and does not draw a zero disk measurement', async (page, data) => {
    const history = [0, 1, 2].map(index => ({ time: new Date(Date.now() - (3 - index) * 60000).toISOString(), cpu: 20 + index, disk: 0, disk_total: 0, uptime: null }));
    data.handlers.push(async ({ path, json }) => {
      if (path !== '/api/records/load') return false;
      await json({ data: history, has_more: false });
      return true;
    });
    await page.goto(origin + '/instance/node-a');
    await page.getByText('3 个数据点', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '磁盘', exact: true }).click();
    await page.getByText('磁盘使用量数据不可用', { exact: true }).waitFor();
    const chart = page.locator('.instance-detail-panel .rt-Card').nth(1);
    assert.equal(await chart.locator('.recharts-line-curve').count(), 0);
    await page.getByRole('tab', { name: 'CPU', exact: true }).click();
    await chart.locator('.recharts-line-curve').waitFor();
    data.observed = { preservedCpuHistory: await chart.locator('.recharts-line-curve').count(), historyCount: history.length };
  });
} finally {
  await finish();
}
