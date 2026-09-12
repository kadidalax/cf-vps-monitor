import assert from 'node:assert/strict';
import test from 'node:test';
import { generateToken } from '../src/auth/jwt.ts';
import { generateMfaToken } from '../src/auth/mfa-token.ts';
import { encryptTotpSecret } from '../src/auth/mfa.ts';
import { createRuntimeFixture, runtimeSecrets } from '../test-support/runtime-fixture.mjs';

// The only I/O boundary substituted here is Supabase HTTP -> local PostgreSQL.
// A raw-path policy fails these assertions even while Hono executes the route.
test('R-W01: native sensitive routes require MFA on every equivalent path', { timeout: 90000 }, async t => {
  const fixture = await createRuntimeFixture();
  t.after(() => fixture.close());
  const identity = { userId: 'reaudit-mfa-owner', username: 'reaudit-mfa-owner', sessionVersion: 1 };
  const encrypted = await encryptTotpSecret('JBSWY3DPEHPK3PXP', identity.userId, runtimeSecrets);
  await fixture.database.query(
    'insert into users(uuid, username, passwd, session_version, totp_secret_enc, totp_enabled_at) values($1,$2,$3,$4,$5,now())',
    [identity.userId, identity.username, 'unused-synthetic-password-hash', 1, encrypted],
  );
  await fixture.database.query('insert into clients(uuid,name,token) values($1,$2,$3)', ['synthetic-node', 'Synthetic node', 'synthetic-node-token']);
  const session = await generateToken(identity.userId, identity.username, 1, runtimeSecrets);
  const stepUp = await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, runtimeSecrets);
  const csrf = 'c'.repeat(32);
  const cookie = `cf_monitor_session=${session}; cf_monitor_csrf=${csrf}`;
  const paired = { Cookie: cookie, 'X-CSRF-Token': csrf };
  const post = (path, headers = paired) => fixture.fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1', ...headers }, body: '{}',
  });
  // A broken authorization check can execute destructive fixture operations.
  // Restore each case's identity/row so one failure cannot invalidate controls.
  t.beforeEach(async () => {
    await fixture.database.query(
      'update users set session_version=1, totp_secret_enc=$1, totp_enabled_at=now() where uuid=$2',
      [encrypted, identity.userId],
    );
    await fixture.database.query(
      'insert into clients(uuid,name,token) values($1,$2,$3) on conflict(uuid) do update set token=excluded.token, token_hash=null',
      ['synthetic-node', 'Synthetic node', 'synthetic-node-token'],
    );
  });

  const protectedPaths = [
    '/api/admin/clients/synthetic-node/token',
    '/api/admin/clients/synthetic-node/%74oken',
    '/api/%61dmin/clients/synthetic-node/token',
    '/api/admin/clients/synthetic%2Dnode/%74oken',
    '/api/admin/account/%75sername',
    '/api/admin/account/%63hpasswd',
    '/api/admin/clients/%62atch-remove',
    '/api/admin/record/%63lear',
    '/api/admin/record/clear/%61ll',
    '/api/admin/download/%62ackup',
    '/api/admin/upload/%62ackup',
    '/api/admin/account/mfa/%73etup',
    '/api/admin/account/mfa/%65nable',
    '/api/admin/account/mfa/%72ecovery-codes',
    '/api/admin/account/mfa/%64isable',
    '/api/admin/clients/synthetic-node/%72emove',
    '/api/admin/clients/synthetic-node/token/%69nstall',
    '/api/admin/clients/synthetic-node/token/%72otate',
  ];
  for (const path of protectedPaths) {
    await t.test(`no step-up: ${path}`, async () => {
      const response = await post(path);
      assert.equal(response.status, 428, 'The matched sensitive route must require step-up before execution');
      assert.equal((await response.json()).code, 'MFA_STEP_UP_REQUIRED');
    });
  }

  await t.test('anonymous and unpaired CSRF are still rejected', async () => {
    const path = '/api/%61dmin/clients/synthetic-node/%74oken';
    assert.equal((await post(path, {})).status, 401);
    assert.equal((await post(path, { Cookie: cookie })).status, 403);
  });

  await t.test('canonical and encoded paths execute with a valid matching step-up', async () => {
    const headers = { ...paired, Cookie: `${cookie}; cf_monitor_mfa_stepup=${stepUp}` };
    for (const path of protectedPaths.slice(0, 4)) {
      const response = await post(path, headers);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).token, 'synthetic-node-token');
    }
  });
});
