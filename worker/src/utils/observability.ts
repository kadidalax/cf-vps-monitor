import * as db from '../db/queries';
import { redactDatabaseSecrets, sanitizeSetupDiagnosticDetail } from './setup-diagnostics';

type HealthDatabase = db.QueryDatabase;

export type HealthStatus = 'ok' | 'warning' | 'error' | 'disabled';

export interface HealthEvent {
  component: string;
  status: HealthStatus;
  updated_at: string;
  last_success_at?: string;
  last_failure_at?: string;
  detail?: string;
  /** 由 buildHealthCheck 现算并附加；不落盘，parseHealthEvent 不会读它。 */
  stale?: boolean;
}

// 时效判定实现在 ./health-staleness.ts（无依赖，测试可直接加载）；这里转出去，
// 调用方仍从 observability 一处取健康相关的东西。
export {
  HEALTH_STALE_AFTER_MS,
  healthComponentsOk,
  isHealthEventStale,
  markStaleEvents,
} from './health-staleness.ts';

/**
 * 存储型健康组件：写入 `settings` 的 `health:<component>`，由 recordHealthEvent 落盘、
 * readHealthEvents 读回。这份清单必须与实际写入点一一对应——少一个名字，那个组件的
 * 事件就永远读不出来（写进去了但没人查），健康页会当它不存在。
 *
 * 注意不含 database_connection_probe 等「现算探针」：那些没有任何写入点，
 * 由 buildHealthCheck 在每次请求时当场算出，不走 settings。
 */
export const STORED_HEALTH_COMPONENTS = [
  'do_record_persistence',
  'ping_persistence',
  'website_probe_persistence',
  'agent_policy',
  'agent_policy_website_probe_tasks',
  'do_agent_policy',
  'do_basic_info_sync',
  'do_viewer_expiry',
  'do_live_network_metadata',
  'telegram',
  'email',
  'webhook',
  'notification',
  'cron_cleanup',
  'cron_load',
  'cron_offline',
  'cron_expiry',
  'cron_website',
] as const;

export type StoredHealthComponent = typeof STORED_HEALTH_COMPONENTS[number];

const HEALTH_KEY_PREFIX = 'health:';
const AUDIT_THROTTLE_PREFIX = 'health:audit:last:';
const DEFAULT_AUDIT_THROTTLE_MS = 5 * 60 * 1000;
const MAX_DETAIL_LENGTH = 700;
const healthSuccessThrottleCache = new Map<string, number>();

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function truncateDetail(detail: unknown): string {
  return String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);
}

function redactHealthDetail(detail: unknown): string {
  return truncateDetail(redactDatabaseSecrets(String(detail ?? '')));
}

export function errorDetail(error: unknown): string {
  return truncateDetail(sanitizeSetupDiagnosticDetail(error));
}

function healthKey(component: string): string {
  return `${HEALTH_KEY_PREFIX}${component}`;
}

function auditThrottleKey(component: string, action: string): string {
  return `${AUDIT_THROTTLE_PREFIX}${component}:${action}`;
}

function parseHealthEvent(raw: string | null, component: string): HealthEvent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HealthEvent>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      component,
      status: parsed.status === 'error' || parsed.status === 'warning' || parsed.status === 'disabled' ? parsed.status : 'ok',
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : '',
      last_success_at: typeof parsed.last_success_at === 'string' ? parsed.last_success_at : undefined,
      last_failure_at: typeof parsed.last_failure_at === 'string' ? parsed.last_failure_at : undefined,
      detail: typeof parsed.detail === 'string' ? redactHealthDetail(parsed.detail) : undefined,
    };
  } catch {
    return null;
  }
}

async function shouldWriteAuditLog(
  database: HealthDatabase,
  component: string,
  action: string,
  nowMs: number,
  throttleMs: number,
): Promise<boolean> {
  // 判断与占位必须在同一条语句里完成。拆成「读上次时间 → 判断 → 写新时间」时，
  // 两个并发请求会读到同一个旧时间戳、同时判定可写，同一条错误落两行审计日志。
  // 时间戳仍由这里的 nowMs 生成而不是服务端 now()：健康事件的其它时间戳都出自
  // Worker 时钟，混入第二套钟会让比较结果不可解释。
  return db.tryClaimAuditThrottle(
    database,
    auditThrottleKey(component, action),
    nowIso(nowMs),
    throttleMs,
  );
}

export async function recordHealthEvent(
  database: HealthDatabase | undefined,
  component: StoredHealthComponent,
  status: HealthStatus,
  detail?: unknown,
  options: {
    auditAction?: string;
    auditUser?: string;
    auditLevel?: string;
    auditThrottleMs?: number;
    successThrottleMs?: number;
    nowMs?: number;
  } = {},
): Promise<void> {
  if (!database) return;

  const nowMs = options.nowMs ?? Date.now();
  const at = nowIso(nowMs);
  if (status === 'ok' && options.successThrottleMs) {
    const cachedSuccessMs = healthSuccessThrottleCache.get(component) || 0;
    if (nowMs - cachedSuccessMs < options.successThrottleMs) {
      return;
    }
  }

  const previous = parseHealthEvent(await db.getSetting(database, healthKey(component)), component);
  if (status === 'ok' && options.successThrottleMs && previous?.status === 'ok' && previous.last_success_at) {
    const previousSuccessMs = Date.parse(previous.last_success_at);
    if (Number.isFinite(previousSuccessMs) && nowMs - previousSuccessMs < options.successThrottleMs) {
      healthSuccessThrottleCache.set(component, previousSuccessMs);
      return;
    }
  }
  const event: HealthEvent = {
    component,
    status,
    updated_at: at,
    last_success_at: status === 'ok' ? at : previous?.last_success_at,
    last_failure_at: status === 'error' ? at : previous?.last_failure_at,
    detail: redactHealthDetail(detail),
  };

  await db.setSetting(database, healthKey(component), JSON.stringify(event));
  if (status === 'ok') {
    healthSuccessThrottleCache.set(component, nowMs);
  }

  if (!options.auditAction || status !== 'error') return;

  const writeAudit = await shouldWriteAuditLog(
    database,
    component,
    options.auditAction,
    nowMs,
    options.auditThrottleMs ?? DEFAULT_AUDIT_THROTTLE_MS,
  );
  if (!writeAudit) return;

  await db.insertAuditLog(
    database,
    options.auditUser || 'system',
    options.auditAction,
    `${component}: ${event.detail || 'unknown error'}`,
    options.auditLevel || 'error',
  );
}

export async function bestEffortRecordHealthEvent(
  database: HealthDatabase | undefined,
  component: StoredHealthComponent,
  status: HealthStatus,
  detail?: unknown,
  options: Parameters<typeof recordHealthEvent>[4] = {},
): Promise<void> {
  try {
    await recordHealthEvent(database, component, status, detail, options);
  } catch (error) {
    console.error(`[observability] ${component} health write failed:`, errorDetail(error));
  }
}

export async function readHealthEvents(
  database: HealthDatabase,
  components: readonly StoredHealthComponent[] = STORED_HEALTH_COMPONENTS,
): Promise<Record<string, HealthEvent | null>> {
  const events: Record<string, HealthEvent | null> = {};
  const keys = components.map(component => healthKey(component));
  const stored = await db.getSettingsByKeys(database, keys);
  for (const component of components) {
    events[component] = parseHealthEvent(stored[healthKey(component)] ?? null, component);
  }
  return events;
}
