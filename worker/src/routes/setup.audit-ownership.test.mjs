import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const env = { JWT_SECRET: 'synthetic-audit-jwt-key-at-least-32-bytes', SUPABASE_SECRET_KEY: 'sb_secret_synthetic_owner_proof' };
const input = { username: 'synthetic-admin', password: 'synthetic-passphrase-937' };

function fixture({ initial = null, race = false } = {}) {
  let user = initial;
  let resetCalls = 0;
  const jobs = [];
  const db = {
    countUsers: async () => {
      const count = user ? 1 : 0;
      if (race) user = { uuid: 'original-owner', username: 'original-owner', password: 'original-hash', session_version: 1 };
      return count;
    },
    createInitialAdmin: async (_database, uuid, username, password) => {
      if (user) return false;
      user = { uuid, username, password, session_version: 1 };
      return true;
    },
    recoverSingleAdmin: async (_database, candidate) => {
      resetCalls += 1;
      user = { uuid: user?.uuid || candidate.uuid, username: candidate.username, password: candidate.hashedPassword, session_version: (user?.session_version || 0) + 1 };
      return user;
    },
    insertAuditLog: async () => {},
  };
  const { publicRoutes } = createWorkerLoader({ db }).load('worker/src/routes/public.ts');
  return {
    get user() { return user; }, get resetCalls() { return resetCalls; },
    async request(body) {
      const response = await publicRoutes.fetch(new Request('https://panel.example.test/admin/recovery', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
        body: JSON.stringify(body),
      }), env, { waitUntil: job => jobs.push(job), passThroughOnException() {} });
      await Promise.all(jobs.splice(0));
      return response;
    },
  };
}

test('AUD-05: first administrator creation requires deployment ownership proof', async () => {
  for (const key of [undefined, 'wrong-synthetic-key']) {
    const f = fixture();
    const response = await f.request({ ...input, supabase_secret_key: key });
    assert.equal(response.status, 403);
    assert.equal(f.user, null);
    assert.equal(f.resetCalls, 0);
  }
  const f = fixture();
  const response = await f.request({ ...input, supabase_secret_key: env.SUPABASE_SECRET_KEY });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'created');
  assert.equal(f.user.username, input.username);
  assert.equal(f.resetCalls, 0, 'creation must never call create-or-reset');
});

test('AUD-05: stale empty-account observation cannot reset a concurrently created administrator', async () => {
  const f = fixture({ race: true });
  const response = await f.request({ ...input, supabase_secret_key: env.SUPABASE_SECRET_KEY });
  assert.equal(response.status, 409);
  assert.equal(f.user.username, 'original-owner');
  assert.equal(f.user.password, 'original-hash');
  assert.equal(f.resetCalls, 0);
});

test('AUD-05: authenticated recovery of the existing sole administrator remains available', async () => {
  const f = fixture({ initial: { uuid: 'old-owner', username: 'old-owner', session_version: 3 } });
  const response = await f.request({ ...input, supabase_secret_key: env.SUPABASE_SECRET_KEY });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'reset');
  assert.equal(f.user.uuid, 'old-owner');
  assert.equal(f.user.session_version, 4);
});
