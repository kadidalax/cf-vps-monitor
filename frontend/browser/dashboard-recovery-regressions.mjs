import assert from 'node:assert/strict';
import { createHarness, deadline, deferred, settleCall, settleRender } from './helpers/harness.mjs';

const moduleFlag = process.argv.indexOf('--playwright-module');
const { origin, check, finish } = await createHarness({
  selection: process.argv[2] || 'ALL',
  playwrightModule: moduleFlag >= 0 ? process.argv[moduleFlag + 1] : process.env.CF_MONITOR_PLAYWRIGHT_MODULE,
});

function snapshot(clients, version) {
  const now = Date.now();
  const record = { cpu: 47, ram: 32_000_000, ram_total: 128_000_000, swap: 0, swap_total: 0,
    disk: 300_000_000, disk_total: 1_024_000_000, disk_source: 'directory', disk_sampled_at: now - 60_000,
    net_in: 0, net_out: 0, net_total_up: 0, net_total_down: 0, load: null, temp: null, uptime: 1000,
    process_count: 3, connections: 1, connections_udp: 0 };
  return { online: clients.map(client => client.uuid),
    clients: clients.map(client => ({ uuid: client.uuid, name: client.name, lastReportTime: now })),
    data: Object.fromEntries(clients.map(client => [client.uuid, record])), last_known: {},
    timestamp: now, count: clients.length, metadata_version: version };
}

