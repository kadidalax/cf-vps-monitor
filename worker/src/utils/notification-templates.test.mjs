import assert from 'node:assert/strict';
import { buildNodeRecoveryNotification } from './notification-templates.ts';

const notification = buildNodeRecoveryNotification({
  nodeName: '首尔节点',
  recoveredAt: '2026-07-12T04:09:00.000Z',
  eventTime: '2026-07-12T04:10:00.000Z',
});

assert.equal(notification.event, '恢复上线');
assert.equal(notification.clients, '首尔节点');
assert.match(notification.body, /节点已恢复上报/);
assert.match(notification.body, /2026-07-12 12:09:00/);
