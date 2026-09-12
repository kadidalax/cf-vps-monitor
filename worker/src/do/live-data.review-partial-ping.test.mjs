import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableState, createWorkerLoader } from '../../test-support/worker-module.mjs';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';

test('V-W01 review: retry after partial local interval-state persistence does not duplicate a saved task', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await database.query("insert into clients(uuid,name) values ('review-node','Synthetic partial persistence review')");
  const tasks = [1, 2].map(id => ({ id, name: `Task ${id}`, type: 'tcp', target: 'example.test:443', all_clients: true, clients: [], interval_sec: 120 }));
  const external = {
    getSettingsByKeys: async () => ({ record_enabled: 'true', ping_record_persist_interval_sec: '120' }),
    getHistoryStorageRowCounts: async () => ({ records: 0, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0 }),
    getHistoryStorageBytes: async () => ({ total: 0 }),
    getHistoryStorageUsage: async () => ({ live_rows: 0, live_row_bytes: 0, estimated_live_storage_bytes: 0, allocated_bytes: 0, reusable_bytes: null, measurement: 'live-row-bytes-plus-index-estimate' }),
    listPingTasks: async () => tasks,
    getSetting: async () => null, setSetting: async () => {},
    tryClaimAuditThrottle: async () => true, insertAuditLog: async () => {},
    insertPingSnapshot: async (_db, client, time, results) => rpc(database, 'cfm_insert_ping_snapshot', {
      input_client: client, input_time: time, input_results: results,
    }),
  };
  const { LiveDataDO } = createWorkerLoader({ db: external }).load('worker/src/do/live-data.ts');
  for (const cold of [false, true]) {
    await t.test(cold ? 'cold retry' : 'same-object retry', async () => {
      await database.exec('delete from ping_snapshots');
      const state = createDurableState();
      let object = new LiveDataDO(state.state, {});
      await state.drain();
      const secondKey = object.pingResultStateKey('review-node', 2);
      const originalPut = state.state.storage.put;
      let failed = false;
      state.state.storage.put = async (key, value) => {
        const containsSecondTask = key === secondKey || (key && typeof key === 'object' && Object.hasOwn(key, secondKey));
        if (containsSecondTask && !failed) { failed = true; throw new Error('Synthetic interval storage failure'); }
        return originalPut(key, value);
      };
      const at = Date.now();
      const batch = { results: [{ task_id: 1, value: 10 }, { task_id: 2, value: 20 }] };
      await assert.rejects(object.persistPingResult('review-node', batch, at), /Synthetic interval storage failure/);
      const firstRows = (await database.query('select values_json from ping_snapshots')).rows;
      assert.deepEqual(firstRows.map(row => row.values_json), [{ 1: 10, 2: 20 }], 'both task values reached real SQL before the local-state failure');
      if (cold) { object = new LiveDataDO(state.state, {}); await state.drain(); }
      await object.persistPingResult('review-node', batch, at);
      const rows = (await database.query('select values_json from ping_snapshots order by id')).rows;
      const occurrences = rows.filter(row => Object.hasOwn(row.values_json, '2')).length;
      assert.equal(occurrences, 1, 'an identical retry must not append the already saved second task after only its interval-state write failed');
    });
  }
});