try {
  for (const result of ['success', 'failure', 'empty', 'malformed']) {
    await check(`RECOVERY-${result}`, 'expired background viewers retain cards during metadata revalidation', async (page, data, context) => {
      data.authenticated = false;
      const base = data.clients[0];
      data.clients = [
        { ...base, uuid: 'node-a', name: 'First', sort_order: 0 },
        { ...base, uuid: 'node-b', name: '香港123', sort_order: 1 },
        { ...base, uuid: 'node-c', name: 'Third', sort_order: 2 },
      ];
      let version = 'synthetic-v1';
      let revalidating = false;
      const refreshFails = result === 'failure' || result === 'malformed';
      const release = deferred();
      const entered = deferred();
      const closed = deferred();
      const sockets = [];
      const heldCalls = [];
      data.handlers.push(async ({ path, call, json }) => {
        if (path === '/api/ws/live-token') { await json({ token: 'synthetic-token', expires_at: Date.now() + 60_000 }); return true; }
        if (path === '/api/live/clients') { await json(snapshot(data.clients, version)); return true; }
        if (path !== '/api/public/bootstrap') return false;
        if (revalidating) {
          heldCalls.push(call);
          entered.resolve(call);
          await release.promise;
          if (result === 'failure') { await json({ error: 'Synthetic refresh failed' }, 503); return true; }
          if (result === 'malformed') { await json({ clients: { error: 'Synthetic malformed list' }, settings: data.settings }); return true; }
        }
        await json({ clients: data.clients, settings: data.settings, live: snapshot(data.clients, version), metadata_version: version });
        return true;
      });
      await context.routeWebSocket('**/api/ws/live*', socket => {
        sockets.push(socket);
        socket.onClose(() => closed.resolve());
        socket.send(JSON.stringify({ type: 'snapshot', ...snapshot(data.clients, version) }));
      });
      await context.addInitScript(() => {
        window.recoveryHidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.recoveryHidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.recoveryHidden ? 'hidden' : 'visible' });
      });
      try {
        await page.goto(origin + '/');
        await page.waitForFunction(() => document.querySelectorAll('.node-card').length === 3);
        await settleRender(page);
        await page.evaluate(async () => {
          window.recoveryCards = [...document.querySelectorAll('.node-card')];
          window.recoveryCounts = [];
          window.recoveryInvalidations = 0;
          (await import('/src/utils/publicDataEvents.ts')).subscribePublicDataUpdated(() => { window.recoveryInvalidations += 1; });
          window.recoveryObserver = new MutationObserver(() => window.recoveryCounts.push(document.querySelectorAll('.node-card').length));
          window.recoveryObserver.observe(document.querySelector('.node-display-shell'), { childList: true, subtree: true });
          window.recoveryHidden = true;
          document.dispatchEvent(new Event('visibilitychange'));
        });
        const beforeHidden = data.calls.length;
        const connectionsBeforeHidden = sockets.length;
        sockets.at(-1).send(JSON.stringify({ type: 'viewer_expired', timestamp: Date.now() }));
        await deadline(closed.promise, 'hidden viewer closes without renewal');
        await settleRender(page);
        const hiddenRequests = data.calls.slice(beforeHidden).filter(call => call.path === '/api/ws/live-token' || call.path === '/api/live/clients');

        version = 'synthetic-v2';
        revalidating = true;
        const beforeResume = data.calls.length;
        await page.evaluate(() => {
          window.recoveryHidden = false;
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await deadline(entered.promise, 'resume starts the existing metadata read');
        await page.waitForFunction(() => window.recoveryInvalidations > 0);
        await settleRender(page);
        const during = await page.evaluate(() => ({
          ids: [...document.querySelectorAll('.node-card')].map(card => card.id),
          sameElements: window.recoveryCards.every(card => card.isConnected),
          unavailable: document.querySelector('.node-display-shell').textContent.includes('节点数据不可用'),
          counts: [...window.recoveryCounts],
        }));
        // Real focus often follows visibilitychange. A connected viewer must not
        // introduce another renewal just because focus also fires.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        if (result === 'empty') data.clients = [];
        if (result === 'success') data.clients[1].name = '香港123 updated';
        if (refreshFails) data.failures['/api/clients'] = { status: 503, error: 'Synthetic list failed' };
        release.resolve();
        for (const call of heldCalls) await settleCall(page, call);
        if (result === 'empty') await page.getByText('暂无节点数据', { exact: true }).waitFor();
        if (result === 'success') await page.locator('#node-b .node-card-title-row').getByText('香港123 updated', { exact: true }).waitFor();
        if (result === 'malformed') {
          await settleRender(page);
          assert.deepEqual(await page.locator('.node-card').evaluateAll(cards => cards.map(card => card.id)),
            ['node-a', 'node-b', 'node-c'], 'a malformed HTTP 200 list must not clear confirmed cards');
        }
        if (refreshFails) await page.getByRole('alert').filter({ hasText: '无法连接 Worker API' }).waitFor();
        await settleRender(page);
        const after = await page.locator('.node-card').evaluateAll(cards => cards.map(card => card.id));
        const resumeCalls = data.calls.slice(beforeResume);
        data.observed = { during, after, hiddenRequests, connectionsBeforeHidden, connectionsAfter: sockets.length,
          resumeRequests: resumeCalls.map(call => call.path + call.search) };
        assert.deepEqual(hiddenRequests, [], 'hidden viewer expiry must not renew or poll');
        assert.deepEqual(during.ids, ['node-a', 'node-b', 'node-c'], 'returning to the page must not blank confirmed nodes');
        assert.equal(during.sameElements, true, 'retaining the actual cards also avoids their per-card effects restarting');
        assert.equal(during.unavailable, false);
        assert.equal(during.counts.includes(0), false, 'no rendered empty-list frame is allowed during revalidation');
        assert.deepEqual(after, result === 'empty' ? [] : ['node-a', 'node-b', 'node-c']);
        assert.equal(sockets.length, connectionsBeforeHidden + 1, 'resume/focus uses one replacement socket');
        assert.equal(resumeCalls.filter(call => call.path === '/api/ws/live-token').length, 1);
        assert.ok(resumeCalls.filter(call => call.path === '/api/public/bootstrap').length <= (refreshFails ? 3 : 2),
          'resume and metadata validation must stay within the existing coalesced refresh/fallback budget');
        assert.equal(resumeCalls.filter(call => call.path === '/api/clients').length, refreshFails ? 1 : 0);
        assert.ok(resumeCalls.length <= (refreshFails ? 7 : 5), 'recovery must not add per-card reads or another request loop');
      } finally { release.resolve(); }
    });
  }
} finally { await finish(); }
