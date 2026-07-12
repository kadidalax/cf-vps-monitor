import assert from 'node:assert/strict';
import { evaluateOfflineNotificationEvent } from './offline-notification.ts';

const now = new Date('2026-07-12T04:10:00.000Z');
const base = {
  now,
  clientCreatedAt: '2026-07-12T03:00:00.000Z',
  gracePeriodSec: 180,
  notifyNeverReported: true,
};

assert.equal(evaluateOfflineNotificationEvent({
  ...base,
  lastTime: '2026-07-12T04:09:00.000Z',
  lastNotified: null,
}), null);

assert.equal(evaluateOfflineNotificationEvent({
  ...base,
  lastTime: '2026-07-12T04:00:00.000Z',
  lastNotified: null,
})?.type, 'offline');

assert.equal(evaluateOfflineNotificationEvent({
  ...base,
  lastTime: '2026-07-12T04:00:00.000Z',
  lastNotified: '2026-07-12T04:04:00.000Z',
}), null);

assert.deepEqual(evaluateOfflineNotificationEvent({
  ...base,
  lastTime: '2026-07-12T04:09:00.000Z',
  lastNotified: '2026-07-12T04:04:00.000Z',
}), {
  type: 'recovery',
  recoveredAt: '2026-07-12T04:09:00.000Z',
});

assert.equal(evaluateOfflineNotificationEvent({
  ...base,
  lastTime: null,
  lastNotified: null,
})?.type, 'offline');

assert.equal(evaluateOfflineNotificationEvent({
  ...base,
  lastTime: '2026-07-12T04:09:00.000Z',
  lastNotified: '2026-07-12T04:04:00.000Z',
  notifyNeverReported: false,
})?.type, 'recovery');
