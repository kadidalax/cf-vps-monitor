const encoder = new TextEncoder();
const TOKEN_TTL_MS = 60_000;

type ViewerTokenPayload = {
  exp: number;
  ip: string;
  nonce: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

function randomNonce(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function createViewerToken({
  ip,
  secret,
  ttlMs = TOKEN_TTL_MS,
  now = Date.now(),
}: {
  ip: string;
  secret: string;
  ttlMs?: number;
  now?: number;
}): Promise<{ token: string; expires_at: number }> {
  const boundedTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : TOKEN_TTL_MS;
  const payload: ViewerTokenPayload = {
    exp: now + boundedTtlMs,
    ip,
    nonce: randomNonce(),
  };
  const payloadText = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await signPayload(payloadText, secret);
  return {
    token: `${payloadText}.${signature}`,
    expires_at: payload.exp,
  };
}

export async function verifyViewerToken({
  token,
  ip,
  secret,
  now = Date.now(),
}: {
  token: string;
  ip: string;
  secret: string;
  now?: number;
}): Promise<boolean> {
  const [payloadText, signature, extra] = token.split('.');
  if (!payloadText || !signature || extra !== undefined) return false;

  const expectedSignature = await signPayload(payloadText, secret);
  if (!constantTimeEqual(signature, expectedSignature)) return false;

  const payloadBytes = base64UrlToBytes(payloadText);
  if (!payloadBytes) return false;

  let payload: ViewerTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return false;
  }

  if (typeof payload.exp !== 'number' || payload.exp < now) return false;
  if (typeof payload.ip !== 'string' || payload.ip !== ip) return false;
  if (typeof payload.nonce !== 'string' || payload.nonce.length < 16) return false;
  return true;
}
