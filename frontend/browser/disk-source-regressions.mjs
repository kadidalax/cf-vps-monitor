import assert from 'node:assert/strict';
import { createHarness, settleRender } from './helpers/harness.mjs';

const moduleFlag = process.argv.indexOf('--playwright-module');
const { origin, check, finish } = await createHarness({
  selection: process.argv[2] || 'ALL',
  playwrightModule: moduleFlag >= 0 ? process.argv[moduleFlag + 1] : process.env.CF_MONITOR_PLAYWRIGHT_MODULE,
});

function directorySnapshot(data, offline) {
  const now = Date.now();
  const record = { cpu: 17, ram: 16_000_000, ram_total: 128_000_000, swap: 0, swap_total: 0,
    disk: 8_388_608, disk_total: 5_024_000_000, disk_source: 'directory', disk_sampled_at: now - 180_000,
    load: null, temp: null, uptime: 1000, net_in: 0, net_out: 0, net_total_up: 0, net_total_down: 0,
    process_count: 3, connections: 1, connections_udp: 0 };
  const node = { uuid: 'node-a', name: data.clients[0].name, lastReportTime: now - 60_000, ...record };
  return { online: offline ? [] : ['node-a'], clients: offline ? [] : [node], data: offline ? {} : { 'node-a': record },
    last_known: offline ? { 'node-a': node } : {}, count: offline ? 0 : 1, timestamp: now };
}

async function openCard(page, data, context, { theme, appearance, offline = false }) {
  data.authenticated = false;
  data.settings.active_theme = theme;
  data.clients = [{ ...data.clients[0], uuid: 'node-a', disk_total: 5_024_000_000 }];
  await page.emulateMedia({ colorScheme: appearance, reducedMotion: 'no-preference' });
  await context.addInitScript(({ theme, appearance }) => {
    localStorage.setItem('cf-monitor-theme', appearance);
    localStorage.setItem('cf-monitor-display-theme', theme);
  }, { theme, appearance });
  const live = directorySnapshot(data, offline);
  data.handlers.push(async ({ path, json }) => {
    if (path === '/api/public/bootstrap') { await json({ clients: data.clients, settings: data.settings, live }); return true; }
    if (path === '/api/live/clients') { await json(live); return true; }
    return false;
  });
  await page.goto(origin + '/');
  const card = page.locator('#node-a');
  await card.waitFor();
  await page.waitForFunction(({ theme, appearance }) => document.documentElement.dataset.monitorTheme === theme
    && document.documentElement.dataset.themeAppearance === appearance, { theme, appearance });
  await settleRender(page);
  return { card, live };
}

try {
  for (const theme of ['monitor', 'aurora']) {
    for (const appearance of ['dark', 'light']) {
      for (const [width, offline] of [[1280, false], [390, false], [1280, true], [390, true]]) {
        await check(`DISK-source-${theme}-${appearance}-${width}-${offline}`, 'disk estimates remain accessible without an extra card footer', async (page, data, context) => {
          const { card, live } = await openCard(page, data, context, { theme, appearance, offline });
          const cardText = await card.innerText();
          const diskMetric = theme === 'monitor'
            ? card.locator('.node-resource-ring').filter({ hasText: 'Disk' })
            : card.locator('.node-metric-tile').filter({ hasText: '磁盘' });
          const diskTitle = await (theme === 'monitor' ? diskMetric : diskMetric.locator('.node-metric-detail')).getAttribute('title');
          const sampleTime = live.data['node-a']?.disk_sampled_at ?? live.last_known['node-a'].disk_sampled_at;
          const expectedSample = await page.evaluate(timestamp => new Date(timestamp).toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
          }), sampleTime);
          const lastVisibleSection = await card.locator('[data-monitor-layout="monitor"]').evaluate(layout => {
            const visible = [...layout.parentElement.children].filter(element => getComputedStyle(element).display !== 'none');
            return visible.at(-1)?.getAttribute('data-monitor-layout');
          });
          const homeBounds = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
          data.observed = { cardText, diskTitle, sampleTime, homeBounds, lastVisibleSection };
          assert.deepEqual({
            extraFooterCount: await card.locator('.node-disk-estimate').count(),
            extraFooterText: /文件占用估算|采样/.test(cardText),
            lastVisibleSection,
            explainsEstimate: /文件占用估算/.test(diskTitle ?? ''),
            showsActualSampleTime: diskTitle?.includes(`采样 ${expectedSample}`) ?? false,
          }, {
            extraFooterCount: 0, extraFooterText: false,
            lastVisibleSection: theme === 'monitor' ? 'monitor' : 'tile',
            explainsEstimate: true, showsActualSampleTime: true,
          }, 'removing the footer must keep its explanation on the existing disk metric');
          assert.match(await diskMetric.innerText(), /≈\s*0\.2%/, 'the measured estimate percentage remains visible');
          assert.match(theme === 'monitor' ? diskTitle : cardText, /≈\s*8\.00 MB\s*\/\s*4\.7 GB/, 'allocated bytes remain readable in the metric or its native title');
          assert.ok(homeBounds.page <= homeBounds.viewport, 'the home card fits the viewport');
          await page.getByRole('button', { name: '表格视图', exact: true }).click();
          const table = page.locator('.node-table-root');
          await table.waitFor();
          assert.match(await table.innerText(), /≈\s*0\.2%/);
          await page.goto(origin + '/instance/node-a');
          await page.locator('.instance-top-summary').waitFor();
          const details = await page.locator('.instance-top-summary').innerText();
          assert.match(details, /≈\s*8\.00 MB\s*\/\s*4\.7 GB/);
          assert.match(details, /文件占用估算/);
          assert.match(details, /采样/);
          await page.getByRole('tab', { name: '磁盘', exact: true }).click();
          await page.getByText(/按上报时间记录.*文件占用估算/).waitFor();
          const bounds = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
          assert.ok(bounds.page <= bounds.viewport, 'source/time text does not overflow the page');
          Object.assign(data.observed, { details, bounds });
        }, { width });
      }
      for (const width of [1280, 390]) {
        await check(`DISK-card-filter-${theme}-${appearance}-${width}`, 'cards keep their theme material without a second background blur', async (page, data, context) => {
          const { card } = await openCard(page, data, context, { theme, appearance });
          const readFilters = () => card.evaluate(element => ({
            outer: getComputedStyle(element).backdropFilter,
            inner: getComputedStyle(element, '::before').backdropFilter,
            innerBackground: getComputedStyle(element, '::before').backgroundColor,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          }));
          const resting = await readFilters();
          await card.hover();
          await settleRender(page);
          const hovered = await readFilters();
          data.observed = { resting, hovered };
          for (const styles of [resting, hovered]) {
            assert.equal(styles.reducedMotion, false, 'exercise normal card transitions');
            assert.equal(styles.inner, 'none', 'Radix must not add another blur behind the card content');
            if (theme === 'aurora' && width > 640) assert.match(styles.outer, /blur\(/, 'desktop Aurora keeps its outer glass effect');
            else assert.equal(styles.outer, 'none', 'Monitor and mobile Aurora keep their original outer-filter behavior');
            assert.notEqual(styles.innerBackground, 'rgba(0, 0, 0, 0)', 'the existing Radix panel background remains present');
          }
        }, { width });
      }
    }
  }
} finally { await finish(); }
