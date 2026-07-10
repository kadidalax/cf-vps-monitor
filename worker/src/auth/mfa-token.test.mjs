import assert from 'node:assert/strict';
import test from 'node:test';
import { generateMfaSetupToken, generateMfaToken, verifyMfaSetupToken, verifyMfaToken } from './mfa-token.ts';
import { AuthConfigurationError } from './jwt.ts';

const env = { JWT_SECRET: '0123456789abcdef0123456789abcdef' };
const identity = {
  userId: 'user-1',
  username: 'admin',
  sessionVersion: 3,
};

test('keeps login challenges and step-up tokens purpose-isolated', async () => {
  const token = await generateMfaToken({ ...identity, purpose: 'mfa-login' }, env);
  assert.deepEqual(await verifyMfaToken(token, 'mfa-login', env), {
    ...identity,
    purpose: 'mfa-login',
  });
  assert.equal(await verifyMfaToken(token, 'mfa-step-up', env), null);
});

test('rejects expired and tampered MFA tokens', async () => {
  const expired = await generateMfaToken({ ...identity, purpose: 'mfa-login' }, env, 1_700_000_000_000);
  assert.equal(await verifyMfaToken(expired, 'mfa-login', env), null);

  const current = await generateMfaToken({ ...identity, purpose: 'mfa-login' }, env);
  const [header, payload, signature] = current.split('.');
  const tampered = `${header}.${payload}.${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`;
  assert.equal(await verifyMfaToken(tampered, 'mfa-login', env), null);
});

test('exposes the session version required for database validation', async () => {
  const token = await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, env);
  const payload = await verifyMfaToken(token, 'mfa-step-up', env);
  assert.equal(payload?.sessionVersion, 3);
  assert.notEqual(payload?.sessionVersion, 4);
});
test('preserves JWT configuration errors for a clear server response', async () => {
  await assert.rejects(
    () => verifyMfaToken('invalid', 'mfa-login', { JWT_SECRET: 'short' }),
    AuthConfigurationError,
  );
});
test('binds the encrypted enrollment secret to a short-lived setup token', async () => {
  const token = await generateMfaSetupToken({ ...identity, encryptedSecret: 'v1.iv.ciphertext' }, env);
  assert.deepEqual(await verifyMfaSetupToken(token, env), {
    ...identity,
    encryptedSecret: 'v1.iv.ciphertext',
  });
  assert.equal(await verifyMfaToken(token, 'mfa-login', env), null);
});