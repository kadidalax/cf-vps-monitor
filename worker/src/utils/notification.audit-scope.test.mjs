import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLoadNotificationInput } from './notification.ts';

const base = { name: 'synthetic rule', metric: 'cpu', threshold: 0, ratio: 0, interval_min: 15 };
const clients = new Set(['node-a']);

test('AUD-45: an explicitly directed empty rule cannot silently become global', () => {
  assert.equal(validateLoadNotificationInput({ ...base, all_clients: false, clients: [] }, clients).ok, false);
  const directed = validateLoadNotificationInput({ ...base, all_clients: false, clients: ['node-a'] }, clients);
  assert.equal(directed.ok, true);
  assert.deepEqual(directed.item.clients, ['node-a']);
  assert.equal(directed.item.threshold, 0);
  assert.equal(directed.item.ratio, 0);
  assert.equal(validateLoadNotificationInput({ ...base, all_clients: true, clients: [] }, clients).ok, true);
  assert.equal(validateLoadNotificationInput({ ...base, clients: [] }, clients).ok, true, 'legacy global rule remains supported');
});
