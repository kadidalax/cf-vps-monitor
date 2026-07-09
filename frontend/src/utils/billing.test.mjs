import assert from 'node:assert/strict';

const { getExpiryInfo } = await import('./billing.ts');

const now = Date.parse('2026-07-09T00:00:00Z');

assert.deepEqual(getExpiryInfo('2026-08-09T00:00:00Z', now), { label: '剩 31天', color: 'green' });
assert.deepEqual(getExpiryInfo('2026-08-08T00:00:00Z', now), { label: '剩 30天', color: 'yellow' });
assert.deepEqual(getExpiryInfo('2026-07-16T00:00:00Z', now), { label: '剩 7天', color: 'yellow' });
assert.deepEqual(getExpiryInfo('2026-07-15T00:00:00Z', now), { label: '剩 6天', color: 'red' });
assert.deepEqual(getExpiryInfo('2026-07-09T00:00:00Z', now), { label: '已到期', color: 'red' });
assert.deepEqual(getExpiryInfo('', now), { label: '', color: 'gray' });
assert.deepEqual(getExpiryInfo('not-a-date', now), { label: '', color: 'gray' });
