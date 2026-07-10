const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_SECRET_BYTES = 20;
const encoder = new TextEncoder();

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const normalized = input.trim().toUpperCase().replace(/=+$/g, '');
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error('Base32 密钥格式无效');
  }

  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Base32 密钥格式无效');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES)));
}

function counterBytes(step: number): Uint8Array {
  const output = new Uint8Array(8);
  let value = BigInt(step);
  for (let index = output.length - 1; index >= 0; index -= 1) {
    output[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return output;
}

async function codeForStep(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(step)));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = (
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff)
  ) >>> 0;
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

export async function generateTotpCode(secret: string, timestamp = Date.now()): Promise<string> {
  return codeForStep(secret, Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS));
}

export async function verifyTotpCode(
  secret: string,
  code: string,
  timestamp = Date.now(),
): Promise<{ valid: boolean; step?: number }> {
  if (!/^\d{6}$/.test(code)) return { valid: false };
  const currentStep = Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS);
  for (const offset of [0, -1, 1]) {
    const step = currentStep + offset;
    if (step >= 0 && constantTimeEqual(await codeForStep(secret, step), code)) {
      return { valid: true, step };
    }
  }
  return { valid: false };
}

export function buildTotpUri(input: { secret: string; username: string; issuer?: string }): string {
  const issuer = (input.issuer || 'CF VPS Monitor').trim();
  const username = input.username.trim();
  const label = `${issuer}:${username}`;
  const query = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}
