import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  buildTotpUri,
  generateTotpCode,
  verifyTotpCode,
} from './totp.ts';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const vectors = [
  [59_000, '287082'],
  [1_111_111_109_000, '081804'],
  [1_111_111_111_000, '050471'],
  [1_234_567_890_000, '005924'],
  [2_000_000_000_000, '279037'],
  [20_000_000_000_000, '353130'],
];

test('generates RFC 6238 SHA-1 codes truncated to six digits', async () => {
  for (const [timestamp, expected] of vectors) {
    assert.equal(await generateTotpCode(RFC_SECRET, Number(timestamp)), expected);
  }
});

test('base32 round-trips bytes and rejects invalid characters', () => {
  const bytes = new TextEncoder().encode('12345678901234567890');
  assert.equal(base32Encode(bytes), RFC_SECRET);
  assert.deepEqual(base32Decode(RFC_SECRET.toLowerCase()), bytes);
  assert.throws(() => base32Decode('INVALID!'), /Base32/);
});

test('verifies current, previous and next time steps only', async () => {
  const timestamp = 1_700_000_000_000;
  const current = await generateTotpCode(RFC_SECRET, timestamp);
  const previous = await generateTotpCode(RFC_SECRET, timestamp - 30_000);
  const next = await generateTotpCode(RFC_SECRET, timestamp + 30_000);
  const old = await generateTotpCode(RFC_SECRET, timestamp - 60_000);

  assert.equal((await verifyTotpCode(RFC_SECRET, current, timestamp)).valid, true);
  assert.equal((await verifyTotpCode(RFC_SECRET, previous, timestamp)).valid, true);
  assert.equal((await verifyTotpCode(RFC_SECRET, next, timestamp)).valid, true);
  assert.equal((await verifyTotpCode(RFC_SECRET, old, timestamp)).valid, false);
  assert.equal((await verifyTotpCode(RFC_SECRET, '12345', timestamp)).valid, false);
});

test('builds a compatible otpauth URI with matching issuer fields', () => {
  const uri = new URL(buildTotpUri({ secret: RFC_SECRET, username: 'admin name' }));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.hostname, 'totp');
  assert.equal(uri.searchParams.get('secret'), RFC_SECRET);
  assert.equal(uri.searchParams.get('issuer'), 'CF VPS Monitor');
  assert.equal(uri.searchParams.get('algorithm'), 'SHA1');
  assert.equal(uri.searchParams.get('digits'), '6');
  assert.equal(uri.searchParams.get('period'), '30');
  assert.match(decodeURIComponent(uri.pathname), /CF VPS Monitor:admin name/);
});
