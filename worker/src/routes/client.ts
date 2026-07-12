/**
 * Agent 客户端 API 路由
 * 用于 Agent 上报数据、获取 Ping 任务等
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { getDatabase } from '../db/provider';
import { buildAdminSettings } from '../settings/schema';
import { normalizeMonitorReport, type MonitorReportPayload } from '../utils/monitor-report';
import { validatePingResults } from '../utils/ping-result';
import { buildIpChangeNotification } from '../utils/notification-templates';
import { bestEffortRecordHealthEvent, errorDetail } from '../utils/observability';
import { NOTIFICATION_DISPATCH_SETTING_KEYS, dispatchNotification } from '../utils/notification-dispatch';
import { getCloudflareClientIp, isPublicIpAddress } from '../utils/request-ip';
import { hashAgentToken, isAgentTokenShape } from '../utils/client';
import { readAcceptedCount, readClientReportResult, readRateLimitResult } from '../utils/do-response';
import { invalidatePublicMetadataCache } from './public';

const clientRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
type ClientContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type CloudflareRequestMetadata = {
  city?: unknown;
  region?: unknown;
  country?: unknown;
};
const HTTP_LIVE_TTL_FALLBACK_MS = 180_000;
const HTTP_LIVE_TTL_MAX_MS = 24 * 60 * 60 * 1000;
export const AGENT_AUTH_CACHE_MS = 120_000;
const AGENT_AUTH_NEGATIVE_CACHE_MS = 10_000;
const AGENT_AUTH_CACHE_MAX_ENTRIES = 512;
const AGENT_TOKEN_USAGE_CACHE_MS = 15 * 60_000;
const AGENT_PING_TASK_CACHE_MS = 120_000;
const AGENT_PING_TASK_EMPTY_POLL_SEC = 3600;
const AGENT_PING_TASK_MAX_POLL_SEC = 3600;
const AGENT_PING_TASK_MIN_POLL_SEC = 60;
const AGENT_PING_TASK_DEFAULT_INTERVAL_SEC = 120;
const AGENT_PING_INTERVAL_SETTING_CACHE_MS = 120_000;
const AGENT_BASIC_INFO_MAX_BODY_BYTES = 64 * 1024;
const AGENT_REPORT_MAX_BODY_BYTES = 512 * 1024;
const AGENT_PING_RESULT_MAX_BODY_BYTES = 64 * 1024;
const AGENT_REPORT_MAX_BATCH = 300;
const AGENT_RATE_LIMIT_WINDOW_MS = 60_000;
const AGENT_AUTH_ATTEMPT_RATE_LIMIT_MAX = 240;
const AGENT_AUTH_FAILURE_RATE_LIMIT_MAX = 6;
const AGENT_BASIC_INFO_RATE_LIMIT_MAX = 30;
const AGENT_REPORT_RATE_LIMIT_MAX = 120;
const AGENT_PING_RESULT_RATE_LIMIT_MAX = 180;
const IP_CHANGE_NOTIFICATION_SETTING_KEYS = [
  'enable_ip_change_notification',
  ...NOTIFICATION_DISPATCH_SETTING_KEYS,
];
const AGENT_POLICY_SETTING_KEYS = [
  'live_poll_active_interval_sec',
  'live_poll_idle_interval_sec',
  'live_poll_active_max_duration_sec',
  'ping_record_persist_interval_sec',
];
const AGENT_PING_INTERVAL_SETTING_KEYS = ['ping_record_persist_interval_sec'];

type AgentAuthCacheEntry<T> = { value: T | null; expiresAt: number };
type JsonBodyResult = { body: unknown } | { response: Response };
type AgentAuthLookupSource = 'memory' | 'do' | 'db' | 'miss';

let agentAuthCache = new Map<string, AgentAuthCacheEntry<db.Client>>();
let agentIdentityAuthCache = new Map<string, AgentAuthCacheEntry<db.ClientIdentity>>();
let agentTokenUsageCache = new Map<string, { ip: string; expiresAt: number }>();
let agentPingTasksCache: { value: db.PingTask[]; expiresAt: number } | null = null;
let agentPingIntervalCache: { value: number; expiresAt: number } | null = null;
const localAgentRateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function runClientBackground(c: ClientContext, promise: Promise<unknown>): void {
  const task = promise.catch((error) => {
    console.warn('[agent] background task failed:', errorDetail(error));
  });
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(task);
  else void task;
}

export function invalidateAgentClientAuthCache(client?: { uuid?: string; token?: string }): void {
  if (!client) {
    agentAuthCache.clear();
    agentIdentityAuthCache.clear();
    agentTokenUsageCache.clear();
    return;
  }
  for (const [cacheKey, entry] of agentAuthCache) {
    if (entry.value?.uuid === client.uuid) {
      agentAuthCache.delete(cacheKey);
    }
  }
  for (const [cacheKey, entry] of agentIdentityAuthCache) {
    if (entry.value?.uuid === client.uuid) {
      agentIdentityAuthCache.delete(cacheKey);
    }
  }
}

async function agentTokenLookupHash(token: string): Promise<string> {
  return hashAgentToken(token);
}

async function markAgentTokenUsedIfDue(
  database: db.QueryDatabase,
  client: Pick<db.Client, 'uuid' | 'name' | 'token_last_used_ip'>,
  cacheKey: string,
  ip: string,
  now = Date.now(),
): Promise<void> {
  const normalizedIp = ip.trim();
  const cached = agentTokenUsageCache.get(cacheKey);
  if (cached && cached.expiresAt > now && cached.ip === normalizedIp) return;
  if (agentTokenUsageCache.size >= AGENT_AUTH_CACHE_MAX_ENTRIES) {
    const firstKey = agentTokenUsageCache.keys().next().value;
    if (typeof firstKey === 'string') agentTokenUsageCache.delete(firstKey);
  }
  agentTokenUsageCache.set(cacheKey, {
    ip: normalizedIp,
    expiresAt: now + AGENT_TOKEN_USAGE_CACHE_MS,
  });
  const tokenUsageUpdated = await db.markClientTokenUsed(database, client.uuid, normalizedIp).catch(() => false);
  if (tokenUsageUpdated) {
    await recordAgentTokenSourceIpChange(database, client, normalizedIp).catch(() => undefined);
  }
}

export function invalidateAgentPingTaskCache(): void {
  agentPingTasksCache = null;
  agentPingIntervalCache = null;
}

function setAgentAuthCache<T>(
  cache: Map<string, AgentAuthCacheEntry<T>>,
  cacheKey: string,
  value: T | null,
  ttlMs: number,
  now: number,
): void {
  if (cache.size >= AGENT_AUTH_CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (typeof firstKey === 'string') cache.delete(firstKey);
  }
  cache.set(cacheKey, {
    value,
    expiresAt: now + ttlMs,
  });
}

function stripCachedAgentToken<T extends { token?: string }>(client: T): T {
  return client.token ? { ...client, token: '' } : client;
}

function clientStringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function clientNullableStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function clientNumberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clientBooleanField(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

function normalizeLiveAgentAuthClient(value: unknown): db.Client | null {
  if (!isJsonObjectPayload(value)) return null;
  const uuid = clientStringField(value, 'uuid').trim();
  const tokenHash = clientStringField(value, 'token_hash').trim();
  if (!uuid || !tokenHash) return null;
  return {
    uuid,
    token: '',
    token_hash: tokenHash,
    token_last_used_at: clientNullableStringField(value, 'token_last_used_at'),
    token_last_used_ip: clientStringField(value, 'token_last_used_ip'),
    token_rotated_at: clientNullableStringField(value, 'token_rotated_at'),
    name: clientStringField(value, 'name') || uuid,
    cpu_name: clientStringField(value, 'cpu_name'),
    virtualization: clientStringField(value, 'virtualization'),
    arch: clientStringField(value, 'arch'),
    cpu_cores: clientNumberField(value, 'cpu_cores'),
    os: clientStringField(value, 'os'),
    kernel_version: clientStringField(value, 'kernel_version'),
    gpu_name: clientStringField(value, 'gpu_name'),
    ipv4: clientStringField(value, 'ipv4'),
    ipv6: clientStringField(value, 'ipv6'),
    region: clientStringField(value, 'region'),
    remark: clientStringField(value, 'remark'),
    public_remark: clientStringField(value, 'public_remark'),
    mem_total: clientNumberField(value, 'mem_total'),
    swap_total: clientNumberField(value, 'swap_total'),
    disk_total: clientNumberField(value, 'disk_total'),
    version: clientStringField(value, 'version'),
    price: clientNumberField(value, 'price'),
    billing_cycle: clientNumberField(value, 'billing_cycle'),
    auto_renewal: clientBooleanField(value, 'auto_renewal'),
    currency: clientStringField(value, 'currency'),
    expired_at: clientStringField(value, 'expired_at'),
    group: clientStringField(value, 'group'),
    tags: clientStringField(value, 'tags'),
    hidden: clientBooleanField(value, 'hidden'),
    traffic_limit: clientNumberField(value, 'traffic_limit'),
    traffic_limit_type: clientStringField(value, 'traffic_limit_type') || 'sum',
    sort_order: typeof value.sort_order === 'number' && Number.isFinite(value.sort_order) ? value.sort_order : undefined,
    created_at: clientStringField(value, 'created_at'),
    updated_at: clientStringField(value, 'updated_at'),
  };
}

function liveDataAuthStub(env: Bindings): DurableObjectStub | null {
  try {
    const doId = env.LIVE_DATA.idFromName('global');
    return env.LIVE_DATA.get(doId);
  } catch {
    return null;
  }
}

async function readLiveAgentAuthClient(env: Bindings, tokenHash: string): Promise<db.Client | null> {
  const stub = liveDataAuthStub(env);
  if (!stub) return null;
  const response = await stub.fetch(new Request('https://do/agent-auth/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token_hash: tokenHash }),
  })).catch(() => null);
  if (!response?.ok) return null;
  const payload = await response.json().catch(() => null);
  if (!isJsonObjectPayload(payload) || !isJsonObjectPayload(payload.client)) return null;
  return normalizeLiveAgentAuthClient(payload.client);
}

async function upsertLiveAgentAuthClient(env: Bindings, client: db.Client): Promise<void> {
  if (!client.token_hash) return;
  const stub = liveDataAuthStub(env);
  if (!stub) return;
  const { token: _token, ...safeClient } = client;
  await stub.fetch(new Request('https://do/agent-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: { ...safeClient, token: '' } }),
  }));
}

async function sourceIpFingerprint(ip: string): Promise<string> {
  const normalized = ip.trim().toLowerCase();
  if (!normalized) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return `sha256:${Array.from(new Uint8Array(digest)).slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function recordAgentTokenSourceIpChange(
  database: db.QueryDatabase,
  client: Pick<db.Client, 'uuid' | 'name' | 'token_last_used_ip'>,
  ip: string,
): Promise<void> {
  const previousIp = (client.token_last_used_ip || '').trim();
  const nextIp = ip.trim();
  if (!previousIp || !nextIp || previousIp === nextIp) return;

  const [previousIpFingerprint, nextIpFingerprint] = await Promise.all([
    sourceIpFingerprint(previousIp),
    sourceIpFingerprint(nextIp),
  ]);
  await db.insertAuditLog(
    database,
    'system',
    'agent_token_source_ip_change',
    `Agent token source IP changed: uuid=${client.uuid}; name=${client.name || '-'}; previous_ip_fp=${previousIpFingerprint}; new_ip_fp=${nextIpFingerprint}`,
    'warning',
  );
}

export async function getAgentClientByToken(
  database: db.QueryDatabase,
  token: string,
  env: Bindings = {} as Bindings,
  ip = '',
  deferBackground?: (promise: Promise<unknown>) => void,
  onAuthSource?: (source: AgentAuthLookupSource) => void,
): Promise<db.Client | null> {
  const now = Date.now();
  const cacheKey = await agentTokenLookupHash(token);
  const cached = agentAuthCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    onAuthSource?.('memory');
    return cached.value;
  }

  const liveAuthClient = await readLiveAgentAuthClient(env, cacheKey);
  if (liveAuthClient) {
    const cachedClient = stripCachedAgentToken(liveAuthClient);
    setAgentAuthCache(agentAuthCache, cacheKey, cachedClient, AGENT_AUTH_CACHE_MS, now);
    onAuthSource?.('do');
    const tokenUsageTask = markAgentTokenUsedIfDue(database, liveAuthClient, cacheKey, ip, now);
    if (deferBackground) deferBackground(tokenUsageTask);
    else await tokenUsageTask;
    return cachedClient;
  }

  const client = await db.getClientByToken(database, token, true);
  if (client) {
    const cachedClient = stripCachedAgentToken(client);
    setAgentAuthCache(agentAuthCache, cacheKey, cachedClient, AGENT_AUTH_CACHE_MS, now);
    if (deferBackground) deferBackground(upsertLiveAgentAuthClient(env, client));
    onAuthSource?.('db');
    const tokenUsageTask = markAgentTokenUsedIfDue(database, client, cacheKey, ip, now);
    if (deferBackground) deferBackground(tokenUsageTask);
    else await tokenUsageTask;
    return cachedClient;
  } else {
    setAgentAuthCache(agentAuthCache, cacheKey, null, AGENT_AUTH_NEGATIVE_CACHE_MS, now);
  }
  onAuthSource?.('miss');
  return null;
}

export async function getAgentClientIdentityByToken(
  database: db.QueryDatabase,
  token: string,
  env: Bindings = {} as Bindings,
  ip = '',
  deferBackground?: (promise: Promise<unknown>) => void,
  onAuthSource?: (source: AgentAuthLookupSource) => void,
): Promise<db.ClientIdentity | null> {
  const now = Date.now();
  const cacheKey = await agentTokenLookupHash(token);
  const cached = agentIdentityAuthCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    onAuthSource?.('memory');
    return cached.value;
  }

  const liveAuthClient = await readLiveAgentAuthClient(env, cacheKey);
  if (liveAuthClient) {
    const cachedClient = stripCachedAgentToken(liveAuthClient);
    setAgentAuthCache(agentIdentityAuthCache, cacheKey, cachedClient, AGENT_AUTH_CACHE_MS, now);
    onAuthSource?.('do');
    const tokenUsageTask = markAgentTokenUsedIfDue(database, liveAuthClient, cacheKey, ip, now);
    if (deferBackground) deferBackground(tokenUsageTask);
    else await tokenUsageTask;
    return cachedClient;
  }

  const client = await db.getClientIdentityByToken(database, token, true);
  if (client) {
    const cachedClient = stripCachedAgentToken(client);
    setAgentAuthCache(agentIdentityAuthCache, cacheKey, cachedClient, AGENT_AUTH_CACHE_MS, now);
    onAuthSource?.('db');
    const tokenUsageTask = markAgentTokenUsedIfDue(database, client, cacheKey, ip, now);
    if (deferBackground) deferBackground(tokenUsageTask);
    else await tokenUsageTask;
    return cachedClient;
  } else {
    setAgentAuthCache(agentIdentityAuthCache, cacheKey, null, AGENT_AUTH_NEGATIVE_CACHE_MS, now);
  }
  onAuthSource?.('miss');
  return null;
}

async function listAgentPingTasks(database: db.QueryDatabase): Promise<db.PingTask[]> {
  const now = Date.now();
  if (agentPingTasksCache && agentPingTasksCache.expiresAt > now) {
    return agentPingTasksCache.value;
  }

  const tasks = await db.listPingTasks(database);
  agentPingTasksCache = {
    value: tasks,
    expiresAt: now + AGENT_PING_TASK_CACHE_MS,
  };
  return tasks;
}

async function getUnifiedPingIntervalSec(database: db.QueryDatabase): Promise<number> {
  const now = Date.now();
  if (agentPingIntervalCache && agentPingIntervalCache.expiresAt > now) {
    return agentPingIntervalCache.value;
  }

  const settings = buildAdminSettings(await db.getSettingsByKeys(database, AGENT_PING_INTERVAL_SETTING_KEYS));
  const intervalSec = Number(settings.ping_record_persist_interval_sec);
  const bounded = Number.isFinite(intervalSec)
    ? Math.min(Math.max(Math.floor(intervalSec), AGENT_PING_TASK_MIN_POLL_SEC), AGENT_PING_TASK_MAX_POLL_SEC)
    : AGENT_PING_TASK_DEFAULT_INTERVAL_SEC;
  agentPingIntervalCache = {
    value: bounded,
    expiresAt: now + AGENT_PING_INTERVAL_SETTING_CACHE_MS,
  };
  return bounded;
}

function withUnifiedPingInterval(tasks: db.PingTask[], intervalSec: number): db.PingTask[] {
  return tasks.map(task => ({ ...task, interval_sec: intervalSec }));
}

function estimateNextPingTaskPollSec(tasks: db.PingTask[], _unifiedIntervalSec: number): number {
  if (tasks.length === 0) return AGENT_PING_TASK_EMPTY_POLL_SEC;
  return AGENT_PING_TASK_MAX_POLL_SEC;
}

function agentPingTasksForClient(tasks: db.PingTask[], uuid: string, intervalSec: number): db.PingTask[] {
  return withUnifiedPingInterval(tasks.filter(task => {
    if (task.all_clients) return true;
    return task.clients.includes(uuid);
  }), intervalSec);
}

async function agentWebsiteProbeTasksForClient(database: db.QueryDatabase, uuid?: string): Promise<db.WebsiteMonitor[]> {
  if (!uuid) return [];
  return db.listAgentWebsiteProbeTasks(database, uuid, new Date().toISOString(), 20);
}

async function pingPolicyVersion(tasks: db.PingTask[], intervalSec: number): Promise<string> {
  const digestInput = JSON.stringify({
    interval_sec: intervalSec,
    tasks: tasks.map(task => ({
      id: task.id,
      name: task.name,
      type: task.type,
      target: task.target,
      interval_sec: task.interval_sec,
      all_clients: task.all_clients,
      clients: [...task.clients].sort(),
    })),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(digestInput));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function nonEmptyString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function nonUnknownRegion(value: unknown, fallback = ''): string {
  const text = nonEmptyString(value);
  return text && !/^(unknown|未知)$/i.test(text) ? text : fallback;
}

function isCountryCodeRegion(value: string): boolean {
  return /^[A-Z]{2}$/i.test(value.trim());
}

function preferredRegion(...values: unknown[]): string {
  const candidates = values
    .map(value => nonUnknownRegion(value))
    .filter(Boolean);
  return candidates.find(value => !isCountryCodeRegion(value)) || candidates[0] || '';
}

function preferredPublicIp(reported: unknown, fallback = '', current = ''): string {
  for (const value of [reported, fallback, current]) {
    const ip = nonEmptyString(value);
    if (ip && isPublicIpAddress(ip)) return ip;
  }
  return '';
}

function publicIpPatch(reported: unknown, fallback = '', current = ''): string | undefined {
  const preferred = preferredPublicIp(reported, fallback, current);
  const currentIp = nonEmptyString(current);
  if (preferred || !currentIp || isPublicIpAddress(currentIp)) return preferred;
  return '';
}

function isJsonObjectPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJsonObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isJsonObjectPayload);
}

function positiveNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clientFieldChanged(current: unknown, next: unknown): boolean {
  if (typeof next === 'number') return Number(current || 0) !== next;
  return String(current ?? '') !== String(next ?? '');
}

function buildChangedClientPatch(client: db.Client | null | undefined, nextValues: Partial<db.Client>): Partial<db.Client> {
  const patch: Partial<db.Client> = {};
  for (const [key, value] of Object.entries(nextValues)) {
    const typedKey = key as keyof db.Client;
    if (clientFieldChanged(client?.[typedKey], value)) {
      (patch as Record<string, unknown>)[key] = value;
    }
  }
  return patch;
}

function requestClientIp(c: ClientContext): string {
  return getCloudflareClientIp(c, '');
}

function isIPv6(ip: string): boolean {
  return ip.includes(':');
}

function requestRegion(c: ClientContext): string {
  const cf = (c.req.raw as Request & { cf?: CloudflareRequestMetadata }).cf ?? {};
  const parts = [
    cf.city,
    cf.region,
    cf.country || c.req.header('CF-IPCountry'),
  ].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.join(', ');
}

function liveReportTtlMs(report: MonitorReportPayload): number {
  const intervalSec = Number(report.report_interval ?? report.interval_sec ?? report.interval);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return HTTP_LIVE_TTL_FALLBACK_MS;
  return Math.min(Math.max(intervalSec * 3 * 1000, 30_000), HTTP_LIVE_TTL_MAX_MS);
}

function ipChangeParts(oldIpv4: string, oldIpv6: string, newIpv4: string, newIpv6: string): string[] {
  const parts: string[] = [];
  if (oldIpv4 && newIpv4 && oldIpv4 !== newIpv4) {
    parts.push(`IPv4: ${oldIpv4} → ${newIpv4}`);
  }
  if (oldIpv6 && newIpv6 && oldIpv6 !== newIpv6) {
    parts.push(`IPv6: ${oldIpv6.slice(0, 10)}… → ${newIpv6.slice(0, 10)}…`);
  }
  return parts;
}

async function recordIpChangeIfEnabled(database: db.QueryDatabase, clientName: string, parts: string[]): Promise<void> {
  if (parts.length === 0) return;

  const settings = await db.getSettingsByKeys(database, IP_CHANGE_NOTIFICATION_SETTING_KEYS);
  if (settings['enable_ip_change_notification'] !== 'true') return;

  const notification = buildIpChangeNotification({ nodeName: clientName, parts });
  const adminSettings = buildAdminSettings(settings);
  await dispatchNotification(database, adminSettings, notification, {
    deps: { recordHealth: bestEffortRecordHealthEvent },
  });

  await db.insertAuditLog(database, 'system', 'ip_change',
    `IP 变更: ${clientName} ${parts.join(', ')}`);
}

async function syncClientIpsFromReport(
  database: db.QueryDatabase,
  c: ClientContext,
  uuid: string,
  clientName: string,
  report: MonitorReportPayload,
  oldClient: db.Client | null,
): Promise<void> {
  if (!oldClient) return;

  const fallbackIp = requestClientIp(c);
  const reportedIpv4 = nonEmptyString(report.ipv4, '');
  const reportedIpv6 = nonEmptyString(report.ipv6, '');
  const nextIpv4 = publicIpPatch(reportedIpv4, fallbackIp && !isIPv6(fallbackIp) ? fallbackIp : '', oldClient.ipv4);
  const nextIpv6 = publicIpPatch(reportedIpv6, fallbackIp && isIPv6(fallbackIp) ? fallbackIp : '', oldClient.ipv6);
  const ipChanged =
    (nextIpv4 !== undefined && oldClient.ipv4 !== nextIpv4) ||
    (nextIpv6 !== undefined && oldClient.ipv6 !== nextIpv6);
  const edgeRegion = requestRegion(c);
  const nextRegion = ipChanged
    ? preferredRegion(report.region, edgeRegion, oldClient.region)
    : preferredRegion(report.region, oldClient.region, edgeRegion);

  const updates: Record<string, string> = {};
  if (nextIpv4 !== undefined && oldClient.ipv4 !== nextIpv4) updates.ipv4 = nextIpv4;
  if (nextIpv6 !== undefined && oldClient.ipv6 !== nextIpv6) updates.ipv6 = nextIpv6;
  if (nextRegion && oldClient.region !== nextRegion) updates.region = nextRegion;
  if (Object.keys(updates).length === 0) return;

  await db.updateClient(database, uuid, updates);
  invalidatePublicMetadataCache();
  invalidateAgentClientAuthCache({ uuid, token: oldClient.token });
  const parts = ipChangeParts(
    oldClient.ipv4 || '',
    oldClient.ipv6 || '',
    nextIpv4 !== undefined ? nextIpv4 : oldClient.ipv4 || '',
    nextIpv6 !== undefined ? nextIpv6 : oldClient.ipv6 || '',
  );
  await recordIpChangeIfEnabled(database, clientName, parts);
}

async function updateLiveReport(
  c: ClientContext,
  uuid: string,
  name: string,
  hidden: boolean,
  reportOrReports: MonitorReportPayload | MonitorReportPayload[],
  nowMs: number,
): Promise<boolean> {
  let report: MonitorReportPayload | undefined;
  let reportBody: { report: MonitorReportPayload } | { reports: MonitorReportPayload[] };
  if (Array.isArray(reportOrReports)) {
    report = reportOrReports[reportOrReports.length - 1];
    reportBody = { reports: reportOrReports };
  } else {
    report = reportOrReports;
    reportBody = { report };
  }
  if (!report) return false;
  try {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    const response = await stub.fetch(new Request('https://do/client-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid,
        name,
        hidden,
        source_ip: requestClientIp(c),
        region: requestRegion(c),
        ...reportBody,
        timestamp: nowMs,
        ttl_ms: liveReportTtlMs(report),
      }),
    }));
    const result = await readClientReportResult(response);
    return Boolean(response.ok && result?.persisted);
  } catch {
    // HTTP reports remain accepted even if the realtime fanout path is unavailable.
    return false;
  }
}

function buildSafeLiveBasicInfoClient(
  uuid: string,
  name: string,
  hidden: boolean,
  oldClient: db.Client | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    uuid,
    name: name || oldClient?.name || uuid,
    hidden,
    cpu_name: oldClient?.cpu_name || '',
    virtualization: oldClient?.virtualization || '',
    arch: oldClient?.arch || '',
    cpu_cores: oldClient?.cpu_cores || 0,
    os: oldClient?.os || '',
    kernel_version: oldClient?.kernel_version || '',
    gpu_name: oldClient?.gpu_name || '',
    region: oldClient?.region || '',
    public_remark: oldClient?.public_remark || '',
    mem_total: oldClient?.mem_total || 0,
    swap_total: oldClient?.swap_total || 0,
    disk_total: oldClient?.disk_total || 0,
    version: oldClient?.version || '',
    group: oldClient?.group || '',
    tags: oldClient?.tags || '',
    traffic_limit: oldClient?.traffic_limit || 0,
    traffic_limit_type: oldClient?.traffic_limit_type || '',
    sort_order: oldClient?.sort_order || 0,
    has_ipv4: isPublicIpAddress(oldClient?.ipv4 || ''),
    has_ipv6: isPublicIpAddress(oldClient?.ipv6 || ''),
    ...patch,
  };
  const ipv4 = typeof patch.ipv4 === 'string' ? patch.ipv4.trim() : oldClient?.ipv4 || '';
  const ipv6 = typeof patch.ipv6 === 'string' ? patch.ipv6.trim() : oldClient?.ipv6 || '';
  meta.has_ipv4 = isPublicIpAddress(ipv4);
  meta.has_ipv6 = isPublicIpAddress(ipv6);
  return meta;
}

async function syncLiveBasicInfoMetadata(c: ClientContext, client: Record<string, unknown>): Promise<void> {
  const uuid = typeof client.uuid === 'string' ? client.uuid : '';
  if (!uuid) return;
  const stub = c.env.LIVE_DATA.get(c.env.LIVE_DATA.idFromName('global'));
  await stub.fetch(new Request('https://do/client-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client,
      uuid,
      name: typeof client.name === 'string' ? client.name : uuid,
      hidden: clientBooleanField(client, 'hidden'),
    }),
  }));
}

async function syncBasicInfoFromReportBatch(
  database: db.QueryDatabase,
  c: ClientContext,
  uuid: string,
  displayName: string,
  hidden: boolean,
  oldClient: db.Client | null,
  reports: MonitorReportPayload[],
): Promise<void> {
  let basicInfoPayload: Record<string, unknown> | null = null;
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    const basicInfo = reports[index].basic_info;
    if (isJsonObjectPayload(basicInfo)) {
      basicInfoPayload = basicInfo;
      break;
    }
  }
  if (!basicInfoPayload) return;

  const oldIpv4 = oldClient?.ipv4 || '';
  const oldIpv6 = oldClient?.ipv6 || '';
  const fallbackIp = requestClientIp(c);
  const inferredIpv4 = publicIpPatch(basicInfoPayload.ipv4, fallbackIp && !isIPv6(fallbackIp) ? fallbackIp : '', oldIpv4);
  const inferredIpv6 = publicIpPatch(basicInfoPayload.ipv6, fallbackIp && isIPv6(fallbackIp) ? fallbackIp : '', oldIpv6);
  const ipChanged =
    (inferredIpv4 !== undefined && oldIpv4 !== inferredIpv4) ||
    (inferredIpv6 !== undefined && oldIpv6 !== inferredIpv6);
  const edgeRegion = requestRegion(c);
  const patch = buildChangedClientPatch(oldClient, {
    cpu_name: nonEmptyString(basicInfoPayload.cpu_name, oldClient?.cpu_name || ''),
    virtualization: nonEmptyString(basicInfoPayload.virtualization, oldClient?.virtualization || ''),
    arch: nonEmptyString(basicInfoPayload.arch, oldClient?.arch || ''),
    cpu_cores: positiveNumber(basicInfoPayload.cpu_cores, oldClient?.cpu_cores || 0),
    os: nonEmptyString(basicInfoPayload.os, oldClient?.os || ''),
    kernel_version: nonEmptyString(basicInfoPayload.kernel_version, oldClient?.kernel_version || ''),
    gpu_name: nonEmptyString(basicInfoPayload.gpu_name, oldClient?.gpu_name || ''),
    ...(inferredIpv4 !== undefined ? { ipv4: inferredIpv4 } : {}),
    ...(inferredIpv6 !== undefined ? { ipv6: inferredIpv6 } : {}),
    region: ipChanged
      ? preferredRegion(basicInfoPayload.region, edgeRegion, oldClient?.region)
      : preferredRegion(basicInfoPayload.region, oldClient?.region, edgeRegion),
    mem_total: positiveNumber(basicInfoPayload.mem_total, oldClient?.mem_total || 0),
    swap_total: nonNegativeNumber(basicInfoPayload.swap_total, oldClient?.swap_total || 0),
    disk_total: positiveNumber(basicInfoPayload.disk_total, oldClient?.disk_total || 0),
    version: nonEmptyString(basicInfoPayload.version, oldClient?.version || ''),
  });
  const ipChange = ipChangeParts(
    oldIpv4,
    oldIpv6,
    inferredIpv4 !== undefined ? inferredIpv4 : oldIpv4,
    inferredIpv6 !== undefined ? inferredIpv6 : oldIpv6,
  );
  if (Object.keys(patch).length > 0) {
    await syncLiveBasicInfoMetadata(c, buildSafeLiveBasicInfoClient(uuid, displayName, hidden, oldClient, patch)).catch(() => undefined);
    invalidatePublicMetadataCache();
    invalidateAgentClientAuthCache({ uuid, token: oldClient?.token });
    runClientBackground(c, (async () => {
      await db.updateClient(database, uuid, patch);
      await recordIpChangeIfEnabled(database, displayName, ipChange);
    })());
  } else {
    runClientBackground(c, recordIpChangeIfEnabled(database, displayName, ipChange));
  }
}

async function fallbackAgentPolicy(database: db.QueryDatabase, uuid?: string) {
  const settings = buildAdminSettings(await db.getSettingsByKeys(database, AGENT_POLICY_SETTING_KEYS));
  const reportIntervalSec = Math.min(Math.max(Number(settings.live_poll_idle_interval_sec || 120), 60), 3600);
  const viewerTtlSec = Math.min(Math.max(Number(settings.live_poll_active_max_duration_sec || 120), 60), 3600);
  const pingIntervalSec = Math.min(Math.max(Number(settings.ping_record_persist_interval_sec || 120), 60), 3600);
  const pingTasks = uuid
    ? agentPingTasksForClient(await listAgentPingTasks(database), uuid, Math.floor(pingIntervalSec))
    : [];
  const websiteProbeTasks = await agentWebsiteProbeTasksForClient(database, uuid);
  return {
    type: 'policy',
    mode: 'idle',
    sample_interval_sec: Math.floor(reportIntervalSec),
    report_interval_sec: Math.floor(reportIntervalSec),
    ping_interval_sec: Math.floor(pingIntervalSec),
    ping_policy_version: await pingPolicyVersion(pingTasks, Math.floor(pingIntervalSec)),
    ping_tasks: pingTasks,
    website_probe_tasks: websiteProbeTasks,
    report_now: false,
    viewer_count: 0,
    viewer_ttl_sec: Math.floor(viewerTtlSec),
    policy_ttl_sec: 120,
    idle_policy_ttl_sec: 120,
    timestamp: Date.now(),
  };
}

function bearerToken(c: ClientContext): string {
  const authHeader = c.req.header('Authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

function rateLimitResponse(c: ClientContext, retryAfter: number, limit: number, remaining: number): Response {
  c.header('Retry-After', String(retryAfter));
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  return c.json({ error: `请求过于频繁，请 ${retryAfter} 秒后重试` }, 429);
}

function localAgentRateLimit(c: ClientContext, key: string, max: number, windowMs: number): Response | null {
  const now = Date.now();
  for (const [bucket, value] of localAgentRateLimitBuckets) {
    if (value.resetAt <= now) localAgentRateLimitBuckets.delete(bucket);
  }

  const current = localAgentRateLimitBuckets.get(key);
  const state = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;
  state.count += 1;
  localAgentRateLimitBuckets.set(key, state);

  const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
  const remaining = Math.max(0, max - state.count);
  c.header('X-RateLimit-Limit', String(max));
  c.header('X-RateLimit-Remaining', String(remaining));
  return state.count > max ? rateLimitResponse(c, retryAfter, max, remaining) : null;
}

async function agentTokenKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const bytes = Array.from(new Uint8Array(digest));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `sha256:${encoded}`;
}

async function enforceAgentBucketRateLimit(
  c: ClientContext,
  bucket: string,
  key: string,
  max: number,
): Promise<Response | null> {
  const localKey = `${bucket}:${key}`;
  try {
    const namespace = c.env.RATE_LIMIT;
    if (!namespace) return localAgentRateLimit(c, localKey, max, AGENT_RATE_LIMIT_WINDOW_MS);
    const doId = namespace.idFromName('agent-ingress');
    const stub = namespace.get(doId);
    const response = await stub.fetch(new Request('https://do/rate-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket,
        ip: key,
        max,
        windowMs: AGENT_RATE_LIMIT_WINDOW_MS,
      }),
    }));
    if (!response.ok) throw new Error(`DO rate limit HTTP ${response.status}`);
    const result = await readRateLimitResult(response, { limit: max, remaining: 0 });
    if (!result) throw new Error('DO rate limit returned an invalid response');
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    if (result.allowed) return null;
    return rateLimitResponse(c, result.retryAfter, result.limit, result.remaining);
  } catch {
    return localAgentRateLimit(c, localKey, max, AGENT_RATE_LIMIT_WINDOW_MS);
  }
}

async function enforceAgentRateLimit(
  c: ClientContext,
  bucket: string,
  max: number,
): Promise<Response | null> {
  const tokenKey = c.get('agentTokenKey') || requestClientIp(c) || 'unknown';
  return enforceAgentBucketRateLimit(c, bucket, tokenKey, max);
}

async function agentPresentedTokenKey(c: ClientContext, token: string): Promise<string> {
  const ip = requestClientIp(c) || 'unknown';
  const tokenPart = token
    ? (isAgentTokenShape(token) ? await agentTokenKey(token) : 'malformed')
    : 'missing';
  return `${ip}:${tokenPart}`;
}

async function enforceAgentAuthAttemptLimit(c: ClientContext, token: string): Promise<Response | null> {
  const ipLimited = localAgentRateLimit(
    c,
    `agent-auth-attempt:${requestClientIp(c) || 'unknown'}`,
    AGENT_AUTH_ATTEMPT_RATE_LIMIT_MAX,
    AGENT_RATE_LIMIT_WINDOW_MS,
  );
  if (ipLimited) return ipLimited;
  return localAgentRateLimit(
    c,
    `agent-auth-presented-token:${await agentPresentedTokenKey(c, token)}`,
    AGENT_AUTH_ATTEMPT_RATE_LIMIT_MAX,
    AGENT_RATE_LIMIT_WINDOW_MS,
  );
}

async function enforceAgentAuthFailureLimit(c: ClientContext, token: string): Promise<Response | null> {
  return enforceAgentBucketRateLimit(
    c,
    'agent-auth-failure',
    await agentPresentedTokenKey(c, token),
    AGENT_AUTH_FAILURE_RATE_LIMIT_MAX,
  );
}

async function readJsonBodyWithLimit(c: ClientContext, maxBytes: number): Promise<JsonBodyResult> {
  const declaredLength = Number(c.req.header('Content-Length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { response: c.json({ error: '请求体过大' }, 413) };
  }

  const stream = c.req.raw.body;
  if (!stream) {
    return { response: c.json({ error: '请求体不能为空' }, 400) };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { response: c.json({ error: '请求体过大' }, 413) };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { response: c.json({ error: '请求格式错误' }, 400) };
  }
}

function requireJsonObjectBody(c: ClientContext, body: unknown): { body: Record<string, unknown> } | { response: Response } {
  return isJsonObjectPayload(body)
    ? { body }
    : { response: c.json({ error: '请求内容必须是 JSON 对象' }, 400) };
}

// Agent Token 认证中间件
async function clientAuth(c: ClientContext, next: Next) {
  const token = bearerToken(c).trim();

  const attemptLimited = await enforceAgentAuthAttemptLimit(c, token);
  if (attemptLimited) return attemptLimited;

  if (!token) {
    const failureLimited = await enforceAgentAuthFailureLimit(c, token);
    if (failureLimited) return failureLimited;
    return c.json({ error: '缺少认证 Token' }, 401);
  }
  if (!isAgentTokenShape(token)) {
    const failureLimited = await enforceAgentAuthFailureLimit(c, token);
    if (failureLimited) return failureLimited;
    return c.json({ error: '无效的 Token' }, 401);
  }

  const database = getDatabase(c.env);
  let authSource: AgentAuthLookupSource = 'miss';
  const client = await getAgentClientByToken(
    database,
    token,
    c.env,
    requestClientIp(c),
    (task) => runClientBackground(c, task),
    (source) => { authSource = source; },
  );
  c.header('X-CF-VPS-Monitor-Agent-Auth', authSource);
  if (!client) {
    const failureLimited = await enforceAgentAuthFailureLimit(c, token);
    if (failureLimited) return failureLimited;
    return c.json({ error: '无效的 Token' }, 401);
  }

  c.set('clientUuid', client.uuid);
  c.set('clientName', client.name);
  c.set('clientHidden', Boolean(client.hidden));
  c.set('clientRecord', client);
  c.set('agentTokenKey', await agentTokenKey(token));
  return next();
}

async function clientIdentityAuth(c: ClientContext, next: Next) {
  const token = bearerToken(c).trim();

  const attemptLimited = await enforceAgentAuthAttemptLimit(c, token);
  if (attemptLimited) return attemptLimited;

  if (!token) {
    const failureLimited = await enforceAgentAuthFailureLimit(c, token);
    if (failureLimited) return failureLimited;
    return c.json({ error: '缺少认证 Token' }, 401);
  }
  if (!isAgentTokenShape(token)) {
    const failureLimited = await enforceAgentAuthFailureLimit(c, token);
    if (failureLimited) return failureLimited;
    return c.json({ error: '无效的 Token' }, 401);
  }

  const database = getDatabase(c.env);
  let authSource: AgentAuthLookupSource = 'miss';
  const client = await getAgentClientIdentityByToken(
    database,
    token,
    c.env,
    requestClientIp(c),
    (task) => runClientBackground(c, task),
    (source) => { authSource = source; },
  );
  c.header('X-CF-VPS-Monitor-Agent-Auth', authSource);
  if (!client) {
    const failureLimited = await enforceAgentAuthFailureLimit(c, token);
    if (failureLimited) return failureLimited;
    return c.json({ error: '无效的 Token' }, 401);
  }

  c.set('clientUuid', client.uuid);
  c.set('clientName', client.name);
  c.set('clientHidden', Boolean(client.hidden));
  c.set('agentTokenKey', await agentTokenKey(token));
  return next();
}

// 旧自动注册入口：功能已移除，仅返回明确拒绝，避免旧安装脚本静默失败。
clientRoutes.post('/register', async (c) => {
  return c.json({ error: 'Agent 自动注册已移除，请在后台创建节点并使用节点 Token 安装 Agent' }, 410);
});

// 获取 Agent 动态上报策略（HTTP 模式使用）
clientRoutes.get('/policy', clientIdentityAuth, async (c) => {
  try {
    return c.json(await fallbackAgentPolicy(getDatabase(c.env), c.get('clientUuid')));
  } catch {
    try {
      return c.json(await fallbackAgentPolicy(getDatabase(c.env), c.get('clientUuid')));
    } catch {
      return c.json({
        type: 'policy',
        mode: 'idle',
        sample_interval_sec: 120,
        report_interval_sec: 120,
        ping_interval_sec: 120,
        ping_policy_version: 'fallback',
        ping_tasks: [],
        website_probe_tasks: [],
        report_now: false,
        viewer_count: 0,
        viewer_ttl_sec: 120,
        policy_ttl_sec: 120,
        idle_policy_ttl_sec: 120,
        timestamp: Date.now(),
      });
    }
  }
});

// 上传基本信息（受保护）
clientRoutes.post('/uploadBasicInfo', clientAuth, async (c) => {
  try {
    const limited = await enforceAgentRateLimit(c, 'agent-basic-info', AGENT_BASIC_INFO_RATE_LIMIT_MAX);
    if (limited) return limited;
    const parsed = await readJsonBodyWithLimit(c, AGENT_BASIC_INFO_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const objectBody = requireJsonObjectBody(c, parsed.body);
    if ('response' in objectBody) return objectBody.response;
    const body = objectBody.body;
    const uuid = c.get('clientUuid')!;
    const authClient = c.get('clientRecord') as db.Client | undefined;

    // Fetch old client info for IP change detection
    const database = getDatabase(c.env);
    const oldClient = authClient || await db.getClient(database, uuid);
    const oldIpv4 = oldClient?.ipv4 || '';
    const oldIpv6 = oldClient?.ipv6 || '';
    const fallbackIp = requestClientIp(c);
    const inferredIpv4 = publicIpPatch(body.ipv4, fallbackIp && !isIPv6(fallbackIp) ? fallbackIp : '', oldIpv4);
    const inferredIpv6 = publicIpPatch(body.ipv6, fallbackIp && isIPv6(fallbackIp) ? fallbackIp : '', oldIpv6);
    const displayName = oldClient?.name || c.get('clientName') || uuid;
    const ipChanged =
      (inferredIpv4 !== undefined && oldIpv4 !== inferredIpv4) ||
      (inferredIpv6 !== undefined && oldIpv6 !== inferredIpv6);
    const edgeRegion = requestRegion(c);

    const patch = buildChangedClientPatch(oldClient, {
      cpu_name: nonEmptyString(body.cpu_name, oldClient?.cpu_name || ''),
      virtualization: nonEmptyString(body.virtualization, oldClient?.virtualization || ''),
      arch: nonEmptyString(body.arch, oldClient?.arch || ''),
      cpu_cores: positiveNumber(body.cpu_cores, oldClient?.cpu_cores || 0),
      os: nonEmptyString(body.os, oldClient?.os || ''),
      kernel_version: nonEmptyString(body.kernel_version, oldClient?.kernel_version || ''),
      gpu_name: nonEmptyString(body.gpu_name, oldClient?.gpu_name || ''),
      ...(inferredIpv4 !== undefined ? { ipv4: inferredIpv4 } : {}),
      ...(inferredIpv6 !== undefined ? { ipv6: inferredIpv6 } : {}),
      region: ipChanged
        ? preferredRegion(body.region, edgeRegion, oldClient?.region)
        : preferredRegion(body.region, oldClient?.region, edgeRegion),
      mem_total: positiveNumber(body.mem_total, oldClient?.mem_total || 0),
      swap_total: nonNegativeNumber(body.swap_total, oldClient?.swap_total || 0),
      disk_total: positiveNumber(body.disk_total, oldClient?.disk_total || 0),
      version: nonEmptyString(body.version, oldClient?.version || ''),
    });
    const ipChange = ipChangeParts(
      oldIpv4,
      oldIpv6,
      inferredIpv4 !== undefined ? inferredIpv4 : oldIpv4,
      inferredIpv6 !== undefined ? inferredIpv6 : oldIpv6,
    );
    if (Object.keys(patch).length > 0) {
      await syncLiveBasicInfoMetadata(c, buildSafeLiveBasicInfoClient(uuid, displayName, Boolean(c.get('clientHidden')), oldClient, patch)).catch(() => undefined);
      invalidatePublicMetadataCache();
      invalidateAgentClientAuthCache({ uuid, token: oldClient?.token });
      runClientBackground(c, (async () => {
        await db.updateClient(database, uuid, patch);
        await recordIpChangeIfEnabled(database, displayName, ipChange);
      })());
    } else {
      runClientBackground(c, recordIpChangeIfEnabled(database, displayName, ipChange));
    }

    return c.json({ success: true });
  } catch {
    return c.json({ error: '上传失败' }, 500);
  }
});

// 上报监控数据（HTTP 方式，受保护）
clientRoutes.post('/report', clientAuth, async (c) => {
  try {
    const limited = await enforceAgentRateLimit(c, 'agent-report', AGENT_REPORT_RATE_LIMIT_MAX);
    if (limited) return limited;
    const parsed = await readJsonBodyWithLimit(c, AGENT_REPORT_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const objectBody = requireJsonObjectBody(c, parsed.body);
    if ('response' in objectBody) return objectBody.response;
    const body = objectBody.body;
    const uuid = c.get('clientUuid')!;
    const nowMs = Date.now();
    const rawReports = Array.isArray(body.reports)
      ? body.reports.slice(0, AGENT_REPORT_MAX_BATCH).filter(isJsonObjectPayload)
      : [body];
    if (rawReports.length === 0) {
      return c.json({ error: '上报数据不能为空' }, 400);
    }
    const reports = rawReports.map((item) => normalizeMonitorReport(item));
    const report = reports[reports.length - 1];
    const liveName = c.get('clientName') || uuid;
    const hidden = Boolean(c.get('clientHidden'));
    const authClient = c.get('clientRecord') as db.Client | undefined;
    const database = getDatabase(c.env);

    runClientBackground(c, syncClientIpsFromReport(database, c, uuid, liveName, report, authClient || null));
    await syncBasicInfoFromReportBatch(database, c, uuid, liveName, hidden, authClient || null, reports);

    const persisted = await updateLiveReport(c, uuid, liveName, hidden, reports.length > 1 ? reports : report, nowMs);
    if (report.version && clientFieldChanged(authClient?.version, report.version)) {
      runClientBackground(c, (async () => {
        await db.updateClient(database, uuid, {
          version: report.version,
        });
        invalidatePublicMetadataCache();
        invalidateAgentClientAuthCache({ uuid, token: authClient?.token });
      })());
    }

    return c.json({ success: true, persisted });
  } catch (e) {
    return c.json({ error: '上报失败' }, 500);
  }
});

// 获取 Ping 任务列表（受保护）
clientRoutes.get('/ping/tasks', clientIdentityAuth, async (c) => {
  try {
    const uuid = c.get('clientUuid')!;
    const database = getDatabase(c.env);
    const allTasks = await listAgentPingTasks(database);

    // 筛选适用于此客户端的任务
    const tasks = allTasks.filter(task => {
      if (task.all_clients) return true;
      return task.clients.includes(uuid);
    });
    const unifiedPingIntervalSec = await getUnifiedPingIntervalSec(database);
    const responseTasks = withUnifiedPingInterval(tasks, unifiedPingIntervalSec);

    if (c.req.query('format') === 'v2') {
      return c.json({
        tasks: responseTasks,
        next_poll_sec: estimateNextPingTaskPollSec(responseTasks, unifiedPingIntervalSec),
      });
    }

    return c.json(responseTasks);
  } catch {
    return c.json({ error: '获取失败' }, 500);
  }
});

// 上报 Ping 结果（受保护）
clientRoutes.post('/ping/result', clientIdentityAuth, async (c) => {
  try {
    const limited = await enforceAgentRateLimit(c, 'agent-ping-result', AGENT_PING_RESULT_RATE_LIMIT_MAX);
    if (limited) return limited;
    const parsed = await readJsonBodyWithLimit(c, AGENT_PING_RESULT_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const body = parsed.body;
    if (!isJsonObjectPayload(body) && !isJsonObjectArray(body)) {
      return c.json({ error: 'Ping 结果参数无效' }, 400);
    }
    const uuid = c.get('clientUuid')!;

    // body 应该是 { task_id, value } 或包含多个结果的数组
    const tasks = await listAgentPingTasks(getDatabase(c.env));
    const validated = validatePingResults(body, tasks, uuid);
    if (!validated.ok) {
      return c.json({ error: validated.error }, validated.status as 400 | 403);
    }
    const taskMap = new Map(tasks.map(task => [task.id, task]));

    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    const doResponse = await stub.fetch(new Request('https://do/ping-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: uuid,
        results: validated.results.map(result => ({
          task_id: result.taskId,
          value: result.value,
          interval_sec: taskMap.get(result.taskId)?.interval_sec || 60,
        })),
        timestamp: Date.now(),
      }),
    }));
    if (!doResponse.ok) {
      return c.json({ error: '上报失败' }, 500);
    }
    const accepted = await readAcceptedCount(doResponse) ?? 0;
    return c.json({ success: true, accepted });
  } catch (error) {
    try {
      await bestEffortRecordHealthEvent(
        getDatabase(c.env),
        'ping_persistence',
        'error',
        `ping persist failed: ${errorDetail(error)}`,
        { auditAction: 'ping_persistence_error' },
      );
    } catch {
      // Best effort only; preserve the original API response.
    }
    return c.json({ error: '上报失败' }, 500);
  }
});

export { clientRoutes, clientAuth, clientIdentityAuth };
