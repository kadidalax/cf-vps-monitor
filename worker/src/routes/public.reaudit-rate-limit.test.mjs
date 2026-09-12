import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../scripts/test-support/postgres.mjs';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const now = Date.parse('2026-09-09T00:00:00Z');
const buckets = ['login:ip:synthetic-client', 'login:ip-user:synthetic-client:synthetic-user'];

test('R-W02: authentication failure state remains atomic across stale request observations', async t => {
  const sql = await createTestDatabase();
  t.after(() => sql.close());
  const env = { SUPABASE_URL: 'https://reaudit-database.invalid', SUPABASE_SECRET_KEY: 'sb_secret_synthetic_fixture' };
  const database = { provider: 'supabase', env };
  const loader = createWorkerLoader({ db: null, globals: {
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, env.SUPABASE_URL, 'No external network is allowed');
      assert.ok(url.pathname.startsWith('/rest/v1/rpc/'));
      const args = JSON.parse(init.body);
      try {
        const result = await sql.transaction(async tx => {
          await tx.exec('set local role service_role');
          return rpc(tx, url.pathname.split('/').at(-1), args);
        });
        return Response.json(result ?? null);
      } catch (error) {
        return Response.json({ code: error.code, message: error.message }, { status: 400 });
      }
    },
  } });
  const { recordLoginFailure, loadLoginRateLimitStates, clearLoginFailures, getLoginRetryAfterSeconds } = loader.load('worker/src/routes/public.ts');
  const read = () => loadLoginRateLimitStates(database, buckets);
  t.beforeEach(() => sql.exec('delete from login_rate_limits'));

  await t.test('five requests that observed the same empty bucket count as five failures', async () => {
    const observations = await Promise.all(Array.from({ length: 5 }, read));
    await Promise.all(observations.map(states => recordLoginFailure(database, buckets, now, states)));
    const current = await read();
    for (const bucket of buckets) {
      assert.equal(current.get(bucket).failures, 5, 'Stale observations must not overwrite increments');
      assert.equal(Date.parse(current.get(bucket).locked_until), now + 30_000);
    }
    assert.equal(getLoginRetryAfterSeconds(current, now), 30);
  });

  await t.test('an older in-flight failure cannot remove or shorten a newer lock', async () => {
    const stale = await read();
    for (let count = 0; count < 5; count++) await recordLoginFailure(database, buckets, now);
    const locked = await read();
    assert.equal(getLoginRetryAfterSeconds(locked, now), 30);
    await recordLoginFailure(database, buckets, now - 1000, stale);
    const current = await read();
    for (const bucket of buckets) {
      assert.equal(current.get(bucket).failures, 6);
      assert.ok(Date.parse(current.get(bucket).locked_until) >= now + 30_000);
      assert.ok(Date.parse(current.get(bucket).last_failed_at) >= now);
    }
  });

  await t.test('successful authentication clears its observed state but preserves later failures', async () => {
    await recordLoginFailure(database, buckets, now);
    const observedBySuccess = await read();
    await recordLoginFailure(database, buckets, now + 1);
    await clearLoginFailures(database, buckets, observedBySuccess);
    assert.equal((await read()).get(buckets[0])?.failures, 2, 'A stale success must not delete a newer failure');
    const current = await read();
    await clearLoginFailures(database, buckets, current);
    assert.equal((await read()).get(buckets[0]), null, 'An unchanged observed state can be cleared');
  });

  await t.test('a success that saw no failures does not erase a later newly created bucket', async () => {
    const empty = await read();
    await recordLoginFailure(database, buckets, now);
    await clearLoginFailures(database, buckets, empty);
    assert.equal((await read()).get(buckets[0])?.failures, 1);
  });

  await t.test('a delayed duplicate success cannot clear a recreated bucket with identical timestamps', async () => {
    await recordLoginFailure(database, buckets, now);
    const earlier = await read();
    await clearLoginFailures(database, buckets, earlier);
    await recordLoginFailure(database, buckets, now);
    await clearLoginFailures(database, buckets, earlier);
    assert.equal((await read()).get(buckets[0])?.failures, 1,
      'A recreated bucket is a new failure even when all timing and count fields match');
  });

  await t.test('repeated failures cap the lock and duplicate bucket names count only once', async () => {
    for (let count = 0; count < 40; count++) {
      await recordLoginFailure(database, [...buckets, ...buckets], now);
    }
    const current = await read();
    assert.equal(current.get(buckets[0]).failures, 40);
    assert.equal(getLoginRetryAfterSeconds(current, now), 900);
  });

  await t.test('independent buckets and an expired window retain their existing semantics', async () => {
    await recordLoginFailure(database, buckets, now);
    await recordLoginFailure(database, ['mfa:synthetic-other'], now);
    await recordLoginFailure(database, buckets, now + 16 * 60_000);
    const current = await read();
    assert.equal(current.get(buckets[0]).failures, 1);
    assert.equal(Date.parse(current.get(buckets[0]).first_failed_at), now + 16 * 60_000);
    assert.equal(current.get(buckets[0]).locked_until, null);
    const other = await loadLoginRateLimitStates(database, ['mfa:synthetic-other']);
    assert.equal(other.get('mfa:synthetic-other').failures, 1);
    await clearLoginFailures(database, ['mfa:synthetic-other'], other);
    assert.equal((await loadLoginRateLimitStates(database, ['mfa:synthetic-other'])).get('mfa:synthetic-other'), null);
  });
});
