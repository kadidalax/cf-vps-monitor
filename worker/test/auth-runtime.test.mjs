import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { generateMfaSetupToken, generateMfaToken } from '../src/auth/mfa-token.ts';
import { generateToken } from '../src/auth/jwt.ts';
import { encryptTotpSecret, generateRecoveryCodes } from '../src/auth/mfa.ts';
import { generateTotpCode } from '../src/auth/totp.ts';
import { cookieJar, createRuntimeFixture, runtimeSecrets } from '../test-support/runtime-fixture.mjs';

test('AUD-01/AUD-05: actual workerd, middleware and PostgreSQL enforce complete authentication', { timeout: 90000 }, async t => {
  const f = await createRuntimeFixture();
  t.after(() => f.close());
  const credentials = { username: 'synthetic-owner', password: 'synthetic-password-937' };
  const post = (path, body, headers = {}) => f.fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1', ...headers }, body: JSON.stringify(body),
  });
  await t.test('initial ownership and a real pair of stale HTTP observations', async () => {
    assert.equal((await post('/api/admin/recovery', credentials)).status, 403);
    f.synchronizeInitialCreation();
    const responses = await Promise.all([1, 2].map(() => post('/api/admin/recovery', { ...credentials, supabase_secret_key: runtimeSecrets.SUPABASE_SECRET_KEY })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal((await f.database.query('select count(*)::int as count from users')).rows[0].count, 1);
  });

  const user = (await f.database.query('select uuid, username, session_version from users')).rows[0];
  const identity = { userId: user.uuid, username: user.username, sessionVersion: user.session_version };
  const secret = 'JBSWY3DPEHPK3PXP';
  const encryptedSecret = await encryptTotpSecret(secret, user.uuid, runtimeSecrets);
  const recovery = await generateRecoveryCodes(runtimeSecrets);
  await f.database.query('update users set totp_secret_enc=$1, totp_enabled_at=now(), recovery_code_hashes=$2::jsonb where uuid=$3', [encryptedSecret, JSON.stringify(recovery.hashes), user.uuid]);

  await t.test('all declared admin routes reject anonymous requests', async () => {
    const routes = [];
    for (const [file, owner, prefix] of [
      ['admin.ts', 'adminRoutes', '/api/admin'], ['theme.ts', 'adminThemeRoutes', '/api/admin/themes'],
    ]) {
      const source = await readFile(new URL(`../src/routes/${file}`, import.meta.url), 'utf8');
      const pattern = new RegExp(`${owner}\\.(get|post|put|patch|delete)\\('([^']+)'`, 'g');
      for (const match of source.matchAll(pattern)) routes.push([match[1].toUpperCase(), prefix + match[2]]);
    }
    routes.push(['POST', '/api/admin/cron/run']);
    assert.ok(routes.length >= 60);
    for (const [method, template] of routes) {
      const path = template.replace(/:uuid/g, 'synthetic-node').replace(/:id/g, '1').replace(/:short/g, 'synthetic-theme');
      const response = await f.fetch(path, { method, ...(method === 'GET' ? {} : { body: '{}' }) });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    t.diagnostic(`${routes.length} protected admin route declarations denied anonymous access`);
  });

  const login = await post('/api/login', credentials);
  assert.equal(login.status, 200, await login.clone().text());
  const challenge = await login.json();
  assert.equal(challenge.code, 'MFA_REQUIRED');
  await t.test('the actual login challenge and every other MFA purpose fail session authentication', async () => {
    const temporary = [
      challenge.challenge,
      await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, runtimeSecrets),
      await generateMfaSetupToken({ ...identity, encryptedSecret }, runtimeSecrets),
    ];
    for (const token of temporary) {
      const headers = { Cookie: `cf_monitor_session=${token}; cf_monitor_csrf=${'a'.repeat(32)}`, 'X-CSRF-Token': 'a'.repeat(32) };
      assert.equal((await f.fetch('/api/admin/clients?refresh=1', { headers })).status, 401);
      assert.equal((await post('/api/admin/notification/load/add', {}, headers)).status, 401);
    }
    const invalidVersion = await generateToken(user.uuid, user.username, user.session_version + 1, runtimeSecrets);
    assert.equal((await f.fetch('/api/admin/clients', { headers: { Cookie: `cf_monitor_session=${invalidVersion}` } })).status, 401);
  });

  let cookies;
  await t.test('a real OTP completion produces the session required by admin routes', async () => {
    const response = await post('/api/login/mfa', { challenge: challenge.challenge, method: 'totp', code: await generateTotpCode(secret) });
    assert.equal(response.status, 200, await response.clone().text());
    cookies = cookieJar(response);
    assert.ok(cookies.includes('cf_monitor_session='));
    assert.equal((await f.fetch('/api/admin/clients', { headers: { Cookie: cookies } })).status, 200);
  });

  await t.test('CSRF and sensitive-action step-up remain independent requirements', async () => {
    assert.equal((await post('/api/admin/clients/batch-remove', {}, { Cookie: cookies })).status, 403);
    const csrf = /(?:^|; )cf_monitor_csrf=([^;]+)/.exec(cookies)[1];
    const headers = { Cookie: cookies, 'X-CSRF-Token': csrf };
    assert.equal((await post('/api/admin/clients/batch-remove', {}, headers)).status, 428);
    const stepUp = await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, runtimeSecrets);
    const allowed = await post('/api/admin/clients/batch-remove', {}, { ...headers, Cookie: `${cookies}; cf_monitor_mfa_stepup=${stepUp}` });
    assert.equal(allowed.status, 400, await allowed.clone().text());
  });

  await t.test('a recovery code completes login once and cannot be replayed', async () => {
    const next = await (await post('/api/login', credentials)).json();
    const body = { challenge: next.challenge, method: 'recovery_code', code: recovery.codes[0] };
    assert.equal((await post('/api/login/mfa', body)).status, 200);
    assert.equal((await post('/api/login/mfa', body)).status, 401);
  });
});
