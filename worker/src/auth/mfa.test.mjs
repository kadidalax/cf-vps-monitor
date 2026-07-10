import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from './mfa.ts';

const env = { JWT_SECRET: '0123456789abcdef0123456789abcdef' };

test('encrypts TOTP secrets with random IV and user-bound authentication', async () => {
  const first = await encryptTotpSecret('JBSWY3DPEHPK3PXP', 'user-a', env);
  const second = await encryptTotpSecret('JBSWY3DPEHPK3PXP', 'user-a', env);

  assert.notEqual(first, second);
  assert.equal(await decryptTotpSecret(first, 'user-a', env), 'JBSWY3DPEHPK3PXP');
  await assert.rejects(() => decryptTotpSecret(first, 'user-b', env));
  const [version, iv, data] = first.split('.');
  const tamperedData = `${data.startsWith('A') ? 'B' : 'A'}${data.slice(1)}`;
  await assert.rejects(() => decryptTotpSecret(`${version}.${iv}.${tamperedData}`, 'user-a', env));
  await assert.rejects(() => decryptTotpSecret(first, 'user-a', { JWT_SECRET: 'abcdef0123456789abcdef0123456789' }));
});

test('generates eight unique 120-bit recovery codes and stable hashes', async () => {
  const result = await generateRecoveryCodes(env);
  assert.equal(result.codes.length, 8);
  assert.equal(result.hashes.length, 8);
  assert.equal(new Set(result.codes).size, 8);
  assert.equal(new Set(result.hashes).size, 8);
  for (const code of result.codes) {
    assert.match(code, /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/);
  }

  const normalized = normalizeRecoveryCode(` ${result.codes[0].toLowerCase()} `);
  assert.equal(normalized, result.codes[0].replaceAll('-', ''));
  assert.equal(await hashRecoveryCode(result.codes[0], env), result.hashes[0]);
  assert.equal(await hashRecoveryCode(normalized, env), result.hashes[0]);
});

test('rejects malformed recovery codes', () => {
  assert.throws(() => normalizeRecoveryCode('short'), /恢复码/);
  assert.throws(() => normalizeRecoveryCode('ABCD-EFGH-IJKL-MNOP-QRST-UVWX!'), /恢复码/);
});
