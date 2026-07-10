import { base32Encode } from './totp.ts';
import { requireJwtSecret } from './jwt.ts';

const encoder = new TextEncoder();
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_BYTES = 15;
const AES_IV_BYTES = 12;
const MFA_KDF_SALT = encoder.encode('cf-vps-monitor/mfa-key/v1');

type MfaEnv = { JWT_SECRET?: string };

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function deriveKey(env: MfaEnv, info: string, usages: Array<'encrypt' | 'decrypt' | 'sign'>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(requireJwtSecret(env)),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const algorithm = info === 'totp-secret-encryption'
    ? { name: 'AES-GCM', length: 256 }
    : { name: 'HMAC', hash: 'SHA-256', length: 256 };
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: MFA_KDF_SALT, info: encoder.encode(info) },
    material,
    algorithm,
    false,
    usages,
  );
}

export async function encryptTotpSecret(secret: string, userId: string, env: MfaEnv): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const key = await deriveKey(env, 'totp-secret-encryption', ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(userId), tagLength: 128 },
    key,
    encoder.encode(secret),
  ));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

export async function decryptTotpSecret(ciphertext: string, userId: string, env: MfaEnv): Promise<string> {
  const [version, ivText, dataText, extra] = ciphertext.split('.');
  if (version !== 'v1' || !ivText || !dataText || extra) throw new Error('TOTP 密文格式无效');
  const iv = base64UrlToBytes(ivText);
  if (iv.length !== AES_IV_BYTES) throw new Error('TOTP 密文格式无效');
  const key = await deriveKey(env, 'totp-secret-encryption', ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(userId), tagLength: 128 },
    key,
    base64UrlToBytes(dataText),
  );
  return new TextDecoder().decode(plaintext);
}

export function normalizeRecoveryCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-7]{24}$/.test(normalized)) throw new Error('恢复码格式无效');
  return normalized;
}

export async function hashRecoveryCode(code: string, env: MfaEnv): Promise<string> {
  const normalized = normalizeRecoveryCode(code);
  const key = await deriveKey(env, 'totp-recovery-code-hmac', ['sign']);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(normalized))));
}

function formatRecoveryCode(raw: string): string {
  return raw.match(/.{1,4}/g)?.join('-') || raw;
}

export async function generateRecoveryCodes(env: MfaEnv): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    formatRecoveryCode(base32Encode(crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES)))),
  );
  return { codes, hashes: await Promise.all(codes.map(code => hashRecoveryCode(code, env))) };
}
