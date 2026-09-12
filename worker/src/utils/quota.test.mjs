import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuotaReference } from './quota.ts';

test('AUD-16 quota references keep Workers monthly included requests separate from daily free limits', () => {
  const quota = buildQuotaReference();
  assert.equal(quota.workers.requests_per_day?.paid_included, undefined, 'monthly included usage cannot be advertised as a daily limit');
  assert.equal(quota.workers.requests?.daily_free, 100_000);
  assert.equal(quota.workers.requests?.monthly_included, 10_000_000);
  assert.equal(quota.workers.requests.comparison_month_days, 30);
  assert.ok(1_000_000 * quota.workers.requests.comparison_month_days > quota.workers.requests.monthly_included);
  assert.equal(quota.durable_objects.requests.monthly_included, 1_000_000, 'DO included requests are billed separately');
  assert.equal(quota.durable_objects.rows_written.daily_free, 100_000);
});
