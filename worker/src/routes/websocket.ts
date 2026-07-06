/**
 * WebSocket routes for agent reports and live viewer snapshots.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { getDatabase } from '../db/provider';
import { createViewerToken, verifyViewerToken } from '../auth/viewer-token';
import { getAgentClientIdentityByToken } from './client';
import { getCloudflareClientIp, isPublicIpAddress } from '../utils/request-ip';
import { readLiveSnapshot, readRateLimitResult } from '../utils/do-response';
import { hasAdminSession, invalidatePublicMetadataCache } from './public';

const wsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
type WsContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type CloudflareRequestMetadata = {
  city?: unknown;
  region?: unknown;
  country?: unknown;
};
const VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS = 60_000;
const VIEWER_TOKEN_RATE_LIMIT_MAX = 20;
const LIVE_CLIENTS_RATE_LIMIT_WINDOW_MS = 60_000;
const LIVE_CLIENTS_RATE_LIMIT_MAX = 180;
const LIVE_CLIENTS_CACHE_SECONDS = 2;
const DEFAULT_VIEWER_TTL_SECONDS = 120;
const LIVE_VIEWER_WS_PROTOCOL = 'cf-monitor-viewer';
const LOCAL_WS_RATE_LIMIT_SWEEP_EVERY = 256;

let localWsRateLimitSweepCounter = 0;
const localWsRateLimitBuckets = new Map<string, { count: number; resetAt: number; lastSeenAt: number }>();

export function invalidateLiveViewerSettingsCache(): void {
  // Kept for the settings save path; viewer tokens stay on the fast default.
}

function bearerToken(c: WsContext): string {
  const authHeader = c.req.header('Authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

function requestHasValidOrigin(c: WsContext): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true;

  try {
    const requestUrl = new URL(c.req.url);
    const originUrl = new URL(origin);
    return originUrl.protocol === requestUrl.protocol && originUrl.host === requestUrl.host;
  } catch {
    return false;
  }
}

function isWebSocketUpgrade(c: WsContext): boolean {
  return (c.req.header('Upgrade') || '').toLowerCase() === 'websocket';
}

function viewerTokenFromProtocol(c: WsContext): string {
  const protocols = (c.req.header('Sec-WebSocket-Protocol') || '')
    .split(',')
    .map(protocol => protocol.trim())
    .filter(Boolean);
  const markerIndex = protocols.indexOf(LIVE_VIEWER_WS_PROTOCOL);
  return markerIndex >= 0 ? protocols[markerIndex + 1] || '' : '';
}

function requestIp(c: WsContext): string {
  return getCloudflareClientIp(c);
}

function requestRegion(c: WsContext): string {
  const cf = (c.req.raw as Request & { cf?: CloudflareRequestMetadata }).cf ?? {};
  return [cf.city, cf.region, cf.country || c.req.header('CF-IPCountry')]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(', ');
}

function isUnknownRegion(region: string): boolean {
  return /^(unknown|未知)$/i.test(region.trim());
}

function isCountryCodeRegion(region: string): boolean {
  return /^[A-Z]{2}$/i.test(region.trim());
}

function isDetailedRegion(region: string): boolean {
  const text = region.trim();
  return text !== '' && !isUnknownRegion(text) && !isCountryCodeRegion(text);
}

async function syncAgentNetworkMetadata(c: WsContext, client: db.ClientIdentity, patch: Partial<db.Client>): Promise<void> {
  const safePatch: Record<string, unknown> = { uuid: client.uuid, ...patch };
  if (typeof patch.ipv4 === 'string') {
    safePatch.has_ipv4 = patch.ipv4.trim() !== '';
  }
  if (typeof patch.ipv6 === 'string') {
    safePatch.has_ipv6 = patch.ipv6.trim() !== '';
  }
  const stub = c.env.LIVE_DATA.get(c.env.LIVE_DATA.idFromName('global'));
  await stub.fetch(new Request('https://do/client-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uuid: client.uuid,
      name: client.name || client.uuid,
      hidden: client.hidden,
      client: safePatch,
    }),
  })).catch(() => undefined);
}

function cleanupLocalWsRateLimitBuckets(nowMs: number): void {
  for (const [key, bucket] of localWsRateLimitBuckets) {
    if (bucket.resetAt <= nowMs || nowMs - bucket.lastSeenAt > VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS * 5) {
      localWsRateLimitBuckets.delete(key);
    }
  }
}

function wsRateLimitResponse(error: string, retryAfter: number, limit: number, remaining: number, noStore = false): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfter),
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
  };
  if (noStore) headers['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify({ error }), { status: 429, headers });
}

function localWsRateLimit(
  c: WsContext,
  bucket: string,
  ip: string,
  max: number,
  windowMs: number,
  error: string,
  noStore = false,
): Response | null {
  const nowMs = Date.now();
  localWsRateLimitSweepCounter += 1;
  if (localWsRateLimitSweepCounter % LOCAL_WS_RATE_LIMIT_SWEEP_EVERY === 0) {
    cleanupLocalWsRateLimitBuckets(nowMs);
  }

  const key = `ws:${bucket}:${ip || 'unknown'}`;
  let state = localWsRateLimitBuckets.get(key);
  if (!state || state.resetAt <= nowMs) {
    state = { count: 0, resetAt: nowMs + windowMs, lastSeenAt: nowMs };
  }
  state.count += 1;
  state.lastSeenAt = nowMs;
  localWsRateLimitBuckets.set(key, state);

  const retryAfter = Math.max(1, Math.ceil((state.resetAt - nowMs) / 1000));
  const remaining = Math.max(0, max - state.count);
  c.header('X-RateLimit-Limit', String(max));
  c.header('X-RateLimit-Remaining', String(remaining));
  if (state.count <= max) return null;
  return wsRateLimitResponse(error, retryAfter, max, remaining, noStore);
}

async function enforceWsRateLimit(
  c: WsContext,
  doName: string,
  bucket: string,
  ip: string,
  max: number,
  windowMs: number,
  error: string,
  noStore = false,
): Promise<Response | null> {
  try {
    const namespace = c.env.RATE_LIMIT;
    if (!namespace) return localWsRateLimit(c, bucket, ip, max, windowMs, error, noStore);
    const doId = namespace.idFromName(doName);
    const stub = namespace.get(doId);
    const response = await stub.fetch(new Request('https://do/rate-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket, ip, max, windowMs }),
    }));
    if (!response.ok) throw new Error(`DO rate limit HTTP ${response.status}`);
    const result = await readRateLimitResult(response, { limit: max, remaining: max });
    if (!result) throw new Error('DO rate limit returned an invalid response');
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    if (result.allowed) return null;
    return wsRateLimitResponse(
      error,
      result.retryAfter,
      result.limit,
      result.remaining,
      noStore,
    );
  } catch {
    return localWsRateLimit(c, bucket, ip, max, windowMs, error, noStore);
  }
}

async function viewerTtlMs(_c: WsContext): Promise<number> {
  return DEFAULT_VIEWER_TTL_SECONDS * 1000;
}

async function enforceViewerTokenRateLimit(c: WsContext, ip: string): Promise<Response | null> {
  return enforceWsRateLimit(
    c,
    'viewer-token',
    'viewer-token',
    ip,
    VIEWER_TOKEN_RATE_LIMIT_MAX,
    VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS,
    'Too many live viewer token requests',
    true,
  );
}

async function enforceLiveClientsRateLimit(c: WsContext, ip: string): Promise<Response | null> {
  return enforceWsRateLimit(
    c,
    'live-clients',
    'live-clients',
    ip,
    LIVE_CLIENTS_RATE_LIMIT_MAX,
    LIVE_CLIENTS_RATE_LIMIT_WINDOW_MS,
    'Too many live clients requests',
    true,
  );
}

function jwtSecret(c: WsContext): string {
  return String(c.env.JWT_SECRET || '').trim();
}

wsRoutes.get('/clients/report', async (c) => {
  const token = bearerToken(c) || String(c.req.query('token') || '').trim();

  if (!token) {
    return c.json({ error: 'Missing token' }, 401);
  }

  const database = getDatabase(c.env);
  const client = await getAgentClientIdentityByToken(database, token, c.env, getCloudflareClientIp(c, ''));
  if (!client) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  const region = requestRegion(c);
  const sourceIp = getCloudflareClientIp(c, '');
  const sourceIpIsPublic = isPublicIpAddress(sourceIp);
  if (region) {
    const storedClient = await db.getClient(database, client.uuid);
    const patch: Partial<db.Client> = {};
    if (storedClient) {
      if (
        region &&
        (
          !storedClient.region ||
          isUnknownRegion(storedClient.region) ||
          (isCountryCodeRegion(storedClient.region) && isDetailedRegion(region))
        )
      ) {
        patch.region = region;
      }
      if (Object.keys(patch).length > 0) {
        await db.updateClient(database, client.uuid, patch);
        await syncAgentNetworkMetadata(c, client, patch);
        invalidatePublicMetadataCache();
      }
    }
  }

  if (!isWebSocketUpgrade(c)) {
    return c.json({ error: 'WebSocket upgrade required' }, 400);
  }
  if (!requestHasValidOrigin(c)) {
    return c.json({ error: 'Invalid WebSocket Origin' }, 403);
  }

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);

  const url = new URL(c.req.url);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('id', client.uuid);
  url.searchParams.set('name', client.name);
  url.searchParams.set('hidden', client.hidden ? '1' : '0');
  url.searchParams.set('role', 'agent');
  if (sourceIpIsPublic) url.searchParams.set('source_ip', sourceIp);
  if (region) url.searchParams.set('region', region);

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

wsRoutes.get('/ws/live-token', async (c) => {
  const secret = jwtSecret(c);
  if (new TextEncoder().encode(secret).byteLength < 32) {
    return c.json({ error: 'Server authentication is not configured' }, 500);
  }

  const ip = requestIp(c);
  const limited = await enforceViewerTokenRateLimit(c, ip);
  if (limited) return limited;

  const ttlMs = await viewerTtlMs(c);
  c.header('Cache-Control', 'no-store');
  return c.json(await createViewerToken({
    ip,
    secret,
    ttlMs,
  }));
});

wsRoutes.get('/ws/live', async (c) => {
  if (!isWebSocketUpgrade(c)) {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    const url = new URL(c.req.url);
    const includeHidden = url.searchParams.get('include_hidden') === '1' && await hasAdminSession(c);
    if (includeHidden) url.searchParams.set('include_hidden', '1');
    else url.searchParams.delete('include_hidden');
    return stub.fetch(new Request(url.toString(), { method: 'GET' }));
  }
  if (!requestHasValidOrigin(c)) {
    return c.json({ error: 'Invalid WebSocket Origin' }, 403);
  }

  const viewerIp = requestIp(c);
  const viewerToken = viewerTokenFromProtocol(c);
  const secret = jwtSecret(c);
  if (!viewerToken) {
    return c.json({ error: 'Missing viewer token' }, 401);
  }
  if (new TextEncoder().encode(secret).byteLength < 32) {
    return c.json({ error: 'Server authentication is not configured' }, 500);
  }
  if (!await verifyViewerToken({ token: viewerToken, ip: viewerIp, secret })) {
    return c.json({ error: 'Invalid viewer token' }, 403);
  }

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);

  const url = new URL(c.req.url);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('id', 'frontend-' + crypto.randomUUID());
  url.searchParams.set('role', 'viewer');
  url.searchParams.set('viewer_ttl_ms', String(await viewerTtlMs(c)));
  url.searchParams.set('viewer_ip', viewerIp);
  if (includeHidden) url.searchParams.set('include_hidden', '1');

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

wsRoutes.get('/live/clients', async (c) => {
  const limited = await enforceLiveClientsRateLimit(c, requestIp(c));
  if (limited) return limited;
  const includeHidden = c.req.query('include_hidden') === '1' && await hasAdminSession(c);

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);

  const response = await stub.fetch(new Request(`https://do/live${includeHidden ? '?include_hidden=1' : ''}`, { method: 'GET' }));
  const snapshot = await readLiveSnapshot(response) ?? { online: [], count: 0 };
  c.header('Cache-Control', includeHidden ? 'no-store' : `public, max-age=${LIVE_CLIENTS_CACHE_SECONDS}, s-maxage=${LIVE_CLIENTS_CACHE_SECONDS}, stale-while-revalidate=${LIVE_CLIENTS_CACHE_SECONDS * 2}`);
  return c.json(snapshot);
});

export { wsRoutes };
