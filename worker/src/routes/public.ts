/**
 * 公开 API 路由 - 无需认证
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { getDatabase } from '../db/provider';
import { resolveSupabaseApiKey } from '../db/supabase-api/client';
import { invalidateAdminSessionCache, validateAdminSession } from '../auth/admin-session';
import { AuthConfigurationError, generateToken, verifyAdminToken } from '../auth/jwt';
import { decryptTotpSecret, hashRecoveryCode } from '../auth/mfa';
import { generateMfaToken, verifyMfaToken } from '../auth/mfa-token';
import { verifyTotpCode } from '../auth/totp';
import { hashPassword, needsPasswordRehash, validateAdminPasswordStrength, verifyPassword } from '../auth/password';
import {
  clearAdminSessionCookie,
  ensureAdminCsrfCookie,
  getAdminSessionToken,
  setAdminSessionCookie,
  verifyAdminCsrfToken,
} from '../auth/session';
import { PUBLIC_SETTING_KEYS, buildPublicSettings } from '../settings/schema';
import type { PublicSettings } from '../settings/schema';
import { toPublicClient } from '../utils/public-client';
import type { PublicClient } from '../utils/public-client';
import { sanitizeSetupDiagnosticDetail } from '../utils/setup-diagnostics';
import { getCloudflareClientIp } from '../utils/request-ip';
import { readLiveSnapshot, readRateLimitResult } from '../utils/do-response';
import { readJsonWithLimit } from '../utils/request-body';
import { base64ToBytes } from '../utils/theme-package';

const publicRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
type PublicContext = Context<{ Bindings: Bindings; Variables: Variables }>;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const LOGIN_RATE_LIMIT_BASE_LOCK_MS = 30 * 1000;
const LOGIN_RATE_LIMIT_MAX_LOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
const LOGIN_RATE_LIMIT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const LOGIN_FAILURE_AUDIT_THROTTLE_MS = 60 * 1000;
const LOGIN_FAILURE_AUDIT_THROTTLE_MAX_ENTRIES = 512;
const MAX_LOGIN_USERNAME_LENGTH = 128;
const MAX_LOGIN_PASSWORD_LENGTH = 4096;
const MAX_MFA_CHALLENGE_LENGTH = 4096;
const MAX_MFA_CODE_LENGTH = 128;
const MAX_PUBLIC_JSON_BYTES = 8 * 1024;
const MAX_PUBLIC_RECORD_RANGE_MS = 3 * 24 * 60 * 60 * 1000;
const PUBLIC_RECORD_RANGE_SLOP_MS = 60 * 1000;
const PUBLIC_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PUBLIC_METADATA_RATE_LIMIT_MAX = 120;
const PUBLIC_HISTORY_RATE_LIMIT_MAX = 60;
const PUBLIC_LIVE_RATE_LIMIT_MAX = 180;
const PUBLIC_ADMIN_RECOVERY_RATE_LIMIT_MAX = 5;
const PUBLIC_METADATA_CACHE_SECONDS = 30;
const PUBLIC_HISTORY_CACHE_SECONDS = 10;
const PUBLIC_LIVE_CACHE_SECONDS = 2;
const PUBLIC_HISTORY_MAX_PAGE = 1000;
const PUBLIC_HISTORY_MAX_OFFSET_ROWS = 5000;
const PUBLIC_METADATA_CACHE_MS = PUBLIC_METADATA_CACHE_SECONDS * 1000;
const PUBLIC_HISTORY_CACHE_MS = PUBLIC_HISTORY_CACHE_SECONDS * 1000;
const PUBLIC_HISTORY_CACHE_MAX_ENTRIES = 256;
const PUBLIC_METADATA_CACHE_MAX_ENTRIES = PUBLIC_HISTORY_CACHE_MAX_ENTRIES;
const ADMIN_SESSION_EDGE_CACHE_SECONDS = 30;
const LOGOUT_CLEAR_SITE_DATA_HEADER = '"cache"';
const DUMMY_ADMIN_PASSWORD_HASH = 'pbkdf2_sha256$10000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const MAX_ADMIN_RECOVERY_KEY_LENGTH = 8192;
const MAX_ADMIN_RECOVERY_USERNAME_BYTES = 64;
const SITE_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

type PublicRateLimitBucket = {
  count: number;
  resetAt: number;
  lastSeenAt: number;
};
type TimingMetric = { name: string; dur: number };

const publicRateLimitBuckets = new Map<string, PublicRateLimitBucket>();
let publicRateLimitSweepCounter = 0;

type PublicClientsSnapshot = {
  clients: PublicClient[];
  nodes: PublicNode[];
  publicClientIds: Set<string>;
  expiresAt: number;
};
type AdminClientsSnapshotOverlay = {
  clients: unknown[];
  removed: string[];
};

type PublicNode = Omit<PublicClient, 'tags'> & { tags: string[] };

let publicSettingsCache: { value: PublicSettings; expiresAt: number } | null = null;
let publicClientsSnapshotCache: PublicClientsSnapshot | null = null;
let publicPingTasksCache: { value: db.PingTask[]; expiresAt: number } | null = null;
const publicMetadataResponseCache = new Map<string, { value: unknown; expiresAt: number }>();
const publicHistoryCache = new Map<string, { value: unknown; expiresAt: number }>();
const publicClientVisibilityCache = new Map<string, { value: boolean; expiresAt: number }>();
let lastLoginRateLimitCleanupAt = 0;
const loginFailureAuditThrottle = new Map<string, { expiresAt: number }>();

async function timed<T>(metrics: TimingMetric[], name: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    metrics.push({ name, dur: performance.now() - started });
  }
}

function setServerTiming(c: PublicContext, metrics: TimingMetric[]): void {
  if (metrics.length === 0) return;
  c.header('Server-Timing', metrics.map(metric => `${metric.name};dur=${metric.dur.toFixed(1)}`).join(', '));
}

function adminSessionEdgeCacheRequest(userId: string, sessionVersion: number): Request {
  return new Request(
    `https://cf-monitor.internal/cache/admin-session/${encodeURIComponent(userId)}/${sessionVersion}`,
    { method: 'GET' },
  );
}

async function getAdminSessionEdgeCache(userId: string, sessionVersion: number): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    return Boolean(await caches.default.match(adminSessionEdgeCacheRequest(userId, sessionVersion)));
  } catch {
    return false;
  }
}

function putAdminSessionEdgeCache(c: PublicContext, user: Pick<db.User, 'uuid' | 'session_version'>): void {
  if (typeof caches === 'undefined') return;
  const task = caches.default.put(adminSessionEdgeCacheRequest(user.uuid, user.session_version), new Response('1', {
    headers: { 'Cache-Control': `public, max-age=${ADMIN_SESSION_EDGE_CACHE_SECONDS}` },
  })).catch(() => undefined);
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(task);
  else void task;
}

export async function deleteAdminSessionEdgeCache(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  userId: string,
  sessionVersion: number,
): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const task = caches.default.delete(adminSessionEdgeCacheRequest(userId, sessionVersion));
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(task.catch(() => undefined));
    await task;
  } catch {
    // Session revocation is enforced by session_version; edge cache deletion shortens stale-cache windows.
  }
}

function isJsonObjectPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readPublicJsonObject(c: PublicContext): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const parsed = await readJsonWithLimit(c.req.raw, MAX_PUBLIC_JSON_BYTES);
  if (!parsed.ok && parsed.reason === 'too_large') {
    return { response: c.json({ error: `请求内容不能超过 ${MAX_PUBLIC_JSON_BYTES} 字节` }, 413) };
  }
  if (!parsed.ok) {
    return { response: c.json({ error: '请求格式错误' }, 400) };
  }
  const body = parsed.body;
  return isJsonObjectPayload(body)
    ? { body }
    : { response: c.json({ error: '请求内容必须是 JSON 对象' }, 400) };
}

function cacheIsFresh(entry: { expiresAt: number } | null | undefined, now = Date.now()): boolean {
  return Boolean(entry && entry.expiresAt > now);
}

function isFreshPublicMetadataRequest(c: PublicContext): boolean {
  return Boolean(c.req.query('_fresh'));
}

export function invalidatePublicMetadataCache(): void {
  publicSettingsCache = null;
  publicClientsSnapshotCache = null;
  publicPingTasksCache = null;
  publicMetadataResponseCache.clear();
  publicHistoryCache.clear();
  publicClientVisibilityCache.clear();
}

function publicHistoryCacheKey(c: PublicContext, bucket: string): string {
  const url = new URL(c.req.url);
  url.searchParams.delete('_fresh');
  url.searchParams.sort();
  return `${bucket}:${url.pathname}?${url.searchParams.toString()}`;
}

function publicCacheRequest(c: PublicContext): Request {
  const url = new URL(c.req.url);
  url.searchParams.sort();
  return new Request(url.toString(), { method: 'GET' });
}

function publicMetadataAllowedQueryParams(pathname: string): string[] {
  if (pathname === '/api/websites') return ['hours'];
  if (/^\/api\/websites\/\d+$/.test(pathname)) return ['limit'];
  return [];
}

function publicMetadataCanonicalQueryValue(pathname: string, name: string, value: string | null): string | null {
  if (pathname === '/api/websites' && name === 'hours') return String(readIntParam(value || undefined, 24, 72));
  if (/^\/api\/websites\/\d+$/.test(pathname) && name === 'limit') return String(readIntParam(value || undefined, 120, 500));
  return null;
}

function publicMetadataCacheKey(c: PublicContext): string {
  const url = new URL(c.req.url);
  const params = new URLSearchParams();
  for (const name of publicMetadataAllowedQueryParams(url.pathname)) {
    const value = publicMetadataCanonicalQueryValue(url.pathname, name, url.searchParams.get(name));
    if (value) params.set(name, value);
  }
  params.sort();
  return `metadata:${url.pathname}?${params.toString()}`;
}

function publicMetadataEdgeCacheRequest(c: PublicContext): Request {
  const source = new URL(c.req.url);
  const url = new URL(source.pathname, source.origin);
  for (const name of publicMetadataAllowedQueryParams(url.pathname)) {
    const value = publicMetadataCanonicalQueryValue(url.pathname, name, source.searchParams.get(name));
    if (value) url.searchParams.set(name, value);
  }
  url.searchParams.sort();
  return new Request(url.toString(), { method: 'GET' });
}

function publicMetadataPathCacheRequest(c: Context<{ Bindings: Bindings; Variables: Variables }>, pathname: string): Request {
  return new Request(new URL(pathname, c.req.url).toString(), { method: 'GET' });
}

export function purgePublicMetadataEdgeCache(c: Context<{ Bindings: Bindings; Variables: Variables }>): Promise<unknown[]> {
  if (typeof caches === 'undefined') return Promise.resolve([]);
  const paths = [
    '/api/public/bootstrap',
    '/api/clients',
    '/api/nodes',
    '/api/public',
    '/api/task/ping',
    '/api/websites',
  ];
  const task = Promise.all(paths.map(path => caches.default.delete(publicMetadataPathCacheRequest(c, path)))).catch(() => []);
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(task);
  else void task;
  return task;
}

function publicJsonResponse(c: PublicContext, value: unknown, maxAgeSeconds: number, cacheState: string): Response {
  setPublicCache(c, maxAgeSeconds);
  c.header('X-CF-VPS-Monitor-Public-Cache', cacheState);
  return new Response(JSON.stringify(value), {
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`,
      'X-CF-VPS-Monitor-Public-Cache': cacheState,
    },
  });
}

function withPublicCacheHeader(c: PublicContext, response: Response, maxAgeSeconds: number, cacheState: string): Response {
  setPublicCache(c, maxAgeSeconds);
  c.header('X-CF-VPS-Monitor-Public-Cache', cacheState);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`);
  headers.set('X-CF-VPS-Monitor-Public-Cache', cacheState);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function getPublicEdgeCache(c: PublicContext, maxAgeSeconds: number): Promise<Response | null> {
  if (c.req.method !== 'GET' || typeof caches === 'undefined') return null;
  try {
    const cached = await caches.default.match(publicCacheRequest(c));
    return cached ? withPublicCacheHeader(c, cached, maxAgeSeconds, 'edge-hit') : null;
  } catch {
    return null;
  }
}

function putPublicEdgeCache(c: PublicContext, response: Response): void {
  if (c.req.method !== 'GET' || typeof caches === 'undefined') return;
  try {
    const put = caches.default.put(publicCacheRequest(c), response.clone());
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(put.catch(() => undefined));
    } else {
      void put.catch(() => undefined);
    }
  } catch {
    // Edge cache is only a quota optimization; correctness comes from the database/DO.
  }
}

async function getPublicMetadataEdgeCache(c: PublicContext): Promise<Response | null> {
  if (c.req.method !== 'GET' || typeof caches === 'undefined') return null;
  try {
    const cached = await caches.default.match(publicMetadataEdgeCacheRequest(c));
    return cached ? withPublicCacheHeader(c, cached, PUBLIC_METADATA_CACHE_SECONDS, 'edge-hit') : null;
  } catch {
    return null;
  }
}

function putPublicMetadataEdgeCache(c: PublicContext, response: Response): void {
  if (c.req.method !== 'GET' || typeof caches === 'undefined') return;
  try {
    const put = caches.default.put(publicMetadataEdgeCacheRequest(c), response.clone());
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(put.catch(() => undefined));
    } else {
      void put.catch(() => undefined);
    }
  } catch {
    // Edge cache is only a quota optimization; correctness comes from the database/DO.
  }
}

async function getPublicHistoryCache(c: PublicContext, key: string): Promise<Response | null> {
  const entry = publicHistoryCache.get(key);
  if (entry && cacheIsFresh(entry)) {
    return publicJsonResponse(c, entry.value, PUBLIC_HISTORY_CACHE_SECONDS, 'memory-hit');
  }
  if (entry) publicHistoryCache.delete(key);
  return getPublicEdgeCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
}

function setPublicHistoryCache(c: PublicContext, key: string, value: unknown): Response {
  if (publicHistoryCache.size >= PUBLIC_HISTORY_CACHE_MAX_ENTRIES) {
    const oldestKey = publicHistoryCache.keys().next().value;
    if (oldestKey) publicHistoryCache.delete(oldestKey);
  }
  publicHistoryCache.set(key, {
    value,
    expiresAt: Date.now() + PUBLIC_HISTORY_CACHE_MS,
  });
  const response = publicJsonResponse(c, value, PUBLIC_HISTORY_CACHE_SECONDS, 'miss');
  putPublicEdgeCache(c, response);
  return response;
}

async function getPublicMetadataResponse(c: PublicContext): Promise<Response | null> {
  const key = publicMetadataCacheKey(c);
  const entry = publicMetadataResponseCache.get(key);
  if (entry && cacheIsFresh(entry)) {
    return publicJsonResponse(c, entry.value, PUBLIC_METADATA_CACHE_SECONDS, 'memory-hit');
  }
  if (entry) publicMetadataResponseCache.delete(key);
  return getPublicMetadataEdgeCache(c);
}

async function getCachedPublicMetadataResponse(c: PublicContext, bucket: string): Promise<Response | null> {
  const cached = await getPublicMetadataResponse(c);
  if (!cached) return null;
  return localPublicApiRateLimit(c, `metadata:${bucket}`, PUBLIC_METADATA_RATE_LIMIT_MAX) || cached;
}

function setPublicMetadataResponse(c: PublicContext, value: unknown, cacheEdge = true): Response {
  if (publicMetadataResponseCache.size >= PUBLIC_METADATA_CACHE_MAX_ENTRIES) {
    const oldestKey = publicMetadataResponseCache.keys().next().value;
    if (oldestKey) publicMetadataResponseCache.delete(oldestKey);
  }
  publicMetadataResponseCache.set(publicMetadataCacheKey(c), {
    value,
    expiresAt: Date.now() + PUBLIC_METADATA_CACHE_MS,
  });
  const response = publicJsonResponse(c, value, PUBLIC_METADATA_CACHE_SECONDS, 'miss');
  if (cacheEdge) putPublicMetadataEdgeCache(c, response);
  return response;
}

function cleanupPublicRateLimitBuckets(nowMs: number): void {
  for (const [key, bucket] of publicRateLimitBuckets) {
    if (bucket.resetAt <= nowMs || nowMs - bucket.lastSeenAt > PUBLIC_RATE_LIMIT_WINDOW_MS * 5) {
      publicRateLimitBuckets.delete(key);
    }
  }
}

function readIntParam(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function readTimeCursorParam(value: string | undefined): { cursor?: string; error?: string } {
  const text = (value || '').trim();
  if (!text) return {};
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return { error: 'cursor 参数无效' };
  return { cursor: new Date(time).toISOString() };
}

function readPublicHistoryPageParams(
  c: PublicContext,
  defaultLimit: number,
  maxLimit: number,
): { page: number; limit: number } | { response: Response } {
  const page = readIntParam(c.req.query('page'), 1, PUBLIC_HISTORY_MAX_PAGE);
  const limit = readIntParam(c.req.query('limit'), defaultLimit, maxLimit);
  const offset = (page - 1) * limit;
  if (offset > PUBLIC_HISTORY_MAX_OFFSET_ROWS) {
    return {
      response: c.json({
        error: '公开历史 page 查询过深，请使用 cursor 分页',
      }, 400),
    };
  }
  return { page, limit };
}

function readIntListParam(value: string | undefined, maxItems: number): number[] {
  if (!value) return [];
  return [...new Set(
    value
      .split(',')
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((item) => Number.isInteger(item) && item > 0),
  )].slice(0, maxItems);
}

function readPingTaskHistorySpecs(value: string | undefined, maxItems: number): db.PingTaskHistoryRequest[] {
  if (!value) return [];
  const specs: db.PingTaskHistoryRequest[] = [];
  const seen = new Set<number>();
  for (const rawSpec of value.split(',')) {
    const [rawTaskId, rawLimit, rawInterval] = rawSpec.split(':');
    const taskId = Number.parseInt(rawTaskId || '', 10);
    if (!Number.isInteger(taskId) || taskId <= 0 || seen.has(taskId)) continue;
    seen.add(taskId);
    specs.push({
      taskId,
      limit: readIntParam(rawLimit, 120, 360),
      intervalSec: readIntParam(rawInterval, 60, 86_400),
    });
    if (specs.length >= maxItems) break;
  }
  return specs;
}

function wantsPagedResponse(c: PublicContext): boolean {
  return c.req.query('paged') === 'true' || c.req.query('page') !== undefined || c.req.query('cursor') !== undefined;
}

function emptyPagedResult<T>(page: number, limit: number) {
  return {
    data: [] as T[],
    total: 0,
    page,
    limit,
    has_more: false,
  };
}

function validatePublicTimeRange(start: string, end: string): string | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return '时间范围格式无效';
  }
  if (endMs < startMs) {
    return '结束时间不能早于开始时间';
  }
  if (endMs - startMs > MAX_PUBLIC_RECORD_RANGE_MS + PUBLIC_RECORD_RANGE_SLOP_MS) {
    return '公开历史查询最多支持 3 天时间范围';
  }
  return null;
}

async function getPublicSettings(database: db.QueryDatabase, force = false): Promise<PublicSettings> {
  const now = Date.now();
  if (!force && cacheIsFresh(publicSettingsCache, now)) return publicSettingsCache!.value;

  const settings = buildPublicSettings(await db.getSettingsByKeys(database, PUBLIC_SETTING_KEYS, force));
  publicSettingsCache = { value: settings, expiresAt: now + PUBLIC_METADATA_CACHE_MS };
  return settings;
}

function privateJsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function hasAdminSession(c: PublicContext): Promise<boolean> {
  const token = getAdminSessionToken(c);
  if (!token) return false;
  try {
    const payload = await verifyAdminToken(token, c.env);
    if (!payload) return false;
    if (await getAdminSessionEdgeCache(payload.userId, payload.sessionVersion)) return true;
    const user = await validateAdminSession(getDatabase(c.env), payload);
    if (user) putAdminSessionEdgeCache(c, user);
    return Boolean(user);
  } catch {
    return false;
  }
}

async function readAdminClientsSnapshotOverlay(c: PublicContext): Promise<AdminClientsSnapshotOverlay | null> {
  const response = await c.env.LIVE_DATA
    .get(c.env.LIVE_DATA.idFromName('global'))
    .fetch(new Request('https://do/admin-clients-snapshot'));
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') return null;
  return {
    clients: Array.isArray((body as { clients?: unknown }).clients) ? (body as { clients: unknown[] }).clients : [],
    removed: Array.isArray((body as { removed?: unknown }).removed)
      ? (body as { removed: unknown[] }).removed.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.trim() !== '')
      : [],
  };
}

function applyPublicClientsOverlay(clients: PublicClient[], overlay: AdminClientsSnapshotOverlay | null, includeHidden = false): PublicClient[] {
  if (!overlay) return clients;
  const removed = new Set(overlay.removed);
  const byUuid = new Map(
    clients
      .filter(client => !removed.has(client.uuid))
      .map(client => [client.uuid, client]),
  );
  for (const raw of overlay.clients) {
    const client = toPublicClient(raw as Parameters<typeof toPublicClient>[0]);
    if (!client.uuid || (!includeHidden && client.hidden) || removed.has(client.uuid)) continue;
    const existing = byUuid.get(client.uuid);
    const next = { ...existing, ...client };
    if (existing) {
      if (client.price === 0 && existing.price !== 0) next.price = existing.price;
      if (client.billing_cycle === 0 && existing.billing_cycle !== 0) next.billing_cycle = existing.billing_cycle;
      if (!client.currency && existing.currency) next.currency = existing.currency;
      if (!client.expired_at && existing.expired_at) next.expired_at = existing.expired_at;
    }
    byUuid.set(client.uuid, next);
  }
  return [...byUuid.values()];
}

async function getPublicClientsSnapshot(c: PublicContext, database: db.QueryDatabase, force = false, includeHidden = false): Promise<PublicClientsSnapshot> {
  const now = Date.now();
  if (!includeHidden && !force && cacheIsFresh(publicClientsSnapshotCache, now)) return publicClientsSnapshotCache!;

  const clients = await db.listPublicClientRows(database, force);
  let publicClients = clients
    .filter(client => includeHidden || !client.hidden)
    .map(toPublicClient);
  publicClients = applyPublicClientsOverlay(publicClients, await readAdminClientsSnapshotOverlay(c), includeHidden);
  const publicClientIds = new Set(publicClients.map(client => client.uuid));
  const nodes = publicClients.map((client) => ({
    ...client,
    tags: client.tags ? client.tags.split(';').filter(Boolean) : [],
  }));
  const expiresAt = now + PUBLIC_METADATA_CACHE_MS;
  for (const client of clients) {
    publicClientVisibilityCache.set(client.uuid, { value: !client.hidden, expiresAt });
  }
  const snapshot = {
    clients: publicClients,
    nodes,
    publicClientIds,
    expiresAt,
  };
  if (!includeHidden) publicClientsSnapshotCache = snapshot;
  return snapshot;
}

function boundedPublicPingIntervalSec(settings: PublicSettings): number {
  const intervalSec = Number(settings.ping_record_persist_interval_sec);
  return Number.isFinite(intervalSec)
    ? Math.min(Math.max(Math.floor(intervalSec), 60), 3600)
    : 300;
}

async function getPublicPingTasks(
  database: db.QueryDatabase,
  publicClientIds: Set<string>,
  pingIntervalSec: number,
  force = false,
): Promise<db.PingTask[]> {
  const now = Date.now();
  if (force || !cacheIsFresh(publicPingTasksCache, now)) {
    publicPingTasksCache = {
      value: await db.listPingTasks(database, force),
      expiresAt: now + PUBLIC_METADATA_CACHE_MS,
    };
  }
  const tasks = publicPingTasksCache?.value || [];
  return tasks
    .map(task => toPublicPingTask(task, publicClientIds))
    .map(task => task ? { ...task, interval_sec: pingIntervalSec } : task)
    .filter((task): task is db.PingTask => Boolean(task));
}

function toPublicPingTask(task: db.PingTask, publicClientIds: Set<string>): db.PingTask | null {
  if (task.all_clients) {
    return { ...task, clients: [] };
  }

  const clients = task.clients.filter(uuid => publicClientIds.has(uuid));
  if (clients.length === 0) return null;

  return {
    ...task,
    clients,
  };
}

function getClientIp(c: PublicContext): string {
  return getCloudflareClientIp(c);
}

function setPublicCache(c: PublicContext, maxAgeSeconds: number): void {
  c.header(
    'Cache-Control',
    `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`,
  );
}

function localPublicApiRateLimit(c: PublicContext, bucket: string, maxRequests: number): Response | null {
  const nowMs = Date.now();
  publicRateLimitSweepCounter += 1;
  if (publicRateLimitSweepCounter % 256 === 0) {
    cleanupPublicRateLimitBuckets(nowMs);
  }

  const clientIp = getClientIp(c);
  const key = `public:${bucket}:${clientIp}`;
  let state = publicRateLimitBuckets.get(key);
  if (!state || state.resetAt <= nowMs) {
    state = {
      count: 0,
      resetAt: nowMs + PUBLIC_RATE_LIMIT_WINDOW_MS,
      lastSeenAt: nowMs,
    };
  }

  state.count += 1;
  state.lastSeenAt = nowMs;
  publicRateLimitBuckets.set(key, state);

  const retryAfter = Math.max(1, Math.ceil((state.resetAt - nowMs) / 1000));
  const remaining = Math.max(0, maxRequests - state.count);
  c.header('X-RateLimit-Limit', String(maxRequests));
  c.header('X-RateLimit-Remaining', String(remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

  if (state.count <= maxRequests) {
    return null;
  }

  c.header('Retry-After', String(retryAfter));
  c.header('Cache-Control', 'no-store');
  return c.json({ error: `公开 API 请求过于频繁，请 ${retryAfter} 秒后再试` }, 429);
}

async function publicApiRateLimit(c: PublicContext, bucket: string, maxRequests: number): Promise<Response | null> {
  const clientIp = getClientIp(c);
  try {
    const namespace = c.env.RATE_LIMIT;
    if (!namespace) {
      return localPublicApiRateLimit(c, bucket, maxRequests);
    }
    const doId = namespace.idFromName('public-api');
    const stub = namespace.get(doId);
    const response = await stub.fetch(new Request('https://do/rate-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket,
        ip: clientIp,
        max: maxRequests,
        windowMs: PUBLIC_RATE_LIMIT_WINDOW_MS,
      }),
    }));
    if (!response.ok) throw new Error(`DO rate limit HTTP ${response.status}`);
    const result = await readRateLimitResult(response, { limit: maxRequests, remaining: 0, retryAfter: 1 });
    if (!result) throw new Error('DO rate limit returned an invalid response');
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.reset));
    if (result.allowed) return null;

    c.header('Retry-After', String(result.retryAfter));
    c.header('Cache-Control', 'no-store');
    return c.json({ error: `公开 API 请求过于频繁，请 ${result.retryAfter} 秒后再试` }, 429);
  } catch {
    return localPublicApiRateLimit(c, bucket, maxRequests);
  }
}

function guardPublicMetadata(c: PublicContext, bucket: string): Promise<Response | null> {
  return publicApiRateLimit(c, `metadata:${bucket}`, PUBLIC_METADATA_RATE_LIMIT_MAX);
}

function guardPublicHistory(c: PublicContext, bucket: string): Promise<Response | null> {
  return publicApiRateLimit(c, `history:${bucket}`, PUBLIC_HISTORY_RATE_LIMIT_MAX);
}

function guardPublicLive(c: PublicContext): Promise<Response | null> {
  return publicApiRateLimit(c, 'live', PUBLIC_LIVE_RATE_LIMIT_MAX);
}

function guardAdminRecovery(c: PublicContext): Promise<Response | null> {
  return publicApiRateLimit(c, 'admin-recovery', PUBLIC_ADMIN_RECOVERY_RATE_LIMIT_MAX);
}

async function preparePublicHistoryRequest(
  c: PublicContext,
  database: db.QueryDatabase,
  uuid: string,
  bucket: string,
): Promise<{ cacheKey: string; visible: boolean; includeHidden: boolean; response?: Response }> {
  const cacheKey = publicHistoryCacheKey(c, bucket);
  const limited = await guardPublicHistory(c, bucket);
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
  if (limited) return { cacheKey, visible: true, includeHidden, response: limited };

  const cachedVisibility = publicClientVisibilityCache.get(uuid);

  if (!includeHidden && cacheIsFresh(cachedVisibility)) {
    if (!cachedVisibility!.value) return { cacheKey, visible: false, includeHidden };
    const cached = await getPublicHistoryCache(c, cacheKey);
    if (cached) return { cacheKey, visible: true, includeHidden, response: cached };
    return { cacheKey, visible: true, includeHidden };
  }

  const snapshot = await getPublicClientsSnapshot(c, database, false, includeHidden);
  const visible = snapshot.publicClientIds.has(uuid);
  if (!visible) return { cacheKey, visible: false, includeHidden };

  const cached = includeHidden ? null : await getPublicHistoryCache(c, cacheKey);
  if (cached) return { cacheKey, visible: true, includeHidden, response: cached };

  return { cacheKey, visible: true, includeHidden };
}

function publicHistoryResult(
  c: PublicContext,
  prepared: { cacheKey: string; includeHidden: boolean },
  value: unknown,
): Response {
  return prepared.includeHidden
    ? privateJsonResponse(value)
    : setPublicHistoryCache(c, prepared.cacheKey, value);
}

function normalizeLoginUsername(username: string): string {
  return username.trim().toLowerCase().slice(0, MAX_LOGIN_USERNAME_LENGTH);
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function timingSafeEqualString(actual: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!actual || !expected) return false;
  const [actualHash, expectedHash] = await Promise.all([sha256Bytes(actual), sha256Bytes(expected)]);
  let diff = actual.length === expected.length ? 0 : 1;
  for (let index = 0; index < expectedHash.length; index += 1) {
    diff |= actualHash[index] ^ expectedHash[index];
  }
  return diff === 0;
}

function readRecoverySecretKey(body: Record<string, unknown>): string {
  const value = body.supabase_secret_key ?? body.supabase_service_role_key ?? body.service_role_key;
  return typeof value === 'string' ? value.trim() : '';
}

function readRecoveryUsername(body: Record<string, unknown>): string {
  return typeof body.username === 'string' ? body.username.trim() : '';
}

function readRecoveryPassword(body: Record<string, unknown>): string {
  return typeof body.password === 'string' ? body.password : '';
}

function validateRecoveryUsername(username: string): string | null {
  if (!username) return '用户名不能为空';
  if (new TextEncoder().encode(username).byteLength > MAX_ADMIN_RECOVERY_USERNAME_BYTES) {
    return `用户名不能超过 ${MAX_ADMIN_RECOVERY_USERNAME_BYTES} 字节`;
  }
  if (/[\u0000-\u001F\u007F]/.test(username)) return '用户名包含无效字符';
  return null;
}

function loginRateLimitBuckets(ip: string, username: string): string[] {
  const normalizedUsername = normalizeLoginUsername(username);
  return [
    `login:ip:${ip}`,
    `login:ip-user:${ip}:${normalizedUsername}`,
  ];
}

function parseTimeMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export type LoginRateLimitStateByBucket = Map<string, db.LoginRateLimit | null>;

export async function loadLoginRateLimitStates(
  database: db.QueryDatabase,
  buckets: string[],
): Promise<LoginRateLimitStateByBucket> {
  const states: LoginRateLimitStateByBucket = new Map();
  const loaded = await db.getLoginRateLimitsByBuckets(database, buckets);
  for (const bucket of buckets) {
    states.set(bucket, loaded.get(bucket) || null);
  }
  return states;
}

export function getLoginRetryAfterSeconds(
  states: LoginRateLimitStateByBucket,
  nowMs: number,
): number {
  let lockedUntilMs = 0;
  for (const state of states.values()) {
    lockedUntilMs = Math.max(lockedUntilMs, parseTimeMs(state?.locked_until));
  }
  if (lockedUntilMs <= nowMs) return 0;
  return Math.ceil((lockedUntilMs - nowMs) / 1000);
}

export async function recordLoginFailure(
  database: db.QueryDatabase,
  buckets: string[],
  nowMs: number,
  states?: LoginRateLimitStateByBucket,
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  const rateLimitStates = states || await loadLoginRateLimitStates(database, buckets);
  const nextStates: db.LoginRateLimit[] = [];
  for (const bucket of buckets) {
    const state = rateLimitStates.has(bucket) ? rateLimitStates.get(bucket) : await db.getLoginRateLimit(database, bucket);
    const firstFailedMs = parseTimeMs(state?.first_failed_at);
    const inWindow = Boolean(state) && nowMs - firstFailedMs <= LOGIN_RATE_LIMIT_WINDOW_MS;
    const failures = inWindow ? Number(state?.failures || 0) + 1 : 1;
    const firstFailedAt = inWindow ? state!.first_failed_at : nowIso;
    const shouldLock = failures >= LOGIN_RATE_LIMIT_MAX_FAILURES;
    const lockMs = shouldLock
      ? Math.min(
        LOGIN_RATE_LIMIT_BASE_LOCK_MS * (2 ** (failures - LOGIN_RATE_LIMIT_MAX_FAILURES)),
        LOGIN_RATE_LIMIT_MAX_LOCK_MS,
      )
      : 0;

    const nextState = {
      bucket,
      failures,
      first_failed_at: firstFailedAt,
      last_failed_at: nowIso,
      locked_until: shouldLock ? new Date(nowMs + lockMs).toISOString() : null,
    };
    nextStates.push(nextState);
    rateLimitStates.set(bucket, nextState);
  }
  await db.setLoginRateLimits(database, nextStates);
}

export async function clearLoginFailures(database: db.QueryDatabase, buckets: string[]): Promise<void> {
  await db.clearLoginRateLimits(database, buckets);
}

function runLoginBackground(c: PublicContext, task: Promise<unknown>): void {
  const guarded = task.catch((error) => {
    console.warn('[auth] background login task failed:', sanitizeSetupDiagnosticDetail(error));
  });
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(guarded);
    return;
  }
  void guarded;
}

async function completeAdminLogin(
  c: PublicContext,
  database: db.QueryDatabase,
  user: db.User,
  bucketsToClear: string[],
  metrics: TimingMetric[],
) {
  let token: string;
  try {
    token = await timed(metrics, 'sign_token', () =>
      generateToken(user.uuid, user.username, user.session_version, c.env));
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
      return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
    }
    throw error;
  }

  setAdminSessionCookie(c, token);
  const csrfToken = ensureAdminCsrfCookie(c);
  putAdminSessionEdgeCache(c, user);
  if (bucketsToClear.length > 0) {
    runLoginBackground(c, clearLoginFailures(database, bucketsToClear));
  }
  runLoginBackground(c, db.insertAuditLog(database, user.username, 'login', '用户登录'));

  setServerTiming(c, metrics);
  return c.json({
    csrf_token: csrfToken,
    user: {
      uuid: user.uuid,
      username: user.username,
    },
  });
}

export function mfaRateLimitBuckets(ip: string, userId: string): string[] {
  return [
    `mfa:ip:${ip}`,
    `mfa:ip-user:${ip}:${userId}`,
  ];
}
export async function cleanupExpiredLoginRateLimits(database: db.QueryDatabase, nowMs: number): Promise<boolean> {
  if (
    lastLoginRateLimitCleanupAt > 0 &&
    nowMs - lastLoginRateLimitCleanupAt < LOGIN_RATE_LIMIT_CLEANUP_INTERVAL_MS
  ) {
    return false;
  }
  await db.deleteLoginRateLimitsBefore(
    database,
    new Date(nowMs - LOGIN_RATE_LIMIT_CLEANUP_AGE_MS).toISOString(),
  );
  lastLoginRateLimitCleanupAt = nowMs;
  return true;
}

export function resetLoginRateLimitCleanupForTests(): void {
  lastLoginRateLimitCleanupAt = 0;
}

function loginFailureAuditThrottleKey(username: string, ip: string, reason: string): string {
  return `${reason}:${ip}:${normalizeLoginUsername(username)}`;
}

export function resetLoginFailureAuditThrottleForTests(): void {
  loginFailureAuditThrottle.clear();
}

export async function auditLoginFailure(
  database: db.QueryDatabase,
  username: string,
  ip: string,
  reason: string,
  nowMs = Date.now(),
): Promise<void> {
  const key = loginFailureAuditThrottleKey(username, ip, reason);
  const existing = loginFailureAuditThrottle.get(key);
  if (existing && existing.expiresAt > nowMs) return;

  if (loginFailureAuditThrottle.size >= LOGIN_FAILURE_AUDIT_THROTTLE_MAX_ENTRIES) {
    for (const [entryKey, entry] of loginFailureAuditThrottle) {
      if (entry.expiresAt <= nowMs || loginFailureAuditThrottle.size >= LOGIN_FAILURE_AUDIT_THROTTLE_MAX_ENTRIES) {
        loginFailureAuditThrottle.delete(entryKey);
      }
      if (loginFailureAuditThrottle.size < LOGIN_FAILURE_AUDIT_THROTTLE_MAX_ENTRIES) break;
    }
  }

  loginFailureAuditThrottle.set(key, {
    expiresAt: nowMs + LOGIN_FAILURE_AUDIT_THROTTLE_MS,
  });
  await db.insertAuditLog(
    database,
    username.slice(0, MAX_LOGIN_USERNAME_LENGTH) || 'anonymous',
    'login_failed',
    JSON.stringify({
      username: username.slice(0, MAX_LOGIN_USERNAME_LENGTH),
      ip,
      reason,
    }),
    'warn',
  );
}

publicRoutes.get('/admin/recovery/status', async (c) => {
  const limited = await guardAdminRecovery(c);
  if (limited) return limited;
  const userCount = await db.countUsers(getDatabase(c.env));
  return c.json({
    admin_present: userCount > 0,
    recoverable: userCount <= 1,
  });
});

publicRoutes.post('/admin/recovery', async (c) => {
  const limited = await guardAdminRecovery(c);
  if (limited) return limited;

  const parsed = await readPublicJsonObject(c);
  if ('response' in parsed) return parsed.response;

  const serviceRoleKey = readRecoverySecretKey(parsed.body);
  const username = readRecoveryUsername(parsed.body);
  const password = readRecoveryPassword(parsed.body);

  const usernameError = validateRecoveryUsername(username);
  if (usernameError) return c.json({ error: usernameError }, 400);
  const passwordError = validateAdminPasswordStrength(password, username);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const database = getDatabase(c.env);
  const userCount = await db.countUsers(database);
  if (userCount > 1) {
    return c.json({ error: '当前存在多个管理员账号，请登录后在账户管理中修改密码' }, 409);
  }
  if (userCount === 1) {
    if (!serviceRoleKey || serviceRoleKey.length > MAX_ADMIN_RECOVERY_KEY_LENGTH) {
      return c.json({ error: 'Supabase Secret key 无效' }, 400);
    }
    if (!await timingSafeEqualString(serviceRoleKey, resolveSupabaseApiKey(c.env))) {
      return c.json({ error: 'Supabase Secret key 无效' }, 403);
    }
  }

  const user = await db.recoverSingleAdmin(database, {
    uuid: crypto.randomUUID(),
    username,
    hashedPassword: await hashPassword(password),
  });
  invalidateAdminSessionCache(user.uuid);
  if (user.session_version > 1) {
    await deleteAdminSessionEdgeCache(c, user.uuid, user.session_version - 1);
  }
  runLoginBackground(
    c,
    db.insertAuditLog(
      database,
      username,
      'admin_recovery',
      userCount === 0 ? '首次创建管理员账号' : '通过 Supabase Secret key 重置管理员账号',
      'warning',
    ),
  );

  return c.json({
    success: true,
    mode: userCount === 0 ? 'created' : 'reset',
    user: { uuid: user.uuid, username: user.username },
  });
});

// 登录
publicRoutes.post('/login', async (c) => {
  const metrics: TimingMetric[] = [];
  const parsed = await timed(metrics, 'parse_body', () => readPublicJsonObject(c));
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;

  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return c.json({ error: '用户名和密码不能为空' }, 400);
  }
  if (username.length > MAX_LOGIN_USERNAME_LENGTH || password.length > MAX_LOGIN_PASSWORD_LENGTH) {
    return c.json({ error: '用户名或密码长度超出限制' }, 400);
  }

  const clientIp = getClientIp(c);
  const rateLimitBuckets = loginRateLimitBuckets(clientIp, username);
  const nowMs = Date.now();
  const database = getDatabase(c.env);
  if (
    lastLoginRateLimitCleanupAt === 0 ||
    nowMs - lastLoginRateLimitCleanupAt >= LOGIN_RATE_LIMIT_CLEANUP_INTERVAL_MS
  ) {
    runLoginBackground(c, cleanupExpiredLoginRateLimits(database, nowMs));
  }

  const rateLimitStates = await timed(metrics, 'db_rate_limit', () => loadLoginRateLimitStates(database, rateLimitBuckets));
  const retryAfter = getLoginRetryAfterSeconds(rateLimitStates, nowMs);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    await timed(metrics, 'audit_failure', () => auditLoginFailure(database, username, clientIp, 'rate_limited', nowMs));
    setServerTiming(c, metrics);
    return c.json({ error: `登录尝试过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  }

  const user = await timed(metrics, 'db_user', () => db.getUserByUsername(database, username));
  if (!user) {
    const userCount = await timed(metrics, 'db_user_count', () => db.countUsers(database));
    await timed(metrics, 'verify_password', () => verifyPassword(password, DUMMY_ADMIN_PASSWORD_HASH));
    const failedAt = Date.now();
    await timed(metrics, 'db_record_failure', () => recordLoginFailure(database, rateLimitBuckets, failedAt, rateLimitStates));
    await timed(metrics, 'audit_failure', () => auditLoginFailure(database, username, clientIp, 'unknown_user', failedAt));
    setServerTiming(c, metrics);
    if (userCount === 0) {
      return c.json({ error: '请先在登录页创建管理员账号' }, 409);
    }
    return c.json({ error: '用户名或密码错误' }, 401);
  }

  const valid = await timed(metrics, 'verify_password', () => verifyPassword(password, user.passwd));
  if (!valid) {
    const failedAt = Date.now();
    await timed(metrics, 'db_record_failure', () => recordLoginFailure(database, rateLimitBuckets, failedAt, rateLimitStates));
    await timed(metrics, 'audit_failure', () => auditLoginFailure(database, username, clientIp, 'invalid_password', failedAt));
    setServerTiming(c, metrics);
    return c.json({ error: '用户名或密码错误' }, 401);
  }

  if (needsPasswordRehash(user.passwd)) {
    runLoginBackground(
      c,
      hashPassword(password).then((hashedPassword) => db.updateUserPassword(database, user.uuid, hashedPassword)),
    );
  }

  if (user.totp_enabled_at && user.totp_secret_enc) {
    try {
      const challenge = await timed(metrics, 'sign_mfa_challenge', () => generateMfaToken({
        userId: user.uuid,
        username: user.username,
        sessionVersion: user.session_version,
        purpose: 'mfa-login',
      }, c.env));
      setServerTiming(c, metrics);
      return c.json({
        code: 'MFA_REQUIRED',
        mfa_required: true,
        challenge,
        methods: ['totp', 'recovery_code'],
      });
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
        return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
      }
      throw error;
    }
  }

  return completeAdminLogin(
    c,
    database,
    user,
    [...rateLimitStates.values()].some(Boolean) ? rateLimitBuckets : [],
    metrics,
  );
});

publicRoutes.post('/login/mfa', async (c) => {
  const metrics: TimingMetric[] = [];
  const parsed = await timed(metrics, 'parse_body', () => readPublicJsonObject(c));
  if ('response' in parsed) return parsed.response;

  const challenge = typeof parsed.body.challenge === 'string' ? parsed.body.challenge : '';
  const method = parsed.body.method;
  const code = typeof parsed.body.code === 'string' ? parsed.body.code.trim() : '';
  if (
    !challenge ||
    challenge.length > MAX_MFA_CHALLENGE_LENGTH ||
    (method !== 'totp' && method !== 'recovery_code') ||
    !code ||
    code.length > MAX_MFA_CODE_LENGTH
  ) {
    return c.json({ code: 'MFA_INPUT_INVALID', error: '双重身份验证参数无效' }, 400);
  }

  let payload;
  try {
    payload = await timed(metrics, 'verify_mfa_challenge', () => verifyMfaToken(challenge, 'mfa-login', c.env));
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
      return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
    }
    throw error;
  }
  if (!payload) {
    return c.json({ code: 'MFA_CHALLENGE_INVALID', error: '登录验证已失效，请重新登录' }, 401);
  }

  const database = getDatabase(c.env);
  const user = await timed(metrics, 'db_user', () => db.getUserByUuid(database, payload.userId));
  if (
    !user ||
    user.username !== payload.username ||
    user.session_version !== payload.sessionVersion ||
    !user.totp_enabled_at ||
    !user.totp_secret_enc
  ) {
    return c.json({ code: 'MFA_CHALLENGE_INVALID', error: '登录验证已失效，请重新登录' }, 401);
  }

  const clientIp = getClientIp(c);
  const mfaBuckets = mfaRateLimitBuckets(clientIp, user.uuid);
  const nowMs = Date.now();
  const rateLimitStates = await timed(metrics, 'db_rate_limit', () => loadLoginRateLimitStates(database, mfaBuckets));
  const retryAfter = getLoginRetryAfterSeconds(rateLimitStates, nowMs);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    await timed(metrics, 'audit_failure', () => auditLoginFailure(database, user.username, clientIp, 'mfa_rate_limited', nowMs));
    return c.json({ code: 'MFA_RATE_LIMITED', error: `验证尝试过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  }

  let verified = false;
  if (method === 'totp') {
    try {
      const secret = await timed(metrics, 'decrypt_totp', () => decryptTotpSecret(user.totp_secret_enc!, user.uuid, c.env));
      const result = await timed(metrics, 'verify_totp', () => verifyTotpCode(secret, code));
      if (result.valid && result.step !== undefined) {
        verified = await timed(metrics, 'consume_totp_step', () => db.consumeTotpStep(database, user.uuid, result.step!));
      }
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
        return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
      }
      console.error('[auth] failed to decrypt TOTP secret:', sanitizeSetupDiagnosticDetail(error));
      return c.json({ error: '双重身份验证配置损坏，请使用管理员恢复功能' }, 500);
    }
  } else {
    try {
      const codeHash = await timed(metrics, 'hash_recovery_code', () => hashRecoveryCode(code, c.env));
      verified = await timed(metrics, 'consume_recovery_code', () => db.consumeRecoveryCode(database, user.uuid, codeHash));
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
        return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
      }
      verified = false;
    }
  }

  if (!verified) {
    const failedAt = Date.now();
    await timed(metrics, 'db_record_failure', () => recordLoginFailure(database, mfaBuckets, failedAt, rateLimitStates));
    await timed(metrics, 'audit_failure', () => auditLoginFailure(database, user.username, clientIp, 'invalid_mfa', failedAt));
    setServerTiming(c, metrics);
    return c.json({ code: 'MFA_INVALID', error: '验证码或恢复码无效' }, 401);
  }

  const loginBuckets = loginRateLimitBuckets(clientIp, user.username);
  return completeAdminLogin(c, database, user, [...loginBuckets, ...mfaBuckets], metrics);
});
// 退出登录
publicRoutes.post('/logout', async (c) => {
  const token = getAdminSessionToken(c);
  if (token && !verifyAdminCsrfToken(c)) {
    return c.json({ error: 'CSRF token 无效，请刷新页面后重试' }, 403);
  }
  let payload = null;
  try {
    payload = token ? await verifyAdminToken(token, c.env) : null;
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
    }
  }
  if (payload) {
    await deleteAdminSessionEdgeCache(c, payload.userId, payload.sessionVersion);
    const database = getDatabase(c.env);
    const user = await validateAdminSession(database, payload);
    if (user) {
      await db.rotateUserSession(database, user.uuid);
      invalidateAdminSessionCache(user.uuid);
      await deleteAdminSessionEdgeCache(c, payload.userId, payload.sessionVersion);
    }
  }
  clearAdminSessionCookie(c);
  c.header('Clear-Site-Data', LOGOUT_CLEAR_SITE_DATA_HEADER);
  return c.json({ success: true });
});

async function authSessionHeadResponse(c: PublicContext): Promise<Response> {
  const token = getAdminSessionToken(c);
  if (!token) {
    c.header('X-CF-VPS-Monitor-Authenticated', '0');
    return c.body(null, 204);
  }

  try {
    const payload = await verifyAdminToken(token, c.env);
    if (payload && await getAdminSessionEdgeCache(payload.userId, payload.sessionVersion)) {
      c.header('X-CF-VPS-Monitor-Authenticated', '1');
      return c.body(null, 204);
    }
    const user = payload ? await validateAdminSession(getDatabase(c.env), payload) : null;
    if (user) putAdminSessionEdgeCache(c, user);
    c.header('X-CF-VPS-Monitor-Authenticated', user ? '1' : '0');
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
      return c.body(null, 500);
    }
    c.header('X-CF-VPS-Monitor-Authenticated', '0');
    return c.body(null, 204);
  }
}

// 获取当前用户信息（需要 token）
publicRoutes.get('/me', async (c) => {
  if (c.req.method === 'HEAD') return authSessionHeadResponse(c);

  const token = getAdminSessionToken(c);
  if (!token) {
    return c.json({ error: '未登录' }, 401);
  }

  try {
    const payload = await verifyAdminToken(token, c.env);
    if (!payload) {
      return c.json({ error: 'Token 无效' }, 401);
    }
    if (await getAdminSessionEdgeCache(payload.userId, payload.sessionVersion)) {
      const csrfToken = ensureAdminCsrfCookie(c);
      return c.json({
        uuid: payload.userId,
        username: payload.username,
        csrf_token: csrfToken,
      });
    }
    const database = getDatabase(c.env);
    const user = await validateAdminSession(database, payload);
    if (!user) {
      return c.json({ error: 'Token 无效' }, 401);
    }
    putAdminSessionEdgeCache(c, user);
    const csrfToken = ensureAdminCsrfCookie(c);
    return c.json({
      uuid: user.uuid,
      username: user.username,
      csrf_token: csrfToken,
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
      return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
    }
    return c.json({ error: 'Token 无效' }, 401);
  }
});

// 获取所有客户端列表（公开）
publicRoutes.get('/site-logo', async (c) => {
  const settings = await db.getSettingsByKeys(getDatabase(c.env), ['site_logo_data', 'site_logo_type']);
  const contentBase64 = settings.site_logo_data || '';
  const contentType = settings.site_logo_type || '';
  if (!contentBase64 || !SITE_LOGO_TYPES.has(contentType)) return c.body(null, 404);

  return new Response(base64ToBytes(contentBase64), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
});

publicRoutes.get('/clients', async (c) => {
  const fresh = isFreshPublicMetadataRequest(c);
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
  const cached = !fresh && !includeHidden ? await getCachedPublicMetadataResponse(c, 'clients') : null;
  if (cached) return cached;
  const limited = await guardPublicMetadata(c, 'clients');
  if (limited) return limited;
  const snapshot = await getPublicClientsSnapshot(c, getDatabase(c.env), fresh, includeHidden);
  return includeHidden ? privateJsonResponse(snapshot.clients) : setPublicMetadataResponse(c, snapshot.clients, !fresh);
});

// 获取公开设置
publicRoutes.get('/public', async (c) => {
  const fresh = isFreshPublicMetadataRequest(c);
  const cached = !fresh ? await getCachedPublicMetadataResponse(c, 'settings') : null;
  if (cached) return cached;
  const limited = await guardPublicMetadata(c, 'settings');
  if (limited) return limited;
  return setPublicMetadataResponse(c, await getPublicSettings(getDatabase(c.env), fresh), !fresh);
});

// 公开首屏 bootstrap：合并设置、节点元数据和最近实时快照，减少冷启动串行请求。
publicRoutes.get('/public/bootstrap', async (c) => {
  const fresh = isFreshPublicMetadataRequest(c);
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
  const cached = !fresh && !includeHidden ? await getCachedPublicMetadataResponse(c, 'bootstrap') : null;
  if (cached) return cached;
  const limited = await guardPublicMetadata(c, 'bootstrap');
  if (limited) return limited;

  const [settings, snapshot, live] = await Promise.all([
    getPublicSettings(getDatabase(c.env), fresh),
    getPublicClientsSnapshot(c, getDatabase(c.env), fresh, includeHidden),
    c.env.LIVE_DATA
      .get(c.env.LIVE_DATA.idFromName('global'))
      .fetch(new Request(`https://do/live${includeHidden ? '?include_hidden=1' : ''}`, { method: 'GET' }))
      .then(response => readLiveSnapshot(response))
      .then(snapshot => snapshot ?? { online: [], count: 0 }),
  ]);
  const payload = {
    settings,
    clients: snapshot.clients,
    nodes: snapshot.nodes,
    live,
    metadata_version: String(snapshot.expiresAt),
    snapshot_at: Date.now(),
    server_time: Date.now(),
  };
  return includeHidden ? privateJsonResponse(payload) : setPublicMetadataResponse(c, payload, !fresh);
});

// 获取客户端最近的监控记录
publicRoutes.get('/recent/:uuid', async (c) => {
  const uuid = c.req.param('uuid');
  const limit = readIntParam(c.req.query('limit'), 30, 150);
  const database = getDatabase(c.env);
  const prepared = await preparePublicHistoryRequest(c, database, uuid, 'recent');
  if (prepared.response) return prepared.response;
  if (!prepared.visible) return publicHistoryResult(c, prepared, []);
  const records = await db.getRecentRecords(database, uuid, limit);
  return publicHistoryResult(c, prepared, records);
});

// 获取系统负载历史记录
publicRoutes.get('/records/load', async (c) => {
  const uuid = c.req.query('uuid');
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!uuid) {
    return c.json({ error: '缺少 uuid 参数' }, 400);
  }

  if (start && end) {
    const rangeError = validatePublicTimeRange(start, end);
    if (rangeError) return c.json({ error: rangeError }, 400);
  }

  const database = getDatabase(c.env);
  const prepared = await preparePublicHistoryRequest(c, database, uuid, 'records-load');
  if (prepared.response) return prepared.response;
  if (!prepared.visible) {
    if (wantsPagedResponse(c)) {
      const params = readPublicHistoryPageParams(c, 100, 500);
      if ('response' in params) return params.response;
      return publicHistoryResult(c, prepared, emptyPagedResult(params.page, params.limit));
    }
    return publicHistoryResult(c, prepared, []);
  }

  if (start && end) {
    const limitQuery = c.req.query('limit');
    if (wantsPagedResponse(c)) {
      const cursorParam = readTimeCursorParam(c.req.query('cursor'));
      if (cursorParam.error) return c.json({ error: cursorParam.error }, 400);
      if (cursorParam.cursor) {
        const limit = readIntParam(limitQuery, 100, 500);
        return publicHistoryResult(c, prepared, await db.getRecordsByTimeRangeCursor(database, uuid, start, end, cursorParam.cursor, limit));
      }
      const params = readPublicHistoryPageParams(c, 100, 500);
      if ('response' in params) return params.response;
      return publicHistoryResult(c, prepared, await db.getRecordsByTimeRangePaged(database, uuid, start, end, params.page, params.limit));
    }

    const limit = readIntParam(limitQuery, 500, 1000);
    return publicHistoryResult(c, prepared, await db.getRecordsByTimeRangeLimited(database, uuid, start, end, limit));
  }

  const records = await db.getRecentRecords(database, uuid, readIntParam(c.req.query('limit'), 150, 500));
  if (wantsPagedResponse(c)) {
    return publicHistoryResult(c, prepared, {
      data: records,
      total: records.length,
      page: 1,
      limit: records.length,
      has_more: false,
    });
  }
  return publicHistoryResult(c, prepared, records);
});

// 获取 GPU 记录
publicRoutes.get('/records/gpu', async (c) => {
  const uuid = c.req.query('uuid');
  const start = c.req.query('start');
  const end = c.req.query('end');
  const limit = readIntParam(c.req.query('limit'), 100, 500);

  if (!uuid) {
    return c.json({ error: '缺少 uuid 参数' }, 400);
  }

  if (start && end) {
    const rangeError = validatePublicTimeRange(start, end);
    if (rangeError) return c.json({ error: rangeError }, 400);
  }

  const database = getDatabase(c.env);
  const prepared = await preparePublicHistoryRequest(c, database, uuid, 'records-gpu');
  if (prepared.response) return prepared.response;
  if (!prepared.visible) {
    if (wantsPagedResponse(c)) {
      const params = readPublicHistoryPageParams(c, 100, 500);
      if ('response' in params) return params.response;
      return publicHistoryResult(c, prepared, emptyPagedResult(params.page, params.limit));
    }
    return publicHistoryResult(c, prepared, []);
  }

  if (wantsPagedResponse(c)) {
    const cursorParam = readTimeCursorParam(c.req.query('cursor'));
    if (cursorParam.error) return c.json({ error: cursorParam.error }, 400);
    if (cursorParam.cursor) {
      return publicHistoryResult(c, prepared, await db.getGPURecordsCursor(database, uuid, start, end, cursorParam.cursor, limit));
    }
    const params = readPublicHistoryPageParams(c, 100, 500);
    if ('response' in params) return params.response;
    return publicHistoryResult(c, prepared, await db.getGPURecordsPaged(database, uuid, start, end, params.page, params.limit));
  }

  const records = await db.getGPURecords(database, uuid, start, end, limit);
  return publicHistoryResult(c, prepared, records);
});

// 获取 Ping 记录
publicRoutes.get('/records/ping', async (c) => {
  const uuid = c.req.query('uuid');
  const taskId = parseInt(c.req.query('task_id') || '0');
  const limit = readIntParam(c.req.query('limit'), 120, 360);

  if (!uuid || !taskId) {
    return c.json({ error: '缺少参数' }, 400);
  }

  const database = getDatabase(c.env);
  const prepared = await preparePublicHistoryRequest(c, database, uuid, 'records-ping');
  if (prepared.response) return prepared.response;
  if (!prepared.visible) {
    if (wantsPagedResponse(c)) {
      const params = readPublicHistoryPageParams(c, 120, 360);
      if ('response' in params) return params.response;
      return publicHistoryResult(c, prepared, emptyPagedResult(params.page, params.limit));
    }
    return publicHistoryResult(c, prepared, []);
  }

  if (wantsPagedResponse(c)) {
    const cursorParam = readTimeCursorParam(c.req.query('cursor'));
    if (cursorParam.error) return c.json({ error: cursorParam.error }, 400);
    if (cursorParam.cursor) {
      return publicHistoryResult(c, prepared, await db.getPingRecordsCursor(database, uuid, taskId, cursorParam.cursor, limit));
    }
    const params = readPublicHistoryPageParams(c, 120, 360);
    if ('response' in params) return params.response;
    return publicHistoryResult(c, prepared, await db.getPingRecordsPaged(database, uuid, taskId, params.page, params.limit));
  }

  const records = await db.getPingRecords(database, uuid, taskId, limit);
  return publicHistoryResult(c, prepared, records);
});

// 批量获取 Ping 记录。详情页用它一次读取多个任务，避免同一批 ping_snapshots 被重复扫描。
publicRoutes.get('/records/ping/batch', async (c) => {
  const uuid = c.req.query('uuid');
  const taskSpecs = readPingTaskHistorySpecs(c.req.query('task_specs'), 16);
  const taskIds = taskSpecs.length > 0
    ? taskSpecs.map(task => task.taskId)
    : readIntListParam(c.req.query('task_ids'), 16);
  const limit = readIntParam(c.req.query('limit'), 120, 360);
  const baseIntervalSec = readIntParam(c.req.query('base_interval'), 60, 86_400);
  const cursorParam = readTimeCursorParam(c.req.query('cursor'));
  if (cursorParam.error) return c.json({ error: cursorParam.error }, 400);

  if (!uuid || taskIds.length === 0) {
    return c.json({ error: '缺少参数' }, 400);
  }

  const database = getDatabase(c.env);
  const prepared = await preparePublicHistoryRequest(c, database, uuid, 'records-ping-batch');
  if (prepared.response) return prepared.response;
  if (!prepared.visible) return publicHistoryResult(c, prepared, {});

  const records = await db.getPingRecordsForTasks(
    database,
    uuid,
    taskSpecs.length > 0 ? taskSpecs : taskIds,
    limit,
    baseIntervalSec,
    cursorParam.cursor,
  );
  return publicHistoryResult(c, prepared, records);
});

// 获取 Ping 任务列表（公开）
publicRoutes.get('/task/ping', async (c) => {
  const fresh = isFreshPublicMetadataRequest(c);
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
  const cached = !fresh && !includeHidden ? await getCachedPublicMetadataResponse(c, 'ping-tasks') : null;
  if (cached) return cached;
  const limited = await guardPublicMetadata(c, 'ping-tasks');
  if (limited) return limited;
  const database = getDatabase(c.env);
  const snapshot = await getPublicClientsSnapshot(c, database, fresh, includeHidden);
  const settings = await getPublicSettings(database, fresh);
  const tasks = await getPublicPingTasks(database, snapshot.publicClientIds, boundedPublicPingIntervalSec(settings), fresh);
  return includeHidden ? privateJsonResponse(tasks) : setPublicMetadataResponse(c, tasks, !fresh);
});

// 获取网站监控列表（公开）
publicRoutes.get('/websites', async (c) => {
  const metrics: TimingMetric[] = [];
  const fresh = isFreshPublicMetadataRequest(c);
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
  const cached = !fresh && !includeHidden ? await getCachedPublicMetadataResponse(c, 'websites') : null;
  if (cached) return cached;
  const limited = await guardPublicMetadata(c, 'websites');
  if (limited) return limited;
  const database = getDatabase(c.env);
  const periodHours = readIntParam(c.req.query('hours'), 24, 72);
  const monitors = await timed(metrics, 'db_list_websites', () => db.listPublicWebsiteMonitors(database, 120, fresh, periodHours, includeHidden));
  const response = includeHidden ? privateJsonResponse(monitors) : setPublicMetadataResponse(c, monitors, !fresh);
  response.headers.set('Server-Timing', metrics.map(metric => `${metric.name};dur=${metric.dur.toFixed(1)}`).join(', '));
  return response;
});

publicRoutes.get('/websites/:id/checks', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Not Found' }, 404);
  const limited = await guardPublicHistory(c, 'website-checks');
  if (limited) return limited;
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
  const cacheKey = publicHistoryCacheKey(c, 'website-checks');
  const cached = includeHidden ? null : await getPublicHistoryCache(c, cacheKey);
  if (cached) return cached;
  const limit = readIntParam(c.req.query('limit'), 120, 500);
  const database = getDatabase(c.env);
  const monitor = await db.getPublicWebsiteMonitorById(database, id, 1, includeHidden);
  if (!monitor) return c.json({ error: 'Not Found' }, 404);
  const checks = (await db.listWebsiteChecks(database, id, limit)).map(check => ({
    checked_at: check.checked_at,
    ok: check.ok,
    effective_status: check.effective_status,
    effective_reason: check.effective_reason,
    status_code: check.status_code,
    raw_status_code: check.raw_status_code,
    latency_ms: check.latency_ms,
  }));
  return includeHidden ? privateJsonResponse(checks) : setPublicHistoryCache(c, cacheKey, checks);
});

publicRoutes.get('/websites/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Not Found' }, 404);
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
  const cached = includeHidden ? null : await getCachedPublicMetadataResponse(c, 'website-detail');
  if (cached) return cached;
  const limited = await guardPublicMetadata(c, 'website-detail');
  if (limited) return limited;
  const database = getDatabase(c.env);
  const monitor = await db.getPublicWebsiteMonitorById(database, id, readIntParam(c.req.query('limit'), 120, 500), includeHidden);
  if (!monitor) return c.json({ error: 'Not Found' }, 404);
  return includeHidden ? privateJsonResponse(monitor) : setPublicMetadataResponse(c, monitor);
});

// 节点信息（兼容旧版格式）
publicRoutes.get('/nodes', async (c) => {
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
  const cached = includeHidden ? null : await getCachedPublicMetadataResponse(c, 'nodes');
  if (cached) return cached;
  const limited = await guardPublicMetadata(c, 'nodes');
  if (limited) return limited;
  const snapshot = await getPublicClientsSnapshot(c, getDatabase(c.env), false, includeHidden);
  return includeHidden ? privateJsonResponse(snapshot.nodes) : setPublicMetadataResponse(c, snapshot.nodes);
});

// 实时数据 - 代理到 Durable Object
publicRoutes.get('/live', async (c) => {
  const limited = await guardPublicLive(c);
  if (limited) return limited;
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);
  const cached = includeHidden ? null : await getPublicEdgeCache(c, PUBLIC_LIVE_CACHE_SECONDS);
  if (cached) return cached;

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);
  const doUrl = new URL(c.req.url);
  if (includeHidden) doUrl.searchParams.set('include_hidden', '1');
  else doUrl.searchParams.delete('include_hidden');
  const response = includeHidden
    ? privateJsonResponse(await (await stub.fetch(new Request(doUrl.toString(), c.req.raw))).json())
    : withPublicCacheHeader(c, await stub.fetch(new Request(doUrl.toString(), c.req.raw)), PUBLIC_LIVE_CACHE_SECONDS, 'miss');
  if (!includeHidden) putPublicEdgeCache(c, response);
  return response;
});

export { publicRoutes, generateToken, hashPassword, verifyPassword };
