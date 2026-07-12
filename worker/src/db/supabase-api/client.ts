import type { AuditLogsPage, BoundedTableRowCounts, ClearAllRecordsResult, Client, ClientCapacityCounts, ClientIdentity, ClientReferenceCleanupResult, ClientTokenMeta, ClientVisibility, DeleteClientsResult, DeleteOldRowsOptions, ExpiryNotification, ExpiryNotificationUpdate, GPUHistoryRecord, GPUInfo, HistoryTableRowCounts, LoadMetricWindowStats, LoadNotification, LoadNotificationInput, LoadNotificationMetric, LoginRateLimit, MonitorRecord, OfflineNotification, OfflineNotificationUpdate, OrphanClientDataCleanupResult, PingHistoryRecord, PingSnapshotInput, PingTask, PingTaskEstimateRow, PingTaskHistoryRequest, PublicClientRow, PublicWebsiteMonitor, ScheduledClientRow, TableRowCounts, Theme, ThemeAsset, ThemeAssetUpsertInput, ThemeUpsertInput, User, WebsiteCheck, WebsiteCheckInput, WebsiteMonitor, WebsiteMonitorInput } from '../types.ts';
import type { BackupData } from '../../utils/backup.ts';
import { redactDatabaseSecrets } from '../../utils/setup-diagnostics.ts';
import { generateAgentToken, hashAgentToken } from '../../utils/client.ts';

export type SupabaseApiEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export class SupabaseApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseApiConfigurationError';
  }
}

export class SupabaseApiError extends Error {
  readonly status: number;

  constructor(functionName: string, status: number, detail: string) {
    super(`Supabase RPC ${functionName} failed: ${status} ${detail}`.trim());
    this.name = 'SupabaseApiError';
    this.status = status;
  }
}

export function isSupabaseApiConfigured(env: SupabaseApiEnv): boolean {
  return Boolean(env.SUPABASE_URL?.trim() && resolveSupabaseApiKey(env));
}

export function resolveSupabaseApiKey(env: SupabaseApiEnv): string {
  return env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
}

function readSupabaseConfig(env: SupabaseApiEnv): { url: string; key: string } {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const key = resolveSupabaseApiKey(env);
  if (!url || !key) {
    throw new SupabaseApiConfigurationError('SUPABASE_URL and SUPABASE_SECRET_KEY are required for Supabase Data API mode.');
  }
  return { url, key };
}

function supabaseRpcHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function sanitizeSupabaseDetail(detail: string, key: string): string {
  return redactDatabaseSecrets(detail).replaceAll(key, '[REDACTED]').slice(0, 400);
}

