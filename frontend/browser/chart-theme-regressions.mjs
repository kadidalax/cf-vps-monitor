import assert from 'node:assert/strict';
import { createHarness, deadline, settleCall, settleRender, waitForCall } from './helpers/harness.mjs';

const moduleFlag = process.argv.indexOf('--playwright-module');
const { origin, check, finish } = await createHarness({
  selection: process.argv[2] || 'ALL',
  playwrightModule: moduleFlag >= 0 ? process.argv[moduleFlag + 1] : process.env.CF_MONITOR_PLAYWRIGHT_MODULE,
});

const metrics = [
  ['CPU', [['CPU', '27.5%']]],
  ['内存', [['内存', '25.0%']]],
  ['磁盘', [['磁盘', '50.0%']]],
  ['网络', [['下载', '2 KB/s'], ['上传', '3.0 MB/s']]],
  ['连接数', [['TCP', '12'], ['UDP', '0']]],
  ['进程数', [['进程数', '23']]],
  ['温度', [['温度', '0.0 °C']]],
  ['GPU', [['利用率 %', '37.5%'], ['显存 %', '25.0%'], ['温度 °C', '45.0 °C']]],
];
const pingValues = [['Ping East', '21 ms'], ['Ping West', '42 ms']];

function historyRows(end, duration = 3_600_000) {
  return Array.from({ length: 12 }, (_, index) => ({
    time: new Date(end - (12 - index) * duration / 13).toISOString(),
    cpu: 27.5, ram: 1024, ram_total: 4096, swap: 0, swap_total: 0,
    disk: 500, disk_total: 1000, load: 0.5, temp: 0,
    net_in: 2048, net_out: 3 * 1024 ** 2, net_total_up: 0, net_total_down: 0,
    connections: 12, connections_udp: 0, process_count: 23, uptime: 3600,
  }));
}

async function openInstance(page, data, context, { display = 'monitor', appearance = 'light', css = '' } = {}) {
  data.authenticated = false;
  data.settings.active_theme = display;
  data.clients[0].gpu_name = 'Synthetic GPU';
  data.observed.tooltips = [];
  await context.addInitScript(({ display, appearance }) => {
    localStorage.setItem('cf-monitor-theme', appearance);
    localStorage.setItem('cf-monitor-display-theme', display);
    localStorage.setItem('cf-monitor-display-theme-source', 'local');
  }, { display, appearance });
  data.handlers.push(async ({ path, url, route, json }) => {
    if (path === '/api/theme/active.css') {
      await route.fulfill({ contentType: 'text/css', body: typeof css === 'function' ? css() : css }); return true;
    }
    if (path === '/api/records/load' || path === '/api/records/gpu') {
      const end = Date.parse(url.searchParams.get('end'));
      const rows = historyRows(end, end - Date.parse(url.searchParams.get('start')));
      const records = path.endsWith('/gpu')
        ? rows.map(({ time }) => ({ time, utilization: 37.5, mem_used: 256, mem_total: 1024, temperature: 45 }))
        : rows;
      await json({ data: records, has_more: false }); return true;
    }
    if (path === '/api/task/ping') {
      await json(pingValues.map(([name], index) => ({
        id: index + 1, name, type: 'icmp', target: 'example.invalid', all_clients: true, interval_sec: 60,
      })));
      return true;
    }
    if (path === '/api/records/ping/batch' || path === '/api/records/ping') {
      const rows = historyRows(Date.parse(url.searchParams.get('cursor')));
      const byTask = Object.fromEntries([1, 2].map(id => [id, rows.map(({ time }) => ({ time, value: id * 21, task_id: id }))]));
      await json(path.endsWith('/batch') ? byTask : { data: byTask[url.searchParams.get('task_id')], has_more: false });
      return true;
    }
    return false;
  });
  await page.goto(origin + '/instance/node-a');
  await page.getByText('12 个数据点', { exact: true }).waitFor();
}

async function renderedBackground(page, tooltip) {
  // Sample rendered padding, including translucent layers, instead of assuming a CSS background formula.
  const png = await tooltip.screenshot({ animations: 'disabled' });
  return page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(Math.floor(image.width / 2), 5, 1, 1).data).slice(0, 3);
  }, png.toString('base64'));
}

