/**
 * CF VPS Monitor - Cloudflare Worker 监控系统
 * 使用 Hono 框架 + Supabase HTTP API/RPC + Durable Objects
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { APP_VERSION } from './utils/app-version';
import { shortGitSha } from './utils/update-check';

// 路由模块
import { publicRoutes } from './routes/public';
import { adminRoutes } from './routes/admin';
import { adminThemeRoutes, publicThemeRoutes } from './routes/theme';
import { clientRoutes } from './routes/client';
import { wsRoutes } from './routes/websocket';
import { setupRoutes } from './routes/setup';
import * as db from './db/queries';
import { DatabaseConfigurationError, getDatabase, withDatabase } from './db/provider';
import { validateAdminSession } from './auth/admin-session';
import { AuthConfigurationError, verifyAdminToken, type AdminJwtPayload } from './auth/jwt';
import { isMfaStepUpProtectedRequest } from './auth/mfa-policy';
import { verifyMfaToken } from './auth/mfa-token';
import { getAdminSessionToken, getMfaStepUpToken, verifyAdminCsrfToken } from './auth/session';
import { buildAdminSettings } from './settings/schema';
import { bestEffortRecordHealthEvent, errorDetail } from './utils/observability';
import { NOTIFICATION_DISPATCH_SETTING_KEYS, dispatchNotification } from './utils/notification-dispatch';
import { clearScheduledDatabaseStartupFailure, recordScheduledDatabaseStartupFailure } from './utils/scheduled-observability';
import { sanitizeSetupDiagnosticDetail } from './utils/setup-diagnostics';
import { getCloudflareClientIp } from './utils/request-ip';
import {
  checkWebsiteMonitorHttp,
  shouldNotifyWebsiteDown,
  shouldNotifyWebsiteRecovery,
} from './utils/website-monitor';
import {
  buildExpiryNotification,
  buildLoadNotification,
  buildNodeRecoveryNotification,
  buildOfflineNotification,
  buildWebsiteAlertNotification,
  buildWebsiteRecoveryNotification,
  type NotificationMessage,
} from './utils/notification-templates';
import { evaluateOfflineNotificationEvent } from './utils/offline-notification';
import type {
  Client as MonitorClient,
  ExpiryNotification,
  LoadNotification,
  OfflineNotification,
  ScheduledClientRow,
} from './db/queries';

type RuntimeBindings = {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  JWT_SECRET?: string;
  SETUP_DIAGNOSTICS_ENABLED?: string;
  CURRENT_GIT_COMMIT?: string;
};

// Wrangler owns configured bindings; this adds runtime-only optional values.
export type Bindings = Env & RuntimeBindings;

export type Variables = {
  userId: string;
  username: string;
  clientUuid?: string;
  clientName?: string;
  clientHidden?: boolean;
  clientRecord?: MonitorClient;
  agentTokenKey?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const BUNDLED_VERSION = APP_VERSION;
const CSRF_REJECTION_AUDIT_THROTTLE_MS = 60_000;
const CSRF_REJECTION_AUDIT_THROTTLE_MAX_ENTRIES = 512;
const ADMIN_SESSION_EDGE_CACHE_SECONDS = 30;
const RECORD_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RECORD_CLEANUP_LAST_RUN_KEY = 'maintenance_last_cleanup_at';
const csrfRejectionAuditThrottle = new Map<string, { expiresAt: number }>();

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: https:; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};

function withSecurityHeaders(headers: HeadersInit = {}): Headers {
  const nextHeaders = new Headers(headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    nextHeaders.set(name, value);
  }
  return nextHeaders;
}

function databaseStartupErrorResponse(request: Request, error: unknown): Response {
  const url = new URL(request.url);
  const detail = sanitizeSetupDiagnosticDetail(error);
  const bootstrapRunning = /schema bootstrap is still running/i.test(detail);
  const status = bootstrapRunning ? 202 : error instanceof DatabaseConfigurationError ? 503 : 500;
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({
      error: bootstrapRunning ? 'Database bootstrap is still running' : 'Database is not ready',
      detail,
      setup: '/setup',
    }), {
      status,
      headers: withSecurityHeaders({
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(bootstrapRunning ? {
          'Retry-After': '1',
          'X-CF-VPS-Monitor-Bootstrap': 'running',
        } : {}),
      }),
    });
  }
  return new Response(`Database is not ready: ${detail}`, {
    status,
    headers: withSecurityHeaders({
      'Cache-Control': 'no-store',
      ...(bootstrapRunning ? {
        'Retry-After': '1',
        'X-CF-VPS-Monitor-Bootstrap': 'running',
      } : {}),
    }),
  });
}

function canServeWithoutDatabaseStartup(pathname: string): boolean {
  return pathname === '/db-init' ||
    pathname === '/assets/' ||
    pathname.startsWith('/assets/') ||
    pathname === '/favicon.ico' ||
    pathname === '/favicon-16x16.png' ||
    pathname === '/favicon-32x32.png' ||
    pathname === '/apple-touch-icon.png' ||
    pathname === '/app-icon.png' ||
    pathname === '/ping' ||
    pathname === '/api/setup/status' ||
    pathname === '/api/setup/database/init' ||
    pathname === '/api/version' ||
    pathname === '/agent/install.sh' ||
    pathname === '/agent/install-linux.sh' ||
    pathname === '/agent/install-windows.ps1' ||
    pathname === '/api/login' ||
    pathname === '/api/login/mfa' ||
    pathname === '/api/logout' ||
    pathname === '/api/me' ||
    pathname === '/api/clients' ||
    pathname.startsWith('/api/clients/') ||
    pathname === '/api/nodes' ||
    pathname === '/api/public' ||
    pathname === '/api/public/bootstrap' ||
    pathname === '/api/site-logo' ||
    pathname === '/api/task/ping' ||
    pathname.startsWith('/api/records/') ||
    pathname.startsWith('/api/recent/') ||
    pathname === '/api/websites' ||
    pathname.startsWith('/api/websites/') ||
    pathname === '/api/theme/active.css' ||
    pathname.startsWith('/api/theme/assets/') ||
    pathname.startsWith('/api/theme/manifest/') ||
    pathname === '/api/live' ||
    pathname === '/api/live/clients' ||
    pathname === '/api/ws/live' ||
    pathname === '/api/ws/live-token' ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/');
}

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

function requestIp(c: AppContext): string {
  return getCloudflareClientIp(c);
}

function isSafeMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method);
}

function adminSessionEdgeCacheRequest(payload: AdminJwtPayload): Request {
  return new Request(
    `https://cf-monitor.internal/cache/admin-session/${encodeURIComponent(payload.userId)}/${payload.sessionVersion}`,
    { method: 'GET' },
  );
}

async function getAdminSessionEdgeCache(payload: AdminJwtPayload): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    return Boolean(await caches.default.match(adminSessionEdgeCacheRequest(payload)));
  } catch {
    return false;
  }
}

function putAdminSessionEdgeCache(c: AppContext, payload: AdminJwtPayload): void {
  if (typeof caches === 'undefined') return;
  const response = new Response('1', {
    headers: {
      'Cache-Control': `public, max-age=${ADMIN_SESSION_EDGE_CACHE_SECONDS}`,
    },
  });
  const task = caches.default.put(adminSessionEdgeCacheRequest(payload), response).catch(() => undefined);
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(task);
  else void task;
}

function csrfRejectionAuditKey(username: string, ip: string, path: string): string {
  return `${username}:${ip}:${path}`;
}

export function resetCsrfRejectionAuditThrottleForTests(): void {
  csrfRejectionAuditThrottle.clear();
}

export async function auditCsrfRejection(
  database: db.QueryDatabase,
  username: string,
  ip: string,
  path: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const key = csrfRejectionAuditKey(username, ip, path);
  const existing = csrfRejectionAuditThrottle.get(key);
  if (existing && existing.expiresAt > nowMs) return false;

  if (csrfRejectionAuditThrottle.size >= CSRF_REJECTION_AUDIT_THROTTLE_MAX_ENTRIES) {
    for (const [entryKey, entry] of csrfRejectionAuditThrottle) {
      if (entry.expiresAt <= nowMs || csrfRejectionAuditThrottle.size >= CSRF_REJECTION_AUDIT_THROTTLE_MAX_ENTRIES) {
        csrfRejectionAuditThrottle.delete(entryKey);
      }
      if (csrfRejectionAuditThrottle.size < CSRF_REJECTION_AUDIT_THROTTLE_MAX_ENTRIES) break;
    }
  }

  csrfRejectionAuditThrottle.set(key, {
    expiresAt: nowMs + CSRF_REJECTION_AUDIT_THROTTLE_MS,
  });
  await db.insertAuditLog(
    database,
    username,
    'csrf_rejected',
    `拒绝缺少或无效 CSRF token 的管理写请求: ${path}; ip=${ip}`,
    'warning',
  );
  return true;
}

async function requireMfaStepUp(
  c: AppContext,
  database: db.QueryDatabase,
  payload: AdminJwtPayload,
): Promise<Response | null> {
  const pathname = new URL(c.req.url).pathname;
  if (!isMfaStepUpProtectedRequest(c.req.method, pathname)) return null;

  const user = await db.getUserByUuid(database, payload.userId);
  if (!user || user.username !== payload.username || user.session_version !== payload.sessionVersion) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!user.totp_enabled_at || !user.totp_secret_enc) return null;

  const token = getMfaStepUpToken(c);
  let stepUp = null;
  try {
    stepUp = token ? await verifyMfaToken(token, 'mfa-step-up', c.env) : null;
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return c.json({ error: 'Server authentication is not configured' }, 500);
    }
    throw error;
  }
  if (
    !stepUp ||
    stepUp.userId !== user.uuid ||
    stepUp.username !== user.username ||
    stepUp.sessionVersion !== user.session_version
  ) {
    return c.json({
      code: 'MFA_STEP_UP_REQUIRED',
      error: '需要双重身份验证确认',
    }, 428);
  }
  return null;
}
app.use('*', async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    c.header(name, value);
  }
});

// API 路由 - 无缓存
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
  return undefined;
});

app.get('/agent/install.sh', (c) => c.redirect('https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/main/agent/install.sh', 302));
app.get('/agent/install-linux.sh', (c) => c.redirect('https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/main/agent/install-linux.sh', 302));
app.get('/agent/install-windows.ps1', (c) => c.redirect('https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/main/agent/install-windows.ps1', 302));

// 公开 API，无认证
app.route('/api/setup', setupRoutes);
app.route('/api/theme', publicThemeRoutes);
app.route('/api', publicRoutes);

// Agent 上报 API，Token 认证
app.route('/api/clients', clientRoutes);

// WebSocket 路由
app.route('/api', wsRoutes);

// 管理员 API，JWT 认证
app.use('/api/admin/*', async (c, next): Promise<Response | undefined> => {
  const token = getAdminSessionToken(c);
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await verifyAdminToken(token, c.env);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
      return c.json({ error: 'Server authentication is not configured' }, 500);
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const safeMethod = isSafeMethod(c.req.method);
  if (await getAdminSessionEdgeCache(payload)) {
    c.set('userId', payload.userId);
    c.set('username', payload.username);
    if (!safeMethod && !verifyAdminCsrfToken(c)) {
      return c.json({ error: 'CSRF token 无效，请刷新页面后重试' }, 403);
    }
    if (!safeMethod) {
      return withDatabase(c.env, async (database) => {
        const stepUpResponse = await requireMfaStepUp(c, database, payload);
        if (stepUpResponse) return stepUpResponse;
        await next();
        return undefined;
      });
    }
    await next();
    return undefined;
  }

  return withDatabase(c.env, async (database) => {
    const sessionUser = await validateAdminSession(database, payload);
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('userId', sessionUser.uuid);
    c.set('username', sessionUser.username);
    putAdminSessionEdgeCache(c, payload);
    if (!safeMethod && !verifyAdminCsrfToken(c)) {
      try {
        const path = new URL(c.req.url).pathname;
        await auditCsrfRejection(database, sessionUser.username, requestIp(c), path);
      } catch {
        // Keep CSRF rejection independent from audit logging availability.
      }
      return c.json({ error: 'CSRF token 无效，请刷新页面后重试' }, 403);
    }
    if (!safeMethod) {
      const stepUpResponse = await requireMfaStepUp(c, database, payload);
      if (stepUpResponse) return stepUpResponse;
    }
    await next();
    return undefined;
  });
});

app.route('/api/admin/themes', adminThemeRoutes);
app.route('/api/admin', adminRoutes);

// 管理员手动触发维护任务，用于本地开发和部署后自检。
app.post('/api/admin/cron/run', async (c) => {
  await runScheduled(c.env);
  return c.json({ success: true });
});

// 健康检查
app.get('/ping', (c) => c.text('pong'));

// 版本信息：面板版本固定为本次部署包内版本，不跟随 GitHub 最新 release 自动变化。
app.get('/api/version', (c) => {
  const appVersion = BUNDLED_VERSION;
  const gitCommit = shortGitSha(c.env.CURRENT_GIT_COMMIT);
  return c.json({
    version: appVersion,
    name: 'CF VPS Monitor',
    hash: gitCommit || 'dev',
    build: gitCommit || `release-${appVersion}`,
  });
});

// 404 处理
// 前端静态资源由 wrangler.toml 的 [assets] 托管；
// 非 API 路由的 SPA fallback 也由 Workers Static Assets 接管。
app.notFound((c) => {
  const url = new URL(c.req.url);
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/ping') {
    return c.text('CF VPS Monitor frontend asset not found. Run `npm run build` in ../frontend and check [assets] in worker/wrangler.toml.', 404);
  }
  return c.json({ error: 'Not Found' }, 404);
});

type ScheduledSettings = Record<string, string>;
type ScheduledAdminSettings = ReturnType<typeof buildAdminSettings>;
type ScheduledMonitorClient = ScheduledClientRow;
const SCHEDULED_SETTING_KEYS = [
  ...NOTIFICATION_DISPATCH_SETTING_KEYS,
  'record_preserve_time',
  'ping_record_preserve_time',
  'audit_log_preserve_time',
  'offline_notify_never_reported',
  RECORD_CLEANUP_LAST_RUN_KEY,
];

interface ScheduledRunContext {
  database: db.QueryDatabase;
  getSettings(): Promise<ScheduledSettings>;
  getAdminSettings(): Promise<ScheduledAdminSettings>;
  getClients(clientIds?: string[]): Promise<ScheduledMonitorClient[]>;
}

function normalizeScheduledClientIds(clientIds: string[] | undefined): string[] | null {
  if (clientIds === undefined) return null;
  return [...new Set(
    clientIds
      .filter((clientId): clientId is string => typeof clientId === 'string')
      .map(clientId => clientId.trim())
      .filter(Boolean),
  )].sort();
}

export function createScheduledRunContext(env: Bindings): ScheduledRunContext {
  const database = getDatabase(env);
  let settingsPromise: Promise<ScheduledSettings> | null = null;
  let adminSettingsPromise: Promise<ScheduledAdminSettings> | null = null;
  let clientsPromise: Promise<ScheduledMonitorClient[]> | null = null;
  const clientsByIdsPromises = new Map<string, Promise<ScheduledMonitorClient[]>>();

  return {
    database,
    getSettings() {
      settingsPromise ||= db.getSettingsByKeys(database, SCHEDULED_SETTING_KEYS, true);
      return settingsPromise;
    },
    getAdminSettings() {
      adminSettingsPromise ||= this.getSettings().then(settings => buildAdminSettings(settings));
      return adminSettingsPromise;
    },
    getClients(clientIds) {
      const normalizedIds = normalizeScheduledClientIds(clientIds);
      if (normalizedIds === null) {
        clientsPromise ||= db.listScheduledClientRows(database);
        return clientsPromise;
      }
      if (normalizedIds.length === 0) {
        return Promise.resolve([]);
      }
      if (clientsPromise) {
        const idSet = new Set(normalizedIds);
        return clientsPromise.then(clients => clients.filter(client => idSet.has(client.uuid)));
      }
      const cacheKey = normalizedIds.join('\0');
      let promise = clientsByIdsPromises.get(cacheKey);
      if (!promise) {
        promise = db.getScheduledClientRowsByIds(database, normalizedIds);
        clientsByIdsPromises.set(cacheKey, promise);
      }
      return promise;
    },
  };
}

async function sendNotification(context: ScheduledRunContext, notification: NotificationMessage): Promise<boolean> {
  const settings = await context.getAdminSettings();
  return dispatchNotification(context.database, settings, notification, {
    deps: { recordHealth: bestEffortRecordHealthEvent },
  });
}

async function runRecordCleanup(context: ScheduledRunContext, now: Date): Promise<void> {
  const settings = await context.getSettings();
  const lastCleanupAt = Date.parse(settings[RECORD_CLEANUP_LAST_RUN_KEY] || '');
  if (Number.isFinite(lastCleanupAt) && now.getTime() - lastCleanupAt < RECORD_CLEANUP_INTERVAL_MS) {
    return;
  }
  const recordHours = Math.min(72, Math.max(1, Number(settings['record_preserve_time'] || 72)));
  const pingHours = Math.min(72, Math.max(1, Number(settings['ping_record_preserve_time'] || recordHours)));
  const auditHours = Math.max(24, Number(settings['audit_log_preserve_time'] || 2160));

  const recordBefore = new Date(now.getTime() - recordHours * 60 * 60 * 1000).toISOString();
  const pingBefore = new Date(now.getTime() - pingHours * 60 * 60 * 1000).toISOString();
  const auditBefore = new Date(now.getTime() - auditHours * 60 * 60 * 1000).toISOString();

  const recordDeleted = await db.deleteOldRecords(context.database, recordBefore);
  const websiteDeleted = await db.deleteOldWebsiteChecks(context.database, recordBefore);
  const pingDeleted = await db.deleteOldPingRecords(context.database, pingBefore);
  const auditDeleted = await db.deleteOldAuditLogs(context.database, auditBefore);
  const deleted = {
    ...recordDeleted,
    ...websiteDeleted,
    ...pingDeleted,
    ...auditDeleted,
  };
  await db.setSetting(context.database, RECORD_CLEANUP_LAST_RUN_KEY, now.toISOString());
  const deletedRows = Object.values(deleted).reduce((sum, value) => sum + Number(value || 0), 0);
  if (deletedRows === 0) {
    return;
  }
  await db.insertAuditLog(context.database, 'system', 'cron_cleanup', `分批清理完成: ${JSON.stringify({
    before: {
      records: recordBefore,
      ping_records: pingBefore,
      audit_logs: auditBefore,
    },
    deleted,
  })}`);
}

async function runOfflineCheck(context: ScheduledRunContext, now: Date): Promise<void> {
  const notifications = await db.listOfflineNotifications(context.database, true);
  const enabled: OfflineNotification[] = notifications.filter(item => item.enable);
  if (enabled.length === 0) return;

  const settings = await context.getAdminSettings();
  const notifyNeverReported = settings.offline_notify_never_reported !== 'false';

  const clients = await context.getClients(enabled.map(item => item.client));
  const clientMap = new Map(clients.map(client => [client.uuid, client]));
  const latestTimes = await db.getLatestRecordTimesForClients(
    context.database,
    enabled.map(item => item.client),
  );
  const latestMap = new Map(latestTimes.map(row => [row.client, row.last_time]));

  for (const item of enabled) {
    const client = clientMap.get(item.client);
    if (!client) continue;

    const gracePeriod = Math.max(30, Number(item.grace_period || 180));
    const event = evaluateOfflineNotificationEvent({
      now,
      clientCreatedAt: client.created_at,
      lastTime: latestMap.get(item.client),
      lastNotified: item.last_notified,
      gracePeriodSec: gracePeriod,
      notifyNeverReported,
    });
    if (!event) continue;

    if (event.type === 'offline') {
      const sent = await sendNotification(context, buildOfflineNotification({
        nodeName: client.name || client.uuid,
        offlineMinutes: Math.floor(event.offlineMs / 60000),
        lastSeen: event.lastSeenLabel,
        createdAt: event.createdAt,
        eventTime: now,
      }));
      await db.markOfflineNotificationSent(context.database, item.client, now.toISOString());
      await db.insertAuditLog(context.database, 'system', 'offline_notify', `${sent ? '已发送' : '已记录'}离线告警: ${client.name || client.uuid}${event.neverReported ? ' (从未上报)' : ''}`);
      continue;
    }

    const sent = await sendNotification(context, buildNodeRecoveryNotification({
      nodeName: client.name || client.uuid,
      recoveredAt: event.recoveredAt,
      eventTime: now,
    }));
    await db.markOfflineNotificationSent(context.database, item.client, null);
    await db.insertAuditLog(context.database, 'system', 'online_notify', `${sent ? '已发送' : '已记录'}恢复上线: ${client.name || client.uuid}`);
  }
}

export function shouldSendExpiryNotification(args: {
  now: Date;
  expiredAt: string | null | undefined;
  advanceDays: number;
  lastNotified: string | null | undefined;
}): { daysLeft: number; expiredAt: string } | null {
  if (!args.expiredAt) return null;
  const expiryMs = new Date(args.expiredAt).getTime();
  const nowMs = args.now.getTime();
  if (Number.isNaN(expiryMs) || expiryMs < nowMs) return null;

  const advanceMs = Math.max(1, Number(args.advanceDays || 7)) * 24 * 60 * 60 * 1000;
  const windowStartMs = expiryMs - advanceMs;
  if (nowMs < windowStartMs) return null;

  const lastNotifiedMs = args.lastNotified ? new Date(args.lastNotified).getTime() : 0;
  if (!Number.isNaN(lastNotifiedMs) && lastNotifiedMs >= windowStartMs) return null;

  return {
    daysLeft: Math.max(0, Math.ceil((expiryMs - nowMs) / (24 * 60 * 60 * 1000))),
    expiredAt: new Date(expiryMs).toISOString(),
  };
}

async function runExpiryCheck(context: ScheduledRunContext, now: Date): Promise<void> {
  const notifications = await db.listExpiryNotifications(context.database, true);
  const enabled: ExpiryNotification[] = notifications.filter(item => item.enable);
  if (enabled.length === 0) return;

  const clients = await context.getClients(enabled.map(item => item.client));
  const clientMap = new Map(clients.map(client => [client.uuid, client]));

  for (const item of enabled) {
    const client = clientMap.get(item.client);
    if (!client) continue;

    const candidate = shouldSendExpiryNotification({
      now,
      expiredAt: client.expired_at,
      advanceDays: Number(item.advance_days || 7),
      lastNotified: item.last_notified,
    });
    if (!candidate) continue;

    const message = buildExpiryNotification({
      nodeName: client.name || client.uuid,
      expiredAt: candidate.expiredAt,
      daysLeft: candidate.daysLeft,
      eventTime: now,
    });
    const sent = await sendNotification(context, message);
    await db.markExpiryNotificationSent(context.database, item.client, now.toISOString());
    await db.insertAuditLog(context.database, 'system', 'expiry_notify', `${sent ? '已发送' : '已记录'}到期提醒: ${client.name || client.uuid} - ${candidate.daysLeft} 天`);
  }
}

type LoadNotificationPlan = {
  rule: LoadNotification;
  ratio: number;
  label: string;
  targetClients: string[];
};

type LoadNotificationGroup = {
  metric: db.LoadNotificationMetric;
  threshold: number;
  startTime: string;
  endTime: string;
  clientIds: Set<string>;
  plans: LoadNotificationPlan[];
};

async function runLoadCheck(context: ScheduledRunContext, now: Date): Promise<void> {
  const notifications = await db.listLoadNotifications(context.database, true);
  if (notifications.length === 0) return;

  const hasAllClientRule = notifications.some(rule => rule.clients.length === 0);
  const scheduledClientIds = hasAllClientRule
    ? undefined
    : notifications.flatMap(rule => rule.clients);
  const clients = await context.getClients(scheduledClientIds);
  const clientMap = new Map(clients.map(c => [c.uuid, c]));
  const metricLabel: Record<string, string> = { cpu: "CPU", ram: "内存", load: "负载", disk: "磁盘", temp: "温度" };
  const groups = new Map<string, LoadNotificationGroup>();

  for (const rule of notifications) {
    const intervalMs = Math.max(1, Number(rule.interval_min || 15)) * 60 * 1000;
    const startTime = new Date(now.getTime() - intervalMs).toISOString();
    const endTime = now.toISOString();
    const threshold = Number(rule.threshold || 80);
    const ratio = Math.max(0, Math.min(1, Number(rule.ratio || 0.8)));
    const metric = rule.metric;
    const label = metricLabel[metric] || metric;
    const lastNotified = rule.last_notified ? new Date(rule.last_notified).getTime() : 0;
    if (lastNotified && now.getTime() - lastNotified < intervalMs) continue;

    const targetClients: string[] = rule.clients.length > 0
      ? rule.clients
      : clients.map(c => c.uuid);
    const uniqueTargetClients = [...new Set(targetClients)];
    if (uniqueTargetClients.length === 0) continue;

    const groupKey = `${metric}:${threshold}:${startTime}:${endTime}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        metric,
        threshold,
        startTime,
        endTime,
        clientIds: new Set<string>(),
        plans: [],
      };
      groups.set(groupKey, group);
    }
    for (const clientUuid of uniqueTargetClients) group.clientIds.add(clientUuid);
    group.plans.push({ rule, ratio, label, targetClients: uniqueTargetClients });
  }

  for (const group of groups.values()) {
    const statsByClient = await db.getLoadMetricWindowStatsForClients(
      context.database,
      [...group.clientIds],
      group.startTime,
      group.endTime,
      group.metric,
      group.threshold,
    );

    for (const plan of group.plans) {
      let notified = false;
      for (const clientUuid of plan.targetClients) {
        const client = clientMap.get(clientUuid);
        if (!client) continue;

        const stats = statsByClient.get(clientUuid) || { samples: 0, exceeded: 0, avg_value: 0 };
        if (stats.samples < 2) continue;

        const exceedRatio = stats.exceeded / stats.samples;
        if (exceedRatio < plan.ratio) continue;

        const message = buildLoadNotification({
          ruleName: plan.rule.name,
          nodeName: client.name || clientUuid,
          metricLabel: plan.label,
          avgValue: stats.avg_value,
          threshold: group.threshold,
          exceedRatio,
          requiredRatio: plan.ratio,
          eventTime: now,
        });
        const sent = await sendNotification(context, message);
        notified = true;
        await db.insertAuditLog(context.database, 'system', 'load_notify', `${sent ? '已发送' : '已记录'}负载告警: ${client.name || clientUuid} - ${plan.label}`);
      }
      if (notified && plan.rule.id != null) {
        await db.updateLoadNotification(context.database, plan.rule.id, { last_notified: now.toISOString() });
      }
    }
  }
}

async function runWebsiteMonitorChecks(context: ScheduledRunContext, now: Date): Promise<void> {
  const monitors = await db.listDueWebsiteMonitors(context.database, now.toISOString(), 50);
  for (const monitor of monitors) {
    const check = await checkWebsiteMonitorHttp(monitor);
    const updated = await db.recordWebsiteCheck(context.database, check);
    if (!updated) continue;

    if (shouldNotifyWebsiteDown(updated, now)) {
      const downSince = updated.down_since ? new Date(updated.down_since).getTime() : now.getTime();
      const downMinutes = Math.max(0, Math.floor((now.getTime() - downSince) / 60000));
      const lastStatus = updated.last_error || (updated.last_status_code ? `HTTP ${updated.last_status_code}` : 'network_error');
      const sent = await sendNotification(context, buildWebsiteAlertNotification({
        name: updated.name,
        url: updated.url,
        downMinutes,
        lastStatus,
        checkedAt: check.checked_at,
      }));
      await db.markWebsiteMonitorNotified(context.database, updated.id, now.toISOString());
      await db.insertAuditLog(context.database, 'system', 'website_down', `${sent ? '已发送' : '已记录'}网站告警: ${updated.name}`);
    }

    if (shouldNotifyWebsiteRecovery(updated)) {
      const downSince = monitor.down_since ? new Date(monitor.down_since).getTime() : now.getTime();
      const downMinutes = Math.max(0, Math.floor((now.getTime() - downSince) / 60000));
      const sent = await sendNotification(context, buildWebsiteRecoveryNotification({
        name: updated.name,
        url: updated.url,
        downMinutes,
        statusCode: updated.last_status_code,
        latencyMs: updated.last_latency_ms,
        eventTime: now,
      }));
      await db.markWebsiteMonitorNotified(context.database, updated.id, null);
      await db.insertAuditLog(context.database, 'system', 'website_recovery', `${sent ? '已发送' : '已记录'}网站恢复: ${updated.name}`);
    }
  }
}

async function runScheduledStep(
  context: ScheduledRunContext,
  component: string,
  action: string,
  label: string,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
    await bestEffortRecordHealthEvent(context.database, component, 'ok', `${label} completed`, {
      successThrottleMs: 60 * 60 * 1000,
    });
  } catch (error) {
    const message = errorDetail(error);
    console.error(`[scheduled] ${label} failed:`, message);
    await bestEffortRecordHealthEvent(
      context.database,
      component,
      'error',
      `${label} failed: ${message}`,
      { auditAction: action },
    );
  }
}

async function runScheduled(env: Bindings): Promise<void> {
  const now = new Date();
  const context = createScheduledRunContext(env);
  await runScheduledStep(context, 'cron_cleanup', 'cron_cleanup_error', '记录清理', () => runRecordCleanup(context, now));
  await runScheduledStep(context, 'cron_load', 'cron_load_error', '负载告警检查', () => runLoadCheck(context, now));
  await runScheduledStep(context, 'cron_offline', 'cron_offline_error', '离线告警检查', () => runOfflineCheck(context, now));
  await runScheduledStep(context, 'cron_expiry', 'cron_expiry_error', '到期提醒检查', () => runExpiryCheck(context, now));
  await runScheduledStep(context, 'cron_website', 'cron_website_error', '网站监控检查', () => runWebsiteMonitorChecks(context, now));
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (!canServeWithoutDatabaseStartup(url.pathname)) {
      try {
        return await withDatabase(env, async () => {
          return app.fetch(request, env, ctx);
        });
      } catch (error) {
        return databaseStartupErrorResponse(request, error);
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Bindings, _ctx: ExecutionContext) {
    try {
      await withDatabase(env, async () => {
        clearScheduledDatabaseStartupFailure();
        await runScheduled(env);
      });
    } catch (error) {
      recordScheduledDatabaseStartupFailure(error);
      console.error('[scheduled] database startup failed:', errorDetail(error));
    }
  },
};

// 导出 Durable Object
export { LiveDataDO, normalizeViewerTtlMs } from './do/live-data';
export { RateLimitDO } from './do/rate-limit';
