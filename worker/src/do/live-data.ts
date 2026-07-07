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
import { bestEffortRecordHealthEvent, errorDetail } from '../utils/observability';
import { isPublicIpAddress } from '../utils/request-ip';
import { unwrapMonitorReportEnvelope } from '../utils/report-envelope';
import { checkWebsiteMonitorHttp } from '../utils/website-monitor';

// 客户端状态
interface ClientState {
  uuid: string;
  name: string;
  hidden: boolean;
  lastReportTime: number;
  lastReport: MonitorReportPayload; // 最后一次上报的数据
  expiresAt?: number;
}

const RECORD_PERSIST_INTERVAL_MS = 120_000;
const PING_RECORD_PERSIST_INTERVAL_MS = 120_000;
const MIN_RECORD_PERSIST_INTERVAL_MS = 3_000;
const MAX_RECORD_PERSIST_INTERVAL_MS = 3_600_000;
const MIN_PING_RECORD_PERSIST_INTERVAL_MS = 60_000;
const MAX_PING_RECORD_PERSIST_INTERVAL_MS = 3_600_000;
const RECORD_SETTING_CACHE_MS = 30_000;
const LIVE_VIEWER_WS_PROTOCOL = 'cf-monitor-viewer';
const RECORD_HIGH_WATERMARK_DEFAULT_ROWS = 450_000;
const RECORD_HIGH_WATERMARK_MIN_ROWS = 1_000;
const RECORD_HIGH_WATERMARK_MAX_ROWS = 10_000_000;
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
];
const HTTP_CLIENT_MIN_TTL_MS = 30_000;
const HTTP_CLIENT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const HTTP_CLIENT_REPORT_MAX_BODY_BYTES = 512 * 1024;
const HTTP_CLIENT_META_MAX_BODY_BYTES = 16 * 1024;
const HTTP_ADMIN_CLIENTS_SNAPSHOT_MAX_BODY_BYTES = 256 * 1024;
const HTTP_PING_RESULT_MAX_BODY_BYTES = 64 * 1024;
const AGENT_WS_MAX_MESSAGE_BYTES = 512 * 1024;
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
  rows: number;
  blocked: boolean;
  checkedAt: number;
  nextCheckAt: number;
  highWatermarkRows: number;
}

interface AdminClientsSnapshot {
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
  private recordPersistenceEnabled: boolean = true;
  private recordPersistIntervalMs: number = RECORD_PERSIST_INTERVAL_MS;
  private pingRecordPersistIntervalMs: number = PING_RECORD_PERSIST_INTERVAL_MS;
  private recordPersistenceCheckedAt: number = 0;
  private recordHighWatermarkRows: number = RECORD_HIGH_WATERMARK_DEFAULT_ROWS;
  private recordCapacityNextCheckAt: number = 0;
  private recordCapacityRows: number = 0;
  private recordCapacityBlocked: boolean = false;
  private recordCapacityLastAuditAt: number = 0;
  private healthOkLastWriteAt: Map<string, number> = new Map();
  private recordLastPersistAt: Map<string, number> = new Map();
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
  private networkMetadataSignatures = new Map<string, { signature: string; syncedAt: number }>();
  private basicInfoSignatures = new Map<string, string>();
  private geoRegionCache = new Map<string, { region: string; expiresAt: number }>();

