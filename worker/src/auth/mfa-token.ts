import { sign, verify } from 'hono/jwt';
import { requireJwtSecret } from './jwt.ts';

const MFA_TOKEN_TTL_SECONDS = 5 * 60;

type MfaEnv = { JWT_SECRET?: string };
export type MfaTokenPurpose = 'mfa-login' | 'mfa-step-up';

export type MfaTokenIdentity = {
  userId: string;
  username: string;
  sessionVersion: number;
};

export type MfaTokenPayload = MfaTokenIdentity & {
  purpose: MfaTokenPurpose;
};

export async function generateMfaToken(
  payload: MfaTokenPayload,
  env: MfaEnv,
  nowMs = Date.now(),
): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  return sign({
    ...payload,
    kind: 'cf-monitor-mfa',
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + MFA_TOKEN_TTL_SECONDS,
  }, requireJwtSecret(env), 'HS256');
}

export async function verifyMfaToken(
  token: string,
  expectedPurpose: MfaTokenPurpose,
  env: MfaEnv,
): Promise<MfaTokenPayload | null> {
  const secret = requireJwtSecret(env);
  try {
    const payload = await verify(token, secret, 'HS256');
    if (
      payload.kind !== 'cf-monitor-mfa' ||
      payload.purpose !== expectedPurpose ||
      typeof payload.userId !== 'string' ||
      typeof payload.username !== 'string' ||
      typeof payload.sessionVersion !== 'number' ||
      !Number.isSafeInteger(payload.sessionVersion) ||
      payload.sessionVersion < 1
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      username: payload.username,
      sessionVersion: payload.sessionVersion,
      purpose: expectedPurpose,
    };
  } catch {
    return null;
  }
}
export type MfaSetupTokenPayload = MfaTokenIdentity & {
  encryptedSecret: string;
};

export async function generateMfaSetupToken(
  payload: MfaSetupTokenPayload,
  env: MfaEnv,
  nowMs = Date.now(),
): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  return sign({
    ...payload,
    kind: 'cf-monitor-mfa',
    purpose: 'mfa-setup',
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + MFA_TOKEN_TTL_SECONDS,
  }, requireJwtSecret(env), 'HS256');
}

export async function verifyMfaSetupToken(
  token: string,
  env: MfaEnv,
): Promise<MfaSetupTokenPayload | null> {
  const secret = requireJwtSecret(env);
  try {
    const payload = await verify(token, secret, 'HS256');
    if (
      payload.kind !== 'cf-monitor-mfa' ||
      payload.purpose !== 'mfa-setup' ||
      typeof payload.userId !== 'string' ||
      typeof payload.username !== 'string' ||
      typeof payload.sessionVersion !== 'number' ||
      !Number.isSafeInteger(payload.sessionVersion) ||
      payload.sessionVersion < 1 ||
      typeof payload.encryptedSecret !== 'string' ||
      !payload.encryptedSecret ||
      payload.encryptedSecret.length > 4096
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      username: payload.username,
      sessionVersion: payload.sessionVersion,
      encryptedSecret: payload.encryptedSecret,
    };
  } catch {
    return null;
  }
}