/**
 * LiveDataDO - Durable Object 用于 WebSocket 实时数据推送
 *
 * 功能:
 * 1. 维护所有在线客户端的 WebSocket 连接
 * 2. 缓存最新的监控数据（内存缓存，避免频繁查询数据库）
 * 3. 广播数据更新给所有连接的前端客户端
 * 4. 使用 Alarm 定时清理过期连接
 */

import { normalizeMonitorReport, toMonitorRecord, type MonitorReportPayload } from '../utils/monitor-report';
import * as db from '../db/queries';
import { getDatabase, type DatabaseProviderEnv } from '../db/provider';
import { MAX_PING_RESULTS_PER_REPORT, MAX_PING_VALUE_MS, PING_LOSS_VALUE, validatePingResults } from '../utils/ping-result';
import {
  buildAdminSettings,
  isRecordPersistenceEnabled as normalizeRecordPersistenceEnabled,
} from '../settings/schema';
import { bestEffortRecordHealthEvent, errorDetail, type StoredHealthComponent } from '../utils/observability';
import { isPublicIpAddress } from '../utils/request-ip';
import { unwrapMonitorReportEnvelope } from '../utils/report-envelope';
import { isRecordPersistDue } from '../utils/record-persist';
import { checkWebsiteMonitorHttp } from '../utils/website-monitor';
import { toPublicReport } from '../utils/public-report';
import { projectAgentClientMetadata, projectClientMetadata } from '../utils/client-metadata';
import { compactLiveReport, serializedBytes } from '../utils/live-report-state';
import { evaluateHistoryCapacity } from '../utils/history-capacity';
import { MAX_BACKUP_BYTES } from '../utils/backup';
import { measureRestoredClientSnapshot, restoredClientMetadata } from '../utils/restore-client-snapshot';

// 客户端状态
interface ClientState {
  uuid: string;
  name: string;
  hidden: boolean;
  lastReportTime: number; // 服务端接收时间，用于判活；不采用 Agent 时钟。
  lastReport: MonitorReportPayload; // timestamp 保留采样时间，历史记录使用它。
  expiresAt?: number;
  transport?: 'http' | 'ws'; // Absent on legacy HTTP snapshots.
}

interface ReportLifecycle {
  clientId: string;
  receivedAt: number;
  removalVersion: number;
  restoreVersion: number;
}

const RECORD_PERSIST_INTERVAL_MS = 120_000;
const PING_RECORD_PERSIST_INTERVAL_MS = 120_000;
const MIN_RECORD_PERSIST_INTERVAL_MS = 3_000;
const MAX_RECORD_PERSIST_INTERVAL_MS = 3_600_000;
const MIN_PING_RECORD_PERSIST_INTERVAL_MS = 60_000;
const MAX_PING_RECORD_PERSIST_INTERVAL_MS = 3_600_000;
const RECORD_SETTING_CACHE_MS = 30_000;
const LIVE_VIEWER_WS_PROTOCOL = 'cf-monitor-viewer';
const RECORD_HIGH_WATERMARK_DEFAULT_ROWS = 700_000;
const RECORD_HIGH_WATERMARK_MIN_ROWS = 1_000;
const RECORD_HIGH_WATERMARK_MAX_ROWS = 10_000_000;
// 字节熔断线：Supabase 卡的是磁盘字节，行数只是它的粗糙代理
//（同样行数可能对应 72MB 也可能 189MB，且行数完全不含索引开销）。
// 行数熔断保留为次要边界，两者谁先到就熔断谁。
const RECORD_HIGH_WATERMARK_DEFAULT_BYTES = 419_430_400;
const RECORD_HIGH_WATERMARK_MIN_BYTES = 16_777_216;
const RECORD_HIGH_WATERMARK_MAX_BYTES = 549_755_813_888;
const RECORD_CAPACITY_CACHE_FAR_MS = 6 * 60 * 60_000;
const RECORD_CAPACITY_CACHE_NEAR_MS = 10 * 60_000;
const RECORD_CAPACITY_CACHE_CRITICAL_MS = 60_000;
const RECORD_CAPACITY_AUDIT_THROTTLE_MS = 10 * 60 * 1000;
const HOT_PATH_HEALTH_OK_THROTTLE_MS = 60 * 60 * 1000;
const POLICY_SETTING_CACHE_MS = 30_000;
const PING_TASK_CACHE_MS = 120_000;
const WEBSITE_PROBE_TASK_CACHE_MS = 120_000;
const AGENT_POLICY_OPTIONAL_ERROR_THROTTLE_MS = 5 * 60 * 1000;
const RECORD_CAPACITY_SNAPSHOT_KEY = 'record:capacity:snapshot';
const AGENT_POLICY_SETTING_KEYS = [
  'live_poll_active_interval_sec',
  'live_poll_idle_interval_sec',
  'live_poll_active_max_duration_sec',
  'ping_record_persist_interval_sec',
];
const RECORD_PERSISTENCE_SETTING_KEYS = [
  'record_enabled',
  'record_persist_interval_sec',
  'ping_record_persist_interval_sec',
  'record_high_watermark_rows',
  'record_high_watermark_bytes',
];
const HTTP_CLIENT_MIN_TTL_MS = 30_000;
const HTTP_LIVE_STATE_PREFIX = 'http-live:';
const HTTP_CLIENT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const HTTP_CLIENT_REPORT_MAX_BODY_BYTES = 512 * 1024;
const HTTP_CLIENT_META_MAX_BODY_BYTES = 16 * 1024;
const HTTP_ADMIN_CLIENTS_SNAPSHOT_MAX_BODY_BYTES = 256 * 1024;
const HTTP_PING_RESULT_MAX_BODY_BYTES = 64 * 1024;
const AGENT_WS_MAX_MESSAGE_BYTES = 512 * 1024;
// Cloudflare permits 16,384 bytes; leave room for structured-clone overhead.
const AGENT_ATTACHMENT_BUDGET_BYTES = 12 * 1024;
const AGENT_REPORT_MAX_BATCH = 300;
const VIEWER_MIN_TTL_MS = 60_000;
const VIEWER_MAX_TTL_MS = 60 * 60 * 1000;
const VIEWER_DEFAULT_TTL_MS = 120 * 1000;
const VIEWER_MAX_TOTAL_SESSIONS = 128;
const VIEWER_MAX_SESSIONS_PER_IP = 8;
const PING_RESULT_STORAGE_PREFIX = 'ping-result:';
const PING_VALUE_CHANGE_THRESHOLD_MS = 5;
const PING_UNCHANGED_HEARTBEAT_MS = 30 * 60_000;
const GPU_SNAPSHOT_META_PREFIX = 'gpu-snapshot-meta:';
const GPU_SNAPSHOT_UNCHANGED_HEARTBEAT_MS = 30 * 60_000;
const GPU_UTILIZATION_BUCKET_PERCENT = 5;
const GPU_TEMPERATURE_BUCKET_C = 2;
const GPU_MEMORY_BUCKET_MIN_UNITS = 64;
const GPU_MEMORY_BUCKET_RATIO = 0.01;
const ADMIN_CLIENTS_SNAPSHOT_KEY = 'admin-clients:snapshot';
const AGENT_AUTH_SNAPSHOT_PREFIX = 'agent-auth:';
const AGENT_AUTH_UUID_PREFIX = 'agent-auth-uuid:';
const GEO_REGION_CACHE_MS = 48 * 60 * 60 * 1000;
type SessionRole = 'agent' | 'viewer';
type AgentPolicyMode = 'active' | 'idle';
type JsonObject = Record<string, unknown>;
type LiveDataEnv = DatabaseProviderEnv & Record<string, unknown>;

interface LiveSnapshotClient extends JsonObject {
  uuid: string;
  name: string;
  lastReportTime: number;
}

interface LiveSnapshot {
  online: string[];
  clients: LiveSnapshotClient[];
  data: Record<string, LiveSnapshotClient>;
  last_known: Record<string, LiveSnapshotClient>;
  count: number;
  timestamp: number;
  metadata_version?: string;
}

interface AgentPolicySettings {
  activeIntervalSec: number;
  idleIntervalSec: number;
  viewerTtlSec: number;
  pingIntervalSec: number;
}

interface AgentPolicyMessage {
  type: 'policy';
  mode: AgentPolicyMode;
  sample_interval_sec: number;
  report_interval_sec: number;
  report_now: boolean;
  viewer_count: number;
  viewer_ttl_sec: number;
  ping_interval_sec: number;
  ping_policy_version: string;
  ping_tasks: db.PingTask[];
  website_probe_tasks: db.WebsiteMonitor[];
  policy_ttl_sec: number;
  idle_policy_ttl_sec: number;
  // 只有在后台确实存有该节点的重置日时才下发；缺省时探针保留自己的
  // --traffic-reset-day / 环境变量取值，不会被一个「默认 1」悄悄改掉。
  traffic_reset_day?: number;
  timestamp: number;
}

function isObjectPayload(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(source: JsonObject, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function isUnknownRegionValue(region: string): boolean {
  return /^(unknown|未知|n\/a|null)$/i.test(region.trim());
}

function isCountryCodeRegion(region: string): boolean {
  return /^[A-Z]{2}$/i.test(region.trim());
}

function isDetailedRegion(region: string): boolean {
  const text = region.trim();
  return text !== '' && !isUnknownRegionValue(text) && !isCountryCodeRegion(text);
}

function geoText(source: unknown, key: string): string {
  return isObjectPayload(source) && typeof source[key] === 'string'
    ? String(source[key]).trim()
    : '';
}

function uniqueGeoParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text || isUnknownRegionValue(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function regionFromGeoJsBody(body: unknown): string {
  const city = geoText(body, 'city');
  const regionName = geoText(body, 'region');
  const country = geoText(body, 'country_code') || geoText(body, 'country');
  return uniqueGeoParts([city, regionName, country]).join(', ');
}

function nullableStringField(source: JsonObject, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function numberField(source: JsonObject, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function booleanField(source: JsonObject, key: string): boolean {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

function normalizeAgentAuthSnapshot(value: unknown): AgentAuthSnapshot | null {
  if (!isObjectPayload(value)) return null;
  const uuid = stringField(value, 'uuid').trim();
  const tokenHash = stringField(value, 'token_hash').trim();
  if (!uuid || !tokenHash) return null;
  const snapshot: AgentAuthSnapshot = {
    uuid,
    token: '',
    token_hash: tokenHash,
    token_last_used_at: nullableStringField(value, 'token_last_used_at'),
    token_last_used_ip: stringField(value, 'token_last_used_ip'),
    token_rotated_at: nullableStringField(value, 'token_rotated_at'),
    name: stringField(value, 'name') || uuid,
    cpu_name: stringField(value, 'cpu_name'),
    virtualization: stringField(value, 'virtualization'),
    arch: stringField(value, 'arch'),
    cpu_cores: numberField(value, 'cpu_cores'),
    os: stringField(value, 'os'),
    kernel_version: stringField(value, 'kernel_version'),
    gpu_name: stringField(value, 'gpu_name'),
    ipv4: stringField(value, 'ipv4'),
    ipv6: stringField(value, 'ipv6'),
    region: stringField(value, 'region'),
    remark: stringField(value, 'remark'),
    public_remark: stringField(value, 'public_remark'),
    mem_total: numberField(value, 'mem_total'),
    swap_total: numberField(value, 'swap_total'),
    disk_total: numberField(value, 'disk_total'),
    version: stringField(value, 'version'),
    price: numberField(value, 'price'),
    billing_cycle: numberField(value, 'billing_cycle'),
    auto_renewal: booleanField(value, 'auto_renewal'),
    currency: stringField(value, 'currency'),
    expired_at: stringField(value, 'expired_at'),
    group: stringField(value, 'group'),
    tags: stringField(value, 'tags'),
    hidden: booleanField(value, 'hidden'),
    traffic_limit: numberField(value, 'traffic_limit'),
    traffic_limit_type: stringField(value, 'traffic_limit_type') || 'sum',
    created_at: stringField(value, 'created_at'),
    updated_at: stringField(value, 'updated_at'),
  };
  if (typeof value.sort_order === 'number' && Number.isFinite(value.sort_order)) {
    snapshot.sort_order = value.sort_order;
  }
  return snapshot;
}

async function parseJsonRequestWithLimit(request: Request, maxBytes: number): Promise<{ body: JsonObject } | { response: Response }> {
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { response: Response.json({ error: 'Request body too large' }, { status: 413 }) };
  }

  const text = await request.text().catch(() => '');
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { response: Response.json({ error: 'Request body too large' }, { status: 413 }) };
  }

  try {
    const body = JSON.parse(text);
    return isObjectPayload(body)
      ? { body }
      : { response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }) };
  } catch {
    return { response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }) };
  }
}

interface PingPersistenceResult {
  taskId: number;
  value: number;
  intervalSec?: number;
}

interface PingResultState {
  lastAcceptedMs: number;
  value?: number;
  persistedAt?: number;
}

interface GPUSnapshotMeta {
  signature: string;
  persistedAt: number;
}

interface RecordCapacitySnapshot {
  measurement: 'live-row-bytes-plus-index-estimate';
  rows: number;
  bytes: number;
  blocked: boolean;
  checkedAt: number;
  nextCheckAt: number;
  highWatermarkRows: number;
  highWatermarkBytes: number;
}

interface AdminClientsSnapshot {
  complete?: boolean;
  clients: JsonObject[];
  updatedAt: number;
  removed?: string[];
}

interface AgentAuthSnapshot extends JsonObject {
  uuid: string;
  token: string;
  token_hash: string;
  token_last_used_at: string | null;
  token_last_used_ip: string;
  token_rotated_at: string | null;
  name: string;
  cpu_name: string;
  virtualization: string;
  arch: string;
  cpu_cores: number;
  os: string;
  kernel_version: string;
  gpu_name: string;
  ipv4: string;
  ipv6: string;
  region: string;
  remark: string;
  public_remark: string;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  version: string;
  price: number;
  billing_cycle: number;
  auto_renewal: boolean;
  currency: string;
  expired_at: string;
  group: string;
  tags: string;
  hidden: boolean;
  traffic_limit: number;
  traffic_limit_type: string;
  sort_order?: number;
  created_at: string;
  updated_at: string;
}

interface ReportNetworkMetadata {
  sourceIp?: string;
  region?: string;
}

interface SessionAttachment {
  role: SessionRole;
  clientId: string;
  clientName: string;
  hidden: boolean;
  includeHidden?: boolean;
  viewerIp?: string;
  viewerExpiresAt?: number;
  sourceIp?: string;
  region?: string;
  lastReport?: MonitorReportPayload;
  lastReportTime?: number;
  expiresAt?: number;
}

export function normalizeViewerTtlMs(value: unknown): number {
  const ttlMs = Number(value);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return VIEWER_DEFAULT_TTL_MS;
  return Math.min(Math.max(ttlMs, VIEWER_MIN_TTL_MS), VIEWER_MAX_TTL_MS);
}

