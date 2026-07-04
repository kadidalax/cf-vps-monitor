const PASSWORD_ALGORITHM = 'pbkdf2_sha256';
const PBKDF2_ITERATIONS = 10000;
const MIN_ACCEPTED_PBKDF2_ITERATIONS = 10000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const LEGACY_SALT = 'cf-monitor-salt';
const LEGACY_SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const MIN_ADMIN_PASSWORD_LENGTH = 6;

type ParsedPasswordHash = {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
};

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  return constantTimeEqual(encoder.encode(a), encoder.encode(b));
}

async function derivePbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

async function hashLegacyPassword(password: string): Promise<string> {
  const data = encoder.encode(password + LEGACY_SALT);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function parsePasswordHash(hash: string): ParsedPasswordHash | null {
  const parts = hash.split('$');
  if (parts.length !== 4) {
    return null;
  }

  const [algorithm, iterationsText, saltText, hashText] = parts;
  if (algorithm !== PASSWORD_ALGORITHM || !iterationsText || !saltText || !hashText) {
    return null;
  }

  const iterations = Number.parseInt(iterationsText, 10);
  const salt = base64ToBytes(saltText);
  const storedHash = base64ToBytes(hashText);

  if (
    !Number.isInteger(iterations) ||
    iterations < MIN_ACCEPTED_PBKDF2_ITERATIONS ||
    !salt ||
    salt.length < SALT_BYTES ||
    !storedHash ||
    storedHash.length !== HASH_BYTES
  ) {
    return null;
  }

  return { iterations, salt, hash: storedHash };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${PASSWORD_ALGORITHM}$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export function needsPasswordRehash(hash: string): boolean {
  const parsed = parsePasswordHash(hash);
  return parsed === null || parsed.iterations < PBKDF2_ITERATIONS;
}

export function validateAdminPasswordStrength(password: string, _username = ''): string | null {
  if (Array.from(password).length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 位`;
  }

  return null;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parsePasswordHash(hash);
  if (parsed) {
    const computed = await derivePbkdf2(password, parsed.salt, parsed.iterations);
    return constantTimeEqual(computed, parsed.hash);
  }

  if (!LEGACY_SHA256_HEX_RE.test(hash)) {
    return false;
  }

  const computedLegacyHash = await hashLegacyPassword(password);
  return constantTimeStringEqual(computedLegacyHash, hash.toLowerCase());
}