async function readTooltip(page, chart = 'metric', { verifyOpaque = false } = {}) {
  if (chart === 'ping') await page.getByText('Ping 延迟', { exact: true }).scrollIntoViewIfNeeded();
  const wrapper = page.locator('.instance-detail-panel .recharts-wrapper').nth(chart === 'ping' ? 1 : 0);
  await wrapper.waitFor();
  await wrapper.scrollIntoViewIfNeeded();
  const box = await wrapper.boundingBox();
  await wrapper.hover({ position: { x: Math.round(box.width * 0.55), y: 80 } });
  const tooltip = wrapper.locator('.recharts-tooltip-wrapper[style*="visibility: visible"] .recharts-default-tooltip');
  await tooltip.waitFor();
  return observeTooltip(page, tooltip, wrapper, { verifyOpaque });
}

async function observeTooltip(page, tooltip, wrapper, { verifyOpaque = false } = {}) {
  const observation = await tooltip.evaluate(element => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const color = node => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(node).color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const label = element.querySelector('.recharts-tooltip-label');
    return {
      label: label.textContent,
      labelColor: color(label),
      items: Array.from(element.querySelectorAll('.recharts-tooltip-item')).map(item => {
        const name = item.querySelector('.recharts-tooltip-item-name');
        const value = item.querySelector('.recharts-tooltip-item-value');
        return { name: name.textContent, value: value.textContent, nameColor: color(name), color: color(value) };
      }),
    };
  });
  observation.background = await renderedBackground(page, tooltip);
  if (verifyOpaque) {
    const previous = await wrapper.evaluate(element => element.style.backgroundColor);
    try {
      await wrapper.evaluate(element => { element.style.backgroundColor = '#000'; });
      const onBlack = await renderedBackground(page, tooltip);
      await wrapper.evaluate(element => { element.style.backgroundColor = '#fff'; });
      const onWhite = await renderedBackground(page, tooltip);
      assert.deepEqual(onBlack, onWhite, 'Tooltip surface must not reveal the chart underneath');
    } finally {
      await wrapper.evaluate((element, value) => { element.style.backgroundColor = value; }, previous);
    }
  }
  return observation;
}

