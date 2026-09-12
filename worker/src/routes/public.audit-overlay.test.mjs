import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const row = { uuid: 'node', name: 'old name', hidden: false, price: 9, billing_cycle: 30, currency: '$', expired_at: '2027-01-01T00:00:00Z', public_remark: 'old', tags: '', updated_at: '2026-09-06T01:00:00Z' };
const newer = '2026-09-06T02:00:00Z';

async function publicClients(databaseRow, overlayRow) {
  const db = { listPublicClientRows: async () => [structuredClone(databaseRow)] };
  const { publicRoutes } = createWorkerLoader({ db }).load('worker/src/routes/public.ts');
  const env = { LIVE_DATA: { idFromName: id => id, get: () => ({ fetch: async () => Response.json({ clients: [overlayRow], removed: [] }) }) } };
  const jobs = [];
  const response = await publicRoutes.fetch(new Request('https://panel.example.test/clients?fresh=1'), env, { waitUntil: job => jobs.push(job), passThroughOnException() {} });
  assert.equal(response.status, 200);
  await Promise.all(jobs);
  return response.json();
}

test('AUD-02: administrative token-use addresses and unknown metadata never enter public REST', async () => {
  const clients = await publicClients(row, { ...row, token_last_used_ip: '10.77.0.5', token_hash: 'synthetic-secret', unknown_extension: 'synthetic-secret' });
  const bytes = JSON.stringify(clients);
  assert.ok(!bytes.includes('10.77.0.5'));
  assert.ok(!bytes.includes('synthetic-secret'));
  assert.equal(clients[0].name, row.name);
});

test('AUD-03: a newer hidden overlay removes a node from an earlier public database read', async () => {
  assert.deepEqual(await publicClients(row, { ...row, hidden: true, updated_at: newer }), []);
});

test('AUD-03: a stale or unversioned public overlay cannot resurrect an authoritative hidden node', async () => {
  for (const overlay of [row, { uuid: row.uuid, name: 'unversioned', hidden: false }]) {
    assert.deepEqual(await publicClients({ ...row, hidden: true, updated_at: newer }, overlay), []);
  }
});

test('AUD-41: explicit zero and empty metadata survive public REST overlays', async () => {
  const clients = await publicClients(row, { ...row, price: 0, billing_cycle: 0, currency: '', expired_at: '', public_remark: '', updated_at: newer });
  assert.equal(clients[0].price, 0);
  assert.equal(clients[0].billing_cycle, 0);
  assert.equal(clients[0].currency, '');
  assert.equal(clients[0].expired_at, '');
  assert.equal(clients[0].public_remark, '');
});

test('AUD-41: a stale DO overlay does not replace newer database metadata', async () => {
  const clients = await publicClients({ ...row, name: 'new database name', price: 12, updated_at: newer }, row);
  assert.equal(clients[0].name, 'new database name');
  assert.equal(clients[0].price, 12);
});
