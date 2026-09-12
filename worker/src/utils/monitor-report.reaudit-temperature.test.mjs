import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const loader = createWorkerLoader();
const { normalizeMonitorReport, toMonitorRecord } = loader.load('worker/src/utils/monitor-report.ts');
const { toPublicReport } = loader.load('worker/src/utils/public-report.ts');
const { compactLiveReport } = loader.load('worker/src/utils/live-report-state.ts');

test('R-A11 unavailable node temperature stays unavailable without borrowing a GPU reading', () => {
  for (const temp of [undefined, null, '', 'invalid', NaN, Infinity, -101, 151]) {
    const normalized = normalizeMonitorReport({ cpu: 37, temp, gpu: { temperature: 72 } });
    assert.equal(normalized.temp, null, `Unmeasured or invalid temperature ${String(temp)}`);
    assert.equal(normalized.cpu, 37);
  }
});

test('R-A11 measured zero/negative Celsius and null survive live, public and record boundaries', () => {
  for (const temp of [null, 0, -12.5, 42.25]) {
    const normalized = normalizeMonitorReport({ cpu: 37, temp });
    assert.equal(normalized.temp, temp);
    assert.equal(toPublicReport(normalized).temp, temp);
    assert.equal(compactLiveReport(normalized).temp, temp);
    assert.equal(toMonitorRecord('temperature-node', '2026-09-09T00:00:00Z', normalized).temp, temp);
  }
});

test('R-A11 SQL keeps unknown temperatures out of temperature statistics while preserving CPU samples', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await database.query("insert into clients(uuid,name) values ('temperature-node','Synthetic temperature fixture')");
  const temperatures = [undefined, null, 0, -5, 50];
  for (let index = 0; index < temperatures.length; index++) {
    await rpc(database, 'cfm_insert_monitor_record', { input_record: {
      client: 'temperature-node', time: `2026-09-09T00:00:0${index}Z`, cpu: 37, temp: temperatures[index],
    } });
  }
  const rows = await database.query("select temp,cpu from records where client='temperature-node' order by time");
  assert.deepEqual(rows.rows.map(row => row.temp), [null, null, 0, -5, 50]);
  assert.ok(rows.rows.every(row => row.cpu === 37));
  const args = {
    input_clients: ['temperature-node'], input_start: '2026-09-08T00:00:00Z',
    input_end: '2026-09-10T00:00:00Z', input_threshold: 0,
  };
  assert.deepEqual(await rpc(database, 'cfm_load_metric_window_stats', { ...args, input_metric: 'temp' }),
    [{ client: 'temperature-node', samples: 3, exceeded: 2, avg_value: 15 }]);
  assert.deepEqual(await rpc(database, 'cfm_load_metric_window_stats', { ...args, input_metric: 'cpu' }),
    [{ client: 'temperature-node', samples: 5, exceeded: 5, avg_value: 37 }]);
});

test('R-A11 an entirely unavailable temperature window cannot satisfy a zero threshold alert', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await database.query("insert into clients(uuid,name) values ('unknown-temperature','Synthetic unavailable sensor')");
  await rpc(database, 'cfm_insert_monitor_record', { input_record: {
    client: 'unknown-temperature', time: '2026-09-09T00:00:00Z', cpu: 25, temp: null,
  } });
  assert.deepEqual(await rpc(database, 'cfm_load_metric_window_stats', {
    input_clients: ['unknown-temperature'], input_start: '2026-09-08T00:00:00Z',
    input_end: '2026-09-10T00:00:00Z', input_threshold: 0, input_metric: 'temp',
  }), []);
});
