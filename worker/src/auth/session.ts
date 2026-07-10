import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';

const ADMIN_SESSION_COOKIE = 'cf_monitor_session';
const ADMIN_CSRF_COOKIE = 'cf_monitor_csrf';
const MFA_STEP_UP_COOKIE = 'cf_monitor_mfa_stepup';
const ADMIN_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const ADMIN_CSRF_MAX_AGE_SECONDS = ADMIN_SESSION_MAX_AGE_SECONDS;
const MFA_STEP_UP_MAX_AGE_SECONDS = 5 * 60;

function isHttpsRequest(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

export function getAdminSessionToken(c: Context): string | null {
  return getCookie(c, ADMIN_SESSION_COOKIE) ?? null;
}

export function setAdminSessionCookie(c: Context, token: string): void {
  setCookie(c, ADMIN_SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: isHttpsRequest(c),
    sameSite: 'Lax',
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
}

function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function isValidCsrfToken(token: string | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token);
}

function constantTimeStringEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function getAdminCsrfToken(c: Context): string | null {
  const token = getCookie(c, ADMIN_CSRF_COOKIE);
  return isValidCsrfToken(token) ? token : null;
}

export function ensureAdminCsrfCookie(c: Context): string {
  const existing = getAdminCsrfToken(c);
  const token = existing || generateCsrfToken();
  setCookie(c, ADMIN_CSRF_COOKIE, token, {
    path: '/',
    httpOnly: false,
    secure: isHttpsRequest(c),
    sameSite: 'Lax',
    maxAge: ADMIN_CSRF_MAX_AGE_SECONDS,
  });
  return token;
}

export function verifyAdminCsrfToken(c: Context): boolean {
  const cookieToken = getAdminCsrfToken(c);
  const headerToken = c.req.header('X-CSRF-Token');
  return Boolean(cookieToken && isValidCsrfToken(headerToken) && constantTimeStringEqual(cookieToken, headerToken));
}

export function getMfaStepUpToken(c: Context): string | null {
  return getCookie(c, MFA_STEP_UP_COOKIE) ?? null;
}

export function setMfaStepUpCookie(c: Context, token: string): void {
  setCookie(c, MFA_STEP_UP_COOKIE, token, {
    path: '/api/admin',
    httpOnly: true,
    secure: isHttpsRequest(c),
    sameSite: 'Strict',
    maxAge: MFA_STEP_UP_MAX_AGE_SECONDS,
  });
}

export function clearMfaStepUpCookie(c: Context): void {
  deleteCookie(c, MFA_STEP_UP_COOKIE, {
    path: '/api/admin',
  });
}
export function clearAdminSessionCookie(c: Context): void {
  clearMfaStepUpCookie(c);
  deleteCookie(c, ADMIN_SESSION_COOKIE, {
    path: '/',
  });
  deleteCookie(c, ADMIN_CSRF_COOKIE, {
    path: '/',
  });
}