export class LiveDataDO {
  private state: DurableObjectState;
  private env: LiveDataEnv;
  private sessions: Map<string, WebSocket>; // WebSocket 连接
  private sessionRoles: Map<string, SessionRole>;
  private viewerExpiresAt: Map<string, number>;
  private clients: Map<string, ClientState>; // 在线客户端状态
  private lastKnownClients = new Map<string, ClientState>();
  private clientReportWrites = new Map<string, Promise<unknown>>();
  private clientRemovalVersions = new Map<string, number>();
  private restoreVersion = 0;
  private httpClientsReady: Promise<void>;
  private recordPersistenceEnabled: boolean = true;
  private recordPersistIntervalMs: number = RECORD_PERSIST_INTERVAL_MS;
  private pingRecordPersistIntervalMs: number = PING_RECORD_PERSIST_INTERVAL_MS;
  private recordPersistenceCheckedAt: number = 0;
  private recordHighWatermarkRows: number = RECORD_HIGH_WATERMARK_DEFAULT_ROWS;
  private recordHighWatermarkBytes: number = RECORD_HIGH_WATERMARK_DEFAULT_BYTES;
  private recordCapacityBytes: number = 0;
  private recordCapacityNextCheckAt: number = 0;
  private recordCapacityRows: number = 0;
  private recordCapacityBlocked: boolean = false;
  private recordCapacityLastAuditAt: number = 0;
  private healthOkLastWriteAt: Map<string, number> = new Map();
  private recordLastPersistAt: Map<string, number> = new Map();
  private recordWritesInFlight = new Set<string>();
  private pingResultStateCache: Map<string, PingResultState> = new Map();
  private policySettings: AgentPolicySettings = {
    activeIntervalSec: 3,
    idleIntervalSec: 120,
    viewerTtlSec: 120,
    pingIntervalSec: 120,
  };
  private policySettingsCheckedAt: number = 0;
  private policySettingsPending: Promise<AgentPolicySettings> | null = null;
  private pingTasksCache: { value: db.PingTask[]; expiresAt: number } | null = null;
  private pingTasksPending: Promise<db.PingTask[]> | null = null;
  private websiteProbeTasksCache: Map<string, { value: db.WebsiteMonitor[]; expiresAt: number }> = new Map();
  private websiteProbeTasksPending: Map<string, Promise<db.WebsiteMonitor[]>> = new Map();
  private policyOptionalErrorLastWriteAt: Map<string, number> = new Map();
  private adminClientsUpdatedAt: number | null = null;
  private adminClientsSnapshot: AdminClientsSnapshot | null = null;
  private adminClientMetadata = new Map<string, JsonObject>();
  private trafficResetDays = new Map<string, number>();
  private trafficResetDaysAt = 0;
  private networkMetadataSignatures = new Map<string, { signature: string; syncedAt: number }>();
  private basicInfoSignatures = new Map<string, string>();
  private metadataSyncQueues = new Map<string, Promise<void>>();
  private pingWriteQueues = new Map<string, Promise<unknown>>();
  private geoRegionCache = new Map<string, { region: string; expiresAt: number }>();

