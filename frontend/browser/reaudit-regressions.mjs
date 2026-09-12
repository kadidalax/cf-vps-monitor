import assert from 'node:assert/strict';
import { createHarness, deadline, deferred, settleCall, settleRender, waitForCall } from './helpers/harness.mjs';

const selection = process.argv[2] || 'ALL';
const moduleFlag = process.argv.indexOf('--playwright-module');
const playwrightModule = moduleFlag >= 0 ? process.argv[moduleFlag + 1] : process.env.CF_MONITOR_PLAYWRIGHT_MODULE;
const { origin, check, finish } = await createHarness({ selection, playwrightModule });

try {
  for (const transport of ['broadcast-channel', 'storage']) {
    await check(`R-F01-${transport}`, 'private website addresses never enter public tabs or transport', async (page, data, context) => {
      if (transport === 'storage') await context.addInitScript(() => { window.BroadcastChannel = undefined; });
      data.authenticated = false;
      data.websites[0].hide_url = true;
      await page.goto(origin + '/?view=websites');
      await page.getByText('Synthetic website', { exact: true }).waitFor();
      assert.equal(await page.locator('.kuma-monitor-row a').count(), 0, 'Fixture: public HTTP strips private URLs');
      await page.evaluate(() => {
        window.reauditWebsiteMessages = [];
        if (typeof BroadcastChannel !== 'undefined') {
          window.reauditWebsiteChannel = new BroadcastChannel('cf-monitor:website-monitors-updated');
          window.reauditWebsiteChannel.onmessage = event => window.reauditWebsiteMessages.push(event.data);
        }
        window.addEventListener('storage', event => {
          if (event.key === 'cf-monitor:website-monitors-updated' && event.newValue) window.reauditWebsiteMessages.push(JSON.parse(event.newValue));
        });
      });
      data.authenticated = true;
      const admin = await context.newPage();
      await admin.goto(origin + '/admin/websites');
      await admin.getByRole('button', { name: '编辑', exact: true }).first().click();
      const dialog = admin.getByRole('dialog', { name: '编辑监控', exact: true });
      await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('Renamed private-address monitor');
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByText('Renamed private-address monitor', { exact: true }).waitFor();
      const messages = await page.evaluate(() => window.reauditWebsiteMessages);
      data.observed = { transport, messages, links: await page.locator('.kuma-monitor-row a').evaluateAll(links => links.map(link => link.href)) };
      assert.equal(data.observed.links.length, 0, 'R-F01: hidden addresses must remain absent after an administrator edit');
      assert.equal(messages.length, 1, 'R-F01: one cross-tab message per mutation');
      assert.equal(JSON.stringify(messages).includes('https://synthetic.invalid/private-path'), false, 'R-F01: private URLs must not be serialized into a public event');
      assert.equal(await admin.evaluate(() => localStorage.getItem('cf-monitor:website-monitors-updated')), null, 'R-F01: fallback envelopes are temporary');
      await admin.getByRole('button', { name: '编辑', exact: true }).first().click();
      assert.equal(await admin.getByRole('dialog').getByRole('textbox', { name: '网址', exact: true }).inputValue(), 'https://synthetic.invalid/private-path', 'R-F01: administrators retain the editable address');
    });
  }

  for (const scope of ['general', 'site']) {
    for (const failure of ['server', 'network', 'invalid']) {
      await check(`R-F02-${scope}-${failure}`, 'failed settings initialization cannot unlock default-value saving', async (page, data) => {
        let failing = true;
        data.handlers.push(async ({ path, route, json }) => {
          if (!failing || path !== '/api/admin/settings') return false;
          if (failure === 'network') await route.abort('internetdisconnected');
          else await json(failure === 'invalid' ? [] : { error: 'Synthetic settings read failure' }, failure === 'invalid' ? 200 : 500);
          return true;
        });
        await page.goto(origin + (scope === 'general' ? '/admin/settings/general' : '/admin/settings'));
        const call = await waitForCall(data, call => call.path === '/api/admin/settings' && call.search.includes(`scope=${scope}`));
        await settleCall(page, call);
        await page.locator('.admin-settings-page .loading-spinner').waitFor({ state: 'detached' });
        const save = page.getByRole('button', { name: '保存', exact: true });
        await save.waitFor();
        data.observed = { saveEnabled: await save.isEnabled(), pageErrors: [...data.errors] };
        assert.equal(data.observed.saveEnabled, false, 'R-F02: Save must remain disabled without a successfully loaded baseline');
        assert.ok(await page.getByRole('alert').count() > 0, 'R-F02: initial read failure must remain visible');
        assert.equal(data.calls.filter(call => call.path === '/api/admin/settings' && call.method === 'POST').length, 0);
        failing = false;
        await page.getByRole('button', { name: /重试/ }).click();
        const input = scope === 'general' ? page.getByRole('spinbutton', { name: '历史保留时长（小时）', exact: true }) : page.getByRole('textbox', { name: '站点标题', exact: true });
        await input.waitFor();
        assert.equal(await input.inputValue(), scope === 'general' ? '48' : 'Synthetic Monitor', 'R-F02: retry loads stored settings rather than defaults');
      });
    }
  }

  for (const logoAction of ['reset', 'upload']) {
  await check(`R-F03-${logoAction}`, 'logo updates never promote an unsaved title into the confirmed cache', async (page, data) => {
    data.settings.site_logo_url = '/fixture-old-logo.png';
    await page.goto(origin + '/admin/settings');
    const title = page.getByRole('textbox', { name: '站点标题', exact: true });
    await title.fill('Unsaved draft title');
    if (logoAction === 'reset') {
      await page.getByRole('button', { name: '恢复默认', exact: true }).click();
      await page.getByText('已恢复默认 Logo', { exact: true }).waitFor();
    } else {
      await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
      await page.getByText('Logo 已上传', { exact: true }).waitFor();
    }
    await page.locator('.admin-subnav-row a[href="/admin/settings/general"]').click();
    await page.getByRole('spinbutton', { name: '历史保留时长（小时）', exact: true }).waitFor();
    await page.locator('.admin-subnav-row a[href="/admin/settings"]').click();
    await title.waitFor();
    data.observed = { displayedTitle: await title.inputValue(), savedTitle: data.settings.site_title };
    assert.equal(data.observed.displayedTitle, 'Synthetic Monitor', 'R-F03: leaving the form reloads confirmed settings, not a logo-promoted draft');
    await title.fill('Explicitly saved title');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    assert.equal(data.settings.site_title, 'Explicitly saved title');
  });
  }

  for (const domain of ['clients', 'websites']) {
    await check(`R-F04-${domain}`, 'a stale list refresh cannot overwrite a confirmed edit', async (page, data) => {
      const entered = deferred();
      const release = deferred();
      let armed = false;
      data.handlers.push(async ({ path, url, call, json }) => {
        if (!armed || path !== `/api/admin/${domain}` || !url.searchParams.has('refresh')) return false;
        armed = false;
        const old = structuredClone(data[domain]);
        entered.resolve(call);
        await release.promise;
        await json(old);
        return true;
      });
      try {
        await page.goto(origin + (domain === 'clients' ? '/admin' : '/admin/websites'));
        await page.getByText(domain === 'clients' ? 'Alpha Server' : 'Synthetic website', { exact: true }).first().waitFor();
        armed = true;
        await page.locator('.admin-refresh-button').click();
        const oldCall = await deadline(entered.promise, 'old list refresh starts');
        await page.getByRole('button', { name: '编辑', exact: true }).first().click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('Newest persisted name');
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.getByText('Newest persisted name', { exact: true }).first().waitFor();
        release.resolve();
        await settleCall(page, oldCall);
        data.observed = { persistedName: data[domain][0].name, renderedLatestCount: await page.getByText('Newest persisted name', { exact: true }).count() };
        assert.equal(data.observed.renderedLatestCount, 1, 'R-F04: the confirmed name must survive completion of the older GET');
      } finally { release.resolve(); }
    });
  }

  for (const domain of ['clients', 'websites']) {
    for (const mutation of ['hidden', 'order', 'failed-edit', 'remount', 'rapid-refresh']) {
      await check(`R-F04-${domain}-${mutation}`, 'list ownership preserves confirmed writes and route lifetimes', async (page, data) => {
        const entered = deferred();
        const release = deferred();
        let armed = false;
        if (domain === 'clients') data.clients.push({ ...data.clients[0], uuid: 'node-b', name: 'Beta Server', sort_order: 1 });
        else data.websites.push({ ...data.websites[0], id: 2, name: 'Second website', sort_order: 2 });
        data.handlers.push(async ({ path, url, call, json }) => {
          if (!armed || path !== `/api/admin/${domain}` || !url.searchParams.has('refresh')) return false;
          armed = false;
          const old = structuredClone(data[domain]);
          entered.resolve(call);
          await release.promise;
          await json(old);
          return true;
        });
        const routePath = domain === 'clients' ? '/admin' : '/admin/websites';
        const firstName = domain === 'clients' ? 'Alpha Server' : 'Synthetic website';
        const names = () => page.locator(domain === 'clients' ? '.admin-node-card-name-row .admin-node-name-text' : '.admin-website-table-row .admin-website-name-text');
        try {
          await page.goto(origin + routePath);
          await page.getByText(firstName, { exact: true }).first().waitFor();
          armed = true;
          await page.locator('.admin-refresh-button').click();
          const oldCall = await deadline(entered.promise, 'old list read starts');
          if (mutation === 'hidden') {
            if (domain === 'clients') {
              await page.locator('.admin-node-card').first().getByRole('checkbox').check();
              await page.locator('.admin-selection-inline').getByRole('button', { name: '隐藏', exact: true }).click();
            } else await page.locator('.admin-website-table-row').first().getByRole('button', { name: '隐藏', exact: true }).click();
            await settleCall(page, await waitForCall(data, call => call.path.endsWith(domain === 'clients' ? '/batch-hide' : '/visibility')));
          } else if (mutation === 'order') {
            const drag = page.getByRole('button', { name: `拖拽排序 ${firstName}`, exact: true });
            await drag.focus();
            await page.keyboard.press('Space');
            await settleRender(page);
            await page.keyboard.press(domain === 'clients' ? 'ArrowRight' : 'ArrowDown');
            await settleRender(page);
            await page.keyboard.press('Space');
            await settleCall(page, await waitForCall(data, call => call.path === `/api/admin/${domain}/reorder`));
          } else if (mutation === 'failed-edit') {
            const editPath = domain === 'clients' ? '/api/admin/clients/node-a/edit' : '/api/admin/websites/edit';
            data.failures[`POST ${editPath}`] = 'Synthetic rejected edit';
            await page.getByRole('button', { name: '编辑', exact: true }).first().click();
            const dialog = page.getByRole('dialog');
            await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('Rejected draft');
            await dialog.getByRole('button', { name: '保存', exact: true }).click();
            await settleCall(page, await waitForCall(data, call => call.path === editPath));
            assert.equal(await dialog.isVisible(), true, 'a failed write remains editable');
            await dialog.getByRole('button', { name: '取消', exact: true }).click();
          } else if (mutation === 'rapid-refresh') {
            data[domain][0].name = 'Latest refresh';
            await page.locator('.admin-refresh-button').click();
            await page.getByText('Latest refresh', { exact: true }).first().waitFor();
          } else {
            await page.locator('.admin-sidebar a[href="/admin/account"]').click();
            await page.getByRole('button', { name: '修改用户名', exact: true }).waitFor();
            data[domain][0].name = 'After remount';
            await page.locator(`.admin-sidebar a[href="${routePath}"]`).click();
            await page.getByText('After remount', { exact: true }).first().waitFor();
          }
          release.resolve();
          await settleCall(page, oldCall);
          data.observed = { names: await names().allTextContents(), persisted: data[domain].map(item => ({ name: item.name, hidden: item.hidden })) };
          if (mutation === 'hidden') {
            const row = page.locator(domain === 'clients' ? '.admin-node-card' : '.admin-website-table-row').filter({ hasText: firstName });
            assert.equal(await row.getByText(domain === 'clients' ? '隐藏' : '对游客隐藏', { exact: true }).count(), 1, 'R-F04: confirmed visibility survives an older GET');
          } else if (mutation === 'order') assert.equal(data.observed.names[0], domain === 'clients' ? 'Beta Server' : 'Second website', 'R-F04: confirmed order survives an older GET');
          else assert.equal(data.observed.names[0], mutation === 'remount' ? 'After remount' : mutation === 'rapid-refresh' ? 'Latest refresh' : firstName);
        } finally { release.resolve(); }
      });
    }
  }

  await check('R-F04-public-websites', 'a public website refresh cannot overtake a later invalidation', async (page, data) => {
    data.authenticated = false;
    const entered = deferred();
    const release = deferred();
    let armed = false;
    data.handlers.push(async ({ path, call, json }) => {
      if (!armed || path !== '/api/websites') return false;
      armed = false;
      const old = structuredClone(data.websites);
      entered.resolve(call);
      await release.promise;
      await json(old);
      return true;
    });
    try {
      await page.goto(origin + '/?view=websites');
      await page.getByText('Synthetic website', { exact: true }).waitFor();
      armed = true;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const old = await deadline(entered.promise, 'old public website read starts');
      data.websites[0].name = 'Latest public website';
      await page.evaluate(async () => (await import('/src/utils/websiteMonitorEvents.ts')).notifyWebsiteMonitorsUpdated());
      await page.getByText('Latest public website', { exact: true }).waitFor();
      release.resolve();
      await settleCall(page, old);
      assert.equal(await page.getByText('Latest public website', { exact: true }).count(), 1, 'R-F04: public website requests also honor invalidation order');
    } finally { release.resolve(); }
  });

  for (const scenario of ['late-success', 'late-error', 'reopen', 'close']) {
  await check(`R-F05-${scenario}`, 'late check history stays owned by its original website and dialog lifetime', async (page, data) => {
    data.websites.push({ ...data.websites[0], id: 2, name: 'Second website', url: 'https://second.invalid/' });
    const entered = deferred();
    const release = deferred();
    let first = true;
    data.handlers.push(async ({ path, call, json }) => {
      if (!first || path !== '/api/admin/websites/1/checks') return false;
      first = false;
      entered.resolve(call);
      await release.promise;
      await json(scenario === 'late-error' ? { error: 'Older A history failed' } : [{ checked_at: new Date().toISOString(), ok: true, latency_ms: 111 }], scenario === 'late-error' ? 500 : 200);
      return true;
    });
    data.checks[2] = [{ checked_at: new Date().toISOString(), ok: true, latency_ms: 222 }];
    data.checks[1] = [{ checked_at: new Date().toISOString(), ok: true, latency_ms: 333 }];
    try {
      await page.goto(origin + '/admin/websites');
      await page.locator('tr').filter({ hasText: 'Synthetic website' }).getByRole('button', { name: '编辑', exact: true }).click();
      const oldCall = await deadline(entered.promise, 'website A history starts');
      await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      if (scenario === 'close') {
        release.resolve();
        await settleCall(page, oldCall);
        assert.equal(await page.getByRole('dialog').count(), 0, 'closing the dialog retires its pending history');
      } else {
        await page.locator('tr').filter({ hasText: 'Second website' }).getByRole('button', { name: '编辑', exact: true }).click();
        await page.getByRole('dialog').locator('.website-heartbeat-segment[data-tooltip*="222ms"]').waitFor();
      }
      if (scenario === 'reopen' || scenario === 'close') {
        if (scenario === 'reopen') await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
        await page.locator('tr').filter({ hasText: 'Synthetic website' }).getByRole('button', { name: '编辑', exact: true }).click();
        await settleRender(page);
      }
      const dialog = page.getByRole('dialog');
      if (scenario === 'reopen') await dialog.locator('.website-heartbeat-segment[data-tooltip*="333ms"]').waitFor();
      release.resolve();
      await settleCall(page, oldCall);
      data.observed = { name: await dialog.getByRole('textbox', { name: '名称', exact: true }).inputValue(), checks: await dialog.locator('.website-heartbeat-segment').evaluateAll(elements => elements.map(element => element.dataset.tooltip)) };
      assert.equal(await dialog.locator(`.website-heartbeat-segment[data-tooltip*="${scenario === 'reopen' || scenario === 'close' ? 333 : 222}ms"]`).count(), 1, 'R-F05: history belongs to the current website and opening, including reopen of the same ID');
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'history updates preserve modal focus containment');
    } finally { release.resolve(); }
  });
  }

  await check('R-F05-check-now', 'a late manual check cannot reload another dialog history', async (page, data) => {
    data.websites.push({ ...data.websites[0], id: 2, name: 'Second website' });
    data.checks[1] = [{ checked_at: new Date().toISOString(), ok: true, latency_ms: 111 }];
    data.checks[2] = [{ checked_at: new Date().toISOString(), ok: true, latency_ms: 222 }];
    const entered = deferred();
    const release = deferred();
    data.handlers.push(async ({ path, call, json }) => {
      if (path !== '/api/admin/websites/1/check') return false;
      entered.resolve(call);
      await release.promise;
      await json({ success: true });
      return true;
    });
    try {
      await page.goto(origin + '/admin/websites');
      await page.locator('tr').filter({ hasText: 'Synthetic website' }).getByRole('button', { name: '检测', exact: true }).click();
      const old = await deadline(entered.promise, 'manual check A starts');
      await page.locator('tr').filter({ hasText: 'Second website' }).getByRole('button', { name: '编辑', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('.website-heartbeat-segment[data-tooltip*="222ms"]').waitFor();
      release.resolve();
      await settleCall(page, old);
      await settleRender(page);
      assert.equal(await dialog.locator('.website-heartbeat-segment[data-tooltip*="222ms"]').count(), 1, 'R-F05: A check completion cannot replace B history');
    } finally { release.resolve(); }
  });

  for (const failure of ['server', 'csrf', 'network']) {
  await check(`R-F06-${failure}`, 'failed server logout remains visible and retryable in the administrator view', async (page, data) => {
    let failing = true;
    data.handlers.push(async ({ path, route, json }) => {
      if (!failing || path !== '/api/logout') return false;
      if (failure === 'network') await route.abort('internetdisconnected');
      else await json({ error: 'Synthetic logout failure' }, failure === 'csrf' ? 403 : 500);
      return true;
    });
    await page.goto(origin + '/admin');
    await page.getByText('Alpha Server', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await settleCall(page, await waitForCall(data, call => call.path === '/api/logout'));
    data.observed = { serverSessionActive: data.authenticated, alerts: await page.getByRole('alert').allTextContents(), currentPath: new URL(page.url()).pathname };
    assert.ok(data.observed.alerts.length > 0, 'R-F06: server logout failure must be persistently visible');
    assert.equal(data.observed.serverSessionActive, true);
    assert.equal(data.observed.currentPath, '/admin', 'R-F06: failed logout retains the truthful administrator view');
    failing = false;
    await page.getByRole('alert').getByRole('button', { name: '重试退出', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/login');
    assert.equal(data.authenticated, false, 'R-F06: successful retry ends the server session');
    await page.goto(origin + '/admin');
    await page.waitForURL(url => url.pathname === '/login');
    assert.equal(data.calls.filter(call => call.path === '/api/logout').length, 2, 'retry sends one request and API rejection does not issue another logout');
  });
  }

  await check('R-F06-pending', 'a pending logout is deduplicated before render', async (page, data) => {
    const entered = deferred();
    const release = deferred();
    data.handlers.push(async ({ path, call, json }) => {
      if (path !== '/api/logout') return false;
      entered.resolve(call);
      await release.promise;
      data.authenticated = false;
      await json({ success: true });
      return true;
    });
    try {
      await page.goto(origin + '/admin');
      const logout = page.getByRole('button', { name: '退出登录', exact: true });
      await logout.waitFor();
      await logout.evaluate(button => { button.click(); button.click(); });
      const request = await deadline(entered.promise, 'logout starts');
      await settleRender(page);
      assert.equal(data.calls.filter(call => call.path === '/api/logout').length, 1, 'R-F06: pending logout accepts one submission');
      assert.equal(new URL(page.url()).pathname, '/admin', 'R-F06: navigation waits for server confirmation');
      release.resolve();
      await settleCall(page, request);
      await page.waitForURL(url => url.pathname === '/login');
    } finally { release.resolve(); }
  });

  await check('R-F07', 'GPU history failure keeps a reachable GPU tab and error state', async (page, data) => {
    data.clients[0].gpu_name = 'Synthetic GPU';
    data.failures['GET /api/records/gpu'] = 'Synthetic GPU history failure';
    await page.goto(origin + '/instance/node-a');
    await page.getByRole('heading', { name: 'Alpha Server', exact: true }).waitFor();
    await settleCall(page, await waitForCall(data, call => call.path === '/api/records/gpu'));
    const tab = page.getByRole('tab', { name: 'GPU', exact: true });
    data.observed = { gpuTabCount: await tab.count() };
    assert.equal(data.observed.gpuTabCount, 1, 'R-F07: GPU capability, not successful history, determines the GPU entry');
    await tab.click();
    assert.ok(await page.getByRole('alert').filter({ hasText: /GPU/ }).count() > 0, 'R-F07: GPU read failure is visible in the reachable view');
    assert.ok(await page.getByRole('button', { name: /重试/ }).count() > 0, 'R-F07: the failed read can be retried');
    delete data.failures['GET /api/records/gpu'];
    data.handlers.push(async ({ path, json }) => {
      if (path !== '/api/records/gpu') return false;
      await json({ data: [60_000, 1000].map(ago => ({ time: new Date(Date.now() - ago).toISOString(), utilization: 65, mem_total: 2000, mem_used: 1000, temperature: 40 })), has_more: false });
      return true;
    });
    const after = data.calls.length;
    await page.getByRole('button', { name: /重试/ }).click();
    await settleCall(page, await waitForCall(data, call => call.path === '/api/records/gpu', after));
    assert.equal(await page.getByRole('alert').filter({ hasText: /GPU/ }).count(), 0);
    assert.ok(await page.locator('.recharts-line-curve').count() >= 3, 'R-F07: retry renders the returned GPU series');
    await page.getByRole('tab', { name: 'CPU', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: 'CPU', exact: true }).getAttribute('data-state'), 'active', 'ordinary metrics remain usable');
  });

  for (const capable of [true, false]) {
    await check(`R-F07-${capable ? 'empty' : 'no-gpu'}`, 'GPU capability and empty history have distinct states', async (page, data) => {
      data.clients[0].gpu_name = capable ? 'Synthetic GPU' : '';
      await page.goto(origin + '/instance/node-a');
      await page.getByRole('heading', { name: 'Alpha Server', exact: true }).waitFor();
      if (capable) await settleCall(page, await waitForCall(data, call => call.path === '/api/records/gpu'));
      const tab = page.getByRole('tab', { name: 'GPU', exact: true });
      assert.equal(await tab.count(), capable ? 1 : 0, 'R-F07: tab availability follows node capability');
      if (capable) {
        await tab.click();
        assert.equal(await page.getByRole('status').filter({ hasText: /暂无 GPU/ }).count(), 1, 'R-F07: successful empty GPU history is explicit');
        assert.equal(await page.getByRole('alert').count(), 0);
      } else assert.equal(data.calls.filter(call => call.path === '/api/records/gpu').length, 0);
    });
  }

  await check('R-F07-range', 'pending GPU requests expose loading and retire on a range change', async (page, data) => {
    data.clients[0].gpu_name = 'Synthetic GPU';
    const entered = deferred();
    const release = deferred();
    let first = true;
    data.handlers.push(async ({ path, call, json }) => {
      if (!first || path !== '/api/records/gpu') return false;
      first = false;
      entered.resolve(call);
      await release.promise;
      await json({ error: 'Older range failed' }, 500);
      return true;
    });
    try {
      await page.goto(origin + '/instance/node-a');
      const old = await deadline(entered.promise, 'GPU history starts');
      await page.getByRole('heading', { name: 'Alpha Server', exact: true }).waitFor();
      const tab = page.getByRole('tab', { name: 'GPU', exact: true });
      assert.equal(await tab.count(), 1, 'R-F07: the GPU view is reachable while history is pending');
      await tab.click();
      assert.equal(await page.getByRole('status').filter({ hasText: /加载 GPU/ }).count(), 1);
      const after = data.calls.length;
      await page.getByRole('radio', { name: '4小时', exact: true }).click();
      await settleCall(page, await waitForCall(data, call => call.path === '/api/records/gpu', after));
      await page.getByRole('status').filter({ hasText: /暂无 GPU/ }).waitFor();
      release.resolve();
      await settleCall(page, old);
      assert.equal(await page.getByRole('alert').filter({ hasText: /GPU/ }).count(), 0, 'obsolete GPU errors cannot replace a successful new range');
      assert.equal(await page.getByRole('status').filter({ hasText: /暂无 GPU/ }).count(), 1);
    } finally { release.resolve(); }
  });

  await check('R-F07-node-switch', 'leaving a GPU node restores an available metric on a CPU-only node', async (page, data) => {
    data.clients[0].gpu_name = 'Synthetic GPU';
    data.clients.push({ ...data.clients[0], uuid: 'node-b', name: 'Beta Server', gpu_name: '' });
    const entered = deferred();
    const release = deferred();
    data.handlers.push(async ({ path, call, json }) => {
      if (path !== '/api/records/gpu') return false;
      entered.resolve(call);
      await release.promise;
      await json({ error: 'Older node failed' }, 500);
      return true;
    });
    try {
      await page.goto(origin + '/instance/node-a');
      const old = await deadline(entered.promise, 'GPU read A starts');
      await page.getByRole('heading', { name: 'Alpha Server', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'GPU', exact: true }).click();
      await page.locator('.instance-sidebar-node[title="Beta Server"]').click();
      await page.getByRole('heading', { name: 'Beta Server', exact: true }).waitFor();
      release.resolve();
      await settleCall(page, old);
      assert.equal(await page.getByRole('tab', { name: 'GPU', exact: true }).count(), 0);
      assert.equal(await page.getByRole('tab', { name: 'CPU', exact: true }).getAttribute('data-state'), 'active', 'R-F07: a CPU-only node cannot remain on a now-missing GPU tab');
      assert.equal(await page.getByRole('alert').filter({ hasText: /GPU/ }).count(), 0);
    } finally { release.resolve(); }
  });

  for (const scenario of ['enter', 'enter-click', 'method', 'failure-retry', 'cancel']) {
  await check(`R-F08-${scenario}`, 'MFA verification has one pending owner and resumes the mutation once', async (page, data) => {
    const entered = deferred();
    const release = deferred();
    let verified = false;
    let attempt = 0;
    let writes = 0;
    data.handlers.push(async ({ path, call, json }) => {
      if (path === '/api/admin/account/username') { if (verified) writes += 1; await json(verified ? { success: true } : { error: 'MFA step-up required' }, verified ? 200 : 428); return true; }
      if (path !== '/api/admin/account/mfa/step-up') return false;
      attempt += 1;
      entered.resolve(call);
      await release.promise;
      if (scenario === 'failure-retry' && attempt === 1) { await json({ error: 'Synthetic incorrect code' }, 400); return true; }
      verified = true;
      await json({ success: true });
      return true;
    });
    try {
      await page.goto(origin + '/admin/account');
      await page.getByRole('textbox', { name: '用户名', exact: true }).fill('New username');
      await page.getByRole('button', { name: '修改用户名', exact: true }).click();
      const code = page.locator('#mfa-step-up-code');
      await code.fill('123456');
      await code.press('Enter');
      const first = await deadline(entered.promise, 'first MFA verification starts');
      if (scenario === 'enter') await code.press('Enter');
      if (scenario === 'enter-click') await page.getByRole('dialog').getByRole('button', { name: /验证中|确认/, exact: false }).evaluate(button => button.click());
      if (scenario === 'method') assert.equal(await page.getByRole('radio', { name: '恢复码', exact: true }).isEnabled(), false, 'R-F08: a pending verification freezes its method');
      if (scenario === 'cancel') {
        const cancel = page.getByRole('dialog').getByRole('button', { name: '取消', exact: true });
        assert.equal(await cancel.isEnabled(), true, 'R-F08: pending verification can be canceled without resuming the mutation');
        await cancel.click();
      }
      await settleRender(page);
      const count = data.calls.filter(call => call.path === '/api/admin/account/mfa/step-up').length;
      data.observed = { pendingRequests: count };
      assert.equal(count, 1, 'R-F08: exactly one MFA verification may be in flight');
      release.resolve();
      await settleCall(page, first);
      if (scenario === 'failure-retry') {
        await page.getByRole('alert').filter({ hasText: 'Synthetic incorrect code' }).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
      }
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      if (scenario !== 'cancel') await settleCall(page, await waitForCall(data, call => call.path === '/api/admin/account/username', data.calls.findIndex(call => call.path === '/api/admin/account/username') + 1));
      await settleRender(page);
      assert.equal(writes, scenario === 'cancel' ? 0 : 1, 'R-F08: verification resumes exactly one original mutation, unless canceled');
      assert.equal(attempt, scenario === 'failure-retry' ? 2 : 1);
    } finally { release.resolve(); }
  });
  }

  for (const oldFailure of [false, true]) {
  await check(`R-F09-http-${oldFailure ? 'error' : 'success'}`, 'an older HTTP live response cannot roll back the newest snapshot', async (page, data) => {
    const entered = deferred();
    const release = deferred();
    let armed = false;
    let requests = 0;
    data.authenticated = false;
    data.handlers.push(async ({ path, call, json }) => {
      if (!armed || path !== '/api/live/clients') return false;
      const nth = ++requests;
      const snapshot = { online: ['node-a'], clients: [], count: 1, data: { 'node-a': { cpu: nth === 1 ? 10 : 70, ram: 1024, ram_total: 2048, disk: 1024, disk_total: 4096 } }, timestamp: Date.now(), metadata_version: 'synthetic-v1' };
      if (nth === 1) { entered.resolve(call); await release.promise; }
      await json(nth === 1 && oldFailure ? { error: 'Older HTTP failed' } : snapshot, nth === 1 && oldFailure ? 500 : 200);
      return true;
    });
    try {
      await page.goto(origin + '/');
      await page.getByText('Alpha Server', { exact: true }).first().waitFor();
      armed = true;
      await page.evaluate(() => dispatchEvent(new Event('focus')));
      const oldCall = await deadline(entered.promise, 'old live HTTP snapshot starts');
      await page.evaluate(() => dispatchEvent(new Event('focus')));
      const newest = page.locator('.node-card .node-resource-ring-chart').getByText('70%', { exact: true });
      await newest.waitFor();
      release.resolve();
      await settleCall(page, oldCall);
      data.observed = { requests, renderedCard: await page.locator('.node-card').first().innerText() };
      assert.equal(await newest.count(), 1, 'R-F09: CPU=70 must survive completion of the older CPU=10 request');
      assert.equal(await page.getByText('HTTP 500', { exact: true }).count(), 0, 'R-F09: an obsolete error cannot obscure the newer success');
    } finally { release.resolve(); }
  });
  }

  for (const scenario of ['snapshot', 'update', 'update-error', 'remove', 'bootstrap', 'first-partial']) {
    await check(`R-F09-ws-${scenario}`, 'HTTP/bootstrap snapshots respect newer WebSocket state without losing other nodes', async (page, data, context) => {
      data.authenticated = false;
      data.clients.push({ ...data.clients[0], uuid: 'node-b', name: 'Beta Server' });
      const socketReady = deferred();
      await context.routeWebSocket('**/api/ws/live*', socket => socketReady.resolve(socket));
      const entered = deferred();
      const release = deferred();
      let armed = scenario === 'first-partial';
      const snapshot = cpu => ({ online: ['node-a', 'node-b'], clients: [{ uuid: 'node-a', name: 'Alpha Server', lastReportTime: 1 }, { uuid: 'node-b', name: 'Beta Server', lastReportTime: 1 }], data: { 'node-a': { cpu }, 'node-b': { cpu: 30 } }, count: 2, timestamp: Date.now(), metadata_version: 'synthetic-v1' });
      data.handlers.push(async ({ path, call, json }) => {
        if (path === '/api/ws/live-token') { await json({ token: 'synthetic-token', expires_at: Date.now() + 60_000 }); return true; }
        const target = scenario === 'bootstrap' ? '/api/public/bootstrap' : '/api/live/clients';
        if (!armed || (path !== target && !(scenario === 'first-partial' && path === '/api/public/bootstrap'))) return false;
        if (scenario !== 'first-partial') armed = false;
        entered.resolve(call);
        await release.promise;
        await json(scenario === 'update-error' ? { error: 'Older HTTP failed' } : path === '/api/public/bootstrap' ? { clients: data.clients, settings: data.settings, live: snapshot(10) } : snapshot(10), scenario === 'update-error' ? 500 : 200);
        return true;
      });
      try {
        await page.goto(origin + '/test/browser-fixture.html');
        await page.evaluate(() => window.mountAuditFixture('live'));
        const socket = await deadline(socketReady.promise, 'synthetic WebSocket opens');
        if (scenario !== 'first-partial') {
          await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['node-a']);
          armed = true;
          if (scenario === 'bootstrap') await page.evaluate(async () => (await import('/src/utils/publicDataEvents.ts')).notifyPublicDataUpdated({ force: true }));
          else await page.locator('#live-refresh').click();
        }
        const old = await deadline(entered.promise, 'older full snapshot starts');
        const message = scenario === 'remove' ? { type: 'remove', client: 'node-a', timestamp: Date.now() }
          : scenario === 'snapshot' || scenario === 'bootstrap' ? { type: 'snapshot', ...snapshot(70) }
          : { type: 'update', client: 'node-a', name: 'Alpha Server', data: { cpu: 70 }, timestamp: Date.now() };
        socket.send(JSON.stringify(message));
        await page.waitForFunction(remove => {
          const state = JSON.parse(document.getElementById('live-result').textContent).liveData;
          return remove ? !state?.data?.['node-a'] : state?.data?.['node-a']?.cpu === 70;
        }, scenario === 'remove');
        release.resolve();
        await settleCall(page, old);
        if (scenario === 'first-partial') {
          for (const call of data.calls.filter(call => call.path === '/api/public/bootstrap' || call.path === '/api/live/clients')) await settleCall(page, call);
        }
        const state = JSON.parse(await page.locator('#live-result').textContent());
        data.observed = state;
        assert.equal(state.liveData.data['node-a']?.cpu, scenario === 'remove' ? undefined : 70, 'R-F09: newer WS data/removal survives an older full response');
        assert.equal(state.liveData.data['node-b'].cpu, scenario === 'update-error' ? 20 : 30, 'R-F09: partial updates retain the rest of the full snapshot');
        assert.equal(state.error, null);
      } finally { release.resolve(); }
    });
  }

  await check('R-F09-auth-scope', 'a pending administrator snapshot cannot repopulate a public session', async (page, data) => {
    data.clients.push({ ...data.clients[0], uuid: 'private-node', name: 'Private node', hidden: true });
    const entered = deferred();
    const release = deferred();
    let armed = false;
    data.handlers.push(async ({ path, url, call, json }) => {
      if (!armed || path !== '/api/live/clients' || !url.searchParams.has('include_hidden')) return false;
      armed = false;
      entered.resolve(call);
      await release.promise;
      await json({ online: ['private-node'], clients: [], count: 1, data: { 'private-node': { cpu: 99 } }, timestamp: Date.now() });
      return true;
    });
    try {
      await page.goto(origin + '/test/browser-fixture.html');
      await page.evaluate(() => window.mountAuditFixture('live'));
      await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['private-node']);
      armed = true;
      await page.locator('#live-refresh').click();
      const old = await deadline(entered.promise, 'private live snapshot starts');
      await page.locator('#live-clear-auth').click();
      await page.waitForFunction(() => {
        const value = JSON.parse(document.getElementById('live-result').textContent).liveData;
        return value?.data?.['node-a'] && !value?.data?.['private-node'];
      });
      release.resolve();
      await settleCall(page, old);
      const state = JSON.parse(await page.locator('#live-result').textContent());
      assert.equal(state.liveData.data['private-node'], undefined, 'R-F09: retired private requests cannot overwrite the public scope');
      assert.equal(state.liveData.data['node-a'].cpu, 20);
    } finally { release.resolve(); }
  });

  await check('R-F09-retired-socket', 'retired socket callbacks cannot repopulate an earlier private scope', async (page, data, context) => {
    await context.routeWebSocket('**/api/ws/live*', () => {});
    data.handlers.push(async ({ path, json }) => {
      if (path !== '/api/ws/live-token') return false;
      await json({ token: 'synthetic-token' });
      return true;
    });
    await page.goto(origin + '/test/browser-fixture.html');
    await page.evaluate(() => {
      const NativeWebSocket = window.WebSocket;
      window.syntheticSockets = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) { super(...args); window.syntheticSockets.push(this); }
      };
    });
    await page.evaluate(() => window.mountAuditFixture('live'));
    await page.waitForFunction(() => window.syntheticSockets.some(socket => socket.url.includes('include_hidden=1')) && JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['node-a']);
    await page.locator('#live-clear-auth').click();
    await page.waitForFunction(() => document.getElementById('live-auth').textContent === 'false' && window.syntheticSockets.some(socket => socket.url.endsWith('/api/ws/live')) && JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['node-a']);
    await page.evaluate(() => {
      const old = window.syntheticSockets.find(socket => socket.url.includes('include_hidden=1'));
      old.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'snapshot', online: ['private-node'], clients: [], data: { 'private-node': { cpu: 99 } }, count: 1, timestamp: Date.now() }) }));
    });
    await settleRender(page);
    const state = JSON.parse(await page.locator('#live-result').textContent());
    assert.equal(state.liveData.data['private-node'], undefined, 'R-F09: callbacks queued on a retired socket have no authority');
  });

  await check('R-F09-partial-error', 'a partial socket update cannot hide a failed first full load', async (page, data, context) => {
    data.authenticated = false;
    const ready = deferred();
    await context.routeWebSocket('**/api/ws/live*', socket => ready.resolve(socket));
    data.failures['GET /api/public/bootstrap'] = 'First full load failed';
    data.failures['GET /api/live/clients'] = 'First full load failed';
    data.handlers.push(async ({ path, json }) => {
      if (path !== '/api/ws/live-token') return false;
      await json({ token: 'synthetic-token' }); return true;
    });
    await page.goto(origin + '/test/browser-fixture.html');
    await page.evaluate(() => window.mountAuditFixture('live'));
    const socket = await deadline(ready.promise, 'socket opens without a full snapshot');
    await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).error);
    socket.send(JSON.stringify({ type: 'update', client: 'node-a', data: { cpu: 70 }, timestamp: Date.now() }));
    await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['node-a']?.cpu === 70);
    const state = JSON.parse(await page.locator('#live-result').textContent());
    assert.ok(state.error, 'R-F09: one node update does not prove that the complete snapshot loaded');
  });

  for (const type of ['update', 'remove']) {
  await check(`R-F09-retry-${type}`, 'a retry snapshot supersedes socket history from before the retry', async (page, data, context) => {
    data.authenticated = false;
    const ready = deferred();
    await context.routeWebSocket('**/api/ws/live*', socket => ready.resolve(socket));
    data.failures['GET /api/public/bootstrap'] = 'First full load failed';
    data.failures['GET /api/live/clients'] = 'First full load failed';
    data.handlers.push(async ({ path, json }) => {
      if (path !== '/api/ws/live-token') return false;
      await json({ token: 'synthetic-token' }); return true;
    });
    await page.goto(origin + '/test/browser-fixture.html');
    await page.evaluate(() => window.mountAuditFixture('live'));
    const socket = await deadline(ready.promise, 'socket opens without a full snapshot');
    await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).error);
    socket.send(JSON.stringify({ type: 'update', client: 'node-a', data: { cpu: 10 }, timestamp: 90 }));
    await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['node-a']?.cpu === 10);
    if (type === 'remove') {
      socket.send(JSON.stringify({ type: 'remove', client: 'node-a', timestamp: 100 }));
      await page.waitForFunction(() => !JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['node-a']);
    }
    delete data.failures['GET /api/live/clients'];
    data.handlers.push(async ({ path, json }) => {
      if (path !== '/api/live/clients') return false;
      await json({ online: ['node-a', 'node-b'], clients: [], data: { 'node-a': { cpu: 20, ram: 200 }, 'node-b': { cpu: 30 } }, count: 2, timestamp: 200 });
      return true;
    });
    const after = data.calls.length;
    await page.locator('#live-refresh').click();
    await settleCall(page, await waitForCall(data, call => call.path === '/api/live/clients', after));
    const state = JSON.parse(await page.locator('#live-result').textContent());
    data.observed = state;
    assert.equal(state.liveData.data['node-a']?.cpu, 20, 'R-F09: pre-retry socket history cannot overwrite a newer retry snapshot');
    assert.equal(state.liveData.data['node-a'].ram, 200);
    assert.equal(state.liveData.data['node-b'].cpu, 30);
    assert.equal(state.liveData.timestamp, 200);
    assert.equal(state.error, null);
  });
  }

  await check('R-F09-empty', 'last-node removal and empty socket snapshots clear live state', async (page, data, context) => {
    data.authenticated = false;
    const ready = deferred();
    await context.routeWebSocket('**/api/ws/live*', socket => ready.resolve(socket));
    data.handlers.push(async ({ path, json }) => {
      if (path !== '/api/ws/live-token') return false;
      await json({ token: 'synthetic-token' }); return true;
    });
    await page.goto(origin + '/test/browser-fixture.html');
    await page.evaluate(() => window.mountAuditFixture('live'));
    const socket = await deadline(ready.promise, 'socket opens');
    await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['node-a']);
    socket.send(JSON.stringify({ type: 'remove', client: 'node-a', timestamp: Date.now() }));
    await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).liveData?.count === 0);
    for (const message of [
      { type: 'update', client: 'node-a', data: { cpu: 70 }, timestamp: Date.now() },
      { type: 'snapshot', online: [], clients: [], data: {}, count: 0, timestamp: Date.now() },
    ]) socket.send(JSON.stringify(message));
    await settleRender(page);
    const state = JSON.parse(await page.locator('#live-result').textContent());
    assert.deepEqual(state.liveData.online, []);
    assert.deepEqual(state.liveData.data, {});
    assert.equal(state.error, null);
  });

  await check('R-F09-remount', 'unmounted live requests cannot affect the replacement provider', async (page, data) => {
    data.authenticated = false;
    const entered = deferred();
    const release = deferred();
    let armed = false;
    data.handlers.push(async ({ path, call, json }) => {
      if (!armed || path !== '/api/live/clients') return false;
      armed = false;
      entered.resolve(call);
      await release.promise;
      await json({ online: ['obsolete-node'], clients: [], count: 1, data: { 'obsolete-node': { cpu: 99 } }, timestamp: Date.now() });
      return true;
    });
    try {
      await page.goto(origin + '/test/browser-fixture.html');
      await page.evaluate(() => window.mountAuditFixture('live'));
      await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['node-a']);
      armed = true;
      await page.locator('#live-refresh').click();
      const old = await deadline(entered.promise, 'old provider HTTP starts');
      await page.locator('#live-remount').click();
      await page.locator('#live-result').waitFor({ state: 'detached' });
      await page.locator('#live-remount').click();
      await page.waitForFunction(() => JSON.parse(document.getElementById('live-result').textContent).liveData?.data?.['node-a']);
      release.resolve();
      await settleCall(page, old);
      const state = JSON.parse(await page.locator('#live-result').textContent());
      assert.equal(state.liveData.data['node-a'].cpu, 20);
      assert.equal(state.liveData.data['obsolete-node'], undefined);
    } finally { release.resolve(); }
  });

  for (const width of [390, 768]) {
  await check(`R-F10-${width}`, 'closed mobile navigation is outside the keyboard focus order', async (page) => {
    await page.goto(origin + '/admin');
    await page.getByText('Alpha Server', { exact: true }).first().waitFor();
    const toggle = page.locator('.mobile-sidebar-toggle');
    await toggle.focus();
    await page.keyboard.press('Tab');
    const inside = await page.locator('.admin-sidebar').evaluate(aside => aside.contains(document.activeElement));
    assert.equal(inside, false, 'R-F10: Tab must not enter a visually closed mobile sidebar');
    await toggle.focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.admin-sidebar').evaluate(aside => aside.contains(document.activeElement)), false, 'R-F10: reverse Tab also skips the closed sidebar');
    await toggle.click();
    await settleRender(page);
    assert.equal(await page.locator('.admin-sidebar').evaluate(aside => aside.contains(document.activeElement)), true, 'R-F10: opening puts keyboard focus inside the menu');
    const firstControl = page.locator('.admin-sidebar button:visible').first();
    const lastControl = page.locator('.admin-sidebar button:visible').last();
    await lastControl.focus();
    await page.keyboard.press('Tab');
    assert.equal(await firstControl.evaluate(element => element === document.activeElement), true, 'mobile menu traps forward Tab at its boundary');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await lastControl.evaluate(element => element === document.activeElement), true, 'mobile menu traps reverse Tab at its boundary');
    await page.keyboard.press('Escape');
    await settleRender(page);
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true, 'R-F10: Escape restores the menu trigger');
    await toggle.click();
    await page.locator('.admin-sidebar a[href="/admin/websites"]').focus();
    await page.keyboard.press('Enter');
    await page.getByText('Synthetic website', { exact: true }).first().waitFor();
    await settleRender(page);
    assert.equal(await page.locator('.admin-sidebar').evaluate(aside => aside.inert), true, 'R-F10: selecting a route closes the mobile interaction tree');
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true, 'R-F10: route selection restores the menu trigger');
    await page.setViewportSize({ width: 1280, height: 900 });
    await settleRender(page);
    assert.equal(await page.locator('.admin-sidebar').evaluate(aside => aside.inert), false, 'R-F10: desktop navigation is interactive after resize');
    const account = page.locator('.admin-sidebar a[href="/admin/account"]');
    await account.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '修改用户名', exact: true }).waitFor();
  }, { width });
  }

  await check('R-F10-logout-error', 'a mobile logout failure returns to its visible retry message', async (page, data) => {
    data.failures['POST /api/logout'] = 'Synthetic logout failure';
    await page.goto(origin + '/admin');
    await page.getByText('Alpha Server', { exact: true }).first().waitFor();
    await page.locator('.mobile-sidebar-toggle').click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await settleCall(page, await waitForCall(data, call => call.path === '/api/logout'));
    assert.equal(await page.getByRole('alert').count(), 1, 'R-F10/R-F06: the pending drawer must not hide the logout failure and retry');
    const retry = page.getByRole('button', { name: '重试退出', exact: true });
    await retry.focus();
    assert.equal(await retry.evaluate(element => document.activeElement === element), true, 'R-F10/R-F06: the failed logout retry must be interactive outside the drawer');
  }, { width: 390 });

  await check('R-F11', 'mobile website actions have accessible names before hover', async (page, data) => {
    data.websites.push({ ...data.websites[0], id: 2, name: 'Second website' });
    await page.goto(origin + '/admin/websites');
    const card = page.locator('.admin-website-card').filter({ hasText: 'Synthetic website' });
    await card.waitFor();
    const unnamed = await card.getByRole('button', { name: '', exact: true }).evaluateAll(elements => elements.map(element => element.outerHTML));
    data.observed = { unnamed };
    assert.equal(unnamed.length, 0, 'R-F11: check, edit and delete require accessible action names before hover');
    for (const name of ['Synthetic website', 'Second website']) {
      for (const action of ['检测', '编辑', '删除']) {
        assert.equal(await page.getByRole('button', { name: new RegExp(`^${action}.*${name}$`) }).count(), 1, `R-F11: ${action} identifies its target ${name}`);
      }
    }
    const target = page.locator('.admin-website-card').filter({ hasText: 'Second website' });
    await target.getByRole('button', { name: /^检测/ }).focus();
    await page.keyboard.press('Enter');
    await settleCall(page, await waitForCall(data, call => call.path === '/api/admin/websites/2/check'));
    await target.getByRole('button', { name: /^编辑/ }).focus();
    await page.keyboard.press('Enter');
    const edit = page.getByRole('dialog', { name: '编辑监控', exact: true });
    assert.equal(await edit.getByRole('textbox', { name: '名称', exact: true }).inputValue(), 'Second website');
    await edit.getByRole('button', { name: '取消', exact: true }).click();
    await target.getByRole('button', { name: /^删除/ }).focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: '确认删除', exact: true });
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(data.calls.filter(call => call.path === '/api/admin/websites/delete').length, 0, 'cancel does not delete either website');
    await target.getByRole('button', { name: /^删除/ }).focus();
    await page.keyboard.press('Enter');
    await confirm.getByRole('button', { name: '确认删除', exact: true }).focus();
    await page.keyboard.press('Enter');
    await confirm.waitFor({ state: 'hidden' });
    assert.deepEqual(data.websites.map(monitor => monitor.id), [1], 'keyboard confirmation deletes only the named website');
    assert.equal(await page.locator('.admin-website-card').count(), 1);
  }, { width: 390 });

  for (const phase of ['initial', 'refresh']) {
  for (const failure of ['server', 'network', 'invalid', 'invalid-row']) {
  await check(`R-F12-${phase}-${failure}`, 'failed server-list reads stay distinct from confirmed empty snapshots', async (page, data) => {
    let failing = phase === 'initial';
    data.handlers.push(async ({ path, route, json }) => {
      if (!failing || path !== '/api/admin/clients') return false;
      if (failure === 'network') await route.abort('internetdisconnected');
      else await json(failure === 'invalid' ? { clients: 'not-a-list' } : failure === 'invalid-row' ? [{}] : { error: 'Synthetic client read failure' }, failure === 'server' ? 500 : 200);
      return true;
    });
    await page.goto(origin + '/admin');
    let after = 0;
    if (phase === 'refresh') {
      await page.getByText('Alpha Server', { exact: true }).first().waitFor();
      data.clients[0].name = 'Newest server name';
      failing = true;
      after = data.calls.length;
      await page.locator('.admin-refresh-button').click();
    }
    await settleCall(page, await waitForCall(data, call => call.path === '/api/admin/clients', after));
    await page.locator('.admin-main .loading-spinner').waitFor({ state: 'detached' });
    data.observed = { alerts: await page.getByRole('alert').allTextContents(), emptyLabelCount: await page.getByText('暂无服务器', { exact: true }).count(), backendClientCount: data.clients.length };
    assert.ok(data.observed.alerts.length > 0, 'R-F12: failed server-list reads need a persistent error');
    assert.equal(data.observed.emptyLabelCount, 0, 'R-F12: failure is not a valid empty list');
    const total = (await page.locator('.admin-overview-value').first().textContent()).trim();
    if (phase === 'initial') assert.equal(/^\d+$/.test(total), false, 'R-F12: a failed first load has no confirmed numeric count');
    else {
      assert.equal(await page.getByText('Alpha Server', { exact: true }).count(), 1, 'refresh failure retains the last trusted list');
      assert.equal(total, '1');
    }
    failing = false;
    await page.locator('.admin-refresh-button').click();
    await page.getByText(phase === 'initial' ? 'Alpha Server' : 'Newest server name', { exact: true }).first().waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, 'successful retry clears the read error');
    data.clients = [];
    await page.locator('.admin-refresh-button').click();
    await page.getByText('暂无服务器', { exact: true }).waitFor();
    assert.equal((await page.locator('.admin-overview-value').first().textContent()).trim(), '0');
  });
  }
  }
  for (const scenario of ['null', 'missing', 'zero', 'positive', 'negative', 'mixed', 'isolated']) {
  await check(`R-A11-${scenario}`, 'host temperature availability preserves CPU history and real Celsius values', async (page, data) => {
    const unavailable = scenario === 'null' || scenario === 'missing';
    const temperatures = unavailable ? [null, null, null] : scenario === 'zero' ? [0, 0] : scenario === 'positive' ? [42, 48] : scenario === 'negative' ? [-5, -2] : scenario === 'isolated' ? [null, 0, null, -7, null, 25, null] : [10, 12, null, null, 0, -7, null, 25, 30];
    const history = temperatures.map((temp, index) => ({
      time: new Date(Date.now() - (temperatures.length - index) * 60000).toISOString(),
      cpu: 20 + index, ram: 512, ram_total: 1024, net_in: 4096,
      ...(scenario === 'missing' ? {} : { temp }),
    }));
    data.handlers.push(async ({ path, json }) => {
      if (path !== '/api/records/load') return false;
      await json({ data: history, has_more: false });
      return true;
    });
    await page.goto(origin + '/instance/node-a');
    await page.getByRole('heading', { name: 'Alpha Server', exact: true }).waitFor();
    const card = page.locator('.rt-Card').filter({ hasText: '监控图表' });
    assert.equal(await card.getByText(`${history.length} 个数据点`, { exact: true }).count(), 1, 'R-A11: unknown temperature does not remove otherwise-valid CPU records');
    assert.ok(await card.locator('.recharts-line-curve').count() > 0, 'CPU history remains rendered');
    await page.getByRole('tab', { name: '温度', exact: true }).click();
    await settleRender(page);
    const unavailableMessage = card.getByRole('status').filter({ hasText: /温度.*不可用/ });
    const paths = await card.locator('.recharts-line-curve').evaluateAll(lines => lines.map(line => line.getAttribute('d')));
    data.observed = { scenario, samples: history.length, unavailable: await unavailableMessage.count(), paths };
    if (unavailable) {
      assert.equal(await unavailableMessage.count(), 1, 'R-A11: all-unknown host temperatures need an explicit unavailable state');
      assert.equal(paths.length, 0, 'unknown is not a zero-temperature line');
    } else {
      assert.equal(await unavailableMessage.count(), 0, 'measured zero/negative temperature is available');
      if (scenario === 'isolated') assert.equal(await card.locator('.recharts-line-dot').count(), 3, 'R-A11: isolated valid measurements remain visible between unknown periods');
      else assert.ok(paths.some(path => path && /[lLcC]/.test(path)), 'real Celsius measurements form a rendered line');
      if (scenario === 'mixed') assert.ok(paths.some(path => (path.match(/[mM]/g) || []).length >= 3), 'R-A11: null periods interrupt the temperature line');
      if (scenario === 'negative') assert.ok((await card.locator('.recharts-yAxis').textContent()).includes('-'), 'negative Celsius is represented on the axis');
    }
    await page.getByRole('tab', { name: 'CPU', exact: true }).click();
    assert.equal(await card.getByText(`${history.length} 个数据点`, { exact: true }).count(), 1);
    assert.ok(await card.locator('.recharts-line-curve').count() > 0);
  });
  }
} finally {
  await finish();
}