function luminance(rgb) {
  const channels = rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const alpha = foreground[3] / 255;
  const text = foreground.slice(0, 3).map((value, index) => value * alpha + background[index] * (1 - alpha));
  const a = luminance(text), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function assertReadable(observation, appearance, values) {
  assert.match(observation.label, /\d{2}:\d{2}/, 'Tooltip retains a readable time label');
  assert.deepEqual(observation.items.map(({ name, value }) => [name, value]), values, 'Tooltip retains metric names, values and units');
  const backgroundLightness = luminance(observation.background);
  assert.ok(appearance === 'dark' ? backgroundLightness < 0.25 : backgroundLightness > 0.5, `Tooltip surface follows ${appearance} appearance`);
  const contrasts = [observation.labelColor, ...observation.items.flatMap(item => [item.nameColor, item.color])].map(color => contrast(color, observation.background));
  observation.minimumContrast = Number(Math.min(...contrasts).toFixed(2));
  assert.ok(contrasts.every(value => value >= 4.5), `Tooltip date and value contrast must be at least 4.5:1; got ${observation.minimumContrast}:1`);
}

async function checkBothCharts(page, data, appearance, options) {
  const results = [];
  for (const [chart, values] of [['metric', metrics[0][1]], ['ping', pingValues]]) {
    const observation = await readTooltip(page, chart, options);
    data.observed.tooltips.push(Object.assign(observation, { chart, appearance }));
    assertReadable(observation, appearance, values);
    results.push(observation);
  }
  return results;
}

async function reloadThemeStylesheet(page) {
  await deadline(page.evaluate(() => new Promise((resolve, reject) => {
    const link = document.getElementById('cf-monitor-active-theme-css');
    if (!link) { reject(new Error('Public theme stylesheet is missing')); return; }
    const cleanup = () => {
      link.removeEventListener('load', loaded);
      link.removeEventListener('error', failed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Public theme stylesheet failed to load')); };
    link.addEventListener('load', loaded);
    link.addEventListener('error', failed);
    window.dispatchEvent(new CustomEvent('cf-monitor:theme-updated'));
  })), 'active theme stylesheet update');
  await settleRender(page);
}

try {
  // Dropping theme props from any conditional Tooltip branch must fail its actual rendered tab.
  for (const display of ['monitor', 'aurora']) {
    for (const appearance of ['light', 'dark']) {
      await check(`CHART-${display}-${appearance}`, 'every metric and Ping tooltip follows the current theme', async (page, data, context) => {
        await openInstance(page, data, context, { display, appearance });
        for (const [metric, values] of metrics) {
          await page.getByRole('tab', { name: metric, exact: true }).click();
          await settleRender(page);
          const observation = await readTooltip(page);
          data.observed.tooltips.push(Object.assign(observation, { metric }));
          assertReadable(observation, appearance, values);
        }
        const ping = await readTooltip(page, 'ping');
        data.observed.tooltips.push(Object.assign(ping, { metric: 'Ping' }));
        assertReadable(ping, appearance, pingValues);
      });
    }
  }

  await check('CHART-runtime', 'existing charts update when appearance and display theme change', async (page, data, context) => {
    await openInstance(page, data, context);
    const light = await checkBothCharts(page, data, 'light');
    await page.getByRole('button', { name: '切换成深色模式', exact: true }).click();
    await settleRender(page);
    const dark = await checkBothCharts(page, data, 'dark');
    await page.getByRole('button', { name: '切换成 Aurora 主题', exact: true }).click();
    await settleRender(page);
    const aurora = await checkBothCharts(page, data, 'dark');
    for (const index of [0, 1]) {
      assert.notDeepEqual(light[index].background, dark[index].background, 'Both tooltip surfaces update after light-to-dark switching');
      assert.notDeepEqual(dark[index].background, aurora[index].background, 'Both tooltip surfaces pick up the selected display theme');
    }
  });

  for (const chart of ['metric', 'ping']) {
    await check(`CHART-hover-${chart}`, 'an open tooltip updates system and custom colors without another pointer event', async (page, data, context) => {
      let customCss = '';
      await page.emulateMedia({ colorScheme: 'light' });
      await openInstance(page, data, context, { display: 'aurora', appearance: 'system', css: () => customCss });
      const beforeRange = data.calls.length;
      await page.getByRole('radio', { name: '24小时', exact: true }).click();
      await settleCall(page, await waitForCall(data, call => call.path === '/api/records/load', beforeRange));
      await page.getByText('12 个数据点', { exact: true }).waitFor();

      const values = chart === 'ping' ? pingValues : metrics[0][1];
      const initial = await readTooltip(page, chart, { verifyOpaque: true });
      data.observed.tooltips.push(Object.assign(initial, { chart, phase: 'system-light' }));
      assertReadable(initial, 'light', values);
      assert.ok(initial.label.match(/\d+/g).length >= 4, 'The open tooltip includes its date and time');
      const wrapper = page.locator('.instance-detail-panel .recharts-wrapper').nth(chart === 'ping' ? 1 : 0);
      const tooltip = await wrapper.locator('.recharts-tooltip-wrapper[style*="visibility: visible"] .recharts-default-tooltip').elementHandle();
      assert.ok(tooltip, 'The hovered tooltip exists before changing themes');
      await page.evaluate(() => {
        window.__chartHoverPointerEvents = [];
        for (const type of ['pointermove', 'mousemove']) {
          document.addEventListener(type, () => window.__chartHoverPointerEvents.push(type), true);
        }
      });

      // Use the retained element handle: a remount, dismissal, or re-hover must not hide a stale-color failure.
      const observeOpenTooltip = async (appearance, phase) => {
        assert.ok(await tooltip.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const parent = element.closest('.recharts-tooltip-wrapper');
          return element.isConnected && parent && getComputedStyle(parent).visibility === 'visible'
            && bounds.width > 0 && bounds.height > 0 && bounds.top >= 0 && bounds.left >= 0
            && bounds.bottom <= innerHeight && bounds.right <= innerWidth;
        }), 'The same tooltip DOM remains visible in the viewport after the theme changes');
        const observation = await observeTooltip(page, tooltip, wrapper, { verifyOpaque: true });
        data.observed.tooltips.push(Object.assign(observation, { chart, phase, sameTooltipDom: true }));
        assertReadable(observation, appearance, values);
        assert.equal(observation.label, initial.label, 'Changing colors preserves the hovered date and time');
        assert.deepEqual(await page.evaluate(() => window.__chartHoverPointerEvents), [], 'Theme updates do not require another pointer event');
        return observation;
      };

      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await settleRender(page);
      const dark = await observeOpenTooltip('dark', 'system-dark');
      assert.notDeepEqual(initial.background, dark.background, 'The open tooltip follows the changed system appearance');

      customCss = `html.dark .radix-themes {
        --monitor-panel-strong: rgba(24, 104, 72, 0);
        --color-panel-solid: #081d14;
        --gray-12: #e0ffed;
      }`;
      await reloadThemeStylesheet(page);
      const transparentTint = await observeOpenTooltip('dark', 'custom-transparent-tint');
      assert.deepEqual(transparentTint.labelColor, [224, 255, 237, 255], 'Custom text reaches the already open date');
      assert.deepEqual(transparentTint.background, [8, 29, 20], 'A transparent tint retains the custom solid backing');

      customCss = `html.dark .radix-themes {
        --monitor-panel-strong: rgba(48, 80, 144, 0.45);
        --color-panel-solid: #0b1628;
        --gray-12: #e7f1ff;
      }`;
      await reloadThemeStylesheet(page);
      const blueTint = await observeOpenTooltip('dark', 'custom-blue-tint');
      assert.deepEqual(blueTint.labelColor, [231, 241, 255, 255], 'A second custom palette updates the same date text');
      assert.notDeepEqual(transparentTint.background, blueTint.background, 'Custom tint and alpha changes update the composited surface');
      assert.ok(blueTint.background[2] > blueTint.background[0] * 2, 'The custom blue tint reaches the open tooltip');

      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => document.documentElement.classList.contains('light'));
      await settleRender(page);
      const lightAgain = await observeOpenTooltip('light', 'system-light-again');
      assert.deepEqual(lightAgain.background, initial.background, 'Leaving the dark custom palette restores the light tooltip surface');
      await tooltip.dispose();
    });
  }

  await check('CHART-custom-system', 'custom theme tokens and system appearance reach opaque mobile tooltips', async (page, data, context) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openInstance(page, data, context, {
      appearance: 'system',
      css: `
        html.light .radix-themes {
          --monitor-panel-strong: rgba(32, 96, 64, 0.12);
          --color-panel-solid: #f4fff8;
          --gray-12: #12331e;
        }
        html.dark .radix-themes {
          --monitor-panel-strong: rgba(24, 104, 72, 0.5);
          --color-panel-solid: #081d14;
          --gray-12: #e0ffed;
        }
      `,
    });
    const light = await checkBothCharts(page, data, 'light', { verifyOpaque: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await settleRender(page);
    const dark = await checkBothCharts(page, data, 'dark', { verifyOpaque: true });
    for (const index of [0, 1]) {
      assert.deepEqual(light[index].labelColor, [18, 51, 30, 255], 'Custom light text token reaches the tooltip title');
      assert.deepEqual(dark[index].labelColor, [224, 255, 237, 255], 'Custom dark text token reaches the tooltip title');
      assert.ok(dark[index].background[1] > dark[index].background[0] * 2, 'Custom green panel token reaches both chart surfaces');
    }
    await page.getByRole('radio', { name: '24小时', exact: true }).click();
    await page.getByText('12 个数据点', { exact: true }).waitFor();
    const date = await readTooltip(page);
    assertReadable(date, 'dark', metrics[0][1]);
    assert.ok(date.label.match(/\d+/g).length >= 4, 'A day-spanning range retains date and time in the title');
    data.observed.tooltips.push({ range: '24h', ...date });
  }, { width: 390 });
} finally {
  await finish();
}
