import assert from 'node:assert/strict';
import test from 'node:test';
import { isDemoResetEnabled, shouldRunDemoReset } from './demo-reset-schedule.ts';

test('demo reset only enables on explicit truthy values', () => {
  assert.equal(isDemoResetEnabled('true'), true);
  assert.equal(isDemoResetEnabled('1'), true);
  assert.equal(isDemoResetEnabled('yes'), true);
  assert.equal(isDemoResetEnabled('on'), true);
  assert.equal(isDemoResetEnabled(undefined), false);
  assert.equal(isDemoResetEnabled('false'), false);
});

test('demo reset runs only after the configured interval', () => {
  const now = Date.parse('2026-06-25T12:30:00Z');
  const intervalMs = 30 * 60 * 1000;

  assert.equal(shouldRunDemoReset({ enabled: false, snapshotExists: true, lastRestoredAt: null, now, intervalMs }), false);
  assert.equal(shouldRunDemoReset({ enabled: true, snapshotExists: false, lastRestoredAt: null, now, intervalMs }), false);
  assert.equal(shouldRunDemoReset({ enabled: true, snapshotExists: true, lastRestoredAt: null, now, intervalMs }), true);
  assert.equal(shouldRunDemoReset({
    enabled: true,
    snapshotExists: true,
    lastRestoredAt: '2026-06-25T12:05:00Z',
    now,
    intervalMs,
  }), false);
  assert.equal(shouldRunDemoReset({
    enabled: true,
    snapshotExists: true,
    lastRestoredAt: '2026-06-25T12:00:00Z',
    now,
    intervalMs,
  }), true);
});