  constructor(state: DurableObjectState, env: LiveDataEnv) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.sessionRoles = new Map();
    this.viewerExpiresAt = new Map();
    this.clients = new Map();
    this.hydrateSessionsFromAcceptedWebSockets();
  }

  private getQueryDatabase(): db.QueryDatabase | null {
    try {
      return getDatabase(this.env);
    } catch {
      return null;
    }
  }

  private runBackground(component: string, promise: Promise<unknown>): void {
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

  private buildSnapshot(includeHidden = false): LiveSnapshot {
    const now = Date.now();
    const onlineClients = Array.from(this.clients.values())
      .filter(c => (includeHidden || !c.hidden) && (!c.expiresAt || c.expiresAt > now))
      .map(c => ({
        ...(c.lastReport || {}),
        uuid: c.uuid,
        name: c.name,
        lastReportTime: c.lastReportTime,
      }));
    const liveData = onlineClients.reduce<Record<string, LiveSnapshotClient>>((acc, client) => {
      acc[client.uuid] = client;
      return acc;
    }, {});

    const snapshot: LiveSnapshot = {
      online: onlineClients.map(c => c.uuid),
      clients: onlineClients,
      data: liveData,
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

  private updateClientReport(
    clientId: string,
    clientName: string,
    hidden: boolean,
    data: unknown,
    now: number,
    expiresAt?: number,
    ws?: WebSocket,
    network?: ReportNetworkMetadata,
  ): MonitorReportPayload {
    const report = this.sanitizeReport(
      normalizeMonitorReport(data),
      network || (ws ? this.getSessionAttachment(ws) || undefined : undefined),
    );
    const previous = this.clients.get(clientId);
    const wasVisible = this.isVisibleClient(previous, now);
    const next: ClientState = {
      uuid: clientId,
      name: clientName,
      hidden,
      lastReportTime: now,
      lastReport: report,
      expiresAt,
    };

    this.clients.set(clientId, next);
    if (ws) this.rememberAgentReportAttachment(ws, clientId, clientName, hidden, report, now, expiresAt);
    this.runBackground('do_live_network_metadata', this.syncNetworkMetadataFromReport(clientId, clientName, hidden, report, now));

    if (this.isVisibleClient(next, now) || next.hidden) {
      this.broadcastToViewers({
        type: 'update',
        client: clientId,
        name: clientName,
        data: report,
        timestamp: now,
      }, next.hidden ? 'admin' : 'all');
    } else if (wasVisible) {
      this.broadcastToViewers({
        type: 'remove',
        client: clientId,
        timestamp: now,
      }, 'public');
    }

    return report;
  }

  private async syncNetworkMetadataFromReport(
    clientId: string,
    clientName: string,
    hidden: boolean,
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
    const previous = this.networkMetadataSignatures.get(clientId);
    if (previous?.signature === signature) return;
    this.networkMetadataSignatures.set(clientId, { signature, syncedAt: now });

    const client = { uuid: clientId, name: clientName || clientId, hidden, ...patch };
    await this.upsertAdminClientSnapshot(client);
    this.broadcastMetadataChanged({ clients: { upsert: [this.publicClientMetadata(client)] } });

    const database = this.getQueryDatabase();
    if (!database) return;
    await db.updateClient(database, clientId, patch as Partial<db.Client>);
  }

  private applyInferredNetworkMetadataToLiveReport(clientId: string, patch: JsonObject, now: number): void {
    const current = this.clients.get(clientId);
    if (!current) return;

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
    ws.serializeAttachment({
      role: 'agent',
      clientId,
      clientName,
      hidden,
      ...(previous?.sourceIp ? { sourceIp: previous.sourceIp } : {}),
      ...(previous?.region ? { region: previous.region } : {}),
      lastReport: report,
      lastReportTime: now,
      expiresAt,
    });
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

  private async getWebsiteProbeTasks(now: number, clientId?: string): Promise<db.WebsiteMonitor[]> {
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

  private removeExpiredClients(now: number) {
    for (const [uuid, client] of this.clients) {
      if (!client.expiresAt || client.expiresAt > now) continue;

      this.clients.delete(uuid);
      this.broadcastToViewers({
        type: 'remove',
        client: uuid,
        timestamp: now,
      }, client.hidden ? 'admin' : 'all');
    }

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
    let payload = '';
    for (const [id, session] of this.sessions) {
      if (this.sessionRoles.get(id) !== 'viewer' || session.readyState !== WebSocket.READY_STATE_OPEN) {
        continue;
      }
      const includeHidden = this.getSessionAttachment(session)?.includeHidden === true;
      if (audience === 'admin' && !includeHidden) continue;
      if (audience === 'public' && includeHidden) continue;
      try {
        payload ||= JSON.stringify(message);
        session.send(payload);
      } catch {
        // Close/error handlers clean up broken viewer sockets.
      }
    }
  }

  private broadcastMetadataChanged(detail: JsonObject = {}) {
    this.broadcastToViewers({
      type: 'metadata_changed',
      ...detail,
      timestamp: Date.now(),
    });
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
      this.broadcastToViewers({
        type: 'remove',
        client: attachment.clientId,
        timestamp: Date.now(),
      }, existing.hidden ? 'admin' : 'all');
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
    const current = this.clients.get(uuid);
    if (current) {
      const wasVisible = !current.hidden;
      current.name = typeof meta.name === 'string' ? meta.name : current.name;
      current.hidden = booleanField(meta, 'hidden');
      this.clients.set(uuid, current);
      const session = this.sessions.get(uuid);
      if (session?.readyState === WebSocket.READY_STATE_OPEN) {
        this.rememberAgentReportAttachment(
          session,
          uuid,
          current.name,
          current.hidden,
          current.lastReport,
          current.lastReportTime,
          current.expiresAt,
        );
      }

      if (wasVisible && current.hidden) {
        this.broadcastToViewers({
          type: 'remove',
          client: uuid,
          timestamp: Date.now(),
        }, 'public');
        if (current.lastReport) {
          this.broadcastToViewers({
            type: 'update',
            client: uuid,
            name: current.name,
            data: current.lastReport,
            timestamp: current.lastReportTime,
          }, 'admin');
        }
      } else if (!current.hidden && current.lastReport) {
        this.broadcastToViewers({
          type: 'update',
          client: uuid,
          name: current.name,
          data: current.lastReport,
          timestamp: current.lastReportTime,
        }, 'all');
      }
    }
    const client = isObjectPayload(meta.client)
      ? meta.client
      : { uuid, name: current?.name || uuid, hidden: booleanField(meta, 'hidden') };
    await this.upsertAdminClientSnapshot(client);
    const broadcastClient = this.publicClientMetadata(client);
    this.broadcastMetadataChanged({
      clients: booleanField(meta, 'hidden')
        ? { upsert: [broadcastClient], remove: [uuid] }
        : { upsert: [broadcastClient] },
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
    const existing = this.clients.get(meta.uuid);
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

  private publicClientMetadata(client: JsonObject): JsonObject {
    const safe = this.sanitizeAdminClientSnapshotItem(client);
    const broadcastClient: JsonObject = safe ? { ...safe } : {};
    delete broadcastClient.ipv4;
    delete broadcastClient.ipv6;
    return broadcastClient;
  }

  private async readAdminClientsSnapshot(): Promise<AdminClientsSnapshot | null> {
    const snapshot = await this.state.storage.get<AdminClientsSnapshot>(ADMIN_CLIENTS_SNAPSHOT_KEY);
    if (!snapshot || !Array.isArray(snapshot.clients)) {
      this.adminClientsUpdatedAt = 0;
      return null;
    }
    const normalized = {
      clients: snapshot.clients.filter(isObjectPayload),
      updatedAt: Number(snapshot.updatedAt || 0),
      removed: Array.isArray(snapshot.removed)
        ? snapshot.removed.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.trim() !== '')
        : [],
    };
    this.adminClientsUpdatedAt = normalized.updatedAt;
    return normalized;
  }

  private async writeAdminClientsSnapshot(request: Request): Promise<Response> {
    const parsed = await parseJsonRequestWithLimit(request, HTTP_ADMIN_CLIENTS_SNAPSHOT_MAX_BODY_BYTES);
    if ('response' in parsed) return parsed.response;
    const clients = Array.isArray(parsed.body.clients)
      ? parsed.body.clients.filter(isObjectPayload).map(client => this.sanitizeAdminClientSnapshotItem(client)).filter((client): client is JsonObject => Boolean(client))
      : [];
    const updatedAt = Date.now();
    this.adminClientsUpdatedAt = updatedAt;
    await this.state.storage.put(ADMIN_CLIENTS_SNAPSHOT_KEY, { clients, updatedAt, removed: [] });
    return Response.json({ success: true, count: clients.length });
  }

  private async upsertAdminClientSnapshot(client: JsonObject): Promise<void> {
    const safe = this.sanitizeAdminClientSnapshotItem(client);
    if (!safe) return;
    const snapshot = await this.readAdminClientsSnapshot();
    if (!snapshot) return;
    const clients = snapshot.clients;
    const byUuid = new Map(clients.map(item => [String(item.uuid || ''), item]));
    byUuid.set(String(safe.uuid), { ...(byUuid.get(String(safe.uuid)) || {}), ...safe });
    const updatedAt = Date.now();
    this.adminClientsUpdatedAt = updatedAt;
    await this.state.storage.put(ADMIN_CLIENTS_SNAPSHOT_KEY, {
      clients: [...byUuid.values()],
      updatedAt,
      removed: (snapshot?.removed || []).filter(item => item !== safe.uuid),
    });
  }

  private async removeAdminClientSnapshot(uuid: string): Promise<void> {
    const snapshot = await this.readAdminClientsSnapshot();
    const updatedAt = Date.now();
    this.adminClientsUpdatedAt = updatedAt;
    await this.state.storage.put(ADMIN_CLIENTS_SNAPSHOT_KEY, {
      clients: (snapshot?.clients || []).filter(client => client.uuid !== uuid),
      updatedAt,
      removed: [uuid, ...(snapshot?.removed || []).filter(item => item !== uuid)].slice(0, 200),
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

    const network: ReportNetworkMetadata = {
      sourceIp: stringField(payload, 'source_ip'),
      region: stringField(payload, 'region'),
    };
    const now = Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now();
    const ttlMs = this.boundedHttpTtlMs(payload.ttl_ms);
    const clientName = typeof payload.name === 'string' && payload.name.trim() !== '' ? payload.name.trim() : payload.uuid;
    const hidden = booleanField(payload, 'hidden');
    const reportsToPersist: Array<{ report: JsonObject; reportTime: number }> = [];
    for (let index = 0; index < reports.length; index += 1) {
      const rawReport = reports[index];
      const reportTime = this.reportTimestamp(rawReport, now);
      const isLast = index === reports.length - 1;
      if (isLast) {
        const report = this.updateClientReport(
          payload.uuid,
          clientName,
          hidden,
          rawReport,
          reportTime,
          now + ttlMs,
          undefined,
          network,
        );
        reportsToPersist.push({ report, reportTime });
        this.runBackground('ping_persistence', this.persistPingResultsFromReport(payload.uuid, rawReport, reportTime));
        this.runBackground('website_probe_persistence', this.persistWebsiteProbeResultsFromReport(payload.uuid, rawReport, reportTime));
      } else {
        reportsToPersist.push({ report: rawReport, reportTime });
        this.runBackground('ping_persistence', this.persistPingResultsFromReport(payload.uuid, rawReport, reportTime));
        this.runBackground('website_probe_persistence', this.persistWebsiteProbeResultsFromReport(payload.uuid, rawReport, reportTime));
      }
    }

    await this.scheduleExpiryAlarm(now);
    const basicInfoReport = this.latestBasicInfoReport(reports);
    if (basicInfoReport) {
      this.runBackground('do_basic_info_sync', this.syncBasicInfoFromReport(payload.uuid, clientName, hidden, basicInfoReport));
    }
    this.runBackground('do_record_persistence', this.persistReportsSequential(payload.uuid, reportsToPersist));

    return new Response(JSON.stringify({ success: true, persisted: false, queued: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
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

  private async syncBasicInfoFromReport(clientId: string, clientName: string, hidden: boolean, report: JsonObject): Promise<void> {
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
      const value = Number(basicInfo[field]);
      if (Number.isFinite(value) && (field === 'swap_total' ? value >= 0 : value > 0)) {
        patch[field] = value;
      }
    }
    if (Object.keys(patch).length === 0) return;
    const signature = JSON.stringify(patch);
    if (this.basicInfoSignatures.get(clientId) === signature) return;
    this.basicInfoSignatures.set(clientId, signature);
    const database = this.getQueryDatabase();
    if (!database) return;
    try {
      await db.updateClient(database, clientId, patch as Partial<db.Client>);
      const clientPatch: JsonObject = { uuid: clientId, name: clientName || clientId, hidden, ...patch };
      await this.upsertAdminClientSnapshot(clientPatch);
      const broadcastPatch = this.publicClientMetadata(clientPatch);
      this.broadcastMetadataChanged({
        clients: hidden ? { upsert: [broadcastPatch], remove: [clientId] } : { upsert: [broadcastPatch] },
      });
    } catch {
      // Basic info is refreshed periodically; keep live reporting independent.
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

      const assigned = new Set((await this.getWebsiteProbeTasks(nowMs, clientId)).map(task => task.id));
      if (assigned.size === 0) return;
      const checkedAt = new Date(nowMs).toISOString();
      let changed = false;
      const fallbackChecked = new Set<number>();
      for (const item of results) {
        const monitorId = Number(item.monitor_id);
        const latencyMs = Math.round(Number(item.latency_ms));
        const statusCode = item.status_code === null || item.status_code === undefined ? null : Number(item.status_code);
        const rawStatusCode = item.raw_status_code === null || item.raw_status_code === undefined ? statusCode : Number(item.raw_status_code);
        const effectiveStatus = item.effective_status === 'up' ? 'up' : item.effective_status === 'down' ? 'down' : null;
        if (
          !Number.isInteger(monitorId) ||
          !assigned.has(monitorId) ||
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
    }
  }

  // HTTP 请求处理（用于 Agent 上报数据）
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

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
      this.broadcastMetadataChanged(parsed.body);
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
      }

      const oldSession = role === 'agent' ? this.sessions.get(clientId) : undefined;
      if (oldSession && oldSession.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          oldSession.close(1000, 'Replaced by a new connection');
        } catch {
          // Best effort only.
        }
      }

      const attachment: SessionAttachment = {
        role,
        clientId,
        clientName,
        hidden,
        ...(role === 'viewer' && viewerIp ? { viewerIp } : {}),
        ...(role === 'viewer' ? { viewerExpiresAt: now + normalizeViewerTtlMs(url.searchParams.get('viewer_ttl_ms')) } : {}),
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
    const now = Date.now();
    if (data?.type === 'ping_result') {
      this.runBackground('ping_persistence', this.persistPingResult(clientId, data, now));
      return;
    }

    if (data?.type === 'reports' && Array.isArray(data.reports)) {
      const reports = data.reports.slice(0, AGENT_REPORT_MAX_BATCH).filter(isObjectPayload);
      const reportsToPersist: Array<{ report: JsonObject; reportTime: number }> = [];
      for (let index = 0; index < reports.length; index += 1) {
        const rawReport = reports[index];
        const reportTime = this.reportTimestamp(rawReport, now);
        const isLast = index === reports.length - 1;
        if (isLast) {
          const report = this.updateClientReport(clientId, clientName, hidden, rawReport, reportTime, undefined, ws);
          reportsToPersist.push({ report, reportTime });
          this.runBackground('ping_persistence', this.persistPingResultsFromReport(clientId, rawReport, reportTime));
          this.runBackground('website_probe_persistence', this.persistWebsiteProbeResultsFromReport(clientId, rawReport, reportTime));
        } else {
          reportsToPersist.push({ report: rawReport, reportTime });
          this.runBackground('ping_persistence', this.persistPingResultsFromReport(clientId, rawReport, reportTime));
          this.runBackground('website_probe_persistence', this.persistWebsiteProbeResultsFromReport(clientId, rawReport, reportTime));
        }
      }

      if (ws.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ack', timestamp: now }));
        } catch {
          // 忽略 ack 发送错误
        }
      }
      this.runBackground('do_agent_policy', this.sendCurrentPolicyToAgent(ws, now, false, false, clientId));
      const basicInfoReport = this.latestBasicInfoReport(reports);
      if (basicInfoReport) {
        this.runBackground('do_basic_info_sync', this.syncBasicInfoFromReport(clientId, clientName, hidden, basicInfoReport));
      }
      this.runBackground('do_record_persistence', this.persistReportsSequential(clientId, reportsToPersist));
      return;
    }

    const rawReport = unwrapMonitorReportEnvelope(data);
    const reportTime = this.reportTimestamp(rawReport, now);
    const report = this.updateClientReport(clientId, clientName, hidden, rawReport, reportTime, undefined, ws);
    this.runBackground('ping_persistence', this.persistPingResultsFromReport(clientId, rawReport, reportTime));
    this.runBackground('website_probe_persistence', this.persistWebsiteProbeResultsFromReport(clientId, rawReport, reportTime));
    this.runBackground('do_basic_info_sync', this.syncBasicInfoFromReport(clientId, clientName, hidden, rawReport));

    if (ws.readyState === WebSocket.READY_STATE_OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'ack', timestamp: now }));
      } catch {
        // 忽略 ack 发送错误
      }
    }

    // 持久化放在实时响应之后，避免数据库写入延迟阻塞 Agent WebSocket ack。
    this.runBackground('do_agent_policy', this.sendCurrentPolicyToAgent(ws, now, false, false, clientId));
    this.runBackground('do_record_persistence', this.persistReport(clientId, report, reportTime));
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
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
      // Ignore malformed agent messages.
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
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
    const now = Date.now();
    this.removeExpiredClients(now);
    this.removeExpiredViewers(now);
    await this.broadcastAgentPolicy(now, false);
    await this.scheduleExpiryAlarm(now);
  }

  private async isPersistDue(clientId: string, now: number): Promise<boolean> {
    const storageKey = `record:persist:${clientId}`;
    let lastPersist = this.recordLastPersistAt.get(clientId);
    if (lastPersist === undefined) {
      lastPersist = Number(await this.state.storage.get<number>(storageKey) || 0);
      this.recordLastPersistAt.set(clientId, lastPersist);
    }
    if (now - lastPersist < this.recordPersistIntervalMs) {
      return false;
    }
    return true;
  }

  private async markPersistAttempt(clientId: string, now: number): Promise<void> {
    const storageKey = `record:persist:${clientId}`;
    this.recordLastPersistAt.set(clientId, now);
    await this.state.storage.put(storageKey, now);
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
    if (this.recordHighWatermarkRows <= 0) return RECORD_CAPACITY_CACHE_NEAR_MS;
    const ratio = this.recordCapacityRows / this.recordHighWatermarkRows;
    if (ratio >= 0.95) return RECORD_CAPACITY_CACHE_CRITICAL_MS;
    if (ratio >= 0.8) return RECORD_CAPACITY_CACHE_NEAR_MS;
    return RECORD_CAPACITY_CACHE_FAR_MS;
  }

  private applyRecordCapacitySnapshot(snapshot: RecordCapacitySnapshot): void {
    this.recordCapacityRows = snapshot.rows;
    this.recordCapacityBlocked = snapshot.blocked;
    this.recordCapacityNextCheckAt = snapshot.nextCheckAt;
  }

  private normalizeRecordCapacitySnapshot(raw: unknown): RecordCapacitySnapshot | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<RecordCapacitySnapshot>;
    const rows = Number(value.rows);
    const checkedAt = Number(value.checkedAt);
    const nextCheckAt = Number(value.nextCheckAt);
    const highWatermarkRows = Number(value.highWatermarkRows);
    if (
      !Number.isFinite(rows) ||
      rows < 0 ||
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
      rows,
      blocked: Boolean(value.blocked),
      checkedAt,
      nextCheckAt,
      highWatermarkRows,
    };
  }

  private isReusableRecordCapacitySnapshot(snapshot: RecordCapacitySnapshot, now: number): boolean {
    return snapshot.highWatermarkRows === this.recordHighWatermarkRows && snapshot.nextCheckAt > now;
  }

  private async readReusableRecordCapacitySnapshot(now: number): Promise<RecordCapacitySnapshot | null> {
    try {
      const snapshot = this.normalizeRecordCapacitySnapshot(
        await this.state.storage.get(RECORD_CAPACITY_SNAPSHOT_KEY),
      );
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
      const counts = await db.getHistoryStorageRowCounts(database);
      this.recordCapacityRows = counts.records + counts.gpu_records + counts.gpu_snapshots + counts.ping_records + counts.ping_snapshots;
      this.recordCapacityBlocked = this.recordCapacityRows >= this.recordHighWatermarkRows;
      this.recordCapacityNextCheckAt = now + this.capacityCheckDelayMs();
      await this.writeRecordCapacitySnapshot({
        rows: this.recordCapacityRows,
        blocked: this.recordCapacityBlocked,
        checkedAt: now,
        nextCheckAt: this.recordCapacityNextCheckAt,
        highWatermarkRows: this.recordHighWatermarkRows,
      });
      if (this.recordCapacityBlocked && now - this.recordCapacityLastAuditAt >= RECORD_CAPACITY_AUDIT_THROTTLE_MS) {
        this.recordCapacityLastAuditAt = now;
        await bestEffortRecordHealthEvent(
          database,
          'do_record_persistence',
          'error',
          `record persistence paused at ${this.recordCapacityRows}/${this.recordHighWatermarkRows} rows; live data continues without history writes`,
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
      return true;
    }

    return !this.recordCapacityBlocked;
  }

  private async recordHotPathHealthOk(component: string, detail: string, now: number): Promise<void> {
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
    this.pingResultStateCache.set(key, state);
    await this.state.storage.put(key, state);
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
    for (const result of results) {
      const key = this.pingResultStateKey(clientId, result.taskId);
      const previous = this.pingResultStateCache.get(key) || { lastAcceptedMs: nowMs };
      await this.writePingResultState(key, {
        ...previous,
        lastAcceptedMs: previous.lastAcceptedMs || nowMs,
        value: result.value,
        persistedAt: nowMs,
      });
    }
  }

  private async persistReport(clientId: string, report: JsonObject, nowMs: number, force = false): Promise<boolean> {
    const database = this.getQueryDatabase();
    if (!database || !report || report.type === 'ping' || report.type === 'pong' || report.type === 'ping_result') {
      return false;
    }

    if (!force && !(await this.isPersistDue(clientId, nowMs))) {
      return false;
    }

    if (!(await this.isRecordPersistenceEnabled(nowMs))) {
      return false;
    }

    if (!(await this.canPersistWithinCapacity(nowMs))) {
      return false;
    }

    if (!force) await this.markPersistAttempt(clientId, nowMs);

    const time = new Date(nowMs).toISOString();
    try {
      const normalizedReport = normalizeMonitorReport(report);
      const record = toMonitorRecord(clientId, time, normalizedReport);
      await db.insertRecord(database, record);

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

  private async persistPingResult(clientId: string, result: unknown, nowMs: number) {
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
        accepted = await this.filterTrustedPingResultsByInterval(payload.client_id, trustedResults, nowMs);
      } else {
        const tasks = await this.getPingTasks(nowMs);
        const validated = validatePingResults(payload.results, tasks, payload.client_id);
        if (!validated.ok) {
          return Response.json({ error: validated.error }, { status: validated.status });
        }
        accepted = await this.filterPingResultsByInterval(payload.client_id, validated.results, tasks, nowMs);
      }
      if (accepted.length === 0) {
        return Response.json({ success: true, accepted: 0, rate_limited: true });
      }

      const time = new Date(nowMs).toISOString();
      await db.insertPingSnapshot(database, payload.client_id, time, accepted);
      await this.markPingResultsPersisted(payload.client_id, accepted, nowMs);
      await this.recordHotPathHealthOk(
        'ping_persistence',
        `ping result persisted for ${payload.client_id}`,
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
      await this.writePingResultState(key, {
        ...state,
        lastAcceptedMs: nowMs,
      });
      dueResults.push(result);
      if (!shouldPersist) {
        continue;
      }
      accepted.push(result);
    }
    return accepted.length > 0 ? dueResults : [];
  }
}
