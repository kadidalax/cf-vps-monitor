import * as db from '../db/queries';
import { validateSupabaseAdminSession } from '../db/supabase-api/client';
import type { AdminJwtPayload } from './jwt';

const ADMIN_SESSION_CACHE_MS = 10_000;

type AdminSessionUser = Pick<db.User, 'uuid' | 'username' | 'session_version'>;

let adminSessionCache = new Map<string, {
  user: AdminSessionUser;
  expiresAt: number;
}>();
const adminSessionRequests = new Map<string, Promise<AdminSessionUser | null>>();

function cacheKey(payload: AdminJwtPayload): string {
  return `${payload.userId}:${payload.username}:${payload.sessionVersion}`;
}

export function invalidateAdminSessionCache(userId?: string): void {
  if (!userId) {
    adminSessionCache.clear();
    adminSessionRequests.clear();
    return;
  }
  for (const key of adminSessionCache.keys()) {
    if (key.startsWith(`${userId}:`)) adminSessionCache.delete(key);
  }
  for (const key of adminSessionRequests.keys()) {
    if (key.startsWith(`${userId}:`)) adminSessionRequests.delete(key);
  }
}

export async function validateAdminSession(
  database: db.QueryDatabase,
  payload: AdminJwtPayload,
): Promise<AdminSessionUser | null> {
  const key = cacheKey(payload);
  const cached = adminSessionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const pending = adminSessionRequests.get(key);
  if (pending) return pending;

  const request = readAdminSession(database, payload, key);
  adminSessionRequests.set(key, request);
  request.finally(() => adminSessionRequests.delete(key)).catch(() => {});
  return request;
}

async function readAdminSession(
  database: db.QueryDatabase,
  payload: AdminJwtPayload,
  key: string,
): Promise<AdminSessionUser | null> {
  if (database.provider === 'supabase-api') {
    const user = await validateSupabaseAdminSession(database.env, payload.userId, payload.sessionVersion);
    if (!user || user.username !== payload.username) return null;
    adminSessionCache.set(key, {
      user,
      expiresAt: Date.now() + ADMIN_SESSION_CACHE_MS,
    });
    return user;
  }

  const user = await db.getUserByUuid(database, payload.userId);
  if (!user) return null;
  if (user.username !== payload.username) return null;
  if (user.session_version !== payload.sessionVersion) return null;
  const sessionUser = {
    uuid: user.uuid,
    username: user.username,
    session_version: user.session_version,
  };
  adminSessionCache.set(key, {
    user: sessionUser,
    expiresAt: Date.now() + ADMIN_SESSION_CACHE_MS,
  });
  return sessionUser;
}