  constructor(state: DurableObjectState, env: LiveDataEnv) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.sessionRoles = new Map();
    this.viewerExpiresAt = new Map();
    this.clients = new Map();
    this.hydrateSessionsFromAcceptedWebSockets();
    this.httpClientsReady = this.hydrateHttpClients();
  }

  private async hydrateHttpClients(): Promise<void> {
    await this.readAdminClientsSnapshot();
    const now = Date.now();
    const stored = await this.state.storage.list<ClientState>({ prefix: HTTP_LIVE_STATE_PREFIX });
    const obsolete: string[] = [];
    for (const [key, client] of stored) {
      if (
        !client || typeof client.uuid !== 'string' || key !== `${HTTP_LIVE_STATE_PREFIX}${client.uuid}` ||
        !Number.isFinite(client.lastReportTime) || !isObjectPayload(client.lastReport) ||
        (client.transport !== 'ws' && !Number.isFinite(client.expiresAt))
      ) {
        obsolete.push(key);
        continue;
      }
      const restored = this.controlledClientState({
        ...client,
        name: typeof client.name === 'string' ? client.name : client.uuid,
        hidden: Boolean(client.hidden),
        lastReport: compactLiveReport(client.lastReport),
      });
      if (!restored) {
        obsolete.push(key);
        continue;
      }
      this.lastKnownClients.set(client.uuid, restored);
      // A stored WebSocket report is historical state. Only an accepted socket
      // attachment can restore its online presence.
      if (client.transport !== 'ws' && client.expiresAt! > now && !this.clients.has(client.uuid)) {
        this.clients.set(client.uuid, restored);
      }
    }
    for (const [uuid, client] of this.clients) {
      let current = this.controlledClientState(client);
      if (!current) {
        this.clients.delete(uuid);
        continue;
      }
      const retained = this.lastKnownClients.get(uuid);
      if (retained && retained.lastReportTime > current.lastReportTime) {
        // A socket can remain attached while a newer HTTP fallback succeeds.
        // Its attachment proves the connection, not that its metrics are newest.
        current = { ...current, lastReport: retained.lastReport, lastReportTime: retained.lastReportTime };
      }
      this.clients.set(uuid, current);
      if (!retained || retained.lastReportTime < current.lastReportTime) {
        // Upgrade a pre-existing socket attachment to the same durable format.
        await this.persistClientSnapshot(current);
        this.lastKnownClients.set(uuid, current);
      }
    }
    for (let offset = 0; offset < obsolete.length; offset += 128) {
      await this.state.storage.delete(obsolete.slice(offset, offset + 128));
    }
    if (stored.size) await this.scheduleExpiryAlarm(now);
  }

  private async persistClientSnapshot(client: ClientState): Promise<void> {
    await this.state.storage.put(`${HTTP_LIVE_STATE_PREFIX}${client.uuid}`, {
      ...client,
      lastReport: compactLiveReport(client.lastReport),
    });
  }

  private getQueryDatabase(): db.QueryDatabase | null {
    try {
      return getDatabase(this.env);
    } catch {
      return null;
    }
  }

  private runBackground(component: StoredHealthComponent, promise: Promise<unknown>): void {
    const task = promise.catch(async (error) => {
      const database = this.getQueryDatabase();
      if (!database) return;
      try {
        await bestEffortRecordHealthEvent(
          database,
          component,
          'error',
          `${component} background task failed: ${errorDetail(error)}`,
          { auditAction: `${component}_background_error` },
        );
      } catch {
        // Avoid surfacing a secondary failure from best-effort observability.
      }
    });
    this.state.waitUntil(task);
  }

  private getSessionAttachment(ws: WebSocket): SessionAttachment | null {
    const attachment = ws.deserializeAttachment();
    if (!attachment || typeof attachment !== 'object') return null;
    const value = attachment as Partial<SessionAttachment>;
    if (value.role !== 'agent' && value.role !== 'viewer') return null;
    if (typeof value.clientId !== 'string' || value.clientId.trim() === '') return null;
    return {
      role: value.role,
      clientId: value.clientId,
      clientName: typeof value.clientName === 'string' && value.clientName.trim() !== ''
        ? value.clientName
        : value.clientId,
      hidden: Boolean(value.hidden),
      includeHidden: Boolean(value.includeHidden),
      viewerIp: typeof value.viewerIp === 'string' && value.viewerIp.trim() !== ''
        ? value.viewerIp
        : undefined,
      viewerExpiresAt: typeof value.viewerExpiresAt === 'number' && Number.isFinite(value.viewerExpiresAt)
        ? value.viewerExpiresAt
        : undefined,
      sourceIp: typeof value.sourceIp === 'string' && value.sourceIp.trim() !== ''
        ? value.sourceIp.trim()
        : undefined,
      region: typeof value.region === 'string' && value.region.trim() !== ''
        ? value.region.trim()
        : undefined,
      lastReport: isObjectPayload(value.lastReport) ? value.lastReport as MonitorReportPayload : undefined,
      lastReportTime: typeof value.lastReportTime === 'number' && Number.isFinite(value.lastReportTime)
        ? value.lastReportTime
        : undefined,
      expiresAt: typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
        ? value.expiresAt
        : undefined,
    };
  }

  private registerSession(ws: WebSocket, attachment: SessionAttachment): void {
    ws.serializeAttachment(attachment);
    this.sessions.set(attachment.clientId, ws);
    this.sessionRoles.set(attachment.clientId, attachment.role);
    if (attachment.role === 'viewer' && attachment.viewerExpiresAt) {
      this.viewerExpiresAt.set(attachment.clientId, attachment.viewerExpiresAt);
    } else {
      this.viewerExpiresAt.delete(attachment.clientId);
    }
  }

  private hydrateSessionsFromAcceptedWebSockets(): void {
    const now = Date.now();
    for (const ws of this.state.getWebSockets()) {
      const attachment = this.getSessionAttachment(ws);
      if (!attachment) continue;
      if (attachment.role === 'viewer' && attachment.viewerExpiresAt && attachment.viewerExpiresAt <= now) {
        this.expireViewer(attachment.clientId, ws, now);
        continue;
      }
      this.sessions.set(attachment.clientId, ws);
      this.sessionRoles.set(attachment.clientId, attachment.role);
      if (attachment.role === 'viewer' && attachment.viewerExpiresAt) {
        this.viewerExpiresAt.set(attachment.clientId, attachment.viewerExpiresAt);
      } else {
        this.viewerExpiresAt.delete(attachment.clientId);
      }
      if (
        attachment.role === 'agent' &&
        attachment.lastReport &&
        typeof attachment.lastReportTime === 'number' &&
        (!attachment.expiresAt || attachment.expiresAt > now)
      ) {
        this.clients.set(attachment.clientId, {
          uuid: attachment.clientId,
          name: attachment.clientName,
          hidden: attachment.hidden,
          lastReportTime: attachment.lastReportTime,
          lastReport: attachment.lastReport,
          expiresAt: attachment.expiresAt,
          transport: 'ws',
        });
      }
    }
  }

  private sanitizeReport(report: MonitorReportPayload, network?: ReportNetworkMetadata): MonitorReportPayload {
    const {
      token,
      authorization,
      password,
      ...safeReport
    } = report as MonitorReportPayload & Record<string, unknown>;

    for (const field of ['ipv4', 'ipv6'] as const) {
      const value = safeReport[field];
      if (typeof value === 'string' && value.trim() !== '') {
        const text = value.trim();
        if (!isPublicIpAddress(text)) delete safeReport[field];
      }
    }

    const sourceIp = typeof network?.sourceIp === 'string' ? network.sourceIp.trim() : '';
    if (isPublicIpAddress(sourceIp)) {
      if (sourceIp.includes(':')) {
        if (typeof safeReport.ipv6 !== 'string' || !isPublicIpAddress(safeReport.ipv6)) safeReport.ipv6 = sourceIp;
      } else {
        if (typeof safeReport.ipv4 !== 'string' || !isPublicIpAddress(safeReport.ipv4)) safeReport.ipv4 = sourceIp;
      }
    }

    const region = typeof network?.region === 'string' ? network.region.trim() : '';
    const reportRegion = typeof safeReport.region === 'string' ? safeReport.region.trim() : '';
    if (region && this.isUsefulRegion(region) && !this.isUsefulRegion(reportRegion)) {
      safeReport.region = region;
    }
    if (typeof safeReport.region === 'string' && !this.isUsefulRegion(safeReport.region)) {
      delete safeReport.region;
    }

    return safeReport as MonitorReportPayload;
  }

  private controlledClientState(client: ClientState): ClientState | null {
    const metadata = this.adminClientMetadata.get(client.uuid);
    if (this.adminClientsSnapshot && (this.adminClientsSnapshot.removed?.includes(client.uuid)
      || (this.adminClientsSnapshot.complete !== false && !metadata))) return null;
    return metadata ? {
      ...client,
      name: typeof metadata.name === 'string' ? metadata.name : client.name,
      hidden: booleanField(metadata, 'hidden'),
    } : client;
  }

  private projectSnapshotClient(client: ClientState, includeHidden: boolean, retained = false): LiveSnapshotClient | null {
    const current = this.controlledClientState(client);
    if (!current || (!includeHidden && current.hidden)) return null;
    return {
      ...this.projectViewerReport(current.uuid, current.lastReport, !retained && includeHidden),
      uuid: current.uuid,
      name: current.name,
      lastReportTime: current.lastReportTime,
    };
  }

  private projectViewerReport(uuid: string, report: MonitorReportPayload, includeHidden: boolean): JsonObject {
    const projected: JsonObject = { ...(includeHidden ? report : toPublicReport(report)) };
    // Agent extensions have no authority over administrative ordering.
    delete projected.sort_order;
    const order = this.adminClientMetadata.get(uuid)?.sort_order;
    if (typeof order === 'number' && Number.isFinite(order)) projected.sort_order = order;
    return projected;
  }

  private buildSnapshot(includeHidden = false): LiveSnapshot {
    const now = Date.now();
    const onlineClients = Array.from(this.clients.values())
      .filter(c => !c.expiresAt || c.expiresAt > now)
      .map(c => this.projectSnapshotClient(c, includeHidden))
      .filter((client): client is LiveSnapshotClient => client !== null);
    const liveData = onlineClients.reduce<Record<string, LiveSnapshotClient>>((acc, client) => {
      acc[client.uuid] = client;
      return acc;
    }, {});

    const onlineIds = new Set(onlineClients.map(client => client.uuid));
    const lastKnown: Record<string, LiveSnapshotClient> = {};
    for (const client of this.lastKnownClients.values()) {
      if (onlineIds.has(client.uuid)) continue;
      const projected = this.projectSnapshotClient(client, includeHidden, true);
      if (projected) lastKnown[client.uuid] = projected;
    }
    const snapshot: LiveSnapshot = {
      online: onlineClients.map(c => c.uuid),
      clients: onlineClients,
      data: liveData,
      last_known: lastKnown,
      count: onlineClients.length,
      timestamp: Date.now(),
    };
    if (this.adminClientsUpdatedAt !== null) {
      snapshot.metadata_version = String(this.adminClientsUpdatedAt);
    }
    return snapshot;
  }

  private async buildSnapshotWithMetadataVersion(includeHidden = false): Promise<LiveSnapshot> {
    if (this.adminClientsUpdatedAt === null) {
      const snapshot = await this.readAdminClientsSnapshot();
      this.adminClientsUpdatedAt = snapshot?.updatedAt || 0;
    }
    return this.buildSnapshot(includeHidden);
  }

  private sendSnapshot(ws: WebSocket) {
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) return;
    const includeHidden = this.getSessionAttachment(ws)?.includeHidden === true;
    try {
      ws.send(JSON.stringify({
        type: 'snapshot',
        ...this.buildSnapshot(includeHidden),
      }));
    } catch (error) {
      // Viewer snapshots are best effort; HTTP fallback will retry.
    }
  }

  private isVisibleClient(client: ClientState | undefined, now: number): boolean {
    return Boolean(client && !client.hidden && (!client.expiresAt || client.expiresAt > now));
  }

  private async resolveReportClientControl(clientId: string, name: string, hidden: boolean): Promise<{ name: string; hidden: boolean }> {
    const snapshot = await this.readAdminClientsSnapshot();
    const metadata = snapshot?.clients.find(client => client.uuid === clientId);
    if (snapshot && (snapshot.removed?.includes(clientId) || (snapshot.complete !== false && !metadata))) {
      throw new Error('Client authorization was removed');
    }
    if (metadata) {
      return {
        name: typeof metadata.name === 'string' ? metadata.name : name,
        hidden: booleanField(metadata, 'hidden'),
      };
    }
    const current = this.clients.get(clientId) || this.lastKnownClients.get(clientId);
    return current ? { name: current.name, hidden: current.hidden } : { name, hidden };
  }

  private isReportCurrent(lifecycle: ReportLifecycle): boolean {
    return lifecycle.removalVersion === (this.clientRemovalVersions.get(lifecycle.clientId) || 0)
      && lifecycle.restoreVersion === this.restoreVersion;
  }

  private assertReportCurrent(lifecycle: ReportLifecycle): void {
    if (!this.isReportCurrent(lifecycle)) throw new Error('Client authorization was replaced');
  }

  private async runClientReport<T>(clientId: string, work: (lifecycle: ReportLifecycle) => Promise<T>): Promise<T> {
    const lifecycle: ReportLifecycle = {
      clientId, receivedAt: Date.now(),
      removalVersion: this.clientRemovalVersions.get(clientId) || 0,
      restoreVersion: this.restoreVersion,
    };
    const previous = this.clientReportWrites.get(clientId) || Promise.resolve();
    // Reserve the entire report/batch before its first external probe await.
    // The final live write and ACK stay inside this same per-node reservation.
    const pending = previous.catch(() => {}).then(() => {
      this.assertReportCurrent(lifecycle);
      return work(lifecycle);
    });
    this.clientReportWrites.set(clientId, pending);
    try {
      return await pending;
    } finally {
      if (this.clientReportWrites.get(clientId) === pending) {
        this.clientReportWrites.delete(clientId);
        this.clientRemovalVersions.delete(clientId);
      }
    }
  }

  private async updateClientReport(
    lifecycle: ReportLifecycle,
    clientName: string,
    hidden: boolean,
    data: unknown,
    expiresAt?: number,
    ws?: WebSocket,
    network?: ReportNetworkMetadata,
  ): Promise<MonitorReportPayload> {
    this.assertReportCurrent(lifecycle);
    const { clientId, receivedAt: now } = lifecycle;
    const report = this.sanitizeReport(
      normalizeMonitorReport(data),
      network || (ws ? this.getSessionAttachment(ws) || undefined : undefined),
    );
    let wroteSnapshot = false;
    let next: ClientState;
    try {
      const control = await this.resolveReportClientControl(clientId, clientName, hidden);
      this.assertReportCurrent(lifecycle);
      next = { uuid: clientId, ...control, lastReportTime: now, lastReport: report, expiresAt, transport: ws ? 'ws' : 'http' };
      while (true) {
        await this.persistClientSnapshot(next);
        wroteSnapshot = true;
        this.assertReportCurrent(lifecycle);
        const current = await this.resolveReportClientControl(clientId, next.name, next.hidden);
        this.assertReportCurrent(lifecycle);
        if (current.name === next.name && current.hidden === next.hidden) break;
        next = { ...next, ...current };
      }
    } catch (error) {
      // A delete/restore may have completed while an old write was pending.
      // Retire that write before a newer report in this node's queue proceeds.
      if (wroteSnapshot) {
        const previous = this.lastKnownClients.get(clientId);
        const retained = this.isReportCurrent(lifecycle) && previous ? this.controlledClientState(previous) : null;
        if (retained) await this.persistClientSnapshot(retained);
        else await this.state.storage.delete(`${HTTP_LIVE_STATE_PREFIX}${clientId}`);
      }
      throw error;
    }

    this.lastKnownClients.set(clientId, { ...next, lastReport: compactLiveReport(next.lastReport) });
    const online = !ws || (this.sessions.get(clientId) === ws && ws.readyState === WebSocket.READY_STATE_OPEN);
    if (online) {
      this.clients.set(clientId, next);
      if (ws) this.rememberAgentReportAttachment(ws, clientId, next.name, next.hidden, report, now, expiresAt);
      this.broadcastToViewers({
        type: 'update', client: clientId, name: next.name, data: report, timestamp: now,
      }, next.hidden ? 'admin' : 'all');
    } else {
      this.broadcastOfflineClient(next, Date.now());
    }
    this.runBackground('do_live_network_metadata', this.syncNetworkMetadataFromReport(clientId, next.name, next.hidden, report, now));
    return report;
  }

  private async syncNetworkMetadataFromReport(
    clientId: string,
    _clientName: string,
    _hidden: boolean,
    report: MonitorReportPayload,
    now: number,
  ): Promise<void> {
    const patch: JsonObject = {};
    if (typeof report.ipv4 === 'string' && isPublicIpAddress(report.ipv4)) patch.ipv4 = report.ipv4.trim();
    if (typeof report.ipv6 === 'string' && isPublicIpAddress(report.ipv6)) patch.ipv6 = report.ipv6.trim();
    if (typeof report.region === 'string' && this.isUsefulRegion(report.region)) patch.region = report.region.trim();
    if (!isDetailedRegion(String(patch.region || ''))) {
      const inferredRegion = await this.inferRegionFromPublicIp(String(patch.ipv4 || patch.ipv6 || ''));
      if (inferredRegion && (!patch.region || isDetailedRegion(inferredRegion))) patch.region = inferredRegion;
    }
    if (Object.keys(patch).length === 0) return;
    this.applyInferredNetworkMetadataToLiveReport(clientId, patch, now);

    const signature = JSON.stringify(patch);
    await this.runClientMetadataSync(clientId, async () => {
      const previous = this.networkMetadataSignatures.get(clientId);
      if (previous?.signature === signature) return;
      const database = this.getQueryDatabase();
      if (!database) return;
      await db.updateClient(database, clientId, patch as Partial<db.Client>);
      const client = await this.upsertAdminClientSnapshot({ uuid: clientId, ...patch }, true);
      this.networkMetadataSignatures.set(clientId, { signature, syncedAt: now });
      if (client) this.broadcastMetadataChanged({ clients: { upsert: [client] } });
    });
  }

  private async runClientMetadataSync(clientId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.metadataSyncQueues.get(clientId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(work);
    this.metadataSyncQueues.set(clientId, pending);
    try {
      await pending;
    } finally {
      if (this.metadataSyncQueues.get(clientId) === pending) this.metadataSyncQueues.delete(clientId);
    }
  }

  private applyInferredNetworkMetadataToLiveReport(clientId: string, patch: JsonObject, now: number): void {
    const source = this.clients.get(clientId);
    const current = source ? this.controlledClientState(source) : null;
    if (!current || (current.expiresAt !== undefined && current.expiresAt <= now)) return;

    const nextReport: MonitorReportPayload = { ...current.lastReport };
    let changed = false;
    const ipv4 = typeof patch.ipv4 === 'string' && isPublicIpAddress(patch.ipv4) ? patch.ipv4.trim() : '';
    if (ipv4 && nextReport.ipv4 !== ipv4) {
      nextReport.ipv4 = ipv4;
      changed = true;
    }
    const ipv6 = typeof patch.ipv6 === 'string' && isPublicIpAddress(patch.ipv6) ? patch.ipv6.trim() : '';
    if (ipv6 && nextReport.ipv6 !== ipv6) {
      nextReport.ipv6 = ipv6;
      changed = true;
    }
    const region = typeof patch.region === 'string' && this.isUsefulRegion(patch.region) ? patch.region.trim() : '';
    if (region && nextReport.region !== region) {
      nextReport.region = region;
      changed = true;
    }
    if (!changed) return;

    const next = { ...current, lastReport: nextReport };
    this.clients.set(clientId, next);
    this.lastKnownClients.set(clientId, { ...next, lastReport: compactLiveReport(next.lastReport) });
    const session = this.sessions.get(clientId);
    if (session && this.sessionRoles.get(clientId) === 'agent') {
      this.rememberAgentReportAttachment(session, clientId, current.name, current.hidden, nextReport, current.lastReportTime, current.expiresAt);
    }
    if (this.isVisibleClient(next, now) || next.hidden) {
      this.broadcastToViewers({
        type: 'update',
        client: clientId,
        name: current.name,
        data: nextReport,
        timestamp: now,
      }, next.hidden ? 'admin' : 'all');
    }
  }

  private async inferRegionFromPublicIp(ip: string): Promise<string> {
    const publicIp = ip.trim();
    if (!isPublicIpAddress(publicIp)) return '';
    const now = Date.now();
    const cached = this.geoRegionCache.get(publicIp);
    if (cached && cached.expiresAt > now) return cached.region;

    const response = await fetch(`https://get.geojs.io/v1/ip/geo/${encodeURIComponent(publicIp)}.json`, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    if (!response?.ok) return '';
    const body = await response.json().catch(() => null);
    const region = regionFromGeoJsBody(body);
    if (!this.isUsefulRegion(region)) return '';
    this.geoRegionCache.set(publicIp, { region, expiresAt: now + GEO_REGION_CACHE_MS });
    return region;
  }

  private rememberAgentReportAttachment(
    ws: WebSocket,
    clientId: string,
    clientName: string,
    hidden: boolean,
    report: MonitorReportPayload,
    now: number,
    expiresAt?: number,
  ): void {
    const previous = this.getSessionAttachment(ws);
    const attachment: SessionAttachment = {
      role: 'agent',
      clientId,
      clientName: clientName.slice(0, 256),
      hidden,
      ...(previous?.sourceIp ? { sourceIp: previous.sourceIp } : {}),
      ...(previous?.region ? { region: previous.region } : {}),
      lastReport: compactLiveReport(report),
      lastReportTime: now,
      expiresAt,
    };
    if (serializedBytes(attachment) > AGENT_ATTACHMENT_BUDGET_BYTES && attachment.lastReport) {
      delete attachment.lastReport.basic_info;
    }
    if (serializedBytes(attachment) > AGENT_ATTACHMENT_BUDGET_BYTES && attachment.lastReport) {
      attachment.lastReport.gpus = attachment.lastReport.gpus.map(gpu => ({ ...gpu, device_name: '' }));
    }
    ws.serializeAttachment(attachment);
  }

  private boundedHttpTtlMs(value: unknown): number {
    const ttlMs = Number(value);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 180_000;
    return Math.min(Math.max(ttlMs, HTTP_CLIENT_MIN_TTL_MS), HTTP_CLIENT_MAX_TTL_MS);
  }

  private boundIntegerSetting(value: string | undefined, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }

  private async getAgentPolicySettings(now: number, forceRefresh = false): Promise<AgentPolicySettings> {
    const database = this.getQueryDatabase();
    if (!database) return this.policySettings;
    if (!forceRefresh && now - this.policySettingsCheckedAt < POLICY_SETTING_CACHE_MS) {
      return this.policySettings;
    }
    if (!forceRefresh && this.policySettingsPending) return this.policySettingsPending;

    const pending = (async () => {
      const settings = buildAdminSettings(await db.getSettingsByKeys(database, AGENT_POLICY_SETTING_KEYS));
      this.policySettings = {
        activeIntervalSec: this.boundIntegerSetting(settings.live_poll_active_interval_sec, 3, 3, 300),
        idleIntervalSec: this.boundIntegerSetting(settings.live_poll_idle_interval_sec, 120, 60, 3600),
        viewerTtlSec: this.boundIntegerSetting(settings.live_poll_active_max_duration_sec, 120, 60, 3600),
        pingIntervalSec: this.boundIntegerSetting(settings.ping_record_persist_interval_sec, 120, 60, 3600),
      };
      this.policySettingsCheckedAt = now;
      return this.policySettings;
    })();
    this.policySettingsPending = pending;
    try {
      return await pending;
    } catch (error) {
      await bestEffortRecordHealthEvent(
        database,
        'agent_policy',
        'error',
        `policy settings lookup failed: ${errorDetail(error)}`,
        { auditAction: 'agent_policy_error' },
      );
      this.policySettingsCheckedAt = now;
      return this.policySettings;
    } finally {
      if (this.policySettingsPending === pending) this.policySettingsPending = null;
    }
  }

  private async getPingTasks(now: number, forceRefresh = false): Promise<db.PingTask[]> {
    const database = this.getQueryDatabase();
    if (!database) return [];
    if (!forceRefresh && this.pingTasksCache && this.pingTasksCache.expiresAt > now) {
      return this.pingTasksCache.value;
    }
    if (!forceRefresh && this.pingTasksPending) return this.pingTasksPending;

    const pending = db.listPingTasks(database).then((tasks) => {
      this.pingTasksCache = {
        value: tasks,
        expiresAt: now + PING_TASK_CACHE_MS,
      };
      return tasks;
    });
    this.pingTasksPending = pending;
    try {
      return await pending;
    } finally {
      if (this.pingTasksPending === pending) this.pingTasksPending = null;
    }
  }

  private pingTasksForClient(tasks: db.PingTask[], clientId?: string): db.PingTask[] {
    if (!clientId) return [];
    const intervalSec = this.policySettings.pingIntervalSec;
    return tasks
      .filter(task => task.all_clients || task.clients.includes(clientId))
      .map(task => ({ ...task, interval_sec: intervalSec }));
  }

  private async pingPolicyVersion(tasks: db.PingTask[], intervalSec: number): Promise<string> {
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

  private invalidatePingTasksCache(): void {
    this.pingTasksCache = null;
    this.pingTasksPending = null;
  }

  private invalidateWebsiteProbeTasksCache(): void {
    this.websiteProbeTasksCache.clear();
    this.websiteProbeTasksPending.clear();
  }

  private async getWebsiteProbeTasks(now: number, clientId?: string, requireSuccess = false): Promise<db.WebsiteMonitor[]> {
    const database = this.getQueryDatabase();
    if (!database || !clientId) return [];
    const cached = this.websiteProbeTasksCache.get(clientId);
    if (cached && cached.expiresAt > now) return cached.value;
    const existing = this.websiteProbeTasksPending.get(clientId);
    if (existing) return existing;

    const pending = db.listAgentWebsiteProbeTasks(database, clientId, new Date(now).toISOString(), 20)
      .then((tasks) => {
        this.websiteProbeTasksCache.set(clientId, {
          value: tasks,
          expiresAt: now + WEBSITE_PROBE_TASK_CACHE_MS,
        });
        return tasks;
      });
    this.websiteProbeTasksPending.set(clientId, pending);
    try {
      return await pending;
    } catch (error) {
      const component = 'agent_policy_website_probe_tasks';
      const previous = this.policyOptionalErrorLastWriteAt.get(component) || 0;
      if (now - previous >= AGENT_POLICY_OPTIONAL_ERROR_THROTTLE_MS) {
        this.policyOptionalErrorLastWriteAt.set(component, now);
        await bestEffortRecordHealthEvent(
          database,
          component,
          'error',
          `website probe tasks lookup failed; policy sent without website probes: ${errorDetail(error)}`,
          { auditAction: 'agent_policy_website_probe_tasks_error' },
        );
      }
      if (requireSuccess) throw error;
      return [];
    } finally {
      if (this.websiteProbeTasksPending.get(clientId) === pending) {
        this.websiteProbeTasksPending.delete(clientId);
      }
    }
  }

  private activeViewerCount(now: number): number {
    let count = 0;
    for (const [id, role] of this.sessionRoles) {
      if (role !== 'viewer') continue;
      const session = this.sessions.get(id);
      const expiresAt = this.viewerExpiresAt.get(id);
      if (expiresAt && expiresAt <= now) continue;
      if (session?.readyState === WebSocket.READY_STATE_OPEN) {
        count += 1;
      }
    }
    return count;
  }

  // 节点的流量重置日来自后台快照。返回 undefined 表示「后台没有这个节点的记录」，
  // 此时不下发该字段，让探针保留安装时的取值。
  private async trafficResetDayFor(clientId?: string): Promise<number | undefined> {
    if (!clientId) return undefined;
    const snapshotAt = this.adminClientsUpdatedAt || 0;
    if (this.trafficResetDaysAt === 0 || snapshotAt > this.trafficResetDaysAt) {
      const snapshot = await this.readAdminClientsSnapshot();
      const next = new Map<string, number>();
      for (const client of snapshot?.clients || []) {
        const uuid = String(client.uuid || '');
        const day = Number(client.traffic_reset_day);
        if (uuid && Number.isFinite(day) && day >= 1 && day <= 31) next.set(uuid, Math.trunc(day));
      }
      this.trafficResetDays = next;
      this.trafficResetDaysAt = Math.max(snapshotAt, Date.now());
    }
    return this.trafficResetDays.get(clientId);
  }

  private async buildAgentPolicy(
    now: number,
    reportNow: boolean,
    forceRefreshSettings = false,
    clientId?: string,
  ): Promise<AgentPolicyMessage> {
    const settings = await this.getAgentPolicySettings(now, forceRefreshSettings);
    const viewerCount = this.activeViewerCount(now);
    const mode: AgentPolicyMode = viewerCount > 0 ? 'active' : 'idle';
    const pingTasks = this.pingTasksForClient(await this.getPingTasks(now), clientId);
    const websiteProbeTasks = await this.getWebsiteProbeTasks(now, clientId);
    return {
      type: 'policy',
      mode,
      sample_interval_sec: mode === 'active' ? settings.activeIntervalSec : settings.idleIntervalSec,
      report_interval_sec: mode === 'active' ? settings.activeIntervalSec : settings.idleIntervalSec,
      report_now: mode === 'active' && reportNow,
      viewer_count: viewerCount,
      viewer_ttl_sec: settings.viewerTtlSec,
      ping_interval_sec: settings.pingIntervalSec,
      ping_policy_version: await this.pingPolicyVersion(pingTasks, settings.pingIntervalSec),
      ping_tasks: pingTasks,
      website_probe_tasks: websiteProbeTasks,
      policy_ttl_sec: mode === 'active' ? 30 : 120,
      idle_policy_ttl_sec: 120,
      traffic_reset_day: await this.trafficResetDayFor(clientId),
      timestamp: now,
    };
  }

  private sendAgentPolicy(session: WebSocket, policy: AgentPolicyMessage): void {
    if (session.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      session.send(JSON.stringify(policy));
    } catch {
      // Broken agent sockets are cleaned up by close/error handlers.
    }
  }

  private async sendCurrentPolicyToAgent(
    session: WebSocket,
    now: number,
    reportNow = false,
    forceRefreshSettings = false,
    clientId?: string,
  ): Promise<void> {
    const policy = await this.buildAgentPolicy(now, reportNow, forceRefreshSettings, clientId);
    this.sendAgentPolicy(session, policy);
  }

  private async broadcastAgentPolicy(
    now: number,
    reportNow = false,
    forceRefreshSettings = false,
  ): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (this.sessionRoles.get(id) !== 'agent') continue;
      this.sendAgentPolicy(session, await this.buildAgentPolicy(now, reportNow, forceRefreshSettings, id));
    }
  }

  private async removeExpiredClients(now: number) {
    for (const [uuid, client] of this.clients) {
      if (!client.expiresAt || client.expiresAt > now) continue;

      this.clients.delete(uuid);
      this.broadcastOfflineClient(client, now);
    }

  }

  private broadcastOfflineClient(client: ClientState, now: number): void {
    const current = this.controlledClientState(client);
    if (!current) return;
    this.broadcastToViewers({
      type: 'remove', client: current.uuid, reason: 'offline', timestamp: now,
      last_known: this.projectSnapshotClient(current, true, true),
    }, current.hidden ? 'admin' : 'all');
  }

  private async scheduleExpiryAlarm(now: number) {
    try {
      const expiries: number[] = [];
      for (const client of this.clients.values()) {
        const expiresAt = client.expiresAt;
        if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now) {
          expiries.push(expiresAt);
        }
      }
      for (const expiresAt of this.viewerExpiresAt.values()) {
        if (Number.isFinite(expiresAt) && expiresAt > now) {
          expiries.push(expiresAt);
        }
      }
      const nextExpiry = expiries.sort((a, b) => a - b)[0];

      if (nextExpiry === undefined) {
        await this.state.storage.deleteAlarm();
        return;
      }

      await this.state.storage.setAlarm(Math.max(nextExpiry, now + 1000));
    } catch {
      // Alarm scheduling is best effort; snapshots still filter expired HTTP clients.
    }
  }

  private broadcastToViewers(message: JsonObject, audience: 'all' | 'public' | 'admin' = 'all') {
    let publicPayload = '';
    let adminPayload = '';
    for (const [id, session] of this.sessions) {
      if (this.sessionRoles.get(id) !== 'viewer' || session.readyState !== WebSocket.READY_STATE_OPEN) {
        continue;
      }
      const includeHidden = this.getSessionAttachment(session)?.includeHidden === true;
      if (audience === 'admin' && !includeHidden) continue;
      if (audience === 'public' && includeHidden) continue;
      try {
        if (includeHidden) {
          adminPayload ||= JSON.stringify(message.type === 'update' && isObjectPayload(message.data)
            ? { ...message, data: this.projectViewerReport(String(message.client), message.data as MonitorReportPayload, true) }
            : message);
          session.send(adminPayload);
        } else {
          publicPayload ||= JSON.stringify(message.type === 'update' && isObjectPayload(message.data)
            ? { ...message, data: this.projectViewerReport(String(message.client), message.data as MonitorReportPayload, false) }
            : message);
          session.send(publicPayload);
        }
      } catch {
        // Close/error handlers clean up broken viewer sockets.
      }
    }
  }

  private broadcastMetadataChanged(detail: JsonObject = {}, audience: 'all' | 'public' | 'admin' = 'all') {
    const timestamp = Date.now();
    for (const target of ['public', 'admin'] as const) {
      if (audience !== 'all' && audience !== target) continue;
      let projected = detail;
      if (isObjectPayload(detail.clients)) {
        const patch = detail.clients;
        const upserts = Array.isArray(patch.upsert) ? patch.upsert.filter(isObjectPayload) : [];
        const remove = new Set(Array.isArray(patch.remove)
          ? patch.remove.filter((uuid): uuid is string => typeof uuid === 'string')
          : []);
        if (target === 'public') {
          for (const client of upserts) {
            if (client.hidden && typeof client.uuid === 'string') remove.add(client.uuid);
          }
        }
        projected = {
          ...detail,
          clients: {
            ...(Array.isArray(patch.upsert) ? {
              upsert: upserts.filter(client => target === 'admin' || !client.hidden)
                .map(client => projectClientMetadata(client, target === 'admin')),
            } : {}),
            ...(remove.size ? { remove: [...remove] } : {}),
          },
        };
      }
      this.broadcastToViewers({ type: 'metadata_changed', ...projected, timestamp }, target);
    }
  }

  private countViewers(viewerIp?: string): { total: number; sameIp: number } {
    let total = 0;
    let sameIp = 0;
    const now = Date.now();
    for (const ws of this.sessions.values()) {
      const attachment = this.getSessionAttachment(ws);
      if (!attachment || attachment.role !== 'viewer') continue;
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const expiresAt = this.viewerExpiresAt.get(attachment.clientId) ?? attachment.viewerExpiresAt;
      if (expiresAt && expiresAt <= now) continue;
      total += 1;
      if (viewerIp && attachment.viewerIp === viewerIp) {
        sameIp += 1;
      }
    }
    return { total, sameIp };
  }

  private enforceViewerConnectionLimit(viewerIp?: string): Response | null {
    const counts = this.countViewers(viewerIp);
    if (counts.total >= VIEWER_MAX_TOTAL_SESSIONS) {
      return new Response(JSON.stringify({ error: 'Too many live viewers' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      });
    }
    if (viewerIp && counts.sameIp >= VIEWER_MAX_SESSIONS_PER_IP) {
      return new Response(JSON.stringify({ error: 'Too many live viewers from this IP' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      });
    }
    return null;
  }

  private expireViewer(id: string, session: WebSocket, now: number): void {
    this.viewerExpiresAt.delete(id);
    if (this.sessions.get(id) === session) {
      this.sessions.delete(id);
      this.sessionRoles.delete(id);
    }

    if (session.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      session.send(JSON.stringify({
        type: 'viewer_expired',
        timestamp: now,
      }));
    } catch {
      // Best effort only; closing below is the enforcement.
    }
    try {
      session.close(1000, 'Viewer live window expired');
    } catch {
      // Best effort only.
    }
  }

  private removeExpiredViewers(now: number): void {
    for (const [id, expiresAt] of this.viewerExpiresAt) {
      if (expiresAt > now) continue;
      const session = this.sessions.get(id);
      if (!session) {
        this.viewerExpiresAt.delete(id);
        this.sessionRoles.delete(id);
        continue;
      }
      this.expireViewer(id, session, now);
    }
  }

  private cleanupSession(ws: WebSocket, attachment: SessionAttachment): void {
    if (this.sessions.get(attachment.clientId) !== ws) return;

    const existing = this.clients.get(attachment.clientId);
    this.sessions.delete(attachment.clientId);
    this.sessionRoles.delete(attachment.clientId);
    this.viewerExpiresAt.delete(attachment.clientId);

    if (attachment.role !== 'agent') return;

    this.clients.delete(attachment.clientId);
    if (existing) {
      this.broadcastOfflineClient(existing, Date.now());
    }
  }

  private async upsertAgentAuthSnapshot(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, HTTP_CLIENT_META_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const client = normalizeAgentAuthSnapshot(parsed.body.client || parsed.body);
    if (!client) {
      return Response.json({ error: 'Invalid agent auth snapshot' }, { status: 400 });
    }
    await this.state.storage.put(`${AGENT_AUTH_SNAPSHOT_PREFIX}${client.token_hash}`, client);
    await this.state.storage.put(`${AGENT_AUTH_UUID_PREFIX}${client.uuid}`, client.token_hash);
    return Response.json({ success: true });
  }

  private async lookupAgentAuthSnapshot(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, HTTP_CLIENT_META_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const tokenHash = stringField(parsed.body, 'token_hash').trim();
    if (!tokenHash) return Response.json({ error: 'Invalid token hash' }, { status: 400 });
    const client = await this.state.storage.get<AgentAuthSnapshot>(`${AGENT_AUTH_SNAPSHOT_PREFIX}${tokenHash}`);
    return client
      ? Response.json({ client })
      : Response.json({ error: 'Snapshot missing' }, { status: 404 });
  }

  private async removeAgentAuthByUuid(uuid: string): Promise<void> {
    const tokenHash = await this.state.storage.get<string>(`${AGENT_AUTH_UUID_PREFIX}${uuid}`);
    if (tokenHash) await this.state.storage.delete(`${AGENT_AUTH_SNAPSHOT_PREFIX}${tokenHash}`);
    await this.state.storage.delete(`${AGENT_AUTH_UUID_PREFIX}${uuid}`);
  }

  private async removeAgentAuthSnapshot(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, HTTP_CLIENT_META_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const uuid = stringField(parsed.body, 'uuid').trim();
    const tokenHash = stringField(parsed.body, 'token_hash').trim();
    if (tokenHash) await this.state.storage.delete(`${AGENT_AUTH_SNAPSHOT_PREFIX}${tokenHash}`);
    if (uuid) await this.removeAgentAuthByUuid(uuid);
    return Response.json({ success: true });
  }

  private async updateClientMeta(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, HTTP_CLIENT_META_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const meta = parsed.body;
    if (!isObjectPayload(meta) || typeof meta.uuid !== 'string' || meta.uuid.trim() === '') {
      return new Response(JSON.stringify({ error: 'Invalid client metadata' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const uuid = meta.uuid;
    if (meta.source === 'agent') {
      const patch = projectAgentClientMetadata(isObjectPayload(meta.client) ? meta.client : meta);
      const client = await this.upsertAdminClientSnapshot({ uuid, ...patch }, true);
      if (client) this.broadcastMetadataChanged({ clients: { upsert: [client] } });
      return Response.json({ success: true });
    }
    const previous = this.clients.get(uuid) || this.lastKnownClients.get(uuid);
    const client = isObjectPayload(meta.client)
      ? meta.client
      : { uuid, name: typeof meta.name === 'string' ? meta.name : previous?.name || uuid, hidden: booleanField(meta, 'hidden') };
    // The durable control row owns name/visibility for both live and retained
    // reports, so rewriting a possibly newer metric snapshot is unnecessary.
    await this.upsertAdminClientSnapshot(client);
    const cached = this.clients.get(uuid);
    const current = cached && (!cached.expiresAt || cached.expiresAt > Date.now()) ? cached : undefined;
    if (cached && !current) this.clients.delete(uuid);
    const retained = cached || this.lastKnownClients.get(uuid);
    const next = retained ? this.controlledClientState(retained) : null;
    if (next) {
      this.lastKnownClients.set(uuid, { ...next, lastReport: compactLiveReport(next.lastReport) });
      if (current) this.clients.set(uuid, next);
      const session = this.sessions.get(uuid);
      if (current && session?.readyState === WebSocket.READY_STATE_OPEN) {
        this.rememberAgentReportAttachment(
          session,
          uuid,
          next.name,
          next.hidden,
          next.lastReport,
          next.lastReportTime,
          next.expiresAt,
        );
      }

      if (next.hidden) {
        this.broadcastToViewers({
          type: 'remove',
          client: uuid,
          timestamp: Date.now(),
        }, 'public');
        if (current) {
          this.broadcastToViewers({
            type: 'update',
            client: uuid,
            name: next.name,
            data: next.lastReport,
            timestamp: next.lastReportTime,
          }, 'admin');
        } else {
          this.broadcastOfflineClient(next, Date.now());
        }
      } else if (current) {
        this.broadcastToViewers({
          type: 'update',
          client: uuid,
          name: next.name,
          data: next.lastReport,
          timestamp: next.lastReportTime,
        }, 'all');
      } else {
        this.broadcastOfflineClient(next, Date.now());
      }
    }
    this.broadcastMetadataChanged({
      clients: { upsert: [{ ...client, hidden: booleanField(meta, 'hidden') }] },
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async removeClient(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, HTTP_CLIENT_META_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const meta = parsed.body;
    if (!isObjectPayload(meta) || typeof meta.uuid !== 'string' || meta.uuid.trim() === '') {
      return new Response(JSON.stringify({ error: 'Invalid client metadata' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const keepMetadata = meta.keepMetadata === true;
    if (this.clientReportWrites.has(meta.uuid)) {
      this.clientRemovalVersions.set(meta.uuid, (this.clientRemovalVersions.get(meta.uuid) || 0) + 1);
    }
    const existing = this.clients.get(meta.uuid) || this.lastKnownClients.get(meta.uuid);
    const session = this.sessions.get(meta.uuid);
    if (session && session.readyState === WebSocket.READY_STATE_OPEN) {
      try {
        session.close(1008, 'Client removed');
      } catch {
        // Best effort only.
      }
    }
    this.sessions.delete(meta.uuid);
    this.sessionRoles.delete(meta.uuid);
    this.clients.delete(meta.uuid);
    this.lastKnownClients.delete(meta.uuid);
    await this.state.storage.delete(`${HTTP_LIVE_STATE_PREFIX}${meta.uuid}`);
    await this.removeAgentAuthByUuid(String(meta.uuid));
    if (!keepMetadata) {
      await this.removeAdminClientSnapshot(String(meta.uuid));
    }
    if (existing) {
      this.broadcastToViewers({
        type: 'remove',
        client: meta.uuid,
        timestamp: Date.now(),
      }, existing.hidden ? 'admin' : 'all');
    }
    if (!keepMetadata) {
      this.broadcastMetadataChanged({ clients: { remove: [String(meta.uuid)] } });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private sanitizeAdminClientSnapshotItem(client: JsonObject): JsonObject | null {
    const uuid = typeof client.uuid === 'string' ? client.uuid.trim() : '';
    if (!uuid) return null;
    const { token: _token, token_hash: _tokenHash, ...safe } = client;
    for (const field of ['ipv4', 'ipv6'] as const) {
      const value = safe[field];
      if (typeof value === 'string' && value.trim() !== '' && !isPublicIpAddress(value)) {
        safe[field] = '';
      }
    }
    safe.has_ipv4 = isPublicIpAddress(String(safe.ipv4 || ''));
    safe.has_ipv6 = isPublicIpAddress(String(safe.ipv6 || ''));
    return { ...safe, uuid };
  }

  private async readAdminClientsSnapshot(): Promise<AdminClientsSnapshot | null> {
    const snapshot = await this.state.storage.get<AdminClientsSnapshot>(ADMIN_CLIENTS_SNAPSHOT_KEY);
    if (!snapshot || !Array.isArray(snapshot.clients)) {
      this.adminClientsUpdatedAt = 0;
      this.adminClientsSnapshot = null;
      this.adminClientMetadata.clear();
      return null;
    }
    const normalized = {
      clients: snapshot.clients.filter(isObjectPayload),
      complete: snapshot.complete !== false,
      updatedAt: Number(snapshot.updatedAt || 0),
      removed: Array.isArray(snapshot.removed)
        ? snapshot.removed.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.trim() !== '')
        : [],
    };
    this.rememberAdminClientsSnapshot(normalized);
    return normalized;
  }

  private rememberAdminClientsSnapshot(snapshot: AdminClientsSnapshot): void {
    this.adminClientsSnapshot = snapshot;
    this.adminClientsUpdatedAt = snapshot.updatedAt;
    this.adminClientMetadata = new Map(snapshot.clients.map(client => [String(client.uuid), client]));
  }

  private async storeAdminClientsSnapshot(snapshot: AdminClientsSnapshot): Promise<void> {
    await this.state.storage.put(ADMIN_CLIENTS_SNAPSHOT_KEY, snapshot);
    this.rememberAdminClientsSnapshot(snapshot);
  }

  private async writeAdminClientsSnapshot(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, HTTP_ADMIN_CLIENTS_SNAPSHOT_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const clients = Array.isArray(parsed.body.clients)
      ? parsed.body.clients.filter(isObjectPayload).map(client => this.sanitizeAdminClientSnapshotItem(client)).filter((client): client is JsonObject => Boolean(client))
      : [];
    const previous = await this.readAdminClientsSnapshot();
    const reorder = parsed.body.mode === 'reorder';
    // A cache read cannot replace changes that committed after its read began.
    // Unversioned writes only seed an object that has no management snapshot.
    if (!reorder && (previous || Object.hasOwn(parsed.body, 'expected_version')) &&
      parsed.body.expected_version !== (previous?.updatedAt ?? null)) {
      return Response.json({ error: 'Client metadata changed while the database was being read' }, { status: 409 });
    }
    const confirmed = new Set(!reorder && Array.isArray(parsed.body.confirmed_removed)
      ? parsed.body.confirmed_removed.filter((uuid): uuid is string => typeof uuid === 'string') : []);
    const removed = (previous?.removed || []).filter(uuid => !confirmed.has(uuid));
    const removedSet = new Set(previous?.removed || []);
    let nextClients = clients.filter(client => !removedSet.has(String(client.uuid)));
    if (reorder && previous) {
      const orders = new Map(clients.map(client => [String(client.uuid), client.sort_order]));
      nextClients = previous.clients.map(client => {
        const order = orders.get(String(client.uuid));
        return typeof order === 'number' && Number.isSafeInteger(order) && order > 0
          ? { ...client, sort_order: order } : client;
      });
    }
    const updatedAt = Math.max(Date.now(), (previous?.updatedAt || 0) + 1);
    await this.storeAdminClientsSnapshot({
      clients: nextClients, updatedAt, removed, complete: reorder && previous ? previous.complete !== false : true,
    });
    return Response.json({ success: true, count: nextClients.length });
  }

  private async upsertAdminClientSnapshot(client: JsonObject, fromAgent = false): Promise<JsonObject | null> {
    const safe = this.sanitizeAdminClientSnapshotItem(client);
    if (!safe) return null;
    const snapshot = await this.readAdminClientsSnapshot();
    if (!snapshot) {
      if (!fromAgent) {
        const updatedAt = Math.max(Date.now(), (this.adminClientsUpdatedAt || 0) + 1);
        await this.storeAdminClientsSnapshot({
          clients: [safe], updatedAt, removed: [], complete: false,
        });
        return safe;
      }
      // No management snapshot yet: only a currently live node can supply the
      // visibility/name. Captured values from before external I/O may be stale.
      const current = this.clients.get(String(safe.uuid));
      return fromAgent && current ? { ...safe, name: current.name, hidden: current.hidden } : null;
    }
    const clients = snapshot.clients;
    const byUuid = new Map(clients.map(item => [String(item.uuid || ''), item]));
    const previous = byUuid.get(String(safe.uuid));
    // An Agent can update technical fields, but cannot recreate deleted metadata
    // or clear a tombstone after an administrator removed the node during I/O.
    if (fromAgent && (!previous || snapshot.removed?.includes(String(safe.uuid)))) return null;
    const merged = { ...(previous || {}), ...safe };
    byUuid.set(String(safe.uuid), merged);
    const updatedAt = Math.max(Date.now(), (snapshot.updatedAt || 0) + 1);
    await this.storeAdminClientsSnapshot({
      clients: [...byUuid.values()],
      updatedAt,
      removed: (snapshot?.removed || []).filter(item => item !== safe.uuid),
      complete: snapshot.complete !== false,
    });
    return merged;
  }

  private async removeAdminClientSnapshot(uuid: string): Promise<void> {
    const snapshot = await this.readAdminClientsSnapshot();
    const updatedAt = Math.max(Date.now(), (snapshot?.updatedAt || 0) + 1);
    await this.storeAdminClientsSnapshot({
      clients: (snapshot?.clients || []).filter(client => client.uuid !== uuid),
      updatedAt,
      removed: [uuid, ...(snapshot?.removed || []).filter(item => item !== uuid)].slice(0, 200),
      complete: snapshot ? snapshot.complete !== false : false,
    });
  }

  private async updateHttpClientReport(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, HTTP_CLIENT_REPORT_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const payload = parsed.body;
    const reports = Array.isArray(payload?.reports)
      ? payload.reports.slice(0, AGENT_REPORT_MAX_BATCH).filter(isObjectPayload)
      : isObjectPayload(payload?.report)
        ? [payload.report]
        : [];
    if (!payload || typeof payload.uuid !== 'string' || payload.uuid.trim() === '' || reports.length === 0) {
      return new Response(JSON.stringify({ error: 'Invalid client report' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const clientId = payload.uuid;
    return this.runClientReport(clientId, async lifecycle => {
      const network: ReportNetworkMetadata = {
        sourceIp: stringField(payload, 'source_ip'),
        region: stringField(payload, 'region'),
      };
      const now = lifecycle.receivedAt;
      const ttlMs = this.boundedHttpTtlMs(payload.ttl_ms);
      const control = await this.resolveReportClientControl(clientId,
        typeof payload.name === 'string' && payload.name.trim() !== '' ? payload.name.trim() : clientId,
        booleanField(payload, 'hidden'));
      this.assertReportCurrent(lifecycle);
      const clientName = control.name;
      const hidden = control.hidden;
      const reportsToPersist: Array<{ report: JsonObject; reportTime: number }> = [];
      for (let index = 0; index < reports.length; index += 1) {
        this.assertReportCurrent(lifecycle);
        const rawReport = reports[index];
        const reportTime = this.reportTimestamp(rawReport, now);
        const isLast = index === reports.length - 1;
        if (isLast) {
          const report = await this.updateClientReport(
            lifecycle, clientName, hidden, rawReport, now + ttlMs, undefined, network,
          );
          reportsToPersist.push({ report, reportTime });
        } else {
          reportsToPersist.push({ report: rawReport, reportTime });
        }
        await this.persistPingResultsFromReport(clientId, rawReport, reportTime);
        this.assertReportCurrent(lifecycle);
        await this.persistWebsiteProbeResultsFromReport(clientId, rawReport, reportTime);
        this.assertReportCurrent(lifecycle);
      }

      await this.scheduleExpiryAlarm(now);
      this.assertReportCurrent(lifecycle);
      const basicInfoReport = this.latestBasicInfoReport(reports);
      if (basicInfoReport) {
        await this.syncBasicInfoFromReport(clientId, clientName, hidden, basicInfoReport, lifecycle);
        this.assertReportCurrent(lifecycle);
      }
      this.runBackground('do_record_persistence', this.persistReportsSequential(clientId, reportsToPersist));

      return Response.json({ success: true, persisted: false, queued: true });
    }).catch(() => Response.json({ error: 'Report was not accepted; retry this report' }, { status: 503 }));
  }

  private reportTimestamp(report: JsonObject, fallback: number): number {
    const parsed = Number(report.timestamp);
    const now = Date.now();
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < 0 || parsed > now + 60_000) return fallback;
    return parsed;
  }

  private pingResultsFromReport(report: JsonObject): unknown[] {
    if (Array.isArray(report.ping_results)) return report.ping_results;
    const ping = report.ping;
    if (isObjectPayload(ping) && Array.isArray(ping.results)) return ping.results;
    return [];
  }

  private latestBasicInfoReport(reports: JsonObject[]): JsonObject | null {
    for (let index = reports.length - 1; index >= 0; index -= 1) {
      if (isObjectPayload(reports[index].basic_info)) return reports[index];
    }
    return null;
  }

  private isUsefulRegion(region: string): boolean {
    const text = region.trim();
    return text !== '' && !isUnknownRegionValue(text);
  }

  private async syncBasicInfoFromReport(clientId: string, _clientName: string, _hidden: boolean, report: JsonObject, lifecycle?: ReportLifecycle): Promise<void> {
    if (lifecycle) this.assertReportCurrent(lifecycle);
    const basicInfo = report.basic_info;
    if (!isObjectPayload(basicInfo)) return;
    const patch: Record<string, unknown> = {};
    const stringFields = [
      'cpu_name',
      'virtualization',
      'arch',
      'os',
      'kernel_version',
      'gpu_name',
      'ipv4',
      'ipv6',
      'region',
      'version',
    ];
    const numberFields = ['cpu_cores', 'mem_total', 'swap_total', 'disk_total'];
    for (const field of stringFields) {
      const value = basicInfo[field];
      if (typeof value === 'string' && value.trim() !== '') {
        const text = value.trim();
        if (field === 'ipv4' || field === 'ipv6') {
          if (!isPublicIpAddress(text)) continue;
        }
        if (field === 'region' && !this.isUsefulRegion(text)) continue;
        patch[field] = text;
      }
    }
    for (const field of numberFields) {
      if (field === 'disk_total' && (basicInfo[field] === null || basicInfo[field] === 0)) {
        patch[field] = 0;
        continue;
      }
      const value = Number(basicInfo[field]);
      if (Number.isFinite(value) && (field === 'swap_total' ? value >= 0 : value > 0)) {
        patch[field] = value;
      }
    }
    if (Object.keys(patch).length === 0) return;
    const signature = JSON.stringify(patch);
    try {
      await this.runClientMetadataSync(clientId, async () => {
        if (lifecycle) this.assertReportCurrent(lifecycle);
        if (this.basicInfoSignatures.get(clientId) === signature) return;
        const database = this.getQueryDatabase();
        if (!database) return;
        await db.updateClient(database, clientId, patch as Partial<db.Client>);
        if (lifecycle) this.assertReportCurrent(lifecycle);
        const clientPatch = await this.upsertAdminClientSnapshot({ uuid: clientId, ...patch }, true);
        this.basicInfoSignatures.set(clientId, signature);
        if (clientPatch) this.broadcastMetadataChanged({ clients: { upsert: [clientPatch] } });
      });
    } catch (error) {
      // No successful signature was committed: the unacknowledged report retries.
      const database = this.getQueryDatabase();
      if (database) {
        await bestEffortRecordHealthEvent(database, 'do_basic_info_sync', 'error',
          `basic info persist failed for ${clientId}: ${errorDetail(error)}`, { auditAction: 'do_basic_info_sync_error' });
      }
      throw error;
    }
  }

  private async persistPingResultsFromReport(clientId: string, report: JsonObject, nowMs: number): Promise<void> {
    const results = this.pingResultsFromReport(report);
    if (results.length === 0) return;
    await this.persistPingResult(clientId, { results }, nowMs);
  }

  private websiteProbeResultsFromReport(report: JsonObject): JsonObject[] {
    const results = report.website_probe_results;
    return Array.isArray(results) ? results.slice(0, 50).filter(isObjectPayload) : [];
  }

  private async persistWebsiteProbeResultsFromReport(clientId: string, report: JsonObject, nowMs: number): Promise<void> {
    const results = this.websiteProbeResultsFromReport(report);
    if (results.length === 0) return;
    const database = this.getQueryDatabase();
    if (!database) return;

    try {
      if (!(await this.isRecordPersistenceEnabled(nowMs))) return;
      if (!(await this.canPersistWithinCapacity(nowMs))) return;

      const assigned = new Set((await this.getWebsiteProbeTasks(nowMs, clientId, true)).map(task => task.id));
      if (assigned.size === 0) return;
      const checkedAt = new Date(nowMs).toISOString();
      let changed = false;
      const fallbackChecked = new Set<number>();
      for (const item of results) {
        const monitorId = Number(item.monitor_id);
        const configRevision = item.config_revision;
        const latencyMs = Math.round(Number(item.latency_ms));
        const statusCode = item.status_code === null || item.status_code === undefined ? null : Number(item.status_code);
        const rawStatusCode = item.raw_status_code === null || item.raw_status_code === undefined ? statusCode : Number(item.raw_status_code);
        const effectiveStatus = item.effective_status === 'up' ? 'up' : item.effective_status === 'down' ? 'down' : null;
        if (
          !Number.isInteger(monitorId) ||
          !assigned.has(monitorId) ||
          typeof configRevision !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(configRevision) ||
          !Number.isFinite(latencyMs) ||
          latencyMs < 0 ||
          latencyMs > 60_000 ||
          !effectiveStatus ||
          (statusCode !== null && (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) ||
          (rawStatusCode !== null && (!Number.isInteger(rawStatusCode) || rawStatusCode < 100 || rawStatusCode > 599))
        ) {
          continue;
        }
        const updated = await db.recordWebsiteCheck(database, {
          monitor_id: monitorId,
          config_revision: configRevision,
          checked_at: checkedAt,
          ok: Boolean(item.ok) && effectiveStatus === 'up',
          effective_status: effectiveStatus,
          effective_reason: typeof item.effective_reason === 'string' ? item.effective_reason.slice(0, 80) : effectiveStatus,
          status_code: statusCode,
          raw_status_code: rawStatusCode,
          latency_ms: latencyMs,
          error: typeof item.error === 'string' && item.error ? item.error.slice(0, 120) : null,
          source_type: 'agent',
          source_client: clientId,
        });
        if (!updated) continue;
        changed = true;

        if (effectiveStatus === 'down' && updated.agent_probe_status_enabled && !fallbackChecked.has(monitorId)) {
          fallbackChecked.add(monitorId);
          const fallbackCheck = await checkWebsiteMonitorHttp(updated);
          const fallbackUpdated = await db.recordWebsiteCheck(database, fallbackCheck);
          changed = Boolean(fallbackUpdated) || changed;
        }
      }
      if (changed) this.broadcastMetadataChanged({ websites: true });
    } catch (error) {
      await bestEffortRecordHealthEvent(
        database,
        'website_probe_persistence',
        'error',
        `website probe persist failed for ${clientId}: ${errorDetail(error)}`,
        { auditAction: 'website_probe_persistence_error' },
      );
      throw error;
    }
  }

  private async restoreClients(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, MAX_BACKUP_BYTES);
    if ('response' in parsed) return parsed.response;
    if (!Array.isArray(parsed.body.clients) || parsed.body.clients.length > 1000 ||
      parsed.body.clients.some(client => !isObjectPayload(client))) {
      return Response.json({ error: 'Invalid restored client list' }, { status: 400 });
    }
    const clients = parsed.body.clients.map(restoredClientMetadata);
    if (clients.some(client => !client.uuid) || new Set(clients.map(client => client.uuid)).size !== clients.length) {
      return Response.json({ error: 'Invalid or duplicate restored client UUID' }, { status: 400 });
    }
    if (!measureRestoredClientSnapshot(clients, false).fits) {
      return Response.json({ error: 'Restored client snapshot exceeds the safe storage size' }, { status: 413 });
    }

    // A restore is a rare whole-configuration transition. Only local storage is
    // awaited in this gate; no database or other external I/O can hold it open.
    return this.state.blockConcurrencyWhile(async () => {
      this.restoreVersion += 1;
      const previous = await this.readAdminClientsSnapshot();
      const updatedAt = Math.max(Date.now(), (previous?.updatedAt || 0) + 1);
      for (const prefix of [HTTP_LIVE_STATE_PREFIX, AGENT_AUTH_SNAPSHOT_PREFIX, AGENT_AUTH_UUID_PREFIX]) {
        while (true) {
          const entries = await this.state.storage.list({ prefix, limit: 128 });
          if (entries.size === 0) break;
          await this.state.storage.delete([...entries.keys()]);
        }
      }
      await this.storeAdminClientsSnapshot({ clients, updatedAt, removed: [], complete: true });
      for (const socket of new Set([...this.sessions.values(), ...this.state.getWebSockets()])) {
        const attachment = this.getSessionAttachment(socket);
        if (attachment?.role !== 'agent') continue;
        try { socket.close(1008, 'Client configuration restored'); } catch {}
        this.sessions.delete(attachment.clientId);
        this.sessionRoles.delete(attachment.clientId);
      }
      this.clients.clear();
      this.lastKnownClients.clear();
      this.networkMetadataSignatures.clear();
      this.basicInfoSignatures.clear();
      this.trafficResetDays.clear();
      this.trafficResetDaysAt = 0;
      this.recordPersistenceCheckedAt = 0;
      this.policySettingsCheckedAt = 0;
      this.invalidatePingTasksCache();
      this.invalidateWebsiteProbeTasksCache();
      this.broadcastMetadataChanged({ clients: true });
      for (const [id, socket] of this.sessions) {
        if (this.sessionRoles.get(id) === 'viewer') this.sendSnapshot(socket);
      }
      await this.scheduleExpiryAlarm(Date.now());
      return Response.json({ success: true, count: clients.length, version: updatedAt });
    });
  }

  // HTTP 请求处理（用于 Agent 上报数据）
  async fetch(request: Request): Promise<Response> {
    await this.httpClientsReady;
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/clients-restore') {
      return this.restoreClients(request);
    }

    if (request.method === 'POST' && url.pathname === '/client-meta') {
      return this.updateClientMeta(request);
    }

    if (request.method === 'POST' && url.pathname === '/client-remove') {
      return this.removeClient(request);
    }

    if (request.method === 'POST' && url.pathname === '/agent-auth') {
      return this.upsertAgentAuthSnapshot(request);
    }

    if (request.method === 'POST' && url.pathname === '/agent-auth/lookup') {
      return this.lookupAgentAuthSnapshot(request);
    }

    if (request.method === 'POST' && url.pathname === '/agent-auth/remove') {
      return this.removeAgentAuthSnapshot(request);
    }

    if (request.method === 'POST' && url.pathname === '/offline-evaluate') {
      return this.evaluateOfflineLiveness(request);
    }

    if (request.method === 'GET' && url.pathname === '/admin-clients-snapshot') {
      const snapshot = await this.readAdminClientsSnapshot();
      return snapshot
        ? Response.json(snapshot)
        : Response.json({ error: 'Snapshot missing' }, { status: 404 });
    }

    if (request.method === 'PUT' && url.pathname === '/admin-clients-snapshot') {
      return this.writeAdminClientsSnapshot(request);
    }

    if (request.method === 'POST' && url.pathname === '/client-report') {
      return this.updateHttpClientReport(request);
    }

    if (request.method === 'POST' && url.pathname === '/ping-result') {
      return this.updateHttpPingResult(request);
    }

    if (request.method === 'POST' && url.pathname === '/policy-refresh') {
      this.invalidateWebsiteProbeTasksCache();
      await this.broadcastAgentPolicy(Date.now(), false, true);
      return Response.json({ success: true });
    }

    if (request.method === 'POST' && url.pathname === '/record-settings-refresh') {
      await this.isRecordPersistenceEnabled(Date.now(), true);
      this.invalidateRecordCapacityMemorySnapshot();
      return Response.json({ success: true });
    }

    if (request.method === 'POST' && url.pathname === '/ping-tasks-refresh') {
      this.invalidatePingTasksCache();
      this.invalidateWebsiteProbeTasksCache();
      await this.broadcastAgentPolicy(Date.now(), false, true);
      return Response.json({ success: true });
    }

    if (request.method === 'POST' && url.pathname === '/metadata-refresh') {
      const parsed = await parseJsonRequestWithLimit(request, HTTP_CLIENT_META_MAX_BODY_BYTES);
      if ('response' in parsed) return parsed.response;
      // audience 只用于投递范围，不进广播载荷
      const { audience, ...detail } = parsed.body as JsonObject & { audience?: unknown };
      const target = audience === 'public' || audience === 'admin' ? audience : 'all';
      if (isObjectPayload(detail.clients)) {
        const snapshot = await this.readAdminClientsSnapshot();
        if (snapshot) {
          const current = new Map(snapshot.clients.map(client => [String(client.uuid), client]));
          const removed = new Set(snapshot.removed || []);
          const patch = detail.clients;
          detail.clients = {
            ...(Array.isArray(patch.upsert) ? { upsert: patch.upsert.filter(isObjectPayload)
              .map(client => removed.has(String(client.uuid)) ? undefined : current.get(String(client.uuid)))
              .filter((client): client is JsonObject => Boolean(client)) } : {}),
            ...(Array.isArray(patch.remove) ? { remove: patch.remove.filter((uuid): uuid is string =>
              typeof uuid === 'string' && (!current.has(uuid) || removed.has(uuid))) } : {}),
          };
        }
      }
      this.broadcastMetadataChanged(detail, target);
      return Response.json({ success: true });
    }

    if (request.method === 'GET' && url.pathname === '/policy') {
      return Response.json(await this.buildAgentPolicy(Date.now(), false));
    }

    // WebSocket 升级
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const clientId = url.searchParams.get('id') || crypto.randomUUID();
      const clientName = url.searchParams.get('name') || clientId;
      const hidden = url.searchParams.get('hidden') === '1' || url.searchParams.get('hidden') === 'true';
      const role = url.searchParams.get('role') === 'agent' ? 'agent' : 'viewer';
      const viewerIp = url.searchParams.get('viewer_ip') || undefined;
      const sourceIp = url.searchParams.get('source_ip') || undefined;
      const region = url.searchParams.get('region') || undefined;
      const now = Date.now();
      const activeViewersBefore = this.activeViewerCount(now);

      if (role === 'viewer') {
        const limitResponse = this.enforceViewerConnectionLimit(viewerIp);
        if (limitResponse) return limitResponse;
        await this.getAgentPolicySettings(now);
      }

      const oldSession = role === 'agent' ? this.sessions.get(clientId) : undefined;
      if (oldSession && oldSession.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          oldSession.close(1000, 'Replaced by a new connection');
        } catch {
          // Best effort only.
        }
      }

      // viewer 窗口由 DO 自己的设置决定（已缓存，无需额外查库）。
      // 显式传参仍然优先，便于覆盖与向后兼容；缺省时才回落到设置项，
      // 从而消除"对外宣称 X 秒、实际执行写死的 120 秒"这一不一致。
      const viewerTtlParam = url.searchParams.get('viewer_ttl_ms');
      const viewerTtlMs = viewerTtlParam !== null
        ? normalizeViewerTtlMs(viewerTtlParam)
        : normalizeViewerTtlMs(this.policySettings.viewerTtlSec * 1000);

      const attachment: SessionAttachment = {
        role,
        clientId,
        clientName,
        hidden,
        ...(role === 'viewer' && viewerIp ? { viewerIp } : {}),
        ...(role === 'viewer' ? { viewerExpiresAt: now + viewerTtlMs } : {}),
        ...(role === 'viewer' && (url.searchParams.get('include_hidden') === '1' || url.searchParams.get('include_hidden') === 'true') ? { includeHidden: true } : {}),
        ...(role === 'agent' && sourceIp && isPublicIpAddress(sourceIp) ? { sourceIp } : {}),
        ...(role === 'agent' && region && this.isUsefulRegion(region) ? { region } : {}),
      };
      this.registerSession(server, attachment);
      this.state.acceptWebSocket(server);

      if (role === 'viewer') {
        this.sendSnapshot(server);
        this.runBackground('do_viewer_expiry', this.scheduleExpiryAlarm(now));
        if (activeViewersBefore === 0) {
          this.runBackground('do_agent_policy', this.broadcastAgentPolicy(now, true));
        }
      } else {
        this.runBackground('do_agent_policy', this.sendCurrentPolicyToAgent(server, now, false, false, clientId));
      }

      const requestedProtocols = (request.headers.get('Sec-WebSocket-Protocol') || '')
        .split(',')
        .map(protocol => protocol.trim());
      const headers = requestedProtocols.includes(LIVE_VIEWER_WS_PROTOCOL)
        ? { 'Sec-WebSocket-Protocol': LIVE_VIEWER_WS_PROTOCOL }
        : undefined;
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    // HTTP GET - 获取缓存的实时数据
    if (request.method === 'GET') {
      const includeHidden = url.searchParams.get('include_hidden') === '1' || url.searchParams.get('include_hidden') === 'true';
      return new Response(JSON.stringify(await this.buildSnapshotWithMetadataVersion(includeHidden)), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleMessage(clientId: string, clientName: string, hidden: boolean, data: Record<string, unknown>, ws: WebSocket) {
    if (data?.type === 'ping_result') {
      await this.resolveReportClientControl(clientId, clientName, hidden);
      this.runBackground('ping_persistence', this.persistPingResult(clientId, data, Date.now()));
      return;
    }

    return this.runClientReport(clientId, async lifecycle => {
      const now = lifecycle.receivedAt;
      const control = await this.resolveReportClientControl(clientId, clientName, hidden);
      this.assertReportCurrent(lifecycle);
      clientName = control.name;
      hidden = control.hidden;
      const reports = data?.type === 'reports' && Array.isArray(data.reports)
        ? data.reports.slice(0, AGENT_REPORT_MAX_BATCH).filter(isObjectPayload)
        : [unwrapMonitorReportEnvelope(data)];
      const reportsToPersist: Array<{ report: JsonObject; reportTime: number }> = [];
      for (let index = 0; index < reports.length; index += 1) {
        this.assertReportCurrent(lifecycle);
        const rawReport = reports[index];
        const reportTime = this.reportTimestamp(rawReport, now);
        const isLast = index === reports.length - 1;
        if (isLast) {
          const report = await this.updateClientReport(lifecycle, clientName, hidden, rawReport, undefined, ws);
          reportsToPersist.push({ report, reportTime });
        } else {
          reportsToPersist.push({ report: rawReport, reportTime });
        }
        await this.persistPingResultsFromReport(clientId, rawReport, reportTime);
        this.assertReportCurrent(lifecycle);
        await this.persistWebsiteProbeResultsFromReport(clientId, rawReport, reportTime);
        this.assertReportCurrent(lifecycle);
      }

      const basicInfoReport = this.latestBasicInfoReport(reports);
      if (basicInfoReport) {
        await this.syncBasicInfoFromReport(clientId, clientName, hidden, basicInfoReport, lifecycle);
      }
      this.assertReportCurrent(lifecycle);
      if (this.sessions.get(clientId) === ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ack', timestamp: now }));
        } catch {
          // 忽略 ack 发送错误
        }
      }
      this.runBackground('do_agent_policy', this.sendCurrentPolicyToAgent(ws, now, false, false, clientId));
      this.runBackground('do_record_persistence', this.persistReportsSequential(clientId, reportsToPersist));
    });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.httpClientsReady;
    const attachment = this.getSessionAttachment(ws);
    if (!attachment || attachment.role !== 'agent') return;
    const messageBytes = typeof message === 'string'
      ? new TextEncoder().encode(message).byteLength
      : message.byteLength;
    if (messageBytes > AGENT_WS_MAX_MESSAGE_BYTES) {
      try {
        ws.close(1009, 'Message too large');
      } catch {
        // Ignore close errors.
      }
      return;
    }
    try {
      const data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
      if (!isObjectPayload(data)) return;
      await this.handleMessage(attachment.clientId, attachment.clientName, attachment.hidden, data, ws);
    } catch {
      // A rejected report must be observable by the Agent rather than looking
      // like a successfully accepted message with missing history.
      if (ws.readyState === WebSocket.READY_STATE_OPEN) {
        try { ws.send(JSON.stringify({ type: 'error', code: 'REPORT_REJECTED', error: 'Invalid or unsupported Agent report' })); } catch {}
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.httpClientsReady;
    const attachment = this.getSessionAttachment(ws);
    if (attachment) {
      const wasViewer = attachment.role === 'viewer';
      const activeViewersBefore = this.activeViewerCount(Date.now());
      this.cleanupSession(ws, attachment);
      if (wasViewer && activeViewersBefore > 0) {
        await this.broadcastAgentPolicy(Date.now(), false);
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.httpClientsReady;
    const attachment = this.getSessionAttachment(ws);
    if (attachment) {
      const wasViewer = attachment.role === 'viewer';
      const activeViewersBefore = this.activeViewerCount(Date.now());
      this.cleanupSession(ws, attachment);
      if (wasViewer && activeViewersBefore > 0) {
        await this.broadcastAgentPolicy(Date.now(), false);
      }
    }
  }

  async alarm(): Promise<void> {
    await this.httpClientsReady;
    const now = Date.now();
    await this.removeExpiredClients(now);
    this.removeExpiredViewers(now);
    await this.broadcastAgentPolicy(now, false);
    await this.scheduleExpiryAlarm(now);
  }

  /**
   * 离线判活。
   *
   * 为什么不能沿用 `max(records.time)`：那是被落库节流过滤后的历史数据，
   * 每客户端每 120 秒最多写一行，且重连补发的那条通常会被节流吃掉，
   * 于是「最后一条记录的时间」会比「最后一次上报」落后 100~330 秒，
   * 撞上宽限期就产生误报。而 `this.clients` 里的 `lastReportTime`
   * **每条上报都会刷新**，且随 WebSocket attachment 一起持久化，休眠重建不丢。
   *
   * 连续确认：单次判定可能因为 DO 刚重启、attachment 尚未恢复而偏悲观，
   * 因此这里维护每客户端的连续离线次数，由调用方决定达到几次才真正告警。
   * 只要有一次判定在线，计数立即清零。
   */
  private async evaluateOfflineLiveness(request: Request): Promise<Response> {
    let payload: JsonObject;
    try {
      payload = await request.json() as JsonObject;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const now = Date.now();
    const items = Array.isArray(payload.clients) ? payload.clients : [];
    const results: Record<string, {
      lastSeen: number | null;
      offline: boolean;
      streak: number;
    }> = {};

    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as JsonObject;
      const uuid = typeof entry.uuid === 'string' ? entry.uuid : '';
      if (!uuid) continue;
      const graceMs = Number(entry.graceMs);
      if (!Number.isFinite(graceMs) || graceMs <= 0) continue;

      const live = this.clients.get(uuid);
      const lastSeen = live && Number.isFinite(live.lastReportTime) ? live.lastReportTime : null;
      // 调用方可传入数据库侧的最后记录时间，两者取较新——DO 刚重启且 attachment
      // 尚未恢复时，数据库的值可以兜底，避免把在线节点判成离线。
      const fallback = Number(entry.fallbackLastSeen);
      const effective = Math.max(
        lastSeen ?? 0,
        Number.isFinite(fallback) && fallback > 0 ? fallback : 0,
      );
      const offline = effective <= 0 || now - effective >= graceMs;

      const streakKey = `offline:streak:${uuid}`;
      let streak = 0;
      if (offline) {
        const stored = Number(await this.state.storage.get<number>(streakKey) || 0);
        streak = (Number.isFinite(stored) ? stored : 0) + 1;
        await this.state.storage.put(streakKey, streak);
      } else {
        await this.state.storage.delete(streakKey);
      }

      results[uuid] = {
        lastSeen: effective > 0 ? effective : null,
        offline,
        streak,
      };
    }

    return Response.json({ ok: true, now, clients: results });
  }

  private async isPersistDue(clientId: string, now: number): Promise<boolean> {
    const storageKey = `record:persist:${clientId}`;
    let lastPersist = this.recordLastPersistAt.get(clientId);
    if (lastPersist === undefined) {
      lastPersist = Number(await this.state.storage.get<number>(storageKey) || 0);
      this.recordLastPersistAt.set(clientId, lastPersist);
    }
    // 用带提前量的判定：上报间隔与落库间隔相等时，抖动导致的「早到几毫秒」
    // 不应跳过本轮落库，否则 last_time 会拉开到两倍间隔并误报离线。
    return isRecordPersistDue(now - lastPersist, this.recordPersistIntervalMs);
  }

  private async markPersistSuccess(clientId: string, now: number): Promise<void> {
    const storageKey = `record:persist:${clientId}`;
    await this.state.storage.put(storageKey, now);
    this.recordLastPersistAt.set(clientId, now);
  }

  private async persistReportsSequential(
    clientId: string,
    reports: Array<{ report: JsonObject; reportTime: number }>,
  ): Promise<void> {
    for (const item of reports) {
      await this.persistReport(clientId, item.report, item.reportTime);
    }
  }

  private async isRecordPersistenceEnabled(now: number, forceRefresh = false): Promise<boolean> {
    const database = this.getQueryDatabase();
    if (!database) return false;
    if (!forceRefresh && now - this.recordPersistenceCheckedAt < RECORD_SETTING_CACHE_MS) {
      return this.recordPersistenceEnabled;
    }

    try {
      const settings = buildAdminSettings(await db.getSettingsByKeys(database, RECORD_PERSISTENCE_SETTING_KEYS));
      this.recordPersistenceEnabled = normalizeRecordPersistenceEnabled(settings);
      const intervalSec = Number(settings.record_persist_interval_sec);
      const boundedIntervalSec = Number.isFinite(intervalSec)
        ? Math.min(Math.max(Math.floor(intervalSec), 3), 3600)
        : RECORD_PERSIST_INTERVAL_MS / 1000;
      this.recordPersistIntervalMs = Math.min(
        Math.max(boundedIntervalSec * 1000, MIN_RECORD_PERSIST_INTERVAL_MS),
        MAX_RECORD_PERSIST_INTERVAL_MS,
      );
      const pingIntervalSec = Number(settings.ping_record_persist_interval_sec);
      const boundedPingIntervalSec = Number.isFinite(pingIntervalSec)
        ? Math.min(Math.max(Math.floor(pingIntervalSec), 60), 3600)
        : PING_RECORD_PERSIST_INTERVAL_MS / 1000;
      this.pingRecordPersistIntervalMs = Math.min(
        Math.max(boundedPingIntervalSec * 1000, MIN_PING_RECORD_PERSIST_INTERVAL_MS),
        MAX_PING_RECORD_PERSIST_INTERVAL_MS,
      );
      const highWatermarkRows = Number(settings.record_high_watermark_rows);
      this.recordHighWatermarkRows = Number.isFinite(highWatermarkRows)
        ? Math.min(
          Math.max(Math.floor(highWatermarkRows), RECORD_HIGH_WATERMARK_MIN_ROWS),
          RECORD_HIGH_WATERMARK_MAX_ROWS,
        )
        : RECORD_HIGH_WATERMARK_DEFAULT_ROWS;
      const highWatermarkBytes = Number(settings.record_high_watermark_bytes);
      this.recordHighWatermarkBytes = Number.isFinite(highWatermarkBytes)
        ? Math.min(
          Math.max(Math.floor(highWatermarkBytes), RECORD_HIGH_WATERMARK_MIN_BYTES),
          RECORD_HIGH_WATERMARK_MAX_BYTES,
        )
        : RECORD_HIGH_WATERMARK_DEFAULT_BYTES;
      this.recordPersistenceCheckedAt = now;
    } catch (error) {
      await bestEffortRecordHealthEvent(
        database,
        'do_record_persistence',
        'error',
        `record persistence settings lookup failed: ${errorDetail(error)}`,
        { auditAction: 'do_record_persistence_error' },
      );
      this.recordPersistenceCheckedAt = now;
    }

    return this.recordPersistenceEnabled;
  }

  private capacityCheckDelayMs(): number {
    if (this.recordCapacityBlocked) return RECORD_CAPACITY_CACHE_CRITICAL_MS;
    if (this.recordHighWatermarkRows <= 0 || this.recordHighWatermarkBytes <= 0) return RECORD_CAPACITY_CACHE_NEAR_MS;
    // 两条熔断线取更紧张的那个比例：离任一条线近了都该查得更勤。
    const ratio = Math.max(
      this.recordCapacityRows / this.recordHighWatermarkRows,
      this.recordCapacityBytes / this.recordHighWatermarkBytes,
    );
    if (ratio >= 0.95) return RECORD_CAPACITY_CACHE_CRITICAL_MS;
    if (ratio >= 0.8) return RECORD_CAPACITY_CACHE_NEAR_MS;
    return RECORD_CAPACITY_CACHE_FAR_MS;
  }

  private applyRecordCapacitySnapshot(snapshot: RecordCapacitySnapshot): void {
    this.recordCapacityRows = snapshot.rows;
    this.recordCapacityBytes = snapshot.bytes;
    this.recordCapacityBlocked = snapshot.blocked;
    this.recordCapacityNextCheckAt = snapshot.nextCheckAt;
  }

  private normalizeRecordCapacitySnapshot(raw: unknown): RecordCapacitySnapshot | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<RecordCapacitySnapshot>;
    const rows = Number(value.rows);
    const bytes = Number(value.bytes);
    const checkedAt = Number(value.checkedAt);
    const nextCheckAt = Number(value.nextCheckAt);
    const highWatermarkRows = Number(value.highWatermarkRows);
    const highWatermarkBytes = Number(value.highWatermarkBytes);
    if (
      value.measurement !== 'live-row-bytes-plus-index-estimate' ||
      !Number.isFinite(rows) ||
      rows < 0 ||
      !Number.isFinite(bytes) ||
      bytes < 0 ||
      !Number.isFinite(highWatermarkBytes) ||
      highWatermarkBytes < RECORD_HIGH_WATERMARK_MIN_BYTES ||
      highWatermarkBytes > RECORD_HIGH_WATERMARK_MAX_BYTES ||
      !Number.isFinite(checkedAt) ||
      checkedAt <= 0 ||
      !Number.isFinite(nextCheckAt) ||
      nextCheckAt <= checkedAt ||
      !Number.isFinite(highWatermarkRows) ||
      highWatermarkRows < RECORD_HIGH_WATERMARK_MIN_ROWS ||
      highWatermarkRows > RECORD_HIGH_WATERMARK_MAX_ROWS
    ) {
      return null;
    }
    return {
      measurement: 'live-row-bytes-plus-index-estimate',
      rows,
      bytes,
      blocked: Boolean(value.blocked),
      checkedAt,
      nextCheckAt,
      highWatermarkRows,
      highWatermarkBytes,
    };
  }

  private isReusableRecordCapacitySnapshot(snapshot: RecordCapacitySnapshot, now: number): boolean {
    return snapshot.highWatermarkRows === this.recordHighWatermarkRows
      && snapshot.highWatermarkBytes === this.recordHighWatermarkBytes
      && snapshot.nextCheckAt > now;
  }

  private async readReusableRecordCapacitySnapshot(now: number): Promise<RecordCapacitySnapshot | null> {
    try {
      const snapshot = this.normalizeRecordCapacitySnapshot(
        await this.state.storage.get(RECORD_CAPACITY_SNAPSHOT_KEY),
      );
      if (snapshot && snapshot.highWatermarkRows === this.recordHighWatermarkRows
        && snapshot.highWatermarkBytes === this.recordHighWatermarkBytes) {
        // Preserve hysteresis across cold starts even when a new measurement is due.
        this.recordCapacityBlocked = snapshot.blocked;
      }
      if (!snapshot || !this.isReusableRecordCapacitySnapshot(snapshot, now)) return null;
      return snapshot;
    } catch {
      return null;
    }
  }

  private async writeRecordCapacitySnapshot(snapshot: RecordCapacitySnapshot): Promise<void> {
    try {
      await this.state.storage.put(RECORD_CAPACITY_SNAPSHOT_KEY, snapshot);
    } catch {
      // The in-memory snapshot still protects the current DO instance; the next cold start can safely recount.
    }
  }

  private invalidateRecordCapacityMemorySnapshot(): void {
    this.recordCapacityNextCheckAt = 0;
    this.recordCapacityRows = 0;
    this.recordCapacityBytes = 0;
    this.recordCapacityBlocked = false;
  }

  private async canPersistWithinCapacity(now: number): Promise<boolean> {
    const database = this.getQueryDatabase();
    if (!database) return false;
    if (now < this.recordCapacityNextCheckAt) {
      return !this.recordCapacityBlocked;
    }

    const storedSnapshot = await this.readReusableRecordCapacitySnapshot(now);
    if (storedSnapshot) {
      this.applyRecordCapacitySnapshot(storedSnapshot);
      return !this.recordCapacityBlocked;
    }

    try {
      // DELETE frees live tuples for reuse without necessarily shrinking allocated
      // files. Use the explicitly estimated live footprint; allocation is diagnostic.
      const usage = await db.getHistoryStorageUsage(database);
      this.recordCapacityRows = usage.live_rows;
      this.recordCapacityBytes = usage.estimated_live_storage_bytes;
      const decision = evaluateHistoryCapacity(usage, {
        rowLimit: this.recordHighWatermarkRows,
        byteLimit: this.recordHighWatermarkBytes,
        wasBlocked: this.recordCapacityBlocked,
      });
      this.recordCapacityBlocked = decision.blocked;
      this.recordCapacityNextCheckAt = now + this.capacityCheckDelayMs();
      await this.writeRecordCapacitySnapshot({
        measurement: 'live-row-bytes-plus-index-estimate',
        rows: this.recordCapacityRows,
        bytes: this.recordCapacityBytes,
        blocked: this.recordCapacityBlocked,
        checkedAt: now,
        nextCheckAt: this.recordCapacityNextCheckAt,
        highWatermarkRows: this.recordHighWatermarkRows,
        highWatermarkBytes: this.recordHighWatermarkBytes,
      });
      if (this.recordCapacityBlocked && now - this.recordCapacityLastAuditAt >= RECORD_CAPACITY_AUDIT_THROTTLE_MS) {
        this.recordCapacityLastAuditAt = now;
        // 写清楚是哪条线跳的：只报一个总数会让人对着错的旋钮调半天。
        const trigger = decision.byteRatio >= decision.rowRatio ? 'estimated live size' : 'row count';
        await bestEffortRecordHealthEvent(
          database,
          'do_record_persistence',
          'error',
          `record persistence paused by history ${trigger}: `
          + `${this.recordCapacityBytes}/${this.recordHighWatermarkBytes} bytes, `
          + `${this.recordCapacityRows}/${this.recordHighWatermarkRows} rows; `
          + `${usage.allocated_bytes} allocated bytes (diagnostic only); `
          + 'live data continues without history writes',
          { auditAction: 'do_record_capacity_high_watermark' },
        );
      }
    } catch (error) {
      this.recordCapacityNextCheckAt = now + RECORD_CAPACITY_CACHE_NEAR_MS;
      await bestEffortRecordHealthEvent(
        database,
        'do_record_persistence',
        'error',
        `record capacity check failed: ${errorDetail(error)}`,
        { auditAction: 'do_record_capacity_error' },
      );
      return !this.recordCapacityBlocked;
    }

    return !this.recordCapacityBlocked;
  }

  private async recordHotPathHealthOk(component: StoredHealthComponent, detail: string, now: number): Promise<void> {
    const previous = this.healthOkLastWriteAt.get(component) || 0;
    if (now - previous < HOT_PATH_HEALTH_OK_THROTTLE_MS) return;
    this.healthOkLastWriteAt.set(component, now);
    const database = this.getQueryDatabase();
    if (!database) return;
    await bestEffortRecordHealthEvent(database, component, 'ok', detail, {
      successThrottleMs: HOT_PATH_HEALTH_OK_THROTTLE_MS,
    });
  }

  private gpuSnapshotSignature(gpus: unknown): string | null {
    if (!Array.isArray(gpus) || gpus.length === 0) return null;
    const devices = gpus
      .map((device, index) => {
        const value = isObjectPayload(device) ? device : {};
        const memTotal = Number(value.mem_total || 0);
        const memBucketSize = Math.max(memTotal * GPU_MEMORY_BUCKET_RATIO, GPU_MEMORY_BUCKET_MIN_UNITS);
        return {
          i: Number(value.device_index ?? index),
          n: String(value.device_name || '').slice(0, 64),
          mt: Math.round(memTotal / GPU_MEMORY_BUCKET_MIN_UNITS),
          mu: Math.round(Number(value.mem_used || 0) / memBucketSize),
          u: Math.round(Number(value.utilization || 0) / GPU_UTILIZATION_BUCKET_PERCENT),
          t: Math.round(Number(value.temperature || 0) / GPU_TEMPERATURE_BUCKET_C),
        };
      })
      .sort((a, b) => a.i - b.i || a.n.localeCompare(b.n));
    return JSON.stringify(devices);
  }

  private async shouldPersistGPUSnapshot(clientId: string, gpus: unknown, nowMs: number): Promise<{ persist: boolean; signature: string | null }> {
    const signature = this.gpuSnapshotSignature(gpus);
    if (!signature) return { persist: false, signature: null };

    const key = `${GPU_SNAPSHOT_META_PREFIX}${clientId}`;
    const previous = await this.state.storage.get<GPUSnapshotMeta>(key);
    if (!previous || previous.signature !== signature || nowMs - Number(previous.persistedAt || 0) >= GPU_SNAPSHOT_UNCHANGED_HEARTBEAT_MS) {
      return { persist: true, signature };
    }
    return { persist: false, signature };
  }

  private async markGPUSnapshotPersisted(clientId: string, signature: string, nowMs: number): Promise<void> {
    await this.state.storage.put(`${GPU_SNAPSHOT_META_PREFIX}${clientId}`, {
      signature,
      persistedAt: nowMs,
    } satisfies GPUSnapshotMeta);
  }

  private pingResultStateKey(clientId: string, taskId: number): string {
    return `${PING_RESULT_STORAGE_PREFIX}${clientId}:${taskId}`;
  }

  private normalizePingResultState(raw: unknown): PingResultState {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return { lastAcceptedMs: raw };
    }
    if (!raw || typeof raw !== 'object') {
      return { lastAcceptedMs: 0 };
    }
    const value = raw as Partial<PingResultState>;
    const lastAcceptedMs = Number(value.lastAcceptedMs || 0);
    const state: PingResultState = {
      lastAcceptedMs: Number.isFinite(lastAcceptedMs) ? lastAcceptedMs : 0,
    };
    const persistedValue = Number(value.value);
    const persistedAt = Number(value.persistedAt || 0);
    if (Number.isFinite(persistedValue)) state.value = persistedValue;
    if (Number.isFinite(persistedAt) && persistedAt > 0) state.persistedAt = persistedAt;
    return state;
  }

  private async readPingResultState(key: string): Promise<PingResultState> {
    const cached = this.pingResultStateCache.get(key);
    if (cached) return cached;

    const state = this.normalizePingResultState(await this.state.storage.get(key));
    this.pingResultStateCache.set(key, state);
    return state;
  }

  private async writePingResultState(key: string, state: PingResultState): Promise<void> {
    await this.state.storage.put(key, state);
    this.pingResultStateCache.set(key, state);
  }

  private shouldPersistPingResult(result: PingPersistenceResult, state: PingResultState, nowMs: number): boolean {
    const previousValue = Number(state.value);
    const previousPersistedAt = Number(state.persistedAt || 0);
    if (!Number.isFinite(previousValue) || !Number.isFinite(previousPersistedAt) || previousPersistedAt <= 0) {
      return true;
    }

    const currentLost = result.value === PING_LOSS_VALUE;
    const previousLost = previousValue === PING_LOSS_VALUE;
    if (currentLost !== previousLost) return true;
    if (currentLost) return nowMs - previousPersistedAt >= PING_UNCHANGED_HEARTBEAT_MS;
    if (Math.abs(result.value - previousValue) >= PING_VALUE_CHANGE_THRESHOLD_MS) return true;
    return nowMs - previousPersistedAt >= PING_UNCHANGED_HEARTBEAT_MS;
  }

  private async markPingResultsPersisted(clientId: string, results: PingPersistenceResult[], nowMs: number): Promise<void> {
    const updates: Record<string, PingResultState> = {};
    for (const result of results) {
      const key = this.pingResultStateKey(clientId, result.taskId);
      const previous = this.pingResultStateCache.get(key) || { lastAcceptedMs: nowMs };
      updates[key] = {
        ...previous,
        lastAcceptedMs: Math.max(previous.lastAcceptedMs, nowMs),
        value: result.value,
        persistedAt: nowMs,
      };
    }
    // At most 50 results. Commit their interval state together so a failed
    // local write cannot turn a retried SQL batch into a different subset.
    await this.state.storage.put(updates);
    for (const [key, state] of Object.entries(updates)) {
      this.pingResultStateCache.set(key, state);
    }
  }

  private async persistReport(clientId: string, report: JsonObject, nowMs: number, force = false): Promise<boolean> {
    if (this.recordWritesInFlight.has(clientId)) return false;
    this.recordWritesInFlight.add(clientId);
    try {
      return await this.persistReservedReport(clientId, report, nowMs, force);
    } finally {
      this.recordWritesInFlight.delete(clientId);
    }
  }

  private async persistReservedReport(clientId: string, report: JsonObject, nowMs: number, force: boolean): Promise<boolean> {
    const database = this.getQueryDatabase();
    if (!database || !report || report.type === 'ping' || report.type === 'pong' || report.type === 'ping_result') {
      return false;
    }

    if (!(await this.isRecordPersistenceEnabled(nowMs))) {
      return false;
    }

    if (!force && !(await this.isPersistDue(clientId, nowMs))) {
      return false;
    }

    if (!(await this.canPersistWithinCapacity(nowMs))) {
      return false;
    }

    const time = new Date(nowMs).toISOString();
    try {
      const normalizedReport = normalizeMonitorReport(report);
      const record = toMonitorRecord(clientId, time, normalizedReport);
      await db.insertRecord(database, record);
      if (!force) await this.markPersistSuccess(clientId, nowMs);

      const gpuDecision = await this.shouldPersistGPUSnapshot(clientId, normalizedReport.gpus, nowMs);
      if (gpuDecision.persist && gpuDecision.signature) {
        await db.insertGPURecords(database, clientId, time, normalizedReport.gpus);
        await this.markGPUSnapshotPersisted(clientId, gpuDecision.signature, nowMs);
      }
      await this.recordHotPathHealthOk(
        'do_record_persistence',
        `record persisted for ${clientId}`,
        nowMs,
      );
      return true;
    } catch (error) {
      await bestEffortRecordHealthEvent(
        database,
        'do_record_persistence',
        'error',
        `record persist failed for ${clientId}: ${errorDetail(error)}`,
        { auditAction: 'do_record_persistence_error' },
      );
      // DO 内部写库失败不应中断实时广播
      return false;
    }
  }

  private async runPingWrite<T>(clientId: string, write: () => Promise<T>): Promise<T> {
    const previous = this.pingWriteQueues.get(clientId);
    const pending = (previous || Promise.resolve()).catch(() => {}).then(write);
    this.pingWriteQueues.set(clientId, pending);
    try {
      return await pending;
    } finally {
      if (this.pingWriteQueues.get(clientId) === pending) this.pingWriteQueues.delete(clientId);
    }
  }

  private persistPingResult(clientId: string, result: unknown, nowMs: number): Promise<void> {
    return this.runPingWrite(clientId, () => this.persistQueuedPingResult(clientId, result, nowMs));
  }

  private async persistQueuedPingResult(clientId: string, result: unknown, nowMs: number): Promise<void> {
    const database = this.getQueryDatabase();
    if (!database) return;

    try {
      if (!(await this.isRecordPersistenceEnabled(nowMs))) return;
      if (!(await this.canPersistWithinCapacity(nowMs))) return;

      const tasks = await this.getPingTasks(nowMs);
      const validated = validatePingResults(result, tasks, clientId);
      if (!validated.ok) return;

      const accepted = await this.filterPingResultsByInterval(clientId, validated.results, tasks, nowMs);
      if (accepted.length === 0) return;

      const time = new Date(nowMs).toISOString();
      await db.insertPingSnapshot(database, clientId, time, accepted);
      await this.markPingResultsPersisted(clientId, accepted, nowMs);
      await this.recordHotPathHealthOk(
        'ping_persistence',
        `ping result persisted for ${clientId}`,
        nowMs,
      );
    } catch (error) {
      await bestEffortRecordHealthEvent(
        database,
        'ping_persistence',
        'error',
        `ping persist failed for ${clientId}: ${errorDetail(error)}`,
        { auditAction: 'ping_persistence_error' },
      );
      throw error;
    }
  }

  private async updateHttpPingResult(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, HTTP_PING_RESULT_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const payload = parsed.body;
    if (!isObjectPayload(payload) || typeof payload.client_id !== 'string' || !Array.isArray(payload.results)) {
      return Response.json({ error: 'Invalid ping result payload' }, { status: 400 });
    }
    const database = this.getQueryDatabase();
    if (!database) {
      return Response.json({ error: 'Database is unavailable' }, { status: 500 });
    }

    const clientId = payload.client_id;
    return this.runPingWrite(clientId, async () => {
      try {
        const nowMs = Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now();
        if (!(await this.isRecordPersistenceEnabled(nowMs))) {
          return Response.json({ success: true, accepted: 0, disabled: true });
        }
        if (!(await this.canPersistWithinCapacity(nowMs))) {
          return Response.json({ success: true, accepted: 0, capacity_limited: true });
        }

        let accepted: PingPersistenceResult[] = [];
        const trustedResults = this.trustedPingResults(payload.results);
        if (trustedResults) {
          accepted = await this.filterTrustedPingResultsByInterval(clientId, trustedResults, nowMs);
        } else {
          const tasks = await this.getPingTasks(nowMs);
          const validated = validatePingResults(payload.results, tasks, clientId);
          if (!validated.ok) {
            return Response.json({ error: validated.error }, { status: validated.status });
          }
          accepted = await this.filterPingResultsByInterval(clientId, validated.results, tasks, nowMs);
        }
        if (accepted.length === 0) {
          return Response.json({ success: true, accepted: 0, rate_limited: true });
        }

        const time = new Date(nowMs).toISOString();
        await db.insertPingSnapshot(database, clientId, time, accepted);
        await this.markPingResultsPersisted(clientId, accepted, nowMs);
        await this.recordHotPathHealthOk(
          'ping_persistence',
          `ping result persisted for ${clientId}`,
          nowMs,
        );
        return Response.json({ success: true, accepted: accepted.length });
      } catch (error) {
        await bestEffortRecordHealthEvent(
          database,
          'ping_persistence',
          'error',
          `ping persist failed: ${errorDetail(error)}`,
          { auditAction: 'ping_persistence_error' },
        );
        return Response.json({ error: 'Ping persist failed' }, { status: 500 });
      }
    });
  }

  private pingResultIntervalMs(intervalSec?: number): number {
    const seconds = Number(intervalSec);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.floor(seconds), 3), 3600) * 1000;
    }
    return this.pingRecordPersistIntervalMs;
  }

  private trustedPingResults(input: unknown): PingPersistenceResult[] | null {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_PING_RESULTS_PER_REPORT) return null;
    const results: PingPersistenceResult[] = [];
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      const taskId = Number(item.task_id);
      const value = Number(item.value);
      const intervalSec = Number(item.interval_sec);
      if (
        !Number.isInteger(taskId) ||
        taskId <= 0 ||
        !Number.isFinite(value) ||
        (value !== PING_LOSS_VALUE && (value < 0 || value > MAX_PING_VALUE_MS)) ||
        !Number.isFinite(intervalSec)
      ) {
        return null;
      }
      results.push({
        taskId,
        value,
        intervalSec,
      });
    }
    return results;
  }

  private async filterPingResultsByInterval(
    clientId: string,
    results: PingPersistenceResult[],
    tasks: db.PingTask[],
    nowMs: number,
  ): Promise<PingPersistenceResult[]> {
    const taskMap = new Map<number, db.PingTask>();
    for (const task of tasks) {
      if (typeof task.id === 'number') taskMap.set(task.id, task);
    }

    return this.filterTrustedPingResultsByInterval(clientId, results.map(result => ({
      ...result,
      intervalSec: result.intervalSec ?? taskMap.get(result.taskId)?.interval_sec,
    })), nowMs);
  }

  private async filterTrustedPingResultsByInterval(
    clientId: string,
    results: PingPersistenceResult[],
    nowMs: number,
  ): Promise<PingPersistenceResult[]> {
    const accepted: PingPersistenceResult[] = [];
    const dueResults: PingPersistenceResult[] = [];
    for (const result of results) {
      const minIntervalMs = this.pingResultIntervalMs(result.intervalSec);
      const key = this.pingResultStateKey(clientId, result.taskId);
      const state = await this.readPingResultState(key);
      if (state.lastAcceptedMs && nowMs - state.lastAcceptedMs < minIntervalMs) {
        continue;
      }
      const shouldPersist = this.shouldPersistPingResult(result, state, nowMs);
      dueResults.push(result);
      if (!shouldPersist) {
        continue;
      }
      accepted.push(result);
    }
    if (accepted.length > 0) return dueResults;
    // Intentional unchanged-value compression has no SQL write to await.
    for (const result of dueResults) {
      const key = this.pingResultStateKey(clientId, result.taskId);
      const state = await this.readPingResultState(key);
      await this.writePingResultState(key, { ...state, lastAcceptedMs: nowMs });
    }
    return [];
  }
}
