import assert from 'node:assert/strict';

const { mergePublicClientPatch, normalizePublicClients } = await import('./publicClients.ts');

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

assert.deepEqual(
  mergePublicClientPatch(
    normalizePublicClients(clients, { includeHidden: true }),
    { clients: { upsert: [{ uuid: 'h', name: 'Hidden', hidden: true, sort_order: 2 }] } },
    { includeHidden: true },
  ).map((client) => `${client.uuid}:${client.hidden}`),
  ['a:false', 'h:true', 'b:false'],
);

assert.deepEqual(
  normalizePublicClients([
    { uuid: 'a', name: 'A', hidden: 0, sort_order: 1 },
    { uuid: 'h', name: 'Hidden', hidden: 1, sort_order: 2 },
    { uuid: 'b', name: 'B', hidden: 'false', sort_order: 3 },
  ]).map((client) => client.uuid),
  ['a', 'b'],
);

assert.deepEqual(
  mergePublicClientPatch(
    normalizePublicClients(clients),
    { clients: { upsert: [{ uuid: 'h', name: 'Hidden', hidden: 1, sort_order: 2 }] } },
  ).map((client) => client.uuid),
  ['a', 'b'],
);
