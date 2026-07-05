import assert from 'node:assert/strict';

const { moveAdminNodeInVisibleOrder } = await import('./adminNodeOrder.ts');

const clients = [
  { uuid: 'a', name: 'A', sort_order: 1 },
  { uuid: 'h', name: 'Hidden', hidden: true, sort_order: 2 },
  { uuid: 'b', name: 'B', sort_order: 3 },
  { uuid: 'c', name: 'C', sort_order: 4 },
];
const visible = [clients[0], clients[2], clients[3]];

assert.deepEqual(
  moveAdminNodeInVisibleOrder(clients, visible, 'c', 'a').map((client) => `${client.sort_order}:${client.uuid}`),
  ['1:c', '2:h', '3:a', '4:b'],
);