export async function callSupabaseRpc<T>(
  env: SupabaseApiEnv,
  functionName: string,
  body: Record<string, unknown> = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const { url, key } = readSupabaseConfig(env);
  const response = await fetcher(`${url}/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
    method: 'POST',
    headers: supabaseRpcHeaders(key),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = sanitizeSupabaseDetail(await response.text().catch(() => ''), key);
    throw new SupabaseApiError(functionName, response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function readRpcBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

function normalizeClientBooleans<T extends { hidden?: unknown; auto_renewal?: unknown } | null>(client: T): T {
  if (!client || typeof client !== 'object') return client;
  const record = client as Record<string, unknown>;
  return {
    ...client,
    ...(Object.prototype.hasOwnProperty.call(record, 'hidden') ? { hidden: readRpcBoolean(record.hidden) } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'auto_renewal') ? { auto_renewal: readRpcBoolean(record.auto_renewal) } : {}),
  } as T;
}

function normalizeClientList<T extends { hidden?: unknown; auto_renewal?: unknown }>(clients: T[]): T[] {
  return clients.map(normalizeClientBooleans);
}

function readRpcStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
}

function normalizePingTask<T extends { clients?: unknown; all_clients?: unknown }>(task: T): T {
  return {
    ...task,
    clients: readRpcStringArray((task as Record<string, unknown>).clients),
    all_clients: readRpcBoolean((task as Record<string, unknown>).all_clients),
  } as T;
}

function normalizePingTaskList<T extends { clients?: unknown; all_clients?: unknown }>(tasks: T[]): T[] {
  return tasks.map(normalizePingTask);
}

function normalizeWebsiteMonitor<T extends { agent_probe_clients?: unknown; agent_probe_status_enabled?: unknown }>(monitor: T): T {
  return {
    ...monitor,
    agent_probe_clients: readRpcStringArray((monitor as Record<string, unknown>).agent_probe_clients),
    agent_probe_status_enabled: readRpcBoolean((monitor as Record<string, unknown>).agent_probe_status_enabled),
  } as T;
}

function normalizeWebsiteMonitorList<T extends { agent_probe_clients?: unknown; agent_probe_status_enabled?: unknown }>(monitors: T[]): T[] {
  return monitors.map(normalizeWebsiteMonitor);
}

export function getSupabasePublicSettings(env: SupabaseApiEnv): Promise<Record<string, string>> {
  return callSupabaseRpc<Record<string, string>>(env, 'cfm_public_settings');
}

export function setSupabaseSettings(env: SupabaseApiEnv, settings: Record<string, string>): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_set_settings', { input_settings: settings });
}

export function getSupabasePublicClients(env: SupabaseApiEnv): Promise<PublicClientRow[]> {
  return callSupabaseRpc<PublicClientRow[]>(env, 'cfm_public_clients').then(normalizeClientList);
}

export function getSupabaseAdminClients(env: SupabaseApiEnv): Promise<Client[]> {
  return callSupabaseRpc<Client[]>(env, 'cfm_admin_clients').then(normalizeClientList);
}

export function supabaseClientExists(env: SupabaseApiEnv, uuid: string): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_client_exists', { input_uuid: uuid });
}

export function getSupabaseClient(env: SupabaseApiEnv, uuid: string): Promise<Client | null> {
  return callSupabaseRpc<Client | null>(env, 'cfm_client', { input_uuid: uuid }).then(normalizeClientBooleans);
}

export function getSupabaseClientVisibility(env: SupabaseApiEnv, uuid: string): Promise<ClientVisibility | null> {
  return callSupabaseRpc<ClientVisibility | null>(env, 'cfm_client_visibility', { input_uuid: uuid }).then(normalizeClientBooleans);
}

export function listSupabaseScheduledClientRows(env: SupabaseApiEnv): Promise<ScheduledClientRow[]> {
  return callSupabaseRpc<ScheduledClientRow[]>(env, 'cfm_scheduled_clients');
}

export function getSupabaseScheduledClientRowsByIds(env: SupabaseApiEnv, uuids: string[]): Promise<ScheduledClientRow[]> {
  return callSupabaseRpc<ScheduledClientRow[]>(env, 'cfm_scheduled_clients_by_ids', { input_uuids: uuids });
}

export function getSupabaseClientTokenMeta(env: SupabaseApiEnv, uuid: string): Promise<ClientTokenMeta | null> {
  return callSupabaseRpc<ClientTokenMeta | null>(env, 'cfm_client_token_meta', { input_uuid: uuid });
}

export function getSupabaseClientsByIds(env: SupabaseApiEnv, uuids: string[]): Promise<Client[]> {
  return callSupabaseRpc<Client[]>(env, 'cfm_clients_by_ids', { input_uuids: uuids }).then(normalizeClientList);
}

export function getSupabaseClientIds(env: SupabaseApiEnv): Promise<string[]> {
  return callSupabaseRpc<string[]>(env, 'cfm_client_ids');
}

export async function getSupabaseClientByToken(env: SupabaseApiEnv, token: string): Promise<Client | null> {
  const tokenHash = await hashAgentToken(token);
  return callSupabaseRpc<Client | null>(env, 'cfm_agent_client_by_token', {
    input_token_hash: tokenHash,
    input_token: token,
  }).then(normalizeClientBooleans);
}

export async function getSupabaseClientIdentityByToken(env: SupabaseApiEnv, token: string): Promise<ClientIdentity | null> {
  const tokenHash = await hashAgentToken(token);
  return callSupabaseRpc<ClientIdentity | null>(env, 'cfm_agent_client_identity_by_token', {
    input_token_hash: tokenHash,
    input_token: token,
  }).then(normalizeClientBooleans);
}

export async function supabaseClientTokenExists(env: SupabaseApiEnv, token: string): Promise<boolean> {
  const tokenHash = await hashAgentToken(token);
  return callSupabaseRpc<boolean>(env, 'cfm_client_token_exists', {
    input_token_hash: tokenHash,
    input_token: token,
  });
}

export async function getSupabaseClientCreateConflict(env: SupabaseApiEnv, uuid: string, token: string): Promise<'uuid' | 'token' | null> {
  const tokenHash = await hashAgentToken(token);
  return callSupabaseRpc<'uuid' | 'token' | null>(env, 'cfm_client_create_conflict', {
    input_uuid: uuid,
    input_token_hash: tokenHash,
    input_token: token,
  });
}

export async function createSupabaseClient(env: SupabaseApiEnv, client: Partial<Client>): Promise<Client> {
  const token = client.token || generateAgentToken();
  return callSupabaseRpc<Client>(env, 'cfm_create_client', {
    input_client: {
      uuid: client.uuid || crypto.randomUUID(),
      name: client.name || '',
      token,
      token_hash: client.token_hash || await hashAgentToken(token),
      sort_order: client.sort_order,
    },
  }).then(normalizeClientBooleans);
}

export function markSupabaseClientTokenUsed(env: SupabaseApiEnv, uuid: string, ip = ''): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_mark_client_token_used', {
    input_uuid: uuid,
    input_ip: ip,
  });
}

export async function rotateSupabaseClientToken(env: SupabaseApiEnv, uuid: string, token: string): Promise<Client | null> {
  return callSupabaseRpc<Client | null>(env, 'cfm_rotate_client_token', {
    input_uuid: uuid,
    input_token: token,
    input_token_hash: await hashAgentToken(token),
  }).then(normalizeClientBooleans);
}

export function updateSupabaseClient(env: SupabaseApiEnv, uuid: string, data: Partial<Client> | Record<string, unknown>): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_update_client', {
    input_uuid: uuid,
    input_patch: data,
  });
}

export function updateSupabaseClientAndReturn(env: SupabaseApiEnv, uuid: string, data: Partial<Client> | Record<string, unknown>): Promise<Client | null> {
  return callSupabaseRpc<Client | null>(env, 'cfm_update_client_returning', {
    input_uuid: uuid,
    input_patch: data,
  }).then(normalizeClientBooleans);
}

export function deleteSupabaseClients(env: SupabaseApiEnv, uuids: string[]): Promise<DeleteClientsResult> {
  return callSupabaseRpc<DeleteClientsResult>(env, 'cfm_delete_clients', { input_uuids: uuids });
}

export function pruneSupabaseClientReferences(env: SupabaseApiEnv, uuid: string): Promise<ClientReferenceCleanupResult> {
  return pruneSupabaseClientReferencesForClients(env, [uuid]);
}

export function pruneSupabaseClientReferencesForClients(env: SupabaseApiEnv, uuids: string[]): Promise<ClientReferenceCleanupResult> {
  return callSupabaseRpc<ClientReferenceCleanupResult>(env, 'cfm_prune_client_references', { input_uuids: uuids });
}

export function cleanupSupabaseOrphanClientData(env: SupabaseApiEnv): Promise<OrphanClientDataCleanupResult> {
  return callSupabaseRpc<OrphanClientDataCleanupResult>(env, 'cfm_cleanup_orphan_client_data');
}

export function updateSupabaseClientsHidden(env: SupabaseApiEnv, uuids: string[], hidden: boolean): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_update_clients_hidden', {
    input_uuids: uuids,
    input_hidden: hidden,
  });
}

export function reorderSupabaseClients(env: SupabaseApiEnv, uuids: string[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_reorder_clients', { input_uuids: uuids });
}

export function getSupabaseClientCapacityCounts(env: SupabaseApiEnv): Promise<ClientCapacityCounts> {
  return callSupabaseRpc<ClientCapacityCounts>(env, 'cfm_client_capacity_counts');
}

export function getSupabasePingTaskEstimateRows(env: SupabaseApiEnv): Promise<PingTaskEstimateRow[]> {
  return callSupabaseRpc<PingTaskEstimateRow[]>(env, 'cfm_ping_task_estimate_rows').then(normalizePingTaskList);
}

export function getSupabasePingTask(env: SupabaseApiEnv, id: number): Promise<PingTask | null> {
  return callSupabaseRpc<PingTask | null>(env, 'cfm_ping_task', { input_id: id }).then(task => task ? normalizePingTask(task) : null);
}

export function createSupabasePingTask(env: SupabaseApiEnv, task: PingTask): Promise<PingTask> {
  return callSupabaseRpc<PingTask>(env, 'cfm_create_ping_task', { input_task: task }).then(normalizePingTask);
}

export function updateSupabasePingTaskAndReturn(env: SupabaseApiEnv, id: number, task: Partial<PingTask>): Promise<PingTask | null> {
  return callSupabaseRpc<PingTask | null>(env, 'cfm_update_ping_task', {
    input_id: id,
    input_task: task,
  }).then(task => task ? normalizePingTask(task) : null);
}

export function reorderSupabasePingTasks(env: SupabaseApiEnv, ids: number[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_reorder_ping_tasks', { input_ids: ids });
}

export function deleteSupabasePingTask(env: SupabaseApiEnv, id: number): Promise<PingTask | null> {
  return callSupabaseRpc<PingTask | null>(env, 'cfm_delete_ping_task', { input_id: id }).then(task => task ? normalizePingTask(task) : null);
}

export function deleteSupabaseOldRecords(
  env: SupabaseApiEnv,
  beforeTime: string,
  options: DeleteOldRowsOptions = {},
): Promise<{ records: number; gpu_records: number; gpu_snapshots: number }> {
  return callSupabaseRpc(env, 'cfm_delete_old_records', {
    input_before_time: beforeTime,
    input_max_batches: options.maxBatches,
  });
}

export function deleteSupabaseOldWebsiteChecks(
  env: SupabaseApiEnv,
  beforeTime: string,
  options: DeleteOldRowsOptions = {},
): Promise<{ website_checks: number }> {
  return callSupabaseRpc(env, 'cfm_delete_old_website_checks', {
    input_before_time: beforeTime,
    input_max_batches: options.maxBatches,
  });
}

export function deleteSupabaseOldPingRecords(
  env: SupabaseApiEnv,
  beforeTime: string,
  options: DeleteOldRowsOptions = {},
): Promise<{ ping_records: number; ping_snapshots: number }> {
  return callSupabaseRpc(env, 'cfm_delete_old_ping_records', {
    input_before_time: beforeTime,
    input_max_batches: options.maxBatches,
  });
}

export function deleteSupabaseOldAuditLogs(
  env: SupabaseApiEnv,
  beforeTime: string,
  options: DeleteOldRowsOptions = {},
): Promise<{ audit_logs: number }> {
  return callSupabaseRpc(env, 'cfm_delete_old_audit_logs', {
    input_before_time: beforeTime,
    input_max_batches: options.maxBatches,
  });
}

export function getSupabaseOfflineNotification(env: SupabaseApiEnv, client: string): Promise<OfflineNotification | null> {
  return callSupabaseRpc<OfflineNotification | null>(env, 'cfm_offline_notification', { input_client: client });
}

export function listSupabaseOfflineNotifications(env: SupabaseApiEnv): Promise<OfflineNotification[]> {
  return callSupabaseRpc<OfflineNotification[]>(env, 'cfm_offline_notifications');
}

export function setSupabaseOfflineNotifications(env: SupabaseApiEnv, items: OfflineNotificationUpdate[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_set_offline_notifications', { input_items: items });
}

export function markSupabaseOfflineNotificationSent(env: SupabaseApiEnv, client: string, time: string | null): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_mark_offline_notification_sent', {
    input_client: client,
    input_time: time,
  });
}

export function getSupabaseExpiryNotification(env: SupabaseApiEnv, client: string): Promise<ExpiryNotification | null> {
  return callSupabaseRpc<ExpiryNotification | null>(env, 'cfm_expiry_notification', { input_client: client });
}

export function listSupabaseExpiryNotifications(env: SupabaseApiEnv): Promise<ExpiryNotification[]> {
  return callSupabaseRpc<ExpiryNotification[]>(env, 'cfm_expiry_notifications');
}

export function setSupabaseExpiryNotifications(env: SupabaseApiEnv, items: ExpiryNotificationUpdate[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_set_expiry_notifications', { input_items: items });
}

export function markSupabaseExpiryNotificationSent(env: SupabaseApiEnv, client: string, time: string): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_mark_expiry_notification_sent', {
    input_client: client,
    input_time: time,
  });
}

export function listSupabaseLoadNotifications(env: SupabaseApiEnv): Promise<LoadNotification[]> {
  return callSupabaseRpc<LoadNotification[]>(env, 'cfm_load_notifications');
}

export function getSupabaseLoadNotification(env: SupabaseApiEnv, id: number): Promise<LoadNotification | null> {
  return callSupabaseRpc<LoadNotification | null>(env, 'cfm_load_notification', { input_id: id });
}

export async function getSupabaseLoadMetricWindowStatsForClients(
  env: SupabaseApiEnv,
  clients: string[],
  start: string,
  end: string,
  metric: LoadNotificationMetric,
  threshold: number,
): Promise<Map<string, LoadMetricWindowStats>> {
  const rows = await callSupabaseRpc<Array<LoadMetricWindowStats & { client: string }>>(
    env,
    'cfm_load_metric_window_stats',
    {
      input_clients: clients,
      input_start: start,
      input_end: end,
      input_metric: metric,
      input_threshold: threshold,
    },
  );
  return new Map(rows.map(row => [row.client, {
    samples: Number(row.samples || 0),
    exceeded: Number(row.exceeded || 0),
    avg_value: Number(row.avg_value || 0),
  }]));
}

export function updateSupabaseLoadNotification(env: SupabaseApiEnv, id: number, data: LoadNotificationInput): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_update_load_notification', {
    input_id: id,
    input_patch: data,
  });
}

export function createSupabaseLoadNotification(env: SupabaseApiEnv, data: LoadNotificationInput): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_create_load_notification', { input_item: data });
}

export function deleteSupabaseLoadNotification(env: SupabaseApiEnv, id: number): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_delete_load_notification', { input_id: id });
}

export function listSupabaseDueWebsiteMonitors(env: SupabaseApiEnv, now: string, limit: number): Promise<WebsiteMonitor[]> {
  return callSupabaseRpc<WebsiteMonitor[]>(env, 'cfm_due_website_monitors', {
    input_now: now,
    input_limit: limit,
  }).then(normalizeWebsiteMonitorList);
}

export function recordSupabaseWebsiteCheck(env: SupabaseApiEnv, check: WebsiteCheckInput): Promise<WebsiteMonitor | null> {
  return callSupabaseRpc<WebsiteMonitor | null>(env, 'cfm_record_website_check', { input_check: check })
    .then(monitor => monitor ? normalizeWebsiteMonitor(monitor) : null);
}

export function listSupabaseAgentWebsiteProbeTasks(
  env: SupabaseApiEnv,
  client: string,
  now: string,
  limit: number,
): Promise<WebsiteMonitor[]> {
  return callSupabaseRpc<WebsiteMonitor[]>(env, 'cfm_agent_website_probe_tasks', {
    input_client: client,
    input_now: now,
    input_limit: limit,
  }).then(normalizeWebsiteMonitorList);
}

export function markSupabaseWebsiteMonitorNotified(env: SupabaseApiEnv, id: number, time: string | null): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_mark_website_monitor_notified', {
    input_id: id,
    input_time: time,
  });
}

export function listSupabaseAuditLogsPaged(env: SupabaseApiEnv, page: number, limit: number): Promise<AuditLogsPage> {
  return callSupabaseRpc<AuditLogsPage>(env, 'cfm_audit_logs_paged', {
    input_page: page,
    input_limit: limit,
  });
}

export function listSupabaseThemes(env: SupabaseApiEnv): Promise<Theme[]> {
  return callSupabaseRpc<Theme[]>(env, 'cfm_themes');
}

export function getSupabaseTheme(env: SupabaseApiEnv, short: string): Promise<Theme | null> {
  return callSupabaseRpc<Theme | null>(env, 'cfm_theme', { input_short: short });
}

export function upsertSupabaseTheme(
  env: SupabaseApiEnv,
  theme: ThemeUpsertInput,
  assets: ThemeAssetUpsertInput[],
): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_upsert_theme', {
    input_theme: theme,
    input_assets: assets,
  });
}

export function updateSupabaseThemeSettings(
  env: SupabaseApiEnv,
  short: string,
  configJson: string,
  customCss: string,
): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_update_theme_settings', {
    input_short: short,
    input_config_json: configJson,
    input_custom_css: customCss,
  });
}

export function deleteSupabaseTheme(env: SupabaseApiEnv, short: string): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_delete_theme', { input_short: short });
}

export function getSupabaseThemeAsset(env: SupabaseApiEnv, short: string, path: string): Promise<ThemeAsset | null> {
  return callSupabaseRpc<ThemeAsset | null>(env, 'cfm_theme_asset', {
    input_short: short,
    input_path: path,
  });
}

export function insertSupabaseMonitorRecord(env: SupabaseApiEnv, record: MonitorRecord): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_insert_monitor_record', { input_record: record });
}

export function insertSupabaseGpuRecords(env: SupabaseApiEnv, client: string, time: string, gpus: GPUInfo[]): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_insert_gpu_snapshot', {
    input_client: client,
    input_time: time,
    input_gpus: gpus,
  });
}

export function insertSupabasePingSnapshot(env: SupabaseApiEnv, client: string, time: string, results: PingSnapshotInput[]): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_insert_ping_snapshot', {
    input_client: client,
    input_time: time,
    input_results: results,
  });
}

export function getSupabaseRecentRecords(env: SupabaseApiEnv, client: string, limit: number): Promise<MonitorRecord[]> {
  return callSupabaseRpc<MonitorRecord[]>(env, 'cfm_recent_records', {
    input_client: client,
    input_limit: limit,
  });
}

export function getSupabaseLatestRecords(env: SupabaseApiEnv): Promise<MonitorRecord[]> {
  return callSupabaseRpc<MonitorRecord[]>(env, 'cfm_latest_records');
}

export function getSupabaseLatestRecordTimes(env: SupabaseApiEnv): Promise<Array<{ client: string; last_time: string }>> {
  return callSupabaseRpc<Array<{ client: string; last_time: string }>>(env, 'cfm_latest_record_times');
}

export function getSupabaseLatestRecordTimesForClients(
  env: SupabaseApiEnv,
  clients: string[],
): Promise<Array<{ client: string; last_time: string }>> {
  return callSupabaseRpc<Array<{ client: string; last_time: string }>>(env, 'cfm_latest_record_times_for_clients', {
    input_clients: clients,
  });
}

export function getSupabaseRecordsByTimeRange(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
): Promise<MonitorRecord[]> {
  return callSupabaseRpc<MonitorRecord[]>(env, 'cfm_records_range', {
    input_client: client,
    input_start: start,
    input_end: end,
  });
}

export function getSupabaseRecordsByTimeRangeLimited(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
  limit: number,
): Promise<MonitorRecord[]> {
  return callSupabaseRpc<MonitorRecord[]>(env, 'cfm_records_range_limited', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_limit: limit,
  });
}

export function getSupabaseRecordsByTimeRangePaged(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
  page: number,
  limit: number,
): Promise<{ data: MonitorRecord[]; total: number; page: number; limit: number; has_more: boolean }> {
  return callSupabaseRpc(env, 'cfm_records_range_paged', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_page: page,
    input_limit: limit,
  });
}

export function getSupabaseRecordsByTimeRangeCursor(
  env: SupabaseApiEnv,
  client: string,
  start: string,
  end: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ data: MonitorRecord[]; total: number; page: number; limit: number; has_more: boolean; next_cursor?: string }> {
  return callSupabaseRpc(env, 'cfm_records_range_cursor', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_cursor: cursor,
    input_limit: limit,
  });
}

export function getSupabaseGpuRecords(
  env: SupabaseApiEnv,
  client: string,
  start: string | undefined,
  end: string | undefined,
  limit: number,
): Promise<GPUHistoryRecord[]> {
  return callSupabaseRpc<GPUHistoryRecord[]>(env, 'cfm_gpu_records', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_limit: limit,
  });
}

export function getSupabaseGpuRecordsPaged(
  env: SupabaseApiEnv,
  client: string,
  start: string | undefined,
  end: string | undefined,
  page: number,
  limit: number,
): Promise<{ data: GPUHistoryRecord[]; total: number; page: number; limit: number; has_more: boolean }> {
  return callSupabaseRpc(env, 'cfm_gpu_records_paged', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_page: page,
    input_limit: limit,
  });
}

export function getSupabaseGpuRecordsCursor(
  env: SupabaseApiEnv,
  client: string,
  start: string | undefined,
  end: string | undefined,
  cursor: string | undefined,
  limit: number,
): Promise<{ data: GPUHistoryRecord[]; total: number; page: number; limit: number; has_more: boolean; next_cursor?: string }> {
  return callSupabaseRpc(env, 'cfm_gpu_records_cursor', {
    input_client: client,
    input_start: start,
    input_end: end,
    input_cursor: cursor,
    input_limit: limit,
  });
}

export function getSupabasePingRecords(env: SupabaseApiEnv, client: string, taskId: number, limit: number): Promise<PingHistoryRecord[]> {
  return callSupabaseRpc<PingHistoryRecord[]>(env, 'cfm_ping_records', {
    input_client: client,
    input_task_id: taskId,
    input_limit: limit,
  });
}

export function getSupabasePingRecordsPaged(
  env: SupabaseApiEnv,
  client: string,
  taskId: number,
  page: number,
  limit: number,
): Promise<{ data: PingHistoryRecord[]; total: number; page: number; limit: number; has_more: boolean }> {
  return callSupabaseRpc(env, 'cfm_ping_records_paged', {
    input_client: client,
    input_task_id: taskId,
    input_page: page,
    input_limit: limit,
  });
}

export function getSupabasePingRecordsCursor(
  env: SupabaseApiEnv,
  client: string,
  taskId: number,
  cursor: string | undefined,
  limit: number,
): Promise<{ data: PingHistoryRecord[]; total: number; page: number; limit: number; has_more: boolean; next_cursor?: string }> {
  return callSupabaseRpc(env, 'cfm_ping_records_cursor', {
    input_client: client,
    input_task_id: taskId,
    input_cursor: cursor,
    input_limit: limit,
  });
}

export function getSupabasePingRecordsForTasks(
  env: SupabaseApiEnv,
  client: string,
  tasks: number[] | PingTaskHistoryRequest[],
  limit: number,
  cursor?: string,
): Promise<Record<string, PingHistoryRecord[]>> {
  if (tasks.some(task => typeof task !== 'number')) {
    return getSupabasePingRecordsForTaskSpecs(env, client, tasks as PingTaskHistoryRequest[], limit, cursor);
  }
  const taskIds = tasks.map(task => typeof task === 'number' ? task : task.taskId);
  return callSupabaseRpc<Record<string, PingHistoryRecord[]>>(env, 'cfm_ping_records_for_tasks', {
    input_client: client,
    input_task_ids: taskIds,
    input_limit: limit,
    input_cursor: cursor,
  });
}

async function getSupabasePingRecordsForTaskSpecs(
  env: SupabaseApiEnv,
  client: string,
  tasks: PingTaskHistoryRequest[],
  fallbackLimit: number,
  cursor?: string,
): Promise<Record<string, PingHistoryRecord[]>> {
  const entries = await Promise.all(tasks.map(async (task) => {
    const taskLimit = Number.isInteger(task.limit) && task.limit && task.limit > 0
      ? Math.min(task.limit, 1000)
      : fallbackLimit;
    const records = cursor
      ? (await getSupabasePingRecordsCursor(env, client, task.taskId, cursor, taskLimit)).data
      : await getSupabasePingRecords(env, client, task.taskId, taskLimit);
    return [String(task.taskId), records] as const;
  }));
  return Object.fromEntries(entries);
}

export function getSupabaseHistoryStorageRowCounts(env: SupabaseApiEnv): Promise<HistoryTableRowCounts> {
  return callSupabaseRpc<HistoryTableRowCounts>(env, 'cfm_history_storage_counts');
}

export function getSupabaseStorageRowCounts(env: SupabaseApiEnv): Promise<TableRowCounts> {
  return callSupabaseRpc<TableRowCounts>(env, 'cfm_storage_row_counts');
}

export function getSupabaseBoundedStorageRowCounts(env: SupabaseApiEnv, limit: number): Promise<BoundedTableRowCounts> {
  return callSupabaseRpc<BoundedTableRowCounts>(env, 'cfm_bounded_storage_row_counts', { input_limit: limit });
}

export function getSupabaseExpiredRowCounts(
  env: SupabaseApiEnv,
  beforeTimes: { records: string; ping_records: string; audit_logs: string },
): Promise<TableRowCounts> {
  return callSupabaseRpc<TableRowCounts>(env, 'cfm_expired_row_counts', {
    input_records_before: beforeTimes.records,
    input_ping_records_before: beforeTimes.ping_records,
    input_audit_logs_before: beforeTimes.audit_logs,
  });
}

export function getSupabasePublicPingTasks(env: SupabaseApiEnv, fetcher: typeof fetch = fetch): Promise<PingTask[]> {
  return callSupabaseRpc<PingTask[]>(env, 'cfm_public_ping_tasks', {}, fetcher).then(normalizePingTaskList);
}

export function getSupabasePublicWebsites(
  env: SupabaseApiEnv,
  periodHours: number,
  checkLimit: number,
  includeHidden = false,
  fetcher: typeof fetch = fetch,
): Promise<PublicWebsiteMonitor[]> {
  return callSupabaseRpc<PublicWebsiteMonitor[]>(env, 'cfm_public_websites', {
    period_hours: periodHours,
    check_limit: checkLimit,
    input_include_hidden: includeHidden,
  }, fetcher);
}

export function getSupabasePublicWebsiteMonitorById(
  env: SupabaseApiEnv,
  id: number,
  checkLimit: number,
  includeHidden = false,
  fetcher: typeof fetch = fetch,
): Promise<PublicWebsiteMonitor | null> {
  return callSupabaseRpc<PublicWebsiteMonitor | null>(env, 'cfm_public_website_monitor', {
    input_id: id,
    input_check_limit: checkLimit,
    input_include_hidden: includeHidden,
  }, fetcher);
}

export function listSupabaseWebsiteMonitors(env: SupabaseApiEnv): Promise<WebsiteMonitor[]> {
  return callSupabaseRpc<WebsiteMonitor[]>(env, 'cfm_website_monitors').then(normalizeWebsiteMonitorList);
}

export function getSupabaseWebsiteMonitor(env: SupabaseApiEnv, id: number): Promise<WebsiteMonitor | null> {
  return callSupabaseRpc<WebsiteMonitor | null>(env, 'cfm_website_monitor', { input_id: id })
    .then(monitor => monitor ? normalizeWebsiteMonitor(monitor) : null);
}

export function listSupabaseWebsiteChecks(env: SupabaseApiEnv, monitorId: number, limit: number): Promise<WebsiteCheck[]> {
  return callSupabaseRpc<WebsiteCheck[]>(env, 'cfm_website_checks', {
    input_monitor_id: monitorId,
    input_limit: limit,
  });
}

export function createSupabaseWebsiteMonitor(env: SupabaseApiEnv, monitor: WebsiteMonitorInput): Promise<WebsiteMonitor> {
  return callSupabaseRpc<WebsiteMonitor>(env, 'cfm_create_website_monitor', { input_monitor: monitor }).then(normalizeWebsiteMonitor);
}

export function updateSupabaseWebsiteMonitorAndReturn(
  env: SupabaseApiEnv,
  id: number,
  monitor: Partial<WebsiteMonitorInput>,
): Promise<WebsiteMonitor | null> {
  return callSupabaseRpc<WebsiteMonitor | null>(env, 'cfm_update_website_monitor', {
    input_id: id,
    input_monitor: monitor,
  }).then(monitor => monitor ? normalizeWebsiteMonitor(monitor) : null);
}

export function deleteSupabaseWebsiteMonitor(env: SupabaseApiEnv, id: number): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_delete_website_monitor', { input_id: id });
}

export function reorderSupabaseWebsiteMonitors(env: SupabaseApiEnv, ids: number[]): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_reorder_website_monitors', { input_ids: ids });
}

export function setSupabaseWebsiteMonitorVisibility(env: SupabaseApiEnv, id: number, hidden: boolean): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_set_website_monitor_visibility', {
    input_id: id,
    input_hidden: hidden,
  });
}

export function setSupabaseWebsiteMonitorEnabled(env: SupabaseApiEnv, id: number, enabled: boolean): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_set_website_monitor_enabled', {
    input_id: id,
    input_enabled: enabled,
  });
}

export function getSupabaseLoginUser(env: SupabaseApiEnv, username: string): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_login_user', { input_username: username });
}

export function countSupabaseUsers(env: SupabaseApiEnv): Promise<number> {
  return callSupabaseRpc<number>(env, 'cfm_users_count');
}

export function createSupabaseUser(
  env: SupabaseApiEnv,
  user: { uuid: string; username: string; hashedPassword: string },
): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_create_user', {
    input_uuid: user.uuid,
    input_username: user.username,
    input_passwd: user.hashedPassword,
  });
}

export function deleteSupabaseUserIfMatches(
  env: SupabaseApiEnv,
  user: { uuid: string; username: string; hashedPassword: string },
): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_delete_user_if_matches', {
    input_uuid: user.uuid,
    input_username: user.username,
    input_passwd: user.hashedPassword,
  });
}

export function recoverSupabaseSingleAdmin(
  env: SupabaseApiEnv,
  user: { uuid: string; username: string; hashedPassword: string },
): Promise<User> {
  return callSupabaseRpc<User>(env, 'cfm_recover_single_admin', {
    input_uuid: user.uuid,
    input_username: user.username,
    input_passwd: user.hashedPassword,
  });
}

export function getSupabaseUserByUuid(env: SupabaseApiEnv, uuid: string): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_user_by_uuid', { input_uuid: uuid });
}

export function enableSupabaseUserTotp(
  env: SupabaseApiEnv,
  uuid: string,
  secretEnc: string,
  recoveryCodeHashes: string[],
  usedStep: number,
): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_enable_user_totp', {
    input_uuid: uuid,
    input_secret_enc: secretEnc,
    input_recovery_code_hashes: recoveryCodeHashes,
    input_used_step: usedStep,
  });
}

export function disableSupabaseUserTotp(env: SupabaseApiEnv, uuid: string): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_disable_user_totp', { input_uuid: uuid });
}

export function replaceSupabaseUserRecoveryCodes(
  env: SupabaseApiEnv,
  uuid: string,
  recoveryCodeHashes: string[],
): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_replace_user_recovery_codes', {
    input_uuid: uuid,
    input_recovery_code_hashes: recoveryCodeHashes,
  });
}

export function consumeSupabaseTotpStep(env: SupabaseApiEnv, uuid: string, step: number): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_consume_totp_step', {
    input_uuid: uuid,
    input_step: step,
  });
}

export function consumeSupabaseRecoveryCode(env: SupabaseApiEnv, uuid: string, codeHash: string): Promise<boolean> {
  return callSupabaseRpc<boolean>(env, 'cfm_consume_recovery_code', {
    input_uuid: uuid,
    input_code_hash: codeHash,
  });
}
export function updateSupabaseUserUsername(env: SupabaseApiEnv, uuid: string, username: string): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_update_user_username', {
    input_uuid: uuid,
    input_username: username,
  });
}

export function updateSupabaseUserUsernameAndRotateSession(
  env: SupabaseApiEnv,
  uuid: string,
  username: string,
): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_update_user_username_rotate_session', {
    input_uuid: uuid,
    input_username: username,
  });
}

export function updateSupabaseUserPassword(env: SupabaseApiEnv, uuid: string, hashedPassword: string): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_update_user_password', {
    input_uuid: uuid,
    input_passwd: hashedPassword,
  });
}

export function updateSupabaseUserPasswordAndRotateSession(
  env: SupabaseApiEnv,
  uuid: string,
  hashedPassword: string,
): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_update_user_password_rotate_session', {
    input_uuid: uuid,
    input_passwd: hashedPassword,
  });
}

export function rotateSupabaseUserSession(env: SupabaseApiEnv, uuid: string): Promise<User | null> {
  return callSupabaseRpc<User | null>(env, 'cfm_rotate_user_session', {
    input_uuid: uuid,
  });
}

export function validateSupabaseAdminSession(
  env: SupabaseApiEnv,
  userId: string,
  sessionVersion: number,
): Promise<Pick<User, 'uuid' | 'username' | 'session_version'> | null> {
  return callSupabaseRpc<Pick<User, 'uuid' | 'username' | 'session_version'> | null>(
    env,
    'cfm_validate_admin_session',
    { user_uuid: userId, expected_session_version: sessionVersion },
  );
}

export function ensureSupabaseInitialAdmin(
  env: SupabaseApiEnv,
  uuid: string,
  username: string,
  hashedPassword: string,
): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_ensure_initial_admin', {
    input_uuid: uuid,
    input_username: username,
    input_passwd: hashedPassword,
  });
}

export function getSupabaseLoginRateLimit(env: SupabaseApiEnv, bucket: string): Promise<LoginRateLimit | null> {
  return callSupabaseRpc<LoginRateLimit | null>(env, 'cfm_login_rate_limit', { input_bucket: bucket });
}

export function getSupabaseLoginRateLimitsByBuckets(env: SupabaseApiEnv, buckets: string[]): Promise<LoginRateLimit[]> {
  return callSupabaseRpc<LoginRateLimit[]>(env, 'cfm_login_rate_limits', { input_buckets: buckets });
}

export function setSupabaseLoginRateLimit(env: SupabaseApiEnv, state: LoginRateLimit): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_set_login_rate_limit', { input_state: state });
}

export function setSupabaseLoginRateLimits(env: SupabaseApiEnv, states: LoginRateLimit[]): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_set_login_rate_limits', { input_states: states });
}

export function clearSupabaseLoginRateLimit(env: SupabaseApiEnv, bucket: string): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_clear_login_rate_limits', { input_buckets: [bucket] });
}

export function clearSupabaseLoginRateLimits(env: SupabaseApiEnv, buckets: string[]): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_clear_login_rate_limits', { input_buckets: buckets });
}

export function deleteSupabaseLoginRateLimitsBefore(env: SupabaseApiEnv, beforeTime: string): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_delete_login_rate_limits_before', { input_before_time: beforeTime });
}

export async function updateSupabaseWebsiteMonitor(
  env: SupabaseApiEnv,
  id: number,
  monitor: Partial<WebsiteMonitorInput>,
): Promise<boolean> {
  return (await updateSupabaseWebsiteMonitorAndReturn(env, id, monitor)) !== null;
}

export function clearSupabaseAllRecords(env: SupabaseApiEnv): Promise<ClearAllRecordsResult> {
  return callSupabaseRpc<ClearAllRecordsResult>(env, 'cfm_clear_all_records');
}

export function clearSupabaseClientRecords(env: SupabaseApiEnv, client: string): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_clear_client_records', { input_client: client });
}

export function restoreSupabaseBackupData(env: SupabaseApiEnv, backup: BackupData): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_restore_backup_data', { input_backup: backup });
}

export function insertSupabaseAuditLog(
  env: SupabaseApiEnv,
  user: string,
  action: string,
  detail: string,
  level = 'info',
): Promise<void> {
  return callSupabaseRpc<void>(env, 'cfm_insert_audit_log', {
    input_user: user,
    input_action: action,
    input_detail: detail,
    input_level: level,
  });
}
