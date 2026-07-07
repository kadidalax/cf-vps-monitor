import assert from 'node:assert/strict';

const { validatePingTaskInput } = await import('./ping-task.ts');

const baseTask = {
  name: 'icmp',
  type: 'icmp',
  interval_sec: 120,
  all_clients: true,
};

assert.equal(
  validatePingTaskInput({ ...baseTask, target: 'example.com:80' }).ok,
  false,
);

assert.equal(
  validatePingTaskInput({ ...baseTask, target: 'example.com' }).ok,
  true,
);

assert.equal(
  validatePingTaskInput({ ...baseTask, target: '2606:4700:4700::1111' }).ok,
  true,
);
