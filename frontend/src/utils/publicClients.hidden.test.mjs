import assert from 'node:assert/strict';

const { normalizePublicClients } = await import('./publicClients.ts');

const clients = [
  { uuid: 'a', name: 'A', sort_order: 1 },
  { uuid: 'h', name: 'Hidden', hidden: true, sort_order: 2 },
  { uuid: 'b', name: 'B', sort_order: 3 },
];

assert.deepEqual(
  normalizePublicClients(clients).map((client) => client.uuid),
  ['a', 'b'],
);

assert.deepEqual(
  normalizePublicClients(clients, { includeHidden: true }).map((client) => client.uuid),
  ['a', 'h', 'b'],
);
