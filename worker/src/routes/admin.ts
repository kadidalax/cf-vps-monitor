/**
 * 管理员 API 路由
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { AuthConfigurationError, generateToken } from '../auth/jwt';
import { decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes, hashRecoveryCode } from '../auth/mfa';
import { generateMfaSetupToken, generateMfaToken, verifyMfaSetupToken } from '../auth/mfa-token';
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from '../auth/totp';
import { invalidateAdminSessionCache } from '../auth/admin-session';
import { hashPassword, validateAdminPasswordStrength, verifyPassword } from '../auth/password';
import { clearMfaStepUpCookie, setAdminSessionCookie, setMfaStepUpCookie } from '../auth/session';
import { SETTING_SCHEMA, buildAdminSettings, sanitizeSettingsForStorage } from '../settings/schema';
import {
  BACKUP_ENCRYPTION_ALGORITHM,
  ENCRYPTED_BACKUP_SCHEMA_ID,
  BACKUP_SCOPE,
  MAX_BACKUP_BYTES,
  decryptBackup,
  encryptBackup,
  summarizeBackup,
  validateBackup,
} from '../utils/backup';
import { buildBackupSnapshot } from '../utils/backup-snapshot';
import { getCloudflareClientIp } from '../utils/request-ip';
import { validatePingTaskInput } from '../utils/ping-task';
import { generateAgentToken, validateClientCreateInput, validateClientUpdateInput } from '../utils/client';
import { validateExpiryNotificationInput, validateLoadNotificationInput, validateOfflineNotificationInput } from '../utils/notification';
import { NOTIFICATION_DISPATCH_SETTING_KEYS, dispatchNotification } from '../utils/notification-dispatch';
import { TELEGRAM_MESSAGE_MAX_CHARS } from '../utils/telegram';
import { EMAIL_MESSAGE_MAX_CHARS } from '../utils/email';
import { WEBHOOK_MESSAGE_MAX_CHARS } from '../utils/webhook';
import { sanitizeSetupDiagnosticDetail } from '../utils/setup-diagnostics';
import { checkWebsiteMonitorHttp, validateWebsiteMonitorInput } from '../utils/website-monitor';
import { readLiveSnapshot, readRateLimitResult } from '../utils/do-response';
import { readJsonWithLimit, readRequestBytesWithLimit } from '../utils/request-body';
import { bytesToBase64 } from '../utils/theme-package';
import { APP_VERSION } from '../utils/app-version';
import {
  formatAppVersion,
  repositoryUrlFromRepositoryUrl,
  normalizeGitSha,
  shortGitSha,
  type UpdateCheckResult,
} from '../utils/update-check';
import {
  auditLoginFailure,
  clearLoginFailures,
  deleteAdminSessionEdgeCache,
  getLoginRetryAfterSeconds,
  invalidatePublicMetadataCache,
  loadLoginRateLimitStates,
  mfaRateLimitBuckets,
  purgePublicMetadataEdgeCache,
  recordLoginFailure,
} from './public';
import { invalidateAgentClientAuthCache, invalidateAgentPingTaskCache } from './client';
import { invalidateLiveViewerSettingsCache } from './websocket';
import { getDatabase, type AppDatabase } from '../db/provider';
import {
  bestEffortRecordHealthEvent,
  errorDetail,
  readHealthEvents,
  type HealthEvent,
} from '../utils/observability';
import { readScheduledDatabaseStartupHealth } from '../utils/scheduled-observability';
import {
  ESTIMATED_GPU_SNAPSHOT_BYTES,
  ESTIMATED_MONITOR_RECORD_BYTES,
  ESTIMATED_PING_SNAPSHOT_BYTES,
  buildQuotaReference,
} from '../utils/quota';

const adminRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
type AdminContext = Context<{ Bindings: Bindings; Variables: Variables }>;
const MAX_ADMIN_USERNAME_BYTES = 64;
const MIN_JWT_SECRET_BYTES = 32;
const CAPACITY_ESTIMATE_CACHE_MS = 30_000;
const CAPACITY_ROW_COUNT_CACHE_MS = 60_000;
const CAPACITY_ROW_COUNT_LIMIT = 100_000;
const ADMIN_CLIENTS_CACHE_MS = 5_000;
const ADMIN_PING_TASKS_CACHE_MS = 5_000;
const ADMIN_PING_TASKS_EDGE_CACHE_SECONDS = 15;
const ADMIN_SETTINGS_SCOPE_CACHE_MS = 10_000;
const HEALTH_CACHE_MS = 30_000;
const ALLOWED_CLIENT_IDS_CACHE_MS = 30_000;
const OFFICIAL_UPDATE_REPOSITORY = 'kadidalax/cf-vps-monitor';
const OFFICIAL_UPDATE_BRANCH = 'main';
const UPDATE_CHECK_CACHE_MS = 10 * 60 * 1000;
const updateCheckCache = new Map<string, { expiresAt: number; value: UpdateCheckResult }>();
const LIVE_POLICY_SETTING_KEYS = new Set([
  'live_poll_active_interval_sec',
  'live_poll_idle_interval_sec',
  'live_poll_active_max_duration_sec',
]);
const RECORD_PERSISTENCE_SETTING_KEYS = new Set([
  'record_enabled',
  'record_persist_interval_sec',
  'ping_record_persist_interval_sec',
  'record_high_watermark_rows',
]);
const CAPACITY_ESTIMATE_SETTING_KEYS = [
  'record_enabled',
  'record_preserve_time',
  'ping_record_preserve_time',
  'live_poll_active_interval_sec',
  'live_poll_idle_interval_sec',
  'record_persist_interval_sec',
  'ping_record_persist_interval_sec',
  'record_high_watermark_rows',
  'audit_log_preserve_time',
  'capacity_daily_view_minutes',
];
const CAPACITY_ESTIMATE_SETTING_KEY_SET = new Set(CAPACITY_ESTIMATE_SETTING_KEYS);
const SETTINGS_SCOPE_KEYS = {
  site: [
    'site_title',
    'site_subtitle',
    'site_description',
    'language',
    'script_domain',
    'site_logo_url',
  ],
  general: [
    'record_enabled',
    'record_preserve_time',
    'ping_record_preserve_time',
    'live_poll_active_interval_sec',
    'live_poll_idle_interval_sec',
    'live_poll_active_max_duration_sec',
    'record_persist_interval_sec',
    'ping_record_persist_interval_sec',
    'record_high_watermark_rows',
    'capacity_daily_view_minutes',
  ],
  notification: [
    'notification_method',
    'telegram_bot_token',
    'telegram_chat_id',
    'email_smtp_host',
    'email_smtp_port',
    'email_smtp_security',
    'email_smtp_username',
    'email_smtp_password',
    'email_smtp_from_address',
    'email_smtp_from_name',
    'email_smtp_recipients',
    'email_smtp_auth_method',
    'webhook_url',
    'webhook_format',
    'webhook_secret',
    'webhook_method',
    'webhook_content_type',
    'webhook_headers_json',
    'webhook_body_template',
    'webhook_username',
    'webhook_password',
    'webhook_retry_count',
    'enable_ip_change_notification',
    'offline_notify_never_reported',
  ],
  update: [
    'update_repository_url',
  ],
} as const satisfies Record<string, readonly (keyof typeof SETTING_SCHEMA)[]>;
const MAINTENANCE_CLEANUP_SETTING_KEYS = [
  'record_preserve_time',
  'ping_record_preserve_time',
  'audit_log_preserve_time',
];
const EMPTY_AGENT_PING_TASK_POLL_SEC = 600;
const DEFAULT_UNIFIED_PING_INTERVAL_SEC = 120;
const MIN_UNIFIED_PING_INTERVAL_SEC = 60;
const MAX_UNIFIED_PING_INTERVAL_SEC = 3600;
const AGENT_BASIC_INFO_REPORTS_PER_DAY = 48;
const CAPACITY_COUNT_FAR_CHECK_SEC = 6 * 60 * 60;
const CAPACITY_COUNT_NEAR_CHECK_SEC = 10 * 60;
const CAPACITY_COUNT_CRITICAL_CHECK_SEC = 60;
const AGENT_TOKEN_ROTATION_WARNING_MS = 180 * 24 * 60 * 60 * 1000;
const AGENT_TOKEN_UNUSED_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_TOKEN_STALE_USE_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ADMIN_JSON_BYTES = 256 * 1024;
const MAX_SITE_LOGO_BYTES = 1024 * 1024;

type LiveClientMeta = Partial<Omit<db.Client, 'token' | 'token_hash'>> & Pick<db.Client, 'uuid'>;
type AdminClientsSnapshot = {
  clients: Array<Omit<db.Client, 'token' | 'token_hash'>>;
  removed: string[];
};
type HealthCheckBody = {
  ok: boolean;
  database_provider: AppDatabase['provider'];
  checked_at: string;
  cache: 'hit' | 'miss' | 'refresh';
  deep: boolean;
  components: Record<string, HealthEvent | null>;
};
type HealthCheckCacheEntry = {
  value: HealthCheckBody;
  status: 200 | 503;
  expiresAt: number;
};
type JsonObjectBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };
type JsonObjectOrArrayBodyResult =
  | { ok: true; body: Record<string, unknown> | Record<string, unknown>[] }
  | { ok: false; response: Response };
type AdminJsonBodyMessages = {
  invalidJson: string;
  invalidShape: string;
};

type TimingMetric = { name: string; dur: number };

let allowedClientIdsCache: { value: Set<string>; expiresAt: number } | null = null;
let adminClientsCache: { value: db.Client[]; expiresAt: number } | null = null;
let adminPingTasksCache: { value: db.PingTask[]; expiresAt: number } | null = null;
const adminSettingsScopeCache = new Map<string, { value: Record<string, string>; expiresAt: number }>();
let healthCheckCache: HealthCheckCacheEntry | null = null;

async function timed<T>(metrics: TimingMetric[], name: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    metrics.push({ name, dur: performance.now() - started });
  }
}

function setServerTiming(c: AdminContext, metrics: TimingMetric[]): void {
  if (metrics.length === 0) return;
  c.header('Server-Timing', metrics.map(metric => `${metric.name};dur=${metric.dur.toFixed(1)}`).join(', '));
}

function runAdminBackground(c: AdminContext, task: Promise<unknown>): void {
  const guarded = task.catch((error) => {
    console.warn('[admin] background task failed:', sanitizeSetupDiagnosticDetail(error));
  });
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(guarded);
  else void guarded;
}

function isJsonObjectBody(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUploadedFile(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer>; type?: string } {
  return !!value && typeof value === 'object' && 'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}

function webhookUrlHost(value: string): string {
  try {
    return value ? new URL(value).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function detectSiteLogoType(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return null;
}

function isJsonObjectArrayBody(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isJsonObjectBody);
}

async function readAdminJsonBody<T>(
  c: AdminContext,
  messages: AdminJsonBodyMessages,
  acceptsBody: (body: unknown) => body is T,
  maxBytes = MAX_ADMIN_JSON_BYTES,
): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  const parsed = await readJsonWithLimit(c.req.raw, maxBytes);
  if (!parsed.ok && parsed.reason === 'too_large') {
    return { ok: false, response: c.json({ error: `请求内容不能超过 ${maxBytes} 字节` }, 413) };
  }
  if (!parsed.ok) {
    return { ok: false, response: c.json({ error: messages.invalidJson }, 400) };
  }
  const body = parsed.body;
  if (!acceptsBody(body)) {
    return { ok: false, response: c.json({ error: messages.invalidShape }, 400) };
  }
  return { ok: true, body };
}

async function readAdminJsonObject(c: AdminContext): Promise<JsonObjectBodyResult> {
  const result = await readAdminJsonBody(
    c,
    { invalidJson: '请求 JSON 格式错误', invalidShape: '请求内容必须是 JSON 对象' },
    isJsonObjectBody,
  );
  return result.ok ? { ok: true, body: result.body } : result;
}

async function readAdminJsonObjectOrArray(c: AdminContext): Promise<JsonObjectOrArrayBodyResult> {
  const result = await readAdminJsonBody(
    c,
    { invalidJson: '请求 JSON 格式错误', invalidShape: '请求内容必须是 JSON 对象或对象数组' },
    (body): body is Record<string, unknown> | Record<string, unknown>[] =>
      isJsonObjectBody(body) || isJsonObjectArrayBody(body),
  );
  return result.ok ? { ok: true, body: result.body } : result;
}

async function readAdminBackupJsonObject(c: AdminContext): Promise<JsonObjectBodyResult> {
  const result = await readAdminJsonBody(
    c,
    { invalidJson: '备份 JSON 格式错误', invalidShape: '备份内容无效' },
    isJsonObjectBody,
    MAX_BACKUP_BYTES,
  );
  return result.ok ? { ok: true, body: result.body } : result;
}

export function invalidateAllowedClientIdsCache(): void {
  allowedClientIdsCache = null;
}

function adminClientsEdgeCacheRequest(): Request {
  return new Request('https://cf-monitor.internal/cache/admin/clients/v2', { method: 'GET' });
}

function adminPingTasksEdgeCacheRequest(): Request {
  return new Request('https://cf-monitor.internal/cache/admin/ping/v2', { method: 'GET' });
}

function invalidateAdminClientsCache(): void {
  adminClientsCache = null;
}

function invalidateAdminPingTasksCache(): void {
  adminPingTasksCache = null;
}

function invalidateAdminSettingsCache(): void {
  adminSettingsScopeCache.clear();
}

function invalidateAdminPublicMetadata(c: AdminContext): Promise<unknown[]> {
  invalidatePublicMetadataCache();
  return purgePublicMetadataEdgeCache(c);
}

function purgeAdminClientsEdgeCache(c: AdminContext): Promise<boolean> {
  if (typeof caches === 'undefined') return Promise.resolve(false);
  const task = caches.default.delete(adminClientsEdgeCacheRequest()).catch(() => false);
  if (c?.executionCtx?.waitUntil) c.executionCtx.waitUntil(task);
  return task;
}

function purgeAdminPingTasksEdgeCache(c: AdminContext): void {
  if (typeof caches === 'undefined') return;
  const task = caches.default.delete(adminPingTasksEdgeCacheRequest()).catch(() => false);
  if (c?.executionCtx?.waitUntil) c.executionCtx.waitUntil(task);
  else void task;
}

async function getAdminPingTasksEdgeCache(): Promise<Response | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cached = await caches.default.match(adminPingTasksEdgeCacheRequest());
    if (!cached) return null;
    const headers = new Headers(cached.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-CF-VPS-Monitor-Admin-Ping-Cache', 'edge-hit');
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  } catch {
    return null;
  }
}

function putAdminPingTasksEdgeCache(c: AdminContext, tasks: db.PingTask[]): void {
  if (typeof caches === 'undefined') return;
  const response = new Response(JSON.stringify(tasks), {
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': `public, max-age=${ADMIN_PING_TASKS_EDGE_CACHE_SECONDS}`,
    },
  });
  const task = caches.default.put(adminPingTasksEdgeCacheRequest(), response).catch(() => undefined);
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(task);
  else void task;
}

function hideAdminClientToken(client: db.Client): Omit<db.Client, 'token' | 'token_hash'> {
  const { token: _token, token_hash: _tokenHash, ...safeClient } = client;
  return safeClient;
}

function liveDataStub(c: AdminContext) {
  return c.env.LIVE_DATA.get(c.env.LIVE_DATA.idFromName('global'));
}

async function readAdminClientsSnapshot(c: AdminContext): Promise<AdminClientsSnapshot | null> {
  const response = await liveDataStub(c).fetch(new Request('https://do/admin-clients-snapshot'));
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const clients = body && typeof body === 'object' && Array.isArray((body as { clients?: unknown }).clients)
    ? (body as { clients: unknown[] }).clients
    : null;
  const removed = body && typeof body === 'object' && Array.isArray((body as { removed?: unknown }).removed)
    ? (body as { removed: unknown[] }).removed.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.trim() !== '')
    : [];
  return clients && clients.every(item => item && typeof item === 'object')
    ? { clients: clients as Array<Omit<db.Client, 'token' | 'token_hash'>>, removed }
    : null;
}

async function writeAdminClientsSnapshot(c: AdminContext, clients: Array<Omit<db.Client, 'token' | 'token_hash'>>): Promise<void> {
  await liveDataStub(c).fetch(new Request('https://do/admin-clients-snapshot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clients }),
  }));
}

function applyAdminClientsSnapshot(
  clients: Array<Omit<db.Client, 'token' | 'token_hash'>>,
  snapshot: AdminClientsSnapshot | null,
): Array<Omit<db.Client, 'token' | 'token_hash'>> {
  if (!snapshot) return clients;
  const removed = new Set(snapshot.removed);
  const byUuid = new Map(clients.map(client => [client.uuid, client]));
  for (const client of snapshot.clients) {
    if (!removed.has(client.uuid)) byUuid.set(client.uuid, { ...byUuid.get(client.uuid), ...client });
  }
  return [...byUuid.values()];
}

async function listAdminClientsCached(database: db.QueryDatabase, force = false): Promise<db.Client[]> {
  const now = Date.now();
  if (!force && adminClientsCache && adminClientsCache.expiresAt > now) {
    return adminClientsCache.value;
  }

  const clients = await db.listClients(database, force);
  adminClientsCache = {
    value: clients,
    expiresAt: Date.now() + ADMIN_CLIENTS_CACHE_MS,
  };
  return clients;
}

async function listAdminPingTasksCached(database: db.QueryDatabase, force = false): Promise<db.PingTask[]> {
  const now = Date.now();
  if (!force && adminPingTasksCache && adminPingTasksCache.expiresAt > now) {
    return adminPingTasksCache.value;
  }
  const tasks = await db.listPingTasks(database, force);
  adminPingTasksCache = {
    value: tasks,
    expiresAt: Date.now() + ADMIN_PING_TASKS_CACHE_MS,
  };
  return tasks;
}

async function syncLiveClientMeta(c: AdminContext, client: LiveClientMeta): Promise<void> {
  const stub = liveDataStub(c);
  await stub.fetch(new Request('https://do/client-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client: { ...client, hidden: Boolean(client.hidden) },
      uuid: client.uuid,
      name: client.name,
      hidden: Boolean(client.hidden),
    }),
  }));
}

async function syncAgentAuthClient(c: AdminContext, client: db.Client): Promise<void> {
  if (!client.token_hash) return;
  const { token: _token, ...safeClient } = client;
  const stub = liveDataStub(c);
  await stub.fetch(new Request('https://do/agent-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: { ...safeClient, token: '' } }),
  }));
}

async function removeLiveClient(c: AdminContext, uuid: string): Promise<void> {
  const stub = liveDataStub(c);
  await stub.fetch(new Request('https://do/client-remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid }),
  }));
}

async function disconnectLiveClient(c: AdminContext, uuid: string): Promise<void> {
  const stub = liveDataStub(c);
  await stub.fetch(new Request('https://do/client-remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid, keepMetadata: true }),
  }));
}

export async function getClientCreateConflict(database: db.QueryDatabase, uuid: string, token: string): Promise<'uuid' | 'token' | null> {
  return db.getClientCreateConflict(database, uuid, token);
}

function isClientUniqueConflict(error: unknown): boolean {
  return /23505|duplicate key|unique constraint|clients_pkey|clients_token/i.test(String(error));
}

export async function generateUniqueClientToken(
  database: db.QueryDatabase,
  randomToken: () => string = generateAgentToken,
): Promise<string | null> {
  let token = randomToken();
  for (let attempt = 0; attempt < 5 && await db.clientTokenExists(database, token); attempt += 1) {
    token = randomToken();
  }
  if (await db.clientTokenExists(database, token)) return null;
  return token;
}

async function getInstallToken(database: db.QueryDatabase, uuid: string): Promise<{ token: string } | null> {
  const client = await db.getClientTokenMeta(database, uuid);
  if (!client) return null;
  return { token: client.token || '' };
}

async function refreshLivePingTasks(c: AdminContext): Promise<void> {
  try {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    await stub.fetch(new Request('https://do/ping-tasks-refresh', { method: 'POST' }));
  } catch {
    // The DO cache is short-lived; admin writes should not fail if refresh signalling is unavailable.
  }
}

async function refreshLiveAgentPolicy(c: AdminContext): Promise<void> {
  try {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    await stub.fetch(new Request('https://do/policy-refresh', { method: 'POST' }));
  } catch {
    // Agent policy caches are short-lived; admin writes should not fail if refresh signalling is unavailable.
  }
}

async function broadcastLiveMetadataChanged(c: AdminContext, detail: Record<string, unknown>): Promise<void> {
  try {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    await stub.fetch(new Request('https://do/metadata-refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(detail),
    }));
  } catch {
    // Cache invalidation is enough for correctness; live broadcast only improves freshness.
  }
}

type WebsiteMonitorMetadataDetail = true | {
  upsert?: unknown[];
  remove?: number[];
  reorder?: number[];
};
const WEBSITE_MONITOR_REQUIRED_EDIT_FIELDS = [
  'name',
  'url',
  'method',
  'expected_status_min',
  'expected_status_max',
  'interval_sec',
  'timeout_sec',
  'grace_period_sec',
  'enabled',
  'hidden',
];

function invalidateWebsiteMonitorPublicState(c: AdminContext, websites: WebsiteMonitorMetadataDetail = true): void {
  invalidateAdminPublicMetadata(c);
  runAdminBackground(c, broadcastLiveMetadataChanged(c, { websites }));
  runAdminBackground(c, refreshLiveAgentPolicy(c));
}

type PingTaskAuditSource = Pick<db.PingTask, 'name' | 'type' | 'target' | 'all_clients' | 'clients' | 'interval_sec'>;

function pingTaskAuditSnapshot(task: PingTaskAuditSource) {
  const scope = task.all_clients ? 'all_clients' : `clients=${Array.isArray(task.clients) ? task.clients.length : 0}`;
  return {
    name: task.name,
    type: task.type,
    target: task.target,
    interval_sec: task.interval_sec,
    scope,
  };
}

function pingTaskAuditDetail(event: string, task: PingTaskAuditSource, previous?: PingTaskAuditSource): string {
  const current = pingTaskAuditSnapshot(task);
  return JSON.stringify({
    event,
    summary: `${event}: ${current.name}; type=${current.type}; target=${current.target}; interval=${current.interval_sec}s; scope=${current.scope}`,
    task: current,
    ...(previous ? { previous: pingTaskAuditSnapshot(previous) } : {}),
  });
}

function isQueryFlagEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function isBodyFlagEnabled(body: unknown, key: string): boolean {
  return !!body && typeof body === 'object' && (body as Record<string, unknown>)[key] === true;
}

function getRequestIp(c: AdminContext): string {
  return getCloudflareClientIp(c);
}

function getRestoreConfirmationState(c: AdminContext, body: unknown): {
  confirmed: boolean;
  confirmRestore: boolean;
  acknowledgeOverwrite: boolean;
} {
  const confirmRestore =
    isQueryFlagEnabled(c.req.query('confirm_restore')) ||
    isBodyFlagEnabled(body, 'confirm_restore');
  const acknowledgeOverwrite =
    isQueryFlagEnabled(c.req.query('acknowledge_overwrite')) ||
    isBodyFlagEnabled(body, 'acknowledge_overwrite');

  return {
    confirmed: confirmRestore && acknowledgeOverwrite,
    confirmRestore,
    acknowledgeOverwrite,
  };
}

function jsonSizeBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isEncryptedBackupEnvelope(value: unknown): boolean {
  return !!value &&
    typeof value === 'object' &&
    ((value as Record<string, unknown>).schema === ENCRYPTED_BACKUP_SCHEMA_ID ||
      (value as Record<string, unknown>).encrypted === true);
}

export async function getAllowedClientIds(database: db.QueryDatabase): Promise<Set<string>> {
  const now = Date.now();
  if (allowedClientIdsCache && allowedClientIdsCache.expiresAt > now) {
    return new Set(allowedClientIdsCache.value);
  }

  const ids = await db.listClientIds(database);
  const value = new Set(ids);
  allowedClientIdsCache = {
    value,
    expiresAt: now + ALLOWED_CLIENT_IDS_CACHE_MS,
  };
  return new Set(value);
}

function readAdminBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

function hasNonEmptyStringList(value: unknown): boolean {
  let source = value;
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value);
    } catch (error) {
      if (error instanceof AuthConfigurationError) throw error;
      return false;
    }
  }
  return Array.isArray(source) && source.some(item => typeof item === 'string' && item.trim() !== '');
}

function pingTaskReferencesSpecificClients(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const body = input as Record<string, unknown>;
  return !readAdminBoolean(body.all_clients) && hasNonEmptyStringList(body.clients);
}

function loadNotificationReferencesSpecificClients(input: unknown): boolean {
  return !!input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    hasNonEmptyStringList((input as Record<string, unknown>).clients);
}

export async function getAllowedClientIdsForPingTask(
  database: db.QueryDatabase,
  input: unknown,
): Promise<Set<string> | undefined> {
  return pingTaskReferencesSpecificClients(input)
    ? getAllowedClientIds(database)
    : undefined;
}

export async function getAllowedClientIdsForLoadNotification(
  database: db.QueryDatabase,
  input: unknown,
): Promise<Set<string>> {
  return loadNotificationReferencesSpecificClients(input)
    ? getAllowedClientIds(database)
    : new Set();
}

function healthEvent(
  component: string,
  status: HealthEvent['status'],
  detail: string,
  checkedAt: string,
): HealthEvent {
  return {
    component,
    status,
    updated_at: checkedAt,
    ...(status === 'ok' ? { last_success_at: checkedAt } : { last_failure_at: checkedAt }),
    detail,
  };
}

function parseTimeMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function runAgentTokenHygieneProbe(database: AppDatabase, checkedAt: string): Promise<HealthEvent> {
  const now = Date.parse(checkedAt);
  const clients = await db.listClients(database);
  let oldRotations = 0;
  let neverUsed = 0;
  let staleUse = 0;
  let missingSourceIp = 0;
  const sourceIpClientCounts = new Map<string, number>();

  for (const client of clients) {
    const createdAt = parseTimeMs(client.created_at);
    const rotatedAt = parseTimeMs(client.token_rotated_at) || createdAt;
    const lastUsedAt = parseTimeMs(client.token_last_used_at);
    const sourceIp = (client.token_last_used_ip || '').trim();

    if (rotatedAt > 0 && now - rotatedAt > AGENT_TOKEN_ROTATION_WARNING_MS) {
      oldRotations += 1;
    }
    if (!lastUsedAt && createdAt > 0 && now - createdAt > AGENT_TOKEN_UNUSED_WARNING_MS) {
      neverUsed += 1;
    }
    if (lastUsedAt > 0 && now - lastUsedAt > AGENT_TOKEN_STALE_USE_WARNING_MS) {
      staleUse += 1;
    }
    if (lastUsedAt > 0) {
      if (!sourceIp) {
        missingSourceIp += 1;
      } else {
        sourceIpClientCounts.set(sourceIp, (sourceIpClientCounts.get(sourceIp) || 0) + 1);
      }
    }
  }

  let sharedSourceIpGroups = 0;
  let sharedSourceIpClients = 0;
  for (const count of sourceIpClientCounts.values()) {
    if (count <= 1) continue;
    sharedSourceIpGroups += 1;
    sharedSourceIpClients += count;
  }

  if (oldRotations || neverUsed || staleUse || missingSourceIp || sharedSourceIpGroups) {
    return healthEvent(
      'agent_token_hygiene_probe',
      'warning',
      `Agent token hygiene warnings: old_rotations=${oldRotations}, never_used=${neverUsed}, stale_use=${staleUse}, missing_source_ip=${missingSourceIp}, shared_source_ip_groups=${sharedSourceIpGroups}, shared_source_ip_clients=${sharedSourceIpClients}`,
      checkedAt,
    );
  }
  return healthEvent('agent_token_hygiene_probe', 'ok', `Checked ${clients.length} agent tokens`, checkedAt);
}

async function runDoProbe(c: AdminContext, checkedAt: string): Promise<HealthEvent> {
  try {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('durable object fetch timed out'), 3_000);
    const response = await (async () => {
      try {
        return await stub.fetch(new Request('https://do/live', {
          method: 'GET',
          signal: controller.signal,
        }));
      } finally {
        clearTimeout(timeoutId);
      }
    })();
    if (!response.ok) {
      return healthEvent('do_binding_probe', 'error', `LIVE_DATA probe returned HTTP ${response.status}`, checkedAt);
    }
    const snapshot = await readLiveSnapshot(response);
    if (!snapshot) {
      return healthEvent('do_binding_probe', 'error', 'LIVE_DATA probe returned an invalid live snapshot', checkedAt);
    }
    return healthEvent('do_binding_probe', 'ok', 'LIVE_DATA binding responded with a live snapshot', checkedAt);
  } catch (error) {
    return healthEvent('do_binding_probe', 'error', `LIVE_DATA probe failed: ${errorDetail(error)}`, checkedAt);
  }
}

async function runRateLimitProbe(c: AdminContext, checkedAt: string): Promise<HealthEvent> {
  const namespace = c.env.RATE_LIMIT;
  if (!namespace) {
    return healthEvent('rate_limit_probe', 'error', 'RATE_LIMIT binding is missing; falling back to per-isolate limits', checkedAt);
  }
  try {
    const doId = namespace.idFromName('admin-health');
    const stub = namespace.get(doId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('rate limit durable object fetch timed out'), 3_000);
    const response = await (async () => {
      try {
        return await stub.fetch(new Request('https://do/rate-limit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            bucket: 'admin-health',
            ip: 'probe',
            max: 1000,
            windowMs: 60_000,
          }),
        }));
      } finally {
        clearTimeout(timeoutId);
      }
    })();
    if (!response.ok) {
      return healthEvent('rate_limit_probe', 'error', `RATE_LIMIT probe returned HTTP ${response.status}`, checkedAt);
    }
    const result = await readRateLimitResult(response, { limit: 1000, remaining: 1000 });
    return result
      ? healthEvent('rate_limit_probe', 'ok', 'RATE_LIMIT binding responded', checkedAt)
      : healthEvent('rate_limit_probe', 'error', 'RATE_LIMIT probe returned an invalid response', checkedAt);
  } catch (error) {
    return healthEvent('rate_limit_probe', 'error', `RATE_LIMIT probe failed: ${errorDetail(error)}`, checkedAt);
  }
}

function runSecretProbe(env: Bindings, checkedAt: string): HealthEvent {
  const missing: string[] = [];
  if (new TextEncoder().encode(env.JWT_SECRET?.trim() || '').length < MIN_JWT_SECRET_BYTES) {
    missing.push('JWT_SECRET must be at least 32 bytes');
  }
  if (!(env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim())) {
    missing.push('SUPABASE_SECRET_KEY is required');
  }
  if (missing.length > 0) {
    return healthEvent('secret_probe', 'error', missing.join('; '), checkedAt);
  }
  return healthEvent('secret_probe', 'ok', 'Required runtime secrets are configured', checkedAt);
}

async function buildHealthCheck(c: AdminContext, deep: boolean, cacheState: HealthCheckBody['cache']): Promise<{ body: HealthCheckBody; status: 200 | 503 }> {
  void deep;
  const checkedAt = new Date().toISOString();
  const database = getDatabase(c.env);
  const components: Record<string, HealthEvent | null> = {};
  const databaseProbe = healthEvent('database_connection_probe', 'ok', 'Supabase HTTP API/RPC configured', checkedAt);
  if (databaseProbe.status !== 'error') {
    Object.assign(components, await readHealthEvents(database));
  }
  components.database_connection_probe = databaseProbe;

  if (databaseProbe.status !== 'error') {
    components.database_role_probe = healthEvent('database_role_probe', 'disabled', 'Direct database role probe is not used in Supabase HTTP API mode', checkedAt);
    components.agent_token_hygiene_probe = await runAgentTokenHygieneProbe(database, checkedAt);
    components.schema_probe = healthEvent('schema_probe', 'disabled', 'Schema probe is handled by Supabase migrations, not Worker runtime bootstrap', checkedAt);
  }

  components.cron_startup_probe = readScheduledDatabaseStartupHealth(checkedAt);
  components.do_binding_probe = await runDoProbe(c, checkedAt);
  components.rate_limit_probe = await runRateLimitProbe(c, checkedAt);
  components.secret_probe = runSecretProbe(c.env, checkedAt);
  const ok = databaseProbe.status !== 'error' &&
    Object.values(components).every(event => !event || event.status !== 'error');

  return {
    body: {
      ok,
      database_provider: database.provider,
      checked_at: checkedAt,
      cache: cacheState,
      deep,
      components,
    },
    status: ok ? 200 : 503,
  };
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseUniqueStringList(value: unknown, maxItems = 100): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: '客户端列表不能为空' };
  }
  const values = [...new Set(
    value
      .map((item: unknown) => String(item || '').trim())
      .filter(Boolean),
  )];
  if (values.length === 0) {
    return { ok: false, error: '客户端列表不能为空' };
  }
  if (values.length > maxItems) {
    return { ok: false, error: `一次最多处理 ${maxItems} 个客户端` };
  }
  return { ok: true, values };
}

function estimatePingSnapshotRowsPerDay(
  clientCount: number,
  pingTasks: db.PingTaskEstimateRow[],
  pingIntervalSec: number = DEFAULT_UNIFIED_PING_INTERVAL_SEC,
): number {
  let hasAllClientTask = false;
  const targetedClients = new Set<string>();
  const boundedPingIntervalSec = Math.max(1, Math.floor(pingIntervalSec));

  for (const task of pingTasks) {
    if (task.all_clients) {
      hasAllClientTask = true;
      continue;
    }
    for (const uuid of parseJsonArray(task.clients).filter((item): item is string => typeof item === 'string')) {
      targetedClients.add(uuid);
    }
  }

  const coveredClientCount = hasAllClientTask ? clientCount : targetedClients.size;
  const rowsPerClient = pingTasks.length > 0 ? Math.ceil(86400 / boundedPingIntervalSec) : 0;
  const rowsPerDay = coveredClientCount * rowsPerClient;

  return rowsPerDay;
}

function estimateAgentPingTaskPullsPerDay(
  clientCount: number,
  pingTasks: db.PingTaskEstimateRow[],
  pingIntervalSec: number,
): number {
  if (pingTasks.length === 0) {
    return Math.ceil(clientCount * 86400 / EMPTY_AGENT_PING_TASK_POLL_SEC);
  }

  const pollIntervalSec = Math.max(1, Math.floor(pingIntervalSec));
  return Math.ceil(clientCount * 86400 / pollIntervalSec);
}

function estimateCapacityCountCheckIntervalSec(estimatedRows: number, highWatermarkRows: number): number {
  if (highWatermarkRows <= 0) return CAPACITY_COUNT_NEAR_CHECK_SEC;
  const ratio = estimatedRows / highWatermarkRows;
  if (ratio >= 0.95) return CAPACITY_COUNT_CRITICAL_CHECK_SEC;
  if (ratio >= 0.8) return CAPACITY_COUNT_NEAR_CHECK_SEC;
  return CAPACITY_COUNT_FAR_CHECK_SEC;
}

type CapacityRowCountSnapshot = {
  bounded_row_counts: Awaited<ReturnType<typeof db.getBoundedStorageRowCounts>> | null;
  expired_row_counts: Awaited<ReturnType<typeof db.getExpiredRowCounts>> | null;
  checked_at: string;
  cache_key: string;
};

let capacityRowCountCache: { value: CapacityRowCountSnapshot; expiresAt: number } | null = null;
let capacityEstimateCache: { value: Record<string, unknown>; expiresAt: number } | null = null;

function invalidateCapacityEstimateCache(): void {
  capacityRowCountCache = null;
  capacityEstimateCache = null;
}

async function getCapacityRowCounts(
  database: db.QueryDatabase,
  settings: Record<string, string>,
  forceRefresh = false,
): Promise<CapacityRowCountSnapshot> {
  const recordHours = Math.min(72, parsePositiveNumber(settings.record_preserve_time, 72));
  const pingHours = Math.min(72, parsePositiveNumber(settings.ping_record_preserve_time, recordHours));
  const auditHours = Math.max(24, parsePositiveNumber(settings.audit_log_preserve_time, 2160));
  const cacheKey = `${recordHours}:${pingHours}:${auditHours}`;
  const nowMs = Date.now();
  if (
    !forceRefresh &&
    capacityRowCountCache &&
    capacityRowCountCache.expiresAt > nowMs &&
    capacityRowCountCache.value.cache_key === cacheKey
  ) {
    return capacityRowCountCache.value;
  }

  let boundedRowCounts: Awaited<ReturnType<typeof db.getBoundedStorageRowCounts>> | null = null;
  let expiredRowCounts: Awaited<ReturnType<typeof db.getExpiredRowCounts>> | null = null;
  try {
    boundedRowCounts = await db.getBoundedStorageRowCounts(database, CAPACITY_ROW_COUNT_LIMIT);
  } catch {
    boundedRowCounts = null;
  }
  try {
    expiredRowCounts = await db.getExpiredRowCounts(database, {
      records: new Date(nowMs - recordHours * 60 * 60 * 1000).toISOString(),
      ping_records: new Date(nowMs - pingHours * 60 * 60 * 1000).toISOString(),
      audit_logs: new Date(nowMs - auditHours * 60 * 60 * 1000).toISOString(),
    });
  } catch {
    expiredRowCounts = null;
  }

  const value = {
    bounded_row_counts: boundedRowCounts,
    expired_row_counts: expiredRowCounts,
    checked_at: new Date(nowMs).toISOString(),
    cache_key: cacheKey,
  };
  capacityRowCountCache = {
    value,
    expiresAt: nowMs + CAPACITY_ROW_COUNT_CACHE_MS,
  };
  return value;
}

export async function buildCapacityEstimate(database: db.QueryDatabase, options: { forceCounts?: boolean } = {}) {
  const nowMs = Date.now();
  if (!options.forceCounts && capacityEstimateCache && capacityEstimateCache.expiresAt > nowMs) {
    return {
      ...capacityEstimateCache.value,
      capacity_estimate_cache: 'hit',
      capacity_estimate_cache_seconds: CAPACITY_ESTIMATE_CACHE_MS / 1000,
    };
  }

  const [clientCapacityCounts, rawSettings, pingTasks] = await Promise.all([
    db.countClientCapacityTargets(database),
    db.getSettingsByKeys(database, CAPACITY_ESTIMATE_SETTING_KEYS),
    db.listPingTaskEstimateRows(database),
  ]);
  const clientCount = clientCapacityCounts.clients;
  const gpuClientCount = clientCapacityCounts.gpu_clients;
  const settings = buildAdminSettings(rawSettings);
  const recordEnabled = settings.record_enabled !== 'false';
  const recordPreserveHours = Math.min(72, parsePositiveNumber(settings.record_preserve_time, 72));
  const pingPreserveHours = Math.min(72, parsePositiveNumber(settings.ping_record_preserve_time, recordPreserveHours));
  const sampleIntervalSec = Math.max(3, parsePositiveNumber(settings.live_poll_active_interval_sec, 3));
  const idleIntervalSec = Math.max(60, parsePositiveNumber(settings.live_poll_idle_interval_sec, 120));
  const persistIntervalSec = Math.max(3, parsePositiveNumber(settings.record_persist_interval_sec, 120));
  const unifiedPingIntervalSec = Math.min(
    MAX_UNIFIED_PING_INTERVAL_SEC,
    Math.max(MIN_UNIFIED_PING_INTERVAL_SEC, parsePositiveNumber(settings.ping_record_persist_interval_sec, DEFAULT_UNIFIED_PING_INTERVAL_SEC)),
  );
  const highWatermarkRows = Math.min(10_000_000, Math.max(1_000, parsePositiveNumber(settings.record_high_watermark_rows, 450_000)));
  const auditPreserveHours = Math.max(24, parsePositiveNumber(settings.audit_log_preserve_time, 2160));
  const effectiveActiveIntervalSec = Math.max(sampleIntervalSec, persistIntervalSec);
  const effectiveIdleIntervalSec = Math.max(idleIntervalSec, persistIntervalSec);
  const dailyViewMinutes = parseBoundedNumber(settings.capacity_daily_view_minutes, 60, 0, 1440);
  const activeSecondsPerDay = Math.floor(dailyViewMinutes * 60);
  const idleSecondsPerDay = Math.max(0, 86400 - activeSecondsPerDay);
  const activeMonitorRecordsPerDay = recordEnabled && activeSecondsPerDay > 0
    ? Math.ceil(clientCount * activeSecondsPerDay / effectiveActiveIntervalSec)
    : 0;
  const idleMonitorRecordsPerDay = recordEnabled && idleSecondsPerDay > 0
    ? Math.ceil(clientCount * idleSecondsPerDay / effectiveIdleIntervalSec)
    : 0;
  const monitorRecordsPerDay = activeMonitorRecordsPerDay + idleMonitorRecordsPerDay;
  const activeGpuSnapshotsPerDay = recordEnabled && activeSecondsPerDay > 0
    ? Math.ceil(gpuClientCount * activeSecondsPerDay / effectiveActiveIntervalSec)
    : 0;
  const idleGpuSnapshotsPerDay = recordEnabled && idleSecondsPerDay > 0
    ? Math.ceil(gpuClientCount * idleSecondsPerDay / effectiveIdleIntervalSec)
    : 0;
  const gpuSnapshotsPerDay = activeGpuSnapshotsPerDay + idleGpuSnapshotsPerDay;
  let legacyPingRecordsPerDay = 0;

  const pingTasksWithEstimates = pingTasks.map((task) => {
    const targetClientCount = task.all_clients
      ? clientCount
      : parseJsonArray(task.clients).filter((uuid): uuid is string => typeof uuid === 'string').length;
    const writesPerDay = recordEnabled ? Math.ceil(targetClientCount * 86400 / unifiedPingIntervalSec) : 0;
    legacyPingRecordsPerDay += writesPerDay;
    return {
      id: task.id,
      name: task.name,
      interval_sec: unifiedPingIntervalSec,
      history_interval_sec: unifiedPingIntervalSec,
      target_client_count: targetClientCount,
    };
  });
  const pingRecordsPerDay = recordEnabled
    ? estimatePingSnapshotRowsPerDay(clientCount, pingTasks, unifiedPingIntervalSec)
    : 0;
  const pingResultReportsPerDay = estimatePingSnapshotRowsPerDay(clientCount, pingTasks, unifiedPingIntervalSec);
  const agentPingTaskPullsPerDay = estimateAgentPingTaskPullsPerDay(clientCount, pingTasks, unifiedPingIntervalSec);
  const agentBasicInfoReportsPerDay = clientCount * AGENT_BASIC_INFO_REPORTS_PER_DAY;
  const agentWebsocketConnectsPerDay = clientCount;
  const estimatedWorkerRequestsPerDay =
    agentPingTaskPullsPerDay +
    pingResultReportsPerDay +
    agentBasicInfoReportsPerDay +
    agentWebsocketConnectsPerDay;
  const pingRecordsSavedPerDay = Math.max(0, legacyPingRecordsPerDay - pingRecordsPerDay);
  const totalEstimatedBusinessRowsPerDay = monitorRecordsPerDay + gpuSnapshotsPerDay + pingRecordsPerDay;
  const estimatedMonitorRecordsRetained = Math.ceil(monitorRecordsPerDay * recordPreserveHours / 24);
  const estimatedGpuSnapshotsRetained = Math.ceil(gpuSnapshotsPerDay * recordPreserveHours / 24);
  const estimatedPingRecordsRetained = Math.ceil(pingRecordsPerDay * pingPreserveHours / 24);
  const estimatedLegacyPingRecordsRetained = Math.ceil(legacyPingRecordsPerDay * pingPreserveHours / 24);
  const estimatedRowsRetained = estimatedMonitorRecordsRetained + estimatedGpuSnapshotsRetained + estimatedPingRecordsRetained;
  const estimatedStorageBytes = estimatedMonitorRecordsRetained * ESTIMATED_MONITOR_RECORD_BYTES
    + estimatedGpuSnapshotsRetained * ESTIMATED_GPU_SNAPSHOT_BYTES
    + estimatedPingRecordsRetained * ESTIMATED_PING_SNAPSHOT_BYTES;
  const capacityCountCheckIntervalSec = recordEnabled
    ? estimateCapacityCountCheckIntervalSec(estimatedRowsRetained, highWatermarkRows)
    : 0;
  const capacityCountChecksPerDay = recordEnabled && capacityCountCheckIntervalSec > 0
    ? Math.ceil(86400 / capacityCountCheckIntervalSec)
    : 0;
  const quotaReference = buildQuotaReference();
  const rowCounts = options.forceCounts
    ? await getCapacityRowCounts(database, settings, true)
    : null;

  const estimate = {
    clients: clientCount,
    gpu_clients: gpuClientCount,
    record_enabled: recordEnabled,
    record_preserve_hours: recordPreserveHours,
    ping_record_preserve_hours: pingPreserveHours,
    audit_log_preserve_hours: auditPreserveHours,
    record_persist_interval_sec: persistIntervalSec,
    ping_record_persist_interval_sec: unifiedPingIntervalSec,
    record_high_watermark_rows: highWatermarkRows,
    capacity_daily_view_minutes: dailyViewMinutes,
    active_seconds_per_day: activeSecondsPerDay,
    idle_seconds_per_day: idleSecondsPerDay,
    active_monitor_records_per_day: activeMonitorRecordsPerDay,
    idle_monitor_records_per_day: idleMonitorRecordsPerDay,
    monitor_records_per_day: monitorRecordsPerDay,
    gpu_storage_mode: 'snapshots',
    active_gpu_snapshots_per_day: activeGpuSnapshotsPerDay,
    idle_gpu_snapshots_per_day: idleGpuSnapshotsPerDay,
    gpu_snapshots_per_day: gpuSnapshotsPerDay,
    ping_storage_mode: 'snapshots',
    ping_records_per_day: pingRecordsPerDay,
    legacy_ping_records_per_day: legacyPingRecordsPerDay,
    ping_records_saved_per_day: pingRecordsSavedPerDay,
    total_estimated_business_rows_per_day: totalEstimatedBusinessRowsPerDay,
    capacity_count_checks_per_day: capacityCountChecksPerDay,
    capacity_count_check_interval_sec: capacityCountCheckIntervalSec,
    ping_result_reports_per_day: pingResultReportsPerDay,
    agent_ping_task_pulls_per_day: agentPingTaskPullsPerDay,
    agent_basic_info_reports_per_day: agentBasicInfoReportsPerDay,
    agent_websocket_connects_per_day: agentWebsocketConnectsPerDay,
    estimated_worker_requests_per_day: estimatedWorkerRequestsPerDay,
    estimated_monitor_records_retained: estimatedMonitorRecordsRetained,
    estimated_gpu_snapshots_retained: estimatedGpuSnapshotsRetained,
    estimated_ping_records_retained: estimatedPingRecordsRetained,
    estimated_legacy_ping_records_retained: estimatedLegacyPingRecordsRetained,
    estimated_ping_records_saved_retained: Math.max(0, estimatedLegacyPingRecordsRetained - estimatedPingRecordsRetained),
    estimated_rows_retained: estimatedRowsRetained,
    estimated_storage_bytes: estimatedStorageBytes,
    actual_row_counts: rowCounts?.bounded_row_counts?.counts ?? null,
    row_counts_capped: rowCounts?.bounded_row_counts?.capped ?? null,
    row_counts_limit: rowCounts?.bounded_row_counts?.limit ?? null,
    expired_row_counts: rowCounts?.expired_row_counts ?? null,
    row_counts_checked_at: rowCounts?.checked_at ?? null,
    row_counts_cache_seconds: rowCounts ? CAPACITY_ROW_COUNT_CACHE_MS / 1000 : 0,
    row_counts_cache_key: rowCounts?.cache_key ?? null,
    capacity_estimate_cache: options.forceCounts ? 'refresh' : 'miss',
    capacity_estimate_cache_seconds: CAPACITY_ESTIMATE_CACHE_MS / 1000,
    quota_reference: quotaReference,
    ping_tasks: pingTasksWithEstimates,
  };
  if (!options.forceCounts) {
    capacityEstimateCache = {
      value: estimate,
      expiresAt: Date.now() + CAPACITY_ESTIMATE_CACHE_MS,
    };
  }
  return estimate;
}

async function runMaintenanceCleanup(database: db.QueryDatabase, username: string, now = new Date()) {
  const settings = buildAdminSettings(await db.getSettingsByKeys(database, MAINTENANCE_CLEANUP_SETTING_KEYS));
  const recordHours = Math.min(72, Math.max(1, Number(settings.record_preserve_time || 72)));
  const pingHours = Math.min(72, Math.max(1, Number(settings.ping_record_preserve_time || recordHours)));
  const auditHours = Math.max(24, Number(settings.audit_log_preserve_time || 2160));
  const before = {
    records: new Date(now.getTime() - recordHours * 60 * 60 * 1000).toISOString(),
    ping_records: new Date(now.getTime() - pingHours * 60 * 60 * 1000).toISOString(),
    audit_logs: new Date(now.getTime() - auditHours * 60 * 60 * 1000).toISOString(),
  };
  const expiredBacklogBefore = await db.getExpiredRowCounts(database, before);
  const maxExpiredBacklog = Math.max(
    expiredBacklogBefore.records,
    expiredBacklogBefore.gpu_records,
    expiredBacklogBefore.ping_records,
    expiredBacklogBefore.audit_logs,
  );
  const cleanupOptions = {
    maxBatches: Math.min(1000, Math.max(200, Math.ceil(maxExpiredBacklog / 100))),
  };
  const deleted = {
    ...(await db.deleteOldRecords(database, before.records, cleanupOptions)),
    ...(await db.deleteOldPingRecords(database, before.ping_records, cleanupOptions)),
    ...(await db.deleteOldAuditLogs(database, before.audit_logs, cleanupOptions)),
  };
  const orphanCleanup = await db.cleanupOrphanClientData(database);
  const expiredBacklogAfter = await db.getExpiredRowCounts(database, before);
  invalidateCapacityEstimateCache();
  const result = {
    success: true,
    before,
    cleanup_options: cleanupOptions,
    deleted,
    orphan_cleanup: orphanCleanup,
    expired_backlog_before: expiredBacklogBefore,
    expired_backlog_after: expiredBacklogAfter,
  };
  await db.insertAuditLog(database, username, 'maintenance_cleanup', `手动维护清理完成: ${JSON.stringify(result)}`);
  return result;
}

type GitHubCommitInfo = {
  sha?: unknown;
  html_url?: unknown;
  commit?: {
    message?: unknown;
    committer?: { date?: unknown };
    author?: { date?: unknown };
  };
};

function updateString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function fetchGitHubJson<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'cf-vps-monitor-update-check',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }
  return await response.json();
}

function fetchLatestCommit(repository: string): Promise<GitHubCommitInfo> {
  return fetchGitHubJson<GitHubCommitInfo>(`repos/${repository}/commits/${OFFICIAL_UPDATE_BRANCH}`);
}

async function fetchLatestWorkerVersion(repository: string, commitSha: string): Promise<string> {
  const response = await fetch(`https://raw.githubusercontent.com/${repository}/${commitSha}/worker/package.json`, {
    headers: { 'User-Agent': 'cf-vps-monitor-update-check' },
  });
  if (!response.ok) return 'dev';
  const body = await response.json().catch(() => null);
  return body && typeof body === 'object' && typeof (body as { version?: unknown }).version === 'string'
    ? (body as { version: string }).version
    : 'dev';
}

async function getUpdateSettings(c: AdminContext): Promise<{ repositoryUrl: string }> {
  const database = getDatabase(c.env);
  const stored = await db.getSettingsByKeys(database, ['update_repository_url'], true);
  const settings = buildAdminSettings(stored);
  return {
    repositoryUrl: settings.update_repository_url,
  };
}

async function buildCommitUpdateResult(
  repository: string,
  deploymentRepositoryUrl: string,
  currentCommitRaw: string | undefined,
): Promise<UpdateCheckResult> {
  const commit = await fetchLatestCommit(repository);
  const latestCommit = normalizeGitSha(updateString(commit.sha));
  const latestVersion = await fetchLatestWorkerVersion(repository, latestCommit);
  const currentCommit = normalizeGitSha(currentCommitRaw);
  const repositoryUrl = repositoryUrlFromRepositoryUrl(deploymentRepositoryUrl);
  const message = updateString(commit.commit?.message);
  return {
    current_version: formatAppVersion(APP_VERSION),
    latest_version: formatAppVersion(latestVersion),
    current_commit: shortGitSha(currentCommit),
    latest_commit: shortGitSha(latestCommit),
    has_update: Boolean(latestCommit) && currentCommit !== latestCommit,
    source_url: updateString(commit.html_url) || `https://github.com/${repository}/commits/${OFFICIAL_UPDATE_BRANCH}`,
    upgrade_url: repositoryUrl,
    repository_url: repositoryUrl,
    title: message.split('\n')[0] || latestCommit,
    body: message,
    published_at: updateString(commit.commit?.committer?.date) || updateString(commit.commit?.author?.date),
  };
}


adminRoutes.get('/update-check', async (c) => {
  const now = Date.now();
  try {
    const { repositoryUrl } = await getUpdateSettings(c);
    const repository = OFFICIAL_UPDATE_REPOSITORY;
    const currentCommit = normalizeGitSha(c.env.CURRENT_GIT_COMMIT);
    const cacheKey = `${repository}:${OFFICIAL_UPDATE_BRANCH}:commit:${repositoryUrl}:${currentCommit}`;
    const cached = updateCheckCache.get(cacheKey);
    if (c.req.query('refresh') !== '1' && cached && cached.expiresAt > now) {
      return c.json(cached.value);
    }

    const result = await buildCommitUpdateResult(repository, repositoryUrl, currentCommit);
    updateCheckCache.set(cacheKey, { expiresAt: now + UPDATE_CHECK_CACHE_MS, value: result });
    return c.json(result);
  } catch (error) {
    return c.json({
      error: 'Update check failed',
      detail: errorDetail(error),
    }, 502);
  }
});

// ============ 客户端管理 ============

// 获取所有客户端（含隐藏的）
adminRoutes.get('/clients', async (c) => {
  const metrics: TimingMetric[] = [];
  const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  let snapshot: AdminClientsSnapshot | null = null;
  if (!refresh) {
    snapshot = await timed(metrics, 'do_snapshot', () => readAdminClientsSnapshot(c));
    if (snapshot && snapshot.removed.length === 0) {
      c.header('X-CF-VPS-Monitor-Admin-Clients-Cache', 'do-hit');
      c.header('Cache-Control', 'no-store');
      setServerTiming(c, metrics);
      return c.json(snapshot.clients);
    }
  }
  let repairAdminClientsSnapshot = Boolean(snapshot && snapshot.removed.length > 0);
  const cacheHit = !refresh && !repairAdminClientsSnapshot && Boolean(adminClientsCache && adminClientsCache.expiresAt > Date.now());
  const database = getDatabase(c.env);
  const clients = await timed(metrics, cacheHit ? 'memory_cache' : 'db_list_clients', () => listAdminClientsCached(database, refresh || repairAdminClientsSnapshot));
  if (refresh) {
    snapshot = await timed(metrics, 'do_snapshot', () => readAdminClientsSnapshot(c));
    repairAdminClientsSnapshot = Boolean(snapshot && snapshot.removed.length > 0);
  }
  const safeClients = applyAdminClientsSnapshot(clients.map(hideAdminClientToken), snapshot);
  if (!snapshot || repairAdminClientsSnapshot) {
    runAdminBackground(c, (async () => {
      await writeAdminClientsSnapshot(c, safeClients);
      await broadcastLiveMetadataChanged(c, { clients: { upsert: safeClients } });
    })());
  }
  c.header('X-CF-VPS-Monitor-Admin-Clients-Cache', refresh ? 'refresh' : (repairAdminClientsSnapshot ? 'repair' : (cacheHit ? 'hit' : 'miss')));
  c.header('Cache-Control', 'no-store');
  setServerTiming(c, metrics);
  return c.json(safeClients);
});

// 获取单个客户端
adminRoutes.get('/clients/:uuid', async (c) => {
  const uuid = c.req.param('uuid');
  const database = getDatabase(c.env);
  const client = await db.getClient(database, uuid);
  if (!client) {
    return c.json({ error: '客户端不存在' }, 404);
  }
  return c.json(hideAdminClientToken(client));
});

// 添加客户端（手动创建）
adminRoutes.post('/clients/add', async (c) => {
  const metrics: TimingMetric[] = [];
  try {
    const parsed = await timed(metrics, 'parse_body', () => readAdminJsonObject(c));
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const validated = validateClientCreateInput(body);
    if (!validated.ok) {
      return c.json({ error: '客户端校验失败', details: validated.errors }, 400);
    }

    const { uuid, token, name } = validated.client;
    const database = getDatabase(c.env);
    let createdClient: db.Client;
    try {
      createdClient = await timed(metrics, 'db_create', () => db.createClient(database, {
        uuid,
        token,
        name,
      }));
    } catch (error) {
      if (isClientUniqueConflict(error)) return c.json({ error: '客户端 UUID 或 Token 已存在' }, 409);
      throw error;
    }
    const safeClient = hideAdminClientToken(createdClient);
    invalidateAdminClientsCache();
    const publicMetadataPurge = invalidateAdminPublicMetadata(c);
    invalidateAgentClientAuthCache({ uuid, token });
    invalidateAllowedClientIdsCache();
    invalidateCapacityEstimateCache();
    await timed(metrics, 'post_write_cache', async () => {
      await Promise.all([
        syncLiveClientMeta(c, safeClient).catch(() => undefined),
        syncAgentAuthClient(c, createdClient).catch(() => undefined),
        publicMetadataPurge.catch(() => undefined),
        purgeAdminClientsEdgeCache(c),
      ]);
    });

    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'client_add', `添加客户端: ${name}`));

    setServerTiming(c, metrics);
    return c.json({ success: true, uuid, token, client: safeClient });
  } catch (e) {
    return c.json({ error: '创建失败' }, 500);
  }
});

// 编辑客户端
adminRoutes.post('/clients/:uuid/edit', async (c) => {
  const metrics: TimingMetric[] = [];
  try {
    const uuid = c.req.param('uuid');
    const parsed = await timed(metrics, 'parse_body', () => readAdminJsonObject(c));
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const database = getDatabase(c.env);
    const validated = validateClientUpdateInput(body);
    if (!validated.ok) {
      return c.json({ error: '客户端校验失败', details: validated.errors }, 400);
    }
    if (Object.keys(validated.client).length === 0) {
      setServerTiming(c, metrics);
      return c.json({ success: true, noop: true, changed: 0 });
    }

    const updatedClient = await timed(metrics, 'db_update', () => db.updateClientAndReturn(database, uuid, validated.client));
    if (!updatedClient) return c.json({ error: '客户端不存在' }, 404);
    const safeClient = hideAdminClientToken(updatedClient);
    invalidateAdminClientsCache();
    const publicMetadataPurge = invalidateAdminPublicMetadata(c);
    invalidateAgentClientAuthCache({ uuid });
    invalidateCapacityEstimateCache();
    await timed(metrics, 'post_write_cache', async () => {
      await Promise.all([
        syncLiveClientMeta(c, safeClient).catch(() => undefined),
        syncAgentAuthClient(c, updatedClient).catch(() => undefined),
        publicMetadataPurge.catch(() => undefined),
        purgeAdminClientsEdgeCache(c),
      ]);
    });
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'client_edit', `编辑客户端: ${uuid}`));

    setServerTiming(c, metrics);
    return c.json({ success: true, changed: 1, client: safeClient });
  } catch (e) {
    return c.json({ error: '编辑失败' }, 500);
  }
});

// 删除客户端
adminRoutes.post('/clients/:uuid/remove', async (c) => {
  const metrics: TimingMetric[] = [];
  const uuid = c.req.param('uuid');
  const parsed = await timed(metrics, 'parse_body', () => readAdminJsonObject(c));
  if (!parsed.ok) return parsed.response;
  const database = getDatabase(c.env);
  const result = await timed(metrics, 'db_delete', () => db.deleteClient(database, uuid));
  if (result.removed === 0) {
    await timed(metrics, 'post_write_cache', async () => {
      await Promise.all([
        removeLiveClient(c, uuid).catch(() => undefined),
        purgeAdminClientsEdgeCache(c),
      ]);
    });
    setServerTiming(c, metrics);
    return c.json({ error: '客户端不存在', removed: 0 }, 404);
  }
  invalidateAdminClientsCache();
  const publicMetadataPurge = invalidateAdminPublicMetadata(c);
  invalidateAgentClientAuthCache({ uuid });
  invalidateAgentPingTaskCache();
  invalidateAllowedClientIdsCache();
  invalidateCapacityEstimateCache();
  await timed(metrics, 'post_write_cache', async () => {
    await Promise.all([
      removeLiveClient(c, uuid).catch(() => undefined),
      publicMetadataPurge.catch(() => undefined),
      purgeAdminClientsEdgeCache(c),
    ]);
  });
  runAdminBackground(c, (async () => {
    const cleanup = await db.pruneClientReferences(database, uuid);
    await refreshLivePingTasks(c);
    await db.insertAuditLog(database, c.get('username')!, 'client_remove', `删除客户端: ${uuid}; removed=${result.removed}; deleted_records=${JSON.stringify(result.deleted_records)}; 清理引用: ${JSON.stringify(cleanup)}`);
  })());
  setServerTiming(c, metrics);
  return c.json({ success: true, removed: result.removed, deleted_records: result.deleted_records });
});

// 获取客户端 Token。管理列表不常驻下发，按需返回当前可用安装凭据。
adminRoutes.post('/clients/:uuid/token', async (c) => {
  const uuid = c.req.param('uuid');
  const parsed = await readAdminJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const database = getDatabase(c.env);
  const installToken = await getInstallToken(database, uuid);
  if (!installToken) {
    return c.json({ error: '客户端不存在' }, 404);
  }
  const { token } = installToken;
  if (!token) {
    return c.json({ error: 'Token 明文不存在，请手动重置 Token 后再复制安装命令' }, 409);
  }
  return c.json({ token });
});

adminRoutes.post('/clients/:uuid/token/install', async (c) => {
  const uuid = c.req.param('uuid');
  const database = getDatabase(c.env);
  const installToken = await getInstallToken(database, uuid);
  if (!installToken) {
    return c.json({ error: '客户端不存在' }, 404);
  }
  const { token } = installToken;
  if (!token) {
    return c.json({ error: 'Token 明文不存在，请手动重置 Token 后再复制安装命令' }, 409);
  }
  return c.json({ token, rotated: false });
});

adminRoutes.post('/clients/:uuid/token/rotate', async (c) => {
  const uuid = c.req.param('uuid');
  const parsed = await readAdminJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const database = getDatabase(c.env);
  const client = await db.getClientTokenMeta(database, uuid);
  if (!client) {
    return c.json({ error: '客户端不存在' }, 404);
  }

  const token = await generateUniqueClientToken(database);
  if (!token) {
    return c.json({ error: '生成新 Token 失败，请重试' }, 500);
  }

  const updatedClient = await db.rotateClientToken(database, uuid, token);
  invalidateAdminClientsCache();
  invalidateAdminPublicMetadata(c);
  invalidateAgentClientAuthCache(client);
  invalidateAgentClientAuthCache({ uuid, token });
  await Promise.all([
    disconnectLiveClient(c, uuid).catch(() => undefined),
    updatedClient ? syncAgentAuthClient(c, updatedClient) : Promise.resolve(),
    purgeAdminClientsEdgeCache(c),
  ]);
  await db.insertAuditLog(database, c.get('username')!, 'client_token_rotate', `重置客户端 Token: ${client.name || uuid}`);
  return c.json({ success: true, token });
});

adminRoutes.post('/clients/reorder', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const uuids = Array.isArray(body.uuids)
      ? body.uuids.map((uuid: unknown) => String(uuid || '').trim()).filter(Boolean)
      : [];

    if (uuids.length === 0) {
      return c.json({ error: '客户端排序列表不能为空' }, 400);
    }

    if (new Set(uuids).size !== uuids.length) {
      return c.json({ error: '客户端排序列表不能包含重复 UUID' }, 400);
    }

    const database = getDatabase(c.env);
    const existingClients = await db.getClientsByIds(database, uuids);
    const existingSet = new Set(existingClients.map(client => client.uuid));
    const existingUuids = uuids.filter(uuid => existingSet.has(uuid));
    const missing = uuids.filter(uuid => !existingSet.has(uuid));
    const updated = existingUuids.length > 0 ? await db.reorderClients(database, existingUuids) : 0;
    if (updated > 0) {
      const refreshedClients = (await listAdminClientsCached(database, true)).map(hideAdminClientToken);
      await writeAdminClientsSnapshot(c, refreshedClients);
      await Promise.all([
        purgeAdminClientsEdgeCache(c),
        broadcastLiveMetadataChanged(c, {
          clients: { upsert: existingUuids.map((uuid, index) => ({ uuid, sort_order: index + 1 })) },
        }),
      ]);
    }
    invalidateAdminPublicMetadata(c);
    invalidateCapacityEstimateCache();
    await db.insertAuditLog(database, c.get('username')!, 'client_reorder', `调整客户端排序: ${existingUuids.join(',')}; missing=${missing.join(',')}`);
    return c.json({ success: true, updated, missing });
  } catch (error) {
    console.error('[admin] client reorder failed:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '排序失败' }, 400);
  }
});

adminRoutes.post('/clients/batch-hide', async (c) => {
  try {
    const json = await readAdminJsonObject(c);
    if (!json.ok) return json.response;
    const body = json.body;
    const uuidList = parseUniqueStringList(body.uuids);
    if (!uuidList.ok) return c.json({ error: uuidList.error }, 400);
    const uuids = uuidList.values;

    const database = getDatabase(c.env);
    const clients = await db.getClientsByIds(database, uuids);
    const existingByUuid = new Map(clients.map(client => [client.uuid, client]));
    const missing = uuids.filter(uuid => !existingByUuid.has(uuid));
    const visibleClients = clients.filter(client => !Boolean(client.hidden));
    const changed = await db.updateClientsHidden(database, visibleClients.map(client => client.uuid), true);
    for (const client of clients) {
      await syncLiveClientMeta(c, { ...client, hidden: true });
      invalidateAgentClientAuthCache(client);
    }

    const updated = clients.length;
    if (updated > 0) {
      invalidateAdminClientsCache();
      await purgeAdminClientsEdgeCache(c);
      invalidateAdminPublicMetadata(c);
      invalidateCapacityEstimateCache();
    }
    await db.insertAuditLog(database, c.get('username')!, 'client_batch_hide', `批量隐藏客户端: ${uuids.join(',')}; updated=${updated}; missing=${missing.join(',')}`);
    return c.json({ success: true, updated, changed, missing });
  } catch {
    return c.json({ error: '批量隐藏失败' }, 500);
  }
});

adminRoutes.post('/clients/batch-remove', async (c) => {
  try {
    const json = await readAdminJsonObject(c);
    if (!json.ok) return json.response;
    const body = json.body;
    const uuidList = parseUniqueStringList(body.uuids);
    if (!uuidList.ok) return c.json({ error: uuidList.error }, 400);
    const uuids = uuidList.values;

    const database = getDatabase(c.env);
    const clients = await db.getClientsByIds(database, uuids);
    const existingByUuid = new Map(clients.map(client => [client.uuid, client]));
    const existingUuids = clients.map(client => client.uuid);
    const missing = uuids.filter(uuid => !existingByUuid.has(uuid));
    const result = await db.deleteClients(database, existingUuids);
    const removed = result.removed;
    for (const uuid of existingUuids) {
      await removeLiveClient(c, uuid);
    }
    const deletedRecords = result.deleted_records;
    const cleanup = await db.pruneClientReferencesForClients(database, existingUuids);

    if (removed > 0) {
      invalidateAdminClientsCache();
      await purgeAdminClientsEdgeCache(c);
      invalidateAdminPublicMetadata(c);
      invalidateAgentClientAuthCache();
      invalidateAgentPingTaskCache();
      invalidateAllowedClientIdsCache();
      invalidateCapacityEstimateCache();
      await refreshLivePingTasks(c);
    }
    await db.insertAuditLog(database, c.get('username')!, 'client_batch_remove', `批量删除客户端: ${uuids.join(',')}; removed=${removed}; missing=${missing.join(',')}; 清理引用: ${JSON.stringify(cleanup)}`);
    return c.json({ success: true, removed, missing, deleted_records: deletedRecords, cleanup });
  } catch {
    return c.json({ error: '批量删除失败' }, 500);
  }
});

// ============ 数据记录管理 ============

// 清除指定客户端记录
adminRoutes.post('/record/clear', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const uuid = typeof body.uuid === 'string' ? body.uuid.trim() : '';
    const database = getDatabase(c.env);
    if (uuid) {
      await db.clearClientRecords(database, uuid);
      invalidateCapacityEstimateCache();
    }
    await db.insertAuditLog(database, c.get('username')!, 'record_clear', `清除记录: ${uuid}`);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '清除失败' }, 500);
  }
});

// 清除所有记录
adminRoutes.post('/record/clear/all', async (c) => {
  const parsed = await readAdminJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const database = getDatabase(c.env);
  const result = await db.clearAllRecords(database);
  invalidateCapacityEstimateCache();
  await db.insertAuditLog(
    database,
    c.get('username')!,
    'record_clear_all',
    `清除所有记录: ${JSON.stringify(result)}`,
    result.has_more ? 'warning' : 'info',
  );
  return c.json({
    success: true,
    complete: !result.has_more,
    has_more: result.has_more,
    deleted: result.deleted,
    remaining: result.remaining,
  });
});

// ============ Ping 任务管理 ============

// 获取所有 Ping 任务
adminRoutes.get('/ping', async (c) => {
  const metrics: TimingMetric[] = [];
  const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  if (!refresh) {
    const cached = await timed(metrics, 'edge_cache', () => getAdminPingTasksEdgeCache());
    if (cached) {
      setServerTiming(c, metrics);
      return cached;
    }
  }
  const database = getDatabase(c.env);
  const cacheHit = !refresh && Boolean(adminPingTasksCache && adminPingTasksCache.expiresAt > Date.now());
  const tasks = await timed(metrics, cacheHit ? 'memory_cache' : 'db_list_ping', () => listAdminPingTasksCached(database, refresh));
  if (!refresh) putAdminPingTasksEdgeCache(c, tasks);
  setServerTiming(c, metrics);
  c.header('X-CF-VPS-Monitor-Admin-Ping-Cache', refresh ? 'refresh' : (cacheHit ? 'hit' : 'miss'));
  return c.json(tasks);
});

// 添加 Ping 任务
adminRoutes.post('/ping/add', async (c) => {
  const metrics: TimingMetric[] = [];
  try {
    const parsed = await timed(metrics, 'parse_body', () => readAdminJsonObject(c));
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const candidate: Record<string, unknown> = {
      ...body,
      interval: 60,
      interval_sec: 60,
    };
    const database = getDatabase(c.env);
    const allowedClientIds = candidate.all_clients ? undefined : await timed(metrics, 'db_allowed_clients', () => getAllowedClientIdsForPingTask(database, candidate));
    const validated = validatePingTaskInput(candidate, allowedClientIds);
    if (!validated.ok) {
      return c.json({ error: 'Ping 任务校验失败', details: validated.errors }, 400);
    }

    const task = await timed(metrics, 'db_create_ping', () => db.createPingTask(database, validated.task));
    invalidateAdminPingTasksCache();
    purgeAdminPingTasksEdgeCache(c);
    invalidateAdminPublicMetadata(c);
    invalidateAgentPingTaskCache();
    invalidateCapacityEstimateCache();
    runAdminBackground(c, refreshLivePingTasks(c));
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'ping_add', pingTaskAuditDetail('添加 Ping 任务', task)));
    setServerTiming(c, metrics);
    return c.json({ success: true, task });
  } catch {
    return c.json({ error: '添加失败' }, 500);
  }
});

// 编辑 Ping 任务
adminRoutes.post('/ping/edit', async (c) => {
  const metrics: TimingMetric[] = [];
  try {
    const parsed = await timed(metrics, 'parse_body', () => readAdminJsonObject(c));
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Ping 任务 ID 无效' }, 400);
    }

    const database = getDatabase(c.env);
    const candidate: Record<string, unknown> = {
      ...body,
      interval: 60,
      interval_sec: 60,
    };
    const allowedClientIds = candidate.all_clients ? undefined : await timed(metrics, 'db_allowed_clients', () => getAllowedClientIdsForPingTask(database, candidate));
    const validated = validatePingTaskInput(candidate, allowedClientIds);
    if (!validated.ok) {
      return c.json({ error: 'Ping 任务校验失败', details: validated.errors }, 400);
    }

    const task = await timed(metrics, 'db_update_ping', () => db.updatePingTaskAndReturn(database, id, validated.task));
    if (!task) return c.json({ error: 'Ping 任务不存在' }, 404);
    invalidateAdminPingTasksCache();
    purgeAdminPingTasksEdgeCache(c);
    invalidateAdminPublicMetadata(c);
    invalidateAgentPingTaskCache();
    invalidateCapacityEstimateCache();
    runAdminBackground(c, refreshLivePingTasks(c));
    runAdminBackground(c, db.insertAuditLog(
      database,
      c.get('username')!,
      'ping_edit',
      pingTaskAuditDetail(`编辑 Ping 任务 ${id}`, task),
    ));
    setServerTiming(c, metrics);
    return c.json({ success: true, changed: 1, task });
  } catch {
    return c.json({ error: '编辑失败' }, 500);
  }
});

adminRoutes.post('/ping/reorder', async (c) => {
  const metrics: TimingMetric[] = [];
  try {
    const parsed = await timed(metrics, 'parse_body', () => readAdminJsonObject(c));
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0)
      : [];

    if (ids.length === 0) {
      return c.json({ error: 'Ping 任务排序列表不能为空' }, 400);
    }

    if (new Set(ids).size !== ids.length) {
      return c.json({ error: 'Ping 任务排序列表不能包含重复 ID' }, 400);
    }

    const database = getDatabase(c.env);
    const updated = await timed(metrics, 'db_reorder_ping', () => db.reorderPingTasks(database, ids));
    invalidateAdminPingTasksCache();
    purgeAdminPingTasksEdgeCache(c);
    invalidateAdminPublicMetadata(c);
    invalidateAgentPingTaskCache();
    invalidateCapacityEstimateCache();
    runAdminBackground(c, refreshLivePingTasks(c));
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'ping_reorder', `调整 Ping 任务排序: ${ids.join(',')}`));
    setServerTiming(c, metrics);
    return c.json({ success: true, updated });
  } catch {
    return c.json({ error: '排序失败' }, 400);
  }
});

// 删除 Ping 任务
adminRoutes.post('/ping/delete', async (c) => {
  const metrics: TimingMetric[] = [];
  try {
    const parsed = await timed(metrics, 'parse_body', () => readAdminJsonObject(c));
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const database = getDatabase(c.env);
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Ping 任务 ID 无效' }, 400);
    }
    const deleted = await timed(metrics, 'db_delete_ping', () => db.deletePingTask(database, id));
    if (!deleted) return c.json({ error: 'Ping 任务不存在' }, 404);
    invalidateAdminPingTasksCache();
    purgeAdminPingTasksEdgeCache(c);
    invalidateAdminPublicMetadata(c);
    invalidateAgentPingTaskCache();
    invalidateCapacityEstimateCache();
    runAdminBackground(c, refreshLivePingTasks(c));
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'ping_delete', pingTaskAuditDetail(`删除 Ping 任务 ${id}`, deleted)));
    setServerTiming(c, metrics);
    return c.json({ success: true, id });
  } catch {
    return c.json({ error: '删除失败' }, 500);
  }
});

// ============ 网站监控 ============

adminRoutes.get('/websites', async (c) => {
  const database = getDatabase(c.env);
  return c.json(await db.listWebsiteMonitors(database, true));
});

adminRoutes.get('/websites/:id/checks', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: '网站监控 ID 无效' }, 400);
  }
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') || 120)));
  const database = getDatabase(c.env);
  return c.json(await db.listWebsiteChecks(database, id, limit));
});

adminRoutes.post('/websites/add', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const validated = validateWebsiteMonitorInput(body);
    if (!validated.ok) return c.json({ error: '网站监控校验失败', code: validated.error }, 400);

    const database = getDatabase(c.env);
    const monitor = await db.createWebsiteMonitor(database, validated.value);
    invalidateWebsiteMonitorPublicState(c, { upsert: [monitor] });
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'website_add', `添加网站监控: ${monitor.name} ${monitor.url}`));
    return c.json({ success: true, monitor });
  } catch (error) {
    console.error('[admin] website add failed:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '添加失败' }, 500);
  }
});

adminRoutes.post('/websites/edit', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: '网站监控 ID 无效' }, 400);
    }

    const database = getDatabase(c.env);
    const hasFullPayload = WEBSITE_MONITOR_REQUIRED_EDIT_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(body, field));
    const existing = hasFullPayload ? null : await db.getWebsiteMonitor(database, id);
    if (!hasFullPayload && !existing) return c.json({ error: '网站监控不存在' }, 404);

    const candidate = hasFullPayload ? body : { ...existing, ...body };
    const validated = validateWebsiteMonitorInput(candidate);
    if (!validated.ok) return c.json({ error: '网站监控校验失败', code: validated.error }, 400);

    const monitor = await db.updateWebsiteMonitorAndReturn(database, id, validated.value);
    if (!monitor) return c.json({ error: '网站监控不存在' }, 404);
    invalidateWebsiteMonitorPublicState(c, { upsert: [monitor] });
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'website_edit', `编辑网站监控: ${existing?.name || id} -> ${monitor.name}`));
    return c.json({ success: true, changed: 1, monitor });
  } catch (error) {
    console.error('[admin] website edit failed:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '编辑失败' }, 500);
  }
});

adminRoutes.post('/websites/visibility', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const id = Number(body.id);
    const hidden = body.hidden;
    if (!Number.isInteger(id) || id <= 0 || typeof hidden !== 'boolean') {
      return c.json({ error: '网站监控显隐参数无效' }, 400);
    }
    const database = getDatabase(c.env);
    const changed = await db.setWebsiteMonitorVisibility(database, id, hidden);
    const monitor = await db.getWebsiteMonitor(database, id);
    invalidateWebsiteMonitorPublicState(c, monitor ? {
      upsert: [monitor],
      remove: hidden ? [id] : undefined,
    } : true);
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'website_visibility', `网站监控 ${id} ${hidden ? '隐藏' : '显示'}`));
    return c.json({ success: true, changed: changed ? 1 : 0 });
  } catch (error) {
    console.error('[admin] website visibility failed:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '设置失败' }, 500);
  }
});

adminRoutes.post('/websites/enabled', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const id = Number(body.id);
    const enabled = body.enabled;
    if (!Number.isInteger(id) || id <= 0 || typeof enabled !== 'boolean') {
      return c.json({ error: '网站监控启停参数无效' }, 400);
    }
    const database = getDatabase(c.env);
    const changed = await db.setWebsiteMonitorEnabled(database, id, enabled);
    const monitor = await db.getWebsiteMonitor(database, id);
    invalidateWebsiteMonitorPublicState(c, monitor ? { upsert: [monitor] } : true);
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'website_enabled', `网站监控 ${id} ${enabled ? '启用' : '停用'}`));
    return c.json({ success: true, changed: changed ? 1 : 0 });
  } catch (error) {
    console.error('[admin] website enabled failed:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '设置失败' }, 500);
  }
});

adminRoutes.post('/websites/reorder', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0)
      : [];
    if (ids.length === 0) return c.json({ error: '网站监控排序列表不能为空' }, 400);
    if (new Set(ids).size !== ids.length) return c.json({ error: '网站监控排序列表不能包含重复 ID' }, 400);

    const database = getDatabase(c.env);
    const updated = await db.reorderWebsiteMonitors(database, ids);
    invalidateWebsiteMonitorPublicState(c, { reorder: ids });
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'website_reorder', `调整网站监控排序: ${ids.join(',')}`));
    return c.json({ success: true, updated });
  } catch (error) {
    console.error('[admin] website reorder failed:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '排序失败' }, 400);
  }
});

adminRoutes.post('/websites/delete', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const database = getDatabase(c.env);
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: '网站监控 ID 无效' }, 400);
    }
    const existing = await db.getWebsiteMonitor(database, id);
    if (!existing) return c.json({ error: '网站监控不存在' }, 404);
    await db.deleteWebsiteMonitor(database, id);
    invalidateWebsiteMonitorPublicState(c, { remove: [id] });
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'website_delete', `删除网站监控: ${existing.name} ${existing.url}`));
    return c.json({ success: true });
  } catch (error) {
    console.error('[admin] website delete failed:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '删除失败' }, 500);
  }
});

adminRoutes.post('/websites/:id/check', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: '网站监控 ID 无效' }, 400);
    }
    const database = getDatabase(c.env);
    const monitor = await db.getWebsiteMonitor(database, id);
    if (!monitor) return c.json({ error: '网站监控不存在' }, 404);
    const check = await checkWebsiteMonitorHttp(monitor);
    const updated = await db.recordWebsiteCheck(database, check);
    invalidateWebsiteMonitorPublicState(c, updated ? { upsert: [updated] } : true);
    runAdminBackground(c, db.insertAuditLog(database, c.get('username')!, 'website_check', `手动检测网站监控: ${monitor.name}`));
    return c.json({ success: true, monitor: updated, check });
  } catch (error) {
    console.error('[admin] website check failed:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '检测失败' }, 500);
  }
});

// ============ 系统设置 ============

// 站点 Logo
adminRoutes.post('/site-logo', async (c) => {
  const body = await readRequestBytesWithLimit(c.req.raw, MAX_SITE_LOGO_BYTES + 4096);
  if (!body.ok) return c.json({ error: `Logo 不能超过 ${MAX_SITE_LOGO_BYTES} 字节` }, 413);

  let form: FormData;
  try {
    form = await new Response(body.bytes, {
      headers: { 'Content-Type': c.req.header('Content-Type') || '' },
    }).formData();
  } catch {
    return c.json({ error: 'Logo 表单格式错误' }, 400);
  }

  const file = form.get('file');
  if (!isUploadedFile(file)) return c.json({ error: '请上传 Logo 图片' }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_SITE_LOGO_BYTES) return c.json({ error: `Logo 不能超过 ${MAX_SITE_LOGO_BYTES} 字节` }, 413);

  const contentType = detectSiteLogoType(bytes);
  if (!contentType) return c.json({ error: 'Logo 只支持 PNG、JPG、WebP' }, 400);

  const database = getDatabase(c.env);
  const version = String(Date.now());
  const siteLogoUrl = `/api/site-logo?v=${version}`;
  await db.setSettings(database, {
    site_logo_data: bytesToBase64(bytes),
    site_logo_type: contentType,
    site_logo_url: siteLogoUrl,
  });
  invalidateAdminSettingsCache();
  await invalidateAdminPublicMetadata(c);
  await db.insertAuditLog(database, c.get('username')!, 'settings_save', '上传站点 Logo');
  return c.json({ success: true, site_logo_url: siteLogoUrl });
});

adminRoutes.post('/site-logo/reset', async (c) => {
  const database = getDatabase(c.env);
  await db.setSettings(database, {
    site_logo_data: '',
    site_logo_type: '',
    site_logo_url: '',
  });
  invalidateAdminSettingsCache();
  await invalidateAdminPublicMetadata(c);
  await db.insertAuditLog(database, c.get('username')!, 'settings_save', '恢复默认站点 Logo');
  return c.json({ success: true, site_logo_url: '' });
});

// 获取所有设置
adminRoutes.get('/settings', async (c) => {
  const database = getDatabase(c.env);
  const scope = c.req.query('scope');
  if (scope) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_SCOPE_KEYS, scope)) {
      return c.json({ error: '未知设置范围' }, 400);
    }
    const fresh = scope === 'notification' || isQueryFlagEnabled(c.req.query('refresh'));
    if (!fresh) {
      const cached = adminSettingsScopeCache.get(scope);
      if (cached && cached.expiresAt > Date.now()) return c.json(cached.value);
    }
    const keys = [...SETTINGS_SCOPE_KEYS[scope as keyof typeof SETTINGS_SCOPE_KEYS]];
    const settings = buildAdminSettings(await db.getSettingsByKeys(database, keys, fresh));
    const scoped = Object.fromEntries(keys.map((key) => [key, settings[key]]));
    if (scope === 'notification') {
      scoped.email_smtp_password_set = settings.email_smtp_password ? 'true' : 'false';
      scoped.webhook_url_set = settings.webhook_url ? 'true' : 'false';
      scoped.webhook_secret_set = settings.webhook_secret ? 'true' : 'false';
      scoped.webhook_headers_set = settings.webhook_headers_json ? 'true' : 'false';
      scoped.webhook_password_set = settings.webhook_password ? 'true' : 'false';
      scoped.webhook_url_host = webhookUrlHost(settings.webhook_url);
      delete scoped['email_smtp_password'];
      delete scoped['webhook_url'];
      delete scoped['webhook_secret'];
      delete scoped['webhook_headers_json'];
      delete scoped['webhook_password'];
    }
    if (!fresh) adminSettingsScopeCache.set(scope, { value: scoped, expiresAt: Date.now() + ADMIN_SETTINGS_SCOPE_CACHE_MS });
    return c.json(scoped);
  }

  const settings = await db.getAllSettings(database, isQueryFlagEnabled(c.req.query('refresh')));
  return c.json(buildAdminSettings(settings));
});

// 修改设置
adminRoutes.post('/settings', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const database = getDatabase(c.env);
    const settingsBody = { ...body };
    delete settingsBody.email_smtp_password_set;
    delete settingsBody.webhook_url_set;
    delete settingsBody.webhook_secret_set;
    delete settingsBody.webhook_headers_set;
    delete settingsBody.webhook_password_set;
    delete settingsBody.webhook_url_host;
    const clearWebhookUrl = settingsBody.webhook_url_clear === true || settingsBody.webhook_url_clear === 'true';
    const clearWebhookSecret = settingsBody.webhook_secret_clear === true || settingsBody.webhook_secret_clear === 'true';
    delete settingsBody.webhook_url_clear;
    delete settingsBody.webhook_secret_clear;
    if (settingsBody.email_smtp_password === '') {
      delete settingsBody.email_smtp_password;
    }
    if (clearWebhookUrl) settingsBody.webhook_url = '';
    else if (settingsBody.webhook_url === '') delete settingsBody.webhook_url;
    if (clearWebhookSecret) settingsBody.webhook_secret = '';
    else if (settingsBody.webhook_secret === '') delete settingsBody.webhook_secret;
    if (settingsBody.webhook_headers_json === '') delete settingsBody.webhook_headers_json;
    if (settingsBody.webhook_password === '') delete settingsBody.webhook_password;
    const normalized = sanitizeSettingsForStorage(settingsBody);
    if (!normalized.ok) {
      return c.json({ error: '设置校验失败', details: normalized.errors }, 400);
    }

    const currentSettings = buildAdminSettings(
      await db.getSettingsByKeys(database, Object.keys(normalized.settings), true),
    );
    const changedSettings = Object.fromEntries(
      Object.entries(normalized.settings)
        .filter(([key, value]) => currentSettings[key] !== value),
    );
    const changedKeys = Object.keys(changedSettings);

    if (changedKeys.length === 0) {
      return c.json({
        success: true,
        ignored: normalized.ignoredKeys,
        changed: 0,
        noop: true,
      });
    }

    await db.setSettings(database, changedSettings);
    invalidateAdminSettingsCache();
    const background: Promise<unknown>[] = [];
    if (changedKeys.some((key) => CAPACITY_ESTIMATE_SETTING_KEY_SET.has(key))) {
      invalidateCapacityEstimateCache();
    }
    if (changedKeys.some((key) => SETTING_SCHEMA[key as keyof typeof SETTING_SCHEMA]?.public)) {
      invalidateAdminPublicMetadata(c);
    }
    if (changedKeys.includes('ping_record_persist_interval_sec')) {
      invalidateAgentPingTaskCache();
    }
    const livePolicySettingsChanged =
      changedKeys.some((key) => LIVE_POLICY_SETTING_KEYS.has(key));
    const recordPersistenceSettingsChanged =
      changedKeys.some((key) => RECORD_PERSISTENCE_SETTING_KEYS.has(key));
    if (
      livePolicySettingsChanged ||
      recordPersistenceSettingsChanged
    ) {
      const doId = c.env.LIVE_DATA.idFromName('global');
      const stub = c.env.LIVE_DATA.get(doId);
      if (livePolicySettingsChanged) {
        invalidateLiveViewerSettingsCache();
        background.push(stub.fetch(new Request('https://do/policy-refresh', { method: 'POST' })));
      }
      if (recordPersistenceSettingsChanged) {
        background.push(stub.fetch(new Request('https://do/record-settings-refresh', { method: 'POST' })));
      }
    }
    background.push(db.insertAuditLog(database, c.get('username')!, 'settings_edit', `修改系统设置: ${changedKeys.join(',')}`));
    if (background.length > 0) {
      c.executionCtx?.waitUntil(Promise.all(background).catch((error) => {
        console.error('[settings] post-save refresh failed:', errorDetail(error));
      }));
    }
    return c.json({ success: true, ignored: normalized.ignoredKeys, changed: changedKeys.length, noop: false });
  } catch {
    return c.json({ error: '保存失败' }, 500);
  }
});

// ============ 通知设置 ============

// 离线通知列表
adminRoutes.get('/notification/offline', async (c) => {
  const database = getDatabase(c.env);
  const notifications = await db.listOfflineNotifications(database, true);
  return c.json(notifications);
});

// 编辑离线通知 (支持单个和批量)
adminRoutes.post('/notification/offline/edit', async (c) => {
  try {
    const parsed = await readAdminJsonObjectOrArray(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const database = getDatabase(c.env);
    const allowedClientIds = await getAllowedClientIds(database);
    // 支持批量编辑：数组形式
    const items = Array.isArray(body) ? body : [body];
    const normalized = [];
    const errors: string[] = [];
    for (const [index, item] of items.entries()) {
      const validated = validateOfflineNotificationInput(item, allowedClientIds);
      if (!validated.ok) {
        errors.push(...validated.errors.map(error => `${index}: ${error}`));
      } else {
        normalized.push(validated.item);
      }
    }
    if (errors.length > 0) {
      return c.json({ error: '离线通知校验失败', details: errors }, 400);
    }
    const changed = await db.setOfflineNotifications(database, normalized);
    return c.json({ success: true, updated: normalized.length, changed, noop: changed === 0 });
  } catch {
    return c.json({ error: '保存失败' }, 500);
  }
});

// 到期通知列表
adminRoutes.get('/notification/expiry', async (c) => {
  const database = getDatabase(c.env);
  const notifications = await db.listExpiryNotifications(database, true);
  return c.json(notifications);
});

// 编辑到期通知 (支持单个和批量)
adminRoutes.post('/notification/expiry/edit', async (c) => {
  try {
    const parsed = await readAdminJsonObjectOrArray(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const database = getDatabase(c.env);
    const allowedClientIds = await getAllowedClientIds(database);
    const items = Array.isArray(body) ? body : [body];
    const normalized = [];
    const errors: string[] = [];
    for (const [index, item] of items.entries()) {
      const validated = validateExpiryNotificationInput(item, allowedClientIds);
      if (!validated.ok) {
        errors.push(...validated.errors.map(error => `${index}: ${error}`));
      } else {
        normalized.push(validated.item);
      }
    }
    if (errors.length > 0) {
      return c.json({ error: '到期通知校验失败', details: errors }, 400);
    }
    const changed = await db.setExpiryNotifications(database, normalized);
    return c.json({ success: true, updated: normalized.length, changed, noop: changed === 0 });
  } catch {
    return c.json({ error: '保存失败' }, 500);
  }
});

// 负载通知列表
adminRoutes.get('/notification/load', async (c) => {
  const database = getDatabase(c.env);
  const notifications = await db.listLoadNotifications(database, true);
  return c.json(notifications);
});

// 添加负载通知
adminRoutes.post('/notification/load/add', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const database = getDatabase(c.env);
    const validated = validateLoadNotificationInput(body, await getAllowedClientIdsForLoadNotification(database, body));
    if (!validated.ok) {
      return c.json({ error: '负载通知校验失败', details: validated.errors }, 400);
    }
    await db.createLoadNotification(database, validated.item);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '添加失败' }, 500);
  }
});

// 编辑负载通知
adminRoutes.post('/notification/load/edit', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const database = getDatabase(c.env);
    const validated = validateLoadNotificationInput(body, await getAllowedClientIdsForLoadNotification(database, body), { requireId: true });
    if (!validated.ok) {
      return c.json({ error: '负载通知校验失败', details: validated.errors }, 400);
    }
    const { id, ...data } = validated.item;
    const existing = await db.getLoadNotification(database, id!, true);
    if (!existing) return c.json({ error: '负载通知不存在' }, 404);
    const changed = await db.updateLoadNotification(database, id!, data);
    return c.json({ success: true, changed: changed ? 1 : 0, noop: !changed });
  } catch {
    return c.json({ error: '编辑失败' }, 500);
  }
});

// 删除负载通知 (DELETE /:id)
adminRoutes.delete('/notification/load/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: '负载通知 ID 无效' }, 400);
  }
  const database = getDatabase(c.env);
  await db.deleteLoadNotification(database, id);
  return c.json({ success: true });
});

// 删除负载通知 (legacy)
adminRoutes.post('/notification/load/delete', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: '负载通知 ID 无效' }, 400);
    }
    const database = getDatabase(c.env);
    await db.deleteLoadNotification(database, id);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '删除失败' }, 500);
  }
});

// 编辑负载通知 (POST /:id)
adminRoutes.post('/notification/load/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const database = getDatabase(c.env);
    const validated = validateLoadNotificationInput(
      { ...body, id },
      await getAllowedClientIdsForLoadNotification(database, body),
      { requireId: true },
    );
    if (!validated.ok) {
      return c.json({ error: '负载通知校验失败', details: validated.errors }, 400);
    }
    const { id: _id, ...data } = validated.item;
    const existing = await db.getLoadNotification(database, id, true);
    if (!existing) return c.json({ error: '负载通知不存在' }, 404);
    const changed = await db.updateLoadNotification(database, id, data);
    return c.json({ success: true, changed: changed ? 1 : 0, noop: !changed });
  } catch {
    return c.json({ error: '编辑失败' }, 500);
  }
});

// ============ 账户管理 ============

type MfaMethod = 'totp' | 'recovery_code';

function readMfaMethod(value: unknown): MfaMethod | null {
  return value === 'totp' || value === 'recovery_code' ? value : null;
}

async function verifyUserMfaFactor(
  database: db.QueryDatabase,
  user: db.User,
  method: MfaMethod,
  code: string,
  env: Bindings,
): Promise<boolean> {
  if (!user.totp_enabled_at || !user.totp_secret_enc) return false;
  if (method === 'recovery_code') {
    try {
      return db.consumeRecoveryCode(database, user.uuid, await hashRecoveryCode(code, env));
    } catch (error) {
      if (error instanceof AuthConfigurationError) throw error;
      return false;
    }
  }

  const secret = await decryptTotpSecret(user.totp_secret_enc, user.uuid, env);
  const result = await verifyTotpCode(secret, code);
  return Boolean(result.valid && result.step !== undefined &&
    await db.consumeTotpStep(database, user.uuid, result.step));
}

async function replaceRotatedAdminSession(c: AdminContext, previousSessionVersion: number, user: db.User): Promise<void> {
  await deleteAdminSessionEdgeCache(c, user.uuid, previousSessionVersion);
  invalidateAdminSessionCache(user.uuid);
  const token = await generateToken(user.uuid, user.username, user.session_version, c.env);
  setAdminSessionCookie(c, token);
  clearMfaStepUpCookie(c);
}

adminRoutes.get('/account/mfa', async (c) => {
  const user = await db.getUserByUuid(getDatabase(c.env), c.get('userId')!);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  return c.json({
    enabled: Boolean(user.totp_enabled_at && user.totp_secret_enc),
    enabled_at: user.totp_enabled_at,
    recovery_codes_remaining: Array.isArray(user.recovery_code_hashes) ? user.recovery_code_hashes.length : 0,
  });
});

adminRoutes.post('/account/mfa/setup', async (c) => {
  const parsed = await readAdminJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const password = typeof parsed.body.password === 'string' ? parsed.body.password : '';
  if (!password || password.length > 4096) return c.json({ error: '当前密码无效' }, 400);

  const database = getDatabase(c.env);
  const user = await db.getUserByUuid(database, c.get('userId')!);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  const clientIp = getCloudflareClientIp(c);
  const buckets = mfaRateLimitBuckets(clientIp, user.uuid);
  const nowMs = Date.now();
  const states = await loadLoginRateLimitStates(database, buckets);
  const retryAfter = getLoginRetryAfterSeconds(states, nowMs);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ code: 'MFA_RATE_LIMITED', error: `验证尝试过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  }
  if (!await verifyPassword(password, user.passwd)) {
    const failedAt = Date.now();
    await recordLoginFailure(database, buckets, failedAt, states);
    await auditLoginFailure(database, user.username, clientIp, 'invalid_mfa_setup_password', failedAt);
    return c.json({ error: '当前密码错误' }, 401);
  }
  await clearLoginFailures(database, buckets);

  const secret = generateTotpSecret();
  const encryptedSecret = await encryptTotpSecret(secret, user.uuid, c.env);
  const setupToken = await generateMfaSetupToken({
    userId: user.uuid,
    username: user.username,
    sessionVersion: user.session_version,
    encryptedSecret,
  }, c.env);
  return c.json({
    setup_token: setupToken,
    secret,
    uri: buildTotpUri({ secret, username: user.username }),
  });
});

adminRoutes.post('/account/mfa/enable', async (c) => {
  const parsed = await readAdminJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const setupToken = typeof parsed.body.setup_token === 'string' ? parsed.body.setup_token : '';
  const code = typeof parsed.body.code === 'string' ? parsed.body.code.trim() : '';
  if (!setupToken || setupToken.length > 4096 || !/^\d{6}$/.test(code)) {
    return c.json({ error: '绑定参数无效' }, 400);
  }

  const userId = c.get('userId')!;
  const database = getDatabase(c.env);
  const user = await db.getUserByUuid(database, userId);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  const setup = await verifyMfaSetupToken(setupToken, c.env);
  if (!setup || setup.userId !== user.uuid || setup.username !== user.username || setup.sessionVersion !== user.session_version) {
    return c.json({ error: '绑定信息已失效，请重新开始' }, 401);
  }

  const clientIp = getCloudflareClientIp(c);
  const buckets = mfaRateLimitBuckets(clientIp, user.uuid);
  const nowMs = Date.now();
  const states = await loadLoginRateLimitStates(database, buckets);
  const retryAfter = getLoginRetryAfterSeconds(states, nowMs);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ code: 'MFA_RATE_LIMITED', error: `验证尝试过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  }

  const secret = await decryptTotpSecret(setup.encryptedSecret, user.uuid, c.env);
  const result = await verifyTotpCode(secret, code);
  if (!result.valid || result.step === undefined) {
    const failedAt = Date.now();
    await recordLoginFailure(database, buckets, failedAt, states);
    await auditLoginFailure(database, user.username, clientIp, 'invalid_mfa_enrollment_code', failedAt);
    return c.json({ error: '验证码无效，请确认服务器时间准确' }, 401);
  }
  await clearLoginFailures(database, buckets);

  const recovery = await generateRecoveryCodes(c.env);
  const updated = await db.enableUserTotp(
    database,
    user.uuid,
    setup.encryptedSecret,
    recovery.hashes,
    result.step,
  );
  if (!updated) return c.json({ error: '用户不存在' }, 404);
  await replaceRotatedAdminSession(c, user.session_version, updated);
  await db.insertAuditLog(database, user.username, 'mfa_enabled', '启用 TOTP 双重身份验证', 'warning');
  return c.json({ success: true, recovery_codes: recovery.codes });
});

adminRoutes.post('/account/mfa/recovery-codes', async (c) => {
  const database = getDatabase(c.env);
  const user = await db.getUserByUuid(database, c.get('userId')!);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  if (!user.totp_enabled_at) return c.json({ error: '尚未启用双重身份验证' }, 409);

  const recovery = await generateRecoveryCodes(c.env);
  const updated = await db.replaceUserRecoveryCodes(database, user.uuid, recovery.hashes);
  if (!updated) return c.json({ error: '无法更新恢复码' }, 409);
  await replaceRotatedAdminSession(c, user.session_version, updated);
  await db.insertAuditLog(database, user.username, 'mfa_recovery_codes_regenerated', '重新生成恢复码', 'warning');
  return c.json({ success: true, recovery_codes: recovery.codes });
});

adminRoutes.post('/account/mfa/disable', async (c) => {
  const database = getDatabase(c.env);
  const user = await db.getUserByUuid(database, c.get('userId')!);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  if (!user.totp_enabled_at) return c.json({ success: true });

  const updated = await db.disableUserTotp(database, user.uuid);
  if (!updated) return c.json({ error: '用户不存在' }, 404);
  await replaceRotatedAdminSession(c, user.session_version, updated);
  await db.insertAuditLog(database, user.username, 'mfa_disabled', '关闭 TOTP 双重身份验证', 'warning');
  return c.json({ success: true });
});

adminRoutes.post('/account/mfa/step-up', async (c) => {
  const parsed = await readAdminJsonObject(c);
  if (!parsed.ok) return parsed.response;
  const method = readMfaMethod(parsed.body.method);
  const code = typeof parsed.body.code === 'string' ? parsed.body.code.trim() : '';
  if (!method || !code || code.length > 128) {
    return c.json({ code: 'MFA_INPUT_INVALID', error: '双重身份验证参数无效' }, 400);
  }

  const database = getDatabase(c.env);
  const user = await db.getUserByUuid(database, c.get('userId')!);
  if (!user) return c.json({ error: '用户不存在' }, 404);
  if (!user.totp_enabled_at || !user.totp_secret_enc) {
    return c.json({ error: '尚未启用双重身份验证' }, 409);
  }

  const clientIp = getCloudflareClientIp(c);
  const buckets = mfaRateLimitBuckets(clientIp, user.uuid);
  const nowMs = Date.now();
  const states = await loadLoginRateLimitStates(database, buckets);
  const retryAfter = getLoginRetryAfterSeconds(states, nowMs);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ code: 'MFA_RATE_LIMITED', error: `验证尝试过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  }

  let verified = false;
  try {
    verified = await verifyUserMfaFactor(database, user, method, code, c.env);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
    }
    console.error('[auth] failed to verify MFA step-up:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '双重身份验证配置损坏，请使用管理员恢复功能' }, 500);
  }
  if (!verified) {
    const failedAt = Date.now();
    await recordLoginFailure(database, buckets, failedAt, states);
    await auditLoginFailure(database, user.username, clientIp, 'invalid_mfa_step_up', failedAt);
    return c.json({ code: 'MFA_INVALID', error: '验证码或恢复码无效' }, 401);
  }

  await clearLoginFailures(database, buckets);
  const token = await generateMfaToken({
    userId: user.uuid,
    username: user.username,
    sessionVersion: user.session_version,
    purpose: 'mfa-step-up',
  }, c.env);
  setMfaStepUpCookie(c, token);
  await db.insertAuditLog(database, user.username, 'mfa_step_up', '完成敏感操作二次确认');
  return c.json({ success: true, expires_in: 300 });
});
// 修改用户名
adminRoutes.post('/account/username', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const userId = c.get('userId')!;
    const oldUsername = c.get('username')!;
    const database = getDatabase(c.env);
    const nextUsername = typeof body.username === 'string' ? body.username.trim() : '';
    const usernameBytes = new TextEncoder().encode(nextUsername).byteLength;

    if (!nextUsername) {
      return c.json({ error: '用户名不能为空' }, 400);
    }

    if (usernameBytes > MAX_ADMIN_USERNAME_BYTES) {
      return c.json({ error: `用户名不能超过 ${MAX_ADMIN_USERNAME_BYTES} 字节` }, 400);
    }

    if (/[\u0000-\u001F\u007F]/.test(nextUsername)) {
      return c.json({ error: '用户名包含无效字符' }, 400);
    }

    const currentUser = await db.getUserByUuid(database, userId);
    if (!currentUser) {
      return c.json({ error: '用户不存在' }, 404);
    }

    if (currentUser.username === nextUsername) {
      return c.json({
        success: true,
        user: { uuid: currentUser.uuid, username: currentUser.username },
      });
    }

    const existing = await db.getUserByUsername(database, nextUsername);
    if (existing && existing.uuid !== userId) {
      return c.json({ error: '用户名已存在' }, 409);
    }

    await deleteAdminSessionEdgeCache(c, userId, currentUser.session_version);
    const updatedUser = await db.updateUserUsernameAndRotateSession(database, userId, nextUsername);
    if (!updatedUser) {
      return c.json({ error: 'User not found' }, 404);
    }
    invalidateAdminSessionCache(userId);

    let token: string;
    try {
      token = await generateToken(updatedUser.uuid, updatedUser.username, updatedUser.session_version, c.env);
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
        return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
      }
      throw error;
    }

    setAdminSessionCookie(c, token);
    clearMfaStepUpCookie(c);
    await db.insertAuditLog(database, oldUsername, 'account_username_edit', `修改用户名: ${oldUsername} -> ${nextUsername}`);

    return c.json({
      success: true,
      user: { uuid: userId, username: nextUsername },
    });
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      return c.json({ error: '用户名已存在' }, 409);
    }
    return c.json({ error: '修改用户名失败' }, 500);
  }
});

// 修改密码
adminRoutes.post('/account/chpasswd', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const userId = c.get('userId')!;
    const username = c.get('username')!;
    const database = getDatabase(c.env);
    const user = await db.getUserByUsername(database, username);

    if (typeof body.old_password !== 'string' || typeof body.new_password !== 'string') {
      return c.json({ error: '密码格式错误' }, 400);
    }

    const strengthError = validateAdminPasswordStrength(body.new_password, username);
    if (strengthError) {
      return c.json({ error: `新密码不符合强度要求：${strengthError}` }, 400);
    }

    if (!user) {
      return c.json({ error: '用户不存在' }, 404);
    }

    // Verify the current password before replacing it.
    const valid = await verifyPassword(body.old_password, user.passwd);
    if (!valid) {
      return c.json({ error: '旧密码错误' }, 400);
    }

    const newHash = await hashPassword(body.new_password);
    const updatedUser = await db.updateUserPasswordAndRotateSession(database, userId, newHash);
    if (!updatedUser) {
      return c.json({ error: '用户不存在' }, 404);
    }
    invalidateAdminSessionCache(userId);

    let token: string;
    try {
      token = await generateToken(updatedUser.uuid, updatedUser.username, updatedUser.session_version, c.env);
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
        return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
      }
      throw error;
    }
    setAdminSessionCookie(c, token);
    clearMfaStepUpCookie(c);
    await db.insertAuditLog(database, username, 'chpasswd', '修改密码');

    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: '修改失败' }, 500);
  }
});

// ============ 审计日志 ============

adminRoutes.get('/logs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100');
  const page = parseInt(c.req.query('page') || '1');
  const database = getDatabase(c.env);
  const logs = await db.listAuditLogsPaged(database, page, Math.min(limit, 500));
  return c.json({
    data: logs.logs,
    total: logs.total,
    has_more: logs.has_more,
    page: Math.max(1, page),
    limit: Math.min(limit, 500),
  });
});

adminRoutes.get('/health', async (c) => {
  const deep = isQueryFlagEnabled(c.req.query('deep')) || isQueryFlagEnabled(c.req.query('refresh'));
  if (!deep && healthCheckCache && healthCheckCache.expiresAt > Date.now()) {
    c.header('X-CF-VPS-Monitor-Health-Cache', 'hit');
    return c.json({ ...healthCheckCache.value, cache: 'hit' }, healthCheckCache.status);
  }

  const result = await buildHealthCheck(c, deep, deep ? 'refresh' : 'miss');
  c.header('X-CF-VPS-Monitor-Health-Cache', result.body.cache);
  if (!deep) {
    healthCheckCache = {
      value: result.body,
      status: result.status,
      expiresAt: Date.now() + HEALTH_CACHE_MS,
    };
  }
  return c.json(result.body, result.status);
});

adminRoutes.get('/capacity', async (c) => {
  const forceCounts = c.req.query('refresh_counts') === 'true' || c.req.query('refresh_counts') === '1';
  const database = getDatabase(c.env);
  return c.json(await buildCapacityEstimate(database, { forceCounts }));
});

adminRoutes.post('/maintenance/cleanup', async (c) => {
  try {
    const database = getDatabase(c.env);
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const result = await runMaintenanceCleanup(database, c.get('username')!);
    invalidateCapacityEstimateCache();
    return c.json(result);
  } catch (error) {
    const database = getDatabase(c.env);
    await db.insertAuditLog(database, c.get('username')!, 'maintenance_cleanup_error', `手动维护清理失败: ${errorDetail(error)}`, 'error');
    return c.json({ error: '维护清理失败' }, 500);
  }
});

// ============ 备份相关 ============

// 下载加密完整备份（包含配置和 token，不包含账号、审计和历史记录）
adminRoutes.post('/download/backup', async (c) => {
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const backupPassword = typeof body.backup_password === 'string' ? body.backup_password : '';
    const database = getDatabase(c.env);
    const backup = await buildBackupSnapshot(database);
    const encrypted = await encryptBackup(backup, backupPassword);
    if (!encrypted.ok) {
      return c.json({ error: encrypted.error }, 400);
    }

    await db.insertAuditLog(
      database,
      c.get('username')!,
      'backup_download',
      `下载加密完整备份: ${JSON.stringify({
        ...summarizeBackup(backup),
        encrypted: true,
        contains_sensitive_fields_after_decrypt: true,
        encryption: BACKUP_ENCRYPTION_ALGORITHM,
      })}`,
    );

    const date = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(encrypted.encryptedBackup, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="cf-monitor-encrypted-backup-${date}.json"`,
        'X-CF-VPS-Monitor-Backup-Schema': ENCRYPTED_BACKUP_SCHEMA_ID,
        'X-CF-VPS-Monitor-Backup-Scope': BACKUP_SCOPE,
        'X-CF-VPS-Monitor-Backup-Encrypted': 'true',
      },
    });
  } catch (error) {
    console.error('[backup] download failed:', sanitizeSetupDiagnosticDetail(error));
    return c.json({ error: '备份失败' }, 500);
  }
});

// 上传备份恢复
adminRoutes.post('/upload/backup', async (c) => {
  try {
    const contentLength = Number(c.req.header('Content-Length') || '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_BACKUP_BYTES) {
      return c.json({ error: `备份文件不能超过 ${MAX_BACKUP_BYTES} 字节` }, 413);
    }

    const bodyResult = await readAdminBackupJsonObject(c);
    if (!bodyResult.ok) return bodyResult.response;
    const { body } = bodyResult;

    if (jsonSizeBytes(body) > MAX_BACKUP_BYTES) {
      return c.json({ error: `备份文件不能超过 ${MAX_BACKUP_BYTES} 字节` }, 413);
    }

    const dryRun = isQueryFlagEnabled(c.req.query('dry_run'));
    const confirmation = getRestoreConfirmationState(c, body);
    if (!dryRun && !confirmation.confirmed) {
      return c.json({
        error: '恢复备份需要同时确认 confirm_restore=true 和 acknowledge_overwrite=true',
        required: {
          confirm_restore: true,
          acknowledge_overwrite: true,
        },
        received: {
          confirm_restore: confirmation.confirmRestore,
          acknowledge_overwrite: confirmation.acknowledgeOverwrite,
        },
      }, 400);
    }
    let backupInput: unknown = body;
    const wrappedBackup = body.backup;
    const encryptedBackup = isEncryptedBackupEnvelope(wrappedBackup) ? wrappedBackup : body;
    if (!isEncryptedBackupEnvelope(encryptedBackup)) {
      return c.json({ error: '只支持导入加密完整备份，不支持明文备份文件' }, 400);
    }
    const backupPassword = typeof body.backup_password === 'string'
      ? body.backup_password
      : c.req.header('X-Backup-Password') || '';
    const decrypted = await decryptBackup(encryptedBackup, backupPassword);
    if (!decrypted.ok) {
      return c.json({ error: decrypted.error }, 400);
    }
    backupInput = decrypted.backup;

    const validated = validateBackup(backupInput);
    if (!validated.ok) {
      return c.json({ error: '备份校验失败', details: validated.errors }, 400);
    }

    const restored = summarizeBackup(validated.backup);
    if (dryRun) {
      return c.json({
        success: true,
        dry_run: true,
        restored,
        warnings: validated.warnings,
      });
    }

    const database = getDatabase(c.env);
    const beforeRestore = await buildBackupSnapshot(database);
    await db.restoreBackupData(database, validated.backup);
    const cleanup = await db.cleanupOrphanClientData(database);
    invalidateAdminClientsCache();
    invalidateAdminPingTasksCache();
    purgeAdminPingTasksEdgeCache(c);
    void purgeAdminClientsEdgeCache(c);
    invalidateAdminPublicMetadata(c);
    invalidateAgentClientAuthCache();
    invalidateAgentPingTaskCache();
    invalidateAllowedClientIdsCache();
    invalidateCapacityEstimateCache();
    await refreshLivePingTasks(c);

    await db.insertAuditLog(
      database,
      c.get('username')!,
      'backup_restore',
      `恢复备份: ${JSON.stringify({
        restored,
        previous: summarizeBackup(beforeRestore),
        cleanup,
        warnings: validated.warnings.length,
        operator_ip: getRequestIp(c),
        backup_size_bytes: jsonSizeBytes(validated.backup),
        encrypted: true,
        plaintext_backup_supported: false,
        confirmed: {
          confirm_restore: confirmation.confirmRestore,
          acknowledge_overwrite: confirmation.acknowledgeOverwrite,
        },
      })}`,
    );
    return c.json({
      success: true,
      restored,
      cleanup,
      warnings: validated.warnings,
    });
  } catch {
    return c.json({ error: '恢复失败' }, 500);
  }
});

// ============ 测试 ============

// 测试发送消息
adminRoutes.post('/test/sendMessage', async (c) => {
  const database = getDatabase(c.env);
  let selectedChannel = 'telegram';
  try {
    const parsed = await readAdminJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const message = typeof body.message === 'string' && body.message.trim() !== ''
      ? body.message.trim()
      : 'CF VPS Monitor 测试消息';
    const requestedChannel = typeof body.channel === 'string' && body.channel.trim() !== ''
      ? body.channel.trim()
      : undefined;
    const adminSettings = buildAdminSettings(await db.getSettingsByKeys(database, [...NOTIFICATION_DISPATCH_SETTING_KEYS]));
    selectedChannel = requestedChannel || adminSettings.notification_method;
    if (!['telegram', 'email', 'webhook', 'none'].includes(selectedChannel)) {
      return c.json({ error: '未知通知方式' }, 400);
    }
    const maxMessageChars = selectedChannel === 'email'
      ? EMAIL_MESSAGE_MAX_CHARS
      : selectedChannel === 'webhook'
        ? WEBHOOK_MESSAGE_MAX_CHARS
        : TELEGRAM_MESSAGE_MAX_CHARS;
    if (selectedChannel !== 'none' && message.length > maxMessageChars) {
      return c.json({ error: `测试消息不能超过 ${maxMessageChars} 个字符` }, 400);
    }

    if (selectedChannel === 'email' && typeof body.test_recipient === 'string' && body.test_recipient.trim() !== '') {
      adminSettings.email_smtp_recipients = body.test_recipient.trim();
    }
    const sent = await dispatchNotification(database, adminSettings, {
      subject: selectedChannel === 'email' ? 'CF VPS Monitor 测试邮件' : 'CF VPS Monitor 测试消息',
      body: message,
    }, {
      channel: selectedChannel,
      auditUser: c.get('username') || 'system',
      deps: { recordHealth: bestEffortRecordHealthEvent },
    });
    if (!sent) {
      return c.json({
        success: false,
        error: selectedChannel === 'none' ? '通知方式为 None，未发送测试消息' : '测试消息发送失败，请检查通知配置',
      }, selectedChannel === 'none' ? 400 : 502);
    }
    return c.json({ success: true });
  } catch (e: unknown) {
    const component = selectedChannel === 'email' || selectedChannel === 'webhook' || selectedChannel === 'telegram'
      ? selectedChannel
      : 'notification';
    await bestEffortRecordHealthEvent(
      database,
      component,
      'error',
      `${selectedChannel} test failed: ${errorDetail(e)}`,
      { auditAction: `${component}_error`, auditUser: c.get('username') || 'system' },
    );
    return c.json({ error: '发送测试消息失败' }, 500);
  }
});

export { adminRoutes };
