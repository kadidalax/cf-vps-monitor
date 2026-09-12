import assert from 'node:assert/strict';
import test from 'node:test';
import { sign } from 'hono/jwt';
import { generateToken, verifyAdminToken } from './jwt.ts';
import { generateMfaSetupToken, generateMfaToken, verifyMfaToken } from './mfa-token.ts';

const env = { JWT_SECRET: 'audit-synthetic-key-at-least-32-bytes' };
const identity = { userId: 'synthetic-admin', username: 'audit-owner', sessionVersion: 1 };

test('AUD-01: temporary MFA credentials cannot authenticate an administrator session', async () => {
  const session = await generateToken(identity.userId, identity.username, identity.sessionVersion, env);
  assert.deepEqual(await verifyAdminToken(session, env), identity);
  assert.equal(await verifyMfaToken(session, 'mfa-login', env), null);

  const tokens = [
    await generateMfaToken({ ...identity, purpose: 'mfa-login' }, env),
    await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, env),
    await generateMfaSetupToken({ ...identity, encryptedSecret: 'synthetic-enrollment' }, env),
  ];
  for (const token of tokens) {
    assert.equal(await verifyAdminToken(token, env), null, 'An unfinished MFA credential must never grant a full session');
  }
});

test('AUD-01: legacy untyped JWTs require login again', async () => {
  const now = Math.floor(Date.now() / 1000);
  const legacy = await sign({ ...identity, iat: now, exp: now + 300 }, env.JWT_SECRET, 'HS256');
  assert.equal(await verifyAdminToken(legacy, env), null);
});

test('AUD-01: signature, expiry and session-version checks remain effective', async () => {
  const token = await generateToken(identity.userId, identity.username, 1, env);
  const [header, payload, signature] = token.split('.');
  const corrupted = `${header}.${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
  await assert.rejects(() => verifyAdminToken(corrupted, env));
  const expired = await sign({
    ...identity, kind: 'cf-monitor-session', purpose: 'admin-session', iat: 1, exp: 2,
  }, env.JWT_SECRET, 'HS256');
  await assert.rejects(() => verifyAdminToken(expired, env));
  const invalidVersion = await generateToken(identity.userId, identity.username, 0, env);
  assert.equal(await verifyAdminToken(invalidVersion, env), null);
});
